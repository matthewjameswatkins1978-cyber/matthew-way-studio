/**
 * Runtime configuration. Defaults are chosen so the extension works with no
 * setup at all; a project may override them in the ledger directory.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS, type ContinuationLimits } from "./continuation.js";
import type { SnapshotConfig } from "./lantern.js";

export interface StudioConfig extends ContinuationLimits {
  /** Only packets at least this substantial become durable missions. */
  minPacketChars: number;
  /** Suppress automatic continuation entirely (one-off debugging). */
  autoContinue: boolean;
  lanternMirror?: SnapshotConfig;
  /** Do not register anything or touch state when the folder is untrusted. */
  requireProjectTrust: boolean;
}

export const DEFAULT_CONFIG: StudioConfig = {
  ...DEFAULT_LIMITS,
  minPacketChars: 320,
  autoContinue: true,
  requireProjectTrust: true,
  // Workshop default: the read-only lantern-git mirror snapshot. Absent or
  // stale is reported as unavailable, never treated as repository truth.
  lanternMirror: { mirrorPath: "D:/Projects/lantern-git/mirror", maxAgeMinutes: 24 * 60 },
};

export function loadConfig(ledgerDir: string, cwd: string): { config: StudioConfig; source: string } {
  const candidates = [
    path.join(ledgerDir, "config.json"),
    path.join(cwd, ".pi", "matthew-way-studio.json"),
    path.join(cwd, ".matthew-way-studio.json"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StudioConfig>;
      return { config: mergeConfig(DEFAULT_CONFIG, raw), source: file };
    } catch {
      return { config: DEFAULT_CONFIG, source: `${file} (invalid, defaults used)` };
    }
  }
  return { config: DEFAULT_CONFIG, source: "defaults" };
}

export function mergeConfig(base: StudioConfig, raw: Partial<StudioConfig>): StudioConfig {
  const positiveInt = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  return {
    maxTurns: positiveInt(raw.maxTurns, base.maxTurns),
    maxUnchangedTurns: positiveInt(raw.maxUnchangedTurns, base.maxUnchangedTurns),
    maxErrorStreak: positiveInt(raw.maxErrorStreak, base.maxErrorStreak),
    minPacketChars: positiveInt(raw.minPacketChars, base.minPacketChars),
    autoContinue: typeof raw.autoContinue === "boolean" ? raw.autoContinue : base.autoContinue,
    requireProjectTrust: typeof raw.requireProjectTrust === "boolean" ? raw.requireProjectTrust : base.requireProjectTrust,
    lanternMirror: raw.lanternMirror?.mirrorPath ? { mirrorPath: raw.lanternMirror.mirrorPath, maxAgeMinutes: raw.lanternMirror.maxAgeMinutes } : base.lanternMirror,
  };
}
