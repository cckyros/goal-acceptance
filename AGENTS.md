# dsh-goal-acceptance — Project Rules

## Package Manager

- Use `pnpm`, never `npm` or `yarn`.
- This is a pnpm workspace monorepo. Core and MCP packages are in the workspace; the Cordis plugin is source-only (peer deps on DeepSeek Harness).

## Architecture

- `packages/goal-acceptance-core` — zero-dependency state machine. No Cordis, no Harness imports. Framework-agnostic.
- `packages/goal-acceptance-mcp` — MCP stdio server + Agent Plugin packaging. Depends on core only.
- `packages/goal-acceptance` — Cordis plugin for DeepSeek Harness. Depends on core + Cordis + Harness. Cannot build standalone (peer deps).

## Code Conventions

- TypeScript with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- `module: esnext`, `moduleResolution: bundler`, `allowImportingTsExtensions: true`.
- Use `.ts` extension in relative imports.
- Event-sourced: all state changes go through `store.append(event)` then `applyEvent(event)`.
- `applyEvent` must be idempotent (sync replays events from the store).
- Readonly interfaces for all public types. Mutable state is private inside the engine.

## Testing

- Vitest. Run with `pnpm test`.
- Core and MCP packages have tests. Cordis plugin tests require Harness deps and are excluded from the standalone test run.
- 34 tests total (27 core + 6 MCP + 1 standalone). All must pass before committing.

## Typecheck

- Run with `pnpm typecheck` (uses `tsconfig.typecheck.json`, covers core + MCP).
- Cordis plugin is not typechecked standalone (missing peer deps).

## Build

- Don't run `pnpm build` unless explicitly asked — it's slow and not needed for most tasks.
- Core and MCP build with `tsdown`. Cordis plugin builds only inside the Harness workspace.

## Git

- Commit messages: conventional commits format (`feat:`, `fix:`, `docs:`, etc.).
- Don't push unless explicitly asked.
- Don't commit `pnpm-lock.yaml` changes that come from unrelated installs.

## Windows Environment

- File encoding: UTF-8. Don't convert encodings as a side effect of editing.
- PowerShell is the default shell. Heredoc syntax (`<<'EOF'`) doesn't work — use `-F <file>` for multi-line commit messages.
- Non-ASCII output in console may be garbled (GBK/CP936). Write to file and read back when needed.
