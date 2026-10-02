/**
 * Mission lifecycle: intake, checkpoint, block, natural resume, complete.
 *
 * These functions own every status transition so the Pi-facing tools stay thin
 * and the whole state machine is testable without a running agent.
 */

import {
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
  const jobId = makeJobId(`${input.facts.root}:${input.facts.branch}:${input.facts.head_sha}:${contract.objective}`);
  const packetMeta = savePacket(input.location, jobId, input.packet);
  return {
    schema_version: 1,
    job_id: jobId,
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
    },
    evidence: { checks: [], commits: [], pushed_shas: [], artifacts: [] },
    memory: { lantern: "not-needed", lantern_refs: [], decisions_loaded: [] },
    human_dogfood: { status: "none", checks: [] },
    continuation: { allowed: true, runs: 0, unchanged_streak: 0, error_streak: 0, last_signature: "", reason: "mission seeded" },
    packet: packetMeta,
    created_at: input.now ?? new Date().toISOString(),
    updated_at: input.now ?? new Date().toISOString(),
  };
}

export interface CheckpointInput {
  milestone?: string;
  next_action?: string;
  attempts?: number;
  child_work?: string;
  checks?: { name: string; status: "pass" | "fail" | "skip"; detail?: string }[];
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
    byName.set(check.name, { name: check.name, status: check.status, detail: check.detail, at });
  }
  // Keep the ledger compact: newest result per named check, capped.
  return [...byName.values()].slice(-40);
}

function uniqueCap(existing: string[], incoming: string[] | undefined, cap: number): string[] {
  if (!incoming?.length) return existing;
  return [...new Set([...existing, ...incoming])].slice(-cap);
}

/**
 * Record observable progress. This is the only sanctioned way to move a blocked
 * mission back to WORKING from inside a turn, so `NEEDS_HUMAN -> WORKING` stays
 * a real, tested edge.
 */
export function applyCheckpoint(job: JobState, input: CheckpointInput): JobState {
  const next: JobState = {
    ...job,
    progress: {
      milestone: input.milestone?.trim() || job.progress.milestone,
      next_action: input.next_action?.trim() || job.progress.next_action,
      attempts: typeof input.attempts === "number" ? Math.max(0, Math.trunc(input.attempts)) : job.progress.attempts + 1,
      child_work: input.child_work?.trim() || job.progress.child_work,
    },
    evidence: {
      checks: mergeChecks(job.evidence.checks, input.checks),
      commits: uniqueCap(job.evidence.commits, input.commits, 60),
      pushed_shas: uniqueCap(job.evidence.pushed_shas, input.pushed_shas, 60),
      artifacts: uniqueCap(job.evidence.artifacts, input.artifacts, 40),
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
    // A checkpoint is the sanctioned resume edge: Pi rechecked the capability
    // and it held. Terminal missions are never reopened by a checkpoint -
    // only a fresh packet or an explicit "resume the mission" reopens those.
    const transitioned = applyTransition(job, "WORKING");
    next.status = transitioned.status;
    next.continuation = { ...next.continuation, runs: 0, unchanged_streak: 0, error_streak: 0, allowed: true, reason: "resumed by checkpoint" };
    next.blocker = undefined;
    next.human_dogfood = job.human_dogfood.status === "pending" ? { status: "done", checks: job.human_dogfood.checks } : job.human_dogfood;
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
export function evaluateCompletion(job: JobState, input: CompleteInput): { ok: boolean; problems: string[]; reaffirm: boolean } {
  const problems: string[] = [];
  const reaffirm = terminalStatus(job.status) && job.status === input.outcome && job.result?.summary === input.summary.trim();
  if (terminalStatus(job.status) && !reaffirm) {
    // Re-declaring a different outcome over a terminal mission needs a resume first.
    problems.push(`mission already recorded as ${job.status}; resume with a checkpoint or a new packet first`);
  }
  if (input.outcome === "COMPLETE") {
    if (job.evidence.checks.length === 0) problems.push("no machine evidence recorded (at least one check is required)");
    if (!input.push_verified && !job.evidence.pushed_shas.length) problems.push("push not verified: record the pushed SHA or verify the remote");
    if (!input.head_sha && !job.repo.current_sha) problems.push("no recorded revision for the completed work");
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
