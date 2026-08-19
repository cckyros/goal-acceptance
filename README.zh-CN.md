# goal-acceptance

![goal-acceptance](docs/goal-acceptance-cover.jpg)

[English](README.md) | 中文

面向自主 AI Agent 的验收标准驱动目标完成机制。

在 Agent 开始工作前锁定不可变的验收标准，在执行过程中记录带证据的验证状态，
将标准关联到任务进度并校验任务依赖，最后阻止 Agent 在必需标准未正式通过时提前宣布完成。

## 优势

### 1. 跨平台兼容

goal-acceptance 兼容支持 MCP 或 Agent Plugins 的 AI Agent 平台。核心状态机零依赖，
可以在 Node.js、Bun、Deno 或浏览器中运行；不同集成层提供不同的运行方式。

| 平台 | 接入方式 | 停止时强制能力 |
|------|----------|----------------|
| Claude Code | MCP stdio server | 模型主动调用工具 |
| Cursor | MCP stdio server | 模型主动调用工具 |
| Devin | MCP stdio server | 模型主动调用工具 |
| OpenClaw | 原生插件或 Agent Plugin bundle | 模型主动调用工具 |
| DeepSeek Harness | Cordis 插件 | `agent.steer()` 强制继续 |
| 任意 MCP 客户端 | stdio MCP server | 模型主动调用工具 |
| 任意 Agent Plugins 客户端 | `plugin.json` + `mcp.json` + skills | 模型主动调用工具 |
| 任意 JS/TS 运行时 | `@cckyros/goal-acceptance-core` | 由程序控制 |

### 2. MCP server 提供 13 个工具

MCP server 覆盖完整的目标验收生命周期：

- **标准管理**：`set_acceptance_criteria`、`get_acceptance_criteria`、`amend_acceptance_criteria`
- **任务计划**：`set_task_plan`、`get_task_plan`
- **验证**：`validate_criterion`、`confirm_criterion`
- **进度跟踪**：`update_task_status`
- **完成门禁**：`can_complete_goal`
- **多目标管理**：`start_goal`、`list_goals`、`switch_goal`、`reset_goal`

### 3. 多目标隔离

每个目标都拥有独立的事件文件 `${PLUGIN_DATA}/goals/{goalId}.json`，多个项目和窗口可以共享同一个 server：

- `set_acceptance_criteria` 在没有活动目标时自动创建目标
- `start_goal` 开始一个全新的独立目标
- `switch_goal` 在目标之间切换，`list_goals` 列出所有目标及状态
- `reset_goal` 删除当前目标及其数据
- 活动目标会在 server 重启后通过 `current-goal.txt` 恢复

### 4. 独立复核，避免自我评分

`set_acceptance_criteria` 的 `role` 参数支持 `agent`、`reviewer` 和 `dual`。
默认角色是 `agent`：Agent 调用 `validate_criterion` 通过标准后，会标记为
`selfClaimed=true`。只有独立 reviewer 使用新证据调用 `confirm_criterion` 后，
该标准才算正式通过，`can_complete_goal` 才会允许完成目标。

### 5. 类型化证据

`validate_criterion` 支持 `command`、`file`、`url` 和 `text` 四种证据类型。
对于命令标准，应实际运行命令并提交真实输出；对于文件和 URL 标准，应提交实际检查结果。
`confirm_criterion` 只接受高可信度的 `command`、`file` 或 `url` 证据，不接受纯文本判断。

### 6. 任务分解与依赖校验

`set_task_plan` 将目标拆分为带具体交付物的原子任务。引擎会校验任务 ID 唯一、描述明确、
交付物非空、依赖存在，并拒绝直接或间接依赖环。

### 7. 事件源持久化与精简响应

所有状态变化都以追加事件保存，读取时重放事件，从而支持持久化、重启恢复和完整审计轨迹。
MCP 工具默认返回精简摘要；传入 `verbose=true` 可获取完整摘要。

## 包

| 包 | 说明 | 依赖 |
|----|------|------|
| [`@cckyros/goal-acceptance-core`](packages/goal-acceptance-core) | 框架无关的状态机、类型、错误和 Store 抽象 | 无 |
| [`@cckyros/goal-acceptance-mcp`](packages/goal-acceptance-mcp) | MCP stdio server 和 Agent Plugin bundle | core、MCP SDK |
| [`@cckyros/goal-acceptance-openclaw`](packages/goal-acceptance-openclaw) | OpenClaw 原生插件，进程内注册工具 | core、typebox；peer：openclaw |
| [`@cckyros/goal-acceptance`](packages/goal-acceptance) | DeepSeek Harness Cordis 插件，支持停止时 steering | core、schemastery；peer：dsh-* 包 |

## 快速开始

### Core library

```sh
npm install @cckyros/goal-acceptance-core@0.1.0
```

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from '@cckyros/goal-acceptance-core'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

await engine.setCriteria([
  {
    id: 'api-200',
    description: 'GET /health 返回 HTTP 200',
    required: true,
    method: 'test',
    taskIds: ['task-1'],
  },
])

await engine.updateTaskStatus({ taskId: 'task-1', status: 'completed' })
await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health 返回 HTTP 200 OK',
})

const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
```

### MCP server（Devin、Claude Code、Cursor 等）

#### 方式 A：全局安装

```sh
npm install -g @cckyros/goal-acceptance-mcp@0.1.0
```

查看全局安装路径：

```sh
npm root -g
```

然后在 MCP 客户端配置中使用：

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["/path/to/global/node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

#### 方式 B：npx

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "npx",
      "args": ["-y", "@cckyros/goal-acceptance-mcp@0.1.0"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

#### 方式 C：项目级安装

```sh
npm install @cckyros/goal-acceptance-mcp@0.1.0
```

```json
{
  "mcpServers": {
    "goal-acceptance": {
      "command": "node",
      "args": ["./node_modules/@cckyros/goal-acceptance-mcp/bin/mcp-server.mjs"],
      "env": {
        "PLUGIN_DATA": "/path/to/persistent/data"
      }
    }
  }
}
```

#### Devin CLI 配置

Windows 使用 `%APPDATA%\devin\mcp_config.json`，macOS/Linux 使用
`~/.config/devin/mcp_config.json`。将 `goal-acceptance` 添加到 `mcpServers` 后重启 Devin。

#### 典型工作流

1. **规划**：复杂任务先使用 `goal-planning` skill，spawn planning subagent 探索代码库
2. **锁定标准**：调用 `set_acceptance_criteria`，确保标准不重合且完整覆盖目标需求
3. **设置任务计划**：调用 `set_task_plan`，拆分带交付物和依赖的原子任务
4. **执行**：使用 `update_task_status` 跟踪 `pending`、`in_progress`、`completed`
5. **验证**：实际执行命令或检查文件/URL 后调用 `validate_criterion`
6. **独立复核**：由不同 reviewer 使用新证据调用 `confirm_criterion`
7. **完成检查**：调用 `can_complete_goal`，仅在 `allowed=true` 时宣布完成

### OpenClaw 原生插件

```sh
openclaw plugins install "npm:@cckyros/goal-acceptance-openclaw@0.1.0"
```

安装后重启 gateway：

```sh
openclaw gateway restart
```

验证插件：

```sh
openclaw plugins inspect goal-acceptance
# Status: loaded, Format: openclaw
```

OpenClaw 会在进程内注册 13 个工具，不需要 MCP stdio。

### Agent Plugin bundle

MCP 包同时包含 Agent Plugin 清单和 skills：

```text
node_modules/@cckyros/goal-acceptance-mcp/
├── plugin.json
├── mcp.json
└── skills/
    ├── goal-planning/SKILL.md
    ├── set-acceptance-criteria/SKILL.md
    ├── get-acceptance-criteria/SKILL.md
    ├── validate-criterion/SKILL.md
    ├── confirm-criterion/SKILL.md
    ├── update-task-status/SKILL.md
    ├── amend-acceptance-criteria/SKILL.md
    └── can-complete-goal/SKILL.md
```

### DeepSeek Harness Cordis 插件

该 Cordis 包在本仓库中保持源码形式，设计上应安装到已经提供 DeepSeek Harness
peer 依赖的 workspace 中，而不是作为独立 npm 包安装。

该插件会注册 goal-acceptance 工具，注入系统提示，并在必需标准未完成时拦截
`agent/turn-stopping`，按照依赖优先级 steering Agent 继续工作。

Cordis 插件需要 DeepSeek Harness 相关包作为 peer 依赖，应在已安装这些依赖的
DeepSeek Harness workspace 中使用；core 和 MCP 包可以独立构建。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `set_acceptance_criteria` | 锁定标准列表；默认 `role=agent`，通过的标准需要独立 reviewer 确认 |
| `get_acceptance_criteria` | 读取标准、任务进度、摘要和可验证列表 |
| `set_task_plan` | 锁定任务分解计划并校验依赖 |
| `get_task_plan` | 读取任务计划及实时状态 |
| `validate_criterion` | 记录状态和证据；必须基于实际检查结果 |
| `confirm_criterion` | reviewer 使用独立的新证据确认 self-claimed 标准 |
| `update_task_status` | 更新关联任务状态 |
| `amend_acceptance_criteria` | 在初始锁定后追加标准，已有标准不会被修改 |
| `can_complete_goal` | 检查所有必需标准是否正式通过 |
| `start_goal` | 开始一个新的独立目标 |
| `list_goals` | 列出所有目标及当前状态 |
| `switch_goal` | 切换活动目标 |
| `reset_goal` | 永久删除当前目标及其数据 |

## 完成门禁

只有所有必需标准都正式通过时，`canComplete()` 才会返回 `allowed: true`。
Agent 自己验证得到的 `selfClaimed=true` 不算正式通过；必须由 reviewer 调用
`confirm_criterion` 后才能完成。

## 构建与测试

```sh
pnpm install
pnpm test
pnpm typecheck
```

根目录的完整 build 还会尝试构建 DeepSeek Harness Cordis 插件；该插件需要 Harness
workspace 提供 peer 依赖。core 和 MCP 包可以独立构建。

## 许可证

MIT
