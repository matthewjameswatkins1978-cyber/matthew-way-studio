/**
 * Workshop run record: the single shared coordination file for one run.
 *
 * One JSON file per run (`workshop.<run_id>.json`) plus one heartbeat file
 * per worker (`workshop.<run_id>.<role>.heartbeat.json`) in the same ledger
 * directory that already holds active-job.json — the existing mechanism, no
 * new database. Each worker owns exactly one heartbeat file (atomic rewrite,
 * no lock contention); the run file changes rarely (membership, END/close)
 * and only through the authorised studio_end path.
 *
 * Pure persistence helpers (read/write/validate); policy lives in
 * sleepwake.ts and authority stays in the extension tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LedgerLocation } from "./paths.js";
import { compareIds, type RunRecord, type WorkerEntry } from "./sleepwake.js";

const MAX_DELIVERED_IDS = 200;

function runFile(dir: string, runId: string): string {
  return path.join(dir, `workshop.${runId}.json`);
}

function heartbeatFile(dir: string, runId: string, role: string): string {
  return path.join(dir, `workshop.${runId}.${role}.heartbeat.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** Accept an unknown blob as a RunRecord or throw with a legible reason. */
export function normalizeRunRecord(raw: unknown): RunRecord {
  if (!isRecord(raw)) throw new Error("run record is not an object");
  const workersRaw = Array.isArray(raw.workers) ? raw.workers : [];
  const workers: WorkerEntry[] = [];
  for (const entry of workersRaw) {
    if (!isRecord(entry)) continue;
    const role = str(entry.role);
    const workerSessionId = str(entry.worker_session_id);
    const status = str(entry.status);
    if (!role || !workerSessionId) continue;
    if (status !== "working" && status !== "waiting" && status !== "blocked" && status !== "finished" && status !== "ended") continue;
    workers.push({
      role,
      worker_session_id: workerSessionId,
      ...(typeof entry.branch === "string" ? { branch: entry.branch } : {}),
      ...(typeof entry.head_sha === "string" ? { head_sha: entry.head_sha } : {}),
      status,
      last_seen: str(entry.last_seen),
      ...(typeof entry.milestone === "string" ? { milestone: entry.milestone } : {}),
      ...(typeof entry.next_action === "string" ? { next_action: entry.next_action } : {}),
      ...(typeof entry.cursor === "string" ? { cursor: entry.cursor } : {}),
    });
  }
  const runId = str(raw.run_id);
  if (!runId) throw new Error("run record has no run_id");
  const record: RunRecord = {
    run_id: runId,
    repository: str(raw.repository),
    issue: typeof raw.issue === "number" && Number.isSafeInteger(raw.issue) ? raw.issue : 0,
    ...(typeof raw.owner_session_id === "string" && raw.owner_session_id ? { owner_session_id: raw.owner_session_id } : {}),
    workers,
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  };
  if (isRecord(raw.closed)) {
    const outcome = str(raw.closed.outcome);
    if (outcome === "ended" || outcome === "finished" || outcome === "cancelled") {
      record.closed = { outcome, at: str(raw.closed.at), by: str(raw.closed.by) };
    }
  }
  return record;
}

export function readRunRecord(location: LedgerLocation, runId: string): RunRecord | undefined {
  let text: string;
  try {
    text = fs.readFileSync(runFile(location.dir, runId), "utf8");
  } catch {
    return undefined;
  }
  try {
    return normalizeRunRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Atomic write via temp file + rename (same volume: the ledger directory). */
export function writeRunRecord(location: LedgerLocation, run: RunRecord): void {
  const file = runFile(location.dir, run.run_id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...run, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** This worker's own heartbeat: atomic rewrite, no shared lock needed. */
export function writeHeartbeat(location: LedgerLocation, runId: string, entry: WorkerEntry): void {
  const file = heartbeatFile(location.dir, runId, entry.role);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...entry, last_seen: new Date().toISOString() }, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function readHeartbeat(location: LedgerLocation, runId: string, role: string): WorkerEntry | undefined {
  let text: string;
  try {
    text = fs.readFileSync(heartbeatFile(location.dir, runId, role), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    if (str(parsed.role) !== role) return undefined;
    const status = str(parsed.status);
    if (status !== "working" && status !== "waiting" && status !== "blocked" && status !== "finished" && status !== "ended") return undefined;
    const workerSessionId = str(parsed.worker_session_id);
    if (!workerSessionId) return undefined;
    return {
      role,
      worker_session_id: workerSessionId,
      ...(typeof parsed.branch === "string" ? { branch: parsed.branch } : {}),
      ...(typeof parsed.head_sha === "string" ? { head_sha: parsed.head_sha } : {}),
      status,
      last_seen: str(parsed.last_seen),
      ...(typeof parsed.milestone === "string" ? { milestone: parsed.milestone } : {}),
      ...(typeof parsed.next_action === "string" ? { next_action: parsed.next_action } : {}),
      ...(typeof parsed.cursor === "string" ? { cursor: parsed.cursor } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Merge heartbeats over the run membership so the roster shows live presence.
 * Unknown heartbeat files (no member entry) are reported, never merged.
 */
export function rosterWithHeartbeats(record: RunRecord, heartbeats: WorkerEntry[]): { workers: WorkerEntry[]; unknown: string[] } {
  const byRole = new Map(heartbeats.map((h) => [h.role, h]));
  const workers = record.workers.map((member) => byRole.get(member.role) ?? member);
  const memberRoles = new Set(record.workers.map((w) => w.role));
  const unknown = heartbeats.filter((h) => !memberRoles.has(h.role)).map((h) => h.role);
  return { workers, unknown: [...new Set(unknown)] };
}

/** Delivered handoff ids live beside the run record, bounded and deduplicated. */
export function deliveredPath(location: LedgerLocation, runId: string): string {
  return path.join(location.dir, `workshop.${runId}.delivered.json`);
}

export function readDeliveredIds(location: LedgerLocation, runId: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(deliveredPath(location, runId), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && /^[0-9]+$/.test(id));
  } catch {
    return [];
  }
}

/** Record a delivered handoff id; keeps the newest MAX_DELIVERED_IDS. */
export function markDelivered(location: LedgerLocation, runId: string, id: string): void {
  const ids = readDeliveredIds(location, runId).filter((existing) => existing !== id);
  ids.push(id);
  while (ids.length > MAX_DELIVERED_IDS) ids.shift();
  const file = deliveredPath(location, runId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ids)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/** Highest delivered id, for cross-restart duplicate suppression. */
export function maxDeliveredId(location: LedgerLocation, runId: string): string {
  let best = "";
  for (const id of readDeliveredIds(location, runId)) {
    if (best === "" || compareIds(id, best) > 0) best = id;
  }
  return best;
}

/** Read the run record, creating it with the caller as owner when absent. */
export function ensureRunRecord(
  location: LedgerLocation,
  init: { run_id: string; repository: string; issue: number; owner_session_id: string },
): RunRecord {
  const existing = readRunRecord(location, init.run_id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const record: RunRecord = {
    run_id: init.run_id,
    repository: init.repository,
    issue: init.issue,
    workers: [],
    owner_session_id: init.owner_session_id,
    created_at: now,
    updated_at: now,
  };
  writeRunRecord(location, record);
  return record;
}

/** Add or refresh one worker entry; membership writes stay owner-side. */
export function upsertWorker(location: LedgerLocation, runId: string, entry: WorkerEntry): RunRecord | undefined {
  const record = readRunRecord(location, runId);
  if (!record) return undefined;
  const idx = record.workers.findIndex((w) => w.role === entry.role);
  if (idx >= 0) record.workers[idx] = entry;
  else record.workers.push(entry);
  writeRunRecord(location, record);
  return record;
}
