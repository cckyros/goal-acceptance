# goal-acceptance

English | [中文](README.zh-CN.md)

Acceptance-criteria-driven goal completion for autonomous AI agents.

Prevents agents from prematurely declaring "done" by locking immutable acceptance
criteria before work begins, tracking validation status with evidence, linking
criteria to task progress, respecting dependency ordering, and enforcing
completion checks.

## Advantages

### 1. Cross-platform compatibility

goal-acceptance works with **any** AI agent platform that supports MCP or Agent
Plugins. One package, multiple runtimes:

| Platform | How it connects | Turn-stopping enforcement |
|----------|----------------|--------------------------|
| **Claude Code** | MCP stdio server | Model voluntarily calls tools |
| **Cursor** | MCP stdio server | Model voluntarily calls tools |
| **Devin** | MCP stdio server | Model voluntarily calls tools |
| **OpenClaw** | Native plugin (`@cckyros/goal-acceptance-openclaw`) or Agent Plugin bundle | Model voluntarily calls tools |
| **DeepSeek Harness** | Cordis plugin (`@cckyros/goal-acceptance`) | **Yes** — `agent.steer()` forces continuation |
| **Any MCP client** | stdio MCP server | Model voluntarily calls tools |
| **Any Agent Plugins client** | plugin.json + mcp.json + skills | Model voluntarily calls tools |
| **Any JS/TS runtime** | Core library (`@cckyros/goal-acceptance-core`) | Programmatic — you control it |

The core state machine is **zero-dependency** and runs in any JS/TS runtime
(Node.js, Bun, Deno, browser). The MCP server adds only the MCP SDK. The Cordis
plugin adds DeepSeek Harness integration. You pick the layer you need.

### 2. MCP server with 8 tools

The MCP server exposes 8 tools covering the full goal-acceptance lifecycle:

- **Criteria management**: set, get, amend
- **Task plan management**: set task plan, get task plan
- **Validation**: validate criterion with typed evidence
- **Progress tracking**: update task status
- **Completion gate**: can complete goal

See [MCP Tools](#mcp-tools) below for the full list.

### 3. Dual-role validation (anti self-grading)

`set_acceptance_criteria` accepts a `role` parameter (`agent` / `reviewer` /
`dual`). When `role=agent`, `validate_criterion` marks `passed` as
`selfClaimed=true` — `can_complete_goal` blocks completion until a reviewer
formally confirms. This breaks the "self-grading" loop where an agent both
does the work and signs off on it.

### 4. Typed evidence

`validate_criterion` accepts `evidence_type` (`command` / `file` / `url` /
`text`). `text` evidence is flagged `lowConfidence=true` so reviewers can
spot subjective claims at a glance. `command` evidence (test output, CLI
results) is high-confidence.

### 5. Task decomposition with dependency validation

`set_task_plan` lets you decompose a goal into atomic tasks, each with a
concrete deliverable. The engine validates: unique IDs, unambiguous
descriptions, non-empty deliverables, no self-dependencies, no unknown
dependencies, and no dependency cycles (including indirect cycles).

### 6. Event-sourced persistence

All state changes are append-only events. The engine replays events on every
read, enabling durable persistence, exact state restoration across restarts,
and a full audit trail of every decision.

### 7. Slim responses by default

MCP tool responses are slim by default (4-field summary). Pass `verbose=true`
for the full summary. This minimizes token overhead during normal operation.

## Packages

| Package | Description | Dependencies |
|---------|-------------|--------------|
| [`@cckyros/goal-acceptance-core`](packages/goal-acceptance-core) | Framework-agnostic state machine, types, errors, abstract store | None |
| [`@cckyros/goal-acceptance-mcp`](packages/goal-acceptance-mcp) | MCP stdio server + Agent Plugin bundle (plugin.json, mcp.json, skills) | core, MCP SDK |
| [`@cckyros/goal-acceptance-openclaw`](packages/goal-acceptance-openclaw) | OpenClaw native plugin (in-process tools, no stdio) | core, typebox; peer: openclaw |
| [`@cckyros/goal-acceptance`](packages/goal-acceptance) | DeepSeek Harness Cordis plugin with turn-stopping steering | core, Cordis, Harness |

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │ @cckyros/goal-acceptance-core                   │
                    │ (zero-dep state machine, event-sourced)         │
                    └────────────┬──────────────────┬─────────────────┘
                                 │                  │
                    ┌────────────┴────────┐ ┌──────┴──────────────────┐
                    │ @cckyros/goal-      │ │ @cckyros/goal-          │
                    │ acceptance-mcp      │ │ acceptance-openclaw     │
                    │ (MCP stdio server + │ │ (OpenClaw native plugin │
                    │  Agent Plugin bundle)│ │  — in-process tools)   │
                    │ turn-stopping       │ │ defineToolPlugin        │
                    │ agent.steer()       │ │ 8 tools, no stdio       │
                    │ system prompt       │ │ skills/ included        │
                    │ tool registration   │ │                         │
                    └─────────────────────┘ └─────────────────────────┘
```

## Quick Start

### Core library (any JS/TS runtime)

```sh
npm install @cckyros/goal-acceptance-core
```

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'

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
console.log(summary.readyToValidate.map(c => c.id)) // → ['api-200']

// Record validation with evidence
await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health → HTTP 200 OK',
})

// Check if goal can complete
const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
// → true, undefined
```

### MCP server (Devin, Claude Code, Cursor, etc.)

Three installation methods, pick one:

#### Method A: Global install (recommended)

```sh
npm install -g @cckyros/goal-acceptance-mcp
```

Find the installed bin path, then add to your MCP client config:

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["/path/to/global/node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

> **Find the global path**: `npm root -g` (e.g. `C:\nvm4w\nodejs\node_modules` on Windows, `/usr/local/lib/node_modules` on macOS/Linux).

#### Method B: npx (no pre-install needed)

npx downloads the package on-demand to a temporary cache. No global install required, but adds a few seconds of startup latency on first run.

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "npx",
      "args": ["-y", "@cckyros/goal-acceptance-mcp"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

> **Windows + nvm users**: If npx fails to start the server, use Method A instead. nvm junctions can cause `import.meta.url` path mismatch in some Node.js versions.

#### Method C: Local install (project-level)

```sh
npm install @cckyros/goal-acceptance-mcp
```

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

#### Devin CLI config

Devin uses `%APPDATA%\devin\mcp_config.json` (Windows) or `~/.config/devin/mcp_config.json` (macOS/Linux). Add the `goal-acceptance` entry to `mcpServers` using any method above, then restart Devin.

#### Standalone usage

```sh
# In-memory (resets on restart)
node ./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs

# Persistent across restarts
PLUGIN_DATA=/path/to/data node ./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs
```

The server writes `acceptance-events.json` under `$PLUGIN_DATA`. If `PLUGIN_DATA`
is not set, state is in-memory only (lost on restart).

#### Typical workflow

1. **Set criteria** — `set_acceptance_criteria` with `role=reviewer` (you verify) or `role=agent` (agent self-claims, you confirm later)
2. **Set task plan** — `set_task_plan` to decompose the goal into atomic tasks with deliverables and dependencies
3. **Execute** — `update_task_status` as tasks progress (`pending` → `in_progress` → `completed`)
4. **Validate** — `validate_criterion` with `evidence_type=command` for high-confidence evidence
5. **Check** — `can_complete_goal` to verify all required criteria are formally passed

### OpenClaw native plugin

The `@cckyros/goal-acceptance-openclaw` package is an OpenClaw native plugin that registers all 8 tools directly in-process (no MCP stdio overhead).

```sh
openclaw plugins install "npm:@cckyros/goal-acceptance-openclaw@rc"
```

> **Note**: The `@rc` tag is required because the package is in pre-release. Once a stable version is published, the tag can be omitted.

After install, restart the gateway:

```sh
openclaw gateway restart
```

Verify:

```sh
openclaw plugins inspect goal-acceptance
# Status: loaded, Format: openclaw
```

The 8 tools are now available in OpenClaw sessions. `Shape: non-capability` is normal for tool plugins — tools are registered via `defineToolPlugin`, not the capability system.

### Agent Plugin (portable bundle format)

The MCP package doubles as an
[Agent Plugin](https://agent-plugins.org) package. Point any Agent
Plugins-capable client at the package root:

```
node_modules/@cckyros/goal-acceptance-mcp/
├── plugin.json    # Agent Plugin manifest
├── mcp.json       # stdio MCP server config
└── skills/        # Portable Agent Skills
    ├── set-acceptance-criteria/SKILL.md
    ├── get-acceptance-criteria/SKILL.md
    ├── validate-criterion/SKILL.md
    ├── update-task-status/SKILL.md
    ├── amend-acceptance-criteria/SKILL.md
    └── can-complete-goal/SKILL.md
```

The client will discover the skills, start the stdio MCP server, and surface
the tools.

### DeepSeek Harness (Cordis plugin)

The Cordis plugin is the only variant that can **force** the agent to continue
working when it tries to stop early. It intercepts `agent/turn-stopping` and
steers the agent back with dependency-aware priority ordering.

```sh
npm install @cckyros/goal-acceptance
```

```yaml
# cordis.yml
plugins:
  goal-acceptance:
    autoSteerUncompleted: true
    maxSteeringTurns: 5
```

The plugin:
- Registers 5 model tools (`set/get/validate_acceptance_criteria`, `update_task_status`, `amend_acceptance_criteria`)
- Injects a `policy:goal-acceptance` system prompt section with task progress and next-actionable ordering
- Intercepts `agent/turn-stopping` and steers the agent back with dependency-aware
  priority ordering when required criteria are still pending

> **Note**: The Cordis plugin requires DeepSeek Harness packages as peer
> dependencies. It will not build standalone without the Harness workspace. The
> core and MCP packages build independently.

## MCP Tools

| Tool | Description |
|------|-------------|
| `set_acceptance_criteria` | Lock the criteria list. Each criterion may link to task IDs and declare dependencies. Optional `role` parameter (`agent`/`reviewer`/`dual`, default `dual`) controls self-claim behavior. Must be called before implementation. |
| `get_acceptance_criteria` | Read current criteria, task progress, summary, task plan, ready-to-validate list, and next-actionable ordering. Optional `verbose` parameter (default `true`; pass `false` for slim summary only). |
| `set_task_plan` | Set and lock the task decomposition plan. Each task must have a unique id, unambiguous description, and concrete deliverable. Dependency cycles are rejected. Requires criteria to be locked first. |
| `get_task_plan` | Read the current task decomposition plan with live task statuses. |
| `validate_criterion` | Record status (`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`) and evidence. `passed` and `failed` require evidence. Optional `evidence_type` (`command`/`file`/`url`/`text`, default `text`). When `role=agent`, `passed` is marked self-claimed. Optional `verbose` (default `false`). |
| `update_task_status` | Update a linked task's status (`pending`/`in_progress`/`completed`/`failed`). When all tasks linked to a criterion are completed, it becomes ready to validate. Optional `verbose` (default `false`). |
| `amend_acceptance_criteria` | Append new criteria after the initial lock. Requires a reason. Existing criteria are not modified. |
| `can_complete_goal` | Check whether all required criteria are formally passed (self-claimed does not count). Returns `{ allowed: boolean, reason?: string }`. |

## Criterion Status Lifecycle

```
                    ┌──────────┐
                    │ pending  │ ← initial state after setCriteria
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │in_progress│ │ passed │ │ failed │
        └──────────┘ └────────┘ └────────┘
              │          │          │
              │          │     ┌────────┐
              │          │     │blocked │
              │          │     └────────┘
              │          │     ┌────────┐
              └──────────┘─────│not_run │
                                └────────┘
```

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

- `goal-acceptance/set` — locks the criteria list (with role)
- `goal-acceptance/task-plan` — locks the task decomposition plan
- `goal-acceptance/validate` — updates one criterion's status (with evidence type, self-claimed flag)
- `goal-acceptance/task-update` — updates a linked task's status
- `goal-acceptance/amend` — appends new criteria after the initial lock

On every read, the engine replays events from the store. This enables:

- Durable persistence (file, database, session log)
- Replay-exact state restoration
- Audit trail of all decisions

### Custom Store

Implement `GoalAcceptanceStore` for your persistence backend:

```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from '@cckyros/goal-acceptance-core'

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

| Capability | Cordis plugin | MCP server | Agent Plugin | OpenClaw native |
|------------|:---:|:---:|:---:|:---:|
| Model tools | `set/get/validate/update_task/amend` | 8 tools (see [MCP Tools](#mcp-tools)) | same as MCP | same as MCP (in-process) |
| System prompt / Skills | `policy:goal-acceptance` | `skills/` | `skills/` | `skills/` |
| Turn-stopping enforcement | yes (`agent.steer()`, dependency-aware) | no | no | no |
| Cross-client portable | no (Harness only) | yes (any MCP client) | yes (any Agent Plugins client) | no (OpenClaw only) |
| Persistent state | `dsh-session` log | `$PLUGIN_DATA/acceptance-events.json` | same as MCP | same as MCP |
| Dual-role validation | no | yes (`role` parameter) | yes | yes |
| Typed evidence | no | yes (`evidence_type` parameter) | yes | yes |
| Task decomposition plan | no | yes (`set_task_plan` / `get_task_plan`) | yes | yes |
| Slim responses | no | yes (`verbose` parameter) | yes | yes |
| In-process calls (no stdio) | yes | no | no | yes |

The Cordis plugin is the only variant that can **force** the agent to continue
working when it tries to stop early. The MCP, Agent Plugin, and OpenClaw native
variants rely on the model voluntarily calling the tools and following skill
instructions.

## Repository Layout

```
packages/
├── goal-acceptance-core/       # Zero-dependency state machine
│   ├── src/
│   │   ├── engine.ts           # GoalAcceptanceEngine (criteria + tasks + deps + amend)
│   │   ├── store.ts            # GoalAcceptanceStore + InMemoryAcceptanceStore
│   │   ├── types.ts            # GoalCriterion, AcceptanceSummary, events, task types
│   │   ├── errors.ts           # GoalAcceptanceError
│   │   └── index.ts            # Public exports
│   └── tests/
│       ├── engine.spec.ts      # 51 tests
│       └── standalone.spec.ts  # 1 test
├── goal-acceptance-mcp/        # MCP server + Agent Plugin
│   ├── src/
│   │   ├── mcp-server.ts       # stdio MCP server, 8 tools
│   │   ├── store.ts            # FileAcceptanceStore
│   │   └── index.ts
│   ├── bin/mcp-server.mjs      # Built stdio entry point
│   ├── plugin.json             # Agent Plugins manifest
│   ├── mcp.json                # MCP server config
│   ├── skills/                 # Portable Agent Skills (8 skills)
│   └── tests/
│       └── mcp-server.spec.ts  # 22 tests
├── goal-acceptance-openclaw/   # OpenClaw native plugin
│   ├── src/
│   │   └── index.ts            # defineToolPlugin, 8 tools (in-process)
│   ├── dist/index.js           # Built entry point
│   ├── openclaw.plugin.json    # OpenClaw plugin manifest
│   └── skills/                 # Portable Agent Skills (8 skills)
└── goal-acceptance/            # DeepSeek Harness Cordis plugin
    ├── src/
    │   ├── index.ts            # apply(): service + tools + prompt + dependency-aware steering
    │   ├── service.ts          # GoalAcceptanceService (per-agent engine)
    │   ├── store.ts            # SessionAcceptanceStore (dsh-session adapter)
    │   ├── tools.ts            # 5 model tools
    │   ├── prompt.ts           # System prompt section with task progress
    │   ├── types.ts            # SessionEventMap declarations
    │   └── invariant.ts        # Runtime invariant
    └── tests/
        ├── service.spec.ts     # 5 tests
        ├── tools.spec.ts       # 3 tests
        ├── plugin.spec.ts      # 4 tests
        └── invariant.spec.ts   # 1 test
```

## Build

```sh
pnpm install
pnpm run build
```

This builds the core and MCP packages. The Cordis plugin (`goal-acceptance`)
requires the DeepSeek Harness workspace and is not built by default in this repo.

## Test

```sh
pnpm install
pnpm test
```

## License

MIT
