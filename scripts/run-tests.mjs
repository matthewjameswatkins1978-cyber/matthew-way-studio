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
const files = fs
  .readdirSync(path.join(root, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("dist", "tests", f.replace(/\.ts$/, ".js")));
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing compiled test: ${file}`);
}
run("node", ["--test", ...files]);
