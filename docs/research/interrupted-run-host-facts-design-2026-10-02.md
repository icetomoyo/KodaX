# 如何用现有 Host 事实承接 interrupted-run recovery，而不恢复事件日志？

结论摘要：保留主线的**有限恢复摘要、操作证据优先预算、SA/AMA 临时请求注入**，将数据源改为 **Run status + 当前 canonical Session/lineage + 现有 uiHistory checkpoint**。已保存的 assistant draft 与工具结果已经有存储，不需新文件/日志；必要增量是明确来源身份，以及把“显示为 cancelled”和“效果未知”区分。主线 `persistence.replay` 和 event→terminal 恢复不适用当前分支。[来源：`a63feede:src/sdk-runtime.ts:2094–2131,3863–3894,4489–4498,17668–17749`；`a63feede:src/session-view.ts:745–858`；`cad8b658:src/sdk-runtime.ts:8633–8681`；`cad8b658:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:10–16,211–259`。]

研究日期：2026-10-02（Asia/Shanghai）。固定源码快照：当前分支合并前 `a63feede5f4b2bac8a62ddfa687d9b515d8c2021`，主线 `cad8b658797976ce22a4bd70c60d2251d537e542`。下文 `base:`、`main:` 分别指这两个提交；设计子模块固定 `fd73eb81d274cc7dc47bc5d2c1c79928c11c4eaf`。仅研究及新增本笔记；未改产品源码、Git 状态、运行真实 LLM 或 eval。所列测试是建议，未在本轮执行。

## 1. 主线修复的实际意图与不适用部分

- 主线从同 Session、非当前、非 completed 的近期 Run 中挑选最多 5 个候选，读取每个 Run 的 persisted event journal，提取工具操作与 streamed reply，再在下一次 SA/AMA 模型请求中添加恢复说明。它并非自动重跑旧工具。[来源：`main:src/runtime-interrupted-run-journal.ts:136–177`；`main:src/sdk-runtime.ts:8633–8681,10097–10111,10192–10197`。]
- 主线摘要的语义值得保留：已记录结果只是证据；开始却没有结果的操作可能有效也可能无效；回复片段是旧 Run 未确认的输出，可能停在半句话，不能当新用户要求；Thinking 不纳入恢复。[来源：`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:135–188`；`main:src/runtime-interrupted-run-journal.ts:104–133`。]
- 主线已经给定有限预算：总 6,000 字符、最多 3 个 Run、每 Run 最多 16 条已记录操作/8 条未知结果操作、每条 160 字符，最多 3 个回复片段/每片 600 字符；所有 Run 的操作先占预算，片段填剩余空间。这是可复用算法，无需另设配置或调度器。[来源：`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:10–16,211–234`；主线预算修补 commit `931e65c8`。]
- **不能照搬的数据/状态恢复入口：** base 的 `RuntimePersistence` 只保存/读取 Run status、设置、授权等领域事实，没有 replay；base 重启处理从 owner/cleanup 与持久 Run status 裁定 interrupted/unknown。main 的 `replay` 提取和 `recoverPersistedDurableTerminal` 是另一套存储架构，不是本分支缺失方法。[来源：`base:src/sdk-runtime.ts:3863–3894,4754–4828,17668–17749`；`main:src/sdk-runtime.ts:8644–8647,18073–18106`；`docs/SDK_MIGRATION.md:105–107`（base）。]

## 2. 当前已经有的事实与真实缺口

| 事实 | 当前已有数据/边界 | 可直接复用与不能推断的部分 |
| --- | --- | --- |
| Run 生命周期及归属 | status 的 runId/sessionId/productInput/turnId/sessionOrder/terminal/interruptInputs | 候选与 terminalCode 只取 Run status；不能用 checkpoint/事件宣布成功。`base:src/sdk-runtime.ts:2094–2131,2163–2173` |
| 当前分支真实用户输入 | canonical message 的 inputId/inputIds/turnId；lineage 路径 | 用户输入和分支锚已存在；不能要求所有旧/首次保存用户消息已经有 turnId。`base:packages/llm/src/types.ts:167–198`；`base:src/sdk-runtime.ts:11572–11585` |
| streamed assistant 暂态正文 | ClientViewItem/outputId、draft、textRevision、afterInputId；persisted text item | 现成 uiHistory 保留 checkpointed draft，正式提交 outputId 会排除镜像。`base:src/session-view.ts:110–122,159–186,806–818,845–852` |
| 工具请求及结果 | ui tool group 的 callId/name/status/preview/output/startTime/endTime/afterInputId；canonical tool_use/tool_result | 已记录结果已有正文及结束时间；运行中保存被转成 cancelled，不能用该显示状态证明实际取消。`base:packages/agent/src/types.ts:421–445`；`base:src/session-view.ts:219–247,855–858` |
| 保存提交点 | `mutateUiHistory` 在 canonical 同一 serializedWrite 锁内；checkpoint async 合并保存、flush 传播错误 | 用同一 Session 文件及 writer；不添加 journal、recovery DB 或通用事务。`base:packages/repl/src/interactive/storage.ts:4555–4568`；`base:src/session-view.ts:305–324,417–420` |
| 来源更新 | Host 的 outputInputId 随 steer、已消费 queue batch 更新；每个新输出项捕获 afterInputId | 可保持每一项自己的输入归属，不以 Run 最终 turn/input 覆盖旧项。`base:src/sdk-runtime.ts:10493–10496,10590–10592,10645–10651`；`base:src/session-view.ts:96–107` |

### 2.1 助手尾部已经覆盖到哪里

- 当前 checkpoint 已保存 draft 正文及稳定 outputId；canonical 成功保存后在 writer 锁内移除同 outputId 的 draft；恢复保持 distinct outputId，即使两条回复正文相同也都保留。**已有这份已保存正文，不应再复制到 Run status 或新恢复文件。**[来源：`base:src/sdk-runtime.ts:4489–4498`；`base:src/session-view.ts:806–818,845–852`；`base:src/session-view.output-ownership.test.ts:176–198`。]
- 现有保存时机包括 retry、replacement、工具结果、终态；`onStreamEnd` 和 `onToolUseStart` 自身没有 checkpoint。checkpoint 也不是同步提交，因此当前不能声称每个中途崩溃的 token/tool-start 都有持久证据。[来源：`base:src/session-view.ts:159–186,213–247,282–283,305–324`；`base:src/sdk-runtime.ts:4530`。]
- 原规格明确只保证已 checkpoint 的中断部分输出，不承诺尚未保存 token 的硬崩溃恢复，也不逐 token 落盘；新摘要读取能补“下次请求可见”，不能改写这条保证。若仅复用现有存储，缺少 checkpoint 的内容必须留作未知。[来源：`fd73eb81:docs/features/v0.7.97.md:273–279`（子模块文件路径实际为 `v0.7.97.md`）。]

### 2.2 工具“开始”必须解释准确

- `onToolUseStart` 发生在权限/override 门之前，是显示/调度开始事实，不能等同于 OS 目标命令已经启动；已有 `onToolExecutionStart` 在调用 tool.execute 前，属于工具实现执行边界，但它也不是 Bash 进程实际 spawn 的证明。[来源：`base:packages/coding/src/agent-runtime/tool-dispatch.ts:194–215,280–289,497–506`；`base:packages/coding/src/types.ts:544–564`。]
- `persistSessionViewItems` 为结束 spinner 把 running 写成 cancelled，且工具结果会写 endedAt。**显示 cancelled + 无结果/无 endedAt 只能表示缺少已保存结算证据，不能表示已确认取消或无副作用。**[来源：`base:src/session-view.ts:229–247,855–858`。]
- 如果恢复摘要必须区别“尚在批准”和“工具实现已开始”，必要的最小新事实是可选 `executionStartedAt`（或等价开始标记），在已有执行边界写到这一个 checkpointed 工具记录；结果是否已记录优先用现有 endedAt/typed result，而不是再造完整 operation receipt。无标记的旧记录应描述为“已有工具请求，结算证据缺失”，不能事后升级成已执行。[推导与推荐；依据上述两个执行/保存源。]
- 若要求该开始事实在执行外部效果之前**保证持久化**，当前同步 void callback 不够：须让现有执行钩子可 await 并让两条真实执行路径 await 同一个 Host checkpoint/flush，失败阻断 dispatch。仅调用 `checkpoint()` 不会形成此保证。该强保证并非读取既有事实所必需；若此次整合只要求恢复已保存 checkpoint，应保留明确有限保证，避免顺带扩大所有工具的持久事务。[推荐及边界；`base:packages/coding/src/types.ts:556–565`；`base:packages/coding/src/agent-runtime/tool-dispatch.ts:280–289,497–506`；`base:src/session-view.ts:305–324,417–420`。]

## 3. 推荐的最小接入方案

### 3.1 保留主线已有模型请求接缝

SA 在恢复历史后计算一次摘要，只加入请求 wire view，不写入 transcript；AMA 在现有 managed transient context 中加入摘要，保存时已有剥离规则。这两条现成请求接缝可以继续使用；不新增第二个 resume engine，显式 tool Run 不调用模型因而不注入。[来源：`main:packages/coding/src/agent-runtime/run-substrate.ts:998–1004`；`main:packages/coding/src/task-engine/runner-driven.ts:2130–2148`；`main:src/sdk-runtime.ts:10097–10111`。]

**推荐替换主线 Host 收集器，而不是新增 replay：** 在 base `startRecord` 已构造 `runOptions` 的执行边界取得当前 Session 已保存状态，填入主线的有限数据 DTO，接到上述 SA/AMA 入口。对应 base managed/SA 分支是现有运行选择，继续保留 command invocation、workflow、sessionControl 等本分支增量，不整段拿主线执行函数覆盖。[推荐；来源：`base:src/sdk-runtime.ts:10635–10655,10729–10766`；`main:src/sdk-runtime.ts:8633–8681,10097–10111,10192–10197`。]

### 3.2 直接读取现有 Host 事实

建议收集顺序：

1. 从既有 Run status 挑同 Session、非当前、已持久 terminal 且 non-completed 的最多 5 个近期候选，按 sessionOrder。unknown 且无 terminal/未确认 cleanup 的 Run 不伪装成已中断，仍由既有 admission/recovery 边界处理。[推荐；`main:src/runtime-interrupted-run-journal.ts:136–177`；`base:src/sdk-runtime.ts:17673–17685,17729–17749`。]
2. `await sessionViews.flush(sessionId)`，再通过 Host 现有 Session storage/admission 取得最新 canonical/lineage/uiHistory；读取要与既有 Session 短提交/分支约束一致。不能把 flush 或读取失败当作空历史继续宣称完整恢复。[推荐；`base:src/session-view.ts:417–420,431–447`；`base:src/sdk-runtime.ts:4489–4498`；`base:packages/repl/src/interactive/storage.ts:4555–4568`。]
3. 以当前 canonical 分支的真实 `inputId`/`inputIds` 或明确 lineage entry 为锚，再用真实 turnId 归属各工具/回复。候选 Run 的原 productInput 不在当前路径时剔除；同 Run steer/queue 项仍按它自己的 afterInputId 筛选，不强制所有证据继承初始 input。初始 user 已保存却尚无 turnId 的情况，优先已有 input 身份，不能套用主线“只有 activeTurnIds”检查。[推荐；`base:src/sdk-runtime.ts:11572–11585,10493–10496,10590–10592,10645–10651`；`base:packages/llm/src/types.ts:189–198`；对照 `main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:32–48,248–257`。]
4. 从 **uiHistory 原始已保存记录** 取工具和 assistant draft；不能取公共 observe 的 150 项/截断正文当全部证据，不能用 `restoreSessionViewItems` 的显示归并来裁定生命周期。canonical 中已有完整工具结果/已提交 outputId 的对应记录移除，其余保留显式来源顺序。[推荐；`base:src/session-view.ts:601–624,745–818`；`base:src/sdk-runtime.ts:4490–4496`。]
5. 工具已有结果时提供有界首行及真实状态；缺结果时提供未知结算的明确说明。只保留 `type === assistant` 且未 canonical committed 的输出尾部；Thinking、child live mirror、sidecar/client-only notice 不混成助手承诺或新用户要求。[推荐；`base:src/session-view.ts:93–95,110–122,219–247,845–858`；`main:src/runtime-interrupted-run-journal.ts:62–133`；`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:135–188`。]
6. 使用主线预算规划器，让工具证据先占各 Run 的预算，然后片段填剩余空间。说明“由 Host 已保存事实/checkpoint 重建”，删掉“来自 event journal”措辞。摘要本身不保存、不修改 Run terminal、不触发任何旧工具 replay。[推荐；`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:166–188,211–259`；`main:packages/coding/src/agent-runtime/run-substrate.ts:998–1004`。]

**不要沿用 main 按 terminal runId 永久缓存 derived evidence。** main journal 终态后不可变，但 base terminal 才触发异步 checkpoint，canonical 也可能随后排除 draft。一次读到空/旧结果就按 runId 缓存，会永远漏掉后来保存事实；直接重算已经有界的少量记录更小，不需要额外缓存协议。[推荐；`main:src/sdk-runtime.ts:8634–8653`；`base:src/sdk-runtime.ts:4490–4496,4530`；`base:src/session-view.ts:305–324`。]

### 3.3 必需新增字段和不必新增字段

| 项目 | 建议 | 理由与源 |
| --- | --- | --- |
| checkpoint 的明确 Run/turn 来源 | 为 text/tool_group 的内部 checkpoint 数据加可选 `runId`、`turnId`（名称可沿现术语）；记录时绑定 Host 实际上下文，并透传保存/恢复 | 现有 assistant item ID 只含 Session/outputId，afterInputId 也不能唯一确定同输入的所有 Run；原类型没有 Run/turn 来源。`base:src/session-view.ts:43–44,83–107`；`base:packages/agent/src/types.ts:398–445` |
| assistant 的输出身份 | 复用现有 outputId；恢复 reply DTO 可增加可选 outputId，缺失时用明确的有限 legacy 规则 | main `missingReplies` 按 normalize/substring 去重会吞掉不同 outputId 的同文消息；base 有真实持久化反例保证两者并存。`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:71–91`；`base:src/session-view.output-ownership.test.ts:176–198` |
| 工具的执行开始证明 | 仅在要求区分 permission 阶段/implementation 执行时加一项可选 `executionStartedAt`；结果结束复用 endTime | startTime 是显示开始，running 保存被改 cancelled；无需单独恢复事件列表。`base:src/session-view.ts:219–247,855–858`；`base:packages/coding/src/agent-runtime/tool-dispatch.ts:202–215,280–289` |
| 同 callId 的重复调用 | 匹配 `(runId, owning turnId, toolUseId, 该 turn 内出现次序)`；如果 checkpoint 会覆盖合法重复调用，才为现有记录增加最小 occurrence/稳定 invocation 身份 | main 已明确 callId 跨 turn 不唯一、每个结果只消费一次；base live tool item 目前仅 `${runId}:tool:${id}`，会覆盖同 Run 重复 id。`main:packages/coding/src/types.ts:1894–1905`；`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:52–63,95–111`；`base:src/session-view.ts:229–246` |
| 操作/result 全文 | 不复制，新摘要取现有 canonical/checkpoint 的有界摘录 | uiHistory 已有 preview/output；canonical 已有内容，不新建 stores。`base:packages/agent/src/types.ts:427–436`；`base:src/session-view.ts:855–858` |
| assistant 尾部存储 | 不新增；只读取已有成功 checkpoint；必要时在 `onStreamEnd` 等真实阶段补一次已有 checkpoint | 当前流结束无保存调用；不能据此建设每-token journal。`base:src/session-view.ts:213–218,305–324,845–852`；`fd73eb81:v0.7.97.md:275` |
| public Product Client 方法 | 不新增 recovery RPC/operation receipt | Host 执行时内部补上下文；消费者继续 observe/history/readItem/runs.await。`base:packages/coding/src/client-contract.ts:123–155`；`base:docs/SDK_MIGRATION.md:105–107` |

字段仍是纯可选数据，低层 coding 包可由 embedder 提供已保存证据；不让 coding 依赖 root Host/REPL 文件实现。新 Client 不需要暴露可写存储或调恢复事件游标。[推荐；`base:src/sdk-client.ts:2–7`；`base:packages/coding/src/client-contract.ts:94–155`；`base:docs/features` 的设计决策为子模块 `fd73eb81:v0.7.97.md:197,379`。]

## 4. 最小确定性公开入口回归建议

优先加在一个 `src/sdk-client.interrupted-run-recovery.test.ts`，沿已有真实 IPC Host/ProductClient + 本地确定性 HTTP Provider 接缝，覆盖 SA/AMA；断言下一次真实 Provider 请求内容和工具实际调用次数，而非仅测 helper 输出字符串。已有 HTTP→IPC→commit→restart 测试可以复用隔离 home、provider、cleanup 方式。[建议；`base:src/sdk-client.output-ownership.test.ts:1–20,27–44,70–118`；`base:src/sdk-client.interactions.test.ts:181–208`。]

| 场景 | 关键确定性断言 | 为什么必要 |
| --- | --- | --- |
| 工具实现已进入，结果未保存；中断后下一次 input | 实际效果计数是 1；下次请求含 result-unknown 提醒及本 Run/tool/turn 归属；无自动再次执行，Run 状态仍取原 status | 新数据源必须承接主线防重复副作用意图。`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:178–185`；`base:packages/coding/src/agent-runtime/tool-dispatch.ts:280–289` |
| 结果 checkpoint 成功，但 canonical 工具结果尚未提交 | 下次请求保留结果首行/状态，不能只剩 started；canonical 后续提交同结果后不再重复恢复 | 现有 uiHistory 承接正式历史提交间隙。`base:src/session-view.ts:238–247`；`base:src/sdk-runtime.ts:4490–4496` |
| assistant draft checkpoint，之后发生失败/Stop | 恢复只含 assistant 的已保存尾部；Thinking/child mirror 不出现；用户正文及 transient recovery 不被写入新 canonical message | 区分思考、证据、用户意图。`base:src/session-view.ts:93–122,845–852`；`main:packages/coding/src/agent-runtime/run-substrate.ts:998–1004` |
| 不同 outputId、同文；replace/retry | 已 canonical 的 outputId 被省略，另一个同文 partial 仍在；旧 replace 片段不复活；不靠 includes 去重 | base 已有真实保存反例。`base:session-view.output-ownership.test.ts:176–198`；`base:src/session-view.ts:159–186` |
| 同 callId 跨 turn/同 turn 多次；中间一个结果已 canonical | 每个 canonical result 只消掉对应 occurrence；后一个未知/未提交结果不能被前结果吞掉 | 主线 pairing 修补不能在 Host 来源适配中失效。`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:52–63,95–111` |
| 初始 input 已 canonical 但尚无 turnId；steer/queued input 后中断 | 初始 inputId 可证明在当前分支；每项归属其实际 afterInputId，不随最终 turn/source 漂移 | base admission 先保存用户且不带 turnId；来源随投递更新。`base:src/sdk-runtime.ts:11572–11585,10590–10592,10645–10651` |
| rewind/selectBranch/fork | 已离当前路径的旧 Run/input 不进入请求；fork 不能把父 Session 的 Run 证据伪装为新 Session 所有 | rewind 清 uiHistory；fork 可能复制显示历史，必须按 Session/branch 来源过滤。`base:packages/repl/src/interactive/storage.ts:5267–5271,5387–5399` |
| checkpoint 保存失败、后来同 Session 成功恢复 | flush/读取报错明确；不能把失败当空完整历史，也不能因别 Session 保存成功清除故障 | base 已有 checkpoint 故障保证。`base:session-view.checkpoint.test.ts:4–39`；`base:src/session-view.ts:305–324,417–420` |
| 多 Run/大量摘录预算 | 至多 6,000 字符、至多 3 个 Run；older/newer 两边工具证据优先，摘录不能挤掉已容纳操作；省略有提示 | `931e65c8` 的实质修补必须保留。`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:10–16,211–234` |

另用已有邻源单测检查 `persistSessionViewItems` 的新增 provenance 透传、unknown/finished 区分及 Thinking 筛除；不需要为这些数据字段另建测试框架。硬崩溃测试只在新增“执行前落盘”保证时加入真实 Host 子进程故障门闩；如果只覆盖软中断，不能在报告中把它写作硬崩溃恢复。[建议；`base:src/session-view.output-ownership.test.ts:176–198`；`base:packages/coding/src/types.ts:556–565`；`base:src/session-view.ts:305–324`。]

## 未证实

- 当前既有 checkpoint 能恢复纯 assistant 流式中途硬崩溃之前的全部尾部：保存时机明确不支持这个结论，原规格也不承诺未保存 token。[来源：`base:src/session-view.ts:190–218,305–324`；`fd73eb81:v0.7.97.md:275`。]
- `onToolUseStart` 或 persisted cancelled 能证明目标命令已开始/已经取消：它们的真实生成顺序与转换规则否定该推断。[来源：`base:packages/coding/src/agent-runtime/tool-dispatch.ts:202–215`；`base:src/session-view.ts:855–858`。]
- 任意旧 checkpoint 都能被精确归属到 Run/turn：原类型缺少字段，assistant id 也不含 Run；没有来源就只能保守处理，不能从文本/时间猜补。[来源：`base:packages/agent/src/types.ts:398–445`；`base:src/session-view.ts:43–44,118–122`。]
- 本笔记建议已通过测试或修改了当前实现：未执行实现与测试；以上只是固定源码研究及具体建议。

## 未解问题

1. 本次是否承诺“工具执行前必须完成开始证据落盘”，还是仅恢复成功保存的 checkpoint？前者需要 await 执行钩子/flush，并增加失败阻断回归；后者不需要扩大底层 callback 承诺，但摘要措辞必须严格区分 request/implementation/target effect。[来源：`base:packages/coding/src/types.ts:556–565`；`base:packages/coding/src/agent-runtime/tool-dispatch.ts:202–215,280–289`。]
2. 旧无 run/turn 身份的 checkpoint，要完全跳过模型恢复，还是仅在已证明同 Session/input 的情况下提供明确 legacy 片段？现行资料无法让旧缺来源数据变成精确证据，应按产品兼容要求决定，不能自动猜测。[来源：`base:packages/agent/src/types.ts:398–445`；`base:src/session-view.ts:168–186`。]
3. 150 项 checkpoint 中更早的未知结果证据是否需保留到当前 Run 终态？此上限是既有显示持久窗口；先按主线近期候选/摘要预算验证真实丢失场景，再决定是否为本 Run 保护必要记录，不能预先添加无限恢复存储。[来源：`base:src/sdk-runtime.ts:4490–4496`；`main:packages/coding/src/task-engine/_internal/interrupted-run-recovery.ts:10–16`。]
