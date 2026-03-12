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
| 085 | Medium | Open | 只读 Bash 命令白名单未在非 plan 模式复用 | v0.5.29 | - | 2026-03-12 | - |
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
| 083 | Medium | Open | 缺少快捷键系统 | v0.5.29 | - | 2026-03-11 | - |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->
---

### 085: 只读 Bash 命令白名单未在非 plan 模式复用
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.5.29
- **Created**: 2026-03-12

- **Original Problem**:
  `git diff`、`git status` 等只读 Bash 命令在 `default`、`accept-edits`、`auto-in-project` 模式下仍需要用户确认，而在 `plan` 模式下可以自动放行。

  根因分析：
  ```typescript
  // InkREPL.tsx:706-711
  if (mode === 'plan' && tool === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommand(command)) {
      return true; // 只在 plan 模式生效！
    }
  }
  ```

  `isBashReadCommand()` 白名单检查只在 `mode === 'plan'` 条件下执行，其他模式没有复用这个逻辑。

- **Expected Behavior**:
  - `BASH_SAFE_READ_COMMANDS` 白名单应该在所有模式中生效
  - 只读命令（如 `git status`、`git diff`、`ls`、`cat` 等）应该自动放行
  - 写命令（黑名单 `BASH_WRITE_COMMANDS`）仍需按各模式规则处理

- **Current Behavior by Mode**:

  | Mode | `git diff` 等只读命令 | 写命令 |
  |------|----------------------|--------|
  | `plan` | ✅ 自动放行（白名单） | ❌ 阻止 |
  | `default` | ⚠️ 需要确认 | ⚠️ 需要确认 |
  | `accept-edits` | ⚠️ 需要确认 | ⚠️ 需要确认 |
  | `auto-in-project` | ⚠️ 需要确认 | ⚠️ 需要确认 |

- **Proposed Solution**:
  1. 将 `isBashReadCommand()` 检查逻辑从 `if (mode === 'plan')` 条件中提取出来
  2. 在所有模式下，如果命令匹配白名单，自动放行
  3. 写命令仍按各模式原有逻辑处理（黑名单阻止或需确认）

  ```typescript
  // 提议的新逻辑
  if (tool === 'bash') {
    const command = (input.command as string) ?? '';
    if (isBashReadCommand(command)) {
      return true; // 所有模式都自动放行只读命令
    }
    // plan 模式下，非白名单命令走阻止逻辑
    // 其他模式走原有确认逻辑
  }
  ```

- **Affected Files**:
  - `packages/repl/src/ui/InkREPL.tsx` - UI 层权限检查
  - `packages/repl/src/interactive/repl.ts` - 非交互模式权限检查
  - `packages/repl/src/permission/types.ts` - 白名单定义

- **Context**:
  - 白名单定义：`BASH_SAFE_READ_COMMANDS` (types.ts:76-89)
  - 白名单检查函数：`isBashReadCommand()` (permission.ts:30-79)

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

### 083: 缺少快捷键系统
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.5.29
- **Created**: 2026-03-11

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

- **Proposed Solution**:
  1. 设计统一的快捷键注册系统
  2. 在 InkREPL 中集成键盘事件监听
  3. 提供快捷键提示 UI
  4. 支持用户自定义快捷键配置

---

## Summary
- Total: 12 (11 Open, 1 Resolved, 0 Partially Resolved, 0 Won't Fix)
- Highest Priority Open: 083 - 缺少快捷键系统 (Medium)
- 78 issues archived to ISSUES_ARCHIVED.md (43 previous + 32 resolved + 3 Won't Fix on 2026-03-11)

---

## Changelog

### 2026-03-12: Issue 085 新增
- Added 085: 只读 Bash 命令白名单未在非 plan 模式复用 (Medium Priority)
- 现象：`git diff` 等只读命令在 default/accept-edits 模式下需要确认
- 根因：`isBashReadCommand()` 检查只在 `mode === 'plan'` 条件下生效
- 建议：将白名单检查逻辑提取到所有模式共用

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
