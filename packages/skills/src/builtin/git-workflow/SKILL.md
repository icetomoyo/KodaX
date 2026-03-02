---
name: git-workflow
description: Git 工作流技能。当用户要求提交代码、创建 PR、合并分支、git commit、push、branch 管理时使用。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Bash(git:*)"
argument-hint: "[action] [args]"
---

# Git Workflow Skill

Git 工作流辅助，帮助管理代码版本和分支。

## 当前 Git 状态

!`git status --short`

## 支持的操作

### commit - 智能提交
分析当前变更并生成规范的 commit message。

**格式**: `/git-workflow commit [message]`

**流程**:
1. 检查 `git status` 和 `git diff`
2. 分析变更内容
3. 生成符合 Conventional Commits 的消息
4. 执行 `git add` 和 `git commit`

**Commit 格式**:
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types**: feat, fix, refactor, docs, test, chore, perf, ci

### branch - 分支管理
创建、切换或删除分支。

**格式**: `/git-workflow branch <action> <name>`

**Actions**:
- `create` / `new` - 创建新分支
- `switch` / `checkout` - 切换分支
- `delete` / `remove` - 删除分支
- `list` - 列出所有分支

### pr - Pull Request
创建 Pull Request。

**格式**: `/git-workflow pr [title]`

**流程**:
1. 检查当前分支状态
2. 推送到远程
3. 生成 PR 标题和描述
4. 创建 PR (需要 gh CLI)

### stash - 暂存管理
管理 git stash。

**格式**: `/git-workflow stash [action]`

**Actions**:
- `save` / (无参数) - 暂存当前变更
- `pop` - 恢复最近暂存
- `list` - 列出所有暂存
- `drop` - 删除最近暂存

## 使用示例

- `/git-workflow commit` - 分析变更并提交
- `/git-workflow commit "fix: resolve auth bug"` - 使用指定消息提交
- `/git-workflow branch create feature/login` - 创建新分支
- `/git-workflow pr` - 为当前分支创建 PR
- `/git-workflow stash` - 暂存当前变更

## 注意事项

- 提交前会检查是否有敏感文件 (.env, credentials 等)
- PR 创建需要 `gh` CLI 并已认证
- 分支操作会检查未提交的变更
