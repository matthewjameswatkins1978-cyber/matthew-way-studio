/** Handoff wait/wake transitions and poll-interval config. No Pi, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHandoffWait, applyWake } from "../src/mission.js";
import { mergeConfig, DEFAULT_CONFIG } from "../src/config.js";
import { canTransition, newJob, type JobState } from "../src/schema.js";

function workingJob(): JobState {
  return newJob({
    jobId: "job-1",
    contract: { objective: "o", scope: [], authority: [], constraints: [], acceptance: ["a"], attention: [] },
    repo: { root: "r", remote: "o/r", branch: "b", base_sha: "a".repeat(40), current_sha: "a".repeat(40), dirty_at_start: false },
    packet: { sha256: "s", bytes: 10, path: "p" },
    nextAction: "go",
  });
}

const target = {
  run_id: "run-1",
  role: "A2",
  repository: "o/r",
  issue: 16,
  cursor: "",
  branch: "b",
  head_sha: "a".repeat(40),
  worker_session_id: "sess-2",
};

test("WAITING_HANDOFF is reachable from WORKING and back, nothing else terminal", () => {
  assert.equal(canTransition("WORKING", "WAITING_HANDOFF"), true);
  assert.equal(canTransition("WAITING_HANDOFF", "WORKING"), true);
  assert.equal(canTransition("WAITING_HANDOFF", "COMPLETE"), false);
  assert.equal(canTransition("WAITING_HANDOFF", "PARTIAL"), false);
});

test("applyHandoffWait enters the wait with continuation stopped", () => {
  const waiting = applyHandoffWait(workingJob(), target);
  assert.equal(waiting.status, "WAITING_HANDOFF");
  assert.equal(waiting.continuation.allowed, false);
  assert.equal(waiting.handoff_wait?.run_id, "run-1");
  assert.equal(waiting.handoff_wait?.cursor, "");
});

test("applyHandoffWait refuses wrong state, mismatched head and re-wait conflicts", () => {
  assert.throws(() => applyHandoffWait(workingJob(), { ...target, head_sha: "b".repeat(40) }), /branch or head SHA/);
  assert.throws(() => applyHandoffWait(workingJob(), { ...target, head_sha: "A".repeat(40) }), /canonical 40/);
  const waiting = applyHandoffWait(workingJob(), target);
  assert.equal(applyHandoffWait(waiting, target).status, "WAITING_HANDOFF");
  assert.throws(() => applyHandoffWait(waiting, { ...target, role: "A3" }), /different handoff wait/);
});

test("applyWake resumes WORKING and points at the handoff", () => {
  const waiting = applyHandoffWait(workingJob(), target);
  const resumed = applyWake(waiting, { comment_id: 42, from: "A1", type: "handoff" });
  assert.equal(resumed.status, "WORKING");
  assert.equal(resumed.continuation.allowed, true);
  assert.match(resumed.progress.next_action, /A1/);
  assert.throws(() => applyWake(workingJob(), { comment_id: 1, from: "A1", type: "t" }), /not waiting/);
});

test("handoffPollMs defaults to 180s and clamps to [10s, 1h]", () => {
  assert.equal(DEFAULT_CONFIG.handoffPollMs, 180_000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { handoffPollMs: 5_000 }).handoffPollMs, 10_000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, { handoffPollMs: 9_999_999 }).handoffPollMs, 3_600_000);
  assert.equal(mergeConfig(DEFAULT_CONFIG, {}).handoffPollMs, 180_000);
});
