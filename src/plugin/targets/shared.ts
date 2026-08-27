// Shared helpers for target adapters. Ported from deepseek-vl-support
// (install.ts / cliagents.ts / skillagents.ts / codex.ts) with every
// vision-specific string parameterized by the manifest:
//  - npx MCP entry builders (stdio + local-array variants)
//  - JSON config read with a manual guard (never clobber unparseable files)
//  - key-level entry upsert/remove ("mcp"/"mcpServers" containers)
//  - skill-tree writes (SKILL.md + references/, marker-checked) and the
//    shared .agents/skills/ convention
//  - empty-dir-tree cleanup (user-authored leftovers keep the tree)
//  - CLI detection via the framework's PATHEXT-consistent shim probe
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginManifest } from "../../framework/manifest.ts";
import type { DetectStatus, InstallContext } from "../../framework/registry.ts";
import { which } from "../../framework/registry.ts";
import { backupFile, fillTemplate, readTextFile } from "../../framework/safe-fs.ts";
import { packagedHookPath, packagedSkillPath, templatePath } from "../../framework/paths.ts";

/** {{placeholder}} variables for asset templates (same set as build.mjs). */
export function manifestVars(m: PluginManifest): Record<string, string> {
  return {
    name: m.name,
    brand: m.brand,
    version: m.version,
    description: m.description,
    skillDir: m.markers.skillDir,
    commandFile: m.markers.commandFile,
    hook: m.markers.hook,
    configDir: m.markers.configDir,
  };
}

/** Read an asset template (assets/<name>, build-synced from src/assets) and
 *  fill its {{placeholders}}; null when the asset is missing. */
export function fillAsset(m: PluginManifest, name: string): string | null {
  const body = readTextFile(templatePath(name));
  if (body === null) return null;
  return fillTemplate(body, manifestVars(m));
}

// ---------------------------------------------------------------- npx entries

/** Installed hook bundle filename. Carries the hookCommand marker (e.g.
 *  `my-agent-plugin-hook.cjs`) so the settings.json command string
 *  (`node .claude/hooks/<file>`) identifies OUR entries — the same
 *  convention as deepseek-vl-support's `deepseek-vision-hook.cjs`. */
export function hookFileName(manifest: PluginManifest): string {
  return `${manifest.markers.hookCommand}.cjs`;
}

/** `npx -y <package> mcp` args (no version pin — installs are idempotent;
 *  only Codex pins the version, see native-codex.ts). */
export function npxArgs(manifest: PluginManifest): string[] {
  return ["-y", manifest.name, "mcp"];
}

/** Claude-schema mcpServers entry. */
export function mcpEntry(manifest: PluginManifest): Record<string, unknown> {
  return { command: "npx", args: npxArgs(manifest) };
}

/** opencode/kilo-schema mcp entry (command as an ARRAY). */
export function localMcpEntry(manifest: PluginManifest): Record<string, unknown> {
  return { type: "local", command: ["npx", ...npxArgs(manifest)], enabled: true };
}

/** workbuddy-schema entry (stdio + npx fields). */
export function stdioMcpEntry(manifest: PluginManifest): Record<string, unknown> {
  return { type: "stdio", ...mcpEntry(manifest) };
}

// ---------------------------------------------------------------- json config

export type JsonConfig =
  | { data: Record<string, unknown> }
  | { missing: true }
  | { manual: string };

/** Read a JSON config file as an object. Returns { data } on success,
 *  { missing } when absent, or a { manual } reason when it exists but cannot
 *  be modified safely (not valid JSON / not an object). */
export function readJsonConfig(file: string): JsonConfig {
  const raw = readTextFile(file);
  if (raw === null) return { missing: true };
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { manual: `${file} is not a JSON object — left untouched` };
    }
    return { data };
  } catch {
    return {
      manual: `${file} is not valid JSON (JSONC comments are allowed by some tools) — left untouched`,
    };
  }
}

/** Merge an entry into data[key][serverName]. "invalid" when data[key] exists
 *  with a non-object type (a user-authored schema violation we never
 *  clobber); "present" when our entry already exists. */
export function jsonEntryAdded(
  data: Record<string, unknown>,
  key: string,
  serverName: string,
  entry: Record<string, unknown>,
): "added" | "present" | "invalid" {
  const existing = data[key];
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    return "invalid";
  }
  const map = (existing as Record<string, unknown> | undefined) ?? {};
  if (map[serverName] !== undefined) return "present";
  map[serverName] = entry;
  data[key] = map;
  return "added";
}

/** Remove our entry from data[key][serverName] (and the empty `key`
 *  container once nothing is left). Returns how many entries were removed. */
export function jsonEntryRemoved(data: Record<string, unknown>, key: string, serverName: string): number {
  const existing = data[key];
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return 0;
  const map = existing as Record<string, unknown>;
  if (!(serverName in map)) return 0;
  delete map[serverName];
  if (Object.keys(map).length === 0) delete data[key];
  return 1;
}

/** Persist a mutated JSON config back (backup first). Returns the outcome
 *  string for the report (dry-run aware). */
export function writeJsonConfig(
  file: string,
  data: Record<string, unknown>,
  dryRun: boolean,
  dryMessage: string,
  writeMessage: string,
): string {
  if (dryRun) return `[dry-run] ${dryMessage}`;
  const backup = backupFile(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  return writeMessage + (backup ? ` (backup: ${backup})` : "");
}

export type JsonMergeOutcome = { report: string } | { manual: string };

/** Deep-merge `entry` into file[key][serverName] with the standard
 *  read → guard → write sequence. `verb` names the entry for messages
 *  (e.g. `mcpServers["<name>"]`). Returns {report} on success, or {manual}
 *  when the file must not be modified (unparseable / wrong shape). */
export function mergeJsonEntry(
  file: string,
  key: string,
  serverName: string,
  entry: Record<string, unknown>,
  dryRun: boolean,
  verb: string,
): JsonMergeOutcome {
  const loaded = readJsonConfig(file);
  if ("manual" in loaded) return { manual: loaded.manual };
  if ("missing" in loaded) {
    const data = { [key]: { [serverName]: entry } };
    return {
      report: writeJsonConfig(file, data, dryRun, `would create ${file} with ${verb}`, `wrote ${verb} to ${file}`),
    };
  }
  const state = jsonEntryAdded(loaded.data, key, serverName, entry);
  if (state === "invalid") {
    return { manual: `"${key}" is not a JSON object in ${file} — left untouched` };
  }
  if (state === "present") {
    return { report: `${verb} already present in ${file} — idempotent, no change` };
  }
  return {
    report: writeJsonConfig(file, loaded.data, dryRun, `would add ${verb} to ${file}`, `added ${verb} to ${file}`),
  };
}

/** Remove file[key][serverName] if present (read → guard → write); appends
 *  the report to `notes`. Never touches unknown entries. */
export function dropJsonEntry(
  file: string,
  key: string,
  serverName: string,
  dryRun: boolean,
  notes: string[],
): void {
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    notes.push(`no ${file} — nothing to clean`);
    return;
  }
  if ("manual" in loaded) {
    notes.push(loaded.manual);
    return;
  }
  const removed = jsonEntryRemoved(loaded.data, key, serverName);
  if (removed === 0) {
    notes.push(`no ${key}["${serverName}"] entry in ${file}`);
    return;
  }
  notes.push(
    writeJsonConfig(file, loaded.data, dryRun, `would remove ${key}["${serverName}"] from ${file}`, `removed ${key}["${serverName}"] from ${file}`),
  );
}

// ---------------------------------------------------------------- skill trees

/** Write the packaged skill tree (SKILL.md, marker-checked via
 *  ctx.writeManaged) into `destDir` (absolute or project-relative). Returns
 *  false when the packaged SKILL.md source is missing. */
export function writeSkillTree(ctx: InstallContext, destDir: string, warnings: string[]): boolean {
  const m = ctx.manifest;
  const skill = readTextFile(packagedSkillPath(m));
  if (skill === null) {
    warnings.push(`missing ${packagedSkillPath(m)} — run \`npm run build\` first (skipping skill write)`);
    return false;
  }
  ctx.writeManaged(join(destDir, "SKILL.md"), skill, m.markers.skill);
  return true;
}

/** Shared <project>/.agents/skills/<skillDir>/ write — the same location and
 *  contract as the Codex project-scope install, used by opencode/pi/omp/dsh
 *  and the CLI agents too (global scope skips it: it is a project-level
 *  convention). */
export function writeSharedAgentsSkill(ctx: InstallContext, warnings: string[]): void {
  if (ctx.scope === "global") {
    ctx.log(`skipped .agents/skills/${ctx.manifest.markers.skillDir}/ write — project-level convention (global scope)`);
    return;
  }
  writeSkillTree(ctx, join(".agents", "skills", ctx.manifest.markers.skillDir), warnings);
}

/** Remove one managed file; user-authored content (no marker) is kept and
 *  reported. Returns how many files were removed (0 or 1). */
export function removeManagedFile(ctx: InstallContext, target: string, marker: string, notes: string[]): number {
  if (!existsSync(target)) return 0;
  const content = readTextFile(target) ?? "";
  if (!content.includes(marker)) {
    notes.push(`${target} exists without our marker (user-authored) — kept`);
    return 0;
  }
  if (ctx.dryRun) {
    notes.push(`[dry-run] would delete ${target}`);
  } else {
    rmSync(target, { force: true });
    notes.push(`deleted ${target}`);
  }
  return 1;
}

/** Remove the managed files of a skill tree and then the empty dirs that
 *  remain (deepest first; any user-authored leftover keeps the tree). */
export function removeSkillTree(ctx: InstallContext, dir: string, notes: string[]): void {
  let removed = 0;
  removed += removeManagedFile(ctx, join(dir, "SKILL.md"), ctx.manifest.markers.skill, notes);
  if (removed > 0 && !ctx.dryRun && existsSync(dir)) {
    notes.push(...removeEmptyDirTree(dir));
  }
}

/** Remove `dir` and every subdirectory, but only when they contain no files
 *  (deepest first). Returns the list of removed paths; a single user-authored
 *  leftover file anywhere in the tree keeps the whole tree. */
export function removeEmptyDirTree(dir: string): string[] {
  const removed: string[] = [];
  const visit = (d: string): boolean => {
    let allEmpty = true;
    for (const name of readdirSyncSafe(d)) {
      const p = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        return false;
      }
      if (isDir) {
        if (!visit(p)) allEmpty = false;
      } else {
        allEmpty = false;
      }
    }
    if (allEmpty) {
      try {
        rmSync(d, { recursive: true, force: true });
        removed.push(d);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  };
  visit(dir);
  return removed;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- hook bundle

/** Read the packaged hook bundle (dist/hook.cjs); null when missing (callers
 *  then skip the settings hook entries and warn). */
export function packagedHook(): string | null {
  return readTextFile(packagedHookPath());
}

// ---------------------------------------------------------------- detection

/** Uninstall ownership: the shared .agents/skills tree is kept — only
 *  `uninstall --target codex` removes it (other agents may use it). */
export function sharedKeepNote(manifest: PluginManifest): string {
  return (
    `shared .agents/skills/${manifest.markers.skillDir}/ kept (may be used by other agents) — ` +
    `remove with \`uninstall --target codex\` or delete the directory.`
  );
}

/** Project .mcp.json is shared by Reasonix/WorkBuddy (and Copilot reads the
 *  same file) — any of them uninstalling removes the entry. */
export const mcpJsonSharedNote =
  `project .mcp.json is shared (Reasonix/Copilot/CodeBuddy read it) — our entry ` +
  `was removed; other agents lose it until reinstalled.`;

/** CLI-first detector with config-dir fallbacks (first existing dir wins).
 *  Returns true when found, "manual" when nothing matched (the wizard flags
 *  the agent with a hint). */
export function cliOrDirDetector(
  bins: string[],
  dirsOf: (home: string) => string[],
): (ctx: InstallContext) => DetectStatus {
  return (ctx: InstallContext) => {
    for (const bin of bins) {
      if (which(bin)) return true;
    }
    for (const dir of dirsOf(ctx.home)) {
      if (existsSync(dir)) return true;
    }
    return "manual";
  };
}

/** Platform home dirs. Reasonix stores its user config at %APPDATA%\reasonix
 *  on Windows and ~/.reasonix elsewhere; Devin at %APPDATA%\devin on Windows
 *  and ~/.config/devin elsewhere. OpenCode at %APPDATA%\opencode on Windows
 *  and ~/.config/opencode elsewhere. */
export function reasonixHome(home: string): string {
  return process.platform === "win32" ? join(home, "AppData", "Roaming", "reasonix") : join(home, ".reasonix");
}

export function devinHome(home: string): string {
  return process.platform === "win32" ? join(home, "AppData", "Roaming", "devin") : join(home, ".config", "devin");
}

export function opencodeConfigDir(home: string): string {
  return process.platform === "win32" ? join(home, "AppData", "Roaming", "opencode") : join(home, ".config", "opencode");
}
