---
name: confirm-criterion
description: Independent reviewer confirms a self-claimed passed criterion with fresh evidence. Must be called by a different agent than the one that did the work.
---

# Confirm Criterion Skill

This tool converts a self-claimed pass into a formal pass, unblocking
`can_complete_goal`. It MUST be called by an **independent reviewer agent**
— not the agent that performed the work.

## Who Should Call This

- ✅ A subagent spawned specifically to review the work
- ✅ A different agent session that re-verifies independently
- ❌ The same agent that called `validate_criterion` with `passed`

## What to Do

1. Read the criterion description and its original evidence
2. **Independently re-verify** — do NOT trust the original evidence:
   - If `method=command`: re-run the command yourself
   - If `method=file`: read the file yourself and check the content
   - If `method=url`: make the HTTP request yourself
3. If the re-verification passes, call `confirm_criterion` with YOUR fresh
   evidence (not a copy of the original)
4. If the re-verification fails, call `validate_criterion` with `status=failed`
   and your evidence showing the failure

## Evidence Type

Must be high-confidence: `command`, `file`, or `url`. `text` evidence is
rejected — a reviewer saying "looks fine" without re-running is worthless.

## Example

```json
{
  "criterion_id": "api-200",
  "evidence": "reviewer re-ran: curl -s localhost:3000/health → 200 {\"status\":\"ok\"}",
  "evidence_type": "command"
}
```

## Rejection Scenarios

| Scenario | Result |
|----------|--------|
| Criterion is not `passed` | Error: not a self-claimed pass |
| Criterion is already confirmed | Error: not a self-claimed pass |
| `evidence_type=text` | Error: high-confidence evidence required |
| Empty evidence | Error: evidence is required |
