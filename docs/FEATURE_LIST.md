# Feature List

_Last Updated: 2026-03-05_

---

## Version Info

| 字段 | 值 | 说明 |
|------|-----|------|
| **Current Release** | v0.5.8 | 最新发布版本（仅供参考） |
| **Planned Version** | v0.5.0 | 当前规划的版本 |

---

## Version Summary

| Version | Status | Features | Progress |
|---------|--------|----------|----------|
| v0.3.1 | Released | 3 | 3/3 (100%) |
| v0.3.3 | Released | 1 | 1/1 (100%) |
| v0.4.0 | Released | 1 | 1/1 (100%) |
| v0.4.6 | Released | 1 | 1/1 (100%) |
| v0.5.5 | Released | 1 | 1/1 (100%) |
| v0.5.0 | InProgress | 7 | 3/7 (43%) |
| v0.6.0 | Planned | 1 | 0/1 (0%) |

---

## Feature Index

| ID | Category | Status | Priority | Title | Planned | Released | Design | Created | Started | Completed |
|----|----------|--------|----------|-------|---------|----------|--------|---------|---------|-----------|
| 001 | New | Completed | High | Plan Mode | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#001) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 002 | Enhancement | Completed | High | 强化 Ask 模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#002) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 003 | New | Completed | High | 交互式项目模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#003) | 2026-02-19 | 2026-02-19 | 2026-02-19 |
| 004 | Enhancement | Completed | Medium | 交互式界面改进 | v0.3.3 | v0.3.3 | [Design](features/v0.3.3.md#004) | 2026-02-19 | 2026-02-19 | 2026-02-20 |
| 005 | Refactor | Completed | High | v0.4.0 架构重构与模块解耦 | v0.4.0 | v0.4.0 | [Design](features/v0.4.0.md#005) | 2026-02-20 | 2026-02-24 | 2026-02-24 |
| 006 | New | Completed | Critical | Skills 系统 | v0.5.0 | v0.5.10 | [Design](features/v0.5.0.md#006) | 2026-02-25 | 2026-02-28 | 2026-03-05 |
| 007 | Enhancement | Planned | Medium | 主题系统完善 | v0.6.0 | - | [Design](features/v0.6.0.md#007) | 2026-02-25 | - | - |
| 008 | Enhancement | Completed | High | 权限控制体系改进 | v0.5.0 | v0.4.6 | [Design](features/v0.5.0.md#008) | 2026-02-26 | 2026-02-27 | 2026-02-27 |
| 009 | Refactor | Completed | Critical | 架构重构：AI 层独立 + 权限层分离 | v0.5.0 | v0.5.0 | [Design](features/v0.5.0.md#009) | 2026-02-27 | 2026-02-27 | 2026-02-27 |
| 010 | Refactor | Completed | Critical | 架构拆分：Agent Core + Skills 独立 | v0.5.0 | v0.5.5 | [Design](features/v0.5.0.md#010) | 2026-03-02 | 2026-03-02 | 2026-03-02 |
| 011 | Enhancement | Planned | High | 智能上下文压缩 (Compact) | v0.5.0 | - | [Design](features/v0.5.0.md#011) | 2026-03-02 | - | - |
| 012 | Enhancement | Planned | High | TUI 自动补全增强 | v0.5.0 | - | [Design](features/v0.5.0.md#012) | 2026-03-02 | - | - |
| 013 | Refactor | Planned | High | Command System 2.0 | v0.5.0 | - | [Design](features/v0.5.0.md#013) | 2026-03-03 | - | - |

---

## Feature Details

### 001: Plan Mode (COMPLETED)
- **Category**: New
- **Status**: Completed
- **Priority**: High
- **Planned**: v0.3.1
- **Released**: v0.3.1
- **Design**: [v0.3.1.md#001](features/v0.3.1.md#001)
- **Created**: 2026-02-18
- **Started**: 2026-02-18
- **Completed**: 2026-02-18

**Description**:
执行前计划系统，支持多步骤计划生成、存储、展示和执行。
- 通过 LLM 在代码变更前生成计划
- 计划持久化存储在 `.kodax/plans/` 目录
- 分步展示计划执行进度
- 每步执行需要用户确认
- 支持 `/plan on|off|once` 命令

**Implementation Notes**:
- 实现于 `src/cli/plan-mode.ts` 和 `src/cli/plan-storage.ts`
- 与 REPL 命令系统集成
- 计划以 JSON 格式存储，包含步骤跟踪

---

### 002: 强化 Ask 模式 (COMPLETED)
- **Category**: Enhancement
- **Status**: Completed
- **Priority**: High
- **Planned**: v0.3.1
- **Released**: v0.3.1
- **Design**: [v0.3.1.md#002](features/v0.3.1.md#002)
- **Created**: 2026-02-18
- **Started**: 2026-02-18
- **Completed**: 2026-02-18

**Description**:
只读模式强制执行，在 Ask 模式下阻止文件修改操作。
- 在 Ask 模式下阻止 write、edit、bash 工具
- 使用 `beforeToolExecute` hook 实现
- 操作被阻止时提供清晰的错误信息
- 从系统提示自动检测模式

**Implementation Notes**:
- 通过 core 模块的 `beforeToolExecute` hook 实现
- 基于系统提示分析进行模式检测
- 与现有工具系统无缝集成

---

### 003: 交互式项目模式 (COMPLETED)
- **Category**: New
- **Status**: Completed
- **Priority**: High
- **Planned**: v0.3.1
- **Released**: v0.3.1
- **Design**: [v0.3.1.md#003](features/v0.3.1.md#003)
- **Created**: 2026-02-19
- **Started**: 2026-02-19
- **Completed**: 2026-02-19

**Description**:
REPL 中的长运行项目管理，通过 `/project` 命令组实现。
- `/project init` - 初始化新项目并设定目标
- `/project status` - 显示当前项目状态和进度
- `/project goals` - 管理项目目标
- `/project cancel` - 取消当前项目
- 项目状态跨会话持久化
- 与 auto-continue 模式集成

**Implementation Notes**:
- 实现于 `src/interactive/project-commands.ts`、`project-state.ts`、`project-storage.ts`
- 项目存储在 `.kodax/projects/` 目录
- 状态包含目标、进度和会话历史

---

### 004: 交互式界面改进 (COMPLETED)
- **Category**: Enhancement
- **Status**: Completed
- **Priority**: Medium
- **Planned**: v0.3.2
- **Released**: v0.3.3
- **Design**: [v0.3.3.md#004](features/v0.3.3.md#004)
- **Created**: 2026-02-19
- **Started**: 2026-02-19
- **Completed**: 2026-02-20

**Description**:
基于 Ink 的 React UI 全面改进，提供现代化终端用户体验。
- **Phase 1-2**: 基于 TextBuffer 的多行输入，支持光标导航
- **Phase 3-4**: 流式上下文和 UI 状态管理
- **Phase 5**: UX 增强（紧凑标题、Banner 优化）
- **Phase 6**: KeypressContext 和 UIStateContext
- **Phase 7-8**: 组件测试和最终优化

**Features**:
- 多行输入与正确的光标处理
- 实时流式显示
- 主题支持基础设施
- 消息列表（带虚拟滚动）
- 状态栏显示会话信息
- 自动补全建议显示
- 工具执行分组

**Implementation Notes**:
- 实现于 `src/ui/` 目录，使用 Ink（CLI 版 React）
- 核心组件：`InkREPL.tsx`、`App.tsx`、`MessageList.tsx`、`InputPrompt.tsx`
- Context：`StreamingContext`、`UIStateContext`、`KeypressContext`
- 测试添加在 `tests/ui/` 目录

---

### 005: v0.4.0 架构重构与模块解耦 (COMPLETED)
- **Category**: Refactor
- **Status**: Completed
- **Priority**: High
- **Planned**: v0.4.0
- **Released**: v0.4.0
- **Design**: [v0.4.0.md#005](features/v0.4.0.md#005)
- **Created**: 2026-02-20
- **Started**: 2026-02-24
- **Completed**: 2026-02-24

**Description**:
重大架构重构，创建 monorepo 结构，包含 `@kodax/core` 和 `@kodax/repl` 两个独立包。

**Goals**:
1. **@kodax/core**: 纯 AI 引擎，环境无关（Node.js、浏览器、边缘运行时）
2. **@kodax/repl**: 完整的交互式终端体验

**Implementation Notes**:
- monorepo 结构使用 npm workspaces
- 根目录 `src/` 简化为代理导出
- packages/core 独立核心功能
- packages/repl 包含 CLI 和 UI 组件

---

### 006: Skills 系统 (COMPLETED)
- **Category**: New
- **Status**: Completed
- **Priority**: Critical
- **Planned**: v0.5.0
- **Released**: v0.5.10
- **Design**: [v0.5.0.md#006](features/v0.5.0.md#006)
- **Created**: 2026-02-25
- **Started**: 2026-02-28
- **Completed**: 2026-03-05

**Description**:
实现完整的 [Agent Skills](https://agentskills.io/) 开放标准，使 KodaX 能够：
- 加载和使用符合 Agent Skills 标准的技能
- 完全兼容 Claude Code 及其他支持 Agent Skills 的工具开发的 skills
- 支持渐进式披露机制，优化上下文使用
- 提供企业级的技能管理和分发能力

**Goals**:
1. ✅ 支持 `.kodax/skills/` 目录加载自定义技能
2. ✅ 内置 3 个技能库（code-review、git-workflow、tdd）
3. ✅ 技能可以通过 `/skill-name` 方式调用
4. ✅ 支持技能的参数传递 (`$ARGUMENTS`, `$0`, `$1`)
5. ✅ 技能可以被 LLM 自动识别和调用
6. ✅ 渐进式披露机制

**Implementation Notes**:
- 实现于 `packages/repl/src/skills/` 目录
- 类型定义: `types.ts` - Agent Skills 标准接口
- 加载器: `skill-loader.ts` - YAML frontmatter 解析
- 发现: `discovery.ts` - 多路径扫描
- 解析: `skill-resolver.ts` - 变量替换
- 注册表: `skill-registry.ts` - 渐进式披露
- 执行器: `executor.ts` - 技能执行
- 测试: 15 个单元测试全部通过

---

### 007: 主题系统完善 (PLANNED)
- **Category**: Enhancement
- **Status**: Planned
- **Priority**: Medium
- **Planned**: v0.6.0
- **Released**: -
- **Design**: [v0.6.0.md#007](features/v0.6.0.md#007)
- **Created**: 2026-02-25
- **Started**: -
- **Completed**: -

**Description**:
将所有硬编码的 chalk 颜色改为使用主题系统，实现全局主题切换。

**Goals**:
1. 命令输出颜色使用主题系统
2. 添加 `/theme` 命令切换主题
3. 支持用户自定义主题
4. 主题持久化到配置文件

**Key Changes**:
- 修改 `commands.ts` 使用主题颜色
- 添加 ThemeContext 全局主题状态
- 主题配置存储在 `.kodax/config.json`

---

### 008: 权限控制体系改进 (COMPLETED)
- **Category**: Enhancement
- **Status**: Completed
- **Priority**: High
- **Planned**: v0.5.0
- **Released**: v0.4.6
- **Design**: [v0.5.0.md#008](features/v0.5.0.md#008)
- **Created**: 2026-02-26
- **Started**: 2026-02-27
- **Completed**: 2026-02-27

**Description**:
完善 KodaX 权限控制系统，对标 Claude Code 的权限控制方案，提供更细粒度的权限管理。

**Implementation**:
- 四级权限模式：`plan` / `default` / `accept-edits` / `auto-in-project`
- `plan` 模式：只读规划，禁止 write/edit/bash/undo，系统提示词告知 LLM
- `default` 模式：全部需确认，选择 "always" 时自动切换到 accept-edits
- `accept-edits` 模式：文件编辑自动，bash 需确认
- `auto-in-project` 模式：项目内全自动
- 永久保护区域：`.kodax/`、`~/.kodax/`、项目外路径永远需确认
- 两级配置：用户级 `~/.kodax/config.json` + 项目级 `.kodax/config.local.json`
- Diff 显示：write/edit 操作显示 unified diff 格式变更

**Key Files**:
- `packages/core/src/tools/permission.ts` - 核心权限逻辑
- `packages/core/src/tools/registry.ts` - 工具执行权限检查
- `packages/core/src/tools/diff.ts` - Unified diff 生成
- `packages/core/src/prompts/builder.ts` - Plan mode 系统提示词
- `packages/repl/src/common/permission-config.ts` - 配置加载/保存
- `packages/repl/src/interactive/commands.ts` - `/mode` 命令更新

---

### 009: 架构重构：AI 层独立 + 权限层分离 (COMPLETED)
- **Category**: Refactor
- **Status**: Completed
- **Priority**: Critical
- **Planned**: v0.5.0
- **Released**: v0.5.0
- **Design**: [v0.5.0.md#009](features/v0.5.0.md#009)
- **Created**: 2026-02-27
- **Started**: 2026-02-27
- **Completed**: 2026-02-27

**Description**:
参考 pi-mono 的优雅设计，重构 KodaX 架构，实现职责分离和可复用性。

**Goals**:
1. **@kodax/ai**: 独立的 LLM 抽象层，可被其他项目复用
2. **@kodax/core**: 纯 Agent 逻辑，移除权限检查
3. **@kodax/repl**: 权限控制层，UI 交互
4. **CLI**: 默认 auto (YOLO) 模式，快速执行

**Inspired by**: [pi-mono](https://github.com/badlogic/pi-mono)

**Key Changes**:
- 创建 `packages/ai/` 独立包，包含 Provider 抽象层
- 从 core 移除 permission.ts，简化为纯执行
- 简化 registry.ts 的 executeTool()（无权限检查）
- CLI 默认 YOLO 模式（无权限检查），保留 `-y/--auto` 向后兼容
- REPL 保留完整权限控制（通过 `beforeToolExecute` hook）

**Implementation Notes**:
- `packages/ai/` - 独立的 LLM Provider 抽象层
- `packages/core/src/tools/registry.ts` - 简化的工具执行
- `packages/repl/src/permission/` - REPL 层权限模块
- `packages/repl/src/ui/InkREPL.tsx` - 使用 `beforeToolExecute` hook

---

### 010: 架构拆分：Agent Core + Skills 独立 (COMPLETED)
- **Category**: Refactor
- **Status**: Completed
- **Priority**: Critical
- **Planned**: v0.5.0
- **Released**: v0.5.5
- **Design**: [v0.5.0.md#010](features/v0.5.0.md#010)
- **Created**: 2026-03-02
- **Started**: 2026-03-02
- **Completed**: 2026-03-02

**Description**:
参考 pi-mono 的多层架构设计，将 KodaX 拆分为更细粒度的包，实现 Agent 框架通用化和 Skills 能力独立化。

**Goals**:
1. **@kodax/agent** - 通用 Agent 框架（状态机、消息循环、transport 抽象）
2. **@kodax/skills** - Skills 系统独立包（零依赖，可被任何 Agent 使用）
3. **@kodax/coding** - Coding Agent（工具 + Prompts，依赖 agent + skills）
4. **@kodax/repl** - CLI 应用（纯 UI 和交互）

**Background**:
- 当前 Skills 在 `repl` 包中，导致只有 REPL 能用
- 当前 `core` 包混合了 Agent 框架和 Coding 工具
- 希望 KodaX 能支持非 Coding Agent 的场景

**Inspired by**: [pi-mono](https://github.com/badlogic/pi-mono)
- `@mariozechner/pi-agent-core` - 通用 Agent 框架
- `@mariozechner/pi-coding-agent` - Coding Agent（Skills 在这里）

**Key Changes**:
- 创建 `packages/agent/` - 从 core 提取通用 Agent 框架
- 创建 `packages/skills/` - 从 repl 提取 Skills 系统
- 重命名 `packages/core/` → `packages/coding/` - Coding 专用工具和 Prompts
- 简化 `packages/repl/` - 只保留 UI 和交互逻辑

**Implementation Notes**:
- Skills 模块零依赖（只依赖 Node.js 内置模块）
- Agent 包提供通用状态机和消息循环
- Coding 包依赖 Agent + Skills
- REPL 只依赖 Coding 包

---

### 011: 智能上下文压缩 Compact (PLANNED)
- **Category**: Enhancement
- **Status**: Planned
- **Priority**: High
- **Planned**: v0.5.0
- **Released**: -
- **Design**: [v0.5.0.md#011](features/v0.5.0.md#011)
- **Created**: 2026-03-02
- **Started**: -
- **Completed**: -

**Description**:
对标 pi-mono 的 Compaction 系统，升级 KodaX 的上下文压缩能力，从简单截断升级为智能摘要。

**Goals**:
1. **可配置阈值** - 用户可配置压缩触发阈值和保留消息数
2. **LLM 智能摘要** - 用 LLM 生成结构化摘要（目标、进度、决策等）
3. **手动 /compact 命令** - 支持用户主动触发压缩
4. **文件追踪** - 累积追踪读写过的文件
5. **扩展钩子** - 提供压缩前事件钩子

**Background**:
- 当前压缩只是简单截断每条消息到 100 字符
- 阈值写死在常量中（100k tokens），无法配置
- 没有手动触发机制
- 不保留关键上下文（文件操作、决策等）

**Inspired by**: [pi-mono compaction](https://github.com/badlogic/pi-mono)
- LLM 生成结构化摘要：Goal、Progress、Decisions、Next Steps
- 累积文件追踪：readFiles、modifiedFiles
- 可配置：reserveTokens、keepRecentTokens
- 扩展 API：session_before_compact 事件

**Key Changes**:
- 创建 `packages/core/src/compaction/` 模块
- 添加配置支持到 `~/.kodax/config.json`
- 添加 `/compact` REPL 命令
- 实现 LLM 摘要生成器
- 添加文件追踪逻辑

**Implementation Notes**:
- `packages/core/src/compaction/compaction.ts` - 压缩逻辑
- `packages/core/src/compaction/summary-generator.ts` - LLM 摘要生成
- `packages/core/src/compaction/file-tracker.ts` - 文件追踪
- `packages/repl/src/interactive/commands.ts` - `/compact` 命令
- `packages/repl/src/common/config.ts` - 配置加载

---

### 012: TUI 自动补全增强 (PLANNED)
- **Category**: Enhancement
- **Status**: Planned
- **Priority**: High
- **Planned**: v0.5.0
- **Released**: -
- **Design**: [v0.5.0.md#012](features/v0.5.0.md#012)
- **Created**: 2026-03-02
- **Started**: -
- **Completed**: -

**Description**:
对标 pi-mono 的自动补全系统，提升 KodaX 的命令行补全体验。

**Goals**:
1. **Fuzzy 匹配** - 支持模糊搜索，更智能的过滤
2. **参数补全** - 根据命令定义提供参数补全
3. **UI 增强** - 下拉菜单 + 图标 + 详细描述
4. **多触发方式** - 支持多种补全触发方式

**Background**:
- 当前补全使用简单前缀匹配
- Tab 触发补全不够直观
- 无参数提示，需要记忆命令用法
- 无法在补全时看到详细描述

**Inspired by**: [pi-mono](https://github.com/badlogic/pi-mono)

---

### 013: Command System 2.0 (PLANNED)
- **Category**: Refactor
- **Status**: Planned
- **Priority**: High
- **Planned**: v0.5.0
- **Released**: -
- **Design**: [v0.5.0.md#013](features/v0.5.0.md#013)
- **Created**: 2026-03-03
- **Started**: -
- **Completed**: -

**Description**:
重构 KodaX 的 Command 系统，参考 pi-mono 的 Extension API 设计，实现动态命令注册、丰富的 UI 交互能力、统一的命令来源追踪。

**Goals**:
1. **动态命令注册** - 通过 `registerCommand()` 动态添加命令
2. **UI 交互能力** - `ctx.ui.select/confirm/input` 交互对话框
3. **命令来源追踪** - 区分 builtin/extension/skill/prompt
4. **参数自动补全** - `getArgumentCompletions` 参数智能提示
5. **缺失命令补齐** - /reload, /compact, /copy, /new, /commands 等

**Background**:
- 当前命令硬编码在 `BUILTIN_COMMANDS` 数组中
- 命令无法提供 UI 交互 (select/confirm/input)
- KodaX 缺失 12+ pi-mono 具有的实用命令
- 无动态命令注册机制

**Inspired by**: [pi-mono Extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)

---

## Summary
- Total: 13 (4 Planned, 9 Completed)
- By Priority: Critical: 3, High: 6, Medium: 2, Low: 0
- Current Version: v0.5.0
- Next Release (v0.5.0): 3 features planned (011, 012, 013)
- Future Release (v0.6.0): 1 feature planned (007)
- Highest Priority Planned: 011 - 智能上下文压缩 (High), 012 - TUI 自动补全增强 (High)
