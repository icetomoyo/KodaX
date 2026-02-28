# Feature 006: Skills System - Human Test Guide

_创建时间: 2026-02-28_
_Feature: Skills 系统_
_状态: ReadyForTesting_

---

## 1. 测试环境准备

### 1.1 构建项目

```bash
cd c:/Works/GitWorks/KodaX
npm run build
```

### 1.2 启动 REPL

```bash
npm run dev
# 或
node dist/repl/index.js
```

---

## 2. 测试用例

### TC-001: 查看 /skills 帮助

**目的**: 验证 `/skills` 命令帮助信息

**步骤**:
1. 在 REPL 中输入 `/skills`
2. 观察输出

**预期结果**:
- 显示 "Available Skills" 标题
- 列出 3 个内置技能: `code-review`, `git-workflow`, `tdd`
- 每个技能显示名称和描述

**状态**: [ ] Pass [ ] Fail

---

### TC-002: 列出所有技能

**目的**: 验证技能列表功能

**步骤**:
1. 输入 `/skills list`

**预期结果**:
```
Available Skills (3):

  /code-review - 代码审查技能。当用户要求审查代码...
  /git-workflow - Git 工作流技能...
  /tdd - 测试驱动开发技能...

Use /skills info <name> for details
```

**状态**: [ ] Pass [ ] Fail

---

### TC-003: 查看技能详情

**目的**: 验证技能详情显示

**步骤**:
1. 输入 `/skills info code-review`

**预期结果**:
- 显示技能名称: `code-review`
- 显示描述
- 显示参数提示: `[file-or-directory]`
- 显示允许的工具: `Read, Grep, Glob, Bash(...)`

**状态**: [ ] Pass [ ] Fail

---

### TC-004: 调用 code-review 技能

**目的**: 验证技能调用

**步骤**:
1. 输入 `/code-review src/utils.ts`

**预期结果**:
- 系统提示加载技能
- 技能内容被注入到对话中
- AI 开始进行代码审查

**状态**: [ ] Pass [ ] Fail

---

### TC-005: 调用 git-workflow 技能

**目的**: 验证另一个内置技能

**步骤**:
1. 输入 `/git-workflow commit`

**预期结果**:
- 系统加载 git-workflow 技能
- AI 协助进行 git 提交流程

**状态**: [ ] Pass [ ] Fail

---

### TC-006: 调用 tdd 技能

**目的**: 验证 tdd 技能调用

**步骤**:
1. 输入 `/tdd auth-service`

**预期结果**:
- 系统加载 tdd 技能
- AI 协助进行测试驱动开发

**状态**: [ ] Pass [ ] Fail

---

### TC-007: 查看重载技能

**目的**: 验证技能重载功能

**步骤**:
1. 输入 `/skills reload`

**预期结果**:
- 显示 "Reloading skills..."
- 显示发现技能数量

**状态**: [ ] Pass [ ] Fail

---

### TC-008: 创建自定义技能

**目的**: 验证项目级技能加载

**步骤**:
1. 创建目录和文件:
```bash
mkdir -p .claude/skills/my-skill
```

2. 创建 `.claude/skills/my-skill/SKILL.md`:
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

3. 在 REPL 中输入 `/skills reload`
4. 输入 `/skills list`

**预期结果**:
- 技能列表中包含 `my-skill`
- 描述显示 "我的自定义技能"

**状态**: [ ] Pass [ ] Fail

---

### TC-009: 调用自定义技能

**目的**: 验证自定义技能执行

**步骤**:
1. 输入 `/my-skill hello world`

**预期结果**:
- AI 响应包含对 "hello world" 的处理

**状态**: [ ] Pass [ ] Fail

---

### TC-010: 用户级技能路径

**目的**: 验证用户级技能加载

**步骤**:
1. 创建目录:
```bash
mkdir -p ~/.claude/skills/user-skill
```

2. 创建 `~/.claude/skills/user-skill/SKILL.md`:
```markdown
---
name: user-skill
description: 用户级技能
user-invocable: true
---

# User Skill

这是用户级技能。
```

3. 在 REPL 中输入 `/skills reload`
4. 输入 `/skills list`

**预期结果**:
- 技能列表中包含 `user-skill`

**状态**: [ ] Pass [ ] Fail

---

### TC-011: 技能优先级

**目的**: 验证高优先级技能覆盖低优先级

**步骤**:
1. 在项目级创建同名技能:
```markdown
---
name: user-skill
description: 项目级覆盖版本
---
```

2. 输入 `/skills reload`
3. 输入 `/skills info user-skill`

**预期结果**:
- 描述显示 "项目级覆盖版本"

**状态**: [ ] Pass [ ] Fail

---

### TC-012: 帮助命令显示技能

**目的**: 验证 `/help` 包含技能信息

**步骤**:
1. 输入 `/help`

**预期结果**:
- 帮助输出包含 "Skills" 类别
- 显示技能相关命令说明

**状态**: [ ] Pass [ ] Fail

---

### TC-013: 无效技能调用

**目的**: 验证错误处理

**步骤**:
1. 输入 `/non-existent-skill`

**预期结果**:
- 显示错误信息: "Skill not found: non-existent-skill"
- 或类似提示

**状态**: [ ] Pass [ ] Fail

---

### TC-014: 技能参数替换

**目的**: 验证 $ARGUMENTS 变量替换

**步骤**:
1. 创建测试技能:
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

2. 调用 `/arg-test foo bar`

**预期结果**:
- AI 响应中参数被正确替换
- $ARGUMENTS → "foo bar"
- $0 → "foo"
- $1 → "bar"

**状态**: [ ] Pass [ ] Fail

---

### TC-015: 技能元数据验证

**目的**: 验证无效 SKILL.md 被正确处理

**步骤**:
1. 创建无效技能 (缺少 description):
```markdown
---
name: invalid-skill
---

Missing description.
```

2. 输入 `/skills reload`
3. 观察错误日志

**预期结果**:
- 技能加载失败，错误被记录
- 不影响其他技能加载

**状态**: [ ] Pass [ ] Fail

---

## 3. 测试总结

| 测试用例 | 状态 | 备注 |
|----------|------|------|
| TC-001 | [ ] | /skills 帮助 |
| TC-002 | [ ] | /skills list |
| TC-003 | [ ] | /skills info |
| TC-004 | [ ] | code-review 调用 |
| TC-005 | [ ] | git-workflow 调用 |
| TC-006 | [ ] | tdd 调用 |
| TC-007 | [ ] | /skills reload |
| TC-008 | [ ] | 自定义技能创建 |
| TC-009 | [ ] | 自定义技能调用 |
| TC-010 | [ ] | 用户级技能 |
| TC-011 | [ ] | 技能优先级 |
| TC-012 | [ ] | /help 显示技能 |
| TC-013 | [ ] | 无效技能错误 |
| TC-014 | [ ] | 参数替换 |
| TC-015 | [ ] | 元数据验证 |

---

## 4. 测试完成标准

- [ ] 所有 15 个测试用例通过
- [ ] 无阻塞问题
- [ ] 至少完成 3 个内置技能验证

---

## 5. 问题记录

| 问题 ID | 描述 | 严重程度 | 状态 |
|---------|------|----------|------|
| | | | |
