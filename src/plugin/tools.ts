/**
 * Model-facing tools for setting, reading, validating, and amending
 * acceptance criteria. Registered via manifest.tools — the framework's MCP
 * runtime serves them over stdio JSON-RPC. Ported from the original
 * goal-acceptance-mcp server (13 tools, same names/descriptions/schemas).
 */

import type { ToolContext, ToolDef } from "../framework/manifest.ts";
import { GoalAcceptanceError, type EvidenceType, type GoalCriterionStatus, type GoalRole, type TaskStatus } from "./engine/index.ts";
import { GoalManager } from "./goal-manager.ts";

const CRITERION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description'],
  properties: {
    id: { type: 'string', description: 'Short unique identifier.' },
    description: { type: 'string', description: 'Concrete requirement.' },
    required: { type: 'boolean', description: 'Whether required for goal completion.' },
    method: { type: 'string', description: 'Verification method: test, command, browser, manual.' },
    task_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task IDs linked to this criterion.',
    },
    depends_on: {
      type: 'array',
      items: { type: 'string' },
      description: 'IDs of criteria that must be passed before this one.',
    },
  },
}

const TASK_PLAN_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'description', 'deliverable'],
  properties: {
    id: { type: 'string', description: 'Unique task id (e.g. "t1", "api-endpoint").' },
    description: { type: 'string', description: 'Non-empty, unambiguous task description.' },
    deliverable: { type: 'string', description: 'Concrete artifact that proves this task is done.' },
    depends_on: {
      type: 'array',
      items: { type: 'string' },
      description: 'Task ids this task depends on within the same plan.',
    },
  },
}

/** Levenshtein distance for fuzzy matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[] = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return dp[n]!
}

/** Find closest match from candidates. Returns suggestion if distance <= threshold. */
function suggestClosest(input: string, candidates: readonly string[], threshold = 3): string | undefined {
  let best: string | undefined
  let bestDist = threshold + 1
  for (const c of candidates) {
    const d = levenshtein(input.toLowerCase(), c.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/** Structured error result, mirroring the original MCP server's isError shape. */
function fail(e: unknown): { error: string; code: string } {
  const message = e instanceof Error ? e.message : String(e)
  const code = e instanceof GoalAcceptanceError ? e.code : 'GOAL_ACCEPTANCE_INTERNAL_ERROR'
  return { error: message, code }
}

/** Compact one-line summary for default (non-verbose) responses. */
function slimSummary(s: { allRequiredPassed: boolean; passedCount: number; selfClaimedCount: number; totalCount: number }) {
  return {
    allRequiredPassed: s.allRequiredPassed,
    passedCount: s.passedCount,
    selfClaimedCount: s.selfClaimedCount,
    totalCount: s.totalCount,
  }
}

interface CriterionInput {
  id: string
  description: string
  required?: boolean
  method?: string
  task_ids?: string[]
  depends_on?: string[]
}

function mapCriterion(c: CriterionInput) {
  return {
    id: c.id,
    description: c.description,
    ...c.required !== undefined ? { required: c.required } : {},
    ...c.method !== undefined ? { method: c.method } : {},
    ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
    ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
  }
}

interface TaskInput {
  id: string
  description: string
  deliverable: string
  depends_on?: string[]
}

function mapTask(t: TaskInput) {
  return {
    id: t.id,
    description: t.description,
    deliverable: t.deliverable,
    ...t.depends_on !== undefined ? { dependsOn: t.depends_on } : {},
  }
}

// ─── Goal manager singleton (per resolved PLUGIN_DATA, process-scoped) ───

let manager: GoalManager | null = null
let managerDataDir: string | undefined

function getManager(config: { pluginData?: string }): GoalManager {
  const d = config.pluginData ?? ''
  if (manager === null || managerDataDir !== d) {
    manager = new GoalManager(d)
    managerDataDir = d
  }
  return manager
}

// ─── Tools ───

export const tools: ToolDef[] = [
  {
    name: 'set_acceptance_criteria',
    description: [
      'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation.',
      '',
      'WORKFLOW (follow in order):',
      '1. PLANNING: For multi-step tasks, spawn a planning subagent (subagent_explore profile) to explore the codebase, draft criteria with goal-backward coverage analysis (every requirement mapped to a criterion, no overlaps, no gaps), then call this tool. Do NOT write criteria directly under execution pressure.',
      '2. TASK PLAN: Call set_task_plan to decompose the goal into atomic tasks with dependencies.',
      '3. EXECUTE: update_task_status as tasks progress.',
      '4. VALIDATE: validate_criterion with evidence_type=command/file/url (NEVER text). You MUST run the actual command before validating.',
      '5. CONFIRM: confirm_criterion MUST be called by an independent reviewer agent with fresh high-confidence evidence. Converts self-claimed passes to formal passes.',
      '6. COMPLETE: can_complete_goal checks all required criteria are formally passed. Self-claimed required criteria block completion.',
      '',
      'CRITERION QUALITY RULES:',
      '- id: kebab-case, unique',
      '- description: concrete and verifiable (NOT vague verbs like "implement", "ensure", "handle")',
      '- method: command | file | url (NEVER text)',
      '- required: true if the goal cannot be achieved without it',
      '- role: agent (default) marks passed as self-claimed; reviewer/dual marks formal passed',
      '',
      'CRITICAL: Default role=agent. Passed criteria are self-claimed, requiring confirm_criterion before completion. Do NOT declare a task complete until can_complete_goal returns allowed=true.',
      '',
      'ALREADY-LOCKED BEHAVIOUR: Criteria are immutable once locked, so calling this again rotates to a NEW goal instead of failing. The response reports previousGoalId, and previousGoalIncomplete=true when the goal you just left still had unfinished required criteria. To add criteria to the CURRENT goal use amend_acceptance_criteria; to return to a rotated-away goal use list_goals then switch_goal.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['criteria'],
      properties: {
        criteria: {
          type: 'array',
          description: 'Array of criteria definitions.',
          items: CRITERION_ITEM_SCHEMA,
        },
        role: {
          type: 'string',
          enum: ['agent', 'reviewer', 'dual'],
          description: 'Role locking the criteria. agent (default): passed marks self-claimed, requiring confirm_criterion by an independent reviewer. reviewer/dual: formal passed immediately (use only when the user explicitly waives independent review).',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      const criteria = args.criteria as CriterionInput[]
      const role = (args.role as GoalRole | undefined) ?? 'agent'
      let engine = mgr.ensureGoal()
      try {
        const list = await engine.setCriteria(criteria.map(mapCriterion), role)
        const summary = engine.summarize()
        return { goalId: mgr.getCurrentGoalId(), criteria: list, summary }
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
          // Locked criteria are immutable, so an error here dead-ends the caller
          // on a goal it can no longer edit. Rotate to a fresh goal instead —
          // the abandoned goal keeps its events and stays reachable through
          // list_goals / switch_goal. When it was left unfinished we surface
          // the abandonment in the response (upstream b883e95 semantics).
          const previousGoalId = mgr.getCurrentGoalId()
          const completion = engine.canComplete()
          const previousGoalSummary = slimSummary(engine.summarize())
          mgr.startGoal()
          engine = mgr.getEngine()
          const list = await engine.setCriteria(criteria.map(mapCriterion), role)
          return {
            goalId: mgr.getCurrentGoalId(),
            previousGoalId,
            autoStarted: true,
            previousGoalIncomplete: !completion.allowed,
            ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
            criteria: list,
            summary: engine.summarize(),
          }
        }
        return fail(e)
      }
    },
  },
  {
    name: 'get_acceptance_criteria',
    description: 'Read the current acceptance criteria, task progress, and summary. Default returns full criteria list + summary. Pass verbose=false for a one-line summary only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Default true: returns criteria + full summary. false: returns only slim summary {allRequiredPassed, passedCount, selfClaimedCount, totalCount}.',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const verbose = args.verbose !== false // default true
        const engine = mgr.getEngine()
        const summary = engine.summarize()
        if (!verbose) {
          return { goalId: mgr.getCurrentGoalId(), summary: slimSummary(summary) }
        }
        const criteria = engine.getCriteria()
        return { goalId: mgr.getCurrentGoalId(), criteria, summary }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'validate_criterion',
    description: [
      'Record verification status and evidence for one criterion. Statuses passed and failed require evidence.',
      '',
      'EVIDENCE REQUIREMENTS — you MUST run the actual verification before calling this:',
      '- method=command: run the exact command in a shell, paste real stdout/stderr + exit code',
      '- method=file: read the file and check the content, paste relevant lines',
      '- method=url: make the HTTP request, paste response status + body',
      '',
      'FORBIDDEN:',
      '- Do NOT validate passed without running anything',
      '- Do NOT write "should work" or "looks correct" as evidence',
      '- Do NOT use evidence_type=text for a criterion with method=command',
      '- Do NOT copy evidence from a previous run without re-running',
      '',
      'When role=agent (default), passed is marked self-claimed (needs confirm_criterion by an independent reviewer before completion). Default response is slim; pass verbose=true for full summary.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['criterion_id', 'status'],
      properties: {
        criterion_id: { type: 'string', description: 'Exact criterion id.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'passed', 'failed', 'blocked', 'not_run'],
          description: 'Outcome status.',
        },
        evidence: { type: 'string', description: 'Verification evidence. Required for passed/failed.' },
        evidence_type: {
          type: 'string',
          enum: ['command', 'file', 'url', 'text'],
          description: 'Type of evidence. text = low confidence. Default: text.',
        },
        verbose: {
          type: 'boolean',
          description: 'Default false: returns criterion + slim summary. true: returns criterion + full summary.',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      const engine = mgr.getEngine()
      try {
        const updated = await engine.validateCriterion({
          criterionId: args.criterion_id as string,
          status: args.status as GoalCriterionStatus,
          evidence: args.evidence as string | undefined,
          ...args.evidence_type !== undefined ? { evidenceType: args.evidence_type as EvidenceType } : {},
        })
        const verbose = args.verbose === true
        const summary = engine.summarize()
        return {
          goalId: mgr.getCurrentGoalId(),
          criterion: updated,
          summary: verbose ? summary : slimSummary(summary),
        }
      } catch (e) {
        if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND') {
          const allIds = engine.getCriteria().map(c => c.id)
          const suggestion = suggestClosest(args.criterion_id as string, allIds)
          return fail(new GoalAcceptanceError(
            `criterion_id "${String(args.criterion_id)}" not found. Available IDs: [${allIds.join(', ')}].${suggestion ? ` Did you mean "${suggestion}"?` : ''} Call get_acceptance_criteria to see the full list.`,
            'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND',
          ))
        }
        return fail(e)
      }
    },
  },
  {
    name: 'confirm_criterion',
    description: [
      'Reviewer confirmation of a self-claimed passed criterion. Converts self-claimed to formal pass, unblocking can_complete_goal.',
      '',
      'WHO SHOULD CALL: An independent reviewer agent (e.g. a subagent spawned to review the work). NOT the agent that performed the task.',
      '',
      'WHAT TO DO:',
      '1. Read the criterion description and its original evidence',
      '2. Independently re-verify — do NOT trust the original evidence:',
      '   - method=command: re-run the command yourself',
      '   - method=file: read the file yourself and check the content',
      '   - method=url: make the HTTP request yourself',
      '3. If re-verification passes, call this tool with YOUR fresh evidence',
      '4. If re-verification fails, call validate_criterion with status=failed',
      '',
      'REQUIRES high-confidence evidence_type (command/file/url); text is rejected.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['criterion_id', 'evidence', 'evidence_type'],
      properties: {
        criterion_id: { type: 'string', description: 'Criterion id to confirm. Must currently be passed and self-claimed.' },
        evidence: { type: 'string', description: 'Independent re-verification evidence gathered by the reviewer (not copied from the original validation).' },
        evidence_type: {
          type: 'string',
          enum: ['command', 'file', 'url'],
          description: 'Type of evidence. Must be high-confidence; text is not accepted.',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const engine = mgr.getEngine()
        const updated = await engine.confirmCriterion({
          criterionId: args.criterion_id as string,
          evidence: args.evidence as string,
          evidenceType: args.evidence_type as EvidenceType,
        })
        const summary = engine.summarize()
        return { goalId: mgr.getCurrentGoalId(), criterion: updated, summary: slimSummary(summary) }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'update_task_status',
    description: 'Update the status of a task linked to one or more acceptance criteria. When all tasks linked to a criterion are completed, that criterion becomes ready to validate. Default response is slim; pass verbose=true for full summary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'status'],
      properties: {
        task_id: { type: 'string', description: 'The task ID to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'failed'],
          description: 'New task status.',
        },
        verbose: {
          type: 'boolean',
          description: 'Default false: returns taskId/status + slim summary. true: returns full summary.',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const engine = mgr.getEngine()
        await engine.updateTaskStatus({
          taskId: args.task_id as string,
          status: args.status as TaskStatus,
        })
        const verbose = args.verbose === true
        const summary = engine.summarize()
        return {
          goalId: mgr.getCurrentGoalId(),
          taskId: args.task_id,
          status: args.status,
          summary: verbose ? summary : slimSummary(summary),
        }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'amend_acceptance_criteria',
    description: 'Append new acceptance criteria after the initial lock. Existing criteria are not modified. Use when requirements expand during execution.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['criteria', 'reason'],
      properties: {
        criteria: {
          type: 'array',
          description: 'New criteria to append.',
          items: CRITERION_ITEM_SCHEMA,
        },
        reason: { type: 'string', description: 'Human-readable reason for the amendment.' },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const engine = mgr.getEngine()
        const criteria = args.criteria as CriterionInput[]
        const added = await engine.amendCriteria({
          criteria: criteria.map(mapCriterion),
          reason: args.reason as string,
        })
        const summary = engine.summarize()
        return { goalId: mgr.getCurrentGoalId(), addedCriteria: added, summary }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'can_complete_goal',
    description: [
      'Check whether the goal can be completed based on current acceptance criteria.',
      '',
      'BLOCKING CONDITIONS:',
      '- passed + selfClaimed=false: OK (formal pass)',
      '- passed + selfClaimed=true: BLOCKED (needs confirm_criterion by independent reviewer)',
      '- failed/blocked/pending/in_progress: BLOCKED',
      '- not_run (required only): BLOCKED',
      '',
      'Do NOT declare the task complete until this returns allowed=true. If allowed=false, read the reason field and address each blocking criterion.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async (_args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const result = mgr.getEngine().canComplete()
        return { goalId: mgr.getCurrentGoalId(), ...result }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'set_task_plan',
    description: 'Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          description: 'Ordered list of atomic tasks.',
          items: TASK_PLAN_ITEM_SCHEMA,
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const engine = mgr.getEngine()
        const tasks = args.tasks as TaskInput[]
        const plan = await engine.setTaskPlan(tasks.map(mapTask))
        const summary = engine.summarize()
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan, summary: slimSummary(summary) }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'get_task_plan',
    description: 'Read the current task decomposition plan with live task statuses.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async (_args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const plan = mgr.getEngine().getTaskPlan()
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'start_goal',
    description: 'Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Optional human-readable title for the goal.',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const title = args.title as string | undefined
        const meta = mgr.startGoal(title)
        return { goal: meta, message: 'New goal started and set as active.' }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'list_goals',
    description: 'List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async (_args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const goals = mgr.listGoals()
        return { goals }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'switch_goal',
    description: 'Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['goal_id'],
      properties: {
        goal_id: {
          type: 'string',
          description: 'The goal ID to switch to (from list_goals).',
        },
      },
    },
    handler: async (args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        const id = args.goal_id as string
        const meta = mgr.switchGoal(id)
        return { goal: meta, message: 'Switched active goal.' }
      } catch (e) {
        return fail(e)
      }
    },
  },
  {
    name: 'reset_goal',
    description: 'Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    handler: async (_args, ctx: ToolContext) => {
      const mgr = getManager(ctx.config as { pluginData?: string })
      try {
        mgr.resetGoal()
        return { message: 'Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal.' }
      } catch (e) {
        return fail(e)
      }
    },
  },
]
