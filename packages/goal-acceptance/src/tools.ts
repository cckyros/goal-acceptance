/**
 * Model-facing tools for setting, reading, and validating acceptance criteria.
 * @module @deepseek-ai/dsh-goal-acceptance/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GoalCriterionStatus } from './types.ts'

const STATUSES: GoalCriterionStatus[] = [
  'pending',
  'in_progress',
  'passed',
  'failed',
  'blocked',
  'not_run',
]

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

const CRITERION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Short unique identifier (e.g. "auth-1", "test-pass").' },
    description: { type: 'string', required: true, description: 'Concrete requirement description.' },
    required: { type: 'boolean', description: 'Whether required for goal completion. Defaults to true.' },
    method: { type: 'string', description: 'Verification method: "test", "command", "browser", "manual".' },
  },
} as const

const OUTPUT_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const

/** Create the tool definitions for goal acceptance criteria. */
export function createAcceptanceTools(ctx: Context): ToolDefinition[] {
  const getTool = defineTool({
    name: 'get_acceptance_criteria',
    description: 'Read the current Goal acceptance criteria, individual statuses, evidence, and evaluation summary.',
    parameters: {},
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('acceptance tools require a calling agent')
      const service = ctx.get('goalAcceptance')
      if (service === undefined) throw new Error('goalAcceptance service is not mounted')
      const criteria = service.getCriteria(agent)
      const summary = service.summarize(agent)
      return Promise.resolve({
        criteria,
        summary,
      } as never)
    },
    presentCall: () => present('Read acceptance criteria', 'read'),
  })

  const setTool = defineTool({
    name: 'set_acceptance_criteria',
    description: 'Set and lock the initial acceptance criteria for the current Goal. Must be called after user confirmation and before implementation.',
    parameters: {
      criteria: {
        type: 'array',
        required: true,
        description: 'Array of criteria definitions with id, description, required flag, and verification method.',
        items: CRITERION_ITEM_SCHEMA,
      },
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('acceptance tools require a calling agent')
      const service = ctx.get('goalAcceptance')
      if (service === undefined) throw new Error('goalAcceptance service is not mounted')
      const rawCriteria = args.criteria as Array<{ id: string; description: string; required?: boolean; method?: string }>
      return service.setCriteria(agent, rawCriteria).then(criteria => ({
        criteria,
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present('Set acceptance criteria', 'other', args.criteria),
  })

  const validateTool = defineTool({
    name: 'validate_criterion',
    description: 'Record verification status and concrete evidence for one criterion. Statuses "passed" and "failed" require evidence.',
    parameters: {
      criterion_id: {
        type: 'string',
        required: true,
        description: 'Exact criterion id to validate.',
      },
      status: {
        type: 'string',
        required: true,
        enum: STATUSES,
        description: 'Outcome status: pending | in_progress | passed | failed | blocked | not_run',
      },
      evidence: {
        type: 'string',
        description: 'Verification evidence (e.g. test output, command result, error log). Required for passed/failed.',
      },
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('acceptance tools require a calling agent')
      const service = ctx.get('goalAcceptance')
      if (service === undefined) throw new Error('goalAcceptance service is not mounted')
      return service.validateCriterion(agent, {
        criterionId: args.criterion_id as string,
        status: args.status as GoalCriterionStatus,
        evidence: args.evidence as string | undefined,
      }).then(updated => ({
        criterion: updated,
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present(`Validate criterion "${String(args.criterion_id)}"`, 'other', args),
  })

  return [getTool, setTool, validateTool]
}
