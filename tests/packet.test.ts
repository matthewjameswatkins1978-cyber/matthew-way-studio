import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePacket, detectControlIntent, isSubstantivePacket, looksLikeResumeAttempt, parseSections } from "../src/packet.js";

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
  assert.equal(detectControlIntent("rename foo to bar"), undefined);
  assert.equal(detectControlIntent("x".repeat(500)), undefined, "long prose is a packet, not a control word");
});

test("resume attempts are recognised without assuming resolution", () => {
  assert.equal(looksLikeResumeAttempt("I added the key to auth.json"), "attempt");
  assert.equal(looksLikeResumeAttempt("done"), "attempt");
  assert.equal(looksLikeResumeAttempt("why is the sky blue"), "unrelated");
  assert.equal(looksLikeResumeAttempt(""), "unrelated");
});
