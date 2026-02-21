# Feature List

_Last Updated: 2026-02-21 23:30_

---

## Version Info

| 字段 | 值 | 说明 |
|------|-----|------|
| **Current Release** | v0.3.3 | 最新发布版本（仅供参考） |
| **Planned Version** | v0.4.0 | 当前规划的版本 |

---

## Version Summary

| Version | Status | Features | Progress |
|---------|--------|----------|----------|
| v0.3.1 | Released | 3 | 3/3 (100%) |
| v0.3.3 | Released | 1 | 1/1 (100%) |
| v0.4.0 | Planned | 1 | 0/1 (0%) |

---

## Feature Index

| ID | Category | Status | Priority | Title | Planned | Released | Design | Created | Started | Completed |
|----|----------|--------|----------|-------|---------|----------|--------|---------|---------|-----------|
| 001 | New | Completed | High | Plan Mode | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#001) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 002 | Enhancement | Completed | High | 强化 Ask 模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#002) | 2026-02-18 | 2026-02-18 | 2026-02-18 |
| 003 | New | Completed | High | 交互式项目模式 | v0.3.1 | v0.3.1 | [Design](features/v0.3.1.md#003) | 2026-02-19 | 2026-02-19 | 2026-02-19 |
| 004 | Enhancement | Completed | Medium | 交互式界面改进 | v0.3.3 | v0.3.3 | [Design](features/v0.3.3.md#004) | 2026-02-19 | 2026-02-19 | 2026-02-20 |
| 005 | Refactor | Planned | High | v0.4.0 架构重构与模块解耦 | v0.4.0 | - | [Design](features/v0.4.0.md#005) | 2026-02-20 | - | - |

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

### 005: v0.4.0 架构重构与模块解耦 (PLANNED)
- **Category**: Refactor
- **Status**: Planned
- **Priority**: High
- **Planned**: v0.4.0
- **Released**: -
- **Design**: [v0.4.0.md#005](features/v0.4.0.md#005)
- **Created**: 2026-02-20
- **Started**: -
- **Completed**: -

**Description**:
重大架构重构，创建三个高度解耦、可独立使用的模块：
`@kodax/core`、`@kodax/cli`、`@kodax/repl`

**Goals**:
1. **@kodax/core**: 纯 AI 引擎，环境无关（Node.js、浏览器、边缘运行时）
2. **@kodax/cli**: 薄层 CLI 封装，带命令注册系统
3. **@kodax/repl**: 完整的交互式终端体验

**Key Changes**:
- 模块间标准化接口
- 事件驱动架构
- Provider 和 Tool 插件系统
- 独立的 npm 包

**Phases**:
- Phase 1: 代码审查与依赖分析
- Phase 2: Core 模块重构
- Phase 3: CLI 模块重构
- Phase 4: REPL 模块重构
- Phase 5: 集成测试与发布

---

## Summary
- Total: 5 (1 Planned, 0 InProgress, 4 Completed)
- By Priority: Critical: 0, High: 4, Medium: 1, Low: 0
- Current Version: v0.3.3
- Next Release (v0.4.0): 1 feature planned
- Highest Priority InProgress: None
