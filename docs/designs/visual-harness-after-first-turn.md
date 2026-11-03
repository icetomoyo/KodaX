# KodaX 首轮优化后的通用主动视觉能力

> 2026-10-29 进展：P0–P2 已实施至 `30310e00`，PNG IHDR 追补已独立复验，6 个视觉测试文件共 44 项通过。支持范围、未解决的全仓测试失败及成本口径见 [实施记录](visual-harness-implementation-2026-10-28.md)；P3–P7 尚未实施，续接使用 [实施要求与验收重点](visual-harness-p3-p7-requirements-2026-10-29.md)。下文“尚未实施/本次复核”等描述保留为 2026-10-28 设计审读的历史状态，不代表后续实施没有发生；模型智能提升仍未验证。

状态：视觉能力推荐设计，尚未实施。2026-10-28 按 KodaX-next-dev 的 2682557e3c3b8d5c8a8dbaf5837b55a220513b82 复核并修订接线与验收；本次不改变已接受的生产默认。最初提案日期为 2026-10-18，源码审读基线 b0b446ec84fd20f21529025d086813eb5bcb2bd0；迁入本工作树时的 5ada4f7c 已是历史基线。VISTA 依据保持论文 v1 与源码 c97c354f0a8948256545a3e8850a1848f8e5b8c1。

## 2026年10月28日适配修订

同日完成能力覆盖、生命周期、性能与验证三个方向的子 Agent 复核。结论是核心机制已覆盖，尚需把 owner、提交确认、派生回显、分页、解码坐标和支持矩阵写成实施契约；下文已补齐这些建议，§12 给出依赖明确的实施计划。此结论表示可以进入分片实现，不表示视觉智能提升、全部 provider 或所有宿主已经验证。

首轮优化阶段已经由用户接受并收口，采用记录为 490ea6de；本次视觉前源码冻结为 2682557e，包含随后合入的恢复、结构化报告及 provider 目录变化。以 [已接受默认与后续边界](agent-under-10k-next-plan.md)、[工作面分配](tool-mode-allocation.md)、[共享契约装配](managed-tool-contract-validation.md) 和 [统一计数](first-turn-uniform-costs.md) 为当前依据；较早首轮/工具入口记录继续作为历史，不再要求重新审议已经采用的优化。

核心目标保留：模型主动选择历史、区域、放大和像素证据，必要时重新观察环境。当前改动允许缩小重复建设，但没有交付可恢复的视觉观察仓库，不能把已支持图片传输等同于本方案已经实现。

| 旧前提 | 当前事实及修订建议 |
| --- | --- |
| 先等待首轮优化收口 | 阶段已接受；从当前 HEAD 冻结视觉前基线，直接进入最小切片，不重开旧候选或评测矩阵 |
| 仅以 SA/AMA 和三份常驻 schema 描述接线 | 产品有 Agent/Coding/Script 三工作面，AMA/兼容 SDK 是另一条轴；通用视觉不标为 coding specialist，沿用实际可见性与模式装配 |
| Script 需要另造图片通道或可自动调用所有视觉工具 | 已有叶结果 typed image 提取和 cell 持久回执；新工具不在显式叶白名单时，首版保留 native/checked bridge，不承诺 tools.visual_inspect |
| 桥接仍有重复工作预算计账 | 该问题已修复；复用 checked bridge 的目标权限、原 wrapper 和一次记账，只补视觉结果相关回归 |
| 773–795 或 54 是新默认成本，800/1000 是统一门槛 | 全部降为历史草案参考；当前按三模式完整模型字段分别比较，不漏算 Script 内嵌合同，也不默认追加旧 98-token 指导段 |
| 关联 toolCallId 即可标识观察/预留 | provider 调用 ID 允许重复；使用 owner 分配的观察 ID，关联精确消息发生位置；预留带 run/generation/batch 范围 |
| 精确 checkpoint / task report 可恢复所有视觉证据 | checkpoint 固定消息 JSON，不固定文件 bytes；report 是展示投影。原件、收据和可见性仍由同一 owner 的媒体与完整历史承担 |
| 为动态视觉新增通用调度/执行日志 | Runner 已有 requiresSerialExecution，Host 已有 invocation unknown 生命周期；复用这些机制，具体环境仍需 freshness→action→current 顺序，桥接/兼容入口须传播目标串行要求 |

### 推进顺序

| 阶段 | 在本工作树完成什么 | 完成依据 |
| --- | --- | --- |
| 0：视觉前基线冻结 | 已接受首轮阶段不重开；固定当前源码、三模式实际工具表、同场景 fixture 与完整模型字段 | 新视觉候选相对同一基线测量，不冒用历史成本或质量结论 |
| 1：最小视觉闭环 | user image 和一个原生 typed-image 来源接纳；稳定 ID、目录、单图/局部/放大检查、真实图片输入、所选 owner 恢复，以及最小同批共享预留 | 实际公共工具到 provider 请求的字节/标签/顺序、原件恢复和并发输出边界均可验证 |
| 2：核实与长任务 | 多时刻/区域、像素采样、更多产品来源、fork 与结构化报告边界 | 原始像素/坐标正确，来源与分支可见性正确，投影不丢必要证据 |
| 3：动态反馈 | 一个受控来源；复用现有串行声明/执行状态，补环境时效与动作后观察登记 | 确定性场景核对已执行/未知、不重放、旧采样不覆盖 current |
| 4：独立环境接入 | 按需求接浏览器/桌面、视频、ARC 或其他后端 | 不要求新模式、统一世界引擎或主体对客户端反向依赖 |

最小共享预留随阶段 1 交付：即使每次只返回一幅派生图，多次 inspect 仍可并行合批。不会把这一安全边界留到多 view 阶段。跨 Host 的 string/structuredContent 桥若还缺真实媒体 materialization，作为该来源的条件性接线，不阻塞本地/native 最小闭环。

### 共用首轮预算与工具曝光

- Coding 仍是默认；Agent 通用工作面和 Script 均可使用视觉。首版三个视觉工具在三种产品工作面中沿用普通 native/checked bridge 接线；独立 SDK、child、专用角色及宿主覆盖保留自己声明的边界。
- Script 已有叶白名单，不为本提案扩大 VM 工具范围或增加 emit-image 协议。已绑定 read 等叶的图片继续复用原通道；未来若确需 cell 内视觉检查，单独显式绑定、只序列化一次完整叶合同，并验证其执行/预算/取消。
- 在现有装配点加入工具，保持 ordinary-root provenance 和统一契约投影守卫；不为视觉重包 Agent 导致已有压缩失效，也不强行给第三方 SDK 对象授予内部投影资格。
- 使用一份短而完整的视觉工具合同；现有 Worker/visual-review 已有实际视觉验证指导。先补缺口，不再默认叠加同义 98-token 段或另一套系统教学。
- 复用已修好的发现/桥接及容量紧张时的统一 schema fitting；不默认启用全量参数按需隐藏，不增加视觉 router、模式、需求分类请求、强制发现或新公开配置。

### 测量与采用判断

采用当前阶段的用户目标：保持任务质量，在完整任务往返基本持平时减少不必要 token。视觉新增了旧方案不能完成的检查能力，需报告新增成本与取证价值；不要求每个样本绝不多一轮，也不以有价值的追加观察自动否决能力。设计强制的分类/发现步骤、持续明显增轮、遗漏证据或不实报告仍需处理。

冻结当前视觉前基线 B 与视觉候选 V，按 Agent/Coding/Script 分别报告 V−B；执行器兼容、独立 SDK/子角色、权限、技能/MCP、宿主绑定、历史、模型/协议与图片条件保持一致。成本包含完整 system/messages/tools 和 Script 内嵌叶合同，不只数 native tools。完整 HTTP 字节另记；图像数、尺寸、实际 bytes/hash 独立登记，不把 base64 文本估算或 1500/图当 provider 视觉计费。

复用 [首轮 wire fixture](../../tests/first-turn-wire-inventory.test.ts)、[统一模型字段度量](../../tests/first-turn-uniform-costs.ts)、[工作模式回归](../../tests/first-turn-work-mode.test.ts)；追加真实初始图片与视觉工具结果的请求格。当前纯文本 fixture 本身不验证图片传输。Script 的普通 native 视觉调用与已有叶返回图片分别验证，不为“支持 Script”强制采用 cell。

先做确定性验证；只对主模型是否主动选对证据、是否修正判断等剩余问题，按 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md) 另立受控实验。既有收口证据、失败和预算不重置，不重跑整套历史优化来作为视觉基线。

### 本次复核边界

本次只修订设计并保留未实现状态。36 项既有 Script model / checked bridge boundary 回归通过，确认现有 typed-image 收据和桥接边界仍可复用；这不是新视觉接纳、持久化、provider 全路径或模型智能的验收。未调用外部模型、未运行付费实验、未修改生产源码。

其中 36 项是同日上一轮适配复核的结果；本轮子 Agent 完备性讨论仅做源码/论文核对和设计一致性检查，没有重跑生产测试，也没有新增视觉实现。必要合同与计划保存在本文，ignored 调研笔记只保留审查过程，不作为实现必须读取的唯一规范。


## 1. 推荐结论

为 KodaX 增加一套**可选、按需工作的通用主动视觉能力**：保留实际收到的原始观察，为模型提供稳定的历史引用、局部检查和像素采样；主模型在推理需要时选择证据，必要时通过环境工具获取新的观察，再据此修正判断和行动。

核心改造围绕“观察 → 提问 → 选择证据 → 检查 → 更新认识 → 行动/回答”形成闭环。它服务于图片、文档、图表、网页、动态界面、视频采样和交互环境。ARC-AGI-3、游戏、桌面控制与 HyperFrames 都可另行接入，不是主体改造的前提。

推荐把观察与检查的通用接缝放在 agent 的可选 media 能力中；coding/Host 连接现有输入、工具、持久化和行为指导；具体环境继续负责渲染、采样和执行动作。llm 层继续负责模型能力与图片传输。没有对 Space 或任何客户端的反向依赖。

这是一项范围可控的**中等改动**。裁剪函数本身很小，真正需要交付的是稳定身份、原图生命周期、模型可见引用、跨压缩恢复、预算和动态环境的时效语义。只增加裁剪/像素工具，不能算完成本提案。

## 2. 从 VISTA 借鉴什么，哪些不能直接照搬

以下“源码事实”限定于上述固定版本；后文的 KodaX 接口、限制和顺序都是本提案的工程建议。

| VISTA 的通用机制 | 对 KodaX 的借鉴 | 实现边界 |
| --- | --- | --- |
| 归档已收到的视觉观察，保留身份、来源和派生关系 | 把原始证据与上下文中的摘要分开，允许后来产生的新问题重新检查旧图 | “原始”指接纳时实际拿到的图；不能恢复采样前、压缩前或从未收到的信息 |
| 按历史时刻、帧、区域选择视图，返回真实图片 | 模型主动重组视觉输入，同时比较旧状态与局部细节 | 工具执行选择、裁剪和展示；理解和比较仍由主模型完成 |
| read_pixels 将选区转成离散颜色样本 | 颜色、边缘、网格关系不明确时，补充数值证据 | 是采样，不是目标识别、OCR、分割或自动求解器 |
| 根据当前认识预测行动结果，再检查反馈 | 用短行为指导鼓励提出可验证的问题、根据证据修正假设 | 不引入每步额外的规划模型、视觉裁判或强制反思轮次 |

依据：[观察契约](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/contracts.py#L43-L169)、[inspect 实现](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/session.py#L519-L638)、[像素采样实现](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/session.py#L675-L805)、[静态任务指导](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/benchmarks/babyvision/profiles.py#L27-L48)、[交互指导](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/prompts/codex.md#L1-L7)。

论文中的静态 BabyVision 和跨时刻交互例子说明，这些机制有独立于 ARC 的使用价值。但消融中，加入记忆/检查的同时改变了自动送入的帧数，不能把全部收益单独归于记忆或裁剪，也不能据此承诺 KodaX 的提升幅度。[论文 §4.3、§5、Fig.10、Fig.14](https://arxiv.org/html/2610.02200v1)

三个实现差异必须保留：

- VISTA 通用像素路径有颜色量化，ARC 路径另有调色板处理；KodaX 首版应明示自己的采样精度，不能把所有输出宣传为精确原色。[颜色编码](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/support.py#L507-L578)
- ARC adapter 的归档帧数与默认展示帧数是两回事；不把“总是只展示末帧”移植成通用策略。[ARC 帧处理](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/benchmarks/arc3/codex/controller.py#L697-L819)
- VISTA GameWorld 可在模型推理期间暂停环境。它不证明普通桌面、实时视频或游戏在持续运行时已有可靠控制能力。[GameWorld 时钟控制](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/benchmarks/gameworld/engine.py#L180-L212)

### 2.1 完整借鉴范围与取舍

这里的“采用”均表示本提案计划采用，不能理解为已经实施。

| 部分 | 处理 | 原因 |
| --- | --- | --- |
| 真实视觉输入、原件身份、历史目录、局部/跨时刻/多 view/放大、像素采样 | 主体采用，见 §5–6 | 让主模型在推理中重新选择证据，是主要通用增量 |
| 主模型主动取证、按反馈修正环境理解、预测相关行动的可见结果 | 主体采用，见 §7–8 | 保留智能选择，工具只提供证据，无额外每步裁判 |
| GUIDE 的可复用理解与 WORKING 的当前计划/预期/矛盾 | 采用职责区分，复用现有状态与摘要 | 借鉴语言记忆，不强制同名文件；临时状态随适用范围变化而失效 |
| checkpoint 与恢复后的当前依据、notes、最后动作/结果 | 采用续接语义，复用现有提交/压缩/恢复 | 原图仍在磁盘不等于主模型已拿到继续所需信息；状态提交成功后才切走 |
| 精确动作/结果 history，attempt/episode 边界 | 回链既有历史；特定游戏 attempts 视图随 adapter | 视觉目录应能解释观察由何而来，无需复制日志数据库 |
| 归档已接纳的所有观察、自动入模只取子集 | 主体采用两者分离 | 保存范围与首轮/每轮输入量分别控制；不移植固定末帧策略 |
| TaskSession、provider transport、checkpoint marker/fresh-session 运行循环 | 采用职责与结果保障，复用 KodaX owner/Runner/provider | 不再并行运行一套 Python/CLI harness；CLI 图片桥逐路径验证 |
| 去重、执行结果不确定性、有界运行和取消 | 采用原则，复用既有执行控制并补必要接缝 | 保证历史检查不重放动作，不照搬实验重试次数与进程参数 |
| ARC、GameWorld、具体浏览器/桌面动作及环境暂停 | 可选后端/extension，主体用一个受控动态来源验证 | 环境能力与通用视觉能力分层，实时世界不能假定可暂停 |
| 每通道 4-bit 颜色量化、字符调色板等特定编码 | 首版不照搬 | 有界精确采样保留细微颜色与 alpha；未来需要压缩时再比较收益 |
| 16 views 等实验常量、默认帧数、特殊状态字段 | 根据宿主预算与来源另定 | 它们不是通用最优参数；本提案的初始护栏也需校准 |
| 全局禁用 shell、skills、multi-agent 等工具白名单 | 不作为 KodaX 默认 | VISTA 的受控运行/评测隔离不能直接替代通用 Agent 的能力与权限策略 |

语言记忆、续接与动作历史依据：[checkpoint 字段](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/tools.py#L237-L260)、[恢复输入](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/session.py#L289-L338)、[动作和 attempts 历史](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/benchmarks/arc3/codex/controller.py#L554-L695)。后端与隔离依据：[Codex 工具注册](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/backends/codex/runner.py#L927-L950)、[图片交付](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/backends/codex/runner.py#L1248-L1353)、[运行隔离](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/backends/codex/runner.py#L261-L318)。

需要纠正一个可能的推断：固定 VISTA 实现中 save_compact_checkpoint 只在已有 pending marker 时接受，Codex PreCompact hook 先建立该边界。能确认的是“Host 管理边界、模型撰写继续状态”，尚不能确认“模型可随时自主开启 fresh context”。后者若将来提出，应作为新增候选，不算本提案遗漏已有 VISTA 机制。[pending 检查](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/session.py#L393-L403)、[PreCompact hook](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/backends/codex/lifecycle.py#L291-L328)

独立视觉裁判、语义向量记忆或自动目标跟踪，不是上述核心 inspect/read_pixels 工具已提供而本方案删掉的功能。不能把本提案暂不建设的所有高级能力，都误列为“没有借鉴 VISTA”。

## 3. 最终能改善哪些任务

以下是设计目标与使用场景，尚无 KodaX 迁移实测。

| 场景 | 新能力带来的具体行为 | 仍然依赖什么 |
| --- | --- | --- |
| 图片、截图、文档检查 | 从整体定位疑点，再裁剪小字、细线、标记；比较多个版本或页面 | 原图质量、模型能力；读文本/结构化数据更直接时继续使用原工具 |
| 图表、网格、流程图分析 | 对选区读取有限颜色样本，复核连通、边界、颜色关系 | 数值采样不自动等于语义解释；原始数据优先用于精确数值计算 |
| 动态界面、动画、视频采样 | 对同一问题选择几个时刻，区分旧状态、变化过程与新观察 | 后端实际采到的帧、时钟和定位信息；不补造遗漏瞬间 |
| 长任务与上下文压缩 | 新假设出现后仍能回看早期原图，不只依赖当时写下的摘要 | 证据保留、来源可见性、恢复接线 |
| 浏览器、桌面或游戏 | 先观察、形成假设，必要时悬停/展开/移动视角获取新证据，再验证结果 | 相应环境 extension、权限、动作工具和时效检查 |

即使不跑 ARC，前四类也能直接使用主体能力。改变的是模型可选的证据和验证路径；不能承诺所有普通任务、纯文本推理都会因此变强。

## 4. 分层与依赖

下图表示观察的运行时接线；包依赖继续遵守 llm ← agent ← coding ← repl，Artifact 等独立后端由 Host 装配。

~~~mermaid
flowchart TB
    H["coding / Host：输入接纳、会话持久化、工具装配、行为指导"]
    V["agent 可选 media 能力：观察引用、历史目录、inspect、read_pixels"]
    L["llm：模型输入能力、图片准备、provider 传输"]
    S["既有 Session / lineage / media：原件与记录的实际 owner"]
    B["独立后端 / extension：Artifact、浏览器、桌面、视频、ARC"]
    H --> V
    H --> S
    V --> L
    V --> S
    B -->|"由 Host 映射观察，或向注入的接纳函数提交"| H
~~~

图中的 Session/media 访问通过调用方注入的窄接缝完成，不让 agent 导入具体客户端存储。后端与 Host 的交互不是包之间的循环依赖。

| 所在层 | 本次职责 | 复用与约束 |
| --- | --- | --- |
| packages/llm | 保持真实多图传输、能力检查和已接纳字节的一致性 | 不引入视觉任务模型、观察数据库或环境动作；一般不需改变公开 image block |
| packages/agent 的可选 media 入口 | 最小观察描述、接纳/解析辅助、目录投影、三个只读工具的工厂与坐标处理 | 使用 RunnableTool；存储 owner 注入；解码惰性加载；独立 SDK 可用 |
| packages/coding / Host | 连接 user/read/MCP/Artifact 图片、已有持久化与预算，提供行为指导 | 不新建第二 transcript writer；不要求 SDK 使用 REPL 或 MCP |
| packages/artifacts、其他 extension/客户端 | 产生图像证据，提供环境特有的重新渲染、采样与动作 | Artifact 的现有 provenance/locator 是原始依据；agent 不反向依赖 artifacts |
| REPL、窗口化宿主 | 输入展示与工具装配 | terminal 也能检查图片；桌面操作由拥有桌面能力的宿主提供 |

分层沿用现有约束：[HLD](../HLD.md)、[PRD](../PRD.md)、[Artifact SDK](../ARTIFACT_SDK.md)。packages/agent 是可独立使用的通用库；workMode=agent 是产品的通用工具面，两者不能混称。视觉能力服务于 Agent/Coding/Script，不要求改用 Agent 模式或替换 AMA。独立 SDK 由调用方装配工具与 owner；安装 KodaX 不自动获得操作系统控制权限。

| 产品工作面 | 首版视觉接法 | 必须保留的边界 |
| --- | --- | --- |
| Agent | 通用 native/checked bridge 工具；不标为 coding specialist | 不补回无关 Repo/LSP 常驻合同；现有可见性/宿主授权不变 |
| Coding | 相同通用视觉工具，复用普通根装配与统一投影 | 编码能力和现有 AMA 策略不变 |
| Script | 新视觉工具暂留普通 native/bridge；既有 read 等叶返回图片复用现有透传 | 新视觉工具不自动成为 cell 叶；完整叶合同已在首轮，不能把 script_exec 当廉价空壳 |

当前接线依据：[模式解析](../../packages/coding/src/work-mode.ts)、[Script 叶白名单](../../packages/coding/src/agent-runtime/script/pilot.ts)、[Script 图片与模型表投影](../../packages/coding/src/agent-runtime/script/model.ts)、[普通根投影资格](../../packages/coding/src/tools/managed-tool-contract.ts)。

## 5. 观察接纳与身份：先保证“再看的是当时那张图”

### 5.1 最小语义

“观察”表示某个来源在某次输入、采样或动作后实际交付的一幅图。事件身份与图像内容身份分开：两个时刻即使像素相同，也可以共享原件，但具有不同 observationId；重复交付同一次结果使用原 ID，避免重复登记。

逻辑上需要以下信息。优先引用既有字段，只为缺失部分补映射；这不是要求重造 Artifact 类型或增加一套持久化 schema。

| 信息 | 用途 |
| --- | --- |
| observationId、来源消息/工具调用/动作、所属 session/branch | 稳定选择与访问可见性；ID 不随物理文件名、fork entry 重编号改变 |
| sourceKey、observedAt；来源提供时附 revision、序号、媒体时间或 frameIndex | 区分来源与顺序；墙钟、视频时间和动作序号不混用 |
| 原件引用、完整内容 hash、MIME、原始宽高 | 固定实际接纳内容，防止同一路径被覆盖后变成另一张图 |
| 已有 provenance/locator，必要的坐标映射 | 关联页、状态、视口、时间等；缺失字段明确 unknown，不伪造 |
| 派生关系与保留状态 | 标记裁剪/缩放来自哪张原图，以及引用是否仍可用 |

ID 是不透明引用，不能让模型通过猜路径或 ID 越过既有会话访问范围。内容 hash 用于完整性和去重，不当作观察发生身份。provider tool-call ID 可重复，只作辅助关联：稳定发生身份由 owner 分配，绑定原 session/逻辑 entry、精确消息及 block/item ordinal；在需要时附 run/generation/batch 范围。Script 来源再关联既有 cellId、leaf receipt 与 image ordinal，不用同一短调用 ID 混并不同观察。[精确调用上下文](../../packages/agent/src/primitives/runner-tool-loop.ts)、[按发生位置处理结果](../../packages/coding/src/task-engine/runner-tool-result-batch.ts)

“当前”只表示该来源最后登记的一次观察，必须同时展示观察时刻/版本；它不保证现实环境此刻未变化。多页面、多窗口、多来源分别有最新观察，不设置全局唯一 current 图。

### 5.2 接纳顺序与原件生命周期

在输入 adapter 或工具仍持有实际 bytes 时，复用既有验证，固定原件、登记收据，再对外返回可回取的 observationId。若已有附件是不可变且由 owner 保证存续，可以 pin 引用；否则在现有 owner 的 media 区域保存一次接纳快照。不能仅保留任意临时路径，更不能在文件被覆盖后重新读取并称作原观察。

归档保存接纳时的 bytes，展示可以另外缩放；若上游只交付了缩略图或有损图，就记录该限制。已有粘贴图的归一化、临时文件清理不自动等于长期原件保留。复用现有验证与 prepareValidatedImageBlock，避免重复编码或从 provider base64 回读建档。[图片准备](../../packages/llm/src/providers/image-serialization.ts)、[MCP 图片接纳](../../packages/agent/src/capabilities/mcp/runtime.ts)、[现有媒体保存](../../packages/agent/src/media/persist-image.ts)

收据和图片先后提交可能留下孤儿文件，但不能留下宣称可用却没有原件的引用。文件与记录不需要分布式事务；沿用 owner 提交边界，对未完成接纳明确报错，孤儿文件交给同一生命周期管理。内存 owner 可以提供单 run 能力，但必须声明不支持跨重启；产品持久化 owner 才能承诺 durable。

所有**明确接纳**的观察按 owner 的现有保留策略管理，默认送入模型的子集另行选择。不要为通用视觉承诺录下全部屏幕/视频，也不要静默超额删除后仍宣称完整历史。过期、清理或缺失的引用返回明确状态；首版不新增用户保留策略开关。

首个持久化消费者选产品 Runtime 的 canonical SessionManager/storage，先支持普通非 fork invocation。它已显式设置 session.storage / persistedByHost=false，并在新消息提交时等待 required persistManagedBoundary；仅传入 storage 的其他 standalone 路径仍可能 best-effort，不能直接继承 durable 保证。agent/media 只依赖注入的能力，不依赖 Runtime 或 REPL 实现。[Runtime 装配](../../src/sdk-runtime.ts#L14829)、[消息提交边界](../../packages/coding/src/task-engine/runner-driven.ts#L2568)、[required 与 best-effort](../../packages/coding/src/agent-runtime/middleware/session-snapshot.ts#L342)

接纳期间可分配 provisional ID，但成功的持久确认须等原件固定和同一 owner 的 canonical/receipt 提交完成。工具路径优先复用现有 materialization / toolResultBatchTransform 附小收据，随最终 tool_result 的 onMessageCommitted 提交；初始 user image 则随输入的 canonical 边界提交。现有 onToolResult 通知发生在该提交之前，不能拿 UI 事件当 durable ACK，也不能从 observer 再写第二份日志。失败时不得把 provisional 当已恢复记录公开；原路径覆盖、写入中断、重复交付均须用故障注入验证。[Runner 提交顺序](../../packages/agent/src/primitives/runner.ts#L1452)

首片就检查 session/owner/lineage 访问范围；尚未支持 fork 继承时明确拒绝解析继承记录，不能等后续支持 fork 才补授权。原件保留和清理属于同一 owner：先写文件后提交收据可能产生孤儿，清理不能删掉仍被可见记录引用的文件；不得借用粘贴临时目录 TTL 宣称跨重启可用。

首版新增快照放在该 owner 管理的 session 媒体命名空间，随 Session 保留；archive 不等于删除，真正删除时接入原 owner 的删除/重试流程。现有删除代码只认识其 canonical/sidecar/cache 文件，媒体清理需要显式补接，不能假定自动覆盖。先不建跨 session 内容池或引用计数数据库；fork 继承时优先复制需要保留的原件，若复用引用则必须先证明原 owner 删除后仍保证其存续。具体布局留给实现，不新增用户保留配置。[现有删除流程](../../packages/repl/src/interactive/storage.ts#L6304)

初始图片还有输入幂等边界：Runtime 当前按 canonicalInputId 检查已有 user content 是否与本次意图相同。新增 snapshot path/标签不能让相同输入重试变成冲突，也不能绕过“同 ID 不同意图”的拒绝。应在同一 owner 的输入接纳边界先查已提交 receipt，校验原请求意图后复用原 ID/快照；只有新输入才读取并固定 bytes。重启后原路径已改变的同输入重交付，仍须指向原快照。收据与 user message 随原提交保存，不另写提前成功日志。[现有输入幂等检查](../../src/sdk-runtime.ts#L12329)

第一片限定首条 immediate 输入；after_turn/redirect 队列及 steer 中断输入在补齐前，不把普通排队回执称作视觉接纳确认。若对这些入口承诺“收到时那张图”，须在原入队/接纳边界固定 bytes，并复用其既有 pending input 记录；不能等下一 Run 开始才读取可能已变的路径。这些入口在发布通用产品能力前补齐或明确排除，不新增队列日志。[Runtime 输入路由](../../src/sdk-runtime.ts#L13008)

### 5.3 接入当前 KodaX 的具体接缝

- Runner 的 tool_result.metadata 可以承载小型 JSON 安全收据，但 provider 不把它作为模型可见内容。图片旁必须有短文本标签，例如“obs_17，来源 chart，修订 r3，1200×800，观察于……”。[结果构造](../../packages/agent/src/primitives/runner-tool-loop.ts)、[消息类型](../../packages/llm/src/types.ts)
- 普通 coding/extension handler 当前主要返回 content；它不能直接假定自己可写 Runner metadata。首版由现有 owner 的接纳/materialization 路径附收据，或用同 owner 既有记录关联精确调用发生位置，原 toolCallId 只作辅助；直接 RunnableTool 可以使用已有 metadata。避免为此重造通用 ToolResult 协议。[coding 工具类型](../../packages/coding/src/tools/types.ts)、[工具包装](../../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.ts)
- 最初的 user image 也进入相同接纳流程：固定 bytes、分配 opaque ID、附可见标签，机器记录关联输入消息与图片序号。独立 Session 当前不能假定已持久化 inputId/turnId；可以依靠持久 entry/opaque ID，不为视觉新增 llm 消息类型。[Runner 提交](../../packages/agent/src/primitives/runner.ts)
- 已有 prepared-image 缓存保证 run 内复用，但不是跨重启的原件仓库，公开 inspectPreparedImage 也不返回归档 bytes。首版在原 adapter 持 bytes 时接纳；若某路径只能晚接，必须补窄的已接纳字节读取接缝，禁止重读可变 path 冒充缓存内容。

来源工具的 UI 事件、内存 append、canonical 提交、owner durable 提交、provider 实际收到图片，是不同阶段。方案与验收分别检查，不把“工具调用成功”直接记作“模型已看懂”。

Script 已把可信叶结果中的 image block 提取到外层多模态结果，并把完整 call/receipt 写入同一 Session 的 cell 记录；guest 自行返回一个路径不能伪造图片。视觉接纳读取这些原始回执，不把模型侧 value_from_receipt 等同响应去重引用当成跨请求观察 ID，也不新增 Script 图片协议。[模型投影](../../packages/coding/src/agent-runtime/script/model.ts)、[cell 提交](../../packages/coding/src/agent-runtime/script/run.ts)

P2 接 read 来源时，Script 叶的原件也必须在 call.settled 持久回执前固定，不能等外层 script_exec 返回图片时才重读路径。外层传播已有观察身份而不重复接纳；以“叶已完成、外层未返回时中断/路径被覆盖”为恢复反例验证。[叶回执时点](../../packages/coding/src/agent-runtime/script/run.ts#L85)

Product Host 工具入口的 string/structuredContent 不自动等于 typed-image 通道；需要该来源时，由宿主媒体 adapter 明确 materialize 并接纳原 bytes。首版先接可实际返回 typed image 的来源，不为此重构全部 Host bridge。[Host 结果合同](../../src/client-host-authorization.ts)

接纳入口区分“来源交付的新观察”与“已存观察的检查回显”。visual_inspect 的原图/裁剪/放大结果只携带原 observationId 与本次变换，不再次归档为新的源事件、不刷新 source current、不递归增加目录；同一来源后来实际交付的相同 bytes 则仍可构成新事件。该分类由可信工具/adapter 元数据决定，不由任意返回文本决定。VISTA 也将 inspection 标为 current_state_unchanged。[VISTA 检查回显](https://github.com/joshhhhhan/VISTA/blob/c97c354f0a8948256545a3e8850a1848f8e5b8c1/src/vista/core/session.py#L543-L551)

checked bridge / Script 包装须保留实际目标的来源或派生属性；不能简单跳过所有 bridge 图片，否则 read 等来源的新观察也会被漏掉。对 inspect 重复调用、通过桥调用与原生 read 的组合做回归，检查目录数量与 current 始终符合来源事件。

## 6. 三个只读工具：最小而完整的证据选择面

以下名称和参数是建议契约，尚不是现有 API。工具不调用第二个模型，不回答 question 的语义；question 和 view 的 label 用于表达本次取证目的与结果对应关系，不要求输出长篇推理。

| 工具 | 建议输入 | 结果与职责 |
| --- | --- | --- |
| visual_history | sourceKey、before/after 或 cursor、limit 等必要过滤条件 | 有界目录：观察 ID、来源、时刻/版本、动作关联、尺寸、可用状态；从同一历史 owner 投影，不新增数据库或向量检索 |
| visual_inspect | question、按序 views，每项含 label、observationId、可选 region / displayLongEdge | 返回原图、区域或放大展示的真实 image block、来源与坐标变换；可跨时刻、跨区域并列检查 |
| visual_read_pixels | question、按序 views，每项含 label、observationId、region、rows、columns | 返回采样坐标、明确精度的 RGBA 值与局部调色板索引；用于有限离散测量 |

目录可以按需读取持久收据/完整 lineage，不能每次模型调用扫描所有历史或打开所有图片。没有新视觉记录时不维护昂贵后台索引。已有 session_history_search/read 继续负责通用消息检索，visual_history 是同一 owner 的图像目录投影。

首版目录按 owner 的稳定接纳顺序返回最近一页，不以可能相同或回拨的墙钟排序。opaque cursor 固定查询的 owner/lineage、过滤条件及首请求的上界；后续新增记录不插入已开始的翻页，重新查询才看到新增项。分页按稳定发生身份去重；分支或查询条件不匹配时明确拒绝复用 cursor。沿用 owner 的读取机制，不为分页另建后台索引服务；目录结果有界且不解码图片。

### 6.1 空间与展示

region 使用原图像素坐标，左上角为原点，整数 x/y/width/height，半开区间。越界、不合法或零面积区域明确拒绝，不静默裁成另一个区域。裁剪输出附原 observationId、原区域、输出宽高与坐标映射；它不是新的环境状态。

裁剪集中展示已有细节；需要局部放大时，模型可用 displayLongEdge 请求展示长边尺寸。它是本次检查的输入参数，不是新的用户配置。首版采用保持比例的最近邻重采样，参数与实际输出受既有尺寸/预算上限约束；省略时保留原生尺寸，必要缩小时明确标注。这样既支持直接裁剪，也支持主动把小选区重新作为较大视觉输入，不把“裁剪”与“放大”混为一谈。

展示变换不增加原图信息，精确测量始终基于固定原件，不能从放大图反测原像素。首版派生展示使用 PNG，复用现有媒体的最大展示长边（当前 2000）和字节预算；超限时要求缩小范围/展示尺寸，不自动套用粘贴图的 JPEG 降质链。输出标明重采样方式与实际尺寸。[既有展示限制](../../packages/agent/src/media/image-normalize.ts)

渲染后端需要高 DPI 或相机变化时，另行产生新观察并标明来源，不能覆盖旧 ID。

返回顺序与请求顺序一致，每张图旁都有可见标签。多图是分别可引用的图片；无需强制拼成 contact sheet。只有宿主协议确实要求拼图时才适配，并保留各子图坐标与身份。

### 6.2 像素数值语义

首版采用**选区等分网格的格心采样**，不加任意测量 DSL。对于列 c、行 r：

~~~text
sampleX = x + floor((c + 0.5) * width / columns)
sampleY = y + floor((r + 0.5) * height / rows)
~~~

rows/columns 为正整数且不超过区域像素高/宽，避免重复采样冒充更高分辨率。输出坐标相对于原图；值为声明的解码流程所得 8-bit RGBA。调色板采用单次调用的精确值去重与整数索引，不引入固定 64 字符限制，不默认复制 VISTA 的有损颜色量化。

“精确”限定于声明的解码像素；JPEG、抗锯齿、色彩配置和 alpha 处理会影响结果，不能声称测到了现实物体原色或屏幕物理色。遇到不能保证该解码契约的格式/色彩模式，应明确 unsupported，不能静默降精度。保留 alpha，不把透明色自动合成为某个背景。

inspect 与 read_pixels 必须共享同一声明的 raster 坐标与解码 profile：方向/EXIF、宽高、色彩转换、位深和 alpha 解释一致，并能从展示坐标回到该 raster。实现前固定支持样本与期望像素；先用无方向元数据的 8-bit 静态 PNG 验证，再扩到 JPEG/其他明确支持的 profile。不能一个工具按自动旋转后的图裁剪，另一个按未旋转 bytes 的宽高采样。动画容器须显式选择帧或返回派生检查 unsupported，不能默取首帧却声称覆盖整个过程。

这只约束新派生/测量能力，不把已有图片上传和 read 改成 PNG-only。原件接纳保持已有 MIME/验证语义；全图回取在允许的输出边界内可直接使用固定 bytes，不必为了第一片先开发完整像素解码器。不能保证的派生操作明确不可用，原图仍保留。现有 normalizePastedImage 会缩放及尝试 JPEG 降质，因此不能直接充当无损裁剪/像素实现。[既有 read 图片路径](../../packages/coding/src/tools/read.ts#L370)、[粘贴转换](../../packages/agent/src/media/image-normalize.ts#L34)

格心采样不是区域均值或连通性证明；细线可能落在采样点之间。模型需要时缩小选区或提高受限采样密度，仍由证据支持结论。有结构化源数据时，不用像素表替代原始数据。

### 6.3 生成前的边界

建议首版工作护栏为每次最多 4 个 view、最多 4096 个像素样本，并受当前剩余上下文和现有输入图像限制约束。这是待机械测试和 profile 校准的工程初值，不是论文最优参数，也不新增用户配置。即使低于数量上限，预计输出过大也应在生成前要求缩小范围。

并行调用不能各自读取同一剩余额度后全部放行。由既有容量 owner 补生成前的窄预留接缝，使用 run/generation/batch 范围及精确调用发生序号关联额度，不能只用可重复的 toolCallId。预留覆盖兄弟调用与整批接纳；取消/失败释放须幂等，仍在执行的共享解码资源须等结算后释放。图像数、实际工作量/字节与模型输入容量分别受限，不另建预算策略引擎。

当前接线位置是 runner-driven 为 resolveToolResultCapacityTokens 与 toolResultBatchTransform 共用的容量 options；这里注入预留，agent 只消费窄接口。同批输出/token 预留与实际 decoder 工作槽是不同资源：后者如跨 run 共用，按其真实 owner 结算，不能把一个批次的 token 余额升级为全局预算。即便全图回取无需解码，输出预留也必须存在。[容量装配点](../../packages/coding/src/task-engine/runner-driven.ts#L2172)

当前 owner 的最终语义是保留已执行 tool/result 配对，必要时记录 capacityDebt，由下一请求的恢复梯子处理，而非执行后硬丢结果。生成前预留只防止可避免的派生开销；动作已执行的收据不能因超量消失，也不能因此重放动作。[容量 owner](../../packages/coding/src/tools/tool-result-policy.ts)、[批次接纳](../../packages/coding/src/task-engine/runner-tool-result-batch.ts)

派生工具需要真正的处理/输出硬上界。首版建议固定内部护栏：源输入不超过 10 MiB、解码不超过 40 MP，沿用展示长边 2000 与现有媒体展示字节预算；视图数/采样数按上述限制。超限明确返回本次检查不可用，保留接纳原件。这里把相应数值用于派生工作的拒绝边界，不改变 llm 的验证语义：现有 10 MiB/40 MP/超时只是验证处理界限，越界可为 unverified 且仍保留原 bytes，不能冒称上传已被硬拒绝。[验证处理边界](../../packages/llm/src/image-validation.ts)、[原字节序列化](../../packages/llm/src/providers/image-serialization.ts)

参数先整体校验；来源不存在、区域非法等返回具体错误。容量不足时给出可执行的缩小建议，默认不生成整批重结果；历史分页与调用方主动拆分必须显式。若执行中某项不可用，按原位置返回该项错误并标记 partial，不能静默遗漏、以别的图替代或把部分结果标成全部完成。

## 7. 什么时候主动看，什么时候直接继续

采用主模型驱动的按需取证原则，先复用已有 Worker/visual-review 的实际视觉验证指导，把工具选择语义放进视觉工具合同；只补当前合同的具体缺口，不在每种工作面重复叠加通用教学，也不增加独立视觉需求分类器。[已有共享指导](../../packages/coding/src/prompts/compact-worker-contract.ts)

> 先判断当前决策缺少什么证据。已有证据足够就继续。局部细节不清时检查选区；判断依赖过去状态时查历史；离散颜色关系需要核实时读取像素。已有观察无法回答时，调用来源工具获取新观察，必要时采取能区分假设的探索动作。取得证据后核对问题是否解决，再更新结论或行动。

这是按需要选择的行为，不是固定工具顺序。一个问题可能只需一次裁剪，也可能完全不需要视觉。图片存在并不构成必须反复查看的理由；纯文本、代码结构、API 或 DOM 足以解决的问题按原路径继续。

典型触发包括：关键信息太小；旧画面已消失；同一动作前后的状态有歧义；当前判断依赖精确颜色；模型遇到证据与预测不一致；当前操作依据的画面可能过期。模型在 tool args 中给出短 question/label 即可，不强制每步向用户展开推理或写反思文件。

主模型维护“已证实事实、待验证假设、当前目标、下一次可观察预期”。这些信息使用已有任务状态/摘要，只有决策依赖环境反馈时才提出短预期；不新增 GUIDE/WORKING 强制文件或程序化世界模型。

借鉴 GUIDE/WORKING 的职责区分：经证据支持的环境规律与当前尝试的临时目标/步骤分别记录，并保留适用来源、版本或 episode。重置、任务切换、分支或规则变化时，重新判断哪些认识仍成立；清理或标记失效的临时状态，不能把上一尝试的坐标、进度或假设当作当前事实。该职责划分复用现有状态与摘要，不增加两份每轮常驻笔记。

能够保证的是：纯文本且没有新图像接纳或检查调用时，不新增图像 I/O、采样、解码或模型请求。启用能力后，user/read/MCP 等路径收到图片，即使没有调用 inspect，也会产生一次原件固定与登记成本；这与后续主动检查的成本分开核算，不触发额外截图或模型请求。**不能保证模型从不误判视觉必要性**，需用纯文本负例与真实任务衡量误触发和浪费。

## 8. 动态环境：三种操作分开

| 操作 | 是否改变环境 | 应由谁负责 |
| --- | --- | --- |
| 检查已存观察 | 否；读取当时固定像素 | 通用视觉工具 |
| 获取新观察 | 通常只采样，也可能涉及重渲染或 seek | 来源工具/adapter，明确实际副作用与时间语义 |
| 为获取信息而行动 | 会改变焦点、界面、视角或环境状态 | 现有环境动作工具及其权限/并发 owner |

例如，回看关闭菜单前的截图是历史检查；再截图确认当前状态是补采样；悬停显示 tooltip、展开菜单或移动相机是探索行动。这三者不能统称为“放大”。

对共享的可变环境，现有环境 owner 在同一临界区内检查 expectedObservationId/来源版本、执行动作、登记结果。若第二个动作仍基于先前观察，即使排队获得锁也应按过期依据处理。获取并提升为 current 的新观察也必须进入该 owner 的顺序，或依据可靠来源序号拒绝旧采样覆盖 current，避免动作前启动、动作后返回的旧截图被误标为最新状态。

Runner 已有 RunnableTool.requiresSerialExecution(input)，可供 native 环境工具复用；但当前 managed tool_call 桥与 compatibility dispatcher 主要识别 Bash 串行，新增环境工具若经这些路径调用，须沿原包装贯通目标声明。它只是同批执行分类，不是环境锁，也不保证跨组按数组顺序执行；跨 Actor/Run 的 freshness→action→current 仍由同一环境 owner 原子处理。保持全局并发语义，其他来源与历史 inspect 仍可并行。[Runner 声明](../../packages/agent/src/primitives/runner-tool-loop.ts)、[桥接包装](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts)、[兼容派发](../../packages/coding/src/agent-runtime/tool-dispatch.ts)

这种版本检查只证明动作依据最后登记的观察。持续运行的现实环境可能已在外部变化，adapter 需要根据自身能力补采样或验证焦点/状态；不能把互斥锁宣传为实时世界一致性。

动作已执行但截图、归档或返回失败时，结果必须保留“已执行，后续观察不可用”或 unknown。该来源的当前操作依据随即失效，旧 observationId 不得继续通过新鲜度检查；先重新观察或停止依赖该状态的操作。不得为了补图自动重放点击、按键或游戏动作。取消后同样区分动作未执行、已执行和无法确认。已有 Host invocation 的 prepared/dispatched/completed/unknown/not_dispatched 及恢复状态应复用，不再新增全局动作 ledger。completed 仅证明收到 Host 结果，不证明动作成功或新观察已接纳；本地 adapter 未走 Host 时须提供等价副作用事实。[Host 调用状态](../../src/client-host-authorization.ts)、[派发与恢复](../../src/runtime-daemon/reverse-bridge.ts)

视频或动画容器由来源 adapter 显式采样成独立观察，标明媒体时间、frameIndex 与实际覆盖范围；只收到海报帧/首帧时明确该范围，不能把一个 GIF/video 文件引用等同于看过连续过程。

首版支持有界的离散观察/行动闭环，不承诺实时高帧率控制。帧采样率、按键持续时间、环境暂停、视频解码、时钟同步和低延迟控制由具体后端独立交付。

## 9. 跨压缩、重启和分支的视觉记忆

聊天上下文只携必要的图片与短引用；原件由现有 owner 管理。压缩摘要保留目标、已证实关系、未决问题、少量关键 observationId 和下一步预期，不把所有图或像素矩阵塞进摘要。

现有工具 metadata 会进入消息，但旧 island eviction 可替换内存内容；当前历史文本检索也不直接投影 metadata。因此“已经放进 metadata”不等于压缩后可发现和可恢复。观察目录应从同一 owner 的 canonical 记录、完整 lineage/sidecar 或既有扩展记录派生，允许丢弃重建，不能另建权威 journal。[lineage 压缩](../../packages/agent/src/session-lineage/kodax-session-lineage.ts)、[历史检索](../../packages/agent/src/session-lineage/history-retrieval.ts)、[产品存储](../../packages/repl/src/interactive/storage.ts)

具体要求：

- 产品 KodaX 继续走 Host 的既有提交路径；生产 Runner 不额外挂 generic Session 写第二份历史。独立 Agent 使用调用方注入的 Session/store。[生产 Runner 接线](../../packages/coding/src/task-engine/runner-driven.ts)
- owner 的 appendRecord 返回或内存 dirty 不算 durable ACK。宣称可跨重启前，必须经过该 owner 的持久化边界。
- 视觉续接必要状态纳入既有 checkpoint/压缩的提交条件；所需状态未成功提交时，不得以“磁盘上还有图片”为由丢弃继续任务所需的旧上下文。复用既有状态整理，不增加每步 checkpoint 或模型请求。
- 恢复时先加载轻量引用，按需回取选定原件，不自动把所有旧图重新发给模型。
- 对仍在进行的视觉交互任务，续接上下文需要足够的启动信息：适用的环境认识、当前工作状态、最后动作及结果、必要的最近观察。如果这些已在上下文中，不重复注入；否则在预算内补相应内容/真实图片，并标注观察时间。现实环境可能继续变化，恢复出的旧图不能冒充新截图，下一动作按来源的时效规则先补观察。
- 从 observationId 可以跳回同一 owner 中对应的精确动作及结果；attempt/episode 有来源时保留边界，沿用通用历史，不建第二份动作日志或 attempts 数据库。
- fork 继承分叉点之前可见的观察引用与不可变原件；之后的新观察归属各分支。既有 opaque extension records 可能全量复制，必须结合来源 entry/active lineage 筛选，不能直接全量公开。
- 观察 ID 不依赖会被 fork 重写的物理 entry ID；访问仍受当前 lineage 和 owner 控制。共享图片不代表共享活跃环境状态。
- 删除、过期、hash 不符或无权访问时明确不可用，不能悄悄回到当前同名路径生成“历史图”。

新的 durable compaction 已先提交精确 lineage，generation checkpoint 还校验 activeEntryId/messagesDigest；应直接复用。但 digest 计算的是消息 JSON，其中图片仍是路径，不能固定图片 bytes，也不能证明另一路尚未 save 的 extension dirty receipt 已提交。视觉收据和原件必须进入所选 owner 的既有提交后，才满足恢复要求；不加第二 checkpoint writer。[精确提交](../../packages/coding/src/agent-runtime/durable-compaction.ts)、[checkpoint](../../packages/coding/src/generation-checkpoint.ts)

结构化 task report 保留任务 summary/artifactRefs 等展示字段，部分 report renderer 会跳过同消息其他 blocks；它不是媒体仓库、观察目录或授权解析器。收据保存在原 owner canonical/sidecar/既有记录中，报告只带摘要与引用，不能把唯一图片/receipt 塞在报告通知里。父 Agent 需看图时仍通过授权检查工具取得真实图片；不能从报告或 UI 附件推导“已看过”。本次没有发现普通 canonical 工具图片因报告功能被删除的证据。[报告读取](../../packages/agent/src/session-lineage/task-results.ts)、[Product 展示投影](../../src/session-view.ts)

这些是首个公开支持工作流的交付要求，不能作为可选后续优化。可以分步开发，但不在恢复尚未接通时宣传“长期视觉记忆”。

## 10. 当前来源验收与历史回看各自成立

Artifact SDK 已有 source/hash、依赖、RasterEvidence、页/状态/时间 locator；这些是应复用的生产能力，而不是等待重造的视觉底座。[类型](../../packages/artifacts/src/types.ts)、[SDK 约定](../ARTIFACT_SDK.md)

当前 readEvidence 会核对来源及依赖是否仍匹配，并验证 PNG；源文件变化后拒绝旧证据是正确行为，不能为支持历史检查放松它。[证据读取](../../packages/artifacts/src/evidence-files.ts)

历史检查读取的是接纳时固定的 snapshot，验证该 snapshot 的 hash、来源记录与访问范围，清楚标为 historical。它可回答“当时是什么样”，不能证明“修改后的产物已通过检查”。当前验收仍调用原来的当前来源流程。

仅当 owner 同时保证 Artifact 原件不可变与存续时，才 pin 引用并复用；外部可能覆盖或清理的文件，在接纳时保存快照。不能仅因 saveEvidence 使用独占创建，就假定外部永远不会删除它。

## 11. 工具曝光、provider 与效率

### 11.1 运行开始就可达，沿用现有模型表示

三个工具是逻辑能力接口，在 Run 开始时注册并受实际 discovery ceiling、宿主绑定和可见性策略约束；产图只新增观察数据，不要求临时注册新工具。SDK 不装配该能力时保留原工具面。首版使用 Agent/Coding/Script 中的普通 native/checked bridge 入口，不新增视觉模式、router 或 MCP server。

当前 tool_search 的 exact 与关键词搜索都覆盖可发现的 builtin/run-scoped 工具，不再限于旧静态 deferred 目录；checked bridge 的重复预算问题也已修复。复用原权限/只读/取消/一次记账和结果包装，仅增加新视觉结果的实际 payload/receipt/容量回归。[工具发现](../../packages/coding/src/tools/tool-search.ts)、[桥接](../../packages/coding/src/task-engine/_internal/managed-task/agent-chain.ts)、[已修复预算合同](native-bridge-budget-equivalence.md)

普通主 Agent 的模型工具与 system 使用现有统一投影，并在容量紧张时复用 fitToolSchemasToContext；这不是默认全量按需隐藏。保持 builtin/宿主 override/SDK/child 的 provenance 守卫，不让视觉外包装破坏已有紧凑资格，也不强行对不适用对象缩写。[工具投影](../../packages/coding/src/tools/managed-tool-contract.ts)、[system 投影](../../packages/coding/src/prompts/managed-system-contract.ts)、[最终请求装配](../../packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts)

Script 只把明确绑定的白名单叶合同嵌入 script_exec，并隐藏那些叶的 native 表示；新视觉工具不会自动进入 cell，首版无此承诺。既有 read 等叶产生的图片通过当前 host-side typed-image 提取返回，不从 guest 路径造图；未来显式加入视觉叶时，分别验证白名单、权限、持久化、预算/取消和一次合同披露。[Script 装配](../../packages/coding/src/agent-runtime/script/model.ts)、[叶范围](../../packages/coding/src/agent-runtime/script/pilot.ts)

deferred 仍可能只缩 description；Script 仍要支付完整内嵌合同成本。所有成本以最终模型字段核对，不以工具数量、入口名或“惰性执行”推导首轮零开销。

### 11.2 真实图片与路由能力

首版以已验证能接收真实 image block 的 native provider 路径为基线。每条 CLI/SDK bridge 路径要单独验证实际输入 payload；不能从“支持工具调用”推导“支持工具返回多图”，也不能承诺所有 provider alias 都覆盖。

支持矩阵分开记录工作面、执行入口、owner、provider 协议和格式，不把“三模式可用”解释为所有组合都已验证。最初选 Coding 默认、产品 Runtime、native 检查工具、一个真实 serializer 与静态 PNG fixture；之后覆盖 Agent/Script、checked bridge 和第二种必要协议。测试调用生产 serializer 并截获 SDK 请求可以证明构造出的 payload，不能证明远端接受或模型使用了图；在线 smoke 与模型行为验证分别记录。兼容 SDK/CLI 及未接媒体的 Host 不在已验证集合内。[现有离线图片审计](../../packages/llm/src/providers/image-compatibility-audit.integration.test.ts#L1)

不支持图像时显式返回 unavailable/unverified 及原因；可继续完成适合文本或数值的部分，但不能标记视觉验收通过。不暗中切换模型、调用外部视觉服务或用文件路径文本冒充图片。[模型输入能力](../../packages/agent/src/media/capabilities.ts)、[图片验证](../../packages/agent/src/media/validation.ts)

### 11.3 成本控制不另造预算系统

现有 batch guardrail 继续负责整批容量。它对图片采用粗估，文本 spill 也不会自动移除图片，因此需要在生成重结果前做窄的视觉 admission：结合有限 views/samples、现有输入限制和同批共享预留，决定是否能产生本次结果，而非生成大量图片后再指望截断解决。这是既有 owner 需要补的接缝，不是声称当前已有完整视觉预算。[token 估算](../../packages/agent/src/tokenizer.ts)、[批量结果处理](../../packages/coding/src/task-engine/runner-tool-result-batch.ts)

agent 只接收 owner 注入的预检/预留接缝；独立 SDK 由自身宿主提供相同语义，不导入 coding 的预算实现。缺少持久化或预算接线的轻量宿主，必须明确其支持范围，不能继承产品 Host 才具备的保证。

- 没有新图像接纳或检查调用：无新增截图、轮询、图片目录扫描、解码、归档或模型请求；图片接纳与检查的成本分别记录。
- 有视觉调用：优先原件引用，按问题回取有限区域/时刻；同次复用源图解码，避免同时解码大量历史大图。
- 现有验证/cache 继续复用；其 unverified 处理界限不代替 §6.3 的派生工作硬边界。I/O、解码、编码受控；取消不等于共享 decoder 已完成，应等待资源结算后释放额度，不在旧操作仍活跃时重开。
- 不默认增加跨 run 解码缓存、worker 池、向量数据库或每步视觉 judge；先用 profile 证明瓶颈。
- 原件保存范围与默认入模范围分开。来源 adapter 给出与任务相符的初始展示；没有“末帧永远最佳”或“把全部帧都送入”的全局规则。

采集延迟、工具延迟、输入图数/字节、估算与实际 token、回取失败、视觉调用次数和任务完成情况使用现有 tracing 承载。少调用不自动代表聪明，多 inspect 也不自动代表有效；必须结合解决了哪条疑问判断。

### 11.4 当前首轮成本按三工作面重新度量

2026-10-18 草案中，三工具数组估算为 675–697，加单独 98-token 行为段为 773–795；54 仅是发现提示自身。它们不是当前 2682557e 下的产品装配或 API usage。旧“20,535 基线 / 约 3.9% / 800 目标和 1000 上限”保留为历史设计参考，由本次分模式验收替代，不能当作统一发布门槛或默认收益。

当前共享契约已经包含视觉验收指导，首版不默认增加旧 98-token 段。新增视觉合同仍需要 token：Agent/Coding 是普通工具输入，Script 首版也保留这些工具的 native/bridge 入口；若后续加入叶白名单，须计其内嵌合同且不双算。仅将 schema 从 tools 移进 script_exec.description 不构成节省。

| 场景 | 本次修订的计量/验收 |
| --- | --- |
| 未装配视觉能力 | 工具与指导不增加；检查既有 system/工具投影仍按原资格工作 |
| 三模式已装配、纯文本新任务 | 同 fixture 分别测完整模型字段 V−B，计说明/参数/投影变化，不增加固定分类/发现请求或默认图片 |
| 首轮已有图片 | 相同接纳 bytes 不因归档重复入模；短引用增量单列，核对真实 image payload |
| Script 已有图片叶 | 叶 receipt、真实图片与同响应引用分别核对；不把 guest return 或 JSON 图片路径当已入模 |
| 压缩/重启续接 | 必要状态、最后结果、所需图片单独计量，不把缺必要证据的更短上下文判为优化 |
| schema 容量 fitting / 按需披露 | 现有 fitting 沿用；默认隐藏另需任务价值证据，不因 bridge 已修或提示只有 54 就自动采用 |

沿用 [measureModelFields](../../tests/first-turn-uniform-costs.ts) 与实际 SDK 序列化 fixture，在当前固定源码、工作面、宿主/权限/技能和相同历史下捕获 B/V。Script 内嵌声明、相应 system 与消息均纳入；图像实际 bytes/hash、尺寸和数量另外报告。API/BPE/缓存用量与本地文字启发式分开，不把含 base64 的完整 JSON 估算当视觉计费。

本次只核查源码与既有回归，没有重抓 2682557e 的三模式成本；其他设计中标明的历史快照也不升级成本次实测。原件与机器收据在本地存储不直接占模型 token，只有实际进入模型的标签、工具结果、指导和图像计入。

评价同时包含全任务质量、请求、token、费用与耗时；不新增固定需求分类或证据发现回合。需要视觉证据时允许有价值的检查；不要求每个样本零增轮。Prompt cache 不消除上下文占用，也不能替代当前首轮模型字段的计数。

## 12. 交付拆分与改动范围

按以下垂直切片开发，每片贯通实际模型输入；不先建设大而无使用者的抽象平台。

| 切片 | 必须交付 | 交付后可见效果 |
| --- | --- | --- |
| A：一条真实图片闭环 | 最初 user image 与一个现有 typed-image 来源；稳定 ID/发生身份、可见标签、history、局部/放大 inspect、真实 provider image、最小同批预留；接通所选 owner 恢复/原件保留与三模式普通入口 | 普通图片任务中能回看原图/局部，恢复后仍可找到；并行单图调用不超发 |
| B：多观察与数值核实 | 有序多 view、跨时刻/区域、格心像素与精度、扩展 A 的生成前边界/取消 | 图表/网格/动态采样任务能围绕疑问选择证据 |
| C：持久化与产品补齐 | Host/standalone 对应接线、原件缺失语义、压缩/重启/fork 可见性、Artifact 当前验收与历史回看边界 | 扩展到长任务和产物检查，避免“短 demo 可用、恢复就失效” |
| D：一个动态消费者 | 一个可控来源；沿用 serial predicate/Host outcome，补桥接目标传播及环境 freshness/action/current；失败/取消后不重放 | 验证主动补采样和根据反馈修正判断的通用闭环 |
| E：按需独立扩展 | 浏览器/桌面、视频、ARC、游戏或其他渲染后端 | 复用同一检查能力；环境规则、动作和评测独立交付 |

A 中所选工作流的恢复和最小同批预留不能等 B/C 才实现；C 覆盖其他 owner、分支与报告投影边界。Host string bridge 的媒体 materialization 随该来源接入，不阻塞 A。Script 首版不扩大叶白名单。D 不要求完整 computer-use 平台，也不以游戏分数作为主体完成条件。

预计主要改动集中于 agent/media 的可选能力与工具、coding/Host 图片接纳和历史投影、现有 skill 指导及必要的 provider 接线测试。Runner 可能需要小型提交/接纳接缝修补，但不重写运行循环。llm 图像协议、Artifact 渲染引擎、全局并发和任务规划保持各自现有职责。

主体范围不应承诺精确天数或代码行数；最容易低估的是恢复/分支、实际 provider 多图路径和媒体生命周期。真实桌面、持续运行游戏、连续视频控制另计，不能塞进“几个工具”的估算。

### 12.1 完备性判断与实施前冻结

三个方向的复核没有发现必须新增的 VISTA 通用大模块。原始观察记忆、主动局部/跨时刻取证、像素核实、可修订理解、恢复与反馈已经覆盖；剩余缺口是可执行的契约及验证范围。以下为本轮推荐的收口决定，仍待实现测试证明：

| 问题 | 收口决定 | 所在切片 |
| --- | --- | --- |
| 谁能承诺跨重启记忆 | 首选产品 Runtime canonical owner；区分 provisional 与 required commit，输入意图幂等保持不变 | P1 |
| 回图是否重复变成观察 | 区分来源事件与 inspection；native/bridge/Script 传递可信属性，回显不刷新 current | P1–P2 |
| 历史如何稳定查找 | 有界最近页、稳定接纳顺序和固定查询边界的 cursor；首片即检查 owner/lineage | P1，fork 扩展在 P4 |
| 什么叫原图坐标与精确像素 | 共享明确 raster/profile；先固定 PNG fixture，派生格式逐项验证，保留既有上传能力 | P2–P3 |
| 如何保证不开销失控 | P1 即有同批输出预留；P2/P3 增加有界派生与解码结算；沿用最终 capacityDebt | P1–P3 |
| 实际支持到哪里 | 将工作面、入口、owner、格式和协议拆开标注；离线请求构造与远端/行为证据分开 | P0 及每片更新 |

每个切片先写会失败的契约测试，再最小实现并通过相关回归；采用仓库覆盖率要求。测试应检验用户可观察事实、真实 bytes/顺序/故障边界，不镜像内部实现。以下是实施计划，不是已注册 feature、已经批准的独立票或完成状态。

### 12.2 可独立演示的实施顺序

| 编号与依赖 | 端到端交付及主要位置 | 验收与完成边界 |
| --- | --- | --- |
| **P0：冻结视觉前基线**；无依赖 | 固定 HEAD、实际工具合同和三工作面完整请求 fixture；列清 Runtime/native/bridge/provider/图片格式支持格；使用现有 tests/first-turn-* | 同条件 B/V 可以复现；纯文本未调用视觉的 I/O、请求和提示成本有单独基线。完成后才能比较新增成本，不使用历史 800/1000 阈值 |
| **P1：用户图片可持久回看**；P0 | 从 Runtime.acceptInput 的首条 immediate 图片经过真实 owner 接纳，到 agent/media 的 history/full inspect，再到 Coding 默认 native 工具和生产 serializer；接好原件、收据、最小共享预留、目录授权及重启恢复 | 覆盖路径后原 ID 回原 bytes；同 inputId 重试复用、异意图拒绝；提交失败无假 durable；inspect 不增新源事件；两个并行 full inspect 不超发；重启可回看。PNG 是首个 fixture，未实现派生能力不曝光 |
| **P2：主动局部检查**；P1 | 接入原生 read 持有 bytes 的来源，加入 crop/zoom 与变换标签；贯通 Agent/Coding/Script 普通 native/checked bridge，复用 Script 已有图片叶；完成所选 owner 压缩续接 | 重复 provider call ID 不串图；read 新观察正常入库，inspect 回显不递归；实际 serializer 中图片、标签、坐标一致；支持协议的单图合同通过；压缩后仍取得所需证据。确定并测试解码 profile、取消与工作上界 |
| **P3：多观察与像素核实**；P2 | 有序多 view、跨时刻/区域对比及 visual_read_pixels；在 agent/media 扩展同一预留/派生路径 | 原图格心 RGBA、alpha、精确调色板、边界与 partial 输出正确；检查不依赖展示缩放图；同源尽量复用解码；批量结果保持顺序和完整配对；生产多图 serializer 契约通过 |
| **P4：产品输入与长任务完整性**；P2 | 补 queued/steer 等受支持输入的接纳时点；fork 继承与 sidecar 可见性；恢复后的认识/临时状态、最后动作结果与必要图片；报告只携引用 | 入队后路径改变不改变已确认原件；分叉前可见、分叉后隔离；压缩/重启/失效/清理故障可诊断；旧临时状态不冒充当前；报告及 UI 投影不是目录源。首片授权不等到本片才做 |
| **P5：逐个扩展来源与宿主**；P4 | 每个来源独立小片接 MCP、Artifact、额外 SDK owner 或 Host materialization；只推进产品实际需要者 | Artifact 当前验收与历史回看互不放松；新来源 bytes/权限/回执/恢复通过同一合同；SDK 无 Runtime/REPL 依赖；缺媒体传输的 Host 明确不可用。每个来源可独立交付，不互相阻塞 |
| **P6：一个受控动态闭环**；P2 | 选择可确定性观察/行动的最小消费者，沿原动作 owner 和 serial/outcome 接线，补目标串行传播及 expectedObservationId → action → current | 旧依据拒绝、延迟旧图不覆盖 current；动作成功但采图失败保留执行事实并使当前依据失效；unknown/取消不重放；可演示为验证一个假设主动补采样。无需 ARC、完整桌面或实时游戏；不依赖 P3 的像素工具 |
| **P7：成本与行为采用评审**；基础版依赖 P3、P4、P6，声明 P5 来源时加对应依赖 | 汇总各片 Layer 1；只对机械检查无法回答的主动取证、修正判断与不必要查看设计小规模受控 probe | 按工作面报告首轮及全任务成本/耗时与质量；主会话盲化读取配对 raw 给出采用/迭代建议；无支持证据的路由不算完成。不默认运行付费 panel；实验按 §13.2 另冻结预算与调用图 |

P0–P2 是顺序主线；P2 后 P3、P4、P6 可在契约稳定且文件职责不冲突时并行。P5 按来源拆小，不是把所有后端装完才能验收。P7 的 fixture、负例和机械检查随各片持续增加，最后汇总；不是等所有代码完成才开始测试。

P1 是可以独立验证的基础闭环，**P1+P2 才作为最小主动视觉里程碑**：模型能回看并主动选择局部，所选路径压缩/重启可继续。P3/P4/P6 补齐数值核实、产品长任务与动态证据反馈，再通过 P7 判断基础版采用价值。浏览器/桌面操作、ARC、游戏、视频/HyperFrames 各自作为后续 extension 项目，不算本次基础版缺失，也不提前承诺支持。

### 12.3 改动规模与不确定性

这是一项跨包的中等规模能力改造，不能估为“增加三个工具”，也不需要重写 Agent 循环。P1/P4 的输入幂等、durable 提交和 lineage 最易低估；P2/P3 的格式、资源和真实图像序列化次之；工具 schema 本身较小。P6 只选一个受控消费者，真实外部环境的延迟与权限适配另估。

实现前仍需选择具体 codec/profile 和首个动态消费者；可以在对应片开工时用现成库与确定性 fixture 决定，无需先建插件平台。数字化资源上限沿 §6.3 初值并通过 profile 校准，具体 token 增量由 P0/P7 测量。缺少这些实测时不报精确工时、代码行数或提升百分比。首轮优化的现有默认和投影资格作为回归约束，不重新开启已收口的优化路线。

## 13. 验证什么才算做成

后续实现遵循仓库 TDD 和现有覆盖率要求；先做机械验证，再做小规模行为验证。本提案没有运行模型、benchmark 或付费实验。

### 13.1 机械验收

| 验收项 | 必须可观察的结果 |
| --- | --- |
| 字节与身份 | 覆盖原路径后旧 ID 仍返回原 hash；相同 bytes 的不同事件区分；重复 provider call ID、不同 batch/cell 不串观察或预留；同事件重交付不重复登记 |
| 接纳与输入幂等 | 同 inputId 重试复用原件/收据，异意图拒绝；UI/排队回执不冒充 durable；文件或 canonical 提交失败不公开假成功；受支持 queued/steer 输入在约定接纳时点固定 bytes |
| 回显与目录 | inspect 的原图/派生回显不新增源事件或刷新 current，native/bridge/Script 分类一致；分页期间追加记录不打乱固定上界，换分支/筛选不能滥用旧 cursor |
| 完整输入链 | 实际 native/checked bridge → Runner → 支持图片的 provider 构造，核对 bytes/hash、顺序、标签；三工作面可达，Script 原生视觉入口与已有图片叶分别验证 |
| 最初 user image | 与工具图片同样可检索/裁剪；在持久化恢复后仍对应接纳时的原件 |
| 空间与像素 | 裁剪/放大坐标与输出映射正确；格心公式、RGBA/alpha、精确调色板索引和边界错误符合契约；不从展示缩略图或放大图测量 |
| 解码与生命周期 | inspect/pixels 的方向、raster 与色彩/alpha 解释一致；未支持的派生格式明确不可用且不收窄既有上传；Session archive/删除/fork 对原件保留符合声明，清理不误删活跃引用 |
| 恢复与分支 | 保存 → 精确压缩/evict → 重启仍回取同图；单有消息 digest 而未提交媒体/receipt 不算通过；fork 不见分叉后/旁支观察；报告/展示 reader 不作目录源 |
| 认识与续接 | 新上下文获得必要观察、适用认识和最后动作/结果；不重复已有内容；重置/换 episode 后旧临时状态失效，历史证据仍可回取 |
| Artifact 边界 | 修改源文件后当前 readEvidence 拒绝旧证据，而历史 inspect 仍可读取已接纳旧快照，并标明 historical |
| 预算与取消 | A 的并行单图调用就有共享预留；重复ID不复用错额度；超派生工作/输出硬限明确失败；已执行结果仍成对提交/debt恢复；取消结算幂等，活跃decoder不提前重开 |
| 共享环境 | native serial 声明与桥接/兼容传播分别验证；同环境旧依据拒绝，延迟旧图不覆盖 current；复用 Host 执行/未知状态；取消/补图失败不冒充未执行，不自动重放 |
| 无视觉路径 | 文本任务未调用视觉工具时，无新增图像 I/O、解码、采样或模型请求；提示成本与延迟单独记录 |
| 首轮增量 | 按三工作面相同 B/V fixture 比较完整模型字段，计 Script 内嵌合同；未装配不增合同；既有 compact 投影不因视觉包装退化；不默认加 98-token 重复指导，不用旧 800/1000 一刀切 |
| 能力不支持/引用失效 | 清楚返回 unsupported、missing、expired、hash mismatch 或访问失败；不输出“已通过视觉检查” |

### 13.2 行为验证与效果边界

设计任何 eval 前先遵循 [EVAL_GUIDELINES](../../benchmark/EVAL_GUIDELINES.md)。未来可用同一条生产工具路径，在固定的模型、提示、输入历史与图像接纳策略下，覆盖“小细节、旧画面、新观察、颜色核实、应当不看”五类受控问题。

机械测试可以确认工具与字节契约，但无法判断主模型是否在合适时机主动取证、证据是否改善最终判断；只有这些剩余问题才进入模型 probe。Layer 2 捕获固定输入下的下一响应/工具调用，不执行后续自由循环；需要看取证后的判断时，用另一份固定历史单独测试。动态问题采用预定义、默认不超过 3 轮的 Layer 3 场景，输入、结果注入和终止点受控。

比较结果应观察是否获得相关证据、是否据此修正错误、最终结果是否正确，以及 token/延迟/调用成本。工具次数只作为诊断，不作为智能评分。用于能力/产品价值比较的 A/B 由当前主会话读取盲化配对证据，结构化记录提升、回退和原因。端到端 smoke 最多 3 个 case，仅验证接线，不用于 prompt A/B 或通用提升结论。

若要拆分记忆、裁剪、像素、主动提示各自贡献，保持自动输入帧数、模型和预算一致，分项对照；不能重复论文消融中的混杂。模型版本、原件 hash、来源/采样范围、费用上限和终止条件在运行前固定。此阶段不需要 ARC 正式接入。

## 14. 明确取舍与暂不建设

推荐现在建设：可恢复原始观察、可见稳定引用、历史目录、局部/跨时刻检查、有限精确采样、主模型按需取证指导、真实图片传输和有界资源使用。

暂不建设：新的渲染引擎、ARC/游戏规则系统、统一所有环境动作的协议、独立规划/视觉裁判、向量记忆库、程序化世界模型、自动目标追踪、连续全帧录像、高帧率实时控制、为未来猜测增加的配置项。具体需求出现后，通过独立后端或 extension 接入。

对效果的合理预期是：**让现有模型在视觉任务中能够重新获得、选择和核实证据，减少被首次看图、摘要遗漏和过期状态限制的机会。**准确率和成本是否改善、改善多少，需要上述验证；既不以 ARC 为前提，也不把工具完备性直接等同于通用智能已提升。

## 15. 可核对来源与状态

- [VISTA 论文 v1](https://arxiv.org/pdf/2610.02200v1)：通用视觉记忆/检查、消融边界、静态与交互任务；未在 KodaX 复现。
- [VISTA 固定源码](https://github.com/joshhhhhan/VISTA/tree/c97c354f0a8948256545a3e8850a1848f8e5b8c1)：本文机制分析以固定版本为准，不假定完全等同论文所有实验版本。
- 当前适配审读基线 2682557e3c3b8d5c8a8dbaf5837b55a220513b82（2026-10-28）；首轮默认采用记录 490ea6de，后续合入不冒称已被原评测覆盖。最初 b0b446ec 与迁入时 5ada4f7c 保留为历史来源。后续实现仍须冻结当时真实源码/fixture。
- [HLD](../HLD.md)、[PRD](../PRD.md)、[Artifact SDK](../ARTIFACT_SDK.md)、[评测规程](../../benchmark/EVAL_GUIDELINES.md)：继续作为各自已有职责与流程依据。
- 本文为首轮收口后的视觉推荐设计，本次适配没有改变已接受默认、注册新 feature、修改 ADR 或实施视觉生产代码。既有 Script/bridge 回归 36 项通过不构成新视觉能力验收；模型主动取证、实际成本和恢复全链仍待对应切片验证。
