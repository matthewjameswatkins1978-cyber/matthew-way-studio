/**
 * Ledger location and one-shot command helpers.
 *
 * Operational state lives in the Git common directory so linked worktrees
 * share one project ledger and nothing is ever committed. Non-git folders fall
 * back to `.pi/matthew-way-studio` under the working directory.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const LEDGER_DIR_NAME = "matthew-way-studio";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a short-lived local command and capture it. Never throws. */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 30_000): CommandResult {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const stdout = (r.stdout ?? "").toString();
    const stderr = (r.stderr ?? "").toString();
    return { ok: r.status === 0, stdout, stderr, code: r.status ?? -1 };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), code: -1 };
  }
}

/** Absolute repository root for a working directory, or undefined. */
export function repoRoot(cwd: string): string | undefined {
  const r = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!r.ok) return undefined;
  const root = r.stdout.trim();
  return root ? path.normalize(root) : undefined;
}

/**
 * Git common directory (shared by all linked worktrees).
 * `--absolute-git-dir` is the worktree-local dir; the common dir is the shared one.
 */
export function gitCommonDir(cwd: string): string | undefined {
  const r = run("git", ["rev-parse", "--git-common-dir"], cwd);
  if (!r.ok) return undefined;
  const raw = r.stdout.trim();
  if (!raw) return undefined;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.normalize(abs);
}

export interface LedgerLocation {
  /** Directory holding active-job.json / events.jsonl / jobs/. */
  dir: string;
  /** Where the ledger came from, for receipts and debugging. */
  source: "git-common-dir" | "git-dir" | "fallback";
  repoRoot?: string;
}

export function ledgerLocation(cwd: string): LedgerLocation {
  const root = repoRoot(cwd);
  const common = root ? gitCommonDir(root) : undefined;
  if (root && common) {
    return { dir: path.join(common, LEDGER_DIR_NAME), source: "git-common-dir", repoRoot: root };
  }
  if (root) {
    // Unusual: a repo whose common dir cannot be resolved. Stay inside the repo.
    return { dir: path.join(root, ".git", LEDGER_DIR_NAME), source: "git-dir", repoRoot: root };
  }
  return { dir: path.join(cwd, ".pi", LEDGER_DIR_NAME), source: "fallback" };
}

/** Ledger paths are created on demand; reading never mutates the repository. */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
