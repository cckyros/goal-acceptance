// Codex adapter: config.toml [mcp_servers.<name>] section (version-pinned),
// AGENTS.md managed block, the models.json supports_search_tool fix
// (openai/codex#36382), and the shared .agents/skills/<skillDir>/ tree
// (project scope only — codex owns it; every other agent keeps it).
// Ported from deepseek-vl-support codex.ts + install.ts (installCodex).
// The models.json fix is genericized: the flag hides ALL mcp__* tools for
// ANY model entry, so every entry carrying `supports_search_tool: true` is
// flipped (the original matched "deepseek" names only).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TargetAdapter } from "../../framework/registry.ts";
import {
  backupFile,
  readTextFile,
  removeManagedBlock,
  removeTomlSection,
  upsertManagedBlock,
  upsertTomlSection,
  writeTextFile,
} from "../../framework/safe-fs.ts";
import { removeManagedFile, removeEmptyDirTree, fillAsset, writeSharedAgentsSkill } from "./shared.ts";

export const codexAdapter: TargetAdapter = {
  id: "codex",
  kind: "native",
  label: "Codex",
  scope: "both",
  detect: () => true,

  install: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const codexDir = global ? join(ctx.home, ".codex") : join(ctx.dir, ".codex");
    const configToml = join(codexDir, "config.toml");
    const agentsFile = join(codexDir, "AGENTS.md");
    const details: string[] = [];

    // 1) [mcp_servers.<name>] section, version-pinned so updates reinstall.
    // TOML bare keys cannot contain '@' or '/', so the last segment must be quoted.
    const tomlServerKey = JSON.stringify(m.name);           // "@cckyros/goal-acceptance"
    const tomlSectionName = `mcp_servers.${tomlServerKey}`; // mcp_servers."@cckyros/goal-acceptance"
    const args = ["-y", `${m.name}@${m.version}`, "mcp"].map((a) => JSON.stringify(a)).join(", ");
    const block =
      `[${tomlSectionName}]\n` +
      `command = ${JSON.stringify("npx")}\n` +
      `args = [${args}]\n` +
      `tool_timeout_sec = 180\n`;
    if (ctx.dryRun) ctx.log(`[dry-run] upsert [${tomlSectionName}] section in ${configToml}`);
    // Migrate away from the old unquoted (TOML-invalid) section name.
    const legacySectionName = `mcp_servers.${m.name}`;
    if (!ctx.dryRun) removeTomlSection(configToml, legacySectionName);
    const r1 = ctx.dryRun
      ? { changed: true }
      : upsertTomlSection(configToml, tomlSectionName, block);
    details.push(
      r1.changed
        ? `[${tomlSectionName}] section upserted in ${configToml} (npx -y ${m.name}@${m.version} mcp)${ctx.dryRun ? " [dry-run]" : r1.backup ? ` (backup: ${r1.backup})` : ""}`
        : `config.toml already has [${tomlSectionName}] — idempotent, no change`,
    );

    // 2) AGENTS.md managed block (from the agents-fragment template)
    const fragment = fillAsset(m, "agents-fragment.md");
    if (fragment !== null) {
      const blockText = `${m.markers.agentsStart}\n${fragment.trim()}\n${m.markers.agentsEnd}`;
      if (ctx.dryRun) ctx.log(`[dry-run] upsert AGENTS.md managed block in ${agentsFile}`);
      const r2 = ctx.dryRun
        ? { changed: true }
        : upsertManagedBlock(agentsFile, blockText, m.markers.agentsStart, m.markers.agentsEnd);
      details.push(
        r2.changed
          ? `AGENTS.md block written to ${agentsFile}${ctx.dryRun ? " [dry-run]" : r2.backup ? ` (backup: ${r2.backup})` : ""}`
          : `AGENTS.md already has our block — idempotent, no change`,
      );
    }

    // 3) shared .agents/skills tree (project scope only)
    const warnings: string[] = [];
    writeSharedAgentsSkill(ctx, warnings);
    if (global) details.push(`.agents/skills/ skipped (project-level convention)`);

    // 4) models.json fix (openai/codex#36382)
    const modelsPath = findModelsJson(ctx.dir, ctx.home);
    if (modelsPath === null) {
      details.push(
        `models.json not found — if "mcp__${m.name}__*" tools are invisible, set supports_search_tool: false for your model entry in ~/.codex/models.json`,
      );
    } else {
      if (ctx.dryRun) ctx.log(`[dry-run] fix models.json bug (#36382) in ${modelsPath}`);
      const fix = ctx.dryRun
        ? { changed: true }
        : fixModelsJson(modelsPath);
      details.push(
        fix.changed
          ? `fixed models.json bug (#36382) in ${modelsPath}${ctx.dryRun ? " [dry-run]" : fix.backup ? ` (backup: ${fix.backup})` : ""}`
          : `models.json OK (no entries with supports_search_tool=true) — ${modelsPath}`,
      );
    }

    details.push(`restart your Codex session; verify with \`codex mcp list\``);
    return {
      status: "ok",
      detail:
        `MCP server section + AGENTS.md block + models.json fix` +
        (global ? "" : " + .agents/skills/") +
        ` (scope: ${ctx.scope})${ctx.dryRun ? " [dry-run, nothing written]" : ""}`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const global = ctx.scope === "global";
    const codexDir = global ? join(ctx.home, ".codex") : join(ctx.dir, ".codex");
    const configToml = join(codexDir, "config.toml");
    const agentsFile = join(codexDir, "AGENTS.md");
    const notes: string[] = [];

    const tomlServerKey = JSON.stringify(m.name);
    const tomlSectionName = `mcp_servers.${tomlServerKey}`;
    const legacySectionName = `mcp_servers.${m.name}`;
    if (ctx.dryRun) {
      notes.push(
        `[dry-run] would remove [${tomlSectionName}] from ${configToml} and the AGENTS.md block from ${agentsFile}`,
      );
    } else {
      // Remove both the new quoted and the old unquoted/invalid section names.
      removeTomlSection(configToml, legacySectionName);
      const r1 = removeTomlSection(configToml, tomlSectionName);
      notes.push(
        r1.changed
          ? `removed [${tomlSectionName}] section from ${configToml}${r1.backup ? `, backup ${r1.backup}` : ""}`
          : `no [${tomlSectionName}] section in ${configToml}`,
      );
      const r2 = removeManagedBlock(agentsFile, m.markers.agentsStart, m.markers.agentsEnd);
      notes.push(
        r2.changed
          ? `removed AGENTS.md block from ${agentsFile}${r2.backup ? `, backup ${r2.backup}` : ""}`
          : `no ${m.markers.agentsStart} block in ${agentsFile}`,
      );
    }

    // .agents/skills (project scope only): codex OWNS the shared tree — remove
    // only our skill dir; siblings are never touched, empty dirs are pruned.
    if (!global) {
      const agentsSkillsDir = join(ctx.dir, ".agents", "skills", m.markers.skillDir);
      removeManagedFile(ctx, join(agentsSkillsDir, "SKILL.md"), m.markers.skill, notes);
      if (!ctx.dryRun) notes.push(...removeEmptyDirTree(agentsSkillsDir));
    }

    notes.push(`models.json fixes are NOT reverted automatically (they are safe/helpful)`);
    return { status: "ok", detail: notes.join("; ") };
  },
};

/** models.json lookup: project .codex/models.json, then ~/.codex/models.json. */
function findModelsJson(cwd: string, home: string): string | null {
  const project = join(cwd, ".codex", "models.json");
  if (existsSync(project)) return project;
  const user = join(home, ".codex", "models.json");
  if (existsSync(user)) return user;
  return null;
}

/** Flip `supports_search_tool: true` → false on every model entry. Returns
 *  {changed, backup}. Accepts an array or `{models: [...]}` shape. */
function fixModelsJson(modelsPath: string): { changed: boolean; backup?: string | null } {
  const existing = readTextFile(modelsPath);
  if (existing === null) return { changed: false };
  let data: unknown;
  try {
    data = JSON.parse(existing);
  } catch {
    return { changed: false };
  }
  const entries = Array.isArray(data)
    ? data
    : Array.isArray((data as { models?: unknown[] })?.models)
      ? (data as { models: unknown[] }).models
      : null;
  if (!entries) return { changed: false };
  let changedAny = false;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    if (rec.supports_search_tool === true) {
      rec.supports_search_tool = false;
      changedAny = true;
    }
  }
  if (!changedAny) return { changed: false };
  const backup = backupFile(modelsPath);
  writeTextFile(modelsPath, JSON.stringify(data, null, 2) + "\n");
  return { changed: true, backup };
}
