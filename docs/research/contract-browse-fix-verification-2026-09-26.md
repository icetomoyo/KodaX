# Product Client 与普通历史浏览修复验收

日期：2026-09-26。修复基线 `6e5d6298`，已合入主分支 `c447c0f3`。
本文对应[审计反例](product-contract-assurance-2026-09-26.md)及[修复方案](contract-browse-repair-plan-2026-09-26.md)。

## 设计与实现

不能把之前的失败都归因于终端。审计确认了五项共享实现缺陷，另有普通 TUI 错把有界实时视图当成完整浏览历史。修复保留 Host 事实所有权和原有分层，没有增加全局事件日志、通用状态机或无限客户端历史缓存。

| 反例 | 修复 | 主要回归证据 |
| --- | --- | --- |
| F01 大正文分块读取失败 | 每块 base64 解码成字节，拼接后统一解码 UTF-8/JSON | `sdk-client.history-boundaries.test.ts`：256 KiB 上下、跨块中英/emoji、page/item/search |
| F02 单消息 160 块被截为 150 | 规范历史使用完整恢复范围；实时窗口默认不变；保留已有输出来源字段 | 同上逐块原文与工具参数；`restore-history.test.ts` 默认窗口对照 |
| F03 用户项移出视图后不能补读 | 有 inputId 的用户项使用稳定来源身份，canonical 回源；legacy 不借用新身份 | `sdk-client.input-read-source.test.ts`：同文不同身份、混合旧历史、追加/压缩/rewind |
| F04 创建失败遗留 MCP 资源 | 资源取得即归属；区分新建与已有 sidecar，失败回滚并报告双重错误 | `sdk-client.mcp-create-rollback.test.ts`：真实子进程及故障注入 |
| F05 工作流默认权限与界面不一致 | 产品工作流明确选择产品默认值，首次执行及动态设置共用规则 | `sdk-client.workflow-product-settings.test.ts`：真实 IPC 实际写入、低层对照、旧 Host 拒绝 |
| Issue 342 普通界面早期内容不可达 | 向上操作触发已有历史接口；有界双向页窗和来源/字符锚点；仅冻结正文 | browse helper/hook、真实渲染器及 `repl-history-browse-acceptance.mjs` |

`KodaXProductClient` 不增加方法或调用参数。必要的底层工作流参数 `settingsDefaults: 'product'` 通过 `workflowSettingsDefaults.version=1` 协商；旧 Host 明确返回升级错误，未选择产品语义的底层调用保留旧默认。

同时补齐底层事件订阅在握手前关闭、远端释放失败时的既有诊断；不再静默吞掉错误。`client-event-cleanup.test.ts` 对照握手前后两条路径。

TUI 的滚轮与 SDK 的读取不是同一个操作：共享契约保证事实和读取语义，TUI 自己负责把历史读取接到滚轮。其他 UI 消费者同样不能把 `observe` 的有界窗口解释为全部历史。

## 防回归方式

- 公共 Client + 真实 named-pipe Host 验证跨适配器语义，不仅测试内部 helper。
- 对原始滚动症状保留两种真实 PTY 场景：160 个独立工具；100 个独立工具加 150 个重复工具、长 thinking、短回答。
- 验证等待真实 Run 终态；浏览期间活动和输入实时更新，End 后最终答案存在。
- 在有界页窗逐出页面后验证顺序向下恢复；验证过期 revision、迟到响应、会话/界面切换、超大正文范围和 resize。
- 失败先保留显示并提示；不猜来源、不跨 revision 拼接、不无限重试。
- 复现先失败，最小实现后通过；最终变更由独立 Standards/Spec 双轴复核。

新增相邻 Vitest 测试被现有 Fast/Unit/Contract/System 分类收集，现有 CI 已运行这些层。PTY 脚本保留为可重复的终端验收命令，未声称已经加入 CI；发布前按回归指南执行。

## Standards

最终独立复核无可行动发现。检查范围包含后端变更、双向 cursor 上限、正文范围检查、UTF-16 映射、实时控制绑定及 PTY 脚本。先前发现的长单行偏移二次复杂度已改为线性处理。

本轴剩余 finding：0；无剩余严重项。

## Spec

最终独立复核未发现阻断项。此前两个 P2 已修复：超大正文尾部不会错切头部预览；长用户正文 resize 按字符位置恢复。状态条与活动条使用实时状态，页窗按来源和 revision 恢复。复核 Agent 独立运行相关 15 项测试通过；实际终端结果另列。

本轴剩余 finding：0；无剩余严重项。

## 验证结果

最终结果如下。生产文件在完整构建前冻结；之后只完善验收脚本和文档。

| 检查 | 结果 |
| --- | --- |
| 完整 TypeScript 检查 | 通过（src + tests） |
| 完整构建 | 通过（packages、native、bundle、自包含 SDK d.ts） |
| 发行包测试 | 39/39 通过 |
| Contract 广套 | 117 文件，954 通过、21 todo |
| Unit 首次广套 | 733 文件；11929 通过、2 失败、3 跳过，失败处置见下 |
| 首次 Unit 失败文件及 hook 复查 | 3 文件，26/26 通过 |
| Fast 广套 | 216 文件；2185 通过、2 超时、32 跳过；超时项串行复查通过 |
| System 广套 | 74 文件；1326 通过、2 超时、42 跳过；超时项串行复查通过 |
| 四项超时串行复查 | 4/4 通过；未修改产品代码或放宽超时阈值 |
| UI 定向 | 162/162 通过；独立 Spec 复查相关 15/15 通过（重叠，不相加） |
| 源码/构建原始症状 PTY | 4/4 场景通过，含实际 Run 完成及 CLI 正常退出 |
| 构建双向 PTY | 2/2 通过，验证中间工具及回到最新内容 |
| 既有完整 PTY | 48/48 通过（Ink + classic），进程退出 0 |
| Issue tracker 一致性 | 4/4 通过 |

Unit 首次广套恰好读取到还在修复的双向工具锚点用例，修复后通过；另一项是旧 OAuth fixture 的随机端口触发 Node `bad port`，未改动 OAuth 产品代码，单独重跑 11/11 通过。随后三文件合跑 26/26 通过。为降低进程和 I/O 争用，第二次重复 Unit 广套主动中断，不作为通过结果。

Fast/System 曾与其他大套并发，且该次 System 使用两个 worker，偏离仓库默认串行配置。四项超时分别是 Session 大列表、Host 能力探测、A2A 启动和本机历史 corpus 顺序读取。其他大套结束后 `--maxWorkers=1` 复查均通过，耗时约 9.2s / 10.3s / 21.7s / 1.8s，原时限分别为 45s / 30s / 内部健康检查 30s / 30s。资源争用符合观察，但不把单独通过写成广套首次全绿。今后按 CI 的顺序执行四层，System 保持单 worker。

PTY 原始症状的源码目录：`mrRsiP`（折叠）、`Jt2Qja`（独立）；bundle：`545TVh`、`gU7aWd`。双向增强目录：`1F2DXy`、`C3Re3M`。均位于本机 `%TEMP%/kodax-repl-acceptance-<后缀>`，保存 ANSI、屏幕及 JSON。测试脚本曾在 End 后多按 Ctrl+O/q，误重新进入 Transcript 或写入草稿；该退出序列已修正。node-pty Windows helper 的保活处理与既有主 PTY 脚本相同，在全部断言、CLI 退出和 Host 清理完成后结束 harness 进程。

既有完整 PTY 目录为 `MKT5td`，覆盖 48 项启动、设置、流式输出、审批/提问、队列、滚动/草稿、Stop、下一输入、隔离、恢复及退出检查。

批量日志位于 `%TEMP%/kodax-contract-browse-{build,typecheck,contract,unit,recheck,fast,system,timeout-recheck,bundle,tracker}.log`；终端命令与手动鼠标检查见[回归指南](../test-guides/ISSUE_340_v0.7.96-rc.11_REGRESSION_GUIDE.md#repair-acceptance-2026-09-26)。`git diff --check` 通过。工作区既有 `Microsoft/` 和 `test_stat.txt` 未修改。

## 明确边界

- 历史追加会使旧 cursor 失效，保留现屏并提示刷新；不承诺任意旧 revision 永久可读或持续写入时无缝翻页。
- 普通浏览最多 4 页、800 项、200 万字符及 128 个新页 cursor；锚点补读最多 100 万字符。超大正文范围无法定位时保留原屏，可用既有 Transcript 全文读取。
- 无 inputId 的旧用户项不新增跨升级身份承诺。跨读取面的显示 ID 仍不可互换。
- 自动 PTY 使用 SGR/PgUp 输入，不能代替物理 Windows Terminal 鼠标测试。
- 原 Session 曾经未持久化的回答尾部无法由此次显示修复恢复。本次不改动原 Session，也不调用付费 Provider。
