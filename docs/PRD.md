# KodaX 产品需求文档（PRD）

> Last updated: 2026-04-12
>
> 本 PRD 描述当前 `FEATURE_061/062` 之后的产品语义：
> KodaX 是一个 Scout-first、极简且智能的 task engine。

## 中文导读

当前产品承诺可以概括为：

1. 用户直接提出请求，不需要先选 mode。
2. 简单任务应像单 agent 一样快速完成。
3. 复杂任务才应逐步增加 planning / verification ceremony。
4. skill 可以参与复杂任务，但不会把所有角色都污染成同一份 workflow。
5. 用户主要感知 `Work`、工具目标、最终结果，而不是内部控制面的噪音。

---

## 1. 产品定位

KodaX 面向这样一类用户：

- 希望 terminal 体验足够直接
- 希望复杂代码任务又足够可靠
- 希望系统能自动判断什么时候该“想得更深”
- 希望结果有 evidence 和 verification 支撑

外在体验要尽量简单，内部执行模型可以很强，但不应把复杂度直接暴露给用户。

---

## 2. 用户承诺

当用户要求 KodaX 完成一项工作时，KodaX 应该：

1. 自动判断任务是否简单
2. 简单任务直接完成
3. 复杂任务逐步升级到更强执行形态
4. 不盲信执行者的自我汇报
5. 在需要时给出清楚的 contract、evidence 和 final answer

一句话总结：

- 外面尽量简单
- 中间足够智能
- 最终结果足够可靠

---

## 3. 产品原则

### 3.1 Single-Agent First

默认先按单 agent 体验设计产品。

### 3.2 Harness On Demand

只有证据表明任务复杂度更高时，才升级到 AMA。

### 3.3 Evidence Before Confidence

完成判定依赖 evidence 和 verdict，而不是“模型说 done 了”。

### 3.4 Role Separation Without Role Bloat

复杂任务需要角色分工，但不应堆出过重图。

### 3.5 Skill as Progressive Disclosure

skill 是 invocation/playbook，不是新的产品 mode。

### 3.6 Work-First UX

预算与进度对用户的主要呈现应是：

- `Work used/total`
- 明确的工具目标
- 直接面向用户的结果

---

## 4. 当前执行形态

### 4.1 SA

`SA` 完全脱离 AMA，单 agent 直接到底。

适用场景：

- 用户明确要求单 agent 成本控制
- 不需要 AMA ceremony 的任务

### 4.2 AMA-H0

direct path。`H0` 的核心是”最终单 agent 收口”。

`Scout` 是 AMA 的唯一入口。所有 AMA 请求先经过 Scout。

适合：

- conversation
- lookup
- 明显轻量说明
- 默认的 `read-only / docs-only` 工作
- 经 `Scout` 少量调研后仍可直接收口的任务（`Scout-complete H0`）

约束：

- Scout 判定 `H0_DIRECT` 且证据足够时，由 Scout 直接完成任务，不 handoff
- Scout 升级到 H1/H2 时保留已有上下文（context continuation），不再冷启动

### 4.3 AMA-H1

lightweight checked-direct。

适合：

- 用户明确要求 `double-check / second pass / 更强审查` 的 `read-only / docs-only` 任务
- 中低风险但值得一次轻量独立检查的 mutation 任务

约束：

- 固定为 `Generator + 轻量 Evaluator`
- 无 `Planner`
- 无 contract negotiation
- 无默认多轮 refine
- `read-only / docs-only` 的 `H1` 最多只允许一次短 revise；失败后返回 `best-effort + limits`，不升级到 `H2`

### 4.4 AMA-H2

coordinated harness。

固定骨架：

```text
Planner -> Generator <-> Evaluator
```

适合：

- 真正长时的 `code / system` mutation work
- 需要明确 deliverable / done criteria / 可执行 QA 的任务

不适合：

- `large review` 本身
- 文档写作 / 改写
- 需求分析 / 测试总结等只读任务

约束：

- 默认单主 pass
- 只有结构化 failure 才开启额外 pass

---

## 5. 用户旅程

### 5.1 Quick answer / lookup

用户感受应该是：

- 提问
- 很快得到答案
- 不需要理解内部角色

### 5.2 Focused code task

用户感受应该是：

- 系统知道何时需要额外校验
- 结果说明清楚改了什么、查了什么、证据是什么

### 5.3 Complex review or architecture task

用户感受应该是：

- 系统先判断复杂度
- 再进入更强的 contract / evidence / evaluation 流程
- 复杂度增加时是合理的，不是无端 ceremony

### 5.4 Skill-assisted task

用户感受应该是：

- skill 改变了系统对任务的理解与执行方式
- 但不会让整个系统变得僵硬、脚本化、机械

---

## 6. Skill 产品语义

当前 skill 的产品语义是：

- 用户 prompt 的渐进式提示词/工作手册
- 可在 direct path 中完整生效
- 进入 AMA 时，通过 `Scout -> skill-map` 做角色投影

用户无需知道 `skill-map` 这个内部名词，但应该感受到：

- Planner 更懂目标与约束
- Generator 更懂怎么执行
- Evaluator 更懂怎么验证

---

## 7. 可见性与信任

### 7.1 工具披露

用户应该能看出系统到底在做什么：

- `bash` 运行了什么命令
- diff/read/search 到底看了哪个文件或范围

### 7.2 Budget 披露

默认让用户看到：

- `Work x/200`

只有真实进入额外 pass，才看到 `Round`。

### 7.3 Evaluator 输出

最终用户答案必须直接面向用户，不应是“review 的 review”。

---

## 8. 核心能力清单

系统必须支持：

- intent gate
- scout pre-harness gating
- `H0 / H1 / H2`
- contract / handoff / verdict 协议
- skill-aware managed execution
- durable artifacts
- provider-aware policy
- explicit tool disclosure

---

## 9. Transitional UX Policy

### 9.1 `/project`

作为 managed task control surface 保留。

### 9.2 `--agent-mode`

`SA / AMA` 是正式、可见、可切换的产品控制面。

### 9.3 `--team`

不再作为主产品故事的一部分。

---

## 10. Success Criteria

### 10.1 用户体验

- 简单问题不被多角色 ceremony 拖慢
- 复杂问题的 planning / verification 让用户感到“更可靠”，而不是“更乱”

### 10.2 可解释性

- 用户能看懂主要预算语义
- 用户能看懂系统在操作什么对象

### 10.3 结果可信度

- 复杂任务有 contract / evidence / verdict
- 最终答案不泄露内部元评估口吻

---

## 11. 相关 Feature

- `FEATURE_019` — Session tree, checkpoints
- `FEATURE_022` — Adaptive task engine + AMA/SA
- `FEATURE_025` — Intent-first routing
- `FEATURE_027` — SA/AMA mode toggle
- `FEATURE_028` — Retrieval/evidence tooling
- `FEATURE_029` — Provider capability policy
- `FEATURE_034` — Extension runtime
- `FEATURE_061` — Scout-first AMA: Scout 成为唯一入口，H0 直接完成，角色升级保留上下文，每角色可拉 subagent
- `FEATURE_062` — Budget simplification: 2 fields + 4 functions 替代 10 fields + 14 functions
