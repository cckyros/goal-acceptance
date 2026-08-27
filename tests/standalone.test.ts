import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '../src/plugin/engine/index.ts'

describe('OpenClaw-style standalone usage', () => {
  it('can run the acceptance engine without Cordis or Harness', async () => {
    // This is the exact pattern an OpenClaw skill would use:
    // 1. Create a store (could be memory, file, or OpenClaw's own log).
    // 2. Create an engine.
    // 3. Set criteria, validate them, and check completion.
    const store = new InMemoryAcceptanceStore()
    const acceptance = new GoalAcceptanceEngine(store)

    await acceptance.setCriteria([
      { id: 'compile', description: 'TypeScript compiles without errors', required: true, method: 'tsc' },
      { id: 'lint', description: 'ESLint passes', required: false, method: 'lint' },
    ])

    await acceptance.validateCriterion({
      criterionId: 'compile',
      status: 'passed',
      evidence: 'tsc --noEmit exited with 0',
      evidenceType: 'command',
    })

    // Default role is 'agent': passed is self-claimed, completion is blocked
    // until an independent reviewer confirms with fresh evidence.
    assert.equal(acceptance.canComplete().allowed, false)

    await acceptance.confirmCriterion({
      criterionId: 'compile',
      evidence: 'reviewer re-ran tsc --noEmit: exit 0',
      evidenceType: 'command',
    })

    assert.equal(acceptance.canComplete().allowed, true)
    assert.equal(acceptance.summarize().allRequiredPassed, true)
  })
})
