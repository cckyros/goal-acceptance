/**
 * Pure types for the generic goal-acceptance state machine.
 * @module @deepseek-ai/dsh-goal-acceptance-core/types
 */

/** Status of an individual acceptance criterion. */
export type GoalCriterionStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_run'

/** One acceptance criterion attached to an autonomous Goal. */
export interface GoalCriterion {
  /** Stable unique identifier within the Goal. */
  readonly id: string
  /** Concrete requirement description. */
  readonly description: string
  /** Whether passing this criterion is required for Goal completion. Defaults to true. */
  readonly required: boolean
  /** Verification method (e.g. "test", "command", "browser", "manual"). */
  readonly method: string
  /** Current verification status. */
  readonly status: GoalCriterionStatus
  /** Verification evidence (command output, test result, inspection detail). */
  readonly evidence?: string
  /** Timestamp when the criterion was last updated. */
  readonly updatedAt?: number
}

/** Input item for creating/setting acceptance criteria. */
export interface CriterionSpec {
  /** Unique id (e.g. "auth-1", "test-pass"). */
  readonly id: string
  /** Non-empty requirement description. */
  readonly description: string
  /** Whether required for completion. Defaults to true. */
  readonly required?: boolean
  /** Verification method. Defaults to "manual". */
  readonly method?: string
}

/** Input for validating one criterion. */
export interface ValidateCriterionSpec {
  /** Criterion id to validate. */
  readonly criterionId: string
  /** Outcome status. */
  readonly status: GoalCriterionStatus
  /** Evidence supporting this status. Required when status is 'passed' or 'failed'. */
  readonly evidence?: string | undefined
}

/** Summary of current criteria evaluation across the Goal. */
export interface AcceptanceSummary {
  /** True when all required criteria are 'passed'. */
  readonly allRequiredPassed: boolean
  /** Total count of criteria. */
  readonly totalCount: number
  /** Passed criteria count. */
  readonly passedCount: number
  /** Failed criteria count. */
  readonly failedCount: number
  /** Blocked criteria count. */
  readonly blockedCount: number
  /** Pending criteria count. */
  readonly pendingCount: number
  /** Not run criteria count. */
  readonly notRunCount: number
  /** List of passed criteria. */
  readonly passed: GoalCriterion[]
  /** List of failed criteria. */
  readonly failures: GoalCriterion[]
  /** List of blocked criteria. */
  readonly blockers: GoalCriterion[]
  /** List of pending criteria. */
  readonly pending: GoalCriterion[]
  /** List of not run criteria. */
  readonly notRun: GoalCriterion[]
}

/** Error codes for goal-acceptance operations. */
export type GoalAcceptanceErrorCode =
  | 'GOAL_ACCEPTANCE_ALREADY_LOCKED'
  | 'GOAL_ACCEPTANCE_NOT_FOUND'
  | 'GOAL_ACCEPTANCE_INVALID_CRITERIA'
  | 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND'
  | 'GOAL_ACCEPTANCE_EVIDENCE_REQUIRED'
  | 'GOAL_ACCEPTANCE_CANNOT_COMPLETE'

/** Event payload when initial criteria are locked. */
export interface GoalAcceptanceSetEvent {
  readonly type: 'goal-acceptance/set'
  readonly criteria: GoalCriterion[]
  readonly lockedAt: number
}

/** Event payload when a criterion status is validated. */
export interface GoalAcceptanceValidateEvent {
  readonly type: 'goal-acceptance/validate'
  readonly criterionId: string
  readonly status: GoalCriterionStatus
  readonly evidence?: string | undefined
  readonly validatedAt: number
}

/** Union of all goal-acceptance events. */
export type GoalAcceptanceEvent = GoalAcceptanceSetEvent | GoalAcceptanceValidateEvent
