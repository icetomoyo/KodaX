# KodaX 对标 Codex：效率、可靠性与任务表现

本文记录 2026-10-16 阶段。后续最新版源码的同 Windows 完整启动抓包、当前
native 精简后的差额和参数披露验证见 [最新对照](first-turn-windows-comparison.md)。
下文安装版 Codex 与旧 DSH preset 数值保留为历史，不作当前基线。

2026-10-16 实施结论。Codex 源码参照 `400f2356`，实际请求来自安装版 CLI `0.162.0-alpha.17.2`；DSH 参照 `d7432673`。最终改动、测量与评测结果见 [首轮契约精简](first-turn-contract-refinement.md)。

## 输入差额来自哪里

同一估算器统计完整序列化请求，包含工具与 SDK。Codex sol/astra、四项官方 skills 的完整 Responses 请求约 17,182–17,271；11 个 native calls 和 12 项 CodeMode SDK 声明约占 9.3k。没有启用 ranked tool_search，IncrementalTools 默认关闭，不能将其总量归因于全部渐进披露机制。个人 skills 场景约 18.7–18.8k，也不是当前带插件的 Codex 桌面会话总量。

KodaX 最终生产 Runtime AMA 请求约 21,809–22,204，原为 22,672–23,067。OpenAI 场景的工具部分约 14.4k，其余约 7.8k；对上述 Codex 场景的主要差额仍在工具契约。AMA 比旧 SA 多出的 Worker 指导和管理事实属于另一维差额；两者不能混算。

DSH Windows model-facing Web preset 的 Standard 约 8,776、PTC 约 11,145；PTC 返回值 SDK 自身也需要输入。Todo 整表写入不等价于 KodaX 稳定 id、增量、owner 和完成 veto。DSH GUI renderer bundles 不齐，不称完整 GUI E2E；Minimal 不作为优化目标。不同能力、模型协议与 skills 只能定位规模，不能计算严格的同任务质量或效率倍率。

## 保留 AMA 策略，收敛产品入口

| 层次 | 当前取舍 |
|---|---|
| 产品根任务 | CLI/REPL 使用 AMA；未指定的 Product SDK 默认 AMA，显式 SDK SA 继续兼容 |
| Actor/specialist 子任务 | 保留 `child-executor → runKodaX → coding preset → runSubstrate`，使用原有能力和预算 |
| Workflow leaf/digest/repair | 保留直接执行器、专属提示词和短预算，不升级为根 Worker 编排 |
| 在途与历史 | Run、queued continuation、权限等待、取消与恢复保留已捕获引擎；不改写历史事件 |
| 共享底座 | tools、权限、文件锁/CAS、history、缓存、压缩、取消继续复用，各包独立可用 |

AMA 已经是单 Worker loop。简单任务的直接完成、免 Todo 指导和 reminder 豁免原先就存在；本次只回归保留，不另造分类器、AMA-lite、固定多阶段流程或新的禁派发策略。模型是否每次遵循指导不能称作机械保证。

退出的是 SA 用户选择入口：帮助、补全、快捷切换和新配置模板不再教授 SA；旧显式命令返回退役说明。SDK 显式 config/session SA 保留，因为强制迁移会改变原有 effort、Memory、提示词、预算和返回契约。存在未结算 Run 时 Session view 展示捕获的实际引擎；新任务使用有效设置，不静默修改旧 raw 设置。

## 对标后实际采用的改进

| 维度 | Codex 机制 | KodaX 的最小改动 |
|---|---|---|
| 模型适配 | catalog 选择指令、工具模式、推理和协议 | 复用已有 descriptor/兼容投影，不复制每模型整套提示词 |
| 工具契约 | CodeMode SDK 加 native 问答/协作，约 9.3k | 仅精简问答和两项 Todo 描述，保留所有 native schema、handler 和完整派发说明 |
| 能力真值 | 启用、发现、呈现分别建模 | 七项 builtin 协作工具按实际 actorControl 门控，提示词与发现一致；有效 SDK Actor/override 保留 |
| 调度 | 并行资格与共享/独占 gate | bridge→bash 与 native bash 使用同一串行规则；不新增依赖图或开放所有 shell 并发 |
| 执行事实 | 调用身份、执行结果与终止证据区分 | 以实际 call 对象的 executionId 归属事实，重复 provider id 不串账；保留 bridge 的 target 事件和 Sandbox/交互上下文 |
| Host 交互 | 请求归属随运行上下文传递 | AMA 根执行补齐 MCP Session/events scope，修复问答被误取消；root/child 用量事件使用实际身份 |
| 计划与完成 | 模型自主选择，完成与 wake ack 分开 | 保留稳定 id、owner、veto、terminal 证据和根整合责任；不改 AMA 规划/派发策略 |
| 缓存与上下文 | 稳定前缀、状态差分、压缩 | 保留现有管理消息增量、cache affinity、输出容量和持久压缩，不靠搬字段计算节省 |

能力门控依据宿主绑定，而非 `agentMode=sa`。lazy LSP、空 memory 或暂时没有 child 容量都不等于永久没有能力。bridge 调度修复继续经过 target override、权限、取消和结果归属；不能把调度差异称作已证实的权限绕过。

`systemPromptOverride` 通过原 Worker governing prefix 接入；task promptOverlay/recovery seed/Skill 原有接线已核实，不再重复注入。没有重写 AMA 角色 effort 或 Memory 自动介入策略。

已退役链路先核实引用、导出、声明和实际作用，再清理失效 runtime 选择器、空策略工厂/钩子、旧验证命令候选和 Evaluator 提示构造器。只供测试的路径列表移入夹具。两个仅测试调用的 `enforce*Boundary` 辅助函数暂留；不把它们误称生产守卫。30 组 Worker 提示字节一致；该清理不是任务表现或 token 降幅证据。

## 暂不采用的方案

五项完整 schema 延迟披露的试验曾把 AMA 请求降到约 21.1–21.5k。GLM 样本出现较宽泛检索、先收结果再派发的效率差异，未证明因果，但不足以支持默认推进；保留 native schema 的补充样本仍偏基线并行推进，因此完整 `spawn_agent` 契约也恢复。最终只保留三项重复描述精简，约省 3.8%，不把撤回候选的约 7% 写作当前收益。

不因为 Codex 使用 CodeMode 就复制 PTC 运行时；没有 GLM/Kimi/DeepSeek 的同条件质量证据。也不为减少工具数删除 `multi_edit`、改变编辑语法或撤回已有错误恢复。既有搜索/桥接链路用实际 handler E2E 回归，未引入新 discovery 机制。

流式工具提前启动、长命令 session/stdin、更多 schema 披露留作独立的后续性能问题：先测完成参数到执行启动的延迟、重复轮询/补读和任务总成本，有实际收益再设计。当前授权的收紧方案不包含这些扩展。

## 如何判断后续是否值得继续

输入效率看完整请求与实际 API input/output/cache，执行可靠性看权限、取消、原子编辑、调度、终止和恢复事实；不能拿工具数量或 run success 代替任务质量。当前与上述 Codex 场景仍差约 4.5–5k，18–20k 只是待验证方向，不是删功能硬门槛。

首批有限评测在 18 次累计上限内完成。用户随后要求补齐真实编辑 E2E，v7/v8 新增 11 次物理请求，包含一次 GLM 连接失败及仅针对该路线的受控补验；两模型均完成完整 native 工具表下的真实读取、双替换 edit、Node 测试和一致报告。未知 usage 全额保守记账，新增参考成本约 $0.0108，原 $0.05 上限不变，详细分项见首轮精简文档。小样本不证明广域智能非劣、整体加速或达到 Codex 智能水平。首轮下降若被额外发现/补读/重试抵消，或出现可信任务回退，应先读 raw 定位并撤回对应变化。

同模型 Codex 对照仍需独立预注册。当前 `codex-cli` adapter 转交最新消息让 Codex 自行执行，会忽略本地 system/tools，不能隔离 KodaX harness 增益；当前原生 OpenAI adapter 是 Chat Completions，不能声称与上述 Responses 场景同条件。正式文档保留工程结论，完整研究来源、哈希和 raw 路径留研发笔记与 OS 临时目录。
