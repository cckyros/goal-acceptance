/**
 * Core state machine for goal acceptance criteria.
 * @module @cckyros/goal-acceptance-core/engine
 */

import { GoalAcceptanceError } from './errors.ts'
import { hashArtifacts, resolveArtifactPath } from './digest.ts'
import type { GoalAcceptanceStore } from './store.ts'
import type {
  AcceptanceSummary,
  AmendSpec,
  ArtifactDigestDelta,
  ArtifactDriftReport,
  DriftedCriterion,
  ClaimTaskResult,
  ConfirmCriterionSpec,
  CriterionSpec,
  CriterionTaskProgress,
  EvidenceType,
  GoalAcceptanceDriftEvent,
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceUpdateEvent,
  GoalAcceptanceValidateEvent,
  GoalAcceptanceTaskUpdateEvent,
  GoalAcceptanceAmendEvent,
  GoalAcceptanceTaskPlanEvent,
  GoalCriterion,
  GoalCriterionStatus,
  GoalRole,
  GoalTask,
  ReviewTaskResult,
  TaskPlanSpec,
  TaskStatus,
  TaskUpdateSpec,
  UpdateCriterionSpec,
  ValidateCriterionSpec,
} from './types.ts'

interface AcceptanceState {
  criteria: Map<string, GoalCriterion>
  order: string[]
  locked: boolean
  observedCount: number
  taskStatuses: Map<string, TaskStatus>
  role: GoalRole
  taskPlan: Map<string, GoalTask>
  taskPlanOrder: string[]
  taskPlanLocked: boolean
}

function initialState(): AcceptanceState {
  return {
    criteria: new Map(),
    order: [],
    locked: false,
    observedCount: 0,
    taskStatuses: new Map(),
    role: 'agent',
    taskPlan: new Map(),
    taskPlanOrder: [],
    taskPlanLocked: false,
  }
}

/** Normalize a CriterionSpec into a stored GoalCriterion. */
function toCriterion(spec: CriterionSpec, now: number, defaults: { addedAfterLock?: boolean; addedAt?: number }): GoalCriterion {
  const artifacts = Array.isArray(spec.artifacts) ? spec.artifacts.map(a => a.trim()).filter(a => a.length > 0) : []
  return {
    id: spec.id.trim(),
    description: spec.description.trim(),
    required: spec.required !== false,
    method: typeof spec.method === 'string' && spec.method.trim().length > 0 ? spec.method.trim() : 'manual',
    status: 'pending',
    updatedAt: now,
    taskIds: Array.isArray(spec.taskIds) ? spec.taskIds.map(t => t.trim()).filter(t => t.length > 0) : [],
    dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.map(d => d.trim()).filter(d => d.length > 0) : [],
    ...artifacts.length > 0 ? { artifacts } : {},
    ...typeof spec.verifyCommand === 'string' && spec.verifyCommand.trim().length > 0 ? { verifyCommand: spec.verifyCommand.trim() } : {},
    ...defaults.addedAfterLock === true ? { addedAfterLock: true, addedAt: defaults.addedAt ?? now } : {},
  }
}

/** Validate a list of CriterionSpecs for unique ids and non-empty fields. */
function validateSpecs(specs: readonly CriterionSpec[], existingIds: Set<string>): void {
  const seenIds = new Set<string>()
  for (const spec of specs) {
    if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
      throw new GoalAcceptanceError('each criterion must have a non-empty id', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }
    const id = spec.id.trim()
    if (seenIds.has(id)) {
      throw new GoalAcceptanceError(`duplicate criterion id "${id}"`, 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }
    if (existingIds.has(id)) {
      throw new GoalAcceptanceError(`criterion id "${id}" already exists`, 'GOAL_ACCEPTANCE_DUPLICATE_AMEND_ID')
    }
    seenIds.add(id)
    if (typeof spec.description !== 'string' || spec.description.trim().length === 0) {
      throw new GoalAcceptanceError(`criterion "${id}" must have a non-empty description`, 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }
  }
}

/** Validate a task plan for atomicity: unique ids, unambiguous descriptions, deliverables, valid deps, no cycles. */
function validateTaskPlan(specs: readonly TaskPlanSpec[]): void {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new GoalAcceptanceError('task plan must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
  }
  const ids = new Set<string>()
  const descriptions = new Set<string>()
  for (const spec of specs) {
    if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
      throw new GoalAcceptanceError('each task must have a non-empty id', 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
    const id = spec.id.trim()
    if (ids.has(id)) {
      throw new GoalAcceptanceError(`duplicate task id "${id}"`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
    ids.add(id)
    if (typeof spec.description !== 'string' || spec.description.trim().length === 0) {
      throw new GoalAcceptanceError(`task "${id}" must have a non-empty description`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
    const description = spec.description.trim()
    if (descriptions.has(description)) {
      throw new GoalAcceptanceError(`task "${id}" has an ambiguous description (duplicate of another task)`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
    descriptions.add(description)
    if (typeof spec.deliverable !== 'string' || spec.deliverable.trim().length === 0) {
      throw new GoalAcceptanceError(`task "${id}" must declare a deliverable`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
  }
  // Dependency references must exist within the plan
  for (const spec of specs) {
    const id = spec.id.trim()
    for (const dep of (spec.dependsOn ?? [])) {
      const depId = dep.trim()
      if (depId.length === 0) {
        throw new GoalAcceptanceError(`task "${id}" has an empty dependency id`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
      }
      if (depId === id) {
        throw new GoalAcceptanceError(`task "${id}" cannot depend on itself`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
      }
      if (!ids.has(depId)) {
        throw new GoalAcceptanceError(`task "${id}" depends on unknown task "${depId}"`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
      }
    }
  }
  // Cycle detection via DFS
  const deps = new Map<string, string[]>()
  for (const spec of specs) {
    deps.set(spec.id.trim(), (spec.dependsOn ?? []).map((d: string) => d.trim()))
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): string[] => {
    if (visiting.has(id)) {
      return [id]
    }
    if (visited.has(id)) {
      return []
    }
    visiting.add(id)
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep)
      if (cycle.length > 0) {
        return [id, ...cycle]
      }
    }
    visiting.delete(id)
    visited.add(id)
    return []
  }
  for (const id of ids) {
    const cycle = visit(id)
    if (cycle.length > 0) {
      throw new GoalAcceptanceError(`dependency cycle detected: ${cycle.join(' -> ')}`, 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
    }
  }
}

/** Byte-level delta between two digest snapshots. Returns undefined when nothing changed. */
function computeDigestDelta(
  prev: Record<string, string> | undefined,
  next: Record<string, string> | undefined,
): ArtifactDigestDelta | undefined {
  if (prev === undefined || next === undefined) return undefined
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const [key, digest] of Object.entries(next)) {
    if (!(key in prev)) added.push(key)
    else if (prev[key] !== digest) changed.push(key)
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) removed.push(key)
  }
  if (changed.length === 0 && added.length === 0 && removed.length === 0) return undefined
  return { changed, added, removed }
}

/** Check whether all dependencies of a criterion are 'passed'. */
function dependenciesMet(criterion: GoalCriterion, criteria: Map<string, GoalCriterion>): boolean {
  if (criterion.dependsOn.length === 0) return true
  return criterion.dependsOn.every(depId => {
    const dep = criteria.get(depId)
    return dep !== undefined && dep.status === 'passed'
  })
}

/** Compute per-criterion task progress from the task status map. */
function computeTaskProgress(criterion: GoalCriterion, taskStatuses: Map<string, TaskStatus>): CriterionTaskProgress {
  let completed = 0
  let inProgress = 0
  let pending = 0
  let failed = 0
  for (const taskId of criterion.taskIds) {
    const status = taskStatuses.get(taskId) ?? 'pending'
    switch (status) {
      case 'completed': completed += 1; break
      case 'in_progress': inProgress += 1; break
      case 'pending': pending += 1; break
      case 'failed': failed += 1; break
    }
  }
  const total = criterion.taskIds.length
  return {
    criterionId: criterion.id,
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    pendingTasks: pending,
    failedTasks: failed,
    readyToValidate: total > 0 && completed === total,
  }
}

/** Engine that manages immutable criteria, task progress, amendments, and their validation lifecycle. */
export class GoalAcceptanceEngine {
  private readonly state: AcceptanceState = initialState()
  private readonly store: GoalAcceptanceStore
  private workspaceRoot: string | undefined

  constructor(store: GoalAcceptanceStore, workspaceRoot?: string) {
    this.store = store
    this.workspaceRoot = workspaceRoot
  }

  /** Lazily bind the workspace root. Set-once: a different value is rejected (anchors must not silently rebase). */
  setWorkspaceRoot(root: string): void {
    if (this.workspaceRoot !== undefined && this.workspaceRoot !== root) {
      throw new GoalAcceptanceError(
        `workspace root is already set to "${this.workspaceRoot}" — cannot rebase to "${root}"`,
        'GOAL_ACCEPTANCE_INVALID_ARGS',
      )
    }
    this.workspaceRoot = root
  }

  getWorkspaceRoot(): string | undefined {
    return this.workspaceRoot
  }

  /** Fail fast when specs declare artifacts without a workspace root, or with escaping relative paths. */
  private assertArtifactsDeclarable(specs: readonly CriterionSpec[]): void {
    const declaring = specs.filter(s => Array.isArray(s.artifacts) && s.artifacts.some(a => a.trim().length > 0))
    if (declaring.length === 0) return
    if (this.workspaceRoot === undefined) {
      throw new GoalAcceptanceError(
        `criteria declare artifacts but no workspace root is set — pass workspace to create_goal/set_acceptance_criteria first`,
        'GOAL_ACCEPTANCE_WORKSPACE_REQUIRED',
      )
    }
    for (const spec of declaring) {
      for (const p of spec.artifacts ?? []) {
        try {
          resolveArtifactPath(this.workspaceRoot, p)
        } catch {
          throw new GoalAcceptanceError(
            `criterion "${spec.id}" artifact path "${p}" escapes workspace root`,
            'GOAL_ACCEPTANCE_INVALID_CRITERIA',
          )
        }
      }
    }
  }

  /** Set and lock the acceptance criteria. Returns the resolved criteria list. */
  async setCriteria(specs: readonly CriterionSpec[], role: GoalRole = 'agent'): Promise<GoalCriterion[]> {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new GoalAcceptanceError('criteria list must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }

    this.sync()
    if (this.state.locked) {
      throw new GoalAcceptanceError('acceptance criteria are already locked', 'GOAL_ACCEPTANCE_ALREADY_LOCKED')
    }

    validateSpecs(specs, new Set())
    this.assertArtifactsDeclarable(specs)

    const now = Date.now()
    const criteria = specs.map(spec => toCriterion(spec, now, {}))

    const event: GoalAcceptanceSetEvent = {
      type: 'goal-acceptance/set',
      criteria,
      lockedAt: now,
      role,
    }

    await this.store.append(event)
    this.applyEvent(event)

    return this.getCriteria()
  }

  /** Append new criteria after the initial lock. Existing criteria are not modified. */
  async amendCriteria(spec: AmendSpec): Promise<GoalCriterion[]> {
    this.sync()

    if (!this.state.locked) {
      throw new GoalAcceptanceError('cannot amend before criteria are locked', 'GOAL_ACCEPTANCE_NOT_LOCKED')
    }

    if (typeof spec.reason !== 'string' || spec.reason.trim().length === 0) {
      throw new GoalAcceptanceError('amend reason is required', 'GOAL_ACCEPTANCE_AMEND_REASON_REQUIRED')
    }

    if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) {
      throw new GoalAcceptanceError('amend criteria list must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }

    const existingIds = new Set(this.state.order)
    validateSpecs(spec.criteria, existingIds)
    this.assertArtifactsDeclarable(spec.criteria)

    const now = Date.now()
    const addedCriteria = spec.criteria.map(s => toCriterion(s, now, { addedAfterLock: true, addedAt: now }))

    const event: GoalAcceptanceAmendEvent = {
      type: 'goal-acceptance/amend',
      addedCriteria,
      reason: spec.reason.trim(),
      amendedAt: now,
    }

    await this.store.append(event)
    this.applyEvent(event)

    return addedCriteria
  }

  /**
   * Patch an existing criterion's declaration (e.g. correct a bad verify_command pin
   * or extend the artifact bindings). Requires a reason for audit. Patching
   * artifacts or verifyCommand on a passed criterion resets it to pending —
   * integrity-bearing changes force re-validation rather than silently re-baselining.
   */
  async updateCriterion(spec: UpdateCriterionSpec): Promise<GoalCriterion> {
    this.sync()

    if (!this.state.locked) {
      throw new GoalAcceptanceError('cannot update criteria before they are locked', 'GOAL_ACCEPTANCE_NOT_LOCKED')
    }
    const existing = this.state.criteria.get(spec.criterionId)
    if (existing === undefined) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND')
    }
    if (typeof spec.reason !== 'string' || spec.reason.trim().length === 0) {
      throw new GoalAcceptanceError('update reason is required', 'GOAL_ACCEPTANCE_UPDATE_REASON_REQUIRED')
    }
    const patch = spec.patch
    if (patch === undefined || Object.values(patch).every(v => v === undefined)) {
      throw new GoalAcceptanceError('update patch must contain at least one field', 'GOAL_ACCEPTANCE_INVALID_ARGS')
    }
    if (patch.description !== undefined && patch.description.trim().length === 0) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" must have a non-empty description`, 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }
    if (patch.artifacts !== undefined) {
      this.assertArtifactsDeclarable([{ id: existing.id, description: existing.description, artifacts: patch.artifacts }])
    }

    const integrityChange = patch.artifacts !== undefined || patch.verifyCommand !== undefined
    const resetToPending = integrityChange && existing.status === 'passed'

    const now = Date.now()
    const event: GoalAcceptanceUpdateEvent = {
      type: 'goal-acceptance/update',
      criterionId: spec.criterionId,
      patch,
      reason: spec.reason.trim(),
      updatedAt: now,
      ...resetToPending ? { resetToPending: true } : {},
    }

    await this.store.append(event)
    this.applyEvent(event)

    const updated = this.state.criteria.get(spec.criterionId)
    /* v8 ignore next */
    if (updated === undefined) throw new Error('sync failed')
    return updated
  }

  /** Record verification status and evidence for one criterion. */
  async validateCriterion(spec: ValidateCriterionSpec): Promise<GoalCriterion> {
    this.sync()

    const existing = this.state.criteria.get(spec.criterionId)
    if (existing === undefined) {
      const available = Array.from(this.state.criteria.keys())
      const hint = available.length > 0
        ? `Available criterion IDs: [${available.map(id => `"${id}"`).join(', ')}]. Call get_acceptance_criteria to inspect full list.`
        : 'No criteria have been set for this goal yet. Call set_acceptance_criteria or quick_start_goal first.'
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND', hint)
    }

    const requiresEvidence = spec.status === 'passed' || spec.status === 'failed'
    if (requiresEvidence && (typeof spec.evidence !== 'string' || spec.evidence.trim().length === 0)) {
      throw new GoalAcceptanceError(
        `evidence is required when setting criterion to "${spec.status}"`,
        'GOAL_ACCEPTANCE_EVIDENCE_REQUIRED',
        'Provide command output, test run logs, or file verification content via evidence parameter, or use run_and_validate tool.',
      )
    }

    const evidenceType: EvidenceType = spec.evidenceType ?? 'text'
    const selfClaimed = spec.status === 'passed' && this.state.role === 'agent' && spec.byReviewer !== true

    // Pinned verify_command is enforced across ALL validation paths, not just
    // run_and_validate: a 'passed' verdict must declare the executed command and
    // it must equal the pin. Non-passed verdicts may omit it but cannot lie.
    const declaredCommand = spec.verifiedCommand ?? spec.command
    if (existing.verifyCommand !== undefined) {
      if (declaredCommand === undefined && spec.status === 'passed') {
        throw new GoalAcceptanceError(
          `criterion "${spec.criterionId}" pins verify_command — a passed verdict must declare the executed command via the "command" parameter`,
          'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
        )
      }
      if (declaredCommand !== undefined && declaredCommand !== existing.verifyCommand) {
        throw new GoalAcceptanceError(
          `pinned verify_command is "${existing.verifyCommand}" but declared command is "${declaredCommand}"`,
          'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH',
        )
      }
    }

    let artifactDigests: Record<string, string> | undefined
    if (existing.artifacts !== undefined && existing.artifacts.length > 0) {
      if (this.workspaceRoot === undefined) {
        throw new GoalAcceptanceError(
          `criterion "${spec.criterionId}" declares artifacts but no workspace root is set`,
          'GOAL_ACCEPTANCE_WORKSPACE_REQUIRED',
        )
      }
      const { digests, problems } = hashArtifacts(this.workspaceRoot, existing.artifacts)
      if (spec.status === 'passed' && problems.length > 0) {
        throw new GoalAcceptanceError(
          `cannot pass criterion "${spec.criterionId}": ${problems.map(p => `artifact "${p.path}" is ${p.kind}`).join('; ')}`,
          'GOAL_ACCEPTANCE_ARTIFACT_MISSING',
        )
      }
      artifactDigests = digests
    }
    const digestDelta = computeDigestDelta(existing.artifactDigests, artifactDigests)

    const now = Date.now()
    const event: GoalAcceptanceValidateEvent = {
      type: 'goal-acceptance/validate',
      criterionId: spec.criterionId,
      status: spec.status,
      evidence: spec.evidence !== undefined && spec.evidence.trim().length > 0 ? spec.evidence.trim() : undefined,
      validatedAt: now,
      evidenceType,
      ...selfClaimed ? { selfClaimed: true } : {},
      ...artifactDigests !== undefined && Object.keys(artifactDigests).length > 0 ? { artifactDigests } : {},
      ...digestDelta !== undefined ? { digestDelta } : {},
      ...typeof declaredCommand === 'string' && declaredCommand.length > 0 ? { verifiedCommand: declaredCommand } : {},
    }

    await this.store.append(event)
    this.applyEvent(event)

    const updated = this.state.criteria.get(spec.criterionId)
    /* v8 ignore next */
    if (updated === undefined) throw new Error('sync failed')
    return updated
  }

  /**
   * Reviewer confirmation of a self-claimed passed criterion.
   * Converts selfClaimed=true to a formal pass. Requires independent
   * high-confidence evidence (command/file/url); 'text' evidence is rejected.
   */
  async confirmCriterion(spec: ConfirmCriterionSpec): Promise<GoalCriterion> {
    this.sync()

    const existing = this.state.criteria.get(spec.criterionId)
    if (existing === undefined) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND')
    }
    if (existing.status !== 'passed' || existing.selfClaimed !== true) {
      throw new GoalAcceptanceError(
        `criterion "${spec.criterionId}" is not a self-claimed pass (status: ${existing.status}, selfClaimed: ${existing.selfClaimed === true}). Only self-claimed passed criteria can be confirmed.`,
        'GOAL_ACCEPTANCE_NOT_SELF_CLAIMED',
      )
    }
    if (typeof spec.evidence !== 'string' || spec.evidence.trim().length === 0) {
      throw new GoalAcceptanceError('independent re-verification evidence is required to confirm a criterion', 'GOAL_ACCEPTANCE_EVIDENCE_REQUIRED')
    }
    if (spec.evidenceType === 'text') {
      throw new GoalAcceptanceError(
        'confirmation requires high-confidence evidence (command, file, or url); text evidence is not accepted',
        'GOAL_ACCEPTANCE_LOW_CONFIDENCE_EVIDENCE',
      )
    }

    const now = Date.now()
    const event: GoalAcceptanceValidateEvent = {
      type: 'goal-acceptance/validate',
      criterionId: spec.criterionId,
      status: 'passed',
      evidence: spec.evidence.trim(),
      validatedAt: now,
      evidenceType: spec.evidenceType,
    }

    await this.store.append(event)
    this.applyEvent(event)

    const updated = this.state.criteria.get(spec.criterionId)
    /* v8 ignore next */
    if (updated === undefined) throw new Error('sync failed')
    return updated
  }

  /** Update the status of a linked task. The host calls this when its task system changes. */
  async updateTaskStatus(spec: TaskUpdateSpec): Promise<void> {
    this.sync()

    const now = Date.now()
    const event: GoalAcceptanceTaskUpdateEvent = {
      type: 'goal-acceptance/task-update',
      taskId: spec.taskId,
      taskStatus: spec.status,
      updatedAt: now,
      ...spec.claimKind !== undefined ? { claimKind: spec.claimKind } : {},
    }

    await this.store.append(event)
    this.applyEvent(event)
  }

  /** Set and lock the task decomposition plan. Requires criteria to be locked first. */
  async setTaskPlan(specs: readonly TaskPlanSpec[]): Promise<GoalTask[]> {
    this.sync()

    if (!this.state.locked) {
      throw new GoalAcceptanceError('cannot set a task plan before criteria are locked', 'GOAL_ACCEPTANCE_NOT_LOCKED')
    }
    if (this.state.taskPlanLocked) {
      throw new GoalAcceptanceError('task plan is already set', 'GOAL_ACCEPTANCE_TASK_PLAN_ALREADY_SET')
    }

    validateTaskPlan(specs)

    const now = Date.now()
    const tasks: GoalTask[] = specs.map(spec => ({
      id: spec.id.trim(),
      description: spec.description.trim(),
      deliverable: spec.deliverable.trim(),
      dependsOn: (spec.dependsOn ?? []).map(d => d.trim()).filter(d => d.length > 0),
      status: 'pending',
      updatedAt: now,
    }))

    const event: GoalAcceptanceTaskPlanEvent = {
      type: 'goal-acceptance/task-plan',
      tasks,
      plannedAt: now,
    }

    await this.store.append(event)
    this.applyEvent(event)

    return this.getTaskPlan()
  }

  /** Get the task decomposition plan in declaration order. Empty array if no plan set. */
  getTaskPlan(): GoalTask[] {
    this.sync()
    return this.state.taskPlanOrder.map(id => ({
      ...this.state.taskPlan.get(id)!,
      status: this.state.taskStatuses.get(id) ?? this.state.taskPlan.get(id)!.status,
    }))
  }

  /** Pending tasks whose dependencies are all completed, in declaration order. */
  private readyTasks(): GoalTask[] {
    return this.getTaskPlan().filter(
      t =>
        t.status === 'pending' &&
        t.dependsOn.every(dep => (this.state.taskStatuses.get(dep) ?? 'pending') === 'completed'),
    )
  }

  /** Criteria linked to a task via criterion.taskIds — its acceptance contract. */
  private linkedCriteria(taskId: string): GoalCriterion[] {
    return this.getCriteria().filter(c => c.taskIds.includes(taskId))
  }

  /**
   * Task dispatch node: claim a task for a worker. Marks the task in_progress
   * and returns it with its linked criteria (the work + acceptance contract).
   * Without taskId, claims the first dependency-ready task in plan order.
   */
  async claimTask(taskId?: string): Promise<ClaimTaskResult> {
    const run = async (): Promise<ClaimTaskResult> => {
      this.sync()
      if (this.state.taskPlan.size === 0) {
        throw new GoalAcceptanceError('no task plan set — call set_task_plan first', 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN')
      }

      const drift = this.checkArtifactDrift()
      const driftedCriterionIds = new Set(drift.drifted.filter(d => d.criterion.required).map(d => d.criterion.id))
      const isReworkTarget = (t: GoalTask): boolean =>
        t.status === 'completed' &&
        this.linkedCriteria(t.id).some(c => c.required && driftedCriterionIds.has(c.id))

      let task: GoalTask | undefined
      let claimKind: 'work' | 'rework' = 'work'
      if (taskId !== undefined) {
        task = this.getTaskPlan().find(t => t.id === taskId)
        if (task === undefined) {
          throw new GoalAcceptanceError(`task "${taskId}" not found`, 'GOAL_ACCEPTANCE_TASK_NOT_FOUND')
        }
        if (isReworkTarget(task)) {
          claimKind = 'rework'
        } else if (task.status !== 'pending') {
          throw new GoalAcceptanceError(
            `task "${taskId}" is not claimable (status: ${task.status})`,
            'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE',
          )
        } else {
          const unmet = task.dependsOn.filter(
            dep => (this.state.taskStatuses.get(dep) ?? 'pending') !== 'completed',
          )
          if (unmet.length > 0) {
            throw new GoalAcceptanceError(
              `task "${taskId}" has unmet dependencies: [${unmet.join(', ')}]`,
              'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE',
            )
          }
        }
      } else {
        // Rework claims take priority over the ready frontier: a drifted
        // previously-verified artifact is a regression and blocks the goal gate.
        task = this.getTaskPlan().find(isReworkTarget)
        if (task !== undefined) {
          claimKind = 'rework'
        } else {
          task = this.readyTasks()[0]
        }
        if (task === undefined) {
          const plan = this.getTaskPlan()
          const pending = plan.filter(t => t.status === 'pending')
          const reason =
            pending.length === 0
              ? 'no pending tasks — all tasks are claimed or done'
              : `no claimable tasks — ${pending.length} pending task(s) are blocked by unmet dependencies: [${pending.map(t => t.id).join(', ')}]`
          return { task: null, criteria: [], reason }
        }
      }

      if (claimKind === 'rework') {
        // Persist the drift evidence that triggered this rework claim — the
        // event log must show WHY a completed task reopened, not just that it did.
        const driftEvent: GoalAcceptanceDriftEvent = {
          type: 'goal-acceptance/drift',
          drifted: drift.drifted.map(d => ({
            criterionId: d.criterion.id,
            reasons: d.reasons,
          })),
          detectedAt: Date.now(),
        }
        await this.store.append(driftEvent)
        this.applyEvent(driftEvent)
      }
      await this.updateTaskStatus({ taskId: task.id, status: 'in_progress', claimKind })
      const claimed = this.getTaskPlan().find(t => t.id === task!.id)!
      return { task: claimed, criteria: this.linkedCriteria(task.id), claimKind }
    }
    return this.store.withLock !== undefined ? this.store.withLock(run) : run()
  }

  /**
   * Task acceptance node: reviewer verdicts on the task's linked criteria.
   * Verdicts are formal (never self-claimed) — the reviewer is the single
   * authority. All linked required criteria formally passed → task completes
   * and dependent tasks unlock. Otherwise the task stays in_progress and the
   * blocking criteria are returned as rework feedback for the next round.
   */
  async reviewTask(taskId: string, verdicts: readonly ValidateCriterionSpec[]): Promise<ReviewTaskResult> {
    const run = async (): Promise<ReviewTaskResult> => {
      this.sync()
      if (!Array.isArray(verdicts) || verdicts.length === 0) {
        throw new GoalAcceptanceError('verdicts must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_ARGS')
      }
      const task = this.getTaskPlan().find(t => t.id === taskId)
      if (task === undefined) {
        throw new GoalAcceptanceError(`task "${taskId}" not found`, 'GOAL_ACCEPTANCE_TASK_NOT_FOUND')
      }
      if (task.status !== 'in_progress') {
        throw new GoalAcceptanceError(
          `task "${taskId}" is not in_progress (status: ${task.status}) — claim it first`,
          'GOAL_ACCEPTANCE_TASK_NOT_IN_PROGRESS',
        )
      }
      const linked = this.linkedCriteria(taskId)
      if (linked.length === 0) {
        throw new GoalAcceptanceError(
          `task "${taskId}" has no linked criteria — nothing to review against`,
          'GOAL_ACCEPTANCE_TASK_NO_LINKED_CRITERIA',
        )
      }
      const linkedIds = new Set(linked.map(c => c.id))
      for (const v of verdicts) {
        if (!linkedIds.has(v.criterionId)) {
          throw new GoalAcceptanceError(
            `criterion "${v.criterionId}" is not linked to task "${taskId}". Linked: [${linked.map(c => c.id).join(', ')}]`,
            'GOAL_ACCEPTANCE_CRITERION_NOT_IN_TASK',
          )
        }
      }
      for (const v of verdicts) {
        await this.validateCriterion({ ...v, byReviewer: true })
      }

      const blocking = this.linkedCriteria(taskId).filter(
        c => c.required && !(c.status === 'passed' && c.selfClaimed !== true),
      )
      if (blocking.length > 0) {
        return {
          taskCompleted: false,
          task: this.getTaskPlan().find(t => t.id === taskId)!,
          blockingCriteria: blocking,
        }
      }

      await this.updateTaskStatus({ taskId, status: 'completed' })
      const next = this.readyTasks()[0]
      return {
        taskCompleted: true,
        task: this.getTaskPlan().find(t => t.id === taskId)!,
        blockingCriteria: [],
        nextTask: next ?? null,
        nextTaskCriteria: next ? this.linkedCriteria(next.id) : [],
      }
    }
    return this.store.withLock !== undefined ? this.store.withLock(run) : run()
  }

  /** Get all criteria in declaration order. */
  getCriteria(): GoalCriterion[] {
    this.sync()
    return this.state.order.map(id => this.state.criteria.get(id)!)
  }

  /** Get a single criterion by id. */
  getCriterion(id: string): GoalCriterion | undefined {
    this.sync()
    return this.state.criteria.get(id)
  }

  /** Compute aggregate summary of criteria validation with task progress and actionable ordering. */
  summarize(): AcceptanceSummary {
    const list = this.getCriteria()
    const passed: GoalCriterion[] = []
    const formalPassed: GoalCriterion[] = []
    const selfClaimedPassed: GoalCriterion[] = []
    const failures: GoalCriterion[] = []
    const blockers: GoalCriterion[] = []
    const pending: GoalCriterion[] = []
    const notRun: GoalCriterion[] = []

    let allRequiredPassed = true

    for (const c of list) {
      switch (c.status) {
        case 'passed':
          passed.push(c)
          if (c.selfClaimed === true) {
            selfClaimedPassed.push(c)
            if (c.required) allRequiredPassed = false
          } else {
            formalPassed.push(c)
          }
          break
        case 'failed':
          failures.push(c)
          if (c.required) allRequiredPassed = false
          break
        case 'blocked':
          blockers.push(c)
          if (c.required) allRequiredPassed = false
          break
        case 'in_progress':
        case 'pending':
          pending.push(c)
          if (c.required) allRequiredPassed = false
          break
        case 'not_run':
          notRun.push(c)
          if (c.required) allRequiredPassed = false
          break
      }
    }

    // Per-criterion task progress
    const criterionTaskProgress: CriterionTaskProgress[] = []
    let totalTasks = 0
    let completedTasks = 0
    let inProgressTasks = 0
    let pendingTasks = 0
    let failedTasks = 0

    // Aggregate over task plan when present, otherwise over criteria-linked tasks
    const planTasks = this.state.taskPlanOrder.map(id => this.state.taskPlan.get(id)!)
    if (planTasks.length > 0) {
      for (const task of planTasks) {
        const status = this.state.taskStatuses.get(task.id) ?? 'pending'
        switch (status) {
          case 'completed': completedTasks += 1; break
          case 'in_progress': inProgressTasks += 1; break
          case 'pending': pendingTasks += 1; break
          case 'failed': failedTasks += 1; break
        }
      }
      totalTasks = planTasks.length
    } else {
      for (const c of list) {
        if (c.taskIds.length > 0) {
          const progress = computeTaskProgress(c, this.state.taskStatuses)
          criterionTaskProgress.push(progress)
          totalTasks += progress.totalTasks
          completedTasks += progress.completedTasks
          inProgressTasks += progress.inProgressTasks
          pendingTasks += progress.pendingTasks
          failedTasks += progress.failedTasks
        }
      }
    }

    // readyToValidate: tasks all completed, criterion not yet validated
    const readyToValidate = list
      .filter(c => c.taskIds.length > 0 && (c.status === 'pending' || c.status === 'in_progress'))
      .filter(c => computeTaskProgress(c, this.state.taskStatuses).readyToValidate)
      .filter(c => dependenciesMet(c, this.state.criteria))
      .sort((a, b) => topologicalCompare(a, b, this.state.criteria))

    // nextActionable: required, pending/in_progress, dependencies satisfied
    const nextActionable = list
      .filter(c => c.required && (c.status === 'pending' || c.status === 'in_progress'))
      .filter(c => dependenciesMet(c, this.state.criteria))
      .sort((a, b) => topologicalCompare(a, b, this.state.criteria))

    return {
      allRequiredPassed: list.length > 0 ? allRequiredPassed : true,
      totalCount: list.length,
      passedCount: passed.length,
      failedCount: failures.length,
      blockedCount: blockers.length,
      pendingCount: pending.length,
      notRunCount: notRun.length,
      selfClaimedCount: selfClaimedPassed.length,
      passed,
      formalPassed,
      selfClaimedPassed,
      failures,
      blockers,
      pending,
      notRun,
      taskProgress: {
        totalTasks,
        completedTasks,
        inProgressTasks,
        pendingTasks,
        failedTasks,
      },
      criterionTaskProgress,
      readyToValidate,
      nextActionable,
      taskPlan: planTasks.map(task => ({
        ...task,
        status: this.state.taskStatuses.get(task.id) ?? task.status,
      })),
    }
  }

  /** Check whether this Goal is allowed to conclude with 'complete'. */
  /**
   * Re-hash artifacts for every passed criterion that recorded digests.
   * Drift is a gate-time computed view — stored state is never mutated.
   */
  checkArtifactDrift(): ArtifactDriftReport {
    this.sync()
    const drifted: DriftedCriterion[] = []
    const intact: GoalCriterion[] = []
    if (this.workspaceRoot === undefined) {
      return { drifted, intact }
    }
    for (const criterion of this.state.criteria.values()) {
      if (criterion.status !== 'passed' || criterion.artifactDigests === undefined) continue
      const reasons: { path: string; kind: 'changed' | 'missing' | 'unreadable' }[] = []
      const { digests, problems } = hashArtifacts(this.workspaceRoot, criterion.artifacts ?? [])
      for (const problem of problems) {
        reasons.push({ path: problem.path, kind: problem.kind })
      }
      for (const [key, recorded] of Object.entries(criterion.artifactDigests)) {
        const current = digests[key]
        if (current !== undefined && current !== recorded) {
          reasons.push({ path: key, kind: 'changed' })
        }
      }
      if (reasons.length > 0) {
        drifted.push({ criterion, reasons })
      } else {
        intact.push(criterion)
      }
    }
    return { drifted, intact }
  }

  canComplete(): { allowed: boolean; reason?: string } {
    this.sync()
    if (!this.state.locked || this.state.criteria.size === 0) {
      return { allowed: true }
    }
    const drift = this.checkArtifactDrift()
    const requiredDrifted = drift.drifted.filter(d => d.criterion.required)
    if (requiredDrifted.length > 0) {
      const details = requiredDrifted
        .map(d => {
          const paths = d.reasons.map(r => `${r.path}(${r.kind})`).join(', ')
          const reworkTask = this.getTaskPlan().find(t => t.status !== 'failed' && d.criterion.taskIds.includes(t.id))
          const hint = reworkTask !== undefined ? ` → claim task "${reworkTask.id}" for rework` : ' → re-validate this criterion'
          return `"${d.criterion.id}" artifacts drifted [${paths}]${hint}`
        })
        .join('; ')
      return { allowed: false, reason: `Cannot complete goal: ${requiredDrifted.length} required criterion drifted — ${details}` }
    }
    const summary = this.summarize()
    if (summary.allRequiredPassed) {
      return { allowed: true }
    }
    const selfClaimedRequired = summary.selfClaimedPassed.filter(c => c.required).length
    const unresolvedCount = summary.failedCount + summary.blockedCount + summary.pendingCount + summary.notRunCount
    if (selfClaimedRequired > 0 && unresolvedCount === 0) {
      return {
        allowed: false,
        reason: `Cannot complete goal: ${selfClaimedRequired} required criterion are self-claimed by agent, awaiting reviewer confirmation`,
      }
    }
    return {
      allowed: false,
      reason: `Cannot complete goal: ${unresolvedCount} required acceptance criteria are not passed`,
    }
  }

  private sync(): void {
    const events = this.store.events.slice(this.state.observedCount)
    for (const event of events) {
      this.applyEvent(event)
      this.state.observedCount += 1
    }
  }

  private applyEvent(event: GoalAcceptanceEvent): void {
    if (event.type === 'goal-acceptance/set') {
      const data = event as GoalAcceptanceSetEvent
      this.state.criteria.clear()
      this.state.order = []
      for (const criterion of data.criteria) {
        this.state.criteria.set(criterion.id, criterion)
        this.state.order.push(criterion.id)
      }
      this.state.locked = true
      this.state.role = data.role ?? 'agent'
    } else if (event.type === 'goal-acceptance/validate') {
      const data = event as GoalAcceptanceValidateEvent
      const existing = this.state.criteria.get(data.criterionId)
      if (existing !== undefined) {
        const evidenceType = data.evidenceType ?? 'text'
        this.state.criteria.set(data.criterionId, {
          ...existing,
          status: data.status,
          ...data.evidence !== undefined ? { evidence: data.evidence } : {},
          updatedAt: data.validatedAt,
          evidenceType,
          lowConfidence: evidenceType === 'text',
          ...data.selfClaimed === true ? { selfClaimed: true } : {},
          ...data.selfClaimed !== true ? { selfClaimed: false } : {},
          ...data.artifactDigests !== undefined ? { artifactDigests: data.artifactDigests } : {},
          ...data.digestDelta !== undefined ? { digestDelta: data.digestDelta } : {},
        })
      }
    } else if (event.type === 'goal-acceptance/update') {
      const data = event as GoalAcceptanceUpdateEvent
      const existing = this.state.criteria.get(data.criterionId)
      if (existing !== undefined) {
        const patch = data.patch
        const artifacts = patch.artifacts === undefined
          ? existing.artifacts
          : patch.artifacts.map(a => a.trim()).filter(a => a.length > 0)
        const verifyCommand = patch.verifyCommand === undefined
          ? existing.verifyCommand
          : patch.verifyCommand === null || patch.verifyCommand.trim().length === 0
            ? undefined
            : patch.verifyCommand.trim()
        this.state.criteria.set(data.criterionId, {
          ...existing,
          ...patch.description !== undefined ? { description: patch.description.trim() } : {},
          ...patch.required !== undefined ? { required: patch.required } : {},
          ...patch.method !== undefined && patch.method.trim().length > 0 ? { method: patch.method.trim() } : {},
          ...artifacts !== undefined ? { artifacts: artifacts.length > 0 ? artifacts : undefined } : {},
          ...verifyCommand !== undefined || patch.verifyCommand !== undefined ? { verifyCommand } : {},
          ...data.resetToPending === true
            ? { status: 'pending' as GoalCriterionStatus, selfClaimed: false, artifactDigests: undefined, digestDelta: undefined }
            : {},
          updatedAt: data.updatedAt,
        })
      }
    } else if (event.type === 'goal-acceptance/drift') {
      // Audit-only event: drift itself is computed at gate time, not stored.
    } else if (event.type === 'goal-acceptance/task-update') {
      const data = event as GoalAcceptanceTaskUpdateEvent
      this.state.taskStatuses.set(data.taskId, data.taskStatus)
    } else if (event.type === 'goal-acceptance/amend') {
      const data = event as GoalAcceptanceAmendEvent
      for (const criterion of data.addedCriteria) {
        // Idempotent: skip if already present (sync may replay this event)
        if (!this.state.criteria.has(criterion.id)) {
          this.state.criteria.set(criterion.id, criterion)
          this.state.order.push(criterion.id)
        }
      }
    } else if (event.type === 'goal-acceptance/task-plan') {
      const data = event as GoalAcceptanceTaskPlanEvent
      this.state.taskPlan.clear()
      this.state.taskPlanOrder = []
      for (const task of data.tasks) {
        this.state.taskPlan.set(task.id, task)
        this.state.taskPlanOrder.push(task.id)
      }
      this.state.taskPlanLocked = true
      // Seed task statuses for plan tasks so progress starts at 'pending'
      for (const task of data.tasks) {
        if (!this.state.taskStatuses.has(task.id)) {
          this.state.taskStatuses.set(task.id, 'pending')
        }
      }
    }
  }
}

/** Compare two criteria for topological ordering: a comes first if b depends on a. */
function topologicalCompare(a: GoalCriterion, b: GoalCriterion, criteria: Map<string, GoalCriterion>): number {
  // If b depends on a (directly or transitively), a should come first
  if (dependsOnTransitive(b, a.id, criteria, new Set())) return -1
  // If a depends on b (directly or transitively), b should come first
  if (dependsOnTransitive(a, b.id, criteria, new Set())) return 1
  // No dependency relationship: stable by declaration order
  return 0
}

/** Check if criterion depends on targetId directly or transitively. */
function dependsOnTransitive(criterion: GoalCriterion, targetId: string, criteria: Map<string, GoalCriterion>, visited: Set<string>): boolean {
  if (criterion.dependsOn.includes(targetId)) return true
  for (const depId of criterion.dependsOn) {
    if (visited.has(depId)) continue
    visited.add(depId)
    const dep = criteria.get(depId)
    if (dep !== undefined && dependsOnTransitive(dep, targetId, criteria, visited)) return true
  }
  return false
}
