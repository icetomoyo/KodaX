# KodaX 详细设计（DD）

> Last updated: 2026-04-12
>
> 这份 DD 描述当前 task engine 的内部模型（`FEATURE_061/062` 后）：
> Scout-first、intent-first、skill-aware、evidence-driven。

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

### 9.4 Project mode convergence into AMA H2

> **变更说明**（`FEATURE_054`）：`Project` 不再是与 `SA / AMA` 正交的独立维度。
> Project 模式的全部能力（brainstorm、plan、execute、evaluate）已融合进 AMA H2 的自适应流程。

#### 9.4.1 核心决策

1. **`/project` 命令组全部废弃**——用户无需学任何 `/project` 命令，AMA 根据请求复杂度自动选择 H0/H1/H2。
2. **Brainstorm 是 Planner 的内建能力**——不是独立 Agent 或独立阶段。Planner 在信息不充分时使用 `ask_user_question` 进行多轮对齐，然后生成 `kodax-task-contract`。
3. **持久化统一到 `managed-tasks/`**——`.agent/project/` 不再作为独立的持久化路径。所有状态（alignment、brainstorm 记录、evidence、checkpoints）统一存入 `.agent/managed-tasks/<id>/`。

#### 9.4.2 Planner 的 brainstorm 工作模式

Planner 接收 Scout 的 scope facts 后有两种自然过渡的工作模式：

- **需求清晰**：直接生成 `kodax-task-contract`
- **需求模糊**：用 `ask_user_question` 多轮对齐（brainstorm）→ 再生成 contract

这两种模式由 Planner 自行判断，不需要外部路由切换。

`inferRequiresBrainstorm()` 的输出从"prompt overlay 一句话"改为"提示 Planner 需要多轮对齐"。Planner prompt 中明确加入 brainstorm 能力描述；task-engine 层面在 `requiresBrainstorm=true` 时为 Planner 提供 `ask_user_question` 工具权限和更宽松的交互预算。

#### 9.4.3 废弃的命令与替代

| 废弃命令 | 替代方案 |
|---------|---------|
| `/project init` | 用户直接说需求，AMA 自动创建 managed task |
| `/project brainstorm` | Planner 的 brainstorm 工作模式（自动触发或用户说"先讨论"） |
| `/project plan` | AMA Planner 自动生成 contract |
| `/project next/auto` | AMA round-based execution 自动推进 |
| `/project quality/verify` | AMA Evaluator 自动检查 |
| `/project status` | 用户自然语言询问进度，AMA 从 managed task 读取回答 |

#### 9.4.4 持久化迁移

| 数据 | 原位置 | 新位置 | 处理 |
|------|--------|--------|------|
| alignment | `.agent/project/alignment.md` | `.agent/managed-tasks/<id>/alignment.md` | 迁入 |
| brainstorm 记录 | `.agent/project/brainstorm/` | `.agent/managed-tasks/<id>/brainstorm.md` | 合并迁入 |
| evidence | `.agent/project/evidence/` | `.agent/managed-tasks/<id>/evidence/` | 迁入 |
| checkpoints | `.agent/project/checkpoints/` | `.agent/managed-tasks/<id>/checkpoints/` | 迁入 |
| session plan | `.agent/project/session_plan.md` | 被 `contract.json` 替代 | 废弃 |
| control-state / project-state | `.agent/project/` | 被 managed task lifecycle 替代 | 废弃 |
| harness config / runs | `.agent/project/harness/` | 被 AMA 自适应替代 | 废弃 |
| lightweight run record | `.agent/project/lightweight-run.json` | 不再需要 | 废弃 |

已存在的 `.agent/project/` 目录由用户自行处理，系统不做自动迁移。

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
- `FEATURE_061`: Scout-first AMA — Scout 唯一入口，H0 直接完成，context continuation，subagent 并行
- `FEATURE_062`: Budget simplification — `{ cap, used }` + 4 纯函数

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

---

## 14. Construction Runtime (v0.7.28)

> 本章描述 v0.7.28 引入的自构建底座（FEATURE_087/088）。  
> 详细 feature 设计：[`features/v0.7.28.md`](features/v0.7.28.md)。  
> DD 这一节固化**跨模块契约**与**生效语义**——实施时以 DD 为准。

### 14.1 双世界模型

KodaX 运行时区分两个 capability 世界：

| 世界 | 定义 | 写入路径 | 生命周期 |
|------|------|---------|---------|
| **Builtin World** | 仓库源码编译产物 | （无；编译时入内存） | 进程级，只读 |
| **Constructed World** | 运行时由 Agent 生成 | `.kodax/constructed/` | 跨进程持久；可 stage / test / activate / revoke |

**无独立索引文件**：每个 `.kodax/constructed/<kind>/<name>/<version>.json` 是 artifact 自身的单一数据源，携带 `name / version / kind / createdAt / testedAt / activatedAt / revokedAt / status`。**进程启动时**用 `glob('.kodax/constructed/**/*.json')` 扫盘 + 过滤 `status === 'active'`，加载到各自 registry。

**为什么不要 `_manifest.json` 索引**：索引信息 100% 可从 artifact 文件推导（status 写在 artifact 自身），引入索引只会带来双写一致性负担。`glob + readJSON` 在百级 artifact 规模下毫秒级，性能损失不可察觉。

### 14.2 ConstructionArtifact lifecycle

四段生命周期由 `ConstructionRuntime` 串联：

```text
scaffold → static_check → stage → test → policy_gate → activate → (used by LLM) → revoke
                                              │
                                              └─ 失败 → 回退 stage，等修正
```

**职责切分**：

| 阶段 | 谁触发 | 失败行为 |
|------|--------|---------|
| `scaffold` | Coding Agent 内部 tool | Agent 重写 |
| `static_check`（Guardrail AST）| `validate_tool` internal tool | `TestResult.errors`，阻止 stage |
| `stage` | `ConstructionRuntime.stage()` | 写 `.kodax/constructed/<kind>/<name>/<version>.json` 但不入 registry |
| `test` | `ConstructionRuntime.test()` | `TestResult.errors`，artifact 标 `testedAt=null` |
| `policy_gate` | `ConstructionPolicy(artifact)` 函数 | `'reject'` → 中止；`'ask-user'` → 阻塞等用户 |
| `activate` | `ConstructionRuntime.activate()` | 失败抛 `ActivationError`，artifact 留 staged 状态 |
| `revoke` | `ConstructionRuntime.revoke()` | 不会失败；幂等 |

### 14.3 Registry 合并语义

**复用现有 `TOOL_REGISTRY` 栈语义**（`packages/coding/src/tools/registry.ts:42-98`），不引入并行 registry：

```text
TOOL_REGISTRY[name] = [
  { source: 'builtin', ... },          ← 编译时入栈
  { source: 'constructed', v1.0.0, ... },  ← activate 时 push
  { source: 'constructed', v1.1.0, ... },  ← 新版本 push（末位赢）
]
```

**查询规则**：`getActiveToolRegistration(name)` 返回 stack 末位 → constructed 自然覆盖同名 builtin，新版本覆盖旧版本。

**View-layer 函数**（不引入 Resolver 类——按 KodaX 哲学，无状态查询用函数）：

```ts
listConstructed(kind?): RegisteredCapability[]
findByVersion(name, version): RegisteredCapability | undefined
listAll(kind?): RegisteredCapability[]
```

不重新实现查找逻辑，仅做 enumerate / filter。

**约束**：constructed agent / skill 同样走该 stack 模式（Agent 用 `AGENT_REGISTRY`，Skill 用 skill-loader 现有路径）。

### 14.4 Handler 加载（loadHandler 纯函数）

**v0.7.28 实现**：主进程动态 `import`，**不做代码级 sandbox**，单个纯函数完成。

```ts
async function loadHandler(source, capabilities): Promise<ToolHandler>
```

```text
manifest.handler.code (string, language='javascript')
  │
  ▼ writeModule(): 直接写盘（无编译步骤）
  │
  ▼ .kodax/constructed/tools/<name>/<version>.js
  │
  ▼ await import(modulePath)
  │
  ▼ wrap with createCtxProxy(ctx, capabilities)
  │
  ▼ register into TOOL_REGISTRY
```

**Language 限定 'javascript'**：本版不支持 TS handler——LLM 直接生成 JS 零成本，避免引入 esbuild/tsx 编译链路、source map、类型纠结等隐藏依赖。手写 TS 是 0% 当前场景，等真有需求再加。

**ESM 限制**：Node 的 module cache 不支持 `unload`。revoke 只移 registry 条目，已 import 的 module 留在内存；artifact JSON 文件的 `status` 改为 `'revoked'` + 写 `revokedAt`，下次进程启动时被 glob 过滤跳过，已写入磁盘的 `.js` 源文件保留供审计。

**为什么不用接口**：当前只有一种 loader 实现，按 KodaX 哲学"NEVER create abstractions until you have 3+ concrete use cases"——直接函数。未来真要做 worker / Isolate 隔离时，再开新 feature 文档讨论接口形状。

### 14.5 安全模型：四层防御

KodaX **拒绝代码级 JS sandbox**（行业先例：Claude Code / pi-mono / opencode 均不做插件代码隔离）。改为四层组合：

```text
LLM 生成代码 → ① Guardrail 静态检查
              → ② manifest.capabilities 显式声明
              → ③ stage/activate
              → 运行时 → ④ CtxProxy 拦截每次 ctx.* 调用
              → ⑤ Policy Gate 在 activate 前人工审批
```

#### 14.5.1 Guardrail：3 条硬规则 + LLM 静态审查

KodaX 哲学"leverage LLM intelligence"——不为对抗手写大量 AST 规则。本版采用两层组合。

**第一层：3 条硬规则（AST，零成本）**：

| 规则 ID | 禁止模式 | 原因 |
|---------|---------|------|
| `no-eval` | `eval(...)` 调用 | 任何 eval 都是对静态检查的根本规避 |
| `no-Function-constructor` | `new Function(...)` | 等价于 eval |
| `require-handler-signature` | 必须导出 `async function handler(input, ctx)` | 统一 dispatch 入口；让"间接 require"等模式无落脚点 |

通过 → 进入第二层。

**第二层：LLM 静态审查**（`ConstructionRuntime.test()` 内一次独立 LLM 调用）：

Prompt 关注模式（含变形）：
- 任何形式的 `require` / 动态 `import` / Function 构造
- 字符串拼接绕引用（`['req','uire'].join('')`）
- `process.*` / `globalThis.*` / `Buffer` / `__dirname` / `__filename`
- 全局 `fetch` / `XMLHttpRequest` / `WebSocket`
- 顶层副作用（顶层 `await`、模块加载时全局赋值）
- `capabilities.tools` 之外的 `ctx` 访问

输出 JSON：

```ts
{
  verdict: 'safe' | 'suspicious' | 'dangerous',
  concerns: string[],
  suggested_capabilities: string[]   // LLM 建议的实际所需 tools
}
```

**Verdict 处置**：

| Verdict | 行为 |
|---------|------|
| `safe` | 通过，进入 stage |
| `suspicious` | 进入 policy gate（默认 ask-user，concerns 一并展示给用户） |
| `dangerous` | 直接 reject，不进 policy gate |

**为什么这样组合**：
- 硬规则毫秒级、零 API 成本、最确定的攻击模式（eval / Function / 签名错误）
- LLM 审查覆盖 AST 难以完美写规则的语义级模式（混淆、间接引用）
- 失败成本低：suspicious 仅多一次 ask-user，不漏放过攻击
- handler 本就是 LLM 写的，让另一次 LLM 审查同类代码非常自然

#### 14.5.2 Capabilities schema

**v0.7.28 单维**：

```ts
interface Capabilities {
  tools: string[]   // ctx.tools.<name> 白名单
}
```

所有 I/O（fs / net / env）一律通过对应 builtin tool（`read` / `write` / `bash` / 等）走 CtxProxy `ctx.tools.<name>` 入口；handler 不获得独立的 `ctx.fs` / `ctx.net` / `ctx.env` 入口。

**演进路径（v0.7.28 不实装）**：当出现"必须把同一 builtin 限制到具体路径/域名"的场景时，schema 升级为：

```ts
type ToolCapability = string | { name: string; constraints: Record<string, unknown> }
interface Capabilities { tools: ToolCapability[] }
```

升级时 `string[]` 是新 schema 的子集（向前兼容）。

#### 14.5.3 CtxProxy 运行时契约

- `ctx.tools.<name>(...)` — 调用前查 `capabilities.tools`；命中后走 `executeTool()` 标准路径（complete the chain，复用 builtin 的所有安全策略，如 bash 走 OS sandbox 若启用）
- 未声明的 tool → throw `CapabilityDeniedError`，记入 tracer span（`source.kind='constructed'` 标签）
- v0.7.28 单一入口：CtxProxy 只拦截 `ctx.tools.*`，无 `ctx.fs` / `ctx.net` / `ctx.env`
- 派发时 CtxProxy 把**原始 host ctx**（不是 frozen 后的 proxy）传给 `executeTool`，这样 builtin（如 `read` 写 `ctx.backups`）正常运转
- **已知 gap（v0.7.28 不修复）**：constructed handler 通过 `ctx.tools.<builtin>` 调用时，agent 高层 plan-mode / permission-gate 检查（位于 `agent.ts` 的 `getToolExecutionOverride`）**不会触发**——只有 builtin 自身的安全策略（bash sandbox、write path policy）生效。如果需要把高层 gate 也接入，需要 v0.7.29+ 把 ctx 上的 gate predicate 透传到 `executeTool` 内部，或把 plan-mode 检查下沉到 `executeTool`
- **已知 gap（v0.7.28 不修复）**：constructed→constructed 循环依赖（A 声明 B、B 声明 A、互相调用）只靠 **outermost** 30s timeout 拦截。outermost reject 后 caller 拿到错误，但 inner Promise tree 仍在 microtask queue 跑直到自然终结——会持续分配 proxy / timer / promise，进程 RSS 缓慢上涨。v0.7.28 威胁模型是 LLM 幻觉而非对抗性 DoS，可以接受；v0.7.29+ 应加调用深度上限（如 ctx 上的 `_constructionDepth` 计数，>5 时直接拒绝）

CtxProxy 用 `Object.freeze` + 每次返回新对象，避免原型污染绕过。

#### 14.5.4 Policy Gate

Policy 是 `activate()` 的决策点，签名为函数类型——**不引入 interface / class**：

```ts
type ConstructionPolicy = (
  artifact: ConstructionArtifact,
) => Promise<'approve' | 'reject' | 'ask-user'>

const defaultPolicy: ConstructionPolicy = async () => 'ask-user'
```

用户在 `kodax.config.ts` 里 export `constructionPolicy` 即可覆盖。可配规则示例：

- `signedBy === 'self'` && `Date.now() - testedAt < 24h` → `'approve'`
- `kind === 'tool'` && `capabilities.tools` 全在低风险白名单（如 `['read', 'grep']`）→ `'approve'`
- 企业 / CI 环境一律 `'reject'`
- 默认 `'ask-user'`

**为什么用 type alias 而非 interface**：v0.7.28 哲学审视的折中——保留扩展点（用户能写自己的 policy 函数）、提供类型安全（`const p: ConstructionPolicy = ...` 编辑器补全），但不引入 OOP 抽象。Policy 函数本身极简，闭包足够承载状态需求。

**已知 gap：Rehydrate 路径绕过 Policy Gate（v0.7.28 不修复）**

`rehydrateActiveArtifacts()` 启动扫盘时，对每个 `status='active'` 的工件**直接** `registerActiveArtifact`，**不调** `_options.policy`。设计原意是"这台机之前已批准过，重启不该重复问"——对单用户造工具自用场景成立。

但是这制造了一个 supply-chain attack vector：如果 `.kodax/constructed/tools/` 进入版本控制（不 .gitignore），恶意 collaborator 可以 commit 一个 `status='active'` 的 .json + 恶意 handler；本机用户 merge + 重启后 KodaX **无任何提示**就 register 该工具，下次 LLM 触发即执行。

**v0.7.28 立场**：
- 威胁模型仅覆盖"LLM 幻觉生成越权代码"——靠 4 层防御（AST + capabilities + CtxProxy + policy）
- **不**覆盖"恶意 git 协作者"——超出本版 scope
- 缓解：**强烈建议** `.kodax/constructed/` 进 `.gitignore`（单用户场景的预期使用模式）

**v0.7.29+ 的修法（建议方向，未实装）**：
- 工件首次 activate 时记录 `signedBy` / fingerprint 到本机的 `~/.kodax/trusted-fingerprints.json`
- rehydrate 时校验：fingerprint 在表里 → 直接 register；不在表里 → 强制走 policy 重新批准
- `signedBy` 至少包含 (machine-id, user-id, timestamp) 三元组，让 attacker 无法伪造一个"看起来像本机已批准过"的工件

### 14.6 LLM 集成生效语义

#### 14.6.1 Tool → LLM 链路（builtin + constructed 共用）

| 环节 | 实现 |
|------|------|
| Registry | `TOOL_REGISTRY` 末位赢栈 |
| Turn 边界快照 | `getActiveToolDefinitions()` 在每个 turn 开始时取一次 |
| Provider 透传 | `tools as Anthropic.Messages.Tool[]` 直接进 `tools` 字段；**无 prompt 级 tool 注入** |
| Dispatch | `executeTool(name, input, ctx)` |
| Tool input 解析 | `packages/ai/src/providers/tool-input-parser.ts` 共享模块 `parseToolInputWithSalvage()` —— **Native API 10 个 provider 全用**（AnthropicCompat 5 + OpenAICompat 5）；CLI bridge `gemini-cli` / `codex-cli` 不在范围（无 tool 调用机制） |

**partial-json salvage 覆盖范围**：仅 10 个 Native API provider。当 LLM 调 constructed tool 触顶 max_tokens 截断 mid-string，`parseToolInputWithSalvage` 三阶段恢复（strict `JSON.parse` → `partial-json` 抢救 → `{}` 兜底），handler 仍能拿到可读 partial input。Constructed tool 与 builtin 共享同一 dispatch 路径，**无须特殊适配自动受益**。

**KodaX 12 个 provider 总览**：
- Native API · AnthropicCompat (5)：`anthropic` / `zhipu-coding` / `kimi-code` / `minimax-coding` / `mimo-coding`
- Native API · OpenAICompat (5)：`openai` / `deepseek` / `kimi` / `qwen` / `zhipu`
- CLI bridge (2)：`gemini-cli` / `codex-cli` —— 不支持 tool 调用，**constructed tool 概念在此不适用**

#### 14.6.2 生效契约（**核心**）

> **activate 在 turn N 完成 → turn N+1 开始时 LLM 可见。同 turn 内不可见。**

理由：`getActiveToolDefinitions()` 在 turn 边界刷新；同 turn 内动态注入会导致 `tools` 列表与 LLM 已建上下文不一致，引发幻觉调用。

**Agent 设计约束**：scaffold→activate→使用是**至少跨两个 turn** 的工作流，Agent prompt 必须明示这一点，避免"刚造完就用"的错误期望。

#### 14.6.3 Revoke 生效契约

> **revoke 不中断正在执行的 turn**；下个 turn 该 tool 不再出现在 `tools` 字段。

已发起的 tool call 继续完成；正在执行的 handler 不被强制终止（依赖正常返回或 30s `AbortController` timeout）。

#### 14.6.4 Provider schema 兼容

`ConstructionRuntime.test()` 内置 `validateToolSchemaForProvider(inputSchema, provider)`：

- v0.7.28 必达：Anthropic（默认 provider）规则集
- 不兼容 → `TestResult.errors`，阻 activate
- 其他 provider 规则增量补，未覆盖时给 warning 不 block（由 policy 决定）

### 14.7 Tracing & 审计

所有 constructed 相关 span 加 `source.kind='constructed'` 标签：

- `construction.stage` / `construction.test` / `construction.activate` / `construction.revoke`
- 每次 constructed tool 的 `executeTool` 调用 → span 含 `tool.name` / `tool.version` / `tool.source='constructed'`
- CtxProxy 拒绝事件 → span event `capability.denied` 含 `requested.kind` / `requested.target`

所有 artifact JSON 文件永久保留（即使 revoke），用于事后审计——**不做物理删除**。`status === 'revoked'` 的 artifact 仅在加载时被过滤，磁盘上仍可读。

### 14.8 Non-Goals（v0.7.28 范围外）

- 进程级 / V8 Isolate 级隔离（升级路径开放但不实现）
- 跨进程签名验证（本地签名够用）
- 自动发布 constructed artifact 到外部 registry
- Constructed Agent 生成（FEATURE_089 v0.7.31）
- 自改 role spec（FEATURE_090 v0.7.32）
- 防御对抗性恶意 handler（威胁模型限定为"LLM 幻觉越权"）
