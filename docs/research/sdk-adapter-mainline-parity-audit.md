# 当前 Product Client 对 SDK、ACP、A2A 和单次 CLI 的主线能力承接还有哪些缺口？

摘要：共享 Host 的连接、所有权、核心交互、长输出和取消已有实际承接；本轮确认 ACP repo-intelligence 参数跨进程丢失并完成定向修复，另确认 one-shot 临时设置覆盖其他客户端更新。ACP 诊断 trace 记录为契约范围差异；A2A 已完成 Run 的恢复缺结果属于主线继承问题，需与本次新增回归区分。[src/sdk-client.ts:24](../../src/sdk-client.ts#L24)、[src/acp_server.ts:1038](../../src/acp_server.ts#L1038)、[src/one-shot-task.ts:178](../../src/one-shot-task.ts#L178)、[src/a2a/server.ts:1678](../../src/a2a/server.ts#L1678)

## 范围与证据

- 审计基线为 `origin/KodaX=7b5b1b9e`，当前分支快照为 `0841fb51726bcce437f5952483a072a662dbbf84`；使用 `git diff origin/KodaX..HEAD`、源码和仓库测试作为 primary sources。本报告的基线缺口以该 commit 为准，避免把同一轮其他 Agent 的修改当作既有行为。
- 判断标准为 FEATURE_298 的“不退步”约束与 ACP/A2A 迁移条款；方法减少本身不算能力减少，可信 Host 内部仍使用 Runtime 也不构成第二 owner。[docs/features/v0.7.97.md:133](../features/v0.7.97.md#L133)、[docs/features/v0.7.97.md:350](../features/v0.7.97.md#L350)
- 本轮只修改 `src/acp_server.ts` 与其现有真实 Host 测试；其余问题交主 Agent 汇总。下方将已修复、待修复和主线继承问题分别标明。

## 已确认：真实能力已经承接

| 能力 | 源码与现有验证 | 判断 |
| --- | --- | --- |
| SDK 连接与启动 | `connectKodaXClient` 被动连接并要求 productClient v1；`ensureKodaXClient` 委托统一启动器。[src/sdk-client.ts:24](../../src/sdk-client.ts#L24) | 没有独立产品引擎或失败时 embedded 回退 |
| 退出、后台、多 Client | `disconnect` 映射连接关闭，Host shutdown 单列；真实双 Client 测试覆盖提交者断开、另一 Client 继续观察。[src/client-runtime-adapter.ts:18](../../src/client-runtime-adapter.ts#L18)、[src/client-runtime-adapter.ts:271](../../src/client-runtime-adapter.ts#L271)、[src/sdk-client.lifecycle.test.ts:57](../../src/sdk-client.lifecycle.test.ts#L57) | 不应再报告为未保留后台运行 |
| 当前态与重连 | daemon view 订阅有重订阅、连接代数、interrupted/closed 状态；产品契约明确重连取当前态，无通用 mutation replay。[src/runtime-daemon/client.ts:1637](../../src/runtime-daemon/client.ts#L1637)、[docs/CLIENT_CONTRACT.md:287](../CLIENT_CONTRACT.md#L287) | 旧 journal 删除不等于观察不可恢复 |
| ACP 实际执行、工具与取消 | 默认 `ensureKodaXClient`，通过 input/observe/await 执行；真实协议测试验证共享 Host、长文本拼接、工具结果、私有 Session MCP、permission、queued cancel、delivery failure、dispose。[src/acp_server.ts:667](../../src/acp_server.ts#L667)、[src/acp_server.ts:1025](../../src/acp_server.ts#L1025)、[src/acp_server.daemon.test.ts:15](../../src/acp_server.daemon.test.ts#L15) | 不把显式 Runtime 注入的 embedder 接缝误判为生产旁路 |
| ACP 有界输出补读 | 按稳定项 ID，正文/参数不足时通过 readItem 翻页补齐；替换文本追加显式 Updated response。[src/acp-client-view.ts:28](../../src/acp-client-view.ts#L28)、[src/acp-client-view.test.ts:53](../../src/acp-client-view.test.ts#L53) | 不应重复历史已修“长输出被截断”问题 |
| One-shot 结算与无人交互 | input→Run 身份→runs.await；未知终态无结果会报错；本 Run 的 permission 拒绝、question/MCP取消；SIGINT 请求 Host stop。[src/one-shot-task.ts:50](../../src/one-shot-task.ts#L50)、[src/one-shot-task.ts:206](../../src/one-shot-task.ts#L206)、[src/kodax_cli.ts:630](../../src/kodax_cli.ts#L630) | 接收/保存/成功未混同，无人交互不再挂到全局超时 |
| A2A 受限执行与热更新 | prepared execution 在 Host 内绑定 owner/workspace/policy；CLI 已委托 daemon serving；hot 字段仍在 Host watcher 执行 updateHot。[src/a2a/server.ts:1719](../../src/a2a/server.ts#L1719)、[src/integration-cli.ts:943](../../src/integration-cli.ts#L943)、[src/kodax_cli.ts:919](../../src/kodax_cli.ts#L919) | 删除 CLI 本地 watcher 不等于删除热更新；不能要求普通 UI 注入执行工厂 |
| A2A 协议幂等与继续输入 | task/principal/messageDigests 仍由 A2A store 保存；pending input 用当前 Run 和当前输入注册表恢复，保留 A2A eventSeq。[src/a2a/task-store.ts:8](../../src/a2a/task-store.ts#L8)、[src/a2a/server.ts:1234](../../src/a2a/server.ts#L1234)、[src/a2a/a2a.test.ts:1340](../../src/a2a/a2a.test.ts#L1340) | Runtime cursor 退役未删除协议自己的去重与状态 |

## 已确认：缺口及本轮修复

### A. ACP repo-intelligence 启动参数没有到达已存在的 Host（本轮已修复）

**原行为与回归来源：** CLI 接收 `--repo-intelligence` / `--repo-intelligence-trace` 后只修改本进程环境。主线 ACP 自建 Runtime 因而可读同一进程环境；当前分支默认 ACP 改连共享 Host，但 `promptThroughHost` 的 settings patch 没有这两个字段。启动之前已经存在的 Host 不会继承后来的 ACP 环境，导致相同命令在冷启动与复用 Host 时采用不同配置。`origin/KodaX:src/acp_server.ts` 构造器的 `createKodaXRuntime` 与 `0841fb51:src/acp_server.ts:1035-1041`、[src/kodax_cli.ts:3927](../../src/kodax_cli.ts#L3927) 为直接证据。

**复现与修复：** 在已有 ACP 协议→真实 daemon Host 测试中，构造 ACP 时环境为 `light/1`，发请求时恢复 Host 环境为 `off/0`。修复前 Host `sessions.getSettings` 仅有 provider/thinking/reasoningMode/permissionMode，断言所需的 `repoIntelligenceMode:'light', repoIntelligenceTrace:true` 均缺失（RED）。修复后 ACP 构造时复用 `resolveRepoIntelligenceRuntimeConfig`，以现有 Session settings 传给 Host，不新增配置或执行入口（GREEN）。[src/acp_server.daemon.test.ts:72](../../src/acp_server.daemon.test.ts#L72)、[src/acp_server.daemon.test.ts:97](../../src/acp_server.daemon.test.ts#L97)、[src/acp_server.ts:648](../../src/acp_server.ts#L648)、[src/acp_server.ts:1043](../../src/acp_server.ts#L1043)

验证命令为 `npx vitest run src/acp_server.daemon.test.ts src/acp_server.admission.test.ts src/acp-client-view.test.ts --maxWorkers=1`；2026-09-14 本轮实际结果为 3 suites / 11 tests passed，31.29 秒。它验证参数到达实际 Host、已有 ACP 输出与取消回归；不是所有平台的真实独立进程配置矩阵。

### B. One-shot 参数使用共享 Session 设置再无条件恢复，可能覆盖另一 UI 的最新选择（交主 Agent 修复）

**确认行为：** `runOneShotClientTask` 先保存 previousSettings，把 provider/model/effort/maxIter 等调用参数写入共享 Session，运行结束后按 previousSettings 无条件写回。同一调用期间另一个 Client 更改同一字段，会在 one-shot finally 被覆盖；即使该值是用户刚选的新模型，也会恢复为调用之前的旧模型。源码注释承认并发 Run 会看到临时设置，但没有处理并发 UI 设置更新的丢失。[0841fb51:src/one-shot-task.ts:178-193](../../src/one-shot-task.ts#L178)、[0841fb51:src/one-shot-task.ts:251-263](../../src/one-shot-task.ts#L251)、[docs/CLIENT_CONTRACT.md:97](../CLIENT_CONTRACT.md#L97)

**实际最小复现：** 使用 `node --import tsx --input-type=module` 调用真实 `runOneShotClientTask`，测试 Client 的 getSettings 初值为 `{model:'before'}`，调用传 `{model:'one-shot-override'}`，`runs.await` 期间另一 Client 写 `{model:'changed-by-other-client'}`。实际写入序列为 `[{model:'one-shot-override'},{model:'before'}]`，最终 settings 是 `{model:'before'}`。这是执行过的控制面复现，不假称真实跨进程负载测试；触发点直接对应原函数两处 updateSettings。

**必要边界：** 这是一个明确的 per-invocation scope 与 shared Session scope 冲突，不是需要重建通用操作回执。仅客户端 finally 读取后比较再恢复仍有 read→write 的竞态；最小可靠方案应由 Host 区分本次调用的参数与共享 Session 设置，或在 Host 做原子条件恢复。现有契约确实把 settings 定义为其他 Client 可见且下一次物理请求采用的共享事实。[docs/CLIENT_CONTRACT.md:61](../CLIENT_CONTRACT.md#L61)、[src/one-shot-task.ts:140](../../src/one-shot-task.ts#L140)

### C. ACP repo-intelligence trace 的诊断输出没有产品投影（明确残留，非本轮扩接口项）

默认 Host 路径在调用旧 `buildKodaXOptions` 前已经转入 `promptThroughHost`。旧方法内唯一的 `onRepoIntelligenceTrace`→`AcpRuntimeEvent(type:'repo_intelligence_trace')` 映射因此不会运行；`observeAcpClientPrompt` 只消费助手/thinking/tool项和交互，`ClientSessionView` 没有 repo-intelligence trace 字段。Host 仍会生成 `repo_intelligence.trace` 事件，而 one-shot 的底层只读 progress adapter 有相应转换。因此 ACP `eventSinks` / logger 在默认 Host 路径丢失已有 trace 信息，是输出面的承接缺口，不是“参数修好便代表 trace 体验全修好”。[src/acp_server.ts:934](../../src/acp_server.ts#L934)、[src/acp_server.ts:1236](../../src/acp_server.ts#L1236)、[src/acp_events.ts:130](../../src/acp_events.ts#L130)、[src/acp-client-view.ts:49](../../src/acp-client-view.ts#L49)、[packages/coding/src/client-contract.ts:450](../../packages/coding/src/client-contract.ts#L450)、[src/sdk-runtime.ts:19174](../../src/sdk-runtime.ts#L19174)、[src/run-progress-events.ts:247](../../src/run-progress-events.ts#L247)

**范围判断：** 当前契约开头明确“本文覆盖公开产品接口，不把 `/runtime` 的全部底层管理、执行和诊断 API 提升为产品承诺”，结尾也明确不承诺跨协议完全等价的瞬态输出。因此这里记录诊断消费差异，不能仅因它存在便扩展通用事件面或把它等同于模型/工具执行能力失效。本轮修复配置实际到达 Host 即止；以后若需要恢复该诊断体验，应单独明确承接形式，不在 ACP 私下重建执行或事件权威。本轮只确认源码生产路径没有消费者，未运行 trace logger 端到端实验。[docs/CLIENT_CONTRACT.md:5](../CLIENT_CONTRACT.md#L5)、[docs/CLIENT_CONTRACT.md:374](../CLIENT_CONTRACT.md#L374)

### D. A2A edge 离线期间 Run 已完成，再恢复时只有 phase，没有最终结果（主线继承，非本分支新增）

`recover()` 对仍活跃的 Run 会等待 `runs.await` 获得完整 RuntimeRunResult；对已经完成的 Run 却调用 `finishRun({runId,sessionId,phase})`，没有 result/error。`finishRun` 只从 `result.result?.lastText` 与 artifactLedger 生成最终消息/附件，因此会把 task 标记 COMPLETED 而缺最终正文和文件产物。主线同一分支也这样写；本轮 diff 只扩大活跃 phase 集合，没有引入这一遗漏。[src/a2a/server.ts:1678](../../src/a2a/server.ts#L1678)、[src/a2a/server.ts:1374](../../src/a2a/server.ts#L1374)、`origin/KodaX:src/a2a/server.ts:1607-1620`

可复现场景：A2A task 尚为 WORKING→关闭 edge、保留 Runtime→Run 完成→用同 dataDir 和同 Runtime 重建 edge→GetTask。现有重连测试在重建 edge **之后**才调用 `controlled.complete('reattached')`，所以不覆盖这个间隙。[src/a2a/a2a.test.ts:2305](../../src/a2a/a2a.test.ts#L2305)

这是旧 embedder edge restart 能力上的真实静态缺口；如今生产 prepared serving 与 Host 同进程，普通 Host 重启会改变 runtimeIdentity，走“中断”而不会进入这个同 Host 恢复分支，影响面较窄。FEATURE_298 T20 明确验收 A2A 断连重取的终态和附件，因此可纳入后续完善；不应以此宣称当前生产 Host 崩溃后还能恢复已执行工作。[docs/features/v0.7.97.md:578](../features/v0.7.97.md#L578)、[src/a2a/server.ts:1683](../../src/a2a/server.ts#L1683)、[src/kodax_cli.ts:919](../../src/kodax_cli.ts#L919)

## 未证实与明确非缺口

- 本次没有重新执行完整 SDK/A2A/所有 OS 的测试矩阵；上表未列本轮实际结果的测试只作为已有 primary-source 覆盖证据，不能当成本轮 fresh green。
- A2A continuation 的 file part 不会被 `continuationAnswer` 提取，此问题已在 T20 的残留中明确记录，属于主线继承；本轮不重复包装成迁移回归。[src/a2a/server.ts:290](../../src/a2a/server.ts#L290)、[docs/features/v0.7.97.md:578](../features/v0.7.97.md#L578)
- 浏览器 HTTP/WebSocket transport 不是已发布能力；Node SDK 与纯类型 Client 的存在不意味着当前已经支持浏览器远程连接。该事项不能作为本轮“不退步”补洞要求。[docs/CLIENT_CONTRACT.md:31](../CLIENT_CONTRACT.md#L31)
- ACP 无 question/form reverse channel、append-only 无任意文本替换是当前明确协议适配边界；已有客户端可以通过其他 KodaX Client 回答共享请求，不能据此要求构造不存在的 ACP 协议能力。[src/acp-client-view.ts:81](../../src/acp-client-view.ts#L81)、[docs/CLIENT_CONTRACT.md:308](../CLIENT_CONTRACT.md#L308)

## 未解问题

本轮后续验证：one-shot 并发恢复已由主任务补成 Host revision/CAS；新增真实双 IPC Client 回归通过。完整测试另发现 Auto 审查读取原始 Session 覆盖而漏合并 profile，已在每次 guardrail resolve 复用有效设置解析器；`src/sdk-runtime.test.ts` 的 Runtime/Product IPC 两种控制面与缓存回归共 3 项通过。最终整体验证见[汇总报告](product-client-reaudit-2026-09-14.md)。

1. 未来如需恢复 ACP 的 repo-intelligence 诊断 trace 展示，应以什么业务形式承接？当前产品契约未将全部 Runtime 诊断纳入承诺，本轮不扩接口。[docs/CLIENT_CONTRACT.md:5](../CLIENT_CONTRACT.md#L5)、[docs/CLIENT_CONTRACT.md:374](../CLIENT_CONTRACT.md#L374)
2. 主线继承的 A2A edge 完成窗口是否安排后续修复？其读取 Run outcome 的来源已存在，但本轮不扩大实现任务，同时保留“Host 换代不自动恢复执行”的边界。[src/a2a/server.ts:1678](../../src/a2a/server.ts#L1678)
