/**
 * Durable job ledger: atomic snapshot plus append-only event log.
 *
 * The snapshot is the reload path after compaction, restart, Pi replacement or
 * model replacement. The event log is the audit trail and is append-only, so a
 * crash between the two writes loses nothing that the snapshot does not
 * already describe.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { JobParseError, normalizeJob, type JobState } from "./schema.js";
import { ensureDir, type LedgerLocation } from "./paths.js";

export const ACTIVE_JOB_FILE = "active-job.json";
export const EVENTS_FILE = "events.jsonl";

export type JobReadResult =
  | { kind: "none" }
  | { kind: "loaded"; job: JobState }
  | { kind: "corrupt"; reason: string }
  | { kind: "future-version"; reason: string };

export function activeJobPath(loc: LedgerLocation): string {
  return path.join(loc.dir, ACTIVE_JOB_FILE);
}

export function eventsPath(loc: LedgerLocation): string {
  return path.join(loc.dir, EVENTS_FILE);
}

export function packetDir(loc: LedgerLocation, jobId: string): string {
  return path.join(loc.dir, "jobs", jobId);
}

/**
 * Read the active job. Never throws for expected on-disk problems: the caller
 * decides how to degrade, because a bad ledger file must not take down a
 * session.
 */
export function readJob(loc: LedgerLocation): JobReadResult {
  const file = activeJobPath(loc);
  if (!fs.existsSync(file)) return { kind: "none" };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { kind: "corrupt", reason: `unreadable: ${String(error)}` };
  }
  if (!text.trim()) return { kind: "none" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { kind: "corrupt", reason: `invalid JSON: ${String(error)}` };
  }
  try {
    return { kind: "loaded", job: normalizeJob(raw) };
  } catch (error) {
    if (error instanceof JobParseError) {
      const future = /newer than runtime/.test(error.message);
      return { kind: future ? "future-version" : "corrupt", reason: error.message };
    }
    return { kind: "corrupt", reason: String(error) };
  }
}

function writeFileAtomic(file: string, text: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    try {
      fs.renameSync(tmp, file);
    } catch (renameError) {
      // Windows can refuse a rename onto a file another handle still holds.
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
      void renameError;
    }
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export interface WriteOptions {
  /** Preserve the previous snapshot for forensics before replacing it. */
  backup?: boolean;
}

export function writeJob(loc: LedgerLocation, job: JobState, options: WriteOptions = {}): string {
  const file = activeJobPath(loc);
  if (options.backup && fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.copyFileSync(file, `${file}.bak-${stamp}`);
    } catch {
      /* backup is best-effort; the write below is the contract */
    }
  }
  writeFileAtomic(file, `${JSON.stringify(job, null, 2)}\n`);
  return file;
}

export function clearJob(loc: LedgerLocation): void {
  const file = activeJobPath(loc);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
}

/** Append one JSONL event. Never throws: telemetry must not break the run. */
export function appendEvent(loc: LedgerLocation, type: string, data: Record<string, unknown>): void {
  try {
    ensureDir(loc.dir);
    const line = `${JSON.stringify({ at: new Date().toISOString(), type, ...data })}\n`;
    fs.appendFileSync(eventsPath(loc), line, "utf8");
  } catch {
    /* event log is advisory */
  }
}

export function readEvents(loc: LedgerLocation, limit = 50): Record<string, unknown>[] {
  const file = eventsPath(loc);
  if (!fs.existsSync(file)) return [];
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-limit);
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* tolerate a torn final line */
    }
  }
  return out;
}

/**
 * Persist the raw mission packet outside the conversation. The packet is the
 * durable objective and constraints, not a transcript, and it survives session
 * replacement so a later run can re-read the contract verbatim.
 */
export function savePacket(loc: LedgerLocation, jobId: string, text: string): { sha256: string; bytes: number; path: string } {
  const dir = packetDir(loc, jobId);
  ensureDir(dir);
  const file = path.join(dir, "packet.md");
  writeFileAtomic(file, text.endsWith("\n") ? text : `${text}\n`);
  const buffer = Buffer.from(text, "utf8");
  return { sha256: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length, path: file };
}

export function readPacket(loc: LedgerLocation, jobId: string): string | undefined {
  const file = path.join(packetDir(loc, jobId), "packet.md");
  if (!fs.existsSync(file)) return undefined;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function makeJobId(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `job-${date}-${hash}`;
}
