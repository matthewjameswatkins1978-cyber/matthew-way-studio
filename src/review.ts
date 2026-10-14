/** Read only the minimal live GitHub facts needed to bind a reviewer wait. */
import { run } from "./paths.js";

export interface PullRequestSnapshot {
  repository: string;
  number: number;
  state: string;
  url: string;
  branch: string;
  head_sha: string;
}

export type PullRequestRead = { ok: true; pull_request: PullRequestSnapshot } | { ok: false; reason: string };

/**
 * Query GitHub CLI using argv (never a shell string), and retain only the
 * identity fields Studio needs. Command output and credentials are not logged.
 */
export function readPullRequest(repository: string, number: number, cwd: string): PullRequestRead {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return { ok: false, reason: "mission remote is not a canonical GitHub owner/repository" };
  if (!Number.isSafeInteger(number) || number < 1) return { ok: false, reason: "pull request number must be a positive integer" };
  const result = run("gh", ["api", `repos/${repository}/pulls/${number}`], cwd, 15_000);
  if (!result.ok) return { ok: false, reason: "GitHub CLI could not verify this pull request; check gh availability and authentication" };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "GitHub returned invalid pull request data" };
  }
  const base = raw.base as Record<string, unknown> | undefined;
  const baseRepo = base?.repo as Record<string, unknown> | undefined;
  const head = raw.head as Record<string, unknown> | undefined;
  const url = typeof raw.html_url === "string" ? raw.html_url : "";
  const branch = typeof head?.ref === "string" ? head.ref : "";
  const headSha = typeof head?.sha === "string" ? head.sha : "";
  const numberOut = typeof raw.number === "number" ? raw.number : 0;
  const repoOut = typeof baseRepo?.full_name === "string" ? baseRepo.full_name : "";
  const state = typeof raw.state === "string" ? raw.state : "";
  if (!url || !branch || !/^[0-9a-f]{40}$/i.test(headSha) || numberOut !== number || repoOut.toLowerCase() !== repository.toLowerCase()) {
    return { ok: false, reason: "pull request identity is incomplete or does not match the requested repository and number" };
  }
  return { ok: true, pull_request: { repository: repoOut, number: numberOut, state, url, branch, head_sha: headSha.toLowerCase() } };
}