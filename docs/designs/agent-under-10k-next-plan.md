# Agent below 10K: capability-preserving next candidate

2026-10-27. The original plan below is retained; the execution record at the end distinguishes implemented changes from remaining proposals.
Production checkpoint `c5c296ff` is committed and pushed. Its broad offline
acceptance, repaired fixture drift and explicit unverified scope are recorded in
[the capability acceptance guide](../test-guides/FEATURE_WORK_MODES_v0.7.97_TEST_GUIDE.md).
No new paid model calls were made for this analysis. SDK, specialist profiles,
AMA policy, native handlers and Coding default remain unchanged.

## Current complete input, not just system text

Same Windows Runtime Host, empty project, official builtins, actual OpenAI SDK
serialization intercepted locally. Count only nonempty system, instructions,
messages, input and tools using [the uniform method](first-turn-uniform-costs.md).
These are heuristic estimates, **not provider tokenizer counts, bills or UI usage**.
All nested Script contracts are included. Temporary paths/session facts are
normalized. Counts below supersede historical KodaX rows for this checkpoint.

| Mode | UTF-16 characters | UTF-8 bytes | Estimated tokens | Native entries |
| --- | ---: | ---: | ---: | ---: |
| Agent | 45,606 | 46,090 | **11,583** | 36 |
| Coding | 60,102 | 60,606 | **15,215** | 54 |
| Script | 67,581 | 68,085 | **17,085** | 25, including nested leaf contracts |

Source: OS Temp `kodax-first-turn-wire-Tr0MDA`, `inventory.json` records source
hashes. Re-serialized complete model-field SHA-256 values:

- Agent: `763fdf28f48d7bf8eac903285aa1381b2d831b8de5e67ae8b95daae654e0fe55`
- Coding: `7cbf1984f2de17e59abc95eacd93ba3924b74215f6fb319af5bcd1dcfb6b23aa`
- Script: `3b948daaa53c56896dbbaa23a7f2c1db42a2a7ee69f0193ce31fa62823a689e0`

Agent comprises system **3,812**, dynamic context/user **1,092**, tools **6,676**;
the remaining 3 come from combined JSON framing/rounding. Against the matching
historical Agent 14,376 input, the reduction is **2,793 (19.4%)**. This is a named
checkpoint comparison, not an assertion about the original project's first release.
Strictly below 10K still requires at least **1,584** fewer estimated tokens.

## External comparisons and their limits

| Reference | Same-counter estimate | Evidence scope |
| --- | ---: | --- |
| Codex Sol Direct / mixed / Only | 15,174 / 18,476 / 17,047 | Historical Windows capture, `deede7201`; **not current HEAD** |
| DSH Standard / PTC | 9,499 / 11,326 | Current revision's tracked Bash snapshots mapped through serializer, not new Windows HTTP capture |
| DSH Minimal Bash / Pwsh | 477 / 463 | Reduced capabilities; Pwsh is a source projection |
| Pi default / specified extensions | 1,414 / 2,282 | Source renderer/schema projection, not installed-provider capture or all plugins |

Methods and exact revisions are preserved in [uniform costs](first-turn-uniform-costs.md).
The numerical gap to DSH Standard is 2,084 and to Pi's selected extensions 9,301,
but these are **not equal-capability optimization budgets**. The latest local
Codex full request has not been captured; its Sol base template alone is 5,446
estimated tokens and cannot be compared with KodaX's complete input as a total.

Current local source review, without pulling:

- **Pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`:** default tools are
  read/bash/edit/write (`packages/coding-agent/src/core/settings-manager.ts:85`).
  The prompt collects tool-contributed guidelines with exact-text deduplication
  (`core/system-prompt.ts:88–124`). Todo, questions, plans and subagents are
  extensions that add their own contracts. Current builtin codemode exists but
  is inactive by default (`src/extensions/codemode/index.ts:2–5`). Its optional
  describe/search path is not automatically a zero-round-trip substitute.
- **DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`:** Minimal disables optional
  runtime context and text read/write/edit (`packages/bundle/web-app/presets/minimal.patch.yml:15–22`).
  Standard includes a much wider plugin surface. PTC still renders complete
  argument/output contracts (`packages/core/tool-executor-ptc/src/index.ts:40–49`).
  Shared delegation teaching has one contributing tool
  (`packages/subagent/tool-subagent/src/index.ts:363–379`).
- **Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`:** model `tool_mode` takes
  precedence over feature defaults (`codex-rs/core/src/tools/mod.rs:64–86`).
  Local Sol and 5.6-Terra entries specify `code_mode_only`; feature default false
  does not mean the actual model uses Direct. Only still teaches nested leaf
  contracts (`core/src/tools/spec_plan.rs:1020–1090`). Model switching recomputes
  ModelInfo/settings, not a hardcoded Sol/Terra toggle. Its smaller plan schema
  and different delegation policy are not substitutes for KodaX's richer Todo/AMA.

The useful lesson is information ownership and compact complete interfaces.
Low injection does not itself prove equal intelligence; long teaching is also
not a necessary condition for a strong harness.

## One coherent next candidate

Use existing managed-system/tool projections. Do not introduce another mode,
rule engine, keyword router, schema discovery step or configuration switch.

| Work | Smallest scope | Effective constraints that must survive |
| --- | --- | --- |
| Single owner for shared rules | Jointly reorganize collaboration, Todo, Memory, editing and interaction across system and tools | Keep planning/dispatch decisions, independent-read batching, no duplicate child work, completion evidence, refusal recovery and memory authorization |
| Complete parameter teaching | Audit the actual 36-tool menu, especially ask/spawn/Todo/grep; shorten duplicate annotations only | Every field/type/required/enum/default and operational distinction; flat vs batch question limits, incremental Todo/evaluator semantics, grep paging/literal modes |
| Facts versus repeated policy | Capacity/route context carries current facts; Skills usage and platform guidance taught once | Actual capacity, unknown versus zero, refresh conditions, active shell/OS and skill catalog remain visible |

Global system text owns when/why and cross-tool invariants; directly available
tool contracts own invocation, defaults, result meaning and failure conditions.
Each retained rule gets an identifiable owner in the final **combined** request.
SDK, host overrides and specialized roles retain canonical contracts under the
existing provenance/full-menu gates. This must not weaken AMA's dispatch policy.

These are measurable audit surfaces, **not promised savings**:

- ask_user_question 801; spawn_agent 550; todo_update 411; grep 355 total tokens.
  Their schemas contain real behavior, not merely verbose descriptions.
- Six larger tools' parameter annotations occupy about 1,168 in total. Even
  deleting all of them, which is unacceptable, would not close the 1,584 gap.
- Skills usage 342 plus three builtin catalog entries 363: approximately 705,
  only 6.1% of Agent total. Skill bodies are not injected. Keep catalog visibility;
  audit duplicated usage rules rather than hiding skills behind another call.
- Platform/role tail 321; capacity 200; route facts 78. Only duplicate instructions
  can go; these blocks cannot be counted as wholly removable.

Repo/LSP/code_search are already absent from this Agent initial menu, so hiding
them again cannot reduce its 11,583. Script's complete-contract representation
may be studied separately, but its gains cannot count toward Agent's target.
Moving text between system/user, caching, or hiding schemas behind discovery
does not satisfy a reduction in complete first input without added round trips.

## Verification and stopping rules

1. Freeze a full candidate and a rule-owner map before measuring. Review effective
   edit semantics explicitly: KodaX multi-edits are sequential, unlike Pi's
   original-file anchor semantics. Retain explicit independent-read batching.
2. Assert identical tool sets and structural schemas; check annotation rules
   separately. Verify both provider serializations and Agent/Coding/Script, SDK,
   host override and specialist exclusions, including bound MCP/Repo contexts.
3. Exercise existing read/edit/test/AMA completion, readonly child refusal and
   legal recovery, cancellation, permissions, capacity changes, Todo veto and
   session recovery. Compare exact adapter-call counts in deterministic traces.
   Preserve existing guards and raw model output; do not revise inputs to pass.
4. Measure the complete request with the same counter. Report real net savings
   and remaining gap. Do not treat the cost of an audited block as savings.
5. Only unresolved behavioral questions justify bounded model evidence, following
   [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md): reuse existing natural
   checkpoints, freeze baseline/candidate, preregister calls/tokens/cost, review
   blind pairs and distinguish shared model errors from prompt regressions.
   Full-task smoke is separate from prompt-comparison evidence. No new matrix
   for a small saving and no rerunning until pass.

Adoption requires retained task quality and recovery as well as no added
discovery round or credible increase in task calls, total tokens/cost or latency.
Deterministic equality cannot alone prove natural-language intelligence equality.
If the complete candidate cannot save the required amount safely, report that
limit and retain the effective rules; do not break interfaces to force a number.


## Execution record: rule ownership candidate

Baseline: `3df6f10f`, ordinary managed roots only. This batch uses the existing
projections; no tool is removed/deferred, no parameter type/required/default/enum
is changed, and no handler, dispatch strategy or discovery step is added.
Canonical SDK and specialist instructions remain unchanged. The existing
independent-read batching, full mutation discipline, Repo policy and explicit
refusal-recovery paragraph are retained verbatim.

### Rule retention map

| Rule family | Final owner / unchanged boundary |
| --- | --- |
| Synthetic envelope authority, untrusted embedded markers, stale evidence, compaction checkpoints/deltas | Worker TRUST AND SCOPE |
| Scope revisions, contrary evidence, reuse of verified evidence, requested language | Worker TRUST AND SCOPE; language includes Todo and child objectives |
| Trivial versus substantive plan, same-response reads/dispatch, no acknowledgement-only round | Worker TASK AND PLAN |
| Existing-plan reuse, scope growth, deduplication, one active item per owner, milestone evidence | Worker TASK AND PLAN |
| Description only when useful, activeForm on every milestone, deterministic evaluator | todo_create parameter teaching; todo_update preserves transition/evaluator/veto rules |
| Unknown/external plan changes versus ordinary turns; no redundant refresh | Worker TASK AND PLAN and tool invocation conditions; existing state machine unchanged |
| Independent lanes, broad review, root blocker, solo exceptions | Worker PARALLEL WORK |
| Exclusive writes, stable verification target, no duplicate/reapplied work, root integration | Worker PARALLEL WORK; spawn isolation field retains worktree merge-back |
| Child goal/evidence/output shape, data versus prescribed shell, readonly investigation | Worker PARALLEL WORK and spawn parameters |
| fast/balanced/deep, evaluated readonly fast, write-capable fallback, inherited tiers | spawn model_hint; system says choose intentionally using its contract |
| Parent permission ceiling, canonical identity, history, effort conflict, evidence refs | Existing spawn fields |
| Concurrency/work budget, no retry while full, no capacity through recursion | Worker PARALLEL WORK; atomic enforcement unchanged |
| quality_strategy optional telemetry, invalid data ignored, never admission control | spawn tool/field; system retains no dispatch delay |
| Mailbox evidence versus wake acknowledgement, terminal summaries, sparse waiting | Worker lifecycle decisions; wait_agent result contract |
| send does not wake idle Actor, broadcast cap 20, followup starts a turn | send_message/followup_task contracts; system retains evidence communication decisions |
| Interrupt conditions, cancellation, live descendant ownership and final settlement | Worker PARALLEL WORK |
| Refusal versus invalid input, legal recovery, budget/cancellation, truthful delivery | Unchanged recovery/delivery and mutation discipline |
| Memory authority, legitimate intent, no file/shell bypass, applicability and receipts | compact Memory section |
| Exact quote/span/key/ref, decision authorization, requested decisions/show | memory_intent contract, required by existing full-contract gate |
| Skill match/invoke before response, no guessed names/read bypass, no duplicate host invocation | Original dynamic-envelope Skills teaching and catalog unchanged |
| Actual OS/cwd/provider/model, unknown-host fallback | Original Environment unchanged; shorter workspace tail only when that environment is present |
| Scratch as last resort, automatic parent creation, empty dirs, missing-command recovery | compact workspace tail; same canonical strings remain for other consumers |
| Exact machine-readable closing and completion authority | compact closing rule |
| Question flat/batch, free text/select, options/default/expiry, custom fallback, multi-select bounds | ask_user_question shared description plus distinct field annotations; original schema untouched |

The first independent review caught one lost obligation: supplying activeForm
at milestone creation had been reduced to a field definition. The requirement
was restored to todo_create's field teaching, with a failing-then-passing check.
The newly projected question contract also has its own canonical drift hash.
No acceptance guard was weakened to address this finding.

### What was deliberately not changed

The remaining Agent tools were reviewed as part of the joint contract: file and
shell editing/recovery, grep paging, Goal authorization, manual version routing,
search/bridge, history, Memory and Actor lifecycle all carry real operation
semantics. No further parameter was hidden to save their schema structure.
In particular the dual-form question interface stays intact. Canonical tool
schemas and handlers remain the source of execution truth.

Dynamic capacity/route and Skills messages are unchanged. They contain state and dispatch
limits; compressing them requires a separate provenance-aware message boundary,
which is not justified for their small cost in this batch. Actual wire inspection showed that Skills teaching is in the dynamic user envelope, not system. A trial system-only projection and its new Agent-package export were withdrawn because they supplied no production benefit; an artificial system fixture was not accepted as production savings. Repo/LSP/code_search
remain as before. Script receives the same shorter shared contracts, retaining
its complete leaf-schema presentation and native undo/background shell boundary.

This batch's adoption evidence is offline contract/execution equivalence and
independent source review. It adds no statistical model-quality guarantee.
No paid model calls or repeated matrix were used. Further reduction is not
justified solely to hit 10K if it sacrifices useful constraints or introduces
new discovery/refresh calls.


### Final measured request

Same uniform method and baseline as above, final pre-withdrawal capture
`kodax-first-turn-wire-2RqlDv` (the withdrawn Skills branch never matched these
production requests). OS Temp `kodax-rule-owner-final-comparison.json` preserves
all 32 comparisons and additional source fingerprints. Final post-withdrawal
checks are listed below; no projected future saving is included.

| Mode | Before | After | Net reduction | After UTF-16 / UTF-8 |
| --- | ---: | ---: | ---: | --- |
| Agent | 11,583 | **10,712** | **871** | 42,122 / 42,606 |
| Coding | 15,215 | **14,344** | **871** | 56,618 / 57,122 |
| Script | 17,085 | **16,214** | **871** | 64,097 / 64,601 |

The 32 protocol/mode/scenario comparisons retain every native schema structure
and non-system message. All eight internal SDK complete requests are equal.
All eight Script captures retain byte-equivalent parsed leaf contracts (23 or
31 leaves according to host capabilities). Shared control and system teaching
accounts for the reduction, not fewer leaf tools or additional discovery calls.

Agent is down 7.5% from this batch's baseline and 25.5% from the named historical
14,376 checkpoint. Strictly below 10K still needs **713**. The existing DSH/Pi
scope and historical Codex limitations above still apply. No claim is made that
an equal-capability KodaX can reach Pi's size or that this is a current Codex
full-request measurement.

Complete model-field SHA-256, Agent/Coding/Script respectively:

- `978be98ee904de31644dda86e9f331ee79648f274f84163a2ff4b0342b5ca591`
- `d3d386fc36e95cee540246cd0ab831c3e591810e708db77a6264dbad6014f765`
- `b9c5b2ea2e054d0f3e47225711f0cfca5035d162be3acffac9e100994981250c`


### Validation and disposition

Implemented in the ordinary-root default projection for all three work modes;
no optional feature flag was introduced. Coding remains the default work mode.
This is not an unadopted experiment. SDK/host-specialist exclusions remain.

- TDD: question annotation ownership, workspace/platform rendering and the
  reviewed activeForm obligation each failed before their implementation/fix.
- Related prompt/tool/role regressions: **335 passed**; final post-withdrawal
  projection/historical-fixture checks: **26 passed**. These groups overlap and
  should not be added as unique coverage.
- Actual Runtime editing/refusal/AMA/Script and natural fixture runs: **37
  passed** in six files before withdrawing the ineffective Skills branch.
- Full fast tier: initially **2,856 passed, 4 failed, 45 skipped**. Three failures
  came from the frozen historical experiment using current tool descriptions.
  Its fixture now explicitly reconstructs the prior contracts; the frozen hash
  gate is unchanged and a new test rejects current contracts in that old
  projector. All six historical-fixture cases pass in the 26-case follow-up.
- The fourth failure hit the existing **5-second Script cell deadline** during
  suite load. The complete file passed **15/15** in one isolated rerun with no
  code, deadline or isolation changes. This is evidence of a load-sensitive
  fixture, not permission to claim the original full command passed.
- Final source and test type checks and full build passed. Actual installed npm
  tarball checks passed **2/2**, including shared three-mode question contracts,
  Script read and durable receipts, exact two execution calls, and explicit
  missing-worker failure. The obsolete assertion that a managed question's
  wording must equal the SDK's canonical wording was replaced by full
  cross-mode equality and schema-structure equality with SDK.
- Final actual SDK wire capture: **32/32 normalized requests equal** before and
  after Skills withdrawal. Final directory `kodax-first-turn-wire-eXlkwk`;
  inventory SHA-256
  `76a4fbecb837f8382b48322ddd5e5dd4c90134d97dfb36742c371a7aee3097e1`.
  The earlier baseline comparison therefore remains applicable, including all
  native schemas, eight SDK full requests and eight sets of Script leaves.
- Independent Standards review: **0 findings**. Independent Spec review:
  **1 P2 found and fixed**, final **0 unresolved findings**. No model generation
  output was modified and no frozen experiment acceptance fingerprint expanded.

Raw logs use OS Temp prefix `kodax-rule-owner-`; no raw evidence or research
scratch files are tracked. There are no unresolved executed-check failures after
these targeted corrections, but this is not a freshly green rerun of all four
full-repository tiers or all platform/package gates from the prior acceptance.
No new live-model quality, bill or end-to-end latency claim is inferred. Existing
full-task call-count/recovery checks remain unchanged; model semantics beyond
those checks are not statistically certified by this batch.

Remaining under-10K work is **not yet justified implementation**. Skills and
capacity teaching in the dynamic envelope are the identified remaining duplicate
surface, but their useful facts/catalog must remain and removing all of them is
neither valid nor enough evidence of a safe saving. A future joint candidate
must first demonstrate the remaining 713-token reduction at that actual
provenance-aware boundary, with unchanged messages' facts and no extra lookup.
Do not add a new router, hide parameters or run a paid matrix merely to force
10K. The current verified reduction can stand independently of that target.

### Subsequent original-version audit (2026-10-27)

The real pre-optimization baseline is `bd4479d`, not the already optimized
14,376 checkpoint. A fresh source-isolated original SDK capture and current
`c9645bc9` capture give **28,734 → 14,344** for the same Coding Runtime Host
fixture with uniform model-field counting (**50.08%**). Current Agent remains
10,712 and Script 16,214; neither mode existed in the original version.

The dynamic-envelope audit found at most **316** additional heuristic tokens
from rule-preserving Skills/capacity wording candidates, giving Agent 10,396.
No production change was made: the catalog, runtime facts, SDK formatter and
exact-text budget attribution remain. Delta injection is already change-driven;
there is no newly appended full Skills/route block each model round to remove.

Eight bounded GLM/Kimi checkpoint calls support much smaller actual inputs but
do **not** establish round non-inferiority: one GLM reporting pair answered
directly in the original and requested re-verification in current; Kimi requested
re-verification in both. Both contracts retain the evidence-reuse rule. The
fixture's user-role receipt context and single-sample variance limit attribution.
Do not respond with a case-specific prompt or repeated full panel.

The [original-version validation record](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md)
contains raw provenance, exact input/API counts, test outcomes, the bounded
full-task follow-up and remaining limitations. Retain existing gains while
prioritizing complete-task evidence over forcing another small first-turn cut.

The completed GLM whole-task observation sharpens that priority: original/current
used **249,364 / 222,370** total tokens, **9 / 15** model requests and
**83.04 / 119.12 seconds**. Both ended normally and passed 7 public/added tests,
but both failed the same missing-identity safety case (hidden 4/5). Current's
extra work includes its own repair, repeated compound-command refusal and late
Todo bookkeeping after the unchanged iteration-8 reminder. Thus fewer input
tokens do not establish full-task efficiency or intelligence equivalence.
Next audit dynamic reminder consistency and precise fixture refusal feedback
offline, keeping AMA planning/dispatch intact. Do not implement the 316-token
candidate or rerun the panel merely to improve the headline numbers.

The subsequent offline follow-up implemented only two corrections: the empty
Todo reminder now concerns remaining multi-step work, with no retrospective
completed milestones or waived verification; the natural fixture explains its
existing command-composition refusal precisely. Cadence, existing plans, AMA
dispatch, schemas and admission rules are unchanged. The six extra requests
align to two repair/retest calls, one repeated compound-command attempt and
three Todo-only calls; this is not causal proof of six removable requests.
Targeted regressions passed 173/173, both type checks passed, and all 32 first-wire
requests are byte-identical to the previous capture. No model calls were made.
The 316-token candidate remains unimplemented; actual behavioral improvement
from the late-reminder/feedback changes is not yet measured.
## 2026-10-27：暂停首轮精简，完成多轮开销归因与最小修复

完整验收与失败记录见 [原始基线与多轮验证指南](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md) 的 R1/R2 结果。24 个四组合对照任务加 3 个最终生产行为 smoke 已完成，没有为了通过替换失败样本。

保留剩余工作导向的晚到 Todo 提醒；修复防循环延迟结论误拦无关 `todo_create` 的投递问题，复用既有重复签名、检查工具类别和进展边界，保持 AMA、SDK、全部能力及 Coding 默认。只读子 Agent 的评测拒绝反馈另作离线澄清，权限不变。首轮 32 组序列化请求保持一致。

同版本 GLM 对照的主请求由 13/13 降为 9/10，历史补账回合消失；但不能据此宣布全模型不增轮：DeepSeek 仍有规划与检查开销，Kimi 的子审查能修复遗漏也会增加调用。最终 smoke 的独立检查为 GLM 4/5、Kimi 5/5、DeepSeek 5/5；GLM 的缺失身份问题在旧组合中同样存在。

下一步聚焦已保存轨迹中的拒绝恢复和独立 Todo 回合，区分有价值的审查与空转，不关闭协作换取更少调用。暂不继续首轮精简、不再重跑整个矩阵；新的行为调整应先用已有轨迹做有明确因果的离线或固定上下文验证。一个任务族的两次抽样不代表跨任务的智能非退化证明。
### 2026-10-27 续验：安全批量推进，不压缩有价值审查

`f2661c2e` 已提交并推送延迟 stall 提示归属修复及 R1/R2 证据。本轮沿用现有调用链，只把“已知 ID 的 Todo 状态更新可与独立工作同轮提交；ID、审批、验证依赖必须等待回执”收拢为两种 Worker 契约共用的一条说明。三模式离线完整编辑/验证/收尾通过；工具菜单、SDK、专用角色和 AMA 策略不变。首轮抓包增加约 78–79 启发式 token，未以删除规则换取下降。

最多 6 次单轮历史检查点补测实际花费 97,133 API token：DeepSeek 开始修复检查点出现合并收益，后续里程碑检查点两版均有保护测试越界尝试；Kimi 拒绝恢复两版仍尝试同效操作，候选改为派可写子 Agent。生产权限上界和 fixture 均能拒绝，离线恢复闭环已补；不据此减少审查、扩大权限或继续堆叠提示。该结果只支持窄范围教学澄清，未证明全任务轮次全面下降。完整数据、非盲评审限制及验证范围见 [原版本对照验收指南](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-27拒绝恢复与独立-todo-回合的定向续验)。不为本项再跑完整矩阵；后续随实际功能验收观察完整质量与效率。

### 2026-10-27：把优化单位从提示字数提升到完整工作流

本轮原始产品版本对照及窄修复结果见[验收记录 R4/R5](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#r4-完整结果产品版本差异不是单条提示的因果试验)。真实修复任务的首轮 API 输入约下降 55%–57%；GLM/Kimi 遗漏相同边界，DeepSeek 当前完成原版未修好的症状。完整请求并非全线减少，审查质量与拒绝恢复仍有缺口。现阶段最优方向是让既有能力更容易正确调用，不再以继续删规则或关闭审查换取短输入。

本地一手源码版本：Pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`，Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`，DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。以下为源码机制对比与工程推论，不是这些项目同任务模型成绩；尚未运行跨产品真实模型对照。

| 借鉴点 | 具体源码证据 | KodaX 取舍 |
|---|---|---|
| Pi 扩展能提供规划、交互和子 Agent | `packages/coding-agent/examples/extensions/plan-mode/index.ts` 的 active-tools/拦截；`todo.ts:106–140` 从当前分支 toolResult.details 恢复状态；`questionnaire.ts:396–413`；`subagent/index.ts:458–479` 单个/并行/链式派发 | 可学习按职责装配及权威状态恢复。不能说 Pi 的少量核心 token 已经包含全部扩展成本；示例的 toggle 非幂等、clear 重置 ID，也不能直接替代 KodaX 的稳定 ID、owner、evaluator 和 Actor 生命周期。 |
| Pi 区分注册、可见和可调用 | `packages/coding-agent/src/core/extensions/types.ts:501–516`：direct/model-only/codemode/deferred/hidden | 对照已有 Agent/Coding/Script 装配边界，保持交互原生、脚本调用复用执行链。不新建第二套路由，不把常用能力藏到发现调用后。 |
| Codex/DSH 一次写入完整计划及状态 | Codex `codex-rs/core/src/tools/handlers/plan.rs:87–110`、`plan_spec.rs:8–38`；DSH `packages/todo/tool-todo/src/index.ts:120–153,193–208` | 学习消除 create→取得 ID→激活首项的接口依赖；不直接照抄整表替换。DSH 新 turn 会清空计划；KodaX `todo_create.ts:4–15` 的历史明确说明独立创建正是为避免整表初始化擦掉进度。 |
| DSH 子任务说明与权限范围对齐 | `packages/subagent/subagent/src/child-agent.ts:166–175,220–277` | 已最小修复 KodaX task read-only 与 host full-access 的说明冲突，权限执行不变。不照抄 DSH 固定授权策略覆盖 KodaX 现有实时检查。R5 未证明少轮次，保留为事实纠正。 |
| 工具返回区分错误来源 | DSH `packages/core/tools/src/contracts.ts:152–164,263–282,348–370`；Pi `packages/agent/src/agent-loop.ts` 的 beforeToolCall block/terminate；KodaX `agent-runtime/tool-result-classify.ts:49–83` 已识别部分 exec-policy 结果 | 复用已有 code、retryable、denialSource；仅在宿主确知来源时补足信息，不建立按英文字符串猜类别的分类器，也不新增自动反复重试。 |
| 已注册角色可以随工具直接呈现 | Codex `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:28–47,71–97`；DSH `packages/subagent/tool-subagent/src/preset-selection.ts:44–68,87–95` | 先核实 KodaX `list-dispatchable-agents.ts:28–80` 与实际注入是否重复。只有发现真实无益 list 前置才调整，目录必须来自现成 registry，不能增加远程发现延迟。 |

**后续改动计划（待对应验证，不是已经采用）**：

1. **优先简化 Todo 的真实依赖**。先评估在现有创建路径允许首项直接 `in_progress`，以及已有 ID 多项更新能否继续用同响应调用达到同样效果；若足够，不新增大而全 batch 工具。只有确定多项创建/推进仍需模型回合，才做稳定 ID 的增量批量入口。保留旧 SDK、专用角色、hooks、事件及 evaluator，逐项报告部分成功，不靠强制整表替换或事务回滚掩盖已发生的操作。首轮 schema 增量与完整任务节省一起比较。
2. **对已确认来源的拒绝提供准确回执**。保留原始原因与多模态内容，区分参数可纠正、能力未绑定、权限拒绝、取消和执行失败。未知 hook veto 不推定永久禁止或可以重试；授权变更后允许重新判断。此项可以独立验证，不能承诺结构化标签必然解决模型重试，也不把 R5 的单个越界案例写进专用提示。
3. **保留协作、收敛选择成本**。有价值的子审查与父级验证继续保留；先查实际请求中已有角色目录及发现成本，再决定是否同源预装简短目录。暂不改 Actor 调度，也不依据 bash/非 bash 与外部项目不同就引入新并发框架，尚无竞态复现。
4. **补真正连续会话验收**。先用同 Session 两次 `runs.start` 的离线测试验证历史、当前权限、执行回执和计划状态；另测新 Runtime 冷恢复，不把同对象 resume 当持久化。当前仅查明 TodoStore 是 task-scoped in-memory，尚未找到默认冷恢复完整 TodoItem[] 的证明；不得宣称已覆盖或擅自承诺跨 Run 共享。若生产契约本就按任务隔离，测试应验证正确隔离而非强行复用。

验证案例以自然任务与实际回执为准，至少区分三个家族：修复后用户追加相关边界（相关修改才复测）；首次定位后用户要求局部实现（复用仍有效证据但不冒用旧测试结果）；只读审查受限后父级合法验证（拒绝不换工具绕过、也不放弃静态工作）。参数错误可纠正、用户取消需停止、明确授权变化可恢复作为离线反例。既有缺失身份错误只作一项边界，不围绕单个 fixture 定制契约。

实施顺序为一次一个接口候选，先真实 store/hooks/evaluator、权限、取消、预算、原生/桥接/Script 和 SDK 等价测试，再冻结真实生产输入。必要的模型验证只做受影响的有限连续会话配对，复用未改基线，不重跑全矩阵；完整任务记录 root/child/aux、用户轮与模型轮、已知 usage/未知预留、费用、延迟、最终补丁和报告准确性。新增调用必须区分实际质量收益与可避免空转；候选有可信质量退化或固定额外发现回合则不默认采用。尚未预注册新付费实验，本计划不是开放预算或已经证明的非退化结果。

### 2026-10-27：Todo 初始状态与连续会话的离线落实

已落实计划第 1 项的最小接口改良：`todo_create` 增加可选 `status: pending | in_progress`，省略仍为 pending。创建时可直接开始工作，无需先取得 ID 再额外激活；已有 ID 的独立更新继续用同一响应，无新 batch 工具、路由或配置。创建终态会拒绝且不分配 ID，完成仍走 todo_update 的原有钩子和 evaluator。新增状态进入 before-create seed 和 created 事件，一次创建只发布一次最终状态，原有进度不被整表替换。SDK/专用角色使用同一兼容参数，旧默认、AMA 和 Coding 默认不变。

补充了三模式实际 Runtime 的三个连续用户 Run：修改 → Plan 下静态审查 → 关闭并重开 Runtime 后运行真实测试。同一 Session 历史与执行回执保留，新任务 TodoStore 为空，这是现有 task-scoped 契约；没有引入跨 Run Todo 持久化。此处冷恢复是已结束 Run 后继续同一 Session，不是崩溃中断任务恢复。模型响应由离线回调预设，不证明真实模型会自主使用新参数、少轮次或质量不下降。

实际 32 格 SDK 抓包与修改前相比，只有 todo_create 的可选 status schema 和去掉“仅 pending”的一句说明变化；其他工具菜单、参数、消息、system、controls 完全一致。三模式完整 Host 输入同口径约增加 48 个估算 token（OpenAI Agent 10,818→10,866；Coding 14,449→14,497；Script 16,319→16,367）。这是完整工作流优化的接口成本，不是首轮精简成果，不把潜在少一次工具调用等同于实际少一次模型往返。

原生/桥接预算与完成检查、取消、创建 hook 否决和既有调用兼容均有离线覆盖。生产改动先 RED→GREEN，类型检查与 workspace 构建通过；覆盖率与最终测试证据见验收指南。本轮无付费模型调用。

下一批仍按原顺序：从已有错误来源审计回执，不靠模型猜错误类别；角色目录只在发现真实重复成本时改。连续会话机制已有离线证据，真实模型的连续用户任务表现与完整质量/轮次仍需独立有限配对。暂不同时引入批量 Todo、更大协作改造或继续削减教学。
