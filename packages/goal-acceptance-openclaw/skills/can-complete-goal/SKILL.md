---
name: can-complete-goal
description: Check whether the goal can be completed based on current acceptance criteria.
---

Before concluding a goal, call this skill to verify that all **required**
acceptance criteria are `passed`. The check returns `{ allowed: boolean,
reason?: string }`:

- **allowed: true** — all required criteria passed (or no criteria locked).
- **allowed: false** — one or more required criteria are still pending,
  in_progress, failed, blocked, or not_run. The `reason` field lists how many
  are unresolved.

Do not declare the goal complete until this check returns `allowed: true`.
