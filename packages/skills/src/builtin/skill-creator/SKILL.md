---
name: skill-creator
description: 创建、重写、移植和优化 KodaX/Agent Skills。当用户想新建 skill、把外部 skill 迁移到 KodaX、改进触发描述、整理 supporting files、设计评测用例或验证 skill 结构时使用。用户即使没有明确说“skill”，只要在描述可复用的代理工作流、想把一套提示词/脚本打包成能力，也应该使用这个 skill。
user-invocable: true
allowed-tools: "Read, Grep, Glob, Write, Edit, Bash(node:*, npm:*, npx:*)"
argument-hint: "[skill-name-or-task]"
compatibility: "Optimized for KodaX and Agent Skills style directories. Bundled helper scripts use Node.js instead of Python."
---

# Skill Creator

把用户的工作流整理成一个可维护、可触发、可评估的 skill。优先适配 KodaX 的 skill 运行方式，而不是逐字复制外部平台的实现。

## 何时使用

- 用户要新建 skill，或把一次对话里的工作流沉淀成 skill。
- 用户要改已有 skill 的触发描述、结构、supporting files 或提示词。
- 用户要把 Claude / Anthropic / 其他平台的 skill 移植到 KodaX。
- 用户要为 skill 设计测试提示、评估结构、人工 review 流程或 benchmark 汇总。

## 工作方式

### 1. 先收敛目标

先明确四件事：

1. 这个 skill 要解决什么任务。
2. 什么时候应该触发，什么时候不该触发。
3. 输出是什么形态。
4. 是否需要评测和人工 review。

如果用户已经给了样例对话、提示词或外部 skill 仓库，先从已有材料里提炼，不要重复让用户描述。

### 2. 适配 KodaX，而不是照抄外部 skill

移植外部 skill 时，拆成三类：

- 可直接复用：SKILL.md 的思路、评测结构、参考文档组织方式。
- 需要改写：路径约定、触发描述、支持的 frontmatter 字段、命令示例。
- 不要硬搬：强依赖 Claude Code / `claude -p` / Cowork / Python stdlib / 专有事件流的部分。

如果外部 skill 依赖特定宿主能力，优先改成 KodaX 当前能承接的手工流程或 Node 工具，而不是留下名不副实的说明。

### 3. 写 KodaX 风格的 skill

- `description` 要写“做什么 + 什么时候用”，并且稍微主动一点，避免 under-trigger。
- `SKILL.md` 负责主流程，不要把所有细节都塞进去。
- 重复性、机械性、易出错的步骤，放到 `scripts/`。
- 大块参考资料放到 `references/`。
- 模板或静态文件放到 `assets/`。

### 4. Bundled scripts 默认用 Node.js

KodaX 当前会把 builtin skill 目录直接复制到 `dist/`。因此：

- skill 内的可执行脚本默认使用 plain Node ESM `.js`。
- 只有在你同时修改了构建链、确保脚本会被编译时，才在 skill 内使用 `.ts`。
- 如果用户只是想“改成 node/typescript”，默认先落成 Node `.js`，这是最稳妥的内建交付方式。

### 5. 先验证，再评估

起草完成后：

1. 用 `node scripts/quick-validate.js <skill-dir>` 做结构检查。
2. 设计 2 到 3 个真实用户会说的测试提示。
3. 如果要评估 description 的触发效果，先整理 `evals.json`，再用 `node scripts/run-trigger-eval.js --skill-path <skill-dir> --evals <evals.json>` 跑一轮触发评测。
4. 如果要迭代 description，可以用 `node scripts/improve-description.js --skill-path <skill-dir> --eval-results <results.json>` 生成候选描述，或用 `node scripts/run-loop.js --skill-path <skill-dir> --evals <evals.json> --workspace <workspace-dir>` 跑多轮优化。
5. 如果需要人工 review，把运行结果整理到 workspace，再用 `node scripts/generate-review.js <workspace> --static <html-file>` 或本地服务模式生成 review 页面。
6. 如果已经有 `grading.json` / `timing.json`，再用 `node scripts/aggregate-benchmark.js <iteration-dir> --skill-name <name>` 聚合 benchmark。
7. 如果要分享给别的 KodaX/Agent Skills 风格环境，用 `node scripts/package-skill.js <skill-dir>` 打包，再用 `node scripts/install-skill.js <archive-or-dir>` 验证安装链路。

## 评估建议

- 客观任务：优先写断言、grading 结构和 benchmark。
- 主观任务：优先给人类 review 页面，而不是强行量化。
- 描述优化：先整理误触发/漏触发样例，再跑 `run-trigger-eval`，需要时再用 `improve-description` 或 `run-loop` 迭代。

## 输出要求

默认给出：

- 修改后的 `SKILL.md`
- 新增或更新的 supporting files
- 简短的 trigger/eval 样例
- 还没覆盖的风险或后续建议

如果用户是在移植外部 skill，还要额外说明：

- 哪些能力已经迁移
- 哪些能力因为宿主差异被删减或改写
- 哪些部分后续值得继续产品化

## 可用工具

- `scripts/quick-validate.js`：校验 skill 结构和 frontmatter。
- `scripts/run-trigger-eval.js`：对 description 做 KodaX 原生触发评测，检查误触发和漏触发。
- `scripts/improve-description.js`：基于评测结果生成新的 description 候选。
- `scripts/run-loop.js`：把触发评测和 description 改写串成可重复的多轮优化流程。
- `scripts/aggregate-benchmark.js`：聚合 `grading.json` / `timing.json` 生成 `benchmark.json` 与 `benchmark.md`。
- `scripts/generate-review.js`：把 workspace 结果生成静态或本地服务版 HTML review 页面。
- `scripts/package-skill.js`：把 skill 目录打成 `.skill` 归档，便于分享与分发。
- `scripts/install-skill.js`：把 `.skill` 归档或目录安装到目标 skills 目录。
- `references/schemas.md`：评测相关 JSON 结构参考。
- 这里的 description eval / loop / packaging 已经是 KodaX 原生实现，不再依赖 Anthropic 的 Python 脚本或 Claude Code 专有宿主能力。

## 使用示例

- `/skill:skill-creator 把这个 Claude skill 迁移成 KodaX builtin`
- `/skill:skill-creator 新建一个 release-notes skill`
- `/skill:skill-creator 优化现有 skill 的 description 和 evals`
- `/skill:skill-creator 给这个 skill 补 trigger eval、loop 和 review 流程`
- `/skill:skill-creator 把这个 skill 打成可分享的 .skill 包`
