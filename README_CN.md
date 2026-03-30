# KodaX

<div align="center">

**一个真正好用的轻量级 AI 编程助手（TypeScript 版本）。**

5层模块化架构 • 10 个大模型 • 流式输出 • 并行执行 • 长运行模式 • 可作为库使用

[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

---

## 为什么选择 KodaX？

**透明** • **灵活** • **强大** • **类型安全**

KodaX 是 KodaXP 的 TypeScript 版本，专为想要**理解**、**定制**和**掌控** AI 编程助手的开发者设计，也包含一套很有辨识度的 **Project 模式 / harness engineering** 工作流，用来处理长周期编码任务。

| 对比项 | KodaX | 其他工具 |
|--------|--------|----------|
| **架构** | 5层模块化，每层可独立使用 | 通常只能作为 CLI 使用 |
| **代码** | 清晰分离，易于理解和定制 | 成千上万文件，难以理解 |
| **类型** | TypeScript 原生类型安全 | 无类型或弱类型 |
| **模型** | 10 个 LLM 供应商，随意切换 | 通常只支持单一供应商 |
| **成本** | 可用便宜的国内模型（Kimi、智谱、通义） | 往往需要昂贵订阅 |
| **长运行** | Feature 跟踪 + 自动继续 | 通常需要人工监督 |
| **定制** | 直接修改代码即可 | 复杂的插件系统 |
| **学习** | 完美适合理解 Agent 原理 | 黑盒 |

**适合使用 KodaX 的场景：**
- 想要**学习** AI 编程 Agent 的工作原理
- 需要**灵活切换**多个 LLM 供应商
- 想要**定制** Agent 以适应自己的工作流
- 需要**长运行**自主开发能力
- **作为库集成**到自己的项目中
- 偏好 **TypeScript/Node.js** 生态

**和 Claude Code / 纯 SDK 的区别：**

| 问题 | KodaX 的答案 |
|------|--------------|
| 为什么不直接用 Claude Code？ | KodaX 更容易自托管、替换模型、查看实现、按需修改。 |
| 为什么不直接用 SDK？ | KodaX 已经把 CLI、会话、工具、权限控制、Skills 串成了可直接使用的一套。 |
| 为什么适合拿来改？ | 代码规模更小，模块边界清晰，读完就能动手改。 |
| 为什么适合集成到自己的产品？ | provider、agent、skills、REPL 是分层的，可以只复用其中一层。 |

## 快速开始

### 1. 安装并构建

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build:packages
npm run build
npm link
```

### 2. 配置 provider

内置 provider 的 API Key 走环境变量：

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

CLI 默认配置可以写到 `~/.kodax/config.json`：

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto"
}
```

如果你需要自定义 `baseUrl`、代理地址或 OpenAI / Anthropic 兼容接口，可以在同一个配置文件里声明 `customProviders`：

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model"
    }
  ]
}
```

### 3. 进入 REPL 或执行单次任务

```bash
# 交互式 REPL
kodax

# 进入后可以直接输入自然语言或命令
读取 package.json 并总结架构
/mode
/help

# Project 模式 / Harness Engineering
kodax --init "桌面应用"
kodax
/project brainstorm
/project plan
/project next

# 单次命令行调用
kodax "审查这个仓库并总结架构"
kodax --session review "找出 src/ 里最危险的部分"
kodax --session review "给出具体修复建议"
```

### 4. 作为库接入

库模式下，API Key 仍然建议走环境变量；如果要在代码里声明 provider 别名或自定义 base URL，用 `registerCustomProviders()`：

```typescript
import { registerCustomProviders, runKodaX } from 'kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
  },
]);

const result = await runKodaX(
  {
    provider: 'my-openai-compatible',
    reasoningMode: 'auto',
  },
  '解释这个代码库'
);
```

## Project 模式（Harness Engineering）

KodaX 最有辨识度的能力，其实不是“再一个 coding agent”，而是 **Project 模式**: 一套面向长期开发任务的 harness engineering 工作流。

它不是让 Agent 自己宣布“完成了”，而是把项目事实落盘，并通过确定性的校验环节去约束执行。这个工作流同时覆盖非 REPL 初始化命令和 REPL 内的 `/project` 命令。

**它的特别之处**

- **Verifier-gated execution**: `/project next` 和 `/project auto` 不是自报完成，而是经过 harness 校验。
- **项目真相文件**: 初始化后会维护 `feature_list.json` 以及 `.agent/project/` 下的一组项目管理文件。
- **结构化规划**: `/project brainstorm` 用来对齐需求，`/project plan` 会写出当前执行计划。
- **质量关卡**: `/project quality` 和 `/project verify` 会在你接受结果前重新跑确定性检查。

**典型流程**

```bash
kodax --init "桌面应用"
kodax
/project brainstorm
/project plan
/project next
/project quality
```

**非 REPL 方式**

```bash
kodax --init "桌面应用"
kodax --auto-continue --max-hours 2
```

---

## 架构

KodaX 使用 **monorepo 架构**，基于 npm workspaces，由 5 个独立的包组成：

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - 独立的 LLM 抽象层
│   │   └── providers/       # 10 个 LLM 提供商 (Anthropic, OpenAI, etc.)
│   │
│   ├── agent/               # @kodax/agent - 通用 Agent 框架
│   │   └── session/         # 会话管理、消息处理
│   │
│   ├── skills/              # @kodax/skills - Skills 标准实现
│   │   └── builtin/         # 内置 skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent（工具 + Prompts）
│   │   └── tools/           # 8 个工具: read, write, edit, bash, glob, grep, undo, ask_user_question
│   │
│   └── repl/                # @kodax/repl - 完整的交互式终端
│       ├── ui/              # Ink/React 组件、主题
│       └── interactive/     # 命令、REPL 逻辑
│
├── src/
│   └── kodax_cli.ts         # 主 CLI 入口点
│
└── package.json             # 根 workspace 配置
```

### 包依赖关系

```
                    ┌─────────────────┐
                    │   kodax (root)  │
                    │   CLI 入口      │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
       ┌─────────────┐               ┌─────────────┐
       │ @kodax/repl │               │@kodax/coding│
       │   UI 层     │               │ 工具+Prompts │
       └──────┬──────┘               └──────┬──────┘
              │                             │
              │              ┌──────────────┼──────────────┐
              │              │              │              │
              ▼              ▼              ▼              ▼
       ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
       │@kodax/skills│ │ @kodax/agent│ │  @kodax/ai  │ │   外部 SDK  │
       │ (零依赖)    │ │ Agent 框架  │ │ LLM 抽象层  │ │             │
       └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

### 包结构

| 包 | 用途 | 关键依赖 |
|----|------|---------|
| `@kodax/ai` | 独立的 LLM 抽象层，可被其他项目复用 | @anthropic-ai/sdk, openai |
| `@kodax/agent` | 通用 Agent 框架，会话管理 | @kodax/ai, js-tiktoken |
| `@kodax/skills` | Skills 标准实现 | 零外部依赖 |
| `@kodax/coding` | Coding Agent，包含工具和 Prompts | @kodax/ai, @kodax/agent, @kodax/skills |
| `@kodax/repl` | 完整的交互式终端 UI | @kodax/coding, ink, react |

### 两种使用方式

```
┌─────────────────────────────────────────────────────────────┐
│  方式 1: CLI 命令行                                          │
│                                                              │
│  kodax "你的任务"                                            │
│                                                              │
│  入口: package.json "bin" → dist/kodax_cli.js               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  方式 2: 库引用                                              │
│                                                              │
│  import { runKodaX } from 'kodax';                          │
│                                                              │
│  入口: packages/coding/dist/index.js                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 特性

- **5层模块化架构** - 每层可独立使用，可作为库
- **10 个模型** - Anthropic, OpenAI, Gemini CLI, Codex CLI, Kimi, Kimi Code, 智谱, 智谱 Coding, 通义千问, Minimax
- **推理模式** - 统一的 `off/auto/quick/balanced/deep` 推理接口
- **流式输出** - 实时显示，不用等待
- **8 个工具** - read, write, edit, bash, glob, grep, undo, ask_user_question
- **会话记忆** - 对话跨次保存
- **Project 模式 / Harness Engineering** - 带项目真相文件和 `/project` 命令的 verifier-gated 长周期工作流
- **Skills 系统** - 自然语言触发，可扩展
- **权限控制** - 3 种权限模式，支持命令模式匹配
- **跨平台** - 支持 Windows、macOS 和 Linux
- **TypeScript 原生** - 完整的类型安全和 IDE 支持

---

## 安装

### 作为 CLI 工具

```bash
# 克隆仓库
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# 安装依赖（包含 workspace 包）
npm install

# 构建所有包
npm run build:packages
npm run build

# 全局链接（推荐）
npm link

# 现在可以在任何目录使用
kodax "你的任务"
```

### 作为库使用

```bash
npm install kodax
```

```typescript
import { runKodaX } from 'kodax';

process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? 'your_api_key';

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
}, '你的任务');
```

如果是 CLI 用户，默认 provider / model / reasoning 建议放在 `~/.kodax/config.json`。如果是库用户，API Key 仍建议走环境变量；需要自定义 `baseUrl` 或 provider 别名时，使用上面的 `registerCustomProviders()`。

---

## CLI 使用

### REPL 快速开始

不带 prompt 直接执行 `kodax`，会进入交互式 REPL。

```bash
kodax
```

进入 REPL 后可以直接输入自然语言请求或斜杠命令：

```text
读取 package.json 并总结架构
/model
/mode
/help
```

### 命令行快速开始

```bash
# 单次任务
kodax "读取 package.json 并总结"

# 指定 provider
kodax --provider zhipu-coding "帮我写一个函数"

# 开启更深的推理模式
kodax --reasoning deep "分析这段代码的问题"
```

### 会话工作流

```bash
# 无记忆：两次独立调用
kodax "读取 src/auth.ts"
kodax "总结一下"

# 有记忆：同一个 session
kodax --session my-project "读取 package.json"
kodax --session my-project "总结一下"
kodax --session my-project "第一个问题怎么修复"

# 列出所有会话
kodax --session list

# 恢复最近的会话
kodax --session resume "继续"
```

### 常见工作流

```bash
# 代码审查（多轮对话）
kodax --session review "审查 src/ 目录的代码"
kodax --session review "重点关注安全问题"
kodax --session review "给我修复建议"

# 项目开发（持续会话）
kodax --session todo-app "创建一个 Todo 应用"
kodax --session todo-app "添加删除功能"
kodax --session todo-app "写测试"

# 长时间任务
kodax --init "构建一个 REST API"
kodax --auto-continue
```

### Project 模式 / Harness Engineering

Project 模式把初始化命令和 REPL 内的 `/project` 命令串成一条线：

```bash
# 初始化项目真相文件
kodax --init "构建一个桌面应用"

# 进入 REPL，走 verifier-gated 工作流
kodax
/project status
/project brainstorm
/project plan
/project next
/project verify --last
/project quality

# 或者直接使用非 REPL 自动循环
kodax --auto-continue --max-hours 2
```

### 权限控制

KodaX 提供 3 种权限模式，支持精细控制：

| 模式 | 说明 | 需要确认的工具 |
|------|------|----------------|
| `plan` | 只读计划模式 | 所有修改工具被阻止 |
| `accept-edits` | 自动接受文件编辑 | 仅 bash |
| `auto-in-project` | 项目内全自动 | 无（仅限项目范围） |

```bash
# 在 REPL 中使用 /mode 命令
/mode plan          # 切换到计划模式（只读）
/mode accept-edits  # 切换到接受编辑模式
/mode auto-in-project  # 切换到项目内全自动模式
/auto                  # auto-in-project 的别名

# 查看当前模式
/mode
```

**高级功能：**
- 在 `accept-edits` 模式下，选择 "always" 会持久化安全 Bash 规则
- 计划模式会在系统提示中告知 LLM 只读限制
- 永久保护区域：`.kodax/`、`~/.kodax/`、项目外路径
- 命令模式匹配：允许特定 Bash 命令（如 `Bash(npm install)`）
- 统一 diff 显示：write/edit 操作显示差异

### 命令选项

| 选项 | 说明 |
|------|------|
| `kodax` | 启动交互式 REPL |
| `-h, --help [topic]` | 显示帮助，或指定主题的详细帮助 |
| `-p, --print <text>` | 单次执行并退出 |
| `-c, --continue` | 继续当前目录最近一次对话 |
| `-r, --resume [id]` | 恢复指定会话，或恢复最近会话 |
| `-m, --provider <name>` | 指定 provider |
| `--model <name>` | 覆盖默认模型 |
| `--reasoning <mode>` | 推理模式：`off/auto/quick/balanced/deep` |
| `-t, --thinking` | 兼容别名，等价于 `--reasoning auto` |
| `-s, --session <op>` | 指定 session ID 或历史会话操作 |
| `-j, --parallel` | 并行执行工具 |
| `--team <tasks>` | 多子 Agent 并行 |
| `--init <task>` | 初始化长时间运行任务 |
| `--auto-continue` | 自动继续直到任务完成或被阻塞 |
| `--max-iter <n>` | 最大迭代次数 |
| `--max-sessions <n>` | `--auto-continue` 的最大会话数 |
| `--max-hours <n>` | `--auto-continue` 的最大运行小时数 |

### CLI 帮助主题

获取特定主题的详细帮助：

```bash
# 基本帮助
kodax -h
kodax --help

# 详细主题帮助
kodax -h sessions      # 会话管理详解
kodax -h init          # 长时间运行任务初始化
kodax -h project       # Project 模式 / Harness 工作流
kodax -h auto          # 自动继续模式
kodax -h provider      # LLM 供应商配置
kodax -h thinking      # 思考/推理模式
kodax -h team          # 多 Agent 并行执行
kodax -h print         # 打印配置
```

---

## 库使用

### 简单模式（runKodaX）

每次调用独立，无记忆：

```typescript
import { runKodaX, KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`推理增量: ${text.length} 字符`),
  onToolResult: (result) => console.log(`工具 ${result.name}`),
  onComplete: () => console.log('\n完成!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events,
}, '1+1等于几？');

console.log(result.lastText);
```

### 连续会话模式（KodaXClient）

共享消息历史，有上下文记忆：

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (t) => process.stdout.write(t),
  },
});

// 第一次对话
await client.send('读取 package.json');

// 第二次对话 - Agent 知道上下文
await client.send('总结一下');

// 第三次对话 - 继续同一会话
await client.send('作者是谁？');

console.log(client.getSessionId());
console.log(client.getMessages());
```

### 自定义会话存储

```typescript
import { runKodaX, KodaXSessionStorage, KodaXMessage } from 'kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // 保存到数据库
  }
  async load(id: string) {
    // 从数据库加载
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { ... },
}, '任务');
```

### 两种模式对比

| 特性 | runKodaX | KodaXClient |
|------|----------|-------------|
| **消息记忆** | ❌ 无 | ✅ 有 |
| **调用方式** | 函数 | 类实例 |
| **上下文** | 每次独立 | 持续累积 |
| **适用场景** | 单次任务、批处理 | 交互对话、多步骤任务 |

---

## 使用独立的 Package

KodaX 采用模块化架构，每个 package 都可以独立使用：

### @kodax/ai - LLM 抽象层

独立的 LLM Provider 抽象，可在任何项目中复用：

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax/ai';

// 获取 provider 实例
const provider = getProvider('anthropic');

// 流式完成
const stream = await provider.streamCompletion(
  [{ role: 'user', content: '你好！' }],
  { onTextDelta: (text) => process.stdout.write(text) }
);

for await (const result of stream) {
  if (result.type === 'text') {
    // 处理文本增量
  } else if (result.type === 'tool_use') {
    // 处理工具调用
  }
}
```

**核心特性**:
- 10 个 LLM Provider，统一接口
- 流式输出支持
- 推理模式支持
- 错误处理和重试逻辑
- 零业务逻辑依赖

### @kodax/agent - Agent 框架

通用 Agent 框架，包含会话管理：

```typescript
import {
  generateSessionId,
  estimateTokens,
  compactMessages,
  type KodaXMessage
} from '@kodax/agent';

// 生成会话 ID
const sessionId = generateSessionId();

// 估算 tokens
const tokens = estimateTokens(messages);

// 当上下文过长时压缩消息
if (tokens > 100000) {
  const compacted = await compactMessages(messages, {
    threshold: 75000,
    keepRecent: 20
  });
}
```

**核心特性**:
- 会话 ID 生成和标题提取
- Token 估算（基于 tiktoken）
- AI 辅助的消息压缩
- 消息类型和常量

### @kodax/skills - Skills 系统

Agent Skills 标准实现，零外部依赖：

```typescript
import {
  SkillRegistry,
  discoverSkills,
  executeSkill,
  type SkillContext
} from '@kodax/skills';

// 从路径发现 skills
const skills = await discoverSkills(['/path/to/skills']);

// 初始化注册表
const registry = getSkillRegistry();
await registry.registerSkills(skills);

// 执行 skill
const context: SkillContext = {
  skillId: 'code-review',
  arguments: { target: 'src/' },
  workingDirectory: process.cwd()
};

const result = await executeSkill(context);
```

**核心特性**:
- 零外部依赖
- 基于 Markdown 的 skill 文件
- 自然语言触发
- 变量解析
- 包含内置 skills

### @kodax/coding - Coding Agent

完整的编程 Agent，包含工具和提示词：

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax/coding';

// 使用 runKodaX 处理单次任务
const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text)
  }
}, '读取 package.json 并解释依赖');

// 或使用 KodaXClient 进行连续会话
const client = new KodaXClient({
  provider: 'anthropic',
  reasoningMode: 'auto',
  events: { ... }
});

await client.send('创建一个新文件');
await client.send('添加一个函数'); // 有之前消息的上下文
```

**核心特性**:
- 8 个内置工具（read, write, edit, bash, glob, grep, undo, ask_user_question）
- 编程任务的系统提示词
- Agent 循环实现
- 会话管理
- 自动继续模式

### @kodax/repl - 交互式终端 UI

完整的交互式 REPL，基于 Ink/React：

```typescript
// 通常作为 CLI 使用，但也可以集成
import { InkREPL } from '@kodax/repl';

// REPL package 提供：
// - 交互式终端 UI
// - 权限控制（4 种模式）
// - 命令系统（/help, /mode 等）
// - Skills 集成
// - 主题支持
```

**核心特性**:
- 基于 Ink 的 React 组件
- 3 种权限模式
- 内置命令
- 实时流式显示
- 上下文使用指示器

### Package 依赖关系

```
@kodax/ai (零业务依赖)
    ↓
@kodax/agent (依赖 @kodax/ai)
    ↓
@kodax/skills (零外部依赖)  →  @kodax/coding (依赖 ai, agent, skills)
                                        ↓
                                  @kodax/repl (依赖 coding, ink, react)
```

**导入建议**:

| 使用场景 | Package | 原因 |
|---------|---------|------|
| 只需要 LLM 抽象 | `@kodax/ai` | 最小依赖 |
| 构建自定义 Agent | `@kodax/agent` | 会话 + 消息 + 分词 |
| 使用 Skills 系统 | `@kodax/skills` | 零依赖，纯 skills |
| 编程任务 | `@kodax/coding` | 完整的编程 Agent |
| 终端应用 | `@kodax/repl` | 完整交互体验 |

---

## 支持的模型

| Provider | 环境变量 | 推理支持 | 默认模型 |
|----------|----------|----------|----------|
| `zhipu-coding` | `ZHIPU_API_KEY` | 原生 | `glm-5` |
| `zhipu` | `ZHIPU_API_KEY` | 原生 | `glm-5` |
| `kimi-code` | `KIMI_API_KEY` | 原生 | `k2.5` |
| `kimi` | `KIMI_API_KEY` | 原生 | `k2.5` |
| `anthropic` | `ANTHROPIC_API_KEY` | 原生 | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | 原生 | `gpt-5.3-codex` |
| `qwen` | `QWEN_API_KEY` | 原生 | `qwen3.5-plus` |
| `minimax-coding` | `MINIMAX_API_KEY` | 原生 | `MiniMax-M2.5` |
| `gemini-cli` | `GEMINI_API_KEY` | prompt-only / CLI bridge | `gemini-cli` |
| `codex-cli` | `OPENAI_API_KEY` | prompt-only / CLI bridge | `codex-cli` |

---

## 工具列表

| 工具 | 说明 |
|------|------|
| read | 读取文件内容（支持 offset/limit） |
| write | 写入文件 |
| edit | 精确字符串替换（支持 replace_all） |
| bash | 执行 Shell 命令 |
| glob | 文件模式匹配 |
| grep | 内容搜索（支持 output_mode） |
| undo | 撤销最后修改 |
| ask_user_question | 向用户发起多选问题 |

---

## Skills 系统

KodaX 包含内置的 Skills 系统，支持自然语言触发：

```bash
# 自然语言触发（无需显式调用 /skill）
kodax "帮我审查代码"           # 触发 code-review skill
kodax "写测试用例"             # 触发 tdd skill
kodax "提交代码"               # 触发 git-workflow skill

# 显式 skill 命令
kodax /skill code-review
```

内置 Skills：
- **code-review** - 代码审查和质量分析
- **tdd** - 测试驱动开发工作流
- **git-workflow** - Git 提交和工作流自动化

Skills 存储在 `~/.kodax/skills/`，可以用自定义 skills 扩展。

---

## Commands（/xxx 快捷命令）

Commands 是 CLI 中的 `/xxx` 快捷方式：

```bash
kodax /review src/auth.ts
kodax /test
kodax /explain src/utils.ts
```

Commands 定义在 `~/.kodax/commands/`：
- `.md` 文件 → 提示词命令（内容作为提示词）
- `.ts/.js` 文件 → 可编程命令

---

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
  estimateTokens, compactMessages,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal, checkAllFeaturesComplete, getFeatureProgress
};
```

---

## 术语说明

| 术语 | 含义 | 位置 |
|------|------|------|
| **Skills** | Agent 能力（KODAX_TOOLS: read, write, bash 等）+ 扩展 Skills | Coding 层 + Skills 层 |
| **Commands** | CLI 快捷命令（/review, /test 等） | REPL 层 |

---

## 长时间运行任务

对于需要跨多个 session 完成的复杂项目：

```bash
# 初始化
kodax --init "构建 REST API"

# 自动继续直到完成
kodax --auto-continue

# 自定义限制
kodax --auto-continue --max-sessions 20 --max-hours 4.0
```

---

## 开发

```bash
# 开发模式
npm run dev "你的任务"

# 构建所有包
npm run build:packages

# 构建
npm run build

# 测试
npm test

# 清理
npm run clean
```

---

## 文档

- [设计文档](DESIGN.md) - 架构和实现细节
- [长时间运行指南](LONG_RUNNING_GUIDE.md) - `--init` 最佳实践
- [测试指南](TESTING.md) - 如何测试所有功能
- [test-guides/](test-guides/) - 功能专用测试指南
- [更新日志](../CHANGELOG.md) - 版本历史


---

## 许可证

[Apache License 2.0](LICENSE) - Copyright 2026 [icetomoyo](mailto:icetomoyo@gmail.com)
