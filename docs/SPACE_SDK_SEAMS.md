# Space 的 Product Client / Host 接缝

基线为 Space 已验证的 `0.7.97-alpha.1`；以下补齐属于当前工作树，需要重新构建 SDK 与 Host，不表示 npm 已发布。业务操作采用 `/client`；可信 Main 负责授权与宿主配置，Space 负责输入身份、队列展示、view、IPC 与 Renderer 状态迁移。

## 可信执行授权

`connectKodaXClient` / `ensureKodaXClient` 的可选 `authorizeExecution(request, services)` 只在可信 Main 进程执行。回调使用同一连接的 `services.credentials` 与 `services.hostTools` 注册现有 lease，为本次操作返回非秘密 `credential` / `hostTools` binding。回调与凭据值不会作为产品输入发送到 Host。配置回调的连接要求 `productExecutionAuthorization:1`；旧 Host 明确拒绝，不能忽略 binding 继续执行。

`kind` 为 `input`、`command`、`review`、`agents_lean`、`tool`、`workflow`、`agent_spawn`、`agent_followup` 或 `compaction`，`input` 是对应业务意图的独立快照。Main 根据自己的 Session 授权、Provider allowlist 和操作用途作决策。SDK 丢弃产品 payload 中的授权字段，再附加 Main 返回的 binding。拒绝应抛出错误；返回 `undefined` 明确选择原有无 binding 路径，不代表拒绝。

```ts
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import type { RuntimeScopedCredentialRequest } from '@kodax-ai/kodax/runtime';

// Main owns these values/functions; Renderer cannot supply them.
declare const approvedSessions: ReadonlySet<string>;
declare const readAuthorizedKeychainSecret:
  (request: RuntimeScopedCredentialRequest) => Promise<string | undefined>;
let lease: Promise<{ readonly id: string }> | undefined;
const client = await connectKodaXClient({
  async authorizeExecution(request, services) {
    const sessionId = request.input.sessionId;
    if (!sessionId || !approvedSessions.has(sessionId)) throw new Error('Session is not authorized.');
    lease ??= services.credentials.registerScoped({ providers: ['anthropic'] }, readAuthorizedKeychainSecret);
    return { credential: { leaseId: (await lease).id, mode: 'scoped', providers: ['anthropic'] } };
  },
});
```

同一回调可用 `services.hostTools.register(descriptors, handlers)` 注册 Artifact/Office/Space Control 的不可变描述符，再返回 `hostTools: {leaseId}`。注册不构成 ambient 授权。broker 仍需核验 Host 提供的 Session、目标身份、Provider 与 purpose；工具 handler 使用 Host 提供的 sessionId/runId/invocationId。秘密只经既有专用反向桥供给单次 Provider 请求，不进入输入、历史、配置或事件。

| 入口 | 授权归属 |
| --- | --- |
| 普通输入、Skill、command、review、显式工具 | 实际创建的 Run；可信准备、hooks、模型与工具执行共享该 Run 的授权，保留该 Session 的 MCP/extension 配置 |
| 排队消费 | 接收时保存非秘密授权上下文，实际消费时绑定 Run；不同授权不合批，也不注入另一授权的活动 Run |
| steer | 目标 Run 原有授权；不同授权返回 conflict，不替换或扩大它 |
| redirect | 旧 Run 保持原授权，新排队意图带自身授权 |
| Workflow | binding 要求明确 sessionId；实际 Run 与既有派生 Actor/Workflow scope，子任务按现有规则收窄 Provider 权限 |
| manual compaction | 仅使用 scoped credential；Host 创建 `session.compact` operation 身份，工具 lease 不参与 |
| automatic compaction、fallback、classifier、sidecar | 使用现有 Run resolver，每次实际请求重新检查 Provider 与 purpose |

实际 Provider 请求的 purpose 表示请求用途；Workflow 子 Agent 的普通模型请求仍可为 primary，目标为带 parentRunId 的 actor_turn。不能仅从 purpose 推断它不属于 Workflow。撤销、到期、断连和 Host 替换遵循现有 lease 生命周期。授权失效后的排队消费不会借用别的 Run 的授权；Host 诊断报告消费失败，尚未创建 Run 的输入仍可保持 queued，Space 可明确撤回/重新提交，不能无限等待一个不存在的 Run。未知 Host Tool 副作用不自动重放。

独立 `agents.spawn/followup` 使用同一 Main 回调，连接要求 `productActorAuthorization:1`。新 native turn 必须使用 scoped credential；Host 为实际 Actor/turn 创建独立执行上下文及 Run，不借用父 Run 的授权。broker 的 target 为 `actor_turn`，Provider allowlist 与 purpose 逐请求检查。Main 可返回 `tools: ['read', 'space_read']` 作为额外工具上限：模型 schema、实际调用、Host Tool runtime 和后代均收窄，仍执行 Session 的权限、Shell 与管理员策略。其他入口不接受该 `tools` 字段。

新 turn 的 followup 重新授权；正在执行的 turn 保留原授权，不能用 followup 替换其 credential。独立子树有自己的客户端归属，其他客户端停止根 Run 不取消该子树。External Actor 使用原有 executor/credentialRef，不能绑定 native Provider credential、Host Tool runtime 或 native tools ceiling。授权和 handler 闭包不持久化；Host 重启恢复既有中断/未知事实，新执行须重新授权，旧工具副作用不重放。

## 客户端退出与恢复

Product 连接要求 `productExitControl:1`。`disconnect()` 释放连接；`host.shutdown()` 仍是空闲 Host 的普通退出请求。完整客户端退出使用以下公开接口：

```ts
const receipt = await client.lifecycle.requestExit({ requestId: 'space-exit-123', shutdownHost: true });
const current = await client.lifecycle.readExit(receipt.requestId);
const unfinished = await client.lifecycle.listPendingExits();
// Main 保存原 clientInfo.instanceId / instanceSecret；断连、原 Host 已退出时也可查询。
const recovered = await readKodaXClientExits({ homeDir, profile, clientInfo });
```

`readKodaXClientExits` 从 `/client` 导出，只读退出回执，不连接或启动 Host，不重放工作，也不清理 Space 资源。稳定 instanceId 和至少 32 字符的 instanceSecret 由 Main 持有；退出回执按该客户端身份隔离。断连后用同一身份重连可查询并重试清理。新的客户端实例使用新身份，保存旧身份供旧退出查询；已接受退出的身份不能在同一 Host 再接收新工作。

| 事实 | 含义 |
| --- | --- |
| `accepted: true` | 退出意图已持久化；不证明清理或进程退出 |
| `cleanup.state: pending` | 本客户端工作正在结算 |
| `cleanup.state: succeeded` | 本客户端队列撤回、Run/Actor/compaction 取消与受管 Shell 清理已确认 |
| `cleanup.state: unknown/failed` | executor 或清理证据未确认，或明确失败；保留 issues 与目标身份，不推断成功 |
| `host.state: protected` | 其他客户端或受管工作仍占用 Host，退出请求被保护策略拒绝 |
| `host.state: accepted` | Host 接受退出控制；实际进程退出仍未证明 |
| `host.state: succeeded` | 原 owner 的持久化清理成功记录、PID generation 和 Windows Job/supervisor 退出已核验 |
| `host.state: unknown/failed` | 缺少证据或实际清理失败；连接 EOF 不作为成功证据 |

取消只作用于本客户端的排队输入、Run、独立 Actor 子树、显式 compaction 与 SDK 托管的 Memory 后台工作；其他客户端的 Run、Actor 和队列继续运行。Actor 持久化 interrupted 与 executor 已结束分别判断；受管 Shell identity 保留至精确清理验证成功。回执返回 runIds、actorTurns、operationIds、withdrawnInputs 及 issues。

同一 requestId 与同一退出意图幂等；Host 存活时可再次提交以重试未确认清理或先前 protected 的退出。回执持久化在 Host profile，断连后清理继续；Host 重启时旧请求只查询旧 owner，不作用于替代 Host。旧 pending 在 owner 丢失后返回 unknown，不能永久显示仍在处理。`replacementRunning` 表示原 Host 已核验退出且替代 Host 运行。inline Host 或缺少平台精确进程/containment 证据时不承诺实际进程退出。关闭自身窗口、IPC、Office/Artifact 与其他 Space 资源由 Space 完成。

退出保护在 Host 的 draining 边界内按 principal 判断，只豁免退出方自己的连接；A 断连后仍在线的空闲 B 也会阻止 Host 退出。退出 fence 同时覆盖 `/runtime` 的 `runs.submitInput`：after_turn 的新 Run 登记和 interrupt 的实际入队都需再次校验。取消并行触发，不等待不合作 compaction 才取消其他工作；有限结算等待后保留 operationIds 和 unknown，之后可重查、重试。未证明 executor 结束时不填成功，也不强迫任意进程内 custom adapter 退出。

## 统计与执行事实

Product 连接要求 `productExecutionFacts:1`。权威统计来自 `statistics.read(sessionId)`、`statistics.readRequests(sessionId, {cursor, limit})` 和 `statistics.readTools(sessionId, {cursor, limit})`。事实在执行边界持久化，断连后继续采集；Host 重启保留累计值和稳定身份。旧 Session 采集前的用量不能补算，返回 `coverage: partial` 与 issues。coverage 表示采集边界是否完整；执行完成与用量完整性仍需查看逐请求 state/usage 和 requestsWithoutUsage。

| 接口内容 | 公开语义 |
| --- | --- |
| 累计 `usage` | 全部已观察请求的归一化 input/output/cache/thought 用量；按稳定 requestId 更新去重。total 是 input+output，thought/cache 是相关分量，不再次叠加。Rewind/compaction 不清零已消耗用量；Fork 的新 Session 记录自己的新请求。缺失 usage 不猜算，查看 requestsWithoutUsage |
| `physicalRequestCount` / `operationCount` | 实际可观察的 wire 请求与只能观察到的 adapter operation 分开计数；requestCount 是两者总数 |
| `contexts[]` | 各根/子 context 最近一次请求准备时的 pressure、tokenBreakdown、窗口/保留量、target、runtimeId、contextRevision（如有）及 revision。属于带时间的估算快照，空闲或重启后不代表新请求已重新计算 |
| 请求事实 | requestId、logicalRequestId、provider/model、attempt、purpose、Run/Actor turn/compaction target、state/usage。原生 HTTP adapter 的 fetch 边界包括 SDK 内部 retry；首个 wire 请求细化已记录的 pending operation，保持 ID |
| fallback | 非 streaming fallback 保留 purpose=fallback；跨 Provider 子任务 fallback 另带 route.chainId/attempt/fromProvider，credential purpose 保持实际用途。previousRequestId 与 fallback 标志用于归属，不能仅凭 Provider 名称推断 |
| 工具事实 | Host 为每次实际调用生成 id；toolId 是 Provider 来源身份，重复 toolId 不合并调用。prepared/executing/completed/not_executed/unknown、结构化结果及实际 sandbox observation 序列分别保留 |
| Sandbox | applied 含实际 backend；fallback 含实际 reason/执行策略；not_selected 表示未选。空序列表示 adapter 未报告，不从 permissionMode 推断 backend |

分页 cursor 绑定 Session 与记录种类，限定开始分页时的条目数量；记录可以继续更新，消费方按 ID/revision upsert，完成分页后重新读取获得新条目。Host 崩溃后未完成请求/工具在原 owner 被确认失效时转 unknown，不自动重试，不填造 usage 或成功结果。custom/CLI adapter 未暴露内部 wire 时明确使用 `boundary: provider_operation, dispatch: unknown`，并报告 partial；不会把一次调用冒充其内部物理请求。统计不提供货币价格账本，也不要求解析 costReport。

Actor 观测身份独立于 credential lease：普通 ambient 子 Actor 也带实际 actorPath/turnId，工具与预算保留子 turn。Sandbox observation 按原顺序转发。SDK invocation 的 executionId 贯穿 prepared、执行、结果、观察和 bridge target；并发重复 Provider toolId 不合并，结果与恢复附件各自关联。`contextRevision` 是进程内 context/compaction 快照版本，不是跨重启的 CAS token；持久化读取使用事实 revision。

执行中的 operation-only adapter 返回 partial。原生 HTTP adapter 的暂态带 `wireObservation: pending`，首个 fetch 同 ID 细化为 `observed`；它不会因为暂态永久污染 coverage。无物理观察能力的 operation 带 `unavailable`。异常或取消后的 usage 仅保存 adapter 实际返回且已归一化的值，缺失用量不推测。

## canonical 操作边界

`readHistory` 返回分页/正文读取身份 `revision`、canonical 存储身份 `sourceRevision`、`status: resolved|partial|ambiguous` 和原有有界 `issues`。可证明 canonical 位置的条目带 `historyBoundary: {entryId, sourceRevision}`；同一消息的显示块共享该边界。记录原样回传，不能从显示 item ID、search entryIndex 或正文推导。

当前 Product 连接要求 `productHistoryBoundaries:1`，使旧 Host 缺失质量字段或 Retry 边界支持时在连接阶段明确失败。

| 动作 | 公共输入 |
| --- | --- |
| Fork | `forkSession(sessionId, {historyBoundary: item.historyBoundary})`，包含边界消息 |
| Retry | `forkSession(sessionId, {historyBoundary: userItem.historyBoundary, before: true})`，在查询前派生，再用新 inputId 提交原查询 |
| Rewind | `rewindSession(sessionId, {historyBoundary: item.historyBoundary, expectedHead})`，expectedHead 来自所见 lineage |

Retry 包括第一条查询之前的空历史；`before` 需要 canonical boundary。长查询须通过 `readHistoryEntry` 补读正文。Fork/Retry 不改变源 Session；这些动作都不回滚文件副作用。sourceRevision 失效返回 `resync_required`，head 变化返回 conflict；刷新后重新选择，不自动扩大选择范围。partial/ambiguous 不表示已浏览完整历史，也不保证每条记录都有可操作边界。

## 宿主配置与支持范围

| Space 能力 | 当前公开接入与限制 |
| --- | --- |
| 手册/可信系统指令 | Host 安装的 extension `provider:before` hook 用 `replaceSystemPrompt` 合并可信手册，随 Host integrations 生命周期加载。低层显式 Run 保留 `context.systemPromptOverride`（SA）/`agentProfile.instructions`（AMA）；产品输入不开放任意 prompt/context。共享 Host hook 的适用范围由可信宿主策略选择。 |
| Shell | 可信 `/runtime` 的 Session `shellExecution` 设置，采用现有规范化 Shell contract 与 revision CAS；Product settings 只暴露已列出的业务选择。 |
| 工具/执行策略 | permissionMode、Plan 与审批经 `/client`；Host `execPolicy.adminRules/trustedProjectRoots`、`autoReview` 在 owner 启动时注入，附着已有 Host不覆盖它。Skill/command 的 allowedTools、hooks 来自可信注册来源；Host Tool 描述符仅在绑定 Run 中提供。 |
| 结构化历史附件 | `readHistory().items[].attachments` 暴露 canonical 用户图片块/工具结果图片的 path、mediaType。原始 picker source/name、附件字节、任意 Office/Artifact 对象不在该接口中。file/video 尚不能作为 Provider prompt 附件；Space 可通过 Host Tools 提供业务读取结果。 |
| 详细统计 | 使用上述 statistics 结构化事实。view.activity.usage 保留最新活动展示语义；SDK 不提供货币价格账本。 |
| 退出/崩溃恢复 | 使用上述 lifecycle 与离线回执查询；SDK 结算自身受管工作，Space 管理自身资源。Host 重启不自动续跑队列、Provider 或未知工具调用。 |

回归入口：

```text
npx vitest run src/sdk-client.host-authorization.test.ts src/sdk-client.exit.test.ts src/sdk-client.statistics.test.ts src/sdk-client.derive.test.ts src/execution-facts.test.ts src/runtime-daemon/client-lifecycle.test.ts packages/coding/src/agent-runtime/__contract-tests__/cap-024-tool-dispatch.contract.test.ts
node --test tests/bundled-product-exit.test.mjs
```

这些测试覆盖真实 Host 上的 credential/tool bridge、排队授权隔离、steer 拒绝授权替换、Skill/command/review/Workflow/compaction、伪造 payload、撤销、canonical Fork/Retry/Rewind 与历史图片引用。退出专项覆盖已退出身份的 after_turn/interrupt 拒绝、异步准入竞态、不响应 abort 的 compaction 与其他任务并行取消；统计专项覆盖普通 ambient 子 Actor 归属、子工具 Sandbox 转发、重复 toolId 的执行/结果/附件隔离、bridge 目标身份，以及运行中的 operation-only adapter 质量。bundle 退出专项已纳入 `test:bundle`。其他现有 Provider/用途/生命周期边界仍由既有 Runtime 和反向桥回归验证。

`packages/coding/src/child-executor.test.ts` 另行验证 Actor/specialist 工具上限、只读子任务，以及 digest/structured-output repair 的无工具边界；Host Tool lease 不绕过这些限制。

本轮验收需同时包含独立 Actor 工具上限/客户端归属、显式 compaction 取消、累计用量、物理 retry、重复工具来源 ID、事实恢复，以及 bundle 的真实 daemon 退出与替代 Host 保护。构建和类型消费者检查不能由仅运行源码测试替代。尚未发布 npm 包。

事实存储、退出控制、客户端工作归属和 Provider observation 模块的 scoped coverage：语句 92.3%、分支 85.43%、函数 94.8%、行 95.93%；不是全仓覆盖率声明。

2026-10-09 本轮本地验收：关联回归 97 文件、977 测试通过；最终增量专项 7 文件、31 测试，以及工具分发合同 12 测试通过。bundle 的 2 项真实 daemon 测试验证立即断连后的空闲 peer 保护、精确进程退出及替代 Host 保护。packages、SDK bundle、声明构建、源码/测试类型检查，以及不加载 Node ambient types 的 Product Client 类型消费者均通过。Standards / Spec 最终复核无明确残余。未全量复跑仓库全部测试，未发布 npm，Space 安装包尚未更新。
