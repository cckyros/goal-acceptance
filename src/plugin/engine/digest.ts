/**
 * Artifact digest helpers for the verification integrity layer.
 * @module @cckyros/goal-acceptance-core/digest
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Resolve a declared artifact path against the workspace root.
 * Absolute paths are used as-is; relative paths must stay inside the
 * workspace subtree (rejects `../` escapes). Returns the absolute path.
 * Throws GOAL_ACCEPTANCE_INVALID_CRITERIA-shaped Error on escape.
 */
export function resolveArtifactPath(workspaceRoot: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    return artifactPath
  }
  const root = resolve(workspaceRoot)
  const abs = resolve(root, artifactPath)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`artifact path "${artifactPath}" escapes workspace root`)
  }
  return abs
}

/** Normalize an absolute path to a workspace-relative POSIX key for digest maps. */
function artifactKey(workspaceRoot: string, absolutePath: string): string {
  const root = resolve(workspaceRoot)
  const abs = resolve(absolutePath)
  if (abs.startsWith(root + sep)) {
    return abs.slice(root.length + 1).split(sep).join('/')
  }
  return absolutePath // absolute path outside workspace: keep as declared
}

type ArtifactHashResult =
  | { readonly kind: 'ok'; readonly digest: string }
  | { readonly kind: 'missing' | 'unreadable' }

/** sha256 of a single artifact file. 'missing' when absent, 'unreadable' on other IO errors. */
function hashArtifact(absolutePath: string): ArtifactHashResult {
  try {
    const content = readFileSync(absolutePath)
    return { kind: 'ok', digest: createHash('sha256').update(content).digest('hex') }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    return { kind: code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

/**
 * Hash all declared artifact paths under workspaceRoot.
 * Keys are normalized workspace-relative POSIX paths (absolute outside-workspace kept as-is).
 * Missing/unreadable entries are omitted from the returned map; details in `problems`.
 */
export function hashArtifacts(
  workspaceRoot: string,
  artifactPaths: readonly string[],
): { digests: Record<string, string>; problems: { path: string; kind: 'missing' | 'unreadable' }[] } {
  const digests: Record<string, string> = {}
  const problems: { path: string; kind: 'missing' | 'unreadable' }[] = []
  for (const p of artifactPaths) {
    const abs = resolveArtifactPath(workspaceRoot, p)
    const result = hashArtifact(abs)
    const key = artifactKey(workspaceRoot, abs)
    if (result.kind === 'ok') {
      digests[key] = result.digest
    } else {
      problems.push({ path: key, kind: result.kind })
    }
  }
  return { digests, problems }
}
