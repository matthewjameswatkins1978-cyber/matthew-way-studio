/**
 * Git and GitHub facts. Deterministic, read-mostly, and honest about what it
 * cannot see. Environment-specific failures are reported as data, never thrown,
 * because a missing credential is a NEEDS_HUMAN signal, not a crash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot, run } from "./paths.js";

export interface RepoFacts {
  root: string;
  /** Present only when this is a real repository. */
  is_repo: boolean;
  /** Origin remote URL, or "" for a repository without a remote. */
  remote: string;
  branch: string;
  head_sha: string;
  dirty: boolean;
  /** Tracked or untracked changes, capped for readability. */
  dirty_paths: string[];
  upstream: string;
  detached: boolean;
  error?: string;
}

const NOT_A_REPO: RepoFacts = {
  root: "",
  is_repo: false,
  remote: "",
  branch: "",
  head_sha: "",
  dirty: false,
  dirty_paths: [],
  upstream: "",
  detached: false,
};

export function repoFacts(cwd: string): RepoFacts {
  const root = repoRoot(cwd);
  if (!root) {
    const probe = run("git", ["rev-parse", "--show-toplevel"], cwd);
    return { ...NOT_A_REPO, root: path.normalize(cwd), error: probe.ok ? undefined : probe.stderr.trim() || "not a git repository" };
  }
  const head = run("git", ["rev-parse", "HEAD"], root);
  if (!head.ok) {
    // Repository exists but has no commits yet.
    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
    const status = run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root);
    const dirtyPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).slice(0, 20);
    return {
      root,
      is_repo: true,
      remote: remoteUrl(root),
      branch: branch.ok && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : "",
      head_sha: "",
      dirty: dirtyPaths.length > 0,
      dirty_paths: dirtyPaths,
      upstream: "",
      detached: false,
      error: "repository has no commits",
    };
  }
  const branchRes = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  const branchName = branchRes.stdout.trim();
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root);
  const dirtyPaths = (status.stdout ?? "").split(/\r?\n/).filter(Boolean).slice(0, 20);
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
  return {
    root,
    is_repo: true,
    remote: remoteUrl(root),
    branch: branchRes.ok && branchName !== "HEAD" ? branchName : "",
    head_sha: head.stdout.trim(),
    dirty: dirtyPaths.length > 0,
    dirty_paths: dirtyPaths,
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    detached: branchRes.ok && branchName === "HEAD",
  };
}

function remoteUrl(root: string, name = "origin"): string {
  const r = run("git", ["remote", "get-url", name], root);
  return r.ok ? r.stdout.trim() : "";
}

/**
 * Branches Studio must never push to directly. Integration branches merge
 * through Lucy; missions ship on isolated feature branches.
 */
export const PROTECTED_BRANCHES = [
  "main",
  "master",
  "develop",
  "development",
  "trunk",
  "foundation",
  "bootstrap",
  "release",
] as const;

const PROTECTED_PREFIXES = ["release/", "foundation/", "bootstrap/"] as const;

export function isProtectedBranch(branch: string, extraProtected: readonly string[] = []): boolean {
  const name = branch.trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  if ((PROTECTED_BRANCHES as readonly string[]).includes(lower)) return true;
  if (PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // Exact configured integration targets (e.g. from repo-local Studio config).
  return extraProtected.some((entry) => entry.trim().toLowerCase() === lower);
}

/** Repo-relative dirty paths from porcelain status (tracked and untracked). */
export function liveDirtyPaths(root: string, cap = 200): string[] {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root);
  if (!status.ok) return [];
  const paths: string[] = [];
  for (const line of (status.stdout ?? "").split(/\r?\n/)) {
    if (!line.trim() || paths.length >= cap) break;
    const entry = line.slice(3);
    // Rename/copy entries look like "old -> new": stage the new path.
    const arrow = entry.indexOf(" -> ");
    paths.push(arrow >= 0 ? entry.slice(arrow + 4) : entry);
  }
  return paths.filter(Boolean);
}

/** Short canonical "owner/repo" for receipts, from the origin URL when present. */
export function canonicalRepo(remote: string): string {
  const ssh = /^git@[^:]+:(.+?)(?:\.git)?$/.exec(remote.trim());
  if (ssh?.[1]) return ssh[1];
  const https = /^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(remote.trim());
  if (https?.[1]) return https[1];
  return remote.trim();
}

export interface RemoteCheck {
  verified: boolean;
  remote_sha: string;
  detail: string;
}

/**
 * Verify a pushed SHA against the remote without a network-dependent test
 * assumption: an unreachable remote is reported as unverified, never as a pass.
 */
export function verifyRemoteSha(root: string, branch: string, expected: string, remoteName = "origin"): RemoteCheck {
  if (!root || !branch || !expected) {
    return { verified: false, remote_sha: "", detail: "missing repository, branch or SHA" };
  }
  const url = remoteUrl(root, remoteName);
  if (!url) return { verified: false, remote_sha: "", detail: `no ${remoteName} remote configured` };
  const res = run("git", ["ls-remote", url, `refs/heads/${branch}`], root, 45_000);
  if (!res.ok) {
    return { verified: false, remote_sha: "", detail: `ls-remote failed: ${res.stderr.trim().split(/\r?\n/)[0] || `exit ${res.code}`}` };
  }
  const line = res.stdout.split(/\r?\n/).find((l) => l.trim());
  const sha = (line ?? "").split(/\s+/)[0] ?? "";
  if (!sha) return { verified: false, remote_sha: "", detail: `${remoteName}/${branch} does not exist on the remote` };
  return {
    verified: sha.toLowerCase() === expected.toLowerCase(),
    remote_sha: sha,
    detail: sha.toLowerCase() === expected.toLowerCase() ? `${remoteName}/${branch} matches ${sha.slice(0, 10)}` : `${remoteName}/${branch} is ${sha.slice(0, 10)}, expected ${expected.slice(0, 10)}`,
  };
}

export interface PushResult {
  ok: boolean;
  detail: string;
  local_sha: string;
  remote?: RemoteCheck;
}

/**
 * Push the current branch and verify the remote SHA in one deterministic step.
 * Never force-pushes and never merges on Matthew's behalf. Refuses protected
 * branches and refuses to push HEAD to a ref other than the checked-out
 * branch, before touching the network.
 */
export function pushAndVerify(
  root: string,
  branch: string,
  remoteName = "origin",
  opts: { protectedBranches?: readonly string[] } = {},
): PushResult {
  const head = run("git", ["rev-parse", "HEAD"], root);
  if (!head.ok) return { ok: false, detail: head.stderr.trim() || "no HEAD", local_sha: "" };
  const localSha = head.stdout.trim();
  if (!branch) return { ok: false, detail: "detached HEAD: refusing to guess a branch", local_sha: localSha };
  if (isProtectedBranch(branch, opts.protectedBranches)) {
    return {
      ok: false,
      detail: `refusing to push protected branch '${branch}': ship mission work on an isolated feature branch (Lucy merges integration branches)`,
      local_sha: localSha,
    };
  }
  const current = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root);
  const checkout = current.ok ? current.stdout.trim() : "";
  if (checkout && checkout !== "HEAD" && checkout !== branch) {
    return {
      ok: false,
      detail: `refusing to push HEAD (${checkout}) to a different ref '${branch}': check out the target branch first`,
      local_sha: localSha,
    };
  }
  const push = run("git", ["push", "-u", remoteName, `HEAD:refs/heads/${branch}`], root, 120_000);
  const stderr = (push.stderr || push.stdout).trim();
  if (!push.ok) {
    const first = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
    return { ok: false, detail: `push failed: ${first || `exit ${push.code}`}`, local_sha: localSha };
  }
  const remote = verifyRemoteSha(root, branch, localSha, remoteName);
  return { ok: remote.verified, detail: remote.detail, local_sha: localSha, remote };
}

export interface CommitResult {
  ok: boolean;
  sha: string;
  detail: string;
  /** Exact pathspecs staged for this commit, in the order given. */
  staged: string[];
  /** Paths the resulting commit actually contains (read back from git). */
  committed: string[];
}

/**
 * Commit exactly the given repo-relative pathspecs — never a bare `git add -A`
 * and never a bare `git commit` (which would sweep in previously staged
 * unrelated files). Array argv (no shell) keeps hostile filenames inert. An
 * empty selection is refused instead of silently committing everything.
 * The committed tree is read back so callers record reality, not intent.
 */
export function commitFiles(root: string, message: string, paths: string[]): CommitResult {
  const clean = paths.map((p) => p.trim()).filter(Boolean);
  const none = { ok: false, sha: "", detail: "", staged: [] as string[], committed: [] as string[] };
  if (!message.trim()) return { ...none, detail: "commit message is required" };
  if (!clean.length) return { ...none, detail: "no paths selected for commit" };
  const add = run("git", ["add", "--", ...clean], root);
  if (!add.ok) return { ...none, detail: add.stderr.trim() || "git add failed" };
  const status = run("git", ["status", "--porcelain=v1"], root);
  if (!status.stdout.trim()) {
    return { ok: true, sha: run("git", ["rev-parse", "HEAD"], root).stdout.trim(), detail: "nothing to commit", staged: clean, committed: [] };
  }
  // Pathspec-restricted commit: previously staged unrelated files stay
  // staged and uncommitted instead of being swept in.
  const commit = run("git", ["commit", "-m", message, "--", ...clean], root, 60_000);
  if (!commit.ok) return { ...none, staged: clean, detail: commit.stderr.trim().split(/\r?\n/)[0] || "commit failed" };
  const sha = run("git", ["rev-parse", "HEAD"], root).stdout.trim();
  const show = run("git", ["show", "--name-only", "--format=", "HEAD"], root);
  const committed = show.ok ? show.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  return { ok: true, sha, detail: "committed", staged: clean, committed };
}

/**
 * Keep the operational ledger out of every commit even when a worktree falls
 * back to a repository-visible path. Writes to .git/info/exclude only.
 */
export function excludeLedger(root: string, relativePath: string): { ok: boolean; detail: string } {
  const common = run("git", ["rev-parse", "--git-common-dir"], root);
  if (!common.ok) return { ok: false, detail: "cannot resolve git common dir" };
  const dir = path.isAbsolute(common.stdout.trim()) ? common.stdout.trim() : path.resolve(root, common.stdout.trim());
  const info = path.join(dir, "info");
  const file = path.join(info, "exclude");
  const entry = relativePath.replace(/^\/+/, "");
  try {
    fs.mkdirSync(info, { recursive: true });
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (text.split(/\r?\n/).includes(entry)) return { ok: true, detail: "already excluded" };
    fs.appendFileSync(file, `${text.endsWith("\n") || text === "" ? "" : "\n"}${entry}\n`, "utf8");
    return { ok: true, detail: `excluded ${entry}` };
  } catch (error) {
    return { ok: false, detail: String(error) };
  }
}
