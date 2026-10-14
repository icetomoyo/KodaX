# deepseek-harness 有哪些 prompt、工具和运行时上下文注入模式？

结论摘要：当前 DSH 的“注入模式”分属多个独立维度，远不止 native/PTC：system section 与 user-context、完整 persona 覆盖与 required context、skills 的目录/模型工具加载/用户显式注入、inbox 的唤醒策略、post-tool 延迟上下文、provider 的 system/tool 历史更新协议。不要把它们合成一个未经源码支持的 `off/sys/tool/injected/deferred` 配置枚举。对 KodaX 最有价值的组合是：短而稳定的基础规则、按实际能力给 schema、按触发时机给上下文、显式技能直接加载、普通技能按需读正文、变化信息去重且持久化；provider 特有的历史增量协议作为可选适配。

## 证据与本轮纠正

本地源：`C:/Works/PubProj/deepseek-harness`；HEAD `d743267388641bc76f17c45ce8b4c231aed1d32c`；日期 2026-10-14。本文相对路径和行号均属于该 commit。只读源码与第一方测试，没有调用模型，没有运行 eval，也没有把“测试用例存在”写成“本轮已跑过”。

对上一轮笔记的纠正：`includeRuntimeContext: false` 只抑制可选 runtime contexts，**仍保留 `required: true` 的上下文**。working-directory 就是 required，因此 minimal preset 也不能简单描述为“没有运行时上下文”。源码直接筛选 required，并有测试确认 suppression 不会运行 optional provider，同时仍保留 cwd 类内容。[system-prompt/src/index.ts:578](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:578)、[working-directory/src/index.ts:90](C:/Works/PubProj/deepseek-harness/packages/session/working-directory/src/index.ts:90)、[system-prompt.spec.ts:35](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/tests/system-prompt.spec.ts:35)。

## 1. 真正存在的配置轴与 API

| 机制 | 真实配置/API | 默认或启用条件 | 注入位置与时机 | 对成本的影响（静态推论） |
|---|---|---|---|---|
| 普通系统规则 | `systemPrompt.section({name, order, text, interpolate})` | 被插件注册才有；text 可按 scope 返回空 | 每次 assembly 产生有序 sections，记录为 system-role；空 section 丢弃 | 基础首轮成本；稳定内容有利于前缀复用 |
| 完整 persona | section `complete: true`；persona `complete` 默认 false | 明确开启；多个有效 complete 会报错 | waterfall 仍处理工具/contexts，但其最终 system sections 被恢复为唯一 complete section | 真正削减 system 内容，但不能推导 schema 或 required context 被关闭 |
| 动态运行时 context | `systemPrompt.context({name,order,text,required})` | `includeRuntimeContext` 默认 true | pre-step 提议、request admission 刷新；形成 user-role runtime snapshot | 变化时才追加，避免每步重写 system；历史仍增长 |
| 关闭可选 runtime context | `includeRuntimeContext: false` 或 `suppressRuntimeContext()` | opt-in；required 永远保留 | assembly/admission 丢弃可选项，包括 waterfall 添加的无注册项 | 删去可选信息，不能牺牲执行必要事实 |
| 原生工具 | tools `mode: 'native'` | 默认 native | 请求的独立 tools 字段：所有当前 scope visible tools | 完整 schema 成本；按 scope 限制才会移除 schema |
| PTC 工具 | tools `mode: 'ptc'` | 明确选择且有 PTC runtime | native tools 只保留 `run_code`，完整 SDK 进入 system section | 转换表示，不承诺缩小首轮；更有利于压缩任务中间结果 |
| 工具协议延迟激活 | schema `deferLoading: true` | 工具显式标记或历史后加工具生成 | 支持的 provider 以 tool addition 激活；不是通用工具发现策略 | 取决于 provider 协议，不等于客户端不传 schema |
| 技能可调用性 | `disable-model-invocation`、`user-invocable` frontmatter | 模型/用户两者默认可调用 | 控制目录、模型加载器、显式手势入口 | 可消除本不应自动选择的 skill 目录成本 |

表中逐项来源：[PromptSection/PromptContext 类型:52](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:52)、[persona 配置默认:49](C:/Works/PubProj/deepseek-harness/packages/preset/persona/src/index.ts:49)、[完整 section assembly:648](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:648)、[runtime refresh:578](C:/Works/PubProj/deepseek-harness/packages/core/system-prompt/src/index.ts:578)、[native 默认:849](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:849)、[wireSchemas:1017](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1017)、[SDK section:897](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:897)、[deferred 投影:381](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:381)、[skill invocation 默认:1008](C:/Works/PubProj/deepseek-harness/packages/skill/skill-filesystem/src/index.ts:1008)。

这不是可互换的 mode 列表：比如 complete persona 与 PTC 可以涉及不同轴；`form: 'instructions'` 也不是 system-role。当前检索到的类型定义没有一个统一 `sys/tool/off` 注入枚举。Cordis `inject: ['service']` 是插件依赖注入，不代表发送给模型；例如 MCP 插件等到 systemPrompt 服务可用后才注册一个真实 section。[mcp-client/src/server-context.ts:28](C:/Works/PubProj/deepseek-harness/packages/mcp/mcp-client/src/server-context.ts:28)。

## 2. Tool description、system guidance 与动态能力是分开的

`read` 的短 description 是“读 UTF-8 文件并返回行号”；跨调用行为要求“用 read 而非 cat，分段使用 offset/limit”放在 system section。该 section 查询当前 scope 的工具可见性，看不见 read 时返回空。Bash 也将跨调用“检查退出码”放在独立 section。因此合理方向是语义分工、随能力裁剪，而不是机械把所有 description 移到 system 或把全部规则塞进工具 JSON。[read.ts:68](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs/src/read.ts:68)、[tool-bash/src/index.ts:250](C:/Works/PubProj/deepseek-harness/packages/shell/tool-bash/src/index.ts:250)。

scope 过滤不是“用户请求语义 top-k”，而是实际 agent 工具可见范围；native `wireSchemas` 直接遍历 visible definitions。并非每个独立 section 都自动跟随工具过滤，owner 必须像 read 一样实现条件。MCP server instructions 也是独立 system section，禁止模板插值，跟随 connection 返回的文本变化；scope 归属由注册 scope 决定。[tools/src/index.ts:1017](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1017)、[mcp-client/src/server-context.ts:28](C:/Works/PubProj/deepseek-harness/packages/mcp/mcp-client/src/server-context.ts:28)、[server-context.spec.ts:44](C:/Works/PubProj/deepseek-harness/packages/mcp/mcp-client/tests/server-context.spec.ts:44)。

plan-mode 使用另一种成本取舍：仅 active 时增加 `plan:policy` section，工具目录保持稳定，降低切换工具集合对缓存的影响；这有意保留 schema 成本，而不是优化最小首轮。其配置也明确说明 mutation tools 保留只是为了稳定目录，plan 指导本身不是执行权限控制。[plan-mode/src/index.ts:216](C:/Works/PubProj/deepseek-harness/packages/plan/plan-mode/src/index.ts:216)、[standard.patch.yml:59](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:59)。

persistent shell 允许覆盖 `description`，minimal preset 直接把精简使用说明放在 shell description 中；这是某个工具配置，不是通用 `descriptionMode`。[tool-bash-persistent/src/index.ts:444](C:/Works/PubProj/deepseek-harness/packages/shell/tool-bash-persistent/src/index.ts:444)、[minimal.patch.yml:35](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/minimal.patch.yml:35)。

## 3. Skills 有三个不同注入路径

### 3.1 目录先行

model-invocable skill 的 name/description 列表在首次 pre-step 注入 user-role catalog，包装为 `<system-reminder>`。description 默认最多 500 字符，空白规范化。目录 digest 与可见历史一致则不追加；body-only 更新不重发目录，正文加载时读取最新版；compaction 隐藏目录后会重新建立。目录仅在对应 skill 工具可见时发布，完整目录没有总字符上限。[tool-skill/src/index.ts:215](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:215)、[tool-skill/src/index.ts:256](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:256)、[tool-skill/src/index.ts:393](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:393)、[tool-skill.spec.ts:631](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:631)、[tool-skill.spec.ts:660](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:660)。

### 3.2 模型主动调用工具

模型决定匹配 skill 后调用 `skill(name)`，校验 modelInvocable、取正文和资源定位，再由 tool result 返回。首条请求不用带正文，但任务可能多一个模型↔工具往返；如果任务确实必须使用该 skill，延迟并不会永久省去正文。[tool-skill/src/index.ts:129](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:129)、[tool-skill.spec.ts:804](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:804)。

### 3.3 用户显式手势直接注入

用户文本中的合法 `/skill-name` 手势触发 host pre-step 确定性加载，追加 `<skill_content>` user-role instructions，位置在背景注入之后、靠近模型回答。只扫描 source.kind=user；未知名和 user-disabled skill 保留为普通文字；重复手势会去重。即使 disable-model-invocation=true，只要 userInvocable 仍为 true，也可从该入口加载，无须先暴露于模型目录。[tool-skill/src/index.ts:165](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:165)、[tool-skill.spec.ts:1022](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:1022)、[tool-skill.spec.ts:1052](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:1052)、[tool-skill.spec.ts:1085](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:1085)。

成本推论：显式选择已消除“不知道需不需要技能”的不确定性，直接注入增加首条请求输入，却可能减少整个任务的总调用数与时延。因此“所有技能永远 lazy”不是最合理策略；应区分用户确定选择与模型自主发现。该推论依据上述两条执行路径，并非实测收益。

## 4. 上下文形式不是 role，也不自动压缩历史

DSH 定义六个真实 `ContextForm`：`instructions`、`catalog`、`snapshot`、`notice`、`relay`、`recall`。`kind` 指生产者，`form` 指信息语义，两者与 role 独立。未声明 form 仍有效。snapshot 的“新状态覆盖旧状态”是语义声明，不意味着旧消息自动从每个请求删除。[llm/src/message.ts:39](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/message.ts:39)。

| 形式/producer | 触发与位置 | 去重/持久化 | 成本关注点 |
|---|---|---|---|
| runtime-context / snapshot | pre-step 在已 claim 用户批次后追加；admission 再刷新 | 与最新保留文本相同不追加；user/message durable append | 不改写 system 前缀，但状态变多仍增长历史 |
| agent-instructions / instructions | 首轮 global + root→cwd；read/write/edit 文件触碰后刷新嵌套规则 | 同候选组内容去重，baseline/变更持久化 | 降低首轮递归预载；不能保证 shell 修改前已读嵌套规则 |
| time-context / snapshot | eligible pre-step 后置 user message | 默认十分钟节流；0 为每 eligible step；旧 readings 保留 | 时间持续变化不能仅文本去重；每步模式会累积成本 |
| tmux-context / snapshot | 仅每 turn 的 step=1，前置该批消息 | 无有效 tmux 不注入；状态未变不注入；可配置刷新间隔 | 属于条件环境事实；不应每步发送 |
| repeat-tool-reminder / notice | 相同调用重复命中阈值后，post-execute additionalContexts | per-agent 链，默认阈值 3/5；新用户输入重置 | 首轮零成本；仅行为异常时提醒，可能避免后续重复浪费 |
| session-reference / recall | 用户引用其他 session 后构造有界材料 | 创建 user-role 附加上下文，记录来源截点与省略统计 | 按需增加大块资料，不能把所有历史当默认启动信息 |
| subagent / relay、notice | 子代理通信或状态变更 | 消息记录生产者与语义 | 与首轮基础 prompt 无关，按真实事件付费 |

逐行来源：[agent preStep:267](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/agent.ts:267)、[runtime-context:146](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:146)、[agent-instructions:76](C:/Works/PubProj/deepseek-harness/packages/context/agent-instructions/src/index.ts:76)、[time-context:185](C:/Works/PubProj/deepseek-harness/packages/context/time-context/src/index.ts:185)、[time-context 默认:132](C:/Works/PubProj/deepseek-harness/packages/context/time-context/src/index.ts:132)、[tmux-context:246](C:/Works/PubProj/deepseek-harness/packages/context/tmux-context/src/index.ts:246)、[repeat-tool-reminder:196](C:/Works/PubProj/deepseek-harness/packages/guard/repeat-tool-reminder/src/index.ts:196)、[默认阈值测试:64](C:/Works/PubProj/deepseek-harness/packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts:64)、[session-reference:329](C:/Works/PubProj/deepseek-harness/packages/context/session-reference/src/index.ts:329)、[continuation-messages:17](C:/Works/PubProj/deepseek-harness/packages/subagent/subagent/src/continuation-messages.ts:17)。

第一方 time-context 集成测试明确检查第二个请求同时含 step 1 和 step 2 reading，而 system header 不变。这是“稳定前缀、历史累积”的直接证据，不是覆盖旧 reading 的实现。[time-context.spec.ts:473](C:/Works/PubProj/deepseek-harness/packages/context/time-context/tests/time-context.spec.ts:473)。

`<system-reminder>` 只是生产者控制的文本包装，不会把 user 消息变成 system 或 developer。Session 不统一替其加框；这要求 KodaX 设计时把内容权威、生产者和 provider role 明确区分。[session/src/surface.ts:130](C:/Works/PubProj/deepseek-harness/packages/core/session/src/surface.ts:130)、[tool-skill/src/index.ts:256](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:256)。

## 5. 注入调度：inject、steer、followup、post-tool deferred

`inject` 将 user-role context 放到 next-step inbox，但不唤醒 idle agent；`steer` 同样进 next-step，但可唤醒；`followup` 进入 next-turn 并唤醒，作为独立普通 turn。inbox splice 本身持久化，claim 时 next-step 输入在 queued turn 前。此处决定何时产生下一次模型调用，与内容是否在 system 内是独立问题。[runtime-types.ts:211](C:/Works/PubProj/deepseek-harness/packages/core/agent/src/runtime-types.ts:211)、[agent.ts:154](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/agent.ts:154)、[inbox.ts:24](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/inbox.ts:24)、[inbox.ts:116](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/inbox.ts:116)。

工具执行期间 `deferContext()` 收集 user-message context，和 post-execute `additionalContexts` 一起，在 tool result 提交后交给 loop 的后续 step。PTC 内层也沿外层传递，避免把额外 user 文本插进未闭合的 tool-call/result 批次；外层 post-execute block 会丢弃工具主体 deferred context，仅保留阻止决策明确附带的 context。[tools/src/index.ts:1425](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1425)、[tools/src/index.ts:1777](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/index.ts:1777)、[tool-calls.ts:146](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:146)、[tools/src/ptc.ts:645](C:/Works/PubProj/deepseek-harness/packages/core/tools/src/ptc.ts:645)。

因此至少有两种完全不同的 deferred：**延迟上下文到工具批次后**与**延迟激活工具 schema**。前者是对话结构/调度，后者是 provider 协议能力，不能混称“lazy tool 注入”。上述 API 本身不提供按内容通用去重；去重由 runtime snapshot、skill catalog、AGENTS 等生产者负责。[runtime-context.ts:152](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:152)、[tool-skill/src/index.ts:233](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:233)、[inbox.ts:127](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/inbox.ts:127)。

## 6. Provider 的历史更新矩阵

| 模式 | 支持条件与语义 | 无支持时行为 | 首轮/整个任务取舍 |
|---|---|---|---|
| `systemPromptUpdate: 'in-history'` | 同一 request series 下 prompt 变更追加为后面的 system node，不重写旧前缀；不变则零更新 | 将有效 prompt 整理回首个 system node，后面的旧 system 清空；新 series 也整理 | 不减少首次 system；可能保留更多可缓存历史，但追加后 prompt 历史更大 |
| `toolUpdate: 'in-history'` | 工具增加/移除放 developer 历史；保留历史定义，later addition 标 deferred | 当前完整目录，无 developer updates | 有效维护历史可见状态；需要 provider 原生支持增删 |
| `toolUpdate: 'addition-only'` | 支持新增，不支持历史移除；仅保留当前 active names 的定义，忽略 removal blocks | 同上 | 添加可用历史协议，删除仍可能改变定义集合/缓存 |
| baseline `deferLoading: true` | 首次声明暂不激活；首次保留 addition 激活，重复 addition 抑制 | 去掉 deferLoading，立即提供该工具 | “声明已发送”与“可调用已激活”分开；没有跨 provider 通用省 token 保证 |

源码：[runtime-context.ts:57](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts:57)、[llm/src/content.ts:381](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:381)、[llm/src/content.ts:424](C:/Works/PubProj/deepseek-harness/packages/llm/llm/src/content.ts:424)。测试直接覆盖 unsupported route 剥离 deferred 标志、两种 route 激活 deferred baseline、in-history 保留移除定义、addition-only 去掉移除定义。[content.spec.ts:421](C:/Works/PubProj/deepseek-harness/packages/llm/llm/tests/content.spec.ts:421)、[content.spec.ts:433](C:/Works/PubProj/deepseek-harness/packages/llm/llm/tests/content.spec.ts:433)、[content.spec.ts:477](C:/Works/PubProj/deepseek-harness/packages/llm/llm/tests/content.spec.ts:477)、[content.spec.ts:493](C:/Works/PubProj/deepseek-harness/packages/llm/llm/tests/content.spec.ts:493)。

DSH 的当前 DeepSeek 默认目录只给 `deepseek-flash` 标记 system in-history + tool addition-only；`deepseek-v4-pro` 条目未声明这两项。因此不能笼统说“所有 DeepSeek 模型都支持”。这只是本地 catalog 的契约，不是本轮对远端产品能力的实测。[llm-deepseek/src/models.ts:6](C:/Works/PubProj/deepseek-harness/packages/llm/llm-deepseek/src/models.ts:6)。

pi-ai adapter 先检查精确 model.compat 的 `supportsMidConvoSystemMessages`，再按 API 和 compat 决定 tool update：anthropic-messages + supportsMidConvoToolChanges → in-history；openai-completions + supportsMidConvoToolAdditions → addition-only；Responses 系列 + supportsAdditionalTools 或 supportsToolSearch → addition-only。仅 provider 名称不是充分条件。[llm-pi-ai/src/models.ts:75](C:/Works/PubProj/deepseek-harness/packages/llm/llm-pi-ai/src/models.ts:75)、[conversation-updates.spec.ts:28](C:/Works/PubProj/deepseek-harness/packages/llm/llm-pi-ai/tests/conversation-updates.spec.ts:28)。

实际 wire role 也不能照抄逻辑历史：DeepSeek 将 developer tools updates 映射为 system-role tool_addition/tool_removal，放在先前 user/tool-result 之后；pi-ai adapter 将 developer event 映射为带 toolsAdded/toolsRemoved 的 system message。DSH 的通用 developer 数据模型不表示每个远端接受相同 developer payload。[llm-deepseek/src/serialize.ts:89](C:/Works/PubProj/deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts:89)、[llm-pi-ai/src/context.ts:170](C:/Works/PubProj/deepseek-harness/packages/llm/llm-pi-ai/src/context.ts:170)。

## 7. 适合 KodaX 多 provider 的机制建议

以下为设计判断，不是已验证的 KodaX 修改方案；所依据的机制见前述源码。

1. **先分开三件事：放哪里、何时放、是否需要模型额外发现。** 稳定安全/行为规则放基础 system；当前工作目录等必要事实作为明确 runtime context；只有出现触发事件才给重复调用提醒/新路径指令。工具短 description 与跨工具工作原则分别去重，避免同时写两遍同一条长说明。DSH 的 section/context 与 post-tool 机制提供这种分离，但 KodaX 无须复制 Cordis 注册架构。
2. **显式 skill 用确定性注入，自主匹配用目录+加载器。** 用户已选的技能无须再强制模型先调用读取工具；用户未选时保持短目录，正文按需。模型禁用与用户禁用是两种不同控制。验收要同时看第一请求 token 和整个 user turn 总调用数。
3. **通用上下文增量先做，特殊 wire updates 后做。** 所有 provider 可先复用“已持久化、未变化不重复追加”的生产者逻辑；system/tool in-history 严格按具体 model capability opt-in，并做无能力 fallback。不要因为上游有 deferred 字段就让其他 provider 丢失核心工具。
4. **有限制、可定位来源，但不要静默丢规则。** AGENTS 同作用域去重和祖先链发现可直接作为思路；过预算需要显式诊断。保留 cwd 等执行必要信息。嵌套目录规则要在执行前可用，特别覆盖 shell 路径；不能只照搬 read/write/edit 成功后的触碰机制。
5. **不用一个“优化级别”切换所有维度。** 若当前产品只需默认 coding 体验，采用内部确定策略即可。完整 persona、PTC、skills catalog 开关、provider 协议能力各自解决不同问题，堆成用户可选模式矩阵反而增加成本与回归面。
6. **验收覆盖历史演进。** 冷启动、第二步未变化、skill 显式/自主加载、工具增加/移除、切换 provider、恢复/compaction 后目录重建都需检查最终 wire 请求。第一方已展示这些边界值得关注，不能只检查首次 prompt 字符数。[system-prompt-projection.spec.ts:156](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/tests/system-prompt-projection.spec.ts:156)、[system-prompt-admission.spec.ts:360](C:/Works/PubProj/deepseek-harness/packages/core/agent-loop/tests/system-prompt-admission.spec.ts:360)、[tool-skill.spec.ts:631](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/tests/tool-skill.spec.ts:631)。

## 未证实与未解问题

- 未在当前 tracked source 中定位到一个统一的 `injected/deferred/off/tool/sys/reminder` 配置类型。本文列的是可确认的真实轴与 API；如果用户指的是其他分支/旧版本/外挂插件，需要给出其路径或版本再比对，不能从词语相似推断该功能存在。
- 没有运行第一方测试、模型或 tokenizer，没有真实缓存命中率/节省比例。本文的首轮与全任务成本取舍是执行路径推论。
- DSH 当前 schema deferred 激活不是通用 tool-search 产品策略；Responses compat 的 supportsToolSearch 只用于确认协议能力，未证明 standard preset 自动做语义工具检索。
- KodaX 最终采用 user/developer/system 哪个 role 应结合现有 provider adapter 的忠实映射和权限语义；文本 `<system-reminder>` 自身不赋予高优先级。
- 需要 KodaX 实际请求分项证据判断最大成本来自内建 prompt、扩展 schema、skills 目录还是工作区上下文。本文不替代这份账单，也不承诺删除某类内容不会增加后续工具往返。
