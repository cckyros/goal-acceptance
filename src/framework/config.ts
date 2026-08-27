// Declarative config system: the manifest declares fields, the framework
// handles file layout, env override, precedence, and masking. Precedence:
//   env > project <configDir>/config.json > global ~/<configDir>/config.json
//   > built-in defaults (from the field definition)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigField, PluginManifest } from "./manifest.ts";

export interface ResolvedConfig {
  values: Record<string, string | number | boolean | undefined>;
  /** Where each value came from: "env" | "project" | "global" | "default" | undefined. */
  sources: Record<string, string>;
  /** Which config file was read (the one that supplies project/global values). */
  file: string | null;
}

export function projectConfigDir(manifest: PluginManifest, cwd: string): string {
  return join(cwd, manifest.markers.configDir);
}

export function projectConfigPath(manifest: PluginManifest, cwd: string): string {
  return join(projectConfigDir(manifest, cwd), "config.json");
}

export function globalConfigDir(manifest: PluginManifest, home: string = homedir()): string {
  return join(home, manifest.markers.configDir);
}

export function globalConfigPath(manifest: PluginManifest, home: string = homedir()): string {
  return join(globalConfigDir(manifest, home), "config.json");
}

function readJsonFile(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function envOf(field: ConfigField): string | undefined {
  const v = process.env[field.env];
  if (v === undefined || v === "") return undefined;
  return v;
}

function coerce(field: ConfigField, raw: string): string | number | boolean {
  switch (field.type) {
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true" || raw === "1";
    case "json":
    case "string":
    default:
      return raw;
  }
}

/** Resolve config for a cwd: env > project file > global file > defaults.
 *  `home` is injectable for tests; defaults to the real home dir. */
export function resolveConfig(
  manifest: PluginManifest,
  cwd: string,
  home?: string,
): ResolvedConfig {
  const project = readJsonFile(projectConfigPath(manifest, cwd));
  const global = readJsonFile(globalConfigPath(manifest, home));

  const values: Record<string, string | number | boolean | undefined> = {};
  const sources: Record<string, string> = {};
  let file: string | null = null;

  for (const field of manifest.config) {
    if (field.default !== undefined) {
      values[field.key] = field.default;
      sources[field.key] = "default";
    }
  }
  if (global) {
    file = globalConfigPath(manifest, home);
    for (const field of manifest.config) {
      const v = global[field.key];
      if (v !== undefined) {
        values[field.key] = v as string | number | boolean;
        sources[field.key] = "global";
      }
    }
  }
  if (project) {
    file = projectConfigPath(manifest, cwd);
    for (const field of manifest.config) {
      const v = project[field.key];
      if (v !== undefined) {
        values[field.key] = v as string | number | boolean;
        sources[field.key] = "project";
      }
    }
  }
  for (const field of manifest.config) {
    const raw = envOf(field);
    if (raw !== undefined) {
      values[field.key] = coerce(field, raw);
      sources[field.key] = "env";
    }
  }
  return { values, sources, file };
}

export function configPaths(manifest: PluginManifest, cwd: string): string[] {
  return [projectConfigPath(manifest, cwd), globalConfigPath(manifest)];
}

/** Read the project config file's raw values (what `config get` shows). */
export function readConfigFile(manifest: PluginManifest, cwd: string): Record<string, unknown> {
  return readJsonFile(projectConfigPath(manifest, cwd)) ?? {};
}

/** Read raw values from any config.json path (used by `config set --global`). */
export function readConfigValuesAt(p: string): Record<string, unknown> {
  return readJsonFile(p) ?? {};
}

/** Write the project config file (creates dir). Returns the file path. */
export function writeConfigFile(
  manifest: PluginManifest,
  cwd: string,
  values: Record<string, unknown>,
): string {
  const p = projectConfigPath(manifest, cwd);
  const dir = join(p, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(values, null, 2) + "\n", "utf8");
  return p;
}

/** Mask secret values for display: keep first 3 + last 2 chars. */
export function maskValue(v: string): string {
  if (v.length <= 8) return "***";
  return `${v.slice(0, 3)}${"*".repeat(6)}${v.slice(-2)}`;
}

/** Human-readable byte count, e.g. 1536 -> "1.5 KB". */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

