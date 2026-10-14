# KodaX 应怎样拆分 prompt 与工具说明，既减少首轮又保留行为？

结论摘要：先按内容所有者与触发条件拆分指令，再决定注入位置。核心行为和当前可调用工具的必要契约保留完整；可选能力首轮给可发现的短提示，正文按需；运行时提醒只用于宿主已知的状态事件。**补充核查 KodaX 后修正默认取舍：优先复用现有 portable bridge 做有限范围的 schema 延迟，普通客户端 activation 保留为对照方案，原生 `tool_search_output`/增量工具协议另按 provider 能力判断。**初稿中偏向 activation 的推论只依据 pi，不能作为 KodaX 最小实现结论；具体见文末补充审计。

## 证据范围

- 日期：2026-10-14。pi 仓库 `C:/Works/PubProj/pi`，commit `3daa20280f6a7c7cbe0935680c9a38fdc3863005`（下称 **P**）；Codex 仓库 `C:/Works/PubProj/codex`，commit `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`（下称 **C**）。以下链接全部为对应 commit 的本地源码/测试位置。
- 只读参考仓库与生产/测试源码，没有模型请求、eval 或测试运行；测试证据表示仓库明确表达的预期，不代表本次已经执行通过。
- 本文是架构建议，不宣称 KodaX 已实现这些能力或有确定 token 降幅。上一轮报告只用于导航，本轮关键结论重新检查源码。

## 1. 说明应归属于谁：prompt 主体、工具契约、发现目录、运行状态

pi 的默认 system 并不复制每个工具全部参数文档；它接收工具贡献的短 `promptSnippet` 和 `promptGuidelines`，按当前已声明工具生成规则并去重。工具的完整 description/schema 仍归工具本身。未声明、仅间接可达的工具不会继续占据 system 的可见工具列表和规则。[P: system-prompt.ts:90](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:90)、[P: system-prompt.ts:149](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:149)、[P: agent-session.ts:1705](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1705)。

这一归属关系比简单删文案更关键：pi 的 edit 工具参数和 guidelines 明确保留唯一匹配、原文件语义、禁止重叠、尽量缩小 oldText 等契约。它们影响调用正确性，不能只因为参数 schema 已有 `oldText` 就全部省掉。[P: edit.ts:21](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:21)。

Codex 也区分“从模型目录选择 wording”与“工具拥有 schema/rendering”：`ResolvedModelMessages` 只返回 per-function/indirect guidance、Code Mode 文案覆盖；schema 解析、namespace mapping、Code Mode composition 留在工具所有者。工具规划仅对可见或可发现的工具应用相应前缀。[C: model_messages.rs:182](C:/Works/PubProj/codex/codex-rs/prompts/src/model_messages.rs:182)、[C: spec_plan.rs:887](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:887)。

**建议（推论）：** KodaX 的长 prompt 应先拆为“跨任务基本行为”“具体工具使用契约”“可选能力目录”“宿主状态事实”四种责任。不要先增加统一 `full/hint/on-demand` 配置，再让所有内容任意选模式；那会使必需约束也可能被配置成按需且无人发现。最小实现可以继续保留现有函数和 registry，只把重复工具说明迁回工具定义附近，并让 prompt renderer 从同一来源取短提示。[依据 P: system-prompt.ts:90；C: model_messages.rs:182]

## 2. full / hint / on-demand 应作为内容策略，而不是删除契约的开关

| 内容 | 首轮策略建议 | 后续加载条件 | 理由与源码先例 |
| --- | --- | --- | --- |
| 用户/项目硬约束、通用执行边界 | full，先去同源重复 | 作用域或规则版本实际改变时更新 | pi 项目指令全文；不能靠模型先猜需不需要遵守 [P: system-prompt.ts:79](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:79) |
| 已可直接调用的核心工具必要 schema/限制 | full，但去重复介绍/示例 | 工具定义/能力变化时更新 | pi 参数所有者与 guidelines [P: edit.ts:21](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:21) |
| 可选 skill | hint：名称、触发描述、可读路径 | 显式点名或任务匹配，使用前读取正文 | [P: skills.ts:358](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:358)；Codex 显式正文加载 [C: host_prompt.rs:59](C:/Works/PubProj/codex/codex-rs/ext/skills/src/host_prompt.rs:59) |
| 大量 MCP 工具 | namespace hint + discovery 入口 | 搜索命中后完整 schema + 必要行为说明 | pi bounded server catalog [P: mcp/index.ts:154](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:154) |
| 当前模式、余额/上下文临界、时钟等状态 | 按宿主已知条件注入最短事实/规则 | 状态转换、阈值跨越、新上下文窗口 | [C: token_budget.rs:160](C:/Works/PubProj/codex/codex-rs/core/src/session/token_budget.rs:160)、[C: time_reminder.rs:62](C:/Works/PubProj/codex/codex-rs/core/src/session/time_reminder.rs:62) |

上表是针对 KodaX 的建议，不是两个参考项目都实现了同一模式枚举。**Hint 必须能回答“何时用、到哪里取正文”**；只留下能力名称会省 token，却丢掉触发语义。pi skills 保留 name/description/location；MCP 保留服务器摘要和 discovery 路由，正是在维护这一入口。[P: skills.ts:364](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:364)、[P: mcp/index.ts:165](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:165)。

反例：pi skill 描述长度的 1024 常量只是警告，超长但有描述仍加载；不能据此判断目录已受硬预算保护。另一方面，Codex 的 skill budget 会先保留名称/路径，再分配描述空间，但这仍不构成“截断触发描述后行为必然不变”的证据。[P: skills.ts:329](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:329)、[C: render.rs:331](C:/Works/PubProj/codex/codex-rs/ext/skills/src/render.rs:331)。

## 3. 避免重复要迁移说明，不能直接丢说明

pi `codemode=on` 保留直接工具声明，并避免又把其完整 declaration 放进 codemode 描述；`codemode=only` 则隐藏直接工具声明，把其调用契约和 guidelines 移到 codemode 目录。若目录预算为 0，`describeTool()` 仍须返回工具 guidelines。这一点有明确回归测试（#10343）：system 不再出现 read 指引时，codemode/describeTool 必须仍带相同指引。[P: codemode/tool.ts:312](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:312)、[P: agent-session-codemode.test.ts:153](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-codemode.test.ts:153)、[P: agent-session-codemode.test.ts:188](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-codemode.test.ts:188)。

Codex 的工具来源目录同样只应拥有一个可见位置：启用 `DeferredToolWorldState` 时，namespace 目录交给 world-state section，tool_search 描述不再重复 sources；未启用时仍在 tool_search 描述中携带 sources。测试明确断言 world-state 路径下 tool_search 描述不包含 Google Drive 条目。[C: spec_plan.rs:1628](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1628)、[C: tool_search_spec.rs:174](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/tool_search_spec.rs:174)。

**建议（推论）：** 做一张“必要行为 → 唯一来源 → 本请求可见位置”的对应表，比简单比较 system 字符数可靠。移除 system 某段之前，确认同一条必要行为已经在活跃 schema、工具 description、已加载正文或本次条件提醒中。参数结构重复可删；触发条件、时序限制、路径约定、审批边界不是纯重复。尤其不要隐藏工具 schema 后还保留另一个大段复制版描述，也不要连同行为规则一并移除。[依据前两段生产/回归测试]

## 4. 延迟工具有两种不同传输方式

### 4.1 Codex 原生工具搜索：schema 随历史输出传播

Codex 的 native tool_search 依赖 `model_info.supports_search_tool`；fallback ModelInfo 为 false。搜索返回 `ToolSearchOutput`，序列化成原生 `ResponseInputItem::ToolSearchOutput`，其中携带 loadable tool schema。后续调用仍不把发现的工具注入顶层 `tools`；集成测试对第二、第三请求都明确要求依靠搜索输出历史。[C: spec_plan.rs:392](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:392)、[C: model_info.rs:136](C:/Works/PubProj/codex/codex-rs/models-manager/src/model_info.rs:136)、[C: context.rs:218](C:/Works/PubProj/codex/codex-rs/core/src/tools/context.rs:218)、[C: search_tool.rs:761](C:/Works/PubProj/codex/codex-rs/core/tests/suite/search_tool.rs:761)。

这是 provider/model 专属能力，不能因为模型支持普通 function calling 就直接发送 `tool_search_output`。Codex 嵌套 Code Mode 搜索甚至是另一条输出路径：返回名称和渲染后的调用说明给 JS，不是原生搜索输出。[C: tool_search.rs:245](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/tool_search.rs:245)、[C: tool_search.rs:291](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/tool_search.rs:291)。

### 4.2 pi 客户端激活：不要求原生搜索协议

pi 的 tool_search 是普通 TypeBox function tool，搜索 local metadata 后 `setActiveTools([...active, ...matches])`。下次模型调用才声明命中的工具；transcript 写一次 `toolsAdded`，分支导航可回到加载前/后状态。搜索工具本身 description 不依赖连接中的 server 集合，减少无意义改写。[P: tool-search/tool.ts:164](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:164)、[P: tool-search/tool.ts:194](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:194)、[P: agent-session-mcp.test.ts:976](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-mcp.test.ts:976)。

pi adapter 对 provider 能力做投影：支持中途 system 则保留增量，否则将所有 system 状态折叠为一个前置 system；支持 additive tools 且没有删除/重定义时，把后来工具加在历史中的原位置，否则发送完整当前 tool set。OpenAI-compatible 默认能力可为 false，Gemini/Bedrock 等直接采用折叠路径。[P: transcript.ts:100](C:/Works/PubProj/pi/packages/ai/src/utils/transcript.ts:100)、[P: transcript.ts:236](C:/Works/PubProj/pi/packages/ai/src/utils/transcript.ts:236)、[P: openai-completions.ts:813](C:/Works/PubProj/pi/packages/ai/src/api/openai-completions.ts:813)、[P: google-generative-ai.ts:65](C:/Works/PubProj/pi/packages/ai/src/api/google-generative-ai.ts:65)。折叠语义有单元测试，包括替换 section、删除旧工具、保留当前工具和幂等。[P: system-message-replay.test.ts:43](C:/Works/PubProj/pi/packages/ai/test/system-message-replay.test.ts:43)。

**参考架构推论（KodaX 默认取舍已由文末审计修正）：** pi 证明“少量常驻核心工具 + 普通 discover tool + 客户端活跃工具集合”不需要原生搜索协议，可在后续请求用已有 provider schema 机制发送完整已激活集合。但这不证明它比 KodaX 已有 bridge 更小。两种方案都应复用既有参数校验、权限、hook 与错误路径，而不是新增旁路执行器。pi 的 Code Mode 嵌套调用明确沿用 agent-loop pipeline，提供这一边界先例。[P: codemode/tool.ts:6](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:6)。

成本反例：portable activation 会改变不支持增量 provider 的顶层工具集合，可能影响缓存；bridge 则要模型用字符串 name + 嵌套 arguments。**bridge 不必额外增加一次 describe 往返：若 search 已返回完整 schema，下一次即可 tool_call。**没有哪个方案仅凭“首轮更小”就能证明总成本更低。Codex 自己也把非 deferred schema 放入 exec prompt，而不是通过 Code Mode 凭空消灭这些定义。[C: spec_plan.rs:1011](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1011)；KodaX search 返回完整 schema 的证据见文末。

## 5. 生命周期：加载状态与必要规则不能只寄存在模型记忆里

pi 在 compaction 时取当前完整 system+tools 状态写入 `CompactionEntry.systemMessage`；恢复 context 时将 checkpoint 放在 summary 前面。回归测试验证早期/后期 system 指令合并、sections 保留、被删除工具不会复活。这是结构化恢复，不依赖模型摘要是否记得工具名。[P: session-manager.ts:1260](C:/Works/PubProj/pi/packages/coding-agent/src/core/session-manager.ts:1260)、[P: session-manager.ts:460](C:/Works/PubProj/pi/packages/coding-agent/src/core/session-manager.ts:460)、[P: agent-session-compaction.test.ts:194](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-compaction.test.ts:194)。

pi resume 从 transcript 恢复 tool names，但先经过当前 allowlist；尚未注册的 MCP tools 进入 pending 集合。服务器连接后可恢复已搜索工具，新的 prompt 开始仍未注册则清掉 pending，避免迟到工具无意改变本轮。测试覆盖恢复成功、显式新 loadout 覆盖、服务器在 prompt 后才连接时不再偷偷激活。[P: agent-session.ts:1815](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1815)、[P: agent-session.ts:1859](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1859)、[P: agent-session-mcp.test.ts:1207](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-mcp.test.ts:1207)、[P: agent-session-mcp.test.ts:1249](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-mcp.test.ts:1249)。

Codex 原生搜索的历史也不是永久存储：context-window 输出裁剪可将 ToolSearchOutput.tools 改为空；child fork 的普通过滤会去掉工具调用和搜索输出，但 V2 `preserve_fork_prefix` 且 baseline 可保留时会保留 ResponseItems。因而不能一概断言“所有 child 都继承父任务已发现工具”或“所有 child 都不会继承”。[C: compact_remote_history.rs:170](C:/Works/PubProj/codex/codex-rs/core/src/compact_remote_history.rs:170)、[C: spawn.rs:81](C:/Works/PubProj/codex/codex-rs/core/src/agent/control/spawn.rs:81)、[C: spawn.rs:1106](C:/Works/PubProj/codex/codex-rs/core/src/agent/control/spawn.rs:1106)、[C: spawn.rs:1221](C:/Works/PubProj/codex/codex-rs/core/src/agent/control/spawn.rs:1221)。这些源码证明存在不同路径，并未证明所有远程 compaction 都丢弃所有已发现工具。

pi 的示例 subagent 是另起 CLI（`--no-session`），按角色传 `--tools` 与 `--append-system-prompt`，属于独立上下文示例，不是生产 core 的父状态自动继承机制。[P: examples/subagent/index.ts:300](C:/Works/PubProj/pi/packages/coding-agent/examples/extensions/subagent/index.ts:300)、[P: examples/subagent/index.ts:333](C:/Works/PubProj/pi/packages/coding-agent/examples/extensions/subagent/index.ts:333)。

**建议（推论）：** KodaX 应显式规定 `activeToolIds`/已加载规则在 new session、resume、fork/child、compact、provider switch 下的语义。最低要求：当前权限过滤在恢复之后仍有效；compaction 恢复必要契约或恢复可用 discovery 入口；child 构建自己的能力视图，不把父 prompt 字符串直接当权威状态；被移除工具不能仅因旧摘要提到它又可调用。实现上优先利用已有 session state/checkpoint，不新增一套庞大状态机。[依据本节源码与回归测试]

## 6. Runtime reminders：宿主知道的时机，而非关键词推测

Codex 的 token budget 提醒有 feature/config/阈值门槛，并通过 `claim_token_budget_reminder()` 去重；current-time 提醒按间隔、user/tool-output 边界及 window ID 决定是否投递。它们在下一次模型采样前记录为上下文条目，不是每个请求都把整段模板复制一遍。[C: token_budget.rs:160](C:/Works/PubProj/codex/codex-rs/core/src/session/token_budget.rs:160)、[C: time_reminder.rs:46](C:/Works/PubProj/codex/codex-rs/core/src/session/time_reminder.rs:46)、[C: turn.rs:527](C:/Works/PubProj/codex/codex-rs/core/src/session/turn.rs:527)。

新 compaction window 会触发时间提示重新投递，集成测试明确要求“下一请求前恢复提醒”。因此“本进程已经提示过”不是可靠去重条件；应考虑当前模型上下文是否还含这项规则/状态。[C: time_reminder.rs:68](C:/Works/PubProj/codex/codex-rs/core/src/session/time_reminder.rs:68)、[C: current_time_reminder.rs:578](C:/Works/PubProj/codex/codex-rs/core/tests/suite/current_time_reminder.rs:578)。

**建议（推论）：** runtime reminder 适合模式切换、工具首次激活、执行受阻后的可行动恢复提示、上下文窗口重建等宿主明确知道的事件。它不适合承载“任何写入前必须遵守”的规则，却等模型第一次写完才注入；也不适合按用户话中几个关键词推测是否该注入重要约束。第一次相关动作前规则必须已可见，执行器仍需硬性校验。实际 reminder 注入后应避免同时保留无条件完整版，否则首轮优化只是后移重复。

## 7. 稳定缓存与首轮减量分别处理

pi 分段 system patch 只写发生变化的内容；Codex bounded namespace world state 比较之前 snapshot，未变化不产生新 fragment，变化时发增删差异。Codex 测试同时要求 cache key 不变与完整旧请求前缀保留；它用词是 cache-hit potential，没有证明服务端实际命中。[P: system-prompt.ts:217](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:217)、[C: tools.rs:99](C:/Works/PubProj/codex/codex-rs/core/src/context/world_state/tools.rs:99)、[C: prompt_caching.rs:550](C:/Works/PubProj/codex/codex-rs/core/tests/suite/prompt_caching.rs:550)。

但 pi fallback projection 会把更新后的当前 system/tool set 放回头部；支持 native additions 的路径才能更好保留历史位置。因此建议 KodaX 先让内容/工具顺序确定、避免无变化重建文案，再单独为确实支持的 provider 做增量协议。不能承诺“client 内部是 patch”就意味着所有模型请求都能沿用原前缀。[P: transcript.ts:108](C:/Works/PubProj/pi/packages/ai/src/utils/transcript.ts:108)、[P: transcript.ts:236](C:/Works/PubProj/pi/packages/ai/src/utils/transcript.ts:236)。

## 最小落地顺序与需要验证的反例

1. **不增加路由先减重复。** 对当前首个实际请求制作必要行为归属表，工具规则保留唯一来源；让核心 schema 保持完整。这一步不依赖模型新能力。参照 pi guidelines 的归属和回归测试。[P: agent-session-codemode.test.ts:174](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-codemode.test.ts:174)
2. **只把确有体积收益的可选正文变 hint/on-demand。** 目录必须保留触发语义与取回路径；少量常用核心工具不先延迟。参照 skills 和 MCP 不同粒度目录。[P: skills.ts:358](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:358)、[P: mcp/index.ts:195](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:195)
3. **若扩展 schema 是大头，先复用 KodaX 已有 bridge。** 仍使用普通 function tools 与现有 serializer，清楚区分 registry 可执行、当前请求可见、policy 允许；activation 是值得比较的另一条路径，不能仅因 pi 已实现就视为 KodaX 更小改动。原生搜索/增量只是能力声明后的增强。[P: tool-search/tool.ts:194](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:194)、[C: spec_plan.rs:392](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:392)；KodaX 实现依据见文末。
4. **把生命周期恢复作为功能的一部分。** 激活、fork、resume、compact、禁用与 schema 变化的行为要先规定，避免首轮 token 降了却在长任务中失去能力。[P: session-manager.ts:1260](C:/Works/PubProj/pi/packages/coding-agent/src/core/session-manager.ts:1260)、[P: agent-session-mcp.test.ts:1207](C:/Works/PubProj/pi/packages/coding-agent/test/suite/agent-session-mcp.test.ts:1207)

最少应人工/后续测试审视这些反例：

- 工具藏起来了，namespace hint 又没描述用途，模型直接宣称没有能力。
- guideline 从 system 删除，但 discovery 只返回裸 schema，丢失工具用法约束（pi 已有明确回归例）。
- 提醒只以进程内 `sent=true` 去重，compaction 后必要说明永不恢复。
- 父任务已激活工具，child 只继承摘要没有契约，却沿用父工具名调用。
- tool_search 成功日志已进入 history，客户端活跃集合未恢复，模型看起来知道工具但后端不允许调用。
- 搜索工具用英文 BM25，而用户任务为中文：pi tokenizer 仅保留 `[a-z0-9]`，Codex BM25 也显式 `Language::English`；不能以静态机制存在替代跨语言召回验证。[P: tool-search/tool.ts:71](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:71)、[C: tool_search.rs:175](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/tool_search.rs:175)
- 顶层 tools 缩小但 exec 描述复制了同一份 schema，实际 provider 总输入没明显变化。[C: spec_plan.rs:1024](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1024)
- 每次用户轮都清空活跃集合，导致同一工具反复搜索；或永不清理，长期又积成全量。pi 当前搜索只追加 active，说明第一轮与长任务的成本必须分别观察。[P: tool-search/tool.ts:199](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:199)

## 未证实 / 未解问题

- 哪些 KodaX provider 能可靠接受下一请求扩展普通 tools，哪些支持原生 tool-search/inline additions，需要逐 provider 契约与本地 serializer 核查；本报告不把 Codex 的 native 协议泛化。
- 延迟多少工具/正文才划算，是否影响跨模型完成质量，目前无实测结论。应比较首个 API 输入与完整用户任务总 input/output、调用轮数、错误恢复，而不是只比较 system 字符数。
- 本轮没有审计 KodaX 自己的 child/compaction 全链路，因此最小架构建议需要由主调研映射到现有 session state，避免重复实现。
- 没有证据说明按关键词裁剪重要 prompt、把所有工具改成 bridge、或强制所有模型 codemode 能保持行为；不建议把这些作为跨模型默认改动。

## 补充：KodaX 当前实现下，bridge 与 activation 的真实增量

本节直接审计当前 KodaX checkout，HEAD `bd4479d59cab3d082f07c2d34681fff198d82fa0`（下称 **K**），未修改业务代码、未执行模型/eval。它修正前文仅从 pi 类推的优先级。这里的 **activation** 指“搜索后将目标工具 schema 放进下一请求的普通 native function tools”，不等于 OpenAI 原生 ToolSearchOutput 协议。

### 现状：已有 bridge，并非要从零设计

SA 的 `getActiveToolDefinitions` 明确保留参数 schema，只把 deferred description 替换为 hint；unlock WeakMap 只控制 description 恢复。每次请求前读取 unlock set 再构造工具定义，所以不能把现状描述成“工具已真正按需激活”。[K: tool-resolution.ts:164](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-resolution.ts:164)、[K: deferred-tools.ts:94](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/deferred-tools.ts:94)、[K: run-substrate.ts:1767](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/run-substrate.ts:1767)。

SA exposure planner 已能把 deferred tools 从模型可见列表过滤，执行资格仍由 `runtimeSessionState.activeTools`/dispatch 控制；有 bridge 时优先 bridge，调用点硬设 `nativeDeferredAvailable:false`。但 planner 对 `already_unlocked` 优先返回 resident，因此目前 search 一解锁，下一请求会把完整目标 schema 放回来——这不是固定桥接表的完整生命周期。[K: tool-exposure-planner.ts:126](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-exposure-planner.ts:126)、[K: tool-exposure-planner.ts:246](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-exposure-planner.ts:246)、[K: run-substrate.ts:1822](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/run-substrate.ts:1822)。

AMA 角色构造时建立 RunnableTool 集合，只对 description 做一次 hint swap；LLM adapter 每次从 `agent.tools` 映射全部 wireTools，generic executor 也从 `agent.tools` 找 handler。当前没有“search 修改 AMA 模型可见集合”的生产通路，tool_search 自己的 description 也明确说明 AMA 依靠搜索结果教学。[K: agent-chain.ts:351](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:351)、[K: agent-chain.ts:408](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:408)、[K: llm-adapter.ts:491](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)、[K: runner-tool-loop.ts:212](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/agent/src/primitives/runner-tool-loop.ts:212)、[K: tool-search.ts:180](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:180)。

两条路径的 bridge 均已执行真实 target：SA 重新检查 target permission、active set、write recovery，再执行既有 registry/run-scoped tool；AMA bridge 捕获角色允许的完整 target definitions，检查 active target、permission、abort，复用角色 override 或现有 wrapper。Auto-mode 在分析前已把 wrapper 解成 target；child 的 permission hook 继续按目标工具检查 parent-only 和实时 plan mode。[K: tool-dispatch.ts:450](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-dispatch.ts:450)、[K: agent-chain.ts:216](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:216)、[K: guardrail.ts:1225](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/guardrails/auto-mode/guardrail.ts:1225)、[K: child-executor.ts:2468](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/child-executor.ts:2468)。这证明可复用接线，不代表所有未来新增工具都自动兼容；AMA async-generator target 仍需现有 role override。[K: agent-chain.ts:286](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:286)

已有测试覆盖 SA target permission 只请求一次、inactive target 拒绝；AMA bridge 可执行、多模态结果保留、等待 permission hook 时取消后不执行目标。这里未重跑测试，证据是已存在的契约覆盖。[K: tool-dispatch-bridge.contract.test.ts:125](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/__contract-tests__/tool-dispatch-bridge.contract.test.ts:125)、[K: tool-dispatch-bridge.contract.test.ts:192](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/__contract-tests__/tool-dispatch-bridge.contract.test.ts:192)、[K: runner-driven-tool-wiring.test.ts:273](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts:273)、[K: runner-driven-tool-wiring.test.ts:335](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/runner-driven-tool-wiring.test.ts:335)。

### 两种方案的调用轨迹没有必然轮数差

KodaX `tool_search` 返回 `<function>`，包含完整 description、name、parameters；bridge `tool_call` 只要求 name/input，不检查必须先 describe。已知精确工具名可通过 `select:` 取回契约，下一模型轮即可调用 bridge target。因此相同 discovery 下：activation 是 `search → target(args)`，bridge 是 `search → tool_call({name,input})`，都能在下一轮执行。工具当前的 `tool_describe` 文案说“Use this after tool_search”，可能误导模型多读一次，属于应澄清的重复提示；这不是执行器的强制前置条件。[K: tool-search.ts:97](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:97)、[K: tool-search.ts:129](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:129)、[K: tool-bridge.ts:46](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-bridge.ts:46)、[K: tool-bridge.ts:71](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-bridge.ts:71)。

### 增量比较

| 维度 | 复用现有 bridge 延迟目标 schema | 搜索后 native activation |
| --- | --- | --- |
| SA 活跃/执行集合 | 保留已有执行资格，只过滤可见 schema；需要让 search 解锁说明与恢复 native 可见性解耦 | 可利用 per-request 构造点，但必须明确搜索只激活有资格工具，并保存展示集合 |
| AMA 活跃/执行集合 | 保留 `agent.tools`/已捕获 target map 作为执行表，在 adapter 做稳定模型视图 | 也可保留完整执行表；另加每次请求可变模型视图及 activation state，不必破坏性修改 Agent |
| provider adapter | 普通 tool_call schema 已存在；主要是 wireTools 过滤/提示一致性 | 普通 tools 序列化已存在，但 dynamic state 要传入 AMA adapter；不是开启一个现成 flag |
| compaction/resume | 不必持久化“已启用调用资格”，但取回的 schema 文本可能被压掉，必须保留 discovery hint 并可重取 | 若 native 可见性持久，需要恢复激活集合并重投 schema；若重置，必须明确再次 discovery，避免模型调用不可见工具 |
| child | 用 child 本身允许的 target 集合与 existing permission hook，重建相同视图 | 同样要按 child 允许集合构造；父 active names 不能直接作为 child 权限 |
| 参数形状 | native wrapper 的 input 仅为一般 object，目标完整 schema 存在历史文本中 | 当前 provider tools 可看见目标参数的实际结构 |
| 重复 schema | 可避免搜索结果与 native target schema 同时驻留；SA 必须改 already_unlocked 回升逻辑 | 若沿用当前 full-schema search 结果，又激活 native schema，会在历史与 tools 中重复；应定义哪个拥有完整契约 |
| 缓存 | 固定 bridge + 稳定 catalog 有望少改顶层 tools；仍受 system/history/provider 影响 | 每次首次激活会改顶层 tools；原生增量协议另论，不应套用到所有 provider |

表中“需要”均为设计增量推论。依据是上述 SA 逐请求构造、AMA 静态 execution/wire 映射、WeakMap unlock 和已接线 bridge；不把代码行数差或实际性能声称成已测结果。

参数可靠性不能只凭原生 schema 就宣称更优：KodaX OpenAI mapper 的普通 function 定义带 parameters，但此处未设置 strict true；registry 的通用验证主要检查 required 参数，具体类型语义仍可能由 handler 决定。bridge 将 target schema 移到文本，会减少 provider 对目标参数的直接结构提示，这是可预期的机制差异；但实际错误率、是否需要修复重试，只能按真实模型比较。也不能以桥接已有权限接线替代参数可靠性验证。[K: openai.ts:920](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/llm/src/providers/openai.ts:920)、[K: tool-bridge.ts:75](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-bridge.ts:75)、[K: registry.ts:469](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/registry.ts:469)。

### 修正后的默认取舍

**KodaX 当前最小工程方向应偏向复用 bridge，而不是移植 pi activation。**理由是双路径 target 执行/权限和测试已经存在，AMA 目前没有动态可见集合，且 search 已完整返回 schema，所以 bridge 没有必然额外往返。限于已确定可发现、低频、体积较大的工具；核心工具保持 direct。这里支持的是工程增量更小的取舍，不是“bridge 全模型效果更好”。[K: agent-chain.ts:216](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:216)、[K: llm-adapter.ts:491](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts:491)、[K: tool-search.ts:97](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-search.ts:97)。

最小改动还应包括三项，不能只把 schema filter 打开：一是保留可理解的 discover hint；二是解释 search 已返回契约时可直接 tool_call，describe 仅作缺失/重取；三是搜索后的 SA description-unlock 不自动反转 bridge 暴露策略，以免 schema 又加回顶层。AMA 只过滤模型视图，不能删除执行 target 集合。[K: tool-exposure-planner.ts:246](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/agent-runtime/tool-exposure-planner.ts:246)、[K: agent-chain.ts:366](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts:366)、[K: tool-bridge.ts:46](C:/Works/GitProj/KodaX-AI/KodaX-next-dev/packages/coding/src/tools/tool-bridge.ts:46)。

只能由后续对照验证决定的内容：bridge 对复杂参数的错误率、模型是否会多余调用 describe、重复使用时 activation 是否更省输出/更少失误、compaction 后重取率、缓存实际命中、完整任务总成本与完成质量。应比较相同候选工具集的 `hint/direct`、`search→bridge`、`search→activation`，并保证 search 成功后的两种方案都允许下一轮执行，不能人为给 bridge 多加一次 describe 后再比较。
