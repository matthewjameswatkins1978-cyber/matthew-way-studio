/**
 * Recovery, inbox discovery, and legacy-adoption regressions for the stacked
 * review PRs. Drives the real extension against a fake Pi 1.2.0 harness:
 *   - a genuine user-originated command recovers WAITING_REVIEW; custom
 *     messages, vague continuations, and other workers' jobs never do;
 *   - a waiting worker discovers its inbox after restart with no ID ferrying;
 *   - legacy missions are never auto-claimed; adoption is explicit;
 *   - acknowledgement never merges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { registerStudio } from "../extensions/index.js";
import { readJob, readEvents, writeJob } from "../src/ledger.js";
import { ledgerLocation } from "../src/paths.js";
import { importReviewComment } from "../src/review.js";
import { applyReviewWait } from "../src/mission.js";
import { newJob } from "../src/schema.js";
import type {
  PiApi,
  PiBeforeAgentStartEvent,
  PiContext,
  PiToolContext,
  PiToolDefinition,
} from "../src/pi-shim.js";

interface Harness {
  tools: Map<string, PiToolDefinition>;
  events: Map<string, Array<(event: any, ctx: PiContext) => any>>;
  notifications: string[];
  api: PiApi;
}

function makeHarness(): Harness {
  const tools = new Map<string, PiToolDefinition>();
  const events = new Map<string, Array<(event: any, ctx: PiContext) => any>>();
  const notifications: string[] = [];
  const api: PiApi = {
    on(event, handler) {
      const list = events.get(event) ?? [];
      list.push(handler as any);
      events.set(event, list);
      return () => {};
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    getAllTools: () => [{ name: "read" }],
  };
  return { tools, events, notifications, api };
}

function ctxFor(cwd: string, harness: Harness, sessionId?: string): PiToolContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    ui: {
      notify: (message) => harness.notifications.push(message),
      setStatus: () => {},
    },
    isProjectTrusted: () => true,
    ...(sessionId ? { sessionManager: { getSessionId: () => sessionId } } : {}),
    tools: [{ name: "read" }],
    executeTool: async () => ({ isError: false, content: [] }),
  } as PiToolContext;
}

async function emit(harness: Harness, event: string, payload: any, ctx: PiContext): Promise<any> {
  const handlers = harness.events.get(event) ?? [];
  let last: any;
  for (const handler of handlers) last = await handler(payload, ctx);
  return last;
}

function tempRepo(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-recovery-"));
  const remote = path.join(base, "remote.git");
  const dir = path.join(base, "repo");
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
  execFileSync("git", ["init", "--initial-branch=main", dir], { encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "studio@test.local"], { cwd: dir, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Studio Test"], { cwd: dir, encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "README.md"), "# recovery\n", "utf8");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

const HEAD40 = "d".repeat(40);

function waitingJob(dir: string, sessionId: string): void {
  const loc = ledgerLocation(dir, sessionId);
  const base = newJob({
    jobId: "job-recovery-test",
    contract: { objective: "recovery test", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: dir, remote: "https://github.com/owner/repo.git", branch: "feature/review", base_sha: HEAD40, current_sha: HEAD40, dirty_at_start: false },
    packet: { sha256: "e".repeat(64), bytes: 4, path: "packet.md" },
    nextAction: "wait",
  });
  const wait = applyReviewWait(base, { repository: "owner/repo", pull_request: 35, url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD40, worker_session_id: sessionId, requested_review: "general" });
  writeJob(loc, { ...wait, worker_session_id: sessionId });
}

function agentStart(prompt: string, messageType?: "user" | "custom"): PiBeforeAgentStartEvent {
  return { type: "before_agent_start", prompt, systemPrompt: "", systemPromptOptions: {}, ...(messageType ? { messageType } : {}) } as PiBeforeAgentStartEvent;
}

test("a genuine user 'cancel review wait' recovers the mission without reviewer approval", async () => {
  const dir = tempRepo();
  waitingJob(dir, "worker-1");
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-1");
  const event = agentStart("cancel review wait — the reviewer is offline, I will direct the next step myself", "user");
  await emit(harness, "before_agent_start", event, ctx);
  const after = readJob(ledgerLocation(dir, "worker-1"));
  assert.equal(after.kind === "loaded" && after.job.status, "WORKING");
  if (after.kind !== "loaded") return;
  assert.match(after.job.continuation.reason, /not reviewer approval/);
  assert.match(event.systemPromptOptions.sections?.["studio_mission"] ?? "", /STUDIO MISSION/);
  const recovery = readEvents(ledgerLocation(dir, "worker-1")).find((e) => e.type === "review-wait-recovery");
  assert.equal((recovery as any)?.human_override, true);
  assert.equal((recovery as any)?.mode, "resume");
  assert.ok(harness.notifications.some((n) => n.includes("not reviewer approval")));
});

test("a genuine user 'resume the mission' releases the wait; 'park the mission' blocks instead", async () => {
  const dir = tempRepo();
  waitingJob(dir, "worker-1");
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-1");
  await emit(harness, "before_agent_start", agentStart("resume the mission", "user"), ctx);
  assert.equal(readJob(ledgerLocation(dir, "worker-1")).kind === "loaded" && (readJob(ledgerLocation(dir, "worker-1")) as any).job.status, "WORKING");

  waitingJob(dir, "worker-1");
  await emit(harness, "before_agent_start", agentStart("park the mission — wait for my direction", "user"), ctx);
  const parked = readJob(ledgerLocation(dir, "worker-1"));
  assert.equal(parked.kind === "loaded" && parked.job.status, "NEEDS_HUMAN");
});

test("custom messages, vague continuations, and other workers never release the wait", async () => {
  const dir = tempRepo();
  waitingJob(dir, "worker-1");
  const harness = makeHarness();
  registerStudio(harness.api);
  const ownerCtx = ctxFor(dir, harness, "worker-1");
  const status = (sessionId: string) => readJob(ledgerLocation(dir, sessionId));

  await emit(harness, "before_agent_start", agentStart("cancel review wait", "custom"), ownerCtx);
  assert.equal(status("worker-1").kind === "loaded" && (status("worker-1") as any).job.status, "WAITING_REVIEW", "model/custom text cannot release the wait");

  await emit(harness, "before_agent_start", agentStart("go ahead", "user"), ownerCtx);
  assert.equal((status("worker-1") as any).job.status, "WAITING_REVIEW", "vague continuation stays quiet");

  await emit(harness, "before_agent_start", agentStart("continue", "user"), ownerCtx);
  assert.equal((status("worker-1") as any).job.status, "WAITING_REVIEW");

  const intruderCtx = ctxFor(dir, harness, "worker-2");
  await emit(harness, "before_agent_start", agentStart("cancel review wait", "user"), intruderCtx);
  assert.equal((status("worker-1") as any).job.status, "WAITING_REVIEW", "another worker cannot recover this job");
  assert.deepEqual(readJob(ledgerLocation(dir, "worker-2")), { kind: "none" }, "the intruder gains no mission of its own");

  // A session-less reader that somehow loads another worker's job is refused out loud.
  const unscoped = ledgerLocation(dir);
  const owned = readJob(ledgerLocation(dir, "worker-1"));
  assert.equal(owned.kind, "loaded");
  if (owned.kind !== "loaded") return;
  writeJob(unscoped, owned.job);
  await emit(harness, "before_agent_start", agentStart("cancel review wait", "user"), ctxFor(dir, harness));
  assert.ok(harness.notifications.some((n) => n.includes("another Pi session")));
});

test("restart announces the pending inbox with exact IDs and the worker receives it", async () => {
  const dir = tempRepo();
  waitingJob(dir, "worker-1");
  const envelope = { repository: "owner/repo", pull_request: 35, job_id: "job-recovery-test", worker_session_id: "worker-1", head_sha: HEAD40, decision: "changes_requested" };
  const imported = importReviewComment({
    location: ledgerLocation(dir, "importer"), repository: "owner/repo", commentId: 9201,
    authorizedReviewers: ["lucy-reviewer"], cwd: dir, now: Date.parse("2026-10-14T12:00:00.000Z"),
    readComment: () => ({ id: 9201, user: { login: "lucy-reviewer" }, issue_url: "https://api.github.com/repos/owner/repo/issues/35", body: `Two findings.\n<!-- mws-review/v1\n${JSON.stringify(envelope)}\n-->`, created_at: "2026-10-14T10:00:00.000Z" }),
    readPullRequest: () => ({ ok: true, pull_request: { repository: "owner/repo", number: 35, state: "open", url: "https://github.com/owner/repo/pull/35", branch: "feature/review", head_sha: HEAD40 } }),
  });
  assert.equal(imported.ok, true);
  if (!imported.ok) return;

  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-1");
  await emit(harness, "session_start", { type: "session_start", reason: "resume" }, ctx);
  assert.ok(harness.notifications.some((n) => n.includes(imported.delivery.id)), "restart announces the exact delivery ID");

  const listed = await harness.tools.get("studio_pending_reviews")!.execute("p1", {}, undefined, undefined, ctx);
  assert.match(listed.content[0]?.text ?? "", new RegExp(imported.delivery.id));

  const received = await harness.tools.get("studio_receive_review")!.execute("p2", { delivery_id: imported.delivery.id }, undefined, undefined, ctx);
  assert.match(received.content[0]?.text ?? "", /Two findings/);

  const acked = await harness.tools.get("studio_ack_review")!.execute("p3", { delivery_id: imported.delivery.id }, undefined, undefined, ctx);
  // No live GitHub PR backs this disposable repo, so the tool fails closed
  // instead of resuming on an unverified head. The positive ack path with a
  // verified live PR is covered in review-authority.test.ts.
  assert.match(acked.content[0]?.text ?? "", /refusing stale review delivery/);
  const after = readJob(ledgerLocation(dir, "worker-1"));
  assert.equal(after.kind === "loaded" && after.job.status, "WAITING_REVIEW", "unverified heads never resume the worker");
  assert.equal(after.kind === "loaded" && after.job.repo.branch, "feature/review", "acknowledgement never merges or moves branches");
});

test("legacy missions are never auto-claimed; studio_adopt_legacy is explicit and preserving", async () => {
  const dir = tempRepo();
  const legacy = newJob({
    jobId: "job-legacy-harness",
    contract: { objective: "legacy harness", scope: [], authority: [], constraints: [], acceptance: [], attention: [] },
    repo: { root: dir, remote: "", branch: "main", base_sha: HEAD40, current_sha: HEAD40, dirty_at_start: false },
    packet: { sha256: "f".repeat(64), bytes: 4, path: "packet.md" },
    nextAction: "wait",
  });
  writeJob(ledgerLocation(dir), legacy);
  const harness = makeHarness();
  registerStudio(harness.api);
  const ctx = ctxFor(dir, harness, "worker-9");

  await emit(harness, "before_agent_start", agentStart("thanks", "user"), ctx);
  assert.deepEqual(readJob(ledgerLocation(dir, "worker-9")), { kind: "none" }, "an unrelated session never inherits the mission");

  const wrong = await harness.tools.get("studio_adopt_legacy")!.execute("a1", { job_id: "job-nope" }, undefined, undefined, ctx);
  assert.equal(wrong.isError, true);

  const adopted = await harness.tools.get("studio_adopt_legacy")!.execute("a2", { job_id: "job-legacy-harness" }, undefined, undefined, ctx);
  assert.match(adopted.content[0]?.text ?? "", /Adopted legacy mission job-legacy-harness/);
  const owned = readJob(ledgerLocation(dir, "worker-9"));
  assert.equal(owned.kind === "loaded" && owned.job.worker_session_id, "worker-9");
  const key = createHash("sha256").update("worker-9").digest("hex").slice(0, 24);
  assert.equal(fs.existsSync(path.join(ledgerLocation(dir).dir, "active-job.json")), true, "legacy snapshot preserved");
  assert.equal(fs.existsSync(path.join(ledgerLocation(dir).dir, `active-job.${key}.json`)), true, "scoped copy written");
});
