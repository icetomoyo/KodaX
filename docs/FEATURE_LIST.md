# Feature List

_Last Updated: 2026-02-27 23:30_

---

## Version Info

| 字段 | 值 | 说明 |
|------|-----|------|
| **Current Release** | v0.5.0 | 最新发布版本（仅供参考） |
| **Planned Version** | v0.5.0 | 当前规划的版本 |

---

## Version Summary

| Version | Status | Features | Progress |
|---------|--------|----------|----------|
| v0.3.1 | Released | 3 | 3/3 (100%) |
| v0.3.3 | Released | 1 | 1/1 (100%) |
| v0.4.0 | Released | 1 | 1/1 (100%) |
| v0.4.6 | Released | 1 | 1/1 (100%) |
| v0.5.0 | InProgress | 4 | 2/4 (50%) |

---

## Feature Index

| ID | Category | Status | Priority | Title | Planned | Released | Design | Created | Started | Completed |
|----|----------|--------|----------|-------|---------|----------|--------|---------|---------|-----------|
| 001 | New | Completed | High | Plan Mode | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#001) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 002 | Enhancement | Completed | High | 强化 Ask 模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#002) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 003 | New | Completed | High | 交互式项目模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#003) | 2026-02-19 | 2026-02-19 | 2026-02-19 |
| 004 | Enhancement | Completed | Medium | 交互式界面改进 | v0.3.3 | v0.3.3 | [Design](features/v0.3.3.md#004) | 2026-02-19 | 2026-02-19 | 2026-02-20 |
| 005 | Refactor | Completed | High | v0.4.0 架构重构与模块解耦 | v0.4.0 | v0.4.0 | [Design](features/v0.4.0.md#005) | 2026-02-20 | 2026-02-24 | 2026-02-24 |
| 006 | New | Planned | Critical | Skills 系统 | v0.5.0 | - | [Design](features/v0.5.0.md#006) | 2026-02-25 | - | - |
| 007 | Enhancement | Planned | Medium | 主题系统完善 | v0.5.0 | - | [Design](features/v0.5.0.md#007) | 2026-02-25 | - | - |
| 008 | Enhancement | Completed | High | 权限控制体系改进 | v0.5.0 | v0.4.6 | [Design](features/v0.5.0.md#008) | 2026-02-26 | 2026-02-27 | 2026-02-27 |
| 009 | Refactor | Completed | Critical | 架构重构：AI 层独立 + 权限层分离 | v0.5.0 | v0.5.0 | [Design](features/v0.5.0.md#009) | 2026-02-27 | 2026-02-27 | 2026-02-27 |

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

### 006: Skills 系统 (PLANNED)
- **Category**: New
- **Status**: Planned
- **Priority**: Critical
- **Planned**: v0.5.0
- **Released**: -
- **Design**: [v0.5.0.md#006](features/v0.5.0.md#006)
- **Created**: 2026-02-25
- **Started**: -
- **Completed**: -

**Description**:
类似 Claude Code 的 Skills 系统，允许用户定义和加载可复用的技能/命令模块。

**Goals**:
1. 支持 `.claude/skills/` 目录加载自定义技能
2. 内置常用技能库（代码审查、测试生成等）
3. 技能可以通过 `/skill-name` 方式调用
4. 支持技能的参数传递和配置
5. 技能可以被 LLM 自动识别和调用

**Key Features**:
- 技能发现和注册机制
- 技能元数据（名称、描述、触发词）
- 技能执行上下文隔离
- 技能依赖管理

---

### 007: 主题系统完善 (PLANNED)
- **Category**: Enhancement
- **Status**: Planned
- **Priority**: Medium
- **Planned**: v0.5.0
- **Released**: -
- **Design**: [v0.5.0.md#007](features/v0.5.0.md#007)
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

## Summary
- Total: 9 (2 Planned, 0 InProgress, 7 Completed)
- By Priority: Critical: 2, High: 4, Medium: 2, Low: 0
- Current Version: v0.5.0
- Next Release (v0.5.0): 2 features planned (006, 007)
- Highest Priority Planned: 006 - Skills 系统 (Critical)
