# Run KodaX inside your own process

This guide is for a developer who runs the KodaX agent inside their own Node
process, with no Host. Your code calls the agent directly, owns its storage,
and answers its tool approvals. To talk to a Host instead, see
[host-client.md](host-client.md). For the big picture, see
[overview.md](overview.md). Subpaths not listed below are covered in
[optional-modules.md](optional-modules.md).

## Imports

| Entry | What it holds |
|---|---|
| `@kodax-ai/kodax` | The run entries, `allowAll`, workflows, agents, `FileSessionStorage` |
| `@kodax-ai/kodax/coding` | The same run entries, without the REPL extras |
| `@kodax-ai/kodax/agent` | The agent framework and the diagnostic sink |
| `@kodax-ai/kodax/llm` | Providers, model capabilities, credential checks |
| `@kodax-ai/kodax/mcp` | `McpManager` and the MCP transport layer |
| `@kodax-ai/kodax/skills` | `SkillRegistry`, Skill loading, the variable resolver |
| `@kodax-ai/kodax/session` | `createSessionManager` and session readers |

## Choose an entry

Every entry runs the same managed root Run. They differ in how you drive it.

| You want | Use |
|---|---|
| One prompt, one result | `runKodaX(options, prompt)` |
| One prompt you can stop or re-route while it runs | `startKodaX(options, prompt)` |
| A chat that keeps its history between calls | `new KodaXClient(options)` |
| To classify every failure yourself | `runManagedTask(options, prompt)` |
| Many tasks with dependencies between them | `createKodaXTaskRunner` with `runOrchestration` |

```ts
import { allowAll, runKodaX } from '@kodax-ai/kodax';

const result = await runKodaX(
  { provider: 'anthropic', events: { beforeToolExecute: allowAll } },
  'Summarize the README in this folder.',
);
console.log(result.lastText);
```

`startKodaX` returns a `RunningSession` right away. Its `result` promise
settles like `runKodaX`. `setProvider`, `setModel` and `setReasoning` apply on
the next turn. `abort(reason)` stops the run, and so does `options.abortSignal`.
`KodaXClient` keeps the session id, the messages and the token snapshot
between `send(prompt)` calls. `getSessionId()`, `getMessages()` and `clear()`
read or reset that state. `Client` is the same class.

`createKodaXTaskRunner({ baseOptions })` builds a runner for
`runOrchestration({ tasks, workspaceDir, runner })`. Each task has an `id`, a
`title`, a `prompt` and optional `dependsOn`. A task's `budget.maxIter`,
`provider` and `model` override the base options. At most `maxParallel`
(default 1) tasks with `execution: 'parallel'` run at once.

## Read the outcome

`runKodaX` resolves for every expected outcome. It throws only for invalid
input and for context capacity errors. `runManagedTask` throws for failures
too.

| Field | Meaning |
|---|---|
| `success` | `false` when the final signal is `BLOCKED` or the run failed |
| `lastText` | The last assistant text |
| `signal` | `COMPLETE`, `BLOCKED` or `DECIDE`, when the agent gave one |
| `failure` | Set when a provider or local error ended the run |
| `limitReached` | `true` when the run hit its turn limit |
| `interrupted` | `true` when the run was stopped |
| `sessionId`, `messages` | The session and its history, kept on failure too |
| `usage`, `contextTokenSnapshot` | Token use for the run |

In `failure`, `safeMessage` is a fixed KodaX summary that never holds upstream
text. Show it to end users. `detail` is the underlying reason, such as the
provider's response. It has credentials redacted and is cut to 1,000
characters. Log it. `errorClass` names the category, such as `rate_limit`,
`provider_overloaded` or `local_execution_error`. Branch on it. `provider`,
`model`, `httpStatus`, `retryable` and `retryAfterMs` are set when known.

`maxIter` bounds the root agent's model turns. Without it, only a safety fuse
of 500 turns applies. When the bound is hit, `limitReached` is `true`.

## Approve tool calls

Without `events.beforeToolExecute`, only tools that read run. The session-only
tools also run: `todo_create`, `todo_update`, `create_goal`, `update_goal` and
`skill`. Every other call is refused. The model gets a tool result that says
no approval callback is set. The process gets one `process.emitWarning` with
the code `KODAX_TOOL_APPROVAL_MISSING`. Pass `allowAll` to run every call.

Your callback gives one of three answers:

- `true` runs the call.
- `false` cancels the call, as if the user stopped it.
- A string blocks the call. The model sees the string as the tool result.

```ts
import { runKodaX } from '@kodax-ai/kodax';

await runKodaX({
  provider: 'anthropic',
  events: {
    beforeToolExecute: async (tool) =>
      tool === 'bash' ? 'Shell commands are not allowed here.' : true,
  },
}, 'Fix the failing test.');
```

- Child agents, Skills and workflow agents get the same callback.
- An extension `tool:before` hook can ask for approval. The ask goes to
  `events.requestToolApproval`. Without that callback, the call is blocked.
- `context.resolveShellPermissionMode` only describes the mode to the model.
  It approves nothing.
- Guardrails in `options.guardrails`, such as one from
  `createAutoModeToolGuardrail`, only restrict. A call must still pass your
  approval callback.

KodaX sends its other warnings and errors to a diagnostic sink, not to the
console. Set one with `setKodaXDiagnosticSink` from `@kodax-ai/kodax/agent`.
Without a sink, diagnostics are silent unless `KODAX_DIAGNOSTICS_STDERR=1`.

## Keep sessions on disk

A run saves its session only when `session.storage` is set. A `session.id`
alone saves nothing. KodaX reports that case once through the diagnostic sink.

```ts
import { createSessionManager } from '@kodax-ai/kodax/session';

const sessions = createSessionManager();
const options = {
  provider: 'anthropic',
  events: { beforeToolExecute: allowAll },
  session: { id: 's_support_42', storage: sessions.storage },
};
await runKodaX(options, 'Find where the config is loaded.');
await runKodaX(options, 'Now add a test for it.'); // same history
```

- Create one session manager per process and reuse it.
- A run with a stored `session.id` loads that history before it starts.
  `session.initialMessages` supplies the history directly instead.
- `session.resume` or `session.autoResume` without an id picks the newest
  non-empty session. Set `context.gitRoot` to limit it to one project.
- A failed save is reported as an error diagnostic. The run continues.
- `createSessionManager({ sessionsDir, configHome })` moves the files.
- The manager also reads and edits stored sessions: `listSessions`,
  `loadSession`, `readFullTranscript`, `forkSession`, `rewindSession`,
  `compactSession`, `archiveSession` and `deleteSession`, among others.

## Shape the prompt

- `context.agentProfile.instructions` goes at the start of the prompt. It
  replaces only the KodaX identity. The rest of the KodaX guidance stays. The
  result echoes `agentProfile` back.
- `context.systemPromptOverride` goes at the start and replaces the KodaX
  identity and guidance. Environment, memory and trust sections still follow.
- `context.prompt` is a prompt spec. Its entries go into the conversation's
  run context, not the system prompt.
- `selfManual` adds your product's topics to the `kodax_manual` tool.

```ts
import { allowAll, runKodaX } from '@kodax-ai/kodax';

await runKodaX({
  provider: 'anthropic',
  events: { beforeToolExecute: allowAll },
  context: {
    agentProfile: { surface: 'support', instructions: 'You are Acme Support.' },
    prompt: { context: [{ key: 'tone', kind: 'rule', text: 'Answer in two sentences.' }] },
  },
}, 'Why does login fail?');
```

The prompt spec has these rules:

- `kodaxGuidance: 'omit'` drops the KodaX working style. Tool teaching and
  project rules stay. The default is `keep`.
- A `rule` is followed like a project rule and reaches child agents that
  write. A `reference` is evidence for the root agent only.
- Keys match `^[a-z0-9][a-z0-9._-]{0,63}$` and are unique. Text is not empty.
  All entries' text together is at most 8,000 characters. Unknown fields fail.
- Each run's entries replace the last run's. An entry you leave out is
  retired.
- A bad spec throws an error with `code: 'invalid_params'`.

`selfManual` takes `productName`, `topics` and `baseTopics`. A topic has an
`id`, `title`, `summary` and `body`. A topic with a KodaX topic's id replaces
it. `baseTopics: []` drops all KodaX topics. To limit the tools the model sees, set `context.excludeTools` or
`context.toolVisibilityPolicy`. The policy gets `{ name, sideEffect,
planModeAllowed }` and returns `true` to show the tool.

## Models and providers

These come from `@kodax-ai/kodax/llm`.

- `getModelCapabilities(provider, model)` describes a built-in model.
  `resolveModelCapabilities` also checks custom providers.
- `getProviderModelDescriptors(provider)` lists a provider's known models.
  `listAllModelCapabilities()` lists every known model.
- `resolveWireEffort({ provider, model, desiredEffort })` returns the effort
  KodaX will send, and whether it was adjusted.
- `listProviderModels(provider)` returns the provider's built-in model list.
  It sends no request. Its `source` is `static` or `failed`.

A capabilities record holds `contextWindow`, `maxOutputTokens`,
`supportsThinking`, `reasoningCapability`, `multimodalSupport`,
`cacheCapabilities` and `toolCapabilities`. `maxOutputTokens` is what KodaX
requests, not the model's upper limit.

`verifyProviderCredential(provider, { timeoutMs, signal })` checks a key with
a small request. When `ok` is `false`, `error` is `unauthorized`, `network`,
`timeout`, `unsupported`, `unconfigured`, `server_error`, `rate_limited` or
`unknown`. `message` is at most 240 characters. `approxTokensSpent` and
`durationMs` say what the check cost.

## MCP servers

An in-process run reaches MCP servers through an extension runtime.

```ts
import { allowAll, createExtensionRuntime, registerConfiguredMcpCapabilityProvider, runKodaX } from '@kodax-ai/kodax';

const runtime = createExtensionRuntime();
await registerConfiguredMcpCapabilityProvider(runtime, {
  files: { type: 'stdio', command: 'mcp-server-filesystem', args: ['/repo'] },
});
await runKodaX({
  provider: 'anthropic', extensionRuntime: runtime, events: { beforeToolExecute: allowAll },
}, 'List the files in /repo.');
await runtime.dispose();
```

The model then sees `mcp_search`, `mcp_describe`, `mcp_call`,
`mcp_read_resource` and `mcp_get_prompt`. Only `mcp_search` and
`mcp_describe` run without an approval callback.

For a settings screen, build an `McpManager` with `createMcpManager(servers)`
from `@kodax-ai/kodax/mcp`. `listServers()` returns one status row per server.
`startServer(id)` and `stopServer(id)` connect and disconnect one server.
`getServerLogs(id)` returns its status and last error. `listTools(id)` returns
its tools, and `getCatalog(id)` adds resources and prompts. `dispose()` closes
every server. A server's `status` is `idle`, `connecting`, `ready`, `error` or `disabled`.
A manager does not see config changes, so build a new one after an edit. To
read and write the servers in the KodaX config, use `listMcpServers`,
`upsertMcpServer` and `removeMcpServer` from `@kodax-ai/kodax/repl`.

## Skills

A run finds Skills from `context.gitRoot`, or else `context.executionCwd`, or
else the current directory. Pass `context.skillRegistry` to supply your own
`SkillRegistry`. The model loads a Skill with the `skill` tool. A Skill can
hold `` !`cmd` `` blocks. KodaX replaces each block with the command's output.

`options.skillDynamicContext` decides how those commands run:

| Setting | Effect |
|---|---|
| `{ execute: (command, cwd) => Promise<string> }` | Your function runs each command. Throw to refuse one. |
| `{ disable: true }` | Every command is refused. |
| Not set, with an approval callback | A built-in list of safe read commands runs, with a 5-second timeout. |
| Not set, without an approval callback | Every command is refused, and so are the Skill's hooks. |

To expand a Skill yourself, call `createResolver(context)` from
`@kodax-ai/kodax/skills`. It returns an `IVariableResolver`, whose
`resolve(content, args, context)` fills `$ARGUMENTS`, `$0`, `$1` and the
other variables. The context needs a `workingDirectory`. Its
`executeDynamicContext` and `disableDynamicContext` fields work like the
options above. `resolveSkillContent(content, args, context)` does it in one
call.

## Agents

You can add named agents that the model starts as children. A markdown agent
is a file in `<configHome>/agents/` or `<project>/.kodax/agents/`. A project
agent wins over a user agent with the same name.

```markdown
---
name: db-reviewer
description: Reviews database migrations for safety
tools: [read, grep]
---
You review database migrations. Check locking and backfill cost.
```

- `name` and `description` are required. A file without front matter or a
  `name` is skipped. A missing `description` is reported as a failure.
- `provider`, `model`, `effort`, `tools` and `skills` are optional.
- Call `loadAgentsFromMarkdown({ cwd, configHome })` before the run. It
  returns `{ loaded, failed }`. `discoverMarkdownAgents` lists the files
  without registering them.

An extension can register an agent when it activates:

```ts
export default async function activate(api: KodaXExtensionAPI) { // from '@kodax-ai/kodax'
  await api.registerAgent('python-reviewer', {
    instructions: 'You review Python code for type hints.',
    description: 'Python type-hint reviewer',
  });
}
```

`registerAgent` returns a promise of a dispose function, so await it. It
throws when the agent is rejected, and that stops the extension's load.

The model starts a registered agent with `spawn_agent` and its `agent_id`.
`listCodingDispatchableAgents` and `resolveCodingDispatchableAgent` read the
same list from your code. They return descriptions, not runnable agents.

## Workflows

A workflow is a script that runs many agents. The model gets the
`run_workflow` tool only when you set all three of `agentMode: 'ama'`,
`workflowRunsBaseDir` (the directory for run records) and
`context.workflowIntent: 'explicit'`. KodaX sets that itself when the prompt
asks for a workflow. Your code can also start a workflow itself.

```ts
import { createWorkflowRunManager, generateWorkflowFromOptions } from '@kodax-ai/kodax';

const generated = await generateWorkflowFromOptions({ request: 'Review src/auth', options });
if (generated.kind === 'generated') {
  const run = createWorkflowRunManager().startFromOptions({
    module: generated.module, scriptSnapshot: generated.scriptSnapshot,
    args: {}, options, runId: 'wf-1', runDir: '/data/workflows/wf-1',
  });
  await run.done;
}
```

`generateWorkflowFromOptions` returns `kind: 'generated'` or
`kind: 'declined'` with a `reason`. `authorWorkflowViaWorker({ request,
options })` lets a full agent write the script instead. It needs
`workflowRunsBaseDir`.

Process events tell a UI how a run is doing. `events.onWorkflowProcessEvent`
sends `workflow_started`, `workflow_updated` and `workflow_finished`, each with
a snapshot. A run manager's `subscribeWorkflowProcess(listener)` does the same
for runs you start. `events.onWorkflowAgentDigest` reports a child agent's
summary, and again each time it changes or the child ends.

`createWorkflowLifecycleController({ runManager, runBaseDir })` controls runs:
`stopWorkflow`, `pauseWorkflow`, `resumeWorkflow`, `readWorkflowResult`,
`deleteWorkflowRun` and `pruneWorkflowRuns`. `workflow.maxConcurrency` limits
parallel agents. The default is 8.

### Routing and cost

A workflow child can ask for a `fast`, `balanced` or `deep` model. Map the
tiers with `modelTiers: { fast: { provider, model }, deep: { provider, model } }`.
`balanced` uses the parent's model. A child that writes never gets the `fast`
model. A child's route facts say what happened. `requestedTier` is what it
asked for. `tierOutcome` is `applied`, `balanced-parent`,
`fast-write-ineligible`, `unconfigured`, `shadowed-by-selector` or
`inherited`. Treat a missing field as unknown.

Each finished run writes `run.json` in its run directory. Its
`efficiencyReport` holds token totals and child counts. Trust
`totalModelTokens` only when `tokenCoverage.ok` is `true`.

## Context compaction

KodaX compacts the conversation on its own when it nears the context window.
It is always on. In `options.compaction`, `triggerPercent` is the fill level
that starts it. The default is 75, kept between 15 and 90. `triggerTokens`
adds an absolute threshold. `contextWindow` overrides the window, for models
KodaX does not know. `events.onContextCompactionFinished` reports each compaction.
`events.onCompactedMessages` gives you the new history. If it returns a
promise, KodaX waits for it.

## Agent mailbox and events

The model waits for its child agents with `wait_agent`. The wait ends on a
child's message or completion, new user input, a stop or a timeout. The
timeout is 10 seconds to 1 hour, 2 minutes by default. Child progress does
not end the wait, so a busy child does not wake the model. To show child
activity in your UI, use the event callbacks instead. An event's `childAgentId` and `childAgentName` say which agent it came from.

## Shell execution

`context.shellExecution` sets how shell commands run. Without it, commands use
the platform shell and `process.env`. With it, KodaX reads the environment
through the shell you name, then runs each command in that shell. Set
`version: 1`.

- `shell.kind` is `pwsh`, `powershell`, `cmd`, `bash` or `zsh`.
  `executable`, `args` and `profile` are optional.
- `environment.inherit: 'filtered'` keeps your process's variables. `'none'`
  keeps only what the OS needs. `set` adds variables. `denyPatterns` removes
  them by name.
- `environment.setup` is shell code that runs before the environment is
  read, for example to activate a version manager.
- On Windows, `environment.windowsPath: 'registry'` re-reads `PATH` from the registry.
- `cache.ttlMs` sets how long a resolved environment is reused. `0` turns the
  cache off. Change `cache.refreshToken` to force a new one.

`clearShellExecutionEnvironmentCache()` drops every cached environment.
