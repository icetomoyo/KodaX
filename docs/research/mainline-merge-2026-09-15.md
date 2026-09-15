# 2026-09-15 主分支合并记录

将主仓库 `origin/KodaX` 的 `eb2168ed` 合并到 `codex/product-client-refactor`，合并前 HEAD 为 `795b8469`。远程默认分支经 `git ls-remote --symref origin HEAD` 验证。新增四个提交：`a10bba74` 图片校验及文字恢复、`ac5e6ddd` rc.5、`ad8b88ce` Windows 进程清理查询优化、`eb2168ed` rc.6。保留合并前未提交的 GLM 调研文档，不将其混入本次合并提交。

## 冲突处理

| 文件 | 当前分支意图 | 主线意图 | 融合结果 |
| --- | --- | --- | --- |
| `.github/workflows/release.yml` | 移除退役 Runtime worker | 发布包带图片 WASM codec | 加入 image-codec，继续不打包 runtime-worker |
| `docs/FEATURE_LIST.md` | FEATURE_298 已进入实现和验证 | 更新 rc.6 发布记录 | 保留 298 InProgress，更新已发布版本 |
| `docs/features` | 保留 v0.7.97 设计与实现记录 | 引入 rc.5/rc.6 设计文档记录 | 子模块合并提交 `26d7cf0` 同时包含 `fb06f62` 和 `3694e9d` |
| `packages/coding/src/agent-runtime/run-substrate.ts` | Run 隔离身份、Host 队列消费/确认、inputId 和失败回滚 | admission 时准备图片，生命周期缓存，失败后文字恢复 | 图片上下文外包现有执行上下文；准备队列图片仍处于回滚保护中；保留 Host 消费入口 |
| `packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts` | reasoning effort 拒绝反馈 | 文字恢复只正式重试一次 | stream 参数同时包含反馈回调与 singleAttempt |
| `public_docs/sdk/embedder-guide.md` | 描述 v0.7.97 开发分支 | 更新已发布基础版本 | 开发分支说明保留，基础版本升至 rc.6 |

以上意图依据合并两侧差异、`a10bba74` 提交说明、[Issue 335 回归规范](../test-guides/ISSUE_335_v0.7.96_REGRESSION_GUIDE.md)、[FEATURE_298](../features/v0.7.97.md) 与 [FEATURE_299](../test-guides/FEATURE_299_0.7.96_TEST_GUIDE.md)。主线引入的一处 Markdown 文件末尾空行在差异检查中清理。

## Standards

首份固定补丁 SHA-256 `1EEB997973F17AE02DA1E25CA3CBE1A2237C8E82394BF2943EA6ABE39F9A81A9`：硬违反 0、需处理 smell 0。Run 上下文组合、队列图片准备失败后回滚与重抛、effort/恢复参数并存均符合现有规范。未借合并扩大旧长函数与双执行路径重构。

最终恢复增量 SHA-256 `0CD1E63EF9AC9A0CB79EEA66CD6D144FFE36F04AB9C9C6C822B8DCD0BD0A129B`：硬违反 0、需处理 smell 0。通过既有 internal 输入端口提供只读事实，未新增公开产品事件或配置；两个恢复调用点各作一个 OR，不增加多余抽象。

后续三个图片测试夹具与 SDK 能力说明增量复核：硬违反 0、需处理 smell 0。复用主线有效 PNG，不改变原断言；SDK 头部不恢复已退役的 runtimeExitSettlement 当前能力声明。

## Spec

首份补丁发现 1 项 P1：新增文字恢复的待输入检查读取旧消息队列及外部回调，不能看到 FEATURE_298 独立 Host Session 队列。违反主线要求“诊断前后检查取消和待处理输入，拒绝将旧方案应用到新输入”。该问题属于两侧实现组合后才暴露的连接缺口。[恢复规范](../investigations/MAIN_AGENT_RECOVERY_IMPLEMENTATION_2026-09-14.md)

真实 IPC 回归先复现 SA/AMA 在诊断中排队后仍继续请求。最终经 `context.interruptInput.hasPendingInputs` 只读当前 Session 队列，仅对非 fork invocation 注入；SA/AMA 只在文字恢复检查使用它，保留原 Actor 队列与外部回调。曾尝试泛接事件的方案被既有 Skill 屏障测试发现改变正常调度，已撤回，没有更改旧测试预期。最终新回归同时覆盖当前 Session 阻止旧方案、其他 Session 不误阻断、排队输入与原图历史保留。[新增回归](../../src/sdk-client.text-recovery.test.ts)

独立需求轴复核：原 P1 已关闭，剩余 0 项，无新增可行动问题。规范轴剩余 0 项；需求轴剩余 0 项。

全量运行进一步发现当前分支三个旧图片测试使用无法解码的 PNG 字节。新主线正确将其识别为损坏内容，因此换用 `tests/fixtures/images/valid-png.png`，保留 Provider 图片送达、原字节一致性、删除/漂移拒绝及 Host 工具成功状态的全部断言。独立需求复核无发现。涉及 `sdk-client.inputs.test.ts`、`sdk-client.artifacts.test.ts`、`session-view.tool-results.test.ts`，无新增生产改动。

## 验证

初次合并类型检查与构建通过。评审发现上述交互问题后主动停止初次完整测试，不将其计为通过；随后固定生产源码完成完整运行，再修正上述三个测试夹具并复验失败文件。不能将完整运行的失败数隐去或称为单次全绿。

| 检查 | 结果 |
| --- | --- |
| 定向回归 | 6 文件、44/44 通过：真实 Host 恢复、Session queue/queue-boundary、主线文字恢复、CAP-038/080；`.merge-text-recovery-final.log` |
| `npm run typecheck` | src/tests 均通过；测试夹具修正后额外 `typecheck:tests` 也通过；`.main-merge-verified-types.log`、`.main-merge-fixture-types.log` |
| `npm run build` | 通过，含四 workspace、native、bundle、自包含 SDK 声明与无 Node ambient types 的 Product Client；`.main-merge-verified-build.log` |
| `npm run test:bundle` | 34/34 通过，含 codec 发布包、图片验证及凭据桥文字恢复；`.main-merge-verified-bundle-tests.log` |
| `npm run test:repl-pty:built` | 35/35 通过，Ink 与 classic 均完成输入、设置、队列、停止、退出和恢复验收；`.main-merge-verified-pty.log` |
| `npm test` | 1093 文件通过、4 失败、1 跳过；15967 用例通过、4 失败、77 跳过、21 todo，695.14 秒。失败为 3 处损坏图片夹具和 1 次 Session 锁读取竞态；`.main-merge-verified-tests.log` |
| 失败文件复验 | 三个图片文件修正后各自通过；domains 定向 4 例及完整文件 23 例均通过。最终四文件联合复验 **37/37 通过**，43.90 秒，exit 0；`.main-merge-final-rechecks.log` |
| 差异检查 | `git diff --cached --check` 通过；无未解决冲突 |

没有运行真实模型请求或其他操作系统实机验收；发布包检查不等于已构建并发布所有平台二进制。本次只创建本地合并提交，不推送或发布。

锁读取失败发生于 domains 的 SA handler admission 用例，返回 `Session data changed during the read boundary: <session-hash>.lock`。锁实现、历史读取和该测试均未被本次合并修改；定向及完整文件复跑未再现，未为消除此单次结果扩大修改 Session 锁策略。现有证据支持读写相遇的时序问题，尚未锁定具体写入者，也不能据复跑通过宣称该竞态已经修复。
