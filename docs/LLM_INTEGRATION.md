# LLM 接入补齐契约（FEATURE_302）

实现对照 pi `e7a0df27c09d11bf4161d3605246cbf57a129cb2`，2026-10-30。这里描述代码和离线契约；不将服务目录、client 注册、订阅权益或 fixture 视为真实账号验证。T12 的产品入口和最终全量验收仍在实施。

## 能力、历史和请求扩展

独立 `@kodax-ai/llm` 与根 SDK `/llm` 暴露相同原生工具能力。provider/model 的 `toolCapabilities` 和 `cacheCapabilities` 为显式声明，模型覆盖 provider。未知模型不按名称猜测 grammar、reasoning 或长缓存。strict、grammar、Google VALIDATED、Bedrock strict 和 Pi constrained sampling 保留各自协议形式；动态工具增删不把旧调用重新解释为新授权。Responses custom 工具及 receipt 只在来源/身份相符时原样回放，跨来源转为普通可读/JSON 历史。

Stream/complete options 可传 temperature、原生 samplingParams、env、headers、fetch、identity，以及 onPayload/onResponse/onProviderStreamEvent/onRequestPrepared。env 是本次请求快照；已有 broker scope 不回退到 env。identity 是可信调用者提供的额外隔离标识，不验证账号。fetch 是可信传输端口，不适合作为不可信配置。onPayload 返回扩展补丁；核心模型/历史/工具/预算/reasoning/cache 字段不可覆盖，认证/路由目标由连接和 broker 负责。hooks 的失败明确报错，不因 ECONNRESET 等外观重放已经收到响应的生成。

samplingParams 使用实际 native 字段名：OpenAI/Anthropic 为顶层；Google 为 generationConfig；Bedrock 为 inferenceConfig；Pi 为 options。Vercel JSON `providerOptions.gateway.order/only` 可经 onPayload 扩展传递；BYOK/凭证与嵌套缓存控制禁止经此入口注入。授权、组织/project、签名、订阅路由和 affinity headers 由接入层控制。响应 hook 获得独立 clone；调用者应消费/取消其 body。

## 缓存和用量

全局 disablePromptCache 或本次 cacheRetention:none 去掉可控 checkpoint/affinity。long 仅对声明支持的 TTL 生效：OpenAI retention（24h）/options（30m、12h）、Anthropic/Bedrock（1h）与 Pi 原生策略。OpenAI options 的显式边界覆盖文本和工具结果，不声称图片边界支持。Anthropic 声明限制 system/tools/messages 和 checkpoint 数量；Fireworks preset 使用 x-session-affinity，去掉 tools cache_control，不支持 long。旧兼容路由默认策略保持。原生 Claude display/block binding 按显式模型能力启用，关闭 thinking 时不发这些字段，beta 也不按模型名猜测。

cachedWriteTokensByTtl 保留 5m/1h/30m/12h/unknown 分区。缺失/不一致的分区或价格不默认为短缓存价格。费用为估算或名义价格，未知返回 null；目录价格为带时间、来源、条件的报价，不自动成为账单或无条件费率。

Google cachedContent 有显式 create/get/list/update/delete 操作。createGoogleCacheConnection 要求 trusted accountScope，Google/Vertex 使用原生缓存资源路径和每次新鲜 utility broker。Vertex 要求匹配的 project/location；不支持 Express 的显式缓存。引用携带来源、模型、期限、system/tool/forced-policy 转换摘要；复用时去掉重复的 system/tools，尾部历史由调用者提供。引用不是权限，换账号/来源/过期/声明变化会拒绝。cache-off 不会通过删除资源引用而静默丢掉其上下文。

## 目录刷新和 WebSocket

refreshProviderModelCatalog 支持 OpenAI models、OpenRouter 用户目录、Radius /v1/config。必须传可信 accountScope；每次 fresh broker，15 秒默认期限，条件 GET 和有界响应。curated 与 advertised 分开，稀疏远端数据不覆盖已知默认预算。401/403/404 返回 unavailable 和此前 snapshot；不是可用性确认。Radius 返回的 baseURL 仅为同源建议，不自动改路由。

持久 KodaXModelCatalogStore.compareAndSwap 必须在同一原子事务内检查 expected revision、signal 和 isCurrent，持久提交之后才发布。Host 账号切换/撤销应使 isCurrent 失效；并发新请求取消旧请求，旧响应不能覆盖新目录。默认内存 store 供独立库使用；Host 持久化属于可信 Main。

Responses/Codex/Azure 可显式选择 transport:auto/websocket/websocket-cached；默认 SSE 不变。auto 仅在 generation frame 发出前的握手失败允许 SSE 回退，401/403/429不隐藏；发出后中断/失败不猜测重放。singleAttempt 禁止额外 generation。previous_response_not_found 的明确前置拒绝可在新 socket 上做一次 full-history 尝试。

cached transport 要求显式 session 标识和有效 owner lifetime：独立调用用 webSocketLifetime，broker 调用由当前授权 lease 拥有。每次仍新鲜取凭证；撤销/owner 关闭会关连接。只有完整且合法的终态才能缓存 continuation；历史前缀、工具、reasoning/cache 或身份变化会全量发送。恢复 Host 必须重绑，不复用序列化 lease。WebSocket 的物理推理计数从 frame 发送开始，握手不计作生成；部分 usage 可观察，但部分工具不可执行。

## 验证与外部前提

验收证据见 [测试指南](test-guides/FEATURE_302_v0.7.99_TEST_GUIDE.md)。公开能力、目录内容、cache TTL、条件报价及 OAuth 端点来自固定 pi 源码与官方资料；实际账号模型权限、云身份、刷新服务、缓存命中/保留时长、真实计费仍需相应账号验证。OAuth client ID 必须由宿主合法注册，不借用其他应用身份。
