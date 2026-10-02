/**
 * Autonomous continuation policy.
 *
 * Pure decision function: given the durable job and what happened since the
 * last boundary, decide whether Pi should take another turn automatically,
 * stop and hand a NEEDS_HUMAN packet to Matthew, or settle.
 *
 * Borrowed from pi-goal-x (MIT, © tmonk): durable goal state, automatic
 * continuation, run allowance and a blocked state. Deliberately not borrowed:
 * its command surface, scheduler phases, token budgets, dashboards and auditor
 * machinery. Matthew types a packet, not `/goal`.
 */

import { progressSignature, terminalStatus, type JobContinuation, type JobState } from "./schema.js";

export interface ContinuationLimits {
  /** Hard ceiling on automatic turns for one mission. */
  maxTurns: number;
  /** Consecutive turns with no progress signature change before we stop guessing. */
  maxUnchangedTurns: number;
  /** Consecutive provider/agent errors before we stop. */
  maxErrorStreak: number;
}

export const DEFAULT_LIMITS: ContinuationLimits = {
  maxTurns: 60,
  maxUnchangedTurns: 3,
  maxErrorStreak: 3,
};

export type ContinueDecision =
  | { action: "continue"; instruction: string; continuation: JobContinuation }
  | { action: "settle"; reason: string; continuation: JobContinuation }
  | { action: "stall"; reason: string; continuation: JobContinuation };

export interface ObserveInput {
  /** The turn just finished without an error and without needing Matthew. */
  turnCompleted: boolean;
  /** The turn ended because the provider/agent errored. */
  errored: boolean;
  /** The user interrupted; never continue over an abort. */
  aborted: boolean;
}

/**
 * Fold one finished turn into the continuation counters and decide what happens
 * next. The signature is computed from the *current* job, so callers must
 * checkpoint evidence and progress before calling.
 */
export function decideContinuation(job: JobState, input: ObserveInput, limits: ContinuationLimits = DEFAULT_LIMITS): ContinueDecision {
  const previous: JobContinuation = { ...job.continuation };
  const next: JobContinuation = { ...previous, reason: "" };

  if (terminalStatus(job.status)) {
    next.allowed = false;
    next.reason = `mission is ${job.status}`;
    return { action: "settle", reason: next.reason, continuation: next };
  }

  if (job.status === "NEEDS_HUMAN") {
    next.allowed = false;
    next.reason = "waiting for a human-only dependency";
    return { action: "settle", reason: next.reason, continuation: next };
  }

  if (input.aborted) {
    next.allowed = false;
    next.reason = "user interrupted this run";
    return { action: "settle", reason: next.reason, continuation: next };
  }

  if (input.errored) {
    next.error_streak = previous.error_streak + 1;
  }

  const signature = progressSignature(job);
  const progressed = signature !== previous.last_signature;
  if (input.errored) {
    // An error turn did not make progress; keep the streak of non-progress too.
    next.unchanged_streak = progressed ? 0 : previous.unchanged_streak + 1;
  } else if (input.turnCompleted) {
    next.unchanged_streak = progressed ? 0 : previous.unchanged_streak + 1;
    next.error_streak = 0;
  }
  next.last_signature = signature;
  next.runs = previous.runs + 1;

  if (next.error_streak >= limits.maxErrorStreak) {
    next.allowed = false;
    next.reason = `${next.error_streak} consecutive failed turns on the same problem`;
    return { action: "stall", reason: next.reason, continuation: next };
  }

  if (next.unchanged_streak >= limits.maxUnchangedTurns) {
    next.allowed = false;
    next.reason = `${next.unchanged_streak} turns without measurable progress`;
    return { action: "stall", reason: next.reason, continuation: next };
  }

  if (next.runs > limits.maxTurns) {
    next.allowed = false;
    next.reason = `run allowance exhausted (${limits.maxTurns} automatic turns)`;
    return { action: "stall", reason: next.reason, continuation: next };
  }

  next.allowed = true;
  const instruction = buildContinuationInstruction(job, next, progressed);
  next.reason = progressed ? "progress observed" : "continuing without measurable progress";
  return { action: "continue", instruction, continuation: next };
}

function buildContinuationInstruction(job: JobState, cont: JobContinuation, progressed: boolean): string {
  const lines = [
    `STUDIO CONTINUATION (${job.job_id}, automatic turn ${cont.runs}).`,
    progressed ? "Previous turn made measurable progress. Keep going." : "Previous turn changed nothing measurable. Do not repeat the same action: change approach, or record a checkpoint, or declare NEEDS_HUMAN.",
    `OBJECTIVE: ${job.objective}`,
  ];
  if (job.progress.milestone) lines.push(`CURRENT MILESTONE: ${job.progress.milestone}`);
  if (job.progress.next_action) lines.push(`NEXT ACTION: ${job.progress.next_action}`);
  if (job.acceptance.length) lines.push(`ACCEPTANCE STILL OPEN: ${remainingAcceptance(job).join(" | ") || "verify each acceptance item against the repository"}`);
  lines.push("Work the next action now. No summary-only turn. Use studio_checkpoint when state changes, studio_complete when acceptance is met, studio_blocked only for a genuinely human-only dependency.");
  return lines.join("\n");
}

function remainingAcceptance(job: JobState): string[] {
  const passed = new Set(job.evidence.checks.filter((c) => c.status === "pass").map((c) => c.name));
  if (passed.size === 0) return [];
  return job.acceptance.filter((a) => ![...passed].some((name) => a.toLowerCase().includes(name.toLowerCase())));
}
