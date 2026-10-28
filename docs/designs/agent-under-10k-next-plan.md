# Token optimization: accepted phase baseline and follow-up work

## 2026-10-28：默认基线已接受，本阶段收口

用户已确认采用当前版作为阶段性默认基线。本阶段状态为 **已接受／收口**；生产基线为
`490ea6de`，配套采用已验证的评测环境、拒绝反馈和 R13–R15 验收证据。
普通主 Agent 的共享系统契约与工具契约已经在生产装配链默认投影，无需增加开关或再次切换。
Coding 仍为默认工作模式，Agent/Script 可选；AMA、SDK、自定义宿主与专用角色兼容边界保持原状。
此次收口记录的是默认采用决定，不代表新包发布或所有平台/模型已获得统计非退化证明。

**当前目标（2026-10-28 用户修订）：保持任务质量，在完整任务往返基本持平的情况下，首轮和全任务 token 持续下降。**
不再把“每个样本绝不多一轮”作为采用条件。偶发多一两次请求要结合任务完成质量、有效测试与审查收益解释；
固定新增步骤、持续明显增轮、遗漏功能或不实报告仍须单独处理。未完成样本不计作同质量效率收益，
单次随机差异不能证明稳定性，也不能因为基线共同失败长期否决已经落地的结构性优化。
下方历史章节中的“零增轮”保留原实验口径；今后的默认采用判断使用本段新目标。

**结论：已按用户确认采用当前生产默认并收口本阶段；不要求逐格零增轮。**
已验收生产补丁在 `490ea6de` 提交并推送；之后仅有评测环境、反馈、案例与证据改动。下面区分生产默认、离线修复和实验候选，
不把某次检查点通过或更短的输出当作完整任务收益。旧日期章节保留取证用途。

**最新 R15 跨案例进展**：从独立人类会话新增历史通知去重、任务状态与正文保真的连续任务，
GLM/Kimi/DeepSeek 均比较原始与当前一次。请求数分别 18→13、13→10、32（截断）→27；
全任务 token 分别 505,917→183,145、348,582→136,647、1,081,961（截断）→581,400。
当前 DeepSeek 完成两轮且独立检查通过，原始没有第一轮最终报告；GLM/Kimi 两版均有去重契约遗漏，
另有身份编码/未知状态边界上的混合差异，因此不能称全部任务等质量全绿或统计稳定。
R14 的技能发现仍受目录拓扑/评分器漏检影响，数据保留，不用失败反复重跑来凑通过。
当前与先前候选生产代码相同，本轮没有待开启的新提示候选。
**现有默认已接受，后续缺口作为独立维护事项；不再以逐格零增轮或共同基线错误推迟采用。**
完整数据与局限见 [R15 验收记录](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#r15-结果与默认采用建议)。
2026-10-28 离线维护已补齐验收反例，并给依赖“临时目录无 Git 祖先”的案例增加调用前检查。
当前受限环境不满足技能发现案例的该前提，直接记录 `eval-invalid`，在模型调用前停止。
这是防误测与防浪费的收束，**不是已实现新的无 Git 根目录隔离环境**。该案例的付费完整任务验证暂不可用；
未来只有在不放宽隔离的环境中通过正确实现预验收，才恢复它。其他案例与生产能力不受此限制。
47 项相邻离线回归、类型检查及 12 份历史最终产物的离线复核见
[离线维护记录](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-28-离线维护目录前提与验收漏检)。
保持已接受默认，不增加固定发现步骤，不为小收益扩矩阵。

| 工作面 | 当前状态 | 尚未证明的部分 |
|---|---|---|
| 三模式与执行装配 | Agent / Coding / Script 已实现；Coding 默认，Script 复用工具执行链、父 Run、预算和取消；undo 保留原生 | Script 不是最低注入模式；不能仅以执行回归证明所有模型同质量同轮次 |
| 共享契约与重复入口 | 三模式共享教学已收拢，保留 AMA、子审查、SDK、专用角色和底层能力；不新增固定发现步骤 | 不以删能力、强制发现或弱化策略换取低于 10K |
| 能力验收 | 既有广泛离线验收覆盖工具、MCP/RepoIntel 装配、模式恢复、打包与 Windows 二进制，见下方验收指南 | 不是最新工作区全套重跑；macOS/Linux 实机、任意外部服务和统计意义上的智能非退化未覆盖 |
| 全任务评估 | 已覆盖缓存、配置、全文恢复、技能发现、历史投影五个家族，最新两组均包含三模型；原始同格一次留存 | 不混算不同协议/修订；存在增轮、共性质量缺口与截断，结论为工程采用依据而非普遍智能等价证明 |
| 有来源的错误反馈 | Todo 来源分类已提交；评测输出目录、缺失 path、角色与命令形状反馈已离线修正；R14/R15 出现实际拒绝恢复 | 无控制变量证明新增反馈的效率收益；仍有多次无效探针尝试，不为触发分支反复跑完整任务 |
| 通用取证教学 R9 | **不采用**，生产规则不变；18 个固定检查点已有结果 | 未观察到新增价值，部分候选只补取包信息；不追加同义提示或矩阵 |

### 当前首轮：完整字段、同一计数器

本轮重新通过真实 SDK 序列化离线截获 32 个装配输入，外部调用为零。
以下选三种 OpenAI Runtime Host 场景：空项目、官方 builtin、归一化路径；
再用 `first-turn-uniform-costs.ts` 只计模型字段，保留全部嵌套工具契约。

| 模式 | UTF-16 字符 | UTF-8 字节 | 估算 token | 同口径历史检查点 | 累计减少 |
|---|---:|---:|---:|---:|---:|
| Agent | 42,628 | 43,112 | **10,839** | 14,376 | 24.6% |
| Coding | 57,124 | 57,628 | **14,470** | 18,008 | 19.6% |
| Script | 64,603 | 65,107 | **16,340** | 22,073 | 26.0% |

这是启发式估算，不是 provider usage。历史列为 `a349eabb` 装配检查点，
**不是最初未优化版**；最初版 `bd4479d` 的实际 API 对比在下表及验收指南。
前述 10,866 / 14,497 / 16,367 多计了 HTTP 控制字段；统一排除后各少 27，
属于口径修正，**不是本轮产品节省**。Agent 严格低于 10K 仍差 840。

外部同计数器参考：Codex Sol Direct / mixed / Only 为 15,174 / 18,476 / 17,047
（`deede7201` 历史 Windows 实抓）；DSH Standard / PTC 为 9,499 / 11,326
（`22ddee37` 源码快照投影）；Pi 默认 / 指定三个扩展为 1,414 / 2,282
（`136b87e8` 源码投影）。这些不是同能力排名，也不是最新版全部实抓。
Agent 比 DSH Standard 高 1,340；Pi 的窄默认工作面不能作为保留全部 AMA 能力的等价预算。
Pi 可继续借鉴的是规则单一归属、简短完整工具契约、扩展只贡献实际需要的说明；
不能据此认定 KodaX 多出的内容全有价值，或要求先发现接口再工作。

### 完整任务三版本：不能只看首轮

R7 每版本六格（两类任务、每格两轮用户指令、三模型），候选仅为 Todo 来源分类，
**不是 R9 取证提示**。保留所有失败与原始留存，没有重跑取好结果。

| 指标 | 最初未优化 `bd4479d` | 当前 `8a1afc77` | R7 Todo 候选 |
|---|---:|---:|---:|
| 已知全任务 token 合计 | 3,215,448 | 1,499,058 | 1,576,826 |
| root 请求 / 全部物理请求 | 103 / 108 | 87 / 89 | 93 / 98 |
| 各格耗时之和（秒） | 931.25 | 560.18 | 631.64 |
| 两轮完成且独立 oracle 通过 | 2/6 | 4/6 | 4/6 |

原始 DeepSeek 缓存格预算截断，候选另有 20,649 未知用量预留；合计不代表公平的同质量性能比。
当前已知 token 比原始少 53.4%，但 DeepSeek 当前配置格比原始多 12 个 root 请求；
GLM/Kimi 三版本均遗漏配置缺省回退契约。不能说智能已全面不降，也不能把基线共同失败归因精简。
R7 首请求真实 API 输入原始约 23.2K–25.7K、当前约 10.1K–11.6K，降低约 55%–57%；
这是受限 Coding fixture，不能与上面的完整宿主估算相混。

### 收口后的维护事项（不阻塞本阶段默认采用）

1. **保留默认与证据**：生产改动已在 `490ea6de`；评测增强和本次收口文档随配套验收提交保存。
   原始对照只留一份，不因采用决定重跑。后续发布按实际变更范围验证，不将阶段收口误记为已发布。
2. **把已知失败分开处理**：输出恢复不可达、字段错误反馈属于确定缺陷，离线修；
   未读契约、错选编辑锚点、无依据扩大验证属于模型决策，目前没有证据支持再加通用提示。
   子审查实际发现问题，应保留；测试后的 Todo 状态确认不能一概算空转。
3. **下一次有限模型验证以机制变化为前提**：复用原始留存，明确当前与候选差异；
   先测失败处的固定检查点及无需恢复的对照，再只补受影响的连续任务。
   同时报质量、报告准确性、root/child/辅助请求、全任务 token、费用与耗时；
   如评测协议改变则标注，不冒充严格三版本因果对照。不再跑完整矩阵。
4. **低于 10K 是后续优化目标，不是删规则指标**：剩余空间以全请求中确定重复或不可用能力的教学为准。
   Agent 工具部分仍约 6.4K，是主要成本；优先一次性审计规则归属和有效装配，
   找不到明确净收益就停，不增加发现往返，不强制合并不同语义工具，也不回退 AMA。

**R11 收束进展（2026-10-28）**：当前工作区已重新完成完整构建、源码/测试类型检查、
20 文件 344 项定向装配与恢复回归、48 项 bundle 回归，以及实际 npm 包中新增的
三模式 Todo 拒绝→合法恢复检查。Bun 1.4.2 重新构建 Windows 二进制，按发布布局生成 ZIP，
8 个生命周期场景通过；npm tarball 的 112 个 bundle 入口审计通过。
这替代了“最终工作区还未做必要包验收”的状态，但不是全仓库测试重跑或实际发布。
15 个首轮装配源码 hash 与 R10 一致，成本数字不变；没有新增生产提示/策略或模型调用。

本次最小改进收束为已有 Todo 错误来源分类和评测输出/拒绝恢复修复，并补上发布产物的验证缺口。
不再据编辑选区失误、未读契约或纯 Todo 响应直接追加机制：现有证据没有证明强制读取、
自动改写编辑范围、删除子审查或跳过完成回执可以无损减少往返。
下一生产候选须先说明哪个真实信息被丢失/误标、由哪一层负责，以及不发生错误时是否保持原调用路径。
满足这些条件才补受影响的有限模型检查；R7/R9 三版本留存继续复用，不为填新表格重跑原始版。

**R12 有限真实验证结果**：只运行预定 GLM 缓存、DeepSeek 配置、Kimi 缓存三格，各两轮用户任务，
原始/旧当前均复用。43 次实际请求、633,638 token、参考 $0.026168477，无未知用量、无重跑。
DeepSeek 通过，主请求 27→17；GLM 15→14、Kimi 10→12，但二者都漏了键碰撞边界，不能算提效通过。
三格均未派发子 Agent、未产生大输出恢复文件，故未实证本轮角色拒绝/输出绑定修复节省轮次。
GLM 两轮分别尝试 `npm test 2>&1` 与 `node --test tests` 后误判所有测试不可用，暴露了精确的
命令形状反馈缺口；已在模型运行结束后仅修改评测回执，144 种允许/拒绝组合保持一致、真实 Runtime
合法恢复通过，未为此重跑模型。生产提示和工具 schema 与旧当前相同（仅 cwd/临时 provider ID 不同），
也没有 Todo 调用，不能把缓存键错误归因于本次 Todo 分类。原始 Kimi 同样曾发生分隔符碰撞。

整体优先级因此仍为：已验收结构作为稳定底座；先解决来源明确的恢复信息缺口，再用既有真实轨迹
定位行为契约遗漏与报告准确性，不先增加提示、强制子审查或自动改写编辑；最后才推进 Agent 低于 10K。
完整任务质量不稳定是当前主要剩余风险。下一次付费若必要，应从保存的失败检查点验证具体机制，
而非再次启动自由任务等待相同错误出现。三版本明细、费用和归因见验收记录 R12。

本轮证据：Temp `kodax-first-turn-wire-MmTAJT`、
`kodax-eval-dumps/feedback-r10-offline-20261028`，包含统一重算与双备份。
具体失败归因、R7/R9 原始留存及本轮回归见
[完整任务验收记录](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md)；
广泛能力验收范围见 [工作模式验收](../test-guides/FEATURE_WORK_MODES_v0.7.97_TEST_GUIDE.md)。

## 以下为 2026-10-27 原计划与历史检查点

以下“current/latest”仅指对应记录日期；当前有效数字和决策以上节为准。

2026-10-27. The original plan below is retained; the execution record at the end distinguishes implemented changes from remaining proposals.
Production checkpoint `c5c296ff` is committed and pushed. Its broad offline
acceptance, repaired fixture drift and explicit unverified scope are recorded in
[the capability acceptance guide](../test-guides/FEATURE_WORK_MODES_v0.7.97_TEST_GUIDE.md).
No new paid model calls were made for this analysis. SDK, specialist profiles,
AMA policy, native handlers and Coding default remain unchanged.

## Historical complete input, not just system text

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

## Historical external comparisons and their limits

| Reference | Same-counter estimate | Evidence scope |
| --- | ---: | --- |
| Codex Sol Direct / mixed / Only | 15,174 / 18,476 / 17,047 | Historical Windows capture, `deede7201`; **not current HEAD** |
| DSH Standard / PTC | 9,499 / 11,326 | Recorded revision's tracked Bash snapshots mapped through serializer, not new Windows HTTP capture |
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


### 2026-10-28：失败回执使用权威来源，不继续增加常驻教学

已推送上一批 `8a1afc77`（Todo 创建即可 in_progress、真实连续 Session 离线验收）。本批发现四个 Todo 处理器的 `{ok:false,reason}` 在通用工具链被当成非错误结果；最小修复为已有失败分支增加四类来源码，分类器只识别完整已知失败形状。成功输出、输入 schema 和首轮内容不变，不用英文原因猜测错误类型，不为 hook veto 推断可重试性。保留原始原因，SDK 的失败 JSON 为新增字段兼容；失败 bytes 与 is_error 有意改变。

本批生产范围共 5 文件，无新工具、发现调用、状态机或自动重试。原生/桥接非法创建→合法创建→旧 ID 拒绝→合法更新的结果和预算相同；三模式实际 Runtime 已验证错误回执进入模型历史后仍可合法继续。32 格归一 SDK 首轮请求相对上一批逐字节一致。完整任务效果通过有限连续用户任务配对另行观察，不能由离线预设回调推定智能提升。验收与局限见[原版本对照指南 R6](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-28-r6来源明确的-todo-错误回执与连续用户任务预注册)。


R6 三模型有限连续配对已完成：主请求合计 50→50，但 GLM 15→16、Kimi 16→18、DeepSeek 19→16；不能用合计掩盖差异。GLM 身份匹配修复更完整，Kimi/DeepSeek 的核心修复接近，但共同缺失身份边界仍失败，部分异常输入处理也不同。后续逐请求复核纠正了 UI 事件漏计：Kimi 两格各有 5 次成功 Todo 调用，其余四格为零；全部样本没有 Todo 失败回执，因此不能把质量或效率差异归因于新增错误码。本批只保留来源分类正确性修复，不把模型变异当作收益，不再重跑。完整智能与全任务效率目标尚未宣称完成；后续围绕已有轨迹中的拒绝范围误读和证据完整性开展通用契约核实，继续保留全部能力与现有隔离。


### 2026-10-28：将多任务效率比较与错误回执 smoke 分离

R6 逐请求复核见[验收指南](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-28-r6-逐请求复核与测量勘误)。修正了 UI 事件漏计 Kimi Todo 的分析错误；两个 Kimi 样本实际各 5 次成功 Todo。上涨集中在审查阶段，修复阶段反而节省 1 个纯 Todo 回合。GLM 额外 README 拒绝及更完整修复、DeepSeek 更少重复探针但放弃部分 Git 核实，必须分别评估，不能笼统归为模型随机性或产品提效。

本地源码再次核对，版本未变：Codex 970111f6（models-manager/models.json 中 gpt-6.1-sol instructions_template）明确批量独立搜索/读取，同时保留依赖、编辑、审批与后续自适应步骤顺序；KodaX 实际首请求已经包含同义约束，不能再堆一条重复教学。Codex plan_spec.rs 的 update_plan 和 DSH 22ddee37 的 packages/todo/tool-todo/src/index.ts:120–153 使用整表计划，减少工具调用数不必然减少模型回合；本次 Kimi 已把多个 todo_create 放在同一响应，保留稳定 ID、evaluator、hooks 优于为此新建整表替换入口。DSH core/agent-loop/src/constants.ts 默认并行安全调用上限 10，是执行调度能力，不能迫使模型把独立操作放在同一响应。Pi 136b87e8 的 core/system-prompt.ts:87–125 按已选择工具组装去重规则，规划扩展独立；可借鉴准确装配，不能把省略扩展能力的低成本视为相同能力的任务成绩。这次未运行三种外部产品的同任务模型对照。

当时计划比较原始产品基线和当前完整版本，并考虑预先固定的波动样本。随后按 owner 新要求改为 R7 三版本、每案例/模型每版一次，原始结果登记复用；没有执行重复波动样本。实际结果与后续取舍如下，不因 R6 总 token −3.32% 就宣布优化目标达成。

### 2026-10-28：R7 多任务三版本对照完成后的取舍

完整数据、缺陷与归因见[验收指南 R7](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-28-r7-完整结果原始版一次留存三版本逐任务比较)。两类自然连续任务 × 三模型 × 三版本共 18 格，每格只跑一次。17 格 Runtime 完成，原始 DeepSeek 缓存触发固定预算后保留未收尾结果；没有补跑该格。原始六格已保存可复用注册表。该观察不是严格同字节因果试验，也不是所有智能能力的验收。

当前已采用版相对原始总已知 token 3,215,448→1,499,058，约减少 53.4%；候选为 1,576,826，相对当前增加 5.2%。原始含预算截断，聚合只能辅助理解。第一 API 输入在此 Coding 受限场景中从约 23–26K 降至 10–12K。仍有逐任务回退：DeepSeek 当前配置 root 15→27，GLM 候选配置 root 比当前多 5；不能宣称已实现“不增轮”。GLM/Kimi 三版本共同漏配置缺省边界，当前/候选没有出现额外独立 oracle 失败，但这不等于全面无退化。

本轮将原因分开：GLM 候选有编辑自修复和有价值的子审查，Kimi R6 上涨在新任务中没有持续复现；DeepSeek 部分开销来自过度扩展验证、独立 Todo 回合及长输出恢复路径不可达。所有 Todo 失败分类分支未暴露，不能将当前/候选差异归因于五文件补丁。原始 Kimi 缓存碰撞被语义评审检出，改进外部 oracle 后统一离线重评所有保存代码，没有为评分器修正重跑模型。

下一阶段按以下最小范围推进，不继续删首轮规则，也不扩大整套模型矩阵：

1. **评测装配先修正**：复用现有 `KODAX_TOOL_OUTPUT_DIR`，由评测子进程绑定到自身 fixture 内，消除合法长输出恢复与隔离边界冲突。已完成真实 Runtime 的外部拒绝→内部恢复离线验证，工作区外读取仍被拒绝；冻结 R7 不改。生产目录默认、白名单和 AMA 不变，不新增路由或发现调用。
2. **核实契约获取与验证范围**：逐请求检查已有提示是否支持将相关公开契约与源码同批读取，以及如何判断已有测试覆盖和新增风险的证据。先用现有失败轨迹离线构造通用反例，不把 undefined、租户分隔符或某个 README 写进常驻规则，不强制每任务多读一轮。尚未形成或采用新提示候选。
3. **保留有价值的工作，减少可证实空转**：子审查确实发现漏测，继续保留；编辑失误导致的修复、误读单条拒绝、缺乏可达路径的额外“竞争缺陷”和独立计划回合分别处理，不用统一循环限制或删除 Todo/协作掩盖质量。已有批量与计划规则已经存在，先查实际接口/回执缺口，不追加同义教学。
4. **后续验证复用原始版**：只对有明确行为差异的新候选做固定检查点及必要的有限任务验证；始终并列原始留存、当前和候选，区分模型选择波动、provider 延迟、评测问题与可信产品退化。保留 AMA、SDK、专用角色和全部能力，以完整任务质量与真实往返为主，费用/耗时一起报告。

### 2026-10-28：R8 离线落实与停止扩大范围的边界

输出目录绑定已落实到独立评测子进程 preload，复用 `KODAX_TOOL_OUTPUT_DIR`，不在并行 Runtime 之间修改共享进程环境。实际启动链的长输出恢复与越界拒绝已验证。另修正评测守卫将缺失 path 错称范围拒绝的反馈；参数和隔离权限不变。没有新增生产改动或模型调用；R7 三版本数据、原始一次留存均保持不变，R8 不冒用其质量/效率成绩。详见[验收记录 R8](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#2026-10-28-r8-离线阶段落实输出绑定校正参数错误反馈)。

进一步审计没有支持立刻重写提示或工具：两个 GLM 编辑失误用原参数重放后，工具均准确执行了指定文本范围/锚点；7 个纯 Todo 响应中 4 个属于验证后的最终状态回执，另 3 个已有合批路径。配置任务缺省边界在原始版也漏，真实请求已具备批量读取能力；应探索相关契约的取证选择，而非强制额外发现/读取或对该案例补答案。现有原生、桥接、Script 合批和依赖回执回归继续保留。

下一步若继续优化生产行为，应先形成一个通用、可检验的候选（例如改善相关契约的取证选择而不新增固定回合），在固定检查点比较选择与合法恢复，再决定有限完整任务补测。本阶段不宣称已节省某几个真实模型回合，也不为了形成改动而加入默认语法修复、强制 Todo 合并或取消子审查。历史全任务对照仍为原始 3,215,448、当前 1,499,058、候选 1,576,826 已知 token，包含 R7 的截断与质量限制。

### 2026-10-28：R9 通用取证候选已验证，维持现有默认

已完成“替换原有编辑前读取规则、把相关行为契约并入已有批次”的通用候选。仅放在 benchmark，没有生产开关或自动发现流程。GLM/Kimi/DeepSeek × 原始/当前/候选 × 两个固定检查点，共 18 单请求、286,626 token、约 $0.0111 参考费用，未执行提议工具、未重跑。原始检查点各一次留存，历史原始完整任务继续复用。

结果不支持推广：尚缺契约时九格都已能一次选齐源码/契约/测试，没有增益；证据已齐时，当前 GLM/Kimi 同批提出源码与测试编辑，候选 GLM 只提出源码编辑、Kimi 转去读包信息、DeepSeek 转去读包信息和 README。包信息未在前文提供，不能简单判为无用读取，也不能证明稳定退化；但候选没有提供更快更完整推进的证据。候选输入每请求增加约 22–23 token，少输出修改内容造成的总 token 降低不等于效率收益。

因此保留当前教学、AMA、子审查与工具能力，不继续调整这条提示直到测试“看起来更好”，也不进入完整任务矩阵。公开契约名称显著时原始版已能选择正确，当前问题不能概括为缺少一条通用教学。后续工作应依赖真实漏取证或恢复轨迹中的具体信息缺口，而非默认多收集文档。完整证据和实验局限见[验收记录 R9](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#r9-结果保留当前教学不推广本候选)。


### 2026-10-28：R14 三模型同场景覆盖与环境边界

已完成 GLM、Kimi、DeepSeek 在两个相同连续任务上的原始/当前产品观察：十格新运行，另两份原始结果留存复用，未重复生成。当前与前轮候选生产字节相同，不重复相同代码组。本轮仅改评测执行环境和守卫反馈，没有添加生产系统提示，首轮装配不变。目录、HOME/TEMP 和环境变量归宿主管理，拒绝回执解释实际执行结果；不让模型背诵具体目录规则。

全文保留/归属清理三模型均完成且核心正确。技能发现不能以冻结 oracle 全绿作为通过：GLM/Kimi 两版均有根标记契约遗漏；DeepSeek 两版均在 32 次上限前没有第二轮最终报告。原始 DeepSeek 被隔离 Temp 的 Git 祖先布局和自写错误测试拖住；当前版主要陷入超出请求范围的并发写入测试。当前六对全任务 token 数值均低于原始，但部分请求数/耗时增加、质量不齐和环境混杂仍在，因此不能宣称完整非退化或零增轮达成。

离线 44 项回归、类型检查、两版各 9 项独立装配检查通过。Node 读写权限和最小环境阻止受控测试意外读取真实用户目录；保留标准测试子进程，不把它称为恶意代码安全边界。当前 Temp 在工作区内的布局仍会干扰根发现任务，需要离线校准不继承 fixture Git 祖先的专用临时根及其原生授权，并补充能区分根标记/错误传播的验收。不能为通过直接扩大外部目录权限。

生产默认、AMA、SDK、专用角色与全部工具能力继续保留。下一步先离线处理上述实验限制，再从已有多案例轨迹分析漏取证和任务范围扩张；不追加泛化教学、固定发现步骤，也不重跑此次失败来凑通过。详细数据、归因和未覆盖项见[验收指南 R14](../test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md#r14-结果三模型均覆盖不能把功能检查通过等同完整任务通过)。
