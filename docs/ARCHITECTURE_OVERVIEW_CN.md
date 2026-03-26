# InfCodeX 架构概览

本文基于当前公开仓库，对 InfCodeX 的整体架构做一个简明总结，并说明这种分层为什么重要。

## 1. 整体结构

InfCodeX 采用分层 monorepo 设计：

```text
CLI Layer
└─ REPL Layer
   └─ Coding Layer
      ├─ Agent Layer
      │  └─ AI Layer
      └─ Skills Layer
```

当前仓库中可见的主要包与入口包括：

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`
- 根目录 `src/kodax_cli.ts`

## 2. 各层职责

### AI Layer
负责 Provider 抽象、流式输出和错误处理。

这一层的重要性在于，它把整个系统从单一模型厂商或单一 API 风格中解耦出来。

### Agent Layer
负责通用智能体能力，例如：

- session 管理
- message 生命周期
- token 估算与压缩支持

这使得 Coding Runtime 可以复用通用 agent 基础能力，而不必把这些逻辑硬编码在 CLI 内部。

### Skills Layer
负责 skill 的发现、注册与执行。

这一层很关键，因为它为系统提供了从“通用 prompt”走向“结构化专业任务模板”的路径。

### Coding Layer
负责：

- tools
- coding prompts
- 将模型输出与工具执行连接起来的 action loop

它是 InfCodeX 真正的工程执行核心。

### REPL Layer
负责终端交互体验，包括：

- 交互式 UI
- 内置命令
- 权限控制
- 面向用户的执行流程

### CLI Layer
负责命令行入口、参数解析以及顶层命令调用。

## 3. 为什么这个架构很强

### 边界清晰
每一层职责明确，能减少系统概念混杂，降低二次扩展成本。

### 易于复用
多个层级天然具备独立复用价值，不必全部依赖 CLI 形态存在，这让 InfCodeX 更容易被上层系统嵌入。

### 易于治理
权限、Provider、Tools、Session 分层存在，为后续接入企业级治理、安全和策略控制留下了空间。

### 面向多智能体未来
相比单文件式 CLI，一个清晰的执行运行时更适合进一步演化出 team mode、agent 分工与编排能力。

## 4. 当前架构的主要优势

- 模块化 monorepo 结构
- 可复用的 package 边界
- Provider 抽象层
- Agent / Session 独立建模
- 明确的 Skills 子系统
- 面向编码执行的专用层
- 终端 UI 与核心运行时解耦

## 5. 战略解读

从架构上看，InfCodeX 已经不只是一个本地 CLI 小工具，而是具备成为工程智能体执行运行时的雏形。特别是在与上层智能体管理平台协同时，这种分层设计会非常有价值。
