# KodaX High-Level Design

> Last updated: 2026-09-01
>
> Current published baseline: `v0.7.96-alpha.3`
> (`@kodax-ai/kodax@0.7.96-alpha.3`; Windows `sandboxRuntime:6`,
> `runtimeExitSettlement:2`, `crashOutcomeModel:2`;
> npm publication remains manual)
> Source candidate: `@kodax-ai/kodax@0.7.96-alpha.5` (FEATURE_297 + Issue 326
> sandbox concurrency correction; not tagged)
>
> This HLD is intentionally current-state only. The old pre-v0.7.43
> chain/harness model has been removed from this active design document because
> it no longer describes the runtime.

## 1. System Overview

KodaX is a TypeScript monorepo published as one npm package with multiple SDK
subpaths. Source code is organized into four workspace packages:

```text
packages/
  llm/      provider abstraction, streaming, capability metadata
  agent/    generic Agent/Runner, orchestration, skills, MCP, tracing, workflow
  coding/   coding-agent preset, tools, prompts, sessions, workflows
  repl/     Ink terminal UI, config, commands, session management surface
src/        CLI entry point and binary-facing bootstrap
clients/    optional external clients and protocol adapters
benchmark/  eval harness, datasets, and prompt-change rules
```

The published package is `@kodax-ai/kodax`. It exposes the root API plus twelve
SDK subpaths: `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`,
`/mcp`, `/session`, `/runtime`, `/sandbox`, `/a2a`, and
`/experimental-memory`.

The v0.7.89 coding plane keeps built-in web search local and bounded: the
default transport sequence is DuckDuckGo HTML, Bing RSS, then Bing HTML, while
an explicit endpoint remains isolated. Daemon host bridges expose leased Host
Tools through run-scoped definitions and a cache-stable capability catalog
block; registry-first dispatch, revoke handling, side-effect metadata, and A2A
authorization prevent cross-run or cross-provider leakage. Ordinary history
projection treats replaceable managed context as topology-transparent and
rebuilds pre-v4 page caches. Shell and sandbox boundaries are unchanged.

The v0.7.90 hardening keeps the same boundary while making failure recovery
explicit. A workspace session that times out fails its pending RPC and closes
orderly before replacement; cleanup receives the reset-grace budget, and daemon
diagnostics preserve Error causes. Lineage/archive maintenance retains direct
clone predecessors, while the coding materializer supplies provider-valid object
schemas for run-scoped tools.

The v0.7.91 Runtime adds a durable exit-settlement transaction at the SDK
boundary. It records the exact daemon owner and boot identity before stop,
reuses the existing owner-policy fence, and only repairs identity-scoped
process/Job/ACL residue after containment and shutdown evidence pass. A
same-boot POSIX ambiguity is retained as a blocked ticket rather than guessed
or force-signalled. The live output projection similarly separates logical
responses from physical provider requests, so Runtime snapshots and raw
journals serve different, explicit authorities.

The same Runtime owner also bounds user interaction. AskUser and permission
callbacks receive an AbortSignal tied to the authoritative request; separate
`userInputTimeoutMs` and `permissionTimeoutMs` values are validated before
startup, and the SDK helper resolves permission UI through the Runtime rather
than trusting a late dialog result. Interactive hosts recover a stale prepared
Session tail with a full authoritative delta, while background persistence
errors remain visible diagnostics.

The v0.7.92 Runtime treats filesystem-effect coordination as an operation
lease, not a process-lifetime lock. Queue tickets share a token with the exact
coordinator lock and heartbeat while waiting. A stale same-process ticket is
reclaimed only when that token no longer owns the lock file. Effect release
writes a token-scoped marker first so a later transaction can drop the matching
settled owner while the shared daemon PID remains alive. An exact active lock
or an unproven process tree stays fail-closed. Managed Runs persist the
canonical Session before publishing completion; repo-intelligence and task-file
projections are asynchronous maintenance. Runtime uses the managed executor
Promise, not the legacy `onComplete` callback, as terminal authority. Hosts
require `sandboxRuntime:4` and `crashOutcomeModel:2`; an idle older daemon may
be replaced, and a busy one fails closed. Resume reconstruction derives the
TUI transcript from canonical Session `messages` first; `uiHistory` may overlay
display metadata or append UI-only entries, but cannot hide ordinary
conversation. Presentation-only synthetic completion events stay host-owned
when a non-empty CLI `uiHistory` exists. This slice does not close Issue 256's
lost-ancestor descendant-closure boundary.

The v0.7.93 Runtime keeps those contracts and closes three follow-up gaps.
A durable Windows `failed` shutdown outcome ends the orderly daemon-exit wait
and uses the existing exact recovery path immediately. After a verified boot
change, shared previous-boot ACL markers may be recovered under the machine
lock without entering Setup or elevation. Provider Stop classification uses
isolated Anthropic/OpenAI abort-class identity so a typed SDK abort is not
redacted as a credential failure. Same-boot ACL and POSIX recovery remain
fail-closed.

The v0.7.94 filesystem-effect refinement separates sandboxed text sinks from
host-privileged sinks. Runtime `write`, `edit`, `multi_edit`,
`insert_after_anchor`, and `undo` execute their snapshot and commit through the
same ASRT workspace policy, keep only a normalized-path FIFO, and may therefore
run while a compatible background shell remains alive. A standalone Coding
consumer with no Runtime capability retains the existing direct lease. A
covered workspace target fails closed when the Runtime capability is
unavailable; non-workspace targets and all other host sinks retain the direct
lease. Helper stdin failures stay on the text-mutation operation Promise.
Linked-worktree and submodule relationship files are read through strict byte
bounds before git trust. Shell policy owners and namespace owners remain in the
coordinator so incompatible Windows ACL transitions and worktree path-alias
changes are still fenced.
KodaX-created linked worktrees are added to the owning Session's exact sandbox
policy before their paths are returned to the model. The roots persist across
Runs, must still prove the same Git common-directory backlink when restored,
and are revoked after removal; unrelated sibling directories never inherit the
workspace policy from a naming convention alone. A Session rooted in a real
submodule derives that common directory only from a byte-bounded
`.git/modules/.../config` `core.worktree` backlink to the exact workspace;
candidate roots still have to prove linked-worktree `gitdir` and `commondir`
backlinks.

FEATURE_295 replaces that coupling in v0.7.96 on Windows, Linux, and macOS. Trusted `write`,
`edit`, `multi_edit`, `insert_after_anchor`, and `undo` execute in the KodaX
Runtime through a narrow in-process filesystem primitive. Final handle-derived
identity, no-follow traversal, a stable per-canonical-namespace kernel lock, locked
revision CAS, flush, and atomic replace constrain the write. The primitive has
no dependency on ASRT, shell setup, a runner, workspace sessions, cleanup,
reset, owner, or poison state; text-tool policy is a trusted-host boundary, not
OS-token sandbox enforcement. Windows shell/process execution is a separate
native host/runner protocol: ASRT provides network/account services, the
runner supplies a restricted policy-capability token (with exact write
capabilities plus shared-group read access and the dedicated account, per-launch logon, and Everyone
compatibility SIDs, matching current Codex), uses a nonce-bound policy-capability private desktop, and creates the target suspended
inside a no-breakaway, kill-on-close Job before `Ready` and resume. Linux and
macOS shell commands use per-command ASRT bubblewrap/Seatbelt preparation with
no KodaX workspace-session owner. Windows v2 setup reuses a healthy fixed
account SID across setup versions and records the protected protocol generation
before shell admission; only damaged identity state rotates.
The Windows private desktop uses a full-policy capability, while persistent
filesystem ACEs use the setup's stable filesystem nonce + canonical-root +
`allowRead`/`allowWrite`/`denyWrite` clause capabilities. Every root keeps the
same policy-independent ACE set; the restricted token activates only the
capabilities required by that command. The restricted target's enabled traverse privilege reaches exact
allowed roots without persistent private-ancestor ACEs or profile-DACL
propagation. Because `WRITE_RESTRICTED` does not enforce restricting SIDs for
reads, Windows per-command `denyRead` fails closed as `unsupported_policy`
before setup, DACL mutation, or target start. Windows setup generation 9
upgrades a healthy generation-8 identity in place without replaying the
generation-8 legacy ACL migration proof. One setup-only elevated native parent
receives a small explicit base64 envelope, validates its versioned digest-bound
`installing` marker inside the protected control directory, and synchronously
converges NUL compatibility plus profile read capabilities. The setup caller
atomically publishes the ready marker only after that parent succeeds; no helper
overlaps ordinary admission, and system TMP is authorized on demand rather than
prewarmed;
 ordinary command admission never invokes UAC, that migration, or
 revokes shared ACL state. New sandbox policy grants broad
 host reads instead. Native requests no
 longer add the protected artifact-cache root as a redundant `denyWrite` root,
 so upgrades neither grow those historical residues nor conflict with the
 control verifier. Existing cache denies remain unchanged: owner/protection,
 masks, flags, and SID shapes cannot prove individual ACE provenance.
This setup-9/stable-ACL boundary advances `sandboxRuntime` to 9 so a newly linked
client replaces an idle v8 daemon and refuses to mix with a busy one.
If the resolved Agent Home is itself below a granted system-TMP root, the
Runtime creates the five fixed host-owned internal directories before adding
them to `denyWrite`. This is local directory materialization, not setup,
capability convergence, or a synchronization boundary; it prevents native root
validation from rejecting a non-existent deny root on first launch.
The protected control directory is doctor-verified and setup-repaired only
after the sandbox SID is idle. Repair can retire an expired dead-PID request or
a dead-owner terminal record that already proves Job drainage; live,
unexpired, malformed, unknown, and deny-recovery records remain fail-closed.
On Windows, an embedded release manifest pins the text/shell sidecar protocols
and hashes plus the ASRT release version and hash. Verified bytes are staged in
a protected content-addressed LocalAppData store; the ASRT source is checked
before materialization and the staged executable is rechecked before broker
startup. Text remains Host/SYSTEM-only, the shell artifact grants read/execute
to the dedicated sandbox group SID, and ASRT grants local Users read/execute;
none grants sandbox write/delete. Unix keeps its binding in a protected Agent
Home cache and loads it through a digest-verified no-follow descriptor below a
UID-owned mode-`0700` state root, which sandboxed shell policy cannot write. The
fixed bootstrap provisioner never receives model text or shell stdin.
Windows uses a host-SID private mutex; Unix uses a fixed per-UID system
coordination root and private inode carrying kernel `flock`, no-follow
descriptor walking, file/parent `fsync`, and rename. Atomic replacement is the
 commit point; any Unix-only durability/rollback uncertainty after it carries a
 complete receipt and is surfaced as `text_mutation_commit_uncertain`, never as
 an ordinary retryable I/O failure.
Neither platform treats an on-disk file as persistent lock ownership.
Windows v2 shell invocations do not own a command-lifetime filesystem-effect
lease. Arbitrary shell writes remain normal OS races and are not serialized by
the text CAS.
Protocol 9 binds every request to the protected setup marker's path and digest.
The native host holds a non-delete-sharing marker handle through durable target
`Started`, so setup rotation and command start are linearized without a global
admission lock. A warm exact ACL policy is read-only; effective inherited
normal-token grants are accepted, while a missing exact restricted capability
is converged using `SET_ACCESS` and DACL readback without a cross-process target
mutex. Setup alone provisions artifacts/control state and performs legacy or
full crash recovery. Unsupported Windows `denyRead` never reaches ordinary
command admission; setup alone may retire pre-cutover receipts.
Each command otherwise owns independent pipes, token, Job,
resume/started records, and terminal proof. Exact-authority
network brokers remain reusable and retire a failed readiness attempt.
When target-start or terminal proof fails, cleanup immediately detaches that
broker generation from reuse. Existing holders finish against the detached
generation, while new commands create a replacement without waiting or stopping
those holders. Detached generations remain in live-capacity accounting until
their processes exit, preventing rolling replacement from overcommitting ASRT's
fixed port pool. Each native startup/control phase is bounded to 15 seconds
without shortening the command deadline; caller-local abort or a shorter caller
deadline does not retire a healthy shared broker. A cleanup-proven pre-Resume failure may re-enter the existing
permission boundary, while started or uncertain work is never replayed.
The final Windows target is creation-time contained. Issue 307 separately
tracks the ASRT-owned shared-account runner's pre-main window, which also
exists in current Codex and requires an upstream spawn boundary to eliminate.

The v0.7.94 Runtime recovery boundary does not change
capability versions. Run finalization owns and observes
its complete persistence chain. A durable terminal status wins over a failed
event append; failure to persist either authority produces an explicit
`unknown` lifecycle error and keeps Session execution fenced. Sandbox and
managed-child cleanup errors are observed and recorded instead of escaping as
process-global Promise rejections. Invalid Skill `allowed-tools` entries and
malformed hook JSON are diagnosed; `PostToolUse` still runs if an embedder
result observer throws. The v0.7.95 release additionally reconciles a
status-lock cleanup error after a terminal commit only when the reread status
exactly equals the local proposal; that path still emits one terminal event,
while any different authority wins.

Daemon transport reports connection facts independently from Run outcome.
Clients receive a close code, `connectionId`, and `reconnectable` marker, while
durable Run status remains the authority for `daemon_crashed`. A host that has
received a `runId` reconnects by creating/attaching a replacement Runtime and
querying then awaiting that exact Run. Reissuing `runs.start()` is forbidden
because it can duplicate provider and tool effects. Classified failures produce
one bounded `failureDetail` at the Runtime failure boundary. Terminal failure
events, settlement `run.updated`, result/status, and Session diagnostics reuse
that fact so classification cannot
drift. Stable KodaX codes are separate from optional upstream codes/request
IDs. Display text is generated from KodaX-owned templates, so provider response
bodies, credentials, prompts, raw header collections, URLs, local paths, stacks,
and raw errors are not copied across the boundary; only allowlisted metadata is
extracted.

For a Windows daemon Runtime, startup is a three-part process boundary:
PowerShell creates the daemon suspended, assigns it to a kill-on-close Job
Object, and resumes it; an out-of-Job supervisor waits for daemon exit and then
for the Job's active-process count to reach zero. The SDK and CLI consume that
boundary as a verified shutdown contract rather than treating PID exit alone as
completion.

Actor settlement is a separate durability boundary. Progress observations are
coalesced once across the complete controller tree. Terminal settlement starts
its five-second canonical deadline only after a phase-aware store admits the
save. Actor mutation order and process-local storage dequeue apply backpressure
without consuming the writer-lock budget; the store eligibility bound begins
only after dequeue, so either a long local queue or a legal Session writer-lock
wait cannot become commit ambiguity. Queued and
pre-commit work can be cancelled before file replacement and must not write
late; an in-flight canonical replacement remains fail-closed, while a returned
replacement error is resolved by authoritative persisted-shape snapshot readback. Canonical success
releases Actor state while cache, watermark, topology, and lock maintenance stay
serialized and surface only as degraded diagnostics if they later fail.
The readback compares the JSON-persisted Actor snapshot, not revision alone. A terminal
settlement also monitors the active predecessor save and fences a predecessor
whose canonical replacement remains unresolved. Same-owner repair reuses the
same phased boundary, so its queue, lock, and post-commit waits are not charged
to the five-second canonical deadline. On unknown durability, Runtime
fail-closes root and child work, suppresses later effects, and automatically
reloads only an exact same-owner snapshot before durably quiescing remaining
turns. Owner conflicts and unresolved storage remain unknown rather than being
treated as successful cancellation. Same-owner repair and abort close effect
admission; the logical convergence boundary also waits for each exact tool
execution admitted before the fence. The Session route then releases without
waiting for the old executor Promise. An abort-ignoring provider remains unable
to publish callbacks or begin new Runtime-mediated effects. Ordinary healthy
after-turn input still defaults to coding mode; mode
inheritance is reserved for work that actually drains behind durability repair.

The workspace sandbox permits broad Agent Home reads, including credential,
security-config, and Runtime paths, without a preflight review. At a proven
host boundary, concrete credential reads and credential/security-control
mutations become Auto[LLM] reviewer facts; a generic sensitive label alone is
not a reason to deny. Ordinary Agent definitions, Sessions, tool results, and
intermediate artifacts remain working data. These concrete home-root and
Runtime-control-plane effects are evidence for Auto[LLM], not an Agent-Home
special hard boundary: Full Access skips that reviewer exactly as documented.
Only explicit administrator `forbid` policy and the narrow critical-effect
fallback remain non-bypassable. Upgrade cleanup still quarantines legacy
unauthenticated `processes/children` records without signaling a process.
The v0.7.85 containment path used ASRT workspace sessions, a per-effect Job,
policy-owner fallback, and a cross-process filesystem-effect lease. FEATURE_295
supersedes that path for shell and controlled text tools; Issue 326 also removes
it from worktree lifecycle. Worktree calls retain only same-exact-path local
ordering and otherwise use Git's own cross-process locks. The current
v0.7.96 boundaries are defined above: trusted text is host-authorized and never
enters the shell graph, while Windows shell uses per-command native token/Job
containment and Linux/macOS use one ASRT command wrapper per invocation. Legacy
sensitive-root guards and pre-cutover execution-deny receipts are retired by
setup-only upgrade reconciliation. Dynamic Windows `denyRead` is reported as
unsupported before target start; POSIX keeps the ASRT policy field.
Learned Skill discovery likewise treats local and remote project identities as
distinct physical roots, searches each applicable root, and directs lifecycle
mutations back to the store that owns the discovered record.

The v0.7.85 Runtime owns one event journal per Session. Events carry a
`{sessionId, journalEpoch, seq}` cursor, replay is scoped by `sessionId` or
`runId`, and A2A maps each Task to one Runtime Session. Journal retention,
failure latches, and per-Run attribution fail closed when cursor or index
evidence is malformed. The Memory surface is likewise host-governed:
conversation-first explicit mutations use stable semantic claim keys and a
host-owned handled-operation marker, while exceptional inferred changes remain
reviewable. F289/F290 drain and lesson pipelines are bounded and observable;
the experimental SDK adds only the management facade supported by the supplied
controller.

The v0.7.86 hardening layer makes Runtime owner recovery atomic and
fail-closed: inline fences are removed only when process identity is proven
dead, and owner/learning locks carry an OS process-start identity so PID reuse
cannot preserve stale ownership. Windows sandbox effects now require a
termination proof before ACL recovery; durable owner markers and a shared
recovery lock serialize one active sandbox owner per KodaX home across Runtime
profiles. Missing termination proof fences later filesystem effects and never
replays a possibly side-effecting command. POSIX workspace admission initializes
fresh `KODAX_HOME` policy roots before identity capture, waits only for its
workspace-local warm-up within the Shell abort/deadline, and retires a cached
session when lease cleanup fails.

## 2. Layering

```text
CLI / REPL / Space / IDE / SDK / binary
          |
          v
src/sdk-runtime  - optional stable host facade (inline / Worker / daemon)
          |
          v
packages/coding  - KodaX coding preset and tool loop
          |
          v
packages/agent   - Runner, fan-out, idle-yield, stop hooks, skills, MCP
          |
          v
packages/llm     - provider registry, streaming, side queries
```

Layer rules:

- `llm` has no dependency on KodaX product logic.
- `agent` can be used without `coding`.
- `coding` builds the coding agent on top of `agent` and `llm`.
- `repl` depends on `coding` for the product runtime and owns terminal UX.
- `src/sdk-runtime.ts` composes public host services over `coding`; it is a root
  package facade, not a fifth workspace package and not a second agent engine.
- Inline capabilities such as skills, MCP, tracing, session-lineage, memory,
  and workflow are subtrees, not separate workspace packages.

## 3. Runtime Shape

KodaX separates the stable Runtime service contract from deployment ownership:

```text
                         same KodaXRuntime facade
                                  |
             +--------------------+--------------------+
             |                    |                    |
      embedded / inline    embedded / Worker      local daemon
      caller JS process      MessagePort IPC      pipe / Unix socket
      private ownership      private ownership    shared profile owner
             |                    |                    |
             +--------------------+--------------------+
                                  |
                          packages/coding engine
```

Inline is the compatibility and lowest-latency default. Worker isolation keeps
one private Runtime in a disposable V8 Worker and reuses the daemon protocol
dispatcher/client over `MessagePort`. Daemon mode owns the same embedded Runtime
in a detached OS process and allows multiple REPL, Space, IDE, or SDK clients to
share sessions, runs, permissions, events, config, MCP, and catalogs.

Daemon uniqueness is scoped by `homeDir + profile`. An atomic owner lock,
persisted PID/endpoint/token/runtime identity, and health handshake make
concurrent starters converge. Client `close()` detaches; explicit daemon stop
ends the shared owner. Restart marks persisted non-terminal runs interrupted;
clients reconnect explicitly and KodaX does not pretend to resume an unknown
in-flight provider/tool operation.

CLI and SDK auto-start use the same candidate lifecycle: the spawned process
remains referenced until its own PID is healthy, and only that candidate process
tree is reclaimed on exit, timeout, identity mismatch, startup cancellation, or
loss of the owner race. Healthy daemons detach and remain available for later
clients; there is no production zero-client idle reaper.

Packaged Electron daemon auto-start uses the application executable only as a
bootstrap Node host. A preloaded scrub import removes `ELECTRON_RUN_AS_NODE`
before daemon application code loads, so ordinary children do not inherit it.
This requires Electron's default-enabled `RunAsNode` fuse; fuse-disabled hosts
must start an ordinary Node/CLI daemon and attach to it.

The published Runtime Worker also owns the Windows visibility boundary for
background subprocesses. Non-interactive memory/Git, provider CLI/ACP, LSP,
clipboard, worktree, review, extension-command, checkpoint, and sandbox child
processes request hidden consoles. Explicit editor, terminal, and PTY paths stay
interactive. The bundle build audits this boundary from the Runtime Worker
metafile.

Windows descendant cleanup is identity-checked and exposes observable
uncertainty instead of bare-PID success. Its current Toolhelp/CIM snapshot model
is still observation rather than containment: a descendant can become
unreachable after an intermediate parent exits. Issue 256 remains open after
v0.7.87; this provider release assigns no replacement target for the remaining
host-issued Worker owner lease. The v0.7.86 daemon/per-effect Job and sandbox owner
attestation slices narrow the risk but do not close that Worker-owned boundary.

The same published worker preserves Sidecar terminal meaning end to end:
optional post-completion offers remain successful, required clarification can
produce a structured blocked terminal, and only an eligible revision can
publish budget-approval state. Embedded and daemon clients observe the same
blocked code and reason.

Shared Coder daemon control is fact-based rather than connection-owned. One
atomic `sessions.observe` call returns the authoritative transcript/settings/
run/interaction projection and installs the post-snapshot event stream without
a gap. Mutations carry daemon-epoch operation identities, same-session runs
receive stable order, and settings/persistent grants use revision CAS. The
durable control journal never replays an operation whose external effect may
already have started. Runtime restart changes `runtimeId`; queued work becomes
interrupted with no effect, while active external work is explicitly unknown.
The packaged transport authenticates a single local OS-user/profile trust
domain with a random profile token and user-only pipe/socket access. Host-
granted scopes gate RPC families; stable client instance IDs provide
attribution and retry binding, not independent authentication. Per-application
credentials between mutually distrusting same-user processes are not part of
the current local-daemon contract.

Space-only integration stays behind two narrow reverse bridges. A keychain
broker supplies a provider/run-scoped credential directly into an in-memory
provider context; a Host Tool lease injects only the explicitly bound run's
capabilities. Both registrations are authenticated-client/connection owned,
never ambient profile capability. Dispatched Host Tool calls are never blindly
replayed. Daemon and inline Coder share one owner policy fence, including a
sticky inline rollback mode. Partner remains a private inline Runtime with a
distinct product data namespace and does not participate in the Coder fence.
An explicit daemon-enable command performs owner-policy reconciliation inside
the SDK coordination fence: it may remove only a parseable inline owner whose
process identity is proven gone. Live, unreadable, legacy-kind, daemon-kind,
and unverifiable owners remain fail-closed; embedders never delete owner files.

Worker and daemon calls cross a typed DTO boundary. Process-local callbacks,
class instances, `AbortSignal`, cyclic values, and extension runtime objects do
not silently cross or execute in the client. Runtime methods bridge abort,
events, permissions, artifacts, config, and owner-loaded extensions instead.

Permission is an owner-plane concern with four canonical profiles: Plan,
Edits, Auto[LLM], and Full Access. Edits and Auto first run eligible shell calls
inside the OS sandbox. A completed invocation is authoritative and creates no
review. Only a proven pre-start denial/unavailability reaches Exec Policy and
then the user or LLM reviewer; a target-started/uncertain call is never replayed.
Full Access skips sandbox and reviewer while retaining administrator forbids
and the narrow critical-effect fallback. Auto reviewer state is per turn;
infrastructure failure retries once (90s then 180s) and then blocks with a safer
route rather than widening authority.

The Runtime owner also owns interaction deadlines. Permission and AskUser have
independent five-minute defaults: permission expires fail-closed, while AskUser
uses only a validated model-supplied recommended default and otherwise
dismisses. Runtime resolution aborts host prompts through SDK AbortSignals, so
a late UI answer cannot retain the event stream or restart resolved work.
Agent-layer MCP elicitation shares the bounded AbortSignal UI contract and
cancels at the same default deadline.

REPL-to-Runtime permission settings are serialized per Session. The UI projects
the selected canonical profile immediately, then reconciles owner acknowledgement.
Legacy `auto-in-project` and Auto[RULES] inputs normalize to Auto[LLM] and are
omitted from new writes and events.

The classifier input boundary is owned by `classify`, not by individual
guardrail callers. It projects the current action independently and sanitizes
the accumulated Runner transcript into a UTF-8-byte-bounded factual subset.
This prevents a prior multi-megabyte tool result from consuming the current
permission verdict's transport/inference deadline.

The public Runtime contract mirrors that boundary. REPL and root SDK entries
export the four canonical profiles plus the input-only `auto-in-project` alias.
Session state owns only the reviewer model; normal review deadlines are fixed
at 90 seconds plus one 180-second retry. Auto-started daemon clients require
`runtimeAutoModeGuardrail` v5 and `sharedSessionSettings` v2, preventing an
alpha.5 client from attaching to a daemon that still implements the earlier
permission-before-sandbox or three-profile settings contract. Version
negotiation treats requirements as minimums. Side-query diagnostics report
only coarse, observed timing/retry facts, while guardrail spans start before
and end after the awaited callback.

Runtime text and reasoning deltas are coalesced before sequence allocation,
durable event persistence, and subscriber delivery. The source owner preserves
flush boundaries and an 8 KiB accumulated-merge limit. Clients that depend on
this behavior require `runtimeEventCoalescing:1`; daemon auto-start may replace
only an idle older owner and fails closed when preflight is unsafe.

Provider output is additionally projected by logical response and physical
request identity. Each request emits `responseId`, `providerRequestId`, and an
explicit append/replace mode. The raw Session journal retains abandoned request
facts, while the observation snapshot exposes only the effective segments.
`liveOutputSegments:1` is mandatory for new SDK clients; an auto-start client
gates it from the authenticated read-only probe before attaching the embedder's
stable identity. It may replace an incompatible daemon only after the existing
management, client/work-idle, owner/process-start identity, durable settlement,
process-exit, and verified-shutdown fences pass.

Session read APIs expose three intentionally separate planes: active model
context, raw append-order transcript audit, and ordinary conversation. The
ordinary projection is owned by the Session implementation, folds only
provenance/topology-proven copies, preserves ambiguity, and carries immutable
revision-fenced boundaries through standalone and Runtime paging APIs.

First-run setup is a pre-Runtime CLI branch. One root-owned coordinator
validates and creates the core, MCP, Extensions, and A2A active files plus
annotated templates through shared lock/revision checks, preserving readable
legacy declarations and never overwriting existing files. Provider readiness
then consults the canonical catalog and environment; a standalone terminal
interaction produces a non-secret choice, and a revision-checked atomic
mutation writes only provider metadata. The CLI exits for terminal environment
refresh. This branch never initializes the daemon, Runtime, session,
extensions, or provider network client.

The main coding path is:

```text
user input
  -> CLI / REPL / SDK adapter
  -> KodaXOptions
  -> Runner.run(createDefaultCodingAgent(), prompt, presetOptions)
  -> coding substrate
  -> provider stream + tool loop
  -> Sidecar Verifier stop hook when Worker text-finishes
  -> KodaXResult + session updates + UI/events
```

The Worker single-loop is the only current main-agent execution shape. The
Worker plans, reads, edits, tests, dispatches children, and writes the final
answer. Sidecar Verifier is out-of-band and only judges termination quality.

## 4. Provider Architecture

`packages/llm` provides:

- 16 built-in provider aliases,
- custom provider registration,
- OpenAI- and Anthropic-compatible protocols,
- CLI bridge providers for Gemini CLI and Codex CLI,
- stream normalization,
- lossless Provider-reported cache usage, including explicit-zero versus
  unreported semantics across CLI/ACP/Runtime boundaries,
- isolated ACP/native-CLI session namespaces with fresh stateless calls,
  native-ID-only resume, restartable pseudo transports, and process-exit
  validation after the terminal CLI event,
- effort-first reasoning and request-timeout config normalization,
- capability metadata and provider policy gates,
- side-query support for verifier and other out-of-band LLM calls.

The 2026-07-25 Kimi snapshot makes `kimi-k2.7-code` the public default, keeps
HighSpeed/K2.6/K2.5 as explicit routes, and treats thinking support as a
route-specific wire contract rather than a generic compatible-provider toggle.
The separate `kimi-code` subscription alias defaults to the direct upstream
`k3-256k` Model ID, retains `kimi-for-coding` for K2.7 Code, and offers a
1,048,576-token `k3` tier. Both K3 routes use `thinking.effort` for reasoning
intent, defaulting to `high`.

The v0.7.88 Zhipu Coding Plan routes keep logical model capacity separate from
the upstream model identifier. `zhipu-coding` defaults to `glm-5.3` and keeps
`glm-5.2`; `zai-coding` and `ark-coding` also default to `glm-5.3` while
keeping `glm-5.2` (Ark alias `glm-latest`). The compatible wires receive those
IDs verbatim, without a
synthetic `[1m]` suffix. GLM-5.3's always-thinking contract lowers `off` /
`none` to low effort at the provider boundary.

Provider-specific logic belongs at the provider boundary: request shape,
reasoning parameters, token caps, image support, forced tool choice support,
retry behavior, and stream watchdogs. Prompt prose should not fork by provider
family.

Main Runtime requests keep transport conversation identity independent from an
opaque `promptCacheKey` used only for explicitly supported cache-routing
fields. Coding derives the latter from the stable root/child context identity,
so retries, fallback, resume, and compaction reuse it without exposing Session
or Agent names or changing ACP conversation mapping. Kimi Code lowers it to
Anthropic-compatible `metadata.user_id`; public Kimi and official OpenAI lower
it to `prompt_cache_key`. Unverified compatible endpoints remain unchanged.

## 5. Coding Runtime

`packages/coding` owns KodaX-specific agent behavior:

- `runKodaX` and `KodaXClient`,
- default coding agent declaration,
- coding substrate and run loop,
- 50+ built-in tools from `tools/tool-definitions.ts`,
- Worker prompts and capability sections,
- permission and auto-mode integration,
- built-in full/light repo-intelligence context and semantic worker wiring,
- sidecar verifier integration,
- shared adaptive AMA pattern catalog and bounded `PatternTrace` projection,
- session snapshots and runtime state,
- construction and self-modification tools,
- workflow backend integration.

The coding runtime is the only layer that knows about KodaX's coding-product
tool bundle and user-facing task semantics.

Generated constructed handlers are a narrower coding-layer isolation case.
Each active handler runs in a persistent Worker, while `ctx.tools.*` calls
return to the host through reverse RPC and still traverse capability,
plan-mode, recursion-depth, permission, tool-registry, truncation, and OS
sandbox checks. Handler Workers are fault boundaries, not security sandboxes.

## 6. Tool And Control Plane

Tools are data-defined and handler-backed. Each tool declares name, description,
JSON schema, side-effect class, handler, and optional classifier projection.
Major tool families include:

- file operations: `read`, `write`, `edit`, `multi_edit`, `insert_after_anchor`,
  `undo`;
- execution and search: `bash`, `glob`, `grep`, web search/fetch, code search,
  semantic lookup, LSP navigation;
- repo intelligence: overview, changed scope, diff bundles, module/symbol/
  process context, impact estimates, cyclic dependency checks;
- coordination: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `interrupt_agent`, `list_agents`, `agent_output`;
- product state: goals, todos, sessions, manual lookup;
- extension capabilities: MCP calls, MCP resources, MCP prompts;
- construction: tool generation, agent generation, self-modify staging.

Permission modes and auto-mode guardrails must operate on tool side effects and
runtime context, not on prompt-only convention.

Configured shell execution is owned by the Runtime host and coding tool layer,
not by the daemon process environment. A normalized, JSON-only contract flows
from Session/Run settings into root and descendant tool contexts. The resolver
sanitizes bootstrap variables, loads the selected shell/profile in the real
execution cwd, captures and validates a framed environment, sanitizes again,
then uses the same explicit interpreter for the command. Cache identity binds
the contract, canonical cwd, Session scratch identity, the fixed internal
KodaX/Electron execution-control deny set, and refresh generation. Legacy
callers bypass this resolver.

ASRT containment is the first authority for Edits and Auto shell execution.
Sandbox completion returns directly; a failure proven before target spawn
reaches a new exact host-boundary decision, while a failure after spawn never
re-executes. The public `/sandbox` entry exposes capability/doctor/setup plus an
explicit host-owned executor that returns `unavailable` instead of applying
the local fallback. `/sandbox` and optional `tool.sandbox` events are diagnostic
surfaces; ordinary REPL history remains unchanged. KodaX's workspace-shell
policy allows broad reads, including Agent Home, credential locations, and
global Git configuration; writes stay within workspace/system temp. The
generic SDK executor continues to apply its caller-owned policy.

The permission boundary treats `gitRoot` as an allowed repository boundary and
`executionCwd` as the base for relative operands. It never promotes quoted
script or regular-expression source into a filesystem path. Permission events
carry a bounded, credential-redacted JSON summary plus the effective execution
directory. `exit_plan_mode` is part of a tool scope only when a trusted host
has supplied its plan-approval callback.

## 7. Child Tasks

Child work is explicit and tool-driven. The main Worker can dispatch a child,
send it follow-up messages, stop it, and inspect output. Idle-yield is the
canonical waiting behavior when useful main work is exhausted and child tasks
remain in flight.

Coordination separates the model control plane from runtime telemetry:

- `wait_agent` suspends on the caller-scoped mailbox, root user input,
  interruption, or timeout and returns only a wake acknowledgement;
- authenticated Agent messages and completion envelopes are injected at the
  next safe model boundary as synthetic context;
- Actor progress remains on the event stream for UI, tracing, and SDK
  replay/long-poll consumers and never wakes the model;
- `agent_output` is a targeted structured/artifact read for a known Actor/Turn,
  not a completion polling loop.

Children are a coordination primitive, not a replacement for the main Worker.
The main Worker owns final synthesis and user communication.

Every persisted Actor Session has one exclusive Runtime owner. Current owners
publish a Runtime-scoped loopback identity challenge in addition to the PID, so
PID reuse cannot make an unrelated process look authoritative. A refused or
completed mismatched challenge proves stale; ambiguous failures and legacy
snapshots without identity evidence stay fail-closed.

FEATURE_274 gives the Worker a shared six-pattern decision catalog without
adding another scheduler. Existing Actor operations accept optional,
coding-owned `quality_strategy` metadata. The agent layer stores opaque turn
metadata and lifecycle facts; the coding layer validates pattern semantics,
derives the bounded `PatternTrace`, and projects it into the existing Sidecar
packet. Coverage, replication, and opposition remain distinct, and neither a
trace nor an Agent count proves correctness. The content-aware Sidecar gate
still decides whether verification runs, and Sidecar remains the single
terminal-answer quality adjudicator.

User follow-ups are routed with the session-root Actor queue id. Queue display,
idle-yield wakeups, and prompt consumption use the same scope, preventing one
session or child actor from draining another session's pending input.
SDK/daemon hosts with `interruptInput:1` may also route ordered user input into
the current active root Run. Tool boundaries and terminal candidates drain the
accepted FIFO batch as separate user messages; a terminal candidate first
closes admission synchronously, then either continues the same Run with the
accepted batch (reserving one model turn at the iteration ceiling) or completes
with the window closed. Managed idle-yield waiting reopens the window because
its wake path is a guaranteed consumption boundary. Failure, cancellation, and
terminal cleanup close it before asynchronous teardown. Ordinary coding rotates
live-turn ownership when it consumes a queued prompt and persists the current
assistant response before a COMPLETE continuation. This is distinct from
`after_turn`, which creates a continuation Run.

## 8. Sessions

KodaX sessions are local JSONL records with branchable lineage. Session
requirements span both product and SDK:

- CLI and REPL resume/list/fork/rewind flows;
- SDK session APIs via `@kodax-ai/kodax/session`;
- session snapshots and runtime state persistence;
- durable terminal tool-card replay from sanitized `uiHistory`, with canonical
  `messages` / `lineage` remaining the source of truth;
- failed-turn `presentationOnly` text is the narrow display-authoritative
  exception: persist it exactly once and restore Assistant summary, Sidecar
  verifier, then terminal error without adding model-context messages;
- searchable bare-resume selection that defers the full CLI load until a
  selection, returns Esc directly to the invoking terminal, and hands stdin to
  the resumed REPL only after selection;
- one shared continue-most-recent rule that scans a broad newest-first page,
  skips zero-message placeholders, preserves explicit IDs, and is used by Ink,
  classic, one-shot CLI, and coding-runtime auto-resume;
- interactive resume restores persisted workspace/runtime identity before
  shell execution, workflow project-key derivation, or the next model turn;
- original per-event history timestamps retained through replay rather than a
  render-time timestamp applied to every message;
- tags, filters, archive state, and project-aware storage evolution;
- compatibility with old session records where practical.

Session management is a product feature, not merely a debug log.

Major context compaction is an always-on, request-bound Session transaction.
One normalized policy takes the minimum of a 15-90% trigger (75% default), an
optional positive absolute token threshold, and physical provider capacity.
The protected recent tail is 20% of that effective trigger. Everything older
is one complete eligible prefix: it is summarized once, or map/reduced only
when one summary request cannot physically fit. A synthetic user checkpoint
combines the semantic summary with an exact genuine-user-query ledger.

Compaction never partially replaces canonical history. A successful result
must reduce tokens, fit the complete provider request, and commit before
success callbacks/events fire. Canonical events are keyed by root/child
`contextId` and revision. Runtime observation carries bounded transcript
slices; revision-bound pages and lossless chunks recover data that cannot fit
inside one daemon frame.

Exact transcript persistence has a stricter boundary than semantic context
replacement. The compaction transaction supplies the root host with the exact
pre-compaction messages, including messages created in the active Run. The host
commits those entries to main JSONL or the island sidecar before it may reclaim
old payload from memory. Sidecar flush precedes slim-main publication; stable
entry IDs deduplicate the safe main/sidecar overlap after an interrupted write.
The commit callback is awaitable, so no next provider request or canonical
finished event can overtake durability. Runtime owns this boundary after a
client crosses into embedded or daemon execution. Child compaction cannot
mutate root Session lineage. Runtime-backed REPL projections are not additional
Session writers. A compact that occurs before the first routine snapshot creates
the Session from explicit Run metadata, while a failed durability callback
restores the tentative context revision and retains the exact payload.

Persisted transcript recovery is a read plane, not long-term semantic memory.
Runs backed by full-lineage storage receive the bounded
`session_history_search` and `session_history_read` pair. Root Runs bind their
root Session; persistent child Runs bind separately minted hidden worker
Sessions and cannot read root lineage. Search uses deterministic Unicode
lexical/metadata ranking and returns revision-bound entry citations; read
returns exact fixed-size chunks. Runtime and daemon hosts use the same evidence
identity through transcript search plus existing page/chunk transport. No
vector store, background extractor, or automatic old-instruction reinjection
is added. The evidence plane excludes system/control content, hidden-only
bodies, synthetic current/legacy compaction checkpoints, and raw payload
placeholders from search and direct read. History discarded by a legacy build
before exact sidecar persistence is not reconstructable.

## 9. Skills, MCP, And A2A

Skills are Markdown-based capabilities discovered from configured paths and
expanded for the LLM through `packages/agent/src/capabilities/skills`.
Every enabled Skill remains available through an explicit user `/<name>` or
`/skill:<name>` token at the head or in the middle of a query. The suffix after
the token is passed as Skill arguments and the host expands the Skill before
the model handles the request. `disable-model-invocation` controls only
model-visible discovery and the model `skill` tool path; it never blocks an
explicit user or SDK registry invocation. The legacy `user-invocable` field is
parsed for compatibility but is not an execution permission.
Structured `skillInvocation` is the provenance boundary for delegation. An
active explicit user Skill is inherited by Workflow and child execution even
when the generated child objective does not repeat the slash token. Text that
the model writes into a child objective is not provenance: a new reference
there remains a model invocation and must pass the model-tool gate.
Queued explicit Skill text is host-owned: runtime mid-turn and idle-resume
drains cannot expose it to the model before trusted expansion. The expanded
active Skill is then present exactly once in either the SA or AMA system
context. Worker/daemon transports rehydrate tool and hook policy from their
local trusted registry and wait for PostToolUse completion rather than trusting
serialized client policy.
The F263 learning owner reuses the governed episode-review inbox and Learning
Center. It records an immutable decision, writes a project-scoped Skill
revision plus canonical capability record, and only then permits
fingerprint/lifecycle-gated discovery. One concurrent root binding and three
exact-revision uses bound testing; independent verified success is required
for project trust. Files alone are never activation authority. Formal sources,
global promotion, and Extension authoring remain explicit.

MCP integration lives under `packages/agent/src/capabilities/mcp` and includes
catalog/search, transport, runtime connection, OAuth helpers, protected-resource
discovery, prompts, resources, tools, and reverse capabilities.

Media/input artifact helpers live under `packages/agent/src/media`. The
published `/media` SDK subpath and `@kodax-ai/coding/media` compatibility
barrel both point at this agent-layer implementation.

Published SDK subpaths expose focused subsets:

- `@kodax-ai/kodax/media`
- `@kodax-ai/kodax/skills`
- `@kodax-ai/kodax/mcp`
- `@kodax-ai/kodax/sandbox`

A2A remains a root integration edge rather than an agent-layer wire concern.
`src/a2a` composes A2A 1.0 Card discovery, JSON-RPC/SSE execution, inbound
Runtime publication, configuration reconciliation, and the protocol-neutral
external-Agent plane. Version 2 configuration adds per-Agent desired-state
activation, outbound OAuth 2.0 Client Credentials, and inbound RFC 9068 JWT
Resource Server validation while retaining fixed Bearer compatibility. Its
per-Agent network block carries independent `allowPrivateAddresses` and
`allowInsecureHttp` booleans; both default false and participate in the
registration fingerprint so grants and revocations force reconciliation.

Trust is split by authority: Card, Agent RPC, and Authorization Server origins
are independently constrained; a stable authentication realm scopes durable
task ownership; registration revisions and management ownership fence hot
reloads; immutable internal route snapshots preserve admitted work after
registration changes. Inbound authentication precedes task/body disclosure,
and synchronous global capacity reservation plus bounded SSE resources prevent
one client from exhausting the server without serializing slow preparation for
other principals. Retained pre-realm tasks stay hidden unless a stopped
operator supplies an exact owner migration. KodaX consumes externally issued
tokens and never owns production signing or issuance. Owner-plane shutdown
uses one 30-second default deadline across admitted work and executor disposal;
obsolete cleanup runs after the serialized registration mutation lane. Daemon
auto-start retains ownership of startup children until readiness and terminates
abandoned children on timeout or cancellation.

## 10. Governed Memory Runtime

FEATURE_260 adds a thin experimental Memory Agent without creating a second
long-term memory plane. `packages/agent/src/experimental-memory` owns the
domain-neutral `MemoryAgent` / `MemorySession` contracts; the existing
`packages/agent/src/memory-control` plane remains the sole governed persistence
authority. `packages/coding` owns coding observations, prompt-safe rendering,
the `memory_recall` tool, Action-LLM integration, and trace correlation.

Routine exact recall is synchronous and injected as a bounded dynamic suffix.
FEATURE_275 adds sparse foreground intervention after tool failure,
verification failure, or a durably committed context compaction. At those
events the Memory Agent rebuilds one closed candidate set from current
objective/open todos, recent governed observations, and a fresh F228 pack.
An optional host-owned selector can return only offered IDs; the default
runtime makes no selector call. Intervention completes after compaction and
before the affected Action-LLM request, so the reminder cannot be compacted
away before use. Deliberate `query()` / `memory_recall` remains read-only and
initiated by the Action LLM. Episode review may create a governed
proposal or defer it to the scoped inbox; only the existing
proposal/preview/fingerprint/apply path can mutate durable memory. Exact scope,
private/sensitive filtering, prompt-injection rejection, stale-result fences,
and managed-path guards remain deterministic. Decision receipts separately
record offered candidate IDs, selected candidate IDs, and exposed evidence refs;
they are trace-only and never store hidden reasoning.

The root Action LLM binds exact current-turn Memory requests through one hidden
`memory_intent` tool. Mutation authority binds both the requested operation and
its exact target, and every new claim carries a stable semantic key. Safe explicit
remember, correction, and forget operations reuse the governed controller and
apply immediately; the episode carries only a host-owned handled-operation marker
for de-duplication, while normal episode and
Skill learning still completes. Ambiguous/broad requests ask for clarification,
conflicts become explained decisions, and secrets are rejected. Autonomous episode review remains a separate
background path: verified low-risk changes may auto-apply, and exceptional cases
remain reviewable. A later run recovers any persisted background jobs.

The user-facing surface is conversational first. `/memory` is an advanced
escape hatch for accepted entries, exceptional decisions, and diagnostics.
`MEMORY.md` is only a derived projection; external editors may open it, while a
hidden repair command may rebuild it from authoritative state.

The public opt-in entry is `@kodax-ai/kodax/experimental-memory`; its additive
`MemoryManagementAgent` exposes list/remember/forget only when the supplied
controller implements that capability. The base `MemoryAgent` return type remains
source-compatible and does not become an implicit dependency for consumers of
the stable root or Runtime SDK.

## 11. Workflow Runtime

Workflow has two layers:

- `packages/agent/src/workflow`: domain-neutral runtime, events, types, caps,
  concurrency, abort, backend injection, and the generic workflow capsule
  contract.
- `packages/coding/src/workflows`: coding backend, built-in workflows,
  durable run graph, workflow capsule persistence/preflight, saved-workflow
  discovery, and REPL command integration.

FEATURE_217 is the v0.7.49 Dynamic Workflow feature. It provides the runtime
substrate, coding backend, durable run graph, on-the-fly JavaScript harness
generation, background management, pause/resume/stop/save, opt-in worktree
routing, hard budget checks, workflow capsules for reusable generated runs, and
reusable workflow pattern templates. The domain-neutral SDK surface lives in
`@kodax-ai/agent/workflow`; coding and REPL layers consume it rather than owning
the core runtime.

Generated workflow scripts keep the orchestration plan in JavaScript, matching
Claude-style dynamic workflows. They must not receive raw host authority:
filesystem, shell, process, environment, module import, and network effects stay
behind child agents and KodaX permission gates. Generated scripts run through a
capability runner that exposes only structured `wf.*` calls to the host. Pattern
templates are examples and scaffolds, not a replacement for dynamic harness
generation.

Saved generated workflows are persisted as lightweight workflow capsules:
source, manifest, intent, input examples, environment/tool/skill/MCP
requirements, and provenance. The capsule protocol belongs in `agent`; checks
that depend on the local repository, skills, MCPs, or `.kodax` paths belong in
`coding`; command help and approval text belong in `repl`.

FEATURE_229 (`v0.7.50`, released)
is the process layer on top of FEATURE_217. It standardizes workflow progress as
agent-layer snapshots and events so SDK embedders, coding commands, REPL
inline/fullscreen surfaces, and future system event bridges can subscribe to the
same source of truth. This follows the same boundary rule as the runtime itself:
`agent` owns process state and terminal status semantics; `coding` maps domain
workflow runs, host policy, lifecycle controls, source/provenance fields, final
result summaries, artifacts, and retention into that state; `repl` renders it.
Space-style hosts must consume the F229 snapshot/controller contract rather than
parsing terminal text, slash-command output, or Ink view models. The host
contract also preserves parent guardrails, existing SDK event callbacks,
workflow logs, capsule preflight, and provider/model policy when a workflow
spawns child agents; entering workflow mode must not weaken safety or
observability.

FEATURE_230 and FEATURE_234 (`v0.7.51`, released) close the host-read
persistence loop around sessions and workflow runs. Resumed TUI sessions replay
bounded terminal tool cards from sanitized `uiHistory` while headless hosts can
still reconstruct tool facts from canonical messages. Workflow process snapshots
also carry optional `hostMetadata`, a small string-only map persisted in
`run.json` and echoed after restart so hosts can attribute runs without a side
table.

CAP-099 extends the host transcript contract with clone provenance. Public
transcript entries include stable `logicalId` and optional `sourceEntryId` so
Space-style hosts can fold cloned or forked history precisely, without parsing
message text or relying on timestamp heuristics. The transcript API still
returns raw append-order scrollback.

FEATURE_246 (`v0.7.58`, released) is the largest workflow change since F229: the
Worker authors and runs workflows inline through a model-callable `run_workflow`
tool (scout-then-author), running generated scripts through the same sandbox +
static-validation + postcondition pipeline. It adds structured child output
(`outputSchema`), the no-barrier `wf.pipeline`, same-session resume
(`resumeFromRunId`), and nested workflows; the neutral run-lifecycle manager is
lifted to `@kodax-ai/agent` (ADR-046) and the inline run is async / idle-yield
(ADR-049). See ADR-044/046/047/048/049.

## 12. REPL And CLI

`packages/repl` owns terminal UX:

- Ink interactive mode,
- slash commands,
- config and custom provider CRUD,
- permissions UI,
- session list/resume/fork/rewind/archive surfaces,
- transcript rendering,
- status and progress surfaces,
- MCP and workflow command surfaces.

`src/kodax_cli.ts` is the product entry for command-line execution and binary
bootstrap. The CLI should stay thin and delegate product behavior to package
APIs.

## 13. Design Constraints

- Do not reintroduce retired V1 chain abstractions into current docs or prompts.
- Do not add a new workspace package unless there is a real independence need.
- Do not expose source-only subpaths as published root-package subpaths unless
  `package.json`, bundle build, and dts generation all support them.
- Do not make SDK consumers depend on REPL-only APIs for headless use cases.
- Do not make provider-specific behavior leak into generic prompt prose.
- Do not add a generic execution manager when a whole-Runtime ownership form or
  an existing typed tool/workflow service is the real contract.
- Do not describe Worker `resourceLimits` as hostile-code containment.

## 14. Related Documents

- Product requirements: [PRD.md](PRD.md)
- Detailed design: [DD.md](DD.md)
- Architecture decisions: [ADR.md](ADR.md)
- Active roadmap: [FEATURE_LIST.md](FEATURE_LIST.md)
- Feature index: [features/README.md](features/README.md)
