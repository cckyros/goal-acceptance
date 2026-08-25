// dsh plugin integration tests (migrated from the original dsh package's
// plugin.spec.ts, vitest → node:test). Verifies the single-package plugin:
// service mount, tool registration, system prompt section, turn-stopping
// steering, and invariant registration.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as applyPlugin, name, inject, Config } from '../src/plugin/dsh-plugin.ts'

function createStubAgent(id: string): Agent {
  const session = Session.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'running',
    send: () => {},
    followup: () => {},
    steer(msg) { inbox.append('next-step', msg) },
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

async function createHarness(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ name, inject, apply: applyPlugin, Config }, config)
  const agent = createStubAgent('plugin-test-agent')
  ctx.agents.register(agent)
  return { ctx, agent }
}

describe('Goal Acceptance Plugin', () => {
  it('registers tools and system prompt section', async () => {
    const { ctx, agent } = await createHarness()

    assert.notEqual(ctx.goalAcceptance, undefined)
    assert.notEqual(ctx.tools.get('set_acceptance_criteria'), undefined)
    assert.notEqual(ctx.tools.get('validate_criterion'), undefined)
    assert.notEqual(ctx.tools.get('get_acceptance_criteria'), undefined)

    const prompt = await ctx.systemPrompt.assemble({ agent })
    const joined = prompt.sections.map(s => s.text).join('\n')
    assert.ok(joined.includes('Goal Acceptance Policy'))
  })

  it('steers uncompleted work when turn is stopping with pending criteria', async () => {
    const { ctx, agent } = await createHarness({ autoSteerUncompleted: true })

    await ctx.goalAcceptance.setCriteria(agent, [
      { id: 'c1', description: 'Run build', required: true },
    ])

    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })

    // Agent should have received a steering message in inbox.nextStep
    assert.equal(agent.inbox.nextStep.length, 1)
    const steerMsg = agent.inbox.nextStep[0]!
    assert.equal(steerMsg.content[0]!.type, 'text')
    assert.ok(((steerMsg.content[0] as { text: string }).text).includes('Required criteria'))
  })

  it('steers self-claimed required criteria toward independent reviewer confirmation', async () => {
    const { ctx, agent } = await createHarness({ autoSteerUncompleted: true })
    await ctx.goalAcceptance.setCriteria(agent, [{ id: 'c1', description: 'Run build' }], 'agent')
    await ctx.goalAcceptance.validateCriterion(agent, { criterionId: 'c1', status: 'passed', evidence: 'build exit 0' })
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    assert.equal(agent.inbox.nextStep.length, 1)
    assert.ok(((agent.inbox.nextStep[0]!.content[0] as { text: string }).text).includes('confirm_criterion'))
  })

  it('does not steer when all required criteria are passed', async () => {
    const { ctx, agent } = await createHarness({ autoSteerUncompleted: true })

    await ctx.goalAcceptance.setCriteria(agent, [
      { id: 'c1', description: 'Run build', required: true },
    ], 'reviewer')
    await ctx.goalAcceptance.validateCriterion(agent, {
      criterionId: 'c1',
      status: 'passed',
      evidence: 'build exit 0',
    })

    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })

    assert.equal(agent.inbox.nextStep.length, 0)
  })

  it('does not steer when criteria are failed or blocked (no actionable pending items)', async () => {
    const { ctx, agent } = await createHarness({ autoSteerUncompleted: true })

    await ctx.goalAcceptance.setCriteria(agent, [
      { id: 'c1', description: 'Run build', required: true },
    ])
    await ctx.goalAcceptance.validateCriterion(agent, {
      criterionId: 'c1',
      status: 'blocked',
      evidence: 'missing permission',
    })

    const signal = new AbortController().signal
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal })

    assert.equal(agent.inbox.nextStep.length, 0)
  })
})
