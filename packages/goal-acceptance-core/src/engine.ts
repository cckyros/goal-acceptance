/**
 * Core state machine for goal acceptance criteria.
 * @module @cckyros/goal-acceptance-core/engine
 */

import { GoalAcceptanceError } from './errors.ts'
import type { GoalAcceptanceStore } from './store.ts'
import type {
  AcceptanceSummary,
  AmendSpec,
  CriterionSpec,
  CriterionTaskProgress,
  EvidenceType,
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceValidateEvent,
  GoalAcceptanceTaskUpdateEvent,
  GoalAcceptanceAmendEvent,
  GoalAcceptanceTaskPlanEvent,
  GoalCriterion,
  GoalRole,
  GoalTask,
  TaskPlanSpec,
  TaskStatus,
  TaskUpdateSpec,
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
    role: 'dual',
    taskPlan: new Map(),
    taskPlanOrder: [],
    taskPlanLocked: false,
  }
}

/** Normalize a CriterionSpec into a stored GoalCriterion. */
function toCriterion(spec: CriterionSpec, now: number, defaults: { addedAfterLock?: boolean; addedAt?: number }): GoalCriterion {
  return {
    id: spec.id.trim(),
    description: spec.description.trim(),
    required: spec.required !== false,
    method: typeof spec.method === 'string' && spec.method.trim().length > 0 ? spec.method.trim() : 'manual',
    status: 'pending',
    updatedAt: now,
    taskIds: Array.isArray(spec.taskIds) ? spec.taskIds.map(t => t.trim()).filter(t => t.length > 0) : [],
    dependsOn: Array.isArray(spec.dependsOn) ? spec.dependsOn.map(d => d.trim()).filter(d => d.length > 0) : [],
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

  constructor(private readonly store: GoalAcceptanceStore) {}

  /** Set and lock the acceptance criteria. Returns the resolved criteria list. */
  async setCriteria(specs: readonly CriterionSpec[], role: GoalRole = 'dual'): Promise<GoalCriterion[]> {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new GoalAcceptanceError('criteria list must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }

    this.sync()
    if (this.state.locked) {
      throw new GoalAcceptanceError('acceptance criteria are already locked', 'GOAL_ACCEPTANCE_ALREADY_LOCKED')
    }

    validateSpecs(specs, new Set())

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

  /** Record verification status and evidence for one criterion. */
  async validateCriterion(spec: ValidateCriterionSpec): Promise<GoalCriterion> {
    this.sync()

    const existing = this.state.criteria.get(spec.criterionId)
    if (existing === undefined) {
      throw new GoalAcceptanceError(`criterion "${spec.criterionId}" not found`, 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND')
    }

    const requiresEvidence = spec.status === 'passed' || spec.status === 'failed'
    if (requiresEvidence && (typeof spec.evidence !== 'string' || spec.evidence.trim().length === 0)) {
      throw new GoalAcceptanceError(`evidence is required when setting criterion to "${spec.status}"`, 'GOAL_ACCEPTANCE_EVIDENCE_REQUIRED')
    }

    const evidenceType: EvidenceType = spec.evidenceType ?? 'text'
    const selfClaimed = spec.status === 'passed' && this.state.role === 'agent'

    const now = Date.now()
    const event: GoalAcceptanceValidateEvent = {
      type: 'goal-acceptance/validate',
      criterionId: spec.criterionId,
      status: spec.status,
      evidence: spec.evidence !== undefined && spec.evidence.trim().length > 0 ? spec.evidence.trim() : undefined,
      validatedAt: now,
      evidenceType,
      ...selfClaimed ? { selfClaimed: true } : {},
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
  canComplete(): { allowed: boolean; reason?: string } {
    this.sync()
    if (!this.state.locked || this.state.criteria.size === 0) {
      return { allowed: true }
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
      this.state.role = data.role ?? 'dual'
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
        })
      }
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
