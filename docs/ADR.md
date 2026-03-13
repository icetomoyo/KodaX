# KodaX 架构决策记录 (ADR)

> 记录 KodaX 项目中的关键架构决策及其理由

---

## ADR-001: 5层独立架构

### 状态
✅ 已采纳 (2026-02)

### 背景
需要设计一个既能作为完整产品使用，又能让各层被其他项目独立复用的架构。

### 决策
采用 5 层独立架构，每层可独立发布和使用：

```
CLI Layer          → 命令行入口
Interactive Layer  → REPL 交互
Coding Layer       → Coding Agent
Agent Layer        → 通用 Agent 框架
AI Layer           → LLM 抽象
```

### 理由
1. **复用性**: 其他项目可以只使用 `@kodax/ai` 作为 LLM 客户端
2. **测试性**: 每层独立测试，边界清晰
3. **演进性**: 可以独立升级各层而不影响其他层
4. **理解性**: 分层降低认知负担

### 后果
- 需要维护多个 npm 包
- 包之间的版本协调需要谨慎

---

## ADR-002: Provider 抽象模式

### 状态
✅ 已采纳 (2026-02)

### 背景
需要支持多种 LLM 提供商（Anthropic、OpenAI、Google 等），同时保持统一的调用接口。

### 决策
采用 **抽象基类 + 注册表** 模式：

```typescript
// 抽象基类
abstract class KodaXBaseProvider {
  abstract stream(messages, tools, system): Promise<StreamResult>;
}

// 注册表
const PROVIDER_REGISTRY = new Map<string, () => KodaXBaseProvider>();

function registerProvider(name: string, factory: () => KodaXBaseProvider): void;
function getProvider(name: string): KodaXBaseProvider;
```

### 理由
1. **扩展性**: 新增 Provider 只需实现基类并注册
2. **统一接口**: 调用方无需关心具体 Provider
3. **延迟加载**: 通过工厂函数延迟实例化

### 后果
- 每个 Provider 需要处理自己的错误转换
- 需要处理不同 Provider 的能力差异（如 thinking 支持）

---

## ADR-003: 流式输出优先

### 状态
✅ 已采纳 (2026-02)

### 背景
LLM 响应可能很长，用户需要实时看到输出，而不是等待全部完成。

### 决策
所有 Provider 必须实现流式输出接口：

```typescript
interface StreamOptions {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolUseStart?: (tool: { name: string; id: string }) => void;
  onToolResult?: (result: { id: string; content: string }) => void;
}
```

### 理由
1. **用户体验**: 实时反馈优于长时间等待
2. **中断能力**: 可以在输出过程中取消
3. **调试便利**: 可以看到 Agent 的"思考过程"

### 后果
- 需要处理流式数据的边界情况
- 测试复杂度增加

---

## ADR-004: 权限模式系统

### 状态
✅ 已采纳 (2026-02)

### 背景
Coding Agent 需要执行可能影响文件系统的操作，需要平衡安全性和效率。

### 决策
采用 4 级权限模式：

| 模式 | 描述 | 需确认的工具 |
|------|------|-------------|
| plan | 只读模式 | 所有修改工具被阻止 |
| default | 安全模式 | write, edit, bash |
| accept-edits | 自动接受编辑 | bash |
| auto-in-project | 项目内全自动 | 无 |

### 理由
1. **渐进信任**: 用户可以根据场景选择信任级别
2. **安全边界**: 危险路径始终需要确认
3. **效率平衡**: 常见操作可以自动化

### 后果
- 需要在多个地方检查权限
- 用户需要理解不同模式的差异

---

## ADR-005: Skills 作为指令模板

### 状态
✅ 已采纳 (2026-02)

### 背景
需要一种方式让用户定义可复用的任务模板，如代码审查、TDD 工作流等。

### 决策
Skills 采用 Markdown 文件格式，作为系统指令注入：

```markdown
# Code Review Skill

## Trigger Keywords
review, 审查代码, 代码检查

## Instructions
1. Review the code for quality
2. Check for security issues
3. Suggest improvements
```

### 理由
1. **简单性**: Markdown 易于编写和维护
2. **可移植性**: 纯文本文件，可以跨项目共享
3. **版本控制**: 可以用 Git 管理

### 后果
- Skills 不支持复杂逻辑（保持简单是故意的）
- 需要 Skill 发现和匹配机制

---

## ADR-006: Ink 作为 CLI UI 框架

### 状态
✅ 已采纳 (2026-02)

### 背景
需要构建复杂的交互式终端 UI，包括输入框、消息列表、状态栏等。

### 决策
使用 Ink (React for CLI) 框架：

```typescript
import { render, Box, Text } from 'ink';

const App = () => (
  <Box flexDirection="column">
    <Text color="green">Hello World</Text>
  </Box>
);

render(<App />);
```

### 理由
1. **组件化**: React 模式易于构建复杂 UI
2. **声明式**: 状态驱动的 UI 更新
3. **生态**: 丰富的 React 组件可复用

### 后果
- 需要学习 Ink 的限制和特性
- 某些终端功能需要自定义实现

---

## ADR-007: 工具注册表模式

### 状态
✅ 已采纳 (2026-02)

### 背景
Agent 需要调用多种工具（read, write, bash 等），需要统一的注册和调用机制。

### 决策
采用注册表模式：

```typescript
type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

const TOOL_REGISTRY = new Map<string, ToolHandler>();

function registerTool(name: string, handler: ToolHandler): void;
function getTool(name: string): ToolHandler | undefined;
```

### 理由
1. **扩展性**: 可以动态注册新工具
2. **解耦**: 工具实现与 Agent 逻辑分离
3. **测试性**: 可以单独测试每个工具

### 后果
- 工具名称冲突需要处理
- 工具错误需要统一格式

---

## ADR-008: 会话持久化格式

### 状态
✅ 已采纳 (2026-02)

### 背景
需要持久化会话数据，支持会话恢复和跨会话上下文。

### 决策
采用 JSONL 格式存储会话：

```jsonl
{"_type":"meta","title":"Session Title","id":"20260213_143000","gitRoot":"/path"}
{"role":"user","content":"Hello"}
{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}
```

### 理由
1. **流式写入**: 可以边运行边追加
2. **可读性**: 纯文本，便于调试
3. **兼容性**: 标准 JSON 格式

### 后果
- 大型会话文件可能较大
- 需要处理 JSON 解析错误

---

## ADR-009: Promise 信号系统

### 状态
✅ 已采纳 (2026-02)

### 背景
长运行模式下，Agent 需要一种方式通知系统任务状态。

### 决策
Agent 通过特殊 XML 标签发送信号：

```xml
<promise>COMPLETE</promise>           <!-- 所有任务完成 -->
<promise>BLOCKED:缺少API Key</promise>  <!-- 需要人工干预 -->
<promise>DECIDE:选择方案</promise>      <!-- 需要用户决策 -->
```

### 理由
1. **非侵入性**: 不改变工具调用方式
2. **可解析**: XML 格式易于检测
3. **语义清晰**: 信号含义明确

### 后果
- Agent 需要知道信号格式
- 需要在输出中检测信号

---

## ADR-010: 自动补全多源合并

### 状态
✅ 已采纳 (2026-03)

### 背景
REPL 需要支持多种补全：命令、文件、技能、参数。

### 决策
采用 Completer 接口 + Provider 协调模式：

```typescript
interface Completer {
  canComplete(input: string, cursorPos: number): boolean;
  getCompletions(input: string, cursorPos: number): Promise<Completion[]>;
}

// 多个 Completer 并行查询，结果合并排序
class AutocompleteProvider {
  completers: Completer[];  // SkillCompleter, FileCompleter, CommandCompleter...
}
```

### 理由
1. **职责分离**: 每个 Completer 只负责一种补全
2. **扩展性**: 新增补全类型只需添加 Completer
3. **性能**: 并行查询提升响应速度

### 后果
- 需要去重和排序合并逻辑
- 补全结果可能来自多个源

---

## ADR-011: 触发字符的空白约束

### 状态
✅ 已采纳 (2026-03)

### 背景
`/` 和 `@` 用于触发补全，但它们也可能出现在路径/URL 中。

### 决策
触发字符必须位于起始位置或前面有空白字符：

```typescript
// 有效触发
"/help"           // 起始位置
"hello /help"     // 前面有空格
"hello\n/help"    // 前面有换行

// 无效触发
"https://example.com"  // URL 中
"@src/file.txt"       // 已经在路径中
```

### 理由
1. **避免误触发**: URL/路径中的字符不应触发补全
2. **符合直觉**: 用户期望补全在"新词"开始时触发
3. **多行支持**: 换行后的命令也应触发

### 后果
- 需要检查前置字符
- `\s` 正则包含换行符

---

## 附录: ADR 模板

```markdown
# ADR-XXX: 标题

## 状态
[提议 | 采纳 | 弃用 | 被替代]

## 背景
描述导致此决策的背景和问题。

## 决策
描述所做的决策及其实现方式。

## 理由
1. 理由一
2. 理由二

## 后果
- 正面后果
- 负面后果
```
