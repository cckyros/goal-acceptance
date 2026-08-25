// Skill-copy target adapters: trae / pi / omp / dsh. These agents read Agent
// Skills but do NOT implement the Agent Plugins open standard (see
// deepseek-vl-support research/opencode-trae.md + pi-deepseek-harness.md), so
// the installer writes the packaged skill tree into the shared
// .agents/skills/<skillDir>/ location (project scope only — these targets
// never trigger the scope question) and prints each agent's preferred native
// install command. Ported from deepseek-vl-support skillagents.ts,
// parameterized by the manifest:
//  - trae (IDE only): skill copied to .trae/skills/<skillDir>/ + manual
//    import guidance (GUI-only; no CLI, no MCP automation)
//  - pi: shared skill + ~/.pi/agent/mcp.json mcpServers entry written ONLY
//    when the community pi-mcp-adapter extension is detected (~/.pi/agent/
//    mcp.json or npm/ dir exists) — a plain pi install is never modified
//  - omp: shared skill + `omp install npm:<name>` guidance; the package's
//    .mcp.json is auto-registered, so there is no config file to touch
//  - dsh: shared skill + `dsh plugin --profile web add <name>@latest`
//    guidance; the cordis patch ships with the package (cordis.patch.yml)
//
// Uninstall ownership (same rule as opencode): none of these remove the
// shared .agents/skills/<skillDir>/ tree — only `uninstall --target codex`
// does. The keep rule is stated in the result detail instead.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TargetAdapter } from "../../framework/registry.ts";
import { packagedSkillPath } from "../../framework/paths.ts";
import {
  cliOrDirDetector,
  dropJsonEntry,
  mcpEntry,
  mergeJsonEntry,
  removeSkillTree,
  sharedKeepNote,
  writeSharedAgentsSkill,
  writeSkillTree,
} from "./shared.ts";

/** Trae IDE data dir: %APPDATA%\Trae (win), ~/Library/Application Support/
 *  Trae (mac), ~/.config/Trae (linux). GUI-only — a pure directory probe. */
function traeConfigDir(home: string): string {
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "Trae");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Trae");
  return join(home, ".config", "Trae");
}

/** Pi MCP config: ~/.pi/agent/mcp.json, Claude Code format (read by the
 *  community pi-mcp-adapter extension — pi core has no MCP). */
function piMcpFile(home: string): string {
  return join(home, ".pi", "agent", "mcp.json");
}

// ---------------------------------------------------------------- trae

export const traeAdapter: TargetAdapter = {
  id: "trae",
  kind: "skill",
  label: "Trae",
  scope: "project",
  detect: (ctx) => existsSync(traeConfigDir(ctx.home)),
  manualHint: "the Trae IDE — trae.ai",

  install: async (ctx) => {
    const m = ctx.manifest;
    const warnings: string[] = [];
    const dest = join(ctx.dir, ".trae", "skills", m.markers.skillDir);
    const ok = writeSkillTree(ctx, dest, warnings);
    if (!ok) {
      warnings.push(
        `missing ${packagedSkillPath(m)} — run \`npm run build\` first (skipping .trae/skills write)`,
      );
    }
    const guidance =
      (ok
        ? `skill copied to ${dest}. Manual: Trae is an IDE — import the skill in Settings → Rules & Skills (Create/Import, pick ${dest}), then restart Trae. `
        : `skill write skipped (packaged skill missing — run \`npm run build\` first). Manual: copy skills/${m.markers.skillDir}/ to ${dest} and import it in Settings → Rules & Skills. `) +
      `Trae community reports also suggest it may scan .agents/skills/ (unverified) — if you also installed codex/opencode/pi/omp/dsh, the shared skill is already there. ` +
      `MCP (manual, optional): add a server in Trae's MCP settings (Settings → MCP → Manually Add) with command \`npx -y ${m.name} mcp\`.`;
    return { status: "manual", detail: guidance + (warnings.length ? warnings.join(" ") : "") };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    const dest = join(ctx.dir, ".trae", "skills", m.markers.skillDir);
    removeSkillTree(ctx, dest, notes);
    if (!notes.length) notes.push(`not present: ${dest} — nothing to remove`);
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- pi

export const piAdapter: TargetAdapter = {
  id: "pi",
  kind: "skill",
  label: "pi",
  scope: "project",
  detect: cliOrDirDetector(["pi"], (home) => [join(home, ".pi", "agent")]),
  manualHint: "npm i -g @earendil-works/pi-coding-agent",

  install: async (ctx) => {
    const m = ctx.manifest;
    const warnings: string[] = [];
    writeSharedAgentsSkill(ctx, warnings);

    // Adapter detection (conservative): only write mcp.json when the target
    // file or the pi extensions dir (~/.pi/agent/npm/) already exists — a
    // plain pi install (no adapter) must not be modified.
    const file = piMcpFile(ctx.home);
    const adapterPresent = existsSync(file) || existsSync(join(ctx.home, ".pi", "agent", "npm"));
    if (!adapterPresent) {
      return {
        status: "manual",
        detail:
          `Prefer the native package: \`pi install npm:${m.name}\` (or ` +
          `\`pi install git:github.com/${m.githubSlug}@<tag>\`) — one command gives pi the ` +
          `${m.brand} skill (user-level, reload-free after restart) and a native extension. ` +
          `The project-level skill was also written to .agents/skills/${m.markers.skillDir}/ (pi loads ` +
          `project skills only after you trust the project on first run; use it for team repos). ` +
          `To get MCP tools on top, install the community extension pi-mcp-adapter ` +
          `(\`pi install npm:pi-mcp-adapter\`, restart pi) and re-run this installer.` +
          (warnings.length ? " " + warnings.join(" ") : ""),
      };
    }

    const verb = `mcpServers["${m.name}"]`;
    const out = mergeJsonEntry(file, "mcpServers", m.name, mcpEntry(m), ctx.dryRun, verb);
    if ("manual" in out) {
      return {
        status: "manual",
        detail:
          `${out.manual}. Manual: add "mcpServers": { "${m.name}": { "command": "npx", ` +
          `"args": ["-y", "${m.name}", "mcp"] } } to ${file}. Or prefer the native package: ` +
          `\`pi install npm:${m.name}\` gives the skill with no config edits.`,
      };
    }
    return {
      status: "ok",
      detail:
        out.report +
        ` (pi-mcp-adapter detected). The package also ships a native pi extension.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    dropJsonEntry(piMcpFile(ctx.home), "mcpServers", m.name, ctx.dryRun, notes);
    notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- omp

export const ompAdapter: TargetAdapter = {
  id: "omp",
  kind: "skill",
  label: "Oh My Pi",
  scope: "project",
  detect: cliOrDirDetector(["omp"], (home) => [join(home, ".omp")]),
  manualHint: "npm i -g @oh-my-pi/pi-coding-agent",

  install: async (ctx) => {
    const m = ctx.manifest;
    const warnings: string[] = [];
    writeSharedAgentsSkill(ctx, warnings);
    // omp reads the project .agents/skills/ shared tree (priority 70) and
    // auto-registers a package's .mcp.json/mcp.json servers once the package
    // is installed and enabled — no config file to touch (omp's user-level
    // mcp config path is unverified; don't write what is not verified).
    return {
      status: "ok",
      detail:
        `Prefer the native package: \`omp install npm:${m.name}\` (or ` +
        `\`omp install github:${m.githubSlug}@<tag>\`) — one command gives omp the ${m.brand} ` +
        `skill AND automatic MCP tools (the package's .mcp.json is auto-registered; activate with ` +
        `/reload-plugins). The project-level skill was also written to ` +
        `.agents/skills/${m.markers.skillDir}/ (omp reads it at priority 70 — use it for team repos). ` +
        `No config file is written by this installer (omp user-level MCP config paths are unverified).` +
        (warnings.length ? " " + warnings.join(" ") : ""),
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes = [
      `omp has no own artifacts to remove (its skill lives in the shared .agents/skills/ tree; the ` +
        `native package is removed with \`omp plugin uninstall ${m.name}\`)`,
    ];
    notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- dsh

export const dshAdapter: TargetAdapter = {
  id: "dsh",
  kind: "skill",
  label: "dsh",
  scope: "project",
  detect: cliOrDirDetector(["dsh"], (home) => [join(home, ".dsh")]),
  manualHint: "npx @deepseek-ai/dsh web",

  install: async (ctx) => {
    const m = ctx.manifest;
    const warnings: string[] = [];
    writeSharedAgentsSkill(ctx, warnings);
    return {
      status: "manual",
      detail:
        `Prefer the native package: \`dsh plugin --profile web add ${m.name}@latest\` (or ` +
        `\`dsh plugin --profile web add github:${m.githubSlug}@<tag>\`) — one command gives dsh ` +
        `first-party tools (same names as the MCP server), reading the same env / config chain ` +
        `(restart the dsh web session after install). The project-level skill was also written to ` +
        `.agents/skills/${m.markers.skillDir}/ (dsh reads it at rank 200 — use it for team repos). ` +
        `Uninstall: \`dsh plugin --profile web remove ${m.name}\`. ` +
        `Note: dsh skill frontmatter is fail-closed on camelCase keys; our skill uses ` +
        `\`allowed-tools\` (kebab-case) — whether dsh ignores the key needs real-machine verification.` +
        (warnings.length ? " " + warnings.join(" ") : ""),
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes = [
      `dsh has no own artifacts to remove (its skill lives in the shared .agents/skills/ tree)`,
    ];
    notes.push(sharedKeepNote(m));
    return { status: "ok", detail: notes.join("; ") };
  },
};
