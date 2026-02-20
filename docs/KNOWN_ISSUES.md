# Known Issues

_Last Updated: 2026-02-20 23:30_

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Created | Resolved |
|----|----------|--------|-------|---------|----------|
| M001 | Low | Open | 未使用常量 PLAN_GENERATION_PROMPT | 2026-02-19 | - |
| M002 | Low | Open | /plan 命令未使用 _currentConfig 参数 | 2026-02-19 | - |
| M003 | Medium | Open | Plan 文件无版本号 | 2026-02-19 | - |
| M004 | Medium | Open | Plan 解析正则表达式脆弱 | 2026-02-19 | - |
| M005 | Low | Open | 中英文注释混用 | 2026-02-19 | - |
| M006 | Low | Open | 整数解析无范围检查 | 2026-02-19 | - |
| M007 | Medium | Open | 静默吞掉错误 | 2026-02-19 | - |
| M008 | Medium | Open | 交互提示缺少输入验证 | 2026-02-19 | - |
| M009 | Medium | Open | 不安全的类型断言 | 2026-02-19 | - |
| M010 | Medium | Open | 非空断言缺乏显式检查 | 2026-02-19 | - |
| M011 | Medium | Open | 命令预览长度不一致 | 2026-02-19 | - |
| M012 | Medium | Open | ANSI Strip 性能问题 | 2026-02-19 | - |
| M013 | Low | Open | 自动补全缓存内存泄漏风险 | 2026-02-19 | - |
| M014 | Low | Open | 语法高亮语言支持不全 | 2026-02-19 | - |
| M015 | Low | Open | Unicode 检测不完整 | 2026-02-19 | - |
| M016 | Medium | Open | InkREPL 组件过大 | 2026-02-19 | - |
| M017 | Low | Open | TextBuffer 未使用方法 | 2026-02-19 | - |
| M018 | Low | Open | TODO 注释未清理 | 2026-02-19 | - |
| M034 | Medium | Open | 状态栏 Session ID 显示问题 | 2026-02-20 | - |
| M019 | High | Resolved | 资源泄漏 - Readline 接口 | 2026-02-19 | 2026-02-19 |
| M020 | High | Resolved | 全局可变状态 | 2026-02-19 | 2026-02-19 |
| M021 | High | Resolved | 函数过长 | 2026-02-19 | 2026-02-19 |
| M022 | High | Resolved | Delete 键无效 | 2026-02-20 | 2026-02-20 |
| M023 | High | Resolved | Backspace 键无效 | 2026-02-20 | 2026-02-20 |
| M024 | High | Resolved | Shift+Enter 换行无效 | 2026-02-20 | 2026-02-20 |
| M025 | High | Resolved | Resize handler 空引用 | 2026-02-20 | 2026-02-20 |
| M026 | High | Resolved | 异步上下文直接退出 | 2026-02-20 | 2026-02-20 |
| M027 | Medium | Resolved | 超宽终端分隔符 | 2026-02-20 | 2026-02-20 |
| M028 | High | Resolved | --continue 会话不恢复 | 2026-02-20 | 2026-02-20 |
| M029 | Medium | Resolved | gitRoot 未设置 | 2026-02-20 | 2026-02-20 |
| M030 | High | Resolved | Thinking 内容不显示 | 2026-02-20 | 2026-02-20 |
| M031 | High | Resolved | 非流式输出 | 2026-02-20 | 2026-02-20 |
| M032 | Medium | Resolved | Banner 消失 | 2026-02-20 | 2026-02-20 |
| M033 | Medium | Resolved | /help 输出不可见 | 2026-02-20 | 2026-02-20 |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->

### M001: 未使用常量 PLAN_GENERATION_PROMPT
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  - 定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它
  - 而是通过 `runKodaX` 内部的系统提示词来生成计划
- **Context**: `src/cli/plan-mode.ts`
- **Proposed Solution**:
  - 选项 A: 删除这个常量
  - 选项 B: 将其实际用于 `generatePlan` 函数

---

### M002: /plan 命令未使用 _currentConfig 参数
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  handler: async (args, _context, callbacks, _currentConfig) => {
    // _currentConfig 从未使用
  }
  ```
  - 所有命令 handler 签名相同，但此参数未被使用
- **Context**: `src/interactive/commands.ts`
- **Proposed Solution**: 保持现状（下划线前缀已表明"故意不使用"）或用它来验证 plan mode 与当前 mode 的兼容性

---

### M003: Plan 文件无版本号
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  - `ExecutionPlan` 接口没有版本字段
  - 如果未来计划格式变更（添加新字段、修改步骤结构），旧文件无法正确解析
- **Context**: `src/cli/plan-storage.ts` - `ExecutionPlan` 接口
- **Impact**: 未来兼容性风险，用户升级后保存的计划可能损坏
- **Proposed Solution**:
  ```typescript
  export interface ExecutionPlan {
    version: '1.0';  // 添加版本号
    id: string;
    // ...
  }
  ```

---

### M004: Plan 解析正则表达式脆弱
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  const match = line.match(/^\d+\.\s*\[([A-Z]+)\]\s*(.+?)(?:\s+-\s+(.+))?$/);
  ```
  - 期望格式：`1. [READ] description - target`
  - 脆弱点：
    - AI 输出 `1.[READ]` (无空格) → 失败
    - AI 输出 `1. [read]` (小写) → 失败
    - AI 输出 `1. [ READ ]` (多空格) → 失败
- **Context**: `src/cli/plan-mode.ts`
- **Impact**: Plan 生成失败时无提示，跨模型兼容性差
- **Proposed Solution**: 添加更宽松的正则匹配，解析失败时给出友好提示，添加日志记录原始输出

---

### M005: 中英文注释混用
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  - 代码中混合使用中文和英文注释
  - 例如：`// 延迟创建 readline 接口` (中文) vs `// Check if project exists` (英文)
- **Context**: `src/interactive/` 目录下多个文件
- **Impact**: 国际化团队协作困难，代码风格不一致
- **Proposed Solution**: 选择一种语言保持一致（推荐英文，便于国际协作）

---

### M006: 整数解析无范围检查
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  const explicitIndex = indexArg ? parseInt(indexArg.split('=')[1] ?? '0', 10) : null;
  ```
  - `parseInt` 可接受超大数字，但功能索引应该有合理范围
- **Context**: `src/interactive/project-commands.ts`
- **Proposed Solution**:
  ```typescript
  const parseIndex = (input: string): number | null => {
    const num = parseInt(input, 10);
    if (isNaN(num) || num < 0 || num > 10000) return null;
    return num;
  };
  ```

---

### M007: 静默吞掉错误
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  async loadFeatures(): Promise<FeatureList | null> {
    try {
      // ...
    } catch {
      return null;  // 所有错误都返回 null
    }
  }
  ```
  - 不同错误有不同含义，但都被静默处理：
    - `ENOENT` (文件不存在) → 正常，项目未初始化
    - `EACCES` (权限不足) → 需要告知用户
    - `SyntaxError` (JSON 格式错误) → 文件损坏，需要警告
- **Context**: `src/interactive/project-storage.ts` - `loadFeatures()` 方法
- **Impact**: 调试困难，用户无法知道真正的问题
- **Proposed Solution**:
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

### M008: 交互提示缺少输入验证
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  rl.question(`${message} (y/n) `, answer => {
    resolve(answer.toLowerCase().startsWith('y'));
  });
  ```
  - 用户输入未进行清理，空白字符可能导致意外行为
  - 输入 " y" 或 "y " 可能不被正确识别
- **Context**: `src/interactive/project-commands.ts`
- **Proposed Solution**:
  ```typescript
  rl.question(`${message} (y/n) `, answer => {
    resolve(answer.trim().toLowerCase().startsWith('y'));
  });
  ```

---

### M009: 不安全的类型断言
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;
  ```
  - 空对象 `{}` 被断言为 `KodaXOptions` 类型，但空对象实际上并不包含该接口所需的任何属性
- **Context**: `src/interactive/project-commands.ts`
- **Impact**: 运行时访问不存在的属性会得到 `undefined`，类型安全被绕过
- **Proposed Solution**:
  ```typescript
  // 方案 A: 提供默认值
  const defaultOptions: KodaXOptions = {
    provider: 'anthropic',
    // ...其他必需字段
  };
  const options = callbacks.createKodaXOptions?.() ?? defaultOptions;
  ```

---

### M010: 非空断言缺乏显式检查
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  return { feature: data.features[index]!, index };
  ```
  - 使用 `!` 非空断言操作符时缺少显式 null 检查
  - TypeScript 的 `!` 在编译后被移除，运行时无保护
- **Context**: `src/interactive/project-storage.ts`
- **Proposed Solution**:
  ```typescript
  const feature = data.features[index];
  if (!feature) return null;  // 显式检查
  return { feature, index };
  ```

---

### M011: 命令预览长度不一致
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  // 行 239: 显示 50 字符
  const preview = cmd.slice(0, 50) + (cmd.length > 50 ? '...' : '');

  // 行 253-254: 显示 60 字符
  const cmd = (input.command as string)?.slice(0, 60) ?? '';
  const suffix = cmd.length >= 60 ? '...' : '';
  ```
- **Context**: `src/interactive/prompts.ts` - 行 253-254 vs 239
- **Impact**: 用户体验不一致，代码维护困难
- **Proposed Solution**:
  ```typescript
  const CMD_PREVIEW_LENGTH = 50;
  const preview = cmd.slice(0, CMD_PREVIEW_LENGTH) + (cmd.length > CMD_PREVIEW_LENGTH ? '...' : '');
  ```

---

### M012: ANSI Strip 性能问题
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  private stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }
  ```
  - `stripAnsi()` 在每次渲染时都调用正则替换
  - 状态栏更新频繁时可能影响性能
  - 正则表达式每次都重新编译
- **Context**: `src/interactive/status-bar.ts` - 行 206-208
- **Proposed Solution**:
  - 使用 `strip-ansi` npm 包（更高效）
  - 或缓存正则表达式：`const ANSI_REGEX = /\x1b\[[0-9;]*m/g;`
  - 或缓存已处理的字符串

---

### M013: 自动补全缓存内存泄漏风险
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  setTimeout(() => this.cache.delete(dir), this.cacheTimeout);
  ```
  - 使用 `setTimeout` 进行缓存过期清理，在高频率调用时可能导致：
    - 大量定时器积压
    - 内存无法及时释放
- **Context**: `src/interactive/autocomplete.ts` - 行 95-110
- **Proposed Solution**:
  ```typescript
  // 使用 LRU cache with TTL
  import { LRUCache } from 'lru-cache';

  private cache = new LRUCache<string, string[]>({
    max: 100,
    ttl: 60_000, // 60 seconds
  });
  ```

---

### M014: 语法高亮语言支持不全
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  function highlightCode(code: string, _language: string): string {
    const keywords = /\b(const|let|var|...)\b/g;
    // _language 参数未使用
  }
  ```
  - 无法针对不同语言高亮（Python、Go、Rust 等）
  - 关键词列表只覆盖 JavaScript/TypeScript
- **Context**: `src/interactive/markdown-render.ts` - 行 43-65
- **Proposed Solution**:
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
  或集成 `highlight.js` / `prism` 库

---

### M015: Unicode 检测不完整
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
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
  - 未检测 CMD/PowerShell 的代码页设置 (`chcp 65001`)
  - 用户设置了 UTF-8 代码页但仍显示 ASCII 字符
- **Context**: `src/interactive/themes.ts` - 行 93-101
- **Proposed Solution**: 在启动时检测并缓存代码页设置结果

---

### M016: InkREPL 组件过大
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  - InkREPL 组件约 637 行代码，包含多个职责：
    - 命令处理
    - Shell 命令执行
    - 会话管理
    - 消息格式化
    - 状态管理
- **Context**: `src/ui/InkREPL.tsx`
- **Impact**: 代码可读性降低，维护成本增加，难以单独测试各模块
- **Proposed Solution**:
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

### M017: TextBuffer 未使用方法
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
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
  - `getAbsoluteOffset()` 方法计算光标在文本中的字节偏移位置，但当前未被任何 UI 组件调用
- **Context**: `src/ui/utils/text-buffer.ts` - 行 436-445
- **Proposed Solution**:
  - **保留**：作为未来高级编辑功能的扩展点（如文本选择、外部编辑器同步）
  - **删除**：如果确定不需要这些功能
  - **标注**：添加 `@internal` 或文档说明用途

---

### M018: TODO 注释未清理
- **Type**: Manual
- **Priority**: Low
- **Status**: Open
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  // 应用主题 (使用默认 dark 主题)
  // TODO: 从配置文件读取主题设置
  const theme = getCurrentTheme();
  ```
  - 代码中留有 TODO 注释，表明主题配置功能尚未完全实现
- **Context**: `src/interactive/repl.ts` - 行 112-113
- **Proposed Solution**:
  - 选项 A: 实现从配置文件读取主题设置的功能
  - 选项 B: 将 TODO 转换为 issue 追踪
  - 选项 C: 如果短期内不计划实现，移除 TODO 注释

---

### M034: 状态栏 Session ID 显示问题
- **Type**: Manual
- **Priority**: Medium
- **Status**: Open
- **Created**: 2026-02-20
- **Original Problem**:
  - Session ID 截断为前 6 个字符 (`slice(0, 6)`)，如果 ID 是时间戳格式则不包含秒信息
  - `model` 字段存储在状态中但从未在渲染时显示
  - 用户无法看到当前使用的模型名称
  ```typescript
  // 行 123-124: Session ID 过短
  const shortId = this.state.sessionId.slice(0, 6);
  parts.push(chalk.dim(`#${shortId}`));

  // model 字段存在于 StatusBarState 接口但从未被显示
  ```
- **Context**: `src/interactive/status-bar.ts` - 行 123-131
- **Expected Behavior**:
  - Session ID 应包含足够的时间信息（至少到秒）
  - 状态栏应显示当前使用的模型名称
  - 各元素之间应有清晰分隔符
- **Proposed Solution**:
  ```typescript
  // 增加截取长度以包含秒
  const shortId = this.state.sessionId.slice(0, 12); // 或根据实际 ID 格式调整

  // 在 provider 后显示 model
  parts.push(chalk.cyan(`${this.state.provider}/${this.state.model}`));
  ```

---

### M019: 资源泄漏 - Readline 接口 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-19
- **Original Problem**:
  - `project-commands.ts` 创建了自己的 readline 接口但从未关闭
  - 可能导致字符双倍显示和资源泄漏
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**:
  - 通过 `CommandCallbacks` 传递 REPL 的 readline 接口
  - 在 `CommandCallbacks` 接口添加 `readline?: readline.Interface`
  - 在 `repl.ts` 中传入 `rl` 实例
  - 在 `project-commands.ts` 中使用传入的接口
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`, `src/interactive/repl.ts`

---

### M020: 全局可变状态 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  let rl: readline.Interface | null = null;
  let autoContinueRunning = false;
  ```
  - 模块级可变变量可能导致状态残留和测试困难
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**:
  - 封装到 `ProjectRuntimeState` 类
  ```typescript
  class ProjectRuntimeState {
    private _autoContinueRunning = false;
    get autoContinueRunning(): boolean { ... }
    setAutoContinueRunning(value: boolean): void { ... }
    reset(): void { ... }  // 用于测试
  }
  export const projectRuntimeState = new ProjectRuntimeState();
  ```
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`

---

### M021: 函数过长 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-19
- **Original Problem**:
  - `projectInit()` ~70 行
  - `projectNext()` ~80 行
  - `projectAuto()` ~100 行
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**:
  提取辅助函数：
  - `createConfirmFn()` - 创建确认提示函数
  - `createQuestionFn()` - 创建问题提示函数
  - `displayFeatureInfo()` - 显示功能信息
  - `buildFeaturePrompt()` - 构建执行提示词
  - `executeSingleFeature()` - 执行单个功能
  - `parseAutoOptions()` - 解析 auto 命令选项
  - `parseAutoAction()` - 解析用户动作
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`

---

### M022: Delete 键无效 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 在 `InputPrompt.tsx` 中，Delete 键的处理函数为空
  - 无法删除光标后的字符
  ```typescript
  if (key.delete) {
    // 空实现
    return;
  }
  ```
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**:
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
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### M023: Backspace 键无效 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 在某些终端（如 Windows Terminal）中，按 Backspace 键无法删除字符
  - 终端发送 `char = "\x7f"` (DEL, ASCII 127)
  - Ink 检测到 `key.backspace = false`, `key.delete = true`
  - 代码中 `key.delete` 检查在 `char === "\x7f"` 之前，导致调用 `deleteChar()` 而非 `backspace()`
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**:
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
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### M024: Shift+Enter 换行无效 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 在某些终端中，按 Shift+Enter 无法插入换行
  - 终端发送 `char = "\n"` (LF)
  - Ink 检测到 `key.return = false`, `key.shift = false`
  - Ink 的 `useInput` hook 在某些终端中无法正确检测 Shift+Enter 组合键
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**:
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
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### M025: Resize handler 空引用 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - `TextInput.tsx` 中的 resize handler 使用闭包中的 `stdout` 变量
  - 在某些情况下可能为 null，导致运行时错误
- **Context**: `src/ui/components/TextInput.tsx`
- **Resolution**:
  - 使用 `process.stdout` 替代闭包中的 `stdout`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/TextInput.tsx`

---

### M026: 异步上下文直接退出 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - `InkREPL.tsx` 中在异步上下文直接调用 `process.exit()`
  - 这会导致资源未正确释放，可能造成数据丢失或资源泄漏
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**:
  - 新增 `KodaXTerminalError` 错误类
  - 在顶层处理错误，而不是在异步上下文中直接退出
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`, `src/ui/errors.ts`

---

### M027: 超宽终端分隔符 (RESOLVED)
- **Type**: Manual
- **Priority**: Medium
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 在超宽终端（如 300+ 列）中，分隔符会生成过长的字符串
  - 可能导致性能问题或显示异常
- **Context**: `src/ui/components/TextInput.tsx`
- **Resolution**:
  - 添加 `MAX_DIVIDER_WIDTH=200` 限制
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/TextInput.tsx`

---

### M028: --continue 会话不恢复 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 使用 `--continue` 参数时，不会恢复最近的会话
  - 用户无法继续之前的对话
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**:
  - 添加 `resume`/`autoResume` 选项处理
  - 加载最近会话
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### M029: gitRoot 未设置 (RESOLVED)
- **Type**: Manual
- **Priority**: Medium
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 创建 context 时 `gitRoot` 未设置
  - 导致会话过滤功能不正常
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**:
  - 在创建 context 前获取 gitRoot
  - 用于会话过滤
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### M030: Thinking 内容不显示 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 在 Thinking 模式下，模型的 thinking 内容（`onThinkingDelta`）不会在 UI 中实时显示
  - 虽然 `thinkingCharCount` 会更新，但实际内容不可见
- **Context**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`
- **Resolution**:
  1. 在 `StreamingContextValue` 接口添加 `thinkingContent: string` 字段
  2. 添加 `appendThinkingContent(text: string)` 方法
  3. 在 `MessageList` 组件中添加 `thinkingContent` 显示区域（淡灰色斜体）
  4. 在 `InkREPL` 中使用 `appendThinkingContent` 替代 `appendThinkingChars`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### M031: 非流式输出 (RESOLVED)
- **Type**: Manual
- **Priority**: High
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 非 Thinking 模式下，响应内容（`onTextDelta`）会在流式完成后一次性显示
  - 而非实时逐字显示
- **Context**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`
- **Resolution**:
  1. 在 `MessageList` 组件添加 `streamingResponse` prop
  2. 添加流式响应实时显示区域（显示 `streamingState.currentResponse`）
  3. 在 `InkREPL` 中传递 `streamingResponse={streamingState.currentResponse}`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### M032: Banner 消失 (RESOLVED)
- **Type**: Manual
- **Priority**: Medium
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - 用户首次交互后，启动 Banner 会消失或被隐藏
  - 导致无法看到版本和配置信息
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**:
  - 移除 `setShowBanner(false)` 调用
  - Banner 在启动时显示，随着消息增加自然向上滚动，保持布局稳定
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### M033: /help 输出不可见 (RESOLVED)
- **Type**: Manual
- **Priority**: Medium
- **Status**: Resolved
- **Created**: 2026-02-20
- **Original Problem**:
  - `/help` 等命令的 `console.log` 输出在 Ink 的 alternate buffer 中不可见
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**:
  - 在 Ink 的 `render()` 选项中设置 `patchConsole: true`
  - 将 `console.log` 输出路由到 Ink 渲染系统
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

## Summary
- Total: 34 (19 Open, 15 Resolved)
- Manual: 34 (19 Open, 15 Resolved)
- Highest Priority Open: M003 - Plan 文件无版本号 (Medium)

---

## Changelog

### 2026-02-20: v0.3.3 流式显示修复
- Resolved M030: Thinking 内容不显示
- Resolved M031: 非流式输出
- Resolved M032: Banner 消失
- Resolved M033: /help 输出不可见
- Added 28 test cases (thinking and tool functionality tests)

### 2026-02-20: Phase 6-8 完成与会话管理修复
- Resolved M028: --continue 会话不恢复
- Resolved M029: gitRoot 未设置

### 2026-02-20: v0.3.2 高优先级问题修复
- Resolved M025: Resize handler 空引用
- Resolved M026: 异步上下文直接退出
- Resolved M027: 超宽终端分隔符
- Added 21 test cases

### 2026-02-20: 按键问题修复
- Resolved M022: Delete 键无效
- Resolved M023: Backspace 键无效
- Resolved M024: Shift+Enter 换行无效

### 2026-02-19: 代码审查与重构
- Resolved M019: 资源泄漏 - Readline 接口
- Resolved M020: 全局可变状态
- Resolved M021: 函数过长
- Added open issues M001-M018 from code review
