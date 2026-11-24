# Run a platform backend on a KodaX Host

This guide is for a platform team whose backend uses a KodaX Host for its users. The
backend connects as the `service` role, or as the owner when it runs on the Host's
machine. It sets limits on Sessions, lends keys and tools, and starts child Agents.
One Host belongs to one person. Your platform decides who that person is and which Host
they get. The Host does not keep tenants apart inside itself.

- Connecting, the core loop and errors: [Build a client](host-client.md).
- Every method with its params and result: [Host protocol reference](host-protocol-reference.md).
- `host.json`, tokens, roles and `userLocks`: [Run a KodaX Host](../deployment/host.md).
- Embedding KodaX in your own process: [In-process](in-process.md).

## Who may call what

The Host sorts its methods into planes, and each role reaches some of them. The data
plane holds Sessions, Runs, history, child Agents, memory and learning. The settings
plane holds the person's configuration, providers, MCP servers and extensions. The
trusted plane holds leases, `session.policy.update`, `session.promote` and the trusted
params below. The local plane manages the Host itself and paths on its machine.

| Role | Connects with | Reaches |
|---|---|---|
| `owner` | The local token file, as `ensureKodaXHostClient` does | data, settings, trusted, local |
| `user` | A JWT whose `sub` is the Host's `server.owner`, or a paired device | data, settings |
| `service` | A JWT whose `sub` is listed in `server.services` | data, trusted |

A `service` may not call `interaction.respond`, because an approval or a question is
addressed to the person. A `user` may not call `agent.registration.*`, because external
Agent registrations stay with the owner.

Only a role that reaches the trusted plane may send these params:

- `policy` on `session.create`.
- `budget`, `prompt` and `leases` on `input.submit`.
- `leases` on `run.startTool`, `run.recover`, `command.execute`, `review.start`,
  `agent.reviewLean`, `actor.spawn`, `actor.followup`, `workflow.start`,
  `session.compact` and `provider.reasoning.probe`.
- `script` on `workflow.start`. A script runs without a sandbox.

Network roles name a project with `project`, a path inside the workspace. `projectRoot`,
`localAttachments` and `mcpServers` on `session.create` are for the owner only.

A method your connection lacks fails with `method_not_found`, the same answer as for a
method the Host lacks. A param your role may not send fails with `forbidden`, reason
`param_not_allowed`. Decide what to do from the handshake's `methods`, not from `role`.

## Set limits with a Session policy

A policy binds every Run of a Session, whoever submits it. Set it on `session.create`:

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

| Field | What it fixes |
|---|---|
| `tools` | The only tools a Run may use, by name. Absent leaves the Host's own limit. |
| `budget` | `maxIter`, the most model turns of a Run, and `maxDurationMs`. |
| `agentProfile` | Who the model is: `id`, `name`, `version`, `surface`, `instructions`. |
| `prompt` | Rules and references every Run starts with. See the next section. |
| `interactions` | `wait` puts questions and approvals to a person. `reject` answers them at once. |
| `leases` | Leases every Run of the Session uses. See [Which key a Run uses](#which-key-a-run-uses). |

Limits nest. The Host's `server.tools` holds for every Run. A Session policy narrows it,
and a Run narrows the Session. Where two layers set the same limit, the lower one holds.
Nothing a Session or a Run sends lifts `server.tools`.

- `maxDurationMs` counts from when the Run starts working, time spent waiting for a
  person included. A Run that reaches it ends `interrupted` with the code `time_limit`.
- A Run that used all its turns has `limitReached: true` in its outcome.
- A Session a service creates without `interactions` is `reject`. One a person creates
  is `wait`.
- `session.policy.get` reads the policy. `session.policy.update` replaces all of it for
  Runs that start later; a Run already working keeps the policy it started with.

`agent` on `session.create` names an Agent from `agent.list`. Its instructions and tools
are copied into the policy, where they narrow what `policy` sets, and the Session starts
on that Agent's model. Sending `agent` with `policy.agentProfile` fails with
`invalid_params`. An unknown name fails with `not_found`.

`budget` on `input.submit` narrows one Run further. An input with `budget` or `prompt`
starts a Run of its own. It is not joined with other waiting inputs and cannot `steer`.

## Customize the prompt

`prompt` adds your rules and references to what the model reads. Set it as
`policy.prompt` on the Session, as `prompt` on one input, or both.

```ts
prompt: {
  context: [
    { key: 'house-style', kind: 'rule', text: 'Answer in British English.' },
    { key: 'order-faq', kind: 'reference', text: faqText },
  ],
},
```

- A `rule` is to be followed. A `reference` is material to draw on. A rule carries your
  authority, so put text from your users in a `reference`.
- `key` is lowercase letters, digits, `.`, `_` and `-`, up to 64 characters.
- At most 64 entries. All the text together stays within 8,000 characters.
- The model reads the Session's entries first, then the Run's. A Run entry may not reuse
  a key of the Session.
- A Run's entries hold for that Run. The next Run tells the model they are no longer
  available.
- `kodaxGuidance: 'omit'` leaves out the Host's own working guidance.

## Lend credentials

A credential lease lets a Run use your keys instead of the Host's. The Host asks your
connection for a key when a Run needs one, so the key is never saved on the Host.

```ts
await host.call('lease.register', {
  requestId: 'acme-keys', kind: 'credential', providers: ['anthropic'],
});
host.answerLeaseRequests(async (request) => vault.keyFor(request.provider));
```

Then send `leases: { credential: 'acme-keys' }` on `input.submit`, or bind the lease in
the Session policy.

- The lease id is the `requestId` of `lease.register`. Sent again, it answers with the
  same lease. Different content under the same id fails with `conflict`.
- `providers` lists 1 to 64 providers. `expiresAt`, in UTC milliseconds, ends the lease.
  Without it, the lease lasts until `lease.revoke`.
- The request names the `provider`, the `sessionId`, the `target` (a Run, child turn,
  workflow or operation) and the `purpose`. Use them to pick the key and bill the right
  account.
- Return `undefined` when you have no key. The model call then fails. Without a handler,
  every request is refused at once.
- What your handler throws goes to `onError`. The Host is told only a fixed word, so a
  key in an error message never leaves your process.

### Which key a Run uses

1. If the Session's policy binds a credential lease, every Run of the Session uses it.
   So does every child turn a client starts there.
2. Otherwise a Run uses the lease sent with the call that started it.
3. Otherwise it uses the Host's own keys: its environment first, then `provider.key.set`.

In a Session whose policy binds leases, a call that sends its own fails with
`invalid_params`, reason `lease_bound_by_session`.

Binding a lease to a Session ties the Session to your client instance:

- Your connection needs an `instanceSecret`. Without one, the Host refuses with
  `invalid_params`, reason `instance_identity_required`.
- Your instance must hold the lease. Otherwise the Host refuses with `not_found`, reason
  `lease_not_found`.
- While your instance is away, a Run that needs the key is refused at submit with
  `unavailable`, reason `lease_holder_away`.

## Lend tools

A `host_tool` lease lends tools that run in your backend. The model calls them like its
own tools.

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

Then send `leases: { hostTools: 'acme-tools' }` on `input.submit`, or bind the lease in
the Session policy.

- A lease lends 1 to 64 tools. A name starts with a letter and holds letters, digits,
  `_`, `.` and `-`. It must not be the name of a tool the Host has.
- `sideEffect` is `none`, `idempotent` or `non_idempotent`. A `none` tool only reads,
  and the model may call it while it plans. Other tools do not run in plan mode.
- `content` is what the model reads. Describe the shape of the optional
  `structuredContent` in `outputSchema`.
- A result may be at most 1 MiB. The Host's `KODAX_HOST_TOOL_MAX_RESULT_BYTES` changes
  that.
- A call answered with an error reaches the model as a call whose outcome is unknown.
  What your handler throws goes to `onError`. The Host is told only
  `host_tool_unavailable` or `host_tool_failed`.

Nothing is offered unless it is named:

- A Run gets a lease's tools only when its input or its Session names the lease.
- Tool limits go by name and apply to lent tools too. If `server.tools` or
  `policy.tools` is set, add your tool names to it.
- A tool outside a limit is not offered to the model. A `run.startTool` for it fails
  the Run with "Tool is not active".
- In a `reject` Session, a tool call that needs approval is not run. The model is told
  that nobody is there to ask.

An in-process library without an approval callback denies tools that change state.
[In-process](in-process.md) covers it.

## Keep leases across reconnects

A lease belongs to your client instance, not to one connection.

- Connect again with the same `instanceId` and `instanceSecret` and you keep your
  leases. Without `instanceSecret`, leases end with each connection.
- The SDK does not resume leases for you. After a reconnect, call `lease.resume` with
  the `kind` and `leaseId`. A tool lease then gets the calls that waited while you were
  away.
- After a Host restart, `lease.resume` fails with `not_found`. Register again under the
  same `requestId`.
- Each key request and tool call waits at most 60 seconds, time you are away included.
  The Host's `KODAX_REVERSE_CALL_TIMEOUT_MS` changes that. A key request also ends at
  the lease's `expiresAt`.
- When a Host is replaced while a Run is part-way, the SDK continues the Run on the new
  Host. Pass `recoveryLeases: async (runId) => ({ credential: 'acme-keys' })` to
  `connectKodaXHost` so the continued Run gets your leases.

`lease.call.get` tells you what became of a tool call, by its `callId`. The Host keeps
the latest 1000 calls:

| State | Meaning |
|---|---|
| `waiting` | Not sent yet, because your client was away |
| `sent` | Sent and not answered yet |
| `completed` | Answered with a result |
| `unknown` | Sent, then the link was lost, the time ran out, or you answered with an error |
| `not_sent` | The time ran out before it was sent |

A call is never sent twice. Make a `non_idempotent` tool safe to retry by keeping its
`callId` in your own store.

## Start child Agents

A child Agent works on its own objective inside a Session. Your backend starts it as
the Session's main Agent would.

```ts
const { actorPath, turnId } = await host.call('actor.spawn', {
  requestId: createRequestId(), sessionId: session.id,
  taskName: 'audit', objective: 'Check the order totals in data/.',
  forkTurns: 'none',
  capabilities: { filesystem: 'read', network: false, canAskUser: false },
});
```

- `taskName` gives the path `/root/<taskName>`. A name in use fails with `conflict`.
- `forkTurns` is how much of the main conversation the child starts from: `all` (the
  default), `none`, or a number of turns.
- `capabilities` narrows what the child may do: `tools`, `filesystem` (`none`, `read`
  or `write`), `network`, `providers` and `canAskUser`.
- A child turn runs within its Session's tools, time limit and leases, and within the
  Host's tools.
- `actor.followup` gives a child a new objective. An idle child starts a turn
  (`started_turn`). A busy child takes it into its current turn (`current_turn`).
  `ifRevision` is the actor `revision` the child must still have.
- `leases` on both methods follow [Which key a Run uses](#which-key-a-run-uses). A lent
  key is for a new turn only. Sent for a turn in progress, it fails with
  `invalid_params`.
- A turn that stopped at its limit has `terminationReason: 'iteration_limit'`.

## Approvals and questions

A Run can stop to ask for approval or for an answer. The Session's `interactions`
decides what happens:

- `reject`: nobody is asked. The model is told so, and a tool call that needs approval
  is not run.
- `wait`: every client attached to the Session sees the request. An approval waits 30
  minutes by default (see [Run a KodaX Host](../deployment/host.md)); a question waits
  until someone answers it.

A `service` connection cannot answer, because the request is addressed to the person.
To answer on a person's behalf, show the request in their own client, which connects as
`user` and calls `interaction.respond`. A client on the Host's machine is the owner and
may answer too. [Build a client](host-client.md) shows the call.

A permission request carries `toolName`, `reason`, `risk`, `inputPreview` and, for a
file change, `diff` with `path`, `added`, `removed` and `unified` hunks. `path` is
absent when the file is outside the workspace. Only the owner also gets `hostPath`.

Grants made by `allow_session` and `allow_always` answers are listed by
`permission.grant.list` and taken back with `permission.grant.revoke`; a `service` may
call both. The Host's security log records each decision as `permission_decided`.

## Memory and learning

Memory holds the notes the agent keeps about the person and a project. Learning holds
the Skills the Host learned from Sessions. Both are on the data plane, so every role
may use them.

- Memory methods are `memory.list`, `get`, `create`, `update`, `approve` and `forget`.
  `scope` is `user`, which follows the person into every project, or `project`, named
  by `project`.
- A note the agent inferred is a `candidate`. Only `active` notes are read into a Run.
  `memory.approve` makes a note active. Forgetting a candidate rejects it, and
  forgetting a note that is gone succeeds.
- A note that looks like a key or token fails with `invalid_params`, reason
  `secret_in_note`.
- `learning.*` records what the person decides about each learned Skill. A decision
  whose outcome already holds succeeds and does nothing. One the lifecycle does not
  allow fails with `conflict`, reason `invalid_transition`.

```ts
const { note } = await host.call('memory.get', { scope: 'user', id: 'style' });
await host.call('memory.update', {
  requestId: createRequestId(), scope: 'user', id: 'style',
  ifRevision: note.revision, body: 'Prefers short answers.',
});
```

`ifRevision` applies a change only to the version you read. For memory it is the
note's `revision`, a string. For learning it is the capability's `revision`, a number.
Something that changed meanwhile fails with `conflict`, reason `revision_mismatch`.
Read it again, then decide.

## Settings, MCP and extensions

The settings plane is for the person, so a `service` does not reach it. A backend sets
what it needs on each Session instead: the policy, and `session.settings.update` for
the model, effort, permission mode and `maxIter`.

A `user` connection may change the person's settings: `config.*`, custom providers, MCP
servers and extension reloads. `config.update` and `session.settings.update` take
`ifRevision` and fail with `conflict` when the settings changed since you read them.

`userLocks` in `host.json` takes items away from `user` connections. The locks are
`providers`, `mcp`, `extensions`, `permissions` and `fullAccess`;
[Run a KodaX Host](../deployment/host.md#the-persons-settings) says what each fixes.

- `mcpStdio` applies by itself when `server.tools` leaves out `bash`. A stdio server is
  then refused with reason `tool_ceiling`.
- A locked call fails with `forbidden`, reason `locked`. The handshake's `locks` lists
  what holds. Locks apply to `user` only, so the owner and services get empty `locks`.
- What a `user` never gets, whatever the locks, is listed in the same section.

## A2A

KodaX speaks [A2A](https://a2a-protocol.org) both ways, set up with the `kodax a2a`
commands.

**Calling other agents.** `kodax a2a add <name> <cardUrl>` adds a remote agent. The
Host registers it as the Agent `external:<name>`.

- `--credential-env <NAME>` sends a bearer token from that environment variable. The
  `--oauth-*` flags set up OAuth2 client credentials instead.
- `--effect none|read|write|unknown` declares what the agent may change.

**Publishing an agent.** `kodax a2a expose [agent]` publishes the default Agent, or a
Markdown Agent from `~/.kodax/agents`. `--auth` chooses how callers prove who they are:

| `--auth` | Callers send |
|---|---|
| `bearer-env` (default) | The token in `--token-env` (default `KODAX_A2A_TOKEN`). They act as `--principal`. |
| `oauth2-jwt` | An access token from `--oauth-issuer`, checked against `--oauth-audience` and `--oauth-jwks-url`. `--required-scope` adds scopes. |
| `host` | The same JWTs as v2 clients, at `/a2a` on the Host's port. See [Run a KodaX Host](../deployment/host.md#serve-a2a-on-the-same-port). |

- A missing or invalid token gets `401`. With `oauth2-jwt`, a valid token without a
  required scope gets `403` with `insufficient_scope`.
- `--workspace-mode managed|fixed`, `--workspace-root` and
  `--workspace-access none|read|write` set where the agent works.
- `kodax a2a serve` runs the Host in the foreground and serves A2A on a loopback port,
  `127.0.0.1:8765` by default.
- In code, `@kodax-ai/kodax/a2a` has `discoverA2ARegistration`, `createKodaXA2AServer`
  and `safeA2AFetch`, among others.

## ACP

`kodax acp serve` speaks the Agent Client Protocol on stdio, for editors. It runs on the
shared Host of this machine. `kodax acp serve --help` lists its options;
`--permission-mode` defaults to `accept-edits`. `KODAX_ACP_LOG` sets its stderr log level:
`off`, `error`, `info` (the default) or `debug`.

## External Agents

On a Host, external Agents come from A2A configuration. The owner manages their
registrations with `agent.registration.*`. A Host without external Agents answers those
methods with `method_not_found`.

To run an executor plane of your own, use `createAgentExecutorPlane` from
`@kodax-ai/kodax/agent` in your process.

## A trusted Main on the same machine

An app next to the Host, such as a desktop shell, connects with `ensureKodaXHostClient`.
It is the `owner` and reaches every plane. It sets the same `policy`, `prompt`, `budget`
and `leases` as a service, and it can answer approvals.

The older product client, `ensureKodaXClient` / `connectKodaXClient`, took an
`authorizeExecution` option, often built with the `createExecutionProfile` helper, to
authorize each Run in the Main process. That client will be removed. Move that logic to a Session `policy` and to
leases; see [Moving from the v1 client](host-client.md#moving-from-the-v1-client).
