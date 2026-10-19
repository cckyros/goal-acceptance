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
  /** Workspace-relative (or absolute) file paths whose bytes this criterion's verdict binds to.
   *  sha256 recorded at validation time; drift detection rechecks at gate time. */
  readonly artifacts?: readonly string[]
  /** The single shell command authorized to prove this criterion. Pinned at lock time. */
  readonly verifyCommand?: string
  /** sha256 (hex) of each declared artifact at the latest validation, keyed by normalized workspace-relative path. */
  readonly artifactDigests?: Record<string, string>
  /** Digest delta recorded by the latest re-validation, when the previous digests existed. */
  readonly digestDelta?: ArtifactDigestDelta
}

/** Byte-level change between two artifact digest snapshots. */
export interface ArtifactDigestDelta {
  /** Artifacts whose sha256 changed between validations. */
  readonly changed: readonly string[]
  /** Artifacts present in the new snapshot but not the old. */
  readonly added: readonly string[]
  /** Artifacts present in the old snapshot but not the new. */
  readonly removed: readonly string[]
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
  /** Workspace-relative (or absolute) file paths whose bytes this criterion's verdict binds to. */
  readonly artifacts?: readonly string[]
  /** The single shell command authorized to prove this criterion. Pinned at lock time. */
  readonly verifyCommand?: string
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
  /** True when the verdict comes from a designated reviewer (e.g. a review
   * subagent in the orchestrated task loop). The verdict is formal — never
   * self-claimed — regardless of the goal's locking role. */
  readonly byReviewer?: boolean
  /** The command actually executed to produce this verdict (set by run_and_validate). Recorded on the event for audit. */
  readonly verifiedCommand?: string
  /** The command the caller declares it executed for this verdict. When the criterion pins
   *  verifyCommand, a 'passed' verdict REQUIRES this to equal the pin. */
  readonly command?: string
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
  /** 'rework' when this update is a rework claim on a drifted completed task. Audit-only. */
  readonly claimKind?: 'work' | 'rework'
}

/** Mutable declaration fields of an existing criterion (integrity-bearing). */
export interface CriterionPatch {
  readonly description?: string
  readonly required?: boolean
  readonly method?: string
  readonly artifacts?: readonly string[]
  readonly verifyCommand?: string | null
}

/** Input for patching an existing criterion after lock. */
export interface UpdateCriterionSpec {
  /** Criterion id to patch. */
  readonly criterionId: string
  /** Fields to update. verifyCommand: null clears the pin. artifacts: [] clears bindings. */
  readonly patch: CriterionPatch
  /** Human-readable reason for the patch (audit trail). Required. */
  readonly reason: string
}

/** Input for amending criteria after the initial lock. */
export interface AmendSpec {
  /** Criteria to append. Each must have a unique id not already present. */
  readonly criteria: readonly CriterionSpec[]
  /** Human-readable reason for the amendment (audit trail). */
  readonly reason: string
}

/** Result of claiming a task for a worker (task dispatch node). */
export interface ClaimTaskResult {
  /** The claimed task (marked in_progress), or null when nothing is claimable. */
  readonly task: GoalTask | null
  /** Criteria linked to the claimed task — the task-granularity acceptance contract. */
  readonly criteria: readonly GoalCriterion[]
  /** 'rework' when claiming a completed task whose linked criteria drifted; 'work' for ready-frontier claims. */
  readonly claimKind?: 'work' | 'rework'
  /** Why no task was claimable, when task is null. */
  readonly reason?: string
}

/** Result of a task review round (task acceptance node). */
export interface ReviewTaskResult {
  /** True when all linked required criteria are formally passed and the task completed. */
  readonly taskCompleted: boolean
  /** The reviewed task with its post-review status. */
  readonly task: GoalTask
  /** Linked required criteria still blocking completion — rework feedback for the worker. */
  readonly blockingCriteria: readonly GoalCriterion[]
  /** Next claimable task after completion (dependencies unlocked), if any. */
  readonly nextTask?: GoalTask | null
  /** Criteria linked to nextTask — the next work contract. */
  readonly nextTaskCriteria?: readonly GoalCriterion[]
}

/** A passed criterion whose current artifact bytes no longer match the validated digests. */
export interface DriftedCriterion {
  readonly criterion: GoalCriterion
  /** Which artifact paths drifted. */
  readonly reasons: readonly { readonly path: string; readonly kind: 'changed' | 'missing' | 'unreadable' }[]
}

/** Gate-time drift report over all passed criteria that recorded artifact digests. */
export interface ArtifactDriftReport {
  /** Criteria whose current artifact bytes differ from validated digests. */
  readonly drifted: readonly DriftedCriterion[]
  /** Criteria checked and consistent. */
  readonly intact: readonly GoalCriterion[]
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
  | 'GOAL_ACCEPTANCE_INVALID_ARGS'
  | 'GOAL_ACCEPTANCE_TASK_NOT_CLAIMABLE'
  | 'GOAL_ACCEPTANCE_TASK_NOT_IN_PROGRESS'
  | 'GOAL_ACCEPTANCE_TASK_NO_LINKED_CRITERIA'
  | 'GOAL_ACCEPTANCE_CRITERION_NOT_IN_TASK'
  | 'GOAL_ACCEPTANCE_ARTIFACT_MISSING'
  | 'GOAL_ACCEPTANCE_VERIFY_COMMAND_MISMATCH'
  | 'GOAL_ACCEPTANCE_WORKSPACE_REQUIRED'
  | 'GOAL_ACCEPTANCE_UPDATE_REASON_REQUIRED'

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
  /** sha256 of each declared artifact at validation time (normalized workspace-relative keys). */
  readonly artifactDigests?: Record<string, string>
  /** Byte-level delta vs the previously recorded digests, when they existed. */
  readonly digestDelta?: ArtifactDigestDelta
  /** The command actually executed to produce this verdict, when one ran. */
  readonly verifiedCommand?: string
}

/** Event payload when a linked task's status is updated. */
export interface GoalAcceptanceTaskUpdateEvent {
  readonly type: 'goal-acceptance/task-update'
  readonly taskId: string
  readonly taskStatus: TaskStatus
  readonly updatedAt: number
  /** 'rework' when this update is a rework claim on a drifted completed task. */
  readonly claimKind?: 'work' | 'rework'
}

/** Event payload when an existing criterion's declaration is patched. */
export interface GoalAcceptanceUpdateEvent {
  readonly type: 'goal-acceptance/update'
  readonly criterionId: string
  /** Applied patch fields (resolved values; verifyCommand null means pin cleared). */
  readonly patch: CriterionPatch
  readonly reason: string
  readonly updatedAt: number
  /** True when the patch invalidated a prior 'passed' verdict and reset status to pending. */
  readonly resetToPending?: boolean
}

/** Audit event appended when a rework claim is made against drifted artifacts. */
export interface GoalAcceptanceDriftEvent {
  readonly type: 'goal-acceptance/drift'
  /** Criteria detected as drifted at claim time, with per-artifact reasons. */
  readonly drifted: readonly { readonly criterionId: string; readonly reasons: readonly { readonly path: string; readonly kind: 'changed' | 'missing' | 'unreadable' }[] }[]
  readonly detectedAt: number
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
  | GoalAcceptanceUpdateEvent
  | GoalAcceptanceDriftEvent
