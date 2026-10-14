import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acknowledgeReview, importReviewComment, parseReviewEnvelope, readReviewDelivery, type PullRequestSnapshot, type ReviewComment } from "../src/review.js";
import { writeJob, readJob } from "../src/ledger.js";
import type { LedgerLocation } from "../src/paths.js";
import { applyReviewWait } from "../src/mission.js";
import { newJob } from "../src/schema.js";

const HEAD = "a".repeat(40);
const REPOSITORY = "owner/repo";
const WORKER = "pi-session-owner";
const JOB = "job-review-test";

function location(dir: string, workerId?: string): LedgerLocation {
  return { dir, source: "fallback", ...(workerId ? { workerId, workerKey: createHash("sha256").update(workerId).digest("hex").slice(0, 24) } : {}) };
}

function waitingJob(dir: string, workerId = WORKER): LedgerLocation {
  const loc = location(dir, workerId);
  const base = newJob({
    jobId: JOB,
    contract: { objective: "review delivery test", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: dir, remote: "https://github.com/owner/repo.git", branch: "feature/review", base_sha: HEAD, current_sha: HEAD, dirty_at_start: false },
    packet: { sha256: "b".repeat(64), bytes: 4, path: "packet.md" },
    nextAction: "wait",
  });
  const wait = applyReviewWait(base, { repository: REPOSITORY, pull_request: 35, url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD, worker_session_id: workerId, requested_review: "general" });
  writeJob(loc, { ...wait, worker_session_id: workerId });
  return loc;
}

function comment(commentId = 9001, author = "lucy-reviewer", body?: string): ReviewComment {
  const envelope = { repository: REPOSITORY, pull_request: 35, job_id: JOB, head_sha: HEAD, decision: "changes_requested" };
  return {
    id: commentId,
    user: { login: author },
    issue_url: "https://api.github.com/repos/owner/repo/issues/35",
    body: body ?? `Please address the two review findings.\n<!-- mws-review/v1\n${JSON.stringify(envelope)}\n-->`,
    created_at: "2026-10-14T10:00:00.000Z",
  };
}

function pullRequest(headSha = HEAD): PullRequestSnapshot {
  return { repository: REPOSITORY, number: 35, state: "open", url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: headSha };
}

function importer(dir: string, commentValue: ReviewComment, headSha = HEAD, worker = "importer-session") {
  return importReviewComment({
    location: location(dir, worker), repository: REPOSITORY, commentId: commentValue.id,
    authorizedReviewers: ["Lucy-Reviewer"], cwd: dir, now: Date.parse("2026-10-14T12:00:00.000Z"),
    readComment: () => commentValue,
    readPullRequest: () => ({ ok: true, pull_request: pullRequest(headSha) }),
  });
}

test("review envelope is strict, bounded control data", () => {
  const valid = comment();
  const marker = valid.body.match(/<!-- mws-review\/v1\n([\s\S]*?)\n-->/)?.[1];
  assert.ok(marker);
  assert.equal(parseReviewEnvelope(valid.body)?.decision, "changes_requested");
  assert.equal(parseReviewEnvelope("ordinary review text"), undefined);
  assert.equal(parseReviewEnvelope(valid.body + "\n" + valid.body.slice(valid.body.indexOf("<!--"))), undefined);
  assert.equal(parseReviewEnvelope(valid.body.replace('"pull_request":35,', '"pull_request":35,"extra":"x",')), undefined);
  assert.equal(parseReviewEnvelope("x".repeat(17 * 1024)), undefined);
});

test("review import queues for the exact owner worker; restart and duplicates are idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-"));
  const owner = waitingJob(dir);
  const value = comment();
  const [first, concurrentDuplicate] = [importer(dir, value), importer(dir, value)];
  assert.equal(first.ok, true);
  assert.equal(concurrentDuplicate.ok, true);
  if (!first.ok || !concurrentDuplicate.ok) return;
  assert.equal(first.delivery.worker_session_id, WORKER);
  assert.equal(first.duplicate, false);
  assert.equal(concurrentDuplicate.duplicate, true);
  const restartedOwner = location(dir, WORKER);
  assert.equal(readReviewDelivery(restartedOwner, first.delivery.id)?.body, "Please address the two review findings.");
  assert.equal(readReviewDelivery(location(dir, "wrong-worker"), first.delivery.id), undefined);
  const sameDecision = comment(9005);
  const duplicateDecision = importer(dir, sameDecision);
  assert.equal(duplicateDecision.ok && duplicateDecision.duplicate, true, "a second comment cannot execute the same decision twice for one job/head");
});

test("unauthorized, free-form, wrong-target and stale-head comments fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-reject-"));
  waitingJob(dir);
  // Live GitHub verification: comment 6176836818 is authored by Matthew, not
  // an independently authenticated Lucy account; its body has no MWS envelope.
  // Keep the private prose out of the fixture: author allowlisting rejects it first.
  const incident = comment(6176836818, "matthewjameswatkins1978-cyber", "");
  assert.equal(importer(dir, incident).ok, false, "the incident comment's GitHub author is not an allowlisted reviewer");
  assert.equal(importer(dir, comment(9002, "stranger")).ok, false);
  assert.equal(importer(dir, comment(9003), "c".repeat(40)).ok, false);
  const malformed = comment(9004, "lucy-reviewer", "<!-- mws-review/v1\n{}\n-->");
  assert.equal(importer(dir, malformed).ok, false);
  const wrongPr = comment(9006);
  wrongPr.issue_url = "https://api.github.com/repos/owner/repo/issues/36";
  assert.equal(importer(dir, wrongPr).ok, false);
  const expired = comment(9007);
  expired.created_at = "2020-01-01T00:00:00.000Z";
  assert.equal(importer(dir, expired).ok, false);
  const beforeWait = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-no-wait-"));
  assert.equal(importer(beforeWait, comment(9008)).ok, false);
});

test("acknowledgement rechecks live SHA, resumes once, and duplicate ack is harmless", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-ack-"));
  const owner = waitingJob(dir);
  const imported = importer(dir, comment());
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const changed = acknowledgeReview(owner, imported.delivery.id, dir, "2026-10-14T12:30:00.000Z", () => ({ ok: true, pull_request: pullRequest("c".repeat(40)) }));
  assert.equal(changed.ok, false);
  const accepted = acknowledgeReview(owner, imported.delivery.id, dir, "2026-10-14T12:31:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(accepted.ok, true);
  const after = readJob(owner);
  assert.equal(after.kind === "loaded" && after.job.status, "WORKING");
  const repeated = acknowledgeReview(location(dir, WORKER), imported.delivery.id, dir, "2026-10-14T12:32:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(repeated.ok, true);
  assert.match(repeated.reason, /already acknowledged/);
});

test("review from an unavailable worker can be queued centrally but only that session can receive it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-offline-"));
  waitingJob(dir);
  const queued = importer(dir, comment());
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const resumedSession = location(dir, WORKER);
  assert.equal(readReviewDelivery(resumedSession, queued.delivery.id)?.state, "pending");
  assert.equal(readReviewDelivery(location(dir, "other-session"), queued.delivery.id), undefined);
});

test("hold decision acknowledgement persists without resuming", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-review-hold-"));
  const owner = waitingJob(dir);
  const hold = comment(9010);
  hold.body = `Please wait for one more check.\n<!-- mws-review/v1\n${JSON.stringify({ repository: REPOSITORY, pull_request: 35, job_id: JOB, head_sha: HEAD, decision: "hold" })}\n-->`;
  const imported = importer(dir, hold);
  assert.equal(imported.ok, true);
  if (!imported.ok) return;
  const ack = acknowledgeReview(owner, imported.delivery.id, dir, "2026-10-14T12:40:00.000Z", () => ({ ok: true, pull_request: pullRequest() }));
  assert.equal(ack.ok, true);
  const after = readJob(owner);
  assert.equal(after.kind === "loaded" && after.job.status, "WAITING_REVIEW");
});
