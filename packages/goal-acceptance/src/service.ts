/**
 * Service implementation for managing and validating goal acceptance criteria.
 * @module @cckyros/goal-acceptance/service
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GoalAcceptanceEngine,
  InMemoryAcceptanceStore,
  type AcceptanceSummary,
  type AmendSpec,
  type ConfirmCriterionSpec,
  type CriterionSpec,
  type GoalCriterion,
  type GoalRole,
  type GoalTask,
  type TaskPlanSpec,
  type TaskUpdateSpec,
  type ValidateCriterionSpec,
} from '@cckyros/goal-acceptance-core'
import { SessionAcceptanceStore } from './store.ts'
import { GoalAcceptanceError } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    goalAcceptance: GoalAcceptanceService
  }
}

/**
 * GoalAcceptanceService manages immutable criteria for Goal sessions.
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

  /**
   * Set and lock the acceptance criteria for the agent's current Goal.
   */
  setCriteria(agent: Agent, specs: readonly CriterionSpec[], role: GoalRole = 'agent'): Promise<GoalCriterion[]> {
    return this.getEngine(agent).setCriteria(specs, role)
  }

  /**
   * Append new criteria after the initial lock.
   */
  amendCriteria(agent: Agent, spec: AmendSpec): Promise<GoalCriterion[]> {
    return this.getEngine(agent).amendCriteria(spec)
  }

  /**
   * Record verification status and evidence for one criterion.
   */
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

  /**
   * Update the status of a linked task.
   */
  updateTaskStatus(agent: Agent, spec: TaskUpdateSpec): Promise<void> {
    return this.getEngine(agent).updateTaskStatus(spec)
  }

  /**
   * Get all criteria for the given agent in declaration order.
   */
  getCriteria(agent: Agent): GoalCriterion[] {
    return this.getEngine(agent).getCriteria()
  }

  /**
   * Get a single criterion by id.
   */
  getCriterion(agent: Agent, id: string): GoalCriterion | undefined {
    return this.getEngine(agent).getCriterion(id)
  }

  /**
   * Compute aggregate summary of criteria validation.
   */
  summarize(agent: Agent): AcceptanceSummary {
    return this.getEngine(agent).summarize()
  }

  /**
   * Check whether this Goal is allowed to conclude with 'complete'.
   */
  canComplete(agent: Agent): { allowed: boolean; reason?: string } {
    return this.getEngine(agent).canComplete()
  }
}

export { GoalAcceptanceError }
