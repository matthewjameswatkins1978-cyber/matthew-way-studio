/**
 * Human-facing packets the runtime emits verbatim: the completion receipt, the
 * NEEDS_HUMAN block, and the small dogfood check. Format is fixed so Lucy or
 * ChatGPT can read it without project history.
 */

import { canonicalRepo, type RepoFacts } from "./git.js";
import type { JobState } from "./schema.js";

function section(label: string, value: string): string {
  return `${label}\n${value.trim() || "none"}`;
}

function list(items: string[], indent = ""): string {
  if (!items.length) return "none";
  return items.map((i) => `${indent}- ${i}`).join("\n");
}

export function pushState(job: JobState, verified: boolean | undefined): string {
  if (verified === true) return "verified";
  if (verified === false) return "not verified";
  if (job.evidence.pushed_shas.length > 0) return "verified";
  return "not verified";
}

export function machineEvidence(job: JobState): string {
  if (!job.evidence.checks.length) return "none recorded";
  return list(
    job.evidence.checks.map((c) => {
      const mark = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP";
      return `${c.name}: ${mark}${c.detail ? ` — ${c.detail}` : ""}`;
    }),
  );
}

/**
 * Canonical remote for a receipt. A relative or local-path remote is shown with
 * the repository root, so a receipt never names an ambiguous "../remote.git".
 */
export function repoLabel(job: JobState, facts: RepoFacts): string {
  const raw = job.repo.remote || facts.remote || "";
  const canonical = canonicalRepo(raw);
  const root = job.repo.root || facts.root || "";
  if (!canonical) return root || "not a repository";
  // Only a real hosted remote form is shown bare. A relative or local-path
  // remote is ambiguous without the repository root beside it.
  const hostedRemote = /^(git@[\w.-]+:|ssh:\/\/|https?:\/\/)/.test(raw.trim());
  const canonicalShape = /^[\w.-]+\/[\w.-]+$/.test(canonical);
  const bare = (hostedRemote && canonicalShape) || !root;
  return bare ? canonical : `${canonical} (${root})`;
}

export function renderReceipt(job: JobState, facts: RepoFacts, input: { push_verified?: boolean } = {}): string {
  const outcome = job.result?.outcome ?? job.status;
  const lines = [
    `RESULT: ${outcome}`,
    "",
    section("OBJECTIVE", job.objective),
    "",
    section("REPO", repoLabel(job, facts)),
    "",
    section("BRANCH", job.repo.branch || facts.branch || "unknown"),
    "",
    section("SHA", job.repo.current_sha || facts.head_sha || "unknown"),
    "",
    section("PUSH", pushState(job, input.push_verified)),
    "",
    section("MACHINE EVIDENCE", machineEvidence(job)),
    "",
    section(
      "IMPORTANT DECISIONS",
      job.memory.decisions_loaded.length ? list(job.memory.decisions_loaded) : "none recorded",
    ),
    "",
    section("LANTERN", lanternLine(job)),
    "",
    section("HUMAN DOGFOOD", dogfoodBlock(job)),
    "",
    section("UNRESOLVED", unresolvedLine(job)),
    "",
    section("HUMAN ATTENTION", attentionLine(job)),
  ];
  return lines.join("\n");
}

function lanternLine(job: JobState): string {
  if (job.memory.lantern === "used") {
    const refs = job.memory.lantern_refs.length ? ` (handles: ${job.memory.lantern_refs.join(", ")})` : "";
    return `context used${refs}`;
  }
  if (job.memory.lantern === "unavailable") return "unavailable — continued from repository and Git facts";
  return "not needed for this mission";
}

function unresolvedLine(job: JobState): string {
  const parts: string[] = [];
  const failed = job.evidence.checks.filter((c) => c.status === "fail").map((c) => c.name);
  if (failed.length) parts.push(`failing checks: ${failed.join(", ")}`);
  if (job.evidence.pushed_shas.length === 0) parts.push("no pushed SHA recorded");
  if (job.repo.dirty_at_start) parts.push("working tree was already dirty at mission start; unrelated changes were preserved");
  return parts.length ? parts.join("\n") : "none";
}

function attentionLine(job: JobState): string {
  if (job.status === "NEEDS_HUMAN" && job.blocker) return `still blocked: ${job.blocker.exact_human_need}`;
  if (job.human_dogfood.status === "pending") return "run the HUMAN DOGFOOD check above and report what happened";
  return "none";
}

export function dogfoodBlock(job: JobState): string {
  if (job.human_dogfood.status === "none" || job.human_dogfood.checks.length === 0) return "none";
  const steps = job.human_dogfood.checks.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return `HUMAN DOGFOOD\n${steps}\nTell Lucy/Pi whether the behaviour above is correct.`;
}

export function renderNeedsHuman(
  job: JobState,
  facts: RepoFacts,
  blocker: { exact_human_need: string; reason: string; resume_condition: string; next_action: string },
): string {
  return [
    "NEEDS_HUMAN",
    "",
    section("WHAT I NEED", blocker.exact_human_need),
    "",
    section("WHY", blocker.reason),
    "",
    section("ALREADY COMPLETE", alreadyComplete(job)),
    "",
    section("STATE", `${repoLabel(job, facts)} / ${job.repo.branch || facts.branch || "no branch"} / ${job.repo.current_sha || facts.head_sha || "no SHA"}`),
    "",
    "WHEN YOU HAVE DONE IT",
    "Reply normally. No special command required.",
    "",
    section("NEXT ACTION", blocker.next_action || job.progress.next_action || "recheck the blocker against the live environment"),
    "",
    section("RESUME CONDITION", blocker.resume_condition),
  ].join("\n");
}

function alreadyComplete(job: JobState): string {
  const bits: string[] = [];
  if (job.progress.milestone) bits.push(`milestone: ${job.progress.milestone}`);
  if (job.evidence.commits.length) bits.push(`commits: ${job.evidence.commits.map((c) => c.slice(0, 10)).join(", ")}`);
  const passed = job.evidence.checks.filter((c) => c.status === "pass").map((c) => c.name);
  if (passed.length) bits.push(`checks passed: ${passed.join(", ")}`);
  if (job.evidence.artifacts.length) bits.push(`artifacts: ${job.evidence.artifacts.join(", ")}`);
  return bits.length ? bits.join("\n") : "no durable work completed yet; repository state is unchanged";
}

/** The compact contract shown to the model so it can work without the chat. */
export function renderMissionBrief(job: JobState): string {
  const lines = [
    `STUDIO MISSION ${job.job_id} [${job.status}]`,
    `OBJECTIVE: ${job.objective}`,
    job.scope.length ? `SCOPE: ${job.scope.join(" | ")}` : "",
    job.authority.length ? `AUTHORITY: ${job.authority.join(" | ")}` : "",
    job.constraints.length ? `CONSTRAINTS: ${job.constraints.join(" | ")}` : "",
    job.acceptance.length ? `ACCEPTANCE: ${job.acceptance.join(" | ")}` : "",
    job.attention.length ? `ATTENTION: ${job.attention.join(" | ")}` : "",
    `REPO: ${job.repo.root || "n/a"} branch=${job.repo.branch || "n/a"} base=${job.repo.base_sha.slice(0, 10) || "n/a"} head=${job.repo.current_sha.slice(0, 10) || "n/a"}`,
    job.progress.milestone ? `MILESTONE: ${job.progress.milestone}` : "",
    job.progress.next_action ? `NEXT ACTION: ${job.progress.next_action}` : "",
    job.blocker ? `BLOCKER: ${job.blocker.kind} — ${job.blocker.exact_human_need}` : "",
    `PACKET: ${job.packet.path} (sha256 ${job.packet.sha256.slice(0, 12)})`,
  ].filter(Boolean);
  return lines.join("\n");
}
