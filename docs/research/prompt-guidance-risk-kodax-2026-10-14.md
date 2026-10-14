# KodaX 哪些提示词是决策必需，哪些重复教学可以合并？

结论摘要：可以先合并同一请求内的重复事实和参数教学，但不能将协作时序、作用域、授权、验证责任和 repo-intel 选择策略一起下沉到按需工具说明。现有历史删除失败证据里，F189 B.4/B.5 的「已证明回退」说法后来被第一方复审撤销；当前是否缩短这些章节，应以当前语义覆盖和有效实验判断，而非旧 DROP 标签。[来源：`worker-role-prompt.ts:102–365`、`tool-resolution.ts:164–174`、`docs/features/v0.7.43.md:984–989`]

## 范围与证据等级

- 查阅日期：2026-10-14；KodaX HEAD：`bd4479d59cab3d082f07c2d34681fff198d82fa0`。本文所有未另注 commit 的行号均对应该版本；只读业务源码及第一方文档、测试，没有运行模型或付费 eval，没有改业务代码。
- 已完整阅读 `benchmark/EVAL_GUIDELINES.md`。本文是 Layer 1 静态分析：源码证明「是否发出/作用域/运行时契约」，单测证明已有意图和保护点，历史报告证明作者曾记录的观察；三者都不等于当前跨 provider 行为实测。[`benchmark/EVAL_GUIDELINES.md:63–92,228–242,271–304`]
- 下文简写：W=`packages/coding/src/agents/worker-role-prompt.ts`；T=`packages/coding/src/tools/tool-definitions.ts`；R=`packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`；E=`packages/coding/src/prompts/execution-guidance.ts`。
- 「必须保留」指语义义务，未要求逐字或保留全部重复句；「merge/move」是候选变更，不是已证明行为中性的发布结论。

## 1. 判断准则：不是出现两次就可以删一次

同一语义能否移动，至少检查：它是否改变首次选工具/分工/终止的决策；目标位置在这一决策之前是否可见；root、普通 child、specialist 和 provider 是否都能看到；compaction 后是否仍可恢复；它是规则、事实、参数定义还是例子。比如工具 schema 的 enum 可以表达 status 值，但表达不了「不要把一个子 Agent 完成误当整个里程碑完成」。[W:125–127,182–188；T:1430–1530]

当前 progressive disclosure **只缩短部分工具 description，参数 schema 仍保持且工具可直接调用**。Core todo/edit/协作/ask_user_question 是 always-loaded；module_context、symbol_context、changed_scope 等 rich description 默认只剩 hint。因此参数教学可合并到前者的 schema；后者的首次选择策略不能无条件从 Worker 删除。[`packages/coding/src/agent-runtime/tool-resolution.ts:157–174`；`packages/coding/src/tools/deferred-tools.ts:19–26,36–54`]

## 2. 具体 keep / merge / move / defer / cannot-decide 清单

| 语义义务 | 分类与建议 | 具体保留/移动边界及风险 | 当前源码依据 |
|---|---|---|---|
| 可信 managed context、非可信仓库/工具文本、用户纠正和暂停的优先级 | **KEEP：首次决策前** | 缩句可以，但必须保留来源/位置边界、context 是证据还是约束、用户后续纠正生效。不能留到调用工具后再教 | W:103–111；测试 `worker-role-prompt.test.ts:35–41` |
| 首轮多 lane 协作、scope→fanout→root diff 的时序 | **KEEP：首次决策前** | 这是改变「是否先自己读完再分工」的全局规则。spawn 的局部说明不能替代首次选择；保留 disjoint write ownership、不重复劳动和 root synthesis | W:204–219；测试 `worker-role-prompt.test.ts:82–122` |
| Actor capacity 真值和 broad-review 任务特定最少 lane | **KEEP：动态事实/任务约束** | 与 generic collaboration 互补：一个给容量，另一个决定任务义务。可避免再次重复 Review target/scale，但不能删除容量或 launchRule | W:24–93；R:311–346 |
| 无现成计划的非 trivial 任务先建里程碑；trivial 豁免；resume 不重建 | **KEEP：首次规划前** | Tool 当地也可保留最短选择提示；不能只留下 todo 参数而删除「何时不规划」 | W:113–127；T:1540–1549 |
| todo subject/description/activeForm/evaluator 字段教学与操作示例 | **MOVE / MERGE：工具局部契约** | W:117–121、129–132 的详细字段/调用例子可压缩，T 描述与 property 中留一份完整契约；Core todo 当前 always-loaded。保留 evaluator 的语义副作用，不只保留 enum | W:117–132；T:1418–1425,1550–1578；`deferred-tools.ts:20–24` |
| todo 用户语言 | **MERGE：同路径重复，但跨路径互补** | Worker、E、R closing、todo_create/update 都重复。Worker 可只保留一次通用自然语言规则加 todo 字段范围；不能只删工具规则，因为 child/SDK 可在缺少 Worker 时调用工具 | W:122；E:16；R:114；T:1403,1539 |
| semantic milestone 不等于 Actor；完成事件后先整合证据再更新 todo，再 wait | **KEEP：互补时序** | 与「完成后更新」相似但并非等价。parent 需要多个 child/综合结果时，过早 completed 是实质风险；可以合并 W 内两处，不宜完全删去 | W:125–127,182–183；T:820–826（wait_agent）；`worker-role-prompt.test.ts:76–78` |
| todo freshness/dedup 与 initial-plan 豁免 | **MERGE：保留触发条件** | 「after wait/resume/Actor 可能改状态才 get」防止每轮仪式性拉取；名称相似≠重复。缩到一处保留 stale boundary、scan-before-midtask-create、resume 区别 | W:150–155；T:1413–1414,1548,1620–1625 |
| plan 是可修订进度视图，不应绑架目标；验证过的证据不重复探测 | **KEEP：全局任务纪律** | 与字段定义无关，直接抑制 scope drift 与反复读源码。compaction summary 有具体证据时也适用 | W:158–163 |
| edit/write/multi_edit 的选择与禁止已知内容 shell 写文件 | **KEEP 短全局规则 + MERGE 详细原因** | 选工具之前要能知道保留 mutation tracking；T:382–457 已有详尽恢复、编码、原子性说明。Worker 保留短选择规则即可考虑删重复 WHY，但需保证所有调用路径看到当地完整合同 | W:166–172；T:382–457,506–515 |
| edit read-first、unique anchor、multi_edit 原子性/顺序组合 | **KEEP：调用前局部契约** | 这些不是有 schema 就自然知道的事实。old_string/new_string 的类型无法表达整文件唯一性、前序 edit 影响后序 anchor、失败零写入 | T:412–457 |
| scratch 目录规则 | **MERGE：同 managed 路径真正重复** | W:172 与 R:201–204 重复；保留 session scratch→session scoped fallback、禁止共享根、不要系统 tmp。R 中 write 自动建目录、helper last resort 是额外义务，不能随着重复句一起删 | W:172；R:200–214 |
| dispatch objective 的作用域、约束、证据、输出格式和语言 | **KEEP / MERGE** | 参数可说明 objective 是 string，却不能教出 bounded delegation。W 的工具家族示例可精简成按任务推荐证据类型；语言规则可引用共同规则 | W:188–201；T:633–640 |
| send_message 不启动 idle turn、followup 才继续；wait 只返回 ack，mailbox 为证据 | **KEEP：协议差异，局部为主** | 同一套语义 W 有简表和展开例子，T 有契约。可删重复调用样例，但保留 idle/non-waking、wait_expired 不忙轮询、何时 agent_output 不该调用 | W:180–187,222–239；T:766–837,891–900 |
| 活 child 不可静默遗弃；root 最终整合与验证责任 | **KEEP / MERGE** | W:187、handoffRules 末段有重复，可集中一处；不能删除生命周期收束/未解决归属披露。Goal 完成、Actor turn 结束、任务质量不是同一语义 | W:187,333–339；E:20–22；T:1355–1367 |
| repo-intel 任务选择/原始 read/grep fallback | **KEEP 短选择器；MOVE 逐工具详解** | Worker 目前列表+WHEN+CHANGE-REVIEW 三层有重合，可保留「任务→首选工具」和 fallback、精确源码例外、scope 边界；工具自身的输出形态/refresh 细节移当地。不能把整块移到默认 deferred rich description | W:254–292；T:1723,1881,1911,1927,1943；`tool-resolution.ts:164–174` |
| repo-intel 模式 off 时仍要求 pull tools | **DEFER：按已知能力裁剪，而非猜任务** | W 注释明确 unconditional，off 时依赖 unknown tool error 再 fallback；运行时确实删掉该工具。能力 off 可同时删对应指导/改为 read/grep，从源头避免首个失败调用；需覆盖真实 builder/child 路径 | W:247–252；`tool-resolution.ts:101–120` |
| 决策 summary 重复字段 | **MERGE：真正重复事实** | R 的 decisionSummary 与 buildWorkerRoutingContext 在 context/combined 同时出现，Primary/work/risk/complexity/review/QA/brainstorm 重叠。保留一次及 R 独有 assuranceIntent；不要只按字符去重丢掉独有字段 | R:99–109,331–346,356–380；W:326–339 |
| 问答 questions 单/多/自由文本、自动 Other、default 到期行为 | **KEEP 局部契约 + MERGE 参数重复** | 选择 UI 行为无法从 string/array 推出。重复「多问题别揉一起」可收一处，但首轮工具可见性、default 的行为与 closed decision 边界不能后移到结果提示 | T:1187–1304；`ask-user-question.ts:190–261,297–334` |
| 验证证据、视觉验收、缺失能力不得假装完成 | **KEEP：终止前义务，首次行动时可见** | 影响提前保存渲染证据/规划验证，不能只在 final 后提醒。新方案主 Agent 担责，普通 child 的 lifecycle completed 不能替代质量结论 | E:17–20；W:300–306；`docs/ADR.md:6582–6588` |
| 40 行/3 层/每 bullet 一句的 plan 输出限制 | **KEEP 局部合同** | 当前 T 仍有，且历史有具体 UI budget + 第一方人工/LLM复审证据。不能把所有数字阈值都视为过时 noise | T:1388；`docs/features/v0.7.43.md:986,989` |

表中的 MERGE 不等于对现有输出做全局字符串去重。应该在源码定义语义的唯一主位置，再对必须独立运行的路径作必要投影；否则容易把跨入口保障误删为重复。[R:309–394；`child-executor.ts:1119–1160,2207–2221`]

## 3. 先澄清再压缩的冲突/残留

1. **read-first 强度不一致**：W:168 仅要求 non-trivial 文件先读，T:419/450 要求该 conversation 中先 read。候选合并必须选定语义，不能声称删哪一份都等价；长任务 compaction 后「先前 read 是否算读过」也需定义。现阶段标记 **cannot-decide**。[W:168；T:419,450；`compaction.ts:311–340`]
2. **git diff 选择有表面冲突**：T bash When to Use 明列 diff，W 禁止 change-review 用 bash git diff，并允许非 review git ops。合理候选是 T 明示 diff 用途例外与 review 专用入口，保留精确 scope。不宜直接删掉 Worker 的 review 时序规则。[T:510；W:287–292]
3. **todo status 教学不完全一致**：W 列 pending/failed/cancelled/deleted 却不列 skipped；T 明确 pending 不能从 update 设置，且 skipped 可用。运行时 `ALLOWED_STATUSES_FOR_UPDATE` 确认后者。把枚举教给当地 schema 可消除维护漂移，但语义里程碑策略仍须保留。[W:124；T:1410,1417；`tools/todo-update.ts:98–117`]
4. **遗留的 Scout/Evaluator 与 handoff 语言**：R skill 区段仍称协调面共享给 Scout/Evaluator，冲突要在 handoff 表露；R closing 仍警告非-authoritative role 的 complete 会导致 runner 提前结束。当前只有 Worker case 主动组装、其终止是 text-only，最新 ADR 又退役 completion adjudicator。属于 **历史残留候选**，需要追踪 specialist/default case 的实际语义再改；不是把「验证义务」删除的理由。[R:111–116,254–269,293–396；W:300–306；`docs/ADR.md:6582–6588`]
5. **SA 的 plan approval 旧路径**：`prompts/system.ts:95–100` 仍教 ask_user_question→set_permission_mode；T:1382 现有 exit_plan_mode 专属 interactive approval 且不得结合 set_permission_mode。这是入口差异/潜在冲突，不能在 Worker 审计中假定所有路径都已统一。需要按当前 permission runtime 验证主入口再处理。[`packages/coding/src/prompts/system.ts:95–100`；T:1382]
6. **语言规则的范围不是完全相同**：E 覆盖解释/进度/final，R 特别覆盖 Actor-event resume summaries，todo 覆盖 subject/activeForm/note，dispatch 覆盖 objective 进而影响 child 返回语言。可以写成一次明确的字段/事件集合，不能只留泛泛「用用户语言回答」后认为等价。[E:16；R:114；W:122,194；T:1403,1539]

## 4. 历史删除/重写证据：纠正旧结论，检查 substrate

### F189 B.4/B.5 不是当前可用的“删字必回退”证据

`benchmark/EVAL_GUIDELINES.md:276–279` 还记载 2026-05-22 删除 RULE A/B/C 或版本标记的 systematic regression。对应 Git 记录是 `a1b132f4`（B.4 DEFER）、`3559e62b`（B.5 DEFER）。然而更晚的第一方 feature 报告已明确撤销 regression 理由：B.4 scorer disagreement 14/18=77.8%、B.5 8/18=44.4%，复审是 baseline 9/9 对 proposed 8/9，属于噪声量级；DROP 原因是当时 release window 中 hygiene 无 measurable lift，不是证明有害。[`docs/features/v0.7.43.md:979–989,1014–1015`；Git commit `1bb85a83` 的 redesigned pilot；`tests/feature-189-b4-rule-labels-recheck-panel.eval.ts:10–23`]

这里优先采用更晚、明确解释 scoring bug 的第一方复审，而不是旧概括。本文没有原始 tmp dump，因此不能独立复算 9/9；数字是第一方报告的历史记录，置信度低于 raw 可重审证据。[同上；`benchmark/EVAL_GUIDELINES.md:319–330` 对 raw 保存的要求]

当前 substrate 更不能直接继承旧 DROP：从 `a1b132f4..HEAD` 对 W/R/T 的 `git diff --stat` 是 2617 insertions、741 deletions（其中 T 有后来拆文件影响，不能当纯 prompt 量）；当前 W 不再有 RULE A/B/C emitted 标签，已有 canonical Actor、parallel-first、managed trust/context delta，新 ADR 2026-10-11 又退役 completion verifier。旧 alias 也与当前 panel 路线不同。[W:103–111,175–239；`worker-role-prompt.test.ts:82–122`；`docs/ADR.md:6582–6588`；`benchmark/EVAL_GUIDELINES.md:396–413`；最新 W 修改 commit `ceb4ed10c977198c6e0a5c600fce788124d9efa8`]

### 仍有参考价值，但不是当前因果证明的证据

- repo-intel 指導在历史 6 alias×5 case×5 runs 的源码注释里记录 4/6 alias 首工具采用率 +30–40pp；这支持“首次选择教学可能承重”的假设，不证明当前每句都需要。当前多了 relationship_scan、parallel-first、deferred hints 等，且注释不是可复审 raw。[W:237–252；`tests/repointel-tool-adoption.eval.ts`]
- F189 todo layered refactor 的 baseline/proposed multi-step 都 0/3 并非共同失败：报告解释为 recon-then-plan 被 single-turn cutoff 截断；trivial case 两臂 3/3。该案例支持语义评审、避免用单次首工具机械分数判断全部计划行为。[`benchmark/EVAL_GUIDELINES.md:260–267,288–304`]
- V27 的 plan 大小约束删减有第一方复审确认的具体失效形态（过长、多段段落）；当前仍有相同 UI 合同，可暂保留。样本小、未经本文原始数据复算，不应外推到其它数字或整份 prompt。[`docs/features/v0.7.43.md:986,989`；T:1388]

## 5. 跨 provider、child、长任务/compaction 的风险边界

**Provider。** 移到工具 schema 后仍为输入不代表所有模型给予同等注意力；现有 eval 规范要求 production description 原始字节走真正 tools 通道，并保留交互章节。第一批候选宜是语义清单完全覆盖的重复事实/字段，而非同时改 policy、tool choice、例子和顺序。Schema 条件约束与不同 provider 支持差异不能由 prompt token 统计回答。[`benchmark/EVAL_GUIDELINES.md:228–242,313–331`]

**Child。** Actor native child 使用 `executeChildAgents`，传递 parent provider/model、repo mode、compaction 配置；child 可以 fork none/all/最近 turns。Specialist 使用自身 instructions/systemPromptOverride，且源码明确 child override 绕过通用 buildSystemPrompt。故「Worker 已教过」不能成为删除 tool-local contract 的理由；必须分别审计 root、普通 read-only/write child、specialist、fork none/continuation 的实际请求。[`agent-runtime/actor-runtime.ts:615–656,1035–1041`；`child-executor.ts:1119–1160,1303–1427,1600–1615,2207–2221`]

**长任务。** Managed compaction 保留 immutable system，并把 canonical managed context 在语义 summary 外重新安装；这为保留全局短契约提供稳定位置。若改成“首次调用后才在 tool result 教学”，这份教学可能随 transcript 摘要失去细节，必须定义重新可达路径。当前 deferred unlock 是 per-context WeakMap，不能假设 resume/new child 继承所有曾经展开的全文。[`task-engine/_internal/managed-task/compaction.ts:311–340,451–467,644–691`；`tools/deferred-tools.ts:88–134`]

**运行时硬约束与模型义务。** Runtime 拒绝超容量 spawn、错误 status 或非法 schema 可保护状态，但不能让模型自动选对分工时机、保留 scope 或及时整合 child 证据。因此不能以“后端会拦”替代 load-bearing 指导；反过来 Runtime 已验证的类型/枚举可减少全局教学重复。[W:35,184；T:627,1434–1530；`tools/todo-update.ts:98–121`]

## 6. 建议的最小后续切片（不执行）

1. **纯结构去重候选**：R decision summary 合并；W todo 字段/API 示例移当地；managed scratch 重复收敛；统一语言规则覆盖集合。先生成实际 root/child/resume prompt 的语义义务对照与字节差异，不能只看代码 diff。[R:99–114,200–214,331–346；W:117–132,172,194]
2. **单独修已知漂移**：todo enum、git diff 场景、read-first 强度、历史角色名称，逐项确定权威 runtime，不和 token compression 同批混测。[本报告第3节源码]
3. **能力裁剪候选**：repo-intel off 时从 prompt 同步移除不可调用工具策略；以有效能力真值为条件，不做首轮关键词分类器，不因此删 enabled 状态下的首选工具提示。[W:247–252；`tool-resolution.ts:101–120`]
4. **高风险后置**：完整删除 repo-intel/parallel-first/termination，或把 todo/协作工具整个延迟，暂 **cannot-decide**。先证明可发现性与首次相关决策前可见；行为问题才需按既有规范设计最小 production-byte 单步/受控多步 probe，本文不发起。[`benchmark/EVAL_GUIDELINES.md:63–117,228–242`]

## 未证实与未解问题

- 未量化每条候选的 token 节省；最终数值应来自实际渲染的 request，而非 TS 源文件长度。
- 未使用历史 tmp raw dump，未独立重新评分历史实验；已显式区分报告结论与当前机制。
- SA plan approval 与当前 root permission 实际路径、read-first 的 intended strength、legacy close authority 的必要性，需要进一步 runtime 对齐后才能决定修复文案。
- 对“同语义不同位置/次数是否削弱某 provider”的问题，源码和字符串单测只能证明可见性，不能证明行为无回退。

## 可点击入口

- [Worker 指令](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:102)
- [工具定义](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1400)
- [Role prompt 组装](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:309)
- [Deferred tools](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/deferred-tools.ts:19)
- [历史结论纠正](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/docs/features/v0.7.43.md:984)
- [当前验证责任 ADR](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/docs/ADR.md:6582)
