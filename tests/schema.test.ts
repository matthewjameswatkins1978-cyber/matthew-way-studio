import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATUSES,
  applyTransition,
  canTransition,
  newJob,
  normalizeJob,
  progressSignature,
  terminalStatus,
  JobParseError,
  SCHEMA_VERSION,
  type JobState,
} from "../src/schema.js";

function baseJob(): JobState {
  return newJob({
    jobId: "job-test",
    contract: {
      objective: "Make the packet runtime autonomous.",
      scope: ["extension"],
      authority: ["local edits"],
      constraints: ["no new harness"],
      acceptance: ["tests pass"],
      attention: ["irreversible choices"],
    },
    repo: { root: "/tmp/r", remote: "git@x:y/r.git", branch: "main", base_sha: "a".repeat(40), current_sha: "a".repeat(40), dirty_at_start: false },
    packet: { sha256: "z".repeat(64), bytes: 10, path: "/tmp/p.md" },
    nextAction: "implement ledger",
  });
}

test("status machine allows the documented edges only", () => {
  assert.equal(canTransition("WORKING", "NEEDS_HUMAN"), true);
  assert.equal(canTransition("NEEDS_HUMAN", "WORKING"), true);
  assert.equal(canTransition("WORKING", "COMPLETE"), true);
  assert.equal(canTransition("NEEDS_HUMAN", "COMPLETE"), false, "a blocked mission must resume before completing");
  assert.equal(canTransition("COMPLETE", "NEEDS_HUMAN"), false);
  assert.equal(canTransition("COMPLETE", "WORKING"), true, "reopening for more work is legal");
  for (const from of STATUSES) {
    assert.equal(canTransition(from, from), true, `${from} -> ${from} is a no-op edge`);
  }
  assert.equal(terminalStatus("PARTIAL"), true);
  assert.equal(terminalStatus("WORKING"), false);
});

test("illegal transition is refused, not silently coerced", () => {
  const job = { ...baseJob(), status: "COMPLETE" as const };
  assert.throws(() => applyTransition(job, "NEEDS_HUMAN"), JobParseError);
});

test("normalizeJob migrates a v0 record forward with defaults", () => {
  const v0 = {
    job_id: "job-old",
    status: "WORKING",
    objective: "Legacy mission objective",
    repo: { root: "/r", branch: "main", base_sha: "b".repeat(40) },
  };
  const job = normalizeJob(v0);
  assert.equal(job.schema_version, SCHEMA_VERSION);
  assert.equal(job.status, "WORKING");
  assert.equal(job.acceptance.length, 0);
  assert.equal(job.continuation.allowed, true);
  assert.deepEqual(job.evidence.checks, []);
  assert.equal(job.human_dogfood.status, "none");
});

test("normalizeJob rejects a newer schema instead of guessing", () => {
  assert.throws(() => normalizeJob({ schema_version: 99, objective: "x", status: "WORKING" }), /newer than runtime/);
});

test("normalizeJob rejects unknown status and missing objective", () => {
  assert.throws(() => normalizeJob({ schema_version: 1, objective: "x", status: "DOING" }), JobParseError);
  assert.throws(() => normalizeJob({ schema_version: 1, status: "WORKING" }), /no objective/);
});

test("normalizeJob tolerates junk lists and coerces check statuses", () => {
  const job = normalizeJob({
    schema_version: 1,
    job_id: "job-salvage",
    status: "WORKING",
    objective: "Salvage",
    scope: ["real", 42, null, ""],
    evidence: { checks: [{ name: "npm test", status: "failed" }, { name: "tsc", at: "2026-01-01T00:00:00Z" }] },
  });
  assert.deepEqual(job.scope, ["real"]);
  assert.equal(job.evidence.checks.length, 2);
  assert.equal(job.evidence.checks[0]?.status, "fail");
  assert.equal(job.evidence.checks[1]?.status, "pass");
});

test("progressSignature changes only on observable progress", () => {
  const a = baseJob();
  const b: JobState = { ...a, progress: { ...a.progress, milestone: "ledger done" } };
  assert.notEqual(progressSignature(a), progressSignature(b));
  const c: JobState = { ...a, created_at: "2020-01-01T00:00:00Z" };
  assert.equal(progressSignature(a), progressSignature(c), "timestamps must not fake progress");
});
