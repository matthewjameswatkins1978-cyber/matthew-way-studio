/**
 * matthew-way-studio — autonomous packet runtime for Pi.
 *
 *   folder + repo + packet  ->  Pi  ->  finished pushed work
 *
 * One extension, five model-callable tools, no mandatory commands. Ordinary
 * work activates it; the durable ledger in the Git common directory keeps the
 * mission alive across compaction, restart, and model or child replacement.
 */

import { Type } from "typebox";
import type {
  CustomMessageDraft,
  PiApi,
  PiBeforeAgentStartEvent,
  PiBoundaryEvent,
  PiBoundaryResult,
  PiContext,
  PiToolContext,
} from "../src/pi-shim.js";
import { customMessage, textResult } from "../src/pi-shim.js";
import { ledgerLocation, type LedgerLocation } from "../src/paths.js";
import { appendEvent, readJob, writeJob, readPacket, type JobReadResult } from "../src/ledger.js";
import { decideContinuation } from "../src/continuation.js";
import { loadConfig, type StudioConfig } from "../src/config.js";
import { commitAll, repoFacts, verifyRemoteSha, pushAndVerify, canonicalRepo, type RepoFacts } from "../src/git.js";
import { applyBlock, applyCheckpoint, applyComplete, applyMemory, evaluateCompletion, startMission, type BlockerInput } from "../src/mission.js";
import { discoverLanternTools, lanternContextResult, readSnapshot } from "../src/lantern.js";
import { isSubstantivePacket, detectControlIntent } from "../src/packet.js";
import { renderMissionBrief, renderNeedsHuman, renderReceipt } from "../src/receipt.js";
import { canTransition, progressSignature, terminalStatus, type BlockerKind, type JobState } from "../src/schema.js";

const STATUS_KEY = "studio";
const MISSION_SECTION = "studio_mission";

interface Runtime {
  location: LedgerLocation;
  config: StudioConfig;
  facts: RepoFacts;
  read: JobReadResult;
}

/** Worktree/repo identity cannot change inside a session, so it is safe to memo. */
const locationMemo = new Map<string, LedgerLocation>();

function locationFor(cwd: string): LedgerLocation {
  const hit = locationMemo.get(cwd);
  if (hit) return hit;
  const location = ledgerLocation(cwd);
  locationMemo.set(cwd, location);
  return location;
}

function runtimeFor(ctx: PiContext | PiToolContext): Runtime {
  const location = locationFor(ctx.cwd);
  const config = loadConfig(location.dir, ctx.cwd).config;
  return { location, config, facts: repoFacts(location.repoRoot ?? ctx.cwd), read: readJob(location) };
}

function jobOf(rt: Runtime): JobState | undefined {
  return rt.read.kind === "loaded" ? rt.read.job : undefined;
}

function statusLine(job: JobState | undefined, config: StudioConfig): string | undefined {
  if (!job) return undefined;
  if (job.status === "NEEDS_HUMAN") return `studio: NEEDS_HUMAN — ${job.blocker?.exact_human_need.slice(0, 60) ?? "blocked"}`;
  if (terminalStatus(job.status)) return `studio: ${job.status} ${job.repo.current_sha.slice(0, 7)}`;
  const milestone = job.progress.milestone ? ` · ${job.progress.milestone.slice(0, 30)}` : "";
  const allowance = config.autoContinue ? ` · turn ${job.continuation.runs}/${config.maxTurns}` : "";
  return `studio: WORKING${milestone}${allowance}`;
}

function safeNotify(ctx: PiContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    /* no UI in print mode */
  }
}

function updateStatus(ctx: PiContext, job: JobState | undefined, config: StudioConfig): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, statusLine(job, config));
  } catch {
    /* status is advisory */
  }
}

/** Degrade loudly but safely: a broken ledger file must never kill a session. */
function describeUnreadable(read: JobReadResult, dir: string): string | undefined {
  if (read.kind === "corrupt") return `studio: active-job.json in ${dir} is corrupt (${read.reason}); working without a mission ledger`;
  if (read.kind === "future-version") return `studio: active-job.json in ${dir} uses a newer schema (${read.reason}); leaving it untouched`;
  return undefined;
}

function withSection(event: PiBeforeAgentStartEvent, body: string): void {
  event.systemPromptOptions.sections = { ...(event.systemPromptOptions.sections ?? {}), [MISSION_SECTION]: body };
}

function missionSection(job: JobState, config: StudioConfig): string {
  const brief = renderMissionBrief(job);
  if (job.status === "NEEDS_HUMAN") {
    return [
      brief,
      "",
      "STUDIO RESUME: this mission is NEEDS_HUMAN and Matthew just replied.",
      "1. Recheck the exact blocker against the live environment with your own tools before assuming anything.",
      "2. If it is resolved, call studio_checkpoint with the next action and continue the mission automatically.",
      "3. If it is not resolved, state precisely what is still missing. Do not repeat the same request verbatim, and do not tell Matthew to run commands you can run yourself.",
      "4. Never convert a small follow-up into a new mission while one is active.",
    ].join("\n");
  }
  if (terminalStatus(job.status)) {
    return [
      brief,
      "",
      `STUDIO: the previous mission is recorded ${job.status}. Treat this message as new work only if Matthew submitted a fresh packet; otherwise answer normally without touching the ledger.`,
    ].join("\n");
  }
  return [
    brief,
    "",
    "STUDIO OPERATING RULES",
    "- You are running this mission autonomously. Do not ask Matthew to approve an internally sensible plan; do the work.",
    "- Work the NEXT ACTION now. A turn that only narrates status is not progress.",
    "- Call studio_checkpoint whenever repo state, evidence, or the next action changes.",
    "- Call studio_blocked only for something genuinely human-only (credential, access, account action, physical interaction, taste judgement, irreversible choice, external approval).",
    `- Automatic continuation is bounded: ${config.maxTurns} turns per mission, and ${config.maxUnchangedTurns} turns without measurable progress stops the loop. Never retry an unchanged failure: change approach or block.`,
    "- Evidence outranks narration: run the cheapest trustworthy check; never claim a push you have not verified.",
    "- Preserve unrelated work in the tree. Keep changes scoped to the mission.",
    "- Before finishing: studio_ship (commit/push/verify), then studio_complete for the receipt.",
    job.blocker ? `- A blocker was recorded earlier (${job.blocker.exact_human_need}); if you worked around it, clear it with studio_checkpoint.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function seedMission(ctx: PiContext | PiToolContext, packet: string): { job?: JobState; rt: Runtime; started: boolean } {
  const rt = runtimeFor(ctx);
  const existing = jobOf(rt);
  if (existing && !terminalStatus(existing.status)) return { job: existing, rt, started: false };
  if (existing) {
    // A closed mission never blocks the next one: archive, then start fresh.
    appendEvent(rt.location, "mission-archived", {
      job_id: existing.job_id,
      status: existing.status,
      sha: existing.repo.current_sha,
      summary: existing.result?.summary ?? "",
    });
  }
  const job = startMission({ packet, location: rt.location, facts: rt.facts });
  writeJob(rt.location, job, { backup: true });
  appendEvent(rt.location, "mission-start", {
    job_id: job.job_id,
    objective: job.objective.slice(0, 200),
    branch: job.repo.branch,
    base_sha: job.repo.base_sha,
    packet_bytes: job.packet.bytes,
  });
  safeNotify(ctx, `studio: mission ${job.job_id} started — ${job.objective.slice(0, 80)}`, "info");
  return { job, rt, started: true };
}

export function registerStudio(pi: PiApi): void {
  pi.on("session_start", async (_event, ctx) => {
    const rt = runtimeFor(ctx);
    const job = jobOf(rt);
    updateStatus(ctx, job, rt.config);
    const warn = describeUnreadable(rt.read, rt.location.dir);
    if (warn) safeNotify(ctx, warn, "warning");
    if (job && job.status === "WORKING") {
      safeNotify(ctx, `studio: resuming mission ${job.job_id} — next: ${job.progress.next_action.slice(0, 90) || job.objective.slice(0, 60)}`, "info");
    }
    if (job && lanternToolNames(pi).length === 0) {
      appendEvent(rt.location, "lantern-tools-absent", { job_id: job.job_id });
    }
  });

  pi.on("before_agent_start", async (event: PiBeforeAgentStartEvent, ctx) => {
    const rt = runtimeFor(ctx);
    const prompt = event.prompt ?? "";
    const job = jobOf(rt);

    if (rt.config.requireProjectTrust && !trusted(ctx)) {
      withSection(event, "STUDIO: project is not trusted; the packet runtime is idle for this folder.");
      return undefined;
    }

    // Ordinary language controls the loop; no ritual commands required.
    if (job) {
      const intent = detectControlIntent(prompt);
      if (intent === "pause") {
        const paused: JobState = {
          ...job,
          continuation: { ...job.continuation, allowed: false, reason: "paused by Matthew" },
          updated_at: new Date().toISOString(),
        };
        writeJob(rt.location, paused);
        appendEvent(rt.location, "paused", { job_id: paused.job_id });
        updateStatus(ctx, paused, rt.config);
        withSection(event, `${renderMissionBrief(paused)}\n\nSTUDIO: automatic continuation paused by Matthew. Do more only if he asks.`);
        return undefined;
      }
      if (intent === "resume") {
        const reopened = job.status !== "WORKING" && canTransition(job.status, "WORKING");
        const resumed: JobState = {
          ...job,
          status: reopened ? "WORKING" : job.status,
          continuation: { ...job.continuation, allowed: true, runs: 0, unchanged_streak: 0, error_streak: 0, reason: "renewed by Matthew" },
          blocker: reopened ? undefined : job.blocker,
          updated_at: new Date().toISOString(),
        };
        writeJob(rt.location, resumed);
        appendEvent(rt.location, "renewed", { job_id: resumed.job_id, from: job.status });
        updateStatus(ctx, resumed, rt.config);
        withSection(event, missionSection(resumed, rt.config));
        return undefined;
      }
    }

    if (!job || terminalStatus(job.status)) {
      const warn = describeUnreadable(rt.read, rt.location.dir);
      if (warn) safeNotify(ctx, warn, "warning");
      if (!isSubstantivePacket(prompt) || prompt.trim().length < rt.config.minPacketChars) {
        // Small jobs stay ordinary work, not heavyweight projects.
        if (job) {
          updateStatus(ctx, job, rt.config);
          withSection(event, missionSection(job, rt.config));
        }
        return undefined;
      }
      const seeded = seedMission(ctx, prompt);
      if (seeded.job) withSection(event, missionSection(seeded.job, rt.config));
      return undefined;
    }

    // A human turn is external steering, not autonomous spinning: clear the
    // no-progress and error streaks so a question cannot trigger the stop-loss.
    if (job && (job.continuation.unchanged_streak !== 0 || job.continuation.error_streak !== 0)) {
      const rearmed: JobState = {
        ...job,
        continuation: { ...job.continuation, unchanged_streak: 0, error_streak: 0, reason: "steered by a new message" },
        updated_at: new Date().toISOString(),
      };
      writeJob(rt.location, rearmed);
      updateStatus(ctx, rearmed, rt.config);
      withSection(event, missionSection(rearmed, rt.config));
      return undefined;
    }

    updateStatus(ctx, job, rt.config);
    withSection(event, missionSection(job, rt.config));
    return undefined;
  });

  pi.on("agent_before_settle", async (event: PiBoundaryEvent, ctx): Promise<PiBoundaryResult | undefined> => {
    try {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      if (!job || !rt.config.autoContinue) return undefined;
      if (terminalStatus(job.status) || job.status === "NEEDS_HUMAN") {
        updateStatus(ctx, job, rt.config);
        return undefined;
      }

      const outcome = event.outcome ?? "completed";
      const decision = decideContinuation(
        job,
        { turnCompleted: outcome === "completed", errored: outcome === "error", aborted: outcome === "aborted" },
        { maxTurns: rt.config.maxTurns, maxUnchangedTurns: rt.config.maxUnchangedTurns, maxErrorStreak: rt.config.maxErrorStreak },
      );
      const priorEntries = (event.entries ?? []) as CustomMessageDraft[];

      if (decision.action === "settle") {
        writeJob(rt.location, { ...job, continuation: decision.continuation, updated_at: new Date().toISOString() });
        updateStatus(ctx, job, rt.config);
        return undefined;
      }

      if (decision.action === "stall") {
        // Stop-loss: convert the stall into an explicit, resumable human need.
        const blocker: BlockerInput = {
          kind: "stalled",
          reason: decision.reason,
          exact_human_need: "a steer from Matthew — the current approach is not producing measurable progress",
          resume_condition: "A reply that redirects or re-authorises the mission.",
        };
        const stalled = applyBlock(job, blocker);
        writeJob(rt.location, stalled);
        appendEvent(rt.location, "stop-loss", { job_id: job.job_id, reason: decision.reason, signature: progressSignature(job) });
        updateStatus(ctx, stalled, rt.config);
        safeNotify(ctx, `studio: stop-loss — ${decision.reason}. Asking Matthew for a steer.`, "warning");
        return {
          entries: [
            ...priorEntries,
            customMessage(
              "studio-stop-loss",
              [
                `STUDIO STOP-LOSS (${stalled.job_id}): ${decision.reason}.`,
                'Do not start new work. Call studio_blocked now with kind "stalled", the exact thing you need from Matthew, and the resume condition.',
                "Then give Matthew the NEEDS_HUMAN summary: what you need, why, what is already complete, repo/branch/SHA, next action after he replies.",
              ].join("\n"),
              false,
              { job_id: stalled.job_id, reason: decision.reason },
            ),
          ],
          continue: true,
        };
      }

      const continued: JobState = { ...job, continuation: decision.continuation, updated_at: new Date().toISOString() };
      writeJob(rt.location, continued);
      appendEvent(rt.location, "continuation", {
        job_id: job.job_id,
        turn: decision.continuation.runs,
        progressed: decision.continuation.reason === "progress observed",
        next: continued.progress.next_action.slice(0, 120),
      });
      updateStatus(ctx, continued, rt.config);
      return {
        entries: [...priorEntries, customMessage("studio-continuation", decision.instruction, false, { job_id: job.job_id, turn: decision.continuation.runs })],
        continue: true,
      };
    } catch (error) {
      // A continuation bug must never strand the session.
      safeNotify(ctx, `studio: continuation skipped — ${error instanceof Error ? error.message : String(error)}`, "warning");
      return undefined;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const rt = runtimeFor(ctx);
    updateStatus(ctx, jobOf(rt), rt.config);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const rt = runtimeFor(ctx);
    const job = jobOf(rt);
    if (job && !terminalStatus(job.status)) {
      writeJob(rt.location, {
        ...job,
        continuation: { ...job.continuation, reason: job.continuation.reason || "session closing" },
        updated_at: new Date().toISOString(),
      });
      appendEvent(rt.location, "session-shutdown", { job_id: job.job_id, status: job.status, head: job.repo.current_sha });
    }
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* ignore */
    }
  });

  // ---------------------------------------------------------------- tools ----

  pi.registerTool({
    name: "studio_checkpoint",
    label: "Studio checkpoint",
    description:
      "Record mission progress: current milestone, next action, machine evidence, commits, pushed SHAs and Lantern usage. A checkpoint with a next action is what keeps autonomous continuation moving, and it clears a NEEDS_HUMAN block once the blocker is genuinely gone.",
    promptSnippet: "Record progress/evidence for the active Studio mission and set the next action.",
    promptGuidelines: [
      "Call studio_checkpoint after each meaningful change in repo state, evidence, or next action.",
      "Report only checks you actually ran, and mark failures honestly.",
    ],
    parameters: Type.Object({
      milestone: Type.Optional(Type.String({ description: "Short name of the milestone being worked on" })),
      next_action: Type.Optional(Type.String({ description: "The single concrete next action, imperative and self-contained" })),
      checks: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Check identity, e.g. npm test" }),
            status: Type.String({ description: "pass | fail | skip" }),
            detail: Type.Optional(Type.String({ description: "Concise observed result" })),
          }),
          { description: "Machine checks actually run during this mission" },
        ),
      ),
      commits: Type.Optional(Type.Array(Type.String({ description: "Commit SHA" }))),
      pushed_shas: Type.Optional(Type.Array(Type.String({ description: "SHA verified present on the remote" }))),
      artifacts: Type.Optional(Type.Array(Type.String({ description: "Files or paths worth carrying forward" }))),
      head_sha: Type.Optional(Type.String({ description: "Current HEAD, if it changed" })),
      branch: Type.Optional(Type.String()),
      attempts: Type.Optional(Type.Number({ description: "Explicit attempt count for the current approach" })),
      child_work: Type.Optional(Type.String({ description: "What any delegated worker is doing, or 'none'" })),
      lantern: Type.Optional(Type.String({ description: "used | not-needed | unavailable" })),
      lantern_refs: Type.Optional(Type.Array(Type.String({ description: "Lantern handles/ids referenced" }))),
      decisions_loaded: Type.Optional(Type.Array(Type.String({ description: "Consequential decisions that bind later work" }))),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      if (!job) {
        return textResult("No active Studio mission. Small jobs do not need one: just do the work. A substantial packet starts a mission automatically.", undefined, true);
      }
      const checks = parseChecks(params["checks"]);
      const updated = applyCheckpoint(job, {
        milestone: str(params["milestone"]),
        next_action: str(params["next_action"]),
        checks,
        commits: strArray(params["commits"]),
        pushed_shas: strArray(params["pushed_shas"]),
        artifacts: strArray(params["artifacts"]),
        head_sha: str(params["head_sha"]),
        branch: str(params["branch"]),
        attempts: num(params["attempts"]),
        child_work: str(params["child_work"]),
        lantern: lanternStatus(str(params["lantern"])),
        lantern_refs: strArray(params["lantern_refs"]),
        decisions_loaded: strArray(params["decisions_loaded"]),
      });
      writeJob(rt.location, updated);
      appendEvent(rt.location, "checkpoint", {
        job_id: updated.job_id,
        from: job.status,
        milestone: updated.progress.milestone,
        next_action: updated.progress.next_action.slice(0, 160),
        checks: checks?.length ?? 0,
      });
      updateStatus(ctx, updated, rt.config);
      return textResult(
        [
          `CHECKPOINT OK · ${updated.status} · ${updated.job_id}`,
          `milestone: ${updated.progress.milestone || "(unset)"}`,
          `next: ${updated.progress.next_action || "(unset — set one so continuation stays useful)"}`,
          `head: ${updated.repo.current_sha.slice(0, 10) || rt.facts.head_sha.slice(0, 10) || "no commits"}`,
          `evidence: ${updated.evidence.checks.length} check(s), ${updated.evidence.commits.length} commit(s), ${updated.evidence.pushed_shas.length} pushed SHA(s)`,
          `continuation: turn ${updated.continuation.runs}/${rt.config.maxTurns}, unchanged streak ${updated.continuation.unchanged_streak}/${rt.config.maxUnchangedTurns}`,
        ].join("\n"),
        { job_id: updated.job_id, status: updated.status },
      );
    },
  });

  pi.registerTool({
    name: "studio_blocked",
    label: "Studio needs-human",
    description:
      "Enter the resumable NEEDS_HUMAN state for a genuinely human-only dependency (credential, authentication, access, account action, physical interaction, taste judgement, irreversible choice, external approval). Preserves all work, records repo/branch/SHA, and stops automatic continuation.",
    promptSnippet: "Mark the active mission NEEDS_HUMAN with the exact one thing Matthew must supply.",
    promptGuidelines: [
      "Use studio_blocked only when Pi truly cannot supply the missing capability itself.",
      "Before blocking, commit safe durable work and record the exact state so the mission is resumable.",
      "Never ask for the same missing thing twice: reuse the recorded blocker if it is unchanged.",
    ],
    parameters: Type.Object({
      kind: Type.String({ description: BLOCKER_KIND_DOC }),
      reason: Type.String({ description: "Why Pi cannot do this itself" }),
      exact_human_need: Type.String({ description: "One concrete thing Matthew must provide or do" }),
      resume_condition: Type.String({ description: "What makes the blocker resolved" }),
      next_action: Type.Optional(Type.String({ description: "What Pi will do after rechecking" })),
      state_preserved: Type.Optional(Type.String({ description: "Where the safe work lives (branch/SHA/commits)" })),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      if (!job) return textResult("No active Studio mission to block.", undefined, true);
      const kind = normalizeKind(str(params["kind"]));
      const input: BlockerInput = {
        kind,
        reason: str(params["reason"]) ?? "",
        exact_human_need: str(params["exact_human_need"]) ?? "",
        resume_condition: str(params["resume_condition"]) ?? "",
        state_preserved: str(params["state_preserved"]),
      };
      if (!input.exact_human_need.trim()) return textResult("studio_blocked needs one concrete exact_human_need.", undefined, true);
      const blocked = applyBlock(job, input);
      writeJob(rt.location, blocked);
      appendEvent(rt.location, "needs-human", {
        job_id: blocked.job_id,
        kind,
        need: input.exact_human_need.slice(0, 200),
        times_raised: blocked.blocker?.times_raised ?? 1,
      });
      updateStatus(ctx, blocked, rt.config);
      const raised = blocked.blocker?.times_raised ?? 1;
      const block = renderNeedsHuman(blocked, rt.facts, {
        exact_human_need: input.exact_human_need,
        reason: input.reason,
        resume_condition: input.resume_condition,
        next_action: str(params["next_action"]) ?? job.progress.next_action,
      });
      safeNotify(ctx, `studio: NEEDS_HUMAN — ${input.exact_human_need.slice(0, 90)}`, "warning");
      return textResult(
        raised > 1
          ? `${block}\n\nNOTE: this same blocker has now been recorded ${raised} times. Do not keep asking for the same thing: try a materially different valid approach, or wait for Matthew.`
          : block,
        { job_id: blocked.job_id, status: "NEEDS_HUMAN", times_raised: raised },
      );
    },
  });

  pi.registerTool({
    name: "studio_ship",
    label: "Studio ship + verify",
    description:
      "Deterministic Git finalisation: optionally commit the intended work, push the mission branch to the remote, and verify the remote SHA. Reports evidence only; it never force-pushes and never merges review branches on Matthew or Lucy's behalf.",
    promptSnippet: "Commit and push mission work, then verify the remote SHA.",
    promptGuidelines: [
      "Use studio_ship before studio_complete so the receipt carries a verified pushed SHA.",
      "If studio_ship reports an authentication or access failure, that is a NEEDS_HUMAN candidate, not something to retry blindly.",
    ],
    parameters: Type.Object({
      commit: Type.Optional(Type.Boolean({ description: "Commit current changes before pushing (default false)" })),
      message: Type.Optional(Type.String({ description: "Commit message; required when commit=true" })),
      branch: Type.Optional(Type.String({ description: "Branch to push (default: current mission branch)" })),
      remote: Type.Optional(Type.String({ description: "Remote name (default: origin)" })),
      dry_run: Type.Optional(Type.Boolean({ description: "Report facts only; change nothing" })),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      const root = rt.location.repoRoot ?? ctx.cwd;
      const wantsCommit = params["commit"] === true;
      const message = str(params["message"]);
      const remoteName = str(params["remote"]) || "origin";
      const branch = str(params["branch"]) || job?.repo.branch || rt.facts.branch;

      if (params["dry_run"] === true) {
        return textResult(
          [
            `DRY RUN · ${rt.facts.is_repo ? "repo" : "not a repo"}`,
            `root: ${rt.facts.root || root}`,
            `remote: ${canonicalRepo(rt.facts.remote) || "(none)"}`,
            `branch: ${branch || "(detached)"} · head: ${rt.facts.head_sha.slice(0, 10) || "(no commits)"}`,
            `dirty: ${rt.facts.dirty ? `yes (${rt.facts.dirty_paths.length} path(s))` : "no"}`,
            `upstream: ${rt.facts.upstream || "(none)"}`,
            `ledger: ${rt.location.dir} (${rt.location.source})`,
          ].join("\n"),
          { facts: rt.facts },
        );
      }
      if (!rt.facts.is_repo) return textResult("studio_ship needs a git repository. If one is genuinely missing, that is a human-only dependency: block with kind access.", undefined, true);
      if (wantsCommit) {
        if (!message?.trim()) return textResult("commit=true requires a commit message.", undefined, true);
        const commitRes = commitAll(root, message);
        if (!commitRes.ok) return textResult(`commit failed: ${commitRes.detail}`, undefined, true);
      }
      const push = pushAndVerify(root, branch, remoteName);
      const facts = repoFacts(root);
      if (job) {
        const updated = applyCheckpoint(job, {
          head_sha: facts.head_sha || push.local_sha,
          branch,
          commits: push.local_sha ? [push.local_sha] : undefined,
          pushed_shas: push.remote?.verified ? [push.local_sha] : undefined,
        });
        writeJob(rt.location, updated);
        appendEvent(rt.location, "ship", { job_id: job.job_id, ok: push.ok, detail: push.detail, branch, sha: push.local_sha });
      }
      const lines = [
        `PUSH: ${push.ok ? "verified" : "not verified"}`,
        `branch: ${branch || "(detached)"}`,
        `local SHA: ${push.local_sha}`,
        push.remote?.remote_sha ? `remote SHA: ${push.remote.remote_sha}` : "remote SHA: unknown",
        `detail: ${push.detail}`,
        wantsCommit ? "commit: created" : "commit: none requested",
      ];
      if (!push.ok && /credential|auth|403|permission|token|denied/i.test(push.detail)) {
        lines.push("", "This looks like an access problem only Matthew can resolve: consider studio_blocked with kind authentication or access.");
      }
      safeNotify(ctx, `studio: push ${push.ok ? "verified" : "NOT verified"} @ ${push.local_sha.slice(0, 7)}`, push.ok ? "info" : "warning");
      return textResult(lines.join("\n"), { push_ok: push.ok, sha: push.local_sha, detail: push.detail });
    },
  });

  pi.registerTool({
    name: "studio_complete",
    label: "Studio complete",
    description:
      "Close the mission as COMPLETE, PARTIAL or FAILED and produce the concise evidence receipt for Lucy/ChatGPT review. COMPLETE is refused while machine evidence is missing, a recorded check is failing, or the push is unverified — unless the only outstanding item is declared human dogfood.",
    promptSnippet: "Finish the mission and emit the concise evidence receipt.",
    promptGuidelines: [
      "Call studio_complete only when the mission's acceptance is materially satisfied or the remainder is explicit human dogfood.",
      "Pass dogfood checks for GUI feel, visuals, or anything faster for Matthew to click than to automate.",
    ],
    parameters: Type.Object({
      outcome: Type.String({ description: "COMPLETE | PARTIAL | FAILED" }),
      summary: Type.String({ description: "One-sentence statement of what was delivered" }),
      head_sha: Type.Optional(Type.String({ description: "Exact final revision" })),
      branch: Type.Optional(Type.String()),
      pushed_sha: Type.Optional(Type.String({ description: "SHA pushed to the remote" })),
      verify_push: Type.Optional(Type.Boolean({ description: "Re-check the remote SHA now (default true for COMPLETE)" })),
      dogfood: Type.Optional(Type.Array(Type.String({ description: "Short human checks, one step each" }))),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      if (!job) return textResult("No active Studio mission to complete.", undefined, true);
      const outcome = normalizeOutcome(str(params["outcome"]));
      const summary = str(params["summary"]) ?? "";
      const branch = str(params["branch"]) || job.repo.branch || rt.facts.branch;
      const head = str(params["head_sha"]) || rt.facts.head_sha || job.repo.current_sha;
      const lastRecorded = job.evidence.pushed_shas[job.evidence.pushed_shas.length - 1] ?? "";
      const pushed = str(params["pushed_sha"]) || lastRecorded;
      const dogfood = strArray(params["dogfood"]);
      let pushVerified: boolean | undefined;
      let pushDetail = "not attempted";
      if (params["verify_push"] !== false && outcome === "COMPLETE" && branch) {
        const check = verifyRemoteSha(rt.location.repoRoot ?? ctx.cwd, branch, pushed || head);
        pushVerified = check.verified;
        pushDetail = check.detail;
        if (!check.verified) appendEvent(rt.location, "push-verify-failed", { job_id: job.job_id, detail: check.detail });
      }
      const candidate: JobState = {
        ...job,
        repo: { ...job.repo, current_sha: head || job.repo.current_sha },
        evidence: { ...job.evidence, pushed_shas: pushVerified === true && (pushed || head) ? [...new Set([...job.evidence.pushed_shas, pushed || head])] : job.evidence.pushed_shas },
      };
      const gate = evaluateCompletion(candidate, { outcome, summary, head_sha: head, branch, pushed_sha: pushed, push_verified: pushVerified, dogfood });
      if (gate.reaffirm) {
        return textResult(`${job.result?.receipt ?? renderReceipt(candidate, rt.facts, { push_verified: pushVerified })}\n\nAlready recorded as ${job.status}; nothing was re-declared.`, {
          job_id: job.job_id,
          outcome: job.status,
          reaffirmed: true,
        });
      }
      if (!gate.ok) {
        return textResult(
          ["COMPLETE refused — fix the evidence, record the honest outcome (PARTIAL/FAILED), or block with studio_blocked.", "", ...gate.problems.map((p) => `- ${p}`), "", `push check: ${pushDetail}`].join("\n"),
          { problems: gate.problems },
          true,
        );
      }
      // Render after the transition: a stored receipt must never describe a
      // mission it just closed as still WORKING.
      const completed = applyComplete(
        candidate,
        { outcome, summary, head_sha: head, branch, remote: job.repo.remote || rt.facts.remote, pushed_sha: pushed, push_verified: pushVerified, dogfood },
        "",
      );
      const receipt = renderReceipt(completed, rt.facts, { push_verified: pushVerified });
      const finalJob: JobState = completed.result ? { ...completed, result: { ...completed.result, receipt } } : completed;
      writeJob(rt.location, finalJob, { backup: true });
      appendEvent(rt.location, "complete", { job_id: finalJob.job_id, outcome, sha: finalJob.repo.current_sha, push_verified: pushVerified === true });
      updateStatus(ctx, finalJob, rt.config);
      safeNotify(ctx, `studio: ${outcome} — ${finalJob.job_id}`, outcome === "COMPLETE" ? "info" : "warning");
      return textResult(receipt, { job_id: finalJob.job_id, outcome, sha: finalJob.repo.current_sha, push_verified: pushVerified === true });
    },
  });

  pi.registerTool({
    name: "studio_status",
    label: "Studio status",
    description:
      "Read the durable mission ledger: status, objective, acceptance still open, current milestone, next action, evidence, blocker, continuation counters, and live Git facts. Use this after compaction or a restart instead of re-reading the conversation.",
    promptSnippet: "Read the active Studio mission state and live Git facts.",
    parameters: Type.Object({ include_packet: Type.Optional(Type.Boolean({ description: "Also return the original packet (first 4000 characters)" })) }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      if (!job) {
        const warn = describeUnreadable(rt.read, rt.location.dir);
        return textResult(
          [
            warn ?? "No active Studio mission.",
            `ledger: ${rt.location.dir} (${rt.location.source})`,
            `branch: ${rt.facts.branch || "(none)"} @ ${rt.facts.head_sha.slice(0, 10) || "(no commits)"}`,
            `dirty: ${rt.facts.dirty ? `${rt.facts.dirty_paths.length} path(s)` : "no"}`,
          ].join("\n"),
          undefined,
          true,
        );
      }
      const passed = job.evidence.checks.filter((c) => c.status === "pass").length;
      const lines = [
        renderMissionBrief(job),
        `ledger: ${rt.location.dir} (${rt.location.source})`,
        `dirty now: ${rt.facts.dirty ? `${rt.facts.dirty_paths.length} path(s)` : "no"}`,
        `upstream: ${rt.facts.upstream || "(none)"}`,
        `acceptance items: ${job.acceptance.length} · checks passed: ${passed} · checks recorded: ${job.evidence.checks.length}`,
        `continuation: ${job.continuation.allowed ? "armed" : "disarmed"} · turn ${job.continuation.runs}/${rt.config.maxTurns} · unchanged ${job.continuation.unchanged_streak}/${rt.config.maxUnchangedTurns} · errors ${job.continuation.error_streak}/${rt.config.maxErrorStreak}`,
        `lantern tools: ${lanternToolNames(pi).join(", ") || "not registered in this session"}`,
      ];
      if (params["include_packet"] === true) {
        const packet = readPacket(rt.location, job.job_id);
        lines.push("", "PACKET (first 4000 chars):", (packet ?? "(packet file missing)").slice(0, 4000));
      }
      return textResult(lines.join("\n"), { job_id: job.job_id, status: job.status, sha: job.repo.current_sha });
    },
  });

  pi.registerTool({
    name: "studio_context",
    label: "Studio context (Lantern)",
    description:
      "Narrow Lantern Keeper retrieval with honest degradation: asks the live Lantern MCP for a bounded context pack, and only falls back to the read-only lantern-git snapshot when the live service is unavailable and the snapshot is fresh enough. Records what path was actually used in the mission ledger. Repository and Git facts always outrank memory.",
    promptSnippet: "Retrieve bounded Lantern decisions/provenance for the mission, with degraded fallback.",
    promptGuidelines: [
      "Use studio_context only for decisions, provenance or history the repository cannot answer.",
      "Never treat a Lantern snapshot as current repository truth, and never dump whole memory into a mission.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Narrow question, e.g. 'why was the ledger placed in the git common dir'" }),
      intent: Type.Optional(Type.String({ description: "What the retrieval is for (Lantern actor intent)" })),
      item_budget: Type.Optional(Type.Number({ description: "Max records to return (1-20, default 6)" })),
      token_budget: Type.Optional(Type.Number({ description: "Approximate token ceiling for the pack" })),
    }),
    execute: async (_id, params, _signal, _update, ctx) => {
      const rt = runtimeFor(ctx);
      const job = jobOf(rt);
      const query = str(params["query"]) ?? "";
      if (!query.trim()) return textResult("studio_context needs a narrow query.", undefined, true);
      const itemBudget = Math.min(20, Math.max(1, Math.trunc(num(params["item_budget"]) ?? 6)));
      const tokenBudget = Math.min(16_000, Math.max(128, Math.trunc(num(params["token_budget"]) ?? 1200)));

      const toolCtx = ctx as PiToolContext;
      const names = discoverLanternTools(safeToolList(toolCtx));
      let mcpText: string | undefined;
      let mcpError: string | undefined;
      if (names) {
        try {
          const outcome = await toolCtx.executeTool(names.context, {
            query,
            intent: str(params["intent"]) ?? "autonomous mission context",
            item_budget: itemBudget,
            token_budget: tokenBudget,
          });
          mcpText = extractText(outcome);
          if (outcome?.isError) mcpError = mcpText ?? "Lantern MCP call failed";
        } catch (error) {
          mcpError = error instanceof Error ? error.message : String(error);
        }
      } else {
        mcpError = "no lantern MCP context tool registered in this session";
      }

      const snapshot = readSnapshot(query, rt.config.lanternMirror ?? {});
      const result = lanternContextResult(mcpText, mcpError, snapshot);
      if (job) {
        const remembered = applyMemory(job, { lantern: result.available ? "used" : "unavailable" });
        writeJob(rt.location, remembered);
        appendEvent(rt.location, "context-retrieval", {
          job_id: job.job_id,
          source: result.source,
          detail: result.detail.slice(0, 200),
        });
      }
      if (!result.available) {
        return textResult(`LANTERN: unavailable\n${result.detail}\nContinue from repository, Git and AGENTS.md facts; record lantern "unavailable" in the completion receipt.`, { source: "none" });
      }
      return textResult(`LANTERN ${result.source.toUpperCase()} — ${result.detail}\n\n${result.text.slice(0, 8000)}`, { source: result.source });
    },
  });
}

// ------------------------------------------------------------ helpers ------

const BLOCKER_KIND_DOC =
  "One of: credential, authentication, access, account-action, external-service, physical-interaction, judgement, irreversible-choice, external-approval, stalled, other";

function trusted(ctx: PiContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function safeGetAllTools(pi: PiApi): { name: string }[] {
  try {
    return pi.getAllTools();
  } catch {
    return [];
  }
}

function safeToolList(ctx: PiToolContext): { name: string }[] {
  return Array.isArray(ctx.tools) ? ctx.tools : [];
}

/** Flatten whatever shape a nested tool result came back in. */
function extractText(outcome: unknown): string | undefined {
  const rec = outcome as { content?: unknown; result?: { content?: unknown }; structuredContent?: unknown };
  const parts: string[] = [];
  const collect = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (typeof b?.text === "string" && b.text.trim()) parts.push(b.text);
    }
  };
  collect(rec?.content);
  collect(rec?.result?.content);
  if (rec?.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(rec.structuredContent));
    } catch {
      /* non-serialisable structured content */
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** Suffix match survives Pi's namespace separators (mcp__lantern__lantern_context). */
function lanternToolNames(pi: PiApi): string[] {
  return safeGetAllTools(pi)
    .map((t) => t.name)
    .filter((n) => /(^|__)(lantern_context|lantern_why|lantern_status)$/.test(n));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function parseChecks(value: unknown): { name: string; status: "pass" | "fail" | "skip"; detail?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { name: string; status: "pass" | "fail" | "skip"; detail?: string }[] = [];
  for (const item of value) {
    const rec = item as Record<string, unknown>;
    const name = typeof rec?.name === "string" ? rec.name : "";
    if (!name) continue;
    const raw = String(rec.status ?? "pass").toLowerCase();
    const status: "pass" | "fail" | "skip" = raw.startsWith("f") ? "fail" : raw.startsWith("s") ? "skip" : "pass";
    out.push({ name, status, detail: typeof rec.detail === "string" ? rec.detail : undefined });
  }
  return out.length ? out : undefined;
}

function lanternStatus(value: string | undefined): "used" | "not-needed" | "unavailable" | undefined {
  if (value === "used" || value === "not-needed" || value === "unavailable") return value;
  return undefined;
}

function normalizeKind(value: string | undefined): BlockerKind {
  const allowed: BlockerKind[] = [
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
  return (allowed as string[]).includes(value ?? "") ? (value as BlockerKind) : "other";
}

function normalizeOutcome(value: string | undefined): "COMPLETE" | "PARTIAL" | "FAILED" {
  const upper = (value ?? "").toUpperCase();
  return upper === "PARTIAL" || upper === "FAILED" ? upper : "COMPLETE";
}

export default function (pi: unknown): void {
  // Never throw at load: a broken extension must not stop Pi starting.
  try {
    registerStudio(pi as PiApi);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[matthew-way-studio] registration failed: ${message}`);
  }
}
