# KodaX A2A 文件返回：实现核验与最小可靠修复

TL;DR：现有 A2A 发送格式已有实现，缺陷在候选文件来源；建议以一个可选的 `KodaXResult.writtenFiles` 字段承载本次运行成功生成的文件，A2A 继续使用既有 staging / Skill 准入和附件编码。不要把压缩记忆账本改造成交付清单，也不要新增模型工具。以下建议基于源码静态核验，未运行真实模型。

基线：仓库 HEAD `eb2168ededda99430faac1ba1d05c0419f254c85`，根包版本 `0.7.96-rc.6`（`package.json:3`）。所有行号均以此工作树读取结果为准。

## 已核实事实

1. **prepared 默认执行确实走 coding 路径。** `prepareExecution` 将执行转给 `startLocal/startDefault`；两者调用 `host.runs.start` 不传 mode；Runtime 默认 mode 是 coding。来源：`src/a2a/server.ts:1677-1695`、`src/runtime-agent-binding.ts:1215-1232`、`:1332-1353`、`src/sdk-runtime.ts:10648-10650`。
2. **coding 返回结果没有自动附加 ledger。** 统一收尾函数当前只合并 managed protocol 和 session snapshot，普通返回只带 messages 等字段；managed-task 外层才有 `result.artifactLedger ?? extractArtifactLedger(result.messages)`。来源：`packages/coding/src/agent-runtime/run-substrate.ts:1144-1159`、`:2992-3000`、`packages/coding/src/task-engine/_internal/round-boundary.ts:205-223`。
3. **A2A collector 缺 ledger 就立即返回空数组。** 有 ledger 时也只认 `file_created/file_modified`；最终读取真实文件并将内容 Base64 放入 `raw`。来源：`src/a2a/server.ts:295-338`。
4. **HTML MIME 缺失是另一处明确缺口。** 当前表没有 `.html/.htm`，回落 `application/octet-stream`；之后按 output mode 精确匹配过滤。只允许 `text/html` 时 HTML 被拒绝。来源：`src/a2a/server.ts:286-292`、`:325-326`。
5. **普通工作区文件默认不交付是既有契约，不是本次漏 ledger 的同义词。** 仅路径包含 `.kodax-a2a-staging` 或成功 Skill promotion 允许；SDK 文档也明确普通 write/edit 不隐式成为附件。来源：`src/a2a/server.ts:311-314`、`public_docs/sdk/embedder-guide.md:4614-4621`。
6. **现有文件集成测试注入了 ledger，未验证默认 coding 生产候选清单。** 两个成功测试使用 `fakeRuntime(..., artifactLedger)`、`createKodaXA2AServer`；分别验证 staged PPTX 与 Skill PPTX，后者同时断言普通工作区 notes 不外发。来源：`src/a2a/a2a.test.ts:1475-1523`、`:1526-1563`。这是这些测试的明确覆盖范围，不代表仓库中不存在其他 prepared 测试。

## 为什么简单补 extractArtifactLedger 不够

- **write/edit 只见到 tool_use 就记为修改，即使对应工具失败或还没返回。** 该分支没有检查 `result.isError`；不能用它证明“本次成功写了文件”。若磁盘上已有同名旧文件，A2A 会读到旧内容。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:298-313`、`src/a2a/server.ts:317-326`。后半句是对这两段代码组合行为的推论，未做现场复现。
- **账本是混合型记忆数据，最多保留 256 条。** 它同时记录 read/search/command/image 等信息；按 kind/sourceTool/action/target 去重，没有调用 ID 的运行归属约束。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:46`、`:281-507`、`:508-515`、`:611-640`。
- **合法的两种写工具也会遗漏。** 远程原生写工具为 write/edit/multi_edit/insert_after_anchor；但 extractor 只专门识别前两种，后两种降为 path_scope，因此 A2A 不收。来源：`src/runtime-agent-binding.ts:209`、`:691-705`、`packages/agent/src/session-lineage/compaction/file-tracker.ts:298-313`、`:483-507`、`src/a2a/server.ts:308`。
- **bash 无法靠账本提取输出文件。** extractor 对 bash 生成 command_scope，不解析 shell 创建的所有文件；prepared 原生工具面也没有默认放开 bash。因此本次不应新增 shell 命令解析器。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:418-481`、`src/runtime-agent-binding.ts:208-209`、`:691-705`。最后一句是范围建议。
- **Skill 的现有提取比 write 严格。** 它要求非错误结果、可解析的结果 outputs，且结果路径必须在调用声明的 outputs 中。应复用这个准入判断，而非只读取 input.outputs。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:221-256`。
- **末尾 messages 已可能被压缩；读取 session ledger 又会带入历史。** 压缩账本单独写入持久化 session，与本次 `KodaXResult.artifactLedger` 是不同位置；持久化函数将原 session ledger 与本次 compaction ledger 合并。来源：`packages/coding/src/agent-runtime/middleware/compaction-orchestration.ts:365-377`、`packages/agent/src/session-lineage/compaction-persistence.ts:27-58`。因此把整个 session ledger 并入本次 A2A 输出会失去本次运行边界，这是推论。

## 两种修复路径比较

| 路径 | 能解决 | 无法可靠解决 / 代价 |
|---|---|---|
| A2A 末尾从 messages 补 ledger | 短任务、工具消息仍在、write/edit 或成功 Skill 的已准入文件 | 压缩前文件、失败写旧文件、256 截断、其他合法写工具；若持续追加修补，会在协议适配层重建执行追踪 |
| 在执行层输出本次成功文件清单 | coding/managed 保持同一返回契约、跨上下文压缩、成功失败分辨、合法写工具覆盖 | 需要一个可选结果字段和两个现有执行落点；恢复到另一个进程是独立范围 |

表中差异根据上一节列出的源码事实推导。第二条是建议，不是当前实现。

## 推荐的具体最小改动

以下是方案建议，尚未修改正式代码。

### 1. 增加一个小的结果字段，保留原账本语义

建议在 `KodaXResult` 上新增可选 `writtenFiles`，元素仅包含 `path`、`sourceTool`。语义是“本次运行成功写入的文件候选”，是否对外发布由 A2A 的既有准入决定。路径在收集时按实际执行工作区转成绝对路径，避免后续 cwd 解释变化。

不改 `artifactLedger`，不删除 checks/read 等记忆，不用它的 256 项截断规则。之所以增加字段，是因为 `artifactLedger` 注释明确服务 round-boundary reshape 的记忆提取，而不是交付清单。来源：`packages/coding/src/types.ts:2613-2621`、`packages/agent/src/session-lineage/compaction/file-tracker.ts:46`、`:611-640`。

### 2. 在已有成功工具结果边界收集，按本次运行持有

- coding：`run-substrate.ts:2777` 附近已有原始 `resultMap` 和 guardrail 更新后的 `result.toolBlocks`；在 `applyPostToolProcessing` 之前收集，避免 Skill JSON 被容量处理截断。复用既有错误分类；只认四种内置写工具和成功 Skill outputs。来源：`packages/coding/src/agent-runtime/run-substrate.ts:2725-2789`、`packages/coding/src/agent-runtime/tool-dispatch.ts:822-867`、`packages/coding/src/agent-runtime/tool-result-classify.ts:49`。
- coding 返回：在统一 finalize 追加本次候选数组，包括 `[]`；不从加载的 session 历史初始化。来源落点：`packages/coding/src/agent-runtime/run-substrate.ts:1144-1159`。
- managed/AMA：它单独构造 `KodaXResult`，不能只改 coding finalize。将同一简单收集 helper 用在现有 `toolResultBatchTransform` 入口、委托原 transform 前，最终在结果上附加。来源落点：`packages/coding/src/task-engine/runner-driven.ts:2201`、`:2974-3001`。
- AMA 的 observer 在 batch transform 后才收到结果，可能已经被截断，因此不推荐从公开 `onToolResult` 回调提取 Skill JSON。来源：`packages/agent/src/primitives/runner.ts:1405-1427`。
- AMA 的 collector 放在 `runManagedTaskViaRunnerInner` 的作用域，跨多个 `runOnce` 保留，不能每轮重建。最终 round reshape 使用 `...result` 可自然保留字段。来源：`packages/coding/src/task-engine/runner-driven.ts:1190`、`:2583`、`:2738`、`packages/coding/src/task-engine/_internal/round-boundary.ts:219-223`。

内部可用一个按规范路径去重的 Map；最后同一路径只读一次实际内容。同一路径先被 Skill 成功晋升、后被 edit 修改时，应保留成功晋升的 `sourceTool` 作为准入来源，否则普通 deliverables 路径会失去 Skill 准入而再次漏返；此处 `sourceTool` 表示产生可信候选的来源，不要求表示最后一次修改工具。不新增注册框架、模型工具、配置开关、目录扫描器或 shell 解析器。此段为实现范围建议。

### 3. A2A 消费结果，并维持兼容性

`writtenFiles !== undefined` 时以它为权威，空数组也不能回退 ledger；字段缺失才沿用旧 Runtime 的现有 ledger 路径。不新增 messages fallback。这样旧手工 Runtime 保留原行为，新 Runtime 获得成功来源保证；旧 ledger 兼容路径不能宣称具有同等保证。

继续复用现有 root/staging/Skill、普通文件、非 symlink、真实路径、大小、output mode 检查和 Base64 包装，补 `.html/.htm → text/html`。现有可复用逻辑：`src/a2a/server.ts:295-338`。

### 4. 文件生命周期的明确语义

- 运行前就有的文件，但本次没有成功写或 promotion：不进入新候选清单。
- 本次只有失败写：不返回碰巧存在的旧文件。
- 本次成功写后又成功覆盖：结束时返回最终磁盘内容，同路径只一份。
- 本次成功写后删除：仍按现有 collector 跳过不可读取文件，不因此把任务改成失败。现有行为与测试：`src/a2a/server.ts:317-324`、`src/a2a/a2a.test.ts:1567-1586`。
- 下一次调用重新建立候选清单，不能因为上次生成过而自动再次交付。

前四条中除删除行为外均是建议验收语义，不声称当前代码已满足。固定工作区由多个并发任务改同一路径时，当前结束读取机制不能证明读到的是哪个运行写的版本；本次不通过新增快照存储系统解决这种共享文件竞争。现有读取时间点：`src/a2a/server.ts:1295-1313`。

## 必须补的回归验证

以下是建议测试，尚未执行：

1. 官方 `prepareKodaXA2AServer` 默认 coding 入口，mock provider 实际调用 write 写 HTML；最终 SendMessage / GetTask / streaming 内容与磁盘一致。
2. staged 文件在上下文压缩前生成，后续 tool messages 不再保留，仍交付。
3. write/edit/multi_edit/insert_after_anchor 成功、失败、未执行；已有旧文件 + 本次失败写不得发旧内容。
4. Skill 成功且 outputs 匹配才交付，失败/未声明输出/结果被显示层截断不误报或漏报；Skill 输出后再 edit 同路径不丢失晋升来源。
5. 同路径覆盖、删除；重复调用不重发上轮文件；普通 workspace 文件依旧不自动外发。
6. `writtenFiles: []` 不 fallback；`undefined` 保留 legacy ledger 测试。
7. AMA 跨多个 runOnce 的清单合并和 round reshape 保留；不影响原 artifactLedger 的 checks 等内容。
8. 不重复扩展已有路径/大小等安全检查测试，只为新候选来源添加必要回归。

## 恢复范围与未证实

- 本次只做源码静态核验，未复现报告现场、未执行真实 provider，也未假装附件的所有论断已验证。
- 新增结果字段本身不解决崩溃恢复。A2A 已终态 Runtime 的恢复分支只把 phase 传给 `finishRun`；Runtime 的 `resultFromStatus` 也不包含原 `KodaXResult`。来源：`src/a2a/server.ts:1599-1617`、`src/sdk-runtime.ts:22284-22297`。本次可验证“已保存的 task.artifacts 可重取”，不能把“Runtime 完成、A2A 尚未保存时崩溃”的窗口当成已解决。
- 外部 Extension / MCP / host tool 任意写文件，没有统一成功输出路径契约的，不能靠本方案自动识别；当前文档“Extension stages”与代码只认 ledger kind 的完整适配是否另有调用方未核实。来源边界：`public_docs/sdk/embedder-guide.md:4614-4621`、`src/a2a/server.ts:307-313`。
- Actor 子运行生成文件如何并入父任务属于另一条运行边界；本次核查了 coding 和 managed/AMA 本身，不承诺所有子 Actor / 远程 Agent 输出传播已经覆盖。

## 未解问题

1. 用户产品预期是否要把所有普通工作区成功写入文件也自动发布？这是与当前文档/测试不同的准入决策，应单独明确，不能用“协议支持文件”代替。
2. 是否需要把 Extension 输出、Actor 子任务文件传播纳入第一批验收？如需要，应采用其已有结构化结果，不扫描整工作区猜测。
3. 是否要同时修复跨进程终态恢复缺少原结果的问题？当前建议本次范围外，另列事实限制，不设计新恢复体系。

