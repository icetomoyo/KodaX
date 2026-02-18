# KodaX 设计文档

> 极致轻量化 Coding Agent - 分层架构，Core 层可独立使用
>
> **架构哲学**: 极简且智能 - 每行代码都应有其价值，每个默认值都应是最佳选择

---

## 1. 架构概览

### 1.1 分层设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Layer                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Command Parse│ │ File Storage │ │ Event Handler (Spinner)  │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Interactive Layer                             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ REPL Loop    │ │ Context Mgmt │ │ Built-in Commands        │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Core Layer (独立库)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Agent Loop   │ │ Providers    │ │ Tools                    │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 模块依赖关系

```
CLI ──────┐
          ├──→ Interactive ────→ Core
REPL ─────┘

Core 层零依赖外部 UI/CLI 库
```

---

## 2. Core 层设计

### 2.1 设计目标

- **库优先**: 可作为独立 npm 包使用
- **零 UI 依赖**: 纯逻辑层，不依赖 readline/chalk
- **事件驱动**: 通过事件回调与上层通信
- **智能默认**: 开箱即用，无需复杂配置

### 2.2 核心 API

```typescript
// 极简调用 - 一行代码运行 Agent
import { runKodaX } from 'kodax/core';

const result = await runKodaX(
  { provider: 'anthropic' },
  "创建一个 HTTP 服务器"
);
```

```typescript
// 流式输出 - 实时显示结果
const result = await runKodaX({
  provider: 'anthropic',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onToolUseStart: (tool) => console.log(`Using ${tool.name}...`),
  }
}, "分析代码结构");
```

```typescript
// 会话续接 - 保持上下文
const result = await runKodaX({
  provider: 'anthropic',
  session: {
    id: '20250218_001946',
    storage: new FileSessionStorage()
  }
}, "继续刚才的任务");
```

### 2.3 Core 目录结构

```
src/core/
├── index.ts              # 统一导出，极简 API 入口
├── types.ts              # 核心类型定义
├── errors.ts             # 错误类型体系
├── constants.ts          # 常量配置
├── config.ts             # 配置管理
├── agent.ts              # Agent 主循环 (~200 LOC)
├── session.ts            # 会话存储接口
├── messages.ts           # 消息处理/压缩
├── tokenizer.ts          # Token 估算
├── providers/
│   ├── index.ts          # Provider 统一导出
│   ├── base.ts           # BaseProvider 抽象类
│   ├── anthropic.ts      # Anthropic 兼容 Provider
│   ├── openai.ts         # OpenAI 兼容 Provider
│   └── registry.ts       # Provider 注册表
├── tools/
│   ├── index.ts          # 工具统一导出
│   ├── types.ts          # 工具类型定义
│   ├── registry.ts       # 工具注册表
│   ├── read.ts           # read 工具实现
│   ├── write.ts          # write 工具实现
│   ├── edit.ts           # edit 工具实现
│   ├── bash.ts           # bash 工具实现
│   ├── glob.ts           # glob 工具实现
│   ├── grep.ts           # grep 工具实现
│   └── undo.ts           # undo 工具实现
└── prompts/
    ├── index.ts          # 提示词统一导出
    ├── system.ts         # SYSTEM_PROMPT
    └── long-running.ts   # LONG_RUNNING_PROMPT
```

### 2.4 文件大小控制

| 模块 | 目标行数 | 说明 |
|------|---------|------|
| `agent.ts` | < 200 | Agent 核心循环 |
| `providers/*.ts` | < 150/个 | Provider 实现 |
| `tools/*.ts` | < 100/个 | 工具实现 |
| `types.ts` | < 150 | 类型定义 |

---

## 3. 类型系统

### 3.1 核心类型

```typescript
// src/core/types.ts

/** 消息内容块 */
export type KodaXContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

/** 消息 */
export interface KodaXMessage {
  role: 'user' | 'assistant';
  content: string | KodaXContentBlock[];
}

/** 工具定义 */
export interface KodaXToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Provider 配置 */
export interface KodaXProviderConfig {
  apiKeyEnv: string;
  baseUrl?: string;
  model: string;
  supportsThinking: boolean;
}

/** Agent 选项 */
export interface KodaXOptions {
  provider: string;
  thinking?: boolean;
  maxIter?: number;
  parallel?: boolean;
  auto?: boolean;
  confirmTools?: Set<string>;
  session?: KodaXSessionOptions;
  events?: KodaXEvents;
}

/** 会话选项 */
export interface KodaXSessionOptions {
  id?: string;
  resume?: boolean;
  autoResume?: boolean;
  storage?: KodaXSessionStorage;
  initialMessages?: KodaXMessage[];
}

/** Agent 结果 */
export interface KodaXResult {
  success: boolean;
  lastText: string;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  signalReason?: string;
  messages: KodaXMessage[];
  sessionId: string;
}
```

### 3.2 事件系统

```typescript
// src/core/types.ts

export interface KodaXEvents {
  // 流式输出
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string, charCount: number) => void;
  onThinkingEnd?: (thinking: string) => void;
  onToolUseStart?: (tool: { name: string; id: string }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  onToolInputDelta?: (toolName: string, partialJson: string) => void;
  onStreamEnd?: () => void;

  // 状态通知
  onSessionStart?: (info: { provider: string; sessionId: string }) => void;
  onIterationStart?: (iter: number, maxIter: number) => void;
  onCompact?: (estimatedTokens: number) => void;
  onRetry?: (reason: string, attempt: number, maxAttempts: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;

  // 用户交互（由上层实现）
  onConfirm?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}
```

---

## 4. Provider 系统

### 4.1 BaseProvider 抽象类

```typescript
// src/core/providers/base.ts

export abstract class KodaXBaseProvider {
  abstract readonly name: string;
  abstract readonly supportsThinking: boolean;
  protected abstract readonly config: KodaXProviderConfig;

  abstract stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    system: string,
    thinking?: boolean,
    streamOptions?: KodaXProviderStreamOptions
  ): Promise<KodaXStreamResult>;

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

### 4.2 Provider 注册表

```typescript
// src/core/providers/registry.ts

const PROVIDER_REGISTRY = new Map<string, () => KodaXBaseProvider>();

export function registerProvider(
  name: string,
  factory: () => KodaXBaseProvider
): void {
  PROVIDER_REGISTRY.set(name, factory);
}

export function getProvider(name: string): KodaXBaseProvider {
  const factory = PROVIDER_REGISTRY.get(name);
  if (!factory) throw new KodaXProviderError(`Unknown provider: ${name}`, name);
  return factory();
}

export function listProviders(): string[] {
  return Array.from(PROVIDER_REGISTRY.keys());
}

// 自动注册内置 Provider
registerProvider('anthropic', () => new AnthropicProvider());
registerProvider('openai', () => new OpenAIProvider());
registerProvider('kimi', () => new KimiProvider());
// ...
```

---

## 5. 工具系统

### 5.1 工具注册表

```typescript
// src/core/tools/registry.ts

export type ToolHandler = (
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
) => Promise<string>;

const TOOL_REGISTRY = new Map<string, ToolHandler>();

export function registerTool(name: string, handler: ToolHandler): void {
  TOOL_REGISTRY.set(name, handler);
}

export function getTool(name: string): ToolHandler | undefined {
  return TOOL_REGISTRY.get(name);
}

// 自动注册内置工具
registerTool('read', toolRead);
registerTool('write', toolWrite);
registerTool('edit', toolEdit);
// ...
```

### 5.2 工具实现示例

```typescript
// src/core/tools/read.ts

import { KodaXToolError } from '../errors.js';

export async function toolRead(
  input: Record<string, unknown>
): Promise<string> {
  const fs = await import('fs/promises');

  const filePath = input.path as string;
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;

  try {
    let content = await fs.readFile(filePath, 'utf-8');

    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = offset ?? 0;
      const end = limit ? start + limit : lines.length;
      content = lines.slice(start, end).join('\n');
    }

    return content;
  } catch (e) {
    throw new KodaXToolError(
      `Failed to read ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      'read'
    );
  }
}
```

---

## 6. Agent 循环

### 6.1 主循环实现

```typescript
// src/core/agent.ts

export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const provider = getProvider(options.provider);
  const maxIter = options.maxIter ?? 50;
  const events = options.events ?? {};

  // 初始化会话
  const sessionId = await resolveSessionId(options.session);
  const messages = await loadMessages(options.session, sessionId);

  // 添加用户消息
  messages.push({ role: 'user', content: prompt });

  // 通知会话开始
  events.onSessionStart?.({ provider: provider.name, sessionId });

  let lastText = '';

  // Agent 循环
  for (let iter = 0; iter < maxIter; iter++) {
    events.onIterationStart?.(iter + 1, maxIter);

    // 消息压缩
    const compacted = compactMessages(messages);
    if (compacted !== messages) {
      events.onCompact?.(estimateTokens(messages));
    }

    // 调用 LLM
    const result = await provider.stream(
      compacted,
      Array.from(TOOL_REGISTRY.keys()).map(getToolDefinition),
      getSystemPrompt(),
      options.thinking,
      {
        onTextDelta: events.onTextDelta,
        onThinkingDelta: events.onThinkingDelta,
      }
    );

    // 构建 assistant 消息
    const assistantContent: KodaXContentBlock[] = [
      ...result.thinkingBlocks,
      ...result.textBlocks,
      ...result.toolBlocks,
    ];
    messages.push({ role: 'assistant', content: assistantContent });

    // 检查信号
    const [signal, reason] = checkPromiseSignal(result.textBlocks.map(b => b.text).join(' '));
    if (signal) {
      return { success: true, lastText, signal, signalReason: reason, messages, sessionId };
    }

    // 没有工具调用则结束
    if (result.toolBlocks.length === 0) break;

    // 执行工具
    const toolResults = await executeTools(
      result.toolBlocks,
      options.confirmTools ?? DEFAULT_CONFIRM_TOOLS,
      options.auto ?? false
    );

    // 添加工具结果
    messages.push({ role: 'user', content: toolResults });
  }

  // 保存会话
  await saveSession(options.session, sessionId, messages);

  return { success: true, lastText, messages, sessionId };
}
```

---

## 7. CLI 层设计

### 7.1 CLI 与 Core 的关系

```
CLI 层职责:
├── 参数解析 (Commander.js)
├── 文件存储 (FileSessionStorage)
├── 事件处理 (Spinner, 格式化输出)
├── 自定义命令系统
└── 交互式 REPL

CLI 层不直接包含 Agent 逻辑，全部委托给 Core 层
```

### 7.2 FileSessionStorage

```typescript
// src/cli/storage.ts

import type { KodaXSessionStorage, KodaXMessage } from '../core/types.js';

export class FileSessionStorage implements KodaXSessionStorage {
  async save(
    id: string,
    data: { messages: KodaXMessage[]; title: string; gitRoot: string }
  ): Promise<void> {
    // JSONL 格式存储
  }

  async load(id: string): Promise<...> {
    // 加载会话
  }

  async list(): Promise<...> {
    // 列出所有会话
  }
}
```

### 7.3 CLI 事件处理器

```typescript
// src/cli/events.ts

import type { KodaXEvents } from '../core/types.js';

export function createCliEvents(showSessionId = true): KodaXEvents {
  let spinner: ReturnType<typeof startSpinner> | null = null;

  return {
    onSessionStart: (info) => {
      if (showSessionId) {
        console.log(chalk.cyan(`[KodaX] Provider: ${info.provider} | Session: ${info.sessionId}`));
      } else {
        console.log(chalk.cyan(`[KodaX] Provider: ${info.provider}`));
      }
    },

    onThinkingDelta: (text, count) => {
      if (!spinner) spinner = startSpinner();
      spinner.updateText(`Thinking... (${count} chars)`);
    },

    // ... 其他事件处理
  };
}
```

---

## 8. Interactive 层设计

### 8.1 REPL 实现

```typescript
// src/interactive/repl.ts

import { runKodaX } from '../core/agent.js';

export async function runInteractiveMode(options: RepLOptions): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(options),
  });

  const context = await createInteractiveContext(options);

  rl.on('line', async (input) => {
    const processed = await processSpecialSyntax(input);

    if (processed.type === 'command') {
      await executeCommand(processed.command, context);
    } else {
      // 委托给 Core 层
      await runKodaX({
        ...options,
        session: {
          id: context.sessionId,
          initialMessages: context.messages,
          storage: options.storage,
        },
      }, processed.content);
    }
  });
}
```

---

## 9. 配置系统

### 9.1 配置优先级

```
1. CLI 参数（最高优先级）
2. 环境变量
3. 配置文件 ~/.kodax/config.json
4. 智能默认值（最低优先级）
```

### 9.2 配置文件

```json
{
  "provider": "anthropic",
  "thinking": false,
  "auto": false
}
```

---

## 10. 与旧版本的对比

### 10.1 架构变化

| 特性 | v0.2.x (旧) | v0.3.0 (新) |
|------|-------------|-------------|
| **文件结构** | 单文件 kodax.ts (~1800 LOC) | 分层架构，Core 独立 |
| **库使用** | 不可单独使用 | `import { runKodaX } from 'kodax/core'` |
| **测试** | 难以单元测试 | 每层可独立测试 |
| **扩展** | 修改核心文件 | 注册 Provider/Tool 即可 |

### 10.2 CLI 参数变化

| 旧参数 | 新参数 | 说明 |
|--------|--------|------|
| `-p, --prompt` | `-p, --print` | 语义更清晰 |
| `-c, --confirm` | `-c, --continue` | 与 Claude Code 对齐 |
| `-y, --no-confirm` | `-y, --auto` | 更简洁 |
| `--single-shot` | 移除 | 与 `-p` 语义重复 |

---

## 11. 快速开始

### 11.1 作为库使用

```bash
npm install kodax
```

```typescript
import { runKodaX } from 'kodax/core';

const result = await runKodaX(
  { provider: 'anthropic' },
  "分析这个函数的复杂度"
);

console.log(result.lastText);
```

### 11.2 作为 CLI 使用

```bash
# 安装
npm install -g kodax

# 基本使用
kodax "创建一个 HTTP 服务器"

# 流式输出模式
kodax -p "快速任务"

# 继续上次会话
kodax -c

# 交互模式
kodax
```

---

## 12. 扩展开发

### 12.1 自定义 Provider

```typescript
import { KodaXBaseProvider } from 'kodax/core';

class MyProvider extends KodaXBaseProvider {
  readonly name = 'my-provider';
  readonly supportsThinking = false;
  protected config = { apiKeyEnv: 'MY_API_KEY', model: 'model-1' };

  async stream(messages, tools, system) {
    // 实现流式调用
  }
}

registerProvider('my-provider', () => new MyProvider());
```

### 12.2 自定义工具

```typescript
import { registerTool } from 'kodax/core';

registerTool('my-tool', async (input, context) => {
  // 实现工具逻辑
  return 'result';
});
```

---

## 附录: 文件结构

```
KodaX/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # 主入口
│   ├── core/                 # Core 层（可独立使用）
│   │   ├── index.ts
│   │   ├── types.ts
│   │   ├── errors.ts
│   │   ├── constants.ts
│   │   ├── config.ts
│   │   ├── agent.ts
│   │   ├── session.ts
│   │   ├── messages.ts
│   │   ├── tokenizer.ts
│   │   ├── providers/
│   │   ├── tools/
│   │   └── prompts/
│   ├── cli/                  # CLI 层
│   │   ├── index.ts
│   │   ├── options.ts
│   │   ├── storage.ts
│   │   ├── events.ts
│   │   └── commands.ts
│   └── interactive/          # Interactive 层
│       ├── index.ts
│       ├── repl.ts
│       ├── context.ts
│       └── commands.ts
├── dist/                     # 编译输出
└── tests/                    # 测试
    ├── core/
    ├── cli/
    └── interactive/
```
