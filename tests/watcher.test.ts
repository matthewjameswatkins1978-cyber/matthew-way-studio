/** pollOnce orchestration with injected fakes: no network, no timers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollOnce, type PollDeps, type PollState, type WatchTarget } from "../src/watcher.js";
import type { HandoffMsg } from "../src/sleepwake.js";
import type { IssueComment } from "../src/inbox.js";

const TARGET: WatchTarget = {
  run_id: "run-1",
  repository: "o/r",
  role: "A2",
  cursor: "100",
  entered_at: "2026-11-06T14:00:00Z",
};

function comment(id: number, body: string, created = "2026-11-06T14:20:00Z"): IssueComment {
  return { id, login: "peer", issue_url: "u", body, created_at: created };
}

function handoff(to = "A2", id = 101): string {
  return `WORKSHOP-HANDOFF run=run-1 to=${to} type=handoff from=A1\nping ${id}`;
}

interface Harness {
  deps: PollDeps;
  sent: HandoffMsg[];
  persisted: string[];
  events: string[];
  failFetch: boolean;
  busy: boolean;
  delivered: Set<string>;
}

function harness(comments: IssueComment[]): Harness {
  const sent: HandoffMsg[] = [];
  const persisted: string[] = [];
  const events: string[] = [];
  const delivered = new Set<string>();
  const h: Harness = {
    sent, persisted, events, delivered,
    failFetch: false,
    busy: false,
    deps: {
      fetch: () => (h.failFetch ? { ok: false, reason: "offline" } : { ok: true, comments }),
      isIdle: () => !h.busy,
      sendWake: (msg) => { sent.push(msg); },
      now: () => Date.parse("2026-11-06T14:30:00Z"),
      nowIso: () => "2026-11-06T14:30:00Z",
      deliveredHas: (id) => delivered.has(id),
      markDelivered: (id) => { delivered.add(id); },
      persistCursor: (cursor) => { persisted.push(cursor); },
      recordEvent: (type) => { events.push(type); },
      heartbeat: () => {},
    },
  };
  return h;
}

const STATE: PollState = { cursor: "100", lastFetchIso: "", consecutiveFailures: 0 };

test("wake exactly once on the first actionable message and advance past chatter", () => {
  const h = harness([comment(99, "old chatter"), comment(101, handoff()), comment(102, handoff())]);
  const { state, report } = pollOnce(STATE, TARGET, h.deps, 180_000, "s2");
  assert.equal(report.woke, "101");
  assert.equal(h.sent.length, 1);
  assert.equal(state.cursor, "101");
  assert.deepEqual(h.persisted, ["101"]);
  assert.ok(h.events.includes("watch-wake"));
});

test("busy worker defers without advancing past the message or the fetch window", () => {
  const h = harness([comment(101, handoff())]);
  h.busy = true;
  const { state, report } = pollOnce(STATE, TARGET, h.deps, 180_000, "s2");
  assert.equal(report.deferred, "101");
  assert.equal(h.sent.length, 0);
  assert.equal(state.cursor, "100");
  assert.equal(state.lastFetchIso, "");
});

test("delivered ids suppress duplicate wakes but still advance the cursor", () => {
  const h = harness([comment(101, handoff())]);
  h.delivered.add("101");
  const { state, report } = pollOnce(STATE, TARGET, h.deps, 180_000, "s2");
  assert.equal(report.duplicateSuppressed, "101");
  assert.equal(h.sent.length, 0);
  assert.equal(state.cursor, "101");
  assert.equal(state.lastFetchIso, "2026-11-06T14:30:00Z");
});

test("non-matching chatter advances the cursor without waking", () => {
  const h = harness([comment(101, "just talking"), comment(102, handoff("A9"))]);
  const { state, report } = pollOnce(STATE, TARGET, h.deps, 180_000, "s2");
  assert.equal(report.woke, undefined);
  assert.equal(h.sent.length, 0);
  assert.equal(state.cursor, "102");
});

test("fetch failure backs off without moving the cursor", () => {
  const h = harness([]);
  h.failFetch = true;
  const first = pollOnce(STATE, TARGET, h.deps, 180_000, "s2");
  assert.equal(first.report.error, "offline");
  assert.equal(first.state.consecutiveFailures, 1);
  assert.equal(first.state.cursor, "100");
  assert.ok(first.report.nextDelayMs > 180_000);
  const second = pollOnce(first.state, TARGET, h.deps, 180_000, "s2");
  assert.ok(second.report.nextDelayMs >= first.report.nextDelayMs);
});

test("send failure keeps cursor and fetch window for retry", () => {
  const h = harness([comment(101, handoff())]);
  const deps: PollDeps = { ...h.deps, sendWake: () => { throw new Error("broker down"); } };
  const { state, report } = pollOnce(STATE, TARGET, deps, 180_000, "s2");
  assert.equal(report.woke, undefined);
  assert.equal(report.deferred, undefined);
  assert.equal(state.cursor, "100");
  assert.equal(state.lastFetchIso, "");
  assert.ok(h.events.includes("watch-wake-failed"));
});
