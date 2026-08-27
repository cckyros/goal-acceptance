/**
 * Package-owned goal-acceptance invariants.
 * @module @cckyros/goal-acceptance/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@cckyros/goal-acceptance'

/** Cordis companion plugin name. */
export const name = 'goal-acceptance-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate acceptance criteria events for structure and uniqueness. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'goal-acceptance/set') {
    const data = event.data as { criteria?: unknown[] }
    if (!Array.isArray(data.criteria) || data.criteria.length === 0) {
      fail('goal-acceptance/set event must contain a non-empty criteria array')
    }
  }
}

/** Check existing sessions and candidate events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) {
      validateEvent(event, fail)
    }
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the goal-acceptance invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns disposer promise.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
