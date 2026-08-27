// Generic disk cache: key = sha256(content) + caller-supplied validity
// fields (e.g. mtime, size, model). Stored under `<configDir>/cache/` next
// to the config file that was read (project or global).
// One record per sha; a newer record for the same content overwrites the
// old one (natural invalidation — the old key then misses and refetches).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB cap

export function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface CacheDirOptions {
  configDir: string;
  cacheDirName: string;
  cwd: string;
  home?: string;
}

/** Cache location follows the config scope: when the project has its own
 *  config.json use the project cache, otherwise the global one. */
export function cacheDirFor(opts: CacheDirOptions): string {
  const home = opts.home ?? homedir();
  if (existsSync(join(opts.cwd, opts.configDir, "config.json"))) {
    return join(opts.cwd, opts.configDir, opts.cacheDirName);
  }
  return join(home, opts.configDir, opts.cacheDirName);
}

export interface CacheRecord {
  key: string;
  /** Validity fields supplied by the caller; ALL must match for a hit. */
  meta: Record<string, unknown>;
  text: string;
}

export class DiskCache {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number = CACHE_MAX_BYTES) {
    this.dir = dir;
    this.maxBytes = maxBytes;
  }

  private recordPath(sha: string): string {
    return join(this.dir, `${sha}.json`);
  }

  /** Hit when a record exists whose meta matches exactly (JSON-equal). */
  async get(sha: string, meta: Record<string, unknown>): Promise<string | null> {
    const file = this.recordPath(sha);
    if (!existsSync(file)) return null;
    let rec: CacheRecord;
    try {
      rec = JSON.parse(await readFile(file, "utf8")) as CacheRecord;
    } catch {
      return null;
    }
    if (typeof rec?.text !== "string" || !jsonEqual(rec.meta, meta)) return null;
    return rec.text;
  }

  async set(sha: string, meta: Record<string, unknown>, text: string): Promise<void> {
    const rec: CacheRecord = { key: sha, meta, text };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.recordPath(sha), JSON.stringify(rec, null, 2) + "\n", "utf8");
    await this.prune();
  }

  /** Total cache size above maxBytes: evict oldest (by mtime) first. */
  async prune(): Promise<void> {
    let entries: Array<{ file: string; mtimeMs: number; size: number }>;
    try {
      const names = await readdir(this.dir);
      const withStats = await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n) => {
            const p = join(this.dir, n);
            const s = await stat(p).catch(() => null);
            return s ? { file: p, mtimeMs: s.mtimeMs, size: s.size } : null;
          }),
      );
      entries = withStats.filter((e): e is NonNullable<typeof e> => e !== null);
    } catch {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      await unlink(e.file).catch(() => {});
      total -= e.size;
    }
  }

  /** Remove the whole cache directory (used by `uninstall --purge-config`). */
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
