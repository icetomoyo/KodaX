# SDK 统一 Client 契约迁移指南

适用范围：当前工作树的 FEATURE_298/299 实现；包版本仍为 `0.7.96-rc.14`，设计目标为 `v0.7.97`。本文不表示 npm 已发布这些变更。接入前应核对所安装包的导出和 Host 能力。

## 1. 替换范围与文档权威

TUI、桌面 UI、IDE、自动化应用接入共享 KodaX 时，以 `KodaXProductClient` 为业务契约。入口是 `@kodax-ai/kodax/client`；[完整行为契约](CLIENT_CONTRACT.md)与[类型定义](../packages/coding/src/client-contract.ts)共同说明方法、数据和错误语义。[英文接入指南](../public_docs/sdk/embedder-guide.md#product-client-integration)提供最小生命周期示例。

这不是对旧 Runtime 对象的重命名：提交输入、执行结算、交互、显示和持久历史现在各有明确边界。不要对旧对象做类型断言来假装它实现了 `KodaXProductClient`。

| 接入目的 | 当前入口 | 迁移要求 |
| --- | --- | --- |
| 产品 UI / 共享 Session / 自动化应用 | `/client` 的 `ensureKodaXClient`、`connectKodaXClient` | 默认采用统一契约；执行、配置与存储归 Host |
| 浏览器侧类型、自己的 UI 适配器 | `@kodax-ai/coding/client-contract` 的 `import type`，或 `/client` 的类型导出 | 纯类型可用；Node 连接器不能直接在浏览器运行 |
| 受信任 Host 的启动、凭据桥、Host Tools、诊断或嵌入 | `/runtime` | 仍是独立的底层接缝；不属于产品 Client 的全部承诺 |
| 独立 Agent/LLM/coding 库 | `/agent`、`/llm`、`/coding` 等 | 保留独立使用；旧 `KodaXClient`/`Client` 是另一种执行对象，不等于 `KodaXProductClient` |

根入口和上述底层导出尚未全部删除，也没有因为本次迁移就全部成为 TypeScript `@deprecated`。产品接入应迁走它们承担的业务职责；确需底层能力的受信任宿主仍可明确使用。客户端不能在连接失败时创建私有 Runtime，形成第二个 Session 写入者。

## 2. 旧调用如何迁移

下表按调用目的映射，参数和返回值不保证一对一兼容。

| 原有用法 | 统一契约用法 | 必须调整的行为 |
| --- | --- | --- |
| `createKodaXRuntime({mode:'daemon'})` 作为 UI 入口 | `ensureKodaXClient(options)` | 启动/升级交给统一启动器；返回产品 Client |
| `connectKodaXRuntime(...)` | `connectKodaXClient(...)` | 被动连接；`daemonToken` 对应产品选项 `token`，`endpoint` 只接受本地 pipe/socket |
| `runKodaX`、旧 `KodaXClient`、`runtime.runs.start` 提交用户请求 | `sessions.create/read` → `inputs.submit` → `runs.await` | 每个意图有 `inputId`；接收回执不是完成结果 |
| 调用时传 provider/model/effort 等执行选择 | `sessions.updateSettings` 或 versioned CAS | 设置是共享 Session 事实，影响下一次物理请求；不是任意 Run 私有 options |
| 客户端 pending 队列、`submitInput` 的旧 delivery | `inputs.submit/read/withdraw` | 使用 `immediate/after_turn/steer/redirect`；不要直接照搬旧 `interrupt` 字面量 |
| `onTextDelta/onTool*/onComplete`、`runtime.events.subscribe` 拼 UI 状态 | `sessions.observe` | 每次回调是完整当前 view 的替换；不用 delta 拼第二套运行权威 |
| `handle.result`、`onComplete` 或 spinner 停止判定结束 | `runs.await(runId)` / `runs.read(runId)` | 保留 `phase` 和 `error`；`unknown` 不是成功 |
| 仅调用 `runs.abort` 实现整个 Session 的 Stop | `sessions.cancel({sessionId, expectedRunId, requestId})` | 按 Host 的 Session 顺序边界停止；单 Run 停止用 `runs.stop` |
| permission/AskUser 回调或客户端创建权限请求 | `view.interactions` / `interactions.list` → `interactions.respond` | 只回答 Host 已创建的精确 requestId；授权 suggestionId 原样回传 |
| `SessionStorage`、`/session` 文件读写、`uiHistory` 拼接 | `sessions.*`、`readHistory/readHistoryEntry/searchHistory` | 客户端不直接访问活动 Host 的文件；历史与显示引用不混用 |
| 复制屏幕预览或对显示数组不断追加 | `readItem` 补读显示项；`readHistoryEntry` 补读历史/搜索项 | 正文分页校验 ID、偏移、长度与版本；显示窗口不是完整历史 |
| 本地追加 `/model` 等命令提示 | `sessions.appendNotice` | 通知由 Host 保存，属于 client-only 内容；失败要显示，不能重跑原命令 |
| 读写本地 config/MCP JSON；UI 创建 `McpManager` | `config.*`、`mcp.*`、`catalog.*` | Host 负责文件和连接；模型能力 probe 是显式、可能计费的动作 |
| 客户端展开 Skill、执行 command hooks、准备 review | `inputs.submit` 原始 Skill 输入；`commands.execute`、`review.start`、`agents.reviewLean` | 可信准备和执行归 Host；`commands.readPrompt` 仅返回可编辑文本 |
| UI 持有 workflow 模块或独立 memory/learning owner | `workflows.*`、`memory.forProject`、`learning.*` | 提交声明式意图；订阅故障和 Run 终态分开处理 |
| 客户端维护 Agent 注册或 mailbox 状态 | `registrations.*`、`agents.*` | 使用领域 ID、revision 和实际事件，不按 UI 缓存推断完成 |
| `runtime.close()` 或旧 Client dispose | `observation.close()`、`client.disconnect()` | 都不会停止共享 Run；正常关闭空闲 Host 需显式 `host.shutdown()` |

没有产品等价项的底层能力不能自动提升为产品承诺。例如凭据 lease、Host Tool bridge、原始 Runtime events 和特定诊断继续由受信任宿主明确接入 `/runtime`。产品 `mcp` 也不承诺旧 `McpManager` 的所有 start/stop/catalog 方法；先核对实际类型，不在 UI 中创建第二套执行连接来补齐。

## 3. 输入、队列与结果恢复

调用者保存 `sessionId`、`inputId`、原始正文和附件，再提交。输入 ID 应使用稳定生成的唯一值；一次响应丢失不能通过生成新 ID 自动重发。

- `submitted`：已进入会话上下文，不证明 Provider 已接收；用返回的 `runId` 跟随执行。
- `queued`：尚待交付。通过 `inputs.read(sessionId, inputId)` 逐项确认；多条输入可能合批为同一 Run。
- `withdrawn`：已撤回；只有 `withdraw` 的完整返回内容适合重新放回编辑器。
- `dropped`：目标 Run 已结束且未交付；明确再次提交时使用新 ID。

`after_turn` 可在当前 Run 的下一次模型请求前交付，并非必定等整个任务结束。`steer/redirect` 需要 `targetRunId`；steer 的等待不等于可撤回队列。Stop/失败也不表示 Host 自动清空所有待发送输入。

同一个 Host 上丢失提交响应时查询原 `inputId`；已知 `runId` 时查询/等待原 Run。新 Host 不承诺继承旧 Host 的输入接收身份；查不到记录不能证明副作用未发生。命令、review、compact、memory 修改等丢失响应，也不能透明重放。

## 4. 观察、历史与完整正文

`sessions.observe` 先给完整当前 view，后续仍是替换。`view.items` 有界，`view.runs` 也不是全量 Run 日志。显示层保持 Host 顺序，按项 ID 更新；不能用相同正文去重不同输入，不能把 `outputId` 当作唯一块 ID。

| 要读取的内容 | 入口与身份 |
| --- | --- |
| 当前屏幕 | `observe` 返回的 `ClientSessionView` |
| 显示项全文/工具参数 | `readItem(sessionId, viewItem.id, {part, offset})` |
| 较早的规范对话 | `readHistory(sessionId, {cursor})`，首次为最新页 |
| 历史页或搜索结果全文 | `readHistoryEntry(sessionId, historyItemId, {part, offset})` |
| 全 Session 搜索 | `searchHistory`，使用命中 itemId 读取正文 |

页内从旧到新，页间 `nextCursor` 指向更旧页。一次组合读取必须保持同一 revision；修订失效就重新读取，不能拼接不同版本。正文偏移单位为 UTF-16 字符单元；沿 `nextOffset` 读取，`null`、无进展、版本变化和不连续都应报告失败。

当前 view 最多 150 项且有正文预览预算。完整历史和离窗 canonical 项回源不裁剪单消息内部的内容块。冻结浏览应保存项身份、所见长度和版本；不能据此承诺任意并发替换时可恢复过去所有内容。

普通 Ink 浏览的 15 秒等待上限是该 UI 的恢复策略，不是所有 SDK 请求的通用超时。其他消费者需要设计自己的等待/退出体验；不能误以为取消客户端等待就取消了已提交 Run 或 Host RPC。

## 5. 交互与 Stop

交互 UI 展示 Host 请求并提交匹配 kind 的回答。权限扩展只使用该请求给出的 `grantSuggestions`；Plan 审批显示完整 `options.plan`，不用参数预览冒充计划。人工取消问题使用 `{kind:'cancel'}`，不等同于停止 Run。重复、过期或已解决请求的 `accepted:false` 应按结果处理。

```ts
import type { KodaXProductClient, ClientInteraction } from '@kodax-ai/kodax/client';

// Call only after the user chooses to reject this displayed permission request.
export async function rejectPermission(client: KodaXProductClient, request: ClientInteraction) {
  if (request.kind !== 'permission') throw new Error('Expected a permission request');
  return client.interactions.respond(request.requestId, {
    kind: 'permission', decision: { type: 'reject', reason: 'Rejected by the user' },
  });
}
```

Session Stop 的 `expectedRunId` 来自用户点击时观察的 Run，`requestId` 在发出请求前生成并保留。过期 Run 冲突应刷新 UI，不把旧点击自动改投新 Run。Stop 回执的接收状态不代表已结束；继续观察并通过 `runs.await` 确认各 Run 的真实结果。

## 6. 设置、能力与订阅

`getSettings` 是原始 Session 覆盖，`view.settings` 是 Host 解析的有效设置；`config.read` 是已保存默认值，`config.readEffective` 是有效执行配置。patch 的缺省字段保持不变，支持的 `null` 清除覆盖。并发编辑使用 `getSettingsVersioned/updateSettingsVersioned` 的 revision；临时覆盖结束后不能无条件恢复旧值覆盖其他客户端的新设置。

`ensureKodaXClient` 可启动/正常更新本地空闲 Host；`connectKodaXClient` 不启动或替换它。两者要求 `productClient` v1，具体新增领域能力仍可能要求额外握手支持（如 `subscriptionLifecycle`、`workflowSettingsDefaults`、`planModeEffort` 设置键）。缺失时明确报错，不能静默降级。

Session 观察通过 `onStatus` 区分 live/interrupted/closed；重连中的提示由应用自身管理，不存在公共 `reconnecting` 状态。Workflow/Learning 订阅的 `ready` 仅代表注册成功；重新订阅后等待 ready，再读取快照，读取期间通知作为再次刷新信号。断连恢复不重放业务 mutation，Run 的 `unknown` 结算也不等于网络断连。

## 7. 已移除与仍保留的能力

本分支移除了通用 operation envelope/receipt、持久事件 journal/replay、旧 exit-settlement/rollback 协议和 Worker-hosted embedded Runtime。它们的迁移明细见[移除表](../public_docs/sdk/embedder-guide.md#migrating-to-v0797)。不能继续依赖旧 event cursor 跨重启续传，或把断连自动重发解释成恰好一次。

独立 coding/Agent/LLM 库、显式 inline embedded Runtime、daemon、构造工具 handler worker、语义分析 worker 等并未因此全部退役。历史 ADR/feature 文档描述的是当时决策；当前产品行为以本迁移指南、Client 契约和实现为准。版本号相同也可能加载了不同源码/构建，升级后需要重新加载 SDK 进程；启动器不会强停忙碌 Host。

## 8. 接入验收

迁移完成至少验证以下行为，而不只验证 TypeScript 能编译：

1. 两个 Client 看到同一 Session 设置、交互与执行事实；断开一个 Client 不停止另一方的工作。
2. 提交后保留输入身份；排队、撤回、steer/redirect、Stop 和迟到回答使用各自回执，不丢失或重复输入。
3. 对 completed/failed/interrupted/unknown 和传输拒绝分别显示；重新连接不重复启动任务。
4. 多轮、多工具、长正文和同文不同输入跨显示窗口后仍能准确读取；分页修订变化有可见恢复路径。
5. 命令通知经 Host 后仍可见且不进入模型上下文；失败只报告，不重跑有副作用命令。
6. Learning/Workflow 订阅注册失败、运行中故障、主动关闭和重连，均不会假报 Run 完成。
7. 产品消费者不持有 SessionStorage、可执行 Runtime 对象或客户端 MCP owner；底层宿主代码单独标明职责。

仓库现有验证入口：`src/sdk-client*.test.ts`、`src/session-view*.test.ts`、`tests/repl-pty-acceptance.mjs`、`tests/repl-history-browse-acceptance.mjs`。具体回归记录见[Issues 345–347 and 352 验证指南](test-guides/ISSUE_352_v0.7.96_REGRESSION_GUIDE.md)。这些测试不证明所有外部应用已经迁移。
