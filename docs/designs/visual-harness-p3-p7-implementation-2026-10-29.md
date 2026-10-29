# 通用主动视觉 P3–P7 实施记录

起点：`30310e0018b3c0803653a278f451751a00ccc3bc`，`KodaX-next-dev`，2026-10-29（Asia/Shanghai）。按用户提供的 [续接要求](visual-harness-p3-p7-requirements-2026-10-29.md) 与主设计 §12–13 推进；P0–P2 与 IHDR 追补不重做。原设计、原 handoff 与续接要求文件的用户修改保留。本记录独立保留下列实际合同、验收和限制，未跟踪输入文档不作为唯一验收依据。

逐片成本短述中的三工作面指 Coding AMA、Agent、Script 六格；另有 Coding SA 兼容入口。完整八格及 Anthropic SA 的差异见最终 P7 表，不能将六格短述套到 SA。

后续验收更正：用户在 `30310e00 → 6778640e` 复核中复现了 P6b 收据等待竞态。此前“无剩余发现”仅是当时评审结果，不能继续当作无此缺陷的验收结论；实际补修与新证据见下方追补，旧测试计数和原始失败记录均保留。

| 切片 | 状态 | 本片交付范围 |
| --- | --- | --- |
| P3a | 已实现并定向验证 | 1–4 个有序 view；同原件复用解码；整次生成前预留；有序 partial |
| P3b | 已实现并定向验证 | 格心 RGBA、精确调色板、全调用 4096 样本；文本路由 |
| P4a | 已实现并定向验证 | queued/after_turn/redirect 接纳与活跃 steer；撤回、重绑、交付重试 |
| P4b | 已实现并定向验证 | fork 复制/隔离、重复压缩、Script 恢复见证及 owner 清理重试 |
| P4c | 已实现并定向验证 | owned 历史图片自动重装配的 hash 校验；P4 按下述通道及未验边界声明 |
| P6a | 已实现并定向验证 | native/checked bridge、managed/兼容入口透传 serial 谓词；不提供环境时效锁 |
| P6b | 已实现限定消费者；收据等待竞态已补修并定向验证 | 本地可暂停 PNG 卡片；current/version、动作事实、unknown 与补观察；派发前重检异步等待后的依据；子 Actor 无 owner 时拒绝 |
| P5 | 已实现选定 MCP 来源并定向验证 | typed tool/resource、SA fallback；Artifact/额外 Host/standalone 未声明支持 |
| P7 | 机械集成完成；旧 r3 为前置证据，任务价值验证未执行 | r3 工具选择/单轮 usage 保留；新方案以 1826cc22→3b2d48e8 比较取证后的最终任务结果与全程 token，按效果→成本→方向评审；r2 失败独立保留 |

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

## P5：选定 MCP typed image

本片只选择已有 MCP typed tool/resource（及兼容 SA 的同名 fallback）。MCP normalization 仍持 base64 解出的实际 Buffer 时，经 agent 层窄 AsyncLocalStorage callback 接纳到同一 Runtime owner；没有把字符串/structuredContent 中的路径猜成媒体。callback 在普通扩展执行 scope 绑定，sourceKey 为 server + tool/resource，source 保留精确 executionId、toolCallId、callOrdinal 与 typed imageOrdinal。checked bridge 继续使用既有目标 call ID 后缀，例如 `:mcp_call`，不伪装成外层 provider ID。

整批 typed 图片在解码/重输出前按图数、来源标签预留，沿同一 batch capacity；无有效接纳时取消一次，有已准备图片时保留到原批次结算。合法/不合法 MIME/base64/解码错误不换槽位；晚归档或取消失败保留首张实际 prepared bytes，返回 partial 和未处理说明。不在取消 signal 下继续发模型请求，诊断核对已准备 hash；新 Run 沿原件回取。原始大图仍沿 P1 unverified 保存语义，未把派生图护栏变成所有来源的上传限制。没有 owner 的 SDK 保持旧 temporary attachment 行为，不因此获得 durable 观察保证。

评审补修两条真实缺口：SA fallback 原在 scope 外、还用原 ctx；现整个回退在原精确 per-call scope 内执行，仍保留原 allow-list/权限。`mcp_read_resource` 原将 typed 数组 JSON 化；现复用同一 typed renderer，文本 metadata/structuredContent/isError 仍保留。Artifact 当前 readEvidence、额外 Host string/structuredContent materialization、standalone durable 与子 Actor owner 继续未接入，不将本片称为所有 P5 来源完成。

真实公共 Runtime 支持矩阵：Coding × AMA/SA × OpenAI/Anthropic × native/checked bridge，8 格各发两个相同 provider ID 的 MCP 调用，每调用两图，**四个独立观察**按 executionId/ordinal 严格核对；输入意图重试不再 RPC，覆盖/删除 producer 原路径、close/reopen 后可 inspect 原 bytes，plan 阻止 mutating MCP 远端调用。8 格还运行 typed resource→canonical tool result→生产 serializer；SA/OpenAI native/bridge 另验证缺失 read→真实 stdio MCP fallback→新观察与图片。AMA/OpenAI native 注入 canonical 保存失败，Run failed 且不发布 provisional 观察。以上均为实际本地 stdio + 离线 SDK serializer，不是远端 provider 接受或模型选择证明。

初始扩展回归未按预期收齐四图，诊断保留为 `kodax-visual-p5-diagnostic8.log`；原因是 Windows 两个相同原件竞争 rename 的 **EPERM**，不能归为 provider ID 或容量。20 个独立 file owner 并行 pin 相同 bytes 的公共回归先 RED；改为同文件系统临时文件 hardlink 独占发布，EEXIST 时逐 byte 核对才能复用，临时文件删除后仅留一个独立 owned 文件。错误/cleanup 保持上抛，未建全局引用计数或 worker 池。其后八格严格四图通过，没有放宽断言。选中用例名的第一次 `-t` 写法曾跳过用例，未记作 RED 或通过；启用新接纳前实际单格因 0 观察失败，启用后 GREEN。typed resource、fallback、后续图片失败及并行发布也分别保留实际 RED→GREEN。

最终 7 文件 **101 项通过**；raw `kodax-visual-p5-final-tests.log`、`kodax-visual-p5-final-coverage-20261029`。四个实际实现模块合计语句 **84.21%**、分支 **71.53%**、函数 **89.07%**、行 **85.98%**；不是全仓或各模块各指标均达 80%（visual-observations 语句 76.23%、resource wrapper 73.33%）。typecheck/build 通过，CLI **5,151 KiB**、bootstrap 4,042 bytes，未提高 5,152 KiB 门槛，14 SDK 声明检查保持。全仓集成另记。

默认成本 `p5-mcp` 32 格实际捕获 `kodax-first-turn-wire-2XNJsB`：相对 P3b/P4/P6 **+0**，24 个无 owner SDK 格不增模型合同。对 30310e00 OpenAI +365～366、Anthropic +358，对 P0 累计 +748/+726，仍为完整字段启发式估算。MCP 首次图片会附每张 observation 标签，其长度随实际 sourceKey/ID/时间/维度/hash 变化，结果本身按真实请求计量；不能把默认首轮 +0 说成使用 MCP 后的总体任务 +0。

本机 compiled public validation fixture：两张 2×1 PNG 各 **72 bytes**，绿 SHA `18ef183350314663b8b055cb6a44f7d633efe96db840232d58ebbcffdec92649`、红 SHA `58071d8eeb0d777fb1c5932943ecddfac227c7d1552312958f9c558b02597f6f`，验证为 valid，约 **29.58/25.16 ms**；没有派生编码。raw `kodax-visual-mcp-profile-2NWUnk`。先前 `--input-type=module -e` 入口得到 decoder_unavailable/unverified（23.10/19.03 ms），保留为未验证样本，不混作成功 decoder 耗时。单机两小图不是网络、视觉计费或模型价值结论。

### Standards

独立只读最终评审：**0 项成文规范违反、0 项 smell 判断**，含独占发布补修。

### Spec

两项 scope/typed wrapper 发现均按上述反例修复；独立最终复核：**0 项剩余发现**。未把未选来源或付费行为写成通过。

## P6b：受控本地动态消费者

通过 `@kodax-ai/coding/visual-environment` 显式安装两个普通 LocalToolDefinition：`visual_observe` 与 `visual_act`。默认 Runtime/CLI 不安装；卡片演示为 `node node_modules/vitest/vitest.mjs run src/sdk-runtime.visual-environment.test.ts`，使用真实 Runtime 装配、权限、媒体 owner、canonical 保存和生产 OpenAI serializer，provider 下一响应由确定性脚本驱动，外部调用为 0。它不是模型行为评测或 computer-use 平台。

消费者选择本地可暂停 2×1 PNG 卡片：source `cards`，版本 `episode:step`，动作 `reveal`/`select:1`，副作用计数由 adapter 实际状态核对。灰卡留下歧义，reveal 后显露红/绿，再用新观察选绿。adapter 对 reset/每次相关变化递增版本，在实际 effect 边界原子核对版本与 pending unknown；生产 owner 锁只能排序其自身调用，外部桌面焦点/持续变化不在承诺内。

每 source 一个 owner 队列、generation 与 sample 序号；没有全局 current。采样起始时间及 sourceVersion 写入观察原收据，仍标 historical；current 只是环境 owner 内待 canonical receipt 证明的候选。动作须同时匹配当前候选、来源版本、媒体 owner 与已提交可见收据，拿到锁仍重新核对。动作开始先失效 current；旧采样即使晚于新帧返回，只能保留为历史。historical inspect 不会刷新。typed admission 复用原 provisional extensionRecords/canonical 提交，未提前另存来源收据或建第二日志。

adapter 返回带 invocationId 的 not_dispatched/completed/unknown 事实。已执行后采图、归档或取消失败仍返回 completed + 补观察要求；unknown 不自动重放。observe/act 任一入口看到 live unknown 都清除旧 current/采样 generation；同版本调和之后仍须重新观察。恢复消费者时 current 为空，并从 adapter 的实际 pending/lastAction 确认状态；Runtime close/reopen 测试保留本地 adapter 事实对象，未声称模拟物理进程崩溃或远端 Host 断连。错误文本保留，超 1024 UTF-16 单元附显式 truncated 标记；最终 action fact 与 lastAction 一起计入图片结果动态预留。

capture 前预留图片和完整 metadata，接纳前按固定事实补差；失败取消未保留额度。沿 P2 同一严格 PNG/IHDR 预检，字节与尺寸沿 3.75 MiB/2000 展示护栏，不默默缩放。原件验证后才走 owner 准备；未知/未装配 owner 或容量拒绝。不增加自动截图、轮询、第二模型、Script 叶白名单或默认模式。初版直接从 media 聚合出口导出导致 CLI **5,156 KiB 超过 5,152**，构建明确失败；改为 opt-in 独立子路径后恢复 **5,150 KiB**，未提高上限，bootstrap 4,042 bytes、14 SDK 声明检查通过。

支持矩阵：Coding/AMA + OpenAI native 的真实 root Runtime 验证卡片闭环、plan-mode 0 effect、reset/stale、历史回取、close/reopen 后补观察与不重放。真实 spawn 子 Actor 试图使用父引用时缺少自己的媒体 owner，**明确拒绝**；不授予父媒体、不声明子 Actor 的观察/动作支持。public consumer seam 的两个独立 caller context 验证排队同 A 只有一次 effect、其他来源不被阻塞、晚采样历史化、未提交收据、unknown 调和、取消前/派发后/完成后、归档失败。这里的 caller context 不是实际 Actor 运行证明。跨物理进程、其他协议/模式/宿主尚未验收。

TDD：公共 Runtime 缺少消费者先 RED→GREEN；初版恢复 unknown 可动作、live unknown 同版本旧 A 重用（act 与 observe 两入口）、500 中文 detail 预留不足、3000 中文 completed 异常漏算依次以反例 RED→GREEN。最终 4 文件 **19 项通过**，raw `kodax-visual-p6b-final4-tests.log`；两实现模块语句 **91.36%**、分支 **82.52%**、函数 **88%**、行 **98.11%**，不是全仓覆盖；visual-owner 单模块分支 68.57% 仍明确保留。typecheck/build 已执行，最终集成另复跑。

默认首轮 `p6b-environment/p6b-final` 32 格捕获 `kodax-first-turn-wire-O5p8mu`，最终 15 个合同源 hash 逐个匹配后复用，未声称重抓。相对 P3b **+0**、24 SDK 无 owner 格不变；对 30310e00 OpenAI +365～366、Anthropic +358，对 P0 累计 +748/+726。显式安装消费者另从同一次 OpenAI Coding 完整 request 只移除两工具 schema 配对：**16,407→16,213，+194 估算 token、+778 ASCII bytes**；raw 为 OS Temp `kodax-visual-environment-cost-2ifPlg`，完整请求 SHA-256 `28672aaad99f43166da5810919cc67033c74b8b4a81cc632111f9283aafb1d75`。不把它混入默认增量，也不是 API usage/费用。

同一次 fixture 的初始 2×1 图 72 bytes，SHA `d5160c116c2218ec16d797ee1ddedbbfd6f9e8cec894bbf8b491f1750e42cd7d`；揭示后 74 bytes，SHA `18b895c28aecb37b71054e54561c937f6920b719cec778d21268446fee434356`。fixture 编码分别约 2.16/0.33/0.28 ms；这些不是生产 decoder、模型时延或基线性能收益。全任务 usage/cache/费用/智能提升未测量。

### Standards

独立只读评审的 1 项异常原因丢失已 RED→GREEN 修复；最终 **0 项硬违反、0 项 smell 判断**。

### Spec

独立审查发现 unknown 失效与资源计量边界，均按上述反例修复；最终限定范围 **0 项剩余发现**。子 Actor 无 owner、跨进程恢复与模型自主探索保持未支持/未验状态。

## P6a：执行顺序声明

LocalToolDefinition 明确已有 RunnableTool 的纯输入 serial 谓词，registry 提供同一查询；managed checked bridge 优先使用实际 Runnable override，兼容 native/bridge 使用解析后的目标注册。Bash 保持串行，谓词为 false 的独立调用仍并行。没有新模型字段、全局锁或 Script 白名单扩展。

真实 Runtime 的 AMA/SA × native/checked bridge 四格使用重复 provider ID。RED 时 managed native 已透传，其余三格发生错误并行；修复后四格按 first:start/end、second:start/end，false 则用双启动 barrier 证明并行。这只证明批次分类，跨 Actor/Run 的来源时效仍待 P6b。

定向与相邻合同 12 文件 **253 项通过**；typecheck/build 通过，CLI 5,150 KiB、bootstrap 4,042 bytes。三修改模块合计语句 **84.21%**、行 **85.94%**、函数 **85.61%**、分支 **71.54%**；registry 单模块语句 74.73%，不能称各模块或各指标均达 80%。raw 为 OS Temp `kodax-visual-p6a-final-test-20261029.log` 和 `kodax-visual-p6a-final-coverage-20261029`。最终集成另统计全仓。

成本 `p6a-serial`：32 格实际离线捕获 `kodax-first-turn-wire-ekBOkO`，相对 P3b/P4 增加 **0**；24 个无 owner SDK 格完整字段不变。对 30310e00 仍为 OpenAI +365～366、Anthropic +358，对 P0 累计 +748/+726，均为启发式估算，非 API usage。

### Standards

独立只读评审：0 项硬违反、0 项 smell 判断。声明复用执行元数据，不引入模型配置或反向依赖。

### Spec

独立只读评审：0 项发现。四格仅声明 serial 传播与 false 并行；环境 current、跨 Actor/Run 和动态行为尚未验收。

## P6b 追补：收据等待期间的动作依据竞态（6778640e 后）

用户独立复核发现 Spec P2：A 的 `visual_act` 暂停于 `owner.list()`，另一观察看到 unknown 并使 A 失效，随后 adapter 同版本完成调和。旧实现只在 await 前检查 current/unknown/version，恢复后仍派发了旧 A。该问题属于已承诺的共享环境合同，不是新增宿主需求。

在既有公共 consumer seam 新增受控收据 gate：实际观察 A 已提交→动作等收据→另一观察见 unknown 返回 historical→同版本 reconcile→释放收据。执行 `node node_modules/vitest/vitest.mjs run packages/coding/src/media/visual-environment.test.ts -t 'committed receipt lookup'`，修复前实际得到 **completed**，与预期 not_dispatched 相反（RED）；修复后 **not_dispatched、effects=0**，重新观察后仍能完成一次动作（GREEN）。没有放宽收据、owner 或 adapter 的版本要求。

最小修复：动作取得 source 队列后捕获 current 对象与 generation；收据读取完成后再次检查取消、unknown，并复核 current 身份、generation、uncertain、owner、预期观察 ID 与实时版本。最终复核到 `adapter.act()` 之间没有 await；adapter 仍负责实际 effect 边界的原子版本/unknown 核对，锁不承诺外部连续变化环境的状态。

另覆盖等待期间同版本新观察替换 current、reset、live unknown、取消四种交错，全部断言 **未进入 adapter、effects=0**。本片没有新增 Actor/Run/宿主支持：精确竞态是在公共工具与注入 owner 收据边界控制交错；既有真实 Runtime 卡片闭环、serial 四入口、其他来源并行及失败恢复回归继续执行。

定向集合 4 文件 **25 项通过**（含新增 5 项）；仅 visual-environment 模块覆盖语句 **94.54%**、分支 **90.54%**、函数 **87.5%**、行 **97.56%**。raw 为 OS Temp `kodax-visual-p6-receipt-race-tests.log`、`kodax-visual-p6-receipt-race-coverage-20261029`。类型检查与构建通过，CLI 仍为 5,151 KiB，14 SDK 声明检查通过。

代码冻结后执行本次默认全仓 `npm test -- --reporter=dot`，退出码 0：**18,072 通过、0 失败、97 skipped、19 todo**（共 18,188 项）；**1,295 文件通过、6 skipped**（共 1,301），用时 **1,077.52 秒**。日志为 OS Temp `kodax-visual-p6-receipt-race-full-20261029.log`。这是本补修的新结果，`6778640e` 的 18,067 以及更早失败记录仍按历史保留；不据此抹除 T30/Feature 270 的未定位原因，也不宣称需要凭证的在线集成或模型行为验证通过。

成本补充见 costs.json `followups/p6-receipt-race`：定向阶段先核对 15 个既有默认合同源 hash 与 `p7-final` 一致，复用其默认估算；随后本次全仓实际产生 **32 格新离线抓包** `kodax-first-turn-wire-B4xY9i`。按同一 `normalized-model-input.json` 完整模型字段口径逐格对比，32 个 SHA 均与 `p7-final` 相同（含 24 个未装配 owner SDK 格）；这不表示包含临时路径/运行 ID 的原始 wire 字节相同。比对证据为 OS Temp `kodax-visual-p6-receipt-race-default-compare-20261029.json`，未改写历史 raw/hash。

显式卡片工具的 name/description/input_schema 共 721 UTF-8 bytes，补修前本地 compiled 包与补修后源码的 JSON SHA 均为 `6183d7eb589619ad9e2dc296242d97f56dd4c77f30bd22476098960ea7601c99`。真实 Runtime 新 fixture 的同请求移除两 schema 配对仍为 16,407→16,213（+194 估算 token），raw `kodax-visual-environment-cost-FSU1Fh`；不是新增 API usage 或整体任务成本。本次未发起付费请求，P7 行为价值仍未验证。

### Standards

独立只读复核：0 项成文规范违反、0 项 smell 判断。前后共用 `basisIsCurrent`，不引入新配置或跨层依赖。

### Spec

针对用户指出的 P2，独立复核：0 项剩余发现；确认 await 后重检到 dispatch 无新增等待窗口。该结论只覆盖本次补修及所执行回归，不等同于证明不存在其它竞态。

## P7：最终集成、完整成本与行为方案

工程候选为 `a591967522287b8b880ee507347668e46f98ea15`（P3、限定 P4/P6、选定 MCP 来源）；P7 另增加离线 freezer、相同初始图/生产 tools 字节的反例，以及集成 fixture 校正。行为部分没有执行。可执行输入生成方案、四个 request/hash、预算和主会话盲审流程见 [P7 方案](visual-harness-p7-pilot-2026-10-29.md)。freezer 不含 provider 执行路径；provider/model 为 UNRESOLVED、已授权调用/token/费用均为 0。拟议的 4-call Layer 2 /512 输出 token /100,000 总 token /$1 停止上限 /60 秒 /同 provider 1 并发，须另行核对路由、费用并取得授权。该 $1 是上限，不是价格估计。

freezer 公共写入 seam 的 TDD：缺少模块/写入 API 先 RED→GREEN；额外历史图片会使两 arm 实际帧数不同却报告相同的反例先 RED，修为只接受无历史图片的生产文本前缀，否则另建 revision。实际两 arm 各 1 帧，相同 PNG/task，完整前缀/tools/request 分别 hash。四份请求草案实际写入 OS Temp `kodax-eval-dumps-visual-freeze-IUrBpR`，独立断言 (1,1) 原 RGBA [0,255,255,128]。最终 **4 项机械测试通过**；只对 freezer 统计语句 **84%**、分支 **78.37%**、函数 **83.33%**、行 **87.17%**，raw `kodax-visual-p7-plan-final2-coverage-20261029`。这不是模型输出、远端协议接受或全仓覆盖率。

第一次默认全仓 `npm test -- --reporter=dot`：**18,055 通过、12 失败**（3 文件），97 skipped、19 todo；1,292 文件通过、3 失败、6 skipped，用时 1,106.65 秒，原始日志保留 `kodax-visual-p7-full-suite-20261029.log`。11 项来自 queue-boundary/steer 旧正向 fixture 的同一张 decoder 判 invalid 的 PNG；换为真实有效 PNG 后，又以旧“仍用原路径”断言 RED。现核对 owned 路径和 ACK 后覆盖 producer 路径仍保留的原 bytes；旧坏 PNG 保留为拒绝 steer、无 input ACK、无额外请求的负例。队列撤回竞争、skill barrier、提交前不可见、幂等、目标冲突与原请求顺序断言均保留。修补后 3 文件 **33 项通过**，日志 `kodax-visual-p7-queue-steer-final.log`。没有放松解码、owner 或权限检查。

另外 1 项为 `src/sdk-runtime.external-agents.test.ts` T30 的 `Session not found: product-face`。三文件复跑中该文件通过，5 次孤立 T30 也通过；未修改该生产路径，**原因仍未定位**。不能由这些复验认定已修复、与本次无关或归因 flaky/环境。第二轮全仓结果独立保留如下。

冻结代码后第二次同一默认命令：**18,067 通过、0 失败**，97 skipped、19 todo；**1,295 文件通过、6 skipped**（总 1,301），总 18,183 项，用时 **1,044.13 秒**，命令退出码 0。日志 `kodax-visual-p7-full-suite-final-20261029.log`。按仓库默认 exclude 未运行需凭证的 provider integration；未据此宣称在线或行为验证通过。两次全仓记录均保留，不用第二次覆盖第一次。原 Feature 270 在本次全仓中未再失败，也不证明历史原因已解决。

最终 `npm run typecheck`（含新增 benchmark 文件）、`npm run build`、`git diff --check` 通过；仓库未提供 lint 脚本，未虚构 lint 通过。CLI **5,151 KiB**，bootstrap **4,042 bytes**，14 SDK 声明检查通过，未提高构建门槛。没有做全仓 coverage 运行，上述逐片数据仅代表明确列出的模块/测试集合。

### 最终成本八格

`p7-final` 使用第一轮完整默认回归里实际离线捕获的 **32 格** `kodax-first-turn-wire-qH7SlF`，保留完整 system/messages/tools 与 Script 内嵌合同；未装配 owner 的 **24 SDK 格**完整字段不变。与 P3b 起后续默认合同相同，P4/P6/P5 未再增加默认首轮字段。基线 30310e00 仍沿原 raw 的 15 个合同源匹配、Windows LF/CRLF 及历史 hash 核对；不是重新捕获的基线。

| 协议/入口 | 完整字段估算 token | 对 30310e00 增量 | 对 token 优化版本 1826cc22 累计增量 |
| --- | ---: | ---: | ---: |
| OpenAI / Coding SA | 15,907 | +366 | +748 |
| OpenAI / Coding AMA | 15,423 | +366 | +748 |
| OpenAI / Agent | 11,791 | +365 | +748 |
| OpenAI / Script | 17,293 | +366 | +748 |
| Anthropic / Coding SA | 16,165 | +364 | +744 |
| Anthropic / Coding AMA | 15,048 | +358 | +726 |
| Anthropic / Agent | 11,546 | +358 | +726 |
| Anthropic / Script | 17,128 | +358 | +726 |

累计 **+726～748 个估算 token**，按各格原 token 优化基线约 **+4.43%～6.77%**。三工作面之外 Anthropic SA 的 +364/+744 必须单列，不能套用 +358/+726。显式安装卡片消费者的 +194（OpenAI Coding 配对）另计，不混作默认所有入口成本。工具结果中的标签、数值/图片及历史增长、实际 usage、缓存、费用、请求数与整体任务耗时均不是这些首轮数字；完整任务净增量仍未实测，不能以 1500/图的容量护栏或 base64 字符数代替视觉计费。

### Standards

逐片与最终跨片独立只读评审：**0 项剩余成文规范违反、0 项 smell 判断**。最终 fixture 修改保留原队列、权限及提交可见性断言。

### Spec

最终发现的 1 项 Anthropic SA 成本漏列已在八格与 P7 方案中更正；实现/输入公平性及 fixture 修补复核 **0 项剩余发现**。没有将 T30、历史 Feature 270 的未定位原因、子 Actor owner、未选来源或未执行模型行为包装成已解决/通过。行为采用建议保持 **recommend-iterate（价值待验证）**。

## 持续保留的失败与未验证范围

此前全仓原始结果为 17,952 通过、1 失败，Feature 270 临时 evidence.json 缺失原因未查明；独立单文件或本次全仓通过不表示历史原因已解决。首轮 P7 的 T30 原因也未定位。上述不同时间/候选的原始记录均保留。

截至原 P7 离线冻结没有在线模型/付费实验；后续 r2 的首请求/账户失败如下单列。没有 ARC、完整桌面或实时游戏接入。P7 没有完成行为验证，不把机械测试或工具数量当作主动取证/智能提升的证据。

## P7 r2：新候选冻结与账户阻塞

用户授权 Kimi 原生视觉路由及四次 pilot，工程候选固定 3b2d48e8，基线固定 30310e00。实际模型 kimi-k2.6，关闭思考，统一非流式/max_tokens=512；4 calls、100,000 总 token、USD 1、60 秒/请求、串行，无重试/fallback/judge。生产 tools 原字节保留，两 arm normalized 文本前缀相同、同一 PNG、每题初始 1 帧。来源转换、官方能力/人民币价格与请求 hash 见 [r2 正式记录](visual-harness-p7-pilot-r2-2026-10-29.md)。旧草案不覆盖，不重做 P0–P2。

**实际首请求 HTTP 429（账户余额不足），1/4 次 provider 请求已发出，其余三次停止；0 行为输出，实际 usage/费用未知。** 原 raw、pre-registration、主会话无配对样本的有效性分析留在 OS Temp，不把未知写成零；不能比较模型行为，也不能声称整体任务 token 改善。后续四类能力及原支持矩阵未验边界均未扩展。

新增有界 runner 的公共 freeze/run seam 按 TDD 验证；原 freezer 加新 runner 共 2 文件 17 项本地测试通过，真实 HTTP 对照保留预算、超时 partial、未知 usage、429、篡改、零授权、工作树落盘拒绝及重复执行负例。双轴独立评审剩余 Standards 0 / Spec 0。P7 建议仍为 recommend-iterate，后续需可用账户/明确路由与新的冻结预算，不自动消耗其它 provider。

## P7 r3：订阅端点四格与实际 token

后续用户明确 `kimi-code` 凭据为 `KIMI_CODE_API_KEY` 并授权新四次预算。实际选择官方 Chat 兼容端点、`kimi-for-coding`（只读模型列表显示 K2.8 Preview），固定相同输入、图像/初始帧和生产工具字节；四格全部完成，无工具执行/额外 generation/judge。冻结、盲评、usage、费用快照与支持矩阵见 [r3 正式记录](visual-harness-p7-pilot-r3-2026-10-29.md)。r2 失败只属于按量端点，不能说明 kimi-code 不可用。

盲评优先 candidate 的精确原始数值采样，baseline 的同区域裁剪也是相关取证；两边算术题都只答 42、没有工具。两题都明确提示证据或图片无关，未测自主识别/取证后答案改善。每题候选实际输入 +327 token；合并两题的下一响应 baseline 24,717 / candidate 25,336，**+619（+2.50%）**，不是完整任务或 P0 前基线的实测。r3 四次合计 50,053 token；另 7 次只读元数据 HTTP（readiness 2 + runner 5），不隐藏额外请求。订阅加油包可见增量 ¥0，订阅摊销/实际美元费用未知；不套用名义 token 单价。

同一 runner 订阅扩展按 TDD 保留金额空值、回退/未知及整数分阈值反例；两文件 26 项通过，类型检查与构建通过，双轴剩余 Standards 0 / Spec 0。r2 阶段本轮全仓实际为 **18,084 通过、1 失败**（one-shot-task 清理 sessions 的 ENOTEMPTY）；该文件单独 10 项通过，原因未定位、不宣称修复。32 格新离线完整字段与补修输入相同，默认首轮估算不增加。后续四类无提示/固定反馈任务仍需新的分批冻结预算，采用建议 recommend-iterate。

最终 r3 代码冻结后的默认全仓：**18,094 通过、0 失败、97 skipped、19 todo**（18,210 项），**1,296 文件通过、6 skipped**（1,302 文件），1,128.24 秒，退出码 0；原日志 `kodax-visual-p7-r3-full-20261029.log`。新抓包 `kodax-first-turn-wire-bsOZr7` 的 32 格 normalized 完整输入仍逐格相同；日志/比对 hash 在成本记录。没有以这次全绿关闭上轮 ENOTEMPTY 或更早 Feature270/T30 的未定位原因。

后续采用边界更正：用户认为 alpha/算术单响应没有回答 VISTA 式实际任务收益，r3 因此只保留为前置工具选择/单轮成本证据。新的 [P7 任务价值方案](visual-harness-p7-task-value-plan-2026-10-29.md) 以视觉改造前已优化的 1826cc22 为主基线，覆盖连线推理、历史截图诊断、反馈面板及普通代码任务；实际工具结果参与后续判断，按效果→全程 token→处理方向评审。方案未执行、当前新增授权为 0；没有重新生成旧数据或预先锁死 token 采用门槛。
