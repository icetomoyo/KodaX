# 统一契约修复验证记录

日期：2026-09-26。基线：`fa2db204`。对应 [审计 F01–F09](product-contract-design-audit-2026-09-24.md) 与 [整改方案](unified-contract-remediation-plan-2026-09-24.md)。

## 实施范围

- Host 统一 canonical 工具正文、参数、状态与可证明的时间；保留已有显示历史合并器，展示预览不再覆盖 canonical 工具事实。已接受 inputId 不再被旧 worker 提示词文本启发式过滤。
- 既有 conversation cache 升级可重建的来源描述信息。使用当前 revision 的来源位置补入保留工具/输入锚，全文补读按来源定位；不按物理 lineage 下标或时间猜顺序。
- 保存故障在 SessionViewOwner 持续保留，后继同 Session 完整保存成功才恢复；晚到读取与关闭仍报告故障，关闭错误不跳过后续资源释放。
- Runtime 按当前问题约束验证答案，校验通过才消费；ACP 传递完整计划、只写明确意图并观察 Host 设置。
- Learning/Workflow 订阅的注册、失败、关闭、断连及重建可观察。Host 后端失败通知和能力检查落实到真实 IPC；订阅不重放 mutation。
- Ink/classic/ACP 共用全文分页校验，拒绝不连续、长度矛盾或版本变化的正文。

## 必要的契约与兼容变更

“尽量复用”不是禁止增加必要机制。本轮发现并补充：

1. Session `planModeEffort`：ACP 原有明确选项必须由 Host 解析。沿用 `sharedSessionSettings.keys` 协商，不支持时 mutation 前明确要求升级；普通设置继续兼容。
2. 订阅 ready、失败通知及 Host 终止通知能力：只在 SDK 等待 transport 失败无法覆盖后端存储故障。新客户端要求对应能力，不假装旧 Host 具备终止保证；旧客户端不主动请求新终止通知。
3. 现有分页缓存中的 source keys：已有缓存没有身份定位信息，单凭 outputId/callId 无法在不读取全部正文时找到来源。缓存可失效重建，Session 原文格式与事实所有权不变。

没有引入全局事件日志、第二份 Session 存储或通用状态机。

## RED → GREEN 的外部反例

| 问题 | 基线失败 | 验证入口 |
| --- | --- | --- |
| F01 原文 | 70,004 字符正文被报告成 2,000；工具参数经过预览裁剪 | `sdk-client.observe-history.test.ts`，实际 IPC observe/readItem/history/entry |
| F02 来源 | 引用 `You are the Generator role` 的已接受输入在 history 中变成空列表 | 同上，实际 submit/await/readHistory/observe |
| F03 保存 | 失败已结算后 flush/close 成功；失败关闭后 event bus 仍可订阅 | `session-view.checkpoint.test.ts`、`sdk-client.derive.test.ts` |
| F04 顺序 | 真实 512KiB 页面从 index 3 开始，旧工具排在四段回答后 | `sdk-client.observe-history.test.ts`、conversation cache 测试；含压缩、离窗读取与分支变更 |
| F05 状态 | 显式 success/cancelled 在公开 history 里都变为 error | `sdk-client.observe-history.test.ts` |
| F06 交互 | min_selections=2 的空答案被 accepted | `sdk-client.interactions.test.ts`，实际 IPC 无效→pending→双端竞争 |
| F07 订阅 | 首次 next 前失败、等待中 return 后仍 pending；后端损坏时连接正常却持续等待 | `client-subscriptions.test.ts`、`sdk-client.domains.test.ts` |
| F08 计划 | 实际 ACP permission 的 rawInput 是空对象 | `acp_server.contract.test.ts`，真实 ACP 协议与 IPC Host |
| F09 设置 | 批准与另一端修改后缺失 Host 模式同步；原实现会在下一轮写回缓存 | 同上；断言实际 Provider effort、清除覆盖与下一轮共享设置 |
| 同源时间 | 无时间的 canonical 工具恢复成当前时间 | `sdk-client.observe-history.test.ts` |
| 全文校验 | classic 接受正文长度与声明长度矛盾的分页 | `classic-plane-display.test.ts`，共用 reader 后覆盖三个消费者 |
| 关闭排空 | Learning 初始化阻塞时 `return()` 已成功，初始化仍在后台写入 | `sdk-runtime.learning.test.ts`，真实初始化门闩；等待者及时结束、重复关闭、初始化失败均覆盖 |

期望正文、合法选项及操作顺序直接来自 fixture，不使用生产投影函数计算期望。
测试使用临时 profile、确定性 Provider、临时 named pipe 和本地服务；未调用付费模型或修改用户原始 Session。

## 最终门禁

最终代码以本记录所在提交为准；验证期间的生产源码候选树为 `f9c7a818b496cdd53a31b867cf941d044faf75b3`，随后仅补验证记录，已再次确认源码无差异。
完整分层执行后，系统层唯一失败触发下述 Learning 关闭排空修复；对受影响的本地服务、真实 IPC、订阅与消费者共 111 项，以及重新构建的发行产物进行复验。没有将整层初次失败抹去，也没有重复无关分层来凑通过次数。

| 门禁 | 结果 |
| --- | --- |
| 完整构建 | `npm run build` 通过；包含 packages/native/bundle/dts 及无 Node ambient types 的 Client 检查 |
| 类型检查 | `npm run typecheck` 源码与测试均通过 |
| 发行构建测试 | 关闭排空修复后的最终构建：`npm run test:bundle` 39/39 通过 |
| 真实终端 | 关闭排空修复后的最终构建，ConPTY + xterm/headless 的 Ink/classic 48/48 通过；包含普通模式滚轮/PgUp/PgDn、transcript、停止、队列、退出和恢复 |
| fast | 全层执行 210 文件、2168 测试通过；唯一超时用例去重后单独复验通过，新 ACP 契约用例同时复验通过（2/2）；原有 1 文件、32 测试跳过 |
| unit | 冻结版本完整重跑：730 文件、11,915 测试通过，3 项既有跳过 |
| contract | 117 文件、954 测试通过；21 项既有 TODO，不计入通过 |
| system | 整层 73 文件、1,326 测试通过，42 项既有跳过；唯一早关闭清理竞态已修，原失败文件 10/10 通过，相关 5 文件合计 111/111 通过 |
| 静态检查 | `git diff --check` 通过；仓库没有 lint script/config，不虚报 lint 通过 |

最终 PTY 现场：`%TEMP%/kodax-repl-acceptance-XDrw9H`；首轮现场为 `%TEMP%/kodax-repl-acceptance-yR4Skw`，均保存屏幕、ANSI、Host 视图和模型请求。主会话的门禁日志保存在 `%TEMP%/kodax-contract-*.log`；最终局部修复后的日志后缀为 `-closed.log`。
最终发行文件 SHA-256：`dist/kodax_cli.js` = `1fd6533e552b9e74f06427367ea43312829c39a519889ba09c0471f04ebb2bae`；`dist/sdk-client.js` = `b478d29bb82401d2aab699a5a59edc3d0b0f3a078a7a6d5af22f8ba5da1462b9`。

## Standards

独立规范轴首次审查发现两项：Ink Learning 的 `open` 闭包混合同步、刷新与重连，超过仓库的小函数约束；`learning.events.reportErrors` 没有消费者，属于可删除的预设字段。前者为低优先级成文规范问题，后者为坏味道判断题。已拆分恢复职责并删除闲置字段；冻结树增量复查通过，无未关闭 finding。

## Spec

独立需求轴首次审查发现两项 P2：注册回执前的终止通知未阻止 `ready` 成功；Workflow 重连丢弃非终态快照，使已暂停任务的进度停留在旧值。握手早失败、暂停快照恢复及快照读取竞态均 RED→GREEN，相关 4 文件 156 项通过。冻结树增量复查通过，无未关闭 finding。

规范轴 2 项已关闭（最高低优先级）；需求轴 2 项已关闭（最高 P2）。首轮两轴上下文独立；规范轴增量复查的完整 diff 自动包含本记录的需求摘要，该评审明确未以此作为规范判断依据。
最终 Learning 关闭排空的两文件增量亦经两轴独立窄复查通过，无新增 finding。

## 验证期间发现的门禁问题

- 完整 PTY 的队列边界断言原先统计所有模型请求，实际后台 Learning review 增加请求，触发 `32 !== 31`；现场回答仍暂停且追问仍排队。测试改为只统计该场景的输入，继续验证同 Run、工具后下一次调用、消费一次与队列清空。修正后该专项 7 项通过；完整复验结果见最终门禁。
- 基线 `KNOWN_ISSUES.md` 已有 `35 Open including 1 needs-info`，统计测试只识别 `Open,`。解析与计数增加 `needs-info`，同时独立核对该状态数量，未改变 Issue 342 的未证实状态。
- 首次 fast 套件中既有 Notification hook 测试超过 20 秒；没有放宽超时或修改生产逻辑。它与统计测试单独复验共 29 项通过，这两项在后续完整 fast 层重验中也通过。
- 增强的旧 ACP daemon 综合用例一次通过耗时 59,985ms，随后并行验证超过既有 60 秒期限。移除其中与新 `acp_server.contract.test.ts` 重复的三轮计划/设置流程；新用例以真实 ACP、IPC 与第二 Product Client 保留全部行为断言，并接入 `ACP setSessionMode`，不增加模型轮数。旧 daemon 用例恢复基线，继续验证真实启动器、共享 Host、MCP、取消与释放。双轴确认无唯一覆盖丢失；未提高超时上限。最终分别耗时 30,377ms / 7,128ms，2/2 通过。
- 系统层暴露 Learning 早取消后的 `ENOTEMPTY`。基线 `return()` 也未排空初始化，但旧 `next()` 隐含等待初始化，使原测试暂未暴露问题；即时结束已关闭 `next()` 后该耦合显现。受控真实初始化门闩稳定复现“关闭提前成功”，现由缓存的 `return()` Promise 等待自身初始化与底层清理，等待中的 `next()` 仍立即结束，初始化失败仍明确拒绝。不增加删除重试，也不将本地订阅关闭泛化成所有 Host 资源的全局排空保证。

## 后续合并的回归责任

| 事实所有者 | 必须维持的不变量 | 首选回归入口 |
| --- | --- | --- |
| Host canonical 历史与视图 | 原文、身份、显式状态、来源顺序跨面一致，离窗后可补读 | `sdk-client.observe-history.test.ts` |
| SessionViewOwner / Runtime | 保存失败不被读屏障或关闭吞掉，后继保存可恢复 | `session-view.checkpoint.test.ts`、`sdk-client.derive.test.ts` |
| Runtime 交互 | 验证当前约束后才消费，竞争应答只成功一次 | `sdk-client.interactions.test.ts` |
| daemon 订阅及生产消费者 | 早失败可见、关闭不挂起、重连恢复快照且不倒退 | `client-subscriptions.test.ts`、`sdk-client.domains.test.ts`、`workflow-observation.test.ts` |
| ACP 适配层 | 只提交明确设置意图，完整计划通过实际协议 | `acp_server.contract.test.ts`，另保留 daemon 启动/取消用例 |
| Ink / classic / ACP 显示层 | 全文分页一致校验，终端切换和输入/停止不破坏 Host 事实 | 三个消费者 reader 测试与 `tests/repl-pty-acceptance.mjs` |

主线合并触及这些所有者时，应按对应行重跑公开入口的正向和失败序列，再运行消费者薄层验收。测试证明本次有限场景，不保证不存在其他缺陷；不能只以 API 方法数量或类型通过代替行为验证。

## 限制

Issue 342 的普通模式滚动故障此前未复现，不能因输出/排序修复通过就标记解决。终端验收覆盖的环境和输入方式需单独记录。
原 Session 的未落盘后缀不能重建；本轮修复不声称恢复完整原答案。
旧记录完全缺失来源时维持明确的兼容规则，不能恢复从未保存的精确逐事件顺序。
旧日志中的通过数字不作为本轮最终门禁证据。
