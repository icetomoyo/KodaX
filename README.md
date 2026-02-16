# KodaX

极致轻量化 Coding Agent - TypeScript 单文件实现

## 概述

KodaX 是 KodaXP 的 TypeScript + Node.js 版本，采用单文件实现（约 1800 LOC），支持 7 种 LLM 提供商。

**核心理念**: 透明、灵活、极简

## 特性

- **单文件实现**: 所有代码在 `src/kodax.ts` 中，易于阅读和定制
- **7 种 LLM 提供商**: Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding
- **Thinking 模式**: 支持深度推理
- **流式输出**: 实时显示响应
- **7 个工具**: read, write, edit, bash, glob, grep, undo
- **会话管理**: JSONL 格式持久化存储
- **跨平台**: Windows/macOS/Linux

## 安装

```bash
# 克隆仓库
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# 安装依赖
npm install

# 构建
npm run build

# 运行
node dist/kodax.js "你的任务"
```

## 使用

### 基本使用

```bash
# 设置 API Key
export ZHIPU_API_KEY=your_api_key

# 运行
node dist/kodax.js "帮我创建一个 TypeScript 项目"

# 或使用 npm
npm start "帮我创建一个 TypeScript 项目"
```

### CLI 选项

```
--provider <name>   LLM 提供商 (default: zhipu-coding)
--thinking          启用思考模式
--no-confirm        禁用所有确认
--session <id>      会话: resume, list, 或指定 ID
--parallel          并行工具执行
--max-iter <n>      最大迭代次数 (default: 50)
```

### 提供商

| Provider | 环境变量 | Thinking | 默认模型 |
|----------|----------|----------|----------|
| anthropic | `ANTHROPIC_API_KEY` | Yes | claude-sonnet-4-20250514 |
| openai | `OPENAI_API_KEY` | No | gpt-4o |
| kimi | `KIMI_API_KEY` | No | moonshot-v1-128k |
| kimi-code | `KIMI_API_KEY` | Yes | k2p5 |
| qwen | `QWEN_API_KEY` | No | qwen-max |
| zhipu | `ZHIPU_API_KEY` | No | glm-4-plus |
| zhipu-coding | `ZHIPU_API_KEY` | Yes | glm-5 |

### 示例

```bash
# 使用智谱 Coding
node dist/kodax.js --provider zhipu-coding --thinking "帮我优化这段代码"

# 使用 OpenAI
export OPENAI_API_KEY=your_key
node dist/kodax.js --provider openai "创建一个 REST API"

# 恢复上次会话
node dist/kodax.js --session resume

# 列出所有会话
node dist/kodax.js --session list
```

## 工具

| 工具 | 描述 |
|------|------|
| read | 读取文件内容 |
| write | 写入文件 |
| edit | 精确字符串替换 |
| bash | 执行 Shell 命令 |
| glob | 文件模式匹配 |
| grep | 内容搜索 |
| undo | 撤销最近修改 |

## 开发

```bash
# 开发模式 (使用 tsx)
npm run dev "你的任务"

# 构建
npm run build

# 清理
npm run clean
```

## 与 KodaXP 的对应

KodaX 是 KodaXP 的 TypeScript 移植版本，功能完全对应：

- `kodaxp.py` (Python) → `src/kodax.ts` (TypeScript)
- 约 2000 LOC Python → 约 1800 LOC TypeScript
- `uv run kodaxp.py` → `node dist/kodax.js`

## 许可证

MIT
