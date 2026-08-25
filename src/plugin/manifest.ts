// Business layer manifest — THE single source of identity for this plugin.
// Everything else (plugin.json / mcp.json / .mcp.json / marketplace.json /
// cordis.patch.yml) is derived by build.mjs. All values are plain literals.
import type { PluginManifest } from "../framework/manifest.ts";
import { tools } from "./tools.ts";

export const manifest: PluginManifest = {
  name: "@cckyros/goal-acceptance",
  version: "0.2.0", // 0.1.x monorepo → 0.2.0 single-package scaffold
  brand: "goal-acceptance",
  description: "Acceptance-criteria-driven goal completion for autonomous agents.",
  githubSlug: "cckyros/goal-acceptance",

  // Identity markers. Keep stable across releases — uninstall recognizes
  // artifacts by these strings and never touches files without them.
  markers: {
    hook: "goal-acceptance-hook",
    hookCommand: "goal-acceptance-hook",
    skill: "@cckyros/goal-acceptance:skill", // matches SKILL.md frontmatter `# {{name}}:skill` fill
    command: "goal-acceptance:command",
    commandFile: "goal-acceptance.md",
    skillDir: "goal-acceptance",
    configDir: ".goal-acceptance",
    cursorDir: "goal-acceptance",
    cursorMarkerFile: ".goal-acceptance-managed",
    cursorMarker: "goal-acceptance:managed",
    agentsStart: "<!-- goal-acceptance:start -->",
    agentsEnd: "<!-- goal-acceptance:end -->",
  },

  config: [
    {
      key: "pluginData",
      label: "Plugin data dir",
      type: "string",
      env: "PLUGIN_DATA",
      default: "",
      placeholder: "e.g. ~/.goal-acceptance (empty = in-memory)",
    },
    {
      key: "autoSteerUncompleted",
      label: "Auto steer on uncompleted goals",
      type: "boolean",
      env: "GOAL_ACCEPTANCE_AUTOSTEER",
      default: true,
    },
    {
      key: "maxSteeringTurns",
      label: "Max steering turns per session",
      type: "number",
      env: "GOAL_ACCEPTANCE_MAX_STEERING_TURNS",
      default: 5,
    },
  ],

  tools,

  // Skill body ships as assets/SKILL.md (byte-synced to skills/<skillDir>/).
  skill: { filename: "SKILL.md" },

  // No hook / bizCli / doctorChecks — goal acceptance is tool-driven; the
  // dsh steering behavior lives in src/plugin/dsh-plugin.ts (cordis plugin).
};
