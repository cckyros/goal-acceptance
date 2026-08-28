import type { GoalAcceptanceErrorCode } from './types.ts'

/** Error class for goal acceptance failures with optional actionable remediation hints. */
export class GoalAcceptanceError extends Error {
  readonly code: GoalAcceptanceErrorCode
  readonly hint?: string

  constructor(message: string, code: GoalAcceptanceErrorCode, hint?: string) {
    const fullMessage = hint ? `goal-acceptance: ${message} (Hint: ${hint})` : `goal-acceptance: ${message}`
    super(fullMessage)
    this.code = code
    this.hint = hint
    this.name = 'GoalAcceptanceError'
  }
}
