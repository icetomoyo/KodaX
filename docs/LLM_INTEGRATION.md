# LLM 接入补齐契约（FEATURE_302）

## Issue 376 接缝补齐（2026-11-01，尚未发布）

内建 Anthropic 的 Claude Opus/Sonnet/Haiku 5.5 使用版本化 `nativeHistory`
增量片段，保存实际已发送的图片/提醒和协议响应块（工具输入沿用既有解析策略）；
JSON 落盘后校验账号、目的地、
模型、canonical 前缀及父片段再复用。系统/工具变化转为会话内原生更新，保持旧前缀；
effort 变化采用会话内控制，thinking 模式变化建立新 lineage，移除旧签名但保留已接纳
的图片和工具回执。跨账号/模型、编辑历史、压缩或缺失父片段不能继承不再可证明的
opaque thinking；可读推理保留为普通上下文。安全过滤改变输出时不保存被过滤的原始片段。

缓存 TTL/关闭只重新投影协议缓存标记，不改工具参数或 JSON Schema 中同名业务字段。
stream 保留实际 block 次序、空但已签名的 thinking、citation 和服务端工具 JSON delta。
`thinkingMode` 为受模型限制的可选 SDK 控制：Sonnet 支持 `between_tools`，Haiku 支持
`disabled`；Opus 仍要求 adaptive。发送前拒绝不支持的 sampling 和 assistant prefill。
`onPayload`/`samplingParams` 不能覆盖统一 effort，非 effort 的 `output_config.format`
扩展仍可合并使用；prepared hash 对应最终发送对象。兼容网关保留其文本优先/宽松签名
策略，旧模型保持原 thinking 参数策略；严格 Anthropic 序列化保留实际块次序。

OAuth lease 可协商 `credentialContextVersion: 1`。可信 Main 返回带稳定注册/账号隔离身份
的请求凭证封装，LLM 层在进入请求作用域时解包，HTTP 头只包含内部凭证。401 可按被拒
token 的指纹刷新同一注册代次，失败的生成 POST 不重放；下一次明确的新请求再取新凭证。
旧的 string broker/绑定入口继续可用；grant 隔离不因此成为已验证 subject，仍遵守下文的
`verifyIdentity`/`identityKind` 契约。云回调可选择返回 `{credential, replayIdentity}`；
该 identity 必须来自可信 principal 校验，不能以 unsigned token claim、profile 名或环境
变量名推定。默认云 SDK 无法证明稳定 principal 时继续采用保守隔离，不新增身份查询请求。
端点指纹仍按实际请求环境校验，配置/环境 key 继续可用，broker scope 不回退到另一来源。

公共目录没有当前账号的请求身份，不以某个账号的拒绝记录全局收窄能力。显式 probe
继续对每个候选发出有界真实请求，供用户主动重新验证；普通生成请求才在自身 scope
内沿用拒绝缓存并自愈。probe 不改变用户默认 effort，忘记能力记录仍是独立显式操作。

模型目录新增 5.5，不改原默认模型与默认输出预算。费率采用三款模型官方 overview
（[Opus](https://platform.claude.com/docs/en/models/opus-5-5/overview)、
[Sonnet](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、
[Haiku](https://platform.claude.com/docs/en/models/haiku-5-5/overview)，2026-11-01 核对）；
Haiku 长上下文档位先按完整输入计量，再分配 cache 读写。协议依据官方
[preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、
[会话内系统消息](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) 和
[effort](https://platform.claude.com/docs/en/build-with-claude/effort)。离线 fixture 不验证真实签名、
订阅权益、服务端缓存命中或跨区域价格；其他 Anthropic 网关、Vertex/Bedrock 的高级原生
5.5 历史并不因此自动获得同等协议保证。

实现对照 pi `e7a0df27c09d11bf4161d3605246cbf57a129cb2`，2026-10-30。这里描述代码和离线契约；不将服务目录、client 注册、订阅权益或 fixture 视为真实账号验证。T01–T12 的实现与离线验收已于2026-10-31完成，尚未合并或发布；真实账号及跨平台范围见最终验收记录。

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


## T12-B 共用文件与连接证明（离线基础层）

`createFileProviderCredentialStore(absolutePath)` 是明确选择的本机权限保护明文后端，版本化文档将 Key 与 OAuth registration 分开保存；不是 OS vault 失败后的回退。独立 llm 不选择产品配置根，不依赖 CLI/REPL/Electron。Key 按 profile、provider alias 与 `provider.getCredentialConnectionFingerprint()` 绑定；指纹覆盖实际 API、地址、认证模式、OAuth 服务与云路由，不含模型、预算、密钥或变量名。SDK/Main 可读原值；UI 仅使用 describe/set/remove 的脱敏状态与 revision CAS。

可信独立 SDK 用 `createFileProviderCredentialAccess({store, bindings})` 创建明确 allowlist，再经既有 `createProviderCredentialLeaseScope` / `runWithProviderCredentialLeaseScope` 调用 provider；每次实际请求重读，缺失/错误连接证明或删除 Key 都明确拒绝，不回退 env。原生云绑定额外显式声明 cloud 服务，以将保存 Key 转成已有 typed cloud carrier；Gemini/Vertex/Azure 用 api-key，Bedrock 用原生 bearer，不将单值误当 AWS 签名密钥对。scope 关闭仍撤销后续权限。保存文件本身不宣称取消所有其他进程已发送的生成；产品更新/撤销的 lease 管理属于 T12-C/D。

Host v2 broker 附带实际 adapter 的非秘密 connectionFingerprint，Main 可要求其等于批准值；旧 environment 来源未开启此约束时兼容。Host 通过 `providerCredentialConnectionBinding:1` 声明该能力，调用方可要求版本。OpenAI/Anthropic SDK 使用与证明相同的实际地址，并在 key/路由变化后刷新 memoized client。OpenAI org/project 从请求环境快照读取并隔离 credential/reasoning identity；broker 控制的连接仍去掉 ambient org/project。背景 Responses 使用与前台 Responses 相同的 API 身份。

整份 JSON 的读改写与 OAuth rotating refresh 共用 proper-lockfile 锁（30 秒 stale、5 秒 heartbeat），新进程不覆盖无关记录。提交为 fsync 后原子 rename；POSIX 文件 0600、staging 目录 0700；Windows 在写明文前去掉继承，仅授予当前用户与 SYSTEM。明文临时文件位于 auth.json.staging，清理失败可见。损坏/未知版本、CAS 冲突和失败事务不覆盖既有数据。应用文件工具保护 auth.json 及临时/备份变体；POSIX shell 对文件和整个 staging 目录显式遮蔽，Windows 文件不继承 sandbox grant。此边界不承诺隔离任意同 OS 用户恶意进程。

2026-10-30 此基础层已有保存后重建 provider、三个独立 Main 进程、API/路由/同名连接和实际 Windows ACL 测试；隐藏输入、CLI 默认文件切换及 Space 实迁移仍为 T12-C–F，最终全量验收仍为 T12-G。


## T12-C Key 管理与产品入口（离线切片）

CLI `kodax setup` 和 REPL `/setup` 现在可选隐藏输入并保存 Key、使用环境变量、或在原生云路线使用现有 env/Main 身份。向导显式切换到 env/cloud 时删除该精确连接的保存值；没有 secret 输入端口的旧 metadata-only SDK interaction 仍兼容。保存成功后重启无需配置 API_KEY 环境变量，原有变量名和值继续有效，优先级为保存值→批准 env→已声明的云/外部流程。普通 config.json 始终不写 Key。OAuth 路线继续走 login，不能误用 set-key。

`kodax auth set-key <provider>` 从 stdin 隐藏读取，Key 不放在 argv；`status` 显示 source/stored 与未在线验证状态；`remove-key` 删除并明确展示剩余来源。Main 每次读取文件，不批量写 process.env。真正 CLI 进程的 setup/重启 status/remove/set 测试已通过；这里不把配置成功等同于真实 API 权益验证。

`@kodax-ai/kodax/runtime` 导出 createProviderCredentialManager({configPath?,profile?,environment?})。configPath 默认实际 KodaX 配置根的 config.json；Space 等宿主应显式使用其实际根/profile。describe 返回非秘密 binding、configRevision、credential revision、source、stored/configured；setApiKey/removeApiKey 要带此前的状态，校验配置与精确连接、再做 Key revision CAS。UI 不接 readApiKey。配置提交失败或并发变化只按本次修订回滚；新的并发值不会被覆盖。

文件文档现在写 version:2，API-key 删除保留仅含 binding/revision 的 tombstone，避免 set→delete 的并发变化被误认为从未写入，并防止旧向导恢复已被其他操作删除的 Key。v1 正确文档可读且只读时不改写，下次修改原子升级 v2；旧程序遇到不支持版本明确失败。describe/remove 后即使 configured:false，也必须保留返回 revision 用于下一次条件写。未条件化的底层 SDK 操作仍属于可信 Main 的显式写入能力。

终端 secret 输入使用该 readline 实例专属输出视图，禁用本次 history；取消/EOF 后恢复正常输出。Classic REPL 和 Ink 都接入 secret port；Ink 输入不带默认 Key，画面与布局只见固定掩码，不把原值附加到对话。可见状态不声称隔离任意同 OS 用户进程。

为保留 CLI 5MiB-64KiB 预算，配置模板移入 generated-config-templates.json；同一生成脚本检查源模板逐字一致，独立 REPL、npm dist 与编译二进制均带资源。没有放宽预算。默认 OAuth 共用文件/旧加密注册迁移仍为 T12-D；Space 实迁移 E/F 和全量 G 尚未完成。


## T12-D 默认 OAuth 文件与恢复（离线切片）

providerOAuthStore(configPath) 现在使用同目录 auth.json 的 OAuth 区域，与 Key 共用整文档锁；新登录不要求 Windows DPAPI 或 keychain。显式 encrypted/Windows store 仍可用作兼容后端。migrateProviderOAuthRegistration 只处理配置引用的 registration ID：新文件已有该 ID（包括 revoked tombstone）即保持其权威，不回读旧 OS 后端；否则持有旧 registration 锁跨过新文件 durable commit。T12-H 将旧 sealed 记录保留为恢复副本，复制或后续清理故障不删除原值。迁移不是远端 revoke；旧备份不是第二个活动 refresh authority，不能覆盖当前撤销或与新 store 同时轮换。

同一进程内，同一 canonical auth 文件的独立 store handle 现在共享 OAuth lifetime/fence；不是按每次 new 出来的 store 对象孤立。一个 handle 撤销会同步封住同文件其他 handle 的旧授权；迟到 refresh 不得向后继账号返回或覆盖结果。三独立 Main 进程的真实 openOAuthSession 测试确认同一 rotating grant 只刷新一次；跨进程每请求重读和文件锁不等于取消另一进程已经发出的生成。

OAuth registration/session 可带可信 profile（旧记录缺省 default），属于不可变 metadata。Main source 校验 grant profile 和 Radius issuer；CLI 默认 profile 不撤销其他 profile，其他 profile 的 grant 不进入本 Main allowlist。Profile-bound source（含 API-key binding）在注册任何 lease 前，必须匹配实际 services.identity.profile；旧不带 profile 的 environment SDK 来源保留。Host epoch 变化继续重绑；不复用序列化 lease。

文件后端 initialize() 用于在启用不可信工具前准备空 auth.json 和 staging。CLI Main 在 env-only 路线也先初始化，否则 Linux ASRT 会忽略不存在的 denyRead 目标。Windows staging 本身去继承并设置 current-user/SYSTEM 可继承 ACL，新建的空文件从一开始就私有；再对实际明文文件去继承。POSIX staging0700/file0600 与 namespace masks 保留。工作区包含配置根时，沙箱不把 auth.json 当目录创建。

DPAPI 与浏览器兼容工具改用明确 SystemRoot 下的系统可执行文件/DLL。独立 Host 现在只转发 owner 实际声明的 providerProbeAuthorization:1，不能由 override 伪造；缺转发曾导致真实 CLI 连接/恢复失败，已有四格 handshake 和真实 Host crash/reattach/idle-exit 回归。文件、Main、Host 的变化不改客户端身份协议；Space 实际迁移仍为 E/F，最终合并全量仍为 G。


## T12-E/F/G 完成：Space 与最终兼容

此节是 A–G 历史验收；新增 T12-H 的来源保持契约见下节，不以这些历史计数替代新验收。

Root 及 Space 的计划内代码缺口已关闭，最终证据优先于前文各切片实施时的 pending 描述。
Space 提交 `065cc39c` 在独立 `codex/provider-credentials-space` 分支：Provider IPC/隐藏输入、
保存状态、迁移和实际 broker 共用真实配置根的 auth.json；API_KEY 仍可用，文件值优先，
删除后外部 env 来源可见，不批量注入保存值。设置/删除必须携带显示时的 binding/revision，
另一端的新写入不能被旧页面覆盖。原生 OAuth/cloud 仍由可信 Main 获取，Host epoch 重新授权。

别名只在可信同路由证明下移动；配置 CAS 在既有 Core 锁中使用原子 staged 写入，写失败
保留旧 config，凭证迁移失败只回滚自己拥有的版本。旧 vault 不可读或 CLI 已有不同值时
显示迁移状态，不能静默改用别处凭证。旧 alias、SDK 入口与 KodaX 原兼容优化保留。

RuntimeClientSecretStore 默认改为同一文件中的保留 namespace；已有稳定身份和 exitRecovery
原值迁移，完整配置根可搬迁恢复，失败不生成新身份；无关 Partner keychain 不变。
Space 的高级原生连接可通过现有 CLI/SDK/config 设置，原表单继续编辑其支持的
OpenAI/Anthropic 字段，认证配置与真实在线验证状态保持区分。

Root 完整18,656、发布包70和Space完整4,498项通过；复审专项、真实第二Node进程与
Windows隔离桌面的Electron Provider IPC均通过，两轴最终无剩余发现。详见
[最终验收与逐项状态](test-guides/FEATURE_302_v0.7.99_TEST_GUIDE.md#t12-efg-final-offline-acceptance-2026-10-31)。
源代码和构建验收不代替服务端权益、macOS/Linux旧vault迁移或生产安装包认证。
两仓版本/锁定Registry依赖未变，正式Space安装包须先锁定包含本契约的发布SDK；
另一线程的在途改动不属于本独立分支测试范围，整合后需重新做相关回归。

## T12-H 来源固定与自动重试（未发布）

Space 自动导入旧 Key 时写应用私有 namespace，保留旧加密项；不同 Space 目录的私有
来源也隔离。首次 legacy/env/shared 来源须成功固定，env 值仍动态读取、不复制到文件。
同根的 CLI 与 Space 可以各用原账号，保存沿当前作用域更新；只有显式发布/采用操作
才选择共享。env 移除、墓碑、并发换号、旧后端锁定和 API/地址改变均不能采用另一账号。
配置编辑前固定原连接；迟到的迁移只能使用自己最初提交的 revision，不能覆盖新选择。

保护文件的格式继续为 v2，旧单记录接口保留。AtomicFileProviderCredentialStore 扩展的
readApiKeys/updateApiKeys 提供一致快照和批量 CAS，任何一项过期都不提交部分变更。
新 profile 的 discovery baseline 避免加载全局 OS 账户，旧 profile 后端不可用会明确失败
并允许后续重试；只有已固定的旧来源可在复制失败时继续使用其原值。OAuth sealed 备份
默认保留，当前 grant/revocation 权威不变。Host、稳定客户端身份及退出恢复边界保持，
legacy 启动值走现有 SDK 升级路径。不可安全自动处理的损坏/缺失材料不会被猜测替换。

H 专项和完整验收单独记入 FEATURE_302 测试指南；两仓交接须采用包含 H 的新提交，
并以 Space docs/handoff/PROVIDER_UPGRADE.md 为接手索引。
Space H独立提交为`437cac7d`。最终Root完整18,659/发布70、Space完整4,531/实际Electron2项
均通过；跨平台实机、生产安装包及原线程后续代码的整合验收仍按测试指南边界执行。

## 审计后续：模型与费用估算边界（2026-11-01，未发布）

公开 SDK 的 `multimodalSupport` 可按模型覆盖连接默认值；省略时保持原继承行为。
原生 Sonnet/Opus 4.6 和 GPT-5.4 的上下文、`outputTokenLimit` 按官方上限更新，
`maxOutputTokens` 仍是原有请求预算。未知模型保留原 provider fallback，用户固定模型 ID
不自动替换。Skill 的通用 haiku/opus 别名分别解析到 Haiku 4.5/Opus 4.8，两入口共用解析器。
依据：[Claude 模型](https://platform.claude.com/docs/en/models/overview)、
[退役与替代](https://platform.claude.com/docs/en/about-claude/model-deprecations)、
[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)。

费率是估算，不是账单。默认 OpenAI `gpt-5.3-codex` 补精确模型条目；GPT-5.4 的
基础价覆盖输入不超过 272,000 tokens 的标准档。`maxPricedInputTokens` 之外，
`calculateCostWithCacheLifetimes` 和聚合统计返回未知，不猜测长上下文整会话或地域附加费。
旧数值 `calculateCost` 为兼容保留，调用方应采用可空计算器/CostTracker 表达这些限制。
[Codex 定价](https://developers.openai.com/api/docs/models/gpt-5.3-codex)、
[GPT-5.4 定价条件](https://developers.openai.com/api/docs/models/gpt-5.4#pricing)。

Claude 已核实模型区分 5m/1h 写缓存。DeepSeek 采用官方 USD 非高峰估算，高峰为两倍；
Flash 支持图片，Pro 为纯文本，两者服务输出上限仍为 384K，默认输出预算不提高。
[Claude 定价](https://platform.claude.com/docs/en/about-claude/pricing)、
[DeepSeek USD 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)。

Kimi 国内公开 API K3.1 使用官方 CNY 价与既有固定 0.14 USD/CNY 估算惯例，标为
`estimate`，不是官方美元价、实时汇率或含税账单。Kimi Code 的 K3.1 条目标为
`nominal`，仅表示订阅使用价值估算；两条路由、精确 ID 和账号选择不合并。
用户费率覆盖保持优先。公开 GLM-5.2 未核实价格继续未知，不借用订阅费率。
[国内价格](https://www.kimi.com/resources/kimi-k3-1-pro-pricing)、
[海外 USD](https://platform.kimi.ai/)、[Coding Plan](https://www.kimi.com/code/docs/en/)。

Chat/Responses 缓存写入属于总输入的互斥子集；读取实际 usage 与响应头的 TTL 分区，
不按本次请求的 TTL 猜测已有缓存寿命。缺失、非法或不完整的分区保留未知，不能当零费率。
[Kimi 缓存计量](https://platform.kimi.com/docs/guide/context-caching#查看缓存读写用量)。

以上为目录、wire 和统计契约，不是账号权益或真实服务实测声明；未增加推理请求。

Claude 5.5 尚未作为完整目录接入公告：不能只补 1M/费率就认为完成。Opus/Sonnet/Haiku
分别有 disabled thinking、forced tool、adaptive/profile 限制；还需有序内容回放、
保留 prefix 的动态工具/effort/system 更新、恢复和账号切换验收。现有签名来源隔离、
thinking display/binding helper 可复用，不能为兼容删除账号隔离。`drop_block` 只是
prefix 不匹配时的恢复措施，可能增加 token/延迟或改变质量，不能声称每轮丢旧推理
仍无智能损失。现有默认模型与用户固定 ID 不切换；未知 ID 的 provider fallback
仍不等于服务已完整验证。依据：[5.5 模型迁移](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)、
[保留 thinking 与 prefix](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、
[动态系统/工具更新](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)。
