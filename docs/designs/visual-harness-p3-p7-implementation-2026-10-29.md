# 通用主动视觉 P3–P7 实施记录

起点：`30310e0018b3c0803653a278f451751a00ccc3bc`，`KodaX-next-dev`，2026-10-29（Asia/Shanghai）。按用户提供的 [续接要求](visual-harness-p3-p7-requirements-2026-10-29.md) 与主设计 §12–13 推进；P0–P2 与 IHDR 追补不重做。原设计、原 handoff 与续接要求文件的用户修改保留。本记录独立保留下列实际合同、验收和限制，未跟踪输入文档不作为唯一验收依据。

| 切片 | 状态 | 本片交付范围 |
| --- | --- | --- |
| P3a | 已实现并定向验证 | 1–4 个有序 view；同原件复用解码；整次生成前预留；有序 partial |
| P3b | 已实现并定向验证 | 格心 RGBA、精确调色板、全调用 4096 样本；文本路由 |
| P4a | 已实现并定向验证 | queued/after_turn/redirect 接纳与活跃 steer；撤回、重绑、交付重试 |
| P4b | 已实现并定向验证 | fork 复制/隔离、重复压缩、Script 恢复见证及 owner 清理重试 |
| P4c | 已实现并定向验证 | owned 历史图片自动重装配的 hash 校验；P4 按下述通道及未验边界声明 |
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

## P4a：产品排队图片的固定接纳与交付

沿既有 pending input owner 保存原意图和授权，不新建队列或日志。图片在 after_turn/积压 queued 的 enqueue ACK 前、redirect 取消旧 Run 前、steer 的活跃目标/权限/窗口检查后及 interrupt ACK 前，写入本 Session 的不可变媒体与 canonical 收据。原路径之后覆盖或删除不改变交付图；相同 inputId/原意图复用同一 observationId，异意图拒绝。只有输入实际进入 canonical 活跃 lineage 后，目录才可见；staging 先检查既有纯文本 inputId 冲突，防止未交付图借旧身份提前公开。

交付时使用固定原件路径，并校验 missing/hash mismatch；失败保留明确诊断及未交付状态，不读同名当前文件。完整性校验沿既有上传合同读取原字节，未把派生处理的 10 MiB 上限转为上传拒绝；大于 10 MiB 的 unverified 原件仍通过生产 serializer 保留 bytes。此处不扩展派生 PNG profile，也不承诺远端接受超限输入。

多输入按原顺序及 inputIds 保留独立观察；首项纯文本也可与后续图片合并。交付 Run 引用在 canonical 消息前写入同一扩展收据，目录可见性仍由 canonical 输入证明。一次 canonical 写成而 ACK 失败后，重试仅结算该已提交输入前缀，后来图片留到下一批，不能静默吞掉。已进入 canonical 的输入不能被仍保留的 queue fact 撤回。尚未交付的撤回先写同一收据的 tombstone，再由既有队列移除；写失败不移除 pending body，重启后不会复活已撤回 ID。

同 principal 用新 execution key 恢复 pending 输入时，先通过原 queue owner 的意图/身份重绑，再更新视觉收据 digest；不借此放宽 foreign principal 授权。Session 保存保留视觉命名空间已有收据与顺序，以单调 revision 防止旧 Run 快照抹除后来接纳、回滚 Run 引用或撤回事实；其他扩展记录仍沿原保存/清空语义。

| 产品路径 | 实际验证范围 | 边界 |
| --- | --- | --- |
| immediate | P1–P2 保持；本片继续回归 | 未重做或扩宣平台 |
| after_turn / 已有队列的 queued | 活跃 Run 安全点或后续 Run；覆盖/删除、重启、同意图重试、多输入、授权换绑、容量与失败 | ACK 与模型可见性分别断言 |
| redirect | 实际取消信号回调中覆盖原图，后续生产请求仍发送接纳时 bytes | 不把取消完成等同已交付 |
| steer | 活跃目标 Run 安全点交付；clean close 后未交付图不可复活 | 未证明 crash checkpoint 中未交付 steer 的跨进程重放 |
| fork / 多次 compact / archive-delete | 下一片 P4b | P4a 不替这些路径背书 |

新增 17 项 Runtime/storage 回归走配置 provider 的真实 OpenAI serializer，以离线 fetch 拦截实际 wire，禁止其他 URL。RED→GREEN 包括入队前无收据、并发 read 的旧快照覆盖、Run 引用回滚、撤回后复活、失败 ACK 后丢新图、换 lease 拒绝同意图、旧纯文本 ID 提前公开、首纯文本合并批次重试，以及交付前 missing/hash mismatch。redirect 与 steer 分别去掉 staging 时实际出现 RED，再恢复接纳边界。撤回写失败、5 项队列容量拒绝、foreign principal、损坏原件及 clean-close steer 反例保留；未使用真实模型行为作断言。

最终定向验证：8 文件 **88 项通过**；`npm run typecheck`、`npm run build` 通过。仅统计 runtime-visual-input/visual-observations 两模块：语句 **85.86%**、分支 **81.11%**、函数 **90%**、行 **92.36%**，不是全仓覆盖；raw 为 OS Temp `kodax-visual-p4a-final2-coverage-20261029`。早期大原件测试的逐元素 Buffer 断言超过 30 秒，改为原生 Buffer.equals，未增加超时；独立重跑及最终集合通过。CLI 5,144 KiB（5,267,402 bytes）、bootstrap 4,042 bytes；既有门槛与依赖守卫不变，14 SDK 声明检查通过。全仓验证仍留集成里程碑。

完整字段成本见 `p4a-inputs`：32 格实际离线捕获 raw 为 OS Temp `kodax-first-turn-wire-SJPfaW`；本片未改工具/提示合同，相对 P3b **+0**，24 个无 owner SDK 格 hash 仍不变。相对 30310e00 仍为 OpenAI **+365～366**、Anthropic **+358**；相对 P0 累计 **+748 / +726**。这些是本地估算，不是 API usage、费用或总体任务收益。

同一 3×2、83-byte 已知 RGBA 原件（SHA-256 `b958f4d9d3ec0bdd5d17cfc029eb4e4d72b9b2d38ab140683d58740d5e7a5109`）的本机单样本：首次接纳含既有验证约 38.33 ms，删除源文件后 materialize 约 0.82 ms，保留收据重试约 0.47 ms；后两步仅读/hash，不解码或编码，不生成额外图。raw/复现为 OS Temp `kodax-visual-input-profile-e3nBrg`。这是 helper 工作量记录，不是端到端或配对速度收益；无图输入不增加截图、目录扫描、解码、轮询或模型请求。

### Standards

独立只读审查：0 项硬违反；1 项收据识别重复判断已集中到共同读取函数，复核 **0 项剩余发现**。

### Spec

独立审查发现的 ACK 批次重试、授权换绑、旧文本身份冲突、纯文本首项重试及误用派生字节上限均已按上述反例修复；最终复核 **0 项剩余发现**。steer crash 恢复、P4b 与模型行为未计为通过。

## P4b：分支媒体与长历史

FileSessionStorage 的视觉 fork 先读取精确 main/sidecar 快照，再按所选 source lineage 的可见观察继承。agent/media 的共同可见性函数同时识别物理/稳定 logical identity、精确 input aliases、compact 前驱与既有 Script 恢复见证；没有以“收据在文件里”代替可见性。只复制获授权的观察，保留 observationId/observedAt/hash，绑定子 owner；后续两支互相隔离，执行前 entry 仍看不到未来图。

子分支复制所需原件及模型历史中的派生媒体，按 hash 去重，校验 bytes 后写入独立 Session 命名空间；普通和嵌套 tool_result image、compact 附件都重映射。Windows 路径按平台等价比较，重启只改变 sessionsDir 大小写也可映射。父 Session archive 保留原件；删除父或中间子分支不影响已继承子/孙分支的真实 bytes。不新建观察事件或全局引用计数。

普通 fork 与 revision-fenced historyBoundary fork 都保留精确 compact 前驱证据岛：复用现有 lineage 克隆，映射新物理 ID 并保留 logical ID，旧岛保持与当前模型上下文断开。未为没有视觉记录的普通 Session 增加全历史加载。两次 compact/evict、sidecar 完整加载、存储实例重启、再次 fork 均有回归。Script 已提交 leaf 的外层失败恢复见证也经两次压缩与公共 Runtime.sessions.fork 验证，父 Session 删除后实际 visual_inspect → OpenAI serializer 仍得到旧图，原 Script 执行次数保持 1。

不继承父 Run 的产品 ACK 收据。继承的用户图片 inputId 只作历史身份；在子 Session 中复用该 ID，无论同意图还是异意图都明确要求新 ID，不能用旧 content 静默替换新请求。普通父会话的文本 inputId 与 Script read 的 source.inputId 分开，只有精确 `originEntryId=input:<id>` 的用户快照参与产品输入重试，不误伤文本输入。

fork 在源锁内先拒绝已存在目标，再持目标锁复查/写入，交叉 A→B/B→A 不互等。媒体复制完成后才 canonical ACK；复制/原件/派生上下文路径或 hash 失败清理未提交命名空间。canonical rename 后的失败保留已提交子媒体；写入与恢复/清理都失败时 AggregateError 保留两项原因。已失败未提交 fork 的遗留媒体可通过原 FileSessionStorage.delete owner 路径清理后重试，不覆盖已有目标。

真正删除沿既有原子 tombstone 机制。物理清理失败记录诊断，不宣称磁盘 bytes 已全部清除；FileSessionStorage.delete 再次调用只清理同一 owner 的精确数字 tombstone 名称，不碰仍可访问的分支。已存在 Session 先验证 Actor owner，再做清理；未确认 owner 的 deleteOwned 不因 canonical 缺失而取得清理权。此处验证的是 storage owner 重试，未新增已删除 Session 的 UI 清理入口或后台扫描。

| 路径 | 本片证据 | 未扩宣范围 |
| --- | --- | --- |
| 普通 fork / 早期 entry / rewind | 真实 FileSessionStorage，父子隔离与新物理 ID、稳定观察 ID | 不放宽 owner 检查 |
| 两次 compact + historyBoundary fork | main/sidecar、evict、重启、子孙保留 bytes | Runtime historyBoundary UI 未单独操作 |
| Runtime.sessions.fork | 用户图片身份负例；Script 恢复、父删除、原件回取及实际 serializer | 不等同在线 provider 接受或行为验证 |
| archive / delete / 清理失败重试 | 真实 storage/Runtime；分支原件保留、tombstone 诊断、foreign owner 拒绝 | 首次物理清理失败不报全清理完成 |
| 自动重装配旧 owned 历史图 | P4c 待补 | 本片不将缺失的 serializer hash 校验记为通过 |

TDD：普通 fork 目录为空、两次压缩后两个 fork 路径丢观察、清理失败后不能重试均先 RED 后 GREEN。双轴审查另触发交叉锁等待、继承 inputId 吞异意图、Windows 大小写漏映射、普通 Script 文本重试误判以及写入/清理双失败丢原因的真实负例，均已修复。自查还以 foreign Actor owner 的清理副作用反例 RED→GREEN，将授权检查前移。派生媒体复制、错误 filename/hash/missing、canonical 前后失败、再次删除/分支保留均保留为可执行反例。

最终定向验证：6 文件 **54 项通过**；较早的完整 storage.test.ts 与视觉 storage 集合 2 文件 **150 项通过**，两组有重叠且候选修订不同，不相加。`npm run typecheck`、`npm run build` 通过；完整仓库回归仍留集成里程碑。覆盖实际范围为 visual-lineage/visual-fork/visual-owner/runtime-visual-input 四模块：语句 **88.44%**、分支 **80.60%**、函数 **86%**、行 **96.73%**；不是全仓覆盖。raw 为 OS Temp `kodax-visual-p4b-final3-coverage-20261029`。CLI 5,149 KiB、bootstrap 4,042 bytes；体积门槛及启动依赖守卫未改，14 SDK 声明检查通过。

成本见 `p4b-fork`/`p4b-final`：32 格实际离线捕获 raw 为 OS Temp `kodax-first-turn-wire-ScgoeA`，完整模型字段 hash 与 P3b/P4a 一样，新增 **+0**；24 个未装配 owner SDK 格不变。最终存储/身份修补后，逐个核对 15 个被捕获的模型合同源码 hash 仍相等，final 阶段复用这次 raw 并另存最终实现 hash，未声称重新捕获。相对 30310e00 仍为 OpenAI **+365～366**、Anthropic **+358**；相对 P0 **+748/+726**；不是 API usage 或任务总体收益。

compiled public FileSessionStorage.fork 本机单样本：同一 3×2、83-byte 原件（hash 同前）复制 1 文件/83 bytes，含 full snapshot、校验、子 canonical fsync/cache 约 **68.54 ms**；不解码或编码。raw/复现为 OS Temp `kodax-visual-fork-profile-7thlXK`。只记录一个小 fixture 的本地工作量，不作配对性能或模型价值结论。

### Standards

独立审查 1 项写入错误被恢复错误覆盖的问题，已以双失败回归修复；最终 **0 项剩余硬违反、0 项 smell 判断**。

### Spec

独立审查 3 项初始发现及 1 项补充发现均按上述反例修复；最终限定范围复核 **0 项剩余发现**。P4c serializer 旧媒体完整性明确留待补修，P4 未整体完成；动态 current/reset 的适用认识留给 P6，模型行为未执行。

## P4c：自动历史图片的完整性

补齐 P4b 明确保留的恢复缺口：新 Run 自动装配历史时，文件即使仍能解码，也不能把 hash 路径下被替换的 bytes 当作旧图上传。File visual owner 提供可选 `expectedImageHash(path)`，仅识别自己的内容寻址媒体目录；LLM 的同一个 prepared-image scope 接受该不可变期望，不依赖 agent/REPL。scope 内每个路径的预期固定；不新增图片 block 字段或模型指导。

从文件恢复时先校验 SHA，再进入既有解码验证；已经持有并验证的 tool bytes 在准备 payload 时也走同一校验。失败形成明确的 historical integrity placeholder，缺失仍沿原 missing placeholder；不换当前同名文件、不采新帧、不创建新观察。原 Run 已固定的 payload 仍发送原 bytes，不因稍后的文件变化改写已接纳证据。图片来源权限仍由原 owner/lineage 控制，hash 回调不授予路径访问权。

Coding/Agent/Script 的两条 native 执行封装注入同一 owner 期望，checked bridge 共用实际准备链。没有 owner 或自定义 owner 未安装该可选期望时，SDK 保持原 fresh-file 语义，不承诺该宿主的跨重启完整性。超 10 MiB 的 unverified 原件只要 hash 匹配仍保留原 bytes，未引入上传硬上限。没有图片的请求不调用校验、扫描目录或增加模型请求。

Windows 大小写按同一物理 owned 路径识别，hash 名正规化；同时修正 fork 的同一 SHA 文件名大小写边界。真实 prepared-image diagnostic 与 storage 回归分别先 RED 后 GREEN。目录外即使使用同一个 hash 文件名，也不被该 owner 强加其完整性期望。

支持矩阵新增：三模式 × OpenAI/Anthropic × native/checked bridge，12 格真实 Runtime 在接纳 read/Script、多图检查与像素结果后，篡改历史媒体为另一张有效 PNG，关闭并重启，再经生产 serializer 明确输出完整性占位，绝不发送被替换的新 bytes。另有 Coding/OpenAI native 历史文件删除反例。源观察数量仍为 2，不能以本次错误提示刷新来源或 current。

TDD：底层已固定 payload/新 Run 恢复反例先收到替换 JPEG 而 RED；增加期望后 GREEN。生产 Coding/OpenAI 接线反例也先 RED，再接两条封装；其余 11 格随后通过。直接已验证 tool payload、不解码坏 hash、无 owner SDK、目录外同名文件和大原件传输反例均保留。独立审查 Standards/Spec 各 **0 项发现**，最后 Windows 补修也复核各 **0 项**。

最终定向集合：7 文件 **104 项通过**；Windows 全路径 fork 的独立回归 **1 项通过**。此前图像验证集合另有 7 文件 **106 项通过**，候选和集合不同、有重叠，不相加。`npm run typecheck`、`npm run build` 通过。仅统计 image-serialization/visual-observations 两模块：语句 **87.89%**、分支 **83.22%**、函数 **93.75%**、行 **91.32%**；raw 为 OS Temp `kodax-visual-p4c-final-coverage-20261029`，不是全仓覆盖。CLI 5,150 KiB、bootstrap 4,042 bytes；既有体积上限、依赖守卫及 14 SDK 声明检查保持。

首轮字段见 `p4c-integrity`：32 格实际离线 SDK 捕获 raw 为 OS Temp `kodax-first-turn-wire-TnvBaC`；最后大小写修补后 15 个被捕获模型合同源 hash 逐个仍匹配。与 P3b/P4a/P4b 相比 **+0**，24 个无 owner SDK 格不变；对 30310e00 增量仍为 OpenAI **+365～366**、Anthropic **+358**，对 P0 累计 **+748/+726**。不是 BPE/API usage、视觉计费或总体任务收益。

compiled public prepared-image scope 本机单样本（先暖原件验证缓存）：同一 83-byte 3×2 PNG 读/hash/准备约 **0.63 ms**；替换为 826-byte JPEG（SHA-256 `4e6f28b4d9d64e71e315166a296fde41c04cf4afcac195ddc076d3cdd16a7dd0`）后拒绝约 **4.16 ms**，产生明确占位，无 PNG 编码。raw/复现为 OS Temp `kodax-visual-integrity-profile-gvn5dW`。这是小 fixture 的本地工作量，不是冷解码、网络、基线速度收益或模型行为结果。

P4a/b/c 至此完成上表限定的工程接线与定向验证；未交付 steer 的 crash checkpoint 重放、historyBoundary UI 及未列宿主仍保留未验状态。动态来源版本/current/reset 的续接认识继续由 P6 验证；P7 行为部分尚未执行，不以这些机械证据替代。

## 持续保留的失败与未验证范围

此前全仓原始结果为 17,952 通过、1 失败，Feature 270 临时 evidence.json 缺失原因未查明；独立单文件通过不表示问题已解决。后续全仓结果单独记录，不覆盖历史。

没有在线模型/付费实验、ARC、完整桌面或实时游戏接入。P7 行为部分未执行，不把机械测试或工具数量当作主动取证/智能提升的证据。
