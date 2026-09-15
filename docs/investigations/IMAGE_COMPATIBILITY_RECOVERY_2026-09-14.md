# 图片兼容性、自愈与 pi / codex 对照

日期：2026-09-14。关联 KodaX Issue 335 / Space Issue 215。
本文保留修改前的调查与方案。2026-09-14 已在工作区实现第一阶段入口检查、逐图片发送准备和旧历史恢复，尚未发布。
实际改动、验证结果及发布边界见 [回归指南](../test-guides/ISSUE_335_v0.7.96_REGRESSION_GUIDE.md)。

## 结论与可用性约束

修复需要覆盖 `read`、MCP 图片、用户附件以及已有历史的 Provider 重放。
MCP 范围指 **KodaX 接收 MCP 工具/资源返回的图片后所做的处理**，不改变 MCP
协议、工具能力或服务端。正常图片、文字、`structuredContent`、原始工具错误状态
都必须保留。只修 `read` 不能防止其他入口再次产生同样的会话故障。

建议借鉴 codex 的逐图片处理和旧历史恢复，借鉴 pi 的完整解码、格式兼容及按需缩放。
不能照搬 pi 在扩展工具图片处理失败后继续传原始坏字节的行为。
**不能把本地解码器不支持一种格式等同于图片损坏，也不能笼统过滤所有图片或所有 400。**

本地源码版本：KodaX `7b5b1b9e`；pi `71dca871bc80b6bc97be37f0ca3189399d651fff`；
codex `3abbf9fe2c6b6910e9de61f6a0c5bb468f74b5c8`。后两者未改动工作区。
结论针对这些 checkout，不宣称代表所有历史版或发布版。

## 三者的实际处理方式

| 环节 | KodaX 修改前实现 | pi 当前实现 | codex 当前实现 |
|---|---|---|---|
| 本地图片工具 | `read` 检查扩展名和 10 MiB 大小，不解码 | 默认 `read → processImage → Photon` 解码；失败返回文字 | `view_image` 先 `load_from_memory`，失败作为工具错误返回模型 |
| 工具返回图片 | MCP 检查 MIME / base64 字符后持久化；未解码 | 扩展 hook 后统一 normalize；但处理失败保留原图 | 历史入库前处理普通/自定义工具图片；单图失败替换文字 |
| 历史恢复 | 每次按 path 读文件；只对缺失文件降级 | 本次检查未发现相当于 codex 的旧历史解码恢复边界 | resume/fork 重建历史时再次准备媒体；不改原 rollout |
| 声明不支持视觉 | 原生协议路径不一致，见下文 | 通用 `transformMessages` 同时处理 user / toolResult 图片 | 根据模型 input modalities 同时处理 message / tool output |
| 上游图片 400 | 被归并为 generic client error；未有图片恢复动作 | 通常不属于瞬态重试；处理失败也不自动清除坏图 | 映射专门错误并提示用户；该分支停止本轮，不无限重试 |

pi 源码坐标（相对 `C:/Works/PubProj/pi/`）：

- `packages/coding-agent/src/core/tools/read.ts:105`：图片识别与读入。
- `packages/coding-agent/src/utils/image-process.ts:82`：默认 resize 路径负责解码；
  关闭 autoResize 时，已有支持 MIME 的字节直接通过。
- `packages/coding-agent/src/utils/image-resize-core.ts:74`：Photon 解码后才检查尺寸，
  合规小图保留原始字节；超限才重编码/缩放。
- `packages/coding-agent/src/utils/tool-result-images.ts:43`：失败仍保留原始图片，
  注释明确为避免解码后端不可用导致扩展工具输出丢失。
- `packages/coding-agent/src/core/agent-session.ts:519`：该处理位于扩展 hook 之后。
- `packages/ai/src/api/transform-messages.ts:35`：非视觉模型的 user / toolResult
  图片转占位；这是模型能力兼容，不能与损坏检查混为一谈。
- `packages/ai/src/api/openai-completions.ts:1376`：图像放到完整工具结果组之后的
  user 消息，避免打断工具调用配对；KodaX 已有类似路由，应保留。
- `packages/ai/src/utils/provider-retry.ts:24`：普通重试针对网络/408/409/429/5xx，
  并尊重服务器 retry hint；不是把所有 400 重试。

codex 源码坐标（相对 `C:/Works/PubProj/codex/`）：

- `codex-rs/core/src/tools/handlers/view_image.rs:180`：返回图片前完整解码验证。
- `codex-rs/utils/image/src/lib.rs:123`：按内容识别格式，再解码像素；小图优先保留
  支持格式的原始字节，输出 MIME 由实际格式决定。缓存以内容摘要和处理模式为 key，
  有条目数/字节上限。
- `codex-rs/core/src/image_preparation.rs:179`、`:220`：message 和 tool output
  都逐图片处理，失败只替换对应项为有界说明。
- `codex-rs/core/src/session/mod.rs:1634`：旧 rollout 保持原样，恢复/分叉时仅准备
  重建的内存历史；`:3422` 是新条目的统一媒体处理入口。
- `codex-rs/core/src/context_manager/normalize.rs:330`：不支持视觉时，两种内容位置
  都提供文字替代，不删除整个工具结果。
- `codex-rs/codex-api/src/api_bridge.rs:122` 与 `core/src/session/turn.rs:743`：
  对特定图片错误识别后给出提示并终止本轮。不能据此声称 codex 会在任意图片 400
  后自动删除图片并重试。
- `codex-rs/core/src/image_preparation_tests.rs:390` 起有坏 base64、坏图片、合法图片
  混合输出的保留断言。本次未编译运行 Rust 全套；这些结论来自源码及已有测试阅读。

## KodaX 扩大检查的发现

1. **工具和直接 SDK 输入都可进入坏图。** 缺失 SOF 的 JPEG、截断 JPEG、只有 PNG
   头的文件和空图片文件均被 `read` 当作图片返回。两种协议的 `complete/stream`、
   直接图片和工具图片均可原样发送无效字节。
2. **MCP 是同一个问题的另一入口。**
   `packages/agent/src/capabilities/mcp/runtime.ts:197` 的 `normalizeMcpContent`
   将 image、embedded resource、resource 图片保存成路径，没有像素解码。
   已用本地 stdio MCP 服务器验证三条入口均保存缺 SOF 的 JPEG。文字、结构化结果及
   `isError` 当前保留，这些是修复必须保持的行为。
3. **Space 粘贴失败回退会放行原始字节。**
   `KodaX-Space/apps/desktop/electron/ipc/clipboard.ts:179` 调规范化；catch 在大小
   允许时写原始 buffer。现有回退测试已执行通过。该测试使用后端异常 mock；
   对“真实坏图”的风险判断来自 catch 不区分异常原因的源码，而非虚构客户粘贴复现。
4. **旧文件变化会改变重放请求。** `image-serialization.ts` 重读文件，声明的
   mediaType 则保留：原 JPEG 路径被写成 PNG 后，会出现 PNG 字节配 `image/jpeg`。
   直接调用序列化也绕过 `read` 的大小限制。仅按 path 缓存检查结果会进一步放大问题。
5. **本地解码器覆盖不足。** `packages/agent/src/media/image-normalize.ts` 已有 Jimp，
   但 LLM 层不依赖 agent，不能向上反向调用。当前 Jimp 默认 codec 没有 WebP；
   测试中有效 WebP 也被包装成 `IMAGE_DECODE_FAILED`，不能拿这个错误码直接隔离图片。
6. **图片能力声明与序列化不一致。** 对显式 `multimodalSupport: none` 的自定义
   Provider，Anthropic 直接/工具图片均发送；OpenAI 直接图片发送、工具图片占位。
   这是公共 SDK 序列化检查，不能推断所有 Space 调用也绕过上层能力策略。
   修复前要区分“已知不支持”与“元数据缺省”，不能把历史缺省一律解释成禁用视觉。
7. **错误恢复不认识图片问题。** 嵌套 `APIError.error.error.code` 的 1210 被漏提取，
   活跃的 resilience classifier 没有图片分支。这不应通过放宽所有 400 重试解决。

## 已执行的兼容性验证

### KodaX：27 项离线基线

`packages/llm/src/providers/image-compatibility-audit.integration.test.ts`：27/27 通过。
测试通过表示所记录的现有行为得到验证，**不是修复通过**。包括：

- 缺 SOF / 截断 JPEG、PNG 只有头、空文件、正常 JPEG / PNG。
- Anthropic / OpenAI × direct / tool × complete / stream，8 条真实序列化路径。
- zhipu / zai 实际 Provider 类接收 `read` 结果后的序列化。
- MIME 与实际内容不一致、缺失文件、超限绕过、正常与损坏图片混合、公开持久化入口。
- GIF / WebP 兼容性，以及本地 MCP 的 image / embedded-resource / resource 三条路线。

### pi：隔离运行原源码与其固定 Photon 0.3.4

pi checkout 没有 node_modules。先记录无后端降级，再在临时目录安装其固定依赖，
禁用 npm lifecycle scripts，复制九个原始 utility 文件并记录 SHA-256；两次结果分开保留。

15 个样本均另经 Pillow 检查：4 个坏样本与 11 个正常样本。
Photon 默认读取拒绝 4/4 坏样本，接受 11/11 正常样本。正常范围含 Baseline /
Progressive / CMYK / EXIF 方向 JPEG、透明 PNG、GIF、动画 GIF、有损及无损 WebP、
4000×64 PNG。10 张无需缩放的正常图片原字节不变；大 PNG 缩至 2000×32 并附尺寸说明。
这里验证的是读入、保留字节和缩放尺寸，没有声称完成所有颜色/动画视觉质量验收。

**同样的 4 个坏样本，经 `normalizeToolResultImages` 仍全部保留为 image。**
因此 pi 的默认 `read` 防护值得参考，但扩展工具处理的失败回退不满足本次修复需求。
关闭 autoResize 也会放行带合法 MIME 的坏字节；坏图被误报为“无法缩到大小限制”则说明
错误分类需要改进。该实验仅验证 Windows Node + WASM，不代表 Bun/Electron 发布包已验证。

### 真实 GLM 接口：仅替换请求中的坏图

另造带 JFIF/EXIF 头、缺 SOF 的 JPEG，并在同一个工具结果中放入正常 160×46 JPEG。
真实 `toolRead → history cleanup → provider.stream` 对两家分别执行：

1. 原始历史：均 HTTP 400 / 1210。
2. 只在请求副本中把已确认坏图改成说明文字：两家均接收并返回模型流。

正常图片、工具调用、思考、改价文字、原始历史对象与坏文件均保留；没有删除历史或
修写图片。这个结果比“覆盖坏文件后恢复”更贴近可实施的历史自愈。
初轮 4 次调用每次最多 256 输出 token；两次恢复请求均达到输出额度、没有可见文本，
因此只证明图片 400 被消除。随后自动思考 / 1024 token 的可见回复探针中，智谱仍
到达额度，Z.AI 达到 45 秒超时。这些失败单独保留，不能算任务恢复成功。
最后仅对两条恢复请求做 low effort / 1024 token 检查，两家均返回可见的 `OK`，
并以 `end_turn` 正常结束。低思考用于实验控制，不是建议生产自愈时更改用户的思考模式。
本节共 8 次显式 Provider 调用（4 次对照、2 次自动思考可见回复探针、2 次低思考探针）；
没有把单次接口恢复等同于 Word 编辑任务已完成。

## 建议实施方案

### 第一阶段：确认坏图不阻塞会话，同时保持正常能力

- 在最低的可共享层建立小型图片准备函数，供原生 Provider 请求使用；agent/coding
  可以调用下层，不能让 `llm` 反向依赖 `agent` 或 Electron。
- 区分：可用、确认损坏、解码器不支持、后端不可用、文件不可读/缺失、大小超限。
  判损坏需要实际格式对应的解码器结果，不能只看扩展名、magic bytes 或异常字符串。
- 优先验证 pi 的四格式 WASM 解码方案是否适合 KodaX 打包；不要直接把 Jimp 失败
  当作全部格式的损坏判据。正常且合规的图片保留原始字节，按实际格式修正 MIME。
- `read` 新读到确认坏图时，返回清楚的工具错误，让模型可重新提取/转换；MCP
  混合结果中只替换坏图片项，保留文字、正常图片、structuredContent 和原 isError。
  SDK/Space 应分别显示“工具执行状态”与“附件不可用”，不能把整个 MCP 结果改成失败。
- 已有历史无论在本进程继续、重启恢复或 fork，都在发送前覆盖检查；在内存请求
  副本中放置原因明确的文字占位。保留原始 JSONL、引用与文件，避免永久性误删除。
- 不可读、后端不可用与坏图不是一回事。对于确认支持的格式，优先尝试等价后端；
  没有可用后端时保留明确诊断和既有兼容路径，不因新校验功能导致整类正常图片失效。
- 检查与发送使用同一份已读字节；重复历史图片可按内容摘要缓存、限制总缓存大小。
  文件修复后应重新验证，不能永久缓存“这个路径是坏图”。解码工作有像素/内存/时间
  边界，异常或超时归为处理不可用，不应冻结主线程或把未知结果永久记为损坏。

### 第二阶段：上游残余拒绝的有界恢复

本地可识别的坏图在发送前处理，不需要额外 LLM 请求。若仍收到明确图片解析错误：

1. 保留脱敏 upstream code、HTTP status、Request ID 和受控原因；仅 `400` 或仅
   `1210` 都不足以定位图片，需结合明确的图片错误语义与本地检查结果。
2. 只有能定位需要变化的附件、且请求内容确实改变时，才在同一步重试一次。
   所有已确认坏图一次处理，不按图片数量反复探测；不能重跑已完成的写文件等工具。
3. 本地解码有效而服务端拒绝时，可针对已定位图片尝试兼容格式重编码一次；转换
   保留透明度、方向、文字清晰度，不能全局强制 JPEG 或默认破坏动画/页面信息。
4. 无法定位具体图片、没有安全转换或仍失败时，报告明确原因及重新读取/重新附图
   的恢复动作。不能靠删除全部图片、删除思考或跨 Provider 无限切换来“自愈”。

先落地第一阶段可直接修复本次确定缺陷。第二阶段先完成结构化错误识别与测试，再
启用自动重编码；不能因为追求所有 400 都自动恢复而扩大误伤范围。

### 必须通过的发布验收

| 维度 | 验收内容 |
|---|---|
| 正常内容 | JPEG / PNG / GIF / WebP；Progressive、CMYK、EXIF、透明度、动画；小图原样保留 |
| 混合工具输出 | 坏图夹在正常图之间；文字、结构化结果、isError、调用 ID、结果顺序保留 |
| 入口 | read、MCP image / resource / embedded、粘贴、直接 SDK；流式与非流式 |
| 旧历史 | continue、重启、fork、压缩/摘要所用 Provider 调用、切换模型；不改原记录 |
| 恢复边界 | 泛化 400 不重试；认证/额度/上下文错误不误触；最多一次变更后的重试；取消有效 |
| 后端失败 | 缺 WASM/依赖加载失败、格式不支持、解码超时；正常功能不被判损坏而删除 |
| 可变文件 | 缺失、目录/权限错误、原路径换格式、修复坏文件；缓存及时失效 |
| 发布环境 | Windows / macOS / Linux、Node / Bun、Electron ASAR、独立 SDK 使用；源代码测试不能替代这些检查 |

## 复现命令与证据

KodaX 根目录，离线：

```powershell
$env:KODAX_IMAGE_COMPAT_AUDIT='1'
npx vitest run -c vitest.integration.config.ts packages/llm/src/providers/image-compatibility-audit.integration.test.ts
```

真实接口（显式开启，使用现有凭据，仅合成文件）：

```powershell
$env:KODAX_GLM_HISTORY_PROBE='1'
npx vitest run -c vitest.integration.config.ts packages/llm/src/providers/glm-history-400.integration.test.ts -t 'sdk-image-projection'
```

该用例现已升级为生产修复回归：两次请求均使用包含原坏图的历史，由 Provider 自动准备图片，
不再由测试手工替换坏图。历史实验产物保留，第一阶段结果在 production-recovery，
第二阶段接收/恢复时机的结果在 admission-recovery。当前行为和验证汇总以
[回归指南](../test-guides/ISSUE_335_v0.7.96_REGRESSION_GUIDE.md) 为准。

离线最终产物：`C:/Users/ADMIN/AppData/Local/Temp/kodax-image-compat-audit-F5imGJ/`。
含 `observations.json`、`pillow-controls.json`、`pi-probe.json`（缺后端）、
`pi-with-photon.json`（有后端）、原源码副本及 hash、固定依赖锁文件。
真实接口产物：原调查目录下 `*-sdk-image-projection*.json`，失败探针与成功实验分开保存。
以上均为合成资料，没有客户原始文件、API key 或生产数据。
Space 现有 normalization-failure 回退测试 1/1 通过；新增诊断用例纳入 tests 类型检查。

相关：[首次 400 调查](GLM_CODING_400_2026-09-14.md)。
