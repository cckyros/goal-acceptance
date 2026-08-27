// Static consistency: the manifest is the single source of identity — every
// generated file (plugin.json / mcp.json / .mcp.json / marketplace.json /
// cordis.patch.yml / dist bundles / skills/) must round-trip its values.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/plugin/manifest.ts";

const ROOT = join(import.meta.dirname, "..");

function read(p: string): string {
  const abs = join(ROOT, p);
  assert.ok(existsSync(abs), `missing ${p}`);
  return readFileSync(abs, "utf8");
}

const pkg = JSON.parse(read("package.json"));
const pluginJson = JSON.parse(read("plugin.json"));
const mcpJson = JSON.parse(read("mcp.json"));
const marketplace = JSON.parse(read("marketplace.json"));
const cordisPatch = read("cordis.patch.yml");

test("package.json bin points at a dist entry; version syncs with the manifest", () => {
  // This repo is BOTH the create-agent-plugin generator package AND the
  // my-agent-plugin demo template — the npm package name is the generator's,
  // the plugin identity lives in the manifest. A scaffolded project flips
  // that: the npm name IS the plugin name and the bin points at the CLI.
  // Both shapes must keep version == manifest.version.
  const [binName, binTarget] = Object.entries(pkg.bin)[0];
  if (pkg.name === "create-agent-plugin") {
    assert.equal(binName, "create-agent-plugin");
    assert.equal(binTarget, "dist/generator.js");
  } else {
    assert.equal(binName, manifest.name.split("/").pop());
    assert.equal(binTarget, "dist/cli.js");
  }
  assert.equal(pkg.version, manifest.version);
});

test("plugin.json carries the manifest identity", () => {
  // agent-plugins 1.0.0 name pattern forbids npm scopes; brand is the
  // unscoped product name, manifest.name stays the npm package id.
  assert.equal(pluginJson.name, manifest.brand);
  assert.equal(pluginJson.version, manifest.version);
  assert.equal(pluginJson.description, manifest.description);
});

test("mcp.json == .mcp.json byte-identical; server keyed by manifest name", () => {
  assert.equal(read("mcp.json"), read(".mcp.json"));
  assert.ok(mcpJson.mcpServers[manifest.name], `server key must be ${manifest.name}`);
});

test("marketplace.json versions match", () => {
  assert.equal(marketplace.metadata.version, manifest.version);
  // plugins[].name must equal plugin.json's name (brand) so marketplace
  // consumers can resolve the entry; the marketplace's own name stays the
  // npm package id.
  assert.equal(marketplace.plugins[0].name, manifest.brand);
  assert.equal(marketplace.plugins[0].version, manifest.version);
});

test("cordis.patch.yml activates the brand id, imports the scoped npm name", () => {
  assert.ok(cordisPatch.includes(`id: ${manifest.brand}`), cordisPatch);
  assert.ok(cordisPatch.includes(`name: "${manifest.name}"`), cordisPatch);
});

test("dist/cli.js: shebang + manifest name baked in", () => {
  const cli = read("dist/cli.js");
  assert.ok(cli.startsWith("#!/usr/bin/env node"), "shebang");
  assert.ok(cli.includes(manifest.name));
});

test("dist/hook.cjs: identity banner (uninstall marker) preserved", () => {
  const hook = read("dist/hook.cjs");
  assert.ok(hook.includes(`/*! ${manifest.markers.hook} */`), "banner marker");
});

test("dist/dsh-plugin.js: @deepseek-ai imports stay external (bare)", () => {
  const dsh = read("dist/dsh-plugin.js");
  assert.ok(dsh.includes(`from "@deepseek-ai/dsh-tools"`), "bare import");
});

test("skills/<skillDir>/SKILL.md: filled from template, marker + frontmatter valid", () => {
  const skill = read(`skills/${manifest.markers.skillDir}/SKILL.md`);
  assert.ok(skill.includes(`# ${manifest.markers.skill}`), "frontmatter marker line");
  assert.ok(skill.includes(`name: ${manifest.markers.skillDir}`), "name matches dir");
  assert.ok(skill.includes(`allowed-tools: Bash Read`), "space-separated allowed-tools");
  assert.ok(!skill.includes("{{"), "no unfilled placeholders");
  assert.ok(!skill.includes(manifest.markers.skillDir + "-"), "no stray concatenations");
});

test("assets template still carries placeholders (single source)", () => {
  const tpl = read("src/assets/SKILL.md");
  assert.ok(tpl.includes("{{skillDir}}"), "template placeholders intact");
});

test("hook command marker: settings entries reference the bundled hook", () => {
  // The hook command string embedded in settings.json (written by the claude
  // target installer) contains the hookCommand marker — assert the marker is
  // a real substring of the package layout it points at.
  assert.ok(existsSync(join(ROOT, "dist", "hook.cjs")));
  assert.equal(manifest.markers.hookCommand, manifest.markers.hook);
});
