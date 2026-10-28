---
name: code-review
description: 审查代码、diff、提交或当前 git 改动，重点发现 bug、行为回归、边界条件遗漏、安全风险、性能问题和缺失测试。当用户提到 code review、review 这段代码、帮我看看改动有没有问题、审查 PR/提交时使用；不要用于单纯解释代码或直接实现需求。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Bash(git status, git status *, git diff, git diff *, git log, git log *, git show, git show *, git ls-files, git ls-files *, git rev-parse, git rev-parse *, git ls-tree, git ls-tree *, git blame, git blame *, git cat-file *, npm *, node *, npx *)"
argument-hint: "[file-or-directory]"
compatibility: "Works best in a git repository or when the review target is provided explicitly."
---

# Code Review Skill

对 **$ARGUMENTS** 进行代码审查，并优先输出真正会影响正确性、稳定性或可维护性的发现。

## 范围判定

- 如果提供了 `$ARGUMENTS`，审查对应文件、目录、diff 或提交范围。
- 如果没有提供参数，先用 git status 清点任务相关的已暂存、未暂存与未跟踪文件，分别读取 staged/unstaged diff，并用 Read 检查相关未跟踪文件。一次 git diff 不代表审完全部改动。
- PR/提交范围使用明确基线，只审该范围，不混入当前工作区的无关修改；不在仓库且没有目标时才补齐范围。
- 在下结论前，尽量查看相邻实现、调用方、测试和相关配置，避免脱离上下文的误报。
- review-only 只报告，不编辑实现或暂存文件。测试前查看脚本副作用，沿用宿主授权；不为审查自动运行安装、--fix 或破坏性 Git 命令。

## 审查重点

- 正确性与回归风险：逻辑错误、边界条件、状态同步、类型假设、兼容性变化。
- 稳定性与安全性：异常处理、输入校验、资源泄漏、敏感信息暴露、权限或注入风险。
- 性能与可维护性：明显的复杂度问题、重复逻辑、难以验证的实现、缺失测试保护。
- 只报告有行动价值的问题。纯风格偏好或可选优化，不要包装成高优先级 finding。

## 严重级别

- `Critical`: 会导致数据丢失、严重安全问题、崩溃或明显错误结果。
- `High`: 很可能引发实际 bug、行为回归或线上风险。
- `Medium`: 不是立刻出错，但会留下明显缺陷、维护风险或测试空洞。
- `Low`: 小范围问题或局部改进点，仅在确实值得用户处理时报告。

## 输出要求

- 先给 `## Findings`，并按严重级别从高到低排列。
- 每条 finding 都要包含：
  - 严重级别和简短标题
  - 具体文件和行号
  - 为什么这是问题，可能造成什么影响
  - 建议的修复方向
- 如果没有发现值得报告的问题，明确写 `No findings.`，并说明实际覆盖和未验证范围；不能暗示未运行的测试已通过。
- 需要时再追加 `## Open Questions` 或 `## Change Summary`，但不要用总体打分或“亮点”冲淡问题。

## 使用示例

- `/code-review src/auth.ts` - 审查单个文件
- `/code-review packages/coding/src/` - 审查目录
- `/code-review` - 审查当前 git 变更

## Lean Review Lens

When the user asks for lean review, minimal diff, YAGNI, over-engineering, or
native/stdlib replacement opportunities, add this lens after correctness and
security findings:

- Look for code, files, abstractions, dependencies, configuration, or workflow
  changes that can be deleted without losing requested behavior.
- Prefer existing repository code, stdlib/native platform features, or an
  already-installed dependency when that is verifiably simpler than new custom
  code.
- Do not recommend cutting trust-boundary validation, security checks,
  data-loss protection, accessibility basics, observability needed for safety,
  or explicitly requested behavior.
- Do not present optional cleanup as a high-severity finding. Put non-blocking
  deletion/replacement ideas under `## Lean Suggestions`.
- For each lean suggestion, explain what can be skipped or removed and when it
  should be added back.
