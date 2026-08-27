// Safe file operations shared by every target adapter and the generator.
//
// Safety rules (inherited from deepseek-vl-support and carried into every
// scaffolded plugin):
//  - a file/entry is OURS only if it carries our marker (manifest.markers) —
//    uninstall removes marked artifacts and never touches anything else
//  - the first modification of an existing file backs it up to `<file>.bak`
//  - JSON edits are deep-merged, idempotent, and leave unknown keys alone
//  - every adapter reports {changed, backup} so callers can aggregate
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function readTextFile(p: string): string | null {
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

export function writeTextFile(p: string, content: string): void {
  ensureDir(p);
  writeFileSync(p, content, "utf8");
}

/** Copy `p` to `p.bak` (pre-modification state). Returns the backup path. */
export function backupFile(p: string): string | null {
  try {
    const bak = `${p}.bak`;
    copyFileSync(p, bak);
    return bak;
  } catch {
    return null;
  }
}

export interface EditResult {
  changed: boolean;
  backup?: string | null;
}

export function noChange(): EditResult {
  return { changed: false };
}

/** Read JSON with a fallback; null when missing/unparseable. */
export function readJson(p: string): unknown | null {
  const text = readTextFile(p);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- deep merge

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive deep merge: patch wins, arrays replace, unknown keys kept. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ---------------------------------------------------------------- managed JSON

/**
 * Upsert a managed JSON entry under `key` (deep-merged, idempotent). The
 * entry is written as-is; the caller is responsible for embedding a marker
 * (e.g. a command string containing our hook marker) so uninstall can find it.
 */
export function upsertJsonKey(
  jsonPath: string,
  key: string,
  patch: unknown,
): EditResult {
  const existing = readTextFile(jsonPath);
  if (existing === null) {
    writeTextFile(jsonPath, JSON.stringify({ [key]: patch }, null, 2) + "\n");
    return { changed: true };
  }
  let data: unknown;
  try {
    data = JSON.parse(existing);
  } catch {
    return noChange();
  }
  if (!isPlainObject(data)) return noChange();
  const next = { ...data, [key]: deepMerge(data[key], patch) };
  const content = JSON.stringify(next, null, 2) + "\n";
  if (content === existing) return noChange();
  const backup = backupFile(jsonPath);
  writeTextFile(jsonPath, content);
  return { changed: true, backup };
}

/** Remove a managed JSON entry under `key` — but only if it looks ours
 *  (deep string scan for `marker`). Never removes unknown entries. */
export function removeJsonKey(jsonPath: string, key: string, marker: string): EditResult {
  const data = readJson(jsonPath);
  if (!isPlainObject(data)) return noChange();
  const entry = data[key];
  if (!isPlainObject(entry)) return noChange();
  if (!JSON.stringify(entry).includes(marker)) return noChange();
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== key) next[k] = v;
  const content = JSON.stringify(next, null, 2) + "\n";
  const existing = readTextFile(jsonPath) ?? "";
  if (content === existing) return noChange();
  const backup = backupFile(jsonPath);
  writeTextFile(jsonPath, content);
  return { changed: true, backup };
}

// ---------------------------------------------------------------- managed text block

/** Insert/replace a managed text block between start/end markers (idempotent). */
export function upsertManagedBlock(
  filePath: string,
  block: string,
  startMarker: string,
  endMarker: string,
): EditResult {
  const existing = readTextFile(filePath);
  if (existing === null) {
    writeTextFile(filePath, block + "\n");
    return { changed: true };
  }
  if (!existing.includes(startMarker)) {
    const content = `${existing.trimEnd()}\n\n${block}\n`;
    const backup = backupFile(filePath);
    writeTextFile(filePath, content);
    return { changed: true, backup };
  }
  const re = new RegExp(`${escapeRe(startMarker)}[\\s\\S]*?(?:${escapeRe(endMarker)}|$)`);
  const content = existing.replace(re, block);
  if (content === existing) return noChange();
  const backup = backupFile(filePath);
  writeTextFile(filePath, content);
  return { changed: true, backup };
}

/** Remove the managed block between start/end markers (and one blank line). */
export function removeManagedBlock(
  filePath: string,
  startMarker: string,
  endMarker: string,
): EditResult {
  const existing = readTextFile(filePath);
  if (existing === null || !existing.includes(startMarker)) return noChange();
  const re = new RegExp(
    `\\n?\\s*${escapeRe(startMarker)}[\\s\\S]*?${escapeRe(endMarker)}\\n?`,
  );
  const content = existing.replace(re, "");
  if (content === existing) return noChange();
  const backup = backupFile(filePath);
  writeTextFile(filePath, content);
  return { changed: true, backup };
}

// ---------------------------------------------------------------- TOML section

const SECTION_RE = /^\s*\[/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Insert/replace a `[section]` block in a TOML file (idempotent). */
export function upsertTomlSection(
  tomlPath: string,
  sectionName: string,
  block: string,
): EditResult {
  const existing = readTextFile(tomlPath);
  if (existing === null) {
    writeTextFile(tomlPath, block + "\n");
    return { changed: true };
  }
  const re = new RegExp(`^\\s*\\[\\s*${escapeRe(sectionName)}\\s*\\]`, "m");
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx >= 0) {
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++) {
      if (SECTION_RE.test(lines[i])) {
        end = i;
        break;
      }
    }
    const head = lines.slice(0, idx).join("\n").trimEnd();
    const tail = lines.slice(end).join("\n");
    const content = `${head}${head ? "\n\n" : ""}${block}${tail ? "\n" + tail : ""}`;
    if (content === existing) return noChange();
    const backup = backupFile(tomlPath);
    writeTextFile(tomlPath, content);
    return { changed: true, backup };
  }
  const content = `${existing.trimEnd()}\n\n${block}`;
  const backup = backupFile(tomlPath);
  writeTextFile(tomlPath, content);
  return { changed: true, backup };
}

/** Remove only the matching `[section]` block; keep everything else. */
export function removeTomlSection(
  tomlPath: string,
  sectionName: string,
): EditResult {
  const existing = readTextFile(tomlPath);
  if (existing === null) return noChange();
  const re = new RegExp(`^\\s*\\[\\s*${escapeRe(sectionName)}\\s*\\]`, "m");
  const lines = existing.split(/\r?\n/);
  const idx = lines.findIndex((l) => re.test(l));
  if (idx < 0) return noChange();
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (SECTION_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, idx).join("\n").trimEnd();
  const tail = lines.slice(end).join("\n").trim();
  let content: string;
  if (head && tail) content = `${head}\n\n${tail}\n`;
  else if (head) content = `${head}\n`;
  else if (tail) content = `${tail}\n`;
  else content = "";
  if (content.trim() === existing.trim()) return noChange();
  const backup = backupFile(tomlPath);
  writeTextFile(tomlPath, content);
  return { changed: true, backup };
}

// ---------------------------------------------------------------- templates

/** A template body with {{placeholder}} tokens; `apply` fills them. */
export function fillTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
}
