/**
 * Timekeeper: deterministic shift/availability projection for the workshop.
 *
 * Pure: no Pi, no filesystem, no network, no timers, no model calls. The
 * projector consumes the Studio extension's already-committed host events
 * (the same `events.jsonl` stream the ledger appends: mission-start,
 * renewed, handoff-wake, handoff-wait, review-wait, needs-human, complete,
 * mission-parked, mission-switch, session-shutdown, plus the two dedicated
 * `timekeeper-*` events) and derives shifts, intervals and one roster.
 *
 * Vocabulary:
 * - a shift opens on actual accept/resume/wake and closes on actual
 *   completion/park/interruption. Resume from park is a new shift, same job.
 * - inside an open shift the agent is WORKING, WAITING (named dependency),
 *   BLOCKED (reason + intervention) or UNKNOWN (stale, error gap, crash).
 * - CLOCKED_OUT means no open shift. A waiting agent that retains job
 *   ownership is WAITING, never "available": only CLOCKED_OUT agents with
 *   no retained job are listed as available.
 * - working time is wall-clock time in the working state. It is never
 *   inference time and never cost: compute/cost ride in a separate
 *   accounting slot that stays `unknown` until TAXI (or a reported total
 *   with provenance) fills it. An unknown gap is never billed as active.
 * - timestamps are stored UTC ISO with millisecond precision from the host
 *   clock and displayed UK local (Europe/London, DST-aware).
 */
import { createHash } from "node:crypto";

export const TIMEKEEPER_SCHEMA = 1;

/** Dedicated Timekeeper event types appended to the shared host JSONL. */
export const TK_WAKE = "timekeeper-wake";
export const TK_INTERRUPTION = "timekeeper-interruption";

export type Availability = "WORKING" | "WAITING" | "BLOCKED" | "CLOCKED_OUT" | "UNKNOWN";

export type ShiftState = "working" | "waiting" | "blocked" | "unknown";

export type ShiftOpenReason = "accept" | "resume" | "wake";
export type ShiftCloseReason = "complete" | "park" | "interrupted" | "superseded";

/** One raw JSONL line from the ledger event stream (fields we read). */
export interface LedgerEvent {
  at: string;
  type: string;
  job_id?: unknown;
  [key: string]: unknown;
}

export interface StateSegment {
  state: ShiftState;
  from: string;
  to?: string;
  dependency?: string;
  reason?: string;
}

export interface ShiftAccounting {
  inference_s?: number;
  cost?: number;
  /** taxi = measured by TAXI; reported = human/agent-supplied with provenance; unknown = no data. */
  source: "taxi" | "reported" | "unknown";
  at?: string;
}

export interface ShiftRecord {
  shift_id: string;
  agent: string;
  job_id: string;
  project: string;
  opened_at: string;
  open_reason: ShiftOpenReason;
  waker?: string;
  wake_trigger?: string;
  wake_source?: "studio-handoff" | "intercom" | "human" | "unknown";
  closed_at?: string;
  close_reason?: ShiftCloseReason;
  /** True when the host observed the close; false when inferred on recovery. */
  close_known?: boolean;
  segments: StateSegment[];
  working_ms: number;
  waiting_ms: number;
  blocked_ms: number;
  unknown_ms: number;
  accounting: ShiftAccounting;
  flags: string[];
  duplicates_suppressed: number;
}

export interface AgentRosterEntry {
  agent: string;
  role?: string;
  availability: Availability;
  project?: string;
  job_id?: string;
  shift_id?: string;
  milestone?: string;
  next_action?: string;
  dependency?: string;
  last_event?: string;
  last_event_at?: string;
  /** ms since last_event_at relative to the projection instant. */
  last_event_age_ms?: number;
  stale: boolean;
  working_ms_today?: number;
  waiting_ms_today?: number;
  blocked_ms_today?: number;
  available: boolean;
  evidence?: string;
}

export interface Projection {
  shifts: ShiftRecord[];
  roster: AgentRosterEntry[];
  suppressed: number;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sha8(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 8);
}

/** Stable id for one logical event: identical retransmits share it. */
export function timekeeperEventId(input: { type: string; job_id: string; at: string; trigger?: string; detail?: string }): string {
  return createHash("sha256")
    .update(`${TIMEKEEPER_SCHEMA}|${input.type}|${input.job_id}|${input.at}|${input.trigger ?? ""}|${input.detail ?? ""}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

const INTERCOM_FRAME = /^\*\*From (.+?)\*\* \((.+?)\)/s;

/**
 * Parse the pi-intercom delivery frame. The broker injects custom messages
 * shaped `**From <sender>** (<cwd>)...` (customType "intercom_message",
 * verified against the installed pi-intercom source). Returns the sender
 * and cwd, or undefined when the prompt carries no intercom frame — never
 * a guess.
 */
export function parseIntercomFrame(prompt: string): { from: string; cwd: string } | undefined {
  const match = INTERCOM_FRAME.exec(prompt.trim());
  if (!match) return undefined;
  const from = (match[1] ?? "").trim().slice(0, 120);
  const cwd = (match[2] ?? "").trim().slice(0, 260);
  if (!from || !cwd) return undefined;
  return { from, cwd };
}

const WORKSHOP_WAKE_LINE = /^WORKSHOP WAKE (\S+): (\S+) \((\S+)\) comment #(\d+)/;

/** WORKSHOP WAKE envelope the Studio timer delivers (see extensions/index.ts). */
export function parseWorkshopWake(prompt: string): { to: string; from: string; kind: string; commentId: string } | undefined {
  const found = WORKSHOP_WAKE_LINE.exec(prompt.trim());
  if (!found) return undefined;
  return { to: found[1] ?? "", from: found[2] ?? "", kind: found[3] ?? "", commentId: found[4] ?? "" };
}

function agentOf(event: LedgerEvent): string {
  const direct = str(event.worker_session_id) || str(event.session_id) || str(event.agent);
  return direct || "legacy";
}

function projectOf(event: LedgerEvent): string {
  return str(event.repository) || str(event.remote) || str(event.root) || str(event.project) || "";
}

function eventMs(event: LedgerEvent): number {
  return Date.parse(str(event.at));
}

function openShift(input: {
  agent: string;
  job_id: string;
  project: string;
  at: string;
  reason: ShiftOpenReason;
  waker?: string;
  wake_trigger?: string;
  wake_source?: ShiftRecord["wake_source"];
  flag?: string;
}): ShiftRecord {
  const shift: ShiftRecord = {
    shift_id: `sh-${sha8(`${input.job_id}|${input.at}|${input.agent}`)}`,
    agent: input.agent,
    job_id: input.job_id,
    project: input.project,
    opened_at: input.at,
    open_reason: input.reason,
    segments: [{ state: "working", from: input.at }],
    working_ms: 0,
    waiting_ms: 0,
    blocked_ms: 0,
    unknown_ms: 0,
    accounting: { source: "unknown" },
    flags: [],
    duplicates_suppressed: 0,
  };
  if (input.waker) shift.waker = input.waker;
  if (input.wake_trigger) shift.wake_trigger = input.wake_trigger;
  if (input.wake_source) shift.wake_source = input.wake_source;
  if (input.flag) shift.flags.push(input.flag);
  return shift;
}

function closeOpenSegment(shift: ShiftRecord, at: string): void {
  const current = shift.segments[shift.segments.length - 1];
  if (current && !current.to) current.to = at;
}

function setState(shift: ShiftRecord, state: ShiftState, at: string, detail?: { dependency?: string; reason?: string }): void {
  const current = shift.segments[shift.segments.length - 1];
  if (current && !current.to && current.state === state) {
    if (detail?.dependency && !current.dependency) current.dependency = detail.dependency;
    if (detail?.reason && !current.reason) current.reason = detail.reason;
    return;
  }
  closeOpenSegment(shift, at);
  const segment: StateSegment = { state, from: at };
  if (detail?.dependency) segment.dependency = detail.dependency;
  if (detail?.reason) segment.reason = detail.reason;
  shift.segments.push(segment);
}

/**
 * Deterministic projection: sort by (occurred_at, file order), dedupe by
 * stable event id, fold into shifts. Replay of the same stream always yields
 * the same roster and totals.
 */
export function projectShifts(rawEvents: LedgerEvent[], nowMs: number, staleAfterMs = 15 * 60_000): Projection {
  const indexed = rawEvents
    .map((event, seq) => ({ event, seq }))
    .filter(({ event }) => event && typeof event.type === "string" && Number.isFinite(eventMs(event)));
  indexed.sort((a, b) => {
    const diff = eventMs(a.event) - eventMs(b.event);
    return diff !== 0 ? diff : a.seq - b.seq;
  });

  const shifts: ShiftRecord[] = [];
  const byAgentJob = new Map<string, ShiftRecord>();
  const lastEventByKey = new Map<string, number>();
  const seenIds = new Set<string>();
  let suppressed = 0;
  // (job, kind, trigger) -> ms, for duplicate wake/interruption suppression.
  const recentTriggers = new Map<string, number>();

  const openFor = (agent: string, jobId: string): ShiftRecord | undefined => {
    const shift = byAgentJob.get(`${agent}|${jobId}`);
    return shift && !shift.closed_at ? shift : undefined;
  };

  for (const { event } of indexed) {
    const type = event.type;
    const jobId = str(event.job_id);
    if (!jobId) continue;
    const agent = agentOf(event);
    const at = str(event.at);
    const atMs = eventMs(event);
    const key = `${agent}|${jobId}`;

    const stableId =
      type === TK_WAKE || type === TK_INTERRUPTION
        ? str(event.event_id) ||
          timekeeperEventId({ type, job_id: jobId, at, trigger: str(event.trigger_id), detail: str(event.detail) })
        : `${type}|${jobId}|${at}|${str(event.comment_id)}|${str(event.cursor ?? "")}`;
    if (seenIds.has(stableId)) {
      suppressed += 1;
      const open = openFor(agent, jobId);
      if (open) open.duplicates_suppressed += 1;
      continue;
    }
    seenIds.add(stableId);
    lastEventByKey.set(key, Math.max(lastEventByKey.get(key) ?? 0, atMs));

    switch (type) {
      case "mission-start": {
        const existing = openFor(agent, jobId);
        if (existing) {
          suppressed += 1;
          existing.duplicates_suppressed += 1;
          break;
        }
        const shift = openShift({ agent, job_id: jobId, project: projectOf(event), at, reason: "accept" });
        shifts.push(shift);
        byAgentJob.set(key, shift);
        break;
      }
      case "renewed":
      case "review-wait-recovery":
      case "legacy-adopted": {
        const open = openFor(agent, jobId);
        if (!open) {
          // Genuine new shift after park/close: resume is the normal reason.
          const shift = openShift({ agent, job_id: jobId, project: projectOf(event), at, reason: "resume" });
          shifts.push(shift);
          byAgentJob.set(key, shift);
          break;
        }
        setState(open, "working", at, { reason: str(event.mode) || str(event.reason) || "resumed" });
        break;
      }
      case "handoff-wake":
      case TK_WAKE: {
        const trigger = str(event.comment_id) || str(event.trigger_id);
        const dedupeKey = `${jobId}|wake|${trigger}`;
        const lastTrigger = recentTriggers.get(dedupeKey);
        if (trigger && lastTrigger !== undefined && atMs - lastTrigger < 60_000) {
          suppressed += 1;
          const open = openFor(agent, jobId);
          if (open) open.duplicates_suppressed += 1;
          break;
        }
        if (trigger) recentTriggers.set(dedupeKey, atMs);
        const waker = str(event.from) || str(event.waker) || "unknown";
        const source: ShiftRecord["wake_source"] =
          type === TK_WAKE ? ((str(event.wake_source) as ShiftRecord["wake_source"]) || "unknown") : "studio-handoff";
        const open = openFor(agent, jobId);
        if (!open) {
          const shift = openShift({
            agent,
            job_id: jobId,
            project: projectOf(event),
            at,
            reason: "wake",
            waker,
            ...(trigger ? { wake_trigger: trigger } : {}),
            wake_source: source,
          });
          shifts.push(shift);
          byAgentJob.set(key, shift);
          break;
        }
        open.waker = waker;
        if (trigger) open.wake_trigger = trigger;
        open.wake_source = source;
        setState(open, "working", at, { reason: `woken by ${waker}${trigger ? ` (${trigger})` : ""}` });
        break;
      }
      case "handoff-delivered": {
        // Send request != delivered != resumed: receipt only, no state change.
        const open = openFor(agent, jobId);
        if (open && !open.wake_trigger && str(event.comment_id)) open.wake_trigger = str(event.comment_id);
        break;
      }
      case "handoff-wait": {
        const dependency = `handoff ${str(event.run_id)} ${str(event.role)}${str(event.expected_from) ? ` from ${str(event.expected_from)}` : ""}`.trim();
        const open = openFor(agent, jobId);
        if (!open) {
          const shift = openShift({ agent, job_id: jobId, project: projectOf(event), at, reason: "resume", flag: "inferred-open" });
          setState(shift, "waiting", at, { dependency, reason: "waiting for handoff" });
          shifts.push(shift);
          byAgentJob.set(key, shift);
          break;
        }
        setState(open, "waiting", at, { dependency, reason: "waiting for handoff" });
        break;
      }
      case "review-wait": {
        const pullRequest = str(event.pull_request) || String(num(event.pull_request) ?? "");
        const dependency = `review PR #${pullRequest}`;
        const open = openFor(agent, jobId);
        if (!open) {
          const shift = openShift({ agent, job_id: jobId, project: projectOf(event), at, reason: "resume", flag: "inferred-open" });
          setState(shift, "waiting", at, { dependency, reason: "waiting for review" });
          shifts.push(shift);
          byAgentJob.set(key, shift);
          break;
        }
        setState(open, "waiting", at, { dependency, reason: "waiting for review" });
        break;
      }
      case "needs-human":
      case "stop-loss": {
        const reason = str(event.exact_human_need) || str(event.reason) || type;
        const open = openFor(agent, jobId);
        if (!open) {
          const shift = openShift({ agent, job_id: jobId, project: projectOf(event), at, reason: "resume", flag: "inferred-open" });
          setState(shift, "blocked", at, { reason });
          shifts.push(shift);
          byAgentJob.set(key, shift);
          break;
        }
        setState(open, "blocked", at, { reason });
        break;
      }
      case TK_INTERRUPTION: {
        const open = openFor(agent, jobId);
        if (!open) break;
        const reason = str(event.reason) || "turn errored or aborted";
        setState(open, "unknown", at, { reason });
        open.flags.push(`interruption:${str(event.outcome) || "error"}`);
        break;
      }
      case "complete":
      case "mission-archived": {
        const open = openFor(agent, jobId);
        if (!open) {
          suppressed += 1;
          break;
        }
        closeOpenSegment(open, at);
        open.closed_at = at;
        open.close_reason = type === "complete" ? "complete" : str(event.reason) === "closed by completion" ? "complete" : "superseded";
        open.close_known = true;
        byAgentJob.delete(key);
        break;
      }
      case "mission-parked": {
        const open = openFor(agent, jobId);
        if (!open) {
          suppressed += 1;
          break;
        }
        closeOpenSegment(open, at);
        open.closed_at = at;
        open.close_reason = "park";
        open.close_known = true;
        byAgentJob.delete(key);
        break;
      }
      case "mission-switch": {
        // Closes the named source job; the new job opens via its mission-start.
        const fromId = str(event.from);
        if (fromId) {
          const fromKey = `${agent}|${fromId}`;
          const open = byAgentJob.get(fromKey);
          if (open && !open.closed_at) {
            closeOpenSegment(open, at);
            open.closed_at = at;
            open.close_reason = "park";
            open.close_known = true;
            byAgentJob.delete(fromKey);
          }
        }
        break;
      }
      case "session-shutdown": {
        const open = openFor(agent, jobId);
        if (!open) break;
        closeOpenSegment(open, at);
        open.closed_at = at;
        open.close_reason = "interrupted";
        open.close_known = true;
        open.flags.push("shutdown-without-close");
        byAgentJob.delete(key);
        break;
      }
      case "checkpoint":
      case "continuation": {
        const open = openFor(agent, jobId);
        if (!open) break;
        const milestone = str(event.milestone);
        const next = str(event.next_action) || str(event.next);
        const trackable = open as ShiftRecord & { milestone?: string; next_action?: string };
        if (milestone) trackable.milestone = milestone.slice(0, 160);
        if (next) trackable.next_action = next.slice(0, 200);
        break;
      }
      default:
        break;
    }
  }

  // Stale live shifts: a still-open shift with no event for longer than the
  // staleness window is surfaced as UNKNOWN from its last confirmed contact,
  // never billed as active past that point.
  for (const shift of shifts) {
    if (shift.closed_at) continue;
    const shiftKey = shift.agent + "|" + shift.job_id;
    const lastSeen = Math.max(lastContactMs(shift), lastEventByKey.get(shiftKey) ?? 0);
    if (Number.isFinite(lastSeen) && nowMs - (lastSeen as number) > staleAfterMs) {
      const current = shift.segments[shift.segments.length - 1];
      if (current && !current.to && current.state !== "unknown") {
        // Billed until the contact went stale; the unconfirmed tail is unknown, never active.
        const splitAt = new Date((lastSeen as number) + staleAfterMs).toISOString();
        current.to = splitAt;
        shift.segments.push({ state: "unknown", from: splitAt });
        if (!shift.flags.includes("stale-unconfirmed")) shift.flags.push("stale-unconfirmed");
      }
    }
  }

  // Interval totals: closed segments billed in full; the trailing open
  // segment truncated at now. Unknown is tracked, never billed as active.
  for (const shift of shifts) {
    let working = 0;
    let waiting = 0;
    let blocked = 0;
    let unknown = 0;
    for (const segment of shift.segments) {
      const fromMs = Date.parse(segment.from);
      if (!Number.isFinite(fromMs)) {
        if (!shift.flags.includes("unparseable-timestamp")) shift.flags.push("unparseable-timestamp");
        continue;
      }
      let toMs = segment.to ? Date.parse(segment.to) : nowMs;
      if (!Number.isFinite(toMs)) toMs = nowMs;
      if (toMs < fromMs) {
        if (!shift.flags.includes("clock-skew")) shift.flags.push("clock-skew");
        continue;
      }
      if (segment.state === "working") working += toMs - fromMs;
      else if (segment.state === "waiting") waiting += toMs - fromMs;
      else if (segment.state === "blocked") blocked += toMs - fromMs;
      else unknown += toMs - fromMs;
    }
    shift.working_ms = working;
    shift.waiting_ms = waiting;
    shift.blocked_ms = blocked;
    shift.unknown_ms = unknown;
  }

  const roster = buildRoster(shifts, nowMs, staleAfterMs, lastEventByKey);
  return { shifts, roster, suppressed };
}

/**
 * Last host-confirmed contact: explicit event stamps only. The open-ended
 * now-truncation used for billing must never count as contact, or nothing
 * would ever go stale.
 */
function lastContactMs(shift: ShiftRecord): number {
  let last = Date.parse(shift.opened_at);
  for (const segment of shift.segments) {
    const to = segment.to ? Date.parse(segment.to) : NaN;
    if (Number.isFinite(to) && (to as number) > last) last = to as number;
    const from = Date.parse(segment.from);
    if (Number.isFinite(from) && from > last) last = from;
  }
  return last;
}

function availabilityOf(shift: ShiftRecord, nowMs: number, staleAfterMs: number, lastEventMs?: number): Availability {
  const current = shift.segments[shift.segments.length - 1];
  const state = current?.to ? "unknown" : (current?.state ?? "unknown");
  if (state === "working") {
    const lastSeen = Math.max(lastContactMs(shift), lastEventMs ?? 0);
    if (Number.isFinite(lastSeen) && nowMs - lastSeen > staleAfterMs) return "UNKNOWN";
    return "WORKING";
  }
  if (state === "waiting") return "WAITING";
  if (state === "blocked") return "BLOCKED";
  return "UNKNOWN";
}

function buildRoster(shifts: ShiftRecord[], nowMs: number, staleAfterMs: number, lastEventByKey?: Map<string, number>): AgentRosterEntry[] {
  const latest = new Map<string, ShiftRecord>();
  for (const shift of shifts) {
    const prev = latest.get(shift.agent);
    if (!prev || shift.opened_at >= prev.opened_at) latest.set(shift.agent, shift);
  }
  const entries: AgentRosterEntry[] = [];
  for (const [agent, shift] of [...latest.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const shiftKey = shift.agent + "|" + shift.job_id;
    const contactMs = Math.max(Date.parse(shift.opened_at), lastEventByKey?.get(shiftKey) ?? 0);
    const availability = shift.closed_at ? "CLOCKED_OUT" : availabilityOf(shift, nowMs, staleAfterMs, contactMs);
    const current = shift.segments[shift.segments.length - 1];
    const lastAt = shift.closed_at ?? (Number.isFinite(contactMs) ? new Date(contactMs).toISOString() : (current?.from ?? shift.opened_at));
    const lastMs = Date.parse(lastAt);
    const trackable = shift as ShiftRecord & { milestone?: string; next_action?: string };
    const entry: AgentRosterEntry = {
      agent,
      availability,
      ...(shift.project ? { project: shift.project } : {}),
      job_id: shift.job_id,
      ...(!shift.closed_at ? { shift_id: shift.shift_id } : {}),
      ...(trackable.milestone ? { milestone: trackable.milestone } : {}),
      ...(trackable.next_action ? { next_action: trackable.next_action } : {}),
      ...(!shift.closed_at && current && (current.state === "waiting" || current.state === "blocked")
        ? { dependency: current.dependency ?? current.reason }
        : {}),
      last_event: shift.closed_at ? `shift-close (${shift.close_reason ?? "unknown"})` : `shift-${current?.state ?? "unknown"}`,
      last_event_at: lastAt,
      ...(Number.isFinite(lastMs) ? { last_event_age_ms: Math.max(0, nowMs - lastMs) } : {}),
      stale: Number.isFinite(lastMs) ? nowMs - lastMs > staleAfterMs : true,
      available: availability === "CLOCKED_OUT",
      ...(shift.closed_at && shift.close_reason ? { evidence: `closed ${shift.close_reason}${shift.close_known === false ? " (inferred)" : ""}` } : {}),
    };
    entries.push(entry);
  }
  return entries.slice(0, 50);
}

/* ---------------- UK time ---------------- */

function londonOffsetMs(instantMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  const hour = parts["hour"] === "24" ? 0 : Number(parts["hour"]);
  const asUtc = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), hour, Number(parts["minute"]), Number(parts["second"]));
  return asUtc - instantMs;
}

/**
 * ms of the London-calendar day start containing `instantMs`.
 * Two offset passes converge except exactly on a DST transition; a final
 * calendar check corrects the remainder deterministically.
 */
export function londonDayStartMs(instantMs: number): number {
  // Work in London wall-clock arithmetic: the day start is 00:00 wall, and
  // 00:00 wall is never inside a DST transition (they fall at 01:00/02:00),
  // so two offset passes converge and a bounded calendar check finishes.
  const wall = instantMs + londonOffsetMs(instantMs);
  const dayStartWall = wall - ((((wall % 86_400_000) + 86_400_000) % 86_400_000));
  let guess = dayStartWall - londonOffsetMs(dayStartWall);
  guess = dayStartWall - londonOffsetMs(guess);
  const want = londonDayKey(instantMs);
  let guard = 0;
  while (londonDayKey(guess) !== want && guard < 3) {
    guess += (londonDayKey(guess) < want ? 1 : -1) * 86_400_000;
    guess = guess - londonOffsetMs(guess) + londonOffsetMs(dayStartWall);
    guard += 1;
  }
  return guess;
}

export function londonDayKey(instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instantMs));
}

/** `HH:mm:ss UK`, with `D Mon` prefixed when outside the reference London day. */
export function formatUK(iso: string, referenceMs = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown time";
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
  if (londonDayKey(ms) === londonDayKey(referenceMs)) return `${time} UK`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" }).format(new Date(ms));
  return `${time} UK ${date}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * Split [fromMs, toMs) at London midnights for per-day attribution.
 * Segments spanning more than 15 London days are lumped into their start
 * day and the caller flags them; real segments are minutes to hours.
 */
export function splitByLondonDay(fromMs: number, toMs: number): { day: string; ms: number }[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const out: { day: string; ms: number }[] = [];
  let cursor = fromMs;
  let guard = 0;
  while (cursor < toMs && guard < 16) {
    const startOfDay = londonDayStartMs(cursor);
    let nextMidnight = startOfDay + 86_400_000;
    if (nextMidnight <= cursor) nextMidnight = cursor + 3_600_000;
    const end = Math.min(toMs, nextMidnight);
    if (end <= cursor) break;
    out.push({ day: londonDayKey(cursor), ms: end - cursor });
    cursor = end;
    guard += 1;
  }
  return out;
}

/** Per-agent working/waiting/blocked totals for one London day. */
export function summarizeDay(shifts: ShiftRecord[], dayKey: string, nowMs: number): Record<string, { working_ms: number; waiting_ms: number; blocked_ms: number; unknown_ms: number }> {
  const totals: Record<string, { working_ms: number; waiting_ms: number; blocked_ms: number; unknown_ms: number }> = {};
  const acc = (agent: string) => (totals[agent] ??= { working_ms: 0, waiting_ms: 0, blocked_ms: 0, unknown_ms: 0 });
  for (const shift of shifts) {
    for (const segment of shift.segments) {
      const fromMs = Date.parse(segment.from);
      let toMs = segment.to ? Date.parse(segment.to) : nowMs;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) continue;
      for (const part of splitByLondonDay(fromMs, toMs)) {
        if (part.day !== dayKey) continue;
        const slot = acc(shift.agent);
        if (segment.state === "working") slot.working_ms += part.ms;
        else if (segment.state === "waiting") slot.waiting_ms += part.ms;
        else if (segment.state === "blocked") slot.blocked_ms += part.ms;
        else slot.unknown_ms += part.ms;
      }
    }
  }
  return totals;
}

/* ---------------- rendering (same data for machine and human views) ---------------- */

export function rosterToJson(roster: AgentRosterEntry[], nowMs: number): Record<string, unknown> {
  return {
    schema: TIMEKEEPER_SCHEMA,
    as_of_utc: new Date(nowMs).toISOString(),
    as_of_uk: formatUK(new Date(nowMs).toISOString(), nowMs),
    agents: roster.map((entry) => ({
      agent: entry.agent,
      availability: entry.availability,
      ...(entry.role ? { role: entry.role } : {}),
      ...(entry.project ? { project: entry.project } : {}),
      ...(entry.job_id ? { job_id: entry.job_id } : {}),
      ...(entry.shift_id ? { shift_id: entry.shift_id } : {}),
      ...(entry.milestone ? { milestone: entry.milestone } : {}),
      ...(entry.next_action ? { next_action: entry.next_action } : {}),
      ...(entry.dependency ? { dependency: entry.dependency } : {}),
      ...(entry.last_event ? { last_event: entry.last_event } : {}),
      ...(entry.last_event_at ? { last_event_utc: entry.last_event_at, last_event_uk: formatUK(entry.last_event_at, nowMs) } : {}),
      stale: entry.stale,
      available: entry.available,
      ...(entry.evidence ? { evidence: entry.evidence } : {}),
    })),
  };
}

export function rosterToText(roster: AgentRosterEntry[], nowMs: number): string {
  if (roster.length === 0) return "timekeeper: no shifts recorded yet.";
  const lines = [`timekeeper roster · ${formatUK(new Date(nowMs).toISOString(), nowMs)} (${roster.length} agent${roster.length === 1 ? "" : "s"})`];
  for (const entry of roster) {
    const what = [entry.job_id, entry.milestone || entry.next_action].filter(Boolean).join(" · ");
    const dep = entry.dependency ? ` · waiting on ${entry.dependency}` : "";
    const age = entry.last_event_age_ms !== undefined ? ` · seen ${formatDuration(entry.last_event_age_ms)} ago` : "";
    lines.push(`- ${entry.agent}: ${entry.availability}${entry.stale ? " (STALE)" : ""}${what ? ` · ${what}` : ""}${dep}${age}${entry.available ? " · AVAILABLE" : ""}`);
  }
  return lines.join("\n");
}
