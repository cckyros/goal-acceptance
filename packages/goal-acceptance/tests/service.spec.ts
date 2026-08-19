import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { GoalAcceptanceService } from '../src/service.ts'
import { GoalAcceptanceError } from '../src/types.ts'

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
    
    expect(service.getCriteria(agent)).toEqual([])
    expect(service.canComplete(agent).allowed).toBe(true)

    const criteria = await service.setCriteria(agent, [
      { id: 'crit-1', description: 'User login works', required: true, method: 'test' },
      { id: 'crit-2', description: 'UI matches design', required: false, method: 'manual' },
    ])

    expect(criteria).toHaveLength(2)
    expect(criteria[0]).toMatchObject({
      id: 'crit-1',
      description: 'User login works',
      required: true,
      method: 'test',
      status: 'pending',
    })
    expect(criteria[1]).toMatchObject({
      id: 'crit-2',
      description: 'UI matches design',
      required: false,
      method: 'manual',
      status: 'pending',
    })

    expect(service.getCriteria(agent)).toHaveLength(2)
    expect(service.canComplete(agent).allowed).toBe(false)
  })

  it('rejects empty, duplicate, or malformed criteria', async () => {
    const { service, agent } = await createHarness()

    await expect(service.setCriteria(agent, [])).rejects.toThrow(GoalAcceptanceError)
    await expect(service.setCriteria(agent, [
      { id: 'c1', description: 'first' },
      { id: 'c1', description: 'duplicate' },
    ])).rejects.toThrow(GoalAcceptanceError)
    await expect(service.setCriteria(agent, [
      { id: '', description: 'no id' },
    ])).rejects.toThrow(GoalAcceptanceError)
  })

  it('validates individual criteria with evidence', async () => {
    const { service, agent } = await createHarness()

    await service.setCriteria(agent, [
      { id: 'crit-1', description: 'Login works', required: true },
      { id: 'crit-2', description: 'Logout works', required: true },
    ], 'reviewer')

    // Rejects passed without evidence
    await expect(service.validateCriterion(agent, {
      criterionId: 'crit-1',
      status: 'passed',
      evidence: '',
    })).rejects.toThrow(GoalAcceptanceError)

    // Validates crit-1 as passed
    const updated1 = await service.validateCriterion(agent, {
      criterionId: 'crit-1',
      status: 'passed',
      evidence: 'Vitest 5/5 login tests passed',
    })
    expect(updated1.status).toBe('passed')
    expect(updated1.evidence).toBe('Vitest 5/5 login tests passed')

    // Cannot complete yet because crit-2 is still pending
    expect(service.canComplete(agent).allowed).toBe(false)

    // Validates crit-2 as passed
    await service.validateCriterion(agent, {
      criterionId: 'crit-2',
      status: 'passed',
      evidence: 'Logout test passed',
    })

    // Now all required passed
    expect(service.canComplete(agent).allowed).toBe(true)
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
    expect(summary.totalCount).toBe(5)
    expect(summary.passedCount).toBe(1)
    expect(summary.failedCount).toBe(1)
    expect(summary.blockedCount).toBe(1)
    expect(summary.pendingCount).toBe(1)
    expect(summary.notRunCount).toBe(1)
    expect(summary.allRequiredPassed).toBe(false)
    expect(summary.failures).toHaveLength(1)
    expect(summary.blockers).toHaveLength(1)
    expect(summary.pending).toHaveLength(1)
    expect(summary.notRun).toHaveLength(1)
  })

  it('handles locking and replay from session events', async () => {
    const { service, agent } = await createHarness()

    await service.setCriteria(agent, [
      { id: 'c1', description: 'Criterion 1' },
    ])

    await expect(service.setCriteria(agent, [{ id: 'c2', description: 'Criterion 2' }]))
      .rejects.toThrow(GoalAcceptanceError)

    // Replay on fresh Context
    const freshCtx = new Context()
    await freshCtx.plugin(AgentRegistry)
    const freshService = new GoalAcceptanceService(freshCtx)
    freshCtx.agents.register(agent)

    expect(freshService.getCriteria(agent)).toHaveLength(1)
    expect(freshService.getCriterion(agent, 'c1')?.description).toBe('Criterion 1')
    expect(freshService.getCriterion(agent, 'non-existent')).toBeUndefined()

    await expect(freshService.validateCriterion(agent, { criterionId: 'unknown', status: 'passed', evidence: 'none' }))
      .rejects.toThrow(GoalAcceptanceError)
  })
})
