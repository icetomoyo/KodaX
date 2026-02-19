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

## 已解决问题

| ID | 问题 | 优先级 | 位置 | 解决日期 | 描述 |
|----|------|--------|------|----------|------|
| 3 | 资源泄漏 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | readline 接口未关闭，通过 callbacks 传递复用 |
| 10 | 全局可变状态 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | 封装到 `ProjectRuntimeState` 类 |
| 11 | 函数过长 | 高 | `src/interactive/project-commands.ts` | 2026-02-19 | 提取辅助函数，每个函数职责单一 |
| 21 | Delete 键无效 | 高 | `src/ui/components/InputPrompt.tsx` | 2026-02-20 | 添加 `delete: deleteChar` 别名并调用处理函数 |

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

## 更新日志

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
