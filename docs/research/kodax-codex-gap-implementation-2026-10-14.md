# KodaX 首轮工具面：对标 Codex 的具体改动计划与反例

日期：2026-10-14。本文只检查本地生产源码和已有测试，没有运行模型、benchmark 或测试。已读 `benchmark/EVAL_GUIDELINES.md`；下文的尺寸是离线字符串统计，不是 token、成本或质量收益。KodaX 基线 commit：`bd4479d59cab3d082f07c2d34681fff198d82fa0`；Codex 基线：`c22a06c18070c3e33bd2648c7210a00a2a9f6f80`。以下 K/C 引用分别以这两个 commit 为准；本轮不修改业务代码。

## 决策

建议接近 Codex 的**短调用契约、按实际能力投影、独立运行策略**，不把 KodaX 改成只有 Codex 同名工具。第一批应完成三个独立切片：模型 schema 去 legacy、工具说明与 Worker 策略重新明确归属、repo-intel 指引与实际可见工具一致。保留 todo 的增量实体、交互输入模式、Actor 生命周期和权限语义。把首轮 schema 隐藏继续接到已有 portable bridge，而不是本轮另造 native activation 状态机。

理由不是“复杂能力不该存在”，而是当前把 SDK 兼容字段、逐字段教学、工具选择策略同时放在模型视野中。以 todo 为例，四个工具 description 原文合计 **9,168 字符**，并且 Worker 另有 3,043 字符 plan-first 与 1,128 字符 plan hygiene；这些区块不是全部重复、也不是全部可以删除。更小的模型接口可以保留现有运行能力。[K1][K2][K3]

## 离线量化：已存在的片段

方法：从 `tool-definitions.ts` 指定对象提取 `description` 与 `input_schema`，只求值这些无副作用的字面量表达式；schema/wire 用无空白 `JSON.stringify`，wire 固定为 `{name,description,input_schema}`；Worker 统计实际字符串数组 `.join('\n')` 的结果。没有 import 产品模块，没有读配置、调用 provider 或初始化 runtime。工具描述列为字符串本身长度，JSON 列包含转义和标点；不同列不可直接相加。UTF-16 长度在本表称“字符”，不是模型 tokenizer 单位。计数源见 [K1][K2]。

| 当前工具 | description 字符 | schema JSON 字符 | wire JSON 字符 / UTF-8 bytes |
|---|---:|---:|---:|
| todo_update | 4,220 | 4,515 | 8,856 / 8,910 |
| todo_create | 2,778 | 1,204 | 4,079 / 4,109 |
| todo_get | 1,133 | 163 | 1,365 / 1,377 |
| todo_list | 1,037 | 33 | 1,141 / 1,153 |
| ask_user_question | 657 | 4,549 | 5,271 / 5,275 |
| spawn_agent | 698 | 3,112 | 3,865 / 3,867 |
| send_message | 290 | 803 | 1,149 / 1,149 |
| followup_task | 169 | 460 | 686 / 686 |
| wait_agent | 475 | 241 | 770 / 770 |
| list_agents | 175 | 424 | 654 / 654 |
| interrupt_agent | 193 | 423 | 675 / 675 |

可直接确认的 legacy 体积：`todo_update.input_schema.properties.op` 与 `items` 的独立 JSON 对象为 **1,690 字符 / 1,696 bytes**；从当前整个 schema 删除这两个属性实际差值为 **1,689 字符 / 1,695 bytes**（JSON 逗号边界导致差一）。这只是现存片段的确切体积，尚未计入新增 `required:['id']`、清理 `op="update" only` 或描述改写后的净差值，不宣称最终节省这么多 token。[K1]

`ask_user_question` 顶层与 `questions.items.properties` 有 **10 个同名键**：question、options、multi_select、min_selections、max_selections、default、allow_custom_input、custom_input_label、custom_input_prompt、custom_input_default。分别独立序列化为 **1,827** 与 **1,582 字符**。这是重叠结构库存，不是可直接删除的收益：顶层也为批量模式提供默认值，而且单问和批量依赖不同 host 能力。误入该 schema 的 `agent_id` 独立 JSON 片段为 **222 字符**；删除属性的实际 schema 差值为 221 字符。[K4]

| 当前 Worker 字符串区块 | 字符 | UTF-8 bytes |
|---|---:|---:|
| managedRunContextTrust | 1,352 | 1,364 |
| planFirstContract | 3,043 | 3,063 |
| planListHygiene | 1,128 | 1,134 |
| scopeCommitment | 780 | 780 |
| mutationDiscipline | 1,022 | 1,026 |
| dispatchRules | 4,676 | 4,682 |
| parallelFirstCollaboration | 2,544 | 2,544 |
| childSteeringRules | 1,336 | 1,344 |
| repoIntelligenceTools | 4,217 | 4,269 |
| handoffRules | 1,145 | 1,147 |

表内不是最终 system prompt 的全部成本，还缺 shared execution guidance、任务/仓库/skills/host 上下文等；也不能把 SA system 与 AMA Worker 无条件相加。AMA 已明确排除 base-system、execution-guidance 等重复 section；相同文件内存在两次 builder 调用不等于一次请求收到两份文本。[K2][K5]

## 1. Todo：只去掉模型不该用的兼容分支，不回退全量覆盖

当前 `todo_update` schema 暴露 `op:init` 与完整 `items`，description 却反复禁止模型使用它。handler 默认 `op=update`；`init` 是独立分支。因而应在 **coding 所有模型出站面共用的纯投影函数** 删除 op/items，并将 id 标为 required；保持原始 registry/handler 接受 SDK 和历史兼容输入。删除描述里的 legacy 教学与每字段 `op="update" only` 前缀。不能直接把 registry 原始 schema 改成 id 必填：registry 会从 schema 提取 requiredParams，`executeTool` 先校验后调用 handler，这会阻断合法 legacy init。[K1][K6]

保留四工具是第一批最小方案。create 是 store 分配 id 的增量插入，update 是状态/字段 patch，get 返回 evaluator/metadata 等完整细节，list 返回列表视图。Codex `update_plan` 是完整 `plan:[{step,status}]`，只有 pending/in_progress/completed，并没有 KodaX 的实体 id、metadata 合并/删除、extension hook、失败/跳过/取消、owner 与 per-item evaluator。强行合并为 Codex 的一项工具会涉及状态协调和 UI/SDK 行为迁移，并非文案优化。[K7][K8][C1]

description 应各自只保留一份调用契约：

- create：增量新增、返回自动 id、默认 pending。字段意义在 schema，不再复写完整 Fields 章节。
- update：现有 id 的 patch/transition；状态语义、metadata merge/null、completion hook 不可删；这些是模型生成正确参数的条件。
- list/get：列表/完整单项的区别；状态有不确定性时刷新，不要求每次行动前读一遍。当前 list 的“BEFORE deciding the next move”与 Worker hygiene 的“非每轮仪式”存在张力，需统一为不确定时读取。[K1][K2]
- 用户语言、何时需要里程碑、一个 owner 一个 in_progress、恢复后复用已有计划、按语义结果更新而非按 Actor 数建行，归 Worker 的短常驻策略。调用级 schema 不需要同一套长教程重复教学。

已有 todo drift/completion/throttle reminders 可以承接边界提醒，不必另建提醒框架。但它们目前主要在 AMA adapter 注入，不能据此删除 SA 仍需要的唯一规则。保留简短初始策略；发现真实偏离后用当前 runtime reminder 纠偏。`todo-throttle-reminder.ts` 的现行正文已经用 todo_create；某些文件注释仍说 init，不能误认为运行时仍教 init。另有 all-terminal 正文携带 `FEATURE_170 v0.7.41` 与 init 反例，可在去 legacy 教学时一并移除版本噪声。[K9]

**测试切面**：纯投影不修改原对象；模型 schema 没有 op/items 且 required id；raw registry/handler 的 init、旧内容兼容仍通过；现代调用与 raw handler 等价；description/search/describe 不重新泄露旧 schema；保留 unknown-id、completion veto、metadata null/浅合并、删除 vs 取消、owner、evaluator 只在实际 transition 执行的回归。现有 `todo-update.test.ts` 已有 init、replacement、metadata、terminal nudge 用例，可增补边界而不是重写所有测试。[K6][K10]

## 2. ask_user_question：先修契约，再决定是否统一输入形状

有两项可立即修正：

1. 顶层 `agent_id` 的说明是 specialist dispatch，不在 ask handler 任何路径读取；应从模型 schema 删除，并确认无相关公共承诺需要迁移。[K4]
2. 当前 top-level `required:['question']` 与“questions 数组优先”不一致。通过 registry 的 questions-only 输入会在 handler 之前因缺 question 被拒绝；已有 ask 单测直接调用 `toolAskUserQuestion`，所以并未验证这个边界。优先让 raw required 约束不阻断 handler 的两种合法输入，补 registry/真实 adapter 契约测试。只改模型投影的 required 还不足以修复 registry 路径。[K4][K6][K11]

不建议本批直接删除单问结构。batch 要求每项 options 非空，走 `ctx.askUserMulti`；单问 select 走 `ctx.askUser`；`kind=input` 走 `ctx.askUserInput`。此外返回分别是 `answers` map 与 `choice/choices`，并有 custom_inputs、expiry default、selection bounds。Codex 一种 questions[] 结构且要求选项，不涵盖 KodaX 的独立自由文本输入合同。把 KodaX 投影成 questions-only 会让只实现 askUser 的独立 host 失效，也会丢 kind=input 能力。[K4][C2]

最小方案是保留双结构，但缩短重复字段说明；用一处规则表达 Other 自动添加/closed choices/推荐 default。**可选的后续统一方案**需先定义 questions item 支持 kind=input，再加 host callback 兼容归一化与返回形状策略；这是产品/API 变更，要独立决定，不能把 1,827/1,582 字符重叠库存直接算作无损可删空间。避免为首轮优化新增“ask_user_question_v2”与旧工具并存，反而增加首轮工具面。

**测试切面**：通过 registry 的 questions-only；单问 select / multi-select / input；只实现 askUser 的独立 host；batch 顶层自定义输入默认值继承；空/取消/expiry；selection min/max；custom input 返回；模型 schema 支持的每种形状都能进入正确 callback。可复用 `ask-user-question.test.ts` 已有 callback 断言，新增执行入口层测试。[K4][K11]

## 3. Spawn/协作：Codex 当前也保留生命周期工具，不能套用旧版单工具印象

Codex 本地当前 v2 同样分别有 spawn_agent、send_message、followup_task、wait_agent、list_agents、interrupt_agent；send_message 不触发新 turn，followup 对 idle actor 启动 turn，wait 是 mailbox 等待。因此“合并 send/followup/interrupt 以更像 Codex”并不符合这个 checkout。Codex v1 的 send_input 是另一套接口，不能混作当前 v2 精简目标。[C3]

KodaX 在此基础上还有 Actor 权限范围、认证转发链、classification、subtree interrupt、分页、shared/worktree 写所有权、provider/model/effort 路由、specialist、evidence refs 与 telemetry。并非每项都有必要常驻教学，但把它们直接删掉会改变能力。第一批保留 schema 功能，仅把 Worker `AGENT STEERING` 的参数签名例子移回 schema：三工具名字、字段以及 idle/running 差异由各 description 承担；Worker 保留“何时发补充证据、何时修改目标、何时停止无用工作”的短规则。[K1][K2]

spawn 的 `quality_strategy` 是可选 telemetry；即使隐藏它不影响 admission，模型生成 provenance 的能力会下降，不能宣称无功能损失。model_hint/provider/model/effort 隐藏也会限制显式跨模型目标。Codex 已按 `expose_spawn_agent_model_overrides` / `expose_agent_type` 投影字段，并避免上下文已有 model catalog 时再次复制；KodaX 可借鉴“只按当前确实不可用的 host 能力投影”，不靠关键词猜测任务不需要什么。[K1][C4]

首批不应新增 generic `agent_control(op,...)`；它需要 discriminated union/错误归因/权限映射与历史兼容，会牺牲当前每操作独立清楚的模型工具契约。只读探索/独占写集、shared edits 已可见无需重复应用、并行验证必须目标稳定、root 负责集成、子任务不越过用户范围，这些是行为策略不是字段说明，要在 Worker 保留。[K2]

**测试切面**：send 不启动 idle；followup 启动 idle 且 running 不加槽；wait 不因普通 progress 唤醒；满槽不新增；permission/mutation classifier 仍看到 concrete target；共享写所有权；exact turn evidence；subtree interrupt 保留身份；host 禁用模型选择时 schema 与 runtime 能力一致。对已有 `agent-collaboration.test.ts` 与 runner-driven contract 测试增补投影断言，不因换文案重做生命周期实现。[K1][K12]

## 4. Worker/repo-intel：删重复路由表，保留唯一的策略规则

当前最大的可审计文字交叉集中于 Worker 的四块：dispatchRules 4,676、parallelFirstCollaboration 2,544、childSteeringRules 1,336、repoIntelligenceTools 4,217 字符。repo-intel 内部就出现“工具目录逐一说明 → WHEN TO PREFER → CHANGE-REVIEW”三段，相同 changed_scope→fanout→diff 顺序还出现在 parallelFirst 和 dispatch objective examples。[K2]

建议建立一个小的源码常量规则表或明确函数所有权，不做动态 prompt 框架：

| 规则种类 | 唯一主位置 | 首轮保留内容 |
|---|---|---|
| 参数、返回、合法状态、side effect | 工具 schema/短 description | 直接调用必需的信息 |
| 何时选择关系、模块、diff 工具 | Worker/SA 共享的短路由策略 | 关系问题→relationship_scan；模块探索→module_context；变更审查→changed_scope→分工→diff；精确代码→read/grep |
| 工具细节、长示例、罕见 recovery | search/describe 的完整文档 | 首轮仅 hint；查询完整合同后直接调用 |
| 权限、任务范围、写所有权、核验责任 | 核心策略 | 必须常驻，不依赖先执行违规动作才补救 |
| 满槽、todo drift、terminal child 结果 | 现有 runtime result/reminder | 真实状态触发，保留稳定 system prefix |

必须同时改一个确定的错配：`buildWorkerStableInstructions()` 无条件带 repo-intel 指导，代码注释承认 off 时工具被剥离、让模型试错后 fallback。SA 的 off 过滤已在 `tool-resolution.ts` 确认；AMA 是否通过传入 excludeTools 达成同样过滤需在完整 runner fixture 断言，不能只信注释。应向 builder 传入已解析的可用能力/工具集合（不是新用户配置）；repo-intel off 时省略该块、保留 read/grep fallback。还要逐项避免指导调用已被角色/host 策略隐藏的工具。不要重引入基于任务关键词的大路由器：短规则让模型判断，host capability 控制实际存在性。[K2][K13]

“完整工具指南移到延迟 description”要与 bridge 方案配套。当前 hint 只替换 description，schema 仍发出；SA search unlock 会重曝原生描述；AMA tools 构建一次；这些不是成熟的跨路径 schema activation。因此本文不建议用“schema 按需”口号掩盖实现缺口。继续上轮结论：复用已有 tool_search 返回完整 schema、tool_call concrete target dispatch/permission，分离“已读说明”与“工具原生可见”。search 后下一轮可直接 bridge 调用，不强制 describe；native activation 也只是另一个可测候选，不天然少一轮。详见同目录 `prompt-injection-codex-pi-2026-10-14.md` 的 KodaX 落地复核。[K14]

**测试切面**：AMA 与 SA 对同一能力集的提示不矛盾；off 不出现被剥离工具名；deferred hint 与 full 文档可达；compaction 后仍有短目录和 bridge 入口；child 使用自己的权限能力集；root/child 不因另一方 unlock 越权；稳定 system 不混入每轮动态容量/缓存时间戳。[K5][K13][K14]

## 5. 系统 prompt：先按真实调用路径去重，再清理过时合同

SA 用 `buildCapabilityContextSections` 组装 system；AMA 将其中 Worker 已拥有的 section 剔除，并分 stable/context，模型 adapter 每次把 `agent.tools` 取 name/description/schema 传出。因而投影应位于 coding 的共用模型表示边界，至少覆盖 SA tool resolution、AMA adapter 的 wireTools、tool_search/describe 输出；不在 `packages/llm` 硬编码 todo，也不改变独立 `packages/agent` 的通用 AgentTool。AMA overrides 早返回可绕过普通 registry 包装，所以只在 `buildAgentToolsFromRegistry` 普通分支投影不完整。[K5][K14]

存在一处值得独立修正的策略冲突：SA `SYSTEM_PROMPT` 的 plan-mode 流程仍教 ask_user_question→set_permission_mode，工具表已有 `exit_plan_mode` 的专门 approval 边界。不能为了保留旧长文本而把冲突当成“多提示更稳”。需要以当前 REPL plan approval 实际路径确认并统一；本文只定位到矛盾，没有执行 UI 验证。[K15]

不建议把所有说明塞入 system 来使工具 description 看起来短：那只是换层、仍产生 token，且未知 host 工具集可能不匹配。也不建议把所有策略移入 tool result：任务范围和写权限必须在首次相关动作之前可见。文字去重要基于同一出站请求的 section inventory，而非文件中搜索到两处同一句就删一处。[K5][K15]

### 空 host inventory 的能力过滤复核

父报告提供了无 AGENTS/空 Git home 的受控 inventory，位于 [kodax-controlled-input-inventory-2026-10-14.json](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/docs/research/kodax-controlled-input-inventory-2026-10-14.json)。对其中 AMA 仍出现 run_skill_script/memory 工具，源码支持不同结论，不能统一视为可以裁剪的冷启动 token：

- **无 host policy 的 AMA builder 有 run_skill_script 过滤缺口**：SA `run-substrate.ts:1151` 无 skillScriptRunner 时删除它；AMA `isManagedToolVisibleForContext` 仅处理 exclude/MCP/workflow/history/host policy，没有对应门禁；handler `skill-script.ts:42` 无 runner 或 executionCwd 会抛 unavailable。`runtime-agent-binding.ts:1165/1257` 只在 hasSkillScripts 时创建 runner，但该 runtime binding 路径同时以 `resolveToolSurface:695` 和 `toolVisibilityPolicy:1222/1343` 排除未允许工具，已有另一层防护。因此不能把空 SDK fixture 的泄漏泛化为所有正式 CLI/remote binding 都出错。仍应在 coding AMA 原语补齐能力判定，以覆盖无额外 policy 的独立 SDK host，并同步 bridge 可发现集合；handler 保留清楚报错。[K16]
- **root memory 通常由 runner 自动绑定**：`startRunnerMemoryRuntime` 在 root 创建 MemorySession，`runner-driven.ts:1340` 安装 recall 与 management callback；不是靠调用者空 context 就能断言缺能力。child 或 memory 初始化失败则 `withoutMemoryIntentTool` 排除 intent。memory_recall 无 binding 时明确返回空结果，属于降级行为；是否隐藏应按完整 runner 最终 context 判定。不能把空 builder fixture 的全部 memory schema 计成正式 root 可以无损删去的收益。[K17]

新增静态验收矩阵：root/child × runner 有/无 skill scripts × memory startup 成功/失败；既检查 tools JSON，也实际调用到 handler 确认不存在“展示但永远 unavailable”的工具。memory 的初始化/持久化不是本轮优化目标，不应为了测首轮而触发真实用户 memory 写入。

## 可实施顺序与验收

| 顺序 | 文件与具体动作 | 必须守住的验收边界 |
|---|---|---|
| P0 | 新增 coding 私有纯 model-tool projection（可邻接 tool-resolution，不做公共框架）；接 SA 出站、AMA wireTools、search/describe 的模型结果；快照原始/模型定义 | 同一工具各模型入口 schema 一致，raw registry、execution permission 与独立 SDK 未变；覆盖 AMA override 分支 |
| P0b | 复用实际 host 能力检查，使 AMA 的 run_skill_script 可见性与 SA 一致；完整 runner fixture 验证 memory 的自动绑定 | 不以空 builder context 误删正式 root memory；native tools、search、bridge 可发现集合一致 |
| P1 | tool-definitions 的 todo 模型投影删除 op/items；短写四工具 description，字段文档留在 schema；同步 Worker 中重复字段教学、throttle 正文版本噪声 | 完整保留增量 id/status/metadata/hook/evaluator/owner 行为；既有 legacy tests 仍有效 |
| P2 | ask schema 删除 agent_id，修 required 与 handler 支持分支不一致；保留双结构和 callbacks | registry questions-only 能执行；三种 host callbacks、答案形状不变；不借优化改 UX |
| P3 | worker-role-prompt 删掉重复参数例子与 repo 路由复述；明确短策略与完整 tool docs 归属；role-prompt 传已知工具能力 | 首次行动必需规则完整；repo off 不教不可用工具；SA/AMA 各有唯一有效规则 |
| P4 | 保持 bridge 方案；search 完整合同和 tool_call 下一轮执行，不再误导必须 describe；分离 read/unlock 与 native expose | 真正减少 tools schema 才计 schema 收益；权限/角色/compaction/child contract 完整 |
| P5 | 按 EVAL_GUIDELINES 做必要的后续受控试验，胜出后才考虑更短 spawn 字段、统一 ask 结构 | 生产 tools 通道、相同 fixtures、独立 raw evidence、第一跳和第二跳成功率及完整任务质量，而非只看压缩率 |

P0 的最小替代是只给 `todo_update` 写专门 pure projector，并在已有出站表 `.map()` 复用；没有必要建设 full/hint/on-demand 可配置泛型系统。P1/P2 可以先独立提交，P3/P4 不与其混成一个无法归因的 A/B。

尚未证实、不能作为结论：短 description 是否降低弱模型 todo/repo-intel 使用率；generic bridge input 与 native 参数约束的实际成功率差；稳定工具集带来的 provider cache 命中收益；ask schema 错配在每个 provider/REPL 路径的用户可见频率；删去具体策略后的全任务工具轮数、质量和总成本。以上需要受控验证；已有源码中的历史 eval 注释只说明为什么曾加入规则，不等于当前候选已通过验证。

## 源码索引

- [K1] [tool-definitions.ts:627](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:627)：spawn/协作 627–887；todo 1400–1640（description、schema 与 handler 绑定）。
- [K2] [worker-role-prompt.ts:103](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:103)：plan 113–156；dispatch 175–236；repo-intel 247–293；handoff 300–306；组合 309–323。
- [K3] [role-prompt.ts:315](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:315)：stable/context 分支 319–350。
- [K4] [tool-definitions.ts:1187](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1187) 与 [ask-user-question.ts:193](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/ask-user-question.ts:193)：batch 193–263、input 269–293、single select 296–354。
- [K5] [runner-driven.ts:1713](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/runner-driven.ts:1713)：section 排除/稳定动态拆分；[role-prompt.ts:319](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:319)。
- [K6] [registry.ts:78](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/registry.ts:78)：requiredParams 提取；执行门禁 469–485；[todo-update.ts:380](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-update.ts:380)：默认 op、init 分支。
- [K7] [todo-create.ts:89](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-create.ts:89)、[todo-get.ts:21](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-get.ts:21)、[todo-list.ts:21](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-list.ts:21)：执行/返回 DTO。
- [K8] [types/todo.ts:13](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/types/todo.ts:13)：状态和 TodoItem；[index.ts:267](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/index.ts:267)：公开类型；[types.ts:721](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/types.ts:721)：UI/SDK onTodoUpdate；[agent-chain.ts:512](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:512)：真实 evaluator wrapper。
- [K9] [llm-adapter.ts:426](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:426)：真实 reminder 注入；[todo-drift-reminder.ts:303](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/todo-drift-reminder.ts:303)；[todo-throttle-reminder.ts:159](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/todo-throttle-reminder.ts:159)：现行正文与旧注释区别。
- [K10] [todo-update.test.ts:256](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-update.test.ts:256)：init/replace 测试；583–657 patch metadata；680–771 nudge；[todo-update.ts:549](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/todo-update.ts:549)：before-complete hook。
- [K11] [ask-user-question.test.ts:2](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/ask-user-question.test.ts:2)：直接 import handler；238、266、279、297 为 batch handler 测试，非 registry 入口。
- [K12] [agent-collaboration.ts:1](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/agent-collaboration.ts:1) 与 [agent-collaboration.test.ts:1](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/agent-collaboration.test.ts:1)：协作实现与现有测试切面；工具契约详细行号见 K1。
- [K13] [tool-resolution.ts:103](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-resolution.ts:103)：off 过滤；[worker-role-prompt.ts:247](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:247)：无条件指导的明确注释/实际数组。
- [K14] [run-substrate.ts:1768](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/run-substrate.ts:1768)：SA resolve，1822 exposure；[agent-chain.ts:374](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:374)：override 早返回、409–422 静态 hint；[llm-adapter.ts:491](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)：模型工具表；[tool-search.ts:97](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:97)：完整结果；[tool-dispatch.ts:450](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-dispatch.ts:450)：bridge target 执行/权限。
- [K15] [system.ts:98](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/prompts/system.ts:98)：旧 plan-mode 工作流；[tool-definitions.ts:1381](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1381)：exit_plan_mode 契约。
- [K16] [agent-chain.ts:106](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:106)：AMA host 过滤；[run-substrate.ts:1151](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/run-substrate.ts:1151)：SA scripts 过滤；[skill-script.ts:42](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/skill-script.ts:42)：执行门槛；[runtime-agent-binding.ts:1165](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/src/runtime-agent-binding.ts:1165)：conditional runner，另一分支 1257；695/1222/1343 能力表与 visibility policy 的防护。
- [K17] [runner-driven.ts:671](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/runner-driven.ts:671)：intent 排除；686–825 root memory 启动/child 分支/失败降级；1005 调用；1340 callback 绑定；[memory-recall.ts:81](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/memory-recall.ts:81)：缺 binding 空结果；[memory-intent.ts:1000](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/memory-intent.ts:1000)：management/legacy 退路。
- [C1] [plan_spec.rs:7](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/plan_spec.rs:7)：Codex update_plan 完整输入和三种状态。
- [C2] [request_user_input_spec.rs:15](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/request_user_input_spec.rs:15)：统一 questions schema；122–141 normalize 要求 options、自动 Other；[request_user_input.rs:69](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/request_user_input.rs:69)：root/mode 限制。
- [C3] [multi_agents_spec.rs:204](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:204)：v2 send/followup/wait/list/interrupt；v1 send_input 在 166–202。
- [C4] [multi_agents_spec.rs:108](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:108)：model catalog 避免重发、agent_type/model/effort capability 投影。
