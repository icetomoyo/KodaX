# FEATURE_270 统一 Actor/Turn 控制面 — 人工测试指南

> **v0.7.74 更新：** 本文保留 FEATURE_270 发布时的历史事件等待用例。
> 当前模型侧 `wait_agent` 不再接收事件游标或 `max_events`；请以
> [FEATURE_273 测试指南](FEATURE_273_v0.7.74_TEST_GUIDE.md)验证 mailbox 等待，
> Runtime/SDK 原始事件回放仍按本文对应的 host/API 用例验证。

## 功能概览

**功能名称**：Ultra-Aligned Adaptive Multi-Agent Actor Control Plane

**目标版本**：v0.7.72

**Feature ID**：FEATURE_270

**测试日期**：待填写

**测试人员**：待填写

> 发布候选说明（2026-07-18）：以下人工用例用于保留发布证据，不构成人工签字门槛；剩余发布动作仅为包版本与 Git tag 定版。

本功能用一个 Runtime-owned Actor/Turn 树替代旧 child-task、Workflow-local
scheduler 和并行外部任务投影。AMA 保留主动协作能力；Workflow 只在显式请求时
使用，并把所有 child Agent 纳入同一容量、事件、输出和恢复模型。

## 测试环境

- Node.js 20 或更高版本。
- 使用临时 `KODAX_HOME` 和临时 session 存储。
- 已执行 `npm run build`。
- 准备 inline、Worker、daemon Runtime，以及一个支持 follow-up/interrupt 的外部
  Agent fixture。

## 测试用例

### TC-001：递归 Actor 树与直接父级完成

1. root 使用 `spawn_agent` 创建 child，child 再创建 grandchild。
2. grandchild 完成后分别从 child 与 root 调用 `list_agents`/`agent_output`。
3. 让 parent Turn 在 descendant 尚存活时完成。

预期：

- [ ] 路径稳定为 direct-parent tree，名称/路径碰撞和 traversal 被拒绝。
- [ ] grandchild completion 只投递给 direct parent 一次。
- [ ] root 看到有界结果与 unresolved descendant，不收到重复原始噪声。
- [ ] descendant 后续完成写入 parent mailbox，不隐式唤醒或 re-parent。

### TC-002：Actor identity 与 Turn 生命周期

1. 完成、失败和 interrupt 同一 Actor 的不同 Turn。
2. 对 idle Actor 调用 `send_message`，确认不启动 Turn。
3. 对 idle 与 running Actor 分别调用 `followup_task`。

预期：

- [ ] terminal Turn 不删除 Actor identity，历史可复用。
- [ ] idle `send_message` 只入 mailbox；idle follow-up 原子启动新 Turn。
- [ ] running follow-up 在安全边界加入当前 Turn，不消耗第二槽位。
- [ ] interrupt 后 Actor 可再次 follow-up，identity/path 不变。

### TC-003：全局容量、预算与权限单调性

1. 在默认配置下同时保持三个 non-root Turn active。
2. 尝试启动第四个 Turn，随后结束一个既有 Turn 并重试。
3. 以 `N=1`、`N=8` 和非法值启动新 session。
4. 让 descendant 尝试扩大权限或绕过 root work budget。

预期：

- [ ] 第四个启动返回结构化 `AgentLimitReached`，无隐藏队列或残留 Actor/name。
- [ ] 槽位释放后可干净重试；root 始终可响应。
- [ ] `N=1` 为 root-only；`N=8` 合法并警告；非法值被拒绝。
- [ ] descendant 权限只能保持或收窄，预算耗尽返回明确错误且无半提交。

### TC-004：Workflow 与外部 Agent 共用控制面

1. 显式运行 named Workflow，并观察 declared pending steps 与 admitted Turns。
2. 在容量饱和时继续推进 Workflow。
3. 运行外部 Agent Turn，执行 follow-up 与 interrupt 能力检查。

预期：

- [ ] Workflow owner 不占 Agent 槽；leaf step 占统一 non-root 槽。
- [ ] pending protocol step 不伪装成 scheduler-accepted overflow。
- [ ] async Workflow terminal event 保留 result/artifact/coverage/error 结构。
- [ ] 外部 backend 能力不足时明确拒绝，不产生孤儿 Turn 或私有生命周期投影。

### TC-005：升级、恢复与 canonical surface

1. 使用历史 persisted `amaw` 与 `ama-workflow` 配置启动一次。
2. 尝试从 CLI/SDK 输入新的 retired mode 或旧工具名。
3. daemon 运行中断线、重连并重启，检查 actor snapshot/event replay。

预期：

- [ ] 历史值只迁移一次到 AMA 并产生一次通知；新输入直接失败并给出迁移提示。
- [ ] model-visible schema 只包含 7 个 canonical collaboration tools。
- [ ] snapshot 在提交完成前不可见；重启后 Actor identity/Turn history 恢复一致。
- [ ] 无第二 actor/task journal，旧 settled Workflow/F258 历史不被重新物化为 live Turn。

### TC-006：AMA 与显式 Workflow 策略

1. 给 AMA 一个简单单步任务。
2. 给出三个独立审查维度并要求合并结果。
3. 对同一复杂任务分别明确请求 named Workflow 与移除全部 Workflow 语言。

预期：

- [ ] 简单任务保持 solo。
- [ ] 并行任务可自适应使用 Agent，但不会超过三个 active non-root Turn。
- [ ] 明确请求时使用 named Workflow；仅复杂但未请求时不调用 `run_workflow`。
- [ ] prompt 包含 canonical Ultra sentence，且没有静态波次或复杂度触发指令。

### TC-007：消息安全、有界观测与统一视觉

1. child 收到 root 消息后，以返回的 `messageId` 作为
   `forwarded_message_id` 转发给 sibling；再尝试使用伪造 ID、回发到已在链路中的
   actor、超过五跳转发，以及降低敏感消息 classification。
2. 在同一 model turn 内分别让 root 发送 21 个 recipient deliveries、child 发送
   6 个；用剩余配额不足的 broadcast 验证原子失败。
3. 让 native 与 external actor 连续产生超过 6 条 tool/status 进度和超过 8,192
   字符的输出，在窄终端和宽终端观察 Ink/Classic 活动面，并调用
   `list_agents`/`agent_output`。
4. root 正在 `wait_agent` 时提交新的用户输入，并确认该输入在下一 root turn
   继续处理；同时验证等待中的 Runtime waiter 已立即清理。

预期：

- [ ] Runtime 只接受调用者真实 mailbox 中的消息 ID；伪造引用、自发、环路、
  超过五跳和 classification 降级均明确失败，合法转发保留来源链。
- [ ] root/child 的 20/5 recipient 上限按接收者计数；配额不足的 broadcast 不发生
  部分投递，下一 model turn 配额重置。
- [ ] 每个 Turn 只保留最近 6 条、单条不超过 240 字符的活动；list summary 不超过
  480 字符，output preview 不超过 8,192 UTF-16 code units、带明确截断标记、
  保留首尾且不拆分 emoji/组合字符。
- [ ] native、Workflow-owned、constructed、external 进度进入同一现有活动面；状态
  色彩、前缀和省略号在 80 列终端仍清楚，无重复行、布局抖动或第二进度存储。
- [ ] root 用户输入中断当前 wait/round 后不会丢失，并在下一 turn 恢复；child 不会
  直接看到用户输入，已中断 wait 不残留 timer、listener 或 waiter。

### TC-008：完整观察面、分支取消与宿主边界

1. 创建超过 20 个可见 Actor，并使用 `path_prefix`、`state`、`after_path` 和
   `limit` 分页调用 `list_agents`；再让非 root Actor 查询 sibling 路径前缀。
2. 在一个游标之后连续提交多条 Actor 事件，以 `max_events: 1` 等待，再用返回的
   `nextSequence` 继续等待直至 `hasMore: false`。
3. 创建 parent/child 两个 active Turn，对 parent 调用
   `interrupt_agent(scope='subtree')`；随后对 parent 发起 `followup_task`。另创建一个
   不支持 interrupt 的 active external child，验证同一操作不会部分中断其 parent。
4. 让 external Agent 返回带 URI、MIME、大小、hash、provenance、producing Agent 和
   remote task 的制品，再调用 `agent_output`。对本地路径使用普通受权限控制的读取
   工具；确认 collaboration 工具不会自动下载远程 URI。
5. 创建名为 `parent` 的 root child 并从 root 操作它；再从普通 child 使用 `parent`
   别名。检查 model-visible schema，并从可信 Runtime host 执行永久 subtree close。

预期：

- [ ] 每页最多返回 `limit` 个可见 Actor，游标无重复或遗漏；非 root 查询不泄露
  sibling 的路径、数量或状态。
- [ ] `event` 保持向后兼容并等于批次首项；`events` 有界，`nextSequence` 指向已返回
  的最后一项，继续等待不会跳过剩余已提交事件。
- [ ] 可中断子树按 child-first 顺序一次提交并保留 idle/reusable identity；任一 active
  descendant 不支持 interrupt 时整棵目标分支保持运行。
- [ ] `artifacts` 字符串数组继续可用，`artifactDetails` 保留结构化元数据；读取、网络
  与凭据仍经过原有权限面，没有隐式 SSRF 或第二文件读取实现。
- [ ] root 可准确操作名为 `parent` 的 child，非 root 的 `parent` 仍解析为直接父级；
  模型仍只看到 7 个 canonical collaboration tools，永久 close 只存在于可信宿主。

### TC-009：启动竞态、closed 语义、协议升级与容量承诺

1. 使用可暂停的 actor snapshot store，让 `spawn_agent` 已提交 running Turn 但启动
   save 尚未返回；此时并发执行 `interrupt_agent`，再释放 save。
2. 永久 close 一个 Actor，分别尝试向它发消息、从它发消息、drain mailbox 和
   follow-up。
3. 用新 SDK 连接一个不声明 `actorControlPlane v1` 的旧 daemon；再让旧 SDK 的
   `agentTasks.start` 请求连接新 daemon。
4. 在默认 4 总槽位、0 active child 的新请求中给出 5 条独立审查轨道，并观察
   Worker 的口头承诺与第一批 `spawn_agent` 调用数；再完成一条并观察 refill。
5. 分别输入“请用工作流完成审查”和“请优化这个复杂流程并行检查三个模块”。

预期：

- [ ] executor 未启动或只拿到同一个已 aborted signal；Turn 保持 interrupted，迟到
  completion 不增加 revision、不写 snapshot。
- [ ] closed Actor 仍可审计历史，但所有 mailbox 双向操作和新执行都返回
  `actor_closed`，mailbox 不增长。
- [ ] 新 SDK 在发 RPC 前给出升级并重启 daemon 的明确错误；新 daemon 对旧
  `agentTasks.*` 只返回 `client_upgrade_required`，不透明 alias、不执行旧生命周期。
- [ ] Worker 在首轮明确看到 4 总槽/3 child start slots，最多承诺并派发 3 个；其余
  由 root 本地承担或等待终态后 refill，不出现先承诺 5 个再解释失败的过程。
- [ ] 明确“工作流”获得 `run_workflow`；只有“流程/复杂/并行”不会触发 Workflow。

## 自动化与评测基线（2026-07-18）

- `npm run build`：通过。
- 最终隔离聚焦回归：15 个测试文件，227/227 通过。
- 本次变更集合：55 个测试文件，999/999 通过。
- F266/F270 扩展 Layer 1：61 个测试文件，1097/1097 通过。
- changed-code coverage：2294/2780 statements，82.52%。
- post-review 控制面聚焦回归：5 个测试文件，62/62 通过；跨层 Actor、Workflow、
  child executor、storage 与 Ink/view-model 回归：12 个测试文件，286/286 通过。
- post-review 五个核心实现文件 coverage：statements/lines 88.79%，branches
  80.05%；完整 package、bundle、Worker sidecar 与 DTS 构建通过。
- completeness audit：聚焦实现 62/62、Actor/Workflow/storage/UI 跨层
  285/285、SDK/protocol 252/252 通过；五个核心实现文件 statements/lines
  89.47%、branches 82.01%；完整 build 与 2/2 零付费 manifest eval 通过。
- F270 eval harness + shared one-shot boundary：65/65 通过；新
  dataset/runner statement coverage 为 97.00%，严格 TypeScript 校验通过。
- fresh-capacity follow-up：Actor/Learning/prompt 103/103、daemon/SDK 94/94、
  eval contract/fake provider 24/24、fallback capacity wiring 1/1 通过；新增
  SDK capability/learning cancellation 选择性测试通过。
- follow-up 覆盖组：核心 Actor/Learning/prompt 90.62% lines、80.86%
  branches；daemon/Runtime Learning 89.34% lines、80.23% branches。
- manifest-only eval：2/2 通过，三个付费 stage 默认跳过；raw root 位于 OS
  临时目录 `kodax-eval-dumps/feature-270/<revision>/`。
- 清洁隔离工作树的全量 suite：10,053 通过、52 跳过、12 失败。12 项来自
  Windows/并发负载下 daemon/SDK 超时、memory lock `EPERM` 和既存 tracker
  summary 不一致；SDK 67/67、memory 32/32、daemon smoke 11/11 的隔离复跑均
  通过。F270 产品路径没有可复现失败。
- Owner 已授权冻结预算上限 `$18`。付费 Layer 2 完成 60/60 cells：treatment
  盲审 10 胜/1 负/19 平，29/30 不劣；Layer 3 完成 24/24 calls：3 胜/1 负/2
  平，5/6 不劣且无无效计划重放。两层均无 timeout/provider error/truncation。
- Layer 2/3 共 678,203 tokens，评估修订估算费用 `$0.02550684`。最终工程建议
  为 `recommend-ship`；发布决定与本指南保留的人工证据保持独立。

零成本 manifest 检查：

```powershell
npx vitest run -c tests/config/vitest.eval.config.ts tests/feature-270.eval.ts
```

原始五 case 合同已按顺序完成四调用 pilot、Layer 2 盲审/解盲、Layer 3
盲审/解盲；未添加自动重试。原始证据位于
`kodax-eval-dumps/feature-270/cd9f0e4168a02279/`。

2026-07-18 当前六 case 合同新增 `fresh_capacity`，pilot 为 6 calls，完整
Layer 2 上限相应为 72 calls。首轮 pilot 暴露容量规则位置不够显著，treatment
发出 5 个 starts；将共享硬容量契约提升到 full/fallback 系统提示首段后，最小
affected re-pilot 在 revision `4d857d43e8edf234` 上通过：treatment 的
`parallel=3`、`fresh_capacity=3`、`no_workflow=0 forbidden Workflow`，共
50,967 tokens，估算 `$0.0027499`。本次诊断时为定位首轮失败已查看 arm 标签，
因此不把 follow-up re-pilot 声称为新的严格盲审或完整 Layer 2 结论。

## 测试总结

| 用例数 | 通过 | 失败 | 阻塞 |
|---:|---:|---:|---:|
| 9 | - | - | - |

**测试结论**：自动化与付费行为评测通过，工程建议 `recommend-ship`；本页 9
个人工用例可由发布测试人员保留为补充证据，但不构成人工签字门槛。

**发现的问题**：follow-up 首轮复现了“新请求先承诺/尝试 5 个、容量层只接纳
3 个”的体验缺口，已通过 authoritative first-section capacity contract 修复并
由最小 re-pilot 验证。已知残余行为是部分模型会先读取具体 diff/file 再启动
并行 Agent，以及一个 Layer 3 旅程多一次树检查；两者均未越过容量、误启
Workflow 或重放已否定计划。

**证据位置**：评测 raw dump 位于
`kodax-eval-dumps/feature-270/cd9f0e4168a02279/`；人工 actor
snapshot/event、迁移前后配置与终端记录待执行时补充。
fresh-capacity follow-up raw dump 位于
`kodax-eval-dumps/feature-270/4d857d43e8edf234/`。
