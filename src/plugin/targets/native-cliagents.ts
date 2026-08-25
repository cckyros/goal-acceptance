// Five native CLI-agent adapters (qwen / reasonix / kilo / workbuddy / devin)
// that read Agent Skills / MCP configs natively but do NOT implement the
// Agent Plugins open standard. Ported from deepseek-vl-support cliagents.ts:
//   - qwen       : skill copy in .qwen/skills/ (it does not read
//                  .agents/skills/); mcpServers + PreToolUse hook written to
//                  .qwen/settings.json (JSONC → manual) with hook.cjs copied
//                  to .qwen/hooks/
//   - reasonix   : shared .agents/skills/ skill (project) / ~/.agents/skills/
//                  (global); project .mcp.json entry; global MCP via a
//                  managed [[plugins]] block in config.toml; PreToolUse hook
//                  in settings.json (project .reasonix/ or the Reasonix home)
//   - kilo       : shared .agents/skills/ skill; `mcp` entry (command as an
//                  ARRAY) in .kilo/kilo.json (project) /
//                  ~/.config/kilo/kilo.json(c) — the existing global file
//                  wins, kilo.json is created when neither exists
//   - workbuddy  : skill copy in .codebuddy/skills/ (it does not read
//                  .agents/skills/); mcpServers stdio entry in project
//                  .mcp.json (JSONC → manual) / ~/.codebuddy/.mcp.json
//   - devin      : shared .agents/skills/ skill; mcpServers entry in
//                  .devin/mcp_config.json (project) / the Devin config dir
//
// JSON config files are deep-merged (foreign keys never touched), backed up
// to <file>.bak before the first modification, and unparseable / JSONC-
// commented files are left untouched and reported as manual with guidance.
// The shared .agents/skills/ tree is NEVER deleted here (only codex removes
// it). Hook commands use an absolute path (Qwen/Reasonix resolve the
// settings file from any working directory).
import { join } from "node:path";
import type { TargetAdapter, InstallContext } from "../../framework/registry.ts";
import { hookEntriesAdded, hookEntriesRemoved } from "../../framework/hooksettings.ts";
import type { SettingsFile } from "../../framework/hooksettings.ts";
import { readTextFile, upsertManagedBlock, removeManagedBlock } from "../../framework/safe-fs.ts";
import { packagedHookPath } from "../../framework/paths.ts";
import {
  cliOrDirDetector,
  devinHome,
  dropJsonEntry,
  hookFileName,
  jsonEntryAdded,
  jsonEntryRemoved,
  localMcpEntry,
  mcpEntry,
  mcpJsonSharedNote,
  mergeJsonEntry,
  packagedHook,
  readJsonConfig,
  reasonixHome,
  removeManagedFile,
  removeSkillTree,
  sharedKeepNote,
  stdioMcpEntry,
  writeJsonConfig,
  writeSharedAgentsSkill,
  writeSkillTree,
} from "./shared.ts";

// ---------------------------------------------------------------- helpers

/** Hook command with an absolute path (the JSONC settings files of
 *  Qwen/Reasonix are resolved by the agent from any working directory). */
function hookCommandFor(hookFile: string): string {
  return `node "${hookFile}"`;
}

/** Write the packaged hook bundle into `<hooksDir>/hook.cjs` (marker-checked
 *  via ctx.writeManaged). Returns the hook file path, or null when the
 *  packaged source is missing (callers skip the settings hook entry then). */
function writeHookBundle(ctx: InstallContext, hooksDir: string, warnings: string[]): string | null {
  const source = packagedHook();
  if (source === null) {
    warnings.push(`missing ${packagedHookPath()} — run \`npm run build\` first (skipping hook write)`);
    return null;
  }
  const hookFile = join(hooksDir, hookFileName(ctx.manifest));
  ctx.writeManaged(hookFile, source, ctx.manifest.markers.hook);
  return hookFile;
}

/** Shared .agents/skills/<skillDir>/ write for global scope: the
 *  writeSharedAgentsSkill helper skips global (it is the project-level
 *  convention), but reasonix/kilo/devin officially read the user-level
 *  ~/.agents/skills/ too. */
function writeGlobalSharedSkill(ctx: InstallContext, warnings: string[]): void {
  writeSkillTree(ctx, join(ctx.home, ".agents", "skills", ctx.manifest.markers.skillDir), warnings);
}

/** Merge a PreToolUse hook entry (absolute-path command) into a Claude-schema
 *  settings.json (Qwen/Reasonix). JSONC → manual. */
function mergeHookEntry(
  file: string,
  hookFile: string,
  ident: string,
  dryRun: boolean,
): { report: string } | { manual: string } {
  const hookCommand = hookCommandFor(hookFile);
  const loaded = readJsonConfig(file);
  if ("manual" in loaded) return { manual: loaded.manual };
  const data = "missing" in loaded ? {} : loaded.data;
  const sf: SettingsFile = { file, data };
  const added = hookEntriesAdded(sf, "PreToolUse", hookCommand, hookCommand, ident);
  if (!added) {
    return { report: `PreToolUse hook already present in ${file} — idempotent, no change` };
  }
  return {
    report: writeJsonConfig(
      file,
      data,
      dryRun,
      `would merge the PreToolUse hook into ${file}`,
      `merged PreToolUse hook into ${file}`,
    ),
  };
}

/** Drop every PreToolUse hook entry of ours from a settings.json and persist
 *  (JSONC → manual). Appends the report to `notes`. */
function dropHookEntry(file: string, ident: string, dryRun: boolean, notes: string[]): void {
  const loaded = readJsonConfig(file);
  if ("missing" in loaded) {
    notes.push(`no ${file} — nothing to clean`);
    return;
  }
  if ("manual" in loaded) {
    notes.push(loaded.manual);
    return;
  }
  const sf: SettingsFile = { file, data: loaded.data };
  const removed = hookEntriesRemoved(sf, ident);
  if (removed === 0) {
    notes.push(`no hook entries for us in ${file}`);
    return;
  }
  notes.push(
    writeJsonConfig(file, loaded.data, dryRun, `would remove our hook entries from ${file}`, `removed our hook entries from ${file}`),
  );
}

// ---------------------------------------------------------------- qwen

export const qwenAdapter: TargetAdapter = {
  id: "qwen",
  kind: "native",
  label: "Qwen Code",
  scope: "both",
  detect: cliOrDirDetector(["qwen", "qwen-code"], (h) => [join(h, ".qwen")]),
  manualHint: "npm i -g @qwen-code/qwen-code",

  install: async (ctx) => {
    const m = ctx.manifest;
    const root = ctx.scope === "global" ? join(ctx.home, ".qwen") : join(ctx.dir, ".qwen");
    const settingsFile = join(root, "settings.json");
    const warnings: string[] = [];

    // 1) skill tree (.qwen/skills/ — Qwen does not read .agents/skills/)
    writeSkillTree(ctx, join(root, "skills", m.markers.skillDir), warnings);

    // 2) hook.cjs bundle (.qwen/hooks/)
    const hookFile = writeHookBundle(ctx, join(root, "hooks"), warnings);
    const hookCommand = hookFile === null ? null : hookCommandFor(hookFile);
    const hookText = hookCommand === null ? "" : " and a PreToolUse Read hook";

    // 3) settings.json deep-merge: mcpServers + PreToolUse hook (JSONC → manual)
    const loaded = readJsonConfig(settingsFile);
    if ("manual" in loaded) {
      return {
        status: "manual",
        detail:
          `cannot modify ${settingsFile}: ${loaded.manual}. ` +
          `Manual: add "mcpServers": { "${m.name}": { "command": "npx", "args": ["-y", "${m.name}", "mcp"] } } ` +
          `and a PreToolUse hook with matcher "Read" running \`node "${join(root, "hooks", hookFileName(m))}"\`, then restart Qwen.`,
      };
    }
    let report: string;
    if ("missing" in loaded) {
      const data: Record<string, unknown> = { mcpServers: { [m.name]: mcpEntry(m) } };
      if (hookCommand !== null) {
        hookEntriesAdded({ file: settingsFile, data }, "PreToolUse", hookCommand, hookCommand, m.markers.hookCommand);
      }
      report = writeJsonConfig(
        settingsFile,
        data,
        ctx.dryRun,
        `would create ${settingsFile} with mcpServers + PreToolUse hook`,
        `wrote ${settingsFile} with mcpServers["${m.name}"]${hookText}`,
      );
    } else {
      const mcpState = jsonEntryAdded(loaded.data, "mcpServers", m.name, mcpEntry(m));
      if (mcpState === "invalid") {
        return {
          status: "manual",
          detail: `cannot modify ${settingsFile}: "mcpServers" is not a JSON object — left untouched. Manual: add "mcpServers": { "${m.name}": … } to ${settingsFile}.`,
        };
      }
      const sf: SettingsFile = { file: settingsFile, data: loaded.data };
      const hookAdded =
        hookCommand !== null && hookEntriesAdded(sf, "PreToolUse", hookCommand, hookCommand, m.markers.hookCommand);
      if (mcpState === "present" && !hookAdded) {
        report = `mcpServers + hooks already present in ${settingsFile} — idempotent, no change`;
      } else {
        report = writeJsonConfig(
          settingsFile,
          loaded.data,
          ctx.dryRun,
          `would merge mcpServers + PreToolUse hook into ${settingsFile}`,
          `merged mcpServers + PreToolUse hook into ${settingsFile}`,
        );
      }
    }
    return {
      status: "ok",
      detail: `${report} (scope: ${ctx.scope}). Restart Qwen for changes to take effect.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    const root = ctx.scope === "global" ? join(ctx.home, ".qwen") : join(ctx.dir, ".qwen");
    const settingsFile = join(root, "settings.json");
    const loaded = readJsonConfig(settingsFile);
    if ("missing" in loaded) {
      notes.push(`no ${settingsFile} — nothing to clean`);
    } else if ("manual" in loaded) {
      notes.push(loaded.manual);
    } else {
      const removedMcp = jsonEntryRemoved(loaded.data, "mcpServers", m.name);
      const sf: SettingsFile = { file: settingsFile, data: loaded.data };
      const removedHooks = hookEntriesRemoved(sf, m.markers.hookCommand);
      if (removedMcp === 0 && removedHooks === 0) {
        notes.push(`no mcpServers/hooks entries for us in ${settingsFile}`);
      } else {
        notes.push(
          writeJsonConfig(
            settingsFile,
            loaded.data,
            ctx.dryRun,
            `would remove our mcpServers/hooks entries from ${settingsFile}`,
            `removed our entries from ${settingsFile}`,
          ),
        );
      }
    }
    removeManagedFile(ctx, join(root, "hooks", hookFileName(m)), m.markers.hook, notes);
    removeSkillTree(ctx, join(root, "skills", m.markers.skillDir), notes);
    if (!notes.length) notes.push(`not present: ${root} — nothing to remove`);
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- reasonix

export const reasonixAdapter: TargetAdapter = {
  id: "reasonix",
  kind: "native",
  label: "Reasonix",
  scope: "both",
  detect: cliOrDirDetector(["reasonix"], (h) => [reasonixHome(h)]),
  manualHint: "npm i -g reasonix",

  install: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const warnings: string[] = [];

    // 1) shared skill (project .agents/skills/ or global ~/.agents/skills/)
    if (global) writeGlobalSharedSkill(ctx, warnings);
    else writeSharedAgentsSkill(ctx, warnings);

    // 2) hook: bundle + PreToolUse entry in settings.json (project .reasonix/
    //    or the Reasonix home)
    const hookDir = global ? reasonixHome(ctx.home) : join(ctx.dir, ".reasonix");
    const hookFile = writeHookBundle(ctx, join(hookDir, "hooks"), warnings);
    const settingsFile = join(hookDir, "settings.json");
    const details: string[] = [];
    if (hookFile !== null) {
      const hookOutcome = mergeHookEntry(settingsFile, hookFile, m.markers.hookCommand, ctx.dryRun);
      if ("manual" in hookOutcome) {
        return {
          status: "manual",
          detail: `cannot modify ${settingsFile}: ${hookOutcome.manual}. Manual: add a PreToolUse hook with matcher "Read" running \`node "${hookFile}"\` to ${settingsFile}.`,
        };
      }
      details.push(hookOutcome.report);
    }

    // 3) MCP: project .mcp.json entry or a global config.toml [[plugins]] block
    if (global) {
      const toml = join(reasonixHome(ctx.home), "config.toml");
      const tomlStart = `# ${m.name}:start`;
      const tomlEnd = `# ${m.name}:end`;
      const block = [
        tomlStart,
        "[[plugins]]",
        `name = ${JSON.stringify(m.name)}`,
        'type = "stdio"',
        `command = ${JSON.stringify("npx")}`,
        `args = [${["-y", m.name, "mcp"].map((a) => JSON.stringify(a)).join(", ")}]`,
        tomlEnd,
        "",
      ].join("\n");
      const raw = readTextFile(toml);
      if (raw !== null && !raw.includes(tomlStart) && raw.includes(tomlEnd)) {
        details.push(`cannot modify ${toml}: partial managed block (missing the start marker line) — left untouched`);
      } else {
        const r = ctx.dryRun ? { changed: true } : upsertManagedBlock(toml, block, tomlStart, tomlEnd);
        details.push(
          r.changed
            ? `managed [[plugins]] block upserted in ${toml}${ctx.dryRun ? " [dry-run]" : r.backup ? ` (backup: ${r.backup})` : ""}`
            : `config.toml already has our [[plugins]] block — idempotent, no change`,
        );
      }
    } else {
      const file = join(ctx.dir, ".mcp.json");
      const outcome = mergeJsonEntry(file, "mcpServers", m.name, mcpEntry(m), ctx.dryRun, `mcpServers["${m.name}"]`);
      if ("manual" in outcome) {
        return {
          status: "manual",
          detail: `cannot modify ${file}: ${outcome.manual}. Manual: add "mcpServers": { "${m.name}": { "command": "npx", "args": ["-y", "${m.name}", "mcp"] } } to ${file}.`,
        };
      }
      details.push(`${outcome.report} (shared with Copilot/CodeBuddy)`);
    }
    return {
      status: "ok",
      detail: `${details.join("; ")} (scope: ${ctx.scope}). Restart Reasonix for changes to take effect.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const notes: string[] = [];
    const hookDir = global ? reasonixHome(ctx.home) : join(ctx.dir, ".reasonix");
    dropHookEntry(join(hookDir, "settings.json"), m.markers.hookCommand, ctx.dryRun, notes);
    removeManagedFile(ctx, join(hookDir, "hooks", hookFileName(m)), m.markers.hook, notes);
    if (global) {
      const toml = join(reasonixHome(ctx.home), "config.toml");
      const r = ctx.dryRun
        ? { changed: true }
        : removeManagedBlock(toml, `# ${m.name}:start`, `# ${m.name}:end`);
      notes.push(
        r.changed
          ? `${ctx.dryRun ? "[dry-run] would remove" : "removed"} the managed [[plugins]] block from ${toml}${!ctx.dryRun && r.backup ? ` (backup: ${r.backup})` : ""}`
          : `no managed [[plugins]] block in ${toml}`,
      );
      notes.push(sharedKeepNote(m));
    } else {
      dropJsonEntry(join(ctx.dir, ".mcp.json"), "mcpServers", m.name, ctx.dryRun, notes);
      notes.push(mcpJsonSharedNote);
      notes.push(sharedKeepNote(m));
    }
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- kilo

/** Kilo config location: <cwd>/.kilo/kilo.json (project) or the global
 *  ~/.config/kilo/kilo.json(kilo.jsonc) — the existing global file wins,
 *  kilo.json is created when neither exists (official first form). */
function kiloConfigFile(ctx: InstallContext): { file: string; existing: boolean } {
  if (ctx.scope !== "global") return { file: join(ctx.dir, ".kilo", "kilo.json"), existing: false };
  const dir = join(ctx.home, ".config", "kilo");
  for (const name of ["kilo.json", "kilo.jsonc"]) {
    const f = join(dir, name);
    if (readTextFile(f) !== null) return { file: f, existing: true };
  }
  return { file: join(dir, "kilo.json"), existing: false };
}

export const kiloAdapter: TargetAdapter = {
  id: "kilo",
  kind: "native",
  label: "Kilo Code",
  scope: "both",
  detect: cliOrDirDetector(
    ["kilo"],
    (h) => [join(h, ".config", "kilo"), join(h, ".kilo"), join(h, ".kilocode")],
  ),
  manualHint: "npm i -g @kilocode/cli",

  install: async (ctx) => {
    const m = ctx.manifest;
    const warnings: string[] = [];

    // 1) shared skill (Kilo loads .agents/skills/ alongside .kilo/skills/)
    if (ctx.scope === "global") writeGlobalSharedSkill(ctx, warnings);
    else writeSharedAgentsSkill(ctx, warnings);

    // 2) `mcp` entry in kilo.json(kilo.jsonc) — command is an ARRAY
    const { file, existing } = kiloConfigFile(ctx);
    const label = ctx.scope === "global" && !existing ? `kilo.json (created; no kilo.json(kilo.jsonc) existed)` : file;
    const outcome = mergeJsonEntry(file, "mcp", m.name, localMcpEntry(m), ctx.dryRun, `mcp["${m.name}"]`);
    if ("manual" in outcome) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: ${outcome.manual}. Manual: add "mcp": { "${m.name}": { "type": "local", "command": ["npx", "-y", "${m.name}", "mcp"], "enabled": true } } to ${file}.`,
      };
    }
    const scopeNote = ctx.scope === "global" ? "" : " + .agents/skills/";
    return {
      status: "ok",
      detail: `${outcome.report.replace(file, label)}${scopeNote} (scope: ${ctx.scope}). Load with /reload.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    dropJsonEntry(kiloConfigFile(ctx).file, "mcp", m.name, ctx.dryRun, notes);
    notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- workbuddy

export const workbuddyAdapter: TargetAdapter = {
  id: "workbuddy",
  kind: "native",
  label: "WorkBuddy",
  scope: "both",
  detect: cliOrDirDetector(
    ["codebuddy", "cbc", "codebuddy-code"],
    (h) => [join(h, ".codebuddy")],
  ),
  manualHint: "npm i -g @tencent-ai/codebuddy-code",

  install: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const root = global ? join(ctx.home, ".codebuddy") : join(ctx.dir, ".codebuddy");
    const warnings: string[] = [];

    // 1) skill tree (.codebuddy/skills/ — CodeBuddy does not read
    //    .agents/skills/)
    writeSkillTree(ctx, join(root, "skills", m.markers.skillDir), warnings);

    // 2) mcpServers stdio entry: project .mcp.json (JSONC → manual) or
    //    ~/.codebuddy/.mcp.json (global)
    const file = global ? join(root, ".mcp.json") : join(ctx.dir, ".mcp.json");
    const outcome = mergeJsonEntry(file, "mcpServers", m.name, stdioMcpEntry(m), ctx.dryRun, `mcpServers["${m.name}"]`);
    if ("manual" in outcome) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: ${outcome.manual}. Manual: add "mcpServers": { "${m.name}": { "type": "stdio", "command": "npx", "args": ["-y", "${m.name}", "mcp"] } } to ${file}.`,
      };
    }
    const extra = global
      ? ""
      : ` Project-level MCP needs a first-connection approval in CodeBuddy; headless runs can pre-authorize with "enabledMcpjsonServers": ["${m.name}"].`;
    return { status: "ok", detail: `${outcome.report}${extra}` };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const notes: string[] = [];
    const root = global ? join(ctx.home, ".codebuddy") : join(ctx.dir, ".codebuddy");
    const file = global ? join(root, ".mcp.json") : join(ctx.dir, ".mcp.json");
    dropJsonEntry(file, "mcpServers", m.name, ctx.dryRun, notes);
    if (!global) notes.push(mcpJsonSharedNote);
    removeSkillTree(ctx, join(root, "skills", m.markers.skillDir), notes);
    if (!notes.length) notes.push(`not present: ${root} — nothing to remove`);
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- devin

export const devinAdapter: TargetAdapter = {
  id: "devin",
  kind: "native",
  label: "Devin",
  scope: "both",
  detect: cliOrDirDetector(["devin"], (h) => [devinHome(h)]),
  manualHint: "the Devin CLI — https://devin.ai/download (no official npm package)",

  install: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const warnings: string[] = [];

    // 1) shared skill (project .agents/skills/ or global ~/.agents/skills/)
    if (global) writeGlobalSharedSkill(ctx, warnings);
    else writeSharedAgentsSkill(ctx, warnings);

    // 2) mcpServers entry in mcp_config.json (project .devin/ or the Devin
    //    config dir)
    const file = global
      ? join(devinHome(ctx.home), "mcp_config.json")
      : join(ctx.dir, ".devin", "mcp_config.json");
    const outcome = mergeJsonEntry(file, "mcpServers", m.name, mcpEntry(m), ctx.dryRun, `mcpServers["${m.name}"]`);
    if ("manual" in outcome) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: ${outcome.manual}. Manual: add "mcpServers": { "${m.name}": { "command": "npx", "args": ["-y", "${m.name}", "mcp"] } } to ${file}.`,
      };
    }
    return {
      status: "ok",
      detail: `${outcome.report} (scope: ${ctx.scope}). stdio MCP works in the local Devin CLI/Desktop; Devin Cloud sessions only support remote HTTP MCP (out of scope).`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const notes: string[] = [];
    const file = global
      ? join(devinHome(ctx.home), "mcp_config.json")
      : join(ctx.dir, ".devin", "mcp_config.json");
    dropJsonEntry(file, "mcpServers", m.name, ctx.dryRun, notes);
    notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};
