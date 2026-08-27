// Shared helpers for the Agent Plugins portable-package target adapters
// (plugin-agents.ts). Ported from deepseek-vl-support plugin.ts:
//  - materializePlugin: copy the 6 package entries (plugin.json, mcp.json,
//    .mcp.json, skills/, openclaw.plugin.json, openclaw-dist/) from the
//    package root into the global ~/.<configDir>/plugin/ dir. The 10 clients
//    share ONE materialized copy, so a per-process guard makes the first
//    adapter that needs it do the copy and the rest reuse it — the same
//    single-materialization semantics as the original installer.
//  - runCli: spawn a resolved CLI with win32 .cmd/.bat shim handling (Node
//    cannot exec .cmd directly — EINVAL — so those go through cmd.exe with a
//    quoted command line, per the Agent Plugins spec §7.2.1)
//  - detectors: PATH probe (CLI clients) and config-dir probe (GUI clients)
//  - platform home helpers: VS Code user settings path, codex marketplace
//    shim root, nanoclaw templates dir
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../../framework/manifest.ts";
import type { DetectStatus, InstallContext } from "../../framework/registry.ts";
import { which } from "../../framework/registry.ts";
import { packageRoot, pluginDir } from "../../framework/paths.ts";

// ---------------------------------------------------------------- materialize

// .mcp.json: Copilot's native MCP convention (byte-identical to mcp.json,
// build-synced). openclaw.plugin.json + openclaw-dist/ extend the portable
// package with the native OpenClaw path (deviation #1 in design.md §7). The
// materialized dir keeps exactly these 6 entries; client-specific shims
// (e.g. the codex local marketplace) live OUTSIDE it.
const PLUGIN_PACKAGE_FILES = [
  "plugin.json",
  "mcp.json",
  ".mcp.json",
  "skills",
  "openclaw.plugin.json",
  "openclaw-dist",
] as const;

const materializedDirs = new Set<string>();

export function pluginMaterialize(
  ctx: InstallContext,
): { dir: string } | { missing: string[] } {
  const m = ctx.manifest;
  const destRoot = pluginDir(m, ctx.home);
  if (materializedDirs.has(destRoot)) return { dir: destRoot };
  const srcRoot = packageRoot();
  const missing: string[] = [];
  for (const rel of PLUGIN_PACKAGE_FILES) {
    if (!existsSync(join(srcRoot, rel))) missing.push(join(srcRoot, rel));
  }
  if (missing.length) return { missing };
  if (ctx.dryRun) {
    ctx.log(`[dry-run] materialize plugin dir -> ${destRoot} (plugin.json + mcp.json + .mcp.json + skills/ + openclaw.plugin.json + openclaw-dist/)`);
  } else {
    mkdirSync(destRoot, { recursive: true });
    for (const rel of PLUGIN_PACKAGE_FILES) {
      cpSync(join(srcRoot, rel), join(destRoot, rel), { recursive: true, force: true });
    }
  }
  materializedDirs.add(destRoot);
  return { dir: destRoot };
}

// ---------------------------------------------------------------- run CLI

export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** First line of stderr/stdout, truncated — the failure surface of a CLI
 *  registration is its error message, not the full transcript. */
function trimErr(s: string): string {
  const t = s.trim();
  const line = t.split(/\r?\n/)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Quote an argument for the Windows cmd.exe command line: wrap in double
 *  quotes with embedded quotes doubled. Backslashes stay literal (cmd does
 *  not process them; JSON-style \\ escaping would corrupt Windows paths). */
function winQuote(a: string): string {
  return `"${a.replace(/"/g, '""')}"`;
}

/** Run a command with a timeout, capturing stdout/stderr. Never throws.
 *  On Windows, .cmd/.bat shims are launched through the platform command
 *  interpreter (per the Agent Plugins spec §7.2.1 a .bat/.cmd wrapper may
 *  require one): Node cannot exec .cmd directly on some builds (EINVAL), so
 *  the fully quoted command string goes through shell:true, which invokes
 *  cmd.exe with the correct wrapping. */
export function runCli(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CmdResult> {
  return new Promise((resolve) => {
    let cmd: string;
    let argv: string[];
    let shell: boolean;
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
      cmd = `"${bin}"${args.map((a) => ` ${winQuote(a)}`).join("")}`;
      argv = [];
      shell = true;
    } else {
      cmd = bin;
      argv = args;
      shell = false;
    }
    const child = spawn(cmd, argv, {
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 30_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message ?? String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- detection

/** PATH-probe detector for clients whose CLI is the automation surface. */
export function cliDetector(bin: string): (ctx: InstallContext) => DetectStatus {
  return () => which(bin) !== null;
}

/** Config-dir probe for GUI clients without a CLI surface (Cursor, Kiro). */
export function dirDetector(dirOf: (home: string) => string): (ctx: InstallContext) => DetectStatus {
  return (ctx) => existsSync(dirOf(ctx.home));
}

// ---------------------------------------------------------------- platform paths

const VSCODE_USER_DIRS = ["Code", "Code - Insiders"];

/** User settings.json for VS Code, derived from the home dir so the
 *  installer stays hermetic and testable (on Windows homedir() already is
 *  %USERPROFILE%; APPDATA = %USERPROFILE%\AppData\Roaming). Prefers the
 *  stable "Code" dir over "Code - Insiders" when both exist. */
export function vscodeUserSettingsPath(home: string): string {
  const base = process.platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config");
  for (const name of VSCODE_USER_DIRS) {
    const dir = join(base, name, "User");
    if (existsSync(dir)) return join(dir, "settings.json");
  }
  return join(base, "Code", "User", "settings.json");
}

/** Local marketplace shim root for the codex CLI (ChatGPT & Codex share the
 *  codex plugin model): ~/.<configDir>/marketplace/. Lives OUTSIDE the
 *  materialized dir so the plugin dir keeps exactly its 4 spec entries. */
export function codexMarketplaceDir(m: PluginManifest, home: string): string {
  return join(home, m.markers.configDir, "marketplace");
}

/** NanoClaw templates dir: NANOCLAW_TEMPLATES_DIR env or
 *  ~/.<configDir>/nanoclaw-templates/. NanoClaw stamps plugins as agent
 *  templates from this dir via `ncl groups create --template <ref>`. */
export function nanoclawTemplatesDir(
  m: PluginManifest,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.NANOCLAW_TEMPLATES_DIR ?? join(home, m.markers.configDir, "nanoclaw-templates");
}

/** Plugin repo reference for install commands (copilot/hermes/marketplace):
 *  the full GitHub URL derived from the manifest's githubSlug. Falls back to
 *  the bare package name when the slug is unset (local-only scaffolds). */
export function pluginRepo(m: PluginManifest): string {
  return m.githubSlug ? `https://github.com/${m.githubSlug}` : m.name;
}

/** MCP tool names for guidance text (e.g. "describe_image / vision_status"). */
export function toolNames(m: PluginManifest): string {
  return m.tools.map((t) => t.name).join(" / ");
}
