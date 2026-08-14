import type { GoalAcceptanceEvent } from './types.ts'

/** Abstract store for goal-acceptance events. */
export interface GoalAcceptanceStore {
  /** All events currently in the store, in append order. */
  readonly events: readonly GoalAcceptanceEvent[]
  /** Append a new event to the store. */
  append(event: GoalAcceptanceEvent): Promise<void> | void
}

/** In-memory store suitable for tests and non-Cordis consumers. */
export class InMemoryAcceptanceStore implements GoalAcceptanceStore {
  private readonly _events: GoalAcceptanceEvent[] = []

  get events(): readonly GoalAcceptanceEvent[] {
    return this._events
  }

  append(event: GoalAcceptanceEvent): void {
    this._events.push(event)
  }
}
