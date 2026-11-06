/** Inbox fetch/parse tests with an injected gh runner; no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIssueComments, parseHandoffEnvelope, parseHandoffs, type IssueComment } from "../src/inbox.js";

const REPO = "matthewjameswatkins1978-cyber/pepin";

function comment(id: number, body: string): IssueComment {
  return { id, login: "matthewjameswatkins1978-cyber", issue_url: `https://api.github.com/repos/${REPO}/issues/16`, body, created_at: "2026-11-06T14:20:00Z" };
}

test("parseHandoffEnvelope accepts the strict envelope and ignores chatter", () => {
  const parsed = parseHandoffEnvelope(
    comment(42, "WORKSHOP-HANDOFF run=job-1 to=A2 type=handoff from=A1 sha=" + "a".repeat(40) + "\nplease verify 1658ea9"),
    REPO,
  );
  assert.ok(parsed);
  assert.equal(parsed.id, "42");
  assert.equal(parsed.run_id, "job-1");
  assert.equal(parsed.to, "A2");
  assert.equal(parsed.sha, "a".repeat(40));
  assert.equal(parseHandoffEnvelope(comment(43, "just some human discussion"), REPO), undefined);
  assert.equal(parseHandoffEnvelope(comment(44, "WORKSHOP-HANDOFF run=job-1 to=A2"), REPO), undefined);
});

test("parseHandoffs skips chatter and keeps envelope comments in order", () => {
  const out = parseHandoffs(
    [comment(3, "hello"), comment(1, "WORKSHOP-HANDOFF run=r to=A2 type=t from=A1\nx"), comment(2, "WORKSHOP-HANDOFF run=r to=A9 type=t from=A1\ny")],
    REPO,
  );
  assert.deepEqual(out.map((m) => m.id), ["1", "2"]);
});

test("fetchIssueComments pages, validates and bounds the cursor", () => {
  const payload = JSON.stringify([
    { id: 5, user: { login: "a" }, issue_url: "u", body: "WORKSHOP-HANDOFF run=r to=A2 type=t from=A1\nx", created_at: "t" },
    { id: "bad", user: { login: "a" }, issue_url: "u", body: "x", created_at: "t" },
  ]);
  const result = fetchIssueComments(REPO, 16, "", "D:/repo", () => ({ ok: true, stdout: payload }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fetch.comments.length, 1);
  assert.equal(result.fetch.maxId, "5");
  const empty = fetchIssueComments(REPO, 16, "", "D:/repo", () => ({ ok: true, stdout: "[]" }));
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal(empty.fetch.maxId, "");
});

test("fetchIssueComments refuses bad repos, issues and transport failures", () => {
  assert.equal(fetchIssueComments("not a repo", 16, "", "D:/repo", () => ({ ok: true, stdout: "[]" })).ok, false);
  assert.equal(fetchIssueComments(REPO, 0, "", "D:/repo", () => ({ ok: true, stdout: "[]" })).ok, false);
  const down = fetchIssueComments(REPO, 16, "", "D:/repo", () => ({ ok: false, stdout: "" }));
  assert.equal(down.ok, false);
  const broken = fetchIssueComments(REPO, 16, "", "D:/repo", () => ({ ok: true, stdout: "not-json" }));
  assert.equal(broken.ok, false);
});

test("fetchIssueComments sends since as a GET query parameter", () => {
  let seenArgs: string[] = [];
  fetchIssueComments(REPO, 16, "2026-11-06T14:00:00Z", "D:/repo", (args) => {
    seenArgs = args;
    return { ok: true, stdout: "[]" };
  });
  assert.ok(seenArgs.includes("--method"));
  assert.ok(seenArgs.includes("GET"));
  assert.ok(seenArgs.some((a) => a.startsWith("since=")));
  assert.ok(!seenArgs.some((a) => a === "POST"));
});
