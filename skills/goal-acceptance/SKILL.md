---
# @cckyros/goal-acceptance:skill
name: goal-acceptance
description: Acceptance-criteria-driven goal completion for the goal-acceptance plugin — lock criteria before implementing, track task status, validate with real evidence, and confirm by an independent reviewer. Trigger words: @cckyros/goal-acceptance, acceptance criteria, goal acceptance, goal planning
allowed-tools: Bash Read
---

# goal-acceptance — goal acceptance skill

This plugin ships 13 MCP/agent tools that drive acceptance-criteria-based
goal completion: you lock criteria before implementing, track task progress,
validate each criterion with real evidence, and block completion until an
independent reviewer confirms the work.

## When to use

- the user gives a multi-step task (implement / fix / refactor) with a
  verifiable outcome — start with the `goal-planning` companion skill
- the task requires criteria to be set, updated, validated, or confirmed
- a goal needs a task plan, task status tracking, or a completion check

## Workflow

1. **Plan** — spawn a planning subagent (see `goal-planning` skill) and
   lock criteria via `set_acceptance_criteria` BEFORE writing code.
2. **Decompose** — set the task plan with `set_task_plan`; update status
   with `update_task_status` as work proceeds.
3. **Validate** — after each task, run the real verification and record it
   with `validate_criterion` (evidence from actual execution, never memory).
4. **Confirm** — have an independent reviewer agent re-verify self-claimed
   passes with `confirm_criterion` (fresh evidence, high-confidence type).
5. **Complete** — only when `can_complete_goal` returns `allowed: true`.

## Companion skills

Eight per-tool companion skills ship with the plugin and activate on demand:

- `goal-planning` — decompose a task into coverage-complete criteria first
- `set-acceptance-criteria` — lock criteria (criterion quality rules)
- `amend-acceptance-criteria` — append criteria when requirements expand
- `get-acceptance-criteria` — read current criteria and progress
- `update-task-status` — track task status linked to criteria
- `validate-criterion` — record status + evidence from real execution
- `confirm-criterion` — independent reviewer confirmation (fresh evidence)
- `can-complete-goal` — completion gate; self-claimed passes block

## Config

- `pluginData` (env `PLUGIN_DATA`) — data directory; goals live in
  `<pluginData>/goals/`. Empty means in-memory mode.
- `autoSteerUncompleted` (dsh only, default true) — steer the agent back to
  uncompleted goals at turn end.
- `maxSteeringTurns` (dsh only, default 5) — steering budget per session.

Set values with `npx @cckyros/goal-acceptance config set <key> <value>` (project) or with
the `--global` flag. Env vars override file values.
