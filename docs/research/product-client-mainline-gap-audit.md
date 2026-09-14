# Product Client 对主线的能力复核

基线：HEAD `0841fb51`，主线 `origin/KodaX` `7b5b1b9e`；2026-09-14。仅依据当前源码、仓库测试及主线提交，未把旧 feature 台账当作实现证据。

## 摘要

主线 FEATURE_299 的 Session Stop、显式工具执行、Full Access、trusted text authority 和 Shell cleanup 均已进入 Host 公共执行链，没有证据要求增加一套 UI 权限或清理接口。发现两处确定的消费者缺口：输入接受期间收到 abort 提前返回 interrupted；重连/跨客户端取回图像队列时丢失附件。下面列出基线证据与本次修复，文件行号除特别标明外均指审计基线。

## 已确认问题

### P1：输入接受期间取消会提前宣布中断

`packages/repl/src/ui/client-plane.ts:425` 在 `submit` 已返回身份、abort 已触发时调用 `stopRun`，然后立即返回 `interruptedPlaneResult`。此路径既不等待 Stop 回复，也不调用 `awaitRun`。这违背 `docs/CLIENT_CONTRACT.md:124` 关于 Stop 接受、真实终态和 unknown 必须区分的要求。

2026-09-14 通过 `node --import tsx --input-type=module` 直接调用公开函数，无修改源码的最小实验：plane.submit 在返回 `{state:'submitted',runId:'r'}` 前触发 controller.abort；plane.stop 返回不结算 Promise；plane.awaitRun 返回不结算 Promise。实际输出为 `outcome.interrupted=true, stopCalls=1, awaitCalls=0`，调用已经完成。真实 IPC 接受回复延迟时用户取消即可触达同一分支；执行器、Shell cleanup 或 Stop 回复未完成不能使显示层认定已中断。

最小修复方向：将该情况接回既有 Stop + awaitRun 流程；已有 Run 的终态必须由 Host 裁定。没有 Run 身份的排队输入仍使用精确 inputId 撤回，不停止其他显示 Run。

修复：保留已接受 Run 身份并进入现有停止/等待结算循环。`packages/repl/src/ui/client-plane.stop-control.test.ts:19` 通过公共 `runClientPlaneRound` 检查 cancelled、自然 completed、shell_cleanup_unconfirmed 三种结果：Stop 已回复 unknown 时仍不提前完成，随后准确处理 Host 结果；接受时滞后的显示 Run 不能抢占刚接受 Run 的停止身份。首轮 RED 三项均因提前 settled 失败，最小修复后连同既有 client-plane 用例 59/59 通过。工具消费者 `packages/repl/src/ui/InkREPL.tsx:8492`、`packages/repl/src/interactive/repl.ts:924` 已统一进入 `followClientPlaneRun`，该函数原本就处理初始 aborted 并等待 Host；不存在另一份待补的 tool round 生命周期。

同一接缝再补排队撤回失败：基线 `client-plane.ts:402` 只记录 withdraw 拒绝，随后仍返回 interrupted。新增 `client-plane.stop-control.test.ts:5` 复现 Host 拒绝撤回而输入仍排队时函数却 resolve；RED 按预期失败。另在 `:19` 覆盖 withdraw 返回 undefined 的未确认情形，RED 同样提前 resolve。修复保存撤回错误并在取消等待后向调用者抛出；undefined 按既有 queue.take 契约显式报告未确认，成功撤回仍沿用原行为，且从不停止其他 Run。既有成功撤回测试 fixture 改为返回正文以表达真实确认。

### P2：无本地草稿时取回图像队列丢失附件

基线 `src/cli-client-plane.ts:63` 把 Host 返回的完整输入压缩为 `.text`；`packages/repl/src/ui/client-input-queue.ts:67` 只有存在本地草稿时才能恢复原来的 `@path`。图像准备在 `packages/repl/src/common/input-artifacts.ts:133` 将图像引用移出执行文本，因此另一个客户端或重连后的 REPL 按 ↑ 取回时，得到正文却丢失图像。Host `inputs.withdraw` 契约已含 inputArtifacts，不需要新 RPC。

修复：CLI binding 保留原输入；Ink plane 的 withdraw 类型兼容已有纯文字绑定。没有本地草稿时，queue 将图像附件补回可编辑的绝对 `@"path"`，按真实执行目录识别原有相对/绝对引用，不重复添加。原草稿和文字编辑行为保持，修改后的文本通过既有 preparePromptInputArtifacts 再提交。

`src/cli-client-plane.test.ts:9` 从生产 adapter → 新建无草稿 queue.pull → 编辑文本 → submitPrompt 验证带空格路径，另覆盖已有绝对/相对引用保持原样。RED detached 图像用例丢路径失败、两个既有引用行为通过；修复后三项及既有 queue/input-artifacts 用例共 13/13 通过（maxWorkers=1）。这是图像输入回归：当前 REPL 文本准备本来仅识别 image；file/video 的完整可编辑回填不是本次扩展的范围。

最终定向回归：`npx vitest run packages/repl/src/ui/client-plane.stop-control.test.ts packages/repl/src/ui/client-plane.test.ts src/cli-client-plane.test.ts packages/repl/src/ui/client-input-queue.test.ts packages/repl/src/common/input-artifacts.test.ts --maxWorkers=1`，5 个文件 73/73 通过。全量测试和类型检查由主任务统一收敛，本子任务未重复运行。

undefined 撤回增补后重新运行两个 client-plane 文件，61/61 通过；附件相关 13 项未再改动，累计覆盖 74 个定向用例。

Spec 复查增补：SDK 图像可以使用无后缀路径或与显式 mediaType 不同的后缀，仅恢复路径会再次丢图或改错类型。公开生产 adapter/queue 回归先复现无后缀 `capture` 丢附件与 `capture.jpg + image/png` 被改为 image/jpeg，覆盖忙时 submitPrompt 和空闲预解析后 submit 两个真实接缝，RED 四项失败。

最小修复保留按 Session 归属的已取回图像元数据及取回 executionCwd，只匹配可见引用或该次已经解析出的相同附件路径，不增加语法、不复制文件。显式类型优先；用户删除引用就不携带附件；接受提交后清除取回元数据，失败及再次取回沿用原草稿附件。空闲预解析仍有无后缀相对引用时使用取回的 executionCwd，该目录不同于 process.cwd 的新增回归也先 RED 再 GREEN。取回后文件被删除时统一 submit 转发图片准备警告，不静默丢图，该公开回归同样先 RED 再 GREEN。最后三个附件相关文件 21/21 通过，覆盖删除引用、Session 隔离、提交清理、失败取回与重复取回；取消接缝的 61 项未再修改。

Windows 大小写增补：Host 图像路径 `Capture` 配可见 `@"capture"` 时，恢复阶段已按不区分大小写去重，但准备与元数据匹配原先使用严格字符串相等，仍会丢图。公开 queue 的 prompt/prepared 两条 Windows 条件测试均先 RED（附件为空）。恢复、准备及 queue 三个真实调用点现在复用同一个小路径 key 函数：仅 win32 统一小写，其他平台保持大小写敏感。最终附件三个文件 23/23 通过，diff check 通过；只保留可见引用所需的原元数据，无新媒体语法或副本机制。

## 已确认非问题

| 关注点 | 当前真实接线及证据 |
| --- | --- |
| Session Stop 缺少产品入口 | `packages/coding/src/client-contract.ts:639` 定义 sessionId/expectedRunId/requestId；`src/client-runtime-adapter.ts:28` 直达 runtime.sessions.cancel。Host 在 `src/sdk-runtime.ts:11882` 建立固定 frontier，并于 `src/sdk-runtime.ts:11924` 发布前拒绝已终态 expected Run；不是根据 UI 缓存清队列。主线修复 `3e4bea12` 已承接。 |
| 独立工具无法通过产品客户端执行 | `src/client-runtime-adapter.ts:130` 将 startTool 映射为 runtime.runs.start 的 toolInvocation；`src/sdk-runtime.ts:11085` 校验输入身份和真实 rawInput，`:11095` 将工具参数纳入意图摘要，`:10587` 选择工具执行路径。无须新增 Shell 专用 RPC。 |
| 旧 Host 会默默缺能力 | `src/sdk-runtime.ts:894` 要求 productClient v1；`:4175`、`:4219`、`:4220` 声明产品契约、Session cancellation 和 toolInvocation。`src/runtime-daemon/client.ts:662`、`:694` 对底层操作仍明确拒绝缺失能力的 Host。 |
| Full Access 或 trusted text 权限由 UI 自行提供 | `packages/coding/src/client-contract.ts:740` 允许选择 full-access；`src/client-settings.ts:5` 传递产品设置。`src/sdk-runtime.ts:13458` 去掉调用侧 trustedTextMutationHost，`:13479` 以 Host workspace、执行目录及实时模式构造可信 authority，`:13492` 绑定单次 textApprovals。工具完成在 `:18986` revoke，终态在 `:22211` clear。主线 `06626fc3` 能力仍在。 |
| Shell cleanup 新修复没有进入 Host | `src/sdk-runtime.ts:10432` 为确切 Run 注册并持久保存 cleanup；`:11868` 在 Stop 交付时重试；`:22196` 有未完成 cleanup 时保留 unknown，不能写终态。重启读取 `:17496` 恢复 cleanup，不确定时保留 unknown 及 stop。主线 `baac57ac`、`368982ae` 已承接。 |
| await 的产品投影把 unknown 丢失 | `src/client-runtime-adapter.ts:137` 保留 outcome.phase 与 error.message；`:135` 的 read 直接保留 Runtime 状态。`packages/coding/src/client-contract.ts:668` 文档明确 unknown 不是成功或取消。当前已确认的缺口发生在消费者提前返回，非该投影。 |
| Stop 后 after_turn 输入仍能撤回是遗漏 | `docs/CLIENT_CONTRACT.md:135` 明确保留未交付队列，普通 stop/failure 不自动 drain。`src/sdk-client.queue.test.ts:153` 验证保留正文、可撤回且不启动剩余工作。它们尚未成为 Run，不应强行纳入 Run frontier。 |

## 未证实与未解问题

- 本轮没有运行真实 Windows native Shell cleanup 故障注入，故不能凭静态承接宣称所有 native 子进程场景验收通过。需区分源码接线完整与平台实机验证；主线修复提交也不替代分支实际测试。
- `ClientRunOutcome` 不返回完整 stop 结构，但 `runs.read` 可读取，且 await 保留 unknown/error；目前没有可复现能力缺口，不建议为此扩大产品协议。
- 此笔记不覆盖所有 REPL 命令、ACP/A2A 和 UI 渲染领域；由并行审计单独核对。
