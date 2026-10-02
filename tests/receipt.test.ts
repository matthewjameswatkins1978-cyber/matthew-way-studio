import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMissionBrief, renderNeedsHuman, renderReceipt, machineEvidence } from "../src/receipt.js";
import { newJob, type JobState } from "../src/schema.js";
import type { RepoFacts } from "../src/git.js";

const facts: RepoFacts = {
  root: "/repo",
  is_repo: true,
  remote: "https://github.com/acme/widget.git",
  branch: "main",
  head_sha: "e".repeat(40),
  dirty: false,
  dirty_paths: [],
  upstream: "origin/main",
  detached: false,
};

function job(over: Partial<JobState> = {}): JobState {
  return {
    ...newJob({
      jobId: "job-receipt",
      contract: {
        objective: "Ship the runtime.",
        scope: ["extension"],
        authority: [],
        constraints: [],
        acceptance: ["tests pass"],
        attention: ["irreversible choices"],
      },
      repo: { root: "/repo", remote: "https://github.com/acme/widget.git", branch: "feature/runtime", base_sha: "a".repeat(40), current_sha: "b".repeat(40), dirty_at_start: false },
      packet: { sha256: "c".repeat(64), bytes: 12, path: "/repo/.git/matthew-way-studio/jobs/job-receipt/packet.md" },
      nextAction: "write the receipt test",
    }),
    ...over,
  };
}

test("receipt carries exactly the fields Lucy needs, in order", () => {
  const done = job({
    status: "COMPLETE",
    result: { outcome: "COMPLETE", summary: "runtime shipped" },
    evidence: {
      checks: [
        { name: "npm test", status: "pass", detail: "48 pass", at: "2026-10-02T00:00:00.000Z" },
        { name: "tsc --noEmit", status: "pass", at: "2026-10-02T00:00:00.000Z" },
      ],
      commits: ["b".repeat(40)],
      pushed_shas: ["b".repeat(40)],
      artifacts: ["extensions/index.ts"],
    },
    memory: { lantern: "used", lantern_refs: ["mem-42"], decisions_loaded: ["state lives in git common dir"] },
  });
  const text = renderReceipt(done, facts, { push_verified: true });
  const order = ["RESULT:", "OBJECTIVE", "REPO", "BRANCH", "SHA", "PUSH", "MACHINE EVIDENCE", "IMPORTANT DECISIONS", "LANTERN", "HUMAN DOGFOOD", "UNRESOLVED", "HUMAN ATTENTION"];
  let cursor = -1;
  for (const label of order) {
    const at = text.indexOf(label);
    assert.notEqual(at, -1, `missing ${label}`);
    assert.ok(at > cursor, `${label} out of order`);
    cursor = at;
  }
  assert.match(text, /^RESULT: COMPLETE$/m);
  assert.match(text, /acme\/widget/);
  assert.match(text, /^BRANCH\nfeature\/runtime$/m);
  assert.match(text, new RegExp(`^SHA\n${"b".repeat(40)}`, "m"));
  assert.match(text, /^PUSH\nverified$/m);
  assert.match(text, /npm test: PASS — 48 pass/);
  assert.match(text, /LANTERN\ncontext used \(handles: mem-42\)/);
  assert.match(text, /HUMAN DOGFOOD\nnone/);
  assert.match(text, /HUMAN ATTENTION\nnone/);
});

test("unverified push is reported as unverified, never optimistic", () => {
  const j = job({ status: "PARTIAL", result: { outcome: "PARTIAL", summary: "local only" } });
  const text = renderReceipt(j, facts, { push_verified: false });
  assert.match(text, /^PUSH\nnot verified$/m);
  assert.match(text, /UNRESOLVED\nno pushed SHA recorded/);
});

test("human dogfood renders as one short numbered check", () => {
  const j = job({
    status: "COMPLETE",
    result: { outcome: "COMPLETE", summary: "gui tweak" },
    evidence: { checks: [{ name: "npm test", status: "pass", at: "now" }], commits: [], pushed_shas: ["z"], artifacts: [] },
    human_dogfood: { status: "pending", checks: ["Open Pi", "Paste a packet", "Tell Lucy/Pi whether it ran"] },
  });
  const text = renderReceipt(j, facts);
  assert.match(text, /HUMAN DOGFOOD\n1\. Open Pi\n2\. Paste a packet\n3\. Tell Lucy\/Pi whether it ran/);
  assert.match(text, /HUMAN ATTENTION\nrun the HUMAN DOGFOOD check/);
});

test("NEEDS_HUMAN block states the one need, why, and no commands for Matthew", () => {
  const blocked = job({
    status: "NEEDS_HUMAN",
    blocker: {
      kind: "credential",
      reason: "Pi has no GitHub token for this account",
      exact_human_need: "run gh auth login once on this machine",
      state_preserved: "branch feature/runtime at " + "b".repeat(40),
      resume_condition: "gh auth status reports a token",
      signature: "credential::token",
      times_raised: 1,
    },
    progress: { milestone: "M3", next_action: "push and verify SHA", attempts: 2, child_work: "" },
    evidence: { checks: [{ name: "npm test", status: "pass", at: "now" }], commits: ["b".repeat(40)], pushed_shas: [], artifacts: [] },
  });
  const text = renderNeedsHuman(blocked, facts, {
    exact_human_need: "run gh auth login once on this machine",
    reason: "Pi has no GitHub token for this account",
    resume_condition: "gh auth status reports a token",
    next_action: "push and verify SHA",
  });
  assert.match(text, /^NEEDS_HUMAN\n/);
  assert.match(text, /WHAT I NEED\nrun gh auth login once on this machine/);
  assert.match(text, /ALREADY COMPLETE\nmilestone: M3/);
  assert.match(text, /STATE\nacme\/widget \/ feature\/runtime \/ b{40}/);
  assert.match(text, /WHEN YOU HAVE DONE IT\nReply normally\. No special command required\./);
  assert.match(text, /NEXT ACTION\npush and verify SHA/);
  assert.match(text, /RESUME CONDITION\ngh auth status reports a token/);
});

test("mission brief stays compact and names the packet file", () => {
  const j = job({ constraints: Array.from({ length: 30 }, (_, i) => `constraint ${i}`) });
  const brief = renderMissionBrief(j);
  assert.match(brief, /STUDIO MISSION job-receipt \[WORKING\]/);
  assert.match(brief, /OBJECTIVE: Ship the runtime./);
  assert.match(brief, /NEXT ACTION: write the receipt test/);
  assert.match(brief, /PACKET: .+packet\.md \(sha256 c{12}\)/);
  assert.ok(brief.length < 4000, `brief must stay small (${brief.length})`);
});

test("machineEvidence reports nothing as nothing", () => {
  assert.equal(machineEvidence(job()), "none recorded");
});

test("IMPORTANT DECISIONS never disguises scope as a decision", () => {
  assert.match(renderReceipt(job(), facts), /IMPORTANT DECISIONS\nnone recorded/);
  const decided = job({ memory: { lantern: "not-needed", lantern_refs: [], decisions_loaded: ["state lives in the git common dir"] } });
  assert.match(renderReceipt(decided, facts), /IMPORTANT DECISIONS\n- state lives in the git common dir/);
});

test("a relative local remote is shown with the repository root", () => {
  const local = job({ repo: { root: "/srv/build/widget", remote: "../widget.git", branch: "main", base_sha: "a", current_sha: "b", dirty_at_start: false } });
  assert.match(renderReceipt(local, facts), /REPO\n\.\.\/widget\.git \(\/srv\/build\/widget\)/);
  assert.match(renderReceipt(job(), facts), /^REPO\nacme\/widget$/m, "a hosted remote stays canonical and bare");
});
