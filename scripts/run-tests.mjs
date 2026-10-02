#!/usr/bin/env node
/**
 * Deterministic test runner: typecheck, build, then node:test over the
 * compiled tests. Same shape as PiToRuleThemAll's runner so the workshop has
 * one convention for Pi packages.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function run(cmd, args, env) {
  const wrapped =
    process.platform === "win32" ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", cmd, ...args] } : { cmd, args };
  const r = spawnSync(wrapped.cmd, wrapped.args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
run("npx", ["tsc", "-p", "tsconfig.json"]);
const dir = path.join(root, "dist", "tests");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join("dist", "tests", f));
run("node", ["--test", ...files]);
