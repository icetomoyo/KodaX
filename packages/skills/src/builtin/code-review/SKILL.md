---
name: code-review
description: 审查代码、diff、提交或当前 git 改动，重点发现 bug、行为回归、边界条件遗漏、安全风险、性能问题和缺失测试。当用户提到 code review、review 这段代码、帮我看看改动有没有问题、审查 PR/提交时使用；不要用于单纯解释代码或直接实现需求。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Bash(npm:*, node:*, npx:*)"
argument-hint: "[file-or-directory]"
compatibility: "Works best in a git repository or when the review target is provided explicitly."
---

# Code Review Skill

对 **$ARGUMENTS** 进行代码审查，并优先输出真正会影响正确性、稳定性或可维护性的发现。

## 范围判定

- 如果提供了 `$ARGUMENTS`，审查对应文件、目录、diff 或提交范围。
- 如果没有提供参数，优先审查当前 git 改动；如果不在 git 仓库中，就明确说明缺少范围并请求更具体的目标。
- 在下结论前，尽量查看相邻实现、调用方、测试和相关配置，避免脱离上下文的误报。

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
- 如果没有发现值得报告的问题，明确写 `No findings.`，然后补充剩余风险或测试空白。
- 需要时再追加 `## Open Questions` 或 `## Change Summary`，但不要用总体打分或“亮点”冲淡问题。

## 输出模板

```markdown
## Findings
- [High] Title — `path/to/file.ts:42`
  Why it matters and what to change.

## Open Questions
- Optional clarification or assumption.

## Change Summary
- Optional short summary only after findings.
```

## 使用示例

- `/code-review src/auth.ts` - 审查单个文件
- `/code-review packages/core/src/` - 审查目录
- `/code-review` - 审查当前 git 变更
