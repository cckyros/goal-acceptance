/**
 * OpenClaw native plugin entry for goal-acceptance.
 * Registers 13 tools that directly call the core engine (no MCP stdio needed).
 * Multi-goal: each goal has its own event file under ${dataDir}/goals/.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { GoalAcceptanceEngine, GoalAcceptanceError, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'
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

// --- Multi-goal manager (mirrors the MCP server design) ---

interface GoalMeta {
  readonly id: string
  readonly title: string
  readonly createdAt: number
}

let resolvedDataDir: string | null = null
let currentGoalId: string | null = null
const engineCache = new Map<string, GoalAcceptanceEngine>()
const metaCache = new Map<string, GoalMeta>()

function dataDir(cfg: { dataDir?: string } | undefined): string {
  if (resolvedDataDir === null) {
    resolvedDataDir = cfg?.dataDir || process.env.PLUGIN_DATA || ''
    if (resolvedDataDir) {
      mkdirSync(join(resolvedDataDir, 'goals'), { recursive: true })
      loadCurrentGoal()
    }
  }
  return resolvedDataDir
}

function goalsDir(): string {
  return resolvedDataDir ? join(resolvedDataDir, 'goals') : ''
}

function currentGoalFile(): string {
  return resolvedDataDir ? join(resolvedDataDir, 'current-goal.txt') : ''
}

function storeForGoal(goalId: string): GoalAcceptanceStore {
  const dir = goalsDir()
  return dir ? new FileAcceptanceStore(join(dir, `${goalId}.json`)) : new InMemoryAcceptanceStore()
}

function loadCurrentGoal(): void {
  const f = currentGoalFile()
  if (f && existsSync(f)) {
    const id = readFileSync(f, 'utf-8').trim()
    if (id.length > 0 && existsSync(join(goalsDir(), `${id}.meta.json`))) {
      currentGoalId = id
      loadGoalMeta(id)
    }
  }
}

function persistCurrentGoal(): void {
  const f = currentGoalFile()
  if (f) writeFileSync(f, currentGoalId ?? '')
}

function loadGoalMeta(id: string): GoalMeta | undefined {
  const cached = metaCache.get(id)
  if (cached) return cached
  const dir = goalsDir()
  if (!dir) return undefined
  const metaPath = join(dir, `${id}.meta.json`)
  if (!existsSync(metaPath)) return undefined
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as GoalMeta
  metaCache.set(id, meta)
  return meta
}

function getOrCreateEngine(goalId: string): GoalAcceptanceEngine {
  let engine = engineCache.get(goalId)
  if (engine === undefined) {
    engine = new GoalAcceptanceEngine(storeForGoal(goalId))
    engineCache.set(goalId, engine)
  }
  return engine
}

function getEngine(cfg: { dataDir?: string } | undefined): GoalAcceptanceEngine {
  dataDir(cfg)
  if (currentGoalId === null) {
    throw new GoalAcceptanceError(
      'no active goal. Call start_goal to create one, or set_acceptance_criteria to auto-create one.',
      'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL',
    )
  }
  return getOrCreateEngine(currentGoalId)
}

function startGoal(cfg: { dataDir?: string } | undefined, title?: string): GoalMeta {
  dataDir(cfg)
  const id = randomUUID()
  const meta: GoalMeta = { id, title: title ?? '', createdAt: Date.now() }
  const dir = goalsDir()
  if (dir) {
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + '\n')
    writeFileSync(join(dir, `${id}.json`), '[]')
  }
  metaCache.set(id, meta)
  currentGoalId = id
  persistCurrentGoal()
  engineCache.set(id, new GoalAcceptanceEngine(storeForGoal(id)))
  return meta
}

function listGoals(cfg: { dataDir?: string } | undefined) {
  dataDir(cfg)
  const dir = goalsDir()
  const metas: GoalMeta[] = dir
    ? readdirSync(dir).filter(f => f.endsWith('.meta.json')).map(f => {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as GoalMeta
        metaCache.set(meta.id, meta)
        return meta
      })
    : Array.from(metaCache.values())
  return metas.map(meta => {
    const engine = getOrCreateEngine(meta.id)
    const summary = engine.summarize()
    return {
      ...meta,
      criteriaCount: summary.totalCount,
      passedCount: summary.passedCount,
      allRequiredPassed: summary.allRequiredPassed,
      isActive: meta.id === currentGoalId,
    }
  }).sort((a, b) => b.createdAt - a.createdAt)
}

function switchGoal(cfg: { dataDir?: string } | undefined, id: string): GoalMeta {
  dataDir(cfg)
  const dir = goalsDir()
  const exists = dir ? existsSync(join(dir, `${id}.meta.json`)) : metaCache.has(id)
  if (!exists) {
    throw new GoalAcceptanceError(`goal ${id} not found`, 'GOAL_ACCEPTANCE_NOT_FOUND')
  }
  currentGoalId = id
  persistCurrentGoal()
  return loadGoalMeta(id) ?? { id, title: '', createdAt: 0 }
}

function resetGoal(cfg: { dataDir?: string } | undefined): void {
  dataDir(cfg)
  if (currentGoalId === null) {
    throw new GoalAcceptanceError('no active goal to reset', 'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL')
  }
  const id = currentGoalId
  const dir = goalsDir()
  if (dir) {
    try { unlinkSync(join(dir, `${id}.json`)) } catch { /* already removed */ }
    try { unlinkSync(join(dir, `${id}.meta.json`)) } catch { /* already removed */ }
  }
  engineCache.delete(id)
  metaCache.delete(id)
  currentGoalId = null
  persistCurrentGoal()
}

function ensureGoal(cfg: { dataDir?: string } | undefined): GoalAcceptanceEngine {
  dataDir(cfg)
  if (currentGoalId === null) {
    startGoal(cfg)
  }
  return getEngine(cfg)
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
      description: 'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation. Optional role field controls self-claim behavior: agent marks passed as self-claimed (needs reviewer confirmation), reviewer/dual marks formal passed. Criteria are immutable once locked, so calling this again rotates to a NEW goal instead of failing; the response reports previousGoalId and previousGoalIncomplete=true when the goal you just left still had unfinished required criteria. To add criteria to the CURRENT goal use amend_acceptance_criteria; to return to a rotated-away goal use list_goals then switch_goal.',
      parameters: Type.Object({
        criteria: Type.Array(CriterionItem, { description: 'Array of criteria definitions.' }),
        role: Type.Optional(Type.Union([
          Type.Literal('agent'),
          Type.Literal('reviewer'),
          Type.Literal('dual'),
        ], { description: 'Role locking the criteria. agent (default): passed marks self-claimed, requiring confirm_criterion by an independent reviewer. reviewer/dual: formal passed immediately (use only when the user explicitly waives independent review).' })),
      }),
      execute: async (params, ctx) => {
        let eng = ensureGoal(ctx?.pluginConfig)
        const role = params.role || 'agent'
        try {
          const list = await eng.setCriteria(params.criteria.map(mapCriterion), role)
          const summary = eng.summarize()
          return { goalId: currentGoalId, criteria: list, summary }
        } catch (e) {
          if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
            // Locked criteria are immutable by design, so rotate to a fresh goal
            // instead of failing: an error here dead-ends the caller on a goal it
            // can no longer edit. The previous goal keeps its own events and stays
            // reachable through list_goals / switch_goal. When it was left
            // unfinished we say so in the response so the abandonment is visible
            // rather than silent.
            const previousGoalId = currentGoalId
            const completion = eng.canComplete()
            const previousGoalSummary = slimSummary(eng.summarize())
            startGoal(ctx?.pluginConfig)
            eng = getEngine(ctx?.pluginConfig)
            const list = await eng.setCriteria(params.criteria.map(mapCriterion), role)
            const summary = eng.summarize()
            return {
              goalId: currentGoalId,
              previousGoalId,
              autoStarted: true,
              previousGoalIncomplete: !completion.allowed,
              ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
              criteria: list,
              summary,
            }
          }
          throw e
        }
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
      name: 'confirm_criterion',
      description: 'Reviewer confirmation of a self-claimed passed criterion. MUST be called by an independent reviewer agent (e.g. a subagent that did not do the work), NOT by the agent that performed the task. The reviewer must independently re-verify the criterion (re-run tests, re-check files) and provide that fresh evidence here. Requires high-confidence evidence_type (command/file/url); text is rejected. Converts self-claimed to formal pass, unblocking can_complete_goal.',
      parameters: Type.Object({
        criterion_id: Type.String({ description: 'Criterion id to confirm. Must currently be passed and self-claimed.' }),
        evidence: Type.String({ description: 'Independent re-verification evidence gathered by the reviewer (not copied from the original validation).' }),
        evidence_type: Type.Union([
          Type.Literal('command'),
          Type.Literal('file'),
          Type.Literal('url'),
        ], { description: 'Type of evidence. Must be high-confidence; text is not accepted.' }),
      }),
      execute: async (params, ctx) => {
        const eng = getEngine(ctx?.pluginConfig)
        const updated = await eng.confirmCriterion({
          criterionId: params.criterion_id,
          evidence: params.evidence,
          evidenceType: params.evidence_type,
        })
        const summary = eng.summarize()
        return { goalId: currentGoalId, criterion: updated, summary: slimSummary(summary) }
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
        return { goalId: currentGoalId, taskPlan: plan }
      },
    }),

    tool({
      name: 'start_goal',
      description: 'Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: 'Optional human-readable title for the goal.' })),
      }),
      execute: async (params, ctx) => {
        const meta = startGoal(ctx?.pluginConfig, params.title)
        return { goal: meta, message: 'New goal started and set as active.' }
      },
    }),

    tool({
      name: 'list_goals',
      description: 'List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.',
      parameters: Type.Object({}),
      execute: async (_params, ctx) => {
        return { goals: listGoals(ctx?.pluginConfig) }
      },
    }),

    tool({
      name: 'switch_goal',
      description: 'Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.',
      parameters: Type.Object({
        goal_id: Type.String({ description: 'The goal ID to switch to (from list_goals).' }),
      }),
      execute: async (params, ctx) => {
        const meta = switchGoal(ctx?.pluginConfig, params.goal_id)
        return { goal: meta, message: 'Switched active goal.' }
      },
    }),

    tool({
      name: 'reset_goal',
      description: 'Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.',
      parameters: Type.Object({}),
      execute: async (_params, ctx) => {
        resetGoal(ctx?.pluginConfig)
        return { message: 'Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal.' }
      },
    }),
  ],
})
