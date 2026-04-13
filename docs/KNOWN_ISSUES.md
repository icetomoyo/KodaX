# Known Issues

_Last Updated: 2026-04-12_

---

> **Archive Notice**: Historical issue records are maintained in `docs/ISSUES_ARCHIVED.md`.
> This file tracks the active issue backlog only.

---

## Issue Index
<!-- Quick reference table for all issues -->

| ID | Priority | Status | Title | Introduced | Fixed | Created | Resolved |
|----|----------|--------|-------|------------|-------|---------|----------|
| 088 | High | Resolved | 消息列表视口布局不稳定 - 底部区域跳动/最后一行被裁剪 | v0.5.29 | v0.5.39 | 2026-03-16 | 2026-03-16 |
| 087 | Medium | Resolved | 自动补全触发冲突 - @文件路径中/错误触发命令补全 | v0.5.33 | v0.5.33 | 2026-03-13 | 2026-03-13 |
| 086 | High | Resolved | 自动补全竞态条件导致快速输入时显示过期补全 | v0.5.32 | v0.5.32 | 2026-03-12 | 2026-03-12 |
| 085 | Medium | Resolved | 只读 Bash 命令白名单未在非 plan 模式复用 | v0.5.29 | v0.5.30 | 2026-03-12 | 2026-03-12 |
| 084 | High | Resolved | 流式响应长时间静默中断无任何提示 | v0.5.29 | v0.5.30 | 2026-03-12 | 2026-03-12 |
| 013 | Low | Resolved | 自动补全缓存内存泄漏风险 | v0.3.1 | v0.6.17 | 2026-02-19 | 2026-03-23 |
| 014 | Low | Resolved | 语法高亮语言支持不全 | v0.3.1 | v0.6.17 | 2026-02-19 | 2026-03-23 |
| 015 | Low | Resolved | Unicode 检测不完整 | v0.3.1 | v0.6.17 | 2026-02-19 | 2026-03-23 |
| 017 | Low | Resolved | TextBuffer 未使用方法 | v0.3.1 | v0.6.17 | 2026-02-19 | 2026-03-23 |
| 018 | Low | Resolved | TODO 注释未清理 | v0.3.1 | v0.6.17 | 2026-02-19 | 2026-03-23 |
| 055 | Low | Resolved | Built-in Skills 未完全符合 Agent Skills 规范 | v0.4.7 | v0.6.17 | 2026-03-01 | 2026-03-23 |
| 061 | Low | Resolved | Windows Terminal 流式输出时滚轮滚动异常 | v0.4.5 | v0.6.17 | 2026-03-02 | 2026-03-23 |
| 077 | Low | Resolved | Skills 系统高级功能未完全实现 | v0.5.5 | v0.6.17 | 2026-03-04 | 2026-03-23 |
| 082 | Low | Open | packages/ai 缺少单元测试 | v0.5.21 | - | 2026-03-08 | - |
| 083 | Medium | Resolved | 缺少快捷键系统 | v0.5.29 | v0.5.30 | 2026-03-11 | 2026-03-12 |

| 089 | High | Resolved | Feature / Design / Summary 元数据漂移 | v0.6.10 | v0.6.10 | 2026-03-18 | 2026-03-19 |
| 090 | High | Resolved | CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 | v0.6.10 | v0.6.10 | 2026-03-18 | 2026-03-19 |
| 091 | High | Open | 缺少一等公民 MCP / Web Search / Code Search 工具体系 | v0.6.10 | - | 2026-03-18 | - |
| 092 | High | Open | Team 模式已暴露但原生多 Agent 架构仍未闭环 | v0.6.10 | - | 2026-03-18 | - |
| 093 | Low | Open | 缺少 IDE / Desktop / Web 一体化分发表面 (Vibe Coding 时代已降级) | v0.6.10 | - | 2026-03-18 | - |
| 094 | Medium | Open | 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 | v0.6.13 | - | 2026-03-22 | - |
| 095 | Medium | Open | Agent / REPL 主流程仍存在重复编排与手写运行时流程 | v0.6.13 | - | 2026-03-22 | - |
| 096 | Low | Open | 类型边界过宽且共享可变状态较多 | v0.6.13 | - | 2026-03-22 | - |
| 097 | Medium | Open | 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 | v0.6.13 | - | 2026-03-22 | - |
| 098 | Low | Open | 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 | v0.6.13 | - | 2026-03-22 | - |
| 099 | Low | Open | 测试辅助代码重复，局部验证资产需要收敛 | v0.6.13 | - | 2026-03-22 | - |
| 100 | High | Resolved | ACP Server 缺少日志/可观测性输出 | v0.6.15 | v0.6.15 | 2026-03-23 | 2026-03-23 |

| 101 | High | Resolved | Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff | v0.7.5 | v0.7.5 | 2026-03-27 | 2026-03-27 |
| 102 | Medium | Resolved | Repo-intelligence mixes git-tracked and filesystem-discovered file sets | v0.7.5 | v0.7.5 | 2026-03-28 | 2026-03-28 |
| 103 | Low | Resolved | Managed-task planning recomputes repo routing signals in the same workspace | v0.7.5 | v0.7.5 | 2026-03-28 | 2026-03-28 |
| 104 | Low | Resolved | Repo-intelligence cache JSON is read without runtime shape validation | v0.7.5 | v0.7.5 | 2026-03-28 | 2026-03-28 |

| 105 | Medium | Open | kodax -c 历史记录未注入 LLM 上下文 - resume 路径可能存在 gitRoot 过滤不一致 | v0.7.14 | - | 2026-04-03 | - |
| 106 | High | Open | Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift | v0.7.14 | - | 2026-04-08 | - |
| 107 | Medium | Open | harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition | v0.7.16 | - | 2026-04-11 | - |

| 108 | High | Open | ACP server 链路未接入 MCP — 编辑器/ACP 场景下 mcpServers 配置不生效 | v0.7.16 | - | 2026-04-11 | - |
| 109 | Low | Open | 缺少 mcp_get_prompt 工具 — MCP prompt 能力未暴露给模型 | v0.7.16 | - | 2026-04-11 | - |
| 110 | Low | Open | 缺少 /mcp status 和 /mcp refresh REPL 命令 | v0.7.16 | - | 2026-04-11 | - |
| 111 | Low | Open | SSE / Streamable HTTP MCP 传输缺少专项测试 | v0.7.16 | - | 2026-04-11 | - |
| 112 | High | Open | ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式 | v0.7.18 | - | 2026-04-12 | - |
| 113 | High | Resolved | Ctrl+C 中断后工具调用仍继续执行 — abort signal 未传播到工具执行阶段 | v0.7.17 | v0.7.18 | 2026-04-12 | 2026-04-12 |
| 114 | High | Resolved | ask_user_question ESC 取消被静默吞掉 — 用户取消后模型继续执行 | v0.7.17 | v0.7.18 | 2026-04-12 | 2026-04-12 |

---

## Issue Details
<!-- Full details for each issue - REQUIRED for all issues -->
---
### 112: ask_user_question 交互机制不完备 — 数字编号歧义 + 缺少 input/multiSelect 模式

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.18
- **Fixed**: -
- **Created**: 2026-04-12

- **Original Problem**:

  `ask_user_question` 的 Select 对话框存在两个根本性缺陷：

  **缺陷 1 — 数字编号歧义（当前最严重的体验问题）**

  KodaX Select 使用"输入数字编号 + 按 Enter"选择方式（`InkREPL.tsx` L4152-4196）。当 LLM 的文字输出中也包含编号列表时（如 smart-changelog 列出的步骤 1-6），用户会混淆"步骤编号"和"选项编号"：

  ```
  [LLM 的文字输出]
  步骤 1: Update CHANGELOG.md
  步骤 2: Sync version
  步骤 3: Create Git Tag
  ...

  [Select 对话框]
  1. 步骤 1,2,3      ← 用户以为按 1 = 选步骤 1
  2. 步骤 1,2,3,4    ← 用户按 2 以为 = 选步骤 2，实际选了这个组合
  3. 全部执行
  ```

  Claude Code 使用**上下箭头导航 + Enter 确认**模式（`CustomSelect/use-select-navigation.ts`），聚焦项显示 `❯` 指针，完全避免了数字编号歧义。

  **缺陷 2 — 缺少 input 和 multiSelect 模式**

  KodaX `ask_user_question` 只有单选列表一种交互模式。Claude Code 提供三种：
  - **单选**（默认）：上下导航 + Enter
  - **multiSelect**：空格键切换选中/取消，✓ 标记已选项，Enter 提交全部选择
  - **input 类型选项**：Tab 键展开自由文本输入，用户可输入任意内容

  缺少后两种模式导致：组合选择场景（如 "选择步骤 1,3,5"）LLM 被迫将组合打包为预设选项；用户无法自行输入任意组合。

- **Context**:

  **KodaX 现有实现**：
  - 工具定义：`packages/coding/src/tools/registry.ts` L420-462 — `required: ['question', 'options']`
  - 工具实现：`packages/coding/src/tools/ask-user-question.ts` — 始终走 `ctx.askUser()` → Select 路径
  - REPL Select 交互：`packages/repl/src/ui/InkREPL.tsx` L4152-4196 — 数字输入 + Enter
  - UI 已有 Input 对话框：`showInputDialog()` 支持自由文本 + 默认值，但 `ask_user_question` 无法触发

  **Claude Code 参考实现**（`C:\Works\claudecode`）：
  - `CustomSelect/use-select-navigation.ts` — 基于 reducer 的焦点管理，支持 up/down/pageUp/pageDown
  - `CustomSelect/use-select-input.ts` L241-282 — 数字键快捷选择（可通过 `disableSelection: 'numeric'` 禁用）
  - `CustomSelect/select-option.tsx` — `ListItem` 渲染：`❯` 聚焦指针 + `✓` 选中标记
  - `AskUserQuestionTool.tsx` L19-23 — schema 包含 `multiSelect?: boolean`
  - `use-multiple-choice-state.ts` — 完整的多问题 + 多选状态管理
  - `keybindings/defaultBindings.ts` L319-330 — Select 上下文绑定：up/down/j/k/enter/escape/space

  **影响范围**：所有需要自由文本/组合输入的 skill（smart-changelog, monorepo version-strategy 等）

- **Planned Resolution**:

  **分两阶段实施，第一阶段解决最紧迫的数字歧义问题：**

  **Phase 1：Select 从数字输入改为上下导航（高优先级）**

  将 Select 对话框从"输入数字编号"改为 Claude Code 风格的"上下箭头导航 + Enter 确认"：

  1. **DialogSurface 渲染层**：
     - 选项不再显示 `1. xxx`，改为 `❯ xxx`（聚焦项）/ `  xxx`（非聚焦项）
     - 追踪 `focusedIndex` 状态，随箭头键更新
     - 选中项右侧显示 `✓`

  2. **Keypress handler 改造**（`InkREPL.tsx` L4152-4196）：
     - `↑` / `k` → 上移焦点
     - `↓` / `j` → 下移焦点
     - `Enter` → 确认当前聚焦项（替代数字 + Enter）
     - `Escape` → 取消
     - 数字键保留为**快捷键**直接选中（按 `2` 直接确认第 2 项，不需再按 Enter），但不是主交互方式

  3. **Select 状态提升**：将 `focusedIndex` 加入 `uiRequest` state，让 DialogSurface 能渲染焦点指针

  这一步完全消除数字编号歧义——用户通过视觉焦点指针明确知道选的是哪一项。

  **Phase 2：新增 multiSelect + input 模式（中优先级）**

  1. **multiSelect 模式**：
     - `ask_user_question` schema 新增 `multiSelect?: boolean`
     - 空格键切换当前聚焦项的选中/取消，`✓` 标记已选项
     - Enter 提交所有已选项，返回逗号分隔的 value 列表
     - 解决"选择步骤组合"场景，用户按空格自由勾选任意步骤

  2. **input 模式**：
     - `ask_user_question` schema 新增 `kind?: "select" | "input"`
     - `kind: "input"` 时走 `showInputDialog(question, default)`
     - 用户可自由输入任意文本（如 "1,3,5" 或 "all"）
     - `options` 在 input 模式下变为可选

  3. **返回格式**：
     - 单选：`{"success": true, "choice": "selected_value"}`
     - 多选：`{"success": true, "choice": "value1, value2, value3"}`
     - 输入：`{"success": true, "choice": "<用户自由输入>"}`

  具体改动文件：
  - `packages/repl/src/ui/components/DialogSurface.tsx` — 渲染焦点指针 + 选中标记
  - `packages/repl/src/ui/InkREPL.tsx` — keypress handler 改造 + multiSelect/input 路由
  - `packages/coding/src/tools/registry.ts` — schema 增加 `multiSelect`, `kind`
  - `packages/coding/src/tools/ask-user-question.ts` — 按 kind/multiSelect 分流
  - `packages/coding/src/types.ts` — `AskUserQuestionOptions` 增加新字段

  **为什么不选其他方案**：
  - ❌ 只加 input 模式不改 Select：不解决数字歧义根因，单选场景仍有问题
  - ❌ 只改 skill prompt：无法解决工具能力缺失，LLM 仍被迫打包组合
  - ❌ 全量复刻 Claude Code CustomSelect 组件：过度工程化，KodaX 的 Ink 版本和组件体系不同

---
### 113: Ctrl+C 中断后工具调用仍继续执行 — abort signal 未传播到工具执行阶段 (RESOLVED)

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.17
- **Fixed**: v0.7.18
- **Created**: 2026-04-12
- **Resolved**: 2026-04-12

- **Original Problem**:

  按下 Ctrl+C 后，API 流式输出能正确中断（AbortController.abort() 传播到 anthropic.ts 的 for-await 循环），但已进入工具执行阶段的工具调用不会被取消，导致用户在中断后仍偶尔看到工具输出或流式内容。

  **现象**：
  - Ctrl+C 后过几秒仍有工具结果输出
  - 并行的非 bash 工具全部运行到完成
  - 顺序 bash 工具队列中的后续工具仍逐一执行

  **根因分析**：
  1. `executeToolCall()` 函数不接受 `abortSignal` 参数，工具执行器无法感知中断
  2. 工具执行入口（agent.ts L2205）没有 abort 门卫，stream 结束到工具执行之间存在无保护窗口
  3. bash 工具 `for...of` 循环中没有在每次迭代前检查 abort 状态
  4. 非 bash 工具通过 `Promise.all()` 并发，已启动的 promise 会运行到完成

- **Context**:

  **信号链路**：
  ```
  Ctrl+C → GlobalShortcuts.tsx:69 abort()
         → StreamingContext.tsx:406 abortController.abort()
         → agent.ts:1787 retrySignal (AbortSignal.any)
         → anthropic.ts:234 for-await loop 检查 signal.aborted ✅
         → agent.ts:2205 工具执行阶段 ❌ (无检查)
  ```

  **影响文件**：`packages/coding/src/agent.ts`、`packages/coding/src/types.ts`、`packages/coding/src/tools/bash.ts`

- **Resolution**:

  四层防御策略（graceful cancellation 模式）：

  1. **工具执行前门卫**（agent.ts L2215-2233）：检查 `options.abortSignal?.aborted`，若已中断则将所有工具标记为 `CANCELLED_TOOL_RESULT_MESSAGE`，走统一的 `hasCancellation` 退出路径
  2. **`executeToolCall` 入口检查**（agent.ts L1220-1225）：新增 `abortSignal?: AbortSignal` 参数，函数入口检查 signal，短路返回取消结果
  3. **bash 工具循环检查**（agent.ts L2251-2255）：每次迭代前检查 abort，跳过未执行的 bash 工具
  4. **bash 子进程 kill**（bash.ts L147-178）：`abortSignal` 通过 `KodaXToolExecutionContext` 透传到 bash 工具，注册 `abort` 事件监听器，信号触发时立即 `proc.kill()` 杀掉正在运行的子进程。使用 `settled` 守卫防止 abort/timeout/close 竞态导致 Promise 多次 resolve；用 `.once()` 注册 cleanup listener 避免内存泄漏。

---
### 114: ask_user_question ESC 取消被静默吞掉 — 用户取消后模型继续执行 (RESOLVED)

- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.17
- **Fixed**: v0.7.18
- **Created**: 2026-04-12
- **Resolved**: 2026-04-12

- **Original Problem**:

  用户在 `ask_user_question` 对话框中按 ESC 取消时，取消意图被静默吞掉，模型仍然继续执行。

  **Select 模式**：
  - ESC → `showSelectDialogWithOptions` 返回 `undefined`
  - `resolveAskUserDefaultChoice(options)` 寻找 label/value 为 "cancel" 的选项
  - 如果 LLM 提供的选项中没有 "cancel" 关键字 → fallback 返回空字符串 `""`
  - 工具返回 `{ success: true, choice: "" }` → 模型认为用户做了有效选择

  **Input 模式**：
  - ESC → `askUserInput` 返回 `undefined`
  - `userText ?? ''` 将 undefined 转为空字符串
  - 工具返回 `{ success: true, choice: "" }` → 同上

  两种模式都没有产生 `[Cancelled]` 前缀的结果，agent 循环的 `hasCancellation` 检测不到取消。

- **Context**:

  **影响文件**：
  - `packages/repl/src/ui/InkREPL.tsx` — `askUser` 回调
  - `packages/coding/src/tools/ask-user-question.ts` — 工具层
  - `packages/coding/src/constants.ts` — 取消常量提取
  - `packages/coding/src/index.ts` — 导出新常量

- **Resolution**:

  1. **REPL 层**（InkREPL.tsx）：`askUser` 回调检测 `selectedValue === undefined`（ESC），直接返回 `CANCELLED_TOOL_RESULT_MESSAGE` 而非调用 `resolveAskUserDefaultChoice`
  2. **工具层 select**（ask-user-question.ts）：检测 `askUser` 返回值是否以 `CANCELLED_TOOL_RESULT_PREFIX` 开头，若是则直接透传而非包装为 `{ success: true }`
  3. **工具层 input**（ask-user-question.ts）：检测 `askUserInput` 返回 `undefined`，返回 `CANCELLED_TOOL_RESULT_MESSAGE`
  4. **常量提取**（constants.ts）：将 `CANCELLED_TOOL_RESULT_PREFIX` 和 `CANCELLED_TOOL_RESULT_MESSAGE` 从 `agent.ts` 私有常量提升为包级导出，消除硬编码字符串

---
### 111: SSE / Streamable HTTP MCP 传输缺少专项测试

- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  `transport.ts` 中 `createSseTransport()` 和 `createStreamableHttpTransport()` 已实现，但没有对应的测试用例。stdio 路径有完整集成测试覆盖（provider.test.ts + mcp-tools.test.ts），远程传输尚未验证。

- **Context**: 需要搭建 mock SSE/HTTP server 才能测试。工作量中等，不影响 stdio 功能。

- **Planned Resolution**: 在 FEATURE_065 范围内创建 `transport.test.ts`，用 Node.js http server 模拟 SSE 和 Streamable HTTP 端点。

---
### 110: 缺少 /mcp status 和 /mcp refresh REPL 命令

- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  用户无法在 REPL 中查看 MCP 连接状态（哪些 server 连接成功、哪些失败、catalog 有什么工具），也无法手动刷新 catalog。只能从 prompt context 间接看到 status=idle/ready/error。

- **Context**: 涉及 `packages/repl/src/interactive/commands.ts`。调用 `extensionRuntime.getDiagnostics()` 和 `refreshCapabilityProviders()`。

- **Planned Resolution**: 在 FEATURE_065 范围内添加 `/mcp` 命令（status 子命令 + refresh 子命令）。

---
### 109: 缺少 mcp_get_prompt 工具 — MCP prompt 能力未暴露给模型

- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  MCP 协议支持三种能力：tool、resource、prompt。KodaX 暴露了 `mcp_call`（tool）、`mcp_read_resource`（resource），但 prompt 能力只在 runtime API 和测试中可达（`runtime.getPrompt()`），没有对应的模型可调用工具。

- **Context**: 需要在 `packages/coding/src/tools/` 下新建 `mcp-get-prompt.ts`，和现有 4 个 MCP 工具同构。

- **Planned Resolution**: 在 FEATURE_065 范围内添加 `mcp_get_prompt` 工具。

---
### 108: ACP server 链路未接入 MCP — 编辑器/ACP 场景下 mcpServers 配置不生效

- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  `acp_server.ts` 的 `buildKodaXOptions()` 没创建 extensionRuntime，编辑器/ACP 场景下 `mcpServers` 配置只记录了服务器数量（用于 diagnostics），不会实际注册 MCP capability provider。因此 VS Code 扩展等 ACP 场景无法使用 MCP 工具。

- **Context**:
  - `src/acp_server.ts` line 119: McpServer 数组仅计数
  - `src/acp_server.ts` line 356: buildKodaXOptions 未传 extensionRuntime
  - `src/acp_server.ts` line 514: session 创建不含 MCP 初始化
  - CLI 路径（`kodax_cli.ts`）已正确接入：`hasConfiguredMcpServers()` → `createExtensionRuntime()` → `registerConfiguredMcpCapabilityProvider()`

- **Planned Resolution**: 在 FEATURE_065 范围内，将 CLI 的 MCP 初始化逻辑抽为共享函数，ACP server 复用。

---
### 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition

- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.16
- **Fixed**: -
- **Created**: 2026-04-11

- **Original Problem**:
  FEATURE_061 移除了预 Scout 状态机和 Tactical Flow，但 `harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL'` 类型命名残留在 237 处引用、10 个文件中。这些名字编码的是"哪个预设配置"的思维，而 FEATURE_061 后系统实际运作方式是"Scout 决定需要哪些角色"。

- **Context**:
  `harnessProfile` 字段在以下位置被广泛使用：
  - `types.ts`（5 处）：类型定义
  - `reasoning.ts`（29 处）：路由决策
  - `task-engine.ts`（106 处）：核心引擎
  - `provider-policy.ts`（4 处）：provider 策略
  - `agent.ts`（1 处）：agent 层
  - 各测试文件（~90 处）

  当前 `harnessProfile` 实际上只是一个 worker chain 的标签：
  - `H0_DIRECT` → `[scout]`
  - `H1_EXECUTE_EVAL` → `[generator, evaluator]`
  - `H2_PLAN_EXECUTE_EVAL` → `[planner, generator, evaluator]`

  `buildManagedTaskWorkers` 已经在做 worker chain 映射，harnessProfile 只是触发条件。

- **Planned Resolution**:
  1. 在 `KodaXTaskRoutingDecision` 中用 `workerChain: KodaXTaskRole[]` 替代 `harnessProfile`
  2. 保留 `harnessProfile` 作为 derived label（向后兼容导出类型）
  3. 内部路由逻辑改为基于 `workerChain` 而非 `harnessProfile`
  4. 逐步更新 237 处引用

- **Workaround**: 无需 workaround，当前命名不影响功能正确性。

---
### 106: Managed-task structured worker blocks remain text-coupled and can fail closed on protocol drift
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.7.14
- **Fixed**: -
- **Created**: 2026-04-08

- **Original Problem**:
  Managed-task workers still depend on long visible prose that ends with fenced protocol blocks such as
  `kodax-task-scout`, `kodax-task-contract`, `kodax-task-handoff`, and `kodax-task-verdict`.

  In practice, minor protocol drift can still break orchestration:

  1. evaluator verdicts can be rejected when structured output drifts
  2. planner / scout / handoff blocks can still fail closed on formatting variations
  3. missing protocol blocks can produce blocked runs even when visible content is otherwise useful
  4. malformed worker output can push too much raw text into failure paths, artifacts, or session memory

- **Context**:
  This issue is broader than a single evaluator bug. It is a protocol-layer reliability issue across all managed workers.
  The recent `missing kodax-task-verdict` crash / OOM chain exposed the highest-severity symptom, but the same text-coupled
  design exists for planner, scout, and handoff blocks too.

- **Planned Resolution**:
  Resolve in phases under `FEATURE_059 Managed Task Structured Protocol V2`:

  1. harden all managed parsers to accept the last valid block, JSON variants, and common field aliases
  2. keep protocol-failure UI compact while persisting raw artifacts separately
  3. move toward a dual-track model with separate `visibleText` and `protocolPayload`
  4. eventually let evaluator act as a structured verdict producer instead of relying on a prose-tail block

---

### 088: 消息列表视口布局不稳定 - 底部区域跳动/最后一行被裁剪 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.5.29
- **Fixed**: v0.5.39
- **Created**: 2026-03-16
- **Resolution Date**: 2026-03-16

- **Original Problem**:
  终端 REPL 界面存在多个布局不稳定问题：

  1. **底部区域高度跳动**：自动补全建议显示/消失、帮助面板显示/隐藏时，消息区域高度会突然变化，导致内容上下跳动
  2. **最后一行消息被裁剪**：消息列表最后一行经常被底部固定区域覆盖，不可见
  3. **状态栏换行不可预测**：窄终端下状态栏文本的换行行数与实际渲染不一致，导致 viewport budget 计算偏差
  4. **历史消息重渲染性能**：使用 Ink `<Static>` 分割历史/动态消息，但分割逻辑不够精确，长对话中仍然存在不必要的重渲染
  5. **Select 对话框选项无限制**：选项过多时可能占满整个终端，把消息区和输入区全部挤出视口
  6. **确认指令逻辑内嵌 JSX**：确认对话框的指令文本生成逻辑嵌套在 JSX 中，难以测试和复用

- **Root Cause Analysis**:
  1. 没有统一的视口行数预算机制，底部各区块高度变化无法被消息区感知
  2. 消息区依赖 Ink 的 `overflowY="hidden"` 来裁剪，但实际行数计算不考虑底部区域
  3. StatusBar 只渲染不导出纯文本格式化结果，无法在预算计算中复用
  4. 历史消息的 Static/Dynamic 分割基于最后一个 user/system 索引，但该索引变化时会导致整块消息重新分配渲染方式

- **Resolution**:

  **核心变更：Viewport Budget + Transcript Layout 架构**

  1. **新增 `viewport-budget.ts`** — 统一计算底部所有区块（输入框、补全建议、帮助栏、状态栏、确认对话框、UI 请求对话框）占用的行数，从中减去得到消息区可用行数
     - `calculateInputPromptRows()`: 考虑输入文本换行后的实际行数
     - `calculateViewportBudget()`: 汇总所有底部区块，输出 `messageRows` 和 `visibleSelectOptions`
     - 使用 `calculateVisualLayout()` 与实际渲染使用相同的文本换行算法

  2. **新增 `transcript-layout.ts`** — 将消息列表从嵌套 React 组件改为扁平的 `TranscriptRow[]` 数据模型
     - `buildTranscriptRows()`: 将所有 HistoryItem 类型转换为统一的 TranscriptRow 数组
     - `getVisibleTranscriptRows()`: 根据 viewportRows 从尾部切片，保证最新内容可见
     - `resolveTranscriptColor()`: 将语义化颜色 token 映射到 theme 实际颜色值
     - 所有文本换行使用 `calculateVisualLayout()` 与渲染保持一致

  3. **StatusBar 导出 `getStatusBarText()`** — 纯函数返回状态栏文本，供 viewport budget 和渲染共用，确保换行计算一致

  4. **重构 `MessageList`** — 移除 Static/Dynamic 分割，改为统一的 TranscriptRow 渲染
     - 移除 `<Static>` 组件（简化架构，牺牲少量长对话性能）
     - 新增 `TranscriptRowRenderer` 组件统一渲染所有行类型
     - 新增 `viewportRows` 和 `viewportWidth` props

  5. **重构 `AutocompleteSuggestions`** — 将预留空间的状态管理提升到 `InkREPLInner`
     - 移除组件内部的 `useState`/`useEffect`，改为由父组件传入 `reserveSpace`
     - `width` prop 从硬编码 80 改为动态 `terminalWidth - 2`

  6. **提取 `confirmInstruction`** — 从 JSX 内联逻辑提取为 `useMemo`，便于测试和复用

  7. **提取 `statusBarProps`** — StatusBar 的所有 props 合并为一个 `useMemo` 对象

  8. **Select 对话框选项截断** — 根据 `viewportBudget.visibleSelectOptions` 截断选项列表，避免占满视口

  9. **UI 清理** — 移除部分中文注释，emoji 改为 Unicode 转义

- **Code Review 发现的遗留问题**（未修复，需后续处理）：
  1. `model` 字段丢失 `currentConfig.model` 回退（statusBarProps 中 model fallback chain 不完整）
  2. `MessageList` 的 `paddingY={1}` 未在 viewport budget 中扣除（实际可见行少 2 行）
  3. 中文注释清理不彻底（新增了一些中文注释）
  4. `getWrappedLogicalLines()` 不做 wrap 只按换行符切片（maxLines 截断不一致）
  5. race condition 阻塞时移除了 `console.log` 无任何反馈

- **Files Changed**:
  - `packages/repl/src/ui/InkREPL.tsx` — viewport budget 集成、状态提升、props 提取
  - `packages/repl/src/ui/components/MessageList.tsx` — TranscriptRow 渲染重构
  - `packages/repl/src/ui/components/StatusBar.tsx` — 导出 getStatusBarText()
  - `packages/repl/src/ui/themes/dark.ts` — 添加 thinking 颜色
  - `packages/repl/src/ui/types.ts` — 添加 thinking 颜色到 ThemeColors
  - `packages/repl/src/ui/utils/viewport-budget.ts` — **新增** 视口预算计算
  - `packages/repl/src/ui/utils/viewport-budget.test.ts` — **新增** 预算计算测试
  - `packages/repl/src/ui/utils/transcript-layout.ts` — **新增** Transcript 数据模型
  - `packages/repl/src/ui/utils/transcript-layout.test.ts` — **新增** Transcript 测试
  - `tests/ui/MessageList.test.tsx` — 更新测试用例适配新 props

- **Tests**:
  - viewport-budget: 3 个测试用例（输入换行、综合预算、select 截断）
  - transcript-layout: 4 个测试用例（末行保留、viewport 切片、流式集成、工具进度）
  - MessageList: 14 个现有测试用例适配新 props

---

### 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.5.33
- **Fixed**: v0.5.33
- **Created**: 2026-03-13
- **Resolution Date**: 2026-03-13

- **Original Problem**:
  输入 `@.kodax/` 时，路径中的 `/` 错误地触发了命令补全，显示 `/help`、`/exit` 等命令选项。

  **期望行为**：
  - `@.kodax/` 应该只触发文件补全，不触发命令补全
  - `/` 和 `@` 在输入中段时，前面必须有空格才能触发补全（参考 Claude Code 的实践）

- **Root Cause Analysis**:
  1. `CommandCompleter.canComplete()` 只检查最后一个 `/` 后是否有空格，没有检查 `/` 是否在有效的命令位置
  2. `ArgumentCompleter.canComplete()` 有同样的问题
  3. `SkillCompleter.canComplete()` 也有类似问题
  4. `AutocompleteProvider.shouldTrigger()` 的触发条件不够严格
  5. `FileCompleter.canComplete()` 对 `@` 的触发条件也不够严格

- **Reproduction**:
  1. 输入 `@.kodax/`
  2. 观察到补全列表显示 `/help`、`/exit` 等命令（错误）
  3. 预期只显示目录内容

- **Resolution**:

  **统一触发规则**：
  - `/` 或 `@` 在输入开头（位置 0）→ 触发
  - `/` 或 `@` 不在开头，但前面有空格 → 触发
  - 其他情况 → 不触发

  **修改的文件和逻辑**：

  1. **`autocomplete.ts` - FileCompleter.canComplete()**
     ```typescript
     // If @ is not at the start, it must be preceded by a space
     if (lastAtIndex > 0 && beforeCursor[lastAtIndex - 1] !== ' ') {
       return false;
     }
     ```

  2. **`autocomplete.ts` - CommandCompleter.canComplete()**
     ```typescript
     // If / is not at the start, it must be preceded by a space
     if (lastSlashIndex > 0 && beforeCursor[lastSlashIndex - 1] !== ' ') {
       return false;
     }
     ```

  3. **`autocomplete-provider.ts` - shouldTrigger()**
     ```typescript
     const hasValidSlash =
       lastSlashIndex === 0 || // / at start
       (lastSlashIndex > 0 && beforeCursor[lastSlashIndex - 1] === ' ');

     const hasValidAt =
       lastAtIndex === 0 || // @ at start
       (lastAtIndex > 0 && beforeCursor[lastAtIndex - 1] === ' ');
     ```

  4. **`argument-completer.ts` - ArgumentCompleter.canComplete()** - 同样的空格检查

  5. **`skill-completer.ts` - SkillCompleter.canComplete()** - 同样的空格检查

- **Verification**:
  | 输入 | @文件补全 | /命令补全 | 预期 |
  |------|:---------:|:---------:|:----:|
  | `@.kodax/` | ✅ | ❌ | ✅ 原问题已解决 |
  | `text @src/` | ✅ | ❌ | ✅ |
  | `text@src/` | ❌ | ❌ | ✅ 防止误触发 |
  | `/help` | ❌ | ✅ | ✅ |
  | `text /help` | ❌ | ✅ | ✅ |
  | `text/help` | ❌ | ❌ | ✅ 防止误触发 |
  | `请看 @src/` | ✅ | ❌ | ✅ |
  | `请看@src/` | ❌ | ❌ | ✅ |

- **Files Modified**:
  - `packages/repl/src/interactive/autocomplete.ts` - FileCompleter, CommandCompleter
  - `packages/repl/src/interactive/autocomplete-provider.ts` - shouldTrigger
  - `packages/repl/src/interactive/completers/argument-completer.ts` - ArgumentCompleter
  - `packages/repl/src/interactive/completers/skill-completer.ts` - SkillCompleter

- **Tests**:
  - 所有 71 个现有测试通过
  - TypeScript 编译成功

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

### 013: 自动补全缓存内存泄漏风险 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.6.17
- **Created**: 2026-02-19
- **Resolution Date**: 2026-03-23
- **Original Problem**:
  ```typescript
  setTimeout(() => this.cache.delete(dir), this.cacheTimeout);
  ```
  - 使用 `setTimeout` 进行缓存过期清理，在高频率调用时可能导致大量定时器积压和内存无法及时释放
- **Context**: `packages/repl/src/interactive/autocomplete.ts` - 行 95-110
- **Proposed Solution**: 使用 LRU cache with TTL 替代 setTimeout

---

### 014: 语法高亮语言支持不全 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.6.17
- **Created**: 2026-02-19
- **Resolution Date**: 2026-03-23
- **Original Problem**:
  ```typescript
  function highlightCode(code: string, _language: string): string {
    const keywords = /\b(const|let|var|...)\b/g;
    // _language 参数未使用
  }
  ```
  - 无法针对不同语言高亮（Python、Go、Rust 等）
  - 关键词列表只覆盖 JavaScript/TypeScript
- **Context**: `packages/repl/src/interactive/markdown-render.ts` - 行 43-65
- **Proposed Solution**: 添加多语言关键词集 或 集成 `highlight.js` / `prism` 库

---

### 015: Unicode 检测不完整 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.6.17
- **Created**: 2026-02-19
- **Resolution Date**: 2026-03-23
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
- **Context**: `packages/repl/src/interactive/themes.ts` - 行 93-101
- **Proposed Solution**: 在启动时检测并缓存代码页设置结果

---

### 017: TextBuffer 未使用方法 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.6.17
- **Created**: 2026-02-19
- **Resolution Date**: 2026-03-23
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
- **Context**: `packages/repl/src/ui/utils/text-buffer.ts` - 行 436-445
- **Proposed Solution**: 保留作为未来扩展点 或 删除如果确定不需要

---

### 018: TODO 注释未清理 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.3.1 (auto-detected)
- **Fixed**: v0.6.17
- **Created**: 2026-02-19
- **Resolution Date**: 2026-03-23
- **Original Problem**:
  ```typescript
  // 应用主题 (使用默认 dark 主题)
  // TODO: 从配置文件读取主题设置
  const theme = getCurrentTheme();
  ```
  - 代码中留有 TODO 注释，表明主题配置功能尚未完全实现
- **Context**: `packages/repl/src/interactive/repl.ts` - 行 112-113
- **Proposed Solution**: 实现功能 或 转换为 issue 追踪 或 移除注释

---

### 055: Built-in Skills 未完全符合 Agent Skills 规范 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.4.7
- **Fixed**: v0.6.17
- **Created**: 2026-03-01
- **Resolution Date**: 2026-03-23
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

### 061: Windows Terminal 流式输出时滚轮滚动异常 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.4.5
- **Fixed**: v0.6.17
- **Created**: 2026-03-02
- **Resolution Date**: 2026-03-23
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

### 077: Skills 系统高级功能未完全实现 (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.5.5
- **Fixed**: v0.6.17
- **Created**: 2026-03-04
- **Resolution Date**: 2026-03-23
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
  `packages/ai` 已经补上了一批 provider / reasoning 相关单元测试，但覆盖仍不完整。当前 issue 已从“完全没有单元测试”收敛为“关键基础层测试覆盖仍然偏薄”。

  当前仍需继续补齐的模块：
  - `providers/base.ts` - Provider 基类行为与回退链
  - `providers/registry.ts` - Provider 注册、配置状态与默认快照
  - `providers/gemini-cli.ts` - Gemini CLI 凭证提取和桥接边界
  - `providers/codex-cli.ts` - Codex CLI 凭证提取和桥接边界
  - `providers/anthropic.ts` / `providers/openai.ts` - 更贴近真实 stream 执行路径的契约测试

- **Expected Behavior**:
  - 测试覆盖率应达到 80%+
  - 至少覆盖：凭证提取、消息转换、SSE 解析、错误处理

- **Impact**: 中等
  - 无法保证代码质量和回归测试
  - 重构时容易引入 bug
  - 新增 provider 时缺乏参考模式

- **Current Coverage**:
  - 已有测试：`reasoning-overrides.test.ts`
  - 已有测试：`providers/anthropic-message-serialization.test.ts`
  - 已有测试：`providers/anthropic-reasoning-capability.test.ts`
  - 已有测试：`providers/capability-profile.test.ts`
  - 已有测试：`providers/openai-reasoning-capability.test.ts`
  - 已有测试：`providers/streaming-robustness.test.ts`

- **Context**:
  - 项目全局测试覆盖要求见 `~/.claude/rules/common/testing.md`
  - IMPROVEMENT_CLI_PROVIDERS.md 中也提到了此问题 (P0)

- **Phase 1 Progress (2026-03-23)**:
  - 新增 `providers/base.test.ts`
  - 新增 `providers/registry.test.ts`
  - 新增 `providers/cli-bridge-providers.test.ts`
  - 问题仍保持 Open，后续继续补 CLI bridge 与真实 provider stream 契约测试

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

### 089: Feature / Design / Summary 元数据漂移 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.6.10
- **Fixed**: v0.6.10
- **Created**: 2026-03-18
- **Resolution Date**: 2026-03-19

- **Original Problem**:
  KodaX 依赖 `FEATURE_LIST.md`、各版本 feature design、summary 区块和发布元数据作为 project truth，但这些内容目前仍需要人工同步。计数、状态、规划版本和设计文档头部信息在多次编辑或发版准备后容易漂移；即使人工修正了某一次快照，流程本身仍然脆弱。

- **Expected Behavior**:
  - feature / issue summary、版本统计、planned / released 字段、design doc header 应保持一致，或在不一致时直接报错
  - self-hosting 工作流和后续自动化不应依赖过期元数据

- **Context**:
  - `docs/FEATURE_LIST.md`
  - `docs/features/v0.7.0.md`
  - `docs/features/v0.8.0.md`
  - `docs/features/v1.0.0.md`

- **Root Cause**:
  1. 多个 Markdown 文件同时承载重叠的真相字段
  2. 缺少 consistency validator 或 summary regeneration
  3. 缺少 CI / release guard 在元数据漂移时阻断流程

- **Proposed Solution**:
  - 实施 `FEATURE_026 Roadmap Integrity and Tracker Consistency Hardening`
  - 为 tracker 建立校验和自动汇总能力，并在发版前强制运行

- **Resolution**:
  - 新增 `tests/tracker-consistency.test.ts`，把 `FEATURE_LIST.md` 的版本信息与 summary 真相字段、`KNOWN_ISSUES.md` 的 summary 计数与最高优先级 open issue、以及 feature design 文件存在性变成可执行校验
  - 这次只覆盖 089 根因对应的关键元数据，不把当前历史 Markdown 结构差异一并扩大成新的 blocker
  - 基于新测试修正了 `KNOWN_ISSUES.md` summary 的总数、open/resolved 计数和最高优先级 open issue 选择逻辑

- **Files Changed**:
  - `tests/tracker-consistency.test.ts`
  - `docs/KNOWN_ISSUES.md`

- **Tests Added**:
  - `npm test -- tests/tracker-consistency.test.ts`

---

### 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.6.10
- **Fixed**: v0.6.10
- **Created**: 2026-03-18
- **Resolution Date**: 2026-03-19

- **Original Problem**:
  `gemini-cli`、`codex-cli` 目前被作为一等 provider 暴露，但桥接路径会把会话内容压成最后一条用户 prompt，并在 ACP session 创建时传入空的 `mcpServers`。这会让用户误以为桥接 provider 与原生 provider 具备相同上下文和连接器语义，实际上存在静默降级。

- **Expected Behavior**:
  - bridge provider 的上下文、MCP、reasoning 能力边界必须被明确暴露
  - 不支持的能力不应静默丢失
  - 在可行情况下，多轮上下文语义应尽量保持一致

- **Context**:
  - `packages/ai/src/providers/acp-base.ts`
  - `packages/ai/src/cli-events/acp-client.ts`
  - `packages/ai/src/providers/gemini-cli.ts`
  - `packages/ai/src/providers/codex-cli.ts`
  - `packages/ai/src/providers/registry.ts`

- **Root Cause**:
  1. pseudo ACP bridge 将外部 CLI 视作普通 provider 适配
  2. provider capability contract 没有区分 native API 与 CLI bridge
  3. 缺少 bridge-provider 的语义兼容性测试

- **Proposed Solution**:
  - 实施 `FEATURE_029 Provider Adapter Transparency and Semantic Compatibility`
  - 配合 `FEATURE_027 Native MCP and Connector Runtime` 补足真实连接器路径

- **Resolution**:
  - 新增 provider capability profile 合同，显式区分 `native-api` 与 `cli-bridge` 两类 transport，并记录上下文语义 (`full-history` / `last-user-message`) 与 MCP 支持边界
  - 将 `gemini-cli`、`codex-cli` 的 bridge 语义固化到 provider snapshot 与 provider base override 中，避免它们继续被 UI 和上层逻辑当作“原生等价 provider”
  - 在 REPL 的 `/model` 列表和 `/status` 输出中直接暴露 bridge provider 的限制：只转发最新一条用户消息，且 MCP 不可用
  - 为 capability metadata 和用户可见 disclosure 新增回归测试，后续若 bridge provider 再次被误标成原生语义，测试会直接失败

- **Files Changed**:
  - `packages/ai/src/types.ts`
  - `packages/ai/src/providers/capability-profile.ts`
  - `packages/ai/src/providers/base.ts`
  - `packages/ai/src/providers/acp-base.ts`
  - `packages/ai/src/providers/registry.ts`
  - `packages/ai/src/providers/registry.js`
  - `packages/ai/src/providers/index.ts`
  - `packages/ai/src/providers/custom-provider.ts`
  - `packages/ai/src/providers/custom-registry.ts`
  - `packages/ai/src/index.ts`
  - `packages/coding/src/providers/index.ts`
  - `packages/coding/src/index.ts`
  - `packages/repl/src/common/utils.ts`
  - `packages/repl/src/interactive/commands.ts`

- **Tests Added**:
  - `packages/ai/src/providers/capability-profile.test.ts`
  - `packages/repl/src/interactive/provider-capabilities.test.ts`
  - `tests/tracker-consistency.test.ts`（持续校验 tracker summary / highest-priority open issue，防止 issue 状态回写再次漂移）

---

### 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前 runtime 仍主要依赖本地文件工具和 shell。对于 MCP、web search、web fetch、code search 这类现代 coding agent 的核心工具族，尚未提供一等公民的结构化实现，导致很多任务只能退回到 bash 或外部 CLI，削弱了安全性、可解释性和产品竞争力。

- **Expected Behavior**:
  - KodaX 应提供结构化、可授权、可归因的 MCP / search / retrieval 工具
  - 外部证据和代码探索结果应具备统一的数据模型和权限边界
  - 研究型与验证型任务不应过度依赖临时 shell 命令

- **Context**:
  - `packages/coding/src/tools/`
  - `packages/repl/`
  - `README.md` 当前能力声明

- **Root Cause**:
  1. 早期优先完成了本地读写与 project workflow
  2. 尚未建立统一的 connector / retrieval abstraction
  3. 尚未建立 evidence-carrying result model

- **Proposed Solution**:
  - 实施现有 `FEATURE_035 MCP 能力 Provider`
  - 实施现有 `FEATURE_028 First-Class 搜索检索与证据工具`
  - 以 `FEATURE_034 Extension + Capability Runtime` 作为连接器与能力运行时底座

---

### 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (OPEN)
- **Priority**: High
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 已经在 CLI 层暴露了 `--team` 和 orchestration 能力，但产品层面仍缺少原生 subagent 角色模型、权限边界、任务路由、证据聚合和与 project truth 的深度集成。当前能力更像并行 runner，而不是成熟的多 Agent 产品。

- **Expected Behavior**:
  - 多 Agent 能力应具备明确的角色语义、状态聚合和 review 边界
  - Team 模式应与 Session Tree、Project Harness、feature truth 协同工作
  - CLI 暴露的能力边界应与真实产品成熟度一致

- **Context**:
  - `src/kodax_cli.ts`
  - `packages/coding/src/orchestration.ts`
  - `docs/FEATURE_LIST.md` 中的 `FEATURE_022`

- **Root Cause**:
  1. 已具备 orchestration plumbing，但 subagent product model 尚未完成
  2. 缺少共享 evidence model 和 role-aware execution layer
  3. 当前 Team mode 仍未与后续 session / harness 体系完全打通

- **Proposed Solution**:
  - `FEATURE_067 Parallel Task Dispatch` (v0.7.18) 作为最小可用切片：Scout 识别可并行子任务 → `runOrchestration` 并行派发 → 聚合结果
  - 完整的 Team Agent 架构 (角色语义/状态聚合/review 边界) 留 v0.8.0 与 FEATURE_059 (Protocol V2) 同版本

---

### 093: 缺少 IDE / Desktop / Web 一体化分发表面 (OPEN)
- **Priority**: Low (2026-04-11 降级: Vibe Coding 时代 terminal 是主入口，IDE Bridge 非关键)
- **Status**: Open
- **Introduced**: v0.6.10
- **Created**: 2026-03-18

- **Original Problem**:
  KodaX 当前主要提供 terminal 与 library 形态，缺少 IDE、desktop、web 等分发表面，因此无法很好承载文件上下文注入、可视化 diff review、远程长任务监控和跨设备会话接力等场景。

- **Expected Behavior**:
  - 至少应具备一个 IDE integration、一个 desktop review surface 和一个 remote / web long-running task surface
  - 不同表面之间应共享同一引擎、session 和 project context

- **Context**:
  - `README.md`
  - `packages/repl/`
  - 当前仓库中缺少对应 app / sdk surface 目录

- **Priority Downgrade Rationale (2026-04-11)**:
  基于 KodaX vs Claude Code 全面对比分析，IDE Bridge 的优先级从 Medium 降级为 Low：
  1. Vibe Coding 范式下对话终端是主入口，不是 IDE 编辑器
  2. KodaX 已有 terminal host 检测 (FEATURE_051)，在 VSCode 集成终端中可正常工作
  3. Cursor/Windsurf/Copilot 已占领 IDE 原生 AI 赛道，KodaX 的核心差异化 (AMA/多 Provider/Repo Intelligence) 全部是 CLI-native
  4. 建 IDE bridge 是高成本低差异化投入 (Claude Code 的 bridge 有 25+ 文件)

- **Root Cause**:
  1. 研发重心长期集中在 CLI 与 project workflow
  2. 缺少统一的 surface protocol 与 session handoff layer
  3. 尚未形成跨表面的产品抽象

- **Proposed Solution**:
- 长期目标：实施 `FEATURE_030 Multi-Surface Delivery`
- 短期：依赖 terminal host 检测 + IDE 集成终端作为分发面
- 在 terminal UX 和 multi-agent 基础稳定后再评估是否需要原生 IDE 集成

---

### 094: 核心工作流文件与函数过大，职责耦合导致重构成本持续上升 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经本轮逐条核对后确认，仓库里仍有多处核心 runtime 文件与主函数承担了过多职责，已经明显超出“单点修补”可持续维护的范围。相关代码同时混合了参数解析、状态推进、权限判断、会话保存、工具调度、provider 适配与 UI / harness 协调，导致回归风险高、修改面大、代码评审成本持续上升。

- **Expected Behavior**:
  - 核心工作流应按职责拆分为可单测、可替换的子模块
  - 入口函数应主要负责编排，不应同时承担解析、执行、持久化和展示细节
  - handler / evaluator 层应具备清晰的输入输出类型边界

- **Context**:
  - `packages/repl/src/interactive/project-commands.ts`
  - `packages/repl/src/interactive/project-harness.ts`
  - `packages/coding/src/repo-intelligence/query.ts`
  - `src/kodax_cli.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/ai/src/providers/anthropic.ts`
  - `packages/ai/src/providers/openai.ts`

- **Source Debt IDs**:
  - `C5`, `C6`, `H1`, `H2`, `H3`, `H4`, `H5`, `H6`, `H7`, `H8`, `H9`, `H10`

- **Root Cause**:
  1. 功能长期沿着现有入口持续堆叠，缺少阶段性模块化回收
  2. 运行时状态与副作用分布在同一层，导致拆分边界不清晰
  3. 项目 workflow、REPL runtime 与 provider stream 演进速度不一致，最终集中在少数超大文件中

- **Proposed Solution**:
  - 先从 `project-commands.ts`、`project-harness.ts`、`kodax_cli.ts` 开始按职责拆分
  - 把 `agent.ts` 的执行编排继续下沉到独立 helper / service 层
  - 为 provider `stream()` 拆出 event parsing、delta normalization、tool result serialization 等子模块

---

### 095: Agent / REPL 主流程仍存在重复编排与手写运行时流程 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  虽然本轮已经消掉了一部分重复逻辑，但 agent 与 REPL 主流程里仍残留多段手写的执行编排代码，包括 reroute、权限前置、会话保存、git / shell 调度和直接修改运行时上下文的路径。它们在行为上高度相关，却没有统一抽象，后续继续演进时很容易再次漂移。

- **Expected Behavior**:
  - 相同语义的运行时流程应复用统一 helper，而不是在多个入口重复实现
  - 会话持久化、权限执行、reroute 策略和错误分类应集中在清晰的边界层
  - REPL context 更新应通过收敛后的状态接口完成，而不是在多处直接改写字段

- **Context**:
  - `packages/coding/src/agent.ts`
  - `packages/repl/src/interactive/repl.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/coding/src/prompts/builder.ts`

- **Source Debt IDs**:
  - `H38`, `H39`, `H40`, `H41`, `H44`, `M39`

- **Root Cause**:
  1. 不同入口在不同时期各自补齐了相似的 runtime 行为
  2. 会话状态与权限模型缺少统一的 façade 层
  3. 历史上更强调尽快打通功能路径，而不是抽象复用

- **Proposed Solution**:
  - 提炼统一的 permission-aware execution helper
  - 收敛 session snapshot / save / title 更新等流程到可复用 API
  - 将 reroute / git evidence / shell evidence 之类的相邻逻辑合并到单一编排层

---

### 096: 类型边界过宽且共享可变状态较多 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  当前代码库仍有一批 “先用 `any` / `unknown` / 断言打通，再在下游兜底” 的边界，以及若干共享可变状态、公共可变容器和原地修改对象的实现。这类问题短期不一定直接出错，但会削弱重构信心，也会让 provider / skills / session 相关代码更难建立稳定的类型约束。

- **Expected Behavior**:
  - 外部输入、provider 事件、skill 上下文和 registry 应尽量使用显式类型与 type guard
  - 共享状态应最小化暴露面，避免 public mutable collection 和原地修改
  - session / routing / registry 相关模型应尽量复用统一类型定义

- **Context**:
  - `packages/ai/src/providers/anthropic.ts`
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/acp/pseudo-acp-server.ts`
  - `packages/skills/src/skill-registry.ts`
  - `packages/repl/src/interactive/plan-mode.ts`
  - `packages/repl/src/interactive/new-command.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
  - `packages/repl/src/permission/executor.ts`

- **Source Debt IDs**:
  - `H7`
  - `H10`, `H11`, `H12`, `H13`, `H14`, `H15`, `H16`
  - `H42`, `H43`, `H44`, `H45`, `H46`, `H47`
  - `M21`, `M22`, `M23`, `M24`
  - `M6`, `M40`, `M42`, `M43`, `M44`, `M46`, `M47`, `M48`, `M49`, `M67`
  - `L22`, `L27`, `L32`, `L37`

- **Root Cause**:
  1. 多数边界最初优先保证联通性，类型建模滞后
  2. registry / session / tool runtime 各自独立演进，导致共享模型碎片化
  3. 一部分对象被默认当作可变工作区使用，没有及时收敛成不可变接口

- **Proposed Solution**:
  - 先清理 provider 与 ACP 边界的 `any` / 断言
  - 为 skill registry、session storage、routing snapshot 建立统一模型
  - 逐步把 public mutable state 改成受控 accessor 或不可变更新

---

### 097: 错误处理、阻塞式 I/O 与执行侧副作用清理仍不完整 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  一批较低风险但会持续侵蚀可观测性的技术债仍然存在，包括静默 `catch`、fire-and-forget async 路径、同步文件系统调用、执行链路里的库层 `console.*` 副作用，以及少数仍依赖 shell / editor / discovery 副作用的分支。它们不像前几批安全问题那样紧急，但会让错误更难定位，也会限制后续把运行时行为统一收口。

- **Expected Behavior**:
  - 静默吞错应仅出现在明确可接受的 best-effort 路径，并附带注释或日志策略
  - 热路径中的同步 I/O 应迁移到缓存或异步接口
  - library / loader / discovery 层应避免直接向控制台输出副作用
  - 命令执行的剩余边角路径应继续向统一执行抽象收敛

- **Context**:
  - `packages/repl/src/common/utils.ts`
  - `packages/repl/src/common/compaction-config.ts`
  - `packages/repl/src/common/permission-config.ts`
  - `packages/repl/src/interactive/plan-storage.ts`
  - `packages/repl/src/permission/permission.ts`
  - `packages/repl/src/permission/executor.ts`
  - `packages/coding/src/tools/read.ts`
  - `packages/coding/src/tools/grep.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H19`, `H20`, `H21`, `H22`, `H23`, `H24`, `H25`, `H26`, `H27`, `H28`, `H29`, `H30`
  - `H48`, `H51`, `H52`, `H54`, `H55`, `H58`
  - `M38`
  - `L10`, `L17`, `L23`, `L26`

- **Root Cause**:
  1. 早期实现大量依赖 best-effort fallback，缺少统一的日志/遥测约束
  2. 部分工具和 loader 仍沿用同步 I/O 以降低实现复杂度
  3. 执行层的命令、编辑器和技能发现路径没有完全统一到同一套运行时约束

- **Proposed Solution**:
  - 为允许静默失败的路径建立显式注释和统一 helper
  - 逐步替换热路径同步 I/O，并对保留的同步路径注明原因
  - 把 loader / discovery / permission 侧的 `console.*` 收敛到 logger
  - 继续收口剩余 command execution 分支到权限感知的执行抽象

- **Phase 1 Progress (2026-03-23)**:
  - `packages/coding/src/tools/read.ts` 改为基于 `fs.stat()` 的异步可访问性检查，移除了 `existsSync`
  - `packages/coding/src/tools/grep.ts` 改为异步路径探测，并为不可访问路径补充明确错误信息
  - `packages/repl/src/common/utils.ts` 为版本号与 `feature_list.json` 进度读取增加缓存，降低热路径同步 I/O 频率
  - `packages/repl/src/common/permission-config.ts`、`packages/repl/src/common/plan-storage.ts` 为保留的 best-effort 静默失败补上显式注释
  - `packages/repl/src/permission/executor.ts` 移除了临时脚本检查里的同步 `existsSync`
  - `packages/repl/src/permission/permission.ts` 为路径 canonicalization 和系统 temp 目录解析增加缓存，减少重复同步文件系统探测
  - 问题仍保持 Open，后续继续清理剩余权限路径解析同步逻辑与执行侧副作用

---

### 098: 重复 helper、兼容层导出、魔法数字与硬编码字符串需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  经核对后仍有一批低风险但会持续制造噪音的清理项，包括重复 helper、长期保留的兼容层导出、仓库内无人消费的遗留 API、魔法数字、硬编码提示字符串，以及若干轻量级设计瑕疵。单个问题都不大，但累计起来会影响可读性，也会提高理解成本。

- **Expected Behavior**:
  - helper / utility 应优先复用而不是多处复制
  - 兼容层与 deprecated 导出应有明确退场计划
  - 算法阈值、缓存大小和提示文案应以命名常量或共享常量表达
  - 轻量级设计瑕疵应在不破坏兼容的前提下逐步收敛

- **Context**:
  - `packages/repl/src/ui/utils/message-utils.ts`
  - `packages/repl/src/ui/utils/textUtils.ts`
  - `packages/coding/src/providers/index.ts`
  - `packages/coding/src/reasoning.ts`
  - `packages/agent/src/compaction/compaction.ts`
  - `packages/skills/src/file-tracker.ts`
  - `packages/skills/src/discovery.ts`

- **Source Debt IDs**:
  - `H32`, `H33`, `H34`
  - `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, `M9`, `M11`, `M12`, `M13`, `M14`, `M15`, `M17`, `M18`, `M19`, `M20`
  - `M26`, `M27`, `M28`, `M29`, `M30`, `M31`, `M32`, `M33`, `M34`, `M35`, `M36`, `M41`, `M45`, `M52`, `M53`, `M54`, `M55`, `M56`, `M58`
  - `L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `L8`, `L11`, `L12`, `L13`, `L14`, `L18`, `L19`, `L20`, `L21`, `L25`, `L31`, `L33`

- **Root Cause**:
  1. 多数条目来源于兼容层保留、局部复制粘贴和快速迭代残留
  2. 一些常量原本只在局部使用，后续没有及时抽象或命名
  3. 文案、缓存和占位实现长期存在，但缺少集中清理窗口

- **Proposed Solution**:
  - 先清理无人消费的 helper / export / placeholder
  - 收敛重复字符串与阈值常量
  - 对仍需兼容保留的导出明确 deprecation 注释和删除条件

---

### 099: 测试辅助代码重复，局部验证资产需要收敛 (OPEN)
- **Priority**: Low
- **Status**: Open
- **Introduced**: v0.6.13
- **Created**: 2026-03-22

- **Original Problem**:
  除了已单独跟踪的 `082 packages/ai 缺少单元测试` 之外，当前测试资产本身也存在一批结构性债务，包括超大的测试文件、重复实现 helper、散落的 scratch / 临时验证脚本，以及若干直接依赖硬编码常量的断言。这类问题会降低新增测试的速度，也会让回归定位变得更慢。

- **Expected Behavior**:
  - 通用测试 helper 应抽到共享位置，而不是在多个测试文件内重复实现
  - scratch / 临时验证脚本应清理或迁移到明确的实验目录
  - 大测试文件应按模块拆开，覆盖目标更清晰

- **Context**:
  - `packages/repl/src/interactive/interactive.test.ts`
  - `packages/repl/src/ui/session-history.test.ts`
  - `packages/repl/src/ui/banner.test.ts`
  - `src/cli_option_helpers.test.ts`
  - `tests/kodax_core.test.ts`
  - `tests/scratch/test-retry.ts`

- **Source Debt IDs**:
  - `H12`, `H60`
  - `M10`, `M11`, `M12`, `M59`, `M60`, `M61`, `M62`, `M63`, `M65`, `M68`
  - `L28`, `L29`, `L30`

- **Root Cause**:
  1. 测试在不同阶段由不同模块各自补齐，复用层没有同步建设
  2. 临时验证资产在问题解决后没有及时回收
  3. 对测试代码的整洁度要求低于生产代码，导致债务长期累积

- **Proposed Solution**:
  - 提取共享 test helper，并拆分超大测试文件
  - 清理或迁移 `tests/scratch` 中已失效的实验资产
  - 为测试资产建立最小限度的 lint / consistency 约束

---

### 100: ACP Server 缺少日志/可观测性输出 (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.6.15
- **Fixed**: v0.6.15
- **Created**: 2026-03-23
- **Resolution Date**: 2026-03-23

- **Original Problem**:
  执行 `kodax acp serve` 启动 ACP Server 后，整个进程完全静默，无任何启动信息、运行状态或错误输出。与 REPL 模式（有 Banner、StatusBar、错误提示等丰富反馈）形成鲜明对比。

  **缺失的日志场景**：

  | 阶段 | 当前状态 |
  |------|----------|
  | 服务启动 | 无输出，不知道 provider/model/cwd/mode |
  | initialize 握手 | 无日志 |
  | newSession 创建 | 无日志（session ID、cwd、mode） |
  | prompt 请求/响应 | 无日志（请求内容、stopReason、耗时） |
  | 权限协商 | 无日志（工具名、决策结果） |
  | 错误/异常 | 仅 1 处 console.error（L610 notification 发送失败） |
  | 服务关闭 | 无日志 |

  **根因分析**：
  1. `runAcpServer()` 将 `process.stdin` 和 `process.stdout` 绑定给 `ndJsonStream`，stdout 被 ACP 协议占用
  2. `console.log()` 写入 stdout 会污染 JSON Lines 输出，导致客户端解析错误
  3. `console.error()` 是唯一安全的日志通道，但整份 `acp_server.ts` 仅在 L610 使用了一处
  4. 无 `--verbose` / `KODAX_DEBUG` / `LOG_LEVEL` 等调试开关
  5. 无结构化日志（JSON log line / timestamp / level）
  6. 无启动信息摘要（provider、model、cwd、permission mode）

- **Expected Behavior**:
  - 启动时应输出启动摘要到 stderr（provider、model、cwd、mode、version）
  - 关键生命周期事件应输出到 stderr（session 创建/关闭、prompt 开始/结束、权限请求）
  - 错误应输出到 stderr，包含上下文信息（session ID、工具名、错误原因）
  - 支持 `--verbose` 或环境变量控制日志级别（off / error / info / debug）

- **Context**:
  - `src/acp_server.ts` — `KodaXAcpServer` 类，622 行
  - `src/kodax_cli.ts` — `acp serve` 子命令（L806-837）
  - REPL 模式通过 `KodaXEvents` 回调实现丰富反馈，ACP 模式缺少等价机制

- **Proposed Solution**:
  1. 新增 `acp-logger.ts`，将所有日志输出到 `process.stderr`，避免污染 ACP stdout
  2. 启动时输出摘要：`[ACP] KodaX v{version} | provider={provider} model={model} cwd={cwd} mode={mode}`
  3. 在 `initialize`、`newSession`、`prompt`、`cancel`、`setSessionMode` 入口添加生命周期日志
  4. 在 `evaluateToolPermission` 和 `requestPermissionFromClient` 添加权限决策日志
  5. 支持 `KODAX_ACP_LOG=debug|info|error|off` 环境变量控制日志级别
  6. 错误日志包含 session ID 和上下文，便于排查

- **Resolution**:
  1. 新增 `src/acp_logger.ts`，统一将 ACP 日志写入 `stderr`，并支持 `off / error / info / debug` 四级日志级别
  2. `KodaXAcpServer` 现在会记录启动摘要、`initialize`、`newSession`、`setSessionMode`、`prompt start/finish`、`cancel` 等关键生命周期事件
  3. 权限协商链路补上了请求、授权、拒绝、remembered allow、客户端断开等日志
  4. 原来 notification 发送失败时零散的 `console.error` 已统一收口到 ACP logger
  5. CLI 帮助和 README / README_CN 已补充 `KODAX_ACP_LOG` 说明，方便用户调节 ACP 日志详细度

- **Superseded Design Note (Historical Context)**:
  当前修复解决了“ACP 完全静默、无法排障”的发布阻塞问题，但实现仍偏务实：`acp_server.ts` 直接在生命周期节点里调用 logger，运行时事件与日志文案仍然耦合在一起。

  **后续更优雅的重构方向**：
  1. 引入 `acp_events.ts` 或等价模块，定义强类型 ACP 运行时事件，例如 `server_attached`、`session_created`、`prompt_started`、`prompt_finished`、`permission_requested`、`permission_granted`、`notification_failed`
  2. `acp_server.ts` 只负责发出结构化事件，不直接拼接日志文案
  3. `acp_logger.ts` 退化为一个 sink / formatter，专门负责把事件渲染到 `stderr`
  4. 后续可以在不触碰 ACP 协议逻辑的前提下新增其他 sink，例如 JSON 日志、文件日志、IDE debug console、遥测上报
  5. 测试层也可以从“断言字符串日志”进一步升级为“断言发出了哪些 runtime events”，让协议逻辑与展示逻辑解耦

  **设计结论**：
  - 当前版本适合作为可发版修复
  - 后续应继续把 ACP 可观测性从“直接写日志”收敛到“运行时事件 + sink”架构
  - 等进入下一轮 ACP 清理时，应优先按这一方案演进，而不是继续在 `acp_server.ts` 内追加零散日志调用

- **Architecture Update**:
  - The follow-up refactor is now landed: `src/acp_events.ts` defines structured ACP runtime events plus the shared emitter/sink contract.
  - `src/acp_server.ts` now emits runtime events instead of directly composing log strings in protocol handlers.
  - `src/acp_logger.ts` now acts as the default `stderr` sink/formatter for those events.
  - `KodaXAcpServerOptions` now supports `eventSinks`, so additional sinks can be attached without touching ACP protocol flow.
  - ACP tests now assert runtime events directly and keep only a small `stderr` integration surface for the default sink.
- **Files Changed**:
  - `src/acp_events.ts`
  - `src/acp_logger.ts`
  - `src/acp_server.ts`
  - `src/index.ts`
  - `src/kodax_cli.ts`
  - `README.md`
  - `README_CN.md`
  - `tests/acp_server.test.ts`
  - `tests/kodax_cli.test.ts`

- **Tests**:
  - `npx vitest run tests/acp_server.test.ts tests/kodax_cli.test.ts`
  - `npx tsc -p tsconfig.json --noEmit`

---

### 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (RESOLVED)
- **Priority**: High
- **Status**: Resolved
- **Introduced**: v0.7.5
- **Fixed**: v0.7.5
- **Created**: 2026-03-27
- **Resolution Date**: 2026-03-27
- **Original Problem**:
  In adaptive multi-agent code review, the user can see Generator start streaming review findings, but after a few hundred characters the text disappears from the UI. Then Evaluator takes over and may report that the generator review was truncated or incomplete.
  This creates two concrete failures:
  1. The user loses the original Generator review text instead of being able to inspect it as part of the task transcript.
  2. Evaluator may be judging a truncated handoff summary rather than the full review body, so the final review can be misleading.
- **Expected Behavior**:
  1. Important output from non-terminal workers should remain visible as transcript history rather than existing only as temporary streaming text.
  2. For review / audit / analysis tasks, Evaluator should receive the full upstream review content or a full artifact reference, not only a short truncated summary.
  3. The final user-facing answer should be the final code review, not a meta-evaluation of the generator's review.
- **Affected Components**:
  - packages/coding/src/orchestration.ts
  - packages/coding/src/task-engine.ts
  - packages/repl/src/ui/InkREPL.tsx
  - packages/repl/src/ui/utils/message-utils.ts
  - CLI / REPL managed-task streaming surfaces
- **Reproduction**:
  1. Trigger a code review request that routes into H1, H2, or H3 managed-task execution.
  2. Watch Generator begin streaming review findings.
  3. Observe that the visible streamed text disappears after the task completes or when Evaluator takes over.
  4. Observe that Evaluator reports the upstream review as truncated, incomplete, or only partially verifiable.
- **Root Cause Analysis**:
  1. **The UI preserves only the terminal worker's final message**
     The streamed Generator text is shown live, but the final persisted assistant output comes from the terminal worker, which is Evaluator. When the round completes, the UI resolves history from the final assistant message and clears the transient response buffer, so the earlier generator text vanishes.
  2. **The worker-to-worker handoff is lossy**
     The orchestration runner builds worker summary from truncateText(result.lastText, 400), and dependency handoff prefers that summary. As a result, Evaluator often receives only a clipped summary instead of the full review body.
  3. **The review-specific final-answer contract is wrong**
     The current user-facing semantics encourage Evaluator to describe its work as an evaluation of the generator review, rather than delivering a merged and verified final review.
- **Impact**:
  - Final code review quality can depend on incomplete evidence
  - User trust in adaptive multi-agent review drops because the flow looks self-contradictory
  - Token cost increases without reliably improving correctness
  - Users may incorrectly conclude that Generator failed, when the visible failure is actually caused by lossy handoff and transcript replacement
- **Proposed Solution**:
  1. **Separate display summary from evaluator handoff**
     Keep short summaries for status and trace output, but provide full review content, structured findings, or artifact-backed handoff for downstream evaluators in long-text review flows.
  2. **Persist non-terminal worker transcript output**
     Store Generator / Planner / Validator output as managed-task transcript history or collapsible sections so it remains inspectable after task completion.
  3. **Redefine the review final-answer contract**
     Let Evaluator remain the final speaker, but require it to deliver the final code review with verified findings, additions, and gaps, not a meta-review of the generator.
  4. **Add targeted tests**
     - Non-terminal worker output remains visible after task completion
     - Review handoff to Evaluator uses full content or full artifact references
     - Final user-facing output is a final review, not a review-of-review
- **Suggested Implementation Plan**:
  - Phase 1: Extend orchestration handoff to support full handoffBody or artifact-based handoff
  - Phase 2: Extend Ink / CLI managed-task history so non-terminal worker transcript is retained
  - Phase 3: Update review-specific evaluator prompt and final-answer contract
  - Phase 4: Add H1 / H2 / H3 review integration tests for long findings
- **Current Workaround**:
  - Do not treat Evaluator claims about generator truncation as authoritative without checking artifacts
  - For important review tasks, inspect managed-task trace/artifacts or re-run in single-agent mode for comparison
- **Notes**:
  This is not just a cosmetic UI issue. It combines correctness risk, broken review semantics, and weak observability in one path.
- **Resolution**:
  1. **Handoff 从 summary-only 改成 summary + artifact + fuller output**
     `orchestration` 现在在 dependency handoff 中同时提供短摘要、`result.json` artifact 路径和更完整的 output excerpt，避免 Evaluator 只基于几百字符摘要下判断。
  2. **managed-task transcript 保留非终态 worker 输出**
     `Generator / Planner / Validator` 的输出会进入 managed-task evidence，并在 Ink REPL 收口时回填为可检查的 transcript history，而不是只作为临时 streaming 文本出现后消失。
  3. **review final-answer contract 修正**
     `Evaluator` 仍然负责最终收口，但现在会按“final review / final verdict”对用户说话，不再把最终答复写成对 Generator 的元评审。
  4. **补齐显式 refinement loop**
     AMA 现在支持 evaluator 发出 `revise` 指令后，把反馈送回 Generator / worker set 再跑下一轮，直到 `accept`、`blocked` 或达到轮次上限。
- **Files Changed**:
  - `packages/coding/src/orchestration.ts`
  - `packages/coding/src/orchestration.test.ts`
  - `packages/coding/src/task-engine.ts`
  - `packages/coding/src/task-engine.test.ts`
  - `packages/repl/src/ui/InkREPL.tsx`
- **Tests**:
  - `packages/coding/src/orchestration.test.ts`
  - `packages/coding/src/task-engine.test.ts`

---

### 102: Repo-intelligence mixes git-tracked and filesystem-discovered file sets (RESOLVED)
- **Priority**: Medium
- **Status**: Resolved
- **Introduced**: v0.7.5
- **Fixed**: v0.7.5
- **Created**: 2026-03-28
- **Resolution Date**: 2026-03-28
- **Original Problem**:
  `buildRepoOverview()` chooses a file source (`git` when available, otherwise `filesystem`), but `buildRepoIntelligenceIndex()` has a separate `collectWorkspaceFiles()` path that always walks the filesystem directly.
  As a result, overview-level routing and query-level intelligence can disagree about which files belong to the workspace, especially when untracked or ignored files are present.
- **Expected Behavior**:
  - Repo overview and repo-intelligence indexing should derive from the same file-source policy for a given workspace.
  - If the system intentionally falls back from git to filesystem, that choice should be explicit and reused consistently.
- **Affected Components**:
  - `packages/coding/src/repo-intelligence/index.ts`
  - `packages/coding/src/repo-intelligence/query.ts`
- **Root Cause Analysis**:
  1. `index.ts` calls `collectWorkspaceFiles(workspaceRoot, source)` where `source` can be `git`.
  2. `query.ts` defines its own `collectWorkspaceFiles()` helper that walks the filesystem without consulting the overview source.
  3. The two layers therefore build repo-intelligence on different file universes for the same workspace.
- **Impact**:
  - File counts, affected areas, and intelligence capsules can drift between overview and query layers.
  - Untracked or ignored files may leak into repo-intelligence even when the higher-level overview is git-scoped.
  - Downstream routing and context-building can become less predictable.
- **Resolution**:
  Added a shared `collectWorkspaceFilesForSource()` helper in `repo-intelligence/index.ts`, and both repo overview generation and query/index generation now reuse the same source-aware file policy. `query.ts` no longer walks the filesystem through a private collector, and both cache validation and live rebuild paths now derive from the same `overview.source`.
- **Files Changed**:
  - `packages/coding/src/repo-intelligence/index.ts`
  - `packages/coding/src/repo-intelligence/query.ts`

---

### 103: Managed-task planning recomputes repo routing signals in the same workspace (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.7.5
- **Fixed**: v0.7.5
- **Created**: 2026-03-28
- **Resolution Date**: 2026-03-28
- **Original Problem**:
  In managed-task flows, repo routing signals can be computed once in the outer `runKodaX()` path and then recomputed again when `task-engine` creates the managed reasoning plan for the same workspace.
  The behavior is correct, but it adds avoidable latency and duplicated repo analysis work.
- **Expected Behavior**:
  - Repo routing signals should be computed once per workspace/run boundary and reused by downstream planning layers whenever possible.
  - Managed-task planning should accept already-derived signals instead of recomputing them by default.
- **Affected Components**:
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/task-engine.ts`
- **Root Cause Analysis**:
  1. `runKodaX()` computes `repoRoutingSignals` before building the initial reasoning plan.
  2. `task-engine` later calls `getRepoRoutingSignals(...)` again when building the managed reasoning plan.
  3. There is no shared cache/parameter handoff for the already-computed signal set.
- **Impact**:
  - Extra repo-analysis latency on managed-task runs.
  - Unnecessary duplicated work for the same workspace snapshot.
  - Harder-to-reason-about performance costs when AMA routing becomes more sophisticated.
- **Resolution**:
  Introduced `context.repoRoutingSignals` as a reusable handoff field. `runKodaX()` now reuses precomputed routing signals when present, and `task-engine` threads the same signal set through `createManagedReasoningPlan()` and `runManagedTask()` instead of recomputing it for the same workspace boundary by default.
- **Files Changed**:
  - `packages/coding/src/agent.ts`
  - `packages/coding/src/task-engine.ts`
  - `packages/coding/src/types.ts`

---

### 104: Repo-intelligence cache JSON is read without runtime shape validation (RESOLVED)
- **Priority**: Low
- **Status**: Resolved
- **Introduced**: v0.7.5
- **Fixed**: v0.7.5
- **Created**: 2026-03-28
- **Resolution Date**: 2026-03-28
- **Original Problem**:
  `safeReadJson<T>()` reads cache files and returns `JSON.parse(content) as T` without validating the runtime shape.
  Corrupted, partially written, or schema-drifted cache files therefore get treated as trusted typed objects until later code trips over missing fields.
- **Expected Behavior**:
  - Cache JSON should be validated against minimal runtime shape checks before being treated as typed repo-intelligence data.
  - Invalid cache payloads should be discarded explicitly rather than silently masquerading as valid typed data.
- **Affected Components**:
  - `packages/coding/src/repo-intelligence/internal.ts`
  - Repo-intelligence cache readers that consume `safeReadJson()`
- **Root Cause Analysis**:
  1. `safeReadJson<T>()` uses a compile-time generic but no runtime schema/guard.
  2. Cache corruption currently collapses into either `null` on parse failure or structurally-invalid objects on parse success.
  3. Downstream callers assume the generic type is already trustworthy.
- **Impact**:
  - Cache corruption can surface later as confusing downstream failures instead of a clean cache miss.
  - Schema migrations become riskier because old cache payloads are not rejected at the boundary.
  - Debugging repo-intelligence drift becomes harder.
- **Resolution**:
  `safeReadJson<T>()` now accepts an optional runtime validator and returns `null` on shape mismatch. Repo overview and repo-intelligence cache readers now use lightweight payload guards, so corrupted or schema-drifted cache JSON is treated as a cache miss instead of an unchecked typed object.
- **Files Changed**:
  - `packages/coding/src/repo-intelligence/internal.ts`
  - `packages/coding/src/repo-intelligence/index.ts`
  - `packages/coding/src/repo-intelligence/query.ts`


### 105: kodax -c 历史记录未注入 LLM 上下文 - resume 路径可能存在 gitRoot 过滤不一致 (OPEN)
- **Priority**: Medium
- **Status**: Open
- **Introduced**: v0.7.14
- **Created**: 2026-04-03

- **Original Problem**:
  用户报告使用 `kodax -c`（继续最近会话）后，之前的历史记录没有正常注入 LLM 上下文。
  LLM 似乎"忘记"了之前的对话内容，表现为不认识之前讨论过的内容。

- **Expected Behavior**:
  - `kodax -c` 应该自动加载当前目录最近的会话历史
  - 历史消息应该作为 `initialMessages` 注入 LLM 上下文
  - UI 应显示 `[Continuing session: xxx]` 横幅

- **Code Path Analysis**:

  代码链完整，但存在多个潜在故障点：

  **1. CLI → buildSessionOptions** (`src/cli_option_helpers.ts:295-297`)
  - 设置 `resume: true`，未传 `autoResume`。✅ 正确

  **2. InkREPL 交互模式** (`packages/repl/src/ui/InkREPL.tsx:3527-3543`)
  - 使用 `storage.list(gitRoot)` 过滤当前目录会话。✅ 正确

  **3. agent.ts runKodaX** (`packages/coding/src/agent.ts:959-962`)
  - ⚠️ **潜在问题 1**: `storage.list()` 不传 `gitRoot`，虽然内部会调用 `getGitRoot()` 获取默认值，
    但在 managed task worker 路径中 cwd 可能不是用户的项目目录，导致找不到匹配会话。

  **4. initialMessages 优先级** (`packages/coding/src/agent.ts:979-982`)
  - ✅ 逻辑正确：`initialMessages` 优先，否则从 storage 加载

  **5. managed task worker 路径** (`packages/coding/src/task-engine.ts:4091-4096`)
  - ⚠️ **潜在问题 2**: compact 策略下 `initialMessages` 设为 `undefined`，不传递原始历史。
    虽然这是设计意图（compact 应该用 compactInitialMessages），但可能导致历史丢失。

  **6. storage.list gitRoot 过滤** (`packages/repl/src/interactive/storage.ts:501-504`)
  - ⚠️ **潜在问题 3**: 如果会话保存时没有记录 gitRoot（旧版本），
    `sessionGitRoot` 为空字符串，会被过滤掉，导致找不到任何会话。

- **Ambiguities**:
  1. 用户描述可能指 LLM 没有接收历史（代码路径完整但可能有运行时故障）
  2. 也可能指 UI 没有显示历史（不同的显示问题）
  3. 需确认 `[Continuing session: xxx]` 横幅是否出现，以判断是加载阶段还是注入阶段的问题
  4. 可能与特定 memory strategy 有关（compact vs continuous）

- **Reproduction Steps** (待确认):
  1. 在项目目录中启动 `kodax` 并进行多轮对话
  2. 退出后执行 `kodax -c`
  3. 检查是否出现 `[Continuing session: xxx]` 横幅
  4. 询问 LLM 之前讨论的内容，确认是否记得

- **Proposed Investigation**:
  1. 添加调试日志确认 `storage.list()` 在 `agent.ts` 中是否返回有效会话
  2. 确认 `initialMessages` 是否正确传递到 `runKodaX`
  3. 检查旧版本保存的会话是否缺少 `gitRoot` 字段
  4. 对比 `InkREPL` 和 `agent.ts` 中 `storage.list()` 的参数差异

- **Context**:
  - `src/cli_option_helpers.ts` - buildSessionOptions
  - `src/kodax_cli.ts` - CLI -c 选项处理
  - `packages/repl/src/ui/InkREPL.tsx` - 交互模式 session resume
  - `packages/coding/src/agent.ts` - runKodaX session loading
  - `packages/coding/src/task-engine.ts` - createWorkerSession
  - `packages/repl/src/interactive/storage.ts` - FileSessionStorage.list

---

## Summary
- Total: 32 (11 Open, 21 Resolved, 0 Partially Resolved, 0 Won't Fix)
- Highest Priority Open: 091 - 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High)
- Historical archived issues are maintained in ISSUES_ARCHIVED.md

## Changelog

### 2026-04-11: Issue 107 added
- Added 107: harnessProfile 类型命名残留 - H0/H1/H2 应替换为 worker-chain composition (Medium Priority)
- 由 FEATURE_061 Phase 5 识别，237 处引用跨 10 文件，需 v0.7.16 提交后独立处理

### 2026-04-03: Issue 105 added
- Added 105: kodax -c 历史记录未注入 LLM 上下文 - resume 路径可能存在 gitRoot 过滤不一致 (Medium Priority)
- 代码链分析完成，确认代码路径完整但存在多个潜在故障点
- 主要关注: agent.ts 中 storage.list() 未传 gitRoot 参数、旧会话缺少 gitRoot 字段、compact 策略下 initialMessages 不传递

### 2026-03-28: Issues 102-104 resolved
- Resolved 102: Repo-intelligence now reuses the same source-aware file collector across overview and query/index layers
- Resolved 103: managed-task planning now reuses `repoRoutingSignals` across `runKodaX()` and `task-engine`
- Resolved 104: repo-intelligence cache readers now validate runtime JSON shape and treat mismatches as cache invalidation

### 2026-03-28: Issues 102-104 added
- Added 102: Repo-intelligence mixes git-tracked and filesystem-discovered file sets (Medium Priority)
- Added 103: Managed-task planning recomputes repo routing signals in the same workspace (Low Priority)
- Added 104: Repo-intelligence cache JSON is read without runtime shape validation (Low Priority)

### 2026-03-27: Issue 101 resolved
- Resolved 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- dependency handoff 现在保留 `Summary + Result artifact + fuller output`，Evaluator 不再只拿到截断摘要
- managed-task transcript 现在会保留非终态 worker 输出，Generator 文本不会在 Evaluator 收口后直接消失
- AMA 新增显式 refinement loop，review 最终答复也改成 final review，而不是 review-of-review

### 2026-03-27: Issue 101 added
- Added 101: Adaptive multi-agent code review loses Generator output and gives Evaluator a truncated handoff (High Priority)
- Generator review text vanishes from UI when Evaluator takes over, and lossy handoff (truncateText 400 chars) limits Evaluator evidence

### 2026-03-23: Issues 013-077 batch resolved
- Resolved 8 legacy low-priority issues (013, 014, 015, 017, 018, 055, 061, 077) at v0.6.17

### 2026-03-23: Issue 100 resolved
- Resolved 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 新增 `src/acp_logger.ts`，统一将 ACP 日志安全写入 `stderr`，避免污染 ACP `stdout` JSONL 协议流
- 补充 ACP 启动摘要、会话生命周期、prompt 开始/结束、权限协商、取消和错误日志
- 支持 `KODAX_ACP_LOG=off|error|info|debug` 控制 ACP 日志级别，并同步更新 CLI 帮助和 README 文档

### 2026-03-23: Issue 100 added
- Added 100: ACP Server 缺少日志/可观测性输出 (High Priority)
- 问题确认：`kodax acp serve` 当前缺少启动摘要、会话生命周期、权限协商、错误与关闭日志，stdout 又被 ACP JSONL 协议占用，导致实际只能依赖 stderr 做安全日志输出
- 后续修复方向：补充 stderr logger、启动摘要、关键生命周期日志，以及可控日志级别开关

### 2026-03-22: Technical debt audit merged into canonical issue tracker
- Verified and landed the fix batch for `C10`, `H17`, `H18`, `H53`, `H59`, `M37`, `M57`, and `M69` during the cleanup pass
- Rolled the remaining verified technical debt into active issues `094` through `099`, so each unresolved item now has a stable issue home
- Removed the temporary `docs/TECHNICAL_DEBT.md` document after migrating the remaining backlog into `KNOWN_ISSUES.md`

### 2026-03-19: Issue 090 resolved
- Resolved 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- 新增 provider capability profile，显式区分 Native API 与 CLI bridge，并记录上下文语义和 MCP 支持边界
- `/model` 与 `/status` 现在会直接披露 bridge provider 的限制：只转发最新一条用户消息，且 MCP 不可用
- 新增 `packages/ai/src/providers/capability-profile.test.ts` 与 `packages/repl/src/interactive/provider-capabilities.test.ts`，防止桥接 provider 再次被误标为原生语义

### 2026-03-19: Issue 089 resolved
- Resolved 089: Feature / Design / Summary 元数据漂移 (High Priority)
- 新增 `tests/tracker-consistency.test.ts`，自动校验 FEATURE_LIST 版本/summary、KNOWN_ISSUES summary/最高优先级 open issue，以及关键 design 文件存在性
- 同步修正 KNOWN_ISSUES summary 漂移，后续再发生同类问题会直接由测试报错

### 2026-03-18: Strategic comparison backlog intake
- Added 089: Feature / Design / Summary 元数据漂移 (High Priority)
- Added 090: CLI Provider 桥接语义降级：上下文与 MCP 能力丢失 (High Priority)
- Added 091: 缺少一等公民 MCP / Web Search / Code Search 工具体系 (High Priority)
- Added 092: Team 模式已暴露但原生多 Agent 架构仍未闭环 (High Priority)
- Added 093: 缺少 IDE / Desktop / Web 一体化分发表面 (Medium Priority)
- 来源：对标 opencode / Gemini CLI / Codex CLI / Claude Code 的差距分析，并已同步映射到 feature backlog

### 2026-03-16: Issue 088 新增并修复
- Added & Resolved 088: 消息列表视口布局不稳定 - 底部区域跳动/最后一行被裁剪 (High Priority)
- 核心变更：引入 Viewport Budget + Transcript Layout 架构
  1. 新增 `viewport-budget.ts` 统一计算底部区块行数
  2. 新增 `transcript-layout.ts` 将消息渲染改为扁平 TranscriptRow[] 数据模型
  3. StatusBar 导出 `getStatusBarText()` 纯函数供预算计算复用
  4. MessageList 移除 Static/Dynamic 分割，改为统一 TranscriptRow 渲染
  5. AutocompleteSuggestions 状态管理提升到父组件
  6. Select 对话框选项根据 viewport budget 截断
- Code Review 遗留 5 个未修复问题（model fallback、paddingY 未扣除等）
- 新增 7 个测试用例（viewport-budget 3 + transcript-layout 4）
- 版本：v0.5.39

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误触发命令补全
- 根因：多个 Completer 的 `canComplete()` 只检查触发符位置，未检查是否在有效触发位置（开头或空格后）
- 解决方案：统一规则 - `/` 和 `@` 不在开头时，前面必须有空格才能触发补全
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts` - FileCompleter, CommandCompleter
  - `packages/repl/src/interactive/autocomplete-provider.ts` - shouldTrigger
  - `packages/repl/src/interactive/completers/argument-completer.ts` - ArgumentCompleter
  - `packages/repl/src/interactive/completers/skill-completer.ts` - SkillCompleter

### 2026-03-13: Issue 087 修复
- Added & Resolved 087: 自动补全触发冲突 - @文件路径中/错误触发命令补全 (Medium Priority)
- 问题：输入 `@.kodax/` 时，路径中的 `/` 错误地触发了命令补全
- 根因：各 Completer 的 `canComplete()` 只检查最后一个 `/` 或 `@`，没有验证是否在有效的触发位置
- 修复：统一触发规则 - `/` 和 `@` 在输入中段时，前面必须有空格才能触发
- 修改文件：
  - `packages/repl/src/interactive/autocomplete.ts`
  - `packages/repl/src/interactive/autocomplete-provider.ts`
  - `packages/repl/src/interactive/completers/argument-completer.ts`
  - `packages/repl/src/interactive/completers/skill-completer.ts`
- 测试：71 个测试全部通过，- 版本：v0.5.33

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
