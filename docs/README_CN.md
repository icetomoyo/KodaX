# KodaX

<div align="center">

**一个真正好用的轻量级 AI 编程助手（TypeScript 版本）。**

单文件 • ~1800 行代码 • 7 个大模型 • 流式输出 • 并行执行 • 长运行模式

[![Node.js 18+](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## 为什么选择 KodaX？

**透明** • **灵活** • **强大** • **类型安全**

KodaX 是 KodaXP 的 TypeScript 版本，专为想要**理解**、**定制**和**掌控** AI 编程助手的开发者设计。

| 对比项 | KodaX | 其他工具 |
|--------|--------|----------|
| **代码** | 单文件（~1800 行），30 分钟读完 | 成千上万文件，难以理解 |
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
- 偏好 **TypeScript/Node.js** 生态
- 更看重**透明可控**而非开箱即用

**适合使用其他工具的场景：**
- 需要**开箱即用**的生产级解决方案
- 想要 **IDE 集成**（Cursor、Windsurf）
- 需要编码之外的**高级功能**

## 特性

- **单文件** - 所有代码在 `src/kodax.ts`，读懂它，改它，发布它
- **7 个模型** - Anthropic, OpenAI, Kimi, Kimi Code, 智谱, 智谱 Coding, 通义千问
- **流式输出** - 实时显示，不用等待
- **会话记忆** - 对话跨次保存
- **长运行模式** - 通过 `feature_list.json` 和 `PROGRESS.md` 跟踪进度
- **并行工具** - 同时执行多个工具
- **技能系统** - 用 JavaScript 函数扩展功能
- **思考模式** - 复杂任务的深度推理（部分模型支持）
- **上下文感知** - 自动注入 Git 状态和项目结构
- **撤销支持** - 使用 undo 工具撤销文件修改
- **跨平台** - 支持 Windows、macOS 和 Linux
- **TypeScript 原生** - 完整的类型安全和 IDE 支持

### TypeScript 版本的改进

相比 Python 版本，TypeScript 版本有以下额外优势：

| 改进 | 说明 |
|------|------|
| **等待动画** | 使用 `\r` 清除，不在终端留下痕迹 |
| **环境上下文** | 包含 Node 版本信息，便于调试 |
| **read 工具增强** | 支持行号、offset、limit 参数 |
| **grep output_mode** | 支持 `content | files_with_matches | count` |
| **edit replace_all** | 支持批量替换所有匹配项 |
| **类型安全** | 编译时捕获错误 |
| **async/await** | 更清晰的异步代码结构 |
| **Session createdAt** | 记录会话创建时间 |

## 快速开始

```bash
# 安装
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install

# 构建
npm run build

# 设置 API Key
export ZHIPU_API_KEY=your-key    # 或 KIMI_API_KEY, ANTHROPIC_API_KEY 等

# 运行
node dist/kodax.js "用 Express 创建一个 REST API"
```

### 全局安装（推荐）

安装为全局命令行工具（类似 Python 的 `uv tool install -e .`）：

```bash
# 先构建
npm run build

# 全局链接（可编辑模式 - 代码修改后重新 build 即可生效）
npm link

# 现在可以在任何目录使用 'kodax' 命令
kodax "你的任务"
kodax --provider kimi-code "帮我写代码"

# 卸载
npm unlink -g kodax
```

**与 Python 版本的对应关系：**

| Python (KodaXP) | TypeScript (KodaX) | 说明 |
|-----------------|-------------------|------|
| `uv tool install -e .` | `npm link` | 本地开发安装，代码修改生效 |
| `uv tool install .` | `npm install -g .` | 全局安装 |
| `uv tool uninstall kodaxp` | `npm unlink -g kodax` | 卸载 |
| `kodaxp "任务"` | `kodax "任务"` | 运行命令 |

## 使用

```bash
# 基本用法
node dist/kodax.js "你的编程任务"

# 使用其他模型
node dist/kodax.js --provider kimi-code "你的任务"

# 复杂任务开启思考模式
node dist/kodax.js --provider zhipu-coding --thinking "重构这个项目"

# 恢复之前的对话
node dist/kodax.js --session resume "继续之前的 API 开发"

# 并行执行（多文件任务更快）
node dist/kodax.js --parallel "读取所有 markdown 文件并总结"

# 多任务并行
node dist/kodax.js --team "分析代码结构,检查测试覆盖率,查找 bug"
```

## 支持的模型

| 模型 | API Key | 思考模式 | 说明 |
|------|---------|----------|------|
| 智谱 Coding | `ZHIPU_API_KEY` | 支持 | GLM-5，中文友好（默认） |
| Kimi Code | `KIMI_API_KEY` | 支持 | K2.5，性价比高 |
| Anthropic | `ANTHROPIC_API_KEY` | 支持 | Claude |
| Kimi | `KIMI_API_KEY` | 不支持 | Moonshot |
| 智谱 | `ZHIPU_API_KEY` | 不支持 | GLM-4（OpenAI 兼容） |
| 通义千问 | `QWEN_API_KEY` | 不支持 | Qwen |
| OpenAI | `OPENAI_API_KEY` | 不支持 | GPT-4 |

## 技能系统

在 `~/.kodax/skills/` 创建自定义技能：

**JavaScript 技能**（灵活，可执行工具）：
```javascript
// ~/.kodax/skills/commit.js
module.exports = {
  name: 'commit',
  description: '根据 git diff 生成 commit 消息',
  execute: async (agent, args) => {
    const diff = await agent.executeTool('bash', { command: 'git diff --staged' });
    if (!diff.trim()) return '没有暂存的更改。';
    return agent.callLLM([{ role: 'user', content: `生成 commit 消息：\n${diff}` }]);
  }
};
```

**Markdown 技能**（简单，纯提示词）：
```markdown
# ~/.kodax/skills/review.md

# 代码审查

审查代码的以下方面：
- Bug 和错误
- 安全问题
- 性能问题
- 代码风格
```

```bash
node dist/kodax.js              # 列出所有技能及描述
node dist/kodax.js /commit      # 执行技能
node dist/kodax.js /review src/main.py
```

## 命令选项

| 选项 | 说明 |
|------|------|
| `--provider NAME` | 指定大模型 |
| `--thinking` | 开启思考模式 |
| `--no-confirm` | 跳过确认 |
| `--session resume\|list` | 会话管理 |
| `--parallel` | 并行执行工具 |
| `--team TASKS` | 多 Agent 并行 |
| `--init TASK` | 初始化长时间运行任务 |
| `--auto-continue` | 自动继续直到所有功能完成 |
| `--max-iter N` | 单次会话最大迭代次数（默认：50） |
| `--max-sessions N` | --auto-continue 最大会话数（默认：50） |
| `--max-hours H` | --auto-continue 最大小时数（默认：2.0） |

## 最佳实践

### 运行方式

**方式一：直接运行**
```bash
npm run build
node dist/kodax.js "你的任务"
```

**方式二：全局安装**
```bash
npm link
kodax "你的任务"
```

### 设置默认 Provider

**方式一：环境变量**
```bash
export KODAX_PROVIDER=kimi-code
node dist/kodax.js "你的任务"  # 使用 kimi-code
```

**方式二：Shell Alias**
```bash
# 添加到 ~/.bashrc 或 ~/.zshrc
alias kodax='node /path/to/KodaX/dist/kodax.js --provider kimi-code'
```

**优先级**：`--provider` 命令行参数 > `KODAX_PROVIDER` 环境变量 > 默认值 (zhipu-coding)

### API Key 配置

```bash
export ZHIPU_API_KEY=your-key      # 智谱 Coding（默认）
export KIMI_API_KEY=your-key       # Kimi / Kimi Code
export ANTHROPIC_API_KEY=your-key  # Anthropic Claude
export QWEN_API_KEY=your-key       # 通义千问
export OPENAI_API_KEY=your-key     # OpenAI
```

### 使用技巧

- 复杂推理任务使用 `--thinking`（支持：zhipu-coding、kimi-code、anthropic）
- 涉及多个独立文件的任务使用 `--parallel`
- 不相关的并行任务使用 `--team`（如："分析代码,写测试,更新文档"）
- 会话是项目级别的（基于 git root），不会混淆上下文

## 长时间运行任务

对于需要跨多个 session 完成的复杂项目，使用 `--init` 初始化：

```bash
# 初始化
node dist/kodax.js --init "构建 claude.ai 克隆"

# 这会创建：
# - feature_list.json (所有功能，初始 passes: false)
# - PROGRESS.md (进度日志)

# 继续工作（自动检测长运行模式）
node dist/kodax.js "继续开发"

# 第二天继续
node dist/kodax.js --session resume "继续昨天的工作"
```

### 自动继续模式

完全自主开发，直到所有功能完成：

```bash
# 先初始化
node dist/kodax.js --init "构建带认证的 REST API"

# 自动继续直到所有功能通过（带安全限制）
node dist/kodax.js --auto-continue

# 自定义限制
node dist/kodax.js --auto-continue --max-sessions 20 --max-hours 4.0
```

自动继续会在以下情况停止：
- `feature_list.json` 中所有功能都标记为 `passes: true`
- 达到最大会话数（默认：50）
- 达到最大小时数（默认：2.0）
- 连续错误超过阈值

## 原理

KodaX 是一个简单的 Agent 循环：

1. 把你的任务 + 可用工具发给大模型
2. 大模型返回文本和/或工具调用
3. 执行工具，把结果发回去
4. 重复直到完成

核心逻辑只有 ~100 行。读 [src/kodax.ts](../src/kodax.ts) 就能完全理解它是怎么工作的。

## 文档

- [设计文档](DESIGN.md) - 架构和实现细节
- [长时间运行指南](LONG_RUNNING_GUIDE.md) - `--init` 最佳实践和提示词范例
- [测试指南](TESTING.md) - 如何测试所有功能
- [Python 版本 (KodaXP)](https://github.com/icetomoyo/KodaXP) - Python 实现

## 许可证

MIT
