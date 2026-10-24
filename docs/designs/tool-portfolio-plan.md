# KodaX 全盘工具与注入方案

2026-10-24；整体审计和分阶段方案。**A/B 的 opt-in SDK 装配已实现，Coding 仍默认；Script、Session/UI 切换未实现，本轮没有运行真实模型。**
本文是当前取舍与验证顺序的总入口，优先于旧文档中的候选优先级；历史失败、抓包和实现记录仍保留。
用户曾提出 Goal 仅由 `/goal` 和 SDK 启动，随后要求重新全盘考虑，故该限制**不是已接受设计**。
已对齐的产品选择：单一切换入口 **Agent / Coding / Script**，**Coding 原生默认**。
Script 是 Coding 能力的程序化调用预设，名字无需 Coding 前缀；本文件与[78 项分配表](tool-mode-allocation.md)
定义完整目标；当前只落地文末所列 A/B 范围，不能把 Script 或三选项 UI 当作已存在功能。

## 1. 总判断

优化对象是完整任务的能力与效率，不是工具数量排行榜。应同时审计四件事：
底层能力是否独特、独立入口是否值得、何时提供契约、结果如何进入后续上下文。
“底层仍被引用”“别家没有同名工具”“调用频率低”都不足以单独决定去留。

确定的架构方向：**一个权威能力目录 + 三个用户预设 + 默认原生调用 + 可选程序化调用**。
保持 AMA 规划、派发、等待、恢复和完成策略。不要复制 Agent/Coding/Script 三套工具数组，
不要添加模型任务分类器、自动模式切换或为了隐藏工具而新增发现步骤。

当前没有证明可无损移除数千 token 的普通 Coding 默认菜单。也不应把当前 54 项永久冻结：
纯重复应退役，有价值服务可以换入口，便利入口要证明全任务收益；不能让兼容层成为永久保留重复实现的借口。

## 2. 事实基线与成本

源码：KodaX HEAD `8d3f05e0` 加工作区；Codex `970111f6cb`；DSH `22ddee3792`；pi `136b87e8a`。
当前编译后的 registry 与逐项清单对账：**78 个内置注册；完整 Host 当前 54 个 native**。
78 = 54 + 已退出本地默认入口的 code_search + 5 兼容别名 + 18 条件能力。
动态第三方/Host 工具另计；不是只有这 78 项才能被装配。

当前真实序列化夹具 `kodax-first-turn-wire-kbrPz0`：OpenAI 模型字段估算 20,028，工具 12,291；
Anthropic 19,675，工具 11,909。估算不是 BPE、API 账单或 UI 上下文读数。

| 当前完整 Host 的家族 | native 数 | OpenAI 单项估算合计 |
| --- | ---: | ---: |
| 文件/执行/搜索/undo/anchor | 8 | 1,823 |
| Git 概览、差异与隔离 | 5 | 874 |
| 交互、Todo、Goal、Plan 审批 | 8 | 2,700 |
| AMA 协作与角色目录 | 8 | 2,121 |
| Repo 结构分析 | 7 | 1,434 |
| LSP | 8 | 1,152 |
| 记忆、历史、知识、网络、发现 | 10 | 2,190 |

单项取整合计 12,294，整数组为 12,291，差 3 是舍入。Repo/LSP 的 2,586 是能力成本，
不是已经证实可删除的浪费，也不是与 Codex 差额的完整因果归因。

| 同口径历史参考 | 全模型输入估算 | 与当前 KodaX OpenAI 差 |
| --- | ---: | ---: |
| Codex Sol / Only | 17,048 | 2,980 |
| DSH Standard | 9,325 | 10,703 |
| DSH PTC | 11,760 | 8,268 |

参考抓包分别固定旧 pin `deede7201d` / `687f282e86`，不是上述最新本地源码的重抓。
Codex 差额主要在工具表示（+3,020），其余输入反而相近（-40）。DSH 的差距还包含不同的
系统说明和能力构成；不能删 AMA 契约来冒充等能力追平。方法与原始证据见
[成本账本](tool-surface-cost-attribution.md)、[Windows 对照](first-turn-windows-comparison.md)。

## 3. 历史为什么增加这些工具

| 历史问题 | 可核对来源 | 今天的判断 |
| --- | --- | --- |
| 工具手工装配漏项 | `role-exclude.ts:15–26` 记载漏掉 17 项 | 统一 registry 必须保留；模式不是复制白名单 |
| 本地检索与 durable anchors | `ba5ae92a`，2026-04-03 | local code_search 从开始就是字面匹配/固定 score；无独占排名或记忆写入职责 |
| edit 失败后整文件覆写 | `c2657091`，2026-04-04 | anchor 曾改善恢复；普通恢复现已迁移。安全事务不是 anchor 独占 |
| 计划不可见、增量任务被全表 init 覆盖 | `9e73ac53`、`54324aa4` | Todo 增量 ID/PATCH/事件仍有价值，不能退回整表覆盖 |
| 长目标与跨轮预算 | `2c50c580`，2026-05-25 | Goal 与 Todo 不同；创建入口和执行期工具要一起设计 |
| 仓库证据聚合、后来内置 full/light | `fa75092f`、`51fb53d3` | 底层索引不等于每个入口必需；旧“社区版没有 RepoIntel”前提失效 |
| 编译器导航与非文本关系 | `8c02b2bc`，2026-06-09 | LSP 语义价值存在；grep 不等价编译器引用 |
| 循环依赖查询 | `e4c05f82`，2026-05-31 | SCC 算法有价值；输出真实环见证仍有质量风险 |
| 子任务身份、恢复、错误唤醒 | `c34260aa`、F273 | Actor/Turn 与事件等待仍必要，轮询或重建子 Agent 不等价 |
| Skill 误匹配/错误执行路径 | `557ae437`，2026-05-20 | 具名加载、参数展开、准入不是普通 read |
| 产品身份混淆 | `862b80b8`，2026-06-08 | manual 知识有价值；专用入口是否常驻另判 |
| 压缩后历史、记忆治理 | `6debae56`、`1dbea5e1`、`b6b062d2` | 会话边界、revision、授权与恢复不能退成任意文件读写 |
| 声明增长与扩展调用 | `1693593b`、`f49a3ba4` | 发现/桥接有历史理由，但声明变小不等于任务净收益 |

原始动机没有可靠证据的基础工具，不补写作者意图。历史 source/当前 handler 详见
[开发契机与已实施边界](tool-origin-and-retirement.md)、[逐工具源码对照](tool-necessity-comparison.md)。
后者旧的“低频就按需”“无 Goal 按需”等候选建议由本文替代，事实来源仍可用。

## 4. 全部 78 项的当前保留判断

下表“保留”不等于以后永不改变入口；“候选”不等于批准隐藏。
默认指普通 Coding、能力已绑定且符合角色/权限的情况。未知扩展不套内置名称规则。

| 工具 | 保留价值 / 决策 |
| --- | --- |
| read | 核心；切片、非文本、可信读状态，保直接调用 |
| write | 核心；可信整文件写入，新文件等职责不能简单用 shell 重定向替代 |
| edit | 核心；唯一锚点、顺序批次、原子提交、旧读保护 |
| bash | 核心执行器；跨平台 shell、权限、进程生命周期，Code 模式仍复用它 |
| glob | 核心路径定位；不依赖用户安装 rg，边界与 ignore 行为要如实说明 |
| grep | 核心内容定位；literal/regex、分页，覆盖 local code_search 主路径 |
| undo | 保留；恢复可信 preimage，Git restore 会丢用户未提交内容，非等价替代 |
| insert_after_anchor | 剩余便利候选；普通恢复已迁移，旧读/当前快照差异未完全等价，不立即隐藏 |
| worktree_create | 保留隔离能力；直接入口是否被 spawn 隔离完整覆盖尚未证明 |
| worktree_remove | 保留 dirty/路径/进程排空保证；不能换成 rm |
| ask_user_question | 正常 Host 保留；显式澄清减少返工，不以暂时没问题为隐藏条件 |
| exit_plan_mode | Plan 审批；按有效模式呈现有 DSH 先例，作为整体装配规则候选，不另开小优化主线 |
| todo_create | 保留稳定 ID 与安全增量追加，不能退回全表 init |
| todo_update | 保留局部更新与 hooks；不与 Goal 或全文计划混为一个工具 |
| todo_list | 保留读取/恢复；现有状态足够时避免重复调用，隐藏可能增加恢复轮次 |
| create_goal | 正常具备 Goal 的 Host 暂保；只允许明确请求，见下一节产品选择 |
| get_goal | 保留真实状态/预算读取；没有目标不等于没有能力 |
| update_goal | 保留目标收尾及阻断规则，不变更 AMA/Goal 生命周期 |
| spawn_agent | 核心协作；受管理身份、预算、读写与隔离，不用 shell 子进程代替 |
| send_message | 保留活跃通信及不唤醒语义 |
| followup_task | 保留 idle 开新 turn 的显式语义；不能隐式混进 send |
| wait_agent | 保留事件等待，防止轮询增加请求 |
| list_agents | 保留活跃拓扑/容量/恢复，与角色目录不同 |
| interrupt_agent | 保留停止当前 turn 且可恢复的能力 |
| agent_output | 精确旧 turn/结构结果仍有用；先减少通知后的重复读取，不强制发现 |
| list_dispatchable_agents | 保留专用/外部执行器目录；不能用 list_agents 替代 |
| repo_overview | 概览便利；优先避免已自动注入后再读，服务/手动刷新/自动上下文分别计量 |
| changed_scope | Git 范围聚合便利；shell 有信息源，但需证据证明无新增调用/输出膨胀才退出 |
| changed_diff | 保留多路径、未跟踪内容与有界分页；既有 bundle 已合并 |
| code_search | local 已退出普通 root 默认入口；provider/角色/SDK 兼容保留，不重复算节省 |
| semantic_lookup | 结构实体匹配有区别；不是 embedding，不用名字声称语义推理更强 |
| cyclic_dependencies | 保留图算法；先验证真实边见证，再评独立入口必要性 |
| relationship_scan | 聚合便利；不能完整覆盖四个窄 capsule，不强制取代它们 |
| module_context | tests/docs/entry 等窄证据；当前聚合有缺项，保留 |
| symbol_context | signature/定义/调用/alternatives；与 grep、LSP 部分重叠但不相同 |
| process_context | 有界启发式步骤；保留事实边界，不能宣传为真实运行轨迹 |
| impact_estimate | 调用位点与变更重叠的窄查询；大聚合可能更贵，保留待组合比较 |
| lsp_definition | 编译器定义定位；保留已启用能力 |
| lsp_references | 编译器引用，非字符串匹配；保留 |
| lsp_hover | 类型、签名、泛型、文档；保留 |
| lsp_implementation | 接口/抽象到实现；保留 |
| lsp_document_symbols | 文件结构与范围；保留 |
| lsp_workspace_symbols | 工作区编译器符号；保留 |
| lsp_incoming_calls | 上游调用位点；保留，内部 prepare |
| lsp_outgoing_calls | 下游调用位点；保留，内部 prepare |
| memory_recall | 治理后的记忆查询；保留，有无记录不是有无能力 |
| memory_intent | 已聚合八动作，授权/revision/receipt 有价值，不能换随意文件写入 |
| session_history_search | 压缩后历史定位与 lineage 边界；保留绑定后的恢复通路 |
| session_history_read | 精确条目/分页恢复；与 search 有依赖但不是重复算法 |
| kodax_manual | 产品版本/白标知识有价值；将来可资源化，但须保持一次调用与正确版本 |
| skill | 参数展开、learned admission、动态上下文权限；保留，普通 read 不完整覆盖 |
| web_search | 保留检索能力，现有 provider/来源/失败处理 |
| web_fetch | 保留正文获取，检索与获取不同；不为少量 token 新造万能路由 |
| tool_search | 扩展/未知契约发现；保留，但不把它强加到本来直接可用的常用操作前 |
| tool_call | 保留可移植桥接；不是 Code 执行器，不宣称已有程序化编排 |
| run_skill_script | 已按宿主能力装配；保留准入/输入输出映射，非普通 shell 别名 |
| run_workflow | 已按 Host 装配；保留明确工作流调度，不用 PTC 偷换授权语义 |
| mcp_search | 条件能力；远端 snapshot/cursor/partial，普通本地发现尚不能替代 |
| mcp_describe | 条件能力；可在 search 有 exact 全契约后合并入口，当前未等价 |
| mcp_call | 条件能力；保远端协议、认证、错误和多模态结果 |
| mcp_read_resource | 条件能力；普通 read 不支持同 MCP 协议 |
| mcp_get_prompt | 条件能力；远端参数展开与不可信内容边界 |
| scaffold_tool | 构造专项模板，可资源化；普通 AMA 已排除，不计默认节省 |
| validate_tool | 构造专项校验，有与 test 的重叠，需合并算法/阶段证据 |
| stage_construction | 构造专项持久化/版本状态，非 write 等价物 |
| test_tool | 保留真实校验；不得把测试 stamp 宣称成真实 handler 运行 |
| activate_tool | 保留重新读取/admission/批准；不是直接注册脚本 |
| scaffold_agent | 构造专项模板，可资源化；不计默认节省 |
| validate_agent | 保留 manifest/Agent admission，与工具 AST 校验不同 |
| stage_agent_construction | 保留 active 同名冲突与版本保护 |
| test_agent | 保留真实检查；未执行模型 testCases 的边界须如实声明 |
| activate_agent | 保留 re-admission 与后续 Run 生效 |
| stage_self_modify | 继续不在普通 AMA；不借入口合并放宽身份/版本/审批边界 |
| multi_edit | 默认重复入口已由 edit.edits 覆盖；SDK 兼容，不再算收益 |
| changed_diff_bundle | 已由 changed_diff.paths 覆盖；兼容保留 |
| tool_describe | 已由 tool_search select 返回完整契约；兼容保留 |
| todo_get | 已由 todo_list.id 覆盖；兼容保留 |
| lsp_prepare_call_hierarchy | 已由 incoming/outgoing 内部 prepare 覆盖；兼容保留 |

没有证据的“无人使用”不作为删除理由。兼容后端如最终退役，应迁移内部引用、历史回执及 SDK
契约后再删，并复用原算法而非永久维护两份；这属于维护收益，不重复包装成首轮 token 收益。

## 5. 已对齐：Agent / Coding / Script 单入口

比较结论：Codex 按 registry/exposure/模型 ToolMode 装配；DSH 用 preset + 能力插件 + executor；
pi 默认 read/bash/edit/write，其他工具/扩展显式启用。应学边界，不抄数量。
源码入口：[Codex spec_plan](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs)、
[DSH Standard](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml)、
[DSH PTC](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/ptc.patch.yml)、
[pi defaults](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:3712)。

| 用户模式 | 工作面与调用方式 | 工具及上下文边界 |
| --- | --- | --- |
| Agent | 通用工作面 + 原生调用 | 文件/命令、交互、AMA、知识/网络及已绑定宿主工具；默认不装配 18 项 Git/Repo/LSP 专项入口或自动仓库分析摘要 |
| **Coding（默认）** | 编码工作面 + 原生调用 | 当前经过验证的完整 Coding 能力，遵守已有绑定、权限和角色限制；不附带新一轮隐藏实验 |
| Script | **同 Coding 工作面** + 程序化调用 | 适合组合的叶工具通过完整 Script SDK 直接可调用；交互/状态/协作控制仍原生，能力不减少 |

Agent 不是只读模式，也不是只聊天：保留 read/write/edit/bash/grep/glob/undo 等通用文件能力，
便于文档、资料和自动化任务；保留可信写入及命令权限。其产品适配可复用 coding 中的这些工具，
但 agent 框架包本身不能反向依赖 coding。选择 Agent 的轻工作面不等于全能力 Coding 的无损压缩。
RepoIntel/LSP、MCP 等继续使用现有能力配置；明确关闭与未启动不同，不新增同义开关。

只有一个对外模式值。完整目标为 SDK/Session 字段 `workMode?: 'agent' | 'coding' | 'script'`，
解析优先级为显式 Run 覆盖 > Session 选择 > 产品默认 Coding；目前仅单次 SDK Run 的 `agent | coding` 已实现，
Session 选择和 `script` 尚未开放，不能将目标优先级当作已有产品行为。
内部派生 `(agent,native)`、`(coding,native)`、`(coding,script)`，不再存两套可互相冲突的状态。
不复用旧 `agentMode=sa/ama` 字段、不恢复 SA 用户入口。旧 Coding 调用不传新字段时行为不变；
裸 `createAgent/Runner` 和显式 SDK 工具清单不被产品预设覆盖。显式 profile/专用角色沿用原能力边界，
不能按名称推断成默认 root 再套裁剪。

CLI/REPL 提供一个选择入口，只显示 **Agent / Coding / Script**，不加 AMA 或 Coding 前缀；
权限模式、模型和 Goal 状态独立。首版只允许 Run 空闲、关联工具/子任务已结算时切换，
忙时不自动中断、不排入隐藏待切换状态。模式从下一次 Run 的首个请求完整生效，存入 Session 并随恢复还原。
已有消息、工具回执和文件状态不清空；压缩后的说明按新模式重建，保留旧回执工具名的解释能力。
Script 执行器不可用或组合未支持时，明确保持原模式并拒绝切换；不静默退回 Coding 冒充 Script。
用户切换模型不授权改工作模式；不兼容的新模型/执行器组合在下一 Run 前明确报告。

子 Agent 的专用角色装配继续遵守既有策略和权限上限，不机械复制父级 native 菜单。
第一版不因父级 Script 而把所有子 Agent 改成 Script；保留当前子执行器并把其费用/轮次纳入完整任务统计。
模式是装配/调用选择，不是授予更大权限的途径。

Goal 两方案比较：仅 `/goal`/SDK 可降低普通注入约 526–548，但取消了明确自然语言创建路径，
不符合用户最新要求把产品取舍重新开放。因此暂保 Codex 式明确请求创建，更不做“无目标就隐藏 create_goal”。
Codex 的 [create_goal](C:/Works/PubProj/codex/codex-rs/ext/goal/src/spec.rs:25) 本来允许明确用户或
system/developer 请求，并非只有 slash；DSH Standard/PTC 同样装配 Goal。该选择不是永久冻结，
但必须按交互能力决策，而不是按首轮小额节省决定。

## 6. 完整注入链与 Code 候选

链条必须一致：注册来源 → Host/角色/权限允许能力 → 策略说明 → 模型表示 → 实际执行 → 回执/预算/恢复。
AMA 策略依赖允许能力，不能因某项不在 native 里就退化 fullTodo/fullCollaboration。
现有 builtin、extension 覆盖、run-scoped lease、SDK 和 child 各有权限上限；不能新建旁路执行器。

首轮同时包含工具契约、稳定系统说明、仓库/技能/记忆等自动上下文。后续成本还包括结果体积、
重复读取、错误恢复、子 Agent 启动以及辅助审查请求。优化效果应连同这些一起记账。
自动注入只去确定同源重复和明确不属于工作面的内容；不去安全规则、失败恢复、证据限制和 AMA 策略。

**延迟不是低频工具的默认归宿。** 已知工具若要先 search/describe 再调用，很容易新增一次请求。
已有 Kimi preflight 从 2 请求/34,573 token 变 3 请求/49,740，不能无视这个反例继续全量延迟。
优先直接等价替换；未知扩展原本就要发现，或正常前置步骤已附完整契约，才有不额外插入发现的空间。
不得用工具名/短提示暗示“能力保留”就宣称无损。

Code 候选的价值在数据依赖的组合、筛选和有界结果，不是“把 54 个名字装进一个名字”。
已有 Codex 同 Sol 抓包：Direct 15,174、混合 18,476、Only 17,047；DSH PTC 也比 Standard 大。
独立工具本已能同轮并行，不能把这类批量当作 Code 额外节省的轮次。应选择“读结构化结果→
筛选→后续查询”的真实依赖链，看是否减少模型往返和结果入历史。

Script 的完整 78 项 native/SDK/条件/兼容分配见[分配表](tool-mode-allocation.md)，没有为常用编码工具
增加 search/describe 前置。SDK 契约与可调用函数来自相同 registry revision；不把全部 schema 从上下文
拿掉再声称模型能准确调用未知参数。Script 首轮可能更大，准确总量须由实现后的相同 Host 抓包决定。

最小研究边界：复用原工具执行链；交互/Goal/Actor 等控制动作先保持原生；程序化调用逐叶权限、
预算、取消、出处和结果完整性不变；不能依靠外层 exec 一次批准放行所有叶调用。
不新增 shell/patch/搜索替代器，除非证明它优于现有同轮工具组合；不默认 native + typed SDK 双份教学。
KodaX 的 tool_call 仍是 JSON 桥接，当前没有等价 Codex/DSH 的完整 Code 执行运行时。

## 7. 改动计划与验收顺序

| 阶段 | 最小改动范围 | 验收及停止条件 |
| --- | --- | --- |
| A 单源模式装配 | `types.ts`、context/registry/model projection、prompt/context builder；一次定义工作面与表示元数据，派生三种视图 | 78 项逐项对账；Coding 与当前 normalized wire 相同；绑定、扩展覆盖、SDK/角色、AMA 教学不变。禁止为模式复制三个执行器/白名单 |
| B Agent 工作面 | 只调整预设专属入口和自动 Repo 内容，复用基础工具与 AMA | 通用文件、网络、知识、Goal/协作任务可直接完成；不删除用户/项目指令、权限、cwd 或历史恢复。不以比 Coding 工具少证明编码非劣 |
| C Script 最小执行闭环 | 受限代码执行器与 exec/wait（名称待实现冻结）、受控 tool SDK；先打通 read→筛选→后续查询及 edit→测试 | 实际 Coding 叶能力可调用；不新增发现轮；先检验 schema/首轮开销。若只包装调用却无完整任务收益，不扩大执行器 |
| D Script 边界与完整装配 | 接入分配表的全部合格叶工具；原生控制项保持，覆盖有界输出、事件、预算、取消、部分失败 | 逐叶权限/只读/路径/预算与原生等价；控制动作不可从脚本绕入；已成功写入不得因重试整段而重复执行；SDK/专用角色不变 |
| E 单入口与恢复 | CLI/REPL/Runtime Session + SDK `workMode` 接线、持久化、空闲切换与能力报告 | 默认 Coding；三名称准确；无自动模式判别/切换；旧 Session/SDK 兼容；压缩/重启/模型切换如实恢复，未结算 cell 不自动重放 |
| F 配对验证与发布决定 | 相同提交/Host/权限/数据，按下列矩阵做离线与有界模型验证 | 先过离线，再做 GLM/Kimi；Coding 默认保留，Script 不因实现完成就自动成为默认或宣传全面更好 |

上述是一个功能的分阶段交付，不在 A–E 之间夹入独立删工具、Repo 引擎重写或新能力项目。
Repo/LSP 已知质量风险只对受影响验证用例先校正或明确记录；不能把它们掩盖为模式效果，也不扩大成无限前置重构。

### Script 执行边界

- 使用真正受限的执行宿主，不把 Node `vm` 当安全沙箱；代码不能直达 FS/network/环境密钥。
  文件、网络、命令均经原工具链；执行器选型与 CPU/内存/墙钟/输出限制在阶段 C 离线确定。
- 不额外复制工具实现。内层每次调用保留 canonical tool identity、调用参数、权限、预算、事件、
  输出出处/截断/错误状态；交互/Goal/Todo/Actor 等原生控制不在 Script SDK 中开放。
- 独立读可并发，写入沿用锁/路径身份/事务规则。脚本中已有写入成功、后续测试失败时，返回可核对的
  部分完成回执；恢复只重试必要步骤，不自动重跑整段。批量写入不凭脚本边界冒称跨文件原子。
- 叶工作预算恰记一次；外层编排 CPU/时间独立观测。模型、辅助审查、子 Agent 和宿主请求均计入账本。
  脚本异常、权限拒绝、超时/取消不能藏在“执行成功”里；取消完成须等待内层及 Windows 进程树收尾。
- 若需异步 cell，exec/wait 句柄属于当前 Run 和能力版本；旧句柄不能延长已撤销权限。
  重启不承诺恢复内存 VM；保留已提交回执，明确丢失的 cell 状态，不静默重放副作用。

### 完整任务验证矩阵

| 任务 | 比较对象 | 必须核验 |
| --- | --- | --- |
| 文档/资料、Web、知识与文件整理 | Agent 与同权限 Coding 基线 | 报告准确、工具可达、不误注入仓库专项内容、不因缺工具反复探索 |
| 普通读改测、陌生仓库定位 | Coding 与 Script | 相同证据/实际修改/测试/最终报告；包含不适合 Script 的简单任务 |
| 多文件修改、符号/调用关系调查、Git review | Coding 与 Script | 不丢字段、分页、编译语义和未跟踪文件；区分质量问题与表示差异 |
| 结果依赖的批量筛选/后续查询 | Coding 与 Script | 比较真实依赖轮次；原生本已同轮并行的工具不冒算为 Script 节省 |
| 只读 child + 主 Agent 编辑 + AMA 收尾 | 三模式适用工作面；主要 Coding/Script 配对 | 派发策略、隔离、拒绝后自主恢复、等待、结果整合及最终报告 |
| Goal 创建/继续/完成；交互和计划审批 | 三模式 | 明确自然语言与 slash/SDK 路径均在；状态与能力不混淆；脚本不能替代控制授权 |
| 部分写入后失败、预算耗尽、取消、压缩/恢复及模式切换 | 三模式/对应执行器 | 不双扣、不重复写、不丢任务/历史、不自动扩大权限或把未完成报成完成 |

先用真实工具与受控离线流程验证边界；Windows 实跑与 macOS/Linux 平台验证分别记录，不外推。
之后使用 `zhipu-coding/glm-5.3` 与 `kimi-code/kimi-for-coding` 做有限配对与最终无干预复杂 E2E，
不使用 zai 别名。每阶段先固定判别任务和总调用/费用上限；用基线完成成本校准预算，不以五轮机械截断。
不反复重跑挑好结果；失败分清模型波动、评测设计、传输和真实退化。当前实施只做离线验证，零模型请求。

统一判据：任务正确性与报告真实性优先；记录总生成请求（含子 Agent 和辅助请求）、串行依赖轮次、
工具数、全任务输入/输出/缓存用量、费用、耗时、拒绝及恢复。多工具同轮不算多次模型往返。
不准通过少读证据、不运行测试、提前收尾或隐藏未完成结果换指标。
候选若确定增加正常任务发现/恢复轮次，或破坏权限/AMA/SDK/质量，撤回该呈现；
若只省首轮而全任务收益不明，保留基线。不承诺有限样本能数学证明所有任务绝不退化。

## 8. 本轮交付与后续范围

已完成全量归类对账与历史复核，并按用户选择补齐三模式设计、78 项分配、SDK/切换及分阶段验收。
公开入口仅落地 A/B：`KodaXOptions.workMode?: 'agent' | 'coding'`，不传继续 Coding；底层 SDK/profile/子角色不迁移。
三选项 UI、Runtime Session 持久化与公开 Script 枚举尚未实现；无效模式明确报错，不伪装成功。
Script 目前仅有下述内部阶段 C 执行实验，不是可选的产品模式。
此前 LSP 明确关闭时过滤、local code_search 默认退出、别名收敛、普通编辑恢复迁移和同源去重
作为已实施基线保留，不重复计功。LSP 合并只省约 350–400 且权限等价未完成，继续暂缓。
具体源引用和既有失败证据留在相邻设计文件；本文件定义当前整体方向，不批准一次性删除任何候选能力。

### A/B 实施边界与离线证据（2026-10-24）

- 在现有 builtin 定义中标注 Coding 专项工作面；没有复制模式清单或执行器。内部标记不进入模型/公开工具定义。
- 统一 `resolveWorkMode` 处理 opt-in 默认 root；显式 `agentProfile`、`currentAgentId`、`systemPromptOverride`
  或 `toolVisibilityPolicy` 保留调用方声明。新字段当前是单次 SDK Run 选项，不是已接通的产品 Session 设置。
- 复用 `isToolDiscoverable`，让 Agent 的 native、发现、桥接一致。18 项专项及其两项兼容别名不在
  普通 Agent 的可发现/桥接工作面；底层 `executeTool`、SDK、专用角色、扩展覆盖继续原契约，不新增权限授权。
- 自动 Repo 摘要在 Agent 直接跳过，但调用方提供的 `repoIntelligenceContext` 原样保留；不关闭共用索引/LSP 服务，
  不改 AMA 的路由、规划、派发、等待、完成或子执行器。
- `work-mode.test.ts` 验证 Coding/Agent 工具差集、AMA 契约、别名/发现/桥接、拒绝后恢复及预算、SDK/专用角色、
  扩展同名覆盖和公开模型定义不泄漏元数据。Repo middleware 回归验证跳过扫描与保留显式调用方上下文。
- `tests/first-turn-work-mode.test.ts` 使用受控离线 provider，执行真实 read/edit/bash 测试和 AMA 收尾；
  Coding、Agent 均 4 次模拟生成请求、3 次工具调用、无发现轮，修改结果和测试回执真实核对。
  这是执行闭环回归，**不是模型智能评估**，不把模拟 usage 或本机测试耗时当 GLM/Kimi 质量/费用数据。
- `tests/first-turn-wire-inventory.test.ts` 的 16 个 Windows 默认场景与前一工作区基线逐项比较，
  归一化完整请求 hash 全部一致；完整 AMA Host 保持 OpenAI 工具估算 12,291、Anthropic 11,909。
  比较 raw 在 OS Temp `kodax-first-turn-wire-kbrPz0` 与 `kodax-first-turn-wire-bmyHmr`；前后都是离线 SDK 序列化，零外部模型调用。
  这些数只证明 Coding 默认请求未变，不是 Agent/Script 已节省的实测总任务 token。

规范复核发现公开 `KODAX_TOOLS`/builtin 定义出口需同步剥离内部标记，已补红→绿回归修正；
需求复核要求明确兼容别名不能绕回 Agent 专项工作面，已补入分配表。
最终针对回归 17 文件、379 通过、3 项原有 todo；另有 16 场景 wire inventory 通过。
新增模式解析器覆盖率为语句/分支/函数/行 100%（仅此新模块，不冒称全仓覆盖率）；Coding 构建、
根目录 source/test 类型检查和新增测试类型检查均通过。规范轴原 P3 已复核关闭；需求轴无阻塞发现。
后续阶段 C 记录如下；不能直接把现有 JSON bridge 当 Script，也不把 SDK opt-in 提前宣布为完整产品模式发布。

### C 最小执行实验与限制（2026-10-24，未公开启用）

提交与推送 A/B 基线：主仓库 `3f768634`，配套 feature 历史文档 `fe93035`。后续实验只在
`packages/coding/src/agent-runtime/script/`，没有被默认装配、AMA 或公开 SDK 导入。
`workMode` 仍只接受 `agent | coding`；Coding 默认行为和专用角色不变。

- 采用独立 Worker 内的 QuickJS/WASM，guest 没有 Node 的 process/require/fs/network 接口。
  受控工具调用是唯一宿主 RPC；工具权限仍由宿主负责，这不是给 shell 命令额外授予权限。
  显式限制 VM 内存/栈、执行墙钟、调用数和单条传输大小；超时或取消终止 VM，并等待已准入叶调用结算。
  Worker 的 V8 堆限制不等于总进程 RSS 限制，现有 OS shell 隔离规则也不由 QuickJS 替代。
- 本轮仅验证五个已存在的 builtin：`read/grep/glob/edit/bash`，全部从 registry 取当前契约；
  无发现/描述前置。pilot 名单只是本轮资格范围，不是第二份正式模式装配表。
  使用现有 `runToolDispatch`、`applyPostToolProcessing`、原 handler、权限/guardrail、编辑恢复、
  mutation accounting、事件及可信结果 artifact。预算在已准入叶执行边界记一次，拒绝不计执行次数；
  `maxCalls` 另限制尝试次数，不能用一层脚本绕过工作预算。
- 每 cell 新建 VM，叶调用暂按串行处理（包括 `Promise.all`），不引入写入调度或常驻状态。
  仅前台 shell；后台参数明确拒绝，不能把返回 PID 当作全部副作用已结算。
  Actor/Goal/交互/审批/通用桥接不暴露给 guest；扩展覆盖或工具撤销会拒绝原绑定。
  **当前 pilot 拒绝带 `extensionRuntime` 的宿主**，包括装配后新增的绑定，避免本地读失败后
  自动落入尚未验证的 MCP fallback。没有静默去掉扩展权限，也没有修改原生 fallback；此限制必须在
  后续资格验证后才能解除，不能宣传成完整 Script 已可用。
- 宿主保留原始结果、canonical 调用和编辑恢复/截断出处；脚本返回值不能抹掉这些回执。
  部分写入后失败只报告实际完成的步骤，不回滚冒充原子操作，也不自动重放整段。
  cell 的 `status` 与 `hadToolErrors` 分开：前者报告脚本失败/超时/取消，后者保留原生工具错误分类。
  例如原生 shell 的正文可含 `[Cancelled]` 而通用错误标志不为真，取消以 cell 状态和原始回执为准。
- 原型复核修复：函数 `toString()` 在 tsx 下依赖外部 helper，改为加载独立 Worker 模块；
  禁止继承父进程 loader 参数/环境密钥，源码 loader 禁用磁盘缓存；非 JSON DTO 结果显式失败并保留宿主回执，
  不允许函数、Map 等被 JSON 静默删除。补齐合并取消信号和可信 artifact metadata 传递。

依赖成本：coding 包新增精确版本 `quickjs-emscripten-core@0.32.0` 与
`@jitl/quickjs-singlefile-cjs-release-sync@0.32.0`，另有共同的 ffi-types 依赖；core 与 singlefile variant
发布包解压体积约 0.8 MB 与 3.1 MB，**不是零体积方案**。选型依据是
[QuickJS 上游的 WASM 嵌入与运行时限制接口](https://github.com/justjake/quickjs-emscripten)。
已检查 Node 源码 tsx 入口和 TypeScript 编译后的模块；单文件/Node-free 发布物、macOS/Linux 尚未验证，
不得因 Windows 测试通过提前接入产品。

离线验收位于 `cell.test.ts` 与 `tests/first-turn-script-cell.test.ts`：受限运算和依赖工具组合、
宿主全局/模块不可达、控制项拒绝、CPU/内存/传输/调用限额、权限拒绝后再次编辑、实际 Node 测试、
预算 2/4 与原生叶计数相同、角色排除/撤销/覆盖、guardrail canonical 重写、编辑恢复、
修改成功后测试失败且只重试测试、真实 Windows shell/Node 取消后进程退出及后续修改未执行。
上述均为受控离线流程，不是模型自主表现证据。

验证结果：Script 的 24 项测试整组通过，随后新增真实 read→grep 依赖链及路径拒绝用例单独通过，
共 25 项；现有装配/执行契约 9 文件 108 项通过、2 项原有 todo。coding 构建、根 source/test 类型检查通过。
24 项整组测量的宿主 `cell.ts`/`pilot.ts` 覆盖率：语句 91.48%、分支 83.50%、函数 92%、行 99.06%；
不包含独立 Worker 内的 VM 执行，也不代表全仓覆盖率。Worker 通过上述外部行为回归验证。
规范轴原 2 项、需求轴原 1 项发现均已修正并独立复核关闭；不因此宣称阶段 D–F 完成。

默认 Coding 的 16 个 Windows 场景与 A/B 基线 `kodax-first-turn-wire-bmyHmr` 比较，归一化完整请求 hash
全部一致，新抓包在 OS Temp `kodax-first-turn-wire-x3KyVS`。无新增首轮注入，也没有 Script token 节省结论。
后续先解决正式宿主的嵌套资格、异步生命周期/产品打包和完整装配，再比较实际 schema 开销及完整任务的
质量、模型往返、总 token、费用和耗时；本轮零模型调用，不以手写脚本的成功代替 GLM/Kimi 非劣验证。
