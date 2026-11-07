/**
 * Deterministic sleep/wake/end policy for coordinated Pi workers.
 *
 * Pure: no Pi, no filesystem, no network, no timers. The extension owns
 * polling, delivery and shutdown; every decision here is unit-testable and
 * produces the same verdict for the same inputs. Model inference is never
 * involved: ticks only compare ids, cursors and stamps.
 *
 * Vocabulary: a workshop run (`run_id`) coordinates named worker roles. A
 * waiting worker records a handoff target; a handoff message wakes exactly
 * the worker whose role and run match and whose cursor has not seen it. END
 * is an authorised control-plane decision, never an inbox string.
 */

export type WorkerPresence =
  | "working"
  | "waiting"
  | "blocked"
  | "finished"
  | "ended";

export interface WorkerEntry {
  role: string;
  worker_session_id: string;
  branch?: string;
  /** Current checkout SHA when the worker last reported. */
  head_sha?: string;
  status: WorkerPresence;
  /** ISO timestamp of the last heartbeat or slice receipt. */
  last_seen: string;
  milestone?: string;
  next_action?: string;
  /** Highest inbox message id this worker has acknowledged. */
  cursor?: string;
}

export interface RunRecord {
  run_id: string;
  repository: string;
  issue: number;
  /** Pi session that created the run; only it (or a human) may END it. */
  owner_session_id?: string;
  workers: WorkerEntry[];
  created_at: string;
  updated_at: string;
  /** Set once an authorised END ALL or FINISH closes the run. */
  closed?: { outcome: "ended" | "finished" | "cancelled"; at: string; by: string };
}

export interface HandoffMsg {
  /** GitHub comment id as a decimal string; the ordering key. */
  id: string;
  run_id: string;
  repository: string;
  from: string;
  /** Recipient role. The literal "ALL" never addresses a worker. */
  to: string;
  type: string;
  body: string;
  /** Optional source SHA the handoff was tested against. */
  sha?: string;
  created_at: string;
}

export interface WakeAssessment {
  wake: boolean;
  reason: string;
}

function isDecimalId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]+$/.test(value);
}

/**
 * Compare decimal id strings without precision loss (GitHub ids already
 * exceed 2^32; string comparison avoids float rounding entirely).
 */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface WakeContext {
  run_id: string;
  repository: string;
  role: string;
  /** Highest message id already processed; empty means nothing seen. */
  cursor: string;
  /** When this worker entered WAITING_HANDOFF; older messages are stale. */
  entered_at: string;
  /** Current checkout SHA; a message-bound SHA must equal it when present. */
  head_sha?: string;
}

/**
 * Decide whether one inbox message wakes one waiting worker. Every identity
 * check must pass; the first failure names itself. Shared-login authorship
 * proves nothing and is deliberately not an input.
 */
export function matchWake(worker: WakeContext, msg: HandoffMsg): WakeAssessment {
  if (!isDecimalId(msg.id)) return { wake: false, reason: "ignore: message id is not a GitHub comment id" };
  if (msg.run_id !== worker.run_id) return { wake: false, reason: "ignore: cross-run message" };
  if (msg.repository.toLowerCase() !== worker.repository.toLowerCase()) {
    return { wake: false, reason: "ignore: wrong repository" };
  }
  if (msg.to !== worker.role) return { wake: false, reason: "ignore: wrong recipient" };
  if (msg.from === worker.role) return { wake: false, reason: "ignore: self-authored message" };
  if (worker.cursor !== "" && compareIds(msg.id, worker.cursor) <= 0) {
    return { wake: false, reason: "ignore: duplicate or already-acknowledged message" };
  }
  const msgMs = Date.parse(msg.created_at);
  const enteredMs = Date.parse(worker.entered_at);
  if (!Number.isFinite(msgMs) || !Number.isFinite(enteredMs)) return { wake: false, reason: "ignore: unparseable timestamp cannot prove handoff freshness" };
  if (msgMs < enteredMs) return { wake: false, reason: "ignore: stale message from before this wait began" };
  if (msg.sha !== undefined && worker.head_sha !== undefined && msg.sha.toLowerCase() !== worker.head_sha.toLowerCase()) {
    return { wake: false, reason: "ignore: message-bound SHA does not match this checkout" };
  }
  if (!msg.type || !msg.body.trim()) return { wake: false, reason: "ignore: empty handoff without an actionable type and body" };
  return { wake: true, reason: `wake: ${msg.from} -> ${msg.to} type=${msg.type} id=${msg.id}` };
}

/** Advance a poll cursor past a batch; empty batches keep the old cursor. */
export function advanceCursor(current: string, messages: { id: string }[]): string {
  let best = current;
  for (const msg of messages) {
    if (!isDecimalId(msg.id)) continue;
    if (best === "" || compareIds(msg.id, best) > 0) best = msg.id;
  }
  return best;
}

export type EndTarget = "ALL" | string;

export interface EndCommand {
  run_id: string;
  targets: EndTarget[];
}

export type EndIssuer =
  | { kind: "human"; worker_session_id?: string }
  | { kind: "session"; worker_session_id: string; owner_session_id: string }
  | { kind: "inbox-text" };

export interface EndDecision {
  allowed: boolean;
  /** True when the text is a proposal to relay, never an authorisation. */
  proposal: boolean;
  reason: string;
}

/**
 * END is a control-plane decision, never an inbox string. Allowed issuers:
 * a human turn in the owning session, or a model tool call from the session
 * that owns the run record. GitHub text (or any unverified origin) can only
 * propose REQUEST_END for a human/owner to decide.
 */
export function decideEnd(cmd: EndCommand, run: RunRecord, issuer: EndIssuer): EndDecision {
  if (cmd.run_id !== run.run_id) {
    return { allowed: false, proposal: false, reason: "refuse: END names a different run" };
  }
  if (run.closed !== undefined) {
    return { allowed: false, proposal: false, reason: "refuse: run is already closed" };
  }
  if (issuer.kind === "inbox-text") {
    return { allowed: false, proposal: true, reason: "proposal: inbox text can only request END, never authorise it" };
  }
  if (issuer.kind === "human") return { allowed: true, proposal: false, reason: "allow: human turn" };
  if (issuer.worker_session_id === issuer.owner_session_id) {
    return { allowed: true, proposal: false, reason: "allow: owning session tool call" };
  }
  return { allowed: false, proposal: false, reason: "refuse: END from a session that does not own this run" };
}

/** Expand ALL to the run's live worker roles; unknown roles are refused. */
export function expandEndTargets(run: RunRecord, targets: EndTarget[]): { roles: string[]; unknown: string[] } {
  const live = run.workers.filter((w) => w.status !== "ended").map((w) => w.role);
  const roles: string[] = [];
  const unknown: string[] = [];
  for (const target of targets) {
    if (target === "ALL") {
      for (const role of live) if (!roles.includes(role)) roles.push(role);
      continue;
    }
    if (!live.includes(target)) {
      if (!unknown.includes(target)) unknown.push(target);
      continue;
    }
    if (!roles.includes(target)) roles.push(target);
  }
  return { roles, unknown };
}

export interface CollectiveSummary {
  working: number;
  waiting: number;
  blocked: number;
  finished: number;
  ended: number;
  stale: string[];
  /** True when every worker has reached a terminal or parked state. */
  accounted: boolean;
  headline: string;
}

/**
 * Count the team by presence. Stale means no heartbeat within staleAfterMs;
 * staleness is surfaced, never auto-ended. FINISH/accounting is a progress
 * statement only — it never declares acceptance (that stays with the
 * evidence-gated completion path).
 */
export function summarizeCollective(run: RunRecord, nowMs: number, staleAfterMs: number): CollectiveSummary {
  let working = 0;
  let waiting = 0;
  let blocked = 0;
  let finished = 0;
  let ended = 0;
  const stale: string[] = [];
  for (const worker of run.workers) {
    if (worker.status === "working") working += 1;
    else if (worker.status === "waiting") waiting += 1;
    else if (worker.status === "blocked") blocked += 1;
    else if (worker.status === "finished") finished += 1;
    else ended += 1;
    const seen = Date.parse(worker.last_seen);
    if (Number.isFinite(seen) && nowMs - seen > staleAfterMs && worker.status !== "ended" && worker.status !== "finished") {
      stale.push(worker.role);
    }
  }
  const accounted = working === 0 && waiting === 0 && blocked === 0;
  const parts = [`${working} working`, `${waiting} waiting`, `${blocked} blocked`, `${finished} finished`, `${ended} ended`];
  const headline = stale.length > 0 ? `${parts.join(", ")}; stale: ${stale.join(", ")}` : parts.join(", ");
  return { working, waiting, blocked, finished, ended, stale, accounted, headline };
}

/**
 * One-line roster row per worker so every agent knows who else is in the
 * team, what each owns, and how fresh the presence is. Pure formatting;
 * staleness uses the same rule as the collective summary.
 */
export function rosterLines(run: RunRecord, nowMs: number, staleAfterMs: number): string[] {
  return run.workers.map((worker) => {
    const seen = Date.parse(worker.last_seen);
    const ageS = Number.isFinite(seen) ? Math.max(0, Math.floor((nowMs - seen) / 1000)) : -1;
    const stale = ageS >= 0 && nowMs - seen > staleAfterMs && worker.status !== "ended" && worker.status !== "finished";
    const ownership = [worker.branch, worker.head_sha?.slice(0, 7)].filter(Boolean).join("@");
    const task = [worker.milestone, worker.next_action].filter(Boolean).join(" — ");
    return `${worker.role}: ${worker.status}${stale ? " (STALE)" : ""}${ownership ? ` ${ownership}` : ""}${ageS >= 0 ? ` seen ${ageS}s ago` : " never seen"}${task ? ` · ${task}` : ""}`;
  });
}

/**
 * Deterministic 32-bit hash for stable per-worker jitter (no Math.random in
 * policy; every session computes the same offset for the same worker).
 */
export function hashWorkerId(workerSessionId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < workerSessionId.length; i++) {
    hash ^= workerSessionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Next poll delay: base interval plus stable per-worker jitter (0–15s, so
 * four workers never tick in lockstep), with exponential backoff on
 * consecutive failures capped at 30 minutes. Pure arithmetic for tests.
 */
export function nextPollDelayMs(baseIntervalMs: number, consecutiveFailures: number, workerSessionId: string): number {
  const base = Math.max(1_000, Math.floor(baseIntervalMs));
  const jitter = hashWorkerId(workerSessionId) % 16_000;
  if (consecutiveFailures <= 0) return base + jitter;
  const backoff = Math.min(30 * 60_000, base * 2 ** Math.min(consecutiveFailures, 10));
  return backoff + jitter;
}
