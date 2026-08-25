// Skill-target adapter integration tests (spawn the built CLI in scratch
// projects). Guards the phase-C wiring:
//  - trae: own .trae/skills/<skillDir>/ copy, removed on uninstall, shared
//    tree untouched
//  - pi: ~/.pi/agent/mcp.json written ONLY when the pi-mcp-adapter dir is
//    present; entry removed on uninstall, shared tree kept
//  - omp/dsh: install/uninstall succeed with no own artifacts; shared tree
//    kept (codex owns it)
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

function run(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    // homedir() reads USERPROFILE on win32, HOME elsewhere — set both so the
    // fake home is hermetic on every platform.
    env: { ...process.env, USERPROFILE: home, HOME: home },
  });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "aps-skill-"));
}

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
const count = (s: string | null, needle: string): number =>
  s === null ? 0 : s.split(needle).length - 1;

test("trae: own skill copy installs, uninstalls, and never touches the shared tree", { skip: !has("trae") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  const ownSkill = join(dir, ".trae", "skills", manifest.markers.skillDir, "SKILL.md");
  const sharedSkill = join(dir, ".agents", "skills", manifest.markers.skillDir, "SKILL.md");

  const inst = run(["install", "--non-interactive", "--target", "trae"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(existsSync(ownSkill), "skill copied to .trae/skills/");
  assert.ok(!existsSync(sharedSkill), "trae does not write the shared tree");

  const un = run(["uninstall", "--non-interactive", "--target", "trae"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(!existsSync(ownSkill), "own skill copy removed");
});

test("pi: mcp.json written only when the pi-mcp-adapter dir exists; entry removable", { skip: !has("pi") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  const mcpFile = join(home, ".pi", "agent", "mcp.json");
  const sharedSkill = join(dir, ".agents", "skills", manifest.markers.skillDir, "SKILL.md");

  // No adapter: shared skill written, mcp.json untouched, manual guidance
  const plain = run(["install", "--non-interactive", "--target", "pi"], dir, home);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.ok(existsSync(sharedSkill), "shared skill written regardless");
  assert.ok(!existsSync(mcpFile), "no pi-mcp-adapter → mcp.json not written");

  // Adapter present (npm/ extensions dir): mcp.json gets our mcpServers entry
  mkdirSync(join(home, ".pi", "agent", "npm"), { recursive: true });
  const withAdapter = run(["install", "--non-interactive", "--target", "pi"], dir, home);
  assert.equal(withAdapter.status, 0, withAdapter.stdout + withAdapter.stderr);
  assert.ok(existsSync(mcpFile), "adapter detected → mcp.json written");
  assert.equal(count(read(mcpFile)!, `"${manifest.name}": {`), 1, "entry keyed by the manifest name");

  // Idempotent re-install: no duplicate entry
  const again = run(["install", "--non-interactive", "--target", "pi"], dir, home);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(count(read(mcpFile)!, `"${manifest.name}": {`), 1, "re-install must not duplicate the entry");

  const un = run(["uninstall", "--non-interactive", "--target", "pi"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  const json = read(mcpFile)!;
  assert.ok(!json.includes(manifest.name), "entry removed");
  assert.ok(existsSync(sharedSkill), "shared tree kept on pi uninstall");
});

test("omp + dsh: no own artifacts; shared tree written and kept", { skip: !has("omp") || !has("dsh") }, () => {
  const dir = tmpDir();
  const home = tmpDir();
  const sharedSkill = join(dir, ".agents", "skills", manifest.markers.skillDir, "SKILL.md");

  const inst = run(["install", "--non-interactive", "--target", "omp,dsh"], dir, home);
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.ok(existsSync(sharedSkill), "shared skill written");

  const un = run(["uninstall", "--non-interactive", "--target", "omp,dsh"], dir, home);
  assert.equal(un.status, 0, un.stdout + un.stderr);
  assert.ok(existsSync(sharedSkill), "shared tree kept (codex owns it)");
});
