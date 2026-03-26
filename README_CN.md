# InfCodeX

**InfCodeX** 是词元无限新一代 AI Coding CLI，也是一个面向真实软件工程执行的智能体运行时（Agent Runtime）。

它不是一个只会在终端里“对话补全”的工具，而是一个以 **执行闭环、工程可落地、平台可集成** 为核心目标构建的 TypeScript 原生系统：既可以作为 CLI 使用，也可以作为库嵌入到更大的智能体平台中。

> 当前仓库中仍保留历史命名：**KodaX / `kodax`**。仓库名已经是 **InfCodeX**，但部分代码、命令和文档仍沿用旧名称。

---

## 为什么 InfCodeX 很重要

很多 AICoding 工具更擅长做演示、做单轮回答、做局部辅助；而 InfCodeX 更值得强调的是，它从一开始就更靠近 **真实工程执行**。

它的重要性来自以下几个方面：

- **CLI 优先**：天然适合终端开发工作流
- **运行时架构**：不是单体工具，而是分层 Agent Runtime
- **项目连续性**：支持 session、长任务、自动续跑
- **安全可控**：具备权限模式与确认边界
- **模块化复用**：可作为 CLI，也可作为 npm library
- **多智能体演进路径**：具备 parallel、team、skills 等基础能力

对于词元无限而言，InfCodeX 的价值不只是一个开发者工具，而是一个 **工程执行型智能体底座**。

---

## 一句话定位

**InfCodeX 是一个面向真实软件工程交付的 AI Coding CLI，也是一个可复用、可扩展、可治理的智能体执行运行时。**

它同时承担两种角色：

1. **面向开发者的终端智能体**
   - 阅读仓库
   - 修改代码
   - 执行命令
   - 连续推进多步工程任务

2. **面向平台的执行层组件**
   - 可作为 npm package 被复用
   - 可被上层系统编排与调用
   - 可扩展 provider、tool、skill 和项目策略

---

## 核心特色

### 1. 清晰分层的模块化架构
InfCodeX 当前采用 monorepo 结构，核心分为五个包：

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`

这不是一个细节，而是这个项目最关键的差异点之一。它说明 InfCodeX 从设计上就不是“把所有东西揉成一个 CLI”，而是把 AI、Agent、Skills、Coding、交互层拆开，便于理解、复用、替换和治理。

### 2. CLI 与库双重使用形态
InfCodeX 既可以直接拿来做终端智能体，也可以被嵌入到其他产品或系统中。

这意味着它不是一个孤立的交互工具，而更像一个 **可被上层产品调用的执行引擎**。

### 3. 多 Provider / 多模型抽象
项目当前公开文档和配置中已经体现出多 Provider 抽象能力，内置支持包括：

- Anthropic
- OpenAI
- Kimi
- Kimi Code
- Qwen
- Zhipu
- Zhipu Coding
- MiniMax Coding
- Gemini CLI
- Codex CLI

这使得 InfCodeX 在以下场景中更有战略价值：

- 模型成本优化
- 国内外模型路由
- 私有化 / 代理部署
- 企业采购与合规适配
- 上层平台统一模型治理

### 4. 面向真实仓库执行，而不是只会回答
InfCodeX 的 Coding Layer 不是只生成文本，而是围绕工程动作组织起来的。当前文档中的工具包括：

- read
- write
- edit
- bash
- glob
- grep
- undo
- diff

这意味着它的核心价值不是“回答得像不像”，而是能否围绕代码仓库形成 **思考—行动—观察—继续推进** 的执行闭环。

### 5. 权限可控的自治能力
InfCodeX 设计了三级权限模式：

- `plan`
- `accept-edits`
- `auto-in-project`

这是一个非常重要的产品选择。它允许团队在效率与安全之间做渐进式平衡，而不是在“完全手动”和“完全放开”之间二选一。

### 6. 会话记忆与长任务连续推进
真实工程任务通常不是一轮 prompt 就能完成。InfCodeX 支持 session 持久化以及长任务工作流，因此更适合：

- 连续迭代一个 feature
- 跨多轮处理复杂问题
- 在中断后恢复上下文
- 在项目级别持续推进工作

### 7. Skills 驱动的专业化能力
InfCodeX 并不满足于通用 prompt，它内置并支持可发现的 skills、Markdown skill 定义、自然语言触发等能力。

这让它有机会从“通用 coding agent”进化为“面向特定工程场景的专业智能体”。

### 8. 天然具备向多智能体演化的路径
当前仓库中已经能看到它面向多智能体方向的基础能力，例如：

- parallel execution
- team mode
- init / auto-continue
- project mode 相关思路

这使 InfCodeX 的发展方向并不止于“单 agent CLI”，而是有潜力成为 **多智能体软件工程执行运行时**。

---

## 架构概览

```text
InfCodeX
├─ AI Layer        → Provider 抽象、流式输出、重试、能力适配
├─ Agent Layer     → Session、消息管理、Token 工具、压缩逻辑
├─ Skills Layer    → Skill 发现、注册、执行
├─ Coding Layer    → Tools、Prompts、Agent Loop、长任务工作流
└─ REPL / CLI      → 交互体验、权限控制、命令系统、Project 流程
```

这种分层设计的直接价值在于：

- **职责清晰**：每层边界明确
- **便于替换**：Provider、Runtime、UI 可以分层演进
- **便于测试**：更容易做独立测试和替换
- **便于复用**：不必所有能力都绑死在 CLI 上
- **便于平台化**：适合作为上层智能体系统的执行底座

### Package 概览

| Package | 职责 | 说明 |
|---------|------|------|
| `@kodax/ai` | Provider 抽象与模型适配 | 支持内置 provider 和兼容接口 |
| `@kodax/agent` | Session、消息、Token、压缩 | 可脱离 CLI 单独复用 |
| `@kodax/skills` | Skill 发现与执行 | 轻量专业化能力层 |
| `@kodax/coding` | Tools、Prompts、Coding Agent Loop | 执行闭环核心 |
| `@kodax/repl` | 终端 UI 与命令系统 | 权限交互和 REPL 体验层 |

### 依赖关系

```text
kodax CLI 入口
├─ @kodax/repl
│  └─ @kodax/coding
│     ├─ @kodax/ai
│     ├─ @kodax/agent
│     └─ @kodax/skills
└─ @kodax/coding
```

---

## 为什么说 InfCodeX 对 InfOne 很关键

InfOne 承载的是词元无限更长期的“智能组织 / AI org”平台愿景，强调的是：

- 如何打造多智能体组织
- 如何管理大规模智能体组织
- 如何让智能体形成可治理、可协同、可持续运转的组织能力

在这个体系里，InfCodeX 的位置非常明确，而且非常关键。

### InfOne 更像控制平面（Control Plane）
InfOne 更适合负责：

- 智能体注册与生命周期管理
- 模型路由与策略下发
- 组织级记忆与审计
- 权限、安全、观测与治理
- 大规模多智能体编排

### InfCodeX 更像执行平面（Execution Plane）
InfCodeX 更适合负责：

- 在代码仓库内真正执行任务
- 进行文件读写、命令调用、工程分析
- 按项目上下文持续推进编码任务
- 承接 SDLC 场景中的工程执行动作
- 作为终端形态或嵌入形态落地工程智能体

### 两者组合后的价值
如果只有管理层，没有执行层，平台容易停留在“管理看板”。
如果只有执行工具，没有管理层，CLI 很难上升为组织级能力。

**InfOne + InfCodeX** 的组合，恰好把这两层补齐：

- **InfOne** 解决“哪个智能体应该做什么、如何管理它们”
- **InfCodeX** 解决“软件工程任务如何被真正执行出来”

这就是 InfCodeX 的战略意义所在：
它不是一个孤立产品，而是连接 **开发者终端、仓库级执行、组织级智能体管理** 的关键桥梁。

---

## 典型使用场景

### 1. 终端里的工程助手
开发者在本地终端直接使用 InfCodeX 阅读仓库、修改代码、执行命令、推进任务。

### 2. 多步特性交付
一个特性开发不必被拆成一次性 prompt，而可以通过 session 与连续执行多轮推进。

### 3. 团队标准化工程智能体
团队可以叠加统一规则、技能、模型选择，使不同仓库和成员获得更一致的智能体行为。

### 4. SDLC 智能体执行底座
InfCodeX 可以作为编码执行层，未来承接代码生成、审查、测试、交付等更大 SDLC 智能体体系中的具体动作。

### 5. 企业渐进式落地
企业可以先从安全模式、权限模式、项目边界开始使用，再逐步走向更高自治。

---

## 能力概览

- TypeScript 原生实现
- Monorepo 分层架构
- CLI + Library 双形态
- Streaming 输出
- Thinking / Reasoning 模式
- Session 持久化
- 权限可控执行
- Skills 系统
- 并行执行
- Team 模式
- 长任务 / 自动续跑
- Windows / macOS / Linux 跨平台

---

## Project 模式（Harness Engineering）

从 KodaX 分支继承下来的最有辨识度的工作流，就是 **Project 模式 / harness engineering**。

它不是让 Agent 自己宣布“完成了”，而是把项目真相落盘，并通过 verifier-gated 步骤来推进执行。对于真实仓库的长周期任务，这种方式更可靠。

核心思路：

- `kodax --init "<任务>"` 初始化项目真相和计划工件
- `/project brainstorm` 先对齐范围
- `/project plan` 写出当前执行计划
- `/project next` 通过确定性门禁推进执行
- `/project verify` 和 `/project quality` 在接受结果前重新校验
- `kodax --auto-continue` 支持跨 session 持续推进

典型流程：

```bash
kodax --init "构建桌面应用"
kodax
/project status
/project brainstorm
/project plan
/project next
/project verify --last
/project quality
```

非 REPL 方式：

```bash
kodax --init "构建桌面应用"
kodax --auto-continue --max-hours 2
```

---

## 快速开始

### 运行要求

- Node.js `>=18.0.0`
- npm workspaces

### 1. 安装与构建

```bash
npm install
npm run build:packages
npm run build
npm link
```

### 2. 配置 Provider

内置 provider 的凭证通过环境变量读取：

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

如果需要自定义 `baseUrl` 或兼容 OpenAI / Anthropic 的接口：

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

# 单次 CLI 调用
kodax "审查这个仓库并总结架构"
kodax --session review "找出 src/ 中最危险的部分"
kodax --session review "给出具体修复建议"
```

### 4. 作为库接入

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

### 常见示例

```bash
# 会话记忆
kodax --session my-project "读取 package.json"
kodax --session my-project "总结一下"

# 并行执行
kodax --parallel "analyze and improve this module"

# team 模式
kodax --team "implement,review,test"

# 初始化长任务
kodax --init "deliver feature X"

# 自动持续推进
kodax --auto-continue --max-hours 2
```

---

## 权限模式

| 模式 | 含义 |
|------|------|
| `plan` | 只读规划模式 |
| `accept-edits` | 自动接受文件编辑，bash 仍需确认 |
| `auto-in-project` | 项目范围内全自动执行 |

这使得 InfCodeX 更适合严肃工程环境，因为它不是简单追求“越自动越好”，而是提供 **可信度渐进提升** 的使用路径。

---

## 详细使用方式

### REPL 快速开始

直接执行 `kodax` 会进入交互式 REPL：

```bash
kodax
```

进入后可以混合使用自然语言请求和斜杠命令：

```text
读取 package.json 并总结架构
/model
/mode
/help
```

### CLI 快速开始

```bash
# 基础用法
kodax "帮我创建一个 TypeScript 项目"

# 指定 provider 和模型
kodax --provider openai --model gpt-5.4 "创建一个 REST API"

# 使用更深的推理模式
kodax --reasoning deep "审查这份架构设计"
```

### Session 工作流

需要跨轮记忆时，使用 session：

```bash
# 无记忆：两次独立调用
kodax "读取 src/auth.ts"
kodax "总结一下"

# 有记忆：同一个 session
kodax --session auth-review "读取 src/auth.ts"
kodax --session auth-review "总结一下"
kodax --session auth-review "第一个问题怎么修复？"

# Session 管理
kodax --session list
kodax --session resume "继续"
```

### 工作流示例

```bash
# 代码审查
kodax --session review "审查 src/ 目录"
kodax --session review "重点看安全问题"
kodax --session review "给我修复建议"

# 项目开发
kodax --session todo-app "创建一个 Todo 应用"
kodax --session todo-app "加上删除功能"
kodax --session todo-app "补测试"
```

### CLI 参考

```text
kodax                  启动交互式 REPL
-h, --help [topic]     显示帮助或某个主题的帮助
-p, --print <text>     单次执行并退出
-c, --continue         继续当前目录最近一次会话
-r, --resume [id]      按 ID 或最近会话恢复
-m, --provider         指定 provider
--model <name>         覆盖默认模型
--reasoning <mode>     off | auto | quick | balanced | deep
-t, --thinking         兼容别名，等价于 --reasoning auto
-s, --session <op>     Session ID 或历史会话操作
-j, --parallel         启用并行工具执行
--team <tasks>         多子 Agent 并行
--init <task>          初始化长任务
--auto-continue        自动持续推进直到完成
--max-iter <n>         最大迭代次数
--max-sessions <n>     --auto-continue 的最大会话数
--max-hours <n>        --auto-continue 的最长运行小时数
```

### 帮助主题

```bash
kodax -h sessions
kodax -h init
kodax -h project
kodax -h auto
kodax -h provider
kodax -h thinking
kodax -h team
kodax -h print
```

---

## 高级库用法

### `runKodaX` 简单模式

```typescript
import { runKodaX, type KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`推理增量: ${text.length} 字符`),
  onToolResult: (result) => console.log(`工具 ${result.name}`),
  onComplete: () => console.log('\n完成!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'auto',
    context: {
      gitRoot: '/repo',
      executionCwd: '/repo/packages/service',
    },
    events,
  },
  '1+1 等于几？'
);

console.log(result.lastText);
```

### `KodaXClient` 连续会话模式

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

await client.send('读取 package.json');
await client.send('总结一下');

console.log(client.getSessionId());
```

### 自定义 Session 存储

```typescript
import { type KodaXMessage, type KodaXSessionStorage } from 'kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // 保存到自定义存储
  }

  async load(id: string) {
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo',
  },
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { /* ... */ },
}, 'task');
```

### 两种模式对比

| 特性 | `runKodaX` | `KodaXClient` |
|------|------------|---------------|
| 消息记忆 | 无 | 有 |
| 调用方式 | 函数 | 类实例 |
| 上下文 | 每次独立 | 持续累积 |
| 适用场景 | 单次任务、批处理 | 多步骤、交互式工作流 |

### 工作目录语义

`runKodaX()` 区分两个相关但不同的概念：

- `context.gitRoot`：项目根目录，用于项目级 prompt 和权限逻辑。
- `context.executionCwd`：执行工作目录，用于 prompt 上下文、工具相对路径和 Shell 执行。

如果省略 `executionCwd`，KodaX 会回退到 `gitRoot`，然后是 `process.cwd()`。

```typescript
await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo/packages/web',
  },
}, '审查当前包并运行本地检查');
```

这在 monorepo 中特别有用——项目根目录和活跃的包目录往往不是同一个。

---

## 使用独立 Package

InfCodeX 仍然保留了 KodaX 分支里很重要的模块化能力。很多场景下你不需要整套 CLI，只需要其中某一层。

### `@kodax/ai` — LLM 抽象层

独立的 LLM Provider 抽象，可在任何项目中复用：

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax/ai';

// 获取 provider 实例
const provider = getProvider('anthropic');

// 流式补全
const stream = await provider.streamCompletion(
  [{ role: 'user', content: 'Hello!' }],
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

**核心能力**：11 个 LLM provider 统一接口、流式输出、推理模式支持、错误处理与重试。

### `@kodax/agent` — Agent 框架

通用 Agent 框架，包含会话管理：

```typescript
import {
  generateSessionId,
  estimateTokens,
  compactMessages,
  type KodaXMessage
} from '@kodax/agent';

// 生成 session ID
const sessionId = generateSessionId();

// 估算 token
const tokens = estimateTokens(messages);

// 上下文过长时压缩消息
if (tokens > 100000) {
  const compacted = await compactMessages(messages, {
    threshold: 75000,
    keepRecent: 20
  });
}
```

**核心能力**：Session ID 生成与标题提取、Token 估算（基于 tiktoken）、AI 摘要式消息压缩。

### `@kodax/skills` — Skills 系统

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

### `@kodax/coding`

适合需要完整 Coding Agent Loop、工具执行和 Prompt 体系的场景。

### `@kodax/repl`

适合需要终端交互 UI、斜杠命令和权限交互体验的场景。

---

## 支持的 Provider

| Provider | 环境变量 | 推理支持 | 默认模型 |
|----------|----------|----------|----------|
| `anthropic` | `ANTHROPIC_API_KEY` | 原生 budget | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | 原生 effort | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` 原生切换；`deepseek-reasoner` 模型选择推理 | `deepseek-chat` |
| `kimi` | `KIMI_API_KEY` | 原生 effort | `k2.5` |
| `kimi-code` | `KIMI_API_KEY` | 原生 budget | `k2.5` |
| `qwen` | `QWEN_API_KEY` | 原生 budget | `qwen3.5-plus` |
| `zhipu` | `ZHIPU_API_KEY` | 原生 budget | `glm-5` |
| `zhipu-coding` | `ZHIPU_API_KEY` | 原生 budget | `glm-5` |
| `minimax-coding` | `MINIMAX_API_KEY` | 原生 budget | `MiniMax-M2.7` |
| `gemini-cli` | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| `codex-cli` | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

### Provider 示例

```bash
# 使用智谱 Coding
kodax --provider zhipu-coding --thinking "帮我优化这段代码"

# 使用 OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "创建一个 REST API"

# 使用 DeepSeek
export DEEPSEEK_API_KEY=your_key
kodax --provider deepseek "总结这个仓库"
kodax --provider deepseek --model deepseek-reasoner "思考一下这个重构方案"

# 恢复最近一次会话
kodax --session resume

# 列出所有会话
kodax --session list

# 并行工具执行
kodax --parallel "Read package.json and tsconfig.json"

# Agent 团队
kodax --team "分析代码结构,检查测试覆盖率,查找 Bug"

# 长时间项目
kodax --init "构建一个 Todo 应用"
kodax --auto-continue --max-hours 2
```

---

## 工具列表

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容，支持 offset / limit |
| `write` | 写文件 |
| `edit` | 精确字符串替换，支持 `replace_all` |
| `bash` | 执行 Shell 命令 |
| `glob` | 文件模式匹配 |
| `grep` | 内容搜索 |
| `undo` | 撤销上一次修改 |
| `ask_user_question` | 向用户发起选项问题 |

---

## Skills 系统

KodaX 分支中更完整的 Skills 说明，在 InfCodeX 中仍然适用。

示例：

```bash
kodax "帮我审查这段代码"
kodax "给这个模块写测试"
kodax /skill:code-review
```

内置 Skills 包括：

- `code-review`
- `tdd`
- `git-workflow`

自定义 Skills 可以放在 `~/.kodax/skills/` 下。

---

## Commands

Commands 是 CLI / REPL 里的 `/xxx` 快捷命令。

```bash
kodax /review src/auth.ts
kodax /test
```

Command 定义位于 `~/.kodax/commands/`：

- `.md` 文件用于提示词命令
- `.ts` / `.js` 文件用于可编程命令

---

## 配置体系

仓库内置了完整的配置模板，支持：

- 默认 provider 选择
- provider 下的 model 选择
- provider model override
- 自定义 provider 定义
- 统一 reasoning mode
- compaction 压缩配置
- permission mode 默认值

当前文档中的配置文件路径是：

```text
~/.kodax/config.json
```

完整模板可参考 `config.example.jsonc`。

---

## 开发

```bash
# 开发模式
npm run dev "你的任务"

# 构建所有包
npm run build:packages

# 构建根 CLI
npm run build

# 测试
npm test

# 清理生成产物
npm run clean
```

---

## 设计哲学

InfCodeX 体现出一套相对清晰的设计哲学：

- **透明优于黑盒**
- **可组合优于单体封装**
- **执行优于对话表演**
- **可治理优于无边界自动化**
- **可演进优于一次性工具化**

这正是它为什么不仅能做 CLI，还能成为更大工程智能体体系基础设施的原因。

---

## 演进方向

结合当前仓库结构和已有文档，InfCodeX 很自然的后续方向包括：

- 更强的多智能体协同
- 更多内置 skills
- 更成熟的插件 / 扩展能力
- 更深的 SDLC 集成
- IDE / Web 形态扩展
- 与 InfOne 的更紧密协同

---

## 仓库说明

当前仓库仍处于快速演进阶段，因此存在一些文档与实现前后不完全一致的地方，例如：

- `InfCodeX` 与 `KodaX` 命名并存
- 有些文档还写 7 个 provider，但更新后的 README / config 已展示 10 个内置 provider
- 包名和 CLI 命令仍是 `kodax`

因此，这份 README 更强调 **稳定的架构事实**，同时保留了 KodaX 分支中对日常使用非常有价值的详细说明。

---

## 相关文档

- [English README](./README.md)
- [Architecture Overview](./docs/ARCHITECTURE_OVERVIEW.md)
- [架构概览（中文）](./docs/ARCHITECTURE_OVERVIEW_CN.md)
- [InfCodeX + InfOne Positioning](./docs/PROJECT_POSITIONING.md)
- [InfCodeX + InfOne 定位说明](./docs/PROJECT_POSITIONING_CN.md)
- [Feature List](./docs/FEATURE_LIST.md)
- [特性发布说明索引](./docs/features/README.md)
- [贡献指南](./CONTRIBUTING.md)
- [更新日志](./CHANGELOG.md)

---

## 许可证

[Apache License 2.0](./LICENSE)

---

## 总结

**InfCodeX 的重要性不在于它是另一个 CLI，而在于它有机会成为软件工程智能体真正的执行底座。**

对今天，它是一个执行力很强的 AI Coding CLI。
对未来，它可以成为词元无限更大智能体组织体系中最关键的工程执行节点之一。
