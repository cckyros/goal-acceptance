# goal-acceptance

English | [中文](README.zh-CN.md)

Acceptance-criteria-driven goal completion for autonomous AI agents.

Prevents agents from prematurely declaring "done" by locking immutable acceptance
criteria before work begins, tracking validation status with evidence, and
enforcing completion checks.

## Why?

Autonomous agents (Claude Code, Cursor, OpenClaw, DeepSeek Harness, etc.) often
stop early — they say "I've finished" without actually verifying the work. This
project provides:

1. **A framework-agnostic state machine** that locks criteria, tracks evidence,
   and gates completion.
2. **An MCP server** any MCP-capable client can call.
3. **An Agent Plugin package** compatible with the
   [Agent Plugins](https://agent-plugins.org) standard.
4. **A Cordis plugin** for DeepSeek Harness with turn-stopping enforcement.

## Packages

| Package | Description | Dependencies |
|---------|-------------|--------------|
| [`@deepseek-ai/dsh-goal-acceptance-core`](packages/goal-acceptance-core) | Framework-agnostic state machine, types, errors, abstract store | None |
| [`@deepseek-ai/dsh-goal-acceptance-mcp`](packages/goal-acceptance-mcp) | MCP stdio server + Agent Plugin packaging (plugin.json, mcp.json, skills) | core, MCP SDK |
| [`@deepseek-ai/dsh-goal-acceptance`](packages/goal-acceptance) | DeepSeek Harness Cordis plugin with turn-stopping steering | core, Cordis, Harness |

## Architecture

```
                    ┌─────────────────────────────────────────────────┐
                    │  @deepseek-ai/dsh-goal-acceptance-core           │
                    │  (zero-dep state machine, event-sourced)         │
                    └────────────┬──────────────────┬──────────────────┘
                                 │                  │
                    ┌────────────┴────────┐ ┌──────┴───────────────────┐
                    │ dsh-goal-acceptance │ │ dsh-goal-acceptance-mcp  │
                    │ (Cordis plugin)     │ │ (MCP server + Agent      │
                    │                     │ │  Plugin packaging)       │
                    │ • turn-stopping     │ │ • stdio MCP server       │
                    │ • agent.steer()     │ │ • plugin.json + mcp.json │
                    │ • system prompt     │ │ • skills/ (Agent Skills) │
                    │ • tool registration │ │ • FileAcceptanceStore    │
                    └─────────────────────┘ └──────────────────────────┘
```

## Quick Start

### Core library (any JS/TS runtime)

```sh
npm install @deepseek-ai/dsh-goal-acceptance-core
```

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@deepseek-ai/dsh-goal-acceptance-core'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

// Lock criteria before work begins
await engine.setCriteria([
  { id: 'api-200', description: 'GET /health returns 200', required: true, method: 'test' },
  { id: 'docs', description: 'README updated', required: false, method: 'manual' },
])

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

### MCP server (OpenClaw, Claude Code, Cursor, etc.)

```sh
npm install @deepseek-ai/dsh-goal-acceptance-mcp
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "type": "stdio",
      "command": "node",
      "args": ["./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs"]
    }
  }
}
```

Or run standalone:

```sh
# In-memory (resets on restart)
node ./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs

# Persistent across restarts
PLUGIN_DATA=/path/to/data node ./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs
```

### Agent Plugin (portable format)

The MCP package doubles as an
[Agent Plugin](https://agent-plugins.org) package. Point any Agent
Plugins-capable client at the package root:

```
node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/
├── plugin.json    # Agent Plugin manifest
├── mcp.json       # stdio MCP server config
└── skills/        # Portable Agent Skills
    ├── set-acceptance-criteria/SKILL.md
    ├── validate-criterion/SKILL.md
    └── get-acceptance-criteria/SKILL.md
```

The client will discover the skills, start the stdio MCP server, and surface
the tools.

### DeepSeek Harness (Cordis plugin)

```sh
npm install @deepseek-ai/dsh-goal-acceptance
```

```yaml
# cordis.yml
plugins:
  goal-acceptance:
    autoSteerUncompleted: true
    maxSteeringTurns: 5
```

The plugin:
- Registers 3 model tools (`set/get/validate_acceptance_criteria`)
- Injects a `policy:goal-acceptance` system prompt section
- Intercepts `agent/turn-stopping` and steers the agent back when required
  criteria are still pending

## MCP Tools

| Tool | Description |
|------|-------------|
| `set_acceptance_criteria` | Lock the criteria list. Must be called before implementation. |
| `get_acceptance_criteria` | Read current criteria and summary. |
| `validate_criterion` | Record status (`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`) and evidence. `passed` and `failed` require evidence. |
| `can_complete_goal` | Check whether all required criteria are passed. |

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

- **Allowed**: all required criteria are `passed`, or no criteria are locked.
- **Not allowed**: any required criterion is `pending`, `in_progress`, `failed`,
  `blocked`, or `not_run`.

## Event Sourcing

The engine is event-sourced. The store holds an append-only list of:

- `goal-acceptance/set` — locks the criteria list
- `goal-acceptance/validate` — updates one criterion's status

On every read, the engine replays events from the store. This enables:

- Durable persistence (file, database, session log)
- Replay-exact state restoration
- Audit trail of all decisions

### Custom Store

Implement `GoalAcceptanceStore` for your persistence backend:

```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from '@deepseek-ai/dsh-goal-acceptance-core'

class MyDbStore implements GoalAcceptanceStore {
  get events(): readonly GoalAcceptanceEvent[] {
    // Return all events in append order
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // Persist the event
  }
}
```

## Three-Way Compatibility

| Capability | Cordis plugin | MCP server | Agent Plugin |
|------------|:---:|:---:|:---:|
| Model tools | `set/get/validate` | `set/get/validate/can_complete` | same as MCP |
| System prompt / Skills | `policy:goal-acceptance` | `skills/` | `skills/` |
| Turn-stopping enforcement | yes (`agent.steer()`) | no | no |
| Cross-client portable | no (Harness only) | yes (any MCP client) | yes (any Agent Plugins client) |
| Persistent state | `dsh-session` log | `$PLUGIN_DATA/acceptance-events.json` | same as MCP |

The Cordis plugin is the only variant that can **force** the agent to continue
working when it tries to stop early. The MCP and Agent Plugin variants rely on
the model voluntarily calling the tools and following skill instructions.

## Repository Layout

```
packages/
├── goal-acceptance-core/       # Zero-dependency state machine
│   ├── src/
│   │   ├── engine.ts           # GoalAcceptanceEngine
│   │   ├── store.ts            # GoalAcceptanceStore + InMemoryAcceptanceStore
│   │   ├── types.ts            # GoalCriterion, AcceptanceSummary, events
│   │   ├── errors.ts           # GoalAcceptanceError
│   │   └── index.ts            # Public exports
│   └── tests/
│       ├── engine.spec.ts      # 11 tests
│       └── standalone.spec.ts  # 1 test
├── goal-acceptance-mcp/        # MCP server + Agent Plugin
│   ├── src/
│   │   ├── mcp-server.ts       # stdio MCP server, 4 tools
│   │   ├── store.ts            # FileAcceptanceStore
│   │   └── index.ts
│   ├── bin/mcp-server.mjs      # Built stdio entry point
│   ├── plugin.json             # Agent Plugins manifest
│   ├── mcp.json                # MCP server config
│   ├── skills/                 # Portable Agent Skills
│   └── tests/
│       └── mcp-server.spec.ts  # 3 tests
└── goal-acceptance/            # DeepSeek Harness Cordis plugin
    ├── src/
    │   ├── index.ts            # apply(): service + tools + prompt + turn-stopping
    │   ├── service.ts          # GoalAcceptanceService (per-agent engine)
    │   ├── store.ts            # SessionAcceptanceStore (dsh-session adapter)
    │   ├── tools.ts            # 3 model tools
    │   ├── prompt.ts           # System prompt section
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

The Cordis plugin (`goal-acceptance`) requires DeepSeek Harness packages as peer
dependencies. It will not build standalone without the Harness workspace. The
core and MCP packages build independently.

## Test

```sh
pnpm install
pnpm test
```

## License

MIT
