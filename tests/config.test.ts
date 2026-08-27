// Config precedence: env > project config.json > global config.json > defaults.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globalConfigPath,
  maskValue,
  projectConfigPath,
  resolveConfig,
  writeConfigFile,
} from "../src/framework/config.ts";
import { manifest } from "../src/plugin/manifest.ts";

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aps-cfg-"));
  mkdirSync(d, { recursive: true });
  return d;
}

function field(key: string) {
  const f = manifest.config.find((x) => x.key === key);
  assert.ok(f, `config field ${key}`);
  return f;
}

const origEnv: Record<string, string | undefined> = {};
for (const f of manifest.config) origEnv[f.env] = process.env[f.env];

test.after(() => {
  for (const f of manifest.config) {
    if (origEnv[f.env] === undefined) delete process.env[f.env];
    else process.env[f.env] = origEnv[f.env];
  }
});

test("default layer: field defaults apply when nothing is configured", () => {
  const cfg = resolveConfig(manifest, tmpDir(), tmpDir());
  assert.equal(cfg.values.pluginData, "");
  assert.equal(cfg.values.autoSteerUncompleted, true);
  assert.equal(cfg.values.maxSteeringTurns, 5);
  assert.equal(cfg.sources.autoSteerUncompleted, "default");
});

test("project layer beats global; sources tracked", () => {
  const cwd = tmpDir();
  const home = tmpDir();
  // global value first
  const gp = globalConfigPath(manifest, home);
  mkdirSync(join(gp, ".."), { recursive: true });
  writeFileSync(gp, JSON.stringify({ autoSteerUncompleted: false, maxSteeringTurns: 9 }, null, 2));
  // then project value
  writeConfigFile(manifest, cwd, { autoSteerUncompleted: true });

  const cfg = resolveConfig(manifest, cwd, home);
  assert.equal(cfg.values.autoSteerUncompleted, true);
  assert.equal(cfg.sources.autoSteerUncompleted, "project");
  assert.equal(cfg.values.maxSteeringTurns, 9);
  assert.equal(cfg.sources.maxSteeringTurns, "global");
  assert.equal(cfg.file, projectConfigPath(manifest, cwd));
});

test("env layer beats everything; boolean/number coerced", () => {
  const cwd = tmpDir();
  writeConfigFile(manifest, cwd, { autoSteerUncompleted: false, maxSteeringTurns: 2 });
  process.env[field("autoSteerUncompleted").env] = "true";
  process.env[field("maxSteeringTurns").env] = "9";

  const cfg = resolveConfig(manifest, cwd, tmpDir());
  assert.equal(cfg.values.autoSteerUncompleted, true);
  assert.equal(cfg.sources.autoSteerUncompleted, "env");
  assert.equal(cfg.values.maxSteeringTurns, 9);
  delete process.env[field("autoSteerUncompleted").env];
  delete process.env[field("maxSteeringTurns").env];
});

test("maskValue hides all but head+tail; short values fully masked", () => {
  assert.equal(maskValue("sk-1234567890ab"), "sk-******ab");
  assert.equal(maskValue("short"), "***");
});

test("broken config files fall back to lower layers", () => {
  const cwd = tmpDir();
  const bad = projectConfigPath(manifest, cwd);
  mkdirSync(join(bad, ".."), { recursive: true });
  writeFileSync(bad, "{not json");
  const cfg = resolveConfig(manifest, cwd, tmpDir());
  assert.equal(cfg.values.autoSteerUncompleted, true); // default survived
  assert.equal(cfg.sources.autoSteerUncompleted, "default");
});
