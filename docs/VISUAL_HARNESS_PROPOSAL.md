# KodaX 通用主动视觉能力提案

状态：历史提案快照，后续主稿已迁至 KodaX-next-dev 的 [首轮优化后视觉设计](../../KodaX-next-dev/docs/designs/visual-harness-after-first-turn.md)，请在目标工作树继续维护。本文不再作为后续实施入口。日期：2026-10-18。KodaX 审读基线：b0b446ec84fd20f21529025d086813eb5bcb2bd0。VISTA 审读基线：论文 v1、源码 c97c354f0a8948256545a3e8850a1848f8e5b8c1。

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

分层沿用现有约束：[HLD](HLD.md)、[PRD](PRD.md)、[Artifact SDK](ARTIFACT_SDK.md)。独立使用 Agent 时，调用方装配可选工具并提供自己的 owner；安装 KodaX 不自动获得操作系统控制权限。

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

ID 是不透明引用，不能让模型通过猜路径或 ID 越过既有会话访问范围。内容 hash 用于完整性和去重，不当作观察发生身份。

“当前”只表示该来源最后登记的一次观察，必须同时展示观察时刻/版本；它不保证现实环境此刻未变化。多页面、多窗口、多来源分别有最新观察，不设置全局唯一 current 图。

### 5.2 接纳顺序与原件生命周期

在输入 adapter 或工具仍持有实际 bytes 时，复用既有验证，固定原件、登记收据，再对外返回可回取的 observationId。若已有附件是不可变且由 owner 保证存续，可以 pin 引用；否则在现有 owner 的 media 区域保存一次接纳快照。不能仅保留任意临时路径，更不能在文件被覆盖后重新读取并称作原观察。

归档保存接纳时的 bytes，展示可以另外缩放；若上游只交付了缩略图或有损图，就记录该限制。已有粘贴图的归一化、临时文件清理不自动等于长期原件保留。复用现有验证与 prepareValidatedImageBlock，避免重复编码或从 provider base64 回读建档。[图片准备](../packages/llm/src/providers/image-serialization.ts)、[MCP 图片接纳](../packages/agent/src/capabilities/mcp/runtime.ts)、[现有媒体保存](../packages/agent/src/media/persist-image.ts)

收据和图片先后提交可能留下孤儿文件，但不能留下宣称可用却没有原件的引用。文件与记录不需要分布式事务；沿用 owner 提交边界，对未完成接纳明确报错，孤儿文件交给同一生命周期管理。内存 owner 可以提供单 run 能力，但必须声明不支持跨重启；产品持久化 owner 才能承诺 durable。

所有**明确接纳**的观察按 owner 的现有保留策略管理，默认送入模型的子集另行选择。不要为通用视觉承诺录下全部屏幕/视频，也不要静默超额删除后仍宣称完整历史。过期、清理或缺失的引用返回明确状态；首版不新增用户保留策略开关。

### 5.3 接入当前 KodaX 的具体接缝

- Runner 的 tool_result.metadata 可以承载小型 JSON 安全收据，但 provider 不把它作为模型可见内容。图片旁必须有短文本标签，例如“obs_17，来源 chart，修订 r3，1200×800，观察于……”。[结果构造](../packages/agent/src/primitives/runner-tool-loop.ts)、[消息类型](../packages/llm/src/types.ts)
- 普通 coding/extension handler 当前主要返回 content；它不能直接假定自己可写 Runner metadata。首版由现有 owner 的接纳/materialization 路径附收据，或用同 owner 既有记录关联 toolCallId；直接 RunnableTool 可以使用已有 metadata。避免为此重造通用 ToolResult 协议。[coding 工具类型](../packages/coding/src/tools/types.ts)、[工具包装](../packages/coding/src/task-engine/_internal/managed-task/tool-wrappers.ts)
- 最初的 user image 也进入相同接纳流程：固定 bytes、分配 opaque ID、附可见标签，机器记录关联输入消息与图片序号。独立 Session 当前不能假定已持久化 inputId/turnId；可以依靠持久 entry/opaque ID，不为视觉新增 llm 消息类型。[Runner 提交](../packages/agent/src/primitives/runner.ts)
- 已有 prepared-image 缓存保证 run 内复用，但不是跨重启的原件仓库，公开 inspectPreparedImage 也不返回归档 bytes。首版在原 adapter 持 bytes 时接纳；若某路径只能晚接，必须补窄的已接纳字节读取接缝，禁止重读可变 path 冒充缓存内容。

来源工具的 UI 事件、内存 append、canonical 提交、owner durable 提交、provider 实际收到图片，是不同阶段。方案与验收分别检查，不把“工具调用成功”直接记作“模型已看懂”。

## 6. 三个只读工具：最小而完整的证据选择面

以下名称和参数是建议契约，尚不是现有 API。工具不调用第二个模型，不回答 question 的语义；question 和 view 的 label 用于表达本次取证目的与结果对应关系，不要求输出长篇推理。

| 工具 | 建议输入 | 结果与职责 |
| --- | --- | --- |
| visual_history | sourceKey、before/after 或 cursor、limit 等必要过滤条件 | 有界目录：观察 ID、来源、时刻/版本、动作关联、尺寸、可用状态；从同一历史 owner 投影，不新增数据库或向量检索 |
| visual_inspect | question、按序 views，每项含 label、observationId、可选 region / displayLongEdge | 返回原图、区域或放大展示的真实 image block、来源与坐标变换；可跨时刻、跨区域并列检查 |
| visual_read_pixels | question、按序 views，每项含 label、observationId、region、rows、columns | 返回采样坐标、明确精度的 RGBA 值与局部调色板索引；用于有限离散测量 |

目录可以按需读取持久收据/完整 lineage，不能每次模型调用扫描所有历史或打开所有图片。没有新视觉记录时不维护昂贵后台索引。已有 session_history_search/read 继续负责通用消息检索，visual_history 是同一 owner 的图像目录投影。

### 6.1 空间与展示

region 使用原图像素坐标，左上角为原点，整数 x/y/width/height，半开区间。越界、不合法或零面积区域明确拒绝，不静默裁成另一个区域。裁剪输出附原 observationId、原区域、输出宽高与坐标映射；它不是新的环境状态。

裁剪集中展示已有细节；需要局部放大时，模型可用 displayLongEdge 请求展示长边尺寸。它是本次检查的输入参数，不是新的用户配置。首版采用保持比例的最近邻重采样，参数与实际输出受既有尺寸/预算上限约束；省略时保留原生尺寸，必要缩小时明确标注。这样既支持直接裁剪，也支持主动把小选区重新作为较大视觉输入，不把“裁剪”与“放大”混为一谈。

展示变换不增加原图信息，精确测量始终基于固定原件，不能从放大图反测原像素。首版派生展示使用 PNG，复用现有媒体的最大展示长边（当前 2000）和字节预算；超限时要求缩小范围/展示尺寸，不自动套用粘贴图的 JPEG 降质链。输出标明重采样方式与实际尺寸。[既有展示限制](../packages/agent/src/media/image-normalize.ts)

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

格心采样不是区域均值或连通性证明；细线可能落在采样点之间。模型需要时缩小选区或提高受限采样密度，仍由证据支持结论。有结构化源数据时，不用像素表替代原始数据。

### 6.3 生成前的边界

建议首版工作护栏为每次最多 4 个 view、最多 4096 个像素样本，并受当前剩余上下文和现有输入图像限制约束。这是待机械测试和 profile 校准的工程初值，不是论文最优参数，也不新增用户配置。即使低于数量上限，预计输出过大也应在生成前要求缩小范围。

并行调用不能各自读取同一剩余额度后全部放行。由既有容量 owner 补一个生成前的窄预留接缝，以 toolCallId 关联本批共享额度；预留持续到整批结果接纳或失败/取消后释放，合计同时约束图像数、预计体积和上下文占用。该接缝与最终 batch guardrail 使用同一预算来源，不另建预算策略引擎。

参数先整体校验；来源不存在、区域非法等返回具体错误。容量不足时给出可执行的缩小建议，默认不生成整批重结果；历史分页与调用方主动拆分必须显式。若执行中某项不可用，按原位置返回该项错误并标记 partial，不能静默遗漏、以别的图替代或把部分结果标成全部完成。

## 7. 什么时候主动看，什么时候直接继续

采用主模型驱动的短指导，接入已有视觉能力说明与 visual-review 等使用场景；不增加独立视觉需求分类器。

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

这里不改变 Runner 的全局非 Bash 并发；只约束同一环境的动作和 current 状态更新，其他来源与历史 inspect 仍可并行。

这种版本检查只证明动作依据最后登记的观察。持续运行的现实环境可能已在外部变化，adapter 需要根据自身能力补采样或验证焦点/状态；不能把互斥锁宣传为实时世界一致性。

动作已执行但截图、归档或返回失败时，结果必须保留“已执行，后续观察不可用”或 unknown。该来源的当前操作依据随即失效，旧 observationId 不得继续通过新鲜度检查；先重新观察或停止依赖该状态的操作。不得为了补图自动重放点击、按键或游戏动作。取消后同样区分动作未执行、已执行和无法确认。

视频或动画容器由来源 adapter 显式采样成独立观察，标明媒体时间、frameIndex 与实际覆盖范围；只收到海报帧/首帧时明确该范围，不能把一个 GIF/video 文件引用等同于看过连续过程。

首版支持有界的离散观察/行动闭环，不承诺实时高帧率控制。帧采样率、按键持续时间、环境暂停、视频解码、时钟同步和低延迟控制由具体后端独立交付。

## 9. 跨压缩、重启和分支的视觉记忆

聊天上下文只携必要的图片与短引用；原件由现有 owner 管理。压缩摘要保留目标、已证实关系、未决问题、少量关键 observationId 和下一步预期，不把所有图或像素矩阵塞进摘要。

现有工具 metadata 会进入消息，但旧 island eviction 可替换内存内容；当前历史文本检索也不直接投影 metadata。因此“已经放进 metadata”不等于压缩后可发现和可恢复。观察目录应从同一 owner 的 canonical 记录、完整 lineage/sidecar 或既有扩展记录派生，允许丢弃重建，不能另建权威 journal。[lineage 压缩](../packages/agent/src/session-lineage/kodax-session-lineage.ts)、[历史检索](../packages/agent/src/session-lineage/history-retrieval.ts)、[产品存储](../packages/repl/src/interactive/storage.ts)

具体要求：

- 产品 KodaX 继续走 Host 的既有提交路径；生产 Runner 不额外挂 generic Session 写第二份历史。独立 Agent 使用调用方注入的 Session/store。[生产 Runner 接线](../packages/coding/src/task-engine/runner-driven.ts)
- owner 的 appendRecord 返回或内存 dirty 不算 durable ACK。宣称可跨重启前，必须经过该 owner 的持久化边界。
- 视觉续接必要状态纳入既有 checkpoint/压缩的提交条件；所需状态未成功提交时，不得以“磁盘上还有图片”为由丢弃继续任务所需的旧上下文。复用既有状态整理，不增加每步 checkpoint 或模型请求。
- 恢复时先加载轻量引用，按需回取选定原件，不自动把所有旧图重新发给模型。
- 对仍在进行的视觉交互任务，续接上下文需要足够的启动信息：适用的环境认识、当前工作状态、最后动作及结果、必要的最近观察。如果这些已在上下文中，不重复注入；否则在预算内补相应内容/真实图片，并标注观察时间。现实环境可能继续变化，恢复出的旧图不能冒充新截图，下一动作按来源的时效规则先补观察。
- 从 observationId 可以跳回同一 owner 中对应的精确动作及结果；attempt/episode 有来源时保留边界，沿用通用历史，不建第二份动作日志或 attempts 数据库。
- fork 继承分叉点之前可见的观察引用与不可变原件；之后的新观察归属各分支。既有 opaque extension records 可能全量复制，必须结合来源 entry/active lineage 筛选，不能直接全量公开。
- 观察 ID 不依赖会被 fork 重写的物理 entry ID；访问仍受当前 lineage 和 owner 控制。共享图片不代表共享活跃环境状态。
- 删除、过期、hash 不符或无权访问时明确不可用，不能悄悄回到当前同名路径生成“历史图”。

这些是首个公开支持工作流的交付要求，不能作为可选后续优化。可以分步开发，但不在恢复尚未接通时宣传“长期视觉记忆”。

## 10. 当前来源验收与历史回看各自成立

Artifact SDK 已有 source/hash、依赖、RasterEvidence、页/状态/时间 locator；这些是应复用的生产能力，而不是等待重造的视觉底座。[类型](../packages/artifacts/src/types.ts)、[SDK 约定](ARTIFACT_SDK.md)

当前 readEvidence 会核对来源及依赖是否仍匹配，并验证 PNG；源文件变化后拒绝旧证据是正确行为，不能为支持历史检查放松它。[证据读取](../packages/artifacts/src/evidence-files.ts)

历史检查读取的是接纳时固定的 snapshot，验证该 snapshot 的 hash、来源记录与访问范围，清楚标为 historical。它可回答“当时是什么样”，不能证明“修改后的产物已通过检查”。当前验收仍调用原来的当前来源流程。

仅当 owner 同时保证 Artifact 原件不可变与存续时，才 pin 引用并复用；外部可能覆盖或清理的文件，在接纳时保存快照。不能仅因 saveEvidence 使用独占创建，就假定外部永远不会删除它。

## 11. 工具曝光、provider 与效率

### 11.1 运行开始就可达，重处理按需发生

三个工具是逻辑能力接口，可作为可选 RunnableTools 在 Run 建立时注册并保持可执行；注册、进入 native 模型表、完整参数披露是三个不同决定。首版可靠基线为精简 native schema，内部目录读取、图片解码和派生只在调用时发生。coding 服从首轮 token 优化分支最终采用的统一曝光策略，不另设视觉 router；已有 MCP 来源可以复用其入口，但不为这项能力专门架设 MCP server。

现有 AMA 工具面与 run-scoped 定义不能保证产图后任意新增工具立即可调用；产图只新增观察数据。deferred 也主要缩短 description，schema 仍有提示成本。因此首版接受小而有界的能力说明/schema 成本，不宣称对所有文本任务零 token 开销。[工具发现](../packages/coding/src/tools/tool-search.ts)、[工具定义选择](../packages/coding/src/agent-runtime/tool-resolution.ts)

SDK 调用者不装配该能力时，维持原工具面；装配后即使任务稍后才产图，也可立即检查。不要增加关键词路由、每轮视觉分类模型或全局开关来模拟不存在的动态注册。

完整 schema 按需披露可利用已有 exact tool_search / checked tool_call，但它只是待验证的表示方案。必须验证 run-scoped 查找、实际执行、目标权限/只读、取消、工作预算和图片结果都与 native 路径一致；现有 bridge 的额外工作单位记账差异尚不能当作等价保证。不能仅因首轮更小就将三个 schema 默认隐藏，也不能把 deferred description 缩短说成参数已经离开首轮。

### 11.2 真实图片与路由能力

首版以已验证能接收真实 image block 的 native provider 路径为基线。每条 CLI/SDK bridge 路径要单独验证实际输入 payload；不能从“支持工具调用”推导“支持工具返回多图”，也不能承诺所有 provider alias 都覆盖。

不支持图像时显式返回 unavailable/unverified 及原因；可继续完成适合文本或数值的部分，但不能标记视觉验收通过。不暗中切换模型、调用外部视觉服务或用文件路径文本冒充图片。[模型输入能力](../packages/agent/src/media/capabilities.ts)、[图片验证](../packages/agent/src/media/validation.ts)

### 11.3 成本控制不另造预算系统

现有 batch guardrail 继续负责整批容量。它对图片采用粗估，文本 spill 也不会自动移除图片，因此需要在生成重结果前做窄的视觉 admission：结合有限 views/samples、现有输入限制和同批共享预留，决定是否能产生本次结果，而非生成大量图片后再指望截断解决。这是既有 owner 需要补的接缝，不是声称当前已有完整视觉预算。[token 估算](../packages/agent/src/tokenizer.ts)、[批量结果处理](../packages/coding/src/task-engine/runner-tool-result-batch.ts)

agent 只接收 owner 注入的预检/预留接缝；独立 SDK 由自身宿主提供相同语义，不导入 coding 的预算实现。缺少持久化或预算接线的轻量宿主，必须明确其支持范围，不能继承产品 Host 才具备的保证。

- 没有新图像接纳或检查调用：无新增截图、轮询、图片目录扫描、解码、归档或模型请求；图片接纳与检查的成本分别记录。
- 有视觉调用：优先原件引用，按问题回取有限区域/时刻；同次复用源图解码，避免同时解码大量历史大图。
- 现有输入大小/像素限制继续生效；派生结果也检查输出尺寸。文件 I/O、解码和编码均响应取消。
- 不默认增加跨 run 解码缓存、worker 池、向量数据库或每步视觉 judge；先用 profile 证明瓶颈。
- 原件保存范围与默认入模范围分开。来源 adapter 给出与任务相符的初始展示；没有“末帧永远最佳”或“把全部帧都送入”的全局规则。

采集延迟、工具延迟、输入图数/字节、估算与实际 token、回取失败、视觉调用次数和任务完成情况使用现有 tracing 承载。少调用不自动代表聪明，多 inspect 也不自动代表有效；必须结合解决了哪条疑问判断。

### 11.4 首轮 token 的增量预算

首轮新增输入分为工具 schema、短行为指导、观察标签和新增图片。原件/收据在本地归档不占模型 token；不能把归档的全部内容、目录或笔记自动放入首轮。复用现有 skill 说明，完整视觉操作指导在使用时展开，不把整份技能或本提案塞进 system prompt。

2026-10-18 以本提案参数组成精简字段草案，对 compact JSON 使用当前 countTokens 做离线估算：history 约 97、inspect 280、pixels 298；三工具数组在 Anthropic 形状约 675、OpenAI 形状约 697，加一段 98 的行为指导，合计约 **773–795**。一个短观察标签示例约 16。这里是草案字节的启发式估算，不是已实施工具的抓包、provider BPE、API usage 或账单；真实描述、协议包装和模型不同都会改变最终数值。[估算实现](../packages/agent/src/tokenizer.ts)

| 路径 | 纯文本新任务首轮增量 | 限定 |
| --- | --- | --- |
| 调用方未装配视觉能力 | 0 | 工具面与提示均不增加 |
| 已装配，精简 native schema 基线 | 草案约 0.8k 估算 token | 当前推荐的可靠预算基线；不是“按需执行所以零 token” |
| 复用已有发现/调用入口，仅新增短能力提示 | 提示草案约 54 | 仅为接线和行为验证后可选的目标；既有入口已存在，未另加 schema/分类器 |
| 首轮已有图片输入 | 另加短引用标签 | 同一图片不因建档重复入模；不能把原本图片的视觉 token 全算成新增成本 |
| 长视觉任务恢复 | 视缺失启动信息而定 | 必要图片、状态或摘要单独计量，不套用纯文本新任务的 0.8k |

在 KodaX-next-dev 2026-10-18 的首轮优化记录中，入口收敛约省 358–380 启发式 token，OpenAI 形状模型字段约 20,535。记录来自该工作树的 docs/designs/tool-entry-consolidation.md（HEAD 5ada4f7c 加未提交修订；本轮未重跑其抓包）。以上 native 草案约占这一同口径参考输入的 3.9%，可能抵消已取得的入口收敛收益。该比较只用于说明量级，不假定该分支已合并或是本提案实测。

因此将“少量开销”收紧为开发验收目标：相同纯文本空历史 fixture 下，默认启用的 native 路径新增估算 token 目标约 800、上限 1000；不增加模型请求，不重复注入 skill/状态，不增加默认图片。若超限，先检查重复说明和表示，不删除必需能力。最终对 SA/AMA 和实际 provider 的完整模型输入做本地抓包核对，API usage 与缓存命中另记。

按需 schema 的 54 不能当作上线承诺。若为省几百 token 新增一次携带约 20k 上下文的模型往返，可能抵消许多轮常驻节省；必须同时观察全任务调用数、输入量、延迟和能力。Prompt cache 也不能被当作首轮上下文字节消失。

## 12. 交付拆分与改动范围

按以下垂直切片开发，每片贯通实际模型输入；不先建设大而无使用者的抽象平台。

| 切片 | 必须交付 | 交付后可见效果 |
| --- | --- | --- |
| A：一条真实图片闭环 | 最初 user image 与一个现有图片工具来源接纳；稳定 ID、可见标签、history、单图/局部 inspect、真实 provider image；接通所选 owner 的恢复与原件保留 | 普通图片任务中能定位疑点、重新看原图/局部，恢复后仍能找到它 |
| B：多观察与数值核实 | 有序多 view、跨时刻/区域比较、格心像素采样、精度说明、生成前预算与取消 | 图表/网格/动态采样任务能围绕疑问选择证据 |
| C：持久化与产品补齐 | Host/standalone 对应接线、原件缺失语义、压缩/重启/fork 可见性、Artifact 当前验收与历史回看边界 | 扩展到长任务和产物检查，避免“短 demo 可用、恢复就失效” |
| D：一个动态消费者 | 优先现有可控时序/交互来源；动作关联、新观察、过期依据与失败后不重放；先用确定性场景验证 | 验证主动补采样和根据反馈修正判断的通用闭环 |
| E：按需独立扩展 | 浏览器/桌面、视频、ARC、游戏或其他渲染后端 | 复用同一检查能力；环境规则、动作和评测独立交付 |

A 中所选工作流的恢复不能等 C 才实现；C 是覆盖其他 owner/分支和产品边界的补齐。D 不要求先开发完整 computer-use 平台，也不以游戏分数作为主体完成条件。

预计主要改动集中于 agent/media 的可选能力与工具、coding/Host 图片接纳和历史投影、现有 skill 指导及必要的 provider 接线测试。Runner 可能需要小型提交/接纳接缝修补，但不重写运行循环。llm 图像协议、Artifact 渲染引擎、全局并发和任务规划保持各自现有职责。

主体范围不应承诺精确天数或代码行数；最容易低估的是恢复/分支、实际 provider 多图路径和媒体生命周期。真实桌面、持续运行游戏、连续视频控制另计，不能塞进“几个工具”的估算。

## 13. 验证什么才算做成

后续实现遵循仓库 TDD 和现有覆盖率要求；先做机械验证，再做小规模行为验证。本提案没有运行模型、benchmark 或付费实验。

### 13.1 机械验收

| 验收项 | 必须可观察的结果 |
| --- | --- |
| 字节与身份 | 接纳后覆盖原路径，旧 ID 仍返回原 hash；相同 bytes 的两次观察保留各自事件；重复交付同事件不重复登记 |
| 完整输入链 | 通过公开 RunnableTool → Runner → 支持图片的 provider 请求构造，断言收到真实图片内容、顺序和标签，不能只测工具返回路径 |
| 最初 user image | 与工具图片同样可检索/裁剪；在持久化恢复后仍对应接纳时的原件 |
| 空间与像素 | 裁剪/放大坐标与输出映射正确；格心公式、RGBA/alpha、精确调色板索引和边界错误符合契约；不从展示缩略图或放大图测量 |
| 恢复与分支 | 保存 → 压缩/evict → 重启 → history/inspect 仍回取同图；fork 不见分叉点之后/旁支观察 |
| 认识与续接 | 新上下文获得必要观察、适用认识和最后动作/结果；不重复已有内容；重置/换 episode 后旧临时状态失效，历史证据仍可回取 |
| Artifact 边界 | 修改源文件后当前 readEvidence 拒绝旧证据，而历史 inspect 仍可读取已接纳旧快照，并标明 historical |
| 预算与取消 | 单调用可容纳但并行合批超量时，共享预留阻止超发；超量在生成前拒绝/要求缩小；执行中单项失败明确 partial；取消释放资源，不伪造完整结果 |
| 共享环境 | 两个基于同一旧观察的写操作不会仅因排队而都视为新鲜；延迟返回的旧截图不覆盖 current；执行后补图失败使旧依据失效，且不自动重放动作 |
| 无视觉路径 | 文本任务未调用视觉工具时，无新增图像 I/O、解码、采样或模型请求；提示成本与延迟单独记录 |
| 首轮增量 | 相同 fixture 比较完整模型字段；native 默认启用增量目标约 800、上限 1000 估算 token；按需披露另验功能/预算等价与额外往返 |
| 能力不支持/引用失效 | 清楚返回 unsupported、missing、expired、hash mismatch 或访问失败；不输出“已通过视觉检查” |

### 13.2 行为验证与效果边界

设计任何 eval 前先遵循 [EVAL_GUIDELINES](../benchmark/EVAL_GUIDELINES.md)。未来可用同一条生产工具路径，在固定的模型、提示、输入历史与图像接纳策略下，覆盖“小细节、旧画面、新观察、颜色核实、应当不看”五类受控问题。

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
- KodaX 基线 b0b446ec84fd20f21529025d086813eb5bcb2bd0：本文所链仓库文件的当前实现依据。后续代码变化应重新核查相关接缝。
- [HLD](HLD.md)、[PRD](PRD.md)、[Artifact SDK](ARTIFACT_SDK.md)、[评测规程](../benchmark/EVAL_GUIDELINES.md)：继续作为各自已有职责与流程依据。
- 本文是可评审的推荐提案；没有注册新 feature、修改已接受 ADR、实施生产代码或给出未经验证的效果数据。若进入开发，再把获采纳的契约与验收条件纳入正式 feature/spec。

