#!/usr/bin/env node
// CLI entry: wires the business manifest + target adapters into the
// framework CLI. Built by build.mjs into dist/cli.js (ESM, shebang) — the
// bin entry named after the package, so npx resolves it by package name.
import { runCli } from "./framework/cli.ts";
import { manifest } from "./plugin/manifest.ts";
import { adapters } from "./plugin/targets/index.ts";

runCli({ manifest, adapters })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`[${manifest.name}] fatal: ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  });
