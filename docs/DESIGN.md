# KodaX 设计文档

> 极致轻量化 Coding Agent - 单文件实现，功能完整（TypeScript 版本）

---

## 1. 设计理念

### 1.1 核心原则

| 原则 | 说明 |
|------|------|
| **单文件** | 所有代码在一个文件中，便于阅读和修改 |
| **功能完整** | 支持 7 种 LLM、长运行模式、并行执行等 |
| **类型安全** | TypeScript 原生类型，编译时捕获错误 |
| **可扩展** | Skill 系统支持自定义功能 |

### 1.2 实际指标

```
代码总量:      ~1800 LOC
Provider 层:   ~550 LOC
工具实现:      ~400 LOC
长运行模式:    ~300 LOC
核心循环:      ~200 LOC
```

### 1.3 与 Python 版本的对比

| 特性 | Python 版本 | TypeScript 版本 |
|------|-------------|-----------------|
| **代码量** | ~2000 行 | ~1800 行 |
| **类型系统** | 运行时类型检查 | 编译时类型检查 |
| **异步处理** | asyncio + threading | async/await |
| **等待动画** | 终端留痕迹 | `\r` 清除，更整洁 |
| **read 工具** | 基本读取 | 支持行号、offset、limit |
| **grep 工具** | 基本搜索 | output_mode 参数 |
| **edit 工具** | 单次替换 | replace_all 参数 |

---

## 2. 架构概览

```
┌─────────────────────────────────────────┐
│           kodax.ts (~1800 LOC)          │
│                                          │
│  ┌─────────┐ ┌─────────┐ ┌────────────┐ │
│  │ Config  │ │  Tools  │ │ Agent Loop │ │
│  │ (~50行) │ │ (~400行)│ │  (~200行)  │ │
│  └─────────┘ └─────────┘ └────────────┘ │
│                                          │
│  ┌─────────────────────────────────────┐│
│  │      Tool Execution (~200行)         ││
│  │  read | write | edit | bash | glob  ││
│  │  grep | undo                         ││
│  └─────────────────────────────────────┘│
│                                          │
│  ┌─────────────────────────────────────┐│
│  │       Provider Layer (~550行)        ││
│  │  anthropic | kimi | kimi-code       ││
│  │  qwen | openai | zhipu | zhipu-coding││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

---

## 3. 已实现功能 (P0)

### 3.1 核心 Agent 循环

```typescript
async function main() {
  const messages: Message[] = [{ role: 'user', content: userPrompt }];

  while (iteration < maxIterations) {
    // 流式调用 LLM
    const { textBlocks, toolBlocks, thinkingBlocks } = await streamLLM(messages);

    // 构建 assistant 响应
    const assistantContent: ContentBlock[] = [];
    // thinking blocks 必须在最前面
    thinkingBlocks.forEach(tb => assistantContent.push(tb));
    textBlocks.forEach(b => assistantContent.push(b));
    toolBlocks.forEach(b => assistantContent.push(b));

    messages.push({ role: 'assistant', content: assistantContent });

    // 如果没有工具调用，结束
    if (toolBlocks.length === 0) break;

    // 执行工具调用
    const toolResults = await executeTools(toolBlocks, confirmTools);

    // 添加工具结果
    messages.push({ role: 'user', content: toolResults });
  }
}
```

### 3.2 工具系统

**工具定义**:
```typescript
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'read',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
  },
  // write, edit, bash, glob, grep, undo ...
];
```

**工具执行**:
```typescript
async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<string> {
  // 确认机制
  if (context.confirmTools.has(name) && !context.auto) {
    const confirmed = await askConfirm(`Execute ${name}?`);
    if (!confirmed) return 'Operation cancelled by user';
  }

  switch (name) {
    case 'read':
      return toolRead(input);
    case 'write':
      return toolWrite(input, context.backups);
    case 'edit':
      return toolEdit(input, context.backups);
    case 'bash':
      return toolBash(input);
    case 'glob':
      return toolGlob(input);
    case 'grep':
      return toolGrep(input);
    case 'undo':
      return toolUndo(context.backups);
    default:
      return `[Tool Error] Unknown tool: ${name}`;
  }
}
```

### 3.3 确认机制

**默认需要确认的工具**: `bash`, `write`, `edit`

**CLI 选项**:
```bash
# 默认模式
node dist/kodax.js "你的任务"

# 自定义确认列表
node dist/kodax.js --confirm bash,write "你的任务"

# 启用自动模式（跳过所有确认）
node dist/kodax.js --no-confirm "你的任务"
```

### 3.4 流式输出

```typescript
async stream(messages: Message[], tools: ToolDefinition[], system: string, thinking = false): Promise<StreamResult> {
  const kwargs: Anthropic.Messages.MessageCreateParams = {
    model: this.config.model,
    max_tokens: MAX_TOKENS,
    system,
    messages: this.convertMessages(messages),
    tools: tools as Anthropic.Messages.Tool[],
    stream: true,
  };
  if (thinking) kwargs.thinking = { type: 'enabled', budget_tokens: 10000 };

  const response = await this.client.messages.create(kwargs);

  for await (const event of response as AsyncIterable<Anthropic.Messages.RawMessageStreamEvent>) {
    if (event.type === 'content_block_delta') {
      const delta = event.delta as any;
      if (delta.type === 'text_delta') {
        process.stdout.write(delta.text ?? '');
      } else if (delta.type === 'thinking_delta' && thinking) {
        process.stdout.write(chalk.gray(delta.thinking?.slice(0, 50) ?? ''));
      }
    }
  }

  return { textBlocks, toolBlocks, thinkingBlocks };
}
```

---

## 4. 多模型支持 (P1)

### 4.1 支持的 Provider

| Provider | 环境变量 | 默认模型 | 兼容类型 | Thinking |
|----------|----------|----------|----------|----------|
| **智谱 Coding** | `ZHIPU_API_KEY` | glm-5 | Anthropic | ✅ (默认) |
| **Kimi Code** | `KIMI_API_KEY` | k2p5 | Anthropic | ✅ |
| **Anthropic** | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 | 原生 | ✅ |
| **Kimi (Moonshot)** | `KIMI_API_KEY` | moonshot-v1-128k | OpenAI | ❌ |
| **智谱AI** | `ZHIPU_API_KEY` | glm-4-plus | OpenAI | ❌ |
| **Qwen (阿里云)** | `QWEN_API_KEY` | qwen-max | OpenAI | ❌ |
| **OpenAI** | `OPENAI_API_KEY` | gpt-4o | 原生 | ❌ |

### 4.2 Provider 抽象设计

```typescript
abstract class BaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: ProviderConfig;

  abstract stream(
    messages: Message[],
    tools: ToolDefinition[],
    system: string,
    thinking?: boolean
  ): Promise<StreamResult>;

  isConfigured(): boolean {
    return !!process.env[this.config.apiKeyEnv];
  }

  protected getApiKey(): string {
    const key = process.env[this.config.apiKeyEnv];
    if (!key) throw new Error(`${this.config.apiKeyEnv} not set`);
    return key;
  }
}
```

### 4.3 Anthropic Provider

```typescript
class AnthropicProvider extends AnthropicCompatProvider {
  readonly name = 'anthropic';
  protected readonly config: ProviderConfig = {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-20250514',
    supportsThinking: true,
  };

  constructor() {
    super();
    this.client = new Anthropic({ apiKey: this.getApiKey() });
  }
}
```

### 4.4 OpenAI 兼容 Provider

```typescript
abstract class OpenAICompatProvider extends BaseProvider {
  readonly supportsThinking = false;
  protected abstract readonly config: ProviderConfig;
  protected client!: OpenAI;

  protected initClient(): void {
    this.client = new OpenAI({
      apiKey: this.getApiKey(),
      baseURL: this.config.baseUrl
    });
  }

  async stream(messages: Message[], tools: ToolDefinition[], system: string): Promise<StreamResult> {
    const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      ...this.convertMessages(messages),
    ];

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: fullMessages,
      tools: tools as OpenAI.Chat.ChatCompletionTool[],
      stream: true,
    });

    // ... 流式处理
  }
}
```

### 4.5 Provider 注册表

```typescript
const PROVIDER_REGISTRY: Record<string, new () => BaseProvider> = {
  'anthropic': AnthropicProvider,
  'zhipu-coding': ZhipuCodingProvider,
  'kimi-code': KimiCodeProvider,
  'kimi': KimiProvider,
  'zhipu': ZhipuProvider,
  'qwen': QwenProvider,
  'openai': OpenAIProvider,
};

function getProvider(name: string): BaseProvider {
  const ProviderClass = PROVIDER_REGISTRY[name];
  if (!ProviderClass) throw new Error(`Unknown provider: ${name}`);
  return new ProviderClass();
}
```

---

## 5. Skill 系统 (P1)

### 5.1 设计目标

- **动态加载**: 无需重启即可添加新 skill
- **两种格式**: JavaScript 函数（灵活）或 Markdown（简单）
- **描述自动提取**: 从导出或首行提取
- **访问上下文**: 可访问 agent 工具和 LLM

### 5.2 目录结构

```
~/.kodax/
├── skills/
│   ├── commit.js         # /commit skill (JavaScript)
│   ├── commit.md         # /commit skill (Markdown) - 二选一
│   ├── review.js         # /review skill
│   └── custom/           # 用户自定义
└── sessions/             # 会话存储
    └── *.jsonl
```

### 5.3 Skill 定义格式

**方式一：JavaScript 函数**（灵活，可执行工具）

```javascript
// ~/.kodax/skills/commit.js
module.exports = {
  name: 'commit',
  description: '根据 git diff 生成 commit 消息',  // 自动提取为描述
  execute: async (agent, args) => {
    const diff = await agent.executeTool('bash', { command: 'git diff --staged' });
    if (!diff.trim()) return 'No staged changes.';

    return agent.callLLM([{
      role: 'user',
      content: `Generate commit message:\n\n${diff}`
    }]);
  }
};
```

**方式二：Markdown 文件**（简单，纯提示词）

```markdown
# ~/.kodax/skills/commit.md

# Generate commit message

Generate a concise git commit message following conventional commits format.
Use git diff --staged to see the changes.

Format: <type>: <description>
Types: feat, fix, refactor, docs, test, chore
```

---

## 6. 上下文压缩 (P1)

### 6.1 设计要点

- **自动触发**: 每次 LLM 调用前检查 token 数
- **阈值**: 100K tokens（可配置）
- **策略**: 保留最近 10 条消息 + 旧消息摘要

### 6.2 Token 估算

```typescript
function estimateTokens(messages: Message[]): number {
  let total = 0;

  for (const msg of messages) {
    const content = msg.content;

    if (typeof content === 'string') {
      total += Math.floor(content.length / 4);
    } else {
      for (const block of content) {
        if (block.type === 'text') {
          total += Math.floor(block.text.length / 4);
        } else if (block.type === 'tool_result') {
          total += Math.floor(block.content.length / 4);
        } else if (block.type === 'tool_use') {
          total += Math.floor(JSON.stringify(block.input).length / 4);
        }
      }
    }
  }

  return total;
}
```

### 6.3 压缩策略

```typescript
function compactMessages(messages: Message[], maxTokens = 100000): Message[] {
  if (estimateTokens(messages) <= maxTokens) return messages;

  // 保留最近 10 条消息
  const recent = messages.slice(-10);
  const older = messages.slice(0, -10);

  // 生成摘要
  const summaryLines: string[] = [];
  for (const msg of older) {
    const role = msg.role;
    if (typeof msg.content === 'string') {
      const preview = msg.content.slice(0, 100);
      summaryLines.push(`- ${role}: ${preview}`);
    } else {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          summaryLines.push(`- Tool: ${block.name}`);
        }
      }
    }
  }

  const summary = summaryLines.slice(-30).join('\n');
  const summaryBlock: Message = {
    role: 'user',
    content: `[对话历史摘要]\n${summary}`
  };

  return [summaryBlock, ...recent];
}
```

---

## 7. 会话持久化 (P1)

### 7.1 设计要点

- **存储格式**: JSONL（第一行为元数据，后续为消息）
- **存储位置**: `~/.kodax/sessions/{session_id}.jsonl`
- **自动保存**: 每次消息后覆盖保存
- **自动标题**: 从第一条用户消息提取前 50 字符作为标题

### 7.2 存储格式

```jsonl
{"_type":"meta","title":"读取项目目录下的所有md文件","id":"20260213_141051","gitRoot":"/path/to/project","createdAt":"2026-02-13T14:10:51.000Z"}
{"role":"user","content":"读取项目目录下的所有md文件"}
{"role":"assistant","content":[{"type":"text","text":"好的，我来读取..."},{"type":"tool_use","id":"...","name":"glob","input":{...}}]}
{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}
```

### 7.3 TypeScript 特有改进

相比 Python 版本，TypeScript 版本的 Session 元数据包含 `createdAt` 字段：

```typescript
interface SessionMeta {
  _type: 'meta';
  title: string;
  id: string;
  gitRoot: string;
  createdAt: string;  // TypeScript 版本新增
}
```

---

## 8. 上下文增强 (P1)

### 8.1 环境上下文（TypeScript 改进版）

```typescript
function getEnvironmentContext(): string {
  const p = process.platform;
  let cmdHint = '';
  if (p === 'win32') {
    cmdHint = 'Use: dir, move, copy, del (not ls, mv, cp, rm)';
  } else {
    cmdHint = 'Use: ls, mv, cp, rm';
  }

  // TypeScript 版本额外包含 Node 版本
  return `Platform: ${p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux'}
${cmdHint}
Node: ${process.version}`;
}
```

### 8.2 Git Context 自动注入

```typescript
async function getGitContext(): Promise<string> {
  try {
    // 检查是否在 Git 仓库中
    const isGit = await execAsync('git rev-parse --is-inside-work-tree');
    if (isGit.stdout.trim() !== 'true') return '';

    const lines: string[] = [];

    // 获取分支名
    const branch = await execAsync('git branch --show-current');
    if (branch.stdout.trim()) {
      lines.push(`Git Branch: ${branch.stdout.trim()}`);
    }

    // 获取状态摘要（最多 10 条）
    const status = await execAsync('git status --short');
    if (status.stdout.trim()) {
      const statusLines = status.stdout.trim().split('\n').slice(0, 10);
      lines.push('Git Status:\n' + statusLines.map(s => `  ${s}`).join('\n'));
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}
```

### 8.3 简单 Undo

```typescript
// 全局备份存储
const FILE_BACKUPS = new Map<string, string>();

async function toolWrite(input: Record<string, unknown>, backups: Map<string, string>): Promise<string> {
  const filePath = input.path as string;
  const content = input.content as string;

  // 备份现有文件
  if (fsSync.existsSync(filePath)) {
    const existing = await fs.readFile(filePath, 'utf-8');
    backups.set(filePath, existing);
  }

  await fs.writeFile(filePath, content, 'utf-8');
  return `File written: ${filePath}`;
}

async function toolUndo(backups: Map<string, string>): Promise<string> {
  if (backups.size === 0) return 'No backups available. Nothing to undo.';

  const [path, content] = Array.from(backups.entries()).pop()!;
  await fs.writeFile(path, content, 'utf-8');
  backups.delete(path);
  return `Restored: ${path}`;
}
```

---

## 9. 长时间运行模式 (P1)

### 9.1 状态文件

**feature_list.json**:
```json
{
  "features": [
    {
      "description": "User can create new chat",
      "steps": ["Navigate to interface", "Click New Chat", "Verify conversation created"],
      "passes": false
    }
  ]
}
```

**PROGRESS.md**:
```markdown
# Progress Log

## 2026-02-12 15:30

### Completed
- Basic chat interface setup

### Next
- Add conversation history
```

### 9.2 长运行模式提示词

```typescript
const LONG_RUNNING_PROMPT = `
## Long-Running Task Mode

At the start of EACH session:
1. Run \`pwd\` to confirm working directory
2. Read git logs and PROGRESS.md
3. Read feature_list.json, pick ONE incomplete feature
4. Test basic functionality before implementing
5. Implement feature incrementally
6. End with: git commit + update PROGRESS.md

IMPORTANT:
- Only change \`passes\` field in feature_list.json
- Leave codebase in clean state
- Work on ONE feature at a time
`;
```

### 9.3 Promise 信号系统 (Ralph-Loop 风格)

```typescript
const PROMISE_PATTERN = /<promise>(COMPLETE|BLOCKED|DECIDE)(?::(.*?))?<\/promise>/is;

function checkPromiseSignal(text: string): [string, string] {
  const match = PROMISE_PATTERN.exec(text);
  if (match) return [match[1]!.toUpperCase(), match[2] ?? ''];
  return ['', ''];
}

// 在 auto-continue 循环中检查信号
const [signal, reason] = checkPromiseSignal(lastText);
if (signal === 'COMPLETE') {
  console.log('[Kodax Auto-Continue] Agent signaled COMPLETE');
  break;
} else if (signal === 'BLOCKED') {
  console.log(`[Kodax Auto-Continue] Agent BLOCKED: ${reason}`);
  break;
}
```

---

## 10. Agent Team (P2)

### 10.1 并行 Agent 执行

```typescript
async function runParallelAgents(tasks: string[], providerName: string, thinking = false): Promise<string[]> {
  const results: string[] = [];

  // 使用交错启动避免 rate limit
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];

    // 交错延迟
    if (i > 0) await new Promise(r => setTimeout(r, STAGGER_DELAY * 1000));

    // 启动子 Agent（使用 stream lock 保证输出不交错）
    const result = await runSubAgent(task, providerName, thinking);
    results.push(result);
  }

  return results;
}
```

### 10.2 流式输出优化

```typescript
// 全局流式输出锁
const streamLock = { locked: false, queue: [] as (() => void)[] };

async function withStreamLock<T>(fn: () => Promise<T>): Promise<T> {
  while (streamLock.locked) {
    await new Promise<void>(resolve => streamLock.queue.push(resolve));
  }
  streamLock.locked = true;
  try {
    return await fn();
  } finally {
    streamLock.locked = false;
    const next = streamLock.queue.shift();
    if (next) next();
  }
}
```

---

## 11. TypeScript 特有改进详解

### 11.1 等待动画改进

**Python 版本**:
```python
print(".", end="", flush=True)  # 终端留下很多点
```

**TypeScript 版本**:
```typescript
function startWaitingDots(): () => void {
  let count = 0;
  const interval = setInterval(() => {
    process.stdout.write('.');
    count++;
    if (count >= 3) {
      process.stdout.write('\r   \r');  // 清除点
      count = 0;
    }
  }, 500);
  return () => {
    clearInterval(interval);
    process.stdout.write('\r   \r');
  };
}
```

### 11.2 read 工具增强

TypeScript 版本支持更多参数：

```typescript
{
  name: 'read',
  description: 'Read the contents of a file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The absolute path to the file' },
      offset: { type: 'number', description: 'Line number to start from' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
}
```

### 11.3 grep output_mode 参数

```typescript
{
  name: 'grep',
  description: 'Search for a pattern in files.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex pattern' },
      path: { type: 'string', description: 'File or directory to search' },
      ignore_case: { type: 'boolean', description: 'Case insensitive search' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count']
      },
    },
    required: ['pattern', 'path'],
  },
}
```

### 11.4 edit replace_all 参数

```typescript
{
  name: 'edit',
  description: 'Perform exact string replacement in a file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file to edit' },
      old_string: { type: 'string', description: 'The text to replace' },
      new_string: { type: 'string', description: 'The replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
}
```

---

## 12. 不实现的功能

以下功能暂不考虑，原因如下：

| 功能 | 不实现原因 |
|------|-----------|
| **MCP 集成** | 复杂度高，内置工具已覆盖核心功能 |
| **Notebook 支持** | 特定场景，可通过 bash 工具操作 |
| **TUI 界面** | 保持简单终端输出 |
| **Web UI** | 与 CLI 定位不符 |
| **分布式执行** | 过于复杂，单机足够 |

---

## 13. 快速开始

### 13.1 安装

```bash
# 克隆项目
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# 安装依赖
npm install

# 构建
npm run build
```

### 13.2 配置

```bash
# 设置 API Key
export ZHIPU_API_KEY=your-key

# 或使用其他 Provider
export KODAX_PROVIDER=kimi-code
export KIMI_API_KEY=your-key
```

### 13.3 使用

```bash
# 基本使用
node dist/kodax.js "创建一个简单的 HTTP 服务器"

# 禁用确认
node dist/kodax.js --no-confirm "删除临时文件"

# 使用 Skill
node dist/kodax.js /commit
node dist/kodax.js /explain src/kodax.ts

# 恢复会话
node dist/kodax.js --session resume "继续修改"
```

---

## 14. 文件结构

```
KodaX/
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript 配置
├── src/
│   └── kodax.ts           # 核心实现 (~1800 LOC)
├── dist/                  # 编译输出
├── tests/
│   └── test_cli.js        # CLI 测试
├── docs/
│   ├── README_CN.md       # 使用说明（中文）
│   ├── DESIGN.md          # 设计文档（本文件）
│   ├── LONG_RUNNING_GUIDE.md  # 长运行模式指南
│   └── TESTING.md         # 测试指南
└── ~/.kodax/              # 用户配置目录
    ├── skills/            # Skill 目录
    └── sessions/          # 会话存储
```

---

## 15. TypeScript vs Python 版本对比分析

本节详细分析 TypeScript 版本 (KodaX) 与 Python 版本 (KodaXP) 的差异。

### 15.1 TypeScript 做得比 Python 更好的部分 ✅

| 改进 | Python 版本 | TypeScript 版本 | 优势 |
|------|-------------|-----------------|------|
| **等待动画** | `print(".", end="")` 终端留痕迹 | `\r` 清除，视觉更整洁 | 用户体验更好 |
| **环境上下文** | 只有平台信息 | 包含 Node 版本 | 便于调试问题 |
| **read 工具** | 基本读取 | offset/limit 参数 | 支持大文件分页 |
| **grep output_mode** | 无 | `content \| files_with_matches \| count` | 更灵活的输出 |
| **edit replace_all** | 只替换第一个 | 支持批量替换 | 更强大的编辑 |
| **类型安全** | 运行时检查 | 编译时类型检查 | 更早发现错误 |
| **异步处理** | asyncio + threading | async/await | 代码更清晰 |
| **Session 元数据** | 无 createdAt | 有 createdAt | 记录创建时间 |

#### 15.1.1 等待动画改进详解

**Python 版本**:
```python
print(".", end="", flush=True)  # 终端留下很多点
```

**TypeScript 版本**:
```typescript
function startWaitingDots(): () => void {
  let count = 0;
  const interval = setInterval(() => {
    process.stdout.write('.');
    count++;
    if (count >= 3) {
      process.stdout.write('\r   \r');  // 清除点
      count = 0;
    }
  }, 500);
  return () => {
    clearInterval(interval);
    process.stdout.write('\r   \r');
  };
}
```

**效果对比**:
- Python: `Waiting.....` (点留在终端)
- TypeScript: `Waiting` (点被清除，更整洁)

#### 15.1.2 环境上下文增强

**Python 版本**:
```python
return f"Platform: {platform} (use: {cmdHint})"
```

**TypeScript 版本**:
```typescript
return `Platform: ${p === 'win32' ? 'Windows' : 'darwin' ? 'macOS' : 'Linux'}
${cmdHint}
Node: ${process.version}`;
```

**实际输出对比**:
```
Python:   Platform: Windows (use: dir, move, copy, del)
TypeScript: Platform: Windows
          Use: dir, move, copy, del
          Node: v20.10.0
```

#### 15.1.3 read 工具增强

**Python 版本**:
```python
{
  "name": "read",
  "input_schema": {
    "properties": {
      "path": {"type": "string"}
    },
    "required": ["path"]
  }
}
```

**TypeScript 版本**:
```typescript
{
  name: 'read',
  input_schema: {
    properties: {
      path: { type: 'string' },
      offset: { type: 'number', description: 'Line number to start from' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
}
```

**使用场景**: 读取大文件时可以分页，避免上下文溢出。

#### 15.1.4 grep output_mode 参数

**Python 版本**: 只能输出匹配内容

**TypeScript 版本**:
```typescript
output_mode: {
  type: 'string',
  enum: ['content', 'files_with_matches', 'count']
}
```

**使用场景**:
- `content`: 显示匹配行（默认）
- `files_with_matches`: 只显示文件名
- `count`: 显示匹配次数

### 15.2 TypeScript 与 Python 功能一致的部分 ⚖️

以下功能两个版本完全一致：

| 功能 | 实现方式 |
|------|---------|
| **核心 Agent 循环** | 相同的 message → tool → result 循环 |
| **流式输出** | 相同的 SSE 流处理 |
| **会话持久化** | 相同的 JSONL 格式 |
| **Provider 抽象** | 相同的 stream() 接口 |
| **长运行模式** | 相同的 feature_list.json + PROGRESS.md |
| **Promise 信号** | 相同的 COMPLETE/BLOCKED/DECIDE |
| **并行 Agent** | 相同的 rate limit + stream lock |
| **Git Context** | 相同的自动注入 |
| **Undo 功能** | 相同的备份恢复 |

### 15.3 TypeScript 版本需要保持同步的部分 🔄

这些部分需要与 Python 版本保持一致：

| 部分 | 说明 |
|------|------|
| **SubAgent 提示词** | 需要相同的 "You are a sub-agent..." 后缀 |
| **消息压缩摘要格式** | 使用 `[对话历史摘要]` |
| **工具返回格式** | `File written: ${path}`, `File edited: ${path}` |
| **错误消息前缀** | `[Tool Error]` |
| **thinking block 处理** | 包含 signature 和 redacted_thinking |
| **并行 Agent 显示** | 显示任务描述 `[Agent N] task_desc...` |
| **grep 输出格式** | `${file}:${line}: ${content}` (空格分隔) |
| **glob 输出格式** | 直接列出文件或 "No files found" |

### 15.4 总结对比表

| 维度 | Python (KodaXP) | TypeScript (KodaX) | 优胜者 |
|------|-----------------|-------------------|--------|
| **代码量** | ~2000 行 | ~1800 行 | 平局 |
| **类型安全** | 运行时 | 编译时 | TypeScript ✅ |
| **异步代码** | asyncio + threading | async/await | TypeScript ✅ |
| **等待动画** | 留痕迹 | 清除 | TypeScript ✅ |
| **环境上下文** | 基础 | 含 Node 版本 | TypeScript ✅ |
| **read 工具** | 基础 | offset/limit | TypeScript ✅ |
| **grep 工具** | 基础 | output_mode | TypeScript ✅ |
| **edit 工具** | 基础 | replace_all | TypeScript ✅ |
| **生态** | uv/pip | npm | 平局（各有优势） |
| **部署** | Python 环境 | Node 环境 | 平局（各有优势） |
| **Skill 系统** | Python 函数 | JavaScript 函数 | 平局（语言偏好） |

### 15.5 选择建议

**选择 TypeScript 版本 (KodaX) 如果**:
- 你熟悉 TypeScript/JavaScript
- 需要更好的类型安全
- 偏好 async/await 语法
- 需要更灵活的工具参数

**选择 Python 版本 (KodaXP) 如果**:
- 你熟悉 Python
- 需要使用 Python 生态的 Skill
- 偏好 Python 语法
- 需要使用 zhipuai SDK（原生支持）

**两个版本都很好，选择你更熟悉的语言即可！**

---

## 附录 A: Kimi Code API Thinking Block 处理

Kimi Code API（以及智谱 Coding、Anthropic）在启用 thinking 模式时，有特殊的内容顺序要求。本节记录这个关键实现细节。

### A.1 问题描述

当启用 thinking 模式后，如果 assistant 消息中包含 tool_use，但 thinking blocks 没有正确处理，API 会返回错误：

```
"thinking is enabled but reasoning_content is missing in assistant tool call message at index 2"
```

### A.2 根本原因

Kimi Code API 要求：
1. **thinking blocks 必须包含 signature 字段**
2. **thinking blocks 必须放在 content 数组的最前面**
3. **redacted_thinking blocks 也需要正确处理**

### A.3 正确实现

#### A.3.1 流处理中保存 signature

```typescript
// 在 content_block_start 事件中提取 signature
if (block.type === 'thinking') {
  currentThinkingSignature = (block as any).signature ?? '';
}

// 在 content_block_stop 事件中保存完整 thinking block
if (currentBlockType === 'thinking') {
  thinkingBlocks.push({
    type: 'thinking',
    thinking: currentThinking,
    signature: currentThinkingSignature  // 关键：必须包含 signature
  });
}

// 处理 redacted_thinking
if (currentBlockType === 'redacted_thinking') {
  const block = (event as any).content_block;
  if (block?.data) {
    thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
  }
}
```

#### A.3.2 消息转换时保持正确顺序

```typescript
private convertMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  return messages.map(m => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const content: Anthropic.Messages.ContentBlockParam[] = [];

    // 关键：thinking blocks 必须放在最前面
    for (const b of m.content) {
      if (b.type === 'thinking') {
        content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' } as any);
      } else if (b.type === 'redacted_thinking') {
        content.push({ type: 'redacted_thinking', data: b.data } as any);
      }
    }

    // 然后是 text blocks
    for (const b of m.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
    }

    // 最后是 tool blocks
    for (const b of m.content) {
      if (b.type === 'tool_use' && m.role === 'assistant') {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      } else if (b.type === 'tool_result' && m.role === 'user') {
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content });
      }
    }

    return { role: m.role, content } as Anthropic.Messages.MessageParam;
  });
}
```

#### A.3.3 构建 assistant content 时的顺序

```typescript
// 正确顺序：thinking → text → tool_use
const assistantContent: ContentBlock[] = [
  ...result.thinkingBlocks,  // thinking blocks 在最前面
  ...result.textBlocks,      // 然后是文本
  ...result.toolBlocks       // 最后是工具调用
];
messages.push({ role: 'assistant', content: assistantContent });
```

### A.4 内容顺序要求

```
assistant message content:
┌──────────────────────────────────────┐
│ thinking blocks (含 signature)       │ ← 必须在最前面
├──────────────────────────────────────┤
│ text blocks                          │
├──────────────────────────────────────┤
│ tool_use blocks                      │ ← 必须在最后
└──────────────────────────────────────┘
```

### A.5 与 Python 版本的对应

TypeScript 版本的实现与 Python 版本 (KodaXP) 保持一致：

```python
# Python 版本 (kodaxp.py:1069-1077)
assistant_content = []
for tb in thinking_blocks:
    assistant_content.append(tb)  # thinking 在最前面
for b in text_blocks:
    assistant_content.append({"type": "text", "text": b["text"]})
for b in tool_blocks:
    assistant_content.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"]})
```

### A.6 相关文件位置

| 功能 | 文件位置 |
|------|----------|
| 流处理 signature 提取 | `src/kodax.ts:390` |
| thinking block 保存 | `src/kodax.ts:420` |
| convertMessages 顺序处理 | `src/kodax.ts:447-469` |
| assistant content 构建 | `src/kodax.ts:1307`, `src/kodax.ts:1697` |

---

## 附录 B: Commander.js --no-xxx 选项处理

### B.1 问题描述

使用 `--no-confirm` 参数时，确认机制没有生效，用户仍然被要求确认工具执行。

### B.2 根本原因

Commander.js 对 `--no-xxx` 格式的选项有特殊处理：
- 定义 `--no-confirm` 时，commander 会创建 `opts.confirm = false`
- **而不是** `opts.noConfirm = true`

### B.3 解决方案

```typescript
// 错误写法
auto: opts.noConfirm ?? false,  // opts.noConfirm 是 undefined

// 正确写法
auto: opts.noConfirm === true || opts.confirm === false,
```

### B.4 替代方案

如果想避免这个问题，可以改用其他选项名：

```typescript
.option('--skip-confirm', 'Skip all confirmations')  // 避免 --no-xxx 格式
```

这样 commander 就会正常设置 `opts.skipConfirm = true`。

