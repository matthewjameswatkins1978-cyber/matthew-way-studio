/**
 * Mission identity and lifecycle regression tests.
 *
 * These cover the reported failure modes directly:
 *   - earlier mission states displayed after new assignments begin;
 *   - unrelated new sessions inheriting or continuing old missions;
 *   - NEEDS_HUMAN contaminating unrelated work;
 *   - completed/stopped jobs auto-resuming without authorised intent;
 *   - stop-loss reacting to a mission that is already stopped;
 *   - studio_complete checking Git from the wrong working directory.
 *
 * Contract under test: one session owns one current mission; a new instruction
 * parks the previous mission as recoverable history instead of silently
 * inheriting or destroying it; automatic continuation belongs to the session's
 * current mission only; terminal missions reopen only on explicit intent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents, activeJobPath, savePacket } from "../src/ledger.js";
import { startMission } from "../src/mission.js";
import { ledgerLocation } from "../src/paths.js";
import { repoFacts } from "../src/git.js";
import type {
  PiApi,
  PiBeforeAgentStartEvent,
  PiBoundaryEvent,
  PiBoundaryResult,
  PiContext,
  PiToolContext,
  PiToolDefinition,
} from "../src/pi-shim.js";

interface Harness {
  tools: Map<string, PiToolDefinition>;
  events: Map<string, Array<(event: any, ctx: PiContext) => any>>;
  notifications: string[];
  status: Array<string | undefined>;
  api: PiApi;
}

function makeHarness(): Harness {
  const tools = new Map<string, PiToolDefinition>();
  const events = new Map<string, Array<(event: any, ctx: PiContext) => any>>();
  const notifications: string[] = [];
  const status: Array<string | undefined> = [];
  const api: PiApi = {
    on(event, handler) {
      const list = events.get(event) ?? [];
      list.push(handler as any);
      events.set(event, list);
      return () => {};
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    getAllTools: () => [{ name: "read" }, { name: "mcp__lantern__lantern_context" }],
  };
  return { tools, events, notifications, status, api };
}

function ctxFor(cwd: string, harness: Harness, sessionId?: string): PiToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    ui: {
      notify: (message) => harness.notifications.push(message),
      setStatus: (_key, text) => {
        harness.status.push(text);
      },
    },
    isProjectTrusted: () => true,
    tools: [{ name: "read" }],
    executeTool: async () => ({ isError: false, content: [{ type: "text", text: "stub" }] }),
    ...(sessionId ? { sessionManager: { getSessionId: () => sessionId } } : {}),
  } as PiToolContext;
}

async function emit(harness: Harness, event: string, payload: any, ctx: PiContext): Promise<any> {
  const handlers = harness.events.get(event) ?? [];
  let last: any;
  for (const handler of handlers) last = await handler(payload, ctx);
  return last;
}

function startEvent(prompt: string, messageType: "user" | "custom" = "user"): PiBeforeAgentStartEvent {
  return { type: "before_agent_start", messageType, prompt, systemPrompt: "", systemPromptOptions: {} };
}

function settleEvent(outcome: "completed" | "aborted" | "error" = "completed"): PiBoundaryEvent {
  return { type: "agent_before_settle", outcome, entries: [], continue: false, context: { canContinue: false } };
}

function tempRepo(): { base: string; dir: string; remote: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-lifecycle-"));
  const remote = path.join(base, "remote.git");
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
  execFileSync("git", ["init", "--initial-branch=main", dir], { encoding: "utf8" });
  for (const [k, v] of [
    ["user.email", "studio@test.local"],
    ["user.name", "Studio Test"],
  ] as Array<[string, string]>) {
    execFileSync("git", ["config", k, v], { cwd: dir, encoding: "utf8" });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir });
  return { base, dir, remote };
}

function packetFor(objective: string, extra: string[] = []): string {
  return [
    "# MATTHEW WAY STUDIO - LIFECYCLE",
    "## OBJECTIVE",
    objective,
    "## SCOPE",
    "- one bounded deliverable",
    "## ACCEPTANCE",
    "- the deliverable exists",
    "## ATTENTION",
    "- nothing irreversible",
    "## IMPLEMENTATION ORDER",
    "1. Do the work.",
    "2. Record evidence.",
    "",
    "Pad the packet with enough ordinary detail that a real harness treats it as a substantive mission rather than a one-line ask. ".repeat(4),
    ...extra,
    "",
  ].join("\n");
}

function lastStatus(harness: Harness): string {
  for (let i = harness.status.length - 1; i >= 0; i--) {
    const value = harness.status[i];
    if (value !== undefined) return value;
  }
  return "";
}

function sectionOf(event: PiBeforeAgentStartEvent): string {
  return event.systemPromptOptions.sections?.["studio_mission"] ?? "";
}

async function seed(harness: Harness, ctx: PiToolContext, packet: string): Promise<void> {
  await emit(harness, "before_agent_start", startEvent(packet), ctx);
}

function loadedJob(cwd: string, sessionId?: string) {
  const read = readJob(ledgerLocation(cwd, sessionId));
  assert.equal(read.kind, "loaded", "expected a loaded mission");
  if (read.kind !== "loaded") throw new Error("unreachable");
  return read.job;
}

// ---------------------------------------------------------------- scenarios --

test("a new instruction parks the previous mission and starts the new one", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));
  const first = loadedJob(dir);
  await harness.tools.get("studio_checkpoint")!.execute("c1", { milestone: "status file", next_action: "write it" }, undefined, undefined, ctx);

  const steer = startEvent(packetFor("Build the cache layer for the ingest pipeline."));
  await emit(harness, "before_agent_start", steer, ctx);

  const second = loadedJob(dir);
  assert.notEqual(second.job_id, first.job_id, "a different objective is a new instruction, not steering");
  assert.equal(second.objective.includes("cache layer"), true, "the new assignment is the current mission");
  assert.match(sectionOf(steer), /cache layer/, "the new instruction owns the run");
  assert.doesNotMatch(sectionOf(steer), /status file/i, "the old mission must not bleed into the new assignment");

  const parkedPath = path.join(ledgerLocation(dir).dir, "jobs", first.job_id, "state.json");
  assert.ok(fs.existsSync(parkedPath), "the previous mission is parked as recoverable history");
  const parked = JSON.parse(fs.readFileSync(parkedPath, "utf8"));
  assert.equal(parked.job_id, first.job_id);
  assert.equal(parked.progress.next_action, "write it", "parked history preserves the actual evidence and authority state");
  const events = readEvents(ledgerLocation(dir), 200).map((e) => e.type);
  assert.ok(events.includes("mission-parked"), "parking is recorded in the append-only trail");
  assert.match(lastStatus(harness), /cache layer|WORKING/, "the status line follows the current assignment");
});

test("a duplicate packet is folded in and never restarts the mission", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  const packet = packetFor("Add the status file to the repository.");
  await seed(harness, ctx, packet);
  const first = loadedJob(dir);
  const eventsBefore = readEvents(ledgerLocation(dir), 200).length;

  const again = startEvent(packet);
  await emit(harness, "before_agent_start", again, ctx);

  const second = loadedJob(dir);
  assert.equal(second.job_id, first.job_id, "the same packet is the same mission");
  assert.equal(readEvents(ledgerLocation(dir), 200).length, eventsBefore, "no mission-start event for a duplicate");
  assert.match(sectionOf(again), /STUDIO MISSION/, "the duplicate still sees the live mission");
});

test("a correction sharing the objective continues the mission", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));
  const first = loadedJob(dir);

  const correction = startEvent(packetFor("Add the status file to the repository.", ["## CONSTRAINTS", "- use JSON, not YAML"]));
  await emit(harness, "before_agent_start", correction, ctx);

  const second = loadedJob(dir);
  assert.equal(second.job_id, first.job_id, "same objective = correction/continuation of the same mission");
});

test("an unrelated new session neither inherits nor continues the old mission", async () => {
  for (const scoped of [true, false]) {
    const { dir } = tempRepo();
    const first = makeHarness();
    registerStudio(first.api);
    const ctxA = ctxFor(dir, first, scoped ? "worker-a" : undefined);
    await seed(first, ctxA, packetFor("Add the status file to the repository."));
    await emit(first, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxA);

    const second = makeHarness();
    registerStudio(second.api);
    const ctxB = ctxFor(dir, second, scoped ? "worker-b" : undefined);
    await emit(second, "session_start", { type: "session_start", reason: "new" }, ctxB);
    assert.doesNotMatch(lastStatus(second), /^studio: WORKING/, `unrelated session must not display the old mission as current (scoped=${scoped})`);
    assert.match(lastStatus(second), /idle/, `a session with no current job says so (scoped=${scoped})`);
    assert.ok(!second.notifications.some((n) => n.includes("resuming mission")), "no resurrection notice for someone else's mission");

    const unrelated = startEvent("why is the sky blue on a clear day");
    await emit(second, "before_agent_start", unrelated, ctxB);
    assert.doesNotMatch(sectionOf(unrelated), /STUDIO MISSION|STUDIO RESUME/, "unrelated work is not contaminated with mission state");

    const boundary: PiBoundaryResult | undefined = await emit(second, "agent_before_settle", settleEvent(), ctxB);
    assert.equal(boundary, undefined, "no automatic continuation of a mission this session does not own");
  }
});

test("a NEEDS_HUMAN blocker stays with its mission and does not claim Matthew replied to unrelated work", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));
  const blocked = await harness.tools.get("studio_blocked")!.execute(
    "b1",
    { kind: "judgement", reason: "two plausible designs", exact_human_need: "a steer on the storage format", resume_condition: "Matthew names the format." },
    undefined,
    undefined,
    ctx,
  );
  assert.match(blocked.content[0]?.text ?? "", /NEEDS_HUMAN|steer/i);
  const mission = loadedJob(dir);
  assert.equal(mission.status, "NEEDS_HUMAN");

  const unrelated = startEvent("why is the sky blue on a clear day");
  await emit(harness, "before_agent_start", unrelated, ctx);
  assert.doesNotMatch(sectionOf(unrelated), /Matthew just replied/, "an unrelated message is not a resume attempt");
  assert.match(sectionOf(unrelated), /NEEDS_HUMAN/, "the blocked state stays attached to its own mission");

  const steer = startEvent("done — the storage format is JSON");
  await emit(harness, "before_agent_start", steer, ctx);
  assert.match(sectionOf(steer), /Recheck the exact blocker/, "a genuine reply to the blocker is recognised as a resume attempt");

  // A new instruction while blocked parks the blocker intact instead of
  // dragging NEEDS_HUMAN into the new assignment.
  const fresh = startEvent(packetFor("Build the cache layer for the ingest pipeline."));
  await emit(harness, "before_agent_start", fresh, ctx);
  assert.doesNotMatch(sectionOf(fresh), /Matthew just replied|STUDIO RESUME|BLOCKER:/, "the new assignment starts clean");
  assert.match(sectionOf(fresh), /cache layer/, "the new assignment owns the run");
});

test("a completed mission is history, not current work, and never auto-resumes weakly", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));
  const done = await harness.tools.get("studio_complete")!.execute("d1", { outcome: "PARTIAL", summary: "status file delivered" }, undefined, undefined, ctx);
  assert.match(done.content[0]?.text ?? "", /PARTIAL|receipt|delivered/i);
  const closed = loadedJob(dir);
  assert.ok(closed.status === "PARTIAL", "the mission is recorded closed");

  await emit(harness, "agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.match(lastStatus(harness), /idle/, "Studio reports no current job once the mission is closed");
  assert.doesNotMatch(lastStatus(harness), /^studio: WORKING/, "a closed mission must not be displayed as current work");

  const weak = startEvent("continue");
  await emit(harness, "before_agent_start", weak, ctx);
  const afterWeak = loadedJob(dir);
  assert.ok(afterWeak.status === "PARTIAL", "a bare 'continue' must not reopen a completed mission");
  assert.equal(afterWeak.continuation.allowed, false, "a completed mission must not auto-resume");
  assert.equal(await emit(harness, "agent_before_settle", settleEvent(), ctx), undefined, "no continuation after completion");

  const strong = startEvent("resume the mission and finish the remaining acceptance item");
  await emit(harness, "before_agent_start", strong, ctx);
  const afterStrong = loadedJob(dir);
  assert.equal(afterStrong.status, "WORKING", "explicit mission resume is authorised intent and may reopen");
});

test("explicit stop holds the loop until Matthew asks again", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));

  const stop = startEvent("stop the mission for now");
  await emit(harness, "before_agent_start", stop, ctx);
  const paused = loadedJob(dir);
  assert.equal(paused.continuation.allowed, false, "explicit stop disarms automatic continuation");
  assert.equal(await emit(harness, "agent_before_settle", settleEvent(), ctx), undefined, "a stopped mission produces no automatic turns");

  const go = startEvent("continue");
  await emit(harness, "before_agent_start", go, ctx);
  const resumed = loadedJob(dir);
  assert.equal(resumed.continuation.allowed, true, "an explicit go-ahead re-arms the mission");
});

test("stop-loss fires once and an automatic turn cannot resurrect the blocked mission", async () => {
  const { dir } = tempRepo();
  const location = ledgerLocation(dir);
  fs.mkdirSync(location.dir, { recursive: true });
  fs.writeFileSync(path.join(location.dir, "config.json"), JSON.stringify({ maxUnchangedTurns: 1, maxErrorStreak: 5, maxTurns: 10, maxRecoveries: 0 }), "utf8");

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));

  await emit(harness, "agent_before_settle", settleEvent(), ctx);
  const stalled = await emit(harness, "agent_before_settle", settleEvent(), ctx);
  assert.equal(stalled, undefined, "a stalled mission settles quietly instead of spinning another turn");
  assert.ok(harness.notifications.some((n) => n.includes("stop-loss")), "the stop-loss is announced, not silent");
  const blocked = loadedJob(dir);
  assert.equal(blocked.status, "NEEDS_HUMAN", "stop-loss moves the mission to NEEDS_HUMAN");

  assert.equal(await emit(harness, "agent_before_settle", settleEvent(), ctx), undefined, "a stopped mission never settles into another stop-loss");
  const stopLossEvents = readEvents(location, 200).filter((e) => e.type === "stop-loss");
  assert.equal(stopLossEvents.length, 1, "stop-loss cannot repeatedly react to a mission that is already stopped");

  // The summary turn must not resurrect the mission it just stopped.
  await harness.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "summary", status: "pass" }] }, undefined, undefined, ctx);
  assert.equal(loadedJob(dir).status, "NEEDS_HUMAN", "an automatic checkpoint records evidence without resuming");

  await emit(harness, "before_agent_start", startEvent("restart"), ctx);
  await harness.tools.get("studio_checkpoint")!.execute("c2", { next_action: "carry on" }, undefined, undefined, ctx);
  assert.equal(loadedJob(dir).status, "WORKING", "a human message re-authorises the resume edge");
});

test("stop-loss recovery resumes a smaller slice within budget, then the stall holds", async () => {
  const { dir } = tempRepo();
  const location = ledgerLocation(dir);
  fs.mkdirSync(location.dir, { recursive: true });
  fs.writeFileSync(path.join(location.dir, "config.json"), JSON.stringify({ maxUnchangedTurns: 1, maxErrorStreak: 5, maxTurns: 10, maxRecoveries: 1 }), "utf8");

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));

  const first = await emit(harness, "agent_before_settle", settleEvent(), ctx);
  assert.ok(first && first.continue, "a progressing turn continues");
  const recovered = await emit(harness, "agent_before_settle", settleEvent(), ctx);
  assert.ok(recovered && recovered.continue, "the recovery resumes instead of blocking");
  const entries = JSON.stringify(recovered?.entries ?? []);
  assert.match(entries, /STOP-LOSS RECOVERY/, "the worker gets the diagnostic slice, not the stall");
  assert.ok(harness.notifications.some((n) => n.includes("stop-loss recovery")), "the recovery is announced");
  const mid = loadedJob(dir);
  assert.equal(mid.status, "WORKING", "recovery keeps the mission working");
  assert.equal(mid.continuation.recoveries, 1);
  const recoveryEvents = readEvents(location, 200).filter((e) => e.type === "stop-loss-recovery");
  assert.equal(recoveryEvents.length, 1);

  const stalled = await emit(harness, "agent_before_settle", settleEvent(), ctx);
  assert.equal(stalled, undefined, "an exhausted budget stalls quietly");
  assert.equal(loadedJob(dir).status, "NEEDS_HUMAN", "the repeated stall stops safely");
});

test("restart resumes the same session's mission and nothing else", async () => {
  const { dir } = tempRepo();
  const first = makeHarness();
  registerStudio(first.api);
  const ctxA = ctxFor(dir, first, "worker-one");
  await seed(first, ctxA, packetFor("Add the status file to the repository."));
  await emit(first, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctxA);

  const restarted = makeHarness();
  registerStudio(restarted.api);
  const ctxR = ctxFor(dir, restarted, "worker-one");
  await emit(restarted, "session_start", { type: "session_start", reason: "resume" }, ctxR);
  assert.ok(restarted.notifications.some((n) => n.includes("resuming mission")), "the same session picks its mission back up");
  const boundary = await emit(restarted, "agent_before_settle", settleEvent(), ctxR);
  assert.ok(boundary && boundary.continue === true, "the same session may continue its mission");

  const stranger = makeHarness();
  registerStudio(stranger.api);
  const ctxS = ctxFor(dir, stranger, "worker-two");
  await emit(stranger, "session_start", { type: "session_start", reason: "resume" }, ctxS);
  assert.ok(!stranger.notifications.some((n) => n.includes("resuming mission")), "a different session id never attaches by restart alone");
  assert.match(lastStatus(stranger), /idle/, "the stranger is told it supervises nothing");
});

test("studio_complete binds to the mission worktree, not the session working directory", async () => {
  const { base, dir } = tempRepo();
  const worktree = path.join(base, "mission-wt");
  execFileSync("git", ["worktree", "add", "-b", "mission/work", worktree], { cwd: dir, encoding: "utf8" });

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctxA = ctxFor(worktree, harness, "worker-w");
  await seed(harness, ctxA, packetFor("Add the status file to the repository."));
  fs.writeFileSync(path.join(worktree, "status.json"), "{}\n", "utf8");
  execFileSync("git", ["add", "status.json"], { cwd: worktree });
  execFileSync("git", ["commit", "-m", "status"], { cwd: worktree });
  execFileSync("git", ["push", "-u", "origin", "mission/work"], { cwd: worktree });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  await harness.tools.get("studio_checkpoint")!.execute(
    "c1",
    { checks: [{ name: "status-file-exists", status: "pass", accepts: [1] }], commits: [sha], pushed_shas: [sha], head_sha: sha },
    undefined,
    undefined,
    ctxA,
  );

  // The same session later runs from the main checkout of the same repository.
  const ctxB = ctxFor(dir, harness, "worker-w");
  const done = await harness.tools.get("studio_complete")!.execute(
    "d1",
    { outcome: "COMPLETE", summary: "status file delivered and pushed", head_sha: sha, pushed_sha: sha, verify_push: true },
    undefined,
    undefined,
    ctxB,
  );
  assert.equal(done.isError ?? false, false, `completion must verify the mission worktree, not the session cwd: ${done.content[0]?.text ?? ""}`);
  assert.equal(loadedJob(dir, "worker-w").status, "COMPLETE");
});

test("a missing mission worktree fails legibly instead of checking the wrong directory", async () => {
  const { base, dir } = tempRepo();
  const worktree = path.join(base, "mission-wt");
  execFileSync("git", ["worktree", "add", "-b", "mission/work", worktree], { cwd: dir, encoding: "utf8" });

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctxA = ctxFor(worktree, harness, "worker-w");
  await seed(harness, ctxA, packetFor("Add the status file to the repository."));
  const job = loadedJob(worktree, "worker-w");
  execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: dir, encoding: "utf8" });

  const ctxB = ctxFor(dir, harness, "worker-w");
  const done = await harness.tools.get("studio_complete")!.execute("d1", { outcome: "COMPLETE", summary: "done anyway", head_sha: job.repo.current_sha, pushed_sha: job.repo.current_sha }, undefined, undefined, ctxB);
  assert.equal(done.isError ?? false, true, "a missing mission worktree is a legible refusal");
  assert.match(done.content[0]?.text ?? "", /worktree|missing|gone/i);
  assert.notEqual(loadedJob(dir, "worker-w").status, "COMPLETE", "completion is never fabricated from the wrong repository");
});

test("a refused completion holds the loop instead of restarting engineering work", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await seed(harness, ctx, packetFor("Add the status file to the repository."));

  const refused = await harness.tools.get("studio_complete")!.execute("f1", { outcome: "COMPLETE", summary: "done" }, undefined, undefined, ctx);
  assert.equal(refused.isError ?? false, true, "COMPLETE without evidence is refused");
  const job = loadedJob(dir);
  assert.equal(job.continuation.allowed, false, "a failed completion must not automatically restart completed engineering work");
  assert.match(job.progress.next_action, /engineering|reconcil/i, "the next action says what to do instead");
  assert.equal(await emit(harness, "agent_before_settle", settleEvent(), ctx), undefined, "the loop stays held after a refused completion");
});

test("pre-existing v2 mission records stay readable and attach only to their own thread", async () => {
  const { dir } = tempRepo();
  const location = ledgerLocation(dir);
  const facts = repoFacts(dir);
  const build = makeHarness();
  registerStudio(build.api);
  const ctxBuild = ctxFor(dir, build, "builder");
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: ledgerLocation(dir, "builder"), facts });
  // Simulate a v2-era record: no worker_session_id, no review_wait.
  const legacy = { ...job, schema_version: 2 } as Record<string, unknown>;
  delete legacy.worker_session_id;
  delete legacy.review_wait;
  savePacket(location, job.job_id, packetFor("Add the status file to the repository."));
  fs.mkdirSync(location.dir, { recursive: true });
  fs.writeFileSync(activeJobPath(location), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const migrated = readJob(location);
  assert.equal(migrated.kind, "loaded", "old records remain readable after the identity change");
  if (migrated.kind !== "loaded") return;
  assert.equal(migrated.job.job_id, job.job_id);

  // The same thread (resume) keeps working on it.
  const same = makeHarness();
  registerStudio(same.api);
  const ctxSame = ctxFor(dir, same);
  await emit(same, "session_start", { type: "session_start", reason: "resume" }, ctxSame);
  assert.ok(same.notifications.some((n) => n.includes("resuming mission")), "thread continuity still resumes a migrated mission");

  // A brand-new thread must not inherit it.
  const fresh = makeHarness();
  registerStudio(fresh.api);
  const ctxFresh = ctxFor(dir, fresh);
  await emit(fresh, "session_start", { type: "session_start", reason: "new" }, ctxFresh);
  assert.match(lastStatus(fresh), /idle/, "a new thread sees history, not a current mission");
  void ctxBuild;
});

test("the mission's authoritative worktree can be re-bound explicitly", async () => {
  const { base, dir } = tempRepo();
  const worktree = path.join(base, "mission-wt");
  execFileSync("git", ["worktree", "add", "-b", "mission/work", worktree], { cwd: dir, encoding: "utf8" });
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-r");
  await seed(harness, ctx, packetFor("Add the status file to the repository."));
  const rebound = await harness.tools.get("studio_checkpoint")!.execute("r1", { repo_root: worktree, branch: "mission/work" }, undefined, undefined, ctx);
  assert.equal(rebound.isError ?? false, false, rebound.content[0]?.text ?? "");
  assert.equal(loadedJob(dir, "worker-r").repo.root, worktree, "the association is explicit and recorded");
  const events = readEvents(ledgerLocation(dir, "worker-r"), 50).map((e) => e.type);
  assert.ok(events.includes("repo-rebound"), "re-binding is recorded in the append-only trail");
  const refused = await harness.tools.get("studio_checkpoint")!.execute("r2", { repo_root: path.join(base, "ghost") }, undefined, undefined, ctx);
  assert.equal(refused.isError ?? false, true, "an invalid re-bind is refused, not recorded");
  assert.equal(loadedJob(dir, "worker-r").repo.root, worktree, "the recorded association survives a refused re-bind");
});
