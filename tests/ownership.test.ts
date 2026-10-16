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
import { execFileSync } from "node:child_process";
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
