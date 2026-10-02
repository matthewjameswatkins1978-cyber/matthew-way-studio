import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverLanternTools, lanternContextResult, readSnapshot } from "../src/lantern.js";

function freshStamp(offsetMinutes = 0): string {
  return new Date(Date.now() - offsetMinutes * 60_000).toISOString();
}

function mirror(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mws-lantern-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return dir;
}

function statusJson(generatedAt: string): string {
  return JSON.stringify({ format: "lantern-git-mirror-status", generated_at: generatedAt, record_count: 2 });
}

test("Lantern MCP tools are discovered through Pi's namespace separators", () => {
  const tools = [{ name: "read" }, { name: "mcp__lantern__lantern_context" }, { name: "mcp__lantern_keeper__lantern_why" }];
  const names = discoverLanternTools(tools);
  assert.equal(names?.context, "mcp__lantern__lantern_context");
  assert.equal(names?.why, "mcp__lantern_keeper__lantern_why");
  assert.equal(discoverLanternTools([{ name: "read" }]), undefined);
});

test("fresh snapshot yields bounded records for a matching query", () => {
  const dir = mirror({
    "status.json": statusJson(freshStamp()),
    "index/active-00000.jsonl": [
      JSON.stringify({ uuid: "a1", type: "memory", title: "ledger lives in git common dir" }),
      JSON.stringify({ uuid: "a2", type: "memory", title: "unrelated cooking note" }),
    ].join("\n"),
  });
  const res = readSnapshot("where should the job ledger live", { mirrorPath: dir, maxAgeMinutes: 60 });
  assert.equal(res.used, true);
  assert.match(res.text, /git common dir/);
  assert.match(res.detail, /1 record\(s\)/);
});

test("stale snapshot is refused as current truth", () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const dir = mirror({ "status.json": statusJson(old), "index/active-00000.jsonl": JSON.stringify({ title: "anything" }) });
  const res = readSnapshot("anything", { mirrorPath: dir, maxAgeMinutes: 60 });
  assert.equal(res.used, false);
  assert.match(res.detail, /stale/);
  // The same mirror becomes usable when the age allowance is widened.
  const widened = readSnapshot("anything", { mirrorPath: dir, maxAgeMinutes: 600 });
  assert.equal(widened.used, true);
});

test("missing mirror degrades without pretending", () => {
  assert.match(readSnapshot("q", {}).detail, /no lantern-git mirror configured/);
  assert.match(readSnapshot("q", { mirrorPath: path.join(os.tmpdir(), "mws-does-not-exist") }).detail, /status missing/);
  const broken = mirror({ "status.json": "{ not json" });
  assert.match(readSnapshot("q", { mirrorPath: broken }).detail, /unreadable/);
  const noTime = mirror({ "status.json": statusJson("") });
  assert.match(readSnapshot("q", { mirrorPath: noTime }).detail, /no readable generated_at/);
});

test("adapter prefers live MCP, then snapshot, then says unavailable", () => {
  const live = lanternContextResult("DECISION: state lives in git common dir", undefined, { used: false, text: "", detail: "none" });
  assert.equal(live.source, "mcp");
  assert.equal(live.available, true);

  const degraded = lanternContextResult(undefined, "connection refused", { used: true, text: "[snapshot 1] x", detail: "5m old" });
  assert.equal(degraded.source, "snapshot");
  assert.match(degraded.detail, /degraded read-only snapshot/);

  const none = lanternContextResult(undefined, "connection refused", { used: false, text: "", detail: "stale" });
  assert.equal(none.available, false);
  assert.equal(none.source, "none");
  assert.match(none.detail, /Lantern unavailable/);
});
