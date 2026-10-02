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

let jiti;
try {
  jiti = require("jiti")(import.meta.url, { interopDefault: true, tryNative: false });
} catch {
  const piPkg = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@earendil-works", "pi-coding-agent");
  jiti = require(path.join(piPkg, "node_modules", "jiti"))(import.meta.url, { interopDefault: true });
}

const registered = { tools: [], events: [] };
const stubPi = {
  on(event, handler) {
    registered.events.push(event);
    return () => {};
  },
  registerTool(def) {
    registered.tools.push(def.name);
  },
  getAllTools: () => [{ name: "read" }],
};

const mod = jiti(path.join(root, "extensions", "index.ts"));
const target = mod?.default ?? mod;
target(stubPi);

if (registered.tools.length < 5) {
  console.error(`LOAD FAIL: only ${registered.tools.length} tools registered`);
  process.exit(1);
}
console.log(`jiti load OK · tools: ${registered.tools.join(", ")}`);
console.log(`events: ${registered.events.join(", ")}`);
