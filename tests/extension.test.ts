/**
 * Integration smoke test for the autonomous packet runtime.
 *
 * Drives the real extension against a fake Pi harness and a real disposable Git
 * repository. It checks the four behaviours Matthew asked for, with no slash
 * commands and no GUI automation:
 *   1. an ordinary packet creates and continues a mission automatically;
 *   2. a forced safe blocker produces NEEDS_HUMAN;
 *   3. a normal follow-up resumes it;
 *   4. completion produces a concise evidence receipt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents } from "../src/ledger.js";
import { ledgerLocation } from "../src/paths.js";
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

function ctxFor(cwd: string, harness: Harness, extra: Partial<PiToolContext> = {}): PiToolContext {
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
    tools: [{ name: "read" }, { name: "mcp__lantern__lantern_context" }],
    executeTool: async () => ({ isError: false, content: [{ type: "text", text: "Lantern context: ledger lives in the git common dir (decision d-1)." }] }),
    ...extra,
  } as PiToolContext;
}

async function emit(harness: Harness, event: string, payload: any, ctx: PiContext): Promise<any> {
  const handlers = harness.events.get(event) ?? [];
  let last: any;
  for (const handler of handlers) last = await handler(payload, ctx);
  return last;
}

function tempRepo(): { dir: string; remote: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-e2e-"));
  const remote = path.join(base, "remote.git");
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
  execFileSync("git", ["init", "--initial-branch=main", dir], { encoding: "utf8" });
  const configPairs: Array<[string, string]> = [
    ["user.email", "studio@test.local"],
    ["user.name", "Studio Test"],
  ];
  for (const [k, v] of configPairs) {
    execFileSync("git", ["config", k, v], { cwd: dir, encoding: "utf8" });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# smoke\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir });
  return { dir, remote };
}

const PACKET = [
  "# MATTHEW WAY STUDIO - SMOKE",
  "## OBJECTIVE",
  "Add a status file to the repository and push it.",
  "## SCOPE",
  "- one file",
  "## ACCEPTANCE",
  "- status.json exists",
  "- pushed to origin/main",
  "## ATTENTION",
  "- irreversible choices",
  "## IMPLEMENTATION ORDER",
  "1. Write status.json.",
  "2. Commit and push.",
  "",
  "Pad the packet with enough ordinary detail that a real harness treats it as a substantive mission rather than a one-line ask. ".repeat(4),
].join("\n");

function boundaryEvent(entries: unknown[] = []): PiBoundaryEvent {
  return { type: "agent_before_settle", outcome: "completed", entries, continue: false, context: { canContinue: false } };
}

test("ordinary packet -> mission -> continuation, without a single command", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);

  await emit(harness, "session_start", { type: "session_start", reason: "startup" }, ctx);

  const event: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", event, ctx);

  const location = ledgerLocation(dir);
  const read = readJob(location);
  assert.equal(read.kind, "loaded", "the packet became a durable mission");
  if (read.kind !== "loaded") return;
  const job = read.job;
  assert.equal(job.status, "WORKING");
  assert.match(job.objective, /status file/);
  assert.deepEqual(job.acceptance, ["status.json exists", "pushed to origin/main"]);
  assert.equal(job.progress.next_action, "Write status.json.");

  const section = event.systemPromptOptions.sections?.["studio_mission"] ?? "";
  assert.match(section, /STUDIO MISSION/, "the mission contract was injected into the prompt");
  assert.match(section, /OBJECTIVE: Add a status file/, "objective reached the model");
  assert.match(section, /NEXT ACTION: Write status.json/, "next action reached the model");
  assert.equal(harness.notifications.some((n) => n.includes("mission")), true, "Matthew sees one plain notification, no ritual");

  // A small follow-up must not open a second mission.
  const follow: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "rename that variable", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", follow, ctx);
  const afterFollow = readJob(location);
  assert.equal(afterFollow.kind, "loaded");
  if (afterFollow.kind === "loaded") assert.equal(afterFollow.job.job_id, job.job_id, "one mission per project");

  // End of a turn that recorded progress: the runtime asks for the next turn.
  const checkpoint = harness.tools.get("studio_checkpoint");
  assert.ok(checkpoint, "studio_checkpoint is registered");
  await checkpoint!.execute("t1", { milestone: "M1", next_action: "Commit and push.", checks: [{ name: "node -e read", status: "pass" }], head_sha: job.repo.current_sha }, undefined, undefined, ctx);

  const decision = (await emit(harness, "agent_before_settle", boundaryEvent(), ctx)) as PiBoundaryResult;
  assert.equal(decision?.continue, true, "automatic continuation requested");
  const entries = decision?.entries ?? [];
  assert.equal(entries.length, 1);
  const draft = entries[0] as { type: string; customType: string; content: string; display: boolean };
  assert.equal(draft.type, "custom_message");
  assert.equal(draft.customType, "studio-continuation");
  assert.match(draft.content, /NEXT ACTION: Commit and push/);

  const reloaded = readJob(location);
  assert.equal(reloaded.kind, "loaded");
  if (reloaded.kind === "loaded") assert.equal(reloaded.job.continuation.runs, 1, "continuation was counted");
});

test("a blocked run stops continuation and asks for exactly one thing", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  await emit(harness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, ctx);

  const block = harness.tools.get("studio_blocked");
  assert.ok(block);
  const result = await block!.execute(
    "t2",
    { kind: "authentication", reason: "this machine has no GitHub token for the smoke remote", exact_human_need: "run gh auth login for the test account", resume_condition: "gh auth status reports a token", next_action: "push and verify the remote SHA" },
    undefined,
    undefined,
    ctx,
  );
  const text = result.content[0]?.text ?? "";
  assert.match(text, /^NEEDS_HUMAN/);
  assert.match(text, /WHAT I NEED\nrun gh auth login/);
  assert.match(text, /WHEN YOU HAVE DONE IT\nReply normally. No special command required./);
  assert.match(text, /STATE\n.+ \/ main \/ [0-9a-f]{40}/);
  assert.match(text, /NEXT ACTION\npush and verify the remote SHA/);

  // Blocked missions never continue.
  const decision = (await emit(harness, "agent_before_settle", boundaryEvent(), ctx)) as PiBoundaryResult | undefined;
  assert.equal(decision, undefined, "NEEDS_HUMAN stops automatic continuation");

  const location = ledgerLocation(dir);
  const read = readJob(location);
  assert.equal(read.kind === "loaded" && read.job.status, "NEEDS_HUMAN");
});

test("a normal reply resumes the blocked mission and completion yields a receipt", async () => {
  const { dir, remote } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  const location = ledgerLocation(dir);

  await emit(harness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, ctx);

  // Evidence gate fires before any work: narrating completion is refused.
  const refused = await harness.tools.get("studio_complete")!.execute("t1", { outcome: "COMPLETE", summary: "already done" }, undefined, undefined, ctx);
  assert.equal(refused.isError, true, "COMPLETE is refused without machine evidence");
  assert.match(refused.content[0]?.text ?? "", /no machine evidence recorded/);

  await harness.tools.get("studio_blocked")!.execute("t2", { kind: "credential", reason: "no token", exact_human_need: "add a token", resume_condition: "token present" }, undefined, undefined, ctx);

  // Matthew replies normally. The runtime re-checks instead of assuming.
  const resumeEvent: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "added the token", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", resumeEvent, ctx);
  assert.match(resumeEvent.systemPromptOptions.sections?.["studio_mission"] ?? "", /Recheck the exact blocker/);
  assert.equal(readJob(location).kind === "loaded" && (readJob(location) as any).job.status, "NEEDS_HUMAN", "a reply does not magically resolve the blocker");

  // Pi rechecks with its own tools and records the resolution.
  fs.writeFileSync(path.join(dir, "status.json"), `{"ok":true}\n`, "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "feat: add status file"], { cwd: dir });
  execFileSync("git", ["push", "origin", "main"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

  const resumed = await harness.tools.get("studio_checkpoint")!.execute("t3", { next_action: "verify push", checks: [{ name: "gh auth status", status: "pass" }] }, undefined, undefined, ctx);
  assert.match(resumed.content[0]?.text ?? "", /CHECKPOINT OK · WORKING/);
  const afterResume = readJob(location);
  assert.equal(afterResume.kind === "loaded" && afterResume.job.status, "WORKING");
  if (afterResume.kind !== "loaded") return;
  assert.equal(afterResume.job.blocker, undefined);

  // studio_ship verifies the real remote SHA.
  const ship = await harness.tools.get("studio_ship")!.execute("t4", { dry_run: true }, undefined, undefined, ctx);
  assert.match(ship.content[0]?.text ?? "", /DRY RUN · repo/);
  const push = await harness.tools.get("studio_ship")!.execute("t5", { branch: "main" }, undefined, undefined, ctx);
  assert.match(push.content[0]?.text ?? "", /PUSH: verified/);
  assert.match(push.content[0]?.text ?? "", new RegExp(head.slice(0, 12)));

  await harness.tools.get("studio_checkpoint")!.execute("t6", { checks: [{ name: "git ls-remote origin main", status: "pass", detail: "matches HEAD" }] }, undefined, undefined, ctx);
  const done = await harness.tools.get("studio_complete")!.execute("t7", { outcome: "COMPLETE", summary: "status file shipped and pushed", head_sha: head, branch: "main", pushed_sha: head, dogfood: ["Open the repo and confirm status.json"] }, undefined, undefined, ctx);
  const receipt = done.content[0]?.text ?? "";
  for (const label of ["RESULT: COMPLETE", "OBJECTIVE", "REPO", "BRANCH", "SHA", "PUSH", "MACHINE EVIDENCE", "IMPORTANT DECISIONS", "LANTERN", "HUMAN DOGFOOD", "UNRESOLVED", "HUMAN ATTENTION"]) {
    assert.match(receipt, new RegExp(`^${label}`, "m"), `receipt carries ${label}`);
  }
  assert.match(receipt, new RegExp(head));
  assert.match(receipt, /HUMAN DOGFOOD\n1\. Open the repo/);
  assert.match(receipt, /LANTERN\nnot needed for this mission/);
  assert.ok(receipt.length < 3000, `receipt stays concise (${receipt.length} chars)`);

  const final = readJob(location);
  assert.equal(final.kind === "loaded" && final.job.status, "COMPLETE");
  if (final.kind === "loaded") {
    assert.match(final.job.result?.receipt ?? "", /^RESULT: COMPLETE\n/, "the stored receipt describes the closed mission");
    assert.match(final.job.result?.receipt ?? "", /IMPORTANT DECISIONS\nnone recorded/, "scope is not presented as a decision");
  }
  const settle = (await emit(harness, "agent_before_settle", boundaryEvent(), ctx)) as PiBoundaryResult | undefined;
  assert.equal(settle, undefined, "a completed mission does not continue");
  assert.equal(readEvents(location).some((e) => e.type === "complete"), true);
  void remote;
});

test("stop-loss converts a stalled loop into a resumable human need", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  const location = ledgerLocation(dir);
  await emit(harness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, ctx);

  // Three settled turns that change nothing measurable.
  let last: PiBoundaryResult | undefined;
  for (let i = 0; i < 4; i++) last = (await emit(harness, "agent_before_settle", boundaryEvent(), ctx)) as PiBoundaryResult | undefined;

  assert.ok(last, "the boundary kept acting while turns were unproductive");
  assert.equal((last?.entries as any[])?.[0]?.customType, "studio-stop-loss", "the stall became an explicit instruction to block");
  const read = readJob(location);
  assert.equal(read.kind === "loaded" && read.job.status, "NEEDS_HUMAN");
  if (read.kind !== "loaded") return;
  assert.equal(read.job.blocker?.kind, "stalled");
  assert.equal(harness.notifications.some((n) => n.includes("stop-loss")), true);

  // Ordinary language pauses and renews the loop.
  const pauseEvent: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "stop the mission", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", pauseEvent, ctx);
  assert.equal(readJob(location).kind === "loaded" && (readJob(location) as any).job.continuation.allowed, false);
  const renewEvent: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "resume the mission", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", renewEvent, ctx);
  const renewed = readJob(location);
  assert.equal(renewed.kind === "loaded" && renewed.job.status, "WORKING");
  if (renewed.kind === "loaded") {
    assert.equal(renewed.job.continuation.allowed, true);
    assert.equal(renewed.job.continuation.runs, 0, "a renewal renews the allowance");
  }

  // A fresh human turn is steering, not spinning: quiet streaks must not stall it.
  await emit(harness, "agent_before_settle", boundaryEvent(), ctx);
  const steered: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "what does receipt.ts do", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", steered, ctx);
  const afterQuestion = readJob(location);
  assert.equal(afterQuestion.kind === "loaded" && afterQuestion.job.continuation.unchanged_streak, 0, "a question does not consume the stop-loss");
  assert.match(steered.systemPromptOptions.sections?.["studio_mission"] ?? "", /STUDIO OPERATING RULES/);
});

test("an untrusted project stays idle and a corrupt ledger degrades visibly", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const untrusted = ctxFor(dir, harness, { isProjectTrusted: () => false } as Partial<PiToolContext>);
  const event: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", event, untrusted);
  assert.equal(readJob(ledgerLocation(dir)).kind, "none", "nothing is written before trust");
  assert.match(event.systemPromptOptions.sections?.["studio_mission"] ?? "", /not trusted/);

  const location = ledgerLocation(dir);
  fs.mkdirSync(location.dir, { recursive: true });
  fs.writeFileSync(path.join(location.dir, "active-job.json"), "{ broken", "utf8");
  const trusted = ctxFor(dir, harness);
  const second: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", second, trusted);
  assert.equal(harness.notifications.some((n) => /corrupt/.test(n)), true, "a broken ledger is reported, not hidden");
  assert.match(second.systemPromptOptions.sections?.["studio_mission"] ?? "", /OBJECTIVE: Add a status file/, "work continues on a fresh mission");
});

test("a finished mission does not block the next packet", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness);
  const location = ledgerLocation(dir);

  await emit(harness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, ctx);
  fs.writeFileSync(path.join(dir, "status.json"), `{"ok":true}\n`, "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "feat: status file"], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  await harness.tools.get("studio_checkpoint")!.execute("n1", { checks: [{ name: "npm test", status: "pass" }] }, undefined, undefined, ctx);
  await harness.tools.get("studio_ship")!.execute("n2", { branch: "main" }, undefined, undefined, ctx);
  await harness.tools.get("studio_complete")!.execute("n3", { outcome: "COMPLETE", summary: "first packet delivered", head_sha: head, branch: "main", pushed_sha: head }, undefined, undefined, ctx);
  assert.equal((readJob(location) as any).job.status, "COMPLETE");

  // A small follow-up keeps the closed mission closed.
  const question: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: "thanks, quick question", systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", question, ctx);
  assert.equal((readJob(location) as any).job.status, "COMPLETE");

  // A new substantive packet archives the old mission and seeds a new one.
  const nextPacket = PACKET.replace("status file", "cache layer");
  const seed: PiBeforeAgentStartEvent = { type: "before_agent_start", prompt: nextPacket, systemPrompt: "", systemPromptOptions: {} };
  await emit(harness, "before_agent_start", seed, ctx);
  const reopened = readJob(location);
  assert.equal(reopened.kind, "loaded");
  if (reopened.kind !== "loaded") return;
  assert.equal(reopened.job.status, "WORKING", "the new packet became a new mission");
  assert.notEqual(reopened.job.job_id, (readEvents(location).find((e) => e.type === "mission-archived") as any)?.job_id ?? reopened.job.job_id, "a different job id was archived");
  assert.match(seed.systemPromptOptions.sections?.["studio_mission"] ?? "", /cache layer/);
  assert.equal(readEvents(location).some((e) => e.type === "mission-archived"), true, "the closed mission stays in the audit trail");
});

test("studio_context prefers live Lantern and degrades honestly", async () => {
  const { dir } = tempRepo();
  const harness = makeHarness();
  registerStudio(harness.api);
  const location = ledgerLocation(dir);
  const ctx = ctxFor(dir, harness);
  await emit(harness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, ctx);

  const live = ctxFor(dir, harness, {
    executeTool: async () => ({ isError: false, content: [{ type: "text", text: "DECISION d-7: the ledger lives in the git common dir" }] }),
  });
  const tool = harness.tools.get("studio_context");
  assert.ok(tool, "studio_context is registered");
  const used = await tool!.execute("c1", { query: "where should the ledger live" }, undefined, undefined, live);
  assert.match(used.content[0]?.text ?? "", /LANTERN MCP/);
  assert.match(used.content[0]?.text ?? "", /git common dir/);
  assert.equal((readJob(location) as any).job.memory.lantern, "used");

  // No Lantern tool and no reachable mirror => says unavailable, invents nothing.
  const coldDir = tempRepo().dir;
  const coldLocation = ledgerLocation(coldDir);
  fs.mkdirSync(coldLocation.dir, { recursive: true });
  fs.writeFileSync(path.join(coldLocation.dir, "config.json"), JSON.stringify({ lanternMirror: { mirrorPath: path.join(coldDir, "no-such-mirror") } }), "utf8");
  const coldHarness = makeHarness();
  registerStudio(coldHarness.api);
  const coldCtx = ctxFor(coldDir, coldHarness, { tools: [{ name: "read" }] });
  await emit(coldHarness, "before_agent_start", { type: "before_agent_start", prompt: PACKET, systemPrompt: "", systemPromptOptions: {} } as PiBeforeAgentStartEvent, coldCtx);
  const coldTool = coldHarness.tools.get("studio_context")!;
  const degraded = await coldTool.execute("c2", { query: "where should the ledger live" }, undefined, undefined, coldCtx);
  assert.match(degraded.content[0]?.text ?? "", /LANTERN: unavailable/);
  assert.match(degraded.content[0]?.text ?? "", /Continue from repository, Git and AGENTS\.md facts/);
  assert.equal((readJob(coldLocation) as any).job.memory.lantern, "unavailable");

  // A reachable, fresh mirror is reported as the degraded snapshot it is.
  const snapshotTool = harness.tools.get("studio_context")!;
  const snapshot = await snapshotTool.execute("c3", { query: "lantern runtime verification" }, undefined, undefined, ctxFor(dir, harness, { tools: [{ name: "read" }] }));
  const snapshotText = snapshot.content[0]?.text ?? "";
  assert.match(snapshotText, /LANTERN (SNAPSHOT|: unavailable)/);
  if (/LANTERN SNAPSHOT/.test(snapshotText)) {
    assert.match(snapshotText, /degraded read-only snapshot/);
    assert.equal((readJob(location) as any).job.memory.lantern, "used");
  }
});
