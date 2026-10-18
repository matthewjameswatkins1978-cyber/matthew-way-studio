/**
 * Mission lifecycle: intake, checkpoint, block, natural resume, complete.
 *
 * These functions own every status transition so the Pi-facing tools stay thin
 * and the whole state machine is testable without a running agent.
 */

import { randomUUID } from "node:crypto";
import {
  SCHEMA_VERSION,
  applyTransition,
  canTransition,
  terminalStatus,
  type BlockerKind,
  type CheckEvidence,
  type JobState,
} from "./schema.js";
import { makeJobId, savePacket } from "./ledger.js";
import type { LedgerLocation } from "./paths.js";
import { compilePacket, parseSections, type ParsedSection } from "./packet.js";
import type { RepoFacts } from "./git.js";
import { currentRuleSnapshot } from "./rules.js";

export interface BlockerInput {
  kind: BlockerKind;
  reason: string;
  exact_human_need: string;
  resume_condition: string;
  state_preserved?: string;
}

export function blockerSignature(input: BlockerInput): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 200);
  return `${input.kind}::${norm(input.exact_human_need)}::${norm(input.resume_condition)}`;
}

const DIRECT_HUMAN_KINDS = new Set<BlockerKind>([
  "credential",
  "authentication",
  "access",
  "account-action",
  "physical-interaction",
  "judgement",
  "irreversible-choice",
  "external-approval",
]);

/**
 * Cheap deterministic friction gate. Ambiguous blockers must show that Studio
 * already tried to reconcile/verify/re-route before spending Matthew's
 * attention. Explicitly human-owned capabilities remain direct.
 */
export function assessBlockerAdmission(
  kind: BlockerKind,
  recoveryAttempts: readonly string[] = [],
): { ok: boolean; reason: string } {
  if (DIRECT_HUMAN_KINDS.has(kind)) return { ok: true, reason: "human-owned capability" };
  const attempts = recoveryAttempts.map((a) => a.trim()).filter(Boolean);
  if (attempts.length === 0) {
    return {
      ok: false,
      reason:
        "this blocker is not inherently human-only; first infer safely, check live authoritative state, repair the crossed wire, or try a materially different valid route",
    };
  }
  return { ok: true, reason: `recovery evidence recorded (${attempts.length} attempt${attempts.length === 1 ? "" : "s"})` };
}

/** Deterministic next action when a packet does not name one. */
export function initialNextAction(packet: string, sections: ParsedSection[]): string {
  const plan = sections.find((s) => s.heading === "IMPLEMENTATION ORDER" || s.heading === "PLAN" || s.heading.startsWith("FIRST"));
  const first = plan?.lines.map((l) => l.trim()).find((l) => l && /^(\d+[.)]|[-*])/.test(l));
  if (first) return first.replace(/^(\d+[.)]|[-*])\s*/, "").slice(0, 300);
  const numbered = packet
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+[.)]\s+\S/.test(l));
  if (numbered) return numbered.replace(/^\d+[.)]\s+/, "").slice(0, 300);
  return "Inspect repository truth, then work the first concrete deliverable in the packet.";
}

export function startMission(input: {
  packet: string;
  location: LedgerLocation;
  facts: RepoFacts;
  now?: string;
}): JobState {
  const contract = compilePacket(input.packet);
  const sections = parseSections(input.packet);
  const nonce = randomUUID().slice(0, 8);
  const jobId = makeJobId(`${input.facts.root}:${input.facts.branch}:${input.facts.head_sha}:${contract.objective}:${input.location.workerId ?? "legacy"}:${nonce}`);
  const packetMeta = savePacket(input.location, jobId, input.packet);
  return {
    schema_version: SCHEMA_VERSION,
    job_id: jobId,
    ...(input.location.workerId ? { worker_session_id: input.location.workerId } : {}),
    status: "WORKING",
    ...contract,
    repo: {
      root: input.facts.root,
      remote: input.facts.remote,
      branch: input.facts.branch,
      base_sha: input.facts.head_sha,
      current_sha: input.facts.head_sha,
      dirty_at_start: input.facts.dirty,
    },
    progress: {
      milestone: "",
      next_action: initialNextAction(input.packet, sections),
      attempts: 0,
      child_work: "",
      reconciliations: [],
    },
    evidence: { checks: [], commits: [], pushed_shas: [], artifacts: [], human_confirmed: [] },
    memory: { lantern: "not-needed", lantern_refs: [], decisions_loaded: [] },
    human_dogfood: { status: "none", checks: [] },
    continuation: { allowed: true, runs: 0, unchanged_streak: 0, error_streak: 0, recoveries: 0, last_signature: "", reason: "mission seeded" },
    rules: currentRuleSnapshot(),
    packet: packetMeta,
    created_at: input.now ?? new Date().toISOString(),
    updated_at: input.now ?? new Date().toISOString(),
  };
}

export interface ReviewWaitInput {
  repository: string;
  pull_request: number;
  url: string;
  branch: string;
  head_sha: string;
  worker_session_id: string;
  requested_review: "general" | "approval" | "correction";
  requested_at?: string;
}

/** Enter a durable reviewer wait only when every identity matches this job. */
export function applyReviewWait(job: JobState, input: ReviewWaitInput): JobState {
  if (job.status === "WAITING_REVIEW") {
    const current = job.review_wait;
    if (current && current.repository === input.repository && current.pull_request === input.pull_request && current.head_sha.toLowerCase() === input.head_sha.toLowerCase() && current.worker_session_id === input.worker_session_id) return job;
    throw new Error("a different reviewer wait is already active for this mission");
  }
  if (job.status !== "WORKING") throw new Error(`cannot wait for review while mission is ${job.status}`);
  if (!input.repository || !input.pull_request || !input.url || !input.branch || !input.worker_session_id) throw new Error("review target is missing repository, PR, branch or worker identity");
  if (job.repo.branch !== input.branch || job.repo.current_sha.toLowerCase() !== input.head_sha.toLowerCase()) throw new Error("review branch or head SHA does not match the mission's current repository state");
  if (input.head_sha !== input.head_sha.toLowerCase() || !/^[0-9a-f]{40}$/.test(input.head_sha)) throw new Error("review head SHA must be a canonical 40-character lowercase SHA");
  const now = input.requested_at ?? new Date().toISOString();
  const transitioned = applyTransition(job, "WAITING_REVIEW");
  return {
    ...transitioned,
    status: "WAITING_REVIEW",
    review_wait: { ...input, job_id: job.job_id, requested_at: now },
    blocker: undefined,
    continuation: { ...job.continuation, allowed: false, reason: "waiting for reviewer decision" },
    updated_at: now,
  };
}
/**
 * Genuine human recovery from a review wait whose channel is dead: no valid
 * review can be delivered (offline reviewer, lost envelope, forged noise).
 * Only a user-originated turn may invoke this (the extension gates on
 * messageType === "user"); it is recorded as a human override, never as
 * reviewer approval, and it grants no merge authority.
 */
export function applyReviewWaitRecovery(
  job: JobState,
  input: { mode: "resume" | "park"; reason: string; now?: string },
): JobState {
  if (job.status !== "WAITING_REVIEW" || !job.review_wait) throw new Error("no review wait to recover from");
  if (!input.reason.trim()) throw new Error("recovery needs an explicit human reason");
  const now = input.now ?? new Date().toISOString();
  if (input.mode === "park") {
    const parked = applyBlock(job, {
      kind: "external-approval",
      reason: `review wait abandoned by Matthew: ${input.reason.trim()}`,
      exact_human_need: input.reason.trim(),
      resume_condition: "Matthew states the next action for this mission.",
    });
    return { ...parked, updated_at: now };
  }
  const resumed = applyTransition(job, "WORKING");
  return {
    ...resumed,
    continuation: { ...job.continuation, allowed: true, runs: 0, unchanged_streak: 0, error_streak: 0, recoveries: 0, reason: "human review-wait recovery; not reviewer approval" },
    progress: { ...job.progress, next_action: input.reason.trim().slice(0, 300) },
    updated_at: now,
  };
}

export interface CheckpointInput {
  milestone?: string;
  next_action?: string;
  attempts?: number;
  child_work?: string;
  /**
   * Accepted for forward compatibility and IGNORED: no verified human-turn
   * boundary exists in-process, so confirmations are never recorded and can
   * never cover acceptance items. The tool layer refuses this input loudly.

   */
  human_confirmed?: number[];
  /** Small corrected assumption/crossed wire. Preserved without rewriting mission history. */
  reconciliation?: string;
  checks?: { name: string; status: "pass" | "fail" | "skip"; detail?: string; accepts?: number[] }[];
  commits?: string[];
  pushed_shas?: string[];
  artifacts?: string[];
  head_sha?: string;
  branch?: string;
  lantern?: "used" | "not-needed" | "unavailable";
  lantern_refs?: string[];
  decisions_loaded?: string[];
}

function mergeChecks(existing: CheckEvidence[], incoming: CheckpointInput["checks"]): CheckEvidence[] {
  if (!incoming?.length) return existing;
  const byName = new Map(existing.map((c) => [c.name, c]));
  const at = new Date().toISOString();
  for (const check of incoming) {
    byName.set(check.name, { name: check.name, status: check.status, detail: check.detail, at, accepts: check.accepts });
  }
  // Keep the ledger compact: newest result per named check, capped.
  return [...byName.values()].slice(-40);
}

function uniqueCap(existing: string[], incoming: string[] | undefined, cap: number): string[] {
  if (!incoming?.length) return existing;
  return [...new Set([...existing, ...incoming])].slice(-cap);
}

function appendReconciliation(
  existing: JobState["progress"]["reconciliations"],
  note: string | undefined,
): JobState["progress"]["reconciliations"] {
  const clean = note?.trim();
  if (!clean) return existing;
  const previous = existing[existing.length - 1]?.note;
  if (previous === clean) return existing;
  return [...existing, { at: new Date().toISOString(), note: clean }].slice(-20);
}

/**
 * Record observable progress. This is the only sanctioned way to move a blocked
 * mission back to WORKING from inside a turn, so `NEEDS_HUMAN -> WORKING` stays
 * a real, tested edge.
 */
export function applyCheckpoint(job: JobState, input: CheckpointInput, opts: { resumeEdge?: boolean } = {}): JobState {
  const next: JobState = {
    ...job,
    progress: {
      milestone: input.milestone?.trim() || job.progress.milestone,
      next_action: input.next_action?.trim() || job.progress.next_action,
      attempts: typeof input.attempts === "number" ? Math.max(0, Math.trunc(input.attempts)) : job.progress.attempts + 1,
      child_work: input.child_work?.trim() || job.progress.child_work,
      reconciliations: appendReconciliation(job.progress.reconciliations, input.reconciliation),
    },
    evidence: {
      checks: mergeChecks(job.evidence.checks, input.checks),
      commits: uniqueCap(job.evidence.commits, input.commits, 60),
      pushed_shas: uniqueCap(job.evidence.pushed_shas, input.pushed_shas, 60),
      artifacts: uniqueCap(job.evidence.artifacts, input.artifacts, 40),
      human_confirmed: job.evidence.human_confirmed,
    },
    memory: {
      lantern: input.lantern ?? job.memory.lantern,
      lantern_refs: uniqueCap(job.memory.lantern_refs, input.lantern_refs, 40),
      decisions_loaded: uniqueCap(job.memory.decisions_loaded, input.decisions_loaded, 40),
    },
    repo: {
      ...job.repo,
      current_sha: input.head_sha?.trim() || job.repo.current_sha,
      branch: input.branch?.trim() || job.repo.branch,
    },
    updated_at: new Date().toISOString(),
  };

  if (job.status === "NEEDS_HUMAN") {
    // A stop-loss summary, an automatic turn or a failed completion must not
    // resurrect a blocked mission: the resume edge only opens when a human
    // message arrived after the block was recorded (resumeEdge from the
    // extension's turn tracking). Evidence still records.
    if (opts.resumeEdge === false) {
      next.continuation = { ...next.continuation, allowed: false, reason: "NEEDS_HUMAN; awaiting a human reply to the recorded need" };
      return next;
    }
    // A checkpoint is the sanctioned resume edge: Pi rechecked the capability
    // and it held. Terminal missions are never reopened by a checkpoint -
    // only a fresh packet or an explicit "resume the mission" reopens those.
    const transitioned = applyTransition(job, "WORKING");
    next.status = transitioned.status;
    next.continuation = { ...next.continuation, runs: 0, unchanged_streak: 0, error_streak: 0, recoveries: 0, allowed: true, reason: "resumed by checkpoint" };
    next.blocker = undefined;
    next.human_dogfood = job.human_dogfood.status === "pending" ? { status: "done", checks: job.human_dogfood.checks } : job.human_dogfood;
    // Human confirmations are NEVER recorded: no observable human-turn
    // boundary exists in-process. A checkpoint runs inside the agent turn,
    // so NEEDS_HUMAN status alone cannot prove a human replied between the
    // block and this call. Claimed confirmations are dropped, which keeps
    // human-gated acceptance items uncovered and forces PARTIAL. (The input
    // field is accepted for forward compatibility; the tool layer refuses it
    // loudly so callers learn the boundary immediately.)
    // (human_confirmed input intentionally unused — see above.)
  } else if (terminalStatus(job.status)) {
    // Recording evidence against a closed mission is allowed; reopening is not.
    next.continuation = { ...next.continuation, allowed: false };
  }
  return next;
}

/** Enter the resumable blocked state, preserving everything useful. */
export function applyBlock(job: JobState, input: BlockerInput): JobState {
  const signature = blockerSignature(input);
  const repeated = job.blocker?.signature === signature ? (job.blocker?.times_raised ?? 1) + 1 : 1;
  const transitioned = applyTransition(job, "NEEDS_HUMAN");
  const next: JobState = {
    ...transitioned,
    blocker: {
      kind: input.kind,
      reason: input.reason.trim(),
      exact_human_need: input.exact_human_need.trim(),
      state_preserved:
        (input.state_preserved ?? "").trim() ||
        `Branch ${job.repo.branch} at ${job.repo.current_sha || "unknown SHA"}; packet and evidence retained in the project ledger.`,
      resume_condition: input.resume_condition.trim(),
      signature,
      times_raised: repeated,
    },
    continuation: { ...job.continuation, allowed: false, reason: "NEEDS_HUMAN" },
    progress: { ...job.progress, attempts: job.progress.attempts + 1 },
  };
  return next;
}

/**
 * A refused or failed studio_complete must not restart completed engineering
 * work. The loop is held until Matthew re-authorises it, or the agent fixes a
 * pure evidence gap inside its current turn.
 */
export function applyCompletionRefused(job: JobState, problems: readonly string[]): JobState {
  const detail = problems.slice(0, 3).join("; ");
  return {
    ...job,
    continuation: { ...job.continuation, allowed: false, reason: `studio_complete refused: ${detail || "evidence gate"}` },
    progress: {
      ...job.progress,
      next_action: `Reconcile the refused completion evidence (${detail || "see studio_complete output"}); do not redo completed engineering work.`,
      attempts: job.progress.attempts + 1,
    },
    updated_at: new Date().toISOString(),
  };
}

export interface CompleteInput {
  outcome: "COMPLETE" | "PARTIAL" | "FAILED";
  summary: string;
  head_sha?: string;
  branch?: string;
  remote?: string;
  pushed_sha?: string;
  push_verified?: boolean;
  dogfood?: string[];
}

/**
 * Completion gate. A mission is only COMPLETE when every acceptance item has
 * recorded evidence, or the outstanding items are explicitly human dogfood.
 * Deterministic: the model cannot narrate its way past an unverified push.
 */
export function evaluateCompletion(
  job: JobState,
  input: CompleteInput,
  opts: { dirty?: boolean } = {},
): { ok: boolean; problems: string[]; reaffirm: boolean } {
  const problems: string[] = [];
  const reaffirm = terminalStatus(job.status) && job.status === input.outcome && job.result?.summary === input.summary.trim();
  if (terminalStatus(job.status) && !reaffirm) {
    // Re-declaring a different outcome over a terminal mission needs a resume first.
    problems.push(`mission already recorded as ${job.status}; resume with a checkpoint or a new packet first`);
  }
  if (input.outcome === "COMPLETE") {
    if (job.evidence.checks.length === 0) problems.push("no machine evidence recorded (at least one check is required)");
    // Positive binding: every acceptance item needs a passing check that
    // names its index. Agent-supplied dogfood citations never cover, and no
    // in-process confirmation counts as a human check: a confirmation claim
    // is not a human-check PASS. Items only a human can verify leave
    // COMPLETE for PARTIAL (or NEEDS_HUMAN first).

    if (job.acceptance.length > 0) {
      const covered = new Set<number>();
      for (const check of job.evidence.checks) {
        if (check.status !== "pass") continue;
        for (const index of check.accepts ?? []) covered.add(index);
      }
      // Human confirmations never cover acceptance items: none are recorded
      // (see applyCheckpoint), so items only a human can verify stay
      // uncovered and refuse COMPLETE for PARTIAL/NEEDS_HUMAN.
      const missing = job.acceptance.map((_, i) => i + 1).filter((i) => !covered.has(i));
      if (missing.length > 0) {
        problems.push(
          `acceptance items without passing evidence: ${missing.map((i) => `#${i} "${job.acceptance[i - 1]?.slice(0, 80) ?? ""}"`).join("; ")} — record checks with accepts:[n], close as PARTIAL/NEEDS_HUMAN when only a human can verify (no in-process confirmation is honored)`,
        );
      }
    }
    // Push binding: the final revision itself must be on the remote. A stale
    // pushed_sha (or verify_push=false over stale evidence) can never pass.
    const head = (input.head_sha?.trim() || job.repo.current_sha).toLowerCase();
    if (!head) {
      problems.push("no recorded revision for the completed work");
    } else {
      const recorded = job.evidence.pushed_shas.map((s) => s.toLowerCase());
      const pushedInput = input.pushed_sha?.trim().toLowerCase() || "";
      if (pushedInput && pushedInput !== head) {
        problems.push(`pushed SHA ${input.pushed_sha?.trim().slice(0, 10)} does not match final revision ${head.slice(0, 10)}`);
      }
      if (input.push_verified === true) {
        // A fresh remote check confirms the revision right now; the
        // pushed-vs-head binding above already rules out stale SHAs.
      } else if (input.push_verified === false) {
        problems.push("remote re-check failed: the final revision is not confirmed on the remote — ship again or reconcile before COMPLETE");
      } else if (!recorded.includes(head)) {
        problems.push("push not verified: run studio_ship (which verifies) or re-check the remote SHA for the final revision");
      }
    }
    if (opts.dirty) problems.push("worktree is dirty: commit or reconcile the unexpected changes before COMPLETE");
    const failed = job.evidence.checks.filter((c) => c.status === "fail");
    if (failed.length > 0) problems.push(`failing checks: ${failed.map((c) => `${c.name}(${c.detail ?? "no detail"})`).join(", ")}`);
  }
  if (!input.summary.trim()) problems.push("summary is required");
  return { ok: problems.length === 0, problems, reaffirm };
}

export function applyComplete(job: JobState, input: CompleteInput, receipt: string): JobState {
  const transitioned = applyTransition(job, input.outcome);
  return {
    ...transitioned,
    repo: {
      ...job.repo,
      current_sha: input.head_sha?.trim() || job.repo.current_sha,
      branch: input.branch?.trim() || job.repo.branch,
      remote: input.remote?.trim() || job.repo.remote,
    },
    evidence: {
      ...job.evidence,
      pushed_shas: uniqueCap(job.evidence.pushed_shas, input.pushed_sha ? [input.pushed_sha] : [], 60),
    },
    human_dogfood: {
      status: input.dogfood?.length ? "pending" : job.human_dogfood.status,
      checks: input.dogfood?.length ? input.dogfood : job.human_dogfood.checks,
    },
    continuation: { ...job.continuation, allowed: false, reason: `mission ${input.outcome}` },
    progress: { ...job.progress, next_action: input.dogfood?.length ? "Human dogfood check" : "", attempts: job.progress.attempts + 1 },
    result: { outcome: input.outcome, summary: input.summary.trim(), receipt },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Record how contextual memory actually featured in this mission. Kept separate
 * from checkpoints so retrieval can be logged even when nothing else changed.
 */
export function applyMemory(
  job: JobState,
  input: { lantern?: "used" | "not-needed" | "unavailable"; refs?: string[]; decisions?: string[] },
): JobState {
  return {
    ...job,
    memory: {
      lantern: input.lantern ?? job.memory.lantern,
      lantern_refs: uniqueCap(job.memory.lantern_refs, input.refs, 40),
      decisions_loaded: uniqueCap(job.memory.decisions_loaded, input.decisions, 40),
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Natural resume reconciliation. Matthew replies normally; Pi rechecks the
 * actual capability instead of trusting the wording.
 */
export function resumeCandidate(job: JobState, reply: string): { accept: boolean; note: string } {
  if (job.status !== "NEEDS_HUMAN") return { accept: false, note: "no blocked mission" };
  const trimmed = reply.trim();
  if (!trimmed) return { accept: false, note: "empty reply" };
  return {
    accept: true,
    note: `Rechecking blocker "${job.blocker?.exact_human_need ?? "unknown"}" against the environment before continuing.`,
  };
}
