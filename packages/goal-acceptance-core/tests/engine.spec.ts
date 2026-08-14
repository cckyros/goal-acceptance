import { describe, expect, it } from 'vitest'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '../src/index.ts'

describe('GoalAcceptanceEngine', () => {
  function createEngine() {
    const store = new InMemoryAcceptanceStore()
    return { engine: new GoalAcceptanceEngine(store), store }
  }

  it('sets and locks criteria', async () => {
    const { engine } = createEngine()
    const criteria = await engine.setCriteria([
      { id: 'c1', description: 'API returns 200' },
      { id: 'c2', description: 'Docs updated', required: false },
    ])

    expect(criteria).toHaveLength(2)
    expect(criteria[0]!.required).toBe(true)
    expect(criteria[1]!.required).toBe(false)
    expect(criteria[0]!.status).toBe('pending')
    expect(criteria[0]!.taskIds).toEqual([])
    expect(criteria[0]!.dependsOn).toEqual([])

    const all = engine.getCriteria()
    expect(all).toHaveLength(2)
  })

  it('rejects empty criteria', async () => {
    const { engine } = createEngine()
    await expect(engine.setCriteria([])).rejects.toThrow('criteria list must be a non-empty array')
  })

  it('rejects duplicate ids', async () => {
    const { engine } = createEngine()
    await expect(engine.setCriteria([
      { id: 'c1', description: 'One' },
      { id: 'c1', description: 'Two' },
    ])).rejects.toThrow('duplicate criterion id')
  })

  it('rejects setting criteria twice', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await expect(engine.setCriteria([{ id: 'c2', description: 'Two' }])).rejects.toThrow('already locked')
  })

  it('validates a criterion with evidence', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200', method: 'test' }])

    const updated = await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'GET /health returned 200',
    })

    expect(updated.status).toBe('passed')
    expect(updated.evidence).toBe('GET /health returned 200')
    expect(engine.summarize().passedCount).toBe(1)
  })

  it('rejects validation without evidence for passed/failed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }])
    await expect(engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
    })).rejects.toThrow('evidence is required')
  })

  it('rejects validation of unknown criterion', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await expect(engine.validateCriterion({
      criterionId: 'missing',
      status: 'blocked',
    })).rejects.toThrow('not found')
  })

  it('summarizes all statuses and blocks completion', () => {
    const { engine } = createEngine()
    const summary = engine.summarize()
    expect(summary.totalCount).toBe(0)
    expect(summary.allRequiredPassed).toBe(true)
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('canComplete blocks when required criteria not passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Pass 1' },
      { id: 'c2', description: 'Pass 2' },
    ])

    const result = engine.canComplete()
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('required acceptance criteria')
  })

  it('canComplete allows when all required passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }])
    await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: '200 OK',
    })
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('replays state from store events', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'One' }])
    await engine1.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })

    const engine2 = new GoalAcceptanceEngine(store)
    expect(engine2.summarize().passedCount).toBe(1)
  })
})

describe('GoalAcceptanceEngine — task linking', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('stores taskIds on criteria', async () => {
    const engine = createEngine()
    const criteria = await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['task-1', 'task-2'] },
    ])
    expect(criteria[0]!.taskIds).toEqual(['task-1', 'task-2'])
  })

  it('tracks task progress in summary', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    const summary = engine.summarize()
    expect(summary.taskProgress.totalTasks).toBe(2)
    expect(summary.taskProgress.pendingTasks).toBe(2)
    expect(summary.taskProgress.completedTasks).toBe(0)
  })

  it('updates task status and reflects in progress', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    await engine.updateTaskStatus({ taskId: 't1', status: 'completed' })
    await engine.updateTaskStatus({ taskId: 't2', status: 'in_progress' })

    const summary = engine.summarize()
    expect(summary.taskProgress.completedTasks).toBe(1)
    expect(summary.taskProgress.inProgressTasks).toBe(1)
    expect(summary.taskProgress.pendingTasks).toBe(0)
  })

  it('marks criterion readyToValidate when all tasks completed', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    await engine.updateTaskStatus({ taskId: 't1', status: 'completed' })
    await engine.updateTaskStatus({ taskId: 't2', status: 'completed' })

    const summary = engine.summarize()
    expect(summary.readyToValidate).toHaveLength(1)
    expect(summary.readyToValidate[0]!.id).toBe('c1')
  })

  it('does not mark readyToValidate when tasks incomplete', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1'] },
    ])
    await engine.updateTaskStatus({ taskId: 't1', status: 'in_progress' })

    const summary = engine.summarize()
    expect(summary.readyToValidate).toHaveLength(0)
  })

  it('persists task updates across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'API', taskIds: ['t1'] }])
    await engine1.updateTaskStatus({ taskId: 't1', status: 'completed' })

    const engine2 = new GoalAcceptanceEngine(store)
    const summary = engine2.summarize()
    expect(summary.taskProgress.completedTasks).toBe(1)
    expect(summary.readyToValidate).toHaveLength(1)
  })
})

describe('GoalAcceptanceEngine — dependencies', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('stores dependsOn on criteria', async () => {
    const engine = createEngine()
    const criteria = await engine.setCriteria([
      { id: 'c1', description: 'Write code' },
      { id: 'c2', description: 'Run tests', dependsOn: ['c1'] },
    ])
    expect(criteria[1]!.dependsOn).toEqual(['c1'])
  })

  it('nextActionable excludes criteria with unmet dependencies', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Write code' },
      { id: 'c2', description: 'Run tests', dependsOn: ['c1'] },
    ])

    const summary = engine.summarize()
    const actionableIds = summary.nextActionable.map(c => c.id)
    expect(actionableIds).toContain('c1')
    expect(actionableIds).not.toContain('c2')
  })

  it('nextActionable includes criteria after dependencies pass', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Write code' },
      { id: 'c2', description: 'Run tests', dependsOn: ['c1'] },
    ])

    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'code written' })

    const summary = engine.summarize()
    const actionableIds = summary.nextActionable.map(c => c.id)
    expect(actionableIds).toContain('c2')
    expect(actionableIds).not.toContain('c1')
  })

  it('topologically orders nextActionable', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c3', description: 'Deploy', dependsOn: ['c2'] },
      { id: 'c1', description: 'Write code' },
      { id: 'c2', description: 'Test', dependsOn: ['c1'] },
    ])

    const summary = engine.summarize()
    const ids = summary.nextActionable.map(c => c.id)
    expect(ids[0]).toBe('c1')
    expect(ids).toHaveLength(1)
  })
})

describe('GoalAcceptanceEngine — amend', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('appends new criteria after lock', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])

    const added = await engine.amendCriteria({
      criteria: [{ id: 'c2', description: 'Added later' }],
      reason: 'User requested additional check',
    })

    expect(added).toHaveLength(1)
    expect(added[0]!.id).toBe('c2')
    expect(added[0]!.addedAfterLock).toBe(true)
    expect(added[0]!.addedAt).toBeTypeOf('number')

    const all = engine.getCriteria()
    expect(all).toHaveLength(2)
  })

  it('rejects amend before lock', async () => {
    const engine = createEngine()
    await expect(engine.amendCriteria({
      criteria: [{ id: 'c1', description: 'One' }],
      reason: 'test',
    })).rejects.toThrow('cannot amend before')
  })

  it('rejects amend with duplicate id', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])

    await expect(engine.amendCriteria({
      criteria: [{ id: 'c1', description: 'Duplicate' }],
      reason: 'test',
    })).rejects.toThrow('already exists')
  })

  it('rejects amend without reason', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])

    await expect(engine.amendCriteria({
      criteria: [{ id: 'c2', description: 'New' }],
      reason: '',
    })).rejects.toThrow('reason is required')
  })

  it('amended criteria participate in completion gate', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })

    await engine.amendCriteria({
      criteria: [{ id: 'c2', description: 'Required addition' }],
      reason: 'scope expanded',
    })

    expect(engine.canComplete().allowed).toBe(false)
  })

  it('persists amend across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'Original' }])
    await engine1.amendCriteria({
      criteria: [{ id: 'c2', description: 'Added' }],
      reason: 'test',
    })

    const engine2 = new GoalAcceptanceEngine(store)
    expect(engine2.getCriteria()).toHaveLength(2)
    expect(engine2.getCriterion('c2')!.addedAfterLock).toBe(true)
  })
})
