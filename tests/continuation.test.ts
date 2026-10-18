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

test("a quiet mission recovers twice within budget, then the stop-loss holds", () => {
  const limits = { ...DEFAULT_LIMITS, maxUnchangedTurns: 3 };
  let state = job();
  const actions: string[] = [];
  for (let i = 0; i < 10; i++) {
    const decision = decideContinuation(state, ok, limits);
    actions.push(decision.action);
    if (decision.action === "continue" || decision.action === "recover") state = { ...state, continuation: decision.continuation };
  }
  assert.deepEqual(actions, ["continue", "continue", "continue", "recover", "continue", "continue", "recover", "continue", "continue", "stall"], "two bounded recoveries, then the exhausted budget stalls");
  const stalled = decideContinuation(state, ok, limits);
  assert.equal(stalled.action, "stall");
  assert.equal(stalled.continuation.allowed, false);
  // Feeding the stalled continuation back stays idle: the stop-loss holds.
  const settled = decideContinuation({ ...state, continuation: stalled.continuation }, ok, limits);
  assert.equal(settled.action, "settle");
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

test("WAITING_REVIEW settles without consuming runs or no-progress allowance", () => {
  const base = job();
  const waiting = job({
    status: "WAITING_REVIEW",
    review_wait: {
      repository: "acme/widget",
      pull_request: 35,
      url: "https://github.com/acme/widget/pull/35",
      branch: "feature/reviewed-work",
      head_sha: "a".repeat(40),
      job_id: base.job_id,
      worker_session_id: "pi-session-a",
      requested_review: "correction",
      requested_at: "2026-10-14T20:00:00.000Z",
    },
    continuation: { allowed: false, runs: 8, unchanged_streak: 2, error_streak: 1, recoveries: 0, last_signature: "same", reason: "waiting for reviewer decision" },
  });
  const decision = decideContinuation(waiting, { turnCompleted: true, errored: true, aborted: false });
  assert.equal(decision.action, "settle");
  assert.deepEqual(decision.continuation, waiting.continuation, "waiting preserves every counter and stays disarmed");
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
  const nearLimit = job({ continuation: { allowed: true, runs: DEFAULT_LIMITS.maxTurns, unchanged_streak: 0, error_streak: 0, recoveries: 0, last_signature: "different|sig", reason: "" } });
  const decision = decideContinuation(nearLimit, ok);
  assert.equal(decision.action, "stall");
  if (decision.action === "stall") assert.match(decision.reason, /run allowance exhausted/);
});

test("progress clears both error and unchanged streaks", () => {
  const streaked = job({
    continuation: { allowed: true, runs: 3, unchanged_streak: 2, error_streak: 2, recoveries: 0, last_signature: "old", reason: "" },
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

test("a three-turn stall recovers, then real progress continues", () => {
  const limits = { ...DEFAULT_LIMITS, maxUnchangedTurns: 3 };
  let state = job();
  for (let i = 0; i < 3; i++) {
    const step = decideContinuation(state, ok, limits);
    assert.equal(step.action, "continue");
    state = { ...state, continuation: step.continuation };
  }
  const decision = decideContinuation(state, ok, limits);
  assert.equal(decision.action, "recover");
  if (decision.action !== "recover") return;
  assert.equal(decision.continuation.recoveries, 1);
  assert.equal(decision.continuation.unchanged_streak, 0);
  assert.equal(decision.continuation.allowed, true);
  assert.match(decision.instruction, /STOP-LOSS RECOVERY 1\/2/);
  assert.match(decision.instruction, /Do not repeat the same action/);
  assert.match(decision.instruction, /smaller measurable slice/);
  assert.match(decision.instruction, /never reset worker_session_id/);
  state = { ...state, continuation: decision.continuation };
  // The recovery slice moves the mission: progress resumes normally.
  const moved = { ...state, progress: { ...state.progress, milestone: "recovery slice shipped" } };
  const resumed = decideContinuation(moved, ok, limits);
  assert.equal(resumed.action, "continue");
  assert.equal(resumed.continuation.unchanged_streak, 0);
  assert.equal(resumed.continuation.recoveries, 1, "consumed recoveries stay consumed");
});

test("a repeated stall with no budget left stops safely and stays idle", () => {
  const limits = { ...DEFAULT_LIMITS, maxUnchangedTurns: 3, maxRecoveries: 1 };
  let state = job();
  const actions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const decision = decideContinuation(state, ok, limits);
    actions.push(decision.action);
    if (decision.action === "continue" || decision.action === "recover") state = { ...state, continuation: decision.continuation };
  }
  assert.deepEqual(actions, ["continue", "continue", "continue", "recover", "continue", "continue"], "one recovery, then the next threshold stalls");
  const stalled = decideContinuation(state, ok, limits);
  assert.equal(stalled.action, "stall");
  assert.equal(stalled.continuation.allowed, false);
  const parked = { ...state, continuation: stalled.continuation };
  assert.equal(decideContinuation(parked, ok, limits).action, "settle");
  assert.equal(decideContinuation(parked, ok, limits).action, "settle", "staying idle without polling");
});

test("NEEDS_HUMAN at the stall threshold settles and never recovers", () => {
  const gated = job({
    status: "NEEDS_HUMAN",
    continuation: { allowed: true, runs: 9, unchanged_streak: 9, error_streak: 0, recoveries: 0, last_signature: progressSignature(job()), reason: "" },
  });
  const decision = decideContinuation(gated, ok);
  assert.equal(decision.action, "settle");
});

test("WAITING_REVIEW at the stall threshold settles: waiting is never permission to resume", () => {
  const waiting = job({
    status: "WAITING_REVIEW",
    continuation: { allowed: true, runs: 9, unchanged_streak: 9, error_streak: 0, recoveries: 0, last_signature: "same", reason: "" },
  });
  const decision = decideContinuation(waiting, ok);
  assert.equal(decision.action, "settle");
  assert.deepEqual(decision.continuation, waiting.continuation, "waiting preserves every counter and stays disarmed");
});

test("a completed mission at the stall threshold settles", () => {
  const done = job({
    status: "COMPLETE",
    continuation: { allowed: true, runs: 9, unchanged_streak: 9, error_streak: 0, recoveries: 0, last_signature: "same", reason: "" },
  });
  assert.equal(decideContinuation(done, ok).action, "settle");
});

test("an explicit hold at the stall threshold settles without consuming recovery budget", () => {
  const held = job({ continuation: { ...job().continuation, allowed: false, unchanged_streak: 9, reason: "execution held by packet" } });
  const decision = decideContinuation(held, ok);
  assert.equal(decision.action, "settle");
  assert.equal(decision.continuation.recoveries, 0);
});

test("exhausted error budget stalls even with recoveries left", () => {
  const limits = { ...DEFAULT_LIMITS, maxErrorStreak: 2, maxRecoveries: 5 };
  let state = job();
  const err = { turnCompleted: false, errored: true, aborted: false };
  const first = decideContinuation(state, err, limits);
  assert.equal(first.action, "continue");
  state = { ...state, continuation: first.continuation };
  const second = decideContinuation(state, err, limits);
  assert.equal(second.action, "stall");
  assert.match(second.reason, /consecutive failed turns/);
});

test("an exhausted run allowance stalls without recovery", () => {
  const nearLimit = job({ continuation: { allowed: true, runs: DEFAULT_LIMITS.maxTurns, unchanged_streak: 0, error_streak: 0, recoveries: 0, last_signature: "different|sig", reason: "" } });
  const decision = decideContinuation(nearLimit, ok);
  assert.equal(decision.action, "stall");
});

test("recovery mutates only the continuation: session and evidence are preserved", () => {
  const owned = job({ worker_session_id: "pi-session-recover" });
  owned.continuation = { ...owned.continuation, runs: 3, unchanged_streak: 2, last_signature: progressSignature(owned) };
  const before = JSON.stringify(owned);
  const decision = decideContinuation(owned, ok, { ...DEFAULT_LIMITS, maxUnchangedTurns: 3 });
  assert.equal(decision.action, "recover");
  assert.equal(JSON.stringify(owned), before, "the input job is never mutated");
  assert.match(decision.instruction, /never reset worker_session_id/, "the recovery playbook names session preservation");
});
