/**
 * Service implementation for managing and validating goal acceptance criteria.
 * @module @deepseek-ai/dsh-goal-acceptance/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  GoalAcceptanceEngine,
  type AcceptanceSummary,
  type AmendSpec,
  type CriterionSpec,
  type GoalCriterion,
  type TaskUpdateSpec,
  type ValidateCriterionSpec,
} from '@deepseek-ai/dsh-goal-acceptance-core'
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

  constructor(ctx: Context) {
    super(ctx, 'goalAcceptance')
  }

  private getEngine(agent: Agent): GoalAcceptanceEngine {
    let engine = this.engines.get(agent)
    if (engine === undefined) {
      engine = new GoalAcceptanceEngine(new SessionAcceptanceStore(agent.session))
      this.engines.set(agent, engine)
    }
    return engine
  }

  /**
   * Set and lock the acceptance criteria for the agent's current Goal.
   */
  setCriteria(agent: Agent, specs: readonly CriterionSpec[]): Promise<GoalCriterion[]> {
    return this.getEngine(agent).setCriteria(specs)
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
