import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitAll, canonicalRepo, pushAndVerify, repoFacts, verifyRemoteSha } from "../src/git.js";
import { gitCommonDir, ledgerLocation, repoRoot } from "../src/paths.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function hasGit(): boolean {
  try {
    git(process.cwd(), "--version");
    return true;
  } catch {
    return false;
  }
}

/** Git is required for the workshop; skip honestly when a machine lacks it. */
const gitTest = hasGit() ? test : test.skip;

interface Sandbox {
  repo: string;
  remote: string;
  worktree: string;
}

function sandbox(): Sandbox {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mws-git-"));
  const remote = path.join(base, "remote.git");
  const repo = path.join(base, "repo");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { encoding: "utf8" });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "studio@test.local");
  git(repo, "config", "user.name", "Studio Test");
  fs.writeFileSync(path.join(repo, "README.md"), "# demo\n", "utf8");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const worktree = path.join(base, "wt");
  git(repo, "worktree", "add", "-b", "studio-task", worktree, "HEAD");
  return { repo, remote, worktree };
}

gitTest("repoFacts reads root, branch, SHA, dirty state and upstream", () => {
  const s = sandbox();
  const facts = repoFacts(s.repo);
  assert.equal(facts.is_repo, true);
  assert.equal(facts.branch, "main");
  assert.match(facts.head_sha, /^[0-9a-f]{40}$/);
  assert.equal(facts.dirty, false);
  assert.equal(facts.upstream, "origin/main");
  assert.match(facts.remote, /remote\.git$/);

  fs.writeFileSync(path.join(s.repo, "new-file.ts"), "export const a = 1;\n", "utf8");
  const dirty = repoFacts(s.repo);
  assert.equal(dirty.dirty, true);
  assert.ok(dirty.dirty_paths.some((p) => p.includes("new-file.ts")));
});

gitTest("repoFacts on a fresh repo with no commits reports the gap honestly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-empty-"));
  git(dir, "init", "--initial-branch=main");
  const facts = repoFacts(dir);
  assert.equal(facts.is_repo, true);
  assert.equal(facts.head_sha, "");
  assert.equal(facts.error, "repository has no commits");
});

gitTest("repoFacts outside a repository is not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-norepo-"));
  const facts = repoFacts(dir);
  assert.equal(facts.is_repo, false);
  assert.equal(facts.root, path.normalize(dir));
});

gitTest("linked worktrees share one ledger in the git common dir", () => {
  const s = sandbox();
  const mainLedger = ledgerLocation(s.repo);
  const wtLedger = ledgerLocation(s.worktree);
  assert.equal(mainLedger.source, "git-common-dir");
  assert.equal(wtLedger.source, "git-common-dir");
  assert.equal(wtLedger.dir, mainLedger.dir, "worktree must see the same project ledger");
  assert.equal(wtLedger.dir, path.join(gitCommonDir(s.repo) ?? "", "matthew-way-studio"));
  // Each worktree keeps its own Git facts, while the ledger stays shared.
  assert.equal(repoRoot(s.worktree), path.normalize(s.worktree));
  assert.equal(repoRoot(s.repo), s.repo);
  assert.equal(ledgerLocation(s.worktree).repoRoot, ledgerLocation(s.worktree).repoRoot);
});

gitTest("verifyRemoteSha distinguishes match, mismatch and unreachable", () => {
  const s = sandbox();
  const sha = git(s.repo, "rev-parse", "HEAD");
  assert.equal(verifyRemoteSha(s.repo, "main", sha).verified, true);
  const mismatch = verifyRemoteSha(s.repo, "main", "f".repeat(40));
  assert.equal(mismatch.verified, false);
  assert.match(mismatch.detail, /expected/);
  const missingBranch = verifyRemoteSha(s.repo, "no-such-branch", sha);
  assert.equal(missingBranch.verified, false);
  assert.match(missingBranch.detail, /does not exist/);
  const badRemote = verifyRemoteSha(s.repo, "main", sha, "ghost");
  assert.equal(badRemote.verified, false);
  assert.match(badRemote.detail, /no ghost remote/);
});

gitTest("pushAndVerify commits, pushes and confirms the remote SHA", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.worktree, "feature.ts"), "export const feature = true;\n", "utf8");
  const commit = commitAll(s.worktree, "feat: add feature");
  assert.equal(commit.ok, true);
  assert.match(commit.sha, /^[0-9a-f]{40}$/);

  const pushed = pushAndVerify(s.worktree, "studio-task");
  assert.equal(pushed.ok, true, pushed.detail);
  assert.equal(pushed.remote?.verified, true);
  assert.equal(pushed.remote?.remote_sha, pushed.local_sha);

  // Pushing again is a no-op that still verifies.
  const again = pushAndVerify(s.worktree, "studio-task");
  assert.equal(again.ok, true);

  // A branch that does not exist locally cannot be pushed.
  const detached = pushAndVerify(s.worktree, "");
  assert.equal(detached.ok, false);
  assert.match(detached.detail, /detached|branch/);
});

gitTest("push failure is reported as data, not thrown", () => {
  const s = sandbox();
  git(s.repo, "remote", "set-url", "origin", path.join(s.remote, "..", "missing.git"));
  const res = pushAndVerify(s.repo, "main");
  assert.equal(res.ok, false);
  assert.match(res.detail, /push failed/);
  assert.match(res.local_sha, /^[0-9a-f]{40}$/);
});

test("canonicalRepo normalises ssh, https and .git forms", () => {
  assert.equal(canonicalRepo("git@github.com:acme/widget.git"), "acme/widget");
  assert.equal(canonicalRepo("git@github.com:acme/widget"), "acme/widget");
  assert.equal(canonicalRepo("https://github.com/acme/widget.git"), "acme/widget");
  assert.equal(canonicalRepo("https://github.com:443/acme/widget"), "acme/widget");
  assert.equal(canonicalRepo(""), "");
});

test("commitAll reports an already-clean tree without inventing a commit", () => {
  const s = sandbox();
  const before = git(s.repo, "rev-parse", "HEAD");
  const res = commitAll(s.repo, "chore: nothing");
  assert.equal(res.ok, true);
  assert.equal(res.sha, before);
  assert.equal(res.detail, "nothing to commit");
});
