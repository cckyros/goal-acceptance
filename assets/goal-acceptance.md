---
description: Run the demo plugin's health check
argument-hint: ""
$ARGUMENTS:
  type: object
  properties: {}
---

<!-- {{name}}:command -->

Run the plugin's doctor command and report the result:

```bash
npx {{name}} doctor
```

Report: whether the plugin's config is complete and every doctor check
passes. If a check fails, quote the failure lines and suggest the fix.
