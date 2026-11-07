/**
 * One deterministic inbox poll: fetch, match, wake-or-defer, advance cursor.
 *
 * Pure orchestration with injected effects: the extension supplies the fetcher,
 * idle probe, sender and persistence; tests supply fakes. No timers here —
 * the extension owns setInterval lifecycle. No model calls anywhere on this
 * path: a tick only moves ids, cursors and one conditional wake message.
 *
 * Staleness guard: the fetch window (`lastFetchIso`) only advances past a
 * batch that was fully scanned. A deferred or failed send keeps the old
 * window, so the message is refetched (dedupe via cursor + delivered ids)
 * instead of silently aging out of the GitHub `since` filter.
 */

import { parseHandoffs, type IssueComment } from "./inbox.js";
import { compareIds, matchWake, nextPollDelayMs, type HandoffMsg, type WakeContext } from "./sleepwake.js";

export interface WatchTarget {
  run_id: string;
  repository: string;
  role: string;
  /** Highest message id already processed. */
  cursor: string;
  /** When this wait began; older messages are stale. */
  entered_at: string;
  head_sha?: string;
}

export interface FetchOk {
  ok: true;
  comments: IssueComment[];
}
export interface FetchFail {
  ok: false;
  reason: string;
}

export interface PollDeps {
  fetch: (sinceIso: string) => FetchOk | FetchFail;
  isIdle: () => boolean;
  /** Deliver the wake message; throws on transport failure. */
  sendWake: (msg: HandoffMsg) => void;
  now: () => number;
  nowIso: () => string;
  deliveredHas: (id: string) => boolean;
  markDelivered: (id: string) => void;
  persistCursor: (cursor: string) => void;
  recordEvent: (type: string, data: Record<string, unknown>) => void;
  heartbeat: (cursor: string) => void;
}

export interface PollState {
  cursor: string;
  lastFetchIso: string;
  consecutiveFailures: number;
}

export interface PollReport {
  fetched: number;
  matched: number;
  woke?: string;
  deferred?: string;
  duplicateSuppressed?: string;
  error?: string;
  nextDelayMs: number;
}

/**
 * Run one tick. At most one wake per tick; a deferred or failed send stops
 * the scan without advancing past the message, and the fetch window stays
 * put so the message is seen again. The cursor only moves past fully
 * processed messages, which bounds refetch without ever skipping one.
 */
export function pollOnce(
  state: PollState,
  target: WatchTarget,
  deps: PollDeps,
  pollIntervalMs: number,
  workerSessionId: string,
): { state: PollState; report: PollReport } {
  const fetched = deps.fetch(state.lastFetchIso);
  if (!fetched.ok) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    deps.recordEvent("watch-poll-error", { run_id: target.run_id, reason: fetched.reason, failures: consecutiveFailures });
    deps.heartbeat(state.cursor);
    return {
      state: { ...state, consecutiveFailures },
      report: { fetched: 0, matched: 0, error: fetched.reason, nextDelayMs: nextPollDelayMs(pollIntervalMs, consecutiveFailures, workerSessionId) },
    };
  }
  const matched = parseHandoffs(fetched.comments, target.repository);
  const worker: WakeContext = {
    run_id: target.run_id,
    repository: target.repository,
    role: target.role,
    cursor: state.cursor,
    entered_at: target.entered_at,
    ...(target.head_sha ? { head_sha: target.head_sha } : {}),
  };
  let scan = state.cursor;
  let woke: string | undefined;
  let deferred: string | undefined;
  let duplicateSuppressed: string | undefined;
  let stoppedEarly = false;
  for (const msg of matched) {
    if (scan !== "" && compareIds(msg.id, scan) <= 0) continue;
    const assessment = matchWake({ ...worker, cursor: scan }, msg);
    if (!assessment.wake) {
      scan = msg.id;
      continue;
    }
    if (deps.deliveredHas(msg.id)) {
      duplicateSuppressed = msg.id;
      scan = msg.id;
      continue;
    }
    if (!deps.isIdle()) {
      deferred = msg.id;
      stoppedEarly = true;
      break;
    }
    try {
      deps.sendWake(msg);
    } catch (error) {
      deps.recordEvent("watch-wake-failed", { run_id: target.run_id, message_id: msg.id, reason: error instanceof Error ? error.message : String(error) });
      stoppedEarly = true;
      break;
    }
    deps.markDelivered(msg.id);
    scan = msg.id;
    deps.persistCursor(scan);
    deps.recordEvent("watch-wake", { run_id: target.run_id, to: msg.to, from: msg.from, type: msg.type, message_id: msg.id });
    woke = msg.id;
    stoppedEarly = true;
    break;
  }
  if (!stoppedEarly) {
    deps.persistCursor(scan);
  }
  deps.heartbeat(scan);
  deps.recordEvent("watch-tick", { run_id: target.run_id, fetched: fetched.comments.length, matched: matched.length, cursor: scan });
  return {
    state: { cursor: scan, lastFetchIso: stoppedEarly ? state.lastFetchIso : deps.nowIso(), consecutiveFailures: 0 },
    report: {
      fetched: fetched.comments.length,
      matched: matched.length,
      ...(woke ? { woke } : {}),
      ...(deferred ? { deferred } : {}),
      ...(duplicateSuppressed ? { duplicateSuppressed } : {}),
      nextDelayMs: nextPollDelayMs(pollIntervalMs, 0, workerSessionId),
    },
  };
}
