---
name: goal-planning
description: Spawn a planning subagent to decompose a task into non-overlapping, fully-covering acceptance criteria before any implementation work begins.
---

# Goal Planning Skill

When a user gives a multi-step task (implement, fix, refactor, etc.), do NOT
call `set_acceptance_criteria` directly. Instead, spawn a planning subagent
that explores the codebase, drafts criteria, and checks coverage before
locking.

## When to Use

- User says "implement X", "fix Y and verify", "refactor Z" — any task with
  a verifiable outcome.
- Single-line answers, file reads, explanations: skip this skill.

## Workflow

### Step 1: Spawn Planning Subagent

Use `run_subagent` (or equivalent) with `subagent_explore` profile and this
prompt template:

```
You are a planning agent. Your job: decompose the task below into
acceptance criteria that are non-overlapping, fully covering, and
individually verifiable.

TASK: {paste the user's original request here}

Do NOT implement anything. Do NOT write code. Only plan.

Phase 1 — EXPLORE:
- Read the relevant source files, configs, and tests.
- Identify every module, function, and interface the task touches.
- Note existing patterns and conventions.

Phase 2 — DRAFT CRITERIA:
- Write acceptance criteria. Each criterion MUST have:
  - id: kebab-case, unique (e.g. "core-default-role-agent")
  - description: specific and concrete, not vague
  - required: true if the goal cannot be achieved without it
  - method: one of "command" | "file" | "url" (NEVER "text")
  - task_ids: linked task IDs for progress tracking

Phase 3 — GOAL-BACKWARD COVERAGE CHECK:
- List every requirement implied by the task description.
- Map each requirement to the criterion(s) that cover it.
- If any requirement is UNCOVERED, add a criterion for it.
- If two criteria overlap (>80% similar description), merge them.

Phase 4 — VAGUE-VERB CHECK:
- Scan every criterion description for vague verbs:
  "implement", "ensure", "handle", "improve", "align", "clean up"
- Replace each with a concrete, verifiable action:
  BAD:  "implement error handling"
  GOOD: "wrap fetchUser in try/catch, return 404 for NotFound"
  BAD:  "improve performance"
  GOOD: "add index on orders.user_id, batch N+1 into JOIN"

Phase 5 — VERIFICATION CHECK:
- Every criterion's method must specify:
  - command: the exact command to run (e.g. "pnpm test")
  - file: the exact file path to check (e.g. "src/engine.ts")
  - url: the exact URL to verify (e.g. "GET /health returns 200")
- "run tests" is NOT sufficient. Specify expected outcome.
- "check it works" is NOT sufficient. Specify observable behavior.

Phase 6 — SUBMIT:
- Call set_acceptance_criteria with the final criteria list.
- Call set_task_plan with the task decomposition.
- Return a summary of the coverage matrix.
```

### Step 2: Review Subagent Output

After the subagent returns, check:
- Did it call `set_acceptance_criteria`? If not, the criteria are not locked.
- Did it call `set_task_plan`? If not, task tracking is missing.
- Read the coverage matrix. Any UNCOVERED requirement is a gap.

If gaps or overlaps are found, spawn the subagent again with feedback:
```
The coverage matrix has gaps: {list uncovered requirements}.
The following criteria overlap: {list pairs}.
Revise and re-submit.
```

### Step 3: Proceed to Implementation

Only after criteria are locked and the coverage matrix has no UNCOVERED
requirements, proceed to implementation.

## Coverage Matrix Format

The subagent should produce this matrix in Phase 3:

```
| # | Requirement (from task) | Covered By | Status |
|---|-------------------------|------------|--------|
| R1 | Add confirm_criterion tool | confirm-criterion-mcp | COVERED |
| R2 | Block self-claimed completion | gate-blocks-selfclaimed | COVERED |
| R3 | Update README | (none) | UNCOVERED |
```

Any UNCOVERED row must be resolved before proceeding.

## Vague Verb Reference

| Vague (reject) | Concrete (accept) |
|----------------|-------------------|
| "implement feature" | "add handler to router with X signature" |
| "ensure error handling" | "wrap fetchUser in try/catch, return 404" |
| "handle edge cases" | "add nil-check for user.Profile before Avatar" |
| "improve performance" | "add index on orders.user_id, batch N+1 into JOIN" |
| "clean up" | "extract validation into validateInput() function" |
| "update docs" | "add confirm_criterion to README tool table" |

## Scope Sanity

| Criterion Count | Verdict | Rationale |
|----------------|---------|-----------|
| 1-2 | Too few | Likely missing requirements; re-check coverage |
| 3-7 | Good | Right-sized for focused execution |
| 8+ | Split | Too many for one goal; split into sub-goals |
