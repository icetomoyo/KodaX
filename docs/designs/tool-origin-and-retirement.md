# 工具开发契机、当前增量价值与退役边界

2026-10-24。**离线调查与取舍建议；未删除工具、未改变 AMA 或默认注入，未新增模型调用。**

结论：应把“工具提供了什么独有能力”与“模型某次能否完美完成调查”分开。local `code_search` 没有实现历史教学所称的相关性排名；原有证据记录收益也已被通用搜索共享。它仍是优先退出普通 root 默认菜单的候选，但 provider、SDK、角色、历史回执和长字面量兼容不能一起删除。一个 Kimi 未收尾样本既不证明这项能力不可替代，也不能被忽略或改判成功。

本页补充 [78 项全量工具审计](tool-necessity-comparison.md) 的历史与因果证据，配套 [完整设计及 r1/r2 评测](tool-mode-design.md)。本页建议不是已经完成的默认切换。

> 后续整体取舍以 [全盘工具与注入方案](tool-portfolio-plan.md) 为准；下文保留历史证据及分阶段实施记录。

## 现有轨迹：能确定什么，不能确定什么

固定版本：KodaX `8d3f05e0db20df6ce9c07a0130e5c55c041cc614` 加评测冻结工作区；参考 pi `136b87e8a7f5a3e5186de0289523ba327dc592fc` 的 `packages/tui` 125 文件。沿用 `unfamiliar-search-20261024-r1/r2` 全部 72 次历史调用；本次只读原始输入、工具回执和最终报告。

### 1. 已排除的执行链问题

- 对全部相邻输入逐项核对：下一请求恰为上一输入加真实 assistant 响应、真实工具结果，system 和工具数组每格不变；续跑没有遗漏证据、重置任务或注入答案。
- 72 次各有一个实际请求，无 provider 错误、工具错误、发现调用或未广告工具调用；没有 `max_tokens` 导致的截断。两菜单实际都只执行了 `grep/glob/read`。
- Kimi 候选第 12 次响应仍为 `tool_use`，没有最终报告。它不是“已经报告完又被 AMA Runtime 追加请求”。本实验由真实 Runtime 捕获首轮后运行受控 provider 对话，不是完整 AMA 收尾 E2E，不能据此诊断 AMA 终止策略。

来源：OS Temp `kodax-eval-dumps/unfamiliar-search-20261024-r2/offline-history-audit.json`、`whole-task-metrics.json`、各格 `controlled-completion.json`；执行链见 [eval driver](../../tests/deferred-repo-lsp.eval.ts) 与 [断点恢复](../../tests/first-turn-unfamiliar-search.ts)。正式结论所需事实已列于本页，raw 不入 Git。

### 2. Kimi：证据顺序和调查范围不同，不是发现工具失败

下表轮次指模型生成；其工具结果在下一次生成前返回。

| 证据/动作 | 原生菜单 | 隐藏入口候选 |
| --- | --- | --- |
| 完整 `stdin-buffer.ts` 480 行 | 第 2 次提出读取 | 第 2 次提出读取，回执完全相同 |
| 具体 Editor 的标记处理实现 | 第 4 次读 `editor.ts:700–769` | 第 6 次 grep；第 12 次才请求读 `editor.ts:696–775`，因总上限未执行 |
| 完整粘贴测试区域 | 第 6 次读 `stdin-buffer.test.ts:575–644` | 第 8 次读 `630–655`（Unicode 尾部和 destroy），第 11 次读 `608–621`；未整体读分块测试 `599–609` |
| 支线调查 | TUI 接线、退出恢复开关 | 先查 keys 辅助逻辑和 Editor 接口，再扩到 alt-screen 粘贴入口、terminal 专项测试 |
| 截止状态 | 12 次生成、20 工具，报告完成 | 12 次生成、24 工具，仍需查证，无最终报告 |

候选选择了更多“先 grep 再局部 read”的路径，并在关键测试正文尚不完整时扩展了旁支。它并非反复执行同一个失败调用；最后请求的 Editor 正文仍有实际补证价值。候选只有一个 editor-test grep 页提示，原生反而有更多分页/不完整提示；完整缓冲实现双方都拿到了，不能把主要差异归因于结果丢失或搜索无法访问。

**可支持的判断**：候选这条轨迹有取证顺序和收尾效率风险。**不能支持的判断**：删除 schema 导致了智能退化、一定只是随机波动、再多一轮必然完成。每模型/任务/菜单只有一条轨迹，没有控制采样随机性；菜单显著性可能影响选择，但当前证据无法识别其因果贡献。

### 3. GLM：错误发生在取得证据之后

粘贴任务两边收到同一个 17,353 字节 `stdin-buffer.ts` 全文回执，SHA256 为 `ecebfe5bf17e8a5be8660de5069e98a2ce774eb0179d03fb9ffaec7a1f14b360`，其中普通路径的 `setTimeout` 完整存在。候选未说明拆开的开始标记有超时窗口；原生更明确地误称不完整 ESC 不会 flush。不能将此解释为隐藏 `code_search` 后缺少源码。

零模型调用的独立探针直接转译该固定源码、注入确定性 timer 回调，未修改源码：

| 输入 | 实际结果 |
| --- | --- |
| `ESC[20` 后在窗口内到达 `0~helloESC[201~` | 聚合出 `paste("hello")` |
| `ESC[20` 后触发普通 50ms timer，再到达剩余部分 | 前缀已 flush，不再组成这次 paste |
| 已进入 pasteMode，结束标记只到 `ESC[20` | 不创建普通 timer；补 `1~x` 后发 paste，再把 `x` 作为普通输入 |

因此需区分**进入 pasteMode 之前的半个开始标记**和**pasteMode 内的半个结束标记**。这是共有的代码理解/报告限定问题，不是已证实的工具精简损害。现有测试覆盖正文分块，并不直接覆盖两种标记都被拆开的全部情形。grep 回执确实包含 editor 的处理注释和阈值，不能因没有整函数 read 就指控模型捏造该部分。

来源：固定 pi `src/stdin-buffer.ts:23–26,348–431`、`test/stdin-buffer.test.ts:588–632`；OS Temp r2 `offline-paste-timer-probe.json`、`trajectory-diagnosis.json`。探针使用真实算法与确定性时钟，不代表新增了原项目已有测试。

### 4. 评测设计应承担的责任

五个概念阶段不等于五次生成；r1 对所有格的共同截断过低。r2 的有限续跑使七格完成，但“一次定位调查”同时包含搜索、流程推理、测试覆盖判断与报告准确性，不能把其中任何错误机械归因于搜索入口。双方提示本来就优先 grep/glob，故该实验没有证明 code_search 的独占收益，也不能证明其永远没有帮助。[当前教学](../../packages/coding/src/agents/worker-role-prompt.ts:282)

不再加预算追求全票通过，不强制末轮报告，不改 AMA 规划/派发。以能力与依赖证据决定退役方向，以真实任务观察回退；保留 Kimi 未完成、GLM 错误和开放标签续跑限制，不把它们改判成功，也不把共有语义错误变成永久保留重复工具的理由。

## 搜索、编辑和仓库工具的开发契机

| 工具 | 引入与当时收益 | 今天的判断与边界 |
| --- | --- | --- |
| local `code_search` | `ba5ae92a`，2026-04-03：统一 retrieval substrate、locator/snippet/trust/freshness、durable anchors；同时提供路径/内容字面匹配 | 便利存在，但没有相关性排序。grep/glob/read 覆盖普通定位，grep 共享压缩证据记录；优先退出普通 root 默认菜单候选。长字面量及 provider/SDK 兼容另留，不直接删后端 |
| `insert_after_anchor` | `c2657091`，2026-04-04：安全编辑锚点及失败恢复，避免因 edit 失败退回整文件覆写 | 引用不是独立价值证据。500 行追加已由一次原有 edit 批量调用覆盖，见下方离线验证；普通恢复教学可迁移。外部改动后的新鲜度语义另行处理，不用放松 edit 校验换取少一次读取 |
| `repo_overview` | `fa75092f`，2026-03-28，FEATURE_018/027/028：持久增量索引的低成本仓库概览 | 自动上下文与手动查询可重复，优先去重复读取；内部 overview 服务仍有用，不因旧多阶段角色退役而删服务 |
| `changed_scope` | 同上：结构化 Git 改动范围与仓库分区 | Git 可取得信息源；独立入口主要是便利。按 review 需要呈现，未找到证明普遍优于现有工具的全任务基准 |
| `changed_diff` / bundle | `20594e10`，2026-03-28，FEATURE_044：大型 review 的分页、多路径与 untracked 补丁 | `changed_diff.paths` 已覆盖 bundle，旧别名已退出默认目录；保分页/未跟踪语义，不重复计算节省 |
| `module_context` | 初始 RepoIntel 六工具：聚合模块依赖、symbols、tests/docs/entry | 部分可手工组合，聚合索引价值仍存在；普通 root 按需候选，SDK/专业角色与 AMA 内部服务保留 |
| `symbol_context` | 初始 RepoIntel：符号定义、signature、调用关系与 alternatives | 与 LSP 部分重叠，非纯文本搜索；有精度/新鲜度限制，不能直接认作 grep 别名 |
| `process_context` | 初始 RepoIntel：入口和有限执行步骤线索 | 静态启发式，不是真实运行轨迹；低频按需，不承诺动态调用完整性 |
| `impact_estimate` | 初始 RepoIntel：目标、callers、改动范围与风险线索 | 与 module/symbol 同源但输出目的更窄；聚合入口未覆盖所有字段，不能未经验证删掉 |
| `semantic_lookup` | 与 retrieval substrate 同批引入；当前查询索引实体 | exact/prefix/includes/all-word 有真实评分，返回 symbol/module/process 元数据；不是 embedding。保结构查询，校准“概念搜索”教学 |
| `cyclic_dependencies` | `e4c05f82`，2026-05-31，FEATURE_205-A：补充一跳查询不能回答的环检测 | Tarjan SCC 有独立算法价值。当前 SCC 顺序闭合不保证每条边构成真实环，应先校准/修复见证，不删算法 |
| `relationship_scan` | `51fb53d3`，2026-06-26：用 upstream/downstream 聚合四项 Repo、LSP、文本证据，减少选工具成本 | 聚合便利真实；并非新多跳图算法，也未完整覆盖四个窄 capsule。按任务保留，不强行取代四项 |

源码核对：[local 搜索](../../packages/coding/src/tools/code-search.ts:87)、[retrieval 只渲染](../../packages/coding/src/tools/retrieval.ts:308)、[grep/code_search 共用 ledger](../../packages/agent/src/session-lineage/compaction/file-tracker.ts:343)、[编辑恢复](../../packages/coding/src/agent-runtime/middleware/edit-recovery.ts)、[AMA 内部 Repo 服务](../../packages/coding/src/task-engine/_internal/managed-task/repo-intelligence.ts)、[结构查询评分](../../packages/coding/src/repo-intelligence/semantic-lookup-query.ts)、[SCC 输出](../../packages/coding/src/repo-intelligence/cyclic-deps.ts:81)、[聚合工具](../../packages/coding/src/tools/relationship-scan.ts)。历史理由见相应提交和 [v0.7.10](../features/v0.7.10.md)、[v0.7.45](../features/v0.7.45.md)、[v0.7.57](../features/v0.7.57.md)。

### code_search 历史收益判断需要纠偏

FEATURE_250 的记录与 [adoption driver](../../tests/deferred-tool-hard-case-teaching.eval.ts:140) 曾将 local code_search 教成 ranked/noise-filtered，并将选择 `code_search/semantic_lookup/tool_search` 计为 adoption。该实验未执行搜索、未比较最终正确性，不能证明其排名算法存在或任务优于 grep。原始实现从 `ba5ae92a` 起就是 `includes` 加固定 score，排序的是候选文件路径。历史实验保留，但不再作为“必须保留本地独立工具”的效能依据。[历史记录](../features/v0.7.60.md:279)

真实残余差异不能隐去：local 支持超过 grep 正则 256 字符上限的字面查询，能一并返回路径和内容；shell `rg -F` 可以覆盖部分边界，但其安装与跨平台调用未经本轮验证。`provider_id` 是 extension `provider.search` 契约，不能与 local 后端一起否定。[grep 限制](../../packages/coding/src/tools/grep.ts:8)、[扩展委托](../../packages/coding/src/extensions/runtime.ts:765)

永久删名字还需处理 SDK 导出、repo-explorer 白名单、read 能力分类、只读工具计数、同名 MCP fallback、compaction 历史回执和显示/结果策略。当前未找到内部算法必须调用 `toolCodeSearch` 创建记忆；这不等于外部 SDK 没消费者。模型菜单投影与执行注册表必须分开。[SDK](../../packages/coding/src/tools/index.ts:88)、[角色](../../packages/coding/src/construction/builtin-agents.ts:25)、[菜单装配](../../packages/coding/src/agent-runtime/tool-resolution.ts)

## 与参考项目的对应关系

固定本地源码：Codex `970111f6cb62cc02fe36a82ea7d71b37a2889c97`；DSH `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；pi 同上。本次未联网更新或声称这些是远端最新版本。

- Codex core 使用 shell exec/write_stdin、apply_patch、MCP/扩展组合。它没有这组同名 Repo capsule，不等于用户不能做仓库分析。[spec_plan.rs](C:/Works/PubProj/codex/codex-rs/core/src/tools/spec_plan.rs:1241)
- DSH Standard 有 grep/glob，fs-search 打包 `@vscode/ripgrep` 并用 argv 调用；不要求模型把每个搜索都写成平台 shell 命令。KodaX 优先复用 Node grep/glob/read 与此方向一致。[Standard preset](C:/Works/PubProj/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml:21)、[fs-search](C:/Works/PubProj/deepseek-harness/packages/fs/tool-fs-search/src/index.ts:1)
- DSH 可选 `str_replace_editor` 有按行 insert，但不是 KodaX 唯一锚点语义，也不是 Standard 必带的工具。[实现](C:/Works/PubProj/deepseek-harness/packages/fs/tool-str-replace-editor/src/index.ts:430)
- pi 的工具集合提供 read/bash/powershell/edit/write/grep/find/ls，不需要独立 local code_search 名字；集合可用不等于每项默认启用。[工具集合](C:/Works/PubProj/pi/packages/coding-agent/src/core/tools/index.ts:96)

另一个过期前提：当前 RepoIntel 已内置 full/light；旧 premium/oss/独立 daemon 控制不再决定运行行为。不能继续按“社区版没有这些能力”判断是否曝光，应看真实 mode/host/capability。[当前契约](../REPOINTEL.md:3)

## 其他差异工具：历史问题是否仍然存在

| 工具族 | 开发契机与可核对历史 | 当前收益与处理建议 |
| --- | --- | --- |
| Todo 三项 | `9e73ac53`（2026-05-04）解决长任务进度黑箱；`54324aa4`（2026-05-16）解决中途新增只能 init 重置全表、又被提示禁止重置的矛盾 | 安全追加、稳定 ID、PATCH、hooks 仍有价值；不退回整表覆盖。读取/专参可按需，不能影响 AMA 的 fullTodo 教学。见 [v0.7.41](../features/v0.7.41.md:1075)、[store](../../packages/coding/src/task-engine/todo-store.ts:361) |
| Goal 三项 | `2c50c580`（2026-05-25）借鉴 Codex /goal，提供长期目标与跨轮继续 | 不是 KodaX 独有重复。v0.7.74 曾测三项延迟净省仅约 109 估算 token，get_goal hint 反增 12 而撤回；先不动授权、预算及生命周期。见 [引入](../features/v0.7.44.md:9)、[撤回记录](../features/v0.7.74.md:251) |
| Actor 协作 | `c34260aa`（2026-07-17）统一持久 Actor/Turn；F273 修复普通进展唤醒父 Agent、反复读取 output 和大上下文请求 | 保 mailbox、wait、send/followup 的不同唤醒语义；不能用轮询替代。历史会话有 93.9/38.5 秒进度唤醒记录。见 [ADR055](../ADR.md:4977)、[F273](../features/v0.7.74.md:80) |
| `agent_output` | Actor/Turn 精确有界结果、structured output、artifact 元数据恢复 | 正常完成摘要已由 mailbox 交付，独立 getter 可按需；旧 Turn/WorkflowOutcome 等仍有消费者，不能删能力。见 [handler](../../packages/coding/src/tools/agent-collaboration.ts:336)、[Workflow](../../packages/coding/src/tools/run-workflow.ts:60) |
| `list_dispatchable_agents` | `4ba33751`（2026-07-10）外部 executor plane，列可派发角色、协议、能力及配置版本 | 与列现存 Actor 的 list_agents 不同；目录读取按需候选，保派发策略和执行器准入。见 [目录实现](../../packages/coding/src/tools/list-dispatchable-agents.ts:45) |
| `skill` | `557ae437`（2026-05-20）记录贴图误匹配 browser skill、直接读取后执行错误 shell 路径；改为具名调用/变量展开 | 当前还承担 learned admission、session binding、disableModelInvocation、动态 context 权限；不是 read 别名。保能力，按实际 registry 装配。见 [当前实现](../../packages/coding/src/tools/skill.ts:41) |
| `kodax_manual` | `862b80b8`（2026-06-08）针对把 KodaX 当成 Claude/Codex 回答；后支持 SDK 白标知识 | 版本及 SDK 知识仍有价值，独立常驻入口必要性较弱；资源化/现有发现候选，不能改读工作区 README 冒充产品手册。见 [F218/F221](../features/v0.7.47.md:13)、[manual](../../packages/coding/src/tools/manual.ts:13) |
| History 搜索/读取 | `6debae56`（2026-07-22）压缩后恢复精确信息 | session scope、entry/version/chunk、system 内容限制有独立职责；读取面可按需，不用任意 session 文件 read 绕过权限。见 [实现](../../packages/coding/src/tools/session-history.ts:20) |
| Memory recall/intent | `1dbea5e1`（2026-07-12）召回；`b6b062d2`（2026-07-29）治理意图 | recall 按需候选；intent 已聚合八操作，绑定用户 Turn、引用、revision，不等价写 MEMORY.md。工具 schema 与后台辅助模型费用分开。见 [治理](../../packages/coding/src/tools/memory-intent.ts:392)、[召回](../../packages/coding/src/tools/memory-recall.ts:53) |
| `undo` | 当前路径追到 `d0c63dcc`（2026-02-18）重构；最初引入理由未证实 | 可信 preimage 与本次修改前的未提交内容有真实恢复价值，git restore HEAD 不等价。保底层恢复；不猜作者最初意图。见 [实现](../../packages/coding/src/tools/undo.ts:21) |
| Worktree 创建/移除 | `0c25f780`（2026-04-12），FEATURE_068：从 hook 升为模型入口，用于隔离，不自动 merge | 内部隔离保留，两个模型入口可按需；不要改 AMA 的共享/隔离派发选择。见 [历史设计](../features/v0.7.18.md:1205)、[实现](../../packages/coding/src/tools/worktree.ts:340) |
| LSP 八项 | `8c02b2bc`（2026-06-09）首批四导航；F132 目标是准确导航和诊断回流 | 语义服务与自动诊断仍有价值；八个 native 名字并非必须同时常驻，可按可用服务/职责实验。历史路由成功率不证明全任务收益。见 [服务委托](../../packages/coding/src/tools/lsp-navigation.ts:47)、[F132](../features/v0.7.47.md) |
| `tool_search/tool_call` | `1693593b`（2026-05-23）为抵消前一批说明约 +9.7KB；`f49a3ba4`（2026-07-10）加入 portable bridge | 已有 exact/batch discovery、完整契约和同执行边界，可复用；不要新建通用路由器。按需方案必须扣除发现教学与新增往返。见 [bridge](../../packages/coding/src/tools/tool-bridge.ts:69) |
| MCP 五 facade | `c658a02f`（2026-04-03）Runtime-owned provider | remote search 的 snapshot/cursor/partial/error、describe 完整 schema 未与普通 tool_search 全面等价。可研究 exact search/describe 收敛；无 MCP 默认请求不含五项，不能虚报默认节省。见 [search](../../packages/coding/src/tools/mcp-search.ts:329)、[describe](../../packages/coding/src/tools/mcp-describe.ts:21) |
| Construction 十一项 | `c275516d`（2026-04-26）工具构造；`18798117`（2026-04-29）Agent 构造，形成注册/验证/激活闭环 | scaffold 模板可资源化；stage/admission/version/approval 保留，test 名字不保证执行真实 LLM 测试。这十一项已被普通 AMA 排除，当前默认首轮收益为零。见 [排除集](../../packages/coding/src/task-engine/_internal/managed-task/role-exclude.ts:36)、[F087/088](../features/v0.7.28.md:32) |

对标补充：Codex 的 plan 是整表接口，并有 Goal/history-notes 条件扩展以及 send_message/followup_task 区分；DSH todo_write 同为整表替换，有具名 skill、选配 session-query 五项及 create_worktree。DSH 单项 lsp(operation) 只有 definition/references/implementation/hover 四操作，不是当前 KodaX 八项的完整替代。不能因只看 Standard preset 漏掉选配能力而给 KodaX 贴“独有冗余”标签。

参考源码：[Codex plan](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/plan_spec.rs:7)、[Codex multi-agent](C:/Works/PubProj/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:205)、[history-notes](C:/Works/PubProj/codex/codex-rs/ext/history-notes/src/tools.rs:35)、[DSH Todo](C:/Works/PubProj/deepseek-harness/packages/todo/tool-todo/src/index.ts:137)、[Skill](C:/Works/PubProj/deepseek-harness/packages/skill/tool-skill/src/index.ts:83)、[session-query](C:/Works/PubProj/deepseek-harness/packages/experimental/tool-session-query/src/index.ts:55)、[worktree](C:/Works/PubProj/deepseek-harness/packages/experimental/tool-worktree/src/index.ts:18)、[LSP](C:/Works/PubProj/deepseek-harness/packages/lsp/tool-lsp/src/index.ts:3)。

## 建议的最小处理顺序

1. **先纠正价值依据。** 保留历史日期、raw、adoption 结果，但明确其不证明 local 排名或全任务质量；semantic_lookup 的实体匹配不要继续教成词面无关的概念搜索。当前 code_search 教学已纠正，不再重复改它。
2. **重复入口与能力分别处理。** `multi_edit / changed_diff_bundle / tool_describe / todo_get / lsp_prepare_call_hierarchy` 已在替代能力可用时退出默认模型目录，不能再算一次收益。[现有别名收敛](../../packages/coding/src/agent-runtime/tool-resolution.ts:68)
3. **local code_search 保持退役候选，而非继续扩大评测预算。** 现有源码足以否定其独占排名/记忆收益；轨迹支持通用搜索可用，但未证明菜单影响绝对中性。普通 root 默认入口退出与 SDK/provider/长字面量兼容分开评审；本次不切默认、不删后端，也不把下一次复杂 E2E 变成“必须跑到成功”。
4. **把优先级转向有更大实际收益的装配。** manual、agent_output、角色目录、History、worktree 等读取/专项面，先按真实使用条件核对；LSP/Repo 窄工具按服务与角色装配，复用已有发现桥接。不得把模型菜单删项反馈为 fullTodo/fullCollaboration 能力缺失，否则会改变 AMA 策略。[能力教学耦合](../../packages/coding/src/agents/worker-role-prompt.ts:133)
5. **真实能力退役需证明职责被覆盖。** 保留安全编辑恢复、Todo 增量状态、Actor 等待、Skill/Memory 准入、可信 undo、索引/语言服务；有算法正确性问题先修/限定输出。清理条件工具仅在对应工作面计算收益。

本次新增模型调用为 **0**。正式默认决策仍未实施；不以无调用遥测宣称某项“没人用”，不以本仓库没有消费者宣称外部 SDK 无依赖，不把 Windows 证据扩大成三平台实测。后续判断以明确的可观察职责、替代路径、迁移成本与全任务收益为准，不再以工具采用率或工具数量本身作为目标。

## 2026-10-24 追加：从调用依赖转向可替代职责

用户确认的原则：引用可以迁移，不能用“AMA 仍调用它”或“错误提示仍推荐它”证明必须保留独立工具。以下将**普通模型入口、内部能力、SDK 兼容**分开处理；保留当前 AMA 规划和派发策略，不增加模型调用或新配置。

### 本地 code_search：退出默认入口的最小边界

建议的产品改动位置是 managed LLM adapter 的最终模型目录投影，放在 Worker 完整执行目录和 AMA 指令装配之后。仅移除一个 builtin schema，不改注册表、权限分类、执行器、SDK 导出、压缩证据记录或 repo-explorer 白名单。普通任务直接使用已常驻的 grep/glob/read，**不把 tool_search → tool_call 设计成普通搜索的替代路径**。

适用面与例外：

| 场景 | 处理与理由 |
| --- | --- |
| 默认 Coding root，builtin grep/glob/read 均可执行 | 普通定位的首要退出候选；历史同输入估算首轮少 214 tokens，非当前所有任务/API 的固定收费差 |
| 子 Agent、专用角色、显式 SDK profile/工具可见性策略、独立 Agent | 不顺带改动；“使用 SDK 默认 Coding Agent”与“显式定制 SDK 契约”要区分 |
| code_search 或替代工具由扩展提供 | 不能仅凭同名断言等价；保留原契约 |
| 存在 provider-backed search 或无法确定其可用性 | 保留其直接可达性，不能将远端搜索误判为本地重复能力；不能只靠 FrozenInput 里的工具名字判断 |
| 无 builtin discovery/bridge | 不采用隐藏实验，避免切断兼容调用；发现可达不等于成本等价 |
| 超过 grep 256 字符安全上限的完整字面量、同时要求路径和正文命中 | 是残余边界。普通短查询替代已验证，但不承诺任意输入一次调用等价；不放宽正则安全限制，不为 214 tokens 新造路由器 |

本轮修正了实验投影的兼容检查：替代工具和 bridge 必须都是 builtin，缺失/同名扩展覆盖均保持原菜单。测试 helper 仍只服务已冻结的本地场景；其 `root` 布尔值**不是**生产环境的 SDK/provider 判定。未来接入 adapter 必须使用真实构建上下文，不能把此 helper 原样搬入产品。

新增离线执行证据：同一含中文、空格路径及 CRLF 的文件，在原菜单/候选菜单下直接执行 grep、glob、read，回执相同，每组计费工作单元均为 3，未执行发现或桥接。这证明已选定替代调用的执行等价，不是新一轮模型行为评测，也不证明所有任务调用次数相同。[验证](../../tests/deferred-repo-lsp-support.test.ts)

**当前状态：默认目录尚未切换。** 普通定位的退出方向成立，但“所有边界绝不新增往返”尚不能由现有工具保证；不把桥接兜底冒充零成本替代。剩余工作是上述生产装配边界和少数输入差异的工程决定，不再通过重复 GLM/Kimi 采样换取全票通过。

### anchor：先替换恢复建议，保留兼容执行

新增真实 Host 回归在 Windows 通过：500 行追加先触发单个 replacement 的大小限制，再拆成两个不超过限制的 replacements，**一次 edit.edits[] 调用**完成；第二项引用第一项生成的唯一尾行。分别覆盖 LF/CRLF、第二项失败全批回滚、成功后一次 undo 恢复原文。没有新增插入操作、参数、工具或执行分支。[真实文件事务测试](../../src/windows-text-transaction.test.ts)

已实施的最小改动只有大段编辑失败的两处恢复文本：工具错误和 Runtime 恢复消息都指向“一次 edit 的 edits 数组”，说明后续 anchor 必须匹配前项结果；不再推荐拆成多次 edit 调用或必须改用 insert_after_anchor。失败计数、write 阻断、事务、预算和 AMA 均不变。[工具错误](../../packages/coding/src/tools/edit.ts)、[Runtime 恢复](../../packages/coding/src/agent-runtime/middleware/edit-recovery.ts)、[契约测试](../../packages/coding/src/agent-runtime/__contract-tests__/cap-015-edit-recovery.contract.test.ts)

后续可逐项迁移普通 section append 和唯一锚点恢复提示，再考虑退出默认入口。外部修改后，edit 会要求重新读取而 anchor 可基于当前快照追加；这只是安全语义差异，不能叫“anchor 更智能”。本轮不把新鲜度校验削弱，也不声称完全隐藏 anchor 后绝无新增读取。SDK handler、专用角色和历史结果解析暂留；永久移除要另作兼容变更。

### RepoIntel：先拆消费者，不能把整套索引视为不可替代

| 消费面 | 目前实际作用 | 可以如何替换 / 验证 |
| --- | --- | --- |
| 首轮自动上下文 | overview/changed scope，以及特定任务的 module/impact 摘要；有冷启动等待与缓存 | overview 本身来自 Git/文件清单与 manifest，不等于完整语义索引。先比较各段提供的独有证据；重复或无信息段可在同次装配中省略，不能删掉后要求模型补一次调查 |
| 模型主动查询 | 四项窄 capsule、relationship_scan、结构查询、环检测 | 按任务字段证明覆盖。relationship_scan 已调用同源服务，但未完整渲染模块证据、符号签名/imports 和流程摘要/歧义候选；符号 alternatives 与正数 changed-overlap 已覆盖，不应误报为缺口。详见后文离线核实；不能仅按调用同源直接删四个入口 |
| 任务结束快照 | 保存 overview/scope/module/impact JSON 和 summary，用于后续证据/恢复 | 与首轮 token 是不同成本面。追踪实际读取方，复用已存在且新鲜的快照；若无必要可迁移/裁剪生成，但不把快照 IO 优化计为首轮节省 |
| 图结构算法/索引 | 符号关系、模块边、SCC 等 | grep 能查词面，不能直接提供同样的图查询结果。但“有算法”也不证明其输出准确或值得默认注入；先用有真值的离线仓库比较正确性、完整性、新鲜度、冷/热耗时，再决定保留服务或换实现 |

源码：[首轮装配](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts)、[轻量 overview](../../packages/coding/src/repo-intelligence/index.ts)、[结束快照](../../packages/coding/src/task-engine/_internal/managed-task/repo-intelligence.ts)、[聚合渲染](../../packages/coding/src/tools/relationship-scan.ts)、[结构返回值](../../packages/coding/src/repo-intelligence/semantic-types.ts)。本轮不改这些消费者，避免同时改变证据供给与工具菜单而失去归因。

### 后续入口收敛优先级

1. 普通 local code_search：先处理上表边界；不新增配置，不启动下一轮付费评测。
2. insert_after_anchor：大段追加恢复教学已迁移；普通恢复继续验证唯一性/EOL/原子回滚后迁移，安全语义差异单独决定。
3. Repo 窄入口：先补 relationship_scan 实际缺失且任务需要的证据，再比较一次聚合查询和窄查询的输出成本；不是强迫每项查询读取四倍内容。
4. manual、agent_output、角色目录、history/worktree：已有特殊职责，低频不自动等于可省。若隐藏会把直接调用改成两轮发现，就不满足本轮要求；有真实使用条件的装配优先于全面延迟。

已有 multi_edit、diff bundle、tool_describe、todo_get、LSP prepare 收敛不重复计算收益。模型调用数为 0、模型费用为 0；不宣称这组离线检查证明模型智能绝对不下降。

## 2026-10-24 实施：默认本地搜索入口与普通编辑恢复

此节是随后获用户授权执行的状态，取代前文“尚未切默认”的阶段结论。

- **生产装配已实施**：registry-managed 默认 root 的 wire tools 去掉 builtin code_search；执行目录、SDK handler/导出、子 Agent 和专用角色仍保留。Factory 将真实执行上下文与 Agent 身份绑定，adapter 在完整 AMA 指令/能力装配之后仅投影模型目录，不用工具名猜测独立 SDK Agent 的身份。
- **保守兼容**：显式 profile/可见性策略、child、独立 Agent、任一 builtin grep/glob/read/tool_search/tool_call 缺失或被扩展覆盖，均不隐藏。存在 provider.search 或扩展能力未知时保留 native code_search。复用具体 runtime 已有 listCapabilityProviders，并仅把它声明为可选契约；不新增远端探测或 provider 路由。未提供该清单的旧 SDK/组合 runtime 保持原状。每轮重查现有清单，后续注册的搜索能力不会被静态缓存漏掉。
- **字面匹配覆盖**：现有 grep 增加可选 `literal: true`，转义正则元字符，支持超过 256 字符的字面查询；默认 regex 路径的长度、嵌套量词等保护不变，空串/NUL 仍拒绝。复用原有路径、过滤、分页和结果链路，无新增工具/产品模式。普通内容查找直接 grep，路径查找直接 glob；需要两类结果时可在同次模型响应中发出两个独立调用，不强制发现往返。这不等于任意查询的工具调用数量或输出格式与 code_search 完全相同。
- **教学匹配**：Worker 保留“优先 grep/glob”的一句，移除引导回 code_search 的重复介绍。AMA 的计划、派发、等待与收尾条款未改；能力教学仍来自完整执行集合。保留入口的 provider 场景由原生 code_search 契约说明。
- **普通 anchor 恢复已迁移**：not-found/恢复耗尽、whole-file write 阻断和 normalized ambiguous 错误都指向 edit 的唯一已有文本；section append 说明保留完整标题行与换行。先前的大段追加使用单次 edits 数组。没有隐藏或删除 insert_after_anchor，没有改变权限、旧读检测、失败计数、原子提交、undo 或成功清理逻辑。

离线验证覆盖：

1. Adapter：正常 root 和空扩展 runtime 的单入口投影，profile/child/独立 Agent/替代工具覆盖保护，压缩后菜单稳定，动态 provider 注册后的直接调用，隐藏后旧搜索通过既有桥接仍可执行。[测试](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter-tool-contract.test.ts)
2. Grep：超过正则长度上限、元字符/反斜杠、大小写、中文空格路径和 CRLF 的字面搜索；原 regex 拒绝规则仍生效。[测试](../../packages/coding/src/tools/grep.test.ts)
3. 公共 createKodaXRuntime：真实生产菜单，无额外测试投影；第 1 次脚本响应并发发出 grep/glob，第 2 次越界 read 被原守卫拒绝，第 3 次合法 read 恢复，第 4 次准确只读报告并正常完成 AMA。无发现/桥接，无第 5 次收尾请求，fetch 被禁止。测试曾因只接受 POSIX 路径分隔符失败，修正为接受两种分隔符，未调整隔离或预算。[测试](../../tests/deferred-repo-lsp-runtime.test.ts)
4. 编辑：普通恢复信息、歧义拒绝/唯一上下文恢复，以及真实 Host 的 LF/CRLF、前缀标题、Unicode、500 行批次、失败全批回滚、undo、外部改动后的新鲜度拒绝。[契约](../../packages/coding/src/agent-runtime/__contract-tests__/cap-015-edit-recovery.contract.test.ts)、[真实 Host](../../src/windows-text-transaction.test.ts)

旧 search A/B 的 prepare 增加相同输入拒绝，当前默认菜单已隐藏时不能再把两份相同输入作为新实验付费执行；旧冻结 raw/失败记录不改写。原来 214 tokens 是只减 code_search 的旧输入估算，本次新增 literal 参数又移除重复教学，不能直接沿用为最终净收益或 API 实报。没有新增付费模型请求；离线脚本验证执行契约与固定调用数，不替代真实模型的质量结论。跨平台实现使用原有 Node 文件工具；本轮实际运行平台仍为 Windows。

下一步保持其他入口不变：先按已有 RepoIntel 消费者清单做有真值的离线证据覆盖比较，不将此改动扩成新的模式系统，不继续为小收益重复调用 GLM/Kimi。

## 2026-10-24 离线核实：Repo 四项与自动注入

审计基线：HEAD `8d3f05e0db20df6ce9c07a0130e5c55c041cc614` 加上文当前工作区改动。此节记录源码与真实 Git fixture 的离线证据，**未改变生产入口、AMA 策略、SDK 或底层能力，新增模型请求与费用均为 0**。此前“聚合工具缺少 changed scope”的表述过宽，已在上表更正。

### 保留能力不等于承诺永久保留重复实现

本地 code_search 的词面扫描没有证实独占检索收益；普通路径/内容定位已有 glob/grep/read。当前保留 handler 是为了旧 SDK、专用角色、结果 envelope/分页等兼容，不是因为被引用就不可替代。独立的 `provider_id` 分支调用扩展搜索能力，不能按本地扫描重复一起删除。后续若要清理本地实现，可复用共同搜索实现并留下薄兼容适配，但要验证默认大小写、路径与正文混合结果、排序、分页、截断及错误语义；仅删除隐藏后的实现不会再省首轮 token，不值得为此新造路由。[本地与 provider 分支](../../packages/coding/src/tools/code-search.ts:80)

### 当前 relationship_scan 不能直接替代四项

| 窄入口 | 已覆盖 | 尚未覆盖 / 不等价 | 当前默认 schema 估算 token |
| --- | --- | --- | ---: |
| module_context | 模块身份、依赖/被依赖关系等 | 模块 tests/docs、完整 entry/top-symbol/process/evidence 等信息未完整呈现 | 136 |
| symbol_context | 定义位置、调用关系、符号歧义候选 | signature、imports、kind/exported/language 等元数据 | 155 |
| process_context | 按 entry/symbol 查询时的部分流程步骤 | 模块单独查询不加载 process；仅 target_path 被拒绝；流程 summary、step.note、流程歧义候选未完整呈现 | 154 |
| impact_estimate | 受影响模块/符号、callers、summary 中的正数 changed-overlap | 显式的零交叠与 unavailable 区分、目标类型/归属等元数据；聚合还执行额外查询 | 184 |

四项合计约 **629**，relationship_scan 自身约 **442**，后者已在菜单中，不能重复计为新增开销。数字来自当前 Worker 短契约的 `{name,description,parameters}` 序列化和 KodaX `countTokens` 字符启发式，**不是模型 tokenizer 或 API 实报，也不是全部请求净收益**。[计数口径](../../packages/agent/src/tokenizer.ts:1)、[模型契约](../../packages/coding/src/tools/model-tool-definition.ts)、[窄渲染](../../packages/coding/src/repo-intelligence/semantic-render.ts:25)、[聚合选取与执行](../../packages/coding/src/tools/relationship-scan.ts:663)

Windows 上以真实 Git fixture、同一 app/shared 调用链分别运行 light/full；包含 tests/docs、签名/imports、一个工作区改动及恢复后的 clean 情况。温热索引样本的工具返回估算如下：

| 查询 | 窄工具返回 | 聚合返回 | 说明 |
| --- | ---: | ---: | --- |
| module | 135–136 | 234–257 | 输出更长，仍缺 tests/docs |
| symbol | 127–128 | 522–545 | 输出更长，仍缺 signature/imports |
| process entry | 173–174 | 451–474 | 不能由部分步骤推断完整流程等价 |
| impact symbol | 156–157 | 417–440 | 同源影响摘要被更多非目标内容包围 |
| impact path | 135–136 | 233–257 | 同时查询模块与影响范围 |

process 的 target_path-only 聚合调用直接报错，其短错误文本不能算节省。module-only 聚合虽成功返回，也没有执行 process 查询。窄查询样本约 124–220 ms，聚合成功样本约 324–632 ms；这是固定顺序、每场景一次的温热索引观察，不是跨平台性能基准。源码上窄工具一次服务请求，聚合按目标依次执行约 2–4 次服务请求，解释了成本方向；不能据此推算全任务耗时、费用或模型智能。首轮 schema 与工具回执都可能在后续请求再次携带，缓存也影响收费，不能只相减宣称收益。

原始离线结果位于 OS 临时目录 `kodax-repo-entry-audit-HCEjMC` 的 light/full-report.json；不提交 raw。长期执行回归见 [Repo 工具测试](../../packages/coding/src/tools/repo-intelligence-tools.test.ts)，包含详细证据保留、refresh、降级/部分失败、权限拒绝恢复、预算与扩展覆盖边界。

兼容边界：聚合直接调用 Repo 服务，**不会调用同名扩展覆盖的窄 handler**；工具级允许/拒绝策略和预算不能因换名字自动视为等价。未来任何收敛还需保留首次 refresh、warming/降级警告、部分结果、歧义候选、目标选择和拒绝后的自主恢复。现有 SDK/专用角色可见性不能随默认 root 菜单一并修改。

### 自动注入的真实重复与最小方案

- 已消除的大块重复不再计收益：当前 baseline 优先于 cached bundle；已有 module/impact 不再次 fallback；AMA 的稳定能力段排除 repo block，只有 managed run context 携带。后续历史携带不等于每轮重复追加。[装配](../../packages/coding/src/agent-runtime/middleware/repo-intelligence.ts:268)、[AMA 排除](../../packages/coding/src/task-engine/runner-driven.ts:1699)
- 同一个 baseline snapshot 中，overview 与 changed scope 重复输出 root，以及 overview.generatedAt。样本这两行合计约 **33 个估算 token**，随路径长度变化。changed scope 的 analyzedAt 是另一时点，必须保留。[组合](../../packages/coding/src/repo-intelligence/index.ts:1174)、[独立 scope 渲染](../../packages/coding/src/repo-intelligence/index.ts:1535)
- project snapshot 与 overview 仅部分交集：前者是 cwd 下有限深度/数量的目录清单，后者是 manifest/docs/entry/area 摘要；不能直接删整段后让模型补一次 glob。Git 原始 index/worktree 状态与 scope 分类、cwd 与 gitRoot、不同结果的 freshness/confidence/warning 也不能仅按文字相似删除。SDK caller 自带 context 原样保留。[目录与 Git](../../packages/coding/src/prompts/capability-sections.ts:479)

**建议的最小下一步**：先校准过度承诺的工具教学；如实施自动注入去重，只在同源 overview+scope 的组合渲染省略第二份身份字段，保留独立工具/SDK 渲染、analyzedAt、风险/截断与失败回退，不新增配置或通用文本去重。约 33 token 的收益不足以支持多处路由改造。

**四项入口暂不收敛**。单纯扩充 relationship_scan 的全量返回会进一步放大输出；再加 view 路由虽然可复用窄查询，也需要新增参数教学、权限/预算和扩展兼容处理，尚无足够净收益证明，不能作为已接受方案。尤其不能隐藏后要求 tool_search/tool_call 补查来满足完整性。

实施前的离线验收：同源 root/时间只出现一次；scope 单独使用时仍自足；根/子目录、clean/dirty/non-Git、baseline 失败/缓存回退与用户自带 context 保持原行为；独立 SDK 返回不变；不新增索引查询或模型往返。现有 refresh/权限/预算/部分失败用例继续通过。该小范围文本改动不需要再反复跑付费模型；离线执行验证也不冒充智能绝对不下降的证据。

本轮现有回归结果：Repo 工具测试 19 passed；自动注入 middleware/CAP-001/CAP-001-budget 三文件 12 passed、3 个既有 todo。合计 31 passed，另有上述 light/full 真实 fixture 的离线对照；没有把仅存在的回归计划当成已完成验证。`git diff --check` 通过。本轮只新增研究证据与设计结论，未实施新的生产行为。

### 随后授权实施：契约校准与同源身份去重

以下为用户确认最小方案后的实施状态，取代上一阶段“未实施”的描述；不改变上述四项暂不隐藏的结论。

- 组合 overview + scope 时，仅省略 scope 中的重复 root 和 overviewGeneratedAt。两段本来就来自同一 snapshot；使用一个私有渲染参数，不新增公开选项、文本解析、服务查询或路由。独立 `renderChangedScope(report)` 的签名和输出保持不变，scope 单独注入时仍自足，analyzedAt、统计、风险、文件清单及截断逻辑保留。
- 四项完整说明删去“必然省掉若干读取轮次”“一定更便宜”“排名/严重度”等未经实现支持的承诺，明确静态索引与证据边界。原生短说明明确可直接调用；完整说明仍可通过既有发现获取。relationship_scan 不再要求所有窄查询先走聚合，说明选择器和详细证据缺口；depth 参数及返回提示明确没有递归遍历，避免在 full 模式仍误称为 light 专属限制。
- 工具名、参数类型/必填项、注册、SDK、专用角色、权限、预算和 AMA 策略均未改变，没有新增调用步骤或付费模型请求。

验收：组合上下文新增 5 个真实文件/Git 用例，先观察 4 个重复 root 失败，再以最小实现通过；覆盖根/子目录、clean/dirty、non-Git，以及独立 scope/SDK 输出与组合证据一致性。light/full 现有详细证据用例补充 depth 限制，先失败后通过。原生 adapter 用例确认四项在任何 discovery 前均已下发全部 SDK 参数。缓存回退、caller context、refresh、部分失败、拒绝恢复、预算及旧 SDK 参数回归通过。

最终定向回归累计 **197 个不同用例通过、3 个既有 todo**，源码与测试 typecheck、`git diff --check` 通过。首次组合回归还发现上一轮 grep.literal 已实现而 canonical 参数测试漏列该字段，已补齐断言，未改执行逻辑。没有运行付费模型或声称已证明所有模型任务表现不变；前文约 33 token 仅是两行重复字段的历史样本估算，不是本次全部契约修改后的 API 净收费差。
