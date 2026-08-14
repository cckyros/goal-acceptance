# @cckyros/goal-acceptance-mcp

MCP server and [Agent Plugins](https://agent-plugins.org) packaging for
`@cckyros/goal-acceptance-core`.

This package is three things at once:

1. **ESM library** (`lib/index.js`) �?programmatic `createMcpServer()`.
2. **MCP server** (`bin/mcp-server.mjs`) �?stdio server for any MCP-capable client.
3. **Agent Plugin** (`plugin.json` + `mcp.json` + `skills/`) �?loadable by
   OpenClaw, Claude Code, Cursor, and any conformant Agent Plugins client.

## Usage as an Agent Plugin

Install the package, then point an Agent-Plugins-capable client at the package
root:

```text
node_modules/@cckyros/goal-acceptance-mcp/
├── plugin.json
├── mcp.json
└── skills/
```

The client will:

- Load `plugin.json`.
- Discover the `skills/*`.
- Start the stdio MCP server defined in `mcp.json`.
- Surface the tools `set_acceptance_criteria`, `get_acceptance_criteria`,
  `set_task_plan`, `get_task_plan`, `validate_criterion`, `update_task_status`,
  `amend_acceptance_criteria`, and `can_complete_goal`.

## Usage as a standalone MCP server

```sh
node ./bin/mcp-server.mjs
```

For persistence across restarts, set `PLUGIN_DATA`:

```sh
PLUGIN_DATA=/path/to/data node ./bin/mcp-server.mjs
```

The server writes `acceptance-events.json` under `$PLUGIN_DATA`.

## Tools

- `set_acceptance_criteria` �?lock the criteria list. Optional `role` parameter (`agent`/`reviewer`/`dual`).
- `get_acceptance_criteria` �?read current criteria, task progress, task plan, and summary. Optional `verbose` (default `true`).
- `set_task_plan` �?set and lock the task decomposition plan. Each task needs id, description, deliverable. Dependency cycles rejected.
- `get_task_plan` �?read the task decomposition plan with live task statuses.
- `validate_criterion` �?record status and evidence for one criterion. Optional `evidence_type` (`command`/`file`/`url`/`text`). Optional `verbose` (default `false`).
- `update_task_status` �?update a linked task's status. Optional `verbose` (default `false`).
- `amend_acceptance_criteria` �?append new criteria after the initial lock (requires a reason).
- `can_complete_goal` �?check whether all required criteria are formally passed (self-claimed does not count).

## DeepSeek Harness

For DeepSeek Harness use the Cordis plugin
`@cckyros/goal-acceptance` instead.
