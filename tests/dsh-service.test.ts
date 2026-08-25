// GoalAcceptanceService tests (migrated from the original dsh package's
// service.spec.ts, vitest → node:test). Per-agent semantics: engines are
// WeakMap<Agent, …>, events persist to the agent's session.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { GoalAcceptanceService } from '../src/plugin/dsh-plugin.ts'
import { GoalAcceptanceError } from '../src/plugin/engine/index.ts'

function createStubAgent(id: string): Agent {
  const session = Session.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function createHarness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const service = new GoalAcceptanceService(ctx)
  const agent = createStubAgent('agent-test-1')
  ctx.agents.register(agent)
  return { ctx, service, agent }
}

describe('GoalAcceptanceService', () => {
  it('sets and locks acceptance criteria for an agent', async () => {
    const { service, agent } = await createHarness()

    assert.deepEqual(service.getCriteria(agent), [])
    assert.equal(service.canComplete(agent).allowed, true)

    const criteria = await service.setCriteria(agent, [
      { id: 'crit-1', description: 'User login works', required: true, method: 'test' },
      { id: 'crit-2', description: 'UI matches design', required: false, method: 'manual' },
    ])

    assert.equal(criteria.length, 2)
    matchObject(criteria[0]!, {
      id: 'crit-1',
      description: 'User login works',
      required: true,
      method: 'test',
      status: 'pending',
    })
    matchObject(criteria[1]!, {
      id: 'crit-2',
      description: 'UI matches design',
      required: false,
      method: 'manual',
      status: 'pending',
    })

    assert.equal(service.getCriteria(agent).length, 2)
    assert.equal(service.canComplete(agent).allowed, false)
  })

  it('rejects empty, duplicate, or malformed criteria', async () => {
    const { service, agent } = await createHarness()

    await assert.rejects(service.setCriteria(agent, []), GoalAcceptanceError)
    await assert.rejects(service.setCriteria(agent, [
      { id: 'c1', description: 'first' },
      { id: 'c1', description: 'duplicate' },
    ]), GoalAcceptanceError)
    await assert.rejects(service.setCriteria(agent, [
      { id: '', description: 'no id' },
    ]), GoalAcceptanceError)
  })

  it('validates individual criteria with evidence', async () => {
    const { service, agent } = await createHarness()

    await service.setCriteria(agent, [
      { id: 'crit-1', description: 'Login works', required: true },
      { id: 'crit-2', description: 'Logout works', required: true },
    ], 'reviewer')

    // Rejects passed without evidence
    await assert.rejects(service.validateCriterion(agent, {
      criterionId: 'crit-1',
      status: 'passed',
      evidence: '',
    }), GoalAcceptanceError)

    // Validates crit-1 as passed
    const updated1 = await service.validateCriterion(agent, {
      criterionId: 'crit-1',
      status: 'passed',
      evidence: 'Vitest 5/5 login tests passed',
    })
    assert.equal(updated1.status, 'passed')
    assert.equal(updated1.evidence, 'Vitest 5/5 login tests passed')

    // Cannot complete yet because crit-2 is still pending
    assert.equal(service.canComplete(agent).allowed, false)

    // Validates crit-2 as passed
    await service.validateCriterion(agent, {
      criterionId: 'crit-2',
      status: 'passed',
      evidence: 'Logout test passed',
    })

    // Now all required passed
    assert.equal(service.canComplete(agent).allowed, true)
  })

  it('summarizes criteria statuses correctly', async () => {
    const { service, agent } = await createHarness()

    await service.setCriteria(agent, [
      { id: 'c1', description: 'Req 1', required: true },
      { id: 'c2', description: 'Req 2', required: true },
      { id: 'c3', description: 'Opt 1', required: false },
      { id: 'c4', description: 'Req 3', required: true },
      { id: 'c5', description: 'Opt 2', required: false },
    ])

    await service.validateCriterion(agent, { criterionId: 'c1', status: 'passed', evidence: 'passed evidence' })
    await service.validateCriterion(agent, { criterionId: 'c2', status: 'failed', evidence: 'test failed' })
    await service.validateCriterion(agent, { criterionId: 'c3', status: 'blocked' })
    await service.validateCriterion(agent, { criterionId: 'c4', status: 'in_progress' })
    await service.validateCriterion(agent, { criterionId: 'c5', status: 'not_run' })

    const summary = service.summarize(agent)
    assert.equal(summary.totalCount, 5)
    assert.equal(summary.passedCount, 1)
    assert.equal(summary.failedCount, 1)
    assert.equal(summary.blockedCount, 1)
    assert.equal(summary.pendingCount, 1)
    assert.equal(summary.notRunCount, 1)
    assert.equal(summary.allRequiredPassed, false)
    assert.equal(summary.failures.length, 1)
    assert.equal(summary.blockers.length, 1)
    assert.equal(summary.pending.length, 1)
    assert.equal(summary.notRun.length, 1)
  })

  it('handles locking and replay from session events', async () => {
    const { service, agent } = await createHarness()

    await service.setCriteria(agent, [
      { id: 'c1', description: 'Criterion 1' },
    ])

    await assert.rejects(service.setCriteria(agent, [{ id: 'c2', description: 'Criterion 2' }]), GoalAcceptanceError)

    // Replay on fresh Context
    const freshCtx = new Context()
    await freshCtx.plugin(AgentRegistry)
    const freshService = new GoalAcceptanceService(freshCtx)
    freshCtx.agents.register(agent)

    assert.equal(freshService.getCriteria(agent).length, 1)
    assert.equal(freshService.getCriterion(agent, 'c1')?.description, 'Criterion 1')
    assert.equal(freshService.getCriterion(agent, 'non-existent'), undefined)

    await assert.rejects(freshService.validateCriterion(agent, { criterionId: 'unknown', status: 'passed', evidence: 'none' }), GoalAcceptanceError)
  })
})

/** Assert that `actual` contains all fields of `expected` (vitest toMatchObject). */
function matchObject(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === 'object', 'expected an object')
  const a = actual as Record<string, unknown>
  for (const [k, v] of Object.entries(expected)) {
    if (v !== null && typeof v === 'object') {
      matchObject(a[k], v as Record<string, unknown>)
    } else {
      assert.equal(a[k], v, `field ${k}`)
    }
  }
}
