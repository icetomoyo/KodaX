# A2A 是否支持返回文件，以及 KodaX 是否需要新增发布工具？

结论摘要：A2A 原生支持文件产物；服务端可直接把文件内容或 URL 放进 `artifacts`。新增 `publish_artifact` 模型工具不是协议要求。KodaX 应优先修复已有文件收集到返回的衔接，并明确哪些文件属于本次交付。[协议 §4.1.6](https://a2a-protocol.org/v1.0.0/specification/#416-part) · [官方执行器示例](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/samples/agents/sample-agent/agent_executor.ts#L111-L148) · [当前收集器](../../src/a2a/server.ts#L295-L340)

调研日期：2026-09-15。协议固定为 v1.0.0，官方 JS SDK 示例固定为 v1.1.0；本地代码基线为 `eb2168ededda99430faac1ba1d05c0419f254c85`。本文不把附件内的分析或此前对话结论当作证据。

## 1. 核实的协议与 SDK 事实

- **文件返回是协议内置能力。** `Artifact.parts` 中的 `Part.raw` 承载字节，JSON 使用 Base64；也可用 `url` 引用文件，附 `filename`、`mediaType`。任务结果应通过 `artifacts` 交付。[§3.7](https://a2a-protocol.org/v1.0.0/specification/#37-messages-and-artifacts) · [§4.1.6–4.1.7](https://a2a-protocol.org/v1.0.0/specification/#416-part)
- **官方有返回文件的示例。** 规范 §6.7 展示客户端上传图片，服务端在任务产物中返回处理后的图片 URL。[§6.7](https://a2a-protocol.org/v1.0.0/specification/#67-file-exchange-upload-and-download)
- **官方 SDK 允许执行器直接发送产物。** `AgentExecutor.execute` 接收事件总线；示例在普通 TypeScript 代码中构建 `Artifact`，发布 `artifactUpdate`，再发布完成状态。示例没有调用模型发布工具；该事实证明不需要以模型工具作为协议接入前提，但示例自身返回的是文本。[接口 L3–15](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/agent_execution/agent_executor.ts#L3-L15) · [执行器 L111–148](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/samples/agents/sample-agent/agent_executor.ts#L111-L148)
- **协议格式与 SDK 内存对象不要混淆。** 规范 JSON 使用平铺的 `raw` / `text` 等字段；官方 JS SDK 示例的内存对象使用 `content: { $case: 'text', value: ... }`。KodaX 当前自己生成 JSON 形状的 `raw`，不能直接把另一 SDK 的内存对象复制进去。[规范 Part](https://a2a-protocol.org/v1.0.0/specification/#416-part) · [示例 L117–122](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/samples/agents/sample-agent/agent_executor.ts#L117-L122) · [KodaX L328–337](../../src/a2a/server.ts#L328-L337)
- **协议没有替服务端决定本地目录策略。** 上述接口接收服务端构造的内容，不接收“监视整个工作区并自动发布”的配置；由此只能得出：识别文件、选择交付物属于 KodaX 的应用集成职责。不能由“支持文件 Part”推导出“执行中写过的每个文件都必须返回”。[官方执行器接口](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/agent_execution/agent_executor.ts#L3-L15) · [事件总线接口](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/events/execution_event_bus.ts#L55-L65)

## 2. 与本地实现交叉核对

- KodaX 已有完整的文件读取、Base64 编码及 `A2AArtifact` 组装代码；不缺文件返回数据格式。收集器只遍历 `result.result.artifactLedger`，账本缺失时直接返回空数组。[server.ts L295–340](../../src/a2a/server.ts#L295-L340)
- 当前收集器只接受工作区内的 `.kodax-a2a-staging` 路径，或 `run_skill_script` 的 `promote_output` 条目。因此“给普通工作区任意文件补账本”仍不足以让它返回。[server.ts L307–314](../../src/a2a/server.ts#L307-L314)
- 当前扩展名映射不含 HTML，未知扩展名归为 `application/octet-stream`，随后按输出 MIME 列表精确过滤。HTML MIME 缺失能够解释特定配置下的附件遗漏。[server.ts L286–292](../../src/a2a/server.ts#L286-L292) · [L325–326](../../src/a2a/server.ts#L325-L326)
- **账本不是成功写入证明。** `extractArtifactLedger` 的 `write` / `edit` 分支仅根据工具输入生成 `file_modified` 条目；不检查成功结果。扫描中即使找不到对应 `tool_result`，仍会构造条目。若目标路径已有旧文件，“补账本后文件存在”也不能证明本次成功生成了它。[file-tracker.ts L298–309](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L298-L309) · [L556–608](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L556-L608)
- 账本有 256 条上限，合并时只保留最后的条目。因此它即使有值，也不等价于无遗漏的文件交付列表。[file-tracker.ts L46](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L46) · [L640](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L640)

## 3. 方案比较与建议（设计判断，不是协议规定）

以下判断以当前收集器及工具账本实现为前提；选择哪类文件是产品契约，A2A 规范无法代替这项决定。[当前边界](../../src/a2a/server.ts#L307-L326) · [账本提取](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L556-L608)

| 方式 | 能解决什么 | 局限 | 本次建议 |
|---|---|---|---|
| 复用当前交付目录 / Skill 输出约定，在执行层记录本次成功输出供收集器读取 | 直接修复已经声明为交付物却漏返的问题；不新增模型工具；明确本次执行归属 | 普通工作区文件仍需遵循交付约定；shell 输出需实际文件证据 | 优先比较此实现方向 |
| 完成时从最终消息补账本 | 对工具记录尚存的短任务能补齐候选 | 消息可能已压缩；账本不证明成功，也可能包含历史条目 | 仅作为受限兜底，不能作为可靠交付的完整方案 |
| 在当前任务专属输出目录结束时枚举文件 | 能识别 write、shell、脚本等方式产生的实际输出；无需给每个工具增加协议能力 | 必须是真正专属于该任务的目录；共享目录会混入旧文件；需要已有路径与大小检查 | 若用户现场主要靠 shell 生成文件，可作为同一修复中的有限补充 |
| 自动收集整个工作区的写入 / 文件系统差异 | 更接近“工作区写了什么都返回” | 文件改动不等于最终交付；会包含脚本、草稿、缓存；共享目录难以归因 | 本次不推荐 |
| 新增 `publish_artifact` 模型工具 | 模型可明确选择已有文件 | 新增工具调用依赖；模型仍可能漏调用；现有交付路径已经能表达选择 | 目前没有必要 |

**推荐实现边界：** 保留现有 A2A 文件封装与限制；在执行层成功完成工具操作时保留本次输出候选，由收集器读取、检查并包装，同时补 HTML 类型。最终消息补账本最多解决记录尚存的短任务，不能当成可靠交付的完整方案。若另用输出目录收集，就对任务专属目录列举实际文件；不要把整个会话账本直接等同于本次交付清单。具体运行期字段和保存位置应由实现侧核查确定，这些选择都不需要新增协议扩展或模型工具。[现有封装与限制](../../src/a2a/server.ts#L315-L340) · [现有账本缺陷依据](../../packages/agent/src/session-lineage/compaction/file-tracker.ts#L298-L309) · [官方 SDK 接收服务端产物的接口](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/server/events/execution_event_bus.ts#L12-L16)

**普通工作区文件自动返回属于另一个行为变更。** 若最终产品契约要求生成的 `报告.html` 可以位于工作区任意位置，必须同步改变目前的路径准入规则；仅修“缺账本”和 HTML 会不完整。应在确定任务隔离、临时文件排除及最终输出选择后再做，而不把它包装成协议要求。[当前准入规则](../../src/a2a/server.ts#L307-L314)

## 4. 建议的验收标准

以下为对现有收集器边界的测试建议，不声称已运行：一次真实 prepared A2A 调用生成 HTML 文件，最终任务 `artifacts` 中包含可 Base64 解码且与磁盘相同的字节；覆盖无账本、已有账本、本次失败写入但路径已有旧文件、脚本生成文件、重复路径、MIME 不匹配，以及流式完成后查询同一任务。文件不存在或被拒绝返回时，应有可定位原因，避免把“只完成了文本响应”误认为“文件已交付”。[现有收集器](../../src/a2a/server.ts#L295-L340) · [官方产物后完成的执行顺序](https://github.com/a2aproject/a2a-js/blob/v1.1.0/src/samples/agents/sample-agent/agent_executor.ts#L127-L148)

## 未证实

- 本笔记未读取现场 SDK 配置、原始响应及现场文件，因此不能独立确认该用户实际缺失产物的唯一原因。
- 未证实用户生成文件使用 `write`、shell、Skill 脚本还是其他工具；不能承诺只补工具账本就覆盖其场景。
- 未证实当前 `.kodax-a2a-staging` 在所有执行入口均按任务隔离；在验证前，不应直接递归发布该名字下的全部文件。

## 未解问题

1. 这次要维持现有“交付目录 / Skill 输出”契约，还是明确扩展成“普通工作区生成文件自动返回”？后者需要独立的产物选择规则。
2. 用户生成文件的实际工具、保存路径、声明的输出 MIME、客户端接受 MIME 是什么？
3. 文件交付受大小或类型限制失败时，应让整个任务失败，还是保留文本结果并明确报告附件交付失败？协议提供状态和消息容器，但无法替 KodaX 决定业务语义。
