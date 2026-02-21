# 特性设计文档

本目录记录 KodaX 项目特性的设计方案。按版本组织，每个版本文件包含该版本所有特性的设计文档。

---

## 目录结构

```
docs/features/
├── README.md          # 本文件（索引和概览）
├── v0.3.1.md          # v0.3.1 版本特性设计（Plan Mode、Ask 模式、项目模式）
├── v0.3.3.md          # v0.3.3 版本特性设计（交互式界面改进）
└── v0.4.0.md          # v0.4.0 版本特性设计（架构重构与模块解耦）
```

---

## KodaX 功能总览

> **版本**: v0.3.x | **更新日期**: 2026-02-21

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI Layer                             │
│  Command Parse | File Storage | Event Handler (Spinner)     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Interactive Layer                         │
│  REPL Loop | Context Management | Built-in Commands         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     Core Layer (独立库)                      │
│  Agent Loop | Providers | Tools | Session Management        │
└─────────────────────────────────────────────────────────────┘
```

### 核心功能

| 功能 | 说明 |
|------|------|
| **Agent 循环** | runKodaX() 核心入口，最多 50 次迭代 |
| **会话管理** | JSONL 格式持久化，Git 项目绑定 |
| **消息压缩** | Token > 100K 时自动压缩 |
| **系统提示** | 动态上下文，跨平台命令提示 |

### CLI 功能

| 参数 | 说明 |
|------|------|
| `-h, --help [TOPIC]` | 主题式帮助 |
| `-p, --print TEXT` | 单次任务模式 |
| `-c, --continue` | 继续最近会话 |
| `-t, --thinking` | 扩展思考模式 |
| `-y, --auto` | 自动模式 |
| `-j, --parallel` | 并行工具执行 |
| `--team TASKS` | 并行子 Agent |
| `--init TASK` | 初始化长运行项目 |
| `--auto-continue` | 自动继续模式 |

### 交互式功能

| 命令 | 说明 |
|------|------|
| `/mode [code\|ask]` | 切换交互模式 |
| `/plan [on\|off\|once]` | Plan 模式管理 |
| `/project [subcommand]` | 项目管理命令组 |
| `@file` | 引用文件 |
| `!command` | 执行 shell 命令 |

### 工具系统

| 工具 | 说明 |
|------|------|
| read | 读取文件（支持 offset/limit） |
| write | 写入文件（自动创建目录） |
| edit | 精确字符串替换（支持 replace_all） |
| bash | 执行 Shell 命令 |
| glob | 文件模式搜索 |
| grep | 正则表达式搜索 |
| undo | 撤销最后一次修改 |

### Provider 系统

| Provider | 默认模型 | Thinking |
|----------|----------|----------|
| anthropic | claude-sonnet-4-20250514 | 是 |
| openai | gpt-4o | 否 |
| kimi | moonshot-v1-128k | 否 |
| kimi-code | k2p5 | 是 |
| qwen | qwen-max | 否 |
| zhipu | glm-4-plus | 否 |
| zhipu-coding | glm-5 | 是 |

### 特色功能

| 功能 | 说明 |
|------|------|
| **Thinking 模式** | 10000 tokens 预算，流式显示 |
| **Promise 信号** | COMPLETE/BLOCKED/DECIDE 信号 |
| **并行执行** | 非 bash 工具并行执行 |
| **Ask 模式** | 只读模式强制执行 |
| **Plan 模式** | 计划生成与逐步确认 |
| **项目模式** | 长运行任务管理 |
| **Auto 模式安全检查** | 项目外危险操作需要确认 |

---

## 已发布版本

| 版本 | 发布日期 | 特性 | 设计文档 |
|------|----------|------|----------|
| **v0.3.1** | 2026-02-19 | Plan Mode、强化 Ask 模式、交互式项目模式 | [v0.3.1.md](./v0.3.1.md) |
| **v0.3.3** | 2026-02-20 | 交互式界面改进（Ink UI） | [v0.3.3.md](./v0.3.3.md) |

### v0.3.1 特性列表

| ID | 特性 | 说明 |
|----|------|------|
| 001 | [Plan Mode](./v0.3.1.md#001) | 执行前计划生成与确认，支持中断恢复 |
| 002 | [强化 Ask 模式](./v0.3.1.md#002) | 只读模式强制执行，阻止文件修改操作 |
| 003 | [交互式项目模式](./v0.3.1.md#003) | REPL 中的长运行项目管理，`/project` 命令组 |

### v0.3.3 特性列表

| ID | 特性 | 说明 |
|----|------|------|
| 004 | [交互式界面改进](./v0.3.3.md#004) | 多行输入、状态栏、自动补全、Markdown 渲染、主题支持 |

---

## 规划中版本

| 版本 | 状态 | 特性 | 设计文档 |
|------|------|------|----------|
| **v0.4.0** | Planned | 架构重构与模块解耦 | [v0.4.0.md](./v0.4.0.md) |

### v0.4.0 特性列表

| ID | 特性 | 说明 |
|----|------|------|
| 005 | [架构重构与模块解耦](./v0.4.0.md#005) | 将 KodaX 重构为三个独立的 npm 包：@kodax/core、@kodax/cli、@kodax/repl |

---

## 扩展性

### 自定义 Provider

```typescript
import { KodaXBaseProvider, registerProvider } from 'kodax';

class MyProvider extends KodaXBaseProvider {
  readonly name = 'my-provider';
  readonly supportsThinking = false;
  protected config = { apiKeyEnv: 'MY_API_KEY', model: 'model-1' };
  async stream(messages, tools, system) { /* ... */ }
}

registerProvider('my-provider', () => new MyProvider());
```

### 自定义工具

```typescript
import { registerTool } from 'kodax';
registerTool('my-tool', async (input, context) => 'result');
```

### 自定义命令

```bash
# ~/.kodax/commands/review.md
请对以下代码进行审查：{args}
```

---

## 相关文档

- [FEATURE_LIST.md](../FEATURE_LIST.md) - 特性列表和状态跟踪
- [DESIGN.md](../DESIGN.md) - 架构设计详解
- [LONG_RUNNING_GUIDE.md](../LONG_RUNNING_GUIDE.md) - 长运行模式指南
- [README.md](../../README.md) - 项目主文档
