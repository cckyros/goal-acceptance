---
name: confirm-criterion
description: Independent reviewer confirms a self-claimed passed criterion with fresh evidence. Must be called by a different agent than the one that did the work.
---

# Confirm Criterion Skill

Use `confirm_criterion` only from an independent reviewer agent. The reviewer
must re-run the command or re-check the file/URL and provide fresh evidence.

- `method=command`: re-run the exact command and include stdout/stderr and exit code.
- `method=file`: read the file and include the relevant lines.
- `method=url`: make the request and include the status and response body.

Do not copy the original agent's evidence. `text` evidence is not accepted.
If re-verification fails, record a failed validation instead of confirming.
