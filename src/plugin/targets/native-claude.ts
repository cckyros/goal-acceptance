// Claude Code adapter: .claude/settings.json hook entries (PreToolUse Read +
// SessionStart), hooks/hook.cjs bundle, skills/<skillDir>/ skill tree,
// commands/<commandFile> slash command, and a .gitignore entry for the
// project config dir. Ported from deepseek-vl-support install.ts
// (installClaude/uninstallClaude), string-parameterized by the manifest.
import { join } from "node:path";
import type { TargetAdapter } from "../../framework/registry.ts";
import { readTextFile, writeTextFile, ensureDir, backupFile } from "../../framework/safe-fs.ts";
import { readSettings, hookEntriesAdded, hookEntriesRemoved } from "../../framework/hooksettings.ts";
import type { SettingsFile } from "../../framework/hooksettings.ts";
import { fillAsset, hookFileName, packagedHook, removeManagedFile, removeEmptyDirTree, writeSkillTree } from "./shared.ts";

export const claudeAdapter: TargetAdapter = {
  id: "claude",
  kind: "native",
  label: "Claude Code",
  scope: "both",
  // Claude Code has no reliable CLI/config probe; always offered (the CLI is
  // detected by the wizard only for agents that CAN be probed).
  detect: () => true,

  install: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const claudeDir = global ? join(ctx.home, ".claude") : join(ctx.dir, ".claude");
    const hooksDir = join(claudeDir, "hooks");
    const skillDir = join(claudeDir, "skills", m.markers.skillDir);
    const commandsDir = join(claudeDir, "commands");
    const commandFile = join(commandsDir, m.markers.commandFile);
    const settingsFile = join(claudeDir, "settings.json");
    const hookFileName_ = hookFileName(m);
    const hookFile = join(hooksDir, hookFileName_);
    const hookCommand = global ? `node "${hookFile}"` : `node .claude/hooks/${hookFileName_}`;
    const startCommand = `${hookCommand} start`;

    // 1) hook bundle (marker-checked whole-file write)
    const hookSource = packagedHook();
    if (hookSource === null) {
      return {
        status: "error",
        detail: `missing dist/hook.cjs — run \`npm run build\` first`,
      };
    }
    ctx.writeManaged(hookFile, hookSource, m.markers.hook);

    // 2) skill tree + 3) slash command (assets are {{placeholder}} templates;
    //    the installer fills them with the manifest identity)
    const warnings: string[] = [];
    writeSkillTree(ctx, skillDir, warnings);
    const cmdMd = fillAsset(m, m.markers.commandFile);
    if (cmdMd !== null) ctx.writeManaged(commandFile, cmdMd, m.markers.command);

    // 4) settings.json hooks (append-only, foreign entries never touched)
    const settings = readSettings(settingsFile);
    const details: string[] = [];
    if (settings === null) {
      const data: Record<string, unknown> = { hooks: {} };
      const sf: SettingsFile = { file: settingsFile, data };
      hookEntriesAdded(sf, "PreToolUse", hookCommand, startCommand, m.markers.hookCommand);
      hookEntriesAdded(sf, "SessionStart", hookCommand, startCommand, m.markers.hookCommand);
      if (ctx.dryRun) {
        details.push(`[dry-run] would create ${settingsFile} with hook entries`);
      } else {
        ensureDir(settingsFile);
        writeTextFile(settingsFile, JSON.stringify(data, null, 2) + "\n");
        details.push(`wrote ${settingsFile} with PreToolUse(Read) + SessionStart hooks`);
      }
    } else {
      const addedPre = hookEntriesAdded(settings, "PreToolUse", hookCommand, startCommand, m.markers.hookCommand);
      const addedStart = hookEntriesAdded(settings, "SessionStart", hookCommand, startCommand, m.markers.hookCommand);
      if (addedPre || addedStart) {
        if (ctx.dryRun) {
          details.push(`[dry-run] would merge hook entries into ${settingsFile}`);
        } else {
          const backup = backupFile(settingsFile);
          ensureDir(settingsFile);
          writeTextFile(settingsFile, JSON.stringify(settings.data, null, 2) + "\n");
          details.push(`merged hooks into ${settingsFile}${backup ? ` (backup: ${backup})` : ""}`);
        }
      } else {
        details.push(`settings.json already contains our hook entries — idempotent, no change`);
      }
    }

    // 5) .gitignore for the project config dir (project scope only)
    if (!global) {
      const gi = join(ctx.dir, ".gitignore");
      const existing = readTextFile(gi);
      const entry = `${m.markers.configDir}/`;
      if (existing !== null && existing.split(/\r?\n/).some((l) => l.trim() === entry)) {
        // already there
      } else if (ctx.dryRun) {
        details.push(`[dry-run] would add "${entry}" to .gitignore`);
      } else {
        writeTextFile(gi, `${existing?.trimEnd() ?? ""}${existing?.trimEnd() ? "\n" : ""}${entry}\n`);
        details.push(`added "${entry}" to .gitignore`);
      }
    }

    details.push(`restart your Claude Code session for hooks to take effect`);
    return {
      status: "ok",
      detail: `hook + skill + /${m.markers.commandFile.replace(/\.md$/, "")} command + settings.json hooks (scope: ${ctx.scope})${ctx.dryRun ? " [dry-run, nothing written]" : ""}`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const claudeDir = global ? join(ctx.home, ".claude") : join(ctx.dir, ".claude");
    const settingsFile = join(claudeDir, "settings.json");
    const notes: string[] = [];

    const settings = readSettings(settingsFile);
    if (settings) {
      const removed = hookEntriesRemoved(settings, m.markers.hookCommand);
      if (removed > 0) {
        if (ctx.dryRun) {
          notes.push(`[dry-run] would remove ${removed} hook entry(ies) from ${settingsFile}`);
        } else {
          const backup = backupFile(settingsFile);
          ensureDir(settingsFile);
          writeTextFile(settingsFile, JSON.stringify(settings.data, null, 2) + "\n");
          notes.push(`removed ${removed} hook entry(ies) from ${settingsFile}${backup ? `, backup ${backup}` : ""}`);
        }
      } else {
        notes.push(`no ${m.markers.hook} hook entries in ${settingsFile}`);
      }
    }

    removeManagedFile(ctx, join(claudeDir, "hooks", hookFileName(m)), m.markers.hook, notes);
    const skillDir = join(claudeDir, "skills", m.markers.skillDir);
    removeManagedFile(ctx, join(skillDir, "SKILL.md"), m.markers.skill, notes);
    if (!ctx.dryRun) notes.push(...removeEmptyDirTree(skillDir));
    removeManagedFile(ctx, join(claudeDir, "commands", m.markers.commandFile), m.markers.command, notes);

    // project scope only: drop the .gitignore line we added
    if (!global) {
      const gi = join(ctx.dir, ".gitignore");
      const entry = `${m.markers.configDir}/`;
      const existing = readTextFile(gi);
      if (existing !== null && existing.split(/\r?\n/).some((l) => l.trim() === entry)) {
        if (ctx.dryRun) {
          notes.push(`[dry-run] would remove "${entry}" from .gitignore`);
        } else {
          const kept = existing.split(/\r?\n/).filter((l) => l.trim() !== entry);
          writeTextFile(gi, kept.join("\n") + (kept.length ? "\n" : ""));
          notes.push(`removed "${entry}" from .gitignore`);
        }
      }
    }

    if (!notes.length) notes.push(`nothing to remove under ${claudeDir}`);
    return { status: "ok", detail: notes.join("; ") };
  },
};
