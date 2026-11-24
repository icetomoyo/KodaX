# 编写 KodaX Host 的客户端

如果你在写一个和 KodaX Host 对话的 UI 或工具，比如 Node 应用、桌面应用或网页，这篇指南就是写给你的。Host 是保存一个人的 Session 并运行他的 Agent 的进程。你的客户端用 v2 协议和它通信，展示它在做什么，并把这个人的要求发给它。

相关指南：选择入口和安装见[概览](overview.zh-CN.md)；每个方法的参数和结果见 [Host 协议参考](host-protocol-reference.md)；运行 Host 见[运行 KodaX Host](../deployment/host.zh-CN.md)；向 Host 出借密钥或工具的后端见[平台后端](host-platform.zh-CN.md)；在你自己的进程里运行 Agent 见[进程内](in-process.zh-CN.md)和[可选模块](optional-modules.zh-CN.md)。

## 选择入口

| 你想要 | 用 | 从 |
|---|---|---|
| 使用这台机器上的 Host，没有运行时启动它 | `ensureKodaXHostClient` | `@kodax-ai/kodax/client` |
| 在 Node 里通过网络连接 Host | `connectKodaXHost` | `@kodax-ai/kodax/client` |
| 在网页里连接 Host | `connectKodaXHost` | `@kodax-ai/kodax/browser` |

每个入口都返回一个 `KodaXHostClient`，返回时第一条连接已经打开。打不开时，promise 以 `HostProtocolError` 拒绝。两个入口都建立在 `createKodaXHostClient({ open })` 之上，但包里没有导出任何能打开这种连接的东西，所以请用上面的入口。

### 这台机器上的 Host

```ts
import { ensureKodaXHostClient } from '@kodax-ai/kodax/client';

const host = await ensureKodaXHostClient({
  client: { name: 'my-app', version: '1.0.0', instanceId: savedId, instanceSecret: savedSecret },
  onStartupProgress: progress => showProgress(progress),
  onError: error => console.warn(error),
});
```

- 这个 home 没有 Host 运行时，它会启动一个；有一个空闲的旧版本 Host 时，它会替换掉。之后 Host 退出了，客户端会再次启动它。
- `homeDir` 是包含 `.kodax` 的目录，和 CLI 的 `--home` 一样。`daemonStartupTimeoutMs` 限制启动最多花多久。
- `instanceId` 和 `instanceSecret` 让 Host 在重启后认出你的应用，它的工作仍然归它所有。每次安装存一次。
- `exitWhenIdle: true` 让这个客户端启动的 Host 在最后一个客户端离开约 30 秒后停止，除非它还有工作。
- `onError` 接收没有哪个调用会告诉你的事，比如一次失败的重连。

本地连接的角色是 `owner`，它的回答里带有这台机器上的路径，所以客户端的类型是 `KodaXHostClient<'local'>`。它用 `projectRoot`（绝对路径）指定项目。它还能管理 Host 本身，用的是 `host.get`、`host.preflight` 和 `host.stop` 这类方法。

#### 启动进度

`onStartupProgress` 接收启动器的阶段：`checking`、`starting`、`upgrading`、`waiting`（带 `reason`：`connected_clients`、`host_starting` 或 `host_stopping`）、`initializing`（带 `phase`：`modules`、`extensions`、`runtime`、`recovery`、`mcp`、`sessions`、`a2a` 或 `listener`）、`connecting` 和 `ready`。`ready` 表示客户端可以用了，不表示已经画出了什么。回调不会被等待，它抛出的错误会被忽略。客户端重启 Host 时，它会再次被调用。

### 网络上的 Host

```ts
import { connectKodaXHost } from '@kodax-ai/kodax/client'; // '@kodax-ai/kodax/browser' in a page

const host = await connectKodaXHost({
  url: 'https://alice.workspaces.example.com',
  client: { name: 'my-app', version: '1.0.0', instanceId: savedId },
  credential: async () => (await fetch('https://app.example.com/api/kodax-token')).text(),
});
```

- `url` 是 `http`、`https`、`ws` 或 `wss`。没有路径的地址会补上 `/v2`。
- `credential` 返回一个 JWT。每次连接都会调用它；token 的有效期过了 80% 时，还会再调用它来续期。它抛出错误时，首次连接会失败，重连则稍后再试。续期失败会交给 `onError`。
- 和 Host 配对过的浏览器不传 `credential`，由 cookie 证明身份。Host 自己提供的页面把 `location.origin` 作为 `url` 传入。
- 这里必须传 `instanceId`：4 到 128 个字母、数字、`_` 或 `-`。`instanceSecret`（32 到 256 个字符）可选；不传时，租约随每条连接结束。
- `instanceId` 和 `instanceSecret` 相同的两条连接是同一个客户端，Host 会永久关闭较旧的那条。给每个浏览器标签页各自的身份。
- Node 需要 22.4 或更高版本，因为要用全局 `WebSocket`。

Token、角色、来源和配对都在 Host 一侧设置：见[运行 KodaX Host](../deployment/host.zh-CN.md)和[远程访问](../deployment/remote-access.zh-CN.md)。

## 握手告诉你什么

`host.handshake` 是 Host 给当前连接的授权：

| 字段 | 含义 |
|---|---|
| `role` | `owner`、`user` 或 `service`。只用于显示和诊断。 |
| `subject` | 凭证指名的是谁。 |
| `host` | Host 的 `id` 和 `version`。 |
| `methods` | 这条连接可以调用的全部方法。 |
| `features` | 可选功能。这个 Host 不发送任何功能。 |
| `locks` | Host 运营者为这条连接锁定的设置，比如 `fullAccess`。 |
| `limits` | `maxFrameBytes`，以及存在时的 `idleTimeoutMs`、`blobChunkBytes`、`maxBlobBytes`、`blobQuotaBytes`。 |
| `expiresAt` | 凭证何时到期，单位是 UTC 毫秒。不过期时没有这个字段。 |

根据 `methods` 和 `locks` 决定提供什么，不要根据 `role`：一个角色能做什么，可能随 Host 版本变化。每次重连后重新读取握手。

```ts
const can = (method: string) => host.handshake.methods.includes(method);
const showSettings = can('session.settings.update');
const showFullAccess = !host.handshake.locks.includes('fullAccess');
```

## 核心流程

每个调用都经过 `host.call(method, params)`。命令（会改变东西的调用）带一个 `requestId`，用 `createRequestId()` 生成。时间都是 UTC 毫秒。游标和修订号是不透明的：原样传回，不要解析。Host 会拒绝它不认识的参数。结果里你不认识的字段，忽略即可。

### Session

```ts
import { createRequestId } from '@kodax-ai/kodax/client';

const { session } = await host.call('session.create', {
  requestId: createRequestId(), project: 'app', title: 'Fix the build',
});
```

- `project` 是 Host 工作区里的路径。本地 owner 改用 `projectRoot`。
- `session.list` 用 `limit` 和 `cursor` 分页，按 `project`、`tag`、`surface` 和 `includeArchived` 过滤。`session.get` 读取一个 Session。
- `session.archive`、`session.unarchive` 和 `session.delete` 各自指定一个状态，所以重复发送不会改变什么。

### 跟随 Session 视图

```ts
const observation = await host.observeSession(session.id, {
  onView: view => render(view),
  onClosed: reason => showClosed(reason),
});
```

- 每次变化后，`onView` 都会拿到完整的视图；客户端替你应用 Host 发来的补丁。第一份视图到达后，promise 才完成。重连后，客户端重新订阅并发出一份新视图。
- `onClosed` 表示 Host 永久结束了这个视图，比如 Session 被删除了。
- `observation.close()` 停止跟随。它不会停止任何 Run。

视图（`HostSessionView`）包含 `items`（对话）、`session`、`runs`、`queue`（等待中的输入）、`interactions`、`settings`（实际生效的设置）、Session 启动的 `workflows`，以及存在时的 `activity`、`contextBudget` 和 `sandbox`。带 `textTotal` 的条目只包含文本的末尾；用 `item.read` 分页读取全文。工具条目的 `tool.change` 说明文件工具改了什么。只用于显示的值，比如条目的 `type`，是开放的字符串：遇到不认识的条目类型，显示它的文本。

命令的回答和它引起的视图变化，到达顺序不确定。按 id 对应它们，比如用户条目的 `inputIds`。

`host.observeHost({ onView })` 用同样的方式跟随 Host 文档：最近的 Session、正在工作的 Run、任何 Session 里等人回答的事项，以及有多少学到的能力在等人处理。它不会继续文档里列出的 Run，只有 Session 视图会。

### 提交输入

```ts
const { input } = await host.call('input.submit', {
  requestId: createRequestId(), sessionId: session.id, text: 'Run the tests and fix what fails.',
});
```

- `requestId` 就是这条输入的 id。在知道输入的结果之前，一直保留它。
- 回答是输入的状态，而不是它的结果：`queued`、`submitted`（带 `runId`）、`withdrawn` 或 `dropped`。
- `delivery` 是 `immediate`、`after_turn`、`steer` 或 `redirect`。`steer` 和 `redirect` 用 `targetRunId` 指定一个 Run。
- `input.get` 再次读取一条输入。`input.withdraw` 撤回一条排队中的输入，并返回它的文本。

### 回答交互

Run 可以停下来问这个人一些事。问题出现在视图的 `interactions` 里，连到这个 Session 的每个客户端都能看到。第一个有效的回答决定结果。

| `kind` | 询问 | 用 `response` 回答 |
|---|---|---|
| `question` | 从 `options` 里选一个，或输入文字 | `{ kind: 'question', answer }` |
| `question_multi` | 一次问几个问题 | `{ kind: 'question_multi', answers }`，以每个问题的文本为键 |
| `question_input` | 输入文字 | `{ kind: 'question_input', text }` |
| `permission` | 批准一次工具调用 | `{ kind: 'permission', decision }` |

```ts
await host.call('interaction.respond', {
  requestId: createRequestId(), interactionId: interaction.id,
  response: { kind: 'permission', decision: { type: 'allow_once' } },
});
```

- 权限请求的 `request` 给出 `toolName`、`reason`、`risk` 和 `inputPreview`。工具要改文件时，`diff` 里有 `path`、`added` 和 `removed` 行数，以及 `unified` 差异块。把它们显示出来。
- `decision.type` 是 `allow_once`、`reject`（可带给模型看的 `reason`），或 `allow_session` / `allow_always`，后两者要带 `suggestionId`，值为请求的某个 `grantSuggestions` 的 `id`。
- `{ kind: 'skip' }` 让问题保持未回答。`{ kind: 'dismiss' }` 关闭它：问题算作未回答，权限算作拒绝。遇到不认识的 `kind`，不要回答。
- 回答的 `status` 是 `answered`、`unanswered`、`dismissed`，或者另一个回答先到时的 `already_resolved`。

### 读取 Run 的结果

Run 在有 `outcome` 之前都算进行中。根据它判断，不要根据 `phase`。

```ts
import { HostProtocolError } from '@kodax-ai/kodax/client';

async function waitForOutcome(runId: string) {
  for (;;) {
    try {
      const { run } = await host.call('run.wait', { runId, timeoutMs: 60_000 });
      return run.outcome;
    } catch (error) {
      if (!(error instanceof HostProtocolError) || error.kodaxCode !== 'timeout') throw error;
    }
  }
}
```

- `run.wait` 在 Run 有了结果时回答，或者过了 `timeoutMs`（最多 60 秒）以 `timeout` 失败。Run 会继续；再问一次即可。
- `outcome.status` 是 `completed`、`failed`、`cancelled`、`interrupted` 或 `unknown`。`unknown` 不是成功：Host 暂时还说不准。
- `outcome.effects` 说明 Run 在对话之外改了什么是否已知。`code` 对程序是稳定的。
- `finalText` 是模型最后的文本，截断在 64,000 个字符（`finalTextTruncated`）。`run.list` 不包含它。

### 停止 Run

带 `requestId` 和 `runId` 调用 `run.stop`，请求停止一个 Run。回答只说明请求已记录；Run 怎么结束的，看 `outcome`。带 `ifRunId` 的 `session.cancel` 停止 Session 正在做的一切，但只在那个 Run 仍是它当前的 Run 时生效，所以迟到的停止不会结束之后才开始的工作。

### 读取历史

- 不带游标的 `history.read` 返回最新的一页，最旧的条目在前。`nextCursor` 读它前面的一页，`newerCursor` 读后面的一页。它的条目和视图条目形状相同。
- `history.search` 在整个 Session 里查找文本。用 `around: { itemId: hit.itemId }` 调用 `history.read`，就能打开命中结果所在的那一页。
- 以 `resync_required` 失败的游标或 id 属于 Host 已不再保留的对话。从最新一页重新开始。

### 修改设置

```ts
const { revision } = await host.call('session.settings.get', { sessionId });
await host.call('session.settings.update', {
  requestId: createRequestId(), sessionId, ifRevision: revision,
  patch: { permissionMode: 'accept-edits', effort: null },
});
```

- `session.settings.get` 返回这个 Session 自己的选择。视图的 `settings` 显示实际生效的设置，包括 Host 默认值。
- `null` 清除一项设置，让它重新跟随 Host 的默认值。
- 带 `ifRevision` 时，如果设置在你读取之后变了，更新会以 `conflict` 失败。重新读取，再做决定。
- 被锁定的设置会以 `forbidden`（reason 为 `locked`）拒绝。
- `provider.list` 和 `provider.reasoning.efforts` 用来填充模型和推理强度的选择器。

## 可靠性

### 连接状态

```ts
const stopListening = host.onConnectionChange((state) => {
  if (state.state === 'reconnecting') showOffline(state.attempt);
  else if (state.state === 'connected') offer(host);
  else showClosed(state.error?.kodaxCode ?? 'closed');
});
```

监听器注册时会立即以当前状态被调用一次。`connected` 带有 `handshake`；Host 宣布要停止后还带 `draining: true`，这时不要再开始新的工作，等下一条连接。

- `reconnecting`：连接断了。客户端自己打开新连接，两次尝试之间从半秒等到最多 30 秒。期间发出的调用会等下一条连接。
- `closed` 是永久的：你调用了 `close()`，客户端已退出，或者 Host 的拒绝不会因为重试而改变，比如设备被吊销。这时 `host.closed` 完成。

客户端已经按 Host 的关闭码处理；关闭码表见[运行 KodaX Host](../deployment/host.zh-CN.md#谁能连进来)。客户端重连到另一个 Host（替换了旧 Host 的那个）时，会把所跟随 Session 中做到一半的每个 Run（phase 为 `recovering`）各继续一次。它从不继续这个客户端要求停止的 Run。

### 重发与 `requestId`

断开时还没完成的调用，会在下一条连接上原样再发一次。查询可以放心重复。`resend` 为 `auto` 的命令（几乎所有命令）在同一个 `requestId` 下不会重复执行任何事：再次发送时，它按当前的状态回答。只有当前状态不是命令要求的状态时，它才以 `conflict` 失败。所以每个意图用一个 `requestId`，不要为重试同一个意图生成新的 id。

### `unknown_outcome`

少数命令是 `resend: 'never'`：`host.stop`、`client.exit.request`、`mcp.server.reload`、`extension.reload` 和 `provider.reasoning.probe`。再发一次可能会停掉替换上来的 Host，或者重复付费的工作。这类命令断开时，调用以 `unknown_outcome` 拒绝：Host 可能做了，也可能没做。再次发送之前，先看看发生了什么，比如用 `mcp.server.list`。

你关闭客户端时还在进行中的调用，也会以 `unknown_outcome` 拒绝。保留 `requestId`，之后再查结果。对于输入，把 `requestId` 作为 `inputId` 传给 `input.get`，就能知道它的状态。

### 错误

每个调用都以 `HostProtocolError` 拒绝。根据 `kodaxCode` 判断，不要根据消息文本。`reason` 是用于显示和日志的开放细节。`retryable` 说明重试是否有用。

| `kodaxCode` | 怎么做 |
|---|---|
| `invalid_params`、`method_not_found` | 修正调用。 |
| `unauthorized`、`forbidden` | 凭证或角色不允许。`reason` 有更多信息，比如 `locked`。 |
| `not_found` | 对象已经不在了。 |
| `conflict` | 状态不是命令需要的：`ifRevision` 过期、Session 正忙、同一个 `requestId` 下有不同的回答。重新读取。 |
| `invalid_state` | Host 现在做不了，或者不支持这个协议。 |
| `resync_required` | 游标、轮次或视图位置过期了。从头重新读取。 |
| `limit_exceeded` | 太大了，比如帧超过 `maxFrameBytes`。 |
| `overloaded`、`unavailable`、`timeout` | 可以重试。有 `retryAfterMs` 时先等这么久。 |
| `cancelled` | 你取消了调用。 |
| `unknown_outcome` | 见上文。 |
| `internal` | Host 出错。显示 `incidentId`；它指向 Host 日志里的那条记录。 |

要放弃一个调用，把 `{ signal }` 作为第三个参数传入。中止会请 Host 取消，并仍然等它回答，因为只有 Host 知道发生了什么。还在等重连的调用会立即以 `cancelled` 拒绝。

## 文件

### 图片和附件

图片按块上传，每块最多 `limits.blobChunkBytes`，这样其他消息不会被堵住。一个 blob 属于一个 Session。

```ts
import { createHash } from 'node:crypto'; // Node 中，图片是 Buffer `bytes`

const chunkBytes = host.handshake.limits.blobChunkBytes ?? 512 * 1024;
const sha256 = createHash('sha256').update(bytes).digest('hex');
let { blobId, received } = await host.call('blob.begin', {
  requestId: createRequestId(), sessionId, mediaType: 'image/png', byteLength: bytes.length, sha256,
});
while (received < bytes.length) {
  const data = bytes.subarray(received, received + chunkBytes).toString('base64');
  ({ received } = await host.call('blob.write', { requestId: createRequestId(), sessionId, blobId, offset: received, data }));
}
const { blob } = await host.call('blob.commit', { requestId: createRequestId(), sessionId, blobId });
await host.call('input.submit', {
  requestId: createRequestId(), sessionId, text: 'What is in this picture?', attachments: [{ blobId: blob.blobId }],
});
```

- `received` 是下一次写入的位置。Host 已经有这些字节时，`blob.begin` 回答全部已收到，你只需提交。
- `blob.commit` 用 `sha256` 校验字节。不匹配时，这次上传作废。
- 本地 owner 可以用 `localAttachments` 附上本机的文件。
- 视图条目的 `attachments` 给出 `blobId`；只有本地 owner 还会拿到 `path`。`blob.read` 以 base64 分块返回字节；一直跟随 `nextCursor`，直到它不存在。游标以 `resync_required` 失败，说明 blob 变了。

### 读取工作区

连到有工作区的 Host 的网络连接可以读取工作区，但不能修改。路径都在工作区内，名字之间用 `/` 分隔，`.` 表示工作区本身。

- `workspace.list` 一页一页地列出目录。
- `workspace.read` 以 base64 分块返回文件，带 `nextCursor`。文件变了之后，游标会以 `resync_required`（`file_changed`）失败。
- `workspace.gitDiff` 以 unified diff 返回 git 看到的某个目录下的改动；`staged: true` 比较暂存区和 `HEAD`。超过 256 KiB 的 diff 会被截断并标明 `truncated`。

`.env`、`.ssh` 这类机密会以 `forbidden` 拒绝，也不会出现在列表和 diff 里。没有工作区的 Host，以及本地连接，会以 `forbidden`（`workspace_not_configured`）拒绝这些方法。

## WebSocket 被拦截时

`connectKodaXHost` 先试 WebSocket。打不开时，它改用同一端口上的普通 HTTP：一条 server-sent events 流向下，POST 向上。你的代码不用改。HTTP 成功过之后，同一个客户端对象在下次连接时先试 HTTP，HTTP 不通了再回到 WebSocket。你的 ingress 不能缓冲 `/v2/events`（见[运行 KodaX Host](../deployment/host.zh-CN.md)）。

## 离开 Host

`host.close()` 永久关闭客户端；Run 会继续。本地 owner 可以调用 `client.exit.request` 停止这个客户端自己在 Host 上的工作；带 `shutdownHost: true` 时，没有其他客户端连着的话也会停止 Host。之后客户端关闭。停止会打断工作时，`host.stop` 以 `conflict` 失败；`host.preflight` 说明是什么挡着。

## 从 v1 客户端迁移

旧的产品客户端，即返回 `KodaXProductClient` 的 `ensureKodaXClient` / `connectKodaXClient`，在 v0.7.100 之前仍可使用，到时会被移除。[协议 v2：v1 方法对照](../../docs/SDK_MIGRATION.md#协议-v2v1-方法对照未发布)列出了每个 v1 调用对应的 v2 方法。
