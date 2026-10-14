# First-turn live smoke：零模型根因重放

日期：2026-10-14。基线 `bd4479d59cab3d082f07c2d34681fff198d82fa0`，候选为当前未提交工作树。所有付费调用已停止，总账 35 calls / 768196 charged tokens / USD 0.050298718 参考记账；其中 unknownUsageCalls=1。本诊断 **零模型调用、零网络请求**，不增加预算。

## 结论

`live-sdk-smoke-r4.json` 的文件未修改是真实失败；`result.success=true` 不能替代文件 groundtruth。其原因是 **实验调用了低层 `@kodax-ai/coding` runKodaX，却没有注入生产 text mutation host**，不是本次 token 优化回归。正确 Runtime 入口在 `NODE_ENV=production` 下用同样 read/edit 参数能够实际修改文件。

原 live 结果必须继续记为失败。新的 Runtime 重放只证明执行链路：read/edit 两步来自已捕获参数，路径换成自有临时文件；第三响应是脚本指定结束文案，**不是原模型第三响应，也不是新的 live E2E 成功**。

## 源码证据

- 低层 mutation 在没有 `ctx.trustedTextMutationHost` 且 `NODE_ENV !== 'test'` 时明确拒绝；仅 test 环境回退到本地文件写入。[text-file-mutation.ts:205](../../packages/coding/src/tools/_internal/text-file-mutation.ts#L205)、[236](../../packages/coding/src/tools/_internal/text-file-mutation.ts#L236)。该文件在 baseline archive 与候选 SHA256 同为 `dd1f9df0f4a7724809fa18d49907d73679bb919f4267149de0c5a7cf2b2457ab`。
- root SDK 的 `/coding` 入口不是直接裸 re-export：它从 `trusted-coding-entry` 覆盖导出 runKodaX。[sdk-coding.ts:21](../../src/sdk-coding.ts#L21)。wrapper 在缺少 host 时创建真实 host，并将其传入 context。[trusted-coding-entry.ts:71](../../src/trusted-coding-entry.ts#L71)、[100](../../src/trusted-coding-entry.ts#L100)。因此不能把实验的低层包入口缺省配置失败说成所有 SDK 入口不可写。
- Runtime 创建 native transaction host，再向运行 context 注入。[sdk-runtime.ts:13976](../../src/sdk-runtime.ts#L13976)、[14140](../../src/sdk-runtime.ts#L14140)。host 的 snapshot/commit 使用真实 native binding，诊断未替换这层。[windows-text-transaction.ts:407](../../src/windows-text-transaction.ts#L407)。相关设计见 [ADR-066 text authority](../ADR.md#L5740)。

## 反馈循环和逐变量结果

先运行“文件应变为加法”的断言，在 production 环境实际 RED，得到未修改文件和明确 tool_result：

`[Tool Error] edit: The trusted text transaction host is unavailable.`

最初 Vitest 默认 `NODE_ENV=test` 的同序列反而成功，暴露 test fallback 的掩盖作用；随后显式冻结 NODE_ENV，并把诊断测试改为准确断言各条件的已知结果。

| 条件 | candidate | baseline archive |
|---|---|---|
| production，原 read/edit visibility 与原路径/两次工具 guard | host unavailable；文件不变 | 同样拒绝 |
| production，仅去掉 beforeToolExecute | 同样拒绝 | 同样拒绝 |
| production，仅去掉 toolVisibilityPolicy | 同样拒绝 | 同样拒绝 |
| 只把 NODE_ENV 改为 test，保留原 guard/visibility | 实际编辑成功 | 实际编辑成功 |
| production，真正 createKodaXRuntime/session/full-access/native host | 实际编辑成功；注释和格式完整保持 | 未重复；根因基线已有前四项独立验证 |

原 guard 日志记录 read 与 edit 的 `allowed=true`、不同 `meta.toolId`、当时未 abort；每一步只有一次 hook。第三次 read 才因两工具上限被阻止。三次 provider transcript 的工具集合始终包含 `edit,read`。这排除了路径斜杠比较、read 后 edit schema 消失、重复 edit hook 被错误计数及 read-first 追踪的解释。

[重放测试](../../tests/first-turn-smoke-replay.test.ts) 保存完整 provider transcript、tool results、guard/meta 和 groundtruth。候选 5/5 通过诊断断言，baseline 的前四项 4/4。真实 Runtime 场景显式 production，禁止 global fetch；不手写 host、不旁路 native 权限检查，仅使用临时项目的 full-access Runtime 设置。三步 scripted provider 有硬上限，第三步结束文案明确标记为重放终点。

## 验证口径修正

先前 HTTP/SSE × SA/AMA 的四项 E2E 是 **test-mode 低层 SDK 的协议/工具执行验证**；它们没有证明缺少 production host 的低层入口可以生产写入。新增 production Runtime 重放补上了这项链路验证，但不能证明真实模型在收到成功 edit 后一定会正确结束。真实 live smoke 保持失败状态，无额外模型重跑。

候选 API usage 的机械汇总与主会话行为盲审是另一条证据链；不能因为本 harness 配置错误将其全部当作 prompt 回退，也不能用 A/B 正常掩盖 live groundtruth 失败。

## 证据与复跑

OS 隔离临时根：`C:\Users\ADMIN\AppData\Local\Temp\kodax-first-turn-isolated-f6d8495a-400f-42c4-b861-8b8b1b37e1cc`。

其 `kodax-eval-dumps/first-turn-tokens-v1` 保存：

- `live-sdk-smoke-r4.json` 及 failure JSON：失败原文。
- `zero-network-replay-candidate-{original,no-hook,no-visibility,test-fallback}.json`。
- `zero-network-replay-baseline-bd4479d-{original,no-hook,no-visibility,test-fallback}.json`。
- `zero-network-runtime-production-replay.json`：真实 Runtime host 成功重放。
- `mechanical-usage-summary.json`：主会话完成盲审后，22 条已保存 A/B 样本的 API input/output/cache/latency 技术汇总；不含新增语义评分。

所有 JSON（包含 main-session reviews、mapping、最新账本）已复制到同一隔离临时根下 `evidence-backup-a/complete-evidence-tree` 与 `evidence-backup-b/complete-evidence-tree`。不得在恢复时重置账本或将丢失历史 raw 视作可评审数据。

```powershell
$env:TEMP='C:\Users\ADMIN\AppData\Local\Temp\kodax-first-turn-isolated-f6d8495a-400f-42c4-b861-8b8b1b37e1cc'
$env:TMP=$env:TEMP
node node_modules/vitest/vitest.mjs run tests/first-turn-smoke-replay.test.ts --config vitest.config.ts
```

无需任何 API key 的真实值。测试使用本地占位凭据和脚本 provider，global fetch 一旦调用即报错。没有修改产品代码。

## 未来 harness 修正（未付费执行）

经主会话授权，`tests/first-turn-live-smoke.eval.ts` 已改用真正的 embedded `createKodaXRuntime`、项目 Session 和 full-access settings，再通过 `runtime.runs.start` 执行。它保留最多三次模型请求、每次 2048 output tokens、singleAttempt、两次工具上限、目标路径守卫、仅 read/edit 的工具可见性以及 180s 总 timeout；单请求再用 `AbortSignal.any` 合并总 abort 与独立 120s timeout，实际传给 backend stream。即使后续学习试图再次请求同一 wrapper，也会在三次硬上限处被阻止。新产物名称为 `live-sdk-smoke-runtime-v1`，不会覆盖旧 r4 失败记录。

这次只运行 gate=0 的预检及五项 production/零网络诊断测试，两个脚本的定向 `tsc --noEmit` 通过，没有新 live 调用，没有重置总账。未来修正的脚本不能被当作本轮 live 验收已通过。
