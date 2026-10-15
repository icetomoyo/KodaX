# ISSUE_369 — Concurrent resume during Host refresh

2026-10-15。修复随 `v0.7.97-alpha.6` tag 发布；npm 发布仍为手动。

## 现象与确认范围

两个不同目录同时 `kodax -r` 并选择会话，可能在 Connecting 阶段失败：

- `Runtime state changed while daemon preflight was being read.`
- `The original Host is still running; retry startup after it exits.`

默认 Host 日志显示 14:04:39 接收正常停机、14:05:03 完成退出，相隔约 24 秒。
这能说明第二条错误等待的是仍存活的旧进程；未捕获其剩余启动预算，不能断言
该等待检查本身有错。没有强杀用户 Host，也没有清除其锁、会话或未知清理登记。

专用 Home、私有安装副本、旧版已加载 Host、50 份各 1,000 条消息的大历史夹具，
以及两个目录的真实 ConPTY 客户端复现了第一条精确错误：一个客户端失败，另一个
稍后进入 TUI。并未声称完整重建了用户两次失败的所有时序。

## 根因与修复边界

并发临时连接会在另一个启动器读取管理状态时改变 revision。SDK 原本只对已返回的
`connected_clients` 结果退避，读取过程的 `conflict` 却直接退出。一个启动器正常
关闭旧 Host 时，另一个仍在握手或只读检查，也可能收到可重连断开。仅修复第一项后，
实际双终端又捕获到 `Runtime daemon transport closed.`，对应两个公开启动用例先红后绿。

固定短于一秒的重连窗口还可能反复打断较慢检查。受控时钟用例中，竞争者需要一秒
安静窗口，原策略会耗尽预算；修复后的随机退避窗口同时考虑前次检查耗时。

仅自动启动器的初始化和更新前只读检查可重新观察当前 Owner。每次重试先释放临时
连接；不重置启动期限，取消可终止退避。停机请求及业务请求不重放；损坏元数据、
无效帧、主动断连和无法确认的存活 Owner 不因此放行。被动连接不获得自动更新能力。
沿用现有 `onStartupProgress`，检查重试报告 `checking`，无需 SDK 调用方另建重试逻辑。

## 回归入口

```powershell
npx vitest run src/sdk-runtime-daemon-upgrade.test.ts src/runtime-daemon/management.orphan-exit.test.ts src/runtime-daemon/process.owner-exit.test.ts src/sdk-runtime.preflight-projection.test.ts src/cli-startup-progress.test.ts src/sdk-client.startup.test.ts src/sdk-runtime.host-owner.test.ts tests/tracker-consistency.test.ts --maxWorkers=2
npm run typecheck
npm run build
node --test tests/bundled-product-exit.test.mjs
node tests/repl-concurrent-startup.mjs
```

真实双终端默认启动当前构建的 Host，在同一私有安装路径替换构建字节，再同时启动
两个目录的恢复选择器。若要覆盖旧版慢预检，可把 `KODAX_ACCEPTANCE_BASELINE_INSTALLATION`
设为预先构建的旧安装目录后运行同一入口；只使用其 `dist`、启动脚本和 package 元数据，
不运行模型请求。终端驱动依赖沿用 FEATURE_298 的 `KODAX_ACCEPTANCE_TOOLS` 设置。
脚本保留 `results.json`、两份原始 ANSI 和启动/停机日志，正常退出后验证 `stopped: true`。

## 已记录的复验

- SDK 启动文件 45/45 通过，包含七项新增用例及带 typed conflict 的停机拒绝断言。
- 最终相关回归 8 文件、77/77 通过，包含 Owner 实际退出、取消、忙时预检、SDK 连接和 tracker。
  完整源码/测试类型检查、构建及自包含 SDK 声明生成通过；不增加公开参数、RPC 或进度联合成员。
- 构建后的 Product 退出验收 2/2 通过，覆盖其他客户端保护、精确进程清理与不停止替换 Owner。
  本次没有重跑全仓测试或再次执行完整 Electron/全部终端验收，不沿用上轮结果宣称本轮全量通过。
- 私有旧 Host 双终端最终样本：12.811 秒、12.767 秒到可输入 TUI，两个 CLI 均退出 0，
  无强制结束；旧/新 Runtime ID 不同，最后验证 Host 已停止。证据目录为
  `%TEMP%/kodax-concurrent-resume-jxGf01`。这是一次含旧版预检及构建切换的场景样本，
  不是日常热启动耗时或统计分位数。
- 同一入口以当前构建作为原 Host 再验证构建切换：7.955 秒、7.974 秒到 TUI，
  两个 CLI 均正常退出，Host 停机验证通过；证据为 `%TEMP%/kodax-concurrent-resume-M6wSzk`。
  原 Host 实现不同，因此不将两组数字当作严格性能 A/B。
- 较早失败证据保留在 `%TEMP%/kodax-concurrent-startup-81r9WQ`（精确预检错误）和
  `%TEMP%/kodax-concurrent-startup-zOimUN`（只修第一项后捕获断连）；两项读取恢复后，
  加阶段探针的中间样本 `%TEMP%/kodax-concurrent-startup-FmypC8` 两端均进入，约 34 秒。
  不把中间和最终的随机竞争样本当作严格耗时 A/B。
- 用户在本轮重建后确认，原先两个目录均可正常进入。

持续有真实工作、无法取得稳定快照或旧进程未在预算内退出时仍允许明确失败；本修复
不承诺任意竞争都必然收敛，也未将新问题误记为 Issue 367 已覆盖的在途 mutation 场景。
