import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ledgerLocation } from "../src/paths.js";
import {
  ACTIVE_JOB_FILE,
  activeJobPath,
  adoptLegacyJob,
  appendEvent,
  clearJob,
  makeJobId,
  readEvents,
  readJob,
  readLegacySnapshot,
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

test("linked Pi workers get isolated ledgers and cannot read each other's active job", () => {
  const base = tempLocation();
  const worker = (id: string) => ({ ...base, workerId: id, workerKey: createHash("sha256").update(id).digest("hex").slice(0, 24) });
  const a = worker("session-a");
  const b = worker("session-b");
  writeJob(a, { ...job("job-a"), worker_session_id: a.workerId });
  writeJob(b, { ...job("job-b"), worker_session_id: b.workerId });
  const readA = readJob(a);
  const readB = readJob(b);
  assert.equal(readA.kind === "loaded" ? readA.job.job_id : undefined, "job-a");
  assert.equal(readB.kind === "loaded" ? readB.job.job_id : undefined, "job-b");
  assert.notEqual(path.basename(activeJobPath(a)), path.basename(activeJobPath(b)));
});

test("legacy shared job is never auto-claimed; explicit adoption is single-winner", () => {
  const base = tempLocation();
  const worker = (id: string) => ({ ...base, workerId: id, workerKey: createHash("sha256").update(id).digest("hex").slice(0, 24) });
  writeJob(base, job("job-legacy"));
  const a = worker("legacy-owner");
  const b = worker("legacy-contender");
  // An unrelated session starting first must not inherit the mission.
  assert.deepEqual(readJob(b), { kind: "none" }, "first reader does not win");
  assert.deepEqual(readJob(a), { kind: "none" }, "the real owner does not win by reading either");
  assert.equal(readLegacySnapshot(base).kind, "loaded", "the snapshot stays observable without claiming");
  // Guessing the wrong job id is refused.
  assert.equal(adoptLegacyJob(b, "job-wrong").ok, false);
  assert.deepEqual(readJob(b), { kind: "none" });
  // The owner adopts explicitly with the exact id Matthew gave it.
  const adopted = adoptLegacyJob(a, "job-legacy");
  assert.equal(adopted.ok, true);
  if (!adopted.ok) return;
  assert.equal(adopted.job.worker_session_id, "legacy-owner");
  assert.equal(readJob(a).kind, "loaded", "the owner resumes its scoped copy after restart");
  // A second worker naming the same id is refused: single winner.
  assert.equal(adoptLegacyJob(b, "job-legacy").ok, false);
  assert.deepEqual(readJob(b), { kind: "none" });
  assert.equal(fs.existsSync(path.join(base.dir, ACTIVE_JOB_FILE)), true, "the original shared snapshot is preserved");
});
