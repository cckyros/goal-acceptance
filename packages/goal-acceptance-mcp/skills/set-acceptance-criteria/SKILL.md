---
name: set-acceptance-criteria
description: Set and lock the acceptance criteria before starting autonomous work. For multi-step tasks, use the goal-planning skill first to spawn a planning subagent.
---

Before implementing, lock the goal's acceptance criteria. Criteria must be
observable, have a unique id, and declare whether they are required for
completion. Once locked, they cannot be modified for the current goal.

## When to Plan First

For any multi-step task (implement, fix, refactor), do NOT write criteria
directly. Instead, use the **goal-planning** skill to spawn a planning
subagent that:

1. Explores the codebase to understand what the task touches
2. Drafts criteria with goal-backward coverage analysis
3. Checks for overlaps and gaps
4. Submits via `set_acceptance_criteria`

This prevents the main agent from writing vague, incomplete, or overlapping
criteria under execution pressure.

## Criterion Quality Rules

Each criterion MUST have:

- **id**: kebab-case, unique (e.g. `api-200`, `core-default-role-agent`)
- **description**: concrete and verifiable, not vague
  - BAD:  `description: "error handling works"`
  - GOOD: `description: "fetchUser returns 404 when user not found"`
- **required**: `true` if the goal cannot be achieved without it
- **method**: one of `command` | `file` | `url` — NEVER `text`
  - `command`: specify the exact command (e.g. `pnpm test`)
  - `file`: specify the exact file path to check
  - `url`: specify the exact URL and expected response
- **task_ids**: linked task IDs for progress tracking

## Role

Default `role=agent`: passed criteria are marked self-claimed, requiring
`confirm_criterion` by an independent reviewer before completion.

Use `role=reviewer` or `role=dual` ONLY when the user explicitly waives
independent review.

## Example

```json
{
  "criteria": [
    {
      "id": "api-200",
      "description": "GET /health returns HTTP 200 with { status: \"ok\" }",
      "required": true,
      "method": "command",
      "task_ids": ["t1"]
    },
    {
      "id": "docs-updated",
      "description": "README.md contains the new /health endpoint in the API table",
      "required": false,
      "method": "file",
      "task_ids": ["t2"]
    }
  ]
}
```
