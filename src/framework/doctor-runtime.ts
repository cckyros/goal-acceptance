// doctor framework: prints the resolved config (masked secrets) and runs the
// business layer's doctor checks. Exit semantics: any check problem → exit 1.
import { resolveConfig, maskValue, humanBytes } from "./config.ts";
import type { PluginManifest } from "./manifest.ts";

export interface DoctorReport {
  ok: boolean;
  lines: string[];
}

export interface DoctorOptions {
  cwd?: string;
}

/** Render the config summary + run manifest.doctorChecks. */
export async function runDoctor(manifest: PluginManifest, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd();
  const cfg = resolveConfig(manifest, cwd);
  const lines: string[] = [];

  lines.push(`[${manifest.name}] doctor`);
  for (const field of manifest.config) {
    const v = cfg.values[field.key];
    const shown =
      v === undefined || v === ""
        ? "(not set)"
        : field.mask
          ? maskValue(String(v))
          : field.type === "boolean" || field.type === "number"
            ? String(v)
            : String(v);
    lines.push(`  ${field.key}: ${shown}  [${cfg.sources[field.key] ?? "unset"}]`);
  }

  const checks = manifest.doctorChecks ?? [];
  for (const check of checks) {
    try {
      const problems = await check.run(cfg.values);
      if (problems.length === 0) {
        lines.push(`  [OK] ${check.label}`);
      } else {
        lines.push(`  [ERROR] ${check.label}`);
        for (const p of problems) lines.push(`    - ${p}`);
      }
    } catch (e) {
      lines.push(`  [ERROR] ${check.label}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ok = no [ERROR] line; config fields that are simply unset are reported
  // but only fail when a business check says so.
  const ok = lines.every((l) => !l.startsWith("  [ERROR]"));
  return { ok, lines };
}

export { maskValue, humanBytes };
