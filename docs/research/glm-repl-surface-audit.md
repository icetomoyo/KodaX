# GLM REPL 消费表面复核

核验日期：2026-09-14。基线：`795b8469`。范围为 G3、G4 和 G1 的 history/grants 次要项；只读生产源码，没有修改产品实现。以下为源码核验，未声称运行新的端到端测试。行号均相对此基线。

## 判定

| GLM 项目 | 当前判断 | 前轮状态 |
| --- | --- | --- |
| G3 prepare* 是产品 CLI 未接线的遗留路径 | 部分成立：该启动器确不注入，但产品路径已有替代；独立 REPL 可注入，不能整体判为死代码 | 前轮未删除，也不应仅凭 CLI 无调用删除 |
| G4 classic 与 Ink 的重连策略不同 | 成立，但限首次观察建立失败；不是所有重连路径都如此 | 前轮修了失效问题/观察关闭提示，未统一首次 attach 重试策略 |
| G4 未选 model 时状态栏无法显示 Host 默认值 | 不成立为一般持续缺口：Host 已解析，消费者也已应用；未知时显示占位 | 本轮之前的 `5aa4956c` 已有实现，`795b8469` 未新增此修复 |
| G1 sessions.searchHistory 没有 REPL 接线 | 成立；但“只能搜当前有限条目”不成立，打开搜索会主动加载全部保存历史再本地搜索 | 前轮未新增服务器搜索入口；已有全历史读取入口 |
| G1 permissions.listGrants/revokeGrant 没有 REPL UI | 成立，是尚未提供的管理入口；不能以契约存在声称 UI 已覆盖 | 前轮未处理 |

## G3：保留独立包的可注入能力

`src/kodax_cli.ts:4914` 的 interactiveOptions 没有 prepare*，但 `:4943`、`:4947`、`:4948` 分别注入 Product commands、review.start 和 agents.reviewLean。`packages/repl/src/commands/review-command.ts:300` 优先走 startReview；`:307` 之后才是可注入 prepareReview。`packages/repl/src/commands/agents-command.ts:192` 同理优先 reviewAgentsLean，`:199` 才是 prepareAgentsLean。`packages/repl/src/interactive/commands.ts:3248` 优先由 commandClient 执行扩展/提示词命令，`:3258` 是旧准备绑定分支。因此这些准备接口未加入产品契约，不等于上述产品功能不可用。

独立包在 `packages/repl/src/index.ts:17`、`:27`、`:34` 公开两种运行入口和 options；`ui/InkREPL.tsx:772` 与 `interactive/repl.ts:504` 的四项参数可以由包使用者注入，并分别在 `InkREPL.tsx:10113`、`interactive/repl.ts:1223` 传给命令层。Skill 准备的注入分支确实在 `interactive/user-skill-invocation.ts:141` 调用绑定，不是只有声明；`interactive/user-skill-invocation.test.ts:296`、`:307` 和 `interactive/commands-extension.test.ts:331` 有对应消费测试。`docs/features/v0.7.97.md:716` 明确 standalone 包保留既有能力。

建议：如果要减少遗留表面，应先确定独立 REPL 的 API 兼容承诺，再更新过时的“直到 fallback removal”注释（`commands/types.ts:300`），不能因单一 CLI 未注入就直接删除所有 prepare*。

## G4：重连有一个真实但应精确描述的差异

`interactive/repl.ts:845` 默认 attempt=0；`:883` 在失败后加一，`:884` 大于 5 即输出诊断并返回。所以是**首次尝试 + 5 次重试，共最多 6 次**，退避总计约 15 秒（不含请求耗时）。失败后不再定时尝试；切换 Session 等再次调用 attach 才有机会恢复。Ink `ui/InkREPL.tsx:1866` 对首次 observe promise 的失败无限退避，上限每 5 秒重试一次。该差异仍然存在，前轮仅修了 `interactive/classic-plane-display.ts:202` 的观察关闭后问题中止及不可用通知。

但成功 attach 以后的 daemon 断线重开是共同下层：`src/runtime-daemon/client.ts:1717` 重新订阅，`:1742` 在三次重开失败后关闭 observation。Ink 的 `:1859` onStatus 仅更新显示，不能据其首次 attach catch 认定所有情况都无限恢复。若以后修复，应区分首次 attach、可重连传输中断、永久 observation 关闭，避免把 Host 的明确永久不可用状态做成无限空转。

## G4：Host 默认模型已有闭环

`src/sdk-runtime.ts:12561` 用 Session model、默认 model、provider.getModel() 依次解析，`:12571` 写入 contextBudget；Session view 在 `:4422` 包含该字段。REPL 的 `ui/client-session-settings.ts:14`、`:17` 从 settings 或 contextBudget 获取 provider/model，Ink 在 `ui/InkREPL.tsx:5825`、`:5833` 应用它。已有测试 `ui/client-session-settings.test.ts:31` 明确覆盖 Host 默认值，并验证未知新 provider 保持 model 未知。

因此 `ui/InkREPL.tsx:4524` 的 `—` 是尚未收到可用 Host 信息或 Host 解析失败时的占位，不能只引用这一行断言未选模型始终不显示默认值。该实现最后修改于 `5aa4956c`，早于前轮提交。

## G1：搜索与授权管理应分别定性

**服务器搜索未接线，但完整历史 UI 已存在。** `packages/coding/src/client-contract.ts:124` 提供 searchHistory，`src/client-runtime-adapter.ts:50` 委托 Host；整个 `packages/repl` 无 searchHistory 调用，`InkClientPlane` 也未声明该搜索操作。当前搜索在 `ui/InkREPL.tsx:4301` 对 rawTranscriptDisplayItems 建本地索引，`:4308` 搜索它。

但 UI 在 `ui/InkREPL.tsx:5149` 有 loadCompleteTranscriptSnapshot，`:5160` 调用 `readClientPlaneHistory`，`:5176` 将完整内容放入 transcript snapshot；打开搜索在 `:5505` 后 `:5511` **主动调用该完整历史加载**，显示全部历史开关 `:5643` 也会调用。`ui/client-plane.ts:193` 每页读取 100 项、`:213` 持续至 nextCursor 结束，并在 `:199` 读取超长条目的完整内容。因此缺的是**无需把全历史载入客户端的 Host 搜索入口/性能与结果分页能力**，不应概括成用户永远不能查找当前短窗口以外内容。

**持久授权管理 UI 确实缺失。** `packages/coding/src/client-contract.ts:188`、`:190` 和 `src/client-runtime-adapter.ts:161`、`:172` 提供 listGrants/revokeGrant，现有 REPL 与 CLI 消费代码没有对这些方法的调用，也没有对应 grant 管理命令入口。审批对话和权限模式选择不等于列出、撤销历史授权；该项是有效的后续消费侧建设工作。这里只确认当前未接线，不将其未经比较地表述为主线回归。
