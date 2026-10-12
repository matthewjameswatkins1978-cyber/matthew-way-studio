import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commitFiles, canonicalRepo, isProtectedBranch, liveDirtyPaths, pushAndVerify, repoFacts, verifyRemoteSha } from "../src/git.js";
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
  const commit = commitFiles(s.worktree, "feat: add feature", ["feature.ts"]);
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
  const res = pushAndVerify(s.worktree, "studio-task");
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

test("commitFiles reports an already-clean tree without inventing a commit", () => {
  const s = sandbox();
  const before = git(s.repo, "rev-parse", "HEAD");
  const res = commitFiles(s.repo, "chore: nothing", ["README.md"]);
  assert.equal(res.ok, true);
  assert.equal(res.sha, before);
  assert.equal(res.detail, "nothing to commit");
});

gitTest("pushAndVerify refuses protected branches without touching the remote", () => {
  const s = sandbox();
  for (const branch of ["main", "Main", "master", "foundation", "release", "release/1.2", "foundation/next"]) {
    assert.equal(isProtectedBranch(branch), true, branch);
    const res = pushAndVerify(s.repo, branch);
    assert.equal(res.ok, false);
    assert.match(res.detail, /protected branch/);
  }
  for (const branch of ["feature/probe", "main2", "release-notes", "foundation-stone", "studio-task"]) {
    assert.equal(isProtectedBranch(branch), false, branch);
  }
  // The refused pushes must not have created anything on the remote.
  const refs = git(s.repo, "ls-remote", s.remote);
  assert.ok(!refs.includes("refs/heads/release"), "no release ref may be created");
  assert.ok(!refs.includes("refs/heads/foundation"), "no foundation ref may be created");
});

gitTest("commitFiles stages only the listed paths", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.worktree, "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(s.worktree, "b.ts"), "export const b = 2;\n", "utf8");
  assert.deepEqual(liveDirtyPaths(s.worktree).sort(), ["a.ts", "b.ts"]);
  const res = commitFiles(s.worktree, "feat: only a", ["a.ts"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.staged, ["a.ts"]);
  const show = git(s.worktree, "show", "--name-only", "--format=", "HEAD");
  assert.ok(show.split(/\r?\n/).includes("a.ts"));
  assert.ok(!show.split(/\r?\n/).includes("b.ts"), "unrelated file must stay out of the commit");
  assert.ok(liveDirtyPaths(s.worktree).includes("b.ts"), "unrelated file must stay dirty");
});

gitTest("commitFiles never sweeps previously staged unrelated files", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.worktree, "target.ts"), "export const t = 1;\n", "utf8");
  fs.writeFileSync(path.join(s.worktree, "unrelated.ts"), "export const u = 2;\n", "utf8");
  // Hostile pre-state: the unrelated file is already staged.
  git(s.worktree, "add", "unrelated.ts");
  const res = commitFiles(s.worktree, "feat: only target", ["target.ts"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.staged, ["target.ts"]);
  assert.deepEqual(res.committed, ["target.ts"], "actual commit tree must match the selection");
  // Unrelated index/worktree state is preserved, not committed.
  const staged = git(s.worktree, "diff", "--cached", "--name-only");
  assert.ok(staged.split(/\r?\n/).includes("unrelated.ts"), "unrelated file stays staged");
  assert.ok(liveDirtyPaths(s.worktree).includes("unrelated.ts"));
});

gitTest("pushAndVerify refuses retargeting HEAD to another ref", () => {
  const s = sandbox();
  // s.worktree is checked out on studio-task; pushing it as feature/other rewrites that ref.
  const res = pushAndVerify(s.worktree, "feature/other");
  assert.equal(res.ok, false);
  assert.match(res.detail, /different ref/);
  const refs = git(s.repo, "ls-remote", s.remote);
  assert.ok(!refs.includes("refs/heads/feature/other"), "no remote write happened");
});

gitTest("protected branches include bootstrap and configured targets", () => {
  assert.equal(isProtectedBranch("bootstrap"), true);
  assert.equal(isProtectedBranch("bootstrap/agent-x-foundation"), true);
  assert.equal(isProtectedBranch("Bootstrap/X", ["custom-integration"]), true);
  assert.equal(isProtectedBranch("feature/work"), false);
  assert.equal(isProtectedBranch("feature/work", ["feature/work"]), true, "configured targets are protected");
  const s = sandbox();
  const res = pushAndVerify(s.worktree, "studio-task", "origin", { protectedBranches: ["studio-task"] });
  assert.equal(res.ok, false);
  assert.match(res.detail, /protected branch/);
});

gitTest("commitFiles refuses empty selections and hostile pathspecs stay inert", () => {
  const s = sandbox();
  const empty = commitFiles(s.worktree, "feat: nothing", []);
  assert.equal(empty.ok, false);
  assert.match(empty.detail, /no paths selected/);
  const missing = commitFiles(s.worktree, "feat: ghost", ["no-such-file.ts"]);
  assert.equal(missing.ok, false);
});

gitTest("commitFiles refuses wildcard, directory and pathspec-magic scope before any write", () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.worktree, "target.txt"), "v2-target\n", "utf8");
  fs.writeFileSync(path.join(s.worktree, "other.txt"), "v2-other\n", "utf8");
  fs.mkdirSync(path.join(s.worktree, "sub"), { recursive: true });
  fs.writeFileSync(path.join(s.worktree, "sub", "inner.txt"), "v2-inner\n", "utf8");
  const before = git(s.worktree, "rev-parse", "HEAD");
  const hostile = [["*.txt"], ["sub"], ["sub/"], [":(glob)**.txt"], [":(top)."], ["../outside.txt"], ["/abs/path.txt"]];
  for (const scope of hostile) {
    const res = commitFiles(s.worktree, "probe: broad scope", scope);
    assert.equal(res.ok, false, `scope ${JSON.stringify(scope)} must be refused`);
    assert.match(res.detail, /broad scope/);
    assert.deepEqual(res.committed, []);
  }
  assert.equal(git(s.worktree, "rev-parse", "HEAD"), before, "refusals must not create a commit");
  assert.equal(git(s.worktree, "diff", "--cached", "--name-only"), "", "refusals must not stage anything");
  assert.equal(liveDirtyPaths(s.worktree).length, 3, "worktree left intact for review");
});

gitTest("commitFiles commits a literal filename containing glob characters", () => {
  const s = sandbox();
  // a[1].txt as a GLOB would also match a1.txt; as a literal it must not.
  fs.writeFileSync(path.join(s.worktree, "a[1].txt"), "literal\n", "utf8");
  fs.writeFileSync(path.join(s.worktree, "a1.txt"), "decoy\n", "utf8");
  const res = commitFiles(s.worktree, "feat: literal name", ["a[1].txt"]);
  assert.equal(res.ok, true, res.detail);
  assert.deepEqual(res.staged, ["a[1].txt"]);
  assert.deepEqual(res.committed, ["a[1].txt"], "glob-shaped names stay literal");
  assert.ok(liveDirtyPaths(s.worktree).includes("a1.txt"), "decoy stays dirty");
});
