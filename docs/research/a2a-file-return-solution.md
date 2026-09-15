# KodaX A2A 文件产物漏返的调研与建议方案

结论：A2A 已原生支持文件返回；本次应修复 KodaX 执行结果到 A2A 产物的衔接，不新增模型工具。推荐在成功工具完成时保留本次运行的文件记录，通过一个小的可选结果字段交给现有 A2A 文件封装代码；同时补齐 HTML MIME 映射。保留现有产物准入规则，普通工作区任意文件自动返回不纳入本次修复。[协议核查](a2a-file-return-protocol.md) · [实现核查](a2a-file-return-implementation.md) · [方案挑战](a2a-file-return-alternatives.md)

调研日期：2026-09-15。本次为设计建议，未修改产品代码。三个子 Agent 分别核查协议、实现和替代方案，并交换关键发现；下文将已核实事实与设计判断分开。

## 1. 用户应该得到什么

请求“生成并返回报告”后，服务端工作区保存报告，调用方从 A2A `Task.artifacts` 拿到文件内容或可访问的文件地址。协议支持 `raw` 字节（JSON 为 Base64）和 `url`，并支持文件名与媒体类型；没有要求使用 `publish_artifact` 工具，也没有规定 staging 目录。[A2A 1.0 Part](https://a2a-protocol.org/v1.0.0/specification/#416-part) · [文件交换示例](https://a2a-protocol.org/v1.0.0/specification/#67-file-exchange-upload-and-download)

协议规定如何传输文件，服务端仍须决定哪些本地文件是交付物。官方 JS SDK 示例由执行器直接组装 Artifact 并发布事件，说明这项工作可以由普通 SDK 代码完成，不需要增加一次模型工具调用。[官方执行器示例](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/samples/agents/sample-agent/agent_executor.ts#L111-L148)

## 2. 已核实的根因和约束

| 事实 | 影响 | 一手证据 |
|---|---|---|
| prepared 调用 `startLocal` / `startDefault`，没有指定 managed-task 模式；Runtime 默认 coding | 没有经过 managed-task 收尾的账本提取 | [binding](../../src/runtime-agent-binding.ts#L1207)、[Runtime 默认值](../../src/sdk-runtime.ts#L10648)、[managed 收尾](../../packages/coding/src/task-engine/_internal/round-boundary.ts#L205) |
| 文件收集器只读 `result.artifactLedger` | 文件在磁盘上，但结果没有账本时漏返 | [server](../../src/a2a/server.ts#L295) |
| MIME 表缺 `.html` / `.htm`，未知类型是 `application/octet-stream` | 只接受 `text/html` 时仍被过滤 | [MIME 映射与过滤](../../src/a2a/server.ts#L285) |
| 通用账本只凭 `write` / `edit` 输入也会生成修改条目 | 失败写入遇到旧文件时，不能把账本当成功证明 | [file-tracker](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L298) |
| 账本是混合记忆记录，合并后只保留最后 256 条；压缩会移走原始消息 | 最终消息补扫与历史账本合并都不能保证长任务产物完整 | [上限](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L46)、[截断](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L640)、[压缩处理](../../packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts#L255) |
| 当前只发布 staging 文件或成功 Skill 晋升的输出 | 补全文件记录不等于普通工作区文件全部自动发布 | [收集器准入](../../src/a2a/server.ts#L307)、[公开 SDK 文档](../../public_docs/sdk/embedder-guide.md#L4614) |

此前已运行过一个确定性对照：真实 prepared 服务和绑定，模拟 Runtime 完成结果，磁盘上有 HTML 文件。没有账本时无附件；有账本但仅允许 `text/html` 时仍无附件；补账本且允许 `application/octet-stream` 后返回成功。它验证两个过滤条件，未完整重现用户的实际 LLM、配置或现场环境。已有两个附件测试也通过，但它们手工提供账本，不能覆盖这个执行链路缺口。[已有测试](../../src/a2a/a2a.test.ts#L1475)

## 3. 方案比较

以下为基于上述事实的设计判断，不是协议要求。

| 方案 | 优点 | 本次判断 |
|---|---|---|
| 在 A2A 端对最终 messages 调用账本提取 | 代码改动最少，能救短任务 | 不作为最终方案：压缩、256 条上限、失败写入和工具覆盖问题仍在 |
| 统一给结果补通用 artifactLedger | 使用已有字段 | 不推荐把它改成交付清单：会混淆记忆与成功写入，影响既有检查证据和消费者 |
| 成功完成边界记录本次文件，随结果返回 | 不依赖模型记忆；不增加工具调用；A2A 只负责准入和封装 | **推荐** |
| 在 A2A 边缘回放工具事件并配对 | 可以利用既有事件 | 不推荐：公开 tool.finished 缺结构化失败标记，还要增加配对、游标、持久状态和恢复处理 |
| 扫描整个工作区或共享 staging | 能看见磁盘上的文件 | 不推荐：无法可靠区分本任务产物、旧文件和并发写入 |
| 新增 publish_artifact 模型工具 | 模型可显式选文件 | 不推荐：不是协议要求；又增加一次可能被漏掉的模型调用 |

事件字段和当前 A2A 的事件处理参见 [KodaXEvents](../../packages/coding/src/types.ts#L540)、[Runtime tool.finished](../../src/sdk-runtime.ts#L19311)、[实现核查](a2a-file-return-implementation.md)。

## 4. 推荐修改

### 4.1 给执行结果增加一个小字段

建议使用 `KodaXResult.writtenFiles`，强调它是“本次成功写入的文件候选”，不是已经授权公开的文件。以下是设计草案，不是已实现的 API：

```ts
writtenFiles?: readonly {
  readonly path: string;
  readonly sourceTool:
    | 'write'
    | 'edit'
    | 'multi_edit'
    | 'insert_after_anchor'
    | 'run_skill_script';
}[];
```

只需路径和来源；不新建 Artifact 服务、注册中心、插件协议或配置层。保留 `artifactLedger` 原有记忆语义和所有现有证据，不用新的文件列表覆盖它。现有结果字段定义及账本用途见 [KodaXResult](../../packages/coding/src/types.ts#L2612)。

### 4.2 在工具完成时收集，任务结束时返回

设计规则：

- 在执行层取得实际执行参数和成功/失败结果时收集，不从最终文字或文件名猜测。实现审查发现，批次结果可能是权限拦截产生的普通说明文字，不能作为实际执行凭证。因此最终接入点为 coding 的 `executeToolCall` / `executeBridgeToolCall` 和 managed 的 `wrapCodingToolAsRunnable`：实际 handler 返回后、结果 guardrail 改写和批次截断前记录。复用同一个小的提取函数，Map 由每次调用创建并经现有执行上下文传递，不新建事件总线。[coding 执行点](../../packages/coding/src/agent-runtime/tool-dispatch.ts) · [managed 执行点](../../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.ts)
- 覆盖现有四种远程原生写工具；`run_skill_script` 只记录工具实际成功返回、且与声明相符的 outputs，沿用当前 Skill 输出校验语义。[远程工具表](../../src/runtime-agent-binding.ts#L209) · [Skill 输出校验](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L222)
- 运行内使用一个按规范化绝对路径去重的 Map，独立于模型消息，因此上下文压缩不会删掉记录。不从旧会话账本恢复候选，不使用通用账本的 256 条裁剪。
- 同一路径多次成功写入保留一项。**若本次运行中该路径已被 Skill 成功晋升，之后又被 edit 等工具修改，去重时保留 `run_skill_script` 这个准入来源**；否则最后一次 edit 会把普通目录中的合法 Skill 产物错误地排除。此处 `sourceTool` 表示候选的可信来源，不承诺是最后一次修改工具。仅有失败或取消的写入不新增候选；先成功、后失败的场景仍须通过交付时文件检查，不能仅凭最后一次请求推断内容。
- 所有正常返回分支携带该字段；managed-task 的结果整形、多轮包装和 Worker/daemon 序列化必须保留它。AMA 集合放在 `runManagedTaskViaRunnerInner` 中、`runOnce` 外侧，跨本次任务的内部多轮合并，在最终构建 `KodaXResult` 时附加；不带入旧任务文件。这是实现与测试要求，尚未完成验证。[runOnce](../../packages/coding/src/task-engine/runner-driven.ts#L2583) · [AMA 结果构建](../../packages/coding/src/task-engine/runner-driven.ts#L2974) · [结果整形](../../packages/coding/src/task-engine/_internal/round-boundary.ts#L220)

### 4.3 A2A 消费文件候选，复用现有发送代码

设计规则：

1. `writtenFiles` 存在时以它为当前运行的候选来源；**空数组也具有权威性**，不能再回退到旧账本把文件补回来。
2. `writtenFiles === undefined` 时，保留自定义/旧 Runtime 现有的 ledger 兼容路径。这个分支不获得“成功写入已核实”的新保证，不追加 messages 猜测。
3. 候选仍经过现有准入：工作区中的 staging 文件，或已成功晋升的 Skill 输出。继续检查真实路径、普通文件、符号链接、大小和 MIME，然后复用 Base64 / A2A Artifact 封装。[现有检查和封装](../../src/a2a/server.ts#L307)
4. `.html`、`.htm` 映射为 `text/html`；调用方和服务端配置的输出类型限制仍然有效，不为让测试通过而绕过过滤。[现有 MIME 逻辑](../../src/a2a/server.ts#L285)

这一步不会移动或复制文件，也不需要模型再次调用发布工具。

### 4.4 明确本次不改变的行为

**本方案保证上述四种原生写工具及已晋升 Skill 输出，在同次正常运行中不会因消息压缩或记忆账本缺失而漏掉符合交付约定的文件；不保证“工作区任意位置写过的每个文件都会返回”。** 后者需要修改当前公开契约；如果选择这种产品行为，需另行明确草稿、脚本、临时文件、修改已有源码等是否交付。A2A 规范无法替项目决定这些规则。[当前公开约定](../../public_docs/sdk/embedder-guide.md#L4614)

自定义 Runtime 的旧 ledger 返回方式继续兼容；第三方 Extension / MCP 的任意文件副作用不属于上述成功收集保证。公开文档虽然描述了 Extension staging，但不能据此假定所有第三方工具已经接入成功产物记录；应核对实际集成及兼容测试，不通过扫描目录或给每个工具新增协议声明来扩大本次范围。[Extension broker 设计](../features/v0.7.69.md#L1067) · [现有收集器](../../src/a2a/server.ts#L307)

不为本问题新增文件系统 watcher、整个工作区 diff、shell 命令解析、上传/下载服务或持久产物数据库。当前默认远程原生工具没有通用 bash，不能为推测的 shell 场景扩大本次修复。[远程原生工具选择](../../src/runtime-agent-binding.ts#L691)

## 5. 验收标准

以下为建议编写的回归测试，不能视为已通过：

| 场景 | 必须验证的结果 |
|---|---|
| 官方 prepared 默认 Agent 和本地 Markdown Agent 生成 HTML | 磁盘有文件，artifacts 中的文件字节与磁盘一致，MIME 为 text/html |
| 不提供通用 ledger；或 ledger 非空但缺该文件 | 新 writtenFiles 路径仍能返回文件 |
| 写文件后强制压缩；之后发生超过 256 条其他操作 | 文件候选仍保留，与消息和记忆账本是否保留无关 |
| write/edit/multi_edit/insert_after_anchor | 每种成功工具都能产生候选，失败、缺失结果不产生候选 |
| 目标已有旧文件，本次写入失败 | 不能因这个失败操作把旧文件作为新产物返回 |
| Skill 输出 | 只接受实际成功晋升的 outputs；失败或仅声明的输出不发布 |
| Skill 晋升普通目录中的文件，随后 edit 同一路径 | 去重保留 Skill 准入来源，返回当前文件字节，不因来源覆盖而漏返 |
| 多次写同一路径；任务间复用工作区 | 本任务内去重，下一任务不能自动继承前一任务文件候选 |
| 普通工作区文件与 staging 文件同时存在 | 仅符合当前准入规则的文件返回，避免无意扩大发布范围 |
| 文件删除、越界、符号链接、超限、MIME 不接受 | 保持既有过滤规则；不得以“发现过路径”绕过检查 |
| writtenFiles 为 [] / undefined | 前者不回退；后者保持旧 Runtime 兼容 |
| blocking、streaming、GetTask、重新打开已保存的 Task | 返回同一组已发布附件；流式附件事件在最终完成事件之前 |
| coding、managed、Worker/daemon 正常结果传输 | 字段不被结果重建或序列化丢弃 |

建议先写能复现失败的公共接口测试，再分两次实现：文件记录链路、HTML MIME。核心验收使用确定性 provider/工具场景，无需依赖真实付费模型。已有附件测试手工构造 ledger，应保留为兼容测试，并增加上述真实执行链路测试。[现有测试](../../src/a2a/a2a.test.ts#L1475)

## 6. 恢复边界和未证实事项

- 已写入 Task 存储的 `artifacts` 可沿既有 Task 查询流程读取；新增候选字段不需要另一套文件存储。[Task 保存](../../src/a2a/server.ts#L1313)
- **进程在“写盘成功、Task 尚未保存附件”之间崩溃的窗口不在本方案保证内。** 当前 A2A 恢复已终态 Run 时只传 phase，持久状态恢复也不一定包含完整 KodaXResult。仅增加结果字段不能解决这一既有问题。[A2A 恢复](../../src/a2a/server.ts#L1599) · [Runtime await](../../src/sdk-runtime.ts#L10999) · [resultFromStatus](../../src/sdk-runtime.ts#L22284)
- A2A 边缘重启而 Runtime 仍存活时，可以优先读取 `runs.await` 的完整结果，这是相邻修正；不要把它描述为完整跨进程恢复。若后续要求消除上述崩溃窗口，应复用既有 Run 持久化另立小范围方案，而不是扫描目录猜测产物。
- 同一固定工作区中并发写同一路径时，路径记录不等于不可变文件快照。本次保留既有“交付时读取当前文件”的语义，不承诺字节级跨任务快照隔离。[现有读取时机](../../src/a2a/server.ts#L315)
- 现场原始响应、实际配置、SDK 安装产物和完整工具记录尚未取得；报告中的历史影响范围不应扩张为“所有版本、所有 A2A 文件都失败”。

## 7. 决策摘要

推荐实施：**一个小的成功写入结果字段 + 两条现有执行路径接入 + 现有 A2A 收集器改读该字段 + HTML MIME 修复 + 公共接口回归测试。** 不新增模型工具，不重写记忆账本，不改变普通工作区文件的发布权限。

未解的产品问题只有范围选择：若需求升级为“普通工作区生成的报告也自动返回”，需要明确产物选择规则；这与本次已确认的漏返 bug 分开处理，避免用一次 bug 修复悄悄改变对外发布行为。

## 8. 修复与验证记录（2026-09-15）

代码已实现上述方案，尚未发布新版本。`KodaXResult.writtenFiles` 提供本次成功写入的绝对路径和工具来源；A2A 沿用原生 `Task.artifacts` 返回文件，不新增模型工具。结果不是文件快照，交付时仍需经过现有发布校验。

### 回归覆盖

- [coding / managed 公共执行测试](../../packages/coding/src/agent.written-files.test.ts)：18 项。四种原生写入工具、桥接调用、权限短路、失败编辑、Skill 实际输出、空白 target、后续编辑、结果改写、260 次后续读取及自动压缩、调用间隔离。
- [A2A 协议与发布测试](../../src/a2a/a2a.test.ts)：74 项。保留旧 ledger 兼容；新增空列表权威性、HTML/HTM、普通文件不发布、越界/目录链接/大小/MIME/缺失文件过滤、去重及流式附件顺序。
- [真实 prepared SDK 测试](../../src/a2a/file-outputs.test.ts)：2 项。默认 Agent 和本地 Markdown Agent 写入 HTML 后，A2A 字节与磁盘一致；重开服务器后 `GetTask` 保留附件。
- [共享 Runtime RPC 测试](../../src/runtime-daemon/server.test.ts)：新增 2 项。验证结果经过 JSON 和 structured clone 两种序列化后，`start().result` 与 `runs.await()` 均保留 `writtenFiles`。这是共享 RPC 边界测试，不冒充真实 Worker/daemon 中的模型执行测试。

上述 96 项相关测试通过。新增记录模块 `written-files.ts` 的行/语句/函数覆盖率为 100%，分支覆盖率为 80%。`npm run typecheck`、`npm run build`、`git diff --check` 通过。

`npm run test:full` 已完整执行并以退出码 0 结束：

| 套件 | 通过 | 跳过 | 待实现 |
|---|---:|---:|---:|
| fast | 1,771 | 32 | 0 |
| unit | 11,623 | 4 | 0 |
| contract | 949 | 0 | 21 |
| system | 1,375 | 42 | 0 |
| 合计 | **15,718** | **78** | **21** |

共 1,027 个测试文件通过、1 个测试文件跳过，0 失败。系统套件包含既有 Worker、daemon、权限、会话恢复、进程退出和清理回归；未运行付费真实模型集成测试。通过项内包含上述定向测试，不将它们重复累加为更多全量通过项。

复现命令：

```powershell
npm run build
npm run typecheck
npm run test:full
node node_modules/vitest/vitest.mjs run packages/coding/src/agent.written-files.test.ts src/a2a/a2a.test.ts src/a2a/file-outputs.test.ts
node node_modules/vitest/vitest.mjs run src/runtime-daemon/server.test.ts -t 'preserves writtenFiles'
```

### Standards

独立规范审查与增量复审：0 项未解决的规范问题，0 项需处理的坏味道。实现保持 coding 包独立，未增加配置项或通用框架。

### Spec

独立需求审查发现的两项问题均已修复并增加测试：权限拦截说明文字误作成功结果；Skill target 与实际工具的 trim 语义不一致。最终生产代码复审：0 项未解决问题。

§6 的崩溃窗口和并发文件快照限制仍然适用。通过回归测试不代表覆盖所有模型输出或部署环境。
