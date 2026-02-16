# KodaX

<div align="center">

**一个真正好用的轻量级 AI 编程助手（TypeScript 版本）。**

模块化架构 • 7 个大模型 • 流式输出 • 并行执行 • 长运行模式 • 可作为库使用

[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## 为什么选择 KodaX？

**透明** • **灵活** • **强大** • **类型安全**

KodaX 是 KodaXP 的 TypeScript 版本，专为想要**理解**、**定制**和**掌控** AI 编程助手的开发者设计。

| 对比项 | KodaX | 其他工具 |
|--------|--------|----------|
| **架构** | 模块化（Core + CLI），可作为库使用 | 通常只能作为 CLI 使用 |
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

KodaX 采用模块化架构：

```
src/
├── kodax_core.ts      # 核心库（可作为 npm 包使用）
├── kodax_cli.ts       # CLI 入口（命令行 UI）
├── kodax.ts           # 原始单文件（保留作为参考）
└── index.ts           # 包导出入口
```

### 模块职责

| 模块 | 职责 | 依赖 |
|------|------|------|
| `kodax_core.ts` | 核心 Agent 能力（Provider、Tools、runKodaX） | 仅 LLM SDK |
| `kodax_cli.ts` | CLI 体验（Spinner、颜色、用户交互、Commands） | Core + chalk/commander |
| `index.ts` | 包导出（给 `import` 使用） | Core |

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
│  入口: package.json "main" → dist/index.js                  │
└─────────────────────────────────────────────────────────────┘
```

### package.json 关键字段

```json
{
  "main": "dist/index.js",           // 库入口（import 使用）
  "bin": {
    "kodax": "./dist/kodax_cli.js"   // CLI 入口（命令行使用）
  }
}
```

| 字段 | 用途 | 触发方式 |
|------|------|---------|
| `"main"` | 库入口 | `import from 'kodax'` |
| `"bin"` | 命令入口 | `kodax "任务"` 或 `npm link` |

### index.ts 的作用

`index.ts` 是包的"门面"，控制公开 API：

```typescript
// index.ts
export * from './kodax_core.js';  // 重导出 Core 的所有内容
```

**为什么需要 index.ts？**
- 作为包入口，让 `import from 'kodax'` 能工作
- 未来可以选择性导出（控制哪些 API 是公开的）
- 可以组合多个子模块

---

## 特性

- **模块化架构** - 可作为 CLI 或库使用
- **7 个模型** - Anthropic, OpenAI, Kimi, Kimi Code, 智谱, 智谱 Coding, 通义千问
- **流式输出** - 实时显示，不用等待
- **会话记忆** - 对话跨次保存
- **长运行模式** - 通过 `feature_list.json` 跟踪进度
- **并行工具** - 同时执行多个工具
- **Commands 系统** - `/xxx` 快捷命令扩展
- **思考模式** - 复杂任务的深度推理（部分模型支持）
- **跨平台** - 支持 Windows、macOS 和 Linux
- **TypeScript 原生** - 完整的类型安全和 IDE 支持

---

## 安装

### 作为 CLI 工具

```bash
# 克隆仓库
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# 安装依赖
npm install

# 构建
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

### Commands（/xxx 快捷命令）

```bash
# 使用预定义的命令
kodax /review src/auth.ts
kodax /test
kodax /explain src/utils.ts

# 命令定义在
~/.kodax/commands/
```

### 命令选项

| 选项 | 说明 |
|------|------|
| `--provider NAME` | 指定大模型 |
| `--thinking` | 开启思考模式 |
| `--no-confirm` | 跳过确认 |
| `--session ID` | 会话管理（resume/list/ID） |
| `--parallel` | 并行执行工具 |
| `--team TASKS` | 多 Agent 并行 |
| `--init TASK` | 初始化长时间运行任务 |
| `--auto-continue` | 自动继续直到所有功能完成 |
| `--max-iter N` | 单次会话最大迭代次数（默认：50） |

---

## 库使用

### 简单模式（runKodaX）

每次调用独立，无记忆：

```typescript
import { runKodaX, KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text, charCount) => console.log(`Thinking: ${charCount} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events,
  noConfirm: true,
}, 'What is 1+1?');

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
| **Skills** | 模型能力（KODAX_TOOLS: read, write, bash 等） | Core 层 |
| **Commands** | CLI 快捷命令（/review, /test 等） | CLI 层 |

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
- [Python 版本 (KodaXP)](https://github.com/icetomoyo/KodaXP) - Python 实现

---

## 许可证

MIT
