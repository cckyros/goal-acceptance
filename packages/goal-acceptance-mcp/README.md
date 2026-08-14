# @deepseek-ai/dsh-goal-acceptance-mcp

MCP server and [Agent Plugins](https://agent-plugins.org) packaging for
`dsh-goal-acceptance-core`.

This package is three things at once:

1. **ESM library** (`lib/index.js`) — programmatic `createMcpServer()`.
2. **MCP server** (`bin/mcp-server.mjs`) — stdio server for any MCP-capable client.
3. **Agent Plugin** (`plugin.json` + `mcp.json` + `skills/`) — loadable by
   OpenClaw, Claude Code, Cursor, and any conformant Agent Plugins client.

## Usage as an Agent Plugin

Install the package, then point an Agent-Plugins-capable client at the package
root:

```text
node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/
├── plugin.json
├── mcp.json
└── skills/
```

The client will:

- Load `plugin.json`.
- Discover the `skills/*`.
- Start the stdio MCP server defined in `mcp.json`.
- Surface the tools `set_acceptance_criteria`, `get_acceptance_criteria`,
  `validate_criterion`, and `can_complete_goal`.

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

- `set_acceptance_criteria` — lock the criteria list.
- `get_acceptance_criteria` — read current criteria and summary.
- `validate_criterion` — record status and evidence.
- `can_complete_goal` — check whether all required criteria passed.

## DeepSeek Harness

For DeepSeek Harness use the Cordis plugin
`@deepseek-ai/dsh-goal-acceptance` instead.
