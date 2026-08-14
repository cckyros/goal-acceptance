/**
 * Model-provider-neutral goal acceptance criteria and validation plugin.
 * @module @deepseek-ai/dsh-goal-acceptance
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GoalAcceptanceService } from './service.ts'
import { createAcceptanceTools } from './tools.ts'
import { renderAcceptanceGuidance } from './prompt.ts'

export type * from './types.ts'
export { GoalAcceptanceService } from './service.ts'
export { createAcceptanceTools } from './tools.ts'
export { renderAcceptanceGuidance } from './prompt.ts'

/** Plugin name. */
export const name = 'goal-acceptance'

/** Services required for goal-acceptance policy and tool registration. */
export const inject = ['agents', 'tools', 'systemPrompt']

/** Configuration for goal-acceptance. */
export interface Config {
  /** Whether to automatically steer the agent when a turn stops with pending required criteria. Defaults to true. */
  autoSteerUncompleted?: boolean
  /** Maximum consecutive turn steerings per session before stopping. Defaults to 5. */
  maxSteeringTurns?: number
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  autoSteerUncompleted: z.boolean().default(true),
  maxSteeringTurns: z.number().step(1).min(1).default(5),
})

/**
 * Apply the goal-acceptance plugin: installs the service, tools, prompt section,
 * and turn-stopping loop check with dependency-aware steering.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const autoSteer = config.autoSteerUncompleted !== false
  const maxSteering = config.maxSteeringTurns ?? 5

  // Install service if not present
  if (ctx.get('goalAcceptance') === undefined) {
    ctx.plugin(GoalAcceptanceService)
  }

  // Register tools
  const tools = createAcceptanceTools(ctx)
  for (const tool of tools) {
    ctx.tools.register(tool)
  }

  // Register system prompt section
  ctx.systemPrompt.section({
    name: 'policy:goal-acceptance',
    order: 115,
    text: (context) => {
      const agent = context.agent
      const service = ctx.get('goalAcceptance')
      const summary = agent !== undefined && service !== undefined ? service.summarize(agent) : undefined
      return renderAcceptanceGuidance(summary)
    },
  })

  // Per-agent steering attempt tracker
  const steeringCounts = new WeakMap<Agent, number>()

  ctx.on('agent/turn-stopping', ({ agent }) => {
    const service = ctx.get('goalAcceptance')
    if (service === undefined) return

    const criteria = service.getCriteria(agent)
    if (criteria.length === 0) return

    const summary = service.summarize(agent)
    if (summary.allRequiredPassed) return

    // If there are no pending/in_progress criteria, all remaining items are already
    // marked failed or blocked — no further work can be done automatically, let turn close.
    const actionable = criteria.filter(c => c.required && (c.status === 'pending' || c.status === 'in_progress'))
    if (actionable.length === 0) return

    if (!autoSteer) return

    const count = steeringCounts.get(agent) ?? 0
    if (count >= maxSteering) return

    steeringCounts.set(agent, count + 1)

    // Build a dependency-aware steering message
    const parts: string[] = []
    parts.push(`Goal Acceptance Reminder (attempt ${count + 1}/${maxSteering}):`)

    // Task progress summary
    const tp = summary.taskProgress
    if (tp.totalTasks > 0) {
      parts.push(`Task progress: ${tp.completedTasks}/${tp.totalTasks} completed.`)
    }

    // Ready to validate — prompt the agent to validate these first
    if (summary.readyToValidate.length > 0) {
      const ready = summary.readyToValidate.map(c => `"${c.id}"`).join(', ')
      parts.push(`Ready to validate (all linked tasks done): ${ready}. Call \`validate_criterion\` with evidence now.`)
    }

    // Next actionable — ordered by dependency
    if (summary.nextActionable.length > 0) {
      const next = summary.nextActionable[0]!
      parts.push(`Next priority: "${next.id}" (${next.description}).`)
      if (summary.nextActionable.length > 1) {
        const rest = summary.nextActionable.slice(1).map(c => `"${c.id}"`).join(', ')
        parts.push(`Then: ${rest}.`)
      }
    } else {
      // No actionable with met dependencies — list what's blocked by deps
      const blocked = actionable.filter(c => !summary.nextActionable.includes(c))
      if (blocked.length > 0) {
        const blockedDesc = blocked.map(c => `"${c.id}" (waiting on: ${c.dependsOn.join(', ')})`).join(', ')
        parts.push(`Waiting on dependencies: ${blockedDesc}.`)
      }
    }

    // Remaining pending without task links
    const noTaskPending = actionable.filter(c => c.taskIds.length === 0 && !summary.readyToValidate.includes(c))
    if (noTaskPending.length > 0 && summary.nextActionable.length === 0) {
      const ids = noTaskPending.map(c => `"${c.id}" (${c.description})`).join(', ')
      parts.push(`Required criteria not yet validated: ${ids}.`)
    }

    parts.push('If an item cannot be validated in this environment, mark it as `blocked`.')

    agent.steer(createUserMessage({
      content: [{ type: 'text', text: parts.join(' ') }],
      source: { kind: 'plugin', plugin: 'goal-acceptance' },
    }))
  })
}

export default GoalAcceptanceService
