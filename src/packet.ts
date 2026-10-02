/**
 * Packet intake: turn an ordinary composer message into a compact, durable
 * mission contract without asking Matthew to use any orchestration vocabulary.
 *
 * Deterministic and pure: no model call, no repository read.
 */

import type { JobContract } from "./schema.js";

const SECTION_ALIASES: Record<keyof Omit<JobContract, "objective">, readonly string[]> = {
  scope: ["SCOPE", "DELIVERY", "NON-GOALS", "BOUNDARIES"],
  authority: ["AUTHORITY", "PERMISSIONS", "AUTONOMY"],
  constraints: ["CONSTRAINTS", "GUARDRAILS", "RULES", "DOCTRINE"],
  acceptance: ["ACCEPTANCE", "DONE WHEN", "VERIFICATION", "TESTS"],
  attention: ["ATTENTION", "ESCALATE", "NEEDS_HUMAN", "STOP CONDITIONS"],
};

const OBJECTIVE_ALIASES = ["OBJECTIVE", "GOAL", "PURPOSE", "INTENT", "WHAT"];

const NOISE_VALUES = new Set([
  "none",
  "n/a",
  "na",
  "-",
  "tbd",
  "to be determined",
  "not specified",
]);

export interface ParsedSection {
  heading: string;
  lines: string[];
}

/**
 * Split a Markdown/plain-text packet on its own headings.
 * `#`, `##`, `**BOLD**`, `NAME:` and `--- underlines` all count as headings so
 * packets pasted from different authors still parse.
 */
export function parseSections(packet: string): ParsedSection[] {
  const lines = packet.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  let current: ParsedSection | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      current?.lines.push(line);
      continue;
    }
    const hash = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const bold = /^\*\*([^*]{2,60})\*\*:?$/.exec(trimmed);
    const labelled = /^([A-Z][A-Z0-9 /&_-]{2,40}):\s*(.*)$/.exec(trimmed);
    const underline = /^\s*[-=]{3,}\s*$/.test(trimmed);
    let heading: string | undefined;
    let inlineRest: string | undefined;
    if (hash?.[1]) heading = hash[1].replace(/[^A-Za-z0-9 /&_-]/g, "").trim();
    else if (bold?.[1]) heading = bold[1].trim();
    else if (labelled?.[1]) {
      heading = labelled[1].trim();
      inlineRest = labelled[2]?.trim() || undefined;
    }
    if (heading && !underline) {
      const normalized = heading.toUpperCase();
      current = { heading: normalized, lines: inlineRest ? [inlineRest] : [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { heading: "PREAMBLE", lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections;
}

function cleanList(lines: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  let budget = maxChars;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const item = line.replace(/^[-*•]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
    if (!item || NOISE_VALUES.has(item.toLowerCase())) continue;
    if (item.length > 400) {
      // Keep long prose as a bounded clause rather than dropping real content.
      const clipped = `${item.slice(0, 400)}…`;
      out.push(clipped);
      budget -= clipped.length;
    } else {
      out.push(item);
      budget -= item.length;
    }
    if (out.length >= maxItems || budget <= 0) break;
  }
  return out;
}

function findSection(sections: ParsedSection[], aliases: readonly string[]): ParsedSection | undefined {
  for (const alias of aliases) {
    const hit = sections.find((s) => s.heading === alias || s.heading.startsWith(`${alias} `) || s.heading.includes(alias));
    if (hit) return hit;
  }
  return undefined;
}

/** First meaningful sentence of the packet body, used when no OBJECTIVE exists. */
function inferObjective(sections: ParsedSection[]): string {
  for (const section of sections) {
    if (section.heading === "PREAMBLE") {
      const text = section.lines.join(" ").trim();
      if (text) return firstSentence(text);
    }
  }
  for (const section of sections) {
    const text = section.lines.join(" ").trim();
    if (text) return firstSentence(`${section.heading}: ${text}`);
  }
  return "";
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = /^(.{10,240}?[.!?])(\s|$)/.exec(clean);
  const sentence = match?.[1] ?? clean.slice(0, 240);
  return sentence.length > 260 ? `${sentence.slice(0, 257)}…` : sentence;
}

export function compilePacket(packet: string): JobContract {
  const sections = parseSections(packet);
  const objectiveSection = findSection(sections, OBJECTIVE_ALIASES);
  const objective =
    objectiveSection && objectiveSection.lines.length > 0
      ? firstSentence(objectiveSection.lines.join(" ").trim())
      : inferObjective(sections);

  const contract: JobContract = {
    objective: objective || firstSentence(packet.replace(/\s+/g, " ").trim()),
    scope: [],
    authority: [],
    constraints: [],
    acceptance: [],
    attention: [],
  };

  for (const [key, aliases] of Object.entries(SECTION_ALIASES) as [keyof typeof SECTION_ALIASES, readonly string[]][]) {
    const section = findSection(sections, aliases);
    contract[key] = section ? cleanList(section.lines, 12, 1800) : [];
  }

  // Non-goals are constraints when they are not their own heading.
  const nonGoals = findSection(sections, ["NON-GOALS"]);
  if (nonGoals) {
    const negatives = cleanList(nonGoals.lines, 12, 900).map((n) => `NOT in scope: ${n}`);
    contract.constraints = [...new Set([...contract.constraints, ...negatives])];
  }

  if (contract.acceptance.length === 0) {
    contract.acceptance = ["The packet's stated deliverable exists in the repository and is verified by the cheapest trustworthy check."];
  }
  if (contract.attention.length === 0) {
    contract.attention = ["Only irreversible, financial, security-sensitive or out-of-scope decisions."];
  }
  return contract;
}

/**
 * Should this message start a mission? Small jobs stay small: a short,
 * single-purpose request is worked on directly, without a heavyweight record.
 */
export function isSubstantivePacket(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const hasHeading = /^\s*(#{1,6}\s+\S|\*\*[A-Z][^*]{2,}\*\*\s*:?|([A-Z][A-Z0-9 /&_-]{2,40}):)/m.test(trimmed);
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim()).length;
  const chars = trimmed.length;
  if (hasHeading && lines >= 3) return true;
  if (lines >= 12 && chars >= 600) return true;
  if (chars >= 1500) return true;
  return false;
}

const PAUSE_PATTERNS = [
  /\b(stop|pause|halt|hold)\b[^.\n]{0,30}\b(mission|job|work|run|loop|continuation|studio)\b/i,
  /\bstop (auto|automatic) continuation\b/i,
  /\bdon'?t continue\b/i,
  /\bstop the studio loop\b/i,
  /\bpi stop\b/i,
];

const RESUME_MARKERS = [
  "done",
  "did it",
  "ready",
  "added",
  "configured",
  "authenticated",
  "logged in",
  "pushed",
  "key",
  "token",
  "permission",
  "approved",
  "yes",
  "ok",
  "continue",
  "resume",
  "try again",
];

/**
 * Natural resume: a plain reply while a job is blocked. We never require a
 * command; we also never assume. An ambiguous short reply rechecks instead.
 */
export function looksLikeResumeAttempt(text: string): "attempt" | "unrelated" {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return "unrelated";
  if (trimmed.length > 600) return "attempt";
  const hit = RESUME_MARKERS.some((marker) => trimmed === marker || trimmed.includes(`${marker} `) || trimmed.startsWith(marker));
  return hit ? "attempt" : "unrelated";
}

/**
 * Matthew owns intent, so ordinary language must be able to stop the loop. The
 * runtime only needs to honour it, never to be commanded.
 */
export function detectControlIntent(text: string): "pause" | "resume" | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 400) return undefined;
  if (PAUSE_PATTERNS.some((p) => p.test(trimmed))) return "pause";
  const lower = trimmed.toLowerCase();
  if (/\b(resume|continue|carry on|keep going|pick it up|renew)\b/.test(lower) && /\b(mission|job|run|loop|studio|work)\b/.test(lower)) return "resume";
  if (lower === "continue" || lower === "resume" || lower === "keep going") return "resume";
  return undefined;
}
