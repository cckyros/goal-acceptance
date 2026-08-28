/**
 * dsh (DeepSeek Harness) native cordis plugin — the single-package evolution of
 * the original `goal-acceptance` dsh package. Registers the per-agent
 * GoalAcceptanceService, the 13 acceptance tools (names/descriptions aligned
 * with the MCP manifest), the system-prompt policy section, turn-stopping
 * steering, and the invariant companion.
 *
 * Activation: package.json "dsh" key → cordis.patch.yml insert line (id =
 * manifest.name) → the profile pnpm closure loads this module (package main
 * entry) and injects @deepseek-ai/cordis + @deepseek-ai/dsh-tools at runtime.
 * Those packages are devDependencies here for types only — this file is
 * bundled with @deepseek-ai/* external (see build.mjs), so the plugin never
 * ships its own copies.
 *
 * Per-agent semantics preserved from the original package: engines, goal maps
 * and active-goal pointers are WeakMap<Agent, …>, and events are appended to
 * the agent's session (SessionAcceptanceStore) so they replay from the
 * transcript — behavior equivalent to the pre-refactor dsh plugin.
 */

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { manifest } from './manifest.ts'
import { SessionAcceptanceStore } from './goal-manager.ts'
import { GoalAcceptanceEngine, GoalAcceptanceError, InMemoryAcceptanceStore, type AcceptanceSummary, type AmendSpec, type ConfirmCriterionSpec, type CriterionSpec, type EvidenceType, type GoalCriterion, type GoalCriterionStatus, type GoalRole, type GoalTask, type TaskPlanSpec, type TaskStatus, type TaskUpdateSpec, type ValidateCriterionSpec } from './engine/index.ts'
import { renderAcceptanceGuidance } from './prompt.ts'
import * as invariant from './invariant.ts'

// Session event declarations: session.append('goal-acceptance/…') payloads.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'goal-acceptance/set': Omit<import('./engine/index.ts').GoalAcceptanceSetEvent, 'type'>
    'goal-acceptance/validate': Omit<import('./engine/index.ts').GoalAcceptanceValidateEvent, 'type'>
    'goal-acceptance/task-update': Omit<import('./engine/index.ts').GoalAcceptanceTaskUpdateEvent, 'type'>
    'goal-acceptance/amend': Omit<import('./engine/index.ts').GoalAcceptanceAmendEvent, 'type'>
    'goal-acceptance/task-plan': Omit<import('./engine/index.ts').GoalAcceptanceTaskPlanEvent, 'type'>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    goalAcceptance: GoalAcceptanceService
  }
}

/** Stable plugin id — must match the cordis.patch.yml insert id. */
export const name = manifest.name

/** Services required for goal-acceptance policy and tool registration. */
export const inject = ['agents', 'tools', 'systemPrompt'] as const

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
 * GoalAcceptanceService manages immutable criteria for Goal sessions
 * (per-agent: engines/goals/active goals live in WeakMaps, events persist to
 * the agent's session).
 */
export class GoalAcceptanceService extends Service {
  static inject = ['agents']

  private readonly engines = new WeakMap<Agent, GoalAcceptanceEngine>()
  private readonly goals = new WeakMap<Agent, Map<string, { engine: GoalAcceptanceEngine; title: string; createdAt: number }>>()
  private readonly activeGoals = new WeakMap<Agent, string>()

  constructor(ctx: Context) {
    super(ctx, 'goalAcceptance')
  }

  private getEngine(agent: Agent): GoalAcceptanceEngine {
    let engine = this.engines.get(agent)
    if (engine === undefined) {
      engine = new GoalAcceptanceEngine(new SessionAcceptanceStore(agent.session))
      this.engines.set(agent, engine)
      const id = randomUUID()
      const goals = new Map([[id, { engine, title: '', createdAt: Date.now() }]])
      this.goals.set(agent, goals)
      this.activeGoals.set(agent, id)
    }
    return engine
  }

  private goalMap(agent: Agent) { this.getEngine(agent); return this.goals.get(agent)! }

  startGoal(agent: Agent, title?: string) {
    const goals = this.goalMap(agent)
    const id = randomUUID()
    const meta = { id, title: title ?? '', createdAt: Date.now() }
    goals.set(id, { ...meta, engine: new GoalAcceptanceEngine(new InMemoryAcceptanceStore()) })
    this.activeGoals.set(agent, id)
    this.engines.set(agent, goals.get(id)!.engine)
    return meta
  }

  listGoals(agent: Agent) {
    const active = this.activeGoals.get(agent)
    return Array.from(this.goalMap(agent).entries()).map(([id, goal]) => {
      const summary = goal.engine.summarize()
      return { id, title: goal.title, createdAt: goal.createdAt, criteriaCount: summary.totalCount, passedCount: summary.passedCount, allRequiredPassed: summary.allRequiredPassed, isActive: id === active }
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  switchGoal(agent: Agent, id: string) {
    const goal = this.goalMap(agent).get(id)
    if (goal === undefined) throw new GoalAcceptanceError(`goal ${id} not found`, 'GOAL_ACCEPTANCE_NOT_FOUND')
    this.activeGoals.set(agent, id)
    this.engines.set(agent, goal.engine)
    return { id, title: goal.title, createdAt: goal.createdAt }
  }

  resetGoal(agent: Agent): void {
    const goals = this.goalMap(agent)
    const id = this.activeGoals.get(agent)
    if (id === undefined) throw new GoalAcceptanceError('no active goal to reset', 'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL')
    goals.delete(id)
    this.activeGoals.delete(agent)
    this.engines.delete(agent)
  }

  getActiveGoalId(agent: Agent): string | undefined { this.getEngine(agent); return this.activeGoals.get(agent) }

  /** Set and lock the acceptance criteria for the agent's current Goal. */
  setCriteria(agent: Agent, specs: readonly CriterionSpec[], role: GoalRole = 'agent'): Promise<GoalCriterion[]> {
    return this.getEngine(agent).setCriteria(specs, role)
  }

  /** Append new criteria after the initial lock. */
  amendCriteria(agent: Agent, spec: AmendSpec): Promise<GoalCriterion[]> {
    return this.getEngine(agent).amendCriteria(spec)
  }

  /** Record verification status and evidence for one criterion. */
  validateCriterion(agent: Agent, spec: ValidateCriterionSpec): Promise<GoalCriterion> {
    return this.getEngine(agent).validateCriterion(spec)
  }

  confirmCriterion(agent: Agent, spec: ConfirmCriterionSpec): Promise<GoalCriterion> {
    return this.getEngine(agent).confirmCriterion(spec)
  }

  setTaskPlan(agent: Agent, specs: readonly TaskPlanSpec[]): Promise<GoalTask[]> {
    return this.getEngine(agent).setTaskPlan(specs)
  }

  getTaskPlan(agent: Agent): GoalTask[] { return this.getEngine(agent).getTaskPlan() }

  /** Update the status of a linked task. */
  updateTaskStatus(agent: Agent, spec: TaskUpdateSpec): Promise<void> {
    return this.getEngine(agent).updateTaskStatus(spec)
  }

  /** Get all criteria for the given agent in declaration order. */
  getCriteria(agent: Agent): GoalCriterion[] {
    return this.getEngine(agent).getCriteria()
  }

  /** Get a single criterion by id. */
  getCriterion(agent: Agent, id: string): GoalCriterion | undefined {
    return this.getEngine(agent).getCriterion(id)
  }

  /** Compute aggregate summary of criteria validation. */
  summarize(agent: Agent): AcceptanceSummary {
    return this.getEngine(agent).summarize()
  }

  /** Check whether this Goal is allowed to conclude with 'complete'. */
  canComplete(agent: Agent): { allowed: boolean; reason?: string } {
    return this.getEngine(agent).canComplete()
  }
}

// ------------------------------------------------------------------ tools

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
    method: {
      type: 'string',
      enum: ['command', 'file', 'url', 'manual'],
      description: 'Verification method: "command", "file", "url", or "manual".',
    },
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

/** Manifest is the identity single source: tool descriptions match the MCP server's. */
function description(toolName: string): string {
  return manifest.tools.find(t => t.name === toolName)!.description
}

/** Create the tool definitions for goal acceptance criteria. */
export function createAcceptanceTools(ctx: Context): ToolDefinition[] {
  const getTool = defineTool({
    name: 'get_acceptance_criteria',
    description: description('get_acceptance_criteria'),
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

  function slimSummary(s: AcceptanceSummary) {
    return {
      allRequiredPassed: s.allRequiredPassed,
      passedCount: s.passedCount,
      selfClaimedCount: s.selfClaimedCount,
      totalCount: s.totalCount,
    }
  }

  const setTool = defineTool({
    name: 'set_acceptance_criteria',
    description: description('set_acceptance_criteria'),
    parameters: {
      criteria: {
        type: 'array',
        required: true,
        description: 'Array of criteria definitions with id, description, required flag, verification method, optional task IDs, and optional dependencies.',
        items: CRITERION_ITEM_SCHEMA,
      },
      role: { ...ROLE_SCHEMA, description: 'Role locking criteria; defaults to agent.' },
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
          // Locked criteria are immutable, so an error here dead-ends the caller
          // on a goal it can no longer edit. Rotate to a fresh goal instead —
          // the abandoned goal keeps its events and stays reachable through
          // list_goals / switch_goal. When it was left unfinished we surface
          // the abandonment in the response (upstream b883e95 semantics).
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
    description: description('validate_criterion'),
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
    description: description('update_task_status'),
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
    description: description('amend_acceptance_criteria'),
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

  const requireService = (exec: { agent?: Agent }) => {
    if (exec.agent === undefined) throw new Error('acceptance tools require a calling agent')
    const service = ctx.get('goalAcceptance')
    if (service === undefined) throw new Error('goalAcceptance service is not mounted')
    return { agent: exec.agent, service }
  }

  const confirmTool = defineTool({
    name: 'confirm_criterion',
    description: description('confirm_criterion'),
    parameters: { criterion_id: { type: 'string', required: true }, evidence: { type: 'string', required: true }, evidence_type: { type: 'string', required: true, enum: ['command', 'file', 'url'] } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec)
      return service.confirmCriterion(agent, { criterionId: args.criterion_id as string, evidence: args.evidence as string, evidenceType: args.evidence_type as EvidenceType }).then(criterion => ({ criterion, summary: service.summarize(agent) })) as never
    },
    presentCall: args => present('Confirm criterion', 'other', args),
  })

  const canCompleteTool = defineTool({
    name: 'can_complete_goal', description: description('can_complete_goal'), parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve(service.canComplete(agent)) as never },
    presentCall: () => present('Check goal completion', 'read'),
  })

  const setPlanTool = defineTool({
    name: 'set_task_plan', description: description('set_task_plan'),
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
    name: 'get_task_plan', description: description('get_task_plan'), parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ taskPlan: service.getTaskPlan(agent) }) as never },
    presentCall: () => present('Read task plan', 'read'),
  })

  const startTool = defineTool({
    name: 'start_goal', description: description('start_goal'), parameters: { title: { type: 'string' } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goal: service.startGoal(agent, args.title as string | undefined), message: 'New goal started and set as active.' }) as never },
    presentCall: args => present('Start goal', 'other', args),
  })

  const listTool = defineTool({
    name: 'list_goals', description: description('list_goals'), parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goals: service.listGoals(agent) }) as never },
    presentCall: () => present('List goals', 'read'),
  })

  const switchTool = defineTool({
    name: 'switch_goal', description: description('switch_goal'), parameters: { goal_id: { type: 'string', required: true } },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) { const { agent, service } = requireService(exec); return Promise.resolve({ goal: service.switchGoal(agent, args.goal_id as string), message: 'Switched active goal.' }) as never },
    presentCall: args => present('Switch goal', 'other', args),
  })

  const runAndValidateTool = defineTool({
    name: 'run_and_validate',
    description: description('run_and_validate'),
    parameters: {
      criterion_id: { type: 'string', required: true, description: 'Criterion ID to validate.' },
      command: { type: 'string', required: true, description: 'Shell command to execute.' },
      cwd: { type: 'string', description: 'Optional working directory.' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
      verbose: { type: 'boolean', description: 'Default false: slim summary. true: full summary.' },
    },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const { agent, service } = requireService(exec)
      const criterionId = args.criterion_id as string
      const command = args.command as string
      const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd.trim() : undefined
      const timeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 60000

      let stdout = ''
      let stderr = ''
      let exitCode = 0
      try {
        stdout = execSync(command, {
          cwd,
          timeout,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 4 * 1024 * 1024,
        })
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string }
        stdout = execErr.stdout ?? ''
        stderr = execErr.stderr ?? (execErr.message || String(err))
        exitCode = typeof execErr.status === 'number' ? execErr.status : 1
      }

      const status: GoalCriterionStatus = exitCode === 0 ? 'passed' : 'failed'
      const rawEvidence = [
        `$ ${command}`,
        stdout.trim() ? `[stdout]\n${stdout.trim()}` : '',
        stderr.trim() ? `[stderr]\n${stderr.trim()}` : '',
        `[exit code] ${exitCode}`,
      ].filter(Boolean).join('\n\n')

      return service.validateCriterion(agent, {
        criterionId,
        status,
        evidence: rawEvidence,
        evidenceType: 'command',
      }).then(updated => ({
        criterion: updated,
        goalId: service.getActiveGoalId(agent),
        commandOutput: { exitCode, stdout, stderr },
        summary: service.summarize(agent),
      })) as never
    },
    presentCall: args => present(`Run and validate criterion "${String(args.criterion_id)}"`, 'other', args),
  })

  const quickStartTool = defineTool({
    name: 'quick_start_goal',
    description: description('quick_start_goal'),
    parameters: {
      title: { type: 'string', description: 'Optional short goal title.' },
      role: { type: 'string', enum: ['agent', 'reviewer', 'dual'], description: 'Role locking criteria.' },
      criteria: { type: 'array', required: true, items: CRITERION_ITEM_SCHEMA },
      tasks: { type: 'array', items: TASK_PLAN_ITEM_SCHEMA },
    },
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    async execute(args, exec) {
      const { agent, service } = requireService(exec)
      const rawCriteria = args.criteria as Array<{ id: string; description: string; required?: boolean; method?: string; task_ids?: string[]; depends_on?: string[] }>
      const rawTasks = args.tasks as Array<{ id: string; description: string; deliverable: string; depends_on?: string[] }> | undefined
      const mappedCriteria = rawCriteria.map(c => ({
        id: c.id,
        description: c.description,
        ...c.required !== undefined ? { required: c.required } : {},
        ...c.method !== undefined ? { method: c.method } : {},
        ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
        ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
      }))
      const role = (args.role as GoalRole | undefined) ?? 'agent'
      const title = args.title as string | undefined

      try {
        if (title !== undefined) await service.startGoal(agent, title)
        const criteria = await service.setCriteria(agent, mappedCriteria, role)
        let taskPlan
        if (Array.isArray(rawTasks) && rawTasks.length > 0) {
          taskPlan = await service.setTaskPlan(agent, rawTasks.map(t => ({
            id: t.id,
            description: t.description,
            deliverable: t.deliverable,
            ...t.depends_on !== undefined ? { dependsOn: t.depends_on } : {},
          })))
        }
        return {
          goalId: service.getActiveGoalId(agent),
          criteria,
          taskPlan,
          summary: service.summarize(agent),
          message: 'Goal initialized and locked successfully.',
        } as never
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
          const previousGoalId = service.getActiveGoalId(agent)
          const completion = service.canComplete(agent)
          const previousGoalSummary = slimSummary(service.summarize(agent))
          await service.startGoal(agent, title)
          const criteria = await service.setCriteria(agent, mappedCriteria, role)
          let taskPlan
          if (Array.isArray(rawTasks) && rawTasks.length > 0) {
            taskPlan = await service.setTaskPlan(agent, rawTasks.map(t => ({
              id: t.id,
              description: t.description,
              deliverable: t.deliverable,
              ...t.depends_on !== undefined ? { dependsOn: t.depends_on } : {},
            })))
          }
          return {
            goalId: service.getActiveGoalId(agent),
            previousGoalId,
            autoStarted: true,
            previousGoalIncomplete: !completion.allowed,
            ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
            criteria,
            taskPlan,
            summary: service.summarize(agent),
            message: 'Goal rotated and locked successfully.',
          } as never
        }
        throw e
      }
    },
    presentCall: args => present('Quick start goal', 'other', args),
  })

  const resetTool = defineTool({
    name: 'reset_goal', description: description('reset_goal'), parameters: {},
    output: { schema: OUTPUT_OBJECT_SCHEMA, render: (_a: unknown, v: unknown) => [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] },
    execute(_args, exec) { const { agent, service } = requireService(exec); service.resetGoal(agent); return Promise.resolve({ message: 'Current goal deleted. No active goal.' }) as never },
    presentCall: () => present('Reset goal', 'other'),
  })

  return [setTool, getTool, validateTool, confirmTool, updateTaskTool, amendTool, canCompleteTool, setPlanTool, getPlanTool, startTool, listTool, switchTool, runAndValidateTool, quickStartTool, resetTool]
}

// ------------------------------------------------------------------ apply

/**
 * Apply the goal-acceptance plugin: installs the service, tools, prompt section,
 * the invariant companion, and turn-stopping loop check with dependency-aware
 * steering.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const autoSteer = config.autoSteerUncompleted !== false
  const maxSteering = config.maxSteeringTurns ?? 5

  // Install service if not present (awaited so the service is ready when the
  // tools/prompt/steer registrations below run against it).
  if (ctx.get('goalAcceptance') === undefined) {
    await ctx.plugin(GoalAcceptanceService)
  }

  // Register the invariant companion when the invariants service is mounted.
  // Full plugin object (name/inject/apply): cordis 4 refuses service access
  // from plugins that do not declare the service in their inject list.
  if (ctx.get('invariants') !== undefined) {
    await ctx.plugin({ name: invariant.name, inject: invariant.inject, apply: invariant.apply })
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
    // marked failed or blocked; no further work can be done automatically, let turn close.
    const actionable = criteria.filter(c => c.required && (c.status === 'pending' || c.status === 'in_progress'))
    const selfClaimedRequired = summary.selfClaimedPassed.filter(c => c.required)
    if (actionable.length === 0 && selfClaimedRequired.length === 0) return

    if (!autoSteer) return

    const count = steeringCounts.get(agent) ?? 0
    if (count >= maxSteering) return

    steeringCounts.set(agent, count + 1)

    // Build a dependency-aware steering message
    const parts: string[] = []
    parts.push(`Goal Acceptance Reminder (attempt ${count + 1}/${maxSteering}):`)

    if (selfClaimedRequired.length > 0) {
      const ids = selfClaimedRequired.map(c => `"${c.id}"`).join(', ')
      parts.push(`Required criteria ${ids} are self-claimed. Ask an independent reviewer to re-verify and call \`confirm_criterion\` with fresh command, file, or url evidence.`)
    } else if (actionable.length > 0) {
      parts.push('Required criteria remain pending or in progress; continue the work before stopping.')
    }

    // Task progress summary
    const tp = summary.taskProgress
    if (tp.totalTasks > 0) {
      parts.push(`Task progress: ${tp.completedTasks}/${tp.totalTasks} completed.`)
    }

    // Ready to validate; prompt the agent to validate these first
    if (summary.readyToValidate.length > 0) {
      const ready = summary.readyToValidate.map(c => `"${c.id}"`).join(', ')
      parts.push(`Ready to validate (all linked tasks done): ${ready}. Call \`validate_criterion\` with evidence now.`)
    }

    // Next actionable; ordered by dependency
    if (summary.nextActionable.length > 0) {
      const next = summary.nextActionable[0]!
      parts.push(`Next priority: "${next.id}" (${next.description}).`)
      if (summary.nextActionable.length > 1) {
        const rest = summary.nextActionable.slice(1).map(c => `"${c.id}"`).join(', ')
        parts.push(`Then: ${rest}.`)
      }
    } else {
      // No actionable with met dependencies; list what's blocked by deps
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
      source: { kind: 'plugin', plugin: manifest.name },
    }))
  })
}
