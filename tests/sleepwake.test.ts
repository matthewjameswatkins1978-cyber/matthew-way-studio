/** Pure-policy tests for the sleep/wake/end coordination layer. No Pi, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceCursor,
  compareIds,
  decideEnd,
  expandEndTargets,
  hashWorkerId,
  matchWake,
  nextPollDelayMs,
  rosterLines,
  summarizeCollective,
  type HandoffMsg,
  type RunRecord,
  type WakeContext,
} from "../src/sleepwake.js";

const RUN = "job-20261106-fe96d8b4";
const REPO = "matthewjameswatkins1978-cyber/pepin";

function workerContext(overrides: Partial<WakeContext> = {}): WakeContext {
  return {
    run_id: RUN,
    repository: REPO,
    role: "A2",
    cursor: "6698000000",
    entered_at: "2026-11-06T14:00:00Z",
    head_sha: "a".repeat(40),
    ...overrides,
  };
}

function msg(overrides: Partial<HandoffMsg> = {}): HandoffMsg {
  return {
    id: "6698051352",
    run_id: RUN,
    repository: REPO,
    from: "A1",
    to: "A2",
    type: "handoff",
    body: "A2: the re-pin SHA is 1658ea9, verify and push.",
    created_at: "2026-11-06T14:20:00Z",
    ...overrides,
  };
}

function runRecord(): RunRecord {
  return {
    run_id: RUN,
    repository: REPO,
    issue: 16,
    workers: [
      { role: "A1", worker_session_id: "s1", branch: "b1", status: "working", last_seen: "2026-11-06T14:00:00Z", milestone: "integrate", next_action: "merge A2 SHA" },
      { role: "A2", worker_session_id: "s2", branch: "b2", status: "waiting", last_seen: "2026-11-06T14:00:00Z", cursor: "6698000000" },
      { role: "A3", worker_session_id: "s3", status: "blocked", last_seen: "2026-11-06T13:00:00Z" },
      { role: "A4", worker_session_id: "s4", status: "finished", last_seen: "2026-11-06T13:30:00Z" },
    ],
    created_at: "2026-11-06T13:00:00Z",
    updated_at: "2026-11-06T14:00:00Z",
  };
}

test("matchWake wakes exactly the addressed worker", () => {
  const decision = matchWake(workerContext(), msg());
  assert.equal(decision.wake, true);
});

test("matchWake ignores wrong recipient, run, repo, self and empty handoffs", () => {
  assert.equal(matchWake(workerContext(), msg({ to: "A3" })).wake, false);
  assert.equal(matchWake(workerContext(), msg({ run_id: "other" })).wake, false);
  assert.equal(matchWake(workerContext(), msg({ repository: "someone/else" })).wake, false);
  assert.equal(matchWake(workerContext({ role: "A1" }), msg()).wake, false);
  assert.equal(matchWake(workerContext(), msg({ type: "", body: "  " })).wake, false);
});

test("matchWake deduplicates by cursor and rejects stale and SHA-mismatched messages", () => {
  assert.match(matchWake(workerContext(), msg({ id: "6698000000" })).reason, /duplicate/);
  assert.match(matchWake(workerContext(), msg({ id: "6697999999" })).reason, /duplicate/);
  assert.match(matchWake(workerContext(), msg({ created_at: "2026-11-06T13:00:00Z", id: "6698100000" })).reason, /stale/);
  assert.match(matchWake(workerContext(), msg({ sha: "b".repeat(40) })).reason, /SHA/);
  assert.equal(matchWake(workerContext(), msg({ id: "6698100000", sha: "a".repeat(40) })).wake, true);
});

test("compareIds orders decimal strings without float precision loss", () => {
  assert.equal(compareIds("9", "10"), -1);
  assert.equal(compareIds("6698051352", "6698051352"), 0);
  assert.equal(compareIds("9007199254740993", "9007199254740992"), 1);
});

test("advanceCursor takes the max valid id and keeps the old cursor on empty batches", () => {
  assert.equal(advanceCursor("", [msg({ id: "5" }), msg({ id: "9" }), msg({ id: "7" })]), "9");
  assert.equal(advanceCursor("6698000000", []), "6698000000");
  assert.equal(advanceCursor("6698000000", [msg({ id: "nope" })]), "6698000000");
});

test("decideEnd authorises humans and owning sessions, never inbox text", () => {
  const run = runRecord();
  const cmd = { run_id: RUN, targets: ["A2" as const] };
  assert.equal(decideEnd(cmd, run, { kind: "human" }).allowed, true);
  assert.equal(decideEnd(cmd, run, { kind: "session", worker_session_id: "s1", owner_session_id: "s1" }).allowed, true);
  const foreign = decideEnd(cmd, run, { kind: "session", worker_session_id: "s9", owner_session_id: "s1" });
  assert.equal(foreign.allowed, false);
  const proposal = decideEnd(cmd, run, { kind: "inbox-text" });
  assert.equal(proposal.allowed, true);
  assert.equal(proposal.proposal, true);
  assert.equal(decideEnd({ run_id: "other", targets: ["ALL"] }, run, { kind: "human" }).allowed, false);
  const closed: RunRecord = { ...run, closed: { outcome: "ended", at: "t", by: "human" } };
  assert.equal(decideEnd(cmd, closed, { kind: "human" }).allowed, false);
});

test("expandEndTargets expands ALL to live roles and reports unknown roles", () => {
  const run = runRecord();
  assert.deepEqual(expandEndTargets(run, ["ALL"]).roles.sort(), ["A1", "A2", "A3", "A4"]);
  assert.deepEqual(expandEndTargets(run, ["A2"]).roles, ["A2"]);
  const unknown = expandEndTargets(run, ["A9"]);
  assert.deepEqual(unknown.roles, []);
  assert.deepEqual(unknown.unknown, ["A9"]);
});

test("summarizeCollective counts presence and surfaces stale workers without ending them", () => {
  const now = Date.parse("2026-11-06T14:05:00Z");
  const summary = summarizeCollective(runRecord(), now, 10 * 60_000);
  assert.deepEqual([summary.working, summary.waiting, summary.blocked, summary.finished, summary.ended], [1, 1, 1, 1, 0]);
  assert.equal(summary.accounted, false);
  // A3 last seen 65 minutes ago with a 10-minute budget: stale but still counted as blocked.
  assert.deepEqual(summary.stale, ["A3"]);
  const done = summarizeCollective(
    { ...runRecord(), workers: runRecord().workers.map((w) => ({ ...w, status: "finished" as const })) },
    now,
    10 * 60_000,
  );
  assert.equal(done.accounted, true);
});

test("rosterLines name every worker with status, ownership and freshness", () => {
  const now = Date.parse("2026-11-06T14:05:00Z");
  const lines = rosterLines(runRecord(), now, 10 * 60_000);
  assert.equal(lines.length, 4);
  const a1 = lines.find((line) => line.startsWith("A1:")) ?? "";
  const a3 = lines.find((line) => line.startsWith("A3:")) ?? "";
  assert.match(a1, /A1: working/);
  assert.match(a1, /b1/);
  assert.match(a1, /integrate/);
  assert.match(a3, /A3: blocked \(STALE\)/);
});

test("poll delays are deterministic with jitter and capped exponential backoff", () => {
  const first = nextPollDelayMs(180_000, 0, "s2");
  assert.ok(first >= 180_000 && first < 196_000);
  assert.equal(nextPollDelayMs(180_000, 0, "s2"), first);
  assert.notEqual(nextPollDelayMs(180_000, 0, "s2"), nextPollDelayMs(180_000, 0, "s3"));
  const failing = nextPollDelayMs(180_000, 3, "s2");
  assert.ok(failing >= 180_000 * 8);
  assert.ok(nextPollDelayMs(180_000, 100, "s2") <= 30 * 60_000 + 16_000);
  assert.equal(hashWorkerId("s2"), hashWorkerId("s2"));
});
