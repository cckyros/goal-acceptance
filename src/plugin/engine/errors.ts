import type { GoalAcceptanceErrorCode } from './types.ts'

/** Error class for goal acceptance failures. */
export class GoalAcceptanceError extends Error {
  readonly code: GoalAcceptanceErrorCode

  constructor(message: string, code: GoalAcceptanceErrorCode) {
    super(`goal-acceptance: ${message}`)
    this.code = code
    this.name = 'GoalAcceptanceError'
  }
}
