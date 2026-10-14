# Codex 首请求工具：默认 surface、可复现组件计数与 KodaX 对照

日期：2026-10-14。只读参考仓库；无网络、模型调用、付费 eval、Rust 构建或产品修改。

## 结论及证据边界

当前源码支持“Codex 的核心工具契约显著少于 KodaX 59 工具”这个结构性判断，但**不能据此声称完整 Codex 首请求比 KodaX 少某个确定 token 数**。Codex bundled `gpt-6.1-sol`、`gpt-6-astra` 默认是 CodeModeOnly：原生工具少，然而 `exec.description` 仍内嵌非 deferred 工具的完整说明、输入/输出 TypeScript 和通用运行时帮助。真正可量化的差额包括计划模型：Codex 默认关闭 `update_plan`；即使开启，其标准化组件只有 700 ASCII 字符（约 175），而当前 KodaX 四个 todo 工具共约 3,901。它们并不具备同等语义，不能把差额直接当安全删除预算。[C1,C2,C6,K1]

本文证据分三种，不能混算：

1. **真实 first-party request snapshot**：确实由 Codex builder/mock transport 生成，但快照只保留工具名/哈希、提示截断，不包含完整工具描述。可以确认 surface，不能算整请求。
2. **静态 source reconstruction**：本研究脚本提取原文，手工转录有限几个 schema，按 Rust renderer 的相关分支生成声明。可精确计数这个重建组件的字符/字节；并非运行 Rust builder，亦非 wire capture。
3. **KodaX 实际 TypeScript component builder**：主研究脚本在空 home、空非 Git workspace 构造 Worker/SA。工具表示统一为 `JSON.stringify({name,description,parameters})`；无原生 type/namespace wrapper。估算是 `countTokens`/ASCII 字符除 4，不是实际 tokenizer/API usage。[C3,K1]

Codex 固定 commit `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`，根目录 `C:/Works/PubProj/codex`；KodaX 固定 commit `bd4479d59cab3d082f07c2d34681fff198d82fa0`。以下 C 引用均在该 Codex commit，K 引用均在该 KodaX commit（研究产物为未提交文件）。复核时须保留 commit，行号本身不够。

## 默认能力与可对照的 direct 组

两个 bundled 模型均为：`tool_mode=code_mode_only`、`multi_agent_version=v2`、`use_responses_lite=true`、`supports_search_tool=true`、freeform apply_patch、`experimental_supported_tools=[send_user_message_async,clock]`，且 `model_messages.tools=null`（工具文案使用源码默认，无 catalog 覆盖）。`send_user_message_async` 在注册处映射到 `request_user_input_async`。模型元数据优先于 CodeMode feature flags，所以只把 flags 设 false **不会**把这两个模型切到 direct。[C1,C2]

受控核心组：root agent、单个本地环境、标准默认 flags、无 MCP/app/extension、无自定义 agent roles、未开启额外工具。它是静态推导的核心组，不代表桌面实际配置。

| surface 层 | bundled CodeModeOnly 核心组 | 同能力 direct 对照组 |
|---|---|---|
| 原生直接工具 | `functions.exec`, `functions.wait`, `functions.request_user_input`, `functions.request_user_input_async`; `clock.sleep`; `collaboration.followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent` | 去掉 exec/wait 包装；保留问答、sleep、6 协作；把下列可用 SDK 工具作为直接工具 |
| exec 内完整 SDK 声明 | `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `clock__curr_time`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` | 前五个保留。无 MCP 时后三个不注册；配置 MCP 后才加入 |
| 计划 | 默认不注册 `update_plan`；开启后进入 SDK | 默认不注册；开启后直接暴露 |
| deferred 外部工具 | 本受控组没有；若有则单独处理目录/发现机制 | 同样取决于外部工具和模型 search 能力 |

由此核心 CodeModeOnly 有 11 个原生 callable 加 8 个嵌入 callable；direct 对照有 14 个 callable（上述无 MCP 条件）。这些计数只是复核名单，**不是 token 结论**。direct 对照须在离线 fixture 中覆盖 model.tool_mode=Direct，保留其他模型能力，而不是宣称产品默认为 direct。源码测试已经采用这个 model override 方法。[C2,C4]

默认开关关键点：ShellTool、UnifiedExec、ViewImage、SleepTool 为 true；update_plan 是 opt-in；request_user_input 是 opt-out；多代理 V2 `non_code_mode_only=true`，所以 6 个协作工具保留原生直接调用；sleep 自身 DirectModelOnly。UnifiedImageBudget=false，因此本重建保留 image detail 字段/帮助。[C2,C5]

实际 first-party fixture `astra_settings_release_check_with_direct_and_code_mode_tools` 使用 bundled astra、dummy ChatGPT auth、一个 rmcp 测试服务；其首请求 snapshot 正是上面 3 namespace/11 callable。它还实际执行 `tools.exec_command`、`tools.mcp__rmcp__echo`、`tools.view_image`、`tools.apply_patch`，说明 snapshot 中没列出的 SDK/MCP 工具确实存在。**测试 harness 禁用 Apps/ShellSnapshot，extensions 为空；不是桌面原始默认配置。**快照中 `<OMITTED 155 LINES; ~4935 TOKENS>`、description hash 都不能当作真实 token 文本计算。[C3]

## 可复现计数

运行：`node docs/research/codex-tool-components-2026-10-14.mjs`。脚本检查固定 Codex HEAD，并生成同名 `.json` 与 `-reconstruction.txt`（包含重建内容供人工审查）。全部 LF；ASCII 字符/4 向上取整。字符/字节真实对应重建表示，token 栏仅估算。**手工 schema 转录尚未与 Rust 原 builder 自动对拍，应在 P0 mock capture 中核验。**

| Codex 组件 | description 字符 | parameters JSON 字符 | 标准化 JSON 总字符 | 估算 tokens |
|---|---:|---:|---:|---:|
| exec_command（Linux、login 可用、单环境） | 82 | 1,395 | 1,531 | 383 |
| write_stdin | 80 | 618 | 751 | 188 |
| list_mcp_resources | 238 | 297 | 595 | 149 |
| list_mcp_resource_templates | 300 | 315 | 684 | 171 |
| read_mcp_resource | 83 | 351 | 493 | 124 |
| apply_patch（只算名称+描述，无 JSON 参数） | 108 | — | 147 | 37 |
| view_image | 124 | 317 | 493 | 124 |
| clock__curr_time | 31 | 62 | 151 | 38 |
| update_plan（默认关闭） | 157 | 487 | 700 | 175 |
| request_user_input（Plan mode 文案） | 120 | 1,142 | 1,322 | 331 |
| request_user_input_async（root） | 556 | 844 | 1,466 | 367 |

上表统一排除了输出 schema、type/strict/namespace wrappers；`apply_patch` direct native grammar 单列在 JSON 的 `directApplyPatchGrammar`，不能把上表 37 当 direct 实际完整花费。CodeMode 的 apply_patch 输入转为 `string`，因此 SDK 声明本身不携带 apply_patch Lark grammar；但 `exec` 有自己的 freeform grammar。[C6,C7]

另一个直接相关口径是 **CodeMode description 的非 deferred SDK 内容**：

| 内容 | ASCII 字符 | 估算 tokens |
|---|---:|---:|
| exec 运行时帮助（插入 30000ms 与 legacy image helper） | 3,374 | 844 |
| deferred 工具通用提示（即使此组无外部工具仍添加） | 251 | 63 |
| Shared MCP Types，包含 Markdown 包裹 | 1,571 | 393 |
| 上述固定内容 + 8 个完整 SDK 描述/输入输出声明，含连接换行 | 10,988 | 2,747 |
| 原生 wait 的单独 description | 700 | 175 |

10,988 是**此受控重建的部分下界**：还没有 clock namespace heading、原生 wait schema、2 问答 schema、6 协作 schema、exec grammar/type/namespace 包装、web、tool search/catalog、外部工具、系统/开发者文本、环境等。这里没有完整请求的有限上界；插件数量、remote catalog、动态 agent model 列表都可变。Windows shell safety 文案与 yield 参数描述也增加长度。不得将 2,747 和 KodaX 17,922 直接相减作为总节省。[C6,C7]

## KodaX 59 工具逐组对照

下表完整覆盖受控 Worker 的 59 个工具。KodaX 合计约 17,922 工具 tokens；所有数来自同一标准化组件口径。Codex“没有”仅指上述固定核心组，桌面 plugin/extension 可以另外提供同名或类似能力。[K1,C2]

| KodaX 工具组（完整名单） | 数量 / 估算 | Codex 核心对应及合理解释 |
|---|---:|---|
| bash, read, write, edit, multi_edit, insert_after_anchor, glob, grep, undo | 9 / 3,113 | exec_command + write_stdin + apply_patch，读取/搜索通过 shell。对方没有独立 read/edit/multiedit/grep schema，不能据此保证 KodaX 跨 provider 的 shell/patch成功率相同 |
| changed_diff, changed_diff_bundle, changed_scope, code_search, cyclic_dependencies, impact_estimate, module_context, process_context, relationship_scan, repo_overview, semantic_lookup, symbol_context | 12 / 2,432 | 核心无同等 repo-intel schema。shell/人工工具组合是不同能力；优先研究真正 schema 延迟加载，而不是删掉能力 |
| lsp_definition, lsp_document_symbols, lsp_hover, lsp_implementation, lsp_incoming_calls, lsp_outgoing_calls, lsp_prepare_call_hierarchy, lsp_references, lsp_workspace_symbols | 9 / 1,590 | 核心无 LSP schema；可通过外部工具提供。21 个 repo/LSP 当前仍在 KodaX 首工具 JSON 中，约 4,022，可作为 schema 可见性研究对象 |
| todo_create, todo_update, todo_get, todo_list | 4 / 3,901 | Codex update_plan 默认关闭；开启约 175。Codex只是整份 step/status 列表，无 KodaX runtime 的依赖、归属、版本/校验/结果元数据。可缩减暴露契约，不能直接替换行为 |
| agent_output, followup_task, interrupt_agent, list_agents, list_dispatchable_agents, send_message, spawn_agent, wait_agent | 8 / 2,297 | Codex V2有 followup/interrupt/list/send/spawn/wait 六个；没有单列 agent_output、list_dispatchable_agents。Codex spawn描述还会动态带model列表/限制，不适合用静态函数数反推更小 |
| ask_user_question, exit_plan_mode | 2 / 1,549 | Codex两个问答组件合约 698；plan模式状态/instructions控制行为，核心没有同名exit_plan_mode。KodaX支持的交互类型/审批语义不同；保留安全/时序约束后再收敛schema |
| create_goal, get_goal, update_goal | 3 / 554 | 核心无同等目标状态工具；桌面/扩展可能提供，不能说整个Codex产品没有 |
| memory_intent, memory_recall | 2 / 669 | 核心工具组未注册对应 callable；模型提示或其它memory机制不是同等工具API |
| kodax_manual | 1 / 294 | 核心无同等工具；文档/skills/插件说明承担部分发现职责 |
| skill, run_skill_script | 2 / 541 | Codex通过技能catalog、读取SKILL.md和shell执行脚本，不在此核心组独立注册skill调用工具 |
| tool_call, tool_describe, tool_search | 3 / 548 | Codex通过exec+ALL_TOOLS/条件search；SDK完整声明和运行时帮助仍计费，不能只保留search工具数比较 |
| web_fetch, web_search | 2 / 219 | provider/native web或standalone web.run扩展；本无extension受控组不含，实际产品需单独计数 |
| worktree_create, worktree_remove | 2 / 215 | 核心可shell调用git；桌面插件管理worktree可增加额外完整schema。管理语义不同 |

这些差额提示 KodaX 的首轮问题不仅是“system 太长”。其工具 API 更像完整工作流/仓库服务接口；Codex 核心更集中于 shell/patch 和窄协作契约。优先对 **todo 的外露结构、问答选项结构、repo/LSP真延迟 schema** 做受控设计，胜过盲目把59个名字压成一个exec。但保持 KodaX 的跨 provider 可靠性、child首次决策、compaction 后可见性，是验收前提。[K1,K2,C2,C6]

## 外部工具和未测量项目清单

- **Web**：`standalone_web_search_enabled` 要求 provider capability 且 lite 或开关；只在实际 extension registry 有 web.run 且web启用时注册。另有 hosted WebSearch 路径。不能拿空extension的test fixture代表在线产品。[C8]
- **MCP/apps**：模型 supports_search_tool 决定 deferred；有可搜索 deferred 才注册tool_search。deferred 的完整schema不进入首次SDK声明，但源码默认可以将 source目录放进search描述；源目录预算512KiB，另有世界状态摘要开关。不能把deferred误读成首次零成本。CodeModeToolSearch默认false，目录发现/原生search路径还受模式影响。[C8]
- **可选core**：update_plan、request_permissions、token-budget上下文工具、deferred环境等待、插件安装推荐、测试同步；它们有各自config/feature/候选条件，不能统统算默认。[C2]
- **动态/环境变体**：Windows shell指导、多个环境的environment_id、附加权限schema、自定义role/model列表、root vs child async问答可用性、request_user_input可用mode、tool description catalog覆盖。[C2,C5,C6]
- **包装和provider**：Responses把tools放顶层，ResponsesLite在developer AdditionalTools输入中；只数顶层tools会把lite大块内容漏掉。[C9]
- **系统、skills、AGENTS、缓存/界面指标**：本文不重复测量，也不从snapshot截断标记推导总量。应与主报告的受控系统组件、TUI统计口径分开。[C3,C9]

## 下一步最小验证

P0 应对固定 bundled sol/astra、direct反事实组各捕获一次离线 mock transport 的完整首请求：空home/空workspace/固定OS/无extensions；再单独添加web、一个MCP、AGENTS、skills及桌面插件。分别导出native工具、exec内SDK、deferred目录、developer/system/用户文本，计算同一tokenizer与chars/bytes，保留原文及哈希。必须捕获构造后的Responses/ResponsesLite请求，不用snapshot formatter。由此验证本手工转录和默认组是否完整，再决定产品方案。

P1 才做不调用模型的KodaX契约候选：todo精简、ask收敛、repo/LSP真实延迟暴露。每项应写明删去哪个模型语义义务、后端是否仍保持校验、哪个首次决策前重新注入；单独评估SA/Worker/child与压缩恢复。涉及执行质量的模型eval由父研究按EVAL_GUIDELINES另行设计，本轮未执行。

## Primary source 索引

- **C1** `C:/Works/PubProj/codex/codex-rs/models-manager/models.json:4`（astra）、`:177`（sol）；`codex-rs/core/src/tools/mod.rs:63`（mode优先级）。
- **C2** `codex-rs/core/src/tools/spec_plan.rs:1177`（四组core注册）、`:1245`（shell）、`:1289`（MCP resource条件）、`:1315`（plan）、`:1331`（问答）、`:1340`（root async与alias）、`:1380`（可选工具起）、`:1390`（clock/sleep）、`:1430`（patch/view）、`:1462`（collab）。`codex-rs/core/src/config/mod.rs:2758`、`:2766`（request/plan默认）。
- **C3** `codex-rs/core/tests/suite/scenarios.rs:276`（bundled catalog）、`:1189`（真实fixture）；`codex-rs/core/tests/common/test_codex.rs:1522`（harness Apps/ShellSnapshot/empty extensions）；`codex-rs/core/tests/suite/snapshots/all__suite__scenarios__astra_settings_release_check_tool_shapes.snap:18`（首request surface）、`:42`（截断）。
- **C4** `codex-rs/core/src/tools/spec_plan_tests.rs:1647`（Direct model override）；`codex-rs/core/src/tools/spec_plan.rs:847`（CodeModeOnly原生隐藏条件）、`:1011`（SDK构造）。
- **C5** `codex-rs/features/src/lib.rs:1050`（shell/view/sleep/unified默认）、`:1168`（CodeModeToolSearch）、`:1754`（image budget）；`codex-rs/core/src/config/mod.rs:1391`（V2默认）；`codex-rs/core/src/tools/handlers/sleep.rs:75`（DirectModelOnly）。
- **C6** `codex-rs/core/src/tools/handlers/shell_spec.rs:24`、`:122`、`:214`（exec/write/output）；`handlers/mcp_resource_spec.rs:7`、`:34`、`:63`；`handlers/view_image_spec.rs:16`；`handlers/current_time.rs:60`；`handlers/plan_spec.rs:7`；`handlers/request_user_input_spec.rs:16`、`:123`；`handlers/request_user_input_async.rs:40`；`codex-rs/prompts/src/model_messages.rs:53`。
- **C7** `codex-rs/code-mode-protocol/src/description.rs:16`（固定帮助）、`:279`（拼接）、`:430`（声明）、`:446`（freeform→string）；`code-mode-protocol/src/json_schema_types.rs:251`、`:325`（数组/对象渲染）；`core/src/tools/handlers/apply_patch_spec.rs:5`、`:9`；`core/src/tools/code_mode/execute_spec.rs:5`。
- **C8** `codex-rs/core/src/tools/spec_plan.rs:391`（有deferred才search）、`:1199`（web条件）、`:1628`（search）、`:1647`（extensions）；`handlers/tool_search_spec.rs:8`、`:34`（目录预算/构造）。
- **C9** `codex-rs/core/src/client.rs:978`（Responses/Lite工具wire位置）。
- **K1** 当前研究产物 `docs/research/kodax-controlled-input-inventory-2026-10-14.ts`、同名`.json`：真实受控builder与逐工具description/schema指标。业务定义 `packages/coding/src/tools/tool-definitions.ts:1400`（todo_update）、`:1536`（todo_create）、`:1187`（ask）、`:1381`（exit_plan）；`packages/coding/src/agents/worker-role-prompt.ts:113`（todo语义）。
- **K2** `packages/coding/src/agent-runtime/tool-resolution.ts:157`（目前deferred只替换description）；`packages/coding/src/tools/deferred-tools.ts:19`（核心常驻）；前轮风险审计 `docs/research/prompt-guidance-risk-kodax-2026-10-14.md`。
