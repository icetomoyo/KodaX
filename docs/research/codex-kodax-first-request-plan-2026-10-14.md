# 对标 Codex：KodaX 首轮输入优化的完整计划

日期：2026-10-14。本文是实施前冻结的主计划；P1–P3 与 P0 的 KodaX 分账现已执行，Codex Rust 同条件捕获仍未完成，P4–P6 仍有条件待推进。实施、真实 wire 分账、有限模型盲审和 E2E 的最新状态见[实施与评估报告](first-turn-optimization-implementation-2026-10-14.md)。下文保留调研时的证据口径与计划，不把历史静态计数改写为本轮 API usage。

## 1. 结论与要解决的问题

**推荐方向：缩小模型必须理解的接口和重复教学，保留 KodaX 的结构化执行能力。** 第一版重点是工具契约、模型投影和 Worker 指令归属；低频工具隐藏、目录预算、缓存协议分别作为后续切片。沿用现有 SA/AMA、registry、bridge、runtime context 与诊断设施，不增加新的任务路由模型或用户可配置的注入模式矩阵。

用户已确认“Codex 更省”的观察来自界面 token / 上下文数字。当前证据能确认两件事：

1. **界面口径可能放大感知差距。** 本地 Codex CLI/TUI 的百分比扣除固定 12,000 基线，部分绝对 token 显示扣除 cached input；KodaX 显示当前上下文与窗口的直接比例。用户未明确界面类型，desktop 消费逻辑尚未核查，不能将 TUI 公式直接套到桌面。
2. **KodaX 的工具面确实更重。** 无外部内容的 Worker 组件基线约 25.8K，工具定义占 17.9K；Codex 的多个对应契约显著更短，但功能并非一一等价。Codex 完整首请求尚未捕获，不能给出可靠的总量差或倍数。

因此优化目标分成：**真实首请求输入降低、固定任务流程净成本改善、行为与可用能力保持、统计可解释**。界面显示变小不算输入优化，缓存命中也不等于内容不占上下文。

证据版本：KodaX `bd4479d59cab3d082f07c2d34681fff198d82fa0`；Codex `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`。本轮仅核查本地 checkout、运行离线计数，没有更新远程仓库、读取用户私有会话或调用 provider。

## 2. 同口径对标：目前知道多少？

### 2.1 界面数字不能直接横比

Codex TUI 的绝对 usage 主要使用 `max(input-cached,0)+output`；上下文百分比使用最后一轮 total，并对分子/分母同时减 12,000。这个常量包含 prompt/tools/compact 空间的展示预留，不是实际测得的每轮固定输入。原始上下文 token 绝对值仍保留。[公式](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2543)、[TUI 消费](C:/Works/PubProj/codex/codex-rs/tui/src/status/card.rs:357)。

KodaX 状态栏使用 `round(currentTokens/contextWindow*100)`；managed 路径在有 usage 时以 API total 锚定当前上下文，包含 cached input；无 usage 时才退回估算。不同模型的窗口容量也会改变百分比。[状态栏](../../packages/repl/src/ui/view-models/status-bar.ts:523)、[managed API 锚定](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:1454)、[Anthropic 输入归一化](../../packages/llm/src/providers/anthropic.ts:103)。

仅作公式演算：同为 128K 窗口、20K 当前上下文，KodaX 直接比例约 16%；Codex TUI 的用户可控部分约用掉 7%。底层内容没有因此减少。app-server 传出原始 total/last/input/cached 等字段，desktop 是否再做同样变换尚未证实。[app-server](C:/Works/PubProj/codex/codex-rs/app-server-protocol/src/protocol/v2/thread.rs:1974)。

**计划中的口径决定：** 保留真实容量统计；必要时解释“估算/API、当前上下文/累计调用、缓存读写”，不复制 12K 常量来制造更小的显示值。总输入、非缓存输入和费用是不同指标。

### 2.2 指令文本差距没有工具差距突出

以下都采用 KodaX 同一个文本估算法；工具 JSON 用明确的标准化表示，精确字符/UTF-8 bytes 另存。均不是 provider BPE 或 API usage。

| 受控组件 | KodaX SA | KodaX Worker | Codex sol / astra |
|---|---:|---:|---:|
| 主体指令与已计运行上下文 | 3,353 | 7,712 稳定 + 138 动态 | 6,525 / 6,437 |
| KodaX 完整已选工具组件 | 16,747（55 工具） | 17,922（59 工具） | 完整工具量尚未捕获 |
| KodaX 上述组件小计 | 20,100 | 25,772 | 不填完整总数 |

KodaX 场景：空隔离 home、空非 Git workspace，无 AGENTS、skills、MCP、历史、可选 hosts、permission suffix、自动 repo-intel bundle；SA full repo-intel 工具模式且应用 workflow-host 过滤；Worker 用真实 TypeScript builder。它用于剥离外部内容定位产品成本，**不是完整 REPL 初始化请求**。例如正常 root runner 会绑定 memory runtime，不能仅因空 builder context 就认定 memory 工具不应存在。[脚本](kodax-controlled-input-inventory-2026-10-14.ts)、[数据](kodax-controlled-input-inventory-2026-10-14.json)。

Codex 场景：bundled sol/astra、Default collaboration、low reasoning、无外部内容，显式选 never/full-access、固定 Windows 环境，V2 root 四并发。统计实际选中 base、collaboration、permissions、environment、V2 role/mode 文本，**尚未包含任何工具通道和用户输入**。它是源码文本重建，未执行 Rust builder。两侧权限和环境覆盖还未完全对齐，不能把约 1.3K 的文本小计差异当精确产品差额。[Codex 指令审计](codex-first-request-instructions-2026-10-14.md)、[数据](codex-first-request-instructions-2026-10-14.json)。

Codex 选中 base 本身约 5.4K，KodaX Worker 主规则单体约 6.1K，后者已含在 7,712 中。Codex 当前直接读取模型 catalog 的 instructions template，不再做 personality 插值，也不能用仓库旧 `prompt.md` 代替实际选中的模板。[Codex renderer](C:/Works/PubProj/codex/codex-rs/prompts/src/model_instructions.rs:8)、[Worker](../../packages/coding/src/agents/worker-role-prompt.ts:103)。

### 2.3 具体结构差额

| 能力 | KodaX 受控 Worker | Codex 当前核心做法 | 对计划的意义 |
|---|---|---|---|
| 文件/搜索/编辑 | 9 工具，约 3,113 | shell + write_stdin + apply_patch 为主 | 保留结构化编辑/搜索，先精简契约；更换执行方式需另证可靠性 |
| todo | 4 工具，约 3,901 | update_plan 默认关闭；开启后标准化组件约 175 | 本轮最高优先级；剥离内部兼容结构、重复字段教学 |
| repo-intel + LSP | 21 工具，约 4,022 | 核心无对应独立 schema，主要通过 shell/扩展 | 值得单独做按需展示；不能把不同能力当等价删除 |
| 协作 | 8 工具，约 2,297 | V2 仍有 spawn/send/followup/wait/list/interrupt 六工具 | 保留操作分离与生命周期，缩短重复教程 |
| 问答/退出计划模式 | 2 工具，约 1,549；其中 ask 1,319 | 两个问答组件合约 698 | 对齐契约并去重复；保留 KodaX 自由输入、回调和审批语义 |
| 其余工具 | 15 工具，约 3,040 | 核心/插件/host 的分工不同 | 逐项按实际 capability 与调用价值决定，不统一删除 |

表中 Codex 数字来自有限 schema 源码重建；并非等价能力的性能对照。详细逐工具名单、条件、输出 schema 与包装遗漏见 [工具专项审计](codex-first-request-tools-2026-10-14.md)。

两个 Codex bundled 模型默认为 CodeModeOnly。受控核心组是 11 个原生 callable 加 8 个 exec 内嵌 callable；仅 exec 固定帮助与这八个 SDK 的说明/输入输出声明就约 2,747，尚未计原生问答、协作、wait、web、目录和协议包装。**不能把这 2,747 与 KodaX 17,922 相减。** 第一方 request snapshots 又经过截断，只能确认名单与布局，不能按文件大小计算完整请求。[组件重建](codex-tool-components-2026-10-14.json)、[CodeMode 组装](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1011)、[snapshot formatter](C:/Works/PubProj/codex/codex-rs/core/tests/common/context_snapshot.rs:24)。

另一个行为差别：选定 low reasoning 下 Codex V2 默认 explicit delegation；KodaX Worker 有 parallel-first 策略。首次用户任务累计量还可能受子 Agent 数和执行轮次影响。优化首请求时保持这一产品策略；若以后调整自动协作强度，独立评估其质量与成本。[Codex mode](C:/Works/PubProj/codex/codex-rs/core/src/session/multi_agents.rs:84)、[KodaX parallel-first](../../packages/coding/src/agents/worker-role-prompt.ts:204)。当前 KodaX routing 已是启发式，没有额外 LLM router 调用，不能把不存在的启动路由请求列为节省来源。[routing](../../packages/coding/src/reasoning.ts:1255)。

## 3. 推荐架构与明确取舍

### 3.1 执行能力与模型接口分开

保留现有完整 registry、SDK/handler、权限与目标分派。为模型生成一个更小但自洽的表示：

- 核心工具继续直接调用，保留完整必要参数与副作用语义。
- 内部 runner-only 兼容字段只留在内部接口。
- 当前 host/role 确实不具备的能力，不进入模型工具表或发现目录。
- 可用但低频的工具可通过短用途目录和现有 bridge 到达。

实施上先用 coding 内一个私有纯函数处理确切的模型投影，不创建公共配置框架。SA、AMA 出站，以及 search/describe 返回的模型文档复用同一投影。原始 registry 定义保持不变；通用 `packages/llm` 不知道 todo/Actor 等产品概念，`packages/agent` 独立可用性保持不变。

现有 exclude-based 执行注册修复过遗漏工具的故障，应保留。后续每个可执行工具必须满足“直接可见、可发现调用、明确因当前能力排除”之一；不能通过缩短白名单重新造成静默失联。[exclude 背景](../../packages/coding/src/task-engine/_internal/managed-task/role-exclude.ts:17)。

### 3.2 指令的源码归属清楚，首次决策前完整可见

| 内容 | 主位置 | 保留要求 |
|---|---|---|
| 范围、授权、可信来源、完成责任 | 短稳定策略 | 首次行动前可见，保留独立 child 所需版本 |
| 何时规划/协作、review 时序、repo-intel 选择 | 按实际能力组合的短策略 | 条件、顺序、例外、fallback 都保留 |
| 参数含义、合法状态、metadata merge/null、原子编辑限制 | 工具局部契约 | 首次可调用前完整可见 |
| 大段例子、重复参数教程 | 清理或现有按需文档 | 核心工具不额外维护长短两套近义文案 |
| cwd、容量、模式等事实 | 现有 canonical context / delta | 首次必要快照，变化才追加，压缩后从宿主恢复 |
| todo 漂移/child 结果/重复失败 | 已有 runtime reminder | 在相关下一次采样前投递，按真实事件去重 |
| 显式 skill | 直接展开正文 | 用户已确定使用，无须再增加发现往返 |
| 未选 skills/MCP | 短目录与按需正文 | 保留触发语义、名称与获取路径 |

同一语义主位置唯一，不等于整个产品只能出现一次。root、child、SDK 工具使用路径可能独立；短的选择提醒与调用局部限制可以互补。不要把尚未展开的 tool result 当作首次决策前已知内容。

### 3.3 第一版保持的产品行为

保留增量 todo 实体和稳定 id、完成 hook、metadata、owner/evaluator；保留问答的单问、批量、自由输入与既有返回形状；保留协作操作与 root 整合责任；保留结构化编辑/写入追踪、repo-intel 能力、当前权限边界。

Codex 的 update_plan 是整份 step/status 列表，与 KodaX 的实体化里程碑不同。直接替换会涉及 UI、SDK、并发写入及恢复；把四个工具合成一个带 op 的泛型工具也未必减少总 schema。第一版用更短的现有契约，避免新增 todo_v2 或 agent_control 双接口。[Codex plan](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/plan_spec.rs:7)、[KodaX todo 类型](../../packages/coding/src/types/todo.ts:13)。

第一版也不引入完整 Code Mode、provider 原生 ToolSearchOutput、缓存预热或模型关键词分类器。这些有独立成本和协议条件，目前不是缩小核心契约的前提。

### 3.4 DSH、pi 的经验如何进入这份计划

DSH 的多个“注入模式”解决的是不同问题：system section 管行为策略，runtime snapshot 管环境事实，skill catalog/body 管发现与正文，inbox 管投递时机，provider history update 管传输。它们不是一个通用精简档位。尤其 minimal 的 `includeRuntimeContext: false` 仍保留 required context；PTC 把完整 SDK 放入 system，也不等于 schema 成本消失。[DSH assembly](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:578)、[DSH SDK](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:897)。

本方案采纳其**按真实能力组合策略、显式 skill 直接展开、状态变化才注入、必要事实不可抑制**的分工；不复制其完整配置组合。DSH 的动态上下文追加会继续增长历史，不能把稳定 system 前缀当成减少首次输入的证据。[DSH read guidance](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs/src/read.ts:68)、[skill 显式入口](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:165)、[runtime 去重](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:146)。

pi 提供两个有用边界：system 只收活跃工具贡献的短 guidance；工具移到 Code Mode/按需描述后，必要使用规则也必须随工具迁移。其客户端 activation 可以作为 P4 的对照，但 KodaX 已有 bridge，因此先复用现有执行路径。pi 的 compact/resume 还说明，发现状态需要结合当前权限恢复，不能只相信历史文本。[pi system](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:90)、[guidance 回归](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-codemode.test.ts:153)、[activation](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:164)、[resume](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1815)。

综合取舍是：**必要策略常驻、核心契约精简完整、可选能力可发现、状态按事件投递**。这是内容责任与时机的约定，不新增 full/minimal/auto 等用户配置，不把具体工具选择交给另一个模型。

## 4. 实施计划：必要切片

### P0：冻结基线和语义义务

**交付**：可复跑的最终请求账单、当前能力矩阵、候选规则归属表。

1. 延续本轮空外部内容 fixture，再增加固定 AGENTS、小型 skills/MCP、真实默认 REPL host 四类场景。每次只增加一个变量。原始用户任务、OS、权限、model/effort、agent mode、feature flags、fixture bytes/hash 全部固定。
2. KodaX 通过现有 provider/mock client 测试接线，捕获序列化后请求，分别覆盖 OpenAI-compatible 与 Anthropic 路径，主场景为默认 Worker，SA 和独立 child 做契约对照。
3. Codex 复用已有 mock transport 场景，导出未经 snapshot formatter 截断的首次 request；选择 bundled sol/astra，并保留一个同能力 Direct 反事实组。源码重建与真实 Rust builder 对拍。构建成本与 KodaX 功能实现分开；在此完成前，不发布 Codex/KodaX 总量比值。
4. 分账 base/developer/runtime、项目规则、skills/MCP 目录、显式正文、原生 tools、exec/SDK、用户输入；同一内容只算一次。字段记录字符/字节/估算、真正 usage 和来源。配置/模型名称等非模型输入元数据不当作 prompt token。
5. 复用现有 `onContextBudgetSnapshot` / cache diagnostics。常规日志只保留长度、计数、hash；使用合成 fixture 的完整 payload 放受控临时目录，不默认记录真实用户 prompt。

相关接线：[SA 出站](../../packages/coding/src/agent-runtime/run-substrate.ts:1768)、[AMA 出站](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)、[预算结构](../../packages/coding/src/agent-runtime/context-budget.ts:14)、[provider mock 模式](../../packages/llm/src/providers/openai-message-serialization.test.ts:1)、[Codex 实际请求](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:977)。

**验收**：模型输入各组件可追溯，没有重复累计、漏掉 SDK/工具通道或将估算当 usage；稳定 fixture 多次运行内容 hash 一致；root/child 与第一请求/任务累计明确区分。P0 零外部模型调用。

### P1：先修明确的工具契约与能力错配

这批纠偏与纯文字精简分开提交，避免把行为修正误称为等价重写。

**问答接口：** `ask_user_question` 顶层 currently required question，但 handler 支持 questions-only；registry 会先按 requiredParams 拦住它。修正 registry-visible required 与 handler 的合法分支一致，补真实执行入口测试。删除误入的 specialist `agent_id` 字段。保留现有三类 host callbacks 和返回形状；不直接统一成 questions[]。[定义](../../packages/coding/src/tools/tool-definitions.ts:1187)、[registry 门禁](../../packages/coding/src/tools/registry.ts:469)、[handler 分支](../../packages/coding/src/tools/ask-user-question.ts:193)。

**能力过滤：** AMA builder 在没有外围 visibility policy 的独立调用中仍可展示无 runner 的 `run_skill_script`，调用必报 unavailable；补本层条件，并与 SA、发现目录一致。已绑定 Runtime 路径另有 policy 防护，不能宣称所有 CLI 都存在泄漏。memory 则必须按真实 root runner 绑定情况保留，不能按空 fixture 盲删。[AMA filter](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:106)、[skill runner 要求](../../packages/coding/src/tools/skill-script.ts:42)、[真实绑定差异](kodax-codex-gap-implementation-2026-10-14.md)。

**验收**：questions-only 经 registry 成功；单问 select/input、多选、取消、默认值、custom input 行为保持；无 runner 时直接工具和搜索都不宣传能力，有 runner 时仍可达。使用可独立调用的 coding/SDK fixture，不能只测 handler 或只测完整 REPL。

### P2：模型投影去掉内部兼容结构，精简 todo 教学

**具体文件与动作：**

- 在 `packages/coding/src/tools/` 增加或邻接现有 resolver 放一个私有纯投影函数；首个分支仅针对 `todo_update`，不用抽象插件机制。
- 模型 schema 删除 `op/items`，id 必填，description 去除 legacy init 教程和重复 `op=update only` 前缀。raw registry/handler 继续接受内部 init。
- 在 `agent-runtime/tool-resolution.ts`、managed adapter 最终 wire tools、`tool-search.ts`、SA/AMA describe 输出复用该投影。特别覆盖 AMA override 早返回路径；只改普通 registry wrapper 会漏掉 todo override。
- 四个 todo descriptions 缩为各自的增量新增/patch/列表/单项差别，保留状态、metadata、hook 等必要限制；字段含义放一份，不在 description 再列全套 Fields 教程。

仅 op/items 现存 schema 片段差值为 1,689 字符 / 1,695 bytes；这是待处理库存，最终还需扣除新 required 等改动，不作为已实现节省。四个 todo 描述合计 9,168 字符，Worker 另有 plan-first/hygiene；可以优先去重复，但不可将整个库存当删除空间。[具体审计](kodax-codex-gap-implementation-2026-10-14.md)。

**必须保留**：稳定 id、unknown-id 错误、增量 patch、cancel/delete 区别、metadata merge/null、evaluator 与 completion veto、owner、续跑状态。模型展示不是权限机制；内部兼容和目标执行仍走原有路径。

**验收**：投影不改变原对象；所有模型出站/发现文档一致；内部 legacy init 回归通过；现代调用行为不变；实际请求体积减少；受控模型 probe 关注正确建/更新计划及简单任务豁免。对 KodaX 源码和公共 SDK 无不必要破坏性迁移。[todo 回归基础](../../packages/coding/src/tools/todo-update.test.ts:256)。

### P3：压缩 Worker 重复教学，按能力保留短策略

先由人可审阅的“现行义务 → 候选表达 → 出现位置/时机 → 独立入口”表驱动编辑；每个条件、例外和恢复责任要有去向。

具体修改 `agents/worker-role-prompt.ts`、managed `role-prompt.ts`，必要时与 SA execution guidance 复用小的现有 helper：

1. Worker 移除重复的 todo 字段/JSON 例子，保留何时规划、trivial 豁免、续跑复用、按语义里程碑更新。
2. 将协作参数签名和工具返回形态留在工具契约；Worker 保留分工时机、写所有权、send/followup 的意图差别、完成整合与等待纪律。
3. 将 repo-intel 的逐工具介绍/WHEN/CHANGE-REVIEW 重复段收敛成一次任务到工具的短选择策略；保留先 scope→fanout→diff、精确源码 read/grep、失败 fallback。相关工具已被 host/role 关闭时，用真实能力过滤掉对应指导。
4. 合并重复 routing 字段、同一路径 scratch 说明及语言规则；语言覆盖 todo/协作 objective/进度/最终输出等，不缩成含糊的“用用户语言”。
5. 分开处理 todo status 漂移、git diff 选择、read-first 强度、旧角色/plan approval 文案。对无法由 runtime 判断的产品语义，列为独立决策，不以删短替代决定。

保留首次决定前必须知道的规则；runtime reminders 补充真实状态，不把所有规则迁到工具执行之后。对 child 重新检查独立 system override、readonly/write/specialist 与 fork/resume，不能假定继承 root 的全部短策略。[义务与冲突表](prompt-guidance-risk-kodax-2026-10-14.md)、[child override](../../packages/coding/src/child-executor.ts:1119)。

**验收**：同能力下 SA/AMA/child 指导自洽；没有要求调用不可用工具；不可删的行为在首次相关决策前可见；compaction 后仍有稳定规则和 canonical context；必要的盲化模型比较未发现有实质影响的回退。允许保留经证据确认有价值的短重复，不为达成字数目标牺牲行为。

## 5. 后续按成本触发的切片

### P4：低频工具真正延迟 schema

在 P1–P3 完成并重新计数后，先评估 LSP 单族；完整 repo-intel 作为独立后续组，因为它影响首次探索策略。9 个 LSP 当前约 1,590，21 个 repo/LSP 合计约 4,022，均是移出首轮的毛上限，实际还需目录和发现调用成本。项目规则、核心编辑、todo、交互和协作保持直接可用。

首选实验路径：**复用固定 bridge**。理由是目标执行/权限路径已存在，AMA 当前 tools 静态构造；移植 native activation 还需要额外活跃状态和恢复机制。search 已返回完整契约，下一轮即可 tool_call，不强制 describe。原生激活可作为后续对照，不能预先认定质量更差或更好。[bridge 审计](prompt-injection-codex-pi-2026-10-14.md)。

同一个切片必须一起完成：

- 从真实可执行/获准集合生成目录和检索范围，加入待隐藏族及可理解的中英文用途。
- search/describe 返回 P2 的统一模型契约，不回流 raw legacy schema。
- SA 分离“说明已读”与“恢复原生可见”；现有 already_unlocked→resident 会使 bridge 后又重曝 schema。
- AMA 只过滤模型视图，保留完整内部执行工具表与 target permission hooks。
- compaction 后目录、bridge 仍在，缺失契约可重新获取；resume/child/provider switch 重新应用当前权限，旧历史不授予新能力。

**验收**：直接/发现/bridge/拒绝四条路径边界一致；中文发现、参数正确性、取消、多模态、写入 guardrail、压缩恢复通过；固定发现→调用流程净成本值得改。若首请求减少但频繁额外调用使总体更差，该工具族保留 direct。

### P5：目录与自动上下文预算

只处理 P0 显示体积显著的真实配置。MCP 已有 320 估算 token manifest 预算，skills 已分目录/正文，不能把它们重新设计成“新发现能力”。优先去同来源重复、冗长目录前导及重复仓库证据；超大 skills 目录才扩展现有按需发现入口。显式 skill 继续直接加载。[MCP 预算](../../packages/agent/src/capabilities/mcp/provider.ts:37)、[skills formatter](../../packages/agent/src/capabilities/skills/skill-registry.ts:24)。

AGENTS 保持作用域、优先级和必要全文，不用任务关键词猜测可删规则。自动 repo overview/preturn 与 project snapshot 单独对拍，确认重复才合并；目录/源码细节可由现有 pull tools 获取。首批不设任意百分比裁掉用户规则。

### P6：缓存与显示解释

基础顺序确定、稳定规则先放、事实变化才追加，复用现有 diagnostics。provider 特定的 in-history/additional-tools 只有在热请求瓶颈被证实后单独适配。当前 OpenAI/Anthropic adapter 合并历史 system 到前置 system，因此内部 append 不代表 wire 前缀没变。[OpenAI](../../packages/llm/src/providers/openai.ts:564)、[Anthropic](../../packages/llm/src/providers/anthropic.ts:1366)。

若用户仍难理解状态栏，优先补现有状态/诊断信息的指标说明和来源，保持当前容量真实；不新增复杂仪表盘，也不以调整显示抵扣代替内容优化。

## 6. 验证矩阵与付费试验边界

按 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md) 执行。当前仅完成源码/离线组件审计，下列是实施后的预注册框架，未启动。

| 层次 | 主要案例 | 验证方式 |
|---|---|---|
| 零模型结构/契约 | 所有出站投影、SDK legacy、问答 host 组合、visibility、bridge 权限 | 测真实入口、最终序列化和状态副作用；不只测 handler/字符串存在 |
| 零模型生命周期 | 新建/续跑/compact、readonly/write child、specialist、权限/host 变化 | 每条路径当前能力、必要规则、已丢文档的重新到达；历史不复活已禁用工具 |
| 单次响应行为 | 简单任务不建 todo、多步维护计划、review 分工时序、合理编辑恢复 | 固定 production prompt/tools/history，捕获下一响应，不执行模型工具 |
| 受控两轮行为 | 中文发现→正确调用、恢复后重取契约 | harness 注入固定工具结果和终点；同时量两轮成本，不自由跑 agent loop |

候选先按独立变更轴比较：A 当前；B 契约投影/文字去重；C 行为纠偏；D 隐藏一族 schema。B/C/D 不混成一个实验。所有 tools 使用真实生产描述和 schema；mock fixture 改变时重新记录版本/hash。

**建议首批 pilot 上限（不是本轮调用授权或执行记录）：**

- 文本/契约比较：`zhipu/glm52` 与 `ark/v4flash` 作为两条候选路线，冻结真实 provider/model/effort 后执行。2 个有区分度案例 × 2 arms × 2 模型 × 1 次 = 8 calls；先核查 case，有需要才加第二次，最多 16 calls。
- 单调用输出最多 2,048；每 cell 1 轮/1 call；整个上述 revision 最多 600K input+output tokens、外部费用硬上限 $3、单调用 timeout 120s。费用预估须在执行前根据实际 route 重新核算，不把此上限当作价格报价；任一上限先到即停。
- P4 两轮流程仅在需要时另开 revision：2 案例 × 2 arms × 2 模型 × 2 轮 = 16 calls，必要的第二次重复后最多 32 calls；上限 1.2M tokens、$5、每 cell 最多 2 轮。工具返回长度预先固定；不自主追加 describe/repair/child。
- 同 provider 默认单请求并发，按实际 fallback route 排队。不开额外 judge panel；当前主会话盲化配对评审，保存机械观察、case verdict、揭盲映射和理由。原始输出放 OS 临时目录的 `kodax-eval-dumps`。

这些参数在候选冻结后仍需做输入大小预检：若保留的必要历史使每调用预算不成立，先缩减实验范围/调整并重新冻结预算，不能执行到一半悄悄放宽。16 + 32 是两类首批 revision 的上限，不是必须耗尽的样本数，也不自动授权为每个小改动重复整套。

**发布判断**：在相同 fixture 中实际出站体积下降；必要语义/权限/SDK 兼容保持；盲化评审总体有价值且无可信的高影响回退；新增发现流程的调用数、重试、输出、缓存和延迟均报告。样本不足只说明置信度有限，不用机械全票或旧 DROP 标签替代分析。

## 7. 依赖、提交与回退安排

建议切成可独立评审的提交/PR：

1. P0 基线 fixture 与分账，固定旧请求和义务表。
2. P1a 问答真实入口契约修复；P1b capability 过滤一致性，两项可独立进行。
3. P2 模型投影与 todo 教学；先 RED 测试 SDK/模型面区别，再最小实现，确认新旧契约兼容。
4. P3 Worker 教学整理；文字去重与 read-first/plan approval 等语义纠偏分开提交。
5. P4 仅一族按需工具实验；达到条件才启用到默认路径。
6. P5/P6 依据剩余账单决定是否必要，不为“计划完整”强制开发。

P2/P3 的模型比较必须使用各自父提交作为 baseline；后续候选重新冻结当前 substrate。P4 回退时恢复该族模型可见 schema，保留原 registry 和持久会话格式，因此不需要迁移已保存用户任务。首批不新增配置 flag、session 格式或公共 API；若实现迫使这些变化，返回设计审查，不能混入优化提交。

项目 TDD、包独立性、无 any 等规则仍适用。使用既有 todo、ask、role-prompt、tool-wiring、bridge 和 provider serialization 测试扩充真实边界；避免为删一句描述新增只复制实现的断言。相关测试通过后才运行必要的模型 probe，不直接启动完整 provider panel。

## 8. 完成定义与尚未决定事项

第一版完成意味着：P0 有真实请求账单；P1 明确错配修复；P2/P3 候选减少了产品自身固定输入，核心行为、独立 SDK/child 和恢复路径守住；收益与残余成本可复核。P4 是否纳入由实际净收益决定，不把所有高级工具隐藏作为完成前提。

节省目标由最终候选账单确定。当前不承诺“达到 Codex 的某个数字”或“减半”：Codex 完整 payload 未捕获、能力不同，而且用户规则/外部插件成本不是 KodaX 内建开销。不会将几乎所有成本先列作可删再相加；每条收益都要有同一 fixture 的 before/after。

未决事项集中在：Codex desktop 具体显示公式及该安装的功能配置；完整 Codex 最终请求；KodaX read-first/旧 plan approval 的最终语义；按需工具的实际跨语言到达率、参数质量和净成本。它们不阻止先做确定的契约/重复整理，但限制了可以对外声称的结论。

## 9. 调研交付物

- [Codex 指令、默认上下文与 UI 口径](codex-first-request-instructions-2026-10-14.md)，附 [脚本](measure-codex-first-request-instructions.mjs) / [数据](codex-first-request-instructions-2026-10-14.json)。
- [Codex 工具名单、条件和部分组件重建](codex-first-request-tools-2026-10-14.md)，附 [脚本](codex-tool-components-2026-10-14.mjs) / [数据](codex-tool-components-2026-10-14.json)。
- [KodaX 具体契约改动与测试切面](kodax-codex-gap-implementation-2026-10-14.md)。
- [KodaX 空外部内容实际 builder 数据](kodax-controlled-input-inventory-2026-10-14.json) / [脚本](kodax-controlled-input-inventory-2026-10-14.ts)。
- [前一轮注入方案](prompt-injection-design-kodax-2026-10-14.md)、[逐项规则风险](prompt-guidance-risk-kodax-2026-10-14.md)、[DSH 注入机制](prompt-injection-modes-deepseek-harness-2026-10-14.md)。

上述调研阶段执行了离线计数与文档检查，没有修改产品代码或运行付费模型试验。后续实施与评估另见[汇总报告](first-turn-optimization-implementation-2026-10-14.md)；本文的候选收益与建议预算不替代实际执行账本。
