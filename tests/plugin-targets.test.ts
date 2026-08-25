// Plugin-target adapter integration tests (spawn the built CLI in scratch
// projects with a fake home). Guards the phase-D wiring:
//  - materialization: the shared ~/.<configDir>/plugin/ dir holds EXACTLY the
//    6 spec entries (plugin.json + mcp.json + .mcp.json + skills/ +
//    openclaw.plugin.json + openclaw-dist/)
//  - cursor: local plugin copy + marker file; uninstall marker-checked
//    (missing marker → skipped, user copy kept)
//  - copilot: enabledPlugins fallback in ~/.copilot/settings.json when the
//    CLI is absent from PATH (idempotent; entry removed on uninstall)
//  - vscode: chat.pluginLocations entry keyed by the materialized dir;
//    uninstall removes only configDir-keyed entries, then drops empty
//    containers
//  - chatgpt-codex: local marketplace shim written OUTSIDE the materialized
//    dir; manual guidance when the codex CLI is absent
//
// Tests that must not touch a real machine CLI (copilot/codex are present on
// the dev box) run with a minimal PATH so the adapter takes its fallback /
// manual branch.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/plugin/manifest.ts";
import { adapters } from "../src/plugin/targets/index.ts";

// Target tests self-skip when the scaffold pruned that target out.
const has = (id: string): boolean => adapters.some((a) => a.id === id);

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
// Empty scratch dir as PATH: no copilot/codex/code on the probe (the node.exe
// dir itself is the npm global bin root on Windows, where copilot lives).
const NO_CLI_PATH = mkdtempSync(join(tmpdir(), "aps-nopath-"));

function run(
  args: string[],
  cwd: string,
  home: string,
  envExtra: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    // homedir() reads USERPROFILE on win32, HOME elsewhere — set both so the
    // fake home is hermetic on every platform.
    env: { ...process.env, USERPROFILE: home, HOME: home, ...envExtra },
  });
}

/** Run with a PATH that hides real-machine CLIs (copilot, codex, code). */
function runNoCli(args: string[], cwd: string, home: string) {
  return run(args, cwd, home, { PATH: NO_CLI_PATH });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aps-plugin-"));
}

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
const count = (s: string | null, needle: string): number =>
  s === null ? 0 : s.split(needle).length - 1;

const pluginDir = (home: string): string => join(home, manifest.markers.configDir, "plugin");
const cursorDir = (home: string): string =>
  join(home, ".cursor", "plugins", "local", manifest.markers.cursorDir);
const shimRoot = (home: string): string => join(home, manifest.markers.configDir, "marketplace");

test("materialize: shared plugin dir holds exactly the 6 spec entries; cursor copy + marker", { skip: !has("cursor") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  mkdirSync(join(home, ".cursor"), { recursive: true });

  const inst = run(["install", "--non-interactive", "--target", "cursor"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);

  // Materialized dir: exactly plugin.json, mcp.json, .mcp.json, skills/,
  // openclaw.plugin.json, openclaw-dist/ — no client shims (those live
  // OUTSIDE, e.g. the codex marketplace).
  assert.deepEqual(
    readdirSync(pluginDir(home)).sort(),
    [".mcp.json", "mcp.json", "openclaw-dist", "openclaw.plugin.json", "plugin.json", "skills"],
    "materialized dir must hold exactly the 6 spec entries",
  );

  // Cursor local copy + marker file with the marker content.
  const markerPath = join(cursorDir(home), manifest.markers.cursorMarkerFile);
  assert.ok(existsSync(join(cursorDir(home), "plugin.json")), "plugin copied to .cursor/plugins/local/");
  assert.equal(read(markerPath), `${manifest.markers.cursorMarker}\n`, "marker file content");

  const un = run(["uninstall", "--non-interactive", "--target", "cursor"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!existsSync(cursorDir(home)), "cursor copy removed on uninstall");
  assert.ok(existsSync(pluginDir(home)), "materialized dir kept after uninstall");
});

test("cursor: uninstall without our marker is skipped, user copy kept", { skip: !has("cursor") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  mkdirSync(join(home, ".cursor"), { recursive: true });
  run(["install", "--non-interactive", "--target", "cursor"], dir, home);
  assert.ok(existsSync(cursorDir(home)), "installed");

  // Simulate a user-authored copy: drop the marker, add a user file.
  rmSync(join(cursorDir(home), manifest.markers.cursorMarkerFile), { force: true });
  const userFile = join(cursorDir(home), "notes.txt");
  writeFileSync(userFile, "user notes");

  const un = run(["uninstall", "--non-interactive", "--target", "cursor"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(un.stdout.includes("skipped"), "marker-less uninstall reported skipped");
  assert.ok(existsSync(cursorDir(home)), "user-authored copy kept");
  assert.ok(existsSync(userFile), "user file untouched");
});

test("copilot: enabledPlugins fallback when the CLI is absent; idempotent; removable", { skip: !has("copilot") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  const settings = join(home, ".copilot", "settings.json");
  const repo = manifest.githubSlug ? `https://github.com/${manifest.githubSlug}` : manifest.name;

  const inst = runNoCli(["install", "--non-interactive", "--target", "copilot"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(existsSync(settings), "settings.json written by the CLI-less fallback");
  const json = JSON.parse(read(settings)!);
  assert.deepEqual(json.enabledPlugins, [repo], "enabledPlugins written with the repo");

  // Idempotent re-install: still exactly one entry.
  const again = runNoCli(["install", "--non-interactive", "--target", "copilot"], dir, home);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(count(read(settings)!, repo), 1, "re-install must not duplicate the entry");

  const un = runNoCli(["uninstall", "--non-interactive", "--target", "copilot"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!read(settings)!.includes(repo), "entry removed");
});

test("vscode: chat.pluginLocations entry keyed by the materialized dir; uninstall removes it", { skip: !has("vscode") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  const base = process.platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  const userDir = join(base, "Code", "User");
  mkdirSync(userDir, { recursive: true });
  const settingsFile = join(userDir, "settings.json");
  const m = manifest;

  // Pre-existing user settings survive; our entry is added next to them.
  writeFileSync(settingsFile, JSON.stringify({ "editor.fontSize": 14 }, null, 2));

  const inst = run(["install", "--non-interactive", "--target", "vscode"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const after = JSON.parse(read(settingsFile)!);
  assert.equal(after["editor.fontSize"], 14, "user settings untouched");
  const locations = after.chat.pluginLocations as Record<string, unknown>;
  const key = Object.keys(locations).find((k) => k.includes(m.markers.configDir));
  assert.ok(key, `pluginLocations keyed by the materialized dir (${m.markers.configDir})`);
  assert.equal(locations[key], true);

  const un = run(["uninstall", "--non-interactive", "--target", "vscode"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  const clean = JSON.parse(read(settingsFile)!);
  assert.equal(clean["editor.fontSize"], 14, "user settings untouched after uninstall");
  assert.ok(
    !JSON.stringify(clean).includes(m.markers.configDir),
    "configDir-keyed entry removed (and empty chat containers dropped)",
  );
});

test("chatgpt-codex: marketplace shim written outside the plugin dir; manual when no codex CLI", { skip: !has("chatgpt-codex") }, () => {
  const dir = tmpDir();
  const home = tmpDir();

  const inst = runNoCli(["install", "--non-interactive", "--target", "chatgpt-codex"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(inst.stdout.includes("codex CLI not found"), "manual branch taken");

  const manifestPath = join(shimRoot(home), ".agents", "plugins", "marketplace.json");
  assert.ok(existsSync(manifestPath), "marketplace.json shim written");
  assert.ok(existsSync(join(shimRoot(home), "plugin", "plugin.json")), "plugin copy in the shim");
  assert.ok(!existsSync(join(pluginDir(home), ".agents")), "shim lives OUTSIDE the materialized dir");
  assert.equal(
    readdirSync(pluginDir(home)).sort().join(","),
    ".mcp.json,mcp.json,openclaw-dist,openclaw.plugin.json,plugin.json,skills",
    "materialized dir keeps exactly its 6 entries",
  );

  const un = runNoCli(["uninstall", "--non-interactive", "--target", "chatgpt-codex"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(existsSync(manifestPath), "marketplace shim kept on uninstall (harmless registration)");
});
