# v0.7.97 产品入口自动化验收

本指南验证构建后的产品入口。组件、协议和 SDK 单测继续保留，但不替代这里的真实进程与终端操作。

## 2026-10-28 任务报告去重复审补充

针对下节首轮提交 `d244ddfa` 的后续复审，先用公开 restoreSessionViewItems 复现
同文独立 event/info 丢失（2 项应保留，实际仅 1 项）。入口不再按正文全局删除；
旧展示须通过 inputId（含 inputIds 别名）关联同一任务消息、来源 Turn 无已知冲突，
且正文等于完整封装或规范报告正文，才可认定为镜像。来源不足、同 Turn 但无消息
身份、消息身份不同、Turn 冲突的记录均保留；不将子任务 runId 当成 Host Run 身份。
不能确证的旧封装允许作为中性展示留下，不能为消除视觉重复而删除未知事实。

定向回归还先后 RED 捕获两条相邻路径：历史对齐把同文 event 合入任务报告并借用
其时间，以及确证身份的正文镜像仍重复。任务报告不再参与普通文本对齐；确证镜像
同时支持完整 wire 和规范报告正文，仍保留身份前提。未增加接口、配置或历史分页。

最终源码/测试类型检查、workspace/bundle 构建、14 个 SDK 声明入口和 Node-free
Product 类型消费者检查通过。相邻回归 25 文件 / 327 项（2 workers、retry=0）全部
通过；JSON 为 `%TEMP%/kodax-task-notice-regression-results.json`。其中定向 3 文件 /
60 项的 restore-history.ts 覆盖率为语句 94.69%、分支 83.64%、函数 98.07%、行
96.56%，不是全仓覆盖率。构建后 `node --test tests/bundled-task-results.test.mjs`
1/1 通过：真实独立 daemon、IPC 和两次启动中，同文独立通知及无身份展示均保留，
完整封装和正文镜像均去重，四份报告身份/状态/顺序及全文哈希保持一致。

后续独立双轴复审：Standards 0 项；Spec 最初发现正文镜像遗漏，补回归并修复后
最终 0 项。该结论仅覆盖本修复，不替代完整发布矩阵；未发布 npm 或更新 Space。

## 2026-10-28 Product 任务报告

本轮在 `0d723c6e` 后修复任务报告投影；属于 alpha.10 发布后的源码修改，不据此
声称新 npm 包或 Space 已交付。复用现有 `_taskResult/_taskResults`，新增共享的报告
读取投影，未改变 canonical 消息、执行状态机、权限策略或历史分页接口。

Product `ClientViewItem.taskResult` 提供 source、已知的 taskId/runId/title/artifactRefs、
completed/failed/cancelled/unknown 和 `reportFormat: 'markdown'`；正文由 item.text
及原有全文读取方法交付。各报告是中性 event，不将子任务失败转换成主 Run 的
Provider 错误。跨显示面 item ID 仍不可互换，任务字段保留逻辑身份。旧 Actor 的
mailbox 投递 id 不冒充 Turn ID；缺状态不从完成标签或 `failed:` 文本推测。

```text
npx vitest run packages/agent/src/session-lineage/task-results.test.ts src/session-view.task-results.test.ts src/sdk-client.task-results.test.ts packages/repl/src/session/public-api.test.ts --maxWorkers=2 --retry=0
```

最初的单项回归确实 RED：输出仍是 XML，缺少任务元数据。扩展测试另捕获历史
超大项读取返回封装、显示身份依赖时间，以及旧投递 ID 被错误当成任务 ID；这些
均修复后复验。多任务、相同正文的不同任务、两个 metadata 字段的重复引用、旧
UI 封装快照、显式失败/取消、未知旧状态和普通用户 XML 文本均独立覆盖。

独立需求复审再捕获并补回归：混合新旧通知时旧报告丢失、旧 interrupted 终态未
映射取消，以及通知仍按 XML 锚定造成次序变化。另用真实队列测试确认模型侧的
预算封装可能重排，显示仍以结构化 metadata 顺序为准；缩写后的无封装文本不
额外制造未知任务。配对也拒绝明确的 source/runId/taskId 冲突，避免吞掉另一份
同名任务报告；缺失字段仅在无已知冲突时兼容。以上已分别 RED → GREEN。

真实 Product Client/IPC 用例通过受信任 MessageQueue 注入确定性的任务结果，使用
实际 AMA Run、规范历史、Host socket、公开 Client、重连与 Host 重启；Provider
仅由离线固定响应替代，不是付费模型评测或真实子任务业务质量验收。单条和三条
报告顺序一致、view ID 恢复稳定，历史与实时元数据一致，主 Run 始终 completed
且无 failureDetail。报告包含 Markdown、代码、文字实体及大于 128 KiB 的 Unicode
正文，经 readItem/readHistoryEntry 的完整重组 SHA256 相等。旧历史也经过 IPC。

共享报告读取模块的最终定向 V8 覆盖：语句/行/函数 100%，分支 92.17%。原有 CLI
展示所有权保持，未因 Product 的新投影而额外展示子任务全文。没有来源的独立
UI-only 文本不能提供可靠任务事实；保持中性，不猜测旧任务成功。

最终源码及测试类型检查、workspace/bundle 构建、14 个 SDK 声明入口和 Node-free
Product 类型消费检查均通过。相邻回归 28 文件 / 333 项（2 workers、retry=0）
全部通过，无跳过或未处理错误；JSON 为 `%TEMP%/kodax-task-report-final-results.json`。
完整 bundle 门禁 51/51，包括构建后公开 SDK 与真实独立 daemon 的 IPC、旧历史、
四份报告及 Host 重启，两个读取面的全文哈希一致。该新用例已加入 test:bundle。
最终独立 Standards / Spec 复审均无剩余 finding；不以这些定向结果替代完整发布矩阵，
也不宣称 Space 已消费新字段或已发布 npm。

## 2026-10-27 本地 Skill 失败分类

基线 `6d101b59` 的真实独立 daemon 回归先 RED：Main 已通过自己的可信路径准备
`draft-response`，daemon 未注册该来源；Provider HTTP 请求数为 0，Run 却返回
`provider / transport / provider_error`。新增本地 Skill 错误事实后，Runtime 结果、
事件、状态、诊断、重启读取及 IPC 保留同一分类；产品 `/client` 的 await 适配器
漏传 failureDetail 亦经真实链路 RED 后修复。Skill 重载和 enforceAtRuntime 保留。

稳定码为 skill_not_found、skill_not_registered、skill_registry_unavailable、
skill_policy_restore_failed，分类为 local_execution，阶段为 skill_load / skill_policy。
安全提示仅含安全技能名和固定原因，不回传路径或原始 IO 报错，不带 Provider HTTP
事实。扫描失败与未找到分开：保留既有 DiscoveryResult.errors 的非 ENOENT 错误，
通过可选 discoveryIncomplete 留存不完整发现；已发现技能仍可用，来源修复后重新
发现可清除该事实。真实来源不是目录、策略文件在发现后损坏、Runtime 绑定包装层
的 wildcard/显式名单均有回归，相关新增断言先 RED 后 GREEN。

`tests/sdk-skill-failure.test.ts` 在 system tier 启动独立 Host（验证 PID 不同）：
未注册时请求数 0，可信注册后同一调用完成；重连及 Product Client 仍保留错误；
真实 HTTP 401、429 和连接中断继续分类为鉴权、限流和网络错误，Provider 错误体
故意包含 skill_not_found 字样，不能据此误判本地错误。测试仅使用本机 HTTP fixture，
无付费模型请求；Host、Windows Job 和 HTTP 服务均收尾。

第一轮 Provider 回归因沿用生产限流恢复等待达到 120 秒测试预算；保留失败记录，
fixture 改用既有 timeouts.llm.maxRetryDelaySec=0.01 后完整通过（21.55 秒测试时间）。
不修改生产重试默认值。成文规范与需求双轴复核的发现均已修复，最终各 0 项。
最终重建后的相邻门通过：16 文件、544/544 passed、0 skipped，两 worker、retry=0，
耗时 246.61 秒。其中 Runtime 文件完整执行 336 项，包含普通提问与权限边界；
独立 daemon 完整用例在该门内再次通过。构建包门 EXIT 0，46/46 passed、0 skipped。
源码/测试类型检查、package/bundle 构建、14 入口 DTS 与无 Node ambient types 的真实
Product Client 消费 fixture 均通过。核对 2783 个源码/配置与 3748 个构建文件的
SHA-256，与门开始前冻结快照完全一致。此次未重跑全仓门，不将下节历史完整门
结果算作本增量验证。本记录不代表 Space 接入或新版本发布。

```powershell
npx vitest run tests/sdk-skill-failure.test.ts --retry=0
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:bundle
```

## 2026-10-27 SDK 一致性与提交前验证

核对源码连接器、Host 启动透传、17 个公开 SDK 子路径、生成声明以及无 Node
ambient types 的真实 `/client` 消费者。消费 fixture 覆盖 initializing/phase、
ClientHostStartupPhase、`userInputTimeoutMs: 0`、退出 recovery.state/nextAction 和
独立的历史 cleanup.state。类型检查和 14 个 SDK 入口声明构建通过。
README/中文 README、SDK 迁移、Client/Space 接缝、HLD/DD、内置手册、发布准备和
设计子模块同步；alpha.10 明确为开发/发布准备，不将提交推送冒称标签或实际发布。

本轮完整门首轮 16955 passed / 1 failed / 90 skipped / 19 todo，无 worker 异常。
唯一失败为 SDK 问答回归在等第一条 pending 时触发 expect.poll 默认 1 秒预算
（`sdk-client.interactions.test.ts` 原第 363 行），尚未收到请求即断言失败。
该用例两次 IPC 等待与相邻用例对齐为 15 秒，总测试预算 45 秒；原因、Host-only
timeout、旧 ID 拒绝、新请求保留和正常 Run 完成断言均保留。不修改生产提问期限。
同时补齐内置手册清单漏写的 `/client`，该增量与问答文件复验 66/66。
Standards 最终复审 0 项；Spec 的一项设计文字歧义已澄清，最终 0 项。
首轮日志保留；最终冻结门结果见下。

原四 worker 复验为 16954 passed / 2 failed：问答文件已全部通过；退出回归在
Provider entered 的默认 1 秒等待失败，已仅对齐为 15 秒；终态缓存保留用例则
在 Windows 临时 Session 文件的 atomic rename 处抛出 EPERM，并非测试超时。
持久化生产代码及其重试/安全策略未改；该 1005 次 Run 的保留用例独立复验通过，
退出文件 4/4 通过。考虑本机 I/O 争用，最终完整门采用 `--maxWorkers=2 --retry=0`，
保持同一 1193 文件集合，不用跳过或自动重试掩盖上述失败；两轮记录均保留。

最终冻结完整门通过：1193 文件中 1189 passed / 4 skipped；测试为
16956 passed / 90 skipped / 19 todo，0 failed，JSON success=true。
配置为两 worker、`retry=0`，耗时 1465.95 秒；Runtime 文件完整执行 332 项，
包括 1005 次 Run 的缓存保留用例。没有为本轮新跳过用例，亦无真实模型请求。
此前四 worker 的 Windows EPERM 记录保留，不能据本机复验宣告跨平台验收完成。

最终构建包门 EXIT 0，46/46 passed、0 skipped，包含实际 SDK 初始化阶段和
Windows 退出/重启回归。真实无 Node ambient types 的 `/client` fixture 再次编译
通过，主仓库与设计子模块 diff check 通过。核验 2782 个源码/配置文件及 3745 个
构建文件的 SHA-256，与完整门开始前快照完全一致；验证后只补写本文验收记录。
源码/测试类型检查、package/bundle/DTS 构建与离线 eval 已通过，未付费调用模型。

## 2026-10-27 Host 内部初始化进度

`ClientStartupProgress` 新增 `{ stage: 'initializing', phase }`，复用现有 callback、
CLI 动画与 elapsed time。固定阶段为 modules、extensions、runtime、recovery、mcp、
sessions、a2a、listener，分别对应真实模块/扩展加载、Runtime 装配、旧子进程及任务
恢复、MCP 预热、会话资源恢复、Agent 连接和 Client 入口初始化。快速阶段可能合并；
不为展示增加停顿，不将这些观察当作百分比或 Ready。

新 Host 仅在有进度观察者时向既有 bootstrap.log 写少量固定阶段记录。父进程
复用原就绪轮询，每次最多读取尾部 4 KiB，并匹配本次启动 UUID 和 Host PID；
不新增 RPC、健康探测、定时器或运行时文件，不改 owner 状态。无 observer 时保留 undefined
穿过 SDK 包装层，不生成启动 ID，也不读写进度记录。重复阶段去重，坏记录忽略；
读取失败只诊断一次并停用该次日志观察，不影响原有就绪、超时、停止或清理。

TDD：新文案映射、启动轮询透传、实际 SDK 启动、受控慢 MCP 和旧构建包的
进度断言分别先 RED。慢 MCP 用例确认服务仍在 initialize 时显示 mcp，而不是
extensions，且不能提前报告 ready；明确 release 后才继续启动并完整关闭测试 Host。
无 observer 和读取失败、旧 ID/错误 PID/无效或半条记录、重复阶段、永不返回的
观察回调都有定向覆盖。Windows 目录零长读取未触发预期错误，故障注入改为
跨平台的非法路径；没有为该夹具修改生产读取行为。

源码初轮相邻门 187 passed / 3 failed：仅旧 owner-exit 通知数组不认识新增阶段。
保留原顺序、旧 PID 已退出、新 owner 就绪等断言，同时验证 initializing；最终
12 文件 190 passed / 1 平台限定 skipped。类型检查、包、bundle 与 14 入口 DTS
构建通过；Standards/Spec 独立复审各 0 项。

重建后构建包门 EXIT 0，46/46 通过、0 跳过；实际 packaged SDK 收到初始化阶段，
仍在认证/能力检查后才收到 ready；无观察者的非交互 CLI 不产生阶段记录。实际
Host 退出、重启和 Windows Job 相关构建包回归均通过。源慢 MCP 用例还验证解除
阻塞后启动 Promise 成功并最终报告 ready，不只验证中途显示。

```powershell
npx vitest run src/sdk-client.startup.test.ts src/runtime-daemon/process.test.ts src/sdk-runtime-daemon-upgrade.test.ts src/runtime-daemon/process.owner-exit.test.ts src/sdk-runtime.launcher.test.ts src/sdk-client.mcp-elicit.test.ts src/sdk-client.command-mcp-elicit.test.ts src/sdk-client.interactions.test.ts src/kodax_cli.sandbox-startup.test.ts src/cli-startup-progress.test.ts src/kodax_bootstrap.test.ts src/integration-hot-reload.test.ts --retry=0
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm run test:bundle
```

以下完整门和前次补漏结果保留各自历史范围，不作为本次进度增量的完整门结果。
本次验证不发送真实模型请求，不停止用户默认 Host；未发布 npm 或改动 Space UI。

## 2026-10-27 MCP SDK 桥接首次 UI 异常补漏

此前只测了直接 MCP reverse 入口，漏掉 SDK 的 `raceElicitAbort`：异步 UI 回调
失败被改成字符串 `"cancel"`，确认框和 URL 授权将它当作未选中 Approve，
错误地回复 `decline`。本次仅让该 Promise 的拒绝分支保留原异常，由已有 MCP
外层统一转换为协议 `cancel`；不新增状态或结果类型，用户明确拒绝仍为 `decline`。

新增 `src/sdk-client.mcp-elicit.test.ts` 两项回归，经过真实 SDK Run、共享 stdio
MCP 服务与 UI 回调，修复前稳定复现 `elicit:decline:`，期望为 `elicit:cancel:`。
修复后确认框和 URL 均返回 `cancel`；同一 Session 的后续明确 Decline 仍为
`decline`，每个回调只执行一次，Run 正常完成，pending 请求清空。该文件 3/3；
相邻 9 文件共 156 项通过，等待期限/超时/迟到回调定向 9/9（其余 323 项按名称
过滤未运行），源码与测试类型检查通过。Standards/Spec 本轮增量复审各 0 项。

```powershell
npx vitest run src/sdk-client.mcp-elicit.test.ts src/sdk-client.command-mcp-elicit.test.ts src/sdk-client.interactions.test.ts src/sdk-runtime.interactions.test.ts src/runtime-daemon/client.test.ts src/one-shot-questions.test.ts src/one-shot-permissions.test.ts packages/coding/src/capabilities/providers/mcp-reverse.test.ts packages/coding/src/tools/ask-user-question.test.ts --retry=0
npx vitest run src/sdk-runtime.test.ts -t 'returns unanswered when a late|ignores a superseded prompt failure|keeps AskUser unbounded|settles ordinary questions' --retry=0
npm run typecheck
npm run build:bundle
npm run build:dts
npm run test:bundle
```

bundle 与 14 个 SDK 入口 DTS 已重建。下节 16949 项的完整门记录对应本次补漏
之前的冻结版本，不作为本增量的完整门结果。Space 仍需升级依赖并消费
`recovery.state`；本 SDK 修复不等于 Space Renderer 已完成接入验收。

重建后的 `npm run test:bundle` EXIT 0，46/46 通过（含实际 Windows 退出/重启
两项），无跳过。与上轮完整门冻结源码比较，仅 SDK Runtime 的上述拒绝分支和
本次真实桥接测试文件变化；未改动退出恢复、权限审批或等待期限实现。

## 2026-10-27 整体评审后的相邻回归修复

修复范围：未回答的 MCP 空表单/URL 返回 cancel；旧任务提示不代选 Resume/Restart、
保留旧检查点；首次 UI 回调错误作为工具错误交给模型，回答/超时/Stop 已结算后的
迟到错误不改写结果；客户端 Stop 只标记 expectedRunId，不对整个 Session 留下屏障；
生成恢复快照保留 maxConcurrentThreadsPerSession。权限审批和默认无限等待保持独立。
复审追加：部分交付的 Session Stop 固定边界也约束生成恢复。Host 复用已有持久
Stop 记录，仅阻止其中列出的 Run，以及属于该 Run 的 Actor/child 恢复；后续 Run
不受旧边界影响，Stop 修复/查询入口不增加限制，不新建客户端 Session 状态机。
同一 Stop 请求在重启后重试时，通过已有 runs.abort 路径核验 owner；只有已验证
死 owner 的有效检查点允许接管并停止，活跃或无法确认的 owner 继续拒绝。
`ensureKodaXClient({ userInputTimeoutMs })` 将已有启动策略透传给新 Host，0 表示
无限等待；已有 Host 的策略不变，不增加 config.json 设置。

新增真实 MCP、检查点文件、SDK 工具结果、重连与启动器类型用例先 RED 后修复。
classic 两项旧 cancel 断言同步为 skip；容量恢复测试保留一次工具/一次恢复请求
断言，等待明确 blocked 状态并在 finally 中 abort、唤醒和等待 pending，避免污染
下一用例。此前 16921 passed / 4 failed 的完整门记录保留在本地评审产物中，
不将本轮定向通过回写为此前全绿。

```powershell
npx vitest run packages/coding/src/capabilities/providers/mcp-reverse.test.ts packages/coding/src/checkpoint.test.ts src/runtime-generation-recovery.test.ts src/recovering-runtime-client.test.ts src/recovering-runtime-launcher.test.ts src/sdk-client.interactions.test.ts packages/repl/src/interactive/classic-plane-interactions.test.ts packages/coding/src/agent-runtime/run-substrate.capacity-accounting.test.ts
npx vitest run src/sdk-runtime.test.ts -t 'returns unanswered when a late|ignores a superseded prompt failure'
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
npm test -- --retry=0
npm run test:bundle
```

AskUser eval 改用生产工具定义并新增无 required 标记的用例；新增 continuation-memory
版本化用例使用生产提示与真实 helper，默认不调用模型。两份 eval 的离线入口以
各自 `KODAX_*_PROBE=off` 运行；不将离线通过称为模型质量验收。本轮不自动跑付费
eval、tag、Release 或 npm 发布。最终门禁结果在完成后追加。

本轮完整门首轮为 16945 passed / 2 failed：失败仅在未改动的 MCP transport
夹具，详细原因均为 Node Fetch 的 `bad port`（随机端口落入 Fetch 禁用集合），
不是环境变量展开失败；单文件复验 25/25。新增确定性 bad-port 注入先 RED，再让
夹具启动前检测并仅对此错误重新绑定端口，其他网络故障照常失败；不修改生产
transport 或增加业务重试。原完整门日志保留，最终冻结门另行记录。

第二轮冻结门为 16911 passed、0 项断言失败，但存在一个 worker 意外退出，
进程退出码为 1；MCP reverse 文件的 38 项未被收集，不能记为全绿，即使 JSON
报告的 success 为 true。该文件独立复验 38/38；本机 Application/System 日志
未发现对应崩溃记录。保持源码和构建不变，再以原四 worker、retry=0 完整复验，
临时父进程诊断仅记录 worker 的退出码，不注入测试子进程或修改依赖。

最终冻结复验 EXIT 0：1189 文件通过、4 跳过；16949 项通过、90 跳过、19 todo，
0 失败、0 unhandled error，MCP reverse 38 项全部收集并通过。上一轮 worker 退出
未复现，原因仍未确定；保留失败日志，不将其描述为已修复的产品缺陷。源码/测试
类型检查、workspace 包、bundle 和 14 个 SDK 入口 DTS 构建均通过。冻结前后的
2781 个源码/配置文件、3745 个构建文件及 HEAD 哈希一致。

Standards/Spec 独立复审最终均为 0 项待处理问题。额外真实 Runtime 探针验证：
活 owner 拒绝旧 Stop 修复、Host 退出后旧 Run 不被自动恢复、原 Stop 请求可确认
关闭两项固定成员、替换 expectedRunId 被拒绝，后续新 Run 可恢复；旧 Run 的
Provider 调用为 0，后续新 Run 恰好调用 1 次。

最终 `npm run test:bundle` EXIT 0，46/46 通过、0 跳过，包括实际 Windows Host
退出、重复连接与重启恢复。构建包验收后的源码/构建哈希再核对一致。以上为
本机 SDK/Host 验证，不替代 Space Renderer 接入 `recovery` 后的人工验收，
也不声称完成跨平台覆盖率或付费模型质量验收。

## 2026-10-26 one-shot 普通问题结算回归

`a92a9577` 改为普通问题正常 unanswered 后，相邻 one-shot 的三项旧断言仍要求
`cancel` 字样；实跑为 3 failed / 1 passed。one-shot 也仍发送旧 cancel，导致模型
只看到 `skipped`，丢失非交互环境无法回答的原因。按既定“只有 Stop 中断 Run”
语义修复：发送 `{ kind: 'skip', reason: 'non_interactive' }`，由 Host 结算并将
`unanswered/non_interactive` 正常工具结果交给模型。用户主动跳过为 `skipped`，
Host 期限到达为 `timeout`；客户端不能将 skip 伪造为 timeout。

回归边界：真实 Host/IPC 的单选、多问、输入和 MCP form；pending view 先于接收
回执时也只处理本次 Run，其他 Run 的问题仍 pending，默认值不自动提交，Run
成功完成且非 interrupted。MCP 仍为协议 cancel；非交互权限仍明确拒绝且不执行
工具。另核验嵌入式回调、Runtime facade 原样保留原因，迟到回复不能作用于新问题。

```powershell
npx vitest run src/one-shot-questions.test.ts src/one-shot-permissions.test.ts src/one-shot-task.test.ts src/sdk-client.interactions.test.ts src/sdk-runtime.interactions.test.ts src/runtime-daemon/client.test.ts packages/coding/src/tools/ask-user-question.test.ts
npx vitest run src/sdk-runtime.test.ts -t 'settles ordinary questions|keeps AskUser unbounded|returns unanswered when a late'
npm run test:fast
npm run build:packages
npm run typecheck
```

新增 one-shot 明确原因/正常成功断言先 RED（4 项），修复后 4/4。首次相邻集
116 passed / 2 failed；两处新断言将 IPC 参数错误码写成了内部的 invalid_input，
按既有传输契约修正为 invalid_params，Client 交互与 Runtime facade 复验 72/72。
最终 fast 门 EXIT 0：242 文件通过、4 跳过；2404 项通过、44 跳过，0 失败。
嵌入式默认无限等待、三种未回答原因与迟到结算定向 7/7（其余 319 项因名称
过滤未运行）；workspace 包、bundle 和 14 个 SDK 入口 DTS 构建，以及源码/测试
类型检查通过。本轮不替代发布全门、覆盖率测量或 Space GUI 人工验收。

## 2026-10-26 客户端退出恢复收敛

契约见 [客户端退出与恢复](../SPACE_SDK_SEAMS.md#客户端退出与恢复)。背景样本为
Space `0.1.47-alpha.2` / SDK alpha.6，并在 SDK alpha.9 继续出现；本工作树为
`0.7.97-alpha.10`，不据此声称这些源码变更已经发布。

| 回归场景 | 必须观察到的结果 |
| --- | --- |
| 原 Host 已退出、客户端 Memory/执行仍 unknown | 精确进程/Job 与匹配成功 outcome 验证后 recovery.ready；原 cleanup、issues 和执行引用保留 |
| 多次重启 / 旧 outcome 超过普通 32 条窗口 | 不靠重试次数放行；仍能用保留的精确证据重核验，不改写原回执 |
| outcome 迟到 | 缺证据时 blocked；真实 outcome 到达后 ready |
| 客户端或 Host 清理确认迟到，同毫秒 updatedAt | 采用同一 owner 最新确认；Stop 回写不能覆盖 Host cleanup 确认 |
| 读取中 owner generation 改变 | blocked / inspect_failure，不把旧证明用到新进程 |
| 原进程或 Job supervisor 真实存活 | pending/blocked，不能启动替换 Host |
| 资源释放失败 / 缺精确身份 / outcome 内容属另一 Host | blocked，给出 retry_verification 或 inspect_failure |
| 替换 Host 上重提旧退出 | 原回执不变、新任务继续运行、旧请求不建立新 fence、不 cleanup/stop 新 Host |
| 已安全恢复的历史回执 | listPendingExits 不再阻塞；readExit / 离线查询仍保留完整历史 |

定向命令：

```powershell
npx vitest run src/sdk-client.exit.test.ts src/sdk-client.exit-recovery.test.ts src/runtime-daemon/client-lifecycle.test.ts src/runtime-daemon/state.test.ts src/runtime-daemon/shutdown-verifier.test.ts src/sdk-client.host-authorization.test.ts
npm run build:packages
npm run typecheck
npm run build:bundle
npm run build:dts
node --test tests/bundled-product-exit.test.mjs
```

新增用例先 RED 后修复。Windows 本机已通过真实 IPC 替换 Host 活动任务与重复连接
检查；bundle 用例真实启动/退出独立 Host，并核验 Windows Job/supervisor。该用例
在实际退出成功后注入旧客户端丢失的 unknown 确认，保留真实 owner/outcome，
连续两轮重新启动并重提旧退出，验证原 unknown 未被伪造成成功、新 Host 不受影响。
源级离线用例另覆盖真实存活 PID、失败/缺失证明、40 次 outcome 写入后的证据保留。
未在 Space Renderer 内手动验收；非 Windows 平台未在本机执行。

最终定向回归：12 个文件、212 项测试全部通过（含 Host、owner 状态、Windows
身份、orphan-exit、process cleanup、Client 授权与 SDK 自知识回归）。完整包构建、
类型检查、bundle 与 14 个入口的 DTS 构建通过；上面的两个 bundled-product-exit
用例最终构建后再次运行，2/2 通过。没有发布 npm 包或修改 Space 代码。

## 2026-10-15 启动与最近消息排序回归

测试边界：规范存储 Actor 投影、共享 Host 所有权与退出、SDK/Client 列表、裸 `-r` 发现及真实 ConPTY 首次可输入。所有性能样本禁止提交模型请求，使用专用 Home，不停止用户默认 Host。

```powershell
npx vitest run packages/repl/src/interactive/storage.actor-read.test.ts packages/repl/src/interactive/storage.owned-read.test.ts packages/repl/src/session/session-recency.test.ts packages/repl/src/cli-resume.test.ts packages/repl/src/session/resume-index.test.ts
npx vitest run packages/agent/src/runtime/managed-child-processes.scope.test.ts packages/agent/src/runtime/managed-child-processes.cache.test.ts packages/agent/src/runtime/managed-child-processes.run.test.ts packages/agent/src/runtime/process-tree.identity-batch.test.ts
npx vitest run src/sdk-runtime.host-owner.test.ts src/sdk-runtime.actors.test.ts src/sdk-client.session-recency.test.ts src/runtime-daemon/process.owner-exit.test.ts src/kodax_cli.interactive-exit.test.ts
npx vitest run src/sdk-runtime.preflight-projection.test.ts src/sdk-runtime.shell-home.test.ts src/sdk-runtime.mcp-home.test.ts packages/agent/src/capabilities/mcp/transport-home.test.ts
npm run typecheck
npm run build
```

必须保留：其他项目的活跃 Actor 仍阻止停机；长首行、未知 schema、损坏与并发替换不返回 false idle；本 Owner 写队列、取消和期限仍生效。历史恢复仅在取得存储所有权后执行并绑定 Host 配置目录；Client 退出不扫描历史，自己的活进程仍需回收，未知树证据仍保留。身份批次内复用，下一轮刷新，PID 复用不误杀。

忙时预检沿用已认领且验证过 admission 的现场 Actor，不因普通内容写队列或旧 flat 临时文件而失效；未认领 Actor 仍严格读取。真实目录成员变化、迁移锁/journal 不得变成空清单；旧 flat 的顶层 `archived/` 与项目内归档均不参与活跃枚举。全量回归首次检出的忙时读锁问题及复核检出的旧 flat 归档问题均有对应修正和失败后通过的用例。

排序场景：旧会话新增真实消息置顶；标题/设置/Actor 保存、合成消息和压缩不置顶；压缩复制与 Fork 保留来源时间。全量保存、prepared append、索引命中/删除重建、旧记录及 SDK 快慢路径一致；相同时间稳定排序；筛选先于 limit，`before` 仍过滤创建时间。新游标锚点删除或移动后可继续；实时分页中的新增活动通过首页刷新发现。

### 本次启动耗时对比

2026-10-15，Windows ConPTY + xterm，110×35，等待实际出现可输入提示后发送 `/exit`。优化前后使用独立安装副本、相同的 759 条历史子进程记录及恢复会话夹具；沙箱已就绪，无模型请求。每种场景各一次配对样本，包含相同的只记录阶段/OS 调用耗时的内存探针，不代表统计分位数或首次安装沙箱的耗时。

| 场景 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 无运行中 Host，输入命令到 TUI 可输入 | 27.493 s | 17.614 s |
| 已有同构建 Host，再次启动 | 8.344 s | 0.772 s |
| `-r`，选择会话到 TUI 可输入 | 8.181 s | 0.621 s |
| 同版本、同来源构建内容改变，正常切换 Host | 27.405 s | 11.699 s |

刷新样本只在私有安装的 `dist/provider-capabilities.json` 末尾追加合法空白以改变构建身份，覆盖重建后的切换路径；不声称在计时期间执行了编译。所有 CLI 样本正常退出，候选 Host 最后通过 `daemon stop --home <专用 Home> --json` 返回 `stopped: true`。基线最后的停机返回 `cleanup_unverified`，进程已退出，不能将其记为已验证清理成功。

阶段证据：再次启动原本约 6.77 s 的客户端全局清理已消除；候选只处理自己的精确登记，约 1–3 ms。冷启动仍保留 Host 的一次历史恢复（最终样本 9.87 s），构建身份首次读取两侧约 1.30–1.36 s。正常切换等待旧 Owner 退出由约 7.31 s 降至 0.89 s；此处仍验证真实退出及清理结果。沙箱就绪检查两侧均约 28–40 ms，配置准备约 1–4 ms，恢复会话的 Host 读取约 2–10 ms，未观察到这些阶段的新回归。大历史会话的预检读取边界另由 Actor 投影和超过 50 条会话的严格全量回归验证，不能用本夹具的预检耗时代替大库测量。

本机证据目录：`%TEMP%/kodax-startup-comparison-Gtwl6A`，包含 `run.mjs`、`probe.cjs`、`comparison-state.json`、`final-candidate.json`、`comparison-results.json`、各场景 `*-result.json`、阶段 `*.jsonl` 与原始 `*.ansi`。表中候选采用最终重建后的 `after-final-*` 样本；较早候选测得冷启动 15.263 s、再次启动 0.827 s、选中后 0.586 s、切换 10.831 s，保留为额外样本，不据此选取最低值。真实用户默认 Host 未停止或重启。

### 回归结果与证据边界

类型检查、完整构建、SDK 声明自包含检查通过。冻结 2,884 个源码、测试和构建文件后运行默认全量：1,178 个文件，16,618 passed、10 failed、89 skipped、19 todo，耗时 1,202.85 s；结束时所有冻结哈希一致。首轮失败逐项处理如下：

- Shell 恢复的 5 项旧调用参数断言现在明确检查 Host `configHome`，MCP 清理的 3 项旧 mock 改为保留真实作用域导出；相关两文件完整复验 12/12 通过，原清理结果与持久化顺序断言保留。
- 既有 Issue 368 索引使用非标准状态导致统计失败，索引规范为 `Resolved`，详情及版本仍明确源码已修复、SDK 待发布；tracker 4/4 通过。
- 1,005 轮 Run 存储用例遇到一次 Windows `EPERM` 原子重命名失败；生产重命名处理未变，原用例独立复验 56.384 s 通过。保留首轮失败证据，不将其写成已根治文件系统失败。

以上共 17 项定向复验通过，覆盖首轮全部 10 个失败；不是第二份“全量零失败”日志。构建产物验收 42/42 通过，测试适配后的类型检查通过。证据为同目录 `regression-frozen.{log,json}`、`frozen-check.json`、`test-adaptation.log`、`retention-check.log`、`bundle.log`、`typecheck.log` 和 `final-build.log`。

完整真实 ConPTY 验收通过 50/50（owned Ink 30、classic 20），覆盖启动、新建草稿、首次提交、设置、排队、停止、退出与持久会话恢复等；结果与屏幕证据为 `%TEMP%/kodax-repl-acceptance-k88a6C/results.json` 及同目录文件，入口输出为本轮证据目录的 `pty-final.log`。首次执行的旧驱动因错误期待未提交会话进入历史而失败，修正的是驱动对草稿契约的适配，生产行为未改。

打包 Electron 42.5.0 验收通过（`electron.log`）：实际 Windows 沙箱执行 20 次工具查询、4 个 Session 并发、环境隔离、连接/断开、Host 关闭与重新启动。新增 `session-recency.ts` 单独测得行/函数覆盖率 100%、语句 95.83%、分支 89.36%，4 项测试通过；证据为 `coverage.log` 和 `recency-coverage/coverage-summary.json`，不代表全仓覆盖率。最后核对 2,884 个冻结文件，只有两个 mock/断言测试文件及 PTY 驱动发生已复验的适配，生产源码和构建均未改变（`final-freeze-check.json`）；`git diff --check` 通过。

Standards：硬规范违反 0，仍需处理的坏味道 0。Spec：剩余需求/契约问题 0。两轴独立只读复核，未修改用户默认 Host。

### 性能成本与功能回归边界

目前证据未发现本次改动引入新的性能或功能退化；这不等于所有平台、磁盘条件和历史规模都已证明零回归。提交前核对以下成本与权威边界：

- 预检仍枚举全部 admitted、未归档会话，成本随会话数量及元数据大小增长；未认领 Actor 的元数据每批最多 48 个并发读取，不物化正文和 lineage。已经认领的 Actor 使用经过 admission 验证的现场控制器，避免持久化写锁使忙时预检失效。损坏、迁移中或无法证明稳定的记录仍拒绝控制读取，不能误报空闲。
- 全量保存原本需要处理完整 lineage，最近消息事实的持久字段、主文件元数据与写后缓存分别计算来源时间投影，使用临时映射，成本随各自处理的完整或精简 lineage 长度线性增长；prepared append 只处理本次新增 entries 和既有时间，不因该字段重新扫描全部历史。会话列表仍为元数据读取及排序，不为补旧时间遍历所有正文；旧索引按现有维护入口升级，裸 `-r` 不重建索引。
- 历史清理由取得独占所有权的共享 Host 执行一次，客户端连接与退出不重复扫描其他 Owner；精确登记、私有 Home、Job/supervisor、真实退出和持久化清理结果的验证保留。未知清理记录不会为了速度被当成已成功回收。
- Windows 身份批次只共享本次 OS 观察；仅自身不可变启动身份可缓存，外部 PID 下一批重新读取。工具执行增加的 Home 作用域不新增 OS 子进程或全局扫描，也不改变进程全局 Agent Home。
- `lastMessageAt` 是统一展示事实，设置、标题、Actor 保存和压缩不制造新活动。新增字段可缺省，旧数据有可靠消息时间才补充；`before` 继续按创建时间过滤，分页保持明确的实时边界语义。

本轮已覆盖 1,005 轮 Run 存储、真实双终端和打包 Electron；没有做全部非启动路径的吞吐量 A/B、大库生产预检延迟分位数或 macOS/Linux 实机对比。Windows 全量中的一次 `EPERM` 已独立复验通过但没有根因修复结论，保留原始证据。后续若出现新的性能或功能问题，应使用同一场景的源码/构建身份和阶段记录定位，不通过缩小预检覆盖、清除未知登记或放宽 Owner 验证规避。

## 2026-09-14 主线融合复核

复核保留唯一 Host/Client 权威，不以旧内部接口删除判断能力缺失。补充以下人工场景，均使用专用测试 HOME 和已有共享 Host：

1. 一个窗口等待问题，第二个客户端回答该问题。classic 窗口应撤掉旧输入；Host 下一问题可立即作答。关闭观察后输入旧答案不得发出 Host 答复。
2. 忙时排入 `说明 @"带空格的图片.png"`，重新挂接同一 Session 后按 ↑ 取回，修改正文再提交。图片引用应可见、仅一份，后续模型请求仍有该图片附件。
3. 在 Host 接受输入期间取消。界面应等待真实 Run 结果；不能把 Stop 接受或 cleanup unknown 显示为已完成取消。
4. one-shot 使用临时模型参数恢复已有 Session，在运行期间由另一客户端改变模型。one-shot 结束不能覆盖新选择；设置恢复冲突需明确报告。
5. ACP 进程与既有 Host 的 repo-intelligence 环境值不同。ACP 发起 prompt 后，Host Session 的模式/trace 开关应采用 ACP 调用配置。

上述公开接缝已有自动回归；真实终端操作通过与否应单独记录，不能以单测成绩代替。

### 2026-09-14 自动回归与边界

复核时当前分支 `0841fb51` 已包含主线 `7b5b1b9e`，无需再次合并。
本轮修复了输入接受期间取消未等待真实结算、classic 失效问题占用输入、
队列图片取回/重交丢失媒体类型（含无后缀图片和 Windows 大小写）、one-shot
恢复设置覆盖另一 Client、ACP repo-intelligence 参数未到达 Host，以及清除
Session Auto 审查覆盖后未回到 profile 的消费者缺口。
`sessions.getSettingsVersioned` / `updateSettingsVersioned` 复用 Host revision/CAS，
没有增加第二设置权威；另一 Client 修改后恢复冲突保留现状，未改写的临时旗标
可能继续保留，不承诺逐 Run 设置隔离。

代码冻结后的历史结果：完整构建与源码/测试类型检查通过；真实构建 PTY
Ink 21 + classic 14，共 35/35；13 文件定向回归 423/423；新增可执行行
150/159（94.34%，非全仓覆盖率）；完整 Vitest 1,086 文件通过、1 跳过，
15,799 用例通过、77 跳过、21 todo。初轮与修改并行、含旧模块缓存/RED 用例的
运行和主动停止的两轮不计为最终快照。Spec 发现的无后缀媒体类型与大小写 P2
经公开 queue 回归修复，最终 Standards/Spec 均无剩余发现。

该次没有真实模型或其他 OS 验收；ACP trace 开关传递不等于新增完整诊断事件面，
浏览器 transport 也未实现。A2A 离线期间 Run 已完成后读取结果、classic 同 ID
正文缩短等当时未独立复现的范围，不由本次成绩证明已解决。入口存在不证明
所有配置、授权 UI 或 Learning 消费者均完成迁移；后续状态以当前契约和问题记录为准。

## Historical integration evidence

以下为原融合记录的定稿事实与限制，迁移不代表重新执行测试或发布新版本。

### 2026-10-02 integration

主线 `cad8b658797976ce22a4bd70c60d2251d537e542` 合入统一 Client 分支
`a63feede5f4b2bac8a62ddfa687d9b515d8c2021`；最终生产源码/双轴复审候选为
`f1bb8eb87b7f367c56a799847b77224baab90a0e`。保留单一 Host、瞬态中断证据、
outputId + opaque callId 身份、离窗全文回源、deferred cleanup unknown 和 v10
缓存边界；未回接 REPL runner 或持久 Runtime event journal/replay。
主线 Issues 340–344 保持身份，worktree 同号项迁为 348–352，345–347 不变。

| 历史门禁 | 结果 |
| --- | --- |
| 最终构建与源码/测试类型检查 | 通过；14 个自包含 SDK 声明入口，纯 Client 不需 Node ambient types |
| 冻结源码后 Fast | 218 文件通过、1 跳过；2,202 项通过、32 跳过 |
| Unit 全量序列 | 740 文件；12,017 项通过、3 跳过 |
| Contract 全量序列 | 117 文件；960 项通过、21 todo |
| System 全量及 daemon 复验 | 全量 74 文件通过；daemon 最终 25/25，合计覆盖 75 文件、1,341 项通过、42 跳过 |
| 最终构建产物 / 真实 PTY | 九个 bundle 文件 39/39；Ink 30 + classic 20，共 50/50；大历史浏览通过 |
| 恢复模块专项覆盖 | statements 97.4%、branches 89.44%、functions 97.82%、lines 99.33%；仅新证据派生/渲染模块 |
| Standards / Spec | 同一最终源码候选均为 0 剩余发现 |

原全量 System 有三项 `launcherBuild` 失败：daemon 测试进程加载的旧源码与
复审修复后磁盘指纹不同。冻结源码、最终重建后整份 daemon 文件 25/25 复验，
不把原 `npm run test:full` 退出码写为成功。真实 IPC 覆盖 SA/AMA 流式中断、
detach、Host 重启与下一轮恢复，未重跑 Provider/工具；复用
`reused:tool:suffix` 的不同 output 在额外 160 条 canonical 消息、移除工具
checkpoint 后仍可各自补读全文。owner-kill fixture 先结清无关 Session 写入，
未用删除遗留锁或放宽超时规避失败。

该次未执行付费模型 eval，也未替代 Linux/macOS 或跨平台人工验收。未成功
checkpoint 的 token 不在恢复保证内；主线未解决问题保留原状态。设计子模块
当时固定点为 `22f1c3561d24b225f057edebb25f6325e362b8e8`，保留双亲融合历史。

### 2026-10-07 stable mainline integration

开发起点 `f9b0fb586aa9bc8af8ffa67160d2c9ec952779b9` 吸收正式主线
`c2c8fdc41f4e0b50fa1c2d0b24142586f155777c` 的 `v0.7.96` 发布记录，
共同祖先为 `cad8b658`。包基线同步 `0.7.96`；FEATURE_298 已实施状态及
单 Host/Client 契约保留，不复活旧 API。用户未选择文本工具 OS 沙箱迁移，
继续沿用 ADR-066；没有新增迁移实施票、重置既有 tag 或宣告 v0.7.97 发布。
设计子模块融合 `7be826fcab188720745e9a5c9374ec5c78997b56` 保留双方历史。

最终历史结果：typecheck、完整构建/纯 Client 编译通过；七文件受影响测试
69 项；冻结产物、修正只读夹具后的 Fast 为 218 文件通过、1 跳过，2,203 项
通过、32 跳过（414.86 秒）；九个 bundle 文件 39/39。包含夹具修正的固定
tree `b0c02b71d1e518d9a2a4ff3972cd2f0876f81037` Standards/Spec 均为 0 发现。

首轮 Fast 有两个构建指纹保护失败；停止重建后专项 3/3 通过。第二轮仍有一个
Session 只读 `data_changed` 失败，不能由窄循环通过抹去；原现场锁未捕获，
不能断言根因。夹具仅按公开契约在原整体期限内重试
`data_changed/resync_required` 的只读 Run/Session 查询，其他错误立即失败；
不删除锁、不重交输入、不修改生产锁/重试，并等待 Provider 正文包含 `tool-ran`
后才触发崩溃。保留 interrupted/unknown、工具一次、Provider 不重跑及完整观察
断言；随后另行完成上面的最终 Fast。日志为
`%TEMP%/kodax-stable-merge-{fast-corrected,bundle,focused}-2026-10-07.log`
及对应崩溃专项日志。该次是主线融合，正式发布及跨平台人工验收另行跟踪。

## Windows 终端验收

入口：`tests/repl-pty-acceptance.mjs`。

链路：node-pty 的 Windows ConPTY → 发布入口 `scripts/kodax-bin.cjs` → 构建后的 CLI → 独立 Host → 本地 HTTP SSE Provider。xterm 解析终端实际输出；测试通过键盘输入操作产品，通过公开 Client 接口核对 Host 事实，并核对 Provider 实际收到的正文。

准备并运行（仓库根目录，PowerShell）：

```powershell
npm run build
npm install --prefix "$env:TEMP/kodax-acceptance-tools" --no-audit --no-fund node-pty@1.1.0 @xterm/headless@5.5.0 @xterm/addon-unicode11@0.9.0
npm run test:repl-pty:built
```

可用 `npm run test:repl-pty:built -- ink` 或 `-- classic` 单独运行。Ink 路径明确使用当前 owned 渲染器；`KODAX_FORCE_INK=1` 选择的是旧 legacy 渲染器，不属于这一通过结论。若工具安装在其他位置，以 `KODAX_ACCEPTANCE_TOOLS` 指向包含 `package.json` 和 `node_modules` 的目录；这是验收驱动的位置，不是产品配置。

每次运行创建独立临时 Home、配置、项目和 Provider，只使用本地测试凭据。退出时停止本次创建的 Host；测试证据保留在启动输出的 `Artifacts:` 目录：

- `results.json`：每项结果及失败原因。
- `*-*.txt`：终端屏幕文本；`*-*.ansi`：原始终端输出。
- `*-requests.json`：本地 Provider 收到的请求，用来核对原文与历史。
- `*-host.json`：公开 Client 读取的视图、Run 和事件，区分正常停止与运行失败。

两种终端均验证新会话启动、流式输入/输出、设置往返、完整长输入、提问、停止后继续输入、新建隔离、退出和历史续接。Ink 额外验证忙时排队撤回编辑、搜索旧消息及冻结浏览。Ink 长输入使用 bracketed paste；classic 使用原有反斜杠续行。新建会话沿用各入口原有交互：Ink 确认后创建，classic 直接创建。具体通过项以当次 `results.json` 为准；失败不能以旧测试通过数豁免。

2026-10-15 驱动同步草稿契约：启动及 `/new` 从真实终端所显示的 Session ID 经公开 `read/observe` 确认目标，classic 使用 `/status` 获取完整 ID；未提交会话必须仍不在历史列表中。首次真实输入后才验证持久化与旧会话保留，不为迎合旧断言恢复空历史记录，也不增加虚假的预热输入。

2026-09-09 起，Ink 同一入口额外检查以下回归：

- 普通输入和完成回答各显示一次，完成后的连续采样不出现回答重影；状态栏显示夹具的 `60/65.5k`、`50→10 (60)` 和 `1/7`。
- AMA 模式下，一条 query 只显示一次、Provider 也只收到一份；临时 worker 提示不混入历史，上一轮回答保持在下一轮提问之前。
- 实际执行 `echo ACCEPT_TOOL_RESULT`，折叠工具项显示命令摘要，Host 记录成功状态及真实工具输出。
- 生成超过 8192 字符的回复时输入草稿，按 Ctrl+O → Ctrl+E 展开历史，冻结尾部仍在；q 返回后草稿保留。再次进入 transcript，按 `/` 搜索预览窗口之外的早期正文，Enter 跳转，q 返回后草稿仍在。

接口再扫描后，同一场景还在 Ctrl+O 后让 Host 追加独有标记，再选择当前项并按 `v` 展开、`G` 移到底部，断言冻结内容没有混入后来的标记。完整历史展开与单项展开必须同时遵守冻结边界；`c/i` 复用该读取实现，本驱动不读取或改写用户剪贴板来断言复制内容。

真实旧会话残留修复后，另加 240×64 长 AMA 输出（Tab 与中文长行），执行展开/收起、开头/末尾跳转及搜索/取消，逐行检查页脚没有混入正文，然后缩回 110×32。xterm 必须启用 Unicode 11，让 emoji 列宽与产品一致。此场景在旧代码下会出现正文标记错位，不以字符串存在替代页脚行检查。Tab 等控制字符只在显示 cell 转为空格；历史和全文复制保留原始字符。

这里 Ctrl+E 表示展开/折叠完整历史，`/` 表示打开 transcript 搜索。分页期间模型继续追加、旧会话来源歧义和取消读取另有契约/显示函数回归；不把这些单测计为额外真实终端用例。

普通聊天的流式翻页回归：构建后运行 `node tests/repl-pty-acceptance.mjs --streaming-scroll-only ink`。驱动在私有 Home 保存 90 轮规范问答，持续追加本地模型输出，同时用鼠标滚轮跨越最近显示窗口和多个历史页。必须能到达第一条 query，停手后阅读位置保持不动，中间页顶部不闪现会话 banner，Provider 只收到一次当前输入。此用例不调用真实模型，也不改写用户会话。

旧显示 checkpoint 的恢复/提交回归：构建后运行 `node tests/repl-pty-acceptance.mjs --checkpoint-resume-only ink`。私有会话包含一轮 55 次已保存工具交互及旧 checkpoint，恢复后回滚到原 query，再用 bracketed paste 提交相同文字。模型响应受控暂停期间，上一轮末尾必须仍可见，Host 视图保留 2–150 个唯一展示项，而非只剩新 query；Provider 仅收到一次新输入。脚本不读取或写入系统剪贴板。对应 SDK 用例还验证没有重新执行旧工具，历史原文和完整补读不依赖显示窗口的 query 边界。

SDK 另由 `src/sdk-client.observe-history.test.ts` 验证：末尾工具尚无结果时，首次准备与复用缓存都能读到原始 query；相同文本的不同 inputId 保持独立，复用 callId 的不同 assistantOutputId 保持独立，工具时间在 observe/readHistory 两个面保持一致。真正的版本变化仍须返回 `resync_required`（`src/sdk-client.history.test.ts`）。Ctrl+E 的 `collapse` 只证明细节已展开；完整读取失败时仍保留冻结窗口并报告失败，不代表早期记录已删除。

## 打包 Electron 与沙箱验收

入口：`scripts/test-electron-daemon-smoke.mjs`。配置已有 Electron 和 electron-builder 后执行：

```powershell
$env:KODAX_ELECTRON_DIST = '<electron 包>/dist'
$env:KODAX_ELECTRON_BUILDER_CLI = '<electron-builder 包>/out/cli/cli.js'
npm run test:electron-daemon:built
```

要求本机 Windows restricted-user sandbox 已就绪。验收不会隐式执行全局 sandbox setup 或修复 ACL；前置条件不足时明确失败。不要将真实用户目录传给 `KODAX_ELECTRON_SMOKE_HOME`，因为现有脚本把该参数视为可清理的验收专用目录。

测试实际打包并启动 Electron，检查 20 次工具查询、4 个 Session 并发、Windows 沙箱实际执行、环境隔离、连接/断开、关闭 Host 和重新启动。它运行 Electron 主进程但不创建 BrowserWindow，因此不覆盖视觉界面点击。

## 结果与边界

本轮执行与修复记录见 [真实产品入口自动化验收](../REVIEW_v0.7.97_FINAL.md#真实产品入口自动化验收)。确定性 Provider 让输入与交互断言可重复，不代表真实商业模型的任务质量验收。本指南也不替代 macOS/Linux 实机、剪贴板/输入法、视觉 GUI 和主观终端手感检查。

多客户端设置反向同步已通过真实 Ink/classic 验收，包括清除覆盖与 Host 默认值变化。仍有一项已知缺口：强制 legacy 渲染器的搜索结果跳转可能无法显示屏幕外的历史消息。详见 [Known Issues](../KNOWN_ISSUES.md)。因此本指南的通过结果不代表整个 v0.7.97 无条件验收通过。

## 开发代码更新后验证旧会话

REPL 和 Host 是两个进程；界面的包版本不能证明后台进程已加载本次修复。启动器现在比较运行中 Host 与本次启动实际代码的构建身份：同版本、同入口、不同字节且旧 Host 空闲时，正常关闭旧进程、确认退出后启动新构建。`npm run dev`、`daemon start`、SDK ensure 和默认 ACP 共用这一规则；被动 connect 不更新进程。

没有构建身份的历史 Host 需要一次明确的正常迁移。在任务结束后退出旧 REPL，从本 worktree 停止、启动 Host，再恢复会话：

```powershell
npm run dev -- daemon stop
npm run dev -- daemon start
npm run dev -- -r 20260909_075806_ed59a28bf46b46
```

这些命令不使用 force。若 Host 报忙，先结束或由用户停止对应任务后重试，不强停。跨安装来源、较新版本或安装正在变化时，按具体诊断处理；不循环重启，不降级。已加载旧 SDK 的长寿命调用进程需要重开。

恢复验证要检查后一轮 query 位于前一轮最后输出和后一轮首段输出之间，而不只查找正文是否存在。历史中已保存的重复输入不自动清理；测试副本可以隔离重放，但不得重写用户原会话来让验收通过。

## 构建更新与统一产品接口自动验收

接口说明见 [CLIENT_CONTRACT.md](../CLIENT_CONTRACT.md)。执行完整 `npm run build` 后运行 `node tests/host-build-acceptance.mjs`。脚本在临时安装副本中使用真正的独立 Host 和公开 SDK，覆盖同版本字节更新、相同内容复用、被动连接、真实观察者阻止更新、空闲后重试、旧调用进程拒绝更新，以及 `daemon start` 一致性。

脚本通过删除/复制隔离 dist 和添加合法 JavaScript 注释模拟 clean/build 的文件替换效果，验证旧 PID 真实退出及 Session 保留；不声称在副本中再次运行了编译器。它不会修改用户安装、用户会话或调用商业模型。

ACP 的共享 Host、文本/工具、Session MCP、权限、取消、并发请求和提交竞态由 `src/acp_server.daemon.test.ts`、`src/acp_server.admission.test.ts` 与投影测试覆盖。发布声明通过真实 `/client` 消费者在 `types: []`、`skipLibCheck: false` 下检查，不能靠注入 Node 全局类型掩盖产品契约泄漏。

## Host 执行归属与统一业务入口回归

这组验收对应 [Host 审查 H1–H5](../HOST_ARCHITECTURE_REVIEW.md) 和 [产品接口说明](../CLIENT_CONTRACT.md)。使用临时项目、独立 Host 与可计数离线 Provider；不重写用户的旧 Session，不把方法存在或类型通过当作实际执行通过。

| 验收入口 | 必须核对的行为 |
| --- | --- |
| `src/sdk-invocations.test.ts`、`src/sdk-runtime.skill-lifecycle.test.ts` | Skill 的输入保存和 Run 准入先于动态工具执行；忙时及保存失败零执行；准备中 stop/close 传播取消并等待退出；同 inputId 不重新执行；Plan 不执行动态命令。 |
| `src/sdk-client.domains.test.ts` | 两个 ProductClient 实际调用 compact、Memory、Learning、注册命令、review 和 agents lean；核对 Provider 请求、落盘正文、领域版本及客户端通知作用域。手动草稿可编辑且不执行 hook、不继承可信调用元数据；无输出命令不伪造 user 或模型轮次。 |
| `src/sdk-client.steer.test.ts` | steer 图片等附件进入实际模型消息和保存的输入；同 ID 换附件产生 conflict，沿用已有媒体能力校验。 |
| `src/session-view.tool-results.test.ts` | 结构化工具失败、成功正文含错误字样、取消和非文本结果在实时与恢复后保持一致，不靠新正文格式猜状态。 |
| `src/sdk-client.observe.test.ts`、`src/runtime-daemon/client.resubscribe.test.ts` | Host 读取失败和传输断连均可观察；先交付恢复后的完整 view 再通知 live；恢复观察不重新提交输入或工具调用。 |
| `src/sdk-client.history.test.ts`、`src/session-view.test.ts` | 当前设置预算与实际执行预算分开；父/worker 及不同 contextId 不混用；搜索命中通过同一全文 reader 打开，快照失效明确失败。 |
| `src/sdk-client.test.ts` | 缺少统一产品契约的旧 Host 在被动连接时明确拒绝；不借连接错误关闭或替换其进程。 |

上述文件可用 `node node_modules/vitest/vitest.mjs run <文件...> --maxWorkers=1` 定向执行。之后运行完整构建、类型检查、完整离线测试与前述 PTY 验收；每次报告应分别给出定向与完整测试结果，不能把不同快照的通过数相加冒充最终门禁。

终端还须核对：注册命令启动后只跟随已返回的 Run，不再次提交同一正文；`disableModelInvocation` 不阻止用户显式执行注册命令；`/review` 无改动时仅显示结果，有改动时使用同一 Host 的项目内容。SDK 的 `commands.readPrompt` 是明确的草稿读取，不据此增加 CLI 开关或改变旧命令行为。已有忙时命令限制、输入草稿、冻结 transcript 和返回编辑器行为均须保留。

Bash/sandbox 的回归继续使用 `src/sandbox-runtime.test.ts`、`packages/coding/src/tools/bash.test.ts` 和 `packages/coding/src/skill-invocation-policy.test.ts`。本轮接口迁移不能引入新的 shell 执行路径、沙箱失败后自动本机执行、批准后修改整个 Session 权限，或无法确认执行状态时自动重跑。原生平台前置条件导致的跳过必须单独报告。

## 长会话显示预算耗尽与工具分组

短回答、单条长文本及展开后的全文读取不能替代这个验收。必须让多个工具结果的有界预览合计超过 131,072 个 UTF-16 码元，并在普通 live 界面重绘后检查早期内容。

```bash
node tests/repl-pty-acceptance.mjs ink --source --long-history-only
```

该入口使用与 `npm run dev` 相同的 production-env、tsx 和源码 bootstrap，在独立临时 HOME/项目和离线 Provider 上启动。夹具先生成早期 query、Thinking、正式回答及两个 Bash 调用，再产生多批真实 read 结果填满预算。核对普通界面上的早期 query 整行、Thinking/回答正文、Bash 参数仍可见，相邻工具按批次显示；不要先用 Ctrl+O 展开全文来掩盖普通显示的空白。另检查原文 reader 仍可读取、总预览不超限。

`src/session-view.preview.test.ts` 覆盖正文、参数双字段和完整 150 项窗口；`client-plane.test.ts` 与 transcript 布局/滚动测试覆盖单项原身份、相邻合并、非首项搜索定位、展开和复制。分组只能改变展示，不能把多个 Host item 合成无法分别读取的新业务身份。

## 队列在下一次模型沟通时交付

```bash
node tests/repl-pty-acceptance.mjs ink --source --queue-boundary-only
```

该场景暂时切换为 AMA 并在结束后恢复原设置。离线 Provider 暂停第一次请求，真实终端输入普通 follow-up，确认 Host 和终端都显示排队；随后让第一次请求返回工具调用。在第二次模型请求尚未结束时，检查其中已且仅已包含一次 follow-up，原 Run 仍在运行，Host 队列和终端排队行已清除，普通界面还须显示 query 完整正文行。不能先让整个任务结束，再把新 Run 收到文字当作通过。完整 PTY 套件另以 SA 注册命令验证原 Run 内续答和双 Esc 停止。

SDK 对应 `src/sdk-client.queue-boundary.test.ts`，须覆盖 SA 与 AMA：消费前 withdraw 返回完整原文和附件，撤回项不进入模型；重新排队使用新 inputId；消费后的 read 指向执行 Run，withdraw 明确 conflict，canonical 输入不重复。Skill 位于队首时仍需走 Host 的可信准备，不让后续普通输入越过；stop/failed 保留尚未交付的队列。此验收不改变 Esc、↑、权限或 sandbox 的既有语义。

## 启动碰撞与终态后的稳定读取

`src/sdk-runtime.launcher.test.ts` 在真实 IPC 层固定制造四轮临时 launcher 同时连接旧 Host，再检查两个调用连接同一个新 owner、旧进程正常退出、原 Session 保留。`src/sdk-runtime-daemon-upgrade.test.ts` 检查同一个启动期限内退避、取消后释放连接、永久忙碌时不 shutdown，以及期限耗尽后不跳过退出确认。不得通过忽略名称为 launcher 的连接来通过测试。

`src/sdk-client.derive.test.ts` 在 Host 显示 checkpoint 内持有真实 Session 写锁，直接调用会话、lineage、设置、auto stats、fork/recover 接口。请求应等待自身 checkpoint；保存失败必须传递，外部写锁仍明确拒绝。不要在目标调用前额外 readHistory 来预热或同步，也不要增加固定 sleep。Run 终态与显示保存是不同边界，所有出口应在 Host 内复用已有等待机制。


## FEATURE_299 融合后的消费者验收

完整 PTY 增加 `host-diagnostics-and-manual-shell`：客户端不加载扩展，`/mcp` 和 `/extensions` 必须显示 Host 诊断；`!echo` 必须产生 Host 的 bash 工具结果、一次原 query、零模型请求。主线已要求 effectful extension 命令具有工具 Run，所以无输出命令改为核对真实 Run 完成、一次输入、零模型调用，不能继续断言不存在 Run。只读帮助仍不能执行 handler。

| 自动测试 | 真实验证范围 |
| --- | --- |
| `src/sdk-client.repl-activity.test.ts` | 真实 Host/IPC、ProductClient、CLI plane 与 Ink/classic 渲染入口；替换终端 streams 和执行器事件夹具，核对 Todo、child、AMA 工作条、workflow、完整摘要、附着忙 Run 排队与停止、两端 cost。该测试不是原生 PTY。 |
| `src/sdk-client.domains.test.ts` | 实际离线 Provider 与共享 Host；扩展 command scope、受检工具、两 Session 隔离、原输入身份、同 Run 模型接续、只读帮助及诊断命令。 |
| `src/sdk-client.interactions.test.ts` | 实际 IPC；显式工具身份、完整长计划、首答、拒绝/取消/Stop；不把直接赋予组件 props 当作协议验证。 |
| `src/one-shot-permissions.test.ts` | 无交互 CLI 及时拒绝自己 Run 的权限，处理 view 早于接收回复；其他 Run 不被误拒，不修改全局模式。 |
| `src/one-shot-questions.test.ts` | 真实 IPC 单选、多选、自由输入及共享 stdio MCP 表单及时取消；固定 view 先于接收回复，不代填默认值，其他 Session 仍待答，观察器正常关闭。 |
| `packages/coding/src/agent-runtime/input-identity.test.ts` | SA/AMA 首次 Provider 请求复用已接受 query，保持 tool call/result 顺序；不同 inputId 的同文输入仍是新输入。 |
| `packages/repl/src/ui/client-plane.stop-control.test.ts` | Stop 请求失败可按同身份重试；自然终态及迟到 ACK 不丢失确认，旧 Run 不确认新目标。 |
| `src/sdk-client.integration-diagnostics.test.ts` | 无本地 runtime 的扩展/MCP 命令；lazy 查询不唤醒；真实初始化暂停时，另一客户端 reload 必须等待目录读取结束。 |
| `src/sdk-client.command-mcp-elicit.test.ts` | command 受检工具与 SA 模型接续两条路径，真实共享 MCP 表单必须归属本 Session，另一 Session 无交互，双客户端可以正常批准。 |
| `tests/repl-legacy-search-acceptance.mjs` | 强制 legacy 渲染器的真实 Windows PTY：长历史搜索编辑区可见、Enter 目标在屏内、Ctrl+E、草稿恢复、退出。 |

扩展接续还须在 handler 暂停期间真实 reload，再检查当轮 Provider 使用旧贡献、下一个 Run 使用新贡献；SA 与 AMA 都要覆盖。MCP 初始化被 dispose 时应保留关闭原因，不能启动备用握手进程。对应 domains、MCP runtime 与 extension runtime 测试均保留，不以静态接线检查替代。

还需运行 FEATURE_299 回归指南的原生边界与真实 Shell 清理测试。`npm run build` 包含不安装 Node 类型的 ProductClient 使用者编译检查，防止诊断字段泄漏 Host 执行类型；不得添加 Node 类型依赖来掩盖失败。


## T38–T42 消费者归口补齐

```bash
npx vitest run src/sdk-client.catalog.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-session-commands.test.ts src/sdk-goal-binding.test.ts
node tests/repl-pty-acceptance.mjs --consumer-only
```

consumer-only 在真实 Ink/classic 终端验证 Host probe/forget、模型与设置命令、fallback/log 控制、按项目列会话、加载目标会话不覆盖设置、rewind 后历史可见、Host tree，以及已有 Host 下明确 `-r <id>` 和 repo-intelligence 启动参数。启动只提交显式参数；未显式指定的 permission/thinking 等字段保持 Host 默认，不强行写成客户端默认。

`src/sdk-client.repl-activity.test.ts` 给客户端注入禁止 load/list/save 的 storage，实际 Host 仍使用 canonical 存储；从两个真实 REPL 入口验证 startup/load/status/tree label/select/rewind/fork/recover、目标设置保留，并验证 Ink 设置写入失败后仍可 load。恢复命令保留原有确认及 Continue 行为。`src/sdk-client.catalog.test.ts` 另验证保存前失败、保存后报错、实际 Session 应用失败分别如实呈现，以及真实 Workflow fallback 与 verifier/stall sidecar 日志开关。

裸 `-r` 继续从 bootstrap 公开入口验收：空目录、旧布局和缺索引时读取不创建目录、迁移文件或写索引；超过 1000 个候选仍能选旧会话；选中后已删除/归档应由 Host 拒绝，不能误建新会话。普通 Host 列表只在索引缺失或无效时维护，热索引路径不重复扫描 canonical 正文。保留旧 worktree 路径映射与 Esc 输入所有权测试。

人工补验：Host 与客户端 home/profile 分开时，Host 独有模型仍可选择；从工作区 A 加载 B 后，相对附件按 B 的实际路径解析；旧会话迟到更新不得覆盖新页。既有冻结浏览、展开、复制、外部编辑器和独立 REPL 入口继续按前文回归，不能用本节自动化替代跨平台及视觉验收。

长历史预算夹具显式在 Host 设置 full-access，仅授权夹具中的受控本地工具，避免默认权限批准阻塞显示验收；既有正文、工具参数、分组和预算断言不变。失败清理覆盖待批准/等待子 Agent/恢复中的 Run。

## T43–T47 体验承接回归

使用隔离 profile；优先从真实 Product Client → IPC Host 和生产 Ink/classic 入口观察行为。T43 的 `src/sdk-client.interactions.test.ts` 验证无配置新会话、无模式旧会话、清除 override 及显式 accept-edits/plan 的 AskUser 直接出现 question，同时原始 Session/config 仍未写入默认。底层 SDK 未声明权限仍须走原 permission broker。原生终端验收中的 question 场景显式清除 profile/Session 权限覆盖后再发起请求，不能用 full-access 绕过这个回归。

观察可用性须分别验证：首次失败、已成功后的短暂 interrupted、明确 closed；失败后原始长稿及附件引用可恢复，读设置与 Stop 继续可用；同会话重新订阅不吞或重复正文/问题，迟到的旧会话回调不污染新会话。提交结果未知不得自动重发输入。普通输入、显式工具、注册命令及 workflow 的新执行入口均须覆盖就绪检查。

会话信息仅依据 Host 元数据：classic /load 显示目标工作区、消息数及切换提示，/sessions 显示工作区标注；目标设置、实际执行 cwd 和 raw Session 文件不因显示而改变。

effort 必须区分拒绝事实与随后发送的参数；sentEffort 不表示模型强度已验证，不写回用户默认。SA/AMA 与双端消费者都需验证。流式活动按请求身份归属，覆盖 thinking 完整长度、同名交错工具、缺 ID、child 隔离、迟到事件和 replace/stop/reset。保留 80ms 合并、长历史预算、空闲 API 上下文真值和共享进程快照测试，不能用扩大预算或逐 delta RPC 换取通过。

本轮不新增 Memory 写入、不恢复退役 Scout、不改 classic 工具全文约定，不将名称/计数反馈冒充逐字 JSON 预览。人工跨平台与终端操作手感仍按前文验收。

新增定向自动化入口：

```bash
npx vitest run src/sdk-client.interactions.test.ts src/sdk-client.repl-observation.test.ts src/sdk-client.repl-activity.test.ts src/sdk-client.capabilities.test.ts src/sdk-client.streaming.test.ts src/session-view.streaming.test.ts src/session-view.reasoning.test.ts
```

`sdk-client.streaming` 使用本地 HTTP SSE 夹具、真实 Provider parser 和 IPC Host，分别暂停 thinking 与工具参数片段，证明两阶段确实可观察；不是对真实模型能力的验证。局部 streaming 用例还覆盖 A/B/A 同名工具分开累计、缺调用 ID 不计数、旧请求同 callId 的迟到工具启动、取消和 reset。classic 在连续流式活动期间按请求/阶段/调用去重提示，计数为首次看到的快照；活动消失后清空去重状态，重新进入可以再次提示。Ink 计数实时更新，冻结浏览不跟随更新。

夹具同步也属于验收可信度：等待实际 Provider 请求进入后才断开或排队，不把默认 1 秒轮询当作产品性能承诺；fallback 统计应区分当前 child 请求与沿用历史的后台摘要；自然完成后清理临时目录前，等待已有 Memory review drain，并取消、等待测试自身额外创建的 Run。HTTP PTY 夹具先做健康检查，仅 Fetch 明确拒绝端口时重选，其他错误继续失败。不要通过跳过断言、增加生产重试或扩大历史预算消除这些夹具故障。

MCP 冷启动/全局重载和私有会话资源隔离分别验收，保留真实工具调用；setup、测试体和 teardown 分别受现有 30 秒限制。不能把拆分后的组合墙钟时间描述为仍有单个 30 秒上限。setup 部分失败也要释放本次已创建的资源，Provider 回调只捕获本次 fixture，避免误清理或污染下一例。

本轮原生 Windows PTY：主矩阵 43/43、consumer 14/14、长历史 7/7，退出码均 0。完整测试的首轮失败、定位及最终复验另见 v0.7.97 设计块的本轮证据；不将定向测试或带重试运行描述成一次无重试全量通过。检查全量结果时同时读取退出码、失败列表和未处理错误；JSON 的测试成功字段不能单独证明运行器无错。

最终快照 `c94d73ab` 的完整默认测试集合使用 `--maxWorkers=1 --retry=0 --reporter=dot --reporter=json`：16140 测试通过、零测试失败，但仍有一次 Vitest `onTaskUpdate` 未处理超时，退出码为 1，**全量验收尚未通过**。类型检查、构建和 PTY 通过不能替代这个失败门禁。下一步先定位报告通道的具体任务与处理延迟，不以忽略错误、扩大时限或重复无定位的整套运行结案。

## T48–T52 UI 暴露面复核回归

```bash
npx vitest run src/session-view.children.test.ts src/session-view.sidecar.test.ts src/sdk-client.repl-activity.test.ts packages/repl/src/interactive/classic-plane-display.test.ts packages/repl/src/ui/client-plane.stop-control.test.ts packages/repl/src/ui/utils/restore-history.test.ts
npx vitest run src/sdk-client.observe.test.ts packages/repl/src/ui/InkREPL.managed-transcript.test.ts src/sdk-client.repl-observation.test.ts
node tests/repl-pty-acceptance.mjs --exposure-only
```

原生 `--exposure-only` 运行双端：开启 light/trace 后真正执行引擎，检查 routing 摘要同时进入 SessionView 和终端；关闭 trace 后下一次请求不产生新摘要。第二个 Product Client 在同一 Session 提交 held Run，终端显示后按 Ctrl+C，Host 必须确认 interrupted，且下一次键盘输入恰好执行一次。classic 的 Stop 日志不能使输入提示符消失；不能通过清理时取消 Run 让断言假通过。

受控引擎事件→真实 IPC Host→生产双 REPL 的用例验证 RepoIntel、Verifier 三种分类、classic 压缩开始提示与外部 Run Stop 接线；这不是实际模型/Verifier 发射链路的 E2E。局部视图测试覆盖两个 child/parent 交错的 progress/result/retry/recovery/rate-limit，去重按 child 与物理请求区分，child 临时进度不写入父历史，换 Run 不接受旧活动。Verifier 的 verdict 和 delivery 是两维：budget-exhausted 仍可能携带真实 verdict；新快照保留两维，旧 icon 只精确解码已知值，未知分类中性显示，不推断默认 revise。观察同一 item 仅分类变化时，Ink 与 classic 缓存必须更新，已恢复的首帧不重复打印，移出窗口后清理去重状态。

classic 复用 compacting 快照，同 Run 同阶段只提示一次、结束或换 Run 可再次提示，同会话重挂接保留 differ。不承诺两个快照间瞬间完成的阶段一定显示。跨会话 Stop、断线重连、已接受输入不重交、草稿与问题框隔离继续运行原有观察/控制回归。以上新增测试不能替代主矩阵、消费者矩阵、长历史预算、类型检查和完整套件。

2026-09-20 本轮定向 7 文件 72 项、类型检查与完整构建通过；原生主矩阵 47/47、consumer 14/14、长历史 7/7，退出码均 0。主矩阵在最终 classic 同 ID 分类缓存修补前执行，该修补由最终定向用例覆盖；最终构建后执行 consumer 与长历史矩阵。consumer 清理阶段仍有 node-pty AttachConsole 辅助进程警告，不隐去该环境噪声，也不将其描述为断言失败。完整默认套件的最终门禁结果另见设计块，不以这些定向通过替代。

追加隔离 profile 的 classic 双 Client 跨会话检查：S1 外部 held Run 启动，切至 S2 按 Ctrl+C 不停止 S1，重新 `/load S1` 后 Ctrl+C 确认 interrupted/confirmed，目标输入及 Provider 请求各一次。该探针同时复现独立残留：冷启动 Session 的首条消息仅来自外部 Client 时，`/new` 仍按本地空 `context.messages` 误报 already empty；先完成本端一轮后才可继续上述切换检查。不能把后续 Stop 隔离通过当作 `/new` 已通过；待补 Host 判空消费接线与双端回归。

完整套件首轮另发现 Verifier 实时条目与 Host 重启恢复的 icon 形状不一致；修复须保留原兼容字段，同时保留新增两维事实，不能放宽原完整相等断言。三种分类往返相等先 RED 3 项、修复后 GREEN；独立 Ink 保存也必须保留两维，未知旧分类再次保存仍不得猜成 revise。收尾定向 9 文件 124 项通过。运行 daemon smoke 前必须先完成构建；运行中重写源码或安装产物会按设计触发 earlier-build 保护。本轮首轮确有此验证安排错误，3 个 daemon 失败不能描述为产品超时，也不能据此移除保护。首轮完整结果为 16144 passed / 6 failed、零未处理错误，最终复验另记于设计块。

最终修正后的构建、源码及测试类型检查均 EXIT 0；在其完成后单独跑默认完整集合，沿用 Windows 4 worker、`--retry=0`，dot/JSON 与 Temp 报告耗时诊断：1112 文件通过、1 跳过；16150 项通过、0 失败、77 跳过、21 todo，EXIT 0，未处理错误 0。收尾两轴复审均无剩余 finding。测试清理未确认的警告仍单独记录，不能把通过的行为断言说成进程树已完整验证；一次未复现 RPC timeout 也不能证明历史运行器故障已根治。当前版本的门禁结果以本段及设计块最终记录为准，前文 c94d73ab 是上一轮历史结果。

最终完整套件后再跑原生 `--exposure-only`，双端 8/8、EXIT 0。限定检查本轮 11 个清理警告目录的 17 条 unresolved 记录，目标 PID 当前均不存在；未证明完整后代树已清理，保留原始记录，不删除目录或终止其他进程。

## T53–T56 输出所有权回归

```bash
npx vitest run src/sdk-client.output-ownership.test.ts src/session-view.output-ownership.test.ts src/session-view.output-notice.test.ts packages/coding/src/task-engine/_internal/managed-task/llm-adapter-output.test.ts
npx vitest run packages/repl/src/ui/client-plane.test.ts packages/repl/src/interactive/classic-plane-display.test.ts src/acp-client-view.test.ts packages/repl/src/ui/utils/message-utils.test.ts packages/repl/src/ui/utils/restore-history.test.ts
```

第一组使用真实 HTTP Provider、SA/AMA 执行器、Host、IPC Client、Session 存储和生产显示适配器；HTTP fixture 只替代模型，不替代运行时。观察流式阶段、正式提交和 Host 重启，要求同一输出身份持续、正文只出现一次、重启不调用模型。真实 `finish_reason=length` 验证 SA 下一消息与 AMA adapter 内续写的不同边界。Sidecar 的独立验证请求不得计作第二份主回答。

正文用例包含普通代码围栏、首尾空白、标记的每个可能切分、续写请求间分割标记及中断时尚未发出的普通尾巴。主回答与续写/拒答提示分别计数，不允许提示拼进正式正文。多 thinking/text 块必须保留全部内容且不凭空添加分隔符。

Host 验证 canonical 先保存、display checkpoint 后到、取消 partial 的保存恢复、窗口外已提交内容、压缩归档的 outputId 保留，以及不同身份的相同文字均存在。新身份数据不得成为旧文本匹配算法的候选。显示正文提交后不能由旧 draft 覆盖；`readItem` 与当前正文权威一致。

消费者检查整个帧序列：重复快照/重挂接不重印，同一项修订明确显示，不同项同文分别保留。长正文普通追加不全文重读；有界前缀修订与 draft→committed 交接校验完整内容。冻结展开在分页之间发生 revision/state 改变必须明确失败，尤其不能把重启后的 committed revision 0 当成旧 draft revision 0。已展开旧全文仍维持冻结浏览行为。

不修改用户的原始 Session，不承诺旧无来源身份记录可无损修复，也不把尚未 checkpoint 的每个 token 承诺为崩溃可恢复。最终构建、全量门禁和独立评审结果在本次执行完成后追加，前面 T48–T52 的历史结果不替代本轮验证。

原生 PTY 首轮曾在 AMA held reply 暴露普通标识符末尾 A 被暂存的问题；最终 marker 检查只在合法单词边界暂存词类前缀，并保留 fence/bracket 规则。真实 adapter 必须在 Provider 尚未结束时完整发出 `BEGIN_ACCEPT_HOLD_AMA`，且非法候选不能挡住后面的合法 marker。修复后主矩阵 47/47、EXIT 0；首轮失败不能删除。guardrail 修订提交后冻结的长项移出窗口仍须完整展开，committed revision 固定 0，旧 draft 的同 revision 不能跨阶段误读。

本轮全量首轮 EXIT 1（25 项失败、3 个未处理错误）；16 个失败文件串行复验为 240 通过、1 失败、2 个未处理错误。剩余 stale-stop 测试用明确 marker 释放代替固定 10 秒时序假设，保留原超时与身份断言；最终与 filter 定向 13 项通过。`onTaskUpdate` 运行器超时仍须采集诊断，不能忽略或凭重跑通过宣称已根治。完整日志为 `%TEMP%/kodax-output-full.log`、`kodax-output-failures-isolated.log`，本轮最终结果另行追加。

第二次完整集合为 16209 通过、4 失败、1 个未处理 RPC 超时，EXIT 1。Memory review 的共享用户 home 扫描通过阶段计时确认：给该请求设置独立 `context.configHome`，等待 review 启动从 14.707s 降到 150ms，保留原断言与超时，完整 fixture 文件 7/7 通过。两项真实 IPC 历史读取冲突继续查写入边界；A2A ready 等待虽单独复验通过，不能据此宣称根因已修。完整日志及 JSON：`%TEMP%/kodax-output-full-final.log`、`kodax-output-full-final-results.json`。

补充 `npx vitest run src/sdk-client.history.test.ts --maxWorkers=1 --retry=0`：真实 Host 的 terminal display checkpoint 持锁时，page／entry 读取应等待其结束；释放后新页返回完整正文、旧 entry 仍返回 `resync_required`。两个缓存入口复用现有预算内 flush，保持外部并发写入检查；两项先 RED 后 GREEN，完整文件 7/7。这证明已修复可确定复现的自身 checkpoint 竞态，不能反推没有 writer 标识的旧全量日志。增量双轴评审均 0 finding。

追加真实队列保存前 gate：观察端先读旧历史，保存放行后输入行与其 afterInputId 输出应在原 3 秒限内同时出现，不需要额外输入或查询刺激。`src/sdk-client.queue-boundary.test.ts` 10/10；第三轮完整集合仍有 8 项失败及 2 个未处理错误，EXIT 1，失败与 fixture/RPC 定位记录见设计块，不能覆盖历史失败。worktree 假进程边界隔离后 37/37，RPC 5/5 返回；hook 23/23、ACP/alias 8/8。完整门禁须读取最终退出码、失败与未处理错误计数。

最终源码构建与类型检查均 EXIT 0；其后原生 `--long-history-only` 与 `--queue-boundary-only` 分别 7/7、EXIT 0。独立完整运行默认 4 worker、retry 0：1117 文件通过、1 跳过；16217 项通过、0 失败、77 跳过、21 todo，EXIT 0，未处理错误 0，源码哈希无变化。日志/JSON：`%TEMP%/kodax-output-final-gate.log`、`kodax-output-final-gate-results.json`。两轴评审无剩余 finding；清理未确认警告仍保留，真实 GUI 人工验收与覆盖率未在本轮测量。此前主 PTY 47/47、consumer 14/14，不与本轮最后两项重复累计为独立用例总数。

## SDK 契约补缺回归（2026-10-07）

基于主分支 `aaaf3c51` 与现有 Product Client v1，补齐 Workflow 摘要事实、排队 Skill 识别及授权的 Session 归属；不新增 RPC、能力版本或配置项。

```bash
npx vitest run src/sdk-client.workflow.test.ts src/sdk-client.queue.test.ts src/sdk-client.queue-boundary.test.ts src/sdk-client.permissions.test.ts src/session-input-queue.test.ts --maxWorkers=1 --retry=0
npm run build
npm run typecheck
```

- Workflow：经真实双 Client/IPC 在暂停、恢复及终态比较列表与详情的 `displayName`、`updatedAt`；跨 RPC 在稳定时间窗比较。模拟旧 Host 缺少摘要字段时使用已有详情读取；详情缺失必须失败，不能合成时间。
- Skill：正文中间的已注册引用在 idle、after_turn、redirect 下应用同样的 model、参数及动态上下文；入队时 hook 未运行，消费时读取更新后的动态上下文。Skill 前后的未知 slash 文本不计入多 Skill 冲突，也不截断参数；路径、URL 和未知名称留在普通批次。两个已知引用须拒绝且不入队、不停止原 Run。既有队列边界夹具显式创建真实注册 Skill。
- 授权：两个 Session 创建同标签授权，新连接仅依公开的 `sessionId` 区分，按原有 ID/revision 撤销一个，另一个保留，陈旧 revision 仍被拒绝。

三处原始缺漏均先复现 RED。评审另发现未知 slash 截断参数，新增 `$ARGUMENTS` 断言先失败再修正。定向首轮 26/27；剩余断言混入后台 Memory review 请求，按已有夹具模式分流该请求后队列文件 8/8，其他四文件 19/19。较早一次并行类型检查期间队列保存观察超时，随后串行边界文件通过；不把复验描述为首轮全绿。构建与类型检查均 EXIT 0，双轴静态评审无剩余 finding。

本轮不运行付费模型 eval，也未测量覆盖率或重复原生 PTY/GUI 验收。完整默认集合的结果在运行结束后追加，历史门禁不替代本轮结果。

最终完整默认集合（默认 4 worker、retry 0）EXIT 0：1150 文件通过、1 跳过；16526 项通过、0 失败、77 跳过、21 todo；未处理错误 0。构建后测试期间未修改生产源码；日志与 JSON 为 `%TEMP%/kodax-sdk-contract-full.log` 和 `kodax-sdk-contract-full-results.json`。子进程清理未确认等既有警告保留，不等同于失败门禁；上述覆盖率和人工验收限制仍然适用。

## 2026-10-11 Result verification replacement

Regression scope: no completion-sidecar request, notification, scorecard or batch criterion pass; current image bytes reach the provider after repair; extension Stop and child/mailbox waiting survive; work-budget extension runs at ordinary execution boundaries. Host Goal tools on SA and AMA use atomic lineage mutation, preserve concurrent transcript/UI state, and propagate write failures/cancellation; parallel create claims are serialized. Legacy sidecar history still restores through Host, Ink and classic consumers. Stall detection and Auto permission review keep their own controls.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:bundle` with build completed and production files frozen before Host tests. New-module coverage uses session-binding and runner-stop-hook tests; assertions about model quality require a separate controlled eval. This change does not establish a measured quality improvement or validate every external renderer.

2026-10-12 validation: typecheck/build passed; bundle checks 41/41; Windows native suites and N-API smoke passed; actual Ink/classic PTY matrix 50/50. An actual npm tarball audit checked 74 bundles, confirmed the built-in visual-review skill, and found no retired verifier runtime. New session-binding/Stop modules: statements 96.15%, branches 100%, functions 90%, lines 94.59%.

The bundle check caught a 32K managed-compaction regression caused by expanded constant guidance (required 32,838 versus available 32,768). Shorter constant guidance with detailed steps in the skill restored the unchanged capacity test: RED → GREEN. Final full-suite verification after this repair passed 16,499 tests in 1,152 files, with 77 skips and 19 todo, zero failures and no unhandled errors. Source and build were frozen throughout; logs are `%TEMP%/kodax-result-review-final-frozen.log` and `kodax-result-review-final-frozen-results.json`. Final Standards and Spec reviews each reported zero remaining findings.

The final current-prompt pilot observed one evidence-seeking response: `read` the PNG, without issuing a visual verdict. The frozen conservative token budget stopped the other three cells; this is no quality comparison. Raw data and structured main-session review: `%TEMP%/kodax-eval-dumps/result-review/1791735672929-e5835a965439`. Existing cleanup warnings retained 17 records in 11 test directories; the recorded PIDs were absent when checked, which does not prove complete descendant-tree cleanup. Cross-platform manual verification remains outside this Windows run.

## 2026-10-12 Real visual E2E smoke

Used the built SDK's real Session → managed AMA Run → production tools → `kimi-code/k3-256k` transport, with actual model responses. Three grouped cases, no children; frozen limits: 60 physical requests including auxiliary requests and invalid pilots, 26 requests/24 rounds/70 tools/10 minutes per positive Run, 8M conservative token reservations. Runs were sequential, but native Learning/Stall requests initially overlapped the primary stream: a scheduling-protocol deviation, so these are functional observations, not a compliant provider-concurrency or quality benchmark. The final missing-tools phase gated all provider streams to one in flight. No baseline/candidate quality comparison. Each render embeds a fresh pixels-only random code; request image SHA256 and the model's reported code must both match. Completion, paths and renderer exits do not establish visual success.

| Scope | Actual evidence and result |
|---|---|
| PNG, PPTX, PDF, XLSX | Read all five original images; repaired covered titles/data and the missing-month total; rerendered and read five fresh images. Exported PPTX/XLSX were imported before rendering; PDF's two pages were decoded by Poppler. Total changed from 30 to 60. All ten wire hashes/codes matched. |
| HTML interaction | Chromium captured 360/1000px after an actual click. Agent repaired overlap, mobile overflow and +2 instead of +1; fresh screenshots and interaction records showed +1 and no overflow. All four hashes/codes matched. |
| GIF and WebM | Decoded all four GIF frames and WebM at 0.2/0.7/1.2/1.7s. With caption Y365, agent found the missing/cropped middle-stage caption, changed Y to 320, rerendered and reread eight fresh frames. All sixteen hashes/codes matched. Caption checks passed; faint WebM encoding residue remains, so overall video quality is not certified. |
| Missing evidence phase | The real `context.toolVisibilityPolicy` first exposed skill/grep: six physical requests contained zero images, with source/signature checks separated from unverified visual requirements. Final skill-only phase serialized primary and auxiliary streams: three physical requests, maximum one in flight, zero images, all seven files explicitly unverified. |

Two production gaps were fixed with RED → GREEN regressions: provider snapshot capability profiles were not forwarded to live instances (24 tests now pass); split SDK skill discovery searched nonexistent `dist/chunks/builtin` instead of packaged `dist/builtin` (new bundle test discovers and loads visual-review). The static repair Run preceded the discovery fix and explicitly reported the missing skill; subsequent HTML/media/negative Runs actually loaded it.

Retained diagnostics: the first output guard rejected an auxiliary call; that interrupted sample is invalid. The first negative setup did not remove actual image delivery, so it is invalid as a missing-image-input test. The first temporal Run read all current frames but overstated clipping in WebM at Y350; its raw and the unsupported finding remain recorded. Only changed inputs were replayed. Extra fixture renders with no model observation are not scored. These results do not establish perfect visual judgment, Office-native fidelity, cross-provider/platform coverage, complete video continuity or audio verification.

Raw requests/responses, immutable renders, experiment revisions, hash/code audits and structured main-session assessment: `%TEMP%/kodax-eval-dumps/result-review-e2e/13451d22bc464c13b7a0abbe3211f721`. Total: 59 physical requests; 30/30 inspected before/after codes match independently hashed native request images. No further model calls. Production files/build remained frozen during regression checks; final gate results follow.

Final gates: typecheck/build passed; complete default suite (Windows 4 workers, retry 0) passed 16,515 tests in 1,152 files, with 77 skips/19 todo, EXIT 0 and no unhandled errors. All 81 recorded source/build hashes matched at full-suite end. Review then isolated the new bundle test from user/project/plugin skills; only that test changed afterward. Bundle 42/42 and Windows native/N-API checks passed, EXIT 0; both review axes have zero remaining findings. Existing child-cleanup-unverified warnings (11 in the full log) remain retained; no complete descendant-tree cleanup claim. Logs: `%TEMP%/kodax-visual-e2e-{typecheck,full,bundle,native}.log`; full JSON: `%TEMP%/kodax-visual-e2e-full-results.json`.

## 2026-10-12 Native Office and autonomous non-Office PPT review

The earlier application probe missed installed 32-bit Office. Real PowerPoint/Excel 16.0 now opened the generated files read-only: two native slide PNGs plus an Excel-exported PDF decoded to PNG. KodaX found covered headings/data and total 30, repaired the layout/formula, rerendered through Office, and reread three new native images showing visible headings/data and total 60. All six before/after image hashes and pixels-only codes matched actual provider requests.

The second case supplied no screenshots or rendering command. A project-discovered optional `pptx-preview` skill and installed artifact-tool renderer were available; PowerPoint/Excel/LibreOffice/COM were excluded from this route. KodaX discovered the skill/package scripts, imported the actual final PPTX and read two slide images, repaired both covered titles, rebuilt the PPTX, and rendered/read two fresh images. All four hashes/codes matched. The npm script entry failed identically outside KodaX; the agent independently used the same renderer via direct Node execution and completed the task. No production shell change was made.

**Capability boundary:** PowerPoint is optional. Autonomous PPT review requires an available final-PPTX renderer/format skill and image-capable model; KodaX currently does not bundle a full PPTX renderer. An environment can provide a headless renderer such as [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html), or a format-tool/MCP integration. Neither source inspection nor an approximate HTML reconstruction certifies the final PPTX. With no usable renderer/image delivery, the correct result remains unverified. The non-Office route was tested with Office excluded on this Windows host, not on a physically Office-uninstalled machine.

Two bounded cases, 22 physical requests including auxiliaries, max one provider stream in flight; 80 production source/build hashes unchanged from the prior gate. Raw, immutable native/non-Office renders, preflight failure, npm diagnostic and structured main-session assessment: `%TEMP%/kodax-eval-dumps/result-review-office/89632d90a0c1498791c4a345466c980c`. No runtime source or dependency change, so prior regression gates were not repeated. This closes the inspected static Office/PPT workflow; animations, other Office versions and the earlier video residue are not covered by this extension. Native model output also contains an unsupported incidental claim about invisible bottom images; the nonce badges are visibly present, and that claim remains in raw evidence.

## 2026-10-29 Unified Host SDK cutover (unreleased)

Baseline: `466b874d`, after `v0.7.97-alpha.11`. The accepted H01–H05 slices are in
[the feature design](../features/v0.7.97.md#2026-10-29-统一-host-sdk-收口未发布).
Public root and `/runtime` exports now provide shared Host connections; isolated
core tests use the non-published `tests/runtime-fixture.ts`. Tests of public
construction, launch/bootstrap, declaration compatibility and installed artifacts
continue to use the public entry. No version bump or publication is included.

The policy transition writes `mode: host` atomically under profile and canonical
Session-root coordination. Its current wire projection remains `daemon`, without
internal migration fields. Repeated startup is idempotent. Alive, unknown or corrupt
inline owners, ambiguous descriptors and storage fences block migration; a failed
publication preserves the old policy, while a failure after publication never
rolls back. Original requested profiles must also be fenced when startup reuses a
Host under another profile. New-owner `execPolicy`/`autoReview` bootstrap remains
supported, and attach cannot overwrite those policies.

Historical owner evidence pins exact Git objects and hashes all executed sources:
`v0.7.96` (`c2c8fdc41f4e0b50fa1c2d0b24142586f155777c`) and alpha.11
(`0f3930e95e0286fd360826cf14f6f5c0d63d0fa5`). These are actual historical readers and
rollback writers, not simulated versions. Their scope is the ownership protocol;
a separate real published-package test covers a running historical Host. The
installed candidate test uses an actual `npm pack` artifact and its declarations,
with declared external dependencies supplied from the local install. It checks
retired imports/calls, a distinct owner PID, bootstrap cleanup, detach semantics,
concurrent first launch, cross-profile reuse and refusal by old rollback writers
after exact Host exit. It does not prove compatibility with arbitrary old private
writers that never recorded a shared owner fence.

During implementation, RED tests exposed the old public embedded/default entry,
public inline helpers, and the in-process external-agent daemon. A later strict
management-schema test caught an internal `unified` field leaking into the wire;
the projection now contains only the existing policy DTO. Independent Spec review
then reproduced a missed requested-profile migration when profile B reused Host A;
the actual tarball test failed with `inline !== host` before the repair. The first
complete bundle run returned EXIT 1 (51/54): three Memory-review fixtures still
constructed embedded owners. Their recovery now starts a replacement shared Host,
retaining cancellation, pending state, request-count and unique-receipt assertions;
the targeted three tests then passed. These intermediate failures remain part of
the evidence and do not count as the final gate.

Validation on 2026-10-30 (Windows; final source build):

- `npm run build` and both source/test `npm run typecheck` checks: EXIT 0.
- `npm run test:host-cutover`: 3/3, EXIT 0, including both historical readers,
  two independent first-launch processes and requested-profile B → live Host A →
  exact shutdown → old B rollback rejection. Actual candidate npm tarball SHA256:
  `5a04d1461af3f560550321f847f6497473f2ba4d08defdb82d92332d2ab0a2c4`.
- `npm run test:bundle`: 54/54, EXIT 0. `bundled-artifacts`: 3/3, EXIT 0, using the
  installed Chrome. These include current-build crash/cleanup, review shutdown,
  restart/history/tool-original, task-report and work-mode regressions.
- All 28 `runtime-daemon` test files: 470 passed, one platform-specific skip.
  `state.ts` coverage: statements 86.01%, branches 80.77%, functions 97.33%,
  lines 89.59%. This is module coverage, not an unmeasured repository-wide claim.
- `npm run test:host-upgrade`: 1/1, EXIT 0 with `KODAX_ALPHA11_TARBALL` set to the
  actual published alpha.11 archive. The test checks the fixed SHA512 before
  extraction. Provision it explicitly with `npm pack @kodax-ai/kodax@0.7.97-alpha.11
  --ignore-scripts --pack-destination <temp>`; no implicit download or skip occurs.
  Linux npm-release and Windows CI jobs provision that exact package and run the
  gate. Non-bundled dependencies reuse the installed test environment.

The historical Host test launches unmodified alpha.11 code, completes a real local
shell append and holds the next fixture-provider response, then replaces code at
that same installation path. A fresh SDK refuses busy upgrade and preserves the
old PID/runtimeId. After the old Run completes, idle upgrade changes the Host and
build fingerprint while retaining origin, activeMessages, Session title, workMode
and completed Run status. Primary requests remain 2 → 2 and the marker contains
one append. A separate background Memory review is identified by its actual tool
contract, not counted as a replayed user Run. This is not a byte-for-byte comparison
of every persisted file, and it does not cover an old stopped Run or active
checkpoint/unknown-effect recovery across versions; current-build tests for those
contracts remain separate evidence.

Standards review also found a missing cancellation boundary in the new historical
test. Its request wait now has a 30-second deadline and test cancellation signal;
`finally` and `t.after` share idempotent cleanup that waits for Run termination.
Temporary fault variants exercised both request-deadline failure and actual
node:test cancellation: each closed the exact Host successfully and exited. The
tracked successful test retains its original 180-second total timeout. Both review
axes report zero remaining findings after the fixes and actual-package evidence.

Source/build logs are `%TEMP%/kodax-host-cutover-final-{build,typecheck}.log`;
package evidence is `kodax-host-cutover-final-package.log`. Full bundle and browser
logs are `kodax-cutover-bundle-final-20261030-000242.log` and
`kodax-cutover-artifacts-final-20261030-000438.log`. Historical process evidence is
`%TEMP%/kodax-historical-host-upgrade-r34Bip/evidence.json`; state coverage is in
`%TEMP%/kodax-state-coverage-5d05fabb8d1a4a7b9d1703dc3f77827d/`.

The initial full default run was interrupted after the reviewed production repair
and a Memory-review test failure; it is not a passing final gate. Its log is
`%TEMP%/kodax-host-cutover-full.log`. Final default-suite results follow separately.
Cross-platform jobs are wired but not executed locally, and no npm/GitHub release,
live-provider quality eval, or external consumer upgrade is claimed.

The Memory-review failure was reproduced at its original one-second polling
assertion, then traced with a temporary test-only probe: after releasing the
reviewer, durable background work remained pending until 635ms and requestStop
arrived at 715ms even in the passing low-load case. Reviewer return is not durable
settlement. The test now uses its existing bounded `awaitEvent` helper to await
actual requestStop, while retaining the no-stop-during-review, un-aborted signal
and exactly-once assertions. All probes were removed; the complete file passed
13/13. Production code and build were unchanged.

The next shared-checkout full run completed with 19 failures, 17,993 passes,
97 skips and 19 todo cases. Ten failures exposed old test seams: ACP fixture
ownership setup, the CLI's renamed internal constructor mock, the child-process
core constructor, the live legacy-owner refusal message and a missing mocked
owner-preparation dependency in pure upgrade orchestration. These fixtures were
repaired with their behavior assertions retained, and the affected files passed
individually. The other nine failures belonged to sandbox tests another task
added while this run was in progress. This was not a frozen passing candidate.
The original log/JSON are `%TEMP%/kodax-host-cutover-final-full.{log,json}`.

Final validation therefore uses an isolated checkout of `466b874d` with only this
Host-cutover patch. The other task's sandbox/A2A files and its two overlapping SDK
guide hunks are excluded and preserved in the original checkout. Fresh isolated
build/typecheck passed. A first isolated bundle run returned 52/54: npm packed
paths outside the package through test-environment dependency junctions, and an
existing Product-exit test observed `readExit: ready` followed by a fresh
`listPendingExits: daemon_active` assessment. Copying the bundled dependencies
locally fixed the package layout without product changes (Script release 2/2).

The Product-exit assertion also failed in an independent repeat. Both queries
use the same existing fresh process-identity verification; unknown identity
continues to block recovery. The exact OS cause was not established, and no PID
reuse claim is made. The test now retries for at most 20 seconds only when the
same old request/runtime/client/owner and unchanged cleanup facts report
`blocked / daemon_active / retry_verification`. Other evidence fails immediately.
The empty-list, replacement-Host usability, old-request idempotence and unchanged
durable-receipt assertions remain. Temporary probes were removed. Independent
review found no remaining issue in this change or the late fixture repairs.

The two failing Product-exit runs also exposed a test-cleanup defect: `finally`
disconnected and removed storage immediately after requesting shutdown, without
waiting for actual process exit. Their two exact test Host/supervisor trees were
identified by PID, creation time, command and temporary home, then cleaned up.
The fixture now waits for verified exit before removing its directory; if exit
cannot be verified, the failure stays visible and the directory is retained.
This changes test cleanup only, not production shutdown or recovery semantics.
A temporary fault-injection copy then threw immediately after replacement Host
creation. It exited 1 with the intentional error still visible, verified cleanup
first, and an independent process check confirmed both exact Host/supervisor PIDs
were gone and the temporary home was removed. The probe was deleted; its log is
`%TEMP%/kodax-exit-cleanup-injection-20261030-010103.log`.

The isolated full suite also exposed an existing snapshot-test wall-clock
assumption. An independent exact-case run returned the required `read_cancelled`
but took 113ms against the test's 100ms threshold. The production read-budget and
snapshot implementation was unchanged from the baseline. The test now blocks
actual `.entries` I/O with an explicit gate: the 20ms caller timeout and a signal
abort must reject with their exact codes before the gate is released. After
release, both Sessions must return their original content. A five-second test
observation guard fails and releases the gates in `finally` if cancellation
regresses. The exact case passed; independent review found no remaining finding.
The full-file confirmation is recorded with the final validation below.

The two historical live-provider eval scripts remain explicitly historical:
their in-process provider/budget instrumentation cannot control a separate Host.
They were not mechanically converted to daemon mode or run as paid live evals.

Isolated final-candidate evidence (2026-10-30, Windows):

- Full default suite, retries disabled and four workers: 1,283 files passed,
  six skipped, one failed; 17,996 cases passed, 97 skipped, 19 todo, one failed.
  Duration: 1,490.91 seconds. The sole failure was the snapshot test's 100ms
  wall-clock threshold (124ms in the full run; the separate cancellation repro
  was 113ms). No production failure was observed. This is the actual full-run
  result, not a claim that the original full invocation exited zero.
- The production source and built-runtime identities were verified unchanged
  across that run: source fingerprint
  `286206bea6fcdcb0b4d85782596ac6f5ca75d41f273c187ca88866a22f8d2d0e`,
  built fingerprint
  `23ddfeb0c44eab6e7a9a2568c3f469e1e2a5013477fe65319131e36ee8723943`.
- Isolated actual-package cutover: 3/3, EXIT 0; tarball SHA256
  `1e0d45e7b4d91a0d6e7567493d949cdf33f19d3d7eb7498652a4203206b61826`.
- Isolated published-alpha.11 in-place Host upgrade: 1/1, EXIT 0; evidence at
  `%TEMP%/kodax-historical-host-upgrade-scpdbH/evidence.json`.

The isolated full log/JSON are `%TEMP%/kodax-host-isolated-full.{log,json}`;
package and historical process logs are `kodax-host-isolated-package.log` and
`kodax-host-isolated-historical.log`. Test-only repairs do not change the runtime
fingerprints above. Their final file/bundle confirmation follows below.

Final confirmation after the test-only repairs:

- `src/sdk-runtime.test.ts`: the complete file passed 337/337 with retries
  disabled (216.98 seconds, EXIT 0), including the deterministic budget/cancel
  case. Log/JSON: `%TEMP%/kodax-host-isolated-runtime-final.{log,json}`. The other
  full-suite files were not rerun after this test-only correction; their
  production code and tests remained unchanged.
- Source and test `npm run typecheck`: EXIT 0 after all fixture edits; log
  `%TEMP%/kodax-host-isolated-typecheck-final.log`. The isolated full build had
  already passed before production was frozen (`kodax-host-isolated-build.log`).
  No repository lint script is defined.
- Complete `npm run test:bundle`: 54/54, EXIT 0, 83.26 seconds; log
  `%TEMP%/kodax-isolated-bundle-final-20261030-011458.log`.
- Chrome artifact acceptance: 3/3, EXIT 0, 21.74 seconds; log
  `%TEMP%/kodax-isolated-artifacts-final-20261030-011632.log`. A subsequent process
  inventory found no remaining test Hosts from these runs.
- Standards and Spec reviews have no remaining findings; the final fixture
  changes also received independent read-only review. The original checkout's
  unrelated changes were verified unchanged and excluded from this commit.

H01–H05 implementation and local verification are complete. This does not mark
the package published, cross-platform CI executed, external clients migrated,
or the explicitly unverified cross-version recovery scenarios accepted.
