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


## T12-A Main 与产品入口（离线切片，最终凭证体验仍推进）

createProviderCredentialAuthorizer 为可信 Main 组合批准的 environment/OAuth/cloud/external 来源；环境值在每次请求读取，来源列表为明确 allowlist。它按实际 Host runtimeId 重绑，稳定 facade 不当作 Host 身份；前一 Host 清理失败会先封住本地权限、记录诊断并在 close 重试，失败仍可观察。撤销 session 后不返回旧授权。CLI 的 print/JSON/raw skill/interactive/recovery 使用同一 authorizer；CLI bridge 用自身登录，没有伪造 API key，仍受 lease allowlist 与 lifetime 限制。

createNativeCloudCredentialResolver 仅在可信 Main 启动官方 GoogleAuth ADC、AWS defaultProvider 或 Entra DefaultAzureCredential；每次解析先检查连接批准的 API key 名称，daemon 不回读云环境/磁盘/metadata。当前 Key 向导仍保留变量名入口；用户于 2026-10-30 进一步要求隐藏输入并保存 Key、默认共用 auth.json 与 Space 迁移，详见 FEATURE_302 T12-B–G，这些后续尚未验收。

loginProviderOAuth 执行实际 PKCE/state 或 device 流程，使用调用者自己的注册 clientId，持久提交后才发布 session。OpenRouter 的 clientId 仅标识 Main 应用，不作为不存在的服务注册证据。默认身份为服务发行的隔离 grant；只有宿主 verifyIdentity 成功才标记 account，既有验证账号记录保持。identityKind:grant 的 accountId 是不透明主体标识，不是已验证用户 subject/email。CLI auth login/status/logout 使用该流程，browser 要求已注册的 HTTP loopback URI 与明确端口；不支持的服务流程明确失败。

当前可选 encrypted OAuth store 在事务内覆盖 read/refresh/atomic commit，Windows DPAPI 通过 stdin 传入，临时文件也只有密文；真实 current-user DPAPI 与三个独立 Main 进程已测试。mkdir 锁在突然终止的 Main 后可能保留，30 秒后明确失败且不擅自删除未知归属锁；该后端不是最终共用文件后端的跨平台证明。SDK sealer 端口可由宿主提供 OS 后端，不存在静默 plaintext fallback。默认文件产品选择将在 T12-B–D 独立实现。

Product catalog.probeReasoningEfforts 现在先调用 Main authorizer 的 provider_probe 请求；Host 发出 provider.reasoning.probe 维护操作身份，broker 请求的 sessionId 为该操作自有 scope，不建立伪 Session。当前 Host 通过 providerProbeAuthorization:1 声明支持，旧 Main 若假设每次执行都有 Session，应先按 kind 收窄。探测使用 utility 目的、单次 generation，普通输出上限 16，手动 Anthropic thinking 为满足最小预算使用 1025；是否实质采用 effort 不由 HTTP 200 推断。

Managed Runner 保留 strict/grammar，并在未改动的 tool call 上保留 customTool 来源；工具名或输入经修复后不继承旧来源。主流式/真正非流式 fallback/continuation 与 compaction 都可报告 native protocol-input 哈希及 cache-write TTL 分区，只有 estimate 时保持明确标记。
