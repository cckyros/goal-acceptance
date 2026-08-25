import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { GoalAcceptanceService } from '../src/service.ts'
import { createAcceptanceTools } from '../src/tools.ts'

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
  it('registers the complete MCP 13-tool protocol', async () => {
    const { tools } = await createHarness()
    expect(tools.map(tool => tool.name)).toEqual([
      'set_acceptance_criteria', 'get_acceptance_criteria', 'validate_criterion',
      'confirm_criterion', 'update_task_status', 'amend_acceptance_criteria',
      'can_complete_goal', 'set_task_plan', 'get_task_plan', 'start_goal',
      'list_goals', 'switch_goal', 'reset_goal',
    ])
  })

  it('executes set_acceptance_criteria and get_acceptance_criteria', async () => {
    const { ctx, agent } = await createHarness()
    const setTool = ctx.tools.get('set_acceptance_criteria')!
    const getTool = ctx.tools.get('get_acceptance_criteria')!

    const setResult = await setTool.execute({
      criteria: [
        { id: 'c1', description: 'API returns 200', required: true, method: 'test' },
        { id: 'c2', description: 'Documentation updated', required: false },
      ],
    }, { agent } as never) as { criteria: unknown[]; summary: { totalCount: number } }

    expect(setResult.criteria).toHaveLength(2)
    expect(setResult.summary.totalCount).toBe(2)

    const getResult = await getTool.execute({}, { agent } as never) as { criteria: unknown[]; summary: { totalCount: number } }
    expect(getResult.criteria).toHaveLength(2)
    expect(getResult.summary.totalCount).toBe(2)
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

    expect(second.goalId).not.toBe(first.goalId)
    expect(second.autoStarted).toBe(true)
    expect(second.previousGoalId).toBe(first.goalId)
    expect(second.previousGoalIncomplete).toBe(true)
    expect(second.previousGoalReason).toBeTruthy()
    expect(second.criteria.map(c => c.id)).toEqual(['c2'])

    // The abandoned goal stays reachable with its criteria intact.
    const goals = await ctx.tools.get('list_goals')!.execute({}, { agent } as never) as {
      goals: Array<{ id: string; criteriaCount: number; isActive: boolean }>
    }
    expect(goals.goals).toHaveLength(2)
    const abandoned = goals.goals.find(g => g.id === first.goalId)!
    expect(abandoned.criteriaCount).toBe(1)
    expect(abandoned.isActive).toBe(false)
  })

  it('validates a criterion using validate_criterion tool', async () => {
    const { ctx, agent } = await createHarness()
    const setTool = ctx.tools.get('set_acceptance_criteria')!
    const validateTool = ctx.tools.get('validate_criterion')!

    await setTool.execute({
      criteria: [
        { id: 'c1', description: 'API returns 200', required: true, method: 'test' },
      ],
    }, { agent } as never)

    const valResult = await validateTool.execute({
      criterion_id: 'c1',
      status: 'passed',
      evidence: 'GET /api/health returned 200 OK',
    }, { agent } as never) as { criterion: { status: string; evidence: string }; summary: { passedCount: number } }

    expect(valResult.criterion.status).toBe('passed')
    expect(valResult.criterion.evidence).toBe('GET /api/health returned 200 OK')
    expect(valResult.summary.passedCount).toBe(1)
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
    expect(result.criterion.selfClaimed).toBe(false)
    expect((await ctx.tools.get('can_complete_goal')!.execute({}, { agent } as never) as { allowed: boolean }).allowed).toBe(true)
  })

  it('supports task plans and goal lifecycle tools', async () => {
    const { ctx, agent } = await createHarness()
    await ctx.tools.get('set_acceptance_criteria')!.execute({ criteria: [{ id: 'c1', description: 'Done' }] }, { agent } as never)
    const plan = await ctx.tools.get('set_task_plan')!.execute({ tasks: [{ id: 't1', description: 'Implement', deliverable: 'Code' }] }, { agent } as never) as { taskPlan: unknown[] }
    expect(plan.taskPlan).toHaveLength(1)
    expect((await ctx.tools.get('get_task_plan')!.execute({}, { agent } as never) as { taskPlan: unknown[] }).taskPlan).toHaveLength(1)
    const initialGoals = (await ctx.tools.get('list_goals')!.execute({}, { agent } as never) as { goals: Array<{ id: string }> }).goals
    expect(initialGoals).toHaveLength(1)
    const started = await ctx.tools.get('start_goal')!.execute({ title: 'Next' }, { agent } as never) as { goal: { title: string } }
    expect(started.goal.title).toBe('Next')
    const switched = await ctx.tools.get('switch_goal')!.execute({ goal_id: initialGoals[0]!.id }, { agent } as never) as { goal: { id: string } }
    expect(switched.goal.id).toBe(initialGoals[0]!.id)
    await ctx.tools.get('reset_goal')!.execute({}, { agent } as never)
  })

  it('rejects execution when agent is missing', async () => {
    const { ctx } = await createHarness()
    const getTool = ctx.tools.get('get_acceptance_criteria')!
    await expect(getTool.execute({}, {} as never)).rejects.toThrow('require a calling agent')
  })
})
