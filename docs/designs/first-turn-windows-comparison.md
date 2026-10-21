# Windows 首轮输入对照与参数披露验证

当前默认保持全部 native 工具与既有 AMA 策略。最新版源码实抓确认，KodaX 与
Codex 的剩余输入差距主要在工具契约；不能只根据首轮更小决定启用参数披露。
本记录更新此前安装版/不完整 DSH preset 的参考值；旧设计文档中的数字仍是历史测量。

## 2026-10-21 两项工具契约精简

在下述基线之上，仅精简 `spawn_agent`、`ask_user_question` 的说明，并将
specialist effort 说明中的错误字段名改为现有 `agent_id`。完整 Host 的模型字段
估算降至 OpenAI **20,191**、Anthropic **19,831**，各省 392，约 1.9%；55 个
native、全部参数形状、执行器与 AMA 策略保持不变。OpenAI 对 Codex Sol 的剩余
差距为 3,159；DSH Standard/PTC 仍为 9,318/11,753，但能力集合并不等价。

GLM/Kimi 配对编辑任务与最终复杂任务已经验证，收益、耗时、失败和报告限制详见
[工具必要性与契约精简记录](tool-contract-necessity-refinement.md)。当时发现的预算
重复计数已由[后续独立修复](native-bridge-budget-equivalence.md)改为原生/桥接各计一次，
Host、专用 wrapper 和拒绝/恢复路径均有验证。参数披露的其他门槛仍未满足，
不启用新的参数隐藏，不退役工具，也未新增注入模式。
这里仍是同口径文本估算，不是 API usage 或桌面界面的上下文读数。

## 2026-10-21 精简前基线复测

基线 `77307a32` 在相同 Windows 夹具重跑已有真实 SDK 抓包测试，16 个场景
通过，外部模型调用为 0。下表采用与原比较完全相同的模型字段提取顺序和
`countTokens`，不使用 mock usage，也不与 Kimi 的真实 usage 混算。

| 当前 AMA 场景 | 模型字段估算 | 工具估算 | 其余输入 | native 数 |
| --- | ---: | ---: | ---: | ---: |
| OpenAI / Runtime Host | 20,583 | 12,816 | 7,767 | 55 |
| Anthropic / Runtime Host | 20,223 | 12,427 | 7,796 | 55 |
| OpenAI / 无 Host 组件路径 | 19,181 | 12,420 | 6,761 | 53 |
| Anthropic / 无 Host 组件路径 | 18,834 | 12,045 | 6,789 | 53 |

保留完整 Host 的数字作为主要基线，不能用少两个绑定的组件路径声称默认更小。
合并主仓后的 Host 数字比前次入口收敛记录各多 48；最近的错误路径恢复修正只改
评测，不减少注入。当前参考仓库 HEAD 仍为 Codex `3b8f43a06b` 和 DSH
`1517a4dbca`，其 tracked 工作区无改动；重新读取原始请求并重算验证，既有
Windows 实抓仍为 Codex Sol 17,032 / Astra 16,944、DSH Standard 9,318 /
PTC 11,753。没有重新构建参考项目，也没有将它们称为联网最新版本。

KodaX OpenAI / Codex Sol 的总差为 3,551，其中工具表示差 3,545，其他输入差
6。剩余差距集中在工具契约，但不同产品的能力集合不同；这不是质量等价证据。
当前 KodaX 已有 coding/agent 分层、角色提示、stable/context 分离及只缩说明的
deferred hints。内部执行器另有压力驱动曝光规划；AMA adapter 当前则直接生成
native wireTools，预算诊断为 report_only，不能把前者描述为已接入 AMA 的模式。
未新增 DSH 式 Standard/PTC preset，也未默认启用大范围参数披露。

原始 SDK 请求、重算脚本、参考请求副本与主会话解释位于 OS Temp 实验
`kodax-eval-dumps/first-turn-status-20261021-PNiuXU`，另有两份哈希校验副本。

## 2026-10-17 同场景实抓（历史基线）

固定短任务“请简短说明你已准备好。”，Windows/PowerShell、空 workspace、隔离
个人与项目规则、无第三方 MCP。各项目自己的官方默认能力和内置 skills 保留。
用当前 `packages/agent/src/tokenizer.ts` 的 `countTokens` 对 compact JSON
统一估算；不代表 BPE、API usage、账单或当前桌面会话的上下文显示。

| 版本与场景 | 完整 HTTP 请求估算 | 标准模型输入字段估算 | 工具表示 |
|---|---:|---:|---|
| KodaX `5ada4f7c` AMA/OpenAI | 20,942 | 20,915 | 58 native |
| KodaX `5ada4f7c` AMA/Anthropic | 20,547 | 20,533 | 58 native |
| Codex `3b8f43a06b` Sol | 17,418 | 17,032 | 11 native + 12 SDK 声明 |
| Codex `3b8f43a06b` Astra | 17,330 | 16,944 | 同上 |
| DSH `1517a4dbca` Standard | 23,303 | 9,318 | 31 native |
| DSH `1517a4dbca` PTC | 28,172 | 11,753 | 1 run_code + 30 SDK bindings |

模型字段包含全部提示、消息、工具与内嵌 SDK，排除请求控制字段和独立扩展字段。
Codex 的工具声明位于 `input` 中，已计入，不能因为顶层 `tools` 为空而漏算。
DSH 原始 HTTP 还默认附带 `dsh_session_log`、`dsh_plugin_packages`，不能将
整包文本估算叫做模型上下文；本地源码也不能证明官方服务端如何消费或计费扩展。
DSH 每模式另有一次默认标题请求，标准模型字段约 176 估算 token，单独登记。

Codex 从锁定源码构建 exec 与同版本 Code Mode host 后实抓；补齐 host 前的
provisional 抓包保留，不作最终证据。DSH 在 Temp 完整生产 Web profile 启动，
补齐精确依赖与当前生成物，真实 adapter 发到 loopback；未删模块或用空 service
冒充完整 boot。以上均无付费模型请求；mock usage 不作真实 API usage。

这些场景能力集合不同，不是同模型、同能力的智能或任务完成率比较。尤其 DSH PTC
默认未装载 Standard 的 workflow，且全量 input/output SDK 仍常驻；不能称为
所有能力不变的工具表示 A/B，也不能将 Code Mode/PTC 直接当默认节省手段。

## 剩余差距与候选边界

KodaX OpenAI 对 Codex Sol 的模型字段差约 3,883。工具部分约 13,185 / 9,271，
其他模型输入约 7,728 / 7,761；后者基本持平。继续优化主要应审查工具展示，
不以达到固定数字为由删除编码能力或改写 AMA 规划、派发、终止策略。

## 注入链条的区别

| 环节 | Codex 当前源码与实抓 | KodaX 当前行为与取舍 |
|---|---|---|
| 模型与模式 | catalog 的 `tool_mode` 优先于 feature flags；本次 Sol/Astra 都是 `code_mode_only` | 复用既有 provider descriptor 与兼容投影，不复制每模型整套提示词 |
| 稳定指导 | 模型 base instructions 与环境、权限、skills 等 developer/user fragments 一并进入请求 | AMA 排除 SA base-system/suffix 等重复 section；Worker stable/context 为互斥渲染，不能将源码两种 renderMode 当重复注入 |
| 工具构建 | native 调用加 Code Mode SDK 的选择来自实际工具配置与绑定 | 当前完整 Actor 能力构建 runnable 工具，Worker 路由知识继续依据实际可执行名称 |
| 请求表示 | Responses Lite 将工具放入 `input.additional_tools`，顶层 `tools` 可为空 | `llm-adapter` 从 runnable 表投影 native schema，provider 最终序列化；本次研究仅在这个输出边界追加表示投影 |
| 参数知识 | 本次 Code Mode 12 项 SDK 声明仍在输入，不能当成全部参数按需检索 | 研究将 18 项完整参数移出 native 表，保留当前顶层说明目录，用现有 exact search/checked bridge；可执行集合不变 |
| 执行与恢复 | 表示层不能代替 host 可用性及实际调用验证 | 继续经过目标权限、只读、取消、identity 和工具保障；本次不改这些链路，也未证明全部恢复情形等价 |

因此，“Codex 的 Code Mode 是否默认开”应按模型和版本回答。本次锁定 catalog 的
Sol/Astra 确实默认选择 Code Mode Only，不需另开 flag；其他模型可由 catalog 或
feature flags 决定，host 可用性和 fallback 分支仍须核实。本次已构建同版本 host，
不是仅抓取缺 host 的降级请求。该观察不能直接推广到所有 Codex 安装或模型。

DSH 从生产 Web profile 的插件绑定决定注入：Standard 发 31 个 native，PTC 发
`run_code` 和系统中的完整 SDK 类型。PTC 的 SDK 输入与输出映射本身约 8,753
估算 token，所以代码执行表示并不天然更省。本次 PTC 的默认 workflow 绑定也与
Standard 不同。值得学习的是按真实宿主/职责绑定提示与工具；不能把 DSH 的模式
差额全部归因于同一能力集合上的注入优化。

KodaX 已有 agent/coding 层独立性与 role-specific 提示。继续由 coding 层承担
编码契约，agent 层保留通用执行框架；root、child、helper 各自必要指导仍保留。
本轮不增加用户模式、任务分类器或 learned-schema 状态机，也不把暂时缺少 LSP
进程、空 memory 或无剩余 child 容量误判为永久无能力。

逐义务审计后的稳定提示候选 A2 为零修改：未找到收益值得、且不承担独立工具或
child fallback 义务的真实重复。保留全部 native 的专项字段文案候选 B0 只省约
196 估算 token，暂不为这点收益修改 41 个字段并扩大模型实验。

完整参数披露的六工具小集合仅省约 491；保留当前顶层描述目录的大范围 18 项
研究投影约 19,125（省 1,817），旧 20 项约 18,722（省 2,220）。后两者包括常用
repo 入口，只是研究表示，尚未进入产品默认。执行集合、Worker 能力知识和权限
不能随模型参数表一起裁掉。额外一个模型往返可能抵消多轮常驻节省；独立发现能否
与读取并行，必须在模型任务中观察。

本次历史测量时 AMA bridge 对普通注册目标存在外层与目标 wrapper 分别计工作单位
的差异。后续已独立修复重复计数，见上述预算验证；该修复没有启用这里的披露投影，
也不代替其他执行、压缩恢复和动态能力验证。

## 有界模型验证

研究投影只在实验 provider 边界应用，使用原真实 Runtime、完整可执行工具集合和
既有 exact `tool_search` → checked `tool_call`，不增加产品模式或公开配置。

冻结四条用户指定路线：`zai-coding/glm-5.3`、`zai-coding/glm-5.3-flash`、
`deepseek/deepseek-flash`、`kimi-code/kimi-for-coding`。先 GLM/Kimi pilot，
主会话复核盲化证据后才继续。每模型两类任务、baseline/candidate 各一次：

- 真实读取 → 一次双替换编辑 → 实际 Node 测试 → 根据结果如实报告，最多四响应。
- 真实读取接口 → 有界契约查询/定义与实现导航 → 可选读取返回实现文件 → 报告。
  最多七响应：两个文件各读一次、最多两个相关 schema 查询、定义/实现各一次及
  最终报告；独立动作允许批量。原生臂也允许合法查询/桥接，不强迫候选多一轮。
  导航使用生产 LspService
  与实际 stdio 固定协议对端，验证调用与坐标，不冒称真实编译器智能评估。

初版上限 64 次/200 万 token；先导修订后共享最终上限为 90 次物理请求、
300 万保守 token、USD 2 冻结本地参考核算，所有旧调用继续计入。每调用最多
2,048 输出 token/120 秒，每任务 360 秒，零 child/retry/fallback。ZAI 两模型共享
串行队列，其他 provider 独立并行。历史 222 调用、4,278,826 保守 token 继续保留。
订阅参考费率不是实际增量账单。每次完整输入、结果、usage、时间、工具结果和预算
状态保存在 OS Temp，主会话先审任务价值与回退，再揭盲比较全任务成本和耗时。

先导暴露了评估设计问题：过窄的发现查询、未覆盖定义导航、禁止读取返回实现
文件，以及以 bridge 外壳名去重而误拦独立目标。分别保存旧 revision、失败和
费用，经零网络回归修正；没有为 scorer 修改重新生成未变输入。中断链使用
原始响应、真实既有工具结果及限定的新响应继续，单独标为 controlled Layer 3
continuation，不写成原 SDK Run 成功恢复；这些链不能比较完整任务 wall time。

上述任务不覆盖全部压缩、恢复、动态能力激活/撤销、复杂派发与长任务。单对样本
也不能证明总体智能非劣或建立耗时排名；仅用于判断下一步是否值得，以及哪些路径
需要补充验证。最终默认行为须在这些证据明确后决定。

## 模型结果与归因

主会话在揭盲和查看效率指标前评审 8 组任务证据，再登记真实路线与全任务用量。
完整可比的配对只有两组；没有将其余失败、缺口或未执行项算成通过或模型失败。

| 路线 | 编辑任务 | 专项导航任务 |
|---|---|---|
| GLM-5.3 | native 经受控补充报告完成，71,317 tokens；披露臂连接错误，无完整比较 | native 四请求完整报告，70,893；披露臂多一次独立契约查询，最终报告请求 terminated、usage 未知 |
| GLM-5.3-flash | native 请求 500；披露臂实际编辑漏掉行尾注释，随后正确提出修复，但超出预注册一次 edit/无 repair 图，未运行测试或交付 | native 请求 500；披露臂按最终停止条件未执行 |
| DeepSeek Flash | 两臂真实 Runtime 四步闭环、文件精确且报告一致：74,147 → 66,849（约 −9.8%） | 披露臂调用了未展示的 native 名称，坐标正确但未遵循 bridge 协议；native 臂的合理 document_symbols 被窄图误拦。整对不作任务质量比较 |
| Kimi for Coding | native 四步闭环 66,523；披露臂中断后提出的编辑会丢闭合括号和注释，实验直接 handler 又因缺 trusted mutation host 拒写，原文件未变。无完整比较 | 两臂经受控续接，真实导航/读取/报告一致，四请求 66,269 → 60,690（约 −8.4%）；披露臂未先查 schema，额外并行查了定义 |

上述 token 是 API input+output（含缓存输入），不是启发式估算。DeepSeek 编辑是
本轮唯一不中断的成功任务配对：wall time 7.779 → 7.820 秒，没有显示加速。
Kimi 定位受实验中断，不比较完整任务 wall time。其他未完成链的前缀用量不能与
完整任务比较；网络错误也不能当成提示词回退。每 cell 一个样本不能证明总体因果。

这轮实际 48 次物理请求，每次 1 attempt；44 次已知 usage 共 734,347 tokens，
4 次未知按预留保守记入 327,817，合计 1,062,164。冻结本地参考核算 $0.0760597038，
不是实际账单；未结预留为 0。包括旧无效先导、实验中断和受控续接，没有重置费用。
加此前历史后累计登记 270 次、5,340,990 保守 tokens、8 次未知 usage；旧 29 次
raw 缺失的限制继续保留。实验标识 `kodax-frontier-ed0a447f79914aa1b746492c76ace513`，
输入/响应、夹具、版本、盲审、揭盲和账本在 OS Temp 三份副本保存。

工程建议为 `recommend-iterate`，本轮结束，不追加生成、不进入默认。初次编辑
缺陷与调用协议风险须保留，但现有缺口不足以证明“披露导致全局智能下降”；同样，
两组节省也不足以证明“四模型无退化”。未修改 AMA 策略或产品默认，不能将这轮
研究的失败描述成现有 native 版本已发生产品退化。

## 默认决策与后续实施条件

当前保持全部 native。A2 零修改；B0 的小收益暂不实施；18 项披露投影只作研究。
即使个别短任务节省 token，也不足以让它进入默认：现有 bridge 预算不等价，实验
仍按完整 schema 预估上下文，而且压缩/恢复/动态能力链尚未形成所需证据。

后续若继续推进，按下列顺序收紧范围，不直接复制 Code Mode 运行时：

1. 以当前完整请求和规则保留清单为基线，逐项证明哪些字节承担独立职责。独立
   工具、child、helper 的必要契约仍须自足；没有实质收益的去重保持零修改。
2. 对真正有收益的披露集合，先单独决定并验证预算语义：具体目标的工作量是否
   应只计一次，发现本身如何计账。保持目标权限、取消、只读、结果及身份归属，
   不通过直接删 bridge 外层计数来忽略 override/run-scoped 分支。
3. 同一次 sampling 绑定中，能力知识、完整执行集合、模型显示和上下文预留必须
   同源。零网络先覆盖同名 extension、schema/source 一致、live 权限撤销与激活、
   major compaction/resume 后重新查询，再复用本轮有效 raw，补足受影响的真实
   模型输入。以任务价值、完整 token/往返和耗时决定，不以 17k 为删能力门槛。

上述是采用披露前的实施条件，不是已经实施的产品改动。现有四模型最终 native
编辑 E2E 记录继续有效；本轮研究投影的局部成功不能替代它，也不能覆盖网络失败、
实验无效或不完整样本。所有默认修改都须另有可审查 diff 与对应验证。

## 证据与实现来源

- KodaX：`tests/first-turn-wire-inventory.test.ts`；首次精简和四模型既有编辑闭环见
  [native 契约实施记录](native-tool-contract-hygiene.md)。
- Codex：`codex-rs/core/src/client.rs` 的 input/AdditionalTools；
  `codex-rs/core/src/tools/mod.rs` 的模型工具模式选择；
  `codex-rs/models-manager/models.json`；`codex-rs/code-mode-protocol/src/description.rs`。
- DSH：`packages/llm/llm-deepseek/src/serialize.ts`、`request-extensions.ts`、
  `adapter.ts`；`packages/bundle/base/cordis.patch.yml`；`packages/core/tools/src/ts-types.ts`。
- 方法与限制遵循 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)。原始抓包、
  构建日志、隔离配置、版本和哈希保存在 OS Temp；探索笔记继续留在 ignored research。
