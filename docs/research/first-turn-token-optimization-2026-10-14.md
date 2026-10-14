# KodaX 首轮 token 为什么偏多，应该如何优化？

后续已完成三个子 Agent 的交叉审计，关于规则承重、DSH 注入方式及 bridge/native activation 的最终设计建议见 [第二轮方案](prompt-injection-design-kodax-2026-10-14.md)。本文保留第一轮成本分析；计数脚本已补齐无 workflow host 时的 SA 过滤。

结论摘要：当前最明确的改进点是 **内置工具的常驻 schema/教学文本，以及 managed Worker 的重复行为说明**。先精简这些内容、统一 SA/AMA 的模型可见投影，再扩展已有按需工具机制。不要以删除用户规则、退化成四工具代理、整体引入 Code Mode 或缓存保温作为第一步。

## 1. 范围与口径

调研日期为 2026-10-14，基于以下本地 checkout，未更新远程仓库：

| 仓库 | HEAD | 独立源码笔记 |
|---|---|---|
| KodaX 当前 worktree | `bd4479d59cab3d082f07c2d34681fff198d82fa0` | 本文 |
| deepseek-harness | `d743267388641bc76f17c45ce8b4c231aed1d32c` | [笔记](first-turn-tokens-deepseek-harness.md) |
| codex | `c22a06c18070c3e33bd2648c7210a00a2a9f6f80` | [笔记](first-turn-tokens-codex.md) |
| pi | `3daa20280f6a7c7cbe0935680c9a38fdc3863005` | [笔记](first-turn-tokens-pi.md) |

本文把“首轮”首先定义为新会话第一次 provider 请求。用户第一次任务的全部请求、子 Agent 请求和输出另计。输入体积、非缓存计费量、缓存读写、输出/推理 token、首响应延迟是不同指标，不能用一个 UI 数字代替。KodaX 已把 Anthropic 的普通输入与缓存读写合为内部 `inputTokens`；不能再无条件加一次缓存量。[Anthropic usage](../../packages/llm/src/providers/anthropic.ts:103)、[OpenAI usage](../../packages/llm/src/providers/openai.ts:174)。

完成了源码阅读和一次离线 builder 计数，没有调用模型、运行付费 eval 或修改产品实现。数字使用 KodaX 自己的 provider-neutral 估算器，ASCII 大致按四字符一个 token，**不是 BPE 精确计数、API usage 或已验证的优化收益**。[估算器](../../packages/agent/src/tokenizer.ts:36)。

## 2. KodaX 的开销：先看实际构造的对象

离线场景使用当前仓库、空的隔离全局配置目录，无 skills/MCP/外部 host tools、会话历史、选中 skill、memory pack、权限附加段和自动 repo-intelligence preturn 内容。SA 指定 full repo-intel 工具模式，移除当前场景未激活的 memory/history/skill-script 工具，并应用无 workflow host 时的最终过滤；Worker 使用无可选 host 的实际 `buildRunnerAgentChain`。系统提示通过真实 builder 生成，Worker stable/context 分别通过生产 `createRolePrompt` 生成。这是**可定位成本的组件基线，不是完整 CLI 首请求抓包**。[计数数据](first-turn-token-audit-2026-10-14.json)、[可复跑脚本](first-turn-token-audit-2026-10-14.ts)、[SA 最终 host 过滤](../../packages/coding/src/agent-runtime/run-substrate.ts:1783)。

| 成分 | 普通 SA | Managed Worker / AMA |
|---|---:|---:|
| 模型可见工具数量 | 55 | 59 |
| 工具定义估算 token | 16,747 | 17,922 |
| 系统提示估算 token | 4,924 | 8,816 |
| 独立动态 role context | 不单列 | 604 |
| 上述组件合计 | 21,671 | 27,342 |

第二轮复跑修正了 SA 初稿漏掉的 `run_workflow` host 过滤（工具量减少 493 估算 token）；新生成的调研文件同时改变了 Git 状态快照，因此 SA system / Worker dynamic context 比初稿增加 131。后者是工作区状态变化，非产品 prompt 回退。表与 JSON 记录同一次复跑；稳定 Worker 指令及其工具计数未变。

表中不含真实用户输入及 provider 消息/工具协议包装，也不含前述排除项。真实配置、任务、provider 和 host 过滤会改变结果。Worker 的稳定规则单体为 24,118 字符、约 6,076 估算 token；它已经包含在 8,816 中，不能重复相加。项目 AGENTS 包装为约 1,113、内存规则约 696、目录快照约 316，说明这个场景下即使没有大量外部能力，固定开销也已经显著。[计数数据](first-turn-token-audit-2026-10-14.json)、[Worker 稳定规则](../../packages/coding/src/agents/worker-role-prompt.ts:108)、[SA 组装](../../packages/coding/src/prompts/capability-sections.ts:93)。

59 个 Worker 工具中，顶层 description 合计约 7,995，参数 schema 合计约 9,076；后者包含字段 description，不是纯粹不可压缩的结构。两项之外还有名称和 JSON 包装以及逐项取整。[计数数据](first-turn-token-audit-2026-10-14.json)。

| 较大的常驻工具 | 总估算 token | 顶层 description | 参数 schema |
|---|---:|---:|---:|
| `todo_update` | 2,234 | 1,070 | 1,135 |
| `ask_user_question` | 1,319 | 165 | 1,139 |
| `todo_create` | 1,031 | 705 | 302 |
| `spawn_agent` | 967 | 175 | 779 |
| `multi_edit` | 660 | 491 | 150 |
| `grep` | 505 | 32 | 463 |

仅前四项就是 5,551，约占这个工具集合的 31%。四个 todo 工具合计 3,901。优先处理这些内容，比先移除 316 token 的目录树更有针对性；但精简幅度仍须按保留下来的行为契约确定。[计数数据](first-turn-token-audit-2026-10-14.json)、[todo_update](../../packages/coding/src/tools/tool-definitions.ts:1400)、[ask_user_question](../../packages/coding/src/tools/tool-definitions.ts:1187)、[todo_create](../../packages/coding/src/tools/tool-definitions.ts:1536)。

### 2.1 工具“可执行”和“首轮必须完整展示”混在一起

SA 默认从注册表收集工具，再做 runtime、权限/可见性及特殊能力过滤。AMA 也从 registry 减去 exclude 集合构建工具。这个做法解决过新工具漏接线的问题，但也让新增普通工具自然进入常驻模型输入。应保留完整执行注册表，另行决定如何展示，不能把已修复的漏接线问题重新引入。[SA 候选集合](../../packages/coding/src/agent-runtime/run-substrate.ts:1143)、[AMA 构造](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:351)、[排除表设计背景](../../packages/coding/src/task-engine/_internal/managed-task/role-exclude.ts:17)。

KodaX 的延迟机制目前首先是 **description hint 替换**：完整参数 schema 仍常驻。SA 搜索后会恢复完整 description；AMA 的工具集合在构建后保持静态，完整教学来自 `tool_search` 返回结果。[SA 投影](../../packages/coding/src/agent-runtime/tool-resolution.ts:174)、[AMA 投影](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:409)、[tool_search](../../packages/coding/src/tools/tool-search.ts:180)。

离线 Worker 中现有 10 个 deferred 工具，hint + schema 合计仅 1,557；若把这十项完全移出初始工具表，**毛节省上限**就是 1,557，还没有扣除发现目录和后续调用成本。当前 hint 替换已经把同一个 Worker 工具集合从约 19,551 降到 17,922，不能把已实现的这部分收益再次算作新方案收益。[计数数据](first-turn-token-audit-2026-10-14.json)。

SA 已有 `tool_search + tool_describe + tool_call` 桥接和 `planToolExposure`，不应另造一套。问题是它主要响应窗口压力，只对现有 deferred 集合工作；许多大工具在 protected core 中。此次 128K/256K 场景选择 `report_only`，没有进一步减少 schema。AMA adapter 直接把 `agent.tools` 映射为 wire tools，没有走同一 exposure planner。**只修改 SA，默认 REPL 的 AMA 路径可能完全不受益。**[planner](../../packages/coding/src/agent-runtime/tool-exposure-planner.ts:82)、[SA 接线](../../packages/coding/src/agent-runtime/run-substrate.ts:1802)、[AMA wire](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)、[REPL 默认 AMA](../../packages/repl/src/interactive/repl.ts:655)。

### 2.2 重复教学与历史接口占用了常驻预算

Worker 提示里详细教 todo 字段、状态、增删、刷新与去重；工具 description 又教一遍；schema 字段再解释一次。协作和 repo-intelligence 也同时有全局长篇指导和工具局部说明。重复的内容应划定唯一归属：全局讲决策原则，工具讲调用契约，字段只讲局部语义。[Worker todo 指导](../../packages/coding/src/agents/worker-role-prompt.ts:121)、[todo_update 字段](../../packages/coding/src/tools/tool-definitions.ts:1440)、[todo_create](../../packages/coding/src/tools/tool-definitions.ts:1536)。

最具体的例子是 `todo_update` 的 `op=init` 和嵌套 `items`：描述明确说这是 legacy / runner-only、LLM 不应调用，却把整个结构及多段警告发给 LLM。建议验证内部调用方后，将这部分从**模型投影**移除，保留 handler/SDK 的兼容路径；不是直接删掉底层功能。[todo_update](../../packages/coding/src/tools/tool-definitions.ts:1400)。

`ask_user_question` 同时描述旧单题入口和 `questions[]` 多题入口，包含大量相同选项字段。第一阶段只精简重复文字、保留契约；模型仅展示一种标准形态需要单独验证单题、多题、输入、默认值和 Runtime 兼容，不能在 token 精简中顺手破坏接口。[ask_user_question](../../packages/coding/src/tools/tool-definitions.ts:1187)。

动态 role context 又同时包含 `decisionSummary`、`buildWorkerRoutingContext` 和任务 contract；这是具体去重候选，但必须检查各自承载的唯一验证要求。stable 模式已经排除了 SA base prompt 和重复 execution-guidance，所以不能把 SA base 与 Worker 指令当成同时注入的双份开销。[role prompt](../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:100)、[stable/context 分支](../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:319)、[AMA 过滤](../../packages/coding/src/task-engine/runner-driven.ts:1725)。

### 2.3 已经做好的优化不要重新设计

- **Skills 已经是目录/正文分离**：首次格式化 name + argument hint + description，显式 invocation 单独展开。但 formatter 没有目录总预算，说明很多时仍线性增长；Runtime deployment 路径还使用另一套较短 formatter，统计需区分入口。[通用目录](../../packages/agent/src/capabilities/skills/skill-registry.ts:24)、[Runtime 目录](../../src/runtime-agent-binding.ts:734)、[显式正文](../../packages/coding/src/prompts/capability-sections.ts:324)。
- **MCP 已是小目录 + 搜索/描述/调用入口**：prompt manifest 预算为 320 估算 token，依次退化为 exact IDs、完整名称、服务器摘要、fleet 摘要，没有默认把远端全部 schema 放进系统提示。因此一般不应把“MCP tool search”列为本次新架构主线；外部 host tools 的直接注册要另计。[MCP 预算](../../packages/agent/src/capabilities/mcp/provider.ts:37)、[目录渲染](../../packages/agent/src/capabilities/mcp/provider.ts:251)。
- **Memory 正文按需**：memory pack 最多 5 个 hints，不带 snippets，当前 memory rules 只有约 696 估算 token。`capability-sections.ts` 中旧注释所称“约 3.1K 规则不能压缩”不代表当前规则体；也不能用历史模型实验直接判定今天的改动。[当前规则](../../packages/coding/src/prompts/memory-rules.ts:1)、[memory pack](../../packages/coding/src/prompts/capability-sections.ts:347)、[旧实验重验要求](../../benchmark/EVAL_GUIDELINES.md:269)。
- **项目指令已经按祖先链加载**：全局、project-root→cwd、`.kodax/AGENTS.md`，只读 AGENTS，按路径避免重复；没有目录总长度保护或内容等价去重。不应误称当前在递归读取全仓库 AGENTS。[loader](../../packages/coding/src/context/agents-loader.ts:134)。
- **AMA 已分离 stable/context**：首次 managed context 有 32,000 字符上限，动态 delta 有 4,000 上限。原始 context 存在历史里仍会占后续输入，只是不再重复追加同一内容。[context envelope](../../packages/coding/src/task-engine/_internal/managed-task/managed-run-context.ts:3)、[分段组装](../../packages/coding/src/task-engine/_internal/managed-task/role-prompts.ts:142)。

### 2.4 自动仓库上下文是另外一个可变成本项

新会话默认考虑 repo overview，review/bugfix/edit/refactor 还可能加入 changed scope、preturn、module、impact 等。源码最后拼接多种来源；与单独 project snapshot 可能有语义重叠，需要抓实际渲染内容后判断，不能仅看到函数名就宣称逐字重复。此项未计入上面的组件基线。[自动上下文](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:212)、[拼接处](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:380)、[AMA 注入](../../packages/coding/src/task-engine/runner-driven.ts:1860)。

建议从“默认给项目名/根目录/必要状态；探索时可取完整结构”评估，但保留影响操作决策的运行时真值。源码有专门推广 pull tools 的行为教学，删除自动上下文和压缩教学应分开比较，否则不能解释回退来源。[Worker repo-intel 指导](../../packages/coding/src/agents/worker-role-prompt.ts:252)。

## 3. 三个项目真正值得借鉴的是什么

| 项目 | 当前实现中的价值 | 限定与代价 | 对 KodaX 的判断 |
|---|---|---|---|
| deepseek-harness | 短 persona；能力各自贡献指导；skills 简介默认 500 字符；AGENTS 作用域加载及同组内容去重 | 默认 native 仍全量发送可见 schema；PTC 把完整 SDK 移到 system；64 KiB 指令裁剪有内容损失 | 学指导归属与作用域去重，不把“一句话 persona”误当请求总量 |
| codex | skills 有预算、确定性排序、路径别名与去重；支持模型可用的延迟工具发现 | 多项能力依赖模型目录/实验开关/Responses Lite；Code Mode 常驻定义仍占输入；基础指令也不必然很短 | 学有预算的可发现目录与单一展示投影，不复制整个协议栈 |
| pi | 默认四个核心内置工具；仅对声明工具生成规则并去重；当前 MCP 默认走 codemode 延迟 schema | AGENTS 仍全文，skills 无总预算；配置扩展会增加能力与内容；搜索 tokenizer 有语言限制 | 学短工具说明、能力感知指导；保留 KodaX 的结构化编辑、协作与 repo-intel 优势 |

上表的逐条源码证据及默认/可选边界分别在 [deepseek-harness 笔记](first-turn-tokens-deepseek-harness.md)、[Codex 笔记](first-turn-tokens-codex.md)、[pi 笔记](first-turn-tokens-pi.md)。不能据此给三个产品排首轮 token 大小榜：没有固定相同任务、配置、模型和实际请求计数。

几个容易错误照搬的地方：

1. Codex skills 默认预算是可用窗口的 2%，未知窗口回退 8000 字符；显式配置上限为 10000 估算 token。对大窗口模型直接照搬比例未必够小，KodaX 可先用一个经基线验证的内部预算，不增加用户配置。[Codex render](C:/Works/PubProj/codex/codex-rs/ext/skills/src/render.rs:132)。
2. Codex 的 4 KiB deferred namespace 摘要属于条件特性；关闭该特性时，旧来源描述路径上限是 512 KiB。CodeMode flag 默认关闭也不代表当前模型默认 Direct：模型目录可以指定 `code_mode_only`。[Codex 工具条件笔记](first-turn-tokens-codex.md)。
3. pi 当前 MCP 默认 exposure 是 codemode；有配置 MCP 才自动启用相应 discovery。没有 MCP 的“四工具默认”与带很多扩展的 pi 不能混比。[pi MCP](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:154)。
4. deepseek-harness PTC 和 Codex Code Mode 都可能只是把 schema 换个位置。要计算 **system + descriptions + schema + SDK 声明总和**，不能只数原生 tools 数量。[deepseek-harness PTC 笔记](first-turn-tokens-deepseek-harness.md)、[Codex Code Mode](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1011)。
5. 缓存保温或 prefix cache 不缩小第一次冷请求。KodaX 已有 cache diagnostics 和 affinity，先复用；不要为解决首轮常驻体积再加入额外保温请求。[KodaX diagnostics](../../packages/coding/src/agent-runtime/prompt-cache-diagnostics.ts:609)、[pi cache warming](C:/Works/PubProj/pi/packages/coding-agent/src/core/cache-warmer.ts:344)。

## 4. 建议的最小方案与实施顺序

以下为设计建议，尚未实施或宣称行为等价。

### 第一阶段：分账与常驻文本精简

**A. 完善现有诊断，不新增独立遥测系统。**

在现有 `onContextBudgetSnapshot` / `onPromptCacheDiagnostics` 上区分：root/child、SA/AMA、第一请求、tool count、各 section、各 tool 顶层描述/参数 schema、显式 skill 正文和首次动态上下文。应用层组件账单再与 provider 最终序列化请求核对，记录估算与实际 usage 的差异。保留 hash/长度等元数据，默认不把 AGENTS、prompt 或凭据落入日志。[预算接口](../../packages/coding/src/agent-runtime/context-budget.ts:14)、[AMA 诊断](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:608)、[cache diagnostics](../../packages/coding/src/agent-runtime/prompt-cache-diagnostics.ts:609)。

**B. 先改 todo 与通用工具的文本归属。**

- Worker 保留何时需要计划、一个进行中里程碑、完成即更新、续跑不重建等原则。
- `todo_create/update/get/list` 的局部行为只在工具契约出现一次，删掉全局字段教程与重复例子。
- 缩短字段 description，但保留删除/取消、metadata merge/null、activeForm 必填、错误恢复等真实语义。
- 对明确 runner-only 的 `init/items` 做单独模型投影，保持 SDK/handler 兼容。先追调用方和补契约测试，再改变模型面。
- `ask_user_question` 第一批只做说明去重；统一单/多题形态放到有必要时再做。

这些候选来自具体重复和计数，优先级高于只压缩已经 hint 化的 web/repo 工具；不应机械地给所有工具截前 200 字符。[对应源码与计数](first-turn-token-audit-2026-10-14.json)、[todo API](../../packages/coding/src/tools/tool-definitions.ts:1400)。

**C. 精简 Worker 全局指导，但保留治理语义。**

压缩重复协作解释、todo 教程、重复 cross-platform/scratch 教学；只为当前真实可用能力附加对应 guidance。权限、用户授权、真实完成、精确编辑、关键协作生命周期和工具失败恢复仍需要明确。不要把所有原则下放为“等第一次犯错再提示”，也不要借 token 优化撤销并行协作策略。[Worker](../../packages/coding/src/agents/worker-role-prompt.ts:108)、[共享 workspace discipline](../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:197)。

这一步的验收是：输入确实变短，语义不变量仍可解释，两个路径同时受益；当前不承诺固定百分比。

### 第二阶段：复用桥接，按需展示完整工具契约

保留注册表/执行权限为真实能力集合；把模型展示视为该集合的一次稳定投影。优先复用 `tool_search / tool_describe / tool_call` 和 exposure planner，在 SA、AMA、child 使用同一策略。按需展示是“何时给模型完整 schema”，不能改变实际权限或让 bridge 绕过 guardrail。[现有 bridge](../../packages/coding/src/tools/tool-bridge.ts:56)、[AMA bridge](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:154)。

常用的 read/edit/write/bash/grep/glob、必要进度/交互，以及 AMA 核心协作工具继续直接可用。候选延迟族包括冷门 LSP 操作、特殊维护/Goal/工作流等，但每族要用实际调用分布和到达率决定，不能先固定“只保留 4 个”或“只保留 12 个”。比如九个 LSP 工具在当前集合约 1,590 token，是可以单独评估的一族。[计数数据](first-turn-token-audit-2026-10-14.json)。

首轮保留短的能力族入口及发现机制；搜索结果必须带足调用契约，尽可能做到“一次发现即可调用”，不要强制每个调用都经历 search→describe→call 三跳。当前 `tool_search` 已返回完整 schema，`tool_describe` 可用于已知名称或补充读取。[search 返回形态](../../packages/coding/src/tools/tool-search.ts:98)。

必须同步解决的接线点：

- 当前 keyword search 只索引 `DEFERRED_TOOL_HINTS`，新增被隐藏的族必须进入同一个可发现目录，不能只从 tools[] 删除。[搜索范围](../../packages/coding/src/tools/tool-search.ts:90)。
- 目录应来自当前获准且可执行的集合；`select:NAME` 和普通关键字检索都要遵守 runtime 绑定/可见性，不应向模型发布一个执行时必然不存在的能力。[当前 select 解析](../../packages/coding/src/tools/tool-search.ts:73)、[runtime 可见性](../../packages/coding/src/agent-runtime/tool-resolution.ts:92)。
- 中文任务必须能发现工具；可先用确定性族名/中英文简短触发词，不引入一次额外 LLM 分类器。
- bridge 执行要保留工具目标的许可判定、取消、并发/写冲突规则、错误结构和输出过滤；它们属于原执行路径，不需要第二套执行器。[现有桥接目标](../../packages/coding/src/tools/tool-bridge.ts:16)、[AMA target dispatch](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:270)。
- 采用便携 bridge 可避免每次发现都改写顶层 tools 前缀；若为减少后续调用开销选择激活 native schema，则必须测完整任务的额外请求与 cache miss，不要默认二者等价。当前 SA/AMA 的 unlock 行为本就不同，统一时要明确取舍。[SA unlock](../../packages/coding/src/agent-runtime/tool-resolution.ts:170)、[AMA 静态工具](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:414)。

### 第三阶段：目录与可变上下文预算

Skills 先压缩重复前导说明、规范化空白并给 description/目录设可观测预算；保留名称和足够触发语义。目录确实大到预算不够时，再通过现有 skill 能力扩展“列举/查找”入口。明确点名的技能、用户规则和当前已激活 skill 正文不能因相关性猜测而静默丢弃。KodaX 目录原本不含每条长绝对路径，Codex 的路径别名不是这里的首要收益。[KodaX 目录](../../packages/agent/src/capabilities/skills/skill-registry.ts:24)。

AGENTS 优先做同来源/同作用域的规范化身份去重和大文件诊断，保持顺序和来源；跨作用域相同文字未必可安全合并，因为相对路径和优先级可能不同。超长规则的处理应有显式产品契约和可见提示，不用任务关键词筛掉“看似无关”的约束。deepseek-harness/Codex 的截断机制可以参考边界，不构成 KodaX 无损省 token 的保证。[当前 loader](../../packages/coding/src/context/agents-loader.ts:134)、[deepseek-harness 去重/预算笔记](first-turn-tokens-deepseek-harness.md)、[Codex AGENTS 笔记](first-turn-tokens-codex.md)。

自动仓库结构要去掉已确认的重复证据；结构细节优先由 repo-overview/module 等现有 pull tools 获取。把能力可用性与结构正文分开，保留当前目录、权限、必要 Git 状态等事实。大仓库 first-turn preturn 需要独立计数；本次没有把其未测成本补成猜测值。[自动上下文](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:212)。

### 缓存工作单列

SA 的 snapshot 排序先插 environment/session，再插部分稳定能力与项目规则，session scratch 等变化可能影响可复用前缀；AMA 已做更明确的 stable/context 分离。未来可对齐稳定排序、静态在前及动态状态变化才追加，但这改善的是热请求复用，不作为冷启动输入缩减指标。[section 顺序](../../packages/coding/src/prompts/sections.ts:56)、[AMA 分离](../../packages/coding/src/task-engine/runner-driven.ts:1739)。

## 5. 验证方式与工程边界

遵守 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)，当前仅完成 Layer 1 离线结构审计；没有足够证据给出 `recommend-ship`。建议进入实现时逐批验证，而非同时改变 schema、Worker 策略、skills 和自动上下文。

| 层次 | 要回答的问题 | 最小证据 |
|---|---|---|
| Layer 1，零模型成本 | 确实减少了什么；默认 AMA 是否接线；能力是否仍可达 | 精确请求组件字节/估算对比；SA/AMA/child 契约测试；schema shape、权限和查询边界 |
| Layer 2，有预算的单次请求 | 短说明是否影响下一步正确决策 | 固定真实 production system/tools/history；代表性案例与 provider；捕获一次响应，不执行其工具 |
| Layer 3，必要时 | 发现→调用是否抵消收益或降低到达率 | 固定两轮输入与注入的工具返回；同时看两轮 input/output、工具选取、参数与延迟 |

首批纯文字精简可按指南从两个有代表性的 provider、两个有区分度案例、每 arm 1–2 次 pilot 开始；只有案例有效且证据不足才增加样本。若改变 schema 可见面或隐藏工具，就不能再宣称只是 behavioral-neutral 文本整理。正式付费实验需先冻结模型/route、calls/rounds/output/total token/美元预算、raw dump 和盲化评审方式；本文不是已经冻结或执行的实验计划。[指南](../../benchmark/EVAL_GUIDELINES.md:113)。

关键场景包括简单问答不建 todo、非平凡任务正确建/更新计划、续跑不重复计划、多题/输入提问、中文工具发现、低频工具可达、并行协作回收、编辑失败恢复、权限模式、显式 skills 只展开一次。判断总体产品价值，要同时比较首请求大小与固定短流程总量，不能为省 1000 首轮 token 多花一次完整的大请求而仍宣称成功。

不新增 LLM 任务路由器、不引入笼统“轻量模式”配置、不把 Agent 层依赖倒置到 Coding。工具教学和展示策略继续留在 `packages/coding`，通用 skills/MCP 目录留在其现有 Agent 能力模块，wire serializer 和 usage 真值继续由 `packages/llm` 负责。以上是沿用现有边界的实施建议。[项目分层要求](../../AGENTS.md)、[现有 builder 归属](../../packages/coding/src/prompts/capability-sections.ts:27)。

## 6. 未证实与待决定事项

- 尚未获取用户所见那一次大 token 请求的 provider/model、SA/AMA、skills 目录、实际 usage 和缓存口径；本文能定位固定成本，却不能断言解释了某个截图/账单的全部差额。
- 没有对三个参考项目跑等价请求，不能宣称其实际首轮比 KodaX 少多少。
- 文字精简后的模型行为、完整 schema 延迟后的搜索召回/中文到达率与净成本尚未评测。
- 本文优先建议“分账 + todo/工具教学与 Worker 去重”。更大规模的工具延迟应作为后续独立变更，依据实际基线决定扩展范围。
- AGENTS/skills 超预算时的用户体验需要明确产品决策；不能直接复制别人的静默省略规则。

## 7. 复跑离线计数

在安装匹配 lockfile 的 workspace dependencies 后，从仓库根执行：

```powershell
node node_modules/vite-node/vite-node.mjs --config vitest.config.ts docs/research/first-turn-token-audit-2026-10-14.ts
```

脚本调用源代码 builder、建立空的临时全局配置目录，不执行工具或 provider 请求。JSON 保存的是聚合计数，不是 eval raw output。Git 状态、目录快照和 checkout 变化会导致小幅数值变化；修改 prompt 后必须重新记录真实 commit，不能将本报告固定基线标签误作新版本结果。[脚本](first-turn-token-audit-2026-10-14.ts)、[基线](first-turn-token-audit-2026-10-14.json)。
