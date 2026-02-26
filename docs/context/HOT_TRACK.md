# 热轨快照

_生成时间: 2026-02-26 10:45_
_快照版本: v5_

---

## 1. 项目状态

### 当前目标
代码质量改进 + Issue 修复

### 进度概览
| 模块 | 状态 | 说明 |
|------|------|------|
| Issue 011 - 命令预览长度 | 已修复 | v0.4.4 (状态更新) |
| Issue 012 - ANSI Strip 性能 | 已修复 | v0.4.4 |
| Issue 035 - Backspace 检测 | 已修复 | 状态不一致修正 |
| Issue 016 - InkREPL 过大 | **已修复** | v0.4.4, 994→819 行 |

### 当下阻塞
无阻塞问题

---

## 2. 已确定接口（骨架）

### packages/repl/src/ui/utils/ (Issue 016 新模块)

```typescript
// session-storage.ts
export interface SessionData {
  messages: KodaXMessage[];
  title: string;
  gitRoot: string;
}
export interface SessionStorage {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>>;
}
export class MemorySessionStorage implements SessionStorage { ... }

// shell-executor.ts
export async function executeShellCommand(command: string, config?: ShellExecutorConfig): Promise<string>
export async function processSpecialSyntax(input: string, config?: ShellExecutorConfig): Promise<string>
export function isShellCommand(input: string): boolean
export function isShellCommandSuccess(result: string): boolean

// message-utils.ts
export function extractTextContent(content: string | unknown[]): string
export function extractTitle(messages: KodaXMessage[]): string
export function formatMessagePreview(content: string, maxLength?: number): string

// console-capturer.ts
export class ConsoleCapturer {
  start(): void;
  stop(): string[];
  getCaptured(): string[];
  clear(): void;
}
export async function withCapture<T>(fn: () => Promise<T>): Promise<{ result: T; captured: string[] }>
```

### status-bar.ts (ANSI_REGEX 缓存)
```typescript
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
private stripAnsi(str: string): string {
  ANSI_REGEX.lastIndex = 0;
  return str.replace(ANSI_REGEX, '');
}
```

### common/utils.ts (PREVIEW_MAX_LENGTH)
```typescript
export const PREVIEW_MAX_LENGTH = 60;
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
| Issue 016 采用方案 A | 低风险渐进式改进，不影响组件结构 | 2026-02-26 |
| 提取 4 个工具模块 | 改善代码组织，便于测试 | 2026-02-26 |
| 删除 printStartupBanner 死代码 | 已被 Banner 组件替代 | 2026-02-26 |

---

## 5. 当前 Open Issues (13)

| 优先级 | ID | 标题 |
|--------|-----|------|
| Medium | 019 | 状态栏 Session ID 显示问题 |
| Medium | 036 | React 状态同步潜在问题 |
| Medium | 037 | 两套键盘事件系统冲突 (Planned v0.5.0+) |
| Low | 001-006, 013-015, 017-018, 039 | 代码质量问题 |

---

*Token 数: ~950*
