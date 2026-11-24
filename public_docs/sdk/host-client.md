# Build a client of a KodaX Host

This guide is for you if you write a UI or a tool that talks to a KodaX Host: a Node app, a desktop
app or a web page. A Host is the process that keeps one person's Sessions and runs their agents.
Your client speaks the v2 protocol to it, shows what it does and sends what the person asks.

Related guides: [Overview](overview.md) for choosing an entry, the
[Host protocol reference](host-protocol-reference.md) for every method's params and result,
[Run a KodaX Host](../deployment/host.md), [Platform backends](host-platform.md), and
[In-process](in-process.md) and [Optional modules](optional-modules.md) for agents in your process.

## Choose an entry

| You want to | Use | From |
|---|---|---|
| Use the Host on this machine, and start it when none runs | `ensureKodaXHostClient` | `@kodax-ai/kodax/client` |
| Reach a Host over the network from Node | `connectKodaXHost` | `@kodax-ai/kodax/client` |
| Reach a Host from a web page | `connectKodaXHost` | `@kodax-ai/kodax/browser` |

Each returns a `KodaXHostClient` whose first connection is open. If it cannot be opened, the promise
rejects with a `HostProtocolError`. Both are built on `createKodaXHostClient({ open })`, but the
package exports nothing that opens such a connection, so use the entries above.

### The Host on this machine

```ts
import { ensureKodaXHostClient } from '@kodax-ai/kodax/client';

const host = await ensureKodaXHostClient({
  client: { name: 'my-app', version: '1.0.0', instanceId: savedId, instanceSecret: savedSecret },
  onStartupProgress: progress => showProgress(progress),
  onError: error => console.warn(error),
});
```

- It starts the Host of this home when none runs, or replaces an idle older one. If the Host goes
  away later, the client starts it again.
- `homeDir` is the directory that contains `.kodax`, as with the CLI's `--home`.
  `daemonStartupTimeoutMs` limits how long the start may take.
- `instanceId` and `instanceSecret` let the Host recognise your app after a restart, so its work is
  still its own. Store them once per installation.
- `exitWhenIdle: true` makes a Host this client started stop about 30 seconds after its last client
  leaves, unless it still has work.
- `onError` receives what no call tells you, such as a failed reconnect.

The local connection has the `owner` role and its answers carry paths on this machine, so the client
is typed `KodaXHostClient<'local'>`. It names a project with `projectRoot`, an absolute path. It can
also manage the Host itself, with methods such as `host.get`, `host.preflight` and `host.stop`.

#### Startup progress

`onStartupProgress` receives the launcher's stages: `checking`, `starting`, `upgrading`, `waiting`
(with a `reason`: `connected_clients`, `host_starting` or `host_stopping`), `initializing` (with a
`phase`: `modules`, `extensions`, `runtime`, `recovery`, `mcp`, `sessions`, `a2a` or `listener`),
`connecting` and `ready`. `ready` means the client can be used, not that anything is drawn. The
callback is not awaited and its errors are ignored. It runs again when the client restarts the Host.

### A Host on the network

```ts
import { connectKodaXHost } from '@kodax-ai/kodax/client'; // '@kodax-ai/kodax/browser' in a page

const host = await connectKodaXHost({
  url: 'https://alice.workspaces.example.com',
  client: { name: 'my-app', version: '1.0.0', instanceId: savedId },
  credential: async () => (await fetch('https://app.example.com/api/kodax-token')).text(),
});
```

- `url` is `http`, `https`, `ws` or `wss`. An address without a path gets `/v2`.
- `credential` returns a JWT, for each connection and again at 80% of its life to renew it. A throw
  fails the first connect, is retried on a reconnect, and on renewal goes to `onError`.
- A browser paired with the Host leaves `credential` out; its cookie proves who it is. A page the
  Host serves passes `location.origin` as `url`.
- `instanceId` is required here: 4 to 128 letters, digits, `_` or `-`. `instanceSecret` (32 to 256
  characters) is optional; without it, leases end with each connection.
- Two connections with the same `instanceId` and `instanceSecret` are one client, and the Host
  closes the older one for good. Give each browser tab its own identity.
- Node needs version 22.4 or later, for the global `WebSocket`.

Tokens, roles, origins and pairing are set up on the Host side: see
[Run a KodaX Host](../deployment/host.md) and [Remote access](../deployment/remote-access.md).

## What the handshake tells you

`host.handshake` is what the Host granted the current connection:

| Field | Meaning |
|---|---|
| `role` | `owner`, `user` or `service`. For display and diagnosis only. |
| `subject` | Who the credential names. |
| `host` | The Host's `id` and `version`. |
| `methods` | Every method this connection may call. |
| `features` | Optional features. This Host sends none. |
| `locks` | Settings the Host operator fixed for this connection, such as `fullAccess`. |
| `limits` | `maxFrameBytes`, and when present `idleTimeoutMs`, `blobChunkBytes`, `maxBlobBytes`, `blobQuotaBytes`. |
| `expiresAt` | When the credential ends, in UTC milliseconds. Absent when it does not expire. |

Decide what to offer from `methods` and `locks`, not from `role`: what a role may do can change
between Host versions. Read the handshake again after each reconnect.

```ts
const can = (method: string) => host.handshake.methods.includes(method);
const showSettings = can('session.settings.update');
const showFullAccess = !host.handshake.locks.includes('fullAccess');
```

## The core loop

Every call goes through `host.call(method, params)`. A command, a call that changes something,
carries a `requestId` you make with `createRequestId()`. Times are UTC milliseconds. Cursors and
revisions are opaque: pass them back, do not parse them. The Host refuses params it does not know.
Ignore result fields you do not know.

### Sessions

```ts
import { createRequestId } from '@kodax-ai/kodax/client';

const { session } = await host.call('session.create', {
  requestId: createRequestId(), project: 'app', title: 'Fix the build',
});
```

- `project` is a path inside the Host's workspace. The local owner uses `projectRoot` instead.
- `session.list` pages with `limit` and `cursor`, and filters by `project`, `tag`, `surface` and
  `includeArchived`. `session.get` reads one Session.
- `session.archive`, `session.unarchive` and `session.delete` each name a state, so sending one
  again changes nothing.

### Follow the Session view

```ts
const observation = await host.observeSession(session.id, {
  onView: view => render(view),
  onClosed: reason => showClosed(reason),
});
```

- `onView` gets the whole view after every change; the client applies the Host's patches for you.
  The promise resolves once the first view arrived. After a reconnect, the client subscribes again
  and sends a fresh view.
- `onClosed` means the Host ended the view for good, for example because the Session was deleted.
- `observation.close()` stops following. It does not stop any Run.

The view (`HostSessionView`) holds `items` (the conversation), `session`, `runs`, `queue` (inputs
waiting), `interactions`, `settings` (what is in effect), the `workflows` the Session started, and
when present `activity`, `contextBudget` and `sandbox`. An item with `textTotal` carries only the
end of its text; `item.read` pages through all of it. A tool item's `tool.change` says what a file
tool changed. Values you only show, such as an item's `type`, are open strings: show the text of an
item type you do not know.

A command's answer and the view change it causes can arrive in either order. Match them by id, for
example by a user item's `inputIds`.

`host.observeHost({ onView })` follows the Host document the same way: the newest Sessions, the
Runs at work, what waits on a person in any Session, and how many learned capabilities wait on a
person. It never continues a Run it lists; only a Session view does.

### Submit input

```ts
const { input } = await host.call('input.submit', {
  requestId: createRequestId(), sessionId: session.id, text: 'Run the tests and fix what fails.',
});
```

- The `requestId` is the input's id. Keep it until you know what became of it.
- The answer is the input's state, not its result: `queued`, `submitted` (with `runId`), `withdrawn`
  or `dropped`.
- `delivery` is `immediate`, `after_turn`, `steer` or `redirect`. `steer` and `redirect` name a Run
  in `targetRunId`.
- `input.get` reads an input again. `input.withdraw` takes back a queued one and returns its text.

### Answer interactions

A Run can stop to ask the person something. It shows in the view's `interactions`, for every client
attached to the Session. The first valid answer settles it.

| `kind` | Asks for | Answer with `response` |
|---|---|---|
| `question` | One choice from `options`, or typed text | `{ kind: 'question', answer }` |
| `question_multi` | Several questions at once | `{ kind: 'question_multi', answers }`, keyed by each question's text |
| `question_input` | Typed text | `{ kind: 'question_input', text }` |
| `permission` | Approval of a tool call | `{ kind: 'permission', decision }` |

```ts
await host.call('interaction.respond', {
  requestId: createRequestId(), interactionId: interaction.id,
  response: { kind: 'permission', decision: { type: 'allow_once' } },
});
```

- A permission's `request` gives `toolName`, `reason`, `risk` and `inputPreview`. When the tool
  would change a file, `diff` has the `path`, `added` and `removed` line counts, and `unified`
  hunks. Show them.
- `decision.type` is `allow_once`, `reject` (with an optional `reason` for the model), or
  `allow_session` / `allow_always` with `suggestionId` set to the `id` of one of its `grantSuggestions`.
- `{ kind: 'skip' }` leaves a question unanswered. `{ kind: 'dismiss' }` closes it: a question goes
  unanswered, a permission is refused. Leave a `kind` you do not know unanswered.
- The answer's `status` is `answered`, `unanswered`, `dismissed`, or `already_resolved` when another
  answer came first.

### Read a Run's outcome

A Run is in progress until it has an `outcome`. Branch on that, not on `phase`.

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

- `run.wait` answers once the Run has an outcome, or fails with `timeout` after `timeoutMs` (60 s at
  most). The Run goes on; ask again.
- `outcome.status` is `completed`, `failed`, `cancelled`, `interrupted` or `unknown`. `unknown` is
  not success: the Host cannot tell yet.
- `outcome.effects` says whether what the Run changed outside the conversation is known. `code` is
  stable for programs.
- `finalText` is the model's last text, cut at 64,000 characters (`finalTextTruncated`). `run.list`
  leaves it out.

### Stop a Run

`run.stop` with a `requestId` and the `runId` asks a Run to stop. The answer only says the request
was recorded; the `outcome` says how the Run ended.
`session.cancel` with `ifRunId` stops everything a Session is doing, but only while that Run is
still its current one, so a late Stop does not end work that started after it.

### Read history

- `history.read` without a cursor returns the newest page, oldest item first. `nextCursor` reads the
  page before it, `newerCursor` the page after. Its items have the same shape as view items.
- `history.search` finds text anywhere in the Session. `history.read` with
  `around: { itemId: hit.itemId }` opens the page around a hit.
- A cursor or id that fails with `resync_required` belongs to a conversation the Host no longer
  keeps. Start again from the newest page.

### Change settings

```ts
const { revision } = await host.call('session.settings.get', { sessionId });
await host.call('session.settings.update', {
  requestId: createRequestId(), sessionId, ifRevision: revision,
  patch: { permissionMode: 'accept-edits', effort: null },
});
```

- `session.settings.get` returns the Session's own choices. The view's `settings` shows what is in
  effect, Host defaults included.
- `null` clears a setting, so it follows the Host's default again.
- With `ifRevision`, the update fails with `conflict` when the settings changed since you read them.
  Read them again, then decide.
- A locked setting is refused with `forbidden` (reason `locked`).
- `provider.list` and `provider.reasoning.efforts` fill model and effort pickers.

## Reliability

### Connection states

```ts
const stopListening = host.onConnectionChange((state) => {
  if (state.state === 'reconnecting') showOffline(state.attempt);
  else if (state.state === 'connected') offer(host);
  else showClosed(state.error?.kodaxCode ?? 'closed');
});
```

The listener is called at once with the current state. `connected` carries the `handshake`, and
`draining: true` once the Host says it is stopping: start nothing new until the next connection.

- `reconnecting`: the link was lost. The client opens a new one by itself, waiting from half a
  second up to 30 seconds between attempts. Calls made meanwhile wait for the next connection.
- `closed` is for good: you called `close()`, the client exited, or the Host refused in a way trying
  again would not change, such as a revoked device. `host.closed` settles then.

The client already acts on the Host's close codes; see the table in
[Run a KodaX Host](../deployment/host.md#who-can-connect). When it reconnects to a different Host,
one that replaced the old one, it continues once each Run of a followed Session that was left
part-way (phase `recovering`). It never continues a Run this client asked to stop.

### Resending and `requestId`

A call that loses its link is sent again on the next connection, unchanged. A query is safe to
repeat. A command whose `resend` is `auto` (almost all of them) repeats nothing under the same
`requestId`: sent again, it answers with the state as it now is. It fails with `conflict` only when
that state is not what the command asked for. So use one `requestId` per intent, and never make a
new id to retry the same intent.

### `unknown_outcome`

A few commands have `resend: 'never'`: `host.stop`, `client.exit.request`, `mcp.server.reload`,
`extension.reload` and `provider.reasoning.probe`. Sending one again could stop a replacement Host
or repeat paid work. When such a command loses its link, the call rejects with `unknown_outcome`:
the Host may or may not have done it. Read what happened, for example with `mcp.server.list`, before
you send it again.

A call in flight when you close the client also rejects with `unknown_outcome`. Keep the `requestId`
and look the result up later. For an input, `input.get` with the `requestId` as `inputId` tells you
its state.

### Errors

Every call rejects with `HostProtocolError`. Branch on `kodaxCode`, never on the message. `reason`
is open-ended detail for display and logs. `retryable` says whether trying again can help.

| `kodaxCode` | What to do |
|---|---|
| `invalid_params`, `method_not_found` | Fix the call. |
| `unauthorized`, `forbidden` | The credential or role does not allow it. `reason` says more, such as `locked`. |
| `not_found` | The thing is gone. |
| `conflict` | The state is not what the command needs: a stale `ifRevision`, a busy Session, a different answer under the same `requestId`. Read again. |
| `invalid_state` | The Host cannot do this now, or does not speak this protocol. |
| `resync_required` | A cursor, turn or view position is stale. Read again from the start. |
| `limit_exceeded` | Too large, such as a frame over `maxFrameBytes`. |
| `overloaded`, `unavailable`, `timeout` | Retryable. Wait `retryAfterMs` when present. |
| `cancelled` | You cancelled the call. |
| `unknown_outcome` | See above. |
| `internal` | A Host failure. Show `incidentId`; it names the entry in the Host log. |

To give up on a call, pass `{ signal }` as the third argument. Aborting asks the Host to cancel and
still waits for its answer, because only the Host knows what happened. A call still waiting for a
reconnect rejects with `cancelled` at once.

## Files

### Images and attachments

Images go up in chunks of at most `limits.blobChunkBytes`, so other messages keep flowing. A blob
belongs to one Session.

```ts
import { createHash } from 'node:crypto'; // Node, with the image in a Buffer `bytes`

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

- `received` is where to write next. For bytes the Host already has, `blob.begin` answers with all
  of them received, so you only commit.
- `blob.commit` checks the bytes against `sha256`. Bytes that do not match end the upload.
- The local owner can attach files on its machine with `localAttachments`.
- A view item's `attachments` give a `blobId`; only the local owner also gets the `path`. `blob.read`
  returns the bytes in base64 chunks; follow `nextCursor` until it is absent. A cursor that fails
  with `resync_required` means the blob changed.

### Read the workspace

A network connection to a Host with a workspace can read it, but not change it. Paths are inside the
workspace, with `/` between names and `.` for the workspace itself.

- `workspace.list` lists a directory, a page at a time.
- `workspace.read` returns a file in base64 chunks with `nextCursor`. A cursor whose file changed
  fails with `resync_required` (`file_changed`).
- `workspace.gitDiff` returns what git sees changed under a directory, as a unified diff;
  `staged: true` compares the index with `HEAD`. A diff over 256 KiB is cut and says `truncated`.

Secrets such as `.env` and `.ssh` are refused with `forbidden` and left out of listings and diffs. A
Host without a workspace, and the local connection, refuse these methods with `forbidden`
(`workspace_not_configured`).

## When WebSockets are blocked

`connectKodaXHost` tries a WebSocket first. If that does not open, it falls back to plain HTTP on
the same port: one server-sent event stream down, POSTs up. Your code does not change. Once HTTP
worked, the same client object tries it first on the next connection, and goes back to WebSocket if
HTTP stops working. Your ingress must not buffer `/v2/events` ([Run a KodaX Host](../deployment/host.md)).

## Leave the Host

`host.close()` closes the client for good; Runs go on. The local owner can call
`client.exit.request` to stop this client's own work on the Host, and with `shutdownHost: true` also
the Host when no other client is connected. The client then closes. `host.stop` fails with
`conflict` while stopping would cut work short; `host.preflight` says what is in the way.

## Moving from the v1 client

The older product client, `ensureKodaXClient` / `connectKodaXClient` returning `KodaXProductClient`,
works until v0.7.100, when it is removed.
[协议 v2：v1 方法对照](../../docs/SDK_MIGRATION.md#协议-v2v1-方法对照未发布) maps each v1 call to its v2 method.
