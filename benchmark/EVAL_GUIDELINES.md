# KodaX Eval Guidelines

> **目的**：本文档规定 KodaX 内部 LLM eval 的方法论，强制约束实验成本与可解读性。

> **背景**：FEATURE_107 (v0.7.32) 累计跑了 200+ cells、横跨 5 轮 prompt 迭代 (v1/v2/v3) + boundary suite + long-context suite + Experiment B，实际产出 3 条产品改动 + 1 条架构决定。**真正能下决策的产出占成本的 5% 以下**。本文档总结这次教训。

---

## 核心原则：每一次 LLM 请求都必须有"一次的成果"

**反模式（之前一直在做的）**：

> 给 LLM 一个 user message → 让 KodaX 自由跑完整 task loop（历史 V1 是 Scout → Planner → Generator → Evaluator；当前是 Worker 主 Agent，按任务要求读取证据并评审；旧 Sidecar Verifier 已退役）→ 跑完看 OK rate / hit rate。

为什么错：
1. **信号被淹没**。Prompt 微小调整的效果被 N 轮自由决策的累积噪声覆盖。Worker / 历史 Generator 第 5 步的不同决策 ≠ prompt 的效果。
2. **acceptance 不可度量**。OK rate（process exit 0）、hit rate（must-touch 文件命中数）都是端到端弱信号，不能区分"prompt 让模型做对" vs "模型自己做对" vs "模型瞎跑了一下凑巧过了"。
3. **token 成本高**。每个 cell 跑 5-15 min × 多轮 tool calls × 大量 file reads → 单 cell ~$0.5-2，36 cells × 6 prompt 版本就是 $100+。
4. **不可重复**。同 prompt + 同 case 跑两次结果可能差很大（agent loop 随机性 + tool 调用顺序差异），1 cell 不够，必须重复 N 次取统计 → 成本指数升高。

**正确模式**：

> 一次 LLM 请求 = 一次可断言的成果。

每次实验定义为：
- **固定的 input**（system prompt + history 的精确字节）
- **明确的 expected output 形态**（关键工具调用名 / 字符串断言 / JSON shape / 不出现某个反模式 / etc.）
- **单次 LLM call** 就能验证

机械断言负责回答“发生了什么”，不是所有发布建议的最终裁判。对于 lift / harm / 产品价值比较，最终问题是 **candidate 是否比 baseline 更有价值**；这类语义问题由当前主会话读取盲化配对证据做语义评审，并将机械指标作为可解释的诊断证据，而不是设置“任一 alias × case 未达固定比例即否决”的僵硬门槛。

**多轮场景**：每一轮是**独立设计**的 controlled test，**不是**让 LLM 自由展开后看最终态。

## Eval 必须交付分析，不交付一个布尔验收值

每次 prompt A/B eval 的产物必须回答：

1. **任务是否有效**：case 是否真实代表 production 任务，输入是否对齐 production bytes，主会话评审是否在比较真正关心的能力。如果任务或评分器无效，结论标为 `eval-invalid`，先修实验，不评价 prompt。
2. **哪里提升、哪里回退**：按任务维度、provider 和失败模式展示 candidate 相对 baseline 的差异，不能只给 aggregate pass rate。
3. **回退原因是什么**：区分 `eval-design`（case / scorer / cutoff 失真）、`provider-noise`（限流 / timeout / 格式抖动）、`prompt-regression`（prompt 确实诱导了更差行为）和 `inconclusive`。
4. **建议怎么处理**：输出 `recommend-ship`、`recommend-iterate`、`recommend-revert` 或 `eval-invalid`，并说明保留项、应撤回项、可优化方案和验证成本。
5. **由谁决定**：eval 给出证据和工程建议；最终是否 ship 由用户 / owner 决定。Harness 不得用 `decisionPassed=false` 之类单一布尔值替代上述分析。

发现任务设计不合理时允许修改，但必须创建新的 experiment revision，记录修改理由，并先做小样本 pilot。旧 raw output 保留为诊断证据；只有输入或任务实际变化的 cell 才需要重跑，不能因为 scorer / 评审方法改进而重烧所有 generation token。

---

## 三层实验金字塔（按成本从低到高）

**永远先尝试上层**，上层不能回答再下沉。

### Layer 1: 代码 reading + unit test（成本 $0）

**何时用**：任何 "X 机制是否生效" / "X 函数是否被调用" / "X env hook 是否实装" 类问题。

**例**：
- "handoff inputFilter 是否真生效？" → 读 [runner.ts](../packages/agent/src/primitives/runner.ts)，确认 handoff transcript 会应用 `inputFilter`。再加一个 unit test "filter 函数 strip 后 history 长度变小"。**0 LLM call**。
- "compaction 75% 阈值是否能从 user config 覆盖？" → 读 compaction-config.ts + 写 unit test 直接断言。
- "FEATURE_107 hooks 是否会污染 production？" → grep `process.env.KODAX_*`，看默认值分支。

**强制要求**：每个 LLM eval 提案必须先列"为什么这个问题不能用 Layer 1 回答"。如果列不出来 → 不批准跑 LLM。

### Layer 2: Single-turn LLM probe（成本 $0.01-0.10/probe）

**何时用**：需要观察**单次 LLM 推理输出**的形态。

**设计模板**：
```
INPUT (固定): system prompt + canned history + user task
EXPECTED: assistant 的下一个响应必须满足 X
                 (可选: 不满足 Y / 不调用 Z 工具)
SAMPLE SIZE: pilot 每 arm 1-2 次；确认 case 有效后通常扩到 3-5 次，只有观察到高方差才增加
```

**例**：
- "v3 discipline 是否减少过早 blocked 终止？"
  → 构造一个 Worker 收到的 history：刚跑了 1 次 vitest 失败。
  → 断言下一个响应**不是**直接给出 blocked 终止。
  → 重复 10 次，看比例。**10 LLM call ≈ $0.5**。
- "两种 history 是否让 Worker 做出不同决策？"
  → 给同一 Worker 系统提示 + 两种 history (full / stripped)。
  → 断言下一个 tool_use 的工具名是否相同。  
  → **2 alias × 2 variant × 5 重复 = 20 LLM call ≈ $1**。
- "Worker 在 200K context 下是否漏掉前文 must-touch 信息？"
  → 构造一个含 must-touch hint 的长 history（接近 contextWindow）。  
  → 断言下一个响应是否引用 hint。**5 LLM call ≈ $1**。

**强制要求**：
- 必须能用一段 mock history 重现要测的场景
- 每个 probe 必须保留机械化观测（regex / JSON shape / tool name），以便定位具体行为和评分器漂移
- 用于发布建议的 A/B 比较必须由当前主会话完成盲化配对语义评审；不能只靠机械命中率替代产品价值判断，评审结论必须结构化落盘并给出理由
- 报告必须给出 sample 比例（"8/10 通过"）而不是单次结论
- **若 probe 涉及 tools**：tool descriptions 必须用 production `KodaXToolDefinition.description` 真实字节走 harness `tools` 通道，不是简化 stub（详见反模式 8）

**结果解读注意**：当 prompt 教 multi-step 行为（X→Y）时，single-turn 只断言 Y 会漏掉 healthy "X-first then Y" 表现，呈 floor saturation。判 floor saturation 时按反模式 11 准则做 evidence-driven override。

### Layer 3: Multi-turn but choreographed（成本 $1-10/case）

**何时用**：单轮无法重现的多步交互场景，且**每一步都明确控制**。

**设计模板**：
```
ROUND 1: input=A → assert output matches PATTERN_1
ROUND 2: input=output_1 + injected B → assert PATTERN_2
ROUND 3: ...
```

每一轮的 input 是上一轮的 output **加上 harness 注入的 controlled 内容**，不是让 LLM 自由跑。

**例**：
- "Compaction 触发后 generator 能否继续完成任务？"  
  → R1: 给 generator 一个 90% context 的 history，断言它做下一步 X。  
  → R2: 把 R1 的 history 跑 compaction，断言 compaction 后 generator 仍然识别得出 X 的执行状态。  
  → **2 LLM call/test × 3 case × 3 alias = 18 LLM call ≈ $5**。

**禁用模式**：
- ❌ "跑完整 KodaX agent loop 看最后结果"
- ❌ "让 generator 自己决定何时 emit_handoff"
- ❌ "跑 30 个 turn 看 OK rate"

如果一定要做端到端，标记为 Layer 3.5（smoke test），**N 控制在 3 以内**，**禁止用于 prompt 比较**。

---

## 防跑飞预算（所有付费 eval 强制）

Timeout 只是最后一道保险，不能代替调用数和 token 预算。每个 experiment revision 必须同时冻结：

- `maxProviderCalls`：总调用数上限；pilot、generation、可选外部复核分项计数。主会话读取 raw 不计 provider call
- `maxCallsPerCell`：Layer 2 固定为 1；Layer 3 按预定义 call graph，禁止运行时自行扩展
- `maxRoundsPerCell`：Layer 2 为 1；Layer 3 默认不超过 3，超过必须在设计中逐轮解释必要性
- `maxOutputTokensPerCall`：provider 支持时由 API 强制；不支持时禁止追加 follow-up，并把超额记录为效率问题
- `maxTotalTokens` 与 `maxExternalSpendUsd`：每次调用后核算；达到任一上限立即停止，保留已完成数据
- `timeoutMs`：按任务复杂度设置，只用于终止失控请求；timeout 样本保留，不盲目自动重试

执行约束：

1. **Pilot 先验证实验，不先验证 prompt**：先用 1–2 个代表 case、1–2 个 provider、每 arm 1–2 次，确认任务可区分、主会话能据此判断有效性、预算估计可信。Pilot 设计无效就停，不扩 panel。
2. **Layer 2 不执行模型提出的工具调用**：只捕获模型的下一响应 / tool call 作为观测，避免一个 probe 展开成 agent loop。
3. **Layer 3 使用固定 call graph**：每轮输入、允许的工具结果、终止点都由 harness 注入。禁止模型自行 spawn 无界 child、重试或决定追加轮次。结构化输出若是生产路径本来就支持 repair，可预注册最多 1 次 bounded repair；它必须计入 call/round/token 上限，不能循环修复。
4. **Layer 3.5 只做 smoke**：最多 3 个 case；必须另设 turn、child、tool-call 和 token 硬上限；不得用于 baseline/candidate 优劣结论。
5. **先评审已有 raw，再考虑重跑**：评分器、rubric 或 aggregate 逻辑变化时由主会话重读原始输出。仅当 case 输入改变、raw 损坏或样本确实不足时，才补跑最小受影响集合。
6. **并发按已验证 provider policy 限流**：默认同一 provider 最多 1 个在途请求，不同 provider 并行；`ark-coding` 例外为最多 3 个 model lane、每模型 1 个在途请求。任何 fallback 按实际 provider/model lane 排队。

---

## 实验前必填 checklist（写在 PR / 设计文档里）

```
[ ] 这个问题能用 Layer 1 回答吗？为什么不能？
[ ] 设计落在 Layer 2 还是 Layer 3？
[ ] 固定 input 是什么？(贴上 system prompt + history 的精确字节)
[ ] expected output 的机械化观测是什么？它诊断哪种行为？
[ ] sample size 多少？为什么是这个数（不能是"看心情"）？
[ ] pre-registered 分析问题与主会话评审 rubric：怎样算“有实质价值、总体优于 baseline、存在可信回退”？
[ ] A/B 证据是否盲化？主会话评审是否会结构化落盘并给出理由？
[ ] provider 并发计划：是否遵守默认每 provider 1 并发；若使用已验证例外，是否同时冻结 provider 总上限与每模型上限？
[ ] maxProviderCalls / maxCallsPerCell / maxRoundsPerCell / maxOutputTokens / maxTotalTokens 是多少？
[ ] 总成本 budget：估计 $X。能换什么决定？($X 不值就放弃)
[ ] raw output dump 路径？(强制条款，见 §Raw output preservation)
[ ] 主会话如何抽查机械 scorer？disagree 到什么程度会让 scorer 降级为“不可信”？(见反模式 7)
[ ] 若建议依据包含历史 eval-driven DROP 数据：DROP-commit→HEAD 之间 substrate 是否有改动？需 re-pilot 吗？(见反模式 10)
[ ] 若是 behavioral-neutral hygiene refactor：2-alias pilot 是否已经足以形成建议，不再扩 panel？(见反模式 9)
[ ] 最终报告是否包含 task validity、提升、回退归因、建议与可选优化方案？
```

**特别强调**：分析问题、评审 rubric、样本量和停止条件必须在跑实验前定下来，避免跑完后无限追加样本或挑选对 candidate 有利的解释。Pre-register 的是**比较目标、价值标准与风险边界**，不是要求所有 alias 表现整齐划一的数字，也不是提前剥夺 owner 的最终判断。没有 raw dump + 主会话语义抽查，regex 假阴假阳会让你基于错误数据给出建议（详见反模式 7）。

---

## 反模式清单（绝对不要做的事）

### 反模式 1：把 OK / FAIL 当主指标

OK = process exit 0 是个**极其弱的信号**：
- 模型 emit_handoff 早退 → OK，但任务没做
- 模型 timeout → FAIL，但可能做了 90% 的事
- 模型乱改 12 个不相关文件 → OK 也 hit，但显然是 attention drift

**取代方案**：每个 eval 必须定义具体、可复核的行为观测：
- 工具调用断言：assistant 的下一个 tool_use 的 name 是 X
- 内容断言：assistant 文本包含 / 不包含某个 phrase（**negative-case "不包含" 方向有 regex 陷阱，详见反模式 7**）
- JSON shape 断言：emit_handoff 的 payload 必须含 X 字段
- 副作用断言：跑完 vitest 某个特定 test 必须 pass

这些观测用于解释 lift、harm 和失败模式。涉及产品价值的最终建议由主会话基于盲化配对证据完成语义评审；不能把某个机械指标直接等同于“值得发布”。

### 反模式 2：让 LLM "自由跑然后我们解读"

这是上一节核心原则反复说的。一旦 LLM 跑了 5+ tool calls 自由决策，prompt 微调的效果就被淹没了。**永远不要把 prompt 比较实验设计成端到端跑**。

### 反模式 3：同 provider 并发

每个 coding plan provider（kimi / glm / mmx / mimo / ark）都有 quota。同一 provider 超出已验证并发能力容易触发 429；429 隐藏在 timeout 之后会看起来像模型失败，污染数据。

**默认 concurrency = 1 per provider**。不同 provider 的队列必须自然并行；禁止为了规避单 provider 限流而退化成整个 panel 全局串行。已由 owner 明确确认的 provider 能力可以作为显式 harness policy 覆盖默认值：`ark-coding` 最多同时运行 3 个模型，但同一模型始终只有 1 个 in-flight call。Fallback 按实际路由 provider 和 model lane 进入对应队列。

### 反模式 4：探索期就开多 alias

探索期（不知道实验设计是否可行）= 1–2 个代表 provider 的最小 pilot。验证期（case 有区分度、主会话能稳定解释，且确实需要看泛化）再扩 provider。次序不可反。

**例外**：behavioral-neutral hygiene refactor 走 2-alias pilot（见反模式 9），通常不扩完整 provider pool。

### 反模式 5：prompt 迭代用大规模实验

`prompt v1` → 跑大 panel → "v1 不够好" → `prompt v2` → 再跑大 panel → … 每轮都全量重跑是错的。

**正确做法**：prompt 调试用最小 single-turn probe，先确认回退原因和可优化方向；收敛到候选后，只对受影响 case 做代表性多 provider 比较。未改变的 baseline raw 可复用。manual prompt review > 大规模 grid search。

### 反模式 6：跑完才想"什么算有价值"

如果跑完才决定“17pp delta 代表什么”，说明价值标准没有事先定义。跑前必须 pre-register 主会话评审 rubric，例如：candidate 是否带来用户可感知的实质改善、总体是否优于 baseline、是否存在可信回退，以及哪些效率指标只是辅助证据。

不要 pre-register “每个 alias × case 必须 4/5”一类跨模型全票门槛。模型差异、floor saturation 和偶发 provider timeout 会让它过度否决。正确分析单位是主会话对盲化 A/B 原始证据的整体价值比较。分 alias / case 数据必须报告，用于解释风险、分析回退原因和提出优化方案。

### 反模式 7：用 regex 实现 "不应出现" 类否定断言

反模式 1 推荐的"内容断言：assistant 文本包含 / 不包含某个 phrase"在**不包含**方向上有结构性陷阱：

- **现象**：负面 case（如"trivial 任务上不应调用 todo_update"）的 regex 形如 `output 不出现 'todo_update'`。
- **失败模式**：verbose / chain-of-thought 模型会写 `I should NOT call todo_update` 或在 `<antThinking>` 块里分析 `trivial 任务，不需要 todo_update`。模型的实际行为正确（确实没调用），但 regex 看不懂否定语义，把字面量出现判 fail。
- **真实案例**（2026-05-10, FEATURE_151 Slice I 验证）：kimi 在 `single_lookup` / `single_grep` 4 个负面 case 里，5 次有 2-3 次 regex FAIL，主会话读取 raw 后全部判为行为正确。"kimi 上引入了过触发回归"是 regex 假阴性，根本不存在的 regression，差点让我们把没有 bug 的 v2 prompt 改回去。

**强制规则**：

1. **Negative-case scorer 不能只用 regex**。要么改成"绝对结构断言"（例如：第一个 tool_call 的 name ≠ X — 需 harness 暴露 toolCalls），要么必须由主会话读取 raw output 做语义兜底。
2. **所有 eval run 必须落盘 raw output**（见下节 §Raw output preservation）。每跑必 dump，不 dump 等于把数据丢了。
3. **跑完后强制抽查**：每个 cell 至少抽 1 条 regex-fail，由主会话在干净证据包中独立判断并对比 regex。若 disagreement >10%，机械 scorer 降级为“不可信”：直接基于已落盘 raw output 扩大主会话复核或修 scorer 后重算，**不得因此重跑 generation calls**。Positive case 也建议抽 1 条 regex-pass 防止假阳性。
4. **Positive-case 工具调用判定不能用 `tool_name\s*\(` 单一 syntax**。生产 panel 里 zhipu/glm51 等模型实测会用 `<tool_name>(args)` / `<tool_name>...</tool_name>` / `<tool_call>{"name":"tool_name", ...}</tool_call>` 等多种 syntax；要求 `name` 后紧跟 `(` 的 regex 会把 syntax 漂移误判成 FN。规则：tool-name detection 至少覆盖 4 种 syntax —— `tool_name(`、`"name":"tool_name"`、`<tool_name>`、`name=tool_name`/`name: tool_name`。参考实现见 `benchmark/datasets/feature-120-child-steering/cases.ts` `buildToolNamePatterns`。
5. **真实案例 2026-05-12 (FEATURE_120 Phase 5b)**：第一版 `task_stop\s*\(` regex 让 zhipu/glm51 在 task_stop 触发 case 上误判 0/5；主会话复核后实际 5/5（regex 全部 false negative，zhipu 输出形式如 `<task_stop>(...)`、`<tool_call[]>{"name":"task_stop"...}</tool_call[]>`、XML 嵌套 + YAML 内嵌等）。整体 50 个 run disagreement 14%，说明机械 scorer 不可信。是 FEATURE_151 Slice I 反模式 7 教训之后的第二次同类事故。

### 反模式 8：Synthetic eval 用简化版 tool descriptions（2026-05-24 补充）

很多 prompt-eval driver 在 system prompt 里只放 brief stub TOOL_DOCS（10-20 行）描述工具签名，而不是 production 实际下发给 LLM 的完整 description（每个 tool 1-10 KB）。

**问题**：
- Eval 测出的"prompt 改动效果"实际是 brief stub 环境的效果，不能 transfer 到 production
- 工具 description 本身就是 LLM-facing prompt，重组 / 加长 / 改 layered structure 会影响模型决策
- FEATURE_189 batch4 + todo desc refactor 2026-05-24 真实案例：原 batch2 eval driver 用 ~120 char brief desc，跑出来 zhipu/glm51 dispatch_intent rate 实际是"模型在 brief context 下的默认行为"，不是 production 的真实行为

**强制规则**：
1. 测试 worker-role-prompt 章节改动时，eval driver 必须包含 production 实际 `KodaXToolDefinition.description` 字节（不是简化版）。harness 的 `tools: readonly KodaXToolDefinition[]` 参数把它们走 LLM API tools 通道下发，与 production 一致
2. 测试 tool description 本身改动时，**v_baseline 用 pre-change description bytes**、**v_proposed 用 post-change description bytes**，二者必须 byte-aligned，schema (`input_schema`) 不变只动 description
3. 测试 prompt 章节 X 改动时，driver 必须包含**所有与 X 交互的章节 Y/Z**（PLAN-FIRST 改动测试要带 SCOPE COMMITMENT + PLAN-LIST HYGIENE + DISPATCH，不能只 mock PLAN-FIRST）

**参考实现**：`tests/feature-189-todo-desc-refactor-pilot.eval.ts`（4 个 todo_* desc 通过 tools param 下发 baseline vs proposed）。

### 反模式 9：Behavioral-neutral hygiene refactor 直接跑 full panel（2026-05-24 补充）

Content-equivalent refactor（语义保留 byte 重排：例如 monolithic prose → layered "When to Use / When NOT to Use" sections / 同样信息换叙述形式）的 expected behavior 是**行为中性**（no regression no lift），通常不需要直接跑完整 provider pool。

**正确成本曲线**：
1. **Layer 1**（$0）：先做内容等价性 diff —— 是否 strictly preserves semantic content？如果是，behavioral neutrality is expected by construction
2. **Layer 2 pilot 2-alias × 2 case × 3 runs**（~$1）：
   - 至少 1 case 在两个 variant 都达到 saturation（floor 或 ceiling）→ 该 dimension 无信号 → behaviorally identical
   - 至少 1 case 在两个 variant 都达 perfect parity（100/100% / 0/0%）→ regression 路径已封死
3. **如果以上两条满足 → `recommend-ship`，不跑 panel**
4. **如果 pilot 出现 cross-variant divergence** → 主会话先分析 divergence 是 scorer、provider noise 还是行为差异，再按需要扩 provider；不是无条件跑满 5 alias

**为什么这样**：
- Behavioral-neutral refactor 的 null hypothesis 是 "v_baseline == v_proposed"
- Pilot 已经 12-24 cells 全 same → null 没被拒
- Panel 多花 $4 也只能再次证明 null（每 cell 都 same）
- Panel 的实际价值在 "lift / harm" detection，对 behavioral-neutral 价值很低

**真实案例 2026-05-24**：F189 todo_* description claudecode-style layered refactor。Pilot 2 alias (ark/v4flash + zhipu/glm51) × 2 case × 3 runs = 24 cells：
- C1 multi-step plan-first：4/4 cells (both alias × both variant) 0/3 PASS — saturation floor（model 选择 recon-then-plan，single-turn cutoff）
- C2 trivial exemption：4/4 cells 3/3 PASS — perfect parity（"When NOT to Use" 没造成 false negative）
- 形成 `recommend-ship`，不跑 panel，省 ~$4-6 + 2 小时

### 反模式 10：Eval-driven DROP 不 re-check substrate 变化就 stale（2026-05-24 补充）

某个 prompt 改动 P 被 eval-driven DROP 后，后续 prompt 体（worker-role-prompt / tool descriptions / other sections）继续演进。**P 的 DROP rationale 只在 DROP-commit-time 的 substrate state 下成立**。如果 substrate 后续 ship 了 N 个 prompt 改动，P 的 DROP 数据**失效**。

**真实案例 2026-05-22 → 2026-05-24**：
- F189 B.4 (RULE A/B/C labels removal) 于 2026-05-22 eval-driven DROP（ark/v4flash 5/5 textLen < 220 systematic regression）
- F189 B.5 (FEATURE_xxx version markers removal) 同日 DROP
- 2026-05-22 → 2026-05-24 期间又 ship 了：F189 Batch 1 (✗ + WHY) + Batch 4 (quant→qual) + F190 (TERMINATION 改写) + F191 (SPECIALIST ROUTING + custom agents)。worker-role-prompt 已重组
- Re-check 验证两个 DROP 在新 substrate 下仍然成立（ark/v4flash 仍 hit per-alias gate），DROP holds —— 但**如果不 re-check 就引用旧数据**，可能漏掉新 substrate 已经"修复"DROP 原因的情况

**强制规则**：
1. 引用历史 eval-driven DROP 作 ship 决策依据前，先 grep DROP-commit 到当前 HEAD 之间是否有 substrate 改动（同一文件、同一段落、interacting section）
2. 有改动 → re-pilot 1 alias × 同 cases × 同 variants 验证 DROP 仍成立。Pilot 不成立则 escalate panel
3. DROP 数据 archival 时在 commit message / project memory 标注"基于 substrate state @ <commit-sha>"，方便后续判断
4. v0.7.X 版本 release 时，本版内 eval-driven DROP 的引用窗口截止到下一个 minor release —— 跨版本必须 re-check

### 反模式 11：Floor saturation × strict per-alias gate 误判 refactor harm（2026-05-24 补充，2026-07-11 修订）

“任一 alias × case 退化 ≥1 cell = SHIP fail”会把 floor-saturation、模型方差或 provider 抖动误判为产品回退。该类 strict per-alias gate 已不再作为 ship 决策规则。

**Floor saturation 的辨识标准**：
- v_baseline 在该 cell 已达 metric 自然 floor / ceiling（plan-first metric baseline 0/5 / 5/5；trivial exemption baseline 5/5）
- v_proposed 与 v_baseline 在该 cell 同号同幅（baseline 0/5 → proposed 0/5；baseline 5/5 → proposed 5/5）
- 同一 alias × 同一 case 在 cross-alias pilot 复现（i.e. 至少 2 alias 都 floor saturate）

**正确处理**：
1. 满足以上 3 条时，将该机械 metric 标记为“无区分度”，不要计作 candidate 回退
2. 把 saturation reason、cross-alias 复现证据和 metric 局限性显式写入主会话评审证据与最终报告
3. 由主会话结合盲化配对原始输出来判断是否存在真实 harm；无需事后“override”，因为机械 metric 本来就只是诊断证据

**真实案例 2026-05-24**：F189 todo desc refactor C1 multi_step ark/v4flash + zhipu/glm51 双 alias 4/4 cells 0/3 PASS。模型实际行为是 "I'll start by reading the existing files... then commit the plan"（healthy multi-turn recon-then-plan），single-turn metric 漏掉。这个结果说明 metric 无区分度，而不是 refactor 有害。

### 比较结论与工程建议：主会话语义评审（2026-07-11 修订）

当 eval 比较 candidate 与 baseline 的产品价值时，由**当前主会话**读取 raw output、验证任务有效性、分析差异并给出工程建议。这里的“评审”不是再调用 alias；executor alias 只负责生成样本。

1. **盲化配对**：先由 harness 生成 Arm A / Arm B 证据包，主会话在不知道标签的情况下判断任务有效性、首选 arm、差异大小和理由；完成 case 级判断后再揭盲综合。
2. **价值 rubric**：判断差异是否达到 material（用户可感知且值得维护成本）、是否存在真实回退、回退更可能来自 case / scorer、provider noise 还是 prompt。只问“是否满足某个字符串”不算价值判断。
3. **建议映射**：总体更好且有实质价值 → `recommend-ship`；有价值但存在可优化回退 → `recommend-iterate`；prompt 导致净回退且优化价值低 → `recommend-revert`；task / scorer 无法回答比较问题 → `eval-invalid`。不要求每个 alias / case 都获胜，最终决定由 owner 作出。
4. **数据缺口单列**：timeout、缺失 usage、格式失败必须进入证据包和报告。偶发缺口降低置信度，不自动否决；系统性只发生在 candidate、足以影响实际可用性的缺口可判为回退。缺失 usage 时不得宣称 token / 成本改善。
5. **机械指标是诊断证据**：pass rate、regex、token、latency 帮助解释为什么更好或更差，并用于发现评分器错误；不能单独覆盖主会话的语义分析。
6. **评审落盘**：保存证据包 hash、case 级 verdict、揭盲映射、最终建议、回退归因和理由。仅存在于聊天文本、无法复核的结论不算完成。
7. **语义不变量不能只靠 schema**：若结构化 schema 子集不能表达条件约束（例如“改 severity 必须附理由”），生产合并层必须采取保守、不中断的处理，并有单测。Eval 发现 schema-valid 但运行时拒绝的输出时，这是产品契约缺口，应先修产品/实验契约，再只重跑输入真正变化的最小集合。

只有在主会话判断证据仍然模糊，或用户明确要求独立复核时，才额外调用外部模型。外部复核必须单独预算和授权，不能默认把 executor panel 再跑一遍当“judge”。

---

## Raw output preservation（强制条款）

每次 eval run 必须把 `runsRaw[].text` + `toolCalls` + 机械 scorer 结果落到磁盘 JSON；主会话语义评审完成后，再把 case verdict、揭盲映射与最终建议追加落盘。

**理由**（同反模式 7）：
- regex / 机械判子可能假阴假阳，**唯一的 ground truth 是模型的原始文本输出**。
- 只有原始输出落盘，主会话才能在不重跑 generation 的前提下修正 scorer、调整 rubric 或重新评审。
- pass-rate aggregate 是 derived，dump 是 source of truth — 没 dump 等于扔了源数据，留下的是 lossy summary。

**落盘路径约定**：`os.tmpdir() / kodax-eval-dumps / <feature-id> / <case>.json`（即 Linux/macOS `/tmp/kodax-eval-dumps/...`，Windows `%LOCALAPPDATA%/Temp/kodax-eval-dumps/...`）。**必须用 OS tmpdir，不能放 repo 工作树内**（哪怕 gitignore 兜底也不行 — dump 是 transient runtime 产物，由 OS 回收，结构上和源代码必须分离）。

Schema：

```json
{
  "case": "<case_id>",
  "stage": "<phase / variant>",
  "userMessage": "<exact user message>",
  "aliases": [
    {
      "alias": "<provider/model>",
      "passRate": "<regex pass-rate>",
      "runs": [
        {
          "runIndex": 0,
          "text": "<raw model output>",
          "toolCalls": ["<harness-captured tool calls>"],
          "durationMs": 1234,
          "regexPassed": true,
          "regexJudges": [{ "name": "...", "passed": true, "reason": "..." }]
        }
      ]
    }
  ],
  "mainSessionReview": [
    {
      "reviewer": "main-session",
      "inputHash": "<sha256>",
      "preferredArm": "A | B | tie",
      "value": "none | minor | material",
      "regressionSeverity": "none | low | high",
      "confidence": "low | medium | high",
      "reason": "<auditable rationale>"
    }
  ]
}
```

**参考实现**：`tests/feature-151-fan-out-plan-granularity.eval.ts` 在 driver 末尾用 `os.tmpdir()` + `node:fs.writeFileSync` 落盘，并 `console.log` 绝对路径供 operator 追溯。

---

## 实验成本预算（强制条款）

每个 eval 提案必须包含以下成本估算：

```
Layer 1 (unit test): $0 — 永远先做
Layer 2 (single-turn probe): $X (probe 数 × $0.01-0.10/probe)
Layer 3 (multi-turn choreographed): $Y (cell 数 × $0.5-2/cell)
Total: $Z

能产出的决策：
- (a) ____ (worth $A?)
- (b) ____ (worth $B?)

如果 Z > A+B：放弃 / 缩减实验。
```

**判断标杆**：
- ✅ $5 实验换一条 production prompt 改动：值
- ✅ $50 实验换一个 v0.7.16 设计决定（实装 vs 不实装）：值
- ❌ $50 实验微调一个 prompt 字段："retry blindly" → "blindly retry"：不值
- ❌ $20 实验确认一个能用 unit test 5 分钟回答的问题：不值

---

## Alias pool 与 panel 选择（2026-07-11 修订）

下面 5 个 coding-plan alias 是常用覆盖池，不是每次 eval 都必须跑满的固定验收阵容：

| Alias short id | Provider · model | Family | 档位 |
|---|---|---|---|
| `zhipu/glm52` | zhipu-coding · glm-5.2 | Zhipu | high-end |
| `ark/k27`     | ark-coding · kimi-k2.7-code | Moonshot (via Ark) | high-end |
| `mmx/m3`      | minimax-coding · MiniMax-M3 | MiniMax | high-end |
| `ark/v4pro`   | ark-coding · deepseek-v4-pro | DeepSeek (via Ark) | high-end |
| `ark/v4flash` | ark-coding · deepseek-v4-flash | DeepSeek (via Ark) | floor |

**覆盖价值**：
- 覆盖 4 个模型 family（Zhipu / Moonshot / MiniMax / DeepSeek），跨家族盲区互补；其中 Moonshot 与 DeepSeek 共用 Ark gateway，但走独立 model lane
- DeepSeek 双档（flash floor + pro high-end）能在同 family 内捕到"模型档位是否吃 prompt 改动"
- **2026-05-21 升级**：DeepSeek 双档从官方 API `ds/v4{pro,flash}` 切到 `ark-coding` 路线 `ark/v4{pro,flash}`。理由：用户验证 ark-coding gateway routes DeepSeek-V4 正常，**走 coding-plan 订阅成本可控**，不再混入 token-bill 路径。`ark-coding/glm-5.1`（`ark/glm51`）退出 default panel — 同 Zhipu family 重复采样收益低于跨 family。
- **2026-07-11 升级**：官方 `kimi-code/kimi-for-coding` 暂停用于新 eval；Moonshot 覆盖改由 `ark/k27`（`ark-coding/kimi-k2.7-code`）承担。历史 raw 仍保留原 alias/route，不改写证据。
- **2026-07-18 升级**：所有新建或修订的 eval 将 Zhipu / MiniMax 默认路线升级为 `zhipu/glm52` 与 `mmx/m3`。`zhipu/glm51` / `mmx/m27` 仅保留为显式历史重放 alias；禁止改写旧 raw、旧报告或既有盲审中的真实路由标签。旧实验若要用新模型复验，必须创建新 experiment revision。
- `mimo/v25(pro)` / `ark/glm51` / `ds/v4{pro,flash}` 可按任务显式 opt-in；不要为了“阵容完整”重复采样同 family / 同模型 gateway

**选择原则**：

1. Pilot 用 1–2 个有代表性的 provider；便宜模型可用于验证 case，但不能因为便宜而忽略目标用户实际使用的模型。
2. 需要跨 provider 泛化时通常选 3 个独立 family；只有出现明显 family / 档位分歧时才扩到完整 5-alias pool。
3. 某 feature 只影响特定 provider 时只测该 provider，并在设计中说明。
4. Executor panel 只负责生成样本；主会话负责语义评审。不要默认追加“judge panel”。
5. coding-plan 与 token-bill 路线都可用；必须冻结真实 provider/model、计费方式和预算，不能把 gateway 变化误当 prompt 效果。

Behavioral-neutral hygiene refactor 通常 2 alias × 2 case × 3 runs 已足以形成建议；出现 cross-variant divergence 再扩 panel（详见反模式 9）。

**Alias 失败兜底**：当某 gateway hard rate-limit 时，可降级到等价模型的备用 provider，但必须记录 `fallbackUsed`，并在分析中把 gateway 变化视为潜在 confounder。Fallback 请求进入实际 provider 的并发队列，禁止立即并发重试。

---

## 现成的 eval 工具（KodaX 现状）

KodaX [benchmark/harness/](harness/) 已直接支持 Layer 2 single-turn probe + Layer 3 multi-turn choreographed，关键能力：

- `OneShotInput.tools: readonly KodaXToolDefinition[]` —— 把 production tool 定义走 LLM API tools 通道下发，**测 prompt 教学时强制用 production 真实 description bytes 不用 stub**（per 反模式 8）
- `BenchmarkRunInput.aliasFallback: Partial<Record<ModelAlias, ModelAlias>>` —— 整 alias rate-limit 时自动降级到等价 fallback，不污染 primary alias 数据（per `feedback_harness_alias_fallback`）
- Raw dump 落 `os.tmpdir() / kodax-eval-dumps / <feature-id> / <case>.json`（per §Raw output preservation；**不入 repo 工作树**）

**跑 Layer 2 probe 前强制完成 Layer 1 检查清单 + checklist 中 substrate-recheck（反模式 10） + behavioral-neutral 判断（反模式 9）**。

---

## 总结：方法论核心

> 每一次 LLM 请求都必须产生一项可复核成果。机械 assertion 用于记录具体行为和发现评分器漂移；lift / harm 的工程建议由当前主会话读取盲化配对 raw evidence，回答“candidate 是否有实质价值且总体优于 baseline”。**raw output 与主会话评审必须落盘**（反模式 7）。如果问题能由代码 reading 或 unit test 回答，先用 Layer 1；语义判断直接复用已生成 raw，不默认再调用 alias。
>
> **配套约束**：先 pilot 验证 case、固定 call graph 与多重预算防跑飞、production tool 真实字节（反模式 8）、引用历史 DROP 数据前 re-check substrate（反模式 10）、floor saturation 标记为 metric 无区分度（反模式 11）、同一 provider 并发 1 且不同 provider 并行（反模式 3）。Eval 给出 `recommend-ship / iterate / revert / eval-invalid` 与理由，最终决定归 owner。
