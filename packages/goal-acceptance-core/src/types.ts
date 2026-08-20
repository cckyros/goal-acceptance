/**
 * Pure types for the generic goal-acceptance state machine.
 * @module @cckyros/goal-acceptance-core/types
 */

/** Status of an individual acceptance criterion. */
export type GoalCriterionStatus =
  | 'pending'
  | 'in_progress'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'not_run'

/** Status of a linked task tracked by the engine. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** One task in the decomposition plan. Tasks are first-class: each carries a concrete deliverable. */
export interface GoalTask {
  /** Stable unique task id. */
  readonly id: string
  /** Non-empty, unambiguous task description. */
  readonly description: string
  /** Non-empty deliverable: the artifact that proves this task is done. */
  readonly deliverable: string
  /** Task ids this task depends on. Must reference other tasks in the same plan. */
  readonly dependsOn: readonly string[]
  /** Current status. Defaults to 'pending'. */
  readonly status: TaskStatus
  /** Timestamp when the task was last updated. */
  readonly updatedAt?: number
}

/** Input item for declaring the task decomposition plan. */
export interface TaskPlanSpec {
  /** Unique task id (e.g. "t1", "api-endpoint"). */
  readonly id: string
  /** Non-empty, unambiguous task description. */
  readonly description: string
  /** Non-empty deliverable that proves the task is done. */
  readonly deliverable: string
  /** Task ids this task depends on within the same plan. */
  readonly dependsOn?: readonly string[]
}

/** Role that locked the criteria. Determines whether agent self-claims are trusted. */
export type GoalRole = 'agent' | 'reviewer' | 'dual'

/** Type of evidence attached to a validation. text is low-confidence. */
export type EvidenceType = 'command' | 'file' | 'url' | 'text'

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
  /** Task IDs linked to this criterion. The host pushes status updates for these IDs. */
  readonly taskIds: readonly string[]
  /** IDs of criteria that must be 'passed' before this criterion should be validated. Advisory: affects steering priority, not hard-enforced. */
  readonly dependsOn: readonly string[]
  /** True when this criterion was appended after the initial lock via amendCriteria. */
  readonly addedAfterLock?: boolean
  /** Timestamp when the criterion was appended via amendCriteria. */
  readonly addedAt?: number
  /** True when status=passed was set by an agent (role=agent). Needs reviewer confirmation. */
  readonly selfClaimed?: boolean
  /** Type of evidence attached. text = low confidence. */
  readonly evidenceType?: EvidenceType
  /** True when evidenceType=text (low confidence). Convenience flag for summary consumers. */
  readonly lowConfidence?: boolean
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
  /** Task IDs linked to this criterion. Opaque strings the host resolves to its task system. */
  readonly taskIds?: readonly string[]
  /** IDs of criteria that should be passed before this criterion is validated. */
  readonly dependsOn?: readonly string[]
}

/** Input for validating one criterion. */
export interface ValidateCriterionSpec {
  /** Criterion id to validate. */
  readonly criterionId: string
  /** Outcome status. */
  readonly status: GoalCriterionStatus
  /** Evidence supporting this status. Required when status is 'passed' or 'failed'. */
  readonly evidence?: string | undefined
  /** Type of evidence. Defaults to 'text' (low confidence). */
  readonly evidenceType?: EvidenceType
}

/** Input for reviewer confirmation of a self-claimed passed criterion. */
export interface ConfirmCriterionSpec {
  /** Criterion id to confirm. Must be passed and self-claimed. */
  readonly criterionId: string
  /** Independent re-verification evidence gathered by the reviewer. Required. */
  readonly evidence: string
  /** Type of evidence. Must be high-confidence: 'command', 'file', or 'url'. 'text' is rejected. */
  readonly evidenceType: EvidenceType
}

/** Input for updating a linked task's status. */
export interface TaskUpdateSpec {
  /** Task ID to update. */
  readonly taskId: string
  /** New task status. */
  readonly status: TaskStatus
}

/** Input for amending criteria after the initial lock. */
export interface AmendSpec {
  /** Criteria to append. Each must have a unique id not already present. */
  readonly criteria: readonly CriterionSpec[]
  /** Human-readable reason for the amendment (audit trail). */
  readonly reason: string
}

/** Per-criterion task progress computed by the engine. */
export interface CriterionTaskProgress {
  /** Criterion id this progress belongs to. */
  readonly criterionId: string
  /** Total linked tasks. */
  readonly totalTasks: number
  /** Completed tasks. */
  readonly completedTasks: number
  /** In-progress tasks. */
  readonly inProgressTasks: number
  /** Pending tasks. */
  readonly pendingTasks: number
  /** Failed tasks. */
  readonly failedTasks: number
  /** True when all linked tasks are 'completed'. Empty task list �?false. */
  readonly readyToValidate: boolean
}

/** Summary of current criteria evaluation across the Goal. */
export interface AcceptanceSummary {
  /** True when all required criteria are formally 'passed' (not self-claimed). */
  readonly allRequiredPassed: boolean
  /** Total count of criteria. */
  readonly totalCount: number
  /** Passed criteria count (includes self-claimed). */
  readonly passedCount: number
  /** Failed criteria count. */
  readonly failedCount: number
  /** Blocked criteria count. */
  readonly blockedCount: number
  /** Pending criteria count. */
  readonly pendingCount: number
  /** Not run criteria count. */
  readonly notRunCount: number
  /** Count of passed criteria that are self-claimed (agent, not reviewer-confirmed). */
  readonly selfClaimedCount: number
  /** List of passed criteria (includes self-claimed). */
  readonly passed: GoalCriterion[]
  /** List of formally passed criteria (selfClaimed=false or undefined). */
  readonly formalPassed: GoalCriterion[]
  /** List of self-claimed passed criteria (selfClaimed=true). */
  readonly selfClaimedPassed: GoalCriterion[]
  /** List of failed criteria. */
  readonly failures: GoalCriterion[]
  /** List of blocked criteria. */
  readonly blockers: GoalCriterion[]
  /** List of pending criteria. */
  readonly pending: GoalCriterion[]
  /** List of not run criteria. */
  readonly notRun: GoalCriterion[]
  /** Aggregate task progress across all linked tasks. */
  readonly taskProgress: {
    readonly totalTasks: number
    readonly completedTasks: number
    readonly inProgressTasks: number
    readonly pendingTasks: number
    readonly failedTasks: number
  }
  /** Per-criterion task progress, one entry per criterion that has linked tasks. */
  readonly criterionTaskProgress: readonly CriterionTaskProgress[]
  /** Task decomposition plan, in declaration order. Empty until a plan is set. */
  readonly taskPlan: readonly GoalTask[]
  /** Criteria whose linked tasks are all completed and that are not yet validated. Ordered by dependency. */
  readonly readyToValidate: readonly GoalCriterion[]
  /** Required criteria that are pending/in_progress and whose dependencies are satisfied. Ordered by dependency. */
  readonly nextActionable: readonly GoalCriterion[]
}

/** Error codes for goal-acceptance operations. */
export type GoalAcceptanceErrorCode =
  | 'GOAL_ACCEPTANCE_ALREADY_LOCKED'
  | 'GOAL_ACCEPTANCE_NOT_FOUND'
  | 'GOAL_ACCEPTANCE_INVALID_CRITERIA'
  | 'GOAL_ACCEPTANCE_CRITERION_NOT_FOUND'
  | 'GOAL_ACCEPTANCE_EVIDENCE_REQUIRED'
  | 'GOAL_ACCEPTANCE_CANNOT_COMPLETE'
  | 'GOAL_ACCEPTANCE_DUPLICATE_AMEND_ID'
  | 'GOAL_ACCEPTANCE_AMEND_REASON_REQUIRED'
  | 'GOAL_ACCEPTANCE_NOT_LOCKED'
  | 'GOAL_ACCEPTANCE_INVALID_TASK_PLAN'
  | 'GOAL_ACCEPTANCE_TASK_PLAN_ALREADY_SET'
  | 'GOAL_ACCEPTANCE_TASK_NOT_FOUND'
  | 'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL'
  | 'GOAL_ACCEPTANCE_NOT_SELF_CLAIMED'
  | 'GOAL_ACCEPTANCE_LOW_CONFIDENCE_EVIDENCE'

/** Event payload when initial criteria are locked. */
export interface GoalAcceptanceSetEvent {
  readonly type: 'goal-acceptance/set'
  readonly criteria: GoalCriterion[]
  readonly lockedAt: number
  /** Role that locked the criteria. Determines self-claim behavior. */
  readonly role?: GoalRole
}

/** Event payload when a criterion status is validated. */
export interface GoalAcceptanceValidateEvent {
  readonly type: 'goal-acceptance/validate'
  readonly criterionId: string
  readonly status: GoalCriterionStatus
  readonly evidence?: string | undefined
  readonly validatedAt: number
  /** Type of evidence. */
  readonly evidenceType?: EvidenceType
  /** True when an agent self-claimed passed (role=agent). */
  readonly selfClaimed?: boolean
}

/** Event payload when a linked task's status is updated. */
export interface GoalAcceptanceTaskUpdateEvent {
  readonly type: 'goal-acceptance/task-update'
  readonly taskId: string
  readonly taskStatus: TaskStatus
  readonly updatedAt: number
}

/** Event payload when criteria are appended after the initial lock. */
export interface GoalAcceptanceAmendEvent {
  readonly type: 'goal-acceptance/amend'
  readonly addedCriteria: GoalCriterion[]
  readonly reason: string
  readonly amendedAt: number
}

/** Event payload when the task decomposition plan is set. */
export interface GoalAcceptanceTaskPlanEvent {
  readonly type: 'goal-acceptance/task-plan'
  readonly tasks: GoalTask[]
  readonly plannedAt: number
}

/** Union of all goal-acceptance events. */
export type GoalAcceptanceEvent =
  | GoalAcceptanceSetEvent
  | GoalAcceptanceValidateEvent
  | GoalAcceptanceTaskUpdateEvent
  | GoalAcceptanceAmendEvent
  | GoalAcceptanceTaskPlanEvent
