# KodaX Product Requirements

> Last updated: 2026-09-03
>
> Current implementation baseline: `@kodax-ai/kodax@0.7.96-beta.1`.
> The GitHub pre-release is automated from the release tag; npm publication
> remains manual.
> This baseline advertises Windows `sandboxRuntime:11`;
> `runtimeExitSettlement:2` and `crashOutcomeModel:2` are unchanged.
>
> This document describes the current product. Historical pre-v0.7.43
> chain/harness designs have been removed from this current PRD because they no
> longer match the code after FEATURE_184, FEATURE_190, and FEATURE_193. Use git
> history and `docs/features/*.md` for historical rationale.

## 1. Product Positioning

KodaX is a lightweight, local-first coding agent that can be used as:

- a terminal REPL for multi-turn engineering work,
- a one-shot CLI for scripted tasks,
- a TypeScript SDK for embedding coding-agent behavior into other products,
- a Node-free single binary for restricted or air-gapped environments.

The product promise is simple: give a developer an LLM-native engineering
assistant that can read, edit, test, reason over a repository, coordinate child
tasks, and preserve useful session context without forcing a heavy IDE or
server product around it.

On Windows, a daemon-backed Runtime now establishes kernel process containment
before daemon application code runs. The daemon is placed in a kill-on-close Job
Object, and shutdown is considered verified only after the durable cleanup
outcome, daemon exit, and containment-supervisor exit are all observed. The
broader Worker owner-lease boundary tracked by Issue 256 remains open:
v0.7.92 closes the stale coordinator-ticket and recorded-release slice, but
does not prove descendant closure after an intermediate parent exits. The
v0.7.86 daemon, per-effect Job, ACL-owner, and termination-attestation
boundaries likewise do not claim that remaining Worker-owned descendant gap.

The v0.7.84 Runtime also bounds Agent progress persistence to one in-flight
projection plus one latest replacement. Same-owner Stop can reconcile a late
Actor settlement after a durability timeout and quiesce the remaining work;
foreign ownership and persistent storage uncertainty remain fail-closed.

The v0.7.85 baseline adds Session-scoped Runtime Event Journals, governed
conversation-first Memory management, reliable Memory review draining and
lesson/verdict production, and the additive `MemoryManagementAgent` SDK facade.
It also carries Agent Home and learned-root guardrails, terminal startup replay
avoidance, idle repo-intelligence Worker retirement, and the corresponding
cross-layer regression coverage.

The v0.7.86 hardening baseline adds atomic abandoned-inline-owner recovery,
process-start identity checks for ownership locks, Windows sandbox termination
attestation, durable ACL owner markers, cross-profile recovery serialization,
and fail-closed no-replay behavior when Shell effects are not proven drained.
POSIX workspace admission initializes fresh `KODAX_HOME` policy roots before
identity capture, keeps warm-up waits within the Shell abort/deadline, and
retires an invalid cached session after lease-cleanup failure before replacement.

The v0.7.88 provider baseline promotes GLM-5.3 across the Coding Plan routes
without inventing wire aliases. `zhipu-coding`, `zai-coding`, and `ark-coding`
default to `glm-5.3` while keeping `glm-5.2`; Ark retains `glm-latest` as its
legacy alias. All model IDs are sent verbatim. Because GLM-5.3 cannot disable
thinking, `off` / `none` is normalized to low effort. The same release also
ships Actor settlement convergence v2, bounded startup/resume work, bounded
classifier-reason diagnostics, and REPL learning-recovery dismissal after a
query is submitted.

The v0.7.89 baseline adds a topology-transparent ordinary conversation
projection for replaceable managed context, with conversation page-cache v4 and
fail-closed handling for unverifiable branches. FEATURE_293 makes built-in
`web_search` useful without a hosted service by using bounded DuckDuckGo HTML,
Bing RSS, and Bing HTML attempts with truthful diagnostics and isolated custom
endpoints. FEATURE_294 materializes daemon-bound Host Tools only inside their
leased Run, exposes a cache-stable capability catalog line, applies conservative
plan-mode policy, and keeps registry, revoke, and A2A authorization boundaries
fail-closed. This release does not change shell or sandbox system behavior.

The v0.7.90 stabilization release keeps those additive contracts and fixes the
follow-up system boundaries: workspace-session RPC timeouts retire through
orderly close with the cleanup grace budget and diagnosable Error details;
chained-compaction clones retain direct physical predecessors and topology-
correct archive markers; and run-scoped tool schemas normalize at the shared
model-materialization boundary. These are intentional Runtime/sandbox, Agent
lineage, Coding runtime, and REPL persistence system-code fixes, not a new
feature slot.

The v0.7.91 maintenance release adds a public SDK-owned Runtime exit
settlement transaction. Hosts persist exact ownership before a complete exit,
resume a crash-resumable ticket, and repair only verified process-containment or
Windows ACL residue; ambiguous ownership and same-boot POSIX recovery remain
fail-closed. Provider retries and continuations also expose one effective live
output projection while retaining raw audit events, and standalone binaries
bundle their lazy provider SDK dependency graphs.

The v0.7.91 follow-up interaction contract gives every AskUser and permission
request an owner-scoped AbortSignal and independent bounded deadline. Runtime
defaults are validated before admission, SDK permission hosts use
`handleRuntimePermissionRequest()` for late-answer-safe UI ownership, and MCP
elicitation cancels when its owner expires. Interactive Session persistence
falls back from a stale prepared tail to an authoritative delta merge and
surfaces background persistence failures as diagnostics.

The v0.7.92 release keeps mutation tools usable on a long-lived shared daemon
after a Worker operation disappears. The filesystem-effect coordinator reclaims
a stale same-process ticket only when that operation no longer owns the exact
lock, and a durable release marker retires the matching settled effect owner
without deleting ProgramData lock files. Managed completion waits for the
canonical Session commit, not for repo/task file projection, so Stop can
confirm instead of remaining unknown. Resumed TUI history is reconstructed from
canonical Session messages first; a sparse `uiHistory` cache can no longer hide
that conversation. Presentation-only synthetic completion events stay
host-owned when a non-empty CLI `uiHistory` exists. Hosts negotiate
`sandboxRuntime:4` and `crashOutcomeModel:2`.
Issue 256's lost-ancestor descendant-closure work remains open.

The v0.7.93 maintenance release keeps those contracts. Complete Windows exit
no longer waits the full orderly window after a durable `failed` shutdown
outcome, can recover previous-boot shared ACL markers after a verified boot
change, and preserves managed Stop interruption when an Anthropic or OpenAI
SDK abort wrapper does not carry the `APIUserAbortError` runtime name.

The v0.7.94 maintenance release allows a compatible long-running or background
Bash process to remain alive while Runtime text tools update workspace files.
Only workspace text operations whose actual read and write are both inside the
Runtime ASRT policy receive this concurrency. Sandbox failure for a covered
workspace target fails closed; non-workspace targets, standalone consumers,
and other host-side file sinks keep the existing filesystem-effect exclusion.
Same-path text operations remain FIFO, worktree namespace changes remain
fenced, and a concurrent shell write to the same file is detected
optimistically where possible rather than promised as an atomic transaction.
Windows sandboxed git trusts authorized repo roots only (Issue 300).
Linked-worktree and submodule relationship files are read through strict byte
bounds before that trust. Sandboxed text-helper stdin failures stay on the
operation Promise. A missing
workspace directory omits that concurrent sandbox at Run start instead of
aborting the Run. Scheduled daemon shutdown reports failed cleanup instead of
a safe stop. Runtime advertises `conversationHistory:2` so hosts can reject
daemons that still expose the legacy ordinary-history projection.
Explicit Skill invocation stays available for every enabled Skill;
`disable-model-invocation` only hides the Skill from the model tool path.
Invalid `allowed-tools` entries and malformed hook JSON are diagnosed.
`PostToolUse` still runs if an embedder result observer throws.
A single Run or process-cleanup failure must not escape as a process-global
unhandled rejection. If terminal durability cannot be proved, Runtime reports
`unknown` / `run_settlement_not_persisted` and keeps the Session fenced.
Transport disconnect metadata reports only observable connection facts;
durable Run status remains the authority for crash outcome. After a host
receives `runId`, reconnect recovery must query and await that same Run and
must never replay `runs.start()` or its provider/tool effects. Safe failure
diagnostics must use one structured `failureDetail` across applicable failure
events (including settlement `run.updated`), Run result/status, and Session
diagnostics whenever a classified fact exists. The contract separates a broad
`failureKind`, diagnostic `stage`, stable KodaX `providerErrorCode`, and bounded
KodaX-owned `safeMessage` from optional HTTP status, upstream code, request ID,
and retry delay. It must distinguish authentication, rate limiting,
network/TLS/timeout, model/endpoint/resource absence, unknown provider/catalog,
upstream 4xx/5xx, protocol/stream incompatibility, local request construction,
user cancellation, provider abort, and Runtime settlement without copying raw
upstream text. Runtime never copies credentials and registered secret values,
Authorization/Cookie, URL userinfo/query, bodies, prompts, complete local paths,
raw header collections, stacks, or raw errors across this boundary. Optional
identifiers are omitted when invalid or when they contain the run credential, a
nontrivial prompt, or a registered/sensitive-name environment secret.

The v0.7.95 maintenance release closes the remaining automatic-
recovery and explicit-Skill gaps without introducing a new feature slot. Stale
zero-byte, malformed, or truncated learning locks are reclaimed only after the
stale boundary and an unchanged bytes/stat check. Same-boot Windows
`unconfirmed-owner` recovery retries until an exact sandbox-user SID probe
proves the account idle; uncertainty remains fail-closed for sandbox work but
does not require manual marker deletion. Explicit Skill execution stores the
exact user query as canonical history, rejects multiple active references, and
denies tools when `PreToolUse` fails or returns malformed JSON. A terminal Run
whose status cannot be persisted publishes `unknown`, or invalidates live
Session observers if the event journal is fenced too. The coding runtime
finalizes its authoritative result before emitting the public completion
signal so A2A cannot publish an empty successful answer, and Windows sandbox
cleanup keeps ACL-mutating owners recoverable through background retries
instead of manual marker deletion.

The v0.7.96-alpha.1 pre-release ships FEATURE_295 and FEATURE_296. Trusted text
transactions and platform shell containment are separate authorities on every
desktop platform: controlled text tools commit in the trusted KodaX Runtime
with final identity policy, a cross-Runtime per-file kernel lock, revision
CAS, and flushed atomic replacement, while Windows shell commands keep ASRT
for network/account services and run through the native restricted-token
runner (native shell protocol version 7, `sandboxRuntime:6` with a one-time
`kodax sandbox setup` cutover). Local tool-result capacity overflow no longer
aborts a Run: over-budget batches record `capacityDebt` and commit through a
bounded recovery ladder, irreducibly oversized fresh input degrades to a paged
volatile pointer, and local capacity terminals classify as
`failureKind: "context_capacity"` with structured `contextTokens`. Classified
Runtime failures expose one credential-safe `failureDetail` across failure
events, Run result/status, and Session diagnostics.

The v0.7.96-alpha.3 pre-release adds the v2 scoped Provider credential
broker (ADR-068) and bounded shared-daemon client inventory: Provider
secrets stay in the OS keychain and resolve lazily per wire call for one
closed purpose inside revocable leases, manual compaction runs keychain-only,
shared-daemon native, constructed, and workflow Agent turns require explicit
scoped bindings and fail closed without one, External Agents remain on their
independent `credentialRef` plane, and Agent authority wire records are
closed against unknown fields.

The v0.7.96-beta.1 release carries FEATURE_297 and completes the Windows
sandbox concurrency regression tracked as Issue 326. Ordinary shell admission
does not run setup, legacy ACL migration, synchronous provisioning, or a
command-lifetime filesystem-effect coordinator. Warm ACL policy is read-only;
effective inherited normal-token grants are accepted and only a missing exact
restricted capability is converged using `SET_ACCESS` and DACL readback,
without a cross-process target mutex. Each command retains
an independent token, pipe, Job, and terminal proof. Shared network brokers are
kept referenced while starting or leased and detached only while idle. The
setup generation 10 / protocol 10 transition reuses a healthy fixed sandbox
account across setup versions, upgrades healthy generation 8 or released
generation 9 without replaying its
completed legacy ACL cleanup, and gates every new target start with an open
handle to the protected generation marker. Setup publishes a protected
non-ready `installing` marker, the elevated parent synchronously converges NUL
compatibility and profile read capabilities, and the caller atomically publishes
the ready marker only after success. No helper overlaps command admission and
system TMP is not prewarmed or rewritten; shell Temp variables point to one
private per-command child. Every canonical root converges the same stable
capability ACE set, while the command token activates only its authorized capabilities.
Windows per-command `denyRead` fails closed as
`unsupported_policy` before target start because `WRITE_RESTRICTED` cannot
enforce restricting SIDs for reads. If an actual requested write root contains
a custom `KODAX_HOME`, the Runtime materializes only its fixed protected internal
directories before constructing the Windows deny-write policy; a
missing deny root cannot fail first launch, and this path acquires no lock or
ACL transaction.

## 2. Target Users

- Developers who want a terminal-native agent for code changes, debugging,
  research, and documentation.
- SDK embedders who want KodaX's agent loop, tools, providers, sessions, skills,
  MCP, or session APIs inside their own app.
- Teams that need first-class support for Anthropic, OpenAI, China-native
  providers, OpenAI/Anthropic-compatible gateways, Gemini CLI, and Codex CLI.
- Power users who need auditable local files, branchable sessions, permission
  control, and scriptable workflows.

## 3. Product Principles

- Minimal surface first. Add product modes only when they carry real use.
- LLM-friendly structure. Types, docs, prompts, and runtime contracts should be
  easy for an LLM and a human to inspect.
- Local control. File edits, shell commands, sessions, config, and credentials
  stay under the user's local environment and explicit permissions.
- Evidence over theater. User-facing progress should reflect real work,
  completed tools, child task state, verifier decisions, and session records.
- Current docs stay current. Historical architecture belongs in feature docs,
  ADR history, changelog, and git history, not in the active PRD/HLD/DD body.

## 4. Current Product Surfaces

| Surface | Entry | Requirement |
|---|---|---|
| REPL | `kodax` | Streaming terminal UI, sessions, slash commands, permissions, skills, MCP, child task visibility. |
| One-shot CLI | `kodax "task"` | Non-interactive task execution with the same coding runtime and provider configuration. |
| SDK root | `@kodax-ai/kodax` | `runKodaX`, `KodaXClient`, events, session storage helpers. |
| Runtime SDK | `@kodax-ai/kodax/runtime` | Stable sessions/runs/events/permissions/workflows/config/catalog/MCP/artifact/diagnostic facade in inline, Worker, or daemon form. |
| Daemon operations | `kodax daemon start/status/logs/stop/restart` | One local owner per `homeDir + profile`, shared by REPL, Space, IDE, and SDK clients; stop success requires Runtime, process resources, managed children, and the serve-host PID to be gone, plus a matching Runtime/PID shutdown-success fence. After an accepted stop, an independent client watchdog reports blocked cleanup and any replacement owner rather than treating the profile as idle. Windows can reclaim the exact creation-time-bound process tree; POSIX must fail closed until a retained kernel process handle or supervisor closes Issue 269. |
| SDK subpaths | `/agent`, `/llm`, `/coding`, `/media`, `/repl`, `/skills`, `/mcp`, `/session`, `/runtime`, `/sandbox`, `/a2a`, `/experimental-memory` | Twelve focused import surfaces for embedders; governed memory remains explicitly experimental. |
| Binary release | `bun --compile` output | Runs without Node.js on the target machine. |

## 5. Current Execution Model

KodaX uses a V2 Worker single-loop model with an out-of-band Sidecar Verifier.
The Worker owns normal reasoning, tool use, file edits, and final response
drafting. When the Worker appears to finish by text, the Sidecar Verifier can
accept, request revision, or mark the run blocked without becoming a visible
in-chain role.

The retired V1 chain model is not a product requirement:

- no retired pre-v0.7.43 chain entry,
- no retired multi-role execution chain,
- no retired harness product surface,
- no `emit_handoff` terminal tool,
- no `KODAX_HARNESS_V2` opt-out behavior.

Child work is handled by one Runtime-owned Actor/Turn tree and the canonical
collaboration tools: `spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `interrupt_agent`, `list_agents`, and `agent_output`. The main
Worker remains responsible for final user-facing synthesis.

AMA uses one shared six-pattern problem-solving catalog:
`classify-and-act`, `fan-out-and-synthesize`, `generate-and-filter`,
`tournament`, `adversarial-verification`, and `loop-until-done`. The Worker
chooses and composes only the stages justified by the task through existing
Actor operations. Strategy metadata and Runtime-derived `PatternTrace` are
bounded execution facts, not proof of quality. They must not activate Workflow,
force a child or model call, create a fixed topology, or replace the existing
Sidecar as the sole terminal-answer quality adjudicator.

Queued user input belongs to the session-root Actor queue rather than a
process-global "main thread" bucket. A waiting Actor can therefore yield at a
safe boundary for its own follow-up without consuming or displaying prompts
from another session.

The model-facing `wait_agent` contract is mailbox-driven. It accepts only a
bounded timeout and returns a small wake acknowledgement; the next safe model
boundary receives the actual scoped Agent message or completion envelope.
Ordinary Actor progress is telemetry for UI and SDK event consumers and must
not wake or resample the parent model. Long waits therefore consume elapsed
time, not model tokens. Raw Actor event replay and long-poll remain available
through the SDK and daemon control-plane APIs.

Runtime hosts may submit real user input to the current active root Run only
through the advertised `interruptInput:1` contract. Input accepted before a
safe Runner boundary must remain FIFO, retain separate user-message authorship,
and enter one next model request without creating a continuation Run. A
terminal candidate atomically closes admission before draining the accepted
batch; admission reopens only if that drain or another lifecycle hook guarantees
a next model turn. An accepted batch at the configured iteration limit grants
exactly the continuation turn needed to consume it. Idle-yield waiting is an
active consumption state and therefore admits input; failure, cancellation, and
terminal cleanup close admission before asynchronous teardown. Closed or
terminal Runs reject or terminalize undelivered input rather than leak it into
later work. A fixed internal continuation allowance keeps one active Run under
an absolute iteration bound without expanding an admitted manifest's
`maxIterations` cap; once exhausted, admission stays closed and `after_turn`
remains the explicit continuation mechanism.

## 6. Required Capabilities

### Runtime Host API

SDK and product hosts must use one `KodaXRuntime` service contract without
forking a second coding engine. The supported ownership forms are:

- inline embedded for lowest overhead and process-local integrations;
- Worker-hosted embedded for private state and deterministic V8 termination;
- local daemon for durable multi-client sharing across REPL, Space, IDE, and
  SDK processes.

Runs must serialize within one session and may execute concurrently across
sessions. Pending permissions and runtime events belong to the Runtime owner,
not to one UI. Daemon ownership is unique per `homeDir + profile`; concurrent
starters must converge on the verified owner rather than start competing
servers. Process-local callbacks and service objects must fail closed at
Worker/daemon DTO boundaries. `close()` must terminate private inline/Worker
ownership but only detach a daemon client.

On Windows GUI hosts, Runtime-owned non-interactive/background child processes
must not create visible console windows. This covers memory/Git metadata,
provider CLI and ACP, LSP, clipboard, worktree, review, extension-command,
checkpoint, and sandbox paths reachable from the published Runtime Worker.
Explicit editor, terminal, and PTY interactions remain interactive and are not
hidden by this requirement.

Runtime hosts must be able to opt into a JSON-serializable Shell Execution
Contract per Session or Run. The contract selects one explicit interpreter,
fixed non-command arguments, profile mode, environment inheritance/setup, and
bounded cache policy. Environment resolution must occur in the effective
execution cwd so directory-scoped toolchains can take effect. The host
environment must be inherited by profile code and command targets; fixed
KodaX/Electron execution-control variables must be removed. A configured interpreter failure is visible
and fail-closed; an absent contract preserves established behavior.

ASRT is the first execution authority for Edits and Auto[LLM]. Non-interactive
Runtime/daemon startup must not depend on setup readiness or silently run
installers/elevation. The bare interactive Windows CLI owns one cold startup
check before it creates the REPL Runtime: a current generation is silent, while
a missing or stale generation enters the existing setup-only UAC boundary and
must pass one real no-side-effect target-start/exit probe before reporting
ready. Concurrent interactive starters converge on one setup and followers
recheck its result. Ordinary tool calls never enter setup or wait on its lock.
Sandbox completion is silently authoritative. A proven
pre-start refusal or unavailable backend reaches a separate host-boundary
decision; target-started or uncertain calls are never replayed. `/sandbox` is the explicit diagnostic
surface. SDK hosts may use `@kodax-ai/kodax/sandbox` for their own commands
with typed filesystem/network/environment/timeout/output policy; that
standalone executor returns structured `unavailable` and never chooses an
ordinary unsandboxed fallback for the host. KodaX's own workspace-shell
containment must allow broad host reads, including Agent Home, credential
locations, and global Git configuration, while limiting writes to the workspace
and platform Temp roots; Windows targets receive a private per-command Temp child.
A standalone SDK host remains responsible for its
own filesystem threat boundary.
On Windows, a loaded embedded native manifest must retain its exact immutable
content-hash generation across later package or npm-link rebuilds. Resolution
must reuse the verified protected cache before mutable source and publish only a
missing exact generation, without serializing independent shell commands.

Sidecar completion must distinguish an optional offer made after the current
request is satisfied from clarification required to satisfy the request.
Runtime hosts must receive budget-approval state only for an eligible revision,
and must retain structured blocked codes and reasons through embedded, daemon,
persistence, and restart boundaries.

For a session with `permissionMode: 'auto'`, the Runtime owns the Auto reviewer
at the exact host boundary. A shell call that completes in the sandbox never
invokes it. Auto[LLM] defaults to automatic allow/deny review, not
command-by-command root authorization. Concrete credential/trust-control
mutation, direct destruction, formatting, or essential-resource exhaustion may
justify denial until narrow, informed user direction exists in trusted
conversation context. Critical effects and administrator forbids remain denied.
Project edits/deletes/moves, Git mutations including stash, and normal global
dependency install/uninstall/reinstall are not denial reasons merely because
they write. Command category, complexity, incomplete analysis, general
uncertainty, or lack of an explicit per-command instruction is insufficient. A
trusted `autoReview.policy` may add stricter review criteria without changing
the fixed role or allow/deny output contract. Static analysis may make sandbox
admission cheap, but after a real host boundary it supplies facts only and
cannot replace the final LLM decision. A reviewer denial cancels that attempt
and tells the agent to seek a safer alternative; it opens no automatic
permission prompt, persists no path/prefix/task denial, and a later informed
natural-language instruction receives a fresh reviewer decision.

Host execution is governed by a separate JSONC Exec Policy loaded from the
user file, an explicitly trusted project file, and host-supplied administrator
rules. Exact token-prefix rules return `allow`, `prompt`, or `forbidden`; the
strictest match wins and administrator forbids are absolute. `prompt` is used
only when an explicit rule or the Edits product boundary requests it—ordinary
uncertainty does not become a prompt. Full Access samples the profile once at
Bash entry and bypasses sandbox, Auto review, and approval prompts. Explicit
forbidden rules and the Codex dangerous-command policy can still block; prompt
rules are rejected and ordinary unmatched development commands execute directly.

The Auto LLM request must contain only bounded permission-relevant evidence,
not the Runner's raw accumulated session. The current tool action remains
separate from a transcript that removes assistant prose/thinking, images, and
unbounded historical tool output. Missing classifier identity is a recoverable
configuration error only when a host-boundary review is needed. Timeout,
provider, or response-contract failure is retried once (90 seconds, then 180
seconds); a second failure blocks with safer-route feedback and
never widens to a user prompt or another engine. Incompleteness itself is not
a denial reason.

Interactive permission-mode changes must be deterministic: Shift-Tab cycles
Plan -> Edits -> Auto[LLM] -> Full Access, and rapid changes are applied in user
order. Legacy `auto-in-project` and Auto[RULES] inputs normalize to Auto[LLM]
and are omitted by new writes. Shift+Enter remains newline input.

SDK hosts must consume this behavior through one typed Auto settings resolver.
Runtime Session settings retain only reviewer-model selection; the normal
review deadlines are fixed at 90 and 180 seconds. Shared daemons advertise a unique
capability version for the bounded-input/defaults/diagnostics contract; a
newer capability satisfies an older minimum, while an older daemon is replaced
only after a safe idle preflight. Timeout diagnostics expose bounded
provider/model/timing/retry/phase metadata without prompt or tool-input text,
and the guardrail trace span covers the actual awaited classification.

Packaged Electron hosts may auto-start the shared daemon only through a bounded
Node bootstrap that cannot relaunch the GUI or leak Electron Node mode into
daemon-owned user processes. Disabling Electron's `RunAsNode` fuse requires an
ordinary Node/CLI-started daemon and attach-only SDK mode; no silent inline
fallback is allowed.

Worker resource limits and termination are fault-isolation features, not an
untrusted-code sandbox. A caller that requires deterministic V8 disposal must
be able to request `hardDispose` and receive an error from inline or daemon
forms rather than a silent downgrade.

Windows process cleanup must never equate an incomplete observation with
verified descendant termination. Identity-checked snapshots prevent PID-reuse
mis-kills and may report `unknown`, but they are not kernel containment: an
intermediate process can exit before a later snapshot and hide an already-
running descendant. The v0.7.79 release gate therefore requires spawn-time Job
Object containment and a host-issued Worker owner lease before KodaX claims
complete descendant closure.

### Providers

KodaX must support 16 built-in provider aliases plus user-defined compatible
providers. Provider behavior must be described by capability metadata rather
than scattered prompt prose. Custom providers must support base URL, protocol,
model, API key env var, effort-first reasoning profile/preset, request timeout
normalization, and multimodal capability flags where needed. The current
provider capability snapshot is maintained in
`packages/llm/src/providers/provider-capabilities.json` and includes the
2026-08-14 model refresh for GPT-5.4, Kimi K3/K2.7 Code/HighSpeed/K2.6/K2.5,
GLM-5.3, MiniMax M3/M2.7, DeepSeek V4, and Doubao Seed 2.0 routes where
supported. Public Kimi routes use their exact 262,144-token limits and
route-specific thinking contract. The separate Kimi For Coding subscription
alias defaults to the official `k3-256k` Model ID while retaining
`kimi-for-coding` for K2.7 Code and exposing the `k3` route with a
1,048,576-token local context tier. `thinking.effort` carries K3 reasoning
intent without mixing public and subscription credentials.

OpenAI-compatible custom providers may select `max_tokens` or
`max_completion_tokens` at provider or per-model scope; model configuration
overrides the provider default. DeepSeek V4 Flash and Pro have distinct
reasoning profiles, share the 1M context tier, and remain text-only.

A bare interactive first launch and `kodax setup` must initialize and validate
the complete split configuration before Runtime or REPL creation: core,
MCP, Extensions, and A2A active files plus annotated templates. Existing files
are never overwritten; readable legacy declarations are preserved through the
shared migration path, and invalid active files fail before any write. The
provider flow stores no key value: it persists only provider/model and
validated public custom-provider metadata, names the required environment
variable, asks the user to restart the terminal, and exits. Scripted, resumed,
JSON, SDK, daemon, unrelated subcommand, and non-TTY paths remain
non-interactive.

### Tools

The coding runtime must expose a rich but explicit tool surface: file read/write
and edit tools, shell, search, repo intelligence, web fetch/search, LSP
navigation, MCP calls, git worktree helpers, child task control, goals, todos,
construction, and self-modification tools. Tool permissions and side effects
must be visible to the runtime.

`gitRoot` is a repository safety boundary, while relative file operands resolve
from the effective `executionCwd`. Permission summaries must remain bounded,
redacted, valid JSON and carry that effective directory; they are not raw tool
input logs. A plan-exit tool is exposed only when the active REPL or host has
provided an approval callback.

### Media Inputs

SDK and REPL hosts must be able to construct image/file/video input artifact
metadata without importing REPL internals. The canonical media implementation
lives in the agent layer and is exposed through `@kodax-ai/kodax/media`; coding
uses the same validation and queue helpers before provider send.

### Sessions

Users must be able to resume, list, fork, rewind, tag, archive, and inspect
sessions. Session records are local JSONL data, public session APIs must remain
stable for SDK consumers, and host-facing reads must distinguish active model
context from append-order transcript history. Resumed interactive sessions
should preserve durable terminal tool-card replay where sanitized `uiHistory`
is available, while canonical `messages` / `lineage` remain the source of
truth.

Failed interactive turns may persist `presentationOnly: true` text items as a
display-authoritative exception. They participate in resumability and restore
exactly once in terminal order (Assistant summary, Sidecar verifier, terminal
error) without entering canonical model context.

Hosts that render ordinary chat require a third, SDK-owned view distinct from
both active model context and raw audit scrollback. That projection folds only
copies proven equivalent by persisted provenance or unambiguous lineage,
retains unresolved candidates, reports `resolved` / `partial` / `ambiguous`,
and supplies revision-fenced physical boundaries for fork or rewind. Hosts must
not reconstruct it from role, content, timestamp, `turnId`, or `logicalId`
grouping alone. A persisted boundary with no conversation records is a resolved
empty projection even when a Run has already been accepted; `partial` is
reserved for existing records whose identity or lineage cannot be fully
recovered.

Continue-most-recent must select the newest non-empty Session in the requested
project rather than a newer zero-message ACP/bootstrap placeholder. The rule is
shared by Ink, classic, one-shot CLI, and coding-runtime auto-resume; an explicit
Session ID always wins. Interactive resume restores saved workspace/runtime
identity before resolving relative shell operations or starting the next turn.

Large context compaction is always enabled and is shared by the CLI, REPL,
Runtime SDK, and embedded products such as KodaX Space. Its percentage trigger
defaults to 75 and is clamped to 15..90. A missing or zero absolute-token
trigger is inactive; otherwise the effective trigger is the smallest of the
percentage threshold, absolute threshold, and physical request capacity. Each
large compaction protects the newest 20% of that effective trigger, preserves
user queries through an exactly-once ledger, and summarizes the complete
eligible prefix in one cache-stable wave. A compaction is reported as
successful only after the replacement transcript is committed, strictly
smaller, and physically sendable. Manual `/compact` and the Runtime imperative
API force the same large-compaction path; microcompaction and tool-result
shaping remain separate mechanisms.

Before the active context discards any exact pre-compaction message, the root
Session host must durably preserve it in the canonical JSONL/main-plus-sidecar
transcript. This includes messages produced during the active Run. Persistence
failure may retain more live memory but must not leave a summary or
`[compacted]` placeholder as the only copy. Child-context compaction must not
mutate root Session history.

Provider prompt-cache affinity must follow the stable logical Runtime context,
not a physical child transcript Session or one transport attempt. Root
affinity remains stable across Runs and resume; each canonical child Agent path
is isolated. Retry, fallback, continuation, and summary requests reuse that
identity. The wire value must be opaque, disabled with prompt caching, and
lowered only for endpoints known or explicitly configured to accept the
protocol field. Cache usage continues to come only from Provider responses;
stable affinity does not guarantee a hit across TTL, routing, or cache shards.
CLI bridge terminal usage must preserve official cache-read/write fields
without estimation or adding them to upstream input totals. An explicit
Provider-reported zero remains present; an unreported or invalid field remains
absent through inline Runtime, daemon transport, persistence, and reconnect.
CLI bridges must not treat a generated ACP conversation ID as a native CLI
resume ID. A fresh turn starts without resume; subsequent resume uses only a
native ID reported by that CLI. Calls without an explicit conversation ID
cannot reuse global transport state, and non-zero CLI exits cannot be reported
as an empty successful turn. Failed handshakes and explicit disconnects must
recreate in-memory transport streams, and a terminal success event cannot be
returned before the backing executor's final exit status is known.

When a later query depends on a detail omitted from the active checkpoint, an
Agent backed by durable Session storage must be able to search its own
compacted history and read a cited exact entry in bounded revision-bound
chunks. Root Agents bind the root Session; persistent child Agents bind a
separately minted hidden worker Session and must never gain root-history
access. SDK and daemon hosts require the same search identity alongside
existing transcript pagination. Historical results are evidence, not current
instructions. This feature must not introduce a vector database, background
extraction loop, or a second long-term memory owner.

Bare `kodax -r` must show the searchable picker without loading the full CLI
until a selection is made. Esc restores terminal ownership immediately; a
selection transfers input ownership to the resumed REPL. Replayed history keeps
the timestamp of each persisted event rather than assigning the current render
time to all entries.

### Skills, MCP, And A2A

Markdown skills and MCP capability integration are first-class KodaX
capabilities. They are source-code subtrees under `packages/agent`, not separate
workspace packages. Public SDK access is through `@kodax-ai/kodax/skills` and
`@kodax-ai/kodax/mcp`.

Skill invocation has two independent product paths. Model-visible Skills expose
only their name and description for natural-language discovery and remain
subject to model-tool admission. Every enabled Skill is also explicitly
invocable by the user or SDK, including `/<name>` and `/skill:<name>` tokens at
the query head or in the middle with trailing arguments. Consequently,
`disable-model-invocation` disables model discovery and model tool invocation
only; it must never disable an explicit user or `SkillRegistry.invoke()` call.
An explicit Skill crosses Workflow and child-Agent boundaries only through the
host-owned structured `skillInvocation` provenance record, and its complete
expanded content appears exactly once in the provider request. Slash text
authored only by a model inside a child objective is not user authority.

Background Skill learning is Memory-first and remains outside foreground Run
latency. A single correction, failure, or verifier result is evidence rather
than mutation authority. Only repeated independently verified evidence, or an
explicit preserve-as-Skill request with verified terminal evidence, may create
a low-risk immutable project-scoped testing revision. Discovery requires the
canonical lifecycle/fingerprint record. Testing is bounded to one concurrent
root binding and three exact-revision uses; project activation requires every
bounded outcome to settle and at least one independently verified success.
Protected/formal Skills, global promotion, and Extension authoring remain
explicit user actions. Runtime hosts consume inventory,
events, and controls through `runtime.learning`, not by inferring state from
files.

Bidirectional A2A 1.0 is a root integration edge exposed through
`@kodax-ai/kodax/a2a`. Outbound Agents must fail closed against advertised
Card/Skill security, keep Card/RPC/token origins separate, and support fixed
Bearer plus OAuth 2.0 Client Credentials from an external Authorization
Server. Inbound publication must authenticate before reading task bodies and
supports fixed Bearer plus externally issued RFC 9068 JWT validation; KodaX is
a Resource Server and does not issue production tokens.

User A2A configuration is version 2. Legacy non-empty version 1 files require
an explicit migration while every owning daemon is stopped. Per-Agent
`enabled` state blocks new admission after owner reconciliation without
cancelling in-flight work. Private-address and non-loopback plaintext-HTTP
permissions are independent, persisted, and default-deny; exact loopback HTTP
needs neither, while private HTTP needs both. CLI discovery/call, Worker and
daemon reconciliation, registration fingerprints, and execution must preserve
the same authority. Durable task routes, authentication realms,
registration ownership/revisions, metadata limits, and SSE resource ceilings
must remain fail-closed across reload, daemon restart, and shutdown.
Retained pre-realm task owners require an explicit stopped-server identity
mapping; normal A2A requests must neither guess nor dual-read legacy ownership.
Cross-principal capacity reservation must not hold a global lock across
workspace, session, or Runtime preparation. External-Agent owner-plane close
must use one bounded deadline (30 seconds by default), and daemon auto-start
must terminate abandoned startup children instead of leaving them detached.

### Governed Memory

FEATURE_260 (`v0.7.68`) adds a thin experimental Memory Agent over the existing
F228 Memory Control Plane. `@kodax-ai/kodax/experimental-memory` exposes scoped
`MemorySession` lifecycle, zero-wait passive recall, deliberate read-only
`query()`, bounded observations, and episode outcomes. The coding runtime may
offer the same deliberate path through `memory_recall`, but the Action LLM
retains final decision authority and recalled text remains low-authority.

FEATURE_275 (`v0.7.77`) replaces timing-ineffective semantic prefetch with a
sparse foreground `MemorySession.intervene()` path after tool failure,
verification failure, or durably committed compaction. Each trigger rebuilds a
closed prompt-safe candidate set from current objective/todos, recent governed
observations, and a fresh F228 pack. Deterministic exact selection adds no
model call; an in-process host may opt into a bounded `memoryRecallRunner` that
can return only offered IDs. At most three candidates enter the next
Action-LLM request, while stale, malformed, unknown, timed-out, cancelled, or
failed selector results remain silent.

An exact current-user `memory_intent` is authoritative evidence for an immediate
governed operation. Safe, explicit remember, correction, and forget requests
must apply directly through the existing preview, fingerprint, applicability,
and apply boundaries. Every new claim has a stable semantic key. Completed
explicit operations are copied into the outcome only as host-owned de-duplication
metadata, so ordinary autonomous episode and Skill review still runs without
capturing the same claim twice. Ambiguous or broad requests require clarification;
conflicts become durable, readable decisions with revision-bound cross-turn handles;
secrets are rejected rather than persisted; inferred changes remain
governed. Autonomous episode review continues in the background and auto-applies
only deterministic low-risk verified changes.

Durable changes must continue through proposal, preview, fingerprint, and apply,
whether the host authorizes an explicit request immediately or exposes an
exceptional decision.
Identity and applicability checks, secret filtering, poisoning defenses, and
managed-path mutation guards are deterministic code boundaries. KodaX must not
add a second memory database, filesystem memory action space, resident Memory
Specialist, hidden-reasoning storage, or runtime self-modification through this
surface.

Memory is conversation-first: asking what KodaX remembers, asking it to remember
or correct something, and asking it to forget something must work without slash
commands. `/memory` is an advanced inspection and recovery surface. `MEMORY.md`
is a derived readable projection rather than the source of truth; `open` uses an
external editor or file manager, and hidden `rebuild` only repairs that projection.

### Dynamic Workflow Harness

FEATURE_217 is the v0.7.49 home for the complete Dynamic Workflow product loop.
The shipped surface includes Agent-layer `createWorkflowRuntime`,
`runWorkflow`, `normalizeWorkflowLimits`, workflow capsule helpers, coding
backend integration, one built-in read-only workflow, durable run graph,
saved-workflow discovery, capability-routed generated scripts, `/workflow
create`, background lifecycle management, pause/resume/stop/save/rerun, hard
budget checks, opt-in worktree routing, and richer workflow pattern templates.
Generated workflows can be promoted into lightweight capsules that preserve the
script plus manifest, intent, input examples, requirements, and provenance so
they remain reusable across sessions and understandable to SDK consumers.

FEATURE_246 (v0.7.58) is the Claude-Code-parity evolution of this surface: the
Worker can now author and run a workflow inline via a model-callable
`run_workflow` tool (scout-then-author, ADR-047) instead of only generating
scripts through `/workflow create`. It adds structured child output
(`outputSchema`), the no-barrier `wf.pipeline` staged primitive, same-session
resume (`resumeFromRunId`), and nested `wf.workflow(...)`, and demotes the
context-blind `sideQuery` generator to a fallback for the explicit `/workflow
create` command and non-interactive / CI hosts. The neutral
run-lifecycle manager moves to `@kodax-ai/agent` (ADR-046) and the inline run is
async / idle-yield (ADR-049).

### Workflow Process Surface

FEATURE_229 (`v0.7.50`) standardizes workflow execution as an Agent-layer
process contract. SDK hosts must be able to subscribe to
`WorkflowProcessEvent`, poll `WorkflowProcessSnapshot`, and use lifecycle
controls for stop, pause, resume, final result reads, artifact reads, terminal
run delete/prune, identity changes, saved-capsule revision/replace provenance,
and preflight checks. REPL and future UI hosts render the same snapshots; they
must not become the source of truth by parsing terminal text, slash-command
output, or Ink view models. Coding-layer workflow APIs own coding run graphs,
host policy, source/provenance fields, and result summaries while preserving the
Agent-layer package boundary.

FEATURE_234 (`v0.7.51`) adds workflow run host attribution through
`hostMetadata`. SDK hosts can stamp a small string-only ownership map on process
metadata, have it persisted in `run.json`, and read it back through snapshots
after restart without KodaX interpreting host-specific meaning.

### Safety And Control

KodaX must keep permission modes, auto-mode guardrails, bash classification,
content-hash safety checks, session snapshots, verifier fail-open behavior, and
explicit user confirmation for trusted-local workflow scripts.

## 7. Non-Goals

- Reintroducing the V1 multi-role chain as a product mode.
- Building a heavy IDE shell inside the REPL.
- Creating a second engine for non-terminal surfaces.
- Adding broad configuration for hypothetical future use.
- Replacing git, package managers, test runners, or the user's own review
  process.
- Treating generated workflow scripts as trusted local code; generated
  workflows must stay on the capability runner path.
- Treating Worker threads as a security sandbox for malicious code.
- Exposing arbitrary process-local execution objects through the daemon
  protocol instead of typed Runtime services and DTOs.

## 8. Success Criteria

- Current docs describe the code that exists today.
- A new SDK consumer can choose the correct import path without reading source.
- A Runtime SDK consumer can choose inline, Worker, or daemon ownership and
  predict close, crash, restart, serialization, and permission behavior from
  the public guide.
- A CLI/REPL user can understand providers, sessions, permissions, skills, MCP,
  and child tasks without learning retired V1 terminology.
- A CLI, SDK, or embedded-product user can predict the effective compaction
  trigger, protected tail, preserved-query behavior, and success telemetry
  without reverse-engineering a host UI.
- A resumed Session can recover exact old user/assistant/tool details after
  compaction; root and persistent child Agents can search/read only their own
  lineage without loading the whole transcript into active context.
- An experimental-memory consumer can predict scope, read/write authority,
  recall behavior, and promotion boundaries without reading implementation code.
- Product changes preserve workspace package independence:
  `llm -> agent -> coding -> repl`, with no reverse dependency from agent to
  coding.
- Prompt or behavior changes that affect the agent loop follow
  `benchmark/EVAL_GUIDELINES.md`.

## 9. Current Roadmap Links

- Active feature index: [FEATURE_LIST.md](FEATURE_LIST.md)
- Architecture decisions: [ADR.md](ADR.md)
- Current high-level design: [HLD.md](HLD.md)
- Current detailed design: [DD.md](DD.md)
- Feature design index: [features/README.md](features/README.md)
