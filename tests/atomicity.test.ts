/**
 * F4 research topic: prove (or disprove) claim_task atomicity.
 *
 * claimTask is check-then-act: sync() → readyTasks() → await append.
 * Two concurrent claimants can interleave at the await and both win.
 * These tests are EXPECTED TO FAIL on an unguarded implementation —
 * that failure is the design evidence for the locking mechanism.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'
import { GoalAcceptanceEngine } from '../src/plugin/engine/index.ts'
import { FileAcceptanceStore } from '../src/plugin/goal-manager.ts'
import type { GoalAcceptanceEvent } from '../src/plugin/engine/index.ts'

function setupGoalFile(): { path: string; engine: (id: string) => Promise<GoalAcceptanceEngine> } {
  const dir = mkdtempSync(join(os.tmpdir(), 'ga-atomicity-'))
  const path = join(dir, 'goal.json')
  return {
    path,
    engine: async () => {
      const e = new GoalAcceptanceEngine(new FileAcceptanceStore(path))
      return e
    },
  }
}

async function seed(path: string): Promise<void> {
  const engine = new GoalAcceptanceEngine(new FileAcceptanceStore(path))
  await engine.setCriteria([
    { id: 'c1', description: 'c1', taskIds: ['t1'] },
    { id: 'c2', description: 'c2', taskIds: ['t2'] },
  ])
  await engine.setTaskPlan([
    { id: 't1', description: 'task one', deliverable: 'a' },
    { id: 't2', description: 'task two', deliverable: 'b' },
  ])
}

function countInProgressEvents(path: string, taskId: string): number {
  const events = JSON.parse(readFileSync(path, 'utf-8')) as GoalAcceptanceEvent[]
  return events.filter(
    e => e.type === 'goal-acceptance/task-update' && e.taskId === taskId && e.taskStatus === 'in_progress',
  ).length
}

describe('claim_task atomicity (F4)', () => {
  it('Q1: N concurrent claimants on the same task — exactly one must win', async () => {
    const { path, engine } = setupGoalFile()
    await seed(path)

    const N = 8
    const engines = await Promise.all(Array.from({ length: N }, () => engine('e')))
    const results = await Promise.allSettled(engines.map(e => e.claimTask('t1')))

    const wins = results.filter(r => r.status === 'fulfilled')
    const losses = results.filter(r => r.status === 'rejected')
    // Exactly one successful claim; losers get TASK_NOT_CLAIMABLE.
    assert.equal(wins.length, 1, `expected exactly 1 claimant to win, got ${wins.length}`)
    for (const l of losses) {
      assert.equal((l.reason as { code?: string }).code, 'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE')
    }
    // The event log records the task entering in_progress exactly once.
    assert.equal(countInProgressEvents(path, 't1'), 1)
  })

  it('Q1b: concurrent frontier claims on different tasks — each task exactly once', async () => {
    const { path, engine } = setupGoalFile()
    await seed(path)

    const engines = await Promise.all([engine('a'), engine('b'), engine('c'), engine('d')])
    const results = await Promise.allSettled(engines.map(e => e.claimTask()))
    const claimed = results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<{ task: { id: string } | null }>).value.task?.id)
      .filter(Boolean)
    // Both independent tasks claimed at most once; no task claimed twice.
    assert.equal(new Set(claimed).size, claimed.length, `double-claim detected: ${claimed.join(',')}`)
    for (const id of claimed) {
      assert.equal(countInProgressEvents(path, id!), 1)
    }
  })
})
