# KodaX 高层设计（HLD）

> Last updated: 2026-04-12
>
> 这份文档描述 `FEATURE_061/062` 之后的高层架构：
> KodaX 现在是一个 Scout-first、以 `task` 为中心、强调”极简且智能”的执行引擎。

## 中文导读

阅读这份 HLD 时，可以先抓住 6 个核心判断：

1. `SA` 与 `AMA` 是用户可见的执行模式，但不是两套完全独立的产品。
2. `SA` 完全不走 AMA；它是单 agent 直接执行路径。
3. `AMA` 只保留 `H0 / H1 / H2` 三层；`H3` 已移除。
4. `Scout` 是 AMA 的唯一入口（FEATURE_061）：H0 时直接完成，H1/H2 时升级并保留上下文。Scout 不属于 H2 主 graph。
5. `H2` 的核心骨架固定为 `Planner -> Generator <-> Evaluator`。
6. `Work` 是用户可见的主预算语义；budget 模型已简化为 `{ cap, used }` + 4 纯函数（FEATURE_062）。
7. `Project` 与 `SA / AMA` 是正交维度；`Project + SA` 是一等路径，但只写 lightweight run record，不写 managed task。
8. 每个 AMA 角色（Scout/Planner/Generator/Evaluator）可通过 `runOrchestration` 拉 subagent 并行执行。

---

## 1. 产品主张

KodaX 不应再被理解为：

- 一个要求用户先切 mode 再提问的 CLI
- 一个把多智能体默认做成“角色越多越稳”的系统
- 一个把 `Project Mode` 当作唯一长流程入口的产品

当前更准确的理解应该是：

- 一个 single-agent first 的 `task engine`
- 一个在必要时才升级到 coordinated harness 的执行系统
- 一个以 `evidence`、`contract`、`verdict` 为核心真相面的 runtime
- 一个能跨 CLI / REPL / ACP 复用的 headless substrate

对应的用户体验目标是：

- 简单问题要像单 agent 一样直接完成
- 复杂问题才逐步增加 planning / verification ceremony
- 用户默认只感知结果与必要进度，不需要先理解内部角色图

---

## 2. 设计目标与非目标

### 2.1 核心目标

1. 默认把复杂度判断隐藏在系统内部，不要求用户先选 mode。
2. 让简单任务保持直接、快速、低 ceremony。
3. 让复杂任务在升级后有清晰的 contract / evidence / verdict 结构。
4. 让 skill 能进入 AMA，但不污染所有角色。
5. 让 tool / budget / verification 的关键过程对用户可见，但不喧宾夺主。

### 2.2 非目标

1. 不再保留 `H3_MULTI_WORKER` 这种默认并行层级。
2. 不再把 `Lead / Admission / Contract Reviewer` 当作主骨架。
3. 不把 skill 做成独立于 task engine 的第二套 orchestrator。
4. 不把内部 worker iter 暴露成用户可见的主进度语义。

---

## 3. 系统概览

```text
Surfaces
  -> Intent Gate / Direct Path
    -> Scout (pre-harness only)
      -> AMA Control Plane
        -> Coding Runtime and Capability Substrate
          -> Provider / Tool / Skill Adapters
            -> Durable Task State and Evidence Store
```

### 3.1 Surfaces

用户或宿主的入口包括：

- CLI one-shot
- interactive REPL
- ACP server
- future IDE / desktop / web surfaces

这些表面只负责收集输入、显示状态、触发审批、展示结果，不拥有任务逻辑。

### 3.2 Intent Gate 与 Direct Path

每个请求都会先经过极轻的 intent gate：

- `conversation`
- `lookup`
- 明显轻量解释/导航问答

命中的请求直接走 `H0_DIRECT` 或 `SA` direct path，不读 dirty repo，不起 managed ceremony。

### 3.3 Scout（FEATURE_061 更新）

`Scout` 是 AMA 的唯一入口和 pre-harness 执行者。

它的职责是：

- 作为所有 AMA 请求的第一站（无预路由 LLM 调用）
- 判断任务是否 actionable 和是否值得进入 `H1 / H2`
- H0 时直接完成任务（Scout-complete H0）
- 升级到 H1/H2 时保留已有上下文（context continuation，不再冷启动）
- 收集 `scope facts`，最多少量补 `overview evidence`
- 如果 skill 被激活，则读取完整 expanded skill 并生成 `skill-map`
- 可通过 `runOrchestration` 拉 subagent 做并行子任务

它**不是** H2 内的长期角色。

### 3.4 AMA Control Plane

AMA 当前只保留 3 个执行层级：

| Profile | Typical task | Shape |
|---|---|---|
| `H0_DIRECT` | 对话、lookup、极轻说明 | direct |
| `H1_EXECUTE_EVAL` | 中低风险但值得独立检查的任务 | checked-direct |
| `H2_PLAN_EXECUTE_EVAL` | 需要 contract、deep evidence、独立验收的复杂任务 | coordinated |

`H3_MULTI_WORKER` 已被移除。

### 3.5 Coding Runtime and Capability Substrate

这层提供：

- prompt building
- tool execution
- skill invocation
- session handling
- checkpoint / artifact plumbing
- verification and evidence capture

它保持 headless，供多个 surface 复用。

### 3.6 Durable Task State

所有非平凡 managed task 都有持久化事实面，例如：

- `managed-task.json`
- `contract.json`
- `round-history.json`
- `budget.json`
- `runtime-contract.json`
- `scorecard.json`
- `skill-execution.md`
- `skill-map.json`
- `skill-map.md`

---

## 4. 执行形态

### 4.1 SA

`SA` = 单 agent 直接执行。

关键约束：

- 完全脱离 AMA
- 不走 Scout
- 不创建 managed worker graph
- 不暴露 AMA breadcrumb / round / budget ceremony

如果 skill 被触发，`SA` 直接消费完整 expanded skill。

### 4.2 AMA H0

`AMA-H0` 用于：

- conversation
- lookup
- 明显轻量问答
- Scout 调研后确认可直接收口的任务

它仍是 direct path，不做独立 evaluator。

### 4.3 AMA H1

`AMA-H1` 是 checked-direct：

- 一个主执行者完成任务
- 结尾允许一个轻量 `Evaluator` 做 post-hoc 检查
- evaluator 只做 accept / revise / blocked
- 最多一次同层 revise，再决定是否升级 H2

### 4.4 AMA H2

`AMA-H2` 是唯一完整 harness：

```text
Planner -> Generator <-> Evaluator
```

关键原则：

- `Planner` 负责 contract、风险、evidence checklist、slice plan
- `Generator` 负责 deep evidence 与实际执行
- `Evaluator` 负责 targeted spot-check 和最终 verdict
- `Planner` 缺 contract 时，必须先打回 `Planner`，不能让 `Generator` 静默全仓兜底

---

## 5. 角色模型

### 5.1 Scout

职责：

- 判断是否进入 harness
- 提供 pre-harness summary
- 生成 `skill-map`

输入层级：

- `scope facts`
- 少量 `overview evidence`
- 完整 raw skill（若 skill 被激活）

### 5.2 Planner

职责：

- 生成 `kodax-task-contract`
- 定义成功标准
- 列出 required evidence / constraints

输入层级：

- `scope facts`
- `overview evidence`
- `skill-map`

默认**不**读取 raw skill，也不线性翻大 diff。

### 5.3 Generator

职责：

- 执行任务
- 深挖证据
- 交付 `kodax-task-handoff`

输入层级：

- `deep evidence`
- 完整 raw skill
- `skill-map`
- planner contract

### 5.4 Evaluator

职责：

- 检查 handoff 是否满足 contract
- 做 targeted spot-check
- 输出 `kodax-task-verdict`

输入层级：

- contract
- generator handoff
- `skill-map`
- 定点 `deep evidence`

它默认不读取 raw skill；只有 `projectionConfidence=low` 或 claim 冲突时才 fallback。

### 5.5 Same-role summary continuity

`Scout`、`Planner`、`Evaluator` 继续默认使用 `reset-handoff`，但跨轮不再完全依赖隐式 artifact continuity。

当前语义：
- 每轮结束时，为非-generator 角色写入 compact same-role summary
- 下一轮同角色运行时，显式注入上一轮摘要
- 不恢复这些角色的完整私有对话历史
- `Generator` 仍是主要深度上下文消费者

---

## 6. Skill 集成

skill 不再作为“整段 prompt 平铺给所有角色”的全局上下文。

当前采用：

```text
skill invocation
  -> Scout reads full expanded skill
    -> emits skill-map
      -> Planner consumes skill-map
      -> Generator consumes full skill + skill-map
      -> Evaluator consumes skill-map (+ raw fallback only when needed)
```

`skill-map` 至少包含：

- `skillSummary`
- `executionObligations`
- `verificationObligations`
- `requiredEvidence`
- `ambiguities`
- `projectionConfidence`
- `allowedTools / hooks / model / context`

这保证了：

- `Planner` 不被完整 workflow 污染
- `Generator` 仍能按 skill 执行
- `Evaluator` 保持独立性

---

## 7. 证据分层

AMA 现在显式区分三层证据：

### 7.1 Scope facts

- changed files / lines / modules
- task family / risk / reviewScale
- repo spread and scope hints

### 7.2 Overview evidence

- `changed_diff_bundle`
- 高优先文件概览
- 关键类型 / 入口 / 测试变化摘要

### 7.3 Deep evidence

- `changed_diff`
- `read`
- 逐条 claim 验证
- 必要测试 / 检查

角色消费规则：

- `Scout`: scope facts + 少量 overview
- `Planner`: scope facts + overview
- `Generator`: deep evidence
- `Evaluator`: contract/handoff + targeted deep evidence

### 7.4 Project surface 与执行拓扑

`Project` 描述任务语境；`SA / AMA` 描述执行拓扑。

合法组合包括：
- `repl + sa`
- `repl + ama`
- `project + sa`
- `project + ama`

其中：
- `Project + AMA` = project-aware managed execution
- `Project + SA` = project-aware direct execution

`Project + SA` 不进入 managed-task graph，也不伪装成 mini-AMA；但会写一份 lightweight run record，用于：
- `/project status`
- latest execution summary
- 推荐下一步

---

## 8. 用户可见语义

### 8.1 Budget

用户默认看到的主预算语义是：

- `Work used/total`

初始预算：

- AMA 默认从 `Work x/200` 开始

当使用量达到 90% 且系统判断仍值得继续时：

- 请求用户审批
- 每次批准 `+200`
- 可多次追加

### 8.2 Round

`Round` 不再表示预分配的容量。

它只在真实额外 pass 已被分配/进入时才显示，例如：

- evaluator request revise
- H1 -> H2 upgrade 后继续
- 获批预算后继续 refinement

任务刚开始时，不应显示 `Round 1/2`。

### 8.3 Tool disclosure

工具摘要必须优先显示：

- `bash`: `cmd=<exact command>`
- `changed_diff`: path + range
- `changed_diff_bundle`: file count + representative path
- `read`: path + offset/limit
- `glob/grep`: pattern + scope/path

不应只剩裸工具名。

### 8.4 Evaluator public answer

Evaluator 的内部职责保留在 verdict / artifact 中。

用户最终答案：

- 应直接面向用户交付结果
- 不应说“我验证了 Generator 的结论”
- 不应把 Generator / Planner 当作用户面对的对象

---

## 9. Transitional Product Surface

### 9.1 `/project`

`/project` 继续存在，但它是 managed task 的 control surface：

- inspection
- resume / pause / verify
- artifact browsing

它不再是唯一的长流程产品抽象。

### 9.2 `--team`

`--team` 已退出主产品语义。

如果仍保留兼容入口，也只应视为 deprecated plumbing，而不是未来主故事。

---

## 10. 参考 Feature

- `FEATURE_019`: session tree、checkpoints、rewindable runs
- `FEATURE_022`: adaptive task engine + AMA/SA 执行骨架
- `FEATURE_025`: intent-first routing and harness selection
- `FEATURE_027`: SA / AMA 模式切换
- `FEATURE_028`: retrieval / evidence tooling
- `FEATURE_029`: provider-aware harness policy
- `FEATURE_034`: extension / capability runtime
- `FEATURE_061`: Scout-first AMA — Scout 成为唯一入口，H0 直接完成，context continuation，subagent 并行
- `FEATURE_062`: Budget simplification — `{ cap, used }` + 4 纯函数替代 10 字段 + 14 函数

---

## 11. Routing Ceiling Update

This routing update keeps KodaX lightweight by default:

- `read-only` work stays on the direct path unless the user explicitly asks for a stronger second pass.
- `docs-only` work stays on the direct path unless the user explicitly asks for a stronger second pass.
- `read-only` and `docs-only` tasks must never enter `H2_PLAN_EXECUTE_EVAL`.
- `reviewScale`, repo size, changed file count, and changed line count now affect evidence strategy only.
- `H2_PLAN_EXECUTE_EVAL` is reserved for long-running mutation work that changes code or system state and benefits from contract plus executable verification.
- H2 now defaults to one main pass; extra passes require a structured evaluator failure rather than default ceremony.
