/**
 * Model-facing system prompt section for goal acceptance criteria.
 * @module @deepseek-ai/dsh-goal-acceptance/prompt
 */

import type { AcceptanceSummary } from './types.ts'

/** Render goal-acceptance instructions and current criteria status for system prompt. */
export function renderAcceptanceGuidance(summary?: AcceptanceSummary): string {
  let text = 'Goal Acceptance Policy:\n'
    + '- Before autonomous implementation, establish and confirm delivery criteria with the user using `set_acceptance_criteria`.\n'
    + '- Once confirmed, criteria are locked for this Goal run. Do not edit, downgrade, or remove criteria during execution.\n'
    + '- As tasks complete, validate each criterion with concrete evidence using `validate_criterion` (status: `passed` or `failed` requires evidence).\n'
    + '- If a criterion cannot be verified because this environment lacks a vision model, screenshot comparison, permission, or external service, mark it as `blocked`.\n'
    + '- Continue executing all achievable independent criteria even if one criterion has failed.\n'
    + '- The Goal can only conclude when all required criteria are passed; otherwise report a structured summary of failures and blockers.'

  if (summary !== undefined && summary.totalCount > 0) {
    text += `\n\nCurrent Criteria (${summary.passedCount}/${summary.totalCount} passed, all required passed: ${String(summary.allRequiredPassed)}):`
    if (summary.failures.length > 0) {
      text += `\n- Failures (${summary.failedCount}): ${summary.failures.map(f => f.id).join(', ')}`
    }
    if (summary.blockers.length > 0) {
      text += `\n- Blockers (${summary.blockedCount}): ${summary.blockers.map(b => b.id).join(', ')}`
    }
    if (summary.pending.length > 0) {
      text += `\n- Pending (${summary.pendingCount}): ${summary.pending.map(p => p.id).join(', ')}`
    }
  }

  return text
}
