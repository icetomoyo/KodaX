# 统一产品契约对照审计：输出、恢复与消费者一致性

日期：2026-09-24。审查快照：`fa2db204`；主线固定点：`c447c0f3`。
比较范围为 `git diff c447c0f3...fa2db204`：226 个提交、441 个文件。
本轮只审计并记录，未修改产品实现、用户 Session 或正在运行的 Host。

## 判断

**确认还有同类错误：9 项 P2 实现问题，另有 1 项需要补清楚的订阅生命周期契约。**
上一轮 `fa2db204` 修复的历史排序仍有无共同锚点的分页遗漏，不能宣称这类问题已经清零。

目前证据支持保留“单一 Host、Client 提交意图并读取事实”的设计方向。上述 9 项均能对应到
已经写明的产品要求：保留原文、按身份和 Host 顺序显示、首次有效答案才消费、Host 共享设置
为权威、失败需要传播。它们主要是实现没有守住这些边界，而非需求要求丢内容或静默结束。

实现层有共同原因：旧 REPL 的显示转换仍进入 Host 的正文与历史投影，多个读取面又各自修补
状态和全文规则；部分消费者仍把本地缓存写回 Host；异步失败仅通知当时的等待者。接口名称
统一，并未让这些行为自动一致。修复应收敛已有投影、校验和生命周期逻辑，不需要再建事件
重放系统、第二份 Session 存储或新的全局运行状态机。

## 设计依据与覆盖

- 产品规格：`docs/features/v0.7.97.md`，尤其 §3.2 四类事实、§3.4 观察/历史、§3.6 交互、
  T04/T05/T17–T20/T23/T53–T56，以及能力和体验不得退步的约束。
- 对外契约：`docs/CLIENT_CONTRACT.md`，身份与事实权威、全文读取、错误与重连、计划批准。
- 规范：`AGENTS.md`、`CONTRIBUTING.md` 和 code-review 的 12 项 smell 基线。
- 来源通过分支提交中的 T01–T56 引用定位；旧审计只用作线索，未把旧结论直接当作本次证据。

| 边界 | 本轮核对方式 | 结果与限制 |
| --- | --- | --- |
| canonical → Host view / readItem / history | 生产投影函数及 SessionViewOwner 隔离探针；实际 conversation 分页缓存 | 确认 F01–F05 |
| Host 交互接收 | 隔离真实 Runtime、随机 named pipe、Product Client、真实 ask_user_question 工具 | 确认 F06；不需要模型 |
| Learning 订阅 | 直接调用生产 daemon client，受控 transport 时序 | 确认 F07；不是完整断网 IPC 实验 |
| ACP → Host 设置与批准 | 生产方法级探针，受控 Product seam | 确认 F08–F09；未启动外部 ACP 编辑器 |
| Run / queue / steer / redirect / 配置治理 | 设计、差异与生产调用链核对 | 未确认新增问题；不等于完成所有竞态穷举 |
| Ink / classic / one-shot / A2A | 消费路径、全文拼接、终态和主线对照 | Standards 发现分页校验重复；A2A 另有主线既有问题 |
| 普通模式滚动 | 沿用上轮原会话副本 PTY 证据 | 仍未独立复现 Issue 342；不随输出修复标为解决 |

没有逐行精读全部 441 个文件，没有重跑完整测试集合，没有跨平台真机或真实模型验证。
上轮的 383 项测试与 48 项 PTY 通过记录仍有效，但它们不能覆盖本轮新复现的边界。
本轮探针没有调用真实模型，也未读取或修改用户原始 Session；临时 Runtime/连接均在结束时释放。
真实分页探针缓存保留在 `%TEMP%/kodax-independent-probe-WPK008`。自动审批拒绝了递归清理，
仅返回 `blocked by policy`；未尝试绕过。该缓存只含合成测试数据。

## Spec

以下按历史/正文、Host 领域、消费者三组保留检查顺序；全部为当前快照仍存在的实现问题。

### F01 — P2：恢复后的工具预览被当成全文

- **位置**：`src/session-view.ts:772–789`；`packages/repl/src/ui/utils/message-utils.ts:167–177`；
  `packages/repl/src/ui/utils/tool-sanitizer.ts:3–18`。
- **要求**：CLIENT_CONTRACT §全文读取规则：“不能把部分原文当全文”；工具参数补读不能把
  预览重解析成原始参数。FEATURE_298 §3.4 要求显示有界、全文仍可读取。
- **复现**：没有 uiHistory 的 canonical 工具结果长 6010 字符，参数 JSON 长 3019；经真实
  `restoreSessionViewItems` → `SessionViewOwner.observe/readItem`，结果正文只有 2000，参数
  只有 2011；`totalLength` 也分别报告 2000/2011，没有剩余页。
- **原因**：Host 复用 REPL 的 2000 字符展示裁剪及参数清洗后，把该值存成 readItem 正文。
  有完整 checkpoint 的工具不一定受影响，canonical-only/旧会话恢复可触发。
- **归属与建议**：裁剪 helper 在主线已存在；新增 Host 全文接口继承了错误语义。应从
  canonical tool_use/tool_result 取得原文，只在 view 出站时裁剪，并保持完整长度和读取来源。

### F02 — P2：真实用户输入被正文关键词过滤

- **位置**：`src/session-view.ts:772` → `packages/repl/src/ui/utils/message-utils.ts:499–505`。
- **要求**：FEATURE_298 §3.4：“新身份数据不参与文本相等、trim 或相似度匹配”；
  CLIENT_CONTRACT §身份要求已接受输入以 inputId 关联。
- **复现**：带 `inputId` 的真实 user 正文为
  `Explain the string "You are the Generator role" in this source.`，恢复结果只剩 assistant
  回答，用户项消失。没有设置 `_synthetic` 或内部来源标记。
- **原因**：旧 worker prompt 启发式按正文 `includes` 删除消息，未区分已识别的用户输入。
- **归属与建议**：关键词规则是主线既有逻辑，但新增 Host 产品投影仍沿用它。对新数据按
  真实来源/合成标记判定内部消息，不能因为用户引用某个短语就隐藏输入；旧兼容单独约束。

### F03 — P2：已经结束的 checkpoint 写入失败从后续 flush/close 中消失

- **位置**：`src/session-view.ts:301–317,395–410`。
- **要求**：CLIENT_CONTRACT §身份、状态与事实权威：“保存失败会传递给调用者”；
  Session 读取、fork/recover 等等待同 Host 的显示保存。
- **复现**：用失败的 save seam 产生一次 checkpoint，等异步 reject 已结束，再调用
  `flush()` 和 `close()`，两者都 fulfilled。探针确认 save 执行一次并失败。
- **原因**：finally 清空 `state.persisting`，故障仅写诊断；只有当时已经等待该 Promise
  的调用者会收到失败。稍后调用者把“没有正在写”误当成“前次已成功”。
- **影响与建议**：取消后的部分输出可能没有 canonical 副本，调用者却无法得知保存失败。
  保留未处理保存故障，直到成功保存或明确处理；补“失败先结束、flush 后进入”的顺序回归。

### F04 — P2：长回答造成无共同锚点的分页，旧工具仍排在答案后

- **位置**：`packages/repl/src/ui/utils/restore-history.ts:414–426`；
  `src/sdk-runtime.ts:4356–4368`；`src/session-view.ts:772`。
- **要求**：CLIENT_CONTRACT §Session 视图：“canonical 历史与当前运行显示项合并后的
  有序、有界列表”；§全文读取要求旧恢复不能按正文/时间猜所属输入。
- **实际生产分页复现**：使用真实 `buildSessionConversationHistory`、conversation page
  cache 写入/读取，Host 参数 limit=80，默认 page=512 KiB、inline=128 KiB。10 条合法消息：
  user、tool call、30k 工具结果、4 条各 125000 字符的 assistant，之间 3 次 synthetic
  max_tokens 续写。分页返回 index 3–9 共 7 条，hasMore=true、全部 oversized=false，
  所以 Host 不会转入 oversized fallback。恢复顺序为 `[o0,o1,o2,o3,旧工具]`。
- **原因**：上一轮增加了工具身份锚，但页内既没有旧 input 也没有工具时，零锚分支仍把
  checkpoint 工具追加到 canonical 回答之后。这是上一轮修复尚未覆盖的情况。
- **建议**：使用现有 lineage/明确来源为窗口外保留项定位；覆盖按字节截页、多个续写、
  页内无共同锚点的真实组合，不能只测“页里仍有一个近期工具”。

### F05 — P2：同一工具结果在当前视图和历史页中状态不同

- **位置**：`src/client-history.ts:201–215`，对照 `src/session-view.ts:777–783`。
- **要求**：CLIENT_CONTRACT §显示项：“状态由 Host 生成，客户端不解析文本前缀再猜一次状态”；
  FEATURE_298 §3.2 指定工具结果事实来自 Session lineage。
- **复现**：相同 canonical `is_error:false`、正文以 `[Error]` 开头，当前 view 为 success，
  `projectConversationHistoryPage` 为 error；`is_error:true, metadata.cancelled:true` 时，
  view 为 cancelled，历史页为 error。
- **原因与建议**：view 已纠正旧的前缀推断，history 仍直接使用旧 tool seed status。应统一
  从明确结果字段解析状态，旧缺字段记录才采用有限兼容；用同一工具同时断言三个读取面。

### F06 — P2：不满足问题约束的答案仍被消费

- **位置**：`src/client-interactions.ts:65–69` → `src/sdk-runtime.ts:17768–17771,17885–17917`。
- **要求**：FEATURE_298 §3.6：“Host 原子消费首次有效答复”“保留……范围校验”；
  `packages/agent/src/runtime/user-interaction.ts:28–39` 明确不足 minSelections 不应 resolve。
- **真实 IPC 复现**：隔离 Host 的 `runs.startTool(ask_user_question)` 要求多选且
  min_selections=max_selections=2；Product Client 提交 `answer:[]` 得到 accepted=true、
  status=answered，pending 清零，Run completed，工具返回 `{"success":true,"choices":[]}`。
- **原因与建议**：Host 只校验 answer 的 string/array/object 形状，没有按原请求 options
  验证数量及选项约束。必须先验证再原子消费；无效答案应明确失败并保留当前问题待答。

### F07 — P2：Learning 订阅握手失败或 return 后 next 永久等待

- **位置**：`src/runtime-daemon/client.ts:1424–1428,1443–1446`；消费者
  `src/repl-learning-binding.ts:14–41`。
- **要求**：CLIENT_CONTRACT §错误：“公开方法以 Promise 拒绝报告操作失败”；
  disconnect/观察释放不应把执行状态混为一谈，且消费者须能结束观察。
- **复现**：直接调用当前生产 daemon client，使用受控 transport：握手先失败、后首次
  next，以及空闲 next 挂起时调用 return，两种时序均在 100ms 观察窗口内不结算；代码中
  对应等待者也没有后续唤醒路径。另一个独立源码探针复现了早失败遗失。
- **原因与建议**：错误只 reject 当前 failure 回调，不保存失败；return 仅 close 订阅。
  保存终止/失败态，唤醒现有 next，并明确后续 next 的结果。无需恢复轮询或增加重放协议。

### F08 — P2：ACP 批准计划时丢失完整计划正文

- **位置**：`src/acp_server.ts:1049–1050`；Host 发布点 `src/sdk-runtime.ts:19372–19375`。
- **要求**：CLIENT_CONTRACT §403：“options.plan 提供完整计划正文，不从截断的
  inputPreview 恢复”；FEATURE_298 §317：“exit_plan_mode 保留完整计划展示”。
- **生产方法级复现**：实际 ACP prompt/permission 方法使用受控 Product seam，收到
  Host options.plan 后发出的 permission rawInput 为 `{}`，完整计划未送到 ACP 客户端。
- **原因与建议**：桥接只解析 inputPreview，而计划请求正文在 plan 字段。用专门计划字段
  构造 ACP 可读的批准内容；不能把通用工具参数预览当作所有批准请求的完整载荷。

### F09 — P2：ACP 每轮把过期本地权限模式写回 Host

- **位置**：`src/acp_server.ts:1038–1042`；本地显式模式更新在 `:874`。
- **要求**：FEATURE_298 §317：“有效批准后，由 Host 将所属 Session 切到 accept-edits”；
  CLIENT_CONTRACT 开篇要求 Client 读取 Host 事实、不另建状态权威。
- **同一生产方法级探针**：计划批准后 Host 为 accept-edits，下一条 ACP prompt 又写成
  plan；观察到的 settingsWrites 为 `[plan,plan]`。ACP 观察器没有同步 view.settings。
- **原因与建议**：每轮 prompt 从陈旧 session.permissionMode 覆写共享设置，也可能覆盖
  其他 Client 的新编辑。只在初始化/显式模式切换时写相应意图，消费 Host 的当前模式事实；
  同时更新 ACP 的 current_mode_update 与本地 effort 选择依据。

需求轴：9 项，最高 P2。其中 F04 是上一轮排序修复的剩余缺口；F01/F02/F05 包含旧展示逻辑
被新增统一读取面沿用的问题，不能误称底层启发式全在本次重构新写。

## 契约需要补清楚的责任

Learning/Workflow 的断连恢复责任尚不完整。产品类型 `workflows.subscribe` 只有 close，
Learning 返回 AsyncIterable；CLIENT_CONTRACT 对 Session.observe 明确了 interrupted/
closed/重订阅，对前两者没有同等说明。`src/runtime-daemon/client.ts:2251–2305` 的通用
通知订阅未使用 lifecycle 重订阅，仍依赖原 remoteSubscriptionId。

需要明确：断连如何让消费者知道、原订阅何时终止、由谁重新建立、重读 snapshot 后如何
接续通知。复用现有 events/snapshot/连接生命周期即可；本轮不把“缺少自动重订阅”冒称为
违背了已存在的自动恢复承诺。F07 的失败遗失与 return 挂起则已有独立实现证据。

## Standards

独立规范轴报告，保持与需求轴分开：

1. **硬违反，P2**：`src/runtime-daemon/client.ts:1424–1427` 违反 AGENTS.md
   “NEVER silently swallow errors”。订阅握手先于 next 失败时丢弃错误，后续读取挂起；
   应保存失败并拒绝等待者。与 Spec F07 是同一缺陷，不重复计为另一产品 bug。
2. **判断项，P3，Duplicated Code**：`src/acp-client-view.ts:29–50`、
   `packages/repl/src/ui/client-plane.ts:107–150`、
   `packages/repl/src/interactive/classic-plane-display.ts:31–48` 有三套分页拼接校验；
   classic 缺少另两者的 totalLength/nextOffset 检查，已出现实现漂移。建议共用读取一致性
   校验，保留各界面展示逻辑。该项是有证据的维护风险判断，不单独当成已复现的数据损坏。

规范轴：1 项硬违反（最高 P2），1 项 smell 判断（P3）。重点检查了 Client/Host/view/
adapters 的新增实现，未声称逐 hunk 精读全部 441 文件；未发现可确证的新层依赖硬违反。

## 主线既有问题与非缺口

- A2A edge 离线期间 Run 已结束，恢复只取 phase、未取完整 await 结果，可能丢最终文本。
  `src/a2a/server.ts` 对应恢复分支在 `c447c0f3` 已相同，不能归因于本分支新增。
- REPL 没有持久授权 list/revoke UI，不等于 Product Client 缺该能力，也没有足够依据将
  “必须新增该 UI”作为本次设计未完成项。
- 浏览器当前只有纯类型契约、连接仍依赖 Node socket/pipe，是明示边界，不能说已交付 Web
  transport；也不能把未承诺的平台功能混入本次实现 bug。

## 建议修复与验收顺序

1. 先修 F01–F05 的原文、排序与保存失败：使用同一份 canonical fixture，连续检查 live、
   commit、checkpoint、Host 重启、observe、readItem、readHistory，覆盖没有 checkpoint、
   按字节截页无锚点、失败先于 flush 结束，以及正文恰好包含内部词句。
2. 修 F06–F07：真实 Host 拒绝无效答案且问题继续可答；订阅覆盖首次读取前失败、等待中
   return、断连与调用方重建。明确生命周期契约，保持业务 mutation 不透明重放。
3. 修 F08–F09：ACP 实际接收完整计划，批准后下一次 prompt 与另一个 Client 都看到同一
   Host 模式；不要在客户端再造默认配置权威。

仅增加更多 DTO 或 snapshot 项数断言不足以完成验收。应以跨读取面、跨保存边界的行为
一致性为门禁；测试绿色只说明已覆盖场景通过，不能代替这些设计承诺。
