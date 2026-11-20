/** Timekeeper projector tests: shifts, states, wake, duplicates, skew, UK time. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatUK,
  londonDayKey,
  londonDayStartMs,
  parseIntercomFrame,
  parseWorkshopWake,
  projectShifts,
  rosterToJson,
  rosterToText,
  splitByLondonDay,
  summarizeDay,
  timekeeperEventId,
  type LedgerEvent,
} from "../src/timekeeper.js";

function ev(type: string, at: string, extra: Record<string, unknown> = {}): LedgerEvent {
  return { at, type, job_id: "job-1", worker_session_id: "sess-A", ...extra };
}

const MIN = 60_000;

test("accept, work and clock-out: one shift, billed working time only", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const events = [
    ev("mission-start", "2026-11-20T10:00:00.000Z", { remote: "o/r" }),
    ev("checkpoint", "2026-11-20T10:30:00.000Z", { milestone: "slice 1", next_action: "slice 2" }),
    ev("complete", "2026-11-20T11:00:00.000Z"),
  ];
  const { shifts, roster, suppressed } = projectShifts(events, t0 + 60 * MIN);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0]?.open_reason, "accept");
  assert.equal(shifts[0]?.close_reason, "complete");
  assert.equal(shifts[0]?.close_known, true);
  assert.equal(shifts[0]?.working_ms, 60 * MIN);
  assert.equal(shifts[0]?.waiting_ms, 0);
  assert.equal(shifts[0]?.accounting.source, "unknown");
  assert.equal(suppressed, 0);
  assert.equal(roster.length, 1);
  assert.equal(roster[0]?.availability, "CLOCKED_OUT");
  assert.equal(roster[0]?.available, true);
  assert.equal((roster[0] as { milestone?: string }).milestone, "slice 1");
});

test("waiting retains ownership: WAITING, never available; park closes; resume opens a new shift", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const events = [
    ev("mission-start", "2026-11-20T10:00:00.000Z"),
    ev("handoff-wait", "2026-11-20T10:10:00.000Z", { run_id: "run-1", role: "A2", expected_from: "A1" }),
    ev("mission-parked", "2026-11-20T10:20:00.000Z", { reason: "parked" }),
  ];
  let proj = projectShifts(events, t0 + 25 * MIN);
  assert.equal(proj.shifts.length, 1);
  assert.equal(proj.shifts[0]?.close_reason, "park");
  assert.equal(proj.roster[0]?.availability, "CLOCKED_OUT");

  // Same job resumed later: new shift, waiting time preserved on the old one.
  const resumed = [...events, ev("renewed", "2026-11-20T12:00:00.000Z", { from: "WAITING_HANDOFF" })];
  proj = projectShifts(resumed, t0 + 3 * 60 * MIN);
  assert.equal(proj.shifts.length, 2);
  assert.equal(proj.shifts[1]?.open_reason, "resume");
  assert.equal(proj.shifts[1]?.flags.includes("inferred-open"), false);
  assert.equal(proj.shifts[0]?.waiting_ms, 10 * MIN);
  assert.equal(proj.shifts[0]?.working_ms, 10 * MIN);

  // Waiting mid-shift: roster shows WAITING with the named dependency.
  const waiting = projectShifts(events.slice(0, 2), t0 + 15 * MIN, 60 * MIN);
  assert.equal(waiting.roster[0]?.availability, "WAITING");
  assert.equal(waiting.roster[0]?.available, false);
  assert.match(waiting.roster[0]?.dependency ?? "", /A1/);
});

test("wake opens a shift with trigger and waker; duplicate wakes suppressed", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const wake = ev("handoff-wake", "2026-11-20T10:05:00.000Z", { comment_id: "123", from: "A1", kind: "handoff" });
  const dup = ev("handoff-wake", "2026-11-20T10:05:30.000Z", { comment_id: "123", from: "A1", kind: "handoff" });
  const proj = projectShifts([wake, dup], t0 + 10 * MIN);
  assert.equal(proj.shifts.length, 1);
  assert.equal(proj.shifts[0]?.open_reason, "wake");
  assert.equal(proj.shifts[0]?.waker, "A1");
  assert.equal(proj.shifts[0]?.wake_trigger, "123");
  assert.equal(proj.shifts[0]?.wake_source, "studio-handoff");
  assert.equal(proj.shifts[0]?.duplicates_suppressed, 1);
  assert.equal(proj.suppressed, 1);
  assert.equal(proj.roster[0]?.availability, "WORKING");
});

test("duplicate clock-in on retransmit is a no-op, not a second shift", () => {
  const start = ev("mission-start", "2026-11-20T10:00:00.000Z");
  const proj = projectShifts([start, { ...start }], Date.parse("2026-11-20T10:30:00.000Z"));
  assert.equal(proj.shifts.length, 1);
  assert.equal(proj.suppressed, 1);
});

test("out-of-order delivery still folds into one shift", () => {
  const start = ev("mission-start", "2026-11-20T10:00:00.000Z");
  const wait = ev("handoff-wait", "2026-11-20T10:10:00.000Z", { run_id: "r", role: "A2" });
  // Generous staleness window: this test covers ordering, not freshness.
  const proj = projectShifts([wait, start], Date.parse("2026-11-20T10:30:00.000Z"), 60 * MIN);
  assert.equal(proj.shifts.length, 1);
  assert.equal(proj.shifts[0]?.open_reason, "accept");
  assert.equal(proj.shifts[0]?.waiting_ms, 20 * MIN);
});

test("blocked segments are tracked separately and never billed as working", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const proj = projectShifts(
    [
      ev("mission-start", "2026-11-20T10:00:00.000Z"),
      ev("needs-human", "2026-11-20T10:10:00.000Z", { exact_human_need: "approve spend" }),
      ev("renewed", "2026-11-20T10:40:00.000Z", { mode: "resume" }),
      ev("complete", "2026-11-20T11:00:00.000Z"),
    ],
    t0 + 70 * MIN,
  );
  assert.equal(proj.shifts.length, 1);
  assert.equal(proj.shifts[0]?.blocked_ms, 30 * MIN);
  assert.equal(proj.shifts[0]?.working_ms, 30 * MIN);
  assert.equal(proj.roster[0]?.availability, "CLOCKED_OUT");
});

test("turn error opens an unknown gap; crash goes stale, never billed as active", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const proj = projectShifts(
    [
      ev("mission-start", "2026-11-20T10:00:00.000Z"),
      { at: "2026-11-20T10:10:00.000Z", type: "timekeeper-interruption", job_id: "job-1", worker_session_id: "sess-A", event_id: "e1", outcome: "error", reason: "boom" },
    ],
    t0 + 20 * MIN,
    5 * MIN,
  );
  assert.equal(proj.shifts[0]?.working_ms, 10 * MIN);
  assert.ok((proj.shifts[0]?.unknown_ms ?? 0) >= 10 * MIN);
  assert.ok((proj.shifts[0]?.flags ?? []).some((f) => f.startsWith("interruption:")));
  assert.equal(proj.roster[0]?.availability, "UNKNOWN");

  // No interruption event at all, process simply gone: stale, unknown, flagged.
  const stale = projectShifts([ev("mission-start", "2026-11-20T10:00:00.000Z")], t0 + 60 * MIN, 5 * MIN);
  assert.equal(stale.roster[0]?.availability, "UNKNOWN");
  assert.ok(stale.shifts[0]?.flags.includes("stale-unconfirmed"));
  assert.equal(stale.shifts[0]?.working_ms, 5 * MIN);
});

test("later checkpoints refresh contact: the shift stays WORKING", () => {
  const t0 = Date.parse("2026-11-20T10:00:00.000Z");
  const proj = projectShifts(
    [
      ev("mission-start", "2026-11-20T10:00:00.000Z"),
      ev("checkpoint", "2026-11-20T10:25:00.000Z", { milestone: "m", next_action: "n" }),
    ],
    t0 + 30 * MIN,
    15 * MIN,
  );
  assert.equal(proj.roster[0]?.availability, "WORKING");
  assert.equal(proj.roster[0]?.stale, false);
  assert.equal(proj.roster[0]?.last_event_at, "2026-11-20T10:25:00.000Z");
});

test("clock skew never produces negative intervals", () => {
  // Complete sorts before start, so it is suppressed (no open shift yet);
  // the shift then opens normally.
  const ordered = projectShifts(
    [
      ev("complete", "2026-11-20T09:00:00.000Z"),
      ev("mission-start", "2026-11-20T10:00:00.000Z"),
    ],
    Date.parse("2026-11-20T12:00:00.000Z"),
  );
  assert.equal(ordered.shifts.length, 1);
  assert.equal(ordered.suppressed, 1);
  // Projection instant predates the event stream (clock moved backwards):
  // the open segment is flagged, never billed negative.
  const skewed = projectShifts(
    [ev("mission-start", "2026-11-20T10:00:00.000Z")],
    Date.parse("2026-11-20T09:00:00.000Z"),
  );
  assert.ok(skewed.shifts[0]?.flags.includes("clock-skew"));
  assert.equal(skewed.shifts[0]?.working_ms, 0);
});

test("intercom frame parsing matches the installed broker format exactly", () => {
  const frame = "**From a2-pepin** (D:\\Projects\\wt-mws-timekeeper)\n\n_some-metadata_\n\nplease resume";
  const parsed = parseIntercomFrame(frame);
  assert.deepEqual(parsed, { from: "a2-pepin", cwd: "D:\\Projects\\wt-mws-timekeeper" });
  assert.equal(parseIntercomFrame("hello, continue the mission"), undefined);
  assert.equal(parseIntercomFrame("**From ** ()"), undefined);
});

test("workshop wake line parsing", () => {
  const parsed = parseWorkshopWake("WORKSHOP WAKE A2: A1 (handoff) comment #12345\nverify and continue.");
  assert.deepEqual(parsed, { to: "A2", from: "A1", kind: "handoff", commentId: "12345" });
  assert.equal(parseWorkshopWake("just chatter"), undefined);
});

test("stable event ids dedupe identical retransmits", () => {
  const a = timekeeperEventId({ type: "timekeeper-wake", job_id: "j", at: "2026-11-20T10:00:00.000Z", trigger: "t", detail: "d" });
  const b = timekeeperEventId({ type: "timekeeper-wake", job_id: "j", at: "2026-11-20T10:00:00.000Z", trigger: "t", detail: "d" });
  const c = timekeeperEventId({ type: "timekeeper-wake", job_id: "j", at: "2026-11-20T10:00:01.000Z", trigger: "t", detail: "d" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("UK display: same day omits date, BST and GMT offsets are exact", () => {
  const ref = Date.parse("2026-07-01T12:00:00.000Z");
  assert.equal(formatUK("2026-07-01T11:00:00.000Z", ref), "12:00:00 UK");
  assert.equal(formatUK("2026-01-01T12:00:00.000Z", ref), "12:00:00 UK 1 Jan");
  assert.equal(formatUK("2026-01-01T12:00:00.000Z", Date.parse("2026-01-01T18:00:00.000Z")), "12:00:00 UK");
  assert.equal(formatUK("not-a-date"), "unknown time");
  assert.equal(formatDuration(90 * MIN + 5000), "1h 30m");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(5000), "5s");
});

test("London day boundaries survive the BST transition", () => {
  // BST begins 2026-03-29 01:00 UTC: the London day is 23h long.
  const before = Date.parse("2026-03-29T00:30:00.000Z");
  const after = Date.parse("2026-03-29T02:30:00.000Z");
  assert.equal(londonDayKey(before), "2026-03-29");
  assert.equal(londonDayKey(after), "2026-03-29");
  assert.equal(londonDayKey(Date.parse("2026-03-28T23:30:00.000Z")), "2026-03-28");
  const start = londonDayStartMs(after);
  assert.equal(londonDayKey(start), "2026-03-29");
  assert.equal(londonDayKey(start - 1), "2026-03-28");
  const parts = splitByLondonDay(Date.parse("2026-03-28T23:00:00.000Z"), Date.parse("2026-03-29T02:00:00.000Z"));
  assert.equal(parts.length, 2);
  assert.equal(parts.reduce((n, p) => n + p.ms, 0), 3 * 3_600_000);
});

test("day summary attributes each segment to its London day", () => {
  const proj = projectShifts(
    [
      ev("mission-start", "2026-11-20T22:00:00.000Z"),
      ev("handoff-wait", "2026-11-20T23:30:00.000Z", { run_id: "r", role: "A2" }),
      ev("complete", "2026-11-21T01:00:00.000Z"),
    ],
    Date.parse("2026-11-21T02:00:00.000Z"),
    60 * MIN,
  );
  const totals = summarizeDay(proj.shifts, "2026-11-20", Date.parse("2026-11-21T02:00:00.000Z"));
  assert.ok((totals["sess-A"]?.working_ms ?? 0) > 0);
  const totalsNext = summarizeDay(proj.shifts, "2026-11-21", Date.parse("2026-11-21T02:00:00.000Z"));
  assert.ok((totalsNext["sess-A"]?.waiting_ms ?? 0) > 0);
  assert.equal((totals["sess-A"]?.working_ms ?? 0) + (totalsNext["sess-A"]?.working_ms ?? 0), proj.shifts[0]?.working_ms);
});

test("machine and human roster views carry the same data", () => {
  const proj = projectShifts(
    [
      ev("mission-start", "2026-11-20T10:00:00.000Z"),
      ev("handoff-wait", "2026-11-20T10:10:00.000Z", { run_id: "run-1", role: "A2", expected_from: "A1" }),
    ],
    Date.parse("2026-11-20T10:15:00.000Z"),
    60 * MIN,
  );
  const json = rosterToJson(proj.roster, Date.parse("2026-11-20T10:15:00.000Z")) as { agents: { availability: string; available: boolean }[] };
  const text = rosterToText(proj.roster, Date.parse("2026-11-20T10:15:00.000Z"));
  assert.equal(json.agents[0]?.availability, "WAITING");
  assert.equal(json.agents[0]?.available, false);
  assert.match(text, /WAITING/);
  assert.match(text, /run-1/);
  assert.equal(rosterToText([], Date.now()), "timekeeper: no shifts recorded yet.");
});
