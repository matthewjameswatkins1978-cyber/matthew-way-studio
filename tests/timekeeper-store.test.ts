/** Timekeeper store tests: real files, real clock, real gzip — fake host only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { projectShifts, rosterToJson, rosterToText, TK_INTERRUPTION, TK_WAKE, type LedgerEvent } from "../src/timekeeper.js";
import { eventsPath } from "../src/ledger.js";
import {
  appendTimekeeperEvent,
  archiveOldEvents,
  clearPendingQueue,
  queuePendingPublish,
  readAllEvents,
  readPendingQueue,
  readSnapshot,
  writeRosterFiles,
} from "../src/timekeeper-store.js";

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "timekeeper-store-"));
  return { dir, loc: { dir, source: "fallback" as const } };
}

function line(type: string, at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ at, type, job_id: "job-demo", worker_session_id: "sess-demo", ...extra });
}

test("append assigns stable ids and read tolerates a torn last line", () => {
  const { loc } = tempLedger();
  const id1 = appendTimekeeperEvent(loc, TK_WAKE, { job_id: "job-demo", trigger_id: "t1", from: "A1", wake_source: "intercom" }, "2026-11-20T10:00:00.000Z");
  const id2 = appendTimekeeperEvent(loc, TK_WAKE, { job_id: "job-demo", trigger_id: "t1", from: "A1", wake_source: "intercom" }, "2026-11-20T10:00:00.000Z");
  assert.equal(id1, id2);
  assert.match(id1 ?? "", /^[0-9a-f]{16}$/);
  fs.appendFileSync(eventsPath(loc), '{"torn": true,\n', "utf8");
  const events = readAllEvents(loc);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, TK_WAKE);
});

test("interruption events project to unknown, never active", () => {
  const { loc } = tempLedger();
  const file = eventsPath(loc);
  fs.writeFileSync(
    file,
    [
      line("mission-start", "2026-11-20T10:00:00.000Z", { remote: "o/r" }),
      line(TK_INTERRUPTION, "2026-11-20T10:05:00.000Z", { event_id: "x1", outcome: "error", reason: "turn errored" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const proj = projectShifts(readAllEvents(loc), Date.parse("2026-11-20T10:10:00.000Z"), 60 * 60_000);
  assert.equal(proj.shifts[0]?.working_ms, 5 * 60_000);
  assert.equal(proj.shifts[0]?.unknown_ms, 5 * 60_000);
});

test("full roundtrip: accept, park, intercom wake, resume, clock-out", () => {
  const { loc } = tempLedger();
  const file = eventsPath(loc);
  const t = (min: number) => new Date(Date.parse("2026-11-20T10:00:00.000Z") + min * 60_000).toISOString();
  fs.writeFileSync(
    file,
    [
      line("mission-start", t(0), { remote: "o/r" }),
      line("handoff-wait", t(10), { run_id: "run-9", role: "B", expected_from: "A" }),
      line("mission-parked", t(20), { reason: "parked for review" }),
      // Park is a new shift on resume; the wake arrives over Intercom.
      line(TK_WAKE, t(60), { event_id: "w1", trigger_id: "frame-hash", from: "agent-a", wake_source: "intercom" }),
      line("checkpoint", t(65), { milestone: "slice 1 done", next_action: "slice 2" }),
      line("complete", t(90)),
    ].join("\n") + "\n",
    "utf8",
  );
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const proj = projectShifts(readAllEvents(loc), now, 60 * 60_000);
  assert.equal(proj.shifts.length, 2);
  assert.equal(proj.shifts[0]?.open_reason, "accept");
  assert.equal(proj.shifts[0]?.close_reason, "park");
  assert.equal(proj.shifts[0]?.waiting_ms, 10 * 60_000);
  assert.equal(proj.shifts[0]?.working_ms, 10 * 60_000);
  assert.equal(proj.shifts[1]?.open_reason, "wake");
  assert.equal(proj.shifts[1]?.wake_source, "intercom");
  assert.equal(proj.shifts[1]?.close_reason, "complete");
  assert.equal(proj.roster[0]?.availability, "CLOCKED_OUT");
  assert.equal(proj.roster[0]?.available, true);
  // Roster files carry the same projection Lucy would read.
  const json = rosterToJson(proj.roster, now) as { agents: unknown[] };
  const text = rosterToText(proj.roster, now);
  writeRosterFiles(loc.dir, json, text);
  assert.ok(fs.existsSync(path.join(loc.dir, "timekeeper.roster.json")));
  assert.ok((fs.readFileSync(path.join(loc.dir, "timekeeper.roster.md"), "utf8")).includes("CLOCKED_OUT"));
  assert.equal((json.agents[0] as { availability: string }).availability, "CLOCKED_OUT");
});

test("archive moves only old closed shifts; replay is identical; open shifts and orphans stay", () => {
  const { loc } = tempLedger();
  const file = eventsPath(loc);
  const old = "2026-10-01T10:00:00.000Z";
  const oldEnd = "2026-10-01T11:00:00.000Z";
  const recent = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    file,
    [
      line("mission-start", old, { worker_session_id: "sess-old" }),
      line("complete", oldEnd, { worker_session_id: "sess-old" }),
      line("mission-start", recent, { worker_session_id: "sess-new" }),
      JSON.stringify({ at: recent, type: "studio-note", job_id: "job-demo", worker_session_id: "sess-new", detail: "unattributed" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const nowMs = Date.now();
  const before = projectShifts(readAllEvents(loc), nowMs, 60 * 60_000);
  return archiveOldEvents(loc, nowMs).then((result) => {
    assert.equal(result.archived_events, 2);
    assert.equal(result.archived_files.length, 1);
    assert.match(result.archived_files[0] ?? "", /^timekeeper-archive\/events-2026-W\d{2}\.json\.gz$/);
    const gz = path.join(loc.dir, result.archived_files[0] ?? "");
    assert.ok(fs.existsSync(gz));
    assert.ok(fs.existsSync(`${gz}.sha256`));
    const digest = fs.readFileSync(`${gz}.sha256`, "utf8").trim().split(/\s+/)[0];
    assert.equal(digest, createHash("sha256").update(fs.readFileSync(gz)).digest("hex"));
    const archivedLines = gunzipSync(fs.readFileSync(gz)).toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    assert.equal(archivedLines.length, 2);
    // Active file keeps the open shift plus the unattributed event.
    const active = readAllEvents(loc);
    assert.equal(active.length, 2);
    // Replay archived + active reproduces the same roster and totals.
    const replayed = projectShifts(
      [...archivedLines.map((l) => JSON.parse(l) as LedgerEvent), ...active],
      nowMs,
      60 * 60_000,
    );
    assert.equal(replayed.shifts.length, before.shifts.length);
    assert.deepEqual(
      replayed.shifts.map((s) => [s.shift_id, s.working_ms, s.close_reason]),
      before.shifts.map((s) => [s.shift_id, s.working_ms, s.close_reason]),
    );
    assert.deepEqual(
      replayed.roster.map((r) => [r.agent, r.availability]),
      before.roster.map((r) => [r.agent, r.availability]),
    );
    // Snapshot records open shifts and digests, never archives them.
    const snapshot = readSnapshot(loc.dir) as { open_shifts: string[]; archived_events: number } | undefined;
    assert.ok(snapshot);
    assert.equal(snapshot.archived_events, 2);
    assert.deepEqual(snapshot.open_shifts, before.shifts.filter((s) => !s.closed_at).map((s) => s.shift_id));
    // Second run archives nothing new (idempotent, deduped).
    return archiveOldEvents(loc, nowMs).then((again) => {
      assert.equal(again.archived_events, 0);
    });
  });
});

test("offline publish queue is bounded and clearable", () => {
  const { dir } = tempLedger();
  queuePendingPublish(dir, { kind: "roster", ref: "r1" });
  queuePendingPublish(dir, { kind: "roster", ref: "r2" });
  assert.equal(readPendingQueue(dir).length, 2);
  clearPendingQueue(dir);
  assert.deepEqual(readPendingQueue(dir), []);
});
