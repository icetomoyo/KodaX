# 工具注入历史研究与程序化调用源码对标

> 当前整体取舍与验证顺序以 [全盘工具与注入方案](tool-portfolio-plan.md) 为准。
> 最新已对齐选择：一个入口 **Agent / Coding / Script**，**Coding 原生默认**。
> 全量分配见 [78 项模式分配](tool-mode-allocation.md)，改动与验收顺序见上述总方案。
> 下文保留历史提案、失败结果与源码依据；第 1、7、8 节的早期产品取舍已被总方案替代。
> 低频工具一律延迟、按无 Goal 状态隐藏，以及“暂不提供三模式”的建议都不是当前实施目标。

2026-10-24。**状态：完整提案，未实施新模式、未改变默认值、未新增付费调用。**
本文件接续 [此前的注入实验](tool-injection-modes.md)。第二轮审查曾撤回三个固定预设与
`toolMode=agent/coding/ptc` 提案；后续用户已选择单入口三模式，见顶部当前决策。保留这个过程以解释旧实验的范围。
本轮源码审计和确定性 Temp 探针没有付费模型调用；发现的缺陷及工具去留提案尚未实施。
全量复核现已覆盖78项固定builtin（55＋18条件＋5alias）、动态扩展/Host来源和3个辅助judge schema。逐项能力/替代/依赖/首轮判断见[全量审计](tool-necessity-comparison.md)。两个举例不再充当整个改动范围；以下计划按全量结论重排，仍不是批准删除78项底层服务。

## 1. 历史方案比较（产品取舍已被总方案替代）

Agent/Coding描述任务工作面，PTC描述调用方式。把两者塞进三档，会漏掉“通用Web/MCP研究＋程序化批处理，但不注入Coding上下文”的组合。
Codex的ToolMode独立于每工具exposure；DSH的executor可挂Agent/preset/deployment；pi Code Mode作用于实际callable集合，并不要求Coding任务。[C1][C3][D2][P3]

| 方案 | 优点 | 本轮不足 | 取舍 |
| --- | --- | --- | --- |
| Agent/Coding/PTC三个固定预设 | 一次选择完整行为，易解释固定清单 | 混合两种维度；通用任务要PTC会被迫带入Coding上下文，容易继续增加第四档 | 暂不采用 |
| 任务profile × 执行方式两个公开轴 | 通用/编码都能组合native/PTC，语义完整 | 新增两套选择/恢复/迁移；当前尚未证实需要两个稳定任务产品面 | 适合作为内部边界，暂不做两个用户选择器 |
| 一个精简默认面＋可选PTC＋已有能力开关 | 不要求用户先分类任务；普通工具直接用，专项按需；增量最小 | 仍需确定核心目录，自动仓库上下文也要单独审查；PTC本身仍有运行时成本 | 当时推荐；后续被单入口 Agent/Coding/Script 取代 |

默认优先采用模型熟悉、可组合的read/write/edit、grep/glob、Shell/Git路径，保留AMA控制与受控状态能力。
低频但独特的LSP/结构分析按需；功能重叠且无实证收益的独立入口退出默认目录，不为其永久保留一个延迟入口来回避退役判断。
AMA规划、派发、内部执行器与完成判断不变，不增加任务分类模型、路由Agent或强制阶段。
实现上只投影明确审计过的builtin候选集合，不改回“核心白名单之外全部消失”的能力装配；未分类的新工具、同名extension与Host binding保持既有呈现，避免重现历史漏工具问题。

SDK通用createAgent/Runner与Coding preset继续按调用方构造分层；已有不透明agentProfile/Host权限/专用角色不改造成两个硬编码产品身份。
通用agent包不能反向依赖coding名单。纯呈现应放在allowed inventory之后；toolVisibilityPolicy同时约束发现可达性，不能拿false冒充延迟。[K5][K7]

PTC只有证明组合/筛选减少全任务成本且恢复可靠后，才作为独立执行选择；可用于任何合法Host工具组合。
届时借鉴Only式单份SDK，不默认完整native再叠完整typed SDK；普通hybrid只作为必要的兼容实验。
如果PTC无净收益，可以继续只有一个精简native默认面，不因已有草案而强行实现。

证伪条件：若通用任务与Coding确实长期需要不同上下文，且固定profile显著改善质量/总成本，再开放独立任务轴；不能仅因为旧AMA显示位置空出来就增加持久产品状态。

## 2. 源码版本与已有同口径抓包

| 仓库 | 本轮固定 revision |
| --- | --- |
| KodaX | `8d3f05e0db20df6ce9c07a0130e5c55c041cc614` |
| Codex | `970111f6cb62cc02fe36a82ea7d71b37a2889c97` |
| DSH | `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` |
| pi | `136b87e8a7f5a3e5186de0289523ba327dc592fc` |

参考仓在审计中被外部更新，未对其 pull/reset。**下面抓包仍属于旧 pin**：Codex `deede7201da27a178c39befa6b4959bb7d451645`，
DSH `687f282e8625c6b8d11ff58211a90524be2e4317`。不能把旧数改标签冒充最新版。
均为相同 countTokens 的完整模型字段估算，含嵌入 SDK；不是 BPE、API usage、账单或 Codex UI 上下文读数。

| 已有 Windows 冻结请求 | 全输入估算 | 工具表示估算 | 边界 |
| --- | ---: | ---: | --- |
| KodaX 完整交互 Host / OpenAI，2026-10-23 | 20,276 | 12,509 | 55 native，含 exit_plan_mode |
| Codex Sol / 旧 pin 默认 Only | 17,048 | 9,271 | 11 native + 12 SDK |
| DSH Standard / 旧 pin | 9,325 | 7,234 | 31 native |
| DSH PTC / 旧 pin | 11,760 | 8,753 | 1 native + 30 SDK |

KodaX Host 比该 Codex 请求多 3,228，其中工具表示多 3,238；这是净差额，能力并不等价。
DSH 完整 HTTP 含 session/plugin 元数据，估算 23,228 / 28,097；服务端消费/计费未知，不能当模型输入。
最新版 DSH 的模型发现、plugin-manager 条件、PTC executor 都有实改，旧总量不能外推。
原方法、模型失败与限制见 [Windows 记录](first-turn-windows-comparison.md)。

## 3. Codex code_mode 与 code_mode_only

注册链：step model metadata / features → 实际允许 registry → exposure → native / exec SDK → 同一 nested dispatch。
模型显式 tool_mode 优先；缺省才按 Only feature → CodeMode feature → Direct 选择。
本地部分模型目录已直接指定 Only，因此 feature 默认 false 不能证明产品常规没有代码模式。[C1][C2]

| 项目 | Direct | code_mode：混合 | code_mode_only |
| --- | --- | --- | --- |
| 原本 Direct exposure 且可嵌套的工具 native schema | 有 | **保留** | 隐藏 |
| typed 参数声明 | 无 | 追加到对应 native 描述 | 集中进 exec SDK |
| exec / wait | 无 | 有 | 有 |
| DirectModelOnly 交互/控制项 | 原生 | 原生 | **仍原生** |
| deferred | 独立策略 | 独立策略 | 独立策略；不是所有工具自动延迟 |
| 代码隔离、nested 权限、并发、取消 | 不适用代码层 | 共用执行器 | 与混合共用执行器 |

混合的 augment_tool_spec_for_code_mode 保留 JSON schema，同时把原说明、参数与属性注释再渲染为 tools typed 声明。
Only 的 exec 更大，但移走了这组 native 双表达。[C2][C3]

同 Sol 完整目录、相同任务/Host/skills，仅改 tool_mode 的旧 pin 实抓（本地 mock、未调用模型、未执行 cell）：

| 模式 | 全输入估算 | 工具表示估算 | 相对 Direct |
| --- | ---: | ---: | ---: |
| Direct | 15,174 | 7,399 | 0 |
| CodeMode 混合 | 18,476 | 10,700 | +3,302 |
| CodeModeOnly | 17,047 | 9,272 | +1,873 |

混合工具增量 3,301 = exec 996 + wait 339 + 九项 native 重复声明 1,968 − 残差 2；整体另约 1 包装/舍入。
重复声明中 web.run 约 745、exec_command 479、write_stdin 275。Only 增量 1,873 = exec 6,703 + wait 339 − 撤去 native 5,147 − 残差 22。
Only 还因装配额外注册三个 MCP resource helper，约 431；三臂不是百分之百相同 inventory，不能把全部差额称纯 JS 开销。

当前 pin 核心 typed renderer、模型目录、execute/wait/delegate 与旧 pin blob 相同；namespace 默认描述、environment selector 接线有改动，
故旧请求精确总量不冒称当前 pin 总量。[C2][C3][C4]

### 切到没有 Only 的模型

- metadata 明确 Direct：下一 step 不再注册 exec/wait，可直接工具恢复 native，仍服从其他 exposure/权限。
- 明确 CodeMode 且执行宿主可用：变成混合，native 恢复并带 typed 示例；宿主不可用且允许 fallback 时会回落 Direct。关闭 Only 不等于关闭代码能力。
- tool_mode=null：重新走 feature 优先级，可能仍是 Only/混合，不能默认 Direct。[C1]

当前本地目录的 gpt-6.1-sol、gpt-6-sol、gpt-5.6-sol、gpt-5.6-terra 都明确 code_mode_only 且 use_responses_lite=true。
所以当前 Sol→Terra 并不是“有Only→无Only”的例子；工具面是否变化由目标 metadata 决定，模型指令与其他能力仍可能变化。
来源：[固定pin模型目录](C:/Works/PubProj/codex/codex-rs/models-manager/models.json)。

满足 ResponsesLite + incremental tools 时保留窗口并追加工具/模型差异，不抹掉旧 SDK、输出或 cell；非 Lite 不能套用同一结论。
cell 绑定启动 step，切 Direct 不证明自动取消或无缝续接。[C5]
KodaX 第一版只在 Run 之间切换；未结束 cell 先明确结束/取消，不照搬中途热切换。

代码模式价值在减少大结果入历史、工具依赖之间的模型往返，**不是首轮天然更小**。
真实 Codex renderer 对 KodaX 54 项做过纯序列化草图：全嵌套约 +595，九项控制原生约 +930；
无完整输出 schema、无 KodaX 执行器，exec/wait 是分析夹具，**不是本设计控制边界的预测值**。
最终须实抓“少量核心 SDK + 专项发现”，不承诺精确增长上限。

## 4. DSH / pi 可借鉴与不可外推

- DSH Standard 有 Goal 三项、Todo、异步子 Agent/fork/control、workflow、Web。send_message 能唤醒 idle child；完成通知和结束 turn 等待减少独立 wait/output，但不等价 KodaX 全部 Actor 契约。[D1][D3]
- 最新 DSH PTC 改独立 tool-executor-ptc，只 native 声明 run_code，prompt 仍渲染底层完整输入/输出 SDK；嵌套进共享 pipeline，未见 pi 式内联 token 预算。Minimal 关闭普通文件编辑等能力，不作同能力目标。[D2]
- pi 当前 CLI 默认 read/bash/edit/write 四项，可选 grep/find/ls/powershell；内置 codemode/tool-search/MCP 工厂。codemode 默认 inactive，MCP 间接能力可激活；裸 SDK 不自动装这些工厂，durable 不是 CLI 默认集合。[P1][P2]
- pi 已有 QuickJS 真实执行、on/only、nested hooks/usage、search/describe；默认 inlineBudget 3,000 估算 token 只管工具片段。其 on 对原生工具只补简短调用/返回说明，不能套 Codex +3,302。[P3]

采用Codex的registry/exposure/control边界、DSH可复现的能力构成与独立executor、pi的有界清单/发现思路。
不直接复制DSH预设数量；初期固定核心清单，不加公开inlineBudget配置或自动学习排序。

## 5. RepoIntel：复用已有开关，先修不一致

当前分支不能按“社区版无实现”处理：`51fb53d3`（2026-06-26）退役外部 premium daemon/client，改内置 full/light worker；
auto 当前解析 full，旧 endpoint/bin 告警忽略。bundle/binary/release 明确带 semantic-worker，未发现该引擎 edition/license 运行裁剪。
此结论不代表已核验所有发行包。[K1][K2]

已有 CLI --repo-intelligence、REPL /repo-intel mode、SDK Session repoIntelligenceMode，值为 auto/full/light/off；不再加同义布尔。
**已复现 off 不一致**：global env=auto、Session/Run=off，真实 AMA 的 54 菜单仍含 Repo；tool_search 返回 module_context，
tool_call 实际执行，得到 full/warming 并创建索引目录。三次本地 mock 响应、外部模型调用零。只证明这条 Session 显式路径，不能外推所有全局/UI 路径。[K3]

分两步，不能把行为调整藏进 bugfix：

1. 一致性修复先遵守**当前 off 工作集**，统一自动 preturn、AMA/内部执行器、native/discovery/bridge/SDK。按 Run 显式传 mode，不改进程 env，不终止另一 full Session 的共享 worker。
2. 单独调整开关边界：旧 working set 含 overview/Git/alias 共 11 名；建议真正依赖语义 worker 的七项受开关控制，基础 overview、changed_scope/diff 与 LSP 分开。会改变旧 off 的屏蔽范围，须迁移说明与独立验收。

以下为第二步调整目标，第一步不提前改工作集；旧11名含已隐藏alias，当前54菜单实际对应10项。
语义七项为 module_context、symbol_context、process_context、impact_estimate、relationship_scan、cyclic_dependencies、semantic_lookup。
off 时不注入、不发现、不嵌套执行这些能力；基础 Git、本地搜索与独立 LSP 不应被语义关闭误伤。
明确禁用/未交付与尚在 warming/按需启动分开，目录应报告状态，不伪装成功空结果。
当前auto/full/light默认保持。自动上下文是另一问题：现有新会话overview会自动注入，agentProfile没有纯注入配置，
repo off也不是“保留索引但不自动塞上下文”的开关。先审查已有新会话/task/Host条件与重复内容；只有现有明确信号无法满足真实需求时，再考虑最小上下文策略，不能宣称无须处理这条链。

### 第二轮已复现的演进错配

本轮固定HEAD源码、Temp两包Git夹具、零模型/网络；以下不是仅凭旧注释推断。原始输入、完整输出与探针保留在OS Temp `kodax-eval-dumps/repointel-evolution-audit-20261024-r1`。[K8]

| 接线 | 确定性观察 | 最小处理方向 |
| --- | --- | --- |
| compiler结果→最终索引 | A包localCaller仅调用本地sameName，TS analyzer只解析到A；最终full索引却改成A+B两个同名函数，仍保留0.99符号confidence | 保留已解析边，名称候选仅用于未解析情况；回归同名/别名/重导出及下游caller/process/impact，别把checker存在当精确性保证 |
| absolute path→模块/impact | 指向B文件的绝对路径被归到A模块且symbols为空；同文件仓库相对路径正确归B并含beta | 在受信任workspace/cwd边界规范路径，再匹配；显式目标无匹配应报错，不能静默选第一个模块 |
| 子包cwd→Active Module | executionCwd=packages/a、targetPath='.'返回仓库根；显式模块对照正确返回a。自动preturn也传'.' | 澄清当前工作目录与仓库相对路径契约，把自动当前模块与实际cwd对齐；不把所有点号路径一律改语义 |
| 无gitRoot的LSP workspace query | ctx仅有Temp executionCwd，fake client记录的root却是进程所在KodaX目录；补gitRoot对照才选Temp | 统一workspace选择，不能遗漏独立SDK/非Git工作目录；mock只证明接线，真实server语义另验 |

最严重的是第一项：有TypeChecker并不证明最终关系图保留了它的解析结果。修复前，不能将所有Repo关系工具宣传成比grep天然准确。
源码还显示显式refresh与自动bundle缓存属于不同路径，但本轮未复现缓存陈旧的完整链路；该项只列待验证，不冒称确证缺陷。
修复应同时检查持久索引/缓存版本和重建条件，防止正确的新算法继续读取旧错误边；不因此重写整个RepoIntel。
当前semantic-workspace序列化未保留精确callTargets，hydrate重新置空，因此仅修改最终materialize不足；必须在冷建、缓存恢复、增量更新中保留“已解析边/未解析调用”的区别，空边列表不能直接解释为全部已解析。
本轮下游实测已见symbol_context混入B同名callee、B出现错误caller，以及impact多出B模块；process夹具未命中该传播路径，relationship_scan未实跑聚合，不能声称所有图查询都已实证错误。import图SCC也不能据此判错。
全量复核另有**独立SCC反例**：A↔B、A↔C时成员集合正确，但cyclic-deps把Tarjan出栈顺序画成A→B→C→A，出现不存在的B→C。它不否定SCC算法，要求如实报告成员或生成真实边见证；不能称已检出具体三跳环。源码[cycle输出](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/cyclic-deps.ts:90)。此外relationship_scan的depth当前只影响warning，不驱动遍历；process为有界启发式，impact为邻域与changed overlap，不应宣称完整动态流程或风险排序。

## 6. 工具去留：任务能力、便利封装与运行保证分开

完整78项与动态边界逐项见 [必要性对照](tool-necessity-comparison.md)。上一版29/41/20的菜单数量是某种分组的算术结果，没有最优性证据，不再作为产品目标。保留底层、保留独立入口、首轮常驻是三项不同决定。

| 工具族 | 实质价值判断 | 建议方向 |
| --- | --- | --- |
| read/write/edit、grep/glob、bash | 通用、可组合且模型熟悉；DSH/pi也保留文件编辑。Shell可覆盖搜索/Git，可信文本写入继续复用现有host | 默认核心；不先新增patch工具或重写安全执行器 |
| local code_search | 普通文本/路径重复封装，非语义引擎；无已证实任务增益 | **退出默认目录并作为local后端弃用候选**；不是永久延迟保留；SDK/明确角色兼容先留 |
| insert_after_anchor | 少重述原文、整行尾定位/补换行的便利；CAS与权限不是独有 | **独立验证退出默认入口**；用现有read+edit替代，SDK/handler保留；不新增万能编辑union |
| repo_overview / changed_scope / changed_diff | 文件/manifest/git信息聚合与有界结果便利，无独立语言语义算法 | 可由read/glob/Shell Git承担普通任务；默认按需候选，review专用路径可保留原声明，不先删有界diff能力 |
| Repo语义七项 | 索引、结构归属、多跳关系/环检测有潜在价值；结果不全是compiler-resolved，且有上述错配 | 先修正确性，再证明具体任务增益；root按需、专用角色保留。relationship_scan不保证完整替代四个窄capsule |
| LSP八项 | 真正语言服务定义/类型/引用/实现/调用层级，rg不完全等价 | 按需、真实服务验收；未启动不等于禁用，四操作DSH例子不代表八项都重复 |
| undo / worktree | 可信preimage/路径身份、dirty保护与受管理隔离生命周期 | 保留底层；小undo不优先折腾，worktree可按需；git restore不等价undo |
| Todo/Goal/Actor | canonical状态、预算与调度/恢复义务；output仅8192字符预览，非全文 | 状态机沿用不代表全常驻：output/角色目录优先按需；Goal按真实状态；todo_list/list_agents后验。append/PATCH与queue/followup可后验表示合并 |
| ask / spawn / Todo专参 | 交互、派发、计划是核心；完整参数并非全为常用 | ask flat/batch及UI装饰优先投影；spawn/Todo专参随后，free input/closed-choice/权限/预算/恢复不可删 |
| 记忆/历史/手册/skill | 治理或恢复义务与静态教学混合；Skill有learned admission/动态展开 | manual/History/Memory读取先按需；静态资源化要安装版/Host兼容；治理写与Skill当前控制保留，后验发现，不永久冻结完整schema |
| 发现/bridge、Web、MCP/Workflow/Construction | 能力可达性与宿主gate | 复用，PTC不递归包装bridge、不跨越原gate；网络/扩展仅在真实可用时呈现 |

全量对账的54项冻结请求，单项紧凑JSON同计数器：基础11项2,728，Todo1,091，Goal526，Actor/目录2,064，Repo11项2,253，LSP1,094，知识/发现10项2,129；逐项取整和11,885，整个tools数组11,881。anchor+code_search仅341；不能围绕两个例子设计整个优化。此为历史请求definition分析，不是新抓包或净收益预测，也不与完整Host旧口径混加。

更有效替代也已纳入：多文件patch能增删改/移动并减少重复旧文；rg backend有成熟搜索实现；resumable exec减少长进程log轮询；PTC可做数据依赖和结果筛选。但它们都需要真实执行与兼容改动，不是已有免费替代。当前不新建fs、actor、state、repository等万能router；LSP operation、Todo显式append/PATCH、消息显式queue/followup有证据再做独立实验。

local code_search的$0对照：五种扩展目录查询（vue/svelte/mts/sql/ps1）候选数为0，grep/glob全部找到；
同一80命中文件取20条后，code_search只有下一文件cursor，grep可offset续到第21行；前20条输出同估算器为1,657对654。
300字符literal是当前builtin grep的限制，但已有rg -F可查询。code_search正确给limit警告，不是静默声称完整。
另确认local handler未调用每文件assertReadablePath，而grep/glob会；这是直接handler回调差异，未证明完整Runtime授权绕过。
这些是小fixture行为证据，不是模型质量/速度结论；raw在OS Temp `kodax-eval-dumps/local-search-value-20261024-r1`。[K4][K9]

anchor对照：Codex用patch context+新增行；DSH Standard与pi用普通replacement，可选DSH editor把insert作为command，三者均无需独立anchor工具。
当前read+edit在LF/CRLF/唯一前缀完整行/Unicode原锚/缩进/无末尾换行六组得到相同字节，双方歧义拒绝；500行插入也可用现有edit.edits两项单次原子batch。
mixed-EOL样本中anchor反而补了额外空行，已保留差别；这些直接handler/test fallback探针不是完整trusted-host或模型验证。
共享CAS/权限可由edit继续保留，不能作为anchor常驻理由。[K10]

目前worker提示有module/symbol优先、changed_scope MUST first以及review禁止bash git diff等规定。
因此“模型一直调用专用工具”并非独立价值证据。替代实验要同步迁移工具教学，允许等价读取/Git路径，
同时保留“先确定评审范围，再按原AMA规则派发/整合”的策略；不以旧工具名耦合阻止收敛。[K11]

### 全量复核带来的共同前提

Worker的fullTodo/fullCollaboration以传入工具名单全员判定策略段。纯函数模拟把仍可发现的agent_output从这个名单删掉，stable prompt从4,897变4,101、删32/加14行；todo_list为4,288，list_agents为4,126。这是未来错误native-only接线的反例，不是当前线上回退。策略必须读真实allowed/discoverable能力，wire schema单独投影；策略义务不变，操作教学允许发现/bridge。[策略构造](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:132)

已有normal链pressure planner与managed静态装配/容量恢复不同；ALWAYS_RESIDENT和isDeferredTool都会影响结果，改一个Set不足。复用现有投影与bridge，分别断言两个执行链、root/child、SDK、专用角色、同名extension、撤销lease。不要另建一套“模式路由器”。[planner](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-exposure-planner.ts:78)

说明要以实现为准：glob无独立cap/分页；web_fetch实际HTML纯文本、无cache且默认跟随redirect；test_tool没有materialize、test_agent模型入口未传sandboxLlm所以不跑cases。worktree remove源码吞分支删除错误却报deleted，keep/remove报Restored CWD但未切cwd，需要最小回归后修返回。不能为兑现旧文案补复杂新行为。[全量证据与来源](tool-necessity-comparison.md)

Construction11已被AMA固定排除，默认Windows Skill-script runner也不支持；二者不能算可省的默认首轮开销。MCP exact search/describe可合并、模板scaffold可资源化，列专项后续。辅助judge三项只在独立请求计费，保留并纳入全任务账本。

## 7. 历史 UI / SDK / 执行契约提案

- 当前不新增三档enum或任务profile选择器；先通过既有真实Runtime测试投影验证一个精简默认。产品默认未改变。
- generic SDK继续由Host提供instructions/tools，Coding/AMA继续由现有preset与角色构成；不把SDK分层误实现为用户切换两种执行器。
- 若PTC成立，只增加必要的执行方式选择（native/PTC），与Host profile和能力开关独立；具体公开名称/字段在运行时原型通过后收敛，避免先发布空设置。
- 该选择届时贯通Config默认、Session覆盖、Run快照、resume/daemon/embedded/SDK；显式会话选择不暗写全局默认。requested/effective、unsupported与旧session缺字段必须明确，不做半途静默回退重放。
- 第一版仅Run间切换，有活动cell先结束/取消；切模型只重验执行方式，不改变任务工作面或真实权限。历史回执与SDK显式SA兼容身份不改写。
- 原AMA状态显示可以移除，无需强行填三个新模式。PTC就绪后如需显示，仅显示实际执行方式；状态栏与启动视图一致，Shift+Tab仍为权限，不复活旧toggleAgentMode。[K6]

同一次可信绑定生成 allowed inventory、native、discovery、SDK、上下文/compaction 预算与 child briefing。
registered ≠ allowed ≠ shown；发现和每次执行重验权限，不能只隐藏 wire 却仍按全量 schema 预留。
模式在Run内固定；registry变化沿用原激活生效边界，各调用面取同一合法revision，旧句柄不延长已撤销权限，不另造热加载时序。
同名 extension / run-scoped 工具按 registration/source 身份处理。root 呈现不剥夺专用角色的原声明；
child 继承真实能力关闭与隔离上限，不继承 root 的首轮隐藏名单。既有 Skill/Workflow/Construction gate 不放宽。

PTC 的必要边界：

1. 真实受限解释器/隔离进程，无直达 Node FS/network/环境密钥；node:vm 不当安全沙箱。复用能力代理与原 executor，不复制工具实现；库选型等最小 spike 后定。
2. 内层逐次 scope/permission/classifier/可信读写/出处审计；保留原只读、路径身份、动态撤销。原生控制项不因脚本能见到名字而可嵌套。
3. work/provider/spend 预算恰记一次，外层 exec 编排/CPU 独立观测，不重复扣叶工作；预算 2/4、拒绝前后、child 和未知 usage 都对照 native。
4. Promise.all 遵守原读写锁/并发；数据依赖读真实返回。部分成功不自动重放整段；报告已完成调用、错误与恢复句柄。
5. 取消/超时排空内层与 Windows 进程树后才确认结束。输出有界，完整事实保留可读回执；截断/partial/warm/拒绝不能包装成成功，不捏造 typed 输出保证。

## 8. 历史最小实施与验证顺序

每个里程碑可单独撤回模型呈现；必要的正确性修复不随呈现回滚。下表是完整候选次序，不是把所有候选一次上线，也不默认每项都值得实现。本文全量源码分析已完成，模型效能结论尚未产生。

| 阶段 | 最小改动与范围 | 前置/验收与退出条件 |
| --- | --- | --- |
| P0 契约与装配边界 | 校正失真说明；固定78及动态source账本；allowed/discoverable与native呈现分开，保持原策略义务 | mock真实装配，normal/AMA/root/child/SDK均不漏能力；未知Host/extension不误删；错误隐藏不会走limited策略；不把策略缩水记作节约 |
| P1 常用默认中的低频/重复项 | 先挑manual/角色目录等只读候选pilot，再按证据选agent_output、worktree对、History对；local code_search/anchor单变量退出root目录，SDK/明确角色暂留 | 发现和实际调用/拒绝恢复/预算一次/receipt一致；output的old-turn/structured/ack、worktree内部调用不改；local留存read回调修好；anchor可信Host/CAS/undo验完 |
| P2 Repo/LSP | 先分项修compiler边及缓存、absolute/cwd、off、LSP workspace、SCC见证，再Repo4/LSP8，之后其余语义项及overview/Git | 同名/alias/re-export/cold/hot/incremental；多Session；真实LS；warming/partial不伪成功；内部自动context独立量。修事实会改变路由输入，但不改AMA策略算法 |
| P3 参数与真实状态 | ask常用batch投影且保留free-input等；spawn/Todo专参；Goal状态呈现，todo_list/list_agents恢复时按需，Memory读取再治理写 | schema完整SDK保留；无Goal/有Goal/compact/resume/child多波；不能为了省schema默认唤醒child或清空Todo；没有净收益就保持现状 |
| P4 条件能力 | MCP search+exact describe；Construction纯模板资源化，validate/test/stage可共用呈现 | 仅启用该能力的Host测；revision/kind/partial/测试真实阶段/激活审批；默认首轮收益零，不抢主线预算 |
| P5 更强替代 | 多文件patch、rg backend、可续接exec、PTC分别最小spike；LSP/Todo/消息的统一表示为可选项 | 每项以明确瓶颈任务证明全任务收益，保留权限/生命周期；无收益即停止，不形成必做大改造 |

P0之后P1可独立推进，不必等全部Repo或构造问题解决；P2使用的错误图必须先修。来源审计中的未复现Host授权/测试能力等保证差异单列，不把此任务扩大成整个产品重写。每阶段只选能改变决策的最少案例；逐组通过后才组合。

自然任务不提示工具名，覆盖exact/无命中/中文英文、过期注册、错误参数/拒绝恢复；比较完整schema与发现成本，不仅数名字。自动context另测编码/非编码、空仓/大仓、子包/非Git、已有caller context；不通过关闭能力假冒省量，不加任务分类LLM。

当前 $0 Runtime54：完整 19,732；Repo4 19,192；LSP8 18,756；组合42项 18,149，组合省 **1,583**。
旧 baseline 重复片段约405已去重；路径/时间变动不归于修复，单组差额不机械相加。
code_search历史独项约222，不是组合净收益；无第二轮建议最终默认/PTC payload，不能预报精确省量。
此前 Kimi 补证多一轮，全任务34,573→49,740，故首轮省量不直接批准默认。[旧结果](first-turn-windows-comparison.md)

**P5中的PTC独立 spike。** 先只读数据依赖/筛选/失败，再写入/undo/测试、只读 child、拒绝恢复、预算2/4、并发、取消、截断与 Windows 清理。
同 allowed inventory 对比 native/bridge/PTC 执行事实、权限、预算、文件终态；工具数少不算等价。无实质组合/总成本收益就不扩大实现。

**每阶段的模型验证：GLM/Kimi 配对 + 最终 smoke。** 遵循 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)，机制先离线；自然发现/编排与自主恢复才需模型。以下是一个选定候选revision的上限提议，不是给78工具逐项复制预算；多阶段重新冻结范围，不能自动叠加。
用 **zhipu-coding/glm-5.3、kimi-code/kimi-for-coding**，不用 zai-coding。单变量后组合，不为未决定的模式排列组合跑评测。

预算提议，尚须冻结生产字节、案例、资费配置与账本才成为可执行预注册：Layer2 两 provider×两 arm×两 case×一次=8 请求；
必要时 Layer3 两 provider×两 arm×一个固定三轮案例=12 请求；受控比较最多20请求/2,000,000保守tokens。
最终候选复杂 smoke 两例、每 provider 一次，每例最多28根/子/辅助请求、800,000tokens、60工具提议、24根迭代、一个只读child、10分钟。
每请求120秒/4096输出；单 revision 总上限76请求/3,600,000tokens/$0.50参考费用，先触顶先停。
同 provider 并发一；未知 usage 保留预留，不自动重跑/切 provider/追加样本。额度不是目标，已有证据足够就停止；价格未知不假报账单。

Layer2/3 盲化评审任务有效性、自然选择、证据、参数/脚本、拒绝后下一步与报告；Layer3.5 只证明最终链路覆盖，**不用自由 E2E 做 prompt A/B 优劣结论**。
复杂链路覆盖读/改/测、只读 child 拒绝后自主恢复、主线程整合与 AMA 收尾；独立 oracle 核对保护文件、测试反事实和如实报告。
同时记完整首轮、根/子/辅助/发现/嵌套全任务 usage、cache、未知预留、费用、往返、耗时。
归因 eval-design/provider-noise/prompt-regression/inconclusive，保留失败，不能用小样本宣称普遍智能非劣。
先决定 native 延迟是否进入默认，PTC 首期仅 opt-in；恶化则撤回对应呈现，保留正确性修复。

## 2026-10-24 P0/P1 手册独项实验

实施范围收紧为 web_fetch 真实说明校准、装配边界回归，以及测试内 `kodax_manual` 独项投影。没有改变默认菜单、能力权限、AMA 算法、SDK 或专用角色。web_fetch 的本地 HTTP 回归确认：跟随重定向、重复请求不缓存、HTML 转纯文本；仅改说明，不添加网络行为。

`deferred-manual-20261024-r1` 使用最终源码的真实 Runtime 捕获，manifest SHA256 `dcfafcac78a63cddb89e82f0c554a5afe65dcdc145c4bf3170f09669872a0b9e`。原始证据在 OS Temp `kodax-eval-dumps/deferred-manual-20261024-r1`，不入 Git。启动采用 `vite-node --config vitest.config.ts` 的源码别名；直接 tsx 启动遭既有 REPL 类型重导出错误，未发付费请求。已完成源码/测试 typecheck、packages 构建及相关 190 项离线回归。

预注册两个自然任务：只读 README 的 TTL 契约；查询当前内置扩展手册中的安装目录、路径加载和重新加载。两 provider × 两 arm × 两 case，先 8 个单轮请求，再按固定最多三轮执行真实只读工具；总受控上限 20 请求、900,000 保守 tokens、$0.20 参考费用。只允许原样工具参数/回执；若两 arm 均无法在预算内完成，保留截断，不追加轮次。主会话先看 A/B 原始输出、落盘语义判断，再揭盲；比较信息正确性、发现及调用成本、全任务 token 和有效耗时。单样本不证明普遍非劣。

离线不能回答模型是否愿意发现及发现往返是否抵消省量，这是付费探针的唯一目的。相同 Runtime 输入的归一化估算：普通任务 19,735→19,527，手册任务 19,778→19,571，54→53 项，净省 207–208（约1.1%），包含新增发现提示；不是 provider 实报 input，也不是产品已生效的省量。

最终复杂 smoke 最多两例（每 provider 一例）：既有跨包缓存缺陷任务加手册查询，含一个只读子 Agent、真实读改测和 AMA 收尾；拒绝恢复只在真实发生时计覆盖，不把离线预置拒绝算成模型自主恢复。每例28根/子/辅助请求、800,000保守tokens、60工具提议、10分钟，总56请求/1,600,000tokens/$0.30参考费用。单revision上限76请求/2,500,000tokens/$0.50，含未知usage保守预留，先触顶先停。每provider并发1；不自动重试、切路由或改写输出。费用使用仓库订阅参考价，不是实际账单。历史 learning reviewer 隔离替身仍存在，不能宣称学习链也经过真实模型验证。

R1 配对结果（每格一次，provider 实报全部 input+output，缓存另计；截断格不是完成任务成本）：

| 模型/任务 | 完整 native | 手册延迟 | 解读 |
| --- | --- | --- | --- |
| GLM 普通读取 | 2次，36,016 tokens，17.912s，$0.0018101 | 2次，35,514，12.189s，$0.0017828 | 均正确完成；时间含缓存/网络波动，不作速度因果结论 |
| Kimi 普通读取 | 2次，33,762，10.902s，$0.00017277 | 2次，33,127，5.921s，$0.000168485 | 均正确完成 |
| GLM 手册查询 | 2次，36,435，11.935s，$0.00183855 | 3次，53,396，14.296s，$0.0026734，未完成 | 首次桥接多嵌套一层，缺顶层name；恢复回合被评测错误反馈污染 |
| Kimi 手册查询 | 3次，51,596，16.243s，$0.00026465 | 3次，50,225，7.548s，$0.000253805，未完成 | 两边query都命中install后改用extensions精确topic；延迟版额外发现一轮，截断时仍待执行精确查询 |

首次 provider input 的普通任务差额：GLM 17,757→17,528（229），Kimi 16,418→16,203（215）。这与归一化估算口径不同。19次受控请求共330,071 tokens、$0.00896456参考费用，无未知usage、无重试。先落盘 `paired-blind-review.json` 再揭盲；完整结果与逐回合回执在上述Temp目录。

**结论 recommend-iterate，保留 native 默认。** 单项约1.1%首轮收益尚不能抵消实际使用时多一次往返和参数风险。GLM首次错误是有效观测，下一次恢复比较标为 `eval-invalid`：旧评测把缺name错误替换成笼统只读scope错误，不能据此声称模型不会恢复。Kimi的三轮截断属于额外发现成本与既有查询匹配共同作用，不等于智能下降。没有扩大样本追求通过率。

R1复杂 smoke：GLM completed，14请求（root8/child5/aux1）、234,500 tokens、190.267s、$0.0119884；公开11/11、隐藏6/6通过、保护文件不变、一个只读child、实际search→bridge手册读取、如实收尾；本例无拒绝，不能计入模型拒绝恢复覆盖。Kimi 13请求（root9/child4）、259,149 tokens、222.192s、$0.001409995；公开14/14与隐藏6/6通过、保护文件不变、根/子两个错误路径均拒绝后恢复，但最后 `npm test | tail -n 12` 被评测hard-stop，**完整E2E未通过、没有最终报告**。不能把代码测试通过代替AMA收尾。两例均无未声明工具调用。独立副本仅恢复原始三项实现、保留模型测试后，GLM 7项/Kimi 6项失败，证明新增测试可检出原缺陷。

R2仅校正评测拒绝反馈：缺失bridge目标名时调用实际bridge返回原始validation错误，不能借此执行内嵌目标；识别无文件参数的 `tail -n 数字`，仍阻止整条管道，仅回传可恢复拒绝。扫描所有shell阶段，目录错误不能掩盖后续未知命令/越界。生产能力、模型输出和AMA未变。193项回归、类型检查通过；不重跑GLM或配对格，只补Kimi复杂例一次。此前R1累计46请求/823,720tokens/$0.022362955；补测上限28请求/800,000tokens，累计最多74请求/1,623,720tokens，仍在原76次/250万预算内。

R2正式manifest SHA256 `c1075e73aa2f85cc6ba127a9f4627abd47d1d58efec6a8343e102f88d2a06bd5`，Temp目录 `kodax-eval-dumps/deferred-manual-20261024-r2`；离线评审前draft另存，付费前已重新冻结。

**R2 Kimi completed**：19请求、206.826s、446,247保守tokens、$0.002335115参考费用。公开9/9、隐藏6/6通过，保护文件不变，一个只读child，实际发现/桥接手册与AMA收尾。模型还自主stash三项修复、验证旧代码上4项新测试失败、恢复后9/9通过；主会话核对实际回执与最终报告一致。一次已发出的辅助judge正常取消，完整usage未知，保守记15,529 tokens/$0.000087885，没有把流式partial usage当完整账单。其余430,718为完整实报usage。本例未触发工具拒绝；不能宣称单次同时覆盖所有拒绝恢复，R1根/子路径恢复与离线阻止tail后的收尾是分开的证据。

本轮合计65请求，完整实报1,254,438 tokens + 未知预留15,529 = 1,269,967保守tokens，参考费用$0.02469807；无自动重试。三次复杂smoke（含保留的失败）已达到本轮案例上限，停止扩样。产出是正确性说明、拒绝反馈与离线契约保障；**未默认隐藏手册，也未新增用户模式开关**。不以两例最终完成声称普遍智能非劣。下一步先验证桥接参数教学，或选择能被现有工具直接覆盖、无需额外发现往返的入口；另开单变量revision，不把本次低频手册结论推广到其它工具。

### Standards

初审无硬规范违反。追加评审发现tail之后的目录拒绝提前返回会掩盖未知命令；已补精确失败回归、延迟目录拒绝至完整扫描后处理，并由评审只读确认关闭。最终无未解决项。

### Spec

初审发现预算原为80次且缺单例token硬限；已改20+56=76并加每例800,000的调用前保守预留检查，复核关闭。R2允许固定单路补测，仍保留原失败及不扩执行权限的约束；无未解决项。

## 2026-10-24 后续单变量验证预注册

桥接教学 `bridge-teaching-20261024-r1`：仅在测试模型视图中给 `tool_call` 补 sibling top-level fields 的说明及 `{"name":"read","input":{"path":"README.md"}}` 例子，schema、执行器、权限、预算和AMA均不变。完整native普通读取作为误触发对照；另外两例从真实Runtime菜单和实际tool_search回执开始，一例再包含旧错误形态与实际bridge缺name拒绝。仅比较相同决策点之后的闭环，不把固定历史当成本为零的完整用户任务。实际schema/回执和源码hash随manifest冻结，raw只放OS Temp。

两模型×三例×两arm各一次，先12次单轮探针；必要时每格最多再两次生成完成受控读取/报告，总上限36请求、120万tokens、$0.15参考费用、每请求1536输出/120秒、每provider并发1。主会话盲评是否按实际schema调用、缺参后恢复、普通任务是否滥用桥接，以及累计tokens/cache/费用/活跃耗时。若无实质改善或出现额外调用，不进入默认，不追加样本追求通过；机制由离线回归验证，真实模型只回答参数理解与自主选择问题。

随后独立检查anchor→edit替代。其核心假设是直接使用已有edit，不新增发现往返；先核对可信Host、歧义、换行、undo和大小限制，保留底层、SDK和专用角色。桥接与anchor呈现不组合，后者的实际付费范围和停止条件在离线核实后单独冻结。

## 2026-10-24 桥接教学结果与直接替代实验

`bridge-teaching-20261024-r1` 已完成，manifest SHA256 `cac4c8acbd90f80e9fe87d6f34799b2c575db153f185a561052667fc3b946756`。仅候选 tool_call 描述增加例子：归一化估算 +39 tokens，provider 首请求 GLM +36、Kimi +35。先保存主会话盲评，再揭盲。每格只有一个样本，不作统计显著性或智能非劣结论。

下表为“调用数 / 总tokens / 活跃耗时 / 参考美元费用”。普通读取从用户请求计；两个桥接任务从相同、已发现工具的决策点计，**不包含发现前的真实生成费用，不能称为全任务成本**。未完成格也不能视为更便宜的已完成任务。缓存实报、逐回执、原始输入及源代码补丁保存在 OS Temp `kodax-eval-dumps/bridge-teaching-20261024-r1`。

| 路线与任务 | 原说明 | 补例子 | 语义评审 |
| --- | --- | --- | --- |
| GLM 普通读取 | 2 / 36,019 / 12.944s / $0.001812 | 2 / 36,155 / 14.374s / $0.0018221 | 均完成，核心契约正确 |
| GLM 发现后调用 | 3 / 53,765 / 23.915s / $0.0026948 | 3 / 55,594 / 15.404s / $0.0027987 | 原说明连续缺name，未完成；候选取得证据并如实回答，但重复查了一次手册 |
| GLM 参数错误后 | 3 / 54,936 / 22.769s / $0.00277295 | 2 / 36,782 / 12.382s / $0.0018596 | 首响应原说明递归bridge、候选正确；原说明后续收到评测scope文案，恢复成本比较 **eval-invalid** |
| Kimi 普通读取 | 2 / 33,795 / 8.147s / $0.000174345 | 2 / 33,742 / 7.155s / $0.00017332 | 均完成 |
| Kimi 发现后调用 | 2 / 34,179 / 9.957s / $0.000175185 | 3 / 51,971 / 6.618s / $0.000262185 | 参数均正确；候选已有extensions证据仍查询sessions，截断时未回答 |
| Kimi 参数错误后 | 3 / 52,550 / 15.150s / $0.00026901 | 3 / 52,308 / 6.200s / $0.00026391 | 参数均自主恢复；候选继续查询，三轮未收尾 |

合计30物理请求、531,796实报tokens、$0.015078105参考费用，无未知usage/重试。首响应四个桥接格中，原说明正确2/4（Kimi两格）、候选4/4；不能用该机械结果覆盖后续重复查询。**recommend-iterate，暂不进入默认**：GLM有格式改善证据，但尚未证明跨模型闭环效率不退步。Kimi重复查询的因果归属为inconclusive（每格N=1）；不额外重跑凑通过率。GLM递归拒绝文案偏差已在后续离线测试中修正：只将生产明确拒绝的builtin bridge meta-call交回原执行器返回原错误；具体目标的权限/隔离检查不放宽。旧raw保持原样，不回填“修正后成绩”。

直接替代预检选择过 `insert_after_anchor → read + edit`。真实Windows可信Host的7项新增检查确认：LF/CRLF/完整前缀行/Unicode原文字节、可信撤销、歧义拒绝与唯一上下文恢复可覆盖；但edit在旧读后拒绝并要求再读，anchor接受当前快照；单段401行插入edit拒绝，且明确推荐anchor，anchor成功。后两项是**能力/恢复差异的记录，不是要求放松edit保护**。结合约127 tokens毛收益，暂不进入anchor隐藏的付费实验，也不修改恢复策略。批次edit可能覆盖大段插入，尚不能保证模型零额外往返或相同失败路径。

下一单变量 `local-search-entry-20261024-r1` 仅测试无搜索provider的本地fixture：候选根菜单移除builtin code_search schema，保留grep/glob/read及原有全部其它字节、执行器、SDK、专用角色和AMA；不加发现提示、不叠加桥接教学。离线验证literal转义、大小写和文件名搜索可由现有工具取得同一关键证据；不声称两工具的排序、截断、信任元数据和provider后端等价。

预注册2任务（普通README读取对照、TTL实现及重导出定位），2路线，每arm1格。L2先8次；审读后L3固定最多三轮：定位→读取实现/公开契约→报告（允许前一轮批量读取提前完成），每格8个工具回执上限。总计最多24请求/1,000,000tokens/$0.10，输出1536，单请求120s，同provider串行。L1不能回答模型会否找到实际实现、是否增加发现往返，因此才进入该有限探针。从用户请求起记录全段token、费用、耗时及是否完成；源码存在历史decoy，正确答案必须关联src/cache.js与packages/cache/store.js，并指出零TTL与相等边界。未声明的code_search调用、额外发现、provider异常与三轮截断分别记录，不能计作成功替代。先盲评真实回执与报告再揭盲；不足以支持默认时停止，不扩到复杂smoke或更多入口。

### 本地搜索 R1 边界与 R2 修正预注册

R1 manifest `a264a7c860dd42572afe24f58c9776a3d82e9513e859161a14c89e607fd5e286`；16请求/279,803tokens/$0.00876651，无未知usage。普通对照双方均两次完成：GLM baseline36,152tokens/15.288s/$0.00182415，candidate35,606/17.441s/$0.0017901；Kimi baseline33,706/12.332s/$0.00017339，candidate33,442/13.640s/$0.00017245。首请求实报input分别减少200/167tokens，不能把估算214当实报。

定位题发生**eval-design**问题：“公开入口重导出链”被两模型合理解读为cache/client/identity所有API，需9–10次读取。GLM一格三轮仍在补identity证据，另格与Kimi第一格触发8工具硬限；Kimi第二格续轮因同路线前格中止而未启动。全部都不能作完整定位任务性能比较；未发生provider异常，也没有模型伪称完成。保留原始raw和盲评，不回填通过，不将未知的最终耗时记为零。首轮都选择read，说明已有仓库overview提供路径；不能声称覆盖了陌生大仓库的搜索能力。

R2只修题目范围：明确只追createCache的TTL链，排除createClient/cacheKey；保留原三轮、8工具、隔离和schema差异。仅补这个变化的case×两路线×两arm，L2四次、审读后至多共12请求/500,000tokens/$0.05。普通对照沿用R1，不重跑。两revision分别报告，不合并成功率；本轮桥接+搜索累计最多58请求（已46），原始失败计入费用。该修正只回答小范围定位的完整成本，不能代替复杂编辑E2E；若仍无法完成，不继续放宽预算或追加样本。

### 本地搜索 R2 结果与本轮决定

R2 manifest `b021de3b1be1accc25cbee953c2ceefbca454346aca7e0916b997a64f07f4592`；12请求/213,284tokens/$0.006038085，无未知usage/重试。按预注册停止，没有进一步扩轮。以下均从原始用户任务开始计费，包含所有读取、模型输出和收尾；不是只比较首请求。

| 路线 | 保留code_search | 根菜单省略code_search | 解释 |
| --- | --- | --- | --- |
| GLM | 3次，54,759tokens，21.740s，$0.0027612，完成 | 3次，54,250tokens，23.911s，$0.00273885，完成 | 双方正确指出公开重导出、`>`与`>=`、0被误当null。候选少509tokens（0.93%），耗时增加2.171s；单样本不能归因为工具投影 |
| Kimi | 3次，52,147tokens，13.149s，$0.000267125，未完成 | 3次，52,128tokens，24.793s，$0.00027091，完成 | 候选read+grep取得证据并报告两个核心差异；附带第三条关于非法falsy输入的说明混乱。原版仍请求读测试，没有伪称完成；不能把其短耗时当完成性能优势 |

两路线候选都无tool_search/tool_call往返、无未声明code_search调用、无路径拒绝、无写入，实际使用现有read/grep。GLM两边核心报告等价；Kimi候选的额外“第三项”不是新的有效缺陷，已在主会话盲评中扣除，不以end_turn代替语义质量。每格N=1，Kimi收尾差异归因inconclusive。该fixture已有真实Runtime overview路径线索，不能外推大型陌生仓库发现、分页恢复、provider-backed搜索或复杂编辑表现。

**本轮决定：保留默认工具面与AMA，继续将local code_search列为最有根据的直接替代候选；不删除任何底层能力、SDK、专用角色或provider后端。** 桥接常驻例子暂不推广；anchor暂保默认；不把未验证的复杂任务能力写成“智能不下降”。下一项高价值验证应是同一code_search单变量在路径未知/重名实现的真实发现任务，以及通过后有限复杂编辑smoke。桥接可另验“仅在参数错误回执中给正确形状示例”，避免健康调用常驻增加39tokens；此项尚未实现或评测，不能算已获收益。

本轮三个revision合计 **58请求、1,024,883实报tokens、$0.0298827参考费用**，包含R1无效定位格，完整usage均已记录；编码套餐参考费不等于实际账单。最终相关离线回归116通过/1平台跳过（Windows不运行POSIX项），测试类型检查与diff检查通过。新增生产行为为零：变化仅在测试投影、离线契约保障与评测拒绝反馈；前轮web_fetch说明校准仍单独保留。没有进行本轮候选的复杂编辑E2E，因此未默认启用。raw、映射、揭盲前评审、逐回合费用及源补丁分别保存在OS Temp的三个revision目录，正式结论不依赖ignored研究稿。

## 2026-10-24 陌生仓库定位：执行前冻结

`unfamiliar-search-20261024-r1` 仅省略builtin local code_search根schema，不叠加桥接教学，不改变AMA装配名单、SDK、专用角色、底层执行器或生产默认。参考为pi `136b87e8a7f5a3e5186de0289523ba327dc592fc` 的完整 `packages/tui` Git子树（125文件）；读取Git对象，拒绝symlink/submodule，不带工作区未提交内容。副本与raw均在OS Temp，逐文件SHA256入manifest。模型无此前任务历史；不能证明训练中未见过开源项目，因此“陌生”指新的本地任务上下文。

真实embedded AMA先零网络捕获正常输入，保留auto RepoIntel/overview及全部正常提示，不人为移除可能有用的路径线索；题目不给实现文件或函数名。两题：显示列宽及缓存淘汰（需区分组件渲染缓存），分片bracketed paste的buffer→终端转发与实际测试。完整答案分别要解释512项/最先插入淘汰/命中不移动顺序/ASCII快路径与grapheme处理，以及跨块开始/结束标记、尾部普通输入递归处理、paste事件重新包标记转交inputHandler。预期事实由主会话读固定源码核实，不注入模型输入。

L1不能回答模型定位/消歧/收尾及额外往返；先验证Git副本与真实AMA捕获、原生grep/glob读取及投影边界，再付费。L2两路线GLM5.3/Kimi × 两题 × 两arm各1样本，共8次，只观察不执行。主会话盲审有效后继续原响应。L3从用户请求起最多**五轮/16工具回执**：1定位，2读取实现，3追公开导出或调用方，4核验测试/歧义，5形成报告；允许提前完成、批量读取，不能在观察失败后增轮。五轮是本次新真实任务预注册的依赖上限，不续跑旧截断格。沿用已有只读执行白名单和隔离守卫，不执行shell/修改/委派；若这些限制阻断合理替代路径，单列eval-design局限，不当作能力退步或扩权限凑通过。

定位预算最多40请求/1,800,000tokens/$0.15参考费，输出2048、每请求120s；同provider并发1，不重试、不fallback、不改模型参数/输出。所有请求与缓存/未知usage、工具回执、完整任务费用与活跃耗时落盘；只比较同等完成质量，未完成不当作便宜或快。质量标准为实际实现与调用/测试证据完整、关键语义准确、不把组件缓存/示例误当实现、不伪称验证。额外发现、修复往返和不必要读取均单列。评审先保存A/B判断再揭盲；未支持“质量不降且不增加往返”的结果则停止本轮，不扩样或放宽边界。

仅在主会话确认定位证据足以支持继续后，才写smoke-review并运行GLM/Kimi各一次候选复杂编辑smoke（至多2例，非A/B性能证明）：沿用跨包缓存fixture、真实AMA、至多一个只读child、原隔离/测试oracle/报告核对。每例28请求/60工具/800,000tokens/600s；合计56请求/2,000,000tokens/$0.30，输出4096。本轮总硬限96请求/$0.45；复杂自由流程按EVAL_GUIDELINES不作为prompt配对比较。完整任务配对成本依据上面的受控定位；复杂例费用/耗时按实单列，旧baseline仅作历史参照。未通过前不得默认隐藏code_search，任何受限/无效样本仍保留计费。

## 源码索引与证据保留

行号绑定第2节 pin，本地后续更新可用 git show pin:path 复核。

- [C1] [Codex 优先级/fallback](C:/Works/PubProj/codex/codex-rs/core/src/tools/mod.rs:65)。
- [C2] [SDK 选择](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:955)、[native augment](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:662)。
- [C3] [typed renderer](C:/Works/PubProj/codex/codex-rs/code-mode-protocol/src/description.rs:321)、[sample](C:/Works/PubProj/codex/codex-rs/tools/src/code_mode.rs:8)、[exposure](C:/Works/PubProj/codex/codex-rs/tools/src/tool_executor.rs:14)。
- [C4] [共享 dispatch](C:/Works/PubProj/codex/codex-rs/core/src/tools/registry.rs:691)、[nested](C:/Works/PubProj/codex/codex-rs/core/src/tools/code_mode/mod.rs:336)、[锁](C:/Works/PubProj/codex/codex-rs/core/src/tools/parallel.rs:220)。
- [C5] [step](C:/Works/PubProj/codex/codex-rs/core/src/session/step_settings.rs)、[tool delta](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/top_level_tools.rs)、[cell](C:/Works/PubProj/codex/codex-rs/core/src/tools/code_mode/delegate.rs:118)。
- [D1] [DSH Standard](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:21)。
- [D2] [新版 PTC](C:/Works/PubProj/deepseek-harness/packages/core/tool-executor-ptc/src/index.ts:11)、[执行](C:/Works/PubProj/deepseek-harness/packages/core/tool-executor-ptc/src/ptc.ts:128)。
- [D3] [control](C:/Works/PubProj/deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts:28)、[通知](C:/Works/PubProj/deepseek-harness/packages/subagent/tool-subagent/src/index.ts:210)。
- [P1] [pi 默认](C:/Works/PubProj/pi/packages/coding-agent/src/core/settings-manager.ts:85)、[registry](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/index.ts:95)。
- [P2] [CLI 扩展](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/index.ts:7)、[MCP exposure](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:135)。
- [P3] [pi on/only/预算](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:226)、[nested](C:/Works/PubProj/pi/packages/coding-agent/src/core/nested-tool-calls.ts:221)。
- [K1] [Repo mode](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/runtime-config.ts:33)、[worker](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-worker.ts:54)。
- [K2] [bundle](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/scripts/build-bundle.mjs:500)、[release](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/scripts/release.mjs:137)。
- [K3] [旧 off 过滤](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-resolution.ts:120)、[AMA](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:108)、[handler](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/module-context.ts:9)。
- [K4] [code_search](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/code-search.ts:27)。
- [K5] [Session settings](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/src/sdk-runtime.ts:1626)、[generic SDK](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/src/sdk-agent.ts:17)、[Coding](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/coding-preset.ts:126)。
- [K6] [状态栏](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/repl/src/ui/view-models/status-bar.ts:432)、[启动视图](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/repl/src/ui/InkREPL.tsx:1696)、[已有 /mode](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/repl/src/interactive/commands.ts:1279)。
- [K7] [profile类型](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/types.ts:1055)、[发现scope](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:84)、[preturn上下文](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:210)。
- [K8] [TS解析边](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-typescript-analyzer.ts:429)、[最终名称覆盖](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-build-materialize.ts:328)、[缓存序列化](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-workspace.ts:166)、[路径/模块匹配](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/repo-intelligence/semantic-query.ts:87)、[LSP请求接线](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/lsp-navigation.ts:18)。
- [K9] [grep过滤与分页](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/grep.ts:397)、[glob可读回调](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/glob.ts:11)。
- [K10] [anchor](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/insert-after-anchor.ts:18)、[edit](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/edit.ts:42)、[批次修改](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/multi-edit.ts:34)、[共享可信写入](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/_internal/text-file-mutation.ts:192)、[Codex patch](C:/Works/PubProj/codex/codex-rs/apply-patch/src/file_update.rs:68)、[DSH edit](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs/src/edit.ts:76)、[pi edit](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:177)。
- [K11] [角色工具教学](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agents/worker-role-prompt.ts:259)。

raw 只在 OS Temp：codex-tool-mode-comparison-20261024（三模式/归因/草图），kodax-eval-dumps/context-modes-20261023-r1（54项投影），
kodax-eval-dumps/repo-mode-off-audit-20261024-r1（off复核）。本文保留决策所需 pin、方法、数值、失败与限制，不依赖 ignored 研究稿充当正式契约。
第二轮raw：kodax-eval-dumps/local-search-value-20261024-r1、kodax-eval-dumps/repointel-evolution-audit-20261024-r1（compiler以r2文件为最终三文件对照）、anchor-tool-necessity-second-pass-20261024。
全量复核raw：kodax-eval-dumps/full-tool-audit-20261024-r1，包括78库存、54项成本、纯SCC见证、错误native名单的策略耦合模拟；Windows import装载失败及探针修正记在manifest，不冒充产品故障。没有新模型调用或真实Host全链性能结果。
上述全量审计阶段是源码handler/索引接线探针，不等价完整Runtime、真实语言服务器或模型任务质量评估。后续生产说明校准和手册独项模型实验以本篇P0/P1实验记录为准，不能把局部结果推广到全部78项工具。


### 2026-10-24 陌生仓库定位结果与平台边界

实验 unfamiliar-search-20261024-r1 已按冻结预算结束。主会话先保存八格盲评及 raw hashes，再揭示 A/B。40 次 provider 调用、40 次实际请求，累计 1,095,995 tokens，按评测配置费率估算 $0.033836205（不是账单金额）；无重试、无未知用量、无剩余预留。44 项离线回归及测试类型检查已通过。

八格全部在第 5 次生成仍提出工具调用，没有最终报告；原生菜单与隐藏本地 code_search 的候选均如此。此项属于共同预算截断，完整任务质量/完成成本比较不可判定（eval-design / floor saturation），不能判定候选通过，也不能据此声称智能下降。真实 grep/glob/read 能找到相关实现，未观察到发现调用或工具执行错误；但部分格尚未取得完整导出、调用链或测试证据。候选的首轮规范化请求约省 214 tokens，不等于全任务收益。

下表全部是预算截止时的累计，**不是完成任务成本**；耗时为模型与真实工具的活跃耗时，不含人工盲评等待。

| 模型/任务 | 原生累计 tokens / 秒 | 候选累计 tokens / 秒 | 最终报告 |
| --- | --- | --- | --- |
| GLM / 列宽 | 141,178 / 41.792 | 150,495 / 43.116 | 两者均无 |
| GLM / 粘贴 | 159,028 / 36.605 | 177,055 / 35.081 | 两者均无 |
| Kimi / 列宽 | 112,271 / 19.076 | 113,207 / 16.228 | 两者均无 |
| Kimi / 粘贴 | 133,441 / 26.304 | 109,320 / 20.025 | 两者均无 |

决定：保持 code_search 默认入口、底层能力、SDK、专用角色和 AMA 策略；不追加轮次或重跑，不启动以定位验证通过为前提的复杂编辑 E2E。此次证据只能支持存在替代路径，不能支持完整任务效率非劣。

平台边界：本轮在 Windows 实际执行内置 Node grep/glob/read，未执行模型 shell 命令，未在 macOS/Linux 主机验证。local code_search 是路径/行字面匹配及检索结果封装；provider_id 分支是独立扩展能力，不纳入本轮移除。既有 shell resolver 分别支持 PowerShell/pwsh/cmd/bash/zsh 的启动、环境和引用约定，但这不自动证明搜索命令跨平台等价，也不保证 rg 可用。优先替代方案是现有内置只读工具；shell 是可选补充。若之后评估 shell 为主要替代，必须单独核对工具安装、字面量与正则差异、路径/引号、Unicode/换行、ignore/隐藏文件、权限与截断恢复，并在对应系统实际验证。不得将本轮结果表述为三个平台 shell 已通过。


### 2026-10-24 r2：用户授权修订预算，执行前冻结

设计复核：r1 八格共 40 次均以 tool_use 结束，未出现 provider 错误；单次输出最高 338 tokens，远低于 2,048 上限。所有格仍在正常收集实现、导出或测试证据，五次生成的共同截断使完成指标无区分度。五步调查的概念阶段不能等同五次模型生成；一个阶段可能需要多次搜索/读取，报告也需要生成机会。

用户明确要求检查设计后用合理但有限预算验证完整定位任务并比较两菜单。故 r2 是**有界完整任务的观察性配对续跑**，不继续将自主调查称为固定步骤 Layer 3，也不将小样本视为因果或统计非劣证明。旧盲评与揭盲已经完成，r2 如实标为开放标签复核，不能声称重新盲测。此授权仅适用于本轮完整任务验证，不修改通用 EVAL_GUIDELINES。

复用 r1 全部八格的原始五次生成和真实工具回执，原始输入、任务、模型、推理档位、工具描述、工作区 125 个文件字节、只读隔离不变；从每格尚未执行的第五次响应工具调用继续，不重跑前缀、不择优选格，不增加答案/终止提示。每格共最多 12 次生成、32 个工具回执；新增最多 7 次依次为完成待执行证据、补导出/调用者、查针对性测试、核对边界、核对引用、归纳、报告提供余量，模型可提前结束，不强迫按这些步骤走。新增阶段每格 180 秒、单请求 120 秒、输出仍 2,048 tokens。若仍截断、输出不足或事实错误，保留原样，不继续加轮数或重采样。

总定位预算包含 r1：最多 96 次调用（新增最多 56 次）、450 万 tokens、配置参考费率 $0.25；冻结 ledger 从 r1 的 40 次 / 1,095,995 tokens / $0.033836205 起算。预计新增约 40–120 万 tokens，费用约 $0.01–0.05，硬上限用于保守预留。每 provider 串行，GLM/Kimi 两 lane 并行。执行前校验父 manifest SHA256、全部旧证据 hash、源码 hash 和 fixture hash；续跑新目录保存，旧 raw 不覆写。

验收先看最终报告和实际回执：列宽实现/公开导出、ASCII 快路径、非 ASCII 缓存键与 FIFO 淘汰、命中不刷新顺序、组件缓存区分；粘贴需解释分块/标记缓存、超时限制、剩余普通输入、terminal 重包交付链与真实测试覆盖，不得宣称不存在的标记拆分测试。再按格比较从任务开始的调用数、工具数、全 token、缓存与参考费用、活跃耗时；续跑等待不算模型耗时，跨阶段缓存/服务抖动记为限制。无报告或被截断的格不使用“完成成本”。不以找到文件代替报告质量；不因首轮少 214 tokens 忽视额外往返或阅读放大。

通过的含义是主会话综合证据支持候选保持关键质量、没有可信新增恢复/发现负担或实质效率回退；单次差异不自动归因工具菜单。若不明确，保持默认，停止本次付费扩展。只有定位证据支持继续，才启动已冻结的两个 GLM/Kimi 复杂编辑 smoke（每格 28 请求/60 工具/80 万 tokens/600 秒，总 56 请求/200 万 tokens/$0.30），保留 AMA、只读子 Agent、拒绝恢复、测试和真实报告；smoke 不作为配对优劣的统计证据。


### 2026-10-24 r2：完整定位续跑结果

本次新增 32 次请求、1,310,569 tokens、参考费用 $0.02744010；含 r1 的全任务累计为 72 次请求、2,406,564 tokens、$0.061276305。实际请求数与调用数一致，无重试、未知用量、剩余预留。源码、父 raw、两个 125 文件快照 hash 均未变化。续跑恢复/投影/守卫共 29 项离线测试通过，测试类型检查通过。生产默认没有变化。

七格以 end_turn 正常结束，用 6–12 次生成，证实原五轮不足。完成报告不等于准确率通过；仍有一格候选在 12 次上限无报告。全部执行工具仅 grep/glob/read，零发现往返、零工具错误、零未广告调用；baseline 也没有调用 code_search。

| 模型/任务 | 菜单 | 完成报告 | 调用/工具 | 总 tokens（含缓存） | 参考美元 | 活跃秒 |
| --- | --- | --- | --- | --- | --- | --- |
| glm/width | baseline | 是 | 8/10 | 264,736 | 0.01330475 | 75.738 |
| glm/width | candidate | 是 | 6/8 | 189,630 | 0.00953580 | 60.930 |
| glm/paste | candidate | 是 | 7/9 | 267,186 | 0.01345370 | 69.651 |
| glm/paste | baseline | 是 | 9/11 | 362,563 | 0.01823145 | 81.246 |
| kimi/width | baseline | 是 | 10/14 | 268,680 | 0.00137442 | 61.452 |
| kimi/width | candidate | 是 | 8/11 | 258,717 | 0.00132284 | 64.297 |
| kimi/paste | candidate | 否，预算截断 | 12/24 | 371,180 | 0.00188431 | 62.789 |
| kimi/paste | baseline | 是 | 12/20 | 423,872 | 0.00216904 | 106.211 |

费用按仓库冻结费率估算而非真实账单，tokens 包含重复上下文与缓存命中，活跃耗时包括前五轮与续跑的模型/工具耗时、排除人工复核等待。未完成格只列截至上限的累计，不与完成格宣称节省。跨阶段服务负载/缓存和单轨迹随机性限制耗时与因果结论。

主会话开放标签复核：

- **列宽**：两模型两菜单均正确定位核心实现、公开导出、512 项 Map FIFO 和命中不刷新。候选各少两次生成，GLM 总 token 减约 28.4%，Kimi 减约 3.7%；Kimi 活跃耗时反增约 4.6%。候选仍有次要表述不精确：GLM 把每帧重建 renderCache 说成尺寸变化重建；两边用“非 ASCII”近似表达“非快路径”。原生也有附带错误，不能将一个菜单视作完美基线。
- **GLM 粘贴**：候选 7 次、原生 9 次，候选 token 减约 26.3%，但候选漏讲开始标记不完整时普通路径的超时 flush；原生甚至误说不完整 ESC 不会 flush。两边回执均含 timeout 实现，属于已获得证据后的理解/报告问题。已有分块测试用完整开始/结束标记，并未直接证明两种标记拆分均被专门覆盖。已抽查原始 grep 回执，其中包含 editor 处理注释、阈值和实现行，不能因没有整函数 read 就判定为臆测；问题仍是超时边界解释不全，不能用更快报告替代准确性。
- **Kimi 粘贴**：原生第 12 次报告，候选第 12 次仍请求 editor/alt-screen 证据（24 次工具 vs 原生 20 次）；候选无完成成本。原生解释了粘贴态半个结束标记不启动超时，但未明确说明拆开的开始标记仍走普通缓冲超时路径。不能从一个样本认定精简导致智能下降，也不能忽略候选的收尾风险。

结论：内置 grep/glob/read 的信息访问替代性有实证，首轮少 214 tokens 没有引入发现调用；但“完整定位任务保持准确且不增加往返”的证据尚不完整。**保持 code_search 默认入口，不启动条件性的复杂编辑 E2E，不继续加轮数或重跑**。AMA、底层能力、SDK、专用角色不变。后续应先利用现有回执分析任务收尾与证据限定，避免为 214 tokens 引入额外路由、工具或配置；本轮不把这些语义缺陷修成新的强制规划策略。原始数据、完整输入/输出、source.patch、输入/缓存 token 及逐格评审在 OS Temp 的 unfamiliar-search-20261024-r2 保存；正式决策不依赖 research 草稿。


### 2026-10-24 离线归因与历史收益复核

后续未追加模型调用。全部72次输入/回执链校验、固定源码timer探针与工具引入历史见[工具开发契机与退役边界](tool-origin-and-retirement.md)。Kimi候选的取证顺序和支线扩展是可观察差异，菜单因果仍未证实；GLM两菜单获得同一完整源码后共有的超时边界误判，不作为必须保留local code_search的理由。历史工具adoption不能代替功能增益证据，退役优先级改由真实增量能力、现有覆盖和兼容依赖共同决定。默认入口、AMA和底层能力均保持原状。

### 2026-10-24 追加：兼容边界与恢复调用迁移

本地搜索实验新增 builtin 替代工具/bridge 完整性检查，直接 grep/glob/read 的真实执行与预算相等；生产默认尚未切换。anchor 的 500 行追加已通过 LF/CRLF、失败全批回滚和一次 undo 检查，现将大段编辑失败教学改为一次 `edit.edits[]`，不再推荐拆成多轮。前文“未修改恢复策略”描述的是当时状态。最新最小方案、provider/SDK 边界、RepoIntel 三类消费者及验证限制见[追加决策](tool-origin-and-retirement.md#2026-10-24-追加从调用依赖转向可替代职责)。本轮不追加模型评测，不隐藏 anchor，不改 AMA 规划/派发。

随后按用户授权完成[生产实施与离线验证](tool-origin-and-retirement.md#2026-10-24-实施默认本地搜索入口与普通编辑恢复)：默认本地 root 隐藏 code_search，SDK/child/provider 等兼容面保留；grep.literal 覆盖长字面量，普通 anchor 恢复提示迁移至 edit。完整执行目录、AMA 策略及底层能力不变，未增加产品模式或付费调用。上述“默认尚未切换”只描述前一阶段。
