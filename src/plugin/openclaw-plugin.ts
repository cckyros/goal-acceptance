/**
 * OpenClaw native plugin entry for goal-acceptance. Registers 15 tools that
 * directly call the shared GoalManager (no MCP stdio needed). Multi-goal:
 * each goal has its own event file under <dataDir>/goals/.
 *
 * The manager replaces the module-level caches the original openclaw package
 * kept (resolvedDataDir / currentGoalId / engineCache / metaCache) — one
 * GoalManager instance per process, dataDir resolved lazily from the first
 * pluginConfig (same stick-after-first-use semantics as the original).
 */
import { execSync } from 'node:child_process'
import type { OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core'
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin'
import { jsonResult, textResult, type AgentToolResult } from 'openclaw/plugin-sdk/tool-results'
import { Type } from 'typebox'
import { GoalAcceptanceError, type GoalCriterion, type GoalTask } from './engine/index.ts'
import { GoalManager } from './goal-manager.ts'
import { clearSessionGoal, syncSessionGoal } from './openclaw-session-sync.ts'

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
  artifacts: Type.Optional(Type.Array(Type.String(), { description: 'Workspace-relative file paths this verdict binds to. sha256 recorded at validation; later changes drift-block the gate.' })),
  verify_command: Type.Optional(Type.String({ description: 'The single shell command authorized to prove this criterion.' })),
})

const WorkspaceParam = Type.Optional(Type.String({ description: 'Absolute workspace path that criterion artifacts resolve against. Required when any criterion declares artifacts. Set-once per goal.' }))

const TaskPlanItem = Type.Object({
  id: Type.String({ description: 'Unique task id (e.g. "t1", "api-endpoint").' }),
  description: Type.String({ description: 'Non-empty, unambiguous task description.' }),
  deliverable: Type.String({ description: 'Concrete artifact that proves this task is done.' }),
  depends_on: Type.Optional(Type.Array(Type.String(), { description: 'Task ids this task depends on within the same plan.' })),
})

// --- Helpers (unchanged from the original package) ---

function wrapResult(result: unknown): AgentToolResult<unknown> {
  if (typeof result === 'string') {
    return textResult(result, result)
  }
  return jsonResult(result)
}

function slimSummary(s: { allRequiredPassed: boolean; passedCount: number; selfClaimedCount: number; totalCount: number }) {
  return {
    allRequiredPassed: s.allRequiredPassed,
    passedCount: s.passedCount,
    selfClaimedCount: s.selfClaimedCount,
    totalCount: s.totalCount,
  }
}

function mapCriterion(c: { id: string; description: string; required?: boolean; method?: string; task_ids?: string[]; depends_on?: string[]; artifacts?: string[]; verify_command?: string }) {
  return {
    id: c.id,
    description: c.description,
    ...c.required !== undefined ? { required: c.required } : {},
    ...c.method !== undefined ? { method: c.method } : {},
    ...c.task_ids !== undefined ? { taskIds: c.task_ids } : {},
    ...c.depends_on !== undefined ? { dependsOn: c.depends_on } : {},
    ...c.artifacts !== undefined ? { artifacts: c.artifacts } : {},
    ...c.verify_command !== undefined ? { verifyCommand: c.verify_command } : {},
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

// --- Tool factory wrapper ---
//
// `defineToolPlugin`'s `factory` form gives us the active OpenClaw session
// context (sessionKey + agentId). We use that to mirror the plugin's active
// acceptance goal into the canonical `SessionEntry.goal` slot, so OpenClaw's
// built-in `get_goal` and `update_goal` tools see a live goal snapshot.

type ToolFactoryContext = {
  api: OpenClawPluginApi
  config: { dataDir?: string }
  toolContext: OpenClawPluginToolContext
}

function makeTool(
  name: string,
  label: string,
  description: string,
  parameters: any,
  options: { mutates?: boolean; clears?: boolean },
  handler: (params: any, config: { dataDir?: string }) => Promise<unknown>,
) {
  return () => ({
    name,
    label,
    description,
    parameters,
    factory: ({ api, config, toolContext }: ToolFactoryContext) => ({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal, _onUpdate?: any) => {
        const result = await handler(params as any, config)
        if (toolContext.sessionKey && toolContext.agentId) {
          if (options.clears) {
            await clearSessionGoal({ api, toolContext })
          } else if (options.mutates) {
            await syncSessionGoal({ api, toolContext, manager: getManager(config) })
          }
        }
        return wrapResult(result)
      },
    }),
  })
}

// --- Plugin ---
// id stays 'goal-acceptance' (the brand) so OpenClaw upgrades replace the
// original plugin instead of installing a duplicate.

export default defineToolPlugin({
  id: 'goal-acceptance',
  name: 'Goal Acceptance',
  description: 'Acceptance-criteria-driven goal completion for autonomous agents.',

  tools: (tool) => [
    tool(makeTool(
      'set_acceptance_criteria',
      'Set Acceptance Criteria',
      'Set and lock the initial acceptance criteria for the current goal. Must be called before implementation. Optional role field controls self-claim behavior: agent marks passed as self-claimed (needs reviewer confirmation), reviewer/dual marks formal passed. Criteria are immutable once locked, so calling this again rotates to a NEW goal instead of failing; the response reports previousGoalId and previousGoalIncomplete=true when the goal you just left still had unfinished required criteria. To add criteria to the CURRENT goal use amend_acceptance_criteria; to return to a rotated-away goal use list_goals then switch_goal.',
      Type.Object({
        criteria: Type.Array(CriterionItem, { description: 'Array of criteria definitions.' }),
        role: Type.Optional(Type.Union([
          Type.Literal('agent'),
          Type.Literal('reviewer'),
          Type.Literal('dual'),
        ], { description: 'Role locking the criteria. agent (default): passed marks self-claimed, requiring confirm_criterion by an independent reviewer. reviewer/dual: formal passed immediately (use only when the user explicitly waives independent review).' })),
        workspace: WorkspaceParam,
      }),
      { mutates: true },
      async (params, config) => {
        let mgr = getManager(config)
        const role = params.role || 'agent'
        try {
          if (params.workspace !== undefined) mgr.setWorkspaceRoot(params.workspace)
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
            if (params.workspace !== undefined) mgr.setWorkspaceRoot(params.workspace)
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
    )()),

    tool(makeTool(
      'get_acceptance_criteria',
      'Get Acceptance Criteria',
      'Read the current acceptance criteria, task progress, and summary. Default returns full criteria list + summary. Pass verbose=false for a one-line summary only.',
      Type.Object({
        verbose: Type.Optional(Type.Boolean({ description: 'Default true: returns criteria + full summary. false: returns only slim summary.' })),
      }),
      { mutates: false },
      async (params, config) => {
        const eng = getManager(config).getEngine()
        const verbose = params.verbose !== false
        const summary = eng.summarize()
        if (!verbose) return { summary: slimSummary(summary) }
        const criteria = eng.getCriteria()
        const drift = eng.checkArtifactDrift()
        return { criteria, summary, ...drift.drifted.length > 0 ? { drift: drift.drifted } : {} }
      },
    )()),

    tool(makeTool(
      'validate_criterion',
      'Validate Criterion',
      'Record verification status and evidence for one criterion. Statuses passed and failed require evidence. Optional evidence_type: command/file/url/text (default text, flagged low-confidence). When role=agent, passed is marked self-claimed. Default response is slim; pass verbose=true for full summary.',
      Type.Object({
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
        command: Type.Optional(Type.String({ description: 'Executed shell command. Required for passed when the criterion pins verify_command; must equal it.' })),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: returns criterion + slim summary. true: returns criterion + full summary.' })),
      }),
      { mutates: true },
      async (params, config) => {
        const eng = getManager(config).getEngine()
        const updated = await eng.validateCriterion({
          criterionId: params.criterion_id,
          status: params.status,
          evidence: params.evidence,
          ...params.evidence_type !== undefined ? { evidenceType: params.evidence_type } : {},
          ...params.command !== undefined ? { command: params.command } : {},
        })
        const verbose = params.verbose === true
        const summary = eng.summarize()
        return verbose
          ? { criterion: updated, summary }
          : { criterion: updated, summary: slimSummary(summary) }
      },
    )()),

    tool(makeTool(
      'confirm_criterion',
      'Confirm Criterion',
      'Reviewer confirmation of a self-claimed passed criterion. MUST be called by an independent reviewer agent (e.g. a subagent that did not do the work), NOT by the agent that performed the task. The reviewer must independently re-verify the criterion (re-run tests, re-check files) and provide that fresh evidence here. Requires high-confidence evidence_type (command/file/url); text is rejected. Converts self-claimed to formal pass, unblocking can_complete_goal.',
      Type.Object({
        criterion_id: Type.String({ description: 'Criterion id to confirm. Must currently be passed and self-claimed.' }),
        evidence: Type.String({ description: 'Independent re-verification evidence gathered by the reviewer (not copied from the original validation).' }),
        evidence_type: Type.Union([
          Type.Literal('command'),
          Type.Literal('file'),
          Type.Literal('url'),
        ], { description: 'Type of evidence. Must be high-confidence; text is not accepted.' }),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const updated = await mgr.getEngine().confirmCriterion({
          criterionId: params.criterion_id,
          evidence: params.evidence,
          evidenceType: params.evidence_type,
        })
        const summary = mgr.getEngine().summarize()
        return { goalId: mgr.getCurrentGoalId(), criterion: updated, summary: slimSummary(summary) }
      },
    )()),

    tool(makeTool(
      'update_task_status',
      'Update Task Status',
      'Update the status of a task linked to one or more acceptance criteria. When all tasks linked to a criterion are completed, that criterion becomes ready to validate. Default response is slim; pass verbose=true for full summary.',
      Type.Object({
        task_id: Type.String({ description: 'The task ID to update.' }),
        status: Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
          Type.Literal('failed'),
        ], { description: 'New task status.' }),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: slim summary. true: full summary.' })),
      }),
      { mutates: true },
      async (params, config) => {
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
    )()),

    tool(makeTool(
      'claim_task',
      'Claim Task',
      'Task dispatch node for the orchestrated worker/reviewer loop. Claims a task for a worker: marks it in_progress and returns the task plus its linked acceptance criteria. Without task_id, claims the first pending task whose dependencies are all completed.',
      Type.Object({
        task_id: Type.Optional(Type.String({ description: 'Task id to claim. When omitted, the next dependency-ready task in plan order is claimed.' })),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const result = await mgr.getEngine().claimTask(params.task_id)
        return { goalId: mgr.getCurrentGoalId(), ...result }
      },
    )()),

    tool(makeTool(
      'review_task',
      'Review Task',
      'Task acceptance node for the orchestrated worker/reviewer loop. Records the independent reviewer\'s verdicts on the claimed task\'s linked criteria. Verdicts are formal (never self-claimed). All linked required criteria formally passed → task completes and the next dependency-ready task is returned; otherwise blockingCriteria is the rework feedback for the next round.',
      Type.Object({
        task_id: Type.String({ description: 'The in_progress task being reviewed.' }),
        verdicts: Type.Array(Type.Object({
          criterion_id: Type.String({ description: 'A criterion linked to this task.' }),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('passed'),
            Type.Literal('failed'),
            Type.Literal('blocked'),
            Type.Literal('not_run'),
          ], { description: 'Reviewed outcome.' }),
          evidence: Type.String({ description: 'Fresh verification evidence gathered by the reviewer.' }),
          evidence_type: Type.Optional(Type.Union([
            Type.Literal('command'),
            Type.Literal('file'),
            Type.Literal('url'),
            Type.Literal('text'),
          ], { description: 'Evidence type.' })),
          command: Type.Optional(Type.String({ description: 'Executed command; required for passed when the criterion pins verify_command.' })),
        }), { description: 'Reviewer verdicts, one per linked criterion being judged this round.' }),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const verdicts = params.verdicts.map((v: { criterion_id: string; status: 'pending' | 'in_progress' | 'passed' | 'failed' | 'blocked' | 'not_run'; evidence: string; evidence_type?: 'command' | 'file' | 'url' | 'text'; command?: string }) => ({
          criterionId: v.criterion_id,
          status: v.status,
          evidence: v.evidence,
          ...v.evidence_type !== undefined ? { evidenceType: v.evidence_type } : {},
          ...v.command !== undefined ? { command: v.command } : {},
        }))
        const result = await mgr.getEngine().reviewTask(params.task_id, verdicts)
        return { goalId: mgr.getCurrentGoalId(), ...result }
      },
    )()),

    tool(makeTool(
      'amend_acceptance_criteria',
      'Amend Acceptance Criteria',
      'Append new acceptance criteria after the initial lock. Existing criteria are not modified. Use when requirements expand during execution.',
      Type.Object({
        criteria: Type.Array(CriterionItem, { description: 'New criteria to append.' }),
        reason: Type.String({ description: 'Human-readable reason for the amendment.' }),
        workspace: WorkspaceParam,
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        if (params.workspace !== undefined) mgr.setWorkspaceRoot(params.workspace)
        const added = await mgr.getEngine().amendCriteria({
          criteria: params.criteria.map(mapCriterion),
          reason: params.reason,
        })
        const summary = mgr.getEngine().summarize()
        return { addedCriteria: added, summary }
      },
    )()),

    tool(makeTool(
      'update_criterion',
      'Update Criterion',
      'Patch an existing criterion after lock (fix a wrong verify_command, extend artifact bindings, correct description/method/required). Requires a reason for audit. Patching artifacts or verify_command on a PASSED criterion resets it to pending. verify_command: null clears the pin; artifacts: [] clears bindings.',
      Type.Object({
        criterion_id: Type.String({ description: 'Existing criterion id to patch.' }),
        reason: Type.String({ description: 'Reason for the patch (audit trail).' }),
        description: Type.Optional(Type.String()),
        required: Type.Optional(Type.Boolean()),
        method: Type.Optional(Type.Union([Type.Literal('command'), Type.Literal('file'), Type.Literal('url'), Type.Literal('manual')])),
        verify_command: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: 'New pinned command, or null to clear.' })),
        artifacts: Type.Optional(Type.Array(Type.String(), { description: 'New artifact list (replaces old). [] clears.' })),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const patch: Record<string, unknown> = {}
        if (params.description !== undefined) patch.description = params.description
        if (params.required !== undefined) patch.required = params.required
        if (params.method !== undefined) patch.method = params.method
        if (params.verify_command !== undefined) patch.verifyCommand = params.verify_command
        if (params.artifacts !== undefined) patch.artifacts = params.artifacts
        const updated = await mgr.getEngine().updateCriterion({
          criterionId: params.criterion_id,
          patch,
          reason: params.reason,
        })
        const summary = mgr.getEngine().summarize()
        return { goalId: mgr.getCurrentGoalId(), criterion: updated, summary: slimSummary(summary) }
      },
    )()),

    tool(makeTool(
      'can_complete_goal',
      'Can Complete Goal',
      'Check whether the goal can be completed based on current acceptance criteria.',
      Type.Object({}),
      { mutates: false },
      async (_params, config) => {
        const eng = getManager(config).getEngine()
        const drift = eng.checkArtifactDrift()
        return { ...eng.canComplete(), ...drift.drifted.length > 0 ? { drift: drift.drifted } : {} }
      },
    )()),

    tool(makeTool(
      'set_task_plan',
      'Set Task Plan',
      'Set and lock the task decomposition plan for the current goal. Each task must have a unique id, an unambiguous description, and a concrete deliverable. Task dependencies must reference other tasks in the same plan; dependency cycles are rejected. Requires acceptance criteria to be locked first.',
      Type.Object({
        tasks: Type.Array(TaskPlanItem, { description: 'Ordered list of atomic tasks.' }),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const plan = await mgr.getEngine().setTaskPlan(params.tasks.map(mapTask))
        const summary = mgr.getEngine().summarize()
        return { taskPlan: plan, summary: slimSummary(summary) }
      },
    )()),

    tool(makeTool(
      'get_task_plan',
      'Get Task Plan',
      'Read the current task decomposition plan with live task statuses.',
      Type.Object({}),
      { mutates: false },
      async (_params, config) => {
        const mgr = getManager(config)
        const plan = mgr.getEngine().getTaskPlan()
        return { goalId: mgr.getCurrentGoalId(), taskPlan: plan }
      },
    )()),

    tool(makeTool(
      'start_goal',
      'Start Goal',
      'Start a new goal with a fresh state. Use this when the current goal is locked and you need to begin a new independent task. Each goal has its own acceptance criteria and task plan. The new goal becomes the active goal.',
      Type.Object({
        title: Type.Optional(Type.String({ description: 'Optional human-readable title for the goal.' })),
        workspace: WorkspaceParam,
      }),
      { mutates: true },
      async (params, config) => {
        const meta = getManager(config).startGoal(params.title, undefined, params.workspace)
        return { goal: meta, message: 'New goal started and set as active.' }
      },
    )()),

    tool(makeTool(
      'create_goal',
      'Create Goal',
      'Create a new named goal and set it as active. Always starts a fresh goal; name and description are recorded in the goal metadata shown by list_goals.',
      Type.Object({
        name: Type.String({ description: 'Short goal name (stored as the goal title, shown by list_goals).' }),
        description: Type.Optional(Type.String({ description: 'Optional longer description of what the goal achieves.' })),
        workspace: WorkspaceParam,
      }),
      { mutates: true },
      async (params, config) => {
        const meta = getManager(config).startGoal(params.name, params.description, params.workspace)
        return { goalId: meta.id, goal: meta, message: 'New goal created and set as active.' }
      },
    )()),

    tool(makeTool(
      'list_goals',
      'List Goals',
      'List all goals with their status summaries. Shows goal ID, title, creation time, criteria counts, and which goal is currently active.',
      Type.Object({}),
      { mutates: false },
      async (_params, config) => {
        return { goals: getManager(config).listGoals() }
      },
    )()),

    tool(makeTool(
      'switch_goal',
      'Switch Goal',
      'Switch the active goal to an existing goal by ID. Use list_goals to find goal IDs.',
      Type.Object({
        goal_id: Type.String({ description: 'The goal ID to switch to (from list_goals).' }),
      }),
      { mutates: true },
      async (params, config) => {
        const meta = getManager(config).switchGoal(params.goal_id)
        return { goal: meta, message: 'Switched active goal.' }
      },
    )()),

    tool(makeTool(
      'run_and_validate',
      'Run And Validate',
      'Execute a shell command, capture its real stdout/stderr/exitCode, and validate the criterion in one call. Guarantees high-confidence command evidence.',
      Type.Object({
        criterion_id: Type.String({ description: 'Criterion ID to validate.' }),
        command: Type.Optional(Type.String({ description: 'Shell command to execute. Optional when the criterion pins a verify_command — then the pinned command runs.' })),
        cwd: Type.Optional(Type.String({ description: 'Optional working directory. Rejected when the criterion pins a verify_command.' })),
        timeout_ms: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds.' })),
        verbose: Type.Optional(Type.Boolean({ description: 'Default false: slim summary. true: full summary.' })),
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const eng = mgr.getEngine()
        const criterion = eng.getCriterion(params.criterion_id)
        if (criterion === undefined) {
          throw new GoalAcceptanceError(`criterion_id "${params.criterion_id}" not found`, 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND')
        }
        const pinned = criterion.verifyCommand
        const requested = typeof params.command === 'string' && params.command.trim().length > 0 ? params.command.trim() : undefined
        if (pinned !== undefined) {
          if ((requested !== undefined && requested !== pinned) || params.cwd !== undefined) {
            throw new GoalAcceptanceError(
              `criterion "${params.criterion_id}" pins verify_command "${pinned}" — run_and_validate must execute exactly that command in the goal workspace`,
              'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
            )
          }
        } else if (requested === undefined) {
          throw new GoalAcceptanceError('command is required when the criterion does not pin a verify_command', 'GOAL_ACCEPTANCE_INVALID_ARGS')
        }
        const command = pinned ?? requested!
        const cwd = pinned !== undefined ? eng.getWorkspaceRoot() : params.cwd
        let stdout = ''
        let stderr = ''
        let exitCode = 0
        try {
          stdout = execSync(command, {
            cwd,
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
          `$ ${command}`,
          stdout.trim() ? `[stdout]\n${stdout.trim()}` : '',
          stderr.trim() ? `[stderr]\n${stderr.trim()}` : '',
          `[exit code] ${exitCode}`,
        ].filter(Boolean).join('\n\n')

        const updated = await eng.validateCriterion({
          criterionId: params.criterion_id,
          status,
          evidence: rawEvidence,
          evidenceType: 'command',
          verifiedCommand: command,
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
    )()),

    tool(makeTool(
      'quick_start_goal',
      'Quick Start Goal',
      'Fast-path tool: Start/rotate a goal, lock criteria, and optionally set task plan all in ONE call.',
      Type.Object({
        title: Type.Optional(Type.String({ description: 'Optional short goal title.' })),
        role: Type.Optional(Type.Union([Type.Literal('agent'), Type.Literal('reviewer'), Type.Literal('dual')], { description: 'Role locking criteria.' })),
        criteria: Type.Array(CriterionItem, { description: 'Initial criteria to lock.' }),
        tasks: Type.Optional(Type.Array(TaskPlanItem, { description: 'Optional task plan.' })),
        workspace: WorkspaceParam,
      }),
      { mutates: true },
      async (params, config) => {
        const mgr = getManager(config)
        const role = params.role || 'agent'
        if (params.title !== undefined) mgr.startGoal(params.title, undefined, params.workspace)
        let engine = mgr.ensureGoal()
        if (params.workspace !== undefined) mgr.setWorkspaceRoot(params.workspace)
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
            mgr.startGoal(params.title, undefined, params.workspace)
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
    )()),

    tool(makeTool(
      'reset_goal',
      'Reset Goal',
      'Delete the current goal and all its data (criteria, task plan, validations). The goal is permanently removed. Use this to clear a messed-up goal and start fresh.',
      Type.Object({}),
      { clears: true },
      async (_params, config) => {
        getManager(config).resetGoal()
        return { message: 'Current goal deleted. No active goal. Call set_acceptance_criteria to auto-create a new one, or start_goal.' }
      },
    )()),
  ],
})
