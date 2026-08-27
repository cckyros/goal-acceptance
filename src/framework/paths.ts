import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "./manifest.ts";

// Package-relative path resolution.
// - In the built ESM CLI (dist/cli.js) import.meta.url points at dist/,
//   so the package root is one level up (dist/ and assets/ are siblings
//   both in the repo and inside the installed npm package).
// - In the standalone CJS hook bundle (dist/hook.cjs) esbuild shims
//   import.meta.url to __filename; the resolved paths then point at the
//   project's .claude/hooks/… which is wrong, but every read that uses
//   these helpers is try/catch'd and falls back to built-in constants,
//   so the hook never depends on the package being on disk.
export function packageRoot(): string {
  const metaUrl: unknown = (import.meta as { url?: string }).url;
  if (typeof metaUrl === "string" && metaUrl) {
    return join(dirname(fileURLToPath(metaUrl)), "..");
  }
  return "";
}

export function assetsDir(): string {
  return join(packageRoot(), "assets");
}

/** Path of a template file shipped in assets/. */
export function templatePath(name: string): string {
  return join(assetsDir(), name);
}

/** Built hook bundle that the installer copies into projects. */
export function packagedHookPath(): string {
  return join(packageRoot(), "dist", "hook.cjs");
}

/** Packaged Agent Plugins skill copy (skills/<skillDir>/SKILL.md,
 *  build-synced from assets/SKILL.md and committed for git installs). */
export function packagedSkillPath(manifest: PluginManifest): string {
  return join(packageRoot(), "skills", manifest.markers.skillDir, "SKILL.md");
}

/** Agent Plugins portable package dir materialized under the global config
 *  dir (~/.<configDir>/plugin/). */
export function pluginDir(manifest: PluginManifest, home?: string): string {
  const base = home ?? homedir();
  return join(base, manifest.markers.configDir, "plugin");
}
