# KodaX Documentation

Public documentation for KodaX users and SDK integrators.

The current source candidate is `v0.7.96-alpha.6`. The existing Git tag and
GitHub pre-release point to the earlier `a71d2b98` candidate and predate the
refreshed startup/diagnostic corrections; tag/Release refresh and npm
publication remain separate manual maintainer actions. Alpha.6 carries
the alpha.4 permission profiles, sandbox-first routing, JSONC Exec Policy,
Auto[LLM] host-boundary review, and Full Access, and completes Windows sandbox
concurrency/self-healing without adding a command lock, queue, or permission restriction.
The alpha.3 line adds the v2 scoped Provider credential
broker (ADR-068): Provider secrets stay in the OS keychain and resolve per
wire call for one closed purpose inside revocable leases, shared-daemon
internal Agent turns require explicit scoped bindings and fail closed
without one, and daemons may expose bounded, display-only client inventory
(`daemonClientInventory:1`). It separates trusted text transactions from platform shell
containment on Windows, Linux, and macOS: controlled text tools commit in the
trusted KodaX Runtime with per-file kernel locking, revision CAS, and flushed
atomic replacement, while Windows shell commands run through the native
   restricted-token runner (alpha.6 native shell protocol version 10/setup
   generation 10, Windows `sandboxRuntime:11`, interactive startup recovery
   through the setup-only boundary, and no command-lifetime global admission
lock). It replaces the
local tool-result capacity hard gate with capacity-debt admission and a
bounded recovery ladder (`capacityDebt` metadata, floor-bounded output
reserve, `failureKind: "context_capacity"` with structured `contextTokens`),
exposes one credential-safe `failureDetail` across failure events, Run
result/status, and Session diagnostics, and registers the
`deepseek-v4-flash-vision-exp` and `glm-5.3-flash` models plus the custom
provider `imageInput` flag. On top of v0.7.95: self-healing
Windows sandbox cleanup (Windows `sandboxRuntime:5`,
`runtimeExitSettlement:2`),
Issue 301 learning-lock / fullscreen-terminal / Explicit-Skill recovery, and
Issue 302 coding-result finalization before the public completion signal, on
top of the v0.7.94 concurrent
sandboxed text mutations, Issue 300 authorized-root git trust, scheduled
shutdown failure reporting, missing-workspace Run start, and
`conversationHistory:2`, the
v0.7.93 failed-exit fast settlement, previous-boot ACL recovery, and isolated
provider abort classification, plus the v0.7.92 filesystem-effect
operation-token coordinator, recorded-release owners, managed Session-before-
completion ordering, canonical-first resume reconstruction, `sandboxRuntime:4`,
and `crashOutcomeModel:2`. Issue 256's
lost-ancestor descendant-closure boundary remains open. The same guidance still
covers the v0.7.89 Issue 293
topology-transparent conversation projection, FEATURE_293 zero-service web
search fallback, and FEATURE_294 run-scoped Host Tools. The host-tool surface is
leased to one Run, registry-first, revocation-safe, and absent from unrelated
CLI runs. Its custom web-search endpoint remains isolated. The v0.7.88 SDK
guidance adds the GLM-5.3 Coding Plan
routes with verbatim model IDs, keeps GLM-5.2 selectable, defaults
`zhipu-coding`, `zai-coding`, and `ark-coding` to 5.3, and documents the GLM-5.3
always-thinking effort mapping. It also covers atomic Runtime owner
recovery, process-start identity locks, Windows sandbox termination attestation,
durable ACL owner markers, and Windows workspace Shell PATH/executable scoping
with quoted `cmd.exe` argument preservation. POSIX workspace sessions initialize
fresh-home policy roots, settle workspace-local warm-up within the Shell
abort/deadline, retire invalid sessions after lease-cleanup failure, and fail closed when process-tree cleanup is unconfirmed,
in addition to the v0.7.85 Session-scoped
Runtime Event Journals, the `sessionEventJournal:1` daemon contract,
conversation-first Memory management, the additive experimental Memory
management facade, and the startup/Worker lifecycle boundaries. Issue 256's
remaining Worker owner-lease boundary remains open after v0.7.89; this release
assigns no replacement target.

The current source additionally documents structured, credential-safe Runtime
`failureDetail`. Stable KodaX classification stays separate from optional
bounded upstream identifiers, and failure/settlement events, Run result/status,
and Session diagnostics project the same fact when it exists. This additive
contract ships in `v0.7.96-alpha.3`; consumers of older published packages must
tolerate an absent field.

The v0.7.90 SDK guidance also documents orderly retirement for timed-out
workspace sessions, actionable daemon Error/aggregate/cause diagnostics, direct
clone-predecessor lineage and topology-correct archive markers, and provider-
valid object schemas for run-scoped tools. npm publication remains a manual
operator step.

The v0.7.91 SDK guidance adds the crash-resumable
`settleKodaXRuntimeExit()` transaction and `runtimeExitSettlement:1` capability,
effective live output segments (`responseId` + `providerRequestId`), and
standalone lazy provider dependency bundling. It also documents bounded
AskUser/permission deadlines, owner AbortSignal propagation,
`handleRuntimePermissionRequest()`, validated default answers, and stale
prepared-Session-tail recovery after a `data_changed` race.

The v0.7.94 SDK guidance documents concurrent sandboxed text mutations,
authorized-root git trust (`gitSafeDirectory: authorized-repo-roots`),
byte-bounded linked-worktree and submodule relationship reads, observed
text-helper stdin failures, scheduled shutdown failure reporting, omitting
the text sandbox when the workspace directory does not exist,
`conversationHistory:2`, independent explicit Skill invocation, diagnosed
invalid `allowed-tools` / malformed hook JSON, `PostToolUse` after an
embedder observer throw, fail-closed Run terminal settlement, observed
sandbox/managed-child cleanup rejection, typed daemon disconnect facts,
bounded credential-safe `failureKind`, and exact-`runId` result recovery. An
admitted Run is queried and awaited after reconnect; it is never started
again. `sandboxRuntime:4` and `crashOutcomeModel:2` are unchanged.

The v0.7.93 SDK guidance documents that a durable Windows `failed` shutdown
outcome ends the orderly exit wait, previous-boot shared ACL markers may be
recovered after a verified boot change, and Anthropic/OpenAI abort wrappers
are classified by isolated SDK class identity. Capability versions are
unchanged.

The v0.7.92 SDK guidance adds `sandboxRuntime:4` and `crashOutcomeModel:2` as
pre-start facts. Auto-start replaces an idle older daemon and fails closed
while it is busy. Managed `onComplete` is not terminal authority. Hosts must
not delete ProgramData lock files to recover a stuck coordinator. Resume
reconstruction uses canonical Session `messages` as the transcript; `uiHistory`
may overlay tool cards and display-only entries but cannot hide ordinary
conversation. Presentation-only `agent-completed` / `task-completed` events
stay host-owned when a non-empty CLI `uiHistory` exists.

## Getting Started

- [Overview](./getting-started/overview.md) — What KodaX is and how it compares
- [Installation](./getting-started/installation.md) — npm, single binary, build from source
- [Quickstart](./getting-started/quickstart.md) — Your first session

## Configuration

- [Providers & API Keys](./configuration/providers.md) — 16 built-in provider aliases
- [Custom Providers](./configuration/custom-providers.md) — OpenAI/Anthropic-compatible endpoints
- [Configuration Files](./configuration/config-files.md) — config.json, split files, env vars
- [Permission Modes](./configuration/permissions.md) — Plan / Edits / Auto[LLM] / Full Access + Exec Policy
- [Sandbox](./configuration/sandbox.md) — Optional OS-level containment (ASRT)

## SDK

- [Embedder Guide](./sdk/embedder-guide.md) — Full SDK integration guide for
  host applications, including
  [structured credential-safe Runtime failures](./sdk/embedder-guide.md#structured-credential-safe-runtime-failures),
  explicit-vs-model Skill invocation, and dynamic-context policy

## Guides

*(More standalone guides coming soon: CLI reference, REPL commands, sessions, multi-agent, skills, extensions, MCP, A2A, repo intelligence, memory, workflows, compaction, doctor, tools reference. Current Skill SDK semantics are documented in the Embedder Guide.)*

## Reference

*(Coming soon: troubleshooting, FAQ, comparison, license.)*
