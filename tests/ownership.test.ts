/**
 * Mission-ownership boundary tests.
 *
 * A mission has one owning session. A detached session (a different, unrelated
 * conversation sharing the same legacy ledger) may read that mission as
 * history but must never mutate or close it through any state-mutating tool.
 * A substantive new instruction during WAITING_REVIEW is independent work: the
 * waiting mission is preserved verbatim and the switch is never treated as
 * reviewer approval or wait recovery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents, writeJob, activeJobPath, readJobSnapshot } from "../src/ledger.js";
import { startMission, applyReviewWait } from "../src/mission.js";
import { ledgerLocation, type LedgerLocation } from "../src/paths.js";
import { repoFacts } from "../src/git.js";
import type {
  PiApi,
  PiBeforeAgentStartEvent,
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
    getAllTools: () => [{ name: "read" }],
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

function tempRepo(): { base: string; dir: string; remote: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-ownership-"));
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

function packetFor(objective: string): string {
  return [
    "# MATTHEW WAY STUDIO - OWNERSHIP",
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
    "",
  ].join("\n");
}

function rawActive(cwd: string, sessionId?: string): string {
  return fs.readFileSync(activeJobPath(ledgerLocation(cwd, sessionId)), "utf8");
}

function makeWaitingJob(loc: LedgerLocation, dir: string, workerId: string) {
  const facts = repoFacts(dir);
  const job = startMission({ packet: packetFor("Wait for review on the status file."), location: loc, facts });
  return applyReviewWait(job, {
    repository: "matthewjameswatkins1978-cyber/matthew-way-studio",
    pull_request: 7,
    url: "https://example.test/pull/7",
    branch: facts.branch,
    head_sha: facts.head_sha.toLowerCase(),
    worker_session_id: workerId,
    requested_review: "general",
  });
}

// ------------------------------------------------------------- tool gates --

test("a detached session cannot mutate or close a shared-ledger mission through any tool", async () => {
  const { dir } = tempRepo();
  const owner = makeHarness();
  registerStudio(owner.api);
  const ownerCtx = ctxFor(dir, owner);
  await emit(owner, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ownerCtx);
  await owner.tools.get("studio_checkpoint")!.execute("c0", { milestone: "M1", next_action: "write it" }, undefined, undefined, ownerCtx);
  const before = rawActive(dir);

  // A genuinely new conversation sharing the same legacy ledger: detached.
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const strangerCtx = ctxFor(dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, strangerCtx);

  const mutations: Array<[string, () => Promise<any>]> = [
    ["studio_checkpoint", () => stranger.tools.get("studio_checkpoint")!.execute("t1", { checks: [{ name: "sneaky", status: "pass" }] }, undefined, undefined, strangerCtx)],
    ["studio_blocked", () => stranger.tools.get("studio_blocked")!.execute("t2", { kind: "judgement", reason: "r", exact_human_need: "n", resume_condition: "c" }, undefined, undefined, strangerCtx)],
    ["studio_ship", () => stranger.tools.get("studio_ship")!.execute("t3", { commit: false }, undefined, undefined, strangerCtx)],
    ["studio_complete", () => stranger.tools.get("studio_complete")!.execute("t4", { outcome: "PARTIAL", summary: "closing your mission" }, undefined, undefined, strangerCtx)],
    ["studio_wait_for_review", () => stranger.tools.get("studio_wait_for_review")!.execute("t5", { pull_request: 1 }, undefined, undefined, strangerCtx)],
    ["studio_ack_review", () => stranger.tools.get("studio_ack_review")!.execute("t6", { delivery_id: "ghost" }, undefined, undefined, strangerCtx)],
  ];
  for (const [name, call] of mutations) {
    const result = await call();
    assert.equal(result.isError ?? false, true, `${name} must refuse a detached session`);
    assert.match(result.content[0]?.text ?? "", /not attached to this session|belongs to another Pi session/, `${name} refusal must say why`);
    assert.equal(rawActive(dir), before, `${name} refusal left the mission record byte-identical`);
  }

  // Retrieval stays read-only: no ledger write may leak through studio_context.
  const context = await stranger.tools.get("studio_context")!.execute("t7", { query: "why the ledger" }, undefined, undefined, strangerCtx);
  assert.equal(context.isError ?? false, false, "reading stays allowed for a detached session");
  assert.equal(rawActive(dir), before, "studio_context recorded nothing against a detached mission");
  const events = readEvents(ledgerLocation(dir), 200).map((e) => e.type);
  assert.ok(!events.includes("context-retrieval"), "no memory write for a detached mission");
});

test("the owning session keeps full use of the mission tools", async () => {
  const { dir } = tempRepo();
  const owner = makeHarness();
  registerStudio(owner.api);
  const ctx = ctxFor(dir, owner);
  await emit(owner, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ctx);

  const checkpoint = await owner.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "suite", status: "pass", accepts: [1] }] }, undefined, undefined, ctx);
  assert.equal(checkpoint.isError ?? false, false, "the owner checkpoints normally");
  const ship = await owner.tools.get("studio_ship")!.execute("c2", { dry_run: true }, undefined, undefined, ctx);
  assert.match(ship.content[0]?.text ?? "", /DRY RUN/, "the owner ships normally");
  const complete = await owner.tools.get("studio_complete")!.execute("c3", { outcome: "PARTIAL", summary: "status file delivered" }, undefined, undefined, ctx);
  assert.equal(complete.isError ?? false, false, "the owner closes normally");
  const after = readJob(ledgerLocation(dir));
  assert.equal(after.kind === "loaded" && after.job.status, "PARTIAL");
});

test("another session's mission readable through a shared ledger is refused by name", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const facts = repoFacts(dir);
  const foreign = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts });
  writeJob(loc, { ...foreign, worker_session_id: "someone-elses-session" });

  const stranger = makeHarness();
  registerStudio(stranger.api);
  const ctx = ctxFor(dir, stranger);
  const result = await stranger.tools.get("studio_checkpoint")!.execute("f1", { checks: [{ name: "sneaky", status: "pass" }] }, undefined, undefined, ctx);
  assert.equal(result.isError ?? false, true);
  assert.match(result.content[0]?.text ?? "", /belongs to another Pi session/);
  const after = readJob(loc);
  assert.equal(after.kind === "loaded" && after.job.evidence.checks.length, 0, "the foreign mission is untouched");
});

// --------------------------------------------------- WAITING_REVIEW switch --

test("a new instruction during WAITING_REVIEW parks the review mission and starts independent work", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir, "worker-w");
  const waiting = makeWaitingJob(loc, dir, "worker-w");
  writeJob(loc, waiting);
  const beforeJob = readJob(loc);
  assert.equal(beforeJob.kind, "loaded");
  if (beforeJob.kind !== "loaded") return;

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-w");
  const steer = startEvent(packetFor("Build the cache layer for the ingest pipeline."));
  await emit(harness, "before_agent_start", steer, ctx);

  const active = readJob(loc);
  assert.equal(active.kind, "loaded");
  if (active.kind !== "loaded") return;
  assert.notEqual(active.job.job_id, waiting.job_id, "the new instruction is a new mission");
  assert.equal(active.job.status, "WORKING");
  assert.equal(active.job.review_wait, undefined, "no review state is carried into the new mission");
  assert.match(steer.systemPromptOptions.sections?.["studio_mission"] ?? "", /cache layer/, "the new mission owns the run");
  assert.doesNotMatch(steer.systemPromptOptions.sections?.["studio_mission"] ?? "", /WAITING_REVIEW/, "no review state leaks into the new mission");

  // The review mission is preserved verbatim: identity, review wait, history.
  const parked = readJobSnapshot(loc, waiting.job_id);
  assert.equal(parked.kind, "loaded");
  if (parked.kind !== "loaded") return;
  assert.deepEqual(parked.job, beforeJob.job, "the parked record preserves the mission unchanged");
  assert.equal(parked.job.status, "WAITING_REVIEW");
  assert.deepEqual(parked.job.review_wait, waiting.review_wait, "the review wait is preserved exactly");
  assert.equal(parked.job.worker_session_id, "worker-w", "mission identity is preserved");

  const events = readEvents(loc, 200);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("mission-parked"), "the park is recorded");
  assert.ok(types.includes("mission-switch"), "the switch is recorded");
  assert.ok(!types.includes("review-wait-recovery"), "a new instruction is never wait recovery");
  const parkEvent = events.find((e) => e.type === "mission-parked");
  assert.match(String(parkEvent?.reason ?? ""), /WAITING_REVIEW/, "the park reason names the review wait");
});

test("review recovery works for the owning session and is refused for a detached one", async () => {
  // Positive: the owning worker session releases its own wait.
  const first = tempRepo();
  const scoped = ledgerLocation(first.dir, "worker-w");
  const waiting = makeWaitingJob(scoped, first.dir, "worker-w");
  writeJob(scoped, waiting);
  const owner = makeHarness();
  registerStudio(owner.api);
  const ownerCtx = ctxFor(first.dir, owner, "worker-w");
  await emit(owner, "before_agent_start", startEvent("cancel review wait"), ownerCtx);
  const released = readJob(scoped);
  assert.equal(released.kind === "loaded" && released.job.status, "WORKING", "the owning session's authorised recovery still works");
  assert.ok(readEvents(scoped, 100).some((e) => e.type === "review-wait-recovery"), "the recovery is recorded for the owner");

  // Negative: a detached session reading the same shared legacy ledger.
  const second = tempRepo();
  const shared = ledgerLocation(second.dir);
  const foreignWait = makeWaitingJob(shared, second.dir, "worker-w");
  writeJob(shared, foreignWait);
  const before = rawActive(second.dir);
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const strangerCtx = ctxFor(second.dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, strangerCtx);
  await emit(stranger, "before_agent_start", startEvent("cancel review wait"), strangerCtx);
  assert.ok(stranger.notifications.some((n) => n.includes("refusing to recover")), "the refusal is announced");
  assert.equal(rawActive(second.dir), before, "the wait and its mission are unchanged");
  assert.ok(!readEvents(shared, 100).some((e) => e.type === "review-wait-recovery"), "no recovery was recorded");
});

// ------------------------------------------ final identity review regressions

test("same-directory conversations without stable ids never share an ownership token", async () => {
  const { dir } = tempRepo();
  const a = makeHarness();
  registerStudio(a.api);
  const aCtx = ctxFor(dir, a);
  await emit(a, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), aCtx);
  await a.tools.get("studio_checkpoint")!.execute("a1", { checks: [{ name: "a-suite", status: "pass" }] }, undefined, undefined, aCtx);
  const before = rawActive(dir);

  // A genuinely new conversation in the SAME directory, without session ids.
  const b = makeHarness();
  registerStudio(b.api);
  const bCtx = ctxFor(dir, b);
  await emit(b, "session_start", { type: "session_start", reason: "new" }, bCtx);
  const seed = startEvent(packetFor("Build the cache layer for the ingest pipeline."));
  await emit(b, "before_agent_start", seed, bCtx);
  assert.equal(rawActive(dir), before, "the new conversation never parks or replaces the live mission");
  const checkpoint = await b.tools.get("studio_checkpoint")!.execute("b1", { checks: [{ name: "sneaky", status: "pass" }] }, undefined, undefined, bCtx);
  assert.equal(checkpoint.isError ?? false, true, "the new conversation cannot checkpoint the live mission");
  assert.match(checkpoint.content[0]?.text ?? "", /belongs to another Pi session/, "the refusal names the owner");
  const complete = await b.tools.get("studio_complete")!.execute("b2", { outcome: "PARTIAL", summary: "closing your mission" }, undefined, undefined, bCtx);
  assert.equal(complete.isError ?? false, true, "the new conversation cannot complete the live mission");
  assert.equal(rawActive(dir), before, "identity, repository facts and completion state are untouched");
  const status = await b.tools.get("studio_status")!.execute("b3", {}, undefined, undefined, bCtx);
  assert.match(status.content[0]?.text ?? "", /NOT this session's mission|not attached/, "status does not present the live mission as current work");

  // The original conversation keeps working normally.
  const more = await a.tools.get("studio_checkpoint")!.execute("a2", { checks: [{ name: "a-final", status: "pass" }] }, undefined, undefined, aCtx);
  assert.equal(more.isError ?? false, false, "the owning conversation continues undisturbed");
  const after = readJob(ledgerLocation(dir));
  assert.equal(after.kind === "loaded" && after.job.evidence.checks.map((c) => c.name).join(","), "a-suite,a-final", "only the owner's evidence lands");
});

test("recovering an abandoned mission takes exclusive ownership", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const abandoned = startMission({ packet: packetFor("Finish the abandoned ingest work."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, { ...abandoned, worker_session_id: `legacy:${dead.pid ?? 999999}:deadbeef` });

  // Session B recovers the abandoned mission and starts working.
  const b = makeHarness();
  registerStudio(b.api);
  const bCtx = ctxFor(dir, b);
  await emit(b, "session_start", { type: "session_start", reason: "resume" }, bCtx);
  assert.ok(b.notifications.some((n) => n.includes("resuming mission")), "an abandoned mission is durably recoverable");
  await b.tools.get("studio_checkpoint")!.execute("b1", { checks: [{ name: "b-suite", status: "pass" }] }, undefined, undefined, bCtx);
  assert.ok(readEvents(loc, 100).some((e) => e.type === "claim-taken"), "recovery establishes exclusive ownership");
  const owned = rawActive(dir);

  // Session C now attempts the same recovery: refused while B owns the mission.
  const c = makeHarness();
  registerStudio(c.api);
  const cCtx = ctxFor(dir, c);
  await emit(c, "session_start", { type: "session_start", reason: "new" }, cCtx);
  await emit(c, "before_agent_start", startEvent("resume the mission"), cCtx);
  assert.ok(c.notifications.some((n) => n.includes("refusing")), "the competing recovery is refused");
  const steal = await c.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "sneaky", status: "pass" }] }, undefined, undefined, cCtx);
  assert.equal(steal.isError ?? false, true, "the recovered mission has exactly one writable owner");
  assert.equal(rawActive(dir), owned, "B's ownership record is unchanged by C's attempts");

  // B keeps working undisturbed.
  const more = await b.tools.get("studio_checkpoint")!.execute("b2", { checks: [{ name: "b-final", status: "pass" }] }, undefined, undefined, bCtx);
  assert.equal(more.isError ?? false, false, "the owner keeps working after the competing attempt");
});

// ------------------------------------------- Lucy review boundary regressions

test("a detached session's fresh mission is attached to it from the start", async () => {
  for (const duringWait of [false, true]) {
    const { dir } = tempRepo();
    const loc = ledgerLocation(dir);
    if (duringWait) {
      const waiting = makeWaitingJob(loc, dir, "worker-w");
      writeJob(loc, waiting);
    }
    const stranger = makeHarness();
    registerStudio(stranger.api);
    const ctx = ctxFor(dir, stranger);
    await emit(stranger, "session_start", { type: "session_start", reason: "new" }, ctx);
    await emit(stranger, "before_agent_start", startEvent(packetFor("Build the cache layer for the ingest pipeline.")), ctx);
    const fresh = readJob(loc);
    assert.equal(fresh.kind, "loaded");
    if (fresh.kind !== "loaded") continue;
    assert.equal(fresh.job.status, "WORKING", `fresh mission seeded (duringWait=${duringWait})`);

    const checkpoint = await stranger.tools.get("studio_checkpoint")!.execute("a1", { checks: [{ name: "suite", status: "pass" }] }, undefined, undefined, ctx);
    assert.equal(checkpoint.isError ?? false, false, `the creating session checkpoints its own mission (duringWait=${duringWait}): ${checkpoint.content[0]?.text ?? ""}`);
    const after = readJob(loc);
    assert.equal(after.kind === "loaded" && after.job.evidence.checks.length, 1, "the checkpoint landed on the fresh mission");
    const boundary = await emit(stranger, "agent_before_settle", { type: "agent_before_settle", outcome: "completed", entries: [], continue: false, context: { canContinue: false } }, ctx);
    assert.ok(boundary && (boundary as any).continue === true, `continuation works for the fresh mission (duringWait=${duringWait})`);
  }
});

test("detached lifecycle writes are bounded to the intentional emergency stop", async () => {
  // Emergency stop: a shared mission without a foreign owner can be disarmed
  // from another session, but nothing else about it changes.
  const first = tempRepo();
  const owner = makeHarness();
  registerStudio(owner.api);
  const ownerCtx = ctxFor(first.dir, owner);
  await emit(owner, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ownerCtx);
  await owner.tools.get("studio_checkpoint")!.execute("e0", { milestone: "M1" }, undefined, undefined, ownerCtx);
  const beforeJob = readJob(ledgerLocation(first.dir));
  assert.equal(beforeJob.kind, "loaded");
  if (beforeJob.kind !== "loaded") return;
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const strangerCtx = ctxFor(first.dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, strangerCtx);
  await emit(stranger, "before_agent_start", startEvent("stop the mission for now"), strangerCtx);
  const after = readJob(ledgerLocation(first.dir));
  assert.equal(after.kind === "loaded" && after.job.continuation.allowed, false, "the emergency stop disarms the loop");
  if (after.kind !== "loaded") return;
  assert.deepEqual({ ...after.job, continuation: beforeJob.job.continuation, updated_at: beforeJob.job.updated_at }, beforeJob.job, "only continuation state changes");
  assert.ok(readEvents(ledgerLocation(first.dir), 100).some((e) => e.type === "paused" && e.from_detached_session === true), "the cross-session stop is recorded explicitly");

  // A foreign worker's mission is protected even from the emergency stop.
  const second = tempRepo();
  const foreignLoc = ledgerLocation(second.dir);
  const foreign = startMission({ packet: packetFor("Add the status file to the repository."), location: foreignLoc, facts: repoFacts(second.dir) });
  writeJob(foreignLoc, { ...foreign, worker_session_id: "someone-elses-session" });
  const foreignBefore = rawActive(second.dir);
  const intruder = makeHarness();
  registerStudio(intruder.api);
  const intruderCtx = ctxFor(second.dir, intruder);
  await emit(intruder, "session_start", { type: "session_start", reason: "new" }, intruderCtx);
  await emit(intruder, "before_agent_start", startEvent("stop the mission for now"), intruderCtx);
  assert.equal(rawActive(second.dir), foreignBefore, "a foreign mission is untouched by the stop");
  assert.ok(!readEvents(foreignLoc, 100).some((e) => e.type === "paused"), "no pause event for a foreign mission");

  // session_shutdown from a detached session never rewrites the mission.
  const third = tempRepo();
  const thirdLoc = ledgerLocation(third.dir);
  const owner3 = makeHarness();
  registerStudio(owner3.api);
  const owner3Ctx = ctxFor(third.dir, owner3);
  await emit(owner3, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), owner3Ctx);
  const shutdownBefore = rawActive(third.dir);
  const eventsBefore = readEvents(thirdLoc, 100).length;
  const stranger3 = makeHarness();
  registerStudio(stranger3.api);
  const stranger3Ctx = ctxFor(third.dir, stranger3);
  await emit(stranger3, "session_start", { type: "session_start", reason: "new" }, stranger3Ctx);
  await emit(stranger3, "session_shutdown", { type: "session_shutdown", reason: "quit" }, stranger3Ctx);
  assert.equal(rawActive(third.dir), shutdownBefore, "a detached shutdown leaves the mission byte-identical");
  assert.equal(readEvents(thirdLoc, 100).length, eventsBefore, "no session-shutdown event from a detached session");
});

test("a detached run never consumes allowance even with stale session flags", async () => {
  const { dir } = tempRepo();
  const owner = makeHarness();
  registerStudio(owner.api);
  const ownerCtx = ctxFor(dir, owner);
  await emit(owner, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ownerCtx);
  // The owner's run leaves the shared legacy runOwned flag set to true.
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const strangerCtx = ctxFor(dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, strangerCtx);
  const before = rawActive(dir);
  const boundary = await emit(stranger, "agent_before_settle", { type: "agent_before_settle", outcome: "completed", entries: [], continue: false, context: { canContinue: false } }, strangerCtx);
  assert.equal(boundary, undefined, "no automatic continuation for a detached run");
  assert.equal(rawActive(dir), before, "allowance and stop-loss counters are untouched");
});

test("status rendering uses true attachment through agent_end", async () => {
  const { dir } = tempRepo();
  const owner = makeHarness();
  registerStudio(owner.api);
  const ownerCtx = ctxFor(dir, owner);
  await emit(owner, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ownerCtx);
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const strangerCtx = ctxFor(dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, strangerCtx);
  await emit(stranger, "agent_end", { type: "agent_end", messages: [] }, strangerCtx);
  const shown = [...stranger.status].reverse().find((s) => s !== undefined) ?? "";
  assert.match(shown, /idle|parked/, "a detached conversation shows the mission as history");
  assert.doesNotMatch(shown, /^studio: WORKING/, "the old mission is never displayed as current work");
});

test("explicit resume attaches to a parked review wait without releasing it", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const waiting = makeWaitingJob(loc, dir, "worker-w");
  writeJob(loc, waiting);
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const ctx = ctxFor(dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, ctx);
  const before = rawActive(dir);
  await emit(stranger, "before_agent_start", startEvent("resume the mission"), ctx);
  assert.equal(rawActive(dir), before, "attachment alone never rewrites the waiting mission");
  const events = readEvents(loc, 100);
  assert.ok(events.some((e) => e.type === "review-wait-attached"), "the attachment is recorded");
  assert.ok(!events.some((e) => e.type === "review-wait-recovery"), "attachment is not wait recovery");
  const job = readJob(loc);
  assert.equal(job.kind === "loaded" && job.job.status, "WAITING_REVIEW", "the review wait remains in force");

  const follow = startEvent("what is the current status");
  await emit(stranger, "before_agent_start", follow, ctx);
  assert.match(follow.systemPromptOptions.sections?.["studio_mission"] ?? "", /WAITING_REVIEW/, "the attached session sees the review wait as current work");

  // After attachment the session's own authorised recovery works as before.
  await emit(stranger, "before_agent_start", startEvent("cancel review wait"), ctx);
  const released = readJob(loc);
  assert.equal(released.kind === "loaded" && released.job.status, "WORKING", "the attached session's recovery releases the wait");
});

test("explicit resume never attaches a foreign worker's review wait", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const foreign = startMission({ packet: packetFor("Wait for review on the status file."), location: loc, facts: repoFacts(dir) });
  const waiting = applyReviewWait(foreign, {
    repository: "matthewjameswatkins1978-cyber/matthew-way-studio",
    pull_request: 7,
    url: "https://example.test/pull/7",
    branch: foreign.repo.branch,
    head_sha: foreign.repo.current_sha.toLowerCase(),
    worker_session_id: "foreign-owner",
    requested_review: "general",
  });
  writeJob(loc, { ...waiting, worker_session_id: "foreign-owner" });
  const before = rawActive(dir);
  const stranger = makeHarness();
  registerStudio(stranger.api);
  const ctx = ctxFor(dir, stranger);
  await emit(stranger, "session_start", { type: "session_start", reason: "new" }, ctx);
  await emit(stranger, "before_agent_start", startEvent("resume the mission"), ctx);
  assert.equal(rawActive(dir), before, "the foreign review wait is untouched");
  assert.ok(!readEvents(loc, 100).some((e) => e.type === "review-wait-attached"), "no attach to a foreign mission");
  assert.ok(stranger.notifications.some((n) => n.includes("refusing")), "the refusal is announced");
});
