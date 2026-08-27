# KodaX Architecture Decision Records

> Last updated: 2026-08-21
>
> **v0.7.94 release addendum:** a direct text mutation may overlap a
> model-started shell only after Runtime has acquired the same workspace ASRT
> policy and moved both snapshot and write into that sandbox. The complete
> text transaction keeps its normalized-path FIFO and uses a file-identity-aware
> optimistic compare-and-write check. Hard-linked workspace targets are
> rejected. Standalone Coding consumers and every other host filesystem sink
> retain the direct lease; Runtime ASRT unavailability for a covered workspace
> target fails closed instead of silently changing authority; non-workspace
> targets retain the legacy host fence. A missing workspace directory omits
> that concurrent sandbox at Run start. Shell owners still coordinate
> incompatible Windows ACL policies, while worktree creation/removal retains
> both its target-path queue and namespace/process-tree lease. Windows
> sandboxed git trusts authorized repo roots only and never emits
> `safe.directory=*` (Issue 300). Linked-worktree and submodule relationship
> files are read through strict byte bounds. Helper stdin failures stay on the
> text-mutation operation Promise. Invalid Skill `allowed-tools` entries and
> malformed hook JSON are diagnosed; `PostToolUse` still runs if an embedder
> result observer throws. `gitSafeDirectory: authorized-repo-roots`
> is a v4 marker, not a version bump. Scheduled daemon shutdown reports failed
> cleanup. `conversationHistory` advances to v2 as an additive negotiation
> fact. Explicit Skill invocation remains available for every enabled Skill;
> `disable-model-invocation` only blocks the model tool path. Terminal
> convergence is a bounded Runtime transaction: every finalization rejection
> is observed; a durable terminal remains authoritative if only event
> publication fails; if neither terminal record can be persisted, the Run
> becomes `unknown` with `run_settlement_not_persisted` and the Session
> execution fence remains closed. Sandbox and managed-child termination
> rejection is diagnostic state, never a process-global unhandled rejection.
> Transport close reports only observable connection facts
> (`RuntimeDaemonDisconnectCode`, `connectionId`, `reconnectable`); it is not
> itself proof of `daemon_crashed`. After admission, clients retain `runId`
> and recover through `runs.get()` / `runs.await()` on a replacement Runtime.
> They never replay `runs.start()` or provider/tool effects. Capability
> versions `sandboxRuntime:4` / `crashOutcomeModel:2` and Issue 256 remain
> unchanged.
>
> **v0.7.93 release addendum:** Runtime exit settlement observes a durable
> Windows `failed` shutdown outcome during the orderly wait and enters exact
> recovery immediately instead of spending the 170-second window (Issue 297).
> After a verified boot change, settlement may recover previous-boot shared ACL
> markers under the machine lock, record the recovery, and only then clear
> revalidated markers (Issue 299). Anthropic/OpenAI abort wrappers are classified
> by isolated SDK class identity when the request signal is already aborted, so
> managed Stop stays interrupted before credential redaction (Issue 298).
> Capability versions are unchanged. Issue 256 remains open.
>
> **v0.7.92 release addendum:** filesystem-effect lock ownership is an operation
> token, not process liveness. Waiters heartbeat their queue ticket; a stale
> same-PID ticket is reclaimed only when it no longer owns the exact coordinator
> lock. Effect release records a token-scoped durable marker first so a later
> coordinator transaction can retire that settled owner while the daemon PID
> remains alive. Managed Runs persist the canonical Session before completion;
> repo/task projections are asynchronous; Runtime uses the executor Promise, not
> managed `onComplete`, as terminal authority. Hosts negotiate `sandboxRuntime:4`
> and `crashOutcomeModel:2`. Idle daemons may be replaced; busy ones fail closed.
> There is no host-side lock-file deletion path. Resume reconstruction uses
> canonical Session `messages` as the ordinary-conversation source; `uiHistory`
> is a display overlay and cannot suppress that baseline (Issue 296).
> Presentation-only `agent-completed` / `task-completed` events stay host-owned
> when a non-empty CLI `uiHistory` exists. Issue 256's lost-ancestor
> descendant-closure boundary remains open.
>
> **v0.7.89 release addendum:** ordinary conversation topology treats
> replaceable managed-run/runtime-context envelopes as transparent while the
> physical audit track remains authoritative; page-cache v4 invalidates old
> projections. Built-in web search uses a bounded DuckDuckGo HTML → Bing RSS →
> Bing HTML fallback with truthful diagnostics and isolated explicit endpoints.
> Daemon Host Tools are run-scoped, registry-first, revoke-safe, and authorized
> through exact A2A `host:` capability ids. No shell or sandbox system contract
> changed in this release.

> **v0.7.90 release addendum:** workspace-session RPC timeout handling fails
> pending requests and retires the shared ASRT session through orderly close;
> cleanup uses the Windows reset-grace budget so serial ACL/WFP cleanup is not
> cut short by the generic RPC deadline. Daemon diagnostics normalize Error,
> AggregateError, and cyclic cause details instead of serializing them as `{}`.
> Session lineage records the direct physical clone predecessor, keeps that
> predecessor addressable during one-hop archive retention, and attaches archive
> markers to the retained topology. Run-scoped tool schemas normalize to the
> provider object-schema contract at materialization. These are system-code
> fixes with no new shell permission or sandbox policy weakening.

> **v0.7.91 release addendum:** complete Runtime exit is now an SDK-owned,
> crash-resumable transaction. The SDK persists exact owner/process-start and
> boot identities before stop, and repairs only verified Windows process/Job/ACL
> residue; same-boot POSIX uncertainty remains blocked. Provider output
> replacement is projected by logical response and physical request identity,
> while raw journals retain all attempts. Standalone binaries bundle lazy
> provider SDK dependency graphs. These changes preserve fail-closed ownership,
> shell, and sandbox boundaries.

> **v0.7.91 interaction addendum:** AskUser, permission, and MCP elicitation
> are owner-scoped interactions with independent bounded deadlines. Runtime
> callbacks receive an AbortSignal, defaults are validated before they can
> settle a request, and SDK permission hosts use Runtime-authoritative
> resolution. Interactive Session hosts recover a stale prepared tail through
> a full authoritative delta after `data_changed`; background persistence
> errors are surfaced as diagnostics.
>
> **v0.7.88 release addendum:** Actor snapshot persistence has
> explicit boundaries for Actor mutation order, process-local storage dequeue,
> file-writer eligibility, cancellable pre-commit work, canonical file
> replacement, and full serialized maintenance completion. Process-local queue
> backpressure is not assigned the file-lock deadline; after dequeue, File
> Session storage advertises a 65-second eligibility bound compatible with its
> 60-second writer lock. The five-second settlement deadline starts only after
> eligibility. Cancellation is checked immediately before replacement, so queued,
> read/CAS, lineage, temp-write, and fsync timeouts are definitely not committed
> and cannot write late. Only an in-flight replacement remains ambiguous and
> fail-closed. An explicit replacement error is classified by authoritative
> exact JSON-persisted-shape snapshot readback rather than revision equality or
> assumed ambiguity.
> A terminal settlement also watches any predecessor save already holding the
> Actor mutation head, so a predecessor replacement hang reaches the same
> bounded fence. Once replacement succeeds, Actor state is durable even if later
> cache, watermark, topology, hint, or lock maintenance fails. The storage queue
> still chains full completion to prevent maintenance from being overtaken.
> Same-owner reconciliation uses these same phase boundaries; its canonical
> repair is not timed by queue, lock, or post-commit maintenance delay.
> Phase/timing diagnostics and `actorSettlementConvergence:2` make this contract
> observable and prevent new SDK clients from reusing a v1 daemon.
> The same release bounds startup/resume work and defers heavy provider, image,
> LSP, and TypeScript dependencies past the CLI bootstrap boundary. REPL startup
> learning-recovery notices are dismissed after the first submitted query, and
> the guardrail classifier reason is exposed as a bounded diagnostic field.
>
> **v0.7.87 release addendum:** Coding Plan model IDs are transport facts, not
> capacity annotations. `zhipu-coding` defaults to `glm-5.3` and keeps
> `glm-5.2`; `zai-coding` defaults to `glm-5.2` and keeps `glm-5.3` for
> accounts granted overseas access. Both IDs are sent verbatim, without
> `[1m]`. GLM-5.3 cannot disable thinking, so stable `off` / `none` intent is
> lowered to enabled low-effort thinking at the protocol boundary. Issue 256
> remains open after v0.7.87, and this provider release assigns no replacement
> target.
>
> **v0.7.86 release addendum:** Runtime owner recovery is atomic and
> fail-closed: only a provably abandoned inline owner fence may be removed,
> and Runtime/learning lock records carry process-start identity to prevent PID
> reuse from preserving stale ownership. Windows sandbox effects wait for
> termination proof before ACL recovery, serialize durable owner markers across
> Runtime profiles, and fence later filesystem effects when attestation is
> missing. Lifecycle failures remain observable and are never replayed.
> POSIX workspace admission initializes fresh Runtime-owned policy roots before
> identity capture, settles only workspace-local warm-up within the Shell
> abort/deadline, and retires invalid cached sessions after lease-cleanup failure
> before allowing replacement.
> Issue 256 remains open; the Worker owner-lease portion was scheduled for
> v0.7.87 in this historical release disposition.
>
> **v0.7.85 release addendum:** the Runtime event authority is now one
> journal per Session, with `{ sessionId, journalEpoch, seq }` cursors and
> replay bound to `sessionId` or `runId`; A2A Tasks persist their Session
> cursor and daemon hosts negotiate `sessionEventJournal:1`. Journal indexes,
> failure latches, and retention watermarks fail closed on ambiguity. F289 and
> F290 keep Memory review draining and lesson/verdict production bounded,
> observable, and host-governed. F292 makes explicit Memory management
> conversation-first and exposes only an additive management facade through
> the experimental SDK. Terminal startup trusts authoritative terminal status
> without replaying complete journals unless queued input needs reconciliation;
> idle semantic Workers retire after their warm-cache window. Issue 256 remains
> open and its Worker owner-lease portion is scheduled for v0.7.87.
>
> **v0.7.85 Issue 282 convergence addendum:** progress batching is owned by one
> Actor controller tree, and terminal persistence receives its own ambiguity
> deadline only after reaching the mutation-queue head. A durability fence
> aborts both child work and the root executor, suppresses post-fence effects,
> and automatically reconciles only an exact same-owner late snapshot. A
> pre-fence Promise fact may survive; otherwise the Run fails with
> `actor_settlement_not_persisted`. Hosts require these semantics through
> `actorSettlementConvergence:1`. Same-owner repair closes new effect admission;
> the Session route converges after every exact tool execution admitted before
> the fence has settled. A queued successor may then start even if an
> abort-ignoring provider leaves its Promise pending. UI tool-start events and
> permission waits are not effect leases, and the fenced provider cannot publish
> callbacks or start new Runtime-mediated effects.
> Healthy after-turn input keeps coding-mode defaults and inherits predecessor
> mode only when it actually drains behind this repair.
>
> **v0.7.85 permission and learned-root review addendum:** agent-home Rules
> authorization preserves ordinary working-data access while protecting the
> home root from whole-tree removal, hard-denying Runtime mutations, and
> reviewing credentials/security config plus generic sensitive names.
> The pre-Runtime `processes/children` registry is also host-owned control
> state: model writes are hard-denied, and unauthenticated records left in its
> historically writable location are quarantined without signaling a process.
> Learned Area persistence is likewise host-owned: model writes to `learned/`
> are hard-denied, while Memory/Skill lifecycle code remains its sole writer.
> `agents/*.md`, Sessions, tool results, and intermediate
> artifacts remain writable without approval. Learned project identity may name
> distinct remote and local hashed roots; discovery traverses both and every
> lifecycle mutation returns to the record's owning store. The legacy public
> `expectedScope` spelling remains accepted alongside optional multi-scope
> configuration.
> Shell authorization is authoritative and OS containment is attempted first.
> Infrastructure failure or policy contention before target start returns an
> already-authorized call to normal permission execution. Once target start is
> committed or unknown, the execution layer never replays it; the main model may
> reason about the result and submit a new call. Runtime provides Linux
> PID-namespace containment and a Windows per-effect Job when selected. Windows
> grants verified ordinary children, not
> the Agent Home directory object, preserving child writes without granting
> whole-root deletion. Shell effects and privileged direct-file sinks use a
> cross-process category lease so neither can overlap the other's canonical
> path validation/write window; same-category work remains concurrent.
> Windows ACL reuse is keyed by the complete effective policy: workspace,
> Agent Home access, additional filesystem roots, toolchain closure, temp scope,
> and network policy. Equal policies may share the restricted-user safety domain
> across Runtime processes; an incompatible owner returns to normal permission
> execution. Setup/reset remains coordinated across processes. Existing
> existing targets are granted directly. A reviewed missing external target that cannot
> be represented without broadening its parent grant uses normal permission execution;
> the root object, escaping links, and host control trees are revalidated before
> the ACL is built. Windows setup idempotently installs persistent read guards
> for the dedicated sandbox SID on existing sensitive roots. Process startup
> only audits those guards and fails closed with setup guidance; it never creates
> or restores broad sensitive-tree denies. Exact reviewed child grants override
> the inherited Agent Home deny without granting the root object. Repository
> config/hooks use
> write-only persistent guards (no read/synchronize deny), while uncovered
> caller-specific SDK denies stay on ASRT's ordinary path. A parent
> delete-child deny is installed only when the sandbox token would otherwise
> have that right, avoiding recursive parent-tree ACL work in normal cases.
>
> **v0.7.84 release addendum:** Agent progress persistence is bounded to one
> in-flight durable projection plus one latest replacement. Terminal settlement
> does not wait behind an unbounded progress backlog. When the Actor durability
> deadline is exceeded, a same-owner Stop may reconcile the exact late snapshot,
> validate owner identity, and quiesce remaining turns; foreign owners and
> unresolved stores remain fail-closed. Promise terminal facts outrank fallback
> callbacks after repair, and stale durable unknown status cannot rewind a local
> terminal Run. npm publication remains a separate manual operator step.
>
> **v0.7.83 release addendum:** Windows daemon startup creates the daemon
> suspended and assigns it to a kill-on-close Job Object before resume/user code;
> an out-of-Job supervisor owns the wait boundary and remains alive until Job
> accounting is empty. Durable shutdown verification now requires the exact
> cleanup outcome plus daemon and supervisor exit. The public SDK advertises
> `daemonShutdownVerification:1` and `waitForRuntimeDaemonShutdown()`; legacy
> uncontained daemons cannot be claimed verified or upgraded in place. A review
> hardening path terminates a suspended process when Job assignment fails. The
> Worker owner-lease part of Issue 256 remains scheduled for v0.7.85.
>
> **v0.7.82 release addendum:** daemon MCP/Host Tool discovery preserves
> explicit source filtering and truthful complete/live capability snapshots;
> managed-Run Stop cooperatively fences later Runtime-controlled work and keeps
> trusted Abort causality ahead of credential redaction; and input submission
> resolves an admitted authoritative Run before it can observe mutable Session
> history. npm publication remains a separate manual operator step.
>
> **v0.7.81 release addendum:** Runtime-owned active-Run interrupt input is
> persisted as one canonical Session user entry before delivery is published.
> The public Run status and `run.input.delivered` event carry that exact
> `entryId`; ambiguous/missing provenance or a required persistence failure
> fails delivery closed. The reference remains useful after replay, compaction,
> and restart, while legacy records remain readable without it. npm publication
> remains a separate manual operator step.
>
> **v0.7.80 release addendum:** the CLI can opt its embedded Runtime into the
> configured A2A plane inside a Worker, managed AMA turns have a per-invocation
> 500-iteration panic fuse with structured recovery failure, and Auto permission
> analysis now shares the deterministic analyzer with the SDK. npm publication
> remains a separate manual operator step.
>
> This header and addendum are authoritative for the v0.7.84 release; the long
> architecture-state notice below is retained as historical context.
>
> **v0.7.79 Runtime observation and A2A authorization addendum:** Runtime
> Session status, diagnostics, export, transcript paging, and recovery now use
> bounded read-only boundaries that cannot mutate legacy storage as an
> observation side effect. Ordinary conversation is a separate SDK-owned,
> provenance-checked projection rather than a host reconstruction of raw audit
> entries. Configured outbound A2A access keeps private-address and non-loopback
> plaintext-HTTP authority independent, persisted, and default-deny;
> Worker-hosted Runtime dispatch uses the same policy. Windows process cleanup
> now fails closed on observable uncertainty, but snapshot ancestry is not
> descendant containment; Issue 256 requires spawn-time Job Objects plus a
> Worker owner lease and is scheduled for v0.7.84.
>
> **v0.7.78 intent-aligned permission and learning addendum:** FEATURE_277
> supersedes ADR-056's automatic LLM-to-rules fallback. Precisely modeled safe
> operations bypass classifier latency; other classifier infrastructure
> failures retry once and then use the Accept-edits boundary for that call.
> They never mutate the Session engine to Rules. Rules remains an explicit,
> persisted user choice, while optional ASRT containment stays below the
> permission decision and never becomes an authorization source.
> `runtimeAutoModeGuardrail` v4 is the capability boundary for this behavior.
> FEATURE_263 separately keeps one-off recovery knowledge in governed Memory;
> only independently verified, exact-use project canaries may become Skills,
> and promotion to global Skill or Extension remains a deliberate action.
> FEATURE_276 initializes the full split configuration without overwriting any
> existing file.
>
> **v0.7.77 adaptive-quality and memory addendum:** FEATURE_274 gives AMA one
> shared six-pattern catalog and Runtime-derived, fact-only `PatternTrace`
> without adding a scheduler, hidden Workflow, or second quality gate; the
> existing Sidecar remains the sole terminal-answer adjudicator. FEATURE_275
> follows ADR-059: F228 stays the only durable memory authority, while sparse
> post-event foreground intervention uses a closed prompt-safe candidate set
> and an optional in-process selector. The default path makes zero selector
> calls, and unmeasured task-effect improvement is not a release claim.
>
> **v0.7.77 shell/cache/terminal hardening addendum:** a host-selected shell is
> a serializable Session/Run execution contract, not an inference from the
> daemon's startup environment and not a version-manager-specific adapter.
> Resolution and command execution use the same explicit interpreter in the
> effective cwd; provider credentials are filtered before and after profile
> loading; cache identity is contract/cwd scoped; configured failures are
> fail-closed; absent configuration retains compatibility. Managed AMA Skills,
> MCP, and task context remain request-only across compaction. Terminal events,
> interrupt batches, pattern target Schema, and governed-memory evidence hashes
> are aligned with their public contracts without adding new authorities.
>
> **v0.7.75 stabilization addendum:** the published Runtime Worker now treats
> hidden Windows consoles as part of the non-interactive background-process
> contract. Memory/Git, provider CLI/ACP, LSP, clipboard, worktree, review,
> extension-command, checkpoint, and sandbox paths request `windowsHide`;
> explicit editor, terminal, and PTY paths remain interactive. This is a
> cross-cutting bug-fix invariant enforced by the bundle audit, not a new
> runtime abstraction or feature authority.
> The same patch keeps Sidecar verdict meaning and budget eligibility at the
> existing coding/Runtime boundary: optional post-completion offers are
> accepted, required clarification can remain blocked, and the blocked reason
> is preserved without adding a second terminal state machine.
>
> **v0.7.74 context/coordination addendum:** FEATURE_272 makes large compaction
> an always-on, full-eligible-prefix transaction with durable exact-history
> recovery. FEATURE_273 separates model mailbox waiting from Actor event
> telemetry, restores only explicitly pending root completions after restart,
> and keeps progress observable without making it a model wake signal. Active
> Runtime Runs also accept ordered user input at safe Runner boundaries.
> Release-candidate closure makes continue-most-recent a shared non-empty
> Session selection invariant across CLI/REPL/coding entry points and restores
> saved workspace identity before resumed execution. It also serializes
> per-Session Auto setting writes and gives the UI a configured engine projection
> while awaiting owner acknowledgement; sticky `Auto[RULES]` remains deliberate.
>
> **v0.7.73 onboarding/Auto reliability addendum:** FEATURE_271 keeps first-run
> provider setup metadata-only and pre-Runtime, while the Runtime-owned Auto LLM
> contract validates effective model identity, bounds classifier input/output,
> exposes typed SDK settings and diagnostics, and upgrades only idle legacy
> daemons through monotonic capability negotiation.
>
> **v0.7.72 agent-control-plane addendum:** FEATURE_266 centralizes learned
> capability lifecycle, durable events, governance, and Runtime/REPL access in
> one agent-layer Learning Center. FEATURE_270 replaces parallel child-task
> authorities with one Runtime-owned Actor/Turn tree and bounded adaptive
> scheduler shared by native, Workflow-owned, and external Agent execution.
>
> **v0.7.72 permission/terminal addendum:** Runtime Auto Mode owns and reuses
> the session guardrail before permission escalation, persists LLM-to-rules
> fallback, and exposes plan exit only when a real host callback exists. The
> same release preserves event timestamps and makes bare resume selection and
> cancellation transfer terminal ownership deterministically.
>
> **v0.7.71 A2A durable-owner/admission correction:** normal RPC handling never
> dual-reads pre-realm task keys; a stopped operator may explicitly rekey exact
> known owners through the CLI or focused SDK migration. New records carry a
> key-scheme marker. Global capacity uses a synchronous pending reservation, so
> workspace/session/run preparation is outside any global asynchronous lock.
>
> **v0.7.71 provider/lifecycle addendum:** Kimi For Coding keeps
> `kimi-for-coding` stable while adding `k3-256k` and the 1,048,576-token `k3`
> tier over the upstream `k3` route with `thinking.effort`. External-Agent
> owner-plane close has one configurable 30-second default deadline, obsolete
> cleanup no longer occupies the registration mutation lane, and daemon
> auto-start owns and terminates abandoned startup children.
>
> **v0.7.76 Kimi Code catalog refresh:** after Kimi published `k3-256k` as an
> independent Model ID, the `kimi-code` alias defaults to it and sends it
> unchanged instead of rewriting it to `k3`. `kimi-for-coding` remains an
> explicit K2.7 Code route. K3 follows the documented `low` / `high` / `max`
> effort contract with `high` as default; the 256K route is image-capable and
> video-unsupported.
>
> **v0.7.71 packaged-Electron patch addendum:** SDK daemon auto-start uses a
> bootstrap-only Electron Node boundary, scrubs `ELECTRON_RUN_AS_NODE` before
> daemon and user child code loads, requires the default-enabled `RunAsNode`
> fuse, and keeps fuse-disabled hosts on ordinary Node/CLI plus attach-only mode.
>
> **v0.7.71 A2A authentication/activation addendum:** the released F267/F268
> boundary now uses config version 2 for outbound OAuth 2.0 Client Credentials,
> inbound RFC 9068 JWT Resource Server validation, and per-Agent desired-state
> activation. Card/RPC/token origins, authentication realms, durable route
> snapshots, registration owner/revision fences, daemon config-home ownership,
> admission ordering, and SSE resource ceilings fail closed. KodaX consumes
> tokens from an external Authorization Server; it does not issue or sign them.
>
> **v0.7.69 planned shared-daemon addendum:** FEATURE_269 extends the released
> F255 local daemon with atomic session observation/resync, durable operation
> receipts and revisions, transport-safe AskUser/permission resolution,
> run-scoped Space credential and Host Tool reverse bridges, explicit
> interrupted/unknown recovery, and one daemon/inline Coder owner fence with
> sticky rollback. Partner remains a private embedded Runtime. See ADR-054.
>
> **v0.7.68 governed-memory addendum:** FEATURE_260 keeps F228 as the sole
> long-term memory plane and adds an opt-in `/experimental-memory` SDK surface,
> zero-wait passive recall, deliberate read-only query, trace-only decision
> receipts, bounded outcome/review handling, and consult-before-write
> promotion. Exact scope and safety gates remain deterministic; runtime code,
> prompts, policy, and model weights are not self-modified.
>
> **v0.7.67 agent/session addendum:** FEATURE_258 adds the host-injected,
> protocol-neutral external-agent executor/catalog/task plane across Worker,
> Workflow, Embedded Runtime, and daemon surfaces. FEATURE_259 keeps the same
> orchestration layers while adding explicit tier intent, focused briefings,
> packet-scoped review, fresh verification, and route/cost telemetry. FEATURE_261
> adds searchable session resume, surface/cursor listing, provisional ACP
> sessions, and preview-first reversible cleanup.
>
> **v0.7.66 runtime addendum:** `@kodax-ai/kodax/runtime` is the ninth SDK
> subpath and exposes one sessions/runs/events/permissions/config/catalog
> contract in inline embedded, Worker-hosted embedded, and local-daemon forms.
> FEATURE_253-FEATURE_255 ship as one runtime migration release; the already
> implemented FEATURE_256 / FEATURE_257 Worker isolation work also ships in
> v0.7.66. Worker termination is a fault-isolation boundary, not an untrusted
> code sandbox (ADR-051).
>
> **v0.7.63 session-boundary addendum:** rewind audit entries are now typed as
> `rewind_marker` lineage entries. They remain visible in
> `loadFullTranscript().transcriptEntries` for host scrollback/audit, but they
> do not enter model-context message arrays. The public `/session` SDK subpath
> also exposes `compactSession`, and `startKodaX()` wrapper-generated handle IDs
> no longer override auto-resume/resume discovery or trigger the caller-ID
> missing-storage warning.
>
> **v0.7.79 conversation-history addendum:** raw transcript APIs remain an
> append-order physical audit. Ordinary chat recovery uses a separate
> `readConversationHistory()` / Runtime `sessions.conversation*` projection.
> It folds copies only from persisted provenance or a unique compaction-boundary
> lineage suffix, reports `resolved` / `partial` / `ambiguous`, and retains all
> candidates when evidence is insufficient. Immutable pages carry the same
> projection revision, while fork/rewind accept a physical boundary plus the
> captured source revision and fail closed if either is stale or missing. This
> avoids content-, timestamp-, and `turnId`-based guesses without changing the
> raw audit format. Conflicting or dangling provenance never authorizes a fold;
> diagnostic evidence is bounded separately from preserved conversation data.
> An inactive compaction epoch or non-leaf ancestor may be crossed only when a
> contiguous retained prefix has exact provenance and its complete parent path
> predates the compaction in strict append order; legacy content matching never
> receives that cross-epoch authority.
> A post-compaction fork keeps active context compact and carries only a proven
> provenance seed needed to reproduce the selected ordinary-history prefix.
>
> **v0.7.60 CAP-099 addendum:** SDK transcript entries now expose clone provenance (`logicalId` / `sourceEntryId`) so hosts can fold cloned or forked history without guessing from role, content, timestamp, or `[compacted]` placeholders. `loadFullTranscript()` remains raw append-order scrollback; it does not silently merge branches or hide compaction notices.

> **⚠️ Architecture state notice (2026-05-25)**: 早期 ADR (ADR-005/006/007/008 等) 描述 `FEATURE_061/062` Scout-first + Planner/Generator/Evaluator H2 chain 模型，已被 [**ADR-030 claudecode-shape Main Agent + Sidecar Verifier**](#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745) (FEATURE_184 v0.7.42) 取代。
> 当前运行时架构：**V2 Worker 单循环 + Sidecar Verifier**。V1 chain (Scout/Planner/Generator/Evaluator) 已于 [ADR-030 §F193 cross-ref](#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745) FEATURE_193 v0.7.43 全量退役；`emit_handoff` 工具已于 FEATURE_190 v0.7.43 删除。
> 早期 Scout-first ADR 保留以便 archive 查阅，不反映当前实现。
> **Current package / SDK state (2026-08-04 / v0.7.80)**: 源码 workspace 为 `llm / agent / coding / repl` 4 包；根 npm 包 `@kodax-ai/kodax` 暴露 12 个 SDK subpath（`/agent`、`/llm`、`/coding`、`/media`、`/repl`、`/skills`、`/mcp`、`/session`、`/runtime`、`/sandbox`、`/a2a`、`/experimental-memory`）；LLM registry 有 16 个内置 provider alias。当前 Runtime 事实包括 embedded inline、embedded Worker 与本机 daemon 三种 ownership/isolation 形态，以及 F269 的 authoritative shared Coder daemon：atomic observe/resync、durable operation、AskUser/permission transport、run-scoped credential/Host Tool bridge、crash outcome 与 daemon/inline owner fence。v0.7.79 已发布（tag `bbdc12c0`）；v0.7.80 development candidate 是 debug/patch 槽位（FEATURE_278/279/282/283/285 改期到 v0.7.85），增加 CLI `worker.configuredA2A`（Worker-hosted embedded Runtime 在 Worker owner 内装载 configured A2A plane，拒绝无法跨 Worker 边界的 configured MCP server/Extension，且像 daemon 一样对 run options 做传输净化）、结构化 `RunnerIterationLimitError` 与 500 次单次调用 panic fuse（idle-yield resume 重置计数，managed-task 生命周期仍无界）、以及 Issue 275 Auto permission 修复。F267 提供双向 A2A 1.0 edge，F268 将 MCP/A2A/Extension 拆入三个 user-level versioned file 并提供 last-known-good hot reload，F281 增加持久化、独立、默认拒绝的 private-address 与 non-loopback plaintext-HTTP 授权，并让 Worker-hosted Runtime 复用同一 configured A2A plane。F263 以 Memory-first、不可变项目 canary、规范记录门禁发现和 Learning Center 控制完成后台 Skill 学习；F276 完成不覆盖既有配置的首次 split-config setup；F277 将 Auto[LLM] 权限与可选 ASRT containment 解耦，并公开 `/sandbox` SDK。small-window 工具 schema 仍通过 `tool_search` / `tool_describe` / `tool_call` 渐进披露，最终目标工具只经过一次权限校验。
>
> 之前的执行模型注脚（v0.7.42 前）：
> 这组 ADR 反映 `FEATURE_061/062` 之后的执行模型：
> Scout-first、按证据升级 harness、skill-aware AMA。
> v0.7.35.1 (FEATURE_142) 修正 v0.7.24 FEATURE_082 包结构漂移，详见 ADR-001 / ADR-021。

---

## ADR-001: Keep the Layered Monorepo

**Status**: Accepted (updated 2026-05-24 after FEATURE_194 v0.7.43 — 9 → 4 packages 合并)

KodaX 保持分层 monorepo，包结构经 FEATURE_194 v0.7.43 整合后为 **4 包**（pre-F194 是 9 包；mcp / skills / tracing / session-lineage / repointel-protocol 5 个子包并入 agent / coding 后达到此结构 — 详 [ADR-036](#adr-036-package-consolidation--inline-5-single-consumer-subpackages-into-agent--coding-feature_194-v0743)）：

| 包 | 角色 | 说明 |
|---|---|---|
| `@kodax-ai/llm` | LLM 抽象 + provider 适配 | retry-after / cache markers / capability |
| `@kodax-ai/agent` | **通用 Agent 框架（智能体底座）+ 内联子树** | Agent / Runner / Handoff / Guardrail / Admission / Messaging / Orchestration / Memory / Team / Scratchpad / Construction / Runtime middleware + `session-lineage/` (持久化 + Lineage + Compaction，v0.7.35.1 split / v0.7.43 inline) + `capabilities/{mcp,skills}/` (MCP progressive disclosure + zero-dep skill packs，v0.7.43 inline) + `tracing/` (Trace/Span/Processor，可对接 OpenTelemetry/Langfuse，v0.7.43 inline) |
| `@kodax-ai/coding` | **Coding agent 实例 + coding-specific 资产** | Coding tools / role prompts / H2 task-engine / coding-preset / repo-intelligence (含 `protocol.ts` 内联，v0.7.43) |
| `@kodax-ai/repl` | Ink TUI | — |

Subpaths 用于外部 SDK 消费者（保持公开 API 稳定）：`@kodax-ai/agent/session-lineage`、`@kodax-ai/agent/capabilities/mcp`、`@kodax-ai/agent/capabilities/skills`、`@kodax-ai/agent/capabilities/skills/shared/yaml`、`@kodax-ai/agent/tracing`。

Reasoning:

- 包名 = 内容承诺：`@kodax-ai/agent` 是通用 agent 平台 + 配套能力承诺集合，`@kodax-ai/coding` 是 coding-specific 实例
- `@kodax-ai/agent` 不依赖 `@kodax-ai/coding`、不依赖 `@kodax-ai/repl` 就能跑一个 agent
- 未来 `@kodax-ai/data-analysis-agent` / `@kodax-ai/ops-agent` 等按 `@kodax-ai/coding` 模式独立成包，统一依赖 `@kodax-ai/agent`
- task engine 的增强应建立在现有层次之上，而不是把层全部揉平
- 详细包归属规则见 ADR-021；包合并决策见 ADR-036

**v0.7.35.1 之前（FEATURE_082 设计）**：曾包含 `@kodax/core`（含 Layer A primitives + 后续漂入的 runtime）和**设计但从未创建**的 `@kodax/capabilities`。v0.7.35.1 (FEATURE_142) 把 `@kodax/core` 30 文件全部并入 `@kodax-ai/agent`，并撤销 `@kodax/capabilities` 死设计，理由见 [v0.7.35.1 设计稿](features/v0.7.35.1.md) §FEATURE_142。

---

## ADR-002: KodaX Becomes a Task Engine

**Status**: Accepted

KodaX 的一等抽象是 `task`，不是旧的 `Project Mode`。

Consequence:

- `/project` 变成 control surface
- task contract / evidence / verdict 成为统一事实面

---

## ADR-003: Single-Agent First, Harness On Demand

**Status**: Accepted

系统默认从单 agent 语义出发，仅在证据表明必要时升级到 AMA harness。

核心执行形态：

- `SA`: single-agent direct
- `AMA-H0`: direct
- `AMA-H1`: checked-direct
- `AMA-H2`: coordinated

Reasoning:

- 简单任务不应先经历多角色 ceremony。
- 用户应当感觉系统“先试着直接做，再在需要时变强”。

---

## ADR-004: Remove `H3_MULTI_WORKER` from the Default Runtime

**Status**: Accepted

默认 runtime 不再保留 `H3_MULTI_WORKER`。

Reasoning:

- 缺乏清晰收益边界
- 容易带来角色膨胀、token 浪费、流式展示混乱

Consequence:

- AMA 只保留 `H0 / H1 / H2`
- 如未来重新引入并行执行，应作为新的受控设计，而不是历史残留

---

## ADR-005: `Scout` Is Pre-Harness Entry, Not a Long-Lived H2 Role

**Status**: Accepted (updated after FEATURE_061)

`Scout` 是 AMA 的唯一入口，承担 pre-harness 判断和 H0 直接执行。不进入 H2 主 graph。

FEATURE_061 扩展了 Scout 的能力：

- Scout 是所有 AMA 请求的第一站（无预路由层）
- H0 时 Scout 可直接完成任务（Scout-complete H0）
- Scout 升级到 H1/H2 时保留已有上下文（context continuation）
- 每个角色（含 Scout）可通过 `runOrchestration` 拉 subagent 并行

Reasoning:

- 避免 H2 角色图再次膨胀
- 保持 `Planner -> Generator <-> Evaluator` 作为唯一完整 harness 骨架
- Scout-complete H0 消除 scout-then-handoff 往返

---

## ADR-006: H2 Uses `Planner -> Generator <-> Evaluator`

**Status**: Accepted

H2 的唯一完整骨架是：

```text
Planner -> Generator <-> Evaluator
```

Consequence:

- `Planner` 负责 contract
- `Generator` 负责 deep evidence / execution
- `Evaluator` 负责 targeted spot-check / verdict

`Lead`、默认 `Admission`、`Contract Reviewer` 不再是主骨架角色。

---

## ADR-007: Skills Stay as Invocation Playbooks, Adapted via `skill-map`

**Status**: Accepted

skill 仍然是 invocation/playbook，而不是新的多角色协议。

当 skill 进入 AMA 时：

- `Scout` 读取完整 expanded skill
- `Scout` 生成 `skill-map`
- `Planner / Generator / Evaluator` 各自读取不同层次的 skill 视图

Reasoning:

- 保留 skill 的智能性
- 避免 raw skill workflow 平铺污染所有角色

Invocation boundary clarification (2026-08-21):

- model invocation and explicit user/SDK invocation are separate sources;
- every enabled Skill is explicitly invocable, while
  `disable-model-invocation` controls only model catalog disclosure and the
  model `skill` tool;
- explicit `/<name>` and `/skill:<name>` tokens may occur at the query head or
  in the middle, with following text passed as arguments;
- Workflow/child reuse requires the host-owned structured `skillInvocation`
  record. Model-authored slash text or copied `<skill>` text is not provenance
  and remains subject to the model-tool gate;
- the expanded Skill body is injected exactly once, while the original user
  request and arguments remain user content.

---

## ADR-008: Evidence, Not Self-Report, Defines Completion

**Status**: Accepted

完成必须由 evidence + verdict 决定，而不是执行者自报完成。

Consequence:

- `Planner` 交 contract
- `Generator` 交 handoff
- `Evaluator` 交 verdict
- 缺 block 不得推进下游

---

## ADR-009: Work Is the Primary User-Visible Budget Signal

**Status**: Accepted

用户可见的主预算语义是 `Work used/total`。

`Round` 仅在真实额外 pass 存在时出现。

Reasoning:

- 用户需要理解成本，但不应暴露底层 worker iter 噪音
- `Iter x/y` 对 AMA 用户不可解释

---

## ADR-010: Evaluator’s Internal Review Must Not Leak into the Public Answer

**Status**: Accepted

Evaluator 可以在内部评估 Generator handoff，但这种元评估不应出现在用户最终答案里。

Consequence:

- 内部判断写入 verdict / transcript
- 用户答案直接面向用户交付结果

---

## ADR-011: `/project` Remains a Transitional Control Surface

**Status**: Accepted

`/project` 继续存在，但不再是主产品抽象。

它负责：

- inspection
- resume / pause / verify
- artifact browsing

---

## ADR-012: `Project` and `SA / AMA` Are Orthogonal Dimensions

**Status**: Accepted

`Project` 描述任务语境，`SA / AMA` 描述执行拓扑；二者可以合法组合。

Consequence:

- `Project + AMA` 继续使用完整 managed-task 语义
- `Project + SA` 是 first-class path，不是降级或非法路径
- `Project + SA` 不进入 managed-task graph，但会写 lightweight direct-run record 以支撑 status / summary / next-step continuity

---

## ADR-013: Non-Generator Roles Share Distilled Same-Role Summaries

**Status**: Accepted

`Scout`、`Planner`、`Evaluator` 保持 `reset-handoff`，但跨轮显式共享 distilled same-role summary。

Reasoning:

- 这些角色需要跨轮连续性，但不应恢复完整私有历史
- summary 注入比隐式依赖 artifacts 更稳定、更可控
- `Generator` 继续作为主要深度上下文消费者

---

## ADR-014: `H0_DIRECT` Means Single-Agent Finish

**Status**: Accepted

`H0` 的核心不是“完全没有判断阶段”，而是“最终没有多 agent handoff”。

Consequence:

- `H0` 允许两种合法形态：
  - `Direct H0`
  - `Scout-complete H0`
- 如果 `Scout` 判定 `H0_DIRECT` 且证据已足够，则由 `Scout` 直接给最终用户答案
- 不允许 `Scout` 判定 `H0` 后再 handoff 给第二个 direct agent

---

## ADR-015: Read-Only and Docs-Only Work Are Capped Below `H2`

**Status**: Accepted

`read-only` 与 `docs-only` 任务永远不进入 `H2`。

Consequence:

- 这类任务默认停留在 `H0`
- 只有用户明确要求 `double-check`、`second pass`、`更强审查` 或等价意图时，才允许进入 `H1`
- `reviewScale`、repo 规模、diff 大小、模块数量只影响 evidence strategy，不得单独抬高 harness

---

## ADR-016: `H1` Is Lightweight Checked-Direct, Not Mini-`H2`

**Status**: Accepted

`H1` 的设计目标是“轻快但有轻度质量保障”，而不是缩小版的 coordinated harness。

Consequence:

- `H1` 固定为 `Generator + 轻量 Evaluator`
- 无 `Planner`
- 无 contract negotiation
- 无默认多轮 refine
- `Scout` 进入 `H1` 后立即停手，只交付中等丰富、严格受限的 cheap-facts handoff
- `Evaluator` 只检查：
  - 是否对题
  - 是否漏项
  - 关键 claim 是否有证据
  - 是否明显过度自信
- `read-only/docs-only` 的 `H1` 最多只允许一次短 revise；失败后返回 `best-effort + limits`，不升级到 `H2`

---

## ADR-017: `--team` Is Not a Product Mode

**Status**: Accepted

`--team` 不再是主产品故事的一部分。

如果保留兼容入口，也只应视为 deprecated plumbing。

---

## ADR-018: Scout-First AMA Entry (FEATURE_061)

**Status**: Accepted

所有 AMA 请求由 Scout 作为唯一入口，不再有预路由 LLM 调用或 harness guardrail 层。

Consequence:

- Intent Gate 直接进 Scout，无 `routeTaskWithLLM` 预判
- `shouldBypassScoutForManagedH0` 已删除
- 预路由 harness floor 已删除（`resolveManagedHarnessGuardrail`）
- 3 个 Tactical Flow 被角色级 subagent 替代

Reasoning:

- 预路由消耗额外 LLM 调用但准确率不高
- Scout 已有足够信息在内部判断 H0/H1/H2
- 减少 ~3200 行代码

---

## ADR-019: Immutable Budget Model (FEATURE_062)

**Status**: Accepted

AMA budget 从 10 字段 + 14 函数简化为 `{ cap, used }` + 4 个纯函数。

Consequence:

- Budget zone、reserve logic、iter limits 全部移除
- convergence signal 内联到 `buildWorkerRunOptions`
- Budget 判断变为 `used/cap` 纯比较

Reasoning:

- 旧模型复杂度远超实际需要
- 新模型更 immutable、更可测试、更 LLM-friendly

---

## ADR-020: Unified Agent Execution Substrate (FEATURE_100, v0.7.29)

**Status**: Accepted

KodaX 的 SA 与 AMA 用户切换是永久产品决策（ADR-003 / ADR-012），但**实现层不再保留两套独立的 agent 执行路径**。所有 agent 调用 —— SA 直达、AMA 的 Scout/Planner/Generator/Evaluator、subagent fan-out —— 都通过同一个 Runner 帧、同一个 executor、同一套 Layer-A primitives 执行。

核心区分：

- **Layer A — substrate（共享）**：provider loop、tool dispatch、history 管理、microcompact、edit recovery、extension runtime、ToolGuardrail runtime、reasoning resolution、trace+span、session snapshot、cost tracking。所有 agent 共享，不绑定 mode。
- **Layer B — Agent declaration（多份）**：role name、system prompt、handoff config、reasoning profile、tool slice、opt-in middleware（如 auto-reroute、mutation reflection）。这是 mode 之间的全部差异。
  - SA topology = `Runner.run(defaultCodingAgent, prompt, ctx)`
  - AMA topology = `Runner.run(scoutAgent, prompt, ctx)`（Scout 自带 handoff 链）
- **dispatcher（薄层）**：`task-engine.ts` 仅按 `agentMode` 选择喂哪份 declaration，body 不分叉。

Reasoning:

- 产品对等不蕴含实现分叉。v0.7.27 commit `5cf161c` "SA and AMA are parallel, not legacy" 描述用户视角的对等；把它误读为"实现必须双轨"是 v0.7.23 Option Y 之后逐版本漂移的结果，不是经过审议的设计。
- 历史漂移：v0.7.23 FEATURE_080 把 SA body 重写到 Runner 的工作显式 punt 给 FEATURE_084；v0.7.26 FEATURE_084 只重写了 Scout/Generator/Evaluator，SA body 未动；之后无 ADR 记录该 punt 失效。本 ADR 关闭这个漂移。
- `runner-driven.ts` 的 13 处 "legacy parity restore" 注释是反向实证：FEATURE_084 当时让 AMA 路径绕开 `runKodaX`，结果陆续发现 `onSessionStart` / repoIntelligence / multimodal / `cleanupIncompleteToolCalls` / `saveSessionSnapshot` / cost tracker 等一批 SA body 已具备的能力在 AMA 缺失，靠补丁回填。统一底座之后这类失踪能力的发生条件消失。
- 路线图依赖：FEATURE_078（v0.7.30）/ FEATURE_089（v0.7.31）/ FEATURE_090（v0.7.32）/ FEATURE_092（v0.7.33）/ FEATURE_094（v0.7.42）都假设 reasoning profile / `Runner.run` 调用 / Runner-level guardrail 在两种 mode 下均可用。沿用双底座会让每个 feature 都重复一次"SA 端再接一遍"。
- 参照项目（pi-mono、openai-agents-python）均为单实现路径；KodaX 没有偏离它们的合理理由。

Consequence:

- `agent.ts` 的 `runKodaX` 不再是独立 SA 入口；其能力按 substrate / declaration 两类拆解到 `agent-runtime/` 与 `defaultCodingAgent`。
- `task-engine.ts` 的 SA / AMA 分支只挑 Agent declaration，不挑 executor。
- v0.7.23 FEATURE_080 引入的 "Option Y" preset dispatcher facade 升级为真实 Runner 帧入口，shim 删除。
- 未来新角色（如 FEATURE_089 生成的 Agent）天然在两种 mode 下都可调用，不需要 mode-specific wiring。
- ADR-003 / ADR-014 的语义不变；ADR-012（Project / SA / AMA 正交）的 SA / AMA 维度从"两种执行路径"重新定义为"两种 Agent topology 选择"。

Migration:

- 实施于 v0.7.29 FEATURE_100，单一 feature 占整版本。
- 直接切换，无 legacy flag。通过 capability inventory + golden-trace test suite + capability contract tests + dispatch eval baseline + reverse audit 五重保险保证零回归，详见 `docs/features/v0.7.29.md`。
- 原计划 v0.7.29 的 FEATURE_078 (Role-Aware Reasoning Profiles) 顺延到 v0.7.30，与 FEATURE_057 Track F 共版（工作面不交叉）。下游版本（089/090/092/094）保持原位。

---

## ADR-021: Agent Framework Boundary（@kodax-ai/agent vs @kodax-ai/coding）

**Status**: Accepted (FEATURE_142 v0.7.35.1)

KodaX 包结构按"包名 = 内容承诺"原则严格执行。`@kodax-ai/agent` 是**通用 Agent 框架（智能体底座）**，`@kodax-ai/coding` 是 **coding-specific** 实例。两者不可互相侵入，下面是判断规则。

### 落 `@kodax-ai/agent` 的内容（通用 agent 平台原语）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Agent primitives | `primitives/` | Agent / Runner / Handoff / Guardrail / Session interface |
| Admission contract | `admission/` | Admission pipeline + 7 quality invariants（FEATURE_101） |
| Messaging | `messaging/` | 2-tier priority queue + agentId routing（FEATURE_115） |
| Orchestration | `orchestration/` | Pattern B dispatch / child-task registry / idle-yield 状态机（detectIdleYield + waitForWakeEvent + composeIdleYieldUserMessage）/ Runner.runWithIdleYield 包装 / SendMessage router / TaskStop / Peer router（FEATURE_119/120/123/128/155 — v0.7.39 FEATURE_120 Step 0 完成包归属迁移） |
| ~~Scratchpad~~ | ~~`scratchpad/`~~ | ~~去耦合大输出通道（FEATURE_121）~~ — **2026-05-12 取消**：FEATURE_121 v0.7.40 rescoped 为 "Envelope Spillover Gap-Fix"（复用 `@kodax-ai/coding/tools/tool-result-policy.ts` 现有 spillover 体系 + `@kodax-ai/agent/orchestration/idle-yield.ts` 加聚合 cap），**不新建 `scratchpad/` 子目录、不引入新工具**。详见 [features/v0.7.40.md](features/v0.7.40.md#feature_121-envelope-spillover-gap-fix--child-task-summary-接入-tool-result-policy) |
| Memory | `memory/` | 4-type taxonomy + scope resolver（FEATURE_124） |
| Team | `team/` | Multi-instance state broadcast + system-prompt injection（FEATURE_125） |
| Construction | `construction/` | Self-Construction runtime / agent-resolver / sandbox-runner（FEATURE_087/088/089/090/101） |
| Runtime middleware | `runtime-middleware/` | 通用 substrate middleware（compaction-trigger / max-tokens-continuation / permission-gate 接口层） |
| Tokenizer | `tokenizer.ts` | O(n) multilingual/dense-data estimate; Provider usage remains authoritative |

**判定规则**：任何"非 coding agent 也需要"的 agent 平台能力 → `@kodax-ai/agent`。

### 落 `@kodax-ai/coding` 的内容（coding-specific）

| 类别 | 子目录 | 例子 |
|---|---|---|
| Coding tools | `tools/` | Read / Write / Edit / MultiEdit / Bash / Grep / Glob / WebFetch / WebSearch / SemanticLookup / RepoOverview |
| Tool wrappers for agent platform tools | `tools/` | dispatch_child_task / send_message / task_stop / list_agents / todo_update（**工具壳留 coding，调 agent 端原语**；tool 描述文本含 coding-specific prompt）—— FEATURE_121 v0.7.40 rescope 后无 `write_scratchpad` / `read_scratchpad`（envelope spillover 由 framework 自动处理，Worker 直接用 Read 工具读 spill 文件） |
| Coding role prompts | `prompts/` / `agents/*-role-prompt.ts` | Worker / Scout / Planner / Generator / Evaluator role prompts |
| H2 task-engine 状态机 | `task-engine/` | managed-task / runner-driven / role-prompt builder（coding AMA-specific） |
| Coding agent 实例 | `agents/` | defaultCodingAgent / scoutAgent / generatorAgent / evaluatorAgent |
| Coding-specific middleware | `agent-runtime/` | tool-dispatch / prompt-content / assistant-message-builder / per-turn-reasoning |
| Coding preset | `coding-preset.ts` | DEFAULT_CODING_INSTRUCTIONS + tool slice 装配 |
| Repo intelligence | `repo-intelligence/` | Coding-specific 仓库结构理解 |
| Coding-side provider wiring | `providers/` | Coding 端的 wire-level provider 配置 |
| File-mutation safety net | `multi-instance/` | content-hash-cache / active-file-warning（绑 Edit / Read tool 实现） |

**判定规则**：任何"只对 coding agent 有意义"的内容 → `@kodax-ai/coding`。

### Tool wrapper 的双层模式

通用 agent 平台工具（dispatch_child_task / send_message / task_stop / list_agents 等）使用**双层模式**：

- **底层 primitive** 在 `@kodax-ai/agent/<domain>/`：路由 / 队列 / 注册表 / 协议（不含 prompt）
- **工具壳** 在 `@kodax-ai/coding/tools/`：tool schema + handler 调底层 primitive；tool description 含 coding-specific prompt（如 "use this when reviewing a coding PR"）

理由：tool description 是 prompt 工程的一部分，含 coding 偏置；底层路由 / 队列等机制对所有 agent 通用。未来真有 ≥3 个非 coding agent 包后，可以再抽 `@kodax-ai/agent/tools/` 通用工具壳层。当前 1 个 consumer，按 KodaX 哲学不预先抽。

### 何时考虑再开 `@kodax/core`（types-only 子包）

撤销 `@kodax/core`（v0.7.35.1）后，未来 **当且仅当**下面三条**至少一条**成立时，才考虑从 `@kodax-ai/agent` 拆出 `@kodax/core` types-only 子包：

1. 出现 ≥3 个 type-only declaration 消费者（例如 IDE 插件 typecheck 用户的 agent manifest 但不跑）
2. 出现真实跨包横切设施需求（例如 errors 类被 `@kodax-ai/llm` / `@kodax-ai/agent` / `@kodax-ai/coding` 都需要统一 shape）
3. 出现 ≥3 个非 coding agent 包（`@kodax-ai/data-analysis-agent` / `@kodax-ai/ops-agent` / 等），它们之间需要共享 Layer A types 但不互相依赖

**严禁预先开包**。FEATURE_082 v0.7.24 在 1 个 consumer 时强行建立 4 层模型（`ai → core → capabilities → coding`），导致 `@kodax/capabilities` 成为死设计 + `@kodax/core` 名实倒挂——这是 KodaX `NEVER add abstractions until 3+ concrete use cases` 哲学违反的实证后果，本 ADR 写明以避免重蹈。

### 撤销的 `@kodax/capabilities` 死设计

FEATURE_082 v0.7.24 设计稿曾把 `@kodax/capabilities` 作为 Layer B 组合能力包列入新包清单和依赖图，并约定 FEATURE_084 v0.7.26 把 Scout/Evaluator/Generator 落入此包。但：

- `packages/capabilities/` **从未被创建**
- FEATURE_084 真要落 Scout/Evaluator/Generator 时绕开它，直接放 `coding/src/agents/`
- 事后回看：Scout/Evaluator/Generator 是 coding AMA H2 实例，本来就该在 coding——"通用 capabilities"是预先抽象

v0.7.35.1 (FEATURE_142) 正式从 ADR / 文档清理 `@kodax/capabilities`，**永久撤销**。未来如真出现"通用能力包"需求（满足 ADR-021 §"何时考虑再开 core"的 3 条之一），可以新设包，不复用 `capabilities` 名字（避免与历史死设计混淆）。

---

## ADR-022: npm Distribution — Single Bundle, Not Multi-Package (FEATURE_150, v0.7.37)

**Status**: Accepted (2026-05-08)

**TL;DR**：源码层保持 9 子包 + 1 root 的分层 monorepo（ADR-001 不变），npm 发布层从"10 个独立包"切到"**1 个 bundle 包 `@kodax-ai/cli`**"。

### 背景

FEATURE_147 (v0.7.37) 完成了 `@kodax/*` → `@kodax-ai/*` scope 重命名，并首次把 9 个子包 + 1 个 root 共 10 个包发布到 npm 公网 registry。发布后立即暴露三个 P0 类问题：

1. **`@kodax-ai/coding` 漏声明 4 个 runtime deps**（`typescript` / `tsx` / `iconv-lite` / `glob`）。Dev 环境靠 monorepo root hoisting 隐藏；终端用户 `npx @kodax-ai/cli` 第一次 `import 'typescript'` 直接 `ERR_MODULE_NOT_FOUND`。
2. **`@kodax-ai/repl` 漏声明 26 个 vendored Ink fork transitive deps**（`yoga-layout` / `react-reconciler` / `ws` / `scheduler` / 等等）。Vendored fork 模式下原 Ink 包的 transitive deps 没人替我们装。
3. **`@kodax-ai/skills` 6 个 helper script 残留旧 scope 引用 `@kodax-ai/coding`**。即使改成 `@kodax-ai/coding`，bundle 模式下该包不再发布到 npm，仍然解析不到。

### 决策

放弃 multi-package 发布模型，改用 esbuild bundle root entry 成单文件，9 个子包**不再发布到 npm**。

### Reasoning

1. **没有真实 SDK 用户**。CLAUDE.md 写过 "every package is independently usable"，但这是架构愿景，不是用户量验证。真实使用形态是 `kodax` 命令；零证据表明有人 `npm install @kodax-ai/coding` 单独消费。
2. **SDK 集成方有标准替代路径**。想做基于 KodaX 的产品的开发者，`git clone + npm link / file: 协议 + esbuild bundle 自己的产品` 是成熟工程做法。这条路径**不依赖** KodaX 在 npm 上发子包，但必须遵守对应副本的许可：0.7.70 及之后的官方分发适用 KAI-FCL 或配套客户条款，商业或托管用途需要 KodaX-AI 授权；此前已按 Apache-2.0 分发的特定副本保留原授权。
3. **bug class 整体消除**。Multi-package 模式下"vendored fork transitive deps 漏声明"这类 bug 是发版 9 包都要重新校验一遍的脆弱面。Bundle 模式下 esbuild 自动跟踪 transitive imports，整个 bug class 不再可能触发。
4. **维护成本下降一个量级**。一个 `package.json` 取代 10 个；一个 version 号取代 10 个；一次 `npm publish` 取代 10 次（外加 root 的临时 rewrite 脚本）。
5. **"独立可用"愿景通过源码可读 + license + monorepo 结构保留**。使用方式从"装 npm 包"变成"读源码 + bundle 自己用"，这正是 SDK 集成方实际在做的事。

### Consequences

**保留不变**：
- `packages/{ai,agent,coding,mcp,repl,repointel-protocol,session-lineage,skills,tracing}/` 9 个子包目录、各自 `package.json`、各自 `src/` / `dist/` 编译产物 → 全部不变（源码层"每个包独立可用"承诺）
- ADR-001 / ADR-021 的 layered monorepo 设计不变
- npm workspace 内部 `*` 协议 deps 不变
- dev 命令 `npm run dev` / `npm run build` / `npm run test` 不变

**改变**：
- npm registry 上只有 `@kodax-ai/cli@<version>`（root），9 个 `@kodax-ai/{llm,agent,...}` 不再发布
- root `package.json#dependencies` 合并所有 9 子包的真第三方 deps（约 35 个第三方包），删除所有 internal `@kodax-ai/*` workspace deps
- `scripts/release-npm.mjs` + `scripts/publish-root-cli.mjs` 删除，替换为 `scripts/release.mjs`（单包发布）
- 新增 `scripts/build-bundle.mjs` —— esbuild 三个 entry：
  - `src/kodax_cli.ts` → `dist/kodax_cli.js`（CLI bin 入口）
  - `src/index.ts` → `dist/index.js`（SDK 入口；服务于 KodaX 自己的 builtin helper scripts，顺带开放给路径 B 集成方）
  - 静态复制 `packages/skills/dist/builtin/` → `dist/builtin/`（LLM 通过 skill 触发的资源；目录名必须是 `builtin` 而非 `builtin-skills`，因为 `@kodax-ai/skills` 通过 `path.join(__dirname, 'builtin')` 解析）

**对 SDK 集成方影响**：
- 路径 A（推荐）—— `git clone + npm link + bundle 自己产品`：完全不受影响
- 路径 B（顺带支持）—— `npm install @kodax-ai/cli` 后 `import { runKodaX } from '@kodax-ai/cli'`：可用，但绑定 cli version cadence
- 旧 multi-package install（`npm install @kodax-ai/coding`）—— 不再支持；CHANGELOG / migration notes 注明引导

### 替代方案讨论

**A. 修 deps republish multi-package**：保留 10 包模式，把漏的 30 个 deps 修齐重发。被否：长期看 vendored fork transitive deps 漏声明的 bug class 仍在；维护成本不变；不解决"无 SDK 用户但发 10 包"的根本不对称。

**C. 混合（保留 `@kodax-ai/llm` `@kodax-ai/agent` 独立发，其他 bundle）**：被否：当前没有任何证据这两个包有独立 SDK 价值；混合模式同时承担两套发版工程的复杂度。

### 与 ADR-001 / ADR-021 的关系

源码层分层（ADR-001 / ADR-021）**完全不变**：9 个子包仍然是层次清晰的分层模型，layer independence 仍是 review 必须坚守的不变量。变化只在**发布层**：从"层次直接映射到 npm package 列表"改成"层次保持源码可读但发布物聚合为单包"。

### 触发回退的条件

未来当且仅当下面**同时**两条成立时，才考虑回到 multi-package 发布模式：

1. 出现 ≥3 个真实独立 SDK 消费者（不是 KodaX 自己的 monorepo 内部消费），且他们明确反馈"装单包绑 cli version 不可接受"
2. 至少 2 个子包出现独立的 release cadence 需求（即 cli 不发版的同时这些子包要发新 version）

仅 1 条满足不足以回滚 —— 单 SDK 用户可以通过路径 A（git clone + bundle）解决。

### Addendum (v0.7.39, 2026-05-11) — 包名更正 `@kodax-ai/cli` → `@kodax-ai/kodax-cli`

> **Status (2026-05-12)**: 本 addendum 描述的中间状态 `@kodax-ai/kodax-cli` 已被 **ADR-024** 取代为 `@kodax-ai/kodax`。v0.7.38 在 npm 上确实双发了 `@kodax-ai/kodax-cli@0.7.38`（作为 `@kodax-ai/cli@0.7.38` 同代码 dual-publish），但 v0.7.39 起的正式发布物名称是 `@kodax-ai/kodax`（无 `-cli` 后缀）。保留下文记录决策演变历史。

v0.7.37/v0.7.38 在 npm 上的包名是 `@kodax-ai/cli`。命名时跟随了 SDK 范式（`@org/cli` 形态名），但实践证明这与 KodaX 作为**产品**的定位不匹配——业界主流是把 npm 包名直接对齐产品名（`@anthropic-ai/claude-code`、`aider-chat` 等）。v0.7.38 刚发完正式版本（之前只有 0.0.1 占位包），用户量极小，是改名最佳窗口期。

**决定**：v0.7.39 起改名为 `@kodax-ai/kodax-cli`。
- 保留 `@kodax-ai` scope（未来加 `@kodax-ai/sdk` 等独立子包仍有命名空间）
- 包名第二段直接 = 产品名 `kodax`，对齐业界主流
- 保留 `-cli` 后缀明确这是 CLI 工具的发布形态

**Migration**：
- `scripts/release.mjs` 改 `pkg.name = '@kodax-ai/kodax-cli'`
- 所有 forward-going 文档（HLD、README、ADR-022 本段、release.mjs banner、build-bundle banner、skill-creator/utils.js Strategy 3）一次性更新
- 历史记录（CHANGELOG v0.7.37/v0.7.38 entries、docs/features/v0.7.37.md、docs/FEATURE_LIST.md）保留原 `@kodax-ai/cli` 字样，作为命名历史的真实记录
- v0.7.39 发布后对 `@kodax-ai/cli@*` 执行 `npm deprecate "Package renamed to @kodax-ai/kodax-cli. Run: npm install -g @kodax-ai/kodax-cli"`
- `skill-creator/scripts/utils.js` 保留 `import('@kodax-ai/cli')` 作为 Strategy 4 兜底（向后兼容 v0.7.37/v0.7.38 已安装用户）；deprecation 窗口过后再移除

**不改的部分**：
- `packages/*/package.json` 里 `@kodax-ai/{ai,agent,coding,mcp,repl,...}` 子包名**不动**——它们本来就不发到 npm（bundle 模式），仅作 workspace 内部 alias。这次改名只针对 root 发布物。
- bin 命令 `kodax` 不动（安装后用户跑的命令仍是 `kodax`）。

---

## ADR-023: Bash Command Parsing — Regex → AST Migration (FEATURE_152, v0.7.38)

**Status**: Proposed (2026-05-09)

**TL;DR**：`packages/repl/src/permission/permission.ts` 里 `isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets` 从手写 regex 拼凑迁移到基于 **`shell-quote`（pure JS POSIX shell parser）** 的 AST 解析。**不**引入 tree-sitter（CC 用作 primary path）—— shell-quote 单独覆盖 99% 场景，且 KodaX "极致轻量化" 哲学不接受 WASM 二进制膨胀。Issue 129 (v0.7.38) 临时 strip-then-classify hack 在迁移落地的同一 commit 内一次性删除（**不并行**两套实现）。

### 背景

当前 [permission.ts](../packages/repl/src/permission/permission.ts) 用 4 个 regex 常量加手写字符串切分判定 bash 命令是只读还是写：

- `BASH_REDIRECTION_WRITE_PATTERN = /(^|[^<])>>?(?=\s*\S)/`
- `BASH_WRITE_COMMAND_REGEXES`（按 `BASH_WRITE_COMMANDS` set 动态生成）
- `BASH_WRITE_SUBCOMMAND_PATTERNS`（PowerShell cmdlet 关键字）
- `baseIllegalSyntax = /[<>;`]|\$\(|(?<!&)&(?!&)|\|\|/`（在 `isBashReadCommand` 内）

这套设计在 KodaX 早期（v0.3.x）足够用，但近期暴露了三类系统性问题：

**问题 A — 假阳性导致 LLM 分类器被 short-circuit**（已有 [Issue 129](KNOWN_ISSUES.md#129) 实例）：
- `2>NUL` (Windows) / `2>/dev/null` (POSIX) stderr 丢弃被当成写文件 → [tool-confirmation.ts:94](../packages/repl/src/common/tool-confirmation.ts#L94) 把 Intent 标成 "Modify files"
- 配合 [executor.ts:236-247](../packages/repl/src/permission/executor.ts#L236-L247) 出项目 `cd` 的硬规则，auto 模式下 FEATURE_092 (v0.7.33) 的 LLM 分类器没机会发言

**问题 B — Windows / 复合命令族覆盖不全**：
- `findstr` / `fc` / `where`（Windows 原生工具）原本不在 `BASH_SAFE_READ_COMMANDS`
- 管道 `|` 一票否决（已有 `&&` 拆分，但没扩展到 `|`）
- heredoc / line-continuation / 命令替换嵌套等 attack vector 不受 regex 检查（CC 在 [commands.ts:120-160](C:\Works\claudecode\src\utils\bash\commands.ts#L120-L160) 有大段安全注释专门处理）

**问题 C — 维护成本随场景膨胀**：
- Issue 129 已通过 strip-then-classify pre-pass（`NULL_DEVICE_REDIRECT_PATTERN` 在 regex 之前先擦掉 fd-redirect）解决，但每次发现新的"语法上读、regex 误判写"场景都要再加一个 strip。技术债在累积。

参考实现：Claude Code 在 [`utils/bash/commands.ts`](C:\Works\claudecode\src\utils\bash\commands.ts) (1339 行) 用 **tree-sitter 作为 primary**（精度 + 性能）+ **shell-quote 作为兜底**（覆盖 tree-sitter 不可用环境）。Tree-sitter 路径需要 WASM binary（`tree-sitter-bash.wasm` ~500KB）+ async 初始化；shell-quote 是 pure JS、同步 API、~12KB。

### 决策

KodaX 跳过 tree-sitter，直接用 shell-quote 作为唯一 AST 后端。新增内部模块 [`packages/repl/src/permission/bash-ast.ts`](../packages/repl/src/permission/bash-ast.ts)，对外只暴露既有公开签名（`isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets`），调用方零改动。

### Reasoning

1. **极致轻量化哲学**（[CLAUDE.md](../CLAUDE.md) 核心原则之一）：tree-sitter + WASM ~500KB 进单文件二进制不可接受。shell-quote 12KB pure JS 可接受。
2. **shell-quote 已被 CC 验证覆盖 99% 场景**：CC 把它当 fallback 全功能路径，不是降级路径——任何 tree-sitter 不在的场景，shell-quote 同样产出正确决策。
3. **同步 API 保持**：现有 `isBashReadCommand(command: string): boolean` 是同步签名，调用方包括 [executor.ts:197](../packages/repl/src/permission/executor.ts#L197) 同步执行链。tree-sitter WASM 强制异步会污染 4 个调用文件 + 上游 `executeWithPermission` 链路。shell-quote 同步即可。
4. **fail-closed 是默认安全语义**：shell-quote 在解析失败（malformed shell syntax）时返回 error；新代码视作 "unsafe → 提示用户" 而不是放行。镜像 CC `splitCommandWithOperators` 在 [commands.ts:156-160](C:\Works\claudecode\src\utils\bash\commands.ts#L156-L160) 的 fail-closed 策略。
5. **一次性替换避免新旧并行**（feedback memory: 大重构不引入新旧代码并行）：迁移 land 的同一 commit 内删除所有 regex 常量 + Issue 129 的 `NULL_DEVICE_REDIRECT_PATTERN` strip-then-classify hack。任何瞬间只有一套实现。
6. **PowerShell 不进 AST**：`set-content` / `out-file` / `new-item` 等 PowerShell cmdlet 在 [permission.ts:177-187](../packages/repl/src/permission/permission.ts#L177-L187) 的 `BASH_WRITE_SUBCOMMAND_PATTERNS` 里用关键字匹配，不属于 POSIX shell 语法族；本 ADR 不动。

### Consequences

**保留不变**：
- 4 个公开函数签名（`isBashReadCommand` / `isBashWriteCommand` / `extractPathsFromCommand` / `collectBashWriteTargets`）+ 类型 → 调用方 0 改动
- `BASH_SAFE_READ_COMMANDS` set 作为白名单语义保留（仍是命令名匹配的 source of truth）
- `BASH_WRITE_COMMANDS` set 同上
- `BASH_WRITE_SUBCOMMAND_PATTERNS`（PowerShell 关键字）保留
- `getBashOutsideProjectWriteRisk` / `getPlanModeBlockReason` 行为保留
- `tool-confirmation.ts` 的 Intent / Risk 分类逻辑保留（消费 `isBashWriteCommand` 的输出）

**删除**：
- `BASH_REDIRECTION_WRITE_PATTERN` regex 常量
- `BASH_WRITE_COMMAND_REGEXES` 编译数组
- `NULL_DEVICE_REDIRECT_PATTERN`（Issue 129 引入的临时 hack）
- `isBashReadCommand` 内部的 `baseIllegalSyntax` / `subCommands.split(...)` 手写切分逻辑

**新增**：
- `packages/repl/src/permission/bash-ast.ts`：内部 helper 模块，导出 `parseBashCommand(s)`（基于 shell-quote）、`extractRedirections(tokens)`、`splitByControlOps(tokens)` 等
- `package.json` deps 加 `shell-quote@^1.8` + `@types/shell-quote@^1.7`（dev）
- 测试加 ~40 case 覆盖 heredoc / 命令替换嵌套 / fd-redirect 各形态 / line-continuation / ZSH 力覆盖等 attack vector（参考 CC 的 hardening test）

**对 SDK 集成方影响**：无。所有改动在 `@kodax-ai/repl` 包内部。

### 替代方案讨论

**A. 继续用 regex + 每次新场景加 strip-pass**：被否。Issue 129 已经证明 `2>NUL` / `|` / `findstr` 任一个 regex 漏判都需要一次 hotfix；剩余场景（heredoc 写、ZSH `>!` 力覆盖、命令替换内嵌写）每个都要重复一遍。技术债线性增长。

**B. tree-sitter 作为 primary（CC 等价方案）**：被否。+500KB WASM 二进制 + async API 污染 + 4 个调用方需要重构同步链路。CC 也只把 tree-sitter 当性能优化，shell-quote 作 fallback —— 我们直接用 fallback 即可。

**C. 写自己的 lexer**：被否。1500+ 行 hand-rolled parser 等价于在 KodaX 内部重写一个 shell-quote。`shell-quote` 是 substack 维护多年的稳定库（npm 周下载 1500 万+，CC 用作生产 fallback），自己重写不增加价值。

**D. 把 Issue 129 的 strip-then-classify pattern 系统化（每个 false-positive 加一条 strip 规则）**：被否。等价于方案 A 的工程化版本——治标不治本，且 strip-pass 本身改命令字符串，未来如果分类器需要看完整命令 token（比如 LLM prefix extractor / FEATURE_153）会失真。

### 与其他 ADR 的关系

- **不影响 ADR-001 / ADR-021**（包结构、layered monorepo）：所有改动在 `@kodax-ai/repl` 包内部。
- **不影响 ADR-022**（npm bundle 发布）：`shell-quote` 作为 root `package.json` 的 deps 经 esbuild 自动 inline 到 `dist/kodax_cli.js`，不增加发布工程负担。
- **解锁 FEATURE_092 (v0.7.33) 的设计意图**：auto-mode LLM classifier 当前被规则层假阳性 short-circuit；AST 化后误判面收敛，classifier 在所有 non-trivial 命令上拿回主决策权——这是用户感知 auto 模式 "顺/不顺" 的根因。
- **解锁 FEATURE_153**（LLM prefix extractor，参考 CC `BASH_POLICY_SPEC`）：prefix extractor 需要的是命令的 token 化结构（"command name + args"），shell-quote AST 直接产出，FEATURE_153 不再需要自己解析。
- **不影响 FEATURE_154**（universal `--help` fast-path）：`isHelpCommand` 是基于 token 的判定，shell-quote 输出直接喂进去更简洁。

### 触发回退的条件

未来当且仅当下面**任一**条成立时，回滚到 hand-written parser（注意：不会回滚到 v0.7.37 的纯 regex 方案，那个已经被验证不够）：

1. shell-quote 出现无法修复的安全 bug（CC 已经在生产 fallback 路径用了 1+ 年没遇到，概率低）
2. 出现 ≥3 个 KodaX 实测场景 shell-quote 解析正确但产出的 token 流不足以做安全决策，且无法通过补充 token-walker 逻辑解决

### 实施切片（FEATURE_152）

每个切片独立 commit + push，逐步 review：

| Slice | 改动 | LOC | 风险 |
|---|---|---|---|
| 1 | 引入 `bash-ast.ts` + 装 `shell-quote` deps，**不接入** | ~400 | 中（新增模块；既有路径不动） |
| 2 | 切换 `isBashReadCommand` / `isBashWriteCommand` 内部到 AST，**同 commit 删 `NULL_DEVICE_REDIRECT_PATTERN` + 旧 regex 常量** | ~500 | **高**（核心切换；no-parallel 原则） |
| 3 | 切换 `extractPathsFromCommand` / `collectBashWriteTargets` 到 AST | ~300 | 中 |
| 4 | 清理：删除已无引用的 `BASH_*_REGEXES` / `BASH_REDIRECTION_WRITE_PATTERN` 等 dead code，补 hardening test（heredoc / 命令替换 / ZSH 力覆盖） | ~200 | 低 |

每个 slice 完成后跑：`packages/repl/src/permission/` 全测 + `packages/repl/src/common/tool-confirmation.test.ts` + `tests/tracker-consistency.test.ts` + `npm run build`，确认 0 漂移 0 退化再进下一片。

---

## ADR-024: npm 发布物正名 `@kodax-ai/kodax` + SDK Subpath Exports 形式化 (v0.7.39)

**Status**: Accepted (2026-05-12)

> **Later status (2026-06-28 / v0.7.57)**: 本 ADR 记录 v0.7.39 当时的 5-subpath 形式化决策。后续 ADR-032 增加 `/mcp`，ADR-038 增加 `/session`，ADR-036 / FEATURE_194 将 skills/mcp/session-lineage/tracing 等源码包内联，v0.7.56 增加 `/media`。当前根发布包为 `@kodax-ai/kodax`，SDK subpath 为 8 个：`/agent`、`/llm`、`/coding`、`/media`、`/repl`、`/skills`、`/mcp`、`/session`。

**TL;DR**：把 npm 发布物从 `@kodax-ai/kodax-cli`（v0.7.38 中间形态）改为 `@kodax-ai/kodax`（去 `-cli` 后缀），同时通过 ESM subpath exports 把 5 个内部包（agent / llm / coding / repl / skills）显式开放给 SDK 消费者。源码层分包（ADR-001 / ADR-021）**完全不变**；ADR-022 的"单 bundle 发布"决策**仍然成立** —— 本 ADR 只是在 bundle 内部增加 6 个 entry（root + 5 subpath）并共享 chunks。

### 背景

v0.7.37 / v0.7.38 在 npm 上的包名经历了两次决策：

1. v0.7.37/v0.7.38 首发：`@kodax-ai/cli`
2. v0.7.38 dual-publish：`@kodax-ai/kodax-cli`（同代码，ADR-022 Addendum 记录的中间状态）

v0.7.38 发布后的复盘暴露两个问题：

1. **`-cli` 后缀和"产品名 = 包名"业界主流不一致**。`@anthropic-ai/claude-code`、`aider-chat`、`next`、`vite` 等都是产品名直接做包名，没有 `-cli` 后缀。`-cli` 后缀暗示"还有一个非 CLI 的 SDK 包"的二分结构，但 KodaX 实际上是一个 CLI + 内嵌 SDK 表层的整体。
2. **SDK 形态没有显式入口**。装 `@kodax-ai/kodax-cli` 后想 `import { Runner } from '...'` —— 只能从 root 拿到，且 root entry 把所有东西 re-export 到一处，bundler 静态分析不友好，对希望 tree-shake 的 SDK 消费者不够明确。

### 决策

1. **改名**：v0.7.39 起 npm 发布物名称为 `@kodax-ai/kodax`（无 `-cli` 后缀），覆盖 v0.7.38 的 `@kodax-ai/kodax-cli` 中间状态。
2. **SDK Subpath Exports**：在 `package.json#exports` 增加 5 个 subpath：
   - `@kodax-ai/kodax/agent`  → re-exports `@kodax-ai/agent`
   - `@kodax-ai/kodax/llm`    → re-exports `@kodax-ai/llm`
   - `@kodax-ai/kodax/coding` → re-exports `@kodax-ai/coding`
   - `@kodax-ai/kodax/repl`   → re-exports `@kodax-ai/repl`
   - `@kodax-ai/kodax/skills` → re-exports `@kodax-ai/skills`
3. **Bundle 结构**：CLI 仍然单 entry self-contained（最快 bin 启动）；6 个 SDK entry（root + 5 subpath）改用 esbuild `splitting: true` 多 entry 单次构建，共享代码自动落到 `dist/chunks/*.js`，避免 6× tarball 膨胀。

### Reasoning

1. **名字 = 产品**。`kodax` 命令、`kodax` 产品定位、`@kodax-ai/kodax` npm 包 —— 三者一致是最少认知负担的命名。
2. **改名窗口期 v0.7.38 → v0.7.39 最佳**。v0.7.38 是首次真实公网发布（之前只有 0.0.1 占位），用户量极小；v0.7.39 之前再改一次成本极低，v1.0 之后再改成本不可控。
3. **Subpath exports 是 SDK 表面化的标准做法**。ESM 生态（`react-dom/server`、`firebase/firestore`）证明这是 tree-shake 友好的方式；不引入新概念。
4. **共享 chunks 控制 bundle 膨胀**。5 个 subpath 几乎都 re-export 同一组内部代码；不共享会让 tarball 翻 6 倍。`splitting: true` 让每个 SDK entry 自己只剩 1-30 kB，chunks 集中 ~1.4 MB，整体 tarball ~1.1 MB 不变。

### Consequences

**变化**：

- `scripts/release.mjs`：`pkg.name = '@kodax-ai/kodax'`；`rewriteRootPackageJson()` 注入 5 个 subpath `exports`
- `scripts/build-bundle.mjs`：SDK 部分改多 entry + `splitting: true`，输出 `dist/index.js` + `dist/sdk-{agent,llm,coding,repl,skills}.js` + `dist/chunks/*.js`；CLI 路径保持 self-contained
- 新增 `src/sdk-{agent,llm,coding,repl,skills}.ts` —— 各自一行 `export * from '@kodax-ai/<pkg>'`
- `packages/skills/src/builtin/skill-creator/scripts/utils.js` SDK Strategy chain 简化为 3 层（relative / `@kodax-ai/coding` / `@kodax-ai/kodax`），删除 `@kodax-ai/kodax-cli` 和 `@kodax-ai/cli` 兜底

**不变**：

- 源码层 9 子包结构、layer independence、ADR-001 / ADR-021 全部不变
- ADR-022"单 bundle 发布"主决策不变 —— bundle 内部 entry 数目变化，对外仍是一个 npm 包
- bin 命令仍然是 `kodax`
- `packages/*/package.json` 的内部 `@kodax-ai/{ai,agent,coding,...}` workspace 包名不变（仍是 workspace internal alias，不发 npm）

**对 npm 上历史包的处理**：

- `@kodax-ai/cli@0.7.37` / `@kodax-ai/cli@0.7.38`：deprecate 指向 `@kodax-ai/kodax`
- `@kodax-ai/kodax-cli@0.7.38`：在 72h 窗口内 unpublish（仅一个版本，无下游绑定）；过期后 deprecate
- 不做 chain redirect（cli → kodax-cli → kodax）；直接两条 parallel deprecate（cli → kodax；kodax-cli → kodax）

### 替代方案讨论

**A. 保留 `-cli` 后缀，仅做 subpath exports**：被否。后缀 vs 主流不一致的问题不解决；v0.7.39 已是改名窗口最后机会。

**B. 拆 `@kodax-ai/sdk` 单独发包**：被否。引入第二个 npm 发布物违反 ADR-022 单 bundle 决策；当前没有任何独立 SDK 用户证据；subpath exports 已经把 SDK 表面暴露出来，不需要额外的 npm 包。

**C. 直接发 `@kodax-ai/agent` / `@kodax-ai/llm` 等独立子包**：被否。等同于回滚到 ADR-022 之前的 multi-package 发布模型 —— 那个模型的"vendored fork transitive deps 漏声明"bug class 仍未解决。

### 与 ADR-022 的关系

ADR-022 的"npm 发布物 = 单 bundle 包"主决策不变。ADR-024 在它之上做两件事：
1. 修正包名（不改变"单包"事实，只改名字）
2. 在 bundle 内部增加多 entry —— `package.json#exports` 通过 subpath 把同一个 npm 包的不同入口暴露给消费者，**仍然是一个 npm 包，一份 tarball，一个 version 号**

ADR-022 Addendum（"v0.7.39 改名 kodax-cli"）被 ADR-024 取代；保留为决策演变历史。

### 触发回退的条件

仅当 ADR-022 的回退条件成立（≥3 独立 SDK 用户 + ≥2 子包独立 release cadence）时，连带回滚 ADR-024 的 subpath exports 部分 —— 但即便如此，**`@kodax-ai/kodax` 这个包名不再改**（避免再次扰动用户安装命令）。

### Addendum (v0.7.43): published-shape root package.json + 简化 release.mjs

**Status**: Accepted (2026-05-23)

v0.7.39 ADR-024 落地时把 `name`、`exports`、`bin` normalize、`publishConfig` 全都放在 `scripts/release.mjs` 的 publish-time rewrite 里。dev 的 root `package.json` 保留 monorepo-internal 形态 `"name": "kodax"` + 单一 `exports: { "." }`，publish 那一刻 release.mjs 才把它改成 `@kodax-ai/kodax` + SDK subpaths。当前 dev package 常驻 8 个 SDK subpath。

**Trigger**: v0.7.42 SDK consumer (KodaX Space) gap report 第 4 项 — embedder 希望对本地 KodaX checkout 直接 `npm link @kodax-ai/kodax`，dev tree 不在已发布形态下时这条路彻底不通：
- `npm link` 按 root `name` 字段建 global symlink，dev tree 是 `kodax` 而非 `@kodax-ai/kodax`，consumer 端 `npm link @kodax-ai/kodax` 找不到目标
- 即便硬 fs.symlink 整个仓库，`import('@kodax-ai/kodax/coding')` 也会被 Node ESM `exports` encapsulation 拒绝（dev tree 的 `exports` 只声明 `.`）
- 强迫 embedder 先跑 `scripts/release.mjs --dry-run` 才能复制 publish-time 形态，对 in-tree SDK 迭代体验是结构性阻塞

**v0.7.43 决策，v0.7.57 状态**: 把已发布形态搬进 dev `package.json` —— `name` 直接是 `@kodax-ai/kodax`，当前 8 个 SDK subpath exports + `./package.json` 都常驻。**唯一的 publish-time 残留 mutation 是 toggle `private: true → false`**（保留 `private: true` 防止误 `npm publish` 裸根目录）。release.mjs 因此薄了大半：从 5 项 rewrite 变成单点 toggle，逻辑分支少了 4 个，出错面同步缩小。

**为什么不直接 `private: false` 进 dev**：失去防误发的最后一道闸门。当前 release flow 严格依赖 `scripts/release.mjs` 的 build + version-sanity 链路，bare `npm publish` 会跳过这些。`private: true` 是廉价的兜底，release.mjs 也会先做 sanity check（断言 `name === '@kodax-ai/kodax'` + `exports['./agent']` 存在 + `files` allowlist 非空）再 toggle —— dev tree drift 会在 publish 入口拒绝。

**业界对照**: vite / next / tailwindcss 的 root `package.json#name` 就是发布名（`vite` / `next` / `tailwindcss`），publish 仅靠 `publishConfig` + `files` 字段控制。ADR-024 v0.7.39 的 publish-time rewrite 模式当时是 `@kodax-ai/cli` → `@kodax-ai/kodax` 改名窗口的过渡产物，迁移完成后已无技术必要保留。

**回滚条件**: 与上文相同（ADR-022 回退条件）；本 addendum 不引入新的回滚阈值。

---

## ADR-025: auto[llm] 信号化分类器 — 决策层级倒置 + Windows-flag 误判结构性修复 (FEATURE_158, v0.7.39)

**Status**: Accepted (2026-05-12)

> **Current Auto[LLM] semantics (2026-08-03)**: ADR-060's decision-semantics
> addendum supersedes this ADR's Tier 0 non-overridable gate for Auto[LLM].
> Historical Tier 0 matches are now classifier facts and the LLM decision is
> final; explicit Auto[Rules] retains the legacy deterministic gate. The
> material below records the original FEATURE_158 design.

**TL;DR**：把 `auto` 模式的 REPL 同步硬规则（[`InkREPL.tsx`](../packages/repl/src/ui/InkREPL.tsx) Step 2.5 dangerous-bash + Step 3 protected-path）从**前置 veto** 改为**喂给 LLM 分类器的信号**；同时把 `~/.kodax/` 写、5 条 catastrophic 模式提升为 **Tier 0 绝对禁令**（LLM 不能 override）；引入 **speculative classify** 抹平延迟；保留 engine 降级到 'rules' 后**重新激活原硬规则路径**做兜底。结构性吃掉 [Issue 131](KNOWN_ISSUES.md#131) `looksLikePath` Windows-flag 误判（`findstr /R` / `dir /B` / `where /R` 等被当作 POSIX 绝对路径触发误确认）。对齐 CC `useCanUseTool` 单决策点 + `SAFE_YOLO_ALLOWLISTED_TOOLS` Tier 1 + `yoloClassifier` LLM-final 架构，但保留 KodaX 已有的 denial tracker / circuit breaker / engine 降级三件套。

### 背景

[FEATURE_092 (v0.7.33)](features/v0.7.33.md) 落地了 auto-mode LLM 分类器，但实际运行时 LLM **大概率不被调用**。链路：

```
REPL.beforeToolExecute (同步硬规则，先于 LLM)
  ├─ Step 1   bash-read fast-path → ALLOW
  ├─ Step 2.5 dangerous bash      → CONFIRM（veto）
  ├─ Step 3   protected path      → CONFIRM（veto）
  └─ Step 4   confirmTools (auto=空)
              ↓ (上面都没拦才到这里)
Runner.beforeTool → AutoModeToolGuardrail (LLM 分类器)
```

REPL 层规则一旦命中即 short-circuit，LLM **永远拿不到决策权**。实测：
- 用户报告 `git tag --sort=-creatordate | findstr /R "v[0-9]"` 在 auto 模式被误判为 Protected path。
- 根因：[`looksLikePath` (permission.ts:608)](../packages/repl/src/permission/permission.ts#L608) 把 Windows 风格 `/R` flag 当 POSIX 绝对路径 → `path.resolve('/R')` 解析为 `C:\R` → 不在 project / temp → 触发 `isAlwaysConfirmPath`。
- LLM 看到完整命令本可秒判"纯只读 piped 命令"，但 LLM 没被调用。

对照 Claude Code [`useCanUseTool.tsx`](../../claudecode/src/hooks/useCanUseTool.tsx) + [`classifierDecision.ts:SAFE_YOLO_ALLOWLISTED_TOOLS`](../../claudecode/src/utils/permissions/classifierDecision.ts) + [`yoloClassifier.ts`](../../claudecode/src/utils/permissions/yoloClassifier.ts)：CC 在 auto 模式下**只有一个决策点** `hasPermissionsToUseTool`；CC 的 `dangerousPatterns.ts` / `pathValidation.ts` 是**分类器 prompt 的输入信号**，不是分类器之前的硬否决。这就是 CC auto 模式"无打断"体感的结构性来源。

KodaX 的差距不在 LLM 模型能力，而在**决策架构**。

### 决策

`auto` 模式下，权限决策采用三层金字塔（plan / accept-edits 模式**不变**）：

```
┌─ Tier 1 (零成本直通，REPL 层)          ──────────────────────┐
│   • bash-read 白名单 + `--help` fast-path                    │
│   • Read/Grep/Glob/Todo/Task 等 projection==='' 工具         │
│   不调 LLM、不计费、不打断                                    │
└──────────────────────────────────────────────────────────────┘
                          ↓ (未命中)
┌─ Tier 0 (绝对禁令，Runner 层 LLM 之前)  ─────────────────────┐
│   硬编码 catastrophic patterns:                              │
│     1. rm -rf / 或 ~                                         │
│     2. mkfs.* / fdisk / format C:                            │
│     3. dd if=... of=/dev/sd*                                 │
│     4. :(){ :|:& };: (fork bomb)                             │
│     5. 写入 `~/.kodax/`（credentials 红线，例外见下）        │
│   直接 BLOCK，LLM 不能 override                              │
└──────────────────────────────────────────────────────────────┘
                          ↓ (未命中)
┌─ Tier 2 (LLM 综合裁决)                  ─────────────────────┐
│   1. 同步收集信号 (signals[])：                              │
│      • dangerous_pattern  (原 DEFAULT_DANGEROUS_PATTERNS)    │
│      • protected_path     (.kodax/ / ~/.kodax/ / 外部)       │
│      • outside_project    (路径在 project + temp 之外)       │
│      • shell_redirect_outside / package_install / network    │
│   2. classify(action, signals[], transcript, user_rules)     │
│   3. allow / block / escalate                                │
│   4. escalate 时 UI 用 signals 渲染 Scope / Risk 标签        │
└──────────────────────────────────────────────────────────────┘
                          ↓ (LLM 不可达 / engine='rules' 降级)
┌─ Fallback (重新激活 REPL Step 2.5/3 原硬规则路径)            │
│   denial 3/20 或 breaker 5/10m 后，行为等价今天的 auto       │
└──────────────────────────────────────────────────────────────┘
```

**Tier 0 `~/.kodax/` 写入例外**：仅 `kodax config set` / `kodax provider add` 等本进程自身管理的 IPC 写入路径不算（通过调用方 ID 而非命令字符串识别）。

**speculative classify**：tool call 进入 Tier 2 时立即发起 classify，并发起 350ms 的"安静窗口"（用户已习惯 ~200ms 视觉延迟）。若分类器在窗口内返回 allow，直接放行不弹 confirm；否则正常 escalate 流程。对齐 CC [`bashPermissions.ts:peekSpeculativeClassifierCheck`](../../claudecode/src/tools/BashTool/bashPermissions.ts) 思路，但实现更窄（不引入 BashPermission 框架）。

**Windows-flag 误判结构性修复**（吃掉 [Issue 131](KNOWN_ISSUES.md#131) hotfix）：
1. [`looksLikePath`](../packages/repl/src/permission/permission.ts) 在 `process.platform === 'win32'` 下识别 `/[A-Za-z]` / `/[A-Za-z]:` 形式为 cmd flag，不当路径。
2. `BASH_SAFE_READ_COMMANDS` 加入 `git tag` / `git stash list` / `git config --get` / `git describe`（CC `DEFAULT_SAFE_PATTERNS` 平价）。
3. 但**这两条本身就是 signals 输入路径的副产物**——结构性改完后，`looksLikePath` 即使再有边角误识别，LLM 看到 signal 也能正确决策；不再单点故障。

### Reasoning

1. **LLM 决策权回归**。FEATURE_092 设计目标是"LLM 综合判断"，现实是 30% 的 bash 命令 LLM 才能见到。决策层级倒置让 LLM 在 ≥95% 的非 Tier-1 命令上承担最终决策——这才是 FEATURE_092 当初的承诺。

2. **威胁模型对齐**。KodaX 是**单用户本地 CLI**（不是 SaaS），信任边界在 user ↔ agent，不在 user ↔ KodaX。在这个模型下：
   - 用户故意打 `rm -rf` 不需要系统保护他（Tier 0 只防"LLM 被 prompt 注入劫持"的灾难性场景）。
   - LLM 看 transcript 综合判断比硬规则更准（用户上一句说"清掉 node_modules" → `rm -rf node_modules` 应该 allow，硬规则不区分上下文）。

3. **平价保证**（重构不能削弱功能）。删除硬规则的退化风险通过三条防线兜住：
   - Tier 0 守住灾难性场景（不可 override）
   - LLM 看到所有原规则作为 signals，可主动 block
   - engine 降级路径**重新激活**原 Step 2.5/3，等价今天的 auto-in-project 行为

4. **不引入新旧代码并行**。Step 2.5/3 不加 feature flag、不保留 legacy code path、不做渐进 cutover。改完即生效，按 commit 粒度滚动；如需回退走 git revert。

5. **速度对齐 CC**。speculative classify 同期落地，否则用户感知延迟反而比今天差（今天硬规则同步即裁决，<10ms；改完每条 bash 都过 LLM，2-8s）。

### Consequences

**变化（新行为）**：

| 维度 | 现状 | 改后 |
|---|---|---|
| auto 模式下 LLM 调用率 | bash 命令 ~30% | bash 命令 ~95% (Tier 1 之外) |
| `~/.kodax/` 写保护 | 软规则可被绕过 | Tier 0 硬禁，IPC 例外 |
| Confirm 弹窗 Scope/Risk 标签 | 来自 REPL 层 `_alwaysConfirm` 等 marker | 来自 classifier 携带的 signals[] |
| Engine 降级（denial 3/20 或 breaker 5/10m） | escalate 一切 | 重新激活 Step 2.5/3 全规则路径 |
| `findstr /R` / `dir /B` / `where /R` 等 Windows flag | 误判 Protected path | 正确识别为 cmd flag，bash-read 直放 |
| `git tag` / `git stash list` / `git describe` | 走 LLM | Tier 1 fast-path 直放 |
| 平均延迟（非 Tier 1 bash） | <10ms (规则同步) | ~350ms (speculative 窗口) 或 ~2-8s (escalate) |
| Token 成本（每会话 auto bash 调用） | ~30% 触发 classifier | ~95%；用 prompt-cache 抹平 ~70% |

**不变（明确保留）**：

- `plan` 模式：所有硬规则、write/edit 阻止、`getPlanModeBlockReason` 完全不变。
- `accept-edits` 模式：alwaysAllowTools / prefix extractor (FEATURE_153) / outside-project file edit 确认完全不变。
- Tier 1：`isBashReadCommand` / `isHelpCommand` / Read/Grep/Glob 工具直放。
- FEATURE_092 已有基建：[denial-tracker](../packages/coding/src/guardrails/auto-mode/denial-tracker.ts) / [circuit-breaker](../packages/coding/src/guardrails/auto-mode/circuit-breaker.ts) / [model-resolver](../packages/coding/src/guardrails/auto-mode/model-resolver.ts) 全部保留。
- 子代理 `AutoModeSharedState` 共享 engine 状态。
- SDK 消费者（`executor.ts` 路径）：当 PermissionContext **没有** guardrail 接线时，Step 2.5/3 仍执行（fail-safe，等价 SDK 用户主动选 "auto + 自实现 onConfirm"）。
- ADR-023 (bash AST 解析) / ADR-021 (agent ↔ coding 边界) 不动。

**测试 churn**：
- [`permission.test.ts`](../packages/repl/src/permission/permission.test.ts) (109 用例) 中 ~20 用例需更新断言（Step 2.5/3 在 auto 模式下不再 veto）。
- [`tool-confirmation.test.ts`](../packages/repl/src/common/tool-confirmation.test.ts) (8 用例) 改为消费 signals。
- [`auto-mode-classifier.eval.ts`](../tests/auto-mode-classifier.eval.ts) (FEATURE_092 dataset) 复跑 + 加 5-10 个 Windows-flag 回归用例。
- 新增子代理 boundary 回归测试（劫持场景下 Tier 0 兜底）。

### 替代方案讨论

**A. 只做 hotfix (`looksLikePath` Windows-flag + `git tag` 白名单)，不动结构**：被否。
- 治标不治本——下一个 Windows flag（`xcopy /Y` / `robocopy /MIR`）还会复现。
- 真正的设计 bug 是**LLM 没被调用**，hotfix 不改决策层级，相当于继续给规则打补丁。
- 用户明确要求 0.7.39 必修，且不接受 issue + feature 拆分。

**B. v1 原方案"删除 REPL 硬规则，只剩 LLM + 极窄 Tier 0"**：被否。
- 自查暴露 5 处重大退化：dangerous 9 类规则丢、`~/.kodax/` 写裸奔、engine 降级失去规则兜底、子代理硬规则消失、SDK 消费者裸奔。
- v2（本 ADR）通过"信号化 + Tier 0 + 降级 fallback"三件套补回所有平价。

**C. 完全照搬 CC 单决策点架构（`hasPermissionsToUseTool` 收编 REPL beforeToolExecute）**：被否。
- KodaX 的两层（REPL `beforeToolExecute` + Runner `beforeTool` guardrail）来自 [ADR-021 agent ↔ coding 边界](#adr-021)，REPL 不应该承载 LLM 调用职责。
- 强行合并需要把 guardrail 上拉到 REPL 层或把 REPL 检查下沉到 guardrail，两者都违反 ADR-021。
- 本方案保留两层结构，只改"REPL 层从 veto 改为 signal-pass-through"，是最小侵入对齐。

**D. 加 feature flag 让用户选择"strict / signal" 模式**：被否。
- 违反用户记忆"大重构不引入新旧代码并行"。
- 两条代码路径常驻 = 长期维护负担 + 配置组合爆炸。
- 改完即生效，回退走 git revert。

**E. Tier 0 清单完全交给 LLM 自洽（无硬编码）**：被否。
- 防御纵深需要"LLM prompt 注入劫持"场景下的兜底；硬编码 5 条是已知 catastrophic 上限。
- 清单进 ADR-025 评审通过后**严禁扩张**——每加一条要走新的 ADR addendum。

### 与其他 ADR 的关系

| ADR | 关系 |
|---|---|
| ADR-021 (agent ↔ coding 边界) | 保留两层架构，REPL 层只改语义不改职责 |
| ADR-023 (bash regex → AST) | AST 解析仍是信号收集的输入；`extractPathsFromCommand` 输出喂给 signals.protected_path |
| FEATURE_092 (auto-mode classifier) | 本 ADR 是 FEATURE_092 的**真正激活**——分类器从"理论存在 30% 命中"变成"实际承担 95% 决策" |
| FEATURE_153 (LLM prefix extractor) | accept-edits 模式专用，不在本 ADR scope |
| FEATURE_154 (`--help` fast-path) | Tier 1 一部分，保留 |
| FEATURE_074 (subagent boundary) | 共享 SharedState 不变；Tier 0 + engine 降级路径在子代理同样生效 |

### 落地节奏（FEATURE_158, v0.7.39）

| Commit | 内容 | Review 锚点 |
|---|---|---|
| 1 | ADR-025 Accepted + Tier 0 清单评审通过 + FEATURE_LIST 登记 | 设计 review |
| 2 | `packages/coding/src/guardrails/auto-mode/signals.ts` 类型 + 收集器 + 单测（无消费方） | 类型/逻辑 review |
| 3 | `absolute-denylist.ts` (Tier 0) + 单测 | 安全 review (清单 freeze) |
| 4 | `classify.ts` 接受 `signals[]` + prompt 更新 + speculative classify 基建 | prompt/eval review |
| 5 | `looksLikePath` Windows-flag 修正 + `git tag` 等加入 `BASH_SAFE_READ_COMMANDS` + 回归测试（结构性修复 [Issue 131](KNOWN_ISSUES.md#131)） | bug parity review |
| 6 | `AutoModeToolGuardrail.beforeTool` 接 Tier 0 + signals + speculative classify | guardrail review |
| 7 | `onEngineChange` 通知 REPL + REPL 层在 `mode==='auto' && engine==='llm'` 时跳过 Step 2.5/3；其他组合走原路径 | **cutover commit**（最关键）|
| 8 | UI 接 signals → Scope/Risk 渲染；移除 `_alwaysConfirm` / `_dangerousCommand` / `_outsideProject` marker（在 auto 路径） | UX parity review |
| 9 | Eval：FEATURE_092 dataset 全量复跑 + Windows-flag 回归 + 子代理 boundary 回归 + 降级路径回归 | **release gate** |
| 10 | KNOWN_ISSUES 加 Issue 131 Resolved + v0.7.39 follow-up notes（如 speculative 窗口需调） + CHANGELOG + test guide | docs review |

**纪律**：
- 每个 commit 后主动 review 三件事（无新漏洞 / 无 scope 漂移 / 无功能退化）。
- 不引入新旧并行路径；REPL Step 2.5/3 在 auto 路径删除即删除，不留 feature flag。
- 前 6 个 commit 可独立 merge / 推迟；commit 7 是 cutover，必须配 commit 8/9 同 release。

### 触发回退的条件

回退（git revert commit 7+）触发条件，任一成立即立项 patch：

1. **安全回退**：上线 4 周内出现 ≥1 例 LLM 误放过原本应该 veto 的命令（用户报告 + git log 复现）。
2. **延迟回退**：speculative classify p95 > 1500ms（连续 3 天监控）；用户体感"等待感增加"反馈 ≥3 起。
3. **成本回退**：单会话平均 classifier token 消费 ≥ baseline × 4（prompt-cache 失效或 prompt 膨胀失控）。
4. **engine 降级误激活**：denial tracker / circuit breaker 在正常使用中误触 ≥1 次 / 周。

**保留兜底**：commit 5 的 Windows-flag 修复 + `git tag` 白名单是**纯加强**，不在回退范围；即使整体 cutover 回滚，这两条仍生效。

### Resolved Decisions (2026-05-12 self-review)

1. **`~/.kodax/` 写"IPC 例外"的实际结论：不需要例外**。 KodaX 内部配置写（`kodax config set` / `kodax provider add`）走 TypeScript `fs.writeFile` 直接调用，**不经过 bash tool**，不命中权限门。Tier 0 第 5 条只在 LLM 通过 bash 工具发出 `echo ... > ~/.kodax/foo` / `cp x ~/.kodax/y` 这类直接 shell 写入时触发——这些场景应当**无条件阻止**：合法配置编辑就该走 slash command 而非 LLM 拼 shell。
2. **speculative classify 窗口：初始 500ms，环境变量可调**。 Commit 4 落 `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env，默认 500ms（CC 同量级），实施期 micro-bench 三家 classifier p50/p95 后在 FEATURE_158 设计稿固化最终值。
3. **`/auto-signals` debug 命令推到 v0.7.40 follow-up**。 不阻塞本次 cutover；release 后用户反馈再立。

---

## ADR-026: `runner-driven.ts` 模块化拆分 — 6406 行单文件 → 12 个聚焦模块 (FEATURE_171, v0.7.41)

**Status**: Accepted (2026-05-16)

**TL;DR**：把 `packages/coding/src/task-engine/runner-driven.ts`（6406 行单文件、AMA 路径承载所有职责）按职责拆成 12 个聚焦模块（`_internal/managed-task/` 目录），主文件压缩到 1897 行（**70.4% 削减**）。**零行为变更**——所有提取为 byte-parity（regex 写法与 inline `import()` 类型注解的等价表达不算漂移）。分 4 个 commit (R1/R2/R3/R4) 落地，每个 commit 单独通过 code-reviewer 子代理 byte-parity 审计（4 次全 PASS、0 缺陷）；4314 个测试每个 commit 后全跑通过。**不引入新旧并行路径**——直接替换 + 顶部 re-export 保留公共导入面（4 个调用方 import path 零变更）。

### 背景

`runner-driven.ts` 是 FEATURE_084 (v0.7.26) 引入的 AMA Runner-driven 路径主入口。随后历经 FEATURE_114 (Harness V2 单循环 Worker)、FEATURE_155 (idle-yield)、FEATURE_120 (async chat-while-waiting)、FEATURE_159 (MessageQueue canonical)、FEATURE_161/162/163 (pull-tool adoption)、FEATURE_165 (handoff pending-children gate)、FEATURE_166 (post-handoff label flip)、FEATURE_167 (Evaluator terminal-verdict fallback)、FEATURE_168 (AMA tool wiring) 等近 10 个 feature 叠加，单文件膨胀到 6406 行。

**问题信号**：

- LLM 上下文 cost：单次 review 该文件需 ~22K tokens，触发 compaction 风险高；reviewer 容易漏 spot-check 末段代码。
- 修改成本：FEATURE_167 retry-config 落地时，单文件改动牵涉 580 行 diff（main runner + recorder + adapter 三块），人类 review 已接近上限。
- 测试隔离差：runner-driven.test.ts 198 个测试加载整个文件，单测 setup 耗时 ~600ms，远高于其他 task-engine 测试。
- 职责泄漏：role-prompts / role-exclude / write-turn-cap / status-derivation / tool-wrappers / dispatch-child / observer-bridge / verdict-recorder / agent-chain / llm-adapter / payload-builder / checkpoint-flow 12 个独立职责挤在一个文件里，layered import 拓扑被压扁。

**Trigger**：v0.7.41 排期内有 3-5 个 feature 计划继续修改 runner-driven 路径（FEATURE_165 完工后还有 follow-up），不拆下去单文件会突破 7000 行。

### 决策

把 `runner-driven.ts` 按职责拆成 12 个聚焦模块，全部放在 `packages/coding/src/task-engine/_internal/managed-task/` 目录下，分 4 个 commit 落地：

```
packages/coding/src/task-engine/
├── runner-driven.ts                          (1897 lines, was 6406)
│   ├─ 顶部 re-export 块保留公共导入面
│   │  (4 个调用方 import path 零变更)
│   └─ 主体保留: isRunnerDrivenRuntimeEnabled
│                __runnerDrivenTestables
│                runManagedTaskViaRunner (公共入口)
│                runManagedTaskViaRunnerInner (主循环)
└── _internal/managed-task/
    ├── types.ts                              (180 lines, R1)
    │  ↳ VerdictRecorder / AmaRole / ObserverBridge /
    │    RolePromptContextFactory / RunnerChainPromptContext
    │    — 打破 verdict-recorder ↔ observer-bridge 循环依赖
    ├── role-prompts.ts                       (297 lines, R1)
    │  ↳ WORKER_INSTRUCTIONS_FALLBACK + resolveRoleInstructions +
    │    buildCompletionContractStatus
    │  ↳ FEATURE_193 (v0.7.43) deleted Scout/Planner/Generator/Evaluator
    │    *_INSTRUCTIONS_FALLBACK + renderScoutSkillMapBlock
    ├── role-exclude.ts                       (142 lines, R1)
    │  ↳ FEATURE_168 per-role exclude sets + getAmaRoleEffectiveExclude
    ├── write-turn-cap.ts                     (100 lines, R1)
    │  ↳ P2b maybeApplyP2bWriteTurnCap
    ├── status-derivation.ts                  (97 lines, R1)
    │  ↳ extractUserFacingText / deriveFinalStatus /
    │    buildManagedProtocolPayload
    ├── tool-wrappers.ts                      (312 lines, R2)
    │  ↳ wrapCodingToolAsRunnable / wrapGeneratorBashWithMutationGuard /
    │    wrapGeneratorWriteWithMutationGuard / wrapReadOnlyBash
    ├── dispatch-child.ts                     (119 lines, R2)
    │  ↳ wrapDispatchChildTaskForRole (per-role child-task wrapper)
    ├── observer-bridge.ts                    (541 lines, R2)
    │  ↳ NULL_OBSERVER / buildObserverBridge / buildRunnerRoutingNote /
    │    applyScoutDecisionToPlanRunner + BUDGET_CAP_BY_HARNESS /
    │    BUDGET_EXTENSION_BY_HARNESS / MAX_ROUNDS_BY_HARNESS 常量
    ├── verdict-recorder.ts                   (532 lines, R2)
    │  ↳ wrapEmitterWithRecorder + H1_MAX_SAME_HARNESS_REVISES +
    │    BudgetExtensionContext + FEATURE_165 handoff pending-children gate
    ├── agent-chain.ts                        (1010 lines, R3)
    │  ↳ CodingToolBundle / buildCodingToolBundle /
    │    buildAgentToolsFromRegistry / RunnerAgentChain /
    │    buildRunnerAgentChain
    │  ↳ FEATURE_193 (v0.7.43) deleted buildRunnerScoutAgent + V1 chain
    │    agent declarations (chain.scout/.planner/.generator)
    ├── llm-adapter.ts                        (954 lines, R3)
    │  ↳ RunnerAdapterTokenState + agentNameToManagedRole +
    │    flattenNormalizedForEmitterInput + buildRunnerLlmAdapter
    │    (含 FEATURE_085 max_tokens L1-L5 escalation ladder +
    │     FEATURE_167 Evaluator terminal-verdict fallback retry hook)
    ├── payload-builder.ts                    (444 lines, R4)
    │  ↳ harnessToBudget (private) + buildManagedTaskPayload (主入口) +
    │    deriveQualityAssuranceMode + buildScoutDecisionRuntime +
    │    buildSkillMapRuntime
    └── checkpoint-flow.ts                    (350 lines, R4)
       ↳ handlePreRunCheckpoint + buildResumePreamble +
         StructuralResumeSeed + buildStructuralResumeSeed +
         writeCurrentCheckpoint
```

**Re-export 策略**：

`runner-driven.ts` 顶部添加 import + re-export 块：

```typescript
// FEATURE_193 (v0.7.43) note: `buildRunnerScoutAgent` was removed from
// this re-export block when V1 chain agents retired. The snapshot
// below shows the pre-F193 surface for historical context.
export {
  // R1 leaf modules
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
  maybeApplyP2bWriteTurnCap,
  // R3 agent-chain + llm-adapter
  buildRunnerAgentChain,
  buildRunnerScoutAgent,
  buildRunnerLlmAdapter,
};
export type {
  AmaRole,
  ObserverBridge,
  RolePromptContextFactory,
  RunnerChainPromptContext,
  VerdictRecorder,
  RunnerAgentChain,
  RunnerAdapterTokenState,
};
```

四个现存调用方（`task-engine.ts`、`runner-driven.test.ts`、`runner-driven-tool-wiring.test.ts`、`p2b-write-turn-cap.test.ts`）的 import path 零变更。R4 提取的 `buildManagedTaskPayload` 和 4 个 checkpoint helper **不**再导出——它们对外部没有需要（只服务于 runner-driven 内部主循环）；`buildStructuralResumeSeed` 通过 `__runnerDrivenTestables` 暴露给测试。

**依赖拓扑**（无循环）：

```
types.ts (R1)
   ↑
   ├── role-prompts.ts, role-exclude.ts, write-turn-cap.ts, status-derivation.ts (R1 leaves)
   ├── tool-wrappers.ts, dispatch-child.ts (R2 leaves)
   ├── observer-bridge.ts (R2)
   │     ↑
   │     └── verdict-recorder.ts (R2, 单向)
   ├── agent-chain.ts (R3) — 也依赖 R1 + R2 模块
   ├── llm-adapter.ts (R3) — 也依赖 compaction.ts
   ├── payload-builder.ts (R4) — 也依赖 workspace/artifacts/scorecard/role-prompts/budget
   └── checkpoint-flow.ts (R4) — 也依赖 checkpoint.ts + workspace
            ↑
runner-driven.ts (主循环 + 顶部 re-export)
```

`verdict-recorder.ts → observer-bridge.ts` 是有意的**单向**依赖（recorder import bridge 中的 `BUDGET_CAP_BY_HARNESS` / `BUDGET_EXTENSION_BY_HARNESS` / `applyScoutDecisionToPlanRunner`）；两者共享的类型上沉到 `types.ts` 打破循环。

### Reasoning

1. **职责粒度对齐**。每个文件单一职责，文件长度 100-1010 行（中位数 ~300 行），LLM 单次 review 不超过 6K tokens。Reviewer 一次能完整 audit 一个模块的所有 invariant。

2. **测试隔离改善**。后续可针对 agent-chain / llm-adapter / payload-builder 写独立单测（不依赖 Runner.run），降低 runner-driven.test.ts 198 个测试的 setup 耗时。R1-R4 阶段不写新测试以保持 byte-parity 审计简单；新测试是 R4 后的 follow-up。

3. **byte-parity 优先于美化**。提取过程**不重命名**、**不简化**、**不修 dead code**（包括 `baseCtx` 这个 pre-existing 未使用的 destructure），唯一允许的差异：
   - 函数加 `export` 关键字（必须，否则 `runner-driven.ts` 无法 import）
   - inline `import('./xxx').Type` → 顶部 `import type { Type } from './xxx'`（TypeScript 编译后字节相同）
   - `/[一-鿿]/` → `/[一-鿿]/`（同 RegExp 对象，[code-reviewer 报告确认](https://...) 行为完全一致）

4. **不引入新旧并行路径**。**没有** feature flag，**没有** 渐进 cutover，**没有** dual-path code。R1/R2/R3/R4 每个 commit 都是"提取 + 主文件删除 + 顶部 re-export"的原子替换。如需回退走 `git revert <commit>`。对齐用户记忆 [feedback_no_parallel_refactor_paths](https://...)：拒绝 dual-path 渐进 cutover。

5. **每个 commit 都触发独立 review**。R1/R2/R3/R4 落地后立即 spawn code-reviewer 子代理做 byte-parity 审计：
   - 函数体逐字符比对（用 `git show <prev>:runner-driven.ts` 取原文）
   - 常量值平价（magic numbers、prompt strings、retry caps）
   - 公共导出面（4 个调用方 import 仍可解析）
   - 依赖方向（无循环）
   - import hygiene（删除的 import 真的没人用）
   - CJK / regex notation（特别针对 R4）
   - `__runnerDrivenTestables` object identity 保留
   
   4 次审计结果：**全 APPROVE，0 个 CRITICAL/HIGH/MEDIUM 缺陷**。对齐用户记忆 [feedback_review_each_commit](https://...)：多步重构每个 commit 主动 review 三件事。

6. **测试每个 commit 后全跑**。R1/R2/R3/R4 commit 前都跑 198 个 runner-driven 测试 + 4314 个 coding/agent/repl 测试，全过。任何 commit 失败立即停推，不进入下一阶段。

### Consequences

**变化（结构性收益）**：

| 维度 | 现状 (v0.7.40) | 改后 (v0.7.41) |
|---|---|---|
| `runner-driven.ts` 行数 | 6406 | 1897（-70.4%）|
| 单文件最大 import block | 280+ symbols | ~80 symbols |
| 单次 review 该文件 token cost | ~22K | ~6.5K |
| 12 个职责的物理隔离 | 单文件 | 12 个聚焦模块 |
| 测试 setup 耗时（per-file mean） | ~600ms | ~300ms（待后续单测） |
| LLM-friendly 度（自然语言"找 X 在哪"） | 必须 grep | 文件名即职责 |

**不变（明确保留）**：

- AMA Runner-driven 路径所有行为：Scout → {Generator | Planner} → Evaluator chain；H0/H1/H2 harness；budget cap + extension dialog；handoff routing；compaction hook；mutation tracker；session continuity；idle-yield outer loop；FEATURE_167 evaluator terminal-verdict fallback；FEATURE_168 tool wiring 等。
- 4 个调用方 import path（`task-engine.ts` / 3 个 test 文件）。
- `__runnerDrivenTestables` 暴露面（`wrapEmitterWithRecorder` / `H1_MAX_SAME_HARNESS_REVISES` / `buildStructuralResumeSeed`）。
- 测试套（198 个 runner-driven + 4314 个全套）100% pass。
- ADR-021 (agent ↔ coding 边界) 不动；FEATURE_171 完全在 coding 层内拆分。
- 现有 prompt eval（FEATURE_092 dataset 等）不动；FEATURE_171 不触发 prompt 内容变化。

### 替代方案讨论

**A. 不拆，继续在单文件加 feature**：被否。
- v0.7.41 起码再加 3-5 个 feature touch 该文件，年内会破 7000 行。
- LLM compaction 风险逐渐升高，reviewer 已开始抱怨。

**B. 拆但保留 `runner-driven.ts` 作为门面，使用 barrel re-export `export * from './_internal/managed-task/*.js'`**：被否。
- barrel export 让 tree-shaking 失效，runner-driven 不是 npm 入口但下游 import 链会带额外 module load。
- 显式 re-export 4 个调用方实际用到的符号，刚好需要、可观测。

**C. 拆得更细（每个函数一个文件）**：被否。
- 12 个模块对应 12 个职责，粒度合理。再细会导致 cross-file context 增加，反而难 reason。
- LLM-friendly 的临界点：每个文件 100-1000 行（一屏到几屏），太细反而碎片化。

**D. 加 feature flag 让用户选 monolith vs split path**：被否。
- 违反 [feedback_no_parallel_refactor_paths](https://...)：拒绝 dual-path 渐进 cutover。
- 拆分是纯重构，零行为变更，没有"两条路径都要保留"的需求。
- 改完即生效，回退走 `git revert`。

**E. 同时清理 pre-existing dead code（如 `baseCtx` 未使用的 destructure）**：被否。
- byte-parity 审计的核心价值在于"提取 vs 原文" 1:1 对照；混入 dead code 清理会让 reviewer 误判 logic drift。
- dead code 清理作为 follow-up commit 单独处理。

### 与其他 ADR 的关系

| ADR | 关系 |
|---|---|
| ADR-021 (agent ↔ coding 边界) | 完全保留——FEATURE_171 在 coding 层内部重构，不动 agent ↔ coding 接口 |
| ADR-022 (npm 单包分发) | 不冲突——`_internal/managed-task/` 是 coding 包内部目录，对外仍是单一 `runner-driven.js` 导入面 |
| ADR-025 (auto-mode 信号化分类器) | 无关——auto-mode 不在 AMA Runner-driven 路径，guardrail 在 Runner.beforeTool 注入 |
| FEATURE_084 (Runner-driven AMA 替代 legacy state machine) | 本 ADR 是 FEATURE_084 的**模块化清理**，保留所有 v0.7.26 引入的行为 |
| FEATURE_165/166/167/168 (v0.7.41 同期 feature) | 这些 feature 落地后再拆，避免 commit interleave 复杂化 byte-parity 审计 |

### 落地节奏（FEATURE_171, v0.7.41）

| Commit | 内容 | Review 锚点 |
|---|---|---|
| R1 (`2fef1c31`) | 4 个 leaf module + 共享 `types.ts`（180 行 type-only）打破循环依赖 | byte-parity review |
| R2 (`f0be2d4e`) | tool-wrappers + dispatch-child + observer-bridge + verdict-recorder（中等耦合度，依赖 R1 types） | byte-parity review |
| R3 (`bfb2b818`) | agent-chain + llm-adapter（两个最大块，1964 行合计） | byte-parity review |
| R4 (`62dc1c58`) | payload-builder + checkpoint-flow（最后两块，含 CJK regex / 全角标点） | byte-parity + CJK review |
| R5 (本 commit) | ADR-026 Accepted + HLD.md 更新 + FEATURE_171 mark Done | docs review |

**纪律**：
- 每个 R-commit 后跑全套测试（198 runner-driven + 4314 总套），任一失败立即停。
- 每个 R-commit 后立即 spawn code-reviewer 子代理 byte-parity audit；reviewer 报 CRITICAL/HIGH 则 revert + 重做（实际 0 次触发）。
- 不引入新旧并行路径——R1-R4 是原子替换，不留 monolith fallback。
- 不修 pre-existing dead code——byte-parity 优先。

### 触发回退的条件

回退（`git revert R1..R4`）触发条件，任一成立即立项 patch：

1. **行为回归**：v0.7.41 release 后 4 周内出现 ≥1 例可复现的 AMA path 行为差异（用户报告或 issue），且追溯 root cause 到 FEATURE_171 任一 commit。
2. **测试回归**：某次 main branch CI 失败，bisect 定位到 R1-R4 任一 commit（实际不该发生，因为本地全跑过；保险条款）。
3. **build 回归**：在某 OS / Node 版本组合上 `tsc -b` 失败且仅在 v0.7.41 出现。

**保留兜底**：模块化拆分本身**不该**有行为差异——任何回退都意味着提取过程出 bug；优先做 minimal hotfix 而非整体 revert。

### Resolved Decisions (2026-05-16 self-review)

1. **`buildManagedTaskPayload` 和 4 个 checkpoint helper 不 re-export**。 它们对外部没有需要——只服务于 `runner-driven.ts` 内部主循环。`buildStructuralResumeSeed` 通过 `__runnerDrivenTestables` 暴露给测试已足够。如未来 SDK 有外部需求再加。
2. **不在拆分阶段加新测试**。 byte-parity 审计已覆盖；新测试是 R4 后的 follow-up（v0.7.42+），不阻塞本 ADR。
3. **保留 R4 `baseCtx` 未使用 destructure（pre-existing）**。 不在 byte-parity 审计期间混入 dead code 清理；作为 follow-up commit 单独处理。
4. **不引入 `_internal/managed-task/index.ts` barrel export**。 12 个模块通过 `runner-driven.ts` 顶部 import 各自接线，barrel 反而模糊依赖关系。

---

## ADR-027: REPL 数据层 streaming cache miss 修复 (FEATURE_172 Phase 1, v0.7.41)

**Status**: Partially Superseded by ADR-028 (2026-05-19).  
**已 ship 部分**:Phase 1 数据层 cache miss 修复(5 commits `19c6aff3` → `343a85ce`)— 保留为 nice-to-have,无功能回退。  
**已撤回部分**:Phase 2-5 计划 + D2.A/B/C selection 机制 port — 见 ADR-028 重新设计。

### 已 ship 部分

`packages/repl/src/ui/InkREPL.tsx` 的 `promptMainScreenRenderModel` 和 `transcriptMainScreenRenderModel` useMemo 把 streaming state(`currentResponse` / `thinkingContent` / `activeToolCalls`)挂进了 cache key,导致 `buildTranscriptRenderModel` 在每次 `StreamingContext.flush()`(80ms 间隔)都重跑;每次重跑内部调 `buildStaticTranscriptSections` 对所有 200 条 history 做 O(N) text-wrap(200 items 实测 28ms,800 items 实测 94ms)。

修复:`buildTranscriptRenderModel` 拆 `buildTranscriptStaticPortion` / `buildTranscriptDynamicPortion` / `composeTranscriptRenderModel` 三个 pure helper;`InkREPL` 静态 portion useMemo 只挂 `[items, vw, maxLines]`,streaming-state 变化不再 invalidate 静态缓存。`TranscriptRowRenderer` 加 `areTranscriptRowPropsEqual` field-level comparator 接进 `React.memo`。

实测(`benchmark/perf-baselines/baseline-26d47084.json`,Win11 / Node v24.13.1):

| Items | streaming-tick 数据层 p95 | streaming-tick-cached-static p95 |
|---|---|---|
| 200 | 29.16ms | 0.44ms |
| 800 | 94.18ms | 0.52ms |

**功能回归审计 PASS**:1402 + 17 repl tests 全过、8 个 golden snapshot byte-equal、22 hit-test/selection edge tests 全过。

### 撤回部分(2026-05-19 调研发现错误)

原 ADR-027(2026-05-18 drafting)把 SSH 2-3s/frame 卡顿的根因**整体**定位在数据层 cache miss + selection 机制 D2.C port,Phase 节奏 21 工作日 5 phase。

2026-05-19 深度调研(三个并行 Explore agent 全管线 trace + claudecode 完整对照)发现:

1. **数据层 cache miss 只是 ~3-5% 总开销** — 不是 SSH 2-3s 的主导因素
2. **D2.A/B/C 三选 D2.C 是关于 selection 机制 port** — 跟 SSH 渲染性能**无关**
3. **真正的 ~80% 总开销** 来自 KodaX `tui/substrate/ink/` 渲染底层缺失了 claudecode 的 7 项核心优化:`nodeCache` blit / Packed Int32Array Screen / `markDirty` propagation / `screen.damage` bounding box / `Output.charCache` 跨帧 / `StylePool.transition` 缓存 / 16ms throttle
4. **原 Phase 2-5 计划完全没覆盖**这些底层优化 — 即使全做完,SSH 仍会卡

错误根因:静态代码分析定位 root cause 时**没 trace 到 engine 层 `render()` 之后的屏幕应用/写屏阶段**(`applyCellFrame` / `cellLogUpdate.render` / `applyDiff` / `stdout.write`)。Bench 设计也是错的 — 只测 `buildTranscriptRenderModel` inner function；后续 `onRender` bench 也必须注意 `onRender` 在 `applyCellFrame` 之前触发，不能当作完整端到端 wall-time。

### 教训(写入 feedback memory)

- bench 必须测端到端 wall-time,只测一个 inner function 会高估修复效果
- claudecode 对标必须 trace 到底层数据结构 / 缓存层,看到"已 port cell-renderer" 不代表对齐
- ADR 跨多次调研时必须可迭代 — 不要让基于不全调研的决策"既成事实化"
- 复杂渲染管线诊断必须用多 agent 并行 + 互相对照 + 对比参考实现

参考:[[feedback_layer1_measurement_before_optimization]] / [[feedback_no_guessing_api_names]]

### 后续

- 数据层 cache miss 修复(Phase 1)**保留** — 是真实优化,无回退
- SSH 2-3s 卡顿的完整修复见 **ADR-028**(底层渲染 perf port,Phase A-E,13-20 工作日)
- `docs/features/v0.7.41.md` FEATURE_172 status 同步更新

---

## ADR-028: KodaX 渲染底层 — Port claudecode 的 7 项核心 perf 优化 (FEATURE_172 Phase A-E, v0.7.41+)

**Status**: Drafting (2026-05-19; pending user SSH 实测 + 工作日预算确认)

### 2026-06-04 校正：Windows Terminal transcript 卡顿根因

本 ADR 2026-05-19 版的方向仍然有价值（渲染层比数据层更关键），但有三处判断已经被代码复查推翻或收窄：

1. **`onRender` 不是完整渲染管线终点。** 当前 `engine.js` 在 `render(rootNode, ...)` 之后立刻调用 `options.onRender?.({ renderTime })`，随后才进入 `applyCellFrame(frame)` / `cellLogUpdate.render` / `applyDiff` / `stdout.write`。因此 `renderTime` 和基于 `onRender` 时间戳的 wall-time 不能证明终端写屏不慢；它们漏掉了最可疑的同步写屏阶段。
2. **`benchmark/perf/repl-render-engine-e2e.bench.ts` 的“端到端”说明不准确。** 该 bench 的 `wallTime = rerender -> onRender callback`，不覆盖 `applyCellFrame` 和真实 `stdout.write` 完成时间。`bytes` 统计仍可用于观察写入量，但不能把 `wallTime - rendererTime` 解释为 apply/write 成本。
3. **assistant 正式输出和 thinking 历史行没有明显不同的 React 渲染分支。** 二者在 transcript 中都进入 `TranscriptRowRenderer`，差异主要是 color / italic / header。若 Windows Terminal 中“大段中文正式输出”比“大段英文 thinking”更卡，根因应定位为：Windows/degraded_vt 仍启用 virtual transcript + streaming renderer，滚动/流式每帧重建并写虚拟屏幕；正式输出的 CJK 宽字符在 Windows Terminal/ConPTY 真实写屏阶段放大阻塞。不是 `assistant` item 类型本身更慢。

修正后的根因表述：

> 在 Windows Terminal / degraded_vt 上，KodaX 仍把 transcript 和 streaming preview 放进 virtual fullscreen/managed viewport。历史 item 虽然不变，但滚动和流式时当前可见窗口仍会走 `renderNodeToOutput -> Output.get()/getGrid -> outputToScreen -> cell diff -> stdout.write`。大段中文正式输出触发宽字符与真实终端渲染成本，阻塞 Node 主线程，spinner 因而卡顿。Thinking 英文走同一 KodaX 代码路径，但真实终端写屏成本低，所以不明显卡。

后续验证必须补真实 TTY 分段 trace：`render()`、`output.get()`、`outputToScreen()`、`applyCellFrame/cellLogUpdate.render`、`applyDiff/stdout.write` 分开计时，并同时记录 viewport、visible rows、CJK/wide-char 比例、bytes。不要再只用 `onRender.renderTime` 判断是否修复。

### 背景

ADR-027 把 SSH `kodax -c` 长 session 2-3s/frame 卡顿的根因定位在数据层 `buildTranscriptRenderModel` cache miss,Phase 1 修复后实测数据层 200 items 从 28ms 降到 0.5ms,但**未端到端验证 SSH 体验**。

2026-05-19 三个并行 Explore agent 全管线 trace + claudecode 完整对照后发现:数据层只占总开销 ~3-5%,真正瓶颈在 KodaX `tui/substrate/ink/` 渲染底层。

### 每帧 cost 分解(200 history items / SSH)

| # | 阶段 | KodaX 当前 cost | claudecode cost | 占比 | KodaX 缺失的优化 |
|---|---|---|---|---|---|
| ① | `buildTranscriptRenderModel` text-wrap | ~0.5ms(P1 后) | N/A | ~0% | (已修复) |
| ② | React reconciliation | ~30-50ms | ~5-10ms | ~5% | `markDirty` propagation + per-row memo(P1.3 部分修) |
| ③ | Yoga calculateLayout | ~20ms | ~5ms | ~3% | Yoga 内部 incremental(已有) |
| ④ | `Output.getGrid` 每帧重建 | ~50-100ms | ~5ms | ~12% | **`Output.charCache` 跨帧** |
| ⑤ | `setCellAt` `cells.slice()` per cell | ~80ms(4000 cells × N slice) | ~0.5ms | ~12% | **Packed `Int32Array` Screen + `TypedArray.set` blit** |
| ⑥ | `diffEach` 全屏 walk | ~16-65ms | ~1ms | ~10% | **`screen.damage` bounding box** |
| ⑦ | `renderNodeToOutput` 全树递归 | O(N) per frame | O(dirty) | **~55%** | **`nodeCache` blit short-circuit** |
| ⑧ | SSH round-trip / ConPTY | ~100-300ms(同) | ~100-300ms(同) | — | (不可在 KodaX 改) |
| **总 wall-time** | | **~400-800ms/frame**(80ms tick 跑不动 → 堆积 → 2-3s) | **~115-330ms/frame**(80ms tick 跑得动) | — | — |

(KodaX cost 是基于 cell-screen.ts:103 `setCellAt`、output.js:80 `getGrid`、render-node-to-output.js:71 `renderNodeToOutput` 三个 agent 的代码 trace + claudecode 对照推断。Phase A 开工前必须先端到端 wall-time bench 校准实测值。)

### 决策 — 按优先级 port claudecode 7 项优化

**Critical(必做,决定 SSH 流畅与否)**:

- **C1. `nodeCache` blit short-circuit**(最大杠杆 ~55%)  
  `WeakMap<DOMElement, ScreenRect>` 缓存每个 React node 的 (x, y, w, h)。clean subtree(`!node.dirty` && layout 未变 && `prevScreen` 在)调 `output.blit(prevScreen, x, y, w, h)` `TypedArray.set` 拷贝 + return,**不进 children 递归**。  
  参考:`c:/Works/claudecode/src/ink/node-cache.ts`(55 行)+ `src/ink/render-node-to-output.ts:454-481` blit 短路逻辑

- **C2. Packed `Int32Array` Screen**(~12% + C1 的 enabler)  
  替换 `Cell[]` 数组 + `cells.slice()` per cell(O(N²))为 `Int32Array(width*height*2)`(charId + style+hyperlink+width 打包)。blit 用 `TypedArray.set`,diff 用整数比较。**C1 的 `output.blit` 需要 TypedArray.set,所以 C2 是 C1 的前置。**  
  参考:`c:/Works/claudecode/src/ink/screen.ts`

- **C3. `markDirty` propagation + renderer dirty-only recursion**(~5%,C1 的 enabler)  
  `commitTextUpdate` 时 `markDirty(textNode)` 走 ancestors;`renderNodeToOutput` 检查 `node.dirty`,clean subtree 走 C1 blit 短路。  
  参考:`c:/Works/claudecode/src/ink/reconciler.ts` commitTextUpdate

- **C4. `screen.damage` bounding box**(~10%)  
  `Output` 记录本帧实际写入的 cell 范围;`diffEach` 只扫这个矩形,不走 max(prev.h, next.h) 全屏。  
  参考:`c:/Works/claudecode/src/ink/output.ts` damage tracking

**Important(强烈建议)**:

- **I1. `Output.charCache` 跨帧持久化**(~12%,和 C4 配合放大)  
  Line 文本的 tokenize + grapheme clustering 结果跨帧缓存,clean line 不重 tokenize。  
  参考:`c:/Works/claudecode/src/ink/output.ts` charCache

- **I2. `StylePool.transition` 缓存**(~2-5%)  
  ANSI escape 转换字符串缓存(`Map<fromId * 0x100000 + toId, string>`),零分配 after warmup。  
  参考:`c:/Works/claudecode/src/ink/screen.ts:153-162`

**Nice-to-have(锦上添花)**:

- **N1. `FRAME_INTERVAL_MS` 33→16**(30 FPS → 62.5 FPS)— 一行常量改动,需 Phase B 完成后才有意义
- **N2. `renderScrolledChildren` viewport culling 强化** — render-time 视口外 children 完全跳过

### 不做(已评估否决)

- **完整 port claudecode ink fork** — KodaX 当前已 fork ~25k 行 tui/,完整 rewrite scope 过大,违反"add code cautiously"
- **D2.A / D2.B / D2.C selection 机制 port**(ADR-027 撤回内容)— 跟 SSH 卡顿**无关**,纯 UX parity issue,可按需独立排期(非本 ADR scope)
- **只做 C1 不做 C2** — `output.blit` 需要 `TypedArray.set`,Cell 对象数组无法直接用,杠杆失效

### Phase 节奏

每 Phase 一个 atomic commit + golden byte-equal + end-to-end wall-time bench 三次取中位(perf 噪声大):

| Phase | 内容 | 工作日估算 | 风险 | 前置 |
|---|---|---|---|---|
| **Phase A** | C2 Packed Int32Array Screen — 重写 `tui/substrate/ink/cell-screen.ts` + 所有 consumer + golden bit-equal tests | 3-5 | **高** — substrate 数据结构,影响面广 | (无)|
| **Phase B** | C1 + C3 nodeCache blit + markDirty propagation + render-node-to-output dirty-only walk(最大性能杠杆) | 4-6 | **高** — 渲染核心改动 | Phase A |
| **Phase C** | C4 `screen.damage` bounding box | 2-3 | 中 | Phase A |
| **Phase D** | I1 + I2 Output.charCache + StylePool.transition cache | 2-3 | 低 | Phase A |
| **Phase E** | N1 + N2 throttle 调整 + viewport culling 强化 | 1-2 | 低 | Phase B |
| **Soak** | 24h dogfood + 端到端 SSH wall-time bench 三次取中位 | 1 | — | A-E 全过 |
| **总计** | | **13-20 工作日(3-4 周)** | — | — |

(参考 ADR-027 错过的工作量预估 21 工作日:那 21 工作日是错配 — Phase 1-2 解 3-5% cost、Phase 3-5 是 selection 机制 port 跟 perf 无关。本 ADR 的 13-20 工作日**全部覆盖 perf 杠杆**。)

### 保障(Layer 0/1/2/5,参考 ADR-027 验证过的结构)

- **Layer 0 — Baseline**:补 **真实端到端 wall-time bench / trace**。不能把 `engine.onRender` 当作全链路终点；必须分段测 `render()`、`applyCellFrame`、`applyDiff/stdout.write`，并记录 stdout.write 次数、bytes、viewport、visible rows、wide-char 比例。当前 `benchmark/perf/repl-render-perf.bench.ts` 只测 inner function,`benchmark/perf/repl-render-engine-e2e.bench.ts` 又停在 `onRender` 时间戳，二者都不足以作为修复 gate。
- **Layer 1 — TDD per phase**:每 phase RED → GREEN。golden byte-equal 是硬底线。
- **Layer 2 — Phase gates**:每 phase 完成必须(a) Layer 0 golden 全 byte-equal PASS;(b) end-to-end wall-time bench 不退化 >5% vs 上 phase 末;(c) phase-specific 测试 PASS。
- **Layer 5 — 24h soak + SSH 实测**:用户 SSH 长 session 实测体验改善。

### 端到端 Bench Contract(Phase A 启动前)

**Bench harness shipped** 2026-05-19:`benchmark/perf/repl-render-engine-e2e.bench.ts` — 通过 KodaX 真实 `render()` 入口 + mock stdout(timestamped writes)+ `onRender` callback 同步。**2026-06-04 校正**：该 bench 的 `wallTime` 实际是 `rerender → onRender callback`，覆盖 React reconcile / Yoga / renderNodeToOutput / outputToScreen，但 `onRender` 在 `applyCellFrame` 之前触发；因此它不覆盖 `cellLogUpdate.render` / `applyDiff` / 真实 `stdout.write` 完成时间。run via `npm run bench:perf:e2e`，但不要把结果当完整端到端写屏耗时。

**Baseline 实测**(`benchmark/perf-baselines/baseline-e2e-<sha>.json`,Win11 / Node v24.13.1 / x64,viewport 120×40,30 ticks × 45ms gap per tier):

**mainscreen mode**(Windows SSH 路径 / `KODAX_FULLSCREEN=0` / `<Static>` 启用):

| items | wallTime p50 | wallTime p95 | rendererTime p95 | bytes p95 / tick |
|---|---|---|---|---|
| 50 | 7.51ms | 9.03ms | 2.62ms | 0B |
| 100 | 13.31ms | 15.29ms | 4.28ms | 0B |
| 200 | 21.83ms | **25.39ms** | 4.70ms | 0B |
| 400 | 39.83ms | 47.04ms | 5.32ms | 0B |
| 800 | 75.61ms | **84.35ms** | 6.60ms | 0B |

**windowed mode**(Linux SSH 路径 / virtual fullscreen / `<Static>` bypass):

| items | wallTime p50 | wallTime p95 | rendererTime p95 | bytes p95 / tick |
|---|---|---|---|---|
| 50 | 44.44ms | 45.79ms | 6.09ms | 10B |
| 100 | 47.74ms | 49.72ms | 5.64ms | 10B |
| 200 | 56.75ms | **90.17ms** | 6.51ms | 10B |
| 400 | 41.49ms | 45.67ms | 6.89ms | 0B |
| 800 | 78.59ms | 84.77ms | 8.14ms | 0B |

**关键发现**:

1. **bytes per tick ≈ 0-10B 只能说明 mock bench 场景下 diff 输出少**。它不能证明真实 Windows Terminal / ConPTY 写屏不慢，也不能覆盖 CJK 宽字符 glyph shaping / terminal repaint 成本。
2. **rendererTime(engine 内部 Yoga + renderNodeToOutput + outputToScreen)只有 5-8ms** — 这只覆盖 `onRender` 之前的阶段；不能用它排除 `applyCellFrame` / `applyDiff` / `stdout.write`。
3. **wall-time 跟 rendererTime 的差(20-80ms)不能再归因到 `applyCellFrame`**。该 bench 的 wall-time 时间戳停在 `onRender` callback；真正的屏幕应用/写屏阶段未被纳入 wall-time。需要补真实 TTY 分段 trace 才能定位。
4. **windowed mode at 200 items: 90ms p95** — **已经超过 80ms flush 窗口**,会开始 backlog
5. **mainscreen at 800 items: 84ms p95** — 同上,刚好饱和
6. **windowed mode 在小 items(50-100)反而比 mainscreen 慢 5×** — `<Static>` bypass 后所有 items 进主 React tree,固定 overhead 大

### Phase 路线修正(基于实测数据)

旧 bench 显示 **Phase 1 后 200 items mainscreen `rerender -> onRender` = 25ms p95**，远小于 ADR-028 草稿假设的"400-800ms/frame"。2026-06-04 校正后，这个数字只能说明 `onRender` 前半段较快，不能代表完整写屏 wall-time。两种解释调整为:

(a) **Phase 1 改善了数据层和 onRender 前半段** — 但不能证明真实终端写屏已可接受。
(b) **bench 没复现真实症状** — 可能与:未计入 apply/write / mock stdout 不模拟 Windows Terminal CJK 宽字符渲染 / viewport rows / 实际 message 复杂度 / 多 commit 在 throttle window 内 coalesce / 真实 streaming 频率 ≠ 45ms 间隔 / SSH round-trip 叠加 等因素相关。

**修正后的 Phase 启动门槛**:

- 用户 SSH 实测 Phase 1 后体验 → 若 200 items 流畅,Phase A-E 转 deferred 到 800+ items 卡顿场景
- 若仍卡 → 用 bench 复现并定位(可能需要扩 bench 覆盖更复杂 fixture)
- 旧 onRender bench 目标仅保留为前半段渲染参考；真正 gate 需等真实端到端 trace 补齐后重设:

| Items | 当前 mainscreen `rerender -> onRender` p95(P1 后) | Phase B 参考目标 | Phase D 参考目标 |
|---|---|---|---|
| 200 | 25.39ms | ≤10ms | ≤5ms |
| 400 | 47.04ms | ≤15ms | ≤8ms |
| 800 | 84.35ms | ≤25ms | ≤10ms |

| Items | 当前 windowed `rerender -> onRender` p95(P1 后) | Phase B 参考目标 | Phase D 参考目标 |
|---|---|---|---|
| 200 | 90.17ms | ≤15ms | ≤8ms |
| 800 | 84.77ms | ≤30ms | ≤12ms |

### Replace ADR-027 D2.C — selection 机制独立 ADR

ADR-027 的 D2.C(port claudecode `selection.ts` + `nodeCache + hit-test`)是**两个独立 concern 错误绑定**:
- `nodeCache` 是渲染 perf 优化(本 ADR C1)
- `selection.ts` 是 mouse selection UX 对齐(跟 perf 无关)

selection 机制 port 如果未来需要做,**独立立 ADR**(暂命名 ADR-XXX),不再绑定 perf scope。

### Rollback

每 Phase atomic commit pushed to origin。`git revert <commit>` 回上 phase 末。**无 dual-path runtime flag**([[feedback_no_parallel_refactor_paths]])。

Phase A/B 之间不能跳 — C2 是 C1 的前置(`output.blit` 需要 `TypedArray.set`)。
Phase C/D 互相独立 — 可并行(不同文件)。
Phase E 是 nice-to-have — 任何时机都可独立做。

如 Layer 5 实测 Phase A+B 后已经流畅,Phase C-E 可降级 future work,本 ADR 转 "Accepted, deferred"。

### 替代方案 — 如 Phase 1 实测已够流畅

用户 SSH 实测 Phase 1 修复后,如已从 2-3s/frame 降到 ≤500ms/frame 且主观可接受:
- Phase A-E **不必做**
- 本 ADR 转 "Accepted, deferred to v0.8.x"
- KodaX 在 200-500 items 区间继续运行;1000+ items 时再启动 Phase A-E

(实测路径:用户 SSH 200/400/800 items session 主观判断 + 可选 `time` 命令 + 可选 KodaX 内部 timing log)

### 与其他 ADR 的关系

| ADR | 关系 |
|---|---|
| ADR-027 | 本 ADR supersedes 027 关于 SSH lag 根因诊断 + Phase 2-5 计划。027 Phase 1 数据层修复保留 |
| FEATURE_057 Track F (cell-level renderer) | C2 Packed Int32Array Screen 是 Track F 自然延伸 — Track F port 了 `log-update.ts`,本 ADR port 配套的 `screen.ts` + `output.ts` + `render-node-to-output.ts` |
| ADR-021 (agent ↔ coding) | 不冲突 — 本 ADR 完全在 `@kodax-ai/repl tui/` 内部 |
| ADR-026 (`runner-driven.ts` 拆分) | 类似的"多 commit atomic per phase + byte-parity gate"节奏先例 |

### References

- 三 agent 调研结论 chat 2026-05-19(KodaX pipeline trace / SSH path / claudecode pipeline)
- claudecode 关键文件:
  - `c:/Works/claudecode/src/ink/node-cache.ts`(55 行,C1 参考)
  - `c:/Works/claudecode/src/ink/screen.ts`(Packed Int32Array Screen,C2 参考)
  - `c:/Works/claudecode/src/ink/reconciler.ts` commitTextUpdate(C3 参考)
  - `c:/Works/claudecode/src/ink/render-node-to-output.ts:454-481`(C1 blit short-circuit 实现)
  - `c:/Works/claudecode/src/ink/output.ts`(I1 charCache 参考)
- KodaX 当前实现:`packages/repl/src/tui/substrate/ink/{cell-renderer,cell-screen,output-to-screen,viewport-state}.ts` + `tui/core/internals/{renderer,render-node-to-output,output,reconciler,dom}.js` + `tui/core/engine.js`

---

## ADR-029: AMA Compaction Trigger Parity — Top-of-Loop (FEATURE_179, v0.7.42)

**Status**: Accepted 2026-05-20

### 背景

kimi-loop 调查（FEATURE_177/178 上下文）暴露了一个 AMA path 独有的 compaction trigger 时序问题：

- **SA path**（substrate runner 直接执行 Tool loop）一直在**每次 iteration 顶部、LLM call 之前** check `needsCompaction` → 触发压缩。
- **AMA path**（agent-runtime + managed-task + Runner.run wrapper）此前在**每次 `tool_result` append 之后** check —— 即在 LLM 已经返回结果、tool 已经跑完之后才检查。

后果：
1. **Text-only end-of-turn** 不触发 compaction。模型一回合只输出 text、不发 tool call → runner 没有 tool_result append → compaction check 不发生 → 下次 LLM call 仍然带着 over-window 的 history → HTTP 400 / context overflow。
2. **Idle-yield 长 wait**：模型 emit `await_child_task` / `task_stop` 后进入 idle-yield 等待 child message。等待期不跑 tool → 不 check compaction → 等待结束恢复时 context 可能已经远超 trigger。

实测某 zhipu/glm51 长 session 在 text-only 总结回合后 history 涨到 +60K tokens 才在下个 tool 调用时被发现并 emergency-compact，但那次 LLM call 已经先 400 了。

### 决策

把 `compactionHook` 从 "after each tool_result append" 上移到 **"top of every tool-loop iteration, before LLM call"**。具体改动在 `packages/agent/src/primitives/runner.ts`：原本在 line ~783 post-tool-result 触发的 hook 移到 line 587 iteration 入口。

这让 AMA path 的触发节拍 == SA path 的触发节拍：

- **Text-only 回合**：下一轮 iteration 顶部 check → 提前压缩
- **Idle-yield 恢复**：恢复后第一次进入 iteration 顶部 check → 立刻压缩
- **正常 tool-loop**：每轮 iteration 开始都 check，比之前"等到 tool 跑完才 check"提前一步

### 替代方案考量 — 为什么不是 dual-trigger

考虑过保留旧的 post-tool-result trigger 同时加一个 top-of-loop trigger（"两个触发点都触发"）。否决理由：

- 违反 [memory: feedback_no_parallel_refactor_paths](../../memory/feedback_no_parallel_refactor_paths.md)，长期维护两个 trigger 时机会让 compaction 顺序问题难诊断。
- 真正的语义是 "top-of-loop"，post-tool-result trigger 只是历史包袱（pre-managed-task agent.ts 那时 SA/AMA 还没分家，trigger 时机由 agent.ts 直接负责）。
- 两套并存意味着 idempotent check 需要承担 double-execution。`needsCompaction` 不便宜（要 `estimateTokens(messages)`）。

### 实施

`runner.ts` 一处搬迁 + 1 处 doc-comment 重写。完整测试：

- 7 个新 regression tests in `runner-compaction-hook.test.ts`（cover text-only / idle / mixed / hook-throw 等场景）
- 145 个 agent 全测 PASS（含 SA + AMA + handoff + structural-resume）
- `coding/src/task-engine/runner-driven.ts` 上游 wire 只改了一行 comment（hook 接同样的 callback，时机变了不影响 callback 内容）

### 与 ADR-020 (Unified Agent Execution Substrate) 的关系

ADR-020 把 SA/AMA 合并到统一 substrate Runner。本 ADR 是 SA/AMA semantic parity 的最后一块拼图：**trigger 时机也对齐**，不只是 tool dispatch / observer 接口对齐。从此 SA 和 AMA 的 compaction 触发是 bit-for-bit 同步的（同一个 `Runner.run` loop 入口、同一个 hook 调用点）。

### References

- commit `02836a72`
- `packages/agent/src/primitives/runner.ts:587` (new hook location)
- `packages/agent/src/primitives/runner-compaction-hook.test.ts` (regression suite)
- v0.7.42 上下文 §FEATURE_179
- 配套 forensic finding：B = repeated RI（→F180）、C.2 = empty summary（→F181）、C.1 = fast-path stuck on fallback（→F182）。F179 是触发时序的根因修复，F180-182 是压缩内容质量的修复，两组合在一起 cover 大部分 kimi-loop-class 的 compaction 病例

---

## ADR-030: claudecode-Shape Main Agent + Sidecar Verifier Substrate (FEATURE_184, v0.7.45)

**Status**: Accepted 2026-05-21 — Phases A/B/C.1/C.2/C.3/D.1/D.2/D.4 all landed; Phase D.3 (UI affordance) deferred. Layer 2 SHIP gate (a)+(b)+(c)+(d) met on second prompt iteration (treatment 100/100 cells across 5 alias × 4 case × 5 run; LLM-judge audit 0% disagreement). Full ship details: [v0.7.45.md §Phase D.4 SHIP outcome](features/v0.7.45.md#phase-d4-ship-outcome-2026-05-21).

### 背景

当前 AMA H2 harness 把 verification 实现为一个 **role**：Worker → `emit_handoff` → Evaluator → `emit_verdict` → 状态机回归。Evaluator 与 Worker 同 Runner session、继承完整 message history、按 H1/H2 模式做 spot-check 或 full verification，verdict ∈ {accept, revise, blocked} 驱动下游 `recorder.verdict`、`deriveFinalStatus`、TodoStore auto-handle、UI label、session-restore filter。

这套设计在 2026-05 暴露三个结构性问题：

1. **zhipu/glm51 intent-vs-action floor**（[memory: project_zhipu_send_message_floor](../../memory/project_zhipu_send_message_floor.md) / [project_feature_167](../../memory/project_feature_167_evaluator_verdict_fallback.md)）— Evaluator 继承 assignment 的 model，因此 assignment=zhipu 时 Evaluator=zhipu。实测 first-turn `emit_verdict` 0/5、retry 0/5。FEATURE_167 B2 合成 `accept` 兜底等同 **整个 verification gate 对 zhipu 静默失效**。换 prompt 不可调（[`feedback_model_structural_floor_not_prompt_tunable`](../../memory/feedback_model_structural_floor_not_prompt_tunable.md) 验过 3 wordings × 5 runs = 0 PASS）。
2. **Role-as-handoff 脚手架脆弱**：[`role-prompt.ts:843-927`](../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts) Evaluator case 拼装 ~15 个 section，其中 contract / metadata / handoff timing / CHILD-TASK WAIT DISCIPLINE 等接近一半都是"给 role-as-handoff-target 准备的脚手架"。v0.7.38 的 child-task wait discipline hotfix 就是时序契约脆弱的化石证据。
3. **与 claudecode 不对齐**：claudecode 没有 Evaluator role；其 `queryLoop`（[query.ts:241](file:///c:/Works/claudecode/src/query.ts)）是单循环，模型不再 emit `tool_use` → 终止。verification 通过 **`Stop hooks` + `blockingErrors`**（[stopHooks.ts:269-280, query.ts:1282-1305](file:///c:/Works/claudecode/src/query/stopHooks.ts)）实现：脚本判 "没做完" 返回 `blockingErrors` → harness 合成 user message → loop continue。`preventContinuation` 是 halt-and-surface 形态。**没有任何 role 状态机**。

### 决策

把 KodaX 主 Agent 改造为 claudecode-shape 单循环，同时在 agent 层提供 **Stop Hook primitive**（`RunOptions.stopHook`），让 Sidecar Verifier 作为 Stop hook 的 LLM-driven 实现替换 Evaluator-as-role。

**核心架构变化**：

```
当前（v0.7.42）：
  User → Worker(role) → emit_handoff → Evaluator(role, same session) → emit_verdict
         ↑__________________ revise 回路 ________________________________|

v0.7.45 后：
  User → Main Agent(single queryLoop) → 模型自然停（无 tool_use 或 signal:COMPLETE）→
         agent-layer stopHook → Sidecar Verifier(独立 sideQuery LLM call, 独立 context) →
            accept → 交付 user
            revise → harness 合成 user msg + continue loop (≤ 2 次 reanimate)
            blocked → halt + surface 给 user
```

**关键设计选择**：

- **Stop hook 在 `@kodax-ai/agent` 层**：与 `compactionHook` / `beforeNextTurn` / `onAgentSwitched` 并列，进 `RunOptions`。理由：`genericRun` (claudecode `queryLoop` 等价物) 已经在 agent 层 [`runner.ts`](../packages/agent/src/primitives/runner.ts)；FEATURE_159 MessageQueue 立下 "SDK-grade observable substrate" 先例；ADR-021 明文 "agent framework should be independently consumable"；FEATURE_121 layer-independence 测试保证不漏到 coding 层。
- **Sidecar Verifier 在 `@kodax-ai/coding` 层**：concrete LLM judging 是 coding-specific（要看 file edits、tool_use 摘要、scout artifact），不该 generalize 到 agent 层。
- **Extension API 桥接**：[`ExtensionHookMap`](../packages/coding/src/extensions/types.ts) 新增 `turn:complete` hook，返回值 `void | string | {abort, reason}` 三态对应 accept / blockingErrors / preventContinuation。让用户写的 extension 也能消费同一接口。
- **Reanimate 预算**：硬 cap 2 次（同 [`feedback_eval_pilot_before_scale`](../../memory/feedback_eval_pilot_before_scale.md) 风格的保守预算）。耗尽 → halt + surface 给 user 让用户决定继续提示还是修改需求。
- **Sidecar context 装配**：当轮全部 user query（完整）+ rolling buffer（last N 条 message） + key artifact（file edit path+diff hint、tool_use 名称序列、scout/handoff metadata）。**不**全量 history 重放（成本不可控）。
- **Sidecar model 与 main agent 解耦**：Sidecar Verifier 可独立选 model family（默认 strong family），绕开 zhipu intent-vs-action floor。

### 替代方案考量

#### A. 保留 Evaluator-as-role，仅修 B2 兜底从 accept 改 revise

**否决**：能修 "静默假阳" 病征但不解 zhipu structural floor 根因 — Evaluator-as-role 仍然要 emit_verdict，zhipu 仍然 0/5，B2 改 revise 后变成"永远 revise 不收敛"。是症状治疗而非根治。

#### B. 把 Evaluator 改成 SDK 上层调用，main agent 不变

**否决**：意味着 KodaX 维护两套 verification 形态（CLI 用 role-handoff、SDK 用 Stop hook 风格），违反 [`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md)。

#### C. 通用 "SidecarRegistry" 模块吃所有 sidecar（compaction / stall / auto-mode / verifier / btw）

**否决**：[调查](../../memory/) 显示三个真 LLM sidecar（compaction / F178 stall / auto-mode classifier）在 4 个维度（trigger 时机 / output 形态 / 延迟契约 / context 装配）上**全不重合**：

| | 触发 | 输出 | 延迟 | 上下文 |
|---|---|---|---|---|
| Compaction | between-turns / token 阈值 | replace messages | fully blocking | 全 transcript |
| Stall (F178) | post-tool / L1 信号 | nudge string | fire-and-forget 5s | 16-msg window |
| Auto-mode | pre-tool / 每次工具调用 | verdict allow/block/escalate | speculative 500ms | 极简投影 |
| Verifier (本 ADR) | turn-end / signal:COMPLETE | accept/revise/blocked | speculative 但宽容 | 当轮 query + buffer + artifact |

这是 eval 验过的 load-bearing design choices，不是巧合。强行抽 `SidecarModule` = swiss-army 参数 surface 81 种组合无简化收益，违反 CLAUDE.md "abstract after 3+ uses"（这恰是反面教材 — 3 个用例证明**不能**抽象）。

**真正的共享底层已经存在**：[`sideQuery`](../packages/llm/src/side-query.ts) 提供独立 cost-bucket / timeout / abort propagation / provider isolation。Verifier 直接用 `sideQuery` + Stop hook 这两个共享 primitive，不再多造 module。

#### D. Dual-path：保留 Evaluator-as-role 同时加 Sidecar Verifier

**否决**：违反 [`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md)。Recorder.verdict 同时有两个 source 会让 deriveFinalStatus 二义性、TodoStore 双触发、UI label 模糊。

#### E. Verifier verdict-outcome 落 JSONL log（受 MetaCogAgent 论文 5b 启发）

**否决**：[MetaCogAgent](https://arxiv.org/pdf/2605.17292) 论文 Section IV-B 建议把 verifier verdict + 最终 task outcome 配对落盘，方便后续算 verifier 准确率。在 KodaX 上这是不必要的重复：

1. **session-lineage 已经记录**：`packages/session-lineage/` 把每个 session 的 verdict slot + final outcome 落到磁盘 — 想算 verifier 准确率从 session-lineage 拉数据就够，不需要额外 JSONL stream
2. **production user 不会自己分析**：KodaX 是单用户 CLI 不是 SaaS dashboard；用户不会 grep 自己的 JSONL 算 verifier accuracy
3. **Layer 2 eval raw dump 已覆盖**：`os.tmpdir()/kodax-eval-dumps/` 落盘所有 eval call 的 raw output，分析需要时去那里找
4. **违反 minimalist 原则**：加一个 runtime logging pipeline 不解决任何当前 pain，是"为假设需求设计"

#### F. Verifier 输出 0-100 confidence-in-verdict score（受 MetaCogAgent 论文 5c 启发）

**否决**：MetaCogAgent Section III-B 让 agent 自评 0-100 confidence，配 historical capability profile 算 hybrid score。把这套搬到 KodaX sidecar verifier 上有四个问题：

1. **三态 verdict 已经分级**：`accept`/`revise`/`blocked` 本身就是粗粒度 confidence ladder（高/中/低），再叠加 0-100 是 over-engineer
2. **verbalized confidence 已知失校**：MetaCogAgent 论文自己证明（Section III-B / Ablation Table IV）verbalized confidence 单独使用比 hybrid 弱 4.3pp，且 ECE 在 hard task 上飙到 0.132。KodaX 不打算（也不该）维护 capability profile（违反 minimalist），所以 confidence 只会是 raw verbalized，已知不可靠
3. **reanimate budget 已经兜底"不确定"case**：sidecar fail-open accept + cap=2 reanimate budget 已经覆盖"我也不太确定"的场景 — 模型下一轮会再判一次。confidence 字段在这套机制里没有放置之处
4. **引入伪精度风险**：用户看到 "confidence=78" 会过度解读，但实际 78 vs 82 没有可解释的差异

**搁置**：5b/5c 不进 FEATURE_184 后续 follow-up，不进 v0.7.46+ roadmap。MetaCogAgent 论文的核心架构（pre-execution routing）跟 KodaX post-execution verification 是不同问题，论文里间接支持"独立验证比 self-judge 强"的发现不需要靠 5b/5c 形态承载 — Stop-hook + cross-family model override 已经覆盖。

### 实施分相

**FEATURE_184 phased commits**（参照 FEATURE_178 4-commit 模式）：

| Phase | Scope | LoC 估算 | 阻塞下游 |
|---|---|---|---|
| **A** | `@kodax-ai/agent` `RunOptions.stopHook` primitive + `genericRun` 入口调用 + 7 个 regression test | ~80 | Phase B/C |
| **B** | `@kodax-ai/coding` `ExtensionHookMap.turn:complete` bridge + CAP contract test（CAP-021）| ~50 | Phase C |
| **C** | Main Agent shape migration：删除 Worker→Evaluator handoff state machine（`EVALUATOR_AGENT_NAME` 注册 / role-prompt evaluator case / FEATURE_165 handoff gate / FEATURE_166 label flip / FEATURE_167 B0/B1/B2 fallback）+ Stop hook 在位但 verifier 未注册（"无验证主 Agent"中间态可独立 ship） | ~400 删 + ~50 改 | — |
| **D** | Sidecar Verifier 作为 Stop hook 的 LLM consumer + 接 `recorder.verdict` 替代下游 + `<verifier-status>` UI affordance | ~200 + prompt eval | — |

Phase A 独立可 ship（claudecode-style infra in agent 层，零行为变化）。Phase B 独立可 ship（extension surface 增量）。Phase C 是大重构核心，**ship 时无 verification gate**，等价于 [`feedback_refactor_parity_baseline`](../../memory/feedback_refactor_parity_baseline.md) 的"重构平价是质量底线" — Phase C 不能 ship 到 Phase D ready 之前。**Phase C + D 必须同 release 落地**，但可分多 commit/push 独立 review。

### 与既有 ADR/FEATURE 的关系

- **ADR-006**（H2 = Planner → Generator ↔ Evaluator）：被本 ADR superseded for AMA H2 worker path。Planner 仍是 in-flow role（不进 sidecar），Generator/Worker 改 claudecode-shape，Evaluator 角色废止 → 替换为 Sidecar Verifier。
- **ADR-020**（Unified Agent Execution Substrate, FEATURE_100）：兼容。Sidecar Verifier 用同一 Runner substrate，只是不再作为 role 进入 chain。
- **ADR-021**（@kodax-ai/agent vs @kodax-ai/coding 边界）：本 ADR 落 stopHook 到 agent 层符合该 ADR 的层职责规则。
- **ADR-029**（Compaction trigger top-of-loop）：无冲突。compactionHook 和 stopHook 并列在 `RunOptions`，触发时机正交（top-of-loop vs end-of-turn）。
- **FEATURE_114**（AMA Harness V2 Worker+Evaluator）：v0.7.36 把 Evaluator 保留为 structural gate；本 ADR 是该决策的反转 — FEATURE_114 当时的论据是 "Evaluator stays a separate structural gate even in V2"，但 v0.7.42 zhipu 数据证明 role-form 的 gate 不可靠，sidecar-form 用 model-decoupling 才能让 gate 真实有效。
- **FEATURE_165/166/167**：本 ADR 落地后这三个 feature 的代码全部 die（handoff gate / label flip / terminal-verdict fallback）。三者的测试套保留转化为 "Sidecar Verifier 接管之后的等价行为" 回归测试。
- **FEATURE_190 (v0.7.43, shipped 2026-05-23) — F184 Cleanup Tail**：本 ADR Phase C/D 完成后 `emit_handoff` 工具 + Worker `EVALUATOR HANDOFF` prompt block 作为 load-bearing dead code 残留（emit_handoff 是 V2 chain 唯一 terminal signal，仅删 prompt 会让 text-only 终止跑到 MAX_TOOL_LOOP_ITERATIONS 才抛）。F190 5-phase 清理：(0) NIL-conflict 配线 / (1) text-only 终止 canonical-path ratification / (2a-2c) prompt rewrite + 200-cell panel + 3-judge audit evidence-driven SHIP / (3) tool surface deletion (`handoffEmit`/`emitHandoff`/`EMIT_HANDOFF_TOOL_NAME`，+52 −178 LoC) / (4) test rewrites (9 files, +279 −717 LoC) / (5) docs + memory。FEATURE_165 pending-children gate 语义经 idle-yield 自然 subsume（Worker text-only 终止 + 子任务未完 → `detectIdleYield` 返 true → runner wait + resume，与原 gate 同观感）。`recorder.handoff` / `IdleYieldSnapshot.hasEmittedHandoff` 等公共类型字段保留 vestigial（永远 false post-Phase-3），删除超出 F190 scope 故 defer。Layer 2 SHIP gate：C1 V_new = 25/25 (100%)、C2 V_new = 24/25 (96%)，C3+C4 case-design-saturated（V_baseline 同样退化）按 [[feedback_pre_registered_gate_saturation]] 不阻 SHIP；audit drop-C4 4.4% disagreement DATA VALID。详见 [v0.7.43.md §FEATURE_190](features/v0.7.43.md#feature_190-feature_184-cleanup-tail--text-only-termination--emit_handoff-tool-surface-removal--evaluator-prompt-sweep)。
- **FEATURE_193 (v0.7.43, shipped 2026-05-23) — V1 Chain Full Retirement**：本 ADR Phase C.1+C.2 在 v0.7.42 退役了 in-chain Evaluator 角色，但 V1 的 Scout / Planner / Generator 三个 chain agent + 它们的 role prompts + V1 emit tools (`emit_scout_verdict` / `emit_contract`) + 入口路由分支 + `KODAX_HARNESS_V2` env flag 当时仍以六种残留形态留在 codebase（用户 prompt 不可见，但 ~26 files / ~50 tests / ~2000-3000 LoC 死代码）。F193 闭环 V1 退役长尾：10 commits dependency-ordered atomic ship —— test-first commit 1 (`9fb07d67`, −2577 LoC) → entry-routing 简化 commit 2 (`c5d4b829`) → V1 chain agent declarations 删 commit 3 (`dcac55ea`) → V1 role prompts + emit tools 删 commit 4 (`ef82e99c`) → SDK barrel + V1 eval archive commit 5 (`c556d46d`) → post-review dead-code residual cleanup commits 6-10（commit 6 修 2 个 HIGH 死代码分支；commits 7-8 修 4 个 RISK 运行时死代码 + 4 个 dead export/interface field；commits 9-10 ADR-030 cross-ref + HLD.md deprecation banner + 8 处 stale JSDoc + `KODAX_HARNESS_V2` migration notes）。Aggregate ~−4500 LoC net deletion across ~30 files。**Zero V2 runtime behavior change**: V2 (`chain.worker` 唯一入口路径) byte-identical to pre-F193 default route。`KODAX_HARNESS_V2=false` env opt-out 后兼容（silently ignored，shell config 不会破）。V1 type union members (`harnessProfile: 'H0_DIRECT' | 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL' | 'PLANNED'`、`roleAssignments[].role` 的 V1 成员、`harnessTransitions`) 保留为 pre-1.0 SDK vestigial（不破坏 destructure-style SDK consumer）。$0 eval cost — V1 是 dead code，删除无需 LLM judge。详见 [v0.7.43.md §FEATURE_193](features/v0.7.43.md#feature_193-v1-chain-full-retirement--scoutplannergenerator-chain-agents--entry-routing--v1-emit-tools)。
- **FEATURE_178 stall sidecar**：当前硬接在 [`runner-driven.ts:651`](../packages/coding/src/task-engine/runner-driven.ts) 通过 `RunnerToolObserver`。**FEATURE_187（planned v0.7.43）** 把 stall sidecar 迁到 `agent-runtime/middleware/stall-sidecar/`、跟 FEATURE_184 verifier 同形（factory + env override + opt-in log），统一 sidecar 接入面。Placeholder 原写 "v0.7.46+, optional"，2026-05-22 promote 到 v0.7.43 — byte-identity prompt 锁兜底 $0 eval、~1-2 工作日。详见 [FEATURE_LIST](FEATURE_LIST.md) §FEATURE_187 + [v0.7.43.md](features/v0.7.43.md#feature_187-stall-sidecar-middleware-unification)。
- **FEATURE_195 + FEATURE_196 (v0.7.43, shipped 2026-05-24) — F184 UX + Content-Aware Fire Gate**：本 ADR Phase C/D 把 verifier sidecar 设计为 default-silent accept（accept 走 session.jsonl 不走 UI；revise / blocked 走 UI），但 v0.7.42 ship 后 user 2026-05-24 实战截图（"你好 → 你好!" 对话）显示 sidecar accept verdict 的 `reason` text 仍以 `> [Evaluator] ...` event-item 渲染到 transcript —— pipeline 三步 (verifier-recorder-bridge `role:'evaluator'` legacy label + payload-builder 写 evidence.entries + InkREPL `buildManagedTaskTranscriptItems` 无差别 render) 把 silent-accept 设计意图漏到 UI 层。F195 单 commit `1b53150e` 落 REPL render filter：`role==='evaluator' AND signal==='COMPLETE' AND !verifierLog ⇒ filter`，opt-in `KODAX_VERIFIER_LOG=1` 复用 F184 Phase D.3 已有 env var；数据层不动 (`recorder.verdict` 仍写 session.jsonl + artifact，replay / debug / scorecard / `kodax sessions` 全完整)；8 新 unit test 覆盖 4 verdict state × 2 mode。**Root cause 修正**：立项 doc 假设 `decidedByAssignmentId='evaluator'`，但 [`payload-builder.ts:218-219`](../packages/coding/src/task-engine/_internal/managed-task/payload-builder.ts#L218-L219) 三元判断 `harness === 'H0_DIRECT' ? 'direct' : verdictStatus ? 'evaluator' : 'worker'` 表明 H0_DIRECT trivial-chat 真实是 `direct`，所以 evidence-entry 是 `buildManagedTaskTranscriptItems` 路径而非 skip-final filter 已处理的 evaluator 路径——这是 F195 设计立项 doc 与生产路径分歧的关键，最终所有 fixture 用 `direct` 对齐生产。F196 4 commits (`10b8b290` gate.ts + 23 unit / `c25ff99c` composedStopHook 集成 + 3 integration / `af7bc588` Layer 2 eval driver + 60/60 PASS / 本 commit docs) 落 deterministic 前置 gate：[`composeGateDecision(ctx, env)`](../packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.ts) 顺序 Layer 1 `detectActionSurface`(last assistant `tool_use`) → Layer 2 `detectConversationalIntent`(greeting prefix + 长度 ≤20 codepoint + 无 imperative verb 三合取) → escape hatch `KODAX_VERIFIER_ALWAYS=1` → default fire；在 `composedStopHook` `!isIdleYieldTurn` 分支 `observer.sidecarStarted()` 之前调用，`fire===false` 直返 `extensionTurnCompleteHook(ctx)` 不进 sidecar；`KODAX_VERIFIER_LOG=1` stderr `[sidecar-gate] {fire|skip}: <reason>` 复用 F195 env var。**Layer 2 eval $0 vs 立项 $10-15 budget under-spend ~8×**：gate logic deterministic（pure function），Layer 1 unit tests 已 exhaustive 覆盖 gate decision（23 unit + 3 integration），Layer 2 只 buy tuple realism——12 cases × 5 canonical alias × 1 run = 60 cells 全 100% PASS（C1 greeting skip / C2 imperative+zero fire / C3 long fire / C4 no-greeting fire），pilot ark/v4flash × 12 × 1 = 12/12 PASS。**3-judge audit 跳过**：gate decision per cell 是 `actualDecision === c.expectedDecision` 严格等值比较，无 LLM 歧义空间，3-judge majority 适用 LLM-judge 场景不适用 deterministic gate eval (per `feedback_audit_must_see_binding`)。Eval driver retain 为永久 regression sweep（`tests/feature-196-sidecar-content-gate.eval.ts` + `benchmark/datasets/feature-196-sidecar-content-gate/cases.ts`），raw dumps 留 `<tmpdir>` per `feedback_eval_dumps_stay_in_temp` 不入 repo。**与 F184 substrate 关系**：F184 是 substrate（verifier 实例 + stop hook wiring + verdict provider 解析），F195+F196 是 UX layer + 性能 gate——F195 落实 F184 设计意图，F196 把 90% trivial chat 的 sidecar LLM call 用 deterministic regex 前置 skip，降 latency tail (3-10s) + 降 cost。F184 verifier prompt / retry / fail-open 逻辑 byte-identical 未动。详见 [v0.7.43.md §F195](features/v0.7.43.md#feature_195-sidecar-verifier-ui-silent-accept--default-hide-accept-verdict-evidence-entry--transcript-mode-opt-in) + [§F196](features/v0.7.43.md#feature_196-sidecar-verifier-content-aware-gate--action-surface-detector--conversational-user-intent-skip)。
- **FEATURE_215 (v0.7.49) — Generic LLM-Judged Stop-Hook Primitive 下沉（补注，不推翻原裁决）**：concrete LLM judging（domain prompt / file-edit 证据 / verdict 落地 / recorder bridge）仍留 `@kodax-ai/coding`；其**域中立的调用内核**（`invokeLlmJudge` / `createLlmJudgedStopHook` — stream → fuzzy-match → parse → timeout-race → fail-open）下沉 `@kodax-ai/agent` 作为 runtime-middleware 原语，供外部 SDK 使用方在裸 `Runner` 上注入自有 domain prompt 复用。Sidecar Verifier (F184) 与 Stall Sidecar (F178) 退化为注入 prompt/parser/default-verdict 的薄 consumer，消除两处复制粘贴的 `editDistance` + invocation 骨架（`editDistance`/`findFuzzyToolMatch` 现为 agent 单一源）。这是对 [ADR-021](#adr-021-agent-framework-boundarykodax-aiagent-vs-kodax-aicoding)“非 coding agent 也需要 → agent 层”的应用，与本 ADR“不 generalize concrete judging”不冲突。**Zero prompt-byte change / eval non-trigger**：以 `byte-identity-lock.test.ts` + `verifier.test.ts`(19/19 零改动) + `sidecar.test.ts`(31/31) 作等价回归证据。详见 [v0.7.49.md §FEATURE_215](features/v0.7.49.md#feature_215-generic-llm-judged-stop-hook-primitive-下沉-kodax-aiagentsidecar-verifier--stall-sidecar-共用内核抽取)。
- **FEATURE_270 Sidecar/Actor alignment（v0.7.72，2026-07-18 设计与实现补注）**：F270 的 Actor tree 与 ADR-030 的 Sidecar Verifier 是相邻控制面，不是同一 identity。Actor plane 对 delegated Turn、mailbox 和 completion delivery 权威；Runner StopHook 对 root answer verification 权威。Verifier 保持 non-Actor，且只能在 `activeDescendantTurns===0`、当前 root 的 session-scoped task-notification queue 已清空之后运行；同一 readiness 也约束 extension `turn:complete`，因为 intermediate idle-yield text stop 不是 root turn completion。Verifier context 以 `KodaXMessage._taskResult(s)`、Todo snapshot、tool outcome status 和 mutation tracker 组成 bounded evidence envelope；`_synthetic` completion 不得成为 user intent，current query/final text 不在 rolling buffer 重复。任务状态、工具 outcome 和计划状态均按控制面事实而非正确性证明解释。禁止读取 child hidden transcript、抓取 artifact URI 或新增 Sidecar registry。`role:'evaluator'` recorder projection 暂留为 downstream compatibility adapter，未来迁移必须单独 version/inventory，不与 readiness/evidence 修复共用 rollback unit。Layer 1 与 32-call blind A/B 均支持发布；完整实施与 eval 证据见 [v0.7.72 Sidecar alignment design](features/v0.7.72.md#2026-07-18-sidecar-verifier--actor-control-plane-alignment-design)。

### 用户可见影响

- 单 turn task 体验**几乎无变化**：模型 emit text 完成 → Sidecar Verifier 在背景 3-10s 内完成判定 → 90% 场景 accept 直接释放给用户。仅在判 revise 时多一轮模型自动修复。
- UI 增加 `⊙ Verifying...` 短指示器（dim, 不抢眼）。Reanimate 触发时显示 `↻ Retrying with: <reason>` system-style line（dim）。Blocked 显示 `⚠ Cannot verify: <reason>` prominent line。形态对标 claudecode 的 `hook_stopped_continuation` attachment 风格。
- Session restore 行为：旧 session 的 `decidedByAssignmentId: "evaluator"` 历史记录仍可读，但新 session 不再产生该字段 — sidecar verdict 落到独立的 `sidecarVerdict` field（不冲突 schema）。

### References

- 设计调研三路 Explore（KodaX Evaluator role / claudecode 完成机制 / KodaX 现有 sidecar mechanisms / agent-coding 边界）2026-05-20 session
- 设计对话 transcript（用户 Q1-Q5 + 三路 Explore 综合，详见 v0.7.45 设计稿）
- 关键 memory: [`project_feature_167`](../../memory/project_feature_167_evaluator_verdict_fallback.md)、[`feedback_model_structural_floor_not_prompt_tunable`](../../memory/feedback_model_structural_floor_not_prompt_tunable.md)、[`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md)、[`feedback_refactor_parity_baseline`](../../memory/feedback_refactor_parity_baseline.md)、[`feedback_behavioral_vs_semantic_equivalence`](../../memory/feedback_behavioral_vs_semantic_equivalence.md)
- claudecode 参照：`src/query.ts:241,824,1062,1278`、`src/query/stopHooks.ts:269-280,325`
- KodaX 当前 Evaluator wiring：`packages/coding/src/agents/task-engine-agents.ts:41`、`packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts:843-927`、`packages/coding/src/agents/protocol-emitters.ts:90`、`packages/coding/src/task-engine/runner-driven.ts:1721+`（B0/B1/B2 fallback）
- v0.7.45 设计稿 §FEATURE_184

---

## ADR-031: Task-Level Hits Ledger 与 Cross-Session Memdir 分层独立（FEATURE_185, v0.7.42）

**Status**: Accepted 2026-05-20

### 背景

v0.7.42 上下文层连续 ship 了若干 compaction-相关 feature（F177 read-cache、F178 stall sidecar、F179 top-of-loop、F180 RI dedup、F181/F182 summary 抗丢失、F183 PROTECTED 扩容）。本 ADR 关注最后一块拼图 **FEATURE_185**：把 `grep` / `code_search` / `glob` / `bash` 的结构化结果保留在 `artifactLedger.metadata`，渲染进 `[Post-compact: recent operations]` system 消息，让模型 compact 之后**不必 re-grep / re-run** 也能回答历史问题。

v0.7.43 设计稿 §FEATURE_124 同时规划了 **memdir**（claudecode-parity 的 per-project markdown memory：4-type taxonomy + `~/.kodax/projects/<repo>/memory/*.md` + LLM 直接读写）。两者都"把信息保存下来供后续 LLM 读取"，乍看有重叠风险。本 ADR 锁定**为什么不合并**。

### 决策

**F185 ledger 与 F124 memdir 故意是两套独立机制，按 lifecycle 与作用域正交切分**：

| 维度 | F185 Hits Ledger | F124 Memdir |
|---|---|---|
| **作用域** | Task 内（同一 `runManagedTask` 调用） | Project 全局（per git-root，跨 session） |
| **生命周期** | Task 结束随 session entry 序列化进 jsonl，task 复用时载入；不跨 project 流转 | 永久驻留 `~/.kodax/projects/<repo>/memory/`，由用户/LLM 主动 prune |
| **写入者** | Runner（自动 — 每次 `tool_use` + 对应 `tool_result` 进 `extractArtifactLedger` pre-pass，无 LLM 决策） | LLM（显式 — 用 `Write` 工具写 `.md` 文件） |
| **粒度** | 单条 hit / 单次 command exit + tail，结构化 record | 自由格式 markdown，4 type 分类 |
| **更新方式** | 增量 merge by dedup-key（同一个 `target` 多次跑 keep latest enrichment） | 文件级 overwrite by LLM 决定 |
| **预算** | 共享 `POST_COMPACT_TOKEN_BUDGET=50K × ledgerShare=15%` ≈ 7.5K tokens / task | `MEMORY.md` 索引 ≤200 行 / 25KB；per-file 自由 |
| **触发渲染** | 每次 LLM-summarised compaction 之后立刻注入 system 消息 | Session 启动时一次性注入 system 消息（claudecode 也是这样） |
| **示例** | "上次 grep authenticate 在 auth.ts:42 / 78 / login.ts:13" | "user prefers integration tests over mocked unit tests" |

### 替代方案考量

#### 方案 A：把 ledger metadata 写到 memdir 的 `project_*.md`

LLM 在 compaction 时把 hits 写入 `~/.kodax/projects/<repo>/memory/project_recent_searches.md`。

**否决理由**：
- 引入 LLM 写入决策 → ledger 更新依赖 model attention，但 model 在长 session 末尾 attention 已稀缺（这正是 F178/F179 要解决的 stall/compaction 触发问题）。F185 必须是 100% 机械可靠的 batch-extract。
- 触发节拍冲突：memdir 是 session-end manual prune，ledger 是 round-end automatic enrich。强行合并要么 memdir 失去用户控制（被 runner 频繁写入），要么 ledger 失去自动化（被 LLM 偶尔遗漏写入）。
- 作用域错配：搜过 `authenticate` 出现在哪些 path:line 是 **task-internal scaffolding info**，不是 cross-session insight。把它持久化进 memdir 会污染 memory 信噪比，让用户每次 prune 时面对一堆 search artefact。

#### 方案 B：在 ledger 写入时 LLM-judge "是否值得 promote 进 memdir"

每条 ledger entry 加一个 LLM 评分（"this finding is/isn't worth long-term retention"），超阈值 promote。

**否决理由**：
- 每 turn 多一个 LLM call → 上下文层延迟 + 成本失控。
- 评分判别本身是 hard problem，且当前 evidence 还不足（没数据表明 hits ledger 内容的 long-term reusable rate 多高）。违反 [`CLAUDE.md`](../CLAUDE.md) "NEVER add abstractions without 3+ use cases"。
- "promotion path" 这种 implicit cross-layer flow 让人难调试 — 反例：FEATURE_180 RI dedup 之前的 cross-layer leak 就是 implicit flow 出过事的化石证据。

#### 方案 C（采纳）：分层 + 显式接口

两套独立，**不互相调用、不共享 storage**，只在 system-prompt 注入点和平共处：
- session 启动注入 → memdir markdown blocks
- compaction 之后注入 → ledger summary block

两块在 system prompt 里**并排存在**，LLM 自行判断哪块跟当前任务相关。这跟 claudecode 的实际做法一致（claudecode 同时有 `extractMemories` markdown 注入 + tool result placeholder，从不让两者互调）。

### 与既有 ADR / Feature 的关系

| 既有 | 关系 |
|---|---|
| **F121 spill-to-file**（v0.7.40） | F185 互补：F121 让超大 raw output 落盘（避免 inline 爆 context），F185 让 path:line + tail 结构化进 ledger（避免 spill 之后失忆）。spill file 是 "需要时按 path 查"，ledger 是 "不用查就有梗概"。 |
| **F183 PROTECTED 扩容**（同版） | F185 互补：F183 是"对的 tool（todo/MCP/RI/control-plane）不让 microcompact 清"；F185 是"被允许 clear 的 tool（grep/bash/...）也别全丢，先抽结构化字段"。两者一起把"压缩销毁丢信息"的攻击面降到最小。 |
| **F124 memdir**（v0.7.43 规划） | 本 ADR 锁定 lifecycle/作用域正交，**不合并**。 |
| **F104 prompt-eval discipline**（v0.7.29） | F185.4 Layer 2 panel 是 F104 harness 的标准应用：5-alias canonical panel + pre-registered gate + pilot-then-scale + offline re-judge with normaliser。 |
| **ADR-029 top-of-loop compaction**（同版） | F179 把 compaction trigger 提前到 LLM call 之前，F185 让 compaction *之后* 的 system prompt 信息密度更高。两者节拍对齐：compaction 越早触发，ledger enrichment 越早被模型用上。 |

### 后续验证

- [v0.7.45+ 真实 session 复盘] 在用户实际跑长 session 时观察 `[Post-compact: ...]` 注入的 ledger summary 是否：
  - 显著降低 long-session 中重复 grep 同一 pattern 的频率（baseline 待 F172 wall-time 实测期一并采集）
  - 不被 ledger budget overrun（7.5K tokens × per task）挤掉重要 file_modified / file_read entries
- [Layer 2 follow-up] F124 memdir ship 后做一个 cross-feature panel（5 alias × 4 case：grep recall, bash recall, memdir cite, mixed）确认两套机制不互相干扰、不让 model 选错块。

### References

- 配套实施：4 commits `15b1ea3c` + `83976149` + `da8d7b28` + `bddc3d58`（同 commit message 内嵌设计 rationale 与 SHIP gate 决策矩阵）
- v0.7.42 上下文 §FEATURE_185（详细 pipeline + render 格式 + eval 结果）
- v0.7.43 设计稿 §FEATURE_124 memdir（确认 lifecycle / 作用域正交）
- 关键 memory：[`feedback_review_threat_model`](../../memory/feedback_review_threat_model.md)（KodaX-specific gap 判断）、[`feedback_layer1_measurement_before_optimization`](../../memory/feedback_layer1_measurement_before_optimization.md)（Layer 2 panel 验证 SHIP gate）、[`feedback_regex_audit_per_new_eval`](../../memory/feedback_regex_audit_per_new_eval.md)（pilot 1 暴露 + 修复 normaliser）

---

## ADR-032: SDK Embedder Surface Closure (FEATURE_186, v0.7.42)

**Status**: Accepted 2026-05-21
**Driver**: KodaX Space（基于 `@kodax-ai/kodax@0.7.40` 的下游消费者）报回的 10-gap export 清单 + MCP popout 独立设计需求
**Scope**: SDK publish surface（dist `.d.ts` bundling + subpath exports）/ 一行 export 集 / runtime hook 注入 / mid-run mutation surface / 配置 CRUD / MCP 子路径

### Context

KodaX 在 v0.7.39 的 ADR-024 把 npm 发布物正名 `@kodax-ai/kodax` + 形式化了 5 个 SDK subpath（`/agent` `/llm` `/coding` `/repl` `/skills`）。v0.7.40-v0.7.41 期间，KodaX Space 把 `@kodax-ai/kodax@0.7.40` 当作 substrate 在他们桌面端封装上跑，集成过程中报回了三类 gap：

1. **SDK 发布物缺陷** — 入口 `.d.ts` 在 v0.7.40 仍内嵌 `import { X } from '@kodax-ai/*'`（rollup-plugin-dts bundle 后跑出来一份 self-contained 但同 commit 漏更新；用户 `tsc --noEmit` 在 Space 项目里能复现）。这一类是 publish hazard，dist tarball ship 出去就坏。
2. **能力存在但 barrel 没 re-export** — Space 在他们项目里反复手写一份 parallel implementation（`bootstrapAutoMode` / `loadCommands` / `getAgentConfigHome` / `getAgentConfigPath` / `getAppDataDir` / `KodaXReasoningMode` / `ToolSideEffect` 分类 / `validateCustomProviderConfig` 等）。每次 KodaX 内部改格式 Space 那边就坏（"你们改格式我们就坏"——commit `ee549d6f` 注释引用）。
3. **运行时 hook 缺失** — Skill 系统的 `!cmd` 动态上下文用 `execSync` 直接出走宿主 shell（在 Space 沙盒里要么噪音要么不安全）；`runKodaX` 是 blocking `Promise<KodaXResult>`，没办法 mid-run 切 provider / model / reasoning 也没办法不 forge `AbortSignal` 取消；MCP 服务器只能 hand-edit `~/.kodax/config.json`，restart runtime 才生效。

并行用户提的 **MCP popout** 是独立产品需求：让 Space 把 MCP 服务器管理放到 popout 窗口，对外只暴露 MCP 子集，避免拉全 coding bundle。

### Decision

**Ship 全部 10 gap + MCP popout 在 v0.7.42，不 defer**。设计原则：

1. **No dual route**（per [feedback_no_parallel_refactor_paths](../../memory/feedback_no_parallel_refactor_paths.md)）：`startKodaX` 是 `runKodaX` 的 thin decorator，不引入并行执行路径；plan-mode gate 元数据驱动一套实现，删 `ACP_TOOL_FILE_MODIFICATION_TOOLS` 硬编码 set；不为 hypothetical future 加 flag 双轨。
2. **Trust boundary 不变** — KodaX 是 single-user CLI（per [feedback_review_threat_model](../../memory/feedback_review_threat_model.md)），CRUD 模块 last-write-wins 多写并发不是 v0.7.42 生产关切；注释里写明 future file-lock 不破坏 caller-facing API。
3. **Validator 同 SDK 一致** — Custom provider CRUD 调 `validateCustomProviderConfig`（来自 `@kodax-ai/llm`，SDK 自身用的同一份）；MCP CRUD 做 shape-level check（已知 transport / connect 枚举 + stdio→command / sse|streamable-http→url 分支必填）。Space 不再需要 parallel zod schema。
4. **Dynamic path resolution** — CRUD 模块每次调用经 `getAgentConfigPath('config.json')`，不缓存 module-load 时的 `KODAX_CONFIG_FILE` 常量，让 `setAgentConfigHome()` programmatic override（tests / 多租户 substrate consumers）即时生效。Phase 5 实测此修复是 14 个 vitest 测试一次全 PASS 的关键。
5. **Mid-run state 直改 live `RuntimeSessionState`** — `sessionControl._attach({...})` 在 `buildRuntimeSessionState` 之后 substrate 调一次，把三个 setter 装上；CAP-055 `resolvePerTurnProvider` 已经在每轮开头从 `sessionState.modelSelection` / `sessionState.thinkingLevel` 重读（pre-FEATURE_100 baseline 保留至今）。下一轮 turn 自动看到变化，无需 re-resolve 仪式。
6. **元数据驱动 plan-mode gate**（Phase 4 keystone）— `LocalToolDefinition.sideEffect: 'readonly' | 'mutates-fs' | 'mutates-shell' | 'mutates-network' | 'mutates-state'` 必填字段 + 可选 `planModeAllowed?: boolean`。`packages/repl/src/permission/types.ts` 的 `FILE_MODIFICATION_TOOLS` / `MODIFICATION_TOOLS` 改为 module-load 时从 `listBuiltinToolDefinitions()` 计算（无需手 sync）；`acp_server.ts` 硬编码 `Set(['write','edit'])` 换成 `isToolFileMutation`；`construction/runtime.ts` LLM-constructed tools 默认 `sideEffect: 'mutates-state'`（守得最严）。
7. **MCP subpath 是 publish-time subset**（per ADR-024 既有模式）— `src/sdk-mcp.ts` 只 re-export `@kodax-ai/mcp`（不带 coding 层 adapter），让 Space 引 `@kodax-ai/kodax/mcp` 时 dist/sdk-mcp.js ~0 kB + 共享 chunks，不拉 12 kB 的 sdk-coding bundle。

### Implementation

**8 atomic commits**（在并行 thread FEATURE_184 跑的时候 stage 每个 commit 都按文件名走，不用 `git add -A`，每个 commit `add + commit` 同一 Bash 调用，per [feedback_concurrent_thread_git_race](../../memory/feedback_concurrent_thread_git_race.md)）：

| Phase | Commit | Surface |
|---|---|---|
| 1 | `2e33b681` | `scripts/build-dts.mjs` self-test + hard-assert `/from\s+['\"]@kodax-ai\//` 在 entry .d.ts |
| 2 | `d3ab38b0` | `packages/agent/src/runtime/agent-home.ts` `getAppDataDir(appId)` + 32 单测；`packages/repl/src/index.ts` `bootstrapAutoMode` re-export；`src/sdk-repl.ts` `loadCommands` etc. re-export；`packages/coding/src/index.ts` `getAgentConfigHome` / `getAgentConfigPath` / `setAgentConfigHome` / `getAppDataDir` re-export |
| 3 | `9b1e440f` | `packages/skills/src/types.ts` `executeDynamicContext?` + `disableDynamicContext?` 注入 `SkillContext`；`skill-resolver.ts` 3-tier dispatch（disable → host hook → legacy `execSync`） |
| 4 | `7defd65f` | `packages/coding/src/tools/types.ts` `ToolSideEffect` + `sideEffect: ToolSideEffect` 必填；`packages/coding/src/tools/registry.ts` 51 工具全打标 + 4 个 helper；`packages/repl/src/permission/types.ts` `FILE_MODIFICATION_TOOLS` / `MODIFICATION_TOOLS` 元数据计算；`packages/repl/src/permission/permission.ts` `getPlanModeBlockReason` layered；`src/acp_server.ts` 硬编码 set 移除 |
| 5 | `ee549d6f` | `packages/repl/src/common/custom-providers.ts` CRUD（21 单测）+ `validateCustomProviderConfig` re-export 链（llm / coding / coding-providers）+ 动态 `getAgentConfigPath('config.json')` resolve |
| 6 | `9ba68f25` | `packages/coding/src/types.ts` `KodaXSessionControl` + `KodaXSessionMutators`；`packages/coding/src/agent-runtime/run-substrate.ts` `_attach({setProvider/setModel/setReasoning})` 在 `buildRuntimeSessionState` 之后；`packages/coding/src/running-session.ts` 新文件（200+ LoC）+ 20 单测 |
| 7 | `523e9a28` | `packages/repl/src/common/mcp-servers.ts` CRUD（26 单测）+ shape validator；`src/sdk-mcp.ts` 子路径入口；`scripts/build-bundle.mjs` `sdkEntryNames` 扩 + `scripts/build-dts.mjs` `sdkEntries` 扩 + `scripts/release.mjs` `pkg.exports['./mcp']` 同步 |
| 8 | Phase 8 | `packages/mcp/src/manager.ts` 新文件（`McpManager` class + `createMcpManager` factory，~230 LoC）暴露 `listServers / startServer / stopServer / getServerLogs / listTools` 5 大 popout 操作 + `provider() / execute / describe / search / read / dispose` escape hatch；`packages/mcp/src/provider.ts` 加 `getServerIds()` + `getRuntime(id)` 两个 readonly accessor 让 manager 复用 provider 内部 runtimes Map（不重复构造）；`packages/mcp/src/index.ts` + `packages/coding/src/index.ts` re-export 链；20 单测（真 MCP test-fixture stdio JSON-RPC 全程，包括 broken-binary lastError 捕获 / stop→start 重连 / forceRefresh 旁路 cache / 4 个 unknown-id 错误路径）|

**158 个新单测**（不含既有不退化测试）。

**Phase 7 vs Phase 8 关系**：Phase 7 暴露的 `@kodax-ai/kodax/mcp` 子路径在 KodaX Space 实测后反馈"只有 types + helpers，没有 manager 高层 API"——`McpCapabilityProvider` 已经被 export 但形状是 capability-provider-shape（`search / describe / execute / read / getPrompt`），popout UI 想要的是 manager-shape（`listServers / startServer / stopServer / getServerLogs / listTools`）。Phase 8 加 `McpManager` thin wrapper（内部 hold 一个 `McpCapabilityProvider` 实例）补这个 surface gap，保持 capability-provider API 完全向后兼容（escape hatch 通过 `manager.provider()` 拿到）。

### Consequences

**正面**：
- KodaX Space 不再维护任何 parallel implementation 的 KodaX SDK ABI；CRUD 走 SDK validator，schema drift 死掉。
- `RunningSession` 让 Space 桌面端的"切 provider / 切 model / 切 reasoning"动作不再需要 restart agent。
- MCP popout 端凭 `@kodax-ai/kodax/mcp` + `@kodax-ai/kodax/repl` 的 MCP CRUD 子集独立构建，不拉全 coding bundle。
- Plan-mode gate 元数据驱动后，新加工具的开发者只需要打 `sideEffect` 标签，gate 自动维护；`acp_server.ts` 不再有"加新工具忘了同步硬编码 set"的隐患。

**负面 / 风险**：
- `LocalToolDefinition.sideEffect` 从可选变必填是 SDK ABI break（已在 Phase 4 commit message 文档化）；旧版 substrate consumer 没标 `sideEffect` 的自定义工具会 tsc fail。缓解：v0.7.42 CHANGELOG `Breaking changes` 段会显式列出。
- `startKodaX` 与 `runKodaX` 并存可能让"哪个是 canonical"的问题反复回到 SDK 文档；通过 `runKodaX` jsdoc 显式说"`startKodaX` is the new non-blocking entry" + sample code 倾向 `startKodaX` 来缓解。
- MCP popout 内 mutation 触发下一次 turn prompt cache miss（Space 用户加 MCP server 后下一轮变慢一次）；与 v0.7.41 FEATURE_125 team-mode 加新 sibling instance 同类，文档化。

### Alternatives considered

- **每个 gap 一个 FEATURE_xxx** — rejected，10 个 gap 涉及面太散，单 FEATURE 多 phase 更适合 release-cycle scope；FEATURE_186 是 umbrella。
- **`startKodaX` 走 `EventEmitter` 协议而非 `RunningSession` 对象** — rejected，KodaX 已有 `KodaXEvents` 一套 observer pattern；额外加 EventEmitter 会形成两个 events 通道，Space 上手负担更高。Setter 方法 + getter 字段对 popout UI 是直接绑定模式。
- **MCP CRUD 放 `@kodax-ai/kodax/mcp` 子路径** — rejected，CRUD 依赖 `getAgentConfigPath` 这条 repl-bound 路径解析；放 `/mcp` 会让子路径意外拉进 repl bundle，破坏"子路径最小化"目标。CRUD 落在 `@kodax-ai/kodax/repl` 是 trade-off：Space MCP popout 多引一行 import 但保住子路径独立性。
- **plan-mode gate 用 string-prefix 启发式（如 `name.startsWith('web_')`）** — rejected，启发式漂移不可见；元数据 explicit + module-load 时计算 + 强类型字段被 TS 强制（添加新工具不打标签直接 tsc fail）是更稳的设计。

### References

- 配套实施：8 atomic commits `2e33b681` → `d3ab38b0` → `9b1e440f` → `7defd65f` → `ee549d6f` → `9ba68f25` → `523e9a28` → Phase 8（每个 commit message 内嵌设计 rationale）
- v0.7.42 上下文 §FEATURE_186（详细 gap 清单 + 实施 cross-reference + 测试合计）
- ADR-024（v0.7.39 SDK subpath 形式化基础）— 本 ADR 扩第 6 个子路径
- 关键 memory：[`feedback_review_threat_model`](../../memory/feedback_review_threat_model.md)（信任边界）、[`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md)（单实现）、[`feedback_concurrent_thread_git_race`](../../memory/feedback_concurrent_thread_git_race.md)（atomic add+commit）

---

## ADR-033: claudecode-Style Prompt Design Principles — Qualitative Criteria over Quantitative Rules (v0.7.42-v0.7.43)

**Status**: Accepted 2026-05-21
**Driver**: FEATURE_177 task_output Worker prompt RULE D Layer 2 panel hit pre-registered REVERT threshold (C5 kimi -60pp cross-case regression on RULE C write fan-out). 同 session 用户提出更深层质疑："RULE A-C 给的信号要求太强了，整个 prompt 应该简单些，让 AI 判断 dispatch 是否提升效率就行"。
**Scope**: 所有 KodaX role prompts（worker / generator / evaluator / planner / scout）的设计哲学 + 措辞规范。本 ADR 是 umbrella；后续 FEATURE refactor 引用此 ADR 作为标准。

### Context

FEATURE_177 v0.7.45 panel rerun #2（5 alias × 5 case × 5 run × 2 variant = 250 cells, 3.2% audit disagreement DATA VALID）实测数据：

| Case | v_baseline | v_proposed (RULE D ON) | Δ |
|------|-----------|------------------------|---|
| C1 peek (user-asked) | 16/25 (64%) | 19/25 (76%) | +12pp |
| C2 peek (long-running) | 15/25 (60%) | 23/25 (92%) | +32pp |
| C3 idle-yield NEG (block:true 滥用) | 24/25 (96%) | 23/25 (92%) | −4pp (saturated) |
| C4 RULE A read-only fan-out | 14/25 (56%) | 14/25 (56%) | 0pp |
| **C5 RULE C write fan-out, kimi** | **4/5 (80%)** | **1/5 (20%)** | **−60pp** |

C5 kimi -60pp 触发 pre-registered REVERT 阈值（>20pp cross-case regression）。根因不是 RULE D 单段写得不好，而是 dispatchRules 整段设计哲学有问题：RULE D 第二个 ✗ 反模式 "do NOT replace planned fan-out (`dispatch_child_task`) with `task_output` polling" 让 kimi 在 RULE C 写场景泛化抑制 dispatch（per [`feedback_prompt_strengthening_cross_case_regression`](../../memory/feedback_prompt_strengthening_cross_case_regression.md)）。

**对照 claudecode 同位置 prompt**（[`C:/Works/claudecode/src/tools/AgentTool/prompt.ts:85-95`](file:///c:/Works/claudecode/src/tools/AgentTool/prompt.ts) + [`src/constants/prompts.ts:316-320`](file:///c:/Works/claudecode/src/constants/prompts.ts)）：

> Fork yourself **when the intermediate tool output isn't worth keeping in your context**. The criterion is **qualitative** — "will I need this output again" — **not task size**.
> - **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message.
> - **Implementation**: prefer to fork implementation work that requires more than a couple of edits.
>
> **Don't peek.** ... You get a completion notification; trust it.
> **Don't race.** ... Never fabricate or predict fork results.

主 prompt 那边整段 "use sub-agent" 教学 = 60 词、一句话。

**KodaX worker-role-prompt.ts `dispatchRules` 同等位置** = ~800 词 + 4 个 RULE 标签 + 多条 MANDATORY + 复合 ✗ 反模式 + FEATURE_xxx vX.Y.Z 版本元数据。**Order of magnitude 差 13×**。

### Decision

把 KodaX 整体 prompt 设计哲学切换为 **claudecode-style qualitative + colleague-judgment**，建立 5 条 prompt design principles 作为后续所有 prompt 改动的标准：

#### 1. Qualitative criteria over quantitative thresholds

❌ "when you need ≥3 independent investigations" / "≥45 seconds" / "≥3 modules"
✅ "when the intermediate tool output isn't worth keeping in your context" / "when independent work can run in parallel for speedup" / "when it would otherwise fill your context with raw output you won't need again"

**Rationale**: 量化阈值让 LLM 把 dispatch 当"查表"而非"判断"。"2 个 child 该不该 dispatch?" "正好 4 个 module 算不算 ≥3?" 这种边界情形模型会僵掉。Qualitative 措辞让 LLM 用 colleague-judgment——这是 claudecode 显式选择的设计点（prompt 内 *literally* 写 "The criterion is qualitative — not task size"）。

#### 2. Single-concept sentences — no compound rules

❌ "do NOT use X as wait substitute, **AND** do NOT replace planned Y with Z"
✅ "Don't peek." / "Don't race." 两句各自单独一行，每句后跟一句 why。

**Rationale**: FEATURE_177 RULE D 的 ✗ #2 复合从句直接造成 kimi C5 -60pp。复合 ✗ 让模型抽出错位的泛化命题。单 concept 单句让模型对每条命题的 scope 边界清晰。

#### 3. ✗ 反模式 sparing usage — must include WHY

❌ "Do NOT use write fan-out for single-file edits" (孤立否定，无 why)
❌ "do NOT replace planned fan-out with task_output polling" (无 why)
✅ "Don't peek. The tool result includes an `output_file` path — do not Read or tail it unless the user explicitly asks for a progress check. **You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.**"

**Rationale**: claudecode 的 ✗ 总带一句 because-clause 解释失败模式。这让 LLM 在 edge case 上能 reason about scope（"啊这是为了防 context 噪音, 不是禁止 Read 文件"）。KodaX 现状很多 ✗ 是裸否定，模型只能 over-suppress。

Per [`feedback_prompt_strengthening_cross_case_regression`](../../memory/feedback_prompt_strengthening_cross_case_regression.md)："用 ✗ 反模式 catalogue 风险最高，模型会泛化抑制"——FEATURE_120 send_message +30pp 同时 task_stop -60pp 的真实复现案例已经在 memory。FEATURE_177 RULE D C5 kimi -60pp 是同一坑的第二次复现。

#### 4. No enumerated taxonomies — RULE A/B/C/D out

❌ KodaX dispatchRules 现有 RULE A (read-only) / RULE B (long-running) / RULE C (write) / RULE D (peek)
✅ claudecode 用 use-case 描述："Research" / "Implementation"——不是分类，是场景示例

**Rationale**: 枚举分类让 LLM 把 "我应不应该 dispatch" 当成"我属于哪个 RULE"的归类问题。一旦实际场景跨多个 RULE 或不完全 fit 任何一个，模型就有"既没满足 A 也没满足 C，那就不 dispatch"的逃逸路径。Claudecode 用 informal use-case examples 而非 classification taxonomy。

#### 5. No version metadata in prompt body

❌ "LARGE CHILD OUTPUT (**FEATURE_121 v0.7.40**)" / "MODEL HINT (**FEATURE_120 v0.7.39**)" / "DISPATCH RULES (`dispatch_child_task` — idle-yield model, **FEATURE_155 v0.7.39**)"
✅ 完全省略——prompt body 是给 LLM 看的，FEATURE 编号是给开发者看的，写在 code comment 即可

**Rationale**: 版本元数据对 LLM 是噪音（不构成判断依据）+ 容易 prompt cache 碎片化（FEATURE 编号变更会破缓存 prefix）+ 给读者错觉 "这些是有时序依赖的规则"。claudecode 代码注释里写 PR 编号但 prompt body 一个 FEATURE_xxx 都没有。

#### 6. Layered prompt — registry brief identity, in-prompt detailed guidance

❌ KodaX 现状：tool registry `description` 字段塞所有教学（schema + use-case + WHY + 多条 numbered rule + 版本号），单 string 700-1600 字。每次 stream tool catalog 都付一次完整教学的 token 成本；模型 always 看见复杂描述，即使该 turn 不调用该 tool。
✅ claudecode：tool `DESCRIPTION` 常量 **3-8 字**（"Create a new task in the task list"）+ 详细教学放 `getPrompt()` 函数单独按需注入（80-700 字）。registry 层只承担**身份标识**职责，使用教学是另一个 surface。

**Rationale**: 双层数据测量证据：
- claudecode `TaskCreateTool/DESCRIPTION` = 6 字 / `getPrompt()` = ~350 字
- KodaX `todo_create` registry description = ~700 字 / KodaX `todo_update` = ~1600 字
- Order of magnitude 差 **80-200×** 在 registry surface

这一层不分离的代价：
- token cost — 每个 turn 模型扫 registry 都付完整教学成本（即使该 turn 不调用 tool）
- cache fragmentation — registry desc 改一个字就破整 tool catalog 缓存 prefix
- attention dilution — 模型看到 700-1600 字的 description 时，会把"读完整 description"当成判断 tool relevance 的代理任务，影响真正的 task 推理
- coupling — schema 改动绑定 prompt 改动，两个独立 concerns 共用一根字符串

**实施方式**：
- 顶层 `description` 字段：1 句话 identity（"X tool — does Y"）
- 详细教学：移到 system prompt 或 capability section（按 role gate 注入，不是 always-on）
- schema field description：保持 schema-level（仅描述字段含义，不教使用 pattern）

**已有先例**：`fanOutPlanGranularity` (worker-role-prompt.ts:210-216, FEATURE_188 + claudecode 3-bullet swap) 是 ADR-033 §1-5 + §6 同时应用的首个 block——既 qualitative 又移除了 registry 层重复描述（教学全在 system prompt 段）。FEATURE_189 Phase B 按此模式扩展到 todo_create / todo_update / dispatch_child_task / 等。

### Implementation roadmap

**Phase 1 — v0.7.42（本 ADR 同 release window）**：

- ✅ **FEATURE_177 REVERT** — 删 worker-role-prompt.ts RULE D + env-flag gating + 5 个 FEATURE_177 unit test。Runtime `task_output` tool 不动（per pre-registered fallback action，SDK consumers 可继续程序化调用）。Eval 文件保留作为永久 regression sweep。
- 🚧 **dispatch_child prompt refactor (FEATURE TBD)** — 按本 ADR 5 条原则重写 `dispatchRules` 整段，准备 2-3 个 variant，在 FEATURE_177 复用 5-case eval 上验证：(a) C1/C2 positive 不退化；(b) C5 kimi RULE C write fan-out 恢复 ≥60%；(c) C3 NEG idle-yield ≥80%。Pre-register SHIP gate before panel run，pilot 1×1×1 first。

**Phase 2 — v0.7.43**：

- **Systemic prompt audit ([FEATURE_189](features/v0.7.43.md#feature_189-systemic-prompt-audit--anti-pattern-hygiene-sweep))** — grep + claudecode 对照 audit 所有 LLM-facing prompt（role prompts / capability sections / tool registry descriptions / classifier prompt / child briefing / protocol emitters）找出违反本 ADR **6 条原则**的所有 instance。**重点是 ✗ 反模式审查 + 工具描述分层**：
    - ✗ 反模式（§3）：per `feedback_prompt_strengthening_cross_case_regression` + claudecode-style panel C4 实测（18-line block 含密集 ✗ → plan-first 0/25 完全失效；3-bullet 无 ✗ → 4/25 plan-first + 5/25 dispatch）
    - 工具描述分层（§6）：tool registry `description` 字段从 700-1600 字塞所有教学的现状，重构为 claudecode-shape 的 3-8 字 identity + 详细教学按需注入（todo_create / todo_update / dispatch_child_task 等高频 tool 是首批 target）
- **逐 block 重写** — 按 audit 优先级 staged rollout，每个 sub-block 一个独立 commit + Layer 2 eval + 3-judge LLM audit + DATA VALID gate。
- **Audit catalog 量化基线**（2026-05-22 grep 实测，整 prompt 体系内）：
    - §1 quantitative threshold violations: ~19 instance（worker-role-prompt 5 + registry 7 + 其它）
    - §2 compound rules: ~6 instance
    - §3 ✗ 反模式: ~18 total, ~6 缺 WHY because-clause
    - §4 enumerated taxonomies: ~20+ instance（RULE A/B/C + todo_update (1)-(9) + todo_create (1)-(6) + todo_get (1)-(3) + system.ts 错误处理编号 list）
    - §5 version metadata in prompt body: ~25 string-literal occurrence
    - §6 registry description over-stuffed: todo_update 1600 字 / todo_create 700 字 / 等高频 tool（vs claudecode 6 字 + 350 字函数注入）

### Consequences

**正面**：
- FEATURE_177 panel 数据明确给出 KodaX prompt 失败模式的量化证据（C5 kimi -60pp）+ claudecode 对照参照（13× 词量差），后续 prompt 设计有可引用的标准 + 反例。
- 减少 prompt 维护负担——qualitative 措辞跨版本稳定，量化阈值 (≥3 / ≥45s) 容易因小幅调整破缓存或失效。
- Cross-case regression risk 降低——单 concept 单句 + WHY-bearing ✗ 让模型 reason about scope 而非泛化抑制。

**负面 / 风险**：
- 短期 dispatch 率可能下降——claudecode 风格更松，模型在该 dispatch 的边界场景里可能 "judge wrong, single-thread it"。需要 Phase 1 eval 验证 mmx/m27 等保守模型不会因为去掉量化触发条件而显著减少 dispatch。
- Per [`feedback_simplifying_prompt_can_regress`](../../memory/feedback_simplifying_prompt_can_regress.md)：简化 prompt 不是默认安全。"Prefer over X when Y" 比较从句看似冗余实际 load-bearing。Phase 1 重写每删一条 ✗ 或量化条件，必须 eval 验证未引入新退化。
- Phase 2 audit 范围大（5 role prompt × 多 segment），v0.7.43 时间可能不够完成全部 roll-out。可分多个 minor version 渐进。

### Alternatives considered

- **保留量化阈值但改 wording** — rejected. C5 kimi -60pp 直接证明量化阈值不是 wording-tunable；问题在哲学层，不在某条具体阈值的数字。
- **每 case 单独 wording iteration**（per FEATURE_177 panel #2 改 RULE D V2/V3）— rejected. 本质是 "在 over-prescription 框架内打补丁"，每补一处 cross-case regression 风险继续累积。User 直接指出问题在 systemic 层，不在 RULE D。
- **直接全量改写所有 prompt** — rejected. Phase 2 之前需要 Phase 1 数据先证明哲学切换确实在 dispatch_child 这条线上正向。一次性大改无法归因哪个 segment 的改动导致哪个 cross-case 变化。

### References

- 配套实施：FEATURE_177 REVERT commit + ADR-033 同 commit（atomic per [feedback_concurrent_thread_git_race](../../memory/feedback_concurrent_thread_git_race.md)）
- FEATURE_177 panel #2 dump：`c:/tmp/kodax-eval-dumps/feature-177-task-output/` (per [feedback_audit_dump_dir_vanishes](../../memory/feedback_audit_dump_dir_vanishes.md) `KODAX_EVAL_DUMP_DIR` override)
- 关键 memory：[`project_feature_177_task_output_shipped`](../../memory/project_feature_177_task_output_shipped.md)（panel 完整数据）、[`feedback_prompt_strengthening_cross_case_regression`](../../memory/feedback_prompt_strengthening_cross_case_regression.md)（✗ 反模式泛化抑制规律）、[`feedback_simplifying_prompt_can_regress`](../../memory/feedback_simplifying_prompt_can_regress.md)（简化非默认安全）、[`project_feature_175_shipped_with_eval_driven_revert`](../../memory/project_feature_175_shipped_with_eval_driven_revert.md)（eval-driven revert 先例）
- claudecode 对照文件：[`AgentTool/prompt.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/prompt.ts)（fork 哲学）、[`constants/prompts.ts:316-320`](file:///c:/Works/claudecode/src/constants/prompts.ts)（主 prompt agent-tool 段）、[`built-in/generalPurposeAgent.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/built-in/generalPurposeAgent.ts)（agent 内置 prompt）

---

## ADR-034: claudecode-Parity dispatch_child Architecture — Drop Forced Worktree + Prompt-Level Conflict Awareness (FEATURE_188, v0.7.42)

**Status**: Implemented 2026-05-22 (FEATURE_188 shipped in v0.7.42)
**Driver**: FEATURE_177 panel #2 dump 显示 dispatch_child eval cells 中 **0/250 real binding dispatches**（C4 read fan-out + C5 write fan-out 全部）。深入调查后发现 (a) 强制 worktree 在当前架构下的安全收益已经无支撑（FEATURE_184 删了 Evaluator role；`backups Map` 已提供 per-file restore），(b) claudecode 用 `isolation: 'worktree'` opt-in，**不**强制。用户决定：信任 LLM 检测冲突 + halt write，drop worktree 作为 default。
**Scope**: `dispatch_child_task` 工具 + `child-executor.ts` 执行分叉 + `worker-role-prompt.ts` dispatchRules 措辞。

### Context

KodaX 当前 `dispatch_child_task` 的 `readOnly: false` 路径强制创 git worktree（[`child-executor.ts:296`](../packages/coding/src/child-executor.ts#L296) `executeWriteChild` 第一步 `toolWorktreeCreate`），无 opt-out。该设计的三个原始支撑现在都不成立或可由其他机制替代：

1. **"Evaluator review at merge time" 已死**。FEATURE_184 (v0.7.42 已 ship，per [ADR-030](#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745)) 把 Evaluator-as-role state machine 整个删了，换成 Sidecar Verifier 读 tool-use summary + file edit refs，不读 worktree diff。"worktree 是 diff review 单元"这个 assumption 没有产品支撑了。

2. **"失败回滚需要 worktree"**：[`child-executor.ts:315`](../packages/coding/src/child-executor.ts#L315) write child 已经维护 `backups: Map`（per-file 写前 backup + 失败时 restore）。大部分实际场景是单 child 改 1-3 个文件，per-file backup 足够。worktree 只对 "child 跑了 50+ file edit 然后整体失败" 这种重场景有意义，pilot/panel 数据未见此使用模式。

3. **"并行 write 必冲突"**：dispatchRules 措辞本身要求 children 之间 `NON-conflicting file-level edits across multiple modules`——并行 children 编辑不同文件这一前提由 coordinator 在 dispatch 时保证，worktree 是 redundant 兜底。`bash` 工具也允许并发也没强制 worktree。真正会冲突的场景（两 child 改同一文件）应由 prompt 层校验 + child 检测后 halt，不是用 worktree 兜底。

**Pilot v3 数据**（2026-05-21 isolation test，20 calls ~$0.20）提供**无回归证据**：删 quant 后 kimi +1 cell aggregate intent rate (1/5 → 2/5)、ark/v4flash 持平 (1/5 → 1/5)，两 alias 都未触发预注册 "≥2 cell regression" 阈值。**注意**：pilot 测的是 intent rate（narrative tool-call mention 计数），real binding 在两 variant 均为 0/20——pilot 证明删 quant 不引入 narrative-FP 退化，**改善 real binding 的判定由 Step 11 re-eval 提供**，不靠 pilot 数据。

**claudecode 对照**（[`AgentTool.tsx:99`](file:///c:/Works/claudecode/src/tools/AgentTool/AgentTool.tsx#L99)）：
```typescript
isolation: z.enum(['worktree']).optional().describe(
  '"worktree" creates a temporary git worktree so the agent works
   on an isolated copy of the repo.'
)
```
**默认 NOT 创 worktree** —— Agent 跑在 parent cwd。[`EnterWorktreeTool/prompt.ts`](file:///c:/Works/claudecode/src/tools/EnterWorktreeTool/prompt.ts) 严格"ONLY when the user explicitly asks for a worktree"。

### Decision

**Drop forced worktree from `executeWriteChild`**。Write children 跑在 parent cwd，跟 read children 同 cwd 处理。差异仅保留：
- `excludeTools`：read 多排除 `write` `edit` `multi_edit` `insert_after_anchor` `undo`
- `systemPromptOverride`：read 用 bare `CHILD_AGENT_SYSTEM_PROMPT`；write 用 `buildWriteSystemPrompt(parentGitRoot)` 含 AGENTS.md mutation policy

**`readOnly` 参数保留** —— 它 gates write tools 可用性 + Scout role safety check（Scout + `readOnly:false` 仍硬阻断），跟 worktree 创建解耦。**Prompt body 不教 readOnly**——schema description 已经写 `'true=investigation only (default), false=code changes (Generator only)'`，prompt 不重复 schema。

**所有 children（read + write）的 briefing 加 conflict-awareness 段**——让 LLM 自己负责检测潜在并行冲突 + halt-and-report。

**worker-role-prompt.ts dispatchRules 改动**（per pilot v3 + worktree drop 后续连带）：
- 量化阈值定性化（pilot v3 验证）：`≥3 independent investigations` → `multiple independent investigations`；`≥45 seconds` → `a while`；`≥3 modules` → `multiple modules`
- 删 RULE C 里 `Worktrees are isolated; merge happens at Evaluator review time` 一句（worktree drop + Evaluator role 已死，两个事实都让这句变成 false statement）
- **保留**：RULE A/B/C labels + structure + Generator-equivalent gate + "Do NOT use write fan-out for single-file edits — coordination cost without speedup" ✗（带 WHY，满足 ADR-033 §3）+ IDLE-YIELD 段 + FEATURE_155 v0.7.39 注解（其它 FEATURE_xxx 注解 + RULE 枚举的整体 restyle 是 v0.7.43 独立 FEATURE，本 ADR 不动）

### Implementation outline（详细见 FEATURE_188 设计文档 [v0.7.42.md](features/v0.7.42.md#feature_188-dispatch_child-worktree-drop--conflict-awareness-prompt-hardening)）

| Step | 文件 | 改动 |
|---|---|---|
| 1 | `packages/coding/src/child-executor.ts` | `executeWriteChild` 删 `toolWorktreeCreate` + `wtPath` + `worktreePaths.set/delete` + `collectWorktreeDiff` + `artifactPaths`；executionCwd / gitRoot 用 parent 的；try/finally cleanup 删 |
| 2 | `packages/coding/src/task-engine/runner-driven.ts` + `packages/coding/src/task-engine/_internal/managed-task/dispatch-child.ts` + `packages/coding/src/task-engine/_internal/managed-task/payload-builder.ts` + `packages/coding/src/types.ts` | `childWriteWorktreePathsRef` / `registerChildWriteWorktrees` callback / `childWriteWorktreePaths` payload 字段 / `worktreePaths` ReadonlyMap 类型声明全删 — 4 处类型 + 4 处 plumbing 在 FEATURE_184 删 Evaluator 后已是 dead infrastructure，不删则 "代码净减" claim 不成立且留 false promise（payload 永远 undefined） |
| 3 | `packages/coding/src/child-executor.ts buildChildBriefing` | 加 "Coordination with peers" 段 **仅 write-children**；read children briefing 不加（read 子 agent 无 write op，"check before file modification" 语义空 + ~100 token/dispatch 浪费 + 可能 mis-fire halt） |
| 4 | `packages/coding/src/agents/worker-role-prompt.ts` | dispatchRules：3 处量化定性化 + 删 worktree-isolated 句 |
| 5 | `packages/coding/src/tools/dispatch-child-tasks.ts` | schema description for `readOnly` 微调（去掉 "(default)" 的歧义，写明语义；维持 schema 是 readOnly 教学唯一源） |
| 6 | `packages/coding/src/agent-runtime/__contract-tests__/cap-097-child-worktree.contract.test.ts` | 整文件删除（产品行为已变） |
| 7 | `cap-095-child-exec.contract.test.ts` + `cap-096-child-par.contract.test.ts` | CAP-095：更新 CAP-CHILD-EXEC-002 期望（write child 不再创 worktree）；**CAP-096**：`vi.mock('../../tools/worktree.js')` 的 `toolWorktreeCreate` / `toolWorktreeRemove` mock 删（FEATURE_188 后 path-under-test 不再调，留 silent mock 会让未来读者误判该路径仍创 worktree） |
| 8 | `packages/coding/src/child-executor.test.ts` | 更新 mocks + 期望（toolWorktreeCreate / toolWorktreeRemove 不再调） |
| 9 | 新单测 | child briefing 含 conflict-awareness 段（**仅 write path 验证含 "Coordination" 段；read path 验证不含**） |
| 10 | `CHANGELOG.md` | `v0.7.42 Breaking changes` 段：`dispatch_child_task` write-child 不再 auto-worktree；`KodaXManagedTaskResult.worktreePaths` 字段 + `evidence.artifacts[].worktree:${path}` 条目下线 |
| 11 | Layer 2 eval re-run | worktree-dropped + qualitative prompt 在 C4 + C5 + 5 alias × 5 runs 上不退化（intent rate ≥ baseline − 1 cell 每 alias × case；C5 严格 gate — write fan-out 是 worktree drop 行为核心信号） |

### Consequences

**正面**：
- **dispatch latency 下降** —— 每个 write child 节省 `git worktree add` + branch 创建 + 完成时 cleanup 三步 IO（典型 200-500ms）
- **代码净减** —— child-executor.ts `executeWriteChild` ~50 LoC 简化；CAP-097 test 整文件删；`worktreePaths` Map + cleanup try/finally 全部下线
- **架构与 ADR-030 一致** —— claudecode-shape main agent + opt-in（不是强制）worktree，跟 FEATURE_184 收口的 Sidecar Verifier 架构同向
- **降低模型 dispatch 心理门槛** —— 不需要内化 "worktree 开销值不值" 的判断；模型更倾向用 dispatch 作为并发原语
- **简化 child briefing** —— 不再有 "your worktree path is X, parent gitRoot is Y, translate paths..." 这段（v0.7.26 NEW-2 加的 path 教学是为 worktree 准备的）

**负面 / 风险**：
- **真实冲突场景**（两 child 编辑同一文件）由 prompt 层 + 子 agent 自检兜底，不再有 file-system 隔离托底。Mitigation：
  - Coordinator dispatchRules 明示 `NON-conflicting file-level edits across multiple modules` 由 dispatcher 保证
  - Child briefing 新 "Coordination with peers" 段：写之前检查 peer scope overlap，不确定就 halt
  - `backups: Map` per-file restore 仍 active —— 单文件错改可回滚
- **artifactPaths `worktree:${wtPath}` 字段下线** —— SDK consumer 如有依赖会 break。**评估**：该字段未在 KodaX SDK doc 出现，gh 仓库 grep 无外部引用；视为内部 API。**Action**：CHANGELOG `Breaking changes` 段写明
- **"big-bang refactor" 单 child 多文件改失败时 rollback 粒度**：`backups: Map` 是 per-file，失败时按文件 restore；如果 child 跑了 30 个 file edit 中间崩了，restore 是 file-level not transaction-level。**评估**：worktree 之前也不是事务性（worktree 失败时 parent diff 还是要手工 review），这条不退化。

**Tool registry retention**：`toolWorktreeCreate` / `toolWorktreeRemove`（`packages/coding/src/tools/worktree.ts` + `tools/registry.ts:833/862`）**不删** — 它们继续服务 user-explicit `EnterWorktreeTool` / `ExitWorktreeTool` 工作流。FEATURE_188 只删 dispatch_child 自动创 worktree 路径，不删工具本身可用性（claudecode 同结构：工具存在但默认不自动调）。

### Alternatives considered

- **Opt-in worktree（claudecode style，加 `isolation: 'worktree'` 参数）** — rejected. 用户明确指示走 prompt-level 协调（用户在以前的项目里实测有效）。加参数会让 LLM 多一个 "should I worktree?" 决策面，pilot v3 已经显示模型对 worktree 暗示的反应是降低 dispatch 倾向，多一个 explicit toggle 是把这个 friction 反向放大。
- **保留 worktree，只删量化阈值** — rejected. Pilot v3 只验证了量化可删；worktree 的产品支撑（Evaluator review at merge）已经在 FEATURE_184 被删，留着是 dead-path code + 错误 mental model 给开发者。半改方案让既有 worktree code 长期 dead 在 codebase 里。
- **完整 claudecode-style restyle（RULE A/B/C labels / ✗ catalogue / FEATURE_xxx 注解全部清理）** — deferred. Pilot v3 只 isolate 验证了量化阈值这一个变量，**没有**验证 RULE 枚举或 ✗ 措辞或 FEATURE 注解是否影响信号。整体 restyle 需独立 v0.7.43 FEATURE 重新设计 + eval 验证 + ship。本 FEATURE_188 严格限定 scope 是 worktree drop + 量化阈值删 + worktree 句删。

### References

- 配套实施：FEATURE_188 实施 commits（待定，会按 [feedback_concurrent_thread_git_race](../../memory/feedback_concurrent_thread_git_race.md) 原则 atomic add+commit）
- FEATURE_177 panel #2 dump：`c:/tmp/kodax-eval-dumps/feature-177-task-output/`（0/250 real dispatch 证据）
- Pilot v3 dump：`c:/tmp/kodax-eval-dumps/feature-dispatch-prompt-pilot/pilot-v3-quantitative-threshold-isolation.json`（量化非 load-bearing 证据）
- [ADR-030](#adr-030-claudecode-shape-main-agent--sidecar-verifier-substrate-feature_184-v0745)（Evaluator role REVERT，本 ADR 的前置依赖）
- [ADR-033](#adr-033-claudecode-style-prompt-design-principles--qualitative-criteria-over-quantitative-rules-v0742-v0743)（prompt design principles，本 ADR 是其架构落地的第一个 FEATURE）
- 关键 memory：[`project_feature_177_task_output_shipped`](../../memory/project_feature_177_task_output_shipped.md) / [`project_feature_184_shipped`](../../memory/project_feature_184_shipped.md) / [`feedback_simplifying_prompt_can_regress`](../../memory/feedback_simplifying_prompt_can_regress.md)（pilot v3 验证为何是必要步骤而非可跳过）/ [`feedback_eval_pilot_before_scale`](../../memory/feedback_eval_pilot_before_scale.md)（pilot v3 探索期为何 1-alias 起步）
- claudecode 对照：[`AgentTool.tsx:99`](file:///c:/Works/claudecode/src/tools/AgentTool/AgentTool.tsx#L99)（isolation opt-in 参数）、[`EnterWorktreeTool/prompt.ts`](file:///c:/Works/claudecode/src/tools/EnterWorktreeTool/prompt.ts)（独立 explicit tool）

---

## ADR-035: User-Authored Custom Agents — Markdown Loader + Extension `registerAgent` + `dispatch_child_task` Bridge (FEATURE_191, v0.7.43)

**Status**: Planned 2026-05-23
**Driver**: KodaX 已具备 LLM-driven agent generation 全栈（FEATURE_087 ConstructionRuntime / FEATURE_088 Tool Generation / FEATURE_089 Agent Generation / FEATURE_101 Admission Contract，shipped v0.7.28-31，code 在 [`packages/coding/src/construction/`](../packages/coding/src/construction/)），但 (a) Worker 不能通过 `dispatch_child_task` 派遣已注册的 specialist agent；(b) 用户无法手写 markdown 文件直接定义 agent（必须走 LLM `scaffold_agent` 或 CLI `kodax constructed admit`）；(c) extension package 无 `registerAgent` API 贡献 agent。三条 gap 同根（dispatch + 数据入口），合并为一个 feature 一次性闭环。原 FEATURE_128（v0.7.50 placeholder）仅覆盖 dispatch 桥，scope 不足以闭环，由本 feature **superseded**。
**Scope**: `dispatch_child_task` schema + `child-executor.ts` 路由分支 + `worker-role-prompt.ts` specialist-routing 段；新增 `packages/coding/src/construction/markdown-loader.ts` + `loadAgentsAtBootstrap` boot hook；`packages/coding/src/extensions/types.ts` `KodaXExtensionAPI` + `runtime.ts` `registerAgent` 实现。

### Context

#### KodaX 既有自定义 agent 能力（已 shipped，常被低估）

| 能力 | 入口 | Path | 状态 |
|---|---|---|---|
| LLM-driven agent generation | Worker 调 `scaffold_agent` 工具 | manifest JSON → `Runner.admit` 5-step → `registerConstructedAgent` | ✅ v0.7.31 ship |
| Constructed agent registry | `resolveConstructedAgent(name)` / `listConstructedAgents()` | module-singleton Map | ✅ v0.7.31 ship（[`agent-resolver.ts`](../packages/coding/src/construction/agent-resolver.ts)） |
| Admission Contract（7 invariant） | `Runner.admit` 5-step pipeline | schema / invariant.admit / tool subset / budget clamp / handoff DAG | ✅ v0.7.31 ship |
| CLI explicit invocation | `kodax constructed admit --manifest <file>` | manifest JSON → admission → register | ✅ v0.7.28 ship |
| Self-modify role spec | Agent 改自己 instructions / reasoning / handoff | 同 admission 通道（versioned + rollback） | ✅ v0.7.32 ship |

#### 缺失的三条 gap

1. **dispatch 桥**：[`dispatch_child_task` schema](../packages/coding/src/tools/dispatch-child-tasks.ts) 无 `subagent_type` 字段。Worker 拿到 SQL review / E2E test 任务时只能 (a) 自己做；(b) 派 anonymous child + prompt 里手写 "扮演 db-reviewer"——丢了 specialist agent 的精炼 prompt + admission 验证。Worker system prompt 也不知道 registry 里有哪些 specialist。
2. **Markdown 入口**：[claudecode `loadAgentsDir.ts:541`](file:///c:/Works/claudecode/src/tools/AgentTool/loadAgentsDir.ts#L541) 用 markdown + YAML frontmatter 让用户**手写** `~/.claude/agents/<name>.md` 即生效。KodaX 只有 JSON manifest + CLI admit 路径——markdown 是更 LLM-friendly 也更 user-friendly 的格式（FEATURE_124 本版本 memory 系统也已选 markdown 路线），单一缺口。
3. **Extension API 入口**：[`KodaXExtensionAPI`](../packages/coding/src/extensions/types.ts) 提供 `registerTool` / `registerCommand` / `registerModelProvider` / `registerCapabilityProvider` / `registerSkillPath`，**唯独缺 `registerAgent`**。npm extension 想贡献 agent 必须自己调 `kodax constructed admit` CLI 或绕开 admission——分裂数据流。

#### claudecode 调研对照

[`loadAgentsDir.ts:296`](file:///c:/Works/claudecode/src/tools/AgentTool/loadAgentsDir.ts#L296) `getAgentDefinitionsWithOverrides(cwd)` 单一数据流：扫四个源（user / project / flag / policy）→ markdown frontmatter parse → 合并内置 + plugin agents → `getActiveAgentsFromList` 同名优先级覆盖（built-in < plugin < user < project < flag < policy）。Frontmatter 字段：`name` / `description` / `tools` / `disallowedTools` / `model` / `permissionMode` / `maxTurns` / `mcpServers` / `hooks` / `skills` / `memory` / `isolation`。运行时通过 `Task({subagent_type:"name"})` 派遣，[`runAgent.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/runAgent.ts) 为子 agent fork 独立 `query()` 循环 + MCP + transcript。

### Decision

**重用既有 Construction substrate，加三层薄 adapter 一次性闭环**：

| Phase | 改动 | 数据流终点 | 字数 |
|---|---|---|---|
| **A**：dispatch 桥 | `dispatch_child_task` schema 加 `subagent_type?: string`；`KodaXChildContextBundle` 加 `specialistName?: string` 字段；`dispatch-child-tasks.ts toolDispatchChildTask` 内调 `resolveConstructedAgent(name)` 拿 `Agent \| undefined`，unknown-name 返 tool-result error 不 throw；`executeReadChild`/`executeWriteChild` 内 inline 切换 `systemPromptOverride` 用 specialist `.instructions` + 用**互补排除**计算 `excludeTools = allTools - specialistAgent.tools`（不引入新 includeOnlyTools API）；`prompts/capability-sections.ts::buildCapabilityContextSections` 注入 conditional `specialist-agents` 段 | 既有 `registerConstructedAgent` registry | ~180 LoC + 8-10 测试 |
| **B**：Markdown loader | 新增 `packages/coding/src/construction/markdown-loader.ts` 扫 `${getAgentConfigHome()}/agents/*.md` + `${cwd}/.kodax/agents/*.md`，用 **`@kodax-ai/skills/shared/yaml::parseYamlFrontmatter`**（**不**用 gray-matter — repo 无此 dep）解析；映射到 `AgentContent` 后调 `buildAdmissionManifest({name, content}) → Runner.admit` （**注意**：`AgentManifest` 是 flat `Agent & {extras}` 不是 `{kind, name, content}` 包装形）→ `registerConstructedAgent(artifact, registration)` 带 invariant `registration` 第二参数（单参调用走 trusted-agent 路径会跳过 invariant 绑定）；bootstrap hook 落 `packages/repl/src/common/construction-bootstrap.ts` 与既有 `bootstrapConstructionRuntime` 并列（**不**落 `packages/coding/src/agent.ts` — 该文件是 thin shell 无 boot lifecycle） | 同 A 终点 | ~180 LoC + 10-14 测试 |
| **C**：Extension `registerAgent` | `KodaXExtensionAPI` 加 `registerAgent: (name: string, content: AgentContent) => () => void`（**接收 `AgentContent` 不是 raw `AgentManifest`**，runtime 内部统一调 `buildAdmissionManifest` 适配）；`runtime.ts` 实现走同一 `Runner.admit` + invariant registration → register + push 入 `LoadedExtensionRecord.disposables`；source tag `'extension'` 落 **in-memory `ConstructedAgentRegistration`** 字段（不动 on-disk `AgentArtifact` schema） | 同 A 终点 | ~70 LoC + 4-6 测试 |

**三条入口的统一保证**：A 消费的 registry **是** B/C/CLI/FEATURE_089 共用的，admission gate 是同一个，不分裂。

**Source-tag precedence 显式声明**：`agent-resolver.ts:339` 当前是 **last-write-wins**（无 precedence stack）。本 feature 用**加载顺序纪律**实现 precedence：boot 时按 `built-in → extension → markdown:user → markdown:project → constructed:cli → constructed:llm` 顺序 register，后写覆盖前。不引入新 precedence 检测 infra（YAGNI；3+ 真实冲突场景后再考虑）。

**新增字段 scope 一次性声明**（不分版本）：
- `AgentContent.description?: string` — frontmatter `description` 字段落点 + Phase A.3 SP block 数据源（当前 `AgentContent` / `Agent` / `AgentManifest` **无任何 description 字段**）
- `KodaXChildContextBundle.specialistName?: string` — specialist 名透传载体（当前 `types.ts:689` 无此字段）
- `ConstructedAgentRegistration.source?: 'built-in' \| 'extension' \| 'markdown:user' \| 'markdown:project' \| 'constructed:cli' \| 'constructed:llm'` — in-memory source tag
- `ChildProgressSnapshot.specialistName?` + dispatch-trace payload `specialistName?` — 诊断字段（FEATURE_177 + writeDispatchTraceIfEnabled 同步加）

### Why not alternatives

- **方案 X — 新建独立 user-agent 系统（绕开 Construction）**：rejected。会引入第二套 admission gate 或裸奔（claudecode 是裸奔，KodaX threat model 不接受）；同时违反 [ADR-021](#adr-021-agent-framework-boundary) 的多原语合并原则。Construction 已经为本场景准备好了：manifest JSON + admission 5-step。
- **方案 Y — 仅 ship Phase A（沿用 FEATURE_128 v0.7.50 scope）**：rejected。LLM-driven generation（必须 model 在 session 内写 manifest）+ CLI admit（必须出 session 命令行）两条入口对"用户给 agent 写一个 5 行 markdown" 的 ergonomic 都很差。markdown loader 是 user-onboarding 的 keystone，跟 dispatch 桥同周期 ship 才闭环可用。
- **方案 Z — 用 claudecode style markdown 直接 register（不走 admission）**：rejected。markdown frontmatter 是用户/extension 提供的不可信声明，绕过 admission 等于把 FEATURE_101 的 7 invariant 投资作废。markdown → manifest → admission 三步是必经路径。
- **方案 W — Phase A+B+C 跨多版本拆分**：rejected。三条入口的 wire point 完全重叠（registry + dispatch），分版本 ship 会造成 ABI 抖动（v0.7.43 ship A → 用户用 dispatch 但拿不到 specialist；v0.7.44 ship B → 用户开始写 markdown 但发现 dispatch 早就在了等他）。一版闭环。

### Implementation outline

**预设**：以下 step 实际行号引用基于 4-agent audit (2026-05-23) verify 的当前代码状态。

| Step | 文件 | 改动 |
|---|---|---|
| **A.0** （prereq） | `packages/coding/src/types.ts:689` | `KodaXChildContextBundle` 加 `specialistName?: string` 字段。**整个 Phase A 的载体类型基础，必须先落**（无此字段 specialist name 无法从 `toolDispatchChildTask` → `executeChildAgents` → `runFanOut` → `executeReadChild/executeWriteChild` 透传） |
| **A.0b** （prereq） | `packages/agent/src/admission/admission.ts` (`AgentContent`) | 加 `description?: string` 字段。frontmatter `description` 数据源 + Phase A.3 SP block 数据源（当前 `AgentContent` / `Agent` / `AgentManifest` 三处皆无此字段） |
| A.1 | `packages/coding/src/tools/registry.ts:498-530` (BUILTIN_TOOL_DEFINITIONS dispatch_child_task entry) | schema 加 `subagent_type?: z.string().optional()` + description 单 sentence qualitative (ADR-033 §1)：`'When the task matches a registered specialist (use list_agents to discover), dispatch as that specialist.'` |
| A.2 | `packages/coding/src/tools/dispatch-child-tasks.ts` (`toolDispatchChildTask` 处理函数，bundle 构建处 line 431-444) | (1) 从 tool input 读 `subagent_type` 放到 `bundle.specialistName`；(2) **unknown-name guard 在这里**（不在 child-executor）：若 `subagent_type` 提供 → 调 `resolveConstructedAgent(name)` 返 `Agent \| undefined`，undefined 时返 tool-result error 不 throw，含 `Available: ${listConstructedAgents().map(a => a.name).join(', ')}` 让 Worker 自纠错 |
| A.2b | `packages/coding/src/child-executor.ts` (`executeReadChild:240` + `executeWriteChild:317`，**`buildChildBundle` 函数不存在**) | inline 切换 `systemPromptOverride`：`bundle.specialistName` 提供 → 用 `resolveConstructedAgent(name).instructions`（resolver 返 `Agent \| undefined`，no 结构化 error 对象）；否则用 `CHILD_AGENT_SYSTEM_PROMPT`/`buildWriteSystemPrompt` 默认；同时计算**互补排除** `excludeTools = listAllTools() - specialistAgent.tools`（KodaXOptions.context 只有 `excludeTools` exclusion-only API，无 `includeOnlyTools`） |
| A.2c | `packages/coding/src/child-executor.ts:723` `validateWriteBundles` gate | **审查 + 补丁**：现 gate 仅允许 `parentRole=worker\|generator` 在 `H2_PLAN_EXECUTE_EVAL\|tool-dispatch` harness 派 write child。specialist write child 必须经此 gate 不被静默 drop —— 若 specialist 是 readOnly:false 但 parent role 不匹配现行白名单，需扩 gate 或显式拒绝（不能 silent drop） |
| A.2d | `packages/coding/src/child-progress-snapshot.ts` (FEATURE_177 ChildProgressSnapshot) + `dispatch-child-tasks.ts:283-370 writeDispatchTraceIfEnabled` | 都加 `specialistName?` 字段。`task_output` ring buffer 和 dispatch trace dump 才能保留 specialist context 用于事后诊断 |
| A.3 | `packages/coding/src/prompts/capability-sections.ts::buildCapabilityContextSections` (line ~85，13 段中 conditional-include 模式与 `mcp-capability-context` / `repo-intelligence-context` 同) | 加 conditional `specialist-agents` 段：`listConstructedAgents()` 为空 → 不注入；非空 → 注入 `=== Available specialist agents ===\n- ${a.name}: ${a.description ?? '(no description)'}\n...\nDispatch via dispatch_child_task(subagent_type="<name>").` |
| A.4 | `packages/coding/src/agents/worker-role-prompt.ts:137-138` (dispatchRules 数组末尾，line 138 `].join('\n')` 之前) | append **1 句** qualitative specialist-routing 指导（per ADR-033 §1+§3+§4+§5：不枚举 agent 名，不加 ✗，不加 FEATURE_xxx 注解）。**并发态势**：dispatchRules 当前**净空**（F189 B.1/B.2/B.3/B.5/B.6 均未触此块；F189 B.4 `52b08ada` 已 ship 仅改 line 125 LARGE CHILD OUTPUT 字面；F190 Phase 2a `5fa1c362` 已 ship 改 lines 1-28/55-57/223-228 不在 dispatchRules）—— append at line 137-138 之间**零冲突**。**保险动作**：实施前 `git fetch && git status` 再次确认 |
| B.1 | `packages/coding/src/construction/markdown-loader.ts` 新增 | 用 `parseYamlFrontmatter` from **`@kodax-ai/skills/shared/yaml`**（**不**用 gray-matter — repo 0 hits）；frontmatter `{name, description, tools, model}` + body → `AgentContent`（**不是**直接 AgentManifest）；扫两 dir（顺序：先 user 再 project，后者覆盖前者）；映射 `tools:["read","grep"]` → `ToolRef[]` 即 `[{ref:'builtin:read'}, {ref:'builtin:grep'}]`（`packages/coding/src/construction/types.ts:86 ToolRef` 是 `{ref:string}` schema-prefixed） |
| B.2 | `packages/repl/src/common/construction-bootstrap.ts` (与 `bootstrapConstructionRuntime` 并列) | 启动期单次调用 `loadAgentsFromMarkdown()`；每 file 走 `buildAdmissionManifest({name, content}) → Runner.admit(manifest)`（**`AgentManifest` 是 flat `Agent & {extras}` 不是 `{kind, name, content}` 包装形 — `packages/agent/src/admission/admission.ts:52` —— 必须先经 admission-bridge 转换**） → pass 即 `registerConstructedAgent(artifact, registration)` **带 invariant `registration` 第二参数**（不要单参 — 单参走 trusted-agent 路径会跳过 observe/assertTerminal hooks 让 invariant 强制静默失效）；fail 进 `{path, reason}[]` 数组返回（**模仿 claudecode `getAgentDefinitionsWithOverrides` `failedFiles` 返回模式**；当前 `rehydrateActiveArtifacts` 只返 `{loaded, failed, tampered}` count，本 feature 需 per-failure 详情） |
| B.3 | `packages/coding/src/construction/markdown-loader.test.ts` | happy path + missing `name` 字段（静默跳过，模仿 claudecode）+ missing `description` 字段（进 failed[]）+ admission fail + 同名冲突（project > user 由加载顺序保证）+ 非 .md 文件忽略 + frontmatter `tools` 引用未注册 builtin（admission `toolCapabilitySubset` invariant 拦截）。`beforeEach`/`afterEach` 调 `_resetAgentResolverForTesting()` (`agent-resolver.ts:138`) |
| B.4 | `packages/coding/src/construction/agent-resolver.ts` | `ConstructedAgentRegistration` 加 `source?: 'built-in' \| 'extension' \| 'markdown:user' \| 'markdown:project' \| 'constructed:cli' \| 'constructed:llm'` 字段（**in-memory only，不动 on-disk `AgentArtifact` schema**）。`registerConstructedAgent` 调用方按上述 enum 标 source；`listConstructedAgents` 投影暴露 source（`/agents list --by-source` 等后续 UI 消费） |
| C.1 | `packages/coding/src/extensions/types.ts:425` (`KodaXExtensionAPI`) | 加 `registerAgent: (name: string, content: AgentContent) => () => void`（**接收 `AgentContent` 不是 raw `AgentManifest`**，runtime 内部统一调 `buildAdmissionManifest`） |
| C.2 | `packages/coding/src/extensions/runtime.ts` | 实现 `registerAgent` 走 `buildAdmissionManifest({name, content}) → Runner.admit → registerConstructedAgent` (source='extension')；unregister fn 推入 `LoadedExtensionRecord.disposables` (per `runtime.ts:285` 既有 `disposables: Disposable[]` pattern with reverse-iterate dispose) |
| C.3 | `packages/coding/src/extensions/runtime.test.ts` | extension activate → registerAgent → resolve 拿到 + source='extension' → extension deactivate → resolve 拿不到 |
| 4 | `tests/feature-191-dispatch-specialist-pilot.eval.ts` + `tests/feature-191-dispatch-specialist-panel.eval.ts` + `tests/feature-191-dispatch-specialist-judge-audit.eval.ts` 三 driver | **驱动可与 Phase A/B/C 并行落 code**，**但跑 panel/audit 必须等 A.1 schema field 上 prod**（否则 binding capture 永远 0 by construction not by model）。Panel: 5 alias × 4 case × 5 run = 100 cells。Pilot: 1×1×1 `ark/v4flash`。3-judge audit 用 `tests/feature-188-worktree-drop-judge-audit.eval.ts:44` 同模板（judges = `['zhipu/glm51','ark/v4pro','kimi']` + `majorityVote()` 2/3）。aliasFallback `{'ark/v4flash':'ds/v4flash','ark/v4pro':'ds/v4pro'}` (`harness.ts:393` quota-err triggered)。**dump dir 双 mkdirSync** at test-suite start + 每次 writeFileSync 前（per `feedback_audit_dump_dir_vanishes` Windows tmpdir wipe 防御）。每 case mock registry 在 `beforeEach`/`afterEach` 调 `_resetAgentResolverForTesting()` |
| 4b | 同上 driver 内的 SHIP gate | Pre-registered: (a) C1 specialist matches dispatch rate ≥60% per alias; (b) C3 false-name dispatch rate ≤10% per alias; (c) C4 multi-specialist fan-out ≥50% per alias; (d) audit disagreement <10% per EVAL_GUIDELINES; (e) 4-of-5 alias 满足 (a)+(b)+(c)（kimi floor 单 alias DEFER 不阻 SHIP per [[feedback_model_structural_floor_not_prompt_tunable]]） |
| 5 | `docs/test-guides/FEATURE_191_v0.7.43_TEST_GUIDE.md` | 手测：用户写 `~/.kodax/agents/db-reviewer.md` → REPL 启动 → 任务 "review this migration" → 观察 Worker 派 specialist + child 使用 db-reviewer prompt |
| 6 | `CHANGELOG.md` v0.7.43 | "User-defined agents: drop `~/.kodax/agents/<name>.md` or use `api.registerAgent(name, content)` in extension; Worker auto-dispatches matching specialist via `dispatch_child_task(subagent_type=...)`. New fields: `AgentContent.description?`, `KodaXChildContextBundle.specialistName?`, `ConstructedAgentRegistration.source?`" |
| 7 | `docs/SDK_EMBEDDER_GUIDE.md` | 加 `loadAgentsFromMarkdown` + `registerAgent` 到 surface 表 |
| 8 | 影响测试更新 | (a) `cap-095-child-exec.contract.test.ts:107-108` `systemPromptOverride` 含 `'focused sub-agent'` 断言加 default-path guard; (b) `child-executor.test.ts:427-577` 多处 verbatim 断言加 specialist 分支变体; (c) `cap-097-child-worktree.contract.test.ts` 已在 FEATURE_188 删 — 不动 |

### Consequences

**正面**：
- **用户 5 分钟自定义专家** —— `vim ~/.kodax/agents/python-reviewer.md` 即生效，对齐 claudecode UX。
- **三条入口统一 admission** —— LLM-driven (F089) / markdown (B) / extension (C) / CLI（既有）走同一 `Runner.admit`，threat model 不分裂。
- **dispatch 可见性** —— Worker 看到 registry 后能自决何时调用 specialist，避免 "派 anonymous + prompt 里手写扮演 X" 的 prompt-pollution anti-pattern。
- **激活既有投资** —— FEATURE_087/088/089/101 ship 后用户实际使用率很低（无 dispatch 路径），本 feature 把"投入未变现"的 path 接通。

**负面 / 风险**：
- **worker-role-prompt.ts 并发态势（澄清，原评估过紧）** —— 2026-05-23 验证：dispatchRules 块（lines 119-138）当前**净空**。F189 B.1 (`557c29a4`)/ B.2 (`47a8101b`) 改 tool descriptions，**不**碰 worker-role-prompt.ts；F189 B.4 (`52b08ada`) 已 ship 仅改 dispatchRules 内 line 125 单 bullet 字面（LARGE CHILD OUTPUT）；F190 Phase 2a (`5fa1c362`) 已 ship 改 lines 1-28 / 55-57 / 223-228（handoffRules，**不在 dispatchRules**）。Phase A.4 append at line 137-138 之间**零冲突**。保险动作：实施前 `git fetch && git status` 再次确认。
- **markdown frontmatter 字段映射** v0.7.43 只 wire `name` / `description` / `tools` / `model` / `instructions`（body）。其它（mcpServers / hooks / memory / isolation / permissionMode / maxTurns / skills）**忽略 + 不报错**（前向兼容）。
- **`description` field 是新 schema 字段** —— 当前 `AgentContent` / `Agent` / `AgentManifest` 三处皆无任何 description 字段；A.0b 加 `AgentContent.description?: string`。**回归边界**：FEATURE_089 已存的 constructed agents 无 description，A.3 SP block 渲染 `(no description)` fallback，不要 throw。
- **`validateWriteBundles` parentRole gate 隐性 drop 风险** —— `child-executor.ts:723` 现 gate 按 `parentRole=worker\|generator` × `harness=H2_PLAN_EXECUTE_EVAL\|tool-dispatch` 过滤，若 specialist 是 `readOnly:false` 但 dispatching role 不在白名单会**静默 drop bundle**。A.2c 必须显式审 + 决定（扩 gate 或显式拒绝带 reason，**不能 silent drop**）。
- **Layer 2 eval 风险**：specialist routing 是新行为，floor model（kimi / ark/v4flash）可能在 C1 "应派 specialist" 场景下不识别 SP 注入的 registry block。**Mitigation**：pilot 先验，PARTIAL 走 prompt iteration；floor model `≥3 wordings × ≥5 runs each` 全 0 PASS 则按 [[feedback_model_structural_floor_not_prompt_tunable]] DEFER per-alias 不强求。
- **Eval sequencing 硬约束** —— Phase 4 driver 可与 Phase A/B/C 并行**写**，**跑** panel/audit 必须等 A.1 schema field 上 prod，否则 binding capture 永远 0 by construction not by model（同步性约束写入 acceptance）。
- **registry 空 vs 满 prompt 不一致**——空时不注入 block，满时注入。模型 SP 字符串变化 = prompt cache miss。**评估**：multi-user 通常一致（用户要么没 agent 要么有 ≥1 个），切换边界出现率低，TTFB 影响可接受。
- **dispatchRules anchor density** —— per F189 B.5 DEFER 教训，dispatchRules 是 mid-tier model（zhipu/glm51 + ark/v4pro）attention anchor。A.4 新句必须**末尾 append**，**不**插入数组中段，**不**重排既有 bullet。

**Tool registry retention**：CLI `kodax constructed admit` + Worker `scaffold_agent` 工具**保留不动**——markdown 是新增 ergonomic path，不是替换。三条 user-facing 入口共存，admission 单一。

### Alternatives considered

- **`/agents` slash UI（REPL 编辑器 / wizard）** — defer to v0.7.46+。markdown 文件 + 用户外部编辑器（VS Code / vim）足以闭环 Phase B；REPL 内 UI 是 UX 加分项，本 feature 不强求。
- **frontmatter 全字段映射（hooks / mcpServers / memory）** — defer。每个字段需要独立产品决策（KodaX hooks 走 FEATURE_063 absorbed extension hooks；mcpServers 走 FEATURE_065 协议成熟度路径；memory 走 v0.7.43 FEATURE_124）；本 feature scope 严格限 5 字段，避免堆耦合。
- **dispatch-time re-admit**（v0.7.50 FEATURE_128 原设计 Step 6）— defer。Boot-time admit 已经过 5-step gate；dispatch 时再跑一次的安全收益（防 manifest tampering）边际，性能开销线性增长。先 ship 不带 re-admit，生产数据证明需要再加。

### References

- 配套实施：FEATURE_191 设计文档 [v0.7.43.md](features/v0.7.43.md#feature_191-user-authored-custom-agents)
- 前置：FEATURE_087-090（Self-Construction staircase）/ FEATURE_101（Admission Contract）/ FEATURE_124（v0.7.43 memory markdown 路径同形）
- Supersedes：原 v0.7.50 FEATURE_128 dispatch-only placeholder
- claudecode 对照：[`loadAgentsDir.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/loadAgentsDir.ts)（markdown 加载 + 优先级合并）/ [`builtInAgents.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/builtInAgents.ts)（内置 + plugin + custom 合并）/ [`runAgent.ts`](file:///c:/Works/claudecode/src/tools/AgentTool/runAgent.ts)（dispatch 时 fork 子 query 循环）
- 关键 memory：[`feedback_selective_hunk_staging`](../../memory/feedback_selective_hunk_staging.md)（A.4 worker-role-prompt.ts 并发管控）/ [`feedback_concurrent_thread_git_race`](../../memory/feedback_concurrent_thread_git_race.md)（atomic add+commit）/ [`feedback_eval_pilot_before_scale`](../../memory/feedback_eval_pilot_before_scale.md)（Phase 4 eval 先 1×1×1 pilot）/ [`feedback_model_structural_floor_not_prompt_tunable`](../../memory/feedback_model_structural_floor_not_prompt_tunable.md)（floor model PARTIAL DEFER 策略）
- [ADR-021](#adr-021-agent-framework-boundary)（数据原语 home，markdown-loader 落 coding 还是 agent 的 trade-off）
- [ADR-033](#adr-033-claudecode-style-prompt-design-principles--qualitative-criteria-over-quantitative-rules-v0742-v0743)（A.3/A.4 prompt 段必须 qualitative 单 sentence，不枚举 agent 名，不加 ✗）

---

## ADR-036: Package Consolidation — Inline 5 Single-Consumer Subpackages into agent / coding (FEATURE_194, v0.7.43)

**Status**: ✅ Accepted + Shipped 2026-05-24 — 9 commits atomic ship (`b7235f0e → ced8a30d → 801eeae5 → c1301898 → 1fb0433a → 7523a5c0 → 324779b4 → 3bb70d1e → 本 commit`). 9 → 4 workspace packages 目标达成。5-gate per commit 全 PASS / net regression = 0 / $0 eval. See [docs/features/v0.7.43.md#feature_194-package-consolidation](features/v0.7.43.md#feature_194-package-consolidation--inline-5-single-consumer-subpackages--9--4-workspace-packages) for ship commit table + evidence.
**Driver**: KodaX 9 包 monorepo 实测 ~132k LoC（之前 framing "70k" 是 `find ... | xargs wc -l` 在 Windows 路径下的 measurement bug，真实 coding=66k 不是 4.7k）。**KodaX 不是代码更少，是投入更多能力（construction / repo-intelligence / task-engine / multi-tier middleware）但同时把包结构碎切**。9 包里 5 个明显过度切分（grep 实测全 0 外部 npm consumer，违反 CLAUDE.md YAGNI "3+ use cases" 标准），且 `@kodax-ai/session-lineage` 还存在 latent bug（agent 4 文件 import 它但 agent/package.json 没声明 dep，monorepo workspace 下靠 tsconfig path 工作，发布 npm 会断）。包合并目的不是"减代码"，而是减包数对应的 carrying cost：10 → 4 包发布 cycle / 9 → 4 build graph 节点 / 84 处 cross-pkg import 收敛到内部 relative path / IDE jump-to-source 顺畅。

**Decision**:

将 5 个 single-consumer 子包内联到 agent 或 coding：

| 子包 | 目标位置 | 内联理由 |
|---|---|---|
| `@kodax-ai/mcp` (2.7k) | `agent/src/capabilities/mcp/` | single-consumer (coding+repl+root src)，已 depend on agent + llm |
| `@kodax-ai/skills` (2.5k) | `agent/src/capabilities/skills/` | single ecosystem (coding+repl)，无非-agent 复用场景 |
| `@kodax-ai/tracing` (0.8k) | `agent/src/tracing/` | **agent self-merge** — agent 本就 depend tracing |
| `@kodax-ai/session-lineage` (5.6k) | `agent/src/session-lineage/` | **包描述自认 agent 子系统**，v0.7.35.1 是 deliberate split from agent，**修复 latent dep bug** |
| `@kodax-ai/repointel-protocol` (0.07k) | `coding/src/repo-intelligence/protocol.ts` | 69 LoC type-only contract，0 外部消费者，未来 30 分钟可 re-extract |

目标结构 **4 包**（对齐 pi 4 包数量）：

```
packages/
├── llm/        # 7.3k — LLM provider 抽象 (16 built-in aliases + stream 协议 + model registry)
├── agent/      # ~20.8k — Agent 框架 + capabilities + tracing + session-lineage
│   └── src/
│       ├── primitives/             # 现有：Agent / Runner / Handoff / Guardrail / Admission / Messaging / Memory / Team / Scratchpad / Construction
│       ├── runtime-middleware/     # 现有
│       ├── capabilities/           # 新增
│       │   ├── mcp/                # 原 @kodax-ai/mcp 全部内容
│       │   └── skills/             # 原 @kodax-ai/skills 全部内容
│       ├── tracing/                # 原 @kodax-ai/tracing 全部内容（self-merge）
│       ├── session-lineage/        # 原 @kodax-ai/session-lineage 全部内容（v0.7.35.1 Batch B 回流闭环）
│       └── index.ts                # 顶层 re-export — 公开 API byte-identical
├── coding/     # ~66.4k — Coding tools + prompts + agent-runtime + task-engine + construction + repo-intelligence
│   └── src/
│       ├── repo-intelligence/
│       │   ├── protocol.ts         # 新增 — 原 @kodax-ai/repointel-protocol 内容
│       │   ├── premium-client.ts
│       │   └── runtime.ts
│       ├── (其它 16 子目录不变)
│       └── index.ts                # re-export REPOINTEL_* + 原 coding API
└── repl/       # ~37.7k — Ink 终端 UI + REPL loop + slash commands + TUI 原语
```

### 包对应关系 — KodaX 4 包 vs pi 4 包

| KodaX 4 包 | pi 4 包 | 量级对比 |
|---|---|---|
| `@kodax-ai/llm` 7.3k | `pi/ai` 30k | KodaX llm 更精简（pi 把更多 provider impl 直接 vendor 进 ai 包） |
| `@kodax-ai/agent` 20.8k | `pi/agent` 8k | KodaX agent 含 capabilities + session-lineage + tracing 比 pi 大 2-3 倍 |
| `@kodax-ai/coding` 66.4k | `pi/coding-agent` 47k | KodaX coding 更大（含 construction / repo-intelligence / multi-instance / 复杂 task-engine 等 pi 无的能力） |
| `@kodax-ai/repl` 37.7k | `pi/tui` 11k + （pi/coding-agent 内含 REPL loop） | KodaX 单独包含 Ink UI + REPL loop + slash commands；pi 把 TUI primitives 单独包但 REPL loop 在 coding-agent 内 |

包数对齐，但内容分布不一样：pi "少包大单元 + tui 独立" vs KodaX "少包大单元 + repl 独立"。本 ADR 后 KodaX 结构成熟到 pi-shape 的镜像（4 vs 4，不强求镜像内容分布）。

### Why not alternatives

- **方案 X — 全包合并到 agent 形成 3 包结构 (llm/agent/repl)**: rejected。`coding` 66k LoC + 多个 distinct subsystem (task-engine / agent-runtime / tools / construction / repo-intelligence) 量级独立。`coding` 是 KodaX 的"应用层"承载具体 coding agent 实现，跟 agent 的"框架层"职责分离明确。
- **方案 Y — 保留 6 包（mcp/skills/tracing 合，session-lineage + repointel-protocol 保留独立）**: rejected per 2026-05-23 用户质疑后 grep 验证。session-lineage 包描述自认 agent 子系统 + latent dep bug；repointel-protocol "multi-host" 是意图非事实（0 外部消费者）。保留独立是 hypothetical-future-need rationalization 违反 YAGNI。
- **方案 Z — 起新聚合包名 `@kodax-ai/agent-capabilities` 装 mcp+skills**: rejected。包数没减（9 → 9-2+1 = 8）、release 复杂度没降、capabilities 类型未收敛到 3+ 案例（YAGNI 拒绝抽象）、改名只是 cosmetic relabel 不解决核心问题。
- **方案 W — 跨多版本拆分（v0.7.43 mcp / v0.7.44 skills / v0.7.45 tracing / v0.7.46 session-lineage / v0.7.47 repointel-protocol）**: rejected。5 个 inline 操作 wire pattern 完全同型（re-export + import 替换 + package.json + tsconfig），分版本只是无谓增加 release coordination；单 session 2.5-3 天 atomic ship 完成更经济，且 session-lineage 的 latent dep bug 应一次修不应拖。
- **方案 V — 引入 feature flag dual-path 让旧 `@kodax-ai/mcp` 等 import 走 deprecation shim**: rejected per [[feedback_no_parallel_refactor_paths]] — KodaX 节奏是"ADR + 一次性替换 + 多 commit/push + 可延迟 release"，不引入并行新旧代码路径。
- **方案 U — 保留 session-lineage 独立但修 agent/package.json deps**: rejected。修 deps 是把 latent bug 显式化为正式 dep 关系，但 session-lineage 跟 agent 是 circular dep（session-lineage depend agent + agent import session-lineage），修 deps 后 npm publish 仍可能因循环失败。合并消除循环。

### Consequences

**正面**：
- **Release 周期简化**：npm publish 10 → 4 包 / build graph 节点 9 → 4 / tsc -b 拓扑链短
- **84 处 cross-pkg import 收敛**：mcp 11 + skills 14 + tracing 10 + session-lineage 45+ + repointel 4 = 84 处 `@kodax-ai/*` import 转为 intra-package relative path，IDE jump-to-source 顺畅
- **"独立可用" 话语真实化**：剩 4 包每个都有独立 SDK use case（llm 提供 LLM 抽象 / agent 提供 agent 框架 / coding 提供 coding agent / repl 提供终端 UI）
- **修复 latent bug**：agent/package.json import-without-dep mismatch（session-lineage）自然消除
- **维护负担下降**：不再为 5 个 sub-package 各维护 README / package.json / tsconfig / files glob

**负面 / 风险**：
- **session-lineage 是 MED risk 单点** —— agent compaction critical path，9 个 cap-* contract test 全依赖。**缓解**：4a/4b 拆 soft-delete 两步，4a 保留 stub + deprecation re-export 兜底，4a commit 强跑 compaction.test 全套 + agent runner.test + 9 个 cap-* contract test + task-engine compaction.test。
- **skills 失去 zero-dep claim**：agent transitive deps（llm 现 agent-internal）通过 inline 后暴露给 skills 消费者。**缓解**：subpath export `@kodax-ai/agent/capabilities/skills` 兜底 tree-shake。
- **外部 npm consumer breakage**（若有）：原 `import { X } from '@kodax-ai/{mcp,skills,tracing,session-lineage,repointel-protocol}'` 在 v0.7.43 后失败。**缓解**：CHANGELOG breaking note + sed 替换模板（per FEATURE_147 migration playbook）；先 `npm view` 5 包 download stats 确认（基本预计零）；如非零再发最后版 stub 带 deprecation warning。
- **repointel-protocol 未来 re-extract**：69 LoC type-only 文件，若 codex/claude/opencode 真要接 daemon，30 分钟可 extract 出来。**可接受**。
- **agent 包变大到 20.8k**：跟 pi/agent 8k 相比偏大，跟 pi/coding-agent 47k 相比仍是 1/2 量级，认知负担可控。

### 保留行为（zero behavior change）

- 所有公开 API 类型签名 / 函数语义 / 默认值 / 错误形态 byte-identical
- agent 顶层 re-export：`MCPManager` / `MCPCatalog` / `SkillRegistry` / `SkillLoader` / `SkillResolver` / `Tracer` / `Span` / `SpanData` / `TracingProcessor` / `LineageExtension` / `LineageCompaction` / `appendSessionLineageLabel` / `applyLineageTruncation` / `applySessionCompaction` / `buildSessionTree` / `createSessionLineage` / `forkSessionLineage` / 等 ~30+ session-lineage helpers
- coding 顶层 re-export：`REPOINTEL_CONTRACT_VERSION` / `REPOINTEL_DEFAULT_ENDPOINT` / `RepoIntelligenceHost` / `RepoIntelligenceIntent` / `RepointelCommand` / `RepointelRequestPayload` / `RepointelRpcRequest` / `RepointelRpcResponse` / `RepoPreturnBundle` 等 type/const
- subpath export 兜底（optional 但提供）：
  ```ts
  import { MCPManager } from '@kodax-ai/agent/capabilities/mcp';
  import { SkillRegistry } from '@kodax-ai/agent/capabilities/skills';
  import { Tracer } from '@kodax-ai/agent/tracing';
  import { LineageExtension } from '@kodax-ai/agent/session-lineage';
  import { REPOINTEL_CONTRACT_VERSION } from '@kodax-ai/coding';
  ```
- 下游 consumer 仅需改 import source string 一处（5 个 sed 替换覆盖所有迁移）：
  ```bash
  sed -i 's|@kodax-ai/mcp|@kodax-ai/agent|g' src/**/*.ts
  sed -i 's|@kodax-ai/skills|@kodax-ai/agent|g' src/**/*.ts
  sed -i 's|@kodax-ai/tracing|@kodax-ai/agent|g' src/**/*.ts
  sed -i 's|@kodax-ai/session-lineage|@kodax-ai/agent|g' src/**/*.ts
  sed -i 's|@kodax-ai/repointel-protocol|@kodax-ai/coding|g' src/**/*.ts
  ```

### Sequencing

本 ADR 配套 FEATURE_194 在 v0.7.43 release window 内 ship，**严格在 FEATURE_193（V1 Chain Full Retirement）12-commit 全部完成 + push + 全测试绿 + git working tree clean 之后启动**。FEATURE_193 已于 2026-05-23 ship 完成（commits `9fb07d67` → `26af8605`），working tree clean 已验证。两个 refactor 在文件层完全不相交（193 改 `packages/coding/src/agents/` + `agent-runtime/`；194 改 `packages/{mcp,skills,tracing,session-lineage,repointel-protocol}/` 包根 + 所有 `@kodax-ai/*` import 站点），但顺序化 ship 避免 import graph 在 193 删除 V1 dead code 过程中被 194 同时改写带来认知负担和 git merge 风险。

### References

- 配套实施：FEATURE_194 [v0.7.43.md](features/v0.7.43.md#feature_194-package-consolidation)
- 先例：FEATURE_147 v0.7.37 npm publishing pipeline + `@kodax/ai` → `@kodax-ai/llm` rename（853 处 import-update 单次 atomic ship 成功，migration playbook 模板源）
- 先例：FEATURE_142 v0.7.35.1 Batch B — session-lineage 从 agent 拆出去的历史；本 ADR 把它合回去 closure the loop
- 先例：FEATURE_142 v0.7.35.1 Batch E — Package Boundary Cleanup + Capability Sections Dedup Helper
- 前置：FEATURE_193 v0.7.43 V1 Chain Full Retirement（codebase 最小化 baseline，已 ship 12 commits）
- pi reference（项目本地已不在，凭 2026-05-23 earlier session 数据）: 4 包 = ai / agent / coding-agent / tui
- 关键 memory：
  - [`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md) — 不引入并行新旧代码路径
  - [`feedback_concurrent_thread_git_race`](../../memory/feedback_concurrent_thread_git_race.md) — atomic `git add + commit`
  - [`feedback_selective_hunk_staging`](../../memory/feedback_selective_hunk_staging.md) — 并发 thread 同文件用 `git add -p`
  - [`feedback_workspace_packages_need_rebuild`](../../memory/feedback_workspace_packages_need_rebuild.md) — packages/*/src 改完必 `npm run build:packages`
- [ADR-021](#adr-021-agent-framework-boundary) — agent 包边界历史 trade-off
- CLAUDE.md "Add code cautiously" + "NEVER add abstractions without 3+ use cases" + "极致轻量化" 三条原则的 YAGNI 边界判定

---

## ADR-038: Per-Project Session Storage — Canonical-Keyed Directory Layout + Archive Semantics Split + Flat-Pool Migration (FEATURE_219, v0.7.46)

**Status**: ✅ Accepted & Implemented — FEATURE_219, v0.7.46（Phase 1-4 + review hardening 已 ship：per-project 布局 + archive 语义拆分 + flat-pool auto-migration 全部落地）。

> **编号说明**:ADR-037 已由 [FEATURE_208 (v0.7.45)](features/v0.7.45.md#L1797) 预留(process hardening threat model),本 ADR 让号取 038。

> **Note — migration 默认开启**:flat-pool → per-project auto-migration 默认 ON(locked + journaled + non-destructive),**首次以本版运行即对真实 `~/.kodax/sessions` 生效**,把平铺的 `{id}.jsonl` 一次性归入 `<projectKey>/` 子目录。因此任何直接扫描该目录的工具/测试都必须按 per-project 布局读取(见 [v0.7.46 SA-goldens `listSessionFiles` 递归读取修复](features/v0.7.46.md))。

**Driver**:

1. **全平铺无分层**:`~/.kodax/sessions/` 实测 580 文件 / 242MB,全部 `{id}.jsonl` 平铺。项目归属只靠每文件首行 `meta.gitRoot` / `runtimeInfo.canonicalRepoRoot`。`list()`([storage.ts:1044-1205](features/../../packages/repl/src/interactive/storage.ts)) 要列「当前项目会话」得**遍历全部文件、各读 64KB 头**再过滤 —— O(all sessions),正是 FEATURE_157 / SDK listing 一串性能补丁的根因。
2. **三套"archive"语义撞车**(用户困惑根源):(A) `{id}.archive.jsonl` **island 边车**(单 session 内部被 rewind 掉的 off-path 分支,lineage >500 条时 `runMaintenance()` 抽出瘦身,与主文件**配对**、本就该留在原地)；(B) `archived-` 前缀**整 session 归档**([public-api.ts:47-50](../packages/repl/src/session/public-api.ts) 注释自陈 "reserved for future use",**从未实现**)；(C) `~/.kodax/sessions-archive/` **旧目录**(2-3 月老文件,代码零引用)。A↔B 命名撞车让用户误以为 A 是"没归档成功的 session"。实测 13 个 `.archive.jsonl` 全是 A、12 个 PAIRED、1 个孤儿(`20260509_152541` 主文件已删边车残留)。
3. **非 git / 临时 / 无路径会话污染主池**:实测含海致交付目录、`kodax-storage-*` 嵌入测试临时目录、`(none)` 无 gitRoot 会话、`C:\` vs `C:/` 大小写漂移脏数据。
4. **参照系**:claudecode(每 cwd 一目录 `projects/<sanitize(cwd)>/<uuid>.jsonl`,无索引,worktree 前缀扫描兜)、codex(日期分层 `sessions/YYYY/MM/DD/` + cwd 写 meta + SQLite state DB)、opencode(单 SQLite + 内容寻址 project id = git-remote-url 哈希/root-commit 哈希)。三者布局差异由**主产品轴**决定:claudecode/KodaX 主轴=「resume 当前项目」,codex 主轴=「全局按时间翻 + cwd 当过滤器」。

**Decision**:

1. **布局 = 每项目一目录**(对齐 claudecode 主轴):`~/.kodax/sessions/<projectKey>/<id>.jsonl`。列表退化成 `readdir(单目录)` = O(sessions-in-project),消掉 scan-all。
2. **projectKey 分层**:`canonical 仓根`(git,源自 [workspace-runtime.ts:48-61](../packages/repl/src/interactive/workspace-runtime.ts) 的 `--git-common-dir` 派生,**今天每个 session 已在算**)→ `裸 cwd`(非 git)→ `_unknown/`(连 cwd 都没有的老孤儿兜底桶)。文件夹名 = 路径归一化(小写盘符消 Windows 大小写漂移)后 sanitize 成**可读 slug + 短 hash 后缀**(`<slug>-<8hex(canonicalRoot)>`,对齐 claudecode `sanitizePath` 的 hash 兜底):slug 给人眼,hash 后缀防碰撞 —— `C:/a-b`、`C:/a/b`、大小写/符号折叠后 slug 可能撞,hash 后缀保证唯一。每文件夹放 `project.json` 清单(`canonicalRoot` / `displayName` / `lastUsed`),picker 读它即可不必解析每个 session meta,**写入时比对 `project.json.canonicalRoot` 做最终冲突检测**(slug+hash 仍撞 → 第二段 hash)。
3. **worktree = canonical 自动归并 + UI 标签**:一个仓所有 worktree 共享同一 `--git-common-dir` → 同一 canonical key → 同住项目文件夹(满足"归到出仓项目一起")。扁平存放,**零新存储字段** —— `meta.runtimeInfo.workspaceRoot`(`--show-toplevel`,worktree 时 ≠ canonicalRepoRoot)已记录,picker 凡 `workspaceRoot ≠ canonicalRepoRoot` 打 `[wt: <basename>]` 标签区分(满足"明确显示是单独 worktree")。可选「只看当前 worktree」过滤复用 `workspaceRoot` 精确匹配。
4. **归档语义彻底分家**:(A) island 边车 `{id}.archive.jsonl` → **`{id}.islands.jsonl`** 改名,把 "archive" 一词**只留给整 session 归档 B**；(B) 整 session 归档 = **move 到 `<projectKey>/archived/`**(codex 风格物理搬家,KodaX 是文件不是 DB,move 比 soft-delete 列更贴) + `archive` / `unarchive` + 落地预留的 `includeArchived`(语义从「`archived-` 前缀」改为「`archived/` 子目录」)。**`archive` / `unarchive` / `delete` 一律成对处理 `{id}.jsonl` + `{id}.islands.jsonl`**(只移主文件会再造孤儿边车,正是本次要消除的那种)。迁移时**退役 `sessions-archive/` 旧目录** + **隔离**现存孤儿边车(迁 `_unknown/orphan-islands/` + 报告,**不删**)。
5. **附带减码**:folder key 即项目身份 → 删 `list()` 的 scan-all 过滤 + [storage.ts](../packages/repl/src/interactive/storage.ts) 的 `pathsEqual` Windows 大小写 hack(归一化已在 folder key 收口) + 部分 `isSameCanonicalRepo` 跨过滤体操。净 LoC 预期下降,符合「minimalist & 少打补丁」。
6. **迁移器(planner + executor，destination 规则)**:对每个平铺文件,**用 runtime 同一解析器**作用在它记录的 `gitRoot` 路径上(老 session 的 gitRoot 多半还在盘上 → 现场解析出与未来 live 行为**确定性收敛到同一 key**,避免老文件路径键、新文件键裂成两目录)；盘上已不存在的 gitRoot → 归一化路径 + 短 hash 桶;非 git/临时 → 各自 cwd 文件夹;真无路径 → `_unknown/`。**planner 只算** `{from, to, sidecarFrom?, sidecarTo?, projectKey, reason}`(可测、可 dry-run、可打印「580 files → N projects」对账)、**executor 才 move**,连带 `{id}.archive.jsonl → {id}.islands.jsonl` 成对搬。**孤儿边车(主文件已不在)绝不自动删** —— 移到 `_unknown/orphan-islands/` 并记入 migration report(客户数据不许被「聪明地」清掉)。**真实 move 不得早于 locator-reader(见 7)落地**:现有 reader([storage.ts:612](../packages/repl/src/interactive/storage.ts) 只找 `<sessionsDir>/<id>.jsonl`)会读不到已被移走的 session,中间态不可读。
7. **id-only locator 层(保 SDK 契约不破)**:现有公开 API `loadSession(id)` / `forkSession(id)` / `rewindSession(id)` / `deleteSession(id)` 都是 **id-only**([public-api.ts:275-419](../packages/repl/src/session/public-api.ts)),FEATURE_173 起 Space 还要跨项目列 + watch。分目录后**不改 id-only 签名**,在 `FileSessionStorage` 内加 `resolveSessionLocation(id)`,查找顺序:① 当前 projectKey `<key>/<id>.jsonl` → ② 当前 `<key>/archived/<id>.jsonl` → ③ legacy 平铺 `<sessionsDir>/<id>.jsonl` → ④ bounded scan `<sessionsDir>/*/<id>.jsonl` + `<sessionsDir>/*/archived/<id>.jsonl`。load/fork/rewind/delete 均先过它。`listSessions` summary 加**可选** `projectKey?` / `archived?`(向后兼容,Space 可当 hint 但不强制)。`watchSessions` 改 watch/poll 各 project dir(POSIX:顶层发现新 project dir + 每个 project/archived dir 注册 watcher;Windows:poll snapshot 从「顶层 .jsonl」扩成「所有 project dir 下的 id 集合」)。legacy 平铺 fallback(③)**保留 ≥1 版本周期**:新写入走 project dir,旧平铺仍可 `load(id)` 命中。**不把完整文件路径暴露给 SDK** —— 只露 `projectKey`,完整 path 会把存储布局变成 public contract,日后更难改。
   - **全局唯一 id(硬决策,堵 §7 ④ bounded-scan 歧义)**:现 `generateSessionId()` 是秒级 `YYYYMMDD_HHMMSS`([session.ts:50](../packages/agent/src/session-lineage/session.ts) 无 ms/random),平铺池靠文件名碰撞「掩盖」同秒冲突(实为静默 overwrite 隐患),**分目录后不同项目可同 id → `loadSession(id)` 不确定**。故新写入 id **必须全局唯一**(追加 ms + 短 random,或 collision-retry + `O_EXCL` 原子创建);迁移**检测重复 id**,历史重复时 id-only **优先当前 projectKey**,仍歧义 → 返回明确 **ambiguity(null + 日志,不猜)**,`listSessions` 已带 `projectKey` 供消费侧精确定位。此决策**顺带堵掉**平铺期同秒静默 overwrite 的 latent bug。
8. **升级后首次使用自动迁移(transparent、locked、journaled、resumable、non-destructive)** —— 别的客户不会手动跑迁移器,所以做成自动,但**先有 §7 双布局兼容读、再自动迁移**,中断也不丢、不变不可读:
   - **触发点**:不放 constructor(不能 async)。在 `list/load/save/fork/rewind/delete/watchSessions` 每个入口开头 `await this.ensureLayoutMigrated()`,内部用**一次性 Promise cache** 保证每进程只跑一次。
   - **检测(layout marker)+ 完成顺序写死**:`~/.kodax/sessions/.layout.json` = `{version:2, migratedAt, from:"flat-v1"}`。无 marker **且**顶层存在 `*.jsonl` → 判定需迁移。**marker 只在「所有 move 完成 + 顶层平铺清空 + journal complete」之后,用 temp file + atomic rename 写入**。**启动时若存在 incomplete journal → 优先 resume journal,不能仅凭 marker 跳过**(marker 在则隐含 journal 已 complete,但仍以 journal 状态为防御性真值)。
   - **跨进程锁 + stale 回收**:`~/.kodax/sessions/.migration-lock/` 目录锁(`fs.mkdir` 原子,跨平台)。抢不到 → 另一个 KodaX/Space 正在迁移,当前进程**继续走 §7 兼容读**(不阻塞读);**写操作等迁移结束**,避免一边搬一边写同一 id。锁目录内放 `owner.json` `{pid, startTime, heartbeatAt}`;**stale 回收**:进程不存在或 heartbeat 超时 → reclaim(防持锁进程崩溃后 lock 永久残留 / 写永久等待)。测试覆盖「持锁者崩溃后下次启动能续 journal」。
   - **journal(可中断续跑)**:`~/.kodax/sessions/.migration-journal.jsonl`,每 move 一步 append `{from, to, done:true}`。下次启动发现 journal 未完成 → **继续 forward 迁移**(不自动回滚、不自动删数据)。
   - **rollback 降级为 dev 工具**:生产姿态是 forward-only + journaled + 非破坏;`move 回平铺` 仅作开发期手动 escape hatch,不在中断时自动触发。
   - 我的 580 文件只是这套自动迁移的**一个实例**,不再是特殊手动流程。

**Why not alternatives**:

- **裸 cwd 做 key(claudecode 原样)**: rejected。会**退化** KodaX 今天已免费算好的两个归并 —— 同仓子目录启动被拆散、worktree 与主仓分家;且 sanitize 不消 Windows 盘符大小写 → **FEATURE_157 resume-loss 复活**;且"列整个项目"需跨文件夹交叉扫(成本回来)。claudecode 用裸 cwd 是因它无 canonical 层、接受 worktree 前缀扫描兜;KodaX 既已付费算 canonical,用裸 cwd 等于买好东西不用。
- **日期分层 `YYYY/MM/DD`(codex)**: rejected。codex 主轴=全局时间线、cwd 仅过滤器,与 KodaX「按项目 resume」相反;真按项目分目录会丢失 newest-first 单路 walk;按 cwd 过滤又贵到必须补 SQLite。KodaX 规模(百级/项目)未到单目录爆炸,日期分层是**未来逃生舱**(某项目涨到数千文件再在其内部加 `YYYY/MM/`),现在不建。
- **单 SQLite 库(opencode)**: rejected。丢掉 JSONL append-only 即崩溃恢复日志 + 可检视性;ORM 层重,违背「极致轻量 / 3+ 用例才抽象」;当前无关系查询刚需。**目录即索引**给 90% 收益、5% 复杂度;待 Space 真出现「跨项目全局列表 @ 规模」3+ 实例再上索引(YAGNI)。
- **内容寻址身份 = git-remote-url 哈希(opencode)**: rejected as over-engineering。其主卖点"统一 worktree"被 `--git-common-dir` canonical 路径**今天就已满足**;remote 哈希额外只多买「仓被移动/重新 clone 后会话仍跟随」—— hypothetical,违 YAGNI,且要 `.git/kodax` 缓存 + 启动跑 `git remote`。folder 名也从可读退化成不透明哈希。
- **物理 `worktrees/<名>/` 子文件夹**: rejected(用户 2026-06-07 定)。扁平 + meta 标签更简、信息(`workspaceRoot`)全现成、列表一次 readdir;物理隔离的 eyeball 收益不抵两层 walk + 写入判 workspaceRoot 的成本。

**Eval posture**: 无需 prompt eval —— 纯 session persistence infrastructure,CLAUDE.md「Prompt Eval — Non-triggers」明列 "Compaction / session persistence infrastructure"。验证靠单测(folder key 解析 + 碰撞矩阵 / **id 全局唯一 + 重复 id 歧义解析** / **迁移幂等 + journal resume + stale-lock recovery + non-destructive orphan handling** / archive-unarchive 成对 / list 单目录) + 迁移 dry-run 实跑 580 文件对账。

**先例 / 关键 memory**:
- 参照对照三家(claudecode `sessionStoragePortable.ts` / codex `rollout/recorder.rs` / opencode `core/project.ts`),2026-06-07 三 Explore agent 实地核实。
- [`feedback_no_parallel_refactor_paths`](../../memory/feedback_no_parallel_refactor_paths.md) — 不引入并行新旧路径;迁移用双布局兼容读 + journaled forward(非破坏、可中断续跑),不做 dual-path flag(rollback 仅 dev escape hatch)。
- [`feedback_workspace_packages_need_rebuild`](../../memory/feedback_workspace_packages_need_rebuild.md) — 改 `packages/repl/src` 后必 `npm run build:packages`。
- FEATURE_157(Windows 大小写 resume-loss)的 `pathsEqual` hack 在本 ADR 后由 folder-key 归一化收口、可退役。

---

## ADR-039: MCP 2025-11-25 Reverse Capabilities — 声明=实现承诺 + 反钓鱼 Elicitation + 零配置 OAuth Discovery + `type:"http"` 配置别名 (FEATURE_222, v0.7.48)

**Status**: Accepted (2026-06-11, shipped v0.7.48)

**Context**: v0.7.47 交付了 MCP `2025-11-25` 的 forward（client→server）半边，但 client 仍声明空 `capabilities:{}`、对所有 server→client 请求回 `-32601`。本 ADR 记录补齐 reverse（server→client）半边时的关键决策。参照对照 `C:\Works\claudecode`（标杆）+ `C:\Works\PubGItProj\codex`，2 个 Explore agent 实地核实其 OAuth/elicitation 实现。

**Decisions**:

1. **声明=实现承诺（capability declaration = implementation promise）**。`buildInitializeCapabilities()` 只在对应 handler 被 host 注入时才点亮 `initialize.capabilities` 的键。
   - *Why not advertise-all*：声明了却不实现 = 协议违规（conformant server 会发请求然后我们回 -32601 或挂起）。本决策让 feature **逐 slice 可增量交付**（roots → elicitation → oauth 各自独立点亮），且 headless host 不注入任何 handler 时行为与改造前完全一致（全部 -32601）。这也是为什么 `sampling` 留了 runtime seam 但**不点亮**——没有 host 注入 `sample`，capability 就不声明，server 不会发。

2. **`ask_user_question` 原语下沉 agent 层 + active-interaction registry（调用时解析）**。原语从 `@kodax-ai/coding` 移到 `@kodax-ai/agent`（coding re-export 向后兼容），因为 MCP runtime 在 agent 层、够不到 coding。MCP provider 在交互 loop 之前就构造，但 server 可在任意时刻 elicit → 用 module-level `setActiveUserInteraction`/`getActiveUserInteraction` 注册表，在**调用那一刻**解析 live 交互面（非构造时）。
   - *Why not 构造时注入*：构造时还没有 live REPL 对话框；late-binding registry 是唯一能让"启动期构造的 provider"在"运行期"拿到真实 UI 的方式。镜像既有 active-extension-runtime 模式。

3. **Elicitation 反钓鱼三件套**：`McpElicitRequest` 带 `serverId`（runtime 在 dispatch / -32042 / OAuth consent 三处注入）→ form + url prompt 都展示「哪个 MCP server 在请求」；form 收集后加 **review-before-send** 确认（列出将发送的值 + Send/Cancel）；url mode 展示完整 URL + 域名、**绝不自动打开浏览器**、**绝不让 model 窥探 URL/内容**。
   - *Why*：elicitation 是 server→user 的注入面，是钓鱼向量（恶意 server 可伪装索要 token）。最高杠杆防御是「让用户知道是谁在问」+「发送前可审阅」。这是 spec User-Interaction Model 的 client SHOULD。

4. **OAuth 零配置 discovery + 复用 url-elicitation 作 consent gate**。401 → RFC 9728 PRM → RFC 8414/OIDC AS metadata → RFC 7591 DCR → PKCE(S256) + RFC 8707 `resource` → `127.0.0.1` loopback。授权 URL 通过**同一个 url-elicitation 反钓鱼门**展示（不另造 UI）。`config.auth` 端点字段改 optional（零配置）。
   - *Why not 静态配置*：成熟客户端（claudecode/codex）都是 discovery-based 零配置；要求用户手填 `authorizationUrl`/`tokenUrl` 不现实。既有 FEATURE_065 静态路径保留（仅在三字段齐备时走）。
   - *Why CIMD 不做*：Client ID Metadata Documents（SEP-991）是*推荐*增强非 MUST，需要 server 端 `client_id_metadata_document_supported`；DCR(RFC 7591) 是注册基线且 codex 也只用 DCR。CIMD 列为 non-goal，待真实目标 server 需要时再评估。**故对外表述为「discovery/login/step-up 完成」而非「完整对齐 2025-11-25」**。
   - *callback 加固*：先监听再展示 URL（消除丢 redirect 竞态，首结果 buffer）；redirect URI 用 `127.0.0.1` 与监听一致（避开 IPv6 `localhost`/`::1` 错配，对齐 codex/RFC 8252）；PKCE 强制 S256，AS 不支持即硬失败拒绝降级到 `plain`。

5. **`type:"http"` 是配置层 alias，不是 wire protocol**。`createAutoHttpTransport` 先 POST `initialize` 当 Streamable HTTP，仅在 `400/404/405` fallback 到旧 HTTP+SSE；`401/403/5xx/网络错误`不 fallback（auth 挑战仍走 OAuth 流程）。diagnostics 记 `resolvedTransport`。
   - *Why not 直接映射成 `streamable-http`*：生态里 `type:"http"` 的语义是「HTTP MCP server，自己判断 flavour」；直接当 streamable 会让只支持旧 SSE 的 server 连不上。auto-detect 在 runtime 层（initialize 本就在 runtime 发），改动面最小。

6. **catalog 对 optional list 容错**：`resources/list`/`prompts/list` 回 `-32601`（按 error code 判定）当空数组，不让整个 catalog refresh 失败；`tools/list` 仍硬失败。
   - *Why tools/list 不容错*：无 tools = 无核心能力，该 server 实际不可用，硬失败比静默空 catalog 更诚实。（实测「小智数据问答」server 正是 `prompts/list` -32601 但 tools 正常的案例。）

**Eval posture**: 无 prompt 改动 → $0 LLM eval（CLAUDE.md「Prompt Eval — Non-triggers」）。验证靠 130+ MCP 单测（每 slice 有 fake-MCP-server）+ 真实「小智数据问答」server 实测（type:http → http:auto->sse、发现 tool、tools/call 发出）。

**先例 / 关键 memory**:
- 参照对照 claudecode（OAuth CIMD+DCR / elicitation serverId 展示 / 127.0.0.1 loopback）+ codex（rmcp DCR / `127.0.0.1/callback/<hash>` / 无 RFC 9728）。
- [`feedback_concurrent_thread_git_race`](../../memory/feedback_concurrent_thread_git_race.md) — GPT 并发改同批 MCP 文件，选择性 staging / 原子提交。
- [`feedback_old_design_doc_verify_against_code_first`](../../memory/feedback_old_design_doc_verify_against_code_first.md) — GPT cross-review 的论断逐条对代码核实（CIMD「MUST」被核为 SHOULD/optional）。

---

## ADR-040: Workflow Process Layer — Agent-Layer Domain-Neutral Snapshot/Event + Child Telemetry Correlation + Restricted-Source Validation (FEATURE_229, v0.7.50)

**Status**: Accepted

> **Later status (2026-06-18 / v0.7.52)**: FEATURE_229 remains the current
> workflow process boundary. v0.7.51 added durable session tool replay,
> workflow run `hostMetadata`, and inline workflow skill-reference propagation
> on top of this contract. v0.7.52 was maintenance-only for this area: no
> workflow architecture change, but the runtime/docs baseline is now Node.js
> 20+.

**Context**: FEATURE_217 (v0.7.49) 已交付动态工作流的完整产品闭环（生成 JS harness、capsule、save/rerun、worktree isolation、REPL `/workflow`）。但工作流的「运行过程」本身还不是 agent 层标准的 process/event/snapshot——SDK 宿主、REPL inline/fullscreen、未来 extension/automation 只能各自拼 UI 和状态解释。FEATURE_229 把这一层抽象成可订阅契约。本 ADR 记录其架构取舍（feature 设计见 [features/v0.7.50.md](features/v0.7.50.md)）。

**Decisions**:

1. **Workflow process 是 agent 层 domain-neutral 的 snapshot/event，不耦合 `KodaXEvents`**。`@kodax-ai/agent/workflow` 暴露 `WorkflowProcessSnapshot` / `WorkflowProcessEvent` / `isFinalWorkflowProcessStatus`；一个薄 reducer 把已有 `WorkflowEvent` 折叠成 snapshot，**不让 generated script 感知 process 状态**。
   - *Why*：保持层独立（CLAUDE.md）。SDK 宿主订阅工作流进度不应被迫拖入 `@kodax-ai/coding` 或 REPL 类型。agent workflow 包**不 import `KodaXEvents`**。

2. **事件只保留三种粗粒度类型**（`workflow_started` / `workflow_updated` / `workflow_finished`），细粒度 phase/agent/step 状态折进 `snapshot.items`。
   - *Why not 全 app-server 事件 taxonomy*：v0.7.50 不发布完整 app-server 协议（YAGNI）。粗事件 + 快照 diff 足以驱动 UI 与 SDK，且避免提前发明协议。

3. **child completion 与 digest 解耦：runtime 暴露 domain-neutral `updateTaskSummary(taskId, { summary, summaryStatus })`**。child 完成立即置 `completed` + `summaryStatus:'pending'`（确定性摘录作 interim），model-authored digest 在关键路径外算好后经该通道作为后续 `workflow_updated`（`result`/`unavailable`）交付；run 已 stop/cancel 时 late digest 静默丢弃。
   - *Why*：v0.7.49 的 digest 在 child 结果返回前同步生成，rate-limit 时「完成」感被阻塞。runtime 只收 `{summary, summaryStatus}` 纯数据，**具体 LLM 自蒸馏仍留 coding**（与 ADR-030/ADR-021 一致：判断/蒸馏属 coding，invocation kernel 属 agent）。worktree-isolated child 保留阻塞式 digest，确保 digest 在 worktree 清理前跑完。

4. **child/tool 遥测走「既有 `KodaXEvents` 回调 + 可选 meta 尾参」，不新开事件通道**。回调签名扩展为 `(x, meta?)`，meta 为 `KodaXToolEventMeta` / `KodaXActivityEventMeta` / `KodaXWorkflowEventMeta`，携带 `toolId`、child agent identity、`WorkflowEventCorrelation`（`workflowRunId`/`childAgentId`/`itemId`）。`onChildActivityEnd` 标记 child 离开执行器。
   - *Why not 第二套事件协议*：宿主只需把每个 tool/thinking/text/progress 事件**归因**到发起它的 child agent 和 workflow run，一个可选 meta 参数即可，不必复制一套并行 event taxonomy。`WorkflowEventCorrelation` 由 coding 层填充，agent workflow 包仍不 import `KodaXEvents`。REPL 据此把 child 活动路由到 bounded `ChildActivitySurface`，不污染主 transcript。

5. **host policy 与 lifecycle controller 属 coding/SDK 边界，不进 domain-neutral runtime**。`WorkflowHostPolicy`（`autoStart` off/confirm/on + `maxAgents`/`maxConcurrency`/`tokenBudget` 上限）clamp caps；`createWorkflowLifecycleController` 提供 stop/pause/resume/result/artifact/delete/prune/identity/preflight。
   - *Why*：它们需要 run storage、artifact 读取、invocation policy 和宿主产品策略，本质是 coding 关注点。host policy 只能更严（不能抬高 KodaX 硬上限、不能绕过 child permission gate）。lifecycle controller 不导入 REPL 类型、不输出 ANSI、不要求宿主解析 slash-command。

6. **generated/saved 工作流源码在 generate/save/rename/replace/run 各路径过 `validateRestrictedWorkflowSource`**（JS 编译检查 + 对去注释/去字符串后的源做策略扫描），generator 增加有界多轮 repair loop（syntax + smoke 执行检查）。`wf.output(taskId)` 别名为 `wf.snapshot(taskId)`（`output` 保留兼容）。
   - *Why*：generated JS 在受限 VM 执行，落盘/运行前先验证可编译且不含越界源模式，比运行时再失败更早暴露问题；smoke 执行用 fake API 跑一遍 harness 形状，抓住「能编译但结构不可显示」的生成缺陷。

7. **identity 模型显式三态、run graph append-only**：`runId` 不可变历史 / saved capsule 版本化（rename 改 capsule identity）/ revision 是新对象。`revise --replace` 确认后移动 saved 名字并把旧 capsule 归档到 `.revisions/<savedName>/`，rename/revise 元数据记为事件或 sidecar，不重写旧时间线。
   - *Why*：用户/ SDK 宿主需要稳定 identity + rename/revise/provenance 而不必记 opaque run id；历史 run 必须保持可审计。

**Layering 边界总结**：snapshot/event schema + 终态 helper + `updateTaskSummary` 通道 ∈ `@kodax-ai/agent`（domain-neutral）；run manager bridge、lifecycle controller、host policy、`KodaXEvents` correlation 填充、digest 自蒸馏、capsule preflight ∈ `@kodax-ai/coding`；inline/fullscreen 渲染 + `ChildActivitySurface` ∈ `@kodax-ai/repl`（只消费 snapshot，不作 source of truth）。

**Eval posture**: 主体为 SDK/runtime 契约与 UI，非 prompt 内容 → 该部分 $0 LLM eval；验证靠各 slice 单测（process reducer / lifecycle controller / generator smoke / child telemetry / 契约测试）+ 全量套件绿。**例外**：同窗附带的 role-prompt「语言连续性」规则触碰 LLM-facing prompt（CLAUDE.md role-prompt.ts 是 eval trigger），需补 prompt-eval。

**先例 / 关键 memory**:
- 承接 FEATURE_217（v0.7.49）的产品闭环；本 ADR 只补 process/SDK/lifecycle 层，不降级 dynamic JS harness。
- ADR-030（判断/蒸馏留 coding、invocation kernel 留 agent）与 ADR-036（包内联、层独立）是分层取舍的直接依据。
- [`feedback_concurrent_thread_git_race`](../../memory/feedback_concurrent_thread_git_race.md) — 本版多线程并发开发，按功能分批原子提交。

---

## ADR-041: Provider Empty-Content Compatibility Contract

**Status**: Accepted

**Context**: KodaX supports multiple OpenAI-compatible and
Anthropic-compatible coding gateways. Several runtime paths can create
assistant or tool-result turns with no user-visible substance:
hidden-tool-only assistant turns, microcompaction, history cleanup,
thinking sanitization, compressed/restored sessions, interrupted tool loops,
and empty stdout/tool results. Some gateways reject empty assistant content,
but writing a text placeholder such as `...` into KodaX history leaks a fake
assistant answer to SDK users, changes the model-visible transcript, and can
fragment provider prompt caches.

**Decision**:

1. Empty-content compatibility is a provider-boundary contract, not a prompt
   behavior question. Provider serializers may use a minimal wire-only
   placeholder only when the target gateway requires non-empty assistant
   content. That placeholder must not become SDK output or persisted
   user-visible assistant text.
2. The mandatory verification artifact is
   `tests/provider-empty-content-contract.eval.ts`. It runs each case through
   both the current KodaX adapter path and a direct raw wire probe where the
   protocol supports it.
3. The default live panel is the customer-relevant provider set:
   `kimi-code`, `zhipu-coding`, `minimax-coding`, `mimo-coding`, `mimo`,
   `ark-coding`, and `deepseek`. Official `anthropic` / `openai` are not the
   default gate for this project because they are not the primary customer
   deployment path.
4. Adding a new provider, changing a provider base class, changing message
   serialization, changing history cleanup, changing compaction, or changing
   recovery/sanitization logic must run this eval for every affected provider
   with a configured key. If a key is unavailable, record the skipped provider
   explicitly in the PR/release note and run it before declaring that provider
   supported for the changed behavior.
5. Raw eval dumps are the source of truth. Store them under the OS temp path
   emitted by the eval (`kodax-eval-dumps/provider-empty-content-contract`),
   not in the repo. Summaries in docs or PRs must cite the dump path and list
   accepted/rejected cases per provider.

**Runbook**:

```bash
KODAX_EVAL_PROVIDER_EMPTY_CONTENT=1 npm run test:eval -- provider-empty-content-contract

KODAX_EVAL_PROVIDER_EMPTY_CONTENT=1 \
KODAX_EVAL_PROVIDER_EMPTY_CONTENT_PROVIDERS=kimi-code,deepseek \
npm run test:eval -- provider-empty-content-contract
```

**Acceptance**:

- `kodax_path` must accept all cases marked required by the eval.
- `raw_wire_probe` is observational. A raw rejection is acceptable and is
  precisely the evidence that a provider may need a wire-only fallback.
- Empty `tool_result` payloads must remain empty tool results; they must not
  be rewritten to an assistant-visible `...`.
- A provider change is not complete until this eval either passes for the
  affected provider or the unsupported/missing-key exception is documented.

## ADR-042: Reasoning Single-Tracking — `effort` as the Sole Reasoning Control (retire V1 reasoning-mode/depth dual track + CAP-019 harness auto-upgrade)

**Status**: Accepted

**Context**: Reasoning control had grown into a dual track. `effort`
(`KodaXWireReasoningEffort`: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`auto`)
was the user-facing control (Ctrl+T ladder, `/effort`, `--effort`, per-model
capability resolution via `resolveReasoningEffort`), while a parallel legacy
track — `reasoningMode` (`off`/`auto`/`quick`/`balanced`/`deep`) + `thinking
depth` (`off`/`low`/`medium`/`high`) — still flowed through the plan, the
per-turn override, the worker role resolution, the extension hook, and the
provider request. The legacy track was **lossy** (it cannot express
`minimal`/`xhigh`/`max`) and forced every layer to carry both encodings.
Separately, CAP-019 added a harness that could *auto-upgrade* reasoning
mid-task (depth-escalation / task-reroute), and the `KodaXHarnessProfile`
(H0/H1/H2/PLANNED) carried per-harness budget/round tables.

**Industry comparison** (verified against a Claude Code reference tree):
Claude Code and Codex have **no** harness-level reasoning auto-upgrade —
effort is fixed per turn and only the user changes it. Claude Code's agent
loop has **no per-complexity budget table**: `maxTurns` is set per agent
*role* (fork=200 / hook=50 / …), not per task tier, and the main loop relies
on the LLM's own stop signal. KodaX's per-harness budget tables were a
V1-multi-harness vestige with no industry analogue.

**Decision**:

1. **`effort` is the single canonical reasoning control end to end.** The
   routing plan (`ReasoningPlan.effort`), the per-turn override
   (`thinkingLevel` / `runtimeThinkingLevel` / the `provider:before` extension
   hook), the worker role resolution (`resolveRoleEffort`), and the provider
   request (`KodaXReasoningRequest.effort`) all carry effort only. The legacy
   `mode`/`depth` fields were removed from `KodaXReasoningRequest` /
   `KodaXNormalizedReasoningRequest`; `normalizeReasoningRequest` is
   effort-only.
2. **CAP-019 harness auto-upgrade is retired** (no harness re-runs a turn with
   "stronger reasoning"). This aligns with Claude Code / Codex: effort is the
   user's lever, not the harness's.
3. **Per-harness budget/round tables collapse to single constants**
   (`MANAGED_WORK_BUDGET_CAP=200` / `MANAGED_MAX_ROUNDS=8` /
   `MANAGED_WORK_BUDGET_EXTENSION=200`). The H0/H1/H2 tiers no longer selected
   different agent topologies (V2 is a single Worker loop), so they were only
   budget tiers reachable via the resume seed — a latent fresh-vs-resume
   inconsistency. `MAX_ROUNDS` is a progress-display denominator (it grows by 1
   on each approved budget extension), not a work cap; the real ceiling is the
   budget controller plus the per-agent inner tool loop.
4. **Two legacy types survive deliberately, demoted to bounded roles, not as a
   reasoning track**: `KodaXReasoningMode` remains only as the deprecated
   `KodaXOptions.reasoningMode` / `--reasoning` compat boundary (mapped to
   effort on load via `mapLegacyReasoningModeToEffortIntent`);
   `KodaXThinkingDepth` remains only as the internal *budget-size* enum
   (`effortToThinkingDepth(effort)` → `resolveThinkingBudget`). Fully deleting
   them is a follow-up gated on migrating the budget map to effort keys and the
   CLI/config surface.
5. **Provider wire is unchanged by construction.** `effortToThinkingDepth`
   mirrors the exact `effort → mode → depth` derivation the old normalizer
   used, so every provider × effort emits the same `reasoning_effort` /
   `thinking.budget_tokens`. This is the behaviour-preservation contract for
   the provider-budget change.

**Consequences**:

- One reasoning encoding to reason about; `minimal`/`xhigh`/`max` now survive
  the per-turn override and worker path (previously collapsed to the nearest
  legacy mode).
- The `provider:before` extension hook and `setThinkingLevel` now carry effort
  values (breaking for extensions that passed legacy mode strings).
- The harness-prompt variants (`HARNESS_PROFILE_OVERLAYS` H0/H1/H2) are
  LLM-facing and remain pending an EVAL_GUIDELINES 5-alias panel before
  removal — they are NOT covered by this ADR's code changes.

---

## ADR-043: Harness via Static LLM Judgment — Worker Self-Judges from Static Guidance + Verifier Fires on Objective Metrics (retire router→harness prompt injection for the Worker)

**Status**: Accepted

**Context**: KodaX classified every request with a keyword heuristic
(`inferIntentGate` / `inferTaskSignal`) into a `harnessProfile` (H0/H1/H2) and a
`recommendedMode`, then injected *different* prompt overlays
(`HARNESS_PROFILE_OVERLAYS` + `EXECUTION_MODE_OVERLAYS` + a `[Task Routing]`
classification dump) into the Worker's system prompt per the prediction. This
router-predicts-then-tells-the-LLM shape violated KodaX's own ADR-033 ("the LLM
is a colleague making a judgment, not a program looking up a table"). The
Sidecar Verifier (FEATURE_196) also fired on a coarse "any tool use → verify"
gate, wasting tokens on trivial work. **Industry comparison** (verified against
Claude Code + Codex reference trees): neither has a router or complexity
pre-classifier — "when to plan / dispatch / review" is static guidance the LLM
self-applies; neither gates verification on a per-task complexity classifier.

**Decision**:

1. **Verifier activation is rule-based on objective execution metrics, not LLM
   self-report** (H2). `composeGateDecision` reads `mutationTracker`
   (writes / estimated lines / files + a new `riskyShellOps` count), `roundRef`
   (rounds), and `todoStore` (plan committed). It fires on substantial / risky
   work (risky shell op, a committed Todolist, > `ROUNDS_VERIFY_THRESHOLD`
   rounds, multi-file, or > `TRIVIAL_LINES` single-file) and skips provably
   trivial observed work (one small edit, or a grounded read-only lookup). LLM
   self-report was rejected: a model that has finished a task does not
   volunteer "I didn't finish / please review me". The conversational floor +
   default-fire are preserved, so the F184 intent-vs-action floor (a text-only
   claim with no tool evidence) still fires.

2. **The Worker self-judges the kind of work from static EXECUTION GUIDANCE, not
   from a router-injected overlay** (H3). `buildWorkerInstructions` carries a
   static block (execute-then-self-check / review-high-signal / broad-audit /
   investigation-root-cause / planning / ambiguity), written ADR-033-style as
   informal use-cases, not RULE A/B/C labels. The Worker role-prompt no longer
   splices `promptOverlaySection`. **Validated** by a 5-alias panel
   (`zhipu/glm52` + `kimi` + `mimo/v25pro` + `mmx/m3` + `ds/v4pro`) × 5 case × 2
   variant × 3 run, judged by the orchestrating Claude reading raw outputs (not
   regex): behavioural parity with the old overlay across no-ceremony /
   plan-first / review / investigation / dispatch, and a shorter prompt
   (−21…−590 chars). Driver kept as a permanent regression sweep
   (`tests/h3-static-guidance-{pilot,panel}.eval.ts`).

3. **The dead LLM-router cluster is deleted** (−534 LoC): `routeTaskWithLLM` and
   its whole transitive set went unreachable when FEATURE_193 switched
   `createReasoningPlan` to `buildFallbackRoutingDecision`. `shouldUseModelRouter`
   was renamed `requiresRoutingHeuristics` — it never selected an LLM router.

**Scope boundaries (deliberately NOT changed)**:

- **The overlay machinery (`buildPromptOverlay` / `HARNESS_PROFILE_OVERLAYS` /
  `EXECUTION_MODE_OVERLAYS`) stays** — it is still live for the SA / direct path
  (`capability-sections.ts` `prompt-overlay` section). H3 only removed the
  *Worker's* consumption (`AMA_OWNED_SECTION_IDS` already excluded it from the
  capability block, so there was no double-injection). Migrating the direct path
  is out of scope (it handles trivial H0 tasks).
- **`harnessProfile` / `KodaXTaskRoutingDecision` stay** — they remain live
  decision fields (repo-intelligence gate, payload, checkpoint, budget, UI). A
  rename to `workerChain` / `repoContextNeed` is high-churn (90–237 refs across
  3 packages) and deferred; a non-`harnessProfile` repo-context gate is the
  prerequisite for any future removal.

**Consequences**:

- The Worker's behaviour is now driven by static principles + its own judgment,
  matching Claude Code / Codex and KodaX's ADR-033 stance.
- Verifier activation is objective and explainable; trivial tasks skip
  verification, substantial / risky work still fires.
- The metric gate's `hasPlan` signal depends on Todolist generation, which the
  static guidance must not regress — the H3 panel includes Todolist-generation
  rate as a first-class metric (it did not regress).

### Phase 2 addendum — harness-tier collapse + Verifier metric fixes

A follow-up full-chain trace (cross-checked against an independent GPT pass)
established that the V1 H0/H1/H2 harness tier is **not just retired but
collapsed to a single constant, and was never fully cleaned**:

- `selectHarnessProfile` unconditionally returns `'H0_DIRECT'`, so
  `decision.harnessProfile` is **always `H0_DIRECT`** in V2; the runtime
  `harnessRef` is **always `'PLANNED'`**. `deriveTopologyCeiling` still emits
  H1/H2 into `upgradeCeiling`, so a request is simultaneously `decision=H0`,
  `runtime=PLANNED`, `ceiling=H2` — a semantic tear with no functional effect.
- Every branch keyed on `decision.harnessProfile` is therefore dead-or-constant:
  provider-policy's `=== H2` warning block, the repo-intelligence
  `!== 'H0_DIRECT'` overview clause, `hypothesis-check` write fan-out
  (`=== H2`, now permanently inactive), `deriveQualityAssuranceMode`'s
  `!== 'H0_DIRECT'` clause, `harnessToBudget` (dead behind
  `budget?.totalBudget ??`), and the checkpoint harness round-trip
  (`PLANNED`-identity). The dead decision-clauses were removed (P1.1–1.4);
  `harnessToBudget` + checkpoint-harness remain as harmless constants.

**Verifier work-scale gate fixes (P0)** — two coverage regressions in the H2
metric gate were found and fixed: (1) the mutation tracker omitted `multi_edit`
(a `mutates-fs` tool the Worker prompt actively encourages), so multi_edit work
produced `writeOps=0` and skipped verification; (2) line estimation used
`abs(new-old)`, collapsing equal-length rewrites to 1 line so large rewrites
slipped the fire rule — now uses touched lines (`max(old,new)`, summed across
`multi_edit` edits).

**Known remaining gap (narrow)**: H3 migrated the **AMA Worker** to static
self-judgment. **Child tasks are already clean** — every dispatched child runs
with a `systemPromptOverride` (`CHILD_AGENT_SYSTEM_PROMPT` / specialist
instructions) that bypasses `buildSystemPrompt` entirely
(`reasoning-plan-entry.ts` returns the override before
`buildCapabilityContextSections`), so the router `prompt-overlay` section never
reaches them. The only path that still injects the full router overlay is the
**explicit top-level `--agent-mode sa` session** (`capability-sections.ts`
`prompt-overlay` section) — a rare, user-selected mode. Aligning it (drop the
overlay + port the static EXECUTION GUIDANCE into `system.ts`) is an optional
LLM-facing follow-up, lower priority now that the common paths (Worker +
children) are all clean. `harnessProfile` / `KodaXTaskRoutingDecision` are
retained (the live consumers now read only the semantic fields —
primaryTask/recommendedMode/complexity/risk/mutationSurface/assuranceIntent/
needsIndependentQA — not the tier).

### Phase 3 addendum — SA alignment + dead overlay & AMA-controller removal

The "known remaining gap" above is now **closed**, and the dead routing-text
machinery it sat on top of was removed (verified by a full-chain trace + an
independent GPT pass, then build + 4053-test green):

- **P1.7 — SA path aligned.** A single static `EXECUTION_GUIDANCE` block
  (`prompts/execution-guidance.ts`) is now shared verbatim by the AMA Worker
  (`buildWorkerInstructions`) and the top-level `--agent-mode sa` path
  (`capability-sections.ts` swapped its `prompt-overlay` section for an
  always-on `execution-guidance` section). Neither path receives router overlay
  text; both self-judge from the same guidance. Validated against the canonical
  5-alias panel for both paths.
- **P1.6 — decisionSummary de-harnessed.** The role-prompt decision summary no
  longer emits `Harness:` / `Topology ceiling:` lines (regression-guarded in
  `role-prompt.test.ts`); the semantic routing fields stay.
- **#6 — router prompt-overlay text machinery deleted.** Once the Worker (H3)
  and SA (P1.7) stopped consuming it, `buildPromptOverlay`'s output reached no
  prompt (all four consumer paths dead-ended; `builder.test.ts` proves the text
  is dropped), so it was no longer LLM-facing and needed no eval — the
  eval-backed migration already happened in H3/P1.7. Removed
  `EXECUTION_MODE_OVERLAYS` + `HARNESS_PROFILE_OVERLAYS`, `buildAmaControllerOverlay`,
  `buildPromptOverlay` (+ its barrel export), `buildWorkIntentGuidance`, and the
  misleading "binding routing decision" hint. The 3 call sites set
  `promptOverlay: ''` (field retained on the plan type).
- **#4 — AMA-controller advisory chain deleted.** The FEATURE_061 AMA-controller
  pre-computed a tactical/managed profile + tactics + child-fanout admissibility
  and injected it as advice. Its consumers died in sequence (fanout-scheduler
  gate deleted in 5b7d1dad; FEATURE_193 retired the Scout managed-upgrade path;
  #6 cut the last text consumer), leaving only write-only-unread runtime
  telemetry. Removed `buildAmaControllerDecision` + helpers, the
  `KodaXAmaControllerDecision`/`KodaXAmaProfile`/`KodaXAmaTactic`/`KodaXAmaFanoutPolicy`
  types, the `amaProfile`/`amaTactics`/`amaFanout`/`amaControllerReason` runtime
  fields, the public export, and the dead `applyScoutDecisionToPlanRunner` Scout
  residue. **Capabilities are carried by live mechanisms, not the advisory:**
  approach selection by the static EXECUTION GUIDANCE, verification by the
  Sidecar Verifier gate, child fan-out by `dispatch_child_task`, and write-fanout
  safety by `validateWriteBundles` (`parentRole==='worker'`, never depended on
  the routing decision). **KEPT (then renamed): the child-fanout classification
  type** — used by `dispatch_child_task`, child bundles/status, and the REPL work
  strip, independent of the advisory. It was kept here and renamed
  `KodaXAmaFanoutClass` → `KodaXChildFanoutClass` in the follow-up below.
- **#1 / #5 — Verifier metric coverage + regression guards.** The mutation
  tracker now covers every `mutates-fs` registry tool (a source-parity test
  fails if a new one is added untracked); added the de-harness regression guards
  (`role-prompt` Harness/Topology absent + a non-harness provider-policy evidence
  case).

**Breaking (pre-1.0, internal):** removes incidental barrel exports
(`buildPromptOverlay`, `buildAmaControllerDecision`, and the `KodaXAma*` advisory
types — none in the SDK embedder guide) and the AMA runtime-state telemetry
fields.

### Phase 3 follow-ups — child-fanout rename, harness-tier dead-code, spent evals

- **`KodaXAmaFanoutClass` → `KodaXChildFanoutClass`.** The type is the child-task
  dispatch/display classification (used by `dispatch_child_task`, child
  bundles/status, the REPL work strip), independent of the deleted AMA-controller
  advisory; the legacy `Ama` prefix was misleading and was renamed across
  llm/coding/repl.
- **Harness-tier dead branches removed.** With `decision.harnessProfile` collapsed
  to a constant `H0_DIRECT`, the remaining branches were dead-or-constant and were
  folded out: `harnessToBudget` (→ the H0 constant), the payload-builder complexity
  ternary + always-true `harness === 'H0_DIRECT'` guards, `HARNESS_ORDER` /
  `getHarnessRank` (no callers), the role-prompt H2 skill-section variant (emitted
  text unchanged), the `buildFallbackRoutingDecision` H1 literal (overwritten by
  `selectHarnessProfile`), and `reviseCountByHarnessRef` (created/passed but never
  read). All behavior-preserving (coding suite green).
- **Harness-tier field KEPT as an accurate constant (decision).** The harness-tier
  *concept* (multi-tier H0/H1/H2 routing) is retired — only the single tier H0
  remains. The `harnessProfile` field (on `KodaXTaskRoutingDecision`,
  `KodaXManagedTaskStatusEvent`, `KodaXTaskContract`, checkpoint, and the REPL
  status display) now accurately reports `H0_DIRECT` (= single-pass execution),
  so it is **not** dead/misleading — it is a constant-valued but honest field.
  Removing it would be a UX change (drop the REPL harness indicator) + a public
  schema break + a checkpoint migration for ~zero benefit, so per KodaX
  minimalism the field is retained. The dead/misleading machinery (overlays,
  AMA-controller, dead branches) is what mattered, and that is gone.
- **Spent comparison evals removed.** The `h3-static-guidance-{panel,pilot}` and
  `sa-static-guidance-panel` evals compared the router overlay (`buildPromptOverlay`)
  against the static EXECUTION GUIDANCE; they reached their KEEP verdict and
  shipped P1.7/H3, after which #6 deleted the overlay baseline. The comparison can
  no longer run (baseline gone) and the substrate is unchanged since KEEP, so the
  spent drivers were deleted. The behavior stays guarded by the role-prompt /
  capability-sections unit assertions (P3#5); the KEEP verdict lives in git
  history. `decision-summary-*` evals are unaffected.

**Dead Scout cluster removed (follow-up done):** `inferScoutMutationIntent` +
its `ScoutMutationIntent` / `ScoutScopeHint` types + the
`ManagedRolePromptContext.scoutScope` field + `isReviewEvidenceTask` were a
self-contained FEATURE_193 residue (production call sites already deleted;
reachable only from their own tests; `scoutScope` never set/read). Traced the
`ScoutScopeHint ↔ scoutScope` entanglement (both dead) and removed the cluster.
All internal (`_internal/managed-task`), so no SDK-surface impact; the live
tool-policy guards are untouched.

### Phase 3 review-driven fixes (a second GPT pass on the cleanup)

A follow-up review surfaced two real defects introduced earlier in this work,
both now fixed:

- **SA Direct Path Rule + caller overlay regression.** P1.7 replaced the
  capability-sections `prompt-overlay` section (which rendered
  `context.promptOverlay`) with the static EXECUTION GUIDANCE. Its intent was to
  drop the *router* overlay, but `context.promptOverlay` also carried the SA
  task-family Direct Path Rule (output-shaping, e.g. `lookup → concise answer
  with file paths`, not covered by EXECUTION GUIDANCE) and any caller-supplied
  overlay — both dropped as collateral, uncaught because the P1.7 eval compared
  only router-overlay-vs-static. Re-emit the `prompt-overlay` section when
  `context.promptOverlay` is set, alongside execution-guidance; the router
  overlay no longer rides this channel (it lived in `reasoningPlan.promptOverlay`,
  now `''`), so only the Direct Path Rule + caller overlay return.
- **Verifier mutation-metric mislabels.** #1 added every registry `mutates-fs`
  tool to the tracker, but `scaffold_tool` / `scaffold_agent` only return a
  fillable JSON skeleton (no disk write) — they were mislabeled `mutates-fs`
  (now `readonly`) — and `activate_agent` is `mutates-state`, not `mutates-fs`,
  yet a fragile parity-test parser let it leak into the set. With the earlier
  blind-write heuristic this made the Verifier over-fire on non-fs work. Fixed
  the registry labels, hardened the parity parser (tool-level indent + reset on
  every sideEffect), reduced the set to the 9 genuine fs-mutators, and replaced
  the `writeOps>0 && filesChanged===0` heuristic with an explicit
  `tracker.unattributedWriteOps` counter (undo / worktree_* / stage_*) that the
  gate fires on — which also catches a pathless write co-occurring with an
  attributed edit. Also dropped the `reviseCountByHarnessRef` test residue left
  by the P2 step-2 removal.
- **topologyCeiling / upgradeCeiling collapsed to H0_DIRECT.** The remaining
  H1/H2-valued residue was retired the same way as `harnessProfile`: kept as a
  field but made an accurate constant. `deriveTopologyCeiling` (FEATURE_112:
  read-only/docs → H1, code/system → H2) had no live consumer
  (`inferRequiresBrainstorm` / `selectHarnessProfile` received it but never read
  it; it only reached REPL/status/payload display, where it showed a misleading
  `Upgrade ceiling: H2` for a run that can never escalate), so it was deleted and
  both call sites set the ceiling to `H0_DIRECT`. The assurance signal it keyed
  on stays queryable on the decision (mutationSurface / assuranceIntent /
  complexity / needsIndependentQA). Tests migrated to semantic (the redundant
  ceiling assertions removed — each mirrored an asserted `mutationSurface` — and
  the `reasoning-feature-112` derivation matrix deleted), plus one invariant test
  that the ceiling is always `H0_DIRECT`. This completes the harness-tier
  retirement: every routing field is now either gone or an accurate H0 constant.

---

## ADR-044: Workflow Authoring Parity with the Claude Code Harness

**Status**: Accepted — shipped in v0.7.58 (FEATURE_246; concrete decisions ratified as ADR-046/047/048).

**Context**: KodaX's Dynamic Workflow (FEATURE_217 + 231/232/234/235/236/238/245)
is a *productised, safety-first* capability: a workflow script is produced by a
separate context-blind `sideQuery` generator
([generator.ts](../packages/coding/src/workflows/generator.ts)), hard-validated
(manifest + forbidden-token + 4-scenario smoke + 2-attempt repair), executed in a
`node:vm` sandbox
([script-runner.ts](../packages/agent/src/workflow/script-runner.ts)), and its
write children get machine-checkable postcondition verification with auto-repair
([agent-adapter.ts](../packages/coding/src/workflows/agent-adapter.ts)). A
completed run can be promoted to a shareable `WorkflowCapsule`.

A 2026-06-29 investigation compared this against the Claude Code harness Workflow
tool (the orchestrating model writes a self-contained script **inline**;
free-function API `agent()/parallel()/pipeline()`; per-child `schema`/`effort`;
`resumeFromRunId` journal). 26/27 cross-checked claims confirmed against source.
Finding: KodaX is at parity-or-ahead on **safety** (sandbox, postcondition
verification, approval gate, capsule), but the **authoring-experience** gap is
real and concentrated on four axes — (1) the script is authored by a separate
generator that cannot see the main conversation ("隔一层"); (2) child results are
untyped `finalText` strings the script must `JSON.parse`; (3) no streaming
`pipeline` primitive (barrier-only `wf.parallel`); (4) no result-cache resume.
Axes (3) and (4) are **already owned** by
[FEATURE_232](features/v0.7.85.md#feature_232-replay-aware-workflow-pipeline-primitive)
(v0.7.85) and
[FEATURE_231](features/v0.7.75.md#feature_231-durable-workflow-replay-resume)
(v0.7.75). Axes (1) and (2) have no home — this ADR opens it (FEATURE_246).

**Decision**:

1. **Add a model-inline authoring path** (FEATURE_246). Register a model-callable
   workflow tool whose `script` is written directly by the orchestrating Worker
   (which carries full conversation context), and run it through the **unchanged**
   existing pipeline: `validateGeneratedWorkflowSource` →
   `createRestrictedWorkflowModule` → `runRestrictedWorkflowScript` → coding
   backend + verification. Principle: **change the author, not the safety layer.**
   The `sideQuery` generator is retained as a *fallback* for `/workflow create
   "<NL>"` and non-interactive / low-capability hosts; it is not removed.

2. **Add `outputSchema` to child spawn** (FEATURE_246). When present, the child is
   asked to end with a fenced JSON block; after it completes the workflow layer
   extracts, parses, and validates that block against a focused JSON-Schema subset
   (`type` / `enum` / `required` / `properties` / `items` / `additionalProperties`)
   and, on a hard miss, runs **one bounded repair turn** — this is the
   **validate-and-repair** path (NOT a forced structured-output tool: coupling
   validation to the actively-evolving provider tool-call parser was deliberately
   rejected — see the "validate-and-repair vs forced-tool" note in
   [FEATURE_246](features/v0.7.58.md)). `WorkflowTaskResult` carries the parsed
   `structured` object alongside `finalText`. This is **orthogonal** to
   existing `WorkflowTaskVerification` (which checks *side-effects* — did it write
   the files), so both can apply to one child. KodaX ends up a superset:
   shape-validation **and** side-effect-validation, where Claude Code has only the
   former.

3. **Small expressiveness adds** (FEATURE_246): per-child `effort` (wired to the
   existing effort-first reasoning resolver, FEATURE_233) and one-level nested
   `workflow(name, args)`.

4. **Pipeline and same-session resume are absorbed into FEATURE_246, re-derived
   against the harness.** FEATURE_232 (pipeline) and FEATURE_231 (resume) pre-dated
   any benchmark against the Claude Code harness and got the coupling backwards.
   Corrected:
   - **Pipeline ships standalone and resume-ready, NOT behind resume.** It must be
     a runtime-scheduled primitive with deterministic `pipeline/item:N/stage:M`
     scopes (a naive in-sandbox `Promise.all` cannot supply stable identities
     because the runtime sees calls in non-deterministic completion order) — but
     assigning those scopes is cheap and independent of whether resume exists.
     The dependency inverts: **resume consumes pipeline's scopes; pipeline does not
     depend on resume.** API is positional `pipeline(items, ...stages)` (drop
     232's object-config + manual ids); a throwing stage drops that item to `null`.
   - **Only the same-session parity subset of resume is kept** (deterministic
     scopes, input-hash prefix divergence, complete result cache,
     `Date.now`/`Math.random` determinism enforcement). The harness resume is
     *same-session only*; KodaX's heavier cross-process crash-recovery half of
     FEATURE_231 (write-ahead journal as execution authority, lost-write safety
     policy, attempt/corruption ceremony) is **not** parity and is split out as
     optional **231b**, not folded into 246.
   - Result: full Claude-Code authoring parity is delivered by **FEATURE_246
     alone**. FEATURE_232 is absorbed; FEATURE_231 is split (parity subset →
     246, 231b deferred).

5. **Defer the capsule metadata layer (YAGNI).** The `WorkflowCapsule` provenance
   / requirements / intent triplet is infra ahead of a real consumer (cross-user
   sharing / a marketplace), which a single-user CLI does not have — it conflicts
   with CLAUDE.md "never add for hypothetical futures / abstract after 3+ cases".
   Keep the *lightweight* saved-workflow surface (`.kodax/workflows/*` + `args` +
   discovery + `/workflow save|list|rerun`), which has a real recurring/team
   consumer. No existing capsule code is deleted; it is simply not expanded, and
   FEATURE_246 does not depend on it.

**Scope boundaries (deliberately NOT changed)**:

- Sandbox, forbidden-token policy, smoke validation, manifest validation,
  approval gate, run-graph events, postcondition verification + repair — all
  reused as-is.
- The generator and the AMAW natural-language intercept stay; model-inline is an
  *additional* entry, gated to AMAW/AMA modes like every other workflow entry
  (SA never exposes it), per
  [invocation-policy.ts](../packages/coding/src/workflows/invocation-policy.ts).
- No change to `wf.parallel` semantics; no `pipeline`; no resume (those are
  231/232).

**Consequences**:

- The Worker can decide mid-turn to fan out and write the exact topology + data
  shapes it wants, eliminating the generator round-trip and the context-blind
  translation gap for the common case.
- Scripts needing typed cross-agent data stop hand-parsing strings.
- KodaX keeps every safety property; the new tool is a thin authoring front-end
  over proven infra.
- **Eval (FEATURE_104 / ADR-033)**: the new tool's `description` field and any
  model-facing "when to author a workflow inline" guidance are LLM-facing prompt
  content → a prompt-eval is required (per `benchmark/EVAL_GUIDELINES.md`). The
  `outputSchema` enforcement is deterministic → Layer-1 unit tests. The tool
  description must follow ADR-033's 5 principles (qualitative triggers,
  single-concept sentences, why-bearing ✗-patterns, no enumerated taxonomy, no
  version metadata in the prompt body).

---

## ADR-045: LLM-Layer Robustness Batch — truncation-execution guard, alternation-preserving history repair, and the decisions deliberately NOT taken

**Status**: Accepted — shipped in v0.7.58 (2026-06-29).

**Context**: A source-level comparison of KodaX's provider-integration layer
against opencode and pi (two other multi-provider CLI agents) surfaced a set of
robustness gaps and one genuine correctness bug. opencode prevents malformed
history structurally (typed parts model + a Lifecycle stream state machine) and
leans on the Vercel AI SDK; pi centralises wire repair in a single pre-send
`transformMessages`. KodaX hand-rolls each provider to support a broader, more
adversarial provider set (Kimi / Qwen / Zhipu / Ark / MiniMax / MiMo / GLM /
DeepSeek-V4) whose wire behaviour is frequently non-conformant. KodaX's defensive
*quantity* is justified by that target set (pi independently converged on a
similarly aggressive posture); the issues were in *correctness* and
*organisation*, not in *whether* to defend.

This ADR records both what was changed and — equally important for
maintainability — what was deliberately NOT changed and why, so the trade-offs
are discoverable from the repo rather than re-derived later.

**Decision — changes made**:

1. **Truncation-execution guard (correctness, highest priority).** A provider
   that truncates a tool_use turn (`stop_reason: max_tokens` /
   `finish_reason: length`) leaves the tool-input JSON salvaged from a mid-value
   cut (e.g. half a `write` payload). Previously `checkIncompleteToolCalls` only
   flagged `undefined`/`null`/empty params, so a truncated-but-present string
   PASSED and the tool executed with corrupt input — silently, worse than failing
   cleanly. Fix: `parseToolInputWithSalvageTracked`
   ([tool-input-parser.ts](../packages/llm/src/providers/tool-input-parser.ts))
   reports whether strict `JSON.parse` threw. The provider tags two markers on
   `KodaXToolUseBlock` ([types.ts](../packages/llm/src/types.ts)): `_salvaged`
   (raw — strict parse failed, set regardless of stop) and `_truncated`
   (`_salvaged && !isCleanStop(stopReason)`). `checkIncompleteToolCalls`
   ([messages.ts](../packages/coding/src/messages.ts)) treats a block as
   untrusted — routing it into CAP-072 instead of executing — when
   `_truncated || (_salvaged && isToolMutation(name))`. Rationale (post-review,
   addressing the stop-reason-vs-integrity gap): a protocol clean stop
   (`tool_use`/`tool_calls`) does NOT guarantee argument integrity — a model can
   emit malformed-but-"complete" JSON (e.g. unescaped quotes) that partial-json
   silently truncates mid-value. So for a MUTATING tool (write/edit/bash —
   `isToolMutation`) ANY salvage is untrusted, even on a clean stop (a corrupt
   write is worse than a retry); a salvaged read-only input on a clean stop is
   allowed through (low risk, avoids a needless retry loop). `isCleanStop`
   ([stop-reason.ts](../packages/llm/src/stop-reason.ts)) is **fail-safe**: a
   truncating OR ambiguous/`unknown` stop marks `_truncated` (unsafe for any
   tool).

2. **maxed_out synthesizes a result for every VISIBLE tool_use in the turn**
   ([incomplete-tool-retry.ts](../packages/coding/src/agent-runtime/incomplete-tool-retry.ts)).
   At the retry cap, a complete tool call sharing a turn with an untrusted
   sibling was left as an orphan `tool_use` that the next serialize silently
   dropped (losing a valid call). The cap path now synthesizes a tool_result for
   every **visible** block — error for the untrusted ones, a
   "skipped — re-issue if still needed" result for complete siblings — so the
   loss is visible and recoverable and the wire stays valid. Only VISIBLE tools
   (post-review): invisible/managed tools (`emit_managed_protocol`, `todo_*`) are
   never in the assistant wire history (run-substrate uses `visibleToolBlocks`),
   so synthesizing a result for them would create an orphan tool_result — the
   normal path (`applyPostToolProcessing`) already gates on `isVisibleToolName`.

3. **Alternation-preserving history repair (real bug fix).**
   `validateAndFixToolHistory` ([history-cleanup.ts](../packages/agent/src/runtime-middleware/history-cleanup.ts))
   previously **dropped** a turn that orphan-stripping fully emptied. A
   mid-conversation drop produces `user,user`, which Anthropic rejects with a
   400. It now holds the slot with an empty-text marker (both roles) — matching
   the wire-level `repairToolCallHistory`, which already replaced an emptied turn
   with a wire-only `'...'` for exactly this reason. This aligns the two layers
   on the alternation invariant.

4. **Partial-on-known-stop** ([anthropic.ts](../packages/llm/src/providers/anthropic.ts)).
   Anthropic sends `stop_reason` in `message_delta`, before the `message_stop`
   envelope. If the stream cuts in that window, the content is already complete,
   so the provider now returns the partial instead of throwing
   `StreamIncompleteError` and re-billing the whole turn. It still throws (and
   retries) when `stop_reason` is also absent — a true mid-stream cut. OpenAI
   already gated on a missing `finish_reason`, so it was unchanged.

5. **Conservative tool-name repair, single-point**
   ([tool-name-repair.ts](../packages/coding/src/agent-runtime/tool-name-repair.ts)).
   A name differing from an active tool only by case/separators (`Write` →
   `write`) is rewritten via `repairToolBlockNames`. **Unique normalized match
   only — never edit-distance** (no `red` → `read`). The repair runs ONCE in
   [run-substrate.ts](../packages/coding/src/agent-runtime/run-substrate.ts) on
   the stream result, before any consumer (history, dispatch bash
   sequential-vs-parallel routing, tool events, the incomplete-tool param scan),
   so the canonical name is used uniformly and `tool:start`/`tool:result` never
   disagree.

6. **No silent malformed-block drop** ([openai.ts](../packages/llm/src/providers/openai.ts)).
   A tool_call missing id/name is dropped (cannot be paired with a tool_result)
   but now logged, at parity with the Anthropic path.

**Decision — deliberately NOT taken (recorded so they are not re-investigated)**:

- **Single pre-send normalizer (pi-style) — REVERTED.** Lowering
  `validateAndFixToolHistory` into the LLM layer and calling it at the top of
  every `convertMessages` was attempted and reverted: the wire-level
  `repairToolCallHistory` ALREADY runs unconditionally in both adapters and
  preserves alternation, so bypass paths were never unprotected. Running validate
  (whose pre-fix semantics *drop* an emptied turn) at the `convertMessages` entry
  *regressed* alternation — locked by
  [anthropic-message-serialization.test.ts](../packages/llm/src/providers/anthropic-message-serialization.test.ts).
  The real latent bug it would have addressed (validate's drop) is fixed directly
  by change #3 above. A future unification would need a single
  alternation-preserving strategy across all three orphan sites and is ADR-scoped
  on its own; it is not required for correctness now.

- **De-duplicating the two `repairToolCallHistory` implementations — WON'T DO.**
  The Anthropic version operates on a content-block array with a role-alternation
  constraint; the OpenAI version operates on separate `role:'tool'` messages with
  no such constraint. They are format-specific by necessity; merging would add an
  abstraction layer for no correctness gain. The resulting three-site orphan logic
  (one canonical `validateAndFixToolHistory` + two wire-format nets) is
  intentional defense-in-depth, consistent with KodaX's broader provider target.

- **Switching compaction-summary injection from `role:'system'` to `role:'user'`
  (retiring `normalizeSystemForWire`) — WON'T DO (for now).**
  `normalizeSystemForWire` ([openai.ts](../packages/llm/src/providers/openai.ts))
  is working, tested code; the mid-transcript `system` injection is not a defect,
  only a stylistic difference from pi. Changing the summary's wire role is
  LLM-facing and would require a prompt-eval (per `benchmark/EVAL_GUIDELINES.md`)
  for a cleanliness-only gain. If pursued later it is an eval-gated FEATURE, not a
  refactor.

- **Non-streaming mid-value truncation — DOCUMENTED LIMITATION.** Anthropic's
  non-streaming `complete()` returns a parsed `input` object with no raw buffer,
  so there is no salvage signal; a truncation that lands mid-value in the last
  field while leaving all required keys present is not detectable, and flagging
  every tool_use on a `max_tokens` non-streaming stop would over-trigger on
  complete small calls. The omission is documented in-code at the construction
  site. Residual risk is bounded: non-streaming is a fallback path (e.g. GLM 308),
  and the common empty-field truncation is still caught by
  `checkIncompleteToolCalls`.

- **`cleanupIncompleteToolCalls` still drops a fully-emptied LAST message —
  NOT A BUG / INTENTIONAL.** Unlike change #3, this guard touches only the tail
  message; dropping it cannot create a mid-sequence `user,user` (nothing follows)
  and is *more* correct than holding a marker — a trailing `'...'` assistant turn
  would become a nonsensical Anthropic assistant-prefill. The divergence from
  `validateAndFixToolHistory` is position-based and deliberate.

**Consequences**:

- The truncation guard converts a silent data-corruption path (executing a
  half-written tool payload) into a visible, recoverable retry — the
  highest-value item in the batch.
- The alternation fix removes a latent Anthropic 400 that could fire whenever
  compaction/microcompaction emptied a mid-conversation turn.
- Net new public surface in `@kodax-ai/llm`: `isCleanStop`,
  `KodaXToolUseBlock._truncated`, `parseToolInputWithSalvageTracked` — all
  additive.
- Verification is deterministic (Layer-1): no LLM-facing prompt content changed,
  so no prompt-eval is required for this batch. The only eval-gated item (the
  compaction-summary role switch) was explicitly deferred above.
- The three-site orphan-repair architecture (validate + two wire nets) is
  retained as deliberate defense-in-depth; a future single-strategy unification,
  if undertaken, supersedes the REVERTED decision above and must preserve the
  alternation invariant established here.

---

## ADR-046: Workflow Run Management — Neutral Lifecycle Manager in `@kodax-ai/agent` via Dependency Inversion

**Status**: Accepted — shipped in v0.7.58 (FEATURE_246 A0/A1: `createWorkflowRunManager` lifted to `@kodax-ai/agent`).

> Extends [ADR-044](#adr-044-workflow-authoring-parity-with-the-claude-code-harness).
> (ADR-045 was concurrently taken by the LLM-layer robustness batch; this is 046.)

**Context**: "Start / manage a workflow run" (mint a run id, register the run,
pause / resume / stop, track process events, settle terminal status) is a
capability a *generic* agent should have — KodaX SDK customers explicitly need
to host and manage workflow runs without the coding agent. Today the lifecycle
core lives in `@kodax-ai/coding`
([run-manager.ts](../packages/coding/src/workflows/run-manager.ts)) and the
start-glue (mint run id + run dir, wire the manager) was hand-rolled in the REPL
([workflow-command-builder.ts](../packages/repl/src/commands/workflow-command-builder.ts)
`startGeneratedWorkflowFromRequest`). Two problems: (1) a coding-layer
model-callable `run_workflow` tool (FEATURE_246 Part A) cannot reach a
REPL-owned start path without a layer violation; (2) the lifecycle core is
domain-neutral but trapped under coding, so non-coding SDK hosts can't use it.

The natural worry is that lifting it to `@kodax-ai/agent` creates a cycle,
because a run *executes* coding-specific things (the child-executor backend,
run-graph fs persistence, git worktrees, `KodaXOptions`→backend). Investigation
shows that coupling is **already inverted or trivially invertible**: the backend
is the existing `WorkflowAgentBackend` *interface* (agent), persistence is just
an `onEvent` subscriber, worktrees are caller finally-hooks, and the manager's
own work (registry / pause-resume / process tracker / settle) touches none of
them.

**Decision**: Lift the **neutral lifecycle core** into
`@kodax-ai/agent/workflow` as `createWorkflowRunManager`, keep every
coding-specific concern in `@kodax-ai/coding` injected through ports. Arrows
stay **coding → agent** only; agent never imports coding → no cycle.

1. **Agent (neutral) — `createWorkflowRunManager` + `getDefaultWorkflowRunManager`.**
   Owns the run registry, process tracker, abort controller, pause/resume/stop,
   `subscribeWorkflowProcess`, `settle`. `start` is **generic over the run
   outcome** and takes execution as an injected thunk — it never knows *how* a
   run executes:
   ```ts
   start<TOutcome>(input: {
     runId: string; workflow: string;
     phases?; maxAgents?; plannedAgents?; tokenBudget?;
     processMetadata?: WorkflowProcessMetadata;   // moved to agent (with the tracker)
     signal?: AbortSignal;
     runFn: (hooks: { onEvent; signal; beforeSpawn }) => Promise<TOutcome>;
     classify: (outcome: TOutcome) => { status: 'completed'|'failed'|'denied'; error?; resultText? };
     onError: (error: unknown) => TOutcome;
   }): ManagedWorkflowRun<TOutcome>
   ```
   Depends only on agent-internal `runWorkflow`, `WorkflowEvent`,
   `WorkflowAgentBackend` (interface), and the process tracker.

2. **Coding (specific) — stays, injected via ports.** `createCodingWorkflowBackend`,
   run-graph persistence (an `onEvent` subscriber + terminal `run.json`),
   worktree sweep (caller finally-hooks), generator, discovery, invocation-policy,
   runs-root, and the `KodaXOptions`→backend factory remain in coding. The coding
   `WorkflowRunManager` becomes a **thin adapter** preserving its current API
   (`start` / `startFromOptions` / list / pause / …) by building a `runFn` from
   `runWorkflowModule` / `runWorkflowFromOptions` and delegating lifecycle to the
   agent manager. **No coding caller signature changes.**

3. **REPL (UI).** `/workflow` + the AMAW intercept call a coding host entrypoint
   (`startManagedWorkflow`, FEATURE_246 Part A1) instead of hand-rolling
   run-id / run-dir / manager wiring; the REPL keeps only approval rendering +
   progress.

**Why no cycle (checked):** the agent manager imports only `./runtime`,
`./events`, `./process`, `./types` (all agent-internal). The coding adapter
imports `@kodax-ai/agent` + the coding backend/run-graph. Every edge points
coding → agent; `madge` stays clean.

**Scope boundaries (deliberately NOT moved):** `clampWorkflowLimits`,
`SYSTEM_WORKFLOW_LIMITS`, `buildApprovalSummary`, and `WorkflowHostPolicy.autoStart`
stay in coding — the neutral manager does not clamp limits or build approval
summaries (its caller's `runFn` does). Only the run-process metadata *type*
(`WorkflowProcessMetadata`) moves to agent, where the process tracker that
consumes it already lives.

**Consequences**:
- A non-coding SDK host gets full run management from `@kodax-ai/agent` by
  supplying its own `WorkflowAgentBackend` + an `onEvent` persistence subscriber.
- The coding `run_workflow` tool (FEATURE_246 Part A) reaches the SAME lifecycle
  via the coding host + `ctx.workflowHost`, no layer violation.
- One-shot replacement, not a dual path (`no_parallel_refactor_paths`): coding's
  `run-manager.ts` becomes an adapter in one move; existing `run-manager.test.ts`
  / `workflow-command` tests stay green (parity), plus new agent-side manager
  tests with a fake `runFn` (zero coding).
- **No eval**: pure structural refactor, no LLM-facing prompt content changed.

---

## ADR-047: Workflow Invocation — Worker-Authored "Scout-then-Author" Primary; Blind `sideQuery` Generation Demoted to Fallback; AMAW Defers to the Worker

**Status**: Accepted — shipped in v0.7.58 (2026-06-29). Implementation: A3.1
`f53a7325`; A5 `690f4f50` (wire) / `61489da9` (policy) / `b4054a43` (REPL
dead-branch removal) / `48dc508e` (cleanup). See
[FEATURE_246 A3.1/A5 status](features/v0.7.58.md).

> Extends [ADR-044](#adr-044-workflow-authoring-parity-with-the-claude-code-harness)
> + [ADR-046](#adr-046-workflow-run-management--neutral-lifecycle-manager-in-kodax-aiagent-via-dependency-inversion).

**Context**: KodaX's `/workflow create "<NL>"` generates a script via
`generateWorkflowFromOptions` → a single `sideQuery` call with **`tools: []`**:
the model that writes the script has **no tools — it cannot grep/read/investigate**,
it only sees the one-line request. So it can only emit *generic* scripts
("investigate X" / "review Y") and pushes all the real scouting onto the child
agents, which then re-discover (often the wrong files). The AMAW path is worse:
the pre-LLM natural-language intercept (`decideWorkflowInvocation` → `auto-start`
→ `startGeneratedWorkflowFromRequest`) blind-generates **before the Worker ever
sees the message**, so the Worker never gets to investigate.

This is the **structural root** of why KodaX workflows feel disjointed while the
Claude Code harness feels smooth: in the harness the script is the *product* of
investigation (the orchestrating agent scouts first — discovering real files,
sub-problems, data shapes — then bakes those findings into the child prompts),
not its trigger. **Eval evidence** (FEATURE_246 A3 5-alias panel): coding-plan
models *do* scout-first (read/grep) but most don't bridge to `run_workflow`; only
kimi/mmx bridge. The missing piece is the *scout-then-author bridge*, not more
generator tuning.

**Decision**:

1. **Worker-authored `run_workflow` (FEATURE_246 Part A) is the PRIMARY
   interactive path.** The Worker has the full toolset + conversation context, so
   it can scout first and then author a workflow whose child prompts carry
   concrete findings (file:line, real dimensions, a real `outputSchema`).

2. **The `run_workflow` description teaches scout-then-author (A3.1).** It must
   say: investigate with your own tools first; bake the findings into the child
   prompts; do **not** emit a generic blind script that re-delegates all scouting
   (the failure mode that makes workflows feel disjointed). LLM-facing →
   FEATURE_104 eval re-run on the 5-alias panel (expected: the scout-first models
   now bridge; negatives still don't over-trigger).

3. **AMAW no longer pre-empts the Worker.** The AMAW pre-LLM natural-language
   intercept is removed — natural-language flows to the Worker, which has
   `run_workflow` + the scout-first guidance and decides itself. This trades the
   "blind-generate saves a Worker turn" micro-optimization for the smooth
   experience (user-approved AMAW semantics change).

4. **The blind `sideQuery` generator is DEMOTED to a fallback, not deleted.** It
   survives only for (a) the explicit `/workflow create` command and (b)
   non-interactive / CI / low-capability hosts that have no investigating Worker.
   It is **not** upgraded with tools — that would rebuild a second full agent when
   the Worker already is one (CLAUDE.md minimalism).

5. **The REPL wires `options.workflowRunsBaseDir`** so the Worker's
   `ctx.workflowHost` is live; without it `run_workflow` no-ops.

**Cleanup (reliability + maintainability):** once the AMAW intercept is removed,
the natural-language intercept glue becomes dead/redundant — the
`decideWorkflowInvocation` `auto-start` branch for AMAW NL and the two REPL
`runWorkflowInvocation` NL paths (repl.ts + InkREPL.tsx). Simplify
`decideWorkflowInvocation` to the command-suggest + negation-detect surface it
still needs, remove the dead NL-auto-start glue, and audit `generateWorkflow*` so
the surviving fallback is cohesive and clearly documented as such. Re-verify
against HEAD before deleting; preserve genuine fallback coverage.

**Consequences**:
- The smooth scout-then-author flow becomes the default; disjointed blind scripts
  only happen on explicit `/workflow create` or headless hosts.
- AMAW becomes "the Worker is equipped + nudged to use `run_workflow`", not "the
  harness blind-generates ahead of the Worker".
- Net REPL surface shrinks (one start path + the fallback command), improving
  maintainability.

**Scope boundaries**: `/workflow <name>` (start a known workflow), saved capsules,
run-graph, and the run manager are unchanged. The sideQuery generator's internals
(validation/repair/smoke) stay as the fallback's safety.

**`/workflow` command intelligence (FEATURE_246 follow-up).** Applying the same
"the Worker authors, the host doesn't blind-generate" principle to the commands:
- `/workflow create <request>` in **ama/amaw** no longer blind-generates — it
  returns a prompt-source invocation that hands the request to the Worker
  (scout-then-author via `run_workflow`) through the existing command→agent-turn
  seam. Blind `sideQuery` generation stays only as the **headless / CI** fallback
  (no Worker to author). Same for the new shorthand below. (Superseded for SA by
  the activation-semantics amendment below: SA rejects execution-class workflow
  commands outright rather than blind-generating.)
- `/workflow <request>` (first word is neither a subcommand nor a known workflow
  name) is shorthand for `create`; bare `/workflow` still lists; `/workflow
  <known-name> [args]` still starts that workflow. One shared `createWorkflowFromText`.
- `/workflow revise` is intentionally **left as the capsule-management op** (load
  → generate revised → save): it is a save-as-capsule operation, and it already
  has the original script as context, so it is far less "blind" than `create` was.
  Pure management/lifecycle subcommands (list/runs/show/pause/resume/stop/delete/
  prune/save/rename/rerun) stay mechanical by design — deterministic ops on known
  artifacts, where LLM mediation would be over-engineering.

**AMA vs AMAW vs SA — workflow activation semantics (FEATURE_246 follow-up, v0.7.58).**
A5 removed the AMAW pre-LLM auto-intercept, which had been the *only* behavioral
difference between AMA and AMAW — leaving them functionally identical (both gave
the Worker a standing `run_workflow`). That collapsed the user's intended
three-mode model. Re-established here, with one principle: **there is a single
workflow path — a Worker turn with `run_workflow` (scout-then-author) — and the
modes differ only in who may pull the trigger.**
- **SA (Solo)** runs a single agent: no workflows, no sub-agents. The sub-agent +
  workflow tool cluster (`dispatch_child_task`, `run_workflow`, `task_output`,
  `task_stop`, `send_message`, `emit_managed_protocol`) is stripped from its
  surface (`SA_SOLO_EXCLUDE_TOOLS` in `task-engine.ts`), and the execution-class
  `/workflow` subcommands (`create` / run-by-name / `rerun`) are refused with a
  hint to switch modes. Read-only / management subcommands still work.
- **AMA** is command-gated: the Worker has **no standing `run_workflow`**, so it
  never self-activates a workflow from natural language. The `/workflow` command
  still gives full capability — its authoring turn is **elevated to amaw for that
  turn only** (`CommandInvocationRequest.agentModeOverride`), so the Worker gets
  `run_workflow` and runs the same scout-then-author flow as AMAW. The session
  mode is unchanged.
- **AMAW** is AMA plus self-activation: the Worker has a standing `run_workflow`
  and may decide from natural language to author and run a workflow. `/workflow`
  behaves identically to AMA.
- **Mechanism.** `buildWorkflowToolHost` gates the host to `agentMode === 'amaw'`
  only; the AMA command turn reaches it already elevated. Tool **visibility follows
  capability** — `run_workflow` is shown to the managed Worker only when
  `ctx.workflowHost` is wired (`agent-chain.ts`), so plain AMA is never offered a
  tool that would just error. The `dispatch_child_task → run_workflow` nudge is
  likewise **host-conditional**: it is appended to the Worker's dispatch
  description only when a host is wired (`DISPATCH_RUN_WORKFLOW_NUDGE`), so plain
  AMA's dispatch description never points at a tool it lacks, and AMAW's stays
  byte-identical to before. Pinned by CAP-TOOL-CTX-009/010 and the FEATURE_168
  worker-surface tests (both run_workflow and its nudge are host-conditional).
- **Verification.** The *gating* is a tool-availability fact (present/absent),
  verified by contract/unit tests, not an LLM eval. The *host-conditional nudge*
  is LLM-facing, so it carries a focused Layer-2 eval
  (`tests/feature-246-ama-command-gating.eval.ts`): on a synthesizable fan-out
  task the AMA Worker (no `run_workflow`, no nudge — byte-identical to the proven
  pre-FEATURE_246 AMA surface) degrades to `dispatch_child_task` and never
  references the absent tool. Result (canonical 5-alias panel, RUNS=3): **phantom
  (mentions-absent-run_workflow) = 0% on every alias**; dispatch mean 53% (the one
  0% alias scouts-first with bash, an anti-pattern-11 first-action floor, not a
  failure). AMAW's surface is byte-identical to the post-A3 state, so the prior A3
  bridge-rate eval still applies to it unchanged.

**Hardening + non-goals (FEATURE_246 Part D/E round)**:
- **Recursion guard is an invariant, not a runtime check.** A workflow child runs
  with `agentMode: 'sa'`, and `buildWorkflowToolHost` only wires `ctx.workflowHost`
  for `amaw` (see the activation-semantics amendment below — plain AMA and SA get
  none) — so a child can never call `run_workflow` (it is a no-op / unavailable).
  This is guaranteed *by construction*; do NOT let a child inherit `amaw` or the
  guard breaks. Pinned by CAP-TOOL-CTX-010 (ama / sa / unset → no `workflowHost`).
  One-level nesting for `wf.workflow(...)` is likewise enforced in the runtime (the
  sub-api's `workflow` throws).
- **Untrusted-input quarantine is a known non-goal.** KodaX is a single-user CLI;
  the workflow sandbox protects against an errant *script*, not a malicious
  *operator*. We deliberately do not add a capability-quarantine tier for
  untrusted inputs — there is no multi-tenant consumer (YAGNI; revisit only if a
  hosted/multi-user surface appears).
- **Ceremony on the inline path stays minimal but the hard sandbox stays.** The
  Worker's `run_workflow` runs the model-authored script through the same
  restricted `node:vm` sandbox + manifest validation as everything else (the
  load-bearing safety boundary). We do NOT add a per-run approval prompt on top of
  the already-sandboxed inline path — that ceremony would be friction without
  safety value. The hard sandbox is the parity *advantage* over the harness, kept.
- **Why scout-then-author beats "be lazy".** The `run_workflow` description teaches
  investigate-first because a blind re-delegating script is the failure mode; this
  plus KodaX's postcondition verification + repair (which the harness lacks) is the
  anti-laziness story — KodaX verifies child *side-effects*, not just shape.

**Review hardening (external review of the activation-semantics work, v0.7.58):**
- **Inline `run_workflow` now surfaces live progress (P1).** Previously only the
  slash `/workflow` path subscribed to the run's process events, so a
  Worker-launched workflow showed as one opaque long tool call. `buildWorkflowToolHost`
  now mints the run id, subscribes to `manager.subscribeWorkflowProcess` filtered to
  that run, and forwards events to `options.events.onWorkflowProcessEvent`. The Ink UI
  renders them through the same work-strip as the slash path (shared
  `applyWorkflowRunUiEvent`); the plain console prints concise start/finish lines.
  No-op when no sink is wired (SDK/headless).
- **The inline path now shares the generator's static source checks (P2).** The
  primary path must not be less-protected than the blind fallback: the inline branch
  runs `validateGeneratedWorkflowSource` (literal task targets, legacy `.output`,
  forbidden host/IO tokens, non-displayable return) so a malformed Worker-authored
  script fails fast with an actionable tool error instead of a late runtime crash.
  The heavier multi-scenario *smoke* run stays generator-only — it would add latency
  to every `run_workflow` call, and the inline author is a Worker with a
  runtime-error retry loop, unlike the one-shot generator.
- **Why not run the generator smoke on the inline path.** The smoke stub
  (`createSmokeWorkflowApi`) never sets `result.structured` and its `synthesize`
  returns only `{ text }` — but the inline textbook teaches `outputSchema →
  result.structured`. So running full smoke on inline would FALSE-REJECT valid
  structured-output Worker scripts. The right pattern is therefore *targeted runtime
  validation*, not a smoke dry-run: enforce the same contracts the smoke checks
  directly in the real runtime, where they are loud on every path (generator +
  inline) and the Worker's retry loop can act on them.
- **Inline runtime now matches the smoke's task-id contract (adversarial self-review).**
  The smoke was loud on unknown task ids where the real runtime was silent — a
  silent quality-degradation gap on the inline path. Closed: (a) `evidenceRefs`
  validation at spawn (`assertValidWorkflowEvidenceRefs`) now also takes the run's
  known task ids and rejects a `task_id:<never-spawned>` ref (an agent name or typo)
  loudly, matching the smoke's `assertKnownTaskId`; (b) `wf.snapshot/output`,
  `wf.send`, and `wf.stop` now throw `unknown workflow task` on a never-spawned id
  (previously they returned a fabricated `running` snapshot / silently no-op'd),
  matching `wf.wait`. A known in-flight task still polls `running`. This makes the
  inline path's dynamic-coordination contract as strict as the generator's without
  the smoke's false-reject risk.

## ADR-048: Same-Session Workflow Resume — Structural Effect Scopes + Injected Result Cache (FEATURE_246 Part D)

**Status**: Accepted — implemented in v0.7.58 (FEATURE_246 Part D): sandbox
determinism guards + content-addressed result cache (runtime + fs) + the
`run_workflow resumeFromRunId` entry. (The `/workflow resume` slash command is a
follow-up; the model-callable entry shipped.) The implementation chose
content-addressing over structural scopes — see Decision below.

> Extends [ADR-044](#adr-044-workflow-authoring-parity-with-the-claude-code-harness)
> + [ADR-046](#adr-046-workflow-run-management--neutral-lifecycle-manager-in-kodax-aiagent-via-dependency-inversion).
> The parity subset of the (dropped) FEATURE_231; cross-process crash recovery is
> explicitly out of scope (→ 231b).

**Context**: The harness's *same-session resume* — relaunch after a pause/kill or a
**script edit**, and "the longest unchanged prefix of `agent()` calls returns
cached results instantly; the first edited/new call and everything after runs
live." It is an **iteration accelerator** for expensive, tweaked-and-re-run
workflows, not crash recovery. KodaX had only from-scratch `rerun` (no result
cache). Real-harness usage showed resume at 0/3, so it trails B/C/E — but it is
part of *completeness + reliability* parity with the harness the Worker now
authors against (user decision).

**Two findings that shape the design**:
1. **The run-graph cannot be the cache.** `events.jsonl` stores only a *bounded
   summary* of each agent result (for UI/audit), not the full `finalText` /
   `structured`. Resume must return results **verbatim**, so it needs a dedicated
   full-result cache (`results/<scope>.json` in the run dir), not a re-read of the
   run graph.
2. **A positional/call-order scope is NOT deterministic under a concurrency cap.**
   KodaX's `parallel`/`pipeline` are *sandbox helpers* (the vm has no
   AsyncLocalStorage to carry an async-context scope), and a launch-order counter
   shifts with real completion timing when `maxConcurrency < items`. So the cache
   identity must not depend on call order at all → **content-addressing**.

**Decision** — content-addressed result cache (no scopes, no latch, no Part C
re-architecture):

1. **Cache key = `inputHash # occurrence`.** `inputHash` is a SHA-256 of the
   canonicalized (sorted-key) spawn input (name/prompt/readOnly/subagentType/
   modelHint/isolation/effort/evidenceRefs/verification/outputSchema/phase).
   A per-`inputHash` occurrence counter (incremented at each `runAgent` call)
   disambiguates two calls with identical input. **The input hash already encodes
   the dependency graph**: a dependent effect bakes the upstream result into its
   prompt, so if an upstream result changes the dependent's hash changes too and
   it re-runs — automatically, without a prefix latch. Distinct inputs are
   order-independent; identical inputs map to interchangeable results, so the
   occurrence order under concurrency does not affect correctness.
2. **Cached value = the full `WorkflowTaskResult`** (incl. Part-B `structured`),
   stored verbatim so a hit returns exactly what the first run produced. Only
   *successful* results are cached — a failed/stopped child (E-d → `null`) is
   never cached, so it re-runs live.
3. **Injected cache port (dependency inversion).** The agent runtime is fs-free,
   so it takes an optional `resultCache` port (`get(key)` / `set(key, result)`)
   and does the hashing + occurrence + lookup in `api.runAgent`. The coding layer
   provides the fs-backed impl rooted at the run dir (`results/<key>.json`); the
   agent layer never touches disk (ADR-021). Because every inline-script
   `runAgent` flows through the runtime api (sandbox RPC → `api.runAgent`), this
   one seam covers inline scripts *and* built-in modules with no sandbox change.
4. **No prefix-divergence latch needed.** Content-addressing re-runs exactly the
   effects whose input changed (a strict improvement over the harness's
   conservative "everything after the first change"), because dependencies flow
   through the input hash.
5. **Determinism enforced in the sandbox bootstrap.** `Date.now`, `Math.random`,
   and argless `new Date()` throw inside workflow scripts — a script that read
   them would make replay diverge. (Pass timestamps via `args`; vary by index.)
   Shipped in 5.3.
6. **Resume entry points.** `run_workflow` accepts `resumeFromRunId`; `/workflow
   resume <runId>` re-runs a prior run's persisted `script.js` with its
   `results/` seeded as the cache. A fresh run id/dir is minted; the prior dir is
   read-only input.

**Consequences**:
- Editing a stage and re-running re-pays only that effect and whatever genuinely
  depended on it; an unchanged re-run is a 100% cache hit. Inline authoring (Part
  A) makes this stable by construction — the same script is re-submitted.
- A cache hit skips the spawn (no `agent_spawned`/`agent_completed` events), so
  the resume run's progress shows only the live effects — cached ones are
  "instant", matching the harness.
- Known limitations (documented, not guarded — adversarial review FEATURE_246
  Part D):
  - Two effects with *identical inputs but position-dependent meaning* may have
    their cached results assigned in a different occurrence order on resume. Rare
    (agents normally have distinct prompts) and only affects position-sensitive
    identical-input fan-outs.
  - `wf.budget.spent()`/`remaining()` reflect only *live-run* token usage — a
    cache hit skips the spawn and the accrual, so budget under-reports on resume.
    Don't gate live-agent launches on `remaining()` in scripts meant for resume.
  - `wf.synthesize` is intentionally NOT cached (it runs through `runAgentImpl`
    directly): it is the terminal fold over the (possibly cached) findings, cheap
    relative to the fan-out, and freshly folding the replayed results each resume
    is the desired behavior.
- New behavior: the determinism guards can break a script that (mis)used
  `Date.now`/`Math.random`; the error names the banned API and how to fix it.
- DROPPED (→ 231b): write-ahead journal as execution authority, cross-process /
  Ctrl+C / process-restart recovery, lost-write safety policy, attempt counters.
  Same-session resume just re-runs the non-cached effects live.

## ADR-049: Async `run_workflow` — Idle-Yield (FEATURE_155 reuse) + Per-Agent Digests to History

**Status**: Accepted — targeted at v0.7.58 (FEATURE_246 parity completion). Extends
[ADR-046](#adr-046-workflow-run-management--neutral-lifecycle-manager-in-kodax-aiagent-via-dependency-inversion)
+ [ADR-047](#adr-047-workflow-invocation--worker-authored-scout-then-author-primary-blind-sidequery-generation-demoted-to-fallback-amaw-defers-to-the-worker).

**Context**: FEATURE_246 Part A made `run_workflow` a **blocking** tool — the Worker
calls it and `await`s the entire workflow (`host.runInline` → `await managed.done`,
tool-execution-context.ts). The P1 review round added a live progress *strip* but
left two gaps vs the slash `/workflow` path, `dispatch_child_task`, and the Claude
Code harness — both surfaced by real usage (v0.7.58 dogfood, a multi-agent self-review
that ran 18+ minutes):
1. **No idle-yield.** Because the tool blocks, the Worker turn is mid-tool for the
   whole run; the REPL is locked — slash commands are refused (`slash-mid-task-guard`),
   follow-ups only process after the workflow finishes. `dispatch_child_task` is
   async (FEATURE_155 idle-yield): the Worker ends its turn, the runner resumes it on
   completion, so the user can keep chatting.
2. **Per-agent completions don't reach history.** The slash path's `workflowEventSink`
   formats `agent_completed` / `agent_summary_updated` events via
   `formatWorkflowAgentDigest` → `onWorkflowRunMessage` → transcript. The inline path
   only wired the aggregate `onWorkflowProcessEvent` strip, so completed workflow
   agents vanish from the live surface with no summary preserved in scrollback (unlike
   `dispatch_child_task` children, whose digests land in history).

**Decision**:

1. **`run_workflow` becomes async / idle-yield, reusing FEATURE_155.** Instead of
   awaiting `managed.done`, the tool: (a) starts the workflow (a non-blocking host
   start that returns the `managed` handle), (b) registers `managed.done` — resolving
   with the synthesis text (or a failure summary) — in the **Worker's**
   `ctx.childTaskRegistry` via `registerChildTask` (the same registry/loop dispatch
   uses), (c) returns immediately: *"Workflow `<name>` started (run-X); its synthesized
   result will arrive as a completion block for task X — idle-yield or do other work."*
   The Worker ends its turn text-only; the runner's **existing** idle-yield outer loop
   (runner-driven.ts, FEATURE_155) awaits the registry and resumes the Worker with the
   synthesis when `managed.done` resolves.
   - **Resume banner**: reuse the existing `<task-completed task_id="X">…synthesis…
     </task-completed>` (drain.ts) — the tool's return told the Worker that task X *is*
     the workflow, so it reads the block as the workflow result. A distinct
     `<workflow-completed>` tag is a clarity nice-to-have that needs a banner-kind tweak
     in `drain.ts` / `idle-yield.ts`; **deferred** unless it proves cheap (YAGNI — the
     task_id already disambiguates).

2. **Per-agent digests to history.** Add a `KodaXEvents.onWorkflowAgentDigest` hook.
   The inline path forwards the workflow's per-agent `agent_completed` /
   `agent_summary_updated` events through it (reusing `formatWorkflowAgentDigest`); the
   REPL writes each completed agent's summary to the transcript — matching the slash
   path and `dispatch_child_task`. Independent of (1): it should hold whether the
   workflow blocks or yields.

3. **Worker prompt + `run_workflow` description** teach the async contract (mirror the
   `dispatch_child_task` idle-yield wording): after `run_workflow` returns, the result
   is not inline — idle-yield; it arrives as a completion block later.

**Consequences**: the REPL stays responsive during a workflow (chat-while-waiting);
the Worker can interleave other work; completed agents' findings persist in scrollback;
`run_workflow` matches `dispatch_child_task`'s async model and the Claude Code
background-workflow experience. The blocking "waiting for tool output" lock is removed.

**Non-goals / risks**: cross-process resume stays out of scope (same-session per
ADR-048). The synthesis is delivered once (the registry entry settles once). The main
risk is the execution-model change — mitigated by reusing the proven FEATURE_155
registry + idle-yield loop (no parallel machinery) and pinning register/resume +
digest-to-history with contract/unit tests; structural change, no eval. Verified by
dogfood: the same self-review should run without locking the REPL and leave each
agent's digest in history.

## ADR-050: Tool-Output 语义压缩层 —— 命令感知的 in-tool 压缩（rtk-style Token Killer 移植, FEATURE_251, v0.7.61）

> **历史原始决策（2026-07-05）。** 本节直到“后果 / 测试”为止记录 v0.7.61 当时发布的
> 行为，不描述当前默认策略。当前权威决策是下方“2026-07-14 纠偏决策”；两者冲突时以后者
> 为准。

**背景**。参考项目 `rtk (Rust Token Killer)` 是一个外部 CLI 代理：别的 agent（Claude Code 等）通过 `PreToolUse` hook 把 `git status` 重写成 `rtk git status`，由 rtk 执行真实命令并**在输出进入 LLM context 前压缩 60-90%**——四类策略：智能过滤 / 分组聚合 / 截断 / 去重，覆盖 100+ 命令（git/cargo/npm/pytest/go/docker/kubectl/aws…）。KodaX 当前的对应能力是**空白**：[bash.ts](../packages/coding/src/tools/bash.ts) 的 `toolBash` 对命令输出只做**尾部截断**（`truncateTail` 600 行/32KB，bash.ts:395）+ 采集期字节封顶（512KB），没有任何命令感知的语义压缩——一次完整的 `git status`/`cargo test`/`npm install` 原样进 context。两条派发路径（SA `runToolDispatch`→`applyToolResultGuardrail`，tool-dispatch.ts:334/362；AMA `runnerGuardrails`，runner-driven.ts:1389）也只做 per-tool 字节/行截断（[tool-result-policy.ts](../packages/coding/src/tools/tool-result-policy.ts) `TOOL_RESULT_POLICIES`），是纯语法层。

**核心决策**。把 rtk 的**语义压缩能力**移植进 KodaX，但**抛弃 rtk 一半的架构**：rtk 的命令重写子系统（`discover/` 词法器 + 复合命令拆分 + `classify_command` + hook 协议）与 SQLite `tracking`/`gain`/`discover` 分析，**只是因为 rtk 是外部 hook 二进制、必须从一个 bash 字符串反推意图**。KodaX 自己就是 agent、拥有 tool 层——在 `toolBash` 内 `command`/`stdout`/`stderr`/`exitCode` 全部原生在手，因此**不重写命令、不装 hook、不建分析 DB**，直接在 tool 内对输出做事后压缩。压缩后的字符串**就是**进 context 计数的内容，context accounting（token-accounting.ts）自动正确（注意：这不等于能测出"节省了多少"，反事实收益只在测试里量）。

**四条硬约束（对抗评审逼出，均已核实 file:line）**，直接界定实现边界：

1. **Body-only：`Command:`/`Exit:` 头部逐字保留**。[result-extractors.ts:264](../packages/agent/src/session-lineage/compaction/result-extractors.ts#L264) 的 `extractBashResult` 用锚定正则解析 `Command:\nExit:\n` 头部，为 FEATURE_185 hits-ledger（ADR-031）恢复 exitCode/tail/cancelled——**跨 microcompact 存活**。压缩若动头部会静默破坏"别让模型重跑已跑过的命令"这一整个机制。故压缩只作用于 stdout/stderr 正文，头部拼装（bash.ts:364）保持不变。同时新过滤器是 rtk tee 之外的**第三层**（现有 `applyToolResultGuardrail` bash tail-truncation 保留为语法兜底，语义压缩后多为 no-op）。

2. **构造即无损 + `never_worse` 尺寸兜底**。评审证明 `never_worse`（rtk `core/guard.rs` 的 `estimate(filtered) > estimate(raw) ? raw : filtered`）**只比大小，测不出"更短但语义错了"**——rtk 自己也踩过（`Language::Data` 在 issue #464 后被硬排除）。故通用层必须**构造即无损**：ANSI-strip（SGR 码不携带正文没有的信息，安全广泛开启）；spinner 帧折叠须严格证明（CR 后紧跟 CR + spinner glyph）且默认关、经 fixture 语料验证后才开。泛化去重不能再被称为纯无损：即便用 `[repeated ×N]` 标注也改变命令正文形状，只能作为可恢复/有 raw hint 的 lossy 变换，或 Phase 0 默认关闭。`never_worse` 保留为最后一道尺寸兜底，不是安全性主保证。命令去噪加 denylist（`git log --graph`/`diff --color`/彩色测试输出跳过去重/CR）。

3. **内容签名检测优先于命令名；绝不整条跳过复合命令**。评审证明"任何复合命令就跳过语义过滤"太保守——coding agent 高频跑 `fmt && clippy && test`/`lint && test`，恰是输出最大的命令。KodaX 拥有输出，可按**内容形状签名**选过滤器（`diff --git`→diff、pytest `=== FAILURES ===`→failure-focus、cargo `test result:`→…），天然吃复合/管道，比 rtk 的命令名匹配更稳。**只事后解析、绝不重跑/重写命令**（规避复合、权限、显示的所有交互）。命令头提取器是 `coding` 内自包含小工具（**不能 import `packages/repl` 的 `bash-ast.ts`——破坏层独立性**，CLAUDE.md 禁止项）。

4. **Phase-1 即混合式：声明式行过滤表 + 编译式状态机**。评审证明 compiled-only 是错的成本曲线——rtk 的 63 个 TOML 声明式过滤器均 ~38 行覆盖长尾（terraform/ansible/df/du…），而有状态 parser（cargo_cmd 2216 行、diff_cmd 516 行）只写了 ~15-20 个。2026-07-05 复核 rtk `develop` 最新提交 `31f9d43`（`feat/toml-filters-in-hook`）后确认：rtk 已把 TOML DSL 扩为 8-stage pipeline，并用 `Lossiness` 区分 `none/tail/whole`。KodaX 仍不上用户可编辑文件与 trust gate，但 Phase 1 的内置声明式 schema 应从原来的最小子集扩大到高价值小集：`strip_ansi` / `strip_lines_matching` / `keep_lines_matching` / `head_lines` / `tail_lines` / `max_lines` / `truncate_lines_at` / `on_empty` / `filter_stderr`。**编译式只留给真正有状态的**（diff/测试 failure-focus/tsc·eslint 结构化）。

5. **lossy 必须可恢复，否则跳过压缩**。KodaX 的 `toolBash` 当前在内部就会做 32KB tail preview；若 lossy filter 先把大输出压到 32KB 内，外层 `applyToolResultGuardrail` 将不会再 spill 原文。因此不能依赖外层 guardrail 保全文。每个 filter 返回 `FilterResult { stdout, stderr, lossiness, note? }`；当 `lossiness !== none`，在拼 `Command:`/`Exit:` 之前先用现有 `persistToolOutput` 保存原始 decoded body 并追加 recovery hint；若保存失败，则放弃该 lossy filter，走 raw body + 现有 tail 截断路径，避免新增"更短但不可恢复"的隐藏数据风险。

**架构**。新增单一子模块 `packages/coding/src/tools/output-filters/`：`types.ts`（`FilterResult`/`Lossiness`）、`never-worse.ts`（尺寸兜底）、`generic.ts`（ANSI 无损层；dedup/spinner 继续 gated）、`detect.ts`（内容签名 + 命令头提取，自包含）、`helpers.ts`、`declarative.ts`、`filters.data.ts`（长尾内置表）、`registry.ts`（声明式表 + 编译式分发）、`compiled/`（git-diff/git-log/git-status/test-runner/lint/json-output）。**唯一集成改动在 bash.ts**：close-handler 内、解码 stdout/stderr 后、拼装 `out` 之前压缩 body，头部不动；两条派发路径都消费 `toolBash` 返回值→一处覆盖全部；background（bash.ts:217 提前 return）/timeout/abort 路径天然不走 395，自动排除。守卫链：内容/命令签名选过滤器 → 无损通用层 → 命令特定或声明式过滤器 → lossy recoverability gate（persist raw body + hint；失败则 raw fallback）→ `never_worse` → 拼装头部 → 现有 truncateTail+guardrail 语法兜底。

**分阶段 / 实施结果（2026-07-05）**。Phase 0 已完成：`never_worse` + `FilterResult/Lossiness` + body-only 集成 + ANSI-only 通用层 + 测试。Phase 1 已完成：git status/diff/log 事后摘要、测试 failure-focus、lint grouping、内置声明式长尾表。Phase 2 收窄完成：docker/infra CLI 与包管理器进度压缩、JSON/NDJSON 结构摘要；read/grep 语义压缩因已有结构化输出与 guardrail，保持 measured-first 非目标。Phase 3 仍 demand-gated：完整 DSL + 用户过滤文件 + 信任门控。

**非目标**。命令重写 / lexer / 复合命令段级重写 / 14-agent hook 安装器 / SQLite gain·discover 分析——KodaX 拥有 tool 层，全部无意义；用户可编辑过滤文件与信任门控推迟。**无 prompt 改动**（透明压缩），不触发 ADR-033；recovery hint 复用 `buildToolResultHint` 现有措辞。

**后果 / 测试**。确定性代码，不触发 FEATURE_104 prompt-eval。已覆盖：每过滤器单测、`never_worse` 不变式、ANSI 去除、声明式 package/docker/infra 规则、git/test/lint/JSON compiled filters、registry raw recovery、lossy persist 失败 raw fallback、filter 失败 raw fallback、`toolBash` 头部保真、`extractBashResult` ledger 解析、tool-result guardrail 回归、`@kodax-ai/coding` build。风险=通用层无损性未证的 spinner/dedup 分支——继续默认关，直到语料验证。预期收益与 rtk README「30 分钟会话 -80%」同量级，且因压缩即计数，有效 context 窗口直接变大。

### 2026-07-14 纠偏决策：完整采集、无损优先、批次单一容量边界

> **状态：Accepted，且在冲突处取代本 ADR 上述 v0.7.61 决策。** 上文保留为
> FEATURE_251 的历史设计记录；其中“透明事后有损压缩默认开启”“32KB / 600 行是
> token 策略”“512KB 是采集上限”和“隔离 body-token 降幅可代表会话收益”不再是
> 当前行为或验收依据。

**触发证据**。证据来自一条真实 review 会话，而不是频率或收益率 benchmark：

- session：`C:\Users\iceto\.kodax\sessions\c-works-gitworks-kodax-author-kodax-66910f2fd8\20260714_174750.jsonl`
- raw artifact：`C:\Users\iceto\.kodax\tool-results\2026-07-14T09-52-03-904Z-KodaX-bash-output-raw-6qsktp.txt`

第一次 `git log v0.7.68..HEAD --oneline --stat` 被改写为
`[git log summarized: showing 30 of 207 lines]`。Worker 随即明确表示需要完整原始输出，读取
12,577-byte artifact；同一段流程还修正并重跑了另一个 `%` 转义失败的 `git log --format`
命令。直接可归因于压缩的证据只有**一次 raw 恢复读取及其额外 tool-result 循环**；格式命令
重跑有独立原因，不能归因于压缩。这条记录也不能推出恢复率、token 增幅或盈亏平衡点。此前
写入文档的百分比推断没有对应样本集，现已删除。原
Layer-1 测试只比较 `raw body` 与 `filtered body + hint`，没有计入恢复读取、额外请求、tool
schema、模型输出和信息误判，因此只能作为历史 fixture 测量，不能证明端到端正收益。

**目标函数**。优先减少完成任务所需的总 token 与总轮次，而不是让单次 tool result 看起来
更短。默认路径必须保持证据完整；容量回退只解决“下一次物理请求确实放不下”的可用性问题，
不能被当作普通 token 优化。由此确立以下不变量：

“任意内容、任意长度都必须节省一些 token”不是可满足的无损目标：对已经紧凑或高熵的任意
文本，不改变契约就不存在保证更短的表示；强制正收益必然在某些输入上丢信息或增加 framing。
因此单次结果允许 **0 节省**，但不允许负节省：候选无损表示只有严格更短才采用；系统级收益
来自可证明的重复开销消除、渐进 schema、显式请求整形和避免 recovery，而不是为每个结果凑
一个压缩百分比。

1. **先完整采集，再决定交付形态。** Bash 从第一个字节起保留 stdout/stderr；512KiB 只触发
   内存到临时文件的 spool，不是采集上限。工具退出后才形成完整结果，并负责清理临时资源。
2. **默认只做契约等价、且严格更短的无损规范化。** 例如可以移除不承载内容的终端样式码；
   OSC 8 hyperlink 必须保留 URL。候选结果不更短时返回原文。compiled/declarative 的
   git/test/lint/JSON/package/docker/infra 有损过滤器默认关闭。
3. **一个结果帧只有一个语义 owner。** 这不是要求每条命令强制选择一个 adapter，而是禁止
   Bash 内层、retrieval bridge 和外层 guardrail 对同一正文反复摘要。单一、明确的工具 API
   可以在执行前通过参数/请求整形减少无关源数据；普通 simple-command adapter 只有在保持
   请求证据契约时才可启用。compound Bash 可能混合多条命令和重定向，语义 adapter 数量为 0。
4. **批次只有一个 capacity owner。** 并行 tool calls 全部完成后，由即将构造下一次 LLM 请求的
   调度层统一判断；工具、bridge 与 retrieval renderer 不再各自应用固定 per-tool 上限。
5. **显式不完整，且可精确恢复。** 只有整个批次放不下时，才把被移出的完整结果持久化一次，
   并交付带 `KODAX_RESULT_INCOMPLETE` 的预览和 continuation。marker 对重复守卫必须幂等，
   不能生成嵌套 artifact；若连所有 tool-call/tool-result 配对所需的最小 marker 都放不下，
   必须显式失败并给出诊断，不能继续提交一个已知超预算请求。

**容量算法**。容量使用将要发送给 provider 的物理请求计数，而不是某个逻辑 session 的近似值：

```text
safety(P) = max(2048, ceil(P * 0.03))
Pmax      = max P such that P + providerReservedOutputTokens + safety(P)
            <= contextWindow
Cbatch    = max(0, Pmax - currentPhysicalRequestTokens)
```

`P` 是加入整个批次后的最终输入候选值；不能只按加入前的
`currentPhysicalRequestTokens` 计算 3%，否则大批次会把 safety margin 本身挤穿。

若批次所有 tool-result（含协议 framing）总计 `<= Cbatch`，全部原样进入下一请求，哪怕超过
旧的 32KB / 600 行或 64KB per-tool 经验值；不得创建 artifact 或恢复 hint。只有总计超过
`Cbatch` 才执行上一条容量回退。prompt cache read/write token 仍占 context，因此必须包含在
`currentPhysicalRequestTokens` 中；成本统计则把 uncached input、cache read、cache write 分开，
各自只计费一次。

这里的 2048/3% 也不是“科学常数”或压缩收益阈值，而是当前 token 估算与 provider framing 误差
的工程安全余量。它与旧 32KB/600 行的关键差别是：按最终物理请求缩放、与 output reserve 分开、
只由唯一 capacity owner 使用。落入“hard window 尚可容纳、但 uncertainty margin 不容纳”的结果
属于**可靠性回退**，不得计作 token 优化收益；应记录 estimate-vs-actual 误差与 artifact recovery，
若长期出现不必要恢复就校准余量。未来若 final-envelope 计数能被 provider 精确给出，应基于证据
收窄余量，而不是把该常数永久固化或复制到各工具。

**“adapter” 的精确定义与边界**。这里的 command/parameter adapter 是**执行前的请求整形**：
例如调用一个本来就声明支持 `limit`、path scope 或字段选择的工具时，根据当前任务显式选择
更窄参数。它不是执行后删 stdout 的 filter。一个调用最多允许一个 adapter 的含义，是禁止
多个语义投影串联后无法判断哪一层丢了证据；不是要求每个调用都选一个。当前默认 Bash 选择
0 个，compound Bash 强制 0 个。只有工具契约能证明所请求证据保持等价时，simple command
才允许选择 1 个；否则仍为 0。即使选择 adapter，工具也必须诚实报告显式 limit/continuation。

**历史压缩使用同一物理容量不变量**。有损历史压缩与 tool-result 溢出不同：历史 summary
不能通过 artifact 精确恢复模型当时的完整推理关系，因此不能把“随时缩短一些”当成无风险
优化。默认策略如下：

1. **容量内不做自动有损历史变换。** 契约等价的无损规范化、tool schema 渐进披露和执行前
   请求整形仍可在任意长度节省 token；但普通 tool-result 清空、user message crop、默认
   microcompaction 都关闭。否则节省的是一次输入，风险却是后续重读、重跑或错误结论。
2. **以最终 provider envelope 判断。** 在 provider prepare/policy、最终 system prompt、实际
   tool schema 和 output reserve 确定后计算物理请求 `P`。固定 overhead（system/tools/framing
   与 transcript 估算的差）在候选 summary 上继续保留，cache token 仍占 `P`。当
   `P + providerReservedOutputTokens + max(2048, ceil(P * 0.03)) <= contextWindow` 时不触发。
3. **真实压力下 summary-first。** 只选完整、原子的最旧消息前缀（tool-use/tool-result 配对不拆），
   在同一物理容量约束内生成语义 summary；不在 summary 前清空 tool result 或裁 user message。
   每次只压到下一请求刚好可容纳就停止，不追逐 36%/52% 等静态低水位。
4. **不以静默删除兜底。** summary 失败、为空或仍不足时，canonical history 保持不变并抛出
   typed `ContextCapacityError`。调度层必须透传该错误；不得把异常吞掉后继续提交已知超限请求，
   也不得用“graceful”名义删除消息/配对。
5. **百分比仅是显式策略。** 默认自动 trigger 为 capacity-only（100% 表示没有额外提前阈值）。
   用户显式配置 `<100%` 可选择提前 summary，手动 `/compact` 可显式 force；二者是用户接受
   信息损失的策略，不宣称必然降低端到端 token。

该设计解释了为什么“完整结果仍超一个任意 32KB/600 行阈值就先 artifact”是负优化：只要
最终物理请求仍可容纳，artifact + preview 既增加 marker/token，又很可能增加一次读取。只有
超出**真实 provider 容量**时，可恢复 artifact 才是可用性回退，而不是常规优化。

**边界与工具契约**。

- `read` 以 `line_offset` 精确续读超长单行；`grep`、`glob`、`code_search` 与 retrieval 不再有
  隐藏的 100/200/2000 条、24/32KB 等内部 caps。用户显式请求的 `limit` / `head_limit` 是
  查询契约，达到边界时必须返回 continuation，而不是暗中声称结果完备。
- `task_output` 对仍在运行的任务可显示有明确标记的 live tail；任务进入终态后返回完整输出。
- web search/fetch 的 256/512KiB 是上游资源采集安全上限，不是 token 优化。命中时结果必须含
  `SOURCE_INCOMPLETE`，禁止把截断内容表述为完整来源。
- 2026-08-04 安全纠偏后，工具已有的 bytes/lines policy 是 token policy 之前的硬边界；Bash
  在 32KiB / 600 行处立即把完整输出封存为 artifact，只让有界 preview 进入后续估算。
  `capacityTokens × 128` 的宽松预判已删除，原始超大文本不得进入 tokenizer。
  直落盘结果必须把 canonical manifest 路径通过 tool-call ID 的可信 side-channel 传给 SA 和 AMA
  的最终 batch owner，并把 incomplete marker 放在结果末尾；不得从原始工具文本猜测可信路径，
  也不得在最终准入时把同一 marker 再落盘一层。

**2026-08-04 tokenizer 与 managed Run durability addendum**：主事件循环不再加载
Provider-specific BPE 词表。`countTokens` / `estimateTokens` 使用 UTF-8 bytes 与 UTF-16 code
units 的 O(n) 多语言估算，并对长 Base64/Hex/随机编码串采用保守 dense-data 下界；Provider
最近一次真实 usage 仍是上下文基线，估算器只负责新增尾部与保护预算。Runtime-owned managed
Run 在执行初始输入前、发布 `turn.completed` 前、发布 `run.input.delivered` 前写入 canonical
Session；任一 required write 失败均 fail closed。该契约公开为 `managedRunDurability` v1，
auto-start SDK 客户端会拒绝或安全升级缺少该能力的旧 daemon。canonical 中存在 queued prompt
只证明输入已接受并保全；只有 durable `run.input.delivered` 才证明它已交付给执行 turn。若 event
journal 写失败，Run 在下一次 provider 调用前失败，保留该 accepted prompt 而不伪造 delivery。
- 物理请求 fallback 在 provider 未返回 usage 时也必须从最终 envelope 估算：最终 system prompt
  只计一次（skills 已合并后不得重复）、active tool schemas、messages/framing、cache 占用以及同一
  next request 的 edit-recovery 等 synthetic sibling 都要计入；有效 provider usage 仍是权威值。
- 显式查询 `limit` 通过请求 `limit + 1` 个候选判断是否确有遗漏，再只交付 `limit` 个并标记；
  不能仅因返回数等于 limit 就猜测还有结果，也不能把真实的第 `limit + 1` 项静默吞掉。
  该规则覆盖 local/provider `code_search`、`semantic_lookup`、keyword `tool_search`、`mcp_search`、
  web search、`read` 与 `grep`；`grep.head_limit < 0` 必须报错，不能被解释为 `0=unlimited`。

全工具审计把任何“变短”归入下面五类；不属于其中之一的隐藏裁剪应删除：

| 类别 | 何时允许 | 模型必须看到什么 |
|---|---|---|
| 契约等价无损规范化 | 语义等价且序列化 token 严格更少 | 完整等价结果，无 lossy hint |
| 调用者显式查询边界 | 工具 schema 已有 `limit` / page / field / scope 参数 | continuation、总量或明确“还有结果” |
| 上游采集安全边界 | 文件/网络/协议资源安全上限被命中 | `SOURCE_INCOMPLETE` 与可用恢复坐标；不得声称完整 |
| 运行中展示 | 任务尚未终态，仅提供 live tail/status | 明确 `LIVE`/pending；终态接口必须完整 |
| 真实请求容量回退 | 唯一 batch owner 证明完整结果放不下 | 完整 artifact + 幂等 `KODAX_RESULT_INCOMPLETE` |

没有物理容量上下文的 public guard 必须 passthrough，不能猜一个 per-tool cap。MCP ordinary
resource text 只进入 `content` 一次，不复制进 `structuredContent`；若 server 确实返回独立的
top-level `structuredContent`，则原样保留两个 distinct channel，只对完全相同表示去重且不改空白；
MCP fallback 也必须使用同一双通道契约，不能二选一丢失。分页中途失败必须抛错且不缓存局部页。
Self-knowledge 的精确 topic 读取返回全文，只有 index
listing 采用结构化 metadata。Bash cancellation 返回已捕获的 partial stdout/stderr、command 和
cancelled 状态。kill 后先有界等待 stdout/stderr close；若 drain deadline 仍未 close，collector
必须转交给持续追加的 recovery artifact，返回 `KODAX_CAPTURE_INCOMPLETE` 与路径，后台继续持有
managed-child/collector ownership，只有真正 close 后写入 `KODAX_CAPTURE_COMPLETE`。这样既不无限
挂起，也不把 deadline 后 chunk 写进已关闭 collector。spool 读取失败同样必须返回
`KODAX_CAPTURE_INCOMPLETE`、恢复坐标和仍在内存的 suffix；background capture 只有出现最终
`[Exit]` footer 才可视为完成。恢复链优先读结构化 metadata，
同时兼容旧文本 marker，并始终保留 artifact pointer 与诚实 omission 状态。

完整 artifact 是可恢复会话的 canonical evidence。仅凭 mtime/固定 TTL 无法证明引用已消失，
因此 `persistToolOutput` 不再自动 age-delete。REPL session manager 启动时先扫描 active/archived
JSONL 中的 artifact 文件名，只删除超过 grace window 且未被任何可恢复会话引用的文件；引用发现
失败时 fail closed，不做删除。遗留 age-only helper 继续保留为显式兼容/operator API，但不在生产
写入路径调用。Bash spool 也进入同一 `tool-results` 生命周期，进程崩溃残留和容量 artifact 不再落在
无人管理的临时目录。粘贴图片路径也会进入 canonical session messages，所以 Classic/Ink REPL
启动时不再按 24 小时自动删除。明确声明为瞬态、拥有恢复
窗口的 managed-task checkpoint 仍可过期，但活跃度必须按最近成功写入的 mtime 判断，不能按任务
最初 `createdAt` 误删仍在运行任务刚写出的 checkpoint。

append capacity 只允许从 `calculateMaxContextInputTokens(contextWindow, reserve) - currentTokens`
导出。旧的 snapshot budget builder 与 byte/per-result clamp 为 SDK 源码兼容继续导出并标记为
compatibility helper；KodaX 内部不调用它们，唯一 batch owner 只消费上述 fixed-point token capacity，
避免重新形成第二套策略 owner。

审计同时移除了散落在其他结果表面的隐式经验 cap：`changed_diff_bundle` 的 10-path 截断、单行
`edit` 的 100-char preview、`relationship_scan` supplemental evidence 的 10-line/1800-char 裁剪、
`tool_search` select-mode 的结果 cap，以及 child evidence/result 的 200-line/4000/10000-char slices。
这些结果先保持完整，再由其下一请求的 batch/envelope capacity owner 判容；工具 schema 中显式的
per-path/page/query limit 仍是调用契约，必须可见并提供 continuation，不能与隐藏截断混为一谈。
为避免一次调用无界占用文件句柄/子进程，`grep` 与 `code_search` 每次最多扫描 512 个候选文件并返回
`scan_offset`，`changed_diff_bundle` 每次最多接收 64 个唯一 path 且内部并发为 4；这些都是显式、可续的
acquisition 契约，不得静默声称全量完成。

**与 rtk 的关系**。保留 rtk 值得借鉴的“在执行前理解命令与参数、尽量让上游只产生任务所需
证据”原则；不照抄其透明 hook、事后有损过滤、隐藏截断或收益口径。KodaX 的优化顺序是：
显式请求整形 → 严格更短的契约等价规范化 → 物理批次容量判断 → 必要时的可恢复不完整交付。

**收益验证口径**。任何未来有损策略都必须按 `benchmark/EVAL_GUIDELINES.md` 预注册并比较完整
任务，而不是只比较一个字符串。至少同时报告：provider 总 input/output（cache read/write 分列）、
模型轮次、tool call 数、artifact/recovery read 与改格式重跑、完成质量和证据完整性；覆盖小结果、
高噪声但可容纳结果、真实 tool-batch 溢出和历史容量压力。只有端到端 token/轮次改善且质量不
回退时，候选才有资格显式启用；单个 fixture 变短、artifact 可读或模型最终完成任务均不能单独
作为正收益证据。当前不基于这条 ADR 新增默认有损 adapter 或配置开关。

**验证门槛**。回归必须覆盖：小结果与超过旧固定阈值但仍可容纳的结果逐字返回；Bash
memory→spool 前后首/中/尾 sentinel 完整；compound 命令不触发语义过滤；SA 与 AMA 使用同一
物理容量公式；并行批次只溢出一次且 marker 幂等；最小 marker 不可容纳时显式失败；长单行
可续读；终态 task output 完整；网络源限额显式不完整；cache 容量与计费口径互不混淆。
历史压缩还必须覆盖：容量内逐字保持、默认 microcompaction no-op、最终 provider envelope
判容、skills 不重复计数、无 usage 时 system/tools envelope 不漏计、同请求 recovery sibling 计入、
固定 overhead 与首个 Worker system prompt 原样保留、原子 tool 配对、summary-first、无效 summary
不消费 source chunk、刚好可容纳即停止、失败时 typed error 携带最新 transcript 且 canonical history
不变。工具侧还要覆盖显式 limit 的 `limit + 1` 探测、MCP ordinary resource body 单份交付、Bash
取消的正常 close 与 delayed-close recovery handoff、spool read 失败 marker、MCP fallback 双通道、
各显式 limit 的 N/N+1 两侧、负数 grep limit，以及 tool/paste artifact 不被启动或新写入触发
age-only GC；长任务 checkpoint 则按最近写入时间保持可恢复。旧的“每个 fixture 压缩后必须更短”
不再是发布门槛。

## ADR-051: Runtime Isolation Is an Ownership Axis, Not a Generic Execution Service

**Status**: Accepted (2026-07-10)

**Context**: SDK embedders need a disposable private V8 isolate, daemon clients
need durable multi-client sharing, and generated constructed handlers need CPU
fault containment. A proposed generic `runtime.executions` service would mix
three ownership, serialization, permission, and security models and imply an
untrusted-code sandbox that Node Workers do not provide.

**Decision**:

1. Keep the public `KodaXRuntime` service facade unchanged.
2. Express deployment as orthogonal identity: `mode` is ownership/sharing
   (`embedded | daemon`); embedded `isolation` is execution placement
   (`inline | worker`). Daemon identity reports process isolation.
3. Reuse the versioned runtime protocol over MessagePort for Worker-hosted
   embedded Runtime. Do not add arbitrary code execution methods.
4. Isolate constructed handler code internally with reverse tool RPC; keep
   capability, plan-mode, permission, depth, and tool execution checks in the
   host.
5. Make Worker/daemon inputs DTO-only and fail closed on process-local values.
6. Advertise `hardDispose` during initialize so callers can require it without
   accepting silent fallback.
7. Treat Worker resource limits/termination as fault isolation, not a security
   sandbox. Hostile code requires a future process/container/OS boundary.
8. Validate isolation requirements in every creation path. Worker-only options,
   inline `hardDispose` requirements, and explicit isolation on daemon mode are
   errors rather than ignored hints.
9. Mark constructed-handler ownership disposed before terminating its Worker so
   queued calls and stale closures cannot resurrect an untracked isolate.

**Consequences**: Existing inline users pay no IPC or startup cost. Worker users
pay one cold start per private Runtime and gain deterministic teardown. Daemon
users get a real detached owner process and multi-client reuse. Constructed
handlers pay Worker/RPC overhead only on their own path. Packaging includes
explicit Runtime and handler Worker sidecars with build/package guards.

**Verification**: full Runtime SDK regression, distinct daemon PID smoke,
MessagePort service round trip, hard-dispose negotiation, CPU-loop termination
and respawn, reverse tool RPC capability denial, bundle and pack smoke. No model
quality eval is required because Runtime isolation does not alter model context;
the construction review prompt receives only a factual boundary correction.
GitHub Actions run `29088957312` proves Node 20/22 builds and tests plus the
Node 22 Ubuntu Unix-domain-socket daemon gate.

## ADR-052: Learned Capability Carriers — Memory for Facts, Skills for Methods, Extensions for Deterministic Capability, Workflows for Execution

**Status**: Accepted (2026-07-12); automatic Extension-learning portion
superseded (2026-07-29)

**Context**: F224 introduced one procedural-learning intake with Skill,
Workflow, memory, reasoning, trace, and discard destinations. Later roadmap
items proposed a Workflow handoff inbox, draft lifecycle, replay-aware pipeline,
and crash-resume journal. Meanwhile F246 made Workflows cheap to author on
demand, F228/F260 established governed memory, and the Extension runtime gained
trusted tools, commands, Skill paths, agents, capability providers, hooks,
disposal, discovery, and daemon ownership.

Reviewing the local Hermes source reinforced two principles: keep the agent core
and model tool surface narrow, and place reusable capability at the edges.
Hermes uses Skills for learned methods and plugins/toolsets for executable
capability; its Workflow-like delegation remains an execution mechanism rather
than a learned artifact lifecycle.

**Decision**:

1. Keep one shared learning evidence/intake plane. Do not create independent
   Skill, Workflow, Extension, and memory signal collectors.
2. Route facts, preferences, constraints, and short conditional lessons to the
   F228/F260 memory plane.
3. Route reusable judgment, procedures, pitfalls, and verification methods to
   governed Skill proposals. F263 closes the F224 production loop.
4. Do not create a generic learned Extension loop. Extension authority,
   dependencies, state, failure modes, and verification cost vary too widely
   for one reliable self-learning path. Repeated deterministic work stays with
   existing builtin/MCP tools, Skill scripts, or explicitly user-directed
   Extension authoring and repair.
5. Keep Workflow as an on-demand execution primitive. Users may explicitly
   save/revise capsules, but KodaX does not automatically learn, promote,
   rewrite, or activate Workflows in `v0.7.x`.
6. Preserve existing `workflow_handoff` data/types for compatibility, but add
   no automatic mutation consumer.
7. Apply authority follows carrier risk rather than one universal approval
   rule. Memory uses governed apply. A new agent-owned, low-risk Skill may enter
   the lower-precedence Learned Area after evidence review with a durable user
   notice and rollback; protected/formal Skill sources still require explicit
   review. Agent-authored Extension code follows the ordinary explicit
   code-review and installation path rather than a Learning Center action.
   Formal global promotion always remains explicit.
8. Learned Skill changes take effect on a later task/session by default.
   Explicit Extension changes follow their ordinary reload lifecycle. Never
   silently change the current stable prompt/tool prefix.
9. Reuse existing runtime, proposal store, Extension runtime, construction,
   Worker isolation, trace, and verification surfaces. Add no new workspace
   package or general self-modification framework.

**Consequences**:

- F231b, F235, F238, and F232 leave the active `v0.7.x` roadmap; the existing
  Workflow runtime and explicit saved-capsule lifecycle remain supported.
- F244 is shelved until F265 performance evidence proves a cold module-graph
  hot path.
- F105 is removed because specialist dispatch and the existing LLM-judge /
  Sidecar paths already cover concrete second-opinion use cases.
- F108 is removed because user/project methods belong in Skills; deterministic
  Extension code remains explicit user-directed engineering, and global prompt
  evolution remains an engineering + eval process.
- F264 is deleted because Extension complexity and executable authority do not
  support a reliable generic self-learning lifecycle.
- The active learning roadmap becomes F266 Learning Center/control plane, F263
  Skill Loop, and F265 work/coding performance and assurance consolidation.
- KodaX uses tiered autonomy rather than blanket approval or blanket mutation:
  low-risk learned instructions can become useful quietly and reversibly,
  executable authority and formal ownership remain user-controlled.

**Reconsideration gates**: A learned Workflow carrier, learned Extension loop,
or cross-process Workflow replay may return only after at least three real
production cases demonstrate a gap that on-demand generation, explicit saved
capsules, daemon ownership, Skills, MCP, and user-authored Extensions cannot
address. A new carrier still requires a distinct validation, approval,
rollback, and cache policy.

---

## ADR-053: One Learning Center, a Separate Learned Area, and Runtime-Owner Semantics

**Status**: Accepted (2026-07-12); Extension-loop assumptions superseded
(2026-07-29)

**Context**: F224 exposes a project Skill-proposal store and `/learn` commands;
F260 adds Memory Agent evidence and F263 closes the Skill loop. An Extension
loop was originally planned but was deleted on 2026-07-29 because Extension
complexity and trust boundaries vary too widely for reliable generic
self-learning. A direct multi-carrier implementation would make each carrier
invent its own inbox, opaque proposal ID, notification recovery, install
location, SDK surface, and daemon synchronization. The current terminal UI also
has two distinct status
surfaces: a composed Ink `PromptFooter` whose header right side currently has
no view-model items, and a dense bottom `StatusBar` carrying agent mode,
permission, reasoning, optional iteration, session, provider/model, and
optional context usage. The main Ink path moves liveness to the activity bar
and does not currently inject the segment builder's optional token usage.
Classic previously had a separate one-line StatusBar implementation, but
`runInteractiveMode` constructed and updated it without calling `show()`; the
write-only path was removed as an early F225 cleanup slice.

**Decision**:

1. F266 establishes one generic Learning Center in `@kodax-ai/agent` before
   F263 adds the Skill-specific authoring loop.
2. Capability lifecycle and notification read state are separate. Lifecycle is
   shared by the Runtime owner; unread/seen/acknowledged/snoozed cursors are per
   stable client identity.
3. User operations use a stable display name and collision-safe slug. Opaque
   capability/event IDs are internal correlation keys, not the normal UI.
4. Active agent-created capabilities live under `~/.kodax/learned`. Learned
   Skills have lower precedence and cannot shadow formal sources. The generic
   carrier type remains transport-compatible, but KodaX has no built-in learned
   Extension producer.
5. `/learn promote <name> --scope user` performs an explicit, collision-checked
   ownership transfer into the formal user Skill catalog.
6. `@kodax-ai/agent` owns the generic store, events, cursors, Learning Center,
   Skill governance, learned Skill registry, and neutral action-driver seam.
   `@kodax-ai/coding` owns coding evidence and the separate explicit Extension
   runtime; it does not generate learned Extensions. REPL only renders and
   invokes services.
7. `src/sdk-runtime.ts` exposes one transport-safe `runtime.learning` facade.
   Inline, Worker, and daemon modes share its DTOs and behavior. Only the
   Runtime owner runs learning jobs or writes learned records.
8. State transition is persisted before its durable event, and the event is
   persisted before client emission. Reconnect/startup recomputes unread state;
   session transcript notices are optional mirrors, not source of truth.
9. Ink appends one compact non-zero Learning segment to the real bottom
   StatusBar, renders state changes in `NotificationsSurface`, and opens the
   center through the existing dialog/overlay path. It does not create a new
   persistent footer-header row. Classic/headless uses `/status`, `/learn`,
   startup recovery, and text/events; Learning does not recreate the removed
   Classic StatusBar. Restoring it requires separate user evidence and
   terminal-compatibility proof.
10. No independent Workflow Loop, Workflow controller, second learning store,
    new workspace package, or generic state-machine framework is introduced.

**Consequences**:

- F266 targets v0.7.72 after the 2026-07-16 patch deferral and becomes a
  dependency of F263 and F265.
- A daemon may continue background review/testing after all UI clients detach;
  embedded modes recover persisted queued state on the next owner start.
- Users can distinguish a learned capability from fresh LLM reasoning without
  approving every low-risk Skill or being interrupted for mere opportunities.
- Learned capabilities are immediately useful at bounded authority while
  formal global directories remain an explicit statement of user ownership.
- HLD/DD remain current-release documents and will describe this control plane
  as current architecture only after F266 ships; the planned contract lives in
  the version feature design meanwhile.

**Reconsideration gates**: A second center/store or carrier-specific protocol is
allowed only if at least three concrete host requirements cannot be expressed
through the shared lifecycle and action-driver seam. Learned Extension slash
commands, a learned Extension loop, or broader generated registration APIs
require separate product-demand, security, and discoverability proof.

---

## ADR-054: Shared Coder Runtime Uses Atomic Observation, Durable Operations, Narrow Host Bridges, and One Owner Fence

**Status**: Accepted (2026-07-13)

**Driver**: `FEATURE_269`, KodaX Space v0.1.32 default Coder migration

**Context**: F255 established a local authenticated daemon with multi-client
connections, per-session FIFO runs, persistent event replay, daemon-held
permissions, and conservative crash interruption. Space now needs CLI, Space,
IDE, and other local SDK clients to open and control the same active Coder
session. The released surface still leaves a snapshot/subscription race, lacks
durable command idempotency and transport-safe AskUser, assumes provider
credentials exist in the Runtime process, cannot call explicitly bound
Space-owned capabilities, and fences daemon candidates without fencing an
inline Coder owner.

These gaps are coupled by one correctness requirement: the policy-selected,
fenced owner must be the only Coder profile fact and authority source (the
daemon in normal mode, inline only during explicit rollback). Solving them independently in
Space would create per-client transcript merge, queue, permission, grant,
credential, tool, and rollback state that can diverge from KodaX.

**Decision**:

1. The Runtime SDK adds one atomic session observation primitive. The daemon
   installs a buffered subscription, takes a short session snapshot barrier,
   returns transcript/state/live projection plus `runtimeId` and numeric event
   cursor, then flushes only post-barrier events in order. A bounded 256-event
   pre-subscribe buffer and `resync_required` close the handoff boundary; there
   is no separate ACK/resume-token protocol.
2. Runtime instance change or `resync_required` forces an explicit full reset.
   Clients replace snapshot state and deduplicate delivery by sequence; they do
   not infer continuity across Runtime instances.
3. The existing session/event persistence remains. A small profile-owned
   append-only control journal stores mutation operation receipts and critical
   dispatch markers. KodaX does not add SQLite or rebuild all state as a new
   event-sourced system. Untrusted control history quarantines mutations while
   reads remain available; a reset changes journal epoch and old-epoch retries
   remain rejected.
4. Every daemon mutation has a high-entropy profile-global operation ID.
   Acceptance/order is persisted before external dispatch; retry returns the
   same receipt only when epoch, authenticated principal, method, authorized
   resource, and normalized request digest match. Same-session order is the
   daemon commit order. Settings and persistent grants use compare-and-swap;
   AskUser uses request revision while permission uses request/run identity and
   first-winner resolution. Legacy clients may read but mutations fail upgrade-
   required; a schema drift test covers every mutating handler.
5. AskUser receives a dedicated transport-safe pending-input service.
   Permission remains a distinct service, but both commit exactly one valid
   resolution and close explicitly on timeout, cancellation, run terminal, or
   Runtime restart. The Coder Runtime owner is the only persistent permission
   grant writer.
6. Space provider credentials use a narrow reverse credential broker registered
   by Space Main. A connection-owned lease has a provider allowlist and a run
   binds it to exact provider/session/run scope. The secret is supplied through
   a dedicated non-journaled reverse response into `AsyncLocalStorage` and never
   enters environment, config, state, event, transcript, log, diagnostic, or
   persistence data.
7. Space Artifact/Office/Control style tools use a separate narrow Host Tool
   reverse bridge. One immutable descriptor set is captured by an explicit run
   acceptance. Trusted client/profile/session/run/invocation identity is
   daemon-derived and never model-controlled. A dispatched call with no known
   result becomes `unknown` and is never automatically invoked again. Host
   registration is not ambient authorization: results use bounded transport-safe
   content, capability sets are single-run, and product-side outcome checking
   after an unknown result remains Space's responsibility.
8. Credential and Host Tool bridges may share a small internal reverse-frame
   router, but KodaX exposes no generic callback/plugin bus. Space product data
   remains Space-owned; only bounded model-safe results cross Runtime.
9. Daemon and explicitly shared inline Coder modes acquire the same
   profile-scoped owner fence. An atomic lock nonce prevents dual ownership and
   makes release ownership-safe. A persisted compare-and-swap policy selects
   `daemon` or `inline`; auto-start never changes it. Fresh profiles default to
   daemon. Existing inline hosts must explicitly acquire the shared fence when
   participating as Coder owner.
10. Emergency rollback first stops the verified daemon, persists `inline`, and
    acquires the same fence for inline Coder. Later CLI auto-start fails
    closed until an explicit transition back to daemon. Stale cleanup requires
    owner identity/nonce and health evidence where available; PID liveness alone
    never authorizes killing another process.
11. Partner stays on a private embedded storage namespace and does not acquire
    the Coder fence. Generic private embedded SDK Runtime behavior remains
    available; only a Runtime explicitly requesting Coder-profile ownership
    participates in daemon/inline election.
12. The daemon never automatically resumes a queued/running run, provider
    request, continuation run, or Host Tool call after process ambiguity. Recovery
    exposes stable interrupted/unavailable/unknown facts.
13. Reliability features are versioned capabilities separate from client UI
    hints and server-issued client scopes. Every RPC checks scope plus profile/
    resource authority. Space requires the needed versions and published Coder
    feature matrix and fails closed; capability absence never triggers silent
    inline Coder fallback.
14. F267 continues to own A2A wire/server behavior and F268 continues to own
    MCP/A2A/Extension configuration. Owner policy, operation receipts,
    credential leases, and Host Tool leases are Runtime control state, not a
    fourth F268 configuration domain.

**Consequences**:

- CLI, Space, IDE, and SDK clients can converge on one active session without
  implementing their own transcript/event merge protocol.
- Transport retry becomes safe for accepted mutations while genuinely
  unknowable external effects remain visible as unknown.
- Space can keep credentials in OS keychain and product capabilities in Space
  without forcing the daemon to depend on Electron or Space Artifact models.
- The Runtime/daemon implementation gains focused session-observation,
  control-journal, credential, Host Tool, and owner modules, but no new
  workspace package or public network service.
- Coder CLI behavior follows the profile owner policy; generic private SDK
  embedding and Partner remain separate, explicit ownership forms.
- v0.7.69 now contains three Critical Features. F267/F268 are not implicitly
  rescheduled; the release remains incomplete until every still-assigned
  Feature passes its own gate or product explicitly moves it.
- HLD/DD describe the implemented architecture; formal npm/Space and
  cross-platform evidence remains a v0.7.69 release gate.

**Rejected alternatives**: client-side snapshot/replay composition, polling,
SQLite/event-sourcing rewrite, transport request IDs as idempotency keys,
credential-in-run/config/environment, daemon-owned copies of Space keychain
secrets, generic callback/plugin RPC, auto-replay of apparently idempotent Host
Tools, client-owned persistent grants, separate inline/daemon locks, PID-only
stale cleanup, and moving Runtime leases/owner policy into F268 integration
files.

**Reconsideration gates**: A generic reverse callback framework requires at
least three additional concrete non-credential/non-Host-Tool use cases plus a
separate security review. A database replaces JSONL only after measured
retention/compaction or atomicity evidence shows the single-owner control
journal is insufficient. Automatic side-effect replay requires an end-to-end
provider/tool idempotency proof, not a descriptor claim.

---

## ADR-055: One Actor Control Plane and Evidence-Based Legacy Recovery

**Status**: Accepted (2026-07-17)

**Driver**: `FEATURE_270`, deletion/replacement and recovery review

**Context**: F270 retires the one-shot native child registry, Workflow-local
execution authority, and parallel external-task projection in favor of one
Runtime-owned Actor/Turn tree. Reviewing the large deletion set confirmed that
the old authorities were intentionally replaced, but also exposed two classes
of risk. First, replacement wiring must preserve mailbox delivery, history,
capability ceilings, one root budget, and concurrent-mutation fencing. Second,
the preregistered design assumed that all active pre-F270 Workflow and F258
records could be imported and protected by a pre-migration checkpoint. That
assumption is not supported by the released data: native children and the
default Workflow manager held active execution only in process memory, F258
task snapshots lack exact session ownership, and F269 owner-policy records have
no Actor schema marker that can change the behavior of already-shipped binaries.

**Decision**:

1. Runtime owns one durable Actor identity tree with separate Turn lifecycles,
   one scheduler, mailbox/event stream, and canonical collaboration tool
   vocabulary. Removed task registries and tool aliases do not remain as a
   compatibility authority.
2. Native, constructed, Workflow-owned, recursive, and external Turns share the
   root-derived concurrency limit and root-owned managed work budget.
   Capabilities are ceilings: descendants may narrow but never widen filesystem,
   tool, network, provider, or user-interaction authority.
3. A mailbox mutation is projected into execution only after durable commit.
   Actor history is reconstructed from durable prior Turns according to
   `fork_turns`. Root and non-root message delivery use the same committed
   mailbox boundary.
4. F269 operation receipts deduplicate transport retries. The Actor revision
   independently fences distinct stale mutations: a follow-up against an idle
   revision cannot silently join a Turn started by another operation.
5. Legacy migration requires an exact durable owner and session correlation.
   Process-local native/default-Workflow execution is not fabricated after
   restart. Existing F258 records without session ownership remain immutable
   backend history or orphan diagnostics; Runtime never guesses, reparents, or
   exposes them as reusable live actors.
6. Actor snapshots use schema version 1 and compare-and-swap persistence.
   F270-and-newer readers reject newer schemas without saving over them. Active
   Turns block daemon rollback/stop. Because new code cannot retroactively make
   old binaries understand a new marker, downgrade uses an offline whole-profile
   or whole-session backup restore under the owner fence, not a synthetic
   in-place checkpoint promise.

**Consequences**:

- The large deletion is acceptable only together with structural absence tests,
  replacement behavior tests, full Layer 1 verification, and the preregistered
  behavioral eval; deletion count alone is not evidence of safety.
- Recovery is deliberately conservative. Some orphaned legacy external records
  remain visible only in their original backend rather than being attached to a
  possibly wrong user session.
- Current binaries fail safely on future Actor schemas, but already-released old
  binaries still require operational owner fencing and backups during downgrade.
- Workflow retains its explicit product surface and deterministic protocol
  semantics while its Agent execution uses the shared Actor control plane.

**Rejected alternatives**: keeping both registries behind aliases, guessing
session ownership from parent/run names, converting process-local tasks into
synthetic failed actors, adding a second migration journal, claiming a
checkpoint that released F269 never wrote, or weakening compare-and-swap to
permit best-effort concurrent updates.

**Reconsideration gates**: automatic legacy attachment requires a released
durable record with exact session/owner correlation and at least three real
recovery cases. In-place cross-version downgrade requires a versioned owner
schema understood by both versions plus a tested reversible migration; backups
and active-turn fencing remain mandatory until then.

---

## ADR-056: Runtime Owns Auto-Mode Permission Decisions and Host Capability Exposure

**Status**: Accepted (2026-07-18)

**Driver**: `v0.7.72` shared-daemon permission-chain correction and `v0.7.73`
public Runtime reliability closure

**Context**: Session settings could explicitly request
`permissionMode: 'auto'` with an LLM classifier, yet a static
`beforeToolExecute` hook could make the generic permission broker decide first.
That inverted ownership: ordinary tool calls became pending requests even when
the configured classifier would allow them, and the classifier's fallback
state was not reliably the state used on a later turn. The same boundary had
related correctness problems: path evidence could confuse quoted shell source
with an operand, `gitRoot` was treated as both safety boundary and working
directory, hosts without a plan-approval bridge could expose an unusable tool,
and large/raw permission previews were not a safe transport contract.

**Decision**:

1. For an auto-mode Runtime session, construct the LLM/rules guardrail in the
   Runtime and cache it by session while its effective provider/model,
   repository boundary, execution directory, classifier model, and timeout are
   unchanged. Do not delegate this ownership to a process-local REPL hook.
2. The required tool order is `guardrail -> permission bridge -> execute`.
   Only `escalate` creates a shared pending permission. `allow` executes under
   the ordinary tool/capability checks; `block` does not ask the user merely to
   override a classification error path.
3. An automatic LLM-to-rules fallback is durable session state. A subsequent
   run reuses the rules engine until settings intentionally select a fresh
   guardrail. A classifier configuration change invalidates the cache rather
   than silently reusing incompatible circuit-breaker or denial history.
4. `gitRoot` remains the validated session repository boundary. Relative
   operands resolve from the separately validated `executionCwd`; path analysis
   must not infer paths from quoted program or regexp source.
5. Permission transport uses a bounded, credential-redacted, valid JSON
   preview and includes the effective execution directory. Preview is a safe
   diagnostic projection, never the source of truth for tool input.
6. Tool scope is capability-derived. `exit_plan_mode` is included only when
   the current run provides `events.exitPlanMode`; absent host capability means
   absent model tool, not a call that fails after model selection.
7. The classifier API owns its own input boundary. The current action is
   projected separately; historical Runner messages are reduced to bounded
   user intent, tool calls, and normalized tool results. Missing classifier
   identity fails as recoverable configuration before provider/permission work,
   and omitting an Auto engine consistently means the LLM default for both
   preflight and guardrail ownership.
8. One exported typed resolver owns Auto config precedence. Session state also
   owns the speculative window, including `0`, and propagates it through the
   same persistence/mutation/cache/bootstrap path as engine/model/timeout.
9. `runtimeAutoModeGuardrail` v3 retains the v2 bounded-input, effective
   timeout/window-default, and diagnostics semantics, and adds Runtime-issued
   opaque exact grant suggestions plus concrete permission matchers. Capability
   requirements are monotonic minimums; v1 or v2 is replaced only through an
   idle fenced preflight.
10. Side-query diagnostics are fixed-field and prompt-free. They report only
    observed provider/model/elapsed/retry/first-output/stream facts and must not
    invent unavailable connect or provider-queue timings. Guardrail spans begin
    before the callback and end with its final verdict/error.

**Consequences**:

- Shared-daemon and inline sessions use the same auto permission decision owner
  and persist the same engine state across turns.
- SDK hosts gain explicit durable `autoModeClassifierModel`,
  `autoModeTimeoutMs`, and `autoModeSpeculativeWindowMs` session settings;
  daemon capability discovery advertises all keys and v3 behavior metadata.
- A permission UI remains responsible for an actual escalation, but no longer
  acts as an implicit classifier or sees avoidable pending requests.
- Host integrations can trust the preview as display-safe JSON while retaining
  the real typed tool input only in the owner execution path.
- Historical tool output can no longer make every subsequent permission check
  retransmit the full active session; the side-query deadline remains bounded
  rather than being raised to mask an unbounded input.
- Existing v1/v2 clients can use a v3 daemon, while clients that depend on the
  v3 exact-grant semantics can reject or safely upgrade v1/v2 without reusing
  the old chain.
- Timeout traces now measure the classification wait and expose actionable
  bounded diagnostics without disclosing the classifier request.

**Rejected alternatives**: keeping a static hook as the first auto decision,
recreating a classifier on every turn, allowing a broad raw-input preview,
using `gitRoot` as an implicit process cwd, parsing arbitrary quoted text as a
path, or exposing a no-op plan-exit compatibility tool.

**Reconsideration gates**: a separate permission decision owner requires at
least three concrete deployment forms that cannot share Runtime session state.
Any broadening of tool scope or preview content requires a distinct transport
security review and cross-host compatibility tests.

---

## ADR-057: Large Compaction Is an Always-On, Context-Scoped, Full-Coverage Transaction

**Status**: Accepted (2026-07-23)

**Context**: The SDK compact path could force a 100% threshold while the core
derived protected and rolling budgets from the full model context window. On a
one-million-token model, a 323k-token active context therefore protected about
200k and summarized only one 100k rolling chunk. Session-level event state and
monolithic Runtime observations then made the real provider input difficult to
distinguish from child-context or full-transcript size. ADR-050's capacity-only
default also conflicts with the now-explicit product policy that automatic
large compaction is always present and defaults to an earlier bounded trigger.

**Decision**:

1. Automatic large compaction cannot be disabled. `triggerPercent` defaults to
   75 and is clamped to 15-90. Optional `triggerTokens` is inactive when absent
   or zero; otherwise the smaller percentage/absolute/physical threshold wins.
2. Protect 20% of that effective trigger on atomic message boundaries, not 20%
   of the model's maximum window. Manual compact bypasses only the comparison,
   never the normalized policy.
3. A major compact is one transaction over the complete eligible prefix. The
   normal path performs one full-prefix summary; physical overflow alone uses
   independent raw chunks followed by one reduce. Serial rolling summary and
   partial canonical commits are prohibited.
4. Every genuine user query is owned by a canonical lineage ledger. A compact
   commit is invalid unless each query is still raw in the protected tail or
   rendered from that ledger. Tool-result wire messages and synthetic prompts
   are not user queries.
5. The normal summary call reuses the exact cache-affecting main-request prefix
   and appends a text-only ephemeral instruction. A synthetic user checkpoint,
   not an inline system message, represents compacted history.
6. The structured checkpoint is installed only by a successful major compact;
   v0.7.74 does not add a second background memory owner.
7. Token state, query ledger, checkpoint, generations, and canonical compact
   events are keyed by stable `contextId` with root/child lineage. Session-only
   and `scope: worker` attribution is insufficient.
8. Runtime observation carries a bounded transcript tail and revision-bound
   cursor. Full transcript recovery uses explicit pagination; no daemon message
   depends on a frame near the fixed 8 MiB transport limit.
9. A fallback rewrite is successful only when it strictly reduces tokens,
   restores physical request validity, and commits. Reference-only rewrites,
   unchanged/oversized candidates, failures, and stale revisions emit no
   successful compatibility callback and leave canonical history replayable.
10. Exact pre-compaction messages are transaction data. The root host reconciles
    them into lineage and durably commits them before old-island payload may be
    evicted from memory. Sidecar data is flushed before a slim main snapshot is
    published; failure preserves the last exact copy even when that temporarily
    costs more memory or duplicates main/sidecar entries.
11. Child compaction callbacks are observations, not authority to mutate root
    Session messages or lineage. Root mutation is fenced by `contextKind`, not
    inferred from a shared Session ID.
12. Exact detail recovery is one read plane over persisted lineage: deterministic
    revision-bound search returns stable entry citations, followed by bounded
    exact reads. It is separate from cross-task governed memory and adds no
    embeddings, vector database, background extractor, or automatic instruction
    reinjection.

**Consequences**:

- FEATURE_251/ADR-050 remains authoritative for lossless tool-output admission
  and micro-compaction but no longer defines the default trigger for major
  history compaction.
- Final post-compact tokens are component-accounted rather than targeted to an
  arbitrary number; the invariant is full eligible-prefix coverage.
- Cache-capable providers can preserve the main prefix cache, while providers
  without it retain identical correctness.
- SDK/UI clients can distinguish root active provider input, child contexts,
  full transcript recovery, and the last compact transition.
- A persistence failure can leave a larger live lineage, and a crash between
  sidecar flush and main replacement can leave duplicate physical copies. Both
  are preferred to deleting the only exact copy; stable entry IDs deduplicate
  the logical transcript.
- Root Agent and SDK hosts share the same persisted evidence and revision. Old
  transcript text is returned as low-authority historical evidence, while
  current instructions and verified current workspace state remain dominant.
- Older v0.7.x `enabled: false` inputs remain source-compatible but are ignored.

**Rejected alternatives**: protecting a fraction of the model maximum,
summarizing one arbitrary oldest chunk per trigger, repeated compact-until-low
loops, summary-of-summary query preservation, partial-progress commits,
session-only event ownership, silent transcript truncation, eviction before
durable acknowledgement, scanning raw JSONL with ordinary shell tools, and a
second semantic-memory/indexing subsystem.

**Reconsideration gates**: changing the 20% protection ratio, internal
checkpoint cadence, or all-query ledger guarantee requires a versioned eval and
a new ADR. Public knobs require three concrete independently useful host cases.

---

## ADR-058: Model Agent Wait Is Mailbox Control, Not Event Telemetry

**Status**: Accepted (2026-07-23)

**Driver**: `FEATURE_273`, post-FEATURE_270 coordination cost and reliability
review

**Context**: The unified Actor/Turn control plane exposed progress, terminal,
and mailbox activity through one model-visible wait shape. A parent could wake
and resample on every progress event even though progress was useful only to
UI/SDK telemetry. Terminal-only filtering reduced some churn but still coupled
the model tool to event cursors and made it easy to poll a second state channel.
At the same time, the process-local MessageQueue meant a completion committed to
the durable Actor snapshot could be absent after a crash before the parent
transcript acknowledged it. Replaying every unacknowledged historical mailbox
entry would have duplicated old completions after upgrade.

**Decision**:

1. Model `wait_agent` is a caller-scoped mailbox yield. Its only input is a
   bounded timeout. It ends for deliverable Agent mailbox evidence, root user
   input, interruption, or expiry and returns only a wake acknowledgement.
2. Actor progress stays on the Runtime event stream. SDK snapshot, replay, and
   sequence-based long-poll remain unchanged and may wake on progress; they are
   not exposed as model control selectors.
3. Safe-boundary delivery owns transcript authorship. Root prompts remain real
   user turns. Agent messages, completion envelopes, and system reminders are
   synthetic Runtime context. A system reminder may be delivered at a later
   boundary but cannot independently end a model wait.
4. `list_agents` owns tree-state inspection. `agent_output` owns a bounded read
   for a known Actor/Turn and must not be polled as a completion substitute.
5. Completion acknowledgement occurs only after the authoritative parent
   transcript/session message commits. Actor snapshots persist an explicit set
   of root completion turn IDs still awaiting that acknowledgement.
6. Initialization republishes only the explicit pending-delivery set. A legacy
   snapshot without the set infers no replay work from historical mail.
   Process-local queue projection deduplicates the same child turn ID, covering
   both a hard restart and a same-process Runtime registry rebuild.
7. Runner yield provenance crosses wrappers such as Goal lifecycle adapters so
   the next safe-boundary drain uses the correct priority without creating a
   second orchestration state machine.

**Consequences**:

- Long child waits consume elapsed time but no extra parent-model calls or
  tokens merely because progress is emitted.
- UI, tracing, SDK, and daemon consumers retain complete Actor progress and
  event replay without a capability-version change.
- The model receives authenticated completion content and structured task
  metadata once, after a wake acknowledgement, rather than receiving raw event
  batches inside tool output.
- Crash recovery may republish one explicitly pending root completion, while
  acknowledged and legacy historical completions remain quiet.
- Coordination guidance must distinguish inspection (`list_agents`), mailbox
  waiting (`wait_agent`), telemetry (`runtime.agents.events/wait`), and targeted
  output (`agent_output` / `runtime.agents.output`).

**Rejected alternatives**: progress-triggered model wake, terminal-event
selectors in the model schema, polling `agent_output`, consuming mailbox content
inside the wait handler, acknowledging completion before transcript persistence,
replaying all unacknowledged historical mail, or adding a second durable task
registry beside the Actor tree.

**Reconsideration gates**: adding a new model wake source requires concrete
evidence that it carries action-critical information unavailable through the
mailbox and a cost/behavior eval showing it does not recreate progress-driven
resampling. Broader replay requires a versioned durable delivery marker written
by the older producer; absence of that marker remains non-replayable.

---

## ADR-059: Memory Intervention Reuses the Governed Plane and Awaits Sparse Events

**Status**: Accepted (2026-07-25)

**Driver**: `FEATURE_275`, adversarial review of arXiv:2607.08716 and
FEATURE_260's production recall timing

**Context**: Long-horizon agents can retain a relevant fact yet fail to let it
shape the next action. FEATURE_260 introduced a thin Memory Agent, but its
semantic prefetch became usable only if a later recall repeated the same
decision key after the asynchronous selector completed. The coding loop usually
advances its revision or observation sequence, so a valid result could miss its
decision. Directly copying the paper's mutable private status/knowledge/
procedure bank would also create a second memory authority beside F228 and
bypass KodaX scope, lifecycle, approval, and provenance work.

**Decision**:

1. F228 remains the only durable memory authority. F275 introduces no second
   bank, vector index, sidecar store, or free-form status persistence.
2. Current objective and open todos are read-only candidates rebuilt from
   authoritative run state. Recent observations are session-local; durable
   candidates come from a fresh F228 pack at intervention time.
3. Automatic semantic intervention occurs only after tool failure,
   verification failure, or a durably committed context compaction. It is
   awaited before the affected Action-LLM request.
4. The runtime makes no selector call by default. An in-process host may inject
   `memoryRecallRunner`; daemon DTOs reject the function binding.
5. The selector receives a closed, prompt-safe candidate set and may return
   only exact offered IDs. Deterministic exact pins remain authoritative.
   Malformed/fuzzy/unknown output, timeout, provider error, cancellation, or
   state revision change fails silent.
6. Central claim safety runs before selection and before prompt rendering.
   Private/sensitive observations are excluded. Suspicious tool text is
   represented by a neutral evidence reference rather than copied prose.
7. Trace receipts distinguish offered candidate identity, selected candidate
   identity, and evidence actually exposed. Exposure is not causality.
8. Semantic selector quality and end-task effect remain experimental until a
   preregistered candidate/selector/action evaluation passes. Architecture
   integrity alone cannot justify a “better than the paper” claim.

**Consequences**:

- A memory decision can affect the intended next action instead of arriving as
  dead prefetch.
- The only extra latency is on sparse registered events and only when a host
  explicitly supplies a selector.
- KodaX preserves stronger governance and package independence, but makes no
  unmeasured task-effect superiority claim.
- Compaction becomes an intervention trigger only after commit, avoiding a
  reminder that is erased by the same compaction wave.
- A selector outage or malformed response removes optional semantic recall
  without blocking the coding run.

**Rejected alternatives**: fixed-interval calls, every-step calls, asynchronous
same-key prefetch, a paper-shaped second mutable bank, LLM extraction of every
trajectory fact, free-form advisor output, fuzzy tool matching, main-provider
implicit reuse, pre-compaction injection, or declaring success from routing
metrics alone.

**Reconsideration gates**: making semantic selection default-on requires frozen
task-effect evidence with zero privacy/unknown-ID violations, no registered
case regression, and a positive paired confidence interval. Adding a durable
execution-state bank requires three concrete cases F228 projections cannot
serve plus a new authority/lifecycle ADR.

---

## ADR-060: Auto Permission Degradation Preserves Intent and Does Not Change Engines

**Status**: Accepted (2026-07-29)

**Driver**: `FEATURE_277`, v0.7.78 intent-aligned Auto Mode correction

**Context**: ADR-056 correctly moved Auto Mode permission ownership into the
Runtime, but its automatic, durable LLM-to-rules fallback conflated classifier
availability with user intent. A transient classifier failure could therefore
replace the user's selected policy engine and make later calls obey a different
policy. Sandbox readiness was also at risk of becoming an authorization
shortcut even though containment and permission answer different questions.

**Decision**:

1. This ADR supersedes only ADR-056 Decision 3 and its claims that automatic
   fallback persists or reuses the Rules engine. ADR-056's Runtime ownership,
   ordering, bounded input, permission transport, and exact-grant decisions
   remain in force.
2. Precisely modeled safe operations use a deterministic pre-classifier
   decision. All remaining Auto[LLM] calls use the configured classifier.
3. Classifier timeout, provider failure, or invalid output is retried once.
   A second infrastructure failure applies the call-local Accept-edits
   boundary; it does not mutate, cache, or persist an engine change.
4. Rules is an explicit, persisted user selection. Neither classifier failure,
   permission timeout, nor sandbox availability may select it implicitly.
5. Permission is decided before optional ASRT containment. A sandbox may
   contain an admitted operation, but readiness, failure, or fallback cannot
   authorize it or cause a second classifier/approval pass.
6. `runtimeAutoModeGuardrail` v4 identifies this contract. Its metadata must
   report that fallback does not persist the engine, and v0.7.78 clients that
   depend on this invariant require v4 rather than accepting a v3 daemon.

**2026-08-03 Auto[LLM] decision-semantics addendum**:

7. Auto[LLM] is an automatic reviewer whose default verdict is `allow`; it is
   not a mechanism for requiring the root user to authorize each concrete
   command. An operational classifier may return `ask` only when supplied
   facts establish one of two hazards: (a) a read from a concrete store/path
   known to hold keys, tokens, passwords, or credentials, or a concrete KodaX
   credential/permission/trust configuration mutation whose target controls
   authorization; or (b) direct destruction/formatting of critical system data
   or devices, or direct essential-resource exhaustion, that can destabilize
   the operating system or make unrelated installed software unavailable.
8. Ordinary project edits, deletes, moves, copies, and Git mutations including
   stash, plus normal global dependency install/uninstall/upgrade/reinstall,
   are not approval reasons by category. Command complexity, incomplete
   analysis, general uncertainty, network or privilege syntax, task-scope
   mismatch, and lack of command-by-command authorization are also
   insufficient by themselves.
9. Static analysis has two roles in Auto[LLM]: deterministic fast admission
   where safety is fully modeled, and bounded facts for the classifier. It
   must not add a second approval standard. Historical ADR-025 Tier 0 matches
   are therefore classifier facts in Auto[LLM], while explicit Auto[Rules]
   retains the legacy deterministic gate. This supersedes ADR-025 only for the
   Auto[LLM] decision owner.
10. A valid classifier `decision=allow|ask` remains the final verdict. Hazard,
    reason, rules, and static signals are explanatory evidence and cannot
    override it. Decision-contract or provider failure remains governed by
    Decision 3's bounded retry and call-local Accept-edits fallback; incomplete
    analysis is not itself an `ask` verdict.
11. A user's rejection of an `ask` cancels only that tool-call attempt and must
    return explicit safer-alternative guidance to the main agent. It does not
    create a persistent path, command-prefix, or task denial. Any revised call
    is reviewed normally and the classifier's new decision remains final.

**Consequences**:

- A classifier outage can narrow one call to Accept-edits behavior without
  silently changing the user's policy for the current or later Session.
- A functioning classifier asks only for the two concrete hazard classes;
  ordinary work is automatically reviewed and admitted without transferring
  judgment back to the user.
- Runtime, daemon, REPL, and SDK hosts share one explicit engine owner and one
  capability boundary.
- ASRT remains independently usable through the sandbox SDK and never becomes
  an Auto Mode correctness prerequisite.
- v3 daemons remain attachable only to clients that do not require the v4
  invariant; an auto-starting v0.7.78 client upgrades or rejects them through
  the existing idle-fenced capability negotiation.

**Rejected alternatives**: durable or call-local implicit Rules selection,
using sandbox readiness as permission evidence, repeating permission after a
containment fallback, removing classifier retry, or advertising v4 while
retaining v3 fallback metadata.

**Reconsideration gates**: any automatic engine transition requires explicit
user-facing semantics, a separately versioned capability, and evidence that it
cannot broaden authority after infrastructure failure. Moving containment
above permission requires a threat-model update and cross-platform proof that
containment state cannot act as authorization.

---

## ADR-061: Runtime Event Order Belongs to the Session

**Status**: Accepted (2026-08-08)

**Driver**: `FEATURE_291`, concurrent SDK/CLI Sessions sharing one Runtime home

**Context**: Runtime events were persisted per Run but numbered through one
Runtime-home sequence and lock. The total order had no consumer-level meaning:
observations, recovery, permissions, and A2A all operate on a Session or Run.
It did, however, couple unrelated processes and allowed one stale lock to fail
another Session.

**Decision**:

1. A Session journal is the sole event-order authority. Public Run replay is
   bound to its owning Session; internal diagnostics may merge managed-child
   Session events by timestamp without claiming a resumable aggregate order.
   Different Sessions are intentionally incomparable.
2. The resumable cursor is `{ sessionId, journalEpoch, seq }`. The epoch fences
   replacement/reinitialization; a bare sequence is insufficient.
3. Public event access must identify a Session or Run. Run-scoped replay first
   resolves its Session and validates the cursor and any supplied Session.
4. Storage retains per-Run event bodies but moves sequence state and locking to
   an encoded per-Session directory. No Runtime-global allocator remains.
5. Legacy global journals are retained as audit artifacts but never merged into
   new live Session replay. Migration starts a fresh journal explicitly.
6. Daemons advertise `sessionEventJournal:1`; incompatible daemons fail
   capability negotiation.
7. Each A2A Task owns one Runtime Session and stores its full cursor. A2A
   projects semantic task lifecycle only, not high-frequency Runtime telemetry.
8. Failure latches, pending batches, retention watermarks, and replacement
   epochs are Session-scoped. A failed Session cannot block another Session;
   deleting and recreating an ID starts a fresh epoch, and legacy watermarks
   without an epoch are ignored.
9. Each Run durably indexes every `{ sessionId, journalEpoch }` that has written
   to it. Retention-watermark corruption can therefore fail closed for a fully
   trimmed managed-child journal without blocking Sessions a valid index proves
   unrelated. A missing or corrupt index cannot prove non-membership and fails
   closed during migration instead of silently skipping lost events.

**Consequences**: independent Sessions no longer contend or share a failure
domain. Same-Session writers still serialize, and SDK consumers must migrate
unscoped/numeric replay code. Cross-Session aggregation, when a host wants it,
is a UI merge by timestamp/arrival and is not presented as durable causal
order.

**Rejected alternatives**: retaining the global sequence with a more tolerant
lock, allocating process-sized global ranges, treating Run as the journal
authority, or accepting numeric cursors during a compatibility window. Each
either preserves the wrong coupling or loses Session-wide recovery/epoch
validation.

---

## ADR-062: Provider Output Replacement Is an SDK-Owned Segment Projection

**Status**: Accepted (2026-08-17)

**Driver**: streamed provider fallback, max-token continuation, and shared
Runtime consumers that must render the same effective assistant response

**Context**: a provider call can stream a partial response and then be replaced
by a retry, fallback, or output-budget escalation. A continuation, however,
must append. Accumulating every delta by Run preserves audit facts but mixes an
abandoned physical request into the live response. Re-appending a provider's
cumulative `getFullResponse()` at recovery boundaries also duplicates text that
the stream already delivered. Attempt numbers cannot distinguish all cases
because a fallback or escalation may reuse an attempt number.

**Decision**:

1. Every physical provider request starts one output segment with a logical
   `responseId`, unique `providerRequestId`, and `mode: append | replace`.
2. `responseId` is the logical reply boundary. A new value starts a fresh live
   projection. `providerRequestId` attributes deltas to exactly one physical
   request and rejects late deltas from an abandoned request. `mode` preserves
   prior segments for a continuation or removes only the current failed segment
   for replacement.
3. SA and managed-Agent execution emit the same contract for initial calls,
   retries, provider fallback, non-stream fallback, max-token escalation, and
   continuation. The CLI and every SDK host consume the projection instead of
   inventing recovery text.
4. Runtime journals retain all segment-start and delta facts in Session order.
   `sessions.observe()` exposes the effective per-Run segment projection in its
   live snapshot. Canonical conversation history remains the terminal durable
   authority.
5. Daemons advertise `liveOutputSegments:1`. Auto-starting SDK clients use the
   authenticated health probe to gate capabilities before attaching the real
   embedder identity. An incompatible owner is contacted only with an ephemeral
   upgrade identity, then may be replaced through the durable exit-settlement
   ticket and its owner/process-start identity, management revision, idle-work,
   client-count, process-exit, shutdown-outcome, and cleanup fences. A daemon
   used by another client or carrying governed work is never stopped.
   Attach-only clients fail closed.
6. Updated hosts do not retain a checkpoint/text-replay execution fallback or
   protocol downgrade. Historical data may be migrated, but legacy `uiHistory`
   without stable source/request identity cannot be losslessly deduplicated by
   text equality.

**Consequences**: raw audit truth and effective live truth are both preserved;
fallback and continuation no longer require UI heuristics. KodaX CLI, Runtime,
and Space converge on one projection after streaming, reconnect, or snapshot
hydration. Old polluted UI caches remain an explicit historical limitation.

**Rejected alternatives**: cumulative text per Run, attempt-number-only
replacement, provider-recovery checkpoint replay in each host, content-based
deduplication, daemon protocol downgrade, or stopping an incompatible daemon
without proving both ownership and quiescence.

---

## ADR-063: Complete Runtime Exit Is an SDK-Owned Durable Transaction

**Status**: Accepted (2026-08-17)

**Driver**: a host crash can occur after Runtime stop acceptance but before
containment and owner cleanup are durably understood

**Decision**: `settleKodaXRuntimeExit()` writes an exact-owner settlement ticket
before stop, binds it to daemon/process-start and platform boot identities, and
uses the existing owner-policy fence for the cooperative stop. A `clean` result
requires verified orderly shutdown; a `recovered` result may repair only
identity-scoped Windows process/Job/ACL residue or, after a boot change, exact
POSIX owner/state/policy residue. Missing, foreign, corrupt, active, reused, or
same-boot unverifiable evidence returns `blocked` with a bounded next action.

**Consequences**: host applications no longer duplicate Runtime lifecycle and
sandbox recovery protocols. Settlement is resumable and idempotent, but it is
not a general process-kill, ACL-delete, or forced recovery API. Existing
shutdown outcomes remain immutable audit facts and npm consumers can opt into
the local `runtimeExitSettlement:1` capability.

**Rejected alternatives**: caching a PID/PGID, deleting markers by path,
force-stopping a replacement owner, treating daemon exit alone as containment
proof, or letting each host invent a timeout/replay policy.

---

## ADR-064: Runtime Owns Bounded Interactions and Stale Session Tail Recovery

**Status**: Accepted (2026-08-17)

**Driver**: a host prompt or permission dialog can outlive the authoritative
Runtime request, while an interactive host can race a prepared Session append
with another durable writer and either hang or lose the newest tail.

**Decision**: Runtime creates one owner AbortSignal for each AskUser,
permission, and MCP elicitation lifecycle, validates independent timeout
options before embedded/Worker/daemon startup, and accepts a default answer only
when it is valid for the request. SDK permission UI must resolve through
`handleRuntimePermissionRequest()` so timeout, cancellation, or a competing
response wins over a late callback. Interactive persistence may use a prepared
tail for the bounded fast path, but a `data_changed` conflict must reload and
merge through the authoritative full delta path; background write failures are
diagnostics rather than swallowed state.

**Consequences**: UI hosts can close prompts deterministically and configure
`userInputTimeoutMs` separately from `permissionTimeoutMs`. A stale prepared
boundary cannot silently drop new session state, and a persistence failure is
observable without changing shell or sandbox fail-closed policy.

**Rejected alternatives**: unbounded host callbacks, trusting late dialog
answers, accepting arbitrary defaults, retrying a stale tail unchanged, or
silently ignoring background persistence errors.

## ADR-065: Windows Sandbox Migrates to Token-Carried Capability Scoping over an Append-Only ACL Substrate

**Status**: Superseded in part by ADR-066 (2026-08-25). The capability-SID
permission economics remain accepted; the ASRT-session execution substrate,
dual-mode rollout, and read-confinement assumptions below are replaced by the
Windows v2 backend and atomic cutover in ADR-066.

**Driver**: the Windows sandbox runs every sandboxed process as one shared
machine account (`srt-sandbox`). Effective permission is therefore the
account's path-ACL state, so every policy change must grant and revoke ACLs,
half-applied state is unsafe, and the account needs a single-writer discipline
during ACL mutations. That discipline — owner admission, exclusive fences,
poison tickets, recovery loops — is correct engineering under the model, but it
is also a standing availability liability: Issues 301-304 (and the B:\
resolution failure in 303) all trace to coordination state interacting with
long-lived commands or broken installations, not to containment itself. A
cross-codebase study of Codex (codex-rs, `C:\Works\PubProj\codex`, two
research passes with file:line evidence) demonstrated a model where permission
lives in each process's restricted token (per-writable-root capability SIDs)
and on-disk ACLs are append-only and therefore inert when stale. Under that
model there is no teardown, no single writer, no owner exclusivity, and no
class of "pending cleanup blocks admission" failures — the class that produced
304. The same study verified four discipline holes in Codex's implementation
(unlocked read-modify-write on `cap_sid` with silent regeneration, torn-write
hard failure on `deny_read_acl_state.json` requiring human deletion, no
teardown or GC for granted ACEs, and unreaped background processes); KodaX
will not copy those.

**Decision**: migrate the Windows backend to Codex-shaped permission economics
— token-carried capability scoping over an append-only, idempotent ACL
substrate — while keeping KodaX's crash discipline (atomic, versioned state
writes; durable recovery; fail-closed admission with structured reasons) and
KodaX's stricter text-mutation safety (same-path FIFO, file-identity checks,
revision CAS). Concretely:

1. **Capability issuance**: one stable capability SID per (workspace root,
   write-root) pair, persisted under KODAX_HOME with atomic
   temporary-file-plus-rename writes and a versioned format; concurrent
   writers merge by re-reading and re-appending, never last-writer-wins.
2. **Token construction** (srt-win, vendored source in-tree): sandboxed
   processes launch with a `WRITE_RESTRICTED` token whose restricting-SID set
   contains exactly the capability SIDs of the current policy's writable
   roots.
   Stale ACEs on disk name SIDs no live token carries, so old grants are
   inert by construction.
3. **Append-only ACL substrate**: grants become idempotent
   `ensure_allow_write_aces`-style operations (single-call atomic, safe to
   repeat, safe after crash); revocation-by-removal is retired in favor of
   token scoping plus a bounded reconcile sweep for deny-read entries, which
   keeps its explicit revoke path.
4. **Owner exclusivity retires**: with no mutating teardown there is no
   single-writer invariant to enforce. The pending-reset admission gate, ACL
   owner markers, poison tickets, and the standalone keyless-owner
   precondition reduce to (a) capability-file locking, (b) the deny-read
   reconciler's short machine-global transaction, and (c) process containment
   (Job objects) — which remain.
5. **Session model stays**: this clause is superseded by ADR-066. ASRT remains
   the Windows network-session provider, but it is no longer the filesystem or
   process-execution authority.

**Migration phases** (each independently shippable, each with a rollback):

- **P0 — substrate parity (no behavior change)**: reorganize srt-win ACL
  helpers into idempotent ensure/reconcile primitives with atomic state
  writes; add capability-SID issuance alongside the existing grant/revoke
  flow without using it for enforcement. *Accept*: existing suites green;
  capability file survives kill -9 mid-write; repeated ensure converges.
- **P1 — dual-mode tokens**: restricted tokens carry capability SIDs while
  the account ACLs remain authoritative; doctor reports mode `dual`.
  *Accept*: sandboxed commands succeed with an empty-permission account if
  and only if the policy grants nothing (proves scoping works); deny-read
  reconciler still enforced; rollback = config flag back to `acl`.
- **P2 — append-only enforcement**: stop revoking allow-ACEs on session
  teardown; permission is token-scoped. Remove owner exclusivity and the
  pending-reset gate; standalone admission loses its keyless-owner
  precondition. *Accept*: the Issue-304 acceptance tests pass by
  construction (no coordination state to race); cross-policy concurrent
  bootstraps succeed; crash-injection suite (kill during ensure, during
  token construction, during reconcile) leaves inert or absent state, never
  over-permissioned state.
- **P3 — residue GC and teardown of the old protocol**: a bounded sweep
  collects orphaned capability SIDs' ACEs (bounded per-run quota, best
  effort); the poison/recovery machinery is retained only for deny-read
  reconciliation and process containment. *Accept*: steady-state ACL count
  is bounded on a long-lived machine; uninstall removes account, filters,
  and ACEs.

**Security review gates** (P1 and P2 mandatory): token construction must be
proven unable to widen a policy (the enabling-SID set is derived only from
the policy's declared roots, never from on-disk ACEs); a corrupted capability
file must fail closed into re-issuance with fresh SIDs and a diagnostic (the
opposite of Codex's silent regeneration); reconcile transactions stay
machine-global and short.

**Consequences**: the 303/304 failure class is eliminated structurally rather
than patched; cross-policy cold-start windows close; the coordination surface
that Issues 291/295/297/299 hardened shrinks to file locks plus the reconcile
transaction. Cost: a vendored-Rust protocol change with a two-release
dual-mode window, plus a one-time on-disk migration for existing installs
(detected at doctor time; old account state is forward-compatible because
P1/P2 only add). The maintainer's efficiency-first principle is served on both
ends: fewer availability failures, and no new restrictions — enforcement
narrows to what each process's token says.

**Rejected alternatives**: keeping the single-account teardown model and
patching coordination indefinitely (accepted through v0.7.96; each new
long-lived-command shape risks a new 304); copying Codex wholesale including
its state-file discipline (rejected: torn-write human-intervention failures
and silent orphaning violate KodaX's crash-recovery bar); adopting
owner-join/shared-owner protocols inside the current model (rejected: highest
risk per the Issue-304 red team, and discarded by P2 anyway); removing the
session layer (rejected: sessions amortize setup and carry the concurrent
text/shell overlap that v0.7.94 delivered).

**Evidence base**: Codex mechanism research (2026-08-24/25, two passes:
manager.rs seatbelt/bwrap/restricted-token model, cap.rs capability SIDs,
token.rs/spawn_prep.rs restricted-token construction, deny_read_state.rs
reconciler, job.rs preserve_descendants; four documented holes as above);
Issue-304 three-way design review (implementation feasibility, safety red
team, codex cross-check) in this repository's session records.

## ADR-066: Trusted Text Transactions and a Native Windows Shell Sandbox Are Separate Authorities

**Status**: Accepted and implementation authorized (revised 2026-08-27).

**Driver**: the production `write` failure in session
`20260825_215704_r8107f13f0eec3` exposed two concerns that the legacy design
incorrectly joined. ASRT `0.0.65` through `0.0.73` consumes its runner stdin as
control data and does not forward KodaX's text payload, while the shared
workspace-session ACL lifecycle lets shell setup, cleanup, owner and poison
state block direct text operations. Fixing only stdin would preserve the
second failure class. A fresh review of Claude Code's trusted FileWrite/Edit
boundary and Codex's native Windows process sandbox showed that these are two
different authorities and should have disjoint production call graphs.

**Decision**: text authority is split from shell containment on every desktop
platform; Windows v2 additionally replaces the legacy Windows shell backend.

1. **Trusted text transaction**: `write`, `edit`, `multi_edit`,
   `insert_after_anchor`, and `undo` execute in the trusted KodaX Runtime.
   They never enter ASRT, a workspace session, the shell runner, or a sandbox
   text helper. Text mutation is constrained by host policy and final resource
   identity; it is not described as OS-token sandbox enforcement.
   KodaX's root and `/coding` `runKodaX`, `startKodaX`, `runManagedTask`,
   `createKodaXTaskRunner`, `createDefaultCodingAgent`, `KodaXClient`, and `Client`
   entries bind this authority when the embedder did not supply one. Their
   root closure reads the live linked-worktree registry for each transaction;
   the CLI uses the same entry. Runtime-owned Runs continue to replace any
   caller host with their authenticated workspace registry.
2. **Cross-platform in-process filesystem primitive**: strict platform path
   and commit guarantees are provided by a narrow native binding loaded into
   the trusted Runtime on Windows, Linux, and macOS. The transaction itself
   starts no process, uses no command IPC, and has no dependency on
   sandbox setup, runner health, owner, cleanup, reset, or poison state. The
   binding exposes only no-follow handle walking, namespace/resource
   identity, a process-owned kernel lock, flush, and atomic replace. Windows
   uses a host-SID private kernel namespace; Unix uses `openat(O_NOFOLLOW)`, a
   UID-private lock inode below a fixed per-UID system coordination root, kernel
   `flock`, `fsync`, rename, and parent `fsync`. The atomic replace is the
   linearization point: no fallible Windows operation follows it, while a Unix
   parent-`fsync` or failed escape rollback returns a receipt-bearing
   `committed_uncertain` result that requires a reread and forbids blind retry.
   File presence is never
   ownership state. TypeScript remains
   responsible for permission policy, content
   transformation, revision CAS, backups, receipts, and structured errors.
3. **Final-resource authorization**: local lexical input is screened before
   filesystem access. Windows UNC/device namespaces, ADS, drive-relative
   paths, DOS device aliases and trailing dot/space fail closed; Unix rejects
   non-local and symlinked resolution. Unsupported remote filesystems fail
   closed everywhere. A host-owned capability binds an authorized root to a canonical
   handle identity. Every existing component below it is
   opened without following reparse points or symlinks; the final resource identity and
   sensitive-directory classification are authorized again inside the lock.
   Initial v2 rejects links, Windows junctions/other reparse points and multi-link
   targets rather than silently following them.
4. **Per-slot transaction and CAS**: one short cross-Runtime kernel lock covers
   one stable canonical namespace slot, not a process lifetime. Windows uses
   its volume identity plus an NT-native normalized path. Unix uses the local
   device plus canonical absolute namespace path; the slot is identical while
   missing, after parent creation, while present, and after atomic replacement.
   Device/inode/content identity belongs to the revision, not the lock key.
   Linux case-insensitive filesystems, ZFS datasets with unproven case/
   normalization semantics, and per-directory casefold are rejected until a
   filesystem-native key is available; macOS uses canonical Unicode
   case folding for its volume semantics. This coalesces every caller based on
   one observed revision while allowing distinct case-sensitive Unix files to
   remain parallel. The Windows lock is
   only an OS handle; Unix retains an inert private inode that carries no owner
   record. Process death releases ownership automatically and leaves no
   recovery ticket or persistent-owner state. Inside the lock KodaX reopens the parent/target,
   revalidates identity and policy, rereads content and revision, applies CAS
   to the candidate bytes computed by the trusted TypeScript tool, writes an
   exclusive same-directory temp file, flushes it, and atomically replaces or
   creates the target. Windows first holds a delete/write reservation across
   the locked final reread, CAS, and POSIX-semantics rename: compatible readers
   can retain a complete old handle while no incompatible reader or new writer
   enters the commit window. There is no
   in-place fallback. Diff rendering, LSP work, and presentation occur after
   releasing the lock.
5. **Conflict contract**: two KodaX text transactions based on the same
   revision produce one commit and one structured stale conflict; different
   canonical slots do not wait for one another. An arbitrary shell does not
   participate in this lock. A shell change observed by the locked final reread
   is a conflict, and an incompatible writer handle at that reread is
   contended. Windows' final reservation excludes a new writer after that
   reread; on Unix an uncooperative write, replace, or rename after it remains
   an ordinary OS race. Documentation must not claim that KodaX
   serializes arbitrary shell filesystem activity.
6. **Undo receipt**: a backup records canonical slot identity, pre-image and
   post-commit revision. Undo restores only when the current revision still
   equals that post-commit revision; otherwise it returns stale instead of
   overwriting a user or shell change. If Undo itself returns
   `committed_uncertain`, the retained backup is rebound to the observed
   post-commit revision so a later Undo remains CAS-checked. New-file
   uncertainty carries `pre_state: missing` in the error receipt but does not
   synthesize a legacy delete-style Undo entry.
7. **Native shell protocol**: shell/process execution uses a separate
   KodaX-owned host/runner protocol with bounded `Spawn`, `Ready`, `Stdin`,
   `CloseStdin`, `Stdout`, `Stderr`, `Exit`, `Error`, and `Terminate` frames.
   Target EOF is explicit and exactly once but does not close the control
   stream. Slow consumers impose backpressure; early stdin close retires only
   that stream. Cancellation and timeout send `Terminate`, then wait for the
   runner to drain the complete Job before returning the original stop reason.
   Control and events use two nonce-bound, account-ACL-protected pipes with
    opposite protocol directions whose peer PID must match; termination additionally requires a validated host-only,
    nonce-bound terminal record rather than trusting a process exit code. Request
    and terminal state is created below a no-reparse directory with an exact
    protected host/SYSTEM-only DACL. Both the SDK policy boundary and native host
    reject allow roots overlapping that directory in either direction, and
    deny roots at or below it, before ACL authorization or target creation.
    Ancestor denies remain permitted because the child DACL is protected.
    Doctor only verifies this state; explicit setup may create or repair a
    no-reparse, host-owned direct child after the sandbox SID is idle. Repair
    retires only expired dead-PID request records or dead-owner terminal records
    that already prove Job drainage. Live/unexpired/malformed/unknown records and
    ACL-recovery receipts remain fail-closed.
    The process-level ASRT broker starts the verified native shell artifact in
    a liveness-controller mode under the trusted host token. That controller
    creates its named pipe with a protected DACL containing exactly Host and
    SYSTEM full-control ACEs, rejects remote clients, verifies owner/DACL before
    readiness, and keeps multiple pending instances for concurrent hosts. The
    broker authenticates the advertised pipe PID against the spawned controller;
    each host authenticates the actual pipe server PID. The controller monitors
    both broker process identity and broker stdin, while the broker observes the
    controller's exact exit and bounded stderr. Loss on either side closes all
    controller handles and makes active Jobs fail closed; a later command
    creates a fresh broker instead of inheriting stale controller state.
8. **Containment before execution**: the restricted runner creates the shell
   target suspended with an explicit handle list and creation-time assignment
   to a no-breakaway, kill-on-close Job. It reports `Ready` only after proving
   Job membership and resumes afterward. Any failure or control-channel loss
   terminates the Job; KodaX never races an already-running PID with a later
   PowerShell containment probe.
   The trusted host also creates a nonce-bound private desktop whose access
   requires both the shared sandbox group and the exact policy capability;
   another policy's restricted target cannot open it. The target's
   `lpDesktop` references it so restricted-token loader initialization works
   without exposing the interactive desktop. The host sets inherited error
   mode before ASRT launch and runner code sets it again; final-target faults
   remain structured with their actual exit code and stderr. The
   ASRT-created trusted runner itself starts before KodaX can assign a Job;
   its pre-main boundary remains ASRT's dedicated account plus authenticated
   host teardown, matching the current Codex elevated-runner residual. Only the
   untrusted final target has creation-time KodaX Job containment.
9. **Shell permission and network split**: ASRT supplies only its network
   proxy, WFP, CA and dedicated account. The KodaX runner supplies a
   `WRITE_RESTRICTED` token whose restricting set carries one ephemeral full-
   policy capability, stable read/write filesystem-clause capabilities, and
   the dedicated primary account, per-launch logon, and Everyone SIDs for
   Windows subprocess compatibility, matching current Codex. Removing the
   primary SID makes real Node/cmd/PowerShell child creation fail with `EPERM`.
   The account SID remains absent from the token's default DACL. The full-policy capability isolates the private desktop but is
   never persisted on filesystem roots. Persistent write authority instead uses
   capability SIDs derived from account generation, final handle-canonical root,
   and clause (`allowWrite` or `denyWrite`), matching Codex's bounded root model.
   Every read root receives its exact allow-read capability, and a read-only
   root receives a stable deny-write capability unless covered by a current
   write root. The ASRT sandbox group supplies ordinary read/execute or modify
   access on the normal pass; the exact read/write root capability supplies the
   restricted pass. Private ancestors receive only
   non-inheriting read-attributes/traverse/synchronize for the sandbox group,
   never list, content-read, write, delete, or inherited authority. Canonical
   targets and nested allow/deny precedence are preflighted before the first
   persistent DACL mutation.

   `WRITE_RESTRICTED` does not consult restricting SIDs for reads. `denyRead`
   is therefore an execution-scoped deny ACE for the authenticated runner logon
   SID, not a capability ACE. The host records a flushed, atomically published
   receipt before the short ACL mutation, holds no-follow target handles while
   the command runs, and removes exactly its owned ACE only after the runner
   proves the Job drained. A host crash leaves recovery evidence keyed by exact
   PID creation time; the next shell host recovers stale evidence under the same
   short ACL mutex. Fixed Agent Home and credential denies are installed once
   on exact existing roots for the stable sandbox group through native no-follow
   handles. Cold admission idempotently installs a guard for an exact sensitive
   root created after setup. They are not propagated afresh by every command.
   This mutex covers only ACL commit/cleanup, never command
   lifetime or trusted text admission. The full-policy/root-clause split bounds
   persistent ACE growth; no speculative capability garbage collector is added.
   This remains ambient-read plus explicit deny, not a strict read whitelist.
   Because the compatibility SIDs remain in the restricted pass, an explicit
   or protected child DACL widened to one of them can bypass a later root
   capability; Issue 309 records this unresolved boundary rather than claiming
   that exact root ACEs override arbitrary child ownership.
10. **Shell concurrency**: Windows v2 shell invocations explicitly identify
    native token isolation and bypass the legacy filesystem-effect lease.
    Different policies, Sessions and Runtime processes may run concurrently.
    No owner/reset/allow-revoke/cleanup/poison admission gate spans a command
    lifetime. Inside one Runtime process, commands with the same canonical
    network policy and sandbox-account generation acquire references to one
    process-level ASRT network broker. Each command still has an independent
    native request, restricted policy token, controller connection and Job;
    releasing one command cannot close the broker while another reference is
    live. The broker is retained for one second after the last release to avoid
    cold-start churn. Different network policies or account generations never
    share a broker.

    This pool is intentionally narrower than Codex's process-shared Windows
    ingress. ASRT 0.0.65 exposes neither authenticated per-connection policy
    identity nor route selection, and allocates two ports per broker from its
    fixed ten-port range. KodaX therefore does not merge unlike policies into a
    permissive callback and does not serialize their command lifetimes. Issue
    308 tracks the remaining capacity bound for distinct policies and Runtime
    processes.

    Linux and macOS likewise prepare an independent ASRT bubblewrap or
    Seatbelt/`sandbox-exec` invocation for each command and keep no KodaX
    workspace-session owner or cross-command lifecycle lock. Shell writers on
    every platform remain ordinary OS writers and do not join text CAS.
    Public POSIX sandbox execution requires an applied target-start
    observation before it may return `completed`; a proven pre-target exit
    returns structured `backend_launch_failed` unavailability. The request is
    delivered on broker stdin and one bounded, invocation/backend-bound frame
    returns on FD3, which is not inherited by the target or fallback. Missing
    or invalid authority returns `execution_uncertain` and forbids blind retry;
    ordinary files are never execution authority. Linux host
    policy must permit unprivileged user namespaces, and KodaX does not mutate
    sysctls or AppArmor policy to obtain that capability.
11. **Atomic backend migration**: `sandbox setup` holds a machine coordination
    lock, proves the old account idle, recovers recorded ACL work, deletes and
    recreates the account, verifies that its SID changed, then writes a strict
    protocol/SID machine generation marker by flushed atomic replace. The
    embedded release manifest independently pins each native sidecar protocol
    and SHA-256 plus the ASRT release version and SHA-256. Verified bytes are
    materialized into a protected content-addressed LocalAppData store before
    load or execution; ASRT source bytes are checked before materialization and
    the staged executable is rechecked before broker startup. Windows text
    bytes remain Host/SYSTEM-only, the native shell executable grants
    read/execute to the dedicated sandbox group SID, and the pinned ASRT
    `srt-win.exe` grants local Users read/execute because the dedicated account
    must execute it. No sandbox or local-Users trustee receives write/delete.
    This store is independent of a custom or private `KODAX_HOME`. Concurrent Runtime provisioners
    share read verification of an already executing immutable image; artifact
    bootstrap is not a cross-Runtime admission lock. A fixed System32 provisioner may
    run once for that artifact bootstrap; it receives already verified bytes,
    never text-tool or shell payload data. Missing, malformed or mismatched migration state makes
    Windows v2 doctor and shell admission fail closed before broker launch.
    After cutover shell execution never falls back to the legacy Windows
    backend. Old owner/poison records are migration evidence only.
    On Unix the binding cache is provisioned under a UID-owned `0700` Agent
    Home state root, while locks rendezvous in a fixed UID-owned `0700` system
    coordination root shared across Runtime config homes. Both are denied to
    sandboxed shell write policy, and the binding is loaded through a verified
    no-follow file descriptor. The trusted text binding is
    packaged and integrity-checked independently;
    its availability and text tools never depend on shell setup or migration.

**Security invariants**: a model cannot mint either a text authorization
capability or a shell policy SID. Text authorization is repeated against
handle-derived final identity while the stable ancestor handles and slot lock
are held. Target files must be regular and single-link. The slot mutex lives
in a current-host-SID private namespace, so a restricted shell cannot precreate
the public object name and block text tools. Temp data is flushed. On Windows,
the replacement is owned by the trusted host rather than copying a foreign
sandbox owner/group; this makes old sandbox-owned files self-healing without
requiring setup or ACL cleanup. The temporary replacement receives the source's
ordered effective ACE policy; the filesystem may canonicalize DACL
protection/inheritance control at the atomic namespace commit. Stale inherited
authority is not copied from an old parent. Integrity/resource attributes
and basic file attributes are preserved. Non-default streams,
Central Access Policy state or unsupported Windows attributes fail closed;
v2 does not claim audit-SACL
preservation. Unix preserves ownership, mode, extended attributes, Linux
user-modifiable inode flags, and macOS extended ACL/file flags or fails the replacement.
Kernel-lock abandonment causes a complete reread and
CAS, never a blind continuation. Shell DACL changes use only short
add-and-verify transactions. Agent Home Runtime/daemon/grant state,
native artifacts, sandbox state, credentials, Git control files and hooks are
classified on the final identity and cannot be made writable through a path
alias. The protected native store is excluded from shell write roots; its DACL
grants only the minimum per-artifact read/execute trustee described above and
no sandbox/local-Users write/delete authority. The ASRT executable directory is
never added to the final restricted target's policy roots; ASRT launches it as
trusted infrastructure, so target ACL application cannot mutate the immutable
artifact cache.

**Consequences**: on Windows, Linux, and macOS, ASRT/runner/setup failures
cannot block trusted text tools;
the text-payload stdin bug disappears by removing that payload path rather
than forwarding it. Issue 304/305's owner/reset conflict class leaves both
text and Windows v2 shell production graphs. KodaX owns two small native
artifacts with intentionally independent health: an in-process filesystem
primitive and a shell sidecar. The text path is stricter than Claude Code's
current path-based atomic fallback, while the shell protocol follows Codex's
explicit-stdio and creation-time containment pattern.
 Issue 307 records the remaining ASRT-owned runner pre-main window: KodaX and
current Codex both create the final target in its Job at process creation, but
their shared-account runner is first launched by the external account broker.
 KodaX does not pretend that a post-spawn hardening step can close that upstream
 race. The host requests inherited modal-error suppression before ASRT launch,
 but a loader/pre-main runner fault remains part of the upstream bootstrap
 residual because ASRT owns the cross-account creation contract; final-target
 faults are suppressed. Issue 308 separately records that KodaX's exact-policy
 ASRT broker pool is not yet Codex's identity-routed shared ingress: same-policy
 commands share capacity, while distinct policies/processes remain bounded by
 ASRT's fixed proxy ports. Neither residual can affect the ASRT-independent
 trusted text path. Issue 309 records the Codex-compatible token model's
 remaining ambient-trustee weakness for any explicit compatibility ACE,
 including one already present on an external or host-owned descendant;
 FEATURE_295 does not claim to solve that upstream Windows token/loader
 trade-off.

**Rejected alternatives**: keeping a sandboxed text helper (retains both
failure classes); forwarding text bytes after ASRT's control frame (stdin-only
patch); ordinary static lock/ticket files (crash residue and recovery races);
pure Node `lstat`/`realpath` plus path-based rename (cannot close Windows
reparse TOCTOU); using target File ID as the lock key (atomic replace ABA);
serializing arbitrary shell writes (false guarantee and unnecessary global
coupling); loading the text primitive through the runner or setup lifecycle
(would let shell health block trusted text); copying Claude Code or Codex
wholesale (their product boundaries and guarantees differ).

**Evidence base**: KodaX production reproduction and direct stdin probes;
ASRT `0.0.65`, `0.0.67`, and `0.0.73`; Claude Code FileWrite/Edit and path
policy source; Codex Windows no-follow, runner, token, capability, pipe, stdio
and Job source at `2764e836`; independent architecture, security, and
concurrency/recovery reviews on 2026-08-26.
