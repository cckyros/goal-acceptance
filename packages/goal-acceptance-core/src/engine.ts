/**
 * Core state machine for goal acceptance criteria.
 * @module @deepseek-ai/dsh-goal-acceptance-core/engine
 */

import { GoalAcceptanceError } from './errors.ts'
import type { GoalAcceptanceStore } from './store.ts'
import type {
  AcceptanceSummary,
  CriterionSpec,
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceValidateEvent,
  GoalCriterion,
  ValidateCriterionSpec,
} from './types.ts'

interface AcceptanceState {
  criteria: Map<string, GoalCriterion>
  order: string[]
  locked: boolean
  observedCount: number
}

function initialState(): AcceptanceState {
  return {
    criteria: new Map(),
    order: [],
    locked: false,
    observedCount: 0,
  }
}

/** Engine that manages immutable criteria and their validation lifecycle. */
export class GoalAcceptanceEngine {
  private readonly state: AcceptanceState = initialState()

  constructor(private readonly store: GoalAcceptanceStore) {}

  /** Set and lock the acceptance criteria. Returns the resolved criteria list. */
  async setCriteria(specs: readonly CriterionSpec[]): Promise<GoalCriterion[]> {
    if (!Array.isArray(specs) || specs.length === 0) {
      throw new GoalAcceptanceError('criteria list must be a non-empty array', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
    }

    if (this.state.locked) {
      throw new GoalAcceptanceError('acceptance criteria are already locked', 'GOAL_ACCEPTANCE_ALREADY_LOCKED')
    }

    this.sync()
    if (this.state.locked) {
      throw new GoalAcceptanceError('acceptance criteria are already locked', 'GOAL_ACCEPTANCE_ALREADY_LOCKED')
    }

    const now = Date.now()
    const seenIds = new Set<string>()
    const criteria: GoalCriterion[] = []

    for (const spec of specs) {
      if (typeof spec.id !== 'string' || spec.id.trim().length === 0) {
        throw new GoalAcceptanceError('each criterion must have a non-empty id', 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
      }
      const id = spec.id.trim()
      if (seenIds.has(id)) {
        throw new GoalAcceptanceError(`duplicate criterion id "${id}"`, 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
      }
      seenIds.add(id)

      if (typeof spec.description !== 'string' || spec.description.trim().length === 0) {
        throw new GoalAcceptanceError(`criterion "${id}" must have a non-empty description`, 'GOAL_ACCEPTANCE_INVALID_CRITERIA')
      }

      criteria.push({
        id,
        description: spec.description.trim(),
        required: spec.required !== false,
        method: typeof spec.method === 'string' && spec.method.trim().length > 0 ? spec.method.trim() : 'manual',
        status: 'pending',
        updatedAt: now,
      })
    }

    const event: GoalAcceptanceSetEvent = {
      type: 'goal-acceptance/set',
      criteria,
      lockedAt: now,
    }

    await this.store.append(event)
    this.applyEvent(event)

    return this.getCriteria()
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

    const now = Date.now()
    const event: GoalAcceptanceValidateEvent = {
      type: 'goal-acceptance/validate',
      criterionId: spec.criterionId,
      status: spec.status,
      evidence: spec.evidence !== undefined && spec.evidence.trim().length > 0 ? spec.evidence.trim() : undefined,
      validatedAt: now,
    }

    await this.store.append(event)
    this.applyEvent(event)

    const updated = this.state.criteria.get(spec.criterionId)
    /* v8 ignore next */
    if (updated === undefined) throw new Error('sync failed')
    return updated
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

  /** Compute aggregate summary of criteria validation. */
  summarize(): AcceptanceSummary {
    const list = this.getCriteria()
    const passed: GoalCriterion[] = []
    const failures: GoalCriterion[] = []
    const blockers: GoalCriterion[] = []
    const pending: GoalCriterion[] = []
    const notRun: GoalCriterion[] = []

    let allRequiredPassed = true

    for (const c of list) {
      switch (c.status) {
        case 'passed':
          passed.push(c)
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

    return {
      allRequiredPassed: list.length > 0 ? allRequiredPassed : true,
      totalCount: list.length,
      passedCount: passed.length,
      failedCount: failures.length,
      blockedCount: blockers.length,
      pendingCount: pending.length,
      notRunCount: notRun.length,
      passed,
      failures,
      blockers,
      pending,
      notRun,
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
    const unresolvedCount = summary.failedCount + summary.blockedCount + summary.pendingCount + summary.notRunCount
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
    } else if (event.type === 'goal-acceptance/validate') {
      const data = event as GoalAcceptanceValidateEvent
      const existing = this.state.criteria.get(data.criterionId)
      if (existing !== undefined) {
        this.state.criteria.set(data.criterionId, {
          ...existing,
          status: data.status,
          ...data.evidence !== undefined ? { evidence: data.evidence } : {},
          updatedAt: data.validatedAt,
        })
      }
    }
  }
}
