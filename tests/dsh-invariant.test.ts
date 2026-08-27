// goal-acceptance invariant companion tests (migrated from the original dsh
// package's invariant.spec.ts, vitest → node:test). The companion rejects
// goal-acceptance/set events whose criteria array is empty.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as GoalAcceptanceInvariant from '../src/plugin/invariant.ts'

describe('goal-acceptance invariant companion', () => {
  it('registers invariant and rejects invalid goal-acceptance/set event', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(GoalAcceptanceInvariant)

    const session = ctx.sessions.create(SessionId('inv-test'))

    // Valid event
    session.append('goal-acceptance/set', {
      criteria: [{ id: 'c1', description: 'test', required: true, method: 'test', status: 'pending', taskIds: [], dependsOn: [] }],
      lockedAt: Date.now(),
    })

    // Invalid event (empty criteria)
    assert.throws(() => session.append('goal-acceptance/set', {
      criteria: [],
      lockedAt: Date.now(),
    }), InvariantError)
  })
})
