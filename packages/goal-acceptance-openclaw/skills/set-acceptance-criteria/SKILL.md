---
name: set-acceptance-criteria
description: Set and lock the acceptance criteria before starting autonomous work.
---

Before implementing, invoke this skill to lock the goal's acceptance criteria.
Criteria must be observable, have a unique id, and declare whether they are
required for completion. Once locked, they cannot be modified for the current
goal.

Example criteria:

- id: api-200
  description: Health endpoint returns HTTP 200
  required: true
  method: test
- id: docs
  description: README is updated with new usage
  required: false
  method: manual
