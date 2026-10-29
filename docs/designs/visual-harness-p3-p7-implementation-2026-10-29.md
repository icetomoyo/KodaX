# 通用主动视觉 P3–P7 实施记录

起点：`30310e0018b3c0803653a278f451751a00ccc3bc`，`KodaX-next-dev`，2026-10-29（Asia/Shanghai）。按用户提供的 [续接要求](visual-harness-p3-p7-requirements-2026-10-29.md) 与主设计 §12–13 推进；P0–P2 与 IHDR 追补不重做。原设计、原 handoff 与续接要求文件的用户修改保留。本记录独立保留下列实际合同、验收和限制，未跟踪输入文档不作为唯一验收依据。

| 切片 | 状态 | 本片交付范围 |
| --- | --- | --- |
| P3a | 已实现并定向验证 | 1–4 个有序 view；同原件复用解码；整次生成前预留；有序 partial |
| P3b | 已实现并定向验证 | 格心 RGBA、精确调色板、全调用 4096 样本；文本路由 |
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

## P3b：格心数值采样

`visual_read_pixels` 接受 question 与 1–4 个有序 view，每项指定 label/observationId/region/rows/columns。region 为原 raster 整数半开区间；rows/columns 为正整数、不超过选区尺寸；所有 view 合计不超过 4096 样本。工具与底层共用 `validateVisualSampleCount`，不是每个 view 分别享有 4096。

返回纯文本 JSON，含 complete/partial/error、统一 profile、每项来源标签、原 region 和 sampleX/sampleY 坐标轴。采样点分别为 `x+floor((c+0.5)*width/columns)`、`y+floor((r+0.5)*height/rows)`；indices 为行优先二维整数矩阵，引用一次调用内按请求顺序建立的精确 RGBA palette。alpha 原样保留，不量化、不合成背景、不设 64 色上限；这些值只代表声明的解码 raster，不证明未采样细节或物理色彩。

沿 P3a 的严格 PNG/IHDR/CRC/位深/方向/40 MP 预检与同一 decoder 槽。一次调用按原件 hash 分组，逐源单次解码，完成项及时记录；坏源或取消只使对应未完成项失败。全失败释放大结果预留后，按实际错误文本重新预留；partial 的完整预留保留到既有批次结算。不返回图片、不编码展示图、不调用第二模型，也不将检查结果新接纳为来源观察。

预留依据是所有坐标、最坏精确调色板/索引、实际标签、question 和有界错误包装的 JSON 上界，同时提供 token/文本字节估计，不用 1500/图估算数值表。coding adapter 在解码前读取原 `tool-result-policy` 的字节及 per-entry attention 上限；视觉兄弟调用共享其 batch attention 与物理剩余容量。未扩大现有策略上限、不绕开最终 pairing/spill/capacityDebt。4096 是工作量上限，不承诺每个达到上限的请求都能容纳；例如生产 40 KiB 策略下预估大表先明确拒绝，要求减采样。standalone owner 仍负责注入自己的额度，既有只接受 token 参数的 callback 保持兼容，可同时消费新增可选的 textBytes 提示。

TDD：真实公共工具缺失先 RED，随后用手写 3×2 RGBA 真值验证格心坐标、透明/半透明和跨 view 精确调色板。2048 色表在最终策略会 spill 的生产工具反例先 RED，再改为解码前拒绝；未识别的 region 字段也先 RED，再按既有 schema 拒绝。16 项像素回归覆盖超过 64 种颜色、全调用超 4096/恰好 4096、网格越界、预留不足、坏 IHDR/CRC/16-bit、hash mismatch 有序 partial、后续来源取消与已完成值保留。纯文本 provider 的公共 coding 工具仍能返回数值结果，图片 gate 仅用于 inspect。

支持矩阵：Agent/Coding/Script × OpenAI/Anthropic × native/checked bridge 的 12 格真实 Runtime 进一步验证数值 JSON 完整、palette/indices 正确且未被截断；Script 叶白名单未增加。纯文本 provider 验证限于公共 coding 工具 wrapper，不据此宣称所有 CLI/provider 或图片上传路径已支持。JPEG 等既有上传/全图保留，派生/数值仍限声明 PNG profile。

最终定向验证：7 文件 **70 项通过**；另跑既有 policy/budget/Runner batch/wiring 与像素回归共 5 文件 **83 项通过**（两组有重叠，不相加）。`npm run typecheck`、`npm run build` 通过。覆盖实际报告范围为 visual-raster/visual-tools/coding visual 三模块：语句 **94.70%**、分支 **89.47%**、函数 **97.05%**、行 **99.20%**；不是全仓覆盖。raw 为 OS Temp `kodax-visual-p3b-final-coverage-20261029`。CLI 5,138 KiB、bootstrap 4,042 bytes，体积门槛/依赖守卫未改，14 SDK 声明检查通过。

完整字段成本见同一[逐片证据](visual-harness-p3-p7-costs.json)的 `p3b-pixels`：32 格实际离线捕获 raw 为 OS Temp `kodax-first-turn-wire-RuZNsN`；24 个未装配 owner 的 SDK 格 hash 不变。三工作面 OpenAI 当前为 Agent **11,791**、Coding **15,423**、Script **17,293**；相对 `30310e00` 增加 **365/366/366**，相对 P0 均累计增加 **748**。Anthropic 为 **11,546/15,048/17,128**，相对 `30310e00` 均增加 **358**，相对 P0 均累计增加 **726**。这是新合同实测的本地估算，不是 API usage、计费、全任务收益或模型智能提升。

compiled public media 暖 codec 单样本复用上述 3×2、83-byte 原件：三次格心选择产生两色 palette、无 image block，数值 JSON 1,375 bytes；解码一次约 20.96 ms，无图片编码，工具总计约 25.38 ms。raw/复现位于 OS Temp `kodax-visual-profile-MLS88C`，样本 JSON hash 为 `0c343d11b924ac1eefdd9f62ae62b8dacdf550ea2a4dee5385b0d0ca3dda28fe`。含运行时观察 ID/时刻，不拿它作跨次字节相等或速度收益结论。

### Standards

独立审查无硬违反；1 项重复样本上限规则判断已集中到共用校验，复核 **0 项剩余发现**。

### Spec

独立只读审查 **0 项发现**。数值路由、整次资源上界、原坐标/alpha/调色板、顺序与失败结算均符合本片要求；行为与在线验证仍未执行。

## 持续保留的失败与未验证范围

此前全仓原始结果为 17,952 通过、1 失败，Feature 270 临时 evidence.json 缺失原因未查明；独立单文件通过不表示问题已解决。后续全仓结果单独记录，不覆盖历史。

没有在线模型/付费实验、ARC、完整桌面或实时游戏接入。P7 行为部分未执行，不把机械测试或工具数量当作主动取证/智能提升的证据。
