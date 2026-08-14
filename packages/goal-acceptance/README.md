# @deepseek-ai/dsh-goal-acceptance

English | [中文](README.zh.md)

Model-provider-neutral goal acceptance criteria and validation enforcement plugin for the DeepSeek Harness (`goal-acceptance`).

This plugin manages immutable acceptance criteria per Goal session, provides model-facing tools (`set_acceptance_criteria`, `validate_criterion`, `get_acceptance_criteria`), and intercepts `agent/turn-stopping` to steer uncompleted work or report a final structured summary.

It is a thin Cordis wrapper over [`@deepseek-ai/dsh-goal-acceptance-core`](../goal-acceptance-core), which is a framework-agnostic npm package that can also be used in OpenClaw, Cursor, Claude Code, or other agent runtimes.

For the portable Agent Plugin and MCP packaging, see [`@deepseek-ai/dsh-goal-acceptance-mcp`](../goal-acceptance-mcp).

## Plugin

`apply(ctx)` provides `ctx.goalAcceptance` and registers model-facing tools and prompts.

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
