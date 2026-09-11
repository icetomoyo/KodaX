# DeepSeek 官方 API 现状(2026-09):模型阵容、定价、OpenAI/Anthropic 兼容面与弃用时间线

> 调研日期:2026-09-10。仅采信官方一手来源(api-docs.deepseek.com 中英文文档)。每条结论附 URL;未能溯源到官方文档的内容一律放在「未证实」。

**TL;DR**:截至 2026-09-10,api.deepseek.com 只有两个在售模型标识符:`deepseek-flash`(实际模型 DeepSeek-V4.1-Flash,当天发布,支持图像理解,上下文 1M/输出最大 384K)和 `deepseek-v4-pro`(实际模型 DeepSeek-V4-Pro-0813,不支持图像,官方已宣布将有序下线——北京时间 2026-09-14 12:00 起至 V4.1 Pro 上线前,其请求全部路由到 V4.1 Flash 并按 Flash 价格计费)。旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用,由 V4.1-Flash 服务、按 Flash 价格计费;`deepseek-chat` / `deepseek-reasoner` 在本次抓到的官方页面中均未出现(见未证实)。定价以人民币/百万 token 计,分高峰/空闲两档,空闲为高峰一半:flash 输入缓存命中 0.04/0.02 元、未命中 2/1 元、输出 8/4 元;v4-pro 输入缓存命中 0.30/0.15 元、未命中 9.0/4.5 元、输出 27.0/13.5 元。OpenAI 兼容 base_url 仍是 `https://api.deepseek.com`;官方文档站设有《Using the Responses API》指南页(`/guides/responses_api`,存在性已确认,内容抓取超时,细节未证实)。Anthropic 兼容端点为 `https://api.deepseek.com/anthropic`,用 Anthropic SDK 改 `ANTHROPIC_BASE_URL`+`ANTHROPIC_API_KEY` 即可用;支持 system prompt、流式、tool use、vision(base64/url/file)、thinking;`cache_control` 被忽略(提示词缓存控制不可用),`anthropic-version` 头被忽略,`claude-*` 模型名自动映射到 DeepSeek 模型。

---

## A. 当前模型阵容(api.deepseek.com)

**结论:用户所述「DeepSeek flash」与「DeepSeek-V4 Pro」属实,官方模型标识符为 `deepseek-flash` 与 `deepseek-v4-pro`。**

- 当前模型名只有两个:`deepseek-flash`、`deepseek-v4-pro`。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing 「Models & Pricing」页(访问日期 2026-09-10);另见快速开始页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md(该 URL 实际渲染的是「Your First API Call」内容,Mintlify 站点 .md 后缀映射异常,但内容同样列出这两个模型名)。
- `deepseek-flash` 对应实际模型 **DeepSeek-V4.1-Flash**(2026-09-10 北京时间 12:00 起生效):552B MoE,新「Causal-Encoder-Decoder 结构」,非对称激活(输入 8B/输出 16B),官方声称基准超越 DeepSeek V4 Pro;**原生多模态视觉理解,API 直接支持**;KV Cache 的 HBM 需求降至 1/4、SSD 需求降至 1/8(官方称缓存较原模型缩小 437 倍,利好 Agent 负载);开源权重与技术报告已发 HuggingFace。
  来源:https://api-docs.deepseek.com/zh-cn/news/news260910 「DeepSeek-V4.1-Flash 发布」(2026/09/10,访问日期 2026-09-10)。
- `deepseek-v4-pro` 对应实际模型 **DeepSeek-V4-Pro-0813**(2026-08-13 正式版):上下文 1M、输出最大 384K、并发限制 500、**不支持图像理解**。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing(访问日期 2026-09-10);上线记录见新闻索引 https://api-docs.deepseek.com/zh-cn/news/news250929(页面含全站新闻列表:「2026/08/13 — DeepSeek-V4-Pro 正式版上线」)。
- `deepseek-flash`:上下文 1M、输出最大 384K、并发限制 2500、**支持图像理解**;FIM 补全仅非思考模式支持(两模型同此限制)。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing(访问日期 2026-09-10)。
- **多模态核实**:用户认为「DeepSeek flash 支持多模态」——正确,模态为**图像理解(vision 输入)**:`deepseek-flash`(V4.1-Flash)原生支持,`deepseek-v4-pro` 明确不支持。vision 指南独立成页 `/guides/vision`。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing(「支持图像理解」/「不支持图像理解」);新闻 https://api-docs.deepseek.com/zh-cn/news/news260910(「原生多模态视觉理解」);站点索引 https://api-docs.deepseek.com/llms.txt(列出 Vision — `/guides/vision`)。
- 前代视觉实验模型 DeepSeek-V4-Flash-Vision-Exp 于 2026-08-21 上线,现已随 V4 Flash 下线(见 E 节)。
  来源:https://api-docs.deepseek.com/zh-cn/news/news250929 新闻索引(「2026/08/21 — DeepSeek-V4-Flash-Vision-Exp 上线」)+ https://api-docs.deepseek.com/zh-cn/quick_start/pricing 弃用注 1。
- **`deepseek-chat` / `deepseek-reasoner` 的下落:未能从本次抓取的官方页面确认**(已抓取:定价页、V4.1-Flash 发布新闻、新闻索引、llms.txt 站点索引、Anthropic API 指南,均未提及这两个名字)。详见「未证实」。

## B. 定价(人民币,每百万 token)

来源(本节全部):https://api-docs.deepseek.com/zh-cn/quick_start/pricing 「Models & Pricing」(访问日期 2026-09-10)。

**deepseek-flash(DeepSeek-V4.1-Flash)**

| 项目 | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入(缓存命中) | 0.02 元 | 0.04 元 |
| 输入(缓存未命中) | 1 元 | 2 元 |
| 输出 | 4 元 | 8 元 |

**deepseek-v4-pro(DeepSeek-V4-Pro-0813)**

| 项目 | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入(缓存命中) | 0.15 元 | 0.30 元 |
| 输入(缓存未命中) | 4.5 元 | 9.0 元 |
| 输出 | 13.5 元 | 27.0 元 |

- 计价货币:**人民币(元)**,单位每百万 token。来源同上。
- 时段定义:「高峰时段」为北京时间周一至周五 9:00–12:00、14:00–18:00,其余为空闲;「空闲时段价格为高峰时段价格的一半」。来源同上。
- 计费规则:按 token 消耗量 × 模型单价扣减;赠送余额优先于充值余额扣减;官方保留调价权利。来源同上。
- 美元定价(英文站):英文定价页本次抓取未返回价目表(见「未证实」)。

## C. OpenAI 兼容面

- OpenAI 兼容 base_url:`https://api.deepseek.com`(鉴权 key 在 platform.deepseek.com 申请)。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing(「接入端点:OpenAI 格式 https://api.deepseek.com」)与快速开始页(同站 `/` 首页「Your First API Call」,经 https://api-docs.deepseek.com/llms.txt 站点索引确认)。
- Chat Completion API 参考页仍存在:`/api/create-chat-completion`。
  来源:https://api-docs.deepseek.com/llms.txt 站点索引(「API Reference (Chat Completion) — /api/create-chat-completion」,访问日期 2026-09-10)。
- **Responses API:官方文档站已有独立指南页《Using the Responses API》(`/guides/responses_api`)**,与 Vision、Thinking Mode、Tool Calls、Files API、Context Caching 等并列于「API Guides」目录。
  来源:https://api-docs.deepseek.com/llms.txt 站点索引(「Using the Responses API — /guides/responses_api」,访问日期 2026-09-10)。
  该指南页正文(支持的模型、端点路径、reasoning summary/流式/工具调用/图像输入/previous_response_id 等特性)本次抓取超时未取得 → 细节见「未证实」。
- `/v1/chat/completions` 具体路径字符串:本次抓取的页面均未逐字确认(抓到的页面只给了 base_url 与 API 参考页链接)→ 见「未证实」。

## D. Anthropic 兼容面

来源(本节全部):https://api-docs.deepseek.com/zh-cn/guides/anthropic_api 「Using the Anthropic API」(访问日期 2026-09-10)。

**结论:官方正式文档化了 Anthropic 兼容端点。**

- Base URL:`https://api.deepseek.com/anthropic`;鉴权用 `x-api-key` 头(「完全支持」),即 `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` + `ANTHROPIC_API_KEY=<key>`,配 Anthropic SDK(`pip install anthropic`)改环境变量即可用。
- 模型:原生支持 `deepseek-flash`、`deepseek-v4-pro`;并自动映射 `claude-opus*` → `deepseek-v4-pro`(2026-09-14 12:00 前按 V4 Pro 费率计费,之后路由至 V4.1 Flash)、`claude-haiku*` / `claude-sonnet*` → `deepseek-flash`;无法识别的模型名默认映射到 `deepseek-flash`。官方称该映射让 Claude Desktop 开发者模式只改 base_url 与 api_key 即可用。
- 特性支持:
  - system prompt:完全支持;流式:完全支持;`stop_sequences`:完全支持;temperature 支持(0.0–2.0)。
  - 思考/推理:支持(`budget_tokens` 被忽略);`top_p` 仅思考模式生效且最小 0.95,否则固定 1.0。
  - Tool use:`tools` 的 `name`/`input_schema`/`description` 支持;`tool_choice` 接受 `none`/`auto`/`any`/`tool`(`disable_parallel_tool_use` 被忽略)。
  - Vision:图像内容块支持 `base64`(jpeg/png/gif/webp)、`url`、`file`(file 需 beta 头)。
  - 支持的内容块类型:`text`、`image`、`thinking`、`tool_use`、`tool_result`、`server_tool_use`、`web_search_tool_result`。
- 已文档化的限制:
  - 被忽略的参数:`cache_control`(**提示词缓存控制完全不可用**)、`container`、`mcp_servers`、`service_tier`、`top_k`、`is_error`、`citations`;`anthropic-version` 头与 `anthropic-beta/messages` 被忽略(Files API 端点需 `files-api-2025-04-14`)。
  - 不支持的内容块:`document`、`search_result`、`redacted_thinking`、`code_execution_tool_result`、`mcp_tool_use`、`mcp_tool_result`、`container_upload`。
  - `output_config` 仅支持 `effort`;`metadata` 仅保留 `user_id`(用于限流隔离)。
- Claude Code 接入另有专门指南页 `/quick_start/agent_integrations/claude_code`(存在性见 https://api-docs.deepseek.com/llms.txt)。
- `stop_reason` 映射表:该页未给出 → 见「未解问题」。

## E. 迁移 / 弃用时间线

- **V4 Flash / V4 Flash Vision Exp 已下线(模型本体)**:旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍被接受,但请求由 DeepSeek-V4.1-Flash 服务、按 Flash 价格计费。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing 弃用注 1;https://api-docs.deepseek.com/zh-cn/news/news260910(「V4 Flash 与 V4 Flash Vision Exp 现已离线,旧名暂时路由至 V4.1 Flash 以保持兼容」)。
- **V4 Pro 有序下线**:因「V4.1 Flash 已全面超越 V4 Pro」(官方测试结论),**北京时间 2026-09-14 12:00 之后、V4.1 Pro 上线之前**,`deepseek-v4-pro` 的请求将全部路由到 V4.1 Flash 并按 V4.1 Flash 价格计费。
  来源:https://api-docs.deepseek.com/zh-cn/quick_start/pricing 弃用注 2;https://api-docs.deepseek.com/zh-cn/news/news260910(同内容);Anthropic 面的 `claude-opus*` 映射同步此时间线(https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)。
- **V4.1 Pro 尚未发布**,上线时间官方未给出(来源:上述两页仅表述为「至未来 V4.1 Pro 上线之前」)。
- 历史参考(非现行):V3.2-Exp 发布时(2025-09-29),V3.1-Terminus 曾通过特殊 base_url 保留对照测试至北京时间 2025-10-15 23:59。
  来源:https://api-docs.deepseek.com/zh-cn/news/news250929 「DeepSeek-V3.2-Exp 发布」正文。
- 版本沿革(新闻索引,均为标题):2026/04/24 V4 预览版 → 2026/08/13 V4-Pro 正式版 → 2026/08/21 V4-Flash-Vision-Exp → 2026/09/10 V4.1-Flash;2025/12/01 V3.2 正式版(「强化 Agent 能力,融入思考推理」)。
  来源:https://api-docs.deepseek.com/zh-cn/news/news250929 页内全站新闻列表。

## 冲突与取舍

- **抓取异常而非来源冲突**:URL `https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md` 与 `https://api-docs.deepseek.com/en/quick_start/pricing` 均返回了「Your First API Call」快速开始页内容而非定价页;`/zh-cn/quick_start/pricing`(无 .md)返回完整定价表。三者在模型名、弃用注、接入端点上内容一致,故以无 .md 的中文定价页为准;英文站定价(疑似美元价)未取得。
- 其余来源之间(定价页 vs 新闻 vs Anthropic 指南)无事实冲突;Anthropic 指南对 `claude-opus*` 计费的表述与定价页 V4 Pro 弃用时间线互相印证。

## 未证实

以下内容未能溯源到官方一手来源,不作为结论:

1. **`deepseek-chat` / `deepseek-reasoner` 的现状**(更名?弃用?别名?)——已抓取的定价页、V4.1-Flash 发布新闻、新闻索引、llms.txt、Anthropic API 指南均未出现这两个标识符;未能定位到明确提及它们的官方页面。
2. **Responses API 的端点路径与特性细节**(`/v1/responses`?支持的模型?reasoning summary、流式、工具调用、图像输入、`previous_response_id`/有状态用法?与 chat completions 的差异?)——指南页存在性已由 llms.txt 确认,但页面正文抓取超时。
3. **英文/美元定价**——`/en/quick_start/pricing` 抓取未返回价目表,无法确认英文站是否为美元计价及具体数字。
4. **`/v1/chat/completions` 路径字符串**——本次抓到的页面只确认了 base_url 与 Chat Completion 参考页存在,未逐字确认路径。
5. **「DeepSeek Harness」**(llms.txt 索引中的 Agent 集成,指向 deepseek-harness.github.io)——未验证。

## 未解问题

1. `deepseek-chat` / `deepseek-reasoner` 若仍被接受,请求路由到哪个模型、按哪个价格计费?官方是否有专门迁移公告?(需在 `/updates` 变更日志或 `/api/create-chat-completion` 参考页进一步查证。)
2. Responses API 指南的完整内容(端点、模型、特性矩阵)与文档化的限制清单。
3. Anthropic 兼容面的 `stop_reason` 到 DeepSeek 侧的映射规则(指南页未给出映射表)。
4. V4.1 Pro 的发布时间与定价;V4 Pro 旧名在 2026-09-14 之后是否长期保留别名。
5. 限流分层详情(`/quick_start/rate_limit`「Rate Limit & Isolation」页未抓取;定价页仅给出两模型并发上限 2500/500)。

---

## F. 官方 Anthropic 兼容端点 live 探针(2026-09-10,补录)

> 以下为本仓库对 `https://api.deepseek.com/anthropic` 的一手实测(`x-api-key` 鉴权,全部最小请求,flash 模型)。这是**第一方 API 实测证据**,补足文档抓取之外的接入事实。

**TL;DR:官方 Anthropic 兼容端点协议层全绿——tool use(含流式 `input_json_delta`)、vision、thinking(启用/禁用/带签名的 thinking block)、`count_tokens`、标准 Anthropic SSE 事件语法、旧模型名、`cache_control` 容忍、多轮 thinking 回放均验证通过,且未复现 OpenAI 线的 `reasoning_content` 回放 400 quirk。切换内置 `deepseek` provider 到 Anthropic 兼容线在协议层已无阻断项。**

| # | 探针 | 结果 |
|---|---|---|
| R1 | 基本对话(不传 thinking) | 200;返回 `thinking`(带 `signature`)+ `text` 块;**默认 thinking 恒开** |
| R2 | 旧名 `deepseek-v4-flash` 走 Anthropic 线 | 200;回显 `model: deepseek-v4-flash`,thinking 块带签名 |
| R3 | tool use | 200;`stop_reason: "tool_use"`,`tool_use` 块正常 |
| R4a | `thinking:{type:'enabled',budget_tokens:1024}` | 200 |
| R4b | `thinking:{type:'enabled'}` + 顶层 `reasoning_effort:'high'` | 200 —— **KodaX `anthropic-reasoning-effort` 策略的线上形状被原生接受** |
| R5 | vision(1px PNG base64) | 200;图片输入被接受(命中 max_tokens 因先输出 thinking) |
| R6 | system 带 `cache_control` + `anthropic-version` 头 | 200;按文档被忽略、不报错 |
| R7 | 多轮回放含 signature 的 thinking block | 200;**无 400**(对比 OpenAI 线剥掉 `reasoning_content` 会 400) |
| P1 | `POST /v1/messages/count_tokens` | 200;返回 `input_tokens` —— `verifyStrategy: 'count-tokens'` 可用 |
| P2 | SSE 流式 + tool | 200;事件语法为标准 Anthropic:`message_start → content_block_start:thinking → thinking_delta → signature_delta → tool_use + input_json_delta → message_delta(stop=tool_use) → message_stop` |
| D1 | `thinking:{type:'disabled'}` | 200;**仅 text 块,thinking 真正关闭** —— 与 KodaX provider-toggle 禁用路径(`packages/llm/src/providers/anthropic.ts:339`)的线上形状完全一致 |
| D2 | 顶层 `reasoning_effort:'none'`(不传 thinking) | 200;thinking 仍开 —— 该字段单独出现不控制开关 |
| D3 | `budget_tokens:32` | 200;thinking 仍开(极小预算) |

**对 KodaX 切线的直接结论(2026-09-10 第二轮探针后更正):**

~~初稿曾推测应改用 `anthropic-reasoning-effort`(顶层 `reasoning_effort`)~~ **该推测被第二轮探针证伪,恰好说明先验证是对的:**

| # | 探针 | 结果 |
|---|---|---|
| OFF-B | `thinking:{type:'adaptive'}` + `output_config:{effort:'high'}`(ark preset 方言) | 200,正常出 thinking |
| V1 | 顶层 `reasoning_effort:'bogus'`(非法值) | **200 放行 → 该字段不被解析,纯忽略** |
| V2 | `output_config:{effort:'bogus'}`(非法值) | **400 + 类型化枚举报错**:`unknown variant 'bogus', expected one of 'low', 'medium', 'high', 'xhigh', 'ultra…`(截断)→ **该字段被原生解析** |
| W1-W3 | `output_config.effort` = `max` / `ultra` / `xhigh` | 全部 200 —— **KodaX 的 `max` 档合法,且上游还有更高的 `ultra` 档** |
| PRESET-H/M | preset 实际发出的精确组合 `thinking:{type:'enabled'}` + `output_config:{effort}`(high/max) | 全部 200,正常出 thinking |

**最终结论(与初稿相反):**

1. 官方 Anthropic 兼容端点**原生实现的是 Claude 的 `output_config.effort` 方言**(类型化枚举校验),顶层 `reasoning_effort` 才是被忽略的那个。仓库现有 `deepseek-v4-anthropic` preset(序列化器专属分支:`thinking:{type:'enabled'}` + `setAnthropicOutputEffort`,见 `packages/llm/src/providers/anthropic.ts`)**方言本来就正确,无需任何修改**;ark-coding 的同名模型共用该 preset,天然走同一方式。
2. 内置 `deepseek` provider 已于 2026-09-10 切到 `KodaXAnthropicCompatProvider` + `baseUrl: 'https://api.deepseek.com/anthropic'`,`verifyStrategy` 改为 `count-tokens`(P1 已验证),移除 OpenAI 线专用的 `replayReasoningContent` 与 `maxOutputTokensField`。真实 key 端到端验证:`verifyProviderCredential('deepseek')` → ok(count-tokens,假 key 正确拒绝);empty-content wire-compat 4 个真实流式用例(含 thinking-only 回放、orphan tool_use 修复)全部通过。
3. thinking 回放(R7)、`cache_control` 被忽略(R6)、默认 thinking 恒开(R1/R6 不传参数也出 thinking 块)与 OpenAI 线行为不同,相关断言已随切线重写。
4. 已知未决:ark-coding 账号 CodingPlan 订阅过期,ark 端点本轮全部 400,无法实测——但 preset 零改动 + 无生产流量,无回归面;订阅恢复后建议跑一轮 `verifyProviderCredential('ark-coding')` + empty-content 用例确认。
5. 未来可选:官方枚举含 `ultra` 档(高于 KodaX `max`),如需暴露可另立 feature,本轮不做(YAGNI)。

**补录(2026-09-10,assistant 块顺序限制)**:端点对 assistant 消息内**尾部 text 块**（位于 `tool_use` 之后）会 400，报错为 "`tool_use` ids were found without `tool_result` blocks immediately after" 且路径指向该 text 块——**即使下一条 user 消息结果齐全**。实测:`[thinking, tool_use×2, text]`+完整结果 → 400;`[thinking, text, tool_use×2]`/`[thinking, tool_use×2]` → 200。该限制官方文档未记载;KodaX 序列化器已改为 assistant 消息保序发射（内部存储顺序即模型自然输出顺序 thinking→text→tool_use）。

**本轮未测项**:`output_config.effort` 各档位的实际行为差异(小 prompt 下 thinking 长度无显著差,难题采样全部打满 `max_tokens` 上限,无法判别调制深度——这是上游实现问题,不影响接入正确性);`metadata.user_id`、`stop_sequence` 容忍度;长会话 `cache_read_input_tokens` 计费回传。

**补录(2026-09-10,vision-exp 清理)**:`deepseek-v4-flash-vision-exp` 旧 id 经双线实测**仍被服务端接受**——Anthropic 线 200 并回显原名;OpenAI 线 200 但响应的 `model` 字段已被重写为 `deepseek-flash`,即纯服务端别名、无独立模型。经确认已从 KodaX 声明面全部移除(provider-capabilities.json models[]、agent 图片路由白名单、cost-rates、配置模板与文档);历史配置若仍选择该 id,运行时不受影响(服务端继续服务,能力解析回落 provider 级,图片按 legacy 路由拒绝)。

**补录(2026-09-10,legacy id 全面收敛)**:`deepseek-v4-flash` 同样从声明面移除(models[]/cost-rates/模板/文档),与 vision-exp 同理——服务端仍接受,但官方在售名单只有 `deepseek-flash` 与 `deepseek-v4-pro`,故 KodaX 仅声明这两个。`deepseek-v4-pro` 保留至 V4.1 Pro 发布后再评估。同日附带修复:跨 provider 切换时恢复会话中的中断工具轮(assistant 多个 `tool_use` 无 result)会触发官方端点 400(已用真实请求复现并对照验证),两族序列化器升级为**合成 `[Tool Error]` tool_result**而非丢弃调用,详见 `docs/KNOWN_ISSUES.md` 同日条目。
