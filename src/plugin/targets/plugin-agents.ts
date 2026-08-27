// Agent Plugins portable-package target adapters: copilot / cursor / kiro /
// openclaw / hermes / vscode / chatgpt-codex / grok / nanoclaw / other.
// These clients read the Agent Plugins open standard (agent-plugins.org), so
// the installer materializes ONE shared plugin dir (~/.<configDir>/plugin/,
// exactly plugin.json + mcp.json + .mcp.json + skills/) and registers it per
// client. Ported from deepseek-vl-support plugin.ts, parameterized by the
// manifest.
//
// Safety rules (same as the native adapters):
//  - external commands run only when not dry-running; every failure is
//    captured into the per-client result and never blocks other clients
//  - file writes (cursor copy, copilot/vscode settings.json) are backed up /
//    marker-checked exactly like the native installers
//  - clients with no automation surface (kiro, other) or whose CLI is not
//    detected get precise guidance via the "manual" status, never a throw
//  - uninstall never removes the materialized dir (--purge-config does);
//    cursor's own copy is marker-checked before removal; the codex
//    marketplace registration is kept (harmless, re-run install to refresh)
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { InstallContext, TargetAdapter } from "../../framework/registry.ts";
import { which } from "../../framework/registry.ts";
import { backupFile, writeTextFile } from "../../framework/safe-fs.ts";
import { readJsonConfig } from "./shared.ts";
import { pluginDir } from "../../framework/paths.ts";
import {
  cliDetector,
  codexMarketplaceDir,
  dirDetector,
  nanoclawTemplatesDir,
  pluginMaterialize,
  pluginRepo,
  runCli,
  toolNames,
  vscodeUserSettingsPath,
} from "./plugin-shared.ts";

// ---------------------------------------------------------------- copilot

const COPILOT_ENABLED_PLUGINS_KEY = "enabledPlugins";

function copilotSettingsFile(home: string): string {
  return join(home, ".copilot", "settings.json");
}

function copilotEntryPresent(data: Record<string, unknown>, repo: string): boolean {
  const arr = data[COPILOT_ENABLED_PLUGINS_KEY];
  return Array.isArray(arr) && arr.includes(repo);
}

/** Remove our enabledPlugins entries; returns how many were removed. */
function copilotEntryRemoved(data: Record<string, unknown>, name: string): number {
  const arr = data[COPILOT_ENABLED_PLUGINS_KEY];
  if (!Array.isArray(arr)) return 0;
  const kept = arr.filter((e) => !(typeof e === "string" && e.includes(name)));
  const removed = arr.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length) data[COPILOT_ENABLED_PLUGINS_KEY] = kept;
  else delete data[COPILOT_ENABLED_PLUGINS_KEY];
  return removed;
}

export const copilotAdapter: TargetAdapter = {
  id: "copilot",
  kind: "plugin",
  label: "GitHub Copilot",
  scope: "global",
  detect: cliDetector("copilot"),
  manualHint: "npm i -g @github/copilot",

  install: async (ctx) => {
    const m = ctx.manifest;
    const repo = pluginRepo(m);
    const bin = which("copilot");

    // Fallback when the copilot CLI is unavailable: declarative
    // enabledPlugins entry in ~/.copilot/settings.json.
    if (bin === null) {
      const file = copilotSettingsFile(ctx.home);
      if (ctx.dryRun) {
        return {
          status: "ok",
          detail: `[dry-run] would add "${repo}" to ${COPILOT_ENABLED_PLUGINS_KEY} in ${file} (copilot CLI not found)`,
        };
      }
      const loaded = readJsonConfig(file);
      if ("manual" in loaded) {
        return {
          status: "manual",
          detail: `cannot modify ${file}: ${loaded.manual}. Manual: run \`copilot plugin install ${repo}\`.`,
        };
      }
      if ("missing" in loaded) {
        mkdirSync(join(file, ".."), { recursive: true });
        writeTextFile(file, JSON.stringify({ [COPILOT_ENABLED_PLUGINS_KEY]: [repo] }, null, 2) + "\n");
        return {
          status: "ok",
          detail: `wrote ${file} with "${repo}" (copilot CLI not found; restart Copilot to load it)`,
        };
      }
      if (copilotEntryPresent(loaded.data, repo)) {
        return { status: "ok", detail: `already present in ${file} — idempotent, no change` };
      }
      // Copilot's real schema is an object ({ "name@marketplace": true }) on
      // some builds — never clobber a non-array enabledPlugins; fall back to
      // guidance instead.
      const existing = loaded.data[COPILOT_ENABLED_PLUGINS_KEY];
      if (existing !== undefined && !Array.isArray(existing)) {
        return {
          status: "manual",
          detail:
            `"${COPILOT_ENABLED_PLUGINS_KEY}" in ${file} is ${typeof existing}, not an array of plugin refs — left untouched. ` +
            `Manual: add "${repo}" to it, or run \`copilot plugin install ${repo}\`.`,
        };
      }
      (loaded.data[COPILOT_ENABLED_PLUGINS_KEY] as unknown[]) ??= [];
      (loaded.data[COPILOT_ENABLED_PLUGINS_KEY] as unknown[]).push(repo);
      const backup = backupFile(file);
      writeTextFile(file, JSON.stringify(loaded.data, null, 2) + "\n");
      return {
        status: "ok",
        detail: `added "${repo}" to ${file}${backup ? ` (backup: ${backup})` : ""} (copilot CLI not found)`,
      };
    }

    const installCmd = `copilot plugin install ${repo} && copilot plugin marketplace add ${repo}`;
    if (ctx.dryRun) {
      return { status: "ok", detail: `[dry-run] would run: ${installCmd}` };
    }
    const list = await runCli(bin, ["plugin", "list"]);
    if (list.code === 0 && list.stdout.includes(repo)) {
      return { status: "ok", detail: `already installed (${bin} plugin list) — idempotent, no change` };
    }
    const install = await runCli(bin, ["plugin", "install", repo]);
    if (install.code !== 0) {
      return {
        status: "error",
        detail: `copilot plugin install failed: ${trimErr(install.stderr || install.stdout)}`,
      };
    }
    const marketplace = await runCli(bin, ["plugin", "marketplace", "add", repo]);
    const extra =
      marketplace.code === 0
        ? "marketplace registered"
        : `marketplace add failed (warning): ${trimErr(marketplace.stderr || marketplace.stdout)}`;
    return { status: "ok", detail: `installed via ${bin}; ${extra}. Verify with \`copilot plugin list\`.` };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    const bin = which("copilot");
    // Install writes the repo URL (pluginRepo), so uninstall must match that
    // identity — filtering on the scoped npm name (@scope/name) would never
    // match the URL and the entry would survive uninstall.
    const repo = pluginRepo(m);
    if (bin === null) {
      notes.push("copilot CLI not found (skipping CLI uninstall)");
    } else if (ctx.dryRun) {
      notes.push(`[dry-run] would run: copilot plugin uninstall ${repo}`);
    } else {
      const r = await runCli(bin, ["plugin", "uninstall", repo]);
      notes.push(
        r.code === 0
          ? "uninstalled via copilot CLI"
          : `copilot plugin uninstall failed: ${trimErr(r.stderr || r.stdout)}`,
      );
    }

    const file = copilotSettingsFile(ctx.home);
    const loaded = readJsonConfig(file);
    if ("missing" in loaded) {
      notes.push(`no ${file} — nothing to clean`);
    } else if ("manual" in loaded) {
      notes.push(`${file} invalid JSON — left untouched`);
    } else {
      const removed = copilotEntryRemoved(loaded.data, repo);
      if (removed === 0) {
        notes.push(`no ${m.name} entries in ${file}`);
      } else if (ctx.dryRun) {
        notes.push(`[dry-run] would remove ${removed} enabledPlugins entr(y/ies) from ${file}`);
      } else {
        const backup = backupFile(file);
        writeTextFile(file, JSON.stringify(loaded.data, null, 2) + "\n");
        notes.push(`removed ${removed} enabledPlugins entr(y/ies) from ${file}${backup ? ` (backup: ${backup})` : ""}`);
      }
    }
    return { status: "ok", detail: notes.join("; ") };
  },
};

// ---------------------------------------------------------------- cursor

export const cursorAdapter: TargetAdapter = {
  id: "cursor",
  kind: "plugin",
  label: "Cursor",
  scope: "global",
  detect: dirDetector((home) => join(home, ".cursor")),
  manualHint: "the Cursor IDE — cursor.com",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const dest = join(ctx.home, ".cursor", "plugins", "local", m.markers.cursorDir);
    if (!existsSync(join(ctx.home, ".cursor"))) {
      return {
        status: "manual",
        detail: `Cursor not detected (~/.cursor missing). Manual: copy ${mat.dir} to ${dest} and restart Cursor (Developer: Reload Window).`,
      };
    }
    if (ctx.dryRun) {
      return {
        status: "ok",
        detail: `[dry-run] would copy plugin dir to ${dest} and write ${m.markers.cursorMarkerFile}`,
      };
    }
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(mat.dir, dest, { recursive: true, force: true });
    writeTextFile(join(dest, m.markers.cursorMarkerFile), `${m.markers.cursorMarker}\n`);
    return {
      status: "ok",
      detail: `copied plugin to ${dest}. Restart Cursor or run "Developer: Reload Window" to load it.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const dest = join(ctx.home, ".cursor", "plugins", "local", m.markers.cursorDir);
    const marker = join(dest, m.markers.cursorMarkerFile);
    if (!existsSync(dest)) {
      return { status: "ok", detail: `not present: ${dest} — nothing to remove` };
    }
    if (!existsSync(marker)) {
      return {
        status: "skipped",
        detail: `${dest} exists without our marker (${m.markers.cursorMarkerFile}) — user-authored, kept`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: `[dry-run] would delete ${dest} (marker present)` };
    }
    rmSync(dest, { recursive: true, force: true });
    return { status: "ok", detail: `removed ${dest}` };
  },
};

// ---------------------------------------------------------------- vscode

const VSCODE_CHAT_KEY = "chat";
const VSCODE_PLUGIN_LOCATIONS_KEY = "pluginLocations";

/** Get or create the chat.pluginLocations object (attaches it to `data`
 *  when absent). Returns null when chat/pluginLocations exist with a
 *  non-object type — a user-authored schema violation we never clobber. */
function vscodeLocations(data: Record<string, unknown>): Record<string, unknown> | null {
  const chatRaw = data[VSCODE_CHAT_KEY];
  if (chatRaw !== undefined && (typeof chatRaw !== "object" || Array.isArray(chatRaw))) return null;
  const chat = (chatRaw as Record<string, unknown> | undefined) ?? {};
  const plRaw = chat[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (plRaw !== undefined && (typeof plRaw !== "object" || Array.isArray(plRaw))) return null;
  const pl = (plRaw as Record<string, unknown> | undefined) ?? {};
  chat[VSCODE_PLUGIN_LOCATIONS_KEY] = pl;
  data[VSCODE_CHAT_KEY] = chat;
  return pl;
}

/** Remove our chat.pluginLocations entries (key contains configDir — the
 *  marker); returns how many were removed. Also drops the empty chat/
 *  pluginLocations containers once nothing is left inside. */
function vscodeLocationsRemoved(data: Record<string, unknown>, configDir: string): number {
  const chat = data[VSCODE_CHAT_KEY];
  if (typeof chat !== "object" || chat === null || Array.isArray(chat)) return 0;
  const chatObj = chat as Record<string, unknown>;
  const pl = chatObj[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (typeof pl !== "object" || pl === null || Array.isArray(pl)) return 0;
  const locations = pl as Record<string, unknown>;
  let removed = 0;
  for (const key of Object.keys(locations)) {
    if (key.includes(configDir)) {
      delete locations[key];
      removed++;
    }
  }
  if (removed === 0) return 0;
  if (Object.keys(locations).length === 0) delete chatObj[VSCODE_PLUGIN_LOCATIONS_KEY];
  if (Object.keys(chatObj).length === 0) delete data[VSCODE_CHAT_KEY];
  return removed;
}

export const vscodeAdapter: TargetAdapter = {
  id: "vscode",
  kind: "plugin",
  label: "VS Code",
  scope: "global",
  detect: (ctx) => {
    if (which("code") !== null) return true;
    return existsSync(join(vscodeUserSettingsPath(ctx.home), ".."));
  },
  manualHint: "code.visualstudio.com — install the `code` CLI (Command Palette → Shell Command: Install 'code' command in PATH)",

  install: async (ctx) => {
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const file = vscodeUserSettingsPath(ctx.home);
    const dir = mat.dir;
    if (!existsSync(join(file, ".."))) {
      return {
        status: "manual",
        detail: `VS Code not detected (no \`code\` CLI and no user settings dir). Manual: open the VS Code settings (JSON) and add "chat.pluginLocations": { "${dir}": true }, then reload the window.`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: `[dry-run] would set chat.pluginLocations["${dir}"] = true in ${file}` };
    }
    const loaded = readJsonConfig(file);
    if ("missing" in loaded) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeTextFile(file, JSON.stringify({ chat: { pluginLocations: { [dir]: true } } }, null, 2) + "\n");
      return {
        status: "ok",
        detail: `wrote ${file} with chat.pluginLocations["${dir}"] = true (restart VS Code or run "Developer: Reload Window")`,
      };
    }
    if ("manual" in loaded) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: ${loaded.manual}. Manual: add "chat.pluginLocations": { "${dir}": true } to your VS Code settings.`,
      };
    }
    const locations = vscodeLocations(loaded.data);
    if (locations === null) {
      return {
        status: "manual",
        detail: `cannot modify ${file}: "chat" or "chat.pluginLocations" is not a JSON object — left untouched. Manual: add "chat.pluginLocations": { "${dir}": true } to your VS Code settings.`,
      };
    }
    if (locations[dir] !== undefined) {
      return { status: "ok", detail: `already present in ${file} — idempotent, no change` };
    }
    locations[dir] = true;
    const backup = backupFile(file);
    writeTextFile(file, JSON.stringify(loaded.data, null, 2) + "\n");
    return {
      status: "ok",
      detail: `set chat.pluginLocations["${dir}"] = true in ${file}${backup ? ` (backup: ${backup})` : ""} (restart VS Code or run "Developer: Reload Window")`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const file = vscodeUserSettingsPath(ctx.home);
    const loaded = readJsonConfig(file);
    if ("missing" in loaded) {
      return { status: "ok", detail: `no ${file} — nothing to clean` };
    }
    if ("manual" in loaded) {
      return { status: "ok", detail: `${file} invalid JSON — left untouched` };
    }
    const removed = vscodeLocationsRemoved(loaded.data, m.markers.configDir);
    if (removed === 0) {
      return { status: "ok", detail: `no chat.pluginLocations entries for us in ${file}` };
    }
    if (ctx.dryRun) {
      return {
        status: "ok",
        detail: `[dry-run] would remove ${removed} chat.pluginLocations entr${removed === 1 ? "y" : "ies"} from ${file}`,
      };
    }
    const backup = backupFile(file);
    writeTextFile(file, JSON.stringify(loaded.data, null, 2) + "\n");
    return {
      status: "ok",
      detail: `removed ${removed} chat.pluginLocations entr${removed === 1 ? "y" : "ies"} from ${file}${backup ? ` (backup: ${backup})` : ""}`,
    };
  },
};

// ---------------------------------------------------------------- chatgpt-codex

// ChatGPT & Codex load the same marketplace model as the codex CLI. Codex
// discovers marketplace manifests under <root>/.agents/plugins/
// marketplace.json, so the installer maintains a LOCAL marketplace shim
// OUTSIDE the materialized dir: ~/.<configDir>/marketplace/, which carries a
// copy of the plugin. The materialized dir keeps exactly its 4 spec entries.
export const chatgptCodexAdapter: TargetAdapter = {
  id: "chatgpt-codex",
  kind: "plugin",
  label: "ChatGPT & Codex",
  scope: "global",
  detect: cliDetector("codex"),
  manualHint: "install the codex CLI (npm i -g @openai/codex) or use the ChatGPT desktop app",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const bin = which("codex");
    const shimRoot = codexMarketplaceDir(m, ctx.home);
    const pluginRef = `${m.name}@${m.name}`;
    // Write the local marketplace shim BEFORE the CLI check: the manual path
    // (ChatGPT desktop app, no codex CLI) points the user at shimRoot, so the
    // marketplace dir must exist for those instructions to be actionable.
    const shim = writeCodexMarketplaceShim(ctx, mat.dir, shimRoot);
    if (bin === null) {
      return {
        status: "manual",
        detail:
          `codex CLI not found; marketplace shim written to ${shimRoot}. Manual: in the ChatGPT desktop app (or Codex) add the local marketplace ${shimRoot} and install the "${m.name}" plugin from it — ` +
          `or run \`codex plugin marketplace add ${shimRoot}\` and \`codex plugin add ${pluginRef}\`.`,
      };
    }
    if (ctx.dryRun) {
      return {
        status: "ok",
        detail: `[dry-run] would write the local marketplace shim (${shimRoot}/.agents/plugins/marketplace.json + plugin copy) and run: codex plugin marketplace add ${shimRoot} && codex plugin add ${pluginRef}`,
      };
    }
    const list = await runCli(bin, ["plugin", "list"]);
    if (list.code === 0 && list.stdout.includes(m.name)) {
      return {
        status: "ok",
        detail: `already installed (${bin} plugin list) — idempotent, no change; marketplace shim refreshed at ${shim?.manifest}`,
      };
    }
    const addMkt = await runCli(bin, ["plugin", "marketplace", "add", shimRoot]);
    if (addMkt.code !== 0) {
      return {
        status: "error",
        detail: `codex plugin marketplace add failed: ${trimErr(addMkt.stderr || addMkt.stdout)}. Manual: \`codex plugin marketplace add ${shimRoot}\` then \`codex plugin add ${pluginRef}\`.`,
      };
    }
    const add = await runCli(bin, ["plugin", "add", pluginRef]);
    if (add.code !== 0) {
      return {
        status: "error",
        detail: `codex plugin add failed: ${trimErr(add.stderr || add.stdout)}. Manual: \`codex plugin add ${pluginRef}\`.`,
      };
    }
    return {
      status: "ok",
      detail: `installed via ${bin} (marketplace ${shimRoot} + ${pluginRef}). Start a new Codex thread (or ChatGPT session) to load the skill and MCP tools.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const notes: string[] = [];
    const pluginRef = `${m.name}@${m.name}`;
    const bin = which("codex");
    if (bin === null) {
      notes.push("codex CLI not found (skipping CLI uninstall)");
    } else if (ctx.dryRun) {
      notes.push(`[dry-run] would run: codex plugin remove ${pluginRef}`);
    } else {
      const r = await runCli(bin, ["plugin", "remove", pluginRef]);
      notes.push(
        r.code === 0
          ? `removed via codex CLI (${pluginRef})`
          : `codex plugin remove failed: ${trimErr(r.stderr || r.stdout)} — remove it in the ChatGPT/Codex plugins UI`,
      );
    }
    notes.push(`marketplace registration + shim (${codexMarketplaceDir(m, ctx.home)}) kept — harmless; re-run install to refresh`);
    return { status: "ok", detail: notes.join("; ") };
  },
};

/** Write the local marketplace shim (manifest + plugin copy) OUTSIDE the
 *  materialized dir. Returns null when dry-running (nothing on disk). */
function writeCodexMarketplaceShim(
  ctx: InstallContext,
  pluginDirPath: string,
  shimRoot: string,
): { manifest: string } | null {
  if (ctx.dryRun) return null;
  const manifestPath = join(shimRoot, ".agents", "plugins", "marketplace.json");
  const copyDest = join(shimRoot, "plugin");
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  cpSync(pluginDirPath, copyDest, { recursive: true, force: true });
  writeTextFile(
    manifestPath,
    JSON.stringify(
      {
        name: ctx.manifest.name,
        owner: { name: ctx.manifest.githubSlug?.split("/")[0] ?? "" },
        plugins: [
          {
            name: ctx.manifest.name,
            source: { source: "local", path: "./plugin" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "development",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return { manifest: manifestPath };
}

// ---------------------------------------------------------------- grok

// Grok Bot / Grok Build: the `grok` CLI is the automation surface.
// `grok plugin install <dir> --trust` takes the materialized dir directly.
export const grokAdapter: TargetAdapter = {
  id: "grok",
  kind: "plugin",
  label: "Grok Bot",
  scope: "global",
  detect: cliDetector("grok"),
  manualHint: "the Grok desktop app (no CLI on PATH)",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const bin = which("grok");
    if (bin === null) {
      return {
        status: "manual",
        detail:
          `grok CLI not found. Manual: copy ${mat.dir} to ~/.grok/plugins/${m.name} (auto-trusted) and start a new session, ` +
          `or install it with \`grok plugin install ${mat.dir} --trust\`. Our shipped .mcp.json matches Grok's dot-prefixed MCP convention; ` +
          `verify MCP tools with \`grok inspect\` after installing (whether Grok also reads the spec mcp.json is not confirmed).`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: `[dry-run] would run: grok plugin install ${mat.dir} --trust` };
    }
    const list = await runCli(bin, ["plugin", "list"]);
    if (list.code === 0 && list.stdout.includes(m.name)) {
      return { status: "ok", detail: `already installed (${bin} plugin list) — idempotent, no change` };
    }
    const install = await runCli(bin, ["plugin", "install", mat.dir, "--trust"]);
    if (install.code !== 0) {
      return {
        status: "error",
        detail: `grok plugin install failed: ${trimErr(install.stderr || install.stdout)}. Manual: \`grok plugin install ${mat.dir} --trust\`.`,
      };
    }
    return {
      status: "ok",
      detail: `installed via ${bin} (trusted). Plugins load after pressing r in the Plugins tab or in a new session; verify MCP tools with \`grok inspect\`.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const bin = which("grok");
    if (bin === null) {
      return {
        status: "manual",
        detail: `grok CLI not found. Manual: run \`grok plugin uninstall ${m.name}\` (or remove ~/.grok/plugins/${m.name}).`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: "[dry-run] would run: grok plugin uninstall <name> --confirm" };
    }
    const r = await runCli(bin, ["plugin", "uninstall", m.name, "--confirm"]);
    if (r.code === 0) {
      return { status: "ok", detail: "uninstalled via grok CLI" };
    }
    return {
      status: "error",
      detail: `grok plugin uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`grok plugin uninstall ${m.name}\`.`,
    };
  },
};

// ---------------------------------------------------------------- nanoclaw

// NanoClaw stamps plugins as agent "templates" from a local templates dir
// (NANOCLAW_TEMPLATES_DIR, default ~/.<configDir>/nanoclaw-templates/) via
// `ncl groups create --template <ref> --name "<name>"`. NanoClaw REJECTS
// symlinks (full-tree lstat walk), so the installer always copies, never
// links. Stamping does not wire a channel; tasks start paused. There is no
// plugin uninstall — removal is manual (delete the stamped group).
const NANOCLAW_TEMPLATES_ENV = "NANOCLAW_TEMPLATES_DIR";

export const nanoclawAdapter: TargetAdapter = {
  id: "nanoclaw",
  kind: "plugin",
  label: "NanoClaw",
  scope: "global",
  detect: cliDetector("ncl"),
  manualHint: "install the NanoClaw CLI (ncl) — nanoclaw.app",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const bin = which("ncl");
    const templatesDir = nanoclawTemplatesDir(m, ctx.home, process.env);
    const templateDest = join(templatesDir, m.name);
    const stamp = `ncl groups create --template ${m.name} --name "${m.brand}"`;
    if (bin === null) {
      return {
        status: "manual",
        detail:
          `ncl CLI not found. Manual: copy ${mat.dir} to ${templateDest} (NanoClaw rejects symlinks — always copy), ` +
          `then stamp it with \`${stamp}\` (set NANOCLAW_TEMPLATES_DIR=${templatesDir} if you keep the template outside your project templates/ dir).`,
      };
    }
    if (ctx.dryRun) {
      return {
        status: "ok",
        detail: `[dry-run] would copy the plugin to ${templateDest} and run: ${stamp} (with NANOCLAW_TEMPLATES_DIR=${templatesDir})`,
      };
    }
    mkdirSync(templatesDir, { recursive: true });
    cpSync(mat.dir, templateDest, { recursive: true, force: true });
    const stampEnv = { ...process.env, [NANOCLAW_TEMPLATES_ENV]: templatesDir };
    const r = await runCli(bin, ["groups", "create", "--template", m.name, "--name", m.brand], {
      env: stampEnv,
    });
    if (r.code !== 0) {
      return {
        status: "error",
        detail: `ncl groups create failed: ${trimErr(r.stderr || r.stdout)}. Manual: ${stamp}`,
      };
    }
    const extra = process.env[NANOCLAW_TEMPLATES_ENV]
      ? `template copied to your NANOCLAW_TEMPLATES_DIR (${templatesDir})`
      : `template copied to ${templateDest} — keep NANOCLAW_TEMPLATES_DIR=${templatesDir} set (or move it into your project templates/ dir)`;
    return {
      status: "ok",
      detail: `stamped via ${bin}: ${stamp}. ${extra}. Wire a channel with \`ncl wirings create\`; tasks start paused.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    return {
      status: "manual",
      detail:
        `NanoClaw has no plugin uninstall. Manual: delete the stamped group in the NanoClaw app (or restamp with \`ncl groups create --template ${m.name} --yes\` + \`ncl groups restart --id <group-id>\`). ` +
        `The template copy (${join(nanoclawTemplatesDir(m, ctx.home, process.env), m.name)}) stays unless you pass --purge-config.`,
    };
  },
};

// ---------------------------------------------------------------- other

// Generic "other spec-compliant agent": materialize + guidance only. The
// portable contract is "a directory with plugin.json at its root" — anything
// a client does beyond that is client-specific.
export const otherAdapter: TargetAdapter = {
  id: "other",
  kind: "plugin",
  label: "Other agents (Agent Plugins open standard)",
  scope: "global",
  detect: () => "manual",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const repo = pluginRepo(m);
    const tools = toolNames(m);
    return {
      status: "manual",
      detail:
        `Manual: install the plugin directory (${mat.dir}) or the repo (${repo}) in your agent per its plugin docs. ` +
        `Enable/trust the plugin if your agent requires it, restart the agent or start a new session, then verify the "${m.markers.skillDir}" skill ` +
        `(may appear namespaced, e.g. ${m.name}:${m.markers.skillDir}) or the ${tools} MCP tools. ` +
        `Same standard: agent-plugins.org/specification.`,
    };
  },

  uninstall: async (ctx) => {
    return {
      status: "manual",
      detail:
        `Manual: uninstall the plugin in your agent (uninstall plugin / remove marketplace entry / delete the local dir). ` +
        `The materialized dir (${pluginDir(ctx.manifest, ctx.home)}) is kept unless you pass --purge-config.`,
    };
  },
};

// ---------------------------------------------------------------- kiro

export const kiroAdapter: TargetAdapter = {
  id: "kiro",
  kind: "plugin",
  label: "Kiro",
  scope: "global",
  detect: () => "manual",
  manualHint: "the Kiro IDE — kiro.dev",

  install: async (ctx) => {
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    return {
      status: "manual",
      detail: `Kiro has no CLI automation surface. Manual: Kiro → Powers panel → Add Custom Power → Import power from a folder → select ${mat.dir}.`,
    };
  },

  uninstall: async (ctx) => {
    return {
      status: "manual",
      detail: `Manual: Kiro → Powers panel → find the power → remove it (imported from ${pluginDir(ctx.manifest, ctx.home)}).`,
    };
  },
};

// ---------------------------------------------------------------- openclaw

export const openclawAdapter: TargetAdapter = {
  id: "openclaw",
  kind: "plugin",
  label: "OpenClaw",
  scope: "global",
  detect: cliDetector("openclaw"),
  manualHint: "npm i -g openclaw",

  install: async (ctx) => {
    const m = ctx.manifest;
    const mat = pluginMaterialize(ctx);
    if ("missing" in mat) {
      return { status: "error", detail: `missing package files: ${mat.missing.join(", ")}` };
    }
    const bin = which("openclaw");
    if (bin === null) {
      return {
        status: "manual",
        detail: `OpenClaw CLI not found on PATH. Manual: \`openclaw plugins install ${mat.dir}\` then \`openclaw gateway restart\`.`,
      };
    }
    if (ctx.dryRun) {
      return {
        status: "ok",
        detail: `[dry-run] would run: openclaw plugins install ${mat.dir} && openclaw gateway restart`,
      };
    }
    const list = await runCli(bin, ["plugins", "list"]);
    if (list.code === 0 && list.stdout.includes(m.name)) {
      return { status: "ok", detail: `already installed (${bin} plugins list) — idempotent, no change` };
    }
    const install = await runCli(bin, ["plugins", "install", mat.dir]);
    if (install.code !== 0) {
      return {
        status: "error",
        detail: `openclaw plugins install failed: ${trimErr(install.stderr || install.stdout)}`,
      };
    }
    const restart = await runCli(bin, ["gateway", "restart"]);
    const extra =
      restart.code === 0
        ? "gateway restarted"
        : `gateway restart failed (warning): ${trimErr(restart.stderr || restart.stdout)} — run \`openclaw gateway restart\` manually`;
    return {
      status: "ok",
      detail: `installed via ${bin}; ${extra}. Verify with \`openclaw plugins list\`.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const bin = which("openclaw");
    if (bin === null) {
      return {
        status: "manual",
        detail: `OpenClaw CLI not found on PATH. Manual: run \`openclaw plugins uninstall ${m.name}\`.`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: "[dry-run] would run: openclaw plugins uninstall <name>" };
    }
    const r = await runCli(bin, ["plugins", "uninstall", m.name]);
    if (r.code === 0) {
      return { status: "ok", detail: "uninstalled via openclaw CLI" };
    }
    return {
      status: "error",
      detail: `openclaw plugins uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`openclaw plugins uninstall ${m.name}\`.`,
    };
  },
};

// ---------------------------------------------------------------- hermes

export const hermesAdapter: TargetAdapter = {
  id: "hermes",
  kind: "plugin",
  label: "Hermes Agent",
  scope: "global",
  detect: cliDetector("hermes"),
  manualHint: "npm i -g hermes-agent",

  install: async (ctx) => {
    const m = ctx.manifest;
    const slug = m.githubSlug ?? m.name;
    const bin = which("hermes");
    if (bin === null) {
      return {
        status: "manual",
        detail: `Hermes CLI not found on PATH. Manual: \`hermes plugins install ${slug} --no-enable\` then \`hermes plugins enable ${m.name}\`.`,
      };
    }
    const commands = [
      `hermes plugins install ${slug} --no-enable`,
      `hermes plugins enable ${m.name}`,
    ];
    if (ctx.dryRun) {
      return { status: "ok", detail: `[dry-run] would run: ${commands.join(" && ")}` };
    }
    const list = await runCli(bin, ["plugins", "list"]);
    if (list.code === 0 && list.stdout.includes(m.name)) {
      const enable = await runCli(bin, ["plugins", "enable", m.name]);
      const extra = enable.code === 0 ? "enabled" : `enable failed (warning): ${trimErr(enable.stderr || enable.stdout)}`;
      return { status: "ok", detail: `already installed (${bin} plugins list) — re-enabled, ${extra}` };
    }
    const install = await runCli(bin, ["plugins", "install", slug, "--no-enable"]);
    if (install.code !== 0) {
      return {
        status: "error",
        detail: `hermes plugins install failed: ${trimErr(install.stderr || install.stdout)}`,
      };
    }
    const enable = await runCli(bin, ["plugins", "enable", m.name]);
    const extra =
      enable.code === 0
        ? "enabled"
        : `enable failed (warning): ${trimErr(enable.stderr || enable.stdout)} — run \`hermes plugins enable ${m.name}\` manually`;
    return {
      status: "ok",
      detail: `installed via ${bin}; ${extra}. Verify with \`hermes plugins list\`.`,
    };
  },

  uninstall: async (ctx) => {
    const m = ctx.manifest;
    const bin = which("hermes");
    if (bin === null) {
      return {
        status: "manual",
        detail: `Hermes CLI not found on PATH. Manual: run \`hermes plugins uninstall ${m.name}\`.`,
      };
    }
    if (ctx.dryRun) {
      return { status: "ok", detail: "[dry-run] would run: hermes plugins uninstall <name>" };
    }
    const r = await runCli(bin, ["plugins", "uninstall", m.name]);
    if (r.code === 0) {
      return { status: "ok", detail: "uninstalled via hermes CLI" };
    }
    return {
      status: "error",
      detail: `hermes plugins uninstall failed: ${trimErr(r.stderr || r.stdout)}. Manual: \`hermes plugins uninstall ${m.name}\`.`,
    };
  },
};

// ---------------------------------------------------------------- helpers

/** First line of stderr/stdout, truncated — the failure surface of a CLI
 *  registration is its error message, not the full transcript. */
function trimErr(s: string): string {
  const t = s.trim();
  const line = t.split(/\r?\n/)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
