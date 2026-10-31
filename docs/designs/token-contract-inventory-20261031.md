# Token 契约归属与全量工具盘点（2026-10-31）

本记录针对 `13f2fe93d786f9389aa3d91bd4953870718c27c3` 加本轮未提交工作区，
区分**已经默认启用、仅供评估的候选、尚无收益证据的方向**。不以工具数、代码删除量或子 Agent 节省量替代根首轮指标。
本轮不修改 Coding 默认、AMA 规划派发、SDK、专用角色及执行权限。

## 1. 当前根首轮基线与计量边界

2026-10-31 离线真实生产装配抓包 32 格通过，未访问模型；原始文件保存在 OS 临时目录
`kodax-first-turn-wire-ICxeNg`。每格 `normalized-model-input.json` 按
[统一计量脚本](../../tests/first-turn-uniform-costs.ts) 的 `measureModelFields` 重计：
仅保留 `system/instructions/messages/input/tools`，完整保留嵌套参数、AdditionalTools 和 Script 叶契约，紧凑 JSON 编码。
统一启发式为 `ceil((3 × UTF-8 bytes − UTF-16 code units) / 8)`，不是 BPE、API 账单或 provider 真实 usage。
`inventory.json` 自身的旧汇总字段不是这套完整字段口径，不混用。

| 场景 / 协议 | Agent | Coding | Script |
| --- | ---: | ---: | ---: |
| runtime-host，OpenAI | 12,035 | 15,667 | 17,536 |
| runtime-host，Anthropic | 11,790 | 15,292 | 17,372 |
| empty，OpenAI | 9,708 | 12,071 | 14,176 |
| empty，Anthropic | 9,499 | 11,789 | 14,032 |

runtime-host 指固定完整 Host 夹具，含官方 skills/宿主上下文，无个人配置；empty 是更小的空工作区夹具。
Coding 对应抓包中的历史标签 `ama`，不是另一个产品模式；`sa` 抓包只验证内部 SDK 执行器，不能当作产品第四模式。
不能用 empty 去对比另一个项目的 full Host。当前“Agent 距离 10K”指完整 Host，约差 2K；
空场景已经在这一估算口径下小于 10K，不应再说所有 Agent 首轮都超过 12K。
这轮候选对子 Agent 生效，**根首轮不因此下降**。Script 完整声明比 native 编码贵，不能用减少外层入口数量隐瞒。

关键源文件 hash：`managed-tool-text.ts` = `77fbade91086a4ecce1d2cb4dee38391b63f9f22abc8392e7e327e1aadf96a0c`；
`managed-system-contract.ts` = `3f48fb46afec764b7bcd057c6be80f74e73b8274a62d28ec1541f3190b457029`。
OpenAI runtime-host Agent 完整字段 hash = `dcb50621bfdef7fdc8a644c5f397ba470edf689a0409f3a13508b5de421fedfd`。
抓包工作区同时有 Goal 记账修复，但没有开启本轮 child/edit 候选。

## 2. 根规则归属：先保留决策义务，再合并重复表述

| 规则/数据 | 当前所有者 | 本轮处理与不能误删的边界 |
| --- | --- | --- |
| 身份、信任层级、请求范围、用户纠正、历史摘要低信任 | `compact-worker-contract.ts` + 原 Worker 规范契约 | 已有整体紧凑化；不能因工具也谈权限就删除信任/任务边界 |
| 真实文件/测试证据、如实报告、缺失检查、不提前结束 | 同一 Worker 执行恢复交付段 | 根最终质量判断保留；Actor 完成不等于验收通过 |
| 非平凡任务规划、Todo 语义里程碑、批量更新、避免重复计划 | Worker 任务/计划段 | 与工具参数可分工，但策略不可退化为工具名字说明 |
| 只读审查、独占写入、专用角色、继续独立工作、子树收尾 | Worker 协作段 | AMA 策略保留；普通子 Agent 不自动继承整段根契约 |
| 可见工具、参数、默认值、分页、错误恢复和真实副作用 | `model-tool-definition.ts` / `managed-tool-text.ts` | 根系统投影要求完整匹配工具；同名扩展不擅自改写 |
| 当前权限/隔离、用户授权、取消、预算 | `prompts/effective-permissions.ts` 等 Runtime + dispatch guard | 事实与强制执行保留；不能用少一句提示替代权限验证 |
| 当前 cwd/平台、项目规则、Git/Repo 概览、能力目录 | `prompts/capability-sections.ts` / managed Run envelope | 动态事实不是泛泛教学；项目规则不得因多轮重复被视作无效 |
| 跨 Run 事实变化、Actor/Team 增量 | managed task context/update 路径 | 保留变化与失效语义；继续按已有 delta，而非额外发现 |
| Memory 意图、低信任、精确用户授权与收据 | `memory-rules.ts` + 根 compact Memory + Memory tools | 子 Agent 缺根 Memory 段；本轮不投影 `memory_intent` |
| 历史恢复、截断续读、精确位置/修订 | history/read 工具与恢复回执 | 内容未展示不等于可丢弃；不把需恢复的原要求替换成猜测 |
| KodaX 产品边界与版本匹配说明 | self-knowledge routing + `kodax_manual` | 根已有规范投影；手册正文按需加载，而非全部常驻 |
| Skills 发现、匹配触发与正文 | skills catalog + `skill` | catalog 有首轮成本，正文通常在命中后加载；不能把目录当完整正文成本 |
| RepoIntel/LSP 数据与调用边界 | 专项工具 + 真实 Host 服务 | Agent 不提供专项入口，但 AMA 共用底层服务保留；未预热不等于不可用 |
| Script VM、串行叶执行、收据、部分失败、父 Run 预算 | `script/model.ts` + cell/pilot/Run lifecycle | Script 特有边界必须保留；完整叶参数已经首轮交付，无新发现回合 |
| 视觉验收原则与实际媒体能力 | 通用交付规则 + visual 工具/skill + Host owner | 不靠 350 token 收益强加一次 discover；仅无真实 owner 时既有过滤 |
| 错误/编辑回执与持久化证据 | tool handlers + output processing | 可研究模型回执减少重复历史驻留；不丢 UI/durable diff，不隐藏恢复信息 |
| 压缩与长期保留 | compaction/retention contracts | 正确性先行；默认 semantic 全证据，不把 legacy destructive pruning 误称默认 |

大块共享契约已合并过，尚未证明存在可无损直接删除的 2K 根规则。本轮优先有明确信息归属的
子 Agent 契约、工具回执重复、缓存与 Goal 正确性；不再以少量首轮收益引入固定发现步骤。
Pi 可借鉴短回执、工具局部契约、扩展边界；它的窄核心不证明 AMA/审批/恢复语义可以直接删掉。

## 3. 全部 81 项 builtin 工具的保留价值与现有模式分配

程序化读取 `listBuiltinToolDefinitions()` 核实 81 个唯一名称：历史分配表 78 项 + visual 3 项。
下表逐项列明，原依据见 [三模式分配](tool-mode-allocation.md)；本轮没有额外隐藏工具。
`N` 原生，`S` 首轮完整 Script 叶契约，`N*` 仅真实绑定后，`C` 兼容入口，`X` 专用 construction，`—` 普通 Agent 不装配。
所有 N/S 仍受真实绑定/权限/SDK/专用角色控制，并不表示每个请求一律注入。
既有 deferred description hint 机制也不等于参数删除；本轮不新增延迟步骤。

### 文件、执行、搜索与隔离（11）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `read` | N | N | S | 文件证据与读取边界；通用任务也需要 |
| `write` | N | N | S | 新文件与可信写入，不绕过原事务 |
| `edit` | N | N | S | 精确修改、批次编辑与冲突检查 |
| `bash` | N | N | S + N | Script 只支持前台命令；保留完整原生入口供后台执行，不增加发现步骤或扩大 cell 生命周期。这一重复契约的成本须计入首轮 |
| `glob` | N | N | S | 不依赖外部 rg 安装的路径定位 |
| `grep` | N | N | S | 内置内容定位，保留字面量/正则、ignore 和截断契约 |
| `undo` | N | N | N | 保留原生入口，复用父 Run 当前备份；guest 不开放。回执持久化不恢复跨 Run 撤销权限，不将部分失败冒充自动回滚 |
| `insert_after_anchor` | N | N | S | 仍有恢复/大段插入差异，本次不夹带退出实验 |
| `code_search` | C / N* | C / N* | C / N* | 本地重复入口沿用已退出默认的基线；provider/custom profile 按既有规则保留，不把扩展搜索误删；首版保留其条件原生表示 |
| `worktree_create` | N | N | N | 工作区生命周期与路径身份控制，暂不嵌套进脚本 |
| `worktree_remove` | N | N | N | 工作区清理、脏状态和关联进程控制，暂不嵌套 |

### Git 与 RepoIntel（10）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `repo_overview` | — | N | S | 仓库概览与结构证据；不与自动同源字段重复输出 |
| `changed_scope` | — | N | S | 变更范围与上下文选择 |
| `changed_diff` | — | N | S | 有界差异与变更证据，不能用任意 git 命令直接声明完全等价 |
| `semantic_lookup` | — | N | S | 语义/索引路径；可用性沿用实际服务绑定 |
| `cyclic_dependencies` | — | N | S | 循环依赖分析 |
| `relationship_scan` | — | N | S | 综合关系调查；没有充分覆盖证据前不替代下列四项 |
| `module_context` | — | N | S | 模块级上下文与完整字段 |
| `symbol_context` | — | N | S | 符号上下文 |
| `process_context` | — | N | S | 过程/链路上下文 |
| `impact_estimate` | — | N | S | 影响范围证据及降级信息 |

### LSP（8）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `lsp_definition` | — | N | S | 定义定位 |
| `lsp_references` | — | N | S | 编译语义引用，文本 grep 不能普遍等价 |
| `lsp_hover` | — | N | S | 类型与文档 |
| `lsp_implementation` | — | N | S | 实现定位 |
| `lsp_document_symbols` | — | N | S | 文件结构 |
| `lsp_workspace_symbols` | — | N | S | 工作区符号定位 |
| `lsp_incoming_calls` | — | N | S | 入向调用与现有 prepare 链路 |
| `lsp_outgoing_calls` | — | N | S | 出向调用与现有 prepare 链路 |

上述 18 项是普通 Agent 工作面与 Coding 的差异，不是 Coding 的待删清单。
LSP 明确关闭且无有效绑定的既有过滤保持；懒启动/宿主绑定/裸 SDK 未知状态继续保留。
RepoIntel 同样复用实际能力契约，不按“社区版”名称或索引未热就推断不可用。

### 交互、计划、Goal（8）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `ask_user_question` | N | N | N | 用户交互与暂停，必须走宿主控制链 |
| `exit_plan_mode` | N | N | N | 计划审批；本次不附带新的按状态隐藏实验 |
| `todo_create` | N | N | N | AMA 计划状态创建 |
| `todo_update` | N | N | N | 增量更新与事件，避免整表覆写 |
| `todo_list` | N | N | N | 权威计划状态读取 |
| `create_goal` | N | N | N | 明确用户/上层指令触发，保留自然语言、slash 和 SDK 路径 |
| `get_goal` | N | N | N | 当前目标、状态与预算读取；没有目标不等于没有能力 |
| `update_goal` | N | N | N | 目标状态与完成判断，不从脚本绕过生命周期 |

### AMA 协作（8）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `spawn_agent` | N | N | N | 派发、隔离与子预算 |
| `send_message` | N | N | N | Actor 消息及既有授权 |
| `followup_task` | N | N | N | 子任务继续执行 |
| `wait_agent` | N | N | N | 协作等待和用户打断 |
| `list_agents` | N | N | N | 实际子任务状态 |
| `interrupt_agent` | N | N | N | 中断与收尾 |
| `agent_output` | N | N | N | 协作结果消费与边界；首版保留控制族一致性 |
| `list_dispatchable_agents` | N | N | N | 可派发角色目录；不更改角色选择策略 |

### 知识、历史、网络与发现（10）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `memory_recall` | N | N | S | 原记忆检索服务、范围与出处 |
| `memory_intent` | N | N | N | 记忆治理意图与状态控制 |
| `session_history_search` | N | N | S | 原会话范围内检索 |
| `session_history_read` | N | N | S | 历史证据读取，保持访问边界 |
| `kodax_manual` | N | N | S | 版本匹配的使用说明，不在模式改动中另做退役 |
| `skill` | N | N | N | 上下文加载和后续能力装配，不是普通数据读取 |
| `web_search` | N | N | S | 经原网络服务执行，保留出处和访问策略 |
| `web_fetch` | N | N | S | 有界网页读取，不借 Script 获得直接网络权限 |
| `tool_search` | N | N | N | 动态扩展发现；已知 Script 叶工具不以此为前置 |
| `tool_call` | N | N | N | 已有 JSON 桥接；不是代码运行时，不能从 Script SDK 递归调用它绕入控制工具 |

### 宿主工作流与 MCP（7）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `run_skill_script` | N* | N* | N* | 现有技能执行授权、输出和状态，首版保留原生 |
| `run_workflow` | N* | N* | N* | 长流程/宿主控制，不与 Script 叶调用混淆 |
| `mcp_search` | N* | N* | N* | 绑定服务的动态发现 |
| `mcp_describe` | N* | N* | N* | 动态契约，不因 Script 名称假定已知全部工具 |
| `mcp_call` | N* | N* | N* | 服务可能交互/挂起/产生副作用；未核实前不批量纳入 Script SDK |
| `mcp_read_resource` | N* | N* | N* | 保持现有 MCP 链路；后续有明确收益再单独资格验证 |
| `mcp_get_prompt` | N* | N* | N* | 模板读取与上下文语义保留 |

### 兼容别名（5）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `multi_edit` | C | C | C | 旧调用兼容，默认使用 edit 的现有批次能力 |
| `changed_diff_bundle` | C | C | C | 默认使用 changed_diff |
| `tool_describe` | C | C | C | 默认使用现有工具发现/契约路径 |
| `todo_get` | C | C | C | 默认使用 todo_list |
| `lsp_prepare_call_hierarchy` | C | C | C | SDK/专用链路保留，默认使用入向/出向调用工具 |

### Construction 专用路径（11）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `scaffold_agent` | X | X | X | 原专用构造路径 |
| `test_agent` | X | X | X | 原专用构造路径 |
| `validate_agent` | X | X | X | 原专用构造路径 |
| `activate_agent` | X | X | X | 原专用激活授权 |
| `stage_agent_construction` | X | X | X | 原专用分阶段构造 |
| `scaffold_tool` | X | X | X | 原专用构造路径 |
| `test_tool` | X | X | X | 原专用构造路径 |
| `validate_tool` | X | X | X | 原专用构造路径 |
| `activate_tool` | X | X | X | 原专用激活授权 |
| `stage_construction` | X | X | X | 原专用分阶段构造 |
| `stage_self_modify` | X | X | X | 原专用自修改边界 |

### 视觉观察（3）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `visual_history` | N* | N* | N* | 读取本 Run 已有视觉观察索引，避免重复读取图片；要求真实 observation owner |
| `visual_inspect` | N* | N* | N* | 读取已登记观察的原图/区域证据，保留媒体来源、部分失败与访问边界 |
| `visual_read_pixels` | N* | N* | N* | 对已有观察请求像素证据；不从 Script 递归扩权，未通过叶资格前保留原生 |

`script_exec` 是额外装配的正式 Script 入口，不在 81 个 registry builtin 名称中；
它携带 31 个有资格的完整叶契约（还需实际可见），bash 同时保留原生后台路径。
扩展/MCP 远端工具、run-scoped lease、自定义 Agent 工具是动态集合，不应伪造一个固定总数。
同名覆盖必须保留自己的契约，不能由“builtin 同名”推断可重写。普通 child 的 Goal 三项已被排除；
根自然语言、slash、SDK 的 Goal 路径仍保留，没有目标状态不等于能力不可用。

## 4. 普通内置子 Agent 紧凑合同：成对补回义务

候选入口为 [compact-child-contract.ts](../../packages/coding/src/prompts/compact-child-contract.ts)，
在本轮有限固定检查点配对后，**已接入普通内置 child 的实际请求，不是新用户配置**。
这是局部采用，不代表完整任务效率或模型统计非劣已经证明。原 child 系统字节移至独立常量模块，executor 原名 re-export，避免接入成环。
只有显式 `builtin-child` 来源、规范系统基段/写子项目附加段、规范核心工具及被审计契约匹配时投影；
SDK override、任何 specialistName、未知系统、同名定制工具、缺失核心或重复名称保持原合同。
实际存在的 spawn/wait/Todo 才追加对应共享义务，不把未绑定的协作工具重新开放。

| 被审计工具 | 规则归属与保留证据 |
| --- | --- |
| `read` | 本地描述保留行号/精确续读、run-scoped transient 引用、内联图像不重读、PDF 扩展边界 |
| `write` | 本地描述保留明确新建/全改、现有改动用 edit、UTF-8、流失败 skeleton 恢复；不绕 shell mutation/diff 检查 |
| `edit` | 本地描述保留先读、全文件唯一、顺序锚点、原子失败、不得整文件覆写规避失败 |
| `bash` | 本地描述保留用途、专用搜索、已知内容用 write/edit、后台能力、完整输出与恢复引用 |
| `glob` | 工具名/参数保留文件路径匹配；原本没有额外全局策略 |
| `grep` | 本地参数保留 regex/literal、类型/上下文、多行、分页、source incomplete 和字节上限边界 |
| `insert_after_anchor` | 本地描述保留唯一锚点插入，不改变恢复/写权限 |
| `spawn_agent` | 参数保留共享预算、父权限上限、隔离、同目录改动不重放、worktree合并策略；系统补回独立只读审查/独占写入 |
| `wait_agent` | 本地描述保留mailbox而非progress、用户中断、超时、消费证据后对齐里程碑；系统补回关键路径等待原则 |
| `send_message` | 本地描述/参数保留不另启回合、idle语义、权限可见性、转发链/分类不可降级 |
| `followup_task` | 本地描述保留idle新回合、running原位更新、无新slot和遥测非准入 |
| `list_agents` | 本地描述保留可见树、分页、状态、最近活动与共享容量 |
| `interrupt_agent` | 本地描述保留受控子树、turn/subtree、历史保留、外部不支持时明确拒绝 |
| `agent_output` | 本地描述保留受控Actor/Turn、有界结果和引用、禁止轮询完成 |
| `list_dispatchable_agents` | 本地描述/参数保留Host可派发范围、规范ID、readonly远端效果过滤 |
| `todo_create` | 本地描述保留生成ID/不替换/非执行/不为简单工作建计划；系统补回已有计划、交付里程碑与语言 |
| `todo_update` | 本地描述保留增量/状态/真正完成/评估hook拒绝后恢复；系统补回owner一个in_progress和语言 |
| `todo_list` | 本地描述保留权威ID、完整详情、仅未知/外部变化才刷新、inactive后不循环 |
| `memory_recall` | 本地描述保留当前MemorySession、只读、仅具体历史缺口、普通工具核实当前事实 |
| `session_history_search` | 本地描述保留省略历史的明确需要、不可猜、出处与只读必要条目 |
| `session_history_read` | 本地描述保留search引用、next_offset、revision并发变化 |
| `kodax_manual` | 本地描述保留产品问题第一来源、不能混用其他产品配置、版本文档与不读秘密 |
| `skill` | 本地描述保留已发现匹配时先调用、Available Skills阻塞义务、不要read SKILL.md、参数代入 |
| `tool_search` | 本地描述保留原生直接调、非原生走bridge、完整参数、select和保留已发现schema |
| `tool_call` | 本地描述保留原始policy/权限/结果guard重新执行，执行链不变 |

`memory_intent` 保持规范原文：child 没有根 Memory 治理段，不能假设已有“当前自然语言意图”等全局补充。
所有未列工具保持原状；以后新加入 root compact map 的项目不会自动进入 child 候选。
旧 child 的任务聚焦、批量独立读取、拒绝恢复、报告语言、停止调查条件、file:line证据和text-only收尾原文完整保留。
权限、预算、取消、专用角色指令仍由原执行链负责，不靠这段提示创造新能力。

离线合同对照（非 provider 完整首轮；repo off，无MCP/visual，保留协作/历史/Memory合同；
不含task briefing/动态权限/写子AGENTS正文）同一完整 `system+tools` 字段口径：

| 合同集合 | 工具数 | 规范估算 | 候选估算 | 净节省 |
| --- | ---: | ---: | ---: | ---: |
| readonly child | 35 | 8,972 | 7,597 | 1,375 |
| write child | 39 | 9,639 | 8,050 | 1,589 |

已扣除补回系统教学的成本；不是根 Agent 12K→10K，也不直接投影专用角色。
真实绑定会减少菜单，正式 probe 的完整输入/hash和计数单独留存，不能把本表当实际 API usage。

## 5. 验证与采用门槛

离线 RED→GREEN：先缺失候选模块失败，再添加最小实现；实际 executor 捕获发现无 Actor control 的子任务
本来就不提供协作入口，已修正候选资格识别，未改原能力边界。
原候选/child/root 146 项先通过；生产接线后，合同 7 项、私有来源 3 项、真实 provider 装配 5 项、
child executor 131 项、普通根兼容 9 项、Goal 子用量 6 项，共 161 项通过。
覆盖规范/候选 schema 约束等价、输入不变、只读无写入口、完整写项目规则、根默认不变、SDK/专用角色保留、
shared预算/Goal sink/guard传递和原恢复教学；真实 executor→Runner→substrate→fake provider 覆盖只读/可写、
有 Actor control、写子项目规则、相同文本 SDK override/专用角色、定制 visibility、跨两回合的 live 权限变化，
并对比已评估的规范/紧凑工具字节。真实 fit 造成不完整菜单时整对回退。新增教学只在请求内，不写进历史。
这些是确定性装配证据，**不是模型智能非劣证明**。

有限 GLM/Kimi/DeepSeek 固定检查点及真实任务已完成本批尝试，保存精确合同和输入 hash。
21次L2、27次两Run组合任务、11次真实child调用及报告语义限制，见
[验收记录](../test-guides/FEATURE_TOKEN_EFFICIENCY_v0.7.97_TEST_GUIDE.md)。不把未完成任务当通过，
不为通过反复跑完整矩阵。质量/往返、全任务token/未缓存token/费用/耗时分列，不把省首轮当唯一目标。

实际最小接线：executor 的每次普通 child 调用携带私有 AsyncLocalStorage 来源；专用角色显式遮蔽父来源。
substrate 一次认领来源并核对身份/原系统，防止同一异步链中的 SDK 嵌套调用自动继承。
实际可见性与预算 fit 完成后，仅完整匹配菜单和唯一原系统基段才成对投影；未知、截断或覆盖全部回退。
provider policy/skill 后缀保留；每次真实请求与 fallback 仍重新追加 live 权限，避免重试循环将配套规则覆盖掉。
自定义 SDK、专用角色、同名扩展不继承根投影；规范系统/持久化历史不改。调用次数和执行路由未增加。

本批正确性修复和普通child已采用；短编辑回执仍为独立候选。
下一优先核实deferred工具的自足短教学和直接调用，之后才是有明确净收益的Script参数表示/缓存专题。
Root继续做有证据的共享规则归属审计，不通过删除AMA、Memory授权或visual验收凑10K；
visual强制发现、细碎参数多跳发现、未证明等价的Repo/LSP工具合并均不作为默认方案。

## 6. 后续 deferred 批次更新（2026-10-31）

§1 保留上一提交基线。本次根首轮真实 SDK 抓包 `kodax-first-turn-wire-qaWpIi` 经同一完整字段口径重计：

| 场景 / 协议 | Agent | Coding | Script |
|---|---:|---:|---:|
| runtime-host，OpenAI | 12,023 | 15,592 | 17,536 |
| runtime-host，Anthropic | 11,778 | 15,218 | 17,372 |
| empty，OpenAI | 9,696 | 11,997 | 14,176 |
| empty，Anthropic | 9,487 | 11,715 | 14,032 |

12 格根场景均验证工具集合、顺序、参数及工具外模型字段不变，仅普通 deferred 短说明改变。
十项短说明支持直接调用，保留用途/refresh/作用域等有效教学；Workflow 仍保留完整激活指引。
code_search 的短说明兼容改动不重新引入其默认入口。全部 81 项工具的分配与底层能力不因本批改变。
Script 首轮叶契约本来完整，不因这项 native 短说明变化而减少。

成功 tool_search 的重复 parameters 仅在本次实际可见原生契约或真实 Script 绑定严格匹配时，从普通根模型请求省略；
完整 description 与 SDK/持久化仍保留，fitting/缺失/变更/歧义时从规范历史自动回退。没有新发现步骤、产品选项或执行器。
SDK override、专用角色和独立同名 search 扩展不自动投影。
最终冻结全量 18,333 项通过，三模式 Runtime 完整固定轨迹和有限三家 L2 证据见
[验收 §6](../test-guides/FEATURE_TOKEN_EFFICIENCY_v0.7.97_TEST_GUIDE.md#6-推送后冻结回归与-deferred-后续批次2026-10-31)。
根收益仅十余/七十余估算 token，主要后续收益是少回传已有参数副本；不能称为达到 10K 或证明稳定全任务提速。
