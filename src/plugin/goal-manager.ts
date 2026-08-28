/**
 * Multi-goal manager for goal-acceptance. Shared by the MCP and OpenClaw
 * paths — one implementation replaces the two drifting copies that used to
 * live in the mcp and openclaw packages.
 *
 * Data layout (unchanged from the original packages, so existing data keeps
 * loading): `<dataDir>/goals/<id>.json` (event array) + `<id>.meta.json`
 * (goal metadata) + `<dataDir>/current-goal.txt` (restart recovery). An empty
 * dataDir means in-memory mode (no persistence).
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Type-only: erased at build; keeps the dsh session adapter in this shared file
// without pulling @deepseek-ai/* into the MCP/OpenClaw bundles.
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  GoalAcceptanceEngine,
  GoalAcceptanceError,
  InMemoryAcceptanceStore,
  type GoalAcceptanceAmendEvent,
  type GoalAcceptanceEvent,
  type GoalAcceptanceSetEvent,
  type GoalAcceptanceStore,
  type GoalAcceptanceTaskPlanEvent,
  type GoalAcceptanceTaskUpdateEvent,
  type GoalAcceptanceValidateEvent,
} from './engine/index.ts'

/** File-backed event store using a JSON file (single shared implementation). */
export class FileAcceptanceStore implements GoalAcceptanceStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async #read(): Promise<GoalAcceptanceEvent[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFileSync(this.path, 'utf-8')
    if (raw.trim().length === 0) return []
    return JSON.parse(raw) as GoalAcceptanceEvent[]
  }

  async #write(events: GoalAcceptanceEvent[]): Promise<void> {
    await writeFileSync(this.path, JSON.stringify(events, null, 2) + '\n')
  }

  get events(): readonly GoalAcceptanceEvent[] {
    // Synchronous read for engine sync(); safe because append is awaited.
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf-8')
    if (raw.trim().length === 0) return []
    return JSON.parse(raw) as GoalAcceptanceEvent[]
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    const events = await this.#read()
    events.push(event)
    await this.#write(events)
  }
}

interface GoalMeta {
  readonly id: string
  readonly title: string
  readonly createdAt: number
}

export interface GoalListItem extends GoalMeta {
  criteriaCount: number
  passedCount: number
  allRequiredPassed: boolean
  isActive: boolean
}

/**
 * Goal manager: engine cache + meta cache + active-goal tracking over a
 * shared data directory. Instantiate once per process (per dataDir).
 */
export class GoalManager {
  private readonly dataDir: string
  private readonly goalsDir: string
  private currentGoalId: string | null = null
  private readonly engineCache = new Map<string, GoalAcceptanceEngine>()
  private readonly metaCache = new Map<string, GoalMeta>()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.goalsDir = dataDir ? join(dataDir, 'goals') : ''
    if (dataDir) {
      mkdirSync(this.goalsDir, { recursive: true })
      this.loadCurrentGoal()
    }
  }

  getCurrentGoalId(): string | null {
    return this.currentGoalId
  }

  /** Create a store for a specific goal (file-backed when persisted). */
  private storeForGoal(goalId: string): GoalAcceptanceStore {
    const dir = this.goalsDir
    if (dir) {
      return new FileAcceptanceStore(join(dir, `${goalId}.json`))
    }
    return new InMemoryAcceptanceStore()
  }

  /** Get or create the engine for a specific goal ID. */
  private getOrCreateEngine(goalId: string): GoalAcceptanceEngine {
    let engine = this.engineCache.get(goalId)
    if (engine === undefined) {
      engine = new GoalAcceptanceEngine(this.storeForGoal(goalId))
      this.engineCache.set(goalId, engine)
    }
    return engine
  }

  /** Get the engine for the active goal. Throws if no active goal. */
  getEngine(): GoalAcceptanceEngine {
    if (this.currentGoalId === null) {
      throw new GoalAcceptanceError(
        'no active goal. Call start_goal to create one, or set_acceptance_criteria to auto-create one.',
        'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL',
      )
    }
    return this.getOrCreateEngine(this.currentGoalId)
  }

  /** Ensure a goal is active; auto-create one if none exists. */
  ensureGoal(): GoalAcceptanceEngine {
    if (this.currentGoalId === null) {
      this.startGoal()
    }
    return this.getEngine()
  }

  /** Start a new goal. Generates a UUID, persists metadata, sets it as current. */
  startGoal(title?: string): GoalMeta {
    const id = randomUUID()
    const meta: GoalMeta = { id, title: title ?? '', createdAt: Date.now() }
    const dir = this.goalsDir
    if (dir) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + '\n')
      writeFileSync(join(dir, `${id}.json`), '[]')
    }
    this.metaCache.set(id, meta)
    this.currentGoalId = id
    this.persistCurrentGoal()
    // Pre-create engine so the goal is immediately usable
    this.engineCache.set(id, new GoalAcceptanceEngine(this.storeForGoal(id)))
    return meta
  }

  /** Persist the current goal ID to disk for restart recovery. */
  private persistCurrentGoal(): void {
    const d = this.dataDir
    if (d) {
      writeFileSync(join(d, 'current-goal.txt'), this.currentGoalId ?? '')
    }
  }

  /** Load the current goal from disk on startup. */
  private loadCurrentGoal(): void {
    const dir = this.goalsDir
    if (!dir) return
    const f = join(this.dataDir, 'current-goal.txt')
    if (existsSync(f)) {
      const id = readFileSync(f, 'utf-8').trim()
      if (id.length > 0 && existsSync(join(dir, `${id}.meta.json`))) {
        this.currentGoalId = id
        // Load meta into cache
        this.loadGoalMeta(id)
      }
    }
  }

  /** Load a goal's metadata from disk into the cache. */
  private loadGoalMeta(id: string): GoalMeta | undefined {
    const cached = this.metaCache.get(id)
    if (cached) return cached
    const dir = this.goalsDir
    if (!dir) return undefined
    const metaPath = join(dir, `${id}.meta.json`)
    if (!existsSync(metaPath)) return undefined
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as GoalMeta
    this.metaCache.set(id, meta)
    return meta
  }

  /** Return the active goal's metadata, or undefined when none is active. */
  getCurrentGoalMeta(): GoalMeta | undefined {
    if (this.currentGoalId === null) return undefined
    return this.loadGoalMeta(this.currentGoalId)
  }

  /** List all goals with status summaries. */
  listGoals(): GoalListItem[] {
    const dir = this.goalsDir
    if (!dir) {
      // In-memory mode: return from caches
      return Array.from(this.metaCache.values()).map(m => {
        const engine = this.engineCache.get(m.id)
        const summary = engine ? engine.summarize() : { totalCount: 0, passedCount: 0, allRequiredPassed: true }
        return {
          ...m,
          criteriaCount: summary.totalCount,
          passedCount: summary.passedCount,
          allRequiredPassed: summary.allRequiredPassed,
          isActive: m.id === this.currentGoalId,
        }
      }).sort((a, b) => b.createdAt - a.createdAt)
    }
    const files = readdirSync(dir).filter(f => f.endsWith('.meta.json'))
    return files.map(f => {
      const meta = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as GoalMeta
      this.metaCache.set(meta.id, meta)
      const engine = this.getOrCreateEngine(meta.id)
      const summary = engine.summarize()
      return {
        ...meta,
        criteriaCount: summary.totalCount,
        passedCount: summary.passedCount,
        allRequiredPassed: summary.allRequiredPassed,
        isActive: meta.id === this.currentGoalId,
      }
    }).sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Switch the active goal to an existing goal ID. */
  switchGoal(id: string): GoalMeta {
    const dir = this.goalsDir
    if (dir) {
      if (!existsSync(join(dir, `${id}.meta.json`))) {
        throw new GoalAcceptanceError(`goal ${id} not found`, 'GOAL_ACCEPTANCE_NOT_FOUND')
      }
    } else {
      if (!this.metaCache.has(id)) {
        throw new GoalAcceptanceError(`goal ${id} not found`, 'GOAL_ACCEPTANCE_NOT_FOUND')
      }
    }
    this.currentGoalId = id
    this.persistCurrentGoal()
    return this.loadGoalMeta(id) ?? { id, title: '', createdAt: 0 }
  }

  /** Reset (delete) the current goal's data and clear it as active. */
  resetGoal(): void {
    if (this.currentGoalId === null) {
      throw new GoalAcceptanceError('no active goal to reset', 'GOAL_ACCEPTANCE_NO_ACTIVE_GOAL')
    }
    const id = this.currentGoalId
    const dir = this.goalsDir
    if (dir) {
      try { unlinkSync(join(dir, `${id}.json`)) } catch { /* already removed */ }
      try { unlinkSync(join(dir, `${id}.meta.json`)) } catch { /* already removed */ }
    }
    this.engineCache.delete(id)
    this.metaCache.delete(id)
    this.currentGoalId = null
    this.persistCurrentGoal()
  }
}

const ACCEPTANCE_EVENT_TYPES = new Set([
  'goal-acceptance/set',
  'goal-acceptance/validate',
  'goal-acceptance/task-update',
  'goal-acceptance/amend',
  'goal-acceptance/task-plan',
])

/**
 * Session-backed store adapter for the dsh path: goal-acceptance events are
 * appended to the calling agent's session, so they replay from the session
 * transcript (same semantics as the original dsh package's store).
 */
export class SessionAcceptanceStore implements GoalAcceptanceStore {
  // Plain field (not a TS parameter property): node --test strip-only mode
  // cannot parse constructor parameter properties.
  private readonly session: Session

  constructor(session: Session) {
    this.session = session
  }

  get events(): readonly GoalAcceptanceEvent[] {
    return this.session.events
      .filter(isAcceptanceEvent)
      .map(toGoalAcceptanceEvent)
  }

  append(event: GoalAcceptanceEvent): void {
    switch (event.type) {
      case 'goal-acceptance/set': {
        const { type: _type, ...payload } = event as GoalAcceptanceSetEvent
        this.session.append('goal-acceptance/set', payload)
        break
      }
      case 'goal-acceptance/validate': {
        const { type: _type, evidence, ...payload } = event as GoalAcceptanceValidateEvent
        this.session.append('goal-acceptance/validate', {
          ...payload,
          ...evidence !== undefined ? { evidence } : {},
        })
        break
      }
      case 'goal-acceptance/task-update': {
        const { type: _type, ...payload } = event as GoalAcceptanceTaskUpdateEvent
        this.session.append('goal-acceptance/task-update', payload)
        break
      }
      case 'goal-acceptance/amend': {
        const { type: _type, ...payload } = event as GoalAcceptanceAmendEvent
        this.session.append('goal-acceptance/amend', payload)
        break
      }
      case 'goal-acceptance/task-plan': {
        const { type: _type, ...payload } = event as GoalAcceptanceTaskPlanEvent
        this.session.append('goal-acceptance/task-plan', payload)
        break
      }
    }
  }
}

function isAcceptanceEvent(event: SessionEvent): event is SessionEvent & { data: GoalAcceptanceEvent } {
  return ACCEPTANCE_EVENT_TYPES.has(event.type)
}

function toGoalAcceptanceEvent(event: SessionEvent & { data: GoalAcceptanceEvent }): GoalAcceptanceEvent {
  return { ...event.data, type: event.type } as GoalAcceptanceEvent
}
