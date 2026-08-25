---
name: can-complete-goal
description: Check whether the goal can be completed based on current acceptance criteria. Blocks on self-claimed required criteria.
---

Before concluding a goal, call this to verify that all **required**
acceptance criteria are formally passed. Returns `{ allowed, reason? }`:

- **allowed: true** — all required criteria are formally passed
- **allowed: false** — one or more required criteria are unresolved or
  self-claimed

## Blocking Conditions

| Criterion State | Blocks completion? |
|----------------|-------------------|
| `passed` + `selfClaimed=false` | No — formal pass |
| `passed` + `selfClaimed=true` | **Yes** — needs `confirm_criterion` |
| `failed` | Yes |
| `blocked` | Yes |
| `pending` | Yes |
| `in_progress` | Yes |
| `not_run` | Yes (required only) |

## Self-Claimed Blocking

When `role=agent` (default), `validate_criterion` with `passed` marks the
criterion as `selfClaimed=true`. The completion gate treats self-claimed
required criteria as unresolved — they must be confirmed by an independent
reviewer via `confirm_criterion` before the goal can complete.

This prevents the agent from declaring "done" based on its own
self-assessment without independent verification.

## Do Not Declare Complete

Do not tell the user the task is complete until this check returns
`allowed: true`. If it returns `allowed: false`, read the `reason` field
and address each blocking criterion.
