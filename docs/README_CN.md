# KodaX

<div align="center">

**一个真正好用的轻量级 AI 编程助手（TypeScript 版本）。**

5层模块化架构 • 7 个大模型 • 流式输出 • 并行执行 • 长运行模式 • 可作为库使用

[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## 为什么选择 KodaX？

**透明** • **灵活** • **强大** • **类型安全**

KodaX 是 KodaXP 的 TypeScript 版本，专为想要**理解**、**定制**和**掌控** AI 编程助手的开发者设计。

| 对比项 | KodaX | 其他工具 |
|--------|--------|----------|
| **架构** | 5层模块化，每层可独立使用 | 通常只能作为 CLI 使用 |
| **代码** | 清晰分离，易于理解和定制 | 成千上万文件，难以理解 |
| **类型** | TypeScript 原生类型安全 | 无类型或弱类型 |
| **模型** | 7 个 LLM 供应商，随意切换 | 通常只支持单一供应商 |
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

---

## 架构

KodaX 使用 **monorepo 架构**，基于 npm workspaces，由 5 个独立的包组成：

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - 独立的 LLM 抽象层
│   │   └── providers/       # 7 个 LLM 提供商
│   │
│   ├── agent/               # @kodax/agent - 通用 Agent 框架
│   │   └── session/         # 会话管理、消息处理
│   │
│   ├── skills/              # @kodax/skills - Skills 标准实现
│   │   └── builtin/         # 内置 skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent（工具 + Prompts）
│   │   └── tools/           # 8 个工具: read, write, edit, bash, glob, grep, undo, diff
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
- **7 个模型** - Anthropic, OpenAI, Kimi, Kimi Code, 智谱, 智谱 Coding, 通义千问
- **思考模式** - 复杂任务的深度推理（部分模型支持）
- **流式输出** - 实时显示，不用等待
- **8 个工具** - read, write, edit, bash, glob, grep, undo, diff
- **会话记忆** - 对话跨次保存
- **Skills 系统** - 自然语言触发，可扩展
- **权限控制** - 4 级模式，支持命令模式匹配
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

const result = await runKodaX({
  provider: 'zhipu-coding',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
}, '你的任务');
```

---

## CLI 使用

### 基本用法

```bash
# 单次任务
kodax "读取 package.json 并总结"

# 指定 provider
kodax --provider zhipu-coding "帮我写一个函数"

# 开启 thinking 模式
kodax --thinking "分析这段代码的问题"
```

### 会话模式（有记忆）

```bash
# 开始一个会话，指定 session ID
kodax --session my-project "读取 package.json"

# 继续同一个会话（有上下文记忆）
kodax --session my-project "总结一下"

# 列出所有会话
kodax --session list

# 恢复最近的会话
kodax --session resume "继续"
```

### 无记忆 vs 有记忆

```bash
# ❌ 无记忆：两次独立调用
kodax "读取 src/auth.ts"           # Agent 读文件并回复
kodax "总结一下"                    # Agent 不知道要总结什么

# ✅ 有记忆：同一 session
kodax --session auth-review "读取 src/auth.ts"
kodax --session auth-review "总结一下"        # Agent 知道总结 auth.ts
kodax --session auth-review "第一个问题怎么修复"  # Agent 知道上下文
```

### 常用场景

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

### 权限控制

KodaX 提供 4 级权限模式，支持精细控制：

| 模式 | 说明 | 需要确认的工具 |
|------|------|----------------|
| `plan` | 只读计划模式 | 所有修改工具被阻止 |
| `default` | 安全模式（默认） | write, edit, bash |
| `accept-edits` | 自动接受文件编辑 | 仅 bash |
| `auto-in-project` | 项目内全自动 | 无（仅限项目范围） |

```bash
# 在 REPL 中使用 /mode 命令
/mode plan          # 切换到计划模式（只读）
/mode default       # 切换到默认模式
/mode accept-edits  # 切换到接受编辑模式
/mode auto          # 切换到项目内全自动模式

# 查看当前模式
/mode
```

**高级功能：**
- 在默认模式选择 "always" 时自动切换到 `accept-edits`
- 计划模式会在系统提示中告知 LLM 只读限制
- 永久保护区域：`.kodax/`、`~/.kodax/`、项目外路径
- 命令模式匹配：允许特定 Bash 命令（如 `Bash(npm install)`）
- 统一 diff 显示：write/edit 操作显示差异

### 命令选项

| 选项 | 说明 |
|------|------|
| `-h, --help [TOPIC]` | 显示帮助，或指定主题的详细帮助 |
| `--provider NAME` | 指定大模型 |
| `--thinking` | 开启思考模式 |
| `--no-confirm` | 启用自动模式（跳过确认） |
| `--session ID` | 会话管理（resume/list/ID） |
| `--parallel` | 并行执行工具 |
| `--team TASKS` | 多 Agent 并行 |
| `--init TASK` | 初始化长时间运行任务 |
| `--auto-continue` | 自动继续直到所有功能完成 |
| `--max-iter N` | 单次会话最大迭代次数（默认：200） |

### CLI 帮助主题

获取特定主题的详细帮助：

```bash
# 基本帮助
kodax -h
kodax --help

# 详细主题帮助
kodax -h sessions      # 会话管理详解
kodax -h init          # 长时间运行任务初始化
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
  onThinkingDelta: (text, charCount) => console.log(`思考中: ${charCount} 字符`),
  onToolResult: (result) => console.log(`工具 ${result.name}`),
  onComplete: () => console.log('\n完成!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events,
  auto: true,
}, '1+1等于几？');

console.log(result.lastText);
```

### 连续会话模式（KodaXClient）

共享消息历史，有上下文记忆：

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
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

## 支持的模型

| 模型 | API Key | 思考模式 | 说明 |
|------|---------|----------|------|
| 智谱 Coding | `ZHIPU_API_KEY` | 支持 | GLM-5，中文友好（默认） |
| Kimi Code | `KIMI_API_KEY` | 支持 | K2.5，性价比高 |
| Anthropic | `ANTHROPIC_API_KEY` | 支持 | Claude |
| Kimi | `KIMI_API_KEY` | 不支持 | Moonshot |
| 智谱 | `ZHIPU_API_KEY` | 不支持 | GLM-4 |
| 通义千问 | `QWEN_API_KEY` | 不支持 | Qwen |
| OpenAI | `OPENAI_API_KEY` | 不支持 | GPT-4 |

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
| diff | 比较文件或显示变更 |

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

# 构建
npm run build

# 构建所有包
npm run build:packages

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
- [Python 版本 (KodaXP)](https://github.com/icetomoyo/KodaXP) - Python 实现

---

## 许可证

MIT
