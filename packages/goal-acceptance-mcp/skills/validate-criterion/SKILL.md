---
name: validate-criterion
description: Record status and evidence for one acceptance criterion. Evidence must come from actual execution, not from memory or assumption.
---

After executing work, call this to validate each acceptance criterion.
Statuses `passed` and `failed` require concrete evidence from actual
execution.

## Evidence Requirements

**You MUST run the actual command or check before validating.** Do NOT
validate based on memory, assumption, or "it should work".

| method | What to do | Evidence to provide |
|--------|-----------|---------------------|
| `command` | Run the exact command in a shell | Paste the real stdout/stderr + exit code |
| `file` | Read the file and check the content | Paste the relevant lines from the file |
| `url` | Make the HTTP request | Paste the response status + body |

## What NOT to do

- ❌ Validate `passed` without running anything
- ❌ Write "should work" or "looks correct" as evidence
- ❌ Copy evidence from a previous run without re-running
- ❌ Use `evidence_type=text` for a criterion with `method=command`
- ❌ Validate before implementation is actually complete

## Self-Claimed Status

When `role=agent` (default), `passed` criteria are marked `selfClaimed=true`.
This means `can_complete_goal` will block until an independent reviewer
calls `confirm_criterion` with fresh evidence.

This is by design — your self-assessment is not trusted for completion.
Use `confirm_criterion` (as a separate reviewer agent) to convert
self-claimed passes to formal passes.

## Example

```json
{
  "criterion_id": "api-200",
  "status": "passed",
  "evidence": "curl -s localhost:3000/health → 200 {\"status\":\"ok\"}",
  "evidence_type": "command"
}
```

```json
{
  "criterion_id": "api-500",
  "status": "failed",
  "evidence": "curl -s localhost:3000/users → 500 Internal Server Error: TypeError: Cannot read property 'name' of undefined",
  "evidence_type": "command"
}
```
