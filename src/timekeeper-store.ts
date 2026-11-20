/**
 * Timekeeper persistence: append-only host JSONL, bounded roster files,
 * weekly compressed archives with checksums, offline publish queue.
 *
 * No model calls, no network, no polling. All writes are atomic (temp file
 * + rename) except the single append-only JSONL, which is append-only by
 * design so a crash can tear at most the last line (tolerated on read).
 * Archives never touch open shifts or the last 7 days of history.
 */
import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { eventsPath } from "./ledger.js";
import { ensureDir, type LedgerLocation } from "./paths.js";
import { projectShifts, timekeeperEventId, TK_INTERRUPTION, TK_WAKE, type LedgerEvent } from "./timekeeper.js";

export const ROSTER_JSON = "timekeeper.roster.json";
export const ROSTER_MD = "timekeeper.roster.md";
export const SNAPSHOT_FILE = "timekeeper.snapshot.json";
export const ARCHIVE_DIR = "timekeeper-archive";
export const PENDING_FILE = "timekeeper.pending.json";
export const ARCHIVE_AFTER_MS = 7 * 24 * 3_600_000;

function writeAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Append one dedicated Timekeeper event to the shared host JSONL.
 * Returns the stable event id, or undefined when the disk write failed
 * (the caller queues the payload for a later retry instead of losing it).
 */
export function appendTimekeeperEvent(
  loc: LedgerLocation,
  type: typeof TK_WAKE | typeof TK_INTERRUPTION,
  data: Record<string, unknown> & { job_id: string },
  nowIso?: string,
): string | undefined {
  try {
    ensureDir(loc.dir);
    const at = nowIso ?? new Date().toISOString();
    const event_id = timekeeperEventId({
      type,
      job_id: data.job_id,
      at,
      trigger: typeof data.trigger_id === "string" ? data.trigger_id : typeof data.comment_id === "string" ? data.comment_id : "",
      detail: typeof data.detail === "string" ? data.detail : "",
    });
    const line = `${JSON.stringify({ at, type, event_id, ...data })}\n`;
    fs.appendFileSync(eventsPath(loc), line, "utf8");
    return event_id;
  } catch {
    return undefined;
  }
}

/** Read every event line; torn last line tolerated, cap guards memory. */
export function readAllEvents(loc: LedgerLocation, cap = 50_000): LedgerEvent[] {
  const file = eventsPath(loc);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out: LedgerEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.type === "string" && typeof parsed.at === "string") {
        out.push(parsed as LedgerEvent);
        if (out.length >= cap) break;
      }
    } catch {
      /* torn line: skip */
    }
  }
  return out;
}

export function writeRosterFiles(dir: string, json: Record<string, unknown>, text: string): void {
  writeAtomic(path.join(dir, ROSTER_JSON), `${JSON.stringify(json, null, 2)}\n`);
  writeAtomic(path.join(dir, ROSTER_MD), text.endsWith("\n") ? text : `${text}\n`);
}

export function readSnapshot(dir: string): Record<string, unknown> | undefined {
  const file = path.join(dir, SNAPSHOT_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export interface ArchiveResult {
  archived_files: string[];
  archived_events: number;
  kept_events: number;
  open_shifts: string[];
  snapshot: Record<string, unknown>;
}

function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

async function gunzipLines(file: string): Promise<string[]> {
  const chunks: Buffer[] = [];
  await pipeline(fs.createReadStream(file), createGunzip(), async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function gzipLines(file: string, lines: string[]): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await pipeline(async function* () {
    yield lines.map((l) => `${l}\n`).join("");
  }, createGzip(), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  fs.writeFileSync(`${file}.sha256`, `${sha256Hex(fs.readFileSync(file))}  ${path.basename(file)}\n`, "utf8");
}

/**
 * Move events of long-closed shifts into compressed weekly files.
 * Only events older than ARCHIVE_AFTER_MS whose shift is closed are moved;
 * open shifts, recent history and unfinished jobs are always preserved.
 * Replaying archived + active lines yields the same roster and totals.
 */
export async function archiveOldEvents(loc: LedgerLocation, nowMs = Date.now()): Promise<ArchiveResult> {
  const lines = fs.existsSync(eventsPath(loc)) ? fs.readFileSync(eventsPath(loc), "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const parsed: { line: string; event: LedgerEvent }[] = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as LedgerEvent;
      if (typeof event.type === "string" && typeof event.at === "string") parsed.push({ line, event });
    } catch {
      /* torn line: dropped only if unparseable; counted as kept-unsafe below */
    }
  }
  const projection = projectShifts(
    parsed.map((p) => p.event),
    nowMs,
  );
  // An event is archivable only when its agent+job key has at least one
  // closed shift and no open shift. Events the projector cannot attribute
  // to any shift (unknown types, orphans) are always kept: this archive
  // never deletes history it cannot account for.
  const closedKeys = new Set(projection.shifts.filter((s) => s.closed_at).map((s) => `${s.agent}|${s.job_id}`));
  const openKeys = new Set(projection.shifts.filter((s) => !s.closed_at).map((s) => `${s.agent}|${s.job_id}`));
  const cutoff = nowMs - ARCHIVE_AFTER_MS;

  const archivable: typeof parsed = [];
  const kept: string[] = [];
  for (const entry of parsed) {
    const atMs = Date.parse(entry.event.at);
    const jobId = typeof entry.event.job_id === "string" ? entry.event.job_id : "";
    const agent = typeof entry.event.worker_session_id === "string" ? entry.event.worker_session_id : typeof entry.event.session_id === "string" ? entry.event.session_id : "legacy";
    const key = `${agent}|${jobId}`;
    if (Number.isFinite(atMs) && atMs < cutoff && closedKeys.has(key) && !openKeys.has(key)) {
      archivable.push(entry);
    } else {
      kept.push(entry.line);
    }
  }

  const byWeek = new Map<string, string[]>();
  for (const entry of archivable) {
    const week = isoWeekKey(Date.parse(entry.event.at));
    const bucket = byWeek.get(week) ?? [];
    bucket.push(entry.line);
    byWeek.set(week, bucket);
  }

  const archiveDir = path.join(loc.dir, ARCHIVE_DIR);
  ensureDir(archiveDir);
  const archivedFiles: string[] = [];
  for (const [week, weekLines] of [...byWeek.entries()].sort()) {
    const file = path.join(archiveDir, `events-${week}.json.gz`);
    const existing = fs.existsSync(file) ? await gunzipLines(file) : [];
    const merged = [...existing];
    const seen = new Set(existing);
    for (const line of weekLines) {
      if (!seen.has(line)) {
        seen.add(line);
        merged.push(line);
      }
    }
    merged.sort();
    await gzipLines(file, merged);
    archivedFiles.push(`timekeeper-archive/events-${week}.json.gz`);
  }

  if (archivable.length > 0) {
    const tmp = `${eventsPath(loc)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    fs.renameSync(tmp, eventsPath(loc));
  }

  const snapshot: Record<string, unknown> = {
    schema: 1,
    as_of_utc: new Date(nowMs).toISOString(),
    archived_files: archivedFiles,
    archived_events: archivable.length,
    kept_events: kept.length,
    open_shifts: projection.shifts.filter((s) => !s.closed_at).map((s) => s.shift_id),
  };
  writeAtomic(path.join(loc.dir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
  const openShifts = projection.shifts.filter((shift) => !shift.closed_at).map((shift) => shift.shift_id);
  (snapshot as Record<string, unknown>).open_shifts = openShifts;
  return { archived_files: archivedFiles, archived_events: archivable.length, kept_events: kept.length, open_shifts: openShifts, snapshot };
}

/* ---------------- offline publish queue ---------------- */

export function queuePendingPublish(dir: string, payload: Record<string, unknown>): void {
  const existing = readPendingQueue(dir);
  existing.push({ queued_at_utc: new Date().toISOString(), ...payload });
  writeAtomic(path.join(dir, PENDING_FILE), `${JSON.stringify(existing.slice(-20), null, 2)}\n`);
}

export function readPendingQueue(dir: string): Record<string, unknown>[] {
  const file = path.join(dir, PENDING_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]).slice(-20) : [];
  } catch {
    return [];
  }
}

export function clearPendingQueue(dir: string): void {
  try {
    if (fs.existsSync(path.join(dir, PENDING_FILE))) fs.unlinkSync(path.join(dir, PENDING_FILE));
  } catch {
    /* advisory */
  }
}
