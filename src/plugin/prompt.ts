/**
 * Model-facing system prompt section for goal acceptance criteria.
 * @module @cckyros/goal-acceptance/prompt
 */

import type { AcceptanceSummary } from './engine/index.ts'

/** Render goal-acceptance instructions, current criteria status, and task progress for system prompt. */
export function renderAcceptanceGuidance(summary?: AcceptanceSummary): string {
  let text = 'Goal Acceptance Policy:\n'
    + '- Before autonomous implementation, establish and confirm delivery criteria with the user using `set_acceptance_criteria`.\n'
    + '- Each criterion may link to task IDs (`task_ids`) and declare dependencies on other criteria (`depends_on`). Link tasks so progress is tracked automatically.\n'
    + '- Once confirmed, criteria are locked for this Goal run. Do not edit, downgrade, or remove criteria during execution.\n'
    + '- If requirements expand during execution, use `amend_acceptance_criteria` to append new criteria with a reason. Existing criteria are not modified.\n'
    + '- As tasks complete, call `update_task_status` to reflect progress. When all tasks linked to a criterion are completed, that criterion is "ready to validate".\n'
    + '- Validate each criterion with concrete evidence using `validate_criterion` (status: `passed` or `failed` requires evidence).\n'
    + '- Required criteria passed by the agent are self-claimed; an independent reviewer must re-verify them and call `confirm_criterion` with command, file, or url evidence before completion.\n'
    + '- Respect dependency ordering: validate criteria whose `depends_on` are all passed first.\n'
    + '- If a criterion cannot be verified because this environment lacks a vision model, screenshot comparison, permission, or external service, mark it as `blocked`.\n'
    + '- Continue executing all achievable independent criteria even if one criterion has failed.\n'
    + '- The Goal can only conclude when all required criteria are formally passed; self-claimed passes require independent `confirm_criterion` review. Otherwise report a structured summary of failures and blockers.'

  if (summary !== undefined && summary.totalCount > 0) {
    const tp = summary.taskProgress
    text += `\n\nCurrent Criteria (${summary.passedCount}/${summary.totalCount} passed, all required passed: ${String(summary.allRequiredPassed)}):`
    if (tp.totalTasks > 0) {
      text += `\nTask Progress: ${tp.completedTasks}/${tp.totalTasks} completed, ${tp.inProgressTasks} in progress, ${tp.pendingTasks} pending, ${tp.failedTasks} failed`
    }
    if (summary.failures.length > 0) {
      text += `\n- Failures (${summary.failedCount}): ${summary.failures.map(f => f.id).join(', ')}`
    }
    if (summary.blockers.length > 0) {
      text += `\n- Blockers (${summary.blockedCount}): ${summary.blockers.map(b => b.id).join(', ')}`
    }
    if (summary.pending.length > 0) {
      text += `\n- Pending (${summary.pendingCount}): ${summary.pending.map(p => p.id).join(', ')}`
    }
    if (summary.readyToValidate.length > 0) {
      text += `\n- Ready to validate (all linked tasks completed): ${summary.readyToValidate.map(c => c.id).join(', ')}`
    }
    if (summary.nextActionable.length > 0) {
      const next = summary.nextActionable[0]!
      text += `\n- Next actionable: "${next.id}" (${next.description})`
      if (summary.nextActionable.length > 1) {
        text += `; followed by: ${summary.nextActionable.slice(1).map(c => `"${c.id}"`).join(', ')}`
      }
    }
  }

  return text
}
