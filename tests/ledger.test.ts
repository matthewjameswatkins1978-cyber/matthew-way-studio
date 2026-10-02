import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ledgerLocation } from "../src/paths.js";
import {
  ACTIVE_JOB_FILE,
  appendEvent,
  clearJob,
  makeJobId,
  readEvents,
  readJob,
  readPacket,
  savePacket,
  writeJob,
} from "../src/ledger.js";
import { newJob } from "../src/schema.js";

function tempLocation(): ReturnType<typeof ledgerLocation> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-ledger-"));
  return { dir: path.join(dir, "matthew-way-studio"), source: "fallback", repoRoot: dir };
}

function job(id = "job-a"): ReturnType<typeof newJob> {
  return newJob({
    jobId: id,
    contract: { objective: "durable state test", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: "/r", remote: "", branch: "main", base_sha: "c".repeat(40), current_sha: "c".repeat(40), dirty_at_start: false },
    packet: { sha256: "d".repeat(64), bytes: 3, path: "/r/p.md" },
    nextAction: "test",
  });
}

test("write then read round-trips the job across a simulated restart", () => {
  const loc = tempLocation();
  const original = job("job-roundtrip");
  writeJob(loc, original);
  const read = readJob(loc);
  assert.equal(read.kind, "loaded");
  if (read.kind !== "loaded") return;
  assert.deepEqual(read.job, original);
});

test("missing ledger means no mission, not an error", () => {
  const loc = tempLocation();
  assert.deepEqual(readJob(loc), { kind: "none" });
});

test("corrupt ledger is reported and does not throw", () => {
  const loc = tempLocation();
  fs.mkdirSync(loc.dir, { recursive: true });
  fs.writeFileSync(path.join(loc.dir, ACTIVE_JOB_FILE), "{ not json", "utf8");
  const read = readJob(loc);
  assert.equal(read.kind, "corrupt");
  if (read.kind === "corrupt") assert.match(read.reason, /invalid JSON/);
});

test("newer schema version is reported as future-version", () => {
  const loc = tempLocation();
  fs.mkdirSync(loc.dir, { recursive: true });
  fs.writeFileSync(path.join(loc.dir, ACTIVE_JOB_FILE), JSON.stringify({ schema_version: 42, objective: "future", status: "WORKING" }), "utf8");
  const read = readJob(loc);
  assert.equal(read.kind, "future-version");
});

test("atomic write leaves no temporary files behind", () => {
  const loc = tempLocation();
  writeJob(loc, job("job-atomic"));
  writeJob(loc, { ...job("job-atomic"), updated_at: new Date().toISOString() });
  const leftovers = fs.readdirSync(loc.dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("backup option preserves the previous snapshot", () => {
  const loc = tempLocation();
  writeJob(loc, job("job-backup"));
  writeJob(loc, { ...job("job-backup"), status: "NEEDS_HUMAN" }, { backup: true });
  const files = fs.readdirSync(loc.dir);
  assert.equal(files.filter((f) => f.startsWith(`${ACTIVE_JOB_FILE}.bak-`)).length, 1);
});

test("clearJob removes the active mission", () => {
  const loc = tempLocation();
  writeJob(loc, job("job-clear"));
  clearJob(loc);
  assert.equal(readJob(loc).kind, "none");
});

test("event log appends and reads newest entries", () => {
  const loc = tempLocation();
  appendEvent(loc, "mission-start", { job_id: "j" });
  appendEvent(loc, "checkpoint", { job_id: "j", milestone: "m" });
  const events = readEvents(loc);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.type, "checkpoint");
  assert.equal(events[1]?.milestone, "m");
});

test("packet survives independently of the conversation", () => {
  const loc = tempLocation();
  const meta = savePacket(loc, "job-packet", "# OBJECTIVE\nDo the thing\n");
  assert.equal(meta.bytes, Buffer.byteLength("# OBJECTIVE\nDo the thing\n"));
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readPacket(loc, "job-packet")?.includes("Do the thing"), true);
  assert.equal(fs.existsSync(meta.path), true);
});

test("job ids are stable for the same mission seed", () => {
  const a = makeJobId("root:main:sha:objective");
  const b = makeJobId("root:main:sha:objective");
  assert.equal(a, b);
  assert.notEqual(a, makeJobId("root:main:sha:other"));
});
