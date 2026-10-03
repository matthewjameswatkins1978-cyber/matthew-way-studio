import { test } from "node:test";
import assert from "node:assert/strict";
import { decideContinuation, DEFAULT_LIMITS } from "../src/continuation.js";
import { progressSignature, newJob, type JobState } from "../src/schema.js";

function job(overrides: Partial<JobState> = {}): JobState {
  const base = newJob({
    jobId: "job-cont",
    contract: { objective: "finish the runtime", scope: [], authority: [], constraints: [], acceptance: ["tests pass"], attention: [] },
    repo: { root: "/r", remote: "", branch: "main", base_sha: "a".repeat(40), current_sha: "a".repeat(40), dirty_at_start: false },
    packet: { sha256: "b".repeat(64), bytes: 1, path: "/p" },
    nextAction: "write tests",
  });
  return { ...base, ...overrides };
}

const ok = { turnCompleted: true, errored: false, aborted: false };

test("a working mission with progress continues automatically", () => {
  const moved = job({ progress: { ...job().progress, milestone: "ledger" } });
  const decision = decideContinuation(moved, ok);
  assert.equal(decision.action, "continue");
  if (decision.action !== "continue") return;
  assert.match(decision.instruction, /STUDIO CONTINUATION/);
  assert.match(decision.instruction, /write tests/);
  assert.equal(decision.continuation.runs, 1);
  assert.equal(decision.continuation.allowed, true);
});

test("repeating the same non-progressing state stops after the allowed streak", () => {
  const still = job();
  let state = still;
  const actions: string[] = [];
  for (let i = 0; i < 5; i++) {
    const decision = decideContinuation(state, ok, { ...DEFAULT_LIMITS, maxUnchangedTurns: 3 });
    actions.push(decision.action);
    if (decision.action === "continue") state = { ...state, continuation: decision.continuation };
  }
  assert.deepEqual(actions, ["continue", "continue", "continue", "stall", "stall"], "three quiet turns, then the stop-loss holds");
});

test("an errored turn does not extend the loop indefinitely", () => {
  let state = job();
  const actions: string[] = [];
  for (let i = 0; i < 4; i++) {
    const decision = decideContinuation(state, { turnCompleted: false, errored: true, aborted: false }, { ...DEFAULT_LIMITS, maxErrorStreak: 2 });
    actions.push(decision.action);
    state = { ...state, continuation: decision.continuation };
  }
  assert.deepEqual(actions.slice(0, 2), ["continue", "stall"], "second identical failure stops the loop");
  assert.equal(actions[2], "settle", "a stalled mission stays idle without polling");
});

test("a user abort never auto-continues", () => {
  const decision = decideContinuation(job(), { turnCompleted: false, errored: false, aborted: true });
  assert.equal(decision.action, "settle");
  assert.equal(decision.continuation.allowed, false);
});

test("NEEDS_HUMAN and terminal states stop continuation", () => {
  assert.equal(decideContinuation(job({ status: "NEEDS_HUMAN" }), ok).action, "settle");
  assert.equal(decideContinuation(job({ status: "COMPLETE" }), ok).action, "settle");
  assert.equal(decideContinuation(job({ status: "PARTIAL" }), ok).action, "settle");
});

test("an explicit hold stays quiet until a human resumes it", () => {
  const held = job({ continuation: { ...job().continuation, allowed: false, reason: "execution held by packet" } });
  const decision = decideContinuation(held, ok);
  assert.equal(decision.action, "settle");
  assert.equal(decision.continuation.runs, 0);
  assert.equal(decision.continuation.allowed, false);
});

test("run allowance is a hard ceiling", () => {
  const nearLimit = job({ continuation: { allowed: true, runs: DEFAULT_LIMITS.maxTurns, unchanged_streak: 0, error_streak: 0, last_signature: "different|sig", reason: "" } });
  const decision = decideContinuation(nearLimit, ok);
  assert.equal(decision.action, "stall");
  if (decision.action === "stall") assert.match(decision.reason, /run allowance exhausted/);
});

test("progress clears both error and unchanged streaks", () => {
  const streaked = job({
    continuation: { allowed: true, runs: 3, unchanged_streak: 2, error_streak: 2, last_signature: "old", reason: "" },
    progress: { milestone: "new", next_action: "ship", attempts: 4, child_work: "", reconciliations: [] },
  });
  const decision = decideContinuation(streaked, ok);
  assert.equal(decision.action, "continue");
  if (decision.action !== "continue") return;
  assert.equal(decision.continuation.unchanged_streak, 0);
  assert.equal(decision.continuation.error_streak, 0);
});

test("continuation instruction names the stall remedy when nothing moved", () => {
  const stalled = job();
  // Same signature as the previous turn => no measurable progress.
  stalled.continuation = { ...stalled.continuation, runs: 1, unchanged_streak: 1, last_signature: progressSignature(stalled) };
  const decision = decideContinuation(stalled, ok);
  assert.equal(decision.action, "continue");
  if (decision.action !== "continue") return;
  assert.match(decision.instruction, /Do not repeat the same action/);
});
