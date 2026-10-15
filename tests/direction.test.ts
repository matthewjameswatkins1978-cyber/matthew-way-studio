/**
 * Human direction, deterministically.
 *
 * Provenance (a verified user-originated turn) is proved in
 * human-direction.test.ts against the real extension; this file proves the
 * pure half of the contract: the quote must be Matthew's own words, a pause
 * never changes status, a redirect supersedes the plan without destroying
 * evidence or the contract, a wait is released as a human override and never
 * as approval, and the newest direction wins while older ones survive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDirection, latestDirection, validateDirectionQuote } from "../src/direction.js";
import { applyBlock, applyComplete, applyReviewWait, applyReviewWaitRecovery } from "../src/mission.js";
import { newJob, normalizeJob, SCHEMA_VERSION, type JobState } from "../src/schema.js";

const HEAD40 = "a".repeat(40);

function baseJob(): JobState {
  const job = newJob({
    jobId: "job-direction",
    contract: {
      objective: "Add a status file to the repository.",
      scope: ["one file"],
      authority: ["local edits"],
      constraints: ["never force-push"],
      acceptance: ["status.json exists"],
      attention: ["irreversible choices"],
    },
    repo: { root: "D:/r", remote: "https://github.com/owner/repo.git", branch: "feature/x", base_sha: HEAD40, current_sha: HEAD40, dirty_at_start: false },
    packet: { sha256: "c".repeat(64), bytes: 10, path: "packet.md" },
    nextAction: "Write status.json.",
  });
  return {
    ...job,
    evidence: {
      ...job.evidence,
      checks: [{ name: "node -e read", status: "pass", at: "2026-10-15T00:00:00.000Z", accepts: [1] }],
      commits: [HEAD40],
      pushed_shas: [HEAD40],
    },
  };
}

function waitingJob(): JobState {
  return applyReviewWait(baseJob(), {
    repository: "owner/repo",
    pull_request: 7,
    url: "https://github.com/owner/repo/pull/7",
    branch: "feature/x",
    head_sha: HEAD40,
    worker_session_id: "worker-1",
    requested_review: "general",
  });
}

function blockedJob(): JobState {
  return applyBlock(baseJob(), {
    kind: "judgement",
    reason: "the packet does not say which of two layouts is wanted",
    exact_human_need: "choose the layout",
    resume_condition: "layout named",
  });
}

test("a direction must be verbatim words from Matthew's current message", () => {
  const prompt = "I've changed my mind. Do this instead: build a CHANGELOG.md, not the status file.";

  assert.equal(validateDirectionQuote(prompt, "Do this instead: build a CHANGELOG.md, not the status file.").ok, true);
  assert.equal(validateDirectionQuote(prompt, "build a changelog.md").ok, true, "matching is case-insensitive");
  assert.equal(validateDirectionQuote("Pause\r\nthis until I tell you otherwise.", "Pause\r\nthis until I tell you otherwise").ok, true, "CRLF is the same message");

  const absent = validateDirectionQuote(prompt, "delete the whole repository");
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /verbatim/);

  const empty = validateDirectionQuote("", "pause everything");
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /no current human message/);

  const tiny = validateDirectionQuote(prompt, "stop");
  assert.equal(tiny.ok, false);
  assert.match(tiny.reason, /too short/);

  const huge = validateDirectionQuote(prompt, "x".repeat(601));
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /longer than 600/);
});

test("questions and quoted text cannot impersonate a direction", () => {
  const question = validateDirectionQuote("Should we pause this until I tell you otherwise?", "Should we pause this until I tell you otherwise?");
  assert.equal(question.ok, false);
  assert.match(question.reason, /question/);

  const cited = validateDirectionQuote('What did you mean by "build a CHANGELOG.md"?', "build a CHANGELOG.md");
  assert.equal(cited.ok, false);
  assert.match(cited.reason, /quotation marks/);

  const wrapped = validateDirectionQuote("I never said this, but: \"pause the mission\"", '"pause the mission"');
  assert.equal(wrapped.ok, false);
  assert.match(wrapped.reason, /quotation marks/);
});

test("pause stops continuation without changing status or destroying anything", () => {
  const job = baseJob();
  const paused = applyDirection(job, { mode: "pause", text: "Pause this until I tell you otherwise." });

  assert.equal(paused.status, "WORKING");
  assert.equal(paused.continuation.allowed, false);
  assert.match(paused.continuation.reason, /paused by Matthew/);
  assert.equal(paused.directions.length, 1);
  assert.equal(paused.directions[0]?.from_status, "WORKING");
  assert.deepEqual(paused.evidence, job.evidence, "evidence survives a pause");
  assert.deepEqual(paused.constraints, job.constraints, "constraints survive a pause");
  assert.deepEqual(paused.acceptance, job.acceptance);
  assert.equal(paused.rules.digest, job.rules.digest, "the pinned rules are untouched");
  assert.equal(paused.objective, job.objective);
  assert.equal(paused.progress.next_action, job.progress.next_action);

  const waiting = applyDirection(waitingJob(), { mode: "pause", text: "Pause this until I tell you otherwise." });
  assert.equal(waiting.status, "WAITING_REVIEW", "pausing never abandons or fabricates a review decision");
  assert.ok(waiting.review_wait, "the review wait is retained");
  assert.equal(waiting.continuation.allowed, false);
  assert.match(waiting.directions[0]?.note ?? "", /no reviewer decision was made/);

  const blocked = applyDirection(blockedJob(), { mode: "pause", text: "Pause this until I tell you otherwise." });
  assert.equal(blocked.status, "NEEDS_HUMAN", "pausing does not resolve a human-owned block");
  assert.ok(blocked.blocker, "the blocker stays recorded");
});

test("redirect supersedes the older plan while evidence and contract survive", () => {
  const job = baseJob();
  const steered = applyDirection(job, {
    mode: "redirect",
    text: "I've changed my mind. Do this instead: build a CHANGELOG.md.",
    next_action: "Write CHANGELOG.md instead of status.json.",
  });

  assert.equal(steered.status, "WORKING");
  assert.equal(steered.progress.next_action, "Write CHANGELOG.md instead of status.json.");
  assert.equal(steered.continuation.allowed, true);
  assert.equal(steered.continuation.runs, 0, "a human direction renews the run allowance");
  assert.equal(steered.continuation.unchanged_streak, 0);
  assert.equal(steered.objective, job.objective, "history is preserved, not rewritten");
  assert.deepEqual(steered.evidence, job.evidence);
  assert.deepEqual(steered.scope, job.scope);
  assert.deepEqual(steered.attention, job.attention);
  assert.equal(steered.rules.digest, job.rules.digest);
  assert.match(latestDirection(steered)?.note ?? "", /superseded/);

  // Without an explicit next action the direction itself becomes the next step.
  const implied = applyDirection(job, { mode: "redirect", text: "Work on the README instead of the status file." });
  assert.equal(implied.progress.next_action, "Work on the README instead of the status file.");
});

test("a redirect from WAITING_REVIEW releases the wait as a human override, never approval", () => {
  const job = waitingJob();
  const steered = applyDirection(job, { mode: "redirect", text: "Don't wait for the review — fix the README instead." });

  assert.equal(steered.status, "WORKING");
  assert.equal(steered.review_wait, undefined, "the wait is released, not silently kept");
  assert.match(steered.continuation.reason, /not reviewer approval/);
  assert.match(steered.directions[0]?.note ?? "", /never reviewer approval, never permission to merge/);
  assert.deepEqual(steered.evidence.human_confirmed, [], "a direction records no acceptance confirmations");
  assert.deepEqual(steered.evidence, job.evidence, "review and check history survive");

  const resumed = applyDirection(waitingJob(), { mode: "resume", text: "Carry on yourself, the reviewer is offline." });
  assert.equal(resumed.status, "WORKING");
  assert.equal(resumed.review_wait, undefined);
  assert.equal(resumed.progress.next_action, job.progress.next_action, "resume keeps the existing plan");
});

test("resume releases a human-owned block and re-arms continuation", () => {
  const job = blockedJob();
  const steered = applyDirection(job, { mode: "redirect", text: "Skip the judgement call: use the simpler layout." });
  assert.equal(steered.status, "WORKING");
  assert.equal(steered.blocker, undefined);
  assert.equal(steered.continuation.allowed, true);
  assert.equal(steered.progress.next_action, "Skip the judgement call: use the simpler layout.");
  assert.deepEqual(steered.evidence, job.evidence, "blocked evidence survives the redirect");

  const held = applyDirection(blockedJob(), { mode: "pause", text: "Pause this until I tell you otherwise." });
  assert.equal(held.status, "NEEDS_HUMAN");
  assert.equal(held.continuation.allowed, false);
});

test("the newest direction wins while older directions stay on the record", () => {
  const job = baseJob();
  const first = applyDirection(job, { mode: "redirect", text: "Do this instead: build a CHANGELOG.md." });
  const second = applyDirection(first, { mode: "redirect", text: "No — fix the README first, then stop." });

  assert.equal(second.directions.length, 2, "the superseded direction is not destroyed");
  assert.equal(second.directions[0]?.text, "Do this instead: build a CHANGELOG.md.");
  assert.equal(latestDirection(second)?.text, "No — fix the README first, then stop.");
  assert.equal(second.progress.next_action, "No — fix the README first, then stop.");
  assert.equal(second.directions[1]?.from_status, "WORKING");
});

test("a closed mission is never reopened by steering", () => {
  const closed = applyComplete(baseJob(), { outcome: "PARTIAL", summary: "half of it" }, "receipt");
  assert.throws(() => applyDirection(closed, { mode: "redirect", text: "Do this instead: build a CHANGELOG.md." }), /already closed as PARTIAL/);
  assert.throws(() => applyDirection(closed, { mode: "pause", text: "Pause this until I tell you otherwise." }), /already closed/);
  assert.equal(closed.status, "PARTIAL", "the refusal changes nothing");

  assert.throws(() => applyDirection(baseJob(), { mode: "teleport" as never, text: "Do this instead: something." }), /unknown direction mode/);
  assert.throws(() => applyDirection(baseJob(), { mode: "redirect", text: "Should we stop?" }), /question/);
  assert.throws(() => applyDirection(baseJob(), { mode: "redirect", text: "stop" }), /at least 6 characters/);
});

test("a released wait never makes the ledger unreadable", () => {
  const steered = applyDirection(waitingJob(), { mode: "redirect", text: "Don't wait for the review — fix the README instead." });
  assert.equal(steered.review_wait, undefined, "the released target is history, not live state");
  const advanced = { ...steered, repo: { ...steered.repo, current_sha: "b".repeat(40) } };
  assert.equal(normalizeJob(JSON.parse(JSON.stringify(advanced))).repo.current_sha, "b".repeat(40), "a later commit cannot corrupt the snapshot");

  // The narrow human recovery keeps the wait as history; it must stay readable too.
  const recovered = applyReviewWaitRecovery(waitingJob(), { mode: "resume", reason: "the reviewer is offline" });
  const drifted = { ...recovered, repo: { ...recovered.repo, current_sha: "b".repeat(40) } };
  assert.equal(normalizeJob(JSON.parse(JSON.stringify(drifted))).status, "WORKING");

  // An ACTIVE wait still enforces exact branch and head identity.
  const waiting = waitingJob();
  const moved = { ...waiting, repo: { ...waiting.repo, current_sha: "b".repeat(40) } };
  assert.throws(() => normalizeJob(JSON.parse(JSON.stringify(moved))), /identity does not match/);
  assert.throws(() => normalizeJob(JSON.parse(JSON.stringify({ ...waiting, review_wait: undefined }))), /no exact review target/);
});

test("directions survive the durable round trip and junk is dropped", () => {
  const steered = applyDirection(baseJob(), { mode: "redirect", text: "Do this instead: build a CHANGELOG.md." });
  const round = normalizeJob(JSON.parse(JSON.stringify(steered)) as unknown);
  assert.equal(round.schema_version, SCHEMA_VERSION);
  assert.deepEqual(round.directions, steered.directions, "the direction record is the reload path");

  const legacy = { ...steered, schema_version: 3 } as Record<string, unknown>;
  delete legacy["directions"];
  const migrated = normalizeJob(legacy);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.deepEqual(migrated.directions, [], "pre-direction missions migrate with an empty record");

  const junked = normalizeJob({
    ...steered,
    directions: ["nope", { mode: "teleport", text: "ignored", from_status: "WORKING", at: "t", note: "" }, { mode: "pause", text: "Pause this until I tell you otherwise.", from_status: "WORKING", at: "2026-10-15T00:00:00.000Z", note: "n" }],
  });
  assert.equal(junked.directions.length, 1);
  assert.equal(junked.directions[0]?.text, "Pause this until I tell you otherwise.");

  let busy = baseJob();
  for (let i = 0; i < 25; i++) {
    busy = applyDirection(busy, { mode: "redirect", text: `Direction number ${i} — do this instead of the previous one.` });
  }
  assert.equal(busy.directions.length, 20, "the record is capped");
  assert.match(busy.directions[19]?.text ?? "", /Direction number 24/);
});
