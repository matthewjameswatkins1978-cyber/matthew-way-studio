/** tickWaitingJob orchestration with injected effects: no network, no timers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureSleepRun, shouldKeepWatching, tickWaitingJob } from "../src/watch.js";
import type { JobState } from "../src/schema.js";
import { newJob } from "../src/schema.js";
import type { HandoffMsg } from "../src/sleepwake.js";

function dir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sleepwake-watch-"));
}

function loc(d: string) {
  return { dir: d, source: "fallback" as const };
}

function waitingJob(): JobState {
  const job = newJob({
    jobId: "job-1",
    contract: { objective: "o", scope: [], authority: [], constraints: [], acceptance: ["a"], attention: [] },
    repo: { root: "r", remote: "o/r", current_sha: "a".repeat(40), branch: "b", base_sha: "a".repeat(40), dirty_at_start: false },
    packet: { sha256: "s", bytes: 10, path: "p" },
    nextAction: "go",
  });
  return {
    ...job,
    status: "WAITING_HANDOFF",
    handoff_wait: {
      run_id: "run-1", role: "A2", repository: "o/r", issue: 16, cursor: "",
      branch: "b", head_sha: "a".repeat(40), job_id: "job-1",
      worker_session_id: "sess-2", entered_at: "2026-11-06T14:00:00Z",
    },
    continuation: { ...job.continuation, allowed: false },
  };
}

const HANDOFF = "WORKSHOP-HANDOFF run=run-1 to=A2 type=handoff from=A1\nping";

function comment(id: number, body: string) {
  return { id, login: "a", issue_url: "u", body, created_at: "2026-11-06T14:20:00Z" };
}

function worker(entry: Partial<{ role: string; worker_session_id: string; branch: string; head_sha: string; next_action: string }> = {}) {
  return { role: "A2", worker_session_id: "sess-2", ...entry };
}

function runTick(d: string, comments: ReturnType<typeof comment>[], busy: boolean, failFetch: boolean) {
  const sent: HandoffMsg[] = [];
  const persisted: JobState[] = [];
  const events: string[] = [];
  const job = waitingJob();
  const out = tickWaitingJob(job, job.handoff_wait!, {
    location: loc(d), pollIntervalMs: 180_000, workerSessionId: "sess-2",
    nowIso: () => "2026-11-06T14:30:00Z",
  }, {
    fetch: (_sinceIso: string) => (failFetch
      ? { ok: false as const, reason: "offline" }
      : { ok: true as const, comments }),
    cwd: "D:/repo",
    isIdle: () => !busy,
    sendWake: (msg: HandoffMsg) => { sent.push(msg); },
    mutate: (fn: (fresh: JobState) => JobState | undefined) => {
      const next = fn(job);
      if (!next) return { ok: false as const, reason: "refused" };
      persisted.push(next);
      return { ok: true as const, job: next };
    },
    event: (type: string) => { events.push(type); },
  });
  return { out, sent, persisted, events };
}

function sleepRun(d: string, w: ReturnType<typeof worker> = worker()) {
  return ensureSleepRun(loc(d),
    { run_id: "run-1", repository: "o/r", issue: 16, owner_session_id: "s1" }, w);
}

test("tick returns poll state so the timer loop can persist without re-reading", () => {
  const d = dir();
  sleepRun(d);
  const r = runTick(d, [comment(5, HANDOFF)], false, false);
  assert.equal(r.out.state.cursor, "5");
  assert.equal(r.out.state.consecutiveFailures, 0);
  const failed = runTick(d, [], false, true);
  assert.equal(failed.out.state.consecutiveFailures, 1);
  assert.equal(failed.out.state.cursor, "");
});

test("shouldKeepWatching listens while waiting or working with a retained target", () => {
  const waiting = waitingJob();
  assert.equal(shouldKeepWatching(waiting), true);
  assert.equal(shouldKeepWatching({ ...waiting, status: "WORKING" }), true);
  assert.equal(shouldKeepWatching({ ...waiting, status: "COMPLETE" }), false);
  assert.equal(shouldKeepWatching({ ...waiting, handoff_wait: undefined }), false);
});

test("tick wakes on a matching handoff and persists cursor + delivered id", () => {
  const d = dir();
  sleepRun(d, worker({ branch: "b", head_sha: "a".repeat(40) }));
  const r = runTick(d, [comment(5, HANDOFF)], false, false);
  assert.equal(r.out.woke, true);
  assert.deepEqual(r.sent.map((m) => m.id), ["5"]);
  assert.equal(r.out.reported.woke, "5");
  assert.equal(r.persisted.length, 1);
  assert.equal(r.persisted[0]?.handoff_wait?.cursor, "5");
});

test("busy worker defers without waking and keeps cursor and fetch window", () => {
  const d = dir();
  sleepRun(d);
  const r = runTick(d, [comment(5, HANDOFF)], true, false);
  assert.equal(r.out.woke, false);
  assert.equal(r.out.reported.deferred, "5");
  assert.equal(r.sent.length, 0);
  assert.equal(r.persisted.length, 0);
});

test("duplicate deliveries are suppressed but still advance the cursor", () => {
  const d = dir();
  sleepRun(d);
  const first = runTick(d, [comment(5, HANDOFF)], false, false);
  assert.equal(first.out.woke, true);
  const second = runTick(d, [comment(5, HANDOFF)], false, false);
  assert.equal(second.out.woke, false);
  assert.equal(second.out.reported.duplicateSuppressed, "5");
  assert.equal(second.sent.length, 0);
});

test("fetch failure backs off without moving the cursor", () => {
  const d = dir();
  sleepRun(d);
  const r = runTick(d, [], false, true);
  assert.equal(r.out.woke, false);
  assert.equal(r.out.error, "offline");
  assert.ok(r.out.reported.nextDelayMs > 180_000);
});

test("ensureSleepRun registers the worker and writes the heartbeat path", () => {
  const d = dir();
  const run = sleepRun(d, worker({ branch: "b", next_action: "wait" }));
  assert.equal(run.workers.length, 1);
  assert.equal(run.owner_session_id, "s1");
  assert.equal(run.workers[0]?.status, "waiting");
});
