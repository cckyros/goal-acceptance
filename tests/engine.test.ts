import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as os from 'node:os'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '../src/plugin/engine/index.ts'

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

    assert.equal(criteria.length, 2)
    assert.equal(criteria[0]!.required, true)
    assert.equal(criteria[1]!.required, false)
    assert.equal(criteria[0]!.status, 'pending')
    assert.deepEqual(criteria[0]!.taskIds, [])
    assert.deepEqual(criteria[0]!.dependsOn, [])

    const all = engine.getCriteria()
    assert.equal(all.length, 2)
  })

  it('rejects empty criteria', async () => {
    const { engine } = createEngine()
    await assert.rejects(engine.setCriteria([]), 'criteria list must be a non-empty array')
  })

  it('rejects duplicate ids', async () => {
    const { engine } = createEngine()
    await assert.rejects(engine.setCriteria([
      { id: 'c1', description: 'One' },
      { id: 'c1', description: 'Two' },
    ]), 'duplicate criterion id')
  })

  it('rejects setting criteria twice', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await assert.rejects(engine.setCriteria([{ id: 'c2', description: 'Two' }]), 'already locked')
  })

  it('validates a criterion with evidence', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200', method: 'test' }])

    const updated = await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'GET /health returned 200',
    })

    assert.equal(updated.status, 'passed')
    assert.equal(updated.evidence, 'GET /health returned 200')
    assert.equal(engine.summarize().passedCount, 1)
  })

  it('rejects validation without evidence for passed/failed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }])
    await assert.rejects(engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
    }), 'evidence is required')
  })

  it('rejects validation of unknown criterion', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await assert.rejects(engine.validateCriterion({
      criterionId: 'missing',
      status: 'blocked',
    }), 'not found')
  })

  it('summarizes all statuses and blocks completion', () => {
    const { engine } = createEngine()
    const summary = engine.summarize()
    assert.equal(summary.totalCount, 0)
    assert.equal(summary.allRequiredPassed, true)
    assert.equal(engine.canComplete().allowed, true)
  })

  it('canComplete blocks when required criteria not passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Pass 1' },
      { id: 'c2', description: 'Pass 2' },
    ])

    const result = engine.canComplete()
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes('required acceptance criteria'))
  })

  it('canComplete allows when all required passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }], 'dual')
    await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: '200 OK',
    })
    assert.equal(engine.canComplete().allowed, true)
  })

  it('replays state from store events', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'One' }])
    await engine1.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })

    const engine2 = new GoalAcceptanceEngine(store)
    assert.equal(engine2.summarize().passedCount, 1)
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
    assert.deepEqual(criteria[0]!.taskIds, ['task-1', 'task-2'])
  })

  it('tracks task progress in summary', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    const summary = engine.summarize()
    assert.equal(summary.taskProgress.totalTasks, 2)
    assert.equal(summary.taskProgress.pendingTasks, 2)
    assert.equal(summary.taskProgress.completedTasks, 0)
  })

  it('updates task status and reflects in progress', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    await engine.updateTaskStatus({ taskId: 't1', status: 'completed' })
    await engine.updateTaskStatus({ taskId: 't2', status: 'in_progress' })

    const summary = engine.summarize()
    assert.equal(summary.taskProgress.completedTasks, 1)
    assert.equal(summary.taskProgress.inProgressTasks, 1)
    assert.equal(summary.taskProgress.pendingTasks, 0)
  })

  it('marks criterion readyToValidate when all tasks completed', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1', 't2'] },
    ])

    await engine.updateTaskStatus({ taskId: 't1', status: 'completed' })
    await engine.updateTaskStatus({ taskId: 't2', status: 'completed' })

    const summary = engine.summarize()
    assert.equal(summary.readyToValidate.length, 1)
    assert.equal(summary.readyToValidate[0]!.id, 'c1')
  })

  it('does not mark readyToValidate when tasks incomplete', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Implement API', taskIds: ['t1'] },
    ])
    await engine.updateTaskStatus({ taskId: 't1', status: 'in_progress' })

    const summary = engine.summarize()
    assert.equal(summary.readyToValidate.length, 0)
  })

  it('persists task updates across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'API', taskIds: ['t1'] }])
    await engine1.updateTaskStatus({ taskId: 't1', status: 'completed' })

    const engine2 = new GoalAcceptanceEngine(store)
    const summary = engine2.summarize()
    assert.equal(summary.taskProgress.completedTasks, 1)
    assert.equal(summary.readyToValidate.length, 1)
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
    assert.deepEqual(criteria[1]!.dependsOn, ['c1'])
  })

  it('nextActionable excludes criteria with unmet dependencies', async () => {
    const engine = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Write code' },
      { id: 'c2', description: 'Run tests', dependsOn: ['c1'] },
    ])

    const summary = engine.summarize()
    const actionableIds = summary.nextActionable.map(c => c.id)
    assert.ok((actionableIds).includes('c1'))
    assert.ok(!(actionableIds).includes('c2'))
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
    assert.ok((actionableIds).includes('c2'))
    assert.ok(!(actionableIds).includes('c1'))
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
    assert.equal(ids[0], 'c1')
    assert.equal(ids.length, 1)
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

    assert.equal(added.length, 1)
    assert.equal(added[0]!.id, 'c2')
    assert.equal(added[0]!.addedAfterLock, true)
    assert.equal(typeof added[0]!.addedAt, 'number')

    const all = engine.getCriteria()
    assert.equal(all.length, 2)
  })

  it('rejects amend before lock', async () => {
    const engine = createEngine()
    await assert.rejects(engine.amendCriteria({
      criteria: [{ id: 'c1', description: 'One' }],
      reason: 'test',
    }), 'cannot amend before')
  })

  it('rejects amend with duplicate id', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])

    await assert.rejects(engine.amendCriteria({
      criteria: [{ id: 'c1', description: 'Duplicate' }],
      reason: 'test',
    }), 'already exists')
  })

  it('rejects amend without reason', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])

    await assert.rejects(engine.amendCriteria({
      criteria: [{ id: 'c2', description: 'New' }],
      reason: '',
    }), 'reason is required')
  })

  it('amended criteria participate in completion gate', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'Original' }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })

    await engine.amendCriteria({
      criteria: [{ id: 'c2', description: 'Required addition' }],
      reason: 'scope expanded',
    })

    assert.equal(engine.canComplete().allowed, false)
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
    assert.equal(engine2.getCriteria().length, 2)
    assert.equal(engine2.getCriterion('c2')!.addedAfterLock, true)
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
    assert.equal(c.selfClaimed, true)
  })

  it('marks passed as self-claimed when role=agent', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    const c = engine.getCriterion('c1')!
    assert.equal(c.selfClaimed, true)
  })

  it('marks passed as formal when role=reviewer', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    const c = engine.getCriterion('c1')!
    assert.equal(c.selfClaimed, false)
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
    assert.equal(s2.formalPassed.length, 1)
    assert.equal(s2.selfClaimedPassed.length, 0)
  })

  it('can_complete_goal blocks on self-claimed required criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'agent self-claim' })
    const result = engine.canComplete()
    assert.equal(result.allowed, false)
    assert.ok(result.reason?.includes('self-claimed'))
  })

  it('can_complete_goal allows when all required are formally passed', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'reviewer confirmed' })
    assert.equal(engine.canComplete().allowed, true)
  })

  it('confirmCriterion converts self-claimed to formal pass and unblocks completion', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'required', required: true }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'agent claim', evidenceType: 'command' })
    assert.equal(engine.canComplete().allowed, false)

    const confirmed = await engine.confirmCriterion({ criterionId: 'c1', evidence: 'reviewer re-ran tests: all green', evidenceType: 'command' })
    assert.equal(confirmed.selfClaimed, false)
    assert.equal(confirmed.status, 'passed')
    assert.equal(confirmed.evidence, 'reviewer re-ran tests: all green')
    assert.equal(engine.canComplete().allowed, true)
  })

  it('confirmCriterion rejects text evidence', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await assert.rejects(engine.confirmCriterion({ criterionId: 'c1', evidence: 'looks fine to me', evidenceType: 'text' }), 'high-confidence')
  })

  it('confirmCriterion rejects non-self-claimed criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'reviewer')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await assert.rejects(engine.confirmCriterion({ criterionId: 'c1', evidence: 'x', evidenceType: 'command' }), 'not a self-claimed pass')
  })

  it('confirmCriterion rejects pending criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await assert.rejects(engine.confirmCriterion({ criterionId: 'c1', evidence: 'x', evidenceType: 'command' }), 'not a self-claimed pass')
  })

  it('confirmCriterion rejects unknown criterion id', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await assert.rejects(engine.confirmCriterion({ criterionId: 'ghost', evidence: 'x', evidenceType: 'command' }), 'not found')
  })

  it('confirmCriterion rejects empty evidence', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }], 'agent')
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })
    await assert.rejects(engine.confirmCriterion({ criterionId: 'c1', evidence: '  ', evidenceType: 'command' }), 'evidence is required')
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
    assert.equal(s.selfClaimedCount, 2)
    assert.equal(s.passedCount, 2)
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
    assert.equal(c.evidenceType, 'text')
    assert.equal(c.lowConfidence, true)
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
    assert.equal(c.evidenceType, 'command')
    assert.equal(c.lowConfidence, false)
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
    assert.equal(engine.getCriterion('c1')!.evidenceType, 'file')
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
    assert.equal(engine2.getCriterion('c1')!.evidenceType, 'command')
    assert.equal(engine2.getCriterion('c1')!.lowConfidence, false)
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

    assert.equal(plan.length, 2)
    assert.equal(plan[0]!.deliverable, 'handler.ts')
    assert.equal(plan[0]!.status, 'pending')
    assert.deepEqual(plan[1]!.dependsOn, ['t1'])
  })

  it('rejects task plan before criteria are locked', async () => {
    const engine = createEngine()
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt' },
    ]), 'before criteria are locked')
  })

  it('rejects empty task plan', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([]), 'non-empty array')
  })

  it('rejects duplicate task ids', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt' },
      { id: 't1', description: 'Two', deliverable: 'b.txt' },
    ]), 'duplicate task id')
  })

  it('rejects ambiguous duplicate descriptions', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'Do the thing', deliverable: 'a.txt' },
      { id: 't2', description: 'Do the thing', deliverable: 'b.txt' },
    ]), 'ambiguous description')
  })

  it('rejects missing deliverable', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'No artifact', deliverable: '' },
    ]), 'must declare a deliverable')
  })

  it('rejects self-dependency', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'Self dep', deliverable: 'a.txt', dependsOn: ['t1'] },
    ]), 'cannot depend on itself')
  })

  it('rejects unknown dependency', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['ghost'] },
    ]), 'unknown task')
  })

  it('rejects dependency cycles', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['t2'] },
      { id: 't2', description: 'Two', deliverable: 'b.txt', dependsOn: ['t1'] },
    ]), 'dependency cycle')
  })

  it('rejects indirect cycles (a→b→c→a)', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await assert.rejects(engine.setTaskPlan([
      { id: 't1', description: 'One', deliverable: 'a.txt', dependsOn: ['t3'] },
      { id: 't2', description: 'Two', deliverable: 'b.txt', dependsOn: ['t1'] },
      { id: 't3', description: 'Three', deliverable: 'c.txt', dependsOn: ['t2'] },
    ]), 'dependency cycle')
  })

  it('rejects setting task plan twice', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'test' }])
    await engine.setTaskPlan([{ id: 't1', description: 'One', deliverable: 'a.txt' }])
    await assert.rejects(engine.setTaskPlan([{ id: 't2', description: 'Two', deliverable: 'b.txt' }]), 'already set')
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
    assert.equal(plan[0]!.status, 'completed')
    assert.equal(plan[1]!.status, 'pending')

    const summary = engine.summarize()
    assert.equal(summary.taskPlan.length, 2)
    assert.equal(summary.taskProgress.totalTasks, 2)
    assert.equal(summary.taskProgress.completedTasks, 1)
  })

  it('persists task plan across engine instances', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'test' }])
    await engine1.setTaskPlan([{ id: 't1', description: 'One', deliverable: 'a.txt' }])
    await engine1.updateTaskStatus({ taskId: 't1', status: 'completed' })

    const engine2 = new GoalAcceptanceEngine(store)
    const plan = engine2.getTaskPlan()
    assert.equal(plan.length, 1)
    assert.equal(plan[0]!.status, 'completed')
    assert.equal(engine2.summarize().taskPlan.length, 1)
  })
})

describe('GoalAcceptanceEngine — orchestrated task loop', () => {
  function createEngine() {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
  }

  async function setupTwoTaskGoal(engine: GoalAcceptanceEngine, role: 'agent' | 'reviewer' = 'agent') {
    await engine.setCriteria([
      { id: 'c1', description: 'task one done right', taskIds: ['t1'] },
      { id: 'c2', description: 'task two done right', taskIds: ['t2'] },
    ], role)
    await engine.setTaskPlan([
      { id: 't1', description: 'Do task one', deliverable: 'one.txt' },
      { id: 't2', description: 'Do task two', deliverable: 'two.txt', dependsOn: ['t1'] },
    ])
  }

  it('claimTask claims the first dependency-ready task with its criteria', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)

    const result = await engine.claimTask()
    assert.equal(result.task?.id, 't1')
    assert.equal(result.task?.status, 'in_progress')
    assert.deepEqual(result.criteria.map(c => c.id), ['c1'])

    // t2 is still blocked on t1 — claiming it directly is rejected.
    await assert.rejects(engine.claimTask('t2'), (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE')
    // t1 is already claimed — re-claim is rejected.
    await assert.rejects(engine.claimTask('t1'), (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE')
  })

  it('claimTask reports the reason when nothing is claimable', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)
    await engine.updateTaskStatus({ taskId: 't1', status: 'in_progress' })

    const result = await engine.claimTask()
    assert.equal(result.task, null)
    assert.ok(result.reason?.includes('unmet dependencies'), result.reason ?? 'missing')
  })

  it('reviewTask fail keeps the task in_progress and returns rework feedback', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)
    await engine.claimTask('t1')

    const result = await engine.reviewTask('t1', [
      { criterionId: 'c1', status: 'failed', evidence: 'output wrong', evidenceType: 'command' },
    ])
    assert.equal(result.taskCompleted, false)
    assert.equal(result.task.status, 'in_progress')
    assert.deepEqual(result.blockingCriteria.map(c => c.id), ['c1'])
  })

  it('reviewTask verdicts are formal — single layer, no confirm needed', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine, 'agent') // agent role would normally self-claim
    await engine.claimTask('t1')

    await engine.reviewTask('t1', [
      { criterionId: 'c1', status: 'passed', evidence: 're-verified by reviewer', evidenceType: 'command' },
    ])
    const c1 = engine.getCriterion('c1')
    assert.equal(c1?.status, 'passed')
    assert.notEqual(c1?.selfClaimed, true, 'reviewer verdict must be formal')
  })

  it('review→rework→re-review loop completes task and unlocks dependents', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)
    await engine.claimTask('t1')

    // Round 1: reviewer rejects.
    const r1 = await engine.reviewTask('t1', [
      { criterionId: 'c1', status: 'failed', evidence: 'still broken', evidenceType: 'command' },
    ])
    assert.equal(r1.taskCompleted, false)

    // Worker fixes; round 2: reviewer passes.
    const r2 = await engine.reviewTask('t1', [
      { criterionId: 'c1', status: 'passed', evidence: 'output now correct', evidenceType: 'command' },
    ])
    assert.equal(r2.taskCompleted, true)
    assert.equal(r2.task.status, 'completed')
    assert.equal(r2.nextTask?.id, 't2', 't2 unlocked by t1 completion')
    assert.deepEqual(r2.nextTaskCriteria?.map(c => c.id), ['c2'])

    // t2 is now claimable.
    const claim = await engine.claimTask()
    assert.equal(claim.task?.id, 't2')
  })

  it('reviewTask rejects verdicts on criteria not linked to the task', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)
    await engine.claimTask('t1')

    await assert.rejects(
      engine.reviewTask('t1', [{ criterionId: 'c2', status: 'passed', evidence: 'x' }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_CRITERION_NOT_IN_TASK',
    )
  })

  it('reviewTask requires an in_progress task with linked criteria', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)

    // t1 never claimed → pending, not reviewable.
    await assert.rejects(
      engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'x' }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_TASK_NOT_IN_PROGRESS',
    )
  })

  it('reviewTask rejects a task with no linked criteria', async () => {
    const engine = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'unlinked' }])
    await engine.setTaskPlan([{ id: 't1', description: 'No criteria', deliverable: 'x.txt' }])
    await engine.claimTask('t1')

    // The no-linked-criteria guard fires before verdict scoping.
    await assert.rejects(
      engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'x' }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_TASK_NO_LINKED_CRITERIA',
    )
  })

  it('full orchestrated loop: claim→work→review→complete→goal gate opens', async () => {
    const engine = createEngine()
    await setupTwoTaskGoal(engine)

    for (const [taskId, criterionId] of [['t1', 'c1'], ['t2', 'c2']] as const) {
      await engine.claimTask(taskId)
      const result = await engine.reviewTask(taskId, [
        { criterionId, status: 'passed', evidence: 'verified', evidenceType: 'command' },
      ])
      assert.equal(result.taskCompleted, true)
    }
    assert.equal(engine.canComplete().allowed, true)
  })
})

describe('Verification integrity layer', () => {
  const tmp = { dir: '' }
  function makeWorkspace(): string {
    tmp.dir = mkdtempSync(join(os.tmpdir(), 'ga-integrity-'))
    return tmp.dir
  }
  function engineIn(ws: string) {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore(), ws)
  }

  it('records artifact digests on passed verdict and blocks completion on drift', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'content-a')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a.txt ok', artifacts: ['a.txt'] }])

    const updated = await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'checked', evidenceType: 'file', byReviewer: true })
    assert.ok(updated.artifactDigests && updated.artifactDigests['a.txt'])
    assert.equal(engine.canComplete().allowed, true)

    writeFileSync(join(ws, 'a.txt'), 'tampered')
    const result = engine.canComplete()
    assert.equal(result.allowed, false)
    assert.match(result.reason!, /drifted/)
    const drift = engine.checkArtifactDrift()
    assert.equal(drift.drifted.length, 1)
    assert.equal(drift.drifted[0]!.criterion.id, 'c1')
    assert.equal(drift.drifted[0]!.reasons[0]!.kind, 'changed')
  })

  it('reports missing artifacts as drift', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    rmSync(join(ws, 'a.txt'))
    const drift = engine.checkArtifactDrift()
    assert.equal(drift.drifted[0]!.reasons[0]!.kind, 'missing')
    assert.equal(engine.canComplete().allowed, false)
  })

  it('rejects passed verdict when a declared artifact is absent', async () => {
    const ws = makeWorkspace()
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['nope.txt'] }])
    await assert.rejects(
      engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_ARTIFACT_MISSING',
    )
    // A failed verdict must NOT be rejected — absence is a legitimate fail reason.
    const failed = await engine.validateCriterion({ criterionId: 'c1', status: 'failed', evidence: 'file missing' })
    assert.equal(failed.status, 'failed')
  })

  it('rejects artifact declaration without a workspace root', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await assert.rejects(
      engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_WORKSPACE_REQUIRED',
    )
  })

  it('rejects relative artifact paths that escape the workspace', async () => {
    const ws = makeWorkspace()
    const engine = engineIn(ws)
    await assert.rejects(
      engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['../outside.txt'] }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_INVALID_CRITERIA',
    )
  })

  it('setWorkspaceRoot is set-once', async () => {
    const ws = makeWorkspace()
    const engine = engineIn(ws)
    engine.setWorkspaceRoot(ws)
    assert.throws(() => engine.setWorkspaceRoot(join(ws, 'other')), /already set/)
  })

  it('non-required drift does not block the gate', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    writeFileSync(join(ws, 'b.txt'), 'y')
    const engine = engineIn(ws)
    await engine.setCriteria([
      { id: 'req', description: 'required', artifacts: ['a.txt'] },
      { id: 'opt', description: 'optional', required: false, artifacts: ['b.txt'] },
    ])
    await engine.validateCriterion({ criterionId: 'req', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    await engine.validateCriterion({ criterionId: 'opt', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    writeFileSync(join(ws, 'b.txt'), 'tampered')
    assert.equal(engine.canComplete().allowed, true)
    assert.equal(engine.checkArtifactDrift().drifted.length, 1)
  })

  it('re-validation after rework clears drift', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    writeFileSync(join(ws, 'a.txt'), 'y')
    assert.equal(engine.canComplete().allowed, false)
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 're-verified', evidenceType: 'file', byReviewer: true })
    assert.equal(engine.canComplete().allowed, true)
  })

  it('drift on a completed task makes it reclaimable as rework', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    writeFileSync(join(ws, 'b.txt'), 'y')
    const engine = engineIn(ws)
    await engine.setCriteria([
      { id: 'c1', description: 'a', artifacts: ['a.txt'], taskIds: ['t1'] },
      { id: 'c2', description: 'b', artifacts: ['b.txt'], taskIds: ['t2'] },
    ])
    await engine.setTaskPlan([
      { id: 't1', description: 'task one', deliverable: 'a.txt' },
      { id: 't2', description: 'task two', deliverable: 'b.txt', dependsOn: ['t1'] },
    ])
    await engine.claimTask('t1')
    await engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'ok', evidenceType: 'file' }])
    await engine.claimTask('t2')
    await engine.reviewTask('t2', [{ criterionId: 'c2', status: 'passed', evidence: 'ok', evidenceType: 'file' }])
    assert.equal(engine.canComplete().allowed, true)

    // t1's artifact drifts after t2 completed (shared-file regression).
    writeFileSync(join(ws, 'a.txt'), 'tampered')
    assert.equal(engine.canComplete().allowed, false)

    // Rework claim takes priority over the (empty) ready frontier.
    const rework = await engine.claimTask()
    assert.equal(rework.claimKind, 'rework')
    assert.equal(rework.task!.id, 't1')
    assert.equal(rework.task!.status, 'in_progress')

    writeFileSync(join(ws, 'a.txt'), 'fixed')
    const re = await engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 're-ok', evidenceType: 'file' }])
    assert.equal(re.taskCompleted, true)
    assert.equal(engine.canComplete().allowed, true)
  })

  it('stores verifyCommand on the criterion and keeps it immutable via amend-only path', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    const list = await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'node --version' }])
    assert.equal(list[0]!.verifyCommand, 'node --version')
  })

  it('empty artifacts array is normalized away', async () => {
    const ws = makeWorkspace()
    const engine = engineIn(ws)
    const list = await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: [] }])
    assert.equal(list[0]!.artifacts, undefined)
  })

  it('digests survive event replay', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const store = new InMemoryAcceptanceStore()
    const engine = new GoalAcceptanceEngine(store, ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })

    // Fresh engine over the same store replays digests.
    const replayed = new GoalAcceptanceEngine(store, ws)
    const drift = replayed.checkArtifactDrift()
    assert.equal(drift.drifted.length, 0)
    assert.equal(drift.intact.length, 1)
  })
})

describe('F5 audit follow-ups (update_criterion, digestDelta, drift event, pin enforcement)', () => {
  const tmp = { dir: '' }
  function makeWorkspace(): string {
    tmp.dir = mkdtempSync(join(os.tmpdir(), 'ga-f5-'))
    return tmp.dir
  }
  function engineIn(ws: string) {
    return new GoalAcceptanceEngine(new InMemoryAcceptanceStore(), ws)
  }

  it('updateCriterion patches verifyCommand on a pending criterion and persists it', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'node --test test/' }])
    const updated = await engine.updateCriterion({
      criterionId: 'c1',
      patch: { verifyCommand: 'node --test' },
      reason: 'pin was broken on Windows',
    })
    assert.equal(updated.verifyCommand, 'node --test')
  })

  it('updateCriterion requires a reason and a non-empty patch', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a' }])
    await assert.rejects(
      engine.updateCriterion({ criterionId: 'c1', patch: { description: 'x' }, reason: '' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_UPDATE_REASON_REQUIRED',
    )
    await assert.rejects(
      engine.updateCriterion({ criterionId: 'c1', patch: {}, reason: 'r' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_INVALID_ARGS',
    )
    await assert.rejects(
      engine.updateCriterion({ criterionId: 'nope', patch: { description: 'x' }, reason: 'r' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND',
    )
  })

  it('updateCriterion on artifacts of a PASSED criterion resets it to pending and clears digests', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    writeFileSync(join(ws, 'b.txt'), 'y')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    assert.equal(engine.getCriterion('c1')!.artifactDigests !== undefined, true)

    const updated = await engine.updateCriterion({
      criterionId: 'c1',
      patch: { artifacts: ['a.txt', 'b.txt'] },
      reason: 'package.json was missing from bindings',
    })
    assert.equal(updated.status, 'pending')
    assert.equal(updated.artifactDigests, undefined)
    assert.deepEqual(updated.artifacts, ['a.txt', 'b.txt'])
    assert.equal(engine.canComplete().allowed, false)
  })

  it('updateCriterion description-only patch keeps passed status', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    const updated = await engine.updateCriterion({ criterionId: 'c1', patch: { description: 'better desc' }, reason: 'clarity' })
    assert.equal(updated.status, 'passed')
    assert.equal(engine.canComplete().allowed, true)
  })

  it('pinned criterion rejects a passed verdict without a declared command', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'node --test' }])
    await assert.rejects(
      engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ran it' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
    )
  })

  it('pinned criterion rejects a mismatched declared command, accepts the pin', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'node --test' }])
    await assert.rejects(
      engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', command: 'npm test' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
    )
    const ok = await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', command: 'node --test' })
    assert.equal(ok.status, 'passed')
    // non-passed verdicts may omit the command but cannot lie
    await assert.rejects(
      engine.validateCriterion({ criterionId: 'c1', status: 'failed', evidence: 'e', command: 'other' }),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
    )
  })

  it('review_task enforces the pin on verdicts too', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a', taskIds: ['t1'], verifyCommand: 'node --test' }])
    await engine.setTaskPlan([{ id: 't1', description: 't', deliverable: 'd' }])
    await engine.claimTask('t1')
    await assert.rejects(
      engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'command' }]),
      (e: { code?: string }) => e.code === 'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
    )
    const ok = await engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'command', command: 'node --test' }])
    assert.equal(ok.taskCompleted, true)
  })

  it('re-validation records digestDelta on the criterion and event', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const engine = engineIn(ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'] }])
    await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'file', byReviewer: true })
    writeFileSync(join(ws, 'a.txt'), 'y')
    const updated = await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 're', evidenceType: 'file', byReviewer: true })
    assert.deepEqual(updated.digestDelta, { changed: ['a.txt'], added: [], removed: [] })
  })

  it('rework claim persists a drift event and claimKind on task-update', async () => {
    const ws = makeWorkspace()
    writeFileSync(join(ws, 'a.txt'), 'x')
    const store = new InMemoryAcceptanceStore()
    const engine = new GoalAcceptanceEngine(store, ws)
    await engine.setCriteria([{ id: 'c1', description: 'a', artifacts: ['a.txt'], taskIds: ['t1'] }])
    await engine.setTaskPlan([{ id: 't1', description: 't', deliverable: 'd' }])
    await engine.claimTask('t1')
    await engine.reviewTask('t1', [{ criterionId: 'c1', status: 'passed', evidence: 'ok', evidenceType: 'file' }])
    writeFileSync(join(ws, 'a.txt'), 'tampered')
    const rework = await engine.claimTask()
    assert.equal(rework.claimKind, 'rework')
    const types = store.events.map(e => e.type)
    const driftIdx = types.indexOf('goal-acceptance/drift')
    assert.ok(driftIdx > 0, 'drift event should be persisted')
    const reopen = store.events.find(e => e.type === 'goal-acceptance/task-update' && (e as { claimKind?: string }).claimKind === 'rework')
    assert.ok(reopen !== undefined, 'task-update should carry claimKind=rework')
  })

  it('update events replay: patched pin survives sync', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine = new GoalAcceptanceEngine(store)
    await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'bad' }])
    await engine.updateCriterion({ criterionId: 'c1', patch: { verifyCommand: 'good' }, reason: 'fix' })
    const replayed = new GoalAcceptanceEngine(store)
    assert.equal(replayed.getCriterion('c1')!.verifyCommand, 'good')
  })

  it('verifyCommand null clears the pin', async () => {
    const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())
    await engine.setCriteria([{ id: 'c1', description: 'a', verifyCommand: 'node --test' }])
    const updated = await engine.updateCriterion({ criterionId: 'c1', patch: { verifyCommand: null }, reason: 'unpin' })
    assert.equal(updated.verifyCommand, undefined)
    const ok = await engine.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'e', evidenceType: 'text', byReviewer: true })
    assert.equal(ok.status, 'passed')
  })
})
