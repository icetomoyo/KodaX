# KodaX 是什么？

**在所有你能接入的 LLM 上运行的源可用 AI 编程 Agent。**

KodaX 是一个 AI 编程 Agent，支持 16+ 个 LLM 提供商——包括 6 个国产提供商——提供 REPL、CLI、库和单文件二进制四种形态。基于多 Agent 运行时构建，内置 50+ 工具、可分支的会话谱系和可选的操作系统级沙箱。

## 为什么选 KodaX

### 🇨🇳 6 个国产 LLM 原生支持

智谱 · Kimi · MiniMax · MiMo · Ark · Qwen

原生适配器，在标准 5 别名面板上做跨提供商提示词 Eval 校准——而非 OpenAI 兼容层包装。

### 📦 单文件二进制

Bun `--compile` · Windows / macOS / Linux · x64 + arm64

目标机器无需 Node。下载一个文件，到处运行——受限环境、CI Runner、隔离主机。

### 🌳 可分支的会话谱系

Fork · 回退 · 并行编辑

会话历史是有向无环图，而非线性列表。支撑即将推出的 KodaX Space 桌面应用。

### 🤖 多 Agent 是一等公民

V2 Worker 单循环 + 结果审查 + 异步子 Agent

`spawn_agent`、`send_message`、`followup_task`、`interrupt_agent`，多实例自动协调，带内容哈希安全网。

### 🧩 Skills + 自我构建

Markdown Skill，模型可见的自然语言发现，每个已启用 Skill 均支持显式斜杠调用。

5 阶段自我修改阶梯（脚手架 → 验证 → 暂存 → 测试 → 激活），由 8 不变式准入合约把关。

### 🛠 50+ 内置工具

文件 · Shell · 搜索 · MCP · ACP

仓库智能、语义搜索、Git Worktree、Web Fetch——全部通过一个统一的工具接口访问。

## KodaX 与同类产品对比

| 特性 | **KodaX** | Claude Code | Aider | Codex CLI | Cursor | Cline |
|---|---|---|---|---|---|---|
| 源码许可 | ⚠️ KAI-FCL，非商业 | ❌ 源可用 | ✅ Apache 2.0 | ✅ Apache 2.0 | ❌ 专有 | ✅ Apache 2.0 |
| 无需 Node 的单文件二进制 | ✅ Bun | ❌ Node | ❌ Python | ✅ Rust | ❌ Electron | ❌ 扩展 |
| 国产 LLM 原生支持 | ✅ 6 个原生 | ❌ | ⚠ 需 LiteLLM | ❌ OpenAI 优先 | ❌ 无提供商菜单 | ⚠ Kimi/Qwen/DeepSeek |
| 可分支会话谱系 | ✅ Fork & 回退 | ⚠ routines/sessions | ❌ | ❌ | ❌ | ⚠ 检查点 |
| 多 Agent + MCP + 50+ 工具 | ✅ 三者全有 | ✅ 三者全有 | ⚠ 工具，无 MCP | ✅ 三者全有 | ⚠ Composer + MCP | ✅ 三者全有 |

## 下一步

- [安装](./installation.zh-CN.md) — 运行 KodaX
- [快速开始](./quickstart.zh-CN.md) — 你的第一次会话
- [提供商](../configuration/providers.zh-CN.md) — 配置 LLM 提供商
