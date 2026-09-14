# Issue 335：坏图入口检查与旧历史恢复

2026-09-14：源码已实现，随 `v0.7.96-rc.5` 发布。关联 Space Issue 215。

## 已实现行为

- `read` 完整解码失败时返回可执行的文字错误，请模型重新提取或替换图片。
- MCP image/resource/embedded-resource 逐图片校验，只将已确认坏图替换成说明文字；
  正常图片、文字、structuredContent、原 isError 保留。非法 base64 / 未支持 MIME
  也只给该图片项返回明确说明，不使整个工具结果丢失。没有更改 MCP 协议或服务端。
- Agent 在接收/恢复时准备图片，Anthropic/OpenAI 流式与非流式请求复用准备结果；
  未采用运行作用域的直接 SDK 调用仍逐次检查，覆盖直接输入和已有工具历史。
  坏图不会发给上游；缺失文件保留既有占位行为；其他文件系统错误仍会上报。
- 不重写原 Session/JSONL 或图片。有效图片按真实格式修正 MIME，保持原字节，
  不默认缩放、重编码、丢弃透明度或动画。新读入/恢复按当前文件重新验证；同一运行
  已经准备的图片保持固定，不追随源路径变化。
- 解码器不可用、超出本地处理预算、已识别但未支持的格式返回 unverified，
  保留原字节和明确提示；判定缓存不保留此类暂时失败。后端恢复后新读入/恢复可重新验证。
  同一运行的已准备内容仍保持固定。真实 Worker 挂起注入
  已验证 10 秒后终止，后续同图能够正常验证，队列不会永久卡住。
- 图片解码在独立 Worker 中执行，串行调度，每次检查的排队及解码共用 10 秒预算，有 10 MiB 输入和
  4000 万像素处理边界、128 MiB Worker JS heap 限制；WASM 内存不是 JS heap。
  判定缓存最多 256 个摘要，不保存图片字节；运行私有准备缓存保存正在引用的请求图片内容。
- 提取嵌套供应商错误码（包括 APIError.error.error.code），仍仅保留允许的元数据。
  不把所有 400/1210 当作图片错误，不新增无限重试或重跑工具。

## 自动验证

### 第二阶段：对齐 Codex 的准备时机

本次需求来源：用户要求当前修复就采用 Codex 的接收/恢复时机，保证正常附图、MCP、
重试及历史顺序兼容；随后只设计通用自愈 sidecar，暂不实现。

- SA `runSubstrate` / AMA 的原生 Provider 接入边界为运行建立独立图片准备作用域。
  恢复历史及接收新内容时准备；循环中的增量遍历只复用已准备块，不重新读文件、
  计算摘要、解码或 Base64 编码。原消息对象/文件/JSONL 不加入 Base64，也不删除坏块。
- `read` 和 MCP 在返回结果之前，从实际拿到的字节生成请求内容；后续修改或删除
  源路径，不会改变本次运行已经观察到的图片。新一次 read 创建新块，读取新内容。
  准备直接复用首次校验结论，尤其在解码器不可用时不立即进行第二次校验。
- 通用 Runner 的自定义 LLM 回调不再隐式读取/解码历史图片；可显式采用准备作用域。
  ACP 不预编码自己不会消费的完整历史；切到原生通道时再准备其需要的历史内容。
- 图片准备结果按块身份存放在运行私有 WeakMap；并行或嵌套运行不共享可变判定。
  文件 I/O 错误延迟到实际消费图片时抛出，不让会忽略图片的非视觉 Provider 提前失败。
- 运行取消会结束历史准备及 read/MCP 初次校验的等待，不继续准备其余图片；共享的
  单次解码仍在原超时内结束，不以取消某个调用者为由杀掉其他调用者共用的任务。
- 没有新图片时同步返回，不给文本/工具队列增加异步调度边界。图片缓存诊断使用
  实际准备内容的摘要，与真实发送保持一致；重复诊断不重新读源文件。
- 直接调用原生 Provider 的 SDK 使用方不需要采用新 API，仍按请求检查文件。
  重新运行/恢复建立新作用域，修复的旧文件会重新验证，不永久记坏。
- **与 Codex 的存储差异仍保留**：KodaX 的原始历史保存路径。运行中的准备内容是
  内存快照；关闭后恢复仍读取历史路径。此次不迁移全部历史、不改变附件清理/所有权。
  内存占用与本次运行仍引用的已准备图片成正比，生命周期随运行结束/消息释放结束；
  未承诺任意大历史的常量内存或跨进程缓存。

新增测试覆盖两种原生协议的 stream/complete、源文件删除后的连续调用、新块、恢复、
直接调用、并行/嵌套运行隔离、非视觉工具结果、SA/Runner 接入，以及 read/MCP 接收时
固定字节。存量恢复和消息顺序测试一起回归。

真实接口第二阶段回归预算：zhipu-coding 与 zai-coding 各 1 次串行请求，无自动重试，
各最多 1024 输出 token、45 秒；固定合成历史、禁止执行模型工具调用。原始结果另存
`%TEMP%/kodax-eval-dumps/glm-history-400-20260914/admission-recovery/`，保留第一阶段证据。

在 SDK 根目录执行：

```powershell
npx vitest run packages/llm/src/providers packages/llm/src/image-validation.test.ts packages/llm/src/image-validation-availability.test.ts packages/agent/src/capabilities/mcp packages/coding/src/tools/read.test.ts
$env:KODAX_IMAGE_COMPAT_AUDIT='1'
npx vitest run -c vitest.integration.config.ts packages/llm/src/providers/image-compatibility-audit.integration.test.ts
npm run typecheck
npm run build:packages
npm run build:bundle
npm run build:dts
node --test tests/bundled-image-validation.test.mjs
node --test tests/image-codec-release.test.mjs
```

真实接口回归需要现有 `ZHIPU_CODING_API_KEY` / `ZAI_CODING_API_KEY`，不要输出凭据：

```powershell
$env:KODAX_GLM_HISTORY_PROBE='1'
npx vitest run -c vitest.integration.config.ts packages/llm/src/providers/glm-history-400.integration.test.ts -t sdk-image-projection
```

两次显式请求，无 SDK 自动重试：缺 SOF 的 JPEG 和正常 JPEG 同处旧工具历史，
保留改价文字与思考。测试使用 low effort / 1024 token 获取短可见回复；
生产恢复不改变用户的思考设置。两家均返回可见回复，原历史与坏文件保持原样。
这验证模型请求恢复，不等于客户原 Word 文档任务已完成。

## 本次结果

第三阶段独立评审后的增量验证（2026-09-14）：

- 三个子 Agent 分别复核 Codex 对齐、规范最小性、消费者兼容。发现并关闭重复校验、
  队列超时不含等待、非消费通道多余准备三个问题；最终静态复核无新增可行动缺陷。
- Provider/MCP/诊断 47 文件 / 1022 项通过；Runner/SA/AMA 187 文件 / 2043 项通过、
  21 项既有 todo。两批有交集，不累加统计。
- 稳定后的边界回归 8 文件 / 286 项通过，包含 11 项消费入口测试：CLI→native hook
  切换、AMA 跨 idle-yield 的多次 Runner 调用仍仅校验一次、custom/CLI 不校验未使用历史、
  解码器不可用时 read/MCP 只校验一次、并行挂起检查共用排队预算。
- 此定向测试集覆盖两个核心文件合计 83.20% 行、92.15% 分支；不与上一轮不同测试集
  的覆盖率直接比较。未覆盖行主要是保留的既有直接文件辅助函数。
- 源码/测试类型检查、packages/bundle/dts 构建及 4 项构建产物/发布归档检查通过。
  本轮没有再次调用付费模型 API；上游恢复证据沿用下列两阶段记录。

前两阶段记录：

- 第二阶段扩大回归：216 文件 / 2473 项通过、21 项既有 todo；补充 read/MCP 初次校验
  取消后再次验证 38 文件 / 865 项通过（包含 2 项新增取消测试，不与前述数字累加）。
- 第二阶段核心两模块覆盖：90.24% 行、89.86% 分支；其中 image-serialization 为
  88.30% 行、90.81% 分支，image-validation 为 94.66% 行、88% 分支。
- 接收/恢复准备流程实测 zhipu-coding、zai-coding 各 1 次，均得到 `OK`；分别使用
  701 / 687 total tokens，没有工具执行及额外重试，原坏文件/历史未改写。
- Node 构建产物 4 项检查通过，包括独立 SDK 入口共享准备缓存、实际 Runner
  上下文溢出后压缩再请求，以及发布 tar/zip 两条路径携带 image-codec 的契约检查。
- 10 个引用 3,152,836 字节图片的块，25 次本地对比：旧重复准备中位 29.4573 ms，
  新准备一次 29.0918 ms 后复用中位 0.0202 ms、p95 0.0761 ms（包含缓存诊断，不含
  JSON 序列化/网络；首次准备前解码判定已预热；准备后删除源文件仍可复用）。证据：
  `%TEMP%/kodax-image-admission-perf-J7fzfv/results.json`。这是本机微基准，不是整体响应耗时承诺。
- 独立评审发现的发布资产遗漏和入口取消等待已修复并复核；扩大回归中发现的纯文本
  调度问题、图片诊断哈希问题也已修复。没有调整原有消息顺序/thinking 恢复规则。

第一阶段与安装环境验证记录：

- 扩大回归首次 47 文件 / 818 项通过，随后补充 8 项校验边界、超时恢复和 MCP 输入测试通过。
- 离线跨入口审计 27 项通过；真实 zhipu-coding / zai-coding 各 1 项通过。
- 解码模块 24 项测试：94.66% 行覆盖、87.5% 分支覆盖、100% 函数覆盖。
- SDK packages、Node bundle、声明构建通过；发布 media 入口 2 项检查通过。
- Windows Node、Bun 1.3.10 源码与编译后 sidecar 加载通过。
- Windows Electron 42.5.0 真实 ASAR 隔离探针：正常 WebP 保留、截断 JPEG 判坏。
  这不是完整 Space 安装包验收。
- Space 剪贴板测试 42 项通过、1 项系统符号链接权限相关跳过；Electron 类型检查通过。

`tests/fixtures/images/` 的 15 个文件全是合成资料：11 个有效 JPEG/PNG/GIF/WebP，
覆盖 progressive、CMYK、EXIF 旋转、透明度、无损 WebP、双帧 GIF、4000×64 PNG；
4 个坏例为空文件、无帧 JPEG、截断 JPEG、仅头部 PNG。基础 JPEG/PNG 由 Jimp
生成，其余格式由 Pillow 生成，并用 Pillow 完整解码核对有效控制组。

## 发布验收与边界

1. 发布新 SDK 后，Space 升级精确依赖并构建安装包；旧安装包引用的是 rc.4，
   不得向客户声称已安装的版本自动获得修复。Space 新校验接口是可选的以兼容旧 SDK。
2. Windows/macOS/Linux 安装包需实测正常附图、MCP 混合图片、粘贴、关闭重开旧会话、
   fork、连续追问和取消。macOS/Linux 及完整安装包尚未在本机运行。
3. 正常文件本地可解码、但服务端仍拒绝时，本次没有启用自动重编码或批量删图；
   会保留原图和现有失败信息（嵌套上游代码现已保留）。需要明确证据定位附件后，
   再增加有界兼容转换。上下文、认证、额度、参数等其他 400 不由此方案“治愈”。
4. 定义的本地预算/后端不可用走保留原字节的兼容路径，可能仍被上游拒绝；
   不能把 unverified 等同于通过校验。原文件不可读也不会冒充已损坏而静默忽略。

调查与 pi/codex 比较见 [兼容性报告](../investigations/IMAGE_COMPATIBILITY_RECOVERY_2026-09-14.md)。

通用恢复 sidecar 仅形成 [讨论稿](../investigations/GENERAL_RECOVERY_SIDECAR_DESIGN_2026-09-14.md)，
未加入运行时，不应将设计中的报错后自动修订/重试列为当前已实现能力。

## 主 Agent 文字诊断恢复（本次增量）

- 已有恢复策略需要人工继续、且剩余预算容纳诊断与重试时，对 native API 请求内容 400/422
  使用当前模型发起一次文字诊断。认证/权限/额度/传输错误沿用原策略，不自动改凭据或权限。
- 诊断保留文字任务与已完成工具结果，图片、原生工具块及不透明思考转为文字记录；不执行写入。
- 精确图片索引按实际 wire 请求解析并关联负载摘要；没有定位时才对实际已发送快照做只读检查。
  无法证明的图片不剔除；原始会话、文件和其他正常图片保持不变。
- 请求修复不会丢失完成的工具结果；无效计划、诊断失败和修复后失败停止。诊断及修复重试
  同时关闭 SDK 隐式重试。新用户输入进入 canonical queue 后，旧诊断不能应用。
- 正常请求不增加诊断调用，不逐次重新解码历史图片；完成后的全局校验缓存只存普通判定值。

运行生产路径回归：

```powershell
npx vitest run packages/coding/src/agent-runtime/text-recovery.integration.test.ts packages/coding/src/resilience/text-recovery.test.ts packages/llm/src/providers/rejected-image.test.ts
```

四 Provider 受控验证见 `MAIN_AGENT_RECOVERY_IMPLEMENTATION_2026-09-14.md` 的最终结果。
Space 已有 recovery 事件桥接接受 text_diagnosis；本地开发 link 与安装包版本更新分别验收。
这不是“所有错误必定自愈”，也不会替代模型对最终文案准确性的责任。

打包后运行 `npm run test:bundle`，包含新增图片校验、发行归档资产和通过凭据 broker 的
真实 bundle 恢复测试；现有 CI 与发布脚本会自动执行。

续轮检查：一次思考修复后，新生成的有效 thinking/signature 必须继续发送；工具修复后，
后来新增的工具调用及完成结果仍须保留。对应 helper 回归固定这两个边界，不能使用永久
布尔开关清掉此运行里所有未来内容。
