/**
 * Types and event declarations for the generic goal-acceptance plugin.
 * @module @deepseek-ai/dsh-goal-acceptance/types
 */

export type {
  AcceptanceSummary,
  CriterionSpec,
  GoalAcceptanceErrorCode,
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceValidateEvent,
  GoalCriterion,
  GoalCriterionStatus,
  ValidateCriterionSpec,
} from '@deepseek-ai/dsh-goal-acceptance-core'

export { GoalAcceptanceError } from '@deepseek-ai/dsh-goal-acceptance-core'

type GoalAcceptanceSetPayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceSetEvent, 'type'>
type GoalAcceptanceValidatePayload = Omit<import('@deepseek-ai/dsh-goal-acceptance-core').GoalAcceptanceValidateEvent, 'type'>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'goal-acceptance/set': GoalAcceptanceSetPayload
    'goal-acceptance/validate': GoalAcceptanceValidatePayload
  }
}
