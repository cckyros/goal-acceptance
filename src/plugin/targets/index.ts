// Target adapter registry: every agent the installer knows how to configure.
// Add a new target by writing a TargetAdapter and listing it here — the
// framework (wizard menus, install/uninstall dispatch, help text) picks it
// up automatically. 22 targets in the full template, grouped by kind:
//   native: claude, codex, opencode, qwen, reasonix, kilo, workbuddy, devin
//   skill:  trae, pi, omp, dsh
//   plugin: copilot, cursor, kiro, openclaw, hermes, vscode,
//           chatgpt-codex, grok, nanoclaw, other
// (native 8 populated in phase B; skill 4 and plugin 10 follow.)
import type { TargetAdapter } from "../../framework/registry.ts";
import { claudeAdapter } from "./native-claude.ts";
import { codexAdapter } from "./native-codex.ts";
import { opencodeAdapter } from "./native-opencode.ts";
import {
  devinAdapter,
  kiloAdapter,
  qwenAdapter,
  reasonixAdapter,
  workbuddyAdapter,
} from "./native-cliagents.ts";
import { dshAdapter, ompAdapter, piAdapter, traeAdapter } from "./skill-agents.ts";
import {
  chatgptCodexAdapter,
  copilotAdapter,
  cursorAdapter,
  grokAdapter,
  hermesAdapter,
  kiroAdapter,
  nanoclawAdapter,
  openclawAdapter,
  otherAdapter,
  vscodeAdapter,
} from "./plugin-agents.ts";

export const adapters: TargetAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  qwenAdapter,
  reasonixAdapter,
  kiloAdapter,
  workbuddyAdapter,
  devinAdapter,
  traeAdapter,
  piAdapter,
  ompAdapter,
  dshAdapter,
  copilotAdapter,
  cursorAdapter,
  kiroAdapter,
  openclawAdapter,
  hermesAdapter,
  vscodeAdapter,
  chatgptCodexAdapter,
  grokAdapter,
  nanoclawAdapter,
  otherAdapter,
];
