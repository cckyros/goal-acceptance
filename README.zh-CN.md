# goal-acceptance

![goal-acceptance](assets/goal-acceptance-cover.jpg)

[English](README.md) | 中文

面向自主 AI Agent 的验收标准驱动目标完成机制。

在 Agent 开始工作前锁定不可变的验收标准，在执行过程中记录带证据的验证状态，
将标准关联到任务进度并校验任务依赖，最后阻止 Agent 在必需标准未正式通过时提前宣布完成。

## 优势

### 1. 跨平台兼容

单一包、四种运行时、22 个安装目标：

| 平台 | 接入方式 | 停止时强制能力 |
|------|----------|----------------|
| Claude Code | MCP stdio server（`cli mcp`） | 模型主动调用工具 |
| Cursor | MCP stdio server（`cli mcp`） | 模型主动调用工具 |
| Devin | MCP stdio server（`cli mcp`） | 模型主动调用工具 |
| OpenClaw | 原生插件（`openclaw-dist/`，进程内、无 stdio） | 模型主动调用工具 |
| DeepSeek Harness | Cordis 插件（`dist/dsh-plugin.js`） | `agent.steer()` 强制继续 |
| 任意 MCP 客户端 | stdio MCP server（`cli mcp`） | 模型主动调用工具 |
| 任意 Agent Plugins 客户端 | `plugin.json` + `mcp.json` + skills | 模型主动调用工具 |
| 任意 JS/TS 运行时 | 核心引擎（`src/plugin/engine/`，已打入 CLI） | 由程序控制 |

核心状态机**零依赖**。`cli mcp` server、dsh Cordis 插件、OpenClaw 原生插件
全部调用同一套共享引擎与目标管理器——一份实现，四个出口。

### 2. 一条命令安装 22 个平台

`dist/cli.js install --target <name>` 为 22 个客户端注册本插件：

- **原生 MCP（8）**：claude、codex、opencode、qwen、reasonix、kilo、workbuddy、devin
- **Skill 目标（4）**：trae、pi、omp、dsh
- **Agent Plugins（10）**：copilot、cursor、kiro、openclaw、hermes、vscode、chatgpt-codex、grok、nanoclaw、other

每个适配器都从同一份生成好的便携包（`plugin.json` / `mcp.json` /
`.mcp.json` / `skills/` / `openclaw.plugin.json` / `openclaw-dist/`）
写入客户端原生配置。

### 3. MCP server 提供 15 个工具

MCP server 覆盖完整的目标验收生命周期：

- **标准管理**：`set_acceptance_criteria`、`get_acceptance_criteria`、`amend_acceptance_criteria`
- **任务计划**：`set_task_plan`、`get_task_plan`
- **验证**：`validate_criterion`、`confirm_criterion`
- **进度跟踪**：`update_task_status`
- **完成门禁**：`can_complete_goal`
- **多目标管理**：`start_goal`、`list_goals`、`switch_goal`、`reset_goal`
- **快速开始**：`quick_start_goal`（一步完成开始/切换目标、锁定标准、可选设置任务计划）
- **运行并验证**：`run_and_validate`（执行 shell 命令并一步完成标准验证）

完整列表见下文 [MCP 工具](#mcp-工具)。

### 多目标隔离

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

## 架构

```
src/
├── framework/              # 零依赖脚手架（manifest、registry、CLI、wizard、
│                           #   mcp-runtime、hook-runtime、安装器）
├── plugin/
│   ├── engine/             # 事件源状态机（core）
│   ├── goal-manager.ts     # 多目标管理器（所有通路共享）
│   ├── tools.ts            # 15 个 ToolDef（manifest.tools 数据源）
│   ├── manifest.ts         # 身份唯一来源
│   ├── dsh-plugin.ts       # DeepSeek Harness Cordis 插件
│   ├── openclaw-plugin.ts  # OpenClaw 原生插件（typebox、进程内）
│   ├── openclaw-session-sync.ts  # 将活动目标同步到 OpenClaw SessionEntry.goal
│   ├── prompt.ts           # dsh 系统提示指引
│   ├── invariant.ts        # dsh session 不变量伴生插件
│   └── targets/            # 22 个安装适配器
└── assets/                 # SKILL.md + 8 个配套技能（{{占位符}}）

build.mjs  →  dist/cli.js（CLI + MCP）+ dist/hook.cjs + dist/dsh-plugin.js
              + dist/openclaw-plugin.js → openclaw-dist/
              + plugin.json / mcp.json / .mcp.json / marketplace.json
              / cordis.patch.yml / openclaw.plugin.json / skills/
```

所有身份文件都在构建时由 `src/plugin/manifest.ts` **生成并提交**，
仓库本身就是所有客户端的合法安装源。

## 快速开始

### 安装（一条命令，22 个平台）

```sh
node dist/cli.js install                # 交互式向导
node dist/cli.js install --target claude
node dist/cli.js install --target openclaw
node dist/cli.js list-targets           # 查看全部 22 个
```

### MCP server（任意 MCP 客户端）

```json
{
  "mcpServers": {
    "@cckyros/goal-acceptance": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/goal-acceptance/dist/cli.js", "mcp"],
      "env": { "PLUGIN_DATA": "/path/to/persistent/data" }
    }
  }
}
```

独立运行：

```sh
# 内存模式（重启后丢失）
node dist/cli.js mcp

# 持久化模式
PLUGIN_DATA=/path/to/data node dist/cli.js mcp
```

未设置 `PLUGIN_DATA` 时状态仅存于内存（重启丢失）。

#### 典型工作流

1. **设定标准** — `set_acceptance_criteria`，`role=reviewer`（你验证）或 `role=agent`（Agent 自评，稍后确认）
2. **设定任务计划** — `set_task_plan` 将目标拆分为带交付物和依赖的原子任务
3. **执行** — 任务推进时调用 `update_task_status`（`pending` — `in_progress` — `completed`）
4. **验证** — `validate_criterion` 使用 `evidence_type=command` 提交高可信度证据。默认 `role=agent`：通过的标准标记为自评
5. **确认** — `confirm_criterion`（仅限独立 reviewer）使用全新的 `command`/`file`/`url` 证据，将自评转为正式通过
6. **检查** — `can_complete_goal` 确认所有必需标准均已正式通过

### OpenClaw 原生插件

`openclaw-dist/` 携带进程内插件（bundle + 带 `openclaw.extensions` 契约的最小
package.json），`openclaw.plugin.json` 声明 15 个工具契约：

```sh
openclaw plugins install @cckyros/goal-acceptance
# 或本地构建：
openclaw plugins install /path/to/goal-acceptance/openclaw-dist
openclaw gateway restart
openclaw plugins list            # goal-acceptance: loaded
```

15 个工具可在 OpenClaw 会话中使用。`Shape: non-capability` 对工具插件是正常的
——工具经 `defineToolPlugin` 注册，不经过 capability 系统。

每次会改变目标状态的工具调用后（`start_goal`、`set_acceptance_criteria`、
`validate_criterion`、`confirm_criterion`、`amend_acceptance_criteria`、
`update_task_status`、`set_task_plan`、`run_and_validate`、`quick_start_goal`、
`switch_goal`、`reset_goal`），插件都会把当前 acceptance 目标镜像到 OpenClaw
的 `SessionEntry.goal` 槽。这样 OpenClaw 内置的 `get_goal` 和 `update_goal`
就能看到这个活动目标。`update_goal` 直接修改 `SessionEntry.goal` 后，如果后续
再调用插件工具，插件会按自身事件源状态重新同步该槽。

### DeepSeek Harness（Cordis 插件）

`dist/dsh-plugin.js` 是唯一能**强制** Agent 继续工作的变体：它拦截
`agent/turn-stopping`，按依赖感知的优先级把 Agent 拉回未完成工作。

```yaml
# cordis.patch.yml（自动生成）
- insert:
    - id: @cckyros/goal-acceptance
      name: @cckyros/goal-acceptance
      config: {}
```

该插件：

- 注册与 MCP 适配器相同的 15 个模型工具
- 注入 `policy:goal-acceptance` 系统提示段落，给出任务进度与 next-actionable 排序
- 拦截 `agent/turn-stopping`，按依赖感知优先级把 Agent 拉回待办工作，
  以及等待 reviewer 确认的自评标准

> **注意**：dsh 插件需要 DeepSeek Harness 宿主包作为 peer 依赖（`@deepseek-ai/*`），
> 由 dsh profile 在运行时注入。`@deepseek-ai/*` 在本仓库仅是 devDependencies（类型用途）。

### 核心引擎（任意 JS/TS 运行时）

零依赖状态机位于 `src/plugin/engine/`，已打入 CLI。可从此仓库直接使用，
或将目录复制到你的项目：

```typescript
import { GoalAcceptanceEngine, InMemoryAcceptanceStore } from './src/plugin/engine/index.ts'

const engine = new GoalAcceptanceEngine(new InMemoryAcceptanceStore())

// 开始工作前锁定验收标准
await engine.setCriteria([
  { id: 'api-200', description: 'GET /health returns 200', required: true, method: 'test', taskIds: ['task-1', 'task-2'] },
  { id: 'docs', description: 'README updated', required: false, method: 'manual', dependsOn: ['api-200'] },
])

// 随进度更新任务状态
await engine.updateTaskStatus({ taskId: 'task-1', status: 'completed' })
await engine.updateTaskStatus({ taskId: 'task-2', status: 'completed' })

// 关联任务全部完成后，标准进入 "ready to validate"
const summary = engine.summarize()
console.log(summary.readyToValidate.map(c => c.id)) // ['api-200']

// 记录带证据的验证
await engine.validateCriterion({
  criterionId: 'api-200',
  status: 'passed',
  evidence: 'curl /health -> HTTP 200 OK',
})

// 检查目标是否可以完成
const { allowed, reason } = engine.canComplete()
console.log(allowed, reason)
// true, undefined
```

## MCP 工具

| 工具 | 说明 |
|------|------|
| `set_acceptance_criteria` | 锁定验收标准列表。每个标准可关联任务 ID 并声明依赖。可选 `role` 参数（`agent`/`reviewer`/`dual`，默认 `agent`）控制自评行为。实现前必须先调用。 |
| `get_acceptance_criteria` | 读取当前标准、任务进度、摘要、任务计划、待验证列表与 next-actionable 排序。可选 `verbose`（默认 `true`；`false` 仅返回精简摘要）。 |
| `set_task_plan` | 设定并锁定任务分解计划。每个任务须有唯一 ID、明确的描述与具体交付物。拒绝依赖环。要求标准已锁定。 |
| `get_task_plan` | 读取当前任务分解计划及实时任务状态。 |
| `validate_criterion` | 记录状态（`pending`/`in_progress`/`passed`/`failed`/`blocked`/`not_run`）与证据。`passed` 和 `failed` 必须附带证据。可选 `evidence_type`（`command`/`file`/`url`/`text`，默认 `text`）。默认 `role=agent` 时 `passed` 标记为自评。可选 `verbose`（默认 `false`）。 |
| `confirm_criterion` | **仅限 reviewer。** 使用独立复核证据确认自评通过的标准。要求 `evidence_type` 为 `command`/`file`/`url`（拒绝 `text`）。将自评转为正式通过，解除 `can_complete_goal` 阻塞。必须由独立 reviewer 调用，而非执行工作的 Agent。 |
| `update_task_status` | 更新关联任务的状态（`pending`/`in_progress`/`completed`/`failed`）。任务全部完成的标准进入待验证。可选 `verbose`（默认 `false`）。 |
| `amend_acceptance_criteria` | 初次锁定后追加新标准。必须提供 reason。已有标准不会被修改。 |
| `can_complete_goal` | 检查所有必需标准是否已正式通过（自评不计）。返回 `{ allowed: boolean, reason?: string }`。 |
| `start_goal` | 以全新状态开始新的独立目标（可选 `title`）。新目标成为活动目标。当前目标已锁定且需要新任务时使用。 |
| `list_goals` | 列出所有目标：ID、标题、标准计数与活动标记。 |
| `switch_goal` | 按 ID 切换活动目标。 |
| `quick_start_goal` | 便捷快速路径：一步完成开始/切换目标、锁定验收标准，并可选同时设置任务计划。 |
| `run_and_validate` | 执行 shell 命令并一步完成标准验证。捕获 stdout/stderr/exitCode 作为 evidence_type=command 证据。 |
| `reset_goal` | 永久删除当前目标及其全部数据。 |

## 技能（Skills）

插件附带 9 个技能（构建时从 `src/assets/` 填充占位符生成）：

```
skills/
├── goal-acceptance/SKILL.md          # 主技能：工作流 + 配套技能索引
├── goal-planning/                    # 先分解为覆盖完整的标准
├── set-acceptance-criteria/          # 锁定标准（标准质量规则）
├── amend-acceptance-criteria/        # 需求扩展时追加标准
├── get-acceptance-criteria/          # 读取当前标准与进度
├── update-task-status/               # 跟踪关联任务状态
├── validate-criterion/               # 记录状态 + 真实执行证据
├── confirm-criterion/                # 独立 reviewer 确认（全新证据）
└── can-complete-goal/                # 完成门禁；自评标准阻塞
```

## 标准状态生命周期

pending -> in_progress -> passed
             |              |
             +-> failed     +-> selfClaimed -> confirm_criterion -> formal pass
             |
             +-> blocked
             +-> not_run（仅非必需标准）

| 状态 | 含义 | 是否需要证据 |
|--------|---------|--------------|
| `pending` | 尚未开始 | 否 |
| `in_progress` | 正在处理 | 否 |
| `passed` | 验证成功 | 是 |
| `failed` | 验证失败 | 是 |
| `blocked` | 当前环境无法验证 | 否 |
| `not_run` | 显式跳过（仅非必需） | 否 |

## 完成门禁

`canComplete()` 返回 `{ allowed: boolean, reason?: string }`：

- **允许**：所有必需标准均已正式 `passed`（非自评），或尚未锁定任何标准。
- **不允许**：任一必需标准处于 `pending`、`in_progress`、`failed`、`blocked` 或 `not_run`。
- **不允许（自评）**：所有必需标准均已 `passed`，但部分为 `selfClaimed=true`
  （由 Agent 设定、尚未经 reviewer 确认）。reason 会指出有多少条等待 reviewer 确认。

## 事件溯源

引擎是事件源的。store 持有追加式事件列表：

- `goal-acceptance/set` — 锁定标准列表（含 role）
- `goal-acceptance/task-plan` — 锁定任务分解计划
- `goal-acceptance/validate` — 更新单条标准状态（含证据类型、自评标记）
- `goal-acceptance/task-update` — 更新关联任务状态
- `goal-acceptance/amend` — 初次锁定后追加标准

每次读取时引擎从 store 重放事件，从而实现：

- 持久化（文件、数据库、会话日志）
- 精确的状态恢复
- 全量决策审计轨迹

### 自定义 Store

为你的持久化后端实现 `GoalAcceptanceStore`：

```typescript
import type { GoalAcceptanceStore, GoalAcceptanceEvent } from './src/plugin/engine/index.ts'

class MyDbStore implements GoalAcceptanceStore {
  get events(): readonly GoalAcceptanceEvent[] {
    // 按追加顺序返回所有事件
  }

  async append(event: GoalAcceptanceEvent): Promise<void> {
    // 持久化事件
  }
}
```

## 四通路兼容性

| 能力 | dsh Cordis 插件 | CLI MCP server | Agent Plugin | OpenClaw 原生 |
|------------|:---:|:---:|:---:|:---:|
| 模型工具 | 15 个（见 [MCP 工具](#mcp-工具)） | 15 个（见 [MCP 工具](#mcp-工具)） | 与 MCP 相同 | 与 MCP 相同（进程内） |
| 系统提示 / 技能 | `policy:goal-acceptance` | `skills/` | `skills/` | `skills/` |
| 停止时强制 | 是（`agent.steer()`，依赖感知） | 否 | 否 | 否 |
| 跨客户端便携 | 否（仅 Harness） | 是（任意 MCP 客户端） | 是（任意 Agent Plugins 客户端） | 否（仅 OpenClaw） |
| 持久化状态 | `dsh-session` 日志 | `$PLUGIN_DATA/goals/` | 与 MCP 相同 | 与 MCP 相同 |
| 双角色验证 | 是（`role` 参数） | 是（`role` 参数） | 是 | 是 |
| 类型化证据 | 是（`evidence_type` 参数） | 是（`evidence_type` 参数） | 是 | 是 |
| 任务分解计划 | 是（`set_task_plan` / `get_task_plan`） | 是（`set_task_plan` / `get_task_plan`） | 是 | 是 |
| 精简响应 | 否 | 是（`verbose` 参数） | 是 | 是 |
| 进程内调用（无 stdio） | 是 | 否 | 否 | 是 |

dsh Cordis 插件是唯一能**强制** Agent 继续工作的变体。MCP、Agent Plugin 与
OpenClaw 原生变体依赖模型主动调用工具并遵循技能指引。

## 仓库布局

```
src/
├── cli-entry.ts            # CLI 入口（打包为 dist/cli.js）
├── hook-entry.ts           # Read hook（打包为 dist/hook.cjs）
├── framework/              # 脚手架框架（manifest、registry、CLI、wizard、
│                           #   mcp-runtime、hook-runtime、paths、cache）
├── plugin/
│   ├── manifest.ts         # 身份唯一来源（name、tools、markers、config）
│   ├── engine/             # 事件源状态机（零依赖）
│   ├── goal-manager.ts     # 多目标管理器 + store（所有通路共享）
│   ├── tools.ts            # 15 个 ToolDef
│   ├── dsh-plugin.ts       # Cordis 插件（service、tools、steer、prompt）
│   ├── openclaw-plugin.ts  # OpenClaw 原生插件
│   ├── openclaw-session-sync.ts  # 将活动目标同步到 OpenClaw SessionEntry.goal
│   ├── prompt.ts           # dsh 系统提示指引
│   ├── invariant.ts        # dsh session 不变量
│   └── targets/            # 22 个安装适配器
└── assets/                 # SKILL.md + 8 个配套技能 + 封面图
tests/                      # node --test 套件（engine、mcp、dsh、targets...）
build.mjs                   # esbuild 打包 + 身份文件生成
dist/                       # cli.js + hook.cjs + dsh-plugin.js（已提交）
openclaw-dist/              # openclaw-plugin.js + package.json（已提交）
```

## 构建与测试

```sh
pnpm install
npm run verify      # build → typecheck → node --test
node dist/cli.js --help
```

## License

MIT
