# 多模态工具结果与错误传递审计

日期：2026-09-11。对象：当前工作区，包含上一轮尚未发布的修复。

**修复状态更新（同日，尚未发布）：** 下文保留初次扫描时的失败证据与诊断，不代表当前仍有这些缺陷。
原 9 个失败用例已移除 `it.fails` 并转为正常回归；Worker、MCP、managed、历史容量、
微压缩、Runtime/daemon 均已补齐。MCP 新增真实图片字节、资源/嵌入资源、重启与模型请求验证。
OpenAI 视觉 provider 现通过有效 tool 回包后附带的 user image 消息交付图片；
不支持视觉时仍明确降级，孤儿/重复工具图片不会进入请求。诊断投影同步更新。
完整修复需求和身份问题方案见 [SDK 契约修复计划](sdk-contract-repair-plan.md)。

## 结论与范围

上一轮修复了直接调用、桥接、guardrail、首次容量准入及 child/Actor 的若干断点，
但没有贯通完整生命周期。本轮在相邻边界复现了 **9 个失败用例**，分为下列 7 类。
最直接影响原始问题的是：公开 Runtime 仍把明确标注的本地异常归类为 provider 故障。

扫描覆盖 coding 工具注册/分发、managed runner、构造工具 Worker、MCP、历史容量恢复、
压缩、LLM 消息序列化、child/Actor 及公开 Runtime。结论来自源码与离线执行，
没有发起模型请求，没有修改本轮涉及的产品实现，没有提交或发布。
这不是全仓所有运行组合均已证明安全的声明。

## 已复现的问题

### 1. P1：公开 Runtime 再次把本地异常变成 provider 故障

- 位置：`src/sdk-runtime.ts:22402` 的 `buildRuntimeFailureDetail`、
  `:22497` 的分类入口、`:22613` 的 response fallback、`:22790` 的错误类别读取。
- 触发：传入 `executionFailure.source = local`、`errorClass = local_execution_error`、
  `requestPhase = local_execution` 和原始 TypeError。
- 实际：公开 run result 的 `failureKind` 仍为 `provider`；分类逻辑重新生成 provider 文案，
  没有将新的本地异常类别贯通至对外错误契约。
- 证据：公开 `createKodaXRuntime`/`runs.start`，mock 底层 `startKodaX` 产生本地失败；
  断言 `failureKind` 不应为 provider 实际失败。
- 影响：Space 等 Runtime 消费者仍可能把 SDK 本地缺陷解释为供应商问题。
  child/Actor 层的信息改善不能证明 Runtime 已正确处理。

### 2. P1：构造工具 Worker 把图片数组 JSON 化

- 位置：`packages/coding/src/construction/handler-worker.ts:60`；
  `handler-worker-protocol.ts` 和 `handler-worker-client.ts` 的返回值仍有字符串契约。
- 触发：构造工具脚本执行 `return await ctx.tools.read(input)`，读取真实 PNG。
- 实际：同一个 `read` 返回的原生 text/image 数组，通过 Worker 返回后成为 JSON 字符串。
- 影响：声明层支持 `ToolResult` 不代表跨进程边界支持；模型无法按原生图片块处理结果。
- 修复方向：RPC 保留合法内容数组，兼顾既有任意 JSON 对象返回值的兼容行为，
  并贯通 Worker client/protocol/proxy 的类型。

### 3. P1：MCP 图片与错误状态在适配层丢失（3 个用例）

- 位置：`packages/agent/src/capabilities/mcp/runtime.ts:155,607,611`，
  `packages/coding/src/tools/mcp-call.ts:55`，
  `packages/coding/src/agent-runtime/run-scoped-tools.ts:115`。
- 图片证据：本地 stdio MCP fixture 返回原生 image 块，`McpServerRuntime.callTool`
  将其变为 JSON 文本；图片数据不再是结构化图片。fixture 用占位 data 验证运输形状，
  不涉及图像解码或供应商视觉能力。
- 错误证据：上游 `metadata.isError = true`，经 `mcp_call` 和 run-scoped 两条路径后，
  结果分类器均判定为非错误。前者把 metadata 放进文本，后者丢弃该错误标记。
- 影响：图片可能以 base64/JSON 文本进入上下文；工具失败可能计为成功并反馈给模型。
- 修复方向：在 MCP 与内部内容契约之间显式适配。MCP 的 `data/mimeType` 与内部
  `path/mediaType` 不同，需要处理图片落地/生命周期；仅扩大 TypeScript union 不够。
  错误状态应保留为结构化字段，不依赖自然语言推断。
- 同族候选：`tool-dispatch.ts` 的 MCP fallback 也未消费上游 `isError`；
  resource 读取也使用 `flattenMcpContent`。这两条仅静态确认，未额外计入 9 个复现用例。

### 4. P1：历史容量恢复跳过所有多模态数组

- 位置：`packages/coding/src/history-capacity-recovery.ts:46`。
- 触发：超容量历史中的 tool_result 是包含大量文本和一张图片的内容数组。
- 实际：`typeof block.content !== 'string'` 直接跳过；相同正文为字符串时能恢复，
  放入 text/image 数组后却抛出 `ContextCapacityError`。
- 证据：相同容量参数、相同正文，分别执行两种结果形状；只有数组分支失败。
- 影响：首次工具结果准入修复后，后续历史恢复仍可能提前终止可恢复的会话，
  例如容量需求变化或恢复已有历史时。
- 修复方向：复用已支持数组的容量处理，回收文本而保留图片，并正确报告图片容量债务。

### 5. P2：managed 直接工具调用未标记返回式错误

- 位置：`packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.ts:199`。
- 触发：直接包装的 `read` 读取不存在的文件，handler 返回 `[Tool Error] ...` 而非 throw。
- 实际：`content` 包含明确错误，但 `isError` 为 undefined。只有 catch 分支设置该标记。
- 影响：runner 的消息、指标与 span 依赖 `isError`，与已修复的 managed 桥接表现不一致。
- 修复方向：统一直接与桥接的错误结果判定，兼容字符串和多模态内容。

### 6. P2：Worker 异常 RPC 丢失错误码

- 位置：`packages/coding/src/construction/handler-worker-protocol.ts:36`，
  `handler-worker-client.ts:287`。
- 触发：构造工具抛出带 `ERR_INVALID_ARG_TYPE` 的 TypeError。
- 实际：RPC 只序列化/还原 name、message、stack，外侧异常不再有 code。
- 影响：即使后续本地失败封装保留 code，也无法恢复跨 Worker 时已丢失的信息。
- 修复方向：保留允许的结构化诊断字段，不复制任意异常对象或敏感上下文。

### 7. P2：显式启用的旧微压缩删除嵌套图片

- 位置：`packages/agent/src/session-lineage/compaction/microcompaction.ts:119,149`，
  `result-extractors.ts:118`。
- 触发：明确开启 `microcompact`，图片所在 tool_result 达到清理年龄且不受保护。
- 实际：顶层 image 被保留，但嵌套图片所在结果变成 `[Cleared: ...]` 文本，图片丢失。
- 范围：该旧微压缩默认关闭，不能据此声称默认会话都会删除图片。
- 修复方向：嵌套图片遵守同样的保留规则；如果产品选择回收图片，应明确恢复机制与契约。

## 现有兼容限制：OpenAI tool_result 图片降级

`packages/llm/src/providers/openai.ts` 约 1465–1490 行显式将 tool_result 内图片转成
unsupported 占位文字，现有 `openai-message-serialization.test.ts` 也固定了这个行为。
顶层 user 图片的支持与工具结果图片支持是不同路径。

这属于现有能力限制，未计入上述 9 个新失败用例；但它意味着“SDK 内部保留数组”不能
等价于“所有模型已收到图片”。Anthropic serializer 存在原生图像序列化路径。
本轮只核对并执行序列化测试，没有实测任何远端模型视觉能力。

## 证据与运行方式

新增探针：

- `packages/coding/src/multimodal-contract-audit.test.ts`：8 个用例。
- `src/sdk-runtime.test.ts` 中 `AUDIT: Runtime retains...`：1 个用例。

最初使用普通 `it` 执行，9 个用例均在上述目标断言/目标容量路径失败。
审计结束保留为 Vitest `it.fails`，以记录尚未修复的问题而不令默认测试集永久失败。
**expected-failure 显示通过只表示缺陷仍可复现，不是修复成功。**
修复时移除相应 `.fails` 并让正常断言通过；还应检查失败原因，避免把 fixture 故障误当缺陷。

```powershell
npx vitest run packages/coding/src/multimodal-contract-audit.test.ts src/sdk-runtime.test.ts -t 'AUDIT:' --reporter=dot
```

构造工具测试遵循现有 loader 的 Worker 路径选择；本次使用上一轮已构建且与审计涉及
Worker 源码一致的产物。若修改 Worker，实现验证前需要重建相关产物，避免执行旧代码。

同时运行 Anthropic/OpenAI 序列化及微压缩现有测试中匹配 `image|multimodal` 的用例：
13 个通过、77 个未选中。既有用例能通过仍遗漏上述边界：微压缩原测试只检查顶层图片，
OpenAI 原测试恰好要求降级，旧调用链测试未覆盖构造 Worker 和公开 Runtime 的新失败类别。

## 建议修复顺序与验收边界

1. 先贯通公开 Runtime 的本地错误分类，并统一 managed/MCP 的结构化错误标记，
   让上层能准确区分执行失败与供应商故障。
2. 补齐 Worker/MCP 内容适配及 Worker 诊断字段；在真实运输边界验证形状和错误码。
3. 补齐历史容量恢复与明确启用的微压缩，验证图片保留、文本可回收、容量确实不可满足三种情况。
4. 单独决定 OpenAI 系列的工具图片兼容策略，并在实际 provider 请求序列化处验收，
   不能只检查 provider mock 接收到的内部消息。

验收应覆盖“结果生产 → RPC/适配 → 分发 → guardrail → 容量准入 → 历史恢复/压缩 →
provider 请求”及“异常产生 → RPC → child/Actor → Runtime 对外结果”。
每个边界同时检查内容结构和错误状态；文字摘要只用于分类、统计与展示，不能替代原始模型内容。
