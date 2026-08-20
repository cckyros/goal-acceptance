import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import type { GoalAcceptanceEvent, GoalAcceptanceStore } from '@cckyros/goal-acceptance-core'

/** File-backed event store using a JSON file. */
export class FileAcceptanceStore implements GoalAcceptanceStore {
  constructor(private readonly path: string) {}

  async #read(): Promise<GoalAcceptanceEvent[]> {
    if (!existsSync(this.path)) return []
    const raw = await readFile(this.path, 'utf-8')
    if (raw.trim().length === 0) return []
    return JSON.parse(raw) as GoalAcceptanceEvent[]
  }

  async #write(events: GoalAcceptanceEvent[]): Promise<void> {
    await writeFile(this.path, JSON.stringify(events, null, 2) + '\n')
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
