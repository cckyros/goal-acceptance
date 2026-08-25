// Native-target adapter integration tests (spawn the built CLI in scratch
// projects). Guards the two wiring regressions found in phase B:
//  - hook entries must carry the marker-named filename so install is
//    idempotent and uninstall removes OUR entries (never duplicated, never
//    missed)
//  - the codex config.toml section + AGENTS.md block must round-trip exactly
//    once (idempotent upsert, full removal)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/plugin/manifest.ts";
import { adapters } from "../src/plugin/targets/index.ts";

// Target tests self-skip when the scaffold pruned that target out.
const has = (id: string): boolean => adapters.some((a) => a.id === id);

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aps-native-"));
}

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
const count = (s: string | null, needle: string): number =>
  s === null ? 0 : s.split(needle).length - 1;

test("claude: hook file is marker-named; install idempotent; uninstall leaves no marker artifacts", { skip: !has("claude") }, () => {
  const dir = tmpDir();
  const hookFile = join(dir, ".claude", "hooks", `${manifest.markers.hookCommand}.cjs`);
  const settingsFile = join(dir, ".claude", "settings.json");

  const first = run(["install", "--non-interactive", "--target", "claude"], dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(existsSync(hookFile), "hook bundle installed under the marker-named file");
  const settings = read(settingsFile)!;
  assert.equal(count(settings, manifest.markers.hookCommand), 2, "PreToolUse + SessionStart entries reference the marker");

  // idempotent re-install: no duplicated entries, no second backup
  const second = run(["install", "--non-interactive", "--target", "claude"], dir);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(count(read(settingsFile)!, manifest.markers.hookCommand), 2, "re-install must not duplicate hook entries");

  const un = run(["uninstall", "--non-interactive", "--target", "claude"], dir);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!existsSync(hookFile), "hook bundle removed");
  assert.ok(!read(settingsFile)!.includes(manifest.markers.hookCommand), "our hook entries removed from settings.json");
  const gi = read(join(dir, ".gitignore"));
  assert.ok(gi === null || !gi.includes(manifest.markers.configDir), ".gitignore line removed");
});

test("codex: config.toml section + AGENTS.md block upsert idempotently and remove cleanly", { skip: !has("codex") }, () => {
  const dir = tmpDir();
  const toml = join(dir, ".codex", "config.toml");
  const agents = join(dir, ".codex", "AGENTS.md");

  const first = run(["install", "--non-interactive", "--target", "codex"], dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(count(read(toml)!, `[mcp_servers.${manifest.name}]`), 1);
  assert.equal(count(read(toml)!, `${manifest.name}@${manifest.version}`), 1, "version-pinned npx args");
  assert.equal(count(read(agents)!, manifest.markers.agentsStart), 1);

  const second = run(["install", "--non-interactive", "--target", "codex"], dir);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(count(read(toml)!, `[mcp_servers.${manifest.name}]`), 1, "re-install must not duplicate the section");
  assert.equal(count(read(agents)!, manifest.markers.agentsStart), 1, "re-install must not duplicate the block");

  const un = run(["uninstall", "--non-interactive", "--target", "codex"], dir);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!read(toml)!.includes(manifest.name), "section removed from config.toml");
  assert.ok(!read(agents)!.includes(manifest.markers.agentsStart), "block removed from AGENTS.md");
  assert.ok(!existsSync(join(dir, ".agents", "skills", manifest.markers.skillDir, "SKILL.md")), "codex owns the shared tree — removed");
});

test("qwen: mcpServers + PreToolUse hook in settings.json are idempotent and removable", { skip: !has("qwen") }, () => {
  const dir = tmpDir();
  const settingsFile = join(dir, ".qwen", "settings.json");

  const first = run(["install", "--non-interactive", "--target", "qwen"], dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const settings = read(settingsFile)!;
  assert.equal(count(settings, `"mcpServers"`), 1);
  assert.equal(count(settings, manifest.markers.hookCommand), 1, "exactly one PreToolUse entry");

  const second = run(["install", "--non-interactive", "--target", "qwen"], dir);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(count(read(settingsFile)!, manifest.markers.hookCommand), 1, "re-install must not duplicate the hook entry");

  const un = run(["uninstall", "--non-interactive", "--target", "qwen"], dir);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!read(settingsFile)!.includes(manifest.name), "mcpServers + hook entries removed");
  assert.ok(
    !existsSync(join(dir, ".qwen", "hooks", `${manifest.markers.hookCommand}.cjs`)),
    "hook bundle removed",
  );
});

test("opencode + devin: json config entries round-trip (mcp array form / mcpServers)", { skip: !has("opencode") || !has("devin") }, () => {
  const dir = tmpDir();
  const first = run(["install", "--non-interactive", "--target", "opencode,devin"], dir);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const opencode = read(join(dir, "opencode.json"))!;
  assert.equal(count(opencode, '"type": "local"'), 1);
  assert.equal(count(opencode, `"${manifest.name}": {`), 1, "mcp entry keyed by the manifest name");
  const devin = read(join(dir, ".devin", "mcp_config.json"))!;
  assert.equal(count(devin, `"mcpServers"`), 1);

  const un = run(["uninstall", "--non-interactive", "--target", "opencode,devin"], dir);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!read(join(dir, "opencode.json"))!.includes(manifest.name), "opencode entry removed");
  assert.ok(!read(join(dir, ".devin", "mcp_config.json"))!.includes(manifest.name), "devin entry removed");
});
