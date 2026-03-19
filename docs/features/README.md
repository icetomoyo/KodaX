# 特性设计文档

本目录记录 KodaX 项目特性的设计方案。按版本组织，每个版本文件包含该版本所有特性的设计文档。

---

## 目录结构

```
docs/features/
├── README.md          # 本文件（索引和概览）
├── v0.3.1.md          # v0.3.1 — Plan Mode、Ask 模式、项目模式
├── v0.3.3.md          # v0.3.3 — 交互式界面改进
├── v0.4.0.md          # v0.4.0 — 架构重构与模块解耦（3 包）
├── v0.5.0.md          # v0.5.0 — 5 层架构重构、Skills、补全增强
├── v0.5.20.md         # v0.5.20 — Project Mode Enhancement
├── v0.5.22.md         # v0.5.22 — CLI-Based OAuth Providers
├── v0.6.0.md          # v0.6.0 — Command System 2.0、Project Mode 2.0
├── v0.6.10.md         # v0.6.10 — Project Harness
├── v0.7.0.md          # v0.7.0 — Session Tree & Rollback (Planned)
├── v0.8.0.md          # v0.8.0 — 主题系统、CodeWiki、Adaptive PI (Planned)
└── v1.0.0.md          # v1.0.0 — Multi-Agent、Dual-Mode UX (Planned)
```

---

## KodaX 功能总览

> **版本**: v0.6.10 | **更新日期**: 2026-03-18

### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Layer                                 │
│  Command Parse | File Storage | Event Handler (Spinner)          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Interactive Layer (REPL)                      │
│  Ink UI | Permission Control | Built-in Commands                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Coding Layer (独立库)                        │
│  Tools (9) | Prompts | Agent Loop                               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Layer (独立库)                         │
│  Session Mgmt | Messages | Tokenizer                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       AI Layer (独立库)                          │
│  Providers (10) | Stream Handling | Error Handling              │
└─────────────────────────────────────────────────────────────────┘
                              +
┌─────────────────────────────────────────────────────────────────┐
│                     Skills Layer (零依赖)                        │
│  Skill Discovery | Skill Execution | Natural Language Triggers  │
└─────────────────────────────────────────────────────────────────┘
```

### 核心功能

| 功能 | 说明 |
|------|------|
| **Agent 循环** | runKodaX() 核心入口，最多 200 次迭代 |
| **会话管理** | JSONL 格式持久化，Git 项目绑定 |
| **消息压缩** | Token 超阈值时智能压缩 |
| **系统提示** | 动态上下文，跨平台命令提示 |
| **并行工具** | 非 bash 工具自动并行执行 |
| **权限模式** | 4 级权限（plan / default / accept-edits / auto-in-project） |

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

### 交互式命令

| 命令 | 说明 |
|------|------|
| `/mode [code\|ask]` | 切换交互模式 |
| `/plan [on\|off\|once]` | Plan 模式管理 |
| `/model [name]` | 切换 LLM 模型 |
| `/reasoning [off\|auto\|quick\|balanced\|deep]` | 设置推理预算 |
| `/project [subcommand]` | 项目管理命令组（brainstorm / plan / next / auto / verify / status / quality） |
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
| diff | 查看文件差异 |
| ask-user | 向用户提问获取决策 |

### Provider 系统

| Provider | 默认模型 | Reasoning | Context Window |
|----------|----------|-----------|----------------|
| anthropic | claude-sonnet-4-6 | native-budget | 200K |
| openai | gpt-5.3-codex | native-effort | 400K |
| kimi | k2.5 | native-effort | 256K |
| kimi-code | k2.5 | native-budget | 256K |
| qwen | qwen3.5-plus | native-budget | 256K |
| zhipu | glm-5 | native-budget | 200K |
| zhipu-coding | glm-5 | native-budget | 200K |
| minimax-coding | MiniMax-M2.5 | native-budget | 204K |
| gemini-cli | Gemini (CLI) | native-budget | varies |
| codex-cli | Codex (CLI) | native-budget | varies |

### Reasoning 模式

| 模式 | 预算策略 |
|------|----------|
| off | 禁用思考 |
| auto | 由 Provider 智能选择 |
| quick | 低预算，快速响应 |
| balanced | 平衡预算，通用场景 |
| deep | 高预算，复杂推理 |

预算上限根据 Provider 自动调整（Provider-Aware Reasoning Budget Matrix）。

### 特色功能

| 功能 | 说明 |
|------|------|
| **Reasoning 模式** | 5 级推理预算，Provider 感知自动调整 |
| **Promise 信号** | COMPLETE / BLOCKED / DECIDE 信号 |
| **并行执行** | 非 bash 工具并行执行 |
| **Plan 模式** | 计划生成与逐步确认 |
| **Project Mode** | AI 驱动开发工作流（brainstorm / plan / quality） |
| **Project Harness** | Action 级别验证执行，proof-carrying completion |
| **AGENTS.md** | 项目级 AI 上下文规则 |
| **Skills 系统** | Markdown 定义，自然语言触发，自定义扩展 |
| **运行时输入插队** | Pending Inputs Queue |

---

## 已发布版本

| 版本 | 发布日期 | 特性数 | 设计文档 |
|------|----------|--------|----------|
| **v0.3.1** | 2026-02-19 | 3 | [v0.3.1.md](./v0.3.1.md) |
| **v0.3.3** | 2026-02-20 | 1 | [v0.3.3.md](./v0.3.3.md) |
| **v0.4.0** | 2026-02-24 | 1 | [v0.4.0.md](./v0.4.0.md) |
| **v0.4.6** | 2026-02-27 | 1 | [v0.5.0.md#008) |
| **v0.5.0** | 2026-02-27 | 7 | [v0.5.0.md](./v0.5.0.md) |
| **v0.5.5** | 2026-03-02 | 1 | [v0.5.0.md#010) |
| **v0.5.13** | 2026-03-05 | 1 | [v0.5.0.md#012) |
| **v0.5.14** | 2026-03-06 | 1 | [v0.5.0.md#011) |
| **v0.5.20** | 2026-03-07 | 1 | [v0.5.20.md](./v0.5.20.md) |
| **v0.5.22** | 2026-03-08 | 1 | [v0.5.22.md](./v0.5.22.md) |
| **v0.5.34** | 2026-03-13 | 1 | [v0.6.0.md#020) |
| **v0.5.37** | 2026-03-15 | 1 | [v0.6.0.md#021) |
| **v0.6.0** | 2026-03-16 | 6 | [v0.6.0.md](./v0.6.0.md) |
| **v0.6.10** | 2026-03-18 | 1 | [v0.6.10.md](./v0.6.10.md) |

### 特性索引

| ID | 特性 | 版本 | 说明 |
|----|------|------|------|
| 001 | Plan Mode | v0.3.1 | 执行前计划生成与确认 |
| 002 | 强化 Ask 模式 | v0.3.1 | 只读模式强制执行 |
| 003 | 交互式项目模式 | v0.3.1 | REPL 中的 `/project` 命令组 |
| 004 | 交互式界面改进 | v0.3.3 | 多行输入、状态栏、自动补全、Markdown 渲染 |
| 005 | 架构重构与模块解耦 | v0.4.0 | 重构为 3 个独立 npm 包 |
| 006 | Skills 系统 | v0.5.10 | Markdown 定义，自然语言触发 |
| 007 | 主题系统完善 | Planned | 全局主题切换 |
| 008 | 权限控制体系改进 | v0.4.6 | 4 级权限模式 |
| 009 | 架构重构：AI 层独立 | v0.5.0 | AI 层 + 权限层分离 |
| 010 | 架构拆分：Agent Core + Skills 独立 | v0.5.5 | 5 层架构成型 |
| 011 | 智能上下文压缩 | v0.5.14 | Token 超阈值自动压缩 |
| 012 | TUI 自动补全增强 | v0.5.13 | 多源合并补全系统 |
| 013 | Command System 2.0 | v0.6.0 | 用户级命令发现 + LLM 可调用交互工具 |
| 014 | Project Mode Enhancement | v0.5.20 | AI-First 方法，7 个精简命令 |
| 015 | Project Mode 2.0 | v0.6.0 | AI 驱动开发工作流（brainstorm, plan, quality） |
| 016 | CLI-Based OAuth Providers | v0.5.22 | OAuth 认证 Provider |
| 017 | 运行时用户输入插队 | v0.6.0 | Pending Inputs Queue |
| 018 | CodeWiki | Planned | 项目知识库系统 |
| 019 | Session Tree & Rollback | Planned | 会话树与回滚 |
| 020 | AGENTS.md | v0.5.34 | 项目级 AI 上下文规则 |
| 021 | Provider-Aware Reasoning Budget | v0.5.37 | Provider 感知推理预算矩阵 |
| 022 | Multi-Agent Orchestration | Planned | 多 Agent 编排层 |
| 023 | Dual-Mode Terminal UX | Planned | Inline + Fullscreen TUI |
| 024 | Project Harness | v0.6.10 | Action 级别验证执行 |
| 025 | Adaptive Project Intelligence | Planned | 自适应项目智能层 |

---

## 规划中版本

| 版本 | 特性数 | 设计文档 |
|------|--------|----------|
| **v0.7.0** | 1 | [v0.7.0.md](./v0.7.0.md) |
| **v0.8.0** | 3 | [v0.8.0.md](./v0.8.0.md) |
| **v1.0.0** | 1 | [v1.0.0.md](./v1.0.0.md) |

---

## 扩展性

### 自定义 Provider

```typescript
import { KodaXBaseProvider, registerProvider } from '@kodax/ai';

class MyProvider extends KodaXBaseProvider {
  readonly name = 'my-provider';
  readonly supportsThinking = false;
  async stream(messages, tools, system) { /* ... */ }
}

registerProvider('my-provider', () => new MyProvider());
```

### 自定义工具

```typescript
import { registerTool } from '@kodax/coding';
registerTool('my-tool', async (input, context) => 'result');
```

### 自定义 Skill

```bash
# ~/.kodax/skills/my-skill.md
# My Custom Skill
#
# ## Trigger Keywords
# my-task, custom
#
# ## Instructions
# 1. Step one
# 2. Step two
```

---

## 相关文档

- [FEATURE_LIST.md](../FEATURE_LIST.md) - 特性列表和状态跟踪
- [HLD.md](../HLD.md) - 高层设计
- [DD.md](../DD.md) - 详细设计
- [ADR.md](../ADR.md) - 架构决策记录
- [PRD.md](../PRD.md) - 产品需求文档
- [KNOWN_ISSUES.md](../KNOWN_ISSUES.md) - 已知问题
