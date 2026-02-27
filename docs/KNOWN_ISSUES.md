# Known Issues

_Last Updated: 2026-02-27 02:30_

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
| 010 | Medium | Resolved | 非空断言缺乏显式检查 | v0.3.1 | v0.4.4 | 2026-02-19 | 2026-02-25 |
| 011 | Medium | Resolved | 命令预览长度不一致 | v0.3.1 | v0.4.4 | 2026-02-19 | 2026-02-26 |
| 012 | Medium | Resolved | ANSI Strip 性能问题 | v0.3.1 | v0.4.4 | 2026-02-19 | 2026-02-26 |
| 013 | Low | Open | 自动补全缓存内存泄漏风险 | v0.3.1 | - | 2026-02-19 | - |
| 014 | Low | Open | 语法高亮语言支持不全 | v0.3.1 | - | 2026-02-19 | - |
| 015 | Low | Open | Unicode 检测不完整 | v0.3.1 | - | 2026-02-19 | - |
| 016 | Medium | Resolved | InkREPL 组件过大 | v0.3.1 | v0.4.4 | 2026-02-19 | 2026-02-26 |
| 017 | Low | Open | TextBuffer 未使用方法 | v0.3.1 | - | 2026-02-19 | - |
| 018 | Low | Open | TODO 注释未清理 | v0.3.1 | - | 2026-02-19 | - |
| 019 | Medium | Resolved | 状态栏 Session ID 显示问题 | v0.3.1 | v0.4.4 | 2026-02-20 | 2026-02-26 |
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
| 043 | Medium | Resolved | 流式响应中断不完全 | v0.3.3 | v0.3.4 | 2026-02-23 | 2026-02-23 |
| 036 | Medium | Resolved | React 状态同步潜在问题 | v0.3.3 | v0.4.5 | 2026-02-22 | 2026-02-26 |
| 037 | Medium | Resolved | 两套键盘事件系统冲突 | v0.3.3 | v0.4.5 | 2026-02-22 | 2026-02-26 |
| 038 | Low | Won't Fix | 输入焦点竞态条件 | v0.3.3 | - | 2026-02-22 | 2026-02-22 |
| 039 | Low | Open | 死代码 printStartupBanner | v0.3.3 | v0.4.0 | 2026-02-22 | - |
| 040 | High | Resolved | REPL 显示问题 - 命令输出渲染位置错误 | v0.3.3 | v0.4.2 | 2026-02-23 | 2026-02-25 |
| 044 | High | Resolved | 流式输出时 Ctrl+C 延迟生效 | v0.3.4 | v0.3.6 | 2026-02-23 | 2026-02-24 |
| 045 | High | Resolved | Spinner 出现时问答顺序颠倒 | v0.4.3 | v0.4.4 | 2026-02-25 | 2026-02-25 |
| 046 | High | Resolved | Session 恢复时消息显示异常 | v0.4.5 | v0.4.5 | 2026-02-26 | 2026-02-27 |
| 047 | Medium | Resolved | 流式输出时界面闪烁 | v0.4.5 | v0.4.5 | 2026-02-26 | 2026-02-27 |
| 048 | Medium | Resolved | Spinner 动画期间消息显示乱序 | v0.4.5 | v0.4.5 | 2026-02-27 | 2026-02-27 |

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

### 010: 非空断言缺乏显式检查 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-25
- **Original Problem**:
  ```typescript
  return { feature: data.features[index]!, index };
  ```
  - 使用 `!` 非空断言操作符时缺少显式 null 检查
  - TypeScript 的 `!` 在编译后被移除，运行时无保护
- **Context**: `packages/repl/src/interactive/project-storage.ts`
- **Resolution**:
  - 修改 `getNextPendingFeature()` 函数，添加显式 null 检查
  - 修复后代码：
    ```typescript
    const feature = data.features[index];
    if (!feature) return null;
    return { feature, index };
    ```
  - 与同文件 `getFeatureByIndex()` (line 152-153) 保持风格一致
- **Files Changed**: `packages/repl/src/interactive/project-storage.ts`

---

### 011: 命令预览长度不一致 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26
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
- **Resolution**:
  - 在 `common/utils.ts` 添加共享常量 `PREVIEW_MAX_LENGTH = 60`
  - 修改 `cli-events.ts` 和 `prompts.ts` 使用共享常量
  - 统一所有命令预览长度为 60 字符
- **Files Changed**: `packages/repl/src/common/utils.ts`, `packages/repl/src/index.ts`, `packages/repl/src/ui/cli-events.ts`, `packages/repl/src/interactive/prompts.ts`

---

### 012: ANSI Strip 性能问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26
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
- **Resolution**:
  - 将正则表达式提取为模块级常量 `ANSI_REGEX`
  - 在 `stripAnsi()` 方法中复用缓存的正则表达式
  - 添加 `lastIndex = 0` 重置以确保从头匹配
- **Files Changed**: `packages/repl/src/interactive/status-bar.ts`

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
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-19
- **Resolved**: 2026-02-26
- **Original Problem**:
  - InkREPL 组件约 994 行代码（原记录 637 行，增长 56%）
  - 包含 7+ 个职责：命令处理、Shell 命令执行、会话管理、消息格式化、状态管理等
  - `handleSubmit()` 单函数 300+ 行，包含 13 个内联回调
  - 代码可读性降低，维护成本增加，难以单独测试各模块
- **Context**: `packages/repl/src/ui/InkREPL.tsx`
- **职责分析** (994 行):
  ```
  1. SessionStorage 接口 + 实现    (lines 84-136)   ~52行
  2. Helper 函数                   (lines 64-81)    ~17行
  3. Banner 组件                   (lines 153-240)  ~87行
  4. InkREPLInner 核心组件         (lines 242-820) ~578行
     ├── 状态管理 (useState x 5)
     ├── 全局中断处理 (useKeypress)
     ├── 消息同步 (useEffect)
     ├── processSpecialSyntax()    ~45行
     ├── extractTitle()            ~8行
     ├── createStreamingEvents()   ~28行
     ├── runAgentRound()           ~16行
     └── handleSubmit()            ~300行 (巨型函数)
  5. InkREPL 包装器                (lines 823-836)  ~13行
  6. isRawModeSupported()          (lines 838-843)  ~5行
  7. printStartupBanner() - 死代码 (lines 845-896) ~51行
  8. startInkREPL() 入口           (lines 898-994) ~96行
  ```
- **handleSubmit() 内联职责** (300+ 行):
  1. CommandCallbacks 创建 (13个回调)
  2. Console.log 捕获 (两处重复)
  3. 命令解析与执行
  4. Shell 命令处理
  5. Plan Mode 处理
  6. Agent 执行
  7. 错误分类 (4种)
  8. 自动保存
- **修复方案 A（保守重构）** - 推荐:
  | 提取模块 | 行数 | 风险 |
  |----------|------|------|
  | session-storage.ts | ~52 | 低 |
  | shell-executor.ts | ~45 | 低 |
  | message-utils.ts | ~25 | 低 |
  | console-capturer.ts | ~30 | 低 |
  | 删除 printStartupBanner() | -51 | 无 |
  - 预期效果：994 → ~800 行
- **修复方案 B（激进重构）** - 不推荐:
  - + 方案 A 的所有模块
  - + 提取 hooks: useSessionManager, useCommandHandler, useAgentRunner
  - 预期效果：994 → ~500 行，但风险较高
- **决策**: 采用方案 A，原因：风险可控、逐步改进、不影响组件结构
- **Files to Change**:
  - 新建: `packages/repl/src/ui/utils/session-storage.ts`
  - 新建: `packages/repl/src/ui/utils/shell-executor.ts`
  - 新建: `packages/repl/src/ui/utils/message-utils.ts`
  - 新建: `packages/repl/src/ui/utils/console-capturer.ts`
  - 修改: `packages/repl/src/ui/InkREPL.tsx`
- **Resolution** (2026-02-26):
  - 执行方案 A 保守重构
  - 新建 4 个工具模块:
    - `utils/session-storage.ts` - SessionStorage 接口 + MemorySessionStorage 实现
    - `utils/shell-executor.ts` - processSpecialSyntax() 和 Shell 命令执行
    - `utils/message-utils.ts` - extractTextContent(), extractTitle(), formatMessagePreview()
    - `utils/console-capturer.ts` - ConsoleCapturer 类和 withCapture() 函数
  - 删除死代码: printStartupBanner() 函数
  - 更新 utils/index.ts barrel export
  - 结果: 994 行 → 819 行 (减少 175 行，-17.6%)

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

### 019: 状态栏 Session ID 显示问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-20
- **Resolved**: 2026-02-26
- **Original Problem**:
  - 存在两套 StatusBar 实现：
    - Legacy `status-bar.ts` (readline 界面): 截断为 6 字符，不显示 model
    - Active `StatusBar.tsx` (Ink React 组件): 截断为 13 字符，已显示 provider/model
  - 当前使用的 Ink 版本截断 Session ID 为 13 字符，丢失最后 2 位秒数
  - Session ID 格式为 `YYYYMMDD_HHMMSS` (15 字符)，13 字符截断后显示 `YYYYMMDD_HHMM`
  ```typescript
  // StatusBar.tsx 原代码
  const shortSessionId = sessionId.length > 13
    ? sessionId.slice(0, 13)
    : sessionId;
  ```
- **Context**: `packages/repl/src/ui/components/StatusBar.tsx` - 行 25-27
- **Expected Behavior**: Session ID 完整显示，不截断，保留 `YYYYMMDD_HHMMSS` 格式
- **Resolution**:
  - 移除截断逻辑，直接显示完整 Session ID (15 字符)
  - 修复后代码：
    ```typescript
    // 直接显示完整 Session ID，不截断
    const displaySessionId = sessionId;
    ```
- **Files Changed**: `packages/repl/src/ui/components/StatusBar.tsx`

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

### 035: Backspace 检测边缘情况 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.3.3
- **Created**: 2026-02-22
- **Resolved**: 2026-02-23
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
- **Resolution**:
  - 按置信度分层重构 Backspace 检测逻辑
  - 分离高/中/低置信度条件，避免重叠
  - 后备检测仅在无其他键标识时触发
  - 与 Delete 检测逻辑完全解耦
- **Files Changed**: `src/ui/components/InputPrompt.tsx`

---

### 036: React 状态同步潜在问题 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.4.5
- **Created**: 2026-02-22
- **Resolved**: 2026-02-26
- **Original Problem**:
  - `useTextBuffer.ts` 中的 `syncState` 函数使用三个独立的 `setState` 调用
  - 在极端情况下（React 批处理失败），可能导致中间渲染状态不一致
- **Context**: `packages/repl/src/ui/hooks/useTextBuffer.ts`
- **Root Cause Analysis**:
  ```typescript
  // 旧代码 - 三个独立的 setState
  const [text, setText] = useState(initialValue);
  const [cursor, setCursor] = useState<CursorPosition>({ row: 0, col: 0 });
  const [lines, setLines] = useState<string[]>([""]);

  const syncState = useCallback(() => {
    setText(buffer.text);      // 状态更新 1
    setCursor(buffer.cursor);  // 状态更新 2
    setLines(buffer.lines);    // 状态更新 3
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);
  ```
  - 虽然 React 18 自动批处理大多数更新，但在某些边缘情况下可能不生效
  - 如果组件在 `setText` 和 `setCursor` 之间渲染，`cursor` 位置可能与 `text` 内容不匹配
- **Resolution**:
  - 使用单一状态对象 `TextBufferState` 替代三个独立的 `useState`
  - `syncState` 现在只调用一次 `setState`，确保原子更新
  - 公开 API 完全保持不变，仅内部实现变更
  ```typescript
  // 新代码 - 单一状态对象
  interface TextBufferState {
    text: string;
    cursor: CursorPosition;
    lines: string[];
  }

  const [state, setState] = useState<TextBufferState>({
    text: initialValue,
    cursor: { row: 0, col: 0 },
    lines: [""],
  });

  const syncState = useCallback(() => {
    setState({
      text: buffer.text,
      cursor: buffer.cursor,
      lines: buffer.lines,
    });
    onTextChange?.(buffer.text);
  }, [buffer, onTextChange]);

  // API 不变
  return {
    buffer,
    text: state.text,
    cursor: state.cursor,
    lines: state.lines,
    // ...
  };
  ```
- **Files Changed**: `packages/repl/src/ui/hooks/useTextBuffer.ts`
- **Tests Added**: 无（该项目暂无自动化测试，已手动验证编译通过）

---

### 037: 两套键盘事件系统冲突 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.4.5
- **Created**: 2026-02-22
- **Resolved**: 2026-02-26
- **Original Problem**:
  - 项目存在两套键盘事件处理系统：
    1. `KeypressContext.tsx` - 优先级系统，支持多个处理器
  2. `InputPrompt.tsx` - 直接使用 Ink 的 `useInput`
  - 两者无法同时使用，导致优先级系统无法用于 REPL
- **Context**: `packages/repl/src/ui/contexts/KeypressContext.tsx`, `packages/repl/src/ui/components/InputPrompt.tsx`
- **Resolution**:
  - `InkREPL.tsx` 现已使用 `<KeypressProvider>` 包裹组件（行 695-697）
  - `InputPrompt.tsx` 已迁移使用 `useKeypress` 从 `KeypressContext`（行 15, 70）
  - 使用优先级系统 `KeypressHandlerPriority.High` 注册输入处理器
  - 实现了完整的 Proposed Solution（v0.4.0 Scope）
- **Files Changed**: `packages/repl/src/ui/InkREPL.tsx`, `packages/repl/src/ui/components/InputPrompt.tsx`

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

### 040: REPL 显示问题 - 命令输出渲染位置错误 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.4.2
- **Created**: 2026-02-23
- **Resolved**: 2026-02-25
- **Original Problem**:
  REPL 显示存在以下确认的问题（基于实际测试观察）：

  **主要问题：命令输出渲染位置错误**
  - `/help`, `/model` 等命令的输出被渲染在 Banner 下面、用户消息上面
  - 预期顺序：Banner → 用户输入 → 命令输出
  - 实际顺序：Banner → 命令输出 → 用户输入

- **Root Cause Analysis**:
  - `executeCommand()` 使用 `console.log` 输出命令结果
  - Ink 的 `patchConsole: true` 模式捕获所有 console 输出
  - 被捕获的 console 输出被渲染在 MessageList 组件之前的位置

- **Resolution**:
  采用方案 B：捕获 console 输出
  - 在命令执行期间临时拦截 `console.log`
  - 将捕获的内容添加到 history 作为 "info" 类型
  - 命令输出按正确顺序出现在 MessageList 中

- **Files Changed**:
  - `packages/repl/src/ui/InkREPL.tsx` - 捕获 console.log 并添加到 history

- **Related**: 037 (两套键盘事件系统冲突), 034 (/help 输出不可见)

---

### 045: Spinner 出现时问答顺序颠倒 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.4.3 (auto-detected)
- **Fixed**: v0.4.4
- **Created**: 2026-02-25
- **Resolved**: 2026-02-25
- **Original Problem**:
  - 在问答过程中，当 spinner (加载指示器) 出现时，问答顺序会上下颠倒乱序
  - 表现类似 Issue 040：命令输出渲染位置错误
  - 当前行为：问答顺序错乱，可能出现"回答显示在问题之前"的情况
  - 预期行为：问答应按时间顺序显示，最新响应应显示在底部
- **Context**: REPL UI 渲染层，Ink 组件
- **Root Cause Analysis**:
  - **渲染结构分析**：
    - 当 `history.length > 0` 时，MessageList 组件渲染，Spinner 在 MessageList 内部（MessageList.tsx 行 468-483）
    - 当 `history.length === 0 && isLoading` 时，ThinkingIndicator 在 MessageList 外部渲染（InkREPL.tsx 行 762-766）
  - **问题根源 1 - Ink patchConsole 行为**：
    - Ink 使用 `patchConsole: true`（InkREPL.tsx 行 952）捕获所有 console 输出
    - 被捕获的输出会作为虚拟组件插入渲染树
    - 在流式响应期间，渲染树不断变化，捕获的输出可能出现在错误位置
    - Agent 执行路径中的 console.log（onError、catch 块）未被显式处理，被 patchConsole 任意插入
  - **问题根源 2 - Thinking 内容消失**：
    - `onTextDelta` 被调用时，会调用 `stopThinking()`（InkREPL.tsx 行 399）
    - `stopThinking()` 会清空 `thinkingContent`（StreamingContext.tsx 行 309）
    - 这导致 Thinking 内容在第一个文本到达时消失
  - **MessageList 渲染顺序**（MessageList.tsx 行 435-484）：
    1. filteredItems（历史消息）
    2. thinkingContent（思考内容）
    3. streamingResponse（流式响应）
    4. Spinner（加载指示器）
- **Related**: 040 (REPL 显示问题 - 命令输出渲染位置错误，已修复)
- **Resolution**:
  1. **修复 1**：在 agent 运行期间捕获 console.log（类似 Issue 040 的解决方案）
     - 在 `InkREPL.tsx` 的 `runAgentRound` 调用前后捕获/恢复 console.log
     - 将捕获的内容添加到 history 作为 info 类型
  2. **修复 2**：保留 Thinking 内容显示
     - 修改 `StreamingContext.tsx` 的 `stopThinking()` 函数，不再清空 `thinkingContent`
     - Thinking 内容现在会保留显示，直到下一个 thinking session 开始

---
  - 在 LLM 流式输出（非 thinking）时按 Ctrl+C 中断
  - 中断不会立即生效，而是等流式输出结束后才生效
  - Thinking 过程中可以正常中断（043 已修复）
- **Context**: `src/ui/InkREPL.tsx`, `src/core/providers/`
- **Root Cause Analysis**:
  - AbortSignal 虽然传递到了 provider，但未传递给底层 SDK
  - `provider.stream()` 调用 `client.messages.create()` 时没有传递 signal 参数
  - 底层 HTTP 请求无法被取消，只能在流事件到达时检查 abort 状态
- **Resolution**:
  1. 修改 `anthropic.ts` 和 `openai.ts`：传递 signal 给 SDK 的 create 方法
  2. 修改 `agent.ts`：正确识别并处理 AbortError（`error.name === 'AbortError'`）
  3. 添加 `KodaXResult.interrupted` 字段标记中断状态
  4. 使用 Gemini CLI 风格的 `isActive` 模式优化 keypress handler 订阅
- **Resolution Date**: 2026-02-24
- **Files Changed**:
  - `src/core/providers/anthropic.ts` - 传递 signal 给 SDK
  - `src/core/providers/openai.ts` - 传递 signal 给 SDK
  - `src/core/agent.ts` - AbortError 处理
  - `src/core/types.ts` - 添加 interrupted 字段
  - `src/ui/contexts/KeypressContext.tsx` - 支持 isActive 模式
  - `src/ui/InkREPL.tsx` - 使用 Gemini CLI 风格中断处理

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

### 043: 流式响应中断不完全 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.3.3 (auto-detected)
- **Fixed**: v0.3.4
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
- **Resolution**:
  1. 添加 `abortSignal?: AbortSignal` 到 `KodaXOptions` 类型
  2. 添加 `signal?: AbortSignal` 到 `KodaXProviderStreamOptions` 类型
  3. 更新 `KodaXBaseProvider.stream()` 签名接受 signal 参数
  4. 更新 `KodaXAnthropicCompatProvider.stream()` 和 `KodaXOpenAICompatProvider.stream()` 在流迭代中检查 `signal.aborted`
  5. 更新 `agent.ts` 将 `options.abortSignal` 传递给 provider.stream()
  6. 在 `StreamingContext` 中添加 `getSignal()` 方法暴露 AbortSignal
  7. 在 `InkREPL.tsx` 中调用 `getSignal()` 并传递给 `runKodaX`
- **Implementation Details**:
  - 参考 Gemini CLI 的 abort 处理模式
  - 在 provider 的流迭代循环中检查 `signal?.aborted`，如果为 true 则抛出 'Request aborted' 错误
  - 完整的信号传递链：UI (StreamingContext) → runKodaX → provider.stream() → SDK
- **Resolution Date**: 2026-02-23
- **Files Changed**: `src/core/types.ts`, `src/core/providers/base.ts`, `src/core/providers/anthropic.ts`, `src/core/providers/openai.ts`, `src/core/agent.ts`, `src/ui/contexts/StreamingContext.tsx`, `src/ui/InkREPL.tsx`

---

## Summary
- Total: 47 (8 Open, 35 Resolved, 3 Won't Fix, 1 Planned for v0.5.0+)
- Highest Priority Open: 036 - React 状态同步潜在问题 (Medium)
- Planned for v0.5.0+: 039 (长期重构 - ConsolePatcher 架构)

---

## Changelog

### 2026-02-27: Issue 046 最终修复
- Issue 046 (Session 恢复时消息显示异常) 已完全修复
- 根本原因分析和修复：
  1. **用户消息重复**：`InkREPL.tsx` 和 `agent.ts` 都添加用户消息，删除前者的 push 操作
  2. **消息截断**：`MessageList.tsx` 默认 `maxLines=20` 太小，改为 1000
  3. **[Complex content]**：纯 tool_result 消息返回空字符串并在 UI 层过滤
  4. **thinking 内容显示**：`extractTextContent` 不应提取 thinking 块内容
- 修改文件：`InkREPL.tsx`, `MessageList.tsx`, `message-utils.ts`

### 2026-02-27: Issue 046 重新打开
- Issue 046 (Session 恢复时消息显示异常) 并未完全修复
- 发现更多问题：
  1. 用户消息重复显示（同一消息出现两遍）
  2. Assistant 回复被截断（显示 `... (33 more lines)`）
  3. tool_result 仍显示为 [Complex content]
- 提升优先级为 High

### 2026-02-26: Issue 046 部分修复（后发现问题未解决）
- 扩展 extractTextContent 支持 thinking/tool_use/redacted_thinking 块
- 但后续测试发现仍有用户消息重复、回复截断等问题

### 2026-02-26: Issue 036 修复
- Resolved 036: React 状态同步潜在问题 - 将三个独立 useState 合并为单一状态对象，确保原子更新

### 2026-02-26: Issue 037 状态更新
- Resolved 037: 两套键盘事件系统冲突 - InputPrompt 已迁移使用 KeypressContext
- InkREPL 现使用 KeypressProvider 包裹，使用优先级系统注册处理器
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 047 新增
- Added 047: 流式输出时界面闪烁 (Medium Priority)
- 高速流式输出时界面出现闪烁，可能与 Ink 渲染频率有关

### 2026-02-26: Issue 019 修复
- Resolved 019: 状态栏 Session ID 显示问题 - 移除截断逻辑，显示完整 Session ID
- 修正 KNOWN_ISSUES.md 中过时的描述（原描述针对已废弃的 status-bar.ts）
- 当前 Open Issues 降至 12 个

### 2026-02-26: Issue 011 & 012 修复
- Resolved 011: 命令预览长度不一致 - 统一使用 PREVIEW_MAX_LENGTH 常量
- Resolved 012: ANSI Strip 性能问题 - 缓存正则表达式避免重复编译
- 更新 Issue 011 状态（之前已修复但未更新状态）
- 当前 Open Issues 降至 15 个

### 2026-02-25: Issue 045 新增
- Added 045: Spinner 出现时问答顺序颠倒 (High Priority)
- 问题表现与 Issue 040 类似，都涉及渲染顺序问题
- 需要进一步排查 Spinner 组件与 MessageList 的渲染顺序关系

### 2026-02-25: Issue 040 修复完成
- Resolved 040: REPL 显示问题 - 命令输出渲染位置错误
- 最终方案：捕获 console.log 输出并添加到 history
- 命令输出现在按正确顺序出现在用户消息之后
- 相关提交：fddc97c, 9c40f40

### 2026-02-24: Issue 040 重新打开
- Issue 040 之前的修复只解决了部分问题
- 新发现的根本问题：命令输出（/help, /model 等）渲染在 Banner 下面、用户消息上面
- 根因：console.log 被 Ink patchConsole 捕获后渲染在 MessageList 之前的位置
- 解决方案：修改命令返回输出字符串，添加到 history 而非使用 console.log

### 2026-02-24: Issue 040 修复 (v0.4.2)
- Resolved 040: REPL 显示问题 - Banner重复/消息双重输出
- 修复内容：
  1. Banner 使用 Ink `<Static>` 组件固定在顶部
  2. 移除冗余的 `console.log` 用户消息输出
  3. MessageList 在流式响应时过滤掉最后一条 assistant 历史
  4. 添加 React 状态更新等待确保渲染顺序正确

### 2026-02-24: v0.4.0 发布 + Issue 040 更新
- 完成架构重构：@kodax/core + @kodax/repl monorepo
- 更新 Issue 040：添加实际测试观察结果
  - Banner 延迟显示（首次交互后才出现）
  - 用户消息双重显示（console.log + MessageList）
  - [Complex content] 与实际内容重复显示
  - 命令输出实际可见（问题 3 部分缓解）
  - 新发现 punycode 弃用警告（低优先级）
- 修复计划调整为短期快速修复 + 长期架构重构

### 2026-02-24: Issue 044 修复
- Resolved 044: 流式输出时 Ctrl+C 延迟生效
- 根因：AbortSignal 未传递给底层 SDK，HTTP 请求无法被取消
- 修复：传递 signal 给 Anthropic/OpenAI SDK 的 create 方法
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 6 个文件实现完整的中断功能

### 2026-02-23: Issue 040 详细分析
- 深度分析 040: REPL 显示严重问题
- 发现问题远超预期：重复消息、占位符、命令不可见、顺序混乱
- 对比 Gemini CLI 的 ConsolePatcher 架构
- 提出短期修复和长期重构方案
- 长期方案融合到 v0.4.0 monorepo 重构计划

### 2026-02-23: Issue 044 新增
- Added 044: 流式输出时 Ctrl+C 延迟生效 (High Priority)
- 根因：流式迭代期间 Ctrl+C 事件被延迟处理
- 043 修复了 AbortSignal 传递，但 Ctrl+C 按键事件处理仍有问题

### 2026-02-23: Issue 043 修复
- Resolved 043: 流式响应中断不完全
- 添加 AbortSignal 传递链：UI → runKodaX → provider → SDK
- 参考 Gemini CLI 的 abort 处理模式实现
- 更新 7 个文件实现完整的中断功能

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

### 046: Session 恢复时消息显示异常 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.4.5
- **Fixed**: v0.4.5
- **Created**: 2026-02-26
- **Resolved**: 2026-02-27
- **Original Problem**:
  使用 `kodax -c` 恢复 session 时，存在多个严重的消息显示问题：

  **问题 1: 用户消息重复显示**
  - 同一条用户消息出现两次
  - 例如：`You [10:29 PM] 请你帮我列一下这个项目中的关键文件` 出现两遍

  **问题 2: Assistant 回复被截断**
  - 长回复被截断，显示 `... (33 more lines)` 或类似提示
  - 用户无法查看完整的历史回复内容

  **问题 3: tool_result 显示为 [Complex content]**
  - 用户消息中包含 tool_result 的部分仍显示为 `[Complex content]`
  - 之前的修复只处理了 thinking/tool_use，未处理 tool_result

  **问题 4: thinking 内容被当作正式回复显示**
  - AI 的内部思考过程在 session 恢复时被当作正式回复显示
  - 这不应该发生，thinking 是内部处理过程

- **Context**: `kodax -c` 命令、session 加载/序列化逻辑、MessageList 组件
- **Reproduction**:
  1. 使用 `kodax` 进行多轮对话（包含工具调用）
  2. 退出后使用 `kodax -c` 恢复 session
  3. 观察：
     - 用户消息是否重复
     - 回复是否被截断
     - tool_result 是否显示为 [Complex content]
     - thinking 内容是否被当作正式回复

- **Root Cause**:
  1. **用户消息重复**：`InkREPL.tsx:481` 和 `agent.ts:76` 都添加用户消息到 messages
  2. **回复截断**：`MessageList.tsx` 默认 `maxLines=20` 太小
  3. **[Complex content]**：`extractTextContent` 对纯 tool_result 消息返回 `[Complex content]`
  4. **thinking 内容显示**：`extractTextContent` 提取了 thinking 块内容

- **Resolution**:
  1. 删除 `InkREPL.tsx:481` 的 push 操作，避免重复添加用户消息
  2. 将 `MessageList.tsx` 的 `maxLines` 从 20 增加到 1000
  3. 修改 `extractTextContent` 对纯 tool_result 消息返回空字符串，UI 层过滤空内容
  4. 修改 `extractTextContent` 只提取 text 块，跳过 thinking 块

- **Files Changed**:
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/ui/components/MessageList.tsx`
  - `packages/repl/src/ui/utils/message-utils.ts`

---

### 047: 流式输出时界面闪烁 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.5
- **Fixed**: v0.4.5
- **Created**: 2026-02-26
- **Resolved**: 2026-02-27
- **Original Problem**:
  - 流式输出时界面偶尔会闪烁
  - 输出越快速，闪烁越频繁
  - 当前行为：高速流式输出时出现明显闪烁
  - 预期行为：流式输出应该平滑无闪烁
- **Context**: REPL 流式响应渲染，Ink 组件频繁重绘
- **Reproduction**:
  1. 使用 `kodax` 进行对话
  2. 观察高速流式输出时的界面表现
  3. 注意界面闪烁频率
- **Root Cause Analysis**:
  1. **Ink 渲染机制**：
     - Ink 默认 30fps 渲染（约 33ms/帧）
     - 当前未使用 `maxFps` 参数限制渲染频率
     - `patchConsole: true`（InkREPL.tsx:802）增加额外渲染负载

  2. **流式更新频率**：
     - `appendResponse()` 在 `onTextDelta` 中被调用（InkREPL.tsx:267）
     - 每个 token 都触发状态更新和 React 重渲染
     - 高速输出时更新频率 > 30fps，超出 Ink 渲染能力

  3. **终端渲染特性**：
     - 终端没有 DOM，每次更新需重绘整个视口
     - 动态内容（streamingResponse）每次变化都触发全视口重绘
     - 未使用 `<Static>` 组件固定历史消息

  4. **MessageList 渲染逻辑**（MessageList.tsx:454-466）：
     ```tsx
     {streamingResponse && (
       <Box flexDirection="column">
         {streamingResponse.split("\n").map((line, index) => (
           <Text key={index}>{line || " "}</Text>
         ))}
       </Box>
     )}
     ```
     - 每次更新都重新渲染整个流式响应块
     - `split("\n")` 生成新数组，key 无变化但仍触发重渲染
- **Proposed Solutions**:
  | 方案 | 优先级 | 难度 | 说明 |
  |------|--------|------|------|
  | A. `maxFps` 限制 | 高 | 低 | 添加 `maxFps: 15` 到 render() 选项 |
  | B. 批量更新 | 高 | 中 | 缓冲流式文本，每 50-100ms 更新一次 UI |
  | C. `<Static>` 组件 | 中 | 中 | 将已完成的历史消息移入 Static 组件 |
  | D. 减少 patchConsole | 低 | 高 | 仅在必要时启用 patchConsole |
- **Recommended**: 方案 A + B 组合
  ```tsx
  // InkREPL.tsx - 方案 A
  render(<InkREPL ... />, {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: true,
    maxFps: 15,  // 降低渲染频率
  });
  ```
  ```tsx
  // StreamingContext.tsx - 方案 B
  let responseBuffer = "";
  let updateTimer: NodeJS.Timeout | null = null;

  const appendResponse = (text: string) => {
    responseBuffer += text;
    if (!updateTimer) {
      updateTimer = setTimeout(() => {
        state.currentResponse += responseBuffer;
        responseBuffer = "";
        updateTimer = null;
        notify();
      }, 50);  // 50ms 批量更新
    }
  };
  ```
- **References**:
  - [Ink render options - maxFps](https://github.com/vadimdemedes/ink/blob/main/src/render.ts)
  - [Qwen Code - Ink flickering analysis](https://github.com/QwenLM/qwen-code/issues/1778)
  - [GitHub Copilot CLI - animation rendering](https://github.blog/engineering/from-pixels-to-characters/)
- **Files to Change**:
  - `packages/repl/src/ui/InkREPL.tsx` - 添加 maxFps 参数
  - `packages/repl/src/ui/contexts/StreamingContext.tsx` - 批量更新逻辑

- **Resolution**:
  通过方案 B（批量更新）解决，与 Issue 048 共用同一修复方案。

  **实现方式**:
  - 在 `StreamingContext.tsx` 添加批量更新缓冲区
  - 使用 80ms 刷新间隔，将更新频率从 ~100fps 降到 12.5fps
  - 高速流式输出不再超出 Ink 渲染能力

  **Commit**: (待提交)

---

### 048: Spinner 动画期间消息显示乱序 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.5
- **Fixed**: v0.4.5
- **Created**: 2026-02-27
- **Resolved**: 2026-02-27
- **Original Problem**:
  - Spinner 动画期间历史消息偶尔会乱序显示
  - 响应结束后恢复正常显示
  - 问题是间歇性的，不是每次必现
  - 类似 Issue 045 但触发条件不同
- **Context**: REPL 流式响应 + Spinner 动画并行渲染
- **Reproduction**:
  1. 使用 `kodax` 进行对话
  2. 在 Spinner 动画期间观察消息显示
  3. 偶尔会出现消息顺序错乱
- **Root Cause Analysis**:

  1. **历史消息未使用 Static 组件**（核心问题）:
     ```tsx
     // InkREPL.tsx:647-659 - 当前实现
     {history.length > 0 && (
       <Box flexDirection="column" marginBottom={1}>
         <MessageList items={history} ... />
       </Box>
     )}
     ```
     - 历史消息放在普通 Box 中，每次状态变化都会重新渲染
     - Banner 使用了 `<Static>` 但历史消息没有
     - 当 Spinner 更新或流式内容更新时，整个历史消息树重新渲染

  2. **两套独立的状态系统 + 独立更新周期**:
     | 状态源 | 管理内容 | 更新触发机制 |
     |--------|----------|--------------|
     | UIStateContext | history, isLoading | dispatch (React batch) |
     | StreamingContext | streamingResponse, thinkingContent | notify() → forceUpdate() |
     | Spinner (useState) | frame | setInterval 80ms |

     - 三个系统独立触发 React 重渲染
     - 当同时更新时产生竞态条件
     - Ink 的批处理时机不确定，可能导致渲染顺序不一致

  3. **StreamingContext 立即 notify()**:
     ```typescript
     // StreamingContext.tsx:226-231
     appendResponse: (text: string) => {
       state = { ...state, currentResponse: state.currentResponse + text };
       notify();  // 每个 token 立即触发 forceUpdate()
     },
     ```
     - 每个 token 立即触发整个组件树重渲染
     - 与 Spinner 的 80ms 更新周期不同步

  4. **Spinner 独立更新周期**:
     ```typescript
     // LoadingIndicator.tsx:81-87
     useEffect(() => {
       const timer = setInterval(() => {
         setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
       }, 80);  // 80ms 更新周期
       return () => clearInterval(timer);
     }, []);
     ```
     - Spinner 每 80ms 更新一次帧
     - 流式更新频率不可预测（取决于 API 返回速度）
     - 两者不同步，可能在任意时刻同时触发更新

  5. **终端渲染特性**:
     - 终端没有 DOM diff，每次更新重绘整个视口
     - 多个异步更新同时到达时，最终渲染顺序可能不一致
     - Ink 的 reconciler 在高频率更新时可能有批处理延迟

- **Proposed Solutions**:
  | 方案 | 优先级 | 难度 | 说明 |
  |------|--------|------|------|
  | A. Static 组件包裹历史消息 | 高 | 中 | 将已完成的历史消息移入 Static 组件 |
  | B. 统一更新周期 | 高 | 中 | 流式内容与 Spinner 同步更新 |
  | C. 合并状态系统 | 中 | 高 | 将 UIStateContext 和 StreamingContext 合并 |

- **Recommended**: 方案 A + B 组合

  **方案 A: Static 组件包裹历史消息**
  ```tsx
  // InkREPL.tsx - 重构渲染结构
  // 已完成的历史消息使用 Static，避免重渲染
  <Static items={completedHistory}>
    {(item) => <HistoryItemRenderer key={item.id} item={item} ... />}
  </Static>

  // 动态区域：仅包含当前流式响应 + Spinner
  {streamingResponse && (
    <StreamingContent text={streamingResponse} />
  )}
  {isLoading && <Spinner />}
  ```
  - 关键点：`completedHistory` 不包含正在流式传输的最后一条 assistant 消息
  - 流式响应单独渲染，不影响历史消息

  **方案 B: 统一更新周期**
  ```typescript
  // StreamingContext.tsx - 批量更新 + 同步 Spinner
  const UPDATE_INTERVAL = 60; // ~15fps，与 Spinner 对齐

  let responseBuffer = "";
  let thinkingBuffer = "";
  let updateTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;

  const startStreaming = () => {
    state = { ...state, state: StreamingState.Responding, ... };
    // 启动统一更新定时器
    updateTimer = setInterval(() => {
      const hasUpdates = responseBuffer || thinkingBuffer;
      if (hasUpdates) {
        state = {
          ...state,
          currentResponse: state.currentResponse + responseBuffer,
          thinkingContent: state.thinkingContent + thinkingBuffer,
          spinnerFrame: (spinnerFrame + 1) % SPINNER_FRAMES.length,
        };
        responseBuffer = "";
        thinkingBuffer = "";
        notify();
      }
    }, UPDATE_INTERVAL);
    notify();
  };

  const appendResponse = (text: string) => {
    responseBuffer += text;  // 仅缓冲，不立即通知
  };

  const stopStreaming = () => {
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
    // 最终刷新
    if (responseBuffer || thinkingBuffer) {
      state = {
        ...state,
        currentResponse: state.currentResponse + responseBuffer,
        thinkingContent: state.thinkingContent + thinkingBuffer,
      };
      responseBuffer = "";
      thinkingBuffer = "";
    }
    state = { ...state, state: StreamingState.Idle, ... };
    notify();
  };
  ```
  - 流式内容和 Spinner 动画使用同一个定时器
  - 所有更新在同一个渲染周期内完成
  - 消除竞态条件

- **Implementation Notes**:
  1. 方案 A 需要重构 MessageList 组件，分离静态和动态内容
  2. 方案 B 需要将 Spinner 的帧管理移到 StreamingContext
  3. 两个方案可以独立实现，但组合使用效果最佳
  4. 需要考虑流式响应中断时的缓冲区清理

- **Files to Change**:
  - `packages/repl/src/ui/InkREPL.tsx` - Static 组件重构
  - `packages/repl/src/ui/contexts/StreamingContext.tsx` - 统一更新周期
  - `packages/repl/src/ui/components/MessageList.tsx` - 分离静态/动态渲染
  - `packages/repl/src/ui/components/LoadingIndicator.tsx` - Spinner 帧管理移出

- **Resolution**:
  实施方案 B（统一更新周期）已解决闪烁和乱序问题。

  **实现方式**:
  - 在 `StreamingContext.tsx` 添加 `pendingResponseText` 和 `pendingThinkingText` 缓冲区
  - 使用 80ms 刷新间隔（与 Spinner 动画同步）
  - 在关键操作（stopStreaming, abort, setError 等）前强制刷新缓冲区
  - 确保所有内容在响应结束时完整显示

  **方案 A 决策**:
  - 方案 A（Static 组件）边际收益低，不实施
  - 方案 B 已将更新频率从 ~100fps 降到 12.5fps
  - Ink 的 reconciler 会跳过未变化的内容，重渲染开销可接受

  **Commit**: (待提交)

---

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
