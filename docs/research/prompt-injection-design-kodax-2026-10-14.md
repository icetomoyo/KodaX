# KodaX 首轮输入优化：哪些说明保留，哪些去重，哪些按需注入？

后续对标 Codex 的定量审计与完整实施顺序已收敛到 [当前主计划](codex-kodax-first-request-plan-2026-10-14.md)；本报告保留为说明归属、风险和生命周期的设计依据。

当前最有依据的方案是：**保留首次决策所需的短规则和核心工具完整调用契约，合并重复教程；按真实能力裁剪指导，运行状态按事件注入，可选正文按需加载。** 首批不改变核心工具的可见性，不把所有说明改为 lazy，不新增面向用户的注入模式配置。大规模隐藏 schema 是独立的后续优化，不能与文字整理混为一次改动。

这是一份设计收敛报告，尚未实施产品修改，也没有验证模型行为等价。三个子 Agent 分别复核 DSH 注入机制、KodaX 指令义务、Codex/pi 生命周期，主 Agent 对照了 KodaX 实际 builder、adapter、bridge 和上下文恢复路径。

## 1. 精简常驻说明，会不会影响表现？

**可能会；但“越长越好”和“出现两次就必然多余”都没有足够依据。** 至少要区分四种变更：

| 变更 | 例子 | 风险判断 |
|---|---|---|
| 合并同一请求内重复教学 | Worker、工具 description、schema 三处解释同一 todo 字段 | 最适合先做；仍需核对触发条件、例外、独立调用路径 |
| 缩写行为规则 | 长篇协作解释改成明确时序和责任 | 可行候选，但是否同样被模型遵守不能由字数或字符串测试证明 |
| 改变说明位置 | system 规则迁到工具 description / tool result | 内容未删也可能改变注意力、权威和首次可见时机，应单独验证 |
| 延迟能力或说明 | 首请求不发 schema，搜索后再提供 | 改变工具选择和调用流程；必须验证发现、恢复和完整任务成本 |

关键判据是：**模型第一次需要据此做决定之前，规则是否已在当前上下文中可见？**

例如，“什么时候建 todo、简单问题不建、续跑不重建”影响首次规划，应该提前知道；`activeForm` 的字段用途属于调用契约，可只保留在常驻工具定义中。又如，“先确定 review 范围再分派独立审查”影响是否选择 spawn，不能全移到 spawn 后的返回文本里。[Worker 规则](../../packages/coding/src/agents/worker-role-prompt.ts:113)、[协作时序](../../packages/coding/src/agents/worker-role-prompt.ts:204)、[todo 定义](../../packages/coding/src/tools/tool-definitions.ts:1400)。

同一义务应有明确的源码归属，但**唯一归属不等于整个产品只出现一次**。普通 child、write child 和 specialist 可以使用独立 system prompt；工具也能独立使用。root 已有一条规则，并不能证明 child 也能看到。必要的短选择提示和工具局部约束可以互补，重点删除的是重复的长篇解释。[child override](../../packages/coding/src/child-executor.ts:1119)、[write child prompt](../../packages/coding/src/child-executor.ts:2207)。

还有一项证据修正：历史 F189 B.4/B.5 的“删除规则导致回退”后来被第一方复审修正，原评分器误判较多；当时 DROP 的理由是收益不足，不是已证明删除有害。不能拿旧标签否决今天的去重，也不能据此认为所有规则都可删。完整义务表及历史证据等级见 [KodaX 专项审计](prompt-guidance-risk-kodax-2026-10-14.md)、[复审记录](../features/v0.7.43.md:984)。

## 2. DSH 的多种注入方式，分别解决什么？

DSH 没有一个可以随意互换的统一“省 token 模式”。它把内容归属、注入时间、调用协议拆开处理：

| DSH 机制 | 真正解决的问题 | KodaX 应借鉴的边界 |
|---|---|---|
| 有序 system sections；工具按能力贡献 guidance | 稳定规则组织、避免给不存在的工具写指导 | 按真实可用能力组装短策略；不用复制其插件框架 |
| `complete` persona / minimal preset | 用户明确选择替换原有 system 指导 | 属于行为配置，不能当成无损压缩默认方案 |
| runtime context / snapshot | cwd 等事实改变时再追加，避免每步重写 system | 复用现有 canonical context / delta；未变不追加；snapshot 不代表旧历史自动删除 |
| skills 目录、模型加载、用户显式手势三条路径 | 不确定用不用时延迟正文；用户已选时直接加载 | 保持显式技能直接展开，自主匹配才先目录后加载；显式加载可能首请求更大而总流程更短 |
| post-tool context / event notice | 工具批次结束后提供新事实或异常提醒 | 用于宿主已知事件和可行动恢复；不能替代动作前必须知道的规则 |
| native / PTC | 直接 function calling 与程序化批量调用 | PTC 把完整 SDK 放进 system，工具数下降不等于总输入下降 |
| system/tool in-history、addition-only、deferLoading | 特定模型协议下更新历史和工具激活 | 按具体能力接入；属于传输/缓存优化，不是通用首次输入减量 |

两点尤其容易误读：`includeRuntimeContext:false` 仍保留 required context，cwd 就是 required；`deferContext()` 的含义是等工具批次结束再投递上下文，与 schema `deferLoading` 不是同一机制。[required 过滤](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:578)、[working-directory](C:/Works/PubProj/deepseek-harness/packages/session/working-directory/src/index.ts:90)、[工具批次上下文](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1777)。

例如 DSH read 的短 description 管局部接口，跨调用的 read 使用原则放到独立 system section，并检查当前 scope 是否能用 read。这支持“各自负责一类语义”，不支持“所有指导都挪到工具里”。[read 实现](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs/src/read.ts:68)。

DSH 的 `inject/steer/followup` 则是是否唤醒及进入哪一轮的调度差别，本身不是文本压缩方式。以上每条的配置默认值、源码和测试证据见 [DSH 第二轮笔记](prompt-injection-modes-deepseek-harness-2026-10-14.md)。

## 3. Codex 和 pi 带来的补充

**pi 最值得学的是工具拥有自己的指导、按可见能力渲染，并保障移动后仍能获取完整契约。** 它有回归测试明确要求：当工具从 system 的直接工具视图隐藏后，codemode 或 `describeTool()` 仍提供 guidelines，不能在去重过程中把规则一起丢掉。[system prompt](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:90)、[回归测试](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-codemode.test.ts:153)。

**Codex 最值得学的是目录只有一个展示位置，以及能力状态有明确生命周期。** native tool_search 返回专用 `ToolSearchOutput`，后续依靠历史中的 schema，不再重复放到顶层 tools；这依赖模型能力。pi 也有普通 function tool 的搜索方案，随后更新客户端 active tools，并不要求原生搜索协议。两者不能混称一种实现。[Codex 测试](C:/Works/PubProj/codex/codex-rs/core/tests/suite/search_tool.rs:761)、[pi activation](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:194)。

pi compaction 将有效 system/tool 状态写入 checkpoint；resume 还会重新应用 allowlist。Codex child fork 对搜索历史的保留也有条件。这说明“曾经加载过”不是充分状态，必须问“这次请求是否仍然可见、目前是否仍然获准”。[pi checkpoint](C:/Works/PubProj/pi/packages/coding-agent/src/core/session-manager.ts:1260)、[pi 恢复](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1815)、[Codex child](C:/Works/PubProj/codex/codex-rs/core/src/agent/control/spawn.rs:1106)。详细比较见 [Codex/pi 第二轮笔记](prompt-injection-codex-pi-2026-10-14.md)。

## 4. KodaX 的推荐内容分配

以下是内部内容策略，不是建议增加一组配置项。

| 内容 | 推荐放置与时机 | 首批处理 |
|---|---|---|
| 用户/项目约束、可信来源边界、完成责任 | 有效作用域内始终可见；必要约束在首次行动前 | 保留；不按任务关键词裁剪用户规则 |
| 何时规划/分工、review 顺序、编辑工具选择、repo-intel 选择原则 | 短的稳定行为规则；只给实际具备对应能力的角色 | 合并重复段落，保留条件、顺序、例外及 fallback |
| 核心工具参数、必填条件、语义副作用、调用前限制 | 工具 description / schema，首次可调用时完整可见 | 清理全局字段教程和重复例子；不机械截断 description |
| 专门工具长教程、低频工具完整 schema | 短用途提示 + 可发现入口；使用前获取完整契约 | 首批维持现状；后续单族试验隐藏 schema |
| 用户显式调用的 skill | 确定性展开当前正文 | 保持直接加载，避免不必要发现往返 |
| 其他 skills / MCP 能力 | 有界且有触发语义的目录，正文/契约按需 | 沿用现有机制，先计量目录规模再加边界 |
| cwd、actor capacity、有效模式等宿主事实 | 首次给必要快照，变化时给短 delta | 沿用现有 runtime context，避免重复描述同一事实 |
| 重复失败、todo 漂移、child 完成等事件 | 相关下一次采样之前的短提醒，按事件去重 | 使用现有 hooks/reminders；不新造通用 LLM 路由器 |
| 大块仓库结构/辅助证据 | 必要摘要先给，细节通过现有 pull tools 获取 | 单独审计重复内容；不与首次选择指导同时删除 |

这里的“短规则”仍是具体可执行的要求。例如 todo 的目标语义可收敛为：非平凡任务围绕里程碑维护计划；简单问题豁免；续跑复用现有计划；子 Agent 完成后先整合证据再更新；不要把 Actor 状态直接当成里程碑状态。字段教程和 JSON 示例另归工具。**这只是语义清单，并非已验证可直接替换生产文本的候选 prompt。**[现有 todo / milestone 指导](../../packages/coding/src/agents/worker-role-prompt.ts:113)。

能力裁剪必须依赖宿主真值：例如 repo-intel 已关闭，应删掉要求调用不存在工具的指导并保留 read/grep fallback；不能因用户这句话没出现“重构”就移除影响分析能力。当前 Worker 的 repo-intel 指导仍有 unconditional 路径，这比减少几个措辞更值得纠正。[Worker](../../packages/coding/src/agents/worker-role-prompt.ts:247)、[工具过滤](../../packages/coding/src/agent-runtime/tool-resolution.ts:101)。

## 5. 先做哪里，收益与风险才合理？

当前离线 Worker 的工具定义约 17.9K 估算 token，稳定规则单体约 6.1K；四个 todo 工具合计约 3.9K，`todo_update` 单项约 2.2K。相比之下，当前已 hint 化的十个工具连 schema 合计约 1.6K。这些是固定场景的启发式计数，不是实际 API usage，也不是可全部删除的量。[计数及方法](first-turn-token-optimization-2026-10-14.md)、[原始聚合](first-turn-token-audit-2026-10-14.json)。

因此第一批应集中在：

1. **重复事实与字段教学**：合并 routing summary 重复字段；Worker 不再重讲完整 todo API；同 managed 路径的 scratch / 语言规则有明确归属。保留每个独立执行入口所需的语义。
2. **工具内部重复说明**：description 与字段说明不再重复整段教程；`ask_user_question` 先去文字重复，暂不改变单题/多题结构。
3. **明确只供 runner 使用的 schema**：审计 `todo_update init/items` 内部调用者后，可从模型投影去掉，handler/SDK 保持兼容。这属于接口可见面变更，需与纯文字去重分开。
4. **消除当前指令漂移**：todo status 的 Worker 教学与 runtime 枚举不一致；bash 的 git diff 示例与 review 专用入口要求有冲突；read-first 的强度不同；旧 Scout/Evaluator/完成裁决措辞可能过时。先对齐真实语义，再压缩，不能一并算作“等价去重”。

逐项源码、保留边界和未决语义见 [义务与冲突清单](prompt-guidance-risk-kodax-2026-10-14.md)。尤其是 read-first 与旧 plan approval 路径，本轮未决定最终产品语义，不应趁优化顺手删掉其中一个。

## 6. 按需工具：bridge 还是普通 native 激活？

第一批文本整理不需要先决定这个问题。核心 read/edit/write/search、todo、交互与协作继续直接可用。若后续隐藏少量低频 schema，两条路径都成立：

| 方案 | 发现后的调用 | KodaX 现有基础 | 主要代价 |
|---|---|---|---|
| 普通工具激活 | search → 下一请求声明目标 → 直接 target(args) | SA 有 description unlock，但不是完整 activation；AMA 目前静态构建 tools | 需让模型可见集合动态更新，恢复激活状态；顶层 schema 变化可能影响缓存；搜索结果与 schema 可能重复 |
| 固定 portable bridge | search 返回完整契约 → tool_call(name,args) | SA/AMA 已有 bridge 与目标执行路径；SA 有 exposure planner | 目标参数仅靠返回的契约引导，缺少顶层目标 schema；长任务需要重新可达契约；要避免 search 后又恢复顶层 schema |
| Provider 原生 deferred/search | 搜索历史携带 schema，由原生协议激活 | 不能只靠现有 exposure mode 名称视为完成 | 需要模型能力、消息结构、序列化和 fallback，工程范围最大 |

**bridge 并不必然多一轮。** KodaX `tool_search` 已返回完整 description/schema，search→tool_call 和 search→native target 均可在下一步执行，不应强制插入 describe。若工具名称和完整契约已知，describe 也不必重复。[search 输出](../../packages/coding/src/tools/tool-search.ts:98)、[bridge](../../packages/coding/src/tools/tool-bridge.ts:56)。

结合现有代码，**建议把 bridge 作为首个“小范围隐藏 schema”实验的候选，不重做整套 activation 系统**；普通 native activation 保留为质量/调用成本对照。这个选择基于工程改动量，不是证明 bridge 的模型表现更好。现有 planner 会把 already_unlocked 工具重新变成 resident；真正试验固定 bridge 时必须明确处理这点，否则工具契约会同时出现在结果和顶层 tools 中。[planner](../../packages/coding/src/agent-runtime/tool-exposure-planner.ts:231)。

同样，AMA 有 bridge 不代表它已做了模型展示裁剪：当前 adapter 直接序列化 `agent.tools`。需要只过滤模型展示，保留内部完整执行/校验工具集合，不能把工具从执行注册表删除后宣称仍可发现。[AMA 工具构建](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:351)、[wireTools](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)。

扩展按需工具前必须同时满足：

- 搜索索引包含所有被隐藏的工具，并遵循当前实际可用/获准范围；当前 keyword search 主要来自静态 deferred hints，不能只删除 schema。
- 首轮短目录能表达“何时值得找”，含足够中文发现线索；不能只列陌生工具名。
- search 返回调用所需的完整局部语义，bridge 仍经过目标工具的许可、取消、写入和错误处理路径。
- 基础行为、目录和 bridge 自身始终可见，压缩后可重新获取契约；如果选择 native 激活，激活状态必须显式恢复并重新过滤当前权限。

相关实现：[search 范围](../../packages/coding/src/tools/tool-search.ts:73)、[SA 目标分派](../../packages/coding/src/agent-runtime/tool-dispatch.ts:440)、[AMA 目标分派](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:222)。没有调用分布证据前，不预先宣布某一组 LSP/Goal/Workflow 工具一定应该隐藏；也不把常用 todo/协作工具作为首个延迟对象。

## 7. 生命周期与 provider 约束

**每条路径都要成立。** SA、managed Worker、普通 child、write child、specialist 分别检查实际请求。复用共同工具契约与现有 prompt helpers，避免为每条路径维护一套长教程；不强行把它们改造成同一调度器。

**持久状态与可见文本要分开。** KodaX 已有 immutable system、canonical managed context 的压缩恢复；tool result 中的长教程则可能被摘要。当前 unlock 是 per-context WeakMap，不能用它推断 resume/new child 仍知道所有契约。稳定规则保留稳定位置；runtime 当前事实从宿主恢复；按需正文确保可以重新获取，不用永久 `sent=true` 代替可见性。[canonical context](../../packages/coding/src/task-engine/_internal/managed-task/managed-run-context.ts:83)、[compaction](../../packages/coding/src/task-engine/_internal/managed-task/compaction.ts:644)、[unlock](../../packages/coding/src/tools/deferred-tools.ts:88)。

**来源和 role 不能混淆。** DSH 的 `<system-reminder>` 标签不会改变 API role；KodaX 也不应把普通仓库/工具返回文本自动提升成 system 规则。用户/项目约束保留现有来源边界，宿主事实与工具证据保持可识别。

**内部追加不等于 wire 保持前缀。** KodaX 当前 OpenAI / Anthropic adapter 会把历史 system 合并到前置 system；所以只在内部历史追加 system，不能自动得到 DSH 的 in-history 缓存效果。真正的增量协议需要 provider 能力和 serializer 同时支持。[OpenAI normalization](../../packages/llm/src/providers/openai.ts:564)、[Anthropic normalization](../../packages/llm/src/providers/anthropic.ts:1366)。

目录/工具顺序确定、动态事实未变不追加，是可以沿用的基本策略。缓存预热、原生工具增量、完整 PTC/Code Mode 不作为本轮首要方案；它们不直接消除首次冷请求中相同内容的 token。

## 8. 实施切片与验收

| 切片 | 范围 | 通过条件 |
|---|---|---|
| A：语义义务与真实请求分账 | 复用现有 diagnostics，核对最终 provider 请求；形成规则归属表 | 区分 system、tools、动态 context、skills、root/child；估算与 usage 分开 |
| B：纯去重 | routing、todo 字段教程、scratch/语言、工具内重复解释 | 工具集合及 API 形状不变；必要语义在所有相关入口、首次决策前仍可见；输入实际减少 |
| C：独立纠偏与能力裁剪 | 每项漂移单独处理；关闭能力时同步裁剪指导 | 当前 runtime 与提示语义一致；没有诱导调用不可用工具 |
| D：模型投影精简 | 单独处理 runner-only legacy schema | 内部接口保持兼容；模型正常调用与错误恢复通过契约检查 |
| E：按需工具小闭环 | 一族低频工具，比较 direct / bridge，必要时 native activation | 发现到达率、正确参数、压缩恢复可接受；固定短流程净成本值得改 |

B 不混入 C/D/E，才能解释质量变化来自哪里。明确用户选中的 skill 保持直接注入；AGENTS 和大块自动 repo context 的预算作为另外的变更，不与本批捆绑。

验证遵循 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)：先完成零模型成本的构造/可达性/生命周期检查；只有行为问题才做真实 production prompt/tools 的受控 probe。初始 pilot 使用少量有区分度案例、1–2 个代表 provider、每 arm 1–2 次；发布判断由主会话盲化语义评审，不能只测关键词。付费调用数、轮数、输出量、总 token、费用上限须在执行前冻结。本轮未执行这些模型试验。

最有区分度的行为样例：简单任务不建计划；非平凡任务或续跑正确维护里程碑；review 先 scope 再分工；多个 child 完成后正确整合；中文任务发现专门工具；编辑前具备完整限制；compaction/resume 后不丢必要规则与能力。隐藏工具试验用固定发现→调用流程，不能跑无界 agent loop 比 prompt。

至少分开看四组指标：第一次 provider 请求的输入；固定首个任务流程的总输入/输出/调用次数；模型行为与恢复错误；缓存读写和延迟。**首请求下降但额外发现请求使任务更贵，不能直接判为优化成功。**

## 9. 当前可以决定与仍需实测的部分

可以收敛的方向：先做重复教学和事实去重；保留短的决策规则及核心调用契约；指导跟随真实能力；事件信息按事件给；显式选择直接加载，自主发现按需加载；复用现有构造和分派边界。

尚不能声称的结论：任一精简候选已经行为等价；可稳定节省某个百分比；bridge 比 native activation 更可靠；某组工具隐藏后全任务成本一定更低。本轮代码和静态证据足以确定改动顺序，不能替代这些行为比较。

证据版本：KodaX `bd4479d59cab3d082f07c2d34681fff198d82fa0`；DSH `d743267388641bc76f17c45ce8b4c231aed1d32c`；Codex `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`；pi `3daa20280f6a7c7cbe0935680c9a38fdc3863005`。日期 2026-10-14，仅本地 checkout，未更新远端。离线计数是组件审计，动态 Git 状态会影响小段上下文，并非固定端到端请求。
