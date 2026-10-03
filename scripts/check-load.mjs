/**
 * Load the extension exactly the way Pi does (jiti + TypeScript source) and
 * register it against a stub Pi API. No inference, no session, no model call:
 * this proves module resolution and registration, which is what a real Pi
 * startup needs to survive.
 *
 *   node scripts/check-load.mjs
 */
import { createRequire } from "node:module";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function loadJiti() {
  const candidates = [
    "jiti",
    path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti"),
  ];
  const appData = process.env.APPDATA?.trim();
  if (appData) {
    candidates.push(path.join(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "jiti"));
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      const factory = require(candidate);
      return factory(import.meta.url, { interopDefault: true, tryNative: false });
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  throw new Error(`Cannot locate Pi's jiti loader. Tried:\n- ${failures.join("\n- ")}`);
}

const jiti = loadJiti();

const registered = { tools: [], events: [], commands: [] };
const stubPi = {
  on(event, handler) {
    registered.events.push(event);
    return () => {};
  },
  registerTool(def) {
    registered.tools.push(def.name);
  },
  registerCommand(name) {
    registered.commands.push(name);
  },
  sendUserMessage() {},
  getAllTools: () => [{ name: "read" }],
};

const mod = jiti(path.join(root, "extensions", "index.ts"));
const target = mod?.default ?? mod;
target(stubPi);

if (!registered.commands.includes("studio")) throw new Error("Studio compatibility command did not register");
if (registered.tools.length < 5) {
  console.error(`LOAD FAIL: only ${registered.tools.length} tools registered`);
  process.exit(1);
}
console.log(`jiti load OK · tools: ${registered.tools.join(", ")}`);
console.log(`events: ${registered.events.join(", ")}`);
