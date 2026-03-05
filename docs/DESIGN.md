# KodaX 设计文档

> 极致轻量化 Coding Agent - 5层架构，每层可独立使用
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
│                    Interactive Layer (REPL)                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Ink UI       │ │ Permission   │ │ Built-in Commands        │ │
│  │ Components   │ │ Control      │ │                          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Coding Layer (独立库)                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Tools (8个)  │ │ Prompts      │ │ Agent Loop               │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Agent Layer (独立库)                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Session Mgmt │ │ Messages     │ │ Tokenizer                │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       AI Layer (独立库)                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Providers    │ │ Stream       │ │ Error Handling           │ │
│  │ (7个)        │ │ Handling     │ │                          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 模块依赖关系

```
CLI ──────┐
          ├──→ REPL ────→ Coding ────→ Agent ────→ AI
Skills ───┘                      │
                                 └──→ Skills (零依赖)
```

**各层职责**:
- **AI Layer**: 独立的 LLM 抽象层，可被其他项目复用
- **Agent Layer**: 通用 Agent 框架，会话管理和消息处理
- **Skills Layer**: Skills 标准实现，零外部依赖
- **Coding Layer**: Coding Agent，包含工具和 Prompts
- **REPL Layer**: 完整的交互式终端体验，权限控制
- **CLI Layer**: 命令行入口，组合所有模块

---

## 2. 包结构详解

### 2.1 @kodax/ai - LLM 抽象层

**设计目标**:
- 独立的 LLM 抽象层，可被其他项目复用
- 支持 7 个 LLM 提供商
- 统一的流式输出接口

**目录结构**:
```
packages/ai/
├── src/
│   ├── index.ts          # 统一导出
│   ├── types.ts          # 核心类型定义
│   ├── constants.ts      # 常量配置
│   ├── errors.ts         # 错误类型体系
│   └── providers/
│       ├── index.ts      # Provider 统一导出
│       ├── base.ts       # BaseProvider 抽象类
│       ├── anthropic.ts  # Anthropic Provider
│       ├── openai.ts     # OpenAI 兼容 Provider
│       └── registry.ts   # Provider 注册表
├── package.json
└── tsconfig.json
```

**支持的 Provider**:

| Provider | Thinking | Default Model |
|----------|----------|---------------|
| anthropic | Yes | claude-sonnet-4-20250514 |
| openai | No | gpt-4o |
| kimi | No | moonshot-v1-128k |
| kimi-code | Yes | k2p5 |
| qwen | No | qwen-max |
| zhipu | No | glm-4-plus |
| zhipu-coding | Yes | glm-5 |

### 2.2 @kodax/agent - Agent 框架

**设计目标**:
- 通用 Agent 框架，不包含具体业务逻辑
- 会话管理和消息处理
- Token 估算和消息压缩

**目录结构**:
```
packages/agent/
├── src/
│   ├── index.ts          # 统一导出
│   ├── types.ts          # 核心类型定义
│   ├── constants.ts      # 常量配置
│   ├── session.ts        # 会话管理
│   ├── messages.ts       # 消息处理/压缩
│   └── tokenizer.ts      # Token 估算
├── package.json
└── tsconfig.json
```

### 2.3 @kodax/skills - Skills 实现

**设计目标**:
- Skills 标准实现
- 零外部依赖，可独立使用
- 支持自然语言触发

**目录结构**:
```
packages/skills/
├── src/
│   ├── index.ts          # 统一导出
│   ├── types.ts          # Skills 类型定义
│   ├── discovery.ts      # Skills 发现
│   ├── executor.ts       # Skills 执行
│   ├── skill-loader.ts   # Skills 加载
│   ├── skill-registry.ts # Skills 注册
│   ├── skill-resolver.ts # Skills 解析
│   └── builtin/          # 内置 Skills
│       ├── code-review/
│       ├── tdd/
│       └── git-workflow/
├── package.json
└── tsconfig.json
```

### 2.4 @kodax/coding - Coding Agent

**设计目标**:
- 完整的 Coding Agent 实现
- 包含 8 个工具和系统 Prompts
- Agent 主循环实现

**目录结构**:
```
packages/coding/
├── src/
│   ├── index.ts          # 统一导出
│   ├── agent.ts          # Agent 主循环
│   ├── client.ts         # KodaXClient 类
│   ├── types.ts          # 核心类型定义
│   ├── constants.ts      # 常量配置
│   ├── errors.ts         # 错误类型
│   ├── session.ts        # 会话存储
│   ├── messages.ts       # 消息处理
│   ├── tokenizer.ts      # Token 估算
│   ├── prompts/          # 系统提示词
│   │   ├── index.ts
│   │   ├── system.ts
│   │   └── long-running.ts
│   └── tools/            # 工具实现
│       ├── index.ts
│       ├── types.ts
│       ├── registry.ts
│       ├── read.ts
│       ├── write.ts
│       ├── edit.ts
│       ├── bash.ts
│       ├── glob.ts
│       ├── grep.ts
│       ├── undo.ts
│       └── diff.ts
├── package.json
└── tsconfig.json
```

**工具列表**:

| Tool | Description |
|------|-------------|
| read | 读取文件内容（支持 offset/limit） |
| write | 写入文件 |
| edit | 精确字符串替换（支持 replace_all） |
| bash | 执行 Shell 命令 |
| glob | 文件模式匹配 |
| grep | 内容搜索（支持 output_mode） |
| undo | 撤销最后修改 |
| diff | 比较文件或显示变更 |

### 2.5 @kodax/repl - 交互式终端

**设计目标**:
- 完整的交互式终端体验
- 基于 Ink/React 的 UI 组件
- 权限控制和命令系统

**目录结构**:
```
packages/repl/
├── src/
│   ├── index.ts          # 统一导出
│   ├── common/           # 通用工具
│   ├── interactive/      # 交互逻辑
│   │   ├── index.ts
│   │   ├── commands.ts   # 命令系统
│   │   ├── repl.ts       # REPL 主逻辑
│   │   ├── themes.ts     # 主题配置
│   │   └── ...
│   ├── permission/       # 权限控制
│   │   ├── index.ts
│   │   └── modes.ts
│   └── ui/               # UI 组件
│       ├── index.ts
│       ├── App.tsx
│       ├── InkREPL.tsx
│       ├── components/   # Ink 组件
│       │   ├── InputPrompt.tsx
│       │   ├── MessageList.tsx
│       │   ├── StatusBar.tsx
│       │   ├── TextInput.tsx
│       │   └── ...
│       ├── contexts/     # React Contexts
│       ├── hooks/        # 自定义 Hooks
│       ├── themes/       # 主题配置
│       └── utils/        # 工具函数
├── package.json
└── tsconfig.json
```

---

## 3. 类型系统

### 3.1 核心类型

```typescript
// packages/coding/src/types.ts

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

/** Agent 选项 */
export interface KodaXOptions {
  provider: string;
  thinking?: boolean;
  maxIter?: number;          // 默认 200
  parallel?: boolean;
  auto?: boolean;
  mode?: PermissionMode;
  confirmTools?: Set<string>;
  session?: KodaXSessionOptions;
  events?: KodaXEvents;
}

/** 权限模式 */
export type PermissionMode =
  | 'plan'           // 只读模式
  | 'default'        // 安全模式（默认）
  | 'accept-edits'   // 自动接受编辑
  | 'auto-in-project'; // 项目内全自动

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
// packages/coding/src/types.ts

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

  // 工具执行钩子
  beforeToolExecute?: (tool: string, input: Record<string, unknown>) => Promise<boolean>;
}
```

---

## 4. Provider 系统

### 4.1 BaseProvider 抽象类

```typescript
// packages/ai/src/providers/base.ts

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
// packages/ai/src/providers/registry.ts

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
```

---

## 5. 工具系统

### 5.1 工具注册表

```typescript
// packages/coding/src/tools/registry.ts

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
```

### 5.2 工具实现示例

```typescript
// packages/coding/src/tools/read.ts

export async function toolRead(
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext
): Promise<string> {
  const fs = await import('fs/promises');

  const filePath = input.file_path as string;
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
// packages/coding/src/agent.ts

export async function runKodaX(
  options: KodaXOptions,
  prompt: string
): Promise<KodaXResult> {
  const provider = getProvider(options.provider);
  const maxIter = options.maxIter ?? 200;  // 默认 200
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

## 7. 权限控制系统

### 7.1 权限模式

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `default` | Safe mode (default) | write, edit, bash |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

### 7.2 Pattern-based Permission

```typescript
// 允许特定 Bash 命令
// 格式: Bash(command) 或 Bash(prefix:*)

const allowedPatterns = [
  'Bash(npm install)',
  'Bash(npm run build)',
  'Bash(git status)',
  'Bash(git diff:*)',  // 允许 git diff 后接任意参数
];

// 通配符 * 被拒绝以确保安全
```

### 7.3 保护路径

以下路径始终需要确认，不提供 "always" 选项：
- `.kodax/` - 项目配置目录
- `~/.kodax/` - 用户配置目录
- 项目根目录外的路径

---

## 8. Skills 系统

### 8.1 Skills 发现

```typescript
// packages/skills/src/discovery.ts

export async function discoverSkills(
  directories: string[]
): Promise<DiscoveredSkill[]> {
  // 扫描目录中的 skills
  // 支持 ~/.kodax/skills/ 和 .kodax/skills/
}
```

### 8.2 自然语言触发

Skills 可以通过自然语言描述触发，无需显式调用 `/skill`:

```typescript
// 用户输入: "帮我审查代码"
// 系统自动匹配 code-review skill

// 用户输入: "写测试用例"
// 系统自动匹配 tdd skill
```

### 8.3 内置 Skills

| Skill | Description | Trigger Keywords |
|-------|-------------|------------------|
| code-review | Code review and quality analysis | 审查代码, review, 检查代码 |
| tdd | Test-driven development workflow | 测试, test, tdd |
| git-workflow | Git commit and workflow | 提交代码, commit, git |

---

## 9. 配置系统

### 9.1 配置优先级

```
1. CLI 参数（最高优先级）
2. 环境变量
3. 项目配置 .kodax/config.local.json
4. 用户配置 ~/.kodax/config.json
5. 智能默认值（最低优先级）
```

### 9.2 配置文件

```json
// ~/.kodax/config.json
{
  "provider": "zhipu-coding",
  "thinking": false,
  "auto": false
}

// .kodax/config.local.json (项目级别)
{
  "permissionMode": "accept-edits"
}
```

---

## 10. REPL UI 设计

### 10.1 组件结构

```
┌────────────────────────────────────────────────────────────┐
│ [KodaX] Provider: zhipu-coding | Session: 20260304_001     │ ← Status Bar
├────────────────────────────────────────────────────────────┤
│                                                            │
│ User: Read package.json                                    │
│                                                            │
│ Assistant: I'll read the package.json file for you.        │ ← Message List
│ [Tool] read: package.json                                  │
│ The file contains...                                       │
│                                                            │
│ ● Thinking... (120 chars)                                  │ ← Thinking Indicator
│                                                            │
├────────────────────────────────────────────────────────────┤
│ > _                                                        │ ← Input Prompt
│ [thinking][auto]                                           │ ← Mode Indicators
└────────────────────────────────────────────────────────────┘
```

### 10.2 主题系统

内置主题:
- `dark` - 默认深色主题
- `warp` - Warp.dev 风格主题

```typescript
// 切换主题
/theme warp
/theme dark
```

---

## 11. 快速开始

### 11.1 作为库使用

```bash
npm install kodax
```

```typescript
import { runKodaX } from 'kodax';

const result = await runKodaX(
  { provider: 'zhipu-coding' },
  "分析这个函数的复杂度"
);

console.log(result.lastText);
```

### 11.2 作为 CLI 使用

```bash
# 安装
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build:packages
npm run build
npm link

# 基本使用
kodax "创建一个 HTTP 服务器"

# 交互模式
kodax
```

---

## 12. 扩展开发

### 12.1 自定义 Provider

```typescript
import { KodaXBaseProvider, registerProvider } from '@kodax/ai';

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
import { registerTool } from '@kodax/coding';

registerTool('my-tool', async (input, context) => {
  // 实现工具逻辑
  return 'result';
});
```

### 12.3 自定义 Skill

```markdown
<!-- ~/.kodax/skills/my-skill/SKILL.md -->
# My Custom Skill

## Description
A custom skill for my workflow.

## Trigger Keywords
my-task, custom

## Instructions
1. Step one
2. Step two
```

---

## 附录: 文件结构

```
KodaX/
├── package.json           # 根配置
├── tsconfig.json          # TypeScript 配置
├── src/
│   ├── index.ts           # 主入口
│   └── kodax_cli.ts       # CLI 入口
│
├── packages/
│   ├── ai/                # @kodax/ai
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── errors.ts
│   │   │   ├── constants.ts
│   │   │   └── providers/
│   │   └── package.json
│   │
│   ├── agent/             # @kodax/agent
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── session.ts
│   │   │   ├── messages.ts
│   │   │   └── tokenizer.ts
│   │   └── package.json
│   │
│   ├── skills/            # @kodax/skills
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── discovery.ts
│   │   │   ├── executor.ts
│   │   │   └── builtin/
│   │   └── package.json
│   │
│   ├── coding/            # @kodax/coding
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── agent.ts
│   │   │   ├── client.ts
│   │   │   ├── types.ts
│   │   │   ├── prompts/
│   │   │   └── tools/
│   │   └── package.json
│   │
│   └── repl/              # @kodax/repl
│       ├── src/
│       │   ├── index.ts
│       │   ├── common/
│       │   ├── interactive/
│       │   ├── permission/
│       │   └── ui/
│       └── package.json
│
├── docs/                  # 文档
│   ├── README_CN.md
│   ├── DESIGN.md
│   ├── TESTING.md
│   └── LONG_RUNNING_GUIDE.md
│
├── tests/                 # 测试
│
└── dist/                  # 编译输出
```
