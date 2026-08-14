import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as GoalAcceptanceInvariant from '../src/invariant.ts'

describe('goal-acceptance invariant companion', () => {
  it('registers invariant and rejects invalid goal-acceptance/set event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(GoalAcceptanceInvariant)

    const session = ctx.sessions.create(SessionId('inv-test'))

    // Valid event
    expect(() => session.append('goal-acceptance/set', {
      criteria: [{ id: 'c1', description: 'test', required: true, method: 'test', status: 'pending' }],
      lockedAt: Date.now(),
    })).not.toThrow()

    // Invalid event (empty criteria)
    expect(() => session.append('goal-acceptance/set', {
      criteria: [],
      lockedAt: Date.now(),
    })).toThrow(InvariantError)
  })
})
