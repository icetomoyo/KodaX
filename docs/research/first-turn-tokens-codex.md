# Codex 当前如何控制首轮输入 token，哪些做法适合 KodaX 借鉴？

结论摘要：该版本 Codex 使用「基础指令 + 按能力启用的上下文 + 有预算的 skills 目录 + 条件延迟加载的工具」；真正直接减少首轮输入的是减少完整 skill/tool 定义、压缩重复元数据，而稳定前缀、cache key 和增量上下文主要改善后续请求。不能把全部实验特性当成默认行为，也不能据源码推断实际 token 节省比例。[S1–S12]

## 调研边界

- 只读本地第一方源码 `C:/Works/PubProj/codex`，HEAD 为 `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`；2026-10-14 查阅时 `git status --short` 为空。下文源码引用均固定于此 commit，无联网、无模型请求、无 benchmark/eval。未发现适用于所读路径的额外 AGENTS.md。
- 这里的「首轮」主要指新会话第一次模型请求；第一次用户任务的所有 tool-loop 调用合计是另一指标。源码能证明组装规则，不能证明某用户实际启用的配置、服务端下发模型配置或实际计费 token。
- 来源定位记法 `codex-rs/...:N` 均相对上述 Codex 仓库根；可用文末绝对路径跳转。

## 1. 请求的输入组成：并非只看一个 system prompt

基础指令来源顺序是显式 `config.base_instructions`、会话历史继承的基础指令、当前模型的 instructions template。当前模型不是唯一来源，因此比较两次请求应固定模型、会话来源与配置。[S1: `core/src/session/mod.rs:798–835`]

初始上下文同时收集配置的 developer instructions、extension 的 thread/turn context、world state；world state 再加入 AGENTS、权限、环境、协作/模式及工具目录等条件片段。环境片段记录 cwd、shell、日期/时区、权限/工作目录、可能的 subagents，没有在该环境渲染器中默认生成完整仓库树或源码摘要。[S2: `core/src/session/mod.rs:4469–4554`; `core/src/session/world_state.rs:147–343`; `core/src/context/world_state/environment.rs:262–353`]

工具 schema 也是实际请求组成。普通 Responses 请求使用 `tools` 字段；Responses Lite 把工具转为 developer `AdditionalTools` 项置于 input 前缀。基础指令也放到前缀。因此仅统计消息文本、只数 system prompt，或只看 `input` 而漏掉外部 `tools` 都会漏算。[S3: `core/src/client.rs:978–1006`; `core/src/session/turn.rs:1665–1695`]

## 2. Skills：目录先行，正文按需；目录本身也有预算

目录条目是 name、description、locator，而非把所有 SKILL.md 正文填进首轮。显式点名的 host skills 会被选择并调用 `load_skill_prompts` 读正文；普通目录则给模型定位路径，由使用指引要求按需打开。[S4: `ext/skills/src/render.rs:203–274`; `core/src/session/turn.rs:1150–1178`; `ext/skills/src/host_prompt.rs:59–101`; `ext/skills/src/catalog_prompt.rs:7–24`]

预算并非固定 2000 token：有可用 context window 时默认目录预算是其 2%；未知 window 时回退为 8000 字符；显式 `max_context_tokens` 最多取 10000。显式覆盖上限不等于默认 2% 分支也有 10000 上限。token 费用使用近似计数，非 provider tokenizer 真值。[S5: `ext/skills/src/render.rs:19–28,132–195`; `ext/skills/src/config.rs:5–16`]

预算策略优先保留名称和路径，把剩余空间轮流分配给各技能的 description；连最小条目都放不下才省略条目。单条 description 预截到 1024 字符，路径共享根可折叠成别名，但会比较完整路径版和别名版的覆盖数、描述保留量及总费用，只有有利才采用别名。目录有确定性排序，超预算还会记录遗漏和描述截断信息。[S6: `ext/skills/src/render.rs:46–67,331–456,1049–1108`; `ext/skills/src/render_dedup.rs:65–106`; `ext/skills/src/render_observability.rs:36–111`]

去重有明确语义，不能总结成「所有同名技能去重」：cloud 同名 `plugin:skill` 优先，可在预算前从另一个 catalog 删除对应名称；host 根还按路径去重；已由扩展注入/替代的正文用 normalized path 标记，防止重复注入。[S7: `ext/skills/src/render_dedup.rs:40–55`; `ext/skills/src/host_roots.rs:69,271`; `ext/skills/src/host_prompt.rs:11–45`]

注意正文的 8000 bytes 限制不是所有 host skill 的统一上限：`load_skill_prompts` 只对 agent-plugin skill 调用此截断，其他 selected host skill 保留全文。不能把该常量解读成普遍保护。[S4: `ext/skills/src/host_prompt.rs:76–90`; S5: `ext/skills/src/render.rs:21,1111–1117`]

## 3. AGENTS：有作用域和总预算，但仍会占首轮

项目说明按 repo root 到 cwd 的祖先链加载，不递归遍历所有子目录；默认以 `.git` 识别根，支持 `AGENTS.override.md` 优先。项目内容预算默认 32 KiB；跨多个 turn environment 共用剩余预算，超长项目文件会截断并 warning。已有 host/user instructions 先进入结构，此 32 KiB 是 project docs 预算，不应推断成所有指令的总预算。[S8: `core/src/agents_md.rs:1–17,38–68,69–95,145–182`; `config/src/config_toml.rs:75`; `core/src/config/mod.rs:4483`]

对 KodaX 的启发（设计推论）：遵守用户规则的指令不能依赖相关性猜测后省略；先做作用域选择、相同来源去重和显式预算/截断可观测性，再考虑压缩冗余元数据。Codex 的做法只能作为边界控制先例，并不证明静默截断用户规则是合适的产品行为。[依据 S8]

## 4. 工具：延迟完整 schema，但可发现性仍有首轮成本

MCP tools 是否延迟不是由旧 `search_tool` flag 决定：`append_mcp_tools` 使用 `model_info.supports_search_tool`；支持时默认 Deferred，否则 Direct；后续还有暴露策略调整。当至少一个可搜索 deferred tool 存在，注册 `tool_search`，搜索使用 BM25 并把匹配工具暴露给下一次模型调用。[S9: `core/src/tools/spec_plan.rs:148–164,391–457`; `core/src/mcp_tool_exposure.rs:84–88`; `core/src/tools/handlers/tool_search_spec.rs:97–113`]

本地 bundled catalog 的 `gpt-6.1-sol`、`gpt-6-astra` 等声明 `supports_search_tool: true`。但 fallback ModelInfo 默认为 false，运行时模型目录还可能变化，因此不可把支持能力外推到 KodaX 的所有 provider/model。[S10: `models-manager/models.json:4,160,177,335`; `models-manager/src/model_info.rs:136`]

Code Mode 也不等于不发工具定义。注册时非 deferred 工具仍被加入 `exec_prompt_tool_specs`，这些定义供模型写 JS 调用；deferred 工具才走分离的提示路径。因此只有把 schema 从 JSON tools 字段搬到 exec 的描述里，不保证首轮 token 明显减少。[S11: `core/src/tools/spec_plan.rs:1011–1045`]

必须区分以下条件：[S9–S12]

| 项目 | 该 commit 的条件/默认 | 对首轮的意义 |
|---|---|---|
| `search_tool` feature | Removed，默认 false；实际看 model capability | 不能推荐「开启旧 flag」作为通用方案 |
| `CodeMode` / `CodeModeOnly` feature | flag 默认 false，但 `model_info.tool_mode` 优先；gpt-6.1-sol / gpt-6-astra 的 catalog 值是 `code_mode_only` | 不能仅看 feature default 判定当前典型 Codex 使用 Direct |
| `DeferredToolWorldState` | 默认 false | 开启后另发有 4 KiB 上限的 namespace 摘要，每个描述先取首行最多 250 字符；保存名称优先，后续只发变化 |
| 关闭上述 world-state flag | 在 `tool_search` 描述内列出 sources | 这条旧路径总 source 描述预算是 512 KiB，不能宣称所有 Codex deferred 目录都只有 4 KiB |
| `IncrementalTools` | 默认 false，且要求 `use_responses_lite` | 将工具/基础指令放入有版本的历史 world state，主要减少后续变更破坏前缀；首轮仍需初始 catalog |

引用细节：`features/src/lib.rs:1162–1172,1216–1220,1258–1262,1586–1596`; `core/src/tools/mod.rs:63–83`; `models-manager/models.json:20,193`; `core/src/session/world_state.rs:147–157,318–327`; `core/src/context/world_state/tools.rs:28–29,56–76,99–144`; `core/src/tools/spec_plan.rs:1633–1643`; `core/src/tools/handlers/tool_search_spec.rs:8,34–99`; `core/src/session/step_context.rs:54–63`。

另外有 agent-plugin MCP schema 限制：单工具 8000 bytes、总计 64000 bytes，超限隐藏；这不是所有 MCP 工具的统一限额。外部 server 还可传 schema max bytes。[S9: `core/src/mcp_tool_exposure.rs:17–18,95–100,130–156`]

## 5. 缓存、稳定前缀和真实 token 口径

请求有 `prompt_cache_key`；一般使用 session ID，internal child 可使用 source + parent thread ID，也支持 override。测试明确要求多轮上下文变化后保留首轮前缀和 key，以提供 cache hit potential；这证明客户端努力保持稳定性，不证明服务器实际命中。[S13: `core/src/client.rs:646–668,1060,1090`; `core/tests/suite/prompt_caching.rs:550–557,820–827`]

工具/基础指令放进稳定前缀；可变环境以 world-state diff 增量描述，未变化不反复插入。这比每次重写初始环境更有利于前缀稳定，但原始历史仍在 input 内，不能把「只添加 diff」误述成原内容不占后续 context。[S3; S12: `core/src/context/world_state/top_level_tools.rs:1–5`; `core/src/context/world_state/environment.rs:113–190`; `core/src/session/turn.rs:1665–1695`]

统计必须分开 `input_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`output_tokens`；Codex 的 `non_cached_input` 明确等于 input 减 cached，显示单一绝对值可用「非缓存输入 + 输出」。跨产品比较 UI 数字前应先核对口径，否则相同输入可能显示不同 token 数。[S14: `protocol/src/protocol.rs:2368–2373,2551–2561,2621–2625`]

## 6. 对 KodaX 的可迁移建议（推论，不是已验证效果）

1. 首先在 provider 最终请求边界分账：基础指令、项目指令、技能 catalog、显式 skill 正文、tool schemas、动态环境/历史、用户输入；字节/近似 token 与 provider actual usage 分开。Codex 本身对 skills 的 kept/omitted/truncated 设指标，说明「可观测预算」比只看总量更容易定位。[依据 S3、S6、S14]
2. 优先处理不改变能力的重复：同一来源 skill/AGENTS 重复注入、长路径重复、相同工具说明在 system 和 schema 同时出现。对重复来源先规范化身份再去重；不要把名称相似误当语义相同。[依据 S7]
3. Skills 保留可发现的简短目录，正文按需。先使用描述与路径预算；极大目录才需要 selector/search。保留名称不一定保留触发语义，不能只用「目录 token 更少」判断成功，应检查该找的技能还能否被找到。[依据 S4–S6；效果待验证]
4. 若 MCP/插件多，再评估稳定常驻核心工具 + 可发现的扩展工具目录 + 按需 schema。不要为少量核心 coding tools 引入复杂路由；额外 search 调用可能抵消首轮节省，需比较首次用户任务完整轨迹。[依据 S9、S11；成本收益待验证]
5. 保持基础指令和 schema 顺序稳定；时间/工作区状态避免无意义重写。缓存优化单独报告，不要把 cached token 抵扣描述为首轮 prompt 缩短。[依据 S12–S14]
6. 不建议照搬 Codex 的全部预算常量和新协议。2% 的目录预算依赖其 context window，IncrementalTools 依赖 Responses Lite，Code Mode 依赖模型/工具运行时；KodaX 的跨 provider 最小实现应按实际重复和实际超量点选用。[依据 S5、S10–S12]

## 未证实

- 没有运行模型或测量首轮请求，不能给出 Codex 实际 token 总量/节省百分比/缓存命中率。
- 未读取用户 Codex 配置，也未调用远程模型目录；本机实际部署的默认配置可能与 bundled catalog 不同。
- 源码的局部 schema/body/metadata 预算不能当作整个系统提示词统一 hard cap。

## 未解问题

- KodaX 当前问题是第一次 API input 多，还是用户第一轮累计 input/output 多？缓存计入口径是什么？
- 大头来自固定 prompt、项目规则、skills 目录、MCP schema，还是自动仓库上下文？需对 KodaX 最终请求组装独立追踪。
- 哪些提供方支持可靠工具增量与 cache？在不支持时，按需工具发现是否增加总轮次/失败率？
- 截断目录描述会不会丢失关键触发条件？应先定义行为保持标准，再判断是否值得使用目录裁剪。

## 源码入口

所有引用对应 commit `c22a06c18070c3e33bd2648c7210a00a2a9f6f80`。

- S1 [会话基础指令选择](C:/Works/PubProj/codex/codex-rs/core/src/session/mod.rs:798)
- S2 [world-state 构建](C:/Works/PubProj/codex/codex-rs/core/src/session/world_state.rs:147)
- S3 [实际请求序列化](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:978)
- S4 [显式技能正文加载](C:/Works/PubProj/codex/codex-rs/ext/skills/src/host_prompt.rs:59)
- S5 [技能预算](C:/Works/PubProj/codex/codex-rs/ext/skills/src/render.rs:132)
- S6 [技能预算分配](C:/Works/PubProj/codex/codex-rs/ext/skills/src/render.rs:331)
- S7 [技能预算前去重](C:/Works/PubProj/codex/codex-rs/ext/skills/src/render_dedup.rs:40)
- S8 [AGENTS 加载](C:/Works/PubProj/codex/codex-rs/core/src/agents_md.rs:55)
- S9 [工具计划](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:148)
- S10 [本地模型目录](C:/Works/PubProj/codex/codex-rs/models-manager/models.json:177)
- S11 [Code Mode 工具描述生成](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1011)
- S12 [功能默认值](C:/Works/PubProj/codex/codex-rs/features/src/lib.rs:1586)
- S13 [缓存 key](C:/Works/PubProj/codex/codex-rs/core/src/client.rs:646)
- S14 [token 使用口径](C:/Works/PubProj/codex/codex-rs/protocol/src/protocol.rs:2551)
