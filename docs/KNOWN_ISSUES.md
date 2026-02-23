# Known Issues

_Last Updated: 2026-02-23 09:50_

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 001 | Low | Open | 未使用常量 PLAN_GENERATION_PROMPT | v0.3.1 | - | 2026-02-19 | - |
| 002 | Low | Open | /plan 命令未使用 _currentConfig 参数 | v0.3.1 | - | 2026-02-19 | - |
| 003 | Medium | Won't Fix | Plan 文件无版本号 | v0.3.1 | - | 2026-02-19 | 2026-02-22 |
| 004 | Medium | Won't Fix | Plan 解析正则表达式脆弱 | v0.3.1 | - | 2026-02-19 | 2026-02-22 |
| 005 | Low | Open | 中英文注释混用 | v0.3.1 | - | 2026-02-19 | - |
| 006 | Low | Open | 整数解析无范围检查 | v0.3.1 | - | 2026-02-19 | - |
| 007 | Medium | Resolved | 静默吞掉错误 | v0.3.1 | v0.3.3 | 2026-02-19 | 2026-02-22 |
| 008 | Medium | Resolved | 交互提示缺少输入验证 | v0.3.1 | v0.3.3 | 2026-02-19 | 2026-02-22 |
| 009 | Medium | Resolved | 不安全的类型断言 | v0.3.1 | v0.3.3 | 2026-02-19 | 2026-02-22 |
| 010 | Medium | Open | 非空断言缺乏显式检查 | v0.3.1 | - | 2026-02-19 | - |
| 011 | Medium | Open | 命令预览长度不一致 | v0.3.1 | - | 2026-02-19 | - |
| 012 | Medium | Open | ANSI Strip 性能问题 | v0.3.1 | - | 2026-02-19 | - |
| 013 | Low | Open | 自动补全缓存内存泄漏风险 | v0.3.1 | - | 2026-02-19 | - |
| 014 | Low | Open | 语法高亮语言支持不全 | v0.3.1 | - | 2026-02-19 | - |
| 015 | Low | Open | Unicode 检测不完整 | v0.3.1 | - | 2026-02-19 | - |
| 016 | Medium | Open | InkREPL 组件过大 | v0.3.1 | - | 2026-02-19 | - |
| 017 | Low | Open | TextBuffer 未使用方法 | v0.3.1 | - | 2026-02-19 | - |
| 018 | Low | Open | TODO 注释未清理 | v0.3.1 | - | 2026-02-19 | - |
| 019 | Medium | Open | 状态栏 Session ID 显示问题 | v0.3.1 | - | 2026-02-20 | - |
| 020 | High | Resolved | 资源泄漏 - Readline 接口 | v0.3.1 | v0.3.2 | 2026-02-19 | 2026-02-19 |
| 021 | High | Resolved | 全局可变状态 | v0.3.1 | v0.3.2 | 2026-02-19 | 2026-02-19 |
| 022 | High | Resolved | 函数过长 | v0.3.1 | v0.3.2 | 2026-02-19 | 2026-02-19 |
| 023 | High | Resolved | Delete 键无效 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 024 | High | Resolved | Backspace 键无效 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 025 | High | Resolved | Shift+Enter 换行无效 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 026 | High | Resolved | Resize handler 空引用 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 027 | High | Resolved | 异步上下文直接退出 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 028 | Medium | Resolved | 超宽终端分隔符 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 029 | High | Resolved | --continue 会话不恢复 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 030 | Medium | Resolved | gitRoot 未设置 | v0.3.1 | v0.3.2 | 2026-02-20 | 2026-02-20 |
| 031 | High | Resolved | Thinking 内容不显示 | v0.3.2 | v0.3.3 | 2026-02-20 | 2026-02-20 |
| 032 | High | Resolved | 非流式输出 | v0.3.2 | v0.3.3 | 2026-02-20 | 2026-02-20 |
| 033 | Medium | Resolved | Banner 消失 | v0.3.2 | v0.3.3 | 2026-02-20 | 2026-02-20 |
| 034 | Medium | Resolved | /help 输出不可见 | v0.3.2 | v0.3.3 | 2026-02-20 | 2026-02-20 |
| 035 | High | Resolved | Backspace 检测边缘情况 | v0.3.3 | v0.3.3 | 2026-02-22 | 2026-02-23 |
| 041 | High | Resolved | 历史导航清空输入无法恢复 | v0.3.3 | v0.3.3 | 2026-02-23 | 2026-02-23 |
| 042 | Medium | Resolved | Shift+Enter/Ctrl+J 换行无效 | v0.3.3 | v0.3.3 | 2026-02-23 | 2026-02-23 |
| 043 | Medium | Open | 流式响应中断不完全 | v0.3.3 | - | 2026-02-23 | - |
| 036 | Medium | Open | React 状态同步潜在问题 | v0.3.3 | - | 2026-02-22 | - |
| 037 | Medium | Open | 两套键盘事件系统冲突 | v0.3.3 | v0.4.0 | 2026-02-22 | - |
| 038 | Low | Won't Fix | 输入焦点竞态条件 | v0.3.3 | - | 2026-02-22 | 2026-02-22 |
| 039 | Low | Open | 死代码 printStartupBanner | v0.3.3 | v0.4.0 | 2026-02-22 | - |
| 040 | High | Open | REPL 历史显示乱序 - Banner 出现在对话中间 | v0.3.3 | - | 2026-02-23 | - |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->

### 001: 未使用常量 PLAN_GENERATION_PROMPT
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - 定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它
  - 而是通过 `runKodaX` 内部的系统提示词来生成计划
- **Context**: `src/cli/plan-mode.ts`
- **Proposed Solution**: 删除这个常量 或 将其实际用于 `generatePlan` 函数

---

### 002: /plan 命令未使用 _currentConfig 参数
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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

### 003: Plan 文件无版本号 (WON'T FIX)
- **Priority**: Medium
- **Status**: Won't Fix
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - `ExecutionPlan` 接口没有版本字段
  - 如果未来计划格式变更（添加新字段、修改步骤结构），旧文件无法正确解析
  - 未来兼容性风险，用户升级后保存的计划可能损坏
- **Context**: `src/cli/plan-storage.ts` - `ExecutionPlan` 接口
- **Decision**: 不添加版本字段，理由如下：
  1. **行业标准实践**: Claude Code 的 JSONL 会话文件不使用版本字段，数据格式被视为内部实现细节
  2. **Plan 文件是短期存储**: 存储在 `.kodax/plans/` 目录，主要用于当前会话，不需要长期跨版本兼容
  3. **容错解析更合适**: 如未来需要兼容性处理，应在 `PlanStorage.load()` 中采用容错解析策略，而非增加版本控制复杂度
- **Resolution Date**: 2026-02-22

---

### 004: Plan 解析正则表达式脆弱 (WON'T FIX)
- **Priority**: Medium
- **Status**: Won't Fix
- **Introduced**: v0.3.1 (auto-detected)
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
  - Plan 生成失败时无提示，跨模型兼容性差
- **Context**: `src/cli/plan-mode.ts`
- **Decision**: 不修复，理由如下：
  1. **脆弱点 1 不是真正的问题**: 正则 `\s*` 允许 0 个或多个空格，`1.[READ]` 实际可以匹配
  2. **PLAN_GENERATION_PROMPT 已明确指定格式**: 提示词要求使用大写的 READ/WRITE 等，AI 会遵循
  3. **v0.4.0 会重构 Plan Mode**: 架构重构可能改变或移除 Plan Mode，现在修复意义不大
  4. **无实际使用报告**: 没有证据表明这个问题在实际使用中出现过
- **Resolution Date**: 2026-02-22

---

### 005: 中英文注释混用
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - 代码中混合使用中文和英文注释
  - 例如：`// 延迟创建 readline 接口` (中文) vs `// Check if project exists` (英文)
  - 国际化团队协作困难，代码风格不一致
- **Context**: `src/interactive/` 目录下多个文件
- **Proposed Solution**: 选择一种语言保持一致（推荐英文，便于国际协作）

---

### 006: 整数解析无范围检查
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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

### 007: 静默吞掉错误 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.3
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
  - 调试困难，用户无法知道真正的问题
- **Context**: `src/interactive/project-storage.ts` - `loadFeatures()`, `readProgress()`, `readSessionPlan()` 方法
- **Resolution**:
  - 在三个方法中区分 `ENOENT` 和其他错误
  - 对于 `ENOENT` 错误（文件不存在），返回 null/空字符串（正常行为）
  - 对于其他错误（权限、格式等），使用 `console.error` 记录错误日志
  - 保持返回类型不变，确保向后兼容
- **Resolution Date**: 2026-02-22
- **Files Changed**: `src/interactive/project-storage.ts`

---

### 008: 交互提示缺少输入验证 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.3
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
- **Resolution**:
  - 在 `createConfirmFn` 函数中添加 `.trim()` 方法
  - 现在用户输入会先去除首尾空白字符，再进行大小写转换和匹配
  - 修改后代码：`resolve(answer.trim().toLowerCase().startsWith('y'));`
- **Resolution Date**: 2026-02-22
- **Files Changed**: `src/interactive/project-commands.ts`

---

### 009: 不安全的类型断言 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.3
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  const options = callbacks.createKodaXOptions?.() ?? {} as KodaXOptions;
  ```
  - 空对象 `{}` 被断言为 `KodaXOptions` 类型，但空对象实际上并不包含该接口所需的任何属性
  - 运行时访问不存在的属性会得到 `undefined`，类型安全被绕过
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**:
  - 移除不安全的类型断言 `{} as KodaXOptions`
  - 改为显式检查 options 是否存在，如果不存在则输出错误并返回
  - 修复后代码：
    ```typescript
    const options = callbacks.createKodaXOptions?.();
    if (!options) {
      console.log(chalk.red('\n[Error] KodaX options not available\n'));
      return;
    }
    ```
- **Resolution Date**: 2026-02-22
- **Files Changed**: `src/interactive/project-commands.ts`

---

### 010: 非空断言缺乏显式检查
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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

### 011: 命令预览长度不一致
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  // 行 239: 显示 50 字符
  const preview = cmd.slice(0, 50) + (cmd.length > 50 ? '...' : '');

  // 行 253-254: 显示 60 字符
  const cmd = (input.command as string)?.slice(0, 60) ?? '';
  const suffix = cmd.length >= 60 ? '...' : '';
  ```
  - 用户体验不一致，代码维护困难
- **Context**: `src/interactive/prompts.ts` - 行 253-254 vs 239
- **Proposed Solution**:
  ```typescript
  const CMD_PREVIEW_LENGTH = 50;
  const preview = cmd.slice(0, CMD_PREVIEW_LENGTH) + (cmd.length > CMD_PREVIEW_LENGTH ? '...' : '');
  ```

---

### 012: ANSI Strip 性能问题
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  private stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }
  ```
  - `stripAnsi()` 在每次渲染时都调用正则替换
  - 状态栏更新频繁时可能影响性能
  - 正则表达式每次都重新编译
- **Context**: `src/interactive/status-bar.ts` - 行 206-208
- **Proposed Solution**: 使用 `strip-ansi` npm 包 或 缓存正则表达式

---

### 013: 自动补全缓存内存泄漏风险
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  setTimeout(() => this.cache.delete(dir), this.cacheTimeout);
  ```
  - 使用 `setTimeout` 进行缓存过期清理，在高频率调用时可能导致大量定时器积压和内存无法及时释放
- **Context**: `src/interactive/autocomplete.ts` - 行 95-110
- **Proposed Solution**: 使用 LRU cache with TTL 替代 setTimeout

---

### 014: 语法高亮语言支持不全
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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
- **Proposed Solution**: 添加多语言关键词集 或 集成 `highlight.js` / `prism` 库

---

### 015: Unicode 检测不完整
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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

### 016: InkREPL 组件过大
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - InkREPL 组件约 637 行代码，包含多个职责：命令处理、Shell 命令执行、会话管理、消息格式化、状态管理
  - 代码可读性降低，维护成本增加，难以单独测试各模块
- **Context**: `src/ui/InkREPL.tsx`
- **Proposed Solution**: 拆分为多个模块（shell-executor、message-formatter、useSessionManager）

---

### 017: TextBuffer 未使用方法
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
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
- **Proposed Solution**: 保留作为未来扩展点 或 删除如果确定不需要

---

### 018: TODO 注释未清理
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  // 应用主题 (使用默认 dark 主题)
  // TODO: 从配置文件读取主题设置
  const theme = getCurrentTheme();
  ```
  - 代码中留有 TODO 注释，表明主题配置功能尚未完全实现
- **Context**: `src/interactive/repl.ts` - 行 112-113
- **Proposed Solution**: 实现功能 或 转换为 issue 追踪 或 移除注释

---

### 019: 状态栏 Session ID 显示问题
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - Session ID 截断为前 6 个字符 (`slice(0, 6)`)，如果 ID 是时间戳格式则不包含秒信息
  - `model` 字段存储在状态中但从未在渲染时显示
  - 用户无法看到当前使用的模型名称
  ```typescript
  const shortId = this.state.sessionId.slice(0, 6);
  parts.push(chalk.dim(`#${shortId}`));
  // model 字段存在于 StatusBarState 接口但从未被显示
  ```
- **Context**: `src/interactive/status-bar.ts` - 行 123-131
- **Expected Behavior**: Session ID 应包含足够的时间信息，状态栏应显示当前使用的模型名称
- **Proposed Solution**:
  ```typescript
  const shortId = this.state.sessionId.slice(0, 12);
  parts.push(chalk.cyan(`${this.state.provider}/${this.state.model}`));
  ```

---

### 020: 资源泄漏 - Readline 接口 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - `project-commands.ts` 创建了自己的 readline 接口但从未关闭
  - 可能导致字符双倍显示和资源泄漏
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**:
  - 通过 `CommandCallbacks` 传递 REPL 的 readline 接口
  - 在 `CommandCallbacks` 接口添加 `readline?: readline.Interface`
  - 在 `repl.ts` 中传入 `rl` 实例
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`, `src/interactive/repl.ts`

---

### 021: 全局可变状态 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  let rl: readline.Interface | null = null;
  let autoContinueRunning = false;
  ```
  - 模块级可变变量可能导致状态残留和测试困难
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**: 封装到 `ProjectRuntimeState` 类
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`

---

### 022: 函数过长 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  - `projectInit()` ~70 行, `projectNext()` ~80 行, `projectAuto()` ~100 行
- **Context**: `src/interactive/project-commands.ts`
- **Resolution**: 提取辅助函数 (createConfirmFn, createQuestionFn, displayFeatureInfo, buildFeaturePrompt, executeSingleFeature, parseAutoOptions, parseAutoAction)
- **Resolution Date**: 2026-02-19
- **Files Changed**: `src/interactive/project-commands.ts`

---

### 023: Delete 键无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 在 `InputPrompt.tsx` 中，Delete 键的处理函数为空，无法删除光标后的字符
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**: 添加 `delete: deleteChar` 别名并调用 `deleteChar()`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 024: Backspace 键无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 在某些终端中，按 Backspace 键无法删除字符
  - 代码中 `key.delete` 检查在 `char === "\x7f"` 之前，导致调用错误的处理函数
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**: 调整检测顺序，使 `\x7f` 字符检测优先于 `key.delete` 检测
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 025: Shift+Enter 换行无效 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 在某些终端中，按 Shift+Enter 无法插入换行
  - Ink 的 `useInput` hook 在某些终端中无法正确检测 Shift+Enter 组合键
- **Context**: `src/ui/components/InputPrompt.tsx`
- **Resolution**: 添加对 `\n` 字符的检测作为换行的后备方案
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 026: Resize handler 空引用 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - `TextInput.tsx` 中的 resize handler 使用闭包中的 `stdout` 变量，可能为 null
- **Context**: `src/ui/components/TextInput.tsx`
- **Resolution**: 使用 `process.stdout` 替代闭包中的 `stdout`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/TextInput.tsx`

---

### 027: 异步上下文直接退出 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - `InkREPL.tsx` 中在异步上下文直接调用 `process.exit()`
  - 导致资源未正确释放，可能造成数据丢失或资源泄漏
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**: 新增 `KodaXTerminalError` 错误类，在顶层处理错误
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`, `src/ui/errors.ts`

---

### 028: 超宽终端分隔符 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 在超宽终端（如 300+ 列）中，分隔符会生成过长的字符串
- **Context**: `src/ui/components/TextInput.tsx`
- **Resolution**: 添加 `MAX_DIVIDER_WIDTH=200` 限制
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/TextInput.tsx`

---

### 029: --continue 会话不恢复 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 使用 `--continue` 参数时，不会恢复最近的会话
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**: 添加 `resume`/`autoResume` 选项处理，加载最近会话
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### 030: gitRoot 未设置 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.3.2 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 创建 context 时 `gitRoot` 未设置，导致会话过滤功能不正常
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**: 在创建 context 前获取 gitRoot
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### 031: Thinking 内容不显示 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.2 (auto-detected)
- **Fixed**: v0.3.3 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 在 Thinking 模式下，模型的 thinking 内容不会在 UI 中实时显示
- **Context**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`
- **Resolution**: 添加 `thinkingContent` 字段和 `appendThinkingContent` 方法，在 MessageList 中显示
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/contexts/StreamingContext.tsx`, `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### 032: 非流式输出 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.2 (auto-detected)
- **Fixed**: v0.3.3 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 非 Thinking 模式下，响应内容会在流式完成后一次性显示，而非实时逐字显示
- **Context**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`
- **Resolution**: 添加 `streamingResponse` prop 实现实时流式显示
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/components/MessageList.tsx`, `src/ui/InkREPL.tsx`

---

### 033: Banner 消失 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.2 (auto-detected)
- **Fixed**: v0.3.3 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - 用户首次交互后，启动 Banner 会消失或被隐藏
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**: 移除 `setShowBanner(false)` 调用
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### 034: /help 输出不可见 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.2 (auto-detected)
- **Fixed**: v0.3.3 (auto-detected)
- **Created**: 2026-02-20
- **Original Problem**:
  - `/help` 等命令的 `console.log` 输出在 Ink 的 alternate buffer 中不可见
- **Context**: `src/ui/InkREPL.tsx`
- **Resolution**: 在 Ink 的 `render()` 选项中设置 `patchConsole: true`
- **Resolution Date**: 2026-02-20
- **Files Changed**: `src/ui/InkREPL.tsx`

---

### 035: Backspace 检测边缘情况
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Created**: 2026-02-22
- **Original Problem**:
  - `InputPrompt.tsx` 中的 Backspace 检测逻辑存在条件重叠
  - 某些边缘情况可能导致 Backspace 行为不一致：
    1. 条件 `(key.delete && char === "")` 与 Delete 检测存在潜在冲突
    2. 后备条件 `(char === "" && key.backspace === undefined && key.delete === undefined)` 可能捕获其他空事件
  - 不同终端对 Backspace 的报告方式不一致（`\x7f`、`\x08`、`key.delete=true`）
- **Context**: `src/ui/components/InputPrompt.tsx` - 行 135-157
- **Root Cause Analysis**:
  ```typescript
  // 当前代码
  const isBackspace = key.backspace ||
                      char === "\x7f" ||
                      char === "\x08" ||
                      (key.ctrl && char === "h") ||
                      (char === "" && (key.backspace === undefined && key.delete === undefined)) ||
                      (key.delete && char === "");  // ⚠️ 与 Delete 检测重叠

  // Delete 检测
  if (key.delete && char !== "\x7f" && char !== "") {
    deleteChar();  // 如果终端发送 key.delete=true + char=某个字符，会错误触发 Delete
  }
  ```
- **Proposed Solution**:
  ```typescript
  // 按置信度分层检测，避免条件重叠

  // 1. 高置信度：明确的 Backspace 标记
  const isExplicitBackspace = key.backspace === true ||
                              char === "\x7f" ||  // DEL (ASCII 127)
                              char === "\x08";    // BS (ASCII 8)

  // 2. 中置信度：Ctrl+H
  const isCtrlH = key.ctrl === true && char === "h";

  // 3. 低置信度：Windows 终端边缘情况
  const isWindowsBackspace = key.delete === true && char === "" && !key.backspace;

  // 4. 后备检测：空事件且无其他键标识
  const isEmptyBackspace = char === "" &&
      !key.backspace && !key.delete && !key.return &&
      !key.escape && !key.tab && !key.upArrow &&
      !key.downArrow && !key.leftArrow && !key.rightArrow;

  const isBackspace = isExplicitBackspace || isCtrlH || isWindowsBackspace || isEmptyBackspace;
  ```
- **Safety Analysis**:
  - ✅ 每个条件显式且文档化
  - ✅ 条件之间无重叠
  - ✅ 后备检测仅在无任何其他键标识时触发
  - ✅ 与 Delete 检测逻辑解耦
  - ✅ 向后兼容现有终端行为
- **Files to Change**: `src/ui/components/InputPrompt.tsx`
- **Tests Required**:
  - 添加单元测试覆盖各种终端 Backspace 报告方式
  - 添加集成测试验证 Delete 键不被 Backspace 检测误捕获

---

### 036: React 状态同步潜在问题
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Created**: 2026-02-22
- **Original Problem**:
  - `useTextBuffer.ts` 中的 `syncState` 函数使用三个独立的 `setState` 调用
  - 在极端情况下（React 批处理失败），可能导致中间渲染状态不一致
- **Context**: `src/ui/hooks/useTextBuffer.ts` - 行 50-55
- **Root Cause Analysis**:
  ```typescript
  const syncState = useCallback(() => {
    setText(buffer.text);      // 状态更新 1
    setCursor(buffer.cursor);  // 状态更新 2
    setLines(buffer.lines);    // 状态更新 3
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);
  ```
  - 虽然 React 18 自动批处理大多数更新，但在某些边缘情况下可能不生效
  - 如果组件在 `setText` 和 `setCursor` 之间渲染，`cursor` 位置可能与 `text` 内容不匹配
- **Proposed Solution**:
  ```typescript
  // 使用单一状态对象确保原子更新
  type BufferState = {
    text: string;
    cursor: CursorPosition;
    lines: string[];
  };

  const [state, setState] = useState<BufferState>({
    text: "",
    cursor: { row: 0, col: 0 },
    lines: [""],
  });

  const syncState = useCallback(() => {
    setState({
      text: buffer.text,
      cursor: { ...buffer.cursor },
      lines: [...buffer.lines],
    });
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);

  // 保持现有 API 不变
  return {
    buffer,
    text: state.text,
    cursor: state.cursor,
    lines: state.lines,
    // ... 其他方法
  };
  ```
- **Safety Analysis**:
  - ✅ 单一 `setState` 确保原子更新
  - ✅ 现有 API 完全保持不变
  - ✅ 使用展开操作符确保不可变性
  - ✅ 向后兼容所有调用方
- **Files to Change**: `src/ui/hooks/useTextBuffer.ts`
- **Tests Required**:
  - 现有测试应继续通过
  - 添加状态一致性测试（验证 text/cursor/lines 总是同步）

---

### 037: 两套键盘事件系统冲突
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Planned Fix**: v0.4.0
- **Created**: 2026-02-22
- **Original Problem**:
  - 项目存在两套键盘事件处理系统：
    1. `KeypressContext.tsx` - 优先级系统，支持多个处理器
  2. `InputPrompt.tsx` - 直接使用 Ink 的 `useInput`
  - 两者无法同时使用，导致优先级系统无法用于 REPL
- **Context**: `src/ui/contexts/KeypressContext.tsx`, `src/ui/components/InputPrompt.tsx`
- **Root Cause Analysis**:
  - `InkREPL.tsx` 行 738-739 注释：
    ```typescript
    // Note: KeypressProvider is not used here because InputPrompt
    // uses useInput directly. Having both would conflict.
    ```
  - Ink 的 `useInput` 全局监听 stdin，多个实例会互相干扰
  - `KeypressContext` 设计用于协调多个处理器，但未被使用
- **Impact**:
  - 无法实现全局快捷键（如 Ctrl+C 退出需要重复实现）
  - 建议导航功能难以集成（需要优先级系统）
  - 代码重复（多处实现相同的按键检测）
- **Proposed Solution** (v0.4.0 Scope):
  1. 迁移 `InputPrompt` 使用 `KeypressContext`
  2. 注册输入处理器为 `KeypressHandlerPriority.Normal`
  3. 注册全局快捷键为 `KeypressHandlerPriority.Critical`
  4. 允许建议导航注册为 `KeypressHandlerPriority.High`
- **Safety Analysis**:
  - ⚠️ 这是架构级变更，需要全面测试
  - ✅ 推迟到 v0.4.0 monorepo 重构时处理
  - ✅ 当前实现功能正常，不阻塞发布
- **Decision**: 推迟到 v0.4.0，详见 [features/v0.4.0.md#issue_037](features/v0.4.0.md#issue_037-两套键盘事件系统冲突)
- **Files to Change**: `src/ui/components/InputPrompt.tsx`, `src/ui/InkREPL.tsx`

---

### 038: 输入焦点竞态条件 (WON'T FIX)
- **Priority**: Low
- **Status**: Won't Fix
- **Introduced**: v0.3.3 (auto-detected)
- **Created**: 2026-02-22
- **Original Problem**:
  - 当 `isLoading` 从 `false` 变为 `true` 时，`InputPrompt` 的 `focus` prop 变为 `false`
  - `useInput` 的 `isActive` 选项随之变为 `false`
  - 如果此时有按键事件正在处理中，可能导致意外行为
- **Context**: `src/ui/components/InputPrompt.tsx`, `src/ui/InkREPL.tsx`
- **Root Cause Analysis**:
  ```typescript
  // InkREPL.tsx
  <InputPrompt focus={!isLoading} ... />

  // InputPrompt.tsx
  useInput(handleInput, { isActive: focus });
  ```
  - 状态更新和 `useInput` 停用之间存在微小时间窗口
- **Decision**: 不修复，理由如下：
  1. **理论问题，无实际报告**: 实际使用中从未有用户报告此问题
  2. **React 18 自动批处理**: 现代 React 会自动批处理状态更新，时间窗口极小
  3. **useInput 内部检查**: `isActive` 在处理事件前检查，竞态条件难以触发
  4. **修复成本高**: 添加延迟机制会增加代码复杂性且可能引入新问题
- **Resolution Date**: 2026-02-22

---

### 039: 死代码 printStartupBanner
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Planned Fix**: v0.4.0
- **Created**: 2026-02-22
- **Original Problem**:
  - `InkREPL.tsx` 中定义了 `printStartupBanner()` 函数（行 761-796）
  - 该函数已被 `Banner` 组件替代，但未删除
  - 代码注释表明迁移已完成：
    ```typescript
    // Note: Banner is now shown inside Ink component (Banner.tsx)
    // This ensures it's visible in the alternate buffer
    ```
- **Context**: `src/ui/InkREPL.tsx` - 行 761-796, 871-872
- **Proposed Solution**: 在 v0.4.0 重构迁移 `src/ui/` 到 `packages/repl/src/ui/` 时，直接不复制该函数
- **Decision**: 推迟到 v0.4.0，详见 [features/v0.4.0.md#issue_039](features/v0.4.0.md#issue_039-死代码-printstartupbanner)
- **Files to Change**: `src/ui/InkREPL.tsx`

---

### 040: REPL 历史显示乱序 - Banner 出现在对话中间
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Created**: 2026-02-23
- **Original Problem**:
  - REPL 启动后，用户输入命令时显示顺序混乱
  - Banner 应该在最上方，但实际出现在对话中间
  - LLM 回答和命令输出出现在 Banner 上方
  - 历史记录出现在 Banner 下方
  - 整体呈现"乱序 + Banner 插入中间"的视觉效果
- **Context**: `src/ui/InkREPL.tsx`, `src/ui/components/MessageList.tsx`
- **Root Cause Analysis**:
  1. **双重输出源**：
     - `console.log(chalk.cyan(\`You: ${input}\`));` (line 426) 立即打印 "You: /model"（无时间戳）
     - `MessageList` 的 `UserItemRenderer` 显示 "You [09:45 AM] /model"（有时间戳）
     - 两者显示相同内容但格式不同，造成视觉混乱
  2. **Ink patchConsole 机制**：
     - `patchConsole: true` 使 `console.log` 输出被 Ink 捕获
     - 但 console 输出区域与 React 组件树是分离的
     - console.log 输出在 Banner 渲染之前显示
  3. **渲染时序**：
     - console.log 立即输出（在命令处理时）
     - React 状态更新后 MessageList 才渲染
     - Banner 作为 React 组件在中间位置渲染
- **Proposed Solution**:
  移除 `console.log(chalk.cyan(\`You: ${input}\`));` (line 426)，因为 MessageList 已正确显示用户输入（带时间戳）。
  这是最安全的修复，不会影响命令输出或其他功能。
- **Safety Analysis**:
  - ✅ MessageList 已正确显示用户输入（带时间戳）
  - ✅ 移除冗余输出不会丢失信息
  - ✅ 不影响命令输出（命令输出仍通过 console.log 显示）
  - ✅ 不影响其他 Ink 组件渲染
- **Files to Change**: `src/ui/InkREPL.tsx` (删除 line 426)

---

### 041: 历史导航清空输入无法恢复 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.3.3
- **Created**: 2026-02-23
- **Original Problem**:
  - 用户输入文字后按上键浏览历史，再按下键回到最新位置时，输入被清空
  - 再次按上键无法恢复刚才输入的文字
- **Context**: `src/ui/hooks/useInputHistory.ts`, `src/ui/components/InputPrompt.tsx`
- **Root Cause Analysis**:
  - `useInputHistory.ts` 中 `navigateDown()` 返回 `tempInputRef.current || null`
  - 当 `tempInputRef.current` 为空字符串时，返回 `null`
  - `InputPrompt.tsx` 中检测到 `null` 后调用 `setText("")` 清空输入
  - 参考 Gemini CLI/OpenCode: 应该返回空字符串而不是 null
- **Resolution**:
  - 修改 `navigateDown()` 返回 `tempInputRef.current` (可能是空字符串)
  - 修改 `InputPrompt.tsx` 在 `historyText !== null` 时更新文本（包括空字符串）
- **Resolution Date**: 2026-02-23
- **Files Changed**: `src/ui/hooks/useInputHistory.ts`, `src/ui/components/InputPrompt.tsx`

---

### 042: Shift+Enter/Ctrl+J 换行无效 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.3.3
- **Created**: 2026-02-23
- **Original Problem**:
  - Shift+Enter 无法插入换行（大多数终端无法区分 Shift+Enter 和 Enter）
  - 用户无法在输入中插入多行文本（只能用 `\`+Enter 后备方案）
- **Context**: `src/ui/utils/keypress-parser.ts`, `src/ui/components/InputPrompt.tsx`
- **Root Cause Analysis**:
  - 大多数终端（尤其是 Windows）不支持 CSI u 格式的 modifyOtherKeys
  - Shift+Enter 发送的 `\x1b[13;2u` 序列很少被终端支持
  - 实际上 Shift+Enter 和 Enter 发送的都是 `\r`
- **Resolution**:
  - 添加 Ctrl+J (Line Feed, `\n`) 作为换行的可靠替代
  - 修改 `keypress-parser.ts` 将 `\n` 命名为 "newline"
  - 修改 `InputPrompt.tsx` 处理 `key.name === "newline"` 为换行
- **Resolution Date**: 2026-02-23
- **Files Changed**: `src/ui/utils/keypress-parser.ts`, `src/ui/components/InputPrompt.tsx`

---

### 043: 流式响应中断不完全
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.3.3 (auto-detected)
- **Created**: 2026-02-23
- **Original Problem**:
  - 在 LLM 流式响应时按 Ctrl+C 或 ESC 中断
  - UI 显示 "[Interrupted]" 但 API 请求可能仍在后台继续
  - 流式输出过程中中断可能导致显示问题
- **Context**: `src/ui/InkREPL.tsx`, `src/ui/contexts/StreamingContext.tsx`, `src/core/providers/`
- **Root Cause Analysis**:
  - `StreamingContext` 创建了 `AbortController` 但 signal 未传递给 API 调用
  - `abort()` 调用 `abortController.abort()` 但 Anthropic/OpenAI SDK 不知道这个 signal
  - 实际 HTTP 请求没有被取消，LLM 会继续生成
- **Proposed Solution**:
  1. 添加 `abortSignal?: AbortSignal` 到 `KodaXOptions`
  2. 在 provider 实现中将 signal 传递给 SDK 调用
  3. 在 `InkREPL.tsx` 中获取 `StreamingContext` 的 abortController.signal 并传递给 runKodaX
- **Safety Analysis**:
  - ⚠️ 需要修改多个文件和接口
  - ⚠️ 需要测试各 provider (Anthropic, OpenAI) 的 abort 行为
  - ✅ 不影响现有功能，只是添加可选参数
- **Files to Change**: `src/core/types.ts`, `src/core/agent.ts`, `src/core/providers/anthropic.ts`, `src/core/providers/openai.ts`, `src/ui/InkREPL.tsx`, `src/ui/contexts/StreamingContext.tsx`

---

## Summary
- Total: 43 (17 Open, 22 Resolved, 3 Won't Fix, 1 Planned for v0.4.0)
- Highest Priority Open: 040 - REPL 历史显示乱序 (High), 043 - 流式响应中断不完全 (Medium)
- Planned for v0.4.0: 037, 039

---

## Changelog

### 2026-02-23: Issue 035 后续修复
- Resolved 041: 历史导航清空输入无法恢复
- Resolved 042: Shift+Enter/Ctrl+J 换行无效
- Added 043: 流式响应中断不完全（需要传递 AbortSignal 到 API 调用）

### 2026-02-23: REPL 显示问题
- Added 040: REPL 历史显示乱序 - Banner 出现在对话中间 (High Priority)
- 根因：console.log 与 MessageList 双重输出 + Ink patchConsole 机制导致渲染顺序混乱
- 解决方案：移除冗余的 console.log 用户输入输出

### 2026-02-22: Issue 状态更新
- Issue 037 (两套键盘事件系统冲突) → 计划在 v0.4.0 解决，已融合到 feature design
- Issue 038 (输入焦点竞态条件) → Won't Fix，理论问题无实际影响
- Issue 039 (死代码 printStartupBanner) → 计划在 v0.4.0 解决，已融合到 feature design
- 更新 v0.4.0 feature design 文档，添加同步解决的已知问题章节

### 2026-02-22: REPL 代码审查
- Added 035: Backspace 检测边缘情况 (High Priority)
- Added 036: React 状态同步潜在问题 (Medium Priority)
- Added 037: 两套键盘事件系统冲突 (Medium Priority)
- Added 038: 输入焦点竞态条件 (Low Priority)
- Added 039: 死代码 printStartupBanner (Low Priority)
- 所有新 issue 都包含详细的根因分析和安全修复方案
- Issue 037, 038, 039 推迟到 v0.4.0 处理

### 2026-02-22: 代码质量修复
- Resolved 008: 交互提示缺少输入验证
- Resolved 009: 不安全的类型断言

### 2026-02-21: 格式更新 (v0.3.3)
- 更新 KNOWN_ISSUES.md 格式以符合新版 known-issues-tracker 技能规范
- 添加 `Introduced` 和 `Fixed` 版本追踪字段
- 根据提交历史推断问题引入版本（v0.3.1: 交互式 UI 首次引入）

### 2026-02-20: v0.3.3 流式显示修复
- Resolved 031: Thinking 内容不显示
- Resolved 032: 非流式输出
- Resolved 033: Banner 消失
- Resolved 034: /help 输出不可见
- Added 28 test cases

### 2026-02-20: Phase 6-8 完成与会话管理修复
- Resolved 029: --continue 会话不恢复
- Resolved 030: gitRoot 未设置

### 2026-02-20: v0.3.2 高优先级问题修复
- Resolved 026: Resize handler 空引用
- Resolved 027: 异步上下文直接退出
- Resolved 028: 超宽终端分隔符

### 2026-02-20: 按键问题修复
- Resolved 023: Delete 键无效
- Resolved 024: Backspace 键无效
- Resolved 025: Shift+Enter 换行无效

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
