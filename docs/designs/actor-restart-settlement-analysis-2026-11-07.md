# Actor 重启恢复：终态结算根因与修复方案

日期：2026-11-07。源码基线：`64dab173a`（父提交 `58671f8de`）。

状态：**生产缺口已通过门控及真实进程硬终止复现；本轮完成调查和方案，生产修复尚未实施。** 下文的修复和验收是拟定方案，不是已交付能力。原始全量失败的唯一成因仍不能从现有历史日志确定。

关联：[ISSUE_322 回归记录](../test-guides/ISSUE_322_v0.7.97_REGRESSION_GUIDE.md)、[容量可靠性方案](context-capacity-reliability-plan-2026-11-06.md)。

## 1. 结论与证据边界

此前已证明：`vi.waitFor` 默认 1 秒会把合法的慢提交判为失败。但人工延迟 rename 1.2 秒，只证明这个误报机制存在，不能证明历史全量失败确实发生了同一段慢 I/O。

此次三路独立审查及交叉质疑发现并实测了另一处生产缺口：**独立 Actor 的 Run 会在对应 Actor 终态持久化之前先写入 `completed`。若 Host 在两次提交之间死亡，新 Host 能读到 Run 已完成、Actor Turn 却中断的不一致状态。** 普通 Product Run 已有不提前公布终态的保障，独立 Actor 没有走同一保障。

因此，`64dab173a` 的五秒等待是测试缓解，不能视为此生产缺口的修复；五秒也不是整条生产结算链的合法总时限。不能通过提高生产 deadline、提前更新 Actor 的公开状态或重放已消费 checkpoint 来掩盖问题。

## 2. 四种完成边界

| 边界 | 实际含义 | 可以据此宣布 Actor 持久化完成吗 |
| --- | --- | --- |
| `agents.followup(...resumeCheckpoint)` 返回 | 权限与恢复接纳完成，原 Turn 已异步启动 | 不可以；返回 `running` 合法 |
| 子执行器 Promise 返回 | 本轮执行器成功或失败的事实已产生 | 不可以；Actor 终态可能还在排写或提交 |
| 独立 Run 当前的 `completed` | 当前实现的 environment release 已提交 Run 状态 | 当前存在提前公布窗口，不是 Actor canonical 凭据 |
| Actor canonical terminal | 匹配 Turn 的终态快照已成为持久化事实 | 可以；随后才能公布相应 Run 终态 |

源码路径，以基线行号为准：

- `packages/agent/src/actors/controller.ts:304`：恢复接纳后异步 `launch`，不等待执行结束。
- `packages/coding/src/agent-runtime/actor-runtime.ts:163`：先执行 `environment.release(result)`，再返回执行器结果。
- `src/sdk-runtime.ts:5798`：独立 release 直接 `markRunTerminal` 并 resolve Run result。
- `packages/agent/src/actors/controller.ts:1073`：执行器返回之后，才进入 `completeExecution`。
- `packages/agent/src/actors/controller.ts:1939`：等待 `saveAttempt.canonical` 后才更新 `committedSnapshot`、公布终态事件。
- `src/sdk-runtime.ts:4869`：Actor health 更新会跳过已经 terminal 的 Run。
- `src/sdk-runtime.test.ts:10757`：普通 Run 的现有测试明确要求不能先于 Actor 持久化终态完成。

问题是上层生命周期适配绕过了 canonical 结算屏障；没有证据要求修改 Controller 的提交前可见性。

## 3. 实验：不依赖一秒或五秒阈值的 RED

探针复用真实 SDK、真实 FileSessionStorage、原 Actor Turn 与 fresh authority。只替换离线子执行器，不发送 Provider 请求。

1. 原 Host 把独立 Actor 保存到 generation checkpoint，正常关闭。
2. 新 Host 使用原 principal 和新 credential binding 恢复同一 Turn。
3. 观察真实 `beginActorSnapshotSave`，精确选中该 Session、该 Turn 的 `completed` 快照；返回原始 save attempt，不伪造存储协议。
4. 对其真实 Session rename 设置 Promise gate，停在 canonical 提交之前。
5. 读取公开 Run、Actor output 与 save attempt diagnostics。

实际观察：

| 观察项 | 实际值 |
| --- | --- |
| Run phase | `completed` |
| 精确 Actor Turn output | `running` |
| save phase / stage | `commit_inflight` / `rename` |
| canonical / completion | `ambiguous` / `pending`，尚未执行实际 rename |
| 执行器调用次数 | 2：原执行一次、恢复一次 |

断言“Run 不得在 Actor canonical 前完成”立即 RED；测试主体耗时约 1.15 秒，没有通过睡眠制造一秒阈值越界。`ambiguous` 是 save protocol 对未完成 rename 的阶段描述，此处不表示已证明发生磁盘损坏。

## 4. 实验：真实 Host 硬终止与重新启动

在同一精确 gate 停点写入自建测试进程 marker，核验 Node worker 及其 Vitest parent 属于本探针后，仅强制终止该 worker。没有终止用户应用或其他线程进程，也没有运行正常 Host close，避免关闭流程修补现场。

另一个进程通过同一路径启动新 Host，结果：

- 原 Run 仍为 `completed`。
- Actor 为 `idle`，原 Turn 为 `interrupted`，没有可用 checkpoint。
- 使用原 principal 和 fresh credential 发起 checkpoint 恢复，被拒为 `Actor recovery target changed.`。

这里的拒绝不能单独视为需要放宽的权限或恢复规则：已经重新执行过、但未保存新 checkpoint 的工作不能随意退回旧边界重放。已证实的缺陷是 Run 对尚未持久化的 Actor 完成提前作了承诺。正确修复应让崩溃后的 Run/Actor 中断或 unknown 事实一致，不自动重放未确认效果。

`crash-verify` 一次性探针中“恢复请求不应报错”的断言是探索性问题，不是已接受规格，也不能原样转成永久回归。永久验收应检查“不假完成、明确中断或 unknown、没有安全 checkpoint 时不重放”，不能要求此时恢复必须被允许。

原始输出、探针和 marker 保存在 OS 临时目录 `kodax-actor-root-cause-20261107`：

- `independent-canonical-red.log`：精确 canonical 门控 RED。
- `crash-prepare.log`：崩溃点状态及预期的 worker 强制退出。
- `crash-verify-red.log`：另一进程启动后的状态与恢复拒绝。
- `sdk-runtime.actor-canonical.probe.test.ts`：一次性反馈脚本，不属于已提交回归或已完成修复。

raw 未提交。崩溃准备阶段的 worker-exited error 是故意硬终止的证据，不计为通过测试。

## 5. 已排查与仍未证实的解释

### 旧执行器晚回写

Controller shutdown 先置 `closing`、递增 settlement generation、停止本地工作；旧执行结果在 generation 不符或 closing 时被丢弃。Runtime close 先关闭 Actor registry，再 abort suspended Run，最后才关闭 owner liveness。静态审查和既有回归没有显示这条防线缺失；本次不据猜测改写它。

### 五秒是否足够

不应把五秒当作从 followup 返回起的总预算。Controller 分别处理 dequeue、writer eligibility、canonical deadline；已有确定性测试覆盖合法的长时间前序维护，以及 queued 6 秒后才开始 canonical 计时。增加一个五秒总等待仍可能误报。

### 原始全量失败是否只有此原因

不能确认。历史 JSON 只有 `running != completed`、失败位置和总用例耗时，没有执行器返回、save phase、canonical、health 或后续终态。没有错误日志也不能排除后台异常：`coding:actors` 诊断通过 `emitKodaXDiagnostic` 发出，未注册 sink 且未启用 stderr 时可以不出现在测试日志中。

此次生产缺口与历史失败处于同一恢复结算链，值得修复；不能把它与历史单次失败强行写成唯一因果关系。

## 6. 推荐修复：复用既有结算能力，补齐独立范围

### 生产路径

1. 独立 Actor factory 绑定其真实 `record.actorSession` 和明确的 Actor/Turn 所有权范围。
2. `environment.release` 只捕获执行器成功/失败事实，立即返回，让 Controller 可以提交终态。不得在 release 内等待本次 Actor finalization，否则执行器和 Controller 相互等待。
3. 由 Host 的异步 finalizer 复用既有 RunService finalization / unknown / Run 状态保存失败处理，等匹配 Actor/Turn 的 canonical terminal 后再写 Run 终态、resolve Run result。先确认目标 Turn 已提交的终态，再处理尚未提交时的 health；不能直接等待整个 Session 的所有 Actor，也不能照搬“先等全局 health 再看全部 active turns”的顺序，否则无关 Actor 会拖住已经提交的目标事实。
4. 正常 finalization 和普通 Stop 按本独立 Actor 的执行所有权范围处理，保留同 Session 的无关独立 Actor；既有 managed cancellation 默认保留所有 independent turns，必须针对本独立范围适配，不能原样套用。存储或 owner unknown 仍执行既有 Session 级安全 fence/repair：同 Session 共用 owner、snapshot 和写队列，不能承诺无关 Actor 的未完成执行不受影响，也不能为了隔离它们而绕过安全 fence；已提交事实仍须保留。
5. Actor unknown / 提交失败时进入现有不确定结算路径，不能公布 `completed`。Run 状态自身保存失败走既有 `finishRunSettlementFailure`，不能吞错或无跟踪地 fire-and-forget。
6. 保留 `generationSuspended` 的安全 checkpoint 关闭短路。未保存新 checkpoint 就再次崩溃，应明确中断或 unknown，不能恢复成虚假的完成，也不能自动重放旧边界。

不推荐在 release 中 `await`、仅 `setImmediate(markRunTerminal)`、新加全局重试层、提高生产 deadline，或为此新增通用状态机。

finalizer 的 Promise 必须被跟踪。不能放进 `record.preparation`：Host close 在关闭 Actor registry 前等待 preparation，会再次形成自等待。关闭顺序应先 fence/关闭 Actor registry，再收敛独立 finalizer，保持现有 owner liveness 释放约束。

finalizer 使用预先绑定的 `record.actorSession` / root，不能在关闭期间再通过需要 open registry 的公开 SDK 或 `registry.forSession` 查找。跨 await 之后以现有 Run owner/revision 和 Actor/Turn identity 再核验，防止旧 finalizer 在新一轮接管后晚写。

Actor registry close 失败或进入 unknown 时，也必须以既有有界结算机制收敛 finalizer并保留错误，不能在已关闭 controller 上无限等待新 health/event；owner liveness 按现有未确认资源规则处理，不能通过假完成或强制释放所有权消除等待。

Stop 的赢家应以原执行器事实及匹配的 canonical Turn 判定，不能在晚时点只看 `signal.aborted`，否则自然完成提交期间到达的 Stop 会错误覆盖完成事实。

### 测试同步与诊断

以精确 Turn 的 `agents.output` 为完成真值；`completed` 成功，`failed` / `interrupted` 立即失败。`agents.wait(cursor, 100–250ms, {signal})` 只作为唤醒提示，返回无事件也重新读取 output；使用外层测试硬期限及 TestContext signal，不再增加独立的一秒或五秒完成期限。

不能纯等终态事件：已被父级 ack 的 direct-child terminal 会被过滤，存在 output 读取与 wait 注册之间的漏唤醒窗口。取消 signal 也不能被描述成取消所有 SDK I/O，因为 `agents.output` 本身没有 signal 参数。

用 Promise gates 检查提交前后，不用固定 1.2 秒睡眠作为主要证明。失败时保留有界 diagnostic sink、最后 output/events、Run lifecycleError 和真实 save attempt diagnostics；失败钩子不能为了取诊断再发起可能无限等待的 SDK I/O。所有 gates 在 finally 先释放，再关闭 Host。

## 7. 实施验收门

| 验收 | 必须观察到的行为 |
| --- | --- |
| 精确提交门控 | Actor canonical 前 Run 没有 terminal；释放后同 Turn 的 Actor/Run 终态一致 |
| 成功与失败 | 成功、执行错误、iteration limit 均等待正确的 Actor 事实，不把失败等成超时 |
| unknown 与晚确认 | 提交未知不报完成；既有 fencing/repair 与晚确认不双结算、不丢错误 |
| 正常范围隔离 | 同 Session 另一个独立 Actor 的执行器被阻塞、但未占用共同 canonical/写锁时，不妨碍本 Actor 正确结算，也不被本 Run 的普通 Stop 误取消 |
| 共享存储边界 | 共同提交或写锁被阻塞可合法阻挡多个 Actor；owner/store unknown 仍触发 Session 级安全 fence，不以范围隔离断言要求继续执行 |
| 已提交事实优先 | A 已 canonical 后 B 进入 recovering/unknown，不撤销 A 已确认的终态；A 自身尚未 canonical 且 unknown 时不报完成 |
| Stop 两种赢家 | 自然完成先 canonical 与 Stop 先取消都保留真实赢家 |
| 正常关闭 | checkpoint suspension、提交前关闭、提交后维护未完成均不自等待、不提前释放 owner |
| 异常关闭与接管 | registry close 失败保留错误且有界收敛；旧 finalizer 不跨 owner/revision 写入新 Host 状态 |
| 硬崩溃 | gate 点强制终止后重新启动，Run 不再假完成；无新 checkpoint 时明确中断/unknown，不重放旧工具 |
| 组合检查 | Actor/controller/generation/小窗口回归、类型检查、相关构建及最终全量，分别记录失败与跳过 |

先将第 3 节门控转成永久失败回归，再改生产路径；每个新增边界先 RED 后 GREEN。修复完成前不把上述验收写成通过。

## 8. work mode 与整合边界

原工作区首轮 work mode 锁定改动集中在 SDK 接口、fork/settings、Run admission 和锁持久化及 helper。当前候选修改点是独立 factory 和 Actor finalization helpers；只读 diff 核对未发现当前文本重叠，也不需要改变模式选择或锁定规则。

本轮没有修改任何生产文件或原工作区。如果实际补丁触及 mode/admission 共享 hunk 或发现语义冲突，应停止该部分处理并保留另一线程的机制。不能仅因 SDK 文件名相同断言已经冲突，也不能据这次静态无重叠保证未来整合不会冲突。

## 9. 交叉复核

恢复时序、持久化/队列和证据反证三路审查分别进行，并互相质疑。证据轴确认门控和硬崩溃结果没有被扩大为历史唯一根因；持久化轴纠正了“无关 Actor 不受影响”的过宽承诺，明确保留共享存储 unknown 的 Session 级 fence。上述修订已纳入本方案；这不等于实现或验收已完成。
