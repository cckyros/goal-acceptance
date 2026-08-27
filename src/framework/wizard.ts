// Numbered-menu wizard built on node:readline/promises (zero dependencies).
// Every step has a default, Enter accepts the default, and every step is
// skippable. Non-interactive installs never call these.
// (Directly carried over from deepseek-vl-support's wizard — zero business
// coupling; prompts are supplied by callers.)
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface MenuOption {
  value: string;
  label: string;
}

export interface MenuSpec {
  prompt: string;
  options: MenuOption[];
  default?: string;
}

export interface InputSpec {
  prompt: string;
  default?: string;
  hint?: string;
}

function makeRl() {
  return createInterface({ input, output });
}

/** Render a numbered single-select menu. The default is conveyed by the
 *  `[value]` hint in the prompt line only — no per-option "(default)"
 *  markers (options show pure labels). Exported for tests. */
export function formatMenu(spec: MenuSpec): string {
  const lines = [spec.prompt];
  spec.options.forEach((opt, i) => {
    lines.push(`  ${i + 1}) ${opt.label}`);
  });
  const def = spec.default ? ` [${spec.default}]` : "";
  lines.push(`> Select (1-${spec.options.length}${def}): `);
  return lines.join("\n");
}

/** Ask a numbered-menu question; returns the chosen option value. */
export async function askMenu(spec: MenuSpec): Promise<string> {
  const rl = makeRl();
  try {
    for (;;) {
      const answer = (await rl.question(formatMenu(spec))).trim();
      if (answer === "" && spec.default !== undefined) return spec.default;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= spec.options.length) {
        return spec.options[n - 1].value;
      }
      output.write(`Invalid choice, please select again.\n`);
    }
  } finally {
    rl.close();
  }
}

export interface MultiMenuSpec {
  prompt: string;
  options: MenuOption[];
  default?: string[];
}

/** Render a numbered multi-select. The default is conveyed by the
 *  "Enter=default" hint only — no per-option "(default)" markers.
 *  Exported for tests. */
export function formatMultiMenu(spec: MultiMenuSpec): string {
  const lines = [spec.prompt];
  spec.options.forEach((opt, i) => {
    lines.push(`  ${i + 1}) ${opt.label}`);
  });
  lines.push(`> Select (comma-separated numbers${spec.default?.length ? ", Enter=default" : ""}): `);
  return lines.join("\n");
}

/** Ask a numbered multi-select. Accepts comma/space-separated numbers or
 *  "all"; Enter returns the default selection. */
export async function askMultiMenu(spec: MultiMenuSpec): Promise<string[]> {
  const rl = makeRl();
  try {
    for (;;) {
      const answer = (await rl.question(formatMultiMenu(spec))).trim().toLowerCase();
      if (answer === "" && spec.default !== undefined && spec.default.length) return [...spec.default];
      if (answer === "all") return spec.options.map((o) => o.value);
      const picks = answer
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number);
      if (
        picks.length > 0 &&
        picks.every((n) => Number.isInteger(n) && n >= 1 && n <= spec.options.length)
      ) {
        return picks.map((n) => spec.options[n - 1].value);
      }
      output.write(`Invalid choice, please select again.\n`);
    }
  } finally {
    rl.close();
  }
}

/** Ask a free-text question; Enter returns the default. */
export async function askInput(spec: InputSpec): Promise<string> {
  const rl = makeRl();
  try {
    const hint = spec.hint ? ` (${spec.hint})` : "";
    const def = spec.default !== undefined ? ` [${spec.default}]` : "";
    const answer = (await rl.question(`${spec.prompt}${hint}${def}: `)).trim();
    return answer === "" ? (spec.default ?? "") : answer;
  } finally {
    rl.close();
  }
}

/** Ask a hidden (masked) input. Falls back to plain input on non-TTY. */
export async function askSecret(spec: InputSpec): Promise<string> {
  if (!input.isTTY || !output.isTTY) return askInput(spec);
  const def = spec.default !== undefined ? ` [Enter=default]` : ` [Enter=skip]`;
  output.write(`${spec.prompt}${def}: `);
  return new Promise<string>((resolve) => {
    const stdin = input;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          output.write("\n");
          cleanup();
          stdin.off("data", onData);
          resolve(value === "" ? (spec.default ?? "") : value);
          return;
        }
        if (ch === "") {
          // Ctrl+C: cancel → treat as skip
          output.write("^C\n");
          cleanup();
          stdin.off("data", onData);
          resolve("");
          return;
        }
        if (ch === "" || ch === "\b") {
          if (value.length) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += ch;
        output.write("*");
      }
    };
    stdin.on("data", onData);
  });
}
