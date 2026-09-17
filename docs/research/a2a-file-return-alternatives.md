# KodaX A2A 文件返回：怎样修复而不过度工程化？

结论摘要（设计判断）：在 coding 执行层记录本次运行成功产生的文件候选，用一个可选 `KodaXResult.writtenFiles` 字段返回；A2A 继续执行现有发布检查并编码文件。不要新增模型工具，不要扫描整个工作区，也不要把有损的会话记忆账本当作完整交付清单。本文为独立方案挑战笔记，未修改产品代码。

## 已核实的实现事实

- 当前 A2A 从 `result.result.artifactLedger` 取文件，缺字段立即返回空列表；随后仅接纳 staging 路径或 `run_skill_script/promote_output`，并检查常规文件、真实路径、大小、输出类型，最后生成 Base64 `raw` 文件 Part。来源：`src/a2a/server.ts:295`、`:301`、`:307`、`:311`、`:320`、`:326`、`:333`。
- HTML 没有 MIME 映射，因此回退 `application/octet-stream`；如果输出类型只接纳 `text/html`，文件会被过滤。来源：`src/a2a/server.ts:286`、`:292`、`:326`。
- 通用账本对 `write/edit` 只凭工具输入路径记账，没有检查匹配结果是否成功；Skill 提取则要求非错误结果、解析结果中的 outputs，并与调用时声明的 targets 取交集。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:222`、`:226`、`:247`、`:298`。
- 账本是混合的会话记忆：包含读取、搜索、执行等信息，合并时只保留末尾 256 项。它不是无损文件清单。来源：`packages/agent/src/session-lineage/compaction/file-tracker.ts:46`、`:291`、`:383`、`:418`、`:640`。
- 当前 coding 公共收尾没有给结果补文件清单；managed 收尾则有账本提取，使用 `result.artifactLedger ?? extractArtifactLedger(result.messages)`。直接预填 files-only 账本会让 managed 跳过原有其他证据提取。来源：`packages/coding/src/agent-runtime/run-substrate.ts:1144`、`packages/coding/src/task-engine/_internal/round-boundary.ts:205`。
- 外部 `tool.finished` 事件由 `onToolResult` 转发产生；managed observer 的外部回调只传 id/name/content，observer 本身可见结构化 `result.isError`，但其结果已经经过 batch transform，不能当作未裁剪的原始结果。A2A 当前忽略 tool 事件并推进游标。来源：`src/sdk-runtime.ts:19311`、`packages/coding/src/task-engine/runner-driven.ts:2272`、`:2285`、`:2340`、`packages/agent/src/primitives/runner.ts:1408`、`:1427`、`src/a2a/server.ts:1239`。
- 现有回归契约明确要求普通 staging 之外的 `write/edit` 不应隐式发布；同一个 A2A context 可复用 workspace，不能假定 staging 天然属于本次任务。来源：`docs/test-guides/ISSUE_163_v0.7.70_REGRESSION_GUIDE.md:60`、`src/a2a/server.ts:1005`。

## 五个候选方案比较

以下均为设计判断，依据见上一节及各行引用。

| 方案 | 优点 | 实际代价与缺口 | 结论 |
|---|---|---|---|
| A2A 末尾从 messages 补提取账本 | 改动行数少 | 压缩/reshape 后证据可能消失；普通 write/edit 无成功保证；256 条会淘汰。来源：`packages/coding/src/types.ts:2614`、`file-tracker.ts:298`、`:640` | 可作局部验证，不能作为可靠修复 |
| runtime 统一返回原 artifactLedger | 复用字段 | 若只做 context ledger + messages 仍受截断、跨运行记忆和输入推断影响；改账本无损性又会扩大到会话记忆系统。来源：`file-tracker.ts:640`、`round-boundary.ts:205` | 不推荐直接复用混合账本 |
| A2A 消费/重放 tool 完成事件 | 不依赖最终 messages | 需要开始/完成配对、成功状态、持久候选与游标一致性；已有事件丢失原始 isError，尚不能直接胜任。来源：`server.ts:1167`、`:1176`、`:1239`、`runner-driven.ts:2285` | 比源头记录更复杂 |
| 本次工作区 diff 自动发布 | 直观覆盖 shell 写入 | diff 只能证明变化，不能区分报告、缓存、脚本或其他任务的写入；改变现有发布契约。来源：`server.ts:1005`、`ISSUE_163_v0.7.70_REGRESSION_GUIDE.md:60` | 本次不采用 |
| 扫描限定 staging | 可发现非 write 工具生成的文件 | 共享 context 工作区会有旧文件；仅凭存在或修改时间无法证明本次成功生成。改成任务专属目录又是新的输出契约。来源：`server.ts:1005`、`:311` | 本次不采用 |

表格中的 `file-tracker.ts` 指 `packages/agent/src/session-lineage/compaction/file-tracker.ts`；`round-boundary.ts` 指 `packages/coding/src/task-engine/_internal/round-boundary.ts`；`runner-driven.ts` 指 `packages/coding/src/task-engine/runner-driven.ts`；`server.ts` 指 `src/a2a/server.ts`；回归指南在 `docs/test-guides/`。

## 单一推荐：成功文件候选随结果返回

**以下是建议设计，不是现有能力。**

1. 新增一个可选结果字段 `writtenFiles`，元素只包含 `path/sourceTool`。它表达“本次执行成功处理过哪些文件”，不表达“这些文件允许对外发布”。不用它替换 `artifactLedger`，也不改会话账本的截断、读取、检查证据语义。依据：原账本约束与现有 A2A 二次准入分别位于 `file-tracker.ts:640`、`server.ts:311`。
2. 在 coding 已有工具完成接缝收集成功候选：`write/edit/multi_edit/insert_after_anchor` 记录成功操作的路径；`run_skill_script` 仅记录成功晋升的 outputs 与声明交集。路径按当前执行工作区解析、去重，不能从历史 messages 初始化集合，不能用磁盘旧文件存在代替成功证据。四种写工具的现有事实来源：`packages/coding/src/tools/registry.test.ts:424`、`packages/coding/src/tools/multi-edit.ts:82`、`packages/coding/src/tools/insert-after-anchor.ts:31`；Skill 成功语义来源：`file-tracker.ts:226`、`:247`。
3. coding 接缝应在 `run-substrate.ts:2775` 已取得批次执行结果、调用 `:2779` 的 `applyPostToolProcessing` 之前收集，再由 `:1144` 公共收尾返回；managed 接缝应包装 `runner-driven.ts:2201` 既有 `toolResultBatchTransform`，在调用原 transform 之前读取实际 calls/results，最后由 `:2974` 构造 `KodaXResult`。不能用 `:2272` 的 observer 代替这个接缝：Runner 先执行 batch transform 并替换 results，再调用 observer，Skill JSON 此时可能已裁剪。来源：`packages/agent/src/primitives/runner.ts:1408`、`:1424`、`:1427`。应复用原始结构化成功/错误判定，不解析显示事件里的自然语言“成功”；参数/结果已成对存在，无须新增事件配对系统。
4. managed 集合应定义在 `runOnce` 外，与 `toolResultBatchTransform` 一起跨内部轮次/idle-yield 存活，最终在 `:2974` 挂到结果；不能每个 `Runner.run` 初始化一次。现有 `runOnce` 复用 transform，`runWithIdleYield` 复用 `runOnce`，外层返回结果；最后 reshape 使用 `...result` 可保留新字段。来源：`runner-driven.ts:2583`、`:2591`、`:2735`、`:1117`、`round-boundary.ts:219`。这条传播只覆盖同一执行中的轮次，不包括创建新顶层 run 后继续合并旧候选。
5. A2A 优先使用 `writtenFiles`；`[]` 是权威空集合，不回退消息或账本；只有 `undefined` 才保持旧自定义 Runtime 的 ledger 兼容路径，该旧路径不提升成功性/完整性保证。沿用现有 staging/Skill 准入、真实路径、大小、输出模式与 Base64 包装；补 `.html/.htm → text/html`。依据：`server.ts:301`—`:336`。

一个可选结果字段和一个内部文件集合是解决本次已出现故障所需的职责分离；新增发布工具、事件存储系统、递归扫描、配置开关或通用产物管理框架均无须进入本次修改。

设计补充：`writtenFiles` 已与最终总方案对齐；此前的 `outputFiles` 名称及 `action` 字段不采用。`sourceTool: 'run_skill_script'` 只由成功且与声明相符的晋升结果产生，因此不需额外 `action`。同路径去重时，若本次运行已存在经过验证的 Skill 晋升记录，后续普通 edit 不应将 `sourceTool` 覆盖为 edit 并丢掉准入来源；保留 Skill 来源，交付时照旧读取最终内容。这对应现有实现可同时含 Skill/edit 账本条目、依 Skill 条目准入并读取当前文件的行为。来源：`src/a2a/server.ts:307`、`:312`、`:322`。

## 本次必须验证

以下为建议验收标准，针对上文源码揭示的故障路径。

- 官方 prepared coding 入口：四种写工具分别成功生成/修改 staging 文件，真实 A2A 返回的文件内容与磁盘内容一致；HTML 在 `text/html` 协商下可返回。
- 写入失败/取消/未执行，但同名旧文件存在：不能因为旧文件存在将其登记为本次成功产物；失败 Skill 声明输出也不返回。
- 同一 run 中先生成文件、随后发生上下文压缩或超过 256 条其他记忆记录：候选仍存在；managed 内部多轮与最终 reshape 不丢候选。
- 同一 workspace 新任务无文件写入：不能把上一任务候选或 staging 旧文件返回。
- `writtenFiles: []` 不触发旧账本回退；字段缺失时保留旧自定义 Runtime 兼容行为。
- 普通工作区文件、越界路径/符号链接、类型不接受、过大或结束前消失的文件继续遵循已有准入规则；消失文件不把成功任务变成失败。来源：`server.ts:311`—`:326`、`ISSUE_163_v0.7.70_REGRESSION_GUIDE.md:56`—`:63`。

## 明确不能承诺的范围

- **普通工作区每次写入都作为最终文件返回。** 这是改变现有产品契约，不是修复漏读字段。用户应知道上述修复仍保留已有输出目录/Skill 准入；如果期望任意路径自动返回，需要另外决定哪些文件允许交付。来源：`ISSUE_163_v0.7.70_REGRESSION_GUIDE.md:60`。
- **任意 shell/MCP/自定义工具落盘均能发现。** 通用现有账本也没有文件系统完整观察能力；此次明确覆盖四个本地写工具和 Skill 已晋升输出，不猜测 shell 脚本的副作用。来源：`file-tracker.ts:418`。
- **跨进程崩溃后完整恢复附件。** A2A 恢复已结束 run 时当前只传状态给 finishRun；Runtime 本进程拥有 run 时 `await` 可返回完整结果，跨进程持久状态恢复用 `resultFromStatus`，不包含 `KodaXResult`。来源：`server.ts:1617`、`src/sdk-runtime.ts:10998`、`:11008`、`:22284`。可在本次将仍存活 Runtime 的 terminal 恢复分支改用 `runs.await`，但不能因此宣称新增了跨进程附件恢复能力；新持久化清单不是本次必须项。
- **子 Agent 私有工作区文件自动归父任务所有。** 本笔记没有证实所有 child 输出晋升接缝，因此不把该保证写进验收；只接纳已归入当前执行工作区及成功记录的候选。

## 未证实

- 用户现场实际运行是否曾触发压缩、是否属于重启恢复、文件是否确在 staging、实际输出类型配置是什么，不能由静态源码确定。
- 旧自定义 Runtime 返回的 `artifactLedger` 是否可信、是否只含本次成功文件，由其实现决定，SDK 兼容回退本身不能证明。

## 未解问题

- 若产品需要“在普通工作区生成报告就自动交付”，应明确报告识别/准入规则。这是下一项行为决策；不能借本次修复默认发布所有写入文件。
- 需要完整跨进程附件恢复或任意 shell 输出发现时，再针对真实用例确定持久清单或任务输出目录；当前不要预建框架。
