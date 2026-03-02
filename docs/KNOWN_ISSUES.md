# Known Issues

_Last Updated: 2026-03-02 10:45_

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 001 | Low | Resolved | 未使用常量 PLAN_GENERATION_PROMPT | v0.3.1 | v0.4.5 | 2026-02-19 | 2026-02-27 |
| 002 | Low | Won't Fix | /plan 命令未使用 _currentConfig 参数 | v0.3.1 | - | 2026-02-19 | 2026-02-27 |
| 003 | Medium | Won't Fix | Plan 文件无版本号 | v0.3.1 | - | 2026-02-19 | 2026-02-22 |
| 004 | Medium | Won't Fix | Plan 解析正则表达式脆弱 | v0.3.1 | - | 2026-02-19 | 2026-02-22 |
| 005 | Low | Resolved | 中英文注释混用 | v0.3.1 | v0.4.5 | 2026-02-19 | 2026-02-27 |
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
| 049 | High | Resolved | 权限模式持久化位置错误 | v0.5.0 | v0.5.0 | 2026-02-27 | 2026-02-27 |
| 050 | Medium | Resolved | 命令输出格式不一致（AI 编造问题） | v0.4.6 | v0.4.6 | 2026-02-27 | 2026-02-28 |
| 051 | Medium | Resolved | 权限确认取消时无提示 | v0.4.6 | v0.4.6 | 2026-02-27 | 2026-02-28 |
| 052 | High | Resolved | 受保护路径确认对话框显示错误选项 | v0.4.6 | v0.4.6 | 2026-02-28 | 2026-02-28 |
| 053 | High | Won't Fix | /help 命令输出重复渲染 | v0.4.7 | - | 2026-02-28 | 2026-03-01 |
| 054 | Critical | Open | Agent Skills 系统未与 LLM 集成 | v0.4.7 | - | 2026-03-01 | - |
| 055 | Low | Open | Built-in Skills 未完全符合 Agent Skills 规范 | v0.4.7 | - | 2026-03-01 | - |
| 056 | Medium | Resolved | Skills 系统缺少渐进式披露机制 | v0.4.8 | v0.4.8 | 2026-03-01 | 2026-03-01 |
| 057 | Medium | Resolved | Skill 命令格式不符合 pi-mono 设计规范 | v0.4.8 | v0.4.8 | 2026-03-01 | 2026-03-01 |
| 058 | Medium | Open | Windows Terminal 流式输出闪烁和滚动问题 | v0.4.8 | - | 2026-03-01 | - |
| 059 | High | Resolved | Skills 延迟加载导致首次调用失败 | v0.4.8 | v0.4.8 | 2026-03-01 | 2026-03-01 |
| 060 | Medium | Open | UI 更新定时器未统一，存在相位差 | v0.4.5 | - | 2026-03-02 | - |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->

### 001: 未使用常量 PLAN_GENERATION_PROMPT (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.5
- **Created**: 2026-02-19
- **Original Problem**:
  - 定义了 `PLAN_GENERATION_PROMPT` 常量作为计划生成的提示词模板，但实际 `generatePlan` 函数中并未使用它
  - 而是通过 `runKodaX` 内部的系统提示词来生成计划
- **Context**: `packages/repl/src/common/plan-mode.ts`
- **Resolution**:
  - 删除未使用的 `PLAN_GENERATION_PROMPT` 常量（25 行代码）
  - `generatePlan` 函数已有自己的内联提示词，不需要这个常量
  - 纯删除操作，无功能变更
- **Resolution Date**: 2026-02-27
- **Files Changed**: `packages/repl/src/common/plan-mode.ts`

---

### 002: /plan 命令未使用 _currentConfig 参数 (WON'T FIX)
- **Priority**: Low
- **Status**: Won't Fix
- **Introduced**: v0.3.1 (auto-detected)
- **Created**: 2026-02-19
- **Original Problem**:
  ```typescript
  handler: async (args, _context, callbacks, _currentConfig) => {
    // _currentConfig 从未使用
  }
  ```
  - 所有命令 handler 签名相同，但此参数未被使用
- **Context**: `packages/repl/src/interactive/commands.ts`
- **Decision**: 不修复，理由如下：
  1. **下划线前缀是标准约定**: `_currentConfig` 表示"故意不使用"，是 TypeScript 社区标准做法
  2. **类型签名要求**: `CommandHandler` 类型要求 4 个参数，无法删除
  3. **无实际功能问题**: 这是代码风格观察，不是 bug
  4. **修改风险高**: 修改类型签名会影响所有命令
- **Resolution Date**: 2026-02-27

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

### 005: 中英文注释混用 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.4.5
- **Created**: 2026-02-19
- **Original Problem**:
  - 代码中混合使用中文和英文注释
  - 例如：`// 延迟创建 readline 接口` (中文) vs `// Check if project exists` (英文)
  - 国际化团队协作困难，代码风格不一致
- **Context**: `src/interactive/` 目录下多个文件
- **Resolution**:
  - 建立了英文优先的双语注释风格指南
  - 格式: `// English comment - 中文简述` (单行) 或 `/** English description - 中文描述 */` (JSDoc)
  - 简单逻辑使用纯英文，复杂/业务逻辑使用英文+中文简述
  - 更新了所有 interactive 模块和 UI 模块的注释
- **Resolution Date**: 2026-02-27
- **Files Changed**:
  - packages/repl/src/interactive/*.ts
  - packages/repl/src/ui/**/*.ts, packages/repl/src/ui/**/*.tsx
- **Tests Added**: None (comment-only changes, build verification)

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
- Total: 52 (7 Open, 41 Resolved, 4 Won't Fix)
- Highest Priority Open: 006 - 整数解析无范围检查 (Low)

---

## Changelog

### 2026-02-28: Issue 052 修复
- Resolved 052: 受保护路径确认对话框显示错误选项
- 修复 `gitRoot` 变量读取错误：从 `options.context?.gitRoot` 改为 `context.gitRoot`
- 新增 `isCommandOnProtectedPath()` 函数检测 bash 命令中的受保护路径
- 扩展受保护路径检查：同时覆盖 `write`/`edit` 工具和 `bash` 命令
- 修改文件：`InkREPL.tsx`, `permission/permission.ts`, `permission/index.ts`

### 2026-02-28: Issue 051 修复
- Resolved 051: 权限确认取消时无提示
- 在 `beforeToolExecute` 中用户拒绝确认时添加取消提示消息
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`

### 2026-02-27: Issue 002 标记为 Won't Fix
- Issue 002 (/plan 命令未使用 _currentConfig 参数) 标记为 Won't Fix
- 理由：下划线前缀是 TypeScript 标准约定，表示"故意不使用"
- 类型签名要求该参数，无法删除
- 无实际功能问题

### 2026-02-27: Issue 001 已修复
- Issue 001 (未使用常量 PLAN_GENERATION_PROMPT) 已修复
- 删除了 `packages/repl/src/common/plan-mode.ts` 中未使用的 `PLAN_GENERATION_PROMPT` 常量（25 行代码）
- 该常量从未被 `generatePlan` 函数使用，是纯粹的死代码删除

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

### 049: 权限模式持久化位置错误 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.5.0
- **Fixed**: v0.5.0
- **Created**: 2026-02-27
- **Resolved**: 2026-02-27
- **Original Problem**:
  - 在 REPL 中使用 `/mode default` 切换权限模式时，用户配置文件 `~/.kodax/config.json` 中的 `permissionMode` 未变化
  - `permissionMode` 被错误地保存到项目级配置 `.kodax/config.local.json` 中
  - 用户期望权限模式是用户级别的偏好设置，应该在用户配置文件中管理
- **Context**:
  - `packages/repl/src/common/permission-config.ts` 提供了两个保存函数：
    - `savePermissionModeProject()` - 保存到 `.kodax/config.local.json`
    - `savePermissionModeUser()` - 保存到 `~/.kodax/config.json`
  - 当前代码调用的是 `savePermissionModeProject()` 而不是 `savePermissionModeUser()`
- **Root Cause**: 使用了错误的保存函数，`permissionMode` 应该保存到用户级配置而非项目级配置
- **Resolution**:
  - 将 `savePermissionModeProject()` 调用改为 `savePermissionModeUser()`
  - 更新帮助文档，将 "saved to .kodax/config.local.json" 改为 "saved to ~/.kodax/config.json"
- **Files Changed**:
  - `packages/repl/src/interactive/commands.ts` - 修改 import 和调用
  - `packages/repl/src/ui/InkREPL.tsx` - 修改 import 和调用

---

### 050: 命令输出格式不一致（AI 编造问题）(RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.6
- **Fixed**: v0.4.6
- **Created**: 2026-02-27
- **Original Problem**:
  在 REPL 中连续执行多个 bash 命令时，命令输出格式不一致：

  **第一次 `ls -a`**：显示正确，Windows `dir` 格式的详细输出（带日期、大小）
  ```
  C:\Works\GitWorks\MarkXbook 的目录
  2026/02/27  23:41    <DIR>          .
  2026/02/27  23:40    <DIR>          ..
  ...
  ```

  **第二次 `ls -a`**：格式错误，显示简化的 Unix ls 风格（只有文件名）
  ```
  .                ..               .git            .gitignore
  .kodax           feature_list.json  node_modules   package.json
  ...
  ```

  **核心问题**：
  - 同一个命令 `ls -a` 在连续执行时输出格式不同
  - 第一次是真正执行命令得到的输出（Windows dir 格式）
  - 后续可能是 AI 模型自己"编造"的输出（Unix ls 风格），而非真正调用 bash 工具
- **Context**:
  - REPL 中的 Bash 工具执行
  - Windows 环境下 `ls -a` 命令（在 Windows 上 `ls -a` 等同于 `dir /a`）
  - 大模型工具调用行为
- **Root Cause Analysis**:
  这是 **大模型行为问题**，而非 kodax 代码问题：

  1. Bash 工具代码正确实现了命令执行（使用 `spawn` 真正执行）
  2. 第一次 AI 正确调用了 bash 工具，得到真实的 Windows 输出
  3. 后续 AI 可能：
     - 没有真正调用 bash 工具，而是基于对话历史自己"编造"输出
     - AI 的训练数据中 Unix `ls` 格式更常见，所以编造了 Unix 风格的输出

  **验证方法**：检查输出中是否有 `Command: ${command}` 前缀
  - 有前缀：真正执行了命令
  - 无前缀：AI 编造的输出

- **Resolution**:
  - 在 bash 工具输出中添加执行的命令（`Command: ${command}`）
  - 输出格式从 `Exit: ${code}\n${output}` 改为 `Command: ${command}\nExit: ${code}\n${output}`
  - 同时更新了超时和错误消息格式以保持一致性
  - 这使 AI 和用户都能清楚地辨别：哪些是真正执行的命令输出，哪些可能是 AI 编造的
  - 帮助 AI 在多轮对话中正确归因输出与命令的对应关系
- **Resolution Date**: 2026-02-28
- **Files Changed**: packages/core/src/tools/bash.ts

---

### 051: 权限确认取消时无提示 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.6
- **Fixed**: v0.4.6
- **Created**: 2026-02-27
- **Original Problem**:
  在 Feature 009 测试 (TC-008) 中发现：
  - 执行需要权限确认的文件操作（如 `创建文件 test_reject.txt`）
  - 在确认对话框中按 `n` (no) 拒绝操作
  - 操作被成功取消，但没有显示 `[Cancelled] Operation cancelled by user` 提示
  - 用户无法得到明确的取消反馈
- **Expected Behavior**:
  - 按下 `n` 后应显示 `[Cancelled] Operation cancelled by user` 或类似的取消提示
- **Context**:
  - REPL 权限确认系统
  - Feature 009: 架构重构后的权限层
  - TC-008 测试用例：拒绝操作确认
- **Reproduction**:
  1. 启动 `kodax` 进入 REPL
  2. 执行 `创建文件 test_reject.txt`
  3. 在确认对话框中按 `n`
  4. 观察：操作被取消但无提示信息
- **Root Cause**: 在 `InkREPL.tsx` 的 `beforeToolExecute` 钩子中，当用户拒绝确认时只返回 `false` 阻止工具执行，但没有输出任何取消提示消息。
- **Resolution**:
  - 在 `beforeToolExecute` 中，当 `result.confirmed` 为 `false` 时，添加 `console.log(chalk.yellow('[Cancelled] Operation cancelled by user'))` 输出取消提示
  - 最小化改动，只添加一行代码
- **Resolution Date**: 2026-02-28
- **Files Changed**: `packages/repl/src/ui/InkREPL.tsx`

---

### 052: 受保护路径确认对话框显示错误选项 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.4.6
- **Fixed**: v0.4.6
- **Created**: 2026-02-28
- **Original Problem**:
  在 Feature 009 测试 (TC-009) 中发现两个相关的问题：

  **问题 1: 受保护路径显示 "always" 选项**
  - 当操作涉及受保护路径（如 `.kodax/test_protected.txt`）时
  - 确认对话框显示了 `Press (y) yes, (a) always yes for this tool, (n) no`
  - 受保护路径不应该允许设置 "always"，因为这会绕过安全保护
  - 预期提示应该只显示 `(y) yes, (n) no`，不包含 `(a) always` 选项

  **问题 2: 缺少 "(protected path)" 提示**
  - 受保护路径的确认对话框应该显示明确的标识
  - 预期提示应包含 `(protected path)` 或类似说明
  - 例如：`Press (y) to confirm, (n) to cancel (protected path)`
- **Expected Behavior**:
  - 受保护路径的确认对话框应该：
    1. 不显示 `(a) always` 选项
    2. 显示 `(protected path)` 提示
- **Context**:
  - REPL 权限确认系统
  - 受保护路径：`.kodax/`, `~/.kodax/`, 项目外路径
  - Feature 009: 架构重构后的权限层
  - TC-009 测试用例：受保护路径确认
- **Reproduction**:
  1. 启动 `kodax` 进入 REPL（在某个 git 项目目录）
  2. 执行 `在 .kodax 目录创建文件 test_protected.txt`
  3. 观察确认对话框：
     - 是否显示 `(a) always` 选项（不应该显示）
     - 是否显示 `(protected path)` 提示（应该显示）
- **Root Cause**:
  - **问题 A**: `gitRoot` 从错误的来源读取 (`options.context?.gitRoot` → 应该是 `context.gitRoot`)
  - **问题 B**: 受保护路径检查只覆盖 `FILE_MODIFICATION_TOOLS` (write/edit)，不包括 `bash` 命令
  - 因此通过 bash 删除受保护路径文件时，仍然显示 "always" 选项
- **Resolution**:
  - 修复 `gitRoot` 来源：`options.context?.gitRoot` → `context.gitRoot`
  - 新增 `isCommandOnProtectedPath()` 函数检测 bash 命令中的受保护路径
  - 扩展受保护路径检查：同时检查 `write`/`edit` 工具和 `bash` 命令
  - 更新 `createStreamingEvents` 的依赖数组
- **Resolution Date**: 2026-02-28
- **Files Changed**:
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/permission/permission.ts`
  - `packages/repl/src/permission/index.ts`

---

### 053: /help 命令输出重复渲染 (WON'T FIX)
- **Priority**: High
- **Status**: Won't Fix
- **Introduced**: v0.4.7
- **Fixed**: -
- **Created**: 2026-02-28
- **Original Problem**:
  在 REPL 中执行 `/help` 或 `/h` 命令时，整个消息（用户输入 + 命令输出）会重复渲染两次：
  1. 第一次输出：完整的帮助信息（部分情况下可能不完整）
  2. 第二次输出：完整的帮助信息（包含 "Skills:" 部分）

  **观察到的现象**:
  ```
  You [11:40 PM]
    /help

  ℹ Info
    Available Commands:
    ... (完整帮助信息，但缺少末尾 Skills 部分)

  You [11:40 PM]
    /help

  ℹ Info
    Available Commands:
    ... (完整帮助信息，包含末尾 Skills 部分)
  ```

  **关键发现**:
  - 问题只发生在 `/help` 命令
  - `/model` 和 `/skills` 命令没有此问题
  - 用户只输入了一次 `/help`，但 `handleSubmit` 被调用了两次
  - 两次输出的时间戳相同
- **Expected Behavior**:
  - 执行 `/help` 命令后，只显示一次用户消息和一次命令输出
- **Context**:
  - REPL 交互系统
  - Ink UI 框架
  - KeypressContext 键盘事件处理
  - `handleSubmit` 在 InputPrompt.tsx 和 InkREPL.tsx 中
- **Reproduction**:
  1. 启动 `kodax` 进入 REPL
  2. 执行 `/help` 或 `/h`
  3. 观察：用户消息和帮助信息出现两次
- **Analysis**:
  **可能原因 1: Keypress handler 重复注册**
  - `useKeypress` 在组件依赖变化时会重新注册 handler
  - 在旧 handler 注销和新 handler 注册之间可能存在竞态条件
  - 导致同一个按键事件被两个 handler 处理

  **可能原因 2: React state 更新触发多次渲染**
  - `handleSubmit` 触发多个 state 更新
  - 这些更新可能导致组件重新渲染
  - 在渲染过程中可能触发了额外的提交

  **可能原因 3: console.log 捕获机制问题**
  - Ink 的 `patchConsole: true` 与手动 console 捕获冲突
  - 可能导致输出被捕获两次

  **分析代码流程**:
  1. `InputPrompt.handleSubmit()` 调用 `onSubmit(text)`
  2. `InkREPL.handleSubmit()` 被调用
  3. 添加用户消息到历史: `addHistoryItem({ type: "user", text: input })`
  4. 执行命令: `executeCommand(parsed, ...)`
  5. 捕获 console 输出并添加到历史: `addHistoryItem({ type: "info", text: capturedOutput.join('\n') })`

  这个流程应该只产生一次输出，但实际上产生了两次。
- **Attempted Fixes**:
  **尝试 1: 添加提交保护 (2026-02-28)**
  ```typescript
  const isSubmittingRef = useRef(false);

  const handleSubmit = useCallback(() => {
    if (isSubmittingRef.current) {
      return;
    }
    if (text.trim()) {
      isSubmittingRef.current = true;
      // ... 提交逻辑
      setTimeout(() => {
        isSubmittingRef.current = false;
      }, 100);
    }
  }, [text, addHistory, onSubmit, clear]);
  ```
  **结果**: 无效，问题仍然存在

  **分析**: 如果问题不是在 InputPrompt 层面的重复调用，而是在更底层（如 Ink 的渲染机制或 stdin 事件处理），那么这个保护无法解决问题
- **Files Investigated**:
  - `packages/repl/src/ui/components/InputPrompt.tsx`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/ui/contexts/KeypressContext.tsx`
  - `packages/repl/src/ui/contexts/StreamingContext.tsx`
  - `packages/repl/src/ui/contexts/UIStateContext.tsx`
  - `packages/repl/src/ui/components/MessageList.tsx`
  - `packages/repl/src/interactive/commands.ts`
- **Decision**: 不修复，理由如下：
  1. **终端特定问题**: 问题只在 warp.dev 终端中出现，在 PowerShell 中未复现
  2. **外部因素**: 可能是 warp.dev 本身的渲染机制与 Ink 框架存在冲突
  3. **优先级考量**: 不影响核心功能，且只在特定终端环境下出现
  4. **修复成本高**: 需要针对特定终端做兼容性处理，投入产出比不合理
- **Resolution Date**: 2026-03-01

---

### 054: Agent Skills 系统未与 LLM 集成 (OPEN → P0 RESOLVED)
- **Priority**: Critical → Medium (P0 已修复)
- **Status**: Open (P1/P2 待实现)
- **Introduced**: v0.4.7
- **Fixed**: v0.4.8 (P0)
- **Created**: 2026-03-01
- **Original Problem**:
  当前通过 slash 命令（如 `/code-review`）调用 Agent Skills 时，系统只是打印 skill 内容的预览，而没有将 skill 内容注入 LLM 上下文让 AI 真正执行 skill。

  **观察到的现象**:
  ```
  You [11:50 PM]
    /code-review

  ℹ Info
    --- code-review skill ---
    Use this skill for code review. Invokes the code-reviewer agent...
    (只显示前 500 字符的预览)
    --- end code-review ---
  ```

  **核心问题**:
  - Skill 命令执行后，LLM 没有收到 skill 的完整内容
  - AI 无法根据 skill 的指导执行任务
  - 用户期望的是 AI 会执行 code-review，而不是看到 skill 文件的预览
- **Expected Behavior**:
  - 执行 `/code-review` 后，skill 内容应该被注入到 LLM 的系统提示词或上下文中
  - AI 应该根据 skill 内容的指导执行相应的任务
  - 参考协议: https://agentskills.io/
- **Context**:
  **当前 KodaX 实现的问题**:

  `packages/repl/src/interactive/commands.ts` (第 811-854 行):
  ```typescript
  async function executeSkillCommand(parsed, context) {
    const skill = await registry.loadFull(skillName);
    console.log(`--- ${skillName} skill ---`);
    console.log(fullSkill.content.slice(0, 500));  // 只是打印预览！
    console.log(`--- end ${skillName} ---`);
    // 没有将 skill 内容传递给 LLM！
  }
  ```

  这个实现存在根本性问题：
  1. 只使用 `console.log` 打印内容，没有与 LLM 交互
  2. 只显示前 500 字符，无法利用完整 skill 内容
  3. 没有将 skill 注入系统提示词或消息上下文
- **Reference Implementation (pi-mono 最佳实践)**:
  **pi-mono 项目的优雅实现** (位于 `C:\Works\GitWorks\pi-mono`)，详细分析如下：

  ### 1. 双轨注入机制

  **系统提示词注入（渐进式披露）**:
  - 位置：`packages/coding-agent/src/core/system-prompt.ts` (第 178-181 行)
  - 方式：将 skill 元数据（名称、描述、路径）注入系统提示词
  - 时机：会话启动时或系统提示词重建时
  ```typescript
  // system-prompt.ts
  if (hasRead && skills.length > 0) {
      prompt += formatSkillsForPrompt(skills);
  }
  ```

  **用户命令展开（按需加载）**:
  - 位置：`packages/coding-agent/src/core/agent-session.ts` (第 878-907 行)
  - 方式：用户输入 `/skill:name` 时，展开为完整 skill XML 块
  - 时机：每次用户发送消息时
  ```typescript
  private _expandSkillCommand(text: string): string {
      if (!text.startsWith("\\skill:")) return text;

      const spaceIndex = text.indexOf(" ");
      const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
      const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

      const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
      if (!skill) return text;

      const content = readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
  }
  ```

  ### 2. Skill 格式化标准

  **系统提示词中的格式** (`skills.ts` 第 290-316 行):
  ```
  The following skills provide specialized instructions for specific tasks.
  Use the read tool to load a skill's file when the task matches its description.

  <available_skills>
    <skill>
      <name>pdf-tools</name>
      <description>Extracts text and tables from PDF files...</description>
      <location>/path/to/skills/pdf-tools/SKILL.md</location>
    </skill>
  </available_skills>
  ```

  **用户消息中的格式** (展开后):
  ```xml
  <skill name="pdf-tools" location="/path/to/skills/pdf-tools/SKILL.md">
  References are relative to /path/to/skills/pdf-tools.

  # PDF Tools
  ## Setup
  npm install
  ## Usage
  ./extract.sh file.pdf
  </skill>

  User message here if provided
  ```

  ### 3. 重复注入防护机制

  **加载时去重 (Load-Time Deduplication)**:
  - 位置：`packages/coding-agent/src/core/skills.ts` (第 361-400 行)
  - 同名 skill 只加载第一个发现的
  - 通过 realpath 检测符号链接指向同一文件的情况
  ```typescript
  function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
      const skillMap = new Map<string, Skill>();
      const realPathSet = new Set<string>();

      for (const skill of result.skills) {
          // 解析符号链接检测重复文件
          let realPath: string;
          try {
              realPath = realpathSync(skill.filePath);
          } catch {
              realPath = skill.filePath;
          }

          // 跳过已加载的文件（通过符号链接）
          if (realPathSet.has(realPath)) {
              continue;
          }

          const existing = skillMap.get(skill.name);
          if (existing) {
              // 报告冲突诊断
              collisionDiagnostics.push({
                  type: "collision",
                  message: `name "${skill.name}" collision`,
                  path: skill.filePath,
                  collision: {
                      resourceType: "skill",
                      name: skill.name,
                      winnerPath: existing.filePath,
                      loserPath: skill.filePath,
                  },
              });
          } else {
              skillMap.set(skill.name, skill);
              realPathSet.add(realPath);
          }
      }
  }
  ```

  **重要发现 - 没有会话级别去重**:
  - pi-mono **不实现**会话级别的重复注入防护
  - 用户可以多次调用 `/skill:name`，每次都会生成新的 skill 块
  - 设计哲学是**无状态的、基于消息的设计**
  - 所有 skill 块都保存在会话历史中（直到压缩）

  ### 4. Skill 生命周期

  ```
  加载阶段 (Startup)
      ↓
  loadSkills() 扫描目录
      ↓
  去重 + 冲突检测
      ↓
  系统提示词注入 ─────────────────────────┐
      ↓                                    │
  formatSkillsForPrompt()                  │
  生成 <available_skills> 块               │
      ↓                                    │
  运行时调用                                │
      ↓                                    │
  用户输入 /skill:name                      │
      ↓                                    │
  _expandSkillCommand() 展开                │
      ↓                                    │
  生成 <skill> XML 块                       │
      ↓                                    │
  作为用户消息发送给 LLM                    │
      ↓                                    │
  持久化到会话历史                          │
      ↓                                    │
  UI 渲染为折叠组件                         │
      ↓                                    │
  上下文压缩时可能被摘要                     │
  ```

  ### 5. UI 渲染处理

  - 位置：`packages/coding-agent/src/modes/interactive/interactive-mode.ts` (第 2407-2432 行)
  - 检测用户消息中的 skill 块
  - 渲染为可折叠的 `[skill] name` 组件
  ```typescript
  case "user": {
      const textContent = this.getUserMessageText(message);
      const skillBlock = parseSkillBlock(textContent);
      if (skillBlock) {
          // 渲染 skill 块（可折叠）
          const component = new SkillInvocationMessageComponent(
              skillBlock,
              this.getMarkdownThemeWithSettings(),
          );
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
          // 如果有用户消息，单独渲染
          if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(
                  skillBlock.userMessage,
                  this.getMarkdownThemeWithSettings(),
              );
              this.chatContainer.addChild(userComponent);
          }
      }
  }
  ```

  ### 6. 关键设计决策

  **有实现的**:
  - ✅ 加载时去重（同名 skill 只加载第一个）
  - ✅ XML 格式化（遵循 Agent Skills 规范）
  - ✅ 渐进式披露（描述在系统提示词，完整内容按需加载）
  - ✅ Skill 块解析和 UI 渲染
  - ✅ 冲突检测和诊断报告

  **没有实现的（有意设计）**:
  - ❌ 会话级别去重（允许同一 skill 多次注入）
  - ❌ 激活状态跟踪（没有"当前激活的 skills"状态）
  - ❌ Skill 缓存（每次调用都重新读取文件）
  - ❌ Skill 生命周期管理（没有 activate/deactivate）

  **设计哲学**:
  - 无状态的、基于消息的架构
  - 每条消息独立处理
  - 依赖 LLM 的上下文窗口和注意力机制处理 skill 有效性
  - 不维护持久化的"激活 skills"状态

- **Files Investigated**:
  **KodaX (当前实现)**:
  - `packages/repl/src/interactive/commands.ts` - executeSkillCommand 实现（问题根源）
  - `packages/repl/src/skills/executor.ts` - 存在但未连接到 REPL
  - `packages/repl/src/skills/skill-registry.ts` - 加载 skill 但不执行
  - `packages/repl/src/skills/types.ts` - 类型定义
  - `packages/repl/src/skills/discovery.ts` - 发现 skills
  - `packages/repl/src/skills/skill-loader.ts` - 加载 skill 文件

  **pi-mono (参考实现)**:
  - `packages/coding-agent/src/core/skills.ts` - 完整的 skill 加载和格式化
  - `packages/coding-agent/src/core/system-prompt.ts` - 系统提示词集成
  - `packages/coding-agent/src/core/agent-session.ts` - `_expandSkillCommand()` 实现
  - `packages/coding-agent/src/core/resource-loader.ts` - 资源管理
  - `packages/coding-agent/src/modes/interactive/interactive-mode.ts` - UI 渲染

- **Resolution Approach**:
  需要架构性重构，关键步骤：

  1. **实现 `_expandSkillCommand()` 函数**:
     ```typescript
     // 新增函数
     function expandSkillCommand(input: string, skills: SkillRegistry): string {
       if (!input.startsWith("/")) return input;

       const skillName = input.slice(1).split(" ")[0];
       const args = input.slice(skillName.length + 2).trim();
       const skill = skills.get(skillName);

       if (!skill) return input; // 未知 skill，原样返回

       const content = fs.readFileSync(skill.filePath, "utf-8");
       const body = stripFrontmatter(content).trim();
       const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">
     References are relative to ${skill.baseDir}.

     ${body}
     </skill>`;
       return args ? `${skillBlock}\n\n${args}` : skillBlock;
     }
     ```

  2. **修改 executeSkillCommand**:
     - 不再使用 console.log 打印
     - 调用 `_expandSkillCommand()` 展开技能
     - 返回展开后的内容作为用户消息

  3. **集成到消息流**:
     - 展开的 skill 块作为用户消息发送给 LLM
     - LLM 接收完整的 skill 内容并执行

  4. **实现 formatSkillsForPrompt()**:
     - 将可用技能列表注入系统提示词
     - 使用 `<available_skills>` XML 格式
     - 支持渐进式披露

  5. **添加 UI 渲染支持**:
     - 检测用户消息中的 skill 块
     - 渲染为可折叠组件
     - 分离 skill 内容和用户附加消息

- **Claude Code 官方 Skills 规范 (https://code.claude.com/docs/en/skills)**:

  ### 1. Commands 与 Skills 的统一

  **官方说明**:
  > "Custom slash commands have been merged into skills. A file at `.claude/commands/review.md` and a skill at `.claude/skills/review/SKILL.md` both create `/review` and work the same way. Your existing `.claude/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control whether you or Claude invokes them, and the ability for Claude to load them automatically when relevant."

  **关键点**:
  - `.claude/commands/review.md` 和 `.claude/skills/review/SKILL.md` 都创建 `/review` 命令
  - 两者工作方式相同，向后兼容
  - Skills 增加了额外功能：
    - 支持文件的目录（templates, examples, scripts）
    - frontmatter 控制调用方式
    - Claude 自动加载能力

  ### 2. 官方目录结构

  | 位置 | 路径 | 作用域 |
  |------|------|--------|
  | Enterprise | 管理设置 | 组织内所有用户 |
  | Personal | `~/.claude/skills/<skill-name>/SKILL.md` | 用户的所有项目 |
  | Project | `.claude/skills/<skill-name>/SKILL.md` | 仅当前项目 |
  | Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | 插件启用范围 |

  **优先级**: enterprise > personal > project
  **Plugin skills**: 使用 `plugin-name:skill-name` 命名空间避免冲突

  **Skill 目录结构**:
  ```
  my-skill/
  ├── SKILL.md           # 主指令（必需）
  ├── template.md        # Claude 填充的模板
  ├── examples/
  │   └── sample.md      # 示例输出
  └── scripts/
      └── validate.sh    # Claude 可执行的脚本
  ```

  ### 3. 官方 Frontmatter 字段

  | 字段 | 必需 | 说明 |
  |------|------|------|
  | `name` | 否 | 显示名称，省略则用目录名。小写字母、数字、连字符，最多64字符 |
  | `description` | 推荐 | 技能描述，Claude 用于判断何时使用。省略则用 markdown 第一段 |
  | `argument-hint` | 否 | 自动补全时显示的参数提示，如 `[issue-number]` |
  | `disable-model-invocation` | 否 | 设为 `true` 阻止 Claude 自动加载。用于手动触发的命令 |
  | `user-invocable` | 否 | 设为 `false` 从 `/` 菜单隐藏。用于背景知识 |
  | `allowed-tools` | 否 | 技能激活时 Claude 可使用的工具，如 `Read, Grep, Bash(python *)` |
  | `model` | 否 | 指定模型 `haiku`/`sonnet`/`opus` |
  | `context` | 否 | 设为 `fork` 在子代理中运行 |
  | `agent` | 否 | `context: fork` 时使用的子代理类型：`Explore`/`Plan`/`general-purpose` |
  | `hooks` | 否 | 技能生命周期钩子 |

  ### 4. 调用控制矩阵

  | Frontmatter | 用户可调用 | Claude 可调用 | 何时加载到上下文 |
  |-------------|-----------|--------------|-----------------|
  | (默认) | Yes | Yes | 描述始终在上下文，调用时加载完整内容 |
  | `disable-model-invocation: true` | Yes | No | 描述不在上下文，用户调用时加载 |
  | `user-invocable: false` | No | Yes | 描述始终在上下文，调用时加载完整内容 |

  ### 5. 参数传递语法

  | 变量 | 说明 |
  |------|------|
  | `$ARGUMENTS` | 所有参数。如果内容中没有 `$ARGUMENTS`，则追加 `ARGUMENTS: <value>` |
  | `$ARGUMENTS[N]` | 按位置访问参数，如 `$ARGUMENTS[0]` 为第一个参数 |
  | `$N` | `$ARGUMENTS[N]` 的简写，如 `$0`/`$1`/`$2` |
  | `${CLAUDE_SESSION_ID}` | 当前会话 ID |

  ### 6. 动态上下文注入

  使用 `!`command`` 语法在 skill 内容发送给 Claude 之前执行 shell 命令：

  ```markdown
  ---
  name: pr-summary
  description: Summarize changes in a pull request
  context: fork
  agent: Explore
  ---

  ## Pull request context
  - PR diff: !`gh pr diff`
  - PR comments: !`gh pr view --comments`
  - Changed files: !`gh pr diff --name-only`

  ## Your task
  Summarize this pull request...
  ```

  ### 7. 子代理执行 (context: fork)

  当 `context: fork` 时，skill 内容成为驱动子代理的 prompt：
  - 子代理无权访问对话历史
  - `agent` 字段决定执行环境（模型、工具、权限）
  - 结果摘要后返回主对话

  | 方式 | 系统提示词 | 任务 | 额外加载 |
  |------|-----------|------|---------|
  | Skill with `context: fork` | 来自 agent 类型 | SKILL.md 内容 | CLAUDE.md |
  | Subagent with `skills` field | 子代理的 markdown body | Claude 的委托消息 | 预加载的 skills + CLAUDE.md |

  ### 8. 上下文字符预算

  - Skill 描述加载到上下文，让 Claude 知道有哪些可用
  - 预算动态缩放：上下文窗口的 2%，最小 16,000 字符
  - 运行 `/context` 检查是否有 skill 被排除
  - 可通过 `SLASH_COMMAND_TOOL_CHAR_BUDGET` 环境变量覆盖

- **KodaX 当前实现分析**:

  ### 1. 目录结构

  **当前实现** (`packages/repl/src/skills/discovery.ts`):
  ```typescript
  // KodaX uses .kodax/skills/ directory
  const skillDirNames = ['.kodax/skills'];
  ```

  **目录结构** (优先级: enterprise > user > project > plugin > builtin):
  - `~/.kodax/skills/enterprise/` - Enterprise 级（全局）
  - `~/.kodax/skills/` - User 级（全局）
  - `.kodax/skills/` - Project 级（项目内）
  - `packages/repl/src/skills/builtin/` - 内置

  **已修复**: 原代码错误使用 `.kodox/`，现已统一为 `.kodax/`（与项目其他模块一致）。

  **设计说明**: KodaX 使用自己的 `.kodax/` 目录结构，与 Claude Code 的 `.claude/` 和 pi-mono 的 `.pi/` 类似但独立。这是正确的做法，重点是**功能能力**对齐，而非目录结构兼容。

  ### 2. Frontmatter 支持情况

  **已支持的字段** (`packages/repl/src/skills/types.ts`):
  ```typescript
  export interface SkillFrontmatter {
    name: string;                          // ✅
    description: string;                   // ✅
    disableModelInvocation?: boolean;      // ✅ 解析但未完全使用
    userInvocable?: boolean;               // ✅ 默认 true
    allowedTools?: string;                 // ✅ "Read, Grep, Bash(python:*)"
    context?: 'fork';                      // ✅ 占位符
    agent?: string;                        // ✅ 占位符
    argumentHint?: string;                 // ✅
    model?: 'haiku' | 'sonnet' | 'opus';   // ✅
  }
  ```

  **YAML 解析** (kebab-case → camelCase):
  ```typescript
  disableModelInvocation: parsed['disable-model-invocation'] === true,
  userInvocable: parsed['user-invocable'] !== false,
  allowedTools: parsed['allowed-tools'] as string | undefined,
  ```

  ### 3. 参数传递实现

  **已实现** (`packages/repl/src/skills/skill-resolver.ts`):
  - ✅ `$ARGUMENTS` - 所有参数
  - ✅ `$0`, `$1`, `$2` - 位置参数
  - ✅ `${VAR_NAME}` - 环境变量（含 `${CLAUDE_SESSION_ID}`）
  - ✅ `!`command`` - 动态上下文（shell 命令执行）

  ```typescript
  // 位置参数解析
  private resolvePositionalArgs(content: string, args: string[]): string {
    return content.replace(/\$(\d+)(?![a-zA-Z0-9_])/g, (match, indexStr) => {
      const index = parseInt(indexStr, 10);
      return args[index] ?? '';
    });
  }
  ```

  ### 4. 当前核心问题

  **`packages/repl/src/interactive/commands.ts` (第 811-854 行)**:
  ```typescript
  async function executeSkillCommand(parsed, context) {
    const fullSkill = await registry.loadFull(skillName);

    // 问题：只打印预览，不注入 LLM 上下文！
    console.log(chalk.bold(`--- ${skillName} skill ---`));
    console.log(chalk.dim(fullSkill.content.slice(0, 500))); // 只显示 500 字符
    console.log(chalk.bold(`\n--- end ${skillName} ---`));

    // 注释说 "将集成到 LLM loop"，但未实现
    console.log(chalk.dim('The skill prompt has been loaded. Continue your request to use it.'));
  }
  ```

  **系统提示词注入**:
  - `getSystemPromptSnippet()` 方法存在但未被调用
  - Skill 描述未注入系统提示词
  - Claude 无法知道有哪些 skills 可用

- **功能对比表格**:

  | 功能 | Claude Code 官方 | pi-mono | KodaX 当前 | 状态 |
  |------|-----------------|---------|-----------|------|
  | **目录结构** |
  | 专用目录 | `.claude/skills/` | `.pi/skills/` | `.kodax/skills/` | ✅ OK |
  | 优先级机制 | ✅ enterprise > personal > project | ✅ | ✅ | OK |
  | **Frontmatter** |
  | `name`/`description` | ✅ | ✅ | ✅ | OK |
  | `disable-model-invocation` | ✅ | ✅ | ⚠️ 解析但未使用 | 部分实现 |
  | `user-invocable` | ✅ | ✅ | ✅ | OK |
  | `allowed-tools` | ✅ | ❌ | ✅ 解析但未执行 | 部分实现 |
  | `context: fork` | ✅ | ❌ | ⚠️ 占位符 | 未实现 |
  | `agent` 字段 | ✅ | ❌ | ⚠️ 占位符 | 未实现 |
  | **参数传递** |
  | `$ARGUMENTS` | ✅ | ❌ | ✅ | OK |
  | `$0`/`$1`/`$N` | ✅ | ❌ | ✅ | OK |
  | `${SESSION_ID}` | ✅ | ❌ | ✅ | OK |
  | `!`command`` 动态上下文 | ✅ | ❌ | ✅ | OK |
  | **LLM 集成（核心问题）** |
  | 系统提示词注入 | ✅ 描述始终在上下文 | ✅ `<available_skills>` | ❌ 未调用 | **缺失** |
  | 命令展开 | ✅ 完整 XML 块 | ✅ `<skill>` XML | ❌ 只打印预览 | **缺失** |
  | 自然语言触发 | ✅ 基于 description | ❌ | ❌ | 缺失 |
  | **子代理** |
  | `context: fork` 执行 | ✅ | ❌ | ❌ | 未实现 |
  | agent 类型选择 | ✅ | ❌ | ❌ | 未实现 |

- **缺失功能清单**:

  ### ~~P0 - 关键阻塞（已修复）~~
  ~~1. **LLM 上下文注入** - skill 内容未发送给 LLM，只打印预览~~ ✅ 已修复 (2026-03-01)
  - 新增 `skill-expander.ts` 模块，将 skill 展开为 XML 格式
  - 修改 `executeSkillCommand` 返回展开后的 skill 内容
  - 修改 `InkREPL.handleSubmit` 检测 skill 内容并注入 LLM 上下文

  ~~2. **系统提示词集成** - `getSystemPromptSnippet()` 未被调用~~ ✅ P1 待实现

  ### ~~P0 - 已修复~~
  ~~3. **目录名称错误** - 代码使用 `.kodox/` 应为 `.kodax/`~~ ✅ 已修复 (2026-03-01)

  ### P1 - 用户体验问题
  4. **自然语言触发** - AI 无法基于 description 自动触发 skill，只能用 `/skill-name`
  5. **`disable-model-invocation` 生效** - ✅ 已在 executeSkillCommand 中检查

  ### P2 - 高级功能
  6. **`context: fork` 执行** - 子代理运行 skill（占位符存在但未实现）
  7. **`allowed-tools` 执行** - 限制 skill 可用工具（已解析但未执行）
  8. **上下文字符预算** - 管理 skill 描述的上下文占用

- **Impact**:
  - ✅ P0 已修复：Skills 现在可以正常工作
  - 用户调用 `/skill-name` 后，AI 会收到完整的 skill 内容并执行

- **Next Steps**:
  1. ✅ 完成 pi-mono 最佳实践调研
  2. ✅ 完成 Claude Code 官方规范调研
  3. ✅ 完成 KodaX 当前实现分析
  4. ✅ 实现 skill 命令展开（`expandSkillForLLM()`）
  5. ✅ 重构 `executeSkillCommand` - 将 skill 内容注入 LLM 上下文
  6. 🔄 实现系统提示词 skill 注入（调用 `getSystemPromptSnippet()`）
  7. 📋 添加自然语言 skill 触发（基于 description）
  8. 📋 实现 `context: fork` 子代理执行
  9. 📋 添加测试验证 skill 正确注入 LLM 上下文

---

### 055: Built-in Skills 未完全符合 Agent Skills 规范 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.4.7
- **Fixed**: -
- **Created**: 2026-03-01
- **Original Problem**:
  内建的 3 个 Agent Skills (`code-review`, `git-workflow`, `tdd`) 未完全符合 [Agent Skills 开放规范](https://agentskills.io/) 和 [Claude Code Skills 文档](https://code.claude.com/docs/en/skills)。

  **已发现的规范偏差**:

  ### 1. `allowed-tools` 格式偏差

  **Agent Skills 规范要求** (https://agentskills.io/specification):
  > Space-delimited list of pre-approved tools the skill may use.

  **示例**:
  ```yaml
  allowed-tools: Bash(git:*) Bash(jq:*) Read
  ```

  **KodaX 当前实现** (空格分隔但使用引号包裹):
  ```yaml
  allowed-tools: "Read, Grep, Glob, Bash(npm:*, node:*, npx:*)"
  ```

  **问题**:
  - 使用逗号分隔而非空格分隔
  - 使用引号包裹（可能影响解析兼容性）

  ### 2. `description` 语言问题

  **Agent Skills 规范建议** (https://agentskills.io/specification):
  > Should include specific keywords that help agents identify relevant tasks.

  **KodaX 当前实现** (仅中文):
  ```yaml
  # code-review
  description: 代码审查技能。当用户要求审查代码、code review、检查代码质量、review code 时使用。

  # git-workflow
  description: Git 工作流技能。当用户要求提交代码、创建 PR、合并分支、git commit、push、branch 管理时使用。

  # tdd
  description: TDD 测试驱动开发技能。当用户要求写测试、TDD、test-driven、单元测试、测试覆盖时使用。
  ```

  **问题**:
  - 描述主体为中文，非英语母语的 LLM 可能识别效率较低
  - 虽然包含了英文关键词（如 "code review", "TDD"），但主体描述为中文
  - 不利于跨平台/跨工具的 skill 互操作性

  **推荐格式** (符合规范的英文描述):
  ```yaml
  description: Performs comprehensive code review for quality, security, and best practices. Use when reviewing code, checking code quality, or when user mentions "review", "audit", or "code quality".
  ```

  ### 3. 其他规范符合性检查

  | 检查项 | 规范要求 | KodaX 实现 | 状态 |
  |--------|---------|-----------|------|
  | `name` 格式 | 小写字母、数字、连字符，1-64字符 | `code-review`, `git-workflow`, `tdd` | ✅ 符合 |
  | `name` 与目录匹配 | 必须匹配父目录名 | ✅ 匹配 | ✅ 符合 |
  | `description` 长度 | 1-1024 字符 | 均在限制内 | ✅ 符合 |
  | `description` 内容 | 描述功能和使用时机 | ✅ 包含关键词 | ⚠️ 部分符合（语言问题） |
  | `user-invocable` | Claude Code 扩展字段 | ✅ 正确使用 | ✅ 符合 |
  | `argument-hint` | Claude Code 扩展字段 | ✅ 正确使用 | ✅ 符合 |
  | `allowed-tools` 格式 | 空格分隔 | ❌ 逗号分隔+引号 | ❌ 不符合 |

- **Expected Behavior**:
  - `allowed-tools` 应改为空格分隔格式，不使用引号
  - `description` 应提供英文版本或双语版本以提高互操作性
  - 遵循 Agent Skills 开放规范确保 skill 可在不同 AI 工具间复用

- **Context**:
  - `packages/repl/src/skills/builtin/code-review/SKILL.md`
  - `packages/repl/src/skills/builtin/git-workflow/SKILL.md`
  - `packages/repl/src/skills/builtin/tdd/SKILL.md`

- **Impact**:
  - 低优先级：不影响核心功能，但影响规范兼容性和跨工具互操作性
  - 如果未来有其他工具采用 Agent Skills 规范，这些 skill 可能无法正确识别

- **Next Steps**:
  1. 修改 `allowed-tools` 为空格分隔格式
  2. 考虑将 `description` 改为英文或双语
  3. 可选择添加 `license` 字段（规范推荐）

---

### 056: Skills 系统缺少渐进式披露机制 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.8
- **Fixed**: v0.4.8
- **Created**: 2026-03-01
- **Original Problem**:
  KodaX 的 Skills 系统虽然已实现基本的 `/skill-name` 命令注入（Issue 054 P0），但缺少 pi-mono 和 Agent Skills 规范中的**渐进式披露**机制，导致 AI 无法主动发现和触发 skills。

  **核心问题**: `getSystemPromptSnippet()` 方法存在但**未被调用**，AI 不知道有哪些 skills 可用。

- **Reference Implementation (pi-mono)**:
  pi-mono 实现了完整的渐进式披露机制，源码位于 `C:\Works\GitWorks\pi-mono`：

  ### 1. 系统提示词注入 (关键缺失)

  **pi-mono 实现** (`packages/coding-agent/src/core/system-prompt.ts`):
  ```typescript
  // Append skills section (only if read tool is available)
  if (hasRead && skills.length > 0) {
      prompt += formatSkillsForPrompt(skills);
  }
  ```

  **pi-mono 的 XML 格式** (`packages/coding-agent/src/core/skills.ts`):
  ```typescript
  export function formatSkillsForPrompt(skills: Skill[]): string {
      const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
      if (visibleSkills.length === 0) return "";

      const lines = [
          "\n\nThe following skills provide specialized instructions for specific tasks.",
          "Use the read tool to load a skill's file when the task matches its description.",
          "",
          "<available_skills>",
      ];

      for (const skill of visibleSkills) {
          lines.push("  <skill>");
          lines.push(`    <name>${escapeXml(skill.name)}</name>`);
          lines.push(`    <description>${escapeXml(skill.description)}</description>`);
          lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
          lines.push("  </skill>");
      }

      lines.push("</available_skills>");
      return lines.join("\n");
  }
  ```

  **KodaX 当前实现** (`packages/repl/src/skills/skill-registry.ts`):
  ```typescript
  getSystemPromptSnippet(): string {
    const skills = this.list();
    // ... 使用简单 markdown 列表格式
    // 关键问题：此方法存在但未被调用！
  }
  ```

  ### 2. 自然语言触发机制

  **pi-mono 的设计**:
  1. 启动时将 skill 元数据（name, description, location）注入系统提示词
  2. AI 根据用户的自然语言描述判断是否应该使用某个 skill
  3. AI 使用 `read` 工具读取完整的 SKILL.md 文件
  4. AI 按照 skill 内容执行任务

  **官方文档说明**:
  > "Use the read tool to load a skill's file when the task matches its description."
  > 注：`models don't always do this; use prompting or /skill:name to force it`

  **KodaX 现状**: 由于系统提示词未注入 skill 列表，AI 完全不知道有哪些 skills 可用，自然语言触发无法工作。

  ### 3. Skill 块 UI 渲染

  **pi-mono 实现** (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`):
  ```typescript
  case "user": {
      const textContent = this.getUserMessageText(message);
      const skillBlock = parseSkillBlock(textContent);
      if (skillBlock) {
          // Render skill block (collapsible)
          const component = new SkillInvocationMessageComponent(skillBlock, ...);
          component.setExpanded(this.toolOutputExpanded);
          this.chatContainer.addChild(component);
          // Render user message separately if present
          if (skillBlock.userMessage) {
              const userComponent = new UserMessageComponent(skillBlock.userMessage, ...);
              this.chatContainer.addChild(userComponent);
          }
      }
  }
  ```

  **KodaX 现状**: 无专门的 skill 块渲染，skill 调用显示为普通消息。

  ### 4. `disableModelInvocation` 过滤

  **pi-mono**: 在 `formatSkillsForPrompt()` 中过滤掉 `disableModelInvocation=true` 的 skills，这些 skills 只能通过 `/skill:name` 显式调用。

  **KodaX**: `getSystemPromptSnippet()` 没有实现此过滤逻辑。

- **功能对比表**:

  | 功能 | pi-mono | KodaX | 说明 |
  |------|---------|-------|------|
  | **系统提示词注入** |
  | `formatSkillsForPrompt()` | ✅ 被调用 | ❌ `getSystemPromptSnippet()` 未调用 | **核心缺失** |
  | XML 格式 `<available_skills>` | ✅ 标准格式 | ❌ 使用 markdown 列表 | 格式不规范 |
  | `disableModelInvocation` 过滤 | ✅ | ❌ | 未实现过滤 |
  | **自然语言触发** |
  | AI 主动发现 skills | ✅ 通过系统提示词 | ❌ 无法工作 | 依赖系统提示词 |
  | 按 description 匹配 | ✅ | ❌ | - |
  | **UI 渲染** |
  | Skill 块折叠组件 | ✅ `SkillInvocationMessageComponent` | ❌ | 用户体验差距 |
  | 分离 skill 内容和用户消息 | ✅ | ❌ | - |
  | **命令展开** |
  | `/skill:name` 展开为 XML | ✅ | ✅ Issue 054 已修复 | OK |
  | `References are relative to` 提示 | ✅ | ✅ | OK |

- **Impact**:
  - **P1 - 用户体验问题**: 用户必须显式使用 `/skill-name` 命令，无法通过自然语言触发
  - AI 不知道有哪些 skills 可用，无法主动建议使用相关 skill
  - 不符合 Agent Skills 规范的渐进式披露设计
  - UI 体验不佳，skill 调用没有专门的视觉呈现

- **Context**:
  - `packages/repl/src/skills/skill-registry.ts` - `getSystemPromptSnippet()` 方法
  - `packages/repl/src/ui/InkREPL.tsx` - 系统提示词构建位置
  - `packages/core/src/agent.ts` - Agent 系统提示词组装

- **Reference**:
  - pi-mono 源码: `C:\Works\GitWorks\pi-mono\packages\coding-agent\src\core\skills.ts`
  - pi-mono 源码: `C:\Works\GitWorks\pi-mono\packages\coding-agent\src\core\system-prompt.ts`
  - pi-mono 源码: `C:\Works\GitWorks\pi-mono\packages\coding-agent\src\modes\interactive\components\skill-invocation-message.ts`
  - Agent Skills 规范: https://agentskills.io/integrate-skills

- **Next Steps**:
  1. **P1 - 系统提示词注入**: 在 Agent 系统提示词构建时调用 `getSystemPromptSnippet()`
  2. **P1 - XML 格式化**: 修改 `getSystemPromptSnippet()` 生成符合规范的 `<available_skills>` XML 格式
  3. **P1 - `disableModelInvocation` 过滤**: 在 `getSystemPromptSnippet()` 中过滤掉 `disableModelInvocation=true` 的 skills
  4. **P2 - UI 渲染**: 添加 Skill 块的专门渲染组件（可折叠显示）
  5. **P2 - `parseSkillBlock()`**: 实现解析用户消息中的 skill 块，用于 UI 渲染

- **Resolution** (2026-03-01):
  已实现核心的渐进式披露机制：

  ### 已修复
  1. **系统提示词注入** ✅
     - `packages/core/src/types.ts`: 添加 `skillsPrompt` 字段到 `KodaXContextOptions`
     - `packages/core/src/prompts/builder.ts`: 在系统提示词构建时追加 `skillsPrompt`
     - `packages/repl/src/ui/InkREPL.tsx`: 在 `runAgentRound` 中调用 `getSystemPromptSnippet()` 并传递给 agent

  2. **`disableModelInvocation` 过滤** ✅
     - `packages/repl/src/skills/types.ts`: 添加 `disableModelInvocation` 到 `SkillMetadata`
     - `packages/repl/src/skills/skill-loader.ts`: 加载 `disableModelInvocation` 元数据
     - `packages/repl/src/skills/skill-registry.ts`: 在 `getSystemPromptSnippet()` 中过滤掉 `disableModelInvocation=true` 的 skills

  ### 未实现 (P2，后续处理)
  - XML 格式化（当前使用 markdown 列表格式，功能等价）
  - Skill 块 UI 渲染组件
  - `parseSkillBlock()` 解析

---

### 057: Skill 命令格式不符合 pi-mono 设计规范 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.4.8
- **Fixed**: v0.4.8
- **Created**: 2026-03-01
- **Resolution Date**: 2026-03-01
- **Original Problem**:
  KodaX 的 Skill 命令设计沿用了传统 CLI 模式，不符合 pi-mono 的 **AI-first 极简设计**哲学。

  **当前 KodaX 设计**:
  ```
  /skills           → 显示 skill 列表
  /skills list      → 显示 skill 列表 (重复)
  /skills info <name> → 显示 skill 详情
  /skills reload    → 重新加载 skills
  /code-review      → 调用 skill
  ```

  **pi-mono 设计**:
  ```
  /skill            → 显示 skill 帮助/列表
  /skill:name       → 调用 skill (命名空间格式)
  自然语言           → "有哪些 skill？" / "code-review 是什么？"
  ```

- **Design Analysis**:

  ### 1. 命令格式对比

  | 功能 | KodaX (当前) | pi-mono | 问题 |
  |------|-------------|---------|------|
  | 列出 skills | `/skills`, `/skills list` | 自然语言或 `/skill` | 冗余命令 |
  | 查看详情 | `/skills info <name>` | 自然语言询问 AI | CLI 思维惯性 |
  | 调用 skill | `/skill-name` | `/skill:name` | 无命名空间分离 |
  | 重载 | `/skills reload` | 不需要 (按需读取) | 缓存设计问题 |

  ### 2. Tab Completion 体验

  **KodaX `/skill-name` 格式**:
  ```
  /          [Tab]
  → /help
  → /clear
  → /model
  → /code-review    ← 命令和 skill 混在一起
  → /tdd
  → /git-workflow
  ```

  **pi-mono `/skill:name` 格式**:
  ```
  /          [Tab]
  → /help
  → /clear
  → /model
  → /skill:         ← 命名空间入口

  /skill:    [Tab]
  → /skill:code-review
  → /skill:tdd
  → /skill:git-workflow
  ```

  **pi-mono 优势**:
  - 清晰的命名空间分离
  - 命令 vs Skill 一目了然
  - 更好的 tab 补全体验
  - 可扩展 (未来可有 `/agent:name`, `/tool:name`)

  ### 3. AI-first 设计哲学

  **KodaX 当前问题**:
  - `/skills info <name>` 是 CLI 思维 - 用户需要记忆命令语法
  - `/skills reload` 存在是因为缓存设计，不是用户需要

  **pi-mono 方式**:
  ```
  用户: code-review skill 是做什么的？
  AI:  [Read SKILL.md] → 回答
  ```
  - 无需记忆命令
  - AI 实时读取最新内容
  - 按需读取，无需 reload

- **Reference Implementation (pi-mono)**:
  源码位于 `C:\Works\GitWorks\pi-mono`

  **pi-mono Command 结构**:
  ```typescript
  // 内置命令 (系统功能)
  /help      - 帮助
  /clear     - 清屏
  /model     - 切换模型
  /compact   - 压缩上下文
  /exit      - 退出

  // Skill 调用 (用户扩展)
  /skill:name [args...]

  // 自然语言
  其他所有输入 → AI 处理
  ```

- **Implementation Plan**:

  ### Phase 1: 添加 `/skill:` 命名空间格式 (Non-breaking)

  **目标**: 新增 `/skill:` 格式，保留旧格式兼容

  **改动文件**:
  1. `packages/repl/src/interactive/commands.ts`
     - 添加 `/skill` 命令入口 (显示帮助)
     - 添加 `/skill:name` 格式解析
     - 保持 `/skill-name` 格式兼容

  2. `packages/repl/src/ui/InkREPL.tsx`
     - 更新 tab 补全逻辑支持 `/skill:` 前缀

  **代码示例**:
  ```typescript
  // 新增 /skill 命令
  registerCommand({
    name: 'skill',
    description: 'Skill namespace - use /skill:name to invoke',
    handler: (args) => {
      if (!args) {
        // /skill -> 显示 skill 列表
        return showSkillList();
      }
      // /skill:name -> 调用 skill
      return invokeSkill(args);
    }
  });
  ```

  ### Phase 2: 移除冗余命令 (Breaking Change)

  **目标**: 移除 CLI 风格命令，改用 AI-first 方式

  **移除**:
  - `/skills list` → 用自然语言替代
  - `/skills info <name>` → 用自然语言替代
  - `/skills reload` → 改为按需读取设计

  **保留**:
  - `/skills` 或 `/skill` 作为快速查看快捷方式 (可选)

  ### Phase 3: 按需读取重构

  **目标**: 移除缓存，AI 每次调用时读取最新 SKILL.md

  **改动文件**:
  1. `packages/repl/src/skills/skill-registry.ts`
     - 移除 skill 内容缓存
     - `loadFullSkill()` 每次从文件读取

  **注意**: 需要评估性能影响

- **Risk Analysis**:

  | 风险 | 影响 | 缓解措施 |
  |------|------|---------|
  | Breaking Change | 用户习惯改变 | Phase 1 保持兼容，渐进迁移 |
  | Tab 补全冲突 | 补全逻辑复杂化 | 优先显示 `/skill:` 格式 |
  | 性能下降 (按需读取) | 每次调用读文件 | SSD 下影响可忽略，可加 LRU 缓存 |
  | 文档需要更新 | 用户困惑 | 更新 README 和帮助文档 |

- **Migration Strategy**:

  1. **v0.4.8**: Phase 1 - 添加新格式，保持兼容
     - 用户可以开始使用 `/skill:name` 格式
     - 旧格式 `/skill-name` 仍然工作
     - 添加 deprecation 警告

  2. **v0.5.0**: Phase 2 - 移除冗余命令
     - 移除 `/skills info`, `/skills list`
     - 保留 `/skill` 作为列表快捷方式

  3. **v0.6.0**: Phase 3 - 完全切换到新格式
     - `/skill-name` 格式标记为 deprecated
     - 主推 `/skill:name` 格式

- **Context**:
  - `packages/repl/src/interactive/commands.ts` - 命令注册和处理
  - `packages/repl/src/ui/InkREPL.tsx` - Tab 补全逻辑
  - `packages/repl/src/skills/skill-registry.ts` - Skill 加载和缓存

- **Reference**:
  - pi-mono 源码: `C:\Works\GitWorks\pi-mono\packages\coding-agent\src\modes\interactive\commands.ts`
  - Agent Skills 规范: https://agentskills.io/

- **Resolution**:
  按照 pi-mono 设计规范完成所有 3 个阶段的实现:

  **Phase 1**: 添加 `/skill:` 命名空间格式
  - 新增 `/skill` 命令 (显示 skills 列表)
  - 新增 `/skill:name` 格式解析和调用
  - 添加 `printSkillsListPiMonoStyle()` 函数

  **Phase 2**: 移除冗余命令
  - `/skills` 标记为 deprecated，重定向到 `/skill`
  - 移除 `/skills info`, `/skills list` 等子命令
  - 移除 `handleSkillsCommand()`, `printSkillInfo()`, `printSkillsList()` 函数

  **Phase 3**: 移除旧格式
  - 移除 `/skill-name` 格式支持
  - 更新系统提示词中的 skill 格式为 `/skill:name`
  - 更新代码注释

  **最终命令格式**:
  ```
  /skill              → 显示所有可用 skills
  /skill:name [args]  → 调用指定 skill
  自然语言             → AI 自动发现和使用 skills
  ```

- **Files Changed**:
  - `packages/repl/src/interactive/commands.ts` - 命令处理
  - `packages/repl/src/skills/types.ts` - 注释更新
  - `packages/repl/src/skills/skill-registry.ts` - 系统提示词格式

---

### 058: Windows Terminal 流式输出闪烁和滚动问题 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.4.8
- **Created**: 2026-03-01
- **Last Updated**: 2026-03-02
- **Affected Platforms**: Windows Terminal (主要), 其他终端可能轻微受影响

- **Failed Implementation Attempt** (2026-03-02):
  尝试实现 Alternate Buffer 模式，但出现以下问题：
  - 闪烁问题未解决，反而更严重
  - 流式输出时无法滚动
  - 进入时清空整个终端历史
  - 退出时只保留 KodaX 会话内容，原终端历史丢失

  **结论**: 手动实现 Alternate Buffer (`\x1B[?1049h/l`) 与 Ink 5.x 渲染机制冲突，
  需要更深入的研究或考虑其他方案。

- **Original Problem**:
  在 Windows Terminal 中，流式输出期间出现两个相关问题：
  1. **闪烁问题**: 屏幕频繁闪烁，影响用户体验
  2. **滚动问题**: 流式输出时用鼠标滚轮向上滚动后，无法用滚轮向下滚动（但拖动滚动条可以）

- **Root Cause Analysis**:

  ### 原因 1: 历史消息未使用 `Static` 组件 (核心问题)

  **当前代码** (`MessageList.tsx:437-438`):
  ```tsx
  {filteredItems.map((item) => (
    <HistoryItemRenderer key={item.id} item={item} theme={theme} maxLines={maxLines} />
  ))}
  ```

  **问题**: 每次流式内容更新时，所有历史消息都会重新渲染，导致全屏重绘。

  **对比**: Banner 正确使用了 `Static` (`InkREPL.tsx:859-868`):
  ```tsx
  <Static items={[1]}>
    {() => <Banner ... />}
  </Static>
  ```

  ### 原因 2: 独立定时器导致相位差

  **当前代码使用两个独立的定时器**:

  - Spinner 动画 (`LoadingIndicator.tsx:82-84`):
    ```tsx
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    ```

  - 流式内容刷新 (`StreamingContext.tsx:207`):
    ```tsx
    const FLUSH_INTERVAL = 80;
    flushTimer = setTimeout(flushPendingUpdates, FLUSH_INTERVAL);
    ```

  **问题**: 虽然间隔相同（80ms），但是**独立定时器**，起始时间不同，产生相位差：

  ```
  时间轴示例:
  0ms:   Spinner 帧 1 渲染
  15ms:  流式内容更新 → 触发渲染 (相位差)
  80ms:  Spinner 帧 2 渲染
  95ms:  流式内容更新 → 触发渲染
  ...
  ```

  相位差会导致某些时刻产生**两次连续渲染**，增加闪烁概率。

  ### 原因 3: Windows Terminal 的 GPU 渲染特性

  Windows Terminal 使用 DirectWrite/GPU 加速渲染，对频繁的全屏重绘更敏感，放大了闪烁效应。

  ### 渲染频率分析

  **当前状态** (存在相位差):
  ```
  理想情况: 每秒 ~12.5 次渲染 (同频率同步)
  实际情况: 每秒 ~15-20 次渲染 (相位差导致额外渲染)
  ```

  **优化后** (统一定时器 + Static):
  ```
  每秒 ~12.5 次局部重渲染 (只有流式内容参与)
  ```

- **Proposed Solution**:

  ### 方案 A: 使用 Static 包裹历史消息 ⭐ (核心方案)

  **优先级**: 高 | **效果**: 显著

  **改动文件**: `packages/repl/src/ui/components/MessageList.tsx`

  **改动内容**:
  ```tsx
  import { Static } from "ink";

  // 在 MessageList 组件中
  // 将已完成的历史消息用 Static 包裹
  <Static items={filteredItems}>
    {(item) => <HistoryItemRenderer item={item} theme={theme} maxLines={maxLines} />}
  </Static>

  // 流式内容保持动态渲染（不使用 Static）
  {streamingResponse && (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.secondary} bold>Assistant</Text>
      <Box marginLeft={2} flexDirection="column">
        {streamingResponse.split("\n").map((line, index) => (
          <Text key={index} color={theme.colors.text}>{line || " "}</Text>
        ))}
      </Box>
    </Box>
  )}
  ```

  **原理**: Ink 的 `Static` 组件将内容写入终端后不再参与后续渲染周期，新内容追加到 Static 内容下方。

  **预期效果**:
  - ✅ 历史消息只渲染一次
  - ✅ 只有流式内容参与动态渲染
  - ✅ 减少 50-80% 的渲染量
  - ✅ 同时改善闪烁和滚动问题

  ### 方案 D: 统一定时器 ⭐ (推荐)

  **优先级**: 高 | **效果**: 显著

  **目标**: 将 Spinner 动画和流式内容刷新使用同一个定时器驱动，消除相位差。

  **改动思路**:
  1. StreamingContext 在 flush 时同时触发 Spinner 帧更新
  2. 或者使用共享的 tick 信号驱动两个更新

  **改动文件**:
  - `packages/repl/src/ui/contexts/StreamingContext.tsx`
  - `packages/repl/src/ui/components/LoadingIndicator.tsx`

  **改动内容**:
  ```tsx
  // StreamingContext 添加 tick 回调
  interface StreamingManager {
    // ... 现有方法
    onTick: (callback: () => void) => () => void;  // 新增：订阅 flush 事件
  }

  // Spinner 组件使用外部 tick
  export const Spinner: React.FC<SpinnerProps & { externalTick?: boolean }> = ({
    color,
    theme,
    externalTick
  }) => {
    const [frame, setFrame] = useState(0);

    // 如果使用外部 tick，不创建自己的定时器
    // 由 StreamingContext 的 flush 事件驱动
    if (externalTick) {
      useStreamingTick(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length));
    } else {
      // 原有逻辑作为 fallback
      useEffect(() => {
        const timer = setInterval(() => {
          setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
        }, 80);
        return () => clearInterval(timer);
      }, []);
    }
    // ...
  };
  ```

  **预期效果**:
  - ✅ 消除相位差导致的额外渲染
  - ✅ Spinner 动画与流式内容完美同步
  - ✅ 稳定的每秒 12.5 次渲染

  ### 方案 B: 智能 Spinner 控制 (效果有限)

  **优先级**: 低 | **效果**: 轻微

  **说明**: 如果已实施方案 D（统一定时器），此方案帮助有限，因为渲染频率不会改变。

  **适用场景**: 如果不实施方案 D，可以在有流式内容时移除 Spinner 动画，减少每帧渲染的组件数量。

  ### 方案 C: 调整缓冲间隔 (可选)

  **优先级**: 低 | **效果**: 中等

  **改动文件**: `packages/repl/src/ui/contexts/StreamingContext.tsx`

  **改动内容**:
  ```tsx
  const FLUSH_INTERVAL = 100; // 原值 80
  ```

  **预期效果**: 减少渲染频率，但可能略微影响感知响应速度。

- **Solution Priority**:

  | 顺序 | 方案 | 优先级 | 效果 | 改动量 |
  |------|------|--------|------|--------|
  | 1 | A: Static 包裹历史消息 | 高 | 显著 | 中 |
  | 2 | D: 统一定时器 | 高 | 显著 | 中 |
  | 3 | C: 调整缓冲间隔 | 低 | 中等 | 小 |
  | 4 | B: 智能 Spinner 控制 | 低 | 轻微 | 小 |

  **推荐实施顺序**: A → D → (可选) C

- **Risk Analysis**:

  | 风险 | 可能性 | 影响 | 缓解措施 |
  |------|--------|------|----------|
  | Static 组件滚动行为变化 | 中 | 低 | 测试多场景滚动 |
  | 消息更新不反映到 Static | 低 | 中 | 只对"已完成"消息用 Static |
  | 某些终端 Static 兼容性 | 低 | 低 | 测试主流终端 |
  | 统一定时器复杂度增加 | 中 | 低 | 保持 fallback 机制 |

- **Verification Checklist**:
  - [ ] Windows Terminal 闪烁明显减少
  - [ ] 滚动行为正常（上下滚动都可）
  - [ ] 流式输出等待首个 token 时 Spinner 正常显示
  - [ ] Spinner 动画与流式内容同步（无相位差）
  - [ ] 历史消息只渲染一次（可用 console.log 验证）
  - [ ] 其他终端 (macOS Terminal, iTerm2, VSCode Terminal) 兼容

- **Context**:
  - `packages/repl/src/ui/components/MessageList.tsx` - 消息列表渲染
  - `packages/repl/src/ui/InkREPL.tsx` - 主 REPL 组件
  - `packages/repl/src/ui/contexts/StreamingContext.tsx` - 流式输出管理
  - `packages/repl/src/ui/components/LoadingIndicator.tsx` - Spinner 组件

---

### 059: Skills 延迟加载导致首次调用失败 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.4.8
- **Fixed**: v0.4.8
- **Created**: 2026-03-01
- **Resolution Date**: 2026-03-01

- **Original Problem**:
  在 REPL 启动后，首次调用 `/skill:xxx` 命令时显示 "Skill not found"，但先执行 `/skill` 列出 skills 后，再调用 `/skill:xxx` 就能正常工作。

  **复现步骤**:
  ```
  1. 启动 KodaX REPL
  2. 直接输入 /skill:code-review packages/core/src/agent.ts
  3. 显示: [Skill not found: code-review]
  4. 输入 /skill
  5. 显示: Available Skills (列出 3 个 skills)
  6. 再次输入 /skill:code-review packages/core/src/agent.ts
  7. 显示: [Invoking skill: code-review] ✓ 正常工作
  ```

- **Root Cause Analysis**:

  Skills 的加载是延迟的（lazy loading），只有在执行 `/skill` 命令（列出 skills）时才触发 `getSkillRegistry()` 的初始化。

  **问题代码位置**:
  - `packages/repl/src/interactive/commands.ts` - `/skill` 和 `/skill:name` 命令处理

  **可能的实现问题**:
  1. `getSkillRegistry()` 是单例，但首次调用才初始化
  2. `/skill:name` 调用时 registry 可能未初始化
  3. `/skill` 命令触发了 registry 初始化，所以后续调用正常

- **Proposed Solution**:

  ### 方案 A: REPL 启动时预加载 Skills

  **改动文件**: `packages/repl/src/ui/InkREPL.tsx`

  **改动内容**:
  ```tsx
  // 在 InkREPL 组件初始化时预加载 skills
  useEffect(() => {
    // 预加载 skill registry，确保 skills 在首次调用前已就绪
    getSkillRegistry();
  }, []);
  ```

  **预期效果**:
  - ✅ REPL 启动时即加载 skills
  - ✅ 首次调用 `/skill:xxx` 正常工作
  - ⚠️ 启动时间可能略微增加（可接受）

  ### 方案 B: 在 `/skill:name` 调用中确保 registry 已初始化

  **改动文件**: `packages/repl/src/interactive/commands.ts`

  **改动内容**:
  ```tsx
  // 在 executeSkillCommand 中确保 registry 已初始化
  async function executeSkillCommand(...) {
    // 确保 registry 已初始化
    const registry = getSkillRegistry();
    await registry.ensureLoaded();  // 新增：确保加载完成

    const skill = registry.getSkill(skillName);
    // ...
  }
  ```

  **预期效果**:
  - ✅ 无需改变启动流程
  - ✅ 按需加载
  - ⚠️ 需要确保 `ensureLoaded()` 方法存在或添加

- **Recommended Solution**: 方案 A（预加载）

  **理由**:
  - 实现简单，改动小
  - Skills 数量有限，加载开销可忽略
  - 避免"首次调用失败"的糟糕用户体验

- **Resolution**:
  采用方案 A，在 `InkREPL.tsx` 组件挂载时预加载 skills：

  ```tsx
  // Preload skills on mount to ensure they're available for first /skill:xxx call
  // Issue 059: Skills lazy loading caused first skill invocation to fail
  useEffect(() => {
    getSkillRegistry();
  }, []);
  ```

- **Files Changed**:
  - `packages/repl/src/ui/InkREPL.tsx` - 添加 skills 预加载

- **Verification Checklist**:
  - [x] REPL 启动后直接调用 `/skill:xxx` 正常工作
  - [x] `/skill` 命令仍然正常显示列表
  - [x] 启动时间无明显增加（< 100ms）

- **Context**:
  - `packages/repl/src/ui/InkREPL.tsx` - REPL 主组件
  - `packages/repl/src/interactive/commands.ts` - 命令处理
  - `packages/repl/src/skills/skill-registry.ts` - Skill 加载逻辑

---

### 060: UI 更新定时器未统一，存在相位差 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.4.5
- **Created**: 2026-03-02
- **Related**: Issue 047, Issue 048, Issue 058

- **Original Problem**:
  KodaX 的 UI 输出更新由多个独立的定时器驱动，虽然 Issue 047/048 通过批量更新缓解了闪烁问题，但根本问题未解决：
  - 多个独立定时器存在**相位差**（phase difference）
  - 极端情况下仍可能导致渲染帧不一致
  - 终端全视口重绘时内容可能错位

- **Root Cause Analysis**:

  ### 当前定时器架构（4 个独立定时器）

  | 组件 | 定时器类型 | 间隔 | 文件位置 | 用途 |
  |------|-----------|------|----------|------|
  | StreamingContext | `setTimeout` 递归 | 80ms | `StreamingContext.tsx:243` | 流式文本批量更新 |
  | Spinner | `setInterval` | 80ms | `LoadingIndicator.tsx:82` | 动画帧切换 |
  | DotsIndicator | `setInterval` | 300ms | `LoadingIndicator.tsx:108` | 跳动点动画 |
  | CLI Spinner | `setInterval` | 80ms | `cli-events.ts:41` | CLI 模式 spinner |

  ### 问题详解

  ```typescript
  // 1. StreamingContext - 递归 setTimeout
  flushTimer = setTimeout(flushPendingUpdates, FLUSH_INTERVAL);
  // 执行完成后才开始下一个计时，可能累积延迟

  // 2. Spinner - 固定 setInterval
  const timer = setInterval(() => {
    setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
  }, 80);
  // 严格固定间隔，不受执行时间影响
  ```

  **相位差影响**：
  - 两个定时器起始时间不同
  - setTimeout 递归会累积微小延迟（每帧执行时间）
  - 极端情况下可能在同一帧内触发多次状态更新
  - 终端全视口重绘时可能导致内容错位

  ### 终端渲染特性

  终端没有 DOM diff，每次状态变化触发全视口重绘。当多个定时器异步更新时：
  1. Ink reconciler 计算差异
  2. 生成 ANSI 序列
  3. 写入 stdout
  4. 终端重绘

  如果在第 3-4 步之间有新的状态更新，就会产生视觉不一致。

- **Proposed Solution**:

  ### 方案 A: 统一 Tick Context（推荐）

  **设计思路**: 创建一个全局的 `TickContext`，所有 UI 更新都订阅同一个 tick 信号。

  **新建文件**: `packages/repl/src/ui/contexts/TickContext.tsx`

  ```typescript
  import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

  const TICK_INTERVAL = 80; // 统一 80ms 刷新周期

  interface TickContextValue {
    tick: number;           // 当前 tick 计数
    subscribe: (callback: () => void) => () => void;
  }

  const TickContext = createContext<TickContextValue | null>(null);

  export function TickProvider({ children }: { children: React.ReactNode }) {
    const [tick, setTick] = useState(0);
    const subscribers = useRef<Set<() => void>>(new Set());

    useEffect(() => {
      const timer = setInterval(() => {
        setTick(t => t + 1);
        subscribers.current.forEach(cb => cb());
      }, TICK_INTERVAL);
      return () => clearInterval(timer);
    }, []);

    const subscribe = useCallback((callback: () => void) => {
      subscribers.current.add(callback);
      return () => subscribers.current.delete(callback);
    }, []);

    return (
      <TickContext.Provider value={{ tick, subscribe }}>
        {children}
      </TickContext.Provider>
    );
  }

  export function useTick() {
    const ctx = useContext(TickContext);
    if (!ctx) throw new Error('useTick must be used within TickProvider');
    return ctx.tick;
  }
  ```

  **改造 StreamingContext**:
  ```typescript
  // 不再使用 setTimeout，而是订阅 tick
  const { subscribe } = useTickContext();

  useEffect(() => {
    return subscribe(() => {
      if (pendingResponseText || pendingThinkingText) {
        flushPendingUpdates();
      }
    });
  }, [subscribe]);
  ```

  **改造 LoadingIndicator (Spinner)**:
  ```typescript
  // 不再使用 setInterval，而是使用 tick
  const tick = useTick();
  const frame = tick % SPINNER_FRAMES.length;
  const spinnerFrame = SPINNER_FRAMES[frame];
  ```

  **优点**:
  - ✅ 绝对同步，无相位差
  - ✅ 单一定时器，性能更好
  - ✅ 易于调试（统一的更新周期）
  - ✅ 支持不同订阅频率（基于 tick 计数）

  **缺点**:
  - ⚠️ 改动较大，需要修改多个组件
  - ⚠️ 需要确保 TickProvider 在组件树顶层

  ### 方案 B: 共享定时器引用

  **设计思路**: 保持现有架构，但共享同一个 setInterval 引用。

  ```typescript
  // shared-timer.ts
  let sharedTimer: ReturnType<typeof setInterval> | null = null;
  const callbacks = new Set<() => void>();

  export function startSharedTimer() {
    if (!sharedTimer) {
      sharedTimer = setInterval(() => {
        callbacks.forEach(cb => cb());
      }, 80);
    }
  }

  export function subscribeToTimer(cb: () => void) {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
  }
  ```

  **优点**:
  - ✅ 改动较小
  - ✅ 向后兼容

  **缺点**:
  - ⚠️ 非响应式，需要手动管理订阅
  - ⚠️ 不如 React Context 方案优雅

- **Recommended Solution**: 方案 A（统一 Tick Context）

  **理由**:
  - 符合 React 范式
  - 更易于测试和调试
  - 支持未来扩展（如可变刷新率）

- **Implementation Steps**:

  1. **Phase 1: 创建 TickContext**
     - 新建 `TickContext.tsx`
     - 在 `App.tsx` 中包裹 `TickProvider`

  2. **Phase 2: 改造 StreamingContext**
     - 移除 setTimeout 逻辑
     - 使用 `subscribe` 订阅 tick

  3. **Phase 3: 改造 LoadingIndicator**
     - Spinner: 移除 setInterval，使用 `useTick()`
     - Dots: 使用 `tick % 4 === 0` 实现 300ms 效果

  4. **Phase 4: 验证**
     - 测试流式输出无闪烁
     - 测试 Spinner 动画流畅
     - 测试 Windows Terminal 兼容性

- **Files to Change**:
  - `packages/repl/src/ui/contexts/TickContext.tsx` (新建)
  - `packages/repl/src/ui/contexts/StreamingContext.tsx` (修改)
  - `packages/repl/src/ui/components/LoadingIndicator.tsx` (修改)
  - `packages/repl/src/ui/App.tsx` (添加 TickProvider)
  - `packages/repl/src/ui/cli-events.ts` (可选，CLI 模式)

- **Risk Assessment**:
  | 风险 | 影响 | 缓解措施 |
  |------|------|----------|
  | TickProvider 未包裹 | 运行时错误 | 启动时检查 context |
  | 性能退化 | 低 | 单一定时器应更快 |
  | Dots 动画变快 | 中 | 使用 tick 计数实现 300ms |

---

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
