# goal-acceptance — Project Rules

## Package Manager

- Use `pnpm`, never `npm` or `yarn`.
- Single package (no workspace). `autoInstallPeers: false` is required:
  `@deepseek-ai/*` peer closures include host-platform packages that are not
  in the npm registry — dsh injects them at runtime.

## Architecture

- `src/plugin/engine/` — zero-dependency event-sourced state machine.
  No Cordis, no Harness, no @deepseek-ai imports.
- `src/plugin/goal-manager.ts` — multi-goal manager + `FileAcceptanceStore`
  + `SessionAcceptanceStore` (dsh, type-only imports). Shared by ALL paths.
- `src/plugin/manifest.ts` — SINGLE source of identity (name, version, tools,
  markers, config). build.mjs generates every identity file from it.
- `src/plugin/tools.ts` — 13 `ToolDef`s (`{name, description, inputSchema,
  handler}`); `manifest.tools` is built from them.
- `src/plugin/dsh-plugin.ts` — Cordis plugin (service + 13 tools + systemPrompt
  section + turn-stopping steer + invariant registration). `@deepseek-ai/*`
  imports live ONLY here, in `invariant.ts`, and type-only in `goal-manager.ts`.
  Plugin id = `manifest.name`.
- `src/plugin/openclaw-plugin.ts` — `defineToolPlugin` port; execute per the
  SDK contract `(params, config, context)`; id = 'goal-acceptance' (brand).
- `src/plugin/targets/` — 22 install adapters (copied framework layer).
  `PLUGIN_PACKAGE_FILES` holds exactly 6 entries (deviation #1) — do not
  change without updating the materialize tests.
- `src/assets/` — SKILL.md + 8 companion skills with `{{placeholders}}`;
  build syncs them to `skills/` (deviation #2).

## Code Conventions

- TypeScript with `strict` (tsconfig in this repo), `.ts` extension in
  relative imports, `allowImportingTsExtensions`.
- Event-sourced: all state changes go through `store.append(event)` then
  `applyEvent(event)`.
- `applyEvent` must be idempotent (sync replays events from the store).
- Readonly interfaces for all public types. Mutable state is private inside
  the engine.
- No TS parameter properties in constructors — node --test strip-only mode
  cannot parse them (use plain fields).
- Engine errors stay `GoalAcceptanceError` (from `./engine/index.ts`); the
  framework MCP runtime converts them to `{error, code}` + `isError: true`.

## Testing

- `node --test` (node:test + node:assert/strict), never vitest.
- `npm run verify` = build → typecheck → test (tests run against built dist/).
- Suites: `tests/engine.test.ts` (core), `tests/standalone.test.ts`,
  `tests/mcp.test.ts` (spawns `dist/cli.js mcp`), `tests/dsh-*.test.ts`
  (cordis + @deepseek-ai/*), `tests/*-targets.test.ts` (spawn the built CLI
  with fake homes; `has(id)` self-skip). All must pass before committing.
- dsh tests mount the plugin via `ctx.plugin({name, inject, apply}, config)`
  and use `ctx.sessions.create()` (bare `Session.create()` does not dispatch).

## Typecheck

- `npx tsc --noEmit` covers `src/**` + `tests/**`.

## Build

- `npm run build` (node build.mjs): 4 bundles (cli.js, hook.cjs,
  dsh-plugin.js, openclaw-plugin.js), assets/skills sync, identity files.
- `dist/dsh-plugin.js` and `openclaw-dist/` are COMMITTED (.gitignore
  exception) so git-checkout installs work without a build step.
- Do not edit generated files (`plugin.json`, `mcp.json`, `.mcp.json`,
  `marketplace.json`, `cordis.patch.yml`, `openclaw.plugin.json`, `skills/`,
  `openclaw-dist/`, `assets/`) — change the source or build.mjs instead.

## Git

- Commit messages: conventional commits format (`feat:`, `fix:`, `refactor:`,
  etc.).
- Don't push unless explicitly asked.
- Don't commit `pnpm-lock.yaml` changes that come from unrelated installs.

## Windows Environment

- File encoding: UTF-8. Don't convert encodings as a side effect of editing.
- PowerShell is the default shell. Heredoc syntax (`<<'EOF'`) doesn't work —
  use `-F <file>` for multi-line commit messages.
- Non-ASCII output in console may be garbled (GBK/CP936). Write to file and
  read back when needed.
