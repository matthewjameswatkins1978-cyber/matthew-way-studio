/**
 * Sleep/wake runtime wiring between the Studio extension and the pure policy.
 *
 * Timers live in the extension (session_start arms, session_shutdown clears);
 * everything decision-shaped lives here and in sleepwake.ts so the whole wait
 * path is unit-testable with fake hosts. No model calls anywhere on this path.
 */

import { applyHandoffCursor, applyHandoffWait, applyWake, type HandoffWaitInput } from "./mission.js";
import type { LedgerLocation } from "./paths.js";
import type { JobState } from "./schema.js";
import { pollOnce, type FetchFail, type FetchOk } from "./watcher.js";
import { nextPollDelayMs, rosterLines, summarizeCollective, type HandoffMsg } from "./sleepwake.js";
import { ensureRunRecord, markDelivered, readDeliveredIds, readHeartbeat, readRunRecord, upsertWorker, writeHeartbeat } from "./workshop.js";
import type { RunRecord } from "./sleepwake.js";

export interface RunContext {
  location: LedgerLocation;
  pollIntervalMs: number;
  workerSessionId: string;
  nowIso: () => string;
}

/**
 * Whether this job should keep a live inbox watcher: waiting for handoff, or
 * working with a retained handoff target from a previous wake. Terminal jobs
 * never watch. This is what makes park -> wake -> work -> wake-again reliable
 * without depending on the model remembering to re-park: the retained target
 * keeps listening across the woken turn.
 */
export function shouldKeepWatching(job: JobState): boolean {
  if (!job.handoff_wait) return false;
  return job.status === "WAITING_HANDOFF" || job.status === "WORKING";
}

export interface TickOutcome {
  reported: { fetched: number; matched: number; woke?: string; deferred?: string; duplicateSuppressed?: string; nextDelayMs: number; error?: string };
  state: { cursor: string; lastFetchIso: string; consecutiveFailures: number };
  woke: boolean;
  error?: string;
}

/**
 * One supervised tick for a WAITING_HANDOFF job: fetch, match, wake-or-defer,
 * persist cursor, heartbeat. Returns whether a wake was delivered.
 */
export function tickWaitingJob(
  job: JobState,
  wait: NonNullable<JobState["handoff_wait"]>,
  run: RunContext,
  io: {
    fetch: (sinceIso: string, cwd: string) => FetchOk | FetchFail;
    cwd: string;
    isIdle: () => boolean;
    sendWake: (msg: HandoffMsg) => void;
    mutate: (fn: (fresh: JobState) => JobState | undefined) => { ok: boolean; job?: JobState; reason?: string };
    event: (type: string, data: Record<string, unknown>) => void;
  },
): TickOutcome {
  const delivered = new Set(readDeliveredIds(run.location, wait.run_id));
  const { state, report } = pollOnce(
    { cursor: wait.cursor, lastFetchIso: "", consecutiveFailures: 0 },
    {
      run_id: wait.run_id,
      repository: wait.repository,
      role: wait.role,
      cursor: wait.cursor,
      entered_at: wait.entered_at,
      head_sha: wait.head_sha,
    },
    {
      fetch: (sinceIso) => io.fetch(sinceIso, io.cwd),
      isIdle: io.isIdle,
      sendWake: io.sendWake,
      now: Date.now,
      nowIso: run.nowIso,
      deliveredHas: (id) => delivered.has(id),
      markDelivered: (id) => {
        delivered.add(id);
        markDelivered(run.location, wait.run_id, id);
      },
      persistCursor: (cursor) => {
        io.mutate((fresh) => (fresh.handoff_wait ? applyHandoffCursor(fresh, cursor) : undefined));
      },
      recordEvent: io.event,
      heartbeat: (cursor) => {
        const record = readRunRecord(run.location, wait.run_id);
        const member = record?.workers.find((w) => w.role === wait.role);
        writeHeartbeat(run.location, wait.run_id, {
          role: wait.role,
          worker_session_id: member?.worker_session_id ?? run.workerSessionId,
          ...(member?.branch ? { branch: member.branch } : {}),
          ...(member?.head_sha ? { head_sha: member.head_sha } : {}),
          status: "waiting",
          last_seen: run.nowIso(),
          ...(cursor ? { cursor } : {}),
        });
      },
    },
    run.pollIntervalMs,
    run.workerSessionId,
  );
  return { state, reported: { fetched: report.fetched, matched: report.matched, ...(report.woke ? { woke: report.woke } : {}), ...(report.deferred ? { deferred: report.deferred } : {}), ...(report.duplicateSuppressed ? { duplicateSuppressed: report.duplicateSuppressed } : {}), nextDelayMs: report.nextDelayMs, ...(report.error ? { error: report.error } : {}) }, woke: report.woke !== undefined, error: report.error };
}

/** Apply a verified wake to the job: WORKING with the handoff as next action. */
export function applyVerifiedWake(job: JobState, commentId: number, from: string, type: string): JobState {
  return applyWake(job, { comment_id: commentId, from, type });
}

export type { HandoffWaitInput };

/** Register (or re-register) a waiting worker and return its run record. */
export function ensureSleepRun(
  location: LedgerLocation,
  input: { run_id: string; repository: string; issue: number; owner_session_id: string },
  worker: { role: string; worker_session_id: string; branch?: string; head_sha?: string; next_action?: string },
): RunRecord {
  const run = ensureRunRecord(location, input);
  upsertWorker(location, input.run_id, {
    role: worker.role,
    worker_session_id: worker.worker_session_id,
    ...(worker.branch ? { branch: worker.branch } : {}),
    ...(worker.head_sha ? { head_sha: worker.head_sha } : {}),
    status: "waiting",
    last_seen: new Date().toISOString(),
    ...(worker.next_action ? { next_action: worker.next_action } : {}),
    cursor: "",
  });
  const updated = readRunRecord(location, input.run_id);
  if (!updated) throw new Error("workshop run record could not be read after write");
  return updated;
}

/** Human-readable team status: roster plus collective counts. */
export function teamStatusText(location: LedgerLocation, run: RunRecord, nowMs: number, staleAfterMs: number): string {
  const withPresence = run.workers.map((member) => readHeartbeat(location, run.run_id, member.role) ?? member);
  const lines = rosterLines({ ...run, workers: withPresence }, nowMs, staleAfterMs);
  const summary = summarizeCollective({ ...run, workers: withPresence }, nowMs, staleAfterMs);
  return [`workshop ${run.run_id} (${run.repository}#${run.issue}): ${summary.headline}`, ...lines.map((line) => `  ${line}`)].join("\n");
}

export function nextDelayMs(pollIntervalMs: number, consecutiveFailures: number, workerSessionId: string): number {
  return nextPollDelayMs(pollIntervalMs, consecutiveFailures, workerSessionId);
}
