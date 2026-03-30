# KodaX 详细设计（DD）

> Last updated: 2026-03-29
>
> 这份 DD 描述当前 task engine 的内部模型：
> single-agent first、intent-first、skill-aware、evidence-driven。

## 中文导读

如果你只想快速理解当前实现，请优先看：

1. `Core Domain Model`
2. `Routing Pipeline`
3. `Control Plane Flows`
4. `Skill Map and Role Projections`
5. `Runtime / UI Semantics`

---

## 1. 范围说明

这份文档覆盖：

- task-first intake
- intent gate / scout / harness selection
- `H0 / H1 / H2` 三层执行语义
- `skill-map` 与 role-aware skill projection
- evidence-driven completion
- user-visible work / round / tool disclosure 规则

这份文档不展开：

- 每个 surface 的完整 UI 视觉细节
- 每条内建命令的逐条行为说明
- 未来并行执行或 `H3` 的潜在设计

---

## 2. 核心领域模型

### 2.1 Task shape

```ts
type TaskFamily =
  | "conversation"
  | "lookup"
  | "review"
  | "implementation"
  | "investigation"
  | "planning"
  | "ambiguous";

type TaskActionability = "non_actionable" | "actionable" | "ambiguous";

type ExecutionPattern = "direct" | "checked-direct" | "coordinated";

interface IntentGateDecision {
  taskFamily: TaskFamily;
  actionability: TaskActionability;
  executionPattern: ExecutionPattern;
  shouldUseRepoSignals: boolean;
  shouldUseModelRouter: boolean;
}
```

### 2.2 Harness profile

```ts
type HarnessProfile =
  | "H0_DIRECT"
  | "H1_EXECUTE_EVAL"
  | "H2_PLAN_EXECUTE_EVAL";
```

说明：

- `SA` 不是 harness profile，而是 agent mode
- `H3_MULTI_WORKER` 已删除

### 2.3 Role model

```ts
type AgentRole =
  | "direct"
  | "scout"
  | "planner"
  | "generator"
  | "evaluator";
```

关键约束：

- `Scout` 只存在于 pre-harness 阶段
- `Planner / Generator / Evaluator` 构成 H2 主 graph

### 2.4 Skill invocation and map

```ts
interface SkillInvocationContext {
  name: string;
  path: string;
  description?: string;
  arguments?: string;
  allowedTools?: string;
  context?: string;
  agent?: string;
  model?: string;
  hookEvents?: string[];
  expandedContent: string;
}

type SkillProjectionConfidence = "high" | "medium" | "low";

interface SkillMap {
  skillSummary: string;
  executionObligations: string[];
  verificationObligations: string[];
  requiredEvidence: string[];
  ambiguities: string[];
  projectionConfidence: SkillProjectionConfidence;
  rawSkillFallbackAllowed: boolean;
  allowedTools?: string;
  preferredAgent?: string;
  preferredModel?: string;
  invocationContext?: string;
  hookEvents?: string[];
}
```

### 2.5 Contract / handoff / verdict

```ts
interface TaskContract {
  summary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
}

interface TaskHandoff {
  status: "ready" | "incomplete" | "blocked";
  summary?: string;
  evidence: string[];
  followup: string[];
}

interface TaskVerdict {
  status: "accept" | "revise" | "blocked";
  reason?: string;
  nextHarness?: "H1_EXECUTE_EVAL" | "H2_PLAN_EXECUTE_EVAL";
  followup: string[];
}
```

---

## 3. Storage Layout

```text
.agent/
  managed-tasks/
    <task-id>/
      managed-task.json
      contract.json
      round-history.json
      budget.json
      runtime-contract.json
      runtime-execution.md
      scorecard.json
      skill-execution.md
      skill-map.json
      skill-map.md
      rounds/
        round-01/
          run.json
          summary.json
          feedback.json
          feedback.md
```

说明：

- raw skill 与 skill-map 都是 artifact-first 的持久化工件
- downstream roles 优先消费 artifact，而不是依赖长 prompt 摘要

---

## 4. Routing Pipeline

### 4.1 Intent gate

入口首先做极轻判断：

- greeting / conversation
- lookup / code navigation
- 明显 actionable family
- ambiguous

约束：

- 非 actionable 输入不得因 dirty repo 升级到 H1/H2
- `lookup` 默认 direct，不吃 repo scaling

### 4.2 Scout stage

未被 direct short-circuit 的请求进入 `Scout`。

Scout 的职责：

- 确认任务是否值得进入 H1/H2
- 收集 `scope facts`
- 最多少量补 `overview evidence`
- 若存在 skill，则读取完整 skill 并生成 `skill-map`

Scout 输出 `kodax-task-scout`，其中至少包含：

- summary
- confirmed_harness
- required_evidence
- optional `skill-map` fields

### 4.3 Harness selection

当前默认映射：

- `conversation` / `lookup` -> `H0_DIRECT`
- 低风险 actionable -> `H1_EXECUTE_EVAL`
- 需要 contract / deep evidence / stronger verification -> `H2_PLAN_EXECUTE_EVAL`

---

## 5. Control Plane Flows

### 5.1 SA

```text
user request -> direct runner
```

特点：

- 不进入 AMA
- 不创建 managed task graph
- skill 直接以完整 expanded form 生效

### 5.2 AMA H0

```text
intent gate -> direct runner
```

或：

```text
intent gate -> Scout -> H0 direct runner
```

Scout downshift 到 H0 时，系统必须重新回到 direct path 收口，而不是把 Scout 口吻直接回给用户。

### 5.3 AMA H1

Current implementation note:
- `H0` downshifts no longer hand off to a second direct agent; Scout can complete `H0_DIRECT` itself when it already has enough evidence.
- `H1` stays lightweight: Generator + light Evaluator only, no Planner, no contract negotiation, no default multi-round refinement.
- `read-only` and `docs-only` work may use `H1` only after an explicit stronger-check request and must never upgrade from `H1` to `H2`.
- Scout must stop after producing a medium-rich cheap-facts handoff for H1; it must not keep exploring to build a mini-plan.

```text
Scout -> Generator -> Evaluator
```

约束：

- 仍然只有一个主执行者
- evaluator 只做 post-hoc accept / revise / blocked
- 最多一次同层 revise，再决定是否升 H2

### 5.4 AMA H2

```text
Scout -> Planner -> Generator <-> Evaluator
```

约束：

- `Planner` 必须先交 `kodax-task-contract`
- 缺 contract 时先重试 `Planner`
- `Generator` 只有在存在可消费 contract 时才执行
- `Evaluator` 只做 targeted spot-check 与 verdict

---

## 6. Evidence Layering

### 6.1 Three-layer model

```text
scope facts
  -> overview evidence
    -> deep evidence
```

`scope facts` 例如：

- changed files / lines / modules
- reviewScale / risk / task family

`overview evidence` 例如：

- `changed_diff_bundle`
- repo_overview
- 关键入口 / 类型 / 测试变化摘要

`deep evidence` 例如：

- `changed_diff`
- `read`
- file-by-file verification
- tests / runtime checks

### 6.2 Role consumption rules

- `Scout`: scope facts + 少量 overview
- `Planner`: scope facts + overview + skill-map
- `Generator`: deep evidence + full skill
- `Evaluator`: contract/handoff + targeted deep evidence + skill-map

---

## 7. Skill Map and Role Projections

当前 skill 不是为多角色原生设计的，因此 AMA 通过 `Scout -> skill-map` 做适配。

### 7.1 Projection rules

- `Scout`
  - reads full skill
  - emits `skill-map`
- `Planner`
  - reads `skill-map`
  - does not default to raw skill
- `Generator`
  - reads full skill + `skill-map`
- `Evaluator`
  - reads `skill-map`
  - may reopen raw skill only when `projectionConfidence=low` or claims conflict

### 7.2 Fallback behavior

如果 skill 不规范：

- `skill-map` 允许低置信度
- `ambiguities` 必须显式记录缺失项
- `Planner` 将缺口写进 `required_evidence / constraints`
- `Evaluator` 获得 raw skill fallback 权限

---

## 7.5 Same-role round summaries

为了保持非-generator 角色的低成本连续性，runtime 会为：
- `Scout`
- `Planner`
- `Evaluator`

写入结构化 `same-role summary`。

该摘要至少覆盖：
- 上一轮该角色的目标
- 已确认结论
- 未决问题
- 下一轮需要延续的判断

运行规则：
- 这些角色继续使用 `reset-handoff`
- 下一轮通过显式输入重新注入 summary
- 不恢复完整私有会话历史
- `Generator` 不使用这套机制

---

## 8. Tool Policy and Enforcement

当前实现通过 role-level `toolPolicy` + `beforeToolExecute` 做硬约束。

示意规则：

- `Scout`
  - allow: `changed_scope`, `repo_overview`, `changed_diff_bundle`, small reads
  - block: deep diff paging, mutation
- `Planner`
  - allow: overview evidence only
  - block: linear `changed_diff` paging, mutation
- `Generator`
  - owns deep evidence / execution
- `Evaluator`
  - allow: verification tools and targeted reads
  - block: mutation

---

## 9. Budget and Runtime Semantics

### 9.1 Global work budget

AMA 默认使用统一的 `globalWorkBudget`：

- 初始 `200`
- 使用量达到 90% 时可申请 `+200`
- 可多次申请

### 9.2 Role guidance vs user-visible budget

系统内部仍可保留 role guidance：

- `softMaxIter`
- `hardMaxIter`
- plannedRounds / refinementCap

但这些只用于 runtime 调优，不应直接作为用户主进度语义。

### 9.3 User-visible rules

- 默认显示 `Work used/total`
- `Round` 只在真实额外 pass 存在时显示
- AMA 不应回退显示 `Iter x/y`

### 9.4 Project + SA persistence

`Project` 与 `SA / AMA` 是正交维度。

当执行 `Project + SA` 时：
- 不创建 `managed-task.json`
- 不创建 planner/generator/evaluator graph
- direct run 结束后写入 `lightweight run record`

该记录至少包含：
- `status`
- `summary`
- `sessionId`
- `taskSurface`
- `agentMode`
- `executionMode`
- `featureIndex / requestId / project metadata`
- `changedFiles`
- `checks`
- `evidence`
- `blockers`
- `nextStep`
- timestamps

读取优先级：
- 若存在 managed task，project surfaces 继续优先读取 managed task
- 若不存在 managed task，但存在 lightweight run record，则使用该记录补足 status / latest summary / next-step guidance

---

## 10. UI / Transcript Semantics

### 10.1 Tool disclosure

`ToolCall.input` 是主要披露来源，preview 只做补充。

显示优先级：

- `bash`: exact command
- diff/read/search tools: path / scope / range / pattern

### 10.2 Evaluator public answer

Evaluator 的内部职责保留在：

- verdict block
- artifact / transcript

用户最终答案必须：

- 直接面向用户
- 不以“我验证了 Generator 的结论”开头
- 不把 Generator / Planner 当成用户面对对象
- 不保留 `Confirmed:`、`I now have sufficient evidence ...`、`Let me verify ...` 之类的内部核查前导段落

### 10.3 Transcript retention

non-terminal worker transcript 仍然保留，以支持可观测性与调试。

但 public answer contract 必须与内部 verdict 语义分离。

---

## 11. Command / Skill Runtime Integration

命令与 skill 继续走统一 invocation runtime。

当前约束：

- builtin / discovered command 共享 `CommandDefinition` 元数据模型
- skill invocation metadata 会被挂入 `options.context`
- skill 的 AMA 适配发生在 managed-task runtime，而不是 command schema

---

## 12. 与相关 Feature 的边界

- `FEATURE_019`: durable state / lineage / checkpoints
- `FEATURE_022`: AMA/SA 主骨架
- `FEATURE_025`: intent-first routing
- `FEATURE_027`: agent mode UX
- `FEATURE_028`: retrieval / evidence tooling
- `FEATURE_029`: provider policy
- `FEATURE_034`: capability runtime

---

## 13. Routing Ceiling Rules

The current execution ceiling is intentionally strict:

- `mutationSurface = read-only` defaults to `SA/H0`.
- `mutationSurface = docs-only` defaults to `SA/H0`.
- Only an explicit user request for stronger checking may move `read-only` or `docs-only` work to `H1_EXECUTE_EVAL`.
- `read-only` and `docs-only` tasks must never escalate to `H2_PLAN_EXECUTE_EVAL`.
- `reviewScale`, repo size, and changed-scope signals are evidence-planning inputs only; they do not determine topology.
- `H2_PLAN_EXECUTE_EVAL` is reserved for long-running code/system mutation work with real verification value.
- H2 starts with a single main pass. Additional passes require a structured evaluator failure.
