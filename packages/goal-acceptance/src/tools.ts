/**
 * Model-facing tools for setting, reading, validating, and amending acceptance criteria.
 * @module @cckyros/goal-acceptance/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { GoalAcceptanceError } from './types.ts'
import type { AcceptanceSummary, EvidenceType, GoalCriterionStatus, GoalRole, TaskStatus } from './types.ts'

const STATUSES: GoalCriterionStatus[] = [
  'pending',
  'in_progress',
  'passed',
  'failed',
  'blocked',
  'not_run',
]

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
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
    task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task IDs linked to this criterion. When all linked tasks are completed, the criterion is ready to validate.',
    },
    depends_on: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of criteria that must be passed before this criterion should be validated. Affects steering priority.',
    },
  },
} as const

const TASK_PLAN_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    description: { type: 'string', required: true },
    deliverable: { type: 'string', required: true },
    depends_on: { type: 'array', items: { type: 'string' } },
  },
} as const

const ROLE_SCHEMA = { type: 'string', enum: ['agent', 'reviewer', 'dual'] } as const

const OUTPUT_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const

function slimSummary(s: AcceptanceSummary) {
  return {
    allRequiredPassed: s.allRequiredPassed,
    passedCount: s.passedCount,
    selfClaimedCount: s.selfClaimedCount,
    totalCount: s.totalCount,
  }
}

/** Create the tool definitions for goal acceptance criteria. */
export function createAcceptanceTools(ctx: Context): ToolDefinition[] {
  const getTool = defineTool({
    name: 'get_acceptance_criteria',
    description: 'Read the current Goal acceptance criteria, individual statuses, evidence, task progress, and evaluation summary.',
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
    description: 'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation. Optional role field controls self-claim behavior: agent marks passed as self-claimed (needs reviewer confirmation), reviewer/dual marks formal passed. Criteria are immutable once locked, so calling this again rotates to a NEW goal instead of failing; the response reports previousGoalId and previousGoalIncomplete=true when the goal you just left still had unfinished required criteria. To add criteria to the CURRENT goal use amend_acceptance_criteria; to return to a rotated-away goal use list_goals then switch_goal.',
    parameters: {
      criteria: {
        type: 'array',
        required: true,
        description: 'Array of criteria definitions with id, description, required flag, verification method, optional task IDs, and optional dependencies.',
        items: CRITERION_ITEM_SCHEMA,
      },
      role: { ...ROLE_SCHEMA, description: 'Role locking criteria; defaults to agent. agent: passed marks self-claimed, requiring confirm_criterion by an independent reviewer. reviewer/dual: formal passed immediately (use only when the user explicitly waives independent review).' },
    },
    output: {
      schema: OUTPUT_OBJECT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('acceptance tools require a calling agent')
      const service = ctx.get('goalAcceptance')
      if (service === undefined) throw new Error('goalAcceptance service is not mounted')
      const rawCriteria = args.criteria as Array<{ id: string; description: string; required?: boolean; method?: string; task_ids?: string[]; depends_on?: string[] }>
      const mapped = rawCriteria.map(c => ({
        id: c.id,
        description: c.description,
        ...c.required !== undefined ? { required: c.required } : {},
        ...c.method !== undefined ? { method: c.method } : {},
        ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
        ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
      }))
      const role = (args.role as GoalRole | undefined) ?? 'agent'
      try {
        const criteria = await service.setCriteria(agent, mapped, role)
        return {
          criteria,
          goalId: service.getActiveGoalId(agent),
          summary: service.summarize(agent),
        } as never
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
          // Locked criteria are immutable by design, so rotate to a fresh goal
          // instead of failing: an error here dead-ends the caller on a goal it
          // can no longer edit. The previous goal keeps its own events and stays
          // reachable through list_goals / switch_goal. When it was left
          // unfinished we say so in the response so the abandonment is visible
          // rather than silent.
          const previousGoalId = service.getActiveGoalId(agent)
          const completion = service.canComplete(agent)
          const previousGoalSummary = slimSummary(service.summarize(agent))
          await service.startGoal(agent)
          const criteria = await service.setCriteria(agent, mapped, role)
          return {
            goalId: service.getActiveGoalId(agent),
            previousGoalId,
            autoStarted: true,
            previousGoalIncomplete: !completion.allowed,
            ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
            criteria,
            summary: service.summarize(agent),
          } as never
        }
        throw e
      }
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
      evidence_type: { type: 'string', enum: ['command', 'file', 'url', 'text'] },
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
        ...args.evidence_type !== undefined ? { evidenceType: args.evidence_type as EvidenceType } : {},
      }).then(updated => ({
        criterion: updated,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present(`Validate criterion "${String(args.criterion_id)}"`, 'other', args),
  })

  const updateTaskTool = defineTool({
    name: 'update_task_status',
    description: 'Update the status of a task linked to one or more acceptance criteria. When all tasks linked to a criterion are completed, that criterion becomes ready to validate.',
    parameters: {
      task_id: {
        type: 'string',
        required: true,
        description: 'The task ID to update.',
      },
      status: {
        type: 'string',
        required: true,
        enum: TASK_STATUSES,
        description: 'New task status: pending | in_progress | completed | failed',
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
      return service.updateTaskStatus(agent, {
        taskId: args.task_id as string,
        status: args.status as TaskStatus,
      }).then(() => ({
        taskId: args.task_id,
        status: args.status,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present(`Update task "${String(args.task_id)}" -> ${String(args.status)}`, 'other', args),
  })

  const amendTool = defineTool({
    name: 'amend_acceptance_criteria',
    description: 'Append new acceptance criteria after the initial lock. Existing criteria are not modified. Use when requirements expand during execution.',
    parameters: {
      criteria: {
        type: 'array',
        required: true,
        description: 'New criteria to append. Each must have a unique id not already present.',
        items: CRITERION_ITEM_SCHEMA,
      },
      reason: {
        type: 'string',
        required: true,
        description: 'Human-readable reason for the amendment (recorded in audit trail).',
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
      const rawCriteria = args.criteria as Array<{ id: string; description: string; required?: boolean; method?: string; task_ids?: string[]; depends_on?: string[] }>
      return service.amendCriteria(agent, {
        criteria: rawCriteria.map(c => ({
          id: c.id,
          description: c.description,
          ...c.required !== undefined ? { required: c.required } : {},
          ...c.method !== undefined ? { method: c.method } : {},
          ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
          ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
        })),
        reason: args.reason as string,
      }).then(added => ({
        addedCriteria: added,
        goalId: service.getActiveGoalId(agent),
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present('Amend acceptance criteria', 'other', args),
  })

  const requireService = (exec: { agent?: import('@deepseek-ai/dsh-agent').Agent }) => {
    if (exec.agent === undefined) throw new Error('acceptance tools require a calling agent')
    const service = ctx.get('goalAcceptance')
    if (service === undefined) throw new Error('goalAcceptance service is not mounted')
    return { agent: exec.agent, service }
  }

  const confirmTool = defineTool({
    name: 'confirm_criterion',
    description: 'Independently confirm a self-claimed passed criterion with high-confidence evidence. Text evidence is rejected.',
    parameters: { criterion_id: { type: 'string', required: true }, evidence: { type: 'string', required: true }, evidence_type: { type: 'string', required: true, enum: ['command', 'file', 'url'] } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec)
      return service.confirmCriterion(agent, { criterionId: args.criterion_id as string, evidence: args.evidence as string, evidenceType: args.evidence_type as EvidenceType }).then(criterion => ({ criterion, summary: service.summarize(agent) })) as never
    },
    presentCall: args => present('Confirm criterion', 'other', args),
  })

  const canCompleteTool = defineTool({
    name: 'can_complete_goal', description: 'Check whether all required criteria are formally passed.', parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve(service.canComplete(agent)) as never },
    presentCall: () => present('Check goal completion', 'read'),
  })

  const setPlanTool = defineTool({
    name: 'set_task_plan', description: 'Set and lock the task decomposition plan. Requires criteria to be locked first.',
    parameters: { tasks: { type: 'array', required: true, items: TASK_PLAN_ITEM_SCHEMA } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec)
      const tasks = args.tasks as Array<{ id: string; description: string; deliverable: string; depends_on?: string[] }>
      return service.setTaskPlan(agent, tasks.map(t => ({ id: t.id, description: t.description, deliverable: t.deliverable, ...t.depends_on !== undefined ? { dependsOn: t.depends_on } : {} }))).then(taskPlan => ({ taskPlan, summary: service.summarize(agent) })) as never
    },
    presentCall: args => present('Set task plan', 'other', args),
  })

  const getPlanTool = defineTool({
    name: 'get_task_plan', description: 'Read the current task decomposition plan with live statuses.', parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ taskPlan: service.getTaskPlan(agent) }) as never },
    presentCall: () => present('Read task plan', 'read'),
  })

  const startTool = defineTool({
    name: 'start_goal', description: 'Start a new independent goal and make it active.', parameters: { title: { type: 'string' } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goal: service.startGoal(agent, args.title as string | undefined), message: 'New goal started and set as active.' }) as never },
    presentCall: args => present('Start goal', 'other', args),
  })

  const listTool = defineTool({
    name: 'list_goals', description: 'List all goals with status summaries.', parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goals: service.listGoals(agent) }) as never },
    presentCall: () => present('List goals', 'read'),
  })

  const switchTool = defineTool({
    name: 'switch_goal', description: 'Switch the active goal by ID.', parameters: { goal_id: { type: 'string', required: true } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goal: service.switchGoal(agent, args.goal_id as string), message: 'Switched active goal.' }) as never },
    presentCall: args => present('Switch goal', 'other', args),
  })

  const resetTool = defineTool({
    name: 'reset_goal', description: 'Delete the current goal and clear its acceptance state.', parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); service.resetGoal(agent); return Promise.resolve({ message: 'Current goal deleted. No active goal.' }) as never },
    presentCall: () => present('Reset goal', 'other'),
  })

  return [setTool, getTool, validateTool, confirmTool, updateTaskTool, amendTool, canCompleteTool, setPlanTool, getPlanTool, startTool, listTool, switchTool, resetTool]
}
