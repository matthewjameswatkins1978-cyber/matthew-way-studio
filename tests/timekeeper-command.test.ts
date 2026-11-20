/** Timekeeper command wiring: the real extension against a fake host and temp ledger. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerStudio } from "../extensions/index.js";
import type { PiContext } from "../src/pi-shim.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tk-command-"));
}

interface Captured {
  commands: Map<string, (args: string, ctx: PiContext) => Promise<void>>;
  notices: string[];
}

function fakeApi(cap: Captured) {
  return {
    on: () => () => {},
    registerTool: () => {},
    registerCommand: (name: string, options: { handler: (args: string, ctx: PiContext) => Promise<void> }) => {
      cap.commands.set(name, options.handler);
    },
  };
}

function ctxFor(dir: string, notices: string[]): PiContext {
  return {
    cwd: dir,
    mode: "print",
    hasUI: false,
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: () => {},
    },
    isProjectTrusted: () => true,
  } as unknown as PiContext;
}

function seedEvents(dir: string): void {
  // Fresh timestamps: the projector marks anything older than the staleness
  // window UNKNOWN, so fixtures stay recent relative to the real test clock.
  const now = Date.now();
  const ledger = path.join(dir, ".pi", "matthew-way-studio");
  fs.mkdirSync(ledger, { recursive: true });
  const lines = [
    { at: new Date(now - 10 * 60_000).toISOString(), type: "mission-start", job_id: "job-1", worker_session_id: "sess-A", remote: "o/r" },
    { at: new Date(now - 5 * 60_000).toISOString(), type: "handoff-wait", job_id: "job-1", worker_session_id: "sess-A", run_id: "run-1", role: "A2" },
  ];
  fs.writeFileSync(path.join(ledger, "events.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

test("timekeeper status renders the roster and refreshes Lucy-readable files", async () => {
  const dir = tempDir();
  seedEvents(dir);
  const cap: Captured = { commands: new Map(), notices: [] };
  registerStudio(fakeApi(cap) as never);
  const handler = cap.commands.get("timekeeper");
  assert.ok(handler, "timekeeper command registered");
  await handler!("", ctxFor(dir, cap.notices));
  assert.equal(cap.notices.length, 1);
  assert.match(cap.notices[0] ?? "", /WAITING/);
  assert.match(cap.notices[0] ?? "", /run-1/);
  const ledger = path.join(dir, ".pi", "matthew-way-studio");
  assert.ok(fs.existsSync(path.join(ledger, "timekeeper.roster.json")));
  assert.ok(fs.existsSync(path.join(ledger, "timekeeper.roster.md")));
  const roster = JSON.parse(fs.readFileSync(path.join(ledger, "timekeeper.roster.json"), "utf8")) as { agents: { availability: string }[] };
  assert.equal(roster.agents[0]?.availability, "WAITING");
});

test("timekeeper today and history render without touching roster files", async () => {
  const dir = tempDir();
  seedEvents(dir);
  const cap: Captured = { commands: new Map(), notices: [] };
  registerStudio(fakeApi(cap) as never);
  const handler = cap.commands.get("timekeeper");
  assert.ok(handler);
  await handler!("today", ctxFor(dir, cap.notices));
  assert.match(cap.notices[0] ?? "", /working/);
  await handler!("history", ctxFor(dir, cap.notices));
  assert.match(cap.notices[1] ?? "", /history \(1 shift\)/);
});

test("timekeeper respects the reversible disable flag", async () => {
  const dir = tempDir();
  seedEvents(dir);
  const cap: Captured = { commands: new Map(), notices: [] };
  registerStudio(fakeApi(cap) as never);
  process.env.STUDIO_TIMEKEEPER_ENABLED = "0";
  try {
    await cap.commands.get("timekeeper")!("", ctxFor(dir, cap.notices));
  } finally {
    delete process.env.STUDIO_TIMEKEEPER_ENABLED;
  }
  assert.match(cap.notices[0] ?? "", /disabled/);
});
