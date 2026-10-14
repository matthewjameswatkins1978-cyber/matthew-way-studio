/** Read only the minimal live GitHub facts needed to bind a reviewer wait. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./paths.js";
import { readJob, writeJob } from "./ledger.js";
import type { LedgerLocation } from "./paths.js";
import { applyTransition, normalizeJob, type JobState } from "./schema.js";
import { applyBlock } from "./mission.js";

export interface PullRequestSnapshot {
  repository: string;
  number: number;
  state: string;
  url: string;
  branch: string;
  head_sha: string;
}

export type PullRequestRead = { ok: true; pull_request: PullRequestSnapshot } | { ok: false; reason: string };

/**
 * Query GitHub CLI using argv (never a shell string), and retain only the
 * identity fields Studio needs. Command output and credentials are not logged.
 */
export function readPullRequest(repository: string, number: number, cwd: string): PullRequestRead {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { ok: false, reason: "mission remote is not a canonical GitHub owner/repository" };
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, reason: "pull request number must be a positive integer" };
  const result = run("gh", ["api", `repos/${repository}/pulls/${number}`], cwd, 15_000);
  if (!result.ok) return { ok: false, reason: "GitHub CLI could not verify this pull request; check gh availability and authentication" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "GitHub returned invalid pull request data" };
  }
  const base = raw.base as Record<string, unknown> | undefined;
  const baseRepo = base?.repo as Record<string, unknown> | undefined;
  const head = raw.head as Record<string, unknown> | undefined;
  const url = typeof raw.html_url === "string" ? raw.html_url : "";
  const branch = typeof head?.ref === "string" ? head.ref : "";
  const headSha = typeof head?.sha === "string" ? head.sha : "";
  const numberOut = typeof raw.number === "number" ? raw.number : 0;
  const repoOut = typeof baseRepo?.full_name === "string" ? baseRepo.full_name : "";
  const state = typeof raw.state === "string" ? raw.state : "";
  if (!url || !branch || !/^[0-9a-f]{40}$/i.test(headSha) || numberOut !== number || repoOut.toLowerCase() !== repository.toLowerCase()) {
    return { ok: false, reason: "pull request identity is incomplete or does not match the requested repository and number" };
  }
  return { ok: true, pull_request: { repository: repoOut, number: numberOut, state, url, branch, head_sha: headSha.toLowerCase() } };
}

export type ReviewDecision = "changes_requested" | "approved" | "hold";
export interface ReviewEnvelope {
  repository: string;
  pull_request: number;
  job_id: string;
  head_sha: string;
  decision: ReviewDecision;
  /** Owning Pi session. Absent only in v1 envelopes; unambiguous routing requires it. */
  worker_session_id?: string;
}
export interface ReviewComment {
  id: number;
  user: { login: string };
  issue_url: string;
  body: string;
  created_at: string;
}
export interface ReviewDelivery {
  id: string;
  comment_id: number;
  repository: string;
  pull_request: number;
  job_id: string;
  head_sha: string;
  worker_session_id: string;
  author: string;
  decision: ReviewDecision;
  body: string;
  created_at: string;
  state: "pending" | "acknowledged";
  acknowledged_at?: string;
  /**
   * independent: the comment author is a provisioned reviewer identity
   * distinct from every GitHub login the workers use. same-account: the
   * author shares a worker GitHub identity, so the feedback can pause for
   * Matthew but can never resume work by itself (see acknowledgeReview).
   */
  authority: "independent" | "same-account";
}

const MAX_REVIEW_BODY_BYTES = 16 * 1024;
const MAX_REVIEW_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The only executable control fields accepted from a comment. */
export function parseReviewEnvelope(body: string): ReviewEnvelope | undefined {
  if (Buffer.byteLength(body, "utf8") > MAX_REVIEW_BODY_BYTES) return undefined;
  const matches = [...body.matchAll(/^<!-- mws-review\/v1\n([\s\S]*?)\n-->$/gm)];
  if (matches.length !== 1 || !matches[0]?.[1]) return undefined;
  try {
    const raw = JSON.parse(matches[0][1]) as Record<string, unknown>;
    const keys = Object.keys(raw).sort().join(",");
    const v1 = keys === "decision,head_sha,job_id,pull_request,repository";
    const v1Worker = keys === "decision,head_sha,job_id,pull_request,repository,worker_session_id";
    if (!v1 && !v1Worker) return undefined;
    if (typeof raw.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository)) return undefined;
    if (typeof raw.pull_request !== "number" || !Number.isSafeInteger(raw.pull_request) || raw.pull_request < 1) return undefined;
    if (typeof raw.job_id !== "string" || !/^job-[A-Za-z0-9-]{1,80}$/.test(raw.job_id)) return undefined;
    if (typeof raw.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(raw.head_sha)) return undefined;
    if (raw.decision !== "changes_requested" && raw.decision !== "approved" && raw.decision !== "hold") return undefined;
    if (v1Worker && (typeof raw.worker_session_id !== "string" || !/^[A-Za-z0-9_:.~-]{1,128}$/.test(raw.worker_session_id))) return undefined;
    return raw as unknown as ReviewEnvelope;
  } catch {
    return undefined;
  }
}

export type ReviewImport = { ok: true; delivery: ReviewDelivery; duplicate: boolean } | { ok: false; reason: string };

function deliveryPath(loc: LedgerLocation, workerId: string, id: string): string {
  const workerKey = createHash("sha256").update(workerId).digest("hex").slice(0, 24);
  return path.join(loc.dir, "review-deliveries", workerKey, `${id}.json`);
}

function writeAtomic(file: string, value: ReviewDelivery): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/** Publish a complete receipt without replacing a previous decision receipt. */
function createDeliveryOnce(file: string, value: ReviewDelivery): boolean {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.linkSync(tmp, file); // same-volume hard link is atomic and exclusive on Windows and POSIX
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readComment(repository: string, commentId: number, cwd: string): ReviewComment | undefined {
  const result = run("gh", ["api", `repos/${repository}/issues/comments/${commentId}`], cwd, 15_000);
  if (!result.ok) return undefined;
  try {
    const raw = JSON.parse(result.stdout) as Record<string, unknown>;
    const user = raw.user as Record<string, unknown> | undefined;
    if (typeof raw.id !== "number" || typeof user?.login !== "string" || typeof raw.issue_url !== "string" || typeof raw.body !== "string" || typeof raw.created_at !== "string") return undefined;
    return { id: raw.id, user: { login: user.login }, issue_url: raw.issue_url, body: raw.body, created_at: raw.created_at };
  } catch {
    return undefined;
  }
}

/** Validate GitHub source, actor, exact job/PR/head and live PR before durable enqueue. */
export function importReviewComment(input: {
  location: LedgerLocation;
  repository: string;
  commentId: number;
  authorizedReviewers: string[];
  /** GitHub logins the workers themselves use. A comment from one of these is never independent reviewer authority. */
  workerGithubLogins?: string[];
  /** Allow same-account comments to queue as non-authoritative feedback. Defaults to false (rejected). */
  allowSameAccountReviews?: boolean;
  cwd: string;
  now?: number;
  readComment?: typeof readComment;
  readPullRequest?: typeof readPullRequest;
}): ReviewImport {
  if (!Number.isSafeInteger(input.commentId) || input.commentId < 1) return { ok: false, reason: "comment id must be a positive integer" };
  const reader = input.readComment ?? readComment;
  const jobReader = input.readPullRequest ?? readPullRequest;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) return { ok: false, reason: "repository must be an exact owner/repository" };
  const comment = reader(input.repository, input.commentId, input.cwd);
  if (!comment) return { ok: false, reason: "GitHub comment could not be read and verified" };
  if (comment.id !== input.commentId) return { ok: false, reason: "GitHub comment id does not match request" };
  if (!input.authorizedReviewers.some((login) => login.toLowerCase() === comment.user.login.toLowerCase())) return { ok: false, reason: "comment author is not in the configured reviewer allowlist" };
  const sharesWorkerIdentity = (input.workerGithubLogins ?? []).some((login) => login.toLowerCase() === comment.user.login.toLowerCase());
  if (sharesWorkerIdentity && input.allowSameAccountReviews !== true) return { ok: false, reason: "comment author shares a worker GitHub identity; independent reviewer authority is not established" };
  const authority: ReviewDelivery["authority"] = sharesWorkerIdentity ? "same-account" : "independent";
  const envelope = parseReviewEnvelope(comment.body);
  if (!envelope) return { ok: false, reason: "comment has no valid exact review envelope" };
  let issue: URL;
  try { issue = new URL(comment.issue_url); } catch { return { ok: false, reason: "GitHub comment source URL is invalid" }; }
  const match = issue.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
  const repository = `${match?.[1] ?? ""}/${match?.[2] ?? ""}`;
  const pullRequest = Number(match?.[3]);
  if (issue.hostname !== "api.github.com" || !match || repository.toLowerCase() !== envelope.repository.toLowerCase() || pullRequest !== envelope.pull_request) return { ok: false, reason: "comment source does not belong to its exact envelope PR" };
  if (envelope.repository.toLowerCase() !== input.repository.toLowerCase()) return { ok: false, reason: "comment envelope repository differs from the requested source" };
  const commentTarget = jobReader(envelope.repository, envelope.pull_request, input.cwd);
  if (!commentTarget.ok || commentTarget.pull_request.state !== "open" || commentTarget.pull_request.head_sha !== envelope.head_sha) return { ok: false, reason: "live PR does not match the comment repository, PR and head SHA" };
  let snapshotFiles: string[];
  try { snapshotFiles = fs.readdirSync(input.location.dir).filter((name) => /^active-job\.[a-f0-9]{24}\.json$/.test(name)); }
  catch { return { ok: false, reason: "shared worker ledger is unavailable" }; }
  if (snapshotFiles.length > 256) return { ok: false, reason: "worker ledger exceeds the bounded review-import scan limit" };
  const candidates: { job: JobState; workerId: string }[] = [];
  for (const fileName of snapshotFiles) {
    try {
      const candidate = normalizeJob(JSON.parse(fs.readFileSync(path.join(input.location.dir, fileName), "utf8")));
      const wait = candidate.review_wait;
      if (candidate.job_id === envelope.job_id && candidate.status === "WAITING_REVIEW" && candidate.worker_session_id && wait?.worker_session_id === candidate.worker_session_id && wait.repository.toLowerCase() === envelope.repository.toLowerCase() && wait.pull_request === envelope.pull_request && wait.head_sha === envelope.head_sha && wait.branch === commentTarget.pull_request.branch) {
        const key = createHash("sha256").update(candidate.worker_session_id).digest("hex").slice(0, 24);
        if (fileName === `active-job.${key}.json`) candidates.push({ job: candidate, workerId: candidate.worker_session_id });
      }
    } catch { /* ignore unreadable or foreign snapshots */ }
  }
  // Never pick an arbitrary recipient: a worker-bound envelope routes to its
  // exact owner, and a legacy envelope without one is refused when ambiguous.
  const owned = envelope.worker_session_id ? candidates.filter((c) => c.workerId === envelope.worker_session_id) : candidates;
  if (owned.length === 0) return { ok: false, reason: "no exact worker-owned WAITING_REVIEW job matches the comment envelope" };
  if (owned.length > 1) return { ok: false, reason: "ambiguous review target: more than one waiting worker matches this envelope; refusing arbitrary delivery" };
  const routed = owned[0];
  if (!routed || !routed.job.review_wait) return { ok: false, reason: "no exact worker-owned WAITING_REVIEW job matches the comment envelope" };
  const job = routed.job;
  const workerId = routed.workerId;
  const wait = job.review_wait;
  if (!wait) return { ok: false, reason: "no exact worker-owned WAITING_REVIEW job matches the comment envelope" };
  const created = Date.parse(comment.created_at);
  if (!Number.isFinite(created) || created > (input.now ?? Date.now()) || (input.now ?? Date.now()) - created > MAX_REVIEW_AGE_MS) return { ok: false, reason: "review comment timestamp is invalid or expired" };
  const live = jobReader(wait.repository, wait.pull_request, input.cwd);
  if (!live.ok || live.pull_request.state !== "open" || live.pull_request.repository.toLowerCase() !== wait.repository.toLowerCase() || live.pull_request.branch !== wait.branch || live.pull_request.head_sha !== wait.head_sha) return { ok: false, reason: "live PR no longer matches the waiting repository, branch and head SHA" };
  // Event identity: every GitHub comment is its own delivery, so two different
  // findings on the same commit never collapse into one receipt. Re-importing
  // the same comment returns the existing delivery (see the queue scan below).
  const eventKey = createHash("sha256").update(`${job.job_id}\n${wait.head_sha}\n${comment.id}`).digest("hex").slice(0, 32);
  const id = `review-${eventKey}`;
  const file = deliveryPath(input.location, workerId, id);
  const delivery: ReviewDelivery = {
    id, comment_id: comment.id, repository: wait.repository, pull_request: wait.pull_request,
    job_id: job.job_id, head_sha: wait.head_sha, worker_session_id: workerId,
    author: comment.user.login, decision: envelope.decision,
    authority,
    body: comment.body.replace(/^<!-- mws-review\/v1\n[\s\S]*?\n-->$/m, "").trim().slice(0, MAX_REVIEW_BODY_BYTES),
    created_at: comment.created_at, state: "pending",
  };
  const queueDir = path.dirname(file);
  fs.mkdirSync(queueDir, { recursive: true });
  try {
    for (const name of fs.readdirSync(queueDir).filter((name) => name.endsWith(".json"))) {
      try {
        const prior = JSON.parse(fs.readFileSync(path.join(queueDir, name), "utf8")) as ReviewDelivery;
        if (prior.comment_id === comment.id) {
          if (prior.job_id !== delivery.job_id || prior.head_sha !== delivery.head_sha || prior.decision !== delivery.decision || prior.worker_session_id !== workerId) return { ok: false, reason: "this GitHub comment id was already bound to a different review decision" };
          return { ok: true, delivery: prior, duplicate: true };
        }
      } catch { /* malformed receipts do not authorize or deduplicate */ }
    }
  } catch { /* queue creation below reports any write failure */ }
  try {
    if (!createDeliveryOnce(file, delivery)) throw new Error("delivery already exists or could not be created exclusively");
    return { ok: true, delivery, duplicate: false };
  } catch {
    try {
      const prior = JSON.parse(fs.readFileSync(file, "utf8")) as ReviewDelivery;
      if (prior.job_id === job.job_id && prior.worker_session_id === workerId && prior.head_sha === wait.head_sha) return { ok: true, delivery: prior, duplicate: true };
    } catch { /* fail closed below */ }
    return { ok: false, reason: "a conflicting or unreadable delivery already uses this comment id" };
  }
}

export function readReviewDelivery(loc: LedgerLocation, deliveryId: string): ReviewDelivery | undefined {
  if (!loc.workerId || !/^review-[a-f0-9]{32}$/.test(deliveryId)) return undefined;
  try {
    const delivery = JSON.parse(fs.readFileSync(deliveryPath(loc, loc.workerId, deliveryId), "utf8")) as ReviewDelivery;
    if (delivery.worker_session_id !== loc.workerId || delivery.id !== deliveryId) return undefined;
    // Receipts queued before reviewer-authority tracking carry no proof of
    // an independent reviewer identity, so they are never promoted to one:
    // they park for Matthew like any other same-account feedback. Anything
    // else unknown fails closed and is unreadable.
    if (delivery.authority === undefined) delivery.authority = "same-account";
    if (delivery.authority !== "independent" && delivery.authority !== "same-account") return undefined;
    return delivery;
  } catch { return undefined; }
}

/**
 * Pending inbox for exactly this Pi session. The owner discovers its queued
 * reviews after restart without anyone ferrying delivery IDs: session start,
 * the WAITING_REVIEW prompt section, studio_status and studio_pending_reviews
 * all read this. Never triggers a model turn by itself.
 */
export function listPendingReviews(loc: LedgerLocation): ReviewDelivery[] {
  if (!loc.workerId) return [];
  const queueDir = path.join(loc.dir, "review-deliveries", createHash("sha256").update(loc.workerId).digest("hex").slice(0, 24));
  let names: string[];
  try {
    names = fs.readdirSync(queueDir).filter((name) => /^review-[a-f0-9]{32}\.json$/.test(name));
  } catch {
    return [];
  }
  const out: ReviewDelivery[] = [];
  for (const name of names) {
    const delivery = readReviewDelivery(loc, name.slice(0, -5));
    if (delivery && delivery.state === "pending") out.push(delivery);
  }
  out.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return out;
}

/** Idempotently acknowledge exactly one pending delivery; no merge authority is represented. */
export function acknowledgeReview(loc: LedgerLocation, deliveryId: string, cwd: string, now = new Date().toISOString(), jobReader: typeof readPullRequest = readPullRequest): { ok: boolean; reason: string; job?: JobState } {
  const delivery = readReviewDelivery(loc, deliveryId);
  if (!delivery || !loc.workerId) return { ok: false, reason: "delivery is missing or belongs to another worker" };
  const snap = readJob(loc);
  if (snap.kind !== "loaded") return { ok: false, reason: "owning job is unavailable" };
  const job = snap.job;
  if (job.job_id !== delivery.job_id || job.worker_session_id !== loc.workerId || (job.status !== "WAITING_REVIEW" && job.status !== "WORKING" && !(delivery.state === "acknowledged" && job.status === "NEEDS_HUMAN")) || job.review_wait?.worker_session_id !== loc.workerId || job.review_wait.repository !== delivery.repository || job.review_wait.pull_request !== delivery.pull_request || job.review_wait.head_sha !== delivery.head_sha) {
    return { ok: false, reason: "job, worker, PR or head SHA no longer matches the delivery" };
  }
  // An already-acknowledged delivery stays idempotent even after its job left the wait (parked for Matthew); a pending delivery never acts outside the wait.
  const live = jobReader(delivery.repository, delivery.pull_request, cwd);
  if (!live.ok || live.pull_request.state !== "open" || live.pull_request.repository.toLowerCase() !== delivery.repository.toLowerCase() || live.pull_request.branch !== job.review_wait.branch || live.pull_request.head_sha !== delivery.head_sha) return { ok: false, reason: "live PR changed after import; refusing stale review delivery" };
  if (delivery.state === "acknowledged" && (delivery.decision === "hold" || job.status === "WORKING")) return { ok: true, reason: "review delivery was already acknowledged", job };
  // A same-GitHub-identity comment is feedback, not reviewer approval: it can
  // pause the mission for Matthew's eyes, but it never resumes work by itself.
  if (delivery.authority === "same-account" && delivery.state === "pending" && delivery.decision !== "hold") {
    delivery.state = "acknowledged";
    delivery.acknowledged_at = now;
    writeAtomic(deliveryPath(loc, loc.workerId, deliveryId), delivery);
    if (job.status === "WORKING") return { ok: true, reason: "same-account feedback recorded; mission already resumed by an independent decision", job };
    const parked = applyBlock(job, {
      kind: "external-approval",
      reason: `review feedback arrived under a shared worker GitHub identity (@${delivery.author}), which cannot authorize resumption by itself`,
      exact_human_need: `review the queued feedback from @${delivery.author} on PR #${delivery.pull_request} and say how to proceed`,
      resume_condition: "Matthew states the next action for this mission.",
    });
    writeJob(loc, parked);
    return { ok: true, reason: "same-account feedback parked for Matthew; not reviewer approval, no merge authority", job: parked };
  }
  if (delivery.state === "pending" && delivery.decision !== "hold") {
    const resumed = applyTransition(job, "WORKING");
    const updated: JobState = { ...resumed, continuation: { ...job.continuation, allowed: true, reason: `authorized review decision: ${delivery.decision}` }, progress: { ...job.progress, next_action: delivery.decision === "changes_requested" ? "Address the authorized review feedback, then rerun required checks." : "Verify required checks and report the approved review outcome; do not merge." }, updated_at: now };
    delivery.state = "acknowledged";
    delivery.acknowledged_at = now;
    const file = deliveryPath(loc, loc.workerId, deliveryId);
    writeAtomic(file, delivery);
    writeJob(loc, updated);
    return { ok: true, reason: "review acknowledged; mission resumed without merge authority", job: updated };
  }
  // A hold is never silently ignored or stranded: every hold receipt is
  // marked acknowledged exactly once. The last independent decision governs:
  // a later hold re-pauses work an earlier decision resumed. Same-account
  // holds are recorded only; Matthew's direction still governs them.
  if (delivery.decision === "hold" && delivery.state === "pending") {
    delivery.state = "acknowledged";
    delivery.acknowledged_at = now;
    writeAtomic(deliveryPath(loc, loc.workerId, deliveryId), delivery);
    if (delivery.authority !== "independent") {
      return { ok: true, reason: "same-account hold recorded; Matthew's direction still governs", job };
    }
    if (job.status === "WORKING") {
      const paused = applyTransition(job, "WAITING_REVIEW");
      const updated: JobState = { ...paused, continuation: { ...job.continuation, allowed: false, reason: "authorized review hold after resumption" }, updated_at: now };
      writeJob(loc, updated);
      return { ok: true, reason: "hold acknowledged; mission re-paused awaiting reviewer", job: updated };
    }
    return { ok: true, reason: "hold acknowledged; mission remains WAITING_REVIEW", job };
  }
  if (delivery.state === "acknowledged" && delivery.authority === "same-account") return { ok: true, reason: "same-account feedback was already recorded; Matthew's direction still governs", job };
  if (delivery.state === "acknowledged" && job.status === "WAITING_REVIEW") {
    const resumed = applyTransition(job, "WORKING");
    const updated: JobState = { ...resumed, continuation: { ...job.continuation, allowed: true, reason: `authorized review decision: ${delivery.decision}` }, progress: { ...job.progress, next_action: delivery.decision === "changes_requested" ? "Address the authorized review feedback, then rerun required checks." : "Verify required checks and report the approved review outcome; do not merge." }, updated_at: now };
    writeJob(loc, updated);
    return { ok: true, reason: "reconciled acknowledged decision after restart", job: updated };
  }
  return { ok: true, reason: "review delivery was already acknowledged", job };
}
