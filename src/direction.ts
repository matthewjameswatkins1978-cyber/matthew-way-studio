/**
 * Human direction: an authorised change of what the mission should do next.
 *
 * Deterministic and pure. Pi already understands Matthew's ordinary language —
 * "I've changed my mind, do this instead", "pause this until I tell you
 * otherwise" — so this module is deliberately NOT a phrase detector. It is the
 * safe mechanism the model uses to express a direction it has already
 * understood, and it enforces the parts a model must never decide:
 *
 *   - the quoted words must appear verbatim in Matthew's own current message
 *     (the caller verifies that the turn is user-originated first);
 *   - text that is itself a question, or is wrapped in quotation marks inside
 *     the message, is not a direction;
 *   - a direction never destroys evidence, history, constraints, authority,
 *     acceptance or rules, and never fabricates reviewer approval;
 *   - the newest direction supersedes older plans; older directions are kept.
 *
 * The provenance half of the contract (origin === "user" for this turn) lives
 * in `extensions/index.ts`, because only the Pi lifecycle can observe it.
 */

import { applyReviewWaitRecovery } from "./mission.js";
import {
  DIRECTION_MODES,
  MAX_DIRECTION_TEXT,
  MAX_DIRECTIONS,
  applyTransition,
  terminalStatus,
  type DirectionMode,
  type HumanDirection,
  type JobState,
} from "./schema.js";

/** Shortest quote that can carry a direction (e.g. "redo it"). */
export const MIN_DIRECTION_TEXT = 6;

export interface DirectionCheck {
  ok: boolean;
  reason: string;
}

const QUOTE_CHARS = new Set(['"', "'", "\u2018", "\u2019", "\u201C", "\u201D", "\u00AB", "\u00BB"]);

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive literal search that returns usable indices. */
function findQuoted(prompt: string, direction: string): { index: number; hay: string } | undefined {
  const pattern = new RegExp(escapeRegex(direction), "i");
  const direct = pattern.exec(prompt);
  if (direct) return { index: direct.index, hay: prompt };
  // CRLF prompts are the same message; match against a normalised copy.
  const normalized = prompt.replace(/\r\n/g, "\n");
  const alt = pattern.exec(normalized);
  if (alt) return { index: alt.index, hay: normalized };
  return undefined;
}

/**
 * Provenance check for one quoted direction against the exact text of
 * Matthew's current message. Fail-closed: every refusal explains how to
 * produce a recordable direction.
 */
export function validateDirectionQuote(prompt: string, direction: string): DirectionCheck {
  const hay = prompt ?? "";
  const needle = (direction ?? "").trim();
  if (!hay.trim()) return { ok: false, reason: "there is no current human message to quote" };
  if (!needle) return { ok: false, reason: "a direction needs Matthew's own words, quoted from his current message" };
  if (needle.length < MIN_DIRECTION_TEXT) {
    return { ok: false, reason: `the quote is too short to be a direction (at least ${MIN_DIRECTION_TEXT} characters of Matthew's words)` };
  }
  if (needle.length > MAX_DIRECTION_TEXT) {
    return { ok: false, reason: `the quote is longer than ${MAX_DIRECTION_TEXT} characters; quote the direction itself, not the whole message` };
  }
  if (/\?\s*$/.test(needle)) {
    return { ok: false, reason: "a question cannot steer the mission; record a direction only when Matthew states one" };
  }
  if (QUOTE_CHARS.has(needle[0] ?? "") && QUOTE_CHARS.has(needle[needle.length - 1] ?? "")) {
    return { ok: false, reason: "strip the quotation marks: text quoted inside a message is not a direction" };
  }
  const hit = findQuoted(hay, needle);
  if (!hit) {
    return { ok: false, reason: "the direction must appear verbatim in Matthew's current message — copy his exact words, including his punctuation" };
  }
  const before = hit.hay[hit.index - 1] ?? "";
  const after = hit.hay[hit.index + needle.length] ?? "";
  if (QUOTE_CHARS.has(before) && QUOTE_CHARS.has(after)) {
    return { ok: false, reason: "the quoted words are enclosed in quotation marks inside Matthew's message; a quotation he cites is not a direction" };
  }
  return { ok: true, reason: "verbatim words from Matthew's current message" };
}

export interface DirectionInput {
  mode: DirectionMode;
  /** Verbatim words already validated against Matthew's current message. */
  text: string;
  /** redirect only: the first concrete action under the new direction. */
  next_action?: string;
  now?: string;
}

/**
 * Record one authorised direction and apply its deterministic effect.
 *
 * History is additive: evidence, commits, checks, reconciliations, contract,
 * constraints and the pinned rules are never rewritten, and older directions
 * stay on the record so the newest one wins without erasing what came before.
 */
export function applyDirection(job: JobState, input: DirectionInput): JobState {
  if (!DIRECTION_MODES.includes(input.mode)) throw new Error(`unknown direction mode: ${String(input.mode)}`);
  const text = input.text.trim();
  if (text.length < MIN_DIRECTION_TEXT) throw new Error(`a direction needs at least ${MIN_DIRECTION_TEXT} characters of Matthew's own words`);
  if (text.length > MAX_DIRECTION_TEXT) throw new Error(`a direction is at most ${MAX_DIRECTION_TEXT} characters; quote the direction itself`);
  if (/\?\s*$/.test(text)) throw new Error("a question cannot steer the mission");
  if (terminalStatus(job.status)) {
    throw new Error(`the mission is already closed as ${job.status}; steering never reopens a closed mission — submit a fresh packet or say "resume the mission"`);
  }

  const now = input.now ?? new Date().toISOString();
  const from = job.status;
  const mode = input.mode;
  let next: JobState;
  let note: string;

  if (mode === "pause") {
    // Pause only ever touches continuation: it never changes status, never
    // resolves a block, and never releases or fabricates a review decision.
    next = {
      ...job,
      continuation: { ...job.continuation, allowed: false, reason: `paused by Matthew: ${text.slice(0, 120)}` },
      updated_at: now,
    };
    note =
      from === "WAITING_REVIEW"
        ? "pause recorded; the review wait is retained and no reviewer decision was made"
        : from === "NEEDS_HUMAN"
          ? "pause recorded; the recorded block is retained until Matthew directs otherwise"
          : "automatic continuation stopped at the next safe boundary";
  } else if (from === "WAITING_REVIEW") {
    // Releasing a wait on Matthew's authority is a human override. It never
    // acknowledges a review delivery and never records approval.
    const released = applyReviewWaitRecovery(job, { mode: "resume", reason: text, now });
    next = {
      ...released,
      // The direction supersedes the wait: the released target becomes history,
      // so a later head move can never make the ledger unreadable and a stale
      // delivery can never be acknowledged against a redirected mission.
      review_wait: undefined,
      continuation: {
        ...released.continuation,
        allowed: true,
        runs: 0,
        unchanged_streak: 0,
        error_streak: 0,
        reason:
          mode === "redirect"
            ? "renewed by Matthew's direction; review wait released as human override — not reviewer approval"
            : "renewed by Matthew; review wait released as human override — not reviewer approval",
      },
      progress:
        mode === "redirect"
          ? { ...released.progress, next_action: input.next_action?.trim() || text.slice(0, 300) }
          : { ...released.progress, next_action: job.progress.next_action || text.slice(0, 300) },
      updated_at: now,
    };
    note = "review wait released by Matthew's direction; human override only — never reviewer approval, never permission to merge";
  } else if (from === "NEEDS_HUMAN") {
    // A verified human direction is a legal NEEDS_HUMAN -> WORKING edge, on
    // the same footing as the review-wait recovery: authorised by provenance,
    // not by narration, and it records no acceptance confirmations.
    next = {
      ...applyTransition(job, "WORKING"),
      blocker: undefined,
      continuation: { ...job.continuation, allowed: true, runs: 0, unchanged_streak: 0, error_streak: 0, reason: `directed by Matthew (${mode})` },
      progress:
        mode === "redirect"
          ? { ...job.progress, next_action: input.next_action?.trim() || text.slice(0, 300) }
          : job.progress,
      updated_at: now,
    };
    note = "human-owned block superseded by Matthew's newest direction";
  } else {
    next = {
      ...job,
      continuation: {
        ...job.continuation,
        allowed: true,
        runs: 0,
        unchanged_streak: 0,
        error_streak: 0,
        reason: `directed by Matthew (${mode})`,
      },
      progress:
        mode === "redirect"
          ? { ...job.progress, next_action: input.next_action?.trim() || text.slice(0, 300) }
          : job.progress,
      updated_at: now,
    };
    note = mode === "redirect" ? "older plan superseded by Matthew's newest direction; constraints, authority, acceptance and rules still bind" : "continuation re-armed by Matthew";
  }

  const record: HumanDirection = { at: now, mode, text, from_status: from, note };
  return { ...next, directions: [...(job.directions ?? []), record].slice(-MAX_DIRECTIONS), updated_at: now };
}

/** Newest authorised direction, the one that governs. */
export function latestDirection(job: JobState): HumanDirection | undefined {
  return job.directions[job.directions.length - 1];
}
