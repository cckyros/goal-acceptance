// OpenCode adapter: opencode.json `mcp.<name>` entry (local, command as an
// ARRAY) + the shared .agents/skills/ tree (project scope only). Ported from
// deepseek-vl-support skillagents.ts (registerOpencode/uninstallOpencode).
import { join } from "node:path";
import type { TargetAdapter } from "../../framework/registry.ts";
import {
  cliOrDirDetector,
  dropJsonEntry,
  localMcpEntry,
  mergeJsonEntry,
  opencodeConfigDir,
  sharedKeepNote,
  writeSharedAgentsSkill,
} from "./shared.ts";

/** opencode.json location: <cwd>/opencode.json (project) or the global
 *  config dir (Windows %APPDATA%\opencode\opencode.json, elsewhere
 *  ~/.config/opencode/opencode.json). */
function opencodeConfigFile(ctx: { dir: string; home: string; scope: string }): string {
  return ctx.scope === "global"
    ? join(opencodeConfigDir(ctx.home), "opencode.json")
    : join(ctx.dir, "opencode.json");
}

export const opencodeAdapter: TargetAdapter = {
  id: "opencode",
  kind: "native",
  label: "OpenCode",
  scope: "both",
  detect: cliOrDirDetector(["opencode"], (h) => [opencodeConfigDir(h)]),
  manualHint: "npm i -g opencode-ai",

  install: async (ctx) => {
    const m = ctx.manifest;
    const file = opencodeConfigFile(ctx);
    const warnings: string[] = [];

    // 1) shared skill (project scope only — opencode reads .agents/skills/
    //    natively, no AGENTS.md block needed)
    writeSharedAgentsSkill(ctx, warnings);

    // 2) MCP entry in opencode.json (deep-merge; user content never touched)
    const outcome = mergeJsonEntry(
      file,
      "mcp",
      m.name,
      localMcpEntry(m),
      ctx.dryRun,
      `mcp["${m.name}"]`,
    );
    if ("manual" in outcome) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: ${outcome.manual}. Manual: add "mcp": { "${m.name}": { "type": "local", "command": ["npx", "-y", "${m.name}", "mcp"], "enabled": true } } to ${file}.`,
      };
    }
    const scopeNote = ctx.scope === "global" ? "" : " + .agents/skills/";
    return {
      status: "ok",
      detail: `${outcome.report}${scopeNote} (scope: ${ctx.scope})${ctx.dryRun ? " [dry-run, nothing written]" : ""}`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    dropJsonEntry(opencodeConfigFile(ctx), "mcp", m.name, ctx.dryRun, notes);
    if (ctx.scope !== "global") notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};
