# KodaX 高层设计 (HLD)

> 极致轻量化 Coding Agent - 架构概览

---

## 1. 系统概述

### 1.1 设计哲学

**极致轻量化 + LLM 优先**

- **5 层独立架构** - 每层可独立使用、测试、发布
- **零配置启动** - 智能默认值，开箱即用
- **LLM 驱动** - 利用 LLM 智能而非复杂规则

### 1.2 核心价值

| 特性 | 说明 |
|------|------|
| 多 Provider 支持 | 10 种 LLM 提供商，统一接口 |
| 交互式 REPL | Ink/React UI，流式输出 |
| 9 种工具 | Read, Write, Edit, Bash, Glob, Grep, Undo, Diff, AskUser |
| 4 种权限模式 | plan, default, accept-edits, auto-in-project |
| Skills 系统 | 自然语言触发，自定义扩展 |

---

## 2. 架构分层

### 2.1 分层架构图

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
│  │ Tools (9个)  │ │ Prompts      │ │ Agent Loop               │ │
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
│  │ (10个)       │ │ Handling     │ │                          │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖关系

```
CLI ──────┐
          ├──→ REPL ────→ Coding ────→ Agent ────→ AI
Skills ───┘
```

### 2.3 各层职责

| 层级 | 职责 | 独立使用场景 |
|------|------|-------------|
| **AI Layer** | LLM 抽象层，统一 Provider 接口 | 其他项目作为 LLM 客户端 |
| **Agent Layer** | 通用 Agent 框架，会话管理 | 非 Coding 场景的 Agent |
| **Skills Layer** | Skills 标准实现 | 零依赖 Skills 库 |
| **Coding Layer** | Coding Agent，工具 + Prompts | 嵌入其他 Agent 系统 |
| **REPL Layer** | 交互式终端，权限控制 | 完整 REPL 体验 |
| **CLI Layer** | 命令行入口 | CLI 应用 |

---

## 3. 模块结构

### 3.1 Monorepo 结构

```
KodaX/
├── packages/
│   ├── ai/              # @kodax/ai - LLM 抽象层
│   ├── agent/           # @kodax/agent - Agent 框架
│   ├── coding/          # @kodax/coding - Coding Agent
│   ├── repl/            # @kodax/repl - 交互式终端
│   └── skills/          # @kodax/skills - Skills 实现
├── src/                 # CLI 入口
└── docs/                # 文档
```

### 3.2 包依赖关系

```
@kodax/repl
    └── @kodax/coding
        ├── @kodax/agent
        │   └── @kodax/ai
        └── @kodax/skills (零依赖)
```

**关键特性**:
- **无循环依赖** - 严格的单向依赖
- **独立发布** - 每个包独立版本管理
- **独立测试** - 每层独立测试覆盖率 >= 80%

---

## 4. 核心设计模式

### 4.1 Provider 抽象模式

**问题**: 需要支持 10 种 LLM 提供商，接口各异

**解决方案**: 抽象基类 + 注册表模式

```typescript
// 抽象基类定义统一接口
abstract class KodaXBaseProvider {
  abstract stream(messages, tools, system): Promise<StreamResult>;
}

// 注册表管理所有 Provider
const PROVIDER_REGISTRY = new Map<string, () => KodaXBaseProvider>();
```

**优势**:
- 统一的调用接口
- 延迟加载（通过工厂函数）
- 易于扩展新 Provider

### 4.2 工具注册表模式

**问题**: Agent 需要调用多种工具，实现分散

**解决方案**: 统一注册表 + 标准接口

```typescript
type ToolHandler = (input: unknown, context: Context) => Promise<string>;

const TOOL_REGISTRY = new Map<string, ToolHandler>();
```

**优势**:
- 工具实现与 Agent 逻辑解耦
- 易于测试和扩展
- 统一错误处理

### 4.3 流式输出优先

**问题**: LLM 响应时间长，用户需要实时反馈

**解决方案**: 所有 Provider 必须实现流式输出

```typescript
interface StreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolUseStart?: (tool: { name: string; id: string }) => void;
  onToolResult?: (result: { id: string; content: string }) => void;
}
```

**优势**:
- 实时用户反馈
- 支持中断
- 可观察 Agent 思考过程

### 4.4 权限模式系统

**问题**: 安全性与效率的平衡

**解决方案**: 4 级权限模式 + 细粒度确认

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | 只读规划模式 | 所有修改工具被阻止 |
| `default` | 安全模式（默认） | write, edit, bash |
| `accept-edits` | 自动接受编辑 | bash only |
| `auto-in-project` | 项目内全自动 | 无（项目范围内） |

**优势**:
- 渐进式信任
- 危险操作始终需确认
- 适应不同场景

---

## 5. 数据流

### 5.1 Agent 循环

```
用户输入
    ↓
构建消息
    ↓
调用 LLM (流式)
    ↓
接收响应 (文本/思考/工具调用)
    ↓
如果有工具调用 → 执行工具 → 添加结果 → 继续
    ↓
如果没有工具调用 → 返回结果
    ↓
保存会话
```

### 5.2 会话持久化

**格式**: JSONL (JSON Lines)

```jsonl
{"_type":"meta","title":"Session Title","id":"20260213_143000","gitRoot":"/path"}
{"role":"user","content":"Hello"}
{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}
```

**优势**:
- 流式写入
- 纯文本可读
- 标准 JSON 格式

---

## 6. 扩展机制

### 6.1 自定义 Provider

实现 `KodaXBaseProvider` 并注册：

```typescript
class MyProvider extends KodaXBaseProvider {
  readonly name = 'my-provider';
  readonly supportsThinking = false;

  async stream(messages, tools, system) {
    // 实现流式调用
  }
}

registerProvider('my-provider', () => new MyProvider());
```

### 6.2 自定义工具

实现 `ToolHandler` 并注册：

```typescript
registerTool('my-tool', async (input, context) => {
  // 实现工具逻辑
  return 'result';
});
```

### 6.3 自定义 Skill

创建 Markdown 文件：

```markdown
# My Custom Skill

## Trigger Keywords
my-task, custom

## Instructions
1. Step one
2. Step two
```

放置于 `~/.kodax/skills/` 或 `.kodax/skills/`

---

## 7. 安全边界

### 7.1 保护路径

以下路径始终需要确认：
- `.kodax/` - 项目配置
- `~/.kodax/` - 用户配置
- 项目根目录外的路径

### 7.2 权限模式约束

| 操作 | plan | default | accept-edits | auto-in-project |
|------|------|---------|--------------|-----------------|
| Read | ✅ | ✅ | ✅ | ✅ |
| Write | ❌ | ⚠️ | ✅ | ✅ (项目内) |
| Bash | ❌ | ⚠️ | ⚠️ | ✅ (项目内) |

⚠️ = 需要确认，❌ = 被阻止，✅ = 自动执行

---

## 8. 性能考虑

### 8.1 Token 管理

- **消息压缩**: 超过阈值时压缩历史消息
- **Token 估算**: 估算消息 Token 数量
- **Context Window**: 根据模型自动适配

### 8.2 并行工具执行

- 支持多工具并行调用
- 顺序执行保护（避免冲突）
- 可配置并行度

### 8.3 流式输出

- 所有 Provider 流式输出
- 减少首字延迟
- 支持中断

---

## 9. 技术栈

| Category | Technology | Version |
|----------|-----------|---------|
| Runtime | Node.js | >= 20.0.0 |
| Language | TypeScript | >= 5.3.0 |
| Package Manager | npm workspaces | - |
| CLI Framework | Ink (React for CLI) | ^4.x |
| Test | Vitest | ^1.2.0 |
| LLM Providers | Anthropic, OpenAI, Zhipu, Kimi, MiniMax, DeepSeek, etc. | 11 total |

---

## 10. 未来扩展

### 10.1 Agent Team

多 Agent 并行执行：
- 任务分解
- 并行执行
- 结果合并

### 10.2 插件系统

- 动态加载 Provider
- 动态加载工具
- 插件市场

### 10.3 VSCode 集成

- VSCode 扩展
- 图形化界面
- 集成终端

---

## 参考资料

- [Architecture Decision Records](ADR.md)
- [Detailed Design](DD.md)
- [Product Requirements](PRD.md)
