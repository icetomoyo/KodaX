# Windows 首轮输入对照与参数披露验证

当前默认保持全部 native 工具与既有 AMA 策略。最新版源码实抓确认，KodaX 与
Codex 的剩余输入差距主要在工具契约；不能只根据首轮更小决定启用参数披露。
本记录更新此前安装版/不完整 DSH preset 的参考值；旧设计文档中的数字仍是历史测量。

2026-10-23 后续十二项延迟实验已完成，默认仍不开启：工具发现修复进入源码，
四项详细 Repo / 八项 LSP 仅在测试投影中延迟，原有 SDK、角色、执行能力和 AMA
保持不变。实际普通首轮输入 GLM 18,239→16,722、Kimi 16,892→15,591；这些是
各 provider 的 API usage，不能直接与下文 Codex/DSH 启发式数值混比。
普通任务全任务 token 减少，但 Kimi 模块预检因补证多一轮，34,573→49,740。
候选复杂编辑两例均完成：GLM 11/11、Kimi 10/10 测试，独立检查各 6/6；
不足以证明普遍非劣或默认更优。完整用量、费用、耗时、报告偏差与验证缺口见
[十二项实验与决策](tool-surface-cost-attribution.md#r3-controlled-results-2026-10-23)。

随后源码审计修复了自动 overview/scope 的重复注入，保留当前快照、失败回退和
全部语义证据；仅拆开 Repo/LSP 测试投影，没有新增默认模式。该步骤零付费调用，
不将上述 r3 模型结果冒称为修复后复测。当前呈现候选与 Code Mode/PTC 的准确
区别、离线度量及实施条件见 [工具注入模式](tool-injection-modes.md)。

## 2026-10-23 最终版本复验预注册

固定 KodaX `92dc1126a8`，先在隔离的 Windows 空工作区重新构建并捕获本地
Codex `deede7201d`、DSH `687f282e86` 的首请求，保留各自官方默认能力。
统一提取非空 system/instructions/messages/input/tools，按原有 countTokens 估算，
完整 HTTP、标题请求与被阻断的后台联网尝试另记，不能充当真实 API 用量。

随后仅做两例 Layer 3.5 smoke：`zhipu-coding/glm-5.3` 和
`kimi-code/kimi-for-coding` 各一次，复用跨包缓存修复夹具及原始负例步骤。
每例最多 28 次根/子/辅助请求合计调用、800,000 保守记账 tokens、4096 输出
tokens/次、60 次工具提议、24 根迭代、一个继承模型的只读子 Agent、10 分钟；
单请求 120 秒。同 provider 并发一，不同 provider 并行；本地 coding-plan 参考
费用每例 $0.06，总上限 56 次/1,600,000 tokens/$0.12，并非实际账单。
未知 usage 完整保留预留，不自动重试、切换、续接或追加样本。

Layer 1 先复验现有拒绝/恢复、预算及收尾回归；这些测试不能证明真实模型会
自主恢复、读取子 Agent 结论并准确交付，因此需要上述两例。子 Agent 被要求
先原样尝试 `cd packages & cd .. & git diff`，经真实 SDK 拒绝后自行继续；
这是受控负例，不测自然误调用频率。不改参数、输出、隔离、AMA 或工具能力。
保留夹具已有的隔离记忆 reviewer，记忆学习质量不在本次范围。

主会话逐例核对完整原文、真实拒绝后的后续选择、只读子 Agent 结论与主线程
整合、修改/测试/独立六项 oracle、保护文件、反事实测试、Runtime completed
及报告准确性；缺少覆盖直接记缺口，不为通过补跑。全任务用量含根、子和辅助
调用，缓存输入只计一次，未知预留单列；与完整耗时一起报告。这不是 prompt
A/B 或总体智能非劣证明。原始输入/输出、版本、账本、源文件哈希和主会话评审
存入 OS Temp `kodax-eval-dumps/final-native-complex-20261023-r1`，另存两份副本。

### 实际抓包与完整性

以下为本地源码 pin 的新构建/实际请求，不宣称已核对远端全网最新 HEAD。
主会话从六份 raw 独立提取相同字段并重算通过。KodaX 使用当前最终版本已校验
的 SDK 请求：抓包源 `db3d629998` 加兼容修复对应 `a6ce65522f`，当前
`92dc1126a8` 的生产源码哈希一致；保留完整 Host，不用组件路径代替默认总量。

| Windows 空工作区 | 模型字段估算 | 完整 HTTP 估算 | 工具表示 |
| --- | ---: | ---: | --- |
| KodaX AMA / OpenAI / Host | 20,276 | 20,303 | 55 native，tools 12,509 |
| KodaX AMA / Anthropic / Host | 19,916 | 19,930 | 55 native，tools 12,120 |
| Codex Sol / `deede7201d` | 17,048 | 17,434 | 11 native + 12 嵌入 SDK，合计 9,271 |
| Codex Astra / 同 pin | 16,960 | 17,346 | 同上 |
| DSH Standard / `687f282e86` | 9,325 | 23,228 | 31 native，tools 7,234 |
| DSH PTC / 同 pin | 11,760 | 28,097 | 1 native + 30 SDK，完整 SDK 8,753 |

KodaX OpenAI / Codex Sol 的模型字段差为 **3,228**，其中工具表示差 **3,238**，
其他输入合计约 −10。能力集合和协议表示仍不等价，这不是质量或计费比较。
相较前次最终值增加的 85 来自主仓合入的 read 瞬态文本恢复契约，本轮未再缩减。

Codex 用当前锁定 Rust 1.99.1 新构建 exec 和独立 Code Mode host；保留默认
模型模式、multi-agent、全部五套官方 skills 文件，其中四项默认目录可见，
review-agent 按官方策略不隐式注入。两模型各一个 loopback inference POST、
exit 0；另有合计八个外向 CONNECT 尝试被本地代理拒绝，两个 loopback WS
探测后回落 HTTP。没有真实模型调用；host 已构建且 help 可运行，但未执行工具
cell，不宣称完成 Codex 工具 E2E。与旧 pin 的指令和工具契约归一化后一致，
原始各增加 16 的主要差异是 developer wrapper 的 turn_id/create_time metadata。

DSH 使用当前锁依赖、30 个 Typert 产物和 69 个重建 browser bundles，真实
production Web profile、无 preset patch，保留 Windows ACL skill。两模式各有
首任务及默认标题两个请求、0 错误、turn/end；标题模型字段另为 176。未声称
完成整个 native/desktop clean build。与旧 pin 的 system/tools 逐字节一致，
模型字段归一化后一致，原始各增加 7 来自更长 Temp 路径。PTC 已计全部 SDK
input/output；其默认 workflow 能力与 Standard 不同。完整 HTTP 含
dsh_session_log 和 dsh_plugin_packages，服务端如何消费、是否计费仍未知。

所有数值均为同一 countTokens 启发式估算，保留 nested AdditionalTools/SDK；
不能与真实 API usage 或 Codex 界面的上下文读数混同。官方能力、skills 元数据
保留不等于跨产品能力等价。本轮没有新增 DSH 式模式或进一步入口收敛。

### 最终版本复杂 smoke 的实际结果

当前生产源码和已构建依赖共 3,550 个文件逐例冻结并校验，执行结束无漂移；
Runtime、agent、coding、llm 走当前源码，REPL 依赖走同版本已构建包。
现有预算、隔离、拒绝/恢复和 terminal-mailbox 回归 **25/25**，当前 workspace
TypeScript build 通过。真实 smoke 使用现有 embedded Runtime 的完整 54 项
native 菜单，并非上表 55 项 Host 场景；code_search、relationship_scan 等保留。

| 路线 | 结果 | 实际物理调用 | 已知 API tokens | 终止前 Runtime 用时 |
| --- | --- | ---: | ---: | ---: |
| zhipu-coding / glm-5.3 | 首请求 HTTP 429/code 1310，7 天额度耗尽 | 1 | 未知 | 5.546 秒 |
| kimi-code / kimi-for-coding | 指定拒绝后自主恢复及编辑已观察到；评测范围守卫终止，收尾未完成 | 13（根 7、子 6） | 234,977 | 177.559 秒 |

GLM 服务提示 `2026-10-26 15:49:59` 后可用，未推定其时区。没有有效模型
输出、子 Agent 或编辑证据，不能算能力失败或通过。错误文案含 after 1 retries，
但物理观测和网络记录均证明只有一次 HTTP 请求，没有重试。未知 usage 完整
保留 **89,817 tokens / $0.00469565** 参考预留，不能称为实际消耗或实际账单。

Kimi 创建了继承模型、filesystem=read 的真实子 Agent。call-2 原样提出指定
命令，SDK 在执行前返回真实 error tool_result；call-4 自主选择 git diff 和
README 读取，call-6 中有成功结果。后续历史中的原始参数均未改写，没有注入
替代命令或人工续接。主 Agent 正确识别 src 公共入口实际重导出 packages，
修复三个实际实现，保留旧示例、API、注释及全部保护文件。

模型新增 12 个回归测试；首轮两项断言未等 loader 的微任务调度，实际测试失败。
根线程据输出增加等待辅助函数并修改测试。子 Agent 为区分实现问题与测试时序，
在 call-12 提出 `node --input-type=module -e ...` 的内存诊断。冻结评测只允许
node --test/npm test，故该命令未执行，wrapper 直接终止整个任务。这是
**评测范围截断**，与前面的真实 SDK 可恢复拒绝不同；不是工具精简导致回退的
证据，也不能据此推定该命令在 production 只读策略下会被允许。未放宽白名单。

事后独立运行最终文件得到 **13/13** 公共测试和 **6/6** 隐藏 oracle；将相同
模型测试放回原实现为 **8 过/5 失败**，具备实际回归检出力。但模型未在最后
修正后完成测试复跑，子 Agent 未交付报告、主线程未读取整合，Runtime 为
failed/success=false、最终报告为空。**不能把事后复验算成模型完成闭环，也
不能宣称报告准确性或 AMA 完整收尾已经通过。** 测试等待辅助函数使用五轮
setImmediate，能够通过当前夹具但等待偏多，作为样本效率限制保留。

两例合计 **14** 次实际请求，没有辅助物理调用或自动重试；Kimi 已知 input
226,422 + output 8,555 = 234,977，其中 cache read 180,480 已含在 input 内。
加 GLM 未知预留，保守记账 **324,794 tokens**，本地参考费用 **$0.005956085**，
均在预算内，未结预留为零；不是完整任务成本或实际账单。不能比较失败前缀与
完整任务来宣称效率提升。历史累计保留为 640 次、12,765,648 保守 tokens、
$0.6506328258 参考费用、25 次未知 usage 预留；旧 raw 缺失等历史限制不撤销。

主会话建议 **recommend-iterate**：抓包刷新已完成，复杂闭环验收尚未完成。
保留当前所有工具、AMA 和默认能力；不继续精简，也不从两个单例推断总体智能
非劣。下一步仅先离线明确评测拒绝的反馈/终止边界，保持禁止命令不执行，再
冻结受影响场景的新 revision；GLM 须等待路线可用。没有为凑通过继续付费调用。

输入、输出、原参数/工具结果、actor/run 状态、反事实、账本、结构化主会话评审
和完整性清单位于上述 OS Temp 实验及两个副本。参考证据身份分别为
`codex-20261023-deede7201-build-be7f21c844c4459794bdfa4f1465a3ce` 和
`dsh-windows-current-687f282-20261023-93b4e6bb5f7d44fa95b406a27d39fdc8`；
主会话独立重算记录为 main-session-capture-audit.json。研究笔记继续 ignored，
本节独立保留结论与限制，不依赖 research 草稿。

### GLM 额度恢复后的单例补验预注册

用户确认已处理 GLM 额度后，明确授权再次执行。新 revision
`final-native-glm-recheck-20261023-r2` 仅补 `zhipu-coding/glm-5.3` 一个相同
复杂 smoke；不重跑 Kimi 或参考抓包。先逐文件核对上一轮冻结源码和依赖，
生产、评测执行器及原始任务/拒绝步骤保持不变，复用相同哈希的 25 项离线回归
证据。上轮 429 原文、89,817 tokens 未知预留及其他失败继续保留。
仍限 28 次根/子/辅助请求、800,000 保守 tokens、$0.06 本地参考费用、
每次输出 4096、60 次工具提议、一个只读继承模型子 Agent、24 根迭代和
10 分钟；不另做付费探活，不自动重试、切换或人工续接。不放宽 Kimi 所遇
评测白名单。按相同 rubric 核对真实拒绝后的自主恢复、编辑与测试、子报告
整合、AMA 完整收尾及准确报告；缺失直接保留，不以事后测试代替模型闭环。
原文与新账本存 OS Temp 同名实验并保留两个完整性校验副本，累计历史不清零。

r2 的首请求实际返回 HTTP 401/error 1000“身份验证失败”，仅一次物理请求、
无模型输出，Runtime 在 4.370 秒结束。无有效 usage，完整保留 89,764 tokens /
$0.004693 参考预留；不是实际消耗或账单。用户说明当时仅处理账号额度，随后
要求暂停；未继续请求。累计为 641 次、12,855,412 保守 tokens、$0.6553258258
参考费用、26 次未知 usage 预留。认证失败不能算智能失败或 E2E 通过。

用户之后明确更新 key 并授权再次执行。新 r3 离线发现当前 Process 与 Windows
User 的 ZHIPU_CODING_API_KEY 不一致；新评测子进程仅将该变量从用户级环境
加载，不改系统配置、其他 provider 或模型参数，不保存密钥值或其哈希。
`final-native-glm-recheck-20261023-r3` 仍仅一个相同 GLM 复杂 smoke，沿用上述
28 次/800,000 tokens/$0.06 参考费用/10 分钟全部上限和相同执行器、任务、
拒绝与停止策略。先冻结来源变化和同源哈希，再将首个实际请求直接用于案例；
无单独探活，不重跑 Kimi，不因结果不佳追加调用，保留前两次失败账本。

#### r3 补验结果（当前状态更新）

更新后的 key 已由服务端接受。相同最终代码的 GLM 复杂执行闭环现在有实际
覆盖：Runtime **completed / success=true**，无错误。13 次物理请求中根线程
8、子 Agent 5、辅助 0；25 次工具提议、一个继承模型且 filesystem=read 的
子 Agent、同 provider 实际并发最多一。没有在最终报告后追加模型请求。

子 Agent 在 call-3 原样提出目录命令，SDK 在执行前真实拒绝；call-5 自主选择
git diff 和测试文件读取，call-7 有成功结果，四份后续历史的原参数完全一致。
子 Agent 通读兼容约束、改动与测试，真实运行 node --test，call-11 交付报告；
完整报告被原样投递到主线程 call-12，主线程据此完成最终报告与 AMA 收尾。
没有提供替代恢复指令、人工续接或放宽白名单。

主线程修复三个实际 packages 实现、新增八个测试。首次 npm test 为 8 过/
1 失败，原因是其自写测试的 loader 只失败一次却断言第二次也应失败；模型
承认测试错误，修正后实际 npm test 和子 Agent node --test 都是 **9/9**。
独立 oracle **6/6**；相同新测试回放原实现为 **3 过/6 失败**。保护文件、
公共入口、示例及原注释未变。首次失败测试中不一致的并发失败片段被移除，
最终新测试没有单独覆盖“并发失败的多个等待者”，不能声称该子项已专门测过。

报告的八个新增/九个总测试、实际执行与文件范围准确，但仍有低严重性表述
问题：子 Agent 与主线程都把“同租户不同 key 互相污染”也归给原 inFlight
按裸 key 索引的缺陷；原实现对不同 key 使用不同 Map 项，实际问题是不同
租户同 key 共享，以及独立的 pair 编码碰撞。QA 的“所有契约都有测试/无遗留
缺陷”也过满：新测试没有单独的大小写差异或同租户不同 key 并发断言。
原始报告未改写；执行闭环通过不等于报告所有细节无误或总体智能非劣。

全任务已知 input **249,428**（其中 cache read **207,104** 已含入一次）+
output **5,144** = **254,572 tokens**，Runtime wall **169.483 秒**；全部
usage 已知、无未结预留。本地 coding-plan 参考费用 **$0.0129858**，不是
实际账单。加历史后为 **654 次、13,109,984 保守 tokens、$0.6683116258**
参考费用、26 次未知 usage 预留；429/401 的旧预留和失败未被撤销。

3,550 个文件与冻结输入在本次运行结束时无漂移，25 项既有离线回归证据按
相同哈希复用。仅凭据加载和正式记录变化，生产能力与 AMA 策略不变。保持
`recommend-iterate`：GLM 闭环缺口已补；Kimi 上次的评测范围截断、报告细节
限制仍保留，不据此进一步收敛工具。原文、结构化主会话评审、反事实、完整
账本及两个校验副本位于 OS Temp 的 r3 同名实验。

### Kimi 评测拒绝反馈修复与 r4 单例预注册

本次只改 tests 中的评测守卫、Runtime wrapper 和回归，不改生产 SDK、AMA、
工具说明/参数/能力或 provider。原 Kimi call-12 的精确原参数离线比较显示：
旧/新 checkComplexTool 均拒绝该命令；旧 SDK 投影漏掉此类拒绝，wrapper 因而
提前终止整项任务。修复以同一判定连接两处：本地 Node/npm 非测试命令仍被
拒绝，SDK 在执行前返回真实 error tool_result，wrapper 允许模型收到后继续。
原有目录/读取拒绝保留，越界 shell 参数、受保护写入、可写/递归 child、未知
可执行程序、工具/请求/时间预算等仍硬停止。未增加可执行命令或放宽隔离。

按测试先行分别复现 SDK 投影漏拒绝和 wrapper 误终止后修复；精确旧调用只做
纯判定，执行与网络均为零。需求评审另发现可恢复拒绝会遮住复合命令后续的
硬停止原因；补 RED 后延迟非测试拒绝、继续检查余下 stage，优先保留后续硬
违规，原始目录负例不变。35 项最终离线回归通过，包含原生/桥接复合命令及实际只读 child
收到 error、原参数不变、同批合法读取、后续合法测试、父线程整合与 AMA 收尾；
禁止命令的 OS spawn 设有 tripwire 且未被调用。测试 TypeScript 检查通过；
两项改动 helper 的合计 statement/branch/function/line 覆盖率为
89.61% / 84.68% / 86.20% / 97.69%，不代表整个项目覆盖率。

`final-native-kimi-recovery-20261023-r4` 仅补一个
`kimi-code/kimi-for-coding` Layer 3.5 复杂 smoke。任务、原有受控目录负例、
全部 native、只读继承模型 child 和 AMA 策略保持不变；不额外强制模型选择
node -e，不给恢复答案或人工续接。沿用隔离 reviewer、reasoning off/effort low、
lsp false 的既有夹具设置，记忆学习质量不在范围。最多 28 次根/子/辅助请求、
800,000 保守 tokens、$0.06 本地参考费用、4096 输出/次、60 次工具提议、
一个 child、24 根迭代、120 秒/请求和 10 分钟；同 provider 实际并发一。
没有单独探活、自动重试/切换或为通过补跑；未知 usage 完整保留预留。

Layer 1 能证明拒绝和隔离机制，不能证明真实 Kimi 会自主恢复、完成编辑、
测试、子报告整合并准确收尾，因此需要这一个 live 样本。主会话核对全部原文、
真实工具结果、测试与独立 oracle/反事实、保护文件、报告准确性、整个 Runtime
用量和耗时；缺口和归因单列，不以事后检查代替模型闭环，不作统计智能非劣
或与失败前缀的效率比较。先完成代码评审再冻结；新原文/账本与两个副本位于
OS Temp 同名实验，全部历史失败与累计成本保留。

#### r4 实际结果：恢复通过，完整收尾仍缺证据

只执行上述一个 Kimi 样本，没有探活、重试、续接或追加样本。child call-6
原样提出目录负例，call-8 收到 SDK 的真实 error tool_result 后自主选择
`git diff` / `git status --short` / glob；call-10 收到成功结果，原参数未改。
本次没有自然提出非测试 Node 命令，该新增拒绝分支只有离线真实 SDK/桥接
回归证据，不能把目录恢复当作该分支的 live 证据。

主线程修改真实 packages 实现并写出 10 项新测试。错误占位 import 自主重写；
首次实际测试 10 pass、1 cancelled（自写异步测试等待顺序错误），修正后根/子
线程实际 `npm test` 均为 11/11。事后独立 oracle 为 6/6；原样新测试放回原始
实现为 6 pass、5 fail，证明可检出原缺陷。受保护文件/API/原注释均保持。

child call-26 经 send_message 报告并指出一条未自增计数器的恒真断言；root
call-27 已收到其原文并提出正确补强。随后 child 下一请求触及共享 28 次上限，
取消发生在该 edit 的 ToolStart 之前，**补强没有执行**，文件仍保留恒真断言。
因此不能把“提出修正”写成“已修正”。子消息有实质价值且父线程确实接收，
但子任务 end_turn、补强后模型复测、最终报告和 AMA 收尾均未完成。
Runtime 为 interrupted/success=false，原因是评测预算截断，不能记完整通过。

28 次物理请求为根 18、子 9、辅助 1，全部单次请求且 usage 已知；合计
**621,281 tokens**（input 609,254 已含 cache read 552,192，output 12,027），
整个不完整 Runtime **217.640 秒**。冻结 coding-plan 本地参考核算 $0.003226675，
不是账单，未结预留为零。含历史累计登记 682 次、13,731,265 保守 tokens、
$0.6715383008 参考费用、26 次未知 usage；以前失败和证据缺口继续保留。

主会话发现 child 将新增测试数误报为 9（实际 10，总数 11 正确），且“全部契约
均被测试覆盖”表述过满：恒真断言不能证明 client 重复命中，大小写隔离亦无
显式断言。原报告不改写。请求增多还包括模型自主的 Todo、两阶段消息协调、
测试自修及计数来回修正，不能归因为工具精简或证明智能退化。保留最小评测
修复与当前产品默认，建议 recommend-iterate；本轮停止付费验证，下一次若
补完整收尾，须先按现有 raw 重新预注册合理的整体预算，不人工续接本例，
不改 AMA/隔离或增加固定流程，也暂不继续精简工具。完整 raw、主会话评审、
源码/输入哈希及账本在 OS Temp 封存三份，不将不完整前缀用于效率优劣结论。

#### 完整收尾修复与 r5 预注册

用户要求考虑并完备修复后，先核对 r4 的实际时序：28 次已发请求均成功、
没有重复 attempt；最后被拒的是 child 在 send_message 的真实 tool_result
之后继续结束其 turn 的正常请求。共享评测 abort 取消了另一 lane 尚未执行的
修正。这个上限截断不构成生产 Runner 缺陷，也不能将 send_message 自动视为
子任务终结，或给已耗尽预算隐式追加“免费”收尾调用。

新增离线公共 Runtime 回归，保留完整工具和真实文件/进程：只读 child 读取并
经消息指出恒真断言，父线程实际 edit、运行 Node 测试并读到成功回执，随后
确认 child completion 和 AMA 最终文本；同一路径在不足的共享预算下必须保持
不完整。这两项在当前生产实现直接通过，证明无需新增调度器、结束工具或
改变 AMA；此前拒绝反馈修复及禁止命令 tripwire 继续保留。
37 项离线回归与类型检查通过，helper 合计 statement/branch 覆盖率为
89.61% / 85.13%。双轴评审发现并修正 QA 前缺少真实读取成功回执断言的
测试缺口，最终受影响两项重跑通过，无剩余评审发现。

`final-native-kimi-closure-20261023-r5` 仅新跑一个同任务同路由 Kimi Layer 3.5
smoke，不续接 r4。唯一 live 变量为评测预算：共享 40 次请求（含根/子/辅助）、
80 次工具提议、1,200,000 保守 tokens；$0.06 参考费用、4096 输出/次、单 child、
根 maxIter=24、120 秒/请求、10 分钟和同 provider 并发一保持。按 r4 的 28 次
加正常 child end_turn、补强执行/复测/报告及波动余量一次冻结，不为通过再次
扩预算。原始 task/provider 输入、权限、54 native、AMA 与隔离 reviewer 不变。

验收分开记录消息接收、子任务完成、修正提议、真实执行、执行后的模型复测、
最终报告和 Runtime completed/success，不能互相替代。若模型自然再次发现 QA
问题，须核对实际修正与后续复测；不向模型塞入 r4 的答案或恒真断言位置。
逐条读新测试断言及原报告，独立 oracle/反事实仅作旁证。缺少完整收尾仍记
不完整；无探活、自动重试、fallback、外部评判或人工续接。Layer 1 已证明完整
机制，仍需这一例回答真实模型能否在合理总预算下自主完成；不能用于 prompt
优劣或统计智能非劣结论。此前累计 682 次和全部失败/账本不重置。先完成离线
检查和双轴评审再冻结；没有生产改动，不重复已完成的 GLM 样本。

#### r5 实际结果：完整闭环完成

仅执行预注册的新样本，没有续接或再扩预算。Runtime 为 completed、success=true、
error=null。root 拼错绝对读取路径时被 SDK 拒绝后自主修正；child call-11 原样
目录负例被拒，call-12 自主选择 git status/diff 和读取，后续收到真实成功结果。
禁止操作未执行、原参数未改；没有自然提出非测试 Node 命令，不新增该分支的
live 证据。生产实现、AMA、54 native 和全部权限/策略不变。

root 实际修改三个 packages 实现，新增 8 项测试；实际首次 npm test 为 9/9。
只读 child 独立核对并运行 9/9，于 call-16 正常 end_turn；其 completed 报告
原文出现在 root call-17。父线程采纳可选建议，真实 edit 添加换行、emoji 和
孤立高代理项的 key 断言（已按字面量解码核实），并于 call-18 再次实际测试
9/9，最终 call-20 如实报告并完成 AMA，没有最终响应之后的额外请求。
独立 oracle 为 6/6；原样最终新测试在原实现上为 5 pass、4 fail。受保护文件、
API、原注释保持。闭环验收不依赖事后检查替代模型执行。

总计 21 次物理请求（根 14、子 6、辅助 1）、55 次工具提议，同 provider 实际
并发一。20 次已知 usage 共 **434,036 tokens**（input 423,162 已含 cache read
374,016；output 10,874）。一次可选防循环副判断在实际发送后取消，partial
2,200 不能当完整账单，完整 **13,221** 预留继续计入；全任务保守合计
**447,257 tokens**，未结预留为零。整个 Runtime **278.651 秒**，冻结本地参考
费用 $0.002355265 含未知预留、不是账单。没有忽略辅助调用或用量不确定性。
含历史累计登记 703 次、14,178,522 保守 tokens、$0.6738935658 参考费用、
27 次未知 usage；旧失败和 raw 缺失限制不改写。

主会话逐条核对实际读取/修改/测试回执、子报告接收及最终说明，未发现实质性
事实误报。QA 的“完整/不会误报”仍只按有限样本理解；没有独立并发失败 waiter
或同租户不同 key 并发专测，child 亦未重新评审父线程最后补的断言。原报告和
这些范围限制一并保留，不能宣称普遍无缺陷或全局智能非劣。此轮仅补齐执行
与恢复验收；r4/r5 决策轨迹及耗时不同、且含未知 usage，不作效率因果比较。

最小评测修复和新增回归建议保留，完成闭环不需要新增调度器、自动结束子
任务或固定 AMA 阶段。尚未实施任何进一步工具精简或参数隐藏。新完整 raw、
源码/输入哈希、主会话评审与账本在同名 OS Temp 实验封存三份。

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
