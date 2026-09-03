# @kodax-ai/coding

KodaX Coding Agent 的核心实现，包含 coding preset、tool registry、role prompts、repo intelligence、session/runtime middleware、extension runtime 和 workflow integration。源码开发时可从 `@kodax-ai/coding` 引入；npm SDK 用户通常从 `@kodax-ai/kodax/coding` 引入。

## 概述

`packages/coding` 依赖 `llm` 和 `agent`，但不依赖 `repl`。它是“可嵌入的 coding agent”，适合 CLI、IDE、桌面壳或自动化宿主直接调用。

当前内置工具不是早期的 8 个文件工具，而是 50+ 个扁平 tool definition，按职责大致分为：

- 文件与搜索：`read`, `write`, `edit`, `multi_edit`, `insert_after_anchor`, `glob`, `grep`, `undo`
- Shell / Web：`bash`, `web_search`, `web_fetch`
- Agent 协作与控制：`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`, `agent_output`
- MCP：`mcp_search`, `mcp_describe`, `mcp_call`, resource / prompt helpers
- Worktree / user interaction / goal / todo：`worktree_create`, `ask_user_question`, `get_goal`, `todo_update`, ...
- Repo intelligence / LSP：`repo_overview`, `changed_scope`, `module_context`, `lsp_definition`, `symbol_context`, `impact_estimate`, ...
- Construction and self-extension: tool/agent scaffold, validate, stage, test, activate, self-modify helpers

`wait_agent` is a model-facing mailbox yield, not an Actor event reader. It
wakes for scoped Agent messages/completions, root user input, interruption, or
timeout; progress events remain available to UI and SDK event consumers without
resampling the parent model. The tool returns only a wake acknowledgement;
authenticated Agent evidence and structured completion metadata are injected
once at the next safe Runner boundary. Use `list_agents` for tree state and
`agent_output` for a targeted known result. SDK callers that need raw event
replay/long-poll continue to use the Actor event APIs directly.

v0.7.77 adds one shared six-pattern AMA catalog. The Worker composes useful
stages through the existing Actor tools and may attach validated
`quality_strategy` metadata; coding derives a bounded, fact-only
`PatternTrace` for the existing Sidecar. This does not activate Workflow,
create a fixed Agent topology, or add another quality judge.

The same release adds the JSON-only `KodaXShellExecutionContract`. Configured
Runtime sessions and runs inherit the host environment except for fixed
KodaX/Electron execution-control variables, resolve it in the effective cwd,
execute through the same explicit interpreter, inherit the
contract into native children and deterministic evaluators, and bind exact
command grants to the contract fingerprint. The feature is opt-in; callers
without `shellExecution` keep the legacy platform-shell interpreter path.
Model-issued commands therefore support ordinary authenticated development
without a second passthrough configuration.

The same release replaces asynchronous semantic memory prefetch with sparse
foreground intervention after tool/verification failure or committed
compaction. The default path performs deterministic exact selection with zero
selector calls. Inline hosts may opt into `memoryRecallRunner` or construct the
coding-owned forced-tool selector with
`createCodingMemoryInterventionRunner()`.

Auto[LLM] is sandbox-first: a sandbox-completing call is silent, and only a
proven pre-start denial or unavailable sandbox reaches the Runtime-owned LLM
reviewer. Reviewer allow authorizes one host attempt; concern blocks the attempt
without opening an approval prompt. Full Access samples the profile once at
Bash entry, skips sandbox and every approval path, and runs directly unless an
explicit forbidden rule or Codex dangerous-command policy blocks. Legacy Rules
settings normalize to Auto[LLM] and the old rules files are inert.

When `session.autoResume` or `session.resume` is set without an explicit ID,
the coding-runtime middleware requests a broad newest-first list and selects the
first record with `msgCount > 0`; empty ACP/bootstrap placeholders cannot shadow
the latest real conversation. A caller-provided ID always wins.

The v0.7.79 release scopes parallel quality-strategy admission to the same
parent Actor state, so unrelated child/progress updates do not create a false
conflict. Its built-in `kodax_manual` also documents current DeepSeek/custom
provider fields, configured-A2A network authorization, strict Session reads and
export, the evidence-checked ordinary-conversation projection, Runtime
status/diagnostic/coalescing capabilities, and the open Windows descendant-
containment boundary tracked as Issue 256.

The v0.7.80 release makes AMA parallel-first (independent lanes fan out
through ordinary Actor operations while indivisible work stays solo), bounds one
uninterrupted managed tool loop by a 500-iteration panic fuse that resets on
every idle-yield resume (the managed-task lifecycle stays unbounded), and lets
the CLI honor `worker.configuredA2A` from `~/.kodax/config.json` for a
Worker-hosted embedded Runtime. `kodax_manual` documents the same surface.

The v0.7.81 release makes active-Run interrupt delivery referentially durable:
each queued prompt is persisted as its own canonical user entry before
`run.input.delivered` is emitted, and the SDK exposes its `entryId` in both the
event and Run status. Missing canonical persistence or an ambiguous entry fails
the delivery closed. `kodax_manual` documents the same contract.

The v0.7.82 release composes complete live MCP and Host Tool discovery only for
unfiltered search, while an explicit server filter isolates its source. Managed
Stop cooperatively fences later recovery, tool, and Actor work without rewriting
a real completion or independent failure; input admission resolves its Run before
reading mutable Session history, avoiding transient `data_changed` responses.
`kodax_manual` documents these boundaries.

The v0.7.83 release documents and exposes the Windows daemon containment
boundary. A new daemon is assigned to a kill-on-close Job Object before user
code runs; `waitForRuntimeDaemonShutdown()` proves the durable cleanup result
and both daemon and supervisor exit, while `daemonShutdownVerification:1`
allows hosts to require the contract. Legacy daemons are not silently upgraded
in place. `kodax_manual` carries the same shutdown and migration rules; the
remaining Worker owner-lease portion of Issue 256 stays open and is scheduled
for v0.7.87.

The v0.7.84 release carries the Issue 282 Actor settlement-recovery hardening:
progress persistence is bounded to one in-flight write plus one latest
replacement, same-owner Stop can reconcile and retry an unknown settlement,
and terminal Promise facts remain authoritative over fallback callbacks. The
boundary is fail-closed for foreign owners, missing snapshots, and persistent
stores; `kodax_manual` documents the same contract.

The v0.7.85 release adds Session-scoped Runtime Event Journals and the
`sessionEventJournal:1` daemon contract, conversation-first Memory management,
F289/F290 review and lesson pipeline hardening, and the additive experimental
Memory management SDK facade. Terminal Run startup restores terminal status
without replaying complete event journals unless queued input requires it; the
semantic repo-intelligence Worker retires after its idle warm-cache window.
These are intentional coding/Runtime system-code changes covered by the
release regression guides.

The v0.7.86 release hardens Windows sandbox lifecycle handling: ACL owner
markers are durable and cross-profile recovery is serialized; stop waits for
termination proof before ACL recovery; combined cleanup failures remain
observable; and a Shell command is never replayed when its effect process tree
was not proven drained. Exact Windows workspace, Agent Home, filesystem,
toolchain, and network policies form a cross-process policy group; compatible
owners share it until the last owner performs ACL recovery, while incompatible
or pre-start-unavailable containment returns to the already-authorized normal
permission path. The remaining Worker owner-lease portion of Issue 256 is still
open and scheduled for v0.7.87.

The v0.7.89 release adds Issue 293's topology-transparent managed-context
history projection and FEATURE_293's built-in zero-service `web_search`.
Default search attempts are bounded and ordered as DuckDuckGo HTML → Bing RSS
→ Bing HTML; valid empty results stop successfully, while transport/challenge/
parse failures carry fallback diagnostics. `KODAX_WEB_SEARCH_ENDPOINT` remains
an isolated explicit endpoint override. FEATURE_294 materializes daemon-bound
Host Tools only for their leased Run, publishes a cache-stable host capability
catalog line, dispatches registry-first, applies conservative plan-mode
metadata, and removes the surface on revoke. Host Tools never enter the global
registry or leak into unrelated CLI runs; `kodax_manual` documents the same
contract.

The v0.7.90 stabilization release hardens the shared run-scoped tool
materializer: open lease/embedder schemas are normalized to the provider
contract (`type: object`, `properties`, and valid string `required` entries)
before either daemon or embedded dispatch. It also carries the Agent lineage
archive-topology and Runtime workspace-session orderly-retirement fixes; these
are intentional system-code changes with no weaker sandbox fallback.

The v0.7.91 maintenance release adds the SDK-owned Runtime exit settlement
contract and the effective provider output-segment projection. A host can call
`settleKodaXRuntimeExit({ configHome, profile, runtime? })` and receive a
bounded `clean`, `recovered`, or `blocked` result without implementing its own
process/ACL recovery. Live provider output is keyed by logical `responseId`
and physical `providerRequestId`: replacement removes only the active failed
segment, continuation appends, and raw Runtime journals remain the audit
authority. Standalone Bun packaging now embeds lazy provider SDK dependency
graphs. See the [SDK Embedder Guide](../../public_docs/sdk/embedder-guide.md)
for host integration rules.
The same release bounds AskUser and permission interactions with owner
AbortSignals, validates timeout defaults at the Runtime boundary, and keeps
stale prepared Session tails recoverable through an authoritative delta merge
instead of silently losing the latest host state.

The v0.7.94 release keeps `sandboxRuntime:4` and `crashOutcomeModel:2`.
Runtime text tools may overlap a compatible live Bash lease through the same
ASRT workspace policy. Windows sandboxed git trusts authorized repo roots
only (`gitSafeDirectory: authorized-repo-roots`). Linked-worktree and
submodule relationship files are byte-bounded before that trust. Sandboxed
text-helper stdin failures stay on the operation Promise. Scheduled daemon
shutdown reports failed cleanup. A missing workspace directory omits the
concurrent text sandbox at Run start. Runtime advertises `conversationHistory:2`.
Explicit Skill invocation is independent of model discovery. Invalid
`allowed-tools` and malformed hook JSON are diagnosed; `PostToolUse` still
runs if an embedder result observer throws. Run settlement
observes finalization rejections and recovers an admitted `runId` through
`runs.get()` / `runs.await()` instead of replaying `runs.start()`. See the
[SDK Embedder Guide](../../public_docs/sdk/embedder-guide.md)
for host capability requirements.

The v0.7.95 release advances Windows `sandboxRuntime` to `5` and local
`runtimeExitSettlement` to `2`. Windows sandbox cleanup is self-healing: the
machine-global cleanup Job is recoverable across reboots, recovery tickets
repair without operator input, background retries observe the exact daemon and
supervisor process generations, and dynamic worktrees register their cleanup
policy at creation. Same-boot ACL recovery automatically retries a
sandbox-user SID probe before clearing an `unconfirmed-owner` ticket. Learning
locks with stale zero-byte, malformed, or truncated owner data are reclaimed
through unchanged bytes/stat verification, and fullscreen TUI teardown restores
the terminal (Issue 301). Terminal
status persistence failure converges to `unknown`; if the event journal is also
fenced, active Session observations are invalidated for a mandatory resnapshot.
Explicit Skill execution keeps exact `rawUserInput` in canonical history,
rejects multiple active Skill references, and fails closed when a `PreToolUse`
hook crashes or returns malformed JSON. The coding runtime finalizes its
authoritative `KodaXResult` before emitting the public completion signal, so
A2A responses cannot publish an empty successful answer (Issue 302).

The v0.7.96-alpha.7 Windows shell path removes the old command-lifetime filesystem-
effect coordinator. Bash commands, trusted text tools, and different worktree
paths no longer share a KodaX global lock; same-file text CAS and same-path
worktree ordering remain narrow. Native protocol 10 gives every command its own
request, token, pipes, Job, start records, and terminal proof. Warm ACL
admission accepts effective inherited normal-token access; only a missing exact
restricted capability uses `SET_ACCESS` and DACL readback without waiting on a
cross-process target mutex.
Artifact, control-state, legacy-ACL, and stale-deny recovery belongs only to
explicit setup generation 10; generation 8 remains only the one-time legacy ACL
migration proof. Windows `denyRead` returns structured
`unsupported_policy` before target start and creates no execution receipt.
Matching network authority reuses a healthy broker and
keeps it referenced while starting or leased, detaches it only while idle, and
retires a failed readiness attempt. Old `model-filesystem-effects.*` state and
deprecated lease exports are inert migration surfaces and cannot block current
commands.

## 安装 / 导入

```bash
npm install @kodax-ai/kodax
```

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax-ai/kodax/coding';
```

仓库内部开发可直接使用 workspace 包名：

```typescript
import { runKodaX } from '@kodax-ai/coding';
```

## Skill 调用所有权

`runKodaX`/`startKodaX` 的模型路径只把允许模型调用的 Skill metadata 注入
system context；内置 `skill` 工具会再次执行 `disableModelInvocation` admission。
显式用户 slash 解析属于 CLI/REPL 宿主层，SDK 宿主应使用
`@kodax-ai/kodax/repl` 的 `resolveUserSkillInvocation`/`prepareInvocationExecution`，
或直接使用 `@kodax-ai/kodax/skills` 的 `SkillRegistry.invoke()`。不要仅把
`/hidden-skill` 原始文本传给模型并期待它获得显式用户权限。

当显式 Skill 启动 Workflow 或 child Agent 时，coding runtime 只信任宿主传入
的结构化 `context.skillInvocation`。它会把当前 Skill 内容和资源根传给 child；
child objective 自己生成的新 slash 引用仍走受限模型工具，不能扩大权限。

## 单次任务

```typescript
import { runKodaX, type KodaXEvents } from '@kodax-ai/kodax/coding';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onToolResult: (result) => console.log(`[tool] ${result.name}`),
  onComplete: () => console.log('\nDone'),
};

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'auto',
    events,
  },
  'Read package.json and summarize the workspace.',
);

console.log(result.lastText);
```

## 连续会话

```typescript
import { KodaXClient } from '@kodax-ai/kodax/coding';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

await client.send('Read package.json');
await client.send('What workspace packages exist?');

console.log(client.getSessionId());
console.log(client.getMessages().length);
```

## 长运行任务句柄

```typescript
import { startKodaX } from '@kodax-ai/kodax/coding';

const session = startKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'balanced',
    events: {
      onTextDelta: (text) => process.stdout.write(text),
    },
  },
  'Investigate the failing tests.',
);

const result = await session.result;
console.log(result.success);
```

## 常用公开能力

- Run API: `runKodaX`, `startKodaX`, `KodaXClient`
- Tools: `KODAX_TOOLS`, `executeTool`, `registerTool`, `KODAX_TOOL_REQUIRED_PARAMS`
- Repo intelligence: protocol helpers and premium/native mode integration
- Provider policy: capability checks, model hints, fallback helpers
- Adaptive AMA: shared pattern catalog, strategy validation, bounded
  `PatternTrace`, and Sidecar strategy context
- Shell execution: `KodaXShellExecutionContract`,
  `normalizeShellExecutionContract`, `shellExecutionContractFingerprint`, and
  `clearShellExecutionEnvironmentCache`
- Governed memory: `createCodingMemoryInterventionRunner` for host-opt-in
  semantic selection; deterministic intervention remains the default
- Workflows: `createCodingWorkflowBackend`, `runWorkflowFromOptions`, `generateWorkflowFromOptions`, `createWorkflowRunManager`, `createWorkflowLifecycleController`, built-in/saved workflow discovery
- Events: `KodaXEvents.onSidecarMessage` surfaces Sidecar Verifier `revise` / `blocked` messages for SDK and headless hosts
- Types: `KodaXOptions`, `KodaXResult`, `KodaXEvents`, `KodaXSidecarMessageEvent`, `KodaXToolExecutionContext`, session and task types

## 构建与测试

```bash
npm run build -w @kodax-ai/coding
npm test -- packages/coding/src
```

## License

[KodaX-AI Fair Core License (KAI-FCL) 1.0](LICENSE). KodaX 0.7.70 and later
are source-available / fair-core, not OSI open source. Commercial or managed
use requires KodaX-AI authorization. Earlier released Apache-2.0 copies keep
their existing license.
