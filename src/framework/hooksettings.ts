// Managed hook-entry helpers for Claude-schema settings.json files (Claude
// Code's .claude/settings.json and the same schema used by Qwen Code and
// Reasonix). Ported from deepseek-vl-support (behavior unchanged):
//  - entries are matched by the manifest's hookCommand marker inside the
//    command string, so a foreign entry with the same event shape is never
//    touched
//  - PreToolUse entries are keyed with matcher "Read"; other events get a
//    plain `hooks` array (used for SessionStart)
import { readTextFile } from "./safe-fs.ts";

export interface SettingsFile {
  file: string;
  data: Record<string, unknown>;
}

/** True when the given hooks array already contains one of OUR entries. */
export function hasOurHookEntry(entries: unknown[], ident: string): boolean {
  return entries.some((e) =>
    Array.isArray((e as { hooks?: unknown[] })?.hooks) &&
    (e as { hooks: unknown[] }).hooks.some(
      (h) =>
        typeof (h as { command?: unknown })?.command === "string" &&
        ((h as { command: string }).command as string).includes(ident),
    ),
  );
}

/** Add our hook entry for `event` if it is not already present. PreToolUse
 *  entries carry matcher "Read"; other events carry only the `hooks` array. */
export function hookEntriesAdded(
  settings: SettingsFile,
  event: string,
  command: string,
  startCommand: string,
  ident: string,
): boolean {
  const hooks = (settings.data.hooks as Record<string, unknown[]> | undefined) ?? {};
  const arr = (hooks[event] as unknown[] | undefined) ?? [];
  if (hasOurHookEntry(arr, ident)) return false;
  arr.push(
    event === "PreToolUse"
      ? { matcher: "Read", hooks: [{ type: "command", command, timeout: 60 }] }
      : { hooks: [{ type: "command", command: startCommand, timeout: 30 }] },
  );
  hooks[event] = arr;
  settings.data.hooks = hooks;
  return true;
}

/** Remove every entry whose hooks array contains one of our commands;
 *  returns how many entries were removed. Empty event arrays and the empty
 *  `hooks` container are dropped. */
export function hookEntriesRemoved(settings: SettingsFile, ident: string): number {
  const hooks = settings.data.hooks as Record<string, unknown[] | undefined> | undefined;
  if (!hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const arr = (hooks[event] as unknown[] | undefined) ?? [];
    const kept = arr.filter((e) => {
      const cmds = ((e as { hooks?: unknown[] })?.hooks ?? []) as unknown[];
      const isOurs = cmds.some(
        (h) =>
          typeof (h as { command?: unknown })?.command === "string" &&
          ((h as { command: string }).command as string).includes(ident),
      );
      if (isOurs) removed++;
      return !isOurs;
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (removed === 0) return 0;
  if (Object.keys(hooks).length === 0) delete settings.data.hooks;
  return removed;
}

/** Read a settings.json into a SettingsFile; null when missing; throws when
 *  the file exists but is not valid JSON (refuse to modify). */
export function readSettings(file: string): SettingsFile | null {
  const raw = readTextFile(file);
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || Array.isArray(data)) return null;
    return { file, data };
  } catch {
    throw new Error(`settings.json is not valid JSON; refusing to modify: ${file}`);
  }
}
