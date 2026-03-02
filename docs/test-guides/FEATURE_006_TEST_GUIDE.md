# Feature 006: Skills System - Human Test Guide

_创建时间: 2026-02-28_
_更新时间: 2026-03-02_
_Feature: Skills 系统_
_状态: ReadyForTesting_
_最近修复: Issue 054 (P0 - LLM 上下文注入), Issue 056 (P1 - 渐进式披露), Issue 057 (P1 - pi-mono 命令格式)_

---

## 目录结构说明

> **重要**: KodaX 使用 `.kodax/` 目录，而非 `.claude/`

| 级别 | 路径 | 作用范围 |
|------|------|----------|
| 用户级 | `~/.kodax/skills/` | 用户所有项目 |
| 项目级 | `.kodax/skills/` | 仅当前项目 |
| 内置 | `packages/repl/src/skills/builtin/` | 随 KodaX 安装 |

---

## 测试顺序总览

| 阶段 | 测试范围 | 用例数 | 优先级 |
|------|----------|--------|--------|
| 阶段 1 | 环境验证 | 2 | P0 |
| 阶段 2 | 显式 Skill 调用 | 3 | P0 |
| 阶段 3 | 渐进式披露 | 2 | P1 |
| 阶段 4 | 完整功能测试 | 5 | P2 |

---

## 命令格式

| 命令 | 功能 |
|------|------|
| `/skill` | 列出所有可用 skills |
| `/skill:name [args]` | 调用指定 skill |
| 自然语言 | AI 自动发现和使用 skills |

---

## 阶段 1: 环境验证 (P0)

### Step 1.0: 构建并启动 REPL

**步骤**:
```bash
cd c:/Works/GitWorks/KodaX
npm run build
npm run dev
```

**预期结果**:
- [x] 构建成功，无错误
- [x] REPL 启动，显示欢迎信息
- [x] 显示提示符等待输入

---

### Step 1.1: TC-001 - 查看 skill 列表

**目的**: 验证 `/skill` 命令显示所有可用 skills

**步骤**:
1. 在 REPL 中输入 `/skill`
2. 观察输出

**预期结果**:
```
Available Skills:

  /skill:code-review [file-or-directory]  代码审查技能...
  /skill:git-workflow [operation]         Git 工作流技能...
  /skill:tdd [file-or-description]        测试驱动开发技能...

Usage: /skill:<name> [args] or ask naturally
```

- [x] 显示 "Available Skills" 标题
- [x] 列出 3 个内置技能，格式为 `/skill:name`
- [x] 每个技能显示名称、参数提示和描述

---

## 阶段 2: 显式 Skill 调用 (P0)

> **目的**: 验证 `/skill:name` 命令正确注入 LLM 上下文

### Step 2.1: TC-000 - Skill 内容注入 LLM 验证

**前置条件**:
- 已配置有效的 AI Provider
- 网络连接正常

**步骤**:
1. 输入 `/skill:code-review packages/core/src/agent.ts`
2. 观察 UI 输出

**预期结果**:
- [x] 显示 "Invoking skill: code-review"
- [x] 显示 "Skill activated: code-review"
- [x] AI 开始生成响应（说明 skill 内容已注入）
- [x] AI 响应包含代码审查相关内容

---

### Step 2.2: TC-000a - TDD Skill 验证

**步骤**:
1. 输入 `/skill:tdd packages/repl/src/commands.ts`
2. 观察 AI 响应

**预期结果**:
- [ ] AI 按照 TDD skill 定义的流程工作（RED-GREEN-REFACTOR）
- [ ] AI 正确引用了用户提供的参数

---

### Step 2.3: TC-000b - 参数替换验证

**步骤**:
1. 输入 `/skill:git-workflow status`
2. 观察 AI 响应

**预期结果**:
- [ ] AI 执行 git status 相关操作
- [ ] AI 响应与参数 "status" 相关

---

## 阶段 3: 渐进式披露 (P1)

> **目的**: 验证 AI 能通过系统提示词发现并主动使用 skills

### Step 3.1: TC-000c - 自然语言触发 Skill (核心测试)

**步骤**:
1. 输入自然语言（不要使用 `/skill:name` 格式）:
   ```
   请帮我审查一下 packages/core/src/agent.ts 的代码
   ```
2. 观察 AI 响应

**预期结果**:
- [ ] AI 识别到这是一个代码审查任务
- [ ] AI 提到它可以使用 `code-review` skill
- [ ] AI 自行读取 skill 文件并按照 skill 指导执行

---

### Step 3.2: TC-000d - disableModelInvocation 过滤验证

**步骤**:

1. 创建测试 skill 目录:
```bash
mkdir -p .kodax/skills/internal-tool
```

2. 创建 `.kodax/skills/internal-tool/SKILL.md`:
```markdown
---
name: internal-tool
description: 内部工具，不应被 AI 主动使用
user-invocable: true
disable-model-invocation: true
---

# Internal Tool

这是一个只能通过显式命令调用的工具。
```

3. 重启 REPL

4. 输入自然语言: "我需要使用内部工具来处理一些事情"

**预期结果**:
- [ ] AI **不会**自动发现并使用 `internal-tool` skill
- [ ] 仍然可以通过 `/skill:internal-tool` 显式调用

---

## 阶段 4: 完整功能测试 (P2)

### Step 4.1: TC-008 - 创建自定义技能

**步骤**:

1. 创建目录:
```bash
mkdir -p .kodax/skills/my-skill
```

2. 创建 `.kodax/skills/my-skill/SKILL.md`:
```markdown
---
name: my-skill
description: 我的自定义技能
user-invocable: true
---

# My Custom Skill

这是一个自定义技能测试。
处理 $ARGUMENTS 的任务。
```

3. 重启 REPL

4. 输入 `/skill`

**预期结果**:
- [ ] 技能列表中包含 `/skill:my-skill`
- [ ] 描述显示 "我的自定义技能"

---

### Step 4.2: TC-009 - 调用自定义技能

**步骤**:
1. 输入 `/skill:my-skill hello world`

**预期结果**:
- [ ] Skill 正常激活
- [ ] AI 响应包含对 "hello world" 的处理

---

### Step 4.3: TC-013 - 无效技能调用

**步骤**:
1. 输入 `/skill:non-existent`

**预期结果**:
- [ ] 显示错误信息: "Skill not found: non-existent"

---

### Step 4.4: TC-014 - 技能参数替换

**步骤**:

1. 创建测试技能 `.kodax/skills/arg-test/SKILL.md`:
```markdown
---
name: arg-test
description: 参数测试
argument-hint: "<arg1> <arg2>"
---

Test skill.
Arguments: $ARGUMENTS
First: $0
Second: $1
```

2. 重启 REPL

3. 调用 `/skill:arg-test foo bar`

**预期结果**:
- [ ] AI 响应中参数被正确替换
- [ ] $ARGUMENTS → "foo bar"
- [ ] $0 → "foo"
- [ ] $1 → "bar"

---

### Step 4.5: TC-011 - 技能优先级

**步骤**:

1. 创建用户级技能 `~/.kodax/skills/user-skill/SKILL.md`:
```markdown
---
name: user-skill
description: 用户级技能
---
用户级
```

2. 创建项目级同名技能 `.kodax/skills/user-skill/SKILL.md`:
```markdown
---
name: user-skill
description: 项目级覆盖版本
---
项目级覆盖
```

3. 重启 REPL

4. 输入自然语言: "user-skill 是做什么的？"

**预期结果**:
- [ ] AI 描述显示 "项目级覆盖版本"（项目级优先于用户级）

---

## 测试总结

| 阶段 | 测试数 | 优先级 |
|------|--------|--------|
| 阶段 1: 环境验证 | 2 | P0 |
| 阶段 2: 显式调用 | 3 | P0 |
| 阶段 3: 渐进式披露 | 2 | P1 |
| 阶段 4: 完整功能 | 5 | P2 |

---

## 测试完成标准

### P0 - 必须通过
- [ ] 阶段 1 全部通过
- [ ] Step 2.1: Skill 内容注入 LLM
- [ ] Step 3.1: 自然语言触发 Skill

### P1 - 应该通过
- [ ] Step 2.3: 参数替换
- [ ] Step 3.2: disableModelInvocation 过滤

---

## 清理测试数据

```bash
# 删除项目级测试技能
rm -rf .kodax/skills/my-skill
rm -rf .kodax/skills/arg-test
rm -rf .kodax/skills/internal-tool
rm -rf .kodax/skills/user-skill

# 删除用户级测试技能 (可选)
rm -rf ~/.kodax/skills/user-skill
```
