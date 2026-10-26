# KodaX 全盘工具与注入方案

2026-10-25；整体审计和分阶段方案。**基础功能与Windows交付验收已收口；Coding仍默认，Agent按需选择，Script保留显式实验选项。有限GLM/Kimi完整任务已观测，但未证明全任务效率非劣，Kimi自主采用Script仍缺证据。**
本文是当前取舍与验证顺序的总入口，优先于旧文档中的候选优先级；历史失败、抓包和实现记录仍保留。
用户曾提出 Goal 仅由 `/goal` 和 SDK 启动，随后要求重新全盘考虑，故该限制**不是已接受设计**。
已对齐的产品选择：单一切换入口 **Agent / Coding / Script**，**Coding 原生默认**。
Script 是 Coding 能力的程序化调用预设，名字无需 Coding 前缀；本文件与[78 项分配表](tool-mode-allocation.md)
定义完整目标；以文末各阶段记录区分已验证边界与尚未验证的效果，不把离线通过当成智能水平证明。

最新状态：A–E实现完成；F的本批有界验收和采用决策完成，结论是保留Coding默认、不默认采用紧凑教学、
不把Script宣传为已证明更高效。最终源码99项离线回归、类型检查、构建、实际npm包和新Windows ZIP通过。
Kimi Agent和Script预设各一次完整完成；后者选择桥接、没有调用script_exec，因此不能冒称Kimi脚本执行E2E通过。
GLM已有完整样本保留，旧SA提示最小修复通过离线回归；没有为通过反复跑模型。Linux/macOS原生实测、
严格效率非劣及Script跨模型采用率属于明确未验收项，完整跨平台/性能目标未宣称全部完成。
[三模式成本与验收复核](first-turn-mode-cost-review.md) 补充了 Agent 16,379 的逐段归因、
DSH Minimal/Standard、Codex 三种表示、pi 当前源码与 builtin Skills 的对照。
旧评测的Script叶范围/计数与拒绝反馈问题已完成离线修复，历史记录保留，当前不再把它们列为待办。
本批具体结果和限制见[基础版收尾记录](work-mode-task-validation.md#r3-最终结果与基础版验收2026-10-25)。

2026-10-26 最新状态：完整契约候选已实现并完成三模型受控验证及三次复杂任务，
但规划、报告与完整任务效率存在风险，未默认启用；不能再称“候选尚未实施”。
Agent 16,352→10,689、Coding 19,984→14,321 是该实验的历史估算，不是当前默认已实现的降幅。
之后最小拒绝恢复原则与评测反馈已修改，121 项离线验证和 12 次有限配对完成，
没有扩大防循环检测；这项修复增加约 119 估算 token，不是进一步精简。
完整证据见[实施与验证记录](compact-contract-validation.md)。当前工作区成果不等于已发布版本。

下一阶段仍以 Agent <10k 为目标，但改为**先独立交付工具契约精简，再按原句去重行为教学**，
不再把两者绑成全有或全无的采用决定。具体修订、收益上限与落地顺序见
[分拆交付方案](compact-contract-plan.md#9-2026-10-26修订从整体候选改为分拆交付)。
原[验证案例](compact-contract-validation-cases.md)和失败原始记录保留；不重新跑完整旧矩阵，不扩大公开配置。

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
解析优先级为受信任 SDK 的显式 Run 覆盖 > Session 选择 > 产品默认 Coding。
产品客户端经 Session 设置选择，单次 CLI 参数沿既有 CAS 临时覆盖与恢复，不建立第二套设置权威。
内部派生 `(agent,native)`、`(coding,native)`、`(coding,script)`，不再存两套可互相冲突的状态。
不复用旧 `agentMode=sa/ama` 字段、不恢复 SA 用户入口。旧 Coding 调用不传新字段时行为不变；
裸 `createAgent/Runner` 和显式 SDK 工具清单不被产品预设覆盖。显式 profile/专用角色沿用原能力边界，
不能按名称推断成默认 root 再套裁剪。

CLI 使用 `--work-mode agent|coding|script`，REPL 使用一个 `/work-mode [agent|coding|script]` 入口；
状态栏显示 **Agent / Coding / Script**，不加 AMA 前缀；既有 `/mode` 仍是权限选择，不复用它；
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
KodaX 的 tool_call 仍是 JSON 桥接；Script 现已接入正式 Run，但不能据此宣称与 Codex/DSH 的完整任务表现等价。

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

## 8. A/B 阶段交付记录（历史，后续完成情况见 D4/E 与 F）

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
  **首版 pilot（`0c0f0fe0`）拒绝带 `extensionRuntime` 的宿主**，包括装配后新增的绑定，避免本地读失败后
  自动落入尚未验证的 MCP fallback。没有静默去掉扩展权限，也没有修改原生 fallback；此限制必须在
  后续资格验证后才能解除，不能宣传成完整 Script 已可用。下节记录该限制的最小替代与验证。
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
首版已检查 Node 源码 tsx 入口和 TypeScript 编译后的模块；当时单文件/Node-free 发布物、macOS/Linux 尚未验证，
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

### C 后续：扩展宿主资格与发布形态探针（2026-10-24）

已先提交并推送内部执行基线 `0c0f0fe0`，随后仅推进两个边界；没有公开 Script 枚举、Session/UI 接线、
扩大五项工具名单、修改 AMA 策略或把 Script 加入默认请求。

1. **保留扩展宿主，限制未验证的降级路径。** 共享 dispatch 增加内部 `allowMcpFallback` 参数，默认
   `true` 保持原生/SDK 行为；Script 固定传 `false`，递归与 JSON bridge 继续传递此约束。
   本地工具失败返回原始失败，不搜索或执行同名 MCP；不剥离 `extensionRuntime`，也不把整层宿主禁用。
   仍只接受已装配的 builtin 身份，扩展同名替换、未授权工具、后台 shell 保持拒绝。
   `createExtensionRuntime` 的真实 Run frame 回归验证 tool:start/result、只读权限拒绝与恢复、预算和文件状态；
   原生 MCP fallback、Script 失败及后续本地恢复分别验证。此处是内部适配器的宿主资格，**不是产品 Run 已提供 Script 工具**。
2. **打包后再运行。** 原来的运行时 `require.resolve(quickjs...)` 在干净目录复现失败，已改为 Worker
   静态依赖，由 bundler 封入 `script-worker.cjs`，WASM 仍内嵌。使用库自带 `PromisedDefault` 处理 Node CJS
   与 bundle 的导入差异，没有自建加载器。路径沿用现有 root/chunks/包内/独立程序 sidecar 约定。
   `tests/first-turn-script-packaging.test.ts` 将 minified ESM 客户端与 CJS Worker 放在 OS Temp 的独立目录，
   没有项目 `node_modules`，验证两种 bundle 布局、受控 RPC 和缺少 sidecar 时明确失败。

当前 Worker 实测 **877,541 字节（约 857 KiB）**，是压缩 JS 加内嵌 WASM，不是模型首轮 token；
在该探针阶段尚未加入默认 `build-bundle`/发布清单；下一节记录正式打包接线及新增载荷。
`KODAX_SCRIPT_TEST_BUN` 仅供测试显式指定编译器，普通测试不自动下载安装。
本机通过 npm 临时缓存取得 Bun **1.4.4**，实际编译 Windows 独立程序，在清空 Node 模块路径及移除 Node PATH
后验证受控调用、guest 无 process/fetch、CPU 无限循环被终止；不修改项目依赖，不发布任何产物。
这是独立 Script 探针，**没有验证完整 KodaX CLI 的发布包或 macOS/Linux**，不外推成正式跨平台支持。

本次 Script/宿主/打包回归 3 文件 28 项通过（含包内/root/chunks/独立程序路径回归），
现有默认装配与执行链回归 7 文件 61 项通过；coding 构建与根 source/test 类型检查通过。
宿主 `cell.ts`/`pilot.ts` 覆盖率为语句 91.72%、分支 85.29%、函数 92%、行 99.08%，
不包含独立 Worker 和编译后子进程的覆盖率，不代表全仓覆盖率。
零模型调用，未增加任何模型发现或描述往返；
这些是边界与执行证据，不是完整模型任务非劣证据。规范轴与需求轴分别复核，均无未关闭发现。
下一步先定义正式 Run 对 cell 的所有权、取消和回执落盘，再接入实际发布清单与验收；异步后台、
完整工具分配、模式切换和 GLM/Kimi 任务比较仍按阶段推进，不能因为这个探针通过就默认启用。


### C 后续：Run 结算、持久化与实际发布包（2026-10-24）

本批仍不公开 Script 工作模式、工具注册或 SDK 导出。内部 `runScriptInvocation` 与既有
`runToolInvocation` 共用 `withHostInvocation`：同一 Run 身份、扩展上下文、Session 加载/保存、
权限上下文和退出释放顺序。它是供后续产品接线使用的显式执行入口，不是 Runtime/REPL 已可选择的模式；
不接管 AMA 主循环，也不改变专用角色或 SDK 的原生调用策略。

- 沿用 Session 的 extensionRecords（`kodax.script`），保存带 runId/cellId 的 cell.started、
  call.started、call.settled、cell.settled。call.started 只代表尝试，不能作为已执行证据；
  call.settled 保留原始结果、canonical 调用、恢复消息及 artifact metadata。
  开始边界先落盘；每项工具回执在 guest 收到结果、继续下一项之前落盘；取消等到已准入工具收尾后再保存终态。
- 正式内部入口要求可写 canonical Session storage；缺失或由外部独占保存的宿主明确拒绝，
  不伪称持久化成功。保存失败停止本 cell 的后续工具；已发生的副作用不回滚或重放。
  工具完成与磁盘写入之间仍存在非事务性崩溃窗口：只有开始记录而无结果时，恢复必须核查实际文件，不能推断未执行。
- 完整叶回执存为宿主证据，不重复塞入模型消息。VM 不跨 Run 存活，也不增加 exec/wait 句柄、后台命令或自动恢复执行。
  Session 重新打开仅加载记录，未结算 cell 不作为待执行队列。产品级 Script 摘要/模式恢复仍属阶段 E。
- 离线回归覆盖真实 edit 后脚本失败、新 Run 只读恢复、取消时等待未结算工具、禁止后续写入、
  首次和中途保存失败，以及真实 Node 宿主强制终止后重载已保存的编辑回执；不把这些受控调用称为模型自主验证。

正式 build-bundle 生成 `script-cell.js`（约 4.3 KB）与自包含 `script-worker.cjs`（877,541 bytes），
后者含 QuickJS/WASM，无运行时 npm 依赖查找。npm 文件清单、binary 拷贝及 tar/zip 发布清单同步包含两项。
这会增加发布物体积，但不被 Coding 启动路径加载、不增加默认请求工具或教学。没有新增公开 SDK export。

本机通过完整 `npm run build`、实际 `npm pack --ignore-scripts` 产物的干净目录运行及缺少 Worker 的明确失败；
实际 Windows x64 `build-binary --skip-tsc` 也通过。二进制验证使用发行的 KodaX 可执行文件自身的 Bun child 模式、
清空 Node 查找路径，执行真实打包的 Script client/Worker；同时通过原有 A2A/native/技能/Provider SDK smoke。
没有调用外部模型，也没有发布或上传产物。macOS/Linux 仅接线发布清单，仍须平台 CI 运行，不冒称本机已验收。

评审中发现并修复两项宿主接线问题：内部入口现优先复用 `ctx.managedWorkBudget`，不另给已耗尽 Run 一份预算；
Script 叶回执采集并转发 `reportShellExecutionOutcome`，实际 shell 非零退出或缺少成功证据时标记失败，
保留原始正文及 `shellExecutionOutcome` metadata，不能把 VM 正常返回误报成测试成功。
cell 终态也保存有界 guest 返回值，便于恢复核对；返回值不是工具副作用成功的证明。

默认请求复核：16 个 Windows 场景与前一基线 `kodax-first-turn-wire-x3KyVS` 的归一化完整请求 hash
全部相同；新抓包位于 OS Temp `kodax-first-turn-wire-fxXLeC`，外部调用数为 0。
此结论是 Coding 默认装配不变，不是 Script 的 token/智能收益证明。

针对性验收：最终 Script/真实工具/Run/独立打包四文件 37 项通过；默认装配、原生显式调用和 Run 回归九文件 76 项通过
（两组存在重复，不相加）。Run 边界两文件共 15 项回归测得 `host-invocation.ts`/`script/run.ts`
语句 97.50%、分支 96.87%、函数 88.88%、行 97.36%；独立 Worker 与子进程仍以外部行为验证，
不将局部覆盖率宣称为全仓。规范轴 0 项，需求轴上述两项修复后独立复核为 0 项。

最终四模块（cell/pilot/run/host-invocation）的定向覆盖率为语句 92.85%、分支 86.11%、
函数 91.66%、行 98.71%。无效 cell 限额或超长源码在接受并持久化前即被拒绝；
此校验复用 VM 原有规则，不另建一份参数契约。

全量检查限制：首次全量为 1,225 文件通过、5 文件失败、4 文件跳过；17,216 项通过、17 项失败。
该轮与代码修正重叠，出现旧模块缓存（validateScriptCell 缺失）和 daemon 构建身份变化，不能作为最终版本全量验收。
固定源码后仅复核这五文件：64 项通过、2 项失败，无未处理异常；Script 与 daemon 失败均关闭，
容量恢复两项在本次复核也通过，但在下述基线对照中又出现，应保留波动记录，不以单次通过宣称彻底解决。

仍失败的两项分别位于 `tests/deferred-repo-lsp-runtime.test.ts`（repo 工作面闭环 phase 为 failed）和
`tests/first-turn-complex-path-recovery.test.ts`（目录命令的隔离拒绝被记录为整任务错误）。
通过 OS Temp 中的 Vite 只读 transform，将本轮修改的既有 packages TypeScript 源码映射回 `0c0f0fe0`，
相同环境运行旧的三文件回归：相同两项失败，另有前述容量恢复两项失败，27 项通过。
这是本轮改动源码的控制变量对照，不是完整干净 checkout 的全仓基线；不将这些失败归因于 Script，
也不因此宣称没有旧缺陷。日志在 OS Temp 的 `kodax-script-full-tests.log`、
`kodax-script-failure-recheck.log`、`kodax-script-baseline-recheck.log`。

本轮没有修旧评测守卫、重写模型参数或运行真实模型来掩盖失败。当前内部执行与打包回归已通过，
但全仓未达全绿，Script 不对外启用，不据此推进默认切换或宣称智能非劣；旧验收问题需独立收敛。

### C 旧验收修正与冻结回归（2026-10-24）

两项旧失败已离线复现并分类为 **eval-design**，本批仅修三份测试，不改生产执行链、隔离守卫或模型参数：

- Repo 夹具始终设置 `lsp:false`，却要求 `lsp_references` 出现在首轮菜单，导致模拟 provider 在返回第一条响应前断言失败。
  修正为验证原输入与 Repo 投影视图都不重新引入已关闭且未绑定的 LSP；既有 support 测试仍单独验证
  LSP 原本可用时，Repo-only 投影保留全部八项，不删除相应能力验收。
- 原 `cd packages & cd .. & git diff` 保持原样，验证硬拒绝、子 Agent 只有一次响应且未派发 bash。
  评测守卫逐参数按夹具根目录检查，不模拟 shell cwd 演进，因此不能把这个保守拒绝当作产品能力退化证据。
  新增独立 `cd packages & git diff` 案例，验证 SDK 返回原始错误回执、只读 child 随后读到 README 实际正文并正常收尾。
  Windows/POSIX 风格路径另验证 `beforeTool` 的 block 决策与输入不变；这不是在两个 OS 上执行了该命令。
- `onToolUseStart` 是调用尝试的显示事件，不能作为实际执行证据；Runtime 内部执行租约也不向该评测回调转发。
  未为补断言扩展生产事件接口：硬拒绝验证没有进入派发，可恢复拒绝用 guard 的 block 决策、真实错误回执与恢复读取验证。

固定源码后的全量 `npm test`：**1,229 文件通过、1 文件失败、4 文件跳过；17,235 项通过、1 项失败、
90 项跳过、19 项 todo**，无未处理异常。上述两项旧失败及全部 Script 回归通过。
唯一失败是未修改的 `packages/agent/src/capabilities/mcp/oauth-connect.test.ts` 中本地 OAuth 回调用例超过原有 30 秒上限；
结束后只做一次隔离复核，该文件 3 项全部通过（测试约 248 ms）。保留全量失败，不改超时或 OAuth 代码，
不把隔离通过冒称原全量全绿，也不据此断言已定位其偶发超时根因。
日志分别在 OS Temp `kodax-script-frozen-full-tests.log`、`kodax-oauth-isolated-recheck.log`。
类型检查通过；规范轴与需求轴最终独立复核均无未关闭发现。

本轮全量产生的 Windows wire 抓包 `kodax-first-turn-wire-1WwIgG` 与 `kodax-first-turn-wire-x3KyVS`
逐项比较，16 个归一化完整请求 hash 全部一致，外部调用 0。没有模型质量、token 或费用收益的新结论。
提交该基线后，阶段 D 先只验证 `write` 一个叶工具，复用现有权限、可信写入、预算与恢复；
不提前接 UI、公开 Script 枚举、后台 shell 或扩大全部叶工具名单。

### D 首个叶资格增量：write（2026-10-24）

先提交并推送 C 基线与旧验收修正 `b44d025a`，再仅将内部 pilot 的合格叶从五项扩为六项，新增 `write`。
生产差异只有现有名单及注释；schema 直接取原 registry，执行、权限、可信文本事务、预算和回执处理都复用原链。
没有公开 Script 模式、修改默认菜单、删除入口或改 AMA/SDK/专用角色，也没有新增发现/描述步骤。

- 预算 2/4 的原生叶对照先因缺少 write 契约而失败，加入资格后通过；核对实际新建/覆写内容、执行与 mutation 计次，
  Script 预算耗尽后无额外写入。权限拒绝不准入；已准入工具内部的 stale/路径拒绝仍按既有执行语义计次。
- 现有只读宿主与编辑失败恢复用例加入 write：不能借脚本整文件覆写绕过保护；过期内容拒绝保留 peer 文件，
  重新读取后才继续写入。取消回归同时验证后续 edit/write 均不执行。
- `NODE_ENV=production` 下绑定实际可信文本事务宿主，验证原样越界参数被拒、合法新文件创建后脚本失败、
  两份真实叶回执落盘，以及重新进入 Run 只读取已保存内容、不重放写入。此处验证平台为 Windows。

最终离线回归 8 文件 **70 项通过**；coding TypeScript 构建与根 source/test 类型检查通过；规范轴 0 项、需求轴 0 项。
本批不重复跑全仓或模型；前节全量及 OAuth 偶发超时记录继续有效。最终 wire `kodax-first-turn-wire-JM04Ia`
与前节基线逐项对照，16 个归一化完整请求 hash 不变，外部调用 0。
当前仍是内部资格实验，后续才逐批核验其余叶工具、完整装配和产品入口；不据本批受控验证宣称模型智能或总任务效率已提升。

### D 第二个叶资格增量：insert_after_anchor（2026-10-24）

以 `06c22850` 为基线，本批只加入 `insert_after_anchor`，内部合格叶从六项变为七项。
生产代码仅改一处资格名单，原 schema、handler、可信写入、权限、预算和恢复链原样复用。
`undo` 的备份生命周期留待单独核实；本批不新增配置、发现步骤、公开模式或默认注入，也不改 AMA、SDK 和专用角色。

- 原生契约与预算 2/4 对照先红后绿，核对实际插入结果、执行及 mutation 计数、预算耗尽后无额外插入。
  工具本来不保证文件末尾换行，测试按原生输出核对，不为 Script 改写该行为。
- 验证显式排除、只读拒绝、缺失/歧义锚点保留原文件与编辑恢复状态，仅有效插入后清除恢复状态。
- Windows 下以 `NODE_ENV=production` 绑定实际可信宿主，验证原样越界参数拒绝、插入后脚本失败的回执持久化、
  后续 Run 读取结果而不重放；另在真实 commit 前受控暂停，取消后等待调用结算，原文件未变、后续 write 未执行。
  暂停只延迟宿主调用，不改参数、权限或返回结果；不据此宣称已验证其他 OS 或原生提交已发生后的取消。

最终离线回归 **10 文件、100 项通过**，coding TypeScript 构建及根 source/test 类型检查通过。
pilot 模块覆盖率：语句 93.75%、分支 86.04%、函数 91.66%、行 97.61%，不是全仓或独立 Worker 覆盖率。
规范轴 0 项、需求轴 0 项。未重复跑全仓或真实模型，前文全量/OAuth 超时记录保留。
最终抓包 `kodax-first-turn-wire-QLtW7t` 与 `kodax-first-turn-wire-JM04Ia` 的 16 个归一化完整请求 hash 全部相同，
外部调用 0；Coding 默认首轮不变，不将受控回归当作 Script 智能或总任务收益证明。

### D undo 生命周期核实：暂缓 Script 资格（2026-10-24）

以 `5ebfbc0c` 为基线，本批只补离线回归和设计边界，不修改生产代码或七项合格叶名单。
`undo` 有恢复可信原文的价值，不能用 Git restore 等价替代；但不能把这一价值等同于跨 Run 撤销：

- 备份由 `KodaXToolExecutionContext.backups` 持有；可信事务凭据以这个 Map 对象为键保存在 WeakMap 中，
  不是按 Session/Run ID 查询的持久历史。普通执行循环共享上下文；新上下文及子执行器不继承父备份。
- 同一上下文中的 Script edit/write/insert_after_anchor 与原生 undo 能复用现有执行链，脚本后续失败不会自动回滚。
  权限拒绝、执行前取消不准入，也不消耗备份；可信提交前取消保留原文件及备份，随后在同一上下文可重试。
  已准入的取消尝试仍计预算；Script 写入与原生撤销共用预算时，各计一次，耗尽后 Script 不再写入。
- 当前 `runScriptInvocation` 每次经 `withHostInvocation` 创建新上下文。持久化的是执行回执，
  不含可重建撤销权限的备份。重开 storage 后，即使使用相同 Session 和相同 Run ID，后续原生宿主 undo 也没有备份；
  不同 Run ID 同样如此。这是现有宿主调用的生命周期边界，不冒称 Script 相对原生新增的回归。
- 空备份的 undo 返回非错误文本 “No backups available. Nothing to undo.”，不能据 `success:true` 报告已恢复。
  新建文件没有覆写前像，不会被 undo 删除；同文件多次修改也不是无限撤销栈。
  既有 undo 回归继续核对路径身份、外部修改 CAS 拒绝及 committed_uncertain 后重试。

因此本批**不将 undo 加入 Script**，保留 Coding/Agent 原生入口、SDK、专用角色及 AMA 策略。
后续接入父 Run 时，先验证多个 cell 复用现有上下文与预算、取消和销毁边界，再决定是否完成表中的 S 目标；
不要求跨 Run 持久撤销，也不为此新建备份服务、路由或发现往返。当前原生能力保留不代表已提供公开 Script 混合模式。

验收使用 Windows 实际可信文本事务宿主及现有原生派发/managed wrapper；取消案例只在真实 commit 前暂停，
不改输入、权限或结果，不宣称验证了提交完成后的取消或其他 OS。本批没有模型调用，也不产生新的 token、费用或智能收益结论。

最终定向回归 **7 文件、98 项通过**（本批新增 7 项），根 source/test 类型检查通过。
规范轴 0 项、需求轴 0 项；未重跑全仓，前述全量/OAuth 超时记录不变。

### D 父 Run 内的多 cell 接线（2026-10-25）

新增内部 `withScriptCells`，借用 `withHostInvocation` 已建立的上下文、Session state、权限和保存边界。
原单 cell `runScriptInvocation` 也走这条路径，不另建执行器、公开 SDK export、模式开关或跨 Run 备份服务。
这是显式宿主父 Run 的接线；普通模型/AMA 装配没有开启 Script，不能把本批称为已完成公开模式。

- 同一作用域的 cell 串行执行，共享恢复状态、可信备份及预算；每个 cell 新建 VM，JS 全局变量不跨 cell 保存。
  并发开启第二个 cell 明确拒绝，不悄悄添加后台队列。原生 undo 保留在宿主，guest 仍不能调用 undo 或 AMA/通用桥接控制项。
- 工作预算优先复用父上下文的 managed budget；无预算时按既有 cell 上限建立有限预算并挂到父上下文，
  避免关闭再打开作用域补充额度。叶执行记一次；拒绝不记执行次数；尝试数、传输、内存和时间仍由每个 cell 单独限制。
- 父取消、回调返回或抛错时关闭入口、取消并等待未结算叶调用及回执持久化，然后才允许父宿主释放绑定。
  旧闭包不能开启新 cell；主动放弃未等待的工作也不能留下后台写入。作用域退出不取消父上下文本身。
- 普通工具/脚本失败可以在下个 cell 做针对性修复；回执保存失败则停止接受本作用域的新 cell。
  前一 cell 已成功的写入不自动重放。新 Run 仍不恢复内存备份，上一节的跨 Run 边界继续有效。

独立评审发现并经红→绿回归修复三项：drain 现在观察返回给宿主的同一个 Promise，放弃等待且保存失败不会遗留未处理拒绝；
每 cell 重建当前能力投影，叶准入继续读取父 state 的实时清单，controller 替换数组撤销能力也立即生效；
父回调与 cell 保存同时抛错时用 AggregateError 保留两项，不让清理异常盖掉父错误。

本地案例参考仅抽取操作与失败类型：KodaX 主仓库 Session `20261013_115415_5ybc4517585d1b.jsonl`
第 48 条记录的 bash 回执为 Exit 128、`is_error:false`；`20261013_000923_4mc693dfecd06d.jsonl`
第 6/25/37 条 bash 回执分别为 Exit 255/128/1、`is_error:false`。
不把 grep/read 正文中的 “failed” 或 Exit 文本当作该工具执行失败，不提交原始对话、命令或私有文件。
由此构造合成的 read→edit→测试失败→针对性修复→测试通过案例，采用真实 Node 测试、可信文件写入及原生叶基线；
这不是完整重放原 Session，更不是新一轮模型自主表现评估。

连续推进顺序保持 A/B→C→D→E→F：本批关闭父 Run 边界后，D 余下按工具家族验证，优先检查
`changed_scope/changed_diff` 的绑定、完整输出与取消，不把其余 Repo/LSP 一次全部开放。
undo 仍是待资格候选；不因同上下文原生撤销通过就把 guest undo 宣称已验证。
E 的三选项入口、Session 恢复和模型请求表示必须在 D 资格与装配核对后接线；F 的真实模型配对本轮不运行。
离线对照只能证明所列任务没有新增发现调用或重复叶工作；模型选择脚本的轮次、总 token 和智能表现仍待后续有界配对。

最终验收：父 Run 新增 14 项；Script/真实工具/原生调用/undo/子执行器/独立 bundle 共 10 文件 125 项通过，
默认工作面及 wire 两文件 3 项通过，合计 **12 文件、128 项通过**，无未处理异常。
真实读改测修复任务两侧均 5 次叶执行、2 次编辑，Script 两个 cell 不自动插入发现调用或重做第一段；
这只是受控任务执行量等价，不把 cell 数当模型往返数或把 fixture 耗时当模型推理耗时。
coding 构建、根 source/test 类型检查通过；host-invocation/run 两模块定向覆盖率为
语句 97.61%、分支 95.23%、函数 94.11%、行 97.14%，不冒称全仓覆盖。
规范轴原 1 项、需求轴原 2 项均修复并独立复核关闭；本批未重跑全仓，先前 OAuth 全量超时记录保留。
测试日志及覆盖率位于 OS Temp `kodax-script-parent-final.log`、`kodax-script-parent-coverage/`。

最终 Windows 抓包 `kodax-first-turn-wire-Km4KFu` 相对 `kodax-first-turn-wire-QLtW7t`，
16 个归一化完整请求 hash 全部相同，外部调用 0。没有减少 Coding 默认首轮 token，也没有增加默认注入。
本轮复核源码构建的独立 bundle；不重复宣称实际 npm tarball 或各平台二进制已重新验收。

### D 变更调查工具组：changed_scope / changed_diff（2026-10-25）

内部 pilot 仅新增这两个现有 builtin，合格叶从七项变为九项；原 registry/handler、模型契约投影、
权限、预算及父 Run 持久化链继续复用。两项直接使用本地 Git，不另依赖 RepoIntel 服务绑定。
`changed_diff` 对模型仍使用既有 `paths/limit_per_path` 契约；旧 `path/limit` SDK 输入保持兼容，
不额外开放 `changed_diff_bundle`、undo 或通用桥接，不增加发现/描述步骤，不改 Coding 默认或 AMA 策略。

离线验证使用真实临时 Git 仓库：暂存/未暂存/全部/提交区间、重命名/删除、中文空格路径、未跟踪文件、
多文件去重、分页及继续提示。scope 只归一化两处生成时间后与原生比较，其余字段保留；diff 正文逐字比较。
另比较预算 2/4、相同权限拒绝、已准入参数错误后恢复、Agent/显式排除/运行期撤销、完整回执及传输上限失败。
单一区域任务在一个 cell 中读取范围、选择全部 source 路径并读取多文件 diff，父 Run 保存两份回执，
恰好两次叶执行；没有自动插入发现调用，也没有借该案例替代跨区域任务的 AMA 派发策略。

完整任务暴露并修复一个**原生已有的路径解析缺陷**：非 NUL Git 输出会给带空格/Unicode 路径加引号或八进制转义，
原 changed_scope 将这些展示字节当成路径，导致 source 被分类为 other、区域归属错误，甚至出现虚假的跨区域提示；
compare 的按空白拆分也无法保留重命名的目标和连续空格。Script/原生字节相同并不足以证明任务质量。
原生回归在 `core.quotepath=true/false` 下先红；修复仅将 changed-scope 的 status/name-status 读取改为 `-z`，
按 Git 字段保留原路径并分别处理 status 的“目标→来源”、diff 的“来源→目标”顺序，沿用仓库已有 NUL 读取方式。
不在脚本中剥引号或改写模型参数来绕过错误，也不调整 AMA 规划/派发。此修复同时惠及原生调用和自动变更摘要。

取消边界按现有实现如实保留：两项 Git helper 尚未接入 AbortSignal，changed_scope 还会写内部分析缓存。
取消后 Script 停止 VM/后续叶调用，但等待已准入 Git、缓存和回执结算再返回；这不是立即终止 Git 的承诺。
原生取消对照和 Script 均完成同一份已准入工作，Script 返回 cancelled 并保留该回执；预先取消不准入、不计预算。
不将内部缓存写入算成用户源码编辑，也不宣称这些 handler 完全没有磁盘副作用。
原 scope 自带文件数/省略提示、diff 自带分页限制均保持；人为缩小 cell 传输上限时明确失败，完整原生正文留在宿主回执，
不静默截掉字段。此测试不是“所有尺寸的输出都无需后续读取”的证明。

最终定向回归 **17 文件、178 项通过**：工具/Script/父 Run/RepoIntel 等 15 文件 175 项，
默认工作面与 wire 两文件 3 项；本批新增 Script 15 项及原生路径回归 2 项，无未处理异常。
coding 构建及根 source/test 类型检查通过；pilot 局部覆盖率为语句 93.75%、分支 86.04%、
函数 91.66%、行 97.61%，不冒称全仓覆盖率。规范轴 0 项、需求轴 0 项；未重跑全仓，先前 OAuth 超时记录保留。
日志与覆盖率在 OS Temp `kodax-script-changes-final.log`、`kodax-script-changes-coverage/`。
Windows wire `kodax-first-turn-wire-s6fUAq` 对照前批 `kodax-first-turn-wire-Km4KFu`，16 个归一化完整请求 hash 全部相同，
外部调用 0。决定：这两项通过内部 Script 资格；不公开启用 Script、不修改原生 undo，不据离线回归宣称模型智能非劣。

### D 仓库调查工具组：repo_overview / semantic_lookup / cyclic_dependencies（2026-10-25）

最小生产改动仅扩展内部 pilot 的 builtin 资格清单，九项增至十二项；不改 registry、handler、
公开 SDK、专用角色、AMA 或 Coding 默认菜单。三项使用原模型契约投影、权限准入、预算和回执链；
不插入 search/describe、补参数或额外模型路由。relationship_scan 与四个窄工具留作下一组。

新增离线测试 `tests/first-turn-script-repo.test.ts`：真实临时双包仓库包含符号与双向导入，
独立断言源文件、符号和两模块循环，避免“原生和 Script 同样错误”也算质量通过。
比较完整正文，只归一化 Snapshot/generatedAt 时间；另比较 guest 返回值与宿主回执、真实刷新、
语义结果上限提示及小传输上限失败后的完整回执。正常查询使用真实索引 worker；warming 使用受控 worker 延迟，
仍走实际等待上限、渲染与执行链，再恢复真实 worker；off 使用实际配置分支，不把这两类退化当成成功的空分析。

权限拒绝在两侧走同一 dispatch，不计执行预算；已准入的参数错误计一次，可在同一 cell 恢复。
验证预算 2/4、Agent/显式排除/实时撤销、预取消零准入，以及准入后取消的原生结果对照。
父 Run 的概览→符号→循环调查在一个 cell 完成三次叶调用并持久化三份回执；无自动发现、重放或模型调用。
它是受控执行路径对照，不能把一个 cell 当成模型只需一轮的实测证明。

三项仍可能写内部分析缓存，工具级取消尚不主动终止已准入扫描/查询；Script 等待该调用和回执结算。
RepoIntel worker 是共享服务，查询等待超时可 detach 并继续后台预热；销毁 cell 不销毁共享服务。
这延续原生服务生命周期，不承诺取消后所有后台索引活动立即停止，也不引入跨 Run 服务或更宽权限。
原生 semantic_lookup 在 off 下仍以空匹配摘要附 capabilityStatus/warnings 表示不可用，Script 完整保留这些字段；
未借本批重写已有降级契约。离线结果只用于内部资格，不证明自主选择、全任务 token/耗时或智能水平非劣。

最终定向回归 **14 文件、122 项通过**：新增本组 20 项包含在 Script/父 Run/Repo 的 12 文件 119 项中，
另有默认工作面与 wire 两文件 3 项；无未处理异常。根 source/test 类型检查及 coding 构建通过。
规范轴 0 项、需求轴 0 项；本批未重跑全仓，先前 OAuth 全量超时记录仍保留。
Windows wire `kodax-first-turn-wire-8XlltY` 相对 `kodax-first-turn-wire-s6fUAq`，16 个归一化完整请求 hash 全部相同，
外部调用 0；因此本批未改变默认首轮注入，不报告虚构的 token 节省或模型质量结论。
日志位于 OS Temp `kodax-script-repo-final.log`、`kodax-script-repo-wire.log`、
`kodax-script-repo-types.log`、`kodax-script-repo-build.log`。此为源码构建与离线资格验证，不替代最终实际发布包验收。

### 连续推进顺序（2026-10-25，关系工具组开始前）

按能力家族连续完成，不再逐工具重新申请确认；每组验证失败时先定位，仅停止依赖该失败的后续接线。
不为凑完清单新增服务或放宽隔离，能保留原生表示的工具不强行改成 Script。

| 剩余批次 | 范围与完成判据 |
| --- | --- |
| D1 关系调查 5 项 | relationship_scan、module_context、symbol_context、process_context、impact_estimate；复用现有执行链，覆盖 refresh、降级、完整输出和既有权限/预算/取消 |
| D2 LSP 8 项 | 按共享绑定、懒启动和服务恢复统一验证；明确关闭与未启动不能混淆，不能用 Script 绕过绑定条件 |
| D3 知识/历史/网络 6 项 | memory_recall、session_history_search/read、kodax_manual、web_search/fetch；离线受控服务验证权限、取消、出处、截断与错误，不新增真实模型评测 |
| D4 装配闭环 | 接入正式模型入口和完整叶契约；原生控制项、undo、SDK、专用角色保留；核对脚本包装与叶预算不重复计费，首轮成本包含全部契约 |
| E 模式与恢复 | Agent / Coding / Script 单一切换入口；公开 SDK/CLI/REPL/Session 的空闲切换、持久化、旧会话兼容和模型切换；Coding 默认 |
| F 发布与效果验收 | 实际发布包与离线 E2E；之后另按有界 GLM/Kimi 配对核对质量、串行往返、全任务 token/费用/耗时，再作发布决定；当前不跑模型 |

当时还有 **19 项叶资格、装配闭环、模式接线、最终验收**；undo 单独保留原生，不计入必须脚本化的 19 项。
叶数不是完成百分比，也不等于可节省的 token。可连续推进离线部分；在真实模型配对之前不能宣称 Script 已达到最终智能与效率目标。

### D1–D3 工具家族连续资格验证（2026-10-25）

按用户授权，先验证关系五项，再推进 LSP 八项、知识/历史/网络六项；每家族先红→最小清单开放→离线验收。
本批生产改动只有 `script/pilot.ts` 的 builtin 资格清单从 12 项扩至 31 项。
无新增配置、执行器或路由；复用原注册、模型契约投影、dispatch/post-processing、预算、绑定与恢复。
Coding 默认、AMA、SDK、专用角色、原生 undo 和 prepare 兼容入口未改变；不删除底层能力。

- **关系五项**：复用真实双包仓库与 worker，逐项对照正文和来源，独立断言符号/文件/调用证据；
  改源后 refresh 获取新符号/流程，warming 采用受控 worker 延迟后恢复真实服务，off 保留原降级提示。
  relationship_scan 的索引组合、可选 grep 和无 LSP 提示保留；一次 scan 只记一次叶预算，2/4 对照无重复计费。
  它的组合输出不是四个窄工具全部字段的替代，本批保留所有入口，没有隐藏实验。
- **LSP 八项**：受控宿主服务逐项核对参数、1-based→0-based 坐标、进度/取消信号、完整正文与服务失败恢复；
  另用实际本地 JSON-RPC fixture 进程执行八项，incoming/outgoing 沿用内部准备，不增加模型 prepare 调用。
  未启动服务仍可用，明确关闭且无绑定才不装配；宿主注入可用，移除绑定或排除工具即时生效。
  测试不需要安装或访问外部语言服务器；不据 fixture 宣称所有第三方服务器已兼容。
- **知识/历史/网络六项**：复用真实历史检索/分页与本地 HTTP 服务，MemorySession 回调提供受控证据。
  保留记忆低权威声明、来源、历史 revision/分页和 system 条目隔离；search→read 在同 cell 用返回引用，未插入发现。
  原生拒绝、准入后错误、预算 2/4、取消与绑定撤销均验证。HTTP 503 仍按原生回执标注非成功状态，不伪称 fetch 成功。
  网络仅访问 loopback fixture，无公网/模型调用；不据此推断在线搜索质量或真实 MemorySession 检索效果。

大网页验证曾因测试把“原生完整 handler 输出”当成“完整模型可见回执”而失败。
校正基线为相同 dispatch + post-processing 后，两侧原生容量摘要及恢复文件相同（仅文件路径归一化），
文件内容逐字等于已采集正文，仍带 SOURCE_INCOMPLETE 网络采集上限警告。
另用小 cell 传输上限验证显式失败与完整宿主回执；没有扩大网络/传输上限来通过，也没有移除原生输出保护。
原生大输出本来就可能需要读取恢复文件，本批不宣称任意大小输出都能免去后续读取。

取消边界依旧区分：LSP 接收取消信号；RepoIntel 的共享索引预热、Memory/历史宿主回调和现有 web handler
不因 cell 销毁自动终止。Script 阻止下一叶并等待已准入调用/回执结算；web 仍使用原生等待上限，
不承诺宿主自定义回调能够被强制中断，不引入后台队列或独立服务。隔离、预算、能力条件不因资格开放而放宽。

截至本批，**D1–D3 叶资格完成，31 项合格，undo 继续原生**。剩余正式交付是 D4 模型入口/完整契约装配、
E 单入口切换与恢复、F 实际发布包及效果验收。本批未接入公开 Script、未调用模型，
也未把离线同等执行量当成自主任务质量、token 或耗时非劣；模型验证继续遵守先离线与有界预算。

最终离线回归 **19 文件、249 项通过**（工具/Script/宿主/本地协议等 17 文件 246 项，加默认工作面与 wire 两文件 3 项），
无未处理异常；关系矩阵 51 项、LSP 30 项、检索 21 项包含在上述总数中，不重复累计。
根 source/test 类型检查、coding 构建及 diff whitespace 检查通过；规范轴 0 项、需求轴 0 项。
未重跑全仓，先前 OAuth 全量超时记录不变。Windows wire `kodax-first-turn-wire-hluknW` 对照
`kodax-first-turn-wire-8XlltY`，16 个归一化完整请求 hash 全部相同，外部调用 0；默认首轮输入未增未减。
原始日志在 OS Temp `kodax-script-families-final.log`、`kodax-script-families-wire.log`、
`kodax-script-families-types.log`、`kodax-script-families-build.log`，不提交 raw 日志。

### D4 / E 正式模型入口、三模式与恢复（2026-10-25）

在 `5ebfbc0c` 加工作区的 D1–D3 资格基础上，正式 managed Run 现在可显式选择 Script。
模型看到 `script_exec` 与实际获准的完整叶 JSON Schema，执行仍经既有 dispatch、权限、post-processing、
预算及父 Run 状态；不调用 search/describe 才取得参数。原生 AMA 控制、SDK 显式 profile 和专用角色不改。
合格叶最多 31 项；undo 继续原生。Script 只支持前台 shell，因此**原生 bash 同时保留**，后台能力不靠额外发现恢复。
这是保留能力所需的一个重复契约例外，不能把 25 个 native 入口误报成只有一个工具或更低首轮成本。

正式模型回执保留每项原生正文、错误、警告、出处/分页 metadata 以及真实图片块；省去重复的原始参数副本。
本轮曾尝试成功结果摘要，但文本中的 SOURCE_INCOMPLETE/HTTP 非成功状态不总有结构化错误标志，故撤回该过滤。
没有新增正文成功分类器；不宣称已经取得中间结果过滤收益。C 阶段“回执仅存宿主”是当时内部入口范围，
正式 D4 为保留模型证据增加了上述结果投影；完整 canonical 回执仍在 Session extensionRecords 中保存。

宿主独占 transcript 保存时，FileSessionStorage 通过既有串行写入队列原子追加 Script extensionRecords，
避免过期全量 snapshot 覆盖宿主历史/标题。SDK 宿主须实现 `appendSessionRecords` 才能采用此路径。
保存失败关闭当前 Run 的 Script 绑定；普通 guest 参数错误可修正，已写文件不回滚、不自动重放。
真实叶事件送达原 AMA stall/Todo/记忆观察器，外层包装不重复扣叶预算；取消等待已准入调用及回执结算。
多 cell 共享父 Run 的现有预算和备份，VM 不持久化；旧记录只有证据作用，不恢复跨 Run undo 权限。

容量恢复同时识别 Script 中真实读取的 canonical 路径；完整契约放不进窗口时不能悄悄隐藏 `script_exec`
或声称不存在的桥接可以恢复。原生大结果分页/恢复仍可能需要后续读取，不能据此承诺所有任务都没有恢复往返。
生成 checkpoint 沿原恢复链保存 workMode；检查点只恢复生成边界，不新增 cell 重放机制。

模式选择与兼容边界：

- `--work-mode` 与 `/work-mode` 使用 Agent / Coding / Script；状态栏不再以 AMA 作为用户模式名称。
  `/mode` 仍控制权限。没有全局 workMode 配置；误存或旧 config 中的同名字段不影响 Coding 默认。
- Session 普通与 versioned 更新都在同一 owner 准入边界检查活跃 Run；忙时拒绝，不排队隐式切换。
  空闲选择随 Session 恢复，模型变化不重置；清除选择回到 Coding。CLI 单次覆盖沿既有 CAS 恢复，保留并发修改规则。
- 旧 Host 未公布 workMode 能力键时，客户端在发送设置或清除前拒绝并提示升级，其他旧设置不受影响。
  Script 切换与 Run 准入用无工具 VM 做本地自检；缺 Worker/QuickJS 明确报错，切换失败保持原模式。
  这增加少量本地启动工作，不产生模型请求，也没有另建执行链或配置服务。
- 低层 `runKodaX/startKodaX` 的 Script 请求明确拒绝并指向 managed Run；产品继续 AMA，受信任 SDK 可用
  `runManagedTask` 或 Runtime 的 managed_task Run。显式 profile/专用角色继续原装配，不机械继承父模式。

离线验证包含正式入口的读取→编辑→本地测试、拒绝后继续、编辑失败后重读修复、取消、原子回执和宿主历史保护；
覆盖原生预算与事件次数、图片真实性、容量恢复、小窗口契约保留。Runtime 实际依次切换三模式，
运行中两种设置接口均拒绝，Script 同 cell 读取后收尾。两次受控主生成是夹具约定，不是模型自主完成率证据；
辅助请求被单独捕获/阻止，不把它们混作第二次主生成，也不把 synthetic usage 当账单。

同 Windows、同 Runtime Host、相同权限/任务的完整首轮序列化估算如下（非真实 usage、非 provider BPE）：

| 模式 | native 入口 | OpenAI 全模型输入 | Anthropic 全模型输入 |
| --- | ---: | ---: | ---: |
| Coding 默认 | 54 | 20,011 | 19,645 |
| Agent | 36 | 16,379 | 16,143 |
| Script | 25 | 21,981 | 21,826 |

Script 相比 Coding 增加 **1,970 / 2,181**，主要来自完整叶契约在描述中的表示、编排教学与保留原生 bash。
Agent 减少 **3,632 / 3,502**，同时选择了少 18 项专项入口的通用工作面，不是 Coding 等能力压缩。
因此仍保留 Coding 默认；Script 的后续价值要看真实依赖任务的完整质量、往返、token/费用和耗时，不能用入口数宣传节省。
最终抓包为 OS Temp `kodax-first-turn-wire-UW7OAm`，32 场景、外部调用 0；其中原有 16 场景与
`kodax-first-turn-wire-hluknW` 的归一化完整请求 hash 全部一致。sourceHashes 额外记录 Script 契约、
资格、模式、投影、容量规划和 Runtime 源文件；旧版默认比较只按相同场景比较，不绕过同源码复测的守卫。

本轮完整 build、SDK 声明与 source/test 类型检查通过；实际 npm tarball 在临时目录由公共 SDK 完成
两次受控主生成、真实 read 及回执持久化，删除 Worker 后在模型前明确失败。
独立 Worker 不依赖 node_modules；公共 SDK 按 package.json 声明绑定本机已安装第三方依赖作离线安装模拟，
不联网安装，不将首次裸解压缺 iconv-lite 的测试夹具错误算作产品回归。未发布产物。
本批未重新验证 Windows 单文件二进制或 macOS/Linux，不外推此前内部探针为最新正式入口的平台验收。

定向回归：Script 家族/入口/恢复 **14 文件 258 项**；模式/CLI helper/显示 **7 文件 107 项**；
RPC/旧 Host/单次 CLI 设置与恢复 **4 文件 127 项**；wire 一项与 npm 包两项通过。
原始日志均在 OS Temp：`kodax-script-formal-family-final.log`、`kodax-mode-e-final.log`、
`kodax-mode-host-boundaries.log`、`kodax-modes-wire-final.log`、`kodax-script-entry-pack.log`；不提交 raw。
没有重跑全仓，之前 OAuth 全量超时记录仍有效。规范轴和需求轴最终均无未关闭发现；
需求复核曾发现执行器缺失准入与全局旧字段继承，两项均以离线失败用例确认后修复。
新增模型装配与工作模式模块的定向覆盖率：语句 92.98%、分支 90.74%、函数 94.44%、行 95.34%
（4 文件 24 项回归；日志 `kodax-script-entry-coverage.log`）。仅覆盖这两个模块，不代表全仓或 Worker 子进程覆盖率。

剩余 F：最新版实际二进制/跨平台验收，以及在另行允许真实模型时做有界 GLM/Kimi 配对和复杂 E2E；
比较完整任务质量、报告真实性、串行往返、总请求、token/费用与耗时。本轮零真实模型调用，
不把离线等价当成智能非劣证明，不改变默认，不继续删除工具或扩大 Script 后台边界。

### F 最新发布包离线验收（2026-10-25）

在上述 D4/E 工作区上，用本机 Bun 1.4.4 重新构建 win-x64 二进制，并按 release workflow 的成员清单
生成实际 ZIP。`tests/release-work-modes.test.mjs` 解压该 ZIP，在独立临时配置和仓库中启动包内 executable、
真实 daemon 与 managed Run，由公共 SDK 和包内 CLI 驱动；provider 仅连接本地 synthetic SSE。
子进程环境不转发真实 provider 密钥、代理或 KodaX 覆盖项。Windows 子 PATH 仅保留系统工具，
`where node/bun` 均退出 1；这是 Windows 发布程序的运行验证，测试驱动自身仍使用 Node。

实际 ZIP 的八个场景通过：

1. 无设置采用 Coding，Agent 切换后请求菜单相符；运行中普通及 versioned 设置接口均拒绝切换。
2. Script 同 cell 读取、编辑后主动抛错，文件修改和原始错误回执均保留。
3. 换模型、停止并重启 daemon 后保留 Script、模型及完整回执；新 Run 读取修改后文件，不重放旧编辑。
4. 真实 read 回执持久化后取消正在执行的 cell，Run interrupted，后续写入未发生。
   相同脚本不取消的阳性对照能够完成后续写入；有限循环避免用不可达代码伪证取消。
5. 包内 CLI 的单次 Agent 覆盖完成后恢复 Session 的 Script；清除选择回到 Coding。

另外，移走实际包内 Script Worker 后，切换在生成前明确失败，原 Coding 设置保留，请求数不增加。
合计 **11 次主生成、18 次本地 HTTP 请求、0 次外部模型调用**；数量由夹具规定，不是自主任务往返或智能表现证据。
实际 ZIP SHA-256：`234efb893efdc1c28e1f40454dc3ed25f5ae64bf62f0d9749e7bd9d9738c404d`。
完整请求与结果在 OS Temp `kodax-release-evidence-iTPRXw`，不提交原始日志。

本轮首先发现 CLI 手写 help 缺少工作模式说明，补了 `--work-mode`、`/work-mode` 两行后重建发布包。
另一失败是测试清空 PATH 时同时移除了 Windows 系统 PowerShell，导致 daemon supervisor 无法启动；
仅修正测试环境，未改 supervisor 或放宽隔离。两次失败原始证据分别在
`kodax-release-evidence-vBYrmA`、`kodax-release-evidence-k0RbfO`。
生产差异仅上述 help 文本，未改 Coding 默认、AMA、SDK、专用角色、工具能力或生成/恢复路径，未增加发现往返。

平台验收边界：

| 平台 | 本轮结果 |
| --- | --- |
| Windows x64 | 最新实际 ZIP 完整离线验收通过；子 PATH 无 Node/Bun |
| Linux x64 / arm64 | 未实测；本机无可用 WSL/Linux 环境，未跨编译冒充运行验收 |
| macOS x64 / arm64 | 未实测；无对应宿主 |

release workflow 已将同一 archive gate 放在五个平台各自原生 runner 的打包后、上传前；
本轮没有触发远端 workflow，因此该接线不代表四个未测平台通过。POSIX 夹具保留系统 PATH，
未来通过也不能据此声称已验证 POSIX 无 Node/Bun 环境。

实际 npm tarball 的两项发布测试再次通过；独立 Worker 与公共 SDK 的依赖边界仍按 D4/E 记录。
发布 workflow、模式命令、状态显示和 CLI helper 定向回归 **4 文件 86 项通过**，source/test 类型检查通过。
构建日志 `kodax-modes-release-build.log`、`kodax-modes-windows-binary-build.log`，
ZIP、npm、定向回归日志分别为 `kodax-modes-release-archive.log`、`kodax-modes-release-npm.log`、
`kodax-modes-release-regression.log`，均在 OS Temp。不重复计入此前用例、不宣称全仓回归通过。

F 的 Windows 与 npm 离线发布部分完成，其余原生平台运行及真实任务效果仍待验证。
本轮按要求不跑真实模型，不把合成响应验证当成质量、费用、耗时或智能水平非劣结论；Coding 继续默认。

### 2026-10-25 完整方案进展补充

上述“本轮不跑模型”是发布验收批次的历史边界。后续已按用户授权完成紧凑教学候选的GLM/Kimi
真实Coding复杂编辑：4run全部完成修复、实际测试、独立6项oracle与AMA收尾；工具不删、SDK及
专用角色不变，没有增加发现调用。详细反例和全任务计账见
[紧凑教学验证第8–9节](compact-teaching-validation.md)。GLM候选总请求16→17、Kimi16→13，
不能确认效率非劣；紧凑教学仍为eval-only候选，不默认启用。

| 工作包 | 当前状态 | 尚未完成 |
| --- | --- | --- |
| A–E：统一装配、Agent工作面、Script执行/宿主生命周期、模式切换与恢复 | 已实现，离线验收 | 不以离线通过替代智能/全任务效率保证 |
| F：实际发布包 | Windows ZIP及npm离线通过 | Linux x64/arm64、macOS x64/arm64原生运行验收；CI接线不等于已运行 |
| 紧凑教学与全能力兼容 | 完整候选、113项离线回归、GLM/Kimi真实Coding复杂E2E完成 | 默认采用决定；往返/耗时非劣尚未证实，保留报告小误差及fault范围限制 |
| 最终三模式真实任务效果 | 当前Coding候选有上述证据 | Agent及Script最终真实任务质量/效率；Script评测的叶调用范围/预算守卫需先离线核对 |
| 更大幅度首轮压缩 | pi/Codex/DSH源码及成本审计完成 | 尚无已验证、保持全部能力又无额外往返的数量级缩减方案；不删除SDK唯一契约或强推发现调用 |

因此完整方案**未全部实施并验收完毕**。下一步先收敛尚未验证的发布/Script边界和基于既有轨迹的
契约价值审计；不继续为单个小改动反复付费，不把候选估算收益算作已上线收益。

### 2026-10-25 Script 复杂评测边界与契约复核

本批仅修改测试辅助代码，不改变产品提示词、工具菜单、SDK、专用角色、AMA 或 Coding 默认。
先以真实 Runtime + Script cell 的离线反例确认：旧复杂评测只在 provider 输出处预检，
看不到 cell 动态产生的叶调用，保护文件写入可漏过评测范围检查。因此先修评测，未调用付费模型。
这不是已发现产品权限绕过：夹具本来使用 full-access，缺失的是评测自定义文件/预算边界。

`runComplexRuntime` 现在在实际工具执行前复用同一范围策略；原生和桥接已预检的调用不重复计数，
Script 叶调用纳入共享工具上限。拒绝仍保留原参数，恢复性错误返回工具回执；不可恢复的范围违反
或超额先停止再执行。`nestedToolCount` 是评测观测，不是新增产品预算；评测上限保留原有
桥接容器加目标的口径，Script 同样计容器和叶调用，不能用该数冒充 provider 往返次数。
新增 workMode 只用于选择真实 Runtime 模式，默认仍是 Coding。Runtime 已解析但失败的结果也记录 error，
避免 phase=failed 却 error=null 的不完整报告。

该私有缓存夹具不需要外网、历史会话或记忆读取，故评测守卫显式拒绝六项外部检索/会话入口；
未从产品隐藏这些工具。changed_scope/changed_diff 的目标路径以及 paths 数组/兼容字符串也加入
同一范围检查。这里仍是有限夹具的 scope check，不能宣称通用 shell 或操作系统安全沙箱。

本批验证包含受保护写入在副作用前拒绝、外部检索不触网、同 cell 原始拒绝后读取合法证据、
跨 cell 共享上限、原生/桥接不重复计数，以及已有子 Agent 拒绝恢复和 AMA 收尾回归。
同 cell 恢复由合成响应确定性驱动，证明执行链不强迫新增模型往返，不证明真实模型必然作同样选择。
定向回归先通过9文件83项，随后补外部检索和原生/桥接计数断言，重跑受影响2文件21项通过；
最终覆盖84个不同用例，不将重复执行相加。`tsconfig.check.json` 与 `tsconfig.test.json` 类型检查通过。
曾误用构建用根 tsconfig 直接 noEmit，触发 rootDir/src-dist 混用诊断；按仓库 source-check 配置
重新检查后通过，未为该命令错误修改产品代码。本批外部模型调用数为0。

协作、Todo、交互契约的源码/现有四条真实轨迹复核结论：

| 家族 | 本批确认 | 决策 |
| --- | --- | --- |
| spawn/followup | model_hint、provider/model、effort、agent_id、isolation、fork_turns 和证据引用各有执行语义；quality_strategy 已是短对象说明，不是大块展开 schema | 保留；四条轨迹未使用某字段不能证明字段无价值 |
| Todo | 模型投影已移除 runner-only op/init/items；todo_list 已支持按 id 取详情。状态可能被其他 actor/hook 改变，必要刷新有价值 | 不重复计算既有收益，不强制每次 update 前读取，也不删除恢复说明 |
| 交互 | 单问/free-text 与批量 select、默认值到期行为、自定义输入的继承存在不同契约 | 保留现有参数；不能为合并 schema 改写宿主语义或引入发现往返 |
| 根教学 | 已有完整紧凑候选，真实任务仍有 GLM 总请求增加的反例 | 保留 eval-only；不为约857 token 反复重跑，也不加固定复核回合来补偿报告小误差 |

既有 GLM 候选的额外子请求发生在读取后补 grep；root 生成的子任务 objective 也不同，
不能仅凭 child 提示词未改就排除间接影响。Kimi 的报告数量误差保留，不通过修改输出纠正。
暂无可直接进入默认、兼顾全部契约且确认不增往返的新工具删除项。

下一验证单元是最终 Agent/Script 的真实任务资格，而不是再次比较小幅教学候选：复用同一复杂
任务、生产默认教学、GLM/Kimi 各模式一次，冻结新 revision 和预算；没有失败后自动重跑。
先审修复/测试/拒绝恢复/AMA 收尾及报告，再列主/子/辅助请求、叶调用、完整 token/费用/耗时。
已有 Coding 数据只能作历史参考，不与修过评测守卫的新运行混成严格因果 A/B。
真实模式验收尚未执行；Linux/macOS 原生发布包验收也仍未完成。完整方案不标记完成。

### Agent/Script 真实任务验收预注册（2026-10-25 r1）

按用户授权使用 zhipu-coding/glm-5.3 和 kimi-code/kimi-for-coding（显式覆盖 eval 默认 alias pool），
复用缓存缺陷复杂任务，每路由每模式一次，共4run、1个case；Layer 3.5资格观测，不作提示词因果比较。
先 GLM Agent / Kimi Script，不同provider并行、同provider串行；主会话核实评测有效性后再跑剩余两格。
离线已验证机制，但不能替代真实模型自主选择工具、组织脚本、拒绝恢复与报告真实性，因此需要本批。

每格上限32个主/子/辅助请求、80个含容器的工具尝试、root 24轮、至多1个只读继承模型child、
120万token、15分钟、参考USD0.15；每请求输出4096、180秒、singleAttempt，无fallback。
四格合计上限128请求、480万token、参考USD0.60；参考成本按SDK费率估算，非订阅实际账单。
未知usage保守计账并按现有辅助取消契约处置。预计成本沿既有Coding观测在USD0.03–0.08数量级，
上限不是消费目标。不重跑失败格，不扩大隔离或预算，不改写调用/输出，不额外调用judge。

使用生产模式装配及默认教学；不应用紧凑教学候选。保持原夹具 lsp:false、空skills目录、
独立home/仓库，故不声称覆盖全部集成。生产AMA、SDK、专用角色和Coding默认没有改动。
原只读child首目标read故障保留：同read目标持续拒绝，其他合法工具可用；仅验证工具拒绝恢复，
不冒充跨工具资源封锁。范围守卫和叶调用预算采用上一批修复版本。

冻结全部相关源码、manifest及逐请求原始输入到OS Temp `kodax-eval-dumps/work-modes-full-complex-20261025-r1`。
主要审查三文件修复、新测试能否暴露原缺陷、真实测试与独立6项oracle、保护文件、child拒绝与恢复、
报告准确性和AMA终态；其次列root/child响应、辅助请求、物理尝试、工具/叶调用、token、费用和耗时。
无完整任务质量的短轨迹不算节省；非盲资格评审不包装成盲化A/B，单样本不保证智能或效率非劣。
历史Coding仅作带版本差异的参考。冻结后不修改执行源码；只读审查、独立反事实测试和结果文档允许继续。

### Agent/Script r1 结果与剩余项

四格各一次已完成观测，无重跑、fallback或预算扩张；GLM Agent完整修复、13项测试、6项oracle、
只读child及AMA收尾通过，新测试在原缺陷实现上检出6失败。另三格因评测shell范围拒绝被硬中止：
GLM Script为echo分隔符（其另一条for循环也不支持），Kimi Agent为fc，Kimi Script为mkdir tests。
禁止命令均未执行；Kimi两格已做正确修复，但没有新增测试/最终报告/完整收尾，不能算完整通过。

40个provider操作、39个已观测物理尝试，保守计账686,905 token、参考USD0.019968；
两次辅助取消的未知usage保留预算。Agent首轮更小，但GLM完整任务操作20次，高于历史Coding的16次；
版本、轨迹和缓存不同，不能作因果比较，更不能宣称全任务效率非劣。完整数字及质量限制见
[模式任务资格验证](work-mode-task-validation.md)。2716份冻结输入依赖结束复核无变化。

下一步先离线修评测拒绝反馈：保持禁止命令不执行，验证模型能收到原始拒绝并继续合法替代，
不靠扩白名单或改写命令。之后才决定最小补测当前未完成格；本批没有再烧模型。
Linux/macOS原生发布包验收、最终模式质量/效率和紧凑教学默认采用决定仍未完成。
Coding默认、AMA、SDK、专用角色及全部底层能力不变，完整方案继续标为未全部验收。

### 拒绝反馈已离线修复；收益目标保持全任务口径

2026-10-25后续批次：评测shell范围拒绝统一交回原工具错误，原生/桥接/Script均不执行
被拒命令；白名单、解析和路径检查与r1冻结源码逐字相同。预算/取消仍终止，生产权限/预算不改。
真实Runtime的四条原命令恢复、只读child、预算截断与Script取消回归通过：定向10文件94项、
source/test类型检查通过，0模型调用。细节及初始失败见[资格验证后续记录](work-mode-task-validation.md)。
离线前提已齐，最小付费补测候选仅剩GLM Script、Kimi Agent、Kimi Script各一次；
先一个Script格校验新评测有效性，不在本批执行，不重跑已完整通过的GLM Agent。

当前优化的目标不是统一追求最低首轮数字，而是：

1. Agent按通用工作面省去专项常驻契约；当前完整Host估算比Coding少3,632（18.15%）。
   这是工作面选择的收益，不能说Coding在保持同一菜单的前提下已经压缩18%。
2. Coding保持默认及完整编码能力，继续只收敛确切重复教学。现有完整紧凑候选约857/858 token，
   相对Agent/Coding约5.2%/4.3%，仍为候选收益，不是已进入默认。
3. Script保留完整可调用契约，当前首轮反而比Coding多约1,970。潜在价值在将确定性、有数据依赖的
   工具步骤放入同一cell，避免每一步都经过模型；当前原始叶回执仍完整回传，不承诺减少中间输出量。
   原生工具原本就能同响应并行，不能把本已并行的操作包装成Script收益。
4. 默认采用的门槛是任务质量/报告/恢复可靠、没有由设计强制新增的发现往返，再核实全任务
   请求、token、费用、耗时。少量首轮收益若伴随全任务额外调用，不据此推进默认。

近期不承诺将保留完整AMA契约的KodaX无损压至pi的约1–2k或DSH Minimal几百token，
也不承诺全任务固定百分比节省。参考项目的简洁表达与规则归属仍可借鉴；数量级目标需要更强证据，
不能用删能力、隐藏必要教学或把额外发现成本移到后续轮次来达成。

### r2 GLM Script完整闭环与新装配问题（2026-10-25）

新守卫版本仅补GLM Script一次：模型在python命令被拒后自主改用内置write，完成三文件修复、
新增10项测试并实际执行11/11通过；独立oracle 6/6，新增用例在原缺陷实现上检出6失败。
只读child收到read拒绝后使用合法工具完成调查，报告准确，AMA completed且无活动child。
12次请求（root8/child4）、236,840全任务token、参考USD0.012125、157.92s；无发现调用或重跑。
历史Coding是16次/已知278,815 token/243.99s，但版本、轨迹及缓存不同，不作因果收益或非劣保证。

真实Script叶回执意外注入旧SA“重新以AMA运行”教学。零模型的同三响应Coding/Script Runtime
对照确认：只有Script经旧post-processing触发反思，原生AMA没有；不是评测拒绝反馈故障。
模型本次没有重复运行，但该装配差异可能误导后续模型，故暂停尚未启动的Kimi两格。
本批没有修改冻结生产代码，也没有为通过重烧GLM；原始证据和完整质量限制见
[模式资格验证r2](work-mode-task-validation.md#r2-实测与离线追查结果2026-10-25)。

最小下一步：修正父AMA Run与Script叶执行的反思教学归属，保留变更追踪、预算、恢复、容量处理
及SDK独立执行兼容；先固化离线反例，之后冻结新revision补Kimi Agent/Script各一次。
完整方案仍未全部验收，Coding默认、AMA与全部底层能力保持不变。

### 基础版收尾决定（2026-10-25 r3）

用户要求停止逐项扩展研究，按基础交付收口。本批仅对借用父Runner的Script禁用旧SA反思追加，
保留tracker、权限/预算/恢复/容量链和独立SDK原行为；生产差异限于三处内部接线，无新用户配置。
原生/桥接/Script真实Runtime三文件编辑与测试反例先红后绿；8文件99项通过，source/test类型检查、
完整构建、真实npm包2项及Windows ZIP的8个场景通过（发布包测试0外部模型调用）。

最终2717份源冻结下Kimi两格各一次，43次provider请求、已知927,924/保守941,432 token、
参考USD0.004951/0.005029，无重跑、fallback、边界放宽或人工改写。Agent 12/12、Script预设13/13
实际测试通过；两格独立oracle 6/6，新测试在原缺陷实现上分别检出6/5失败，保护文件不变，child与AMA收尾。

**采用结论**：

- Coding保持默认。Agent作为通用工作面可选，首轮较小不保证完整任务更省。
- Script保留显式实验选择；GLM先前已实际执行cell，但本次Kimi绕行兼容桥接并做1次发现，0个cell。
  这证明兼容路径完成任务，不证明Kimi自主使用Script，且不能满足“实际没有额外发现往返”的效果目标。
  不强制脚本、不删除桥接来刷结果，不在本批继续调教学或重跑。
- 紧凑教学继续候选，不进入默认。两格Kimi请求23/20次，高于历史Coding16次；版本、轨迹和缓存
  不同不能归因为模式退化，也没有足够证据宣称非劣。基础功能验收与效率优化采用分开下结论。
- Linux/macOS原生发布包未实测；Windows产物验收可交付，不将CI配置冒充其他平台通过。

本批基础交付工作结束，无继续自动烧模型的待办。余项记录为后续有独立价值证据才启动的工作：
Script跨模型采用与完整任务效率、紧凑教学采用、Linux/macOS实机验收；不把这些开放目标包装成已完成。
