# rc.14 修复并入 v0.7.97 统一契约面的实施与验收

日期：2026-10-02，Windows / Node 22.23.1 / npm 10.9.8。

本次把 `origin/KodaX` 的 `cad8b658797976ce22a4bd70c60d2251d537e542`
合入 `codex/product-client-refactor`。改造前固定点是
`a63feede5f4b2bac8a62ddfa687d9b515d8c2021`，整合策略在
[融合方案](mainline-unified-contract-integration-2026-10-02.md)。
主线临时版本修复服从当前分支的 **v0.7.97 / FEATURE_298** 设计；
源码包基线吸收为 `0.7.96-rc.14`，没有宣告 v0.7.97 已发布。

## 最终实现

- 保留单一 Product Host、纯 Client 契约和原有 Session queue、MCP、
  Interaction、sessionControl、command、workflow 接缝。没有回接 REPL
  runtimeRunner、持久 Runtime event journal/replay 或 event→status 修补。
- 中断证据从已保存的 Session、active lineage、Run status、uiHistory
  checkpoint 派生。每次先 flush 再读；只选择同会话最近五个非 completed
  终态，按现有 Host Run 记录筛选并逐 ID 读取，避免每次启动重扫 Run 目录。
  按真实 inputId/turnId 过滤分支，以 outputId 排除正式正文。
- checkpoint 显式保留 sourceRunId/sourceTurnId、assistantOutputId、
  executionBegan/resultRecorded。权限提议不是已执行效果，未知结果不是已取消。
  SA/AMA 恢复说明最多 6,000 字符，只进入瞬态上下文，保存前剥离。
- 重复 provider callId 以所属 assistant output 区分，贯通实时项、checkpoint、
  恢复、canonical 配对、历史及 notice。离窗全文读取定位所属 output 和相邻
  canonical 结果；保留含 `:tool:` 的 opaque callId，不借用另一调用的结果。
- Shell cleanup 无法确认时保留注册身份和 unknown，释放执行占用让下一轮继续。
  重启和 Host close 按原身份再次尝试回收；已落盘的 terminal 不被清理改写。
  Client 的 Run read/await 公开 terminal.effectOutcome 与 Stop 事实。
- 保留主线 Provider/native/旧历史修复和消息提交边界保存。缓存 schema 为 v10，
  同时保留本分支 sourceKeys 和主线旧工具配对、压缩截断修复。
- 发布主线 Issues 340–344 保留；worktree 同号的五项迁为 348–352，
  345–347 不变。测试指南和活跃引用同步；ledger 保留双方问题与证据。
- `docs/features` 在独立子模块里真正合并双方历史，保留 T38–T56 Done；
  v0.7.97 头部不再把已实施工作标为 Planned。

## 验证

自动验收分为全量分层测试、冻结源码后的复验和构建产物验收。最终生产源码与
双轴复审候选 `f1bb8eb87b7f367c56a799847b77224baab90a0e` 一致；下列结果不是
跨平台发布声明。

| 门禁 | 结果 |
|---|---|
| `npm run build`，最终重建 | PASS；14 个 SDK 声明入口，纯 Client 无需 Node ambient types |
| `npm run typecheck`，最终源码 | PASS；源码与测试类型检查 |
| `npm run test:fast`，冻结源码后复验 | 218 文件通过、1 跳过；2,202 项通过、32 跳过 |
| `npm run test:unit`，全量序列 | 740 文件通过；12,017 项通过、3 跳过 |
| `npm run test:contract`，全量序列 | 117 文件通过；960 项通过、21 todo |
| `npm run test:system` 与 daemon 文件复验 | 74 文件全量通过；daemon 文件最终 25/25 通过，合计覆盖 75 文件、1,341 项通过、42 跳过 |
| 构建后 `node --test --test-concurrency=1`，`test:bundle` 九个文件 | 39/39 通过；Provider、daemon、Memory、权限、图像、文本恢复、ASRT WFP 与发布归档 |
| 构建后 `node tests/repl-pty-acceptance.mjs` | 50 场景通过；Ink 30、classic 20，包括停止、排队、扩展、退出及恢复 |
| 构建后 `node tests/repl-history-browse-acceptance.mjs` | PASS；默认 250 工具、重复调用 ID、实时/完成滚动、浏览与活动同步、退出和独立 Host 清理 |

原全量序列的 system 命令有三项 `launcherBuild` 失败：长运行的 daemon 测试进程
加载了复审修复前的源码，启动保护检查发现磁盘源码指纹已经变化。冻结源码并完成
最终重建后，整个 `src/kodax_cli.daemon-smoke.test.ts` 文件复验 25/25 通过。
因此这里记录全量结果及该文件复验，没有把原 `npm run test:full` 的退出码写成成功。

- 新增确定性 RED→GREEN 回归，覆盖 checkpoint 来源/执行边界、重复 callId
  覆盖、deferred 重启及关闭回收、Run await 的 unknown 事实。
- 真实 Product Client IPC：SA/AMA 流式中断、detach、Host 重启、下一轮恢复，
  没有自动重跑模型或将恢复说明写入正式历史。
- 真实工具调用使用同一个 `reused:tool:suffix`，验证不同输出的正文/参数及
  重启后的身份。随后给这段真实历史追加 160 条 fixture canonical 消息、移除
  工具 checkpoint；确认工具已离开 150 项窗口，旧引用仍读取各自全文。
- 恢复模块专项覆盖率：statements 97.4%、branches 89.44%、functions 97.82%、
  lines 99.33%。范围为新 Host 证据派生器和 coding 恢复说明渲染器，非全仓覆盖率。

整合中发现并修复了旧 event-journal 测试接缝、v9 缓存断言、异步执行/终端反馈
fixture、提前 checkpoint 的读写边界，以及每 Run 重扫索引的性能回退。
真实 owner-kill fixture 先完成无关后台 Session 写入，再注入未完成 Run 并杀掉 owner，
不把死进程遗留的无关文件锁当作 Shell 恢复结论。没有放宽产品超时或跳过失败用例。

## Standards

PASS。最终源码候选 `f1bb8eb87b7f367c56a799847b77224baab90a0e`：
原生 outputId 与 opaque callId 的解析边界明确；checkpoint、历史、全文读取保持
复合身份，包边界不变。deferred 清理保留诊断及权威 terminal，恢复不重扫索引。
已关闭此前含 `:tool:` 的调用 ID 误解析问题。

Standards：finding 0；最高等级：无。

## Spec

PASS。同一候选保持 FEATURE_298 Host 身份范围：SA/AMA 原生 outputId 均为
`output_<UUID>`，Client 无需解析身份。重复调用、重启、离窗全文回源以及此前
checkpoint 覆盖、deferred 回收、索引重扫问题均已关闭；无新的缺失或越界。

Spec：finding 0；最高等级：无。

## 验收边界

本次没有执行付费模型 eval，没有代替 Linux/macOS native 与跨平台人工验收。
主线 Open issue 仍保留原状态。未成功 checkpoint 的 token 不在崩溃恢复保证中。
本次为本地整合，根仓库和设计子模块提交均未推送；发布另行安排。

设计子模块最终固定点：`22f1c3561d24b225f057edebb25f6325e362b8e8`。
其历史保留真正的双亲融合提交 `e2e9645`，包含主线设计固定点
`664d8ba0365776b15764e33da8e47a65ee2366ae` 和本分支原有 v0.7.97 设计。
