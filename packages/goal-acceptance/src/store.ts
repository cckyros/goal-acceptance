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
  GoalAcceptanceTaskUpdateEvent,
  GoalAcceptanceAmendEvent,
} from '@deepseek-ai/dsh-goal-acceptance-core'

const ACCEPTANCE_EVENT_TYPES = new Set([
  'goal-acceptance/set',
  'goal-acceptance/validate',
  'goal-acceptance/task-update',
  'goal-acceptance/amend',
])

export class SessionAcceptanceStore implements GoalAcceptanceStore {
  constructor(private readonly session: Session) {}

  get events(): readonly GoalAcceptanceEvent[] {
    return this.session.events
      .filter(isAcceptanceEvent)
      .map(toGoalAcceptanceEvent)
  }

  append(event: GoalAcceptanceEvent): void {
    switch (event.type) {
      case 'goal-acceptance/set': {
        const { type: _type, ...payload } = event as GoalAcceptanceSetEvent
        this.session.append('goal-acceptance/set', payload)
        break
      }
      case 'goal-acceptance/validate': {
        const { type: _type, evidence, ...payload } = event as GoalAcceptanceValidateEvent
        this.session.append('goal-acceptance/validate', {
          ...payload,
          ...evidence !== undefined ? { evidence } : {},
        })
        break
      }
      case 'goal-acceptance/task-update': {
        const { type: _type, ...payload } = event as GoalAcceptanceTaskUpdateEvent
        this.session.append('goal-acceptance/task-update', payload)
        break
      }
      case 'goal-acceptance/amend': {
        const { type: _type, ...payload } = event as GoalAcceptanceAmendEvent
        this.session.append('goal-acceptance/amend', payload)
        break
      }
    }
  }
}

function isAcceptanceEvent(event: SessionEvent): event is SessionEvent & { data: GoalAcceptanceEvent } {
  return ACCEPTANCE_EVENT_TYPES.has(event.type)
}

function toGoalAcceptanceEvent(event: SessionEvent & { data: GoalAcceptanceEvent }): GoalAcceptanceEvent {
  return { ...event.data, type: event.type } as GoalAcceptanceEvent
}
