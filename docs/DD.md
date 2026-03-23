# KodaX 详细设计 (DD)

> 实现细节和接口规范

---

## 1. 类型系统

### 1.1 核心类型定义

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

### 1.2 事件系统

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

## 2. Provider 系统

### 2.1 BaseProvider 抽象类

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

### 2.2 Provider 注册表

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

### 2.3 支持的 Provider

| Provider | Thinking | Default Model | Context Window |
|----------|----------|---------------|----------------|
| anthropic | Yes | claude-sonnet-4-6 | 200K |
| openai | No | gpt-5.3-codex | 400K |
| kimi | Yes | k2.5 | 256K |
| kimi-code | Yes | k2.5 | 256K |
| qwen | No | qwen3.5-plus | 256K |
| zhipu | No | glm-5 | 200K |
| zhipu-coding | Yes | glm-5 | 200K |
| minimax-coding | Yes | MiniMax-M2.7 | 204.8K |
| gemini-cli | Yes | (via gemini CLI) | Varies |
| codex-cli | Yes | (via codex CLI) | Varies |

---

## 3. 工具系统

### 3.1 工具注册表

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

### 3.2 工具列表

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

### 3.3 工具实现示例

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

## 4. Agent 循环

### 4.1 主循环实现

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

### 4.2 Promise 信号系统

长运行模式下，Agent 通过特殊 XML 标签发送信号：

```xml
<promise>COMPLETE</promise>           <!-- 所有任务完成 -->
<promise>BLOCKED:缺少API Key</promise>  <!-- 需要人工干预 -->
<promise>DECIDE:选择方案</promise>      <!-- 需要用户决策 -->
```

---

## 5. 权限控制系统

### 5.1 权限模式

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `default` | Safe mode (default) | write, edit, bash |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

### 5.2 Pattern-based Permission

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

### 5.3 保护路径

以下路径始终需要确认，不提供 "always" 选项：
- `.kodax/` - 项目配置目录
- `~/.kodax/` - 用户配置目录
- 项目根目录外的路径

---

## 6. Skills 系统

### 6.1 Skills 发现

```typescript
// packages/skills/src/discovery.ts

export async function discoverSkills(
  directories: string[]
): Promise<DiscoveredSkill[]> {
  // 扫描目录中的 skills
  // 支持 ~/.kodax/skills/ 和 .kodax/skills/
}
```

### 6.2 自然语言触发

Skills 可以通过自然语言描述触发，无需显式调用 `/skill`:

```typescript
// 用户输入: "帮我审查代码"
// 系统自动匹配 code-review skill

// 用户输入: "写测试用例"
// 系统自动匹配 tdd skill
```

### 6.3 内置 Skills

| Skill | Description | Trigger Keywords |
|-------|-------------|------------------|
| code-review | Code review and quality analysis | 审查代码, review, 检查代码 |
| tdd | Test-driven development workflow | 测试, test, tdd |
| git-workflow | Git commit and workflow | 提交代码, commit, git |

---

## 7. Project Mode 系统

### 7.1 概述

Project Mode 是 KodaX 的长时间运行项目管理功能，提供 AI-Driven 的项目管理体验。

**核心特性**:
- Feature 跟踪与进度管理
- AI 辅助编辑功能描述
- 智能项目分析
- `#<n>` 语法快速索引 Feature

### 7.2 命令列表

| 命令 | 别名 | 说明 |
|------|------|------|
| `/project init <task>` | `/proj i` | 初始化长运行项目 |
| `/project status` | `/proj st` | 显示项目状态和进度 |
| `/project next` | `/proj n` | 执行下一个未完成功能 |
| `/project auto` | `/proj a` | 进入自动继续模式 |
| `/project edit [#n] <prompt>` | `/proj e` | AI 驱动编辑功能描述 |
| `/project reset [--all]` | - | 重置项目（仅删除 init 创建的文件） |
| `/project analyze` | - | 分析项目状态和进度 |

### 7.3 Feature Index 语法

使用 `#<n>` 语法快速引用 Feature：

```bash
/project edit #0 "标记为完成"      # 编辑第一个 Feature
/project next #2                    # 执行第三个 Feature
/project edit #1 "添加步骤：测试"  # 编辑第二个 Feature
```

### 7.4 项目文件结构

```
项目根目录/
├── feature_list.json     # 功能列表（init 创建）
├── PROGRESS.md          # 进度日志（init 创建）
└── .kodax/
    ├── session_plan.md  # 当前会话计划
    └── settings.json    # 项目配置（不删除）
```

### 7.5 Reset 安全边界

`/project reset --all` 命令**只删除**以下项目文件：
- `feature_list.json`
- `PROGRESS.md`
- `.agent/project/` (session plan, brainstorm, harness records)

**永远不删除**：
- `.kodax/settings.json`
- `.kodax/memory/`
- 项目源代码（src/, package.json 等）

---

## 8. REPL UI 设计

### 8.1 组件结构

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

### 8.2 Ink 组件体系

**核心组件**:
- `App.tsx` - 根组件
- `InkREPL.tsx` - REPL 主逻辑
- `InputPrompt.tsx` - 输入框
- `MessageList.tsx` - 消息列表
- `StatusBar.tsx` - 状态栏
- `TextInput.tsx` - 文本输入

**自定义 Hooks**:
- `useSession` - 会话管理
- `useTheme` - 主题切换
- `useAutocomplete` - 自动补全

**Contexts**:
- `ThemeContext` - 主题上下文
- `SessionContext` - 会话上下文

### 8.3 主题系统

内置主题:
- `dark` - 默认深色主题
- `warp` - Warp.dev 风格主题

```typescript
// 切换主题
/theme warp
/theme dark
```

---

## 9. 自动补全系统

### 9.1 Completer 接口

```typescript
interface Completer {
  canComplete(input: string, cursorPos: number): boolean;
  getCompletions(input: string, cursorPos: number): Promise<Completion[]>;
}
```

### 9.2 多源合并

```typescript
// 多个 Completer 并行查询，结果合并排序
class AutocompleteProvider {
  completers: Completer[];  // SkillCompleter, FileCompleter, CommandCompleter...
}
```

### 9.3 触发字符约束

触发字符 (`/`, `@`) 必须位于起始位置或前面有空白字符：

```typescript
// 有效触发
"/help"           // 起始位置
"hello /help"     // 前面有空格
"hello\n/help"    // 前面有换行

// 无效触发
"https://example.com"  // URL 中
"@src/file.txt"       // 已经在路径中
```

---

## 10. 配置系统

### 10.1 配置优先级

```
1. CLI 参数（最高优先级）
2. 环境变量
3. 项目配置 .kodax/config.local.json
4. 用户配置 ~/.kodax/config.json
5. 智能默认值（最低优先级）
```

### 10.2 配置文件

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

## 11. 错误处理

### 11.1 错误类型体系

```typescript
// packages/ai/src/errors.ts

export class KodaXError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KodaXError';
  }
}

export class KodaXProviderError extends KodaXError {
  constructor(message: string, public provider: string) {
    super(message);
    this.name = 'KodaXProviderError';
  }
}

export class KodaXToolError extends KodaXError {
  constructor(message: string, public tool: string) {
    super(message);
    this.name = 'KodaXToolError';
  }
}
```

### 11.2 错误处理策略

- **Provider 错误**: 重试 + 降级
- **Tool 错误**: 返回错误信息给 LLM
- **权限错误**: 用户确认
- **网络错误**: 指数退避重试

---

## 12. 包结构详解

### 12.1 @kodax/ai

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

### 12.2 @kodax/agent

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

### 12.3 @kodax/skills

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

### 12.4 @kodax/coding

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

### 12.5 @kodax/repl

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

## 参考资料

- [High-Level Design](HLD.md)
- [Architecture Decision Records](ADR.md)
- [Product Requirements](PRD.md)
