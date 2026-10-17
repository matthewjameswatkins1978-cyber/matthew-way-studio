import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LedgerLocation } from "../src/paths.js";
import { readPacket, writeJob, readJob } from "../src/ledger.js";
import {
  assessBlockerAdmission,
  applyBlock,
  applyCheckpoint,
  applyComplete,
  applyCompletionRefused,
  applyMemory,
  applyReviewWait,
  blockerSignature,
  evaluateCompletion,
  initialNextAction,
  resumeCandidate,
  startMission,
} from "../src/mission.js";
import { parseSections } from "../src/packet.js";
import { normalizeJob, progressSignature, type JobState } from "../src/schema.js";
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
  assert.match(job.rules.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(job.rules.entries.some((r) => r.key === "friction.absorb-noise"), true);
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

test("a small crossed wire is reconciled in-place and counts as progress", () => {
  const job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const before = progressSignature(job);
  const fixed = applyCheckpoint(job, {
    reconciliation: "Packet said config.toml, but live repository truth shows settings.toml; using settings.toml.",
    next_action: "Update settings.toml.",
  });
  assert.equal(fixed.status, "WORKING");
  assert.equal(fixed.progress.reconciliations.length, 1);
  assert.match(fixed.progress.reconciliations[0]?.note ?? "", /live repository truth/);
  assert.notEqual(progressSignature(fixed), before, "repairing understanding is measurable progress");

  const duplicate = applyCheckpoint(fixed, {
    reconciliation: "Packet said config.toml, but live repository truth shows settings.toml; using settings.toml.",
  });
  assert.equal(duplicate.progress.reconciliations.length, 1, "identical reconciliation is not spammed");
});

test("WAITING_REVIEW is durable and bound to this job, branch, head and worker", () => {
  const job = startMission({ packet: PACKET, location: location(), facts: facts() });
  const input = {
    repository: "acme/widget",
    pull_request: 35,
    url: "https://github.com/acme/widget/pull/35",
    branch: "feature/reviewed-work",
    head_sha: "1111111111111111111111111111111111111111",
    worker_session_id: "pi-session-a",
    requested_review: "correction" as const,
    requested_at: "2026-10-14T20:00:00.000Z",
  };
  const waiting = applyReviewWait({ ...job, repo: { ...job.repo, branch: input.branch } }, input);
  assert.equal(waiting.status, "WAITING_REVIEW");
  assert.equal(waiting.review_wait?.job_id, job.job_id);
  assert.equal(waiting.review_wait?.worker_session_id, "pi-session-a");
  assert.equal(waiting.continuation.allowed, false);
  assert.equal(waiting.continuation.runs, job.continuation.runs);
  assert.equal(applyReviewWait(waiting, input), waiting, "duplicate wait registration is idempotent");
  assert.throws(() => applyReviewWait(waiting, { ...input, worker_session_id: "pi-session-b" }), /different reviewer wait/);
  assert.throws(() => applyReviewWait({ ...job, repo: { ...job.repo, branch: input.branch } }, { ...input, head_sha: "2222222222222222222222222222222222222222" }), /head SHA/);  const staleSnapshot = { ...waiting, repo: { ...waiting.repo, current_sha: "2222222222222222222222222222222222222222" } };
  assert.throws(() => normalizeJob(staleSnapshot), /does not match its job, branch and current head SHA/);
});
test("ambiguous blockers must absorb noise before spending human attention", () => {
  assert.equal(assessBlockerAdmission("credential", []).ok, true, "a credential is genuinely human-owned");
  const vague = assessBlockerAdmission("other", []);
  assert.equal(vague.ok, false);
  assert.match(vague.reason, /infer safely|crossed wire|different valid route/);
  assert.equal(assessBlockerAdmission("other", ["checked live repo truth and tried the alternate path"]).ok, true);
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
  assert.equal(job.acceptance.length, 2);
  const bare = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: false });
  assert.equal(bare.ok, false);
  assert.equal(bare.problems.length >= 2, true);

  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }], commits: ["3".repeat(40)] });
  const stillNoPush = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: false });
  assert.ok(stillNoPush.problems.some((p) => /remote re-check failed/.test(p)));

  const okGate = evaluateCompletion(
    applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass", accepts: [1, 2] }] }),
    { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: true },
  );
  assert.equal(okGate.ok, true, okGate.problems.join(", "));
});

test("untagged evidence can never bind acceptance items", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass" }] });
  const gate = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: "3".repeat(40), push_verified: true });
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.some((p) => /acceptance items without passing evidence: #1.*#2/.test(p)));
});

test("verify_push=false over stale evidence cannot complete", () => {
  const head = "a".repeat(40);
  const stale = "b".repeat(40);
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, {
    checks: [{ name: "npm test", status: "pass", accepts: [1, 2] }],
    pushed_shas: [stale],
  });
  // Stale pushed SHA presented explicitly: binding refuses.
  const explicit = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: head, pushed_sha: stale, push_verified: false });
  assert.equal(explicit.ok, false);
  assert.ok(explicit.problems.some((p) => /does not match final revision/.test(p)));
  // Stale recorded evidence with verification skipped: refused.
  const skipped = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: head });
  assert.equal(skipped.ok, false);
  assert.ok(skipped.problems.some((p) => /push not verified/.test(p)));
  // A failed fresh re-check blocks even with older ship evidence.
  const moved = evaluateCompletion(
    applyCheckpoint(job, { pushed_shas: [head] }),
    { outcome: "COMPLETE", summary: "done", head_sha: head, push_verified: false },
  );
  assert.equal(moved.ok, false);
  assert.ok(moved.problems.some((p) => /remote re-check failed/.test(p)));
  // Ship-verified evidence for the final revision with verification skipped: allowed.
  const recorded = applyCheckpoint(job, { pushed_shas: [head] });
  const gate = evaluateCompletion(recorded, { outcome: "COMPLETE", summary: "done", head_sha: head });
  assert.equal(gate.ok, true, gate.problems.join(", "));
});

test("agent-supplied dogfood citations never cover acceptance", () => {
  const head = "d".repeat(40);
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, {
    checks: [{ name: "npm test", status: "pass", accepts: [1] }],
    pushed_shas: [head],
  });
  // Even an explicit #2 citation in dogfood is a request, not evidence.
  const cited = evaluateCompletion(job, { outcome: "COMPLETE", summary: "done", head_sha: head, dogfood: ["#2 renders correctly in the GUI"] });
  assert.equal(cited.ok, false);
  assert.ok(cited.problems.some((p) => /acceptance items without passing evidence: #2/.test(p)));
});

test("human confirmations are never recorded: same-run confirmation fails closed", () => {
  const head = "e".repeat(40);
  // Mid-flight fabrication is dropped at the pure layer...
  let working = startMission({ packet: PACKET, location: location(), facts: facts() });
  working = applyCheckpoint(working, { next_action: "go", human_confirmed: [2] });
  assert.deepEqual(working.evidence.human_confirmed, []);
  assert.equal(working.status, "WORKING");
  // ...and a confirmation arriving on the NEEDS_HUMAN resume edge is dropped
  // too: NEEDS_HUMAN status cannot prove a human replied, because the
  // checkpoint itself runs inside the agent turn.
  let blocked = applyBlock(working, { kind: "judgement", reason: "r", exact_human_need: "eyeball #2", resume_condition: "reply" });
  blocked = applyCheckpoint(blocked, {
    next_action: "finish",
    checks: [{ name: "npm test", status: "pass", accepts: [1] }],
    pushed_shas: [head],
    human_confirmed: [2, 99],
  });
  assert.equal(blocked.status, "WORKING", "the resume edge still reopens");
  assert.deepEqual(blocked.evidence.human_confirmed, [], "confirmations are dropped even on the resume edge");
  const gate = evaluateCompletion(blocked, { outcome: "COMPLETE", summary: "done", head_sha: head });
  assert.equal(gate.ok, false, "a human-gated item must refuse COMPLETE");
  assert.ok(gate.problems.some((p) => /acceptance items without passing evidence: #2/.test(p)));
  assert.ok(gate.problems.some((p) => /PARTIAL/.test(p)), "the refusal must point at PARTIAL");
  const partial = evaluateCompletion(blocked, { outcome: "PARTIAL", summary: "needs a human to eyeball #2" });
  assert.equal(partial.ok, true, partial.problems.join(", "));
});
test("a dirty worktree blocks COMPLETE but not PARTIAL", () => {
  let job = startMission({ packet: PACKET, location: location(), facts: facts() });
  job = applyCheckpoint(job, { checks: [{ name: "npm test", status: "pass", accepts: [1, 2] }], pushed_shas: ["c".repeat(40)] });
  const dirty = evaluateCompletion(
    job,
    { outcome: "COMPLETE", summary: "done", head_sha: "c".repeat(40) },
    { dirty: true },
  );
  assert.equal(dirty.ok, false);
  assert.ok(dirty.problems.some((p) => /worktree is dirty/.test(p)));
  const partial = evaluateCompletion(job, { outcome: "PARTIAL", summary: "dirty, handing over" }, { dirty: true });
  assert.equal(partial.ok, true, partial.problems.join(", "));
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

test("a blocked mission only reopens on the human resume edge", () => {
  const loc = location();
  const job = startMission({ packet: PACKET, location: loc, facts: facts() });
  const blocked = applyBlock(job, { kind: "judgement", reason: "two designs", exact_human_need: "pick a design", resume_condition: "Matthew picks" });
  assert.equal(blocked.status, "NEEDS_HUMAN");
  const auto = applyCheckpoint(blocked, { checks: [{ name: "summary", status: "pass" }] }, { resumeEdge: false });
  assert.equal(auto.status, "NEEDS_HUMAN", "an automatic turn records evidence without reopening");
  assert.ok(auto.blocker, "the blocker stays attached to its mission");
  const human = applyCheckpoint(blocked, { checks: [{ name: "recheck", status: "pass" }] }, { resumeEdge: true });
  assert.equal(human.status, "WORKING", "a human message after the block re-authorises the resume edge");
});

test("applyCompletionRefused holds the loop instead of restarting engineering work", () => {
  const loc = location();
  const job = startMission({ packet: PACKET, location: loc, facts: facts() });
  const held = applyCompletionRefused(job, ["push not verified: run studio_ship"]);
  assert.equal(held.continuation.allowed, false, "the loop is held");
  assert.match(held.continuation.reason, /studio_complete refused/);
  assert.match(held.progress.next_action, /do not redo completed engineering work/i);
  assert.equal(held.status, "WORKING", "a refusal is not a mission outcome");
});
