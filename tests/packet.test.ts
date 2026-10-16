import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { classifyInstruction, compilePacket, detectControlIntent, detectLegacyAdoptionIntent, detectReviewRecoveryIntent, explicitMissionResume, isSubstantivePacket, looksLikeResumeAttempt, parseSections } from "../src/packet.js";
import { requestsExecutionHold } from "../src/authority.js";

const PACKET = `# DEMO
## OBJECTIVE
Make the widget fast. The cache must be durable.

## SCOPE
- extension only
- no dashboard

## AUTHORITY
- local edits without asking

## CONSTRAINTS
- preserve unrelated work
- never switch provider

## ACCEPTANCE
- tests pass
- pushed SHA verified

## ATTENTION
- irreversible choices

# NON-GOALS
Do not create a workflow DSL.
`;

test("compilePacket extracts the six durable parts", () => {
  const c = compilePacket(PACKET);
  assert.equal(c.objective, "Make the widget fast.");
  assert.deepEqual(c.scope, ["extension only", "no dashboard"]);
  assert.deepEqual(c.authority, ["local edits without asking"]);
  assert.deepEqual(c.constraints, ["preserve unrelated work", "never switch provider", "NOT in scope: Do not create a workflow DSL."]);
  assert.deepEqual(c.acceptance, ["tests pass", "pushed SHA verified"]);
  assert.deepEqual(c.attention, ["irreversible choices"]);
});

test("compilePacket falls back to the first sentence when no OBJECTIVE exists", () => {
  const c = compilePacket("Repair the flaky test in parser.ts. It fails on Windows only.\n\nSome detail here.");
  assert.match(c.objective, /Repair the flaky test/);
  assert.ok(c.acceptance.length >= 1, "acceptance always has a floor");
  assert.ok(c.attention.length >= 1, "attention always has a floor");
});

test("parseSections honours hash, bold and labelled headings", () => {
  const labels = parseSections("OBJECTIVE: build it\nmore detail\n**SCOPE**\n- one thing\n").map((s) => s.heading);
  assert.ok(labels.includes("OBJECTIVE"));
  assert.ok(labels.includes("SCOPE"));
});

test("noise-only sections do not become fake constraints", () => {
  const c = compilePacket("## OBJECTIVE\nDo it\n\n## CONSTRAINTS\nnone\nN/A\n");
  assert.deepEqual(c.constraints, []);
});

test("isSubstantivePacket starts missions for packets but not for small asks", () => {
  assert.equal(isSubstantivePacket("rename the variable foo to bar"), false);
  assert.equal(isSubstantivePacket("please run the tests and tell me what failed"), false);
  assert.equal(isSubstantivePacket(PACKET), true);
  assert.equal(isSubstantivePacket("x".repeat(1600)), true);
  assert.equal(isSubstantivePacket("a\n".repeat(2) + "b".repeat(700)), false, "700 chars with 3 lines is still a small ask");
});

test("detectControlIntent reads ordinary language", () => {
  assert.equal(detectControlIntent("stop the mission"), "pause");
  assert.equal(detectControlIntent("pause the run for now"), "pause");
  assert.equal(detectControlIntent("don't continue"), "pause");
  assert.equal(detectControlIntent("continue"), "resume");
  assert.equal(detectControlIntent("resume the mission"), "resume");
  assert.equal(detectControlIntent("/studio start"), "resume");
  assert.equal(detectControlIntent("go ahead"), "resume");
  assert.equal(detectControlIntent("rename foo to bar"), undefined);
  assert.equal(detectControlIntent("x".repeat(500)), undefined, "long prose is a packet, not a control word");
});

test("explicit packet holds are recognised without holding ordinary delivery", () => {
  assert.equal(requestsExecutionHold("Plan only. Do not execute yet."), true);
  assert.equal(requestsExecutionHold("Inspect only and wait for my approval."), true);
  assert.equal(requestsExecutionHold("Don't execute until I approve."), true);
  assert.equal(requestsExecutionHold("Implement, test, commit and push the fix."), false);
  assert.equal(requestsExecutionHold("- Do not implement a second harness."), false);
  assert.equal(requestsExecutionHold("Build a read-only API."), false);
});

test("resume attempts are recognised without assuming resolution", () => {
  assert.equal(looksLikeResumeAttempt("I added the key to auth.json"), "attempt");
  assert.equal(looksLikeResumeAttempt("done"), "attempt");
  assert.equal(looksLikeResumeAttempt("why is the sky blue"), "unrelated");
  assert.equal(looksLikeResumeAttempt(""), "unrelated");
});

test("review recovery vocabulary is narrow: only explicit phrases release the wait", () => {
  assert.equal(detectReviewRecoveryIntent("cancel review wait"), "resume");
  assert.equal(detectReviewRecoveryIntent("resume the mission"), "resume");
  assert.equal(detectReviewRecoveryIntent("resume from review wait and continue"), "resume");
  assert.equal(detectReviewRecoveryIntent("park the mission"), "park");
  assert.equal(detectReviewRecoveryIntent("cancel review wait and park it"), "park");
  assert.equal(detectReviewRecoveryIntent("go ahead"), undefined, "vague continuation never releases the wait");
  assert.equal(detectReviewRecoveryIntent("continue"), undefined);
  assert.equal(detectReviewRecoveryIntent("looks good, thanks"), undefined);
  assert.equal(detectReviewRecoveryIntent("x".repeat(500)), undefined);
});

test("legacy adoption needs the words adopt and legacy plus an exact job id", () => {
  assert.equal(detectLegacyAdoptionIntent("adopt legacy job job-20261014-abcdef12"), "job-20261014-abcdef12");
  assert.equal(detectLegacyAdoptionIntent("please adopt the legacy job job-x for this session"), "job-x");
  assert.equal(detectLegacyAdoptionIntent("adopt legacy job"), undefined, "no id, no adoption");
  assert.equal(detectLegacyAdoptionIntent("adopt job job-x"), undefined, "legacy must be named");
  assert.equal(detectLegacyAdoptionIntent("here is the legacy job job-x"), undefined, "adopt must be named");
  assert.equal(detectLegacyAdoptionIntent("thanks"), undefined);
});

test("classifyInstruction separates new work, duplicates, corrections and steering", () => {
  const text = [
    "# P",
    "## OBJECTIVE",
    "Add the status file to the repository.",
    "## SCOPE",
    "- one",
    "## ACCEPTANCE",
    "- done",
    "Pad the packet with enough ordinary detail that a real harness treats it as a substantive mission rather than a one-line ask. ".repeat(4),
  ].join("\n");
  const sha = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const active = { objective: compilePacket(text).objective, packetSha256: sha };
  assert.equal(classifyInstruction(text, active), "duplicate", "the mission's own packet re-pasted is a duplicate");
  assert.equal(classifyInstruction(text.replace("- one", "- two"), active), "correction", "same objective is a correction");
  assert.equal(classifyInstruction(text.replace("Add the status file", "Build the cache layer"), active), "new-instruction", "a different objective is new work");
  assert.equal(classifyInstruction("why is the sky blue", active), "steering");
  assert.equal(classifyInstruction(text, undefined), "new-instruction", "without a live mission, a packet seeds one");
});

test("reopening closed work takes explicit mission-level resume language", () => {
  assert.equal(explicitMissionResume("resume the mission and finish the item"), true);
  assert.equal(explicitMissionResume("continue the studio job"), true);
  assert.equal(explicitMissionResume("continue"), false, "bare continuation words are not enough");
  assert.equal(explicitMissionResume("go ahead"), false);
  assert.equal(explicitMissionResume("why is the sky blue"), false);
});
