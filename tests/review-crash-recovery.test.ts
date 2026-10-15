import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acknowledgeReview, importReviewComment, listPendingReviews, readReviewDelivery, type PullRequestSnapshot, type ReviewComment } from "../src/review.js";
import { writeJob, readJob } from "../src/ledger.js";
import type { LedgerLocation } from "../src/paths.js";
import { applyReviewWait } from "../src/mission.js";
import { newJob } from "../src/schema.js";

const HEAD = "c".repeat(40);
const REPOSITORY = "owner/repo";
const OWNER = "pi-session-crash";
const JOB = "job-crash-recovery";

function location(dir: string, workerId?: string): LedgerLocation {
  return { dir, source: "fallback", ...(workerId ? { workerId, workerKey: createHash("sha256").update(workerId).digest("hex").slice(0, 24) } : {}) };
}

function waitingJob(dir: string, workerId: string): void {
  const loc = location(dir, workerId);
  const base = newJob({
    jobId: JOB,
    contract: { objective: "crash recovery test", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: dir, remote: "https://github.com/owner/repo.git", branch: "feature/review", base_sha: HEAD, current_sha: HEAD, dirty_at_start: false },
    packet: { sha256: "b".repeat(64), bytes: 4, path: "packet.md" },
    nextAction: "wait",
  });
  const wait = applyReviewWait(base, { repository: REPOSITORY, pull_request: 35, url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD, worker_session_id: workerId, requested_review: "general" });
  writeJob(loc, { ...wait, worker_session_id: workerId });
}

function envelopeBody(decision: string): string {
  const envelope = { repository: REPOSITORY, pull_request: 35, job_id: JOB, worker_session_id: OWNER, head_sha: HEAD, decision };
  return `Review feedback here.\n<!-- mws-review/v1\n${JSON.stringify(envelope)}\n-->`;
}

function comment(commentId: number, author: string, decision: string, createdAt = "2026-10-14T10:00:00.000Z"): ReviewComment {
  return { id: commentId, user: { login: author }, issue_url: "https://api.github.com/repos/owner/repo/issues/35", body: envelopeBody(decision), created_at: createdAt };
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

const liveReader = () => ({ ok: true as const, pull_request: pullRequest() });

/** Test-only stand-in for a process crash between the two persistence writes. */
function crash(): never {
  throw new Error("simulated interruption between persistence writes");
}

test("a crash between the hold's job write and its receipt write cannot lose the independent hold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-crash-hold-"));
  waitingJob(dir, OWNER);
  const owner = () => location(dir, OWNER);
  const ack = (deliveryId: string, at: string, interrupt?: () => void) => acknowledgeReview(owner(), deliveryId, dir, at, liveReader, interrupt);

  const resumed = importer(dir, comment(9401, "lucy-reviewer", "changes_requested"));
  const held = importer(dir, comment(9402, "lucy-reviewer", "hold"));
  assert.equal(resumed.ok && held.ok, true);
  if (!resumed.ok || !held.ok) return;

  // The independent approval resumes the worker, so the hold has a WORKING job to re-pause.
  assert.equal(ack(resumed.delivery.id, "2026-10-14T12:10:00.000Z").ok, true);
  const working = readJob(owner());
  assert.equal(working.kind === "loaded" && working.job.status, "WORKING");

  // Deterministic interruption after the first persistence write (the job
  // pause) and before the second (the receipt), on the real code path.
  assert.throws(() => ack(held.delivery.id, "2026-10-14T12:20:00.000Z", crash), /simulated interruption between persistence writes/);

  // Torn state on the same ledger: the pause is durable, the receipt is not.
  const torn = readJob(owner());
  assert.equal(torn.kind === "loaded" && torn.job.status, "WAITING_REVIEW", "the hold's job transition is durable before its receipt");
  assert.equal(readReviewDelivery(owner(), held.delivery.id)?.state, "pending", "a receipt is never acknowledged before its transition is durable");
  assert.equal(listPendingReviews(owner()).length, 1, "the interrupted receipt is still discoverable after restart");

  // Restart: a fresh location over the same ledger replays the acknowledgement.
  const restarted = location(dir, OWNER);
  const replay = acknowledgeReview(restarted, held.delivery.id, dir, "2026-10-14T12:21:00.000Z", liveReader);
  assert.equal(replay.ok, true);
  assert.equal(readReviewDelivery(restarted, held.delivery.id)?.state, "acknowledged", "replay completes the interrupted receipt");
  const after = readJob(restarted);
  assert.equal(after.kind === "loaded" && after.job.status, "WAITING_REVIEW", "the independent hold survives the crash and restart");
  if (after.kind === "loaded") assert.equal(after.job.continuation.allowed, false, "the re-paused job stays disarmed");

  // Duplicate acknowledgement stays harmless.
  const again = acknowledgeReview(location(dir, OWNER), held.delivery.id, dir, "2026-10-14T12:22:00.000Z", liveReader);
  assert.equal(again.ok, true);
  assert.equal(again.job?.status, "WAITING_REVIEW");
  assert.equal(readReviewDelivery(location(dir, OWNER), held.delivery.id)?.state, "acknowledged");
  assert.equal(listPendingReviews(location(dir, OWNER)).length, 0);
});

test("a crash between the same-account park's job write and its receipt write cannot lose the human park", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-crash-park-"));
  waitingJob(dir, OWNER);
  const owner = () => location(dir, OWNER);
  const ack = (deliveryId: string, at: string, interrupt?: () => void) => acknowledgeReview(owner(), deliveryId, dir, at, liveReader, interrupt);

  const queued = importer(dir, comment(9403, "matthewjameswatkins1978-cyber", "changes_requested"), { workerGithubLogins: ["matthewjameswatkins1978-cyber"], allowSameAccountReviews: true });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  assert.equal(queued.delivery.authority, "same-account");

  // Deterministic interruption after the first persistence write (the human
  // park) and before the second (the receipt), on the real code path.
  assert.throws(() => ack(queued.delivery.id, "2026-10-14T12:30:00.000Z", crash), /simulated interruption between persistence writes/);

  const torn = readJob(owner());
  assert.equal(torn.kind === "loaded" && torn.job.status, "NEEDS_HUMAN", "the park is durable before its receipt");
  assert.equal(torn.kind === "loaded" && torn.job.blocker?.kind, "external-approval", "the exact review-feedback block was raised");
  const signature = torn.kind === "loaded" ? torn.job.blocker?.signature : undefined;
  assert.ok(signature);
  assert.equal(readReviewDelivery(owner(), queued.delivery.id)?.state, "pending", "a receipt is never acknowledged before its transition is durable");
  assert.equal(listPendingReviews(owner()).length, 1, "the interrupted receipt is still discoverable after restart");

  // Restart: a fresh location over the same ledger replays the acknowledgement.
  const restarted = location(dir, OWNER);
  const replay = acknowledgeReview(restarted, queued.delivery.id, dir, "2026-10-14T12:31:00.000Z", liveReader);
  assert.equal(replay.ok, true);
  assert.match(replay.reason, /parked for Matthew/);
  const after = readJob(restarted);
  assert.equal(after.kind === "loaded" && after.job.status, "NEEDS_HUMAN", "the human park survives the crash and restart");
  if (after.kind === "loaded") {
    assert.equal(after.job.blocker?.signature, signature, "replay reuses this delivery's exact block instead of raising a foreign one");
    assert.equal(after.job.blocker?.times_raised, 1, "replay does not double-raise the block");
  }
  assert.equal(readReviewDelivery(restarted, queued.delivery.id)?.state, "acknowledged", "replay completes the interrupted receipt");

  // Duplicate acknowledgement stays harmless.
  const again = acknowledgeReview(location(dir, OWNER), queued.delivery.id, dir, "2026-10-14T12:32:00.000Z", liveReader);
  assert.equal(again.ok, true);
  assert.match(again.reason, /already recorded/);
  const final = readJob(location(dir, OWNER));
  assert.equal(final.kind === "loaded" && final.job.status, "NEEDS_HUMAN");
  assert.equal(listPendingReviews(location(dir, OWNER)).length, 0);
});

test("the last acknowledged decision governs, not the newest GitHub comment (documented limitation)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-order-"));
  waitingJob(dir, OWNER);
  const owner = () => location(dir, OWNER);
  const ack = (deliveryId: string, at: string) => acknowledgeReview(owner(), deliveryId, dir, at, liveReader);

  const olderHold = importer(dir, comment(9404, "lucy-reviewer", "hold", "2026-10-14T10:00:00.000Z"));
  const newerApproval = importer(dir, comment(9405, "lucy-reviewer", "approved", "2026-10-14T11:00:00.000Z"));
  assert.equal(olderHold.ok && newerApproval.ok, true);
  if (!olderHold.ok || !newerApproval.ok) return;
  assert.ok(olderHold.delivery.created_at < newerApproval.delivery.created_at, "the hold comment is the older one");

  // Acknowledge out of comment order: the newer approval first.
  assert.equal(ack(newerApproval.delivery.id, "2026-10-14T12:10:00.000Z").ok, true);
  const resumed = readJob(owner());
  assert.equal(resumed.kind === "loaded" && resumed.job.status, "WORKING");

  // Then the older hold. The receipt acknowledged last governs; Studio does
  // not claim chronological authority over GitHub comment order.
  const result = ack(olderHold.delivery.id, "2026-10-14T12:20:00.000Z");
  assert.equal(result.ok, true);
  assert.match(result.reason, /re-paused/);
  const after = readJob(owner());
  assert.equal(after.kind === "loaded" && after.job.status, "WAITING_REVIEW", "the last acknowledged decision governs");
  assert.equal(readReviewDelivery(owner(), olderHold.delivery.id)?.state, "acknowledged");
  assert.equal(readReviewDelivery(owner(), newerApproval.delivery.id)?.state, "acknowledged");
  assert.equal(listPendingReviews(owner()).length, 0, "every receipt is acknowledged exactly once");
});
