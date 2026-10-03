/**
 * Canonical Matthew Way operating rules for Studio.
 *
 * Rules are deliberately data, not scattered prompt prose. A mission snapshots
 * the active entries and their digest at start, so later rule edits cannot
 * silently change the meaning of work already in flight.
 */

import { createHash } from "node:crypto";

export type RuleCategory =
  | "autonomy"
  | "progress"
  | "attention"
  | "friction"
  | "truth"
  | "evidence"
  | "scope"
  | "shipping";

export type RuleStatus = "active" | "superseded";

export interface RuleDefinition {
  key: string;
  revision: number;
  category: RuleCategory;
  status: RuleStatus;
  statement: string;
  supersedes?: number[];
}

export interface RuleSnapshotEntry {
  key: string;
  revision: number;
  category: RuleCategory;
  statement: string;
}

export interface RuleSnapshot {
  schema: "matthew-way.rules-snapshot/1";
  digest: string;
  entries: RuleSnapshotEntry[];
}

const SHARED_RULES: readonly RuleDefinition[] = [
  {
    key: "autonomy.act-within-authority",
    revision: 1,
    category: "autonomy",
    status: "active",
    statement: "Run the mission autonomously inside granted authority. Do not ask Matthew to approve an internally sensible, reversible plan.",
  },
  {
    key: "progress.do-the-work",
    revision: 1,
    category: "progress",
    status: "active",
    statement: "Work the next concrete action now. Status narration by itself is not progress; checkpoint when repo state, evidence, understanding, or the next action materially changes.",
  },
  {
    key: "evidence.outranks-narration",
    revision: 1,
    category: "evidence",
    status: "active",
    statement: "Evidence outranks narration. Run the cheapest trustworthy check and never claim an effect, test result, or push that was not observed.",
  },
  {
    key: "scope.preserve-unrelated",
    revision: 1,
    category: "scope",
    status: "active",
    statement: "Preserve unrelated work and keep changes scoped to the mission.",
  },
  {
    key: "progress.change-approach",
    revision: 1,
    category: "progress",
    status: "active",
    statement: "Never repeat an unchanged failure blindly. Reinspect reality, change approach, or escalate only when the remaining dependency is genuinely human-owned.",
  },
  {
    key: "shipping.verify-remote",
    revision: 1,
    category: "shipping",
    status: "active",
    statement: "Before COMPLETE, ship through the sanctioned path and verify the remote revision. Completion is an evidence transition, not a confidence statement.",
  },
];

const LEGACY_ATTENTION_RULE: RuleDefinition = {
  key: "attention.human-only",
  revision: 1,
  category: "attention",
  status: "active",
  statement: "Use NEEDS_HUMAN only when Pi truly cannot supply the missing capability itself.",
};

/**
 * Behaviour of the original 0.1 runtime. Used only when migrating an already
 * active v1 mission, so an upgrade never changes its rules underneath it.
 */
export const LEGACY_RULES: readonly RuleDefinition[] = [...SHARED_RULES, LEGACY_ATTENTION_RULE];

export const MATTHEW_WAY_RULES: readonly RuleDefinition[] = [
  ...SHARED_RULES,
  {
    key: "scope.threadmoth-first",
    revision: 1,
    category: "scope",
    status: "active",
    statement: "Use Threadmoth by default for supported file edits: preview, mutate, then verify the certificate. Fall back only when it genuinely cannot express the edit; explain why. Use ordinary tools for Git, builds, tests and read-only inspection.",
  },
  {
    ...LEGACY_ATTENTION_RULE,
    status: "superseded",
  },
  {
    key: "attention.human-only",
    revision: 2,
    category: "attention",
    status: "active",
    supersedes: [1],
    statement: "Spend Matthew's attention only on genuinely human-owned action or consequential judgement. Before NEEDS_HUMAN, safely infer, mechanically verify, retry differently, or repair the crossed wire yourself.",
  },
  {
    key: "friction.absorb-noise",
    revision: 1,
    category: "friction",
    status: "active",
    statement: "Absorb harmless human roughness: tolerate typos, small omissions, stale wording, and obvious crossed wires when the likely intent is cheap and reversible to verify. Record a soft reconciliation and continue instead of manufacturing ceremony.",
  },
  {
    key: "truth.owner-wins",
    revision: 1,
    category: "truth",
    status: "active",
    statement: "When sources disagree, prefer the live owner of that fact: Git/repository for implementation state and Lantern for remembered context/provenance. A Tethers decision, when present, owns deterministic consequential authority; its absence never becomes permission. Preserve meaningful disagreement instead of guessing.",
  },
];

function canonicalEntries(entries: readonly RuleSnapshotEntry[]): RuleSnapshotEntry[] {
  return [...entries]
    .map((entry) => ({
      key: entry.key.trim(),
      revision: Math.trunc(entry.revision),
      category: entry.category,
      statement: entry.statement.trim(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.revision - b.revision);
}

function digestEntries(entries: readonly RuleSnapshotEntry[]): string {
  const canonical = JSON.stringify(canonicalEntries(entries));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function validateRuleSet(definitions: readonly RuleDefinition[]): void {
  const byKey = new Map<string, RuleDefinition[]>();
  for (const rule of definitions) {
    if (!rule.key.trim()) throw new Error("rule key is empty");
    if (!Number.isInteger(rule.revision) || rule.revision < 1) throw new Error(`invalid revision for ${rule.key}`);
    if (!rule.statement.trim()) throw new Error(`rule statement is empty for ${rule.key}@${rule.revision}`);
    const list = byKey.get(rule.key) ?? [];
    if (list.some((r) => r.revision === rule.revision)) throw new Error(`duplicate rule revision ${rule.key}@${rule.revision}`);
    list.push(rule);
    byKey.set(rule.key, list);
  }

  for (const [key, rules] of byKey) {
    const active = rules.filter((r) => r.status === "active");
    if (active.length !== 1) throw new Error(`rule ${key} must have exactly one active revision, found ${active.length}`);
    const revisions = new Set(rules.map((r) => r.revision));
    for (const rule of rules) {
      for (const old of rule.supersedes ?? []) {
        if (!revisions.has(old)) throw new Error(`rule ${key}@${rule.revision} supersedes missing revision ${old}`);
        if (old >= rule.revision) throw new Error(`rule ${key}@${rule.revision} cannot supersede revision ${old}`);
      }
    }
    for (const old of rules.filter((r) => r.status === "superseded")) {
      const replaced = rules.some((r) => r.status === "active" && (r.supersedes ?? []).includes(old.revision));
      if (!replaced) throw new Error(`superseded rule ${key}@${old.revision} has no active replacement`);
    }
  }
}

export function snapshotRuleSet(definitions: readonly RuleDefinition[]): RuleSnapshot {
  validateRuleSet(definitions);
  const entries = canonicalEntries(
    definitions
      .filter((rule) => rule.status === "active")
      .map((rule) => ({ key: rule.key, revision: rule.revision, category: rule.category, statement: rule.statement })),
  );
  return { schema: "matthew-way.rules-snapshot/1", digest: digestEntries(entries), entries };
}

export function currentRuleSnapshot(): RuleSnapshot {
  return snapshotRuleSet(MATTHEW_WAY_RULES);
}

export function legacyRuleSnapshot(): RuleSnapshot {
  return snapshotRuleSet(LEGACY_RULES);
}

/** Parse a durable mission snapshot without consulting today's active rules. */
export function parseRuleSnapshot(raw: unknown): RuleSnapshot {
  if (typeof raw !== "object" || raw === null) throw new Error("rules snapshot is not an object");
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== "matthew-way.rules-snapshot/1") throw new Error("unknown rules snapshot schema");
  if (!Array.isArray(obj.entries) || obj.entries.length === 0) throw new Error("rules snapshot has no entries");

  const allowedCategories = new Set<RuleCategory>(["autonomy", "progress", "attention", "friction", "truth", "evidence", "scope", "shipping"]);
  const entries: RuleSnapshotEntry[] = obj.entries.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("invalid rules snapshot entry");
    const entry = value as Record<string, unknown>;
    const category = entry.category as RuleCategory;
    if (typeof entry.key !== "string" || !entry.key.trim()) throw new Error("rules snapshot entry has no key");
    if (typeof entry.revision !== "number" || !Number.isInteger(entry.revision) || entry.revision < 1) throw new Error(`invalid rules revision for ${entry.key}`);
    if (!allowedCategories.has(category)) throw new Error(`invalid rules category for ${entry.key}`);
    if (typeof entry.statement !== "string" || !entry.statement.trim()) throw new Error(`rules snapshot entry has no statement for ${entry.key}`);
    return { key: entry.key.trim(), revision: entry.revision, category, statement: entry.statement.trim() };
  });

  const keys = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new Error(`rules snapshot contains duplicate active key ${entry.key}`);
    keys.add(entry.key);
  }

  const digest = digestEntries(entries);
  if (typeof obj.digest !== "string" || obj.digest !== digest) throw new Error("rules snapshot digest mismatch");
  return { schema: "matthew-way.rules-snapshot/1", digest, entries: canonicalEntries(entries) };
}

export function renderRuleSnapshot(snapshot: RuleSnapshot): string {
  return [
    "STUDIO OPERATING RULES",
    ...snapshot.entries.map((entry) => `- [${entry.key}@${entry.revision}] ${entry.statement}`),
  ].join("\n");
}
