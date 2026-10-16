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
  return path.join(loc.dir, loc.workerKey ? `active-job.${loc.workerKey}.json` : ACTIVE_JOB_FILE);
}

export function eventsPath(loc: LedgerLocation): string {
  return path.join(loc.dir, loc.workerKey ? `events.${loc.workerKey}.jsonl` : EVENTS_FILE);
}

export function packetDir(loc: LedgerLocation, jobId: string): string {
  return path.join(loc.dir, "jobs", ...(loc.workerKey ? [loc.workerKey] : []), jobId);
}

/**
 * Read the legacy shared snapshot without claiming it. Worker-scoped reads
 * never consult the legacy file: an unrelated Pi session must not
 * automatically inherit another worker's in-flight mission. Explicit,
 * opt-in adoption is the only path (see adoptLegacyJob).
 */
export function readLegacySnapshot(loc: LedgerLocation): JobReadResult {
  return readJob({ ...loc, workerId: undefined, workerKey: undefined });
}

export type LegacyAdoption =
  | { ok: true; job: JobState }
  | { ok: false; reason: string };

/**
 * Explicitly adopt the legacy shared snapshot into this worker's scoped file.
 * The caller must name the exact expected job id out of band (Matthew tells
 * the owning worker; nothing is inferred from the shared directory). The
 * legacy file is preserved verbatim so a failed migration stays recoverable.
 * Single-winner: a second worker adopting the same legacy job is refused.
 */
export function adoptLegacyJob(loc: LedgerLocation, expectedJobId: string): LegacyAdoption {
  if (!loc.workerId || !loc.workerKey) return { ok: false, reason: "adoption needs a worker-scoped ledger location" };
  if (!expectedJobId.trim()) return { ok: false, reason: "adoption needs the exact legacy job id" };
  const legacy = readLegacySnapshot(loc);
  if (legacy.kind !== "loaded") return { ok: false, reason: "no adoptable legacy mission snapshot" };
  if (legacy.job.job_id !== expectedJobId) return { ok: false, reason: "legacy job id does not match the expected mission" };
  if (claimIsForeign(legacy.job.worker_session_id, loc.workerId, undefined)) {
    return { ok: false, reason: "legacy mission already belongs to another worker" };
  }
  if (fs.existsSync(activeJobPath(loc))) return { ok: false, reason: "this worker already has an active mission" };
  const claimDir = path.join(loc.dir, "legacy-adoptions");
  ensureDir(claimDir);
  const claim = path.join(claimDir, `${createHash("sha256").update(legacy.job.job_id).digest("hex")}.json`);
  const value = { job_id: legacy.job.job_id, worker_session_id: loc.workerId, at: new Date().toISOString() };
  try {
    const fd = fs.openSync(claim, "wx");
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8"); } finally { fs.closeSync(fd); }
  } catch {
    try {
      const prior = JSON.parse(fs.readFileSync(claim, "utf8")) as Record<string, unknown>;
      if (prior.job_id !== legacy.job.job_id || prior.worker_session_id !== loc.workerId) {
        return { ok: false, reason: "legacy mission was already adopted by another worker" };
      }
    } catch {
      return { ok: false, reason: "legacy adoption record is unreadable" };
    }
  }
  const owned = { ...legacy.job, worker_session_id: loc.workerId };
  writeJob(loc, owned);
  return { ok: true, job: owned };
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
    const job = normalizeJob(raw);
    if (loc.workerId && job.worker_session_id && job.worker_session_id !== loc.workerId) return { kind: "none" };
    return { kind: "loaded", job };
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
  if (loc.workerId && job.worker_session_id && loc.workerId !== job.worker_session_id) {
    throw new Error("refusing to write another Pi worker's mission");
  }
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

/**
 * Sessions without a stable Pi session id get a synthesised claim that is
 * unique per process. It is recorded on the missions they create so any other
 * session can tell a live writable mission from shared history.
 */
export function makeSessionToken(): string {
  return `legacy:${process.pid}:${randomUUID().slice(0, 8)}`;
}

function claimProcessAlive(claim: string): boolean {
  const pid = Number(claim.split(":")[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Ownership of a mission claim. A claim naming this session (stable worker id
 * or synthesised token) is mine. A legacy claim whose process is gone is
 * inheritable: nobody can be writing that mission. Anything else is somebody
 * else's writable mission and must stay read-only here.
 */
export function claimIsForeign(claim: string | undefined, workerId: string | undefined, sessionToken: string | undefined): boolean {
  if (!claim) return false;
  if (workerId && claim === workerId) return false;
  if (sessionToken && claim === sessionToken) return false;
  if (claim.startsWith("legacy:") && !claimProcessAlive(claim)) return false;
  return true;
}

export function stateSnapshotPath(loc: LedgerLocation, jobId: string): string {
  return path.join(packetDir(loc, jobId), "state.json");
}

/**
 * Park a full mission record beside its packet before the active slot moves
 * on. History is preserved verbatim, so a parked or replaced mission stays
 * recoverable and its evidence and authority state are never rewritten away.
 */
export function saveJobSnapshot(loc: LedgerLocation, job: JobState): string {
  const file = stateSnapshotPath(loc, job.job_id);
  writeFileAtomic(file, `${JSON.stringify(job, null, 2)}\n`);
  return file;
}

export function readJobSnapshot(loc: LedgerLocation, jobId: string): JobReadResult {
  const file = stateSnapshotPath(loc, jobId);
  if (!fs.existsSync(file)) return { kind: "none" };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const job = normalizeJob(raw);
    if (loc.workerId && job.worker_session_id && job.worker_session_id !== loc.workerId) return { kind: "none" };
    return { kind: "loaded", job };
  } catch (error) {
    return { kind: "corrupt", reason: String(error) };
  }
}

/** Parked missions, newest first, for status reporting and recovery. */
export function listJobSnapshots(loc: LedgerLocation): JobState[] {
  const dir = path.join(loc.dir, "jobs", ...(loc.workerKey ? [loc.workerKey] : []));
  if (!fs.existsSync(dir)) return [];
  const out: JobState[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = readJobSnapshot(loc, entry.name);
    if (read.kind === "loaded") out.push(read.job);
  }
  return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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
