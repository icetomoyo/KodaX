# 在 KodaX Host 上运行平台后端

这篇指南写给平台团队：你们的后端为自己的用户使用 KodaX Host。后端以 `service` 角色连接；如果它运行在 Host 所在的机器上，则以 owner 身份连接。它给 Session 设上限、出借 key 和工具、启动子 Agent。一个 Host 只属于一个人。由你的平台决定这个人是谁、他用哪个 Host。Host 内部不做租户隔离。

- 连接、核心循环和错误：[编写客户端](host-client.zh-CN.md)。
- 每个方法的参数和结果：[Host 协议参考](host-protocol-reference.md)。
- `host.json`、token、角色和 `userLocks`：[运行 KodaX Host](../deployment/host.zh-CN.md)。
- 把 KodaX 嵌入你自己的进程：[进程内](in-process.zh-CN.md)。

## 谁能调用什么

Host 把方法分成几个平面，每个角色能到达其中一部分。数据平面包括 Session、Run、历史、子 Agent 和记忆。设置平面包括这个人的配置、provider、MCP server 和扩展。受信平面包括租约、`session.policy.update`、`session.promote` 和下面列出的受信参数。本地平面管理 Host 本身和它所在机器上的路径。

| 角色 | 怎么连接 | 能到达 |
|---|---|---|
| `owner` | 本机的令牌文件，`ensureKodaXHostClient` 就是这样连的 | 数据、设置、受信、本地 |
| `user` | `sub` 等于 Host 的 `server.owner` 的 JWT，或者配对过的设备 | 数据、设置 |
| `service` | `sub` 在 `server.services` 名单里的 JWT | 数据、受信 |

`service` 不能调用 `interaction.respond`，因为审批和提问是问这个人的。`user` 不能调用 `agent.registration.*`，因为外部 Agent 注册只留给 owner。

只有能到达受信平面的角色才能发送这些参数：

- `session.create` 的 `policy`。
- `input.submit` 的 `budget`、`prompt` 和 `leases`。
- `run.startTool`、`run.recover`、`command.execute`、`review.start`、`agent.reviewLean`、`actor.spawn`、`actor.followup`、`workflow.start`、`session.compact` 和 `provider.reasoning.probe` 的 `leases`。
- `workflow.start` 的 `script`。脚本运行时没有沙箱。

网络角色用 `project` 指定项目，它是工作区里的一个路径。`projectRoot`、`localAttachments` 和 `session.create` 的 `mcpServers` 只给 owner 用。

调用连接没有的方法，报 `method_not_found`，和调用 Host 没有的方法得到的回答一样。发送角色不能发的参数，报 `forbidden`，reason 为 `param_not_allowed`。根据握手结果的 `methods` 决定做什么，不要根据 `role`。

## 用 Session 策略设上限

策略约束一个 Session 的每个 Run，不管是谁提交的。在 `session.create` 上设置：

```ts
const { session } = await host.call('session.create', {
  requestId: createRequestId(),
  project: 'app',
  policy: {
    tools: ['read', 'grep', 'glob', 'lookup_order'],
    budget: { maxIter: 40, maxDurationMs: 10 * 60_000 },
    interactions: 'reject',
  },
});
```

| 字段 | 固定什么 |
|---|---|
| `tools` | Run 能用的全部工具，按名字列出。不设时沿用 Host 自己的上限。 |
| `budget` | `maxIter`（一个 Run 最多几轮模型调用）和 `maxDurationMs`。 |
| `agentProfile` | 模型是谁：`id`、`name`、`version`、`surface`、`instructions`。 |
| `prompt` | 每个 Run 开始时带的规则和参考资料。见下一节。 |
| `interactions` | `wait` 把提问和审批交给人。`reject` 立刻回绝。 |
| `leases` | 这个 Session 每个 Run 都用的租约。见 [Run 用哪把 key](#run-用哪把-key)。 |
| `defaultSkill` | `{ name }`：每条输入都经过的 Skill，输入文字作为它的参数。 |

上限是一层套一层的。Host 的 `server.tools` 对每个 Run 都生效。Session 策略在它之内收窄，Run 又在 Session 之内收窄。两层设了同一项上限时，取较低的那个。Session 和 Run 发什么都放宽不了 `server.tools`。

- `maxDurationMs` 从 Run 开始工作时算起，等人回答的时间也算在内。到时的 Run 以 `interrupted` 结束，code 为 `time_limit`。
- 用完全部轮次的 Run，结局里有 `limitReached: true`。
- `service` 创建 Session 时不设 `interactions`，就是 `reject`。人创建的是 `wait`。
- `session.policy.get` 读取策略。`session.policy.update` 整个替换策略，对之后开始的 Run 生效；已经在工作的 Run 保持开始时的策略。
- 设了 `defaultSkill` 时，点名另一个 Skill 的输入（`/summarize the memo`）改走那个 Skill。Skill 在 Run 开始时才查找，所以排队中的输入用的是那时 Session 的设置。项目里没有这个名字的 Skill，输入报 `not_found`，reason 为 `default_skill_unavailable`。不基于 Skill 构建的 Agent，不设这个字段即可。

`session.create` 的 `agent` 指定 `agent.list` 里的一个 Agent。它的指令和工具被复制进策略，在 `policy` 设定的范围内再收窄，Session 也从这个 Agent 的模型开始。`agent` 和 `policy.agentProfile` 一起发，报 `invalid_params`。名字不存在，报 `not_found`。

`input.submit` 的 `budget` 再收窄单个 Run。带 `budget` 或 `prompt` 的输入单独开始一个 Run：不和其他等待中的输入合并，也不能 `steer`。

## 定制提示词

`prompt` 把你的规则和参考资料加进模型读到的内容。可以作为 Session 的 `policy.prompt` 设置，也可以作为单个输入的 `prompt` 设置，或者两者都设。

```ts
prompt: {
  context: [
    { key: 'house-style', kind: 'rule', text: 'Answer in British English.' },
    { key: 'order-faq', kind: 'reference', text: faqText },
  ],
},
```

- `rule` 是要遵守的。`reference` 是可以引用的资料。规则带着你的权威，所以来自用户的文本要放进 `reference`。
- `key` 由小写字母、数字、`.`、`_` 和 `-` 组成，最多 64 个字符。
- 最多 64 条。所有文本加起来不超过 8,000 个字符。
- 模型先读 Session 的条目，再读 Run 的。Run 的条目不能重用 Session 的 key。
- Run 的条目只对这个 Run 有效。下一个 Run 会告诉模型它们已经不可用。
- `kodaxGuidance: 'omit'` 去掉 Host 自己的工作指引。

## 出借凭证

凭证租约让 Run 用你的 key，而不是 Host 的。Run 需要 key 时，Host 向你的连接要，所以 key 从不存在 Host 上。

```ts
await host.call('lease.register', {
  requestId: 'acme-keys', kind: 'credential', providers: ['anthropic'],
});
host.answerLeaseRequests(async (request) => vault.keyFor(request.provider));
```

然后在 `input.submit` 上发送 `leases: { credential: 'acme-keys' }`，或者把租约绑到 Session 策略里。

- 租约 id 就是 `lease.register` 的 `requestId`。重发时回答同一个租约。同一个 id 下内容不同，报 `conflict`。
- `providers` 列出 1 到 64 个 provider。`expiresAt`（UTC 毫秒）是租约结束的时间。不设时，租约一直有效，直到 `lease.revoke`。
- 请求里有 `provider`、`sessionId`、`target`（Run、子 Agent 的一轮、workflow 或一次操作）和 `purpose`。用它们挑选 key、记到正确的账上。
- 没有 key 时返回 `undefined`，这次模型调用就会失败。不设处理函数时，每个请求都立刻被拒绝。
- 处理函数抛出的错误交给 `onError`。Host 只收到一个固定的词，所以错误信息里的 key 不会离开你的进程。

### Run 用哪把 key

1. 如果 Session 策略绑定了凭证租约，这个 Session 的每个 Run 都用它。客户端在这里启动的每一轮子 Agent 也用它。
2. 否则 Run 用启动它的那次调用里发送的租约。
3. 否则用 Host 自己的 key：先看 Host 的环境变量，再看用 `provider.key.set` 存下的 key。

在策略绑定了租约的 Session 里，调用自带租约会报 `invalid_params`，reason 为 `lease_bound_by_session`。

把租约绑到 Session，就把这个 Session 和你的客户端实例绑在一起：

- 你的连接需要 `instanceSecret`。没有时，Host 拒绝并报 `invalid_params`，reason 为 `instance_identity_required`。
- 你的实例必须持有这个租约。否则 Host 拒绝并报 `not_found`，reason 为 `lease_not_found`。
- 你的实例不在线时，需要这把 key 的 Run 在提交时被拒绝，报 `unavailable`，reason 为 `lease_holder_away`。

## 出借工具

`host_tool` 租约出借在你的后端里运行的工具。模型像调用自己的工具一样调用它们。

```ts
await host.call('lease.register', {
  requestId: 'acme-tools', kind: 'host_tool',
  tools: [{
    name: 'lookup_order',
    description: 'Finds an order by its id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    sideEffect: 'none',
  }],
});
host.answerToolCalls(async (call) => ({ content: await orders.describe(call.input.id) }));
```

然后在 `input.submit` 上发送 `leases: { hostTools: 'acme-tools' }`，或者把租约绑到 Session 策略里。

- 一个租约出借 1 到 64 个工具。名字以字母开头，由字母、数字、`_`、`.` 和 `-` 组成，不能和 Host 已有的工具重名。
- `sideEffect` 是 `none`、`idempotent` 或 `non_idempotent`。`none` 的工具只读，模型在规划时也能调用。其他工具在计划模式下不运行。
- `content` 是模型读到的内容。可选的 `structuredContent` 的结构在 `outputSchema` 里描述。
- 结果最大 1 MiB。Host 的 `KODAX_HOST_TOOL_MAX_RESULT_BYTES` 可以改这个值。
- 回答为错误的调用，在模型看来是结果未知的调用。处理函数抛出的错误交给 `onError`。Host 只收到 `host_tool_unavailable` 或 `host_tool_failed`。

不点名就不提供：

- 只有输入或 Session 指定了租约，Run 才拿得到租约里的工具。
- 工具上限按名字算，对出借的工具同样生效。如果设了 `server.tools` 或 `policy.tools`，要把你的工具名加进去。
- 上限之外的工具不会提供给模型。对它调用 `run.startTool`，Run 会以 "Tool is not active" 失败。
- 在 `reject` 的 Session 里，需要审批的工具调用不会运行。模型会被告知没有人可以问。

进程内的库没有审批回调时，会拒绝改变状态的工具。详见[进程内](in-process.zh-CN.md)。

## 重连后保留租约

租约属于你的客户端实例，不属于某一条连接。

- 用同样的 `instanceId` 和 `instanceSecret` 重连，租约就还在。没有 `instanceSecret` 时，租约随每条连接结束。
- SDK 不会替你恢复租约。重连后，用 `kind` 和 `leaseId` 调用 `lease.resume`。工具租约随后会收到你不在时等着的调用。
- Host 重启后，`lease.resume` 报 `not_found`。用同一个 `requestId` 重新注册。
- 每个 key 请求和工具调用最多等 60 秒，你不在线的时间也算在内。Host 的 `KODAX_REVERSE_CALL_TIMEOUT_MS` 可以改这个值。key 请求到租约的 `expiresAt` 也会结束。
- Run 进行到一半时 Host 被替换，SDK 会在新 Host 上继续这个 Run。给 `connectKodaXHost` 传 `recoveryLeases: async (runId) => ({ credential: 'acme-keys' })`，继续的 Run 就能拿到你的租约。

`lease.call.get` 按 `callId` 告诉你一次工具调用的结果。Host 保留最近 1000 次调用：

| 状态 | 含义 |
|---|---|
| `waiting` | 还没发出，因为你的客户端不在线 |
| `sent` | 已发出，还没有回答 |
| `completed` | 已用结果回答 |
| `unknown` | 发出后连接断了、时间到了，或者你回答了错误 |
| `not_sent` | 发出之前时间就到了 |

一次调用绝不会发两次。在你自己的存储里记下 `callId`，让 `non_idempotent` 的工具可以安全重试。

## 启动子 Agent

子 Agent 在 Session 里处理自己的目标。你的后端像 Session 的主 Agent 那样启动它。

```ts
const { actorPath, turnId } = await host.call('actor.spawn', {
  requestId: createRequestId(), sessionId: session.id,
  taskName: 'audit', objective: 'Check the order totals in data/.',
  forkTurns: 'none',
  capabilities: { filesystem: 'read', network: false, canAskUser: false },
});
```

- `taskName` 给出路径 `/root/<taskName>`。名字已被占用时报 `conflict`。
- `forkTurns` 是子 Agent 从主对话的多少内容开始：`all`（默认）、`none`，或者轮数。
- `capabilities` 收窄子 Agent 能做的事：`tools`、`filesystem`（`none`、`read` 或 `write`）、`network`、`providers` 和 `canAskUser`。
- 子 Agent 的一轮在 Session 的工具、时限和租约之内运行，也在 Host 的工具之内。
- `actor.followup` 给子 Agent 一个新目标。空闲的子 Agent 开始新的一轮（`started_turn`）。忙着的子 Agent 把它并入当前这一轮（`current_turn`）。`ifRevision` 是子 Agent 必须仍然处于的 actor `revision`。
- 两个方法的 `leases` 都按 [Run 用哪把 key](#run-用哪把-key) 的规则。出借的 key 只用于新的一轮；发给进行中的一轮，报 `invalid_params`。
- 停在上限的一轮，`terminationReason` 为 `'iteration_limit'`。

## 审批和提问

Run 可以停下来请求审批或等一个回答。Session 的 `interactions` 决定接下来怎样：

- `reject`：不问任何人。模型会被告知这一点，需要审批的工具调用不会运行。
- `wait`：连在这个 Session 上的每个客户端都看到请求。审批默认等 30 分钟（见[运行 KodaX Host](../deployment/host.zh-CN.md)）；提问一直等到有人回答。

`service` 连接不能回答，因为请求是问这个人的。要代表这个人回答，就在这个人自己的客户端里显示请求，这个客户端以 `user` 连接并调用 `interaction.respond`。Host 所在机器上的客户端是 owner，也可以回答。[编写客户端](host-client.zh-CN.md)里有调用示例。

权限请求带有 `toolName`、`reason`、`risk`、`inputPreview`；改文件时还带 `diff`，包括 `path`、`added`、`removed` 和 `unified` hunk。文件在工作区之外时没有 `path`。只有 owner 还会拿到 `hostPath`。

`allow_session` 和 `allow_always` 回答产生的授权，用 `permission.grant.list` 列出，用 `permission.grant.revoke` 收回；`service` 两个都能调用。Host 的安全日志把每次决定记为 `permission_decided`。

## 记忆

记忆是 Agent 关于这个人和项目记下的笔记。它在数据平面，所以每个角色都能用。

- 记忆的方法是 `memory.list`、`get`、`create`、`update`、`approve` 和 `forget`。`scope` 是 `user`（跟着这个人进入每个项目）或 `project`（由 `project` 指定）。
- Agent 推断出来的笔记是 `candidate`。只有 `active` 的笔记会被读进 Run。`memory.approve` 让笔记变成 active。forget 一条 candidate 就是拒绝它；forget 一条已经不在的笔记也算成功。
- 看起来像 key 或 token 的笔记，报 `invalid_params`，reason 为 `secret_in_note`。

```ts
const { note } = await host.call('memory.get', { scope: 'user', id: 'style' });
await host.call('memory.update', {
  requestId: createRequestId(), scope: 'user', id: 'style',
  ifRevision: note.revision, body: 'Prefers short answers.',
});
```

`ifRevision` 让修改只作用于你读到的那个版本，即笔记的 `revision`，一个字符串。期间被改过的笔记，报 `conflict`，reason 为 `revision_mismatch`。重新读取，再做决定。

## 设置、MCP 和扩展

设置平面是给这个人用的，所以 `service` 到达不了。后端改在每个 Session 上设置它需要的：策略，以及用 `session.settings.update` 设置模型、推理强度、权限模式和 `maxIter`。

`user` 连接可以改这个人的设置：`config.*`、自定义 provider、MCP server 和重新加载扩展。`config.update` 和 `session.settings.update` 接受 `ifRevision`，设置在你读取之后被改过时报 `conflict`。

`host.json` 里的 `userLocks` 从 `user` 连接拿走一些项。锁定项有 `providers`、`mcp`、`extensions`、`permissions` 和 `fullAccess`；各自固定什么见[运行 KodaX Host](../deployment/host.zh-CN.md#这个人的设置)。

- `server.tools` 里没有 `bash` 时，`mcpStdio` 自动生效。stdio server 随即被拒绝，reason 为 `tool_ceiling`。
- 被锁的调用报 `forbidden`，reason 为 `locked`。握手结果的 `locks` 列出生效的锁定项。锁只对 `user` 生效，所以 owner 和 service 拿到的 `locks` 是空的。
- 不管锁不锁 `user` 都拿不到的东西，列在同一节里。

## A2A

KodaX 双向支持 [A2A](https://a2a-protocol.org)，都用 `kodax a2a` 命令设置。

**调用其他 Agent。** `kodax a2a add <name> <cardUrl>` 添加一个远程 Agent。Host 把它注册为 Agent `external:<name>`。

- `--credential-env <NAME>` 从这个环境变量取 bearer token 发送。也可以改用 `--oauth-*` 这组参数设置 OAuth2 client credentials。
- `--effect none|read|write|unknown` 声明这个 Agent 可能改动什么。

**发布 Agent。** `kodax a2a expose [agent]` 发布默认 Agent，或者 `~/.kodax/agents` 里的一个 Markdown Agent。`--auth` 选择调用方怎么证明身份：

| `--auth` | 调用方发送 |
|---|---|
| `bearer-env`（默认） | `--token-env`（默认 `KODAX_A2A_TOKEN`）里的 token。调用方的身份是 `--principal`。 |
| `oauth2-jwt` | `--oauth-issuer` 签发的 access token，按 `--oauth-audience` 和 `--oauth-jwks-url` 校验。`--required-scope` 增加必需的 scope。 |
| `host` | 和 v2 客户端一样的 JWT，发到 Host 端口上的 `/a2a`。见[运行 KodaX Host](../deployment/host.zh-CN.md#在同一个端口上提供-a2a)。 |

- 没有 token 或 token 无效，回答 `401`。用 `oauth2-jwt` 时，token 有效但缺少必需的 scope，回答 `403` 和 `insufficient_scope`。
- `--workspace-mode managed|fixed`、`--workspace-root` 和 `--workspace-access none|read|write` 设置 Agent 在哪里工作。
- `kodax a2a serve` 在前台运行 Host，并在一个回环端口上提供 A2A，默认是 `127.0.0.1:8765`。
- 在代码里，`@kodax-ai/kodax/a2a` 提供 `discoverA2ARegistration`、`createKodaXA2AServer` 和 `safeA2AFetch` 等。

## ACP

`kodax acp serve` 在 stdio 上提供 Agent Client Protocol，给编辑器用。它运行在这台机器共用的 Host 上。选项有 `--cwd`、`--provider`、`--model`、`--effort`、`--thinking`、`--reasoning`、`--repo-intelligence`、`--repo-intelligence-trace` 和 `--permission-mode`（默认 `accept-edits`）。它默认以 `info` 级别把日志写到 stderr；`KODAX_ACP_LOG` 设置级别：`off`、`error`、`info` 或 `debug`。

## 外部 Agent

在 Host 上，外部 Agent 来自 A2A 配置。owner 用 `agent.registration.*` 管理它们的注册。没有外部 Agent 的 Host 对这些方法回答 `method_not_found`。

要运行你自己的执行器平面，在你的进程里使用 `@kodax-ai/kodax/agent` 的 `createAgentExecutorPlane`。

## 同一台机器上的受信 Main

Host 旁边的应用，比如桌面外壳，用 `ensureKodaXHostClient` 连接。它是 `owner`，能到达每个平面。它和 service 一样设置 `policy`、`prompt`、`budget` 和 `leases`，还能回答审批。

旧的产品客户端 `ensureKodaXClient` / `connectKodaXClient` 用 `authorizeExecution` 选项（常用 `createExecutionProfile` 辅助函数构造）在 Main 进程里授权每个 Run。这个客户端将被移除。把这部分逻辑移到 Session 的 `policy` 和租约上；见[从 v1 客户端迁移](host-client.zh-CN.md#从-v1-客户端迁移)。
