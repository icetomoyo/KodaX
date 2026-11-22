# 为远程客户端运行 KodaX Host

> 尚未发布。这里说的网络监听随 v2 Host 协议在之后的版本发布，现在只在开发线上。

这篇写给替别人运行 KodaX Host 的一方：给每个用户开云端工作区的平台、驱动 Agent 的后端，或者想让自己电脑上的 Host 一直在线的个人。它写清楚 Host 需要平台提供什么，以及 Host 承诺什么。想用手机连自己电脑上的 Host，看[远程访问](remote-access.zh-CN.md)。

## Host 是什么

一个 Host 就是一个 `kodax daemon serve` 进程。它独占一个 home 目录（`KODAX_HOME`，通常是 `~/.kodax`），里面是这个人的设置、Session 和记忆，并运行他的 Agent。客户端通过 WebSocket 连到它的 `/v2`。

- **一个 Host 只属于一个人。** 能连上的都是这个人本人，或者替他工作的后端。每个用户一个 Host，放在各自的容器或系统账号里。
- **一个 home 只有一个 Host。** home 已经被一个活着的 Host 持有时，再启动 `kodax daemon serve` 会以非 0 退出。
- 需要 Node.js 22.4 或更高版本，或者单文件版。见[安装](../getting-started/installation.zh-CN.md)。

## 配置监听

只有 `$KODAX_HOME/integrations/host.json` 要求时，Host 才监听网络。在 Host 启动之前写好这个文件。

```json
{
  "version": 1,
  "server": {
    "listen": { "hostname": "0.0.0.0", "port": 8080 },
    "jwt": {
      "issuer": "https://auth.example.com",
      "audience": "kodax-host-alice",
      "jwksUrl": "https://auth.example.com/.well-known/jwks.json"
    },
    "owner": "alice",
    "services": ["orders-backend"],
    "allowedOrigins": ["https://app.example.com"],
    "workspaceRoot": "/data/workspace",
    "tools": ["read", "grep", "glob", "edit", "write", "bash"]
  }
}
```

| 字段 | 含义 |
|---|---|
| `listen` | `{hostname, port}` 或 `{socketPath}`。Host 不做 TLS，放在你的 ingress 或服务网格后面。 |
| `jwt` | Host 怎么校验 token，见[Token](#token)。 |
| `owner` | 这个 Host 所属的人的 JWT `sub`，以 `user` 角色连接。 |
| `services` | 后端的 JWT subject，各自以 `service` 角色连接。 |
| `allowedOrigins` | 允许连接的浏览器来源，比如 `https://app.example.com`，不带路径。留空就拒绝所有浏览器。 |
| `pairing` | 允许这个人不用 JWT 配对浏览器。用于个人远程访问，见[远程访问](remote-access.zh-CN.md)。 |
| `webRoot` | 绝对路径，Host 在同一个端口上提供这个目录里的静态网页。见[提供 Web UI](#提供-web-ui)。 |
| `workspaceRoot` | 绝对路径。网络客户端按项目在它里面的相对路径指定项目；不配就不能指定项目。 |
| `tools` | 这个 Host 上任何 Run 能用的全部工具，不管谁提交。Session 和 Run 的策略只能在它里面再收窄。不配表示 Host 不设上限。 |

以下情况 Host 拒绝启动：

- 文件里有它不认识的字段，所以回滚镜像时要连这个文件一起回滚；
- 配了监听，却既没配 `jwt` 也没开 `pairing`；
- 配了 `jwt`，却没有任何人能用它连进来（没有 `owner`，也没有 `services`）；
- 配了 `owner` 或 `services`，却没配 `jwt`；
- 同一个 subject 既是 `owner` 又是 service。

### Host 运行时修改这个文件

- `owner`、`services`、`allowedOrigins`、`pairing`、`jwt`、`tools` 不用重启就生效。按新文件不再被接纳的连接会被断开：
  - `jwt` 变了，所有连接以 4401 断开，客户端换一个新校验能接受的 token 再连；
  - subject 或来源被删、`jwt` 被删、配对被关，受影响的连接以 4403 断开。
- `tools` 对下一个 Run 生效，正在跑的 Run 保留原来的上限。
- `listen`、`workspaceRoot`、`webRoot` 要重启才生效，改了只记一条警告。
- Host 读不懂的修改不生效，旧文件继续有效，错误写进日志。

## 谁能连进来

| 谁 | 怎么证明身份 | 角色 |
|---|---|---|
| 本人（`owner`） | `sub` 等于 `owner` 的 JWT | `user` |
| `services` 里的后端 | `sub` 在名单里的 JWT | `service` |
| 配对过的浏览器 | 配对时拿到的 cookie | `user` |
| 本机客户端（CLI、桌面应用） | home 里的令牌文件 | `owner` |

- `user` 能做一个人在界面上做的事：聊天、回答审批、看历史。
- `service` 还能把凭证和工具绑到 Session 上、设置 Session 策略。它创建的 Session 默认拒绝审批请求，因为那里没有人能回答。
- 只有本机客户端能管理 Host 本身。

浏览器一定会带 `Origin` 头。它的来源必须在 `allowedOrigins` 里，或者是某台配对设备配对时的来源。被拒的浏览器以 4403 `origin_not_allowed` 断开。不带 `Origin` 的客户端不是浏览器，只看 token。

Host 断开连接时，关闭码告诉客户端该怎么做：

| 关闭码 | 含义 | 客户端怎么做 |
|---|---|---|
| 4400 | 协议错误 | 不要重连 |
| 4401 | token 过期、无效，或 JWT 校验配置变了 | 换新 token 再连 |
| 4403 | 设备被吊销，或不再被接纳 | 不要重连 |
| 4408 | 60 秒没有任何帧 | 重连 |
| 4409 | 被同一客户端的新连接取代 | 不要重连 |
| 4429 | 过载 | 退避后重连 |
| 4503 | 正在停止，或暂时没法校验 token | 退避后重连 |

KodaX 客户端 SDK（`connectKodaXHost`）已经按这些关闭码处理。

## Token

Host 用你的身份提供方发布的公钥校验 JWT，只要求这几个 claim：

| Claim | 要求 |
|---|---|
| `iss` | 等于 `server.jwt.issuer` |
| `aud` | 等于 `server.jwt.audience`，或是包含它的数组。每个 Host 用自己的 audience，这样给一个 Host 的 token 打不开另一个。 |
| `sub` | `owner` 或 `services` 之一 |
| `exp` | 还没到。有 `nbf` 时也检查。时钟可以差 30 秒。 |

不要求 `typ: at+jwt`、`jti`、`client_id`，所以 Keycloak 和 Entra 默认签发的 token 能直接用。

- 签名算法：RS256/384/512、PS256/384/512、ES256/384/512 或 EdDSA。RSA 至少 2048 位。拒绝 `none` 和 HS*。
- JWKS：必须是 HTTPS，HTTP 只允许精确的 loopback 地址。私网地址可以。响应不超过 1 MiB，10 秒内返回，不跟随重定向。
- Host 把读到的 key 集用 10 分钟。token 点名一个没见过的 `kid` 时重读一次，30 秒内最多一次，所以轮换的 key 立即可用。
- Host 一次都没读到过 key 集时，新连接以 `unavailable` 被拒（客户端会重试），而不是 `unauthorized`。已有的连接不受影响。

token 的有效期要短。token 到期时 Host 以 4401 断开连接。客户端在那之前用 `auth.renew` 续期；SDK 在 token 有效期过去 80% 时自动续期。

### 最小样例

自己签发 token 的平台需要一对密钥、一个 JWKS 地址和一个签发 token 的函数。下面只用 Node 标准库。

```js
import { generateKeyPairSync, sign } from 'node:crypto';

const ISSUER = 'https://auth.example.com';
const AUDIENCE = 'kodax-host-alice';
const KID = 'host-key-1';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

// 在 server.jwt.jwksUrl 提供这份 JSON。
export const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' }] };

const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 给一个人或一个后端签发 token，5 分钟有效。 */
export function issueHostToken(subject) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${part({ alg: 'ES256', typ: 'JWT', kid: KID })}.${part({ iss: ISSUER, aud: AUDIENCE, sub: subject, iat: now, exp: now + 300 })}`;
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}
```

客户端传一个函数，从你的后端取新 token：

```js
import { connectKodaXHost } from '@kodax-ai/kodax/browser'; // Node 里用 '@kodax-ai/kodax/client'

const host = await connectKodaXHost({
  url: 'https://alice.workspaces.example.com',
  client: { name: 'my-app', version: '1.0.0', instanceId: localStorage.kodaxInstanceId },
  credential: async () => (await fetch('/api/kodax-token')).text(),
});
```

每条连接、每次续期都会调用一次 `credential`。

## 生命周期

监听网络的 Host 在没有客户端时也不退出。收到 SIGTERM 时：

1. 监听进入排空：新连接回 503，已连接的客户端收到 `host.draining` 通知，`/healthz` 报 `draining`。
2. Run 停止或在检查点挂起，最多等 10 秒。客户端能看到自己的 Run 怎么结束。
3. 每条连接最多花 2 秒发完已排队的数据，再以 4503 关闭。
4. 进程清理后退出。

Host 这一段有 90 秒的总截止时间，之后的清理最多再花 160 秒，所以从 SIGTERM 到退出最坏约 250 秒。宽限期设到这么长，就不会走到 SIGKILL。设短一些也安全：被提前杀掉的 Host 下次启动时从 home 恢复。15 到 20 秒通常已经够客户端看到 Run 结束。

在 `/healthz` 还列着 blocker 时停掉 Host，正在跑的 Run 以结局未知结束，没人回答的提问会丢失。

### 没人回答的提问

默认情况下，审批请求等 5 分钟，普通提问一直等。没人回答的提问让 Host 一直处于忙碌状态，永远不会报 `canStop`。平台上应该设一个时限：

```bash
kodax daemon serve --user-input-timeout-ms 1800000 --permission-timeout-ms 1800000
```

## 健康检查：`/healthz`

在监听端口上 `GET /healthz`，返回：

```json
{ "state": "ready", "canStop": true, "blockers": [], "lastActivityAt": 1795389425000 }
```

- `state` 是 `ready` 时回 200；是 `starting` 或 `draining`，或者 Host 报不出健康状态时回 503。就绪探针指向这里。
- `canStop` 和 `blockers` 说明现在停掉会不会打断工作，比如 `active_runs`、待回答的提问、正在写入的改动。
- `lastActivityAt` 是最后一次看到 Host 忙碌的时间，UTC 毫秒。用它回收空闲的 Host。
- 不包含任何 Session 内容，不需要凭据。
- 开着 `pairing` 时只返回 `{ "state": ... }`。配对的 Host 经隧道访问，隧道把端口暴露给所有人，完整的返回会让陌生人知道主人什么时候在用电脑。

## 日志

日志是 JSON 行：`{time, level, message, data}`。前台运行的 `kodax daemon serve` 把它写到 stdout，同时写进 home 里的 `daemon.log`。`kodax daemon logs` 打印这个文件。

安全事件的 `data.source` 是 `host.security`，消息是 `[host.security] <事件名>`，事件内容在 `data.detail` 里。里面不会有 token 或参数值：

- `auth_failed`：被拒的 token、浏览器来源或配对尝试；
- `permission_decided`：谁回答了哪个审批，怎么回答的；
- `trusted_use`：`service` 连接用了特权方法或特权参数；
- `device_paired`、`device_revoked`。

## 上限

| 项 | 值 |
|---|---|
| 单帧大小 | 8 MiB |
| 还在握手的连接 | 32 个，再多回 503 |
| 空闲连接 | 60 秒，客户端在此之内发 ping |
| 发给一个客户端但它没读的数据 | 64 MiB，超过就断开 socket |
| 上传的块 / 单个文件 / 整个 Host | 512 KiB / 32 MiB / 1 GiB |

## 平台检查清单

这些 KodaX 不替你做：

1. 每个用户一个容器或系统账号，一个 home 只有一个 Host。home 放在同一时间只能被一个 Host 挂载的卷上。
2. 封锁到 `169.254.169.254` 和集群内网的出站流量。模型在 `bash` 里执行的命令，能访问容器能访问的一切。
3. 平台自己的模型 key 不要放进 Host 的环境变量，模型执行的命令会继承它们。用一个自动加 key 的出口代理，或者让可信客户端按请求借出 key（凭证租约）。
4. 在 ingress 或服务网格上做 TLS。
5. JWT 有效期要短，`aud` 绑定到这个 Host。
6. 提供 Web UI 时，用严格的 CSP 并净化输出，见下文。

## 容器

PID 1 用 init 进程，比如 `tini` 或 `docker run --init`。否则 `bash` 命令留下的进程会变成僵尸进程。

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG KODAX_VERSION
RUN npm install -g @kodax-ai/kodax@${KODAX_VERSION}
ENV KODAX_HOME=/data/kodax
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["kodax", "daemon", "serve", "--user-input-timeout-ms", "1800000"]
```

shell 命令的系统沙箱在非特权容器里可能用不了，把容器本身当作边界。

一个副本、`ReadWriteOncePod` 卷的 StatefulSet 保证一个 home 只有一个 Host。init 容器把 ConfigMap 里的 `host.json` 复制进 home。不重启就修改鉴权字段时，直接改卷里的这个文件。

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kodax-alice
spec:
  replicas: 1
  serviceName: kodax-alice
  selector:
    matchLabels: { app: kodax-alice }
  template:
    metadata:
      labels: { app: kodax-alice }
    spec:
      terminationGracePeriodSeconds: 260
      securityContext: { fsGroup: 1000 }
      initContainers:
        - name: host-config
          image: busybox:1.36
          command: ["sh", "-c", "mkdir -p /data/kodax/integrations && cp /config/host.json /data/kodax/integrations/host.json"]
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: host-config, mountPath: /config }
      containers:
        - name: host
          image: registry.example.com/kodax-host:1.0.0
          ports:
            - { name: v2, containerPort: 8080 }
          readinessProbe:
            httpGet: { path: /healthz, port: v2 }
            periodSeconds: 10
          livenessProbe:
            tcpSocket: { port: v2 }
            periodSeconds: 30
          volumeMounts:
            - { name: data, mountPath: /data }
      volumes:
        - name: host-config
          configMap: { name: kodax-alice-host }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOncePod"]
        resources:
          requests: { storage: 20Gi }
```

不要把 `/healthz` 用作存活探针：Host 启动和排空时它回 503，这时重启会打断工作。

## 让自己电脑上的 Host 一直在线

CLI 替你启动的 Host 也读同一个 `host.json`。只有需要 Host 在任何程序启动它之前就在线时，才需要配成服务。

### Linux：systemd 用户服务

保存为 `~/.config/systemd/user/kodax-host.service`，把路径换成 `command -v kodax` 的输出。

```ini
[Unit]
Description=KodaX Host
After=network-online.target

[Service]
ExecStart=/usr/local/bin/kodax daemon serve
Restart=on-failure
RestartSec=10
TimeoutStopSec=260

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kodax-host
loginctl enable-linger "$USER"   # 注销后继续运行
journalctl --user -u kodax-host  # 查看日志
```

如果 home 已经被另一个 Host 持有，`serve` 以非 0 退出，systemd 每 10 秒重试一次，直到那个 Host 停止。

### Windows：任务计划程序

`kodax daemon start` 在后台启动 Host，不弹窗口。登录时运行它：

```powershell
$kodax = (Get-Command kodax.cmd).Source
$action = New-ScheduledTaskAction -Execute $kodax -Argument 'daemon start'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'KodaX Host' -Action $action -Trigger $trigger
```

这个任务不会重启崩溃的 Host。下次登录，或者运行任何 `kodax` 命令，都会再把它启动起来。

## 提供 Web UI

`server.webRoot` 在监听端口上提供静态文件，网页和 Host 同源。

- 只认 `GET` 和 `HEAD`。`/` 对应 `index.html`；未知路径不会回退到 `index.html`。
- 经 `..` 或链接跑出 `webRoot` 的路径回 404。
- 响应带 `X-Content-Type-Options: nosniff` 和 `X-Frame-Options: DENY`，不带 CSP，也不带缓存头。

能连上 Host 的网页就能在 Host 上执行命令：注入到页面里的脚本可以借这个人自己的连接提交 Run、回答审批。配对浏览器的 cookie 是 `HttpOnly` 的，脚本偷不走，但仍然能利用打开的页面。关键的防线有两道：

**严格的 CSP。** Host 不发 CSP，所以写在页面里：

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">
```

- `script-src` 里不要有 `'unsafe-inline'` 或 `'unsafe-eval'`。
- `connect-src 'self'` 覆盖同源的 Host WebSocket。如果较旧的浏览器不认，再加上页面的 `wss://` 来源。
- `img-src` 不放远程地址，模型输出就不能加载一张 URL 里带着数据的图片，把数据带出去。

**净化输出。** 模型回复、工具结果、文件内容和命令输出，都可能包含攻击者写的文字，比如模型抓取的网页。

- 按纯文本显示，或者按关掉原始 HTML 的 Markdown 显示。
- 链接只允许 `http:` 和 `https:`，打开时带 `rel="noopener noreferrer"`。
- 模型输出里的远程图片，不经用户同意不要加载。
- diff 和代码按文本显示，不要经过 `innerHTML`。
