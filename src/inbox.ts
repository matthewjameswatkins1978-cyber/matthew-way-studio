/**
 * GitHub issue inbox for workshop handoffs.
 *
 * One shared issue carries many humans' chatter, so wake-worthy messages use
 * one strict machine-readable envelope line; everything else is ignored (not
 * refused loudly — chatter is normal). Authorship proves nothing: the shared
 * workshop login cannot authenticate a role, so matching is by run, recipient
 * and cursor only, exactly as sleepwake.matchWake decides.
 *
 * Envelope (first matching line wins):
 *   WORKSHOP-HANDOFF run=<run_id> to=<ROLE> type=<type> from=<ROLE> [sha=<40hex>]
 * followed by the human body. Unknown roles, cross-run and stale messages are
 * filtered by matchWake, not here; this file only fetches and parses.
 */

import { run } from "./paths.js";
import type { HandoffMsg } from "./sleepwake.js";

export interface IssueComment {
  id: number;
  login: string;
  issue_url: string;
  body: string;
  created_at: string;
}

export type GhRunner = (args: string[], cwd: string) => { ok: boolean; stdout: string };

function defaultRunner(args: string[], cwd: string): { ok: boolean; stdout: string } {
  const result = run("gh", args, cwd, 30_000);
  return { ok: result.ok, stdout: result.stdout };
}

function parseComment(raw: unknown): IssueComment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const user = obj.user as Record<string, unknown> | undefined;
  if (
    typeof obj.id !== "number" ||
    !Number.isSafeInteger(obj.id) ||
    typeof user?.login !== "string" ||
    typeof obj.issue_url !== "string" ||
    typeof obj.body !== "string" ||
    typeof obj.created_at !== "string"
  ) {
    return undefined;
  }
  return { id: obj.id, login: user.login, issue_url: obj.issue_url, body: obj.body, created_at: obj.created_at };
}

const ENVELOPE = /WORKSHOP-HANDOFF\s+run=([A-Za-z0-9_.-]+)\s+to=([A-Za-z0-9_.-]+)\s+type=([A-Za-z0-9_.-]+)\s+from=([A-Za-z0-9_.-]+)(?:\s+sha=([0-9a-fA-F]{40}))?/;

/** Parse one comment body into a handoff message, or undefined for chatter. */
export function parseHandoffEnvelope(comment: IssueComment, repository: string): HandoffMsg | undefined {
  const match = ENVELOPE.exec(comment.body);
  if (!match) return undefined;
  const [, runId, to, type, from, sha] = match;
  if (!runId || !to || !type || !from) return undefined;
  return {
    id: String(comment.id),
    run_id: runId,
    repository,
    from,
    to,
    type,
    body: comment.body,
    ...(sha ? { sha: sha.toLowerCase() } : {}),
    created_at: comment.created_at,
  };
}

export interface InboxFetch {
  comments: IssueComment[];
  /** Highest comment id observed (chatter included), for cursor bounding. */
  maxId: string;
}

/**
 * Fetch comments newer than sinceIso (empty means all recent). Injectable
 * runner keeps tests offline; the default shells out to authenticated `gh`.
 */
export function fetchIssueComments(
  repository: string,
  issue: number,
  sinceIso: string,
  cwd: string,
  runner: GhRunner = defaultRunner,
): { ok: true; fetch: InboxFetch } | { ok: false; reason: string } {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return { ok: false, reason: "repository must be an exact owner/repository" };
  }
  if (!Number.isSafeInteger(issue) || issue < 1) return { ok: false, reason: "issue must be a positive integer" };
  const args = [`repos/${repository}/issues/${issue}/comments`, "--paginate", "--slurp", "--method", "GET", "-F", "per_page=100"];
  if (sinceIso) args.push("-F", `since=${sinceIso}`);
  const result = runner(args, cwd);
  if (!result.ok) return { ok: false, reason: "GitHub issue comments could not be read; check gh availability, authentication and network" };
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: "GitHub returned invalid comment data" };
  }
  const pages: unknown[] = Array.isArray(raw) ? raw : [raw];
  const comments: IssueComment[] = [];
  for (const page of pages) {
    const list = Array.isArray(page) ? page : [page];
    for (const entry of list) {
      const parsed = parseComment(entry);
      if (parsed) comments.push(parsed);
    }
  }
  let maxId = "";
  for (const comment of comments) {
    const id = String(comment.id);
    if (maxId === "" || id.length > maxId.length || (id.length === maxId.length && id > maxId)) maxId = id;
  }
  comments.sort((a, b) => a.id - b.id);
  return { ok: true, fetch: { comments, maxId } };
}

/** Parse every comment with a handoff envelope; chatter is skipped silently. */
export function parseHandoffs(comments: IssueComment[], repository: string): HandoffMsg[] {
  const out: HandoffMsg[] = [];
  for (const comment of comments) {
    const parsed = parseHandoffEnvelope(comment, repository);
    if (parsed) out.push(parsed);
  }
  return out;
}
