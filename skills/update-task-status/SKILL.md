---
name: update-task-status
description: Update the status of a task linked to one or more acceptance criteria.
---

When the host task system changes, call this skill to keep acceptance criteria
in sync. Each criterion may link to one or more task IDs. When all tasks linked
to a criterion are `completed`, that criterion becomes **ready to validate**.

Statuses:

- `pending` — not yet started
- `in_progress` — actively being worked on
- `completed` — finished successfully
- `failed` — could not be completed

Example:

- task_id: t1
  status: completed
