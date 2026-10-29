# 通用主动视觉 P3–P7 实施记录

起点：`30310e0018b3c0803653a278f451751a00ccc3bc`，`KodaX-next-dev`，2026-10-29（Asia/Shanghai）。按用户提供的 [续接要求](visual-harness-p3-p7-requirements-2026-10-29.md) 与主设计 §12–13 推进；P0–P2 与 IHDR 追补不重做。原设计、原 handoff 与续接要求文件的用户修改保留。本记录独立保留下列实际合同、验收和限制，未跟踪输入文档不作为唯一验收依据。

| 切片 | 状态 | 本片交付范围 |
| --- | --- | --- |
| P3a | 已实现并定向验证 | 1–4 个有序 view；同原件复用解码；整次生成前预留；有序 partial |
| P3b | 待实施 | 格心 RGBA、精确调色板、全调用 4096 样本；文本路由 |
| P4 | 待实施 | 排队/steer/redirect 接纳、fork 复制/隔离、重复压缩及生命周期 |
| P6 | 待实施 | 一个经生产装配的受控动态消费者；动作事实与 current 时效 |
| P5 | 待实施 | 先评估 MCP typed-image；Artifact/额外 Host/standalone 未声明支持 |
| P7 | 持续收集机械证据 | 最终成本、支持边界与受控行为实验方案；未发起付费调用 |

## P3a：有序多观察检查

`visual_inspect` 保持单 view 兼容，扩展为每次 1–4 个 view，仍是 Agent/Coding/Script 普通 native/checked bridge 工具，未加入 Script 叶白名单。模型说明明确 historical 与 partial；不新增 system 教学、视觉分类/发现步骤、模式或自动截图。

整次调用先检查参数和目录授权，再为全部图片、实际 question/label/观察标签及变换/错误包装预留输出。兄弟调用沿原 Run/batch 共用额度，不以 provider call ID 唯一标识。参数错误不读图片或解码。尺寸未知的来源仍在真实原件预检处判断，不能从目录元数据推导派生支持。

一次调用按不可变 content hash 分组，逐源读取并解码，同一原件多个区域/重复选择只解码一次。严格沿用已修 IHDR、CRC、位深、方向/色彩与 40 MP 上界；只支持既有 PNG 派生 profile。不同源 raster 不同时保留；输出图片顺序、标签和观察 ID 始终对应请求。全图回取保留既有 MIME 能力。

原件 missing/hash mismatch、编码/写入或取消等执行失败保留所在槽位。每张派生图编码完成后立即持久化和准备实际 image block，再开始下一张；不先积累整批 PNG。已完成视图保留；返回显式 partial 与 failedViews，不将检查回显重新接纳为来源观察。全部失败时取消图片预留，并同步改为实际错误文本的预留；多 view 全失败也按原位置返回标签与错误。partial 的预留保留到原批次结算。

TDD：三 view/重复观察测试先因“只支持一个 view”RED；最小实现后 GREEN。派生写入第二项失败的回归先发现第三项被连带丢弃，再修为只标记失败槽位。真实 1100×1100 噪声 PNG 的后续编码超字节限制先 RED，再修为保留已完成的小视图。评审另发现晚取消及全失败顺序问题：回归进入生产 `withPreparedImageHistory` 并使用同一 signal，先 RED，再修为立即准备首图、保留其真实 prepared payload。全失败 A0/B1/A2 也先 RED，再按原槽位返回。新增晚出现的非法区域、原件缺失与重复 provider ID 的并行双 view 容量回归；旧 IHDR/CRC/位深/尺寸、alpha、取消、恢复与原件保留测试继续运行。

支持矩阵：三模式 × OpenAI/Anthropic × native/checked bridge，共 12 格真实 Runtime → read/Script leaf → visual_inspect → 生产 serializer，通过三个 image payload 的 bytes、数量和顺序断言。它证明离线构造出的请求，不能替代远端协议接受或模型行为验证。兼容 CLI/未知 Host 未新增支持声明。

成本：[逐片完整字段证据](visual-harness-p3-p7-costs.json)。P3a 对 `30310e00` 增加 19–20 个估算 token；对 P0 累计增加 387–402。24 个未装配 owner 的 SDK 格完整字段 hash 不变。32 格候选由实际离线 SDK 序列化截获，最终 raw 为 OS Temp `kodax-first-turn-wire-LSuhJd`，先前检查点 `kodax-first-turn-wire-kwGE8M` 也保留；基线复用原 P0–P2 raw，并逐个核对 30310e00 的模型合同源码，显式区分 Windows LF/CRLF 字节。未重写旧成本 hash，也不把此次复用称为重新抓取的基线。数字不是 BPE/API usage、视觉计费或智能收益。

最终定向验证：6 文件 **52 项通过**；`npm run typecheck`、`npm run build` 通过。只对本片修改的 visual-tools/visual-raster 统计覆盖：语句 **93.75%**、分支 **89.20%**、函数 **97.36%**、行 **99.40%**，不是全仓覆盖率；raw 为 OS Temp `kodax-visual-p3a-final-coverage-20261029`。CLI 为 5,133 KiB，bootstrap 为 4,042 bytes，既有体积上限及启动依赖守卫未调整；14 SDK 声明检查通过。全仓留待集成里程碑。

本机 compiled public media 工具暖 codec 单样本：3×2 RGBA 原件 83 bytes（SHA-256 `b958f4d9d3ec0bdd5d17cfc029eb4e4d72b9b2d38ab140683d58740d5e7a5109`），三张 1×1 输出各 70 bytes。蓝像素输出 hash 为 `aa5bc32408344e789a7c52aa0d3f3bdfe145c6724e197cb1e2bbfd055f2f9373`，半透明青像素为 `f1cdc8d2aa15128a8e5ff91b37cef89d0a722ce020d60d751f17ee780766df3c`，第三张重复第一张。仅解码一次约 18.25 ms；编码分别约 0.19/0.38/0.26 ms；工具含文件 I/O 共约 39.02 ms。raw/复现脚本在 OS Temp `kodax-visual-profile-4L7RXB`。这是当前本机一个小 fixture 的工作量记录，不是冷启动、配对性能收益或模型图片计费。

### Standards

独立只读审查：0 项发现。多 view 的分组、预留、失败槽位与结果排序职责明确，无成文规范违反或值得提报的 Fowler smell。

### Spec

独立只读审查初次发现 2 项（晚取消、全失败顺序），均经上述 RED→GREEN 修复；复核 **0 项剩余发现**。生产 prepared-image scope、同源单次解码、逐源内存及已修 IHDR 预检均保留。像素工具仍属下一片 P3b，不将 P3a 标成完整 P3。

## 持续保留的失败与未验证范围

此前全仓原始结果为 17,952 通过、1 失败，Feature 270 临时 evidence.json 缺失原因未查明；独立单文件通过不表示问题已解决。后续全仓结果单独记录，不覆盖历史。

没有在线模型/付费实验、ARC、完整桌面或实时游戏接入。P7 行为部分未执行，不把机械测试或工具数量当作主动取证/智能提升的证据。
