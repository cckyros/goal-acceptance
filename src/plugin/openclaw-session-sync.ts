/**
 * OpenClaw session-goal bridge for goal-acceptance.
 *
 * The old OpenClaw `get_goal` / `update_goal` tools read and write the
 * `SessionEntry.goal` slot. The new goal-acceptance plugin keeps its own
 * event-sourced goal state. To keep both surfaces usable without coupling
 * OpenClaw core to plugin internals, we mirror the active acceptance goal
 * into `SessionEntry.goal` after every plugin tool that mutates goal state.
 */
import type { OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/core'
import type { GoalManager } from './goal-manager.ts'

type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'

interface SessionGoalShape {
  schemaVersion: 1
  id: string
  objective: string
  status: SessionGoalStatus
  createdAt: number
  updatedAt: number
  tokenStart: number
  tokenStartFresh: true
  tokensUsed: number
  continuationTurns: number
}

export interface SyncGoalContext {
  api: OpenClawPluginApi
  toolContext: OpenClawPluginToolContext
  manager: GoalManager
}

export interface ClearGoalContext {
  api: OpenClawPluginApi
  toolContext: OpenClawPluginToolContext
}

function hasSession(ctx: { toolContext: OpenClawPluginToolContext }): { sessionKey: string; agentId: string } | undefined {
  const { sessionKey, agentId } = ctx.toolContext
  if (!sessionKey || !agentId) return undefined
  return { sessionKey, agentId }
}

function buildGoal(manager: GoalManager, now: number): SessionGoalShape | undefined {
  const id = manager.getCurrentGoalId()
  if (id === null) return undefined
  const meta = manager.getCurrentGoalMeta() ?? { id, title: '', createdAt: now }
  const summary = manager.getEngine().summarize()
  const status = summary.totalCount > 0 && summary.allRequiredPassed ? 'complete' : 'active'
  return {
    schemaVersion: 1,
    id: meta.id,
    objective: meta.title,
    status,
    createdAt: meta.createdAt,
    updatedAt: now,
    tokenStart: 0,
    tokenStartFresh: true,
    tokensUsed: 0,
    continuationTurns: 0,
  }
}

/** Preserve an explicit user `blocked` override for the same goal until it actually completes. */
function preserveStatus(existingStatus: SessionGoalStatus | undefined, newStatus: SessionGoalStatus, existingId: string | undefined, newId: string): SessionGoalStatus {
  if (existingId === newId && existingStatus === 'blocked' && newStatus !== 'complete') return 'blocked'
  return newStatus
}

/**
 * Mirror the active acceptance goal into `SessionEntry.goal`.
 * Called after every plugin tool that can change the active goal or its
 * criteria state. Skips silently when no OpenClaw session is available.
 */
export async function syncSessionGoal(ctx: SyncGoalContext): Promise<void> {
  const scope = hasSession(ctx)
  if (!scope) return
  const { api, manager } = ctx
  const now = Date.now()
  const goal = buildGoal(manager, now)
  if (!goal) {
    await clearSessionGoal(ctx)
    return
  }
  try {
    const sessionStore = api.runtime?.agent?.session
    if (!sessionStore) return
    const existing = sessionStore.getSessionEntry(scope)
    const existingGoal = existing?.goal as SessionGoalShape | undefined
    goal.status = preserveStatus(existingGoal?.status, goal.status, existingGoal?.id, goal.id)
    await sessionStore.patchSessionEntry({
      ...scope,
      update: () => ({ goal }),
    })
  } catch (e) {
    api.logger?.warn?.(`goal-acceptance session sync failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Remove the mirrored `SessionEntry.goal` (after reset_goal or no active goal). */
export async function clearSessionGoal(ctx: ClearGoalContext): Promise<void> {
  const scope = hasSession(ctx)
  if (!scope) return
  const { api } = ctx
  try {
    const sessionStore = api.runtime?.agent?.session
    if (!sessionStore) return
    await sessionStore.patchSessionEntry({
      ...scope,
      update: () => ({ goal: undefined }),
    })
  } catch (e) {
    api.logger?.warn?.(`goal-acceptance session clear failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
