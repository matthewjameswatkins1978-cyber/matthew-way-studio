/** Workshop run-record persistence tests in disposable directories. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  markDelivered,
  maxDeliveredId,
  normalizeRunRecord,
  readDeliveredIds,
  readHeartbeat,
  readRunRecord,
  rosterWithHeartbeats,
  writeHeartbeat,
  writeRunRecord,
} from "../src/workshop.js";
import type { RunRecord } from "../src/sleepwake.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sleepwake-workshop-"));
}

function location(dir: string) {
  return { dir, source: "fallback" as const };
}

function record(): RunRecord {
  return {
    run_id: "job-1",
    repository: "o/r",
    issue: 16,
    workers: [
      { role: "A1", worker_session_id: "s1", status: "working", last_seen: "t" },
      { role: "A2", worker_session_id: "s2", status: "waiting", last_seen: "t" },
    ],
    created_at: "t",
    updated_at: "t",
  };
}

test("run record round-trips and rejects blobs without identity", () => {
  const dir = tempDir();
  writeRunRecord(location(dir), record());
  const loaded = readRunRecord(location(dir), "job-1");
  assert.ok(loaded);
  assert.equal(loaded.workers.length, 2);
  assert.equal(readRunRecord(location(dir), "missing"), undefined);
  assert.throws(() => normalizeRunRecord({ workers: [] }), /run_id/);
  assert.deepEqual(normalizeRunRecord({ run_id: "x", workers: [{ role: "A1" }] }).workers, []);
});

test("heartbeats are per-worker atomic files merged over membership", () => {
  const dir = tempDir();
  const loc = location(dir);
  writeRunRecord(loc, record());
  writeHeartbeat(loc, "job-1", { role: "A2", worker_session_id: "s2", branch: "b", status: "waiting", last_seen: "t", cursor: "9" });
  const heartbeat = readHeartbeat(loc, "job-1", "A2");
  assert.ok(heartbeat);
  assert.equal(heartbeat.branch, "b");
  assert.equal(readHeartbeat(loc, "job-1", "A9"), undefined);
  const merged = rosterWithHeartbeats(record(), [
    { role: "A2", worker_session_id: "s2", status: "waiting", last_seen: "t", cursor: "9" },
    { role: "ZZ", worker_session_id: "sz", status: "working", last_seen: "t" },
  ]);
  assert.equal(merged.workers.find((w) => w.role === "A2")?.cursor, "9");
  assert.deepEqual(merged.unknown, ["ZZ"]);
});

test("delivered ids deduplicate, bound and survive restarts", () => {
  const dir = tempDir();
  const loc = location(dir);
  assert.deepEqual(readDeliveredIds(loc, "job-1"), []);
  markDelivered(loc, "job-1", "5");
  markDelivered(loc, "job-1", "9");
  markDelivered(loc, "job-1", "5");
  assert.deepEqual(readDeliveredIds(loc, "job-1"), ["9", "5"]);
  assert.equal(maxDeliveredId(loc, "job-1"), "9");
  for (let i = 0; i < 250; i++) markDelivered(loc, "job-1", String(100 + i));
  assert.ok(readDeliveredIds(loc, "job-1").length <= 200);
});
