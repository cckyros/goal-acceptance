// Target adapter contract + dispatch. One adapter per agent target; the
// registry installs/uninstalls them independently (a failing client never
// blocks the others) and aggregates per-target results.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PluginManifest } from "./manifest.ts";
import {
  backupFile,
  ensureDir,
  readTextFile,
  upsertJsonKey,
  writeTextFile,
} from "./safe-fs.ts";
import type { EditResult } from "./safe-fs.ts";

export type TargetKind = "native" | "skill" | "plugin";
export type Scope = "project" | "global" | "both";
export type DetectStatus = boolean | "manual";

export interface InstallContext {
  manifest: PluginManifest;
  /** Effective scope for this run (resolved by the wizard/CLI). */
  scope: Scope;
  /** Project directory (cwd); global installs also use it for path echoes. */
  dir: string;
  dryRun: boolean;
  nonInteractive: boolean;
  update: boolean;
  home: string;

  /** Write a managed file: marker-checked, backed up, idempotent. Accepts a
   *  project-relative path or an absolute path (global-scope installs). */
  writeManaged: (path: string, content: string, marker: string) => EditResult;
  /** Key-level upsert into a JSON config file (deep-merge, idempotent; never
   *  touches other keys). Accepts a project-relative or absolute path. */
  mergeManagedJson: (filePath: string, key: string, patch: unknown) => EditResult;
  /** Run an external command; null when the binary can't be found. */
  run: (cmd: string, args: string[]) => Promise<CommandResult | null>;
  log: (msg: string) => void;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type TargetStatus = "ok" | "manual" | "skipped" | "error";

export interface TargetResult {
  status: TargetStatus;
  detail?: string;
  manualHint?: string;
}

export interface TargetAdapter {
  id: string;
  kind: TargetKind;
  /** Pure-name label for wizard menus (no detection annotations). */
  label: string;
  scope: Scope;
  /** "manual" = no automation surface detected → guidance instead. */
  detect: (ctx: InstallContext) => DetectStatus | Promise<DetectStatus>;
  install: (ctx: InstallContext) => TargetResult | Promise<TargetResult>;
  uninstall: (ctx: InstallContext) => TargetResult | Promise<TargetResult>;
  /** Shown when the client is not detected. */
  manualHint?: string;
}

// ---------------------------------------------------------------- commands

function shimCandidates(name: string): string[] {
  // Windows npm globals create three shims per CLI (x, x.cmd, x.ps1).
  // Probe in PATHEXT order: .exe → .cmd → .bat → extensionless LAST
  // (extensionless-first breaks raw spawn on every Windows machine — 0.2.1
  // regression, see deepseek-vl-support maintenance notes).
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.ps1`, name];
}

/** Resolve a CLI to an executable path; null when not on PATH. */
export function which(name: string, paths?: string[]): string | null {
  const dirs = paths ?? (process.env.PATH ?? "").split(/[;:]/).filter(Boolean);
  for (const dir of dirs) {
    for (const cand of shimCandidates(name)) {
      const p = join(dir, cand);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Spawn a command; resolves null when the binary is missing. */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill(), opts.timeoutMs)
      : undefined;
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

// ---------------------------------------------------------------- dispatch

export interface InstallOutcome {
  id: string;
  kind: TargetKind;
  label: string;
  result: TargetResult;
}

/** Install every adapter in order; a failing target never blocks the rest. */
export async function installAll(
  adapters: TargetAdapter[],
  ctx: InstallContext,
): Promise<InstallOutcome[]> {
  const out: InstallOutcome[] = [];
  for (const a of adapters) {
    try {
      const result = await a.install(ctx);
      out.push({ id: a.id, kind: a.kind, label: a.label, result });
    } catch (e) {
      out.push({
        id: a.id,
        kind: a.kind,
        label: a.label,
        result: { status: "error", detail: e instanceof Error ? e.message : String(e) },
      });
    }
  }
  return out;
}

export async function uninstallAll(
  adapters: TargetAdapter[],
  ctx: InstallContext,
): Promise<InstallOutcome[]> {
  const out: InstallOutcome[] = [];
  for (const a of adapters) {
    try {
      const result = await a.uninstall(ctx);
      out.push({ id: a.id, kind: a.kind, label: a.label, result });
    } catch (e) {
      out.push({
        id: a.id,
        kind: a.kind,
        label: a.label,
        result: { status: "error", detail: e instanceof Error ? e.message : String(e) },
      });
    }
  }
  return out;
}

/** Which adapters are detected on this machine (used for wizard defaults). */
export async function detectAll(
  adapters: TargetAdapter[],
  ctx: InstallContext,
): Promise<Map<string, DetectStatus>> {
  const map = new Map<string, DetectStatus>();
  for (const a of adapters) {
    try {
      map.set(a.id, await a.detect(ctx));
    } catch {
      map.set(a.id, false);
    }
  }
  return map;
}

// ---------------------------------------------------------------- ctx helpers

/** Build the standard InstallContext (safe-fs wired to the project dir). */
export function makeContext(
  manifest: PluginManifest,
  opts: {
    scope: Scope;
    dir: string;
    dryRun?: boolean;
    nonInteractive?: boolean;
    update?: boolean;
    home?: string;
    log?: (msg: string) => void;
  },
): InstallContext {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((_msg: string) => {});
  const resolvePath = (p: string): string => (isAbsolute(p) ? p : join(opts.dir, p));
  const writeManaged = (path: string, content: string, marker: string): EditResult => {
    if (opts.dryRun) {
      log(`[dry-run] write ${path}`);
      return { changed: true };
    }
    const p = resolvePath(path);
    const existing = readTextFile(p);
    if (existing === null) {
      ensureDir(p);
      writeTextFile(p, content);
      return { changed: true };
    }
    if (existing.includes(marker)) {
      // Ours: back up the pre-update state, then overwrite.
      if (existing === content) return { changed: false }; // idempotent
      const backup = backupFile(p);
      ensureDir(p);
      writeTextFile(p, content);
      return { changed: true, backup };
    }
    // User-authored file without our marker — never touch it.
    return { changed: false };
  };
  const mergeManagedJson = (filePath: string, key: string, patch: unknown): EditResult => {
    if (opts.dryRun) {
      log(`[dry-run] merge ${filePath} ${key}`);
      return { changed: true };
    }
    return upsertJsonKey(resolvePath(filePath), key, patch);
  };
  return {
    manifest,
    scope: opts.scope,
    dir: opts.dir,
    dryRun: opts.dryRun ?? false,
    nonInteractive: opts.nonInteractive ?? false,
    update: opts.update ?? false,
    home,
    writeManaged,
    mergeManagedJson,
    run: (cmd, args) => runCommand(cmd, args),
    log,
  };
}
