# pi 当前如何控制首轮 token，KodaX 应借鉴什么？

TL;DR：pi 的重点是小型默认工具集、技能目录与正文分离、MCP schema 延迟发现、明确的目录预算；项目指令仍然全文加入。缓存与分段更新主要降低后续调用成本，不等于减少首个冷请求的输入量。

## 范围与证据

- 调研日期：2026-10-14；本地仓库 `C:/Works/PubProj/pi`，HEAD `3daa20280f6a7c7cbe0935680c9a38fdc3863005`，检查时工作区干净。以下所有源码位置均属于该 commit；只读源码，没有启动 agent、连接模型或执行 benchmark/eval。
- 下文的“首轮”优先指新会话第一次模型请求。一次用户任务中的全部模型调用另算，按需加载会把一部分成本移到后续调用，不能只比较第一次输入。
- 这是当前 checkout 的实现分析，不能套用“早期 pi 只有四个工具”的印象：本版已经存在 MCP、codemode、tool_search、结构化 system 更新和缓存保温。源码：[默认工具](C:/Works/PubProj/pi/packages/coding-agent/src/core/settings-manager.ts:85)、[MCP 扩展](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:1)、[系统分段](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:50)。

## 1. 新会话装入什么

| 成分 | 当前实现 | 对首轮的含义 |
| --- | --- | --- |
| 基础 system | 一段 coding assistant 身份、可见工具单行简介、规则、pi 文档入口 | 短基础框架，但文档导航不是零成本 |
| 工具规则 | 只取已声明工具贡献的 guidelines，相同规则去重 | 避免无关工具规则常驻 |
| 项目指令 | 全局 agent 目录指令 + 从文件系统祖先到 cwd 的指令，全文包入 `project_instructions` | 大 AGENTS 仍然直接放大首轮 |
| skills | 名称、描述、绝对路径，正文不进入目录 | 正文需要时再读；目录随 skills 数量增长 |
| 环境 | 默认 builder 固定添加 cwd | 默认 builder 不主动加入目录树、git diff、git status 或每请求时钟 |
| 工具 schema | 默认内置 read、bash、edit、write；扩展/配置能改变 | 原生默认工具集合小；不代表所有用户环境都是四工具 |

上表来源：[system-prompt.ts:79](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:79)、[system-prompt.ts:90](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:90)、[system-prompt.ts:149](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:149)、[skills.ts:358](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:358)、[resource-loader.ts:232](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:232)、[sdk.ts:278](C:/Works/PubProj/pi/packages/coding-agent/src/core/sdk.ts:278)。环境结论仅适用于这个 builder；扩展可以加入自定义 sections 或改写请求。

默认工具 schema 也直接、窄：read 为 `path/offset/limit`；bash 为 `command/timeout`；write 为 `path/content`；edit 为 `path/edits[{oldText,newText}]`。核心约束仍保留，例如 edit 要求原文件匹配、唯一、禁止重叠，不能把简短误解为省掉正确性契约。[read.ts:14](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/read.ts:14)、[bash.ts:40](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/bash.ts:40)、[write.ts:11](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/write.ts:11)、[edit.ts:21](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:21)。

## 2. Skills 与指令：有延迟正文，没有全局预算

技能文件在本地发现阶段会被读入并解析 frontmatter，但模型初始只看 XML 目录中的 `name/description/location`。因此本地文件 I/O 与模型输入不是同一个指标。`disable-model-invocation: true` 的技能不进入模型目录，只保留显式命令用途。[skills.ts:283](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:283)、[skills.ts:329](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:329)、[skills.ts:358](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:358)。

技能名称 64、描述 1024 的常量只是验证警告，超长但有描述的 skill 仍装载；formatter 不截断、不挑选相关技能，也没有目录总预算。不能引用这些常量声称 pi 把技能 token 严格限制住了。[skills.ts:11](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:11)、[skills.ts:122](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:122)、[skills.ts:324](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:324)、[skills.ts:377](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:377)。

每层目录只选一个上下文文件，优先序是 `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`。祖先链之外还加载全局 agent 目录。实现专门识别嵌套 linked worktree：当 worktree 自己的上下文覆盖同一仓库范围时，跳过主仓库祖先中的副本，避免同一项目指令加载两遍。[resource-loader.ts:184](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:184)、[resource-loader.ts:210](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:210)、[resource-loader.ts:232](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:232)。

项目上下文 renderer 原样插入文件内容，没有字符/token 截断。自定义 `SYSTEM.md` 替代默认 preamble/tools/rules/docs，但随后仍追加项目指令、skills、cwd；不是整个上下文的空白替换。项目级 SYSTEM/APPEND_SYSTEM 发现受项目 trust 条件限制。[system-prompt.ts:79](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:79)、[system-prompt.ts:152](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:152)、[system-prompt.ts:172](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:172)、[resource-loader.ts:1213](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:1213)。

## 3. MCP：延迟工具 schema，但保留可发现性

MCP 默认 exposure 为 `codemode`。pi 将其映射为底层 `deferred` tool exposure，使其既不直接声明给模型，也不把 schema 填满 codemode 描述。模型先看简短服务器目录，再通过脚本中的 `searchTools/describeTool/describeNamespace` 发现工具与服务器 instructions。[mcp-servers.ts:233](C:/Works/PubProj/pi/packages/coding-agent/src/core/mcp-servers.ts:233)、[mcp/tools.ts:40](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/tools.ts:40)、[mcp/index.ts:387](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:387)、[codemode/tool.ts:123](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:123)。

`mcp_servers` 是独立 system section：服务器按名称排序；每个服务器描述取配置或 server instructions 的第一行，最多 250 字符；整节最多 4096 字符，必要时缩描述或省略末尾服务器并给计数。这是明确的首轮 catalog 控制，而不是将全部 schema 改个包装再发一遍。[mcp/index.ts:154](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:154)、[mcp/index.ts:185](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:185)、[mcp/index.ts:195](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:195)。

`codemode` 和 `tool_search` 扩展单独注册时默认 inactive；有对应 MCP 配置时，MCP 扩展会提前激活 codemode（除非禁用 autoEnableCodemode）或 tool_search（服务器 exposure 为 deferred）。`direct` MCP 仍从一开始声明。因此“默认四工具”只适合没有额外配置/扩展的基线。[codemode/index.ts:1](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/index.ts:1)、[tool-search/index.ts:1](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/index.ts:1)、[mcp/index.ts:496](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:496)。

tool_search 在本地用 BM25 搜索名称、描述、schema 属性/描述和 namespace 内容，默认 8 个命中；只搜索尚未 active 的 codemode/deferred 工具。命中后加入 active tools，下一次模型请求可直接调用；结果文本只给工具名和描述第一行。它不是一次额外的 LLM 路由调用，但模型调用 discovery 本身通常仍产生一个工具往返。[tool-search/tool.ts:21](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:21)、[tool-search/tool.ts:114](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:114)、[tool-search/tool.ts:194](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:194)、[tool-search/tool.ts:239](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:239)。

其 tokenizer 只按 `[a-z0-9]` 留词，中文自然语言 query 本身可能无有效词；借鉴时不能直接宣称支持中文语义路由。加载后的 active tools 在所读 `searchAndLoad` 路径里只增不减，所以它主要推迟成本，并非永久保持固定小工具集。[tool-search/tool.ts:71](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:71)、[tool-search/tool.ts:199](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:199)。

## 4. codemode：避免重复声明，有目录预算，也有自身成本

默认 inlineBudget 为 3000 **估算 token**，工具段以 `ceil(chars / 4)` 计价。各 namespace 轮流选当前最便宜工具入目录，超预算部分留给发现。这个预算只限制工具 section，不包含 codemode 使用说明、globals 或 namespace 标题，不能把整个 codemode 工具描述当成严格 3000 token 上限。[settings-defaults.ts:57](C:/Works/PubProj/pi/packages/coding-agent/src/core/settings-defaults.ts:57)、[codemode/tool.ts:136](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:136)、[codemode/tool.ts:202](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:202)、[codemode/tool.ts:230](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:230)。

`mode=on` 时直接工具保持 provider 声明，codemode 描述仅列非 direct 的可调用工具；`mode=only` 时隐藏 direct 声明，改放入 codemode 目录。按 exposure 而非当前 active 状态生成目录，避免 tool_search 激活工具又改写 codemode 描述。隐藏的工具也从默认 system 的工具简介/规则中移除。[codemode/tool.ts:312](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:312)、[system-prompt.ts:150](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:150)、[agent-session.ts:1768](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1768)。

脚本可以批量调用并过滤输出，只有脚本主动输出回模型；这有利于一次任务后续工具返回量，但需要额外 JS sandbox、执行及结果契约。不能仅为四个内置工具的首轮优化就推断移植整套 codemode 划算。[codemode/tool.ts:1](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:1)、[codemode/tool.ts:109](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:109)、[codemode/tool.ts:113](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/codemode/tool.ts:113)。最后一句是基于实现复杂度的建议，未做收益实测。

## 5. 缓存、后续 system 更新与统计口径

system prompt 被拆为有序 sections，变化时只向 transcript 写差异；未变化不写新 system message。provider 是否保留中途 system/tool 变化取决于兼容能力，例如 Anthropic 的原生工具变化需要相应 compat 开关且初始有工具。因此“内部增量”不能直接等同于每个 provider 都只发送网络增量或永不破坏缓存。[system-prompt.ts:225](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:225)、[agent-session.ts:1732](C:/Works/PubProj/pi/packages/coding-agent/src/core/agent-session.ts:1732)、[anthropic-messages.ts:1167](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:1167)。

Anthropic 默认 short cache retention，在 system、末尾工具、末尾适合的会话块加入 cache_control；OpenAI Responses 按 retention 与兼容能力传 session 关联的 prompt_cache_key/retention。它们是复用已有前缀的机制，代码不支持“缓存选项令冷启动输入 token 消失”的结论。[anthropic-messages.ts:65](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:65)、[anthropic-messages.ts:1220](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:1220)、[anthropic-messages.ts:1528](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:1528)、[anthropic-messages.ts:1658](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:1658)、[openai-responses.ts:327](C:/Works/PubProj/pi/packages/ai/src/api/openai-responses.ts:327)。

默认 cacheWarming 为 streaming：在真实请求之后、TTL 临近到期时，按经济性估算重新发送原请求且 maxTokens=1；不是启动前空发请求，也不是首个冷请求压缩器。其输入规模直接用最近一次 provider usage 的 `input + cacheRead + cacheWrite`，保温成本单独持久化为 `cache_warm`。[settings-defaults.ts:61](C:/Works/PubProj/pi/packages/coding-agent/src/core/settings-defaults.ts:61)、[sdk.ts:419](C:/Works/PubProj/pi/packages/coding-agent/src/core/sdk.ts:419)、[cache-warmer.ts:67](C:/Works/PubProj/pi/packages/coding-agent/src/core/cache-warmer.ts:67)、[cache-warmer.ts:344](C:/Works/PubProj/pi/packages/coding-agent/src/core/cache-warmer.ts:344)。

OpenAI usage 中 cached tokens 已包含在 input_tokens，pi 会先减缓存读写得到非缓存 input；Anthropic 另报 input/cacheRead/cacheWrite。这提示跨 provider 比较必须统一口径：实际 prompt 总量、非缓存计费量、缓存读写量分别统计，不可直接把不同 API 的 input 字段摆在一起。[openai-responses-shared.ts:561](C:/Works/PubProj/pi/packages/ai/src/api/openai-responses-shared.ts:561)、[anthropic-messages.ts:713](C:/Works/PubProj/pi/packages/ai/src/api/anthropic-messages.ts:713)。

## 对 KodaX 的可迁移建议（推论，不是已经验证的收益）

1. **先做首个实际 provider 请求的组成账单。** 区分默认 system、工具 schema、skills 目录、用户/项目指令、运行时环境及首条用户消息；统计与缓存账单分离。依据是 pi 对 token usage 的显式拆分，以及 builder 的独立 sections，而不是预设哪项最大。[system-prompt.ts:50](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:50)、[openai-responses-shared.ts:561](C:/Works/PubProj/pi/packages/ai/src/api/openai-responses-shared.ts:561)。
2. **优先消除重复与无关默认内容。** 借鉴只对 active tools 发规则、短 snippet 替代重复整篇工具说明、嵌套 worktree 指令去重；保留对能力使用至关重要的参数与边界约束。[system-prompt.ts:90](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:90)、[resource-loader.ts:210](C:/Works/PubProj/pi/packages/coding-agent/src/core/resource-loader.ts:210)、[edit.ts:21](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/edit.ts:21)。
3. **若 MCP schema 是大头，用服务器摘要 + 按需工具契约。** 先实现普通 discovery/direct-call 的小闭环，未必要引入 codemode。必须保留发现入口、失败回退、权限/执行契约，以及中文查询可用性。pi 已提供无需 codemode 的 deferred + tool_search 路径，但其英文 BM25 不能直接搬作中文方案。[mcp/index.ts:154](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:154)、[mcp/index.ts:496](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:496)、[tool-search/tool.ts:71](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/tool-search/tool.ts:71)。
4. **不要自动截断 AGENTS 或用关键词筛掉硬约束。** pi 也保留项目指令全文；其技能目录未设硬预算同样是规模风险。更稳妥的是先找重复注入、冗长自带介绍，允许项目作者把非普适操作手册拆到按需文件；这个建议依赖具体 KodaX 契约进一步判断。[system-prompt.ts:79](C:/Works/PubProj/pi/packages/coding-agent/src/core/system-prompt.ts:79)、[skills.ts:358](C:/Works/PubProj/pi/packages/coding-agent/src/core/skills.ts:358)。
5. **缓存优化与冷启动压缩分开排期。** 稳定排序、静态内容在前有利于后续复用；缓存保温新增请求与状态维护，不应作为首轮输入过大时的第一修复项。[mcp/index.ts:198](C:/Works/PubProj/pi/packages/coding-agent/src/extensions/mcp/index.ts:198)、[cache-warmer.ts:171](C:/Works/PubProj/pi/packages/coding-agent/src/core/cache-warmer.ts:171)。

## 未证实与未解问题

- 未运行模型请求，不报告“pi 首轮恰好多少 token”或相对 KodaX 降幅；也没有使用 chars/4 当成真实 tokenizer 结果。
- 尚未知道用户典型 KodaX 环境中 MCP、skills、AGENTS 和工具规范各占多少；应由主调研的 KodaX 请求构造审计确认。
- discovery 少发 schema 的收益能否抵销额外往返、误检和模型失误，需要后续在相同任务与 provider 下验证，至少同时观察第一次输入与整个任务的总 input/output、完成质量及延迟。
- 缓存命中率依赖 provider、模型兼容、实际前缀和会话使用方式；这里只确认客户端机制，没有实测服务端行为。
