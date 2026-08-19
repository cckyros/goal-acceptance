# MCP Protocol Parity and 0.1.1 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize the Cordis and OpenClaw adapters with the current 13-tool MCP protocol, verify against the DeepSeek Harness workspace, and publish the three publishable packages as 0.1.1.

**Architecture:** `@cckyros/goal-acceptance-core` remains the single state-machine and event-contract source of truth. MCP, Cordis, and OpenClaw each expose equivalent adapters over that core; Cordis additionally injects system guidance and turn-stopping steering. The Cordis package remains workspace-only because its DeepSeek Harness dependencies use `workspace:^`.

**Tech Stack:** TypeScript, Vitest, pnpm, tsdown, MCP SDK 1.12.x, DeepSeek Harness Cordis, OpenClaw.

## Global Constraints

- Keep all adapters behaviorally aligned with the MCP server's 13 tools.
- Preserve the default `role=agent` behavior and independent `confirm_criterion` requirement.
- Do not publish the source-only Cordis package as a standalone npm package.
- Publish core, MCP, and OpenClaw at version 0.1.1.
- Run `pnpm test` and `pnpm typecheck` before release.
- Use the DeepSeek Harness workspace at `D:\SOFT\repository\deepseek-harness` for Cordis integration verification.

---

### Task 1: Synchronize Cordis tool and service parity

**Files:**
- Modify: `packages/goal-acceptance/src/service.ts`
- Modify: `packages/goal-acceptance/src/tools.ts`
- Modify: `packages/goal-acceptance/src/types.ts` if adapter-only types are needed
- Test: `packages/goal-acceptance/tests/tools.spec.ts`
- Test: `packages/goal-acceptance/tests/plugin.spec.ts`

**Interfaces:**
- Consume core engine methods and specs from `@cckyros/goal-acceptance-core`.
- Produce Cordis tools named exactly like the MCP tools, with compatible inputs and outputs.

- [ ] **Step 1: Add failing parity assertions**
  - Assert that `createAcceptanceTools(ctx)` returns all 13 MCP tool names.
  - Assert `confirm_criterion`, `set_task_plan`, `get_task_plan`, `can_complete_goal`, `start_goal`, `list_goals`, `switch_goal`, and `reset_goal` are present.
  - Assert the `confirm_criterion` tool calls the core review method with high-confidence evidence.

- [ ] **Step 2: Run the targeted Cordis tests and observe the expected failure**

Run: `npx vitest run packages/goal-acceptance/tests/tools.spec.ts packages/goal-acceptance/tests/plugin.spec.ts`
Expected: FAIL because the current Cordis adapter returns only five tools.

- [ ] **Step 3: Add service wrappers for missing core operations**
  - Add typed methods for task-plan reads/writes, confirmation, completion checks, and goal lifecycle operations.
  - Keep per-Agent state isolation through the existing `WeakMap<Agent, GoalAcceptanceEngine>` and session-backed store.

- [ ] **Step 4: Add the eight missing Cordis tool definitions**
  - Mirror MCP parameter names and result summaries.
  - Include `role` in criteria locking.
  - Include `evidence_type` where the core contract supports it.
  - Reject text evidence for confirmation.

- [ ] **Step 5: Run the targeted tests and verify they pass**

Run: `npx vitest run packages/goal-acceptance/tests/tools.spec.ts packages/goal-acceptance/tests/plugin.spec.ts`
Expected: all targeted Cordis tests pass.

### Task 2: Fix Cordis self-claim reviewer steering

**Files:**
- Modify: `packages/goal-acceptance/src/index.ts`
- Modify: `packages/goal-acceptance/src/prompt.ts`
- Test: `packages/goal-acceptance/tests/plugin.spec.ts`

**Interfaces:**
- Consume `AcceptanceSummary.selfClaimedPassed` and `canComplete()` state from the core service.
- Produce a steering message that directs the agent to independent confirmation rather than stopping silently.

- [ ] **Step 1: Add a failing steering test**
  - Lock an `agent`-role criterion, validate it as passed, fire `agent/turn-stopping`, and assert the inbox receives a message mentioning reviewer confirmation.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run packages/goal-acceptance/tests/plugin.spec.ts -t "self-claimed"`
Expected: FAIL because current steering filters only pending/in-progress criteria.

- [ ] **Step 3: Implement the minimal steering branch**
  - Detect required self-claimed criteria.
  - Add them to the next actionable guidance.
  - Do not repeatedly steer after the configured maximum.
  - Preserve the existing dependency ordering for ordinary pending criteria.

- [ ] **Step 4: Run targeted and regression tests**

Run: `npx vitest run packages/goal-acceptance/tests/plugin.spec.ts`
Expected: all plugin tests pass.

### Task 3: Verify and align OpenClaw parity

**Files:**
- Modify: `packages/goal-acceptance-openclaw/src/index.ts`
- Modify: `packages/goal-acceptance-openclaw/skills/*/SKILL.md`
- Test: `test-output/openclaw-proto/src/index.test.ts`

**Interfaces:**
- Preserve OpenClaw's `defineToolPlugin` registration model.
- Match MCP tool names, schemas, defaults, role behavior, and confirmation evidence rules.

- [ ] **Step 1: Add failing OpenClaw parity assertions**
  - Assert all 13 names are registered.
  - Assert `confirm_criterion` rejects text evidence and formalizes a self-claimed pass.
  - Assert task-plan and multi-goal tools use the same state semantics as core/MCP.

- [ ] **Step 2: Run the targeted OpenClaw test and verify the failure**

Run: `pnpm vitest run test-output/openclaw-proto/src/index.test.ts`
Expected: FAIL for any missing or schema-incompatible tool.

- [ ] **Step 3: Update OpenClaw registrations and skill docs**
  - Reuse core engine methods rather than duplicating state transitions.
  - Add or update `goal-planning` and `confirm-criterion` skills.
  - Align descriptions with the MCP tool descriptions.

- [ ] **Step 4: Run the targeted OpenClaw test and verify it passes**

Run: `pnpm vitest run test-output/openclaw-proto/src/index.test.ts`
Expected: PASS.

### Task 4: Run complete parity and workspace checks

**Files:**
- Test: `packages/goal-acceptance-mcp/tests/mcp-server.spec.ts`
- Test: `packages/goal-acceptance/tests/*.spec.ts`
- Test: `test-output/openclaw-proto/src/index.test.ts`

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all test files and tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: exit code 0 for the supported workspace packages.

- [ ] **Step 3: Run the DeepSeek Harness integration check**

Run from `D:\SOFT\repository\deepseek-harness`: the repository's targeted test command for loading the goal-acceptance Cordis plugin, using the local package source or workspace link.
Expected: plugin loads, all tools register, and no missing dependency/schema error occurs.

### Task 5: Prepare and publish 0.1.1

**Files:**
- Modify: `packages/goal-acceptance-core/package.json`
- Modify: `packages/goal-acceptance-mcp/package.json`
- Modify: `packages/goal-acceptance-openclaw/package.json`
- Modify: `packages/goal-acceptance-mcp/plugin.json`
- Modify: `packages/goal-acceptance-openclaw/openclaw.plugin.json`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Set versions to 0.1.1**
  - Update the three publishable packages and plugin manifests.
  - Keep the Cordis source-only package version aligned if its metadata is included, but do not publish it independently.

- [ ] **Step 2: Build publishable packages**

Run the package-local TypeScript and tsdown commands for core, MCP, and OpenClaw.
Expected: package entrypoints and declarations are regenerated without errors.

- [ ] **Step 3: Publish and verify npm versions**

Run `pnpm publish --access public --registry https://registry.npmjs.org/ --no-git-checks` in each publishable package.
Then run `npm view <package> version --registry https://registry.npmjs.org/`.
Expected: each returns `0.1.1`.

- [ ] **Step 4: Commit and tag**

```sh
git add packages README.md README.zh-CN.md
git commit -m "release: publish goal-acceptance 0.1.1"
git push origin master
git tag -a v0.1.1 -m "Release goal-acceptance 0.1.1"
git push origin v0.1.1
```

Expected: remote master and annotated `v0.1.1` point to the same final commit.
