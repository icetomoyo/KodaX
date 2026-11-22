# KodaX Runtime/SDK v2：可被编排的单用户 Host

状态：第 4 版修订稿，2026-11-20。边界和 2026-11-14 定稿相同；规格改为按"规则、资源、传输"三层来写，并补上了方法表。用户 2026-11-20 要求按 §7 开始实现。M0 的代码和 ADR-079 已经写完，2026-11-22 在 `KodaX-next-dev` 上分层提交；各节里标"M0 已落地"的段落写的是实际行为。M1a 已经落地（含 REPL 跑在 v2 上），和 M0 一起提交：帧编解码、IPC 首帧区分、握手和 revision 协商、zod 方法定义和漂移测试、Node 无关的客户端核心已经写完并有测试，标"M1a 已落地"的段落写的是实际行为；方法表已有握手三项、只读目录三项（`provider.list`、`command.list`、`skill.list`）、会话七项（`session.list/get/create/archive/unarchive/delete/compact`）、视图三项（`view.subscribe`、`view.unsubscribe`、`item.read`，加上通知 `view.patch`、`view.reset`、`view.closed`；会话视图带这个 Session 的 Workflow）、输入与 Run 十项（`input.submit/get/withdraw`、`run.get/list/wait/stop/startTool/recover`、`session.cancel`）、交互与授权四项（`interaction.list/respond`、`permission.grant.list/revoke`）、设置两项（`session.settings.get/update`）、历史两项（`history.read`、`history.search`）、提升两项（`session.promote`、`session.promotion.get`）和技能学习十二项（`learning.*`，见"记忆与技能学习"），其余按 §7 的顺序逐组加入。2026-11-21 合入了主线 beta.13（本地合并提交 `4b688c8b4`），主线登记的 FEATURE_312（稳定的历史 ID）和 FEATURE_313（Session 的恢复状态）要求先在这份方案里定规格，见"历史两项的落地细节"和"Session 的恢复状态"。FEATURE_312 已经落地。主线推迟了 FEATURE_313，用户决定连同恢复时限一起在 next-dev 上做；它也已经落地，见"Session 的恢复状态"末尾的落地细节。

**这一版改了什么**

- 2026-11-20 用户确认的三项（§11 第 11 条）：
  - 执行策略以 Session 为绑定单位（D12）；
  - 显示项逐项定界，不再共用一份文本预算（D3）；
  - 增加只允许同一主体续期的 `auth.renew`，推翻原先"不做 `auth.refresh`"的决定（D13）。
- 这一版新写、还没有逐项确认的内容：
  - 契约的四种原语和统一保证（D10）；
  - 引用模型（D11）；
  - 方法表（§4.7）；
  - 封闭的 Run 结局类型；
  - 错误码表；
  - 连接生命周期里的心跳、鉴权前限制和关闭原因（D13）；
  - blob 改为分块读写，上下行同一套方法。第 3 版为了简化选了单请求上传，这一版改回分块，理由见 §5 的"blob 传输"。
- 对照最新代码的修订：主线在第 3 版定稿之后合入了一批改动（ADR-078、Issue 412-418、提示词定制、FEATURE_310/311），受影响的条目已经改写，见各节的"现状"说明。

**来源与行号**：第 3 版的来源是 6 份领域调研、3 份交叉评审、1 份综合方案、2 份红队审查和一次对照代码的独立评审，原文在本地 `docs/research/2026-11-14-sdk-v2/`（gitignored）。这一版新增的事实在 KodaX-next-dev `f69df5305` 上核对过，2026-11-21 合入主线之后的部分在 `4b688c8b4` 上核对过。沿用自第 3 版的行号以 `1178550d8` 为准，其间 `sdk-runtime.ts` 改了一千多行，这些行号没有重新核对，M1a 开工前要整体重核。

## 0. 需求与边界

### 需求

用户 2026-11-14 确认，以下都来自现有客户：

- 部署形态：
  - (a) 云端工作区；
  - (b) 本机 Host + 远程 UI；
  - (c) 企业私有部署；
  - (d) 客户后端服务端嵌入，可能没有 UI，也可能不是编码场景。
- 接入方式：TypeScript/Node，以及浏览器直连。
- 版本策略：上 v2 协议，v1 保留一段过渡期后下线。

### 边界原则

**KodaX 交付三样东西**：

1. 一个可被编排的、单用户的 Host 实例；
2. 一份语言中立的 v2 协议；
3. Node 和浏览器两套客户端 SDK。

租户由上层平台管理。对平台来说，每个 Host 都是一个黑盒实例：开通、路由、启停、计量都由平台做。

| 上层平台负责（KodaX 只提供文档和样例） | Host 负责 |
|---|---|
| 租户、账号、IdP/SSO、登录会话 | 校验平台签发的 JWT，确认来者是 owner 或者被允许的 service |
| 给每个用户开通容器或 uid，挂载 home 卷 | 状态全部放在 home 里；单写者；换容器后能恢复 |
| 调度、路由、唤醒、空闲回收 | 常驻；通过 `/healthz` 报告是否可以回收；收到 SIGTERM 时限时收尾 |
| TLS、对外网关、隧道 | 在平台指定的地址监听；没配鉴权就拒绝启动 |
| 按租户的配额、计费、限流 | 自我保护：帧上限、有界队列、blob 配额、Run 预算 |
| 平台自有 LLM key：出口代理注入、按租户计量 | 支持 provider 的 baseUrl 指向代理、使用占位 key；请求带 `X-Session-Id` |
| 出口网络策略（封锁 metadata 地址和集群内网） | 无 |
| 日志汇聚、监控、审计报表 | 把 JSON 结构化日志写到 stdout。谁批准了什么，只有 Host 知道，所以这类安全事件必须由 Host 记录 |

**不做**：

- 进程内多租户；
- 一个 Host 让多个人类用户共享（ACL）；
- 内置 OIDC 登录、BFF 或网关；
- 自建中继；
- launcher 或调度器；
- 跨租户的配额和计费；
- 审计投递。

这些都属于平台的产品能力。做进 KodaX，会和各家客户自己的基础设施冲突。

## 1. 架构与规格分层

```
 浏览器 / 手机 / 客户后端
      │ wss
 ┌────▼──────────────────────────┐
 │ 上层平台（客户自建或其他产品）  │  登录、签发 JWT、TLS、按 homeId 路由、开通和回收 Host、出口代理
 └────┬──────────────────────────┘
      │ ws（集群内网 / 同 Pod / 隧道）              本机 Space / REPL / ACP ── IPC（v1 → v2）
 ┌────▼────────────────────────────────────────────────────────────▼───┐
 │ Host：一个 home 一个 Host，服务一个人类用户，以独立容器或 uid 运行      │
 │  HTTP server（一个端口）：/ (WS v2) · /healthz · /a2a（A2A handle）  │
 │  准入：凭证 → 身份 + 角色 owner|user|service → 方法和参数白名单        │
 │  编解码：v2 JSON-RPC（IPC + WS）| v1（只走 IPC）                      │
 │  领域 handler ← 两套编解码共用                                       │
 │  产品层：Session/Run/Input/Interaction/View/Blob/Workspace            │
 └─────────────────────────────────────────────────────────────────────┘
 进程内库（runKodaX/createAgent）：一个进程只服务一个信任域，不写共享 Session
```

| 形态 | 落法 | KodaX 提供 |
|---|---|---|
| (a) 云端工作区 | 平台为每个用户开通一个容器（StatefulSet，1 个副本，RWOP 卷），浏览器经平台连到 Host | Host、浏览器 SDK、实例契约、容器样例 |
| (b) 本机 Host + 远程 UI | Host 只绑 loopback，用户用 Tailscale serve 或 cloudflared 反代出去；远程 UI 用设备配对令牌接入 | 配对令牌、隧道指南、systemd 和 Windows 任务计划程序样例 |
| (c) 企业私有部署 | 和 (a) 相同，IdP 换成企业自己的，每个员工一个 Host | 同 (a) |
| (d) 服务端嵌入 | 需要持久会话或业务工具时：每个终端租户一个 Host，由客户开通，客户后端以 service 身份连接。只做无状态的一次性调用时：在客户进程里用库，一个进程只服务一个信任域 | Node SDK、service 角色、Host Tool、Session 策略、工具上限 |

### 为什么分三层来写

v1 的契约里固化了三个没有明说的假设。每一个都对应一类系统性的问题：

| 隐含假设 | 在 v1 契约里的表现 | v2 的对策 |
|---|---|---|
| 客户端和 Host 在同一台机器 | 路径是通用引用。约 25 个契约字段带 Host 路径；图片输入只能传路径，Host 直接读盘（`src/runtime-visual-input.ts:69`）；`sessions.create` 接受任意绝对目录，没有包含检查（`src/sdk-runtime.ts:8761`） | 引用模型（D11） |
| 客户端和 Host 属于同一信任域 | 每条连接拿到全部 scope；`authorization` 靠 SDK 过滤，服务端照收（`src/runtime-daemon/server.ts:2478`） | 身份拆分和服务端白名单（D4）、权限链（D12） |
| 只有 Space 一个消费方 | 每个需求各加一个方法、一个能力键、一套自己的做法 | 契约规则（D10）：先规定有哪几种东西、每种遵守什么 |

第三行的具体表现：

- 189 个方法，55 个能力键。
- 两套观察模型：全量视图（`session.view.observe`）和带 `seq` 的事件流（`session.observe`）。workflow 和 learning 另有各自的订阅。
- 幂等至少六种做法：`inputId`、`requestId`、`expectedRevision`、`expectedHead`、指纹、没有。
- 5 种互不通用的 revision（`docs/CLIENT_CONTRACT.md:767`）。
- 30 个错误码，没有统一的错误类型，也没有重试提示。
- 一个 Run 的结局同时由 `phase`、`terminal.kind`、`terminal.code`、`failureDetail`、`error`、`stop.state/outcome` 表达，多数是裸字符串（`packages/coding/src/client-contract.ts:956-1049`）。

所以 v2 的规格分三层，顺序固定：

1. **契约规则（§3）**：契约里只有哪几种交互，每种的保证是什么，错误和演进怎么处理。
2. **资源与引用（§4）**：有哪些资源，怎么引用，谁能做什么，以及方法表。
3. **传输绑定（§5）**：同一份契约怎么落到 IPC、WS 和 SSE 上。

新增一个方法时，先回答它属于哪种原语、作用在哪个资源上。答不出来就不加。

## 2. Host 实例契约

这一节是平台编排者唯一需要读的内容。M1b 时会把它写成一篇公开文档。

### 启动

沿用现有的 `kodax daemon serve`（前台运行，`kodax_cli.ts:3001`），不新增命令。

- 监听地址、鉴权、`workspaceRoot`、工具上限都写在 home 配置里一个独立的 `server` 块中。平台在启动 Host 之前写好这个块。
- **只要配置了网络监听，Host 就自动进入 persistent 生命周期**：
  - 由当前持有 home 的进程执行，做法与 A2A 相同（`kodax_cli.ts:911-935`）；
  - persistent 模式本身已经存在（`management.ts:62/96/317`）；
  - 这样也覆盖了 (b)：Space 拉起的 daemon 不会在 Space 关闭后因为成了孤儿而退出。
- 如果 home 已经被另一个存活的 Host 持有，`daemon serve` 必须以**非 0** 退出。M0 之前是以 0 静默退出，在 systemd 或 K8s 下会被当成正常结束。
  - M0 已落地。有一个例外：SDK 自动拉起的子进程（带 `KODAX_DAEMON_SERVE=1`）仍然以 0 退出。拉起它的一方把 0 理解为"另一个 Host 抢先了"，只有在锁文件里能看到赢家时才容忍非 0。

### 鉴权配置

```
server: {
  listen: {hostname, port} | {socketPath},
  jwt: {issuer, audience, jwksUrl},
  owner: <sub>,
  services: [<sub>…],
  allowedOrigins: [],
  pairing: bool,
  workspaceRoot,
  tools: [...]   // Host 级工具上限
}
```

- `listen`：v2 有自己的监听，不复用 A2A 的监听，因为 A2A 只能绑 loopback（`a2a/server.ts:682`）。地址由平台指定。TLS 由平台或服务网格负责。
- `jwt`：从 A2A 的校验器里抽出"校验一个 token 字符串"的函数。A2A 现在从 Authorization 头里取 token（`a2a/server-auth.ts:175`）。抽出时：
  - **只要求** `iss`、`aud`、`exp`、`sub`，不要求 RFC 9068 的 `typ`、`jti`、`client_id`，这样 Keycloak 和 Entra 默认签发的 token 也能通过；
  - 签名算法用白名单，只接受非对称算法；`exp` 的时钟偏差容忍写成固定值；
  - JWKS 必须走 HTTPS，但允许私网地址，因为这个地址是平台配置的；JWKS 取不到时拒绝新连接，已有连接不受影响；
  - 不要求 `tokenUrl` 和 `requiredScopes`。
- `owner`、`services`、`allowedOrigins`：只有这些身份和来源能连进来。
- `allowedOrigins` 默认为空，也就是拒绝所有浏览器来源。
- `tools`：Host 级工具上限，是权限链的最外层（D12）。每个 Run 都会和它求交集，复用现有的 `intersectExecutionToolCeilings`（`execution-profile.ts:43`）。非编码的 (d) 场景用它去掉 fs 和 bash。
- 只要配置了网络监听而没配鉴权，Host 就拒绝启动。

### 项目来源信任

这部分由主线实现，v2 只负责在实例契约里写清楚，不在 `server` 块里另起一套字段。

- 项目信任按仓库根目录配置，在现有 `execPolicy.trustedProjectRoots` 的基础上扩展。目录别名不能绕过它（主线 Issue 422）。
- 文本来源（项目的 `AGENTS.md`、rules）照常加载。
- 会执行代码的项目来源只对受信任的根目录生效，例如 constructed 工具、skill 和 command 上的 hooks。
- constructed 工具另外需要本机审批记录才会加载，记录在 `<home>/runtime/construction-approvals.json`（主线 Issue 419）。
- Host 级的 `projectSources` 强制关闭开关属于平台控制面（D4）。平台不想让任何仓库执行代码时，就用它关掉。
- 硬规则：工具上限里没有 bash 时，会执行代码的项目来源一律关闭。原因和 stdio MCP 一样：加载这些来源，本身就是在 Host 上执行代码，等于绕过工具上限。

### 配置变更

- 鉴权字段（`owner`、`services`、`allowedOrigins`、`pairing`、`tools`）**热生效**：在下一次握手时应用，同时立即断开不再符合的现有连接。复用 A2A 的配置热加载分类（`kodax_cli.ts:957-984`）。
- `listen` 和 `workspaceRoot` 改动后需要重启 Host。
- 配置里出现不认识的字段时，Host 拒绝启动（失败即关闭）。所以平台回滚镜像时，必须连同配置一起回滚。

### 生命周期

**现状（`f69df5305`）**：主线在 Issue 412-414 和 ADR-078 里改了停止和失败的语义。

- 每个 Stop 都有最终结局。
- 结算无法确认的 Run 不再停在 `unknown`，而是以 `failed` + `actor_settlement_not_persisted` + `effectOutcome: 'unknown'` 结束。所在的 Session 进入隔离，拒绝新的 Run，由 Host 在进程内修复，不需要重启。
- Host 关闭时，如果只是因为隔离中的 Actor 树而失败，按成功关闭处理，由重启后的恢复流程接管。
- 停止前置检查会跳过隔离中的 Actor 和已经被要求停止的工作，所以隔离中的 Session 不会阻止 Host 停止。
- 2026-11-21 合入的主线（`4b688c8b4`）：Issue 428 把 next-dev 的失败码表移到了主线，结算类失败（`actor_settlement_retrying`、`actor_settlement_not_persisted`、`run_settlement_not_persisted`）在 v1 线上一律是 `conflict`，带原来的 `code`。两边现在共用 `RUNTIME_FAILURE_CODES`。同一批里 Issue 427 给 v1 的 Run 句柄加了 `warnings`，提醒调用方 `mode: 'coding'` 和 `agentMode: 'sa'` 已经退役、被忽略。v2 不需要它：v2 的参数是 `.strict()`，没有这两个字段，传了就报 `invalid_params`。

**Session 的恢复状态**（FEATURE_313，2026-11-21 定的规格，按 FEATURE_LIST 里同日记下的 owner 决定）：

- **为什么要有**：Session 被隔离之后在后台自愈，但客户端现在只能反复启动 Run、看报错才知道好了没有。没有可读的状态，没有"恢复结束"或"恢复卡住"的通知。
- **形状**：Session 资源多一个可选字段 `recovery: { state, since, code }`，只在隔离中出现，恢复之后整个字段消失。
  - `state` 是 `recovering`（后台修复在进行）或 `stalled`（超过了时限，修复仍在后台重试）。开放枚举，客户端不认识时按 `recovering` 处理。
  - `since` 是进入隔离的时间（UTC 毫秒）。`code` 是进入隔离的原因，现在只有 `actor_settlement_not_persisted`。
- **读和订阅**：`session.get` 和 `session.list` 的结果带这个字段。会话视图加顶层键 `session`，内容和 `session.get` 的 `session` 相同，所以订阅视图的客户端靠"设置顶层键"就能看到进入隔离、卡住和恢复。
- **通知就是视图里的这次变化**：不另加通知方法。恢复完成是 `recovery` 消失，卡住是 `state` 变成 `stalled`。M2 的 Host 文档里的会话列表带同一个字段，不订阅单个 Session 的客户端从那里看到。
- **被拒绝的命令**：隔离中的 Session 上，`input.submit` 和其他会启动 Run 的命令报 `invalid_state`，`reason` 是 `session_recovering` 或 `recovery_stalled`，和 `recovery.state` 一致。v1 继续用 Issue 428 的 `conflict` 形状。
- **时限也在 next-dev 上做**（2026-11-21 用户改的决定：主线推迟了这部分，整个 FEATURE_313 都在 next-dev 的 v2 重构里做，主线不再单独加时限）：
  - 从进入隔离算起 10 分钟。原定加在 `src/sdk-runtime.ts` 的 `recoverActorDurability`，落地时改了位置，见下面的落地细节。
  - 超过时限之后后台修复继续重试，修好了照样自动解除隔离，`recovery` 字段随之消失。变的只是报出来的状态：`recovering` 变成 `stalled`。
  - v1 沿用 Issue 428 的 `conflict` 形状，超时之前的 `code` 不变，超时之后是 `recovery_stalled`。
- **现有的接入点**：Actor 控制器已经通过 `onHealthChanged` 把每个 Session 的健康变化报给 Runtime（`state` 是 `healthy`、`recovering` 或 `unknown`），隔离对应 `unknown`。实现时把它接到 Session 资源和视图，不需要新的检测逻辑。
- **落地细节**（M1a 已落地，2026-11-21，未经用户确认）：
  - 时限的计时放在新的 `src/session-recovery.ts`，按 Session 记，从第一次报 `unknown` 起算，到点时让会话视图刷新一次。没有放进 `recoverActorDurability`，原因有两个。那个循环按 Run 跑，一个隔离中的 Session 可能有好几个 Run 在修，也可能一个都没有。它的退避最长 30 秒，放在里面会晚报卡住。后台重试仍然由 `recoverActorDurability` 做，没有改。
  - `recovering` 只对应 `unknown`。健康树里一次保存的短暂重试也报 `recovering`，但那不是隔离，不出这个字段。
  - `since` 只记在内存里，Host 重启之后从重新进入隔离算起，时限也重新计。
  - v1 的 `ClientSession` 带同样的 `recovery`，`since` 是 ISO 时间字符串；桥接层换成 UTC 毫秒。`sessions.load`、`sessions.list` 和 v1 视图的 `session` 都带它。
  - 启动 Run 时被拒，v1 是 `conflict`，`data.conflict` 在时限之前是 `actor_settlement_not_persisted`，之后是 `recovery_stalled`。桥接层把这两个分别换成 `invalid_state` 和 `session_recovering`、`recovery_stalled`。
  - 已知的缺口：直接对 Actor 发的命令被拒时，Actor 控制器报的仍是 `actor_settlement_not_persisted`，超过时限也一样，所以 v2 看到的是 `session_recovering`。客户端以视图里的 `recovery.state` 为准。
  - 视图里的 `session` 带 `project` 时，按订阅时那个连接的工作区算，和 `session.get` 一样；没有工作区的连接不带 `project`。

M0 之前的关闭顺序是先关传输层，再关 Runtime，所以客户端在断开之前看不到自己的 Run 怎么结束。M0 改成下面的顺序（`src/runtime-daemon/host.ts`、`src/runtime-host-close.ts`）：

1. **先停 Run，传输层保持打开**。
   - Host 让 Runtime 停止接收新工作，并且按 `close()` 的原有语义停止或挂起在途的 Run：已到检查点的 Run 挂起等待恢复，不写用户 Stop。
   - 这一步最多等 10 秒，是 Runtime 在这条路径上已有的两个上限之和（等 Run 到达检查点 5 秒，等被取消的 Run 确认 Actor 结束 5 秒）。
   - 这段时间里，Run 的事件照常发给已有的订阅；新的请求（包括读请求）得到 `conflict`，文案说明 Host 正在关闭。
   - 到时间还没有结算的 Run 记一条警告日志，留给重启后的恢复流程，和以前一样。
2. **再关传输层**。服务端先把每条连接上已经排队的帧发完，再断开；不读数据的客户端等 2 秒后强制断开。
3. **最后关 Runtime**，顺序不变。

**时间**：

- 客户端拿到 Run 状态：停 Run 开始后最多 10 秒，加上冲刷的最多 2 秒。
- `daemon serve` 收到停止信号后，Host 关闭这一段有一个总截止时间 90 秒。超过后放弃 Host 关闭，进入原有的进程清理，以退出码 1 结束。
- 进程清理沿用原有的 160 秒上限（ASRT 工作区队列排空和记忆审阅落盘）。
- 所以最坏情况下，从 SIGTERM 到进程退出约 250 秒。
- **不承诺小于 K8s 默认的 30 秒宽限期**。平台把宽限期设成不小于这个最坏值，就不会出现 SIGKILL；设得更短也安全，被提前杀掉的 Host 在下次启动时从 home 恢复，沿用现有的回执语义。15 到 20 秒的宽限期通常已经够客户端拿到 Run 状态。

**还没有做**：

- 关闭前给客户端发"Host 正在排空"的通知，以及带原因的关闭帧，属于 D13，在 v2 上实现。v2 里这段时间的拒绝用 `unavailable`。M1b 第 1 项已经给网络连接做了（`host.draining` 通知、4503 关闭帧），IPC 上的连接还没有。
- 总截止时间只加在 `daemon serve` 的停止信号路径上。通过 `daemon.stop` 或嵌入方直接调用的 `host.close()` 没有总截止时间。
- IPC 上的管理面排空开关在这段时间里没有打开，新的 IPC 客户端仍然可以完成握手，之后的请求得到上面的 `conflict`。网络监听在排空开始时就拒绝新的升级请求（503）。

### 健康检查

`GET /healthz` 和监听共用一个端口，返回：

```
{state: starting|ready|draining, canStop, blockers, lastActivityAt}
```

- `ready` 时返回 200，`starting` 和 `draining` 时返回 503，方便直接接到 K8s 探针上。
- `canStop` 和 `blockers` 直接复用现有的停止前置检查（`management.ts:238-246/341/400-408`），它已经包含了在途 Run、待回答的交互和后台工作。
- 平台据此决定能不能回收这个 Host。
- 返回内容不包含任何会话内容信息，所以不需要鉴权。(b) 经隧道暴露时，它只泄露"有一个 Host 在运行"。

### 等待中的交互

- 待回答的提问和审批是否等人，由 Session 决定（D12 的 `interactions`），复用现有的 `permissionTimeoutMs` 和 `userInputTimeoutMs`（`sdk-runtime.ts:949-951`）：
  - `reject`：立即拒绝。service 创建的 Session 默认是这个值；
  - `wait`：等待一个有限的时长，默认 30 分钟，平台可以修改。人创建的 Session 默认是这个值。
- 第 3 版按提交者的角色来定。那样的话，后端创建、人来使用的会话里，后端提交的 Run 会立即拒绝审批，即使用户就在线上。
- 现在 `userInputTimeoutMs` 默认为 0，也就是永不超时（`kodax_cli.ts:3018`），一个没人回答的提问会让容器永远无法回收。
- 契约里写明：平台在 `blockers` 不为空时强行 SIGTERM，等待中的 Run 会以不确定的结局结束，提问也会丢失。

### 状态与锁

- 所有状态都在 home 里。
- 平台必须保证同一个 home 同一时刻只有一个 Host，用 RWOP 卷或等价手段。禁止多节点共享 NFS。
- 锁的存活判断已经按进程启动身份做了：`state.ts:734-758`，Linux 上读 `/proc/<pid>/stat` 的 starttime，能识别 pid 复用。
- 剩下一个洞：容器重启后 PID 命名空间变了，旧 pid 如果恰好对应另一个 uid 的进程，`kill` 会返回 EPERM，被判为 `unknown`，锁永远回收不掉（`state.ts:741-750`）。
  - 修正：锁记录里加上 PID 命名空间标识（`readlink /proc/self/ns/pid`）。命名空间不同，就直接判定旧持有者已不存在。M0 已落地。
  - 这依赖上面"一个 home 一个 Host"的保证。反过来说，任何从另一个 PID 命名空间访问同一个 home 的进程，都会把存活 Host 的锁当成已经失效。宿主机上的 CLI 和容器里的 Host 不能共用一个 home。
  - 这个标识只存在锁记录里，不进 v1 的线上结果，也不进客户端退出回执。
  - 还没覆盖的情况：`daemon.json` 留下而锁记录丢失时，仍然按原来的规则判为不健康；旧 Host 的退出回执在锁被替换之后无法确认进程状态，只影响那个客户端的退出恢复，不影响 Host 启动。

### 资源上限

- 在 `initialize` 结果的 `limits` 里宣告，包括：帧上限、blob 分块大小、单个 blob 上限、home 内 blob 总配额、出站队列上限、反向调用超时、空闲超时、单个显示项的文本上限、默认 Run 预算。
- 超出上限时返回明确的错误，不做静默截断。

### 日志

服务模式下向 stdout 写 JSON 行。以下安全事件必须记录：

- 鉴权失败；
- 权限决定：谁、在哪个 Run、对什么、批准还是拒绝；
- 特权参数的使用，包括 Session 策略的创建和修改；
- 配对设备的签发和吊销。

### LLM 凭证

- **用户自带的 key**（本机或 BYOK）：沿用现有的配置和环境变量。bash 会继承 provider key（`bash.test.ts:1054` 是有意的设计），用户自己的 key 对自己可见，可以接受。
- **平台自有的 key 不能放进 Host 容器**：放在环境变量里会被 bash 继承；放在同一个 uid 的文件里，bash 能直接 `cat`；Host 自己的环境变量，同 uid 的进程可以从 `/proc/<pid>/environ` 读到。平台有两种做法：
  - **出口代理**：provider 的 baseUrl 指向代理，Host 里只放占位 key。按租户计量和限额也在这里做。Provider 请求带根会话的 `X-Session-Id`（主线 Issue 416），代理可以按会话对账。
  - **凭证租约**：service 角色通过现有的 `credential: scoped` 绑定，在内存中下发凭证（`client-host-authorization.ts:240`）。
- 凭证租约有一个限制：它只对"由可信角色提交的 Run"生效，因为租约按 Run 绑定，反向调用只发回提交者自己的连接（D12 的"现状"）。(a)(c) 里 Run 由浏览器用户提交，在 Session 级租约绑定（M1b）落地之前，只能用出口代理。
- 待核实：托管时用到的 provider 是否都支持自定义 baseUrl 加占位 key。

### 版本兼容

- Host 必须能打开上一个版本写过的 home。持久格式只增加字段，不修改字段。
- UI 和 Host 的版本差异靠协议协商处理（D9）。
- v2 对未知参数一律报错（D2），因此"旧 Host 静默忽略新的安全参数"这种情况不会发生。

### 容器样例

- Dockerfile 用 `tini` 或 `--init` 作为 PID 1，否则 bash 工具留下的孙进程会变成僵尸进程。
- 提供 StatefulSet 样例。
- 提供平台签发 JWT 的最小样例，写明需要哪些 claim。

## 3. 第一层：契约规则

### D10 四种原语

契约里的每个方法只能属于下面四种之一。每种的保证是固定的，不逐个方法另行约定。

| 原语 | 用途 | 固定保证 |
|---|---|---|
| 查询 | 读资源 | 没有副作用，可以任意重试。列表统一返回 `{items, nextCursor?}`。带等待的查询必须有等待上限 |
| 命令 | 表达意图 | 必须带 `requestId`。返回回执。同一个 `requestId` 重发，返回原回执；内容不同则报 `conflict` |
| 订阅 | 跟随一份文档 | 先发快照，再发有序的 patch。patch 可以丢，丢了就补发快照。全协议只有这一种机制 |
| 宿主请求 | Host 向参与方要东西：审批、提问、工具调用、凭证 | 有明确的应答方和期限。只结算一次。应答方不在场时，结局是确定的 |

v1 里的各种做法都能归进来：

- `runs.await`、`agents.wait` 是带等待上限的查询。现在 `run.await` 没有超时（`server.ts:2116-2123`）。
- 会话视图、事件流、workflow 订阅、learning 订阅是同一种订阅，区别只在跟随哪份文档。
- 审批、提问和反向调用是同一种宿主请求。区别只在应答方：审批和提问广播给所有人类连接，反向调用定向发给持有租约的连接。

### 命令与回执

- **"已受理"不等于"已完成"**。回执只说明 Host 记下了这个意图，并给出它产生的资源 ID（`inputId`、`runId`、`sessionId`）。结果通过订阅或查询去看。这条规则 v1 已经在 Stop 上用了，v2 推广到所有命令。
- **`requestId` 的作用域是授权身份**。带 `sessionId` 的命令在该 Session 内判重，不带的在 Host 内判重。
- **重试安全是契约层的保证**，实现沿用各领域已有的回执（持久化的 pending-inputs、session-stops、CAS），不新建通用账本。主线曾经删除过通用的 operation envelope（`docs/CLIENT_CONTRACT.md:649`）。
- **要补的缺口**：
  - 立即启动的输入只在 Host 的一次启动内判重。云端形态下 Host 重启是常态，判重要能跨重启。M1a 已落地，见下一条。
  - `memory.remember` 现在重试不安全，不补：旧记忆面整个由 FEATURE_309 删除，见"记忆与技能学习"。`workflow.start` 已经补上，见"Workflow 的落地细节"。`session.create`、`session.compact` 已经补上，见下面两条；`session.fork` 和 `session.recover` 用的是 `session.create` 的办法，见"分叉、回退、恢复和侧聊的落地细节"。`command.execute` 的重试规则见"输入与 Run 的落地细节"里它自己那条：Host 直接做完的命令只在 Host 的一次启动内判重。
- **`session.compact` 的重试安全**（M1a 已落地，2026-11-21，未经用户确认）：
  - 做在 runtime 领域里，v1 和 v2 都受益。v1 的 `session.compact` 多了一个可选的 `requestId`。
  - `requestId` 记在这次压缩写进会话谱系的那条压缩记录上，和压缩本身一起提交。所以不需要账本，Host 重启之后也认得。
  - 同一个请求重发，用那条记录里的数字作答，不再调用模型。这一步在"Session 是否空闲"的检查之前，所以压缩之后 Session 又开始跑了，重发照样得到答复。
  - 第一次还在压缩的时候同一个请求又到了：等第一次结束，再用同样的办法作答。两次得到同一个结果，模型只被调用一次。
  - 判重只看 `requestId`，不比对内容。
  - 没有压缩成（对话太短，或者摘要失败）不留记录，同一个 ID 再发会重新试一次。
  - 保证的期限是那条压缩记录还在谱系里的期间。分叉出来的 Session 不继承这个 `requestId`。
- **`session.create` 的重试安全**（M1a 已落地，2026-11-21，未经用户确认）：
  - 做在 runtime 领域里，v1 和 v2 都受益。v1 的 `session.create` 多了一个可选的 `requestId`。
  - Session ID 由 `requestId` 确定地算出来（`sha256("session.create:" + requestId)` 的前 32 个十六进制字符），所以判重不需要账本：查这个 ID 的 Session 在不在就行。
  - Session 的 `runtimeInfo.creationRequest` 存 `{requestId, digest}`，`digest` 是请求内容的规范化 JSON 的 sha256。同一个请求重发，返回原来的 Session，Host 重启之后也一样；内容不同报 `conflict`。
  - `requestId` 和 `sessionId` 不能同时给（`invalid_params`），因为 ID 由 Host 决定。
  - v2 桥接层把 `requestId` 加上授权主体前缀再交给 runtime，所以两个主体用同一个 `requestId` 互不相干；owner 和 user 是同一个人，共用一个主体。
  - Session 被删除之后，同一个 `requestId` 再来会重新创建。删除是明确的意图，这里不为它留墓碑。
- **输入的重试安全跨 Host 重启**（M1a 已落地，2026-11-21，未经用户确认）：
  - 做在 runtime 领域里，v1 和 v2 都受益。原来有两处原因让重启之后认不出同一个输入，都已经改掉。
  - 第一处：立即启动的输入，Run ID 原来由 `(Host 本次启动的 ID, sessionId, inputId)` 算出，重启后同一个输入会算出另一个 Run。现在只用 `(sessionId, inputId)`。
  - 第二处：从磁盘恢复 Run 记录时丢了它回答的是哪个输入（`productInput`）。现在保留。
  - 效果：同一个输入重发，返回原来的 Run，不会跑第二次；Host 在 Run 中途停掉再重发也一样。同一个 ID 换了内容报 `conflict`。
  - 保证的期限是 Run 记录还在的期间。Run 记录被清理之后，同一个 ID 会被当成新输入。
  - v2 的 `input.submit` 直接把 `requestId` 当作输入的 ID。客户端收到 `unknown_outcome` 之后，用自己发出的那个 ID 调 `input.get` 就能查到结果。
  - 输入的 ID 在一个 Session 内唯一，不按授权主体分开：它会出现在各方共享的视图里（`inputIds`），加前缀会让视图里的 ID 和客户端发出的对不上。
- **表达状态的命令天然幂等**（M1a 已落地，未经用户确认）：`session.archive`、`session.unarchive` 在 runtime 里改成"已经是这个状态就什么都不做"；v2 的 `session.delete` 在 Session 已经不存在时返回成功。它们的 `requestId` 不需要回执存储。
- **`requestId` 只表示命令的意图**（未经用户确认）：`request.cancel` 的参数从 `requestId` 改名为 `id`，指 JSON-RPC 的请求 id。漂移测试检查：一个方法带必填的 `requestId`，当且仅当它是命令。
- **条件写**：需要防止覆盖的命令带 `ifRevision`。资源的 `revision` 是不透明字符串，不匹配时报 `conflict`。
- **不确定的结局**：命令的效果无法确认时，报 `unknown_outcome`。客户端用原来的 `requestId` 查回执，不能换一个新 id 重发。
- 浏览器 SDK 把还没确认的 `requestId` 存在 storage 里，重连后查回执。
- 不承诺响应和 patch 的先后顺序。客户端按 ID 把两者对上，例如显示项上的 `inputIds`。

### D3 订阅：一种机制，多份文档

**决定**：

- `view.subscribe` 取代现有的两套 observe 模型，以及 workflow 和 learning 各自的订阅。
- r1 只有一种文档：会话视图。M2 加 Host 文档，内容是会话列表的实时状态和跨会话的待处理事项，取代第 3 版的 `sessions.watch`。新增文档种类不是新机制。
- 每次订阅（包括重连后的重新订阅）先发一份快照，之后发 patch。
- 每个 Session 每个 tick 只做一次 diff、编码一次，然后分发给所有订阅者。沿用现有的 80 毫秒合并（`src/session-view.ts:389-403`）。

**顺序和重同步**：

- patch 带 `seq`，在一个订阅内连续递增。客户端发现断档就重新订阅。
- 快照和 patch 都带 `epoch`。`epoch` 变化表示显示项的身份空间被重建了，客户端要丢掉本地缓存，包括窗口外的旧项和自己累积的全文。Host 重启一定会换 `epoch`。会话内的重写（rewind、压缩）是否换，M1a 对照代码确定。

**同步操作和数据模式分开**：

- 同步操作只有四种，r1 之后永久冻结：整项放入、整项移除、向某个字段追加文本、设置某个顶层键。
- 数据模式在这四种操作之下演进。新增顶层键时，旧客户端忽略不认识的键；新增显示项类型时，旧客户端按文本显示（D9）。这样加功能不需要加操作。
- 文本不是只追加的：provider 重试会替换或移除已经发出的文本。这种情况用整项放入表达，追加操作只用于真正的追加。

**逐项定界**（2026-11-20 确认）：

- **现状**：整个视图共用一份 128K 的文本预算，每帧从最新项往回重算。新项变长，旧项会被压回 256 字符的预览（`src/session-view.ts:769-796`）。在这上面做 diff，旧项会不停地变化。
- **改为**：一个显示项怎么表示，只取决于它自己。
  - 每项有固定的文本上限，被截断时带上全文长度；全文用 `item.read` 分页读。
  - 正在生成的项和已经结束的项可以有不同的上限，但都只取决于项自己的状态。
  - 具体上限在 M1a 用真实会话测量后确定，通过 `limits` 宣告。
- 窗口成员单独管理：视图保留最近 150 项，被挤出窗口的项用整项移除表达。
- 这会改变 Space 现在看到的截断行为。

**M1a 的落地细节**（2026-11-21，未经用户确认）：

- **上限**：每项文本 6144 个 UTF-16 单元，工具输入 2048 个。
  - 上限目前没有放进 `limits`：客户端不需要知道上限也能工作，项带 `textTotal` 就说明被截断了。等有客户端真的要用再加。
  - 依据是 3230 个本地会话的实测：助手文本超过 8192 的占 0.92%，思考占 9.06%，工具输出占 10.40%；工具输入超过 2048 的占 2.26%。
  - 没有取 8192：150 项全满、每个单元都按 JSON 转义的最坏情况（6 字节）算，8192 + 2048 会超过 8 MiB 的帧上限，6144 + 2048 是 7.4 MB，不用逐帧检查就能保证装得下。
- **截断方向**：文本保留结尾，工具输入保留开头。两者都带全文长度（`textTotal`、`tool.inputTotal`）。
- **截断起点落在 3072 的整数倍上**：正在增长的文本，起点每长 3072 个单元才移动一次，两次移动之间的变化都是纯追加。结束之后的项用同一条规则，所以一个项怎么表示只取决于它自己的文本，结束的那一刻显示不会跳。被截断的项显示 3073 到 6144 个单元。
- **v1 不变**：v1 的视图继续共用 128K 预算。v1 每次变化都重发整份视图，改成逐项定界会让每帧从最多 128K 涨到中位数 248K、最大 555K。v1 的 `session.view.observe` 多了一个可选参数 `bounds: 'item'`，v2 的桥接层用它；带这个参数时视图多一个 `epoch` 字段。这推翻了 §8 里"v1 客户端也会看到逐项定界"的说法，Space 现在看到的截断行为不变。
- **`epoch`**：不透明字符串。Host 每次为一个 Session 建立视图状态时新生成（重启之后必然不同），rewind 和切换分支时换，压缩不换。
  - rewind 之后留下来的项 ID 不变，但整项移除说不清一个项是滑出了窗口还是离开了这条分支，窗口外的旧项也没法逐个移除，所以让客户端整体丢弃。
  - 压缩不重建显示项，项和 ID 都保留。
  - 同一个订阅里 `epoch` 变了，Host 发 `view.reset`。
- **顺序规则**：订阅的应答是位置 0。之后每条 `view.patch` 和 `view.reset` 的 `seq` 加 1。patch 只有在 `epoch` 相同并且 `seq` 正好是下一个时才能应用，否则重新订阅；`view.reset` 直接替换本地副本和位置。
  - Host 保证应答先于这个订阅的任何通知到达：应答写出去之前到的变化先留着，写出去之后再发。连接层为此给方法处理器加了一个"应答发出之后执行"的钩子。
  - 客户端看到的内容没有变化时（比如只有契约之外的字段变了），Host 不发帧，`seq` 也不动。
- **四种操作的精确含义**：
  - 整项放入：放在 `before` 指的项前面，不带 `before` 就放在最后；同 ID 的旧项先拿掉。
  - 整项移除：按 ID。
  - 追加：只对 `text` 字段；项带 `textTotal` 时同步加上追加的长度。
  - 设置顶层键：不带 `value` 表示删除这个键，`null` 是普通的值。Host 发出的键是封闭的，按契约裁剪，和快照一样。
  - 应用是全有或全无的。操作指向本地没有的项，或者客户端不认识这个操作，结果都是重新订阅，不会悄悄忽略。
- **订阅 ID 由客户端给**：`view.subscribe` 的参数里带 `subscriptionId`。同一个 ID 再订一次，替换原来的订阅并重新发快照。同一个 ID 上的订阅和退订由 Host 排队依次执行，所以上一次还没应答时再订也可以，不会报错。
- **`view.unsubscribe` 归为订阅原语**，不是命令：它不带 `requestId`，按订阅 ID 天然幂等，订阅不存在也返回成功。
- **`view.closed`**（新增的通知）：Host 主动结束订阅时发，带 `reason`。客户端可以重新订阅，Session 不在了会得到 `not_found`。
  - `unavailable`：Session 被删除或者被 Host 释放。
  - `internal`：某一份视图不符合契约。Host 记一条诊断并结束订阅，不让客户端停在旧内容上而不自知。
  - 订阅还没应答就被 Host 结束的，`view.subscribe` 本身报 `unavailable`，不发 `view.closed`。
  - v1 的"观察暂时中断"状态（`interrupted`）目前没有带到 v2。
- **r1 的顶层键**：`session`、`runs`、`queue`、`interactions`、`settings`、`activity`、`contextBudget`、`parentContextTokens`、`sandbox`。
  - `interactions` 是这个 Session 正在等人回答的提问和审批，形状和 `interaction.list` 的条目相同。
  - `settings` 是这个 Session 实际生效的设置：Session 自己选的，加上没选的那些项的 Host 默认值。形状和 `session.settings.get` 的 `settings` 相同，含义不同（见"设置的落地细节"）。
  - `session` 的形状和 `session.get` 的 `session` 相同，带 FEATURE_313 的恢复状态（见"Session 的恢复状态"）。
  - `activity` 是从 v1 照搬的（去掉了带 Host 路径的 `workflow`），r1 冻结之前要再过一遍。
- **只有本机 owner 能看到的字段**：附件的 `path`、`sandbox.degradedReadRoots`。工具完整输出的保存路径对谁都不暴露，只给一个布尔值 `tool.outputSaved`，内容用 `item.read` 读。
- **显示项的状态**：`live` 表示还会变，`settled` 表示只有历史被改写时才变。工具项看它自己的状态（运行中、等待审批）；输出项要同时满足"还是草稿"和"所属的 Run 还在跑"，因为中断的 Run 留下的草稿在恢复之后仍然标着草稿。
- **v1 里有、v2 显示项没有带的字段**：`historyBoundary`、`taskResult`、`sidecar`、`icon`、`compactText`、`outputId`、`textRevision` 等。`icon`、`compactText`、`sidecar`、`textRevision` 不带，提示类的项改带 `notice.kind`（见"REPL 切到 v2 的决定"）。另外三个要在后面的分组里决定去留：
  - `historyBoundary`：v1 的 fork、rewind、retry 用它定位。v2 不带它：`history.resolveTurn` 接受显示项 ID，返回一个不透明的轮次引用（M1a 已落地，见"分叉、回退、恢复和侧聊的落地细节"）。
  - `taskResult`：结构化的任务卡片。
  - `sidecar`：验证结论和投递方式。
- **显示项 ID 不符合通用 ID 规则**：它由 Session、输出和 provider 的调用 ID 拼成，带冒号，长度上限放到 512。老数据里可能有重复的 ID，桥接层给重复的加后缀。
- **`item.read`**：参数 `{sessionId, itemId, part?, cursor?}`，`part` 是 `text`、`input` 或 `output`；结果 `{text, total, nextCursor?}`。游标里带着文本的修订号，分页途中文本被替换就报 `resync_required`。项不存在报 `not_found`（v1 返回 null），游标不是 `item.read` 给出的报 `invalid_params`。每页最多 64K 个单元。被加了后缀的重复 ID 读不到全文，报 `not_found`。附件字节在 M1b 的 `blob.read` 之前，非 owner 的客户端读不到。
- **diff 目前按订阅各算一次**，没有做到"每个 Session 每个 tick 只算一次、编码一次"。一个 Session 的订阅者通常只有一到三个，一次 diff 是对最多 150 项的比较，先不做共享。订阅者多了再把 diff 移到 Session 一侧。
- **ID 稳定性**：有输出 ID 的文本、工具调用、用户输入、Run 范围的提示，从第一个增量到提交到重启，ID 都不变。没有输出 ID 的流式文本在提交时会换 ID，表现为一次移除加一次放入。

**背压**：

- M1a 已落地：patch 不排队也不丢。连接拥塞时 Host 不发 patch，每个订阅只记住最新的一份视图；排空之后和客户端手里的副本算一次差量，照常作为一条 `view.patch` 发出去。
  - 原方案是"丢掉 patch、排空后用 `view.reset` 补发快照"。Host 知道客户端手里是哪一份（已经发出去的帧一定按顺序到达），所以差量总是成立的，而且不会比快照大。`view.reset` 只在 `epoch` 变化时发。
  - 传输层把"是否拥塞"和"已经排空"两个信号交给 v2 的连接，v1 的 `pendingViews` 不变。
- 响应和宿主请求不能丢：超过硬上限时，以 `overloaded` 断开连接。M0 之前除视图以外的帧没有上限。
  - M0 已在 IPC 上落地：上限是 8 个最大帧（64 MiB）。每次写入后检查 socket 的待发字节数，超过就记一条诊断并销毁这条连接。IPC 上客户端看到的是连接断开；带原因的关闭帧属于 D13，在 WS 上实现。

**否决**：

- `since` 增量续订：Host 不保留 patch 历史（`sdk-runtime.ts:10268`）。
- 可续传的事件日志：工作量是 L 级，而视图有窗口上限，重拉快照的代价可以接受。

### 宿主请求

| | 审批和提问（Interaction） | 反向调用 |
|---|---|---|
| 应答方 | 人：任何 `person` 身份的连接 | 机器：持有租约的那条连接 |
| 送达 | 作为会话视图的一部分广播 | 定向通知 `lease.request` |
| 结算 | `interaction.respond`，首个有效回答生效，之后的回答得到 `already_resolved` | `lease.complete` |
| 期限 | 由 Session 的 `interactions` 决定（§2） | `limits.reverseCallTimeoutMs` |
| 应答方不在场 | 到期按拒绝结算 | 工具调用：未派发的到期后记为未派发；已派发的记为结局不确定。凭证：立即失败 |

- 请求有自己的 ID，结算是一条带这个 ID 的命令。这样连接断开重连之后仍然可以结算，不依赖某一条连接上的请求响应配对。
- service 不能回答人的审批（M0 已落地，`src/runtime-daemon/access.ts`；v2 上同样报 `forbidden`）。
- 重连后，持有 Host Tool 租约的一方用 `lease.pending` 取回还没结算的请求。凭证请求在断线时已经失败，不需要取回（见"凭证租约的落地细节"）。

### 错误模型

错误统一为 JSON-RPC 的 `code` 加 `data: {kodaxCode, reason?, retryable, retryAfterMs?}`。`kodaxCode` 是封闭集合，按"客户端该做什么"来划分。`reason` 是开放的字符串，只用于展示和排查。

| kodaxCode | 含义 | 客户端动作 |
|---|---|---|
| `invalid_params` | 参数不合法，含未知字段 | 修正请求 |
| `method_not_found` | 方法不存在，或者这条连接不能调用 | 按 `initialize` 的 `methods` 判断，不重试 |
| `unauthorized` | 凭证无效或已过期 | 重新取凭证 |
| `forbidden` | 角色、锁定项或工具上限不允许 | 不重试；`reason` 说明是哪一种 |
| `not_found` | 资源不存在 | 不重试 |
| `conflict` | `requestId` 被另一个意图占用，或者 `ifRevision` 不匹配 | 重新读取后再决定 |
| `invalid_state` | 资源当前的状态不允许这个操作，例如 Session 在隔离中（`reason` 是 `session_recovering` 或 `recovery_stalled`） | 等状态变化后再试 |
| `resync_required` | 客户端持有的游标或选择已经过期 | 重新读取或重新订阅 |
| `limit_exceeded` | 超过帧、blob、配额或预算上限 | 不改请求就不要重试 |
| `overloaded` | Host 过载 | 按 `retryAfterMs` 退避后重试 |
| `unavailable` | Host 正在启动或排空，或者绑定的租约不在线 | 稍后重试 |
| `timeout` | 带等待的查询到了上限 | 可以立即重试 |
| `cancelled` | 请求被取消 | 无 |
| `unknown_outcome` | 效果无法确认 | 用原 `requestId` 查回执，不能换 id 重发 |
| `internal` | Host 内部错误 | 报告，不自动重试 |

SDK 导出一个统一的错误类型。客户端不解析错误文本。

**M1a 已落地**（`src/host-protocol/codec.ts`、`client.ts`）：

- JSON-RPC 的 `code`：`invalid_params` 用 -32602，`method_not_found` 用 -32601，`internal` 用 -32603；其余 12 个按上表顺序占 -32001 到 -32012。读不出来的帧用 -32700，不是合法消息的帧用 -32600，两者的 `kodaxCode` 都是 `invalid_params`。
- 默认只有 `overloaded`、`unavailable`、`timeout` 的 `retryable` 是 `true`，其余是 `false`。
- 对端发来不认识的 `kodaxCode`（对端更新）时，按 `internal` 处理，原值放进 `reason`。
- Host 只把有意抛出的协议错误原样发给客户端。其他失败，以及不符合结果 schema 的返回值，客户端只看到一条不带细节的 `internal`，细节进 Host 的诊断日志。
- 连接断开时客户端这样结算：
  - 已经发出、还没收到应答的请求报 `unknown_outcome`（`reason: connection_closed`）；
  - 断开之后再发的请求报 `unavailable`；
  - 握手期间断开、连不上，都报 `unavailable`，因为握手不改变 Host 上的任何东西；
  - 握手超时报 `timeout`。
- 取消：客户端的信号中止后，发 `request.cancel` 通知，然后继续等 Host 的应答，因为只有 Host 知道请求做到了哪一步。发出之前信号已经中止的，不发送，直接报 `cancelled`。
- 超过 `limits.maxFrameBytes` 的请求在客户端就被拒绝（`limit_exceeded`）。发出去的话 Host 会断开整条连接，连带丢掉其他在途请求。

### D9 协商与演进

**协商**：

- 宣告 `protocol: 'kodax/2'`，带一个单调递增的 `revision`，再加不超过 12 个描述部署差异的 feature。
- 协商是双向的：客户端在 `initialize` 里报自己支持的最高 `revision`，Host 回复双方都支持的最高值，之后双方只使用这个 revision 之内的内容。
- 不比较 semver。
- 调用不认识的方法时返回 `method_not_found`，取代 `daemon_upgrade_required`（约 26 处）。
- `initialize` 的结果给出这条连接可以调用的方法列表（`methods`）和对它生效的锁定项（`locks`）。客户端按这两项决定显示什么，不按角色名分支。

**演进规则**：

- Host 对输入严格：未知字段报 `invalid_params`（D2）。
- 客户端对输出宽容：忽略不认识的字段。
- **供展示的枚举是开放的**，契约必须写明不认识时怎么回退。例如：不认识的显示项类型按文本显示，不认识的 `reason` 按通用原因处理。主线已经有先例：不认识的 resync reason 按 `source_changed` 处理（`docs/CLIENT_CONTRACT.md:734`），所以新增 reason 不需要升能力键。
- **供决策的枚举是封闭的**，例如 Run 的 `status` 和 `kodaxCode`。新增值必须升 `revision`，并且给出对旧 revision 的降级值。
- 每个方法的 `params` 和 `result` 对象里预留一个 `_meta` 字段，用来放追踪上下文之类的旁路信息。参数对象是 strict 的，结果对象是封闭的，不预留就没有地方放。
  - M1a 已落地。原稿写的是放在信封里；JSON-RPC 2.0 的信封只有 `jsonrpc`、`id`、`method`、`params`、`result`、`error` 这几个成员，加字段会让通用的 JSON-RPC 库拒收，所以放进 `params` 和 `result`，和 MCP 的做法一样。
  - 漂移测试检查每个方法都预留了它；对未知字段的检查见 D2。

**适配器**：

- ACP 和 A2A 不在关键路径上。
- A2A 在容器形态下挂到 `/a2a`，在那之前只供本机使用。
- ACP 等 M2 有了 ToolFacts 再迁移。

### 通用约定

- **ID**：字符集 `[A-Za-z0-9_-]{1,128}`，和主线 Issue 417 对 Host 会话 id 的校验一致。Host 生成的会话 id 是 UUIDv7。客户端提供的 `requestId` 和 `inputId` 用同一个字符集。
- **时间**：UTC 毫秒整数，字段名以 `At` 结尾。v1 里数字和 ISO 字符串混用。
- **分页和偏移**：一律用不透明游标。长度只作显示提示，单位是 UTF-16 码元，在字段文档里注明。这样其他语言的客户端不需要换算偏移。
- **版本**：全协议只有三个相关概念，互不混用。
  - 协议 `revision`：整数，只出现在 `initialize` 里。
  - 资源 `revision`：不透明字符串，只用于 `ifRevision`。
  - 订阅 `seq`：整数，只用于判断 patch 是否连续。
- **命名**：`<资源>.<动词>`，资源名用单数。不设别名。

## 4. 第二层：资源与引用

### D11 引用模型

跨网络只允许三种引用。网络角色（user、service）的入参和出参里不出现 Host 的绝对路径。

| 引用 | 形式 | 用于 |
|---|---|---|
| 不透明 ID | 字符串 | Session、Run、Input、显示项、Interaction、租约、Agent、Skill、扩展、MCP server |
| 工作区相对路径 | 相对 `workspaceRoot`，不含 `..`，Host 用 realpath 做包含检查 | 项目选择、文件位置、diff、`writtenFiles` |
| blob 引用 | `{blobId, mediaType, byteLength, sha256}` | 所有字节内容：输入的图片和文件，输出的图片、截图和文件产物 |

**现状**：路径是 v1 契约的承重结构。

- 输入：图片和文件只能按路径传（`packages/agent/src/media/types.ts:23-39`）。`inputArtifacts[].path` 接受任意字符串（`schema.ts:358`），Host 不做包含检查就读。
- 输出：`ClientViewItem.attachments[].path`、`tool.outputPath`、`ClientWorkflowRun.runDir`、`ClientSkillInfo.path`、`ClientLoadedExtension.path`、memory 的 `memoryRoot` 等。
- 项目：`sessions.create({projectPath})` 接受任意绝对目录；没有项目列表接口。
- Artifact：客户端按 Host 路径匹配附件（`packages/artifacts/src/client.ts:36`）。HTML、PPTX 这类文件产物只返回路径或哈希，没有字节通道。

**改法**：

- **项目**：`session.create` 接受工作区相对的 `project`，缺省是工作区根。包含检查在服务端做。
- **输入**：网络客户端先上传 blob，再用 blob 引用提交。Host 把 blob 落到 home 下，再交给 agent 的媒体输入，所以规范消息里按路径引用的结构不用改。
- **输出**：显示项的附件带 blob 引用，取代路径。工具保存的完整输出用 `item.read` 读，不暴露 `outputPath`。写到工作区里的文件产物，M2 起用 `workspace.read` 取。
- **owner 是例外**：本机 IPC 的 owner 仍然可以传路径、拿到路径，因为它和 Host 在同一台机器上。v2 的 schema 里，带路径的参数只有 owner 能传（`restricted`），带路径的结果字段只在 owner 的结果 schema 里（`localResult`），见 D2。
- **Artifact SDK** 要改成按 blob 引用匹配，不再按路径。

**D7 契约去泄漏**（并入这里）：

- 契约只使用自有 DTO：
  - 用 `RunOutcome` 取代 `KodaXResult`（`client-contract.ts:1047`）。`KodaXResult` 带出 `KodaXMessage[]`、`KodaXManagedTask`、`KodaXExecutionFailure` 等十多个内部类型；
  - goal、workflow、agents、AutoModeStats 改用契约自有的类型；
  - 加 lint 测试，确保契约文件只从 `./client-*` 导入。
- 公开面按平面划分（见下面的"角色"）。trusted 永远不进浏览器 SDK。

**否决**：

- 在 v1 上加字段；
- 用 ACP 当产品契约。

### 资源

| 资源 | 身份 | 状态 | 说明 |
|---|---|---|---|
| Host | `host.id` | starting、ready、draining | 一个 home 一个 |
| Session | `sessionId`（UUIDv7） | 活动、归档、隔离中 | "隔离中"是主线 ADR-078 新增的事实：拒绝新的 Run，后台自愈。客户端从 `recovery` 字段读到它（FEATURE_313） |
| Input | `sessionId` + `inputId`，客户端提供 | 排队、已提交、已撤回 | 多条输入可以合批成一个 Run、一个显示项，用 `inputIds` 点名 |
| Run | `runId` | 进行中，然后是一个封闭的结局（`RunOutcome`） | 结局里"执行是否结算"和"副作用是否确定"是两个独立的事实 |
| 显示项 | `itemId` | 生成中、已结束 | 可以关联 `runId` 和 `inputIds` |
| Interaction | `interactionId` | 待回答、已结算 | 宿主请求 |
| Blob | `blobId` | 上传中、已提交 | 归属一个 Session，随 Session 删除 |
| 租约 | `leaseId` | 活动、脱机、已吊销 | 归属一个连接实例身份；三种：授权方、Host Tool、凭证 |
| Agent | 名字 | 已安装 | 人设的来源 |
| 设置 | Session 设置、Host 配置 | 带 `revision` | 用户设置域 |
| 授权记录 | `grantId` | 有效、已撤销 | `allow_always` 的持久授权 |

### D4 身份与角色

#### 两种身份，各管各的

| 身份 | 构成 | 用途 |
|---|---|---|
| 授权身份 | 人类用户统一记为 `person`，包括 owner IPC、owner 的 JWT 和配对设备；后端记为 `service:<sub>` | 决定谁能 `run.recover`、看到哪些侧聊、`requestId` 的作用域、谁能回答审批、审计里记的是谁 |
| 连接实例身份 | 授权身份 + `instanceId` 或 `deviceId` | 客户端退出时清理哪些工作、租约归谁、反向调用发往哪条连接 |

为什么要拆开：现在的 principal 同时承担这两种职责（`client-lifecycle.ts:163-166`，`reverse-bridge.ts:863-918`）。如果直接把网络身份合并成一个 `net:<sub>`，会出两个问题：

- 手机关掉标签页，会把笔记本上的 Run 一起清掉；
- (b) 里本机和远程变成两个人，远程端恢复不了本机发起的 Run（`server.ts:1994`），也看不到本机的侧聊（`side-chat.ts:145`）。

**迁移**：

- owner IPC 的连接实例身份继续用原来的公式，`hash(instanceId, instanceSecret)`。
- `run.recover`、steer、输入撤回和侧聊的校验改为比对授权身份。
- 持久格式只增加字段。
- **M0 已落地**（`src/requester-identity.ts`）：
  - Run 的 `origin`、排队的输入、撤回回执、侧聊绑定和侧聊消息各增加一个可选的 `subject` 字段；`principalId` 和侧聊的 `owner` 仍然写连接实例身份，公式不变。
  - 校验规则：双方都有 `subject` 时比 `subject`；任何一方没有（旧版本写的记录），就退回去比连接实例身份。所以升级后旧记录的归属不变，降级后旧代码读到的字段也和原来一样。
  - 行为变化：同一个 Host 上的两个本机客户端现在是同一个人。第二个客户端可以撤回第一个客户端排队的输入、打开同一个侧聊、恢复它的 Run、向它没有执行绑定的 Run 追加 steer。带执行绑定的 Run 仍然只接受持有绑定的那个连接实例的 steer，因为执行授权的键里包含连接实例身份。
  - 客户端退出时的清理、压缩控制、记忆任务、等待重新绑定的输入、反向调用租约，仍然按连接实例身份。
  - service 连接必须带已验证的 token `sub`，没有就拒绝所有方法。
- A2A 在主线 Issue 418 之后，按 `sha256(principal key, contextId)` 派生会话。A2A 迁到产品层时，它的 principal key 要并入授权身份，不能成为第三种身份。

#### 角色与平面

角色决定能调用哪些方法、能传哪些参数，实现为一张白名单，默认拒绝。方法按四个平面划分：

| 平面 | 内容 | owner（本机 IPC） | user（JWT 的 `sub` 等于 `owner`，或者设备配对令牌） | service（JWT 的 `sub` 在 `services` 里） |
|---|---|---|---|---|
| 数据面 | Session、Input、Run、Interaction、视图、历史、Blob、只读目录、只读 Workspace | 可以 | 可以 | 可以，但不能回答人的审批 |
| 用户设置 | MCP、扩展、provider、权限规则等 | 可以 | M2 起可以，平台可以按项锁定 | 不可以 |
| 可信面 | 租约、Session 策略、执行授权 | 可以 | 不可以 | 可以 |
| 本机管理 | Host 启停、日志、客户端退出、诊断 | 可以 | 不可以 | 不可以 |

- 白名单从 zod 定义派生（D2），和方法表（§4.7）是同一份数据。
- **M0 已落地**（`src/runtime-daemon/access.ts`）：v1 的每个方法归入一个平面，新增方法不归类就编译不过；dispatcher 必须传入角色，没有角色时拒绝所有方法，包括 `initialize`；没有可信面的角色传 `authorization`、`credential`、`hostTools` 会被拒绝；service 不能调用 `interaction.respond`。除这三个参数之外的按角色参数白名单，随 M1a 的 v2 strict schema 一起落地。记忆和技能学习的方法在 M0 归入本机管理面，只有 owner 能调用。
- 现在每条连接都拿到全部 scope（`host.ts:121-140` 没有传 `grantedScopes`，`server.ts:521-523` 默认给全部），唯一的门槛是 token。

#### 参数白名单

现在服务端会接受任何连接传来的 `params.authorization`（`server.ts:2478`），过滤只做在客户端 SDK 里（`client-runtime-adapter.ts:31-33`）。v1 还有一些参数能直接触达 Host：

- `inputArtifacts[].path`（`schema.ts:358`）；
- `run.recover.options`（`schema.ts:370`）；
- `options.context`：服务端只去掉 `configHome`、`memoryIdentity`、`contextIdentitySessionId` 和未受信的 `commandInvocation`，其余原样通过（`server.ts:2650-2656`）；
- `options.toolInvocation`；
- `projectPath` 和 `projectRoot`（`sdk-runtime.ts:8761`，`server.ts:2340`）。

所以 v2 改为**按角色的参数白名单**，按"列出允许的"来写，不按"去掉危险的"来写：

- user 角色传 `authorization`、`policy`、租约引用、任何 Host 路径，一律拒绝。
- user 角色不能传内联的 `agentProfile`。人设只在创建会话时选一次，让网络面不出现第二条人设通道。
- user 角色可以传 `context.prompt`。它只能追加规则和参考资料；`kodaxGuidance:'omit'` 也去不掉 home 下的规则，所以绕不过平台的约束。
- stdio MCP、`full-access`、持久化的权限规则、项目信任列表，归入下面的"用户设置"，受平台锁定控制。
- 网络客户端只能用 blob 引用和工作区相对路径（D11）。

#### 两类设置：平台控制面与用户设置

一个 Host 只属于一个用户，而且运行在平台给的容器或 uid 里，隔离边界是容器。所以用户改自己 Host 的设置，影响不到别人。真正要挡住的，是用户改掉平台定下的约束。

- **平台控制面**：永远不通过网络开放，只能由平台写入 home 配置，本机场景下由 IPC owner 修改。
  - 包括整个 `server` 配置块：监听、鉴权、`owner`/`services`、`allowedOrigins`、配对开关、`workspaceRoot`、工具上限、资源上限、sandbox 模式。
  - 还包括 Host 级的 `projectSources` 强制关闭开关（§2）。
  - home 下的 `AGENTS.md` 和 `rules/` 由平台写入，网络上的 user 角色也改不了。
  - 理由：用户如果能改这些，就能绕过平台的限制，比如放宽工具上限，或者把自己改成别的 owner。
- **用户设置**：对 user 角色开放，平台可以按项锁定。M2 对 user 开放这一组方法。
  - 包括：MCP server（含 stdio）、skills 和扩展、provider 和模型偏好、用户自带的 key、持久化的权限规则、`full-access` 模式、项目信任列表。
  - 锁定方式：配置项 `server.userLocks: ['mcp', 'extensions', 'providers', 'permissions', 'fullAccess']`，默认不锁。企业私有部署 (c) 通常会锁一部分。
  - `userLocks` 只放安全相关的设置。项目信任列表跟着 `permissions` 一起锁，不另设锁定项。
  - 硬规则：工具上限里没有 bash 时，stdio MCP 自动锁定。原因是启动 stdio MCP 本身就是在 Host 上执行一条命令，等于绕过工具上限。
  - key 只能写入，不能读回。

#### 人设

- 人设沿用现有的两样东西：
  - markdown Agent，包括 `~/.kodax/agents`、`.kodax/agents`，以及 `registerAgent` 注册的 Agent；
  - `agentProfile`。
- 创建会话时按名字选一个已安装的 Agent，可选的 Agent 用 `agent.list` 列出。M1a 的做法和范围见"按名字选 Agent 的落地细节"：它没有复用 `bindLocal`，第一版只收 Host 主目录里的 Agent（2026-11-21 改，未经用户确认）。
- 选定的 Agent 在创建时就固定，之后不能换。原因是人设在 Worker 提示词的最顶端，会话中途换人设，整段提示词缓存都会失效。
- 人设不进 `userLocks`，Host 端也不建人设存储。对标的 opencode、codex、pi 都没有人设锁。

#### 企业规则

- 企业规则继续用 home 下的 `AGENTS.md` 和 `rules/`。它们总会被加载，项目不能覆盖。
- 不新增平台策略源。
- SDK 想替换 home 下的规则，就切换 config home（`setAgentConfigHome` 或 `KODAX_HOME`）。

#### 设备配对

只用于 (b)。个人用户没有 IdP，而远程链接一旦泄露（浏览器历史同步、截图、隧道地址被扫描），任何拿到链接的人都能在这台电脑上执行命令。所以网络监听**必须**鉴权，Tailscale 下也一样：Host 区分不出流量来自隧道还是本机的其他程序。

流程（类似 Jupyter 的 token 链接，用户无感）：

1. 用户在 Space 里点"添加设备"，得到一个一次性配对链接和对应的二维码：`https://<隧道地址>/#pair=<配对码>`。配对码 10 分钟内有效，只能用一次，并且对尝试次数限速。
2. 手机或浏览器打开链接，网页从 URL 的 `#` 部分取出配对码。这部分不会发给服务器和代理，也不会进入访问日志。
3. 网页用配对码换取一个长期有效的设备令牌，存进浏览器的 localStorage，再把配对码从地址栏清掉。之后访问同一个地址会自动登录。
4. 用户清空了浏览器数据就重新配对。在 Space 的设备列表里吊销某台设备后，Host 立即断开这台设备的连接。

令牌是 256 位随机数，home 里只保存它的 SHA-256。命令行等价操作：

- `kodax daemon pair --name <设备>`：配对；
- `kodax daemon devices`：列出设备；
- `kodax daemon devices revoke <设备>`：吊销。

远程网页由 Host 在同一端口上提供：Space 打包出静态的 Web UI，通过配置 `server.webRoot` 指向它。网页和 Host 同源，不涉及跨域。

#### 浏览器来源

带 Origin 头的连接，其来源必须在 `allowedOrigins` 里。

#### 否决

- 客户端自报身份。
- tier 加 claimMap：平台控制 JWT 的签发，`sub` 就够用。
- 票据换连接凭证。
- 人设锁和 Host 端人设存储：没有真实需求，对标的三家也都没有。
- 平台策略源：home 下的规则已经满足"总会加载、项目不能覆盖"。
- 提示词里的 `system.lead`：会和 `agentProfile` 形成两条人设通道。

### D12 权限链：Host ⊇ Session ⊇ Run

**决定**（2026-11-20 确认）：一个 Run 能做什么，由三层策略逐层收窄得出。每一层只能收窄，不能放宽。

| 层 | 谁来定 | 内容 |
|---|---|---|
| Host | 平台，写在 `server` 配置里 | 工具上限、资源上限、`projectSources` 开关、`userLocks` |
| Session | 可信的创建者（owner 或 service），在 `session.create` 时给出 | 工具上限、预算、Agent、`agentProfile`、应用提示词、交互是否等人、绑定的租约 |
| Run | 提交者 | 预算、`context.prompt`；可信角色还可以再给执行授权 |

**现状**：只有 Host 层和 Run 层，没有 Session 层。

- 执行授权、Host Tool 租约、凭证都随提交参数进来，按 Run 绑定：`RuntimeExecutionAuthorization`（`src/client-host-authorization.ts:239-251`）。
- Run 在提交时捕获提交者的 reverse bridge（`server.ts:742`）。反向调用只发往这个 bridge 当前的连接。
- 没有 Session 级或 Host 级的登记。另一个连接引用别人的 `leaseId` 会查不到（`server.ts:3488-3492`，`reverse-bridge.ts:708-709`）。
- 每条排队的输入各自保存一份执行上下文（`session-input-queue.ts:250-253`）。

这在 v1 里够用，因为 Space 的 Renderer 和 Main 共用一条连接，由 Main 在提交前加上授权。到了三方场景就有缺口：

- (a)(c) 里 Run 由浏览器用户提交，用不上平台后端的凭证租约；
- 带 UI 的 (d) 里，人提交的 Run 用不上后端注册的 Host Tool；
- 人提交的 Run 只受 Host 级上限约束，后端没有办法给某个会话单独收窄。

**Session 策略**：

- `session.create` 接受 `policy`，只有 owner 和 service 可以传。user 创建的会话不能自己给策略，只受 Host 层约束；它可以按名字选 Agent，这时策略里只有那个 Agent 的人设和工具。
- 策略里的静态部分（工具上限、预算、Agent、`agentProfile`、应用提示词、`interactions`）是纯数据，存在 Session 上，对这个 Session 的每个 Run 生效，不管是谁提交的。
- 应用提示词就是主线的 `profile.prompt`。主线的提示词定制有两条通道：`authorization.profile.prompt` 和 `options.context.prompt`，正好对应 Session 层和 Run 层。
- 策略里可以绑定租约：授权方、Host Tool、凭证。绑定之后，这个 Session 上任何人提交的 Run，反向调用都发往绑定者的连接。
- `session.policy.get` 对所有角色开放，返回生效的策略，不含凭证内容。`session.policy.update` 只对可信角色开放，修改对之后的 Run 生效。
- 绑定者不在线时，结局按 §3 的宿主请求规则确定：需要凭证的 Run 在准入时失败，现有的错误码是 `execution_binding_unavailable`（`client-contract.ts:951`）；工具调用等到超时。

**分期**：策略的形状在 r1 冻结。静态部分在 M1a 实现。租约的 Session 级绑定在 M1b 实现，和 service 的反向调用一起做。

### D6 工具（服务端嵌入）

- 需要幂等和结局对账的业务工具：用 Host Tool 租约。可以按 Run 给，也可以绑定到 Session（D12）。v2 承载现有的反向调用，语义不变。
- 无状态的工具：用现有的 streamable-http MCP。
- 非编码场景：用 Host 级的 `tools` 上限（§2）去掉 fs 和 bash，Session 和 Run 还可以再收窄。
- MCP annotations 只能收紧权限，不能放宽。

**反向调用路由**：

- 反向调用发往持有租约的那条连接（连接实例身份）。
- 重连后恢复租约的条件已经核实（`reverse-bridge.ts:877-916`）：bridge 的键是 `stable:<principalId>:<sha256(instanceSecret)>`，所以只有带着同一个 `instanceId` 和 `instanceSecret` 的连接才能恢复。这是接管：新连接接上之后，旧连接会被关闭。
- 因此 service 有多个副本时有两种做法：
  - 副本共享同一个实例身份，同一时刻只有一个副本持有租约，故障时由另一个副本接管；
  - 各用各的实例身份，副本故障时在途的 Run 以不确定的结局结束，由调用方重试。
- 契约里把这两种做法都写明。

### 契约要点

```ts
// 握手
initialize({protocol:'kodax/2', revision, client:{name, version, instanceId},
            auth:{scheme:'jwt'|'pairing'|'ipc', token}})
 -> {protocol, revision,            // 双方都支持的最高协议 revision
     features, role, subject,
     methods,                       // 这条连接可以调用的方法
     locks,                         // 对这条连接生效的 userLocks
     expiresAt?,                    // 凭证到期时间；到期前用 auth.renew 续期
     limits:{maxFrameBytes, blobChunkBytes, maxBlobBytes, blobQuotaBytes,
             reverseCallTimeoutMs, idleTimeoutMs, itemTextUnits},
     host:{id, version}}

// 订阅
view.subscribe({subscriptionId, target:{kind:'session', sessionId}})   // 订阅 ID 由客户端给
 -> {subscriptionId, epoch, seq: 0, snapshot: SessionView}
// 通知
view.patch {subscriptionId, epoch, seq, ops: ViewOp[]}    // seq 连续递增
view.reset {subscriptionId, epoch, seq, snapshot}         // epoch 变了，整体替换
view.closed {subscriptionId, reason}                      // Host 结束了订阅
type ViewOp =
  | {op:'item.put'; item: ViewItem; before?: ItemId}      // 新增或整项替换
  | {op:'item.remove'; id: ItemId}
  | {op:'item.append'; id: ItemId; field:'text'; text: string}
  | {op:'set'; key: string; value?}                       // 不带 value 是删除；不认识的 key 保留但不使用

// 显示项：表示只取决于项自己
interface ViewItem {
  id; type;                         // type 是开放的，不认识时按 text 显示
  state:'live'|'settled';
  text; textTotal?;                 // 被截断时带全文长度，全文用 item.read 读
  at?; runId?; inputIds?;
  attachments?: BlobRef[];
  tool?: {callId; name; status; inputText?; inputTotal?; outputSaved?; progress?; startedAt?; endedAt?};
}

// Run 的结局：一个封闭的类型，取代 phase、terminal、error、result 的组合
// M1a 落地的形状见"输入与 Run 的落地细节"：结局挂在 Run 上，finalText 之后的四项推迟
interface RunOutcome {
  runId; sessionId;
  status:'completed'|'failed'|'cancelled'|'interrupted'|'unknown';   // 封闭
  effects:'none'|'known'|'unknown';                                  // 封闭；副作用是否确定
  code: string;                     // 开放、稳定，例如 actor_settlement_not_persisted
  failure?: {kind; stage; code; safeMessage; skillName?};            // 只在 failed 时出现
  finalText?;                       // 有界
  outputItemId?; usage?;
  writtenFiles?: {path /* 工作区相对 */; sourceTool}[];
}

// 创建会话
session.create({requestId, project? /* 工作区相对 */, title?, agent? /* 已安装 Agent 的名字 */,
  policy?: {                        // 只有 owner 和 service 可以传
    tools?; budget?: {maxIter?, tokenBudget?, maxDurationMs?};
    agentProfile?; prompt? /* 主线的 KodaXPromptSpec */;
    interactions?: 'wait'|'reject';
    leases?: {authorizer?, hostTools?, credential?} }})   // 值是 leaseId
// M1a 实际接受的范围见"Session 策略的落地细节"：tokenBudget 和 agentProfile.verification
// 在 Host 能执行之前不接受（未经用户确认）。现有的 tokenBudget 只存在于工作流的 Host 策略和 Goal 上，
// 没有 Run 级的可以挂。

// Run 选项（随 input.submit 给出，M1a 只有 owner 和 service 可以传）：
//   budget?: {maxIter?, maxDurationMs?}（只有 maxDurationMs 是新增的；tokenBudget 同上，暂不接受）
//   prompt?: {kodaxGuidance:'keep'|'omit', context:[{key, kind:'rule'|'reference', text}]}
//   原样沿用主线的定义：条目文本总长上限 8,000 字符；'omit' 去掉 KodaX 默认风格，
//   保留契约文本、工具说明和 AGENTS.md
//   M1a 实际的行为见"Run 的限制与选项的落地细节"

// blob：上下行同一套分块方法
blob.begin({requestId, sessionId, mediaType, byteLength, sha256}) -> {blobId}
blob.write({blobId, offset, data /* base64，不超过 blobChunkBytes */})
blob.commit({blobId}) -> BlobRef   // {blobId, mediaType, byteLength, sha256}，只在本 home 内有效
blob.read({blobId, cursor?}) -> {data, nextCursor?}

// 权限 Interaction 带上拟变更：{kind, locations?: 工作区相对路径[], diff?: {path, added, removed, unified?, truncated?}}
```

- `initialize`（M1a 已落地，`src/host-protocol/methods.ts`）：
  - `auth` 必填。IPC 端点只接受 `ipc`，其他 scheme 报 `unauthorized`。
  - `client.instanceId` 必填，用通用约定的 ID 字符集，最少 4 个字符；`client.instanceSecret` 可选，沿用 v1 证明"重连的是同一个客户端实例"的做法，32 到 256 个字符（v1 的下限是 32，2026-11-22 对齐，未经用户确认）。
  - `role` 和 `subject` 只用于展示和排查，客户端按 `methods` 和 `locks` 分支。
  - `methods` 按方法定义的顺序列出这个角色够得着的全部方法。
  - `limits` 目前只有 `maxFrameBytes`。其余各项随对应的功能一起加进来，不先放占位值。
  - `ping` 的结果是空对象。
- `RunOutcome` 以主线 ADR-078 的失败契约为准：能预期的结局都结算，并保留真实原因。`limitReached` 不在持久化的 Run 状态里，只在进程内的执行结果里，和 `finalText` 等四项一起推迟（见"输入与 Run 的落地细节"）。
- FEATURE_311 之后所有根 Run 都走 managed Worker，所以第 3 版里"只对 managed Run 生效"的限定不再需要。
- FEATURE_310 之后 `agentMode` 的 `sa` 和 `amaw` 只是兼容输入。v2 的 Session 设置不带 `agentMode`，也不带兼容用的 `reasoningMode` 和 `thinking`。
- 主线为提示词定制新增的 context key 和能力键（例如 `promptSpec`），在 v2 里直接进入 r1 基线，不占 feature 名额。

**r1 冻结的内容**：

- 四种原语的保证、`requestId` 和回执规则；
- 帧格式和 `initialize` 的结果；
- 角色和平面；
- 四种同步操作、`seq` 和 `epoch`；
- `RunOutcome`；
- 引用模型和 blob 引用；
- Session 策略的形状；
- 错误码；
- 权限请求里的拟变更；
- 通用约定（ID、时间、游标、版本）。

**M2 按 `revision+1` 追加**：执行后的 `ToolFacts`、`workspace.list/read/gitDiff`、Host 文档。

### 方法表

把 v1 的 189 个方法逐个归到"资源 × 原语"上。原语一列：查 = 查询，命 = 命令，订 = 订阅。★ 表示 M1a 把它抽成领域 handler；其余方法先由 v2 编解码转给现有的实现，M3 再拆。原先标"核实"的 7 个条目已在 M0 对照本仓库的代码逐项确认，结论写在各行里。Space 的调用点不在本仓库，凡是结论依赖 Space 的，都单独注明。

**连接与同步（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `initialize` ★ | 握手 | `initialize`、`runtime.initialize`、`runtime.identity`、`runtime.capabilities`、`runtime.status` | 身份、能力和状态并入握手结果 |
| `ping` ★ | 查 | `ping` | 兼作心跳 |
| `auth.renew` | 命 | 新增 | M1b |
| `request.cancel` ★ | 通知 | `request.cancel` | 取消带等待的查询。参数是 `id`（JSON-RPC 请求 id） |
| `view.subscribe` ★ | 订 | `session.view.observe`、`session.observe`、`workflow.subscribe`、`learning.subscribe` | 一种机制。M1a 已落地 Session 视图这一种，视图里带这个 Session 的 Workflow |
| `view.unsubscribe` ★ | 订 | `session.view.close`、`subscription.close`、`workflow.unsubscribe`、`learning.unsubscribe` | 不带 `requestId`，按订阅 ID 幂等。M1a 已落地 |

`request.ack` 删除（已核实）：

- 它不是用来释放响应的，Host 不保留响应体。它的作用是：一个请求如果创建了订阅，客户端确认之后订阅才归客户端所有；确认之前取消这个请求，订阅会被关掉，避免调用方放弃之后留下没人管的订阅（`server.ts:679-711`、`842-845`）。
- 调用方只有 socket 传输层自己（`transport.ts:259-293`），不是产品接口。
- v2 用三条规则代替它：订阅 ID 由客户端在请求里给出，所以即使没收到响应也能退订；`view.unsubscribe` 是幂等的；连接断开时 Host 关闭这条连接上的全部订阅。

**数据面：会话（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `session.create` ★ | 命 | `session.create` | M1a 已落地 `project` 和 `policy`（工具、`maxIter`、`maxDurationMs`、`agentProfile`、应用提示词、`interactions`）和 `agent`（按名字选已安装的 Agent） |
| `session.list` ★ | 查 | `session.list` | M1a 已落地 |
| `session.get` ★ | 查 | `session.load`、`session.status`、`session.autoMode.getStats` | M1a 已落地，自动模式统计还没并入 |
| `session.archive` ★ | 命 | `session.archive` | M1a 已落地 |
| `session.unarchive` ★ | 命 | `session.unarchive` | M1a 已落地 |
| `session.delete` ★ | 命 | `session.delete` | M1a 已落地 |
| `session.cancel` ★ | 命 | `session.cancel` | 停止整个会话。M1a 已落地 |
| `session.settings.get` ★ | 查 | `session.settings.get`、`session.settings.getVersioned` | 一律带 `revision`。M1a 已落地 |
| `session.settings.update` ★ | 命 | `session.settings.update`、`session.settings.updateVersioned`、`run.model.set`、`run.provider.set`、`run.reasoning.set`、`run.setModel`、`run.setProvider`、`run.setReasoning` | 用 `ifRevision`。M1a 已落地。已核实：6 个 `run.*.set` 只改 Run 记录、不落到 Session（`sdk-runtime.ts:14308-14345`），而更新 Session 设置已经会推给所有在跑的 Run（`sdk-runtime.ts:12383-12432`）。本仓库只有客户端封装在调用，公开契约里没有。合并后不再有"只对这一个 Run 生效、不保存"的覆盖。Space 是否直接调用 `runs.setModel` 没有核对 |
| `session.policy.get` ★ | 查 | 新增 | D12。M1a 已落地 |
| `session.compact` ★ | 命 | `session.compact` | M1a 已落地 |
| `session.notice.append` | 命 | `session.notice.append` | M1a 已转发。v1 多了 `requestId`，同一个请求只加一条 |
| `session.fork` | 命 | `session.fork` | M1a 已转发。同一个请求只分叉一次；v2 不能指定新 Session 的 ID |
| `session.rewind` | 命 | `session.rewind` | M1a 已转发。必须说明退回到哪里 |
| `session.branch.select` | 命 | `session.activeEntry.set`、`session.active_entry.set` | 去掉别名。M1a 已转发 |
| `session.lineage.get` | 查 | `session.lineage.get` | M1a 已转发，分页 |
| `session.lineage.label` | 命 | `session.lineage.label` | M1a 已转发 |
| `session.recover` | 命 | `session.recover` | M1a 已转发。同一个请求只恢复一次 |
| `session.side.open` | 命 | `session.side.open` | 侧聊。M1a 已转发 |
| `session.goal.get` | 查 | `session.goal.get` | M1a 已转发 |
| `session.goal.create` | 命 | `session.goal.create` | M1a 已转发 |
| `session.goal.pause` | 命 | `session.goal.pause` | M1a 已转发 |
| `session.goal.resume` | 命 | `session.goal.resume` | M1a 已转发 |
| `session.goal.clear` | 命 | `session.goal.clear` | M1a 已转发 |

会话六项的落地细节（2026-11-21，未经用户确认）：

- **Session 的形状**：`id`、`title`、`tag?`、`archived`（必有）、`project?`、`branch?`、`surface?`、`profileId?`、`messageCount?`、`createdAt?`、`lastMessageAt?`（都是 UTC 毫秒）、`sideChat?`、`revision?`、`recovery?`（FEATURE_313，只在隔离中出现）。Host 本机的 owner 另外能看到 `workspaceRoot`、`gitRoot`、`executionCwd`；其他角色的结果里没有 Host 路径。
- **引用已有 Session 的 ID 比新 ID 宽松**（1 到 256 个字符）：Host 里还有 ID 规则出现之前建的 Session。
- **项目的两种叫法**：
  - `project` 是工作区内的相对路径，用 `/` 分隔，`.` 表示工作区根，不允许 `..` 和反斜杠。Host 解析之后再用 realpath 确认它在工作区里面，并且是个目录。
  - `projectRoot` 是 Host 上的绝对路径，只有 owner 能发，其他角色发了报 `forbidden`（`param_not_allowed`）。
  - 两个都给报 `invalid_params`（`project_named_twice`）。
  - 其他失败：项目不存在是 `not_found`（`project_not_found`）；跑到工作区外面是 `invalid_params`（`project_outside_workspace`）；工作区目录读不了是 `unavailable`（`workspace_unavailable`）。
- **Host 没有配工作区时**：非本机角色不能创建 Session，也不能按项目筛选（`forbidden`，`workspace_not_configured`）。owner 不给项目时沿用 v1 的默认值，也就是 Host 的当前目录。
- **不给项目时的默认值**：有工作区的 Host 上，Session 建在工作区根。
- **工作区从哪来**：桥接层已经接受一个工作区对象，但 Host 启动时还没有把配置接进来，这是 M1b 的 `server.workspaceRoot`。在那之前，IPC 上的非 owner 连接建不了 Session。
- **`session.list`**：`limit` 是 1 到 200，默认 50。v1 的 `scope` 和 `before` 两个筛选没有带过来。
- **`session.get`**：结果是 `{session, phase, runId?}`。`phase` 是开放字符串。自动模式统计没有并入，因为 v1 的统计类型直接暴露了内部的跟踪器对象，要先定一个不泄漏的形状。
- **找不到 Session** 在 runtime 里现在带 `not_found` 码；v1 以前报的是 `internal_error`。
- **`session.create` 还没带的字段**：`draft`、`temporary`、`mcpServers`。

设置两项的落地细节（2026-11-21，未经用户确认）：

- **两处设置含义不同**：
  - `session.settings.get` 返回这个 Session 自己选的值。没选的项不出现，表示跟随 Host 的默认值。
  - 视图里的 `settings` 是实际生效的值，已经把 Host 的默认值填进去了。比如新建的 Session 自己没有选 `permissionMode`，视图里是 `accept-edits`。
  - 这是 v1 现有的行为，v2 照搬并写进了契约。客户端画界面用视图，编辑设置用 `session.settings.get`。
- **结果**：`{ settings, revision, workModeLocked }`。`revision` 是字符串。`workModeLocked` 为真表示 Session 已有历史，`workMode` 不能再改。
- **v2 能读写的设置**：`provider`、`model`、`effort`、`planModeEffort`、`permissionMode`、`workMode`、`autoModeClassifierModel`、`compactionTriggerPercent`、`compactionTriggerTokens`、`maxIter`、`repoIntelligenceMode`、`repoIntelligenceTrace`、`compactionReasoning`。
- **v2 不提供的设置**：
  - `executionCwd`、`shellExecution` 属于 Host 的执行契约，不由数据面的客户端改，结果里也不返回（`executionCwd` 是 Host 路径）。
  - `agentMode`、`reasoningMode`、`thinking` 是旧的叫法，分别被固定的 AMA 模式和 `effort` 取代。
  - 补丁里出现这些键报 `invalid_params`。
- **补丁**：只写要改的键。`null` 清除一项，让它重新跟随 Host 的默认值。
- **读出来的值比能写进去的宽**：磁盘上的旧设置是宽松解析的，所以结果里的 `provider`、`model`、`effort` 是开放字符串，数字没有上下限。只有补丁做严格校验。
- **`ifRevision`**：
  - 带了就做比较，设置在那之后变过则报 `conflict`（`reason` 是 `revision_mismatch`），什么都不写。
  - 不是 Host 发出过的 revision（比如不是数字）同样按过期处理。
  - 不带就直接改。
  - 带 `ifRevision` 的更新成功之后，同一个请求再发一次会得到 `revision_mismatch`，因为 revision 已经变了。客户端这时重新读一次就能看到自己的修改。
- **其他冲突**（Session 已有历史时改 `workMode` 等）仍然是 `conflict`，`reason` 是 `conflict`。
- **v1 的变化**：设置更新和授权撤销在 revision 过期时，错误里多了 `data: { conflict: 'revision_conflict', currentRevision }`。桥接层靠它把过期和别的冲突分开。

目标、对话树和通知的落地细节（2026-11-21，未经用户确认）。这九个方法不带 ★，是"由 v2 编解码转给现有实现"的第一批：

- **目标的形状**：`id`、`objective`、`status`（`active`、`paused`、`budget_limited`、`blocked`、`complete`）、`tokenBudget?`（没有上限时不出现）、`tokensUsed`、`timeUsedSeconds`、`blocker?`（模型上次报告的阻碍类别）、`createdAt`、`updatedAt`（UTC 毫秒）。v1 的 `version` 和 `blockerTurnCount` 没有带过来。
- **目标的五个方法**：
  - `session.goal.get` 的结果是 `{goal?}`，没有目标时 `goal` 不出现。
  - `session.goal.create` 的参数是 `{requestId, sessionId, objective, tokenBudget?}`，结果是 `{goal}`。
  - `session.goal.pause` 和 `session.goal.resume` 的结果是 `{goal}`，`session.goal.clear` 的结果是 `{}`。
- **目标命令的重发**：四个命令都按"要的状态已经成立"判断，不看 `requestId`。
  - v1 对不改变任何东西的目标命令报 `conflict`，REPL 要把这句话显示给人看，所以 v1 不改。
  - 桥接层收到 `conflict` 之后读一次目标。同一目标和预算的未完成目标已在、已是 `paused`、已是 `active`、已经没有目标，这四种情况分别按 create、pause、resume、clear 的成功回答，结果是目标现在的样子。其他情况原样报 `conflict`。
  - 所以换一个 `requestId` 再建同一个目标也是成功，返回的可能是一个已经暂停的目标，`status` 会说明。
- **目标的其他失败**：Session 还没有对话时建目标是 `conflict`；Session 在跑的时候改目标是 `conflict`；另一个未完成的目标还在是 `conflict`。
- **已知缺口**：`create` 的回复丢了，目标又在重发之前完成，重发会再建一个同名目标。客户端通常拿到回复之后才提交下一条输入，所以很难撞上。没有为它给目标条目加持久化的 `requestId`。
- **对话树条目的形状**：`id`、`parentId?`（第一条没有）、`type`（开放字符串，如 `message`、`label`、`branch_summary`、`client_notice`）、`createdAt?`（UTC 毫秒）、`role?`、`preview?`（最多 160 个字符）、`targetId?`、`label?`、`truncatedCount?`。
- **`session.lineage.get`**：参数是 `{sessionId, limit?, cursor?}`，结果是 `{items, nextCursor?, activeEntryId?}`，最早的条目在前。
  - `limit` 是 1 到 1000，默认 200。v1 一次返回整棵树，长对话会超过帧的上限，所以 v2 分页。
  - `cursor` 是上一页最后一条的 ID。这条不在了报 `resync_required`（`cursor_gone`），客户端从头再读。
  - 分页现在在桥接层做，每页都向 v1 读一次整棵树。M3 拆领域的时候下沉。
- **`session.lineage.label`**：参数是 `{requestId, sessionId, entry, label?}`，结果是 `{entry}`，也就是记录这次标签的那一条。`entry` 是条目 ID 或已有的标签。不给 `label` 表示去掉标签。重发会再记一条同样的标签，读树的人看到的结果不变。
- **`session.branch.select`**：参数是 `{requestId, sessionId, entry, summarize?}`，结果是 `{session}`。
  - 带 `summarize` 时，被离开的那段分支的摘要挂在目标条目后面，对话停在摘要上。
  - v1 的变化：对话已经停在这样一条摘要上时，同一个带摘要的切换什么都不做。原来重发会给摘要再做一份摘要，并多出一条分支。
- **`session.notice.append`**：参数是 `{requestId, sessionId, text, source?}`，结果是 `{itemId}`。
  - `itemId` 是 Session 视图里显示这条通知的条目 ID。`history.read` 不含通知。
  - v1 的变化：`session.notice.append` 多了 `requestId` 参数，记在通知条目上。同一个 `requestId` 再发，回答第一次加的那条，不再加新的。重发时不比较内容。
  - v1 存不下通知时返回 `null`，v2 报 `unavailable`（`notice_not_saved`）。
- **这一组共同的 v1 行为**：找不到条目报的是 `conflict`，不是 `not_found`；Session 在跑的时候，标签、切换和通知都报 `conflict`。M3 拆领域的时候把前者改成 `not_found`。
- **没有验证的**：已经订阅的视图会不会实时收到新加的通知（只验证了重新订阅时的快照里有）；`budget_limited` 和 `blocked` 两种状态下的目标命令；归档过旧条目的 Session 的分页。

Session 策略的落地细节（2026-11-21，未经用户确认）。这是 D12 静态部分的第一步，代码在 `src/session-policy.ts`：

- **形状**：`policy` 是 `{ tools?, budget?: { maxIter?, maxDurationMs? }, agentProfile?, prompt?, interactions? }`，每一项都可以不给。
  - `tools` 是工具名的白名单，而且是完整的：没列进去的工具，包括提问、派生子 Agent 这些内置工具，这个 Session 的 Run 都用不了。不给就只受 Host 层约束。空列表表示一个工具都不给。
  - `budget.maxIter` 是一个 Run 最多跑多少轮模型调用。
  - `budget.maxDurationMs` 是一个 Run 最多跑多久，见"Run 的限制与选项的落地细节"。
  - `agentProfile` 是人设：`id`、`name`、`version`、`surface`、`instructions`。
  - `prompt` 就是主线的 `KodaXPromptSpec`：`kodaxGuidance` 加一组 `{ key, kind, text }` 条目。
  - `interactions` 是 `wait` 或 `reject`，见"等人还是不等的落地细节"。
- **只接受 Host 真正会执行的字段**。接受了却不执行的限制比没有更糟，所以下面两项现在发了报 `invalid_params`，等到能执行时再加：
  - `budget.tokenBudget`：现在没有 Run 级的 token 预算可以挂。
  - `agentProfile.verification`：它带的是启动命令和环境变量，属于执行授权，不是纯数据。
- **谁能给**：owner 和 service。user 发了报 `forbidden`（`param_not_allowed`）。v1 的 `session.create` 也收 `policy`，`policy` 进了 v1 的可信参数名单，所以 v1 上的 user 同样发不了。
- **存在哪**：Session 的 `runtimeInfo.policy`。`packages/agent` 这一层把它当不透明数据，只有 Host 解析。
  - 之后的保存不会丢掉或改写它：存储层合并快照时保留已有的策略，和创建回执的做法一样。
  - 以后做 `session.policy.update` 时要走单独的写入路径，因为现有的 `mutateRuntimeInfo` 也经过这个合并。
- **怎么生效**：每个 Run 在 `startRun` 里、算出执行选项之后套上策略。立即启动的、排队的、点名工具的、命令、工作流、恢复的 Run 都走这里。
  - 工具：和 Run 自带的上限求交集。限制写成声明式的，所以 Host 重启后恢复的 Run 仍然受它约束。子 Agent 继承同一份限制。
  - `maxIter`：取策略和 Run（或 Session 设置）里较小的那个。
  - `agentProfile`：用 Session 的，Run 自带的被替换。
  - 提示词：Session 的条目在前，Run 的在后。Session 给了 `kodaxGuidance` 就用 Session 的。Run 用了 Session 已有的 key 又写了不同的内容，或者合起来超过 8000 个字符，这个 Run 报 `invalid_params`。
  - 工作模式不受策略影响：一个 Run 在没有策略时是什么模式，套上策略之后还是什么模式。
- **读不懂就不跑**：存下来的策略解析失败时，这个 Session 的 Run 一律拒绝，不会当成没有策略。读 Session 本身不受影响。
- **`session.policy.get`**：所有角色可读，结果是 `{ policy }`。没有策略的 Session 返回空对象。它读的是 v1 的 `session.load`，v1 的 Session 上多了可选的 `policy`。
- **重试**：`policy` 算进 `session.create` 的请求指纹。同一个 `requestId` 配同样的策略返回同一个 Session，配不同的策略报 `conflict`。
- **fork 和侧聊**：fork 出来的 Session 带着同一份策略。侧聊继承父 Session 的策略，它自己的只读工具集再和策略求交集，所以策略里没有 `send_to_parent` 的 Session，侧聊不能向父会话汇报。
- **没有测到的**：工作流和侧聊这两条路径只读了代码（它们用的是同一份工具可见性策略），没有专门的测试。MCP 工具同理。
- **还没做**：`session.policy.update`、租约绑定。

按名字选 Agent 的落地细节（2026-11-21，未经用户确认）。代码在 `src/session-agent.ts`：

- **用法**：`session.create` 多了顶层参数 `agent`，值是 `agent.list` 里的一个名字。所有角色都能传，因为可选的 Agent 都是 Host 的主人自己装的。v1 的 `session.create` 同样多了 `agent`。
- **创建时把 Agent 抄进 Session 策略**，之后每个 Run 走的就是"Session 策略的落地细节"里已有的路径，没有新的执行路径：
  - Agent 的名字和正文写进 `policy.agentProfile` 的 `name` 和 `instructions`。
  - Agent 声明了 `tools` 的，写进 `policy.tools`。创建者同时给了 `policy.tools` 时取交集，所以 Agent 只能收窄，不能放宽。Agent 没声明 `tools` 的，工具不变。
  - `session.policy.get` 读到的就是抄进去之后的结果。
- **抄的是快照**：之后改或删 Agent 的文件，不影响已经创建的 Session。Host 重启后也一样。fork 带着同一份策略。
- **模型是起点，不是限制**：Agent 声明的 `provider`、`model`、`effort` 在创建时写进这个 Session 的设置。之后人可以用 `session.settings.update` 改，和别的 Session 一样。
- **`agent.list`**：所有角色可读，每项是 `{ name, description, tools?, provider?, model?, effort? }`，不带正文和路径。它对应新增的 v1 方法 `agent.list`，不是 `agents.listDispatchable`。
  - 原因：`agents.listDispatchable` 列的是一个正在跑的 Agent 能把活派给谁，要带 `actorId` 才能调，而且 Host 进程里它根本不加载 markdown Agent。它回答不了"建会话时能选谁"。
  - `agent.list` 列出的和 `session.create` 接受的是同一批，两处用同一个加载函数。
  - `agent.get` 不做：`agent.list` 已经给了选人设要用的全部信息。
- **没有复用 `bindLocal`**：它是给远程 Agent 互调（A2A）用的，要带执行授权和工作区绑定，绑定只存在内存里，Host 重启就没了。这里复用的是它底下的加载和准入（`loadMarkdownAgentScope`），所以同一个 Agent 文件在两条路径上过的是同一道检查。
- **第一版只收 Host 主目录的 Agent**（`<Host 主目录>/agents/*.md`）：
  - 项目里的 `.kodax/agents` 不收。项目文件是项目说的话，现在代码里还没有项目信任的检查（`projectSources` 只在本方案里），收了就等于任何一个仓库都能给会话换人设、定工具。等项目信任落地后再放开。
  - `registerAgent` 注册的 Agent 不收。它们只存在于注册它的那个进程里，Host 进程里没有。
- **错误**：
  - 没有这个名字的 Agent，报 `not_found`。
  - 同时给了 `agent` 和 `policy.agentProfile`，报 `invalid_params`：一个 Session 只有一个人设。
  - Agent 的正文超过 32,000 个字符的，不出现在 `agent.list` 里，也不能选。这是 Session 策略里人设正文的上限，超过了 `session.policy.get` 就答不出来。
- **重试**：`agent` 算进 `session.create` 的请求指纹。同一个 `requestId` 配同一个名字返回同一个 Session，哪怕 Agent 的文件在两次之间改过；配不同的名字报 `conflict`。
- **已知的缺口**：
  - Session 存下来之后、模型设置写进去之前 Host 崩溃，重试会拿到同一个 Session，但它用的是 Host 的默认模型。人设和工具不受影响，它们和 Session 是一次写入。fork 复制设置时有同样的窗口。
  - Agent 声明的 `skills` 没有带进来，这样创建的 Session 看到的是全部技能。`bindLocal` 那条路径会按它筛选。
  - 记忆不按 Agent 分开：`agentProfile.id` 没有写，所以这些 Session 和普通会话共用同一份记忆。
  - 每次按名字创建会话都会重新加载主目录下全部 Agent 文件并过准入，开销和 Agent 个数成正比。
- **没有测到的**：草稿会话（`draft`）加 `agent`、侧聊和工作流在 Agent 会话里的表现，只读了代码。

等人还是不等的落地细节（2026-11-21，未经用户确认）。对应 §2 的"等待中的交互"：

- **`interactions: 'reject'`**：这个 Session 的 Run 不把任何提问和审批交给人，当场回答，Run 继续跑。
  - 提问：工具结果是现有的"没有回答，原因 `non_interactive`"，模型据此自己往下做。
  - 审批：这次工具调用不执行，模型收到的是代码里已有的那句"需要人批准，但这个 Host 没法问"。没有新增给模型看的文字，所以没有新的提示词 eval。
  - 计划模式的退出审批：按没批准处理，Run 留在计划模式。
  - 不生成等待中的交互，`interaction.list` 和视图里的 `interactions` 始终是空的。
  - 进程内宿主自己的 `beforeToolExecute` 钩子是代码不是人，照常调用。
- **`interactions: 'wait'`**：和现在一样，交给已连接的客户端，等多久由 Host 的 `permissionTimeoutMs`（默认 5 分钟）和 `userInputTimeoutMs`（默认不限时）决定。
- **默认值**：service 创建 Session 时没说，桥接层替它写上 `reject`，`session.policy.get` 能读到。owner 和 user 创建的不写，等于 `wait`。v1 的 `session.create` 没有这条默认，不给就是 `wait`。
  - 后端创建、真人使用的会话，后端要显式给 `interactions: 'wait'`。
- **只在 Session 上**：Run 选项里没有它，发了报 `invalid_params`。
- **还没做**：§2 说的"`wait` 默认等 30 分钟"。现在提问默认不限时，改这个默认值会影响本机 REPL，放到 M1b 做 `kodax host` 的启动参数时一起定。在那之前，平台要用现有的 `--user-input-timeout-ms` 自己设上限。
- **没有测到的**：子 Agent、侧聊、工作流和 MCP 反向提问在 `reject` 下只读了代码（它们走同两个入口），没有专门的测试。计划模式的退出审批同理。

Run 的限制与选项的落地细节（2026-11-21，未经用户确认）。这是 D12 里 Run 这一层：

- **时间上限**：`budget.maxDurationMs` 是 1 到 2^31−1 的整数毫秒，Session 策略和 Run 选项都可以给，取较短的那个。
  - 计的是一次连续执行的墙上时间，等人回答的时间也算。排队的时间不算。Host 重启后恢复的 Run 重新开始计。
  - 到时间后 Host 走和用户 Stop 同一条持久化路径，所以这个 Stop 请求在 Host 重启后还在。记不下来时退回内存里直接停，并发一条诊断。
  - 结局是 `{status: 'interrupted', effects: 'unknown', code: 'time_limit', message: 'The Run reached its time limit.'}`，Run 上能看到 `stop` 已请求并确认。`time_limit` 是新增的终态码，v1 也能看到。
  - 因超时停下的 Run 之后，队列不会自动接着跑下一条，和用户 Stop 之后一样。
- **Run 选项随输入给出**：`input.submit` 多了 `budget`（`maxIter`、`maxDurationMs`）和 `prompt`（主线的 `KodaXPromptSpec`）。v1 的 `input.submit` 对应多了一个可选的 `runOptions`。
  - **谁能给**：M1a 只有 owner 和 service。user 发了报 `forbidden`（`param_not_allowed`）。v1 上 `runOptions` 进了可信参数名单，对 v1 的所有方法生效。
  - **它约束的是这一条输入，不是这个 Session 的使用者**：user 可以自己提交不带选项的输入，也可以撤回一条带选项的输入再重发。要让每个 Run 都受约束，用 Session 策略。
  - **只能收窄**：先套 Run 选项，再套 Session 策略。两个上限都取较小的；提示词是 Session 的条目在前，Run 的在后；Run 用了 Session 已有的 key 报 `invalid_params`。这一条在提交时就检查，不等排到它的时候才拒绝。
  - **带选项的输入有自己的 Run**：它不会并进正在跑的 Run，排队时也不和前后的输入合成一批；为它启动的 Run 也不会吸收别的排队输入（内部标记 `soleInput`，Host 重启后恢复的 Run 仍然带着）。主动 steer 进这个 Run 仍然可以。
  - **不能和 `steer` 一起用**：steer 是加入一个已经在跑的 Run，报 `invalid_params`（`run_options_not_allowed`）。
  - **重试**：选项算进输入的意图指纹。同一个 `requestId` 配同样的选项是同一条输入，配不同的选项报 `conflict`。排队的输入在 Host 重启后还带着它的选项。
  - **Run 的提示词条目只管这一个 Run**：它们出现在这个 Run 的上下文增量里；同一个 Session 的下一个 Run 会收到"No longer available"的增量，告诉模型这些条目已经失效。Session 的条目只在第一个 Run 的完整上下文里说一次。这是主线提示词链本来的行为，桥接测试里有断言。
- **`run.start` 上直接给的 `maxDurationMs`**（进程内和 v1 的调用方）按同样的范围校验，同样只能收窄。
- **没有测到的**：恢复的 Run 重新计时这一条只读了代码；选项在恢复后仍然保留有单元测试。时间上限在工作流和点名工具的 Run 上没有专门的测试，它们走同一个启动入口。

压缩的落地细节（2026-11-21，未经用户确认）：

- **参数**：`{ requestId, sessionId, instructions? }`。`instructions` 告诉摘要要特别保留什么，不能全是空白，最长 8000 个字符。
- **结果**：`{ compacted, tokensBefore, tokensAfter }`。不带对话内容，也不带压缩报告；压缩之后的对话从视图和 `history.read` 读。
- **三种结局分开表达**：
  - 压缩了：`compacted: true`。
  - 对话太短，不需要压缩：`compacted: false`。
  - 摘要没做成（比如模型不可用）：报 `unavailable`，`reason` 是 `compaction_failed`，消息里是原因。对话没有变。
  - v1 把后两种都放在 `compacted: false` 里，靠 `reason` 的文字区分。现在 v1 的结果多了一个 `failed: true` 标记，桥接层靠它分开。
- **什么时候作答**：压缩做完才作答，耗时相当于一次模型调用。它是修改，不能用 `request.cancel` 中途取消。
- **忙的时候**：Session 正在跑，或者另一个请求正在压缩它，报 `conflict`。压缩期间提交输入同样报 `conflict`。
- **重试**：见"命令与回执"一节的 `session.compact` 条。
- **修掉的一个 v1 问题**：手动压缩选模型时没有看 Host 的默认 provider。Session 自己没选 provider、也还没跑过时，它固定去找 `anthropic`，没配这个 key 就失败。现在先用 Host 的默认 provider 和默认模型，和这个 Session 的 Run 用的一致。v2 新建的 Session 通常不自己选 provider，所以这个问题在 v2 上必现。
- **v1 的变化**：`session.compact` 多了可选的 `requestId`；结果多了 `failed`；谱系里的压缩记录多了可选的 `requestId`。
- **留到 SDK 那一步**：产品客户端契约的 `sessions.compact` 返回 `messages`，REPL 的 `/compact` 在用。v2 不返回它。REPL 已经改成只用 `tokensBefore`、`tokensAfter`，不再替换本地消息（见"REPL 切到 v2 的决定"）。

**数据面：历史与显示项（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `history.read` ★ | 查 | `session.conversation.page` | 只读对话视图，分页。M1a 已落地。已核实：整份读取的 `session.conversation`、`session.transcript` 和 `session.transcript.page` 在本仓库没有产品消费方，只有测试、基准和文档示例，v2 不提供。Space 是否分页读原始 transcript 没有核对（`SPACE_SDK_SEAMS.md:31` 只提到 `readHistory`） |
| ~~`history.entry.read`~~ | | `session.conversation.entryChunk`、`session.transcript.entryChunk` | 并入 `item.read`：历史页上的 ID 和搜索结果的 ID 都能直接交给 `item.read`，不需要单独的方法 |
| `history.search` ★ | 查 | `session.transcript.search` | 在原始 transcript 上搜索。对话视图和 transcript 的 ID 空间是分开的（`CLIENT_CONTRACT.md:509`），不加模式开关。M1a 已落地 |
| `history.resolveTurn` | 查 | `session.history.resolveTurn` | M1a 已转发，和 `session.fork`、`session.rewind` 同一批。细节见"分叉、回退、恢复和侧聊的落地细节" |
| `item.read` ★ | 查 | `session.view.item` | 文本、工具输入、工具的完整输出；附件改用 `blob.read`。M1a 已落地 |

历史两项的落地细节（2026-11-21，未经用户确认）：

- **一页的内容**：`{ items, status, issues, nextCursor?, newerCursor?, locatedItemId? }`。
  - `items` 和视图里的显示项是同一个形状，从旧到新。历史里的项一律是 `settled`；Run 还在写的内容只出现在视图里。
  - `nextCursor` 读更旧的一页，`newerCursor` 读更新的一页。到头了就没有对应的游标。
  - `status` 是 `resolved` 表示整段对话都读出来了；其他值配合 `issues` 说明哪一部分没读出来。
- **`limit` 数的是对话条目，不是显示项**。一条助手消息可以展开成一段文字加几个工具调用。范围 1 到 200，默认 50。
- **长文本和视图用同一条规则**：只发末尾一段，`textTotal` 给出全长，完整内容用 `item.read` 按 ID 读。v1 的历史页发的是开头一段，v1 的行为没有变。
  - 这样改是因为同一个显示项在视图里和历史里应该读起来一样，客户端只需要一套处理。
- **显示项的 ID 和视图里的是同一个**（FEATURE_312，2026-11-21 按 owner 决定改写，原来的 ID 带着读取时的对话版本）：
  - 用户消息是 `<sessionId>:input:<inputId>`；助手的文字和思考是 `<sessionId>:output:<outputId>:<种类>:<序号>`；工具调用是 `<sessionId>:output:<outputId>:tool:<callId>:0`。规则和视图从存档恢复显示项时相同，同一条消息在视图里、在历史页上、保存之后、压缩之后、窗口滑过之后都是同一个 ID。
  - 客户端用这个 ID 去重：错过了更新就重新订阅视图、拿到完整快照，再按 ID 和自己读过的历史合并。没有持久化的序号，没有 `since` 续读，也没有缺口标记。持久化的序号在每次压缩、回退和切换分支时都得重写。
  - 没有 `inputId` 或 `outputId` 的旧条目（引入这两个 ID 之前存下来的）和任务结果卡片，继续用带对话版本的 ID。视图对这些项用内容指纹加出现次数，一页读不到整段对话，算不出同样的出现次数。
  - 这些 ID 交给 `item.read` 时按当前的对话查找，查不到报 `not_found`，比如对话在读第一页之后被压缩、那条消息已经不在对话里。交给 `history.resolveTurn` 的 `{kind: 'item'}` 和视图的 ID 一样处理。
  - 为此改了 v1 的一处行为：按视图 ID 定位轮次原来要求这一项此刻就在某个视图的窗口里，没人订阅这个 Session、或者消息已经滑出 150 项的窗口，都报 `unproven_source`。现在窗口里没有时从存档的对话里核对这条消息，存过就能定位，编造的 ID 仍然定位不到。`CLIENT_CONTRACT.md` 记了这一条。
  - v1 的历史页不变，仍然是带版本的 ID。
- **游标属于读第一页时的那份对话**。之后 Session 继续往下聊，旧游标仍然读原来那份；Host 不再保留它时报 `resync_required`，客户端从最新一页重新读。
  - 不认识的游标同样报 `resync_required`。
  - 不带游标读最新一页时，如果正好撞上对话在写入，桥接层等 50 毫秒重试一次，和 v1 的客户端做法相同。
- **`history.search`**：结果是 `{ items: [{ itemId, role, at?, snippet }] }`，最相关的在前。
  - 搜的是整段对话，包括已经被压缩掉的部分。v1 默认只搜被压缩掉的部分，v2 不提供这个开关。
  - `limit` 是 1 到 20，默认 8。`query` 最长 1024 个字符。
  - `itemId` 可以交给 `item.read` 读全文，也可以交给 `history.read` 的 `around` 读它前后的一页。那一页的 `locatedItemId` 指出命中的是哪一项，用的是上面的稳定 ID。
  - 搜索结果的 `itemId` 指的是原始 transcript 里的一个条目，不是一个显示项，所以仍然带版本。
  - `around` 只接受搜索结果的 ID，传别的 ID 报 `resync_required`。`around` 和 `cursor` 一起传报 `invalid_params`。
- **没有带过来的 v1 字段**：页上的 `revision`、`sourceRevision`、`oversized`，显示项上的 `historyBoundary`，问题里的 `entryIds` 和 `occurrenceCount`，搜索结果里的 `entryIndex` 和 `revision`。它们是 v1 的 fork 和 rewind 定位用的，等那一批方法落地时再定 v2 的形状。
- **`history.entry.read` 并入 `item.read`**：v1 的 `session.view.item` 本来就认历史页的 ID 和搜索结果的 ID，两种都有测试。
- **`history.resolveTurn` 和 fork、rewind 同一批落地**：只有它们用它的结果。

分叉、回退、恢复和侧聊的落地细节（2026-11-21，未经用户确认）。五个方法不带 ★，是"由 v2 编解码转给现有实现"的第二批：

- **`history.resolveTurn`**：参数是 `{sessionId, turn?}`，结果是 `{turn?: {ref, index, excerpt, hasLaterTurn}, unavailable?}`。
  - 一轮是用户的一条消息加上 Session 对它的全部回答。
  - `turn` 有四种写法：`{kind: 'latest'}`（不给时的默认）、`{kind: 'previous'}`、`{kind: 'index', index}`（最早一轮是 0）、`{kind: 'item', itemId}`。
  - `itemId` 可以来自视图，也可以来自历史页或搜索结果。桥接层从 ID 本身看出它来自哪里，再按 v1 要的方式转述；v1 拿它和存下来的对话核对，编造的 ID 定位不到任何一轮。
  - `excerpt` 是用户那条消息的开头，最多 240 个字符，给界面显示"这是哪一轮"用。
  - 定位不到时没有 `turn`，`unavailable` 给出原因（`no_turns`、`no_previous_turn`、`turn_not_found`、`item_not_found`、`unproven_source`、`not_canonical`、`incomplete_turn`、`unresolved_history`）。它是开放字符串，客户端按"现在定位不到"处理。
- **轮次引用 `ref`**：一个不透明的字符串，最长 4096 个字符，交给 `session.fork` 和 `session.rewind` 的 `turn`。
  - 它代表读取那一刻的对话。对话之后变了（多了一轮、被回退、被压缩），用它的命令报 `resync_required`，客户端重新定位。
  - 现在的内容是 v1 轮次定位结果的四个字段（来源版本、起始条目、结束条目、当时的对话头）编成的 base64url。它不带签名：v1 会把这四项和存下来的对话逐一核对，而且调用方只能对自己已经能访问的 Session 用它。
  - 解不开的引用报 `invalid_params`（`turn_ref_invalid`）。别的 Session 的引用报 `resync_required`。
- **`session.fork`**：参数是 `{requestId, sessionId, turn?, before?, entry?, title?}`，结果是 `{session}`。
  - 都不给，复制整段对话。`turn` 保留到这一轮结束；再加 `before: true`，保留到这一轮之前（重试一条消息时用）。`entry` 保留到对话树的这一条，写条目 ID 或标签。
  - 分叉出来的 Session 沿用来源的设置和 Session 策略。
  - `turn` 和 `entry` 一起给、只给 `before` 不给 `turn`，报 `invalid_params`。`entry` 找不到、来源在跑、来源是侧聊，报 `conflict`。
  - v2 不能指定新 Session 的 ID。v1 的 `newSessionId` 留给 v1。
- **`session.recover`**：参数是 `{requestId, sessionId, title?, reason?}`，结果是 `{session}`。新 Session 从来源的一份摘要开始，摘要不调用模型。来源没有对话或在跑时报 `conflict`。
- **分叉和恢复的重试安全**：用的是 `session.create` 的办法，做在 runtime 领域里。
  - v1 的 `session.fork` 和 `session.recover` 多了可选的 `requestId`。新 Session 的 ID 由它算出来（`sha256(方法名 + ":" + requestId)` 的前 32 个十六进制字符），请求内容的摘要记在新 Session 的 `runtimeInfo.creationRequest` 上。
  - 同一个请求重发，返回第一次建的那个 Session，Host 重启之后也一样。这一步在"来源是否空闲"和"对话有没有变"的检查之前，所以来源之后又聊了几轮，重发照样得到答复。
  - 同一个 `requestId` 换了内容报 `conflict`。`requestId` 和 `newSessionId` 一起给报 `invalid_params`。
  - 三个方法各用各的前缀，同一个 `requestId` 用在 create 和 fork 上互不相干。
- **v1 的两处修正**（v1 和 v2 都受益）：
  - `session.fork` 的 `newSessionId` 如果是一个已经存在的 Session，原来只检查名字格式，然后把分叉写进那个 Session，覆盖它的对话。现在报 `conflict`。先写的失败测试确认了这个问题。
  - 分叉和恢复原来会把来源的 `creationRequest` 一起抄给新 Session。抄过去之后，新 Session 会被当成来源那次创建请求的产物。现在不抄。Session 策略照旧沿用。
- **`session.rewind`**：参数是 `{requestId, sessionId, turn?, entry?, ifActiveEntryId?}`，结果是 `{session}`。
  - 必须说明退回到哪里：给 `turn`，或者给 `entry` 加 `ifActiveEntryId`。`ifActiveEntryId` 是客户端读对话树时的 `activeEntryId`；`turn` 自己带着这项检查。其他组合报 `invalid_params`。
  - v1 不给目标时退回到倒数第二条用户消息。v2 没有这种用法：这样的命令每重发一次就多退一步。REPL 的 `/rewind` 不带参数时，改成先读对话树或先定位上一轮，再带着目标调用。
  - 重发按状态判断，不看 `requestId`：对话已经停在目标条目上，就直接返回 Session 现在的样子，什么都不改。桥接层为此先读一次对话树。
  - 对话在客户端读过之后变了，报 `resync_required`，`reason` 是 `head_changed`。所以一个迟到的重复请求不会把之后新聊的几轮截掉。
  - `entry` 找不到、Session 在跑，报 `conflict`。
  - 回退不删除任何东西。被退掉的条目留在对话树里，用 `session.branch.select` 可以回去。
- **`session.side.open`**：参数是 `{requestId, sessionId}`，结果是 `{session}`。v1 本来就为每条分支、每个请求方只保留一个侧聊，重发得到同一个，所以不看 `requestId`。侧聊不能再开侧聊，也不能被分叉，报 `conflict`。
- **`resync_required` 的 `reason`**：v1 的 `resync_required` 带着"是什么变了"（`head_changed`、`source_changed`、`revision_mismatch`、`selection_expired`、`writer_active`）。桥接层原来把它换成了 v1 的错误码本身，现在原样带到 v2 的 `reason`。
- **已知缺口**：
  - `entry` 写的是标签时，回退的重发认不出来（桥接层只比较条目 ID），会报 `resync_required`。客户端重读对话树就能看到回退已经生效。
  - Host 在"写下新 Session"和"抄设置、加上'分叉自……'的通知"之间停掉，重发拿到的是没有这两样的 Session。`session.create` 应用 Agent 设置也有同样的窗口。
  - 分叉出来的 Session 还会沿用来源 `runtimeInfo` 里的其他项（`temporary`、`sessionPromotion`、`workModeLocked`），这一批没有逐项核对该不该沿用。
  - 轮次定位每次都读整段对话（runtime 有一份短时间的缓存），很长的对话上的耗时没有量过。
- **没有验证的**：按搜索结果的 ID 定位一轮；按工具项的 ID 定位一轮；被压缩过的对话上的定位、分叉和回退；`reject` 策略下的 Session 的侧聊；service 角色调用这五个方法；带附件的轮次。

**数据面：输入与 Run（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `input.submit` ★ | 命 | `input.submit`、`run.input.submit`、`run.start` | M1a 已落地。已核实：one-shot CLI 用的是 `inputs.submit`；A2A 和内嵌的 ACP 在进程内直接调 Runtime，传的是函数，本来就过不了线；经 RPC 的产品路径只有带工具调用的 `run.start`，对应下面的 `run.startTool`。所以 v2 不提供通用的 `run.start`。`run.input.submit` 没有产品调用方。Space 是否发原始的 `run.start` 没有核对（`SDK_MIGRATION.md:796` 已经让它改用 `inputs.submit`） |
| `input.get` ★ | 查 | `input.read` | M1a 已落地 |
| `input.withdraw` ★ | 命 | `input.withdraw` | M1a 已落地 |
| `run.startTool` ★ | 命 | `run.start`（带工具调用） | 用户明确指定的工具。M1a 已落地 |
| `run.get` ★ | 查 | `run.get` | M1a 已落地 |
| `run.list` ★ | 查 | `run.list` | M1a 已落地 |
| `run.wait` ★ | 查 | `run.await` | 必须带等待上限，到期返回 `timeout`。M1a 已落地 |
| `run.stop` ★ | 命 | `run.abort` | M1a 已落地 |
| `run.recover` ★ | 命 | `run.recover` | M1a 已落地 |

输入与 Run 的落地细节（2026-11-21，未经用户确认）：

- **资源自己的 ID 叫 `id`，引用别的资源叫 `<种类>Id`**。Session、Run、输入、显示项、交互、授权都这样，视图里 `runs[]` 和 `queue[]` 的条目也是。
- **输入**：`{id, state, runId?, admissionError?}`。`state` 是封闭的四个值，沿用 v1 的叫法：
  - `queued`：在排队，还能撤回；
  - `submitted`：已经进入对话，`runId` 是处理它的 Run；
  - `withdrawn`：投递之前被撤回；
  - `dropped`：它要作用的 Run 先结束了，没有进入对话。
- **`input.submit`**：`{requestId, sessionId, text, delivery?, targetRunId?, localAttachments?}`。
  - `text` 必须有非空白字符，否则报 `invalid_params`（v1 报的是 `conflict`）。
  - `delivery` 是 `immediate`、`after_turn`、`steer`、`redirect`。后两个作用在一个进行中的 Run 上，不带 `targetRunId` 报 `invalid_params`（`target_run_required`）。
  - 附件和项目一样分两种叫法。`localAttachments` 是 Host 本机的文件路径，只有 owner 能发，其他角色发了报 `forbidden`。`attachments`（blob 引用）随 M1b 的 `blob.*` 加入。v1 的 `mimeType` 别名没有带过来，只留 `mediaType`。
  - Run 选项 `budget` 和 `prompt` 见"Run 的限制与选项的落地细节"。`tokenBudget` 没有带，理由和 Session 策略里一样。
- **`input.get`**：查不到报 `not_found`（`input_not_found`）；v1 返回 `null`。
- **`input.withdraw`**：返回原来提交的内容 `{id, text, delivery?, targetRunId?}`（v2 现在不返回它的 Run 选项），方便改了之后用新 ID 重发；owner 另外拿回 `localAttachments`。重复调用返回同样的内容。
- **Run**：`{id, sessionId, phase, inputId?, provider, model?, startedAt?, endedAt?, stop?, outcome?}`。
  - 没有 `outcome` 就是还在进行。客户端按这一点分支，不按 `phase`；`phase` 是开放字符串，只用于显示。
  - 时间都是 UTC 毫秒。
  - `stop` 是 `{requestedAt?, confirmed}`，有人请求过 Stop 才出现。
- **`RunOutcome`**：`{status, effects, code, message?, failure?}`。
  - `status` 沿用 v1 的含义：`cancelled` 是还没开始做事就停了；`interrupted` 是做到一半停下，用户 Stop、Host 退出和到了时间上限都算，由 `code` 区分（例如 `interrupted`、`runtime_restarted`、`time_limit`）。
  - `effects` 来自 v1 的终态事实。v1 更早的版本没有记终态事实，这种 Run 的 `effects` 一律是 `unknown`。
  - `status: unknown` 表示 Host 现在说不清这个 Run 结束没有（例如它属于另一个还不确定死活的 Host 进程）。之后再读可能换成真实的结局。
  - `failure` 是 `{kind, stage, code, safeMessage, detail?, skillName?, retryAfterMs?}`，只在 `failed` 而且 Host 记下了失败细节时出现。
  - **推迟的字段**：`finalText`、`outputItemId`、`usage`、`writtenFiles` 和 `limitReached`。它们现在只在进程内的执行结果里，持久化的 Run 状态里没有，Host 重启后就读不到。等把 one-shot CLI 和 SDK 的 `run()` 搬到 v2 时再决定：要么把它们持久化，要么让调用方从视图和 `item.read` 取。
- **`run.list`**：`{sessionId, limit?, cursor?}`，`sessionId` 必填，最新的在前，`limit` 是 1 到 200，默认 50。游标是上一页最后一个 Run 的 ID；这个 Run 不在了报 `resync_required`（`cursor_expired`）。分页现在是桥接层对 v1 的整份列表做的。
- **`run.wait`**：`{runId, timeoutMs?}`，`timeoutMs` 是 0 到 60000，默认 30000。
  - Run 有了结局就返回 `{run}`。到了上限还没有，报 `timeout`（`run_in_progress`）；Run 照常继续，客户端可以马上再等。
  - 放弃等待之后总是再读一次 Run，所以恰好在放弃那一刻结束的 Run 也会被正常返回。
  - v1 对"属于别的 Host 进程的 Run"会立刻返回一个还没结束的状态。v2 这时照样等到上限才报 `timeout`，否则客户端会原地打转。
- **`run.stop`**：`{requestId, runId}`，结果是空对象，表示请求记下了；Run 怎么结束的看它的 `outcome`。可以重复发。
- **`session.cancel`**：`{requestId, sessionId, ifRunId}`，结果是空对象。`ifRunId` 是 v1 的 `expectedRunId`：只有它还是这个 Session 当前的 Run 时才停，晚到的 Stop 不会误停之后才开始的工作；不是了报 `conflict`。同一个 `requestId` 重发返回成功。
- **`run.startTool`**：`{requestId, sessionId, tool, input, text}`，结果是 `{run}`。
  - 不经过模型，直接执行用户点名的一个工具。工具照常过权限检查，和模型调用的工具走同一道门。
  - `text` 是用户敲的原文，作为用户消息进入对话；工具的输出也进入对话。
  - `requestId` 就是输入的 ID，和 `input.submit` 共用一个 ID 空间。同一个请求重发，返回原来的 Run，Host 重启之后也一样；同一个 ID 换了内容报 `conflict`。
  - Host 没有这个工具，或者工具被拒绝：请求照样被受理，得到的是一个失败的 Run，不是报错。
  - Session 正在跑的时候报 `conflict`。
  - v1 的 `options.toolInvocation` 是 §4.5 列出的"能直接触达 Host 的参数"之一。v2 里它只能通过这个方法进来，形状由 schema 固定。
- **`command.execute`**（M1a 已落地，2026-11-21，未经用户确认）：`{requestId, sessionId, name, args?}`，结果是 `{run?, success?, message?}`。
  - 按 `command.list` 给出的名字执行一个命令，相当于用户敲 `/name args`。准备和执行在 Host 上一步完成，对应 v1 的 `invocations.executeCommand`。
  - 结果有两种。命令通过模型或工具完成时启动一个 Run，结果带 `run`，怎么结束的看 Run 的 `outcome`。命令由 Host 直接做完时（扩展注册的 configuration 命令、查看帮助）没有 Run，结果带 `success`。`message` 是命令要对用户说的话，两种都可能有。
  - Session 正在跑或者正在压缩的时候报 `conflict`。例外：`args` 的第一个是 `help`、`--help` 或 `-h` 时只查看命令的说明，任何时候都能答。
  - 名字对不上任何用户可执行的命令，报 `not_found`。
  - **重试**：`requestId` 就是输入的 ID，和 `input.submit`、`run.startTool` 共用一个 ID 空间。
    - 启动了 Run 的命令：同一个请求重发，返回原来的 Run。Run 还在跑的时候重发也一样，不会因为 Session 忙被拒绝。Host 重启之后也认得，因为靠的是已经存盘的 Run 记录。同一个 ID 换了命令或参数报 `conflict`。
    - Host 直接做完的命令：Host 把回答记在内存里，同一个请求重发返回原回答，处理函数不会再跑一遍；同一个 ID 换了内容报 `conflict`。执行失败（处理函数抛错）不记，同一个 ID 可以再试。
    - 这两条做在 runtime 领域里，v1 的 `invocations.executeCommand` 同样受益。产品客户端每次执行都用新的随机 ID，行为不变。
  - **已知缺口**：
    - Host 直接做完的命令，回答只记在内存里，最多记最近 256 条。Host 重启之后，或者回答被挤掉之后，同一个请求重发会让处理函数再跑一遍。按文档，这类命令只用来配置或查看扩展宿主；需要更强的保证时要给回答落盘，现在没有做。
    - configuration 命令先跑处理函数、再由处理函数的返回值启动 Run 时：Host 重启后重发，返回原来的 Run，处理函数不再跑，但原来的 `message` 丢了，也不比对命令内容。
    - configuration 命令在 Host 上直接执行，不是 Run，所以不受 Session 策略里工具上限的约束。它们是 Host 的 owner 装的扩展代码，数据面的任何角色都能调用，和 v1 一致。
  - **没有验证的**：带策略的 Session 里执行经工具运行的扩展命令。`/review` 和 `/agents lean` 走另外两个方法，见下一条。
- **`review.start`、`agent.reviewLean`**（M1a 已落地，2026-11-21，未经用户确认）：
  - `review.start` 是 `{requestId, sessionId, args?}`，`agent.reviewLean` 是 `{requestId, sessionId}`。结果和 `command.execute` 同形：`{run?, success?, message?}`。
  - `review.start` 相当于用户敲 `/review args`，`args` 原样交给 Host 解析（比较范围、`--lean`、`--workflow`、`--` 之后的关注点）。没有改动可评、参数读不懂时没有 Run，结果是 `success` 加 `message`。`--workflow` 的评审也是一个 Run（工作流 Run），一样带 `run`。
  - `agent.reviewLean` 相当于用户敲 `/agents lean`：让模型把 KodaX 的"小而准的改动"指引补进项目的 AGENTS.md，已有同义内容就不改。模型可能改 AGENTS.md。项目没有 AGENTS.md 时结果是 `success: false` 加 `message`。
  - 准备（抓 diff、读 AGENTS.md）和启动在 Host 上一步完成，v1 的两个 `prepare*` 方法不进 v2。Session 正在跑或者正在压缩时报 `conflict`。
  - **重试**：`requestId` 就是输入的 ID，和 `input.submit`、`command.execute` 共用一个 ID 空间。
    - 同一个请求重发，返回原来的 Run，不再抓一遍 diff。Run 还在跑时重发也一样，不会因为 Session 忙被拒绝。
    - Host 重启之后也认得：靠存盘的 Run 记录比对用户敲的那行字（`/review args`）。这一条要紧，因为改动可能已经提交，重新准备会答"没有改动"，而不是原来的 Run。
    - 同一个 ID 换了参数，或者换成另一种命令，报 `conflict`。
    - 没有启动 Run 的回答（没有改动、没有 AGENTS.md）只记在内存里，和 `command.execute` 的同一张表，最多 256 条。
    - 这几条做在 runtime 领域里（`runtime-product-commands.ts` 和运行服务的 `acceptedRun`），v1 的 `invocations.startReview`、`invocations.startAgentsLean` 同样受益。产品客户端每次都用新的随机 ID，行为不变。
  - **没有验证的**：`--workflow` 评审经 v2 发起；带策略的 Session 里发起评审。
- **`run.recover`**：`{requestId, runId}`，结果是 `{run}`。
  - 用途：Host 停下来时，正在跑的 Run 如果正好停在一个可以接着做的点上，会留在 `recovering` 阶段，没有 `outcome`。新的 Host 起来之后，由客户端发这个命令让它接着跑。Run 的 ID 不变。
  - 只有发起这个 Run 的身份能恢复它，别的身份报 `forbidden`。owner 和 user 是同一个人，谁来都行。
  - 对任何 Run 发都安全：不在等待恢复的 Run（已经在跑、已经结束）按现状返回 `{run}`。所以重发、两个客户端同时发，结果都一样，模型只被调用一次。
  - 在等待但接不下去时报 `conflict`：运行它的 Host 还活着（它会自己接着跑），或者对话在它停下之后又往前走了。后一种 Run 用 `run.stop` 结束。
  - 接着跑时用的 provider、模型和推理强度取 Session 现在的设置，和产品客户端现在的做法相同。
  - **还做不到的**：原来用了客户端凭据或者客户端提供的工具的 Run，恢复时要重新绑定，这依赖 M1b 的反向调用。在那之前这类 Run 报 `unavailable` 或 `internal`。
  - **客户端怎么知道该发这个命令**（M1a 已落地，2026-11-22，未经用户确认）：Host 不另给"等待恢复"的事实，SDK 按 v1 恢复客户端的做法判断。
    - 条件是 Run 的 `phase` 等于 `recovering`，并且客户端刚重连到的是另一个 Host 实例，即握手里的 `host.id` 变了。`host.id` 是 Host 的 `runtimeId`，每次启动随机生成。
    - Host 重启留下的 Run 和"上下文放不下、等用户换模型"的 Run，在视图里看起来一样。区别只在原来的 Host 还在不在，`host.id` 变了说明它不在了。
    - 每个 Run 在同一个 Host 实例下最多发一次。接着跑之后又因为放不下而停住的 Run，等的是人，不该再自动发。
    - 这个客户端自己用 `run.stop` 或带 `ifRunId` 的 `session.cancel` 停过的 Run 不发。
    - 发失败只报给 `onError`，不影响视图。
- **找不到 Run** 在 runtime 里现在带 `not_found` 码；v1 以前报的是 `internal_error`。

**数据面：交互与授权记录（所有角色；service 不能回答人的审批）**

| v2 方法 | 原语 | 对应的 v1 方法 |
|---|---|---|
| `interaction.list` ★ | 查 | `interaction.list`（M1a 已落地） |
| `interaction.respond` ★ | 命 | `interaction.respond`（M1a 已落地） |
| `permission.grant.list` ★ | 查 | `permission.grants.list`（M1a 已落地） |
| `permission.grant.revoke` ★ | 命 | `permission.grants.revoke`（M1a 已落地） |

交互与授权的落地细节（2026-11-21，未经用户确认）：

- **交互**：`{id, sessionId, runId, createdAt, expiresAt?, kind, request}`，时间是 UTC 毫秒。
  - `kind` 沿用 v1 的四种：`question`（选一个或多个选项）、`question_multi`（一次问几个问题）、`question_input`（要一段文字）、`permission`（工具动手之前的审批）。以后的 revision 可以加新的种类，客户端遇到不认识的就不回答。
  - `request` 是 v1 的 `options` 改的名字，内容由 `kind` 决定。
  - 审批的 `request` 是 `{toolName, toolCallId?, reason?, extensionAsks?, risk?, inputPreview?, plan?, grantSuggestions?}`。`executionCwd` 是 Host 路径，只有 owner 能看到。
  - `grantSuggestions[]` 是 `{id, kind, label}`，`kind` 是 `session` 或者 `persistent`。`label` 是给人看的一句话，说明这个回答覆盖什么；路径类的授权会在里面写出 Host 上的完整路径。它和工具输出一样算展示文本，对所有角色原样给出，不是引用。
- **`interaction.list`**：`{sessionId?}`，不带就列出所有 Session 的。
- **`interaction.respond`**：`{requestId, interactionId, response}`，返回 `{status}`。
  - `response.kind` 和交互同名的四种是回答：`question {answer}`、`question_multi {answers}`（按问题原文作键）、`question_input {text}`、`permission {decision}`。种类对不上报 `invalid_params`。
  - `decision` 是 `allow_once`、`allow_session {suggestionId}`、`allow_always {suggestionId}`、`reject {reason?}`。`suggestionId` 必须是 Host 在这个交互里给出的，自己编的报 `invalid_params`。
  - `skip {reason?}` 只能用在提问上，表示不回答；`reason: non_interactive` 告诉模型现在没有人可以问。用在审批上报 `invalid_params`。
  - `dismiss {reason?}` 是 v1 的 `cancel` 改的名字，表示人把它关掉了：提问算没回答，审批算拒绝。
  - `status` 是 `answered`、`unanswered`、`dismissed`、`already_resolved`。前三个表示这次回答结算了交互。
  - 首个有效回答生效。之后的回答（包括同一个 `requestId` 的重发）得到 `already_resolved`，不改变任何东西；交互不存在或者已经超时也是 `already_resolved`。Host 不记是谁的回答生效了，交互怎么结束的看 Session 视图。
  - service 角色不能回答，报 `forbidden`。
- **授权**：`{id, sessionId?, toolName?, label?, persistence?, createdAt?}`。没有 `sessionId` 的是永久授权。
- **`permission.grant.list`**：没有参数，返回 `{items, revision}`。授权有增减 `revision` 就变。不分页。
- **`permission.grant.revoke`**：`{requestId, grantId, ifRevision?}`，结果是空对象。
  - 授权已经不在了也返回成功，所以可以重发。
  - 带 `ifRevision` 时，授权在那之后变过就报 `conflict`（`revision_mismatch`）。不带就直接撤销；按 ID 撤销一条授权不会误伤别的，所以它不是必填的。v1 的 `expectedRevision` 也跟着改成了可选。
- **测试 Host 要按真实 Host 的方式启动**（`sharedDaemonHost: true`）。不这样，提问会被直接当成没人回答，而不是等客户端来答。
- **待定**：网络角色看到的 `label` 要不要改成相对项目的路径。要改就得改 Host 生成标签的地方，v1 的显示文字也会跟着变。

**数据面：Blob（所有角色，M1b）**

| v2 方法 | 原语 | 对应的 v1 方法 |
|---|---|---|
| `blob.begin` | 命 | `artifact.create`（只接受路径） |
| `blob.write` | 命 | 新增 |
| `blob.commit` | 命 | 新增 |
| `blob.read` | 查 | `artifact.get`、`session.view.item` 的附件分块 |

`artifact.delete` 删除：blob 随 Session 删除。

**数据面：只读目录与统计（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `agent.list` ★ | 查 | `agent.list`（新增） | M1a 已落地。列出创建会话时能选的 Agent，见"按名字选 Agent 的落地细节"。`agent.get` 不做（2026-11-21 改，未经用户确认） |
| `command.list` ★ | 查 | `command.list` | M1a 已落地。`projectRoot` 只有 owner 能传；`path` 只发给 owner。2026-11-21 加了 `project` |
| ~~`command.resolve`~~ | | `command.resolve` | 不进 v2（2026-11-21 改，未经用户确认），见下面的落地细节 |
| `skill.list` ★ | 查 | `skill.list` | M1a 已落地。去掉恒为 `true` 的 `userInvocable` 和已弃用的 `userInvocableOnly`。2026-11-21 加了 `project` |
| `skill.get` | 查 | `skill.describe`、`skill.read` | M1a 已转发。Host 路径只发给 owner |
| `tool.list` | 查 | `tool.catalog` | M1a 已转发 |
| `provider.list` ★ | 查 | `provider.list`、`model.list` | M1a 已落地。`model.list` 不进 v2（2026-11-21 改，未经用户确认）：它在 v1 里就是 `provider.list` 的投影，每个 provider 自带 `models`，SDK 从这里算出模型目录 |
| `provider.reasoning.efforts` | 查 | `provider.reasoning.efforts` | 模型选择器要用的只读目录，所以放在数据面。M1a 已转发 |
| `mcp.tool.list` | 查 | `mcp.tool.list` | 挪到"用户设置"的 MCP 那一批（2026-11-21 改，未经用户确认），M1a 已落地 |
| `stats.get` | 查 | `session.facts.read` | M1a 已转发 |
| `stats.requests` | 查 | `session.facts.requests` | M1a 已转发。分页，最早的在前 |
| `stats.tools` | 查 | `session.facts.tools` | M1a 已转发。分页，最早的在前 |

只读目录与统计的落地细节（2026-11-21，未经用户确认）。七个方法不带 ★，是"由 v2 编解码转给现有实现"的第三批：`skill.get`、`tool.list`、`provider.reasoning.efforts`、`command.readPrompt`、`stats.get`、`stats.requests`、`stats.tools`。

- **`command.resolve` 不进 v2**：它等于 `command.list` 按名字或别名过滤，客户端拿到列表之后自己就能做。本仓库没有产品调用方。Space 有没有在用没法核对（见 §12 第 1 条）。
- **`mcp.tool.list` 挪到 `mcp.server.*` 那一批**：它名义上是读，实际上不带 `forceRefresh` 也会连接 MCP 服务器并写缓存；一台服务器失败，整个列表失败；`forceRefresh` 本身是一个命令。这些要和 MCP 服务器的管理方法一起定。已经定了，拆成 `mcp.tool.list` 和 `mcp.tool.refresh`，见"用户设置"里 MCP 的落地细节。
- **目录方法的 `project`**：`command.list`、`skill.list`、`skill.get` 原来只有 `projectRoot`（Host 路径，只有 owner 能传），其他角色看不到任何项目自己的命令和 Skill。现在和 `session.create` 一样，可以用 `project`（工作区里的相对路径）指定。
  - 两个都不给时，Host 有工作区就按工作区根目录列，和不指定项目创建的 Session 所在的目录一致。Host 没有工作区时沿用 v1 的默认值（Host 进程的当前目录）。
  - `project` 和 `projectRoot` 一起给报 `invalid_params`。`project` 不存在报 `not_found`（`project_not_found`），指到工作区外面报 `invalid_params`。
- **`skill.get`**：参数是 `{name, project?, projectRoot?}`，结果是 `{skill?}`。
  - `skill` 是 `skill.list` 的那一项，加上 `content`（SKILL.md 的正文，原样返回，不展开变量，不执行其中的 shell）和它带的文件：`scripts`、`references`、`assets`、`templates`、`resources`，每个文件是 `{name, relativePath}`。
  - owner 另外拿到 `path`、`skillFilePath` 和每个文件的 `path`。其他角色拿不到 Host 路径。
  - `name` 要完全一致，区分大小写。没有这个 Skill 时结果里没有 `skill`，不报错。
- **`tool.list`**：参数是 `{sessionId}`，结果是 `{items: [{name, sideEffect, planModeAllowed}]}`。列的是 Host 上登记的全部工具。`sideEffect` 是开放字符串（现在有 `readonly`、`mutates-fs` 等）。
  - 它不按 Session 策略过滤：策略里 `tools` 禁掉的工具也在列表里。要不要过滤留到做 Session 策略界面时再定。
- **`provider.reasoning.efforts`**：参数是 `{provider, model?}`，结果是 `{items: string[]}`。Host 不认识的 provider 得到通用的那一组，不报错。
- **`command.readPrompt`**：参数是 `{sessionId, name, args?}`，结果是 `{prompt?: {title, text}}`。
  - `text` 是命令文件的正文，后面空一行接上用空格连起来的 `args`，和执行这个命令时发给模型的开头一致。不执行任何 shell。
  - Session 里没有这个命令、命令由 Host 自己执行（内置命令和扩展命令）、命令不允许用户调用，这三种情况结果里都没有 `prompt`。
- **统计的三个方法**：
  - `stats.get` 参数是 `{sessionId}`，结果是 `{stats}`：`revision`、`coverage`（`complete` 或 `partial`）、`issues`、`usage`（六项 token 合计）、`requestCount`、`requestsWithoutUsage`、`physicalRequestCount`、`operationCount`、`contexts`（每个上下文最近一次的预算估算）。
  - `stats.requests` 和 `stats.tools` 参数是 `{sessionId, limit?, cursor?}`，结果是 `{items, nextCursor?, revision}`。`limit` 是 1 到 500，默认 100。
  - 字段改名：请求的 `requestId`、`logicalRequestId`、`previousRequestId` 改叫 `id`、`logicalId`、`previousId`，因为 v2 里 `requestId` 专指命令的意图。token 的缓存项改叫 `cacheReadTokens`、`cacheWriteTokens`，和 Session 视图一致。
  - 时间都是 UTC 毫秒整数。`sessionId` 和 `runtimeId` 不返回；上下文里和 `target` 重复的 `runId`、`turnId` 不返回。
  - `target` 说明一条统计属于谁：`run`、子代理的一轮 `actor_turn`，或者 Host 自己做的 `operation`（现在只有压缩）。`kind` 是开放字符串。
  - 工具调用的 `sandbox` 里，`degradedReadRoots` 是 Host 路径，只发给 owner。
- **统计游标过期**：v1 在这种情况下报 `conflict`，和别的冲突分不开。现在 v1 的错误多带一项 `data.conflict: 'cursor_expired'`（错误码不变），桥接层把它转成 `resync_required`，`reason` 是 `cursor_expired`，客户端从第一页重读。
  - 游标在两种情况下过期：Host 重启；Host 只在内存里留最近读过的 8 个 Session 的统计，更早的被换出之后，指向它的游标失效。前一种有测试，后一种没有（换出的时机不确定）。
- **实现时发现的事实**：
  - Run 结束之后，Host 自己还会为它发模型请求（测试里看到的是记忆复盘，`purpose` 是 `sidecar`，在 Run 结束后约 0.6 秒），记在同一个 Run 名下。所以 `run.wait` 返回之后，这个 Run 的请求数还会涨。按 `purpose` 可以把它们和 Run 自己的请求分开。
- **已知缺口**：
  - Skill 的登记表在 Host 进程里只有一份，`projectRoot` 换了就整个重建。一个 Host 同时服务多个项目时，交替读两个项目的目录会反复重建，并发时可能读到另一个项目的列表。这是 v1 就有的问题，M1a 没有动。
  - 读统计可能写盘：发现上一个 Host 进程留下没结束的请求或工具调用时，读的时候把它们标成 `unknown` 并写一条恢复记录。所以这三个方法不是严格只读，重复调用是安全的。
  - Host 没有工作区时，目录方法默认按 Host 进程的当前目录列，远端客户端会看到那个目录的项目命令和 Skill。配了 `server.workspaceRoot`（M1b）之后没有这个问题。
  - `stats.get` 每次把全部请求过一遍来求和，很长的 Session 上的耗时没有量过。
- **没有验证的**：子代理的统计（`actor_turn`）；压缩的统计（`operation`）；回退到备用 provider 的请求链（`previousId`、`route`）；带 `degradedReadRoots` 的沙箱记录（只在 Windows 沙箱下出现）；扩展带来的工具出现在 `tool.list` 里；service 角色调用这七个方法；`command.readPrompt` 读用户目录（`~/.kodax/commands`）里的命令。

**数据面：命令与评审（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `command.execute` ★ | 命 | `invocations.executeCommand` | M1a 已落地。准备和执行是一步；细节见"输入与 Run 的落地细节" |
| `command.readPrompt` | 查 | `invocations.readCommandPrompt` | M1a 已转发，见"只读目录与统计的落地细节" |
| `review.start` | 命 | `invocations.prepareReview`、`invocations.startReview` | M1a 已落地，见"输入与 Run 的落地细节" |
| `agent.reviewLean` | 命 | `invocations.prepareAgentsLean`、`invocations.startAgentsLean` | M1a 已落地，同上 |

`invocations.prepareSkill` 删除（已核实）：`input.submit` 已经在 Host 上解析并展开 Skill（`sdk-runtime.ts:13131-13167`）。这个方法也不是无副作用的预览，展开时可能执行动态上下文里的 shell。本仓库只有客户端封装在调用。界面要预览 Skill 时用 `skill.get`。

**数据面：运行中的子代理（所有角色）**

v1 的 `agents.*` 同时指"已安装的 Agent 定义"和"运行中的子代理"。v2 把后者改叫 `actor.*`，和代码里的 Actor 一致。

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `actor.tree` | 查 | `agents.tree` | M1a 已转发 |
| `actor.get` | 查 | `agents.detail` | M1a 已转发。Host 路径只发给 owner |
| `actor.output` | 查 | `agents.output` | M1a 已转发。Host 路径只发给 owner |
| `actor.wait` | 查 | `agents.wait` | M1a 已转发。等待上限 60 秒，默认 30 秒 |
| `actor.spawn` | 命 | `agents.spawn` | 挪到 M1b（2026-11-21 改，未经用户确认），见下面的落地细节 |
| `actor.send` | 命 | `agents.send` | M1a 已转发。按 `requestId` 去重 |
| `actor.followup` | 命 | `agents.followup` | 已核实，不并入 `actor.send`。`send` 只往信箱里放一条消息，不会开新的 Turn；`followup` 需要控制权限和 revision 检查，要绑定凭证，可能开新的 Turn，返回值也不同（`controller.ts:509-534`、`561-624`）。Space 用的是 `followup`。挪到 M1b（2026-11-21 改，未经用户确认），见下面的落地细节 |
| `actor.interrupt` | 命 | `agents.interrupt` | M1a 已转发。必须带 `turnId` |

`agents.events` 删除：并入会话视图。

`agents.preflight` 删除（已核实）：它等于 `agents.describe` 加一次配置 revision 比对，针对的是可派发的外部 Agent 定义，不是 `actor.spawn`。启动任务时 Host 自己会做同一个检查并报告原因（`executor-plane.ts:994-1006`）。本仓库没有产品调用方，只有 embedder-guide 里的一个示例。

子代理的落地细节（2026-11-21，未经用户确认）。转发了六个方法：`actor.tree`、`actor.get`、`actor.output`、`actor.wait`、`actor.send`、`actor.interrupt`。客户端都是以根（`/root`）的身份读和操作。

- **`actor.spawn` 和 `actor.followup` 挪到 M1b**：两个都可能开新的 Turn。v1 要求为新 Turn 显式绑定一份限定范围的凭证（`credential`/`authorization`），`user` 角色不能传这两个参数；v2 要等 M1b 的租约绑定到 Session 之后才有对应的东西。另外它们现在不经过 `startRun`，Session 策略（工具、时长）管不到它们开的 Turn，先补上再开放。模型自己调用 `spawn_agent`/`followup_task` 不受影响。
- **结果的形状**：
  - `actor.tree` 是 `{items, activeNonRootTurns, maxConcurrentThreads, revision}`，`items` 含根。去掉恒为 `/root` 的 `rootPath` 和内部的 `admissionRevision`。
  - `actor.get` 是 `{actor, turns, mailbox}`。信箱消息的 `content` 改叫 `text`，和 `actor.send` 的参数一致；消息上记的 `requestId` 不返回。
  - Turn 里执行器自己的 `checkpoint` 不返回给任何角色。`artifacts`、`artifactDetails`（现在是子代理写过的文件的 Host 路径）和执行器的 `metadata`（实际用的 provider、model、失败详情）只发给 owner。`actor.output` 的 `artifacts`、`artifactDetails` 也一样。
  - 时间都是 UTC 毫秒整数。
- **`actor.wait`**：参数 `{sessionId, afterSequence?, timeoutMs?}`，结果 `{event?}`。等待上限 60 秒，默认 30 秒，和 `run.wait` 一致（v1 没有上限）。到时没有事件就返回空结果。它是"该重读树了"的提示，不是完整记录：Host 只留最近 2048 个事件，根已经确认过的子代理结束事件会被跳过。
- **重试规则**：
  - `actor.send`：v1 原来每次都投一条新消息，重试会重复投递。现在消息上记下 `requestId`（桥接层发的是 `subject:requestId`），同一个发送者对同一个收件人重发同一个 `requestId` 时返回已经投过的那条，不写盘，也不产生事件。改的是控制器（`controller.ts` 的 `send`），v1 的 `agents.send` 也多了可选的 `requestId`。
  - `actor.interrupt`：必须带 `turnId`。这个 Turn 正在进行就中断它；已经结束（被中断或者跑完）就什么也不做，正常返回；这个子代理从来没有这个 Turn 报 `not_found`（`turn_not_found`）。这样重试和迟到的重复请求都不会打断后来的 Turn。v1 的 `agents.interrupt` 多了可选的 `turnId`，不带时行为不变（空闲报 `no_active_turn`）。
- **错误码**：v1 原来把子代理的错误码几乎都报成 `internal_error`（`normalizeRuntimeDaemonError` 只认守护进程自己的码）。现在按含义映射，原来的码放在 `data` 里（冲突类放 `data.conflict`，其余放 `data.reason`），v2 的 `reason` 就是这个码：
  - `actor_not_found`、`turn_not_found` → `not_found`；
  - `actor_closed`、`name_collision`、`no_active_turn`、`unsupported_operation`、`actor_owner_conflict`、`actor_owner_unknown`、`session_archived` → `conflict`；
  - `invalid_*`、`message_cycle_detected` → `invalid_params`。
  - `agents.output` 给一个不属于这个子代理的 `turnId` 原来报 `permission_denied`，改成 `turn_not_found`（Turn ID 按路径和序号生成，没有保密的必要）。
  - 桥接层原来只对 `resync_required` 透传 `data.reason`，现在对所有错误码透传 `data.reason` 和 `data.conflict`。
  - `session_archived` 的映射对所有方法生效：对归档 Session 发输入，v1 客户端原来看到 `internal_error`，现在看到 `conflict`。
- **实现时发现的事实**：
  - 第一次读一个 Session 的子代理树会认领这棵树并恢复上一个 Host 留下的 Turn，所以这几个读方法可能写盘。没被准入的 Session 报 `session_not_admitted`。
  - 中断之后，子代理的 `revision` 还会再涨一次（执行器被中止后补记的结算），所以不能拿 `revision` 判断"重复的中断什么也没做"。控制器的单元测试直接检查了没有写盘。
  - 中断只是中止执行器，不等它退出；控制器关闭时也只等结算，不等被中止的执行器。provider 不理会中止的话，执行器会在 `runtime.close()` 之后继续写项目目录下的 `.agent/managed-tasks`。测试里的假 provider 原来就不理会中止，删临时目录时偶尔报 `EBUSY`；现在它像真实 provider 一样响应中止（Issue 421 之后真实 provider 都会），问题消失。嵌入方关闭后立刻删项目目录的场景没有改，也没有验证。
- **没有验证的**：外部（A2A）和 Workflow 类型的子代理；`artifactDetails.uri` 是不是一定是 Host 路径（外部子代理可能给的是远端 URL，现在一律只发给 owner）；Host 重启之后读一个正在运行的子代理；`subtree` 范围的中断（v2 没有开放）；service 角色调用这六个方法。

**数据面：Workflow（所有角色）**

| v2 方法 | 原语 | 对应的 v1 方法 |
|---|---|---|
| `workflow.list` | 查 | `workflow.list` |
| `workflow.get` | 查 | `workflow.get` |
| `workflow.start` | 命 | `workflow.start` |
| `workflow.pause` | 命 | `workflow.pause` |
| `workflow.resume` | 命 | `workflow.resume` |
| `workflow.stop` | 命 | `workflow.stop` |

Workflow 的落地细节（2026-11-21，未经用户确认）。六个方法都已转发，都要求 `sessionId`。

- **按 Session 划分**：
  - 一个 Workflow 属于启动它的 Session，依据是它进程元数据里的 `ownerSessionId`。这个字段由 Host 写入，客户端改不了。
  - 运行时启动的和模型用 `run_workflow` 工具启动的都带这个字段。
  - 没有所属 Session 的 Workflow（比如 REPL 里不带 Session 启动的）v2 看不到。
  - 通过别的 Session 读或操作，报 `not_found`（`workflow_not_found`），和不存在一样。
  - v1 的 Workflow 过滤器多了 `sessionId`。
- **按 Host 划分**：
  - Workflow 管理器是进程级的单例。一个进程里的两个 Host 可能有 ID 相同的 Session：Session ID 由创建请求的 `requestId` 推出，不含 Host 的数据目录。
  - 所以按 Session 过滤时，还要求 Workflow 的文件在这个 Host 的 `workflow-runs` 目录下。不加这一条，多租户嵌入时一个租户能读到另一个租户的 Workflow（测试里复现过）。
  - 不带 `sessionId` 的 v1 列表仍然列出整个进程的 Workflow，和原来一样。
- **ID**：运行时启动的 Workflow，ID 就是它所在 Run 的 ID，`runId` 也返回这个值。模型在一个 Run 里用工具启动的 Workflow 有自己的 ID，`runId` 是那个 Run。
- **状态**：用托管状态 `running`、`paused`、`completed`、`failed`、`denied`、`stopped`。进程快照里的状态（被停止的是 `cancelled`）不返回。`stop.state` 说明停止有没有确认。
- **`workflow.start`**：
  - 名字、请求、脚本三选一。一个都没有或给了多个，报 `invalid_params`（`workflow_source_required`）。
  - 项目目录取 Session 的工作区根，没有就取 git 根。两个都没有，报 `invalid_state`（`session_without_project`）。
  - 名字找不到等 v1 拒绝的情况，报 `invalid_params`（`workflow_declined`）。
  - 只有 trusted 平面的角色能传 `script`：脚本跑在 `node:vm` 里，它不是安全边界。
  - 设置按产品默认值（`settingsDefaults: 'product'`）。
- **`workflow.start` 的重试安全**：
  - 桥接层把 `requestId` 当成这次启动在 Session 里的输入 ID 传给 v1，v1 的 `workflow.start` 多了可选的 `inputId`。
  - 判重走输入的持久化受理记录，和 `input.submit` 一样，Host 重启之后也认得。第一次还在启动的时候同一个请求又到了，用进程内的表等第一次的结果。
  - 同一个 `requestId` 重发，返回第一次的 Run，不再启动。换了 Workflow 名字报 `conflict`。比较的是记进 Session 的那句启动文字，所以 `args` 不参与比较，两份不同的脚本也不区分（都记作"从审阅过的源码启动"）。
  - 带 `inputId` 不带 `sessionId`，v1 报 `invalid_params`。
  - 已知的边界：重发会重新解析名字，存的 Workflow 被删了会报 `workflow_declined`。第一次在执行里才被拒绝的，重发会报"已启动"，指向一个失败的 Run。`requestId` 和 `input.submit` 共用 Session 的输入 ID 空间。
- **暂停、恢复、停止**：
  - 都返回 `{}`，结果去 `workflow.get` 看。
  - 暂停一个已经暂停的、恢复一个正在运行的，什么也不做，正常返回。
  - 对已经结束的 Workflow 暂停或恢复，报 `invalid_state`（`workflow_ended`）。正在停止的，报 `invalid_state`（`workflow_stopping`）。
  - 停止一个已经结束或已经在停止的，什么也不做，正常返回。
- **列表**：新的在前，游标是 Workflow ID。游标指向的 Workflow 不在了，报 `resync_required`（`cursor_expired`）。v1 原来忽略列表的 `activeOnly`，现在生效了。
- **只发给 owner 的**：Workflow 的文件目录 `runDir` 和产物的 `path` 是 Host 路径，只发给能到达 local 平面的角色。
- **没做的**：
  - Workflow 只在内存里，Host 重启之后就没了，Session 的 Run 还在。
- **没有验证的**：用请求（`request`）启动的 Workflow；保存在项目或个人目录里的 Workflow；service 角色调用这六个方法。
- **视图里的 Workflow**（M1a 已落地，2026-11-21，未经用户确认）：`workflow.subscribe` 不单独转发，Session 视图多一项 `workflows`，内容和 `workflow.list` 的条目同形，新的在前，最多 50 个，更早的用 `workflow.list` 翻页。
  - v1 不改。Host 替每个视图订阅开一个 v1 的 `workflow.subscribe`（按 Session 过滤），收到变化就重读一次 `workflow.list`，再和视图的其余部分一起 diff，客户端收到的是 `workflows` 这一项的 `set`。
  - 先订阅再读，两步之间的变化不会漏。读的过程中又有变化，只在读完后再读一次，不按变化次数读，也不会让旧的读取结果盖过新的。
  - v1 的 Workflow 订阅出错时，Host 结束这个视图订阅（`view.closed`，原因 `internal`），客户端重新订阅。视图订阅被替换、退订或结束时，Host 一并退掉 v1 的 Workflow 订阅。
  - 代价：每次变化读一次这个 Session 的全部 Workflow 摘要。Workflow 只在内存里，数量小，读的是内存。v1 的变化事件很密时（每个子 Agent 的开始和结束都算），最多同时一次读取在路上。

**用户设置（owner；M2 起对 user 开放，受 `userLocks` 约束）**

下表 22 个方法 M1a 全部落地（2026-11-21，未经用户确认），细节见表后三段。

| v2 方法 | 原语 | 对应的 v1 方法 | 锁定项 |
|---|---|---|---|
| `config.get` | 查 | `config.read`、`config.effective` | |
| `config.update` | 命 | `config.patch` | 按字段 |
| `config.reload` | 命 | `config.reload` | |
| `provider.custom.list` | 查 | `provider.custom.list` | `providers` |
| `provider.custom.upsert` | 命 | `provider.custom.upsert` | `providers` |
| `provider.custom.remove` | 命 | `provider.custom.remove` | `providers` |
| `provider.reasoning.probe` | 命 | `provider.reasoning.probe` | `providers` |
| `provider.reasoning.forget` | 命 | `provider.capabilities.forget` | `providers` |
| `mcp.server.list` | 查 | `mcp.server.list`、`mcp.server.status` | |
| `mcp.server.get` | 查 | `mcp.server.get` | |
| `mcp.server.validate` | 查 | `mcp.server.validate` | |
| `mcp.server.upsert` | 命 | `mcp.server.upsert` | `mcp` |
| `mcp.server.remove` | 命 | `mcp.server.delete`、`mcp.server.remove` | `mcp` |
| `mcp.server.reload` | 命 | `mcp.server.reload` | `mcp` |
| `mcp.tool.list` | 查 | `mcp.tool.list` | |
| `mcp.tool.refresh` | 命 | `mcp.tool.list`（`forceRefresh`） | |
| `extension.list` | 查 | `extension.list` | |
| `extension.reload` | 命 | `extension.reload` | `extensions` |
| `agent.registration.list` | 查 | `agentRegistrations.list` | |
| `agent.registration.upsert` | 命 | `agentRegistrations.upsert` | `extensions` |
| `agent.registration.setEnabled` | 命 | `agentRegistrations.setEnabled` | `extensions` |
| `agent.registration.remove` | 命 | `agentRegistrations.remove` | `extensions` |

`config.*`、`provider.*` 这 8 个的落地细节（M1a 已落地，2026-11-21，未经用户确认）：

- **形状**：
  - `config.get` 返回 `{config, revision, effective}`。`config` 是存盘的配置，密钥读出来是 `[redacted]`。`effective` 说明每一项现在实际生效的值和来源（运行时覆盖、环境变量、存盘、未设），哪些 provider 的 key 在 Host 环境里（只说有没有，不给值），以及改了之后什么时候生效。
  - `config.update` 是 `{requestId, patch, ifRevision?}`，返回 `{config, revision}`。`patch` 是列出字段的严格对象，未知字段报 `invalid_params`；字段设成 `null` 就删掉，回到默认值。`config.reload` 返回同样的 `{config, revision}`。
  - v1 的 `agentMode` 已经退役，不进 `patch`。
  - `provider.custom.upsert` 是 `{requestId, provider}`，同名就替换。Host 用不了的 provider（缺字段、协议不认识）报 `invalid_params`。顺带修了 v1：这类错误以前报 `internal_error`。
  - `provider.reasoning.probe` 是 `{requestId, provider, model?, efforts}`，每个 effort 真发一个小请求，返回每个 effort 的 `status`。`provider.reasoning.forget` 忘掉探测的结果，可以只忘一个模型、一个 provider，或者全部。
- **`revision`**：存盘配置去掉密钥后的哈希。客户端只能比对自己读得到的东西，所以只改了密钥，`revision` 不变。
  - 带 `ifRevision` 的 `config.update`，在 Host 的跨进程配置写锁里比对，不一致报 `conflict`（`revision_mismatch`），什么都不写。两个窗口同时改设置，后到的那个会被拒，不会悄悄覆盖。
  - 例外：Host 没有指定配置文件、用的是全局配置时，比对在写入之前，不在写锁里面。全局配置的写法本来就不在这个锁下，这里不为它另加一层。
- **重试**：这几个命令不记 `requestId`。同样的 `patch` 再写一遍结果一样，删 provider 不论原来在不在都返回 `{}`，所以重发是安全的。`probe` 重发会再花一次请求。
- **M2 开放给 user 之前要定的安全项**（现在只有 owner 能调，暂不构成问题）：
  - `provider.custom.upsert` 里 `apiKeyEnv` 加上 `baseUrl`，等于让调用方指定"把 Host 上哪个环境变量发到哪个地址"。对 user 开放时，`apiKeyEnv` 必须限制在平台允许的名单里，或者只能用用户自带的 key。
  - `config.update` 里的 `extensions`（Host 加载的模块路径）、`repoIntelligence.storageDir`（Host 上的目录）、`permissionMode: 'full-access'` 必须受 `userLocks` 管，或者对 user 直接拒绝。
- **没有验证的**：Host 用全局配置（没有指定配置文件）时经 v2 改设置；`probe` 对真实 provider 的结果。

MCP 这 8 个的落地细节（M1a 已落地，2026-11-21，未经用户确认）：

- **形状**：
  - `mcp.server.list` 把 v1 的 `list` 和 `status` 合成一个列表，每项是服务器的名字、配置、连接方式、状态、已发现的工具/资源/提示数、最近的错误。v1 的 `dirty` 改叫 `stale`：服务器提供的东西变了，下次读会重新问它。
  - `mcp.server.get` 没有这个名字报 `not_found`（v1 返回 `null`）。`mcp.server.validate` 是查询，只检查不保存，返回 `{ok, config?, error?}`。
  - `mcp.server.upsert` 只保存；正在运行的服务器要等 `mcp.server.reload` 才换成新配置。Host 用不了的配置报 `invalid_params`，顺带修了 v1：以前报 `internal_error`。
  - `mcp.server.remove` 不论原来在不在都返回 `{}`，重发安全。v1 的 `delete` 和 `remove` 是同一个方法的两个名字，v2 只留 `remove`。
- **`mcp.tool.list` 拆成两个**：
  - `mcp.tool.list` 是查询，读 Host 已经知道的；Host 还没连过的服务器会去连，stdio 服务器就是启动它的命令。
  - `mcp.tool.refresh` 是命令，对应 v1 的 `forceRefresh`，每个服务器都重新问一遍。
  - 两个都按服务器分别读：一台连不上，它那一项带 `error`，其他服务器的工具照常返回。v1 是一台失败整个列表失败。点名的 `server` 不存在报 `not_found`。
- **M2 开放给 user 之前要定的安全项**：
  - 服务器配置原样返回，`env`、`headers` 里可能有密钥。对 user 开放时要么隐去这两项的值，要么只写不读。
  - stdio 服务器的 `command` 就是在 Host 上执行命令，已经在上面"用户设置"里写了：工具上限没有 bash 时自动锁定。
- **没有验证的**：`sse`、`streamable-http` 服务器经 v2 管理；需要 OAuth 的服务器。

扩展和外部 Agent 注册这 6 个的落地细节（M1a 已落地，2026-11-21，未经用户确认）：

- **`extension.list`、`extension.reload`** 返回同样的 `{active, extensions, failures}`：加载了哪些模块（Host 上的路径、怎么找到的），哪些加载失败、失败在哪一步。v1 的整份诊断（注册的工具、命令、钩子）不进 v2，要看这些用 `tool.list`、`command.list`。
  - `reload` 只重新加载已经加载的模块，改了模块代码之后用。配置里新加的扩展、启动时加载失败的扩展，要等 Host 重启。
  - **已有的问题，没改**：`config.get` 说 `extensions` 改了之后 `extension_reload` 生效（`client-settings.ts`），实际要重启。要么改成 `restart`，要么让 `reload` 按配置增删扩展，由用户定。记入 §12。
- **`agent.registration.*`**：Host 启动时没有接外部 Agent，四个方法都报 `method_not_found`，和 v1 一样。
  - v1 的 `expectedConfigurationRevision`、`expectedManagementOwner` 改叫 `ifRevision`、`ifOwner`，和 `config.update` 的 `ifRevision` 一个说法；`null` 表示必须没有。条件不满足报 `conflict`（`external_agent_registration_conflict`）。
  - `setEnabled` 找不到这个 Agent 报 `not_found`（v1 返回空）。
  - **修了一处**：v1 的 `remove` 条件不满足时只返回 `false`，和"本来就没有"分不出来。原样转成 `{}` 的话，管理方会以为删掉了。v2 在条件不满足、Agent 还在时报 `conflict`；Agent 已经不在时返回 `{}`，所以带条件的删除重发也安全。
  - 读出来的注册信息不带 `executorConfig` 和凭据，只有 `credentialConfigured`。
  - **已有的问题，没改**：注册信息本身不合法（缺字段、`agentId` 不在 `external:` 下）时报 `internal`，不是 `invalid_params`。检查做在 `packages/agent` 里，抛的是普通错误，和存盘失败分不开。要改得在那一层给这类错误一个代码。
- **没有验证的**：A2A 配置文件同步出来的注册经 v2 修改；service 角色管理注册（v1 里平台用这条路，v2 暂时只给 owner，M2 定）。

**记忆与技能学习（owner；v2.0 不对网络角色开放）**

- `memory.*` 12 个方法：next-dev 的 FEATURE_308 已经换了记忆模型，旧实现计划在 FEATURE_309 删除。v2 不照搬这 12 个方法，等 FEATURE_309 之后按新模型重定。`memory.ensureOpenTarget` 返回路径、由 UI 打开本机编辑器，只属于本机 owner。
  - **改了原计划**（2026-11-21，未经用户确认）：原计划在 FEATURE_309 之前让 owner 经 v2 编解码原样调用这 12 个方法，并补上 `memory.remember` 的重试安全。两样都不做。FEATURE_308 已经默认开启，这 12 个方法只剩 v1 客户端在用，FEATURE_309 连同它们一起删掉；先接进 v2 再删，是白做，还会让 v2 的方法表里出现注定要删的方法。在那之前 owner 继续走 v1。
- `learning.*` 14 个方法：`learning.subscribe` 和 `learning.unsubscribe` 并入 `view.subscribe`，其余 12 个由 owner 原样调用。是否对网络角色开放，另立 feature 决定。
  - **订阅放到 M2**（2026-11-21，未经用户确认）：学到的技能属于整个 Host，不属于某个 Session，放进 Session 视图不对，所以并入 M2 的 Host 文档，不在 M1a 做。在那之前客户端用 `learning.events` 的 `afterRevision` 拉取。
  - **落地细节**（M1a 已落地，2026-11-21，未经用户确认）：12 个方法都在本机管理面，只有 owner 看得到，`user` 和 service 调用报 `method_not_found`。查询四项（`learning.list/get/snapshot/events`），决定八项（`acknowledge`、`snooze`、`reject`、`disable`、`rollback`、`review`、`trust`、`promote`），决定都带 `requestId`，结果是 `{}`。
  - 读出来的 capability 字段改名：`id`、`name`（v1 的 `capabilityId`、`displayName`），时间是 UTC 毫秒。来源、作用域哈希、出处和试用绑定不出 Host，试用只给计数（`canary`）。`artifactPath` 是 Host 路径，本机管理面只给 owner，所以不拆本机结果。`snooze.until` 收 UTC 毫秒，Host 转成 v1 的 ISO 时间。
  - 被拒绝的决定说明原因：找不到报 `not_found`（`capability_not_found`）；名字或 slug 对应多个报 `invalid_params`（`ambiguous_name`）；生命周期不允许、或这种 capability 不支持这个动作，报 `conflict`（`invalid_transition`、`unsupported_action`）；做决定期间 capability 变了，报 `conflict`（`revision_mismatch`）。v1 以前这些都报 `internal_error`，现在 daemon 按同样的规则映射，v1 也受益。为了把"变了"和别的校验失败分开，learning 层的 `invalid_record` 里拆出一个 `revision_conflict`，其余的 `invalid_record` 仍报 `internal_error`，因为它也是存储自己的检查，说明不了调用方错了。
  - **重发**：决定不按 `requestId` 判重。生效之后重发，多数会因为生命周期不允许报 `conflict`（`invalid_transition`），客户端读一次 capability 就知道结果；`promote` 已经提升过时直接成功。v1 本来就这样，判重要在 learning 层加回执，没有用户场景要求，没做。
  - **已有的问题，没改**：v1 的治理动作在执行前自己读一次当前 revision 当作"用户看到的版本"，所以用户看到的是旧内容、执行时内容已经变了，决定照样落在新内容上。要改得让客户端把看到的 `revision` 带上来（v2 加可选的 `ifRevision`），learning 层已经支持，只是 facade 没接。窗口很小，等对网络角色开放时一起做。

**可信面（owner 和 service；永不进浏览器 SDK）**

| v2 方法 | 原语 | 对应的 v1 方法 | 说明 |
|---|---|---|---|
| `lease.register` | 命 | `execution.register`、`credential.register`、`host_tool.register` | 用 `kind` 区分三种租约 |
| `lease.resume` | 查 | `credential.get`、`host_tool.get` | 重连后恢复。只读，所以是查询 |
| `lease.revoke` | 命 | `execution.revoke`、`credential.revoke`、`host_tool.revoke` | |
| `lease.complete` | 命 | `execution.complete`、`credential.supply`、`host_tool.complete` | 结算一个宿主请求 |
| `lease.pending` | 查 | `host_tool.invocation.get` | 取回还没结算的请求 |
| `session.policy.update` | 命 | 新增 | D12 |
| `session.promote` | 命 | `session.promote` | |
| `session.promotion.get` | 查 | `session.promotion.read` | |

Host 发出的宿主请求是通知 `lease.request`。三种租约合成一组方法的前提是它们的语义规则一致。M1b 对照现有的三种实现核实；如果差别大，就保留按种类分的方法名，但语义规则仍然统一。

**凭证租约的落地细节**（2026-11-22 已落地，未经用户确认）：

- **为什么提前**：REPL 跑在 v2 上需要用客户端的凭证（OAuth、云厂商凭据），所以凭证这一种租约先于 M1b 第 9 项做。Host Tool 和授权方两种仍在 M1b，`kind` 目前只收 `credential`。
- **四个方法**都带 `kind`，只有 owner 和 service 看得到；`user` 调用报 `method_not_found`。
  - `lease.register {requestId, kind, providers, expiresAt?}`：租约 id 就是 `requestId`。重发得到同一份租约；同一个 id 换了 providers 或期限，报 `conflict`（`request_id_reused`）。
  - `lease.resume {kind, leaseId}`：查询。这个客户端实例没有这份租约，报 `not_found`（`lease_not_found`）。v1 上登记的租约在 v2 上看不到。
  - `lease.revoke`：不管还在不在都答 `{}`，可以安全重发。
  - `lease.complete {requestId, kind, callId, credential | error}`：两者恰好给一个，否则 `invalid_params`。结果 `accepted`，或者 `already_settled`（已经答过、已经放弃、租约已吊销）。
- **哪些命令能带租约**：会调用模型的九个命令收 `leases: {credential}`，只有可信角色能传，`user` 传了报 `forbidden`（`param_not_allowed`）。九个是 `input.submit`、`run.startTool`、`command.execute`、`review.start`、`agent.reviewLean`、`run.recover`、`workflow.start`、`session.compact`、`provider.reasoning.probe`。引用一份不存在的租约，在提交时就报 `not_found`（`lease_not_found`），不等到模型调用才失败。
- **实现**：v2 连接接上 v1 已有的反向通道，四个方法转给 v1 的 `credential.*`。Host 发出的 v1 `credential.request` 改名成 `lease.request` 发给持有者（`requestId` 改叫 `callId`，去掉 `brokerVersion`）。v1 和 v2 共用一份规则：期限、断线即失败、密钥只在内存里。
- **重连**：凭证租约归客户端实例。
  - 带着同一个 `instanceId` 和 `instanceSecret`（至少 32 个字符）重连到同一个 Host，租约还在，新连接接管，旧连接被关闭。没给 `instanceSecret` 时，租约随连接结束。
  - 断线时在途的凭证请求立即失败，模型调用随之失败。所以凭证不需要 `lease.pending`。
  - Host 重启后不持有任何租约，`lease.resume` 报 `not_found`。CLI 的授权器发现 Host 的 id 变了就重新登记。
- **Node SDK**：
  - `KodaXHostClient.answerLeaseRequests(handler)`：handler 返回密钥，或者没有时返回 `undefined`。没设 handler 时立即拒绝，模型调用不用等到超时。Host 只会收到固定的词：`credential_unavailable`、`credential_broker_failed`。handler 抛的错交给 `onError`，因为错误信息里可能带着密钥。
  - `createHostCredentialService(client)`（`src/host-credentials.ts`）把它包成 CLI 授权器用的 `RuntimeCredentialService`，`bindRequestCredentials` 原样复用。只支持限定范围的凭证（`registerScoped`、`resumeScoped`），现有的授权器都用这种。
- **原来的缺口，已补**：Host 被替换后，`KodaXHostClient` 自动发出的 `run.recover` 原来不带租约，用客户端凭证的 Run 会以缺凭证失败。现在调用方可以给 `recoveryLeases`，REPL 的做法见"REPL 切到 v2 的落地细节"。
- **验证**：`host-rpc.test.ts` 覆盖登记、重发、冲突、Run 拿到借来的密钥、客户端没有密钥时 Run 失败、吊销、同一实例重连保留而另一个实例看不到、`user` 被拒；还有一个用例走完整条链路：`bindRequestCredentials` → `createHostCredentialService` → `createKodaXHostClient` → Host → Run。`host-client.test.ts` 覆盖应答、没有 handler 时立即拒绝、handler 抛错时不泄露内容。

**Session 提升的落地细节**（M1a 已落地，2026-11-21，未经用户确认）：

- `session.promote`：`{requestId, sessionId, ifRevision, tag}`，`ifRevision` 必填，因为 v1 的提升本来就只按 CAS 做。结果是 `{session}`，和 `session.get` 的 `session` 同形。一个 Session 只能提升一次，同一个 `requestId`、`tag` 和 `ifRevision` 重发得到同样的结果。
- 两种冲突分开报：Session 在读到之后变过，报 `conflict`（`revision_mismatch`），重读再试；已经被别的请求提升过，报 `conflict`（`already_promoted`），重试没有用。为此 v1 的这两种错误多带一项 `data.conflict`（`revision_conflict` 和 `already_promoted`），错误码仍是 `conflict`。
- `session.promotion.get`：`{sessionId, promotionId}`，`promotionId` 是那次 `session.promote` 的 `requestId`。查询不能带 `requestId`（方法表的统一规则），所以换了名字。不是这个请求提升的，报 `not_found`（`promotion_not_found`）；v1 返回 `null`。
- `requestId` 不按调用方加前缀，和 `session.create`、`session.compact` 不同。一个 Session 只提升一次，能看到这个 Session 的人本来就能读到结果；另外 v1 限制 `requestId` 最长 128，加上 `service:<subject>:` 前缀可能超长。
- 只有 owner 和 service 能调用，`user` 角色看不到这两个方法，和 v1 的 `trusted` 平面一致。

**本机管理（owner，只走 IPC）**

| v2 方法 | 原语 | 对应的 v1 方法 |
|---|---|---|
| `host.get` | 查 | `daemon.status`、`daemon.management.get`、`daemon.integrations.get`（主线 Issue 429 新增，桌面集成的检测结果，2026-11-21 合入） |
| `host.preflight` | 查 | `daemon.preflight` |
| `host.stop` | 命 | `daemon.stop`、`runtime.shutdown` |
| `host.logs` | 查 | `daemon.logs` |
| `client.exit.request` | 命 | `client.exit.request` |
| `client.exit.get` | 查 | `client.exit.read` |
| `client.exit.list` | 查 | `client.exit.pending` |
| `session.diagnostics` | 查 | `session.diagnostics` |
| ~~`session.identityAlias.confirm`~~ | | `session.identityAlias.confirm` |
| `repo.intelligence.inspect` | 查 | `repo.intelligence.inspect` |
| `repo.intelligence.prewarm` | 命 | `repo.intelligence.prewarm` |

本机管理的落地细节（2026-11-21，未经用户确认）。十个方法都已转发，都只给 owner，平面是 `local`。形状按现有调用方实际读的字段定：

- **`host.get`**：Host 概况，便宜到可以轮询，不做停机评估。
  - `host`：`id`、`version`、`mode`、`profile`、`startedAt`。
  - `counts`：`sessions`、`runs`、`activeRuns`、`queuedRuns`、`workflows`，就是 CLI 的 `daemon status` 打印的那几个数。`activeRuns` 是还没有 `outcome`、也不在排队的 Run。`workflows` 和 v1 一样数的是整个进程的 Workflow：守护进程里一个进程只有一个 Host，数字是对的；一个进程里嵌多个 Host 时会多算。
  - `integrations`：桌面集成的检测结果，每个域带 Host 上的配置文件路径。没有托管服务的 Host 不返回这一项。
- **`host.preflight`**：现在停 Host 安不安全。
  - `canStop`、`blockers`。v1 已弃用的 `active_agent_tasks` 不返回。
  - 挡着的工作只给 ID 和数量：`clients`（名字、类型、连上的时间）、`activeRunIds`、`queuedRunIds`、`activeWorkflowIds`、`activeAgentTurns`、`pendingInteractions`、`pendingBackgroundWork`。v1 返回的整份 Run 和交互对象不带。
  - `owner`：Host 进程的 `pid`、`createdAt`、`processStartIdentity`。升级时客户端先停 Host，再等这个进程退出；有了启动标识，PID 被复用也不会认错。
- **`host.stop`**：结果是 `{}`。Host 有挡着的工作，报 `conflict`。
- **`host.logs`**：`{logFile, entries: [{at, level, message, data?}]}`，最近 200 条。
- **`client.exit.request` / `get` / `list`**：
  - 都按连接的客户端实例划分，别的实例的退出看不到。`list` 只列还没完成的退出。
  - `get` 用 `exitId` 指定退出，就是发起时的 `requestId`。查询方法不带 `requestId`，所以换了名字。找不到报 `not_found`（`exit_not_found`）。
  - 回执的形状按 Space 读的字段定：`id`、`runtimeId`、`requestedAt`、`updatedAt`、`cleanup`（`state`、`runIds`、`actorTurns`、`withdrawnInputs`、`operationIds`、`issues`）、`host`（`requested`、`state`、`cleanup`、`message`、`replacementRunning`）、`recovery`（`state`、`reason`、`nextAction`、`checkedAt`）。
  - 恒为 `true` 的 `accepted` 和客户端自己的 `clientId` 不返回。
  - 回执里的 Host 进程标识也不返回：Host 已经退出时，是 SDK 读本机的回执文件来判断恢复状态，不经过协议。
- **`session.diagnostics`**：`{sessionId, runId?}`，结果是 `{diagnostics}`，一份带 `schemaVersion` 的支持包，原样返回，不按契约裁剪。它是给人和支持工具读的，不是给客户端分支用的。
- **`repo.intelligence.inspect` / `prewarm`**：`{sessionId}`（`prewarm` 另带 `requestId`），结果是代码索引的状态：`configuredMode`、`requestedMode`、`effectiveEngine`、`status`、`initialized`、`warnings`、`workspaceRoot`。
- **`session.identityAlias.confirm` 不进 v2**：它是给 beta.8 以前写下的旧数据做的人工修复。没有客户端调用，也没有文档引用。进程内 SDK 和 v1 继续提供。

**小结**

- 数据面 83 个，用户设置 20 个，可信面 8 个，本机管理 10 个，合计 121 个（2026-11-21 本机管理去掉了 `session.identityAlias.confirm`）；技能学习的 12 个已在 v2 落地（本机管理面），记忆的 12 个等 FEATURE_309 之后重定。v1 的 15 个已退役方法不带到 v2。
- 第 3 版写的"约 85 个"没有清单支撑。逐个归并之后做不到 85，除非砍功能。砍哪些功能是产品决策，不在这份方案里做。
- 精简的收益不在数量上：每个方法都属于四种原语之一，遵守同一套保证。

## 5. 第三层：传输绑定

### D1 传输

**决定**：

- IPC 上同时支持 v1 和 v2，按首帧区分。
- 网络上只开放 v2 over WebSocket。
- 一个端口上挂三样东西：WS、`/healthz`，以及 `/a2a`（A2A 的 `handle()` 挂载点，见 `a2a/server.ts:649`），共用一套监听和鉴权。
- `daemon.token` 和 v1 协议只在 IPC 上有效。

**否决**：

- 只绑 loopback：K8s 里网关和 Host 不在同一个 Pod，强制 loopback 就得部署 sidecar。
- 让 Host 内置 TLS 和 OIDC：这是平台的事。
- 用 SSE 做主通道：WS 是默认通道；SSE 加 POST 只作为 WS 被拦截时的自动回退，M2 实现。Host 的连接层从 M1b 起就与传输方式解耦。

### D2 协议风格与 schema 来源

**决定**：

- 使用 JSON-RPC 2.0，禁用 batch，不设别名。
- 用 `zod/v4` 作为唯一的定义来源，派生出方法表、角色和参数白名单、JSON Schema、TS 类型和参考文档。
  - 项目里是 `zod ^3.25`（`package.json:225`），`zod/v4` 是它附带的桥接子路径；
  - 以后升级到 zod 4 时，所有 import 统一改一遍。
- 每个方法的定义里带上它的原语和平面。§4 的方法表从这份定义生成，不手工维护。
- **参数对象都用 strict**：未知字段返回 `invalid_params`。zod 默认会静默丢掉未知字段，而 v1 是 `additionalProperties:false`（`schema.ts:1030`）。
- **结果按契约裁剪**（M1a 已落地，2026-11-21 改，未经用户确认）：
  - Host 发出结果之前用结果 schema 过一遍，契约没有列出的字段被丢掉，类型不对的仍然报 `internal`。
  - 原稿是"结果也 strict，多一个字段就报错"。两种做法都保证不泄漏契约之外的字段；区别是 Runtime 内部类型以后加字段时，strict 会让线上的方法整体失败，裁剪不会。
  - 生成的 JSON Schema 里结果对象仍然是封闭的（`additionalProperties:false`），因为它描述的是 Host 实际发出的内容。
  - 这也让"转给 v1 实现"的方法不需要逐字段手写映射：handler 只调整形状，字段取舍由 schema 决定。
- 结果不允许是任意对象。
- **方法定义的形状**（M1a 已落地，`src/host-protocol/schema.ts`）：每个方法是一条数据 `{primitive, plane, params, result, restricted?, localResult?}`。
  - `restricted`：顶层参数名到平面的映射。角色够不着这个平面就不能传这个参数，报 `forbidden`（`reason: param_not_allowed`）。D4 的"按角色的参数白名单"用它实现。
  - `localResult`：够得着本机管理面的角色（owner）拿到的结果 schema，等于 `result` 加上 Host 路径字段。其他角色的结果只过 `result`，路径字段不在 schema 里，所以发不出去（D11）。
  - 漂移测试检查：参数在任意层级拒绝未知字段；结果在任意层级是封闭的；`restricted` 里的名字都是已定义的参数；`localResult` 包含 `result` 的全部字段。
- 文件组织：`schema.ts` 放构件，每种资源一个文件（例如 `catalog.ts`），`methods.ts` 汇总成方法表并导出类型。
- 浏览器 SDK 不打包 zod，只带生成的类型；校验放在 Host 上做。

**否决**：

- TypeBox：要新增一个依赖。
- 保留现有的自定义帧：不利于语言中立。

### D13 连接生命周期

**鉴权之前**：

- 连接建立后，必须在限定时间内完成 `initialize`，否则断开。
- `initialize` 之前的帧有一个小得多的大小上限。
- 未完成握手的连接数有上限。
- 凭证在握手时校验，token 比较用常量时间。
- M1a 已在 IPC 上落地（`src/host-protocol/connection.ts`）：
  - 握手期限 10 秒。
  - 握手之前的帧上限 16 KiB，超过报 `limit_exceeded` 并断开。
  - 握手之前只接受 `initialize`，其他方法报 `invalid_state`。
  - 参数不合法的 `initialize` 可以在期限内重发；凭证被拒绝的，Host 发完应答就断开。
  - 握手成功后再发 `initialize` 报 `invalid_state`。
  - 同一条连接上 id 相同的请求还在处理时，第二个报 `invalid_params`。
  - 请求 id 是长度 1 到 128 的字符串或安全整数。
  - 未完成握手的连接数上限留到 M1b，和网络监听一起做。

**续期**（2026-11-20 确认）：

- Host 按 JWT 的 `exp` 设一个定时器，到期就断开连接。
- 客户端在到期前调用 `auth.renew({token})` 换上新 token。新 token 必须是同一个 `sub`、同一个角色，否则拒绝并断开。
- 配对令牌没有到期时间，只能吊销。
- 为什么推翻"重连就行"：JWT 有效期要短（§9），service 的连接上有租约。连接断开时，已经派发的 Host Tool 调用变成结局不确定，凭证请求立即失败（`reverse-bridge.ts:436-437`）。定期强制重连，等于定期制造这种窗口。
- 吊销设备或改了鉴权配置时，Host 重新检查现有连接，不再符合的断开。

**心跳**：

- v1 没有任何保活（`transport.ts` 里没有心跳，`ping` 只是一个普通 RPC）。浏览器发不了 WS 协议层的 ping，而代理和隧道会切断空闲连接。
- 客户端按间隔调用 `ping`。Host 在 `limits.idleTimeoutMs` 内没有收到任何帧就断开连接。客户端在同样的时间内收不到任何帧，就认为连接已经断开。

**关闭原因**：每种原因对应客户端的一种动作。WS 关闭码的具体数值在 M1b 确定。

| 关闭原因 | 客户端动作 |
|---|---|
| 凭证到期或无效 | 取新凭证后重连 |
| 被吊销，或者鉴权配置变了 | 不自动重连，提示用户 |
| 过载 | 退避后重连 |
| Host 正在排空 | 退避后重连；平台会把连接路由到新的 Host |
| 协议错误 | 不重连，报告 |
| 被同一实例身份的新连接接管 | 不重连 |

**重连**：SDK 用带抖动的退避重连。重连后的固定顺序是：握手，重新订阅，用原 `requestId` 查还没确认的命令的回执，持有租约的一方再取回还没结算的宿主请求。

### blob 传输

**决定**：blob 用分块的 RPC 读写，上下行是同一组方法（§4 的 `blob.*`）。

- 第 3 版选了单请求上传。它要求帧上限大于单个 blob 的上限，等于把大帧开放给所有方法；一次上传期间，同一连接上的其他消息都被堵住；而且没有下载方向。
- 分块读取 v1 已经有了：附件按 512 KiB 分块，并校验 sha256（`src/session-view-image.ts:13-27`）。上传沿用同样的分块大小和校验方式。
- 分块 RPC 在 IPC、WS 和 SSE 回退上都能用，不需要另开 HTTP 端点和它的鉴权。
- 上传必须带 `sessionId`。blob 落在 home 下，随 Session 删除，超过配额时拒绝上传，没有提交的上传复用现有的 maintenance scheduler 清理。不另建 GC。
- 声明的 sha256 已经存在时，`blob.begin` 直接返回已有的引用，重复上传天然幂等。

**否决**：

- 单独的 HTTP blob 端点：是一种优化，等有了大文件的真实需求再做。

## 6. 其他决策

### D5 隔离

- 隔离单位是 home：一个 home 对应一个 Host，对应一个人类用户，运行在平台提供的容器或 uid 里。
- 进程内库：一个进程只服务一个信任域。不同的终端租户，必须用不同的进程或 Host。

**否决单进程多租户**：

- sandbox 只包住了 bash，MCP stdio、extension、LSP 和 git 都以 Host 的身份运行；
- home 牵涉 132 处调用和多个全局注册表；
- 和 ADR-075 冲突。

**否决一个 Host 多个用户**：

- 同一个租户内的用户之间也会互相执行 shell，memory 也可能被投毒；
- 要实现就得做 ACL，这属于平台的能力。

**需要修订的文档**：

- `docs/ADR.md` 里 "there is no multi-tenant consumer" 那一段（当前在第 4736 行附近）；
- `public_docs/sdk/embedder-guide.md` 的 "Interaction with `setAgentConfigHome`" 一节（当前第 1019-1051 行）：推荐用 `setAgentConfigHome` 按租户切换 home，这和代码的实际行为矛盾。

### D8 嵌入的安全默认值

- 进程内库在没有设置审批回调（`events.beforeToolExecute`）时，危险工具直接默认拒绝，不经过告警版本。想全部放行，必须显式写 `allowAll`。
  - 改之前不传回调就放行（`permission-gate.ts`）。
  - 这是破坏性变更，所以拒绝时的工具结果和第一次拒绝时的日志都要写明原因和改法，CHANGELOG 里标为 breaking。
- **落地**（M1a，2026-11-21，未经用户确认的取舍）：
  - "危险工具"按工具声明的 `sideEffect` 判断：只有 `readonly` 不需要回调，其余都拒绝，`reads-network` 也算。原因是 `mutates-state` 里有 `activate_tool`、构造出来的工具和 `visual_act` 这类危险工具，分不出一个更窄的安全集合。门禁看不到声明的工具（没注册的名字、Run 范围的租约工具）也拒绝；这些工具实际都从 Runtime 进来，Runtime 一直带回调。
  - 默认值只有一处：`readOnlyWithoutApproval`（`permission-gate.ts`）。门禁和包裹回调的四处代码（Skill 调用两处、子 Agent、Script 单元）都退回到它，不再退回 `true`。之前这些包裹会把"没有回调"变成"全部放行"，只改门禁不生效。根包 `trusted-coding-entry.ts` 只在宿主给了回调时才包一层。
  - 拒绝时给模型的工具结果是 `approvalMissingToolResult`（`constants.ts`），进程收到一次 `process.emitWarning`（code `KODAX_TOOL_APPROVAL_MISSING`）。用 `emitWarning` 是因为库没有日志出口时，诊断会被静默吞掉。
  - 权限模式（`resolveShellPermissionMode`）只描述会话，不批准调用；护栏只做限制。所以没有回调时 `full-access` 或 auto 护栏都只运行只读工具，要放行就加 `allowAll`。
  - 拒绝文本是模型可见的工具结果，按 ADR-033 补了提示词 eval（`benchmark/approval-missing.*`，8ccea5254）：3 个模型 × 5 个用例 × 2 次，盲评对比旧的"审批不可用"文本，好 10、差 1、持平 19；Host 会再次拒绝的调用从 30 次里 8 次降到 2 次。结论记在 ADR-079 D8。
  - skill-creator 的 `run-eval.js` 显式放行所有调用，保持原行为；`run-trigger-eval.js` 本来就有回调。
  - 只改会话自身的工具也不需要回调（2026-11-22 用户确认）：`todo_create`、`todo_update`、`create_goal`、`update_goal`、`skill`。拒绝它们保护不了什么，只会让模型没法列计划（D8 eval 的 todo-plan 用例）。`skill` 能放行，是因为没有回调时 `applyRuntimeSkillInvocationPolicy` 把 Skill 的 `!`cmd`` 设为 `disable`（内置白名单允许 `find`、`awk`、`git branch` 等任意参数，参数还可以来自模型给的 `$ARGUMENTS`），hooks 本来就按 `bash` 走审批。`memory`/`memory_intent`（写以后的会话会读的笔记）、`exit_plan_mode`（等于自己批准计划）、`test_tool`（加载并运行构造出来的工具代码）不放行。
  - 宿主自己点名调用的 `runToolInvocation` 也走同一个门禁，没有回调时同样只运行只读工具。没有为它开例外，因为门禁分不出"宿主要的"和"模型要的"，例外会多一条绕过路径。
  - 测试里约 40 处依赖"没有回调就放行"的调用改成传 `allowAll`。生产路径（REPL、CLI、Runtime、A2A 远程运行）本来就带回调，Actor 子 Agent 的 `parentEvents` 就是这个 Run 的 events，回调能传下去。
- 每个 Run 的预算复用现有字段：迭代上限用 `maxIter`（`packages/coding/src/types.ts:2246`），token 用 `tokenBudget`（`client-host-authorization.ts:230`）。r1 只新增 `maxDurationMs`。
- 费用上限归平台管。

## 7. 路线图

**关键路径**：M0 → M1a → M1b → M1c。

到 M1b，(a)(c)(d) 可用；到 M1c，(b) 可用。多租户由平台承担，不需要等 M2。

**方法的两步落地**：v2 的编解码和 handler 的抽取分开做。

- M1a 用 zod 定义方法表里的全部方法。标 ★ 的抽成领域 handler；其余方法由 v2 编解码校验之后，转给 `server.ts` 里现有的实现。
- 这样 REPL（M1a）和 Space（M1c）切到 v2 时，用到的方法都已经有 v2 定义。第 3 版只定义约 35 个核心方法，却要求 REPL 和 Space 整体切到 v2 并且不留 v1 回退，两者用到的方法远超 35 个。
- 剩余的 handler 在 M3 拆完。

### M0 契约规格与底座（S-M）

**交付物**：

1. 契约规格评审：§3 和 §4 定稿；方法表里标"核实"的条目逐项确认（已完成，结论在方法表里）；沿用自第 3 版的行号重新核对（推到 M1a 开工时，随各方法的 zod 定义一起做）。
2. 新的 ADR，覆盖 D1-D13；修订 ADR 里 "no multi-tenant consumer" 那一段和 embedder-guide 的 `setAgentConfigHome` 一节（位置见 D5）。
3. 按连接传入角色：
   - Host 实现角色表和参数白名单；
   - 服务端拒绝非 owner/service 角色传入 `authorization`、`credential`、`hostTools`；
   - owner 的权限和现在一样。
4. 授权身份和连接实例身份拆开，持久数据双读。
5. 出站队列设上限，超出时以 `overloaded` 断开；token 比较改为常量时间。
6. SIGTERM 处理（已落地，顺序和时间见 §2 的"生命周期"）：
   - 设总截止时间；
   - 先停 Run 并短暂排空，再关闭传输层；传输层断开前先发完已排队的帧。
7. 锁记录加 PID 命名空间标识。
8. `daemon serve` 发现 home 已有 owner 时，以非 0 退出。

**出口标准**：

- 网络 dispatcher 在没有传入角色时，所有方法都被拒绝。
- "升级后再降级，Space 重连并接回租约"的回归测试通过。
- 队列溢出测试通过。
- SIGTERM 测试：在途 Run 有终态回执，客户端在断开之前能收到终态。
- 模拟换 PID 命名空间重启后，Host 能正常启动。

### M1a v2 内核，先跑在 IPC 上（M）

**交付物**：

1. v2 编解码 + IPC 首帧嗅探；双向的 revision 协商。
2. 用 zod 定义方法表里的全部方法（`.strict()`），每个方法带原语和平面；golden 漂移测试。标 ★ 的抽成领域 handler，v1 也调用同一份 handler。
3. 订阅：逐项定界的显示项、四种同步操作、`seq` 和 `epoch`。
4. 命令的统一规则：`requestId`、回执、`ifRevision`；补上跨重启的输入判重，以及现在重试不安全的几个命令。
5. `RunOutcome`、统一的错误类型，以及去掉内部泄漏的 DTO。
6. Session 策略的静态部分；`session.create` 的 `project`（带包含检查）和按名字选 Agent。
7. `maxDurationMs`；原样承载主线的 `context.prompt`。
8. 交互是否等人，按 Session 决定。
9. Node 版 v2 SDK。已落地，取舍见下面的"Node 版 v2 SDK 的落地细节"。
10. 进程内库在没有审批回调时，默认拒绝危险工具（D8）。已落地，取舍见 D8 一节。
11. FEATURE_312：`history.read` 用稳定的显示项 ID。
12. FEATURE_313：Session 的恢复状态、恢复时限和视图键 `session`，全部在 next-dev 上做（2026-11-21 用户决定，不再等主线）。已落地。

**Node 版 v2 SDK 的落地细节**（2026-11-22，未经用户确认）：

- **放在哪里**：放进现有的 `./client` 入口（`src/sdk-client.ts`），和 v1 产品客户端并列。过渡期不新增包子路径。
  - 连接无关的部分在 `src/host-protocol/host-client.ts`，不依赖 `node:`，M1b 的浏览器 SDK 直接复用。
  - 本机启动器在 `src/local-host-client.ts`。
- **接口**：
  - `createKodaXHostClient({open})` 接受一个"打开一条连接"的函数，返回一个比单条连接活得久的客户端。
  - `ensureKodaXHostClient({client, homeDir?, ...})` 是本机版：没有 Host 就启动，空闲的旧 Host 就替换，然后用 v2 连上。
  - `call(method, params)` 按方法表推出参数和结果的类型。`'local'` 客户端拿到本机形状的结果。
  - `observeSession(sessionId, {onView, onClosed})` 给出完整的视图，内部处理快照、patch 和重新订阅。
  - `onConnectionChange` 报告 `connected`、`reconnecting`、`closed` 三种状态。
- **`requestId` 由调用方给**：SDK 不替命令生成 `requestId`，导出 `createRequestId()`。调用方自己保存它，才能在进程重启之后用同一个 `requestId` 重发。
- **断线重发**：连接断开时还没有答复的请求，以及断线期间发的请求，在下一条连接上用同样的参数重发，包括同一个 `requestId`。
  - 命令按 `requestId` 重试安全，这就是 §"重连"里说的"用原 `requestId` 查回执"。
  - 调用方关闭客户端时，已经发出的请求保留 `unknown_outcome`，不改报"客户端已关闭"。
  - 等待重连的请求可以用 `signal` 放弃。
- **不重连的情况**：
  - 发出 `client.exit.request` 或 `host.stop` 之后，连接断开就是退出生效了。这两个请求本身不重发。
  - Host 拒绝的是重试也不会变的错误，比如凭证无效、协议不匹配。客户端关闭，把这个错误交给所有等待的调用。
  - 其余失败按带抖动的指数退避重试：从 0.5 秒起，上限 30 秒，每次等待取上限的一半到全部，至少等到 `retryAfterMs`。
- **视图**：
  - 答复和第一条 patch 在同一次读里到达时，patch 可能先于答复的后续代码执行。SDK 先缓存这些 patch，拿到快照后再按序应用。
  - patch 接不上（`seq` 跳了、`epoch` 变了、操作套用失败）就退订再订阅，不在本地猜。
  - 重连之后对每个视图重新订阅，拿到新快照。
  - 第一份视图没拿到时，`observeSession` 以原因失败；之后订阅失败，就调用 `onClosed`。
- **自动恢复 Run**：见 `run.recover` 一节的"客户端怎么知道该发这个命令"。
- **本机启动器**：先用 v1 的 `ensureKodaXRuntime` 启动或替换 Host，再从这条 v1 连接取端点和 token，用 v2 连上。
  - 端点和 token 记在一张内部的 WeakMap 里（`src/runtime-daemon/host-link.ts`），不放到公开的 facade 上。
  - v1 连接用一个临时的客户端身份，等 v2 连上之后才关闭。这样 Host 不会因为看到客户端全部离开而按空闲退出。
  - 没给 `instanceId` 时，每次 `ensureKodaXHostClient` 生成新的 `instanceId` 和 32 字节的 `instanceSecret`，同一个客户端对象重连时沿用。
  - Host 正在启动、停止或被替换时的失败（`ECONNREFUSED`、`ENOENT` 等，或者 v1 标了可重试）按可重试处理，其余的关闭客户端。
- **握手快速失败**：v1 的 Host 用 v1 的错误帧回答 v2 握手。客户端立刻报 `invalid_state`，`reason` 是 `protocol_mismatch`，不再等 10 秒超时。
- **没做的**：
  - 心跳和关闭原因放到 M1b。IPC 上没有代理切断空闲连接。"被同一实例的新连接接管"随凭证租约一起有了，旧连接直接被关闭，还不带关闭原因。
  - 断线期间的待答交互、Host Tool 租约，跟 M1b 的反向调用一起做。凭证租约已经做了，见"凭证租约的落地细节"。
- **验证**：
  - `host-client.test.ts` 用假 Host 覆盖重发、退避、不重连的情况、视图同步和自动恢复。
  - `local-host-client.test.ts` 起一个真的 Host，先杀掉它，再确认客户端拉起新 Host、视图重新订阅、读到原来的 Session。

**第一个用户**：REPL。

**出口标准**：

- 属性测试证明"快照 + patch 序列"等价于完整视图；任意一个显示项的表示不随其他项变化。
- 一个和协议无关的场景测试驱动，在 ★ 方法上对 v1 和 v2 都通过。已达成，见下面的"场景测试驱动"。
- 同一个 `requestId` 在 Host 重启前后重发，不产生第二个 Run。已达成，由场景测试驱动的第二个场景覆盖。
- REPL 跑在 v2 上。已达成（2026-11-22），交互式 `kodax` 经 `src/repl-host/connect.ts` 接 v2，见下面的"REPL 切到 v2 的落地细节"。打印模式、`-r` 查找和 daemon 命令仍走 v1。

**场景测试驱动**（2026-11-22，未经用户确认）：

- **位置**：`src/host-protocol/scenario.contract.test.ts`，归在 `test:contract` 这一层。它起一个真的进程内 Host，模型换成脚本，不花 token。
- **怎么做到和协议无关**：场景只认一个小接口，接口有两份实现。
  - v1 那份直接发 v1 线上方法，不经过产品 Client。这样测的是 Host 的线上契约，不是 Client 的包装。
  - v2 那份用 `createKodaXHostClient`。
  - 两边的拒绝都归成同一组原因：`stale_revision`、`not_found`、其他。
- **五个场景**，每个都在两种协议上各跑一遍：
  1. 同一个 `requestId` 建 Session 只建一个；归档、取消归档、删除都生效；删除后再读得到 `not_found`。
  2. 同一个 `requestId` 提交只产生一个 Run，Host 重启后重发也一样；模型只被调用一次，对话里只有一问一答。
  3. 带 `ifRevision` 改设置成功；拿旧的 revision 再改得到 `stale_revision`；最终设置就是第一次改的结果。
  4. 两个客户端回答同一个提问，第一个回答生效，另一个得到 `already_resolved`，Run 照常结束。
  5. Stop 正在跑的 Run，结果是 `interrupted`，回执确认已停；再 Stop 一次什么都不变。Run 已经开始干活，所以是 `interrupted` 而不是 `cancelled`，和"Run 的结局"一节的规则一致。

**REPL 切到 v2 的决定**（用户 2026-11-22 确认）：

- **不加读消息的 v2 方法**。REPL 在绑定 Host 时不再自己存一份对话，用到对话的地方都改读 Host：
  - `/compact` 显示 `session.compact` 返回的 `tokensBefore`、`tokensAfter`。
  - 出错后是否提示 `/recover`，用 Host 的消息条数判断。只有可能是历史被拒的错误才去读这个数，普通失败不多一次读取。
  - `/copy` 从显示项找最后一条助手回复，被截断的用 `item.read` 读全文。
  - 标题本来就由 Host 写，REPL 的本地写入在绑定时都被跳过，不用改。
- **显示项只加 `notice: {kind}`**。`kind` 是开放的字符串，现在有 `retry` 和 `compaction`，REPL 用它选图标。不加 `icon`、`compactText`、`sidecar`，也不加文本改写计数：
  - `icon` 是 REPL 自己的展示方式，pi、codex、opencode 的协议都只给事件种类，由客户端选图标。
  - `compactText` 是 REPL 折叠显示用的短文本，客户端可以从正文自己截。
  - verifier 的 `sidecar` 已经废弃，剩下的投递方式信息没有客户端在用。
  - 文本改写计数由 REPL 的适配层自己数。
- **去掉 `/auto-denials`，不加读自动模式统计的 v2 方法**。这条命令几乎没人用；pi、codex 也没有对应的统计接口。
- **顺序**：v2 显示项加 `notice.kind` → REPL 包的定点修改 → CLI 层的 v2 端口适配 → REPL 切换。每一步测试保持全绿。

**REPL 切到 v2 的落地细节**（2026-11-22，未经用户确认）：

- **入口**：`kodax` 交互模式（Ink 和经典两种）经 `src/repl-host/connect.ts` 连 Host。`connectReplHost` 建连接和租约，`createReplHostBindings` 把各个 Host 能力交给 REPL。适配层都在 `src/repl-host/`，每个文件对着真的 Host 测。print 模式、`-r` 的查找、`kodax daemon` 等子命令仍走 v1。
- **一个进程只用一种协议跑 REPL**：`-r` 的查找先经 v1 打开连接，v2 连上之后立刻关掉它。先连后关，Host 不会在中间看到最后一个客户端离开。
- **Host 的去留**：v1 交互模式启动的 Host 在最后一个客户端离开约 30 秒后、没有剩余工作时退出。v2 启动器原来没有这个选项，启动的 Host 会一直运行。`ensureKodaXHostClient` 加了 `exitWhenIdle`，REPL 打开它。已经在运行的 Host 保持自己的策略。
- **恢复时的租约**：补上"凭证租约的落地细节"里记的缺口。`connectReplHost` 给 `recoveryLeases`：先用 `run.get` 查到 Run 所属的 Session，再按 `recovery` 请求向 CLI 授权器要租约。
- **会话**：
  - 不传本地 storage。绑定了 `sessionCommands.read` 时，两种 REPL 都不读写本地会话文件。`-c` 和自动续接由 REPL 从 Host 的会话列表里挑，CLI 不再先挑一次。
  - 新会话用 `draft: true` 创建，没发过消息的会话不进列表。
  - v2 对找不到的对话树条目报 `conflict`，原因 `entry_not_found`。适配层把它转成 REPL 原来的"没找到"。
  - `/rewind` 不带参数时，先用 `history.resolveTurn` 找上一轮，再带着这一轮调用。原因见"分叉、回退、恢复和侧聊的落地细节"：v2 没有"退回上一步"的命令。
  - 这一轮如果在找到之后、回退之前被写过，回退就会报 `resync_required`，REPL 照 `TurnRef` 的约定重新找一次，最多试 3 次。会这样写会话的有 Run 结束后的记忆复盘，它往会话里追加 `memory_review_receipt`。这时头部不动，但会话文件的版本变了，v1 只比较头部，所以碰不到这个问题。
- **工作流**：
  - 每个调用都带上所属的 Session。没有所属 Session 的工作流，v2 看不到。
  - 显示用的 lineage 元数据和项目目录 v2 不保存，留在 REPL 这边。
  - 对已结束的工作流发 Stop，v2 当作成功；REPL 要知道"没有可停的"，所以先读一次状态。
  - 修了 run-manager 的一个顺序问题：工作流的进程先报"结束"，Run 后结算，读到结束事件的人可能看到 Run 还在跑。现在"结束"事件等 Run 结算之后再发。
- **学习中心**：v2 不推送学习事件，适配层每 5 秒用 `learning.events` 拉一次。能力条目只带 REPL 读的字段，v2 不给 `source`。
- **设置**：`config.update` 不收已退役的 `agentMode`，适配层把它去掉；只改它时什么都不发，revision 不变。CLI 适配和 v2 适配共用 `toClientEffectiveConfig` 投影。
- **`/extensions`**：v2 的 `extension.list` 只给 `active`、`extensions`、`failures`，REPL 在 v2 上显示这三项。命令和工具的明细在 `/help` 里。
- **MCP**：`mcp.tool.refresh` 按服务器返回结果，某个服务器读失败时整个读取报错，信息里列出每个失败的服务器。
- **状态面板**：读 `host.get` 的计数；待审批数用 `interaction.list` 数 `kind === 'permission'` 的项；端点和健康状态仍读本机的 Host 状态文件。
- **不在 v2 上用的**：`runtimeAutoModeControl`（v2 的 plane 有 `updateSettings`，REPL 不会走到它）；`memory.*`（见前面的决定）。
- **v1 的 REPL 适配留作测试驱动**：`src/cli-client-plane.ts`、`src/repl-learning-binding.ts` 和 `createReplRuntimeAutoModeControl` 生产代码不再使用。很多 `sdk-client.*` 测试用它们驱动 v1 行为，v1 从 Host 上删掉时一起删。

### M1b 网络与浏览器（M-L）

**交付物**：

1. `server` 配置块和 v2 WS 监听：
   - 抽出 JWT 字符串校验，放宽 claim 要求；
   - 配置热生效；
   - 鉴权之前的时限和帧上限、心跳、关闭原因、排空通知（D13）；
   - `auth.renew`；在 `exp` 到期和吊销时断开连接；
   - 没配鉴权就拒绝启动；
   - 配了监听就进入 persistent 模式。
2. `/healthz`，复用现有的停止前置检查。
3. Host 级的 `tools` 上限。
4. 设备配对。
5. JSON 日志。
6. 浏览器 SDK：
   - 新入口，零 `node:` 依赖，不打包 zod；
   - 不改造 `sdk-client.ts`，因为它依赖 `node:path`、sdk-runtime、state、client-lifecycle 和 repl。
7. 分块的 blob 读写；显示项的附件改为 blob 引用；网络客户端只能用 blob 引用和工作区相对路径。
8. 权限请求带上拟变更的 diff。
9. 在 v2 上承载 service 的反向调用（`lease.*`）；租约的 Session 级绑定（D12）。凭证这一种已经提前做了（见"凭证租约的落地细节"），这里剩 Host Tool 和授权方两种，以及 Session 级绑定。
10. 文档：
    - 实例契约（§2）；
    - Dockerfile（带 tini）和 StatefulSet 样例；
    - systemd 和 Windows 任务计划程序样例；
    - JWT 最小样例；
    - 隧道加配对指南；
    - UI 的 CSP 和输出净化须知。

**出口标准**：

- 浏览器经过样例反向代理，能完成提交、审批（看到 diff）、回答提问、Stop、上传图片，以及下载工具产出的图片。
- 不在 `owner` 或 `services` 里的 `sub` 被拒绝；JWT 到期后连接被断开，在途 Run 继续运行；到期前续期的连接不断开，租约保持。
- user 角色调用可信面的方法或传特权参数时被拒绝。
- 配了 `tools` 上限后，user 直接提交的 Run 和 `startTool` 都调用不到 bash。
- 以 service 身份跑通一个只带业务工具的 Run。
- 三方场景：service 创建带策略和 Host Tool 租约的 Session，user 在这个 Session 上提交的 Run 能调用到这个工具，并且受策略里的工具上限约束。

**第 1 项的落地细节**（2026-11-22，未经用户确认的取舍）：

- 分三次提交：① 配置块和 JWT 校验；② WS 监听、握手鉴权、心跳、关闭码、`exp` 断开、`auth.renew`；③ 配置热生效、排空通知、`/healthz`。
- 配置放在新的集成域 `<configHome>/integrations/host.json`（`src/host-server/config.ts`），和 mcp/a2a/extensions 并列，热生效直接复用 `IntegrationConfigController`。平台在启动 Host 前写这个文件。不认识的字段让 Host 拒绝启动，所以回滚镜像时也要回滚这个文件。
  - 这一步只有 `listen`、`jwt`、`owner`、`services`、`allowedOrigins`。`workspaceRoot` 在第 ② 步加入，`pairing`、`tools` 随各自的交付项加入。
  - 配了 `listen` 没配 `jwt`、配了 `jwt` 却没有任何可接纳的 `sub`、同一个 `sub` 既是 owner 又是 service，都拒绝启动。`allowedOrigins` 只收不带路径的 origin，不收 `*`；留空就拒绝所有浏览器。
  - 集成状态的 `domain` 加上 `host`（v1 `RuntimeIntegrationDomainStatus` 和 wire schema 一起放宽），第 ③ 步把它报上来。
- JWT 校验单独写（`src/host-server/jwt.ts`），用 `node:crypto`，不复用 A2A 的 `oauth4webapi.validateJwtAccessToken`。后者强制 RFC 9068（`typ: at+jwt`、`jti`、`client_id`），Keycloak、Entra 默认签的 token 过不了。Host 只看 `iss`、`aud`（字符串或数组）、`sub`、`exp`，`nbf` 有就看，时钟容差 30 秒。
  - 只收非对称算法（RS/PS/ES 256/384/512、EdDSA），RSA 至少 2048 位，ES 核对曲线；拒绝 `alg: none`、HS*、带 `crit` 的 token，以及和发布的 key `alg` 不符的 token。没有 `kid` 时必须恰好有一把合适的 key。
  - JWKS 读取复用 A2A 的 `safeA2AFetch`（1 MiB、10 秒、不跟随重定向）和 `readJwksResponse`，允许私网地址（平台自己配的），HTTP 只允许精确的 loopback。
  - key 集 10 分钟内有效；token 点名一把没见过的 key 时重读一次，30 秒内最多一次，这样轮换的 key 能用，乱填 `kid` 的连接又打不爆 IdP。重读失败时保留已有的 key，30 秒后再试；从没读到过 key 时报 `unavailable` 而不是 token 无效，握手据此回 `unavailable` 而不是 `unauthorized`。
- 第 ② 步用 `ws`（已是根包运行时依赖）的 `noServer` 模式挂在 `node:http` 的 upgrade 上，`/healthz` 走同一个 HTTP server。
- 第 ② 步的取舍：
  - 只有 `kodax daemon serve` 读 `host.json`（`networkConfigHome`），进程内嵌入的 Host 不监听。配了 `listen` 就监听，Host 自动进入常驻模式（retention `service`），不再因为没有客户端而退出。
  - WS 路径固定 `/v2`，其他路径回 404。带 Origin 头的请求必须精确命中 `allowedOrigins`，否则 403；不带 Origin 的不是浏览器，放行。
  - 关闭码 = 4000 + 同义 HTTP 状态（`src/host-protocol/close.ts`）。每个码对应客户端的一个动作：4400 协议错误不重连；4401 凭据过期或无效，换 token 再连；4403 设备被撤销或鉴权配置变了，不重连；4408 空闲，重连；4409 被同一客户端实例的新连接取代，不重连；4429 过载，退避后重连；4503 Host 停止中或暂时没法校验凭据，退避后重连。
  - 握手没完成的连接最多 32 个，超过的升级请求回 503。每个还可能带一帧 `maxFrameBytes`，所以最坏约 32 × 8 MiB。
  - 空闲超时 60 秒，经 `limits.idleTimeoutMs` 告诉客户端，任何一帧（包括 `ping`）都会刷新它。二进制帧算协议错误。关闭压缩，避免小帧解压后超出限制。
  - 读得慢的客户端：积压超过 64 KiB 时视图补丁开始合并；超过 64 MiB 直接断开 socket，不发关闭帧（它也读不到），记一条诊断，客户端按断线重连处理。这和 IPC 一致。其他断开在关闭帧后最多等 30 秒，客户端不回就强制断开。
  - 角色由凭据决定：`sub` 等于 `owner` 的是 `user`，在 `services` 里的是 `service`（subject 为 `service:<sub>`），其他回 `unauthorized` + `subject_not_admitted`。JWKS 读不到时回 `unavailable`。网络连接不能用 `ipc` 凭据，也拿不到 agent 注册管理权。
  - token 到 `exp` 时 Host 用 4401 断开。客户端在那之前调 `auth.renew` 换新 token：新 token 无效或暂时没法校验时报错，但连接保留；`sub` 或角色变了就回 `subject_changed` 并用 4401 断开；IPC 连接调它回 `invalid_state`。
  - `workspaceRoot` 随这一步加入配置（绝对路径），给网络客户端按相对路径指定项目用；不配就不能指定项目。
- 第 ③ 步的取舍：
  - `host.json` 改了之后，现有连接按新文件重新判一次。`jwt` 块变了，所有已接纳的连接用 4401 断开，客户端换一个新校验能接受的 token 再连。`sub` 不再以原来的角色被接纳、`jwt` 被删掉、浏览器的 origin 不再在 `allowedOrigins` 里，用 4403 断开。还在握手的连接，等校验结束后按新文件再校验一次，所以文件改动不会被一次慢的 JWKS 读取绕过。
  - `listen` 和 `workspaceRoot` 要重启才生效：改了只记一条 warn 诊断（`detail.fields` 列出字段），同一次改动里的鉴权字段照常生效。
  - 改坏的文件不生效，旧配置继续有效。具体错在哪里写进日志，`host` 集成域的状态带 `invalid-config` 诊断，`daemon.integrations.get` 能看到。启动时第一次读仍然直接报错、拒绝启动。
  - Host 开始关闭时，网络监听立刻进入排空：新的升级请求回 503，已接纳的连接收到 `host.draining` 通知（还在握手的不发），`/healthz` 报 `draining`。连接保持到 Run 停完，再用 4503 关闭。
  - `/healthz` 只认 `GET`，其他方法回 404，响应带 `no-store`。`blockers` 来自停止前置检查；前置检查因为有正在进行的变更而报 `conflict` 时，`blockers` 是 `['active_mutations']`。每次探测看到 `blockers` 不为空，就把 `lastActivityAt` 更新为当前时间，所以它表示 Host 最后一次被看到忙碌的时间，不单独埋点。健康检查本身出错时回 503，并记一条诊断。

### M1c Space 整体迁移到 v2

- Renderer 和 Main 一起迁，在同一个 Space 版本里切换。升级到这个 SDK 版本的 Space 就只用 v2，不保留 v1 回退开关。
- 没迁完之前，Space 就继续用旧版 SDK。
- Space 打包一份静态 Web UI，交给 Host 的 `server.webRoot`。(b) 的远程访问依赖这一步。
- Artifact SDK 改为按 blob 引用匹配附件（D11）。

### M2 前半：用户设置域对 user 开放

用户设置这一组方法在 M1a 已经有 v2 定义，owner 可用。M2 把它们对 user 角色开放，并支持 `userLocks`：MCP、skills/扩展、provider/模型、用户自带 key（只写）、权限规则、`full-access`、项目信任列表。(a) 的用户可以在网页上自己装 MCP。

不包括人设存储：人设用已安装的 Agent（D4）。

### M2 富 UI（M，四项可以并行）

1. 执行后的 `ToolFacts`：`edit.ts:207` 和 `write.ts:58` 已经算出了 diff，只需要接线。
2. 只读的 workspace 域：
   - 提供 `list`、`read`、`gitDiff`；
   - 根目录是 `workspaceRoot`；
   - 文件打开后基于 fd 做包含关系校验；
   - 沿用 read 工具的拒绝规则。
3. Host 文档：`view.subscribe` 新增一种文档，内容是会话列表的实时状态、跨会话的待处理事项和技能学习的变化（取代 `learning.subscribe`）。
4. WS 被拦截时的自动回退：
   - Host 侧：在同一端口上提供 HTTP 承载，下行用 SSE，上行用 POST；SSE 带心跳，并禁用代理缓冲。
   - SDK 侧：浏览器 SDK 自动探测并切换。

### M3 收尾

1. ACP 迁到 v2，删掉 `infer*`。
2. A2A 挂到 `/a2a`，身份并入授权身份（D4）。
3. `server.ts` 剩余的 case 全部拆成领域 handler，删除 15 个已退役的方法。
4. 合并 `schema.ts`。
5. 记忆域按 FEATURE_309 之后的模型重定。
6. 可选：子路径从 19 个减到 6 个。旧入口保留为转发，加弃用警告，配迁移指南，至少保留 2 个版本。
7. 拆分 embedder-guide。
8. 满足 §8 的条件后删除 v1。

## 8. 迁移、兼容与回滚

### 客户端：一次切换

升级到新 SDK 的客户端（Space、REPL、ACP）就只用 v2。没迁完的客户端继续用旧版 SDK，不在客户端里保留 v1/v2 双路径。

### Host：过渡期内两种协议都接

v1 只需要在 **Host** 里保留一段时间，原因是一台机器上的 Host 被多个版本不同的客户端共用（ADR-075）。例如：

- 用户升级了 Space，但全局安装的 `kodax` CLI 还是旧版；
- Zed 里的 ACP 集成是旧版；
- 外部客户基于 v1 client 写的程序。

这些旧客户端连到新 Host 时，Host 仍然要能用 v1 应答。

逐项定界（D3）只用于 v2。v1 的视图继续共用一份文本预算，v1 客户端看到的截断行为不变（2026-11-21 改，未经用户确认，理由见 D3 的落地细节）。

### 新客户端连到旧 Host

比如旧 CLI 先拉起了旧 Host，新 Space 再去连：

- v2 握手失败；
- 沿用现有的 `ensure` 逻辑，Host 空闲时替换它，忙时提示用户重启。

### 删除 v1

- 删除线（2026-11-22 用户决定）：`v0.7.100`，如果先发 `v0.8.0` 就在 `v0.8.0`。0.8.0 排在 0.7.100 之后，所以只有一条线。
- 保证到期会删：`src/host-protocol-v1-removal.test.ts` 从第一个 0.7.100 版本（预发布也算）起失败，CI 拦住带着 v1 的发版。删 v1 的提交同时删掉这个测试。任务登记为 FEATURE_314。
- CHANGELOG 提前公告：[Unreleased] 的 Deprecated 已经写上。
- Host 遇到 v1 连接时打印弃用警告：等 KodaX 自己不再用 v1 之后再加（打印模式、`-r`、`daemon` 命令、`ensureKodaXHostClient` 里的 v1 启动和探测、`recovering-runtime-client`、导出的 v1 product client）。v1 `initialize` 不带客户端版本，在那之前警告会打到当前版本的客户端上。每个 v1 客户端实例只打一次。
- 窗口从发布 v2 的版本算起。v2 晚于 `v0.7.98` 发布时，同时带两个协议的版本不足 2 个，届时重新确认删除线。

### 其他规则

- 改造期间，不新增 v1 方法、能力键、子路径和 `export *`。"改造期间"从 M1a 第一批 v2 代码合入时开始算。在那之前，主线照常演进 v1。v2 把这些原样接过去。
- 主线在改造开始之前新增的契约内容，要在 M0 评审时对照 §3 的规则归类。第 3 版定稿之后已经有这些：`inputIds`、失败显示项的 `sourceRunId` 和 `afterInputId`、`writer_active`、`promptSpec`、`actorSettlementConvergence:3`。
- 平台回滚 Host 镜像时，必须把配置一起回滚（§2）。
- **测试**：全部放进 `test:contract`，不新增 CI 触发方式。
  - 内容：
    - v1/v2 场景契约测试，覆盖 `requestId` 重发、`ifRevision`、首个有效回答生效、Stop 回执（M1a 已落地，见"场景测试驱动"）；
    - schema golden；
    - patch 属性测试；
    - 角色和参数白名单矩阵，从方法表生成；
    - 双身份测试：多设备时，一台设备退出不影响其他设备；本机和远程可以互相恢复；
    - 权限链测试：Session 策略只能收窄，不能放宽；
    - 故障注入：host tool 派发后断连、SIGTERM 排空、PID 命名空间变化、Host 重启后重发命令。
  - 需要 Linux 容器的验证写进 `docs/test-guides/`。

## 9. 安全底线

### Host 侧

以下任何一条不满足，就不开放网络监听：

1. 角色只来自验证过的凭证；未验证的连接没有任何权限，并且受时限、帧上限和连接数的限制；`daemon.token` 和 v1 只走 IPC。
2. 只有 `owner` 和 `services` 能连接；浏览器来源必须在 `allowedOrigins` 里；`exp` 到期或吊销时断开连接；续期只能换成同一主体的 token。
3. 方法和参数都用白名单，默认拒绝，未知字段直接报错；网络客户端不能传路径，也拿不到 Host 的绝对路径。
4. Host 级的工具上限对所有 Run 生效；Session 和 Run 的策略只能收窄。
5. 出站队列和 blob 都有上限；没有配鉴权就拒绝监听；安全事件写进日志。
6. service 不能回答人的审批。

### 平台侧

KodaX 在实例契约里给出检查清单，但不实现：

1. 每个用户一个容器或 uid；同一个 home 同时只有一个 Host。
2. 出口封锁 `169.254.169.254` 和集群内网。bash 里的 curl 不经过 `guardedHttpGet`，所以只能在网络层拦。
3. 平台自有的 key 走出口代理，或者用凭证租约。
4. TLS。
5. JWT 有效期要短，`aud` 绑定到这个 Host；客户端在到期前续期。
6. UI 使用严格的 CSP，并净化模型和工具的输出。

## 10. 精简收益

- 每个方法都属于四种原语之一，遵守同一套保证。重试、版本、订阅和错误各只有一种做法。
- RPC 方法从 189 个降到 121 个，另有技能学习 12 个（本机管理面）和记忆 12 个（等 FEATURE_309 之后重定），见 §4 的方法表。`server.ts` 拆成领域 handler（关键路径上只拆 ★ 部分）。
- 能力键从 55 个降到"基线 + 不超过 12 个 feature"；删掉约 26 处升级分支。
- `schema.ts`（2027 行）和手写契约合并成一份 zod 定义。方法表、角色白名单和参考文档都从它生成。
- 删掉 ACP 的 `infer*` 猜测，以及 REPL 从文本里解析 diff 的逻辑。
- 子路径从 19 个降到 6 个；embedder-guide（7436 行）拆成不超过 5 篇、每篇不超过 400 行的指南，再加一份生成的参考文档。
- 不新建网关、launcher、中继、配额或审计子系统。生命周期、停止检查、凭证绑定、工具上限、Run 预算、各领域的回执都复用现有实现。

## 11. 已确认的决策

2026-11-14 确认：

1. 一个 Host 只服务一个人类用户，不做多人共享，也不做 ACL。
2. 平台自有的 LLM key 走出口代理或凭证租约，KodaX 不做凭证保险箱。
3. 等人回答的交互默认超时为 30 分钟，平台可以修改。
4. 过渡期按我们自己的节奏：
   - 客户端一次切换到 v2（§8），不设截止日期，也不收集外部客户的 import 清单；
   - 子路径合并是瘦身，不是功能需求，优先级最低。真要合并时，旧入口保留并转发到新入口，加弃用警告，配迁移指南，至少保留 2 个版本。
5. 默认按"代理不拦截 WS"设计，同时实现自动回退：
   - 浏览器 SDK 先尝试 WS；
   - 握手失败或超时，就自动切到 HTTP 承载：下行用 SSE，上行用 POST；
   - 上层 API 不变，并在同一网络环境下记住这次选择；
   - M1b 先让 Host 的连接层与传输方式解耦，M2 再完成回退。
6. (b) 先做隧道，不做中继。网络监听必须鉴权：用一次性配对链接换取设备令牌（D4）。
7. 平台控制面不通过网络开放。用户设置对 user 角色开放，平台可以逐项锁定（D4）。
8. 进程内库没有审批回调时，直接默认拒绝危险工具，不先出一个只告警的版本（D8）。
9. v2.0 的 workspace 接口只读。UI 直接写文件另立 feature（§13）。
10. 2026-11-19，与主线的提示词定制结论对齐：
    - 提示词定制在主线做，v2 原样承载；
    - 人设 = 已安装的 Agent + `agentProfile`，不进锁，不建存储；
    - 不新增平台策略源；
    - 项目信任按仓库根目录配置，`projectSources` 强制关闭开关属于控制面（D4）。

2026-11-20 确认：

11. 按第一性原理复审之后的三项：
    - 执行策略以 Session 为绑定单位。r1 冻结策略的形状；静态部分先实现，租约的 Session 级绑定晚一个里程碑（D12）。
    - 显示项逐项定界，接受 Space 的截断行为随之变化（D3）。
    - 增加只允许同一主体续期的 `auth.renew`。这一条推翻了第 3 版 D4 里"不做 `auth.refresh`"的决定（D13）。

## 12. 风险与待核实

1. 方法表里原先标"核实"的 7 个条目已在 M0 对照本仓库确认。还没有核对的是 Space 的调用点（Space 仓库不在这里）：Space 是否直接调用 `runs.setModel` 一类的方法、是否分页读原始 transcript、是否发原始的 `run.start`、是否调用 `prepareSkill`。M1c 切 Space 之前要对照 Space 的代码确认；任何一项有调用方，对应的 v2 方法要补回来。
2. 三种租约合成一组 `lease.*` 方法是否成立，M1b 对照现有实现核实。凭证这一种已经按这组方法落地。已知的差别是重连：凭证请求断线即失败，不需要 `lease.pending`；Host Tool 调用断线后结局不确定，需要取回。
3. `epoch` 在会话内的重写（rewind、压缩）时是否变化，取决于显示项的 id 是否保持稳定，M1a 对照代码确定。
4. 逐项定界之后，快照的最坏大小是"窗口项数 × 单项上限"。单项上限要用真实会话测量后定，移动网络下反复重拉快照的成本上线后观察，必要时再评估做事件日志。
5. 跨重启的输入判重怎么落：现在立即启动的输入用启动内的地址判重，代码里明确说它不是输入账本（`sdk-runtime.ts:12427-12431`）。M1a 设计时要避免重建已被删除的通用 operation envelope。
6. 配对令牌存在 localStorage 里，会被 XSS 读走。网页和 Host 同源，备选做法是配对时由 Host 下发 HttpOnly cookie。非浏览器的远程客户端用不了 cookie，所以两种方式可能要并存。M1b 前确定。
7. 容器里能不能用 bwrap。如果不能，需要一个"容器本身就是边界"的 sandbox 模式，并写进实例契约。
8. 托管时用到的 provider 是否都支持自定义 baseUrl 加占位 key。
9. 身份拆分对 Space 重连的影响：靠双读，加上"升级后再降级"的回归测试兜底。
10. A2A：主线 Issue 418 之后，同一 context 的 Task 续用一个 Runtime Session。迁到产品层之前，要重新核对 task-store 和 Session 是否双写，以及 A2A 的 principal key 怎么并入授权身份。
11. 沿用自第 3 版的行号没有重新核对（见文首）。M1a 开工前要先合并主线，再整体重核。
12. 扩展改了配置之后什么时候生效：`config.get` 说 `extension_reload`，实际 `extension.reload` 只重载已加载的模块，新加的要重启。改成如实说 `restart`，还是让 `reload` 按配置增删扩展，由用户定（2026-11-21 发现，见"用户设置"里扩展的落地细节）。

## 13. 后续 Feature（不在 v2.0 范围）

- **UI 直接写工作区文件**：让 UI 直接编辑并保存文件，类似 VS Code Web，属于长期设计。至少要考虑：
  - 用 `ifRevision` 防止和 agent 的写入冲突；
  - 走同一套权限规则；
  - 写入前备份，可撤销；
  - 写入要进入安全日志；
  - 要让 agent 知道文件被用户改过。
- **记忆和技能学习对网络角色开放**：等 FEATURE_309 之后按新模型设计。
- **单独的 HTTP blob 端点**：等有了大文件的真实需求再做。
- 定稿 ADR 时，把 v2 的 feature 一起登记到 FEATURE_LIST。一起登记是为了避免分支之间撞 ID。登记前查一遍 KodaX、KodaX-next-dev 和在途 worktree 的最大编号。截至 2026-11-20 已占用：
  - FEATURE_307 到 FEATURE_311；
  - ADR-076 到 ADR-078；
  - Issue 412 到 423。
