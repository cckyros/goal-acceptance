# goal-acceptance

[English](README.md) | 中文

面向自主 AI Agent 的验收标准驱动式目标完成机制。

在 Agent 开始工作前锁定不可变验收标准，执行过程中跟踪带证据的验证状态，
并在目标完成前强制检查——防止 Agent 过早宣布"做完了"。

## 优势

### 1. 跨平台兼容

goal-acceptance 兼容**任何**支持 MCP 或 Agent Plugins 的 AI agent 平台。一个包，多个运行时：

| 平台 | 连接方式 | Turn-stopping 强制拦截 |
|------|---------|----------------------|
| **Claude Code** | MCP stdio server | 模型自觉调用工具 |
| **Cursor** | MCP stdio server | 模型自觉调用工具 |
| **OpenClaw** | Agent Plugin (plugin.json + mcp.json + skills) | 模型自觉调用工具 |
| **DeepSeek Harness** | Cordis 插件 (`dsh-goal-acceptance`) | **是** — `agent.steer()` 强制继续 |
| **任何 MCP 客户端** | stdio MCP server | 模型自觉调用工具 |
| **任何 Agent Plugins 客户端** | plugin.json + mcp.json + skills | 模型自觉调用工具 |
| **任何 JS/TS 运行时** | 核心库 (`dsh-goal-acceptance-core`) | 编程式 — 你自己控制 |

核心状态机**零依赖**，可在任何 JS/TS 运行时中运行（Node.js、Bun、Deno、浏览器）。
MCP server 仅增加 MCP SDK。Cordis 插件增加 DeepSeek Harness 集成。按需选择层级。

### 2. MCP server 提供 8 个工具

MCP server 暴露 8 个工具，覆盖完整的 goal-acceptance 生命周期：

- **标准管理**：set、get、amend
- **任务计划管理**：set task plan、get task plan
- **验证**：validate criterion（带类型化证据）
- **进度跟踪**：update task status
- **完成门控**：can complete goal

完整列表见下方 [MCP 工具](#mcp-工具)。

### 3. 双角色验证（防自评）

`set_acceptance_criteria` 接受 `role` 参数（`agent` / `reviewer` / `dual`）。
当 `role=agent` 时，`validate_criterion` 标记 `passed` 为 `selfClaimed=true` —
`can_complete_goal` 会阻止完成，直到 reviewer 正式确认。这打破了 Agent
"既干活又给自己盖合格章"的自评循环。

### 4. 类型化证据

`validate_criterion` 接受 `evidence_type`（`command` / `file` / `url` / `text`）。
`text` 证据标记 `lowConfidence=true`，reviewer 可一眼识别主观声明。
`command` 证据（测试输出、CLI 结果）为高可信。

### 5. 任务分解与依赖校验

`set_task_plan` 将目标分解为原子任务，每个任务带具体交付物。
引擎校验：唯一 ID、无歧义描述、非空交付物、无自依赖、无未知依赖、无依赖环（含间接环）。

### 6. 事件溯源持久化

所有状态变更为只追加事件。引擎每次读取时重放事件，支持持久化存储、
跨重启精确状态恢复、以及完整的决策审计轨迹。

### 7. 默认精简响应

MCP 工具响应默认精简（4 字段摘要）。传 `verbose=true` 获取完整摘要。
正常操作时最小化 token 开销。

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
      "args": ["./node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
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

server 在 `$PLUGIN_DATA` 下写入 `acceptance-events.json`。未设置 `PLUGIN_DATA`
时状态仅在内存中（重启丢失）。

#### 典型工作流

1. **设标准** — `set_acceptance_criteria`，`role=reviewer`（你验证）或 `role=agent`（agent 自评，你后续确认）
2. **设任务计划** — `set_task_plan` 将目标分解为带交付物和依赖的原子任务
3. **执行** — `update_task_status` 跟踪任务进度（`pending` → `in_progress` → `completed`）
4. **验证** — `validate_criterion`，用 `evidence_type=command` 提供高可信证据
5. **检查** — `can_complete_goal` 确认所有 required 标准正式通过

### Agent Plugin（可移植格式）

MCP 包同时也是符合 [Agent Plugins](https://agent-plugins.org) 标准的插件包。
将任何支持 Agent Plugins 的客户端指向包根目录即可：

```
node_modules/@deepseek-ai/dsh-goal-acceptance-mcp/
├── plugin.json    # Agent Plugin 清单
├── mcp.json       # stdio MCP server 配置
└── skills/        # 可移植 Agent Skills
    ├── set-acceptance-criteria/SKILL.md
    ├── get-acceptance-criteria/SKILL.md
    ├── validate-criterion/SKILL.md
    ├── update-task-status/SKILL.md
    ├── amend-acceptance-criteria/SKILL.md
    └── can-complete-goal/SKILL.md
```

客户端会自动发现 skills、启动 stdio MCP server、暴露工具。

### DeepSeek Harness（Cordis 插件）

Cordis 插件是唯一能**强制** Agent 在尝试提前停止时继续工作的变体。
它拦截 `agent/turn-stopping`，按依赖优先级 steer Agent 继续。

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
- 注册 5 个模型工具（`set/get/validate_acceptance_criteria`、`update_task_status`、`amend_acceptance_criteria`）
- 注入 `policy:goal-acceptance` 系统提示词，含任务进度和下一步行动排序
- 拦截 `agent/turn-stopping`，当 required 标准未完成时按依赖优先级 steer Agent 继续

> **注意**：Cordis 插件需要 DeepSeek Harness 包作为 peer 依赖。
> 在没有 Harness workspace 的独立仓库中无法构建。core 和 mcp 包可独立构建。

## MCP 工具

| 工具 | 描述 |
|------|------|
| `set_acceptance_criteria` | 锁定标准列表。每个标准可关联 task ID 和依赖。可选 `role` 参数（`agent`/`reviewer`/`dual`，默认 `dual`）控制自评行为。必须在实现前调用。 |
| `get_acceptance_criteria` | 读取当前标准、任务进度、摘要、任务计划、可验证列表和下一步行动排序。可选 `verbose`（默认 `true`；传 `false` 仅返回精简摘要）。 |
| `set_task_plan` | 设定并锁定任务分解计划。每个任务需唯一 id、无歧义描述、具体交付物。依赖环被拒绝。需先锁定标准。 |
| `get_task_plan` | 读取当前任务分解计划及实时任务状态。 |
| `validate_criterion` | 记录状态（`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`）和证据。`passed` 和 `failed` 需要证据。可选 `evidence_type`（`command`/`file`/`url`/`text`，默认 `text`）。当 `role=agent` 时 `passed` 标记为自评。可选 `verbose`（默认 `false`）。 |
| `update_task_status` | 更新关联任务的状态（`pending`/`in_progress`/`completed`/`failed`）。当标准关联的所有任务完成时，该标准变为可验证。可选 `verbose`（默认 `false`）。 |
| `amend_acceptance_criteria` | 在初始锁定后追加新标准。需要理由。已有标准不被修改。 |
| `can_complete_goal` | 检查所有 required 标准是否正式通过（自评不算）。返回 `{ allowed: boolean, reason?: string }`。 |

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

- **允许**：所有 required 标准正式 `passed`（非自评），或未锁定任何标准。
- **不允许**：任何 required 标准为 `pending`、`in_progress`、`failed`、`blocked` 或 `not_run`。
- **不允许（自评）**：所有 required 标准为 `passed` 但部分为 `selfClaimed=true`（由 agent 设置，未经 reviewer 确认）。reason 会指出有多少条待确认。

## 事件溯源

引擎采用事件溯源模式。store 持有只追加的事件列表：

- `goal-acceptance/set` — 锁定标准列表（含 role）
- `goal-acceptance/task-plan` — 锁定任务分解计划
- `goal-acceptance/validate` — 更新单个标准的状态（含证据类型、自评标记）
- `goal-acceptance/task-update` — 更新关联任务的状态
- `goal-acceptance/amend` — 在初始锁定后追加新标准

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
| 模型工具 | `set/get/validate/update_task/amend` | 8 个工具（见 [MCP 工具](#mcp-工具)） | 同 MCP |
| 系统提示词 / Skills | `policy:goal-acceptance` | `skills/` | `skills/` |
| Turn-stopping 强制拦截 | 是（`agent.steer()`） | 否 | 否 |
| 跨客户端可移植 | 否（仅 Harness） | 是（任何 MCP 客户端） | 是（任何 Agent Plugins 客户端） |
| 持久化状态 | `dsh-session` 日志 | `$PLUGIN_DATA/acceptance-events.json` | 同 MCP |
| 双角色验证 | 否 | 是（`role` 参数） | 是 |
| 类型化证据 | 否 | 是（`evidence_type` 参数） | 是 |
| 任务分解计划 | 否 | 是（`set_task_plan` / `get_task_plan`） | 是 |
| 精简响应 | 否 | 是（`verbose` 参数） | 是 |

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
│       ├── engine.spec.ts      # 51 个测试
│       └── standalone.spec.ts  # 1 个测试
├── goal-acceptance-mcp/        # MCP server + Agent Plugin
│   ├── src/
│   │   ├── mcp-server.ts       # stdio MCP server，8 个工具
│   │   ├── store.ts            # FileAcceptanceStore
│   │   └── index.ts
│   ├── bin/mcp-server.mjs      # 构建后的 stdio 入口
│   ├── plugin.json             # Agent Plugins 清单
│   ├── mcp.json                # MCP server 配置
│   ├── skills/                 # 可移植 Agent Skills（6 个 skill）
│   └── tests/
│       └── mcp-server.spec.ts  # 22 个测试
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

构建 core 和 mcp 包。Cordis 插件（`goal-acceptance`）需要 DeepSeek Harness
workspace，在本仓库中默认不构建。

## 测试

```sh
pnpm install
pnpm test
```

## 许可证

MIT
