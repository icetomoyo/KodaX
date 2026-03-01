# Feature 006: Skills System - Human Test Guide

_创建时间: 2026-02-28_
_更新时间: 2026-03-01_
_Feature: Skills 系统_
_状态: ReadyForTesting_
_最近修复: Issue 054 (P0 - LLM 上下文注入), Issue 056 (P1 - 渐进式披露), Issue 057 (P1 - pi-mono 命令格式)_

---

## 测试顺序总览

| 阶段 | 测试范围 | 用例数 | 优先级 |
|------|----------|--------|--------|
| 阶段 1 | 环境验证 | 3 | P0 |
| 阶段 2 | Issue 054/057 - 显式调用 | 4 | P0 |
| 阶段 3 | Issue 056 - 渐进式披露 | 3 | P1 |
| 阶段 4 | 完整功能测试 | 8 | P2 |

---

## 命令格式说明 (Issue 057)

> **重要**: KodaX 现在采用 pi-mono 风格的命令格式

| 命令 | 功能 |
|------|------|
| `/skill` | 列出所有可用 skills |
| `/skill:name [args]` | 调用指定 skill |
| 自然语言 | AI 自动发现和使用 skills |

**已废弃**:
- `/skills` → 重定向到 `/skill`
- `/skill-name` → 使用 `/skill:name` 替代

---

## 阶段 1: 环境验证 (P0)

> **目的**: 确保基础环境正常，Skills 系统可被访问

### Step 1.0: 构建并启动 REPL

**步骤**:
```bash
cd c:/Works/GitWorks/KodaX
npm run build
npm run dev
```

**预期结果**:
- [ ] 构建成功，无错误
- [ ] REPL 启动，显示欢迎信息
- [ ] 显示提示符等待输入

**状态**: [ ] Pass [ ] Fail

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

- [ ] 显示 "Available Skills" 标题
- [ ] 列出 3 个内置技能，格式为 `/skill:name`
- [ ] 每个技能显示名称、参数提示和描述
- [ ] 底部显示使用提示

**状态**: [ ] Pass [ ] Fail

---

### Step 1.2: TC-002 - 旧命令废弃提示

**目的**: 验证 `/skills` 命令显示废弃提示并重定向

**步骤**:
1. 输入 `/skills`

**预期结果**:
- [ ] 显示废弃提示: "[/skills is deprecated. Use /skill instead]"
- [ ] 随后显示 skill 列表（与 `/skill` 相同）

**状态**: [ ] Pass [ ] Fail

---

### Step 1.3: TC-003 - 自然语言查询 skill 详情

**目的**: 验证 AI-first 设计 - 用自然语言了解 skill 详情

**步骤**:
1. 输入自然语言: "code-review skill 是做什么的？"
2. 观察 AI 响应

**预期结果**:
- [ ] AI 读取 skill 文件并解释功能
- [ ] AI 描述 skill 的工作流程
- [ ] 无需使用 `/skills info` 命令

**状态**: [ ] Pass [ ] Fail [ ] Partial

---

## 阶段 2: Issue 054/057 验证 - 显式 Skill 调用 (P0)

> **目的**: 验证 `/skill:name` 命令正确注入 LLM 上下文
> **修复前**: skill 只打印预览，不注入 LLM
> **修复后**: skill 内容被展开为 XML 格式并注入 LLM 上下文
> **Issue 057**: 命令格式从 `/skill-name` 改为 `/skill:name`

### Step 2.1: TC-000 - Skill 内容注入 LLM 验证

**目的**: 验证 skill 内容被正确注入 LLM 上下文

**前置条件**:
- 已配置有效的 AI Provider (Anthropic/OpenAI)
- 网络连接正常

**步骤**:
1. 输入 `/skill:code-review packages/core/src/agent.ts`
2. 观察 UI 输出

**预期结果**:
- [ ] 显示 "Invoking skill: code-review"
- [ ] 显示 "Skill activated: code-review"
- [ ] 显示 "The skill context has been prepared for the AI."
- [ ] AI 开始生成响应（说明 skill 内容已注入）
- [ ] AI 响应包含代码审查相关内容（不是普通对话）

**状态**: [ ] Pass [ ] Fail

---

### Step 2.2: TC-000a - Skill XML 格式验证

**目的**: 验证 skill 被正确展开为 XML 格式

**步骤**:
1. 输入 `/skill:tdd packages/repl/src/commands.ts`
2. 观察 AI 响应

**预期结果**:
- [ ] AI 响应表明它收到了 skill 内容
- [ ] AI 按照 TDD skill 定义的流程工作（RED-GREEN-REFACTOR）
- [ ] AI 正确引用了用户提供的参数 (`packages/repl/src/commands.ts`)

**状态**: [ ] Pass [ ] Fail

---

### Step 2.3: TC-000b - 参数替换验证

**目的**: 验证 $ARGUMENTS 被正确替换

**步骤**:
1. 输入 `/skill:git-workflow status`
2. 观察 AI 响应

**预期结果**:
- [ ] AI 执行 git status 相关操作
- [ ] AI 响应与参数 "status" 相关

**状态**: [ ] Pass [ ] Fail

---

### Step 2.4: TC-000e - 显式调用回归验证

**目的**: 验证渐进式披露不影响显式 skill 调用

**步骤**:
1. 输入 `/skill:code-review packages/core/src/types.ts`
2. 观察 AI 响应

**预期结果**:
- [ ] Skill 正常激活
- [ ] AI 按照 skill 内容执行
- [ ] 与 Step 2.1 的行为一致

**状态**: [ ] Pass [ ] Fail

---

## 阶段 3: Issue 056 验证 - 渐进式披露 (P1)

> **目的**: 验证 AI 能通过系统提示词发现并主动使用 skills
> **核心问题**: `getSystemPromptSnippet()` 方法存在但未被调用
> **修复内容**: 在 `runAgentRound` 中调用并注入系统提示词

### Step 3.1: TC-000c - 自然语言触发 Skill (核心测试)

**目的**: 验证 AI 能够通过系统提示词发现并主动使用可用 skills

**前置条件**:
- 至少有一个内置 skill 可用 (code-review, tdd, git-workflow)

**步骤**:
1. 输入自然语言请求，**不要**使用 `/skill:name` 格式:
   ```
   请帮我审查一下 packages/core/src/agent.ts 的代码
   ```
2. 观察 AI 响应

**预期结果**:
- [ ] AI 识别到这是一个代码审查任务
- [ ] AI 提到它可以使用 `code-review` skill
- [ ] AI 自行读取 skill 文件并按照 skill 指导执行
- [ ] AI 响应符合 skill 定义的工作流程

**验证原理**:
> 渐进式披露机制的工作方式:
> 1. 系统提示词包含 skill 列表 (name, description, location)
> 2. AI 根据用户描述匹配 skill 的 description
> 3. AI 使用 Read 工具读取完整 SKILL.md 文件
> 4. AI 按照 skill 内容执行任务
>
> 注：AI 不一定会每次都触发，但应该能识别并建议使用 skill

**状态**: [ ] Pass [ ] Fail [ ] Partial

---

### Step 3.2: TC-000d - disableModelInvocation 过滤验证

**目的**: 验证 `disableModelInvocation: true` 的 skill 不会出现在系统提示词中

**步骤**:

1. 创建测试 skill 目录:
```bash
mkdir -p .claude/skills/internal-tool
```

2. 创建 `.claude/skills/internal-tool/SKILL.md`:
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

3. 重启 REPL（重新加载 skills）

4. 输入自然语言: "我需要使用内部工具来处理一些事情"

5. 观察 AI 响应

**预期结果**:
- [ ] AI **不会**自动发现并使用 `internal-tool` skill
- [ ] AI 可能会询问用户想使用什么工具
- [ ] 仍然可以通过 `/skill:internal-tool` 显式调用

**状态**: [ ] Pass [ ] Fail

---

### Step 3.3: 第二次自然语言触发验证

**目的**: 再次验证渐进式披露机制

**步骤**:
1. 输入自然语言:
   ```
   我想用 TDD 的方式为 packages/repl/src/commands.ts 写测试
   ```
2. 观察 AI 响应

**预期结果**:
- [ ] AI 识别到这是 TDD 任务
- [ ] AI 提到或使用 `tdd` skill
- [ ] AI 按照 TDD 流程工作

**状态**: [ ] Pass [ ] Fail [ ] Partial

---

## 阶段 4: 完整功能测试 (P2)

> **目的**: 验证 Skills 系统的完整功能

### Step 4.1: TC-008 - 创建自定义技能

**目的**: 验证项目级技能加载

**步骤**:

1. 创建目录:
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

3. 重启 REPL

4. 输入 `/skill`

**预期结果**:
- [ ] 技能列表中包含 `/skill:my-skill`
- [ ] 描述显示 "我的自定义技能"

**状态**: [ ] Pass [ ] Fail

---

### Step 4.2: TC-009 - 调用自定义技能

**目的**: 验证自定义技能执行

**步骤**:
1. 输入 `/skill:my-skill hello world`

**预期结果**:
- [ ] Skill 正常激活
- [ ] AI 响应包含对 "hello world" 的处理

**状态**: [ ] Pass [ ] Fail

---

### Step 4.3: TC-012 - 帮助命令显示技能

**目的**: 验证 `/help` 包含技能信息

**步骤**:
1. 输入 `/help`

**预期结果**:
- [ ] 帮助输出包含 "Skills" 类别
- [ ] 显示 `/skill` 和 `/skill:<name>` 命令说明

**状态**: [ ] Pass [ ] Fail

---

### Step 4.4: TC-013 - 无效技能调用

**目的**: 验证错误处理

**步骤**:
1. 输入 `/skill:non-existent`

**预期结果**:
- [ ] 显示错误信息: "Skill not found: non-existent"
- [ ] 或类似提示

**状态**: [ ] Pass [ ] Fail

---

### Step 4.5: TC-014 - 技能参数替换

**目的**: 验证 $ARGUMENTS 变量替换

**步骤**:

1. 创建测试技能 `.claude/skills/arg-test/SKILL.md`:
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

**状态**: [ ] Pass [ ] Fail

---

### Step 4.6: TC-010 - 用户级技能路径

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

3. 重启 REPL

4. 输入 `/skill`

**预期结果**:
- [ ] 技能列表中包含 `/skill:user-skill`

**状态**: [ ] Pass [ ] Fail

---

### Step 4.7: TC-011 - 技能优先级

**目的**: 验证高优先级技能覆盖低优先级

**步骤**:

1. 在项目级创建同名技能 `.claude/skills/user-skill/SKILL.md`:
```markdown
---
name: user-skill
description: 项目级覆盖版本
---

项目级覆盖
```

2. 重启 REPL

3. 输入自然语言: "user-skill 是做什么的？"

**预期结果**:
- [ ] AI 描述显示 "项目级覆盖版本"（项目级优先于用户级）

**状态**: [ ] Pass [ ] Fail

---

### Step 4.8: TC-015 - 旧格式拒绝验证

**目的**: 验证旧格式 `/skill-name` 不再工作

**步骤**:
1. 输入 `/code-review packages/core/src/agent.ts`

**预期结果**:
- [ ] 显示 "Unknown command: /code-review"
- [ ] 提示使用 `/help` 查看可用命令
- [ ] 或者显示建议使用 `/skill:code-review`

**状态**: [ ] Pass [ ] Fail

---

## 测试总结

### 阶段 1: 环境验证

| Step | 测试ID | 状态 | 备注 |
|------|--------|------|------|
| 1.0 | 环境 | [ ] | 构建并启动 REPL |
| 1.1 | TC-001 | [ ] | /skill 列表 |
| 1.2 | TC-002 | [ ] | /skills 废弃提示 |
| 1.3 | TC-003 | [ ] | 自然语言查询 skill |

### 阶段 2: Issue 054/057 - 显式调用 (P0)

| Step | 测试ID | 状态 | 备注 |
|------|--------|------|------|
| 2.1 | TC-000 | [ ] | Skill 内容注入 LLM |
| 2.2 | TC-000a | [ ] | Skill XML 格式 |
| 2.3 | TC-000b | [ ] | 参数替换 |
| 2.4 | TC-000e | [ ] | 显式调用回归 |

### 阶段 3: Issue 056 - 渐进式披露 (P1)

| Step | 测试ID | 状态 | 备注 |
|------|--------|------|------|
| 3.1 | TC-000c | [ ] | **自然语言触发 (核心)** |
| 3.2 | TC-000d | [ ] | disableModelInvocation 过滤 |
| 3.3 | 二次验证 | [ ] | 自然语言触发 TDD |

### 阶段 4: 完整功能 (P2)

| Step | 测试ID | 状态 | 备注 |
|------|--------|------|------|
| 4.1 | TC-008 | [ ] | 自定义技能创建 |
| 4.2 | TC-009 | [ ] | 自定义技能调用 |
| 4.3 | TC-012 | [ ] | /help 显示技能 |
| 4.4 | TC-013 | [ ] | 无效技能错误 |
| 4.5 | TC-014 | [ ] | 参数替换 |
| 4.6 | TC-010 | [ ] | 用户级技能 |
| 4.7 | TC-011 | [ ] | 技能优先级 |
| 4.8 | TC-015 | [ ] | 旧格式拒绝 |

---

## 测试完成标准

### P0 - 必须通过 (阻塞发布)
- [ ] 阶段 1 全部通过
- [ ] Step 2.1: TC-000 Skill 内容注入 LLM
- [ ] Step 2.2: TC-000a Skill XML 格式
- [ ] Step 3.1: TC-000c 自然语言触发 Skill

### P1 - 应该通过
- [ ] Step 2.3: TC-000b 参数替换
- [ ] Step 2.4: TC-000e 显式调用回归
- [ ] Step 3.2: TC-000d disableModelInvocation 过滤
- [ ] Step 3.3: 二次自然语言触发
- [ ] Step 4.8: TC-015 旧格式拒绝

### P2 - 基本功能验证
- [ ] 阶段 4 测试通过率 ≥ 80%
- [ ] 无阻塞问题

---

## 问题记录

| 问题 ID | 相关测试 | 描述 | 严重程度 | 状态 |
|---------|----------|------|----------|------|
| | | | | |

---

## 清理测试数据

测试完成后，清理创建的测试技能：

```bash
# 删除项目级测试技能
rm -rf .claude/skills/my-skill
rm -rf .claude/skills/arg-test
rm -rf .claude/skills/internal-tool
rm -rf .claude/skills/user-skill

# 删除用户级测试技能 (可选)
rm -rf ~/.claude/skills/user-skill
```
