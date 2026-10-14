# deepseek-harness 如何控制首轮输入，以及哪些做法适合 KodaX？

结论摘要：它的价值在于按 agent 实际能力组合 prompt/schema、skill 只先放目录、工作区指令按目录作用域加载和去重，以及把变化上下文移出稳定前缀；它并不是“默认只发一个极小 prompt”的实现。PTC 也不是自动节省首轮 token 的机制，因为完整工具 SDK 仍进入 system prompt。以下仅为本地源码静态分析，未进行模型调用、tokenizer 计数或效果评测。

## 来源边界

- 调研日期：2026-10-14。仓库：`C:/Works/PubProj/deepseek-harness`。当前 HEAD：`d743267388641bc76f17c45ce8b4c231aed1d32c`。`git status --short` 仅发现未跟踪 `.agent/`；下列被引用的 tracked 文件没有本地修改。所有相对源码路径均相对此仓库和此 commit。
- 使用当前源码、随仓库发布的配置和第一方 README。没有把测试 fixture 的大小当成产品默认输入大小，没有读取 credentials 或本地用户 skills/instructions。

## 1. 首次请求不是仅由 persona 构成

standard preset 和 headless profile 的 persona 只有 `You are a coding agent powered by the {{model}} model.`；系统注册器通常还添加 harness identity。短 persona 不等于短 system prompt，因为 plan、tools、MCP、SDK 等贡献独立 sections。[standard.patch.yml:11](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:11)、[headless/cordis.patch.yml:9](C:/Works/PubProj/deepseek-harness/packages/bundle/headless/cordis.patch.yml:9)、[system-prompt/src/index.ts:131](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:131)、[system-prompt/src/index.ts:441](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:441)。

prompt assembly 明确分成 `sections`、`contexts`、`tools`、`variables`。因此首轮至少要拆分统计：system sections、native tool schemas、skills 目录、工作区指令、runtime/time context、用户输入；不能只比较 persona 字符数。[system-prompt/src/index.ts:120](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:120)、[tool-skill/src/index.ts:215](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:215)、[agent-instructions/src/index.ts:334](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/index.ts:334)、[time-context/src/index.ts:185](C:/Works/PubProj/deepseek-harness/packages/context/time-context/src/index.ts:185)。

它还提供显式 minimal preset：`complete: true` 覆盖其他 system sections，`includeRuntimeContext: false` 抑制可选 runtime context，但保留 cwd 等 `required: true` 项，并挂载 persistent shell。这个模式是真实的能力/指导取舍，不足以证明 standard 模式也具备相同首轮成本。[minimal.patch.yml:11](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/minimal.patch.yml:11)、[persona/src/index.ts:62](C:/Works/PubProj/deepseek-harness/packages/preset/persona/src/index.ts:62)、[required 过滤](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:578)。更多注入路径见[第二轮笔记](prompt-injection-modes-deepseek-harness-2026-10-14.md)。

## 2. Skills：只先放简短目录，全文通过一个工具加载

首次目录包含 name + description，没有把各 skill 正文和资源路径全部装入目录。description 先压缩空白，默认最大 500 个 JavaScript string code units（不是 500 tokens）；随后 `skill` 工具按精确 name 返回完整内容及必要资源定位信息。[tool-skill/src/index.ts:28](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:28)、[tool-skill/src/index.ts:256](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:256)、[tool-skill/src/index.ts:321](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:321)、[tool-skill/src/index.ts:393](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:393)、[tool-skill/src/index.ts:129](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:129)。

目录和工具可见性绑定：当前 agent 看不见该注册的 `skill` 工具，就不发布其目录；仅 model-invocable skills 进入目录。已可见目录 digest 相同则不追加，目录变化时发布完整替代目录。这里的“只发布一次”指不额外追加重复历史，并不意味着后续 API 请求不再包含已有历史。[tool-skill/src/index.ts:215](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:215)、[tool-skill/src/index.ts:281](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:281)。

推论：适合 KodaX 的是有限摘要 + 单一正文加载入口 + 去重，而非把完整技能说明搬进基础 prompt。但当前实现仍把所有可调用 skill 摘要列出，单条 500 字符限制没有提供目录总预算；当 skills 很多时成本仍线性增长。此结论来自对全部 entries 的 `map` 和发布逻辑，而不是运行数据。[tool-skill/src/index.ts:55](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:55)、[tool-skill/src/index.ts:228](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:228)。

## 3. AGENTS：作用域加载、内容去重、显式预算

首轮 baseline 发现 user-global 文件和 project-root → cwd 祖先链文件，不递归预载所有子目录指令。默认项目根标记 `.git`；同目录默认候选为 `AGENTS.md`、`CLAUDE.md`，local overlay 为 `AGENTS.local.md`、`CLAUDE.local.md`。[agent-instructions/src/config.ts:11](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/config.ts:11)、[agent-instructions/src/files.ts:323](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/files.ts:323)。

同候选组按 trim 后内容 digest 去重，保留先发现的原始内容；同目录 symlink 和复制的相同文件均可折叠。不同作用域组不会因为内容相同就被随意合并；两个用户全局根属于同一去重组。[agent-instructions/src/files.ts:421](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/files.ts:421)。

standard preset 给指令 baseline/dynamic batch 的上限为 65,536 UTF-8 bytes；单源文件默认读取上限 1 MiB。渲染预算包括 reminder 包装和省略/截断说明。过预算先丢弃较早、较宽作用域文件，保留最具体后缀；仍超额时截断最具体文件。字节预算是边界保护，不是 token 预算，也不是无损压缩。[standard.patch.yml:15](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:15)、[agent-instructions/src/config.ts:14](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/config.ts:14)、[agent-instructions/src/render.ts:310](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/render.ts:310)、[agent-instructions/src/render.ts:348](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/render.ts:348)。

后续仅 `read`/`write`/`edit` 文件触碰触发嵌套/变化指令投影，工具结果成功后的流程将其加入后续上下文。这降低首次加载成本，但不能直接照搬为“任意 shell 修改前都已获得嵌套指令”的保证；其触发工具集合明确有限。[agent-instructions/src/index.ts:4](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/index.ts:4)、[agent-instructions/src/index.ts:76](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/index.ts:76)、[agent-instructions/src/index.ts:315](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/index.ts:315)。

## 4. Tools：能力范围比表达形式更重要

native 模式默认把当前 scope 的所有 visible tools 映射为完整 schema，字段包括 name、description、parameters。它没有在该默认路径按用户问题语义筛选最相关的几项工具。工具采用稳定排序，默认按名称的 locale-independent code-unit 顺序排列。[tools/src/index.ts:1017](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1017)、[tools/src/index.ts:1288](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1288)、[system-prompt/src/index.ts:218](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:218)。

PTC 模式把 native schema 压为 `run_code` 一个入口，但完整 visible tool SDK 会渲染进 system；SDK 投影还携带 output schema，原先工具 guidance 仍可能存在。因此不能把“API tools 数量从 N 到 1”算成首轮 token 节省。第一方 README 也明确不承诺普遍下降。[tools/src/index.ts:897](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:897)、[tools/src/index.ts:1017](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1017)、[tools/src/index.ts:1270](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1270)、[tools/README.md:203](C:/Works/PubProj/deepseek-harness/packages/core/tools/README.md:203)。

provider-neutral schema 有 `deferLoading`，DeepSeek adapter 序列化为 `defer_loading`。但这也用于 conversation 中后加工具的历史激活，不能仅凭字段存在就认定有默认 tool-search/discovery 策略；不支持 tool-update 的 route 会移除 defer 标志并立即提供工具。[llm/src/content.ts:381](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:381)、[llm/src/content.ts:424](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:424)、[llm-deepseek/src/serialize.ts:159](C:/Works/PubProj/deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts:159)。

推论：KodaX 应先消除不适用于当前能力集合的 schema 和重复 guidance，再考虑冷门扩展工具按需发现。PTC 适合减少中间工具结果/批次开销的假设，不能替代首轮 schema 裁减的验证。[tools/README.md:170](C:/Works/PubProj/deepseek-harness/packages/core/tools/README.md:170)、[tools/README.md:195](C:/Works/PubProj/deepseek-harness/packages/core/tools/README.md:195)。

## 5. 缓存友好与冷启动 token 缩减必须分开

稳定 instructions 在前，本地路径、端点、persona suffix 在后；runtime context 被单独组织。工具排序稳定有利于可重用 prefix，但不会减少相同文本的原始 token 数。[system-prompt/src/index.ts:131](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:131)、[system-prompt/src/index.ts:218](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:218)。

runtime context 与前一保留 snapshot 文本相同则不产生新消息；time-context 默认 600,000ms 才再次注入，作为 user message 加入历史，不在每个工具 step 重写 system 的当前时间。[agent-loop/src/runtime-context.ts:146](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:146)、[time-context/src/index.ts:132](C:/Works/PubProj/deepseek-harness/packages/context/time-context/src/index.ts:132)、[time-context/src/index.ts:185](C:/Works/PubProj/deepseek-harness/packages/context/time-context/src/index.ts:185)。

system 文本不变时不更新；支持 `in-history` 且同一 request series 内变化时，在已有历史后追加新 system，避免改写旧前缀。不支持的 route 或新 series 则整理首个 system node。工具历史更新同样按 provider capability 投影。此类协议能力不能假设所有 KodaX providers 都支持，也不能算作首次冷请求输入下降。[agent-loop/src/runtime-context.ts:57](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:57)、[llm/src/content.ts:424](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:424)。

## 对 KodaX 的可借鉴优先级（设计判断，尚未验证 KodaX 现状）

1. 先建立最终 provider 请求的组成账单，包含 schema 而不只 system 字符数；分别记录原始输入、cache read/write、首轮总调用数。依据是本实现明确分离多类 model-visible 来源，而不是某个单一大 prompt。[system-prompt/src/index.ts:120](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:120)。
2. 优先做无损去重和 scope 过滤：skill full text 按需、同作用域 AGENTS/CLAUDE 相同内容去重、只加载祖先指令链。不要默认删除用户规则，也不要把 64KiB 截断当作质量不变的优化。[tool-skill/src/index.ts:129](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:129)、[agent-instructions/src/files.ts:323](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/files.ts:323)、[agent-instructions/src/files.ts:421](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/files.ts:421)。
3. 再按当前实际可用能力发布工具和必要 guidance；从一开始就保持确定顺序。不能只过滤 schema 而留下要求调用该工具的独立 prompt section；第一方文档明确指出 schema restriction 并不会自动删除独立 section。[system-prompt/README.md:164](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/README.md:164)。
4. 将缓存优化另列验收目标：稳定 prefix、时间和目录变化上下文增量投影可降低重复成本；PTC 和 provider 特有 in-history updates 都放在真实必要性之后。[agent-loop/src/runtime-context.ts:57](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:57)、[tools/README.md:203](C:/Works/PubProj/deepseek-harness/packages/core/tools/README.md:203)。

## 未证实

- 未实测 standard/minimal/PTC 的首次请求 tokens、时延、缓存命中率、工具选择准确率或任务成功率；没有给出节省百分比。
- 未确认用户实际启动 profile、外挂 MCP、个人 skills、工作区 AGENTS 等组合。不能据此声称 deepseek-harness 的实际首轮一定比 KodaX 更少。
- 在所审阅默认路径没有发现按任务语义进行自动 top-k tool 选择；这不是对整个仓库所有可选扩展的不存在证明。

## 未解问题

- KodaX 当前首轮中 system、工具 schema、MCP、skills 目录、工作区指令、repo intelligence 各占多少？是否存在相同说明跨层重复？
- “首轮 token 较多”主要指第一条 provider 请求、第一整个用户 turn，还是未命中缓存的计费 tokens？不同目标会改变优化优先级。
- 若延迟加载工具，节省的 schema tokens 是否被额外发现往返抵消？需基于 KodaX 的真实任务与 provider 验证。
- 对嵌套 AGENTS，KodaX 是否需要确保写入前读到规则，并覆盖 shell/PTC 路径？本实现的事后文件触碰机制不能直接当成该保证。
