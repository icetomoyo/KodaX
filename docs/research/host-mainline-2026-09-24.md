# Host 主线合并复核（2026-09-24）

范围：当前分支 `88e11abd` 合并 `origin/KodaX` 的 `c447c0f3`。按 resolving-merge-conflicts 技能还原两侧意图；本笔记只覆盖 Host 生命周期、状态发布、升级诊断、Memory/终态维护。引用均为仓库一手源码或提交。其它消费面由总审计报告汇总。

## 结论

主线新增的 Memory 工作所有权、终态维护排空、预取消入口结算和 Windows 诊断，可以进入当前固定 Host 设计，不需要恢复通用 exit settlement、worker 模式或客户端执行权威。专项 5 文件 **106/106** 通过，包含真实 Windows 进程持续读取状态时的 200 次原子发布。此结果不代替全仓类型检查和全量测试；全局验证由合并主任务记录。

## 冲突意图与融合

| 文件 | 当前分支意图 | 主线意图与融合结果 |
| --- | --- | --- |
| `src/runtime-daemon/state.ts` | Windows 短暂 rename 拒绝时复用已 fsync 的 staging 文件，保留旧状态；最多五次尝试 | `0f9c8763` 将重试收紧为 EPERM、单调 200ms 累计预算（包含后续 I/O）、保留首次 EPERM、无争用无等待分配。采用该更新算法，保留分支的其余身份/状态结构。见 `src/runtime-daemon/state.ts:500`。 |
| `src/runtime-daemon/state.test.ts` | 验证旧状态与 staging 清理、有限重试 | 融入更完整的主线预算、非 EPERM 立即失败、首次错误、fast path 测试；分支原有其它 ownership 测试保留。见 `src/runtime-daemon/state.test.ts:213`、`:252`、`:280`、`:314`。 |
| `src/sdk-runtime-daemon-upgrade.test.ts` | `ensureKodaXRuntime` 才能启动/刷新；passive connect 不能隐式替换 Host | `0ec6aa41` 增加诊断 sink 抛错时仍返回原始 capability 错误的回归。保留本分支完整升级测试，把新案例移到 `ensureKodaXRuntime`，不恢复主线旧 `connect(autoStart)` 路径。见 `src/sdk-runtime-daemon-upgrade.test.ts:120`、`:305`。 |
| 已删除的 `exit-settlement.ts` 及测试 | 移除独立通用退出结算面，使用固定 Host 生命周期 | `0ec6aa41` 仅在旧 `validateWindowsOwner` 增加缺失字段诊断，没有新增执行语义。保持删除；对应旧票据字段清单不移植到不存在该票据的接口。有效的 Windows 身份探针诊断仍由 `src/runtime-daemon/manager.ts:128` 写入 Host 日志，进程退出仍由 `src/runtime-daemon/process.ts:327` 核验精确身份。 |

明确取舍：本分支原实现对 EACCES/EBUSY 也重试，融合后遵从主线经测试的 EPERM 限定，EACCES/EBUSY 立即抛出；两侧共同要求的“不删除旧状态、不重写未刷新的数据、失败可见”保持不变。

## 自动融合语义抽查

- `7c92d2aa` / `18762851`：Runtime 分别登记已接纳的 managed-task maintenance 与 Memory work；关闭后拒绝新 work，关闭时取消 reviewer 并等待已登记工作。注入点在 `src/sdk-runtime.ts:10518`，登记在 `:4783`/`:4799`，取消在 `:5232`，排空在 `:5249`/`:5250`，均早于 Actor、owner liveness 与 Session view 释放。`packages/coding/src/types.ts:572` 是内部执行 hook，未新增 Product Client RPC 或第二个事件面。
- 正常 Product Host shutdown 仍经 `src/client-runtime-adapter.ts:22` 和 `src/runtime-daemon/host.ts:222` 到 Runtime close。Client disconnect 仍遵循现有 adapter 连接语义，不把每个客户端离开误当成全局 shutdown。
- `bd01e0f4`：`packages/coding/src/agent-runtime/run-substrate.ts:958` 在 Memory setup 后、transcript/provider 之前把预取消转换为 interrupted terminal；没有恢复客户端自建 queue，也没有改写分支的 `interruptInput` admission。
- Memory reviewer 取消是 Host 的关闭职责，普通 Run Stop 不应取消其它已完成 Run 的维护。专项 `src/sdk-runtime.memory-review.test.ts:287` 覆盖恢复 review 与新 Run 并存时 Stop 的隔离；maintenance 首个用例验证 Run 完成与后继启动无需等待可选投影写入。

## 验证

执行：`npx vitest run src/runtime-daemon/state.test.ts src/runtime-daemon/state.windows.test.ts src/sdk-runtime-daemon-upgrade.test.ts src/sdk-runtime.maintenance.test.ts src/sdk-runtime.memory-review.test.ts --maxWorkers=1`。

结果：5 文件、106 用例通过，58.22s。分别为 state 55、upgrade 34、Memory 12、maintenance 4、Windows 真并发发布 1。日志 `.host-sept24-tests.log` 为本地忽略文件，不入版本控制。针对本组冲突文件的 `git diff --check` 通过。

## 保留边界与未证实问题

- reviewer 的 AbortSignal 是协作取消，Host 等待真实 cleanup；自行注入且永不响应取消的 reviewer 可以拖延关闭。这是 `packages/coding/src/memory-runtime.ts:926` 的明确所有权选择，不应为缩短关闭而提前释放 owner 或虚报清理完成。当前专项验证的是遵守取消合同的 reviewer。
- state 原子替换测试只证明 daemon state 发布；不能据此声称此前记录的其它锁读取竞态已解决。
- 本组没有发现必须新增统一接口的合并缺口；未做配置/catalog 消费迁移、Learning 订阅释放或 A2A 恢复结果的重新判定。那些问题须由对应消费者审计独立核验。
