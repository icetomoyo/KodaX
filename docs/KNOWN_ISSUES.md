# Known Issues

_Last Updated: 2026-03-12_

---

> **Archive Notice**: 35 issues archived to `ISSUES_ARCHIVED.md` (31 resolved + 1 on 2026-03-11 + 3 Won't Fix on 2026-03-11).
> For historical issue records, please see `docs/ISSUES_ARCHIVED.md`.

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 086 | High | Resolved | 自动补全竞态条件导致快速输入时显示过期补全 | v0.5.32 | v0.5.32 | 2026-03-12 | 2026-03-12 |
| 085 | Medium | Resolved | 只读 Bash 命令白名单未在非 plan 模式复用 | v0.5.29 | v0.5.30 | 2026-03-12 | 2026-03-12 |
| 084 | High | Resolved | 流式响应长时间静默中断无任何提示 | v0.5.29 | v0.5.30 | 2026-03-12 | 2026-03-12 |
| 013 | Low | Open | 自动补全缓存内存泄漏风险 | v0.3.1 | - | 2026-02-19 | - |
| 014 | Low | Open | 语法高亮语言支持不全 | v0.3.1 | - | 2026-02-19 | - |
| 015 | Low | Open | Unicode 检测不完整 | v0.3.1 | - | 2026-02-19 | - |
| 017 | Low | Open | TextBuffer 未使用方法 | v0.3.1 | - | 2026-02-19 | - |
| 018 | Low | Open | TODO 注释未清理 | v0.3.1 | - | 2026-02-19 | - |
| 055 | Low | Open | Built-in Skills 未完全符合 Agent Skills 规范 | v0.4.7 | - | 2026-03-01 | - |
| 061 | Low | Open | Windows Terminal 流式输出时滚轮滚动异常 | v0.4.5 | - | 2026-03-02 | - |
| 077 | Low | Open | Skills 系统高级功能未完全实现 | v0.5.5 | - | 2026-03-04 | - |
| 082 | Low | Open | packages/ai 缺少单元测试 | v0.5.21 | - | 2026-03-08 | - |
| 083 | Medium | Resolved | 缺少快捷键系统 | v0.5.29 | v0.5.30 | 2026-03-11 | 2026-03-12 |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->
---

### 086: 自动补全竞态条件导致快速输入时显示过期补全 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.5.32
- **Fixed**: v0.5.32
- **Created**: 2026-03-12
- **Resolution Date**: 2026-03-12

- **Original Problem**:
  使用补全功能时，输入 `/model zhipu-coding` 后，补全列表会停留在 `zhipu` 这个推荐上，按回车会直接变成命令 `/model zhipu`。

  **预期行为**：当用户快速输入时，补全列表应该立即更新为最新输入的补全结果，不应该显示过期的补全选项。

- **Root Cause Analysis**:

  **问题不在前缀匹配逻辑，而在异步竞态条件**

  经过详细测试分析，发现 `fuzzy.ts` 中的匹配逻辑实际上是**正确的**：
  - `prefixMatch("zhipu-coding", "zhipu")` → `false` ✅
  - `fuzzyMatch("zhipu-coding", "zhipu")` → `{ matched: false }` ✅
  - `ArgumentCompleter` 的过滤逻辑也正确

  **真正的问题**：`AutocompleteProvider` 中的异步竞态条件

  在 `packages/repl/src/interactive/autocomplete-provider.ts` 的 `fetchCompletions()` 方法中：

  ```typescript
  private fetchCompletions(input: string, cursorPos: number): void {
    this.updateState({ loading: true });

    this.fetchCompletionsInternal(input, cursorPos)
      .then((completions) => {
        // ❌ 问题：没有检查 input 是否已经改变
        if (completions.length > 0) {
          this.updateState({ ... });
        }
      });
  }
  ```

  **竞态条件流程**：
  1. 用户输入 `/model zhipu` → 触发异步补全请求 #1
  2. 用户快速输入 `-coding` → `lastInput` 更新为 `/model zhipu-coding`
  3. 补全请求 #1 完成 → 更新状态为 `['zhipu', 'zhipu-coding']` (基于旧输入)
  4. 补全请求 #2 完成 → 更新状态为 `['zhipu-coding']` (基于新输入)

  如果用户在步骤3按回车，就会错误地选择 `zhipu` 而不是继续输入的 `zhipu-coding`。

- **Reproduction**:
  1. 输入 `/model zhipu` → 看到补全列表 `['zhipu', 'zhipu-coding']`
  2. 快速输入 `-coding` → 短暂看到旧的补全列表 `['zhipu', 'zhipu-coding']`
  3. 立即按回车 → 选择 `zhipu` 而不是 `zhipu-coding`

- **Resolution**:

  在 `fetchCompletions()` 的 Promise 回调中添加**输入版本检查**：

  ```typescript
  private fetchCompletions(input: string, cursorPos: number): void {
    this.updateState({ loading: true });

    this.fetchCompletionsInternal(input, cursorPos)
      .then((completions) => {
        // CRITICAL: Check if input has changed since we started fetching
        // This prevents race conditions where stale completions overwrite newer ones
        if (this.lastInput !== input || this.lastCursorPos !== cursorPos) {
          // Input changed, discard these completions
          return;
        }

        if (completions.length > 0) {
          this.updateState({
            visible: true,
            completions: completions.slice(0, this.options.maxCompletions),
            selectedIndex: 0,
            loading: false,
          });
        } else {
          this.updateState({
            visible: false,
            completions: [],
            selectedIndex: 0,
            loading: false,
          });
        }
      })
      .catch(() => {
        this.updateState({ loading: false });
      });
  }
  ```

  **修复原理**：
  - 在请求开始时记录当前的 `input` 和 `cursorPos`
  - 在 Promise 完成时检查 `this.lastInput` 和 `this.lastCursorPos` 是否还匹配
  - 如果不匹配，说明用户已经继续输入，丢弃这些过期的补全结果
  - 这样可以确保只有最新的补全结果才会更新状态

- **Files Changed**:
  - `packages/repl/src/interactive/autocomplete-provider.ts` (line 320-344)

- **Tests Added**:
  - 验证测试：快速输入场景，确保最终只显示正确的补全结果
  - 现有测试：所有 71 个测试通过，无回归

- **Verification**:
  ```bash
  npm test --workspace=packages/repl
  # 71 tests passed
  ```

---

### 085: 只读 Bash 命令白名单未在非 plan 模式复用
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.5.29
- **Fixed**: v0.5.30
- **Created**: 2026-03-12
- **Resolved**: 2026-03-12

- **Original Problem**:
  `git diff`、`git status` 等只读 Bash 命令在 `default`、`accept-edits`、`auto-in-project` 模式下仍需要用户确认，而在 `plan` 模式下可以自动放行。

  根因分析：
  ```typescript
  // InkREPL.tsx:706-711 (修复前)
  if (mode === 'plan' && tool === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommand(command)) {
      return true; // 只在 plan 模式生效！
    }
  }
  ```

  `isBashReadCommand()` 白名单检查只在 `mode === 'plan'` 条件下执行，其他模式没有复用这个逻辑。

- **Solution Implemented**:
  1. 将 `isBashReadCommand()` 检查逻辑从 `if (mode === 'plan')` 条件中提取出来，使其在所有模式下都生效
  2. 将只读命令检查移到**受保护路径检查之前**，这样项目目录外的只读命令也能自动放行

  ```typescript
  // 修复后的逻辑顺序
  // 1. Safe read-only bash commands: auto-allowed BEFORE protected path check
  if (tool === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommand(command)) {
      return true; // 所有模式都自动放行只读命令（含项目目录外）
    }
  }

  // 2. Protected paths check (only affects non-whitelisted commands now)
  // 受保护路径检查现在只影响非白名单命令
  ```

- **Fixed Behavior by Mode**:

  | Mode | `git diff` 等只读命令 | 写命令 |
  |------|----------------------|--------|
  | `plan` | ✅ 自动放行（含项目外） | ❌ 阻止 |
  | `default` | ✅ 自动放行（含项目外） | ⚠️ 需要确认 |
  | `accept-edits` | ✅ 自动放行（含项目外） | ⚠️ 需要确认 |
  | `auto-in-project` | ✅ 自动放行（含项目外） | ✅ 自动放行（项目内） |

  **Note**: Safe read-only commands are auto-allowed BEFORE protected path check, meaning they work even for paths outside the project directory (e.g., `cat /etc/hosts`, `ls /tmp`).
  **注意**：安全的只读命令在受保护路径检查之前就自动放行，即使操作项目目录外的路径（如 `cat /etc/hosts`、`ls /tmp`）也无需确认。

- **Files Modified**:
  - `packages/repl/src/ui/InkREPL.tsx` - UI 层权限检查
  - `packages/repl/src/interactive/repl.ts` - 非交互模式权限检查

---

### 084: 流式响应长时间静默中断无任何提示
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.5.29
- **Fixed**: v0.5.30
- **Created**: 2026-03-12
- **Resolved**: 2026-03-12

- **Original Problem**:
  会话在长时间运行后（如电脑休眠或网络长时间空闲）突然中断，现象如下：
  - Assistant 输出中途停止（如"现在创建题库管理页面"）
  - 无任何 info 信息、重试消息或错误提示
  - LLM API 统计中无调用日志
  - 时间跨度约 9 小时（12:07 AM → 09:32 AM）
  - 用户输入新消息后，程序才"恢复"，但之前的上下文已丢失

- **Expected Behavior**:
  - 连接断开时应该有明确的错误提示或重试消息
  - 即使无法重试，也应该告知用户发生了什么
  - API 调用应该有日志记录（至少在重试时）

- **Context**:
  - 相关代码：`packages/ai/src/providers/anthropic.ts` 流式响应循环
  - 相关代码：`packages/coding/src/retry-handler.ts` 重试逻辑
  - 现有 3 分钟硬超时可能未生效（或超时后消息未显示）
  - 可能是 `for await...of` 循环在网络断开时静默结束

- **Root Cause Analysis**:
  1. **流式响应静默失败**：`for await (const event of response)` 循环在网络中断时没有抛出错误，而是返回不完整结果
  2. **HTTP 连接静默断开**：网络连接可能在某个时间点断开，但没有被检测到
  3. **超时机制可能未生效**：如果 `for await` 循环阻塞在等待数据，setTimeout 可能不会触发
  4. **无完整性检查**：流式响应结束后没有验证响应是否完整（如检查 stop_reason）

- **Additional Context**:
  - 电脑没有休眠，排除了系统挂起的可能性
  - 9 小时期间没有任何输出，说明请求可能被"挂起"或返回了不完整结果

- **Reproduction**:
  1. 启动 KodaX 会话
  2. 让电脑进入休眠状态或断开网络 8+ 小时
  3. 恢复后发送消息
  4. 观察是否没有任何错误/重试信息

- **Solution Implemented**:
  1. **添加流式完整性检查**：
     - 在 `anthropic.ts` 中追踪 `message_stop` 事件
     - 如果流式响应结束时未收到 `message_stop`，抛出 `StreamIncompleteError`
     - 同时追踪 `message_start`、`message_delta` 事件
  2. **添加错误分类**：
     - 在 `error-classification.ts` 中添加 `StreamIncompleteError` 分类
     - 将其标记为 `TRANSIENT`，支持最多 3 次重试
  3. **OpenAI Provider 同步修复**：
     - 在 `openai.ts` 中追踪 `finish_reason`
     - 如果流结束时未收到 `finish_reason`，抛出相同错误
  4. **调试日志**：
     - 设置 `KODAX_DEBUG_STREAM=1` 可查看流式事件详情
     - 记录流开始时间、结束时间、事件类型等

- **Files Modified**:
  - `packages/ai/src/providers/anthropic.ts` - 添加 message_stop 检测
  - `packages/ai/src/providers/openai.ts` - 添加 finish_reason 检测
  - `packages/coding/src/error-classification.ts` - 添加 StreamIncompleteError 分类

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

### 055: Built-in Skills 未完全符合 Agent Skills 规范
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.4.7
- **Created**: 2026-03-01
- **Original Problem**:
  当前 Built-in Skills（如 `/help`, `/model`, `/project`）使用 console.log 输出，而非返回结构化数据给 LLM。这与 Agent Skills 标准不一致：
  - Agent Skills 标准：Skill 内容应注入 LLM 上下文
  - Built-in Skills 当前：直接使用 console.log 输出到终端
  - 用户期望：所有 Skills 都应该统一行为
- **Context**:
  - Issue 054 已修复，核心 Skills 系统已正常工作
  - 此 Issue 追踪 Built-in Skills 的统一性问题
- **Proposed Solution**:
  - 将 Built-in Skills 迁移到统一的 Skill 框架
  - 或明确文档说明 Built-in Skills 与 User Skills 的区别

---

### 061: Windows Terminal 流式输出时滚轮滚动异常 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.4.5
- **Created**: 2026-03-02
- **Related**: Issue 058 (闪烁问题已解决)
- **Affected Platforms**: Windows Terminal

- **Problem**:
  流式输出时用鼠标滚轮向上滚动后，无法用滚轮向下滚动（但拖动滚动条可以）

- **Root Cause Analysis**:

  ### 历史消息未使用 `Static` 组件

  **当前代码** (`MessageList.tsx`):
  ```tsx
  {filteredItems.map((item) => (
    <HistoryItemRenderer key={item.id} item={item} theme={theme} maxLines={maxLines} />
  ))}
  ```

  **问题**: 每次流式内容更新时，所有历史消息都会重新渲染，Ink 重新计算整个视口，
  可能导致终端滚动状态被重置。

- **Proposed Solution**:

  ### 方案 A: 使用 Static 包裹历史消息 ⭐

  **优先级**: 高 | **效果**: 显著

  **改动文件**: `packages/repl/src/ui/components/MessageList.tsx`

  **改动内容**:
  ```tsx
  import { Static } from "ink";

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

  **原理**: Ink 的 `Static` 组件将内容写入终端后不再参与后续渲染周期，
  新内容追加到 Static 内容下方，不会触发整个视口重绘。

  **预期效果**:
  - ✅ 历史消息只渲染一次
  - ✅ 只有流式内容参与动态渲染
  - ✅ 滚动状态不会被重置

---

### 077: Skills 系统高级功能未完全实现 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.5.5
- **Fixed**: -
- **Created**: 2026-03-04
- **Original Problem**:
  Issue 054 已修复，Skills 系统的核心功能（命令注入、渐进式披露、自然语言触发）已正常工作。但 KodaX 扩展的以下高级功能尚未完全实现：

  1. **`context: fork` 子代理执行**
     - 期望行为：Skill 在独立子代理中执行，不影响主会话
     - 当前状态：`executor.ts` 中有占位符实现，返回 fork 配置但未集成
     - Pi-mono 实现：作为独立扩展 (`subagent`) 实现，不是 Skills 系统的一部分

  2. **`allowed-tools` 工具限制**
     - 期望行为：限制 skill 执行时 LLM 可用的工具
     - 当前状态：解析工具列表但未强制执行
     - Pi-mono 实现：文档中有说明（experimental），但代码中未实现

  3. **`agent` / `model` 字段**
     - 期望行为：指定子代理类型或模型
     - 当前状态：已解析并传递，但依赖于 `context: fork` 完整实现

- **Expected Behavior**:
  以上功能为 **KodaX 扩展**（非 Agent Skills 标准或 pi-mono 实现的一部分），属于"锦上添花"功能：
  - 基本 Skills 功能（`/skill-name` 命令、自然语言触发、渐进式披露）已正常工作
  - 高级功能需要更大架构改动（子代理执行需要完整的子进程管理）

- **Reference**:
  **Pi-mono 对比分析** (参考 `C:\Works\GitWorks\pi-mono`):

  | 功能 | Pi-mono | KodaX |
  |------|---------|-------|
  | `context: fork` | 独立扩展（非 Skills） | 占位符 |
  | `allowed-tools` | 文档有，代码未实现 | 解析但未执行 |
  | `agent` | 独立扩展 | 占位符 |
  | `model` | Agent 定义中支持 | 解析但未使用 |
  | 上下文字符预算 | 未实现 | 未实现 |

- **Files**:
  - `packages/skills/src/types.ts` - 类型定义（已有字段）
  - `packages/skills/src/executor.ts` - fork 模式占位符实现
  - `packages/skills/src/skill-loader.ts` - 字段解析

- **Resolution Approach**:
  这些是**可选的高级功能**，当前不需要紧急实现：
  - 核心 Skills 功能已满足基本使用需求
  - 如需完整子代理功能，可参考 pi-mono 的 subagent 扩展实现

---

### 082: packages/ai 缺少单元测试
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.5.21
- **Created**: 2026-03-08

- **Original Problem**:
  `packages/ai` 目录包含多个 AI Provider 实现，但完全没有单元测试覆盖。

  当前缺少测试的模块：
  - `providers/anthropic.ts` - Anthropic Claude API 集成
  - `providers/openai.ts` - OpenAI API 集成
  - `providers/gemini-cli.ts` - Gemini CLI 凭证提取和 API 集成
  - `providers/codex-cli.ts` - Codex CLI 凭证提取和 API 集成
  - `providers/registry.ts` - Provider 注册和工厂
  - `providers/base.ts` - 基类实现

- **Expected Behavior**:
  - 测试覆盖率应达到 80%+
  - 至少覆盖：凭证提取、消息转换、SSE 解析、错误处理

- **Impact**: 中等
  - 无法保证代码质量和回归测试
  - 重构时容易引入 bug
  - 新增 provider 时缺乏参考模式

- **Context**:
  - 项目全局测试覆盖要求见 `~/.claude/rules/common/testing.md`
  - IMPROVEMENT_CLI_PROVIDERS.md 中也提到了此问题 (P0)

- **Proposed Solution**:
  1. 创建 `tests/providers/` 目录
  2. 为每个 provider 创建测试文件
  3. 优先覆盖关键路径：认证、消息转换、流式响应解析
  4. 使用 mock 避免真实 API 调用

---

### 083: 缺少快捷键系统 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.5.29
- **Fixed**: v0.5.30
- **Created**: 2026-03-11
- **Resolved**: 2026-03-12

- **Original Problem**:
  KodaX 目前缺少快捷键系统，用户需要完全依赖命令输入来改变程序行为，
  例如切换工作模式等。这与 Gemini CLI 和 Claude Code 的用户体验有差距，
  两者都提供了快捷键支持。

- **Expected Behavior**:
  - 支持常用快捷键，如：
    - `Ctrl+O`: 切换工作模式（Project/Coding 等）
    - `Ctrl+T`: 切换 Extended Thinking
    - `Ctrl+C`: 中断当前操作
    - `Ctrl+L`: 清屏
    - `?`: 显示帮助
  - 快捷键应该是可发现、可配置的
  - 在流式输出或 LLM 响应期间也能响应快捷键

- **Impact**: 中等
  - 影响用户体验和操作效率
  - 与竞品功能对齐有助于用户迁移

- **Context**:
  - 参考 Gemini CLI 的快捷键设计
  - 参考 Claude Code 的快捷键设计
  - 当前已有 `Ctrl+C` 中断功能，可扩展

- **现有架构**:
  - `KeypressContext.tsx`: 已有优先级键盘事件分发系统
  - `InputPrompt.tsx`: 硬编码的输入快捷键 (Tab, Esc, Ctrl+C, 方向键等)
  - `InkREPL.tsx`: 流式中断处理 (Ctrl+C)

- **差距分析**:
  1. 无快捷键注册表 - 快捷键硬编码在各组件
  2. 无用户配置支持
  3. 无快捷键发现/帮助机制
  4. 无操作抽象层

- **Implementation Plan**:

  **Phase 1: Core Infrastructure (2-3 files)**

  创建文件结构:
  ```
  packages/repl/src/ui/shortcuts/
    index.ts                    # Public exports
    types.ts                    # 核心类型定义
    ShortcutsRegistry.ts        # 集中式注册表单例
    defaultShortcuts.ts         # 默认快捷键定义
    useShortcut.ts              # React hook
    shortcuts-config.ts         # 配置文件加载/保存
  ```

  核心类型 (types.ts):
  ```typescript
  type ShortcutActionId =
    | 'interrupt'       // Ctrl+C - 中断
    | 'clearScreen'     // Ctrl+L - 清屏
    | 'showHelp'        // ? - 显示帮助
    | 'toggleWorkMode'  // Ctrl+O - 切换模式
    | 'toggleThinking'  // Ctrl+T - 切换思考
    | 'acceptCompletion'| 'submitInput' | 'historyUp' | 'historyDown'
    // ... 更多

  interface KeyBinding {
    key: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
  }

  interface ShortcutDefinition {
    id: ShortcutActionId;
    name: string;
    description: string;
    defaultBindings: KeyBinding[];
    context: 'global' | 'input' | 'streaming';
    priority: number;
    category: 'global' | 'navigation' | 'editing' | 'mode';
  }
  ```

  **Phase 2: Registry & Hook**

  ShortcutsRegistry (ShortcutsRegistry.ts):
  - 单例模式，存储所有注册的快捷键
  - 从 `~/.kodax/keybindings.json` 加载用户配置
  - 提供 `findMatchingShortcut(key, context)` 查询
  - 支持上下文感知激活

  useShortcut Hook (useShortcut.ts):
  ```typescript
  function useShortcut(
    actionId: ShortcutActionId,
    handler: () => boolean | void,
    options?: { context?: ShortcutContext; isActive?: boolean }
  ): void;
  ```

  **Phase 3: Default Shortcuts**

  | Action | Key | Context | Description |
  |--------|-----|---------|-------------|
  | `interrupt` | Ctrl+C | streaming | 中断当前操作 |
  | `clearScreen` | Ctrl+L | global | 清屏 |
  | `showHelp` | ? | global | 显示帮助 |
  | `toggleWorkMode` | Ctrl+O | global | 切换 Project/Coding 模式 |
  | `toggleThinking` | Ctrl+T | global | 切换 Extended Thinking |
  | `acceptCompletion` | Tab | input | 接受补全 |
  | `submitInput` | Enter | input | 提交输入 |
  | `historyUp` | Up | input | 历史上一条 |
  | `historyDown` | Down | input | 历史下一条 |

  **Phase 4: Integration**

  修改 InkREPL.tsx:
  1. 添加 `ShortcutsProvider` 包装
  2. 追踪当前上下文 (input/streaming)
  3. 注册全局快捷键 (toggleWorkMode, toggleThinking, clearScreen, showHelp)

  修改 InputPrompt.tsx:
  1. 移除硬编码的键处理
  2. 使用 `useShortcut` 注册快捷键
  3. 保留现有的输入逻辑，但通过快捷键触发

  **Phase 5: Help System**

  创建 ShortcutsHelp 组件:
  - 按 `?` 显示帮助面板
  - 按类别分组显示快捷键
  - 显示当前键绑定和描述

  **Phase 6: User Configuration**

  配置文件结构 (`~/.kodax/keybindings.json`):
  ```json
  {
    "version": 1,
    "bindings": {
      "toggleWorkMode": [{ "key": "o", "ctrl": true }],
      "toggleThinking": [{ "key": "t", "ctrl": true }],
      "clearScreen": [{ "key": "l", "ctrl": true }]
    }
  }
  ```

- **Critical Files**:

  | File | Purpose |
  |------|---------|
  | `packages/repl/src/ui/contexts/KeypressContext.tsx` | 集成现有优先级系统 |
  | `packages/repl/src/ui/InkREPL.tsx` | 添加全局快捷键注册 |
  | `packages/repl/src/ui/components/InputPrompt.tsx` | 迁移硬编码快捷键 |
  | `packages/repl/src/ui/types.ts` | 扩展快捷键类型 |

- **Verification**:

  1. 功能测试:
     - Ctrl+O 切换工作模式
     - Ctrl+T 切换 Extended Thinking
     - Ctrl+L 清屏
     - ? 显示帮助
     - Ctrl+C 中断流式输出

  2. 上下文测试:
     - 流式输出时 Ctrl+C 中断有效
     - 输入时 Tab 补全有效
     - 全局快捷键在各上下文都可用

  3. 配置测试:
     - 用户配置文件正确加载
     - 自定义键绑定覆盖默认值

- **Migration Strategy**:
  1. Phase 1-2: 创建新基础设施，不修改现有代码
  2. Phase 3-4: 逐步迁移，先 InkREPL 后 InputPrompt
  3. Phase 5-6: 添加帮助和配置功能
  4. Backward compatibility: 保留所有现有快捷键行为

- **Resolution**:
  实现了完整的快捷键系统，包括以下组件：

  1. **核心基础设施** (Phase 1-3 完成):
     - `types.ts`: 定义 ShortcutActionId, KeyBinding, ShortcutDefinition 等核心类型
     - `ShortcutsRegistry.ts`: 单例模式注册表
     - `defaultShortcuts.ts`: 默认快捷键定义，涵盖全局、输入、导航、编辑类别
     - `useShortcut.ts`: React Hook 集成 KeypressContext 优先级系统
     - `ShortcutsProvider.tsx`: Context Provider 初始化注册表

  2. **全局快捷键集成** (Phase 4 完成):
     - `GlobalShortcuts.tsx`: 注册全局快捷键处理器
     - `InkREPL.tsx`: 添加 ShortcutsProvider 和 GlobalShortcuts 组件
     - 实现的快捷键：Ctrl+C (中断), Ctrl+L (清屏), ? (帮助), Ctrl+T (思考)
     - 新增 `onInputChange` 回调追踪输入状态

  3. **帮助面板** (Phase 5 完成):
     - 按 ? 显示/隐藏帮助面板（仅当输入为空时，且消费 ? 字符不输入）
     - 发送消息后自动隐藏帮助面板
     - 显示已注册快捷键列表

  4. **设计决策**（按用户要求简化）:
     - **不实现用户配置文件**：用户明确表示不需要过度工程化
     - interrupt 快捷键使用 'global' 上下文 + `isActive: isLoading` 控制触发时机
     - **不实现模式切换快捷键**：原计划的 `toggleWorkMode` 语义有误（涉及安全敏感的权限模式），已移除

  5. **GPT Review 问题处理**:
     - ✅ `?` 快捷键优先级从 -10 提升到 150（高于 InputPrompt 的 100，确保能触发）
     - ✅ 添加 Shift+Tab 转义序列支持 (`\x1b[Z`)
     - ✅ 移除 `toggleWorkMode` 快捷键（语义错误，会切换包含 'plan' 在内的权限模式）
     - ✅ 移除用户配置相关代码和类型

- **Files Modified**:
  - `packages/repl/src/ui/shortcuts/types.ts` - 核心类型定义
  - `packages/repl/src/ui/shortcuts/ShortcutsRegistry.ts` - 注册表单例
  - `packages/repl/src/ui/shortcuts/defaultShortcuts.ts` - 默认快捷键定义
  - `packages/repl/src/ui/shortcuts/useShortcut.ts` - React Hook
  - `packages/repl/src/ui/shortcuts/ShortcutsProvider.tsx` - Context Provider
  - `packages/repl/src/ui/shortcuts/GlobalShortcuts.tsx` - 全局快捷键组件
  - `packages/repl/src/ui/shortcuts/index.ts` - 导出入口
  - `packages/repl/src/ui/InkREPL.tsx` - 集成快捷键系统
  - `packages/repl/src/ui/types.ts` - 添加 onInputChange 回调类型
  - `packages/repl/src/ui/components/InputPrompt.tsx` - 添加 onInputChange 支持
  - `packages/repl/src/ui/utils/keypress-parser.ts` - 添加 Shift+Tab 转义序列支持

---

## Summary
- Total: 13 (11 Open, 2 Resolved, 0 Partially Resolved, 0 Won't Fix)
- Highest Priority Open: 086 - 自动补全前缀匹配方向错误导致超长输入仍匹配短选项 (High)
- 78 issues archived to ISSUES_ARCHIVED.md (43 previous + 32 resolved + 3 Won't Fix on 2026-03-11)

---

## Changelog

### 2026-03-12: Issue 086 新增
- Added 086: 自动补全前缀匹配方向错误导致超长输入仍匹配短选项 (High Priority)
- 根因分析：`combinedMatch()` 中的 `prefixMatch()` 检查方向错误，检查的是"选项是否以用户输入开头"而非"用户输入是否以选项开头"
- 现象：输入 `/model zhipu-coding` 时，补全列表仍显示 `zhipu` 选项，按回车会替换为 `/model zhipu`
- 影响文件：`packages/repl/src/interactive/fuzzy.ts`, `autocomplete-provider.ts`, `autocomplete.ts`, `argument-completer.ts`

### 2026-03-12: Issue 083 修复
- Resolved 083: 缺少快捷键系统 (Medium Priority)
- 实现内容：
  1. 创建集中式快捷键注册表 (ShortcutsRegistry)
  2. 创建 useShortcut React Hook 集成 KeypressContext
  3. 定义默认快捷键（中断、清屏、帮助、思考等）
  4. 添加 GlobalShortcuts 组件注册全局快捷键
  5. 集成 ShortcutsProvider 到 InkREPL
  6. 帮助面板仅在输入为空时显示，发送后自动隐藏
- GPT Review 后修复：
  1. `?` 快捷键优先级从 -10 提升到 150（高于 InputPrompt 的 100）
  2. 添加 Shift+Tab 转义序列 `\x1b[Z` 支持
  3. 移除 toggleWorkMode 快捷键（语义错误）
  4. 移除用户配置相关代码（按用户要求不实现）
- 修改文件：`packages/repl/src/ui/shortcuts/` 目录下 7 个文件 + `InkREPL.tsx` + `InputPrompt.tsx` + `keypress-parser.ts`
- 设计决策：按用户要求不实现用户配置文件，保持简洁

### 2026-03-12: Issue 085 修复
- Added & Resolved 085: 只读 Bash 命令白名单未在非 plan 模式复用 (Medium Priority)
- 修复内容：
  1. 将 `isBashReadCommand()` 检查移到所有模式下都生效
  2. 将只读命令检查移到**受保护路径检查之前**，项目目录外的只读命令也能自动放行
- 修改文件：`packages/repl/src/ui/InkREPL.tsx`, `packages/repl/src/interactive/repl.ts`

### 2026-03-12: Issue 084 新增
- Added 084: 流式响应长时间静默中断无任何提示 (High Priority)
- 现象：长时间（9小时）后会话静默中断，无重试/错误信息，API 无调用日志
- 可能原因：流式响应 `for await` 循环在网络断开时静默结束，或超时机制未生效

### 2026-03-11: Won't Fix Issues 归档
- Archived 3 Won't Fix issues to ISSUES_ARCHIVED.md:
  - 039: 死代码 printStartupBanner (误报)
  - 053: /help 命令输出重复渲染
  - 063: Shift+Enter 换行功能失效
- Remaining: 10 Open issues only

### 2026-03-11: Issue 058 归档
- Issue 058 (终端流式输出闪烁问题) 归档到 ISSUES_ARCHIVED.md
- VS Code Terminal 兼容性问题已确认解决方案（关闭 GPU 加速）
- Remaining: 10 Open, 3 Won't Fix

### 2026-03-11: Issue 归档
- 31 resolved issues archived to ISSUES_ARCHIVED.md
- Remaining: 10 Open, 1 Partially Resolved, 3 Won't Fix
- Issue 083 added: 缺少快捷键系统 (Medium Priority)

### 2026-03-11: Issue 状态审查更新
- **Issue 006**: Open → Resolved (存储层 `getFeatureByIndex()` 添加了范围验证)
- **Issue 039**: Open → Won't Fix (误报 - `printStartupBanner` 函数实际在 `repl.ts` 第 156 行被调用，非死代码)
- **Issue 060**: Deferred → Resolved (定时器已同步：StreamingContext flush 80ms 与 Spinner 动画帧 80ms 同步)
- **Issue 067**: Open → Resolved (v0.5.27 实现了正确的重试循环和回调式 UI 通知)
- **Issue 069**: Open → Resolved (`toolAskUserQuestion` 工具已存在于 `packages/coding/src/tools/ask-user-question.ts`)
- **Issue 070**: Open → Resolved (代码审查确认换行符在流式管道中被正确保留，非 KodaX 代码问题)
- **Issue 081**: Open → Resolved (Provider 已使用 `useMemo` 记忆化，所有回调使用 `useCallback` 包装)
- 更新 Summary 统计: 10 Open, 32 Resolved, 1 Partially Resolved, 3 Won't Fix

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

### 2026-02-26: Issue 046 重新打开
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

### 2026-02-19: 代码审查与重构
- Resolved 020: 资源泄漏 - Readline 接口
- Resolved 021: 全局可变状态
- Resolved 022: 函数过长
- Added open issues 001-018 from code review
