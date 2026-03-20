# v0.6.0 Release - 人工测试指导

## 功能概览

**版本**: v0.6.0  
**测试日期**: 2026-03-17  
**测试人员**: [待填写]  
**覆盖 Feature**: 013, 015, 017, 020, 021

**本次版本核心变化**:
- FEATURE_013: Command System 2.0
- FEATURE_015: Project Mode 2.0 - AI-Driven Development Workflow
- FEATURE_017: 运行时用户输入插队
- FEATURE_020: AGENTS.md - 项目级 AI 上下文规则
- FEATURE_021: Provider-Aware Reasoning Budget Matrix

**建议执行顺序**:
1. 先跑冒烟用例，确认版本可用
2. 再跑 5 个 feature 的核心流程
3. 最后跑回归和边界场景

---

## 测试环境

### 前置条件
- 已完成依赖安装，`npm install` 成功
- 已完成构建，`npm run build -w @kodax/coding` 和 `npm run build -w @kodax/repl` 成功
- 至少配置 1 个可用模型提供商
- 准备一个可读写的测试仓库目录

### 建议准备的测试材料
- 一个带 Git 的测试项目目录
- 一个项目级 `.kodax/AGENTS.md`
- 一个用户级或项目级 `.kodax/commands/*.md` 命令文件
- 一个较长的问题，用于验证 streaming 和 follow-up queue

### 建议记录项
- 实际使用的 provider / model
- 是否在 Windows / macOS / Linux
- 是否出现乱码、布局错位、输入焦点异常
- 是否出现历史丢失、最后一行不可见、空白消息

---

## 冒烟测试

### TC-001: REPL 启动与基础界面

**优先级**: 高  
**类型**: 冒烟

**步骤**:
1. 启动 KodaX REPL
2. 观察 Banner、输入框、状态栏是否正常显示
3. 输入一个简单问题并发送
4. 等待完整响应结束

**预期结果**:
- [ ] REPL 正常启动，无崩溃
- [ ] Banner、消息区、输入区、状态栏布局正常
- [ ] AI 能正常返回一条完整响应
- [ ] 响应结束后输入框仍可继续输入

---

## Feature 013 - Command System 2.0

### TC-002: 项目级 `.md` 命令发现

**优先级**: 高  
**类型**: 正向测试

**前置条件**:
- 在测试项目中创建 `.kodax/commands/hello.md`

**建议内容**:
```md
---
name: hello
description: Say hello
---

Say hello to the user and mention this command came from project commands.
```

**步骤**:
1. 启动 KodaX 并进入该项目目录
2. 执行 `/hello`
3. 观察输出

**预期结果**:
- [ ] `/hello` 可被识别
- [ ] 输出符合命令内容语义
- [ ] 未出现“unknown command”之类错误

### TC-003: 命令侧 UI 交互能力

**优先级**: 中  
**类型**: 正向测试

**步骤**:
1. 执行一个会触发 confirm/select/input 的命令或 `/project` 子命令
2. 分别测试确认、取消、输入文本

**预期结果**:
- [ ] 交互框可正常显示
- [ ] 键盘选择、确认、取消都正常
- [ ] 交互结束后焦点回到主输入框

---

## Feature 015 - Project Mode 2.0

### TC-004: `/project quality`

**优先级**: 高  
**类型**: 正向测试

**步骤**:
1. 在测试项目目录执行 `/project quality`
2. 观察 workflow health / readiness 输出

**预期结果**:
- [ ] 命令可执行完成
- [ ] 输出包含质量维度或 readiness 信息
- [ ] 没有明显占位文案或空报告

### TC-005: `/project status "问题"`

**优先级**: 高  
**类型**: 正向测试

**步骤**:
1. 执行 `/project status "当前项目离发布还差什么？"`
2. 观察输出是否结合 feature/progress/plan 上下文

**预期结果**:
- [ ] 输出不是简单占位文案
- [ ] 能给出结构化分析或明确建议
- [ ] 输出与当前项目状态相关

### TC-006: `/project brainstorm`

**优先级**: 高  
**类型**: 正向测试 / 持久化测试

**步骤**:
1. 执行 `/project brainstorm 发布测试策略`
2. 连续进行至少 2 轮 brainstorm
3. 结束后检查 `.kodax/projects/<session>/brainstorm/`

**预期结果**:
- [ ] brainstorm 可以开始并继续多轮
- [ ] AI 输出体现“引导式 brainstorming”而非普通闲聊
- [ ] 会生成会话持久化文件

### TC-007: `/project plan`

**优先级**: 高  
**类型**: 正向测试

**步骤**:
1. 执行 `/project plan`
2. 或先 brainstorm，再执行 `/project plan #1`
3. 检查 `.kodax/session_plan.md`

**预期结果**:
- [ ] 能生成结构化计划
- [ ] 计划包含阶段、任务或风险信息
- [ ] `.kodax/session_plan.md` 被正确更新

---

## Feature 017 - 运行时用户输入插队

### TC-008: 单条 follow-up 排队

**优先级**: 高  
**类型**: 正向测试

**步骤**:
1. 提交一个会产生较长 streaming 输出的问题
2. 在 AI 仍在输出时输入一条 follow-up 并回车
3. 等待当前轮安全结束

**预期结果**:
- [ ] follow-up 不会打断当前正在输出的内容
- [ ] 底部出现 queued follow-up 提示
- [ ] 当前轮结束后，follow-up 自动作为下一轮用户输入执行

### TC-009: 多条 follow-up FIFO

**优先级**: 高  
**类型**: 正向测试 / 边界测试

**步骤**:
1. 在 streaming 期间连续提交 2 到 3 条 follow-up
2. 记录提交顺序
3. 等待系统逐条执行

**预期结果**:
- [ ] follow-up 按提交顺序执行
- [ ] 不会跳序或丢失
- [ ] 不会出现重复执行

### TC-010: `Esc` 删除最后一条排队输入

**优先级**: 高  
**类型**: 负向测试 / 交互测试

**步骤**:
1. 在 streaming 时提交 2 条 follow-up
2. 保持输入框为空
3. 按一次 `Esc`
4. 观察队列提示

**预期结果**:
- [ ] 只删除最后一条排队输入
- [ ] 不会误中断当前 streaming
- [ ] 输入框布局不应左移或错位

### TC-011: `Ctrl+C` 中断时清空队列

**优先级**: 高  
**类型**: 负向测试

**步骤**:
1. 在 streaming 时提交至少 1 条 follow-up
2. 按 `Ctrl+C` 中断当前轮
3. 观察历史和底部队列提示

**预期结果**:
- [ ] 当前轮被中断
- [ ] 队列被清空
- [ ] 不会在后续无意执行旧的 queued prompt

### TC-012: 空白消息与布局回归

**优先级**: 高  
**类型**: 回归测试

**步骤**:
1. 重复执行以下组合: streaming -> queue -> `Esc` -> 再输入 -> 再 queue
2. 尤其关注输入框和历史区

**预期结果**:
- [ ] 不出现连续空白 `You` 消息
- [ ] 不出现输入框缩进异常
- [ ] 响应结束后历史内容不会突然只剩最后一屏

---

## Feature 020 - AGENTS.md

### TC-013: 项目级 AGENTS 规则注入

**优先级**: 高  
**类型**: 正向测试

**前置条件**:
- 在测试项目创建 `.kodax/AGENTS.md`

**建议内容**:
```md
# Test Rules

- Always mention the phrase "PROJECT RULE ACTIVE" when asked what rules are loaded.
```

**步骤**:
1. 启动 KodaX 进入该项目
2. 询问“你当前加载了哪些项目规则？”

**预期结果**:
- [ ] AI 能感知到项目规则
- [ ] 响应体现 `.kodax/AGENTS.md` 的内容

### TC-014: 规则优先级

**优先级**: 中  
**类型**: 正向测试

**步骤**:
1. 同时配置全局规则、目录规则、`.kodax/AGENTS.md`
2. 让 AI 复述当前规则来源和关键内容

**预期结果**:
- [ ] 多层规则可同时生效
- [ ] 项目级规则优先级最高
- [ ] 不会遗漏明显应加载的规则文件

---

## Feature 021 - Provider-Aware Reasoning Budget Matrix

### TC-015: `/reasoning` 模式切换

**优先级**: 高  
**类型**: 正向测试

**步骤**:
1. 依次执行 `/reasoning off`、`/reasoning auto`、`/reasoning quick`、`/reasoning balanced`、`/reasoning deep`
2. 观察状态栏变化

**预期结果**:
- [ ] 每个模式都能切换成功
- [ ] 状态栏模式显示同步更新
- [ ] thinking 开关与 reasoning mode 一致

### TC-016: `Ctrl+T` 快捷切换

**优先级**: 中  
**类型**: 交互测试

**步骤**:
1. 在空输入框状态下连续按 `Ctrl+T`
2. 观察状态栏

**预期结果**:
- [ ] 模式按预期循环切换
- [ ] 不会影响当前输入内容

### TC-017: 不同任务类型的默认推理强度

**优先级**: 中  
**类型**: 探索性测试

**步骤**:
1. 分别发起 `review`、`bugfix`、`plan`、`refactor` 类型请求
2. 在相同 provider 下观察响应风格和状态栏模式

**预期结果**:
- [ ] 默认推理行为与任务类型相符
- [ ] 不会所有任务都表现成同一种强度

---

## 回归测试

### TC-018: 长回复末行可见

**优先级**: 高  
**类型**: 回归测试

**步骤**:
1. 让 AI 输出带代码块、空行、粗体尾句的长回复
2. 观察最终屏幕显示
3. 对比 `/copy` 内容

**预期结果**:
- [ ] 屏幕上能看到最后一行
- [ ] `/copy` 与屏幕最后一段内容一致

### TC-019: Thinking 样式与历史恢复

**优先级**: 中  
**类型**: 回归测试

**步骤**:
1. 在启用 thinking 的模式下执行一轮对话
2. 重启或切换会话后恢复历史

**预期结果**:
- [ ] thinking 内容与普通 assistant 文本样式区分明显
- [ ] 历史恢复后不会退化成 `[Thinking]...[/Thinking]` 原始标签文本

### TC-020: `/history` 与主界面共存

**优先级**: 低  
**类型**: 回归测试

**步骤**:
1. 进行多轮对话后执行 `/history`
2. 再继续正常对话

**预期结果**:
- [ ] `/history` 能输出摘要
- [ ] 不会破坏后续主消息区渲染

---

## 测试总结

| 类别 | 用例数 | 通过 | 失败 | 阻塞 |
|------|--------|------|------|------|
| 冒烟 | 1 | - | - | - |
| Feature 013 | 2 | - | - | - |
| Feature 015 | 4 | - | - | - |
| Feature 017 | 5 | - | - | - |
| Feature 020 | 2 | - | - | - |
| Feature 021 | 3 | - | - | - |
| 回归 | 3 | - | - | - |
| 总计 | 20 | - | - | - |

**发布建议**:
- [ ] 可以发布
- [ ] 有条件发布
- [ ] 暂不建议发布

**主要问题记录**:
- [待填写]

**备注**:
- 如果 Feature 017 相关场景出现“空白 You 消息”“输入框左移”“队列不自动接力”“Esc 无法删队列”，应直接判定为阻塞问题。

