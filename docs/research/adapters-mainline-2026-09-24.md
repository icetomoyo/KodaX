# 最新主线合并后，SDK、ACP、A2A、Memory 与 Learning 还有哪些能力缺口？

结论：主线新增的 memory shutdown、terminal maintenance 与 pre-abort 语义沿现有 Host 执行路径进入产品接口，没有发现需要另开公共执行通道的缺口。旧 Learning 轮询已经在当前分支改为推送，但仍有可复现的订阅结束/错误传播缺口；A2A 离线完成结果的恢复遗漏仍在。ACP 专用 trace 与浏览器 transport 属于既有明确边界，不能称为本次合并回归。

审计基线：合并前 `88e11abddac252805395493c81560a87aa143480`，本次主线 `c447c0f3`（v0.7.96-rc.11）；2026-09-24 正在合并的工作树。只读源码、现有测试和 Git 历史；未运行真实模型、完整测试套件或修改生产代码。下列行号对应本次审计时工作树，后续冲突解决可能移动行号。

## 新主线能力的承接

- **Memory 与 maintenance 仍由 Host 统一持有。** Runtime 注册 `runMemoryWork`、`scheduleManagedTaskMaintenance`，向实际 coding 执行 events 注入；`closeRuntime` 先中止 memory review，再等待两类已持有的工作完成，最后关闭 actor、integrations、view 和 persistence。Product `host.shutdown` 继续调用 daemon shutdown；daemon server 路由最终走 Host 的 `runtime.close`。这是内部生命周期增强，不要求 REPL、ACP 或 UI 自己收集后台任务。[src/sdk-runtime.ts:4780](../../src/sdk-runtime.ts#L4780)、[src/sdk-runtime.ts:5230](../../src/sdk-runtime.ts#L5230)、[src/sdk-runtime.ts:10518](../../src/sdk-runtime.ts#L10518)、[src/client-runtime-adapter.ts:20](../../src/client-runtime-adapter.ts#L20)、[src/runtime-daemon/server.ts:1008](../../src/runtime-daemon/server.ts#L1008)、[src/runtime-daemon/host.ts:222](../../src/runtime-daemon/host.ts#L222)；主线提交 `18762851`、`7c92d2aa`。
- **Run 完成不等于后台 maintenance 已全部完成，是本次主线刻意保留的语义。** 新测试明确要求 Run 与其后续 Run 不被 maintenance 阻塞，关闭 Runtime 时才等待维护；已有 Product shutdown 测试也区分“受理关闭”与 executor helper 完成清理。因此不能让 UI 在收到 Run completed 后自行杀 Host，也不应把 shutdown 的 accepted 改解为进程已退出。[src/sdk-runtime.maintenance.test.ts:77](../../src/sdk-runtime.maintenance.test.ts#L77)、[src/sdk-runtime.memory-review.test.ts:172](../../src/sdk-runtime.memory-review.test.ts#L172)、[src/sdk-client.lifecycle.test.ts:133](../../src/sdk-client.lifecycle.test.ts#L133)。本轮仅阅读测试，未声称这些测试已执行。
- **pre-abort 通过既有终态抵达消费者。** 主线入口现在执行 interrupt terminal、complete、turn completed 后返回 interrupted 结果，避免原始 AbortError 直接逃逸；ACP Product 路径已经通过 `runs.await` 将 cancelled/interrupted 映射为 cancelled。公共契约不需要新终态。[packages/coding/src/agent-runtime/run-substrate.ts:958](../../packages/coding/src/agent-runtime/run-substrate.ts#L958)、[src/acp_server.ts:1064](../../src/acp_server.ts#L1064)、[src/client-runtime-adapter.ts:146](../../src/client-runtime-adapter.ts#L146)；主线提交 `bd01e0f4`。
- **本次合并没有改写 Product contract 或协议接入实现。** `git diff HEAD --` 对 `packages/coding/src/client-contract.ts`、`src/client-runtime-adapter.ts`、`src/runtime-daemon/client.ts`、`src/acp_server.ts`、`src/a2a/server.ts` 均无差异。macOS Git 的调整属于 Host/本地 Git 调用实现，不能仅因没有新 RPC 就认定能力缺失。主线提交 `54ac092a`。

## 已确定的剩余缺口

### P2：Learning 推送的结束与失败传播还不完整

旧报告的“daemon 每 100ms 轮询”已经不适用于当前分支：`learning.subscribe` 调用 `learningEventPushIterable`，server 通过通知通道驱动实际 iterator。Product adapter 直接复用该实现；当前主线 `c447c0f3` 仍含 `pollRuntimeLearningEvents`，说明推送是本分支已有增强，合并应保留。[src/runtime-daemon/client.ts:1080](../../src/runtime-daemon/client.ts#L1080)、[src/runtime-daemon/client.ts:1402](../../src/runtime-daemon/client.ts#L1402)、[src/runtime-daemon/server.ts:2202](../../src/runtime-daemon/server.ts#L2202)、[src/client-runtime-adapter.ts:94](../../src/client-runtime-adapter.ts#L94)；分支历史 `7a8fc22a`、`ae8c9ee1`。

但当前手写 iterator 有两个可复现问题：

1. `return()` 会立即关闭 subscription，却不调用保存的 `wake`，所以先前空闲中的 `next()` 一直不结算。REPL binding 的消费协程停在此处；它的 active=false 可以阻止将来调用 listener，却不能让 await 退出。与旧报告不同，**当前不会继续发轮询 RPC**，不能沿用旧资源泄漏描述。[src/runtime-daemon/client.ts:1433](../../src/runtime-daemon/client.ts#L1433)、[src/runtime-daemon/client.ts:1443](../../src/runtime-daemon/client.ts#L1443)、[src/repl-learning-binding.ts:11](../../src/repl-learning-binding.ts#L11)、[src/repl-learning-binding.ts:39](../../src/repl-learning-binding.ts#L39)。
2. `subscription.ready` 如果在调用者第一次 `next()` 前 reject，catch 只调用当时可能尚不存在的 failure，既不保存错误也不标记终结，随后 `next()` 永久等待。显式保留 iterator、稍后开始消费的 SDK 用户可遇到静默失效。[src/runtime-daemon/client.ts:1425](../../src/runtime-daemon/client.ts#L1425)、[src/runtime-daemon/client.ts:1433](../../src/runtime-daemon/client.ts#L1433)。

本轮无模型函数级复现：直接提取工作树 `learningEventPushIterable` 源码，用项目 TypeScript 转译，注入可计数订阅 stub。结果：`returnDone=true, subscriptionClosed=1, nextSettled=false`；握手先失败、下一 tick 再 next，结果 `lateNext=pending`。这是原函数控制流复现，不是完整 IPC 端到端测试。底层进程内 Learning iterator 的 return 已会唤醒 waiter，说明这两个问题位于 daemon Client 包装层。[packages/agent/src/learning/learning-center-service.ts:479](../../packages/agent/src/learning/learning-center-service.ts#L479)。建议先补 pending-next/late-next 的结束和失败测试，再决定统一恢复策略。

### P2：A2A edge 离线期间完成的 Run 恢复时遗漏最终文本结果

`recover()` 对 live Run 调用 `runs.await` 后 finish；对已经 terminal 的同 Runtime Run 仅拼 `{runId, sessionId, phase}` 传给 `finishRun`。后者由 `result.result?.lastText` 构造最终消息和文本 artifact，故离线完成的最终文本不会从结果恢复。终态失败的 error 也未从结果中取回。这里限定 **A2A edge 重启、同一 Runtime 仍存活、Run 在恢复之前已完成**；Runtime identity 改变时按 interrupted 处理是另一条设计路径。[src/a2a/server.ts:1688](../../src/a2a/server.ts#L1688)、[src/a2a/server.ts:1702](../../src/a2a/server.ts#L1702)、[src/a2a/server.ts:1707](../../src/a2a/server.ts#L1707)、[src/a2a/server.ts:1385](../../src/a2a/server.ts#L1385)。

现有 surviving-Run 测试是在第二个 edge 已 listen 之后才 complete，覆盖 live reattach，未覆盖上述 terminal-at-recovery 分支。本次没有新增或运行 A2A 复现，不将“最终文本遗漏”扩展声称为所有文件 artifact 丢失；文件返回有自己基于 record/tool events 的路径。[src/a2a/a2a.test.ts:2387](../../src/a2a/a2a.test.ts#L2387)、[src/a2a/server.ts:1403](../../src/a2a/server.ts#L1403)。

## 设计边界与迁移范围

- **ACP 专用 repo-intelligence trace sink 仍未由 Product view 回填。** 设置本身已在 prompt 前送至 Host；现有 onRepoIntelligenceTrace 回调仅位于旧 execution-options 路径。Product 投影只处理 tool、assistant、thinking 和交互，未重放该专用事件。这是诊断可见性边界，不能据此说 Host 没有启用 repo-intelligence。[src/acp_server.ts:1043](../../src/acp_server.ts#L1043)、[src/acp_server.ts:1236](../../src/acp_server.ts#L1236)、[src/acp-client-view.ts:52](../../src/acp-client-view.ts#L52)。
- **ACP question/form 并未缺少 Host 能力，而是协议消费者无回答通道。** Product 投影会提示到其他 KodaX Client 回答；permission 有专用桥接。当前源码明确说明该边界，不能通过恢复客户端执行权解决。[src/acp-client-view.ts:96](../../src/acp-client-view.ts#L96)、[src/acp_server.ts:1260](../../src/acp_server.ts#L1260)。
- **A2A 服务端仍消费内部 Runtime，不是纯 Product Client。** server options 与执行准备使用 Runtime execution binding；这没有在客户端另造执行权，但“所有协议适配器只依赖 ProductClient”并非当前代码事实。若目标是将 A2A edge 单独部署为仅持公共 Client 的进程，需要另外定义执行绑定/工作区准备的产品边界；不能简单替换类型。[src/a2a/types.ts:279](../../src/a2a/types.ts#L279)、[src/a2a/product.ts:80](../../src/a2a/product.ts#L80)、[src/a2a/server.ts:1740](../../src/a2a/server.ts#L1740)。
- **浏览器 transport 仍未实现。** Product SDK 连接选项是本机 socket/named pipe；纯类型可给浏览器使用，但不存在 HTTP/WebSocket Client 实现。契约文档已明确该限制。[src/sdk-client.ts:10](../../src/sdk-client.ts#L10)、[docs/CLIENT_CONTRACT.md:31](../CLIENT_CONTRACT.md#L31)。
- **普通 Client disconnect 不应替代 Host shutdown。** ACP dispose 释放自己连接，Product disconnect 转发所连接 Runtime facade 的 close；显式 host.shutdown 是另一个入口。新 shutdown-owned memory 不要求每个 UI 离开就关闭全体共享 Host。[src/acp_server.ts:781](../../src/acp_server.ts#L781)、[src/client-runtime-adapter.ts:20](../../src/client-runtime-adapter.ts#L20)、[src/client-runtime-adapter.ts:294](../../src/client-runtime-adapter.ts#L294)。

## 未证实与未解问题

- **Learning / workflow 断线恢复的产品承诺需明确。** 它们共用 `subscribeToDaemonNotification`，只有握手和关闭逻辑，没有 Session observe 使用的 lifecycle 重订阅；server 会在连接关闭时清理 subscription。源码支持“需要重建订阅”的判断，但本轮未做实际重连复现。workflow 文档已要求重连后读取快照；Learning 应明确是否同样由消费方重建，或由 transport 恢复并按 revision 补齐。[src/runtime-daemon/client.ts:2251](../../src/runtime-daemon/client.ts#L2251)、[src/runtime-daemon/server.ts:831](../../src/runtime-daemon/server.ts#L831)、[docs/CLIENT_CONTRACT.md:84](../CLIENT_CONTRACT.md#L84)。
- 本次新 memory/maintenance 的源码单元测试充分区分 Runtime 与 Run 生命周期，但本轮未证明“Product Client → IPC shutdown → 具体 memory 持久化完成”完整链路。建议把它作为最终合并验证项，而不是事先判定出现能力缺失。[src/sdk-runtime.memory-review.test.ts:172](../../src/sdk-runtime.memory-review.test.ts#L172)、[src/sdk-client.lifecycle.test.ts:133](../../src/sdk-client.lifecycle.test.ts#L133)。
- 优先顺序建议：Learning 生命周期完成语义 → A2A terminal-at-recovery 结果补取 → 明确跨重连订阅责任；ACP 诊断 sink 与浏览器 transport 按产品范围排期，勿为本次合并引入泛化事件总线。
