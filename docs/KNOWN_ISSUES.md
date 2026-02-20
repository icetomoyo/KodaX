# KodaX Known Issues

本目录记录已知但暂不紧急处理的问题。

## 待处理问题列表

| ID | 问题 | 优先级 | 位置 | 状态 | 描述 |
|----|------|--------|------|------|------|
| 1 | 未使用常量 | 低 | `src/cli/plan-mode.ts` | 待处理 | `PLAN_GENERATION_PROMPT` 常量已定义但未被使用 |
| 2 | 未使用参数 | 低 | `src/interactive/commands.ts` | 待处理 | `/plan` 命令 handler 的 `_currentConfig` 参数未使用 |
| 4 | Plan 无版本号 | 中 | `src/cli/plan-storage.ts` | 待处理 | `ExecutionPlan` 接口缺少版本字段，未来格式变更可能导致兼容性问题 |
| 5 | Plan 解析脆弱 | 中 | `src/cli/plan-mode.ts` | 待处理 | 正则表达式对 AI 输出格式要求严格，容错性差 |
| 6 | 中英文注释混用 | 低 | `src/interactive/` | 待处理 | 代码注释语言不一致，影响国际化协作 |
| 7 | 整数解析无范围检查 | 低 | `src/interactive/project-commands.ts` | 待处理 | `parseInt` 可能接受超大数字 |
| 8 | 静默吞掉错误 | 中 | `src/interactive/project-storage.ts` | 待处理 | `loadFeatures()` 所有错误都返回 null |
| 9 | 交互提示缺少输入验证 | 中 | `src/interactive/project-commands.ts` | 待处理 | 空白字符可能导致意外行为 |
| 12 | 不安全的类型断言 | 中 | `src/interactive/project-commands.ts` | 待处理 | `{} as KodaXOptions` 空对象断言为特定类型 |
| 13 | 非空断言缺乏显式检查 | 中 | `src/interactive/project-storage.ts` | 待处理 | 使用 `!` 操作符时缺少显式 null 检查 |
| 14 | 命令预览长度不一致 | 中 | `src/interactive/prompts.ts` | 待处理 | 某处显示 60 字符，另一处 50 字符，应统一常量 |
| 15 | ANSI Strip 性能 | 中 | `src/interactive/status-bar.ts` | 待处理 | 每次渲染都用正则替换，建议缓存或使用 `strip-ansi` 库 |
| 16 | 自动补全缓存内存泄漏 | 低 | `src/interactive/autocomplete.ts` | 待处理 | `setTimeout` 高频调用可能内存问题，建议用 LRU cache |
| 17 | 语法高亮语言支持不全 | 低 | `src/interactive/markdown-render.ts` | 待处理 | `_language` 参数未使用，仅支持 JS/TS 关键词 |
| 18 | Unicode 检测不完整 | 低 | `src/interactive/themes.ts` | 待处理 | 未检测 Windows CMD/PowerShell 的 `chcp 65001` 设置 |
| 19 | InkREPL 组件过大 | 中 | `src/ui/InkREPL.tsx` | 待处理 | ~637 行代码，可考虑拆分为更小模块 |
| 20 | TextBuffer 未使用方法 | 低 | `src/ui/utils/text-buffer.ts` | 待处理 | `getAbsoluteOffset()` 方法已实现但未被调用 |
| 22 | TODO 注释未清理 | 低 | `src/interactive/repl.ts` | 待处理 | 行 112-113 有 TODO 注释关于主题配置，需实现或转换为 issue |

## 已解决问题

| ID | 问题 | 优先级 | 位置 | 解决日期 | 描述 |
|----|------|--------|------|----------|------|
| 3 | 资源泄漏 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | readline 接口未关闭，通过 callbacks 传递复用 |
| 10 | 全局可变状态 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | 封装到 `ProjectRuntimeState` 类 |
| 11 | 函数过长 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | 提取辅助函数，每个函数职责单一 |
| 21 | Delete 键无效 | 高 | `src/ui/components/InputPrompt.tsx` | 2026-02-20 | 添加 `delete: deleteChar` 别名并调用处理函数 |
| 23 | Backspace 键无效 | 高 | `src/ui/components/InputPrompt.tsx` | 2026-02-20 | 调整 `\x7f` 检测优先级高于 `key.delete` |
| 24 | Shift+Enter 换行无效 | 高 | `src/ui/components/InputPrompt.tsx` | 2026-02-20 | 添加 `char === "\n"` 检测以支持更多终端 |
| 25 | Resize handler 空引用 | 高 | `src/ui/components/TextInput.tsx` | 2026-02-20 | 使用 `process.stdout` 替代闭包中的 `stdout` |
| 26 | 异步上下文直接退出 | 高 | `src/ui/InkREPL.tsx` | 2026-02-20 | 使用 `KodaXTerminalError` 替代 `process.exit()` |
| 27 | 超宽终端分隔符 | 中 | `src/ui/components/TextInput.tsx` | 2026-02-20 | 添加 `MAX_DIVIDER_WIDTH=200` 限制 |
| 28 | --continue 会话不恢复 | 高 | `src/ui/InkREPL.tsx` | 2026-02-20 | 添加 `resume`/`autoResume` 选项处理，加载最近会话 |
| 29 | gitRoot 未设置 | 中 | `src/ui/InkREPL.tsx` | 2026-02-20 | 在创建 context 前获取 gitRoot，用于会话过滤 |
| 30 | Thinking 内容不显示 | 高 | `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx` | 2026-02-20 | 添加 `thinkingContent` 字段和 `appendThinkingContent` 方法，实时显示 thinking 内容 |
| 31 | 非流式输出 | 高 | `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx` | 2026-02-20 | 添加 `streamingResponse` prop 实现实时流式显示 |
| 32 | Banner 消失 | 中 | `src/ui/InkREPL.tsx` | 2026-02-20 | 移除 `setShowBanner(false)` 调用，保持 Banner 可见 |
| 33 | /help 输出不可见 | 中 | `src/ui/InkREPL.tsx` | 2026-02-20 | 设置 `patchConsole: true` 使 console.log 输出在 Ink 中可见 |

---

## 问题详情

### Issue #1: 未使用常量 `PLAN_GENERATION_PROMPT`

**位置**: `src/cli/plan-mode.ts`

**问题描述**:
定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它，而是通过 `runKodaX` 内部的系统提示词来生成计划。

**影响**:
- 代码维护混淆：开发者可能误以为这个常量是实际使用的
- 死代码占用空间

**建议修复**:
- 选项 A: 删除这个常量
- 选项 B: 将其实际用于 `generatePlan` 函数

---

### Issue #2: `/plan` 命令未使用 `_currentConfig` 参数

**位置**: `src/interactive/commands.ts`

**问题描述**:
```typescript
handler: async (args, _context, callbacks, _currentConfig) => {
  // _currentConfig 从未使用
}
```

**影响**:
- API 一致性问题：所有命令 handler 签名相同
- 下划线前缀已表明"故意不使用"

**建议修复**:
- 保持现状（下划线前缀已足够）
- 或用它来验证 plan mode 与当前 mode 的兼容性

---

### Issue #4: Plan 文件无版本号

**位置**: `src/cli/plan-storage.ts` - `ExecutionPlan` 接口

**问题描述**:
`ExecutionPlan` 接口没有版本字段。如果未来计划格式变更（比如添加新字段、修改步骤结构），旧文件无法正确解析。

**影响**:
- 未来兼容性风险
- 用户升级后保存的计划可能损坏
- 错误信息不友好

**建议修复**:
```typescript
export interface ExecutionPlan {
  version: '1.0';  // 添加版本号
  id: string;
  // ...
}
```

---

### Issue #5: Plan 解析正则表达式脆弱

**位置**: `src/cli/plan-mode.ts`

**问题描述**:
```typescript
const match = line.match(/^\d+\.\s*\[([A-Z]+)\]\s*(.+?)(?:\s+-\s+(.+))?$/);
```

这个正则期望格式：`1. [READ] description - target`

**脆弱点**:
- AI 输出 `1.[READ]` (无空格) → 失败
- AI 输出 `1. [read]` (小写) → 失败
- AI 输出 `1. [ READ ]` (多空格) → 失败

**影响**:
- Plan 生成失败时无提示
- 跨模型兼容性差

**建议修复**:
- 添加更宽松的正则匹配
- 解析失败时给出友好提示
- 添加日志记录原始输出便于调试

---

### Issue #6: 中英文注释混用

**位置**: `src/interactive/` 目录下多个文件

**问题描述**:
代码中混合使用中文和英文注释，例如：
- `// 延迟创建 readline 接口` (中文)
- `// Check if project exists` (英文)

**影响**:
- 国际化团队协作困难
- 代码风格不一致

**建议修复**:
- 选择一种语言保持一致（推荐英文，便于国际协作）

---

### Issue #7: 整数解析无范围检查

**位置**: `src/interactive/project-commands.ts`

**问题描述**:
```typescript
const explicitIndex = indexArg ? parseInt(indexArg.split('=')[1] ?? '0', 10) : null;
```

`parseInt` 可接受超大数字，但功能索引应该有合理范围。

**影响**:
- 理论上可输入超大数字导致意外行为
- 实际使用中风险较低

**建议修复**:
```typescript
const parseIndex = (input: string): number | null => {
  const num = parseInt(input, 10);
  if (isNaN(num) || num < 0 || num > 10000) return null;
  return num;
};
```

---

### Issue #8: 静默吞掉错误

**位置**: `src/interactive/project-storage.ts` - `loadFeatures()` 方法

**问题描述**:
```typescript
async loadFeatures(): Promise<FeatureList | null> {
  try {
    // ...
  } catch {
    return null;  // 所有错误都返回 null
  }
}
```

不同错误有不同含义，但都被静默处理：
- `ENOENT` (文件不存在) → 正常，项目未初始化
- `EACCES` (权限不足) → 需要告知用户
- `SyntaxError` (JSON 格式错误) → 文件损坏，需要警告

**影响**:
- 调试困难
- 用户无法知道真正的问题

**建议修复**:
```typescript
async loadFeatures(): Promise<FeatureList | null> {
  try {
    const content = await fs.readFile(this.featuresPath, 'utf-8');
    return JSON.parse(content) as FeatureList;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null; // 预期：文件不存在
    }
    console.error('Failed to load feature_list.json:', error);
    throw error; // 非预期错误应该抛出
  }
}
```

---

### Issue #9: 交互提示缺少输入验证

**位置**: `src/interactive/project-commands.ts`

**问题描述**:
```typescript
rl.question(`${message} (y/n) `, answer => {
  resolve(answer.toLowerCase().startsWith('y'));
});
```

用户输入未进行清理，空白字符可能导致意外行为。

**影响**:
- 输入 " y" 或 "y " 可能不被正确识别
- 风险较低（CLI 环境）

**建议修复**:
```typescript
rl.question(`${message} (y/n) `, answer => {
  resolve(answer.trim().toLowerCase().startsWith('y'));
});
```

---

### Issue #12: 不安全的类型断言

**位置**: `src/interactive/project-commands.ts`

**问题描述**:
```typescript
const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;
```

空对象 `{}` 被断言为 `KodaXOptions` 类型，但空对象实际上并不包含该接口所需的任何属性。

**影响**:
- 运行时访问不存在的属性会得到 `undefined`
- 类型安全被绕过，可能导致难以追踪的 bug

**建议修复**:
```typescript
// 方案 A: 提供默认值
const defaultOptions: KodaXOptions = {
  provider: 'anthropic',
  // ...其他必需字段
};
const options = callbacks.createKodaXOptions?.() ?? defaultOptions;

// 方案 B: 运行时验证
const rawOptions = callbacks.createKodaXOptions?.() ?? {};
const options = validateKodaXOptions(rawOptions);
```

---

### Issue #13: 非空断言缺乏显式检查

**位置**: `src/interactive/project-storage.ts`

**问题描述**:
```typescript
return { feature: data.features[index]!, index };
```

使用 `!` 非空断言操作符时，虽然前面已经通过 `getNextPendingIndex` 验证了索引有效性，但：

**影响**:
- 代码审查者需要追溯验证逻辑
- 未来修改可能导致静默失败
- TypeScript 的 `!` 在编译后被移除，运行时无保护

**建议修复**:
```typescript
const feature = data.features[index];
if (!feature) return null;  // 显式检查
return { feature, index };
```

---

### Issue #3: 资源泄漏 - Readline 接口（已解决）

**原问题描述**:
`project-commands.ts` 创建了自己的 readline 接口但从未关闭，可能导致：
- 字符双倍显示
- 资源泄漏

**解决方案**:
通过 `CommandCallbacks` 传递 REPL 的 readline 接口：
- 在 `CommandCallbacks` 接口添加 `readline?: readline.Interface`
- 在 `repl.ts` 中传入 `rl` 实例
- 在 `project-commands.ts` 中使用传入的接口

---

### Issue #10: 全局可变状态（已解决）

**原问题描述**:
```typescript
let rl: readline.Interface | null = null;
let autoContinueRunning = false;
```

模块级可变变量可能导致状态残留和测试困难。

**解决方案**:
封装到 `ProjectRuntimeState` 类：
```typescript
class ProjectRuntimeState {
  private _autoContinueRunning = false;
  get autoContinueRunning(): boolean { ... }
  setAutoContinueRunning(value: boolean): void { ... }
  reset(): void { ... }  // 用于测试
}
export const projectRuntimeState = new ProjectRuntimeState();
```

---

### Issue #11: 函数过长（已解决）

**原问题描述**:
- `projectInit()` ~70 行
- `projectNext()` ~80 行
- `projectAuto()` ~100 行

**解决方案**:
提取辅助函数：
- `createConfirmFn()` - 创建确认提示函数
- `createQuestionFn()` - 创建问题提示函数
- `displayFeatureInfo()` - 显示功能信息
- `buildFeaturePrompt()` - 构建执行提示词
- `executeSingleFeature()` - 执行单个功能
- `parseAutoOptions()` - 解析 auto 命令选项
- `parseAutoAction()` - 解析用户动作

---

---

### Issue #14: 命令预览长度不一致

**位置**: `src/interactive/prompts.ts` - 行 253-254 vs 239

**问题描述**:
```typescript
// 行 239: 显示 50 字符
const preview = cmd.slice(0, 50) + (cmd.length > 50 ? '...' : '');

// 行 253-254: 显示 60 字符
const cmd = (input.command as string)?.slice(0, 60) ?? '';
const suffix = cmd.length >= 60 ? '...' : '';
```

**影响**:
- 用户体验不一致
- 代码维护困难

**建议修复**:
```typescript
const CMD_PREVIEW_LENGTH = 50;
const preview = cmd.slice(0, CMD_PREVIEW_LENGTH) + (cmd.length > CMD_PREVIEW_LENGTH ? '...' : '');
```

---

### Issue #15: ANSI Strip 性能问题

**位置**: `src/interactive/status-bar.ts` - 行 206-208

**问题描述**:
```typescript
private stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
```

`stripAnsi()` 在每次渲染时都调用正则替换，状态栏更新频繁时可能影响性能。

**影响**:
- 高频渲染时可能有性能开销
- 正则表达式每次都重新编译

**建议修复**:
- 使用 `strip-ansi` npm 包（更高效）
- 或缓存正则表达式：`const ANSI_REGEX = /\x1b\[[0-9;]*m/g;`
- 或缓存已处理的字符串

---

### Issue #16: 自动补全缓存内存泄漏风险

**位置**: `src/interactive/autocomplete.ts` - 行 95-110

**问题描述**:
```typescript
setTimeout(() => this.cache.delete(dir), this.cacheTimeout);
```

使用 `setTimeout` 进行缓存过期清理，在高频率调用时可能导致：
- 大量定时器积压
- 内存无法及时释放

**影响**:
- 长时间运行时可能内存泄漏
- 大量文件操作时定时器堆积

**建议修复**:
```typescript
// 使用 LRU cache with TTL
import { LRUCache } from 'lru-cache';

private cache = new LRUCache<string, string[]>({
  max: 100,
  ttl: 60_000, // 60 seconds
});
```

---

### Issue #17: 语法高亮语言支持不全

**位置**: `src/interactive/markdown-render.ts` - 行 43-65

**问题描述**:
```typescript
function highlightCode(code: string, _language: string): string {
  const keywords = /\b(const|let|var|...)\b/g;
  // _language 参数未使用
}
```

**影响**:
- 无法针对不同语言高亮（Python、Go、Rust 等）
- 关键词列表只覆盖 JavaScript/TypeScript

**建议修复**:
```typescript
function highlightCode(code: string, language: string): string {
  const keywordSets: Record<string, string[]> = {
    javascript: ['const', 'let', 'var', ...],
    python: ['def', 'class', 'import', 'from', ...],
    go: ['func', 'package', 'import', 'var', ...],
    // ...
  };
  const keywords = keywordSets[language] ?? keywordSets['javascript'];
  // ...
}
```

或集成 `highlight.js` / `prism` 库。

---

### Issue #18: Unicode 检测不完整

**位置**: `src/interactive/themes.ts` - 行 93-101

**问题描述**:
```typescript
function supportsUnicode(): boolean {
  if (process.platform === 'win32') {
    const env = process.env;
    return env.WT_SESSION !== undefined ||  // Windows Terminal
           env.TERM_PROGRAM === 'vscode' ||
           env.CI === 'true';
  }
  return true;
}
```

**影响**:
- 未检测 CMD/PowerShell 的代码页设置 (`chcp 65001`)
- 用户设置了 UTF-8 代码页但仍显示 ASCII 字符

**建议修复**:
```typescript
function supportsUnicode(): boolean {
  if (process.platform === 'win32') {
    const env = process.env;
    // Windows Terminal, VS Code, CI
    if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.CI) {
      return true;
    }
    // 检测代码页 (65001 = UTF-8)
    // 注意：这需要同步执行 chcp 命令，可能影响性能
    // 可以在启动时缓存结果
    return false;
  }
  return true;
}
```

---

### Issue #19: InkREPL 组件过大

**位置**: `src/ui/InkREPL.tsx`

**问题描述**:
InkREPL 组件约 637 行代码，包含多个职责：
- 命令处理
- Shell 命令执行
- 会话管理
- 消息格式化
- 状态管理

**影响**:
- 代码可读性降低
- 维护成本增加
- 难以单独测试各模块

**建议修复**:
拆分为多个模块：
```typescript
// 提取 shell 执行逻辑
// src/ui/utils/shell-executor.ts
export async function executeShellCommand(...)

// 提取消息格式化
// src/ui/utils/message-formatter.ts
export function formatMessage(...)

// 提取会话管理
// src/ui/hooks/useSessionManager.ts
export function useSessionManager(...)
```

---

### Issue #20: TextBuffer 未使用方法

**位置**: `src/ui/utils/text-buffer.ts` - 行 436-445

**问题描述**:
```typescript
getAbsoluteOffset(): number {
  let offset = 0;
  for (let i = 0; i < this._cursor.row; i++) {
    offset += (this._lines[i]?.length ?? 0) + 1;
  }
  offset += sliceByCodePoints(line, 0, this._cursor.col).length;
  return offset;
}
```

`getAbsoluteOffset()` 方法计算光标在文本中的字节偏移位置，但当前未被任何 UI 组件调用。

**影响**:
- 代码冗余（约 10 行）
- 不影响功能

**建议处理**:
- **保留**：作为未来高级编辑功能的扩展点（如文本选择、外部编辑器同步）
- **删除**：如果确定不需要这些功能
- **标注**：添加 `@internal` 或文档说明用途

---

### Issue #21: Delete 键无效（已解决）

**原问题描述**:
在 `InputPrompt.tsx` 中，Delete 键的处理函数为空，无法删除光标后的字符：
```typescript
if (key.delete) {
  // 空实现
  return;
}
```

**解决方案**:
1. 从 `useTextBuffer` hook 解构时添加 `delete` 别名：
```typescript
const { ..., delete: deleteChar } = useTextBuffer({...});
```
2. 在 Delete 键处理中调用 `deleteChar()`:
```typescript
if (key.delete) {
  deleteChar();
  return;
}
```

---

### Issue #23: Backspace 键无效（已解决）

**原问题描述**:
在某些终端（如 Windows Terminal）中，按 Backspace 键无法删除字符。调试发现：
- 终端发送 `char = "\x7f"` (DEL, ASCII 127)
- Ink 检测到 `key.backspace = false`, `key.delete = true`

代码中 `key.delete` 检查在 `char === "\x7f"` 之前，导致调用 `deleteChar()` (删除光标后字符) 而非 `backspace()` (删除光标前字符)。

**解决方案**:
调整检测顺序，使 `\x7f` 字符检测优先于 `key.delete` 检测：
```typescript
// 退格键 - 检查多种情况（必须在 key.delete 检查之前）
if (key.backspace || char === "\x7f" || char === "\x08" || (key.ctrl && char === "h")) {
  backspace();
  return;
}

// Delete 键（真正的 Delete 键，不是 Backspace）
if (key.delete) {
  deleteChar();
  return;
}
```

---

### Issue #24: Shift+Enter 换行无效（已解决）

**原问题描述**:
在某些终端中，按 Shift+Enter 无法插入换行。调试发现：
- 终端发送 `char = "\n"` (LF)
- Ink 检测到 `key.return = false`, `key.shift = false`

Ink 的 `useInput` hook 在某些终端中无法正确检测 Shift+Enter 组合键。

**解决方案**:
添加对 `\n` 字符的检测作为换行的后备方案：
```typescript
const isNewline = (key.return && key.shift) ||
                  (key.return && key.ctrl) ||
                  (char === "\n" && !key.return);  // 新增：支持更多终端

if (isNewline) {
  newline();
  return;
}
```

---

### Issue #22: TODO 注释未清理

**位置**: `src/interactive/repl.ts` - 行 112-113

**问题描述**:
```typescript
// 应用主题 (使用默认 dark 主题)
// TODO: 从配置文件读取主题设置
const theme = getCurrentTheme();
```

代码中留有 TODO 注释，表明主题配置功能尚未完全实现。

**影响**:
- 代码维护混淆
- 用户无法通过配置文件自定义主题

**建议修复**:
- 选项 A: 实现从配置文件读取主题设置的功能
- 选项 B: 将 TODO 转换为 GitHub issue 追踪
- 选项 C: 如果短期内不计划实现，移除 TODO 注释

---

### Issue #30: Thinking 内容不显示（已解决）

**原问题描述**:
在 Thinking 模式下，模型的 thinking 内容（`onThinkingDelta`）不会在 UI 中实时显示。虽然 `thinkingCharCount` 会更新，但实际内容不可见。

**解决方案**:
1. 在 `StreamingContextValue` 接口添加 `thinkingContent: string` 字段
2. 添加 `appendThinkingContent(text: string)` 方法
3. 在 `MessageList` 组件中添加 `thinkingContent` 显示区域（淡灰色斜体）
4. 在 `InkREPL` 中使用 `appendThinkingContent` 替代 `appendThinkingChars`

---

### Issue #31: 非流式输出（已解决）

**原问题描述**:
非 Thinking 模式下，响应内容（`onTextDelta`）会在流式完成后一次性显示，而非实时逐字显示。

**解决方案**:
1. 在 `MessageList` 组件添加 `streamingResponse` prop
2. 添加流式响应实时显示区域（显示 `streamingState.currentResponse`）
3. 在 `InkREPL` 中传递 `streamingResponse={streamingState.currentResponse}`

---

### Issue #32: Banner 消失（已解决）

**原问题描述**:
用户首次交互后，启动 Banner 会消失或被隐藏，导致无法看到版本和配置信息。

**解决方案**:
移除 `setShowBanner(false)` 调用。Banner 在启动时显示，随着消息增加自然向上滚动，保持布局稳定。

---

### Issue #33: /help 输出不可见（已解决）

**原问题描述**:
`/help` 等命令的 `console.log` 输出在 Ink 的 alternate buffer 中不可见。

**解决方案**:
在 Ink 的 `render()` 选项中设置 `patchConsole: true`，将 `console.log` 输出路由到 Ink 渲染系统。

---

## 更新日志

- **2026-02-20**: v0.3.3 流式显示修复
  - 解决 Issue #30: Thinking 内容不显示 - 添加 `thinkingContent` 字段实时显示
  - 解决 Issue #31: 非流式输出 - 添加 `streamingResponse` 实时显示
  - 解决 Issue #32: Banner 消失 - 移除状态切换保持可见
  - 解决 Issue #33: /help 输出不可见 - 设置 `patchConsole: true`
  - 新增 28 个测试用例（thinking 和 tool 功能测试）
- **2026-02-20**: Phase 6-8 完成与会话管理修复
  - 解决 Issue #28: --continue 会话不恢复 - 添加 `resume`/`autoResume` 选项处理
  - 解决 Issue #29: gitRoot 未设置 - 在创建 context 前获取 gitRoot
  - 更新功能对比表：消息列表、流式响应、工具可视化、加载指示器、状态栏现已实现
  - 添加 Phase 6-8 手动测试指南到功能文档
- **2026-02-20**: v0.3.2 高优先级问题修复
  - 解决 Issue #25: Resize handler 空引用 - 使用 `process.stdout` 替代闭包中的 `stdout`
  - 解决 Issue #26: 异步上下文直接退出 - 新增 `KodaXTerminalError` 错误类，在顶层处理
  - 解决 Issue #27: 超宽终端分隔符 - 添加 `MAX_DIVIDER_WIDTH=200` 限制
  - 新增 21 个测试用例（errors.test.ts, text-input-utils.test.ts）
- **2026-02-20**: UI 改进与代码审查
  - 新增启动 Banner 显示当前工作目录
  - 多行输入使用分隔线样式替代 `...` 提示
  - 分隔线响应终端宽度变化
  - 修复版本号读取错误（使用 `import.meta.url` 代替 `process.cwd()`）
- **2026-02-20**: 按键问题修复
  - 解决 Issue #23: Backspace 键无效 - 调整 `\x7f` 检测优先级
  - 解决 Issue #24: Shift+Enter 换行无效 - 添加 `\n` 字符检测
  - 移除调试代码和未使用的导入
- **2026-02-20**: 代码审查与安全修复
  - **安全修复** (高严重性):
    - 修复 `openExternalEditor` 中的命令注入漏洞：使用 `spawnSync` 代替 `execSync`
    - 修复临时文件路径遍历风险：使用 `os.tmpdir()` 代替 `process.env.TEMP`
    - 添加编辑器名称基本安全验证
    - 添加随机后缀避免临时文件名冲突
  - **功能修复** (中严重性):
    - 完善 Esc+Esc 编辑功能：现在会打开外部编辑器编辑上一条消息
    - 改进入口点检测逻辑：添加详细注释，使用 `endsWith` 代替 `includes`
  - **已知问题更新**:
    - 新增 Issue #22 (TODO 注释未清理)
  - **架构简化**:
    - 移除 `--ink` 参数，统一使用 Ink UI
    - Ink UI 在不支持 raw mode 时显示清晰错误提示
- **2026-02-20**: Ink UI 代码审查与修复
  - 解决 Issue #21: Delete 键无效问题
  - 新增 `tests/text-buffer.test.ts` 单元测试（48 个测试用例）
  - 新增 Issue #19-20（中/低优先级）
- **2026-02-19**: Ink UI 集成完成
  - 新增 `src/ui/InkREPL.tsx` 适配器层
  - 更新 `kodax_cli.ts` 添加 `--ink` 参数
  - Phase 4 集成完成，可通过 `kodax --ink` 使用实验性 Ink UI
- **2026-02-19**: 交互式 UI Phase 1-4 代码审查
  - 新增 Issue #14-18（中/低优先级）
- **2026-02-19**: 代码审查更新
  - 新增 Issue #6-9, #12-13（低/中优先级）
  - 解决 Issue #3, #10, #11（高优先级）
  - 重构 `project-commands.ts`
- **2025-02-18**: 初始创建，记录代码审查发现的4个待处理问题
