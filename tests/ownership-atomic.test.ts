/**
 * Ownership atomicity and read-only purity regressions.
 *
 * Covers Lucy's remaining ownership defects:
 *   1. stale recovery snapshots — a mutation after claim acquisition must
 *      never write a stale pre-acquisition job object (which restored the
 *      abandoned claim and broke exclusivity);
 *   2. competing recoveries — two independent processes racing for one
 *      abandoned claim: exactly one wins;
 *   3. read-only purity — session startup, status rendering and agent_end
 *      never claim ownership or change mission state;
 *   4. crash recovery — a dead holder's claim lock is stolen, a live one
 *      times out with a clear diagnostic;
 *   5. terminal missions never restart themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents, writeJob, activeJobPath, mutateJob, makeSessionToken, claimIsAbandoned, inspectClaimLocks } from "../src/ledger.js";
import { startMission } from "../src/mission.js";
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

function tempRepo(): { base: string; dir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-atomic-"));
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", dir], { encoding: "utf8" });
  for (const [k, v] of [
    ["user.email", "studio@test.local"],
    ["user.name", "Studio Test"],
  ] as Array<[string, string]>) {
    execFileSync("git", ["config", k, v], { cwd: dir, encoding: "utf8" });
  }
  fs.writeFileSync(path.join(dir, "README.md"), "# atomic\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  return { base, dir };
}

function packetFor(objective: string): string {
  return [
    "# MATTHEW WAY STUDIO - ATOMIC",
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

function deadPid(): number {
  const dead = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  return dead.pid ?? 999999;
}

function abandonedMission(loc: LedgerLocation): { deadClaim: string; jobId: string } {
  const job = startMission({ packet: packetFor("Finish the abandoned ingest work."), location: loc, facts: repoFacts(loc.repoRoot ?? process.cwd()) });
  const deadClaim = `legacy:${deadPid()}:deadbeef`;
  writeJob(loc, { ...job, worker_session_id: deadClaim });
  return { deadClaim, jobId: job.job_id };
}

// ------------------------------------------------------- stale snapshots ----

test("a mutation after recovery never writes back the abandoned claim", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const { deadClaim } = abandonedMission(loc);

  const h = makeHarness();
  registerStudio(h.api);
  const ctx = ctxFor(dir, h);
  await emit(h, "session_start", { type: "session_start", reason: "resume" }, ctx);
  await h.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "b-suite", status: "pass" }] }, undefined, undefined, ctx);

  const after = readJob(loc);
  assert.equal(after.kind, "loaded");
  if (after.kind !== "loaded") return;
  assert.notEqual(after.job.worker_session_id, deadClaim, "the abandoned claim is not restored by a stale write");
  assert.equal(claimIsAbandoned(after.job.worker_session_id), false, "the claim belongs to a live recoverer now");
  assert.ok(readEvents(loc, 100).some((e) => e.type === "claim-taken"), "recovery is recorded");

  // The acquired claim must survive subsequent mutations too.
  await h.tools.get("studio_checkpoint")!.execute("c2", { checks: [{ name: "b-final", status: "pass" }] }, undefined, undefined, ctx);
  const later = readJob(loc);
  assert.equal(later.kind === "loaded" && later.job.worker_session_id, after.job.worker_session_id, "the claim persists across mutations");
  assert.equal(later.kind === "loaded" && later.job.evidence.checks.length, 2, "both mutations landed on the authoritative state");
});

// --------------------------------------------------- competing recoveries ---

test("two separate processes competing for one abandoned claim: exactly one wins", async () => {
  const { base, dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const { deadClaim } = abandonedMission(loc);

  const racerSrc = `
import { mutateJob } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "ledger.js")).href)};
const [ledgerDir, startAt, token] = process.argv.slice(2);
const until = Number(startAt);
while (Date.now() < until) { /* barrier */ }
const res = mutateJob({ dir: ledgerDir, source: "git-common-dir" }, { sessionToken: token }, (fresh) => ({
  ...fresh,
  progress: { ...fresh.progress, milestone: token },
}));
process.stdout.write(JSON.stringify({ ok: res.ok, reason: res.reason ?? "", token, claim: res.job?.worker_session_id ?? "" }));
`;
  const racer = path.join(base, "racer.mjs");
  fs.writeFileSync(racer, racerSrc, "utf8");

  const startAt = Date.now() + 1200;
  const tokens = ["racer-one", "racer-two", "racer-three", "racer-four"];
  const results = await Promise.all(
    tokens.map(
      (token) =>
        new Promise<{ ok: boolean; reason: string; token: string; claim: string }>((resolve) => {
          const child = spawn(process.execPath, [racer, loc.dir, String(startAt), token], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("exit", () => resolve(JSON.parse(out.trim() || '{"ok":false,"reason":"no output","token":"","claim":""}')));
        }),
    ),
  );

  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, `exactly one process acquires the claim: ${JSON.stringify(results)}`);
  assert.equal(results.filter((r) => /another Pi session/.test(r.reason)).length, results.length - 1, "losers get a clear ownership refusal");
  const after = readJob(loc);
  assert.equal(after.kind, "loaded");
  if (after.kind !== "loaded") return;
  const winner = winners[0];
  assert.ok(winner, "a winner exists");
  assert.equal(after.job.worker_session_id, winner.token, "the record carries exactly the winner's claim");
  assert.equal(after.job.progress.milestone, winner.token, "exactly the winner's mutation landed");
  assert.notEqual(after.job.worker_session_id, deadClaim);
});

// -------------------------------------------------------- read-only purity --

test("read-only paths never claim ownership or change mission state", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  abandonedMission(loc);
  const before = rawActive(dir);

  const h = makeHarness();
  registerStudio(h.api);
  const ctx = ctxFor(dir, h);
  await emit(h, "session_start", { type: "session_start", reason: "resume" }, ctx);
  await emit(h, "agent_end", { type: "agent_end", messages: [] }, ctx);
  const status = await h.tools.get("studio_status")!.execute("s1", {}, undefined, undefined, ctx);
  assert.equal(status.isError ?? false, false, "status stays readable");

  assert.equal(rawActive(dir), before, "session startup, agent_end and status rendering change nothing on disk");
  assert.ok(!readEvents(loc, 100).some((e) => e.type === "claim-taken"), "no claim is taken by a read");
});

// --------------------------------------------------------- crash recovery ---

test("a crashed claim lock is stolen and a live one times out with a clear diagnostic", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);
  const lock = path.join(loc.dir, "claim-lock");

  fs.writeFileSync(lock, `${JSON.stringify({ pid: deadPid(), at: new Date().toISOString() })}\n`, "utf8");
  const stolen = mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => ({
    ...fresh,
    progress: { ...fresh.progress, milestone: "after-crash" },
  }));
  assert.equal(stolen.ok, true, "a dead holder's lock is stolen so crash recovery works");
  assert.equal(stolen.job?.progress.milestone, "after-crash");
  assert.equal(fs.existsSync(lock), false, "the stolen lock is cleaned up");

  fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
  assert.throws(
    () => mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => fresh, { timeoutMs: 250 }),
    /claim lock timeout/,
    "a live holder's lock times out with a clear diagnostic instead of corrupting state",
  );
  fs.rmSync(lock, { force: true });
  assert.equal(readJob(loc).kind, "loaded", "the mission survives both lock situations");
});

// --------------------------------------------------- terminal stays closed --

test("terminal missions never restart themselves", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const h = makeHarness();
  registerStudio(h.api);
  const ctx = ctxFor(dir, h);
  await emit(h, "before_agent_start", startEvent(packetFor("Add the status file to the repository.")), ctx);
  const closed = await h.tools.get("studio_complete")!.execute("d1", { outcome: "PARTIAL", summary: "delivered what was verified" }, undefined, undefined, ctx);
  assert.equal(closed.isError ?? false, false, "the mission closes as PARTIAL");

  const before = rawActive(dir);
  const settle = await emit(h, "agent_before_settle", { type: "agent_before_settle", outcome: "completed", entries: [], continue: false, context: { canContinue: false } }, ctx);
  assert.equal(settle, undefined, "a terminal mission never auto-continues");
  await h.tools.get("studio_checkpoint")!.execute("c1", { checks: [{ name: "late", status: "pass" }] }, undefined, undefined, ctx);
  const after = readJob(loc);
  assert.equal(after.kind === "loaded" && after.job.status, "PARTIAL", "a checkpoint records evidence without reopening a terminal mission");
  assert.equal(after.kind === "loaded" && after.job.continuation.allowed, false, "continuation stays disallowed");
  assert.notEqual(rawActive(dir), before, "the evidence note is recorded (record moves forward, status does not)");
});

test("an old lock belonging to a live process is never stolen", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);
  const lock = path.join(loc.dir, "claim-lock");
  fs.writeFileSync(lock, `${JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 120_000).toISOString() })}\n`, "utf8");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);

  assert.throws(
    () => mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => ({ ...fresh, progress: { ...fresh.progress, milestone: "stolen" } }), { timeoutMs: 250 }),
    /claim lock timeout/,
    "a provably live holder's lock fails safely with a timeout, however old",
  );
  assert.ok(fs.existsSync(lock), "the live holder's lock is never stolen on age alone");
  fs.rmSync(lock, { force: true });
  const after = readJob(loc);
  assert.equal(after.kind === "loaded" && after.job.progress.milestone, "", "the refused mutation changed nothing");
});

test("two distinct sessions competing for an unclaimed record: exactly one becomes its owner", async () => {
  const { base, dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);
  const initial = readJob(loc);
  assert.equal(initial.kind === "loaded" && initial.job.worker_session_id, undefined, "the record starts unclaimed");

  const racerSrc = `
import { mutateJob } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "ledger.js")).href)};
const [ledgerDir, startAt, token] = process.argv.slice(2);
const until = Number(startAt);
while (Date.now() < until) { /* barrier */ }
const res = mutateJob({ dir: ledgerDir, source: "git-common-dir" }, { sessionToken: token }, (fresh) => ({
  ...fresh,
  progress: { ...fresh.progress, milestone: token },
}));
process.stdout.write(JSON.stringify({ ok: res.ok, reason: res.reason ?? "", token, claim: res.job?.worker_session_id ?? "" }));
`;
  const racer = path.join(base, "unclaimed-racer.mjs");
  fs.writeFileSync(racer, racerSrc, "utf8");

  const startAt = Date.now() + 1200;
  const tokens = ["first-session", "second-session", "third-session"];
  const results = await Promise.all(
    tokens.map(
      (token) =>
        new Promise<{ ok: boolean; reason: string; token: string; claim: string }>((resolve) => {
          const child = spawn(process.execPath, [racer, loc.dir, String(startAt), token], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("exit", () => resolve(JSON.parse(out.trim() || '{"ok":false,"reason":"no output","token":"","claim":""}')));
        }),
    ),
  );

  const winners = results.filter((r) => r.ok);
  const winner = winners[0];
  assert.equal(winners.length, 1, `exactly one session may claim an unclaimed record: ${JSON.stringify(results)}`);
  assert.ok(winner, "a winner exists");
  assert.equal(results.filter((r) => /another Pi session/.test(r.reason)).length, results.length - 1, "losers get the ownership refusal");
  const after = readJob(loc);
  assert.equal(after.kind, "loaded");
  if (after.kind !== "loaded") return;
  assert.equal(after.job.worker_session_id, winner.token, "the first mutation established one exclusive owner");
  assert.equal(after.job.progress.milestone, winner.token, "exactly the winner's mutation landed");
  assert.ok(readEvents(loc, 100).some((e) => e.type === "claim-taken"), "the acquisition is recorded");
});

test("a lock whose owner cannot be read is never stolen, even when old", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);
  const lock = path.join(loc.dir, "claim-lock");
  // Created but not yet written: a live process suspended before its pid.
  fs.writeFileSync(lock, "", "utf8");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);

  assert.throws(
    () => mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => ({ ...fresh, progress: { ...fresh.progress, milestone: "stolen" } }), { timeoutMs: 250 }),
    /claim lock timeout[\s\S]*remove the stale lock manually/,
    "an unprovable holder fails closed with a clear recovery diagnostic",
  );
  assert.ok(fs.existsSync(lock), "the lock is never stolen on age alone");
  fs.rmSync(lock, { force: true });
  const after = readJob(loc);
  assert.equal(after.kind === "loaded" && after.job.progress.milestone, "", "the refused mutation changed nothing");
});

test("a lock that cannot even be created yields a useful filesystem error, not an endless retry", async () => {
  const { base } = tempRepo();
  const blocked = path.join(base, "ledger-is-a-file");
  fs.writeFileSync(blocked, "not a directory\n", "utf8");
  const loc: LedgerLocation = { dir: blocked, source: "fallback" };
  const started = Date.now();
  assert.throws(
    () => mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => fresh),
    /claim lock could not be created/,
    "a broken lock path surfaces as a useful filesystem error",
  );
  assert.ok(Date.now() - started < 1_000, "the failure is immediate, never an endless retry");
});

test("two processes recovering one stale lock never delete the winner's lock and never overlap", async () => {
  const { base, dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);

  // Competing recovery: one stale lock whose owner is provably dead.
  const staleUid = `dead-${deadPid()}`;
  fs.writeFileSync(path.join(loc.dir, "claim-lock"), `${JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), uid: staleUid })}\n`, "utf8");

  const logFile = path.join(base, "critical-sections.log");
  const racerSrc = `
import * as fs from "node:fs";
import * as path from "node:path";
import { withClaimLock } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "src", "ledger.js")).href)};
const [ledgerDir, startAt, token, log] = process.argv.slice(2);
const until = Number(startAt);
while (Date.now() < until) { /* barrier */ }
withClaimLock({ dir: ledgerDir, source: "git-common-dir" }, () => {
  const owners = fs.readdirSync(ledgerDir)
    .filter((n) => n.startsWith("claim-lock"))
    .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(ledgerDir, n), "utf8")); } catch { return null; } });
  const intact = owners.some((o) => o && o.pid === process.pid);
  fs.appendFileSync(log, "ENTER " + token + " " + (intact ? "lock-ok" : "LOCK-MISSING") + "\\n");
  const end = Date.now() + 150;
  while (Date.now() < end) { /* hold the section */ }
  fs.appendFileSync(log, "EXIT " + token + "\\n");
}, 8_000);
fs.appendFileSync(log, "DONE " + token + "\\n");
`;
  const racer = path.join(base, "competing-racer.mjs");
  fs.writeFileSync(racer, racerSrc, "utf8");

  const startAt = Date.now() + 1200;
  await Promise.all(
    ["racer-one", "racer-two"].map(
      (token) =>
        new Promise<void>((resolve) => {
          const child = spawn(process.execPath, [racer, loc.dir, String(startAt), token, logFile], { stdio: ["ignore", "inherit", "inherit"] });
          child.on("exit", () => resolve());
        }),
    ),
  );

  const log = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean);
  assert.equal(log.filter((l) => l.startsWith("ENTER")).length, 2, `both processes eventually ran: ${log.join(" | ")}`);
  assert.equal(log.filter((l) => l.startsWith("EXIT")).length, 2, "both processes left the section cleanly");
  let depth = 0;
  for (const line of log) {
    const verb = line.split(" ")[0];
    if (verb === "ENTER") depth += 1;
    if (verb === "EXIT") depth -= 1;
    assert.ok(depth <= 1, `critical sections must never overlap: ${log.join(" | ")}`);
  }
  assert.equal(depth, 0, "every entry is matched by an exit");
  assert.ok(log.filter((l) => l.startsWith("ENTER")).every((l) => l.includes("lock-ok")), `the winner's lock is never deleted mid-section: ${log.join(" | ")}`);
  const leftover = fs.readdirSync(loc.dir).filter((n) => n.startsWith("claim-lock"));
  assert.deepEqual(leftover, [], `locks are cleaned up: ${leftover.join(", ")}`);
});

test("lock inspection fails closed instead of reporting no competing locks", () => {
  const { base } = tempRepo();
  // A directory that cannot be listed is an uninspected directory — never
  // proof that no competing lock exists.
  const missing = path.join(base, "no-such-ledger");
  assert.throws(
    () => inspectClaimLocks(missing, "claim-lock"),
    /claim lock inspection failed[\s\S]*Failing closed/,
    "a missing ledger directory must fail closed, not read as an empty lock set",
  );
  // A ledger path that is a regular file cannot be listed either.
  const file = path.join(base, "ledger-is-a-file");
  fs.writeFileSync(file, "not a directory\n", "utf8");
  assert.throws(
    () => inspectClaimLocks(file, "claim-lock"),
    /claim lock inspection failed[\s\S]*Failing closed/,
    "an unlistable ledger path must fail closed, not read as an empty lock set",
  );
});

test("an unreadable lock owner fails closed as a blocker, never as absence", async () => {
  const { dir } = tempRepo();
  const loc = ledgerLocation(dir);
  const job = startMission({ packet: packetFor("Add the status file to the repository."), location: loc, facts: repoFacts(dir) });
  writeJob(loc, job);
  // A lock name that is a directory: its owner metadata can never be read.
  const unreadable = path.join(loc.dir, "claim-lock.12345678-deadbeef");
  fs.mkdirSync(unreadable);
  const started = Date.now();
  assert.throws(
    () => mutateJob(loc, { sessionToken: makeSessionToken() }, (fresh) => ({ ...fresh, progress: { ...fresh.progress, milestone: "stolen" } }), { timeoutMs: 250 }),
    /claim lock timeout[\s\S]*failing closed/,
    "an uninspectable lock blocks the contender instead of being treated as absent",
  );
  assert.ok(Date.now() - started >= 200, "it waits for the deadline rather than proceeding");
  fs.rmdirSync(unreadable);
  const after = readJob(loc);
  assert.equal(after.kind === "loaded" && after.job.progress.milestone, "", "the refused mutation changed nothing");
});
