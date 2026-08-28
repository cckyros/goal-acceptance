The {{brand}} plugin gives this project an MCP server (`{{name}} mcp`) with
acceptance-criteria-driven workflow tools.

### When starting a multi-step coding or bugfix task:
- **DO NOT** edit code immediately.
- **DO** call `quick_start_goal` or `set_acceptance_criteria` to lock verifiable criteria first.
- **DO** run tests/commands and use `run_and_validate` to capture real execution evidence.

```json
// Good Example: Initialize goal before implementation
quick_start_goal({
  "title": "Fix login timeout",
  "criteria": [
    { "id": "unit-tests", "description": "pnpm test passes login suite", "required": true, "method": "command" }
  ]
})
```
Check configuration with `npx {{name}} config get` and run `npx {{name}} doctor`
when something is not working.

