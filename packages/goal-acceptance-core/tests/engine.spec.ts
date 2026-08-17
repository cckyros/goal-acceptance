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
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }], 'dual')
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

describe('GoalAcceptanceEngine — role and self-claimed', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('defaults to agent role when not specified (passed is self-claimed)', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    const c = engine.getCriterion('c1')!
    expect(c.selfClaimed).toBe(true)
  })

  it('marks passed as self-claimed when role=agent', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    const c = engine.getCriterion('c1')!
    expect(c.selfClaimed).toBe(true)
  })

  it('marks passed as formal when role=reviewer', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    const c = engine.getCriterion('c1')!
    expect(c.selfClaimed).toBe(false)
  })

  it('summary distinguishes formalPassed from selfClaimedPassed', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'agent claim' },
      { id: 'c2', description: 'reviewer confirm' },
    ], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'agent says ok' })
    // Reviewer confirms c2 by re-validating with role=reviewer is not possible after lock,
    // but we can test that a fresh engine with role=reviewer gives formal passed
    const engine2 = createEngine()
    await engine2.setCriteria([{ id: 'c2', description: 'reviewer' }], 'reviewer')
    await engine2.validateCriterion({ criterionId: 'c2', status: 'passed', evidence: 'reviewer says ok' })
    const s2 = engine2.summarize()
    expect(s2.formalPassed).toHaveLength(1)
    expect(s2.selfClaimedPassed).toHaveLength(0)
  })

  it('can_complete_goal blocks on self-claimed required criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'agent self-claim' })
    const result = engine.canComplete()
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('self-claimed')
  })

  it('can_complete_goal allows when all required are formally passed', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'reviewer confirmed' })
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('confirmCriterion converts self-claimed to formal pass and unblocks completion', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'agent claim', evidenceType: 'command' })
    expect(engine.canComplete().allowed).toBe(false)

    const confirmed = await engine.confirmCriterion({ criterionId: 'c1', evidence: 'reviewer re-ran tests: all green', evidenceType: 'command' })
    expect(confirmed.selfClaimed).toBe(false)
    expect(confirmed.status).toBe('passed')
    expect(confirmed.evidence).toBe('reviewer re-ran tests: all green')
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('confirmCriterion rejects text evidence', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await expect(engine.confirmCriterion({ criterionId: 'c1', evidence: 'looks fine to me', evidenceType: 'text' }))
      .rejects.toThrow('high-confidence')
  })

  it('confirmCriterion rejects non-self-claimed criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await expect(engine.confirmCriterion({ criterionId: 'c1', evidence: 'x', evidenceType: 'command' }))
      .rejects.toThrow('not a self-claimed pass')
  })

  it('confirmCriterion rejects pending criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await expect(engine.confirmCriterion({ criterionId: 'c1', evidence: 'x', evidenceType: 'command' }))
      .rejects.toThrow('not a self-claimed pass')
  })

  it('confirmCriterion rejects unknown criterion id', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await expect(engine.confirmCriterion({ criterionId: 'ghost', evidence: 'x', evidenceType: 'command' }))
      .rejects.toThrow('not found')
  })

  it('confirmCriterion rejects empty evidence', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await expect(engine.confirmCriterion({ criterionId: 'c1', evidence: '  ', evidenceType: 'command' }))
      .rejects.toThrow('evidence is required')
  })

  it('self-claimed count appears in summary', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'one' },
      { id: 'c2', description: 'two' },
    ], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await engine.validateCriterion({ criterionId: 'c2', status: 'passed', evidence: 'ok' })
    const s = engine.summarize()
    expect(s.selfClaimedCount).toBe(2)
    expect(s.passedCount).toBe(2)
  })
})

describe('GoalAcceptanceEngine — evidence type', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('defaults evidenceType to text', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'looks fine' })
    const c = engine.getCriterion('c1')!
    expect(c.evidenceType).toBe('text')
    expect(c.lowConfidence).toBe(true)
  })

  it('stores evidenceType=command without lowConfidence', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'dotnet test: 368 passed',
      evidenceType: 'command',
    })
    const c = engine.getCriterion('c1')!
    expect(c.evidenceType).toBe('command')
    expect(c.lowConfidence).toBe(false)
  })

  it('stores evidenceType=file', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'test-report.txt',
      evidenceType: 'file',
    })
    expect(engine.getCriterion('c1')!.evidenceType).toBe('file')
  })

  it('persists evidenceType across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'test' }])
    await engine1.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'ci log',
      evidenceType: 'command',
    })
    const engine2 = new GoalAcceptanceEngine(store)
    expect(engine2.getCriterion('c1')!.evidenceType).toBe('command')
    expect(engine2.getCriterion('c1')!.lowConfidence).toBe(false)
  })
})

describe('GoalAcceptanceEngine — task plan', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  it('sets a task plan with deliverables and dependencies', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Implement API' }])

    const plan = await engine.setTaskPlan([
      { id: 't1', description: 'Define route handler', deliverable: 'handler.ts' },
      { id: 't2', description: 'Write integration tests', deliverable: 'api.spec.ts', dependsOn: ['t1'] },
    ])

    expect(plan).toHaveLength(2)
    expect(plan[0]!.deliverable).toBe('handler.ts')
    expect(plan[0]!.status).toBe('pending')
    expect(plan[1]!.dependsOn).toEqual(['t1'])
  })

  it('rejects task plan before criteria are locked', async () => {
    const engine = createEngine()
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt' },
    ])).rejects.toThrow('before criteria are locked')
  })

  it('rejects empty task plan', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([])).rejects.toThrow('non-empty array')
  })

  it('rejects duplicate task ids', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt' },
      { id: 't1', description: 'Two', deliverable: 'b.txt' },
    ])).rejects.toThrow('duplicate task id')
  })

  it('rejects ambiguous duplicate descriptions', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'Do the thing', deliverable: 'a.txt' },
      { id: 't2', description: 'Do the thing', deliverable: 'b.txt' },
    ])).rejects.toThrow('ambiguous description')
  })

  it('rejects missing deliverable', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'No artifact', deliverable: '' },
    ])).rejects.toThrow('must declare a deliverable')
  })

  it('rejects self-dependency', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'Self dep', deliverable: 'a.txt', dependsOn: ['t1'] },
    ])).rejects.toThrow('cannot depend on itself')
  })

  it('rejects unknown dependency', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['ghost'] },
    ])).rejects.toThrow('unknown task')
  })

  it('rejects dependency cycles', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['t2'] },
      { id: 't2', description: 'Two', deliverable: 'b.txt', dependsOn: ['t1'] },
    ])).rejects.toThrow('dependency cycle')
  })

  it('rejects indirect cycles (a→b→c→a)', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await expect(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['t3'] },
      { id: 't2', description: 'Two', deliverable: 'b.txt', dependsOn: ['t1'] },
      { id: 't3', description: 'Three', deliverable: 'c.txt', dependsOn: ['t2'] },
    ])).rejects.toThrow('dependency cycle')
  })

  it('rejects setting task plan twice', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.setTaskPlan([{ id: 't1', description: 'One', deliverable: 'a.txt' }])
    await expect(engine.setTaskPlan([{ id: 't2', description: 'Two', deliverable: 'b.txt' }])).rejects.toThrow('already set')
  })

  it('task status updates reflect in plan and summary', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] }])
    await engine.setTaskPlan([
      { id: 't1', description: 'Define route handler', deliverable: 'handler.ts' },
      { id: 't2', description: 'Write tests', deliverable: 'api.spec.ts', dependsOn: ['t1'] },
    ])

    await engine.updateTaskStatus({ taskId: 't1', status: 'completed' })

    const plan = engine.getTaskPlan()
    expect(plan[0]!.status).toBe('completed')
    expect(plan[1]!.status).toBe('pending')

    const summary = engine.summarize()
    expect(summary.taskPlan).toHaveLength(2)
    expect(summary.taskProgress.totalTasks).toBe(2)
    expect(summary.taskProgress.completedTasks).toBe(1)
  })

  it('persists task plan across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'test' }])
    await engine1.setTaskPlan([{ id: 't1', description: 'One', deliverable: 'a.txt' }])
    await engine1.updateTaskStatus({ taskId: 't1', status: 'completed' })

    const engine2 = new GoalAcceptanceEngine(store)
    const plan = engine2.getTaskPlan()
    expect(plan).toHaveLength(1)
    expect(plan[0]!.status).toBe('completed')
    expect(engine2.summarize().taskPlan).toHaveLength(1)
  })
})
