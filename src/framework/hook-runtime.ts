// Claude Code hook runtime — the stdin/stdout protocol shell shared by every
// scaffolded plugin. Bundled by esbuild into dist/hook.cjs (zero runtime
// deps) with the business handlers from the manifest; the banner
// (`/*! <markers.hook> */`) is the identity marker uninstall checks.
//
// Contract (verified against real Claude Code in deepseek-vl-support):
//  - stdin: hook event JSON (UTF-8), stdout: ONE hook JSON payload
//  - all logging → stderr; NEVER log to stdout
//  - always exit 0 (non-zero would block the tool / kill context injection);
//    failure paths emit `{}` (no-op, tool proceeds normally)
import type { HookDef, PluginManifest } from "./manifest.ts";
import { resolveConfig } from "./config.ts";

/** Write the hook JSON payload in a single write, then exit only after the
 *  write flushed (process.exit() before flush truncates piped output).
 *  Exit naturally (process.exitCode) — on Windows a forced process.exit()
 *  after async HTTPS work asserts in libuv (UV_HANDLE_CLOSING, win/async.c).
 *  The unref'd watchdog forces an exit only if some future leak keeps the
 *  loop alive. */
function output(obj: unknown): void {
  const json = JSON.stringify(obj);
  process.stdout.write(json + "\n", () => {
    process.exitCode = 0;
  });
  const watchdog = setTimeout(() => process.exit(0), 10_000);
  watchdog.unref();
}

function noop(): void {
  output({});
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  // Release the stdin handle after EOF. Windows: a live-but-closing stdin
  // handle at process.exit() triggers a libuv assertion
  // (UV_HANDLE_CLOSING, win/async.c) — observed with real endpoints
  // (deepseek-vl-support E2E 0.1.3); localhost/mock servers do not reproduce.
  process.stdin.destroy();
  return chunks.join("");
}

function cwdOf(input: { cwd?: unknown }): string {
  return typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
}

export function log(prefix: string, msg: string): void {
  process.stderr.write(`[${prefix}] ${msg}\n`);
}

/**
 * Run the hook: mode from argv[2] ("start" = SessionStart, anything else =
 * PreToolUse). Dispatches to the manifest's handlers; anything missing or
 * failing → `{}` so the agent tool always proceeds.
 */
export async function runHook(manifest: PluginManifest, mode?: string): Promise<void> {
  process.stdin.setEncoding("utf8");
  process.stdout.setDefaultEncoding("utf8");

  const handlers = manifest.hook;
  const m = mode ?? (process.argv[2] === "start" ? "start" : "read");

  let input: Record<string, unknown> = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    noop();
    return;
  }

  const cwd = cwdOf(input);
  const cfg = resolveConfig(manifest, cwd);

  try {
    if (m === "start") {
      if (handlers?.sessionStart) {
        const result = await handlers.sessionStart(input, {
          cwd,
          config: cfg.values,
          log: (msg) => log(manifest.markers.hook, msg),
        });
        output(result);
      } else {
        noop();
      }
      return;
    }
    if (handlers?.preToolUse) {
      const result = await handlers.preToolUse(input, {
        cwd,
        config: cfg.values,
        log: (msg) => log(manifest.markers.hook, msg),
      });
      output(result);
    } else {
      noop();
    }
  } catch (e) {
    log(manifest.markers.hook, `unexpected error: ${e instanceof Error ? e.message : e}`);
    noop();
  }
}
