/**
 * Lantern adapter boundary.
 *
 * Lantern is contextual memory, never code truth. The adapter is deliberately
 * narrow: it asks for a bounded context pack, records handles, and degrades to
 * the read-only `lantern-git` snapshot only when that snapshot is fresh enough
 * for the question. Studio does not know Lantern's storage shape.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export interface LanternToolNames {
  context: string;
  why: string;
}

/** Discover Lantern MCP tool names as registered in this Pi session. */
export function discoverLanternTools(allTools: { name: string }[]): LanternToolNames | undefined {
  const context = allTools.find((t) => /(^|__)lantern_context$/.test(t.name));
  if (!context) return undefined;
  const why = allTools.find((t) => /(^|__)lantern_why$/.test(t.name));
  return { context: context.name, why: why?.name ?? "" };
}

export interface LanternContextResult {
  available: boolean;
  source: "mcp" | "snapshot" | "none";
  text: string;
  detail: string;
}

export interface SnapshotConfig {
  /** Path to a lantern-git mirror checkout, when one exists on this machine. */
  mirrorPath?: string;
  /** Mirror older than this is not treated as current for a mission. */
  maxAgeMinutes?: number;
}

const DEFAULT_MAX_AGE_MINUTES = 24 * 60;

/**
 * Read the degraded snapshot. Returns nothing useful when the mirror is absent
 * or stale, and always says which, so the model can prefer Git facts.
 */
export function readSnapshot(query: string, config: SnapshotConfig): { used: boolean; text: string; detail: string } {
  const mirror = config.mirrorPath?.trim();
  if (!mirror) return { used: false, text: "", detail: "no lantern-git mirror configured" };
  const statusFile = path.join(mirror, "status.json");
  if (!existsSync(statusFile)) return { used: false, text: "", detail: `lantern mirror status missing at ${mirror}` };
  let generatedAt = "";
  try {
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as { generated_at?: string };
    generatedAt = status.generated_at ?? "";
  } catch (error) {
    return { used: false, text: "", detail: `lantern mirror status unreadable: ${String(error)}` };
  }
  const stamp = Date.parse(generatedAt || "");
  const maxAge = (config.maxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES) * 60_000;
  if (Number.isNaN(stamp)) return { used: false, text: "", detail: "lantern mirror status has no readable generated_at" };
  const age = Date.now() - stamp;
  if (age > maxAge) {
    const minutes = Math.round(age / 60_000);
    return { used: false, text: "", detail: `lantern mirror is stale (${minutes}m old > ${Math.round(maxAge / 60_000)}m allowed); using repository truth` };
  }
  const terms = tokenize(query);
  const hits: string[] = [];
  try {
    const indexDir = path.join(mirror, "index");
    if (existsSync(indexDir)) {
      for (const entry of walkJsonl(indexDir, 400)) {
        const hay = entry.toLowerCase();
        if (terms.length === 0 || terms.some((t) => hay.includes(t))) {
          hits.push(entry.slice(0, 600));
          if (hits.length >= 8) break;
        }
      }
    }
  } catch (error) {
    return { used: false, text: "", detail: `lantern mirror index unreadable: ${String(error)}` };
  }
  if (!hits.length) return { used: false, text: "", detail: `lantern mirror has no record matching the query (${ageMinutes(age)}m old)` };
  return {
    used: true,
    text: hits.map((h, i) => `[snapshot ${i + 1}] ${h}`).join("\n"),
    detail: `lantern-git snapshot, ${ageMinutes(age)}m old, ${hits.length} record(s)`,
  };
}

function ageMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .slice(0, 12);
}

function walkJsonl(dir: string, maxRecords: number): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < maxRecords) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of safeReaddir(current)) {
      const full = path.join(current, entry);
      try {
        if (statSync(full).isDirectory()) {
          stack.push(full);
          continue;
        }
      } catch {
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      try {
        for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
          if (line.trim()) out.push(line.trim());
          if (out.length >= maxRecords) break;
        }
      } catch {
        /* skip unreadable shard */
      }
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  // UNC paths make directory enumeration hang on Windows; skip them.
  if (dir.startsWith("\\\\") || dir.startsWith("//")) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Build the adapter's answer from a live MCP call, or degrade. */
export function lanternContextResult(
  mcpText: string | undefined,
  mcpError: string | undefined,
  snapshot: { used: boolean; text: string; detail: string },
): LanternContextResult {
  if (mcpText && mcpText.trim()) {
    return { available: true, source: "mcp", text: mcpText, detail: "Lantern MCP context pack" };
  }
  if (snapshot.used) {
    return { available: true, source: "snapshot", text: snapshot.text, detail: `degraded read-only snapshot — ${snapshot.detail}` };
  }
  return {
    available: false,
    source: "none",
    text: "",
    detail: `Lantern unavailable (${mcpError?.trim().split(/\r?\n/)[0] ?? "no live response"}); snapshot: ${snapshot.detail}`,
  };
}
