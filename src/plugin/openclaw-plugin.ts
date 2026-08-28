/**
 * OpenClaw native plugin entry for goal-acceptance. Registers 13 tools that
 * directly call the shared GoalManager (no MCP stdio needed). Multi-goal:
 * each goal has its own event file under <dataDir>/goals/.
 *
 * The manager replaces the module-level caches the original openclaw package
 * kept (resolvedDataDir / currentGoalId / engineCache / metaCache) — one
 * GoalManager instance per process, dataDir resolved lazily from the first
 * pluginConfig (same stick-after-first-use semantics as the original).
 */
import { execSync } from 'node:child_process'
import { GoalAcceptanceError, type GoalCriterion, type GoalTask } from './engine/index.ts'
import { GoalManager } from './goal-manager.ts'
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'
import { Type } from 'typebox'

/** One manager per process, created on first tool call. */
let manager: GoalManager | null = null

function getManager(cfg: { dataDir?: string } | undefined): GoalManager {
  if (manager === null) {
    manager = new GoalManager(cfg?.dataDir || process.env.PLUGIN_DATA || '')
  }
  return manager
}

// --- Schemas (unchanged from the original package) ---

const CriterionItem = Type.Object({
  id: Type.String({ description: 'Short unique identifier (e.g. "api-health", "test-pass").' }),
  description: Type.String({ description: 'Concrete requirement description.' }),
  required: Type.Optional(Type.Boolean({ description: 'Whether required for goal completion. Defaults to true.' })),
  method: Type.Optional(Type.Union([
    Type.Literal('command'),
    Type.Literal('file'),
    Type.Literal('url'),
    Type.Literal('manual'),
  ], { description: 'Verification method: command, file, url, or manual.' })),
  task_ids: Type.Optional(Type.Array(Type.String(), { description: 'Task IDs linked to this criterion.' })),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: 'IDs of criteria that must be passed before this one.' })),
})

const TaskPlanItem = Type.Object({
  id: Type.String({ description: 'Unique task id (e.g. "t1", "api-endpoint").' }),
  description: Type.String({ description: 'Non-empty, unambiguous task description.' }),
  deliverable: Type.String({ description: 'Concrete artifact that proves this task is done.' }),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: 'Task ids this task depends on within the same plan.' })),
})

// --- Helpers (unchanged from the original package) ---

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
// id stays 'goal-acceptance' (the brand) so OpenClaw upgrades replace the
// original plugin instead of installing a duplicate.

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
      execute: async (params, config) => {
        let mgr = getManager(config)
        const role = params.role || 'agent'
        try {
          const list = await mgr.ensureGoal().setCriteria(params.criteria.map(mapCriterion), role)
          const summary = mgr.getEngine().summarize()
          return { goalId: mgr.getCurrentGoalId(), criteria: list, summary }
        } catch (e) {
          if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
            // Locked criteria are immutable, so an error here dead-ends the
            // caller on a goal it can no longer edit. Rotate to a fresh goal
            // instead — the abandoned goal keeps its events and stays
            // reachable through list_goals / switch_goal. When it was left
            // unfinished we surface the abandonment (upstream b883e95).
            const previousGoalId = mgr.getCurrentGoalId()
            const completion = mgr.getEngine().canComplete()
            const previousGoalSummary = slimSummary(mgr.getEngine().summarize())
            mgr.startGoal()
            const list = await mgr.getEngine().setCriteria(params.criteria.map(mapCriterion), role)
            return {
              goalId: mgr.getCurrentGoalId(),
              previousGoalId,
              autoStarted: true,
              previousGoalIncomplete: !completion.allowed,
              ...completion.allowed ? {} : { previousGoalReason: completion.reason, previousGoalSummary },
              criteria: list,
              summary: mgr.getEngine().summarize(),
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
      execute: async (params, config) => {
        const eng = getManager(config).getEngine()
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
      execute: async (params, config) => {
        const eng = getManager(config).getEngine()
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
      execute: async (params, config) => {
        const mgr = getManager(config)
        const updated = await mgr.getEngine().confirmCriterion({
          criterionId: params.criterion_id,
          evidence: params.evidence,
          evidenceType: params.evidence_type,
        })
        const summary = mgr.getEngine().summarize()
        return { goalId: mgr.getCurrentGoalId(), criterion: updated, summary: slimSummary(summary) }
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
      execute: async (params, config) => {
        const mgr = getManager(config)
        await mgr.getEngine().updateTaskStatus({
          taskId: params.task_id,
          status: params.status,
        })
        const verbose = params.verbose === true
        const summary = mgr.getEngine().summarize()
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
      execute: async (params, config) => {
        const mgr = getManager(config)
        const added = await mgr.getEngine().amendCriteria({
          criteria: params.criteria.map(mapCriterion),
          reason: params.reason,
        })
        const summary = mgr.getEngine().summarize()
        return { addedCriteria: added, summary }
      },
    }),

    tool({
      name: 'can_complete_goal',
      description: 'Check whether the goal can be completed based on current acceptance criteria.',
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        return getManager(config).getEngine().canComplete()
      },
    }),

    tool({
      name: 'set_task_plan',
      description: 'Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.',
      parameters: Type.Object({
        tasks: Type.Array(TaskPlanItem, { description: 'Ordered list of atomic tasks.' }),
      }),
      execute: async (params, config) => {
        const mgr = getManager(config)
        const plan = await mgr.getEngine().setTaskPlan(params.tasks.map(mapTask))
        const summary = mgr.getEngine().summarize()
        return { taskPlan: plan, summary: slimSummary(summary) }
      },
    }),

    tool({
      name: 'get_task_plan',
      description: 'Read the current task decomposition plan with live task statuses.',
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        const mgr = getManager(config)
        const plan = mgr.getEngine().getTaskPlan()
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan }
      },
    }),

    tool({
      name: 'start_goal',
      description: 'Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: 'Optional human-readable title for the goal.' })),
      }),
      execute: async (params, config) => {
        const meta = getManager(config).startGoal(params.title)
        return { goal: meta, message: 'New goal started and set as active.' }
      },
    }),

    tool({
      name: 'list_goals',
      description: 'List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.',
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        return { goals: getManager(config).listGoals() }
      },
    }),

    tool({
      name: 'switch_goal',
      description: 'Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.',
      parameters: Type.Object({
        goal_id: Type.String({ description: 'The goal ID to switch to (from list_goals).' }),
      }),
      execute: async (params, config) => {
        const meta = getManager(config).switchGoal(params.goal_id)
        return { goal: meta, message: 'Switched active goal.' }
      },
    }),

    tool({
      name: 'run_and_validate',
      description: 'Execute a shell command, capture its real stdout/stderr/exitCode, and validate the criterion in one call. Guarantees high-confidence command evidence.',
      parameters: Type.Object({
        criterion_id: Type.String({ description: 'Criterion ID to validate.' }),
        command: Type.String({ description: 'Shell command to execute.' }),
        cwd: Type.Optional(Type.String({ description: 'Optional working directory.' })),
        timeout_ms: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds.' })),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: slim summary. true: full summary.' })),
      }),
      execute: async (params, config) => {
        const mgr = getManager(config)
        const eng = mgr.getEngine()
        let stdout = ''
        let stderr = ''
        let exitCode = 0
        try {
          stdout = execSync(params.command, {
            cwd: params.cwd,
            timeout: params.timeout_ms || 60000,
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
        const status = exitCode === 0 ? 'passed' : 'failed'
        const rawEvidence = [
          `$ ${params.command}`,
          stdout.trim() ? `[stdout]\n${stdout.trim()}` : '',
          stderr.trim() ? `[stderr]\n${stderr.trim()}` : '',
          `[exit code] ${exitCode}`,
        ].filter(Boolean).join('\n\n')

        const updated = await eng.validateCriterion({
          criterionId: params.criterion_id,
          status,
          evidence: rawEvidence,
          evidenceType: 'command',
        })
        const verbose = params.verbose === true
        const summary = eng.summarize()
        return {
          goalId: mgr.getCurrentGoalId(),
          criterion: updated,
          commandOutput: { exitCode, stdout, stderr },
          summary: verbose ? summary : slimSummary(summary),
        }
      },
    }),
    tool({
      name: 'quick_start_goal',
      description: 'Fast-path tool: Start/rotate a goal, lock criteria, and optionally set task plan all in ONE call.',
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: 'Optional short goal title.' })),
        role: Type.Optional(Type.Union([Type.Literal('agent'), Type.Literal('reviewer'), Type.Literal('dual')], { description: 'Role locking criteria.' })),
        criteria: Type.Array(CriterionItem, { description: 'Initial criteria to lock.' }),
        tasks: Type.Optional(Type.Array(TaskPlanItem, { description: 'Optional task plan.' })),
      }),
      execute: async (params, config) => {
        const mgr = getManager(config)
        const role = params.role || 'agent'
        if (params.title !== undefined) mgr.startGoal(params.title)
        let engine = mgr.ensureGoal()
        let list: GoalCriterion[]
        let previousGoalId: string | undefined
        let previousGoalIncomplete = false
        let previousGoalReason: string | undefined
        let previousGoalSummary: ReturnType<typeof slimSummary> | undefined
        try {
          list = await engine.setCriteria(params.criteria.map(mapCriterion), role)
        } catch (e) {
          if (e instanceof GoalAcceptanceError && e.code === 'GOAL_ACCEPTANCE_ALREADY_LOCKED') {
            previousGoalId = mgr.getCurrentGoalId() ?? undefined
            const completion = engine.canComplete()
            previousGoalSummary = slimSummary(engine.summarize())
            previousGoalIncomplete = !completion.allowed
            previousGoalReason = completion.reason
            mgr.startGoal(params.title)
            engine = mgr.getEngine()
            list = await engine.setCriteria(params.criteria.map(mapCriterion), role)
          } else {
            throw e
          }
        }

        let taskPlanRes: GoalTask[] | undefined
        if (Array.isArray(params.tasks) && params.tasks.length > 0) {
          taskPlanRes = await engine.setTaskPlan(params.tasks.map(mapTask))
        }

        const summary = engine.summarize()
        return {
          goalId: mgr.getCurrentGoalId(),
          ...previousGoalId ? { previousGoalId, previousGoalIncomplete, previousGoalReason, previousGoalSummary, autoStarted: true } : {},
          criteria: list,
          taskPlan: taskPlanRes,
          summary: slimSummary(summary),
          message: 'Goal initialized and locked successfully.',
        }
      },
    }),
    tool({
      name: 'reset_goal',
      description: 'Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.',
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        getManager(config).resetGoal()
        return { message: 'Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal.' }
      },
    }),
  ],
})
