# Codex 怎样验证结果、做视觉审查，以及哪些机制能替代 KodaX verifier？

TL;DR：本地 Codex 源码支持“主 agent 用真实工具结果及图片验证当前产物 + 按需启动拥有工具的 fresh-context reviewer”；它也有可阻断停止并回灌修正提示的 Stop hooks，但没有在所审查完成路径中发现内置、默认执行的通用质量 verifier。Guardian 是动作权限审查，不能当作完成质量验收。依据见下面各事实条目。

## 调研范围与基线

- 日期：2026-10-11（Asia/Shanghai）。只读研究 `C:/Works/PubProj/Codex`，不运行 benchmark/eval，不修改外部仓库。
- 本地 HEAD：`a07c8ebd57feedc4cf5dfe854c8e9101de54186b`。研究前、研究后 `git status --short` 均为空。此为本地快照结论，不代表其他版本或所有部署。
- 当前仓库 README 自称 Codex CLI，并分别链接 IDE、Desktop、Cloud 入口。Desktop launcher 源码只是打开/安装 Desktop 应用，不能据此声称仓库含有 Desktop 的完整 browser、文档/PPT 渲染及视觉 QA 实现。来源：[README.md:1](C:/Works/PubProj/Codex/README.md:1)、[app_cmd.rs:15](C:/Works/PubProj/Codex/codex-rs/cli/src/app_cmd.rs:15)。
- 已读适用 KodaX `AGENTS.md`；Codex 根目录及其祖先没有 `AGENTS.md`。Codex 存在的两份 scoped AGENTS 位于 `tui/src/bottom_pane` 与 `exec-server/src/sandbox_integrity`；未读取这些子目录中的实现。
- 已实际打开 [OpenAI 官方 Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide#view_image)。该页将 `view_image` 描述为把本地图片附加进模型上下文的工具。本文关键实现判断以固定本地 HEAD 的源码为准。

## 已证实：视觉检查依靠真正的图片输入

1. `view_image` 是普通工具，说明要求“需要视觉检查时查看磁盘上的本地图片”；输入必需 `path`，适用模型可以额外选择 `high`/`original`，后者保留原始分辨率。它不是“让另一个模型凭文字猜图片”的审查服务。来源：[view_image_spec.rs:16](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image_spec.rs:16)、[view_image_spec.rs:42](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image_spec.rs:42)。
2. handler 首先检查模型是否接受 Image modality；按当前环境 cwd 解析路径，经过环境 filesystem 与 sandbox 读取文件，拒绝非文件与无法解码的图片。来源：[view_image.rs:98](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:98)、[view_image.rs:145](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:145)、[view_image.rs:169](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:169)。
3. 实际数据路径为图片 bytes → data URL → `FunctionCallOutputBody::ContentItems` 内的 `InputImage`。图片不是仅以文件路径或日志文本存在。日志反而明确省略 image data URL。来源：[view_image.rs:188](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:188)、[view_image.rs:228](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:228)。
4. 集成测试断言下一次模型请求中的该 `function_call_output` 为 `input_image` 内容项，且没有另插一条普通 image message；这直接证明工具输出进入模型请求的多模态路径。此处只读测试，未运行。来源：[view_image.rs（集成测试）:524](C:/Works/PubProj/Codex/codex-rs/core/tests/suite/view_image.rs:524)。
5. Code Mode 的 `view_image` 返回 `image_url`/detail；其 image 内容经 response adapter 转成协议 `InputImage`。因此编排层必须显式输出 image 内容，单纯 stringify 原始工具返回值不等于把图片送进模型。前半是实现事实，后半是依据转换接口的推断。来源：[view_image.rs:256](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:256)、[response_adapter.rs:29](C:/Works/PubProj/Codex/codex-rs/core/src/tools/code_mode/response_adapter.rs:29)。
6. MCP `image` 内容支持 base64 与 data URL，并转换为 `InputImage`，支持 `_meta` 中的 image detail。**边界：**若普通 MCP 返回了非空 `structuredContent`，当前直接 MCP 转换优先返回其序列化 text，普通 `content` 里的图片不一定同时保留；Code Mode 保留 raw result 可另行选取图片。不能笼统断言所有 MCP 返回图片必定进入模型。来源：[models.rs:2414](C:/Works/PubProj/Codex/codex-rs/protocol/src/models.rs:2414)、[models.rs:2509](C:/Works/PubProj/Codex/codex-rs/protocol/src/models.rs:2509)、[context.rs:164](C:/Works/PubProj/Codex/codex-rs/core/src/tools/context.rs:164)。

## 已证实：主循环承担验证，goal completion audit 是提示词而非独立裁判

1. 仓库保留的 GPT-5.2 通用提示词要求把任务推进到实现、验证、解释结果；它把测试/构建作为主 agent 验证手段，要求优先窄范围验证再视需要扩大。这是提示词行为要求，不代表任何特定部署一定选用此旧模型提示词。来源：[gpt_5_2_prompt.md:29](C:/Works/PubProj/Codex/codex-rs/core/gpt_5_2_prompt.md:29)、[gpt_5_2_prompt.md:136](C:/Works/PubProj/Codex/codex-rs/core/gpt_5_2_prompt.md:136)。
2. Goal continuation 提示词有直接的 completion audit：逐项从目标、spec、用户指令导出要求，检查当前 files、命令输出、测试、PR 状态、**rendered artifacts**、runtime 等权威证据；证据不充分就继续工作。测试、manifest、verifier、绿色标记本身只有在覆盖相应要求后才算证据，不能用 plausible final answer 证明完成。来源：[continuation.md:35](C:/Works/PubProj/Codex/codex-rs/ext/goal/templates/goals/continuation.md:35)。
3. Active goal 续跑由 runtime 读取目标状态并向原 thread 提交 continuation steering item。`update_goal` handler 检查允许的状态、统计使用量、更新存储及发出事件；该 handler 没有再调用模型裁判验证实现或渲染结果。因此这里是**主 agent 的完成审计指令 + 生命周期状态更新**，不应称作强制语义完成 verifier。来源：[runtime.rs:465](C:/Works/PubProj/Codex/codex-rs/ext/goal/src/runtime.rs:465)、[tool.rs:247](C:/Works/PubProj/Codex/codex-rs/ext/goal/src/tool.rs:247)。
4. Skills catalog 会把 skills 的名称、描述、来源及使用规则交给模型；要求触发后阅读 `SKILL.md`，可使用其 scripts/assets。这个设施能承载“生成→渲染→看图→修正”的工作流指令，但设施本身没有强制每次 HTML/PPT 都执行该流程。来源：[catalog_prompt.rs:3](C:/Works/PubProj/Codex/codex-rs/ext/skills/src/catalog_prompt.rs:3)、[catalog_prompt.rs:7](C:/Works/PubProj/Codex/codex-rs/ext/skills/src/catalog_prompt.rs:7)。

## 已证实：code review 是按需的完整子会话

1. CLI 有显式 `codex review` 命令；core 处理显式 `Op::Review` 后 resolve target 并启动 ReviewTask。Target 包含当前工作区、base branch、commit、custom instructions，base branch 路径使用 merge-base 而非凭主 agent 摘要构建“假 diff”。来源：[main.rs:158](C:/Works/PubProj/Codex/codex-rs/cli/src/main.rs:158)、[handlers.rs:402](C:/Works/PubProj/Codex/codex-rs/core/src/session/handlers.rs:402)、[review_request.rs:59](C:/Works/PubProj/Codex/codex-rs/prompts/src/review_request.rs:59)。
2. ReviewTask 启动子 Codex 会话，把 base instructions 替换为 review rubric；可单独配置 `review_model`，否则用当前模型。它禁用 web search、Collab/MultiAgentV2，并设置 approval `never`，以 `SubAgentSource::Review` 标记；不是每次普通 turn 自动触发。来源：[review.rs:99](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:99)。
3. `run_codex_thread_one_shot` 的 one-shot 指“一次完整 turn”，内部创建 interactive session，再提交输入，到 `TurnComplete`/`TurnAborted` 才 shutdown；不是只给模型一次采样且强制立即 report。Review 传 `initial_history=None`，delegate 将其解析为 `InitialHistory::New`。它仍继承共享 instructions、environment、skills、plugins、MCP 服务。故 fresh conversation 不等于与任务环境完全隔离。来源：[review.rs:128](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:128)、[codex_delegate.rs:82](C:/Works/PubProj/Codex/codex-rs/core/src/codex_delegate.rs:82)、[codex_delegate.rs:95](C:/Works/PubProj/Codex/codex-rs/core/src/codex_delegate.rs:95)、[codex_delegate.rs:226](C:/Works/PubProj/Codex/codex-rs/core/src/codex_delegate.rs:226)。
4. Delegate 使用一般 Session runtime，工具计划包含 shell、MCP resource、utility 等；其 review prompt要求直接研究 diff、具体受影响路径、适用 repo 规则，报告离散、可操作、由本次变更新引入的问题，宁可 no findings 也不编造。内置 review rubric 禁止生成 PR fix；系统 bundled `review-agent` skill 同样要求只读、直接检查 diff/tests/call sites、不得继续委托。**边界：**“不得修改”主要是这些提示指令；approval `never` 本身不等于强制 read-only filesystem sandbox。来源：[spec_plan.rs:1211](C:/Works/PubProj/Codex/codex-rs/core/src/tools/spec_plan.rs:1211)、[rubric.md:10](C:/Works/PubProj/Codex/codex-rs/prompts/templates/review/rubric.md:10)、[rubric.md:34](C:/Works/PubProj/Codex/codex-rs/prompts/templates/review/rubric.md:34)、[rubric.md:95](C:/Works/PubProj/Codex/codex-rs/prompts/templates/review/rubric.md:95)、[review-agent/SKILL.md:8](C:/Works/PubProj/Codex/codex-rs/skills/src/assets/samples/review-agent/SKILL.md:8)。
5. Review 最后产出结构化 findings、priority、confidence、file/line、overall correctness，结果回写父会话，供用户或后续工作使用。它不是直接把父会话“验收通过/失败”设成一个不可疑问的真值；解析失败时退化为带 plain text explanation 的结构。来源：[rubric.md:67](C:/Works/PubProj/Codex/codex-rs/prompts/templates/review/rubric.md:67)、[review.rs:188](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:188)、[review.rs:210](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:210)。
6. **源码冲突须保留：**`session/review.rs:29` 注释声称 review 禁用 `view_image`；但后面的可执行代码只禁 web-search features、Goals，`tasks/review.rs` 也只显式禁 web search/Collab/MultiAgentV2。`ViewImage` 在 feature catalog 为 Stable/default=true，utility tool 注册条件为环境可用且该 feature 开启。当前静态证据无法把“review 必然无法看图”当事实；该注释可能过期。也不能以可注册工具推断 `/review` 会自动做视觉检查，因为默认 rubric 针对代码 diff。来源：[session/review.rs:29](C:/Works/PubProj/Codex/codex-rs/core/src/session/review.rs:29)、[tasks/review.rs:107](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:107)、[features/lib.rs:1041](C:/Works/PubProj/Codex/codex-rs/features/src/lib.rs:1041)、[spec_plan.rs:1464](C:/Works/PubProj/Codex/codex-rs/core/src/tools/spec_plan.rs:1464)。

## 已证实：Stop hook 有续跑语义，但不是默认模型 verifier

1. 普通 turn 在模型不需要 follow-up 且无待处理输入后调用 Stop hooks。`should_block` 若带 continuation fragments，会把 hook 提示写回会话并 `continue` 主循环；若只有 block 而没有提示，记录 warning 并忽略该 block。因此它能完成“明确未满足项→再工作”的生命周期控制。来源：[turn.rs:657](C:/Works/PubProj/Codex/codex-rs/core/src/session/turn.rs:657)。
2. 根 turn 用 Stop，普通 ThreadSpawn child 用 SubagentStop；review 等 synthetic/internal subagent 跳过用户配置的 Stop/SubagentStop。请求携带 cwd、transcript path、model、last assistant message、`stop_hook_active`。后者是 hook 可感知的“已因 hook 续跑”状态，不能独自保证终止。来源：[hook_runtime.rs:392](C:/Works/PubProj/Codex/codex-rs/core/src/hook_runtime.rs:392)。
3. 没有 matched handler 时返回不 block；有 handler 才执行配置。JSON block+非空 reason 或退出码 2+stderr continuation 可阻断；普通执行/解析错误主要产生 Failed hook event，不自动产生质量通过证明。来源：[stop.rs:128](C:/Works/PubProj/Codex/codex-rs/hooks/src/events/stop.rs:128)、[stop.rs:293](C:/Works/PubProj/Codex/codex-rs/hooks/src/events/stop.rs:293)。
4. Handler discovery 支持 Command 与 MCP Tool；**Prompt hook 与 Agent hook 当前明确 unsupported，直接跳过并记录 load failure**。因此不能把 config 里存在这些枚举当作“内置自动审查 agent 已实现”。来源：[discovery.rs:507](C:/Works/PubProj/Codex/codex-rs/hooks/src/engine/discovery.rs:507)、[discovery.rs:584](C:/Works/PubProj/Codex/codex-rs/hooks/src/engine/discovery.rs:584)、[discovery.rs:637](C:/Works/PubProj/Codex/codex-rs/hooks/src/engine/discovery.rs:637)。

## 已证实：Guardian、browser/computer integration 的真实边界

1. Guardian policy针对“当前计划执行的动作”的 risk、authorization 与 allow/deny；features 文档直接称之为 approval review。它可以检查浏览器点击前的设置是否符合指令，但这仍是授权与风险检查，不能用它证明 PPT 排版、HTML 视觉效果或目标完成。来源：[guardian/policy.md:3](C:/Works/PubProj/Codex/codex-rs/prompts/templates/guardian/policy.md:3)、[features/lib.rs:363](C:/Works/PubProj/Codex/codex-rs/features/src/lib.rs:363)、[guardian/node_repl_policy.md:2](C:/Works/PubProj/Codex/codex-rs/prompts/templates/guardian/node_repl_policy.md:2)。
2. Core 确有把 Code Mode 中 node/cua-backed MCP 响应 text/image 捕获为有大小上限的多模态 evidence 的实现，并从 image base64/mime/detail 转换成 `UserInput::Image`。该路径用于 Guardian 等上下文证据，不是 PPT/HTML 质量 verifier 的实现。来源：[mcp.rs:319](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/mcp.rs:319)、[mcp.rs:370](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/mcp.rs:370)。
3. Browser/computer 配置文件定义的是 origin、history、upload/download/CDP 或 app access 的策略；本地 native handler 列表主要是 shell、MCP、dynamic、multi-agent、image 等。这里只能确认集成与策略层，不能由此补出 Desktop browser/cua API 的实际 screenshot renderer、PPT export 或本机操控实现。来源：[browser_use.rs:9](C:/Works/PubProj/Codex/codex-rs/config/src/browser_use.rs:9)、[computer_use.rs:9](C:/Works/PubProj/Codex/codex-rs/config/src/computer_use.rs:9)、[handlers/mod.rs:1](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/mod.rs:1)。

## 从事实推出的 KodaX 建议（设计推断，不是 Codex 已替我们验证）

- 默认把质量检查放回拥有需求上下文和工具的主循环：先产出、实际执行/渲染、读取文本/看图片、发现问题后修正，再依据真实证据说明完成。这能继承已有上下文，且依据工具结果而非结尾 prose。支撑：`view_image` 的 `InputImage` 数据路径与 goal completion audit 的逐项 current-state evidence 要求。来源：[view_image.rs:237](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image.rs:237)、[continuation.md:35](C:/Works/PubProj/Codex/codex-rs/ext/goal/templates/goals/continuation.md:35)。
- 按 artifact/任务选择验证动作，通过 skill 提供必要流程：代码用 diff/tests，HTML 用运行页面/截图/交互，PPT 用渲染后的各页图片及结构检查。Codex 给出了 image 输入和 skills 设施，**本地仓库未提供可直接移植的 PPT/HTML 全套 QA skill**；具体渲染链需要另行实现或复用项目现有工具。来源：[view_image_spec.rs:42](C:/Works/PubProj/Codex/codex-rs/core/src/tools/handlers/view_image_spec.rs:42)、[catalog_prompt.rs:7](C:/Works/PubProj/Codex/codex-rs/ext/skills/src/catalog_prompt.rs:7)。
- 需要第二视角时，调用一次有边界的 reviewer 子会话：fresh history，需求/目标/产物定位，允许读取源码/真实 diff/图片并运行必要检查，以 findings/evidence/gaps 返回结果；主 agent 负责修正与复查。不要把“一次完整 turn”收窄成“不能取证的一次模型判词”。支撑：Codex ReviewTask + delegate 实现，以及只读 review-agent 的具体检查规则。来源：[tasks/review.rs:99](C:/Works/PubProj/Codex/codex-rs/core/src/tasks/review.rs:99)、[codex_delegate.rs:226](C:/Works/PubProj/Codex/codex-rs/core/src/codex_delegate.rs:226)、[review-agent/SKILL.md:12](C:/Works/PubProj/Codex/codex-rs/skills/src/assets/samples/review-agent/SKILL.md:12)。
- Stop/complete extension point 适合承载可解释的客观缺口及用户显式验收规则：产物缺失、必须检查未执行、检查命令失败、图片证据缺失时反馈具体动作。不要以 hook 超时/解析失败冒充审查成功；限制续跑次数/预算是 KodaX 需要自行明确的策略，Codex 这里只展示生命周期接口。来源：[turn.rs:657](C:/Works/PubProj/Codex/codex-rs/core/src/session/turn.rs:657)、[stop.rs:293](C:/Works/PubProj/Codex/codex-rs/hooks/src/events/stop.rs:293)。
- 主循环和子 reviewer 都需要同一条可保存/回放的多模态证据通道，结果中的 screenshot/rendered page 应作为真实 image content 进入模型，不能在摘要器里变成 `[image omitted]` 或只留下 path。注意 MCP `structuredContent` 优先及 Code Mode 显式 image 输出等桥接细节。支撑：协议转换与 view_image 请求测试。来源：[models.rs:2414](C:/Works/PubProj/Codex/codex-rs/protocol/src/models.rs:2414)、[response_adapter.rs:29](C:/Works/PubProj/Codex/codex-rs/core/src/tools/code_mode/response_adapter.rs:29)、[view_image.rs（集成测试）:524](C:/Works/PubProj/Codex/codex-rs/core/tests/suite/view_image.rs:524)。

## 未证实

- Desktop 或服务端是否还有私有的默认 completion verifier、视觉评分子 agent、审查模型选择、异步 scorer。CLI 源码和可见 launcher 无法证明。
- Desktop 安装的 `presentations`、`documents`、`pdf`、browser/cua 插件具体如何 render-and-verify，是否由主 agent 自主调用、是否有隐藏 gate；这些 skill/package 不在本次固定仓库的 reviewed implementation 内，不能把当前产品会话的 tool catalog 当作仓库实现。
- `/review` 在该 HEAD 的真实请求是否暴露 `view_image`：源码存在注释/执行代码不一致，未运行 Codex model session 来验证。静态可见注册条件不足以推出运行时全部外部权限条件。
- 上述主循环/按需 reviewer 方案对 KodaX 不同 provider 的质量、成本、时延收益；本次只做源码调研，不运行 benchmark/eval，不给出效果数值。

## 未解问题

1. KodaX 当前多模态 content/tool_result 在 provider serialization、session persistence、compaction、child 输入路径上是否完整？需用已有工具输出做端到端路径审计。
2. 能否直接复用现有截图/文档转图片工具？哪些模型具备可靠 image input，缺少视觉能力时应向用户明确哪项未验证？
3. 默认完成前需要哪些最低证据，哪些仅由主 agent 根据任务判断？如何避免为每种任务硬编码膨胀的规则系统？
4. 独立 reviewer 何时明确触发（用户要求、重要改动、主 agent 自知需要第二视角），其读/写/运行工具边界、预算与退出语义如何保持轻量？
5. timeout、provider error、解析失败、检查能力不可用应该怎样映射到“未验证”，并防止 goal completion 对该状态误报成功？
