# goal-acceptance

![goal-acceptance](assets/goal-acceptance-cover.jpg)

English | [中文](README.zh-CN.md)

Acceptance-criteria-driven goal completion for autonomous AI agents.

Prevents agents from prematurely declaring "done" by locking immutable acceptance
criteria before work begins, tracking validation status with evidence, linking
criteria to task progress, respecting dependency ordering, and enforcing
completion checks.

## Advantages

### 1. Cross-platform compatibility

One package, four runtimes, 22 install targets:

| Platform | How it connects | Turn-stopping enforcement |
|----------|----------------|--------------------------|
| **Claude Code** | MCP stdio server (`cli mcp`) | Model voluntarily calls tools |
| **Cursor** | MCP stdio server (`cli mcp`) | Model voluntarily calls tools |
| **Devin** | MCP stdio server (`cli mcp`) | Model voluntarily calls tools |
| **OpenClaw** | Native plugin (`openclaw-dist/`, in-process, no stdio) | Model voluntarily calls tools |
| **DeepSeek Harness** | Cordis plugin (`dist/dsh-plugin.js`) | **Yes** — `agent.steer()` forces continuation |
| **Any MCP client** | stdio MCP server (`cli mcp`) | Model voluntarily calls tools |
| **Any Agent Plugins client** | plugin.json + mcp.json + skills | Model voluntarily calls tools |
| **Any JS/TS runtime** | Core engine (`src/plugin/engine/`, bundled in the CLI) | Programmatic — you control it |

The core state machine is **zero-dependency**. The `cli mcp` server, the dsh
Cordis plugin, and the OpenClaw native plugin all call the same shared engine
and goal manager — one implementation, four surfaces.

### 2. One installer for 22 agent platforms

`dist/cli.js install --target <name>` registers the plugin for 22 clients:

- **Native MCP** (8): claude, codex, opencode, qwen, reasonix, kilo, workbuddy, devin
- **Skill targets** (4): trae, pi, omp, dsh
- **Agent Plugins** (10): copilot, cursor, kiro, openclaw, hermes, vscode,
  chatgpt-codex, grok, nanoclaw, other

Each adapter writes the client's native config (MCP server entries, skills,
plugin dirs, marketplace shims) from one generated portable package
(`plugin.json` / `mcp.json` / `.mcp.json` / `skills/` / `openclaw.plugin.json` /
`openclaw-dist/`).

### 3. MCP server with 13 tools

The CLI exposes 13 tools covering the full goal-acceptance lifecycle:

- **Criteria management**: set, get, amend
- **Task plan management**: set task plan, get task plan
- **Validation**: validate criterion with typed evidence; confirm criterion with independent reviewer evidence
- **Progress tracking**: update task status
- **Completion gate**: can complete goal
- **Multi-goal management**: start goal, list goals, switch goal, reset goal

See [MCP Tools](#mcp-tools) below for the full list.

### Multi-goal isolation

Each goal has its own event file under `${PLUGIN_DATA}/goals/{goalId}.json` —multiple projects and windows can share one server without lock conflicts:

- `set_acceptance_criteria` auto-creates a goal when none is active
- `start_goal` begins a new independent goal (fresh criteria + task plan)
- `switch_goal` moves between goals; `list_goals` shows all with status
- `reset_goal` deletes a messed-up goal so you can start over
- The active goal survives server restarts (`current-goal.txt`)

### 4. Dual-role validation (anti self-grading)

`set_acceptance_criteria` accepts a `role` parameter (`agent` / `reviewer` /
`dual`). When `role=agent`, `validate_criterion` marks `passed` as
`selfClaimed=true` — `can_complete_goal` blocks completion until a reviewer
formally confirms. This breaks the "self-grading" loop where an agent both
does the work and signs off on it.

### 5. Typed evidence

`validate_criterion` accepts `evidence_type` (`command` / `file` / `url` /
`text`). `text` evidence is flagged `lowConfidence=true` so reviewers can
spot subjective claims at a glance. `command` evidence (test output, CLI
results) is high-confidence.

### 6. Task decomposition with dependency validation

`set_task_plan` lets you decompose a goal into atomic tasks, each with a
concrete deliverable. The engine validates: unique IDs, unambiguous
descriptions, non-empty deliverables, no self-dependencies, no unknown
dependencies, and no dependency cycles (including indirect cycles).

### 7. Event-sourced persistence

All state changes are append-only events. The engine replays events on every
read, enabling durable persistence, exact state restoration across restarts,
and a full audit trail of every decision.

### 8. Slim responses by default

MCP tool responses are slim by default (4-field summary). Pass `verbose=true`
for the full summary. This minimizes token overhead during normal operation.

## Architecture

```
src/
├── framework/              # Zero-dependency scaffold (manifest, registry, CLI,
│                           #   wizard, mcp-runtime, hook-runtime, installers)
├── plugin/
│   ├── engine/             # Event-sourced state machine (core)
│   ├── goal-manager.ts     # Multi-goal manager (shared by all paths)
│   ├── tools.ts            # 13 ToolDefs (manifest.tools data source)
│   ├── manifest.ts         # Single source of identity
│   ├── dsh-plugin.ts       # DeepSeek Harness Cordis plugin
│   ├── openclaw-plugin.ts  # OpenClaw native plugin (typebox, in-process)
│   ├── prompt.ts           # dsh system-prompt guidance
│   ├── invariant.ts        # dsh session invariant companion
│   └── targets/            # 22 install adapters
└── assets/                 # SKILL.md + 8 companion skills ({{placeholders}})

build.mjs  →  dist/cli.js (CLI + MCP) + dist/hook.cjs + dist/dsh-plugin.js
              + dist/openclaw-plugin.js → openclaw-dist/
              + plugin.json / mcp.json / .mcp.json / marketplace.json
              / cordis.patch.yml / openclaw.plugin.json / skills/
```

All identity files are **generated from `src/plugin/manifest.ts`** at build
time and committed, so the repo is a valid install source for every client.

## Quick Start

### Install (one command, 22 platforms)

```sh
node dist/cli.js install                # interactive wizard
node dist/cli.js install --target claude
node dist/cli.js install --target openclaw
node dist/cli.js list-targets           # show all 22
```

### MCP server (any MCP client)

```json
{
  "mcpServers": {
    "@cckyros/goal-acceptance": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/goal-acceptance/dist/cli.js", "mcp"],
      "env": { "PLUGIN_DATA": "/path/to/persistent/data" }
    }
  }
}
```

Standalone:

```sh
# In-memory (resets on restart)
node dist/cli.js mcp

# Persistent across restarts
PLUGIN_DATA=/path/to/data node dist/cli.js mcp
```

If `PLUGIN_DATA` is not set, state is in-memory only (lost on restart).

#### Typical workflow

1. **Set criteria** — `set_acceptance_criteria` with `role=reviewer` (you verify) or `role=agent` (agent self-claims, you confirm later)
2. **Set task plan** — `set_task_plan` to decompose the goal into atomic tasks with deliverables and dependencies
3. **Execute** — `update_task_status` as tasks progress (`pending` — `in_progress` — `completed`)
4. **Validate** — `validate_criterion` with `evidence_type=command` for high-confidence evidence. Default `role=agent`: passed criteria are self-claimed.
5. **Confirm** — `confirm_criterion` (independent reviewer agent only) with fresh `evidence_type=command`/`file`/`url` evidence. Converts self-claimed to formal pass.
6. **Check** — `can_complete_goal` to verify all required criteria are formally passed

### OpenClaw native plugin

`openclaw-dist/` carries the in-process plugin (bundle + minimal package.json
with the `openclaw.extensions` contract) and `openclaw.plugin.json` declares
the 13-tool contracts:

```sh
openclaw plugins install /path/to/goal-acceptance/openclaw-dist
# or, when materialized by the installer:
openclaw plugins install ~/.goal-acceptance/plugin
openclaw gateway restart
openclaw plugins list            # goal-acceptance: loaded
```

The 13 tools are available in OpenClaw sessions. `Shape: non-capability` is
normal for tool plugins — tools are registered via `defineToolPlugin`.

### DeepSeek Harness (Cordis plugin)

`dist/dsh-plugin.js` is the only variant that can **force** the agent to
continue working when it tries to stop early. It intercepts
`agent/turn-stopping` and steers the agent back with dependency-aware priority
ordering.

```yaml
# cordis.patch.yml (generated)
- insert:
    - id: @cckyros/goal-acceptance
      name: @cckyros/goal-acceptance
      config: {}
```

The plugin:

- Registers the same 13 model tools as the MCP adapter
- Injects a `policy:goal-acceptance` system prompt section with task progress and next-actionable ordering
- Intercepts `agent/turn-stopping` and steers the agent back with dependency-aware
  priority ordering for pending work and self-claimed criteria awaiting reviewer confirmation

> **Note**: The dsh plugin requires the DeepSeek Harness host packages as peer
> dependencies (`@deepseek-ai/*`), injected at runtime by the dsh profile.
> `@deepseek-ai/*` imports are devDependencies here for types only.

### Core engine (any JS/TS runtime)

The zero-dependency state machine lives in `src/plugin/engine/` and is
bundled into the CLI. Use it programmatically from this repo or copy the
folder into your project:

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from './src/plugin/engine/index.ts'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

// Lock criteria before work begins
await engine.setCriteria([
  { id: 'api-200', description: 'GET /health returns 200', required: true, method: 'test', taskIds: ['task-1', 'task-2'] },
  { id: 'docs', description: 'README updated', required: false, method: 'manual', dependsOn: ['api-200'] },
])

// Update task progress as work proceeds
await engine.updateTaskStatus({ taskId: 'task-1', status: 'completed' })
await engine.updateTaskStatus({ taskId: 'task-2', status: 'completed' })

// When all linked tasks are done, the criterion is "ready to validate"
const summary = engine.summarize()
console.log(summary.readyToValidate.map(c => c.id)) // ['api-200']

// Record validation with evidence
await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health -> HTTP 200 OK',
})

// Check if goal can complete
const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
// true, undefined
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `set_acceptance_criteria` | Lock the criteria list. Each criterion may link to task IDs and declare dependencies. Optional `role` parameter (`agent`/`reviewer`/`dual`, default `agent`) controls self-claim behavior. With the default, passed criteria require independent reviewer confirmation. Must be called before implementation. |
| `get_acceptance_criteria` | Read current criteria, task progress, summary, task plan, ready-to-validate list, and next-actionable ordering. Optional `verbose` parameter (default `true`; pass `false` for slim summary only). |
| `set_task_plan` | Set and lock the task decomposition plan. Each task must have a unique id, unambiguous description, and concrete deliverable. Dependency cycles are rejected. Requires criteria to be locked first. |
| `get_task_plan` | Read the current task decomposition plan with live task statuses. |
| `validate_criterion` | Record status (`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`) and evidence. `passed` and `failed` require evidence. Optional `evidence_type` (`command`/`file`/`url`/`text`, default `text`). When `role=agent` (default), `passed` is marked self-claimed. Optional `verbose` (default `false`). |
| `confirm_criterion` | **Reviewer-only.** Confirm a self-claimed passed criterion with independent re-verification evidence. Requires `evidence_type` of `command`/`file`/`url` (text rejected). Converts self-claimed to formal pass, unblocking `can_complete_goal`. Must be called by an independent reviewer agent, not the agent that did the work. |
| `update_task_status` | Update a linked task's status (`pending`/`in_progress`/`completed`/`failed`). When all tasks linked to a criterion are completed, it becomes ready to validate. Optional `verbose` (default `false`). |
| `amend_acceptance_criteria` | Append new criteria after the initial lock. Requires a reason. Existing criteria are not modified. |
| `can_complete_goal` | Check whether all required criteria are formally passed (self-claimed does not count). Returns `{ allowed: boolean, reason?: string }`. |
| `start_goal` | Start a new independent goal with fresh state (optional `title`). The new goal becomes active. Use when the current goal is locked and you need a new task. |
| `list_goals` | List all goals with ID, title, criteria counts, and active flag. |
| `switch_goal` | Switch the active goal to an existing goal by ID. |
| `reset_goal` | Delete the current goal and all its data permanently. |

## Skills

The plugin ships 9 skills (built from `src/assets/` with placeholder filling):

```
skills/
├── goal-acceptance/SKILL.md          # Main skill: workflow + companion index
├── goal-planning/                    # Decompose into coverage-complete criteria first
├── set-acceptance-criteria/          # Lock criteria (criterion quality rules)
├── amend-acceptance-criteria/        # Append criteria when requirements expand
├── get-acceptance-criteria/          # Read current criteria and progress
├── update-task-status/               # Track task status linked to criteria
├── validate-criterion/               # Record status + evidence from real execution
├── confirm-criterion/                # Independent reviewer confirmation (fresh evidence)
└── can-complete-goal/                # Completion gate; self-claimed passes block
```

## Criterion Status Lifecycle

pending -> in_progress -> passed
             |              |
             +-> failed     +-> selfClaimed -> confirm_criterion -> formal pass
             |
             +-> blocked
             +-> not_run (non-required criteria only)

| Status | Meaning | Evidence required |
|--------|---------|-------------------|
| `pending` | Not yet started | No |
| `in_progress` | Being worked on | No |
| `passed` | Verified successful | Yes |
| `failed` | Verified unsuccessful | Yes |
| `blocked` | Cannot verify in current environment | No |
| `not_run` | Explicitly skipped (non-required only) | No |

## Completion Gate

`canComplete()` returns `{ allowed: boolean, reason?: string }`:

- **Allowed**: all required criteria are formally `passed` (not self-claimed), or no criteria are locked.
- **Not allowed**: any required criterion is `pending`, `in_progress`, `failed`,
  `blocked`, or `not_run`.
- **Not allowed (self-claimed)**: all required criteria are `passed` but some are
  `selfClaimed=true` (set by an agent, not yet reviewer-confirmed). The reason
  will indicate how many are awaiting reviewer confirmation.

## Event Sourcing

The engine is event-sourced. The store holds an append-only list of:

- `goal-acceptance/set` —locks the criteria list (with role)
- `goal-acceptance/task-plan` —locks the task decomposition plan
- `goal-acceptance/validate` —updates one criterion's status (with evidence type, self-claimed flag)
- `goal-acceptance/task-update` —updates a linked task's status
- `goal-acceptance/amend` —appends new criteria after the initial lock

On every read, the engine replays events from the store. This enables:

- Durable persistence (file, database, session log)
- Replay-exact state restoration
- Audit trail of all decisions

### Custom Store

Implement `GoalAcceptanceStore` for your persistence backend:

```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from './src/plugin/engine/index.ts'

class MyDbStore implements GoalAcceptanceStore {
  get events(): readonly GoalAcceptanceEvent[] {
    // Return all events in append order
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // Persist the event
  }
}
```

## Four-Way Compatibility

| Capability | dsh Cordis plugin | CLI MCP server | Agent Plugin | OpenClaw native |
|------------|:---:|:---:|:---:|:---:|
| Model tools | 13 tools (see [MCP Tools](#mcp-tools)) | 13 tools (see [MCP Tools](#mcp-tools)) | same as MCP | same as MCP (in-process) |
| System prompt / Skills | `policy:goal-acceptance` | `skills/` | `skills/` | `skills/` |
| Turn-stopping enforcement | yes (`agent.steer()`, dependency-aware) | no | no | no |
| Cross-client portable | no (Harness only) | yes (any MCP client) | yes (any Agent Plugins client) | no (OpenClaw only) |
| Persistent state | `dsh-session` log | `$PLUGIN_DATA/goals/` | same as MCP | same as MCP |
| Dual-role validation | yes (`role` parameter) | yes (`role` parameter) | yes | yes |
| Typed evidence | yes (`evidence_type` parameter) | yes (`evidence_type` parameter) | yes | yes |
| Task decomposition plan | yes (`set_task_plan` / `get_task_plan`) | yes (`set_task_plan` / `get_task_plan`) | yes | yes |
| Slim responses | no | yes (`verbose` parameter) | yes | yes |
| In-process calls (no stdio) | yes | no | no | yes |

The dsh Cordis plugin is the only variant that can **force** the agent to
continue working when it tries to stop early. The MCP, Agent Plugin, and
OpenClaw native variants rely on the model voluntarily calling the tools and
following skill instructions.

## Repository Layout

```
src/
├── cli-entry.ts            # CLI entry (bundled to dist/cli.js)
├── hook-entry.ts           # Read hook (bundled to dist/hook.cjs)
├── framework/              # Scaffold framework (manifest, registry, CLI,
│                           #   wizard, mcp-runtime, hook-runtime, paths, cache)
├── plugin/
│   ├── manifest.ts         # Identity single source (name, tools, markers, config)
│   ├── engine/             # Event-sourced state machine (zero-dependency)
│   ├── goal-manager.ts     # Multi-goal manager + stores (shared by all paths)
│   ├── tools.ts            # 13 ToolDefs
│   ├── dsh-plugin.ts       # Cordis plugin (service, tools, steer, prompt)
│   ├── openclaw-plugin.ts  # OpenClaw native plugin
│   ├── prompt.ts           # dsh system-prompt guidance
│   ├── invariant.ts        # dsh session invariant
│   └── targets/            # 22 install adapters
└── assets/                 # SKILL.md + 8 companion skills + cover image
tests/                      # node --test suites (engine, mcp, dsh, targets...)
build.mjs                   # esbuild bundles + identity file generation
dist/                       # cli.js + hook.cjs + dsh-plugin.js (committed)
openclaw-dist/              # openclaw-plugin.js + package.json (committed)
```

## Build & Test

```sh
pnpm install
npm run verify      # build → typecheck → node --test
node dist/cli.js --help
```

## License

MIT
