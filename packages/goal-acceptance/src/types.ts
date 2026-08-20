/**
 * Types and event declarations for the generic goal-acceptance plugin.
 * @module @cckyros/goal-acceptance/types
 */

export type {
  AcceptanceSummary,
  AmendSpec,
  ConfirmCriterionSpec,
  CriterionSpec,
  EvidenceType,
  GoalRole,
  GoalTask,
  TaskPlanSpec,
  CriterionTaskProgress,
  GoalAcceptanceErrorCode,
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceValidateEvent,
  GoalAcceptanceTaskUpdateEvent,
  GoalAcceptanceAmendEvent,
  GoalCriterion,
  GoalCriterionStatus,
  TaskStatus,
  TaskUpdateSpec,
  ValidateCriterionSpec,
} from '@cckyros/goal-acceptance-core'

export { GoalAcceptanceError } from '@cckyros/goal-acceptance-core'

type GoalAcceptanceSetPayload = Omit<import('@cckyros/goal-acceptance-core').GoalAcceptanceSetEvent, 'type'>
type GoalAcceptanceValidatePayload = Omit<import('@cckyros/goal-acceptance-core').GoalAcceptanceValidateEvent, 'type'>
type GoalAcceptanceTaskUpdatePayload = Omit<import('@cckyros/goal-acceptance-core').GoalAcceptanceTaskUpdateEvent, 'type'>
type GoalAcceptanceAmendPayload = Omit<import('@cckyros/goal-acceptance-core').GoalAcceptanceAmendEvent, 'type'>
type GoalAcceptanceTaskPlanPayload = Omit<import('@cckyros/goal-acceptance-core').GoalAcceptanceTaskPlanEvent, 'type'>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'goal-acceptance/set': GoalAcceptanceSetPayload
    'goal-acceptance/validate': GoalAcceptanceValidatePayload
    'goal-acceptance/task-update': GoalAcceptanceTaskUpdatePayload
    'goal-acceptance/amend': GoalAcceptanceAmendPayload
    'goal-acceptance/task-plan': GoalAcceptanceTaskPlanPayload
  }
}
