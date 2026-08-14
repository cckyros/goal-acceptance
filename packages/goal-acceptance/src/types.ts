/**
 * Types and event declarations for the generic goal-acceptance plugin.
 * @module @deepseek-ai/dsh-goal-acceptance/types
 */

export type {
  AcceptanceSummary,
  AmendSpec,
  CriterionSpec,
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
} from '@deepseek-ai/dsh-goal-acceptance-core'

export { GoalAcceptanceError } from '@deepseek-ai/dsh-goal-acceptance-core'

type GoalAcceptanceSetPayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceSetEvent, 'type'>
type GoalAcceptanceValidatePayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceValidateEvent, 'type'>
type GoalAcceptanceTaskUpdatePayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceTaskUpdateEvent, 'type'>
type GoalAcceptanceAmendPayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceAmendEvent, 'type'>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'goal-acceptance/set': GoalAcceptanceSetPayload
    'goal-acceptance/validate': GoalAcceptanceValidatePayload
    'goal-acceptance/task-update': GoalAcceptanceTaskUpdatePayload
    'goal-acceptance/amend': GoalAcceptanceAmendPayload
  }
}
