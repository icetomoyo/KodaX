# KodaX Runtime/SDK v2：可被编排的单用户 Host

状态：定稿，2026-11-14。§9 的决策已经全部确认。下一步按 §5 从 M0 开始；M0 的第一项交付是 ADR。

来源：6 份领域调研、3 份交叉评审、1 份综合方案、2 份红队审查，以及第 2 版之后一次对照代码的独立评审。原文在本地 `docs/research/2026-11-14-sdk-v2/`（gitignored）。源码行号以 KodaX-next-dev `1178550d8` 为准；标"待核实"的条目没有逐行验证。

**定稿相对第 2 版的修正**（第 2 版之后又有一轮独立评审，以及一轮用户问答）：

- 事实修正：
  - A2A 的监听只能绑 loopback，JWT 校验器也不能原样复用；
  - SIGTERM 回执和常驻模式其实已经存在；
  - 锁已经按进程启动身份判断存活，第 2 版提的"实例随机数"是多余的。
- 补上的缺口：
  - Host 级工具上限；
  - 参数改成白名单；
  - 拆分"授权身份"和"连接实例身份"；
  - Host 按 `exp` 到期和吊销主动断开连接；
  - 等待中的交互和空闲回收；
  - 配置热加载与回滚；
  - A2A 与 v2 合用一个端口；
  - (b) 依赖 Space Renderer 迁移。
- 删掉的过度设计：
  - 关键路径不再先拆完整个 `server.ts`；
  - `RunBudget` 复用现有字段；
  - 去掉 blob 的单独 GC 和配对令牌的哈希盐。

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
| 平台自有 LLM key：出口代理注入、按租户计量 | 支持 provider 的 baseUrl 指向代理、使用占位 key |
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

## 1. 架构

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
| (d) 服务端嵌入 | 需要持久会话或业务工具时：每个终端租户一个 Host，由客户开通，客户后端以 service 身份连接。只做无状态的一次性调用时：在客户进程里用库，一个进程只服务一个信任域 | Node SDK、service 角色、Host Tool、工具上限 |

## 2. Host 实例契约

这一节是平台编排者唯一需要读的内容。M1b 时会把它写成一篇公开文档。

### 启动

沿用现有的 `kodax daemon serve`（前台运行，`kodax_cli.ts:3001`），不新增命令。

- 监听地址、鉴权、`workspaceRoot`、工具上限都写在 home 配置里一个独立的 `server` 块中。平台在启动 Host 之前写好这个块。
- **只要配置了网络监听，Host 就自动进入 persistent 生命周期**：
  - 由当前持有 home 的进程执行，做法与 A2A 相同（`kodax_cli.ts:911-935`）；
  - persistent 模式本身已经存在（`management.ts:62/96/317`）；
  - 这样也覆盖了 (b)：Space 拉起的 daemon 不会在 Space 关闭后因为成了孤儿而退出。
- 如果 home 已经被另一个存活的 Host 持有，`daemon serve` 必须以**非 0** 退出。现在是以 0 静默退出（`kodax_cli.ts:1001-1010`），在 systemd 或 K8s 下会被当成正常结束。

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
  - JWKS 必须走 HTTPS，但允许私网地址，因为这个地址是平台配置的；
  - 不要求 `tokenUrl` 和 `requiredScopes`。
- `owner`、`services`、`allowedOrigins`：只有这些身份和来源能连进来。
- `allowedOrigins` 默认为空，也就是拒绝所有浏览器来源。
- `tools`：Host 级工具上限。每个 Run 都会和它求交集，复用现有的 `intersectExecutionToolCeilings`（`execution-profile.ts:43`）。非编码的 (d) 场景用它去掉 fs 和 bash。
- 只要配置了网络监听而没配鉴权，Host 就拒绝启动。

### 配置变更

- 鉴权字段（`owner`、`services`、`allowedOrigins`、`pairing`、`tools`）**热生效**：在下一次握手时应用，同时立即断开不再符合的现有连接。复用 A2A 的配置热加载分类（`kodax_cli.ts:957-984`）。
- `listen` 和 `workspaceRoot` 改动后需要重启 Host。
- 配置里出现不认识的字段时，Host 拒绝启动（失败即关闭）。所以平台回滚镜像时，必须连同配置一起回滚。

### 生命周期

收到 SIGTERM 时的处理已经有了：`waitForShutdownSignal` → `host.close` → `runService.closeAll` → 把在途 Run 记为 `unknown` 并写入回执（`host.ts:207-262`，`sdk-runtime.ts:11473-11500`）。要补三件事：

1. 设一个总截止时间，必须小于平台的宽限期（K8s 默认 30 秒）；
2. **先取消 Run、短暂排空**，确认停下的 Run 记为 `stopped` 而不是 `unknown`，**然后再关闭传输层**，让客户端能收到终态。现在的顺序是先关传输层（`host.ts:229`）再取消 Run（`host.ts:259`）；
3. 补一个测试。

Host 重启后从 home 恢复，沿用现有的回执和 `unknown` 语义。

### 健康检查

`GET /healthz` 和监听共用一个端口，返回：

```
{state: starting|ready|draining, canStop, blockers, lastActivityAt}
```

- `canStop` 和 `blockers` 直接复用现有的停止前置检查（`management.ts:238-246/341/400-408`），它已经包含了在途 Run、待回答的交互和后台工作。
- 平台据此决定能不能回收这个 Host。
- 返回内容不包含任何会话内容信息。

### 等待中的交互

- 待回答的提问和审批，按角色给现有的 `permissionTimeoutMs` 和 `userInputTimeoutMs`（`sdk-runtime.ts:949-951`）设置默认值：
  - service：立即拒绝；
  - user：等待一个有限的时长，默认 30 分钟，平台可以修改。
- 不新增 `interactionPolicy` 类型。
- 现在 `userInputTimeoutMs` 默认为 0，也就是永不超时（`kodax_cli.ts:3018`），一个没人回答的提问会让容器永远无法回收。
- 契约里写明：平台在 `blockers` 不为空时强行 SIGTERM，等待中的 Run 会以 `unknown` 结束，提问也会丢失。

### 状态与锁

- 所有状态都在 home 里。
- 平台必须保证同一个 home 同一时刻只有一个 Host，用 RWOP 卷或等价手段。禁止多节点共享 NFS。
- 锁的存活判断已经按进程启动身份做了：`state.ts:734-758`，Linux 上读 `/proc/<pid>/stat` 的 starttime，能识别 pid 复用。
- 剩下一个洞：容器重启后 PID 命名空间变了，旧 pid 如果恰好对应另一个 uid 的进程，`kill` 会返回 EPERM，被判为 `unknown`，锁永远回收不掉（`state.ts:741-750`）。
  - 修正：锁记录里加上 PID 命名空间标识（`readlink /proc/self/ns/pid`）。命名空间不同，就直接判定旧持有者已不存在。
  - 这依赖上面"一个 home 一个 Host"的保证。

### 资源上限

- 在 `initialize` 结果的 `limits` 里宣告，包括：帧上限、单个 blob 上限、home 内 blob 总配额、出站队列上限、默认 Run 预算。
- 超出上限时返回明确的错误，不做静默截断。

### 日志

服务模式下向 stdout 写 JSON 行。以下安全事件必须记录：

- 鉴权失败；
- 权限决定：谁、在哪个 Run、对什么、批准还是拒绝；
- 特权参数的使用；
- 配对设备的签发和吊销。

### LLM 凭证

- **用户自带的 key**（本机或 BYOK）：沿用现有的配置和环境变量。bash 会继承 provider key（`bash.test.ts:1054` 是有意的设计），用户自己的 key 对自己可见，可以接受。
- **平台自有的 key 不能放进 Host 容器**：放在环境变量里会被 bash 继承；放在同一个 uid 的文件里，bash 能直接 `cat`；Host 自己的环境变量，同 uid 的进程可以从 `/proc/<pid>/environ` 读到。平台有两种做法：
  - **出口代理**：provider 的 baseUrl 指向代理，Host 里只放占位 key。按租户计量和限额也在这里做。
  - **按 Run 下发**：service 角色通过现有的 `credential: scoped` 绑定，在内存中给单个 Run 下发凭证（`client-host-authorization.ts:240`）。
- 待核实：托管时用到的 provider 是否都支持自定义 baseUrl 加占位 key。

### 版本兼容

- Host 必须能打开上一个版本写过的 home。持久格式只增加字段，不修改字段。
- UI 和 Host 的版本差异靠协议协商处理（D9）。
- v2 对未知参数一律报错（D2），因此"旧 Host 静默忽略新的安全参数"这种情况不会发生。

### 容器样例

- Dockerfile 用 `tini` 或 `--init` 作为 PID 1，否则 bash 工具留下的孙进程会变成僵尸进程。
- 提供 StatefulSet 样例。
- 提供平台签发 JWT 的最小样例，写明需要哪些 claim。

## 3. 关键决策（ADR 候选）

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
- **所有对象都用 `.strict()`**：未知字段返回 `invalid_params`。zod 默认会静默丢掉未知字段，而 v1 是 `additionalProperties:false`（`schema.ts:1030`）。
- 结果不允许是任意对象。
- 浏览器 SDK 不打包 zod，只带生成的类型；校验放在 Host 上做。

**否决**：

- TypeBox：要新增一个依赖。
- 保留现有的自定义帧：不利于语言中立。

### D3 增量视图

**决定**：

- 用 `session.subscribe` 取代现有的两套 observe 模型。
- 每次订阅（包括重连后的重新订阅）先发一份快照，之后发 patch，patch 带 `epoch` 和 `revision`。
- 每个 Session 每个 tick 只做一次 diff、编码一次，然后分发给所有订阅者。
- 视图有 150 项的窗口，被挤出窗口的项用 `item.remove` 表达。

**背压**：

- patch 可以丢：复用 `transport.ts` 的 `pendingViews`，按订阅记一个"已丢弃"标记，排空后补发快照。
- 响应和反向调用不能丢：超过硬上限时，以 `overloaded`（-32001）断开连接。

**否决**：

- `since` 增量续订：Host 不保留 patch 历史（`sdk-runtime.ts:10268`）。
- 可续传的事件日志：工作量是 L 级，而视图有 150 项上限，重拉快照的代价可以接受。

### D4 身份、角色、权限

#### 两种身份，各管各的

| 身份 | 构成 | 用途 |
|---|---|---|
| 授权身份 | 人类用户统一记为 `person`，包括 owner IPC、owner 的 JWT 和配对设备；后端记为 `service:<sub>` | 决定谁能 `run.recover`、看到哪些侧聊、幂等键的作用域、审计里记的是谁 |
| 连接实例身份 | 授权身份 + `instanceId` 或 `deviceId` | 客户端退出时清理哪些工作、反向调用发往哪条连接 |

为什么要拆开：现在的 principal 同时承担这两种职责（`client-lifecycle.ts:163-166`，`reverse-bridge.ts:863-918`）。如果直接把网络身份合并成一个 `net:<sub>`，会出两个问题：

- 手机关掉标签页，会把笔记本上的 Run 一起清掉；
- (b) 里本机和远程变成两个人，远程端恢复不了本机发起的 Run（`server.ts:1994`），也看不到本机的侧聊（`side-chat.ts:145`）。

**迁移**：

- owner IPC 的连接实例身份继续用原来的公式，`hash(instanceId, instanceSecret)`。
- `run.recover` 和侧聊的校验改为比对授权身份。
- 持久格式只增加字段。

#### 角色

角色决定能调用哪些方法、能传哪些参数，实现为一张白名单，默认拒绝，映射到现有的 `RUNTIME_METHOD_SCOPES`。

| 角色 | 凭证 | 能力 |
|---|---|---|
| owner | 本机 IPC 的 `daemon.token` | 全部，和现在一样 |
| user | JWT 的 `sub` 等于 `owner`，或者设备配对令牌 | core：Session、Run、Input、Interaction、View、Blob、只读的 Workspace；另外可用**用户设置**，平台可以按项锁定 |
| service | JWT 的 `sub` 在 `services` 列表里 | user 的全部能力，加上 trusted：Host Tool、执行授权、凭证下发 |

#### 参数白名单

现在服务端会接受任何连接传来的 `params.authorization`（`server.ts:2477`），过滤只做在客户端 SDK 里（`client-runtime-adapter.ts:31-33`）。v1 还有一些参数能直接触达 Host：

- `inputArtifacts[].path`（`schema.ts:358`）；
- `run.recover.options` 是任意对象（`schema.ts:370`）；
- `options.context`（`server.ts:2640-2650`）；
- `options.toolInvocation`。

所以 v2 改为**按角色的参数白名单**：

- user 角色传 `authorization`、`credential`、`hostTools`、`workspaceRoot` 一律拒绝。
- stdio MCP、`full-access`、persona/profile、持久化的权限规则，归入下面的"用户设置"，受平台锁定控制。
- 网络客户端只能用 `blobId` 引用文件，不能传 Host 上的路径。

#### 连接管控

- 凭证在握手时校验。Host 按 JWT 的 `exp` 设一个定时器，到期就断开连接。
- 吊销设备或改了鉴权配置时，Host 重新检查现有连接，不再符合的断开。
- 客户端被断开后重新连接即可，因此不需要 `auth.refresh`。

#### 两类设置：平台控制面与用户设置

一个 Host 只属于一个用户，而且运行在平台给的容器或 uid 里，隔离边界是容器。所以用户改自己 Host 的设置，影响不到别人。真正要挡住的，是用户改掉平台定下的约束。

- **平台控制面**：永远不通过网络开放，只能由平台写入 home 配置，本机场景下由 IPC owner 修改。
  - 包括整个 `server` 配置块：监听、鉴权、`owner`/`services`、`allowedOrigins`、配对开关、`workspaceRoot`、工具上限、资源上限、sandbox 模式。
  - 理由：用户如果能改这些，就能绕过平台的限制，比如放宽工具上限，或者把自己改成别的 owner。
- **用户设置**：对 user 角色开放，平台可以按项锁定。v2 在 M2 提供这一组方法。
  - 包括：MCP server（含 stdio）、skills 和扩展、provider 和模型偏好、用户自带的 key、持久化的权限规则、`full-access` 模式、persona。
  - 锁定方式：配置项 `server.userLocks: ['mcp', 'extensions', 'providers', 'permissions', 'fullAccess']`，默认不锁。企业私有部署 (c) 通常会锁一部分。
  - 硬规则：工具上限里没有 bash 时，stdio MCP 自动锁定。原因是启动 stdio MCP 本身就是在 Host 上执行一条命令，等于绕过工具上限。
  - key 只能写入，不能读回。

#### 设备配对

只用于 (b)。个人用户没有 IdP，而远程链接一旦泄露（浏览器历史同步、截图、隧道地址被扫描），任何拿到链接的人都能在这台电脑上执行命令。所以网络监听**必须**鉴权，Tailscale 下也一样：Host 区分不出流量来自隧道还是本机的其他程序。

流程（类似 Jupyter 的 token 链接，用户无感）：

1. 用户在 Space 里点"添加设备"，得到一个一次性配对链接和对应的二维码：`https://<隧道地址>/#pair=<配对码>`。配对码 10 分钟内有效，只能用一次。
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
- 票据换连接凭证、`auth.refresh`。

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

- `ADR.md:4405`："no multi-tenant consumer"；
- `embedder-guide.md:930-954`：推荐用 `setAgentConfigHome` 按租户切换 home，这和代码的实际行为矛盾。

### D6 工具（服务端嵌入）

- 需要按 Run 绑定、需要幂等和 `unknown` 对账的业务工具：用 service 角色的 Host Tool 租约。v2 承载现有的反向调用，语义不变。
- 无状态的工具：用现有的 streamable-http MCP。
- 非编码场景：用 Host 级的 `tools` 上限（§2）去掉 fs 和 bash，每个 Run 还可以通过执行授权再收窄。
- MCP annotations 只能收紧权限，不能放宽。

**反向调用路由**：

- 反向调用发往持有租约的那条连接（连接实例身份）。
- service 有多个副本时，故障转移的做法是：另一个实例对同一个 `leaseId` 执行 `resume`，或者重新注册后用 `run.recover` 接管。
- 待核实：`resume` 能不能跨 bridge key（`reverse-bridge.ts:877-918`）。M1b 前要确认；如果不能，就在契约里写明"service 副本故障时，在途 Run 会以 `unknown` 结束，由调用方重试"。

### D7 契约去泄漏

- 契约只使用自有 DTO：
  - 用 `ClientRunResult` 取代 `KodaXResult`（`client-contract.ts:1043`）；
  - 去掉 Host 的绝对路径；
  - goal、workflow、agents、AutoModeStats 改用契约自有的类型；
  - 加 lint 测试，确保契约文件只从 `./client-*` 导入。
- 公开面只分两层：core 和 trusted。trusted 永远不进浏览器 SDK。

**否决**：

- 在 v1 上加字段；
- 用 ACP 当产品契约。

### D8 嵌入的安全默认值

- 进程内库在没有设置审批回调（`events.beforeToolExecute`）时，危险工具直接默认拒绝，不经过告警版本。想全部放行，必须显式写 `allowAll`。
  - 现状是不传回调就放行（`permission-gate.ts:11`）。
  - 这是破坏性变更，所以拒绝时的工具结果和第一次拒绝时的日志都要写明原因和改法，CHANGELOG 里标为 breaking。
- 每个 Run 的预算复用现有字段：迭代上限用 `maxIter`（`packages/coding/src/types.ts:2246`），token 用 `tokenBudget`（`client-host-authorization.ts:230`）。r1 只新增 `maxDurationMs`。
- 费用上限归平台管。

### D9 协商与适配器

**协商**：

- 宣告 `protocol: 'kodax/2'`，带一个单调递增的 `revision`，再加不超过 12 个描述部署差异的 feature。
- 不比较 semver。
- 调用不认识的方法时返回 `method_not_found`，取代 `daemon_upgrade_required`（约 26 处）。

**适配器**：

- ACP 和 A2A 不在关键路径上。
- A2A 在容器形态下挂到 `/a2a`，在那之前只供本机使用。
- A2A 迁到产品层之前，先核实 task-store 和 Session 是否会双写。
- ACP 等 M2 有了 ToolFacts 再迁移。

## 4. v2 契约要点

```ts
initialize({protocol:'kodax/2', client:{name,version,instanceId}, auth:{scheme:'jwt'|'pairing'|'ipc', token}})
 -> {protocol, revision, features, role:'owner'|'user'|'service', subject,
     limits:{maxFrameBytes, maxBlobBytes, blobQuotaBytes, reverseCallTimeoutMs},
     host:{id, version}}

session.subscribe({sessionId}) -> {subscriptionId, snapshot: SessionView & {epoch, revision}}
type SessionPatch = {subscriptionId, epoch, baseRevision, revision, ops:(
  | {op:'item.upsert'; item:ViewItem; afterId?:string} | {op:'item.remove'; id:string}
  | {op:'text.append'; id:string; text:string}
  | {op:'set'; key:'activity'|'queue'|'interactions'|'runs'|'settings'|'session'; value:/* 按 key 判别 */})[]}

// 权限 Interaction 带上拟变更：{kind, locations?: 工作区相对路径[], diff?: {path, added, removed, unified?, truncated?}}
blob.upload(bytes ≤ maxBlobBytes) -> {blobId /* 不透明，只在本 home 内有效 */, mediaType, byteLength}
//  Host 把 blob 落到 home 下，交给 agent 的媒体输入（只接受 path，见 agent/media/types.ts）
//  删除 Session 时一起删掉；超过配额时拒绝上传；复用现有的 maintenance scheduler
interface ClientRunResult { finalText; signal?; interrupted?; limitReached?; usage?; writtenFiles? }
// Run 选项：maxIter?、tokenBudget?、maxDurationMs?（只有这一项是新增的）
```

- 错误统一为 `code + data.kodaxCode`，`kodaxCode` 取值：`resync_required`、`unknown`、`overloaded`、`insufficient_scope`、`conflict`、`unauthorized`。
- 所有变更方法都必须带幂等键，作用域是（授权身份, sessionId）。浏览器 SDK 把还没确认的 inputId 存在 storage 里。Stop 回执可以按 runId 查询。
- r1 冻结的内容：
  - 帧格式；
  - `initialize` 的结果；
  - 角色；
  - 视图 ops；
  - `ClientRunResult`；
  - blob 引用；
  - 幂等键；
  - 错误码；
  - 权限请求里的拟变更。
- M2 按 `revision+1` 追加：执行后的 `ToolFacts`、`workspace.list/read/gitDiff`、带实时状态的 `sessions.list` 和 `sessions.watch`。

## 5. 路线图

**关键路径**：M0 → M1a → M1b → M1c。

到 M1b，(a)(c)(d) 可用；到 M1c，(b) 可用。多租户由平台承担，不需要等 M2。

### M0 身份与生命周期底座（S-M）

**交付物**：

1. 新的 ADR，覆盖 D1-D9；修订 `ADR.md:4405` 和 embedder-guide。
2. 按连接传入角色：
   - Host 实现角色表和参数白名单；
   - 服务端拒绝非 owner/service 角色传入 `authorization`、`credential`、`hostTools`；
   - owner 的权限和现在一样。
3. 授权身份和连接实例身份拆开，持久数据双读。
4. 出站队列设上限，超出时以 `overloaded` 断开；token 比较改为常量时间。
5. SIGTERM 处理：
   - 设总截止时间；
   - 先取消 Run 并短暂排空，再关闭传输层。
6. 锁记录加 PID 命名空间标识。
7. `daemon serve` 发现 home 已有 owner 时，以非 0 退出。

**出口标准**：

- 网络 dispatcher 在没有传入角色时，所有方法都被拒绝。
- "升级后再降级，Space 重连并接回租约"的回归测试通过。
- 队列溢出测试通过。
- SIGTERM 测试：在途 Run 有终态回执，客户端在断开之前能收到终态。
- 模拟换 PID 命名空间重启后，Host 能正常启动。

### M1a v2 内核，先跑在 IPC 上（M）

**交付物**：

1. v2 编解码 + IPC 首帧嗅探。
2. 用 zod 定义约 35 个 core 方法（`.strict()`）+ golden 漂移测试。只把这些方法对应的 case 抽成领域 handler，v1 也调用同一份 handler。
3. subscribe/patch。
4. `ClientRunResult`，以及去掉内部泄漏的 DTO。
5. `maxDurationMs`。
6. 按角色设置交互超时的默认值。
7. Node 版 v2 SDK。
8. 进程内库在没有审批回调时，默认拒绝危险工具（D8）。

**第一个用户**：REPL。

**出口标准**：

- 属性测试证明"快照 + patch 序列"等价于完整视图。
- 一个和协议无关的场景测试驱动，在 core 方法上对 v1 和 v2 都通过。
- REPL 跑在 v2 上。

### M1b 网络与浏览器（M-L）

**交付物**：

1. `server` 配置块和 v2 WS 监听：
   - 抽出 JWT 字符串校验，放宽 claim 要求；
   - 配置热生效；
   - 在 `exp` 到期和吊销时断开连接；
   - 没配鉴权就拒绝启动；
   - 配了监听就进入 persistent 模式。
2. `/healthz`，复用现有的停止前置检查。
3. Host 级的 `tools` 上限。
4. 设备配对。
5. JSON 日志。
6. 浏览器 SDK：
   - 新入口，零 `node:` 依赖，不打包 zod；
   - 不改造 `sdk-client.ts`，因为它依赖 `node:path`、sdk-runtime、state、client-lifecycle 和 repl。
7. 单请求的 blob 上传，网络客户端只能用 blobId。
8. 权限请求带上拟变更的 diff。
9. 在 v2 上承载 service 的反向调用：`host_tool.invoke`、`execution.resolve`、`credential.request`。
10. 核实 `resume(leaseId)` 能否跨实例。
11. 文档：
    - 实例契约（§2）；
    - Dockerfile（带 tini）和 StatefulSet 样例；
    - systemd 和 Windows 任务计划程序样例；
    - JWT 最小样例；
    - 隧道加配对指南；
    - UI 的 CSP 和输出净化须知。

**出口标准**：

- 浏览器经过样例反向代理，能完成提交、审批（看到 diff）、回答提问、Stop 和上传图片。
- 不在 `owner` 或 `services` 里的 `sub` 被拒绝；JWT 到期后连接被断开，在途 Run 继续运行。
- user 角色调用 trusted 方法或传特权参数时被拒绝。
- 配了 `tools` 上限后，user 直接提交的 Run 和 `startTool` 都调用不到 bash。
- 以 service 身份跑通一个只带业务工具的 Run。

### M1c Space 整体迁移到 v2

- Renderer 和 Main 一起迁，在同一个 Space 版本里切换。升级到这个 SDK 版本的 Space 就只用 v2，不保留 v1 回退开关。
- 没迁完之前，Space 就继续用旧版 SDK。
- Space 打包一份静态 Web UI，交给 Host 的 `server.webRoot`。(b) 的远程访问依赖这一步。

### M2 前半：用户设置域

按 D4 提供"用户设置"这一组 v2 方法，并支持 `userLocks`：MCP、skills/扩展、provider/模型、用户自带 key（只写）、权限规则、`full-access`。(a) 的用户可以在网页上自己装 MCP。

### M2 富 UI（M，三项可以并行）

1. 执行后的 `ToolFacts`：`edit.ts:207` 和 `write.ts:58` 已经算出了 diff，只需要接线。
2. 只读的 workspace 域：
   - 提供 `list`、`read`、`gitDiff`；
   - 根目录是 `workspaceRoot`；
   - 文件打开后基于 fd 做包含关系校验；
   - 沿用 read 工具的拒绝规则。
3. `sessions.list` 带实时状态，以及 `sessions.watch`。
4. WS 被拦截时的自动回退：
   - Host 侧：在同一端口上提供 HTTP 承载，下行用 SSE，上行用 POST；SSE 带心跳，并禁用代理缓冲。
   - SDK 侧：浏览器 SDK 自动探测并切换。

### M3 收尾

1. ACP 迁到 v2，删掉 `infer*`。
2. A2A 挂到 `/a2a`，并核实双写问题。
3. `server.ts` 剩余的 case 全部拆成领域 handler，删除 15 个已退役的方法。
4. 合并 `schema.ts`。
5. 可选：子路径从 19 个减到 6 个。旧入口保留为转发，加弃用警告，配迁移指南，至少保留 2 个版本。
6. 拆分 embedder-guide。
7. 满足 §6 的条件后删除 v1。

## 6. 迁移、兼容与回滚

### 客户端：一次切换

升级到新 SDK 的客户端（Space、REPL、ACP）就只用 v2。没迁完的客户端继续用旧版 SDK，不在客户端里保留 v1/v2 双路径。

### Host：过渡期内两种协议都接

v1 只需要在 **Host** 里保留一段时间，原因是一台机器上的 Host 被多个版本不同的客户端共用（ADR-075）。例如：

- 用户升级了 Space，但全局安装的 `kodax` CLI 还是旧版；
- Zed 里的 ACP 集成是旧版；
- 外部客户基于 v1 client 写的程序。

这些旧客户端连到新 Host 时，Host 仍然要能用 v1 应答。

### 新客户端连到旧 Host

比如旧 CLI 先拉起了旧 Host，新 Space 再去连：

- v2 握手失败；
- 沿用现有的 `ensure` 逻辑，Host 空闲时替换它，忙时提示用户重启。

### 删除 v1

- 节奏自己定，比如 v2 发布后再过 2 个版本。
- CHANGELOG 提前公告。
- Host 遇到 v1 连接时打印弃用警告。

### 其他规则

- 改造期间，不新增 v1 方法、能力键、子路径和 `export *`。
- 平台回滚 Host 镜像时，必须把配置一起回滚（§2）。
- **测试**：全部放进 `test:contract`，不新增 CI 触发方式。
  - 内容：
    - v1/v2 场景契约测试，覆盖幂等、CAS、首个有效回答生效、Stop 回执；
    - schema golden；
    - patch 属性测试；
    - 角色和参数白名单矩阵；
    - 双身份测试：多设备时，一台设备退出不影响其他设备；本机和远程可以互相恢复；
    - 故障注入：host tool 派发后断连、SIGTERM 排空、PID 命名空间变化。
  - 需要 Linux 容器的验证写进 `docs/test-guides/`。

## 7. 安全底线

### Host 侧

以下任何一条不满足，就不开放网络监听：

1. 角色只来自验证过的凭证；未验证的连接没有任何权限；`daemon.token` 和 v1 只走 IPC。
2. 只有 `owner` 和 `services` 能连接；浏览器来源必须在 `allowedOrigins` 里；`exp` 到期或吊销时断开连接。
3. 方法和参数都用白名单，默认拒绝，未知字段直接报错；网络客户端不能传路径。
4. Host 级的工具上限对所有 Run 生效。
5. 出站队列和 blob 都有上限；没有配鉴权就拒绝监听；安全事件写进日志。

### 平台侧

KodaX 在实例契约里给出检查清单，但不实现：

1. 每个用户一个容器或 uid；同一个 home 同时只有一个 Host。
2. 出口封锁 `169.254.169.254` 和集群内网。bash 里的 curl 不经过 `guardedHttpGet`，所以只能在网络层拦。
3. 平台自有的 key 走出口代理，或者按 Run 下发。
4. TLS。
5. JWT 有效期要短，`aud` 绑定到这个 Host。
6. UI 使用严格的 CSP，并净化模型和工具的输出。

## 8. 精简收益

- RPC 方法从 189 个降到约 85 个，`server.ts` 拆成领域 handler（关键路径上只拆 core 部分）。
- 能力键从约 74 个降到"基线 + 不超过 12 个 feature"；删掉约 26 处升级分支。
- `schema.ts`（2027 行）和手写契约合并成一份 zod 定义。
- 删掉 ACP 的 `infer*` 猜测，以及 REPL 从文本里解析 diff 的逻辑。
- 子路径从 19 个降到 6 个；embedder-guide（7436 行）拆成不超过 5 篇、每篇不超过 400 行的指南，再加一份生成的参考文档。
- 不新建网关、launcher、中继、配额或审计子系统。生命周期、停止检查、凭证绑定、工具上限、Run 预算都复用现有实现。

## 9. 已确认的决策（2026-11-14）

1. 一个 Host 只服务一个人类用户，不做多人共享，也不做 ACL。
2. 平台自有的 LLM key 走出口代理或按 Run 下发，KodaX 不做凭证保险箱。
3. user 角色等待交互的默认超时为 30 分钟，平台可以修改。
4. 过渡期按我们自己的节奏：
   - 客户端一次切换到 v2（§6），不设截止日期，也不收集外部客户的 import 清单；
   - 子路径合并是瘦身，不是功能需求，优先级最低。真要合并时，旧入口保留并转发到新入口，加弃用警告，配迁移指南，至少保留 2 个版本。
5. 默认按"代理不拦截 WS"设计，同时实现自动回退：
   - 浏览器 SDK 先尝试 WS；
   - 握手失败或超时，就自动切到 HTTP 承载：下行用 SSE，上行用 POST；
   - 上层 API 不变，并在同一网络环境下记住这次选择；
   - M1b 先让 Host 的连接层与传输方式解耦，M2 再完成回退。
6. (b) 先做隧道，不做中继。网络监听必须鉴权：用一次性配对链接换取设备令牌（D4）。
7. 平台控制面不通过网络开放。用户设置对 user 角色开放，平台可以逐项锁定（D4）。
8. 进程内库没有审批回调时，直接默认拒绝危险工具，不先出一个只告警的版本（D8）。
9. v2.0 的 workspace 接口只读。UI 直接写文件另立 feature（§11）。

## 10. 风险与待核实

1. `resume(leaseId)` 能否跨实例（`reverse-bridge.ts:877-918`）。这决定 service 多副本时能不能做故障转移，M1b 前必须确认。
2. 容器里能不能用 bwrap。如果不能，需要一个"容器本身就是边界"的 sandbox 模式，并写进实例契约。
3. 托管时用到的 provider 是否都支持自定义 baseUrl 加占位 key。
4. patch 和 150 项窗口裁剪之间的交互：靠属性测试兜底。
5. 身份拆分对 Space 重连的影响：靠双读，加上"升级后再降级"的回归测试兜底。
6. A2A 是否会双写。
7. 移动网络下反复重拉快照的成本：上线后观察，必要时再评估做事件日志。

## 11. 后续 Feature（不在 v2.0 范围）

- **UI 直接写工作区文件**：让 UI 直接编辑并保存文件，类似 VS Code Web，属于长期设计。至少要考虑：
  - 用版本号做 CAS，防止和 agent 的写入冲突；
  - 走同一套权限规则；
  - 写入前备份，可撤销；
  - 写入要进入安全日志；
  - 要让 agent 知道文件被用户改过。
  - 定稿 ADR 时和 v2 的其他 feature 一起登记到 FEATURE_LIST。一起登记是为了避免分支之间撞 ID。
