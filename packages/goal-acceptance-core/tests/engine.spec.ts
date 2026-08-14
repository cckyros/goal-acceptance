import { describe, expect, it } from 'vitest'
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '../src/index.ts'

describe('GoalAcceptanceEngine', () => {
  function createEngine() {
    const store = new InMemoryAcceptanceStore()
    return { engine: new GoalAcceptanceEngine(store), store }
  }

  it('sets and locks criteria', async () => {
    const { engine } = createEngine()
    const criteria = await engine.setCriteria([
      { id: 'c1', description: 'API returns 200' },
      { id: 'c2', description: 'Docs updated', required: false },
    ])

    expect(criteria).toHaveLength(2)
    expect(criteria[0]!.required).toBe(true)
    expect(criteria[1]!.required).toBe(false)
    expect(criteria[0]!.status).toBe('pending')

    const all = engine.getCriteria()
    expect(all).toHaveLength(2)
  })

  it('rejects empty criteria', async () => {
    const { engine } = createEngine()
    await expect(engine.setCriteria([])).rejects.toThrow('criteria list must be a non-empty array')
  })

  it('rejects duplicate ids', async () => {
    const { engine } = createEngine()
    await expect(engine.setCriteria([
      { id: 'c1', description: 'One' },
      { id: 'c1', description: 'Two' },
    ])).rejects.toThrow('duplicate criterion id')
  })

  it('rejects setting criteria twice', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await expect(engine.setCriteria([{ id: 'c2', description: 'Two' }])).rejects.toThrow('already locked')
  })

  it('validates a criterion with evidence', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200', method: 'test' }])

    const updated = await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: 'GET /health returned 200',
    })

    expect(updated.status).toBe('passed')
    expect(updated.evidence).toBe('GET /health returned 200')
    expect(engine.summarize().passedCount).toBe(1)
  })

  it('rejects validation without evidence for passed/failed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }])
    await expect(engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
    })).rejects.toThrow('evidence is required')
  })

  it('rejects validation of unknown criterion', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'One' }])
    await expect(engine.validateCriterion({
      criterionId: 'missing',
      status: 'blocked',
    })).rejects.toThrow('not found')
  })

  it('summarizes all statuses and blocks completion', () => {
    const { engine } = createEngine()
    const summary = engine.summarize()
    expect(summary.totalCount).toBe(0)
    expect(summary.allRequiredPassed).toBe(true)
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('canComplete blocks when required criteria not passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([
      { id: 'c1', description: 'Pass 1' },
      { id: 'c2', description: 'Pass 2' },
    ])

    const result = engine.canComplete()
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('required acceptance criteria')
  })

  it('canComplete allows when all required passed', async () => {
    const { engine } = createEngine()
    await engine.setCriteria([{ id: 'c1', description: 'API returns 200' }])
    await engine.validateCriterion({
      criterionId: 'c1',
      status: 'passed',
      evidence: '200 OK',
    })
    expect(engine.canComplete().allowed).toBe(true)
  })

  it('replays state from store events', async () => {
    const store = new InMemoryAcceptanceStore()
    const engine1 = new GoalAcceptanceEngine(store)
    await engine1.setCriteria([{ id: 'c1', description: 'One' }])
    await engine1.validateCriterion({ criterionId: 'c1', status: 'passed', evidence: 'ok' })

    const engine2 = new GoalAcceptanceEngine(store)
    expect(engine2.summarize().passedCount).toBe(1)
  })
})
