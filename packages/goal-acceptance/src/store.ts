/**
 * Session-backed store adapter for the goal-acceptance core engine.
 * @module @deepseek-ai/dsh-goal-acceptance/store
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  GoalAcceptanceEvent,
  GoalAcceptanceSetEvent,
  GoalAcceptanceStore,
  GoalAcceptanceValidateEvent,
} from '@deepseek-ai/dsh-goal-acceptance-core'

export class SessionAcceptanceStore implements GoalAcceptanceStore {
  constructor(private readonly session: Session) {}

  get events(): readonly GoalAcceptanceEvent[] {
    return this.session.events
      .filter(isAcceptanceEvent)
      .map(toGoalAcceptanceEvent)
  }

  append(event: GoalAcceptanceEvent): void {
    if (event.type === 'goal-acceptance/set') {
      const { type: _type, ...payload } = event as GoalAcceptanceSetEvent
      this.session.append('goal-acceptance/set', payload)
    } else {
      const { type: _type, evidence, ...payload } = event as GoalAcceptanceValidateEvent
      this.session.append('goal-acceptance/validate', {
        ...payload,
        ...evidence !== undefined ? { evidence } : {},
      })
    }
  }
}

function isAcceptanceEvent(event: SessionEvent): event is SessionEvent & { data: GoalAcceptanceEvent } {
  return event.type === 'goal-acceptance/set' || event.type === 'goal-acceptance/validate'
}

function toGoalAcceptanceEvent(event: SessionEvent & { data: GoalAcceptanceEvent }): GoalAcceptanceEvent {
  return { ...event.data, type: event.type } as GoalAcceptanceEvent
}
