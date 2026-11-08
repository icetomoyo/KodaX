# Actor 重启恢复：终态结算根因与修复方案

日期：2026-11-07。源码基线：`64dab173a`（父提交 `58671f8de`）。

状态：**分阶段实施中。P0-A 的持久关联与恢复对账已实现并通过专项验收；实时 Run 提前结算仍待 P0-B，整体尚未完成或发布。** 已执行证据见第 11 节；不能将方案中的其余验收计为通过。原始全量失败的唯一成因仍不能从现有历史日志确定。

方案修订：2026-11-07 根据第二轮 Claude 建议及独立交叉核对，优先采用内部终态事件驱动，补充反向崩溃窗口、持久绑定与两处恢复对账，并拆分 P0/P1。此前异步 Host finalizer 为被替代的候选，不与事件路线同时实施。

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

## 6. 修订方案：内部终态事件驱动，加持久化对账

本版优先采纳 Claude 的更小实现路线：**内部 committed-event hook + 一个幂等的 canonical Turn → Run 投影入口**。不新建另一套 Host 等待 finalizer、轮询循环或生产 deadline。原 Host 异步 finalizer 降为备选，只有事件路径出现已证实且无法复用现有机制覆盖的缺口时才重新评估，不同时实现两套结算机制。

### 6.1 实时结算

1. Registry 构造时安装 Controller 的内部 `onEventCommitted` hook，经 CodingActorSession 的最小 optional callback 透传。它是已有的构造期单 sink，并非现成的 per-Turn subscribe API；不为此扩展公开 SDK。内部 hook 不经过 `agents.events/wait` 的 ack 过滤。
2. 独立 factory 在 worker dispatch 前，与首份 Run 状态原子写入内部精确关联：Session、actorPath、turnId；使用已有 `turn.createdAt` 等事实核验绑定，不增加新 ID 体系。可放 `_runtime` envelope，不必污染公开 RunStatus。所有后续状态写必须保留该关联；绑定未提交就不能 dispatch。恢复 Run 也必须遵守同一规则，无需改 work mode admission。
3. Host 在执行前建立精确关联的路由；`environment.release` 只捕获执行器事实，立即返回，让 Controller 可以进入终态提交。不能在 release 内等自身终态。
4. 内部终态 hook 使用预绑定 Session/root，同步读取该事件对应的 canonical 历史 Turn，调用共享投影入口提交 Run 终态并收敛 Run result。当前 Run 持久化是同步路径，因此正常成功/失败路径不需要额外可跟踪的异步 finalizer。重复、过期、不同 actorPath/turnId 或不同 owner/revision 的事件不能覆盖当前 Run；路由在结算或所有权结束时清理。
5. canonical Turn 是执行结果真值，不再使用晚时点 `signal.aborted` 覆盖已提交的完成事实。但 event 本身不含完整 error / terminationReason / failureDetail，必须读取对应 Turn。Actor `interrupted` 也不机械等于 Run `cancelled`：仍须结合持久化 Stop、关闭/重启原因和现有终态策略。Run 的 blocking Shell cleanup 未确认时保持 unknown，不能因 Actor completed 绕过它。

### 6.2 事件之外的必要出口

- **unknown 没有终态事件也必须收敛。** 继续接入已有 health / settlement persistence error 路径，不假完成、不让 Run result 永久悬空。owner/store unknown 保留 Session 级 fence/repair；普通 Stop 和正常结算才按独立 Actor 执行范围处理。
- **checkpoint 正常关闭仍有短路。** 保留 `generationSuspended` 的现有 resolve 行为；安全悬停不一定产生终态事件，不能把 Host close 变成等待永远不会到来的 terminal event。
- **callback / Run 写入失败不能只交给日志。** Controller 的 `onEventCommitted` 调用是 fire-and-forget，抛错只进入后台诊断；`markRunTerminal` 又会先改内存 phase，再可能在保存时抛错。Host hook 必须显式接入既有结算保存失败/unknown 处理。若写入或通知的确认失败，应核对权威 Run 记录：已提交的终态不倒写为 unknown，只有未确认的提交才保持不确定。不能相信预先修改过的内存 phase。
- **关闭与迟到回调仍需 owner 约束。** 使用预绑定 root，不在关闭期间再走公开 SDK/已关闭 registry 查找；保存时核验 Run owner/revision、精确 Turn。关闭后的旧 hook 不能晚写新 Host 状态。保留 owner liveness 和错误传播，不通过强制假完成释放资源。

内部事件解决实时顺序，不构成跨两份持久化记录的原子事务。因此必须同时实施下面的对账，不能把“预先订阅”当成崩溃恢复保证。

### 6.3 反向崩溃窗口与恢复对账

调整顺序后，存在第二个必须覆盖的停点：**Actor terminal 已 canonical，Run terminal 尚未提交时 Host 死亡**。

基线代码审查确认缺少这种对账：

- `sdk-runtime.ts:5030–5056` 启动恢复会将 dead-owner 非终态 Run 送入 `interruptPersistedNonTerminalRun`。
- `:19247` 的该函数不读取 Actor snapshot，直接生成 interrupted。
- `:9978–10024` 的 `observePersistedRun` 在之后发现旧 owner 死亡时，也使用同一路径；因此不只启动要修。
- 两条路径目前都会先保留 `recovering + checkpoint`。对已 canonical terminal 的精确 Turn，应先对账，再决定是否仍可恢复。
- 内存 `independentActorRef` 不在 RunStatus / `statusFromRecord` / `recordFromPersistedStatus` 中持久化；checkpoint 专用的 generation-recovery.actor 不能覆盖普通独立 Run。所以精确持久关联是本修复的必要前置，不能猜最新 Actor 或反解析 turnId。

这确认了修复方案必须包含反向窗口；本轮尚未对该新顺序的第二停点执行硬崩溃实验，不将静态确认写成实验通过。

共用的对账/投影规则：

1. 对有可靠持久关联、仍非 terminal 的独立 Run 使用投影。入口权限分开：实时 hook 核验本 Host 仍持有匹配的 Run owner/revision/binding；启动和后续 owner-death 对账才要求旧 owner 已 dead，alive/unknown 不能抢写。可共享结果构造和受约束提交，不能把“owner 必须 dead”当作实时 hook 的前置条件。
2. 用已有 `readActorSnapshot/readActorMetadata` 读取稳定 canonical 投影，定位精确历史 Turn；不要先初始化 Controller，让 `recoverUnmatchedTurns` 改变现场，也不要读取 actor.currentTurnId 来猜目标。
3. 若精确 Turn 已 terminal，只修复 Run 状态，不进入任何执行、LLM、工具或 checkpoint 恢复入口。该检查先于“保留 recovering/checkpoint”以及首次写 interrupted。
4. 在 Run 状态锁内按 observed owner + expected revision + durable binding 做 CAS；竞争变化则重新读取权威事实并重新投影或明确退出所有权，不能覆盖接管者。若本地仍有待完成的 Run result，也要以权威终态或明确 unknown 收敛，不能静默退出使结果永久悬空。现有 `saveRunStatus` 对 terminal 写入没有完整 foreign-owner guard，不能无条件拿来写新对账结果；应使用既有锁内的受约束提交入口。
5. actor canonical terminal 只决定执行事实；Stop 结果、failure detail、Shell cleanup 等仍走同一既有 Run 终态策略。缺失/损坏/身份不符时保守 unknown/interrupted 并记录诊断，不猜 completed，更不重执行。canonical Turn 未必保留完整 Runtime failureDetail；只恢复可证实的 state/error/terminationReason 和已持久化上下文，不补造 typed failure details。缺少错误细节可以使用既有安全通用诊断，不因细节缺失抹掉已经证实的 failed 终态。
6. 投影入口供实时 hook、启动恢复、后续 owner-death observation 三处复用，保证重复调用幂等，不重复执行或重复结算。Run 提交后的通知失败也不能反转已确认的完成。
7. 历史 terminal 仍遵守不可随意覆写原则。旧记录没有精确关联时，不自动“修正”所有 completed/interrupted；已知历史不一致应单独诊断，必要的迁移另行设计。

这条设计收敛的是两种崩溃方向，不是引入跨存储事务系统或通用后台对账服务。

### 6.4 测试同步与诊断

P0 事件路线闭合时，真正撤掉 `64dab173a` 中五处固定五秒完成等待。以精确 Turn 的 `agents.output` 为真值；completed 成功，failed/interrupted 立即失败。`agents.wait(cursor, 100–250ms, {signal})` 仅作唤醒提示，无事件也重新读取；只使用外层测试预算和 TestContext signal。

这与生产内部 hook 不矛盾：公开事件会过滤已 ack 的 direct-child terminal，测试不能纯等公开事件。`agents.output` 没有 signal 参数，不能声称 signal 能取消所有 SDK I/O。

回归注册有界 `coding:actors` diagnostic sink；失败时保存最后 output/events、Run lifecycleError、执行器调用次数和真实 save attempt 的 stage/phase/canonical/completion diagnostics。取证不能在 failure hook 再发起可能无限等待的 SDK I/O。用精确 terminal snapshot 的 Promise gate 检查提交前后，所有 gates 在 finally 先释放再 close；不以固定 1.2 秒睡眠作为主要证明。

## 7. 分阶段交付与放行条件

采用 P0/P1 分批，但分批是缩小提交和评审范围，不把新路线的基础错误收敛推迟到下一批。以下是目标验收要求，实际执行状态单独记录在第 11 节。

### P0：闭合最小一致性修复

按垂直切片执行，不一次堆完：

| 切片 | 内容 | 放行条件 |
| --- | --- | --- |
| P0-A 持久关联与恢复对账 | 首次 dispatch 前原子写入关联；共享 canonical 投影及 owner/revision CAS；启动和后续 owner-death observation 两个入口 | 精确历史 Turn、幂等、legacy 缺关联、损坏/缺失、foreign owner、并发 revision 变化；不执行模型/工具 |
| P0-B 实时事件驱动 | 内部 hook 透传和精确路由；release 捕获事实；canonical 后结算 Run | 原门控 RED→GREEN，正常完成、执行错误/iteration limit；无关 Actor 执行器挂起时本 Actor 不被错误拖住 |
| P0-C 基础异常与测试收口 | basic unknown、callback/Run-store 失败、checkpoint graceful close；撤销五秒等待、接入有界诊断 | 不假完成、不悬空、不死锁；既有 Stop/close 回归不退化；不绕过 Shell cleanup 和 Session 安全 fence |

P0 必须包含两个真实进程硬崩溃停点：

1. **Actor terminal canonical 之前。** 新 Host 不读到虚假的 Run completed；没有新安全 checkpoint 时明确中断/unknown，不重放旧工具。
2. **Actor terminal canonical 之后、Run terminal 提交之前。** 新 Host 或后续 dead-owner 观察按精确 terminal Turn 补写 Run；不把 completed Turn 当 interrupted，也不再次启动该 Turn。

还需覆盖重复终态事件、重复对账、Run 已提交但通知失败以及失败后的权威读回。测试子进程的强制退出须作为受控夹具处理，不把预期崩溃误算成普通通过测试。

P0-A 应先于 P0-B 的实时顺序切换落地，避免交付“新顺序已经产生反向窗口、对账却尚未具备”的中间版本。A/B/C 可以分别提交评审，但中间切片不能单独宣称完整修复。P0 通过上述基础门后可以作为独立修复候选评审；不得据此宣布 P1 的组合压力已验证。

### P1：扩大竞争与故障组合验证

| 验收 | 必须观察到的行为 |
| --- | --- |
| Stop 两种赢家 | 自然完成先 canonical、Stop 先取消均保留真实赢家；不只按晚时点 signal 判断 |
| unknown 与晚确认 | 无终态事件时有明确不确定出口；晚确认不双结算、不丢错误 |
| 正常范围隔离 | 无关独立 Actor 的执行器挂起但未占共同写锁时，不错误等待/取消它 |
| 共享存储边界 | 共同提交/写锁可合法阻挡多个 Actor；owner/store unknown 保留 Session 级安全 fence |
| 已提交事实优先 | A 已 canonical 后 B recovering/unknown，不撤销 A 的终态；A 自身未 canonical 且 unknown 不报完成 |
| 关闭与接管 | registry close 失败有界收敛并保留错误；旧 hook/旧 owner 不跨 revision 写入新 Host 状态 |
| 组合检查 | Actor/controller/generation/小窗口、源码/测试 typecheck、相关构建及最终全量；失败、跳过、未运行分别记录 |

P0 合入不自动等于发布。发布候选按实际承诺范围和必需回归放行；容量修复与此 Actor 切片独立管理，不与 next-dev 整体合并捆绑。work mode 锁定不属于本修复范围。

## 8. work mode 与整合边界

原工作区首轮 work mode 锁定改动集中在 SDK 接口、fork/settings、Run admission 和锁持久化及 helper。修订后的候选修改点为独立 factory、CodingActorSession/Registry 的内部 hook 透传，以及 Runtime 的内部持久化、启动和观察对账；不需要改变模式选择或锁定规则。此前只读 diff 核对未发现相关文本重叠，实际补丁前仍须按最终修改位置重新核对。

调查阶段未修改生产文件；随后隔离分支的实施改动见第 11 节，原工作区没有写回或覆盖。若实际补丁触及 mode/admission 共享 hunk 或发现语义冲突，应停止该部分处理并保留另一线程的机制。不能仅因 SDK 文件名相同断言已经冲突，也不能据这次静态无重叠保证未来整合不会冲突。

## 9. 交叉复核

恢复时序、持久化/队列和证据反证三路审查分别进行，并互相质疑。证据轴确认门控和硬崩溃结果没有被扩大为历史唯一根因；持久化轴纠正了“无关 Actor 不受影响”的过宽承诺，明确保留共享存储 unknown 的 Session 级 fence。上述修订已纳入本方案；这不等于实现或验收已完成。

## 10. Claude 建议复核与关闭清理实测

外部 review 基于读代码及 `64dab173a`，未运行测试。其提出的有界失败诊断、精确选择 terminal snapshot、关闭后检查锁及避免容量修复与单项 flaky 测试绑在一起，均有价值。五秒无充分总时限依据的意见与本报告第 5–6 节一致；不建议简单再换成孤立的十五秒完成期限。

### 关闭后的锁与旧执行器

使用原恢复 fixture 的备份构造四次 depth=0 离线重复，在旧 Host 关闭期间记录容量等待的退出方式，关闭返回后立即扫描 Session 锁及队列，再重复成功关闭并启动新 Host。结果为 4/4 通过：

- `first.close()` 用时为 39、36、34、31ms；这些是本次观测，不是延迟承诺。
- 容量等待均在关闭开始后 reject `AbortError`，其后的显式 `throw new Error('Old executor must remain suspended')` 均未执行。源码中的该 throw 是等待正常返回后的保护，不代表正常关闭前先抛出了这条错误。
- 关闭后活动 `.lock` 文件为零；三个 `.lock.queue` 目录仍存在，但内部均为空，没有 choosing/ticket 文件。空队列目录本身不是未释放锁，不能据其存在判定泄漏或直接删除它来“修复”。
- 并发 `close()` 复用同一 Promise，随后再次 `await close()` 成功，扫描结果不变；原恢复及最终调用次数断言继续通过。

这组小样本未复现旧 Host 遗留活动锁，但不能据此证明所有压力或故障场景都不存在锁问题。raw 和一次性探针位于 OS 临时目录 `kodax-claude-feedback-20261107`，未提交探针，也未修改生产关闭逻辑。

### 诊断表需要的条件

| 观察 | 可以说明什么 | 还需要什么证据 |
| --- | --- | --- |
| `recovering` 且保存阶段未结束 | 存在待提交或重试状态 | 真实存储错误、重试次数、阶段进展和时限；不能直接判为“仅慢、非生产问题” |
| `healthy` 且 output 为 `running` | 当前健康与 Turn 执行状态 | 执行器是否已返回、精确 Turn 的 canonical 是否成功、revision/identity；正常执行中可以同时 healthy + running |
| fileLock/storageQueue 等待较久 | 存在等待或排队 | owner PID/liveness、ticket、当前 Host 与旧 Host 时间线；不能仅凭时间长认定旧 Host 竞争 |

`1/19,635` 是一次全仓执行中的失败数除以全部测试数，不是此 Actor 场景的重复观测频率，不能用来估算其自然失败率。针对性压力采样可以保留原一秒观察点并继续有界观测、捕获诊断，但不应等待低概率历史现象重现后，才修复第 3–4 节已经确定复现的生产结算缺口。

已验证的容量修复有独立提交和验收，应与本 Actor 缺口分开管理。尚未发布、next-dev 尚未整体合并的状态不变；本轮也没有执行发布或分支合并。

## 11. 分阶段实施记录

### P0-A：持久关联及恢复对账

本切片以 `77bafbee0` 为固定点实施。首次独立 worker dispatch 前，Run 原子 envelope 保存 `_runtime.actor` 的精确 path、Turn ID 和 createdAt；Session 身份来自同一 status。正常更新、恢复接管、Stop 和 Shell cleanup 元数据写入均保留该关联。公开 RunStatus 不增加字段。

启动和后续 dead-owner observation 在保留 checkpoint 或写 interrupted 前，读取精确 canonical 历史 Turn；仅在 owner/revision/Session/binding 仍匹配时提交终态。legacy 不猜测完成，身份不符或读取失败保持不确定，blocking cleanup 不允许 completed。已有失败详情保留，没有详情则不从 Actor 纯文本推断 Provider 类型；已完成事实不残留晚 Stop 的 cancelled failureKind。

RED 证据：对未修改基线实际运行的启动与 dispatch 两项均失败，分别返回 interrupted 和缺失绑定；评审补充的“无可信详情却新增 provider/transport 分类”及“completed terminal 残留 cancelled”也分别先 RED，再最小修复为 GREEN。raw 在 OS 临时目录 `kodax-actor-p0a-20261107`。

验证：

- 最终专项 5 文件 / 54 项通过，其中新增 13 项覆盖 startup、后续 owner-death、pre-dispatch、真实 owner/revision 竞争、可信失败详情、legacy、错误身份、checkpoint 优先级、清理和读取失败。
- 本阶段较早实现的 SDK 主回归 342 项通过；之后两处 failure-detail 修正由新增专项 RED→GREEN 覆盖。最终全仓仍在 P0 收口时运行，不将这次主回归等同于最终完整快照的全仓验收。
- 源码/测试 `npm run typecheck` 和 `git diff --check` 通过。
- 中途 bundle 预检失败：CLI 5,193,648 bytes，超过 5,192,704 bytes 的现有 5071KiB 门槛 944 bytes。尚未改门槛；完整 Actor 切片完成后做净增量和依赖审计，再验证最终构建。此中间切片不作为发行产物。

#### Standards

独立评审剩余 0 项。原 P3 的测试等待/读取重复已通过两个文件内小 helper 去除，无新增框架。

#### Spec

独立评审剩余 0 项。两项 P1 的失败详情问题均补了有效 RED 并修复；abort-control 的 dead-owner checkpoint 直达分支留在 P0-C 控制收口，不算本阶段已验收。

以上是 P0-A 提交时的阶段状态；后续实施如下。容量修复和 next-dev 整体合并未混入 Actor 切片。

### P0-B：canonical 事件结算及必要异常出口

冻结生产源码 SDK blob `adf5fded8ca0141d1aceac2ebc69effe54ea4dce`。CodingActorSession 透传构造期 committed hook；Registry 按 Session、actorPath 和 Turn ID 路由，读取对应 canonical 历史 Turn，经 P0-A 同一投影及 CAS 结算 Run。release 仅捕获执行事实，保留 generationSuspended 短路，没有新增 Host finalizer 或生产轮询期限。

独立运行接入现有异常和资源清理时，回归额外定位并修复了以下真实缺口：

- 临时 Session 的独立 Actor 结算误触发 Session 删除；独立结算现不负责 Session 生命周期和主 Run 队列推进。
- unknown 通知失败阻断结果收敛，且缺少 baseline 导致修复不前进；现在通知失败仍进入明确 unknown，并复用 Session 级 quiesce/repair，保留共享存储安全 fence。
- Stop 提前 abort 执行器导致 failed 抢赢取消；独立取消先按精确 Turn 提交中断，再传递取消信号。旧 Turn 取消不会影响同 Actor 的新 Turn 或无关 peer；owner/store unknown 仍按 Session 范围修复。
- checkpoint 关闭资格误受无关运行影响，且排队取消与 registry shutdown 竞争；关闭按独立 Turn 检查 checkpoint，并等待已发起的独立取消提交。
- Shell cleanup 阻塞时，healthy 通知恢复旧 running 缓存；解除 cleanup 后也没有新事件触发结算。现保留 unknown，解除清理并持久保存后重新读取精确 Turn，经同一投影收敛，不绕过清理屏障。
- dead-owner checkpoint 的直接 abort 入口先做 canonical 对账，不把已完成事实转成取消或再走恢复。

上述问题分别先出现有效 RED，再由最小生产改动转为 GREEN；注入未命中的夹具调试不计为生产 RED。源码全量验收尚在 P0-C 收口阶段，不以专项通过替代最终全仓。

专项实际通过：实时结算 4 项；异常出口 5 项；Stop、写入/通知确认和 live-owner 竞争 7 项；CodingActorSession 41 项。P0-A 的新增 abort 控制回归先返回 recovery instructions missing，修复后通过。SDK 主回归 342 项在 P0-B 较早实现通过，之后关闭和 Shell 修正仍须由最终完整快照验证。source/tests typecheck 已分别执行；最终冻结快照再次执行。

Stop 的两种赢家、持久写入拒绝、提交后确认丢失、读回失败、终态通知失败、foreign owner/revision 替换后的迟到 hook 与旧 Host close 均有门控验证；实际保存/故障注入标志必须命中，不能将未命中的注入当作通过。标准轴与需求轴独立复审均为 0 项剩余发现。

P0-C 包含两个已编写的真实子进程崩溃回归、撤销五秒完成等待及有界诊断，随后完成最终全仓和构建检查。真实崩溃夹具仅终止自己 spawn 的专属子进程，预期硬退出不作为普通测试错误；低层 Turn 定位回归同时覆盖同 Actor 的新旧 Turn。CLI 的增量和最小预算复核单列在 [Actor 构建预算审计](actor-settlement-bundle-audit-2026-11-07.md)。

此 P0-B 提交时，P1 已执行上述基本 Stop、unknown 晚确认、共享 fence 和 live-owner 竞争，其余确定性验证在下面单独记录。没有执行发布或 next-dev 整体合并，也没有写回另一工作区的 work mode 锁定改动。

#### Standards

独立最终审查：0 项可行动发现。新回归只在失败时读取缓存和同步 save-attempt 诊断，不重新发起 SDK/磁盘查询；未新增配置、依赖或跨文件测试框架。

#### Spec

独立最终审查：0 项剩余实现发现。精确 canonical、owner/revision/binding CAS、unknown 出口、checkpoint 关闭及 Shell cleanup 约束均已落实；专项、全仓、构建和未覆盖压力范围分别记录。

### P0-C 与 P1：崩溃、重复交付及关闭竞争

P0-C 回归已提交 `ef1af6fe9`。两个真实进程停点实际 2/2 通过；generation-actors 的五处固定五秒完成等待已删除。等待依精确 output 判断终态，事件只作提示，错误诊断使用有界缓存及 save-attempt；需求复审发现终态检查前多读了一次 Run 诊断，已调整为终态立即返回/失败，最后完整文件 10/10 通过。只改变测试，没有解冻生产源码。

P1 新增两文件，最终串行组合执行 3/3 通过：

- `sdk-runtime.actor-hook-idempotency.test.ts`：实际构造器截获已安装 committed hook，重复交付同一终态，再于同 Actor 新 Turn 执行时交付旧事件。两个 Run 的真实状态文件及 revision 不受重复通知改变，每个 Turn 仅一个完成事件，各执行一次。
- `sdk-runtime.actor-races.test.ts`：A 已完成 canonical 和 Run 后，B 的精确 terminal rename 进入 unknown；A 的状态、输出和事件不回退，Session fence 保留，B 后续修复完成。
- 同一 races 文件：真实 owner-release rename 注入一次 EIO；并发 close 复用 Promise，错误保留，活跃 owner 阻止 contender 接管；重试关闭成功后，原 Turn 以 fresh authority 和原 checkpoint 恢复，执行次数为原始一次加恢复一次。

这些验证补齐 P1 的确定性边界矩阵，与前述 Stop 两赢家、共享 unknown、live-owner/revision 和写入/通知确认故障共同验收。它们不代表所有可能调度、概率失败率或长时间压力均已穷举。新增 P1 文件在全仓启动后加入，因此单独执行并保留 JSON，不伪称被此前已收集的默认套件包含；生产 blob 全程保持不变。

#### Standards

新增 P1 测试与 P0-C 诊断增量独立复审：0 项可行动发现。实际 save/rename 及状态文件验证，不添加生产测试注入点。

#### Spec

交叉审查其他 Agent 编写的文件：0 项剩余发现。P0-C 等待诊断顺序的 P2 已修正并定向验证；hook 重复投递、canonical 事实保持和关闭失败后的所有权边界符合第 6–7 节。

### 最终冻结快照验收

生产三模块保持上述冻结 blob，没有在全仓期间修改生产代码。阶段提交为：`c68e7abc8`（持久关联/对账）、`0c37a4eb7`（canonical 实时结算及必要异常出口）、`031215c63`（独立预算审计）、`ef1af6fe9`（崩溃及精确等待）、`918f526d0`（P1 重复交付/关闭竞争）。

| 检查 | 实际结果 |
| --- | --- |
| 默认全仓，Windows / 4 workers | 1,430 文件：1,423 通过、7 跳过；19,758 项：19,671 通过、87 跳过、0 失败；1,573.83s |
| 全仓启动后追加的 P1 两文件 | 3/3 通过，未并入上一行计数 |
| generation 诊断顺序修正后的完整文件 | 10/10 通过；仅测试修改 |
| 最终 source/tests typecheck | 均通过 |
| 完整 `npm run build` | 包编译、Windows native、CLI/SDK bundle 和 14 组声明构建通过 |
| `test:bundle` 完整 29 文件清单 | 102/102 通过；前 27 文件并发 4，后 2 文件按原约定串行 |
| 本地 `npm pack` | 成功；1,120 entries，37 个导出目标全部存在 |
| `git diff --check` | 通过；没有 lint 脚本，未新增工具配置 |

最终真实 CLI 为 5,196,207 bytes，SHA-256 `76ae8781f649d05ecc742f2f87b1023afb739152dc32a92a2ac7948e0a2701f3`，与预算探测逐字节一致。完整构建和打包回归没有以移除行为或依赖绕过门槛。完整默认套件与 P1 追加验证共享同一生产快照；后者独立保留 JSON，不能虚称在默认套件初始收集的文件中。

日志、JSON、打包产物及完整 bundle 清单运行脚本保存在 OS 临时目录 `kodax-actor-final-20261107`，raw 未提交。包含 `full-suite.json`、`p1-additional.json`、`generation-final.json`、`typecheck-final.log`、`build-final.log`、`bundle-tests.log` 和 `pack-final.json`。打包检查使用 `test:bundle` 原有完整文件清单，仅限制第一组并发为 4，避免 Windows 上不必要的进程竞争；第二组保留原并发 1。

这是一轮新的验收结果，不改写第 1 节历史全量中的单次失败，也不据此声称找到了历史失败的唯一因果链。确定性崩溃、故障与竞争回归证明本文已修复的生产缺口，不证明所有调度或模型语义均被穷举。

最终只读比较另一工作区的 work mode 锁定改动，公共变更文件仅 SDK，基于共同基线的 hunk 无重叠；未写回原工作区。此结果不替代将来整合时的冲突及语义复验。容量修复、next-dev 合并和发布仍分别管理；没有发布或覆盖安装中的 Space/CLI。当前隔离工作区两处已有快照换行触碰未纳入提交。
