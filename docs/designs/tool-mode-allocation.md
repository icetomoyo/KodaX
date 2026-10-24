# Agent / Coding / Script 全量工具分配

2026-10-24；**完整目标分配。Agent/Coding 的 opt-in SDK 工作面已落地；Script 和产品切换 UI 尚未实现。** 总设计、源码对标、历史收益与分阶段计划见
[全盘方案](tool-portfolio-plan.md)。用户选择一个入口、三个名称，Coding 原生默认。
本表对账 KodaX `8d3f05e0` 加当前工作区的 78 项 builtin；动态工具另列规则，不冒充只有 78 项能力。

## 1. 分配语义

| 标记 | 含义 |
| --- | --- |
| N | 原生直接呈现；继续遵守现有绑定、权限、专用角色和产品装配条件，不代表所有 Host 都注入 |
| S | Script 首个请求已提供完整可调用 SDK 契约，经原工具执行链执行；不先 search/describe，不重复提供同一份 native schema |
| — | 普通 Agent 工作面不装配此专项入口；Coding、Script、SDK 和专用角色保留底层能力 |
| C | 现有兼容能力，不重新加入默认 native 或 Script SDK 菜单；旧 SDK/角色与允许的桥接调用保持兼容 |
| N* | 仅沿用现有有效 Host/provider 绑定条件，不增加新的“无当前状态就隐藏”判断 |
| X | 仅原有 construction 专用路径可装配，三个普通 AMA 模式都不自动开放 |

**工作面与权限不同**：模式不能授予原本不允许的能力，也不能借 tool_call 绕过既有权限、角色或隔离。
Agent 的“—”不是删除 registry/SDK，也不关闭 AMA 共用的 RepoIntel 服务；主 Agent 显式选择的通用菜单
与合法专用子角色的菜单不必相同。不得把专用角色误判成默认 root 后套本表。
纯呈现与发现可达性须分别建模，沿用已有控制；不能用权限禁止冒充延迟呈现，也不能偷偷扩大已有桥接可达范围。
当前 A/B 实施中，Agent 不装配的专项入口在发现/桥接中也不开放；这不是等待 search 解锁的延迟工具。
`changed_diff_bundle` 与 `lsp_prepare_call_hierarchy` 的 C 标记保留底层 SDK/角色兼容，
不允许通过别名绕回 Agent 已退出的专项工作面；Coding 的既有别名桥接行为不变。

## 2. 78 项逐项分配

### 文件、执行、搜索与隔离（11）

| 工具 | Agent | Coding | Script | 保留或分配依据 |
| --- | --- | --- | --- | --- |
| `read` | N | N | S | 文件证据与读取边界；通用任务也需要 |
| `write` | N | N | S | 新文件与可信写入，不绕过原事务 |
| `edit` | N | N | S | 精确修改、批次编辑与冲突检查 |
| `bash` | N | N | S | 原有跨平台命令执行、测试及进程治理；Script 不直达宿主 shell |
| `glob` | N | N | S | 不依赖外部 rg 安装的路径定位 |
| `grep` | N | N | S | 内置内容定位，保留字面量/正则、ignore 和截断契约 |
| `undo` | N | N | S | 原可信历史撤销；不能将脚本部分失败冒充自动回滚 |
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

## 3. 动态工具与 Script 新入口

扩展、同名覆盖、Host binding 和运行期 lease 不得被静态 78 项清单吞掉。
未经嵌套执行资格验证的扩展保持现有原生/发现表示，不因 readonly 标签自动判定可脚本调用；
不得依据 builtin 同名标记把一个有交互副作用的覆盖实现送进 SDK。
资格应来自实际执行契约，覆盖后重算，不添加第二份独立执行实现。

拟新增 Script 编排入口 `exec`，如确实需要跨请求长任务则配套 `wait`，最终名称/生命周期在实现审查冻结。
这不是 registry 已有的 78 项，首轮成本要另计。原生控制项仍存在，因此不能宣传 Script 只有一个工具。
一次模型可并行原生工具本来就无需多轮，Script 的潜在收益在数据依赖、局部筛选与减少中间大结果回传。

基于本表、不含扩展/条件能力，Coding 的 54 项分成 **32 项 S + 22 项 N**；
Agent 对应 36 项原生，减少 18 项专项入口。此为表内核算，实际 Host 还需按绑定/权限装配；
**入口数不等于 token，32 项契约仍要计入 Script SDK**。不得以少提供参数说明制造虚假首轮收益。

Script SDK 与对外 TypeScript SDK 是两回事：前者是模型在受限代码宿主中的调用面，后者继续向程序调用方
保留原接口。S/N 的变化不要求现有 SDK 调用迁移；兼容别名不会为 Script 再生成一份常驻声明。
SDK 结果保持工具真实返回格式、错误、截断与出处，不把原文本结果伪装成有稳定语义字段的对象。
模型可在代码里处理结果，但测试状态、拒绝/失败、部分写入回执和待处理交互必须可靠上报，不能仅靠模型自选 print。

## 4. 上下文分配

| 内容 | Agent | Coding / Script |
| --- | --- | --- |
| 用户指令、适用 AGENTS/项目规则、权限与平台/cwd | 保留 | 保留 |
| AMA 规划/派发/恢复/收尾、Goal/Todo/交互契约 | 保留现有策略 | 同一策略，不能从 native 数量推断能力退化 |
| 用户选择的技能、记忆、会话与已完成回执 | 按原规则保留 | 按原规则保留 |
| 自动 Repo 概览、活动模块、结构/索引摘要 | 默认不自动加入专项摘要；用户提供的仓库材料不删除 | 继续现有装配，仅去已确认同源重复 |
| LSP、RepoIntel 能力说明 | 无专项入口则不教该入口；不关闭共用服务 | 依有效绑定/明确关闭规则，未启动不等于不可用 |
| 程序化执行说明与完整叶 SDK | 无 | Coding 无；Script 有，包含预算/取消/部分失败/输出契约 |

Agent 仍可用文件/命令完成零星编码任务，但不承诺它与全能力 Coding 对复杂仓库任务等价；
Coding/Script 才是相同能力工作面的严格对照。不同模式不是由额外分类模型自动选择。

## 5. 实施与验证接口

仅从同一个权威目录派生工作面、允许能力和模型表示；SDK、发现、桥接、专用角色分别核对原契约。
Coding 首先与当前 normalized wire 比较，确保模式框架本身没有移除能力或重写 AMA 教学。
Script 逐叶核验同权限、同预算、同事件、同错误/取消/恢复，不因外层 exec 包装重复计费或遗漏内层调用。
模式切换只能在安全空闲边界生效，持久化一个模式值，不自动清空历史、重放 cell 或改变模型/权限。

完整验证顺序、GLM/Kimi 配对和停止条件见[总计划第 7 节](tool-portfolio-plan.md#7-改动计划与验收顺序)。
离线回归回答权限/装配/预算问题；真实模型仅回答契约可理解性、自主选择、完整任务质量与恢复是否改变。
所有全任务统计包含子 Agent/辅助请求与 Script 执行器成本，同时报告输入/输出/缓存 token、参考费/实付差异、
串行往返、总请求、工具调用及墙钟时间。按任务和 provider 展示退化，不能用平均节省掩盖质量损失。
