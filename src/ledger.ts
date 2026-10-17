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

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function claimProcessAlive(claim: string): boolean {
  return pidAlive(Number(claim.split(":")[1]));
}

/**
 * Ownership of a mission claim. A claim naming this session (stable worker id
 * or synthesised token) is mine. A legacy claim whose process is gone is
 * inheritable: nobody can be writing that mission. Anything else is somebody
 * else's writable mission and must stay read-only here.
 */
/** A legacy claim whose process is gone: unowned until someone takes it. */
export function claimIsAbandoned(claim: string | undefined): boolean {
  return Boolean(claim) && (claim as string).startsWith("legacy:") && !claimProcessAlive(claim as string);
}

export function claimIsForeign(claim: string | undefined, workerId: string | undefined, sessionToken: string | undefined): boolean {
  if (!claim) return false;
  if (workerId && claim === workerId) return false;
  if (sessionToken && claim === sessionToken) return false;
  if (claimIsAbandoned(claim)) return false;
  return true;
}

/** The identity a mutation presents when claiming an abandoned mission. */
export interface ClaimHolder {
  /** Stable Pi session id when the context exposes one. */
  workerId?: string;
  /** Synthesised claim token for sessions without a stable id. */
  sessionToken: string;
}

export interface MutateResult {
  ok: boolean;
  reason?: string;
  job?: JobState;
}

function claimLockPath(loc: LedgerLocation): string {
  return path.join(loc.dir, `claim-lock${loc.workerKey ? `.${loc.workerKey}` : ""}`);
}

interface ClaimLockEntry {
  path: string;
  uid: string;
  createdAt: number;
  known: boolean;
  dead: boolean;
}

/** Names this lock creates: the legacy fixed name and `<prefix>.<uid>`. */
function isClaimLockName(name: string, prefix: string): boolean {
  if (name === prefix) return true;
  if (!name.startsWith(`${prefix}.`)) return false;
  return /^\d+-[0-9a-f]{8}$/.test(name.slice(prefix.length + 1));
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Inspection must fail closed: a lock set that could not be inspected is
 * never evidence that no competing lock exists. Only a genuine ENOENT — a
 * lock concurrently removed between listing and reading — counts as absence;
 * every other filesystem error is surfaced immediately instead of being
 * treated as an empty lock set.
 */
export function inspectClaimLocks(dir: string, prefix: string): ClaimLockEntry[] {
  const out: ClaimLockEntry[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    throw new Error(`claim lock inspection failed at ${dir}: ${(error as NodeJS.ErrnoException).code ?? error}. Failing closed rather than assuming no competing lock exists.`);
  }
  for (const name of names) {
    if (!isClaimLockName(name, prefix)) continue;
    const file = path.join(dir, name);
    let createdAt = 0;
    try {
      createdAt = fs.statSync(file).mtimeMs;
    } catch (error) {
      if (isEnoent(error)) continue; // genuine race: the lock was removed
      throw new Error(`claim lock inspection failed at ${file}: ${(error as NodeJS.ErrnoException).code ?? error}. Failing closed rather than treating an uninspected lock as absent.`);
    }
    let uid = name;
    let known = false;
    let dead = false;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number; uid?: string };
      const pid = Number(raw.pid);
      if (Number.isFinite(pid) && pid > 0) {
        known = true;
        dead = !pidAlive(pid);
      }
      if (typeof raw.uid === "string" && raw.uid) uid = raw.uid;
    } catch (error) {
      if (isEnoent(error)) continue; // genuine race: the lock was removed
      // Unreadable-but-present owner metadata: keep the entry as an unknown
      // owner so it blocks contenders instead of vanishing from the view.
      known = false;
    }
    out.push({ path: file, uid, createdAt, known, dead });
  }
  return out;
}

/**
 * Exclusive claim lock across processes, one ownership-sensitive
 * read-modify-write at a time per mission slot. Every acquisition creates a
 * UNIQUENY named lock file (`<prefix>.<pid>-<uid>`), so a lock file can only
 * ever be deleted by its own owner or garbage-collected once its owner is
 * provably dead: two competing recoveries can never delete a newly acquired
 * winner's lock. Contenders elect the oldest live lock (creation time, then
 * uid as tiebreak) and re-scan once after a settle window before entering, so
 * concurrent creators resolve to exactly one winner. Unknown-owner locks fail
 * closed with a clear recovery diagnostic; every retry is deadline-bounded.
 */
export function withClaimLock<T>(loc: LedgerLocation, fn: () => T, timeoutMs = 5_000): T {
  const lockPath = claimLockPath(loc);
  const dir = path.dirname(lockPath);
  const prefix = path.basename(lockPath);
  try {
    ensureDir(dir);
  } catch (error) {
    // A lock whose directory cannot even be created can be neither inspected
    // nor retried: surface the filesystem error immediately.
    throw new Error(`claim lock could not be created at ${lockPath}: ${(error as NodeJS.ErrnoException).code ?? error}. Fix the filesystem problem and retry.`);
  }
  const uid = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const mine = path.join(dir, `${prefix}.${uid}`);
  try {
    fs.writeFileSync(mine, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), uid })}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new Error(`claim lock could not be created at ${mine}: ${(error as NodeJS.ErrnoException).code ?? error}. Fix the filesystem problem and retry.`);
  }
  // Order contenders by their files' actual timestamps: an integer wall-clock
  // floor would rank same-millisecond neighbours inconsistently.
  let createdAt = 0;
  try {
    createdAt = fs.statSync(mine).mtimeMs;
  } catch (error) {
    throw new Error(`claim lock inspection failed at ${mine}: ${(error as NodeJS.ErrnoException).code ?? error}. Failing closed rather than proceeding unseeded.`);
  }
  try {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    for (;;) {
      const others = inspectClaimLocks(dir, prefix).filter((entry) => entry.path !== mine);
      // Garbage-collect only locks whose owners are provably dead. The names
      // are unique per acquisition, so this delete can never touch a live
      // winner's lock — that is the whole safety argument.
      for (const other of others) {
        if (other.known && other.dead) {
          try {
            fs.rmSync(other.path, { force: true });
          } catch {
            /* another contender collected it first */
          }
        }
      }
      const blockers = others.filter((entry) => {
        if (entry.known && entry.dead) return false;
        // A lock in the modern `<prefix>.<uid>` form is an election
        // contender: the oldest wins and the rest yield. A lock of any other
        // provenance (a legacy fixed name) always blocks while its owner is
        // live or unprovable — it may already hold the section and it never
        // yields, so its age must not be used to overtake it.
        if (path.basename(entry.path) !== prefix) {
          return entry.createdAt < createdAt || (entry.createdAt === createdAt && entry.uid < uid);
        }
        return true;
      });
      if (blockers.length === 0) {
        if (!settled) {
          // Two creators can each miss the other in a single directory scan;
          // re-scan after a settle window before entering.
          settled = true;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
          continue;
        }
        return fn();
      }
      settled = false;
      if (Date.now() >= deadline) {
        const unknown = blockers.find((entry) => !entry.known);
        throw new Error(
          unknown
            ? `claim lock timeout: ${unknown.path} has no readable owner and its holder cannot be proven dead; failing closed rather than stealing. If its holder crashed before writing its identity, remove the stale lock manually: ${unknown.path}`
            : `claim lock timeout: ${blockers.map((entry) => entry.path).join(", ")} ${blockers.length === 1 ? "is" : "are"} held by a live session; wait for it to finish and retry.`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } finally {
    // Only an owner deletes its own lock, and its name is unique to this
    // acquisition: this delete can never touch anyone else's lock.
    try {
      fs.rmSync(mine, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * The one authoritative ownership-sensitive mutation. Runs under the claim
 * lock: it re-reads the current record, enforces claim ownership, acquires an
 * abandoned claim exactly once (competing processes lose), applies the
 * mutation to THAT authoritative job and writes it. Callers must build their
 * mutation from the fresh job handed to `fn` — never from an earlier read —
 * so a recovery can never be undone by a stale write.
 *
 * `emergencyStop` is the single documented cross-session write: it only ever
 * disarms automatic continuation, never takes ownership, and still refuses a
 * stable foreign worker's mission.
 */
export function mutateJob(
  loc: LedgerLocation,
  holder: ClaimHolder,
  fn: (fresh: JobState) => JobState | undefined,
  opts: { emergencyStop?: boolean; timeoutMs?: number } = {},
): MutateResult {
  return withClaimLock(
    loc,
    () => {
      const read = readJob(loc);
      if (read.kind !== "loaded") {
        return { ok: false, reason: read.kind === "none" ? "no active Studio mission" : `mission record is ${read.kind}` };
      }
      const current = read.job;
      const claim = current.worker_session_id;
      const mine = Boolean(claim) && (claim === holder.workerId || claim === holder.sessionToken);
      const unclaimed = !claim;
      const abandoned = claimIsAbandoned(claim);
      if (opts.emergencyStop) {
        const stableForeign = typeof claim === "string" && !claim.startsWith("legacy:") && claim !== holder.workerId && claim !== holder.sessionToken;
        if (stableForeign) return { ok: false, reason: "this mission belongs to another Pi session" };
      } else if (!mine && !abandoned && !unclaimed) {
        return { ok: false, reason: "this mission belongs to another Pi session" };
      }
      // The first mutation atomically establishes exclusive ownership of an
      // unclaimed or abandoned record: the claim lands in the very same write
      // as the mutation, so two competing sessions can never both own it. An
      // emergency stop never takes ownership.
      const taken = holder.workerId ?? holder.sessionToken;
      const acquiring = !mine && !opts.emergencyStop && (abandoned || unclaimed);
      let base = current;
      if (acquiring) {
        base = { ...current, worker_session_id: taken, updated_at: new Date().toISOString() };
      }
      const next = fn(base);
      if (!next) return { ok: true, job: base };
      writeJob(loc, next);
      if (acquiring) appendEvent(loc, "claim-taken", { job_id: next.job_id, from: claim ?? "", to: taken });
      return { ok: true, job: next };
    },
    opts.timeoutMs,
  );
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
