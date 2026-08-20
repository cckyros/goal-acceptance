# @cckyros/goal-acceptance

English

Model-provider-neutral goal acceptance criteria and validation enforcement plugin for the DeepSeek Harness (`goal-acceptance`).

This plugin manages immutable acceptance criteria per Goal session, provides the same 13 model-facing tools as the MCP adapter, and intercepts `agent/turn-stopping` to steer uncompleted work or request independent reviewer confirmation.

It is a thin Cordis wrapper over [`@cckyros/goal-acceptance-core`](../goal-acceptance-core), which is a framework-agnostic npm package that can also be used in OpenClaw, Cursor, Claude Code, or other agent runtimes.

For the portable Agent Plugin and MCP packaging, see [`@cckyros/goal-acceptance-mcp`](../goal-acceptance-mcp).

## Plugin

`apply(ctx)` provides `ctx.goalAcceptance`, registers the 13 MCP-compatible tools,
and adds the `policy:goal-acceptance` prompt section plus dependency-aware
`agent/turn-stopping` steering. The default `role=agent` marks passed criteria as
self-claimed until an independent reviewer calls `confirm_criterion`.

## Model Experience

### Criteria Confirmation

#### What the model sees
A structured list of required criteria, verification methods, and capability limitations before autonomous execution begins.

#### Token effect
Criteria stay in the session log and model context until the Goal concludes.

#### KV Cache effect
Append-only; new criterion validations follow the session event stream.

## Known Limitations and Deferred Work

- Interactive criteria modification after confirmation is deferred; subsequent modifications start a new Goal session.
