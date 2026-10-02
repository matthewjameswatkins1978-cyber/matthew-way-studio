/**
 * Durable job schema, status machine and version handling.
 *
 * Pure: no Pi, no filesystem, no git. Everything here is deterministic and
 * unit-testable, because the runtime's value comes from state that survives
 * compaction, restart and model replacement.
 *
 * Lifecycle vocabulary follows the MCP Tasks pattern (WORKING /
 * INPUT_REQUIRED / COMPLETE / FAILED) renamed to Matthew-facing terms:
 * NEEDS_HUMAN is a first-class resumable state, not a failure.
 */

export const SCHEMA_VERSION = 1;

export const STATUSES = ["WORKING", "NEEDS_HUMAN", "COMPLETE", "PARTIAL", "FAILED"] as const;
export type JobStatus = (typeof STATUSES)[number];

export type BlockerKind =
  | "credential"
  | "authentication"
  | "access"
  | "account-action"
  | "external-service"
  | "physical-interaction"
  | "judgement"
  | "irreversible-choice"
  | "external-approval"
  | "stalled"
  | "other";

export const BLOCKER_KINDS: readonly BlockerKind[] = [
  "credential",
  "authentication",
  "access",
  "account-action",
  "external-service",
  "physical-interaction",
  "judgement",
  "irreversible-choice",
  "external-approval",
  "stalled",
  "other",
];

export interface CheckEvidence {
  name: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  at: string;
}

export interface JobContract {
  objective: string;
  scope: string[];
  authority: string[];
  constraints: string[];
  acceptance: string[];
  attention: string[];
}

export interface JobRepo {
  root: string;
  remote: string;
  branch: string;
  base_sha: string;
  current_sha: string;
  dirty_at_start: boolean;
}

export interface JobProgress {
  milestone: string;
  next_action: string;
  attempts: number;
  child_work: string;
}

export interface JobEvidence {
  checks: CheckEvidence[];
  commits: string[];
  pushed_shas: string[];
  artifacts: string[];
}

export interface JobMemory {
  /** used | not-needed | unavailable — how Lantern actually featured in this mission. */
  lantern: "used" | "not-needed" | "unavailable";
  lantern_refs: string[];
  decisions_loaded: string[];
}

export interface JobBlocker {
  kind: BlockerKind;
  reason: string;
  exact_human_need: string;
  state_preserved: string;
  resume_condition: string;
  /** Stable digest of the need, so the same missing thing is never asked twice. */
  signature: string;
  times_raised: number;
}

export interface JobDogfood {
  status: "none" | "pending" | "done";
  checks: string[];
}

export interface JobContinuation {
  allowed: boolean;
  runs: number;
  /** Consecutive auto-continuations that produced no progress signature change. */
  unchanged_streak: number;
  /** Consecutive provider/agent errors. */
  error_streak: number;
  last_signature: string;
  reason: string;
}

export interface JobState extends JobContract {
  schema_version: number;
  job_id: string;
  status: JobStatus;
  repo: JobRepo;
  progress: JobProgress;
  evidence: JobEvidence;
  memory: JobMemory;
  blocker?: JobBlocker;
  human_dogfood: JobDogfood;
  continuation: JobContinuation;
  packet: { sha256: string; bytes: number; path: string };
  result?: { outcome: "COMPLETE" | "PARTIAL" | "FAILED"; summary: string; receipt?: string };
  created_at: string;
  updated_at: string;
}

/**
 * Edges of the status machine. Self-edges are legal so re-affirming the same
 * state is idempotent instead of throwing at a tool boundary.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  WORKING: ["WORKING", "NEEDS_HUMAN", "COMPLETE", "PARTIAL", "FAILED"],
  NEEDS_HUMAN: ["NEEDS_HUMAN", "WORKING", "FAILED"],
  COMPLETE: ["COMPLETE", "WORKING"],
  PARTIAL: ["PARTIAL", "WORKING"],
  FAILED: ["FAILED", "WORKING", "NEEDS_HUMAN"],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function terminalStatus(status: JobStatus): boolean {
  return status === "COMPLETE" || status === "PARTIAL" || status === "FAILED";
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Coerce sloppy status spellings ("failed", "skipped") instead of inventing a pass. */
function coerceCheckStatus(value: unknown): CheckEvidence["status"] {
  const raw = String(value ?? "pass").toLowerCase();
  if (raw.startsWith("f")) return "fail";
  if (raw.startsWith("s")) return "skip";
  return "pass";
}
function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function clampInt(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.trunc(value)) : fallback;
}

export class JobParseError extends Error {}

/**
 * Accept an unknown blob from disk and return a valid v1 job.
 *
 * Unknown-but-newer schema versions are rejected rather than guessed at; the
 * caller preserves the file and starts clean. Missing/older versions are
 * migrated forward with defaults.
 */
export function normalizeJob(raw: unknown): JobState {
  if (typeof raw !== "object" || raw === null) throw new JobParseError("job state is not an object");
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.schema_version === "number" ? obj.schema_version : 0;
  if (version > SCHEMA_VERSION) {
    throw new JobParseError(`job state schema_version ${version} is newer than runtime ${SCHEMA_VERSION}`);
  }
  const status = (str(obj.status) as JobStatus) || "WORKING";
  if (!STATUSES.includes(status)) throw new JobParseError(`unknown job status: ${status}`);

  const repo = (obj.repo ?? {}) as Record<string, unknown>;
  const progress = (obj.progress ?? {}) as Record<string, unknown>;
  const evidence = (obj.evidence ?? {}) as Record<string, unknown>;
  const memory = (obj.memory ?? {}) as Record<string, unknown>;
  const blocker = obj.blocker as Record<string, unknown> | undefined;
  const dogfood = (obj.human_dogfood ?? {}) as Record<string, unknown>;
  const cont = (obj.continuation ?? {}) as Record<string, unknown>;
  const packet = (obj.packet ?? {}) as Record<string, unknown>;
  const result = obj.result as Record<string, unknown> | undefined;
  const now = new Date().toISOString();

  const lanternMemory = str(memory.lantern);

  const job: JobState = {
    schema_version: SCHEMA_VERSION,
    job_id: str(obj.job_id) || `job-${Date.now().toString(36)}`,
    status,
    objective: str(obj.objective),
    scope: strList(obj.scope),
    authority: strList(obj.authority),
    constraints: strList(obj.constraints),
    acceptance: strList(obj.acceptance),
    attention: strList(obj.attention),
    repo: {
      root: str(repo.root),
      remote: str(repo.remote),
      branch: str(repo.branch),
      base_sha: str(repo.base_sha),
      current_sha: str(repo.current_sha),
      dirty_at_start: repo.dirty_at_start === true,
    },
    progress: {
      milestone: str(progress.milestone),
      next_action: str(progress.next_action),
      attempts: clampInt(progress.attempts, 0, 0),
      child_work: str(progress.child_work),
    },
    evidence: {
      checks: Array.isArray(evidence.checks)
        ? evidence.checks
            .map((c) => c as Record<string, unknown>)
            .filter((c) => typeof c?.name === "string")
            .map((c) => ({
              name: String(c.name),
              status: coerceCheckStatus(c.status),
              detail: typeof c.detail === "string" ? c.detail : undefined,
              at: typeof c.at === "string" ? c.at : now,
            }))
        : [],
      commits: strList(evidence.commits),
      pushed_shas: strList(evidence.pushed_shas),
      artifacts: strList(evidence.artifacts),
    },
    memory: {
      lantern: lanternMemory === "used" || lanternMemory === "unavailable" ? (lanternMemory as JobMemory["lantern"]) : "not-needed",
      lantern_refs: strList(memory.lantern_refs),
      decisions_loaded: strList(memory.decisions_loaded),
    },
    human_dogfood: {
      status: dogfood.status === "pending" || dogfood.status === "done" ? (dogfood.status as JobDogfood["status"]) : "none",
      checks: strList(dogfood.checks),
    },
    continuation: {
      allowed: cont.allowed === false ? false : true,
      runs: clampInt(cont.runs, 0, 0),
      unchanged_streak: clampInt(cont.unchanged_streak, 0, 0),
      error_streak: clampInt(cont.error_streak, 0, 0),
      last_signature: str(cont.last_signature),
      reason: str(cont.reason),
    },
    packet: {
      sha256: str(packet.sha256),
      bytes: clampInt(packet.bytes, 0, 0),
      path: str(packet.path),
    },
    created_at: str(obj.created_at) || now,
    updated_at: str(obj.updated_at) || now,
  };

  if (blocker && typeof blocker === "object") {
    const kind = str(blocker.kind) as BlockerKind;
    job.blocker = {
      kind: BLOCKER_KINDS.includes(kind) ? kind : "other",
      reason: str(blocker.reason),
      exact_human_need: str(blocker.exact_human_need),
      state_preserved: str(blocker.state_preserved),
      resume_condition: str(blocker.resume_condition),
      signature: str(blocker.signature),
      times_raised: clampInt(blocker.times_raised, 1, 1),
    };
  }

  if (result && typeof result.outcome === "string") {
    job.result = {
      outcome: result.outcome === "PARTIAL" || result.outcome === "FAILED" ? result.outcome : "COMPLETE",
      summary: str(result.summary),
      receipt: typeof result.receipt === "string" ? result.receipt : undefined,
    };
  }

  if (!job.objective) throw new JobParseError("job state has no objective");
  return job;
}

export function newJob(input: {
  jobId: string;
  contract: JobContract;
  repo: JobRepo;
  packet: { sha256: string; bytes: number; path: string };
  nextAction: string;
  now?: string;
}): JobState {
  const now = input.now ?? new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    job_id: input.jobId,
    status: "WORKING",
    ...input.contract,
    repo: input.repo,
    progress: { milestone: "", next_action: input.nextAction, attempts: 0, child_work: "" },
    evidence: { checks: [], commits: [], pushed_shas: [], artifacts: [] },
    memory: { lantern: "not-needed", lantern_refs: [], decisions_loaded: [] },
    human_dogfood: { status: "none", checks: [] },
    continuation: {
      allowed: true,
      runs: 0,
      unchanged_streak: 0,
      error_streak: 0,
      last_signature: "",
      reason: "mission seeded",
    },
    packet: input.packet,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Progress signature: what the runtime uses to decide whether the last
 * continuation actually moved the mission. Deterministic and cheap.
 */
export function progressSignature(job: JobState): string {
  return [
    job.repo.current_sha,
    job.progress.milestone,
    job.progress.next_action.slice(0, 120),
    job.evidence.checks.length,
    job.evidence.commits.length,
  ].join("|");
}

export function applyTransition(job: JobState, to: JobStatus): JobState {
  if (!canTransition(job.status, to)) {
    throw new JobParseError(`illegal job transition ${job.status} -> ${to}`);
  }
  return { ...job, status: to, updated_at: new Date().toISOString() };
}
