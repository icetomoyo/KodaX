---
name: git-workflow
description: 执行明确的 Git 操作，例如查看状态、提交、建分支、push、stash 或创建 PR。只有在用户明确要求实际执行这些 Git 操作时才使用；不要用于单纯解释 Git 概念或讨论策略。
user-invocable: true
disable-model-invocation: true
allowed-tools: "Read, Grep, Glob, Bash(git:*, gh:*)"
argument-hint: "[status|commit|branch|push|pr|stash] [args]"
compatibility: "Requires a Git repository. Pull request creation works best when GitHub CLI (gh) is installed and authenticated."
---

# Git Workflow Skill

执行 Git 工作流时，优先保证仓库安全、改动边界清晰、命令可追溯。

## 总流程

1. 先检查仓库状态，例如 `git status --short --branch`，必要时补充 `git diff --stat`、`git diff --cached`、`git log --oneline`。
2. 根据第一个参数判断操作类型；如果用户表达明确，就直接执行对应流程。
3. 对会改写历史、删除数据或影响远程分支的操作，先说明风险；只有在用户明确要求时才继续。
4. 所有 Git 命令都使用非交互方式执行。

## 支持的操作

### status
- 汇总当前分支、upstream、已暂存/未暂存/未跟踪文件，以及明显的下一步建议。

### commit
- 只暂存与当前任务直接相关的文件；不要顺手带上无关改动。
- 如果用户没有提供 message，基于 diff 生成简洁的 Conventional Commit。
- 优先使用 `git add <path>`，避免无差别 `git add .`，除非用户明确要求全部提交。
- 提交前检查是否混入敏感文件或明显不该提交的产物。

**Commit 模板**
```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### branch
- `create` / `new`: 创建新分支。除非用户指定，否则遵循仓库已有命名风格。
- `switch` / `checkout`: 切换分支前，先检查当前工作区是否干净。
- `list`: 列出本地/远程分支，并在有帮助时指出当前分支。
- `delete` / `remove`: 仅在删除条件安全且用户请求明确时执行。

### push
- 先确认当前分支与 upstream 的关系。
- 首次 push 或没有 upstream 时，设置合适的 upstream。
- `--force` 或 `--force-with-lease` 只有在用户明确要求时才允许。

### pr
- 检查当前分支是否已 push，必要时先推送。
- 基于 diff 和提交历史生成简洁的 PR 标题与描述。
- 使用 `gh pr create` 前确认 `gh` 可用且已认证；否则清楚说明阻塞点。

### stash
- `save`: 有上下文时附带说明性消息。
- `list`: 列出 stash，并说明最近一条的用途。
- `pop`: 应用并删除最近 stash，若有冲突需明确报告。
- `drop`: 仅在用户明确要求删除时执行。

## 安全边界

- 不要使用 `git reset --hard`、`git checkout --`、`git clean -fd`、`git commit --amend`、强推、历史改写等危险操作，除非用户明确要求。
- 不要回滚、覆盖或丢弃用户的无关改动。
- 遇到脏工作区、冲突、无 upstream、权限不足、缺少 `gh` 等阻塞时，要先解释现状再继续。
- 对“合并分支”“rebase”“cherry-pick”等这里没有明确定义的操作，如果用户明确提出，可以按 Git 最佳实践执行，但要先说明风险和计划。

## 汇报方式

- 简洁说明执行了哪些命令、当前仓库状态变成了什么样。
- 如果因为风险或条件不满足而没有执行，要明确说明原因和下一步建议。

## 使用示例

- `/git-workflow status` - 查看当前仓库状态
- `/git-workflow commit` - 分析相关改动并提交
- `/git-workflow commit "fix: resolve auth bug"` - 使用指定消息提交
- `/git-workflow branch create feature/login` - 创建新分支
- `/git-workflow push` - 推送当前分支
- `/git-workflow pr` - 为当前分支创建 PR
- `/git-workflow stash` - 暂存当前变更
