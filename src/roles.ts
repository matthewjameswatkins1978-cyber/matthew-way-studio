/** Read the existing Pi Studio role preferences without claiming route availability. */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROLES = ["COORDINATOR", "IMPLEMENTER", "FAST_WORKER", "RESEARCHER", "INDEPENDENT_INSPECTOR", "RELEASE_ENGINEER"] as const;

export function rolePreferenceSection(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(agentDir, "studio-models.json"), "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
    return "STUDIO ROLE PREFERENCES: configuration is unreadable; use the current configured Pi model and do not guess a route.";
  }
  if (typeof raw !== "object" || raw === null || !("version" in raw) || !("roles" in raw) ||
      (raw.version !== 1 && raw.version !== 2) || typeof raw.roles !== "object" || raw.roles === null) {
    return "STUDIO ROLE PREFERENCES: unsupported format; use the current configured Pi model and do not guess a route.";
  }
  const roles = raw.roles as Record<string, unknown>;
  const lines = ROLES.flatMap((role) => {
    const value = roles[role];
    const route = typeof value === "string" ? value :
      raw.version === 2 && typeof value === "object" && value !== null && "model" in value ? value.model : undefined;
    if (typeof route !== "string" || !/^[^\s/]+\/[^\s]+$/.test(route)) return [];
    const thinking = typeof value === "object" && value !== null && "thinkingLevel" in value && typeof value.thinkingLevel === "string"
      ? "; thinking " + value.thinkingLevel : "";
    return ["- " + role + ": " + route + thinking];
  });
  if (lines.length === 0) return "";
  return ["STUDIO ROLE PREFERENCES (saved, not verified routes):", ...lines,
    "Verify each provider/model in Pi's current catalog and authentication before use. Do not silently switch to a metered route."].join("\n");
}
