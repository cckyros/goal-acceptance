// dsh acceptance tools tests (migrated from the original dsh package's
// tools.spec.ts, vitest → node:test). Tools are per-agent: they resolve the
// calling agent via exec.agent and route through the goalAcceptance service.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { GoalAcceptanceService, createAcceptanceTools } from '../src/plugin/dsh-plugin.ts'

function createStubAgent(id: string): Agent {
  const session = Session.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'running',
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
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const service = new GoalAcceptanceService(ctx)
  const tools = createAcceptanceTools(ctx)
  for (const tool of tools) {
    ctx.tools.register(tool)
  }
  const agent = createStubAgent('tool-test-agent')
  ctx.agents.register(agent)
  return { ctx, service, tools, agent }
}

describe('Goal Acceptance Tools', () => {
  it('registers the complete 15-tool protocol', async () => {
    const { tools } = await createHarness()
    assert.deepEqual(tools.map(tool => tool.name), [
      'set_acceptance_criteria', 'get_acceptance_criteria', 'validate_criterion',
      'confirm_criterion', 'update_task_status', 'amend_acceptance_criteria',
      'can_complete_goal', 'set_task_plan', 'get_task_plan', 'start_goal',
      'list_goals', 'switch_goal', 'run_and_validate', 'quick_start_goal', 'reset_goal',
    ])
  })

  it('executes set_acceptance_criteria and get_acceptance_criteria', async () => {
    const { ctx, agent } = await createHarness()
    const setTool = ctx.tools.get('set_acceptance_criteria')!
    const getTool = ctx.tools.get('get_acceptance_criteria')!

    const setResult = await setTool.execute({
      criteria: [
        { id: 'c1', description: 'API returns 200', required: true, method: 'command' },
        { id: 'c2', description: 'Documentation updated', required: false },
      ],
    }, { agent } as never) as { criteria: unknown[]; summary: { totalCount: number } }

    assert.equal(setResult.criteria.length, 2)
    assert.equal(setResult.summary.totalCount, 2)

    const getResult = await getTool.execute({}, { agent } as never) as { criteria: unknown[]; summary: { totalCount: number } }
    assert.equal(getResult.criteria.length, 2)
    assert.equal(getResult.summary.totalCount, 2)
  })

  it('rotates to a new goal when set_acceptance_criteria hits an incomplete locked goal', async () => {
    const { ctx, agent } = await createHarness()
    const setTool = ctx.tools.get('set_acceptance_criteria')!

    const first = await setTool.execute({
      criteria: [{ id: 'c1', description: 'first', required: true }],
    }, { agent } as never) as { goalId: string }

    // Goal 1 is locked and still pending — this must not dead-end the caller.
    const second = await setTool.execute({
      criteria: [{ id: 'c2', description: 'second', required: true }],
    }, { agent } as never) as {
      goalId: string
      previousGoalId: string
      autoStarted: boolean
      previousGoalIncomplete: boolean
      previousGoalReason: string
      criteria: Array<{ id: string }>
    }

    assert.notEqual(second.goalId, first.goalId)
    assert.equal(second.autoStarted, true)
    assert.equal(second.previousGoalId, first.goalId)
    assert.equal(second.previousGoalIncomplete, true)
    assert.ok(second.previousGoalReason)
    assert.deepEqual(second.criteria.map(c => c.id), ['c2'])

    // The abandoned goal stays reachable with its criteria intact.
    const goals = await ctx.tools.get('list_goals')!.execute({}, { agent } as never) as {
      goals: Array<{ id: string; criteriaCount: number; isActive: boolean }>
    }
    assert.equal(goals.goals.length, 2)
    const abandoned = goals.goals.find(g => g.id === first.goalId)!
    assert.equal(abandoned.criteriaCount, 1)
    assert.equal(abandoned.isActive, false)
  })

  it('validates a criterion using validate_criterion tool', async () => {
    const { ctx, agent } = await createHarness()
    const setTool = ctx.tools.get('set_acceptance_criteria')!
    const validateTool = ctx.tools.get('validate_criterion')!

    await setTool.execute({
      criteria: [
        { id: 'c1', description: 'API returns 200', required: true, method: 'command' },
      ],
    }, { agent } as never)

    const valResult = await validateTool.execute({
      criterion_id: 'c1',
      status: 'passed',
      evidence: 'GET /api/health returned 200 OK',
    }, { agent } as never) as { criterion: { status: string; evidence: string }; summary: { passedCount: number } }

    assert.equal(valResult.criterion.status, 'passed')
    assert.equal(valResult.criterion.evidence, 'GET /api/health returned 200 OK')
    assert.equal(valResult.summary.passedCount, 1)
  })

  it('confirms a self-claimed criterion with high-confidence evidence', async () => {
    const { ctx, agent } = await createHarness()
    await ctx.tools.get('set_acceptance_criteria')!.execute({
      role: 'agent', criteria: [{ id: 'c1', description: 'API returns 200' }],
    }, { agent } as never)
    await ctx.tools.get('validate_criterion')!.execute({
      criterion_id: 'c1', status: 'passed', evidence: 'test passed', evidence_type: 'command',
    }, { agent } as never)
    const result = await ctx.tools.get('confirm_criterion')!.execute({
      criterion_id: 'c1', evidence: 'independent test passed', evidence_type: 'command',
    }, { agent } as never) as { criterion: { selfClaimed?: boolean }; allowed: boolean }
    assert.equal(result.criterion.selfClaimed, false)
    assert.equal((await ctx.tools.get('can_complete_goal')!.execute({}, { agent } as never) as { allowed: boolean }).allowed, true)
  })

  it('supports task plans and goal lifecycle tools', async () => {
    const { ctx, agent } = await createHarness()
    await ctx.tools.get('set_acceptance_criteria')!.execute({ criteria: [{ id: 'c1', description: 'Done' }] }, { agent } as never)
    const plan = await ctx.tools.get('set_task_plan')!.execute({ tasks: [{ id: 't1', description: 'Implement', deliverable: 'Code' }] }, { agent } as never) as { taskPlan: unknown[] }
    assert.equal(plan.taskPlan.length, 1)
    assert.equal((await ctx.tools.get('get_task_plan')!.execute({}, { agent } as never) as { taskPlan: unknown[] }).taskPlan.length, 1)
    const initialGoals = (await ctx.tools.get('list_goals')!.execute({}, { agent } as never) as { goals: Array<{ id: string }> }).goals
    assert.equal(initialGoals.length, 1)
    const started = await ctx.tools.get('start_goal')!.execute({ title: 'Next' }, { agent } as never) as { goal: { title: string } }
    assert.equal(started.goal.title, 'Next')
    const switched = await ctx.tools.get('switch_goal')!.execute({ goal_id: initialGoals[0]!.id }, { agent } as never) as { goal: { id: string } }
    assert.equal(switched.goal.id, initialGoals[0]!.id)
    await ctx.tools.get('reset_goal')!.execute({}, { agent } as never)
  })

  it('rejects execution when agent is missing', async () => {
    const { ctx } = await createHarness()
    const getTool = ctx.tools.get('get_acceptance_criteria')!
    await assert.rejects(getTool.execute({}, {} as never), /require a calling agent/)
  })
})
