# @cckyros/goal-acceptance-core

Framework-agnostic core for managing and validating goal acceptance criteria.

This package contains no Cordis, Harness, or session dependencies. It exposes a
stateful `GoalAcceptanceEngine` over an abstract `GoalAcceptanceStore` and can be
used in any JavaScript/TypeScript runtime (DeepSeek Harness, OpenClaw, Cursor,
Claude Code, tests, or standalone scripts).

For Agent Plugins and MCP packaging, see `@cckyros/goal-acceptance-mcp`.

## Usage

```ts
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

await engine.setCriteria([
  { id: 'api-200', description: 'API health endpoint returns 200', required: true, method: 'test' },
  { id: 'docs', description: 'README updated', required: false },
])

await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'GET /health returned 200 OK',
})

console.log(engine.summarize())
console.log(engine.canComplete())
```

## Usage in OpenClaw

`@cckyros/goal-acceptance-core` has no Cordis/Harness peer dependencies. You can
`npm install` it into an OpenClaw (or any other Node.js agent) project and wire
it into a skill:

```ts
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'

// Inside an OpenClaw skill context
const store = new InMemoryAcceptanceStore() // or a custom store backed by OpenClaw's memory
const acceptance = new GoalAcceptanceEngine(store)

// Expose as skill commands
export async function setGoalCriteria(criteria) {
  return acceptance.setCriteria(criteria)
}

export async function validateGoalCriterion(criterionId, status, evidence) {
  return acceptance.validateCriterion({ criterionId, status, evidence })
}

export function goalCompletionStatus() {
  return acceptance.canComplete()
}
```

For persistence across OpenClaw turns, implement `GoalAcceptanceStore` with a
backend that survives the skill's lifecycle (e.g. a JSON file or OpenClaw's
conversation state).

## Store interface

Implement `GoalAcceptanceStore` to persist events in your own backend:

```ts
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from '@cckyros/goal-acceptance-core'

class MyStore implements GoalAcceptanceStore {
  private readonly _events: GoalAcceptanceEvent[] = []

  get events(): readonly GoalAcceptanceEvent[] {
    return this._events
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // write to file, database, session log, etc.
    this._events.push(event)
  }
}
```

## Status model

- `pending` / `in_progress` - not yet verified
- `passed` / `failed` - terminal outcomes; requires evidence
- `blocked` - cannot be verified in this environment
- `not_run` - explicitly skipped

`canComplete()` returns `allowed: true` only when all `required: true` criteria are `passed`.
