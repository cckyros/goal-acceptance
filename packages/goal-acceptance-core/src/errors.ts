import type { GoalAcceptanceErrorCode } from './types.ts'

/** Error class for goal acceptance failures. */
export class GoalAcceptanceError extends Error {
  constructor(message: string, readonly code: GoalAcceptanceErrorCode) {
    super(`goal-acceptance: ${message}`)
    this.name = 'GoalAcceptanceError'
  }
}
