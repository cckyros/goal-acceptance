---
name: validate-criterion
description: Record status and evidence for one acceptance criterion.
---

After executing work, call this skill to validate each acceptance criterion.
Statuses `passed` and `failed` require concrete evidence (command output, test
result, or inspection detail). Use `blocked` when the criterion cannot be
verified in the current environment. Use `not_run` when explicitly skipping a
non-required criterion.

Example:

- criterion_id: api-200
  status: passed
  evidence: GET /health returned 200 OK
