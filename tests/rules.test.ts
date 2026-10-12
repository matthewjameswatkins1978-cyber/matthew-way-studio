import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_RULES,
  MATTHEW_WAY_RULES,
  currentRuleSnapshot,
  legacyRuleSnapshot,
  parseRuleSnapshot,
  snapshotRuleSet,
  validateRuleSet,
} from "../src/rules.js";

test("Threadmoth previews establish a checkout boundary and reject mirror-root mismatch", () => {
  const statement = MATTHEW_WAY_RULES.find((r) => r.key === "scope.threadmoth-first" && r.status === "active")?.statement ?? "";
  assert.match(statement, /Before the first Threadmoth preview/);
  assert.match(statement, /budget\.allowed_path_prefixes/);
  assert.match(statement, /outside the boundary/);
  assert.match(statement, /configured workspace root is established to match that checkout/);
  assert.match(statement, /project mirror or another workspace/);
  assert.match(statement, /repository-local Threadmoth CLI from the active checkout root/);
});

test("current rules are deterministic and include the forgiving-friction law", () => {
  const a = currentRuleSnapshot();
  const b = currentRuleSnapshot();
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a, b);
  const friction = a.entries.find((r) => r.key === "friction.absorb-noise");
  assert.ok(friction);
  assert.match(friction?.statement ?? "", /typos|crossed wires/i);
});

test("later attention rule explicitly supersedes the original one", () => {
  validateRuleSet(MATTHEW_WAY_RULES);
  const current = currentRuleSnapshot();
  const attention = current.entries.find((r) => r.key === "attention.human-only");
  assert.equal(attention?.revision, 2);
  assert.match(attention?.statement ?? "", /Before NEEDS_HUMAN/);
});

test("legacy missions retain the original rules rather than silently upgrading", () => {
  validateRuleSet(LEGACY_RULES);
  const legacy = legacyRuleSnapshot();
  const current = currentRuleSnapshot();
  assert.notEqual(legacy.digest, current.digest);
  assert.equal(legacy.entries.some((r) => r.key === "friction.absorb-noise"), false);
  assert.equal(legacy.entries.some((r) => r.key === "scope.threadmoth-first"), false);
  assert.equal(current.entries.some((r) => r.key === "scope.threadmoth-first"), true);
  assert.equal(legacy.entries.find((r) => r.key === "attention.human-only")?.revision, 1);
});

test("rule validation rejects contradictory active revisions", () => {
  const bad = [
    { key: "x", revision: 1, category: "attention" as const, status: "active" as const, statement: "one" },
    { key: "x", revision: 2, category: "attention" as const, status: "active" as const, statement: "two", supersedes: [1] },
  ];
  assert.throws(() => validateRuleSet(bad), /exactly one active revision/);
});

test("a mission rules snapshot is self-verifying", () => {
  const snapshot = currentRuleSnapshot();
  assert.deepEqual(parseRuleSnapshot(snapshot), snapshot);
  assert.throws(() => parseRuleSnapshot({ ...snapshot, digest: "sha256:deadbeef" }), /digest mismatch/);
  assert.deepEqual(snapshotRuleSet(MATTHEW_WAY_RULES), snapshot);
});
