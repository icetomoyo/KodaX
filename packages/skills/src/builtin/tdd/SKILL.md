---
name: tdd
description: 用测试驱动开发方式实现或修复功能：先写失败测试，再做最小实现，最后重构。只在用户明确要求 TDD、先写测试、补回归测试或按 Red-Green-Refactor 工作时使用；不要用于单纯解释测试报错或泛泛讨论测试概念。
user-invocable: true
disable-model-invocation: true
allowed-tools: "Read, Grep, Glob, Write, Edit, Bash(npm:*, node:*, npx:*, vitest:*, jest:*, pytest:*)"
argument-hint: "[file-or-description]"
compatibility: "Works best in repositories with an existing test runner and established test conventions."
---

# TDD (Test-Driven Development) Skill

按小步快跑的 Red -> Green -> Refactor 循环工作，优先建立可复现的行为保护，再修改实现。

## 开始前

- 根据 `$ARGUMENTS` 明确目标行为、bug 场景或待实现功能。
- 先读现有实现、相邻测试和项目约定，优先沿用仓库已有的测试框架、fixture 和命名方式。
- 如果用户只要求“补测试”而没有要求改实现，就停在测试层，不主动改生产代码。

## RED

1. 写能暴露目标行为的最小失败测试。
2. 对 bug 修复，先写复现 bug 的回归测试。
3. 优先运行最小测试范围，确认它确实失败，并说明失败证明了什么。

## GREEN

1. 只做让新测试通过所需的最小实现改动。
2. 先重跑刚刚失败的测试；必要时再补跑相邻测试。
3. 不为了“顺手优化”扩大改动面。

## REFACTOR

1. 在测试保护下整理命名、消除重复、简化实现。
2. 任何重构后都重新运行相关测试，确保行为不变。
3. 只有在改动面较大或用户明确要求时，才扩大到更完整的测试集。

## 工作准则

- 优先断言对外可观察行为，而不是内部实现细节。
- 新增测试尽量贴近现有测试文件；只有在必要时才创建新文件。
- 如果仓库没有测试基础设施，先说明现状，再决定是补最小配置还是只给出建议。
- 不要把覆盖率数字当成目标；以行为信心和回归保护为准。

## 汇报方式

- 使用 `## RED`、`## GREEN`、`## REFACTOR` 三段汇报。
- 说明修改了哪些测试文件、哪些实现文件，以及运行了哪些测试命令。
- 最后补充剩余风险、未覆盖场景或后续建议。

## 使用示例

- `/tdd src/utils/format.ts` - 为 format.ts 编写测试
- `/tdd add user validation` - 实现用户验证功能 (TDD 方式)
- `/tdd` - 为当前 git 变更编写测试
