// CLI end-to-end: subcommands, config set/get, doctor (no business checks —
// goal-acceptance is tool-driven), dry-run install, and unknown commands.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/plugin/manifest.ts";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "aps-cli-"));
  mkdirSync(d, { recursive: true });
  return d;
}

const REPO = join(import.meta.dirname, "..");

test("version prints manifest.version", () => {
  const r = run(["version"], REPO);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), manifest.version);
});

test("help lists the CLI, targets, and subcommands", () => {
  const r = run(["help"], REPO);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(`${manifest.name} v${manifest.version}`));
  assert.ok(r.stdout.includes("install"));
  assert.ok(r.stdout.includes("doctor"));
  assert.ok(r.stdout.includes("mcp"));
});

test("config get default + set/get round-trip in a scratch project", () => {
  const dir = tmpDir();
  const get = run(["config", "get", "maxSteeringTurns"], dir);
  assert.equal(get.stdout.trim(), "5"); // default layer

  const set = run(["config", "set", "maxSteeringTurns", "9"], dir);
  assert.equal(set.status, 0);
  assert.ok(set.stdout.includes("maxSteeringTurns = 9"));

  const after = run(["config", "get", "maxSteeringTurns"], dir);
  assert.equal(after.stdout.trim(), "9");

  // config file landed in the project config dir
  const path = run(["config", "path"], dir);
  assert.ok(path.stdout.includes(join(manifest.markers.configDir, "config.json")));
});

test("config set coerces booleans", () => {
  const dir = tmpDir();
  const set = run(["config", "set", "autoSteerUncompleted", "false"], dir);
  assert.equal(set.status, 0);
  const get = run(["config", "get", "autoSteerUncompleted"], dir);
  assert.equal(get.stdout.trim(), "false");
});

test("config get unknown key prints (not set)", () => {
  const r = run(["config", "get", "nope"], tmpDir());
  assert.equal(r.stdout.trim(), "(not set)");
});

test("doctor reports the resolved config and passes without business checks", () => {
  const r = run(["doctor"], REPO);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes("pluginData"), r.stdout);
  assert.ok(r.stdout.includes("maxSteeringTurns"), r.stdout);
});

test("install unknown target fails with a clear message", () => {
  const r = run(["install", "--non-interactive", "--target", "nope"], tmpDir());
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("unknown target: nope"), r.stderr);
});

test("unknown command fails", () => {
  const r = run(["frobnicate"], REPO);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes("unknown command: frobnicate"));
});
