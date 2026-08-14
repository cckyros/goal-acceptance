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

  it('rejects execution when agent is missing', async () => {
    const { ctx } = await createHarness()
    const getTool = ctx.tools.get('get_acceptance_criteria')!
    await expect(getTool.execute({}, {} as never)).rejects.toThrow('require a calling agent')
  })
})
