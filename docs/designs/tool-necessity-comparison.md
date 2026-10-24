# 全量工具必要性审计：KodaX / Codex / DSH / pi

> 当前 78 项清单、保留判断和模式方案见 [全盘工具与注入方案](tool-portfolio-plan.md)。
> 下文是历史逐项证据：local code_search 已退出普通 root 默认入口，普通 anchor 恢复已迁移；
> “无 Goal 按需”和“Repo/LSP 低频就延迟”不再作为当前默认建议，旧成本口径不可叠加。

2026-10-24；**源码审计与取舍提案，未删除工具、未改变产品默认值。**
完整设计与验证顺序见 [精简默认工具面与可选程序化调用](tool-mode-design.md)。三个固定预设的最优性判断已撤回。
开发契机、历史收益依据的校准，以及 GLM/Kimi 现有轨迹的离线归因见 [工具开发契机与退役边界](tool-origin-and-retirement.md)。local code_search 的历史 adoption 不证明排名或最终任务收益；当前仍为退出候选，未改变默认入口。

## 结论与比较口径

本轮已逐项审计固定registry的**78项**：下列55项＋18条件项＋5兼容别名；另审动态来源与3个辅助请求schema。逐项区分底层价值、独立入口价值、首轮必要性，不能以“有契约”直接判定常驻。当前没有证据支持54项全部首轮必要，也不支持照抄另一产品的少工具数。
**local code_search 是最明确的默认目录退出及local后端弃用候选**；insert_after_anchor 也应独立验证退出默认入口，不能拿共享CAS作为其独占价值；
Repo/LSP、产品手册、历史等适合按职责/启用情况按需呈现；Todo/Goal、Actor、记忆治理、可信撤销不应为减少名字而丢契约。
新增确定性探针发现RepoIntel会覆盖编译器已解析调用边，并存在absolute/cwd归属和LSP workspace接线错配；先修准确性，不能把结构化输出等同更可靠。
全量审计新增：agent_output/角色目录、worktree、manual/history/Memory读取、无Goal状态下Goal都有按需空间；ask及spawn/Todo专参值得投影实验。MCP发现与Construction模板也可收敛，但不属于当前默认首轮主要成本。读写、消息/追问、计划状态不能仅靠一个万能operation工具假装等价。

固定源码：KodaX `8d3f05e0db20df6ce9c07a0130e5c55c041cc614`；Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`；
DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；pi `136b87e8a7f5a3e5186de0289523ba327dc592fc`。
“没有”只指检查的内置/preset 没有独立同类入口，不是框架不能扩展。没有作者动机证据，不把自己的工程推论写成其删工具的理由。

KodaX 实际 embedded AMA 请求是54项；完整交互 Host 曾多 exit_plan_mode 成55项。下表逐项覆盖这55项，之后补条件能力和已收敛别名。
registry 原始定义不能直接当首轮菜单：还有 alias、model schema projection、宿主和 activation gate。
Codex 也有 Goal/notes/history control extension，不能说它们只属于 KodaX；具体曝光取决于宿主注册。[K0][C4]
78项是静态内置全集，不包含未知第三方工具。当前直接导入registry核对78唯一名称，所有能力flag启用的resolver去5alias为73；这不是某真实Host能同时运行73项的保证。历史Runtime54全部有对应定义，本文78个表格条目与registry精确对账，无漏项/多项。

### 本轮统一成本口径

对已有2026-10-23 Runtime54冻结请求，按每项`{name,description,input_schema}`紧凑JSON用当前countTokens估算；54项单项估算与当前源码投影一致。不是新抓包、BPE或账单。表格下述类别相加为11,885（逐项取整）；整个tools数组为11,881，不能和旧完整Host工具表示12,509混作同一序列化口径。

| 家族 | 项数 | 单项估算之和 | 解释 |
| --- | ---: | ---: | --- |
| 基础/交互/隔离，不含Plan | 11 | 2,728 | ask793，grep394，read328；anchor127仅小部分 |
| Todo | 3 | 1,091 | create373/update557/list161；状态保留不要求全参数常驻 |
| Goal | 3 | 526 | 可按真实Goal状态呈现，不能删生命周期 |
| Actor与角色目录 | 8 | 2,064 | spawn730；output149/目录199可先按需 |
| Repo与code_search | 11 | 2,253 | 多数是专项/便利，不能全部凭名称判必要 |
| LSP | 8 | 1,094 | 服务有价值，八项首轮无须齐备 |
| Memory/History/manual/skill/Web/发现 | 10 | 2,129 | memory_intent506/manual295；可分层但需治理和发现验证 |

anchor+local code_search仅341，不能把这两个例子当整体方案。每项去留以下独立判断；移除schema后需加发现目录/教学，模型也可能多往返，表中成本不是净节省承诺。历史Repo4/LSP8投影净省1,583仍单独保留在设计中，不与此表简单叠加。

### 为什么 Codex 可以没有这些独立名字

Codex 组合 shell、apply_patch、Web、技能/扩展与受管理协作，很多文件/搜索/Git 操作可写成命令或小程序，
因此不需要为每个动作单独 native 注册。其 CodeModeOnly 路径进一步把适合嵌套的契约移进 SDK，wire 工具少仍可能有大量真实契约；混合 CodeMode 仍保留对应 native。
DSH Standard 也提供 read/write/edit/grep/glob、Goal、Todo、Web；pi 默认四项是另一种能力组成，额外能力来自主动启用的扩展。

对 KodaX，shell 能重做某动作，只证明信息源/计算可覆盖，不证明同时保留权限、Windows 行为、可信读写、分页证据和失败恢复。
反过来，工具有独立契约也不证明值得首轮常驻。以下建议按“功能价值、常驻价值、替代验证成本”分别判断。

## 文件、搜索、隔离与交互（12 项）

| # / KodaX | 实际价值与重复部分 | Codex | DSH / pi | 取舍 |
| --- | --- | --- | --- | --- |
| 1 read | 切片、图片/二进制、缓存与可信读状态；是安全修改的证据输入 | shell 读文本；view_image 读图 [C1] | Standard read；pi 默认 read [D1][P1] | 默认核心；如引入PTC则可通过SDK调用 |
| 2 write | 整文件写入、trusted mutation、规范路径身份/CAS，防止覆盖旧读后外部修改 | apply_patch/shell [C1] | 两家均有 write [D1][P1] | 保留；不能仅用重定向代替 |
| 3 edit | 精确/归一化替换、批次原子、stale保护；已覆盖 multi_edit | apply_patch [C1] | DSH unique literal/replace_all；pi edits[] [D1][P4] | 保留，不另加 batch 工具 |
| 4 insert_after_anchor | 少重述原文、整物理行后插入/补换行便利；权限、可信写入、CAS与edit共用 | patch context+新增行，无独立anchor | DSH Standard edit，可选editor有insert command；pi edit [D5][P4] | 暂保默认：真实Windows Host已验证小段替代与撤销，但旧读恢复、大段限制和失败提示仍不同；约127tokens收益不支持先改恢复策略；不加编辑union |
| 5 bash | 权限分类、Windows配置Shell、超时、输出和进程树生命周期 | exec_command + write_stdin [C1] | DSH Windows pwsh/其他bash；pi默认bash，另有可选powershell | 基础执行器；PTC仍需它运行真实编译/测试 |
| 6 glob | JS glob+逐文件read policy，无外部二进制；当前无cap/分页且不读gitignore，不能称有界 | shell rg --files / 枚举 | DSH glob有cap；pi可选find有cap/ignore，与本工具语义不同 [D1][P1] | 暂保默认只读搜索通路；先校正/验证大目录边界，再谈shell-only |
| 7 grep | regex、路径/上下文、分页/不完整提示；覆盖多数本地搜索 | shell rg | DSH grep；pi可选grep，默认shell [D1][P1] | 保留；替代local code_search须验literal转义/长输入 |
| 8 undo | 仅恢复工具可信preimage；核验当前路径身份，避免丢掉用户原有未提交改动 | Git/反向patch可做部分恢复，无同receipt入口 | 两家默认无此receipt工具；DSH可选editor也无undo | 保留安全能力，历史约36token无必要先折腾 |
| 9 worktree_create | 受控Git分支/路径隔离与进程生命周期，非纯命令别名 | host worktree/spawn isolation或shell | Standard/pi默认无专用工具，可shell git worktree | 按需候选；不删隔离执行器，不改AMA策略 |
| 10 worktree_remove | dirty保护、路径身份、移除许可、Windows进程排空 | host生命周期或shell | 两家主要靠shell/宿主 | 同上；rm或git restore不等价 |
| 11 ask_user_question | 批量问题、单/多选、自由文本、宿主回调/到期；flat/batch和UI字段有重复 | request_user_input及async [C2] | DSH ask工具；pi基础无独立入口，可扩展UI | 真实Host支持时原生；优先实验一种常用批量投影，free-input/closed-choice/expiry与完整SDK保留 |
| 12 exit_plan_mode | 真实callback审批；现曝光先看callback，非Plan由callback拒绝 | Plan/交互宿主，无同handler | DSH权限Plan；pi扩展可实现交互 | 建议真实Plan+Host门控，需验证状态切换；Runtime54已排除，不能再算收益 |

KodaX：[基础定义](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:211)、
[可信写入](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/_internal/text-file-mutation.ts:194)、
[anchor](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/insert-after-anchor.ts:18)、
[恢复依赖](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/middleware/edit-recovery.ts:21)、
[undo](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/undo.ts:21)、
[worktree](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/worktree.ts:340)。

## Todo、Goal 与 AMA 协作（14 项）

| # / KodaX | 实际价值 | Codex | DSH / pi | 取舍 |
| --- | --- | --- | --- | --- |
| 13 todo_create | 安全append、单调id、before-create veto/event；当前create无owner输入 | 可选 update_plan 是整表 [C3] | DSH todo_write整表；pi todo(action)示例支持add [D3][P5] | 暂保核心；可后验append/PATCH同入口，不能恢复全表init冒充替代 |
| 14 todo_update | 已存在id的PATCH/delete/metadata、hook veto；evaluator仅特定wiring触发；owner不可patch | update_plan不含同义务 | DSH列表/状态更薄 | 暂保核心；先专参投影，后验与create表示合并，复用原wrapper/事件 |
| 15 todo_list | canonical ids及id详情，恢复/后台变化有价值；普通轮次不需仪式化读取 | plan+历史，无同store查询 | DSH快照；pi扩展list | 按需/恢复时呈现候选；必须先保留完整计划教学，不能等同删除读取 |
| 16 get_goal | 实时累计预算/时间/状态；continuation已有部分snapshot | 条件control extension [C4] | DSH同名；pi基础无 [D3] | 无Goal按需；有Goal避免重复snapshot读取，不另造任务分类器 |
| 17 create_goal | 显式授权是模型契约；handler校验objective/budget，binding检查已有Goal | 条件control extension | DSH有直接human/goal-round authority，不能外推KodaX | 按需创建；保留仅明确请求规则及SDK，不与Todo混合 |
| 18 update_goal | complete/blocked与活动child检查、Goal context计数；默认binding不等于质量验证器 | 条件control extension | DSH同名，状态动作和authority不同 | 有Goal保原生收尾，无Goal按需；unique-turn/授权边界需单独验证，不夹带策略改写 |
| 19 spawn_agent | 受管理身份、模型继承、读写/隔离、并发与工作预算 | 受管理协作spawn [C2] | DSH subagent/fork；pi为示例扩展子进程 [D4][P5] | 保留原生，策略不变 |
| 20 send_message | 活跃turn投递、broadcast/forward去重、防消息循环 | 同类协作 [C2] | DSH也能启动idle turn；pi基础无 | 保留；本轮不更改唤醒授权 |
| 21 followup_task | idle child开新turn，running投当前turn；admission/退款/history保留 | 与send共用flow但TriggerTurn/QueueOnly明确不同 [C2] | DSH send可唤醒；pi示例不是常驻Actor | 暂保，未来可显式queue/followup合并表示；禁止隐式唤醒或重spawn代替 |
| 22 wait_agent | mailbox/user唤醒和timeout，避免轮询；不是全量output读取 | 协作wait [C2] | DSH Standard靠完成通知/结束turn；Team实验插件另有wait | 保留；不因DSH没独立入口破坏收尾 |
| 23 list_agents | 活跃拓扑、容量、分页/revision、latest短摘要；初始context已有slots | 同类live list [C2] | DSH control注册；pi默认无 | 读取能力保留，按需/已有Actor时呈现后验；不得改后续派发前容量检查策略 |
| 24 interrupt_agent | 停止当前turn，保留Actor可续聊 | 同类interrupt [C2] | DSH同类；pi默认无 | 保留原生；不等于删除子Agent |
| 25 agent_output | exact turn的8192字符有界预览、structured/artifactDetails；不是全文 | 完成通知/结果事件，无同getter | DSH通知/列表；pi收集子进程结果 | 优先按需；普通通知可覆盖大意，旧turn/结构化恢复仍保留；核验result入历史后ack |
| 26 list_dispatchable_agents | executor/专用角色/外部协议及availability/revision，非活跃树 | spawn的agent_type目录 | DSH模型/preset发现；pi示例agent目录 | 优先按需；用tool_search发现此工具即可，当前search不能直接返回Agent descriptor |

KodaX：[Todo定义/约束](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1379)、
[Goal](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/goal-tools.ts:40)、
[Actor执行](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/agent-collaboration.ts:104)、
[角色目录](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/list-dispatchable-agents.ts:48)。

不能把两类调用机械合并：todo_update的legacy init会全表替换；send_message的QueueOnly不会启动idle turn，followup会。保留原store/controller与hook/预算不要求每个名字永远native，但新表示必须显式保留分支。Todo one-in-progress主要是提示，Goal完成也不能冒称独立质量证明。[K-Control]

**AMA教学耦合是前置验收项**：worker-role-prompt.ts:132的fullTodo/fullCollaboration检查名单全员。零模型模拟错误传入native-only名单，去agent_output让stable instructions从4,897变4,101、删32/加14行；去todo_list变4,288，去list_agents变4,126。此为未来错误接线模拟，不是当前线上回退。策略必须按实际allowed/discoverable能力保留，调用教学再指向native或发现/bridge。不能把误删策略产生的token下降计作优化。

## 仓库与搜索（11 项）

Codex、DSH Standard、pi基础默认没有下面专用结构capsule/图工具；都能通过文件/搜索/Shell、git、分析程序组合完成部分调查。
这是其可见替代机制，不是证明结构索引没价值。KodaX full/light当前内置，见模式设计的开关与版本说明。

| # / KodaX | 超出普通搜索的价值 / 重叠点 | DSH / pi 与 Codex 的覆盖边界 | 取舍 |
| --- | --- | --- | --- |
| 27 repo_overview | 有界结构/分区/manifest/入口聚合；target用于找root，不等于按subtree过滤；自动context已有时会重复 | 读manifest+tree/ls可组成；无同capsule | 便利封装，按需候选；自动注入与工具调用分别审查 |
| 28 changed_scope | Git范围/分类聚合，不是独立语义分析 | git status/diff --stat覆盖信息源，结果结构需重新组织 | 普通任务可用Shell；专用review保留，迁移教学但保留AMA范围判断 |
| 29 changed_diff | 多paths、未跟踪内容、补丁分页和续页便利 | git diff可覆盖大部分；未跟踪/稳定分页仍需处理 | 保留有界能力，按需独立实验；不以便利性证明常驻必要 |
| 30 code_search | **local仅路径/行字面includes**、固定分数、512文件页；provider分支不证明源码语义搜索 | 三家普通本地搜索均由grep/glob/shell覆盖；无必需同名入口 | **退出默认目录第一候选**，不是永久延迟；local后端列弃用候选，SDK/明确角色暂兼容 |
| 31 semantic_lookup | 对结构索引symbol/module/process名称排序、signature/canonical定位；不是embedding/概念搜索 | 普通rg提供文本位置，不自动提供结构实体/出处 | 先校正概念/范围说明，修索引准确性；有价值任务再按需 |
| 32 cyclic_dependencies | import图Tarjan SCC有独特算法；当前把SCC顺序画成环，可能含不存在的边 | shell脚本可重做，grep一次不等价 | 先修环见证，低频按需；不并入每次scan |
| 33 relationship_scan | 聚合四服务和可选LSP/text，无独立新图算法；depth只进提示不驱动多跳 | 三家无同默认聚合接口 | 按需候选，不再因聚合名就优先常驻；窄查询可能更便宜，未完整覆盖四项 |
| 34 module_context | 模块tests/docs/entry/top symbols/process线索 | shell读多文件可做；relationship不保证全部返回 | Repo4延迟候选，SDK/专用角色保留 |
| 35 symbol_context | signature/import/export/kind/callers/callees/alternatives | grep定位后读代码只能覆盖部分；LSP部分覆盖 | 同上，不当成relationship别名 |
| 36 process_context | 有界启发式entry及少数callee/第二跳steps、notes/alternatives，不是真实执行轨迹 | shell手工追踪可推理；聚合scan不总加载完整流程 | 同上；不能把有序steps宣传为精确运行流程 |
| 37 impact_estimate | 目标、调用位点、变更scope overlap的窄输出 | git+rg+推理可组成；关系总览未必含同细节 | 同上，保留窄查询效率 |

KodaX：[local/provider分流](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/code-search.ts:80)、
[literal实现](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/code-search.ts:27)、
[semantic查询](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-lookup-query.ts:34)、
[cycles](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/cyclic-deps.ts:74)、
[聚合scan](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/relationship-scan.ts:663)、
[窄capsule渲染](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-render.ts:22)。

local code_search 于 `ba5ae92aa8b704e9eb832ee8cb21a69ae602c32c`（2026-04-03）为durable memory anchors/retrieval加入，不是Code Mode必需。它早于2026-06-26的full/light引擎内置；Repo工具设计本身已于2026-03-28出现，不能混淆两次演进。
当前query是literal includes，path/content固定分数1/.8，不排名；provider分支走searchCapabilities，甚至可能搜索工具/资源目录，不能默认叫源码语义搜索。
已检查到注册、角色推荐、compaction/display/result处理，未发现固定生产算法必须执行local分支；外部SDK消费者仍未知。
本轮已离线对照literal元字符、长字面量、扩展覆盖、分页与可读回调，结果见下节。已有rg -F覆盖长字面量，不因一个参数限制立即添加grep配置或搜索router。

### 第二轮确定性证据与限制

真实source handler、临时文件、禁止网络、零模型调用：

| 检查 | 观察 | 判断 |
| --- | --- | --- |
| code_search vs grep/glob：vue/svelte/mts/sql/ps1目录 | local搜索候选0，grep/glob命中5个文件；直接指定文件可绕过local扩展过滤 | local不是更完整的通用代码搜索 |
| literal及分页 | 转义后的grep找到相同literal；300字符literal被builtin grep安全上限拒绝，但rg -F能查；单文件80命中取20，local续页跳文件，grep offset可接第21行 | 无独立搜索算法优势；不能把文件cursor等同匹配cursor |
| 小fixture输出 | 同20条结果估算local 1,657 vs grep 654；local诚实给limit警告 | 仅该fixture输出成本，非模型质量或总体性能结论 |
| 可读回调 | local未调用assertReadablePath，grep/glob过滤被拒文件 | 留存SDK需修回调；尚不能声称完整Runtime授权绕过 |
| anchor vs read+edit | LF/CRLF/唯一前缀完整行/Unicode原锚/缩进/无末尾换行六组字节相同，歧义都拒绝；500行插入用两项edit.edits一次原子batch可覆盖 | 不需新增工具/union；仍须可信宿主、并发与模型恢复验证 |
| anchor mixed-EOL | CRLF前文、LF锚行时anchor额外加空行，exact edit没有 | 补换行便利并非总更正确；记录差别，不为了等价改写预期 |

anchor/edit/batch共享text-file-mutation保护，成功edit也清理恢复状态；现有依赖主要是教学/提示和注册兼容，不是必须调用anchor的固定算法。
anchor探针走test fallback，不代表全Runtime；edit的旧读检查与共享snapshot→commit CAS也不能混作同一保护。

RepoIntel另以两包同名函数夹具复现：TypeChecker只解析A，但最终materialize把callTargets覆盖成A+B，并保留高符号confidence；
symbol_context已显示假callee/caller，impact多出B。持久缓存也没保存精确callTargets，修最终输出一处不够。
另复现绝对B文件被归A、自动子包cwd被当root、LSP无gitRoot时丢executionCwd。完整源位置和验收边界见[设计第5节](tool-mode-design.md#5-repointel复用已有开关先修不一致)。
process实测未命中调用边错误传播，relationship聚合未实跑，import SCC不能由此判错。全量审计另做独立纯函数反例：A↔B、A↔C的SCC成员正确，但cyclic_dependencies输出A→B→C→A，包含不存在的B→C。最小修复先如实报告SCC成员，或生成真实边见证；不能直接把SCC大小解释成某一具体环长度。raw为full-tool-audit-20261024-r1/cycle-witness.json。

角色提示仍有module先于多文件读取、symbol先于grep、changed_scope MUST first、review不用bash git diff等规定；
调用频次受教学强约束，不是工具自然价值证据。替代实验应允许同等文件/Git路径，同时保留原AMA的范围判断、派发和整合。
源码：[材料化](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-build-materialize.ts:328)、[缓存](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-workspace.ts:166)、[角色教学](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:259)。

raw仅OS Temp：kodax-eval-dumps/local-search-value-20261024-r1、kodax-eval-dumps/repointel-evolution-audit-20261024-r1（compiler最终r2文件）、anchor-tool-necessity-second-pass-20261024。
以上探针没有外部模型、真实LS或完整可信Host验证；没有改生产行为。

## LSP（8 项）

Codex当前默认没有内置同类LSP操作，用户可扩展；pi默认也没有。DSH有**选配单工具lsp(operation)，四操作**，Standard未默认装。
它证明少入口可行，不证明四操作覆盖KodaX八项。先延迟现有八项，统一operation另做实验。[D6][P1]

| # / KodaX | 真正语义价值 | DSH对应 | 取舍 |
| --- | --- | --- | --- |
| 38 lsp_definition | 编译器解析重导出/别名/重载的定义 | goToDefinition | 按需，保留真实语言服务 |
| 39 lsp_references | 精确引用，避免字符串/注释假阳性 | findReferences | 同上 |
| 40 lsp_hover | 当前编译类型、泛型与文档 | hover | 同上 |
| 41 lsp_implementation | interface/abstract具体实现 | goToImplementation | 同上 |
| 42 lsp_document_symbols | 文档结构符号与range | 无该操作 | 同上，不能误删 |
| 43 lsp_workspace_symbols | server级workspace symbol查询 | 无该操作 | 同上 |
| 44 lsp_incoming_calls | 自动prepare后incoming位点 | 无该操作 | 同上；prepare不需独立首轮 |
| 45 lsp_outgoing_calls | 自动prepare后outgoing位点 | 无该操作 | 同上 |

KodaX：[八项handler](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/lsp-navigation.ts:47)。
工具存在不证明当前机器装了server；warming/可按需启动与明确禁用分开。验1-based位置/UTF16、重命名冲突、重导出、失败与恢复，不能用regex fixture冒充语言语义。

## 记忆、历史、知识、Web 与发现（10 项）

| # / KodaX | 独立价值 | Codex | DSH / pi | 取舍 |
| --- | --- | --- | --- | --- |
| 46 memory_recall | MemorySession查询、decision revision/throughSequence绑定；不等于纯文件读取或零辅助成本 | 条件notes检索有真实backend [C7] | DSH/pi文件/skills无同治理默认 | 真实binding下按需候选；先验经验缺口发现率，保留原query/receipt |
| 47 memory_intent | 已为八操作单入口；真实用户turn/ref/fingerprint授权；legacy capture不等于持久化 | 条件notes五操作但不等价KodaX治理 [C7] | 两家基础无同治理 | 暂保根治理入口；家族延迟/专参投影可后验，不因治理必要就永久冻结全schema |
| 48 session_history_search | 找回压缩前persisted entry、lineage、分页/出处 | history control extension [C4] | DSH按显式session引用注入只读snapshot；pi Host/SDK历史，不是默认模型检索 | 按需候选；仅有宿主才呈现 |
| 49 session_history_read | entry_id/revision/分页恢复，system和lineage边界 | 条件history.read_item [C7] | 同上，快照只覆盖部分 | 与search一起按需验证；以后可history(operation)，先验版本/分页而非直接读session文件 |
| 50 kodax_manual | 运行版本自知识、产品重品牌/curate；不需读秘密配置 | skills/版本文档，无同专用入口 | pi prompt给安装版README/docs路径再read；DSH技能/文档 [P6] | 按需；静态内容可资源化，动态注册信息先验再替代 |
| 51 skill | 发现/loadFull、learned admission、args/动态context展开；通常返回展开说明 | 条件skills.list/read/installations [C8] | DSH原生skill；pi资源read [D7][P6] | 有可调用目录时保留；read只覆盖静态子集，PTC先控制面；低频按需另验 |
| 52 web_search | 搜索服务、provider/限额、来源与fallback | web.run search/hosted [C5] | DSH Standard同类search；pi靠扩展/MCP | 保留；两项本来小，不值得万能Web router |
| 53 web_fetch | HTTP GET/512KiB、HTML纯文本、最终URL/status；无builtin缓存，默认跟随redirect | web.run open [C5] | DSH fetch；pi扩展/shell | 先纠正Markdown/cache/3xx停止的旧说明；与search合并暂无净收益依据 |
| 54 tool_search | 当前有权限registry/run-scoped完整契约，exact/批量/无命中目录；不执行 | deferred search/catalog [C6] | pi内置tool-search；DSH PTC目前完整SDK | 延迟bootstrap必须原生；只返已允许能力 |
| 55 tool_call | 单目标JSON portable bridge，经原权限/预算/identity执行 | exec SDK dispatch有部分相似，但可程序组合 [C6] | pi/DSH真实nested executor更强，不是单次JSON包装 | 默认发现路径保留；PTC若实现则叶工具直接SDK，API兼容保留，避免递归桥 |

KodaX：[记忆](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/memory-intent.ts:18)、
[历史](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/session-history.ts:36)、
[手册](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/manual.ts:13)、
[发现](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:83)、
[bridge](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-bridge.ts:69)。
本组真实binding、Skill准入、Web和MCP源码补充见[K-Knowledge]；不能只读工具description后把所有声明当作已实现保证。

## 条件能力：不属于上述54/55项的固定开销

| 工具 | 价值 / 他家路径 | 模式建议 |
| --- | --- | --- |
| run_skill_script | Host runner校验准入脚本、inputs/outputs映射及promotion，不是shell别名 | 有runner/cwd才可达；默认ASRT在Windows直接拒绝初始化，custom SDK另验，不能冒称本平台已可用 |
| run_workflow | 受限wf API、显式意图、受管Actor/预算/恢复；DSH也有workflow，pi示例chain更薄 | 真实Host且明确请求才使用；当前PTC不代替它，也不自动扩大授权 |
| mcp_search | 远端snapshot、server/kind、revision绑定cursor、partial/容量恢复 | 条件入口；当前tool_search不索引远端具体capability。未来可统一发现，不可直接删 |
| mcp_describe | 精确ID完整输入/输出/参数/风险契约，搜索compact项不能代替 | **明确合并候选**：mcp_search增加exact/select全契约路径后隐藏别名；先验分页/schema容量/重连 |
| mcp_call | 远端tool kind执行，text/images/structuredContent/isError保留 | 维持原协议/权限；远端直接SDK可后验，不等于普通read或外层代码授权 |
| mcp_read_resource | 真实MCP session/auth/resource kind/内容 | 条件按需；可未来统一读取facade，但普通本地read目前不支持该协议 |
| mcp_get_prompt | 远端prompt kind/参数展开，结果untrusted | 有prompt catalog时按需；他家协议支持不代表默认有同模型入口，保留底层 |
| scaffold_tool | 纯返回版本化模板，无必须先调用的runtime令牌 | 专项内可资源化/退模型入口，SDK生成器留；模板有效性/首次成功率先验 |
| validate_tool | shape/AST/provider schema快检，不写disk；与test部分重复 | 可统一validator facade，保留确定性算法；先比较预stage失败恢复价值 |
| stage_construction | stageArtifact持久化、版本保护、重置tested状态 | 可与Agent stage按kind共享呈现，普通write不等价；低默认收益，后验 |
| test_tool | 当前模型路径做shape/AST/schema并stamp；没有文案所说handler materialize，也未传llmReviewer | 先校正真实检查说明；可后验test(kind)，不能拿stamp冒充执行验证 |
| activate_tool | 重新读持久artifact、testedAt/policy批准后注册 | 条件受控动作保留，不能shell改文件替代；可与Agent activation共享呈现但不降门槛 |
| scaffold_agent | 纯AgentArtifact模板，不写disk | 同scaffold_tool，专项资源化候选，无默认首轮收益 |
| validate_agent | shape/registered invariants/Runner.admit，readonly | 保留算法；可统一validate(kind)，不把Agent admission等同工具AST检查 |
| stage_agent_construction | 持久化且拒同名active冲突，防绕self-modify路径 | 可共享stage呈现，但必须保留冲突和版本分支 |
| test_agent | 当前handler未传sandboxLlm，实际模型工具不跑manifest testCases | 先校正说明/未执行项；是否补真实执行为独立能力与预算变更 |
| activate_agent | 重新admit后交resolver，后续Run绑定 | 条件可达，原re-admission/policy保持；不能把共享入口变成免验证注册 |
| stage_self_modify | manifest身份相等、active前版、ratchet/预算；激活审批与nextRun；handler未使用ctx，真实caller身份保证未在此证明 | 不恢复AMA入口；不因合并stage或PTC放宽。身份保证另核，非本轮已证实漏洞或顺手修复 |

Codex/DSH/pi都可扩展工具/Agent，但检查的默认内置未提供KodaX这套Construction阶梯的同义务接口；
因此不能用shell写插件文件当作生命周期等价。它们当前本就不固定首轮常驻，不应算进还能省的基数。
尤其Construction11被AMA_BASELINE_EXCLUDE固定排除；内部coding路径的toolConstructionMode不能解释成AMA打开同一flag就能使用。对应最小实验可晚做，不能占据默认首轮优化的主要预算。[K-Extension]
MCP三家均有不同呈现/发现机制；重点借鉴同registry多面，不因名字不同全部重建。
源码：[MCP声明](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1003)、
[Construction](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-definitions.ts:1895)、
[gate](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-resolution.ts:120)。

### 动态来源与辅助请求也纳入边界审计

| 来源/协议 | 本轮结论 |
| --- | --- |
| extension注册与extension_command__ | 名字、schema、handler可能来自用户扩展；仅按builtin来源收敛，不按同名字符串删 |
| activated constructed业务工具 | 不等于11个构造工具；关authoring入口不自动撤销已批准业务能力 |
| official-sandbox覆盖write/edit | 必须保留实际extension handler/policy，不能优化时跳回同名builtin |
| Run-scoped Host lease | 不一定在全局registry；发现、执行、撤销、resume保持同一绑定；未知Host工具先保现有呈现 |
| report_stall_judgment | 单独副判断的结构化输出协议，不在主Agent首轮菜单；保留机制，核对建议工具名跟随alias收敛 |
| select_memory_candidates | Memory候选精确ID选择，独立judge调用；不计主菜单节省，计全任务用量 |
| commit_episode_learning_review | 结束后Memory/Skill审议结构化输出；同样保留治理/账本，不能当一个可删普通工具 |

来源：[动态注册](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/extensions/runtime.ts:584)、[run-scoped装配](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:350)、[副判断](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/middleware/stall-sidecar/prompts.ts:76)、[候选选择](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/memory/intervention-selector.ts:18)、[episode review](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/learning-reviewer.ts:18)。

## 已收敛的重复入口，不能再算一次收益

| 旧入口 | 当前模型替代 | 底层保留理由 |
| --- | --- | --- |
| multi_edit | edit.edits | edit复用executeEditBatch；外部SDK兼容 |
| changed_diff_bundle | changed_diff.paths | 多paths能力仍在 |
| tool_describe | tool_search select | exact直接完整契约，避免重复教学 |
| todo_get | todo_list.id | 详情读取仍调用旧handler |
| lsp_prepare_call_hierarchy | incoming/outgoing内部prepare | 服务步骤仍需要 |

仅在builtin本体与替代builtin都可执行时过滤；同名extension不按名字误裁。
todo_update的op/init/items、edit旧单替换字段、changed_diff旧path/limit已做模型投影，不能按原始registry全schema计算收益。[K0]

## 决策与验收

1. **P0共同前提**：校准说明与事实，固定78项和动态source边界；保留allowed/discoverable清单，让model-visible投影不改变AMA策略。已有normal pressure planner与managed装配都验，不新增同义框架。没有证据的调用频次不作依据。
2. **P1低风险单变量候选**：manual、agent_output、list_dispatchable_agents、worktree双入口、History对分别走既有发现/bridge；local code_search/anchor单独验证退出root模型目录（SDK/明确角色兼容）。先pilot一个有判别力案例，不一口气跑全矩阵。
3. **P2 Repo/LSP**：先修compiler边/缓存、absolute/cwd、off、LSP workspace及SCC见证；再验证Repo4/LSP8，随后评估其余语义三项与overview/Git便利项。内部preturn服务与自动context单独量，不能把移模型入口误当停底层调用。
4. **P3高成本schema与状态**：ask常用输入投影、spawn/Todo高级字段；Goal按真实Session状态，todo_list/list_agents按需或恢复时呈现，Memory读取先于治理写操作。每组独立验发现、权限、原策略、compact/resume，收益不显著即保持原状，不加任务分类模型。
5. **P4条件工作面**：MCP exact-search/describe合并、Construction模板资源化/validate-test重复检查；只在该能力真的启用的夹具测收益，当前默认首轮收益为零。SDK与构造生命周期保留。
6. **P5更强替代**：LSP operation、Todo append/PATCH、message queue/followup、Actor读取面统一均可实验，但不是必须实施。更实质的multi-file patch、rg backend、resumable exec、PTC应按多文件/大仓/长进程/数据组合任务分别证伪；不夹进默认菜单精简。

### 各族最低验收，而非所有工具共用一个“跑通”

| 家族 | 离线必须保留的事实 | 模型阶段需要回答的问题 |
| --- | --- | --- |
| 文件/搜索/undo | sequential edit/CAS/旧读/Unicode/EOL/新文件undo边界；opaque读取；read-only无shell仍可查；ignore/分页/大目录/拒绝 | 普通读改测与歧义编辑失败后能否自主恢复；shell替代是否反而增加轮次 |
| worktree/交互 | 内部controller仍调用；dirty/分支删除失败/keep无cwd切换如实报告；ask三种binding、free input/closed-choice/expiry；Plan拒绝/resume | 能否发现隔离工具、不误删分支、不编造交互答案 |
| Todo/Goal/Actor | append不丢表、id/hook/evaluator一次；queue不唤醒、followup admission/refund；wait mailbox/user/abort；old turn/preview/ack-after-commit；Goal和child收尾 | 不强迫简单任务建计划；复杂任务规划/派发/整合不变，通知足够时不多读，必要时能恢复 |
| Repo/LSP | 同名/alias/re-export、cold/cache/incremental；绝对/子包/非Git；SCC真实边；真实LS UTF16/层级；warming不报无关系 | 调查/重构是否少读而准确，能识别不完整/启发式证据，不因工具名被强制先查 |
| Memory/History/Manual/Skill | root/child/无binding、引用revision/授权/receipt；system隔离/lineage分页；版本/重品牌；learned admission/动态context拒绝 | 自然记忆/历史/产品问题能否发现，不丢治理、不把静态read冒充Skill执行 |
| Web/发现/MCP | 本地HTTP fixture校准redirect/text/截断/失败；select/keyword/no-match；normal/managed；budget2/4；远端revision/kind/partial/schema容量 | 未知能力能发现，拒绝后选合法替代；不为一次小查询多做无谓发现 |
| 条件构造/辅助 | AMA11仍不可见/不可桥接；stage/test/activate真实阶段，policy reject、nextRun；Windows runner不降级；辅助请求全部计账 | 仅专项启用后再测，不因默认省token改变自修改/记忆/防循环决策 |

源码发现但未做新端到端反例的worktree不实返回、Construction测试说明失真、Goal/caller保证边界应逐项复核，不能把它们全部捆成首轮优化的无限前置修复工程。真实说明纠正、受影响候选的正确性修复与独立专项问题分开交付。

源码审计说明可覆盖与有区别；任务价值须由有界离线/GLM/Kimi配对与最终复杂smoke确认。比较全任务token、费用、耗时、恢复和诚实报告，
不从另一产品缺少工具推断智能，也不把首轮节约当普遍非劣证明。

## 参考源码索引

以下绑定开头pin，目录均为本地源码；后续HEAD更新需git show复核。

- [K0] [alias与能力过滤](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-resolution.ts:67)、[模型schema投影](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/model-tool-definition.ts:17)。
- [K-Control] [Actor有界输出/控制](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/agent/src/actors/controller.ts:52)、[Todo追加与PATCH](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/todo-store.ts:361)、[Goal binding](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/goal/runtime-wiring.ts:175)、[策略名单耦合](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:132)、[已有曝光planner](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-exposure-planner.ts:78)。
- [K-Extension] [AMA构造排除](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/role-exclude.ts:36)、[Tool构造handler](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/construction.ts:172)、[Agent构造handler](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/agent-construction.ts:150)、[真实test/activate](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/construction/runtime.ts:334)、[self modify](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/self-modify-tool.ts:160)、[Windows脚本runner](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/src/sandbox-runtime.ts:6281)。
- [K-Knowledge] [Memory绑定](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/memory-recall.ts:53)、[治理分派](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/memory-intent.ts:392)、[History loader](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/session-history.ts:20)、[Skill准入/展开](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/skill.ts:41)、[真实fetch](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/web-fetch.ts:84)、[MCP目录](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/mcp-search.ts:329)、[MCP契约](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/mcp-describe.ts:21)。
- [C1] [Codex shell / patch / image注册](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1240)。
- [C2] [Codex交互](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1315)、[协作注册](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1460)、[协作handler](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/multi_agents_v2)。
- [C3] [Codex Plan](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/plan.rs:75)、[Plan schema](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/plan_spec.rs:7)。
- [C4] [Codex control扩展分类](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/extension_tools.rs:124)。
- [C5] [Codex Web呈现](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:698)。
- [C6] [Codex Code Mode / discovery](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:955)、[tool_search handler](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/tool_search.rs)。
- [C7] [Codex History/Notes条件注册](C:/Works/PubProj/codex/codex-rs/ext/history-notes/src/extension.rs:51)、[后端](C:/Works/PubProj/codex/codex-rs/ext/history-notes/src/backend.rs:37)、[九项模型工具](C:/Works/PubProj/codex/codex-rs/ext/history-notes/src/tools.rs:35)。
- [C8] [Codex Skills条件工具](C:/Works/PubProj/codex/codex-rs/ext/skills/src/tools/mod.rs:58)、[read实现](C:/Works/PubProj/codex/codex-rs/ext/skills/src/tools/read.rs:44)。
- [D1] [DSH Standard全部composition](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:21)、[fs edit](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs/src/edit.ts:86)、[grep](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs-search/src/grep.ts:285)。
- [D2] [DSH新版PTC](C:/Works/PubProj/deepseek-harness/packages/core/tool-executor-ptc/src/index.ts:11)。
- [D3] [DSH Todo整表](C:/Works/PubProj/deepseek-harness/packages/todo/tool-todo/src/index.ts:137)、[Goal](C:/Works/PubProj/deepseek-harness/packages/goal/tool-goal/src/index.ts:196)。
- [D4] [DSH control](C:/Works/PubProj/deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts:28)、[subagent](C:/Works/PubProj/deepseek-harness/packages/subagent/tool-subagent/src/index.ts:210)、[实验Team wait](C:/Works/PubProj/deepseek-harness/packages/experimental/tool-agent-team/src/index.ts:250)。
- [D5] [DSH可选editor四command](C:/Works/PubProj/deepseek-harness/packages/fs/tool-str-replace-editor/src/index.ts:430)。
- [D6] [DSH选配LSP四操作](C:/Works/PubProj/deepseek-harness/packages/lsp/tool-lsp/src/index.ts:3)。
- [D7] [DSH skill](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:83)、[session引用](C:/Works/PubProj/deepseek-harness/packages/context/session-reference/src/index.ts:57)、[Web](C:/Works/PubProj/deepseek-harness/packages/web/tool-web/src/search.ts:363)。
- [P1] [pi默认四项](C:/Works/PubProj/pi/packages/coding-agent/src/core/settings-manager.ts:85)、[八种可选内置](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/index.ts:95)。
- [P2] [pi CLI扩展](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/index.ts:7)、[MCP](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:135)。
- [P3] [pi Code Mode](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:226)、[nested](C:/Works/PubProj/pi/packages/coding-agent/src/core/nested-tool-calls.ts:221)。
- [P4] [pi批量edit](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:23)。
- [P5] [pi Todo示例](C:/Works/PubProj/pi/packages/coding-agent/examples/extensions/todo.ts:25)、[subagent示例](C:/Works/PubProj/pi/packages/coding-agent/examples/extensions/subagent/index.ts:270)。
- [P6] [pi shell搜索/安装文档/skills](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:102)。

未证实：没有本轮真实模型收益结果；没有穷尽外部SDK消费者、第三方扩展和实际发行包的edition配置。
当前提案的入口去留不等于删除能力；local后端真正退役还需明确SDK兼容期限。
