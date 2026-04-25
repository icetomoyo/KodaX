# KodaX

轻量、透明、可定制的 TypeScript AI Coding Agent。

KodaX 既可以作为命令行工具使用，也可以作为库集成到你的项目里，还能打包成**免 Node 运行时**的单文件二进制分发到目标机器。当前支持 12 个模型提供商，包含完整的 REPL、会话、30+ 工具、Skills，以及 Scout-first 自适应多 Agent 工作流。

## 为什么用 KodaX

- 透明：代码结构清晰，便于阅读、修改和调试。
- 灵活：支持多 provider，方便切换模型和网关。
- 可定制：prompts、tools、skills、session 流程都能改。
- 可复用：不只是 CLI，也可以把其中一层当库来使用。

如果你关心：

- 想理解 AI coding agent 是怎么工作的
- 不想被单一 provider 绑定
- 希望 agent 逻辑能自己控制
- 需要一套适合长期开发任务的工程化工作流

那 KodaX 会比单纯依赖某个黑盒托管产品更合适。

## 快速开始

### 1. 安装并构建

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build
npm link
```

构建完成后就可以直接启动：

```bash
kodax
```

### 2. 配置模型提供商

最简单的方式是先设置 API Key：

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

然后在 `~/.kodax/config.json` 里写一个最小配置：

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto"
}
```

### 3. 启动 REPL 或执行单次任务

```bash
# 进入交互式 REPL
kodax

# 单次任务
kodax "Review this repository and summarize the architecture"
```

进入 REPL 后，你可以直接自然语言提问，也可以使用命令：

```text
/help
/mode
/agent-mode ama
```

### 4. 作为库使用

```typescript
import { runKodaX } from 'kodax';

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'auto',
  },
  'Explain this codebase'
);
```

### 5. 自定义 Provider（OpenAI / Anthropic 兼容端点）

任何 OpenAI 或 Anthropic 协议兼容的 endpoint 都可以通过 `customProviders[]` 接入，CLI 模式写在 `~/.kodax/config.json` 里：

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model",
      "userAgentMode": "compat"
    }
  ]
}
```

`userAgentMode` 默认 `"compat"`（发送 `KodaX` 而非上游 SDK 的 User-Agent）；如果你的网关要求原生 SDK header，再切到 `"sdk"`。

库模式下用 `registerCustomProviders()` 显式注册：

```typescript
import { registerCustomProviders, runKodaX } from 'kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
    userAgentMode: 'compat',
  },
]);

await runKodaX({ provider: 'my-openai-compatible' }, '解释这个仓库');
```

### 6. 打包成单文件二进制（无需 Node）

KodaX 可以用 `bun --compile` 打包成单可执行文件 + 一个 `builtin/` sidecar 目录，目标机器**不需要安装 Node.js 或任何运行时**。

支持目标：`win-x64`、`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`。Win7 / glibc < 2.27 的发行版 / 龙芯 LoongArch 暂不支持。

本地构建：

```bash
# 先在构建机器上装好 Bun（一次性）
npm i -g bun                  # 或 scoop / brew / curl，详见 docs/release.md

npm run build:binary          # 当前平台（最快）
npm run build:binary:all      # 一台机器出全部 5 个目标
node scripts/build-binary.mjs --target=linux-arm64   # 指定平台
```

产物在 `dist/binary/<target>/`：

```
dist/binary/linux-x64/
├── kodax              # ~60 MB Bun 编译的二进制
└── builtin/           # 内置 skills sidecar
```

冒烟验证：`dist/binary/<host>/kodax --version`。

**自动发布**：推送 `v*` git tag 会触发 `.github/workflows/release.yml`，在原生 runner 上构建全部 5 个目标、跑冒烟测试，然后自动创建 GitHub Release 并上传 archives + SHA256SUMS。也可以从 Actions UI 用 `workflow_dispatch` 不打 tag 跑流水线测试。

详细的构建参数、archive 结构、`KODAX_BUNDLED` / `KODAX_VERSION` build-time defines、故障排查，参见 [docs/release.md](docs/release.md)。

## 内置 Provider 列表

| Provider | 环境变量 | Reasoning | 默认 Model |
|----------|----------|-----------|-----------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6 |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex |
| kimi | `KIMI_API_KEY` | Native | kimi-k2.6 |
| kimi-code | `KIMI_API_KEY` | Native | kimi-for-coding |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Native | glm-5（GLM Coding Plan 端点） |
| minimax-coding | `MINIMAX_API_KEY` | Native | MiniMax-M2.7 |
| mimo-coding | `MIMO_API_KEY` | Native | mimo-v2.5-pro（小米 MiMo Token Plan，Anthropic 协议） |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | （通过 gemini CLI） |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | （通过 codex CLI） |

> 不在表里的端点：用上面"自定义 Provider"那一节加进来即可。

## 内置工具一览

KodaX 有 30+ 个内置工具，按类别分组如下（实际暴露给 LLM 是一张扁平表）。

**文件操作**

| 工具 | 说明 |
|------|------|
| `read` | 读取文件（支持 offset / limit） |
| `write` | 创建新文件或完整重写 |
| `edit` | 精确字符串替换（支持 `replace_all`） |
| `multi_edit` | 对同一文件做一批独立 edit，整批原子提交 |
| `insert_after_anchor` | 在唯一 anchor 后插入内容，避免整文件重写 |
| `undo` | 撤销最近一次文件修改 |

**Shell 与搜索**

| 工具 | 说明 |
|------|------|
| `bash` | 执行 shell 命令（支持后台、输出截断） |
| `glob` / `grep` | 文件名匹配 / 正则内容搜索 |
| `code_search` | 代码搜索，比裸 grep 噪音更低 |
| `semantic_lookup` | 借助 repo intelligence 的符号 / 模块 / 流程感知查找 |
| `web_search` / `web_fetch` | 联网搜索 / 抓取，自带 trust + 时效信号 |

**Repo Intelligence working tools**

| 工具 | 说明 |
|------|------|
| `repo_overview` | 仓库结构、关键区域、入口提示、intelligence 快照 |
| `changed_scope` | 当前 diff 涉及的文件 / 区域 / 类别 |
| `changed_diff` / `changed_diff_bundle` | 单文件 / 多文件分页 diff |
| `module_context` | 模块 capsule（依赖、入口、符号、测试、文档） |
| `symbol_context` | 定义 + 可能的 caller/callee + 备选 |
| `process_context` | 入口的近似静态执行/流程 capsule |
| `impact_estimate` | 符号 / 路径 / 模块的影响面估算 |

**MCP 能力**（配置了 MCP server 时可用）

| 工具 | 说明 |
|------|------|
| `mcp_search` / `mcp_describe` / `mcp_call` | 通过共享 capability runtime 发现并调用 MCP 工具 |
| `mcp_read_resource` / `mcp_get_prompt` | 读取 MCP 资源、获取 MCP prompt |

**Git Worktree**

| 工具 | 说明 |
|------|------|
| `worktree_create` | 在隔离分支上新建 worktree，让 agent 安全工作 |
| `worktree_remove` | 移除 worktree（自带安全检查） |

**Agent 控制 / 交互**

| 工具 | 说明 |
|------|------|
| `dispatch_child_task` | 派发子 agent 跑独立调研 / 改动任务 |
| `ask_user_question` | 向用户发起单选 / 多选 / 自由文本提问 |
| `exit_plan_mode` | Plan 模式下提交最终方案给用户审批（仅 REPL） |
| `emit_managed_protocol` | scout / planner / handoff / verdict 内部协议侧信道 |

## Repo Intelligence Premium

KodaX 现在支持一套拆分后的 Repo Intelligence 架构：

- 公共 OSS baseline 在 public `KodaX` 仓库里
- premium intelligence 在 private `KodaX-private` 仓库里
- premium 通过本地 `repointel` frontdoor 和 daemon 运行
- KodaX 自身支持原生旗舰路径

一句话理解：

- 没有 premium 时，KodaX 仍然能正常工作
- 安装 premium 后，KodaX 可以获得更强的仓库理解、影响面分析、上下文压缩和原生自动注入能力

## Repo Intelligence 运行模式

KodaX 支持这些模式：

- `off`
  - 严格关闭 repo-intelligence 工作面
  - 不自动注入，也不暴露 repo working tools
  - 但 `/repointel` 控制命令仍然保留
- `oss`
  - 只使用 public OSS baseline
- `premium-shared`
  - 使用 premium，但不走 KodaX 原生 auto lane
  - 适合和其他宿主路径做对比
- `premium-native`
  - 使用 premium，并走 KodaX 原生路径
  - 这是推荐模式，也是最佳体验
- `auto`
  - 先尝试 `premium-native`
  - premium 不可用时自动回退到 `oss`

## native-first 使用方式

当前正式发布推荐使用 native `repointel` 包。

也就是说：

- 正式 GitHub Release 应该发布 native 包
- offline bundle 只保留给内部验证或特殊场景

### 普通用户最简配置

如果 `repointel` 已经在 `PATH`：

```json
{
  "repoIntelligenceMode": "premium-native"
}
```

### 不在 PATH 时

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe"
}
```

### 作者同父目录联调

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelEndpoint": "http://127.0.0.1:47891",
  "repointelBin": "C:\\path\\to\\KodaX-private\\packages\\repointel-cli\\dist\\index.js",
  "repoIntelligenceTrace": true
}
```

配置模板可参考：

- [config.example.jsonc](./config.example.jsonc)

## `repointelEndpoint` 是什么

`repointelEndpoint` 表示 KodaX 连接本地 premium daemon 的地址。

默认值通常是：

```json
"repointelEndpoint": "http://127.0.0.1:47891"
```

大多数用户不需要手动配置它，只有这些情况才建议显式设置：

- 你改了默认端口
- 你想同时跑多个 daemon
- 你在做本地调试或隔离实验

## REPL 里怎么看当前状态

启动 `kodax` 后，可以直接使用：

- `/status`
  - 看简要状态
- `/repointel`
  - 看更详细的 repo-intelligence 状态
- `/repointel status`
  - 显式探测本地 premium frontdoor

最重要的字段有：

- `mode`
- `engine`
- `bridge`
- `status`

例如：

- `premium-native / premium / native / ok`
  - 说明 premium 生效了，而且走的是 KodaX 原生旗舰路径
- `oss / oss / none / ok`
  - 说明当前实际运行在 OSS baseline

## REPL 里怎么控制 Repo Intelligence

可用命令包括：

- `/repointel`
- `/repointel status`
- `/repointel mode premium-native|premium-shared|oss|off|auto`
- `/repointel trace on|off|toggle`
- `/repointel warm`
- `/repointel endpoint ...`
- `/repointel bin ...`

你也可以用：

- `/clear`

来清空当前会话上下文。

如果要做严格 benchmark，最好每档模式都使用一个全新的 session，避免旧上下文污染结果。

## `repoIntelligenceTrace` 有什么用

`repoIntelligenceTrace` 是一个诊断和对比开关。

打开后，你可以更清楚地看到：

- 当前到底是 `oss` 还是 `premium`
- 当前是 `shared` 还是 `native`
- daemon latency
- cache hit/miss
- capsule token 估算

普通用户平时通常可以不开；联调、benchmark、排障时再打开。

## `premium-native` 和 `premium-shared` 的区别

两者都使用 premium，但区别在于是否使用 KodaX 原生特权路径：

- `premium-native`
  - KodaX 旗舰路径
  - 更早预取 intelligence
  - 在 planning / routing / prompt build 前就更主动地使用 premium
- `premium-shared`
  - 仍然用 premium
  - 但故意不走 KodaX 原生 auto lane
  - 更接近其他宿主的共享接入方式

如果你平时自己用 KodaX，推荐 `premium-native`。

## 如何更明显地体现 `repointel` 收益

最容易体现 repo-intelligence 收益的任务，不是“改单一文件”，而是：

- 需要先理解仓库结构
- 需要缩小范围
- 需要判断模块、流程、影响面

例如：

```text
我要给 KodaX 增加一个真正的 /new 命令。先不要写代码，先判断最可能需要改哪些模块、调用链会经过哪里、最值得先看的 8 个文件是什么。
```

```text
帮我定位 KodaX 从命令行启动，到进入 REPL 或 ACP，再到真正调用 coding agent 的主入口链。先给我分层图和最关键文件，不要先铺开全部实现。
```

如果你要做 A/B 测试，建议比较：

- `off`
- `oss`
- `premium-shared`
- `premium-native`

而且每档尽量用全新的 session。

## Clients 目录说明

`clients/` 目录现在已经收敛成极简结构。

它只保留一个共享的开放资产：

- `clients/repointel/`

这份 shared skill 是 Phase 1 多宿主接入的唯一源：

- Codex
- Claude Code
- OpenCode

都通过同一份 shared skill 接入本地 `repointel`，而不是各自维护一套 host-pack 目录。

这样做的原因是：

- premium 逻辑在 `KodaX-private` 的 `repointel` 工具里，不在 host 包装层里
- 多宿主接入本来就是薄层，不应该继续保留一堆 Windows-first 的历史壳目录
- 共享一个 skill 源更干净、更容易维护，也更符合当前 native-first 的发布方向

现在的标准使用方式是：

- 用 `clients/repointel/scripts/install.mjs` 把 shared skill 安装到目标宿主需要的位置
- 用 `clients/repointel/scripts/doctor.mjs` 检查本地 premium / daemon / host skill 安装状态
- 用 `clients/repointel/scripts/demo.mjs` 做本地演示和验证

示例：

```powershell
node .\clients\repointel\scripts\install.mjs --host codex
node .\clients\repointel\scripts\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\scripts\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

补充说明：

- 可安装的 skill 目录入口是 `clients/repointel/SKILL.md`
- `clients/repointel/` 整个目录遵循 Claude Code Skills 规范，`SKILL.md` 是入口，`reference.md` 是辅助参考文件
- `scripts/install.mjs`、`doctor.mjs`、`demo.mjs` 是仓库维护脚本，位于 `scripts/` 子目录
- 所以 `clients/repointel/` 现在承载的是完整的第三方宿主集成单元，而不只是一个单独的 skill 文件

也就是说：

- `clients/` 不是 build 产物
- 它现在也不再是“每个宿主一套安装包”
- 它只是存放 shared repointel skill 的正式源码位置

## 仓库结构

KodaX 是一个基于 npm workspaces 的 TypeScript monorepo。核心包：

| 包 | 作用 | 主要依赖 |
|----|------|---------|
| `@kodax/ai` | LLM 抽象层（12 个内置 provider + 自定义 provider 注册），可独立使用 | `@anthropic-ai/sdk`, `openai` |
| `@kodax/agent` | 通用 Agent 框架，会话管理 + tokenization + 可插拔 compaction policy | `@kodax/ai`, `js-tiktoken` |
| `@kodax/skills` | Agent Skills 标准实现（自然语言触发、变量解析） | 零外部依赖 |
| `@kodax/coding` | Coding Agent：30+ 工具、prompts、agent loop、auto-continue | `@kodax/ai`, `@kodax/agent`, `@kodax/skills` |
| `@kodax/repl` | 完整交互式终端 UI（Ink / React、权限模式、命令系统、流式渲染） | `@kodax/coding`, `ink`, `react` |

根目录 `src/kodax_cli.ts` 是 CLI 入口；构建产物在 `dist/`，单文件二进制在 `dist/binary/<target>/`。

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai
│   │   └── providers/       # 12 个 LLM provider 实现
│   ├── agent/               # @kodax/agent（session + token）
│   ├── skills/              # @kodax/skills
│   │   └── builtin/         # 内置 skills：code-review / tdd / git-workflow / skill-creator
│   ├── coding/              # @kodax/coding（tools + prompts）
│   │   └── tools/           # read/write/edit/bash/grep/repo-intel/MCP/worktree/...
│   └── repl/                # @kodax/repl（Ink TUI）
├── src/
│   └── kodax_cli.ts         # CLI 主入口
├── scripts/
│   └── build-binary.mjs     # Bun --compile 单文件二进制打包脚本
└── .github/workflows/
    └── release.yml          # 推 v* tag 自动发布 GitHub Release
```

这套拆分让你既可以把 KodaX 当成完整产品使用，也可以只复用其中某一层能力。
## API 导出

```typescript
// 主函数
export { runKodaX, KodaXClient };

// 类型
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// 工具
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Provider
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// 工具函数
export {
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## 术语说明

| 术语 | 含义 | 位置 |
|------|------|------|
| **Skills** | Agent 能力（KODAX_TOOLS: read, write, bash 等）+ 扩展 Skills | Coding 层 + Skills 层 |
| **Commands** | CLI 快捷命令（/review, /test 等） | REPL 层 |

---

## 开发

```bash
# 开发模式
npm run dev "你的任务"

# 构建
npm run build

# 可选：只构建 workspace packages
npm run build:packages

# 打包成单文件二进制（当前平台 / 全平台）
npm run build:binary
npm run build:binary:all

# 测试
npm test

# Eval-driven development（provider 矩阵、identity round-trip 等）
npm run test:eval

# 清理
npm run clean
```

### Repo Intelligence 缓存目录

KodaX 现在会把 Repo Intelligence 的本地缓存分成两条路径：

- `.agent/repo-intelligence/`
  - OSS baseline 的索引、缓存和现有 task-engine 产物。
- `.repointel/`
  - premium `repointel` 的 workspace 级共享缓存，供本地 daemon / native frontdoor 使用。

这样拆开的目的很明确：

- premium 不可用时，OSS fallback 仍然可以稳定工作。
- premium 缓存不会污染 OSS 产物目录。
- KodaX 和其他宿主可以共享同一份 premium workspace cache。

`.repointel/` 是本地生成目录，不应该提交到 Git。

---

## 文档

- [README.md](README.md) - 英文版 README
- [docs/release.md](docs/release.md) - 单文件二进制构建与发布流程
- [docs/PRD.md](docs/PRD.md) - 产品需求
- [docs/ADR.md](docs/ADR.md) - 架构决策
- [docs/HLD.md](docs/HLD.md) - 高层设计
- [docs/DD.md](docs/DD.md) - 详细设计
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature 跟踪
- [docs/test-guides/](docs/test-guides/) - 功能专用测试指南
- [CHANGELOG.md](CHANGELOG.md) - 更新日志（v0.7.0+；更早版本见 [CHANGELOG_ARCHIVE](docs/CHANGELOG_ARCHIVE.md)）


---

## 许可证

公共仓库当前采用：

- `Apache-2.0`

## 相关仓库

建议把公仓和私仓 clone 到同一个父目录下，例如：

- public repo: `<parent>/KodaX`
- private repo: `<parent>/KodaX-private`（未公开发布）
