# goal-acceptance

[English](README.md) | 中文

面向自主 AI Agent 的验收标准驱动式目标完成机制。

在 Agent 开始工作前锁定不可变验收标准，执行过程中跟踪带证据的验证状态，
并在目标完成前强制检查——防止 Agent 过早宣布"做完了"。

## 为什么需要？

自主 Agent（Claude Code、Cursor、OpenClaw、DeepSeek Harness 等）经常提前停止——
它们说"我完成了"却没有真正验证工作成果。本项目提供：

1. **框架无关的状态机**：锁定标准、跟踪证据、门控完成。
2. **MCP server**：任何 MCP 客户端都可以调用。
3. **Agent Plugin 包**：符合 [Agent Plugins](https://agent-plugins.org) 标准。
4. **Cordis 插件**：DeepSeek Harness 专用，带 turn-stopping 强制拦截。

## 包结构

| 包 | 描述 | 依赖 |
|----|------|------|
| [`@deepseek-ai/dsh-goal-acceptance-core`](packages/goal-acceptance-core) | 框架无关状态机、类型、错误码、抽象 store | 无 |
| [`@deepseek-ai/dsh-goal-acceptance-mcp`](packages/goal-acceptance-mcp) | MCP stdio server + Agent Plugin 打包（plugin.json、mcp.json、skills） | core、MCP SDK |
| [`@deepseek-ai/dsh-goal-acceptance`](packages/goal-acceptance) | DeepSeek Harness Cordis 插件，带 turn-stopping 强制 steering | core、Cordis、Harness |

## 架构

```
                    ┌─────────────────────────────────────────────────┐
                    │  @deepseek-ai/dsh-goal-acceptance-core           │
                    │  (零依赖状态机，事件溯源)                         │
                    └────────────┬──────────────────┬──────────────────┘
                                 │                  │
                    ┌────────────┴────────┐ ┌──────┴───────────────────┐
                    │ dsh-goal-acceptance │ │ dsh-goal-acceptance-mcp  │
                    │ (Cordis 插件)        │ │ (MCP server + Agent      │
                    │                     │ │  Plugin 打包)             │
                    │ • turn-stopping     │ │ • stdio MCP server       │
                    │ • agent.steer()     │ │ • plugin.json + mcp.json │
                    │ • 系统提示词         │ │ • skills/ (Agent Skills) │
                    │ • 工具注册           │ │ • FileAcceptanceStore    │
                    └─────────────────────┘ └──────────────────────────┘
```

## 快速开始

### 核心库（任何 JS/TS 运行时）

```sh
npm install @deepseek-ai/dsh-goal-acceptance-core
```

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@deepseek-ai/dsh-goal-acceptance-core'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

// 工作开始前锁定验收标准
await engine.setCriteria([
  { id: 'api-200', description: 'GET /health 返回 200', required: true, method: 'test' },
  { id: 'docs', description: 'README 已更新', required: false, method: 'manual' },
])

// 记录验证结果和证据
await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health → HTTP 200 OK',
})

// 检查目标是否可以完成
const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
// → true, undefined
```

### MCP server（OpenClaw、Claude Code、Cursor 等）

```sh
npm install @deepseek-ai/dsh-goal-acceptance-mcp
```

在你的 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "type": "stdio",
      "command": "node",
      "args": ["./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs"]
    }
  }
}
```

或直接运行：

```sh
# 内存模式（重启后重置）
node ./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs

# 持久化模式（跨重启保留）
PLUGIN_DATA=/path/to/data node ./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs
```

### Agent Plugin（可移植格式）

MCP 包同时也是符合 [Agent Plugins](https://agent-plugins.org) 标准的插件包。
将任何支持 Agent Plugins 的客户端指向包根目录即可：

```
node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/
├── plugin.json    # Agent Plugin 清单
├── mcp.json       # stdio MCP server 配置
└── skills/        # 可移植 Agent Skills
    ├── set-acceptance-criteria/SKILL.md
    ├── validate-criterion/SKILL.md
    └── get-acceptance-criteria/SKILL.md
```

客户端会自动发现 skills、启动 stdio MCP server、暴露工具。

### DeepSeek Harness（Cordis 插件）

```sh
npm install @deepseek-ai/dsh-goal-acceptance
```

```yaml
# cordis.yml
plugins:
  goal-acceptance:
    autoSteerUncompleted: true
    maxSteeringTurns: 5
```

插件功能：
- 注册 3 个模型工具（`set/get/validate_acceptance_criteria`）
- 注入 `policy:goal-acceptance` 系统提示词
- 拦截 `agent/turn-stopping`，当 required 标准未完成时 steer Agent 继续

## MCP 工具

| 工具 | 描述 |
|------|------|
| `set_acceptance_criteria` | 锁定标准列表。必须在实现前调用。 |
| `get_acceptance_criteria` | 读取当前标准和汇总。 |
| `validate_criterion` | 记录状态（`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`）和证据。`passed` 和 `failed` 需要证据。 |
| `can_complete_goal` | 检查所有 required 标准是否通过。 |

## 标准状态生命周期

```
                    ┌──────────┐
                    │ pending  │ ← setCriteria 后的初始状态
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
              ▼          ▼          ▼
        ┌──────────┐ ┌────────┐ ┌────────┐
        │in_progress│ │ passed │ │ failed │
        └──────────┘ └────────┘ └────────┘
              │          │          │
              │          │     ┌────────┐
              │          │     │blocked │
              │          │     └────────┘
              │          │     ┌────────┐
              └──────────┘─────│not_run │
                                └────────┘
```

| 状态 | 含义 | 是否需要证据 |
|------|------|:---:|
| `pending` | 尚未开始 | 否 |
| `in_progress` | 正在进行 | 否 |
| `passed` | 验证通过 | 是 |
| `failed` | 验证失败 | 是 |
| `blocked` | 当前环境无法验证 | 否 |
| `not_run` | 显式跳过（仅非 required） | 否 |

## 完成门控

`canComplete()` 返回 `{ allowed: boolean, reason?: string }`：

- **允许**：所有 required 标准为 `passed`，或未锁定任何标准。
- **不允许**：任何 required 标准为 `pending`、`in_progress`、`failed`、`blocked` 或 `not_run`。

## 事件溯源

引擎采用事件溯源模式。store 持有只追加的事件列表：

- `goal-acceptance/set` — 锁定标准列表
- `goal-acceptance/validate` — 更新单个标准的状态

每次读取时，引擎从 store 重放事件。这使得：

- 持久化存储（文件、数据库、session log）
- 精确重放的状态恢复
- 所有决策的审计轨迹

### 自定义 Store

为你的持久化后端实现 `GoalAcceptanceStore`：

```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from '@deepseek-ai/dsh-goal-acceptance-core'

class MyDbStore implements GoalAcceptanceStore {
  get events(): readonly GoalAcceptanceEvent[] {
    // 按追加顺序返回所有事件
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // 持久化事件
  }
}
```

## 三方兼容性

| 能力 | Cordis 插件 | MCP server | Agent Plugin |
|------|:---:|:---:|:---:|
| 模型工具 | `set/get/validate` | `set/get/validate/can_complete` | 同 MCP |
| 系统提示词 / Skills | `policy:goal-acceptance` | `skills/` | `skills/` |
| Turn-stopping 强制拦截 | 是（`agent.steer()`） | 否 | 否 |
| 跨客户端可移植 | 否（仅 Harness） | 是（任何 MCP 客户端） | 是（任何 Agent Plugins 客户端） |
| 持久化状态 | `dsh-session` 日志 | `$PLUGIN_DATA/acceptance-events.json` | 同 MCP |

Cordis 插件是唯一能**强制** Agent 在尝试提前停止时继续工作的变体。
MCP 和 Agent Plugin 变体依赖模型自觉调用工具并遵循 skill 指令。

## 仓库布局

```
packages/
├── goal-acceptance-core/       # 零依赖状态机
│   ├── src/
│   │   ├── engine.ts           # GoalAcceptanceEngine
│   │   ├── store.ts            # GoalAcceptanceStore + InMemoryAcceptanceStore
│   │   ├── types.ts            # GoalCriterion、AcceptanceSummary、事件
│   │   ├── errors.ts           # GoalAcceptanceError
│   │   └── index.ts            # 公开导出
│   └── tests/
│       ├── engine.spec.ts      # 11 个测试
│       └── standalone.spec.ts  # 1 个测试
├── goal-acceptance-mcp/        # MCP server + Agent Plugin
│   ├── src/
│   │   ├── mcp-server.ts       # stdio MCP server，4 个工具
│   │   ├── store.ts            # FileAcceptanceStore
│   │   └── index.ts
│   ├── bin/mcp-server.mjs      # 构建后的 stdio 入口
│   ├── plugin.json             # Agent Plugins 清单
│   ├── mcp.json                # MCP server 配置
│   ├── skills/                 # 可移植 Agent Skills
│   └── tests/
│       └── mcp-server.spec.ts  # 3 个测试
└── goal-acceptance/            # DeepSeek Harness Cordis 插件
    ├── src/
    │   ├── index.ts            # apply(): service + tools + prompt + turn-stopping
    │   ├── service.ts          # GoalAcceptanceService（每 Agent 一个引擎）
    │   ├── store.ts            # SessionAcceptanceStore（dsh-session 适配器）
    │   ├── tools.ts            # 3 个模型工具
    │   ├── prompt.ts           # 系统提示词
    │   ├── types.ts            # SessionEventMap 声明
    │   └── invariant.ts        # 运行时不变式
    └── tests/
        ├── service.spec.ts     # 5 个测试
        ├── tools.spec.ts       # 3 个测试
        ├── plugin.spec.ts      # 4 个测试
        └── invariant.spec.ts   # 1 个测试
```

## 构建

```sh
pnpm install
pnpm run build
```

Cordis 插件（`goal-acceptance`）需要 DeepSeek Harness 包作为 peer 依赖。
在没有 Harness workspace 的独立仓库中无法构建。core 和 mcp 包可以独立构建。

## 测试

```sh
pnpm install
pnpm test
```

## 许可证

MIT
