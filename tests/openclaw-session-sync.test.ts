// OpenClaw session-goal mirror tests.
// Verifies that the plugin writes the canonical `SessionEntry.goal` slot
// when an active OpenClaw session is available.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GoalManager } from '../src/plugin/goal-manager.ts'
import { clearSessionGoal, syncSessionGoal } from '../src/plugin/openclaw-session-sync.ts'

function makeApi(store: Record<string, Record<string, { goal?: unknown }>> = {}) {
  return {
    runtime: {
      agent: {
        session: {
          getSessionEntry: ({ sessionKey, agentId }: { sessionKey: string; agentId: string }) => {
            return store[agentId]?.[sessionKey] as { goal?: unknown } | undefined
          },
          patchSessionEntry: async ({ sessionKey, agentId, update }: any) => {
            store[agentId] ??= {}
            const entry = store[agentId]![sessionKey] ?? {}
            const patch = update(entry)
            if (patch?.goal === undefined) {
              delete (entry as any).goal
            } else {
              ;(entry as any).goal = patch.goal
            }
            store[agentId]![sessionKey] = entry
            return entry
          },
        },
      },
    },
    logger: { warn: (_m: string) => { /* noop */ } },
  } as any
}

function makeToolContext(sessionKey: string, agentId: string): any {
  return { sessionKey, agentId, agentDir: '/tmp/agent', workspaceDir: '/tmp/workspace' }
}

test('syncSessionGoal writes a SessionGoal when a goal is active', async () => {
  const manager = new GoalManager('')
  manager.startGoal('ship the fix')
  await manager.getEngine().setCriteria([
    { id: 'c1', description: 'find the bug' },
    { id: 'c2', description: 'write the patch' },
  ], 'dual')

  const store: Record<string, Record<string, { goal?: unknown }>> = {}
  const api = makeApi(store)
  const toolContext = makeToolContext('agent:main:run-1', 'main')

  await syncSessionGoal({ api, toolContext, manager })

  const goal = store.main?.['agent:main:run-1']?.goal as any
  assert.ok(goal, 'SessionEntry.goal should be set')
  assert.equal(goal.objective, 'ship the fix')
  assert.equal(goal.status, 'active')
  assert.equal(goal.tokenStart, 0)
  assert.equal(goal.tokensUsed, 0)
  assert.equal(goal.continuationTurns, 0)
})

test('syncSessionGoal flips status to complete when all required criteria pass', async () => {
  const manager = new GoalManager('')
  manager.startGoal('ship the fix')
  await manager.getEngine().setCriteria([{ id: 'c1', description: 'find the bug' }], 'dual')
  await manager.getEngine().validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'found it', evidenceType: 'text' })

  const store: Record<string, Record<string, { goal?: unknown }>> = {}
  const api = makeApi(store)
  const toolContext = makeToolContext('agent:main:run-2', 'main')

  await syncSessionGoal({ api, toolContext, manager })

  const goal = store.main?.['agent:main:run-2']?.goal as any
  assert.ok(goal)
  assert.equal(goal.status, 'complete')
})

test('syncSessionGoal preserves an existing blocked status for the same goal', async () => {
  const manager = new GoalManager('')
  manager.startGoal('ship the fix')
  await manager.getEngine().setCriteria([
    { id: 'c1', description: 'find the bug' },
  ], 'dual')

  const store: Record<string, Record<string, { goal?: unknown }>> = {
    main: { 'agent:main:run-3': { goal: { id: manager.getCurrentGoalId(), status: 'blocked' } } },
  }
  const api = makeApi(store)
  const toolContext = makeToolContext('agent:main:run-3', 'main')

  await syncSessionGoal({ api, toolContext, manager })

  const goal = store.main?.['agent:main:run-3']?.goal as any
  assert.equal(goal.status, 'blocked')
})

test('syncSessionGoal overwrites stale blocked status when the goal becomes complete', async () => {
  const manager = new GoalManager('')
  manager.startGoal('ship the fix')
  await manager.getEngine().setCriteria([{ id: 'c1', description: 'find the bug' }], 'dual')
  await manager.getEngine().validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'found it', evidenceType: 'text' })

  const store: Record<string, Record<string, { goal?: unknown }>> = {
    main: { 'agent:main:run-4': { goal: { id: manager.getCurrentGoalId(), status: 'blocked' } } },
  }
  const api = makeApi(store)
  const toolContext = makeToolContext('agent:main:run-4', 'main')

  await syncSessionGoal({ api, toolContext, manager })

  const goal = store.main?.['agent:main:run-4']?.goal as any
  assert.equal(goal.status, 'complete')
})

test('syncSessionGoal does nothing when no session context is available', async () => {
  const manager = new GoalManager('')
  manager.startGoal('ship the fix')

  const store: Record<string, Record<string, { goal?: unknown }>> = {}
  const api = makeApi(store)
  const toolContext = { sessionKey: undefined, agentId: undefined } as any

  await syncSessionGoal({ api, toolContext, manager })

  assert.equal(store.main, undefined)
})

test('clearSessionGoal removes the SessionEntry.goal', async () => {
  const manager = new GoalManager('')

  const store: Record<string, Record<string, { goal?: unknown }>> = {
    main: { 'agent:main:run-5': { goal: { id: 'old-goal', status: 'active' } } },
  }
  const api = makeApi(store)
  const toolContext = makeToolContext('agent:main:run-5', 'main')

  await clearSessionGoal({ api, toolContext })

  assert.equal(store.main?.['agent:main:run-5']?.goal, undefined)
})
