/**
 * Live reproduction: cross-agent mission identity contamination between two Pi
 * sessions in separate linked worktrees of the same repository.
 *
 * The common Git ledger (git common directory) is intentional: linked worktrees
 * share one mission ledger. Cross-session ownership contamination is not.
 *
 *   Agent ONE (Core): worktree wt-core, branch feature/pi-first-core
 *   Agent TWO (GUI):  worktree wt-gui,  branch feature/gui-work
 *
 * The reproduced symptom: Agent TWO's mission record kept its GUI objective and
 * worktree path but showed feature/pi-first-core and Core's HEAD — repository
 * facts and completion state overwritten by the other session.
 *
 * These tests run both variants:
 *   - distinct stable session identities (ctx.sessionManager.getSessionId);
 *   - missing stable session identity (legacy shared slot).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents, writeJob, activeJobPath, readJobSnapshot } from "../src/ledger.js";
import { startMission } from "../src/mission.js";
import { ledgerLocation } from "../src/paths.js";
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

function packetFor(objective: string): string {
  return [
    "# MATTHEW WAY STUDIO - TWO WORKTREES",
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

/** One repository with two linked worktrees and one shared Git-common ledger. */
function twoWorktrees(): { base: string; dir: string; wtCore: string; wtGui: string; coreSha: string; guiSha: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-two-wt-"));
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
  fs.writeFileSync(path.join(dir, "README.md"), "# two worktrees\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir });

  const wtCore = path.join(base, "wt-core");
  const wtGui = path.join(base, "wt-gui");
  execFileSync("git", ["worktree", "add", "-b", "feature/pi-first-core", wtCore], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["worktree", "add", "-b", "feature/gui-work", wtGui], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(wtCore, "core.txt"), "core\n", "utf8");
  execFileSync("git", ["add", "core.txt"], { cwd: wtCore });
  execFileSync("git", ["commit", "-m", "core work"], { cwd: wtCore });
  fs.writeFileSync(path.join(wtGui, "gui.txt"), "gui\n", "utf8");
  execFileSync("git", ["add", "gui.txt"], { cwd: wtGui });
  execFileSync("git", ["commit", "-m", "gui work"], { cwd: wtGui });
  const coreSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtCore, encoding: "utf8" }).trim();
  const guiSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wtGui, encoding: "utf8" }).trim();
  return { base, dir, wtCore, wtGui, coreSha, guiSha };
}

const CORE_PACKET = packetFor("Ship the first core slice for the platform.");
const GUI_PACKET = packetFor("Ship the GUI surface for the platform.");

// --------------------------------------------------- distinct identities ----

test("distinct stable identities: two worktrees run fully independent missions", async () => {
  const { wtCore, wtGui, coreSha, guiSha } = twoWorktrees();
  const locCore = ledgerLocation(wtCore, "worker-one");
  const locGui = ledgerLocation(wtGui, "worker-two");
  assert.equal(locCore.dir, locGui.dir, "the shared Git-common ledger is intentional");
  assert.notEqual(activeJobPath(locCore), activeJobPath(locGui), "each stable session identity reads and writes its own active-job file");

  const one = makeHarness();
  registerStudio(one.api);
  const oneCtx = ctxFor(wtCore, one, "worker-one");
  await emit(one, "before_agent_start", startEvent(CORE_PACKET), oneCtx);
  await one.tools.get("studio_checkpoint")!.execute("c1", { head_sha: coreSha, branch: "feature/pi-first-core", checks: [{ name: "core-suite", status: "pass", accepts: [1] }] }, undefined, undefined, oneCtx);

  const two = makeHarness();
  registerStudio(two.api);
  const twoCtx = ctxFor(wtGui, two, "worker-two");
  await emit(two, "before_agent_start", startEvent(GUI_PACKET), twoCtx);
  await two.tools.get("studio_checkpoint")!.execute("c2", { head_sha: guiSha, branch: "feature/gui-work", checks: [{ name: "gui-suite", status: "pass", accepts: [1] }] }, undefined, undefined, twoCtx);

  // Status refresh shows each session only its own mission and its own facts.
  const statusTwo = await two.tools.get("studio_status")!.execute("s2", {}, undefined, undefined, twoCtx);
  const textTwo = statusTwo.content[0]?.text ?? "";
  assert.match(textTwo, /GUI surface/, "Agent TWO sees its GUI objective");
  assert.match(textTwo, new RegExp(guiSha.slice(0, 10)), "Agent TWO sees its own revision");
  assert.doesNotMatch(textTwo, /pi-first-core|Ship the first core/, "Agent TWO never sees the Core mission's identity");

  const oneBefore = rawActive(wtCore, "worker-one");
  const twoBefore = rawActive(wtGui, "worker-two");

  // Independent PARTIAL completions: neither overwrites the other's record.
  const doneTwo = await two.tools.get("studio_complete")!.execute("d2", { outcome: "PARTIAL", summary: "GUI surface delivered at 5de6377" }, undefined, undefined, twoCtx);
  assert.equal(doneTwo.isError ?? false, false, `Agent TWO completes independently: ${doneTwo.content[0]?.text ?? ""}`);
  assert.equal(rawActive(wtCore, "worker-one"), oneBefore, "Agent ONE's record is byte-identical across Agent TWO's completion");

  const doneOne = await one.tools.get("studio_complete")!.execute("d1", { outcome: "PARTIAL", summary: "core slice delivered at 6bc2830" }, undefined, undefined, oneCtx);
  assert.equal(doneOne.isError ?? false, false, `Agent ONE completes independently: ${doneOne.content[0]?.text ?? ""}`);
  const finalTwo = rawActive(wtGui, "worker-two");
  assert.match(finalTwo, new RegExp(guiSha.slice(0, 10)), "Agent TWO's record still carries its own revision");
  assert.doesNotMatch(finalTwo, new RegExp(coreSha.slice(0, 10) + "|feature/pi-first-core"), "Agent TWO's record never absorbed Agent ONE's branch or revision");

  // Restart: the same stable identity finds its own mission, not the other one.
  const oneAgain = makeHarness();
  registerStudio(oneAgain.api);
  const oneAgainCtx = ctxFor(wtCore, oneAgain, "worker-one");
  const restarted = await oneAgain.tools.get("studio_status")!.execute("s3", {}, undefined, undefined, oneAgainCtx);
  const restartedText = restarted.content[0]?.text ?? "";
  assert.match(restartedText, /core slice/, "after restart Agent ONE reads its own mission");
  assert.doesNotMatch(restartedText, /GUI surface/, "after restart Agent ONE still sees no foreign mission");
});

// ---------------------------------------------------- missing identities ----

test("missing identity: one session can never overwrite the other's writable mission", async () => {
  const { wtCore, wtGui, coreSha, guiSha } = twoWorktrees();

  // Agent ONE works Core from its worktree (legacy shared slot).
  const one = makeHarness();
  registerStudio(one.api);
  const oneCtx = ctxFor(wtCore, one);
  await emit(one, "before_agent_start", startEvent(CORE_PACKET), oneCtx);
  await one.tools.get("studio_checkpoint")!.execute("c1", { head_sha: coreSha, branch: "feature/pi-first-core", checks: [{ name: "core-suite", status: "pass", accepts: [1] }] }, undefined, undefined, oneCtx);
  const coreRecordBefore = rawActive(wtCore);
  assert.match(coreRecordBefore, new RegExp(coreSha.slice(0, 10)), "the active record is Agent ONE's Core mission");

  // Agent TWO tries to start its GUI mission while ONE's mission is live.
  const two = makeHarness();
  registerStudio(two.api);
  const twoCtx = ctxFor(wtGui, two);
  await emit(two, "session_start", { type: "session_start", reason: "new" }, twoCtx);
  const seedAttempt = startEvent(GUI_PACKET);
  await emit(two, "before_agent_start", seedAttempt, twoCtx);
  assert.equal(rawActive(wtGui), coreRecordBefore, "the live mission's record is byte-identical: it was not parked or replaced");
  assert.ok(!readEvents(ledgerLocation(wtGui), 200).some((e) => e.type === "mission-parked"), "no park of another session's live mission");
  assert.match(seedAttempt.systemPromptOptions.sections?.["studio_mission"] ?? "", /another Pi session/, "the refusal names the reason");

  // The reproduction's exact corruption attempt: Agent TWO (and a restarted
  // Agent ONE-style session) must not write repository facts or completion.
  const foreignCheckpoint = await two.tools.get("studio_checkpoint")!.execute("c2", { head_sha: guiSha, branch: "feature/gui-work", checks: [{ name: "gui-suite", status: "pass" }] }, undefined, undefined, twoCtx);
  assert.equal(foreignCheckpoint.isError ?? false, true, "a foreign checkpoint is refused");
  const foreignComplete = await two.tools.get("studio_complete")!.execute("d2", { outcome: "PARTIAL", summary: "GUI surface delivered" }, undefined, undefined, twoCtx);
  assert.equal(foreignComplete.isError ?? false, true, "a foreign completion is refused");
  assert.equal(rawActive(wtGui), coreRecordBefore, "repository facts and completion state are never overwritten");
  assert.match(coreRecordBefore, new RegExp(coreSha.slice(0, 10)));
  assert.doesNotMatch(coreRecordBefore, new RegExp(guiSha.slice(0, 10) + "|feature/gui-work"), "no GUI facts leaked into the Core record");

  // Status refresh tells the truth instead of showing the mission as current.
  const foreignStatus = await two.tools.get("studio_status")!.execute("s2", {}, undefined, undefined, twoCtx);
  assert.match(foreignStatus.content[0]?.text ?? "", /NOT this session's mission|not attached/, "status does not present a foreign mission as current work");

  // Restart without stable identity must not silently inherit the live mission.
  const twoAgain = makeHarness();
  registerStudio(twoAgain.api);
  const twoAgainCtx = ctxFor(wtGui, twoAgain);
  await emit(twoAgain, "session_start", { type: "session_start", reason: "resume" }, twoAgainCtx);
  const inherited = await twoAgain.tools.get("studio_checkpoint")!.execute("c3", { checks: [{ name: "sneaky", status: "pass" }] }, undefined, undefined, twoAgainCtx);
  assert.equal(inherited.isError ?? false, true, "a restart does not silently inherit somebody else's writable mission");
  assert.equal(rawActive(wtGui), coreRecordBefore, "the owner's record survives the other session's restart");

  // Agent ONE keeps working independently and closes normally.
  const ownerCheckpoint = await one.tools.get("studio_checkpoint")!.execute("c4", { checks: [{ name: "core-final", status: "pass", accepts: [1] }] }, undefined, undefined, oneCtx);
  assert.equal(ownerCheckpoint.isError ?? false, false, "the owning session keeps working");
  const doneOne = await one.tools.get("studio_complete")!.execute("d1", { outcome: "PARTIAL", summary: "core slice delivered at 6bc2830" }, undefined, undefined, oneCtx);
  assert.equal(doneOne.isError ?? false, false, "the owning session completes normally");
});

test("missing identity: a dead claim is inheritable and history stays recoverable", async () => {
  const { wtCore, coreSha } = twoWorktrees();
  const loc = ledgerLocation(wtCore);

  // A mission claimed by a session whose process is gone.
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  const deadClaim = `legacy:${dead.pid ?? 999999}:deadbeef`;
  const facts = repoFacts(wtCore);
  const orphan = startMission({ packet: packetFor("Finish the abandoned ingest work."), location: loc, facts: { ...facts, head_sha: coreSha } });
  const claimed = { ...orphan, worker_session_id: deadClaim };
  writeJob(loc, claimed);

  const fresh = makeHarness();
  registerStudio(fresh.api);
  const ctx = ctxFor(wtCore, fresh);
  await emit(fresh, "session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.ok(fresh.notifications.some((n) => n.includes("resuming mission")), "a dead claim is safely inheritable: the mission survives restart");
  const checkpoint = await fresh.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "suite", status: "pass" }] }, undefined, undefined, ctx);
  assert.equal(checkpoint.isError ?? false, false, "inherited missions are writable again");

  // Historical mission records and receipts stay recoverable verbatim.
  const second = tempRepoLegacy();
  const loc2 = ledgerLocation(second);
  const done = startMission({ packet: packetFor("Deliver the old receipt work."), location: loc2, facts: repoFacts(second) });
  const closed = {
    ...done,
    status: "PARTIAL" as const,
    result: { outcome: "PARTIAL" as const, summary: "delivered earlier", receipt: "RECEIPT-MARKER-6bc2830" },
  };
  writeJob(loc2, closed);
  const owner2 = makeHarness();
  registerStudio(owner2.api);
  const ctx2 = ctxFor(second, owner2);
  await emit(owner2, "before_agent_start", startEvent(packetFor("Build the cache layer for the ingest pipeline.")), ctx2);
  const parked = readJobSnapshot(loc2, done.job_id);
  assert.equal(parked.kind, "loaded");
  if (parked.kind !== "loaded") return;
  assert.match(parked.job.result?.receipt ?? "", /RECEIPT-MARKER-6bc2830/, "parked history preserves receipts verbatim");
  assert.equal(parked.job.status, "PARTIAL");
});

function tempRepoLegacy(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-legacy-hist-"));
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", dir], { encoding: "utf8" });
  for (const [k, v] of [
    ["user.email", "studio@test.local"],
    ["user.name", "Studio Test"],
  ] as Array<[string, string]>) {
    execFileSync("git", ["config", k, v], { cwd: dir, encoding: "utf8" });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# legacy\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  return dir;
}
