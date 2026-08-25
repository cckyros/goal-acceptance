// AC8: persistence compatibility. The data layout is UNCHANGED from the
// original mcp/openclaw packages: `<dataDir>/goals/<id>.json` (event array)
// + `<id>.meta.json` + `<dataDir>/current-goal.txt`. This suite hand-writes
// files in that legacy shape and proves a fresh process (new GoalManager)
// loads and summarizes them — the single-package refactor must not orphan
// existing goal data.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalManager } from '../src/plugin/goal-manager.ts'

const OLD_GOAL_ID = 'legacy-goal-11111111'

/** Hand-write the legacy on-disk shape: event array + meta + current-goal. */
function writeLegacyDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'goal-acceptance-compat-'))
  const goalsDir = join(dataDir, 'goals')
  mkdirSync(goalsDir, { recursive: true })

  // Event array as written by the original packages (append-only, no schema
  // change across the refactor). Full lifecycle: set → task-plan →
  // task-update → validate (self-claimed, role=agent) → amend.
  writeFileSync(
    join(goalsDir, `${OLD_GOAL_ID}.json`),
    JSON.stringify(
      [
        {
          type: 'goal-acceptance/set',
          criteria: [
            { id: 'api-200', description: 'GET /health returns 200', required: true, method: 'test', status: 'pending', taskIds: ['t1', 't2'], dependsOn: [] },
            { id: 'docs', description: 'README updated', required: false, method: 'manual', status: 'pending', taskIds: [], dependsOn: ['api-200'] },
          ],
          lockedAt: 1700000000000,
          role: 'agent',
        },
        {
          type: 'goal-acceptance/task-plan',
          tasks: [
            { id: 't1', description: 'implement /health endpoint', deliverable: 'route handler + tests', dependsOn: [], status: 'pending' },
            { id: 't2', description: 'add integration test', deliverable: 'passing GET /health test', dependsOn: ['t1'], status: 'pending' },
          ],
          plannedAt: 1700000001000,
        },
        { type: 'goal-acceptance/task-update', taskId: 't1', taskStatus: 'completed', updatedAt: 1700000002000 },
        {
          type: 'goal-acceptance/validate',
          criterionId: 'api-200',
          status: 'passed',
          evidence: 'curl /health -> 200 OK',
          evidenceType: 'command',
          validatedAt: 1700000003000,
          selfClaimed: true,
        },
        {
          type: 'goal-acceptance/amend',
          addedCriteria: [
            { id: 'rate-limit', description: 'rate limiting on /health', required: true, method: 'test', status: 'pending', taskIds: [], dependsOn: [], addedAfterLock: true, addedAt: 1700000004000 },
          ],
          reason: 'production hardening',
          amendedAt: 1700000004000,
        },
        {
          type: 'goal-acceptance/validate',
          criterionId: 'rate-limit',
          status: 'passed',
          evidence: 'ab -n 100 -c 10 -> 200, no 429 without burst',
          evidenceType: 'command',
          validatedAt: 1700000005000,
          selfClaimed: true,
        },
        {
          type: 'goal-acceptance/validate',
          criterionId: 'docs',
          status: 'passed',
          evidence: 'README.md contains install + usage sections',
          evidenceType: 'file',
          validatedAt: 1700000006000,
          selfClaimed: true,
        },
      ],
      null,
      2,
    ) + '\n',
    'utf-8',
  )

  writeFileSync(
    join(goalsDir, `${OLD_GOAL_ID}.meta.json`),
    JSON.stringify({ id: OLD_GOAL_ID, title: 'health endpoint', createdAt: 1700000000000 }, null, 2) + '\n',
    'utf-8',
  )
  writeFileSync(join(dataDir, 'current-goal.txt'), OLD_GOAL_ID, 'utf-8')
  return dataDir
}

describe('AC8 persistence compatibility (legacy data dir)', () => {
  it('a fresh process restores the active goal from legacy files', () => {
    const dataDir = writeLegacyDataDir()
    const mgr = new GoalManager(dataDir) // "new process" boots here

    assert.equal(mgr.getCurrentGoalId(), OLD_GOAL_ID)

    const goals = mgr.listGoals()
    assert.equal(goals.length, 1)
    assert.equal(goals[0].id, OLD_GOAL_ID)
    assert.equal(goals[0].title, 'health endpoint')
    assert.equal(goals[0].isActive, true)
  })

  it('replays legacy events into an identical summary (no schema drift)', () => {
    const dataDir = writeLegacyDataDir()
    const mgr = new GoalManager(dataDir)
    const s = mgr.getEngine().summarize()

    // set(2) + amend(1): criteria survive replay untouched.
    assert.equal(s.totalCount, 3)
    assert.equal(s.passedCount, 3)
    assert.equal(s.selfClaimedCount, 3)
    assert.equal(s.allRequiredPassed, false) // all passes are self-claimed

    // task plan + linked progress replay intact.
    assert.equal(s.taskPlan.length, 2)
    assert.equal(s.taskProgress.totalTasks, 2)
    assert.equal(s.taskProgress.completedTasks, 1)

    // All required criteria are passed but self-claimed by the agent: the
    // completion gate still blocks, citing reviewer confirmation.
    const gate = mgr.getEngine().canComplete()
    assert.equal(gate.allowed, false)
    assert.match(gate.reason ?? '', /self-claimed/i)

    // amend marker preserved (addedAfterLock=true).
    const rateLimit = s.passed.find((c) => c.id === 'rate-limit')
    assert.ok(rateLimit)
    assert.equal(rateLimit.addedAfterLock, true)
    assert.equal(rateLimit.selfClaimed, true)
  })

  it('appends to legacy files in the same format (read/write compatible)', async () => {
    const dataDir = writeLegacyDataDir()
    const mgr = new GoalManager(dataDir)

    // Continue the goal through the new code path, as the original flow would.
    await mgr.getEngine().confirmCriterion({
      criterionId: 'api-200',
      evidence: 'reviewer re-ran curl /health -> 200 OK',
      evidenceType: 'command',
    })

    // File on disk is still the same shape: a JSON event array the old
    // packages (or a downgraded process) could read back.
    const raw = JSON.parse(readFileSync(join(dataDir, 'goals', `${OLD_GOAL_ID}.json`), 'utf-8'))
    assert.ok(Array.isArray(raw))
    assert.equal(raw.length, 8) // 7 legacy + 1 confirm event
    assert.equal(raw[7].type, 'goal-acceptance/validate')
    // Confirm events carry no selfClaimed field (absent = formal pass).
    assert.equal(raw[7].selfClaimed, undefined)

    const s = mgr.getEngine().summarize()
    assert.equal(s.allRequiredPassed, false) // rate-limit still self-claimed
    assert.equal(s.selfClaimedCount, 2)
  })

  it('lists goals that are NOT the current one (multi-goal scan of legacy data)', () => {
    const dataDir = writeLegacyDataDir()
    // Second legacy goal, never made current.
    const otherId = 'legacy-goal-22222222'
    writeFileSync(
      join(dataDir, 'goals', `${otherId}.json`),
      JSON.stringify([
        { type: 'goal-acceptance/set', criteria: [{ id: 'c1', description: 'x', required: true, method: 'test', status: 'passed', taskIds: [], dependsOn: [] }], lockedAt: 1600000000000 },
        { type: 'goal-acceptance/validate', criterionId: 'c1', status: 'passed', evidence: 'ran tests', evidenceType: 'command', validatedAt: 1600000001000 },
      ]),
      'utf-8',
    )
    writeFileSync(
      join(dataDir, 'goals', `${otherId}.meta.json`),
      JSON.stringify({ id: otherId, title: 'old goal', createdAt: 1600000000000 }, null, 2) + '\n',
      'utf-8',
    )

    const mgr = new GoalManager(dataDir)
    const goals = mgr.listGoals()
    assert.equal(goals.length, 2)

    const other = goals.find((g) => g.id === otherId)
    assert.ok(other)
    assert.equal(other.isActive, false)
    assert.equal(other.criteriaCount, 1)
    assert.equal(other.passedCount, 1)
    assert.equal(other.allRequiredPassed, true)
  })

  it('legacy data directory layout is untouched by read-only startup', () => {
    const dataDir = writeLegacyDataDir()
    const before = readdirSync(join(dataDir, 'goals')).sort()
    const mgr = new GoalManager(dataDir)
    mgr.listGoals() // pure reads
    const after = readdirSync(join(dataDir, 'goals')).sort()
    assert.deepEqual(after, before)
  })
})
