import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolePreferenceSection } from "../src/roles.js";

test("existing Pi Studio role preferences are read without claiming route availability", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-role-test-"));
  writeFileSync(join(dir, "studio-models.json"), JSON.stringify({ version: 1, roles: {
    COORDINATOR: "qwen-token-plan/qwen3.8-max", IMPLEMENTER: "qwen-token-plan/qwen3.8-flash"
  } }));
  const section = rolePreferenceSection(dir);
  assert.match(section, /COORDINATOR: qwen-token-plan\/qwen3.8-max/);
  assert.match(section, /saved, not verified routes/);
  assert.match(section, /Do not silently switch to a metered route/);
});

test("missing or invalid preferences degrade safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-role-test-"));
  assert.equal(rolePreferenceSection(dir), "");
  writeFileSync(join(dir, "studio-models.json"), "{invalid");
  assert.match(rolePreferenceSection(dir), /unreadable/);
});
