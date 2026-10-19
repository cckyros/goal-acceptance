import type { GoalAcceptanceEvent } from './types.ts'

/** Abstract store for goal-acceptance events. */
export interface GoalAcceptanceStore {
  /** All events currently in the store, in append order. */
  readonly events: readonly GoalAcceptanceEvent[]
  /** Append a new event to the store. */
  append(event: GoalAcceptanceEvent): Promise<void> | void
  /**
   * Optional mutual exclusion around a check-then-act critical section.
   * File-backed stores implement this with a filesystem lock; memory stores
   * may omit it. NOT re-entrant — never wrap a call that takes the lock again.
   */
  withLock?<T>(fn: () => Promise<T> | T): Promise<T>
}

/** In-memory store suitable for tests and non-Cordis consumers. */
export class InMemoryAcceptanceStore implements GoalAcceptanceStore {
  private readonly _events: GoalAcceptanceEvent[] = []
  private _tail: Promise<unknown> = Promise.resolve()

  get events(): readonly GoalAcceptanceEvent[] {
    return this._events
  }

  append(event: GoalAcceptanceEvent): void {
    this._events.push(event)
  }

  /** In-process mutex: serializes check-then-act sections on this store. */
  withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this._tail.then(() => fn())
    this._tail = next.then(() => undefined, () => undefined)
    return next
  }
}
