---
name: amend-acceptance-criteria
description: Append new acceptance criteria after the initial lock.
---

When requirements expand during execution, call this skill to add new criteria.
Existing criteria are **not modified** — only new ones are appended. A
human-readable reason is required to record why the amendment was made.

Amended criteria are marked with `addedAfterLock: true` in the returned
criteria list.

Example:

- criteria:
  - id: perf-check
    description: Response time under 200ms
    required: true
    method: test
- reason: Performance requirement added after initial scope discussion
