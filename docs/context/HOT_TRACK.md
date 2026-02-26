# 热轨快照

_生成时间: 2026-02-26 14:35_
_快照版本: v7_

---

## 1. 项目状态

### 当前目标
代码质量改进 + Issue 修复

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 011 - 命令预览长度 | 已修复 | v0.4.4 |
| Issue 012 - ANSI Strip 性能 | 已修复 | v0.4.4 |
| Issue 016 - InkREPL 过大 | 已修复 | v0.4.4, 994→819 行 |
| Issue 045 - Thinking 内容闪烁 | 已修复 | v0.4.4, 提交 30a9ea2 |
| Issue 019 - Session ID 显示 | **已修复** | v0.4.4, 完整显示 15 字符 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### StreamingContext.tsx (Issue 045 修复)
```typescript
export interface StreamingActions {
  // ... existing methods
  stopThinking(): void;           // 只设置 isThinking=false，不清空内容
  clearThinkingContent(): void;   // 响应完成时清空 thinking 内容
}

// MessageList 渲染条件
// 旧: {isThinking && thinkingContent && ...}
// 新: {isLoading && thinkingContent && ...}
```

### packages/repl/src/ui/utils/ (Issue 016 新模块)

```typescript
// session-storage.ts
export interface SessionStorage {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
}

// shell-executor.ts
export async function executeShellCommand(command: string, config?: ShellExecutorConfig): Promise<string>
export async function processSpecialSyntax(input: string, config?: ShellExecutorConfig): Promise<string>

// message-utils.ts
export function extractTextContent(content: string | unknown[]): string
export function extractTitle(messages: KodaXMessage[]): string

// console-capturer.ts
export class ConsoleCapturer { start(): void; stop(): string[]; }
export async function withCapture<T>(fn: () => Promise<T>): Promise<{ result: T; captured: string[] }>
```

---

## 3. 避坑墓碑

| 死胡同 | 失败原因 | 日期 |
|--------|----------|------|
| 50ms 延迟方案 | 临时方案，不能根本解决问题 | 2026-02-25 |
| WebSearch 查询 | API 错误，无法获取信息 | 2026-02-25 |

---

## 4. 关键决策

| 决策 | 理由 | 日期 |
|------|------|------|
| Issue 016 采用方案 A | 低风险渐进式改进 | 2026-02-26 |
| Thinking 内容用 isLoading 控制显示 | 响应期间持续显示，完成后消失 | 2026-02-26 |
| 添加 clearThinkingContent() | 响应完成时清空，为下次请求做准备 | 2026-02-26 |

---

## 5. 关键理解：Claude API 流式机制

### Content Block 交织
```
单次 API 调用 → 单次流式响应

content_block_start (thinking)
  → thinking_delta → onThinkingDelta()
  → content_block_stop → onThinkingEnd()

content_block_start (text)
  → text_delta → onTextDelta()
  → content_block_stop

content_block_start (thinking)  ← 可多次交织
  → thinking_delta → onThinkingDelta()
  → content_block_stop → onThinkingEnd()

...直到 message_stop
```

### Thinking 状态生命周期
```
startThinking() → thinkingContent = ""
    ↓
onThinkingDelta → thinkingContent += text (累加)
    ↓
onThinkingEnd → isThinking = false (内容保留)
    ↓
响应完成 → clearThinkingContent() (清空)
```

---

## 6. 当前 Open Issues (11)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 (Planned v0.5.0+) |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

*Token 数: ~1,100*
