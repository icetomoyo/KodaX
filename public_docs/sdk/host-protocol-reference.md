# KodaX Host protocol v2: method reference

<!-- Generated from src/host-protocol/. Do not edit by hand: run
     node node_modules/vitest/vitest.mjs run src/host-protocol/reference-doc.test.ts -u -->

Every method a v2 client may send to a Host, generated from the method table
the Host checks requests against. How to connect and call them is in
[Build a client of a Host](host-client.md); a platform backend is in
[Run a platform on a Host](host-platform.md).

- **Kind**: a *query* reads and is safe to repeat. A *command* changes state
  once per `requestId`. A *subscription* starts or ends a stream of patches.
  A *notification* gets no answer. The *handshake* opens the connection.
- **Resend**: what the SDK does with a command the link lost on the way.
  *auto*: sent again under the same `requestId`. *never*: the call fails with
  `unknown_outcome`, and the caller reads what happened.
- **Who**: the roles that may call the method. `initialize` returns the exact
  list for a connection in `methods`; a Host operator can lock settings
  further (`locks`).
- Params are strict: a field not listed is an error. Every params and result
  object may also carry `_meta`. Fields deeper than two levels show as
  `object`; the TypeScript types exported from `@kodax-ai/kodax/client` have them.

## Contents

- **connection**: [`initialize`](#initialize), [`ping`](#ping)
- **auth**: [`auth.renew`](#authrenew)
- **request**: [`request.cancel`](#requestcancel)
- **provider**: [`provider.list`](#providerlist), [`provider.reasoning.efforts`](#providerreasoningefforts), [`provider.custom.list`](#providercustomlist), [`provider.custom.upsert`](#providercustomupsert), [`provider.custom.remove`](#providercustomremove), [`provider.reasoning.probe`](#providerreasoningprobe), [`provider.reasoning.forget`](#providerreasoningforget)
- **command**: [`command.list`](#commandlist), [`command.readPrompt`](#commandreadprompt), [`command.execute`](#commandexecute)
- **skill**: [`skill.list`](#skilllist), [`skill.get`](#skillget)
- **tool**: [`tool.list`](#toollist)
- **agent**: [`agent.list`](#agentlist), [`agent.reviewLean`](#agentreviewlean), [`agent.registration.list`](#agentregistrationlist), [`agent.registration.upsert`](#agentregistrationupsert), [`agent.registration.setEnabled`](#agentregistrationsetenabled), [`agent.registration.remove`](#agentregistrationremove)
- **session**: [`session.list`](#sessionlist), [`session.get`](#sessionget), [`session.create`](#sessioncreate), [`session.policy.get`](#sessionpolicyget), [`session.policy.update`](#sessionpolicyupdate), [`session.archive`](#sessionarchive), [`session.unarchive`](#sessionunarchive), [`session.delete`](#sessiondelete), [`session.promote`](#sessionpromote), [`session.promotion.get`](#sessionpromotionget), [`session.compact`](#sessioncompact), [`session.lineage.get`](#sessionlineageget), [`session.lineage.label`](#sessionlineagelabel), [`session.branch.select`](#sessionbranchselect), [`session.notice.append`](#sessionnoticeappend), [`session.goal.get`](#sessiongoalget), [`session.goal.create`](#sessiongoalcreate), [`session.goal.pause`](#sessiongoalpause), [`session.goal.resume`](#sessiongoalresume), [`session.goal.clear`](#sessiongoalclear), [`session.fork`](#sessionfork), [`session.recover`](#sessionrecover), [`session.rewind`](#sessionrewind), [`session.side.open`](#sessionsideopen), [`session.settings.get`](#sessionsettingsget), [`session.settings.update`](#sessionsettingsupdate), [`session.cancel`](#sessioncancel), [`session.diagnostics`](#sessiondiagnostics)
- **view**: [`view.subscribe`](#viewsubscribe), [`view.unsubscribe`](#viewunsubscribe)
- **item**: [`item.read`](#itemread)
- **history**: [`history.read`](#historyread), [`history.search`](#historysearch), [`history.resolveTurn`](#historyresolveturn)
- **input**: [`input.submit`](#inputsubmit), [`input.get`](#inputget), [`input.withdraw`](#inputwithdraw)
- **run**: [`run.get`](#runget), [`run.list`](#runlist), [`run.wait`](#runwait), [`run.stop`](#runstop), [`run.startTool`](#runstarttool), [`run.recover`](#runrecover)
- **review**: [`review.start`](#reviewstart)
- **blob**: [`blob.begin`](#blobbegin), [`blob.write`](#blobwrite), [`blob.commit`](#blobcommit), [`blob.read`](#blobread)
- **interaction**: [`interaction.list`](#interactionlist), [`interaction.respond`](#interactionrespond)
- **permission**: [`permission.grant.list`](#permissiongrantlist), [`permission.grant.revoke`](#permissiongrantrevoke)
- **stats**: [`stats.get`](#statsget), [`stats.requests`](#statsrequests), [`stats.tools`](#statstools)
- **actor**: [`actor.tree`](#actortree), [`actor.get`](#actorget), [`actor.output`](#actoroutput), [`actor.wait`](#actorwait), [`actor.spawn`](#actorspawn), [`actor.followup`](#actorfollowup), [`actor.send`](#actorsend), [`actor.interrupt`](#actorinterrupt)
- **workflow**: [`workflow.list`](#workflowlist), [`workflow.get`](#workflowget), [`workflow.start`](#workflowstart), [`workflow.pause`](#workflowpause), [`workflow.resume`](#workflowresume), [`workflow.stop`](#workflowstop)
- **workspace**: [`workspace.list`](#workspacelist), [`workspace.read`](#workspaceread), [`workspace.gitDiff`](#workspacegitdiff)
- **host**: [`host.get`](#hostget), [`host.preflight`](#hostpreflight), [`host.stop`](#hoststop), [`host.logs`](#hostlogs)
- **client**: [`client.exit.request`](#clientexitrequest), [`client.exit.get`](#clientexitget), [`client.exit.list`](#clientexitlist)
- **repo**: [`repo.intelligence.inspect`](#repointelligenceinspect), [`repo.intelligence.prewarm`](#repointelligenceprewarm)
- **device**: [`device.pair`](#devicepair), [`device.list`](#devicelist), [`device.revoke`](#devicerevoke)
- **config**: [`config.get`](#configget), [`config.update`](#configupdate), [`config.reload`](#configreload)
- **mcp**: [`mcp.server.list`](#mcpserverlist), [`mcp.server.get`](#mcpserverget), [`mcp.server.validate`](#mcpservervalidate), [`mcp.server.upsert`](#mcpserverupsert), [`mcp.server.remove`](#mcpserverremove), [`mcp.server.reload`](#mcpserverreload), [`mcp.tool.list`](#mcptoollist), [`mcp.tool.refresh`](#mcptoolrefresh)
- **extension**: [`extension.list`](#extensionlist), [`extension.reload`](#extensionreload)
- **learning**: [`learning.list`](#learninglist), [`learning.get`](#learningget), [`learning.snapshot`](#learningsnapshot), [`learning.events`](#learningevents), [`learning.acknowledge`](#learningacknowledge), [`learning.snooze`](#learningsnooze), [`learning.reject`](#learningreject), [`learning.disable`](#learningdisable), [`learning.rollback`](#learningrollback), [`learning.review`](#learningreview), [`learning.trust`](#learningtrust), [`learning.promote`](#learningpromote)
- **memory**: [`memory.list`](#memorylist), [`memory.get`](#memoryget), [`memory.create`](#memorycreate), [`memory.update`](#memoryupdate), [`memory.approve`](#memoryapprove), [`memory.forget`](#memoryforget)
- **lease**: [`lease.register`](#leaseregister), [`lease.resume`](#leaseresume), [`lease.revoke`](#leaserevoke), [`lease.complete`](#leasecomplete), [`lease.call.get`](#leasecallget)

## connection

### `initialize`

Opens the connection: the protocol revision, who the client is and how it proves it. The answer lists what this connection may call.

Kind: handshake · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `protocol` | "kodax/2" | yes |  |
| `revision` | integer | yes | The newest revision the client speaks. The connection uses the lower of the two sides'. |
| `client` | object | yes |  |
| `client.name` | string | yes |  |
| `client.version` | string | yes |  |
| `client.instanceId` | string | yes | Stable for one installed client, so its requests and leases survive a reconnect. |
| `client.instanceSecret` | string | no | Proves a reconnecting client is the same instance. Without it the id alone identifies the client, and its leases end with each connection. |
| `auth` | object | no | Absent when the transport already proved who the client is, as a paired browser's cookie does. |
| `auth.scheme` | "ipc" or "jwt" | yes |  |
| `auth.token` | string | yes |  |
| `purpose` | "probe" | no | `probe`: the connection only checks whether the Host is up (`ping`, `host.get`, `host.preflight`). It does not count as a connected client, so polling it never keeps an idle Host running. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `protocol` | "kodax/2" | yes |  |
| `revision` | integer | yes |  |
| `role` | "owner" or "user" or "service" | yes | For display and diagnosis. Clients decide what to offer from `methods` and `locks`. |
| `subject` | string | yes |  |
| `host` | object | yes |  |
| `host.id` | string | yes |  |
| `host.version` | string | yes |  |
| `methods` | string[] | yes | Every method this connection may call. |
| `features` | string[] | yes |  |
| `locks` | string[] | yes | Settings the Host operator fixed for this connection. |
| `expiresAt` | integer | no | When the credential ends, in UTC milliseconds. Absent when it does not expire. |
| `limits` | object | yes |  |
| `limits.maxFrameBytes` | integer | yes |  |
| `limits.idleTimeoutMs` | integer | no | The Host hangs up when it hears nothing from the client for this long, so the client pings more often. The client may treat the same silence from the Host as a lost connection. Absent on a local connection. |
| `limits.blobChunkBytes` | integer | no | The most bytes one `blob.write` carries and one `blob.read` returns. |
| `limits.maxBlobBytes` | integer | no | The most bytes one blob may hold. |
| `limits.blobQuotaBytes` | integer | no | The most bytes all the blobs on the Host may hold together. An upload that would pass it is refused. |

### `ping`

Answers at once, so a client can tell the link is alive.

Kind: query · Who: owner, user, service

No params.

Empty result.

## auth

### `auth.renew`

A new token for the same subject and role, sent before `expiresAt`. Any other subject or role ends the connection.

Kind: handshake · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `token` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `expiresAt` | integer | no |  |

## request

### `request.cancel`

Gives up a request this client sent that is still running, by its `id`. The request fails with `cancelled`.

Kind: notification · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string or integer | yes |  |

## provider

### `provider.list`

The providers the Host knows, with their models and whether the Host can call them.

Kind: query · Who: owner, user, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].model` | string | yes |  |
| `items[].models` | string[] | yes |  |
| `items[].configured` | boolean | yes |  |
| `items[].source` | string | yes |  |
| `items[].reasoningCapability` | string | yes |  |
| `items[].capabilityProfile` | object | yes |  |
| `nextCursor` | string | no |  |

### `provider.reasoning.efforts`

The efforts a Session on this model can be set to. A provider the Host does not know gets the efforts every model takes.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | string | yes |  |
| `model` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | string[] | yes |  |
| `nextCursor` | string | no |  |

### `provider.custom.list`

The custom providers saved in the Host's configuration.

Kind: query · Who: owner, user

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `nextCursor` | string | no |  |

### `provider.custom.upsert`

Adds a provider, or replaces the one of the same `name`. Fails with `invalid_params` when the Host cannot use it.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `provider` | object | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `provider` | object | yes |  |

### `provider.custom.remove`

Answers the same whether or not the provider was there, so it is safe to send again.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `name` | string | yes |  |

Empty result.

### `provider.reasoning.probe`

Asks the provider which of `efforts` a model accepts, by sending one small request for each, and remembers the answers for the model picker. Costs a request per effort.

Kind: command · Resend: never · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `provider` | string | yes |  |
| `model` | string | no |  |
| `efforts` | string[] | yes |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls get their provider keys from this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].effort` | string | yes |  |
| `items[].status` | string | yes |  |
| `items[].error` | string | no |  |
| `nextCursor` | string | no |  |

### `provider.reasoning.forget`

Forgets what probing learned, for one model, one provider, or all of them.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `provider` | string | no |  |
| `model` | string | no |  |

Empty result.

## command

### `command.list`

The commands `command.execute` runs: prompt commands and extension commands a person may start. The REPL's own commands, such as `/model`, are not among them; the REPL runs them itself.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].aliases` | string[] | no |  |
| `items[].description` | string | yes |  |
| `items[].source` | string | yes |  |
| `items[].location` | string | no |  |
| `items[].usage` | string | no |  |
| `items[].argumentHint` | string | no |  |
| `items[].userInvocable` | boolean | no |  |
| `items[].disableModelInvocation` | boolean | no |  |
| `items[].allowedTools` | string | no |  |
| `items[].context` | string | no |  |
| `items[].agent` | string | no |  |
| `items[].model` | string | no |  |
| `nextCursor` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `command.readPrompt`

The text a prompt command sends to the model, with `args` added the way running the command adds them. No `prompt` when the Session has no such command, or the Host carries the command out itself.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `name` | string | yes |  |
| `args` | string[] | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `prompt` | object | no |  |
| `prompt.title` | string | yes |  |
| `prompt.text` | string | yes |  |

### `command.execute`

Runs a command under the name `command.list` gives it, as a person does who types `/name args`. A command that works through the model or a tool starts a Run and is answered with it. A command the Host finishes itself is answered with `success`. The Session must not be at work, because the command acts on it; `help` as the first of `args` only asks what the command is for and is answered at any time. Fails with `not_found` when no command a person may run has the name.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `name` | string | yes |  |
| `args` | string[] | no | What the person typed after the name, word by word. |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | no | The Run the command started. Absent when the Host finished the command itself. |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |
| `success` | boolean | no | Whether a command the Host finished itself did what was asked. Absent with `run`: the outcome of the Run tells. |
| `message` | string | no | What the command says to the person. |

## skill

### `skill.list`

The Skills a Run in the project can use.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].description` | string | yes |  |
| `items[].source` | string | yes |  |
| `items[].argumentHint` | string | no |  |
| `items[].disableModelInvocation` | boolean | yes |  |
| `nextCursor` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `skill.get`

One Skill by its exact name. No `skill` when the project and the Host have none by that name.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `skill` | object | no |  |
| `skill.name` | string | yes |  |
| `skill.description` | string | yes |  |
| `skill.source` | string | yes |  |
| `skill.argumentHint` | string | no |  |
| `skill.disableModelInvocation` | boolean | yes |  |
| `skill.content` | string | yes |  |
| `skill.scripts` | object[] | no |  |
| `skill.references` | object[] | no |  |
| `skill.assets` | object[] | no |  |
| `skill.templates` | object[] | no |  |
| `skill.resources` | object[] | no |  |

The owner on the Host's own machine also receives paths on that machine.

## tool

### `tool.list`

The tools a Run of the Session can use.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].sideEffect` | string | yes |  |
| `items[].planModeAllowed` | boolean | yes |  |
| `nextCursor` | string | no |  |

## agent

### `agent.list`

The Agents a Session can be created as (`session.create` with `agent`).

Kind: query · Who: owner, user, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].description` | string | yes |  |
| `items[].tools` | string[] | no |  |
| `items[].provider` | string | no |  |
| `items[].model` | string | no |  |
| `items[].effort` | string | no |  |
| `nextCursor` | string | no |  |

### `agent.reviewLean`

Has the model add KodaX's guidance for small, focused changes to the project's AGENTS.md where it is missing, as a person does who types `/agents lean`. The model may edit AGENTS.md. Starts a Run. Without an AGENTS.md the Host answers with `success` false and a `message`. The Session must not be at work.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | no | The Run the command started. Absent when the Host finished the command itself. |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |
| `success` | boolean | no | Whether a command the Host finished itself did what was asked. Absent with `run`: the outcome of the Run tells. |
| `message` | string | no | What the command says to the person. |

### `agent.registration.list`

Fails with `method_not_found` when the Host was started without external Agents.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].agentId` | string | yes |  |
| `items[].displayName` | string | yes |  |
| `items[].description` | string | no |  |
| `items[].managementOwner` | string | no |  |
| `items[].enabled` | boolean | yes |  |
| `items[].executorId` | string | yes |  |
| `items[].protocol` | string | yes |  |
| `items[].configurationRevision` | string | yes |  |
| `items[].endpointIdentityHash` | string | yes |  |
| `items[].credentialConfigured` | boolean | yes |  |
| `items[].capabilities` | object | yes |  |
| `items[].effects` | object | yes |  |
| `items[].health` | object | no |  |
| `items[].diagnostics` | string[] | yes |  |
| `nextCursor` | string | no |  |

### `agent.registration.upsert`

Registers an external Agent, or replaces the one of the same `agentId`. The same content under the same `configurationRevision` is safe to send again; different content must come with a new revision.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `registration` | object | yes |  |
| `ifRevision` | string or null | no |  |
| `ifOwner` | string or null | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `registration` | object | yes |  |
| `registration.agentId` | string | yes |  |
| `registration.displayName` | string | yes |  |
| `registration.description` | string | no |  |
| `registration.managementOwner` | string | no |  |
| `registration.enabled` | boolean | yes |  |
| `registration.executorId` | string | yes |  |
| `registration.protocol` | string | yes |  |
| `registration.configurationRevision` | string | yes |  |
| `registration.endpointIdentityHash` | string | yes |  |
| `registration.credentialConfigured` | boolean | yes | Whether a credential is bound to it. The credential itself never comes back. |
| `registration.capabilities` | object | yes |  |
| `registration.effects` | object | yes |  |
| `registration.health` | object | no |  |
| `registration.diagnostics` | string[] | yes |  |

### `agent.registration.setEnabled`

Turns an Agent on or off. `claimOwner` also claims an Agent no manager owns yet. Fails with `not_found` when no Agent has the id.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `agentId` | string | yes |  |
| `enabled` | boolean | yes |  |
| `claimOwner` | string | no |  |
| `ifRevision` | string or null | no |  |
| `ifOwner` | string or null | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `registration` | object | yes |  |
| `registration.agentId` | string | yes |  |
| `registration.displayName` | string | yes |  |
| `registration.description` | string | no |  |
| `registration.managementOwner` | string | no |  |
| `registration.enabled` | boolean | yes |  |
| `registration.executorId` | string | yes |  |
| `registration.protocol` | string | yes |  |
| `registration.configurationRevision` | string | yes |  |
| `registration.endpointIdentityHash` | string | yes |  |
| `registration.credentialConfigured` | boolean | yes | Whether a credential is bound to it. The credential itself never comes back. |
| `registration.capabilities` | object | yes |  |
| `registration.effects` | object | yes |  |
| `registration.health` | object | no |  |
| `registration.diagnostics` | string[] | yes |  |

### `agent.registration.remove`

Answers the same whether or not the Agent was there, so it is safe to send again. Fails with `conflict` when the Agent is there but no longer meets `ifRevision` or `ifOwner`.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `agentId` | string | yes |  |
| `ifRevision` | string or null | no |  |
| `ifOwner` | string or null | no |  |

Empty result.

## session

### `session.list`

The Sessions, a page at a time.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `includeArchived` | boolean | no |  |
| `tag` | string | no |  |
| `surface` | string | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].title` | string | yes |  |
| `items[].tag` | string | no |  |
| `items[].archived` | boolean | yes |  |
| `items[].project` | string | no |  |
| `items[].branch` | string | no |  |
| `items[].surface` | string | no |  |
| `items[].profileId` | string | no |  |
| `items[].messageCount` | integer | no |  |
| `items[].createdAt` | integer | no |  |
| `items[].lastMessageAt` | integer | no |  |
| `items[].sideChat` | object | no |  |
| `items[].revision` | string | no |  |
| `items[].recovery` | object | no |  |
| `nextCursor` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.get`

One Session. `phase` is `idle` or the phase of the Run that decides what the Session is doing; `runId` names that Run.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no | Where the Session works, as a path inside the Host's workspace. Absent when it works outside it. |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no | Messages in the conversation as the model sees it now. |
| `session.createdAt` | integer | no | UTC milliseconds. |
| `session.lastMessageAt` | integer | no | When a person or the model last added to the conversation. UTC milliseconds. |
| `session.sideChat` | object | no | Present on a side conversation: the Session it was opened from. |
| `session.revision` | string | no | Changes when the Session's title, tag or place does. Compare, do not parse. |
| `session.recovery` | object | no |  |
| `phase` | string | yes |  |
| `runId` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.create`

Creates a Session. Its `policy` is fixed for the Session's life.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `title` | string | no |  |
| `tag` | string | no |  |
| `surface` | string | no |  |
| `profileId` | string | no |  |
| `policy` | object | no | Fixed for the life of the Session and kept by a fork of it. Only owner and service may send it. |
| `policy.tools` | string[] | no | The only tools a Run may use, by name. Absent leaves the Host's own limit. |
| `policy.budget` | object | no |  |
| `policy.agentProfile` | object | no | Who the model is in this Session. |
| `policy.prompt` | object | no | What every Run starts with. A Run adds its own entries after these. |
| `policy.interactions` | "wait" or "reject" | no | Whether a Run puts its questions and approval requests to a person. `wait` shows them to the clients attached and waits as long as the Host allows. `reject` answers them at once: the model is told that nobody is there to ask, and a tool call that needs approval is not run. A Session a service creates without saying is `reject`; one a person creates is `wait`. |
| `policy.leases` | object | no | Leases of the creator that every Run of the Session uses, whoever submits it. Their requests go to the client instance that bound them, which must hold them and connect with an `instanceSecret`. A Run there brings no leases of its own. While that instance is away, a Run that needs the key is refused with `unavailable`, and a tool call waits for it to come back. After a Host restart it registers again under the same `requestId`. |
| `agent` | string | no | The name of an Agent from `agent.list`. The Session is created as that Agent: its instructions and tools are copied into the policy, where they narrow what `policy` fixes, and the Session starts on its model. A later change to the Agent does not reach the Session. Fails with `not_found` when no such Agent is installed, and with `invalid_params` when `policy.agentProfile` is sent as well. |
| `draft` | boolean | no | Held in the Host's memory until its first input is saved, so a conversation a person opens and never uses leaves nothing behind. A Host that restarts first no longer has it. |
| `temporary` | boolean | no | Deleted by the Host when its Run ends, also when no client is attached any more, so a one-off task leaves nothing behind. Queued inputs do not start another Run. |
| `mcpServers` | object | no | MCP servers of this Session alone, by name, configured as for `mcp.server.upsert`. Their tools join the Host's for its Runs, and other Sessions do not see them. Owner only: a stdio server is a command on the Host. Only owner may send it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no | Where the Session works, as a path inside the Host's workspace. Absent when it works outside it. |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no | Messages in the conversation as the model sees it now. |
| `session.createdAt` | integer | no | UTC milliseconds. |
| `session.lastMessageAt` | integer | no | When a person or the model last added to the conversation. UTC milliseconds. |
| `session.sideChat` | object | no | Present on a side conversation: the Session it was opened from. |
| `session.revision` | string | no | Changes when the Session's title, tag or place does. Compare, do not parse. |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.policy.get`

What binds every Run of the Session. Anyone who can reach the Session may read it.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `policy` | object | yes |  |
| `policy.tools` | string[] | no | The only tools a Run may use, by name. Absent leaves the Host's own limit. |
| `policy.budget` | object | no |  |
| `policy.agentProfile` | object | no | Who the model is in this Session. |
| `policy.prompt` | object | no | What every Run starts with. A Run adds its own entries after these. |
| `policy.interactions` | "wait" or "reject" | no | Whether a Run puts its questions and approval requests to a person. `wait` shows them to the clients attached and waits as long as the Host allows. `reject` answers them at once: the model is told that nobody is there to ask, and a tool call that needs approval is not run. A Session a service creates without saying is `reject`; one a person creates is `wait`. |
| `policy.leases` | object | no | Leases of the creator that every Run of the Session uses, whoever submits it. Their requests go to the client instance that bound them, which must hold them and connect with an `instanceSecret`. A Run there brings no leases of its own. While that instance is away, a Run that needs the key is refused with `unavailable`, and a tool call waits for it to come back. After a Host restart it registers again under the same `requestId`. |

### `session.policy.update`

Replaces the whole policy, for the Runs that start from then on. A Run already working keeps the policy it started with. Leases in it are bound as `session.create` binds them, to the client instance that sends this.

Kind: command · Resend: auto · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `policy` | object | yes |  |
| `policy.tools` | string[] | no | The only tools a Run may use, by name. Absent leaves the Host's own limit. |
| `policy.budget` | object | no |  |
| `policy.agentProfile` | object | no | Who the model is in this Session. |
| `policy.prompt` | object | no | What every Run starts with. A Run adds its own entries after these. |
| `policy.interactions` | "wait" or "reject" | no | Whether a Run puts its questions and approval requests to a person. `wait` shows them to the clients attached and waits as long as the Host allows. `reject` answers them at once: the model is told that nobody is there to ask, and a tool call that needs approval is not run. A Session a service creates without saying is `reject`; one a person creates is `wait`. |
| `policy.leases` | object | no | Leases of the creator that every Run of the Session uses, whoever submits it. Their requests go to the client instance that bound them, which must hold them and connect with an `instanceSecret`. A Run there brings no leases of its own. While that instance is away, a Run that needs the key is refused with `unavailable`, and a tool call waits for it to come back. After a Host restart it registers again under the same `requestId`. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `policy` | object | yes |  |
| `policy.tools` | string[] | no | The only tools a Run may use, by name. Absent leaves the Host's own limit. |
| `policy.budget` | object | no |  |
| `policy.agentProfile` | object | no | Who the model is in this Session. |
| `policy.prompt` | object | no | What every Run starts with. A Run adds its own entries after these. |
| `policy.interactions` | "wait" or "reject" | no | Whether a Run puts its questions and approval requests to a person. `wait` shows them to the clients attached and waits as long as the Host allows. `reject` answers them at once: the model is told that nobody is there to ask, and a tool call that needs approval is not run. A Session a service creates without saying is `reject`; one a person creates is `wait`. |
| `policy.leases` | object | no | Leases of the creator that every Run of the Session uses, whoever submits it. Their requests go to the client instance that bound them, which must hold them and connect with an `instanceSecret`. A Run there brings no leases of its own. While that instance is away, a Run that needs the key is refused with `unavailable`, and a tool call waits for it to come back. After a Host restart it registers again under the same `requestId`. |

### `session.archive`

Takes the Session out of the list; `session.list` with `includeArchived` still shows it.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

Empty result.

### `session.unarchive`

Puts an archived Session back in the list.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

Empty result.

### `session.delete`

Succeeds when the Session is already gone: what was asked for holds.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

Empty result.

### `session.promote`

Gives a Session its lasting tag once, as when a quick question becomes a working Session; the id and the conversation stay. `ifRevision` is the Session's `revision` as the caller read it. Fails with `conflict`: `revision_mismatch` when the Session changed since, so read it again; `already_promoted` when another request promoted it, which no retry changes. Sent again with the same `requestId`, `tag` and `ifRevision`, it answers with the Session as promoted.

Kind: command · Resend: auto · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `ifRevision` | string | yes |  |
| `tag` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.promotion.get`

The Session as promoted by the `session.promote` sent under `promotionId` as its `requestId`, for a caller who lost the answer. Fails with `not_found` (`promotion_not_found`) when that request did not promote it.

Kind: query · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `promotionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.compact`

Replaces the older part of the conversation with a summary, so the model has room to go on. Answers once that is done, which takes as long as a model call. Sent again under the same `requestId`, it answers with the compaction the first one made. Fails with `conflict` while the Session is running or another request is compacting it, and with `unavailable` when the summary could not be made; the conversation is unchanged in both cases.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `instructions` | string | no | What the summary should take care to keep. |
| `leases` | object | no | The summary is a model call, which gets its provider key from `leases.credential`. Only owner and service may send it. |
| `leases.credential` | string | no | The model calls get their provider keys from this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `compacted` | boolean | yes | False when the conversation was too short to need it. |
| `tokensBefore` | number | yes | The size of the conversation, in the model's tokens, before and after. |
| `tokensAfter` | number | yes |  |

### `session.lineage.get`

The conversation tree of the Session, the oldest entry first. `activeEntryId` is where the conversation stands: the next Run goes on from it. Fails with `resync_required` when the entry a `cursor` names is gone; read again from the start.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].parentId` | string | no |  |
| `items[].type` | string | yes |  |
| `items[].createdAt` | integer | no |  |
| `items[].role` | string | no |  |
| `items[].preview` | string | no |  |
| `items[].targetId` | string | no |  |
| `items[].label` | string | no |  |
| `items[].truncatedCount` | integer | no |  |
| `nextCursor` | string | no |  |
| `activeEntryId` | string | no | Absent while the Session has no conversation. |

### `session.lineage.label`

Puts a label on an entry, or takes its label off when `label` is absent. Answers with the entry that records it. When the entry already carries what is asked, as when this is sent again, it records nothing and answers with the entry that recorded it. Fails with `conflict` when no entry matches, and while the Session is running.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `entry` | string | yes |  |
| `label` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `entry` | object | yes |  |
| `entry.id` | string | yes |  |
| `entry.parentId` | string | no |  |
| `entry.type` | string | yes |  |
| `entry.createdAt` | integer | no |  |
| `entry.role` | string | no |  |
| `entry.preview` | string | no |  |
| `entry.targetId` | string | no |  |
| `entry.label` | string | no |  |
| `entry.truncatedCount` | integer | no |  |

### `session.branch.select`

Moves the conversation to another entry of its tree. The next Run goes on from there, and what came after stays in the tree as a branch. With `summarize`, a summary of the branch that is left is put after the entry, so the model knows what was tried. A switch already in place changes nothing, so it is safe to send again. Fails with `conflict` when no entry matches, and while the Session is running; with `resync_required` when the conversation no longer stands on `ifActiveEntryId`.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `entry` | string | yes |  |
| `summarize` | boolean | no |  |
| `ifActiveEntryId` | string | yes | The `activeEntryId` of the tree as the client read it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no | Where the Session works, as a path inside the Host's workspace. Absent when it works outside it. |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no | Messages in the conversation as the model sees it now. |
| `session.createdAt` | integer | no | UTC milliseconds. |
| `session.lastMessageAt` | integer | no | When a person or the model last added to the conversation. UTC milliseconds. |
| `session.sideChat` | object | no | Present on a side conversation: the Session it was opened from. |
| `session.revision` | string | no | Changes when the Session's title, tag or place does. Compare, do not parse. |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.notice.append`

Adds a line to the conversation that people read and the model does not, such as what a command of the client's own printed. `itemId` is the id of the item a Session view shows the notice as; `history.read` leaves notices out. Sent again under the same `requestId`, it answers with the notice it added the first time. Fails with `conflict` while the Session is running.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `text` | string | yes |  |
| `source` | string | no | What printed the notice, such as the name of a command. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `itemId` | string | yes |  |

### `session.goal.get`

The goal of the Session. `goal` is absent when it has none.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `goal` | object | no |  |
| `goal.id` | string | yes |  |
| `goal.objective` | string | yes |  |
| `goal.status` | "active" or "paused" or "budget_limited" or "blocked" or "complete" | yes |  |
| `goal.tokenBudget` | number | no | The most tokens the goal may use. Absent when it has no limit. |
| `goal.tokensUsed` | number | yes |  |
| `goal.timeUsedSeconds` | number | yes |  |
| `goal.blocker` | string | no | The kind of obstacle the model last reported. |
| `goal.createdAt` | number | yes | UTC milliseconds. |
| `goal.updatedAt` | number | yes |  |

### `session.goal.create`

Gives the Session a goal. A Session has one goal at a time, so this fails with `conflict` while another goal stands that is not complete; clear that one first. Asking for the goal the Session already has answers with it as it stands. Also fails with `conflict` before the Session has a conversation, and while it is running.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `objective` | string | yes |  |
| `tokenBudget` | integer | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `goal` | object | yes |  |
| `goal.id` | string | yes |  |
| `goal.objective` | string | yes |  |
| `goal.status` | "active" or "paused" or "budget_limited" or "blocked" or "complete" | yes |  |
| `goal.tokenBudget` | number | no | The most tokens the goal may use. Absent when it has no limit. |
| `goal.tokensUsed` | number | yes |  |
| `goal.timeUsedSeconds` | number | yes |  |
| `goal.blocker` | string | no | The kind of obstacle the model last reported. |
| `goal.createdAt` | number | yes | UTC milliseconds. |
| `goal.updatedAt` | number | yes |  |

### `session.goal.pause`

Sets an `active` goal aside. Fails with `conflict` for a goal in any other state but `paused`.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `goal` | object | yes |  |
| `goal.id` | string | yes |  |
| `goal.objective` | string | yes |  |
| `goal.status` | "active" or "paused" or "budget_limited" or "blocked" or "complete" | yes |  |
| `goal.tokenBudget` | number | no | The most tokens the goal may use. Absent when it has no limit. |
| `goal.tokensUsed` | number | yes |  |
| `goal.timeUsedSeconds` | number | yes |  |
| `goal.blocker` | string | no | The kind of obstacle the model last reported. |
| `goal.createdAt` | number | yes | UTC milliseconds. |
| `goal.updatedAt` | number | yes |  |

### `session.goal.resume`

Takes a `paused` goal up again. Fails with `conflict` for a goal in any other state but `active`.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `goal` | object | yes |  |
| `goal.id` | string | yes |  |
| `goal.objective` | string | yes |  |
| `goal.status` | "active" or "paused" or "budget_limited" or "blocked" or "complete" | yes |  |
| `goal.tokenBudget` | number | no | The most tokens the goal may use. Absent when it has no limit. |
| `goal.tokensUsed` | number | yes |  |
| `goal.timeUsedSeconds` | number | yes |  |
| `goal.blocker` | string | no | The kind of obstacle the model last reported. |
| `goal.createdAt` | number | yes | UTC milliseconds. |
| `goal.updatedAt` | number | yes |  |

### `session.goal.clear`

Leaves the Session without a goal. Succeeds when it already has none.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

Empty result.

### `session.fork`

A new Session that starts with the conversation of this one: all of it, or the part `turn` or `entry` keeps. The source is unchanged. The fork runs as its source does and is bound by the same policy. Sent again under the same `requestId`, it answers with the Session the first one made. Fails with `conflict` while the source is running, and with `resync_required` when the conversation changed since `turn` was named.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `turn` | string | no | Keeps the conversation up to the end of this turn. Not to be sent with `entry`. |
| `before` | boolean | no | Sent with `turn`: keeps what came before the turn and leaves the turn out. |
| `entry` | string | no | Keeps the conversation up to this entry of the tree. |
| `title` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.recover`

A new Session that starts from a summary of what this one learned, for a conversation that can no longer go on as it is. The summary is put together without a model call. The source is unchanged, and the new Session is bound by the same policy. Sent again under the same `requestId`, it answers with the Session the first one made. Fails with `conflict` while the source is running or has no conversation.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `title` | string | no |  |
| `reason` | string | no | Why the conversation is being left, kept at the head of the summary. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.rewind`

Takes the conversation back to where `turn` or `entry` ends: what came after leaves the conversation the model reads. One of the two says where to. A rewind that is already in place changes nothing, so it is safe to send again. Fails with `conflict` while the Session is running or `entry` names nothing, and with `resync_required` when the conversation changed since `turn` was named or no longer stands on `ifActiveEntryId`.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `turn` | string | no | Goes back to the end of this turn. Not to be sent with `entry` or `ifActiveEntryId`. |
| `entry` | string | no | Goes back to this entry of the tree. Sent with `ifActiveEntryId`. |
| `ifActiveEntryId` | string | no | The `activeEntryId` of the tree as the client read it. A turn carries this check itself. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.side.open`

The side chat of the Session: a Session of its own that can read the conversation so far and leaves it untouched. One exists for each branch of the conversation and each client identity, so asking again answers with the same one. Fails with `conflict` when `sessionId` is itself a side chat.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `session` | object | yes |  |
| `session.id` | string | yes |  |
| `session.title` | string | yes |  |
| `session.tag` | string | no |  |
| `session.archived` | boolean | yes |  |
| `session.project` | string | no |  |
| `session.branch` | string | no |  |
| `session.surface` | string | no |  |
| `session.profileId` | string | no |  |
| `session.messageCount` | integer | no |  |
| `session.createdAt` | integer | no |  |
| `session.lastMessageAt` | integer | no |  |
| `session.sideChat` | object | no |  |
| `session.revision` | string | no |  |
| `session.recovery` | object | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `session.settings.get`

The Session's settings and their `revision`.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `settings` | object | yes |  |
| `settings.provider` | string | no |  |
| `settings.model` | string | no |  |
| `settings.effort` | string | no |  |
| `settings.planModeEffort` | string | no |  |
| `settings.permissionMode` | "plan" or "accept-edits" or "auto" or "full-access" | no |  |
| `settings.workMode` | "agent" or "coding" or "script" | no |  |
| `settings.autoModeClassifierModel` | string | no |  |
| `settings.compactionTriggerPercent` | number | no |  |
| `settings.compactionTriggerTokens` | number | no |  |
| `settings.maxIter` | number | no |  |
| `settings.repoIntelligenceMode` | "auto" or "off" or "light" or "full" | no |  |
| `settings.repoIntelligenceTrace` | boolean | no |  |
| `settings.compactionReasoning` | boolean or object | no |  |
| `revision` | string | yes |  |
| `workModeLocked` | boolean | yes |  |

### `session.settings.update`

Answers with the settings as they are after the change. With `ifRevision`, fails with `conflict` when the settings changed since that revision was read, unless they already hold what the patch asks, as when it is sent again after it applied.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `patch` | object | yes |  |
| `patch.provider` | string or null | no |  |
| `patch.model` | string or null | no |  |
| `patch.effort` | string or null | no |  |
| `patch.planModeEffort` | string or null | no |  |
| `patch.permissionMode` | "plan" or "accept-edits" or "auto" or "full-access" or null | no |  |
| `patch.workMode` | "agent" or "coding" or "script" or null | no |  |
| `patch.autoModeClassifierModel` | string or null | no |  |
| `patch.compactionTriggerPercent` | number or null | no |  |
| `patch.compactionTriggerTokens` | integer or null | no |  |
| `patch.maxIter` | integer or null | no |  |
| `patch.repoIntelligenceMode` | "auto" or "off" or "light" or "full" or null | no |  |
| `patch.repoIntelligenceTrace` | boolean or null | no |  |
| `patch.compactionReasoning` | boolean or object or null | no |  |
| `ifRevision` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `settings` | object | yes |  |
| `settings.provider` | string | no |  |
| `settings.model` | string | no |  |
| `settings.effort` | string | no |  |
| `settings.planModeEffort` | string | no |  |
| `settings.permissionMode` | "plan" or "accept-edits" or "auto" or "full-access" | no |  |
| `settings.workMode` | "agent" or "coding" or "script" | no |  |
| `settings.autoModeClassifierModel` | string | no |  |
| `settings.compactionTriggerPercent` | number | no |  |
| `settings.compactionTriggerTokens` | number | no |  |
| `settings.maxIter` | number | no |  |
| `settings.repoIntelligenceMode` | "auto" or "off" or "light" or "full" | no |  |
| `settings.repoIntelligenceTrace` | boolean | no |  |
| `settings.compactionReasoning` | boolean or object | no |  |
| `revision` | string | yes |  |
| `workModeLocked` | boolean | yes |  |

### `session.cancel`

Stops everything the Session is doing, provided `ifRunId` is still its current Run: a Stop that arrives late must not end work started after it.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `ifRunId` | string | yes |  |

Empty result.

### `session.diagnostics`

A record of the Session and its Run for a support request. Its shape is versioned by `schemaVersion` and sent as the Host wrote it; read it, do not branch on it.

Kind: query · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `runId` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `diagnostics` | object | yes |  |

## view

### `view.subscribe`

Starts a stream of patches to a view: a Session's, or the Host document with `target.kind: 'host'`. The answer is the view as it is now.

Kind: subscription · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscriptionId` | string | yes | Chosen by the client, so it can end a subscription whose answer it never received. |
| `target` | object | yes |  |

Empty result.

The owner on the Host's own machine also receives paths on that machine.

### `view.unsubscribe`

Succeeds whether or not the subscription still exists.

Kind: subscription · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscriptionId` | string | yes |  |

Empty result.

## item

### `item.read`

The whole of one item of a Session's view, a page at a time.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `itemId` | string | yes |  |
| `part` | "text" or "input" or "output" | no | `text` when absent. `output` is the complete output a tool item's `outputSaved` announces. |
| `cursor` | string | no | From a previous page of the same part. Absent for the first page. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `text` | string | yes |  |
| `total` | integer | yes | UTF-16 units in the whole part. |
| `nextCursor` | string | no |  |

## history

### `history.read`

Without `cursor` and `around`, answers with the newest page.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `limit` | integer | no | Counts entries of the conversation. One entry can show as several items. |
| `cursor` | string | no |  |
| `around` | object | no | Answers with the page around what `history.search` found. Not to be sent with `cursor`. |
| `around.itemId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].type` | string | yes |  |
| `items[].state` | "live" or "settled" | yes |  |
| `items[].text` | string | yes |  |
| `items[].textTotal` | integer | no |  |
| `items[].at` | integer | no |  |
| `items[].runId` | string | no |  |
| `items[].inputIds` | string[] | no |  |
| `items[].attachments` | object[] | no |  |
| `items[].tool` | object | no |  |
| `items[].notice` | object | no |  |
| `status` | string | yes |  |
| `issues` | object[] | yes |  |
| `issues[].code` | string | yes |  |
| `issues[].message` | string | yes |  |
| `issues[].entryCount` | integer | yes |  |
| `nextCursor` | string | no |  |
| `newerCursor` | string | no |  |
| `locatedItemId` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `history.search`

Finds text anywhere in what the Session said, including what was summarised away since.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `query` | string | yes |  |
| `limit` | integer | no |  |
| `role` | "user" or "assistant" | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes | Best match first. |
| `items[].itemId` | string | yes | Reads with `item.read`, and names the place for `history.read`'s `around`. |
| `items[].role` | "user" or "assistant" | yes |  |
| `items[].at` | integer | no |  |
| `items[].snippet` | string | yes | The text around the match. |

### `history.resolveTurn`

Names one turn of the conversation: a message of the user and what the Session answered. The answer's `ref` is what `session.fork` and `session.rewind` take. Without `turn`, names the newest one.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `turn` | object | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `turn` | object | no |  |
| `turn.ref` | string | yes |  |
| `turn.index` | integer | yes | Counts from the oldest turn, which is 0. |
| `turn.excerpt` | string | yes | The start of the user's message, to show which turn this is. |
| `turn.hasLaterTurn` | boolean | yes |  |
| `unavailable` | string | no | Set in place of `turn` when no turn can be named, with the reason, such as `no_turns` or `item_not_found`. |

## input

### `input.submit`

The input's id is the `requestId`, so a client that lost the answer reads `input.get` under the id it sent. Sent again, the same input starts nothing new.

`budget` and `prompt` are for the Run of this input alone. They narrow what the Session allows and cannot widen it. An input that carries either starts a Run of its own: it is not joined with other waiting inputs, and it cannot `steer`, because a steer joins a Run that is already working.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `text` | string | yes |  |
| `delivery` | "immediate" or "after_turn" or "steer" or "redirect" | no |  |
| `targetRunId` | string | no |  |
| `localAttachments` | object[] | no | Only owner may send it. |
| `localAttachments[].kind` | "image" or "file" or "video" | yes |  |
| `localAttachments[].path` | string | yes |  |
| `localAttachments[].mediaType` | string | no |  |
| `localAttachments[].name` | string | no |  |
| `localAttachments[].source` | "user-inline" or "clipboard" or "drag-drop" or "file-picker" | no |  |
| `localAttachments[].description` | string | no |  |
| `attachments` | object[] | no | Images the Session holds, uploaded with `blob.*`. |
| `attachments[].blobId` | string | yes |  |
| `attachments[].name` | string | no |  |
| `budget` | object | no | Only owner and service may send it. |
| `budget.maxIter` | integer | no | The most model turns the Run may take. |
| `budget.maxDurationMs` | integer | no | The longest the Run may work, in milliseconds, counted from when it starts working and including time it waits for a person. The Host stops a Run that reaches it; its outcome then has the code `time_limit`. |
| `prompt` | object | no | Read by the model after the entries of the Session. An entry may not reuse a key of the Session. They hold for this Run: the next Run of the Session tells the model that they are no longer available. Only owner and service may send it. |
| `prompt.kodaxGuidance` | "keep" or "omit" | no | `omit` leaves out the Host's own working guidance. |
| `prompt.context` | object[] | no | Each key names one entry. All the text together stays within 8,000 characters. |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `input` | object | yes |  |
| `input.id` | string | yes |  |
| `input.state` | "queued" or "submitted" or "withdrawn" or "dropped" | yes |  |
| `input.runId` | string | no |  |
| `input.admissionError` | object | no | Present on a queued input that cannot start as things are. `code` says what is missing. |

### `input.get`

One input, by the id its client chose, and what became of it.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `inputId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `input` | object | yes |  |
| `input.id` | string | yes |  |
| `input.state` | "queued" or "submitted" or "withdrawn" or "dropped" | yes |  |
| `input.runId` | string | no |  |
| `input.admissionError` | object | no | Present on a queued input that cannot start as things are. `code` says what is missing. |

### `input.withdraw`

Takes back a queued input. Sent again, it answers the same.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `inputId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `input` | object | yes |  |
| `input.id` | string | yes |  |
| `input.text` | string | yes |  |
| `input.delivery` | string | no |  |
| `input.targetRunId` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

## run

### `run.get`

One Run and how it stands or ended.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `runId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | yes |  |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |

### `run.list`

The Runs of a Session, the newest first.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].sessionId` | string | yes |  |
| `items[].phase` | string | yes |  |
| `items[].inputId` | string | no |  |
| `items[].provider` | string | yes |  |
| `items[].model` | string | no |  |
| `items[].startedAt` | integer | no |  |
| `items[].endedAt` | integer | no |  |
| `items[].stop` | object | no |  |
| `items[].outcome` | object | no |  |
| `nextCursor` | string | no |  |

### `run.wait`

Answers once the Run has an outcome. Fails with `timeout` when `timeoutMs` passes first; the Run goes on, and asking again is safe.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `runId` | string | yes |  |
| `timeoutMs` | integer | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | yes |  |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |

### `run.stop`

Asks the Run to stop. The answer says the request was recorded; the Run's `outcome` says how it ended.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `runId` | string | yes |  |

Empty result.

### `run.startTool`

Runs one tool a person named, without asking the model. The tool passes the permission checks a tool the model calls passes, and what it did enters the conversation. The `requestId` is the id of the input, as for `input.submit`: sent again, it answers with the Run it started. A tool the Host does not have, or one that was refused, is a Run that failed. The request itself fails with `conflict` while the Session is running.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `tool` | string | yes | The tool, by the name the Host knows it under. |
| `input` | object | yes |  |
| `text` | string | yes | What the person typed. It is their message in the conversation. |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | yes |  |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |

### `run.recover`

Continues a Run that stopped part-way at a point it can go on from, which is where a Host that shuts down leaves the Run it was working on. Such a Run has the phase `recovering` and no outcome. Only who started the Run may continue it. Safe to send for any Run: one that is not waiting to be continued is answered as it stands. Fails with `conflict` while a waiting Run cannot go on: the Host that runs it is still at work, or the conversation moved on since it stopped.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `runId` | string | yes |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | yes |  |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |

## review

### `review.start`

Reviews the changes in the Session's project, as a person does who types `/review args`. `args` choose what to compare, such as `--staged`, `base` or a commit, and how: `--lean` for a short review, `--workflow` for one split among several agents, and words after `--` for what to look at. A review starts a Run. With no changes to review, or `args` it cannot read, the Host answers with `success` and a `message` instead. The Session must not be at work.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `args` | string[] | no | What the person typed after `/review`, word by word. |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `run` | object | no | The Run the command started. Absent when the Host finished the command itself. |
| `run.id` | string | yes |  |
| `run.sessionId` | string | yes |  |
| `run.phase` | string | yes | What the Run is doing, for display. |
| `run.inputId` | string | no | The input the Run was started for, when it was started for one. |
| `run.provider` | string | yes |  |
| `run.model` | string | no |  |
| `run.startedAt` | integer | no | UTC milliseconds. |
| `run.endedAt` | integer | no |  |
| `run.stop` | object | no | Present once the Run was asked to stop, by a Stop or by the Host at the Run's time limit. The Run has stopped when `outcome` says so. |
| `run.outcome` | object | no |  |
| `success` | boolean | no | Whether a command the Host finished itself did what was asked. Absent with `run`: the outcome of the Run tells. |
| `message` | string | no | What the command says to the person. |

## blob

### `blob.begin`

Opens an upload, or finds the one already open for the same bytes. `received` is how many bytes the Host already has: the client writes from there. Bytes the Session already holds come back with `received` equal to `byteLength`, and the client only commits.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `mediaType` | string | yes |  |
| `byteLength` | integer | yes |  |
| `sha256` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `blobId` | string | yes |  |
| `received` | integer | yes |  |

### `blob.write`

Writes the next chunk at `offset`, which is the `received` of the last answer. A chunk the Host already has is accepted again, so a write whose answer was lost can be repeated.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `blobId` | string | yes |  |
| `offset` | integer | yes |  |
| `data` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `received` | integer | yes |  |

### `blob.commit`

Checks the bytes against the `sha256` the upload began with. Bytes that do not match end the upload.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `blobId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `blob` | object | yes |  |
| `blob.blobId` | string | yes |  |
| `blob.mediaType` | string | yes |  |
| `blob.byteLength` | integer | yes |  |
| `blob.sha256` | string | yes |  |

### `blob.read`

A chunk of a blob, uploaded or attached to an item. Every chunk says the whole blob's length and hash. A cursor whose blob changed fails with `resync_required`, and the client reads again from the start.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `blobId` | string | yes |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `data` | string | yes |  |
| `mediaType` | string | yes |  |
| `byteLength` | integer | yes |  |
| `sha256` | string | yes |  |
| `nextCursor` | string | no |  |

## interaction

### `interaction.list`

The pending interactions of one Session, or of every Session without `sessionId`.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `nextCursor` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `interaction.respond`

`status` says what became of this answer: answered, unanswered, dismissed — it settled the interaction already_resolved                — another answer settled it first, it timed out, or it never existed The same answer sent again under the same `requestId` gets the status it got the first time. A different answer under that `requestId` fails with `conflict`.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `interactionId` | string | yes |  |
| `response` | object | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `status` | "answered" or "unanswered" or "dismissed" or "already_resolved" | yes |  |

## permission

### `permission.grant.list`

`revision` changes whenever the set of grants does.

Kind: query · Who: owner, user, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].sessionId` | string | no | The Session it holds in. A grant without one is not thereby a grant for every Session. |
| `items[].toolName` | string | no |  |
| `items[].label` | string | no | Says what the grant covers, for a person to read. It may name a path on the Host and is no reference to one. |
| `items[].persistence` | "session" or "persistent" | no |  |
| `items[].createdAt` | integer | no |  |
| `revision` | string | yes |  |

### `permission.grant.revoke`

Succeeds when the grant is gone, whether or not this call removed it. With `ifRevision`, fails with `conflict` when the grants changed since that revision was read.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `grantId` | string | yes |  |
| `ifRevision` | string | no |  |

Empty result.

## stats

### `stats.get`

The Session's totals: requests, usage and tool calls.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `stats` | object | yes |  |
| `stats.revision` | integer | yes | Goes up with every count the Host adds. |
| `stats.coverage` | string | yes | `partial` when the Host could not see every request; `issues` says why. |
| `stats.issues` | string[] | yes |  |
| `stats.usage` | object | yes | The sum over the requests whose provider reported usage. |
| `stats.requestCount` | integer | yes |  |
| `stats.requestsWithoutUsage` | integer | yes |  |
| `stats.physicalRequestCount` | integer | yes | Requests the Host saw go out on the wire. The rest it knows only as operations of a provider adapter. |
| `stats.operationCount` | integer | yes |  |
| `stats.contexts` | object[] | yes |  |

### `stats.requests`

The Session's model requests, a page at a time.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].logicalId` | string | yes |  |
| `items[].previousId` | string | no |  |
| `items[].provider` | string | yes |  |
| `items[].model` | string | no |  |
| `items[].purpose` | string | yes |  |
| `items[].attribution` | object | no |  |
| `items[].attempt` | integer | yes |  |
| `items[].fallback` | boolean | yes |  |
| `items[].route` | object | no |  |
| `items[].boundary` | string | yes |  |
| `items[].dispatch` | string | yes |  |
| `items[].wireObservation` | string | no |  |
| `items[].state` | string | yes |  |
| `items[].recovery` | string | no |  |
| `items[].startedAt` | integer | yes |  |
| `items[].endedAt` | integer | no |  |
| `items[].usage` | object | no |  |
| `items[].partialUsage` | object | no |  |
| `items[].target` | object | yes |  |
| `items[].revision` | integer | yes |  |
| `nextCursor` | string | no |  |
| `revision` | integer | yes |  |

### `stats.tools`

The Session's tool calls, a page at a time.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].toolId` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].state` | string | yes |  |
| `items[].result` | string | no |  |
| `items[].updatedAt` | integer | yes |  |
| `items[].target` | object | yes |  |
| `items[].sandbox` | object[] | yes |  |
| `items[].revision` | integer | yes |  |
| `nextCursor` | string | no |  |
| `revision` | integer | yes |  |

The owner on the Host's own machine also receives paths on that machine.

## actor

### `actor.tree`

The Session's Agents as a tree: the main Agent and the children each started.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes | The root and every actor under it. |
| `items[].path` | string | yes |  |
| `items[].taskName` | string | yes |  |
| `items[].parentPath` | string | no |  |
| `items[].kind` | string | yes |  |
| `items[].state` | string | yes |  |
| `items[].capabilities` | object | yes |  |
| `items[].turnIds` | string[] | yes |  |
| `items[].currentTurnId` | string | no |  |
| `items[].mailboxCursor` | integer | yes |  |
| `items[].createdAt` | integer | yes |  |
| `items[].updatedAt` | integer | yes |  |
| `items[].revision` | integer | yes |  |
| `items[].latestTurn` | object | no |  |
| `activeNonRootTurns` | integer | yes | Turns of children in progress, against the most the Session runs at once. |
| `maxConcurrentThreads` | integer | yes |  |
| `revision` | integer | yes | Goes up with every change to the tree, its turns or its mailboxes. |

### `actor.get`

One Agent of the Session, by its path in the tree.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `actorPath` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `actor` | object | yes |  |
| `actor.path` | string | yes |  |
| `actor.taskName` | string | yes |  |
| `actor.parentPath` | string | no |  |
| `actor.kind` | string | yes |  |
| `actor.state` | string | yes |  |
| `actor.capabilities` | object | yes |  |
| `actor.turnIds` | string[] | yes |  |
| `actor.currentTurnId` | string | no |  |
| `actor.mailboxCursor` | integer | yes |  |
| `actor.createdAt` | integer | yes |  |
| `actor.updatedAt` | integer | yes |  |
| `actor.revision` | integer | yes |  |
| `turns` | object[] | yes |  |
| `turns[].turnId` | string | yes |  |
| `turns[].actorPath` | string | yes |  |
| `turns[].sequence` | integer | yes |  |
| `turns[].state` | string | yes |  |
| `turns[].objective` | string | yes |  |
| `turns[].forkTurns` | string or integer | yes |  |
| `turns[].createdAt` | integer | yes |  |
| `turns[].startedAt` | integer | no |  |
| `turns[].completedAt` | integer | no |  |
| `turns[].output` | string | no |  |
| `turns[].structured` | any | no |  |
| `turns[].error` | string | no |  |
| `turns[].progress` | object[] | no |  |
| `turns[].iteration` | object | no |  |
| `turns[].terminationReason` | string | no |  |
| `turns[].revision` | integer | yes |  |
| `mailbox` | object[] | yes |  |
| `mailbox[].messageId` | string | yes |  |
| `mailbox[].sequence` | integer | yes |  |
| `mailbox[].senderPath` | string | yes |  |
| `mailbox[].recipientPath` | string | yes |  |
| `mailbox[].turnId` | string | no |  |
| `mailbox[].kind` | string | yes |  |
| `mailbox[].classification` | string | yes |  |
| `mailbox[].lineage` | string[] | no |  |
| `mailbox[].forwardedMessageId` | string | no |  |
| `mailbox[].text` | string | yes |  |
| `mailbox[].createdAt` | integer | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `actor.output`

What one turn answered. Without `turnId`, the actor's newest turn.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `actorPath` | string | yes |  |
| `turnId` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `actorPath` | string | yes |  |
| `turnId` | string | yes |  |
| `state` | string | yes |  |
| `output` | string | no |  |
| `outputTruncated` | boolean | no |  |
| `progress` | object[] | yes |  |
| `progress[].sequence` | integer | yes |  |
| `progress[].kind` | string | yes |  |
| `progress[].summary` | string | yes |  |
| `progress[].iteration` | object | no |  |
| `progress[].createdAt` | integer | yes |  |
| `structured` | any | no |  |
| `error` | string | no |  |
| `iteration` | object | no |  |
| `iteration.current` | integer | yes |  |
| `iteration.max` | integer | yes |  |
| `terminationReason` | string | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `actor.wait`

Waits for something to happen among the Session's actors after `afterSequence`, and answers without `event` when nothing did in time. It is a nudge to read the tree again, not a full record: the Host keeps a bounded number of events and drops the ended turns the root has taken note of.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `afterSequence` | integer | no |  |
| `timeoutMs` | integer | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `event` | object | no |  |
| `event.sequence` | integer | yes |  |
| `event.kind` | string | yes | `actor_spawned`, `turn_started`, `message_delivered`, `turn_progress`, `turn_completed`, `turn_failed`, `turn_interrupted` or `actor_closed`. |
| `event.actorPath` | string | yes |  |
| `event.turnId` | string | no |  |
| `event.parentPath` | string | no |  |
| `event.progress` | object | no |  |
| `event.createdAt` | integer | yes |  |

### `actor.spawn`

Starts a child of the root at `/root/<taskName>` with its first turn. A name in use is refused with `conflict`. As for a Run, the model calls of the turn use the key the Session binds; `leases` sent there are refused with `invalid_params`, reason `lease_bound_by_session`. In a Session that binds none, they use the key of `leases.credential`, else the Host's own.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `taskName` | string | yes |  |
| `objective` | string | yes |  |
| `forkTurns` | "all" or "none" or integer | no | How much of the root's conversation the child starts from: `all` (the default), `none` or a number of turns. |
| `capabilities` | object | no |  |
| `capabilities.tools` | string[] | no |  |
| `capabilities.filesystem` | "none" or "read" or "write" | no |  |
| `capabilities.network` | boolean | no |  |
| `capabilities.providers` | string[] | no |  |
| `capabilities.canAskUser` | boolean | no |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `actorPath` | string | yes |  |
| `turnId` | string | yes |  |

### `actor.followup`

Gives a child a new objective. An idle child starts a turn for it (`started_turn`), under the same key rules as `actor.spawn`. A child at work takes it into the turn in progress (`current_turn`), except that a key the client lends is for a new turn only and is refused there with `invalid_params`. `ifRevision` is the actor `revision` the child must still have.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `actorPath` | string | yes |  |
| `objective` | string | yes |  |
| `ifRevision` | integer | no |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `delivery` | "started_turn" or "current_turn" | yes |  |
| `turnId` | string | yes |  |

### `actor.send`

Puts a message from the root in an actor's mailbox. It starts no turn: an idle actor reads it in its next one.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `actorPath` | string | yes |  |
| `text` | string | yes |  |
| `classification` | "public" or "internal" or "sensitive" | no | How freely the actor may pass the message on. `internal` when absent. |

Empty result.

### `actor.interrupt`

Ends the named turn as `interrupted`. A turn that already ended is left as it is.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `actorPath` | string | yes |  |
| `turnId` | string | yes |  |
| `reason` | string | no |  |

Empty result.

## workflow

### `workflow.list`

The Session's workflows, newest first.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `activeOnly` | boolean | no | Only those still running or paused. |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].displayName` | string | no |  |
| `items[].status` | string | yes |  |
| `items[].stop` | object | no |  |
| `items[].spawnedAgents` | integer | yes |  |
| `items[].error` | string | no |  |
| `items[].startedAt` | integer | yes |  |
| `items[].updatedAt` | integer | no |  |
| `items[].endedAt` | integer | no |  |
| `nextCursor` | string | no |  |

### `workflow.get`

One workflow of the Session and how it stands.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `workflowId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `workflow` | object | yes |  |
| `workflow.id` | string | yes |  |
| `workflow.name` | string | yes |  |
| `workflow.displayName` | string | no |  |
| `workflow.status` | string | yes |  |
| `workflow.stop` | object | no |  |
| `workflow.spawnedAgents` | integer | yes |  |
| `workflow.error` | string | no |  |
| `workflow.startedAt` | integer | yes |  |
| `workflow.updatedAt` | integer | no |  |
| `workflow.endedAt` | integer | no |  |
| `workflow.runId` | string | no |  |
| `workflow.goal` | string | no |  |
| `workflow.source` | string | no |  |
| `workflow.savedWorkflowName` | string | no |  |
| `workflow.resumedFromId` | string | no |  |
| `workflow.activePhaseId` | string | no |  |
| `workflow.phaseCount` | integer | no |  |
| `workflow.items` | object[] | yes |  |
| `workflow.counts` | object | yes |  |
| `workflow.progress` | object | yes |  |
| `workflow.tokens` | object | no |  |
| `workflow.latestMessage` | string | no |  |
| `workflow.result` | string | no |  |
| `workflow.artifacts` | object[] | no |  |

The owner on the Host's own machine also receives paths on that machine.

### `workflow.start`

Starts a workflow as a Run of the Session, by its name or by a request the Host writes the script for. Only a trusted role may send its own `script`: the Host runs it without a sandbox around it.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `name` | string | no | A built-in or saved workflow. |
| `request` | string | no | What the workflow should do, for the Host to write a script for. |
| `script` | object | no | Only owner and service may send it. |
| `script.manifest` | object | yes |  |
| `script.source` | string | yes |  |
| `args` | object | no |  |
| `provider` | string | no |  |
| `model` | string | no |  |
| `leases` | object | no | Only owner and service may send it. |
| `leases.credential` | string | no | The model calls of the Run get their provider keys from this lease. |
| `leases.hostTools` | string | no | The Run may call the tools of this lease. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `workflowId` | string | yes |  |
| `runId` | string | yes |  |

### `workflow.pause`

Keeps the workflow from starting more Agents. Those running go on.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `workflowId` | string | yes |  |

Empty result.

### `workflow.resume`

Lets a paused workflow start Agents again.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `workflowId` | string | yes |  |

Empty result.

### `workflow.stop`

Asks the workflow to stop; `stop.state` says when all its work has ended. One that already ended is left as it is.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |
| `workflowId` | string | yes |  |

Empty result.

## workspace

### `workspace.list`

What a directory holds, ordered by name, a page at a time.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | no | The workspace itself when absent. |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `entries` | object[] | yes |  |
| `entries[].name` | string | yes |  |
| `entries[].kind` | "file" or "directory" or "link" or "other" | yes | A link is not followed: list or read through it to see where it leads. |
| `entries[].size` | integer | no | Bytes, for a file. |
| `entries[].modifiedAt` | integer | no | UTC milliseconds. Absent for a link. |
| `nextCursor` | string | no |  |

### `workspace.read`

A chunk of a file, at most `limits.blobChunkBytes`, in base64. Every chunk says the whole file's length. A cursor whose file changed since fails with `resync_required` (`file_changed`), and the client reads again from the start.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | yes |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `data` | string | yes |  |
| `byteLength` | integer | yes |  |
| `modifiedAt` | integer | yes |  |
| `nextCursor` | string | no |  |

### `workspace.gitDiff`

What git sees changed under a directory, as a unified diff with paths relative to it: the working tree against the index, or with `staged` the index against `HEAD`. Files git does not track yet are not in it. A diff longer than 256 KiB is cut at a line and says `truncated`. A directory outside any git work tree fails with `invalid_state` (`not_a_git_repository`). A repository whose own config names a filter, a command git would run as it reads, fails with `forbidden` (`repository_filters`).

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | string | no |  |
| `staged` | boolean | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `diff` | string | yes |  |
| `truncated` | boolean | no |  |

## host

### `host.get`

Which Host this is, its version, and how much work it holds.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `host` | object | yes |  |
| `host.id` | string | yes |  |
| `host.version` | string | yes |  |
| `host.mode` | string | yes |  |
| `host.profile` | string | yes |  |
| `host.startedAt` | integer | yes |  |
| `host.build` | object | no | The installation the Host runs: where it was loaded from and a hash of its code. Two Hosts of the same `version` differ here when one is a newer build. |
| `counts` | object | yes | `activeRuns` are Runs in progress that are not waiting in the queue. |
| `counts.sessions` | integer | yes |  |
| `counts.runs` | integer | yes |  |
| `counts.activeRuns` | integer | yes |  |
| `counts.queuedRuns` | integer | yes |  |
| `counts.workflows` | integer | yes |  |
| `integrations` | object | no | `degraded` when a domain is not as configured. The Host runs either way. Absent when the Host does not watch them. |
| `integrations.state` | string | yes |  |
| `integrations.domains` | object[] | yes |  |

### `host.preflight`

Whether the Host can stop now, and what stopping would cut short.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `canStop` | boolean | yes |  |
| `blockers` | string[] | yes | What stopping now would cut short: `connected_clients`, `active_runs`, `queued_runs`, `active_workflows`, `active_agent_turns` or `pending_interactions`. |
| `clients` | object[] | yes | The clients connected to the Host. |
| `clients[].name` | string | no |  |
| `clients[].title` | string | no |  |
| `clients[].version` | string | no |  |
| `clients[].type` | string | yes |  |
| `clients[].connectedAt` | integer | yes |  |
| `activeRunIds` | string[] | yes |  |
| `queuedRunIds` | string[] | yes |  |
| `activeWorkflowIds` | string[] | yes |  |
| `activeAgentTurns` | object[] | yes |  |
| `activeAgentTurns[].sessionId` | string | yes |  |
| `activeAgentTurns[].actorPath` | string | yes |  |
| `activeAgentTurns[].turnId` | string | yes |  |
| `activeAgentTurns[].kind` | string | yes |  |
| `pendingInteractions` | integer | yes |  |
| `pendingBackgroundWork` | integer | no | Work an idle Host keeps for later and a stop gives up. |
| `owner` | object | yes | The Host process. After a stop, a client waits until this process is gone; `processStartIdentity` tells it apart from a later process that got the same `pid`. |
| `owner.pid` | integer | yes |  |
| `owner.createdAt` | integer | yes |  |
| `owner.processStartIdentity` | string | no |  |

### `host.stop`

Fails with `conflict` while stopping would cut work short; `host.preflight` says what. The SDK does not send it again: that would stop the Host that replaced the one it stopped.

Kind: command · Resend: never · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |

Empty result.

### `host.logs`

The Host's most recent log entries.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `logFile` | string | no |  |
| `entries` | object[] | yes | The most recent entries, oldest first. |
| `entries[].at` | integer | yes |  |
| `entries[].level` | string | yes |  |
| `entries[].message` | string | yes |  |
| `entries[].data` | object | no |  |

## client

### `client.exit.request`

Stops this client's work on the Host, and the Host too with `shutdownHost` when no other client is connected. Sending the same `requestId` again answers with the same exit.

Kind: command · Resend: never · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `shutdownHost` | boolean | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `exit` | object | yes |  |
| `exit.id` | string | yes |  |
| `exit.runtimeId` | string | yes | The Host the exit was asked of. |
| `exit.requestedAt` | integer | yes |  |
| `exit.updatedAt` | integer | yes |  |
| `exit.cleanup` | object | yes | The client's own work the Host stopped or withdrew. |
| `exit.host` | object | yes | Whether the client asked the Host to stop too, and how that went. |
| `exit.recovery` | object | no | Whether the client may start or connect again. `state` is `ready`, `pending` or `blocked`; `nextAction` says what to do about it. |

### `client.exit.get`

An exit this client asked for with `client.exit`, and how far it got.

Kind: query · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `exitId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `exit` | object | yes |  |
| `exit.id` | string | yes |  |
| `exit.runtimeId` | string | yes | The Host the exit was asked of. |
| `exit.requestedAt` | integer | yes |  |
| `exit.updatedAt` | integer | yes |  |
| `exit.cleanup` | object | yes | The client's own work the Host stopped or withdrew. |
| `exit.host` | object | yes | Whether the client asked the Host to stop too, and how that went. |
| `exit.recovery` | object | no | Whether the client may start or connect again. `state` is `ready`, `pending` or `blocked`; `nextAction` says what to do about it. |

### `client.exit.list`

This client's exits that are not yet done.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].runtimeId` | string | yes |  |
| `items[].requestedAt` | integer | yes |  |
| `items[].updatedAt` | integer | yes |  |
| `items[].cleanup` | object | yes |  |
| `items[].host` | object | yes |  |
| `items[].recovery` | object | no |  |
| `nextCursor` | string | no |  |

## repo

### `repo.intelligence.inspect`

Reading the state never builds the index.

Kind: query · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `configuredMode` | string | yes |  |
| `requestedMode` | string | yes |  |
| `effectiveEngine` | string | yes |  |
| `status` | string | yes | `disabled`, `ok`, `limited`, `unavailable` or `warming`. |
| `initialized` | boolean | yes |  |
| `warnings` | string[] | yes |  |
| `workspaceRoot` | string | yes | The directory the Session's code index covers. |

### `repo.intelligence.prewarm`

Builds the Session's code index now, so its first Run does not wait for it.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `sessionId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `configuredMode` | string | yes |  |
| `requestedMode` | string | yes |  |
| `effectiveEngine` | string | yes |  |
| `status` | string | yes | `disabled`, `ok`, `limited`, `unavailable` or `warming`. |
| `initialized` | boolean | yes |  |
| `warnings` | string[] | yes |  |
| `workspaceRoot` | string | yes | The directory the Session's code index covers. |

## device

### `device.pair`

A one-time code that pairs one browser. Open `<address>/#pair=<code>` on it before `expiresAt`. Sending the same `requestId` again answers with the same code while it is good.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `name` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `code` | string | yes |  |
| `expiresAt` | integer | yes |  |

### `device.list`

The devices paired with the Host.

Kind: query · Who: owner

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].origin` | string | yes |  |
| `items[].pairedAt` | integer | yes |  |
| `items[].lastSeenAt` | integer | yes |  |
| `nextCursor` | string | no |  |

### `device.revoke`

Its connections close as `revoked`. A device that is not paired, such as one already revoked, answers the same.

Kind: command · Resend: auto · Who: owner

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `deviceId` | string | yes |  |

Empty result.

## config

### `config.get`

The Host's saved configuration with its `revision`, and what is in effect.

Kind: query · Who: owner, user

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `config` | object | yes |  |
| `revision` | string | yes |  |
| `effective` | object | yes |  |
| `effective.persisted` | string | yes | `loaded`, `missing` or `invalid`: whether the saved configuration could be read. |
| `effective.entries` | object | yes | What is in effect, by setting name. |
| `effective.credentials` | object | yes | Which provider keys the Host's environment holds, by variable name. Never their values. |
| `effective.application` | object | no | When a changed setting takes effect: `immediate`, `next_run`, `restart` or `extension_reload`. |

### `config.update`

Fails with `conflict` when `ifRevision` is not the saved configuration's revision.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `patch` | object | yes |  |
| `patch.provider` | string or null | no |  |
| `patch.model` | string or null | no |  |
| `patch.effort` | string or null | no |  |
| `patch.planModeEffort` | string or null | no |  |
| `patch.thinking` | boolean or null | no |  |
| `patch.reasoningMode` | "off" or "auto" or "quick" or "balanced" or "deep" or null | no |  |
| `patch.permissionMode` | "plan" or "accept-edits" or "auto" or "full-access" or null | no |  |
| `patch.locale` | string or null | no |  |
| `patch.providerModels` | object or null | no |  |
| `patch.extensions` | string[] or null | no |  |
| `patch.repoIntelligenceMode` | "auto" or "off" or "light" or "full" or null | no |  |
| `patch.repoIntelligenceTrace` | boolean or null | no |  |
| `patch.stallLog` | boolean or null | no |  |
| `patch.fallbackProviders` | string[] or null | no |  |
| `patch.fastProvider` | string or null | no |  |
| `patch.fastModel` | string or null | no |  |
| `patch.deepProvider` | string or null | no |  |
| `patch.deepModel` | string or null | no |  |
| `patch.maxOutputTokens` | integer or null | no |  |
| `patch.disablePromptCache` | boolean or null | no |  |
| `patch.cacheWarming` | "off" or "run" or "idle" or null | no |  |
| `patch.lsp` | boolean or null | no |  |
| `patch.lspAutoDownload` | boolean or null | no |  |
| `patch.acpLogLevel` | string or null | no |  |
| `patch.sessionRetentionDays` | integer or null | no |  |
| `patch.repoIntelligence` | object or null | no |  |
| `patch.workflow` | object or null | no |  |
| `ifRevision` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `config` | object | yes |  |
| `revision` | string | yes |  |

### `config.reload`

Reads the saved configuration again after something other than the Host changed it.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `config` | object | yes |  |
| `revision` | string | yes |  |

## mcp

### `mcp.server.list`

The MCP servers configured on the Host and how each is doing.

Kind: query · Who: owner, user

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].config` | object | yes |  |
| `items[].connect` | string | yes |  |
| `items[].status` | string | yes |  |
| `items[].transport` | string | no |  |
| `items[].tools` | integer | yes |  |
| `items[].resources` | integer | yes |  |
| `items[].prompts` | integer | yes |  |
| `items[].stale` | boolean | yes |  |
| `items[].cachedAt` | string | no |  |
| `items[].lastError` | string | no |  |
| `nextCursor` | string | no |  |

### `mcp.server.get`

Fails with `not_found` when no server has the name.

Kind: query · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `config` | object | yes |  |

### `mcp.server.validate`

Says whether the Host could use the configuration, without saving it.

Kind: query · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `config` | object | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `ok` | boolean | yes |  |
| `config` | object | no |  |
| `error` | string | no |  |

### `mcp.server.upsert`

Saves a server, or replaces the one of the same name. A running server keeps its old configuration until `mcp.server.reload`. Fails with `invalid_params` when the Host cannot use it.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `name` | string | yes |  |
| `config` | object | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `config` | object | yes |  |

### `mcp.server.remove`

Answers the same whether or not the server was there, so it is safe to send again.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `name` | string | yes |  |

Empty result.

### `mcp.server.reload`

Disconnects every server and connects again with the saved configurations. The SDK does not send it again: that would cut every server off once more.

Kind: command · Resend: never · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].name` | string | yes |  |
| `items[].config` | object | yes |  |
| `items[].connect` | string | yes |  |
| `items[].status` | string | yes |  |
| `items[].transport` | string | no |  |
| `items[].tools` | integer | yes |  |
| `items[].resources` | integer | yes |  |
| `items[].prompts` | integer | yes |  |
| `items[].stale` | boolean | yes |  |
| `items[].cachedAt` | string | no |  |
| `items[].lastError` | string | no |  |
| `nextCursor` | string | no |  |

### `mcp.tool.list`

The tools of every server, or of `server`. Reading a server the Host has not connected to yet connects to it, which for a stdio server starts its command. Fails with `not_found` when `server` names none.

Kind: query · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `server` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].server` | string | yes |  |
| `items[].tools` | object[] | no |  |
| `items[].cachedAt` | string | no |  |
| `items[].error` | string | no |  |
| `nextCursor` | string | no |  |

### `mcp.tool.refresh`

Like `mcp.tool.list`, but asks each server again instead of reading what the Host kept.

Kind: command · Resend: auto · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `server` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].server` | string | yes |  |
| `items[].tools` | object[] | no |  |
| `items[].cachedAt` | string | no |  |
| `items[].error` | string | no |  |
| `nextCursor` | string | no |  |

## extension

### `extension.list`

The extensions the Host loaded, and those that failed to load.

Kind: query · Who: owner, user

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `active` | boolean | yes |  |
| `extensions` | object[] | yes |  |
| `extensions[].path` | string | yes | Where the module is, as a path on the Host. |
| `extensions[].label` | string | yes |  |
| `extensions[].loadSource` | string | yes | How the Host found it: `config`, `cli`, `api` or `discovery`. |
| `failures` | object[] | yes |  |
| `failures[].stage` | string | yes | `load`, `reload`, `event`, `hook`, `persistence` or `dispose`. |
| `failures[].target` | string | yes |  |
| `failures[].message` | string | yes |  |
| `failures[].occurredAt` | string | yes |  |

### `extension.reload`

Loads again the extensions the Host has loaded, so a changed module takes effect. One that fails is listed under `failures`; the others still load. An extension newly added to the configuration, or one that failed when the Host started, loads at the next restart. The SDK does not send it again: that would run every extension's setup once more.

Kind: command · Resend: never · Who: owner, user

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `active` | boolean | yes |  |
| `extensions` | object[] | yes |  |
| `extensions[].path` | string | yes | Where the module is, as a path on the Host. |
| `extensions[].label` | string | yes |  |
| `extensions[].loadSource` | string | yes | How the Host found it: `config`, `cli`, `api` or `discovery`. |
| `failures` | object[] | yes |  |
| `failures[].stage` | string | yes | `load`, `reload`, `event`, `hook`, `persistence` or `dispose`. |
| `failures[].target` | string | yes |  |
| `failures[].message` | string | yes |  |
| `failures[].occurredAt` | string | yes |  |

## learning

### `learning.list`

What waits for the person first: `ready`, then `quarantined`, then the rest. `revision` is the event sequence the page was read at.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `search` | string | no |  |
| `carrier` | string | no |  |
| `lifecycle` | string | no |  |
| `limit` | integer | no |  |
| `cursor` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].slug` | string | yes |  |
| `items[].carrier` | string | yes |  |
| `items[].lifecycle` | string | yes |  |
| `items[].revision` | integer | yes | Goes up with every change to the capability. |
| `items[].createdAt` | integer | yes |  |
| `items[].updatedAt` | integer | yes |  |
| `items[].lastAction` | string | no | The decision that produced this revision, when the lifecycle does not say: `rollback`, for one. |
| `items[].previousGoodRevision` | integer | no | The revision a rollback returns to. |
| `items[].diagnostics` | string[] | no |  |
| `items[].canary` | object | no | How a Skill on trial has fared so far. |
| `nextCursor` | string | no |  |
| `revision` | integer | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `learning.get`

Fails with `not_found` (`capability_not_found`).

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `nameOrSlug` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `capability` | object | yes |  |
| `capability.id` | string | yes |  |
| `capability.name` | string | yes |  |
| `capability.slug` | string | yes |  |
| `capability.carrier` | string | yes |  |
| `capability.lifecycle` | string | yes |  |
| `capability.revision` | integer | yes | Goes up with every change to the capability. |
| `capability.createdAt` | integer | yes |  |
| `capability.updatedAt` | integer | yes |  |
| `capability.lastAction` | string | no | The decision that produced this revision, when the lifecycle does not say: `rollback`, for one. |
| `capability.previousGoodRevision` | integer | no | The revision a rollback returns to. |
| `capability.diagnostics` | string[] | no |  |
| `capability.canary` | object | no | How a Skill on trial has fared so far. |

The owner on the Host's own machine also receives paths on that machine.

### `learning.snapshot`

The counts a client shows as a badge: what waits for the person and what became active.

Kind: query · Who: owner, user, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `ready` | integer | yes |  |
| `newlyActive` | integer | yes |  |
| `attention` | integer | yes |  |
| `active` | integer | yes |  |
| `revision` | integer | yes |  |

### `learning.events`

The events after `afterRevision`, a sequence, oldest first.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `afterRevision` | integer | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].sequence` | integer | yes |  |
| `items[].id` | string | yes |  |
| `items[].kind` | string | yes |  |
| `items[].capabilityId` | string | yes |  |
| `items[].capabilityRevision` | integer | yes |  |
| `items[].lifecycle` | string | yes |  |
| `items[].name` | string | yes |  |
| `items[].slug` | string | yes |  |
| `items[].carrier` | string | yes |  |
| `items[].createdAt` | integer | yes |  |
| `nextCursor` | string | no |  |

### `learning.acknowledge`

Marks the capability's latest event as seen by this client.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |

Empty result.

### `learning.snooze`

Hides the capability's latest event from this client until `until`, in UTC milliseconds.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `until` | integer | yes |  |

Empty result.

### `learning.reject`

Turns down a capability the Host proposed; it is not used.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

### `learning.disable`

Stops using the capability. A rollback brings back the last good revision.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

### `learning.rollback`

Brings back the capability's last good revision and keeps it in use.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

### `learning.review`

Puts a Skill on trial: the Host uses it a few times and watches how it fares before it becomes active.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

### `learning.trust`

Lets the Host use the capability without a trial.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

### `learning.promote`

Makes a learned Skill one of the person's own Skills. Promoted already, it succeeds.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `nameOrSlug` | string | yes |  |
| `scope` | "user" | yes |  |
| `ifRevision` | integer | no |  |

Empty result.

## memory

### `memory.list`

Every note of both scopes, of every status, without their bodies.

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `items` | object[] | yes |  |
| `items[].id` | string | yes |  |
| `items[].scope` | "user" or "project" | yes |  |
| `items[].type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `items[].status` | string | yes |  |
| `items[].source` | string | no |  |
| `items[].description` | string | yes |  |
| `items[].why` | string | no |  |
| `items[].check` | string | no |  |
| `items[].used` | integer | yes |  |
| `items[].lastUsedAt` | integer | no |  |
| `items[].revision` | string | yes |  |
| `nextCursor` | string | no |  |

### `memory.get`

Fails with `not_found` (`note_not_found`).

Kind: query · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `scope` | "user" or "project" | yes |  |
| `id` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `note` | object | yes |  |
| `note.id` | string | yes |  |
| `note.scope` | "user" or "project" | yes |  |
| `note.type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `note.status` | string | yes |  |
| `note.source` | string | no |  |
| `note.description` | string | yes |  |
| `note.why` | string | no |  |
| `note.check` | string | no |  |
| `note.used` | integer | yes |  |
| `note.lastUsedAt` | integer | no |  |
| `note.revision` | string | yes |  |
| `note.body` | string | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `memory.create`

Writes a new active note. An `id` taken by another note fails with `conflict` (`note_exists`); one that is not a valid id fails with `invalid_params` (`invalid_note_id`).

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `scope` | "user" or "project" | yes |  |
| `id` | string | yes |  |
| `type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `description` | string | yes |  |
| `body` | string | no |  |
| `why` | string | no |  |
| `check` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `note` | object | yes |  |
| `note.id` | string | yes |  |
| `note.scope` | "user" or "project" | yes |  |
| `note.type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `note.status` | string | yes |  |
| `note.source` | string | no |  |
| `note.description` | string | yes |  |
| `note.why` | string | no |  |
| `note.check` | string | no |  |
| `note.used` | integer | yes |  |
| `note.lastUsedAt` | integer | no |  |
| `note.revision` | string | yes |  |
| `note.body` | string | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `memory.update`

Changes the fields given and keeps the rest.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `scope` | "user" or "project" | yes |  |
| `id` | string | yes |  |
| `ifRevision` | string | no |  |
| `type` | "user" or "feedback" or "project" or "reference" or "procedure" | no |  |
| `description` | string | no |  |
| `body` | string | no |  |
| `why` | string | no |  |
| `check` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `note` | object | yes |  |
| `note.id` | string | yes |  |
| `note.scope` | "user" or "project" | yes |  |
| `note.type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `note.status` | string | yes |  |
| `note.source` | string | no |  |
| `note.description` | string | yes |  |
| `note.why` | string | no |  |
| `note.check` | string | no |  |
| `note.used` | integer | yes |  |
| `note.lastUsedAt` | integer | no |  |
| `note.revision` | string | yes |  |
| `note.body` | string | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `memory.approve`

Makes a note active and the person's own, so Runs read it.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `scope` | "user" or "project" | yes |  |
| `id` | string | yes |  |
| `ifRevision` | string | no |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `note` | object | yes |  |
| `note.id` | string | yes |  |
| `note.scope` | "user" or "project" | yes |  |
| `note.type` | "user" or "feedback" or "project" or "reference" or "procedure" | yes |  |
| `note.status` | string | yes |  |
| `note.source` | string | no |  |
| `note.description` | string | yes |  |
| `note.why` | string | no |  |
| `note.check` | string | no |  |
| `note.used` | integer | yes |  |
| `note.lastUsedAt` | integer | no |  |
| `note.revision` | string | yes |  |
| `note.body` | string | yes |  |

The owner on the Host's own machine also receives paths on that machine.

### `memory.forget`

Removes a note. A note that is not there is forgotten already, so this succeeds.

Kind: command · Resend: auto · Who: owner, user, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `project` | string | no |  |
| `projectRoot` | string | no | Only owner may send it. |
| `scope` | "user" or "project" | yes |  |
| `id` | string | yes |  |
| `ifRevision` | string | no |  |

Empty result.

## lease

### `lease.register`

Registers a lease. Its id is the `requestId`, so a register sent again answers with the same lease; one that lends something else under the same id fails with `conflict`.

Kind: command · Resend: auto · Who: owner, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `lease` | object | yes |  |

### `lease.resume`

After a reconnect, whether the Host still holds the lease. Fails with `not_found` when it does not. For a `host_tool` lease it also sends the calls that waited while the client was away.

Kind: query · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | "credential" or "host_tool" | yes |  |
| `leaseId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `lease` | object | yes |  |

### `lease.revoke`

Ends the lease. Model calls that need a key from it, or Runs that would call its tools, fail from then on. Sent again, or for a lease that is gone, it answers the same.

Kind: command · Resend: auto · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `requestId` | string | yes | The command runs once per id; send the same id to retry. |
| `kind` | "credential" or "host_tool" | yes |  |
| `leaseId` | string | yes |  |

Empty result.

### `lease.complete`

Answers one `lease.request`, by its `callId`. A key request is answered with `credential` or `error`, a tool call with `result` or `error`. `already_settled` means the request had ended already: answered before, given up, or its lease revoked. A tool call answered with `error` is reported to the model as a call whose outcome is unknown.

Kind: command · Resend: auto · Who: owner, service

No params.

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `status` | "accepted" or "already_settled" | yes |  |

### `lease.call.get`

What the Host recorded for one tool call of this client instance, such as one it was handling when its connection was lost. The Host keeps the latest thousand calls. Fails with `not_found` for a call it does not have.

Kind: query · Who: owner, service

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `callId` | string | yes |  |

| Result field | Type | Always | Notes |
| --- | --- | --- | --- |
| `call` | object | yes |  |
| `call.callId` | string | yes |  |
| `call.leaseId` | string | yes |  |
| `call.tool` | string | yes |  |
| `call.sessionId` | string | yes |  |
| `call.runId` | string | yes |  |
| `call.state` | "waiting" or "sent" or "completed" or "unknown" or "not_sent" | yes | `waiting`: not sent yet, because the client was away. `sent`: sent and not answered yet. `completed`: answered with a result. `unknown`: sent, then the connection was lost, the time limit passed, or the client answered with `error`. `not_sent`: never sent before the time limit passed. |
| `call.updatedAt` | integer | yes | When the state last changed, in UTC milliseconds. |
