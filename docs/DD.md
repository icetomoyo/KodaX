# KodaX Detailed Design

> Last updated: 2026-09-01
>
> Current published baseline: `v0.7.96-alpha.5`
> (`@kodax-ai/kodax@0.7.96-alpha.5`; Windows `sandboxRuntime:10`,
> `runtimeAutoModeGuardrail:5`, `sharedSessionSettings:2`,
> `runtimeExitSettlement:2`, `crashOutcomeModel:2`;
> npm publication remains manual)
>
> This DD describes current implementation structure. Retired V1 chain details
> were deleted from this active document; use git history and historical feature
> docs when archaeology is needed.

## 1. Scope

This document maps product behavior to current code ownership. It is not an API
reference and does not duplicate every type. It should answer three questions:

- Where does this behavior live?
- Which package owns the contract?
- What must not be coupled across package boundaries?

## 2. Published Package And Build Entries

The published package is `@kodax-ai/kodax@0.7.96-alpha.5`, which includes the v2
scoped Provider credential broker (ADR-068) and bounded daemon client
inventory on top of the v0.7.96-alpha.1 feature set and the v0.7.96-alpha.2
Windows boot-identity hotfix. The v0.7.96-alpha.1
pre-release separates trusted text transactions from platform shell
containment (FEATURE_295, Windows `sandboxRuntime:6`) and replaces the local
tool-result capacity hard gate with capacity-debt admission and a bounded
recovery ladder (FEATURE_296). The v0.7.95 maintenance
release makes Windows sandbox cleanup self-healing: the machine-global cleanup
Job is recoverable across reboots, recovery tickets repair without operator
input, background retries observe the exact daemon and supervisor process
generations, and dynamic worktrees register their cleanup policy at creation.
Stale learning locks and fullscreen terminal teardown are reclaimed safely
(Issue 301), and the coding runtime defers its completion signal until the
authoritative `KodaXResult` is finalized so A2A answers can no longer publish
an empty success (Issue 302). The v0.7.94 maintenance
slice lets Runtime text tools overlap a compatible live Bash lease through
the same ASRT workspace policy, rejects hard-linked sandboxed targets, trusts
Windows git `safe.directory` for authorized repo roots only (Issue 300), reads
linked-worktree / submodule relationship files through strict byte bounds,
observes text-helper stdin failures on the operation Promise, and
reports scheduled shutdown cleanup failures. A missing workspace directory
omits the concurrent text sandbox at Run start. Runtime advertises
`conversationHistory:2`. Explicit Skill invocation is independent of model
discovery. Invalid `allowed-tools` and malformed hook JSON are diagnosed;
`PostToolUse` still runs if an embedder result observer throws. Run settlement
observes finalization rejections and recovers an admitted `runId` without
replaying `runs.start()`. The v0.7.95 maintenance release
automatically retries same-boot Windows `unconfirmed-owner` recovery and clears
it only after an exact sandbox-user SID-idle proof. Learning locks with stale
zero-byte, malformed, or truncated owner data are reclaimed through unchanged
bytes/stat verification. Explicit Skill execution separates exact canonical
user input from execution overlays, rejects multiple active references, and
makes `PreToolUse` failure a denial. Terminal Run persistence failure publishes
`unknown`, or invalidates live Session observations when no durable event can be
committed. The v0.7.93 maintenance
slice observes a durable Windows `failed` shutdown outcome during orderly
exit wait, recovers previous-boot shared ACL markers only after a verified
boot change, and classifies Anthropic/OpenAI abort wrappers by isolated SDK
class identity. The v0.7.85 release
established
controller-wide bounded Actor progress
persistence, queue-aware terminal deadlines, root fail-closed fencing, and
automatic same-owner settlement recovery after an unknown durability boundary.
The v2 settlement contract separates Actor mutation order, process-local
storage dequeue, writer eligibility, cancellable pre-commit work, canonical
replacement, and full maintenance completion. Local storage queue backpressure
is unbounded by the file-lock contract; after dequeue, File Session storage
declares a 65-second eligibility bound around its 60-second writer-lock
contract. The five-second deadline begins only after eligibility. Actor state
commits at canonical replacement while the storage queue continues to serialize
cache, watermark, topology, hint, and lock maintenance. Same-owner repair uses
the same phased save contract, and terminal settlement observes an active
predecessor's canonical phase rather than waiting forever behind a hung rename.
Same-owner repair and root abort close effect admission; the logical convergence
boundary also requires every exact tool execution admitted before the fence to
settle. The Session route then releases without waiting for the old root executor Promise.
An abort-ignoring provider cannot publish callbacks or start a new Runtime-
mediated effect after its fence.
The versioned `actorSettlementConvergence:2` capability lets new SDK hosts reject
older monolithic-save semantics while remaining backward compatible with hosts
that require v1. It keeps
Windows daemon containment before user code
can create descendants: the daemon is created suspended, assigned to a
kill-on-close Job Object, and resumed only after assignment succeeds. An
out-of-Job supervisor waits for daemon exit and Job emptiness. The public
`waitForRuntimeDaemonShutdown()` verifier requires that boundary plus the exact
durable cleanup outcome, while the `daemonShutdownVerification:1` capability
lets hosts require it. Legacy daemons are deliberately not upgraded in place
for this contract. The patch retains v0.7.82's causality and input-admission
contracts; FEATURE_287 remains planned for v0.7.93 and the Worker owner-lease
portion of Issue 256 remains open after v0.7.89 without a replacement target
assigned by this release.

The v0.7.94 source hardening keeps Run convergence inside
`src/sdk-runtime.ts`: successful and failed executor callbacks feed one
observed settlement chain, durable status outranks event-publication failure,
and total terminal persistence failure records
`run_settlement_not_persisted` while retaining the Session fence. The
v0.7.95 source additionally handles a terminal status rename that commits
before later status-lock cleanup throws: one retry may treat the reread record
as the local commit only when the complete public status is deeply equal; it
then emits the terminal event exactly once. A different terminal record
remains authoritative and is not republished.
`src/sandbox-runtime.ts` and Agent managed-child event handlers terminate
through rejection-observed cleanup paths. `src/runtime-daemon/transport.ts`
publishes the same typed disconnect facts to pending RPCs and lifecycle
subscribers and rejects oversized outbound frames before socket write.
Classified failures are normalized once into `failureDetail` and projected
unchanged through terminal failure events (or settlement `run.updated`), Run
result/status, and Session diagnostics when that fact exists.
The existing terminal `failureKind` remains the coarse compatibility field;
`providerErrorCode` is the stable KodaX classification, while
`upstreamErrorCode` is explicitly provider-controlled. `safeMessage` comes
from a bounded KodaX-owned template rather than provider response text;
provider-controlled identifiers are allowlisted and dropped if they contain a
run credential, a nontrivial prompt, or a registered/sensitive-name environment
secret. Raw header collections/bodies, URLs, local
paths, stacks, causes, and raw errors never cross the Runtime boundary.

Reconnect recovery belongs to the SDK host adapter, not the transport. After
admission returns `runId`, an adapter may create a replacement Runtime, verify
`runs.get(runId)` still identifies the same Session, and call
`runs.await(runId)`. It must not call `runs.start()` again. Transient connection
or daemon-health failures share one host backoff authority; permanent
initialization failure and host close settle all waiting result observers.

The v0.7.89 implementation adds `conversationHistory` projection rules that
hide replaceable managed context from ordinary topology while retaining the
physical audit track and fail-closed ambiguity. `web-search.ts` owns the
DuckDuckGo HTML → Bing RSS → Bing HTML bounded fallback and custom-endpoint
isolation. The coding runtime owns `RunScopedToolDefinition` materialization,
registry-first dispatch, permission predicates, and AMA/SA tool wiring; the
Runtime daemon reverse bridge owns lease binding, revocation, catalog context,
and `host:` authorization. These are additive to MCP and do not modify Shell
or sandbox implementations.

The v0.7.90 patch extends the implementation boundaries without changing their
authority: `src/sandbox-runtime.ts` retires timed-out workspace sessions through
orderly close and gives cleanup its reset-grace deadline; the daemon host
serializes Error/aggregate/cause diagnostics; Agent lineage writes
`sourceEntryId` as the direct physical predecessor and preserves referenced
predecessors during archive slimming; and Coding's shared run-scoped tool
materializer normalizes open schemas to `{ type: 'object', properties, required? }`.

The v0.7.86 hardening adds atomic abandoned-inline-owner recovery, process-start
identity records for Runtime and learning locks, and a Windows sandbox owner
protocol. Sandbox effects acquire one durable owner marker per KodaX home,
serialize recovery across Runtime profiles, wait for process-tree termination
proof before ACL recovery, and fence later filesystem effects when attestation
is missing. Spawn, lease-release, and cleanup failures are preserved together
as lifecycle safety errors instead of being collapsed or triggering a replay.
POSIX workspace admission initializes Runtime-owned `KODAX_HOME` policy roots
before hashing the policy, waits only for workspace-local warm-up within the
Shell abort/deadline, and asynchronously retires a cached session after lease-cleanup failure; later
admission waits for that reset and remains fail-closed if reset is unconfirmed.

The v0.7.92 filesystem-effect coordinator lives in
`packages/agent/src/learning/store-lock.ts` (generic ticket queue) and
`packages/coding/src/tools/_internal/file-mutation-queue.ts` (direct / shell /
namespace leases). Queue tickets reuse the coordinator-lock token and heartbeat
while waiting; stale same-PID tickets are reclaimed only when they do not own
the exact lock file. Effect release writes a token-scoped `.released` marker
before the coordinator transaction that drops that owner. Managed terminal
ordering is owned by `packages/coding/src/task-engine/runner-driven.ts`:
`saveManagedRunBoundary` precedes `observer.completed`, and
`scheduleManagedTaskMaintenance` projects repo-intelligence and task artifacts
after the Run is no longer active. `src/sdk-runtime.ts` keeps managed
`onComplete` non-authoritative and requires `sandboxRuntime:5` plus
`crashOutcomeModel:2` so idle older daemons are replaced.

The v0.7.94 direct-text path used the coordinator plus an ASRT helper. That
historical path is superseded on all desktop platforms by FEATURE_295 and is not reachable
from controlled text tools. `withFileMutation()` remains only for legacy and
non-text filesystem effects; it is not the trusted-text transaction
primitive.

The v0.7.96 FEATURE_295 path supersedes that implementation on Windows, Linux,
and macOS. The
five controlled text tools no longer construct or receive a text sandbox
capability. Their shared transaction seam performs a preflight, acquires a
process-death-released kernel lock for one stable canonical namespace slot, reopens
and reauthorizes the target under that guard, reruns revision/identity CAS,
checks the candidate content computed by TypeScript, flushes a same-directory temporary file,
and atomically replaces or creates the target. Diff/LSP/presentation work is
outside the guard. A receipt carries the complete preimage and post-commit
revision so undo cannot overwrite an intervening user or shell write. A text
transaction starts no process and is packaged independently from shell
doctor/setup. Before first load, a fixed System32 provisioner can place already
hash-verified binding bytes in the protected content-addressed artifact store;
no text payload enters that bootstrap. The Windows slot mutex is inside a current-host-SID private namespace;
the restricted account cannot squat its public name, and process death leaves
no lockfile or recovery ticket. Unix uses a fixed per-UID system coordination
 root and private per-slot inode carrying kernel `flock`; the inode is inert
state, process death releases ownership,
 and native commit uses `openat(O_NOFOLLOW)`, `fsync`, rename, and parent `fsync`.
 Rename is the commit point. A later parent-directory flush failure or an
 unprovable rollback is surfaced as `committed_uncertain` with the complete
 pre/post receipt; callers reread and never retry blindly. Existing-file edits
 retain an Undo backup, and an uncertain Undo rebinds its receipt to the
 observed post-commit revision. New-file uncertainty exposes its missing
 pre-state in the structured error but creates no legacy delete-style Undo entry.
Its mode-`0700` Agent Home state root contains content-addressed artifact state;
the addon is loaded from a verified descriptor, and sandboxed shell policy
denies writes to both artifact and coordination roots. Unix replacement
preserves owner, mode, extended attributes, Linux inode flags, and macOS
extended ACL/file flags or fails closed.
On Windows, commit holds a target delete/write reservation across the locked
final reread, revision CAS, and `FileRenameInformationEx` commit. POSIX rename
semantics keep compatible readers open while preventing a non-delete-sharing
reader or new writer from entering that narrow window. Legacy low-integrity
sandbox labels normalize to the destination's ordinary host integrity; higher
or unknown labels remain fail-closed.

Windows v2 Bash uses a different native sidecar. Bounded frames separate
control from target stdin and carry explicit close, output, error, terminate,
ready, and exit events. The runner verifies its host, constructs the restricted
policy token, creates the target suspended with explicit inherited handles,
assigns it to the Job before execution, then reports Ready and resumes. The
trusted host holds a nonce-bound private desktop whose DACL requires the exact
policy capability, so restricted targets initialize without using the
interactive desktop or opening a sibling policy's desktop. The
prepared invocation identifies native token isolation so Coding bypasses the
legacy effect gate and lease; no owner/reset/cleanup/poison transition spans a
command lifetime. The restricting set carries exact write policy capabilities,
shared-group read access, plus the dedicated account, per-launch logon, and Everyone
compatibility SIDs. Real nested Node/cmd/PowerShell probes require the account
SID, matching current Codex; Issue 309 records that an ambient-trustee child
DACL can therefore bypass a later root capability. The token default DACL still
excludes the account. Pre-alpha.4 exact sensitive-root denies are removed only
by the generation-8 legacy migration proof. Setup generation 9 preserves a
healthy fixed account identity and upgrades generation 8 in place without
replaying that destructive cleanup. Setup writes a protected non-ready
`installing` marker, its elevated parent synchronously converges NUL compatibility
and profile read capabilities, and the caller then publishes the ready marker;
it does not prewarm system TMP. Ordinary command admission converges the same
stable read/deny/write capability ACE set for every canonical root; the command
token alone activates its authorized clauses. Admission never runs legacy ACL
cleanup or revokes another Session's shared ACL state. Windows shell Temp variables point to an
empty per-command directory under system TMP, preventing recursive writes to
the shared Temp/AppData DACL. Linux and
macOS prepare one
ASRT bubblewrap or Seatbelt/`sandbox-exec` command per invocation and keep no
KodaX workspace-session owner or filesystem-effect lease across its lifetime.
Protocol 9 requires a marker path and SHA-256 on every request. The native host
holds that marker without delete sharing until its resume/started proof is
durable. Warm ACL verification is read-only; effective inherited normal-token
access is accepted, while a missing exact restricted capability uses
`SET_ACCESS` and DACL readback without a cross-process target mutex.
Control-directory provisioning and migration are setup-only. A missing
content-addressed executable image may be atomically published by the first
execution; an existing image is never repaired by admission. Ordinary admission
performs local path/identity/hash verification and starts an independent
request/token/pipe/Job lifecycle. Windows `denyRead`
returns structured `unsupported_policy` before setup, DACL mutation, or target
start; ordinary start/exit creates no execution receipt. Setup alone retires legacy
receipts and their pre-cutover ACEs.
Before selecting Windows shell policy, `workspaceShellSandboxConfig()` creates
fixed host-owned Agent Home deny-write directories only when an actual requested
write root contains them. Merely placing `KODAX_HOME` below the system Temp path
does not widen that write policy because the shell receives a separate private
Temp child. This avoids both an `ENOENT` denial-root failure and a broad shared
Temp grant without introducing a mutex/queue.
Generation-9 setup invokes one elevated native parent with a versioned,
digest-bound, single-use request below the protected control directory. It
synchronously converges NUL compatibility and profile top-level read
capabilities before publishing ready; no detached prewarm helper overlaps
ordinary admission. A target-start or terminal-proof failure, or trusted
terminal proof of runner/controller loss, immediately detaches that broker
generation from reuse. Existing holders may finish on the
detached generation, while new same-authority commands create a replacement;
detached processes still count against the fixed ASRT port capacity until they
actually exit. Each startup/control phase has its own 15-second bound without
shortening the caller's command deadline, and a caller-local abort or shorter
deadline does not retire a healthy shared broker.
Windows allow-root ACL changes are exact-root only. The target's enabled
traverse privilege reaches private descendant roots without rewriting ancestor
container DACLs, avoiding inheritance propagation through unrelated profile
trees.
Only the final Windows target is creation-time contained by KodaX. Issue 307
records the external ASRT runner's shared-account pre-main creation window;
post-spawn DACL hardening cannot close it, and current Codex retains the same
`CreateProcessWithLogonW` residual.
The following v0.7.95 helper lifecycle is historical and does not apply to
FEATURE_295 trusted text transactions. Sandbox backups used a canonical path minted from the opened helper identity;
undo rejects a subsequently changed canonical identity. Worktree create/remove
keep a process-local queue only for the same exact target path until the managed
Git process tree is proven drained; different paths and processes rely on Git's
own locks and do not acquire a KodaX namespace lease.
Historical text cleanup recovery was phase-idempotent. It applied to both ordinarily
drained and delayed-drain paths, caches a successfully read execution
attestation before deleting the broker file, retries a transient
workspace cleanup or policy reset, and does not repeat finished process-drain,
effect-process, or outer lease-release phases.
After `git worktree add` succeeds, the worktree tool validates and canonicalizes
the exact root, atomically persists it through the Runtime-owned Session
registry, and only then returns it. A persistence failure rolls the Git
worktree and branch back instead of exposing an uncovered path. Both shell and
trusted-text authority construction read that same live registry, so their
authorized roots remain compatible in the creating Run and later Runs. On load, each
root must again prove bounded `.git`, `gitdir`, `commondir`, `HEAD`, and backlink
records that resolve to the Session repository's common Git directory. Removal
captures the canonical root before Git deletes the directory, then removes and
atomically revokes it; an unregister failure makes the tool fail rather than
reporting a successful policy transition. When the Session root is a Git
submodule, its main common directory is accepted only if the canonical gitdir
is under `.git/modules/` and a byte-bounded `core.worktree` value points back to
that exact Session root; the newly registered candidate must still satisfy the
ordinary linked-worktree backlink checks. For a pre-correction Session with no
registry field, migration considers only an exact successful `worktree_create`
tool result retained in canonical messages or UI history and repeats the full
Git validation before persisting it. A successful retained `worktree_remove`
acts as a conservative tombstone across both evidence sources. Roots are never
inferred from directory names. If the create evidence is unavailable, the
background process must be stopped and the worktree removed/recreated through
KodaX once; an unregistered pre-correction root remains removable.

The same release implements Session-scoped event journals and cursor-bound
replay, the F289/F290 Memory review and lesson pipelines, and F292's
conversation-first Memory management. Terminal startup restores terminal Runs
from authoritative status records without replaying their complete event
journals unless queued interrupt input requires reconciliation. The semantic
repo-intelligence Worker retires after its warm cache becomes idle, while
Agent Home, learned-root, and Windows sandbox enforcement remain host-owned and
fail closed.

`package.json` exposes:

| Export | Build artifact | Source intent |
|---|---|---|
| `.` | `dist/index.js` | Root SDK and CLI-facing helpers. |
| `./agent` | `dist/sdk-agent.js` | Generic agent framework. |
| `./llm` | `dist/sdk-llm.js` | Provider abstraction. |
| `./coding` | `dist/sdk-coding.js` | Coding agent SDK. |
| `./media` | `dist/sdk-media.js` | Agent-layer media/input artifact helpers. |
| `./repl` | `dist/sdk-repl.js` | REPL/config/session helpers. |
| `./skills` | `dist/sdk-skills.js` | Focused skills subset. |
| `./mcp` | `dist/sdk-mcp.js` | Focused MCP subset. |
| `./session` | `dist/sdk-session.js` | Public session-management subset. |
| `./runtime` | `dist/sdk-runtime.js` | Stable host Runtime facade and daemon protocol/schema exports. |
| `./sandbox` | `dist/sdk-sandbox.js` | Explicit ASRT capability, setup/doctor, and host-owned contained execution. |
| `./a2a` | `dist/sdk-a2a.js` | Bidirectional A2A 1.0 client/server integration edge. |
| `./experimental-memory` | `dist/sdk-experimental-memory.js` | Opt-in governed Memory Agent and scoped session contracts. |

The build path is:

```text
npm run build
  -> tsc -b tsconfig.build.json
  -> copy built-in skills and provider capabilities
  -> scripts/build-bundle.mjs
  -> scripts/build-dts.mjs
```

The bundle build also emits `dist/semantic-worker.js`,
`dist/runtime-worker.js`, and `dist/constructed-handler-worker.js`. These are
explicit npm/binary sidecars; CI builds them before tests so clean checkouts do
not depend on source-only Worker fallback resolution.

Only `llm`, `agent`, `coding`, and `repl` are workspace package build roots.

## 3. Main Entry Points

| Area | Current file(s) | Notes |
|---|---|---|
| CLI bootstrap | `src/kodax_bootstrap.ts`, `src/kodax_resume.ts`, `src/kodax_cli.ts` | The bootstrap handles bare `-r` with a lightweight picker, then loads the full CLI only after selection. |
| Coding SDK | `packages/coding/src/agent.ts` | `runKodaX(options, prompt)` delegates through `Runner.run`. |
| Coding preset | `packages/coding/src/coding-preset.ts` | Declares the default coding agent and substrate executor. |
| Continuous SDK | `packages/coding/src/client.ts`, `running-session.ts` | `KodaXClient` and non-blocking session handle. |
| Runtime SDK | `src/sdk-runtime.ts` | One service facade for inline, Worker-hosted, and daemon ownership. Managed `onComplete` is not terminal authority. |
| Durable state lock primitive | `packages/agent/src/learning/store-lock.ts` | Exact state-file ownership where a subsystem still needs it; not part of shell/write/worktree admission. |
| File mutation ordering | `packages/coding/src/tools/_internal/file-mutation-queue.ts` | Same-path process-local ordering and inert compatibility lease exports; no cross-process command-lifetime fence. |
| Managed terminal commit | `packages/coding/src/task-engine/runner-driven.ts` | Session snapshot before completion; repo/task projection is asynchronous. |
| Runtime daemon | `src/runtime-daemon/` | Versioned protocol/schema, socket transport, owner state/lock, host, client, and process launcher. |
| Runtime Worker | `src/runtime-worker/` | MessagePort host that reuses the daemon dispatcher/client and supports hard termination. |
| Generic agent | `packages/agent/src/primitives/runner.ts`, `agent.ts` | Layer-A Runner and Agent primitives. |
| REPL | `packages/repl/src/index.ts` | `runInkInteractiveMode`, classic mode, config/session exports. |
| First-run setup | `packages/repl/src/common/provider-setup.ts`, `packages/repl/src/interactive/provider-setup.ts`, `src/provider-setup-cli.ts` | Catalog-backed readiness inspection + revision-checked non-secret persistence, standalone pre-Runtime terminal flow, and CLI eligibility gate. |
| LLM providers | `packages/llm/src/providers/registry.ts` | Built-in aliases and custom provider registration. |

### 3.1 Runtime Host Facade

`createKodaXRuntime()` defaults to `{ mode: 'embedded', isolation: 'inline' }`.
`isolation: 'worker'` starts `dist/runtime-worker.js`, initializes the normal
runtime protocol over `MessagePort`, and always calls `Worker.terminate()` after
the shutdown grace period. `mode: 'daemon'` starts or attaches to a detached
`kodax daemon serve` owner at the profile-default endpoint. Custom daemon
endpoints are attach-only.

When the host is packaged Electron, daemon auto-start launches through an
internal Node bootstrap and scrubs `ELECTRON_RUN_AS_NODE` before loading the
daemon entry. Ordinary user children inherit the scrubbed environment. The
path requires Electron's `RunAsNode` fuse; disabling it requires an ordinary
Node/CLI-started daemon and attach-only SDK mode.

All forms expose `identity`, `sessions`, `runs`, `events`, `permissions`,
`workflows`, `config`, `catalog`, `mcp`, `artifacts`, `status`, and
`diagnostics`. The deployment-specific close contract is intentional:

| Form | `close()` | Sharing | `hardDispose` |
|---|---|---|---|
| inline embedded | closes private Runtime state cooperatively | no | false |
| Worker embedded | requests shutdown, then terminates Worker | no | true |
| daemon client | closes only that transport | yes | false |

`requirements.hardDispose` is checked for all three forms. Worker-only options
without `isolation: 'worker'`, or any explicit embedded isolation combined with
daemon mode, are rejected rather than ignored.

`CreateKodaXRuntimeOptions.execPolicy` and `.autoReview` are trusted host-owner
inputs in every ownership form. Inline and Worker hosts receive them through
their owner bootstrap. A detached daemon receives them only while a new owner
is auto-started, through a bounded one-shot file under its daemon state root;
the daemon consumes and deletes the file before extension loading. The client
protocol never carries these fields. Supplying them while attaching an existing
daemon fails closed instead of mutating or silently reusing a different
administrator policy.

`RuntimeSessionSettings.permissionMode` persists one of four profiles:
`plan`, `accept-edits`, `auto`, or `full-access`. `auto-in-project` is accepted
only at read boundaries and immediately canonicalized to `auto`. Legacy Auto
engine fields are ignored on input and omitted from new writes; Auto is always
Auto[LLM]. The optional `autoModeClassifierModel` remains a reviewer-model
override, while `config.json#autoReview.policy` supplies only the configurable
security-policy body.

Plan rejects mutations. Edits and Auto attempt the Runtime-owned workspace
sandbox first, with broad reads, workspace/platform-Temp writes (a private
per-command Temp child on Windows), external network,
and the inherited host environment. A completed sandbox execution is final and
silent. Only a proven pre-start denial or unavailable backend reaches Exec
Policy and then the Edits user boundary or Auto reviewer. A started or uncertain
target is never replayed. Full Access skips sandbox and Auto review and runs on
the host after Exec Policy.

Auto review is lazy and run-owned: sandbox success does not require a reviewer
model. Host-boundary review uses fixed role/schema and bounded input, a 90-second
attempt, and one 180-second retry only for timeout, provider, or invalid-output
failure. Explicit deny is terminal. Three consecutive denies, or ten of the
last fifty completed reviews in one turn, stop that turn without changing mode.
Infrastructure failure blocks the boundary and tells the Agent to choose a
safer route; it never opens an automatic permission prompt, falls back to Edits,
or switches to Auto[RULES]. A later informed natural-language instruction is
part of a fresh semantic review.

Daemon and embedded capability metadata advertise the same four canonical
profiles, the `auto-in-project` input alias, fixed reviewer attempts, and the
Runtime-owned boundary route. Capability checks accept `advertised >= required`;
auto-start may fence and replace an idle older daemon, but attach-only/busy paths
return a recoverable error without mutation. Version comparison follows SemVer:
an older idle owner is replaced, an active older owner is never force-killed,
and an older client does not downgrade a newer owner.
An invalid or otherwise non-comparable daemon version is a recoverable,
zero-mutation boundary; only a version proven older may trigger version
self-healing.

`sideQuery()` owns a fixed-field `SideQueryDiagnostics` envelope: provider,
model, effective timeout, elapsed time, retry count/wait, optional first-output
and stream durations, and a coarse terminal phase. It copies no prompt or
response content and does not invent connect/queue timings unavailable from
provider adapters. Guardrail tracing creates a pending child span before the
callback and finalizes its verdict/error after the await.

On a bare TTY launch, `src/kodax_cli.ts` runs the root-owned setup coordinator
before Runtime/extension/session creation. It validates every existing
core/MCP/Extensions/A2A active file, preserves readable legacy integration
declarations, and creates only missing active files/templates while holding
the shared configuration lock and rechecking revisions. Any invalid active
file fails before all writes and before the provider wizard. Only
`needs-provider` enters the non-secret provider interaction; selected providers
missing credentials preserve their existing error path. `kodax setup` invokes
the same coordinator explicitly, while `setup --help` returns before side
effects. Writers use SHA-256 revisions, same-directory temporary files,
restrictive modes, and atomic rename while preserving unrelated keys.

The Worker and daemon facades reuse `runtime-daemon/server.ts` and
`runtime-daemon/client.ts`; there is no duplicate service implementation.
Protocol methods are schema-validated, run results preserve serialized errors,
and pending event notifications are bounded while a remote subscription id is
being established. Non-terminal persisted runs become `interrupted` after an
owner restart. Reconnection is explicit; automatic replay of an unknown
in-flight operation is forbidden.

Runtime event persistence is Session-owned. Each Session has an independent
`sequence`, `sequence.lock`, and journal epoch under
`.kodax/runtime/session-events/<encoded-session-id>/`; Run event bodies remain
in their bounded `events.jsonl` files. A cursor is the complete
`{ sessionId, journalEpoch, seq }` tuple and is comparable only within that
Session journal. Public event subscriptions/replay require a `sessionId` or
`runId`; a Run scope resolves its owning Session before cursor validation.
Internal Run diagnostics may merge root and managed-child Session events by
timestamp, but that aggregate has no resumable numeric order. Retention
watermarks are keyed by both Session and journal epoch; legacy numeric or
Session-only watermarks cannot invalidate a new journal. Every Run also keeps
a durable journal-identity index, so a corrupted watermark remains attributable
after all managed-child event rows have been trimmed and cannot poison an
unrelated Session when that index is valid. If the index is absent or corrupt,
non-membership is unknowable and cursor replay conservatively requires resync.
Deleting a Session rotates its journal before the same ID can be reused. A
persistence failure is latched only for the affected Session, so a blocked
writer cannot poison other Session queues in the same process.
There is no numeric-cursor compatibility path because it cannot detect journal
replacement. Legacy Runtime-global event files are left untouched for audit
and ignored by live replay. Inline, Worker, and daemon owners share this code,
while `sessionEventJournal:1` prevents a new client from attaching to an old
daemon with different ordering semantics.

Live provider output is not reconstructed from Run-wide cumulative text.
`output.segment.started` records `{ responseId, providerRequestId, mode }`
before the corresponding text or reasoning deltas. The shared reducer keeps
completed append segments, replaces only the active segment of the same
logical response, resets on a new `responseId`, and ignores stale deltas whose
`providerRequestId` is no longer active. Runtime replay remains an unfiltered
audit journal; `RuntimeSessionLiveProjection.outputSegmentsByRun` is the
effective reconnect/snapshot authority. New clients require
`liveOutputSegments:1`, so hosts do not need a checkpoint replay state machine.

Complete Runtime exit is similarly a durable SDK transaction rather than a
host-side sequence of stop, close, and cleanup guesses. The settlement ticket
records exact owner/process-start and boot identities before stop; Windows may
repair only verified empty Job/ACL residue, while same-boot POSIX uncertainty
returns `blocked` and retains the ticket. The public API exposes bounded
`clean`, `recovered`, and `blocked` outcomes without exposing raw kill or ACL
mutation primitives.

#### 3.1.1 Shared Coder daemon consistency (FEATURE_269)

`sessions.observe(sessionId, listener)` installs a server subscription first,
takes a stable snapshot, and returns its `runtimeId` plus cursor. The daemon
client buffers at most 256 handshake notifications; overflow returns
`resync_required`. Consumers replace their derived projection on reconnect or
Runtime change instead of merging two authority epochs.

Daemon mutations require the authenticated client's operation capability and
an `{ journalEpoch, operationId }` envelope. The append/fsync control journal
records accepted/dispatched/applied/rejected facts and binds reuse to principal,
method, resource, and canonical request digest. Accepted work becomes
`interrupted` after restart; dispatched work becomes `unknown`; neither is
automatically executed again. Corrupt control history quarantines all
mutations while read/status operations remain available. Run status and
versioned settings/grants use atomic temp-file + fsync + rename writes.

The packaged daemon has one random token per `homeDir + profile`, protected by
the local OS-user filesystem boundary. Its host grants the advertised scope
set to token-authenticated connections. `clientInfo.instanceId` is stable
attribution used by operation receipts; it is not a per-application secret.
Renderer/model surfaces must therefore remain behind a trusted host such as
Electron Main and never receive the profile token.

Same-session run creation allocates a monotonic `sessionOrder`. `after_turn`
input is a real queued continuation run and accepts the same operation
contract. `interruptInput:1` routes input into the current active Actor Run's
process-local queue. A tool boundary drains accumulated interrupt inputs FIFO,
preserves their separate user-message boundaries, and emits one ordered
`run.input.delivered` batch before the next LLM request. When a managed Runner
or ordinary coding loop recognizes a terminal candidate, it synchronously
closes admission before any asynchronous finalization, drains every input
accepted before that line, and continues the same Run when the batch is
non-empty. If that batch arrives at the configured iteration ceiling, the loop
reserves exactly one additional generation turn so delivery cannot be recorded
without model consumption. Admission reopens only after the batch is committed,
or while idle-yield is waiting on a wake path that guarantees another model
turn. Both the managed Runner and ordinary coding substrate permit only a fixed
internal number of lifecycle-reserved iterations beyond the configured ceiling
and close admission before the final absolute generation starts. An admitted
manifest's `maxIterations` remains a non-expandable governance cap. Failure,
cancellation, and terminal cleanup close admission before asynchronous teardown.
Ordinary coding rotates live-turn attribution for the queued prompt and commits
the preceding assistant response before continuing a COMPLETE signal. The
mechanism creates no continuation Run.
Run status exposes queued/delivered/terminal input state; terminal cleanup
removes undelivered queue entries. Runs without a same-Run safe Actor boundary
return `unsupported_capability`, while queued or terminal targets return
`stale_run`. Submissions after the atomic terminal boundary return
`interrupt_window_closed`; clients must restore the unsent input for retry
rather than silently converting it to `after_turn`. External aborts and
terminal errors also close the window. Non-terminal observer diagnostics do not
close a still-consumable window. AskUser and permission
registries expose pending lists and first-winner responses over transport.
They have independent owner deadlines (five minutes by default). Permission
expiry resolves as a typed `reject` with `cause: approval_timeout`; an SDK host
uses `handleRuntimePermissionRequest()` so owner resolution aborts its UI
prompt and a late answer cannot hold or revive the event chain. AskUser expiry
accepts only a Runtime-validated `default` option value (or input default); a
missing or invalid default dismisses the request. The same AbortSignal linkage
is used for embedded host callbacks, so timeout behavior is not daemon-UI-only.
Permission request timeout overrides are non-negative safe integers bounded by
the Node timer maximum; explicit absolute deadlines must also fit that horizon.
MCP reverse elicitation carries the agent-layer AbortSignal through the same UI
surface and cancels after the five-minute interaction bound instead of leaving
an untracked host Promise alive. SDK user-input timeout overrides must be
positive integers no greater than 2,147,483,647; permission timeout overrides
use the same upper bound and retain `0` as the existing timer-disable value.
Invalid values are rejected before embedded, Worker, or daemon startup.
Persistent permission grants have one daemon-owned revisioned store. A concrete
permission request may expose opaque
Runtime-issued Session and persistent grant suggestions. Clients can select a
suggestion id but cannot submit or widen its hidden matcher. Command matchers
bind the normalized shell command fingerprint, effective cwd, shell family,
background mode, executable, and argv fingerprint; quoting or wrapper changes
remain distinct. Path matchers are limited to known built-in file tools and
bind one tool to one normalized absolute path, not to one Write/Edit body.
Extension, MCP, and other unknown tool shapes use an exact-call matcher even
when their input happens to contain a field named `path`, and are eligible only
for an in-memory Session grant. High-risk, absolute-deny,
dangerous-pattern, and dynamically expanded shell calls never receive a
persistent suggestion. New grants are revisioned and audited; legacy
`toolName`/`sessionId` grants remain listable, matchable, and revocable but are
never created by the new flow.

The credential reverse bridge stores only lease metadata. It requests the
secret from the registering connection for a bound provider/session/run and
places it in `AsyncLocalStorage` only for provider execution. An active scoped
credential never falls back to daemon environment on provider mismatch. The
Host Tool bridge creates an extension runtime only for the bound run, bounds
result size/time, memoizes invocation handling client-side, and classifies a
lost dispatched result as `host_outcome_unknown` without replay.

`homeDir + profile` has one Coder owner-policy file and one cross-process fence
shared by daemon and inline ownership. CAS policy changes make rollback to
inline sticky. Partner compatibility depends on the embedder retaining its
existing distinct inline data/sessions root; Partner does not acquire or write
the Coder owner fence.

`enableKodaXDaemonOwner()` is the atomic convergence command for returning an
inline profile to daemon policy. While holding `owner-policy.lock`, it rereads
the policy and owner fence, removes only an exact `kind: inline` owner whose OS
process identity is proven gone, and then commits the policy revision. Unknown
liveness, malformed/legacy fences, and daemon-kind fences are not repaired by
this synchronous path. New owner records include an optional process-start
identity so PID reuse cannot be mistaken for the original owner.

Actor Session snapshots separately persist one exclusive Runtime owner.
Current owners expose a Runtime-scoped loopback liveness challenge, so a
contender can distinguish that exact owner from an unrelated process that
reused its PID. A refused or completed mismatched challenge proves stale;
timeouts, unknown failures, and legacy owners without challenge evidence remain
fail-closed.

`runs.start({ options })` is transport-safe data in Worker/daemon forms. The
client rejects functions, symbols, bigint, cycles, non-finite numbers, and
class instances. CLI integration additionally rejects known process-local host
bindings rather than deleting them. Host-specific callbacks/extensions must be
configured in the Runtime owner or use inline mode.

## 4. Coding Run Sequence

```text
runKodaX(options, prompt)
  -> applyFollowupEscalationToOptions
  -> Runner.run(createDefaultCodingAgent(), prompt, presetOptions)
  -> Agent.substrateExecutor
  -> runSubstrate
  -> provider stream + tool loop
  -> sidecar stop hooks as needed
  -> KodaXResult
```

Important contracts:

- `runKodaX` must return the full `KodaXResult` lifted through
  `RunResult.data`.
- `Runner.run` remains generic and cannot depend on coding-specific modules.
- Coding-specific state travels through `presetOptions`, not through global
  Runner configuration.
- Sidecar verifier can ask for revision, but the Worker remains the main task
  owner and final-answer author.
- AMA strategy is selected stage by stage from the shared pattern catalog.
  Actor turns store validated opaque metadata; coding derives a bounded,
  fact-only `PatternTrace` for the existing Sidecar rather than adding a
  scheduler or quality gate.

## 5. Provider Design

`packages/llm` owns provider concerns:

- `providers/registry.ts`: built-in alias registry and custom provider loading.
- `providers/provider-capabilities.json`: capability metadata snapshot.
- provider implementations: Anthropic, OpenAI, compatible providers, CLI
  bridges.
- `side-query.ts`: out-of-band provider calls for verifier-style use.
- shared stream/result types and error normalization.

Built-in aliases are:

```text
anthropic, openai, deepseek, kimi, kimi-code, qwen, zhipu,
zhipu-coding, zai-coding, minimax-coding, mimo-coding, mimo, ark-coding,
gemini-cli, codex-cli
```

For `kimi`, `providers/provider-capabilities.json`, `cost-rates.ts`, and the
OpenAI-compatible request serializer jointly define the public K2.7
Code/HighSpeed and K2.6/K2.5 contract. K2.7 rejects thinking-disable requests;
K2.6 emits the required wire toggle. Optional live-key tests are gated and do
not run during the default offline suite.

For `kimi-code`, the default is the direct upstream `k3-256k` Model ID.
`kimi-for-coding` remains available for K2.7 Code beside the 1,048,576-token
`k3` tier and `kimi-for-coding-highspeed`. The Anthropic- and OpenAI-compatible
serializers carry K3 reasoning through `thinking.effort`, default omitted
effort to `high`, and preserve explicit disable semantics. Media capability
metadata keeps `k3-256k` image-capable and video-unsupported. Public Kimi and
Kimi For Coding credentials remain separate.

For the Zhipu Coding Plan aliases, `provider-capabilities.json` defines both
`glm-5.3` and `glm-5.2` as 1M-context routes. `zhipu-coding` and
`zai-coding` and `ark-coding` all default to 5.3 while keeping `glm-5.2`;
`ark-coding` retains the `glm-latest` alias. `registry.ts` sends
the chosen ID verbatim. The GLM-5.3 reasoning preset maps none/minimal/light/low to low,
medium/high to high, and xhigh/max/ultra to max. Its Anthropic-compatible
serializer emits adaptive thinking plus `output_config.effort`; an attempted
disable is normalized to low because this model does not support disabled
thinking.

OpenAI-compatible provider configuration carries
`maxOutputTokensField: 'max_tokens' | 'max_completion_tokens'`. A model
descriptor overrides the provider value; absent configuration uses
`max_completion_tokens`. DeepSeek V4 Flash and Pro use separate reasoning
presets so their effort aliases do not drift, while legacy
`deepseek-v4-openai` configuration migrates by known model ID and preserves
Pro-like behavior for unknown IDs. Capability metadata marks both routes
text-only, and cost tracking keeps their base/cache rates separate.

`KodaXProviderStreamOptions.promptCacheKey` is separate from the transport
`sessionId`. Coding derives a domain-separated SHA-256 value from the stable
logical context ID: the root uses its resumable Session identity and a child
uses `${root}/agent/${encodeURIComponent(canonicalAgentId)}`. AMA, SA, retry,
max-token continuation, non-streaming fallback, and compaction reuse the same
value. `disablePromptCache` omits it. Anthropic- and OpenAI-compatible
serializers emit the protocol field only when `promptCacheAffinity` is enabled;
built-in Kimi Code, public Kimi, and official OpenAI are verified opt-ins, while
custom gateways default off. `provider.cache.diagnostics` reports a separate
`promptCacheAffinityHash` only when the configured Provider applies the key;
the hash does not enter `requestEnvelopeHash` because routing metadata does not
change prompt bytes.

Codex CLI `turn.completed` usage maps `cached_input_tokens` and
`cache_write_input_tokens`; Gemini CLI `result.stats.cached` maps cache reads.
The shared CLI event and pseudo-ACP path preserve those optional counters
without adding them to input totals. Parsers retain explicit zero, omit invalid
or absent counters, and reject malformed required core usage instead of
manufacturing all-zero records. Runtime realtime/latest diagnostics preserve
the same property-presence contract through JSON persistence and daemon
transport.

ACP conversation IDs and native CLI resume IDs are distinct namespaces. The
pseudo-ACP bridge starts a new ACP conversation with no CLI resume argument,
binds that ACP ID only after a `session_start` event reports a non-empty native
ID, and uses the native ID on later prompts in that same explicit
conversation. `KodaXAcpProvider` caches ACP sessions only for an explicit
transport `sessionId`; stateless calls create and release a fresh ACP session
and cannot share a process-global default. A non-zero CLI process exit rejects
the ACP prompt instead of becoming an empty successful completion. Provider
singletons share one in-flight connection promise and clear it after failure;
overlapping prompts for one explicit conversation are rejected before they can
replace active stream routing. Normalized CLI error/failed-completion events
and pre-aborted requests fail closed. Reconnects obtain a newly constructed
pseudo transport rather than reusing closed streams, abort operates through
the bridge-held reader/writer endpoints, and disconnect closes a pending
handshake immediately. A transport closure invalidates the connected client
and its ACP-session map before retry. A successful completion event is not
returned until the CLI generator has been exhausted and its process exit
validated; normal exhaustion without a completion event is rejected.

Custom provider design must remain data-driven: protocol, base URL, API key env
var, default model, reasoning preset/profile, multimodal support, forced tool
support, timeout normalization, and session semantics belong in provider
config/capabilities.

## 6. Tool Registry

Built-in tools are declared in
`packages/coding/src/tools/tool-definitions.ts`.

Each definition carries:

- `name`,
- human-readable LLM description,
- JSON input schema,
- handler function,
- side-effect classification,
- optional classifier projection.

Tool handlers live beside their definitions under `packages/coding/src/tools`.
The registry consumes flat data; avoid hidden factory layers or circular
dependencies.

Current tool families:

- file: read/write/edit/multi-edit/insert/undo;
- shell and search: bash/glob/grep/web/code/semantic/LSP;
- repo intelligence: overview, changed scope/diff, module/symbol/process
  context, impact estimate, cyclic dependency checks;
- MCP: search/describe/call/resource/prompt;
- child tasks: dispatch/send/stop/output;
- product state: goals and todos;
- construction: tool generation, agent generation, self-modify staging.

## 7. Permissions And Guardrails

Permission enforcement is runtime behavior, not just prompt text.

Key concepts:

- permission modes come from REPL/CLI options and config;
- tools declare side-effect class;
- Plan rejects mutations; Edits and Auto[LLM] first attempt the OS sandbox;
- sandbox completion is final authority, while only a proven pre-start
  denial/unavailability reaches host Exec Policy and the profile boundary;
- Auto review returns allow/deny only at that exact host boundary and never
  manufactures a shared permission request; an allow produces one host attempt;
- Full Access skips sandbox and Auto review but still applies administrator
  forbids, explicit Exec Policy, and the narrow critical-effect fallback;
- trusted-local workflow scripts require explicit confirmation;
- verifier and stop-hook failures fail open where blocking would trap the user.

`gitRoot` constrains the session repository boundary. `executionCwd` is the
working directory used to resolve relative operands and is independently
validated to remain inside that boundary. Path extraction must not treat quoted
Python, JavaScript, or regular-expression source inside a shell command as a
path. Permission `inputPreview` is a bounded, credential-redacted JSON object
that remains parseable even for a large write input and records the effective
execution directory. Tool exposure removes `exit_plan_mode` unless an
`events.exitPlanMode` approval bridge exists for the active run.

When `context.shellExecution` is present, `normalizeShellExecutionContract()`
admits only version 1 and the bounded `pwsh` / `powershell` / `cmd` / `bash` /
`zsh` forms. Host arguments cannot override KodaX command, persistence,
profile, server, or working-directory flags. `resolveShellExecution()`:

1. canonicalizes the effective cwd;
2. inherits the host bootstrap environment while removing only the fixed
   KodaX/Electron execution-control variables;
3. loads the selected profile and trusted setup in that cwd;
4. captures the environment through a random framed payload with timeout and
   output bounds;
5. validates and filters it again before explicit-interpreter execution.

The in-memory cache key includes normalized contract bytes, canonical cwd,
Session scratch identity, and a generation. TTL is capped;
`refreshToken`, daemon restart, or `clearShellExecutionEnvironmentCache()`
invalidates the result. In-flight probes are waiter-counted: one cancelled
caller does not kill another caller's shared probe, while the last waiter
terminates it and cannot populate the cache. Native children, nested Actors,
Workflow leaves, and deterministic evaluators inherit the contract. Exact
command permission matchers bind the interpreter family and contract SHA-256.
No contract keeps `shell: true` plus the legacy process environment.

Shell command targets inherit the host environment, including ordinary
development identity. A fixed internal deny set removes KodaX/Electron
execution-control variables. The legacy `sandbox.envPass` config, environment,
and SDK input is inert and is not written or advertised by new clients.

The default terminal bindings keep Shift-Tab for the four permission profiles
and Shift+Enter for newline input. Rapid changes enter the per-Session Runtime
settings queue in input order, so the final visible mode is also the final
persisted mode. `auto-in-project` and legacy Auto[RULES] inputs normalize to
Auto[LLM]; `/auto-engine` no longer exists.

Shell containment is the first authority for Edits and Auto[LLM]. Windows uses
the native v2 runner and Linux/macOS prepare one ASRT invocation per command.
A completed sandbox invocation returns its result without permission or LLM
review. A proven pre-start denial/unavailability reaches Exec Policy and the
profile-specific host boundary; an allow can start the host target once.
Post-start or uncertain failure never retries the target. Full Access skips the
sandbox and reviewer and goes directly through Exec Policy. The `/sandbox` command and
`tool.sandbox` events expose diagnostics without entering ordinary history.
The separate `src/sdk-sandbox.ts` API deliberately has no such fallback:
`runKodaXSandboxed()` returns a typed `unavailable` result when containment
cannot run. POSIX completion additionally requires an applied target-start
observation; only a proven wrapper spawn failure returns `backend_launch_failed`
with bounded diagnostics. A spawned wrapper without target-start authority is
`execution_uncertain`. Request authority travels on
broker stdin and target-start/fallback authority returns through a bounded FD3
frame bound to the invocation and expected backend; the target never inherits
that descriptor. Missing or invalid authority is `execution_uncertain`, not a
retryable not-started result. Broker-control collection and request cleanup
settle independently, so a control close/error/overflow cannot bypass cleanup.
Background execution is acknowledged only after the wrapper exposes an OS PID;
asynchronous spawn rejection is handled by the same proven pre-start boundary
and is never rendered as `PID: undefined`. Per-command settlement and output
capture attach immediately after spawn, before start attestation, so a fast
target cannot exit through an unobserved lifecycle window. The internal
workspace-shell adapter allows broad
host reads, including Agent Home, credential locations, and global Git
 configuration. Writes remain bound to canonical workspace roots and system
 temporary directories. The standalone SDK executor keeps its caller-owned
 filesystem boundary.

Windows v2 no longer injects the protected native artifact-cache root into each
request's `denyWrite`: the native control boundary already prevents direct
sandbox access, and the redundant deny collided with that verifier. Historical
cache-root deny ACEs are not automatically removed: SID shape, mask, owner, and
the surrounding canonical boundary still cannot prove whether an individual
entry came from KodaX or an administrator. Provisioning preserves such denies,
and ordinary admission no longer treats their presence as a request-policy
conflict.

Do not add a new permission bypass path for convenience. Route effects through
the tool layer or an existing capability API.

## 8. Child Task Coordination

Child Agents are controlled through one Runtime-owned Actor/Turn tree:

- `spawn_agent`, `send_message`, and `followup_task` start or steer work;
- `wait_agent` yields for scoped mailbox activity; `list_agents` observes the
  current tree; `agent_output` reads a known Actor/Turn result;
- `interrupt_agent` requests active-turn cancellation;
- one scheduler, mailbox, event stream, and root-owned work budget cover native,
  constructed, Workflow-owned, and external turns.

The model-visible `wait_agent` schema contains only `timeout_ms` (10 seconds to
1 hour, default 2 minutes). The handler subscribes to the caller's MessageQueue
with read-register-recheck, does not consume the wake message, and returns one
of `mailbox`, `user_input_pending`, `wait_expired`, or `interrupted`. The
Runner's next-turn hook drains background priority only when the previous tool
set included `wait_agent`. Ordinary tools drain user-priority traffic: real
user prompts remain real turns, while urgent Actor follow-ups remain synthetic.

Message mode determines transcript authorship. `prompt` becomes a real user
turn. `agent-message`, `task-notification`, and `system-reminder` become
synthetic Runtime context; completion metadata is preserved for deterministic
Todo/receipt handling. Actor event snapshots and long-poll remain separate SDK
and daemon APIs, so removing raw-event selectors from the model tool does not
remove SDK telemetry capability or require a control-plane version bump.

Completion delivery is crash-recoverable. Actor snapshots persist completion
messages, acknowledgement IDs, and an explicit pending-root-delivery set;
initialization republishes only completions in that set. Legacy snapshots lack
the set and do not infer replayability from historical mail. The Coding
projection deduplicates by scoped child-task
`turnId`, so a hard restart restores a missing process queue while a same-process
Runtime rebuild does not duplicate an entry that is already pending.

Actor identity outlives an individual Turn. Capability ceilings are inherited,
concurrency and budget admission are atomic, and stale mutations conflict on
the Actor revision instead of silently joining newer work. The main Worker uses
children for bounded parallel investigation or specialist work. Children do
not own final response. When pending children remain and the
main Worker has no useful work, idle-yield is the wait mechanism.

The full Actor revision remains the persistence and general mutation fence.
Strategy admission uses a separate admission revision that advances only for
Actor/Turn state relevant to accepting work; progress and mailbox updates do
not invalidate it. Coding serializes only the brief admission section, keyed by
a stable identity shared by every client bound to the same Actor tree, so
validation and mutation are ordered while admitted child Turns continue to
execute concurrently. Legacy snapshots and custom clients fall back to the
full revision and per-client admission identity.

`packages/coding/src/orchestration/pattern-catalog.ts` is the shared semantic
source for the six AMA/Workflow pattern names.
`pattern-strategy.ts` validates optional `quality_strategy` metadata at the
coding boundary, while `pattern-trace.ts` derives delegated-stage facts from
trusted Actor Turn metadata and result envelopes. The agent controller stores
the metadata opaquely and prevents a running Turn from switching strategy.
Root-only work creates no synthetic stage; old or unsupported paths carry no
fabricated trace.

The queue routing key for user follow-ups is derived from the session and root
Actor. MessageQueue, idle-yield wake subscriptions, StreamingContext, and the
Ink queued-input view all filter by that same key; a process-global
`agentId: undefined` bucket is not a REPL session contract.

## 9. Stop Hooks And Sidecar Verifier

Generic stop-hook infrastructure lives in `packages/agent`.
KodaX-specific verifier behavior lives in `packages/coding`.

Design split:

- `packages/agent/src/runtime-middleware/llm-judge.ts`: generic LLM-judged
  stop-hook primitives.
- `packages/coding/src/agent-runtime/middleware/sidecar-verifier`: coding
  verifier prompt, gate, parser, and integration.
- content-aware gate skips trivial conversational turns.
- verifier accept is silent by default in UI but preserved in session/artifacts
  where applicable.
- when that gate fires, the Sidecar packet may include a bounded
  `PatternTrace` and quality signals as context, never as proof; a `revise` or
  `blocked` verdict may carry one focused optional strategy recommendation.

The verifier is not an in-chain Evaluator role. Do not represent it as a second
visible agent in current product docs.

## 10. Sessions And Storage

Session behavior spans agent, coding, and repl:

- `packages/agent/src/session-lineage`: lineage model and compaction helpers.
- `packages/repl/src/session/public-api.ts`: public session SDK.
- `packages/repl/src/interactive/storage.ts`: file-backed storage behavior.
- coding runtime records snapshots, runtime session state, and result metadata.
- `SessionData.uiHistory`: optional bounded replay cache for sanitized terminal
  tool groups. It is a display projection, not the canonical model transcript.
  Resume must first derive and bound visible history from canonical `messages`;
  a non-empty, sparse, or damaged `uiHistory` may enrich that baseline or add
  explicitly display-only entries, but must never suppress canonical
  conversation items or create ordinary user/assistant/thinking conversation.
  Presentation-only synthetic completion events (`agent-completed` and legacy
  `task-completed`) are the exception: a non-empty `uiHistory` owns whether the
  CLI displayed them, while headless/no-cache restore derives them from messages.
  Failed-turn Assistant summaries, Sidecar verifier verdicts, and terminal
  errors may also be marked `presentationOnly: true`; valid text items make an
  otherwise context-empty Session resumable, persist exactly once across write
  retries, and replay in that order without entering canonical model context.

Public session APIs should preserve id-based usage while allowing storage layout
to evolve. New storage features must be backward-compatible with old JSONL
records whenever practical. Host code should treat `loadSession()` as active
model context, `loadFullTranscript()` as append-order scrollback, and
`uiHistory` as an optional replay hint. Ordinary chat uses
`readConversationHistory()` or Runtime `sessions.conversation*`; it is neither
the active model context nor the raw audit stream.

Transcript entries expose both physical and logical identity. `entryId`
identifies the persisted lineage node; `logicalId` is stable across cloned or
forked copies; `sourceEntryId` points at the direct physical predecessor copy when an entry
is a clone, so every chained-compaction generation stays addressable (until
v0.7.89 it addressed the transitive root source). These fields support audit inspection but do not authorize a host
to fold by `logicalId` alone. The Session-owned ordinary-conversation projection
validates provenance and topology, reports unresolved ambiguity, and supplies
revision-fenced physical boundaries; `loadFullTranscript()` continues to return
raw append-order scrollback.

`FileSessionStorage.loadFullLineage()` is the storage-owned merge of the main
JSONL and island sidecar. Sidecar entries win for the same stable physical ID
because they carry the exact pre-eviction payload. Public transcript projection,
Runtime search, and model-facing history recovery all consume this one merged
lineage rather than independently guessing from `[compacted]` placeholders.
One shared evidence predicate excludes system/control entries, hidden-only
content, current and legacy synthetic history checkpoints, and compacted-body
placeholders from both search and direct read. Metadata ID ranking activates
only for a sufficiently specific direct identifier query, avoiding accidental
matches from short terms embedded in random IDs.

Rewind audit markers are stored as `rewind_marker` lineage entries. They are
visible through `loadFullTranscript().transcriptEntries` for host UI/audit, but
they are context-silent: `loadSession()` and `loadFullTranscript().messages`
exclude them. The public `/session` subpath also exposes `compactSession` for
host-triggered imperative compaction.

## 11. Skills

Skills live under `packages/agent/src/capabilities/skills`.

Invocation has two distinct trust paths:

- model invocation sees only metadata whose `disableModelInvocation` is false
  and the model `skill` tool rejects disabled entries;
- explicit user or SDK invocation can load every enabled Skill. REPL head
  commands (`/<name>`, `/skill:<name>`) and in-query slash tokens use the text
  after the token as `$ARGUMENTS`, then inject the expanded Skill for that turn.

Busy Ink follow-ups that resolve to a known Skill remain raw, user-authored
queue entries with `delivery: host`. AMA mid-turn drain, SA interrupt drain,
and idle-yield resume never splice those entries directly into model context;
the next host round performs the same resolve, expand, policy, hook, and
finalize pipeline as an immediate invocation. Built-in and extension slash
commands keep their existing mid-task guard. Both SA and AMA inject the active
Skill's full expanded content exactly once, including SA workflow children
that use a specialist `systemPromptOverride`.

Child delegation trusts only the structured `skillInvocation` supplied by the
host. That active Skill and its resource roots propagate to read/write children
even if the objective does not repeat its name. A slash token or `<skill>` block
present only in a model-authored child objective cannot manufacture user
provenance; it remains a model-tool request and therefore still observes
`disableModelInvocation`.

Tool policy is runtime-owned. Isolated transports carry only an enforcement
marker and rehydrate `allowed-tools` plus Pre/Post hooks from the runtime's
trusted registry; a bound registry is authoritative and absence fails closed.
Host registry objects and hook command strings never cross the JSON boundary.
Hook shell commands still require the runtime permission broker, and runtime
completion waits for all admitted `PostToolUse` hooks to settle.

`user-invocable` remains parse-compatible with existing `SKILL.md` files, but
enabled Skills always report as user-invocable and the field is not used as an
execution gate.

Core modules:

- discovery and plugin paths,
- skill loader and frontmatter parsing,
- skill registry and resolver,
- LLM expansion,
- built-in skills copied during build,
- `packages/agent/src/learning` for immutable learned revisions, canonical
  lifecycle records, project canary admission, usage/outcome receipts, and
  Learning Center actions,
- `packages/coding/src/learning-reviewer.ts` plus `memory-runtime.ts` for the
  bounded production review and Memory-first carrier decision.

The published `@kodax-ai/kodax/skills` subpath is a focused subset of agent
capabilities. It should not require importing the full coding package.

Learned Skill files are not self-authorizing. Runtime discovery requires a
matching canonical record, project identity, lifecycle, fingerprint,
regular-file checks, and formal-name policy. A testing revision permits one
concurrent root binding and three exact-revision invocations. Project trust is
established only after all three outcomes settle and at least one is an
independently verified success. Credible negative evidence quarantines
immediately; an exhausted canary without success returns the record to
Ready/attention. The locked invocation mutation rechecks the current artifact
revision and fingerprint before consuming a slot. Protected/formal
changes, user-global promotion, and Extension authoring require explicit user
authority through `runtime.learning` or `/learn`.

Remote and local project IDs hash to different learned-area roots. Discovery
opens each applicable store, applies remote-first precedence, and retains the
record-to-store mapping for admission, invocation, outcome, reconciliation, and
release. This includes `remote-hash:*` fallback. The public discovery config
accepts both deprecated `expectedScope` and optional `expectedScopes`. Discovery
pairs each physical root with exactly one expected scope, validates the pairing
before scanning even an empty store, and never accepts a stale cross-root scope.

Host-owned file mutation sinks keep their own namespace-integrity checks.
Ordinary Agent Home descendants, including `agents/*.md`, Sessions, tool
results, and intermediate artifacts, remain working data. Controlled file
sinks do not replace the Runtime, legacy `processes/children`, or `learned/`
lifecycle APIs; this is a non-shell host-namespace invariant, not a permission
profile or Full Access shell restriction. Legacy unauthenticated process records
are quarantined for diagnosis and never used as process-signal authority.
Shell reads are broadly available inside the workspace sandbox, including the
Runtime tree, Agent Home, credential locations, and global Git configuration.
Concrete Runtime, credential, security-control, and whole-home mutations become
reviewer facts only if execution reaches the Auto[LLM] host boundary; ancestor
traversal never inherits a child mutation exemption.

File mutation sinks recheck their host-owned namespace invariants immediately
before execution. Undo records context-local canonical path identities and
refuses restore after retargeting. Model-facing worktree creation ignores any
undeclared base path; only the workflow controller can supply its Runtime-owned
worktree base through trusted execution context. Since FEATURE_295, controlled
text sinks use the native trusted-text transaction described in section 3 and
never acquire the legacy cross-process filesystem-effect lease. Issue 326
removes that coordinator from worktree lifecycle as well; old state and lease
exports are migration-only inert data/API and cannot block current work.
Recognized shell mutations of the Agent Home root, Runtime, credentials, and
security configuration remain on the reviewable branch. Full Access skips this
reviewer; only administrator `forbid` policy and the narrow critical-effect
fallback remain non-bypassable.
Shell authorization remains independent from containment. Windows v2 uses ASRT
only for the network/account launch and the native host/runner path described in
section 3 for per-command restricted token, private desktop, framed stdio, and
creation-time Job containment. Different policies, Sessions, and Runtime
processes do not share a command-lifetime filesystem-effect lease. The
generation-8 migration proof records removal of exact obsolete KodaX
sandbox-account read-deny ACEs. Setup generation 9/protocol 9 reuses a healthy
fixed SID and filesystem nonce, upgrades generation 8 without replaying cleanup,
and publishes a protected marker whose handle gates target start. Ordinary
admission performs zero legacy cleanup or setup provisioning. The elevated
setup parent receives only an explicit base64 envelope naming a digest-bound
`installing` marker in protected control state and synchronously converges NUL
compatibility plus profile read capabilities; the caller publishes the ready
marker only after the parent succeeds, with no detached helper.
Native executable publication is separate from setup migration. Publication
uses the fixed System32 boundary to construct and verify owner/DACL state. Every
ordinary admission then verifies stable single-link file identity, physical
cache containment, and the content hash locally; it launches no PowerShell
verifier and treats no mutable timestamp as authority. If a new release hash has
no protected destination, the first caller publishes it through an atomic,
content-addressed operation; concurrent callers share the immutable winner and
no command-lifetime or global mutex is introduced. Existing malformed content
fails closed instead of being repaired on admission.
The native host observes termination immediately after consuming bootstrap,
before synchronous pre-launch preparation. A per-command abort completion
boundary keeps the process alive until Job-drain evidence is durable. Node treats
an absent nonce-bound Resume record only after confirmed host-tree death as
proof that the target never ran; once Resume exists, terminal Job-drain evidence
remains mandatory.
The public/daemon capability is `sandboxRuntime:10`; SemVer is also part of the
execution contract. An idle older daemon is replaced, a busy older daemon is
rejected before sandbox execution, a newer daemon is never downgraded, and an
unknown/non-SemVer owner is never mutated.
When multiple new clients encounter the same idle older daemon together, their
token-authenticated temporary upgrade identities elect one inventory leader.
Followers detach and reconnect after the existing fenced replacement; this is
a bounded upgrade-only convergence path, not a command-path lock or queue. If
a peer attaches after the durable prepared-exit ticket but before the revision
CAS, one authenticated follower resumes the exact durable ticket after
detaching, while the original client and any other followers wait only for the
already elected replacement owner.
Caller-supplied
dynamic Windows `denyRead` roots in the standalone sandbox API fail closed as
`unsupported_policy` before target start; ordinary start/exit creates no
execution receipt or ACL cleanup transaction. Foreground Bash and the SDK validate setup state
immediately before spawn and release prepared state on a synchronous pre-start
failure. Caller-local broker deadlines release only their reference, while a
fully active broker pool fails before target start rather than waiting for a
command lifecycle. Linux and macOS use one ASRT bubblewrap or Seatbelt wrapper per command
without a KodaX workspace-session owner. A pre-target-start sandbox preparation
failure may create an exact host-boundary decision;
it never redirects through trusted text or replays a target whose start is
committed or unknown.

## 12. Media Input Artifacts

Media/input artifacts are agent-layer primitives under `packages/agent/src/media`.
The public `@kodax-ai/kodax/media` SDK entry and the legacy
`@kodax-ai/coding/media` source-side path both re-export that implementation.
Coding consumes validation/enqueue helpers from this layer; file and video
artifact contracts remain stable even when a provider route is not wired for
send.

## 13. MCP And A2A

MCP lives under `packages/agent/src/capabilities/mcp`.

Core modules:

- catalog/search,
- config,
- transport/runtime/manager,
- OAuth and protected-resource discovery,
- reverse capabilities,
- prompt/resource/tool bridging.

The published `@kodax-ai/kodax/mcp` subpath exposes a focused MCP surface.
Coding tools consume MCP through capability providers rather than duplicating
connection logic.

A2A lives under `src/a2a` and is published through `@kodax-ai/kodax/a2a`:

- `config.ts` reads version 1 compatibility input and writes version 2; a
  non-empty legacy file needs an explicit stopped-daemon migration.
- `client-auth.ts`, `security.ts`, and `client-executor.ts` select one complete
  advertised security alternative, resolve fixed Bearer or OAuth 2.0 Client
  Credentials just in time, and keep Card/RPC/token origins separate.
- `server-auth.ts` validates external-issuer RFC 9068 JWT access tokens/JWKS;
  the compatibility Bearer profile and custom authentication adapters expose a
  stable `securityRealm` for task ownership.
- `task-migration.ts` provides an explicit offline exact-owner rekey for
  retained pre-realm tasks. Normal serving never dual-reads the legacy key.
- `runtime-config.ts` applies disables/removals before discovery and mutates
  only source-owned registrations with revision/owner preconditions.
- Each configured outbound Agent may persist a strict `network` block with
  `allowPrivateAddresses` and `allowInsecureHttp`. CLI one-shot overrides and
  persisted Runtime execution feed the same safe-fetch policy; private HTTP
  requires both permissions, while exact loopback HTTP requires neither.
- `server.ts` authenticates before body/task lookup, reserves global capacity
  synchronously before slow preparation, replays after subscription, drains
  admitted handlers on close, and enforces fixed per-task/per-server/per-stream
  SSE limits. Its loopback listener rejects explicit Fetch-blocked ports and
  retries ephemeral allocation until the returned URL is Fetch-compatible.
- Each Task owns one Runtime Session. High-frequency Runtime progress updates a
  small per-Task cursor checkpoint under `runtime-cursors/`; semantic Task
  transitions still atomically rewrite `tasks.json`. Restart overlays the
  checkpoint before replay, avoiding full-store writes for every token/tool
  event without weakening recovery.

The external-Agent plane persists an internal immutable registration snapshot
for each admitted route. It is not part of the public task DTO and contains no
resolved credential; it keeps input/cancel/reconcile routing stable across
registration replacement/removal and Runtime restart. `closeTimeoutMs` is a
positive finite owner-plane override with a 30-second default shared by admitted
work and executor disposal. Obsolete executor cleanup happens after the
serialized persistence/publication lane, while daemon auto-start waits on and
terminates abandoned child process trees. CLI and SDK callers share that exact
candidate lifecycle; detachment occurs only after the candidate PID is healthy.
The repository test harness may additionally bind a daemon to its Vitest worker
for abnormal worker-loss cleanup, but production daemon lifetime remains
explicitly administered rather than client- or idle-owned.

## 14. Governed Memory Runtime

The sole durable memory authority remains `packages/agent/src/memory-control`.
FEATURE_260 adds these focused layers:

- `packages/agent/src/experimental-memory`: public `MemoryAgent`, scoped
  `MemorySession`, policy, passive recall, deliberate query, observations,
  outcomes, and bounded episode close/review.
- `packages/agent/src/memory`: exact identity/applicability and managed memory
  path policy.
- `packages/coding/src/memory-runtime.ts`: coding integration, project identity,
  passive recall preparation, episode lifecycle, and review scheduling.
- `packages/coding/src/memory`: coding context/observation extraction,
  prompt-safe rendering, policy artifact hashes, and trace-only decision links.
- `packages/coding/src/tools/memory-recall.ts`: the session-bound read-only
  `memory_recall` tool; mutation tools share the managed-path guard.

Routine exact recall remains synchronous and renders only into the dynamic
prompt suffix. FEATURE_275 adds `MemorySession.intervene()` for three sparse
events: tool failure, verification failure, and committed context compaction.
The coding loop projects current objective/open todos, then combines them with
recent prompt-safe observations and a fresh governed pack. Deterministic exact
pins run first; an optional host `memoryRecallRunner` may add only exact offered
IDs. Selection is awaited before the Action-LLM request, capped at three
candidates and three calls per Session, and discarded if the observation
sequence changes.

The central prompt-safe claim gate runs before selection and again before the
evidence envelope. Private/sensitive observations are excluded; suspicious
tool text becomes a neutral source reference. The daemon DTO explicitly rejects
the function-valued runner. Deliberate query appends a normal tool call/result
tail. None of these paths writes memory. Episode promotion first consults existing
claims, then emits at most a governed proposal or a deferred inbox record; the
existing preview/fingerprint/apply controller is the only durable write path.
`MemoryDecisionReceipt` stores candidate IDs, selected candidate IDs, exposed
evidence refs, event triggers, and policy facts in tracing, not hidden reasoning
or a second event database.

The root-only `memory_intent` tool binds an exact quote from the current user
turn and implements `list`, `remember`, `correct`, `forget`, plus exceptional
decision inspection and approval/rejection. The quote must identify the operation
and exact target; revision-bearing decision handles survive turn/binding changes
and stale revisions fail closed. Mutating operations reject any text
whose stored statement is not itself an exact current-turn claim span. Safe
explicit operations call `MemoryManagementController.remember()` or `forget()`
immediately. Every new fact, preference, policy, or procedure has a stable semantic
claim key. Foreground completion still emits the ordinary outcome plus a bounded
host-owned handled-operation marker, so autonomous Memory and Skill learning are
not skipped and cannot repeat the explicit mutation.
Duplicates are idempotent; correction requires an exact target; deterministic
safety, identity, scope, applicability, and fingerprint checks remain mandatory.
Ambiguous/broad operations return clarification, conflicts persist a readable
decision, and restricted/secret content is rejected without persistence.

Autonomous outcome review is separate. The model returns only actions and
warnings; the host binds trigger, time, source/candidate references, and digest
authority before validation. Deterministic low-risk verified actions may
auto-apply; other actions remain decisions. Same-process drains are serialized
best effort, and restart recovery owns any persisted remainder.

The normal REPL surface lists accepted Memory and exceptional decisions.
`open` delegates to the host/default external application (never an embedded
editor) and opens one exact storage scope/item. `MEMORY.md` remains
a derived readable projection; hidden `rebuild` recreates only that projection.

## 15. Workflow Runtime

Workflow runtime has a strict boundary:

- `packages/agent/src/workflow`: domain-neutral runtime, event recorder,
  concurrency/cap accounting, abort, limit validation, public SDK types,
  workflow capsule validation/factory helpers, and backend injection.
- `packages/coding/src/workflows`: coding backend, built-ins, durable run graph,
  workflow capsule persistence/preflight, saved workflow discovery, and
  `/workflow` command integration.

FEATURE_217 is the v0.7.49 Dynamic Workflow product feature. The implementation
provides the substrate, JavaScript harness generation, background manager
behavior, pause/resume/stop/save, workflow-level worktree wiring, hard budget
checks, workflow capsule reuse, and advanced workflow pattern templates.

Generated workflows remain dynamic JavaScript, but the runner boundary is a
capability boundary: the script may hold loops, branches, intermediate results,
model routing, and calls to `wf.*`; it must not receive direct host access to
filesystem, shell, process, environment, module import, or network APIs. The
host handles `wf.*` as structured commands and applies existing permission gates
through child agents. `node:vm` with host objects is not a valid trust boundary
for generated workflows.

Saved generated workflows use a small capsule contract rather than a bare script
file. A capsule stores the generated source, validated manifest, task intent,
input examples, lightweight requirements (`git-repo`, `worktree-capable`,
tools, MCPs, skills, model tiers), and provenance. Full JSON Schema is deferred
until KodaX needs third-party generation, marketplace-style distribution, or
complex cross-tool requirement validation; v0.7.49 uses TypeScript contracts and
runtime validation to stay minimal.

FEATURE_229 (`v0.7.50`, released)
adds the process contract without changing the dynamic harness model. The agent
workflow package exposes `WorkflowProcessSnapshot`, `WorkflowProcessEvent`, and
`isFinalWorkflowProcessStatus`; the event model stays intentionally small:
`workflow_started`, `workflow_updated`, and `workflow_finished`, each carrying a
snapshot with phase/agent/item status. `WorkflowRunManager` updates and emits
snapshots after runtime events, while `createWorkflowLifecycleController`
provides host-owned stop/pause/resume, result/artifact reads, terminal-run
delete/prune, identity, and preflight controls. Coding commands and SDK callers
share the same process callbacks/read APIs; REPL inline/fullscreen surfaces
render snapshots only. KodaX Space and other SDK hosts configure invocation
policy, subscribe to process snapshots, and control runs through the SDK
controller instead of replaying slash commands or depending on REPL callback
text. This keeps progress semantics reusable and prevents terminal UI state from
becoming the hidden source of truth. F229 also preserves workflow source and
revision provenance (`source`, `sourceRunId`, `sourceWorkflowName`,
`savedWorkflowName`, `revisionOf`) plus `resultSummary` in the durable run graph.
Workflow child agents inherit or fail closed on parent guardrails, existing SDK
event callbacks, workflow logs, capsule preflight, and provider/model policy.
Durable run graphs remain audit/result records in this slice; they are not
cross-process executable checkpoints.

FEATURE_230 / FEATURE_234 (`v0.7.51`, released) add persistence readback on top
of that process contract. TUI sessions persist sanitized terminal tool groups in
`uiHistory`, with malformed siblings filtered rather than dropping the full
array. Workflow process metadata accepts optional `hostMetadata`, normalizes it
to a small string-only map, persists it in `run.json`, and echoes it through
`WorkflowProcessSnapshot` / process events after restart.

FEATURE_246 (`v0.7.58`, released) adds inline workflow authoring: a
model-callable `run_workflow` tool lets the Worker scout the codebase and author
+ run a workflow script in-chat (`packages/coding/src/workflows/`
author-via-worker / host / invocation-policy), routed through the unchanged
sandbox + static-validation + postcondition pipeline. It carries structured
child output (`outputSchema`), the no-barrier `wf.pipeline`, same-session resume
(`resumeFromRunId`), and nested `wf.workflow(...)`; the neutral run-lifecycle
manager moves to `@kodax-ai/agent` (ADR-046). ADR-044/046/047/048/049.

## 16. REPL Detail

`packages/repl` owns:

- `runInkInteractiveMode`,
- classic `runInteractiveMode`,
- config load/save and custom provider CRUD,
- permission helpers,
- command registry and slash commands,
- transcript rendering,
- session list/resume/fork/rewind/archive/tag flows,
- UI bridge for confirmations and prompts.

The REPL should not become the owner of core agent semantics. Product behavior
belongs in `coding`, reusable primitives in `agent`, and provider behavior in
`llm`.

The bare resume path follows the same separation: `src/kodax_bootstrap.ts`
starts the picker without importing the complete CLI, pauses/references stdin
only for a selected-session handoff, and pauses/unreferences it on Esc. Session
replay uses the persisted event timestamp for each message/tool record instead
of one `Date.now()` value at render time.

`findMostRecentResumableSession()` is the shared REPL/CLI selector. It requests
up to 1000 newest summaries and returns the first `msgCount > 0` record. The
coding-layer CAP-043 middleware mirrors that rule without depending on REPL.
Classic startup now restores the same messages, UI history, lineage, artifact
ledger, extension state, title, tag, Session ID, and normalized runtime/workspace
identity as Ink. Explicit IDs short-circuit discovery in both layers.

## 17. Construction And Self-Modification

Construction tools allow staged creation and admission of tools and agents.
Self-modification tools stage proposed changes through explicit runtime paths.

Design constraints:

- staged artifacts must be validated before activation;
- admission invariants live in `packages/agent/src/admission`;
- construction runtime lives under `packages/coding/src/construction`;
- user approval remains required for irreversible or high-risk changes;
- generated capabilities should not bypass normal tool permissions.

Activated JavaScript handlers are materialized as immutable `.mjs` files and
loaded into a persistent per-handler Worker. Calls for one handler are FIFO.
`ctx.tools.*` is reverse RPC: the parent creates `CtxProxy` from the live tool
context and calls `executeTool`, preserving capability, live plan-mode,
constructed-depth, permission, and tool sandbox behavior. The Worker receives
only cloneable informational context plus a bridged `AbortSignal`; host
callbacks and mutable services remain in the parent.

Timeout awaits `Worker.terminate()` before rejecting. Revoke/dispose marks the
handler entry dead before terminating it, so active, queued, and future calls
cannot recreate an untracked Worker. Direct Node imports inside generated code
remain possible at runtime, so admission checks and approval still matter.

## 18. Observability And Eval

Behavior-affecting prompt changes must follow
`benchmark/EVAL_GUIDELINES.md`. Runtime changes should add focused Vitest
coverage near the source file. Eval outputs belong under benchmark result
locations, not in active docs.

Tracing lives under `packages/agent/src/tracing` and is inline after package
consolidation. It is reusable infrastructure, not a separate workspace package.

## 19. Current Anti-Patterns

Do not introduce:

- V1 role names as current runtime concepts;
- prompt-only permission rules without runtime checks;
- provider-specific prompt prose;
- SDK exports not backed by `package.json`, bundle entries, and dts output;
- new workspace packages for code that is only used by one package;
- REPL-only state as a dependency of headless SDK operation.
- ignored Runtime isolation/capability options that silently select a weaker
  ownership form;
- Worker or daemon boundaries described as a security sandbox.

## 20. v0.7.74 Large Compaction Chain

The agent layer owns one normalized policy:

```text
percent = clamp(triggerPercent ?? 75, 15, 90)
effective = min(contextWindow * percent, positive(triggerTokens), physicalCapacity)
protectedTail = floor(effective * 0.20)
```

Automatic triggering is request-bound and cannot be disabled. One major wave
partitions atomic tool groups into the complete eligible prefix and protected
raw tail. It summarizes the full eligible prefix once, using map/reduce only
when that request cannot physically fit. Temporary summaries never mutate
canonical history. The committed synthetic user checkpoint combines the
structured semantic summary with an exact JSONL ledger of genuine user queries.
Emergency fallback returns the original array when mandatory content cannot be
reduced. Its gate accepts a candidate only when token count strictly decreases
and the full request fits physical capacity; only then may success stats fire.

Coding owns per-context anti-thrash and stable root/child attribution. The
canonical post-commit callback increments `contextRevision`; Runtime projects it
as `context.compaction.finished`. KodaX Space updates its Session meter only for
root facts.

Runtime observations carry a bounded `RuntimeTranscriptSlice`. Older pages use
opaque revision-bound cursors; a single oversized entry uses bounded
`base64-json` chunks. The legacy daemon full-transcript method is capped at 512
KiB and points callers to page/chunk recovery before the transport's 8 MiB
frame can be approached.

The compaction update carries `preCompactionMessages` only to the in-process
host callback. It never enters the replacement provider input or a serialized
live event. The root host first reconciles those messages into lineage, then
adds the compaction island. `applySessionCompaction()` no longer performs
payload eviction itself. After `appendSessionDelta()`/`save()` acknowledges the
exact snapshot, the host may call `evictOldIslandMessageContent()` on the live
lineage. `onCompactedMessages` is awaitable: the next provider request and
`context.compaction.finished` both wait for that acknowledgement. Failure keeps
the exact live payload, emits a diagnostic, and rejects the compact commit.
Headless core Runs write through their injected storage; Runtime overrides a
client-carried `persistedByHost` flag because the Runtime is the canonical
Session owner on both embedded and daemon paths. Runtime-backed Ink/classic
hosts update only their live projection after acknowledgement and never become
a second canonical transcript writer. Ink's presentation-state tail may still
race an owner-written Actor snapshot: a stale prepared append catches only
`SessionReadError(data_changed)`, reloads through `appendSessionDelta()`, and
merges the UI tail without replacing the newer Actor snapshot. Background
persistence failures become diagnostics rather than unhandled promise
rejections. A first-run compact seeds a missing Session from explicit Run
metadata before persistence; a rejected async compact callback restores the
tentative context revision as well as leaving the exact payload intact.

Full rewrites run the same archive-first transaction as maintenance: reconcile
legacy placeholders against exact persisted entries, append and `sync()` new
sidecar records, atomically replace the slim main file, then update storage
state. A main-write failure after sidecar success is safe duplication. Storage
maintenance resets only its rewrite counter; it retains the live caller's
lineage append watermark until restart so delta slicing cannot reappend an old
placeholder range.

The agent-layer transcript retrieval primitive computes a content revision over
the merged lineage. `searchSessionHistory()` excludes system/control entries by
default, searches compacted entries with exact phrase, logical-ID, Unicode term
coverage, and inverse-document-frequency signals, and returns bounded snippets.
`readSessionHistoryEntry()` requires a stable entry ID, optionally fences the
revision, and returns a fixed character chunk plus `nextOffset`. Coding exposes
the `session_history_search` / `session_history_read` pair when the current Run
owns full-lineage-capable storage. Root Runs bind the root Session. Persistent
child Runs bind a separately minted hidden `managed-task-worker` Session, so a
child can recover its own compacted detail without reading or mutating root
lineage. Storage-less Runs and partial visibility of the pair expose neither
tool. The embedded Runtime/daemon projects the same search hits; bulk and
oversized exact reads continue through transcript page/chunk APIs.

## 21. v0.7.75 Stabilization Boundaries

Every Runtime Worker-reachable non-interactive `child_process` call must either
request `windowsHide: true` or be an explicit reviewed exception. The covered
surface includes memory and Git metadata probes, provider CLI/ACP execution,
LSP acquisition and servers, clipboard helpers, worktrees, review commands,
extension commands, managed-task checkpoints, and sandbox helpers.

Interactive external editors, explicit terminal commands, PTY sessions, and
POSIX-only process-management branches remain exceptions because hiding or
changing their process contract would alter user-visible behavior. The bundle
build inspects the Runtime Worker esbuild metafile and fails when a statically
identifiable reachable call lacks the required option or a named exception.
The packaged Electron smoke separately executes 20 ordinary queries and checks
Win32 console visibility at the actual SDK/daemon boundary.

The release candidate also retains the Sidecar/Runtime completion boundary:

- optional follow-up offered after the request is complete is an accepted
  completion, while clarification required to finish the request is blocked;
- the budget bridge publishes approval state only immediately before an
  eligible `revise` request;
- live results and persisted/daemon projections retain the blocked code and
  reason, including after restart recovery;
- the release script audits those prompt and budget guards in the exact
  tarball it can publish.

## 22. Scoped Provider Credential Runtime

The Runtime credential bridge has two additive protocol versions. V1 keeps the
legacy exact binding `{ leaseId, provider }` for one Run. V2 uses
`registerScoped()` / `resumeScoped()` and binds
`{ leaseId, mode: 'scoped', providers }`; the binding Provider set must be a
non-empty subset of the registered lease allowlist.

V1 keeps its exact Run request shape, but registration rejects a lease whose
`expiresAt` is already past. This prevents a transient unusable record without
changing v1 acquisition or binding semantics.

The daemon mints every trusted target and asks the host separately for every
actual Provider wire request:

```text
lease allowlist
  └─ operation binding intersection
       └─ run | session.compact | actor_turn | workflow target
            └─ provider + closed purpose
                 └─ one transient exact-secret wire scope
```

The outer async context contains a revocable resolver handle, not a secret.
While it is active, Provider discovery is fail-closed: an unauthorized Provider
does not fall back to process environment. Built-in Provider instances and
Anthropic/OpenAI SDK clients bypass credential-bearing global caches. All
production request seams—primary, fallback, continuation, classifier,
compaction, sidecar judgment, and utility summarization—enter the transient
scope before calling a Provider.

Lease revoke/expiry aborts related pending acquisition and active request
signals. Credential supply checks the original lease record again, so a host
reply arriving after revoke cannot revive the request. Run, Actor-turn, and
Workflow handles are closed at their terminal boundary; derived handles also
check the live parent. A stale async resource can retain the inert handle but
cannot resolve a credential.

`sessions.compact()` sends its optional `operation` in the RPC envelope and
uses a stable `operationId`. The daemon validates lease, Provider, Session, and
the `session.compact` operation target before the shared compaction summarizer
requests a credential. Agent credentials live only in host operation options,
never `AgentSpawnInput`; internal child authority is an intersection and a
current-turn follow-up cannot replace it. Detached Workflow execution derives
a Workflow-targeted handle and closes it on success, failure, cancellation, or
parent closure.

Shared-daemon `agents.spawn` and newly admitted internal `agents.followup`
turns fail before admission when no scoped binding is supplied. External turns
use only their independent `credentialRef` plane and reject a Runtime Provider
binding; their executor scope also suppresses daemon ambient Provider keys.
Embedded/local Agent calls retain their existing configuration model.

`config.readEffective()` is a separate `integration:admin` operation. Its
snapshot contains only whitelisted effective keys with `present`, `applied`,
`source`, and `priority`; credential environment names contain only
`present/source`. Persisted config state is `loaded`, `missing`, or `invalid`,
and no arbitrary persisted object or credential value is serialized.

Agent operation, capability, control, and credential-binding records are
closed wire objects. Unknown authority fields fail validation; `metadata` is
the sole open host-extension field. Compile-time key guards keep the daemon
spawn schema aligned with `AgentSpawnInput`, including required control keys.

## 23. Related Documents

- Product requirements: [PRD.md](PRD.md)
- High-level design: [HLD.md](HLD.md)
- Architecture decisions: [ADR.md](ADR.md)
- SDK embedder guide: [embedder-guide.md](../public_docs/sdk/embedder-guide.md)
- Release process: [release.md](release.md)
