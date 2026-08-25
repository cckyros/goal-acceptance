// Hook entry: bundles the framework hook runtime + business handlers into
// dist/hook.cjs (standalone CJS, zero deps) with the identity marker banner.
// Copied into projects by the installer; run by Claude Code's hook system.
// goal-acceptance ships no hook handlers — runHook no-ops (emits `{}`) so the
// bundle stays a valid install artifact (uninstall recognizes it by banner).
import { runHook } from "./framework/hook-runtime.ts";
import { manifest } from "./plugin/manifest.ts";

runHook(manifest)
  .then(() => {
    process.exitCode = 0;
  })
  .catch((e) => {
    process.stderr.write(`[${manifest.name}] hook error: ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 0; // never fail the agent tool
  });
