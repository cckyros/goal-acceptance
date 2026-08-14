/**
 * OpenClaw native plugin entry for goal-acceptance.
 * Registers 8 tools that directly call the core engine (no MCP stdio needed).
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'
import type { GoalAcceptanceEvent, GoalAcceptanceStore } from '@cckyros/goal-acceptance-core'
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'
import { Type } from 'typebox'

// --- FileAcceptanceStore (inlined from mcp package) ---

class FileAcceptanceStore implements GoalAcceptanceStore {
  constructor(private readonly path: string) {}

  async #read(): Promise<GoalAcceptanceEvent[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFile(this.path, 'utf-8')
    if (raw.trim().length === 0) return []
    return JSON.parse(raw) as GoalAcceptanceEvent[]
  }

  async #write(events: GoalAcceptanceEvent[]): Promise<void> {
    await writeFile(this.path, JSON.stringify(events, null, 2) + '\n')
  }

  get events(): readonly GoalAcceptanceEvent[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf-8')
    if (raw.trim().length === 0) return []
    return JSON.parse(raw) as GoalAcceptanceEvent[]
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    const events = await this.#read()
    events.push(event)
    await this.#write(events)
  }
}

// --- Store resolution ---

let engine: GoalAcceptanceEngine | null = null

function getEngine(cfg: { dataDir?: string } | undefined): GoalAcceptanceEngine {
  if (engine) return engine
  const dataDir = cfg?.dataDir || process.env.PLUGIN_DATA || ''
  const store = dataDir
    ? new FileAcceptanceStore(`${dataDir}/acceptance-events.json`)
    : new InMemoryAcceptanceStore()
  engine = new GoalAcceptanceEngine(store)
  return engine
}

// --- Schemas ---

const CriterionItem = Type.Object({
  id: Type.String({ description: 'Short unique identifier.' }),
  description: Type.String({ description: 'Concrete requirement.' }),
  required: Type.Optional(Type.Boolean({ description: 'Whether required for goal completion.' })),
  method: Type.Optional(Type.String({ description: 'Verification method: test, command, browser, manual.' })),
  task_ids: Type.Optional(Type.Array(Type.String(), { description: 'Task IDs linked to this criterion.' })),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: 'IDs of criteria that must be passed before this one.' })),
})

const TaskPlanItem = Type.Object({
  id: Type.String({ description: 'Unique task id (e.g. "t1", "api-endpoint").' }),
  description: Type.String({ description: 'Non-empty, unambiguous task description.' }),
  deliverable: Type.String({ description: 'Concrete artifact that proves this task is done.' }),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: 'Task ids this task depends on within the same plan.' })),
})

// --- Helpers ---

function slimSummary(s: { allRequiredPassed: boolean; passedCount: number; selfClaimedCount: number; totalCount: number }) {
  return {
    allRequiredPassed: s.allRequiredPassed,
    passedCount: s.passedCount,
    selfClaimedCount: s.selfClaimedCount,
    totalCount: s.totalCount,
  }
}

function mapCriterion(c: { id: string; description: string; required?: boolean; method?: string; task_ids?: string[]; depends_on?: string[] }) {
  return {
    id: c.id,
    description: c.description,
    ...c.required !== undefined ? { required: c.required } : {},
    ...c.method !== undefined ? { method: c.method } : {},
    ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
    ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
  }
}

function mapTask(t: { id: string; description: string; deliverable: string; depends_on?: string[] }) {
  return {
    id: t.id,
    description: t.description,
    deliverable: t.deliverable,
    ...t.depends_on !== undefined ? { dependsOn: t.depends_on } : {},
  }
}

// --- Plugin ---

export default defineToolPlugin({
  id: 'goal-acceptance',
  name: 'Goal Acceptance',
  description: 'Acceptance-criteria-driven goal completion for autonomous agents.',

  tools: (tool) => [
    tool({
      name: 'set_acceptance_criteria',
      description: 'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation. Optional role field controls self-claim behavior: agent marks passed as self-claimed (needs reviewer confirmation), reviewer/dual marks formal passed.',
      parameters: Type.Object({
        criteria: Type.Array(CriterionItem, { description: 'Array of criteria definitions.' }),
        role: Type.Optional(Type.Union([
          Type.Literal('agent'),
          Type.Literal('reviewer'),
          Type.Literal('dual'),
        ], { description: 'Role locking the criteria. agent: passed marks self-claimed. reviewer/dual: formal passed. Default: dual.' })),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const role = params.role || 'dual'
        const list = await eng.setCriteria(params.criteria.map(mapCriterion), role)
        const summary = eng.summarize()
        return { criteria: list, summary }
      },
    }),

    tool({
      name: 'get_acceptance_criteria',
      description: 'Read the current acceptance criteria, task progress, and summary. Default returns full criteria list + summary. Pass verbose=false for a one-line summary only.',
      parameters: Type.Object({
        verbose: Type.Optional(Type.Boolean({ description: 'Default true: returns criteria + full summary. false: returns only slim summary.' })),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const verbose = params.verbose !== false
        const summary = eng.summarize()
        if (!verbose) return { summary: slimSummary(summary) }
        const criteria = eng.getCriteria()
        return { criteria, summary }
      },
    }),

    tool({
      name: 'validate_criterion',
      description: 'Record verification status and evidence for one criterion. Statuses passed and failed require evidence. Optional evidence_type: command/file/url/text (default text, flagged low-confidence). When role=agent, passed is marked self-claimed. Default response is slim; pass verbose=true for full summary.',
      parameters: Type.Object({
        criterion_id: Type.String({ description: 'Exact criterion id.' }),
        status: Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('passed'),
          Type.Literal('failed'),
          Type.Literal('blocked'),
          Type.Literal('not_run'),
        ], { description: 'Outcome status.' }),
        evidence: Type.Optional(Type.String({ description: 'Verification evidence. Required for passed/failed.' })),
        evidence_type: Type.Optional(Type.Union([
          Type.Literal('command'),
          Type.Literal('file'),
          Type.Literal('url'),
          Type.Literal('text'),
        ], { description: 'Type of evidence. text = low confidence. Default: text.' })),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: returns criterion + slim summary. true: returns criterion + full summary.' })),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const updated = await eng.validateCriterion({
          criterionId: params.criterion_id,
          status: params.status,
          evidence: params.evidence,
          ...params.evidence_type !== undefined ? { evidenceType: params.evidence_type } : {},
        })
        const verbose = params.verbose === true
        const summary = eng.summarize()
        return verbose
          ? { criterion: updated, summary }
          : { criterion: updated, summary: slimSummary(summary) }
      },
    }),

    tool({
      name: 'update_task_status',
      description: 'Update the status of a task linked to one or more acceptance criteria. When all tasks linked to a criterion are completed, that criterion becomes ready to validate. Default response is slim; pass verbose=true for full summary.',
      parameters: Type.Object({
        task_id: Type.String({ description: 'The task ID to update.' }),
        status: Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
          Type.Literal('failed'),
        ], { description: 'New task status.' }),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: slim summary. true: full summary.' })),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        await eng.updateTaskStatus({
          taskId: params.task_id,
          status: params.status,
        })
        const verbose = params.verbose === true
        const summary = eng.summarize()
        return verbose
          ? { taskId: params.task_id, status: params.status, summary }
          : { taskId: params.task_id, status: params.status, summary: slimSummary(summary) }
      },
    }),

    tool({
      name: 'amend_acceptance_criteria',
      description: 'Append new acceptance criteria after the initial lock. Existing criteria are not modified. Use when requirements expand during execution.',
      parameters: Type.Object({
        criteria: Type.Array(CriterionItem, { description: 'New criteria to append.' }),
        reason: Type.String({ description: 'Human-readable reason for the amendment.' }),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const added = await eng.amendCriteria({
          criteria: params.criteria.map(mapCriterion),
          reason: params.reason,
        })
        const summary = eng.summarize()
        return { addedCriteria: added, summary }
      },
    }),

    tool({
      name: 'can_complete_goal',
      description: 'Check whether the goal can be completed based on current acceptance criteria.',
      parameters: Type.Object({}),
      execute: async (_params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        return eng.canComplete()
      },
    }),

    tool({
      name: 'set_task_plan',
      description: 'Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.',
      parameters: Type.Object({
        tasks: Type.Array(TaskPlanItem, { description: 'Ordered list of atomic tasks.' }),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const plan = await eng.setTaskPlan(params.tasks.map(mapTask))
        const summary = eng.summarize()
        return { taskPlan: plan, summary: slimSummary(summary) }
      },
    }),

    tool({
      name: 'get_task_plan',
      description: 'Read the current task decomposition plan with live task statuses.',
      parameters: Type.Object({}),
      execute: async (_params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const plan = eng.getTaskPlan()
        return { taskPlan: plan }
      },
    }),
  ],
})
