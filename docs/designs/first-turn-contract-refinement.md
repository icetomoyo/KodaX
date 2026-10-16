# 首轮工具契约与 AMA 精简计划

2026-10-14；设计基线 `cded4799`。本阶段完成测量、候选契约和实施边界设计，尚未修改产品行为。DSH Minimal 不作为目标。

后续 [Codex 框架对标](codex-harness-parity.md) 已零网络确认默认 SA 的协作展示/宿主绑定不一致及 native/bridge 调度差异。完整 schema 延迟披露前先修这些窄边界；本文件的现状与 r3 数字保留原场景，新增 SA 合并预算另列，既定 18 次评测上限不自动扩大。

2026-10-16 范围更新：新产品任务统一 AMA、退出用户可选 SA；保留 AMA child/helper 使用的 direct executor 和旧 SDK/恢复兼容。实施顺序见框架对标设计。下文 SA 抓包与 r3 作为历史/内部回归保留；产品首轮和任务表现以 AMA 为主，退出 SA 本身不算 token 收益。候选输入变化须新 revision，模型预算不扩大。

## 完整请求基线

采用同一 `countTokens` 估算完整序列化请求，包含工具、SDK、说明、任务与包装；不是模型 tokenizer、API usage 或 Codex 桌面上下文显示值。

| 当前 Windows 场景 | 完整请求 bytes | 估算 tokens |
|---|---:|---:|
| Codex CLI sol / astra，四项官方 skills | 68,710–69,065 | 17,182–17,271 |
| KodaX Runtime SA，OpenAI / Anthropic | 78,015–79,120 | 19,574–19,850 |
| KodaX Runtime AMA，OpenAI / Anthropic | 90,384–91,963 | 22,672–23,067 |
| DSH Standard，31 个工具 | 35,071 | 8,776 |
| DSH PTC，一个入口及完整 SDK | 44,547 | 11,145 |

Codex 数据来自安装版 CLI `0.162.0-alpha.17.2` 的真实 Responses 请求，使用参考仓库 `400f2356` 的原样模型 catalog；CodeMode SDK 与全部原生工具已计入。此前约 6.5k 只是指令小计。隔离 Windows 的个人 skills 后保留四项官方 skills；个人目录场景约 18.7–18.8k，不能混作空基线。这不是当前带插件的桌面会话总量。

DSH 数据来自 `d7432673` 的实际 Windows model-facing Web preset、AgentLoop 和生产 Messages serializer；GUI renderer bundles 缺失，不称完整 GUI E2E。三者能力、skills 和协议不同，可定位输入规模，不能据此计算严格同任务效率倍率。无外部模型调用；合成响应 usage 不作为实测用量。

## 差额与取舍

- OpenAI 场景 AMA 对 SA 多 3,493：system +2,115、管理消息 +1,172、工具 +207；Anthropic 场景总增量为 2,822。没有再放一整套工具。管理消息首次安装、后续仅追加变化；不能为了省首轮丢掉容量、身份、恢复或事实信任边界。
- OpenAI 场景 AMA 工具约 15,310，Codex 全部 AdditionalTools/SDK 约 9,271；两者其余请求分别约 7.8k / 8k。对 Codex 的主要差额在工具契约；AMA 对 SA 的主要差额才是 Worker 指导与管理上下文。
- DSH Standard 的 Todo、问答契约更短，但 Todo 整表写入不等价于 KodaX 的稳定 id、增量、owner 和完成检查。不能为追平 8.8k 撤回已有修复。PTC 返回值 SDK 自身约 2.9k；入口减少不保证首轮减少，批处理价值需看整个任务。

## 分阶段实施

### 1. 四项常驻契约，先落实可核对收益

精炼 `ask_user_question`、`todo_create`、`todo_update`、`spawn_agent` 的工具及字段描述，优先修改现有 builtin 定义的单一来源。复用已有模型投影处理 SDK 兼容差异；不再复制一套 schema 或增设用户配置。

已完成离线 r3 候选：只修改 description 字符串，四组完整请求各减少 4,072 bytes、1,019–1,020 估算 tokens。SA 变为 18,554–18,831，AMA 变为 21,652–22,047；这是候选预算，不是上线或非劣证明。

输入的名称、type、required、enum、default、边界、handler、历史和 extension override 保留。语义核对特别保留：

- `kind=input` 仅平铺单题自由文本；`questions[]` 每项必须有 options，选项默认、有效期和自定义输入规则不变。
- Todo 稳定 id、增量变更、owner、状态、hook veto、metadata 浅合并及 null 语义；完成检查仅在 runner 已接线时触发，completed 不等于实际测试通过。
- 派发明确独占写路径与产物，根/兄弟不得抢写；抽象 objective 而非 shell 教程；fast 的只读评估和可写父层限制；只有已投递且带 terminal state 的 Agent summary 才是完成证据，wake acknowledgement 或普通消息不是；根负责整合验证及仍运行的孩子。

后者在现有 SA system 中覆盖不完整，候选同时补强该缺口，不能把这部分变化宣称为完全行为中性。

### 2. 规则归属与实际能力一致

系统保留“何时做、承担什么责任”，工具保留“参数、结果、副作用和错误”，管理消息保留“当前事实”。按 SA/AMA 分别核对每项义务的常驻归属，再删重复教程、理由和不适用平台例子；不按字符长度截断。

Worker 的计划/恢复、范围、并行策略、信任、写入所有权、终止、最新用户修正、验证责任必须保留。Skills/repo 信息只是换注入位置的部分不能算节省。已有管理消息变化增量机制保留。

修正 SA 仍教授 `set_permission_mode` 的过时说明，指向实际 `exit_plan_mode` 宿主审批边界；不恢复权限提升 callback。工具表、search、describe、bridge 共享实际 host/role/policy ceiling。lazy LSP、空 memory、暂时零 child 容量不能当能力永久关闭。这一步收益待真实候选抓包确认。

### 3. 小步延迟完整 schema

当前 deferred 仅缩短 description，参数 schema 仍常驻；SA 低压首轮 exposure planner 为 report-only，AMA adapter 尚未接入该 planner。复用已有 discovery/dispatch，不添加任务关键词权限分类器或第二套执行 registry。

先从已有 deferred 中 process/impact/overview/semantic 等较低频族试点，保留短目录、适用条件与首次选工具规则。核心读改查、shell、diff、Todo、交互、技能激活和 AMA 协作继续直接可用；LSP 另行按受影响场景验证，不一次隐藏全部长尾。

`tool_search` 一次批量返回完整契约，随后 `tool_call`；不强制 search→describe→call。先采用稳定核心工具前缀及结果内披露，避免每次解锁改变 native 工具数组。验证 provider 历史兼容后才考虑动态提升。执行仍经过 target override、权限、取消、异步结果与 mutation accounting，曝光不授予权限。

只移除该 Runtime 抓包中十项 deferred schema 的理想化上限约 1,634 tokens，未计目录、结果、额外轮次和缓存损失；不能与其他收益简单相加。首个 AMA 工程目标可设约 18–20k，但需抓包和任务表现决定可达性，不作为删功能的硬门槛，也不是已实现数字。

## 验证、成本与回退

每阶段独立提交、保存原始基线、先测试再实现。首先零网络断言最终 OpenAI/Anthropic SA/AMA 请求、SDK/历史/override 兼容、自由文本与批问、Todo owner/veto/metadata、编辑失败零写入、只读子 Agent、取消、compaction/resume 和 terminal evidence。发现阶段还要覆盖批量 schema、首次记忆写入、lazy LSP、跨轮工具恢复及 bridge/direct 同一执行边界。

Layer 1 不能回答的是模型能否正确理解精炼义务、主动发现工具及正确选择下一步。按 `benchmark/EVAL_GUIDELINES.md` 设计固定历史、真实生产工具字节的盲化配对 pilot，先 Kimi Code 与 GLM-5.3；GLM 按已有 zai-coding/zhipu-coding 可用路由分别记录，观察到别名或任务差异时才扩至已有 GLM-5.3-Flash、DeepSeek/Flash 路由。先核对可用路由，失败与不可用单列，不把替代模型混作同名样本。

重点场景：具体计划及恢复、批问/自由文本、广域审查派发、写入所有权、wait 后证据整合、完成检查 veto、工具发现后的正确行动。各阶段先做 Layer 1；不在每阶段机械重跑所有付费场景。冻结生产候选后，第一批只选择两项有判别力的固定历史：①计划恢复、完成 veto 与用户缺失信息；②广域审查派发、终止证据与下一工具选择。每 arm 一个样本，主会话评审价值与回退原因；机械命中及少量通过不证明全局智能非劣。

下一修订拟采用以下增量预算，须与历史累计账本并列登记，不能把 v1/v2 已花成本清零：

| 项目 | 冻结上限与执行规则 |
|---|---|
| Layer 2 pilot | 两个 case × 两条路由 × 两个 arm = 8 次；每 cell 一轮/一次，不执行所提工具 |
| 有条件复采 | 最多 2 次，仅补一个受影响配对；无有效差异或 pilot 无效时停止，不扩完整模型池 |
| 真实 Runtime smoke | 最多 2 case × 4 次响应 = 8 次；候选实际工具表，固定 read→edit→Node test→final，以及 search→bridge call→实际验证→final；不用于 A/B 质量裁决 |
| smoke 边界 | 每 case 最多 3 次工具执行、0 个真实子 Agent、不自动 repair；子 Agent 取消/恢复/消息唤醒先由零网络 Runtime E2E 覆盖 |
| 共享总预算 | 最多 18 次 provider dispatch、600,000 总 tokens、$1 冻结费率参考成本；coding-plan 参考成本不是订阅账单 |
| 请求边界 | 每请求输出最多 2,048 tokens、120 秒；smoke 每 case 最多 300 秒；同 provider 并发 1，重试/fallback 均计入总数 |

预估规模约 0.4–0.6M tokens；用来决定是否保留本轮契约/披露变化，而非购买泛化非劣证明。输出上限不被 provider 支持时记录超额，禁止补问。未知 usage 按预留额度计费；额度不足、可信退化、超时或无效 case 都保留 raw 并停止对应路径，不自动补齐矩阵。后续 Flash/备用路由需要单独预注册剩余额度，不能从这张表推导无限扩样授权。

实施前登记新 experiment revision 和共享预算；历史 v1/v2 账本与 raw 不改写，不重置已花成本。每一请求预先说明预期成果与上限。报告完整首轮、受控任务总 input/output、发现轮次、缓存命中、时延、错误和重试，同时给语义收益/损害。若首轮下降但额外轮次抵消、关键义务弱化或出现可信退化，修复或撤回该阶段。

详细来源、完整 raw 路径、哈希、独立复核与候选全文保留在忽略的研发笔记和 OS 临时目录；正式文档仅追踪结论、边界和验证计划。后续实际请求评测成功前，不把本设计称为表现无损或整体加速。
