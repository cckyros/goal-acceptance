// CLI skeleton for a scaffolded plugin. Subcommands: install / uninstall /
// doctor / config / mcp / version + business subcommands (manifest.bizCli).
// Zero-dependency hand-rolled arg parsing (deepseek-vl-support heritage).
import { join } from "node:path";
import {
  resolveConfig,
  writeConfigFile,
  configPaths,
  readConfigFile,
  readConfigValuesAt,
  globalConfigPath,
  projectConfigPath,
} from "./config.ts";
import { runDoctor } from "./doctor-runtime.ts";
import { runMcpServer } from "./mcp-runtime.ts";
import type { PluginManifest } from "./manifest.ts";
import { installAll, uninstallAll, detectAll, makeContext } from "./registry.ts";
import type { InstallContext, Scope, TargetAdapter } from "./registry.ts";
import { askInput, askMenu, askMultiMenu, askSecret } from "./wizard.ts";
import type { MenuOption } from "./wizard.ts";

export interface CliDeps {
  manifest: PluginManifest;
  adapters: TargetAdapter[];
}

interface ParsedArgs {
  flags: Map<string, string>;
  positionals: string[];
}

/** Flags that take a value; every other flag is boolean (`--json file.png`
 *  must not swallow the positional that follows it). */
const VALUE_FLAGS = new Set([
  "target",
  "preset",
  "clients",
  "dir",
  "url",
  "global",
  "scope",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, "");
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags.set(a.slice(1), "");
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

export function fail(manifest: PluginManifest, msg: string): never {
  process.stderr.write(`[${manifest.name}] error: ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------- install

function splitTargets(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveScope(manifest: PluginManifest, flags: Map<string, string>): Scope {
  const g = flags.get("global");
  if (g !== undefined) return "global";
  const s = flags.get("scope");
  if (s === "project" || s === "global" || s === "both") return s;
  return "project";
}

async function chooseTargetsInteractive(
  manifest: PluginManifest,
  adapters: TargetAdapter[],
  dir: string,
  ctx: InstallContext,
): Promise<string[]> {
  const detected = await detectAll(adapters, ctx);
  const options: MenuOption[] = adapters.map((a) => ({
    value: a.id,
    label: detected.get(a.id) === true ? a.label : detected.get(a.id) === "manual" ? `${a.label} (manual)` : a.label,
  }));
  const defaults = adapters.filter((a) => detected.get(a.id) === true).map((a) => a.id);
  return askMultiMenu({
    prompt: `Which agents should ${manifest.brand} be installed for?`,
    options,
    default: defaults.length ? defaults : undefined,
  });
}

/** Interactive config collection: preset pick (when presets exist) then
 *  per-field prompts. Returns values to write to the project config. */
async function collectConfigInteractive(
  manifest: PluginManifest,
  cwd: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const existing = readConfigFile(manifest, cwd);

  const presets = manifest.presets ?? [];
  let presetValues: Record<string, unknown> = {};
  if (presets.length) {
    const options: MenuOption[] = [
      ...presets.map((p) => ({ value: p.id, label: p.label })),
      { value: "later", label: "Decide later" },
    ];
    const pick = await askMenu({
      prompt: `Configure ${manifest.brand}'s endpoint preset?`,
      options,
      default: "later",
    });
    if (pick !== "later") {
      const preset = presets.find((p) => p.id === pick);
      if (preset) presetValues = { ...preset.values };
    }
  }

  for (const field of manifest.config) {
    if (field.wizardHidden) continue;
    const current = (presetValues[field.key] ?? existing[field.key]) as string | undefined;
    if (field.mask) {
      const v = await askSecret({
        prompt: `${field.label} (${field.env})`,
        default: current ? "***" : undefined,
        hint: field.placeholder,
      });
      if (v && v !== "***") out[field.key] = v;
    } else if (field.type === "boolean") {
      const v = await askInput({
        prompt: `${field.label} (true/false)`,
        default: current ?? String(field.default ?? "true"),
      });
      out[field.key] = v === "true";
    } else {
      const v = await askInput({
        prompt: field.label,
        default: current ?? (field.default !== undefined ? String(field.default) : undefined),
        hint: field.placeholder,
      });
      if (v !== "") out[field.key] = v;
    }
  }
  return { ...existing, ...presetValues, ...out };
}

/** Collect config values from flags: every non-hidden field accepts
 *  `--<key> <value>`; secret fields read the env var when present. */
function collectConfigFromFlags(
  manifest: PluginManifest,
  flags: Map<string, string>,
  cwd: string,
): Record<string, unknown> {
  const existing = readConfigFile(manifest, cwd);
  const out: Record<string, unknown> = { ...existing };
  for (const field of manifest.config) {
    if (field.wizardHidden) continue;
    const raw = flags.get(field.key);
    if (raw !== undefined && raw !== "") {
      switch (field.type) {
        case "number": {
          const n = Number(raw);
          out[field.key] = Number.isFinite(n) ? n : raw;
          break;
        }
        case "boolean":
          out[field.key] = raw === "true" || raw === "1";
          break;
        default:
          out[field.key] = raw;
      }
    } else if (field.mask && !(field.key in out)) {
      const envVal = process.env[field.env];
      if (envVal) out[field.key] = envVal;
    }
  }
  return out;
}

export async function runInstall(
  deps: CliDeps,
  flags: Map<string, string>,
): Promise<number> {
  const { manifest, adapters } = deps;
  const dir = flags.get("dir") ? join(flags.get("dir")!) : process.cwd();
  const scope = resolveScope(manifest, flags);
  const dryRun = flags.has("dry-run");
  const nonInteractive = flags.has("non-interactive") || !process.stdin.isTTY;
  const update = flags.has("update");

  const ctx = makeContext(manifest, {
    scope,
    dir,
    dryRun,
    nonInteractive,
    update,
    log: (msg) => process.stderr.write(msg + "\n"),
  });

  let targets = splitTargets(flags.get("target"));
  if (!targets.length) {
    if (nonInteractive) {
      const detected = await detectAll(adapters, ctx);
      targets = adapters
        .filter((a) => detected.get(a.id) === true)
        .map((a) => a.id);
      if (!targets.length) targets = [adapters[0]?.id].filter(Boolean) as string[];
    } else {
      targets = await chooseTargetsInteractive(manifest, adapters, dir, ctx);
    }
  }
  const selected = adapters.filter((a) => targets.includes(a.id));
  const unknown = targets.filter((t) => !adapters.some((a) => a.id === t));
  if (unknown.length) fail(manifest, `unknown target: ${unknown.join(", ")}`);

  // config collection (interactive or flags/env)
  if (!nonInteractive) {
    const values = await collectConfigInteractive(manifest, dir);
    if (Object.keys(values).length) writeConfigFile(manifest, dir, values);
  } else {
    const values = collectConfigFromFlags(manifest, flags, dir);
    if (Object.keys(values).length) writeConfigFile(manifest, dir, values);
  }

  process.stdout.write(
    `[${manifest.name}] installing for: ${selected.map((a) => a.label).join(", ") || "(none)"} (${scope})\n`,
  );
  const outcomes = await installAll(selected, ctx);
  for (const o of outcomes) {
    if (o.result.status === "ok") process.stdout.write(`  [OK] ${o.label}\n`);
    else if (o.result.status === "manual") {
      process.stdout.write(`  [manual] ${o.label} — ${o.result.detail ?? o.result.manualHint ?? "follow the manual steps"}\n`);
    } else if (o.result.status === "skipped") {
      process.stdout.write(`  [skipped] ${o.label} — ${o.result.detail ?? ""}\n`);
    } else {
      process.stdout.write(`  [FAIL] ${o.label} — ${o.result.detail ?? ""}\n`);
    }
  }
  if (dryRun) {
    process.stdout.write(`[${manifest.name}] dry-run — nothing written.\n`);
    return 0;
  }
  const failed = outcomes.filter((o) => o.result.status === "error").length;
  process.stdout.write(
    `[${manifest.name}] done: ${outcomes.filter((o) => o.result.status === "ok").length} ok, ` +
      `${outcomes.filter((o) => o.result.status === "manual").length} manual, ${failed} failed\n`,
  );
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------- uninstall

export async function runUninstall(
  deps: CliDeps,
  flags: Map<string, string>,
): Promise<number> {
  const { manifest, adapters } = deps;
  const dir = flags.get("dir") ? join(flags.get("dir")!) : process.cwd();
  const scope = resolveScope(manifest, flags);
  const dryRun = flags.has("dry-run");
  const purgeConfig = flags.has("purge-config");
  const nonInteractive = flags.has("non-interactive") || !process.stdin.isTTY;

  const ctx = makeContext(manifest, { scope, dir, dryRun, nonInteractive, log: (m) => process.stderr.write(m + "\n") });

  let targets = splitTargets(flags.get("target"));
  if (!targets.length) {
    targets = nonInteractive
      ? adapters.map((a) => a.id)
      : await chooseTargetsInteractive(manifest, adapters, dir, ctx);
  }
  const selected = adapters.filter((a) => targets.includes(a.id));
  const unknown = targets.filter((t) => !adapters.some((a) => a.id === t));
  if (unknown.length) fail(manifest, `unknown target: ${unknown.join(", ")}`);

  process.stdout.write(`[${manifest.name}] uninstalling for: ${selected.map((a) => a.label).join(", ") || "(none)"} (${scope})\n`);
  const outcomes = await uninstallAll(selected, ctx);
  for (const o of outcomes) {
    if (o.result.status === "ok") process.stdout.write(`  [OK] ${o.label} removed\n`);
    else if (o.result.status === "skipped") process.stdout.write(`  [skipped] ${o.label} — ${o.result.detail ?? "nothing to remove"}\n`);
    else if (o.result.status === "manual") process.stdout.write(`  [manual] ${o.label} — ${o.result.detail ?? "manual cleanup"}\n`);
    else process.stdout.write(`  [FAIL] ${o.label} — ${o.result.detail ?? ""}\n`);
  }
  if (purgeConfig) {
    if (!dryRun) {
      const { rmSync } = await import("node:fs");
      rmSync(join(dir, manifest.markers.configDir), { recursive: true, force: true });
      rmSync(join(ctx.home, manifest.markers.configDir, "plugin"), { recursive: true, force: true });
      process.stdout.write(`[${manifest.name}] config + cache purged.\n`);
    } else {
      process.stdout.write(`[dry-run] purge ${manifest.markers.configDir}\n`);
    }
  }
  return outcomes.some((o) => o.result.status === "error") ? 1 : 0;
}

// ---------------------------------------------------------------- config

async function runConfig(
  manifest: PluginManifest,
  flags: Map<string, string>,
  positionals: string[],
): Promise<number> {
  const cwd = process.cwd();
  const global = flags.has("global");
  const sub = positionals[0];
  const cfg = resolveConfig(manifest, cwd);

  if (sub === "path") {
    for (const p of configPaths(manifest, cwd)) process.stdout.write(p + "\n");
    return 0;
  }
  if (sub === "set") {
    const key = positionals[1];
    const value = positionals.slice(2).join(" ");
    const field = manifest.config.find((f) => f.key === key);
    if (!field) fail(manifest, `unknown config key: ${key} (valid: ${manifest.config.map((f) => f.key).join(", ")})`);
    const target = global ? globalConfigPath(manifest) : projectConfigPath(manifest, cwd);
    if (value === "") fail(manifest, `config set ${key} <value>`);
    let parsed: unknown = value;
    if (field.type === "number") parsed = Number(value);
    else if (field.type === "boolean") parsed = value === "true" || value === "1";
    else if (field.type === "json") {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
    }
    const prev = readConfigValuesAt(target);
    if (global) {
      const { writeFileSync, mkdirSync } = await import("node:fs");
      const next = { ...prev, [key]: parsed };
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, JSON.stringify(next, null, 2) + "\n", "utf8");
      process.stdout.write(`${target}: ${key} = ${JSON.stringify(parsed)}\n`);
      return 0;
    }
    writeConfigFile(manifest, cwd, { ...prev, [key]: parsed });
    process.stdout.write(`${key} = ${JSON.stringify(parsed)}\n`);
    return 0;
  }
  if (sub === "get" || sub === undefined) {
    const key = positionals[1];
    const source = cfg.sources[key ?? ""];
    if (key) {
      const v = cfg.values[key];
      if (v === undefined) {
        process.stdout.write(`(not set)\n`);
      } else {
        const field = manifest.config.find((f) => f.key === key);
        process.stdout.write(`${field?.mask ? maskForDisplay(String(v)) : String(v)}\n`);
      }
      return 0;
    }
    for (const field of manifest.config) {
      const v = cfg.values[field.key];
      const shown = v === undefined ? "(not set)" : field.mask ? maskForDisplay(String(v)) : String(v);
      process.stdout.write(`${field.key}: ${shown}  [${cfg.sources[field.key] ?? "unset"}]\n`);
    }
    return 0;
  }
  fail(manifest, `config subcommand: get [key] | set <key> <value> | path`);
}

function maskForDisplay(v: string): string {
  if (v.length <= 8) return "***";
  return `${v.slice(0, 3)}${"*".repeat(6)}${v.slice(-2)}`;
}

// ---------------------------------------------------------------- main

export async function runCli(deps: CliDeps, argv: string[] = process.argv.slice(2)): Promise<number> {
  const { manifest, adapters } = deps;
  const { flags, positionals } = parseArgs(argv);
  const cmd = positionals[0];

  switch (cmd) {
    case "install":
      return runInstall(deps, flags);
    case "uninstall":
      return runUninstall(deps, flags);
    case "doctor": {
      const report = await runDoctor(manifest);
      for (const l of report.lines) process.stdout.write(l + "\n");
      return report.ok ? 0 : 1;
    }
    case "config":
      return runConfig(manifest, flags, positionals.slice(1));
    case "mcp":
      await runMcpServer(manifest);
      return 0;
    case "version":
      process.stdout.write(`${manifest.version}\n`);
      return 0;
    case "help":
    case undefined:
    case "-h":
    case "--help":
      printHelp(manifest, adapters);
      return 0;
    default: {
      const biz = manifest.bizCli?.[cmd];
      if (biz) {
        await biz(positionals.slice(1), {
          log: (msg) => process.stdout.write(msg + "\n"),
          fail: (msg) => fail(manifest, msg),
        });
        return 0;
      }
      fail(manifest, `unknown command: ${cmd} (try: help)`);
    }
  }
}

function printHelp(manifest: PluginManifest, adapters: TargetAdapter[]): void {
  const lines = [
    `${manifest.name} v${manifest.version} — ${manifest.description}`,
    ``,
    `Usage:`,
    `  ${manifest.name} install [options]       Multi-agent installer (wizard)`,
    `  ${manifest.name} uninstall [options]     Remove installed artifacts`,
    `  ${manifest.name} doctor                   Diagnose the plugin setup`,
    `  ${manifest.name} config [get|set|path]    View/edit config [--global]`,
    `  ${manifest.name} mcp                      Run the MCP stdio server`,
    `  ${manifest.name} version                  Print version`,
    ...Object.keys(manifest.bizCli ?? {}).map(
      (c) => `  ${manifest.name} ${c}                        Business subcommand`,
    ),
    ``,
    `install options: --target <agent,...> --global --update --dry-run`,
    `                 --non-interactive --preset <id> --dir <project>`,
    ...manifest.config.map((f) => `                 --${f.key} <value>`),
    `uninstall options: --target <agent,...> --global --purge-config --dry-run`,
    ``,
    `Agents (--target, comma-separated):`,
    ...adapters.map((a) => `  ${a.id.padEnd(14)} ${a.label} (${a.kind})`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}
