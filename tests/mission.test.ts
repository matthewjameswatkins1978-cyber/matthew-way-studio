import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LedgerLocation } from "../src/paths.js";
import { readPacket, writeJob, readJob } from "../src/ledger.js";
import {
  applyBlock,
  applyCheckpoint,
  applyComplete,
  applyMemory,
  blockerSignature,
  evaluateCompletion,
  initialNextAction,
  resumeCandidate,
  startMission,
} from "../src/mission.js";
import { parseSections } from "../src/packet.js";
import { progressSignature, type JobState } from "../src/schema.js";
import type { RepoFacts } from "../src/git.js";

function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return {
    root: "/repo",
    is_repo: true,
    remote: "git@github.com:acme/widget.git",
    branch: "main",
    head_sha: "1111111111111111111111111111111111111111",
    dirty: false,
    dirty_paths: [],
    upstream: "origin/main",
    detached: false,
    ...over,
  };
}

function location(): LedgerLocation {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-mission-"));
  return { dir, source: "fallback", repoRoot: dir };
}

const PACKET = `# MISSION
## OBJECTIVE
Ship the ledger.

## ACCEPTANCE
- tests pass
- pushed

## IMPLEMENTATION ORDER
1. Inspect current reality.
2. Implement durable job state.
`;

test("startMission compiles the contract and records the baseline", () => {
  const loc = location();
  const job = startMission({ packet: PACKET, location: loc, facts: facts() });
  assert.equal(job.status, "WORKING");
  assert.equal(job.objective, "Ship the ledger.");
  assert.equal(job.repo.base_sha, "1".repeat(40));
  assert.equal(job.repo.branch, "main");
  assert.deepEqual(job.acceptance, ["tests pass", "pushed"]);
  assert.match(job.packet.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readPacket(loc, job.job_id)?.includes("Ship the ledger"), true);
});

test("initialNextAction takes the first numbered step from the packet", () => {
  const sections = parseSections(PACKET);
  assert.equal(initialNextAction(PACKET, sections), "Inspect current reality.");
  assert.match(initialNextAction("just fix the bug", parseSections("just fix the bug")), /Inspect repository truth/);
});

test("checkpoint records evidence, caps lists and bumps attempts", () => {
  const job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const next = applyCheckpoint(job, {
    milestone: "M1 ledger",
    next_action: "implement tools",
    checks: [{ name: "npm test", status: "pass", detail: "12 ok" }],
    commits: ["a".repeat(40)],
    artifacts: Array.from({ length: 60 }, (_, i) => `f${i}`),
    head_sha: "2".repeat(40),
  });
  assert.equal(next.evidence.checks[0]?.name, "npm test");
  assert.equal(next.evidence.commits.length, 1);
  assert.equal(next.evidence.artifacts.length, 40, "artifacts are capped");
  assert.equal(next.repo.current_sha, "2".repeat(40));
  assert.equal(next.progress.attempts, 1);
  assert.equal(progressSignature(next) !== progressSignature(job), true);
});

test("named checkpoints overwrite rather than grow the ledger", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "fail" }] });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }] });
  assert.equal(job.evidence.checks.length, 1);
  assert.equal(job.evidence.checks[0]?.status, "pass");
});

test("WORKING -> NEEDS_HUMAN preserves state and disarms continuation", () => {
  const job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const blocked = applyBlock(job, {
    kind: "credential",
    reason: "no GitHub token for this machine",
    exact_human_need: "run `gh auth login`",
    resume_condition: "gh auth status succeeds",
  });
  assert.equal(blocked.status, "NEEDS_HUMAN");
  assert.equal(blocked.continuation.allowed, false);
  assert.equal(blocked.blocker?.kind, "credential");
  assert.match(blocked.blocker?.state_preserved ?? "", /main/);
  assert.match(blockerSignature({ kind: "credential", reason: "", exact_human_need: "run gh auth login", resume_condition: "gh auth status succeeds" }), /credential/);
});

test("the same blocker is counted, not duplicated", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const input = { kind: "access" as const, reason: "r", exact_human_need: "need repo write", resume_condition: "grant" };
  job = applyBlock(job, input);
  const again = applyBlock(job, input);
  assert.equal(again.blocker?.times_raised, 2);
  const different = applyBlock(again, { ...input, exact_human_need: "need a different secret" });
  assert.equal(different.blocker?.times_raised, 1);
});

test("NEEDS_HUMAN -> WORKING through a checkpoint clears the blocker and renews allowance", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyBlock(job, { kind: "credential", reason: "r", exact_human_need: "token", resume_condition: "added" });
  job = { ...job, continuation: { ...job.continuation, runs: 9, unchanged_streak: 2 } };
  const resumed = applyCheckpoint(job, { next_action: "continue implementation", checks: [{ name: "gh auth status", status: "pass" }] });
  assert.equal(resumed.status, "WORKING");
  assert.equal(resumed.blocker, undefined);
  assert.equal(resumed.continuation.runs, 0);
  assert.equal(resumed.continuation.allowed, true);
});

test("resumeCandidate never assumes the blocker is gone", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyBlock(job, { kind: "judgement", reason: "r", exact_human_need: "which name?", resume_condition: "a reply" });
  assert.equal(resumeCandidate(job, "call it Lantern").accept, true);
  assert.equal(resumeCandidate(job, "   ").accept, false);
  const working = applyCheckpoint(job, { next_action: "x" });
  assert.equal(resumeCandidate(working, "hello").note, "no blocked mission");
});

test("COMPLETE requires machine evidence, a revision and push verification", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const bare = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: false });
  assert.equal(bare.ok, false);
  assert.equal(bare.problems.length >= 2, true);

  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }], commits: ["3".repeat(40)] });
  const stillNoPush = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: false });
  assert.ok(stillNoPush.problems.some((p) => /push not verified/.test(p)));

  const okGate = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: true });
  assert.equal(okGate.ok, true, okGate.problems.join(", "));
});

test("a failing check refuses COMPLETE", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "fail", detail: "2 failures" }] });
  const gate = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "4".repeat(40), push_verified: true });
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.some((p) => /failing checks: npm test/.test(p)));
});

test("PARTIAL and FAILED are honest terminal outcomes", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "fail" }] });
  const partial = applyComplete(job, { outcome: "PARTIAL", summary: "runtime works, dogfood pending", head_sha: "5".repeat(40) }, "receipt");
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.result?.outcome, "PARTIAL");
  assert.equal(partial.continuation.allowed, false);
  const failed = applyComplete(job, { outcome: "FAILED", summary: "blocked by env" }, "receipt");
  assert.equal(failed.status, "FAILED");
});

test("complete records human dogfood as pending, not as a failure", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }] });
  const done = applyComplete(job, { outcome: "COMPLETE", summary: "shipped", head_sha: "6".repeat(40), pushed_sha: "6".repeat(40), push_verified: true, dogfood: ["Open Pi", "Paste a packet"] }, "receipt");
  assert.equal(done.human_dogfood.status, "pending");
  assert.deepEqual(done.human_dogfood.checks, ["Open Pi", "Paste a packet"]);
  assert.equal(done.progress.next_action, "Human dogfood check");
});

test("applyMemory records the Lantern path without touching progress", () => {
  const job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const before = progressSignature(job);
  const after = applyMemory(job, { lantern: "used", refs: ["mem-1"], decisions: ["ledger lives in git common dir"] });
  assert.equal(after.memory.lantern, "used");
  assert.deepEqual(after.memory.decisions_loaded, ["ledger lives in git common dir"]);
  assert.equal(progressSignature(after), before);
});

test("a checkpoint never reopens a terminal mission", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }] });
  const done = applyComplete(job, { outcome: "COMPLETE", summary: "shipped", head_sha: "7".repeat(40), push_verified: true }, "receipt");
  const afterShip = applyCheckpoint(done, { head_sha: "8".repeat(40), commits: ["8".repeat(40)] });
  assert.equal(afterShip.status, "COMPLETE", "recording evidence does not restart a closed mission");
  assert.equal(afterShip.continuation.allowed, false);
  assert.equal(afterShip.repo.current_sha, "8".repeat(40), "but the evidence is still kept");
});

test("re-declaring the same outcome is a reaffirmation, not a second completion", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }] });
  const done = applyComplete(job, { outcome: "COMPLETE", summary: "shipped", head_sha: "7".repeat(40), push_verified: true }, "receipt");
  assert.equal(evaluateCompletion(done, { outcome: "COMPLETE", summary: "shipped", head_sha: "7".repeat(40), push_verified: true }).reaffirm, true);
  const changed = evaluateCompletion(done, { outcome: "PARTIAL", summary: "actually incomplete", head_sha: "7".repeat(40) });
  assert.equal(changed.ok, false, "a terminal mission cannot silently change outcome");
  assert.ok(changed.problems.some((p) => /already recorded as COMPLETE/.test(p)));
});

test("a mission written by one runtime is readable by the next", () => {
  const loc = location();
  let job = startMission({ packet: PACKET, location: loc, facts: facts() });
  job = applyCheckpoint(job, { milestone: "M2", next_action: "wire the boundary", checks: [{ name: "tsc", status: "pass" }] });
  writeJob(loc, job);
  const reload = readJob(loc);
  assert.equal(reload.kind, "loaded");
  if (reload.kind !== "loaded") return;
  assert.deepEqual(reload.job, job);
  assert.equal(reload.job.progress.next_action, "wire the boundary");
});
