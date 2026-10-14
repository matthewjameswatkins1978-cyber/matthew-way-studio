import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acknowledgeReview, importReviewComment, listPendingReviews, parseReviewEnvelope, readReviewDelivery, type PullRequestSnapshot, type ReviewComment } from "../src/review.js";
import { writeJob, readJob } from "../src/ledger.js";
import type { LedgerLocation } from "../src/paths.js";
import { applyReviewWait } from "../src/mission.js";
import { newJob } from "../src/schema.js";

const HEAD = "b".repeat(40);
const REPOSITORY = "owner/repo";
const OWNER = "pi-session-owner";
const OTHER = "pi-session-other";
const JOB = "job-authority-test";

function location(dir: string, workerId?: string): LedgerLocation {
  return { dir, source: "fallback", ...(workerId ? { workerId, workerKey: createHash("sha256").update(workerId).digest("hex").slice(0, 24) } : {}) };
}

function waitingJob(dir: string, workerId: string, jobId = JOB): void {
  const loc = location(dir, workerId);
  const base = newJob({
    jobId,
    contract: { objective: "authority routing test", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: dir, remote: "https://github.com/owner/repo.git", branch: "feature/review", base_sha: HEAD, current_sha: HEAD, dirty_at_start: false },
    packet: { sha256: "b".repeat(64), bytes: 4, path: "packet.md" },
    nextAction: "wait",
  });
  const wait = applyReviewWait(base, { repository: REPOSITORY, pull_request: 35, url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD, worker_session_id: workerId, requested_review: "general" });
  writeJob(loc, { ...wait, worker_session_id: workerId });
}

function envelopeBody(jobId = JOB, workerSessionId?: string, decision = "changes_requested"): string {
  const envelope = workerSessionId
    ? { repository: REPOSITORY, pull_request: 35, job_id: jobId, worker_session_id: workerSessionId, head_sha: HEAD, decision }
    : { repository: REPOSITORY, pull_request: 35, job_id: jobId, head_sha: HEAD, decision };
  return `Review feedback here.\n<!-- mws-review/v1\n${JSON.stringify(envelope)}\n-->`;
}

function comment(commentId: number, author: string, body: string): ReviewComment {
  return { id: commentId, user: { login: author }, issue_url: "https://api.github.com/repos/owner/repo/issues/35", body, created_at: "2026-10-14T10:00:00.000Z" };
}

function pullRequest(): PullRequestSnapshot {
  return { repository: REPOSITORY, number: 35, state: "open", url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD };
}

function importer(dir: string, value: ReviewComment, extra: { workerGithubLogins?: string[]; allowSameAccountReviews?: boolean } = {}) {
  return importReviewComment({
    location: location(dir, "importer-session"), repository: REPOSITORY, commentId: value.id,
    authorizedReviewers: ["Lucy-Reviewer", "matthewjameswatkins1978-cyber"], workerGithubLogins: extra.workerGithubLogins, allowSameAccountReviews: extra.allowSameAccountReviews,
    cwd: dir, now: Date.parse("2026-10-14T12:00:00.000Z"),
    readComment: () => value,
    readPullRequest: () => ({ ok: true, pull_request: pullRequest() }),
  });
}

test("worker-bound envelopes parse; malformed worker identity is rejected", () => {
  assert.equal(parseReviewEnvelope(envelopeBody(JOB, OWNER))?.worker_session_id, OWNER);
  assert.equal(parseReviewEnvelope(envelopeBody(JOB))?.worker_session_id, undefined);
  assert.equal(parseReviewEnvelope(envelopeBody(JOB, "not a session id!!")), undefined);
  assert.equal(parseReviewEnvelope(envelopeBody(JOB, OWNER).replace('"pull_request":35,', '"pull_request":35,"extra":1,')), undefined);
});

test("a forged same-account comment is rejected by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-forge-"));
  waitingJob(dir, OWNER);
  const forged = comment(9101, "matthewjameswatkins1978-cyber", envelopeBody());
  const refused = importer(dir, forged, { workerGithubLogins: ["matthewjameswatkins1978-cyber"] });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /worker GitHub identity/);
  assert.equal(listPendingReviews(location(dir, OWNER)).length, 0, "nothing was queued");
  // An independently provisioned reviewer identity still imports cleanly.
  const genuine = comment(9102, "lucy-reviewer", envelopeBody());
  const accepted = importer(dir, genuine, { workerGithubLogins: ["matthewjameswatkins1978-cyber"] });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.delivery.authority, "independent");
});

test("same-account feedback, when explicitly allowed, parks for Matthew instead of resuming", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-park-"));
  waitingJob(dir, OWNER);
  const sameAccount = comment(9103, "matthewjameswatkins1978-cyber", envelopeBody());
  const queued = importer(dir, sameAccount, { workerGithubLogins: ["matthewjameswatkins1978-cyber"], allowSameAccountReviews: true });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  assert.equal(queued.delivery.authority, "same-account");
  const ack = acknowledgeReview(location(dir, OWNER), queued.delivery.id, dir, "2026-10-14T12:30:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(ack.ok, true);
  assert.match(ack.reason, /parked for Matthew/);
  const after = readJob(location(dir, OWNER));
  assert.equal(after.kind === "loaded" && after.job.status, "NEEDS_HUMAN", "same-account feedback never resumes work by itself");
  if (after.kind !== "loaded") return;
  assert.equal(after.job.blocker?.kind, "external-approval");
  const repeated = acknowledgeReview(location(dir, OWNER), queued.delivery.id, dir, "2026-10-14T12:31:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(repeated.ok, true, "duplicate acknowledgement stays harmless");
});

test("two workers on the same PR and commit: legacy envelopes refuse, worker-bound envelopes route exactly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-ambiguous-"));
  waitingJob(dir, OWNER);
  waitingJob(dir, OTHER);
  const legacy = comment(9104, "lucy-reviewer", envelopeBody());
  const refused = importer(dir, legacy);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /ambiguous/);
  const bound = comment(9105, "lucy-reviewer", envelopeBody(JOB, OWNER));
  const routed = importer(dir, bound);
  assert.equal(routed.ok, true);
  if (!routed.ok) return;
  assert.equal(routed.delivery.worker_session_id, OWNER);
  assert.equal(readReviewDelivery(location(dir, OWNER), routed.delivery.id)?.state, "pending");
  assert.equal(readReviewDelivery(location(dir, OTHER), routed.delivery.id), undefined);
  const wrongOwner = comment(9106, "lucy-reviewer", envelopeBody(JOB, "pi-session-ghost"));
  assert.equal(importer(dir, wrongOwner).ok, false);
});

test("a validated independent review reaches the correct worker after restart, once, without merge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-restart-"));
  waitingJob(dir, OWNER);
  const approved = comment(9107, "lucy-reviewer", envelopeBody(JOB, OWNER, "approved"));
  const queued = importer(dir, approved);
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  // Restart: a fresh location for the same session discovers the inbox.
  const restarted = location(dir, OWNER);
  const inbox = listPendingReviews(restarted);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.id, queued.delivery.id);
  const ack = acknowledgeReview(restarted, queued.delivery.id, dir, "2026-10-14T12:30:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(ack.ok, true);
  assert.match(ack.reason, /without merge authority/);
  const after = readJob(restarted);
  assert.equal(after.kind === "loaded" && after.job.status, "WORKING");
  const again = acknowledgeReview(location(dir, OWNER), queued.delivery.id, dir, "2026-10-14T12:31:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(again.ok, true, "duplicate acknowledgement is harmless");
  assert.equal(listPendingReviews(location(dir, OWNER)).length, 0);
});
