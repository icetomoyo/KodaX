# Union Alpha 是否支持 thinking，为什么请求成功却没有推理字段？

截至 2026-09-17，Union Alpha 的官方页面及 API 元数据均未声明可控 reasoning，严格路由实测也找不到支持 reasoning 参数的 endpoint；这不能证明底层模型没有内部推理。OpenRouter 默认允许忽略不支持的参数，因此 HTTP 200 也不能证明思考档位生效。[模型页面](https://openrouter.ai/stealth/union-alpha)、[模型 API](https://openrouter.ai/api/v1/models)、[严格路由实测](C:/Users/ADMIN/AppData/Local/Temp/kodax-eval-dumps/openrouter-reasoning/2026-09-17T06-15-15.314Z-strict-routing/report.json)、[默认参数路由规则](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters)

## 官方能够确认什么

- Union Alpha 是匿名第三方提供的预览模型，面向研究、编码及 agentic 工作流；页面声明图文输入、文本输出、工具调用和 JSON 输出，没有声明 thinking 开关、思考档位或推理文本输出。页面标注发布于 2026-09-16；上下文 262,144、最大输出 131,072 tokens，当前输入输出价格为零。[Union Alpha 页面及 FAQ](https://openrouter.ai/stealth/union-alpha)
- 2026-09-17 06:14 UTC 抓取的模型记录没有 `reasoning` 对象。模型和唯一 Stealth endpoint 的 `supported_parameters` 均仅列出 `max_tokens`、`response_format`、`temperature`、`tool_choice`、`tools`、`top_p`，不包括 `reasoning`、`reasoning_effort`、`include_reasoning`。[模型 API](https://openrouter.ai/api/v1/models)、[Union Alpha endpoints API](https://openrouter.ai/api/v1/models/stealth/union-alpha/endpoints)
- 同批元数据中的 `openai/gpt-oss-20b` 明确列出上述三个 reasoning 参数，并提供 `reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"], default_effort: "medium" }`。这说明两者的公开能力声明确有区别。[模型 API](https://openrouter.ai/api/v1/models)

本地元数据快照：[official-model-metadata.json](C:/Users/ADMIN/AppData/Local/Temp/kodax-eval-dumps/openrouter-reasoning/official-model-metadata.json)。这是当时的公开响应摘录，后续能力或路由可能变化。

## 请求参数的准确语义

| 问题 | 官方定义与结论 |
|---|---|
| 参数不支持会怎样？ | `provider.require_parameters` 默认 `false`；不支持全部请求参数的提供商仍可能被选中，并忽略未知参数。设为 `true` 才会过滤不支持参数的提供商。这是路由支持检查，不是对底层实际算力的测量。[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters) |
| 顶层 `reasoning_effort` 是否写错？ | Chat Completions 接口明确把它定义为 `reasoning.effort` 的简写；两者同时出现时不能取不同值。不能仅因 Union Alpha 没有推理输出就认定必须改成嵌套字段。[Chat Completions：reasoning_effort](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion#body-reasoning-effort) |
| `exclude: true` 是否关闭 thinking？ | 否。它只隐藏推理输出，内部推理及计费仍继续；`effort: "none"` 才表达关闭语义，实际支持取决于模型。[隐藏推理](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#excluding-reasoning-tokens)、[Effort](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-effort-level) |
| `include_reasoning: false` 是否关闭？ | 否。它是旧参数，等价于 `reasoning: { exclude: true }`。[Legacy Parameters](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#legacy-parameters) |
| 如何知道默认档及能否关闭？ | 官方模型元数据的 `default_effort`、`supported_efforts`、`mandatory` 用于声明这些能力；`mandatory: true` 表示不能发送 `none`。Union Alpha 未提供这些声明。[每个模型的推理配置](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options) |

官方文档存在一处枚举不一致：[参数总览](https://openrouter.ai/docs/api_reference/parameters#reasoning-effort) 的顶层 effort 列表漏列 `max`，而[当前 Chat Completions 接口定义](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion#body-reasoning-effort)及[reasoning 专页](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#controlling-reasoning-tokens)都包含 `max`。这里优先采用具体接口 schema，不能用总览遗漏推导网关拒绝 `max`。

## 为什么不能从字段缺失推导“模型不会思考”

OpenRouter 明确说明某些 reasoning 模型不会公开推理文本；隐藏选项也能让响应不包含文本。因此，要区分“接口支持控制”“本次返回推理内容”和“底层进行了推理”。前两者可查接口及响应，第三者不能仅靠字段缺失判断。[Reasoning Tokens 开头说明](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[隐藏推理](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#excluding-reasoning-tokens)

对于字段解析，`reasoning` 与 `reasoning_content` 是兼容别名；`reasoning_details` 还承载摘要、文本和加密结构，工具续接时应保留结构及顺序，不能只看可见 thinking。[Preserving Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning)

本次真实响应中，各字段的缺失、空值、usage 及 SDK 回传结果详见 [E2E 报告](../openrouter-reasoning-live-2026-09-17.md)。不能把“已发送某档位”写成“该档位已生效”。

## 严格参数路由的真实对照

2026-09-17 06:15 UTC，直接请求 OpenRouter 网关，共三次、每项一次且无自动重试；固定模型、OK 输入、`max_tokens: 128`、`provider.require_parameters: true`，未修改 SDK 或保存的 provider 配置。以下为网关响应，不是模拟结果。[原始报告](C:/Users/ADMIN/AppData/Local/Temp/kodax-eval-dumps/openrouter-reasoning/2026-09-17T06-15-15.314Z-strict-routing/report.json)

| 额外参数 | HTTP | 观察 |
|---|---:|---|
| 无 reasoning 参数 | 429 | 上游 Stealth 限流，`limit_source: upstream_provider_shared_pool`；基线未成功完成生成。 |
| `reasoning_effort: "high"` | 404 | 找不到可处理请求参数的 endpoint；`failed_routing_step: "Filter by Parameters"`。 |
| `reasoning: { effort: "high", exclude: false }` | 404 | 同上，候选初始为一个 endpoint，在参数过滤阶段淘汰。 |

三次报告总 token 与费用均为零。两个 reasoning 写法均无法通过当前 endpoint 的参数支持过滤，与公开元数据一致；基线的上游 429 不应被当作 reasoning 拒绝。嵌套请求多带了显式 `exclude: false`，因此不把两者称作完全单变量等价实验；两种写法的语义等价由官方接口定义支撑。[原始报告](C:/Users/ADMIN/AppData/Local/Temp/kodax-eval-dumps/openrouter-reasoning/2026-09-17T06-15-15.314Z-strict-routing/report.json)、[接口定义](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion#body-reasoning-effort)

**推断：**此前默认路由下 HTTP 200、无推理内容，与“未支持的 reasoning 控制被忽略”相符；文档、元数据及严格路由结果共同支持这一解释。但没有取得 OpenRouter 发往匿名上游的实际请求，不能断言具体在哪一层移除了参数，也不能断言底层没有隐藏推理。[路由规则](https://openrouter.ai/docs/guides/routing/provider-selection#requiring-providers-to-support-all-parameters)、[实测报告](../openrouter-reasoning-live-2026-09-17.md)

## 未证实

- Union Alpha 底层是否有隐藏推理、是否固定思考预算：官方未披露。
- 本次各 effort 请求在上游是否被忽略，或是否映射到某个内部设置：默认路由允许忽略，但仅凭 HTTP 200 无法证明具体发生了哪一种处理。
- `reasoning_tokens: 0` 是否完整反映匿名提供商的内部计算：尚无该模型专属的计量保证。
- 模型的真实开发商、底座及规模：没有可确认的第一方披露，不推测身份。

## 未解问题

1. OpenRouter 或匿名提供商是否会公开 Union Alpha 的 reasoning 参数及 usage 计量合同？
2. 当前接口未公开的内部思考行为及计量方式，能否由提供商直接澄清？现有公开接口及端到端观察无法回答。
