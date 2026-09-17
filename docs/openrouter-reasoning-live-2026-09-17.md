# OpenRouter reasoning 真实接口验证（2026-09-17）

使用本机已有 `OpenRouter` 自定义 provider：`https://openrouter.ai/api/v1`，默认模型 `stealth/union-alpha`，未声明 reasoning profile。测试当前工作区构建产物，通过公开的 `createCustomProvider().stream()/complete()` 调用真实 OpenRouter；fetch 只记录实际收发数据，没有替换服务器响应。另用相同配置临时覆盖模型为 `openai/gpt-oss-20b`，验证真实推理详情。未修改保存的 provider 配置。

结论：默认及显式档位的发送、明确拒绝后的缓存回退、真实推理字段解析和工具后续轮次回传均有实际网络证据。`stealth/union-alpha` 的强度是否生效、是否能关闭 thinking，仍然无法确认。所有成功结果的 `reasoningResolution.verified` 均为 `false`。

## 方法与范围

单元测试无法证明线上路由真实返回什么字段，因此增加受控网络 smoke；这不是模型能力或 prompt 优劣评测。通过 provider 的公开接口核对请求、返回结果及宿主回调，不涉及 CLI UI 或完整 SDK agent 自由运行。

固定单轮输入：system 为 `Follow the request exactly. Keep your final answer short.`，user 为 `Reply with exactly OK.`。检查实际请求中的 `reasoning_effort`、拒绝事件、最终 resolution 和响应字段，不以 HTTP 200 或可见 thinking 推断档位支持。

工具测试固定两轮：首轮要求 `Call read for /virtual/live-test.txt. After its result, reply with the exact value of the token field and nothing else.`；使用生产 `KODAX_TOOLS` 中 read 的完整定义，强制 read。将首轮全部 thinking/text/tool blocks 经 JSON 序列化往返后，注入工具结果 `{"token":"OPENROUTER_REPLAY_OK"}`，第二轮检查该精确回答。工具结果是受控测试输入，未执行文件读取；两轮模型请求均为真实网络调用。

每个阶段冻结：最多 16 次 HTTP 请求、每个 cell 最多 7 次请求（含 SDK 与 provider 重试）、最多两轮、每次输出上限 2048 tokens、累计 32768 tokens / 1 USD、单次逻辑调用 60 秒超时。同一 provider 串行。所有请求、重试和未完成样本保留；未重复已成功的档位矩阵。

## 实测结果

| 场景 | 观测 | 可以得出的结论 |
| --- | --- | --- |
| 默认 complete | 发送 `max`，返回 OK | 未设置 effort 进入 auto/max |
| 默认 stream | 发送 `max`，返回 OK | 流式默认也有明确控制字段 |
| 显式 none/low/medium/high/xhigh/max | 六档分别按所选值发送，均返回 OK；无档位拒绝事件 | 未被本地拦截；none 明确发送关闭意图。实际强度与关闭效果未验证 |
| 限流 | HTTP 429 重试保留当前档位，未产生能力拒绝事件 | 限流不会被当成 reasoning 不支持 |
| 非法值连续两次调用 | 首次 `invalid-e2e-effort` 被真实 HTTP 400 拒绝，回退 `max`；第二次直接发送 `max` | 拒绝事件只发生一次，后续调用复用拒绝缓存 |
| 默认模型工具两轮 | 首轮 read；第二轮精确返回 `OPENROUTER_REPLAY_OK` | 工具调用及结果回传路径完成 |
| gpt-oss-20b 工具两轮 | 返回真实 `reasoning`、`reasoning_details`；详情完整回传，最终回答匹配 | 流式/非流式解析与结构化推理回传得到真实响应验证 |

非法值测试是对真实网关枚举校验的负向测试，不代表 `max` 或 `none` 被模型拒绝。真实错误为：

```text
reasoning_effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"
```

修复后首轮 resolution 为 requested=`invalid-e2e-effort`、sent=`max`、reason=`unsupported-effort`；第二轮 requested 保持不变、sent=`max`、reason=`cached-rejection`。这证明缓存机制工作，不能据此证明所有标准档位都实现了各自的推理强度。

## “未返回推理字段”的准确含义

`stealth/union-alpha` 的成功流式响应中，`reasoning_content`、`reasoning`、`reasoning_details` 三个键均未出现。成功非流式响应中有 `reasoning: null`，另外两个键不存在。用量中 `completion_tokens_details.reasoning_tokens` 为 0。此前“未返回推理字段”应理解为没有非空的推理内容，而不是所有响应都缺少全部三个键。

这些证据不能判定模型本身不支持 thinking，也无法区分模型未产生可见推理、路由未暴露推理、控制参数被忽略等情况。因此保留“能力未知”，不添加拒绝缓存、不降档，也不将 HTTP 200 记为已验证支持。

`openai/gpt-oss-20b` 的补充样本：

- 首轮 stream 返回 3860 字符 `reasoning` 和 11 个 `reasoning.text` 片段，合并为一个详情块；没有重复拼接两个字段的相同文本。
- 原始 reasoning、原始详情文本拼接、解析后的 thinking 三者完全相等。
- 序列化后，下一轮请求中的 reasoning 与首轮原始字符串相等，reasoning_details 与解析结果逐字段相等。
- 详情 SHA-256 在首轮解析结果和下一轮实际请求中均为 `25657848de3a35ca8435114a4e8953948de759a50c815aee28b58b4b760d48bb`。
- 第二轮 complete 返回 450 字符推理；原始 reasoning、details 分别与解析结果完全相等，最终文本精确匹配。
- 该样本有可见推理，但同样不能证明 `high` 对应何种实际计算强度。

## 发现并修复的问题

第一次真实拒绝测试在 HTTP 400 后连续遇到 429。拒绝缓存和回调正常，但外层限流重试重新创建 `reasoningResolution`，使本轮首次拒绝被报告为 `cached-rejection`。

已新增 stream/complete 两个回归测试，先验证失败，再将 resolution 的生命周期调整为一次逻辑调用，并避免重试重复添加缓存原因。测试覆盖先拒绝、再限流、最终成功和下一次调用；首次保留 `unsupported-effort`，下一次仍报告 `cached-rejection`。真实接口复测首次 400→max 成功、第二次直接 max 成功；该次线上复测没有再次遇到 429，429 组合由确定性回归测试验证。

本次增量检查：相关 5 个测试文件共 84 项通过，LLM TypeScript 编译通过，live harness 语法检查及 `git diff --check` 通过。

## 未完成样本与验证边界

- 初始进程继承的凭据返回 401；Windows User 环境中已有另一份凭据可用。后续子进程使用后者，未打印凭据或修改持久配置。401 没有触发能力降级。
- 原始档位矩阵最后的 `max-second-turn` 在 429 后达到该阶段 16 次 HTTP 请求预算，未完成；旧 harness 表现为 Connection error。已保留原始记录，并改进 harness，后续预算耗尽明确报告。其他连续调用和两轮工具场景均已完成，不将该失败样本计入通过。
- 原模型未实际拒绝任何标准档位，也未拒绝 none。因此 max→xhigh→… 的多级拒绝链、none 被拒绝后的最低档回退、整参数拒绝和已声明默认档仍由回归测试覆盖，不能称为本次线上全部验证通过。
- 真实响应未覆盖 `reasoning_content` 或 encrypted details；这些字段的处理仍依赖已有回归测试。线上证据覆盖 `reasoning` 和 `reasoning.text` details。

## 证据与复现

脚本：`scripts/openrouter-reasoning-live.mjs`。先构建工作区，再显式运行所需阶段：

```powershell
npm run build:packages
# 仅当当前进程仍继承过期凭据，而 Windows User 环境中已有可用凭据时使用：
$env:OPENROUTER_API_KEY = [Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY', 'User')
node scripts/openrouter-reasoning-live.mjs --run pilot
node scripts/openrouter-reasoning-live.mjs --run matrix
node scripts/openrouter-reasoning-live.mjs --run replay
node scripts/openrouter-reasoning-live.mjs --run replay openai/gpt-oss-20b
node scripts/openrouter-reasoning-live.mjs --run rejection
```

原始数据只在本机临时目录，未进入仓库；不保存请求 headers，响应按凭据值脱敏。根目录：`C:\Users\ADMIN\AppData\Local\Temp\kodax-eval-dumps\openrouter-reasoning`。每次运行包含 `report.json`、`wire-N.json` 和解析结果。

| UTC 运行目录 | 内容 | HTTP 次数 | tokens | 返回的 cost (USD) |
| --- | --- | ---: | ---: | ---: |
| 2026-09-17T06-01-55.264Z-pilot | 401 凭据诊断 | 1 | 0 | 0 |
| 2026-09-17T06-02-30.696Z-pilot | 默认 complete | 3 | 49 | 0 |
| 2026-09-17T06-02-57.741Z-matrix | 默认 stream、六档、一次预算中止 | 16 | 339 | 0 |
| 2026-09-17T06-04-22.675Z-replay | 原模型工具两轮 | 4 | 1150 | 0 |
| 2026-09-17T06-05-17.248Z-replay | gpt-oss-20b 推理两轮 | 2 | 2938 | 0.00023046 |
| 2026-09-17T06-08-20.466Z-rejection | 拒绝缓存及限流报告缺陷复现 | 11 | 100 | 0 |
| 2026-09-17T06-10-34.002Z-rejection | 修复后真实复测 | 3 | 165 | 0 |

合计 40 次 HTTP 请求：16 次 200、21 次 429、2 次 400、1 次 401；18 次逻辑调用中 16 次完成、2 次未完成。服务返回用量合计 4741 tokens、cost 合计约 0.00023046 USD；这是响应账目之和，不是独立账单核验。

建议保留本次修复及回归测试。若宿主需要对某模型宣称“关闭有效”或“某强度已验证”，还需要路由/模型提供额外明确证据，本报告不作该结论。

## 追加：官方资料及严格路由诊断

用户随后要求核查模型详情。官方 models API 和该模型 endpoints API 均未列出 `reasoning`、`reasoning_effort`、`include_reasoning`，模型也没有 `reasoning` 能力对象。官方说明 `require_parameters` 默认为 false，不支持某参数的 provider 仍可能收到请求并忽略该参数。来源：[模型端点 API](https://openrouter.ai/api/v1/models/stealth/union-alpha/endpoints)、[官方路由文档](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters)。

另做三个直接 HTTP 请求，使用同一既有 provider/模型和固定 OK 输入，启用 `provider.require_parameters: true`；每个只请求一次，不自动重试，max_tokens=128、timeout=45 秒，总上限 3 次请求、4096 tokens、0.01 USD：

| 请求差异 | 实际返回 |
| --- | --- |
| 不带 reasoning 控制 | 429，上游 Stealth 共享池限流；正向成功对照未完成 |
| `reasoning_effort: "high"` | 404，`No endpoints found that can handle the requested parameters` |
| `reasoning: { effort: "high", exclude: false }` | 同上 404 |

两个 404 的结构化元数据均为初始端点数 1、失败于 `Filter by Parameters`。这进一步支持“当前 OpenRouter 路由没有可路由的 reasoning 参数支持”，不是从无 thinking 或 HTTP 200 得出的判断。普通请求的控制可能被忽略，符合官方默认路由语义；底层匿名模型是否做不可见内部推理仍未证实。这些直连诊断未改变 SDK 策略，泛化的 404 不写入档位拒绝缓存。

追加证据：临时根目录下 `2026-09-17T06-15-15.314Z-strict-routing` 和 `official-model-metadata.json`。追加 3 次请求（429×1、404×2），0 tokens / 0 USD；与前述 E2E 合计 43 次 HTTP 请求，生成用量不变。详细官方引用和未解问题见 [Union Alpha reasoning 调研](research/union-alpha-reasoning.md)。

## Standards

提交前独立规范评审未发现阻断项：本次改动符合包依赖方向、最小化及不新增 any、console.log、静默吞错的要求。工作区另有既存 NODE_ENV 修复，不包含在 reasoning 提交中。

## Spec

提交前需求评审发现两项 P2，均已通过先失败后通过的回归测试修复并复核关闭：

- DeepSeek V4 / GLM 5.2 的 `minimal` 是关闭别名，不能作为启用思考的最低回退档。ladder 已排除 `disabledEfforts`，新增三个实际 preset 的拒绝回退测试。
- 完整响应中无 id/index 的独立详情块曾被合并并覆盖签名。现在完整响应保留数组边界，流式仅合并同 id/index 且签名/格式不冲突的延续块；新增流式、非流式完整回传测试。

最终检查于 2026-09-17 完成：164 个测试文件、1606 项通过，19 项既有 todo；检查范围包括全部 LLM 测试、coding agent-runtime 契约、跨实例拒绝缓存和 SDK session events。六个核心改动模块（custom-provider、openai、openai-reasoning、reasoning-effort-rejection、reasoning-ladder、wire-effort）覆盖率：行 90.77%、分支 89.47%、函数 93.75%。`npm run build:packages` 和 `npm run typecheck` 均通过。

最终构建还离线重放了此前捕获的 gpt-oss-20b 真实响应：解析文本和详情与原始结果一致，序列化后的回传详情、reasoning 和工具后续答案均匹配，未新增网络请求。证据为原 replay 目录内 `final-parser-replay-check.json`；这属于捕获响应回放，不冒充一次新的线上 E2E。

评审汇总：Standards 0 项；Spec 2 项 P2 均已关闭，剩余 0 项。测试和线上证据范围内未发现新的回归，不作未测试全仓路径或模型内部思考强度的保证。
