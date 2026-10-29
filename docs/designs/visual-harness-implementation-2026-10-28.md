# 通用主动视觉 P0–P2 实施记录

实施起点：`KodaX-next-dev`，`1826cc228f299995fe5b22e608c7fbd90c3dc9ee`。依据 [交接](../HANDOFF_VISUAL_HARNESS_2026-10-28.md) 与 [主设计 §12.2](visual-harness-after-first-turn.md#122-可独立演示的实施顺序)，顺序推进 P0 → P1 → P2，没有重开 VISTA 调研。主设计交接版本的 SHA-256 仍为 `9b576bac2c9562b98b4415b33f362f63e03652cfb747fa20ce0833114c7d14fd`，未覆盖其现有修改。

实施窗口：2026-10-28 至 2026-10-29，Asia/Shanghai。

本记录跟踪既有设计切片，不新分配 feature ID、发布版本或逐票审批记录。P3–P7 未实施；没有运行外部模型、付费实验、推送或发布。

## 1. 已实现的切片

| 切片 | 交付与公共接缝 | 验证范围 |
| --- | --- | --- |
| P0 | 冻结真实 HEAD、32 格首轮 wire、完整模型字段与工具表 | [基线](visual-harness-p0-baseline.json)；两种协议、三工作面及 SA 兼容入口；固定现有 fixture，未使用旧成本门槛 |
| P1 | Runtime `acceptInput` 的 immediate 用户图片；同 owner 原件与收据；`visual_history`、单图全图 `visual_inspect`；同批输出预留 | 覆盖源路径后仍回取原 bytes；同 ID 重试与异意图冲突；保存失败；同 ID 的并行检查；归档、删除及重启 |
| P2 | `read` 持 bytes 时接纳；单图 crop/zoom；Agent/Coding/Script native/checked bridge；Script 既有 read 叶；压缩续接 | 12 个真实 Runtime 请求格；重复 provider call ID；两种生产 serializer；RGBA/alpha/坐标；格式与资源边界；叶提交后外层失败、重启、分支隔离 |

产品默认仍为 Coding。新视觉工具没有进入 Script 叶白名单；Script 中的 native/checked bridge 视觉调用与已有 read 叶回图分别验证。

## 2. 当前合同与持久化

`visual_history` 接受可选 `sourceKey/cursor/limit`，默认最近 20 项、上限 50 项。按稳定接纳顺序返回，目录不解码图片。cursor 固定 owner、查询、上界与实际分支选择；正常追加不插入已开始的页，换分支或筛选不能复用。目录的 `retained` 表示收据的保留状态；读取时仍独立校验文件存在性、大小和 hash。

`visual_inspect` 接受 `question` 和恰好一个 `views` 项：`label/observationId`，可选 `region/displayLongEdge`。本片不曝光多 view 或 `visual_read_pixels`。区域为原 raster 的整数 `x/y/width/height` 半开区间，越界或零面积拒绝。输出含原观察标签、实际图片、区域、尺寸、比例与解码 profile；检查回显不新增源事件。

原件在 Session owner 的 `.media/<session-id-sha256>/<content-sha256>` 命名空间固定，临时文件完成后原子发布。内容相同的不同发生仍有不同 opaque `observationId`。收据进入同一 canonical `extensionRecords`，没有第二 transcript writer、数据库或后台图片扫描。

初始输入收据保留原请求内容 digest、产品 intent digest 及原 Run 引用。已有输入先校验意图并复用快照，不再读取可变原路径。canonical 已保存但设置晋升/Run 注册失败时，下次成功接纳会修复收据的 Run 引用；压缩、重启后的再次交付复用原 Run。

工具原件在 `read` 仍持 bytes 时固定，并复用原验证与 prepared-image 通道。收据保留来源 entry、run、精确调用 ordinal/execution ID 和 image ordinal；Script 另关联 cell 与 leaf receipt。相同 provider ID 不合并事件。普通工具随最终 tool_result 的 required canonical 边界提交；Script 原件在 `call.settled` 保存前固定，外层不重复接纳。

压缩 entry 增加可选 `compactedFromEntryId`，只用于历史证据回链，不改变模型上下文的父链。目录读取同 owner 的完整 lineage/sidecar，沿已授权的压缩链恢复观察，不将所有旧岛公开。

若 Script 叶已提交而外层中断，既有 storage 恢复会清理不完整调用。本片在该原提交中复用 `branch_summary` 保存已验证 leaf 的观察引用。它是当前恢复分支上的接纳见证，原观察仍绑定实际来源 entry；退回到执行前的 user entry 或转入旁支不再看见这些未来观察。测试确认恢复不重放已完成叶。

Session archive 保留媒体；真正删除与原 canonical/sidecar 删除流程共同处理媒体目录。draft 接纳失败留下的孤儿快照也随 draft 删除清理。没有跨 Session 内容池、引用计数或新保留配置；fork 继承留待 P4。

## 3. 解码、容量和支持边界

派生 profile 为 `png8-rgba-unoriented-no-color-transform`：静态、非交错、8-bit RGB/RGBA PNG，保持 alpha，不做 EXIF 旋转或色彩转换。动画、方向、ICC/gamma/chromaticity/HDR 等不在当前 profile 内的块明确拒绝。JPEG/WebP/GIF 等既有原件接纳能力保留；新增派生检查对它们返回 unsupported。原图尺寸由 `image-size` 惰性读取，实际解码沿当前 lockfile 的 Jimp/pngjs 路径。

最近邻展示保留比例。源处理上限 10 MiB / 40 MP；展示长边 2000、字节上限沿用 `TARGET_RAW_SIZE_BYTES`（3.75 MiB）。不走粘贴图的 JPEG 降质链；不从放大图反测原像素。

同一 managed Run 的容量 owner 在生成前为完整图片和实际标签/question 预留，兄弟调用共享同一批额度，不使用 provider call ID 作额度键。成功结果的预留保留到批次接纳，失败释放幂等；最终配对、capacityDebt 与恢复梯子保持原语义。实际解码槽位与输出额度分开，取消不会在旧解码尚未结束时重开同 owner 的槽位。

| 维度 | 本片已验证 | 未覆盖或明确限制 |
| --- | --- | --- |
| 工作面 | Agent、Coding、Script；SA 兼容图片恢复回归 | 没有新增视觉模式或强制发现步骤 |
| 入口 | native、checked bridge；Script 既有 read 叶 | 新视觉工具不是 cell 叶 |
| owner | 产品 Runtime 普通非 fork Session | standalone SDK 必须自己注入 owner/提交/预留；不自动继承 durable 保证 |
| 产品输入 | immediate 图片及原生 read | queued/steer/redirect 的接纳时点保证留待 P4；排队回执不等于原件已接纳 |
| 来源 | user、read、可信 Script read 回执 | MCP、Artifact、额外 Host materialization 留待 P5 |
| 协议 | OpenAI 与 Anthropic 生产 serializer 的离线 payload | 不证明远端接受、模型看懂、全部 alias、CLI 图片桥或跨 Host 媒体传输 |
| 图片 | 全图固定原件；PNG crop/nearest zoom；RGBA/透明通道 fixture | 数值像素工具、多观察、多 view 留待 P3；其他派生 profile 尚未声明支持 |

图片能力检查读取当前请求的实际模型选择；运行中切换 provider 时不会沿用启动时的父配置。不可用路由明确返回 unavailable/unverified，不暗中换模型。

## 4. 验证与成本证据

TDD 的可观察 RED 包括：原目录删除后仍有媒体；read 结果没有观察 ID；裁剪尚不可用；JPEG 全图绕过尺寸上限；压缩后输入重试找不到 canonical input；分支切换仍接受旧 cursor；模型切换仍按旧路由拒绝；Script 外层失败后 leaf 引用失去可见性。每项经最小实现后定向 GREEN。

补充固定点复验用临时 Vite 插件只替换 Runtime adapter 为 `1826cc22` 源码，不改工作区：当前真实入口测试在“canonical 图片仍指向原可变路径”断言上 RED。它验证 Runtime 接纳增量，不能冒称整套当前核心库都切换成了旧版本。

新增 6 个测试文件共 33 项通过；覆盖统计限于新视觉模块和 `runtime-visual-input.ts`：语句 **86.48%**、分支 **80.90%**、函数 **92.59%**、行 **95.33%**。不是全仓覆盖率。新增的 storage/Runner 接线另由真实 Runtime、删除/恢复和现有对应回归覆盖。额外 PNG fixture 含有效 Orientation=6 EXIF 块，确认在解码前拒绝派生，并保留原件。

首次全仓运行：1,277 文件通过、9 文件失败、6 文件跳过；17,938 项通过、14 项失败、97 项跳过、19 todo。运行时部分新回归仍在 RED 阶段；后续修复只读工具 classifier、optional owner 工具表与媒体 facade，并把旧“原路径仍在”的 fixture 改为检查保留的图片 bytes。没有降低原图片完整性或工具执行断言。

最终全仓复验：1,285 文件通过、1 文件失败、6 文件跳过；17,952 项通过、1 项失败、97 项跳过、19 todo。唯一失败为既有 `benchmark/datasets/feature-270/runner.test.ts` 的零成本 fake-provider 测试，读取临时 `layer3/main-session-review/evidence.json` 时 ENOENT。该文件随后独立复验 3 项全部通过；未改 benchmark 实现，也未将这次全仓结果表述为全绿。缺失文件的具体原因未证实，不能据独立复验认定临时文件问题已解决。

最终源码的 `npm run build`、`npm run typecheck:src` 与 `npm run typecheck:tests` 均通过，14 个 SDK 的声明自包含检查通过。仓库没有独立 lint script；使用类型检查、diff 检查及 Standards/Spec 双轴审查。

完整 B/V 证据：[统一字段成本](visual-harness-p0-p2-costs.json)。32 格使用相同 fixture/归一化与同一 KodaX 文本启发式，24 个未装配视觉 owner 的 SDK 格完整模型字段 hash 不变。以下只列 Runtime 产品工作面：

| 协议 / 模式 | B 估算 token | V 估算 token | V−B |
| --- | ---: | ---: | ---: |
| OpenAI / Agent | 11,043 | 11,426 | +383 |
| OpenAI / Coding | 14,675 | 15,057 | +382 |
| OpenAI / Script | 16,545 | 16,927 | +382 |
| Anthropic / Agent | 10,820 | 11,188 | +368 |
| Anthropic / Coding | 14,322 | 14,690 | +368 |
| Anthropic / Script | 16,402 | 16,770 | +368 |

计入完整 system/messages/tools 和 Script 内嵌合同；新工具在 Script 中仍是普通 native 工具，没有重复加入叶合同。纯文本格没有自动图片或新增分类/发现请求。初始图片和工具图片由独立实际 serializer 测试核对 bytes、标签和顺序，不拿含 base64 的文本估算当视觉计费。

这些是新增合同成本与机械证据，不是 API usage、实付费用、准确率或速度提升。P7 行为采用评审尚未运行，不能据此声称模型会自主选择正确区域或修正判断。

构建曾因 CLI 为 5,130 KiB 超出旧 5 MiB 门槛而失败。为本片的实际媒体代码把 CLI 限额增加 **32 KiB**，保持原有 eager dependency/input 守卫；未引入专用加载平台或新用户配置。轻量 bootstrap 仍为 4,042 bytes；本机 `--version` 5 次为 49.00–56.40 ms，仅是产物启动 smoke，不是与 B 配对的性能结论。独立二进制、打包 tarball 的跨平台运行与在线模型验收不在本轮声明内。

## 5. 复现与下一片

在本工作树执行：

```powershell
node node_modules/vitest/vitest.mjs run packages/agent/src/media/visual-tools.test.ts packages/coding/src/media/visual-owner.test.ts packages/coding/src/task-engine/visual-output-reservations.test.ts src/sdk-runtime.visual.test.ts src/sdk-runtime.visual-sources.test.ts src/sdk-runtime.visual-source-failure.test.ts --reporter=dot
npm run typecheck
npm run build
npm test -- --reporter=dot
```

最终覆盖率 raw 在 OS Temp `kodax-visual-p0-p2-coverage-final-20261029`；基线/候选 wire raw 分别在 `kodax-first-turn-wire-W1CvXo`、`kodax-first-turn-wire-mwTGST`；最终全仓 JSON 为 `kodax-visual-p0-p2-full-final-20261028.json`。这些产物位于本机 `C:/Users/ADMIN/AppData/Local/Temp/`，可能被清理。必要结论、hash 和限制已写入上述跟踪文件，不依赖 ignored research 笔记。

下一前沿沿用主设计：P3 扩展多 view 与像素核实；P4 补产品输入/分支/长任务；P6 选一个受控动态消费者；P5 按实际所需来源拆小。P7 在对应依赖完成后汇总 Layer 1，再决定是否开展单独冻结预算的行为 probe。本轮不把这些后续项标成已完成。

## 6. Standards

以下是原始切片审查记录；用户后续复核发现的 IHDR 缺陷及追补审查见 §8–§10。

固定点为 `1826cc22`；依据 AGENTS.md 与 code-review 的 12 条 Fowler 基线独立审查本片 diff。无硬规范违反。唯一剩余的 P3 判断项是两分支重复构造 `visualSource`，已在分支前构造一次并复用；45 项 dispatch/bridge/Script 模型回归通过。新增依赖归属 agent，包独立与只读 classifier 约束保留；本片 CLI 预算调整对应已测代码增量，原启动依赖守卫保留。

Standards：**0 项未解决发现**。

## 7. Spec

依据主设计 P0–P2 和 §5/§6/§9/§11/§13.1 独立审查。动态 provider 选择、分支 cursor、失败晋升后的 Run 引用修复均已核对。Script 观察绑定精确来源；恢复见证只纳入匹配已提交 leaf 的观察，并受 active lineage 约束，回退到执行前输入后不可见。未将 P3–P7、全部 provider 或模型行为证据冒充本片交付。

Spec：**0 项未解决阻断发现**。

## 8. 2026-10-29 P2 追补：PNG IHDR 预检与解码一致性

用户独立复核 `58bca775` 后指出一项中优先级缺陷：预检读取第一个 IHDR，实际解码器接受后续 IHDR。首头声明 8-bit、后头声明 16-bit 时仍成功回显为 8-bit profile；尺寸不一致则直到解码后才报错。此前 P2 完成判断遗漏了该反例，本片先补修，不推进 P3。

沿现有 `visual_inspect` 公共工具入口执行 TDD：重复相同头、8-bit→16-bit、尺寸变化三个 case 均先 RED；修复唯一性后 GREEN。另将错误 CRC 的解码前拒绝测试先跑 RED，再补校验。预检现在要求第一个 chunk 为精确的 13-byte IHDR，验证其 CRC 后读取尺寸和 profile，并在扫描时拒绝任何后续 IHDR；不把另一个头的尺寸或位深交给解码器使用。原来的 40 MP、8-bit RGB/RGBA 与无方向/色彩变换边界保留，未改变既有原件接纳能力。

新增 **11 项**回归覆盖重复头、16-bit、尺寸变化、首 chunk 类型、头长度、CRC、零尺寸和超过 40 MP。它们验证错误在 `Jimp.read` 前返回，且失败预留释放、原件仍可读取。原有正常 RGBA/alpha 裁剪与取消回归继续通过。

本次验证：原来 6 个视觉测试文件现为 **44 项全部通过**；`npm run typecheck`、`npm run build` 与 `git diff --check` 通过。相同 7 个视觉模块的定向覆盖为语句 **88.11%**、分支 **83.17%**、函数 **92.59%**、行 **96.59%**，不是全仓覆盖率。raw 位于 OS Temp `kodax-visual-p2-ihdr-coverage-20261029`。本次未重跑全仓，§4 的原始 17,952 通过、1 失败继续保留，失败原因仍未查明。

本次未改模型工具合同或 system 提示。首轮已有证据仍为约 **+368～383 个估算 token**，不是 API 实际计费，也未验证模型智能提升；P3–P7 的合同投影不算本轮实测。[原始成本文件](visual-harness-p0-p2-costs.json) 保留原冻结源码 hash，没有把修复后的源码 hash 回填为旧抓包证据。

## 9. Standards（IHDR 追补）

固定点 `58bca775`，独立只读审查：新增校验范围集中，未引入依赖、配置或抽象，错误明确抛出；未发现成文规范违反或值得提报的 Fowler smell。

Standards：**0 项发现**。

## 10. Spec（IHDR 追补）

依据用户复核要求与主设计 §6.1–6.3，独立只读审查：解码前验证首个 IHDR 位置、长度、CRC、位深及尺寸，并拒绝后续重复头；回归确认失败时不调用解码器、保留原件并释放预留。未发现范围扩张；原始全仓失败保留为原因未证实。

Spec：**0 项发现**。
