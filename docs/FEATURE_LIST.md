# Feature 总表

> 这是活跃 roadmap 与近期完成项索引：保留仍需计划/实现/验证的 feature，
> 并保留 archive cutoff 之后的近期发布项。更早的已发布、取消、吸收、搁置
> 历史见 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)。
> 版本设计细节见 [docs/features/v{VERSION}.md](features/)；发布历史见 [CHANGELOG.md](../CHANGELOG.md)。

---

## 当前概况

| Item | Value |
|---|---|
| Current released version | `v0.7.96-alpha.3` (Git tag / GitHub pre-release) |
| Current package version | `@kodax-ai/kodax@0.7.96-alpha.4` source candidate (not yet tagged or published) |
| Workspace baseline | `llm / agent / coding / repl` 4 packages |
| Total tracked features | `81` |
| InProgress | `1` |
| Planned | `16` |
| Completed | `58` |
| Reviewed out of active roadmap | `6` (`108, 231, 232, 235, 238, 244`) |
| Tracked feature IDs | `007, 030, 093, 105, 108, 113, 139, 174, 211, 221, 224, 225, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 265, 266, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279, 280, 281, 282, 283, 284, 285, 286, 287, 288, 289, 290, 291, 292, 293, 294, 295, 296, 297` |
| Archive cutoff | Shipped / canceled / absorbed / shelved items through `v0.7.49` are archived. |

### 一览表

| Status | Count | Feature IDs | Next checkpoint |
|---|---:|---|---|
| Completed | 58 | `297, 295, 296, 294, 293, 292, 291, 290, 289, 286, 284, 281, 277, 276, 263, 275, 274, 273, 272, 271, 270, 266, 269, 268, 267, 260, 261, 259, 258, 253, 254, 255, 256, 257, 228, 251, 252, 250, 248, 249, 247, 246, 245, 243, 242, 241, 233, 240, 239, 224, 221, 174, 211, 237, 229, 230, 234, 236` | `297` is implemented in the v0.7.96-alpha.4 source candidate; `295` and `296` shipped in alpha.1. npm publication remains manual. |
| InProgress | 1 | `225` | `225` remains the bounded v0.8.25 cleanup. |
| Planned, 0.8.x | 10 | `278, 279, 282, 283, 285, 280, 287, 288, 265, 105` | `v0.8.10` -> `v0.8.11` -> `v0.8.13` -> `v0.8.14` -> `v0.8.15` -> `v0.8.20` -> `v0.8.25` |
| Planned, 0.9.x | 6 | `007, 030, 093, 113, 139, 262` | `v0.9.0` -> `v0.9.5` -> `v0.9.7` -> `v0.9.25` |
| Reviewed out, 2026-07-12 | 6 | `244, 231, 235, 238, 232, 108` | Shelved, deferred, absorbed, or cancelled after the post-v0.7.70 roadmap review; F105 was restored by the 2026-07-29 MoA redesign. |

> v0.7.49 / v0.7.50 workflow split：`FEATURE_217` remains the human-facing workflow mode. Manual testing reopened required UI/UX and reliability deltas inside [v0.7.49](features/v0.7.49.md#13-v0749-completion-delta): bounded live progress with phase index / running 智能体 wording / preserved progress row / elapsed time / completed-child token usage, localized assistant-style launch notes, result-bearing child-agent digests or folded long-report notices, non-`info` agentic transcript, clear separation between `finished/spawned` progress and lifetime `maxAgents` cap, final synthesis, generated final-result contract lint, implicit `tokenBudget` stripping, generated task-command crash hardening, tighter AMAW invocation policy, wait timeout propagation, no default total workflow wall-clock timeout, terminal cleanup for un-awaited children, accurate template read/write metadata, capsule min-version preflight, manual run cleanup controls, and the closed minimal saved-workflow named reuse delta (`/workflow <savedName>` plus `/workflow rerun <runId|savedName>` with help/completion). `FEATURE_229` in v0.7.50 is the platform layer: it standardizes the same process as agent-layer snapshot/events, SDK subscription/polling, Space-style host policy and lifecycle controls, terminal-state helpers, workflow identity/lifecycle controls beyond named reuse (`display name | revise | rename | revision provenance`), REPL-as-consumer rendering, conservative retention, and durable source/provenance/resultSummary persistence; it is not the first implementation of the user-visible UX.

### 各版本待做分布

| Version | Planned features |
|---|---:|
| `v0.7.54` | `0` |
| `v0.7.55` | `0` |
| `v0.7.56` | `0` |
| `v0.7.57` | `0` |
| `v0.7.59` | `0` |
| `v0.7.61` | `0` |
| `v0.7.62` | `0` |
| `v0.7.63` | `0` |
| `v0.7.64` | `0` |
| `v0.7.65` | `0` |
| `v0.7.66` | `0` |
| `v0.7.67` | `0` |
| `v0.7.68` | `0` |
| `v0.7.69` | `3` |
| `v0.7.70` | `0` |
| `v0.7.71` | `0` |
| `v0.7.72` | `2` |
| `v0.7.73` | `1` |
| `v0.7.74` | `2` |
| `v0.7.75` | `0` |
| `v0.7.76` | `0` |
| `v0.7.77` | `2` |
| `v0.7.78` | `3` |
| `v0.7.79` | `3` |
| `v0.7.80` | `0` |
| `v0.7.81` | `0` |
| `v0.7.82` | `0` |
| `v0.7.83` | `0` |
| `v0.7.84` | `0` |
| `v0.7.85` | `0` |
| `v0.7.86` | `0` |
| `v0.7.87` | `0` |
| `v0.7.88` | `0` |
| `v0.7.89` | `2` |
| `v0.7.90` | `0` |
| `v0.7.91` | `0` |
| `v0.7.92` | `0` |
| `v0.7.93` | `0` |
| `v0.7.94` | `0` |
| `v0.7.95` | `0` |
| `v0.7.96` | `0` |
| `v0.7.100` | `0` |
| `v0.7.105` | `0` |
| `v0.8.10` | `5` |
| `v0.8.11` | `1` |
| `v0.8.13` | `1` |
| `v0.8.14` | `1` |
| `v0.8.15` | `1` |
| `v0.8.20` | `1` |
| `v0.8.25` | `1` |
| `v0.9.0` | `1` |
| `v0.9.5` | `3` |
| `v0.9.7` | `1` |
| `v0.9.25` | `1` |

> Release cadence rule: every `v0.7.x` feature-bearing release normally leaves
> the next two patch versions for debug/patch releases. `v0.7.55` is intentionally
> left without a planned feature so it can be used for the temporary emergency
> release. `FEATURE_239` and `FEATURE_240` both moved to `v0.7.56`.
> `FEATURE_233`, `FEATURE_241`, `FEATURE_242`, and `FEATURE_243` shipped in
> `v0.7.57`; `v0.7.58` shipped 2026-07-02. `v0.7.59` (2026-07-03) shipped
> `FEATURE_248` (AMAW mode-level orchestration directive) + `FEATURE_249` (AMA
> natural-language workflow activation) as a rollup on top of the Space SDK R1-R6
> hardening and ark-coding lineup refresh.
>
> **Historical 2026-07-04 reschedule, superseded for active targets by the
> 2026-07-08 cadence update below**: at user request, every planned `v0.7.x`
> feature at `v0.7.60` and later was temporarily pushed back 3 minor versions,
> except `FEATURE_250` (stays `v0.7.60`) and `FEATURE_251` (stays `v0.7.61`).
> That temporary mapping is retained only as release-cadence history; use the
> 2026-07-08 cadence update below for every active target.
>
> **Historical 2026-07-08 runtime cadence update, superseded for future
> feature assignments by the 2026-07-12 roadmap review below**:
> `FEATURE_253`, `FEATURE_254`, and
> `FEATURE_255` reserve `v0.7.64`, `v0.7.65`, and `v0.7.66` for the KodaX
> runtime migration sprint: embedded runtime contract, host migration/control
> plane hardening, and local daemon. `v0.7.67`, `v0.7.68`, `v0.7.69`, and
> `v0.7.70` are reserved as feature-free runtime stabilization / bugfix slots.
> At that time, the previous `FEATURE_244` and `FEATURE_231` reschedule was:
> `244` +
> `231` + `235` -> `v0.7.75`, `238` -> `v0.7.80`, `232` -> `v0.7.85`,
> `105` -> `v0.7.90`, `108` -> `v0.7.95`, and `225` -> `v0.7.100`. All
> v0.8.x features remain unchanged.
>
> **2026-07-10 runtime release rollup**: the v0.7.64 and v0.7.65 development
> slots were not cut as standalone tags. FEATURE_253, FEATURE_254, and
> FEATURE_255 release together in v0.7.66 after the final context/tool exposure
> eval and release audit. The already implemented FEATURE_256 and FEATURE_257
> isolation follow-ups are also delivered early in v0.7.66; their former
> v0.7.71/v0.7.72 slots return to stabilization capacity.
>
> **2026-07-07 patch release**: `v0.7.63` is a no-planned-feature-slot
> patch/stability release for SDK session boundary hardening, deterministic
> transcript fixtures, `/reload` extension rediscovery, and feature-design index
> cleanup. After the 2026-07-08 cadence update, every slot before `v0.7.75`
> remains available as debug/patch buffer.
>
> **2026-07-09 runtime design addendum**: `FEATURE_254` now explicitly absorbs
> session-scoped runtime settings, stable rich-UI event payload families,
> config-boundary rules, runtime input/artifact parity, session-operation
> parity, daemon-prep permission/replay hardening, and the Hermes-like
> agent-performance/context-budget plane: runtime budget snapshots, tool
> exposure planning, portable `tool_search` / `tool_describe` / `tool_call`
> bridge semantics, skill/MCP metadata budgets, context-aware tool-result
> budgets, compaction anti-thrashing, small-window behavior, and report-only
> guardrails before pruning is enabled. `FEATURE_255` now explicitly absorbs
> daemon config/admin APIs, MCP/custom-provider admin APIs, command/skill
> catalogs, artifact upload/reference APIs, protocol initialization/versioning,
> protocol schemas, client identity/capabilities, session settings/history
> operations over transport, deterministic multi-client permission semantics,
> and daemon transport/diagnostics for the same context-budget/tool-exposure
> plane. No new feature ID or release slot is added.
>
> **2026-07-10 isolation follow-up (delivered early in v0.7.66)**: concrete SDK
> embedder demand added optional Worker-hosted embedded Runtime + hard disposal
> (FEATURE_256) and constructed-handler Worker fault isolation (FEATURE_257).
> Release review proved capability/configuration fail-closed behavior in all
> three Runtime forms and that constructed-handler revoke drains active/queued
> calls without Worker resurrection. Worker isolation remains explicitly not an
> untrusted-code sandbox and adds no generic arbitrary-code execution service.
>
> **2026-07-10 external-agent + build-loop efficiency exception**: two bounded
> features consume the first stabilization slot, `v0.7.67`. `FEATURE_258`
> delivers the protocol-neutral, host-injected executor plane, dispatchable
> catalog, task ledger, Worker child bridge, Workflow target, and
> Embedded/Daemon API. `FEATURE_259` applies a measured cost-discipline pass to
> the same multi-agent surface: truthful/smaller resident prompts, explicit
> tier intent, focused child/review handoffs, consolidated scope review, and
> conditional digest reuse. It adds no orchestration framework, model-price
> router, or protocol adapter. Concrete A2A, MCP Tasks, and governed HTTP
> adapters remain separate follow-ups so core KodaX does not acquire protocol
> SDK dependencies or overstate cancel/recovery semantics. At that point,
> `v0.7.68`-`v0.7.70` remained stabilization slots, and no third feature was
> planned for `v0.7.67`.
>
> **2026-07-11 Memory Agent schedule exception**: at explicit user direction,
> `FEATURE_260` consumes `v0.7.68`. It extends the released F228 Memory Control
> Plane with zero-wait proactive recall, bounded Outcome Digests, staged
> evidence-backed learning, exact cross-session applicability, cache-safe
> ephemeral reminders, and a thin experimental agent-layer `MemoryAgent` SDK.
> `v0.7.69`-`v0.7.70` remained stabilization slots until the Learning Center
> correction recorded below.
>
> **2026-07-12 post-v0.7.70 roadmap review**: the active `v0.7.x` roadmap now
> follows ADR-052. Memory carries facts/preferences/constraints, Skills carry
> reusable methods, Extensions carry repeated deterministic executable
> capability, and Workflows remain on-demand execution primitives rather than a
> learned carrier. `FEATURE_244`, `231`, `235`, `238`, `232`, `105`, and `108`
> leave the active roadmap. `FEATURE_266` establishes the shared Learning
> Center/control plane in `v0.7.70`; `FEATURE_263` closes the released F224
> Skill Loop in `v0.7.75`; deterministic Extension work remains explicitly
> user-authored; `FEATURE_265` consolidates Hermes-parity work efficiency and
> coding assurance in `v0.7.85`. `v0.7.90` and `v0.7.95` return to stabilization
> capacity. `FEATURE_225` remains the bounded final cleanup in `v0.7.100`.
>
> **2026-07-12 Learning Center correction**: `FEATURE_266` now consumes
> `v0.7.70`. It establishes the shared agent-layer Learning Center, Learned
> Capability Area, durable lifecycle/events/client cursors, human-readable
> names, Runtime SDK parity, and real Ink/classic notification placement before
> F263 authors learned Skills. It does not add a Workflow Loop, Skill reviewer,
> or Extension generator. The learning sequence is now F260 (`v0.7.68`) ->
> F266 (`v0.7.70`) -> F263 (`v0.7.75`) -> F265 (`v0.7.85`).
>
> **2026-07-13 A2A product/config closure**: `FEATURE_267` remains the same
> bidirectional A2A Feature, now explicitly including the missing no-TypeScript
> CLI/config/Runtime product surface and the ability to bind one admitted
> `~/.kodax/agents/<name>.md` through an owner-side, revision-pinned Runtime
> service. The completed design correction treats A2A as a general task-Agent
> surface—documents, presentations, databases, MCP, approved automation and
> Agent orchestration—while ACP owns coding workspace/editor/terminal
> collaboration. It binds trusted Runtime Skills (including
> `~/.agents/skills`), separates internal Skills from public Agent Card skills,
> and layers native tools, product-managed services, trusted narrow Extension
> tools, exact MCP allowlists, and exactly admitted isolated Skill scripts under a
> structured deployment `toolPolicy`. The isolation correction now makes this
> concrete rather than pluggable: `skillScripts` is a default-empty map from
> exact Skill names to exact `scripts/...` entrypoints. Skill instructions/resources
> remain usable with process denied,
> and admitted checked-in scripts use one exact-version, privacy-reviewed ASRT
> adapter with no Extension backend registry, credential injection, TLS MITM,
> ambient SRT settings, runtime download, or host-shell fallback. Managed
> context workspaces default below `~/kodax_a2a_server_workspace`; optional
> fixed resource roots remain host-selected. ASRT is local process containment,
> while hostile multi-tenant serving requires an outer container/VM. New
> `FEATURE_268` shares `v0.7.69` as its bounded substrate: one user-level file
> each for MCP, A2A, and Extensions, canonical core/MCP/A2A/Extension templates,
> migration, actual live reconciliation, last-known-good reload, and explicit
> restart-required status for inbound Agent/Skill/tool-policy/workspace binding
> changes. User `a2a.json` intentionally contains independent outbound `agents`
> and inbound `server` sections; no project integration scope is added.
> It adds neither one-file-per-link storage nor a generic plugin/config
> framework;
> `FEATURE_266` remains planned for `v0.7.70`.
>
> **2026-07-13 F267/F268 joint implementation checkpoint**: the bounded code
> path is complete and jointly verified with 158 focused tests at 80.55% line
> coverage, 9689/9689 full-suite assertions in 810 files, full TypeScript/
> bundle/DTS/template checks, npm dry-run contents, and four real daemon CLI
> smoke tests. The current Windows host correctly reports ASRT setup-required
> until its explicit one-time sandbox account provisioning is performed; there
> is no host-shell fallback. At this checkpoint both Features remained
> InProgress for independent A2A/TCK and cross-platform release evidence; the
> later v0.7.69 release closed the bounded implementation status without
> claiming official-TCK certification. Their original product paths are implemented; the F269
> insertion additionally requires the cross-Feature operation/revision
> integration recorded in the v0.7.69 design before they can ship together.
>
> **2026-07-16 F267/F268 standards-authentication and activation closure**:
> the v0.7.69 feature design now records this post-release amendment, implemented
> in the v0.7.71 patch; older v0.7.69 binaries did not contain these
> later OAuth profiles. KodaX outbound can obtain short-lived
> access tokens from an external Authorization Server with OAuth 2.0 Client
> Credentials; KodaX inbound can validate RFC 9068 JWT access tokens as a
> Resource Server. KodaX does not sign or issue production tokens. The same
> user-level `a2a.json` keeps every third-party declaration and adds one hot
> `agents.<name>.enabled` desired-state switch, managed by `a2a enable|disable`.
> Running owners apply disables/removals before network preparation, reconcile
> only source-owned changed/drifted entries, fence authority changes before
> parallel discovery, retry failed same-revision activation, preserve durable
> registration writes, and never cancel already admitted tasks. Card-level and
> Skill-level security requirements, token/interface origin separation,
> complete executor revisions, exact issuer/scope validation, compare-and-clear
> token refresh, and reflected-token redaction across successful/error/SSE paths are part of the
> closure; groups, schedules, priorities, and a second runtime-only switch are
> deliberately not added.
>
> **2026-07-13 shared-daemon priority insertion**: `FEATURE_269` joins
> `v0.7.69` as a third Critical Feature without automatically moving
> `FEATURE_267` or `FEATURE_268`. It closes the released F255 gaps required
> by Space v0.1.32's default Coder migration: atomic session observation and
> resync, durable operation ordering/idempotency, transport-safe AskUser and
> permission concurrency, run/provider-scoped Space credential brokerage,
> immutable run-bound Host Tools, explicit unknown/interrupted recovery, and a
> shared daemon/inline Coder owner fence with sticky rollback. Partner remains
> private embedded and Space Artifact remains Space-owned. The three
> v0.7.69 Features keep separate release gates so product can explicitly
> reschedule F267/F268 later without weakening F269.
>
> **2026-07-14 adaptive collaboration insertion**: `FEATURE_270` joins
> `v0.7.70` beside F266. It replaces KodaX's overlapping one-shot child,
> Workflow-local, and external-task collaboration authorities with one
> Runtime-owned actor tree and scheduler. AMA gains feedback-driven Agent
> delegation and recursion under the Codex V2 default of four total session
> slots including a reserved Root lane (three active non-root turns), explicit
> `AgentLimitReached` without a hidden capacity queue, direct-parent
> completion, reusable Actor identities with separate Turn lifecycles,
> safe-boundary follow-up, interruption, a root-owned work budget, and a
> canonical Ultra-aligned collaboration surface. F270 retires AMAW and F248's
> complexity-driven Workflow directive, leaving AMA as the single adaptive
> multi-Agent mode.
> F249's explicit natural-language Workflow request plus `/workflow`,
> `/review --workflow`, named, and SDK execution remain available; task
> complexity alone never activates Workflow in either prompt or tool-description
> bytes. Released Workflow product capabilities remain while their declared
> pending steps stay protocol state and child execution moves to the unified
> control plane; post-F270 use determines later retirement or evolution. The old
> model-visible task tool names are superseded rather than kept as a second
> orchestration system, and F269's released owner/recovery schema is a hard ship
> prerequisite.
>
> **2026-07-15 patch deferral**: `FEATURE_266` and `FEATURE_270` move together
> from `v0.7.70` to `v0.7.71` so `v0.7.70` remains a bounded, feature-free patch
> release. Scope, priority, dependencies, and acceptance criteria are unchanged.
> This schedule correction supersedes the earlier `v0.7.70` target references
> above without rewriting their historical record.
>
> **2026-07-16 second patch deferral**: `FEATURE_266` and `FEATURE_270` move
> together again from `v0.7.71` to `v0.7.72`. Their scope, priority,
> dependencies, and acceptance criteria remain unchanged. This is the current
> target and supersedes the 2026-07-15 `v0.7.71` assignment.
>
> **2026-07-15 F269 embedder patch**: the feature-free `v0.7.70` patch fixes
> logical daemon client accounting and adds a public, revisioned, atomic
> daemon-to-inline rollback contract. Process-distinct automation proves
> `1 -> 2 -> 1` clients, stale-commit rejection, detach-only `close()`, and two
> daemon/inline owner cycles. F269 remains assigned to `v0.7.69`; this is a
> compatibility fix, not a new Feature or a reschedule of F266/F270.
>
> **2026-07-15 v0.7.70 release hardening**: issues 161-164 close MCP physical-
> capacity/cache/pagination and multilingual zero-match defects, plus A2A
> provider-default, endpoint-trust, task-lifecycle, artifact, and protocol gaps.
> The release also begins the KAI-FCL-1.0 license boundary. These are bounded
> compatibility, correctness, and distribution changes; they do not add a new
> Feature or move F266/F270 back into this patch slot.
>
> **2026-07-17 v0.7.71 patch release**: issues 165 and 166 make packaged/asar
> Electron daemon auto-start execute through a bootstrap-only Node boundary,
> prevent a second GUI launch, scrub Electron Node mode before daemon and user
> child code loads, and document the `RunAsNode` fuse/attach-only boundary.
> Windows CRLF template checks are also normalized. The patch additionally
> carries the post-release F267/F268 OAuth/activation closure, Issues 167-170
> hardening, explicit stopped-server durable-owner migration, concurrent A2A
> admission, bounded executor/daemon lifecycle, and the public Kimi K2.7 plus
> Kimi For Coding K3 capability refresh. No new Feature ID enters the slot;
> F266/F270 remain scheduled together for v0.7.72.

> **2026-07-19 v0.7.73 first-run setup insertion**: `FEATURE_271` makes a
> fresh interactive CLI installation recoverable without requiring users to
> discover provider aliases, config-file schema, and environment-variable names
> from an eventual failed model call. It is intentionally coupled in release
> timing, but not in authority, with the Auto LLM classifier-model patch: the
> setup flow writes only non-secret provider/model configuration; Runtime Auto
> LLM continues to fail clearly when no valid classifier model is available.
> No API key is entered, persisted, or exposed by the wizard.
> The original implementation slice completed on 2026-07-20 after the matching 1.625 MB historical
> tool-result regression was bounded at the classifier API, implicit Auto LLM
> ownership was corrected, the four-call GLM-5.2 diagnostic probe completed,
> and the full 10,321-test suite passed. F271 was reopened the same day to close
> the public typed-settings resolver, Runtime speculative-window parity,
> capability-v3 daemon negotiation, and prompt-free sideQuery/guardrail
> diagnostics before release.
>
> **2026-07-12 F225 early cleanup slice**: the Classic readline
> reverse-video StatusBar was proven write-only (`update()` calls with no
> production `show()`/`toggle()`), internal-only, and independent of the live
> Ink StatusBar and Runtime SDK. Its module, dead-only tests, allocation,
> updates, and cleanup calls were removed. The auto-mode guardrail returns to
> its documented lazy first-use construction. F225 remains InProgress because
> the broader current-HEAD cleanup is still planned for `v0.7.105`.
>
> **2026-07-11 emergency session-recovery exception**: `FEATURE_261` is a
> bounded v0.7.67 corrective enhancement prompted by Issue 149. It replaces
> bare `-r` auto-resume with a searchable/paged TUI, adds SDK surface/cursor
> session listing, hides non-resumable zero-message placeholders, and provides
> preview-first reversible cleanup. It does not consume a new roadmap slot.
>
> **2026-07-12 v0.9.0 supply-chain security reactivation**: `FEATURE_262`
> reuses the otherwise empty `v0.9.0` milestone for npm 12 install-time
> security and npm trusted publishing. This does not move any feature out of
> the archived `v0.9.5` staging history. The feature keeps Node 20 runtime
> support, proves that KodaX builds without dependency lifecycle scripts, and
> migrates npm publication from long-lived/bypass-2FA credentials to GitHub
> Actions OIDC before the January 2027 publishing cutoff.
>
> **2026-07-23 F263 schedule adjustment**: at user direction, `FEATURE_263`
> moves from `v0.7.75` to `v0.7.77`. `v0.7.75` and `v0.7.76` are therefore
> feature-free stabilization / bugfix slots. `FEATURE_265` and
> all later roadmap targets remain unchanged. This supersedes only the active
> F263 target in the 2026-07-12 notes; their historical reviewed-out decisions
> remain unchanged.
>
> **2026-07-24 F274 quality-strategy insertion**: at user direction,
> `FEATURE_274` enters `v0.7.76`, superseding only the statement above that
> `v0.7.76` is feature-free. It gives AMA a shared six-pattern adaptive
> problem-solving playbook, Runtime-derived `PatternTrace`, and Sidecar-aligned
> quality judgment without reintroducing complexity-driven Workflow activation,
> a fixed Agent topology, or a second quality gate. `v0.7.75` remains the
> feature-free SDK stabilization candidate; F263 and later targets do not move.
>
> **2026-07-25 F274/F263 one-version delay**: at user direction,
> `FEATURE_274` moves from `v0.7.76` to `v0.7.77`, and `FEATURE_263` moves from
> `v0.7.77` to `v0.7.78`. `v0.7.76` returns to a feature-free stabilization /
> bugfix slot. `FEATURE_265` and all later roadmap targets remain
> unchanged. This supersedes only the active targets established by the two
> schedule notes immediately above.
>
> **2026-07-25 F275 governed-intervention insertion**: at user direction,
> `FEATURE_275` joins `v0.7.77` without moving F274. It replaces F260's
> timing-ineffective semantic prefetch with sparse post-event intervention,
> while F228 remains the sole durable memory authority. Core primitives are
> landed, including source-aware candidate admission, trigger-aware pinning,
> and run-loop ordering regression. F274 engineering and frozen experiment
> contracts are also landed. The paid release evaluation completed with a
> joint `SHIP` decision; no task-effect improvement is claimed.
>
> **2026-07-28 F276 setup onboarding completion**: `FEATURE_276` joins
> `v0.7.78` to make first-run setup initialize and explain the complete split
> configuration surface. It keeps active `config.json` strict JSON, puts the
> split-path pointer on the first line of `config.example.jsonc`, adds the
> custom-only wizard and shared CLI/REPL guide, and never overwrites an
> existing active file or template.
>
> **2026-07-28 F277 Auto[LLM] permission correction**: `FEATURE_277` joins
> `v0.7.78` to separate deterministic permission decisions, LLM danger review,
> user approval, and optional ASRT execution containment. Exact safe reads and
> workspace/temp mutations no longer depend on classifier latency or sandbox
> activation; setup entrypoints proactively prepare the platform sandbox.
>
> **2026-07-29 F278 durable AskUser history projection**: `FEATURE_278` joins
> `v0.7.80` to expose AskUser questions and answers as a compact structured SDK
> projection and a distinct REPL history module. It derives from the canonical
> `tool_use` + `tool_result` pair, survives normal session resume without a
> second store, and deliberately avoids a new UI-history union member,
> `InkREPL.tsx` state, Session schema migration, or Runtime event change.
>
> **2026-07-29 Extension self-learning removal**: the proposed automatic
> Extension learning loop is deleted from the roadmap. Extension complexity,
> authority, dependencies, state, and verification cost vary too widely for one
> reliable generic self-learning path. Extension authoring remains an explicit
> user-directed coding task. `v0.7.80` now contains F278 and the independently
> scoped F279.
>
> **2026-07-30 F279 same-Runtime root Task messaging**: `FEATURE_279` joins
> `v0.7.80` after the Codex/KodaX collaboration review. F270/F273 already cover
> the complete same-Session Actor tree, so F279 addresses the missing
> Runtime-authenticated root Session-to-Session route while treating its
> persistence/Runner/ownership work as a primary v0.7.80 change. It reuses the target
> root's durable Actor mailbox, safe-boundary Runner delivery, stable pending
> IDs, and post-transcript acknowledgement; it does not merge Actor trees,
> create a second bus/store, impersonate user input, or auto-start an idle
> target Run. v1 is root-only, same canonical project/Runtime, bounded
> single-recipient messaging; desktop task routing/UI labels, cross-process
> standalone delivery, handoff, wait/read receipts, broadcast, and remote A2A
> remain out of scope.
>
> **2026-08-01 F282/F283 long-Session continuity design**: `FEATURE_282`
> replaces ADR-057's unbounded active all-query residency with a bounded recent
> exact-query projection while preserving every genuine query in canonical
> durable lineage. It upgrades the existing CAP-028/CAP-062 path into one
> mandatory, capability-aware, durable physical-capacity emergency transaction;
> no second rail, vector index, or 64K admission gate is added. Public guidance
> recommends at least 64K and classifies smaller windows as high-risk/
> best-effort. Each F282 checkpoint also carries a bounded lossy Query Digest
> updated from the previous digest plus a bounded consecutive exact backlog
> through the active archive boundary; it never resends all historical queries on every
> compaction, and exact lineage/search/read remain authoritative. `FEATURE_283`
> remains independent: builtin history search gains local BM25-style/character
> n-gram recall plus adaptive bounded `sideQuery()` expansion/rerank when
> lexical confidence is insufficient. LLM assistance is builtin, not an
> Extension. Only a future optional local embedding/dense layer uses the
> existing Extension wrapper seam; embeddings, external services, and vector
> databases are not v0.7.80 dependencies.
>
> **2026-07-30 F280 cache-stable prompt/tool optimization**: `FEATURE_280`
> was targeted at `v0.7.79` and was explicitly rescheduled to `v0.7.81` on
> 2026-08-03 to reduce real multi-turn model cost without weakening
> tool selection, arguments, permissions, recovery, or cache reuse. It freezes
> stable prompt/tool projections per task, bounds built-in discovery results,
> adds a qualified exact/unique MCP call-ready fast path, and evaluates
> 6.5/6.0/5.5k compact tool projections with the direct-callable set unchanged
> before any separate exposure experiment; 5/4.5k remain pressure candidates.
> The first KodaX/Claude Code/Codex/Hermes inventory audit found that KodaX's
> 78-definition registry is not itself the cost defect, while its ordinary
> 59-67 model-visible surface is materially broader. The design therefore
> prioritizes stable compact projections and additive, run-frozen exposure over
> aggressive all-family merging. A complete 78-to-Codex crosswalk further
> adopts registry/projection separation, hidden compatibility aliases,
> canonical Ask input, and no-unlock search history; Codex-like plan, persistent
> shell session, patch, namespace, and code-mode surfaces remain independently
> gated challengers.
>
> **2026-07-30 F105 parity-first virtual Provider decision**: `FEATURE_105`
> returns in `v0.7.90` as a faithful KodaX adaptation of Hermes Agent's
> Mixture-of-Agents virtual Provider. `moa:<preset>` behaves as one logical
> provider/model while tool-free reference slots run concurrently and one
> configured aggregator remains the acting, streaming, tool-capable model.
> Scope includes presets, `/moa` one-turn use, session/SDK selection,
> `user_turn | per_iteration | every_n:N` cadence, exact retry/cache behavior,
> partial failure, abort/late accounting, privacy, physical provider/model cost,
> effective aggregator capability/cache/replay identity, auxiliary unwrapping,
> and recursive-MoA rejection. The previous planner/role-router/Decision-Packet
> redesign is withdrawn as an architectural regression. Post-parity research
> into Self-MoA, roles, structured evidence, blind aggregation, and learned
> routing remains unplanned; no superiority claim is part of F105.
>
> **2026-08-01 F105 architecture contract approved**: the MoA implementation
> belongs in `@kodax-ai/agent`, while `@kodax-ai/llm` adds only neutral
> effective-target, prepare/rebase, and physical-call contracts. Existing Root
> and managed loops prepare once before context compaction and rebase the same
> guidance afterward; this is a Provider lifecycle hook, not a restored planner
> stage. Cadence/result-cache state and an idempotent physical-call ledger are
> keyed by stable logical context inside the session rather than Provider
> instance lifetime. Local reference-result reuse and physical Provider
> KV/prompt-cache usage are specified and measured as separate cache layers.

---

## 进行中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `225` | REPL Dead / Legacy Code Cleanup | Internal / Refactor + Tech Debt | Medium | `v0.7.105` | [v0.7.100](features/v0.7.100.md#feature_225-repl-dead--legacy-code-cleanup) |

---

## v0.7.96-alpha.3 Release Record

`v0.7.96-alpha.3` is a GitHub pre-release. It ships the v2 scoped Provider
credential broker (ADR-068) and bounded shared-daemon client inventory
(`daemonClientInventory:1`) without a new FEATURE ID: shared-daemon native,
constructed, and workflow Agent turns require an explicit scoped credential
binding and fail closed without one, External Agents keep their independent
`credentialRef` plane, Agent authority wire records are closed against
unknown fields, and a v2 client fails closed against an older daemon. It
closes no tracked issues and changes no capability version beyond the new
daemon inventory capability. npm publication remains a manual maintainer
step.

## v0.7.96-alpha.2 Release Record

`v0.7.96-alpha.2` is a GitHub pre-release hotfix on top of alpha.1. It
restores the Windows boot-identity PowerShell resolution helper that the
FEATURE_295 cleanup deleted while its last caller stayed (Issue 325): on
alpha.1, every Windows exit settlement crashed with
`windowsAclPowerShellExecutable is not defined` and left sandbox cleanup
`unverified`. The hotfix ships no feature or protocol changes; Windows
`sandboxRuntime:6`, `runtimeExitSettlement:2`, and `crashOutcomeModel:2` are
unchanged, and npm publication remains a manual maintainer step.

## v0.7.96-alpha.1 Release Record

`v0.7.96-alpha.1` is a GitHub pre-release. It ships `FEATURE_295` and
`FEATURE_296`, closes Issues 303-320 (except the Open residuals listed below),
and advances Windows `sandboxRuntime` to `6` (`runtimeExitSettlement:2` and
`crashOutcomeModel:2` unchanged). npm publication remains a manual maintainer
step.

`FEATURE_295` (ADR-066) separates trusted text transactions from platform
shell containment on Windows, Linux, and macOS: controlled text tools commit
in the trusted KodaX Runtime with final identity policy, a cross-Runtime
per-file kernel lock, revision CAS, and flushed atomic replacement, while
Windows shell commands keep ASRT for network/account services and run through
the native restricted-token runner (native shell protocol version 7). Existing
Windows installations run `kodax sandbox setup` once for the account/SID
cutover; missing migration state blocks only native shell admission.

`FEATURE_296` (ADR-067) replaces the local tool-result capacity hard gate with
capacity-debt admission and a bounded recovery ladder: executed
`tool_use`/`tool_result` pairs always commit, over-budget batches record
`capacityDebt` metadata, compaction relieves the debt, the output reserve
shrinks floor-bounded (3000), irreducibly oversized fresh input degrades to a
paged volatile pointer, and local capacity terminals classify as
`failureKind: "context_capacity"` with structured `contextTokens`.

Issues 256, 307, 308, 309, and 321-324 remain Open and documented in
`KNOWN_ISSUES.md`; none block this pre-release.

The release checklist is [docs/release.md](release.md#v0796-alpha1-release-preparation).
The completed F295 human verification is
[FEATURE_295_v0.7.96_TEST_GUIDE](test-guides/FEATURE_295_v0.7.96_TEST_GUIDE.md).
The completed F296 human verification is
[FEATURE_296_v0.7.96_TEST_GUIDE](test-guides/FEATURE_296_v0.7.96_TEST_GUIDE.md).

---

## v0.7.79 Release Record

The `@kodax-ai/kodax@0.7.79` release (tagged `bbdc12c0` on 2026-08-04,
published to npm) includes completed `FEATURE_281` and `FEATURE_284` plus the
Runtime Session observation/export/diagnostic,
event-coalescing, standalone child-process, lineage, shell cleanup, packaged
sidecar, provider-compatibility, setup, and Windows ASRT fixes recorded in
`CHANGELOG.md` and `KNOWN_ISSUES.md`.

`FEATURE_280` was explicitly rescheduled to `v0.7.81` on 2026-08-03, then to
`v0.7.86` on 2026-08-04. It is not
included in the release claims, and the v0.7.79 feature design,
this tracker, the release checklist, and the README release notes were updated
together with that decision.

The same release contains a non-Feature release-hardening addendum. Issue 257
delivers the evidence-checked ordinary-conversation projection without changing
raw transcript audit semantics. Issue 256 was explicitly rescheduled to
`v0.7.85` on 2026-08-07 and is not part of this release: snapshot-based
Windows ancestry cannot prove descendant closure after an intermediate parent
exits, so spawn-time Job Object containment and a host-issued Worker owner
lease are required in v0.7.85.

The release checklist is [docs/release.md](release.md#v0784-release-preparation).
The completed F281 human verification is
[FEATURE_281_v0.7.79_TEST_GUIDE](test-guides/FEATURE_281_v0.7.79_TEST_GUIDE.md).
The completed F284 Qwen Token Plan verification is
[FEATURE_284_v0.7.79_TEST_GUIDE](test-guides/FEATURE_284_v0.7.79_TEST_GUIDE.md).

---

## v0.7.90 Release Record

`v0.7.90` is a stabilization release with no new feature slot. It carries
workspace-session orderly retirement after RPC timeout, the reset-grace cleanup
deadline, diagnosable daemon Error/AggregateError/cause details, direct physical
clone provenance with topology-correct archive markers, and provider-valid
object schemas for run-scoped tools. These are intentional Runtime/sandbox,
Agent lineage, Coding runtime, and REPL persistence system-code fixes; no
fail-closed safety boundary is weakened.

The release checklist is [docs/release.md](release.md#v0790-release-preparation).

---

## v0.7.95 Release Record

`v0.7.95` is a non-Feature maintenance release. It closes Issues 301 and 302
plus the Windows sandbox recovery layer, and advances Windows
`sandboxRuntime` to `5` and `runtimeExitSettlement` to `2`
(`crashOutcomeModel:2` unchanged).

Windows sandbox cleanup is self-healing: the machine-global cleanup Job is
recoverable across reboots, recovery tickets repair without operator input,
background retries observe the exact daemon and supervisor process
generations, and dynamic worktrees register their cleanup policy at creation.
Same-boot `unconfirmed-owner` recovery retries automatically and clears only
after an exact sandbox-user SID-idle proof.

Issue 301 reclaims learning locks whose owner data is stale zero-byte,
malformed, or truncated through unchanged bytes/stat verification, and
restores the terminal after fullscreen TUI teardown. Explicit Skill execution
separates exact canonical user input from execution overlays, rejects
multiple active references, and treats `PreToolUse` failure as a denial.
Terminal Run persistence failure publishes `unknown` (or
`run_settlement_not_persisted`) and invalidates live Session observations
when no durable event can be committed; a terminal status rename that
commits before later cleanup throws is reread once and emitted exactly once.

Issue 302 delays the coding runtime's public `onComplete` completion signal
until extension completion and asynchronous result finalization have produced
the authoritative `KodaXResult`, including the lost-executor-Promise fallback
path. A2A responses and other completion subscribers can no longer observe an
empty successful answer before the coding result settles.

Issue 256 remains Open: this slice does not prove descendant closure after an
intermediate parent exits. FEATURE_287 remains planned for a later 0.8.x slot
and is not shipped here.

The release checklist is [docs/release.md](release.md#v0795-release-preparation).

---

## v0.7.94 Release Record

`v0.7.94` is a non-Feature maintenance release. It closes post-v0.7.93
sandbox and host-lifecycle gaps without changing capability versions.

Runtime `write`, `edit`, `multi_edit`, `insert_after_anchor`, and `undo` may
overlap a compatible live Bash lease because snapshot and commit run through
the same ASRT workspace policy. Covered workspace targets fail closed when
that sandbox is unavailable. Hard-linked targets are rejected. Backup
identity comes from the opened helper. Worktree Git drain stays fail-closed
when process-tree completion is unprovable. A missing workspace directory
omits the concurrent text sandbox at Run start instead of aborting the Run.

Issue 300 replaces Windows sandboxed git wildcard trust with authorized repo
roots, including linked-worktree and submodule backlinks. The v4 capability
exposes `gitSafeDirectory: authorized-repo-roots` as a stale-daemon marker.

Scheduled daemon shutdown reports failed cleanup instead of a safe stop.
Runtime advertises `conversationHistory:2` for topology-transparent managed
context and direct clone provenance.

Explicit Skill invocation (`/<name>`, `/skill:<name>`) is independent of
model discovery. `disable-model-invocation` only blocks the model `skill`
tool; structured `skillInvocation` provenance follows Workflow and child
execution, and a model-authored slash token cannot bypass that fence.

Run terminal settlement observes every finalization rejection. Durable
terminal status remains authoritative if only event publication fails. Total
terminal persistence failure reports `unknown` /
`run_settlement_not_persisted` and keeps the Session fenced. Daemon
disconnects expose typed connection facts. After admission, hosts recover
through `runs.get(runId)` / `runs.await(runId)` and never replay
`runs.start()`.

Issue 256 remains Open: this slice does not prove descendant closure after an
intermediate parent exits. FEATURE_287 remains planned for a later 0.8.x slot
and is not shipped here.

The design and acceptance contract are
[v0.7.94](features/v0.7.94.md),
[Issue 300 v0.7.94](test-guides/ISSUE_300_v0.7.94_REGRESSION_GUIDE.md), and
[Runtime daemon recovery](test-guides/ISSUE_RUNTIME_DAEMON_RECOVERY_v0.7.94_REGRESSION_GUIDE.md).

Sandboxed text-helper stdin failures stay on the operation Promise.
Linked-worktree and submodule relationship files are read through strict byte
bounds before git trust. Invalid Skill `allowed-tools` entries and malformed
hook JSON are diagnosed. `PostToolUse` still runs if an embedder result
observer throws.

The release checklist is
[docs/release.md](release.md#v0794-release-preparation).

---

## v0.7.93 Release Record

`v0.7.93` is a non-Feature maintenance release. It closes three post-v0.7.92
Runtime/LLM correctness gaps without changing capability versions.

Issue 297 keeps the 170-second orderly daemon-exit budget for genuinely slow
cleanup, but no longer spends that window after the exact Windows daemon has
already persisted a terminal failed shutdown outcome. Settlement observes that
durable evidence while waiting for process exit and enters the existing exact
PID/start-identity, Job-containment, and ACL-recovery path immediately.

Issue 299 recovers previous-boot foreign Windows ACL markers only after a
changed boot identity and a machine-lock recheck prove every marker has a
canonical non-current boot identity. Recovery is recorded before marker
removal. Same-boot, mixed, unreadable, or identity-free markers remain
fail-closed.

Issue 298 classifies Anthropic/OpenAI `APIUserAbortError` objects by isolated
SDK class identity when the request signal is already aborted, so managed Stop
retains its interrupted terminal before credential redaction.

Issue 256 remains Open: this slice does not prove descendant closure after an
intermediate parent exits. FEATURE_287 remains planned for a later 0.8.x slot
and is not shipped here.

The design and acceptance contract are
[v0.7.93](features/v0.7.93.md),
[Issue 297 v0.7.93](test-guides/ISSUE_297_v0.7.93_REGRESSION_GUIDE.md),
[Issue 298 v0.7.93](test-guides/ISSUE_298_v0.7.93_REGRESSION_GUIDE.md), and
[Issue 299 v0.7.93](test-guides/ISSUE_299_v0.7.93_REGRESSION_GUIDE.md).

The release checklist is
[docs/release.md](release.md#v0793-release-preparation).

---

## v0.7.92 Release Record

`v0.7.92` is a non-Feature maintenance release. It closes the live-daemon
orphan filesystem-effect ticket and recorded-release owner path, and it
corrects managed terminal ordering so Session persistence precedes completion
while repo/task projections no longer hold the Run. Queue tickets share a token
with the exact coordinator lock and heartbeat while waiting. Effect release
records a token-scoped durable marker first. Runtime treats the managed
executor Promise as terminal authority and advertises `sandboxRuntime:4` plus
`crashOutcomeModel:2` so idle older daemons are replaced. Issue 296 makes
resumed TUI history canonical-first: `uiHistory` may overlay display metadata
but cannot suppress Session messages. Presentation-only `agent-completed` and
legacy `task-completed` events stay host-owned when a non-empty CLI
`uiHistory` exists. Issue 256 remains Open: this slice does not prove
descendant closure after an intermediate parent exits.

The design and acceptance contract are
[v0.7.92](features/v0.7.92.md),
[Issue 256 v0.7.92](test-guides/ISSUE_256_v0.7.92_REGRESSION_GUIDE.md), and
[Issue 296 v0.7.92](test-guides/ISSUE_296_v0.7.92_REGRESSION_GUIDE.md).

The release checklist is
[docs/release.md](release.md#v0792-release-preparation).

---

## v0.7.91 Release Record

`v0.7.91` adds the local `runtimeExitSettlement:1` SDK contract and
`settleKodaXRuntimeExit()` high-level transaction. Complete exits now persist
exact-owner intent before stop, can resume before a host starts owner
reconciliation, and can autonomously repair a verified empty Windows Job plus
matching ACL residue. Replacement owners, PID reuse, foreign markers, and
same-boot unverifiable macOS/Linux process trees remain fail-closed. After an
OS reboot, a durable boot-identity change proves the retained POSIX tree cannot
still be running and allows exact old owner/state/policy recovery. This
maintenance capability does not add a new remote daemon handshake requirement.
The release also makes provider output replacement an SDK-owned segment
projection and bundles lazy Anthropic/OpenAI SDK dependency graphs into
standalone binaries; raw Runtime journals remain the audit authority.

The design and acceptance contract are
[v0.7.91](features/v0.7.91.md) and
[Issue 295](test-guides/ISSUE_295_v0.7.91_REGRESSION_GUIDE.md).

The release checklist is
[docs/release.md](release.md#v0791-release-preparation).

---

## v0.7.89 Release Record

`v0.7.89` releases FEATURE_293's resilient zero-service web search fallback
and FEATURE_294's first-class run-scoped Host Tools. Issue 293's managed-context
projection fix is the accompanying REPL/runtime patch: replaceable context is
transparent to ordinary topology and pagination, while physical audit history,
genuine duplicate content, and unverifiable branches remain protected.

FEATURE_293 uses bounded DuckDuckGo HTML → Bing RSS → Bing HTML attempts with
truthful failure diagnostics, normalized direct URLs, `freshness: unknown`, and
isolated explicit endpoint behavior. FEATURE_294 materializes leased Host Tools
outside `TOOL_REGISTRY`, adds a cache-stable host capability catalog line,
dispatches registry-first, revokes fail-closed, rejects collisions, and supports
exact A2A `host:` capability authorization. No shell or sandbox system code is
changed by this release.

The release checklist is [docs/release.md](release.md#v0789-release-preparation),
with human verification guides for
[Issue 293](test-guides/ISSUE_293_v0.7.89_REGRESSION_GUIDE.md) and
[FEATURE_294](test-guides/ISSUE_294_v0.7.89_REGRESSION_GUIDE.md).

---

## v0.7.88 Release Record

`v0.7.88` is a non-Feature Runtime/LLM/REPL hardening release. It ships the
Actor settlement convergence v2 durability boundary, bounded startup/resume
work and heavy-dependency bootstrap audit, bounded classifier-reason
diagnostics, stale learning-recovery dismissal after query submission, and
GLM-5.3 defaults for `zhipu-coding`, `zai-coding`, and `ark-coding` while
retaining `glm-5.2` and Ark's `glm-latest` alias. Issue 292 is resolved and
the known-issue summary is synchronized.

Issue 256's remaining Worker owner-lease boundary remains Open after v0.7.88;
this release assigns no replacement target. The release checklist is
[docs/release.md](release.md#v0788-release-preparation), and the human
verification guide is
[ISSUE_292_v0.7.88_REGRESSION_GUIDE](test-guides/ISSUE_292_v0.7.88_REGRESSION_GUIDE.md).

---

## v0.7.87 Release Record

`v0.7.87` is a non-Feature GLM provider compatibility release. It adds
GLM-5.3 metadata and reasoning behavior while preserving GLM-5.2 as a usable
route. `zhipu-coding` defaults to `glm-5.3`; `zai-coding` defaults to
`glm-5.2` and keeps `glm-5.3` for accounts with access. Both aliases send
`glm-5.3` / `glm-5.2` verbatim, without the invalid `[1m]` suffix. GLM-5.3
normalizes `off` / `none` to low effort because upstream thinking cannot be
disabled.

Issue 256's remaining Worker owner-lease boundary is not included and remains
Open after v0.7.87; this release assigns no replacement target. The release
checklist is [docs/release.md](release.md#v0787-release-preparation), and the
human verification guide is
[ISSUE_GLM53_v0.7.87_REGRESSION_GUIDE](test-guides/ISSUE_GLM53_v0.7.87_REGRESSION_GUIDE.md).

---

## v0.7.86 Release Record

`v0.7.86` is a non-Feature Runtime and Windows sandbox hardening release. It
adds atomic abandoned-inline-owner recovery, process-start identity records for
Runtime and learning locks, durable Windows ACL owner markers, cross-profile
recovery serialization, termination-proof-before-ACL-recovery, combined
lifecycle diagnostics, and fail-closed no-replay behavior when Shell effects
are not proven drained. POSIX workspace admission also stabilizes fresh
`KODAX_HOME` policy roots, waits only for workspace-local warm-up within the
Shell abort/deadline, and retires invalid cached sessions after lease-cleanup
failure. Issue 291 is resolved by the inline-owner recovery
slice. Issue 256 remains Open: its Worker owner-lease portion is not included
and was scheduled for `v0.7.87` in that release disposition.

The release checklist is [docs/release.md](release.md#v0786-release-preparation).

---

## v0.7.85 Release Record

`v0.7.85` is the combined memory, Runtime journal, containment, and startup
reliability release. It ships `FEATURE_289` review-drain reliability and
pipeline observability, `FEATURE_290` lesson/verdict production,
`FEATURE_291` Session-scoped Runtime Event Journals, and `FEATURE_292`
conversation-first Memory management. It also includes the non-Feature fixes
for Actor settlement convergence (Issue 282), learned-root and Agent Home
guardrails (Issues 285/286), terminal startup replay (Issue 287), idle
repo-intelligence Worker retirement (Issue 288), Windows sandbox/ACL safety,
custom-provider completion, and the related cross-layer regression coverage.

This release does not claim the remaining Worker owner-lease portion of Issue
256. That issue remains Open and is scheduled for `v0.7.86`; the release
records the boundary explicitly rather than treating daemon/per-effect Job
containment as proof of descendant closure for every Worker-owned child.
The release checklist is [docs/release.md](release.md#v0785-release-preparation).

---

## v0.7.84 Release Record

`v0.7.84` is a non-Feature Actor settlement-recovery hardening release. Agent
progress persistence is bounded to one in-flight write plus one latest
replacement, so terminal settlement cannot wait behind an unbounded progress
backlog. When durability becomes unknown, a same-owner Stop can reconcile the
late Actor snapshot, validate the owner fence, quiesce remaining turns, and
retry repair. Promise terminal facts outrank fallback callbacks after repair;
foreign owners, missing snapshots, and persistent storage failures remain
fail-closed. No-op quiescence avoids an unnecessary Session rewrite.

This release resolves Issue 282. It does not claim the Worker owner-lease
portion of Issue 256, which remains scheduled for `v0.7.85`; `FEATURE_287`
remains planned for `v0.7.93`. The release checklist is
[docs/release.md](release.md#v0784-release-preparation).

---

## v0.7.83 Release Record

`v0.7.83` is a non-Feature Windows daemon-containment hardening release. A
new Windows daemon is created suspended, assigned to a kill-on-close Job Object
before resume, and supervised from outside that Job until its active-process
count reaches zero. The SDK exports `waitForRuntimeDaemonShutdown()` and
advertises `daemonShutdownVerification:1`; CLI stop waits for both daemon and
supervisor exit. Legacy uncontained daemons remain explicitly unverified and
must be stopped and relaunched before a host requires this contract.

The release also closes the review-found Job-assignment failure path by
terminating a still-suspended process before closing its handles. This is a
runtime system-code fix, not a test-only or process-only change. The daemon
slice reduces Issue 256's scope but does not resolve the Worker owner-lease
portion, which remains scheduled for `v0.7.84`; `FEATURE_287` remains planned
for `v0.7.93`. The release checklist is
[docs/release.md](release.md#v0783-release-preparation).

---

## v0.7.82 Release Record

`v0.7.82` is a non-Feature runtime-causality patch. It releases the resolved
Issue 279/280/281 hardening without representing any planned feature as shipped:

- unfiltered daemon capability discovery composes live, complete MCP and Host
  Tool snapshots; explicit server filtering selects only its source and a
  legacy source reports incomplete/unknown discovery honestly;
- an observed managed Run Stop cooperatively fences later retry, continuation,
  guardrail, tool, and Run-admitted Actor work while preserving trusted
  Stop/Abort causality before credential redaction;
- input admission resolves the authoritative Run before mutable Session history,
  eliminating transient `data_changed` rejection during active interrupt and
  after-turn submission while retaining predecessor settlement and exact
  operation idempotency.

`FEATURE_287` remains planned for `v0.7.93`; Issue 256 remains scheduled for
`v0.7.84`. The release checklist is
[docs/release.md](release.md#v0782-release-preparation).

---

## v0.7.81 Release Record

`v0.7.81` is a non-Feature runtime-integrity patch. `FEATURE_287` was already
rescheduled from `v0.7.81` to `v0.7.88`; it is not presented as delivered here.
The `@kodax-ai/kodax@0.7.81` release records the following canonical interrupt
delivery contract:

- every Runtime-owned queued interrupt prompt is saved as its own canonical
  Session user entry before delivery is published;
- the durable `run.input.delivered` event and `runs.get()` interrupt status
  expose the exact physical `entryId` for each delivered queue item, including
  after compaction, replay, and Runtime restart;
- an ordered multi-input drain keeps separate user-message boundaries and maps
  each queue id to its own entry; missing/ambiguous provenance or persistence
  failure fails delivery closed rather than publishing an unverifiable result.

The release checklist is [docs/release.md](release.md#v0781-release-preparation).

---

## v0.7.80 Release Record

`v0.7.80` is a debug/patch release. `FEATURE_278/279/282/283/285` were explicitly
rescheduled to `v0.7.85` on 2026-08-04 (designs stay in
[features/v0.7.80.md](features/v0.7.80.md)); `FEATURE_287` was rescheduled from
`v0.7.81` to `v0.7.88` on 2026-08-05, leaving `v0.7.81` empty. The `@kodax-ai/kodax@0.7.80` release
contains the non-Feature hardening recorded in `CHANGELOG.md`,
`KNOWN_ISSUES.md` (Issue 275 resolved), and
[docs/release.md](release.md#v0780-release-preparation):

- the CLI honors `worker.configuredA2A` in `~/.kodax/config.json`, creating a
  Worker-hosted embedded Runtime that loads the configured A2A plane inside the
  Worker owner (rejecting configured MCP servers or Extensions that cannot
  cross the Worker boundary), with daemon-style transport sanitization of run
  options;
- a structured `RunnerIterationLimitError` failure plus a 500-iteration
  per-invocation panic fuse for one uninterrupted managed tool loop (idle-yield
  resumes reset the counter; the managed-task lifecycle stays unbounded);
- Issue 275 Auto permission fix (ordinary search scopes / trusted tool
  side-effect metadata stay deterministic; `max_tokens`-truncated classifier
  retries with a 1024-token budget);
- managed-run repetition-loop prevention, restored parallel review, and
  tightened parallel delegation guidance.

The release checklist is [docs/release.md](release.md#v0780-release-preparation).

---

## 2026-08-04 v0.7.80+ Roadmap Reschedule

At explicit user direction, every planned `v0.7.x` feature moves back by five
minor versions so the next several slots can serve as release/debug buffer:

- `FEATURE_278`, `FEATURE_279`, `FEATURE_282`, `FEATURE_283`, `FEATURE_285`:
  `v0.7.80` -> `v0.7.85`.
- `FEATURE_280`: `v0.7.81` -> `v0.7.86` (follows its 2026-08-03 move from
  `v0.7.79` to `v0.7.81`).
- `FEATURE_265`: `v0.7.85` -> `v0.7.90`.
- `FEATURE_105`: `v0.7.90` -> `v0.7.95`.
- `FEATURE_225` stays at `v0.7.100` (InProgress, unchanged).

The design documents keep their per-version homes
(`docs/features/v0.7.80.md`, `v0.7.85.md`, `v0.7.90.md`) with updated
Status/Target fields; `v0.7.80`, `v0.7.81`, and `v0.7.82` are debug/patch slots.
Issue 256 remains scheduled for `v0.7.85` (bug fix, not a feature).

---

## 2026-08-04 Virtual-Provider Split

`FEATURE_287` was created to split the virtual-Provider work (previously
planned as a single `FEATURE_105`) into two independently releasable features
at explicit user direction:

- `FEATURE_287` (v0.7.88): virtual-Provider skeleton + **Advisor mode**
  (host-owned escalation triggers, no model-visible consult tool), shipped
  first; design in [v0.7.88](features/v0.7.88.md).
- `FEATURE_105` (v0.7.95): **MoA mode** on the same skeleton; design remains in
  [v0.7.90](features/v0.7.90.md).

Advisor mode validates the provider-neutral skeleton (effective-target
resolution, prepare/rebase, advisory transcript, physical-call ledger,
role-separated cache) with one real mode before MoA adds parallel fan-out.

---

## 2026-08-07 v0.7.85+ Roadmap Reschedule

At explicit user direction, every planned `v0.7.x` feature at `v0.7.85` and
later moves back by five minor versions so the next several slots can serve as
release/debug buffer:

- `FEATURE_278`, `FEATURE_279`, `FEATURE_282`, `FEATURE_283`, `FEATURE_285`:
  `v0.7.85` -> `v0.7.90`.
- `FEATURE_280`: `v0.7.86` -> `v0.7.91`.
- `FEATURE_287`: `v0.7.88` -> `v0.7.93`.
- `FEATURE_288`: `v0.7.89` -> `v0.7.94`.
- `FEATURE_265`: `v0.7.90` -> `v0.7.95`.
- `FEATURE_105`: `v0.7.95` -> `v0.7.100`.
- `FEATURE_225`: `v0.7.100` -> `v0.7.105` (InProgress).

The design documents keep their per-version homes
(`docs/features/v0.7.79.md`, `v0.7.80.md`, `v0.7.85.md`, `v0.7.88.md`,
`v0.7.89.md`, `v0.7.90.md`, `v0.7.100.md`) with updated Status/Target fields;
`v0.7.85`, `v0.7.86`, `v0.7.88`, and `v0.7.89` return to debug/patch slots.
Issue 256 remains scheduled for `v0.7.85` (bug fix, not a feature).

---

## 2026-08-07 FEATURE_289 Addition

`FEATURE_289` (Memory Review Drain Reliability + Pipeline Observability, `v0.7.85`,
design in [v0.7.85](features/v0.7.85.md#feature_289-memory-review-drain-reliability--pipeline-observability))
was added at explicit user direction after a multi-agent adversarial audit of the
governed memory pipeline found that episode review has never completed since
v0.7.68: on a real machine 1377 review jobs accumulated (1312 pending with zero
provider attempts, 64 completed all eligibility discards, zero `decision.json`)
because drains are fire-and-forget and short-lived processes exit before the
LLM judge returns. `v0.7.85` therefore carries one feature alongside Issue 256
instead of remaining a pure debug/patch slot. Scope is the P0 reliability and
observability package only; review-admission widening and lifecycle-command
wiring were explicitly deferred pending user review.

---

## 2026-08-08 FEATURE_290 Addition + FEATURE_289 P2-a Merge

`FEATURE_290` (Memory Lesson and Verdict Production + failedWithLesson
Admission, `v0.7.85`, design in
[v0.7.85](features/v0.7.85.md#feature_290-memory-lesson-and-verdict-production--failedwithlesson-admission))
was added at explicit user direction as the improved replacement for the
deferred P1 "review-admission widening" proposal. A replay-dataset probe
over the 1332 real pending review jobs showed admission was never the
bottleneck (lesson rate 3.1%; zero verdicts in 1333 evidence entries), so
F290 fixes lesson/verdict production structurally, admits `failedWithLesson`
additively, keeps failedWithLesson-derived proposals in the human approval
queue deterministically, and validates with an offline replay eval instead
of a multi-week production baseline. It shares `v0.7.85` with FEATURE_289
and Issue 256. The same day, P2-a (dead review-inbox rewind/fence removal)
was merged into FEATURE_289 as its §3.8; the remaining P2 dead-code cleanup
(`truncate.ts` / `memory-section.ts` / `purgeRef` deprecation) and
`/memory forget|archive` wiring stay deferred.

Note: the uncommitted "v0.7.89+ roadmap slide into 0.8.x" in
`docs/features/` (mapping `v0.7.(90+n) -> v0.8.n`; F265 -> `v0.8.5`,
F280 -> `v0.8.1`, old `v0.8.5` -> `v0.9.5`) does not cover `v0.7.85`;
F289/F290 stay at `v0.7.85`. The broader FEATURE_LIST sync for that slide
(F265/F280/F105/F225/007/030/093 rows, the near-term chain, and the
per-version distribution) remains pending with the slide itself.
---

## v0.7.78 Release Record

`FEATURE_263` now implements the full evidence-gated background Skill Learning
Loop: non-blocking durable review, immutable unified decisions, fenced
effectively-once Memory/Skill actions, project-scoped declarative canaries,
verified use/outcome attribution, canonical record-gated discovery, complete
Learning Center controls, and truthful inline/Worker/daemon capability parity.
The final hardening also adds session-wide all-root atomic preflight, exact
durable identity/payload/owner gates, decision-pinned carriers with
completion-after-all-receipts, and Memory-required/Skill-optional recovery for
older v2 artifacts. It is not a Ready-only MVP. Layer 1 build and automated
verification pass. The recorded 14-core-file scoped coverage run measured
86.39% line coverage; the current documented F263 cross-layer regression
matrix passes 487 tests with one optional case skipped across 23 files, and the
complete fast/unit/contract/system suite passes.
The human guide is
[FEATURE_263_v0.7.78_TEST_GUIDE](test-guides/FEATURE_263_v0.7.78_TEST_GUIDE.md).

`FEATURE_276` now implements complete first-run split-configuration onboarding:
missing core/MCP/Extensions/A2A active files and annotated templates are created
without overwriting existing files, legacy integration declarations are
preserved, and CLI/REPL share one provider/path/command/shortcut guide. The
custom-only metadata wizard explains every field without collecting secrets.
The implementation review additionally makes help return before startup
side effects, prevents `KODAX_PROVIDER` from bypassing first-run initialization,
validates every existing active split config before writing, and fences
concurrent migration/provider writes. The root-owned A2A schema is injected
without reversing package dependencies, pending legacy MCP/Extensions are
validated as one preflight inside the public migration entry, and all
cooperating KodaX core writers—including startup self-healing and legacy
cleanup—share one lock plus revision recheck. Installed templates show the
actual `KODAX_HOME`.
Built-process tests cover help, real initialization, authoritative invalid
configuration failure, mid-wizard EOF, and `--custom`; the suite is part of the
normal system/CI gate. The full verification record remains with the feature.
The human guide is
[FEATURE_276_v0.7.78_TEST_GUIDE](test-guides/FEATURE_276_v0.7.78_TEST_GUIDE.md).

`FEATURE_277` implements the v0.7.78 permission correction defined in its
design: exact safe operations bypass classifier latency, remaining actions are
reviewed against bounded user intent and precise side effects, approval timeout
cancels only the current execution with recovery guidance, classifier failure
uses one retry plus Accept-edits fallback, and ASRT becomes optional execution
containment rather than permission authority. Its verification record and human
guide are maintained in
[FEATURE_277_v0.7.78_TEST_GUIDE](test-guides/FEATURE_277_v0.7.78_TEST_GUIDE.md);
normal REPL history stays quiet and `/sandbox` is the explicit diagnostics entry.

All three features are `Completed` and shipped in v0.7.78 on 2026-07-29. The
previously missing current-policy release runners were closed as Issue 235:
F263 revision `f263-v0.7.78.2` and F277 revision
`f277-v0.7.78.2` froze the initial exact production bytes, cases, routes, scorer,
budgets, resumable raw output and blind-review packets. Their paid calls
required explicit owner authorization, and the final integrated regression
matrix remained a version-level gate rather than a Feature lifecycle state.

The authorized `f263-v0.7.78.2` pilot then exposed Issue 236 and stopped after
four calls without panel expansion. The minimal production prompt/schema fix is
retained as historical evidence. The authorized F263 `.3` safety panel then
found no credible high-severity harm and no negative project canary, while all
nine positive raw decisions selected `project_canary`. It also exposed Issue
237: six of those nine positive decisions were downgraded solely because the
production prompt/tool schema omitted the validator's lowercase hyphenated-slug
constraint. The strict validator and learning policy remain unchanged; the
minimal protocol clarification is tracked by replacement revisions
`f263-v0.7.78.4` and `f277-v0.7.78.4`. Both bound the corrected bytes to the
same exact release-candidate SHA before publication. These release-gate results
did not roll completed Feature lifecycle records back into implementation
status.

---

## v0.7.77 Release Record

`@kodax-ai/kodax@0.7.77` contains the engineering-complete F274/F275
implementation. F274 gives AMA one shared six-pattern adaptive playbook,
validated optional `quality_strategy` metadata, bounded Runtime-derived
`PatternTrace`, and Sidecar-aligned evidence without complexity-driven Workflow
activation, fixed Agent topology, or a second quality gate. F275 replaces the
timing-ineffective F260 semantic prefetch with sparse foreground intervention
after tool failure, verification failure, or committed compaction while F228
remains the sole durable memory authority.

The release also adds public `kimi-k3`, prompt-cache diagnostics, provider
default-model resolution before Auto preflight, default-model catalog
deduplication, active-run interrupt finalization hardening, the final
child-runtime cache/context identity and Actor capability fixes, a
host-configurable Shell Execution Contract, compaction-safe request-only
managed context, stable root/child Provider cache affinity across physical
requests and resume, official Codex/Gemini CLI cache-usage preservation,
ACP/native-CLI session isolation with fail-closed process exits, and
terminal/schema/memory integrity hardening. Package metadata was synchronized
at `0.7.77`; the release-evidence commit passed Node 20/22, Unix Runtime
socket, Windows Shell Contract, and packaged Electron CI before tagging.
The frozen F274 `f274-v0.7.77.6` Layer 2/3 evaluation and F275
`f275-v0.7.77.3` pilot completed against clean commit `25d5521e`; the three
final blinded stage reviews recorded `recommend-ship`, and the joint owner
decision is `SHIP`. F274's budgeted production playbook plus
`quality_strategy` delta is
2,985 bytes (2,425 prompt bytes plus 560 `spawn_agent`/`followup_task`
tool-schema bytes), candidate simple tasks stayed solo
in 6/6 cells, and accidental Workflow activation was zero. F275 deterministic
B/C preserved the post-compaction compatibility constraint in 4/4 cells while
all four selector calls remained silent. The semantic selector remains experimental
and host opt-in; no task-effect/default-on, token, or latency improvement is
claimed. Git tag `v0.7.77`, the GitHub Release, and npm publication completed
on 2026-07-27.

---

## v0.7.76 Release Record

`v0.7.76` introduces no Feature ID. It refreshes Kimi Code after `k3-256k`
became an independent official Model ID: `kimi-code` defaults to the direct
256K route, while `kimi-for-coding` remains selectable for K2.7 Code beside
`k3` and `kimi-for-coding-highspeed`. The release also aligns K3 effort,
media-capability, and nominal quota metadata with the official model contract
and exercises all four subscription routes through gated live smoke tests.

---

## v0.7.75 Stabilization Record

`v0.7.75` introduces no Feature ID. It is the SDK stabilization candidate for
Windows GUI background-process hardening and Sidecar/Runtime completion
correctness. Runtime
Worker-reachable non-interactive child processes request hidden Windows
consoles, while explicit editor, terminal, and PTY paths remain unchanged. The
bundle build audits the published worker surface and the packaged Electron
smoke executes 20 ordinary queries with a console-visibility probe.

The same candidate accepts optional post-completion offers, reserves blocked
for required clarification, publishes budget-approval state only for an
eligible revision, and preserves structured blocked reasons across Runtime
persistence and daemon boundaries. The release path audits those guards in the
exact npm tarball.

Packaged KodaX Space regression on Windows 10 and Windows 11 remains a
non-blocking product follow-up and does not gate tag, package build, or npm
publication. This release slot also preserves the 2026-07-12 roadmap decisions;
FEATURE_263 is planned for `v0.7.78`.

---

## v0.7.74 Completion Record

`273` separates the model coordination wait from the durable Actor telemetry
stream. The model tool now has one bounded timeout, wakes only for scoped
mailbox/user/interruption/timeout activity, and returns an acknowledgement;
Runner and idle-yield boundaries inject authenticated Agent evidence with the
correct synthetic/user authorship and post-transcript completion receipt. Raw
event replay and long-poll remain unchanged for Runtime/SDK/daemon consumers.
The closure review added crash recovery for unacknowledged root completions,
same-process queue deduplication by child `turnId`, and explicit Goal-wrapper
propagation of the Runner yield marker.

`272` replaces the model-window/rolling-chunk large-compaction behavior with a
shared always-on policy, percentage/absolute minimum threshold, effective-tail
protection, full eligible-prefix coverage, atomic query-ledger checkpoints,
cache-stable summary requests, context-owned canonical events, and bounded
Runtime transcript paging. KodaX Space consumes the same SDK policy, isolates
root/child telemetry, reconstructs oversized transcripts through pages/chunks,
and labels root provider input separately from visible transcript history.
The final adversarial review closed managed-path event/token drift, prevented
protected raw queries from being duplicated into the ledger, rebased persisted
anchors after attachments, and made Space use paging without first attempting a
monolithic transcript request. The closing review also made imperative Runtime
compaction emit one ordered start/finished/end lifecycle (including no-op
outcomes) and made Space display the SDK-resolved physical threshold instead of
reimplementing only the percentage/absolute minimum.
The post-implementation review additionally moved Actor terminal receipts to a
post-transcript-commit boundary, made acknowledged direct-child events
non-replayable, aligned repeated visible text to the latest canonical suffix,
and suppressed fallback success for unchanged or still-oversized candidates.
The final durable-recovery closure is implemented: exact pre-compaction
messages commit before memory eviction in both SA and AMA paths, child
compaction cannot mutate root lineage, and root Agents/SDK hosts share bounded
revision-bound transcript search and exact-read recovery. Persistent children
inherit the resolved compaction policy, keep exact history in a separately
minted hidden worker Session, and can search only that child lineage. Child
compaction telemetry remains context-scoped and cannot overwrite root
accounting. The closing adversarial pass also covered a
first-run Session compact before its routine snapshot, tentative revision
rollback, Runtime/REPL single-writer ownership, legacy checkpoint/placeholder
exclusion, short-ID false positives, sidecar flush failure, and daemon
capability-v3 parity.
Canonical config templates and `kodax_manual` now document the complete policy.
Automated compaction, lineage, SDK transport, daemon, Space adapter, typecheck,
and release-build evidence is recorded in the v0.7.74 feature design; human UI
and semantic summary checks remain in its release test guide.

The final release-candidate review also resolves Issue 105 and Issue 204.
Continue-most-recent now skips zero-message placeholders across Ink, Classic,
one-shot CLI, and coding-runtime discovery, preserves explicit IDs, and restores
the saved interactive workspace runtime. Auto mode immediately shows its known
LLM/rules engine and serializes per-Session setting writes so rapid Shift-Tab
cycling is last-action-wins without resetting a legitimate sticky rules fallback.
Human regression guides cover both closures before tagging.

---

## v0.7.73 Completion Record

`271` completed its original onboarding and classifier-input slice, then closed
the SDK public-contract work for the v0.7.73 release. A bare
interactive CLI with no valid provider selection or credential now enters a
metadata-only provider/model setup before Runtime startup; explicit
`kodax setup` reuses the same revision-checked atomic writer. Auto LLM now
rejects missing classifier identity before permission work, treats omitted
engine as the LLM default under Runtime ownership, and bounds historical
Runner context at the classifier API. The SDK closure is now implemented: root
and REPL entries export the typed resolver/loader, Session state owns the
speculative window (including zero), v3 capability negotiation safely upgrades
idle v1/v2 daemons while preserving minimum-version compatibility, and prompt-free
sideQuery diagnostics plus callback-lifetime guardrail spans make timeouts
observable. The classifier-input closure now also replaces historical results
with status-only metadata, deduplicates canonical history, unwraps portable
tool bridges, and gives MCP, constructed tools, and JavaScript extensions one
fail-closed semantic projection contract. High-impact built-ins expose bounded
operational facts rather than raw bodies; non-readonly empty projections require
an explicit exemption, common snake/camel SDK fields share one priority-safe
table, projector failures escalate, and Tier 0 runs before any opt-out. The
deterministic build, focused suites, full test suite, and GitHub release gates
completed the release validation on 2026-07-20.

---

## v0.7.72 Completion Record

`266` implementation and its zero-provider Layer 1 gate are complete: the
Runtime-owned Learning Center, learned-area store, lower-precedence learned
Skill discovery, daemon/Worker facade, `/learn`/status surfaces, notification
cursors, and hard-dispose persistence are covered by deterministic tests. It
shipped in v0.7.72 after the package, documentation, build, and release gates
were finalized.

`270` engineering implementation and release eval are complete:
native, Workflow-owned, and external Agent work share the Runtime-owned
Actor/Turn tree, scheduler, durable snapshot, canonical collaboration tools,
and output events. AMAW and the parallel legacy task lifecycles are retired. A
deletion/replacement review found and fixed native/external executor selection,
durable mailbox/history projection, capability-ceiling, shared-budget, and
stale-follow-up concurrency gaps, then closed accidental Workflow activation and
speculative Actor-output-read behavior found by the frozen eval. It also
corrected an unsafe migration premise:
pre-F270 native/default-Workflow active state was process-local and F258 records
lack exact session ownership, so recovery never guesses or re-parents legacy
work. The frozen Layer 2/3 driver, exact historical/current production-byte
fixtures, manifest-only gate, budget enforcement, raw-cell integrity checks,
and blind evidence packs are complete. The final isolated 227/227 focused suite
and full build pass. The authorized Layer 2 treatment is non-inferior in 29/30
blind pairs; Layer 3 is non-inferior in 5/6 journeys with no invalid-plan replay.
Estimated evaluated-revision spend is `$0.02550684`; engineering recommendation
is `recommend-ship`. F270 shipped in v0.7.72; the separate manual guide remains
evidence rather than a sign-off gate.

The 2026-07-18 Sidecar/Actor alignment follow-up is also complete. Terminal
verification now waits for both descendant termination and root-scoped
completion delivery, synthetic completion cannot replace real user intent, and
the verifier consumes bounded task/plan/tool/file evidence with explicit
confidence semantics. The final related Layer 1 gate passes 188/188; its
separate 32-call blind A/B is candidate 14/14 versus baseline 12/14 across the
seven valid cases and recommends ship without a credible false-revise
regression. The detailed raw-evidence paths and invalid-fixture analysis remain
in the v0.7.72 design document.

A post-implementation control-plane review also replaced the stale model-owned
`seen_by` forwarding field with Runtime-minted mailbox message IDs and
authenticated lineage, added cycle/depth/classification guards and per-turn
recipient limits, and made native/external Turn progress observable through the
existing Ink/Classic activity surface. Progress, list summaries, output
previews, and event retention are explicitly bounded; no legacy task registry,
second UI store, or duplicate compatibility tool was restored.
The post-review and interruption-cleanup gate passes 62/62 focused and 286/286
cross-layer tests, 88.79% core statement/line and 80.05% branch coverage, the
complete build, and the 2/2 zero-provider manifest check.

A final completeness audit keeps the seven-tool model command plane but makes
its observation and reversible-control semantics complete: `list_agents` now
offers visibility-safe filtering and bounded cursor pagination; `wait_agent`
returns a bounded, cursor-safe event batch; `agent_output` preserves legacy
artifact strings while adding executor-neutral metadata; and
`interrupt_agent(scope='subtree')` atomically cancels an invalidated branch
without retiring reusable Actor identities. Permanent subtree close is exposed
only through the trusted Runtime host. Pause, reopen, reparent, resource-budget
changes, and capability grants remain intentionally outside the model surface
because they respectively require a portable checkpoint, administrative
identity migration, user cost authority, or host security authority. The audit
also fixes the root-only ambiguity between the non-root `parent` alias and a
valid root child named `parent`.
The completeness-audit gate passes 62/62 focused, 285/285 Actor/Workflow/
storage/UI cross-layer, and 252/252 SDK/protocol regression tests. The five
core implementation files reach 89.47% statements/lines and 82.01% branches;
the complete package/bundle/Worker/DTS build and 2/2 zero-provider manifest
eval also pass.

The 2026-07-18 adversarial concurrency follow-up closed two final runtime
classes without restoring a legacy surface. F270 now installs each Turn's
AbortController in the same atomic start commit, makes closed Actors inert for
mailbox send/receive, skips terminal executor no-op persistence, advertises
`actorControlPlane v1`, and returns explicit SDK-upgrade/daemon-restart errors
for incompatible peers. The full and fallback Worker prompts now begin with an
authoritative current total/active Actor-capacity contract before any spawn
wave is announced, and explicit Workflow intent now
recognizes the product word in English, Chinese, Japanese, and Korean without
guessing from complexity. F266 now uses cursor read-register-recheck,
cancellable subscription waiters, and owner-scoped initialization without a
principal-to-facade cache. PID-reuse stale-lock handling remains deliberately
fail-closed pending a portable process-start identity contract. A six-call
`zhipu/glm51` follow-up pilot distinguishes the repaired prompt: treatment
starts three Actors for a fresh five-track request while the historical
baseline starts five; this diagnostic re-pilot does not replace the original
authorized Layer 2/3 result.

The same release closure makes Runtime Auto Mode a real permission
owner rather than a prompt/config preference: an auto session reuses one LLM or
rules guardrail across turns, executes guardrail -> permission bridge -> tool,
and persists a fallback to rules. Classifier model/timeout are durable session
settings and daemon capabilities. The surrounding permission boundary now
keeps `gitRoot` as a safety boundary, resolves relative operands from the
validated execution directory, avoids quoted-source false paths, emits bounded
credential-redacted JSON previews, and omits `exit_plan_mode` when no host
approval callback exists. The final REPL follow-up scopes queued prompts to the
session-root Actor, preserves original history timestamps, and closes the bare
resume picker cleanly: list startup stays lightweight, selecting a session
hands stdin to the REPL, and Esc immediately returns the invoking shell.

Recent completion notes:

`267`, `268`, and `269` shipped together in `v0.7.69`. The release provides the
bounded A2A 1.0 JSON-RPC/SSE client/server edge, no-code Agent management and
serving, exact Agent/Skill-script admission, three split integration files with
migration and last-known-good hot reload, plus the authoritative shared Coder
daemon with atomic observation, durable operations, transport-safe interaction,
run-scoped credential/Host Tool bridges, recovery facts, and owner fencing.
Their release evidence is historical and no source or publication gate remains.

`260` completed for `v0.7.68`: the thin experimental Memory Agent SDK,
zero-wait scoped recall, deliberate read-only `memory_recall`, trace-only
decision receipts, bounded Outcome Digests/review inbox, consult-before-write
promotion, and cache-safe policy-versioned provider integration are complete.
The fresh `f260-v0.7.68.2` 520-call panel passed every preregistered gate; the
earlier v1 99%-for-all panel remains diagnostic only.
Post-review hardening for Issue 152 additionally removes credential-bearing Git
remote identity, closes Windows/interpreter mutation-guard gaps, serializes
review/proposal/lifecycle persistence, and makes eval provenance/cache handling
fail-loud without changing the frozen prompt, tool schema, or policy bytes.
The bundled `kodax_manual` now routes memory-capability questions to a dedicated
F228/F260 topic, covers every built-in slash command through a two-way drift
test, and points SDK readers at the Runtime and experimental-memory contracts.
The schema-v2 manifest remains available, but Windows temporary-directory
cleanup reclaimed the earlier 520-cell raw/review artifacts during the final
full-suite validation; a renewed raw-evidence audit therefore requires an
explicitly authorized bounded rerun rather than reconstruction.

`261` shipped in `v0.7.67`: bare `-r`
opens a searchable keyboard-driven picker with the full selected ID; explicit
resume is ID-first, then exact-title with duplicate disambiguation; session listing supports exact
surface filtering and opaque cursor continuation across Embedded/Daemon SDK
forms; ACP handshake-only sessions remain provisional; and strict cleanup is
preview-first plus reversible archive.

`258` shipped in `v0.7.67`: protocol-neutral
host-injected executors, the policy-filtered catalog, durable task ledger,
Worker/Workflow routing, Embedded/Daemon parity, public in-process Daemon
factory bootstrap, and Reference Executor conformance are all implemented.

`253-257` shipped together in `v0.7.66`: the embedded Runtime contract, host
migration/control plane, local daemon transport, context-budget/tool-exposure
planner + portable bridge, Worker-hosted Runtime, and constructed-handler Worker
fault isolation. The release audit closed the bridge permission eval drift and
fixed GitHub binary archive sidecar omission before tagging.

`251`（Tool-Output Token Efficiency）在 `v0.7.61` 首次引入 body-only 命令过滤；2026-07-14 一条真实 review 记录显示自动摘要后发生 1 次 raw artifact 恢复读取及其额外 tool-result 循环，因此否定了“透明事后有损压缩默认开启即可直接视为端到端收益”的假设，但不据此虚构恢复率或 token 百分比。同一记录中的格式命令重跑有独立的 `%` 转义失败原因，不归因于压缩。当前源码已纠偏为完整采集、严格更短的契约等价无损规范化、下一次物理请求的批次单一 capacity owner，以及仅在完整批次确实放不下时使用 `KODAX_RESULT_INCOMPLETE` + 完整 artifact。旧 32KB / 600 行不再是 token policy，512KiB 仅是 Bash memory→spool 阈值；compiled/declarative 有损 filter 默认关闭。这里记录的历史 compaction 结论仅描述 `v0.7.61`：大型压缩触发策略已由 `FEATURE_272` / `v0.7.74` 的始终开启、百分比/绝对值取最小值方案取代；FEATURE_251 的工具结果与 microcompaction 结论继续有效。`252`（Workflow Quality Preflight）当前收窄为纯确定性合约 lint：启动前对未 await 的 workflow-command 真值判断、schema 顶层字段误用、静态 agent fanout 超 manifest/host 上限做硬失败；review/verifier/通用质量启发式刻意不作为模型可见告警发出。二者均为确定性代码，无 prompt 改动、无 LLM eval。`v0.7.61` 同时修复一处 workflow 启动崩溃：`typescript` 提升为 `@kodax-ai/agent` 运行时依赖（quality lint 在热路径使用 TS 编译器 API）。

> `249` shipped 2026-07-03 (Option A): widened `buildWorkflowToolHost`
> (`tool-execution-context.ts`) from `!== 'amaw'` to `!== 'amaw' && !== 'ama'`, so AMA
> and AMAW both host `run_workflow` — AMA activates it on an explicit natural-language
> request (tool available, LLM-native), AMAW additionally on complexity (the FEATURE_248
> `ORCHESTRATION DEFAULT` directive, which stays strictly amaw-only via the independent
> `amawOrchestrationAvailable` gate — verified structurally separate). SA unchanged
> (fails gate + `SA_SOLO_EXCLUDE_TOOLS`). No prompt change (run_workflow's own description
> is the request-driven surface). cap-048 CAP-TOOL-CTX-009/010 updated; FEATURE_248
> role-prompt boundary tests green unchanged. The AMA-turn token cost of the resident
> run_workflow description was found to be a broader gap (the deferred-tool mechanism is
> SA-path-only) → filed as `250`. See docs/features/v0.7.60.md §FEATURE_249.

> `248` narrowed-SHIP 2026-07-03: AMAW-gated, mode-level `ORCHESTRATION DEFAULT`
> standing directive in the Worker system prompt (mirrors the ultracode mechanism),
> leak-closed via a new optional `ManagedRolePromptContext.amawOrchestrationAvailable`
> field. Layer-1 green (role-prompt.test.ts, 28 tests). Eval history: the old
> tool-level lever (A run_workflow desc + B' dispatch nudge) was eval-falsified and
> reverted; the mode-level directive floored 0% on a mid-task real-session replay, but
> a deep multi-agent investigation found that fixture tested the WRONG moment (mid-task
> defection, not the turn-0 decision ultracode actually applies). The turn-0 eval
> (`workflow-activation-turn0.eval.ts`, 4 aliases) then showed a real lift on the same
> a2aDesign task (mid-task 0% -> turn-0 baseline 8% -> proposed 33%, +25%) with models
> causally citing the directive ("按照编排默认原则... 让多个 agent 交叉验证"). A follow-up
> flow-fix (PLAN-TIME COMMITMENT: front-load the orchestrate-vs-solo call to turn-0 +
> make plan items = the agents/stages) then added a causally-confirmed increment on top
> of the ambient directive (turn-0 3-variant: +8~+17% on 3/4 shapes, zero regression;
> pulls review off the floor) and was merged into `orchestrationDefault`. Shipped with
> acceptance NARROWED to task-inception activation; mid-task re-architecture is a
> documented non-goal. Absolute activation is model-ceiling-limited on current
> coding-plan aliases. See docs/features/v0.7.59.md §6/§6.1.

---

## 计划中的 Feature

| ID | Title | Category | Priority | Planned | Design |
|---|---|---|---|---|---|
| `287` | Advisor Mode Virtual Provider | Enhancement / LLM Provider + Session Quality | High | `v0.8.13` | [v0.8.13](features/v0.8.13.md#feature_287-advisor-mode-virtual-provider) |
| `288` | CLI-Space Daemon Profile Alignment | Enhancement / Runtime + Multi-Client UX | High | `v0.8.14` | [v0.8.14](features/v0.8.14.md#feature_288-cli-space-daemon-profile-alignment) |
| `278` | Durable AskUser History Projection + Compact SDK/REPL Visualization | Enhancement / SDK + Session UX | High | `v0.8.10` | [v0.8.10](features/v0.8.10.md#feature_278-durable-askuser-history-projection--compact-sdkrepl-visualization) |
| `279` | Same-Runtime Root Task Messaging + Durable Safe-Boundary Inbox | Enhancement / Runtime + Agent Collaboration | High | `v0.8.10` | [v0.8.10](features/v0.8.10.md#feature_279-same-runtime-root-task-messaging--durable-safe-boundary-inbox) |
| `282` | Bounded Active Query Recovery + Durable Physical-Capacity Emergency Compaction | Core / Context Management + Reliability | Critical | `v0.8.10` | [v0.8.10](features/v0.8.10.md#feature_282-bounded-active-query-recovery--durable-physical-capacity-emergency-compaction) |
| `283` | Local Hybrid Session History Retrieval + Builtin Adaptive LLM Rerank | Enhancement / Session Retrieval + LLM | High | `v0.8.10` | [v0.8.10](features/v0.8.10.md#feature_283-local-hybrid-session-history-retrieval--builtin-adaptive-llm-rerank) |
| `285` | Capability-Aware Auto Classifier Model Selection | Enhancement / LLM Provider + Auto Permission Reliability | High | `v0.8.10` | [v0.8.10](features/v0.8.10.md#feature_285-capability-aware-auto-classifier-model-selection) |
| `280` | Cache-Stable Prompt and Tool Surface Optimization | Internal / LLM Cost + Tool Reliability | High | `v0.8.11` | [v0.8.11](features/v0.8.11.md#feature_280-cache-stable-prompt-and-tool-surface-optimization) |
| `265` | Work Fast Path + Coding Assurance Budget | Core / Performance + Agent Quality | High | `v0.8.15` | [v0.8.15](features/v0.8.15.md#feature_265-work-fast-path--coding-assurance-budget) |
| `105` | Mixture-of-Agents Virtual Provider (MoA mode, reuses F287 skeleton) | Core / LLM Provider + Test-Time Scaling | High | `v0.8.20` | [v0.8.20](features/v0.8.20.md#feature_105-mixture-of-agents-virtual-provider) |
| `007` | Theme System Consolidation | Enhancement | Medium | `v0.9.5` | [v0.9.5](features/v0.9.5.md#feature_007-theme-system-consolidation) |
| `030` | Multi-Surface Delivery | Enhancement | High | `v0.9.5` | [v0.9.5](features/v0.9.5.md#feature_030-multi-surface-delivery) |
| `093` | Coding and REPL Internal Circular Dependency Decoupling | Internal | Medium | `v0.9.5` | [v0.9.5](features/v0.9.5.md#feature_093-coding-and-repl-internal-circular-dependency-decoupling) |
| `113` | TodoList JSON / CLI Surface | Enhancement | Medium | `v0.9.7` | [v0.9.7](features/v0.9.7.md#feature_113-todolist-json--cli-surface) |
| `139` | NotebookEdit Tool | Enhancement / Tool | Low | `v0.9.25` | [v0.9.25](features/v0.9.25.md#feature_139-notebookedit-tool--jupyter-cell-level-crud) |
| `262` | npm 12 Install-Time Security + Trusted Publishing Migration | Internal / Supply Chain Security | High | `v0.9.0` | [v0.9.0](features/v0.9.0.md#feature_262-npm-12-install-time-security--trusted-publishing-migration) |

---

## 2026-07-12 Reviewed-Out Feature Records

| ID | Previous target | Decision | Design record |
|---|---|---|---|
| `244` | `v0.7.75` | Shelved; reopen only through F265's measured cold-module hot-path gate. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `231` | `v0.7.75` | Cross-process Workflow replay deferred out of active `v0.7.x`. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `235` | `v0.7.75` | Removed; current approval/save/revise lifecycle is sufficient without a Workflow Loop. | [v0.7.75](features/v0.7.75.md#2026-07-12-roadmap-review) |
| `238` | `v0.7.80` | Cancelled; Workflow remains execution-only, while Skills carry learned methods and Extensions remain explicitly authored. | [v0.7.80](features/v0.7.80.md#2026-07-12-roadmap-review) |
| `232` | `v0.7.85` | Removed as already absorbed by F246 pipeline + same-session reuse. | [v0.7.85](features/v0.7.85.md#2026-07-12-roadmap-review) |
| `108` | `v0.7.95` | Removed; local learning belongs in Skills/Extensions and global prompt work stays engineering-led. | [v0.7.95](features/v0.7.95.md#2026-07-12-roadmap-review) |

---

## 阅读说明

- `FEATURE_LIST.md` 是活跃索引，不再承载长篇立项正文。
- 每个活跃 feature 在本表只保留：ID、标题、类别、优先级、目标版本、设计入口。
- 活跃项必须有明确版本和设计入口；`TBD` / parking-lot / 用户需求未成熟的项不进主表。
- archive cutoff 之前的已完成、取消、吸收、搁置项归档到 [FEATURES_ARCHIVED.md](FEATURES_ARCHIVED.md)；cutoff 之后的近期完成项暂留本表以便发布审计。
- 新 feature 进入本表前，应先确认是否已有相同目标、是否可被现有 feature 吸收、是否需要单独设计文档。
- Feature 在实现与功能验收完成后、正式发布前移到“已完成 Feature”；版本是否发布由 Current released version、[CHANGELOG.md](../CHANGELOG.md)、Git tag、GitHub Release 与 npm 独立记录。越过 archive cutoff 后再归档。
- Emergency patch absorption: Session Scratch Directory / `KODAX_SESSION_TMP` is tracked as a `FEATURE_071` workspace-discipline extension, not as a new active feature ID. The patch gives each session a repo-local `.agent/tmp/sessions/<session-id>/` scratch path and keeps temporary helper files out of shared roots.

---

## 已完成 Feature

| ID | Title | Version | Design | Notes |
|---|---|---|---|---|
| `297` | Codex-Aligned Permission Profiles, Sandbox Escalation, and Exec Policy | `v0.7.96-alpha.4` candidate | [v0.7.96](features/v0.7.96.md#feature_297-codex-aligned-permission-profiles-sandbox-escalation-and-exec-policy) | Makes sandbox completion authoritative, moves Edits/Auto decisions to an exact host boundary, adds Full Access and JSONC Exec Policy, removes Auto[RULES]/envPass/global-Git blocking, and preserves a single no-replay host retry. |
| `295` | Separate Trusted Text Mutation from Native Shell Containment | `v0.7.96-alpha.1`; alpha.4 concurrency correction | [v0.7.96](features/v0.7.96.md#feature_295-separate-trusted-text-mutation-from-native-shell-containment) | Splits trusted text transactions from platform shell containment; Issue 326/ADR-070 removes command-lifetime/global admission locks, uses protocol 8 + setup generation 8, exact-object bounded ACL admission, independent command Jobs/pipes, bounded-idle exact-authority brokers, and a real dual-Runtime overlap gate. |
| `296` | Capacity-Debt Tool Result Admission and Bounded Context Recovery | `v0.7.96-alpha.1` | [v0.7.96](features/v0.7.96.md#feature_296-capacity-debt-tool-result-admission-and-bounded-context-recovery) | Replaces the local tool-result capacity hard gate with capacity-debt admission, a bounded recovery ladder, floor-bounded output reserve, paged oversized-input degradation, and `context_capacity` terminal classification (ADR-067). |
| `294` | Host Tools First-Class Visibility | `v0.7.89` | [v0.7.89](features/v0.7.89.md#feature_294--host-tools-first-class-visibility-2026-08-16) | Materializes leased Host Tools as run-scoped model tools, adds cache-stable host capability context, conservative plan-mode metadata, registry-first dispatch, revoke/collision hardening, and exact A2A `host:` authorization. |
| `293` | Resilient Zero-Service Web Search Fallback | `v0.7.89` | [v0.7.89](features/v0.7.89.md#feature_293-resilient-zero-service-web-search-fallback) | Adds the bounded DuckDuckGo HTML → Bing RSS → Bing HTML zero-service fallback, truthful failure diagnostics and freshness metadata, normalized deduplicated locators, isolated custom endpoints, and removal of the invalid `provider_id` contract. |
| `292` | Natural-Language-First Memory Management | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_292-natural-language-first-memory-management) | Makes ordinary remember, recall, correction, and forgetting conversational and immediate; reserves decisions for exceptional cases, keeps slash commands as an advanced escape hatch, and exposes the same governed operations through the experimental SDK. |
| `291` | Session-Scoped Runtime Event Journals | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_291-session-scoped-runtime-event-journals) | Replaces the Runtime-global event sequence lock with independent Session journals/cursors, scopes the breaking SDK replay API, negotiates the daemon contract, and binds each A2A Task to one Runtime Session. |
| `290` | Memory Lesson and Verdict Production + failedWithLesson Admission | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_290-memory-lesson-and-verdict-production--failedwithlesson-admission) | Ships the governed lesson/verdict production path, bounded review admission, and failedWithLesson safety gates with the accompanying human regression guide. |
| `289` | Memory Review Drain Reliability + Pipeline Observability | `v0.7.85` | [v0.7.85](features/v0.7.85.md#feature_289-memory-review-drain-reliability--pipeline-observability) | Ships bounded startup/turn-end review draining, observable pipeline health, backlog recovery, and the accompanying human regression guide. |
| `286` | Explicit Shell Environment Passthrough | `v0.7.79` (superseded by F297) | [v0.7.79](features/v0.7.79.md#feature_286-explicit-shell-environment-passthrough) | Historical exact-name passthrough design; F297 now inherits the host environment except fixed execution-control variables and treats `sandbox.envPass` as inert migration input. |
| `284` | Qwen 3.8 Max Token Plan Model Refresh | `v0.7.79` candidate | [v0.7.79](features/v0.7.79.md#feature_284-qwen-38-max-token-plan-model-refresh) | Makes `qwen3.8-max` the default production ID, retains Preview selection, and aligns Qwen 3.8 context/output/reasoning/image metadata. |
| `281` | Explicit A2A Network Authorization | `v0.7.79` candidate | [v0.7.79](features/v0.7.79.md#feature_281-explicit-a2a-network-authorization) | Adds independent persisted private-address and non-loopback plaintext-HTTP permissions across config, CLI discovery/call, Runtime reconciliation, registration fingerprints, and execution. Exact loopback HTTP remains implicit; all broader authority remains default deny. |
| `277` | Intent-Aligned Auto[LLM] Permissions and Optional ASRT Containment (superseded by FEATURE_297) | `v0.7.78` | [v0.7.78](features/v0.7.78.md#feature_277-intent-aligned-autollm-permissions-and-optional-asrt-containment) | Historical shipped behavior. FEATURE_297 replaces its permission-before-sandbox and Auto[RULES] fallback contracts with sandbox-first routing and host-boundary review. |
| `276` | Complete First-Run Setup and Split-Configuration Onboarding | `v0.7.78` | [v0.7.78](features/v0.7.78.md#feature_276-complete-first-run-setup-and-split-configuration-onboarding) | Shipped with create-only split configuration, shared writer fencing, built-process setup coverage, and sandbox preparation guidance. |
| `263` | Evidence-Gated Background Skill Learning Loop | `v0.7.78` | [v0.7.78](features/v0.7.78.md#feature_263-evidence-gated-background-skill-learning-loop) | Shipped with the explicitly authorized paid semantic evaluation recorded as version-level release evidence. |
| `275` | Governed Event-Triggered Memory Intervention | `v0.7.77` | [v0.7.77](features/v0.7.77.md#feature_275-governed-event-triggered-memory-intervention) | Sparse foreground intervention after tool failure, verification failure, or committed compaction; F228 remains the durable authority and semantic selection remains an explicit in-process host option. Frozen paid evaluation and blind review produced the joint `SHIP` decision. |
| `274` | Pattern-Aware Adaptive AMA and Sidecar Quality Alignment | `v0.7.77` | [v0.7.77](features/v0.7.77.md#feature_274-pattern-aware-adaptive-ama-and-sidecar-quality-alignment) | One shared six-pattern catalog, optional validated `quality_strategy`, bounded fact-only `PatternTrace`, and the existing Sidecar as sole terminal-answer adjudicator. Frozen Layer 2/3 evaluation and blind review produced the joint `SHIP` decision. |
| `273` | Mailbox-Driven Agent Wait + Telemetry/Control Separation | `v0.7.74` | [v0.7.74](features/v0.7.74.md#feature_273-mailbox-driven-agent-wait-and-telemetrycontrol-separation) | Model coordination waits only on scoped mailbox/user/interruption/timeout activity; progress remains SDK/UI telemetry. Safe-boundary synthetic delivery, post-transcript completion acknowledgement, explicit pending-delivery recovery, and child-turn queue deduplication provide one-shot completion evidence across restart. |
| `272` | Reliable Full-Coverage Context Compaction + Durable Exact-History Recovery | `v0.7.74` | [v0.7.74](features/v0.7.74.md#feature_272-reliable-full-coverage-context-compaction-and-sdk-observability) | Always-on minimum-threshold policy, effective-trigger tail protection, complete eligible-prefix transaction, exact user-query ledger, context-owned events, bounded transcript pages/chunks/search, and durable-before-evict exact history for root and isolated persistent child Sessions. |
| `271` | First-Run Provider Setup + Runtime Auto LLM Reliability Contract | `v0.7.73` | [v0.7.73](features/v0.7.73.md#feature_271-first-run-provider-setup-and-secure-restart-handoff) | Historical first-run and reliability base remains shipped; FEATURE_297 supersedes its configurable timeout/speculative-window and permission-ordering semantics with fixed 90/180 review and capability v5/settings v2. |
| `270` | Ultra-Aligned Adaptive Multi-Agent Actor Control Plane | `v0.7.72` | [v0.7.72](features/v0.7.72.md#feature_270-ultra-aligned-adaptive-multi-agent-actor-control-plane) | One Runtime-owned Actor/Turn tree and scheduler replaces the parallel child-task authorities; AMA gains bounded adaptive recursion, durable observation, safe follow-up/interruption, unified Workflow/external execution, and the canonical collaboration surface while AMAW retires. |
| `266` | Learning Center + Learned Capability Runtime Control Plane | `v0.7.72` | [v0.7.72](features/v0.7.72.md#feature_266-learning-center--learned-capability-runtime-control-plane) | Runtime-owned Learning Center, Learned Area lifecycle/events/cursors, lower-precedence learned Skills, governed actions, and inline/Worker/daemon SDK plus REPL parity. |
| `269` | Shared Daemon Multi-Client Consistency + Secure Host Bridges | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_269-shared-daemon-multi-client-consistency--secure-host-bridges) | Authoritative shared Coder daemon observation/resync, durable operations, transport-safe AskUser/permissions, run-scoped credential and Host Tool bridges, recovery facts, and daemon/inline owner fencing. |
| `268` | Hot-Reloadable Integration Configuration Split | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_268-hot-reloadable-integration-configuration-split) | Base split/template/migration/hot-reload scope shipped in v0.7.69; the v0.7.71 closure adds source-owned, fail-closed per-Agent hot `enabled` reconciliation without peer rediscovery. |
| `267` | Bidirectional A2A Client Executor + KodaX Agent Server | `v0.7.69` | [v0.7.69](features/v0.7.69.md#feature_267-bidirectional-a2a-client-executor--kodax-agent-server) | Bounded A2A 1.0 client/server base shipped in v0.7.69; the v0.7.71 closure adds external-issuer OAuth Client Credentials/JWT Resource Server profiles and activation hardening alongside trusted Agent/Skill/tool admission, durable tasks, and explicit artifact publication. |
| `260` | KodaX Memory Agent — Proactive Execution Recall + Scoped Memory Consolidation | `v0.7.68` | [v0.7.68](features/v0.7.68.md#feature_260-kodax-memory-agent--proactive-execution-recall--scoped-memory-consolidation) | Thin experimental agent-layer Memory Agent over F228; exact scoped zero-wait recall, deliberate read-only query, trace-only decision receipts, bounded outcome/review lifecycle, consult-before-write promotion, policy-versioned cache-safe integration, deterministic safety gates, and passing v2 routing eval. |
| `261` | Searchable Session Resume TUI + Session Listing Pagination | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_261-searchable-session-resume-tui--session-listing-pagination) | Bare `-r` searchable/paged keyboard picker with full selected ID, deterministic ID-first/exact-title resume and duplicate disambiguation, meaningful ACP titles, Embedded/Daemon `surface` + cursor listing, zero-message suppression, isolated ACP tests, and preview-first reversible ACP pollution cleanup. |
| `259` | Cost-Disciplined Agent Build Loop + Review Handoff Optimization | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_259-cost-disciplined-agent-build-loop--review-handoff-optimization) | Layer 1 complete; Layer 2 shows material semantic value with no regression after retiring official Kimi; bounded Layer 3 passes 8/8 proposed vs 6/8 baseline, reduces total tokens 16.9%, standard-review median tokens 57.2%, primary starts 75%, and duplicate packet reads 83.3%. Main-session recommendation: `recommend-ship`. |
| `258` | External Agent Executor Plane + Dispatchable Agent Catalog | `v0.7.67` | [v0.7.67](features/v0.7.67.md#feature_258-external-agent-executor-plane--dispatchable-agent-catalog) | Protocol-neutral host-injected executor plane, redacted/policy-filtered catalog, durable task ledger, Worker and Workflow routing, Embedded/Daemon parity, public in-process Daemon factory bootstrap, Reference Executor, and security/recovery conformance. |
| `257` | Constructed Handler Worker Fault Isolation | `v0.7.66` | [v0.7.72](features/v0.7.72.md#feature_257-constructed-handler-worker-fault-isolation) | Delivered ahead of the original v0.7.72 slot. Constructed JavaScript handlers run in persistent per-handler Workers, use reverse host tool RPC, hard-terminate CPU loops, and cannot resurrect active/queued work after revoke. |
| `256` | Worker-Hosted Embedded Runtime + Hard Disposal | `v0.7.66` | [v0.7.71](features/v0.7.71.md#feature_256-worker-hosted-embedded-runtime--hard-disposal) | Delivered ahead of the original v0.7.71 slot. Adds optional embedded Worker ownership, MessagePort protocol reuse, hard-dispose capability negotiation, DTO-only transport, and release sidecar packaging. |
| `255` | KodaX Runtime Daemon + Local Transport | `v0.7.66` | [v0.7.66](features/v0.7.66.md#feature_255-kodax-runtime-daemon--local-transport) | Local named-pipe/Unix-socket daemon, detached ownership, multi-client sessions/runs/events/permissions/config/catalog/artifact/diagnostic services, schema-validated protocol, and CLI/SDK host parity. |
| `254` | Runtime Host Migration + Control Plane Hardening | `v0.7.66` | [v0.7.65](features/v0.7.65.md#feature_254-runtime-host-migration--control-plane-hardening) | Host/runtime consolidation plus context budgets, small-window tool exposure planning, `tool_search` / `tool_describe` / `tool_call` reachability, target-only permission checks, result budgets, compaction pressure, and deterministic 6/6 exposure evals. |
| `253` | KodaX Runtime Contract + Embedded Runtime API | `v0.7.66` | [v0.7.64](features/v0.7.64.md#feature_253-kodax-runtime-contract--embedded-runtime-api) | Embedded Runtime sessions/runs/events/permissions/workflows facade and public `/runtime` subpath, developed in the v0.7.64 slot and released in the combined v0.7.66 cut. |
| `228` | Unified Memory Control Plane + Memory Governance | `v0.7.62` | [v0.7.62](features/v0.7.62.md#feature_228-unified-memory-control-plane--memory-governance) | Released in `v0.7.62` (2026-07-06). Reuses the F224 learning proposal store for memory handoffs, adds agent-layer typed memory refs/snapshots/previews, fingerprint-guarded approval writes, thin `/memory` REPL commands, deterministic task-aware memory packs, bounded prompt memory-index injection, governance/curator reports with a 200-report cap, feedback-triggered review contracts, and host trace metadata for selected memory refs. No vector DB, embeddings, or second memory database. |
| `252` | Workflow Quality Preflight + Review/Audit Verification Lints | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_252-workflow-quality-preflight--reviewaudit-verification-lints) | Released in `v0.7.61` (2026-07-06). Phase A (deterministic contract lint only): `quality-lint.ts` (`lintRestrictedWorkflowSource` / `assertRestrictedWorkflowQuality`) runs in restricted workflow module materialization + the coding host with host `maxAgents`, hard-failing three contract classes before a run starts — unawaited workflow-command variable in a boolean position (no Proxy trap for object truthiness), top-level structured-output field access that belongs under `result.structured`, and literal `[...]`/`.map()` agent fanout above manifest/host caps. Review/verifier/generic quality heuristics intentionally NOT emitted as model-visible warnings (false-positive review narrowed the feature). Layer 2 strengthens review/audit templates to make verifier stages explicit. Layer 3 (gated strong-tier LLM reviewer) deferred behind future policy/eval. Deterministic — no LLM eval. |
| `251` | Tool-Output Token Efficiency（rtk 参考，2026-07-14 纠偏） | `v0.7.61` | [v0.7.61](features/v0.7.61.md#feature_251-tool-output-semantic-compression-rtk-style-token-killer) | Original command-aware body compression released in `v0.7.61` (2026-07-06); corrected after one replay showed an automatic lossy summary followed by one attributable raw recovery read/additional tool-result cycle (a separate format-command rerun had its own escaping failure; no unsupported population/token percentages are claimed). Authoritative tool behavior: collect full output; apply only contract-equivalent normalization when strictly shorter; keep compiled/declarative lossy filters off by default; use zero semantic adapters for compound Bash; decide once for the complete parallel-result batch using the largest final input `Pmax` satisfying `Pmax + provider output reserve + max(2048, ceil(Pmax * 3%)) <= contextWindow`, then admit at most `Pmax - current physical input`; return all results verbatim when they fit, otherwise persist full content once and emit an idempotent `KODAX_RESULT_INCOMPLETE` continuation. Its historical capacity-only large-compaction trigger is superseded by FEATURE_272/v0.7.74; the tool-result and microcompaction rules remain current. 32KB/600 lines are not token policy; 512KiB is only memory→spool. rtk informs request shaping/command awareness, not transparent lossy post-processing. |
| `250` | Progressive Disclosure for the AMA/AMAW Managed Tool Path | `v0.7.60` | [v0.7.60](features/v0.7.60.md#feature_250-progressive-disclosure-for-the-amaamaw-managed-tool-path) | Released in `v0.7.60` (2026-07-04). The original managed-path release hint-swapped 13 non-mcp tools (repo-intel + web/code + goal) with unchanged schemas. **v0.7.74 correction:** `get_goal` / `create_goal` / `update_goal` now stay resident with full lifecycle contracts on SA and AMA; the former hints saved only about 109 estimated tokens in total and made `get_goal` 12 tokens larger. The deferred set is otherwise unchanged and now contains exactly 11 tools (6 repo-intel + 4 web/code + `run_workflow`); `mcp_*` remain resident. No handler, permission, Goal-state, or compaction-protection behavior changed, and `tool_search` plus Goal receipts remain protected in `PRUNE_PROTECTED_TOOLS`. |
| `249` | AMA Natural-Language Workflow Activation | `v0.7.59` | [v0.7.60](features/v0.7.60.md#feature_249-ama-natural-language-workflow-activation) | Released in `v0.7.59` (2026-07-03). Widened `buildWorkflowToolHost` so AMA also hosts `run_workflow` on an explicit natural-language request; AMAW additionally self-activates on complexity via the FEATURE_248 directive (independent `amawOrchestrationAvailable` gate, verified structurally separate). SA unchanged. Design doc filed under v0.7.60; shipped early in the v0.7.59 rollup. |
| `248` | AMAW Mode-Level Orchestration Directive | `v0.7.59` | [v0.7.59](features/v0.7.59.md#feature_248-amaw-mode-level-orchestration-directive) | Released in `v0.7.59` (2026-07-03). AMAW-gated mode-level `ORCHESTRATION DEFAULT` standing directive + PLAN-TIME COMMITMENT flow-fix (prompt-only, narrowed-SHIP: task-inception activation; mid-task re-architecture a documented non-goal). Leak-closed via optional `ManagedRolePromptContext.amawOrchestrationAvailable`. See v0.7.59.md §6/§6.1. |
| `247` | SDK Agent-Profile Surface (KodaX-Space Partner) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_247-sdk-agent-profile-surface-kodax-space-partner) | Released in `v0.7.58` (2026-07-02). Profile-gated `KodaXAgentProfile` (R1–R9): identity/instruction injection, tool-visibility policy, Sidecar Verifier binding + verdict attribution, `onEffectiveConfig` snapshot, structured profile/runtime metadata across `fork()`, imperative `compactSession()`, session/profile/toolCall attribution, and a `reads-network` side-effect class. Default Coding Agent byte-identical when no profile is set. Built on the concurrent `feature/partner-sdk-support` branch. |
| `246` | Claude-Code-Parity Workflow (inline authoring + structured output + streaming pipeline + same-session resume; absorbs `232`, parity subset of `231`) | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_246-claude-code-parity-workflow--inline-authoring--structured-output--streaming-pipeline--same-session-resume) | Released in `v0.7.58` (2026-07-02). Model-callable `run_workflow` inline authoring (scout-then-author; `sideQuery` generator demoted to headless/SA fallback), structured child output via `outputSchema`, no-barrier `wf.pipeline`, same-session resume via `resumeFromRunId` (content-addressed result cache; `Date.now`/`Math.random` now throw in-sandbox), nested `wf.workflow`, per-agent phase + per-child effort, `/workflow` command intelligence, and mode-distinct SA/AMA/AMAW activation. ADR-044/046/047/048. Neutral run-lifecycle manager lifted to `@kodax-ai/agent`. |
| `245` | Workflow Generation Robustness + Runtime Partial-Result Salvage | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_245-workflow-generation-robustness--runtime-partial-result-salvage) | Released in `v0.7.58` (2026-07-02). Generation-time: static literal-taskId rejection, smoke asserts taskId/evidenceRefs identity, adversarial smoke, taskId randomization, and repair hardening. Runtime: mid-run failures surface completed-child outputs instead of a bare failure. Cross-process replay was once deferred to F231 and was removed from active v0.7.x by the 2026-07-12 review. |
| `221` | White-Labelable Self-Knowledge Manual | `v0.7.58` | [v0.7.58](features/v0.7.58.md#feature_221-white-labelable-self-knowledge-manual) | Released in `v0.7.58` (2026-07-02). `selfManual.baseTopics` (seed all/none/subset) + `KODAX_UNDERLYING_CAPABILITY_TOPICS` + `MANUAL_REGISTRY` export; `kodax_manual` tool description + self-knowledge routing rule re-branded from `selfManual.productName` (config-path clauses gated to the default product). Extends FEATURE_218; default output byte-identical. |
| `243` | Built-in Repository Intelligence + Codebase Mastery Parity | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_243-built-in-repository-intelligence--codebase-mastery-parity) | Released v0.7.57 (2026-06-28). Replaces external Repointel runtime with built-in full/light repo-intelligence, semantic worker sidecar, `relationship_scan`, repo-explorer agent, and `/repo-intel` controls. |
| `242` | Lean Review + Project Instructions Bootstrap | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_242-lean-review--project-instructions-bootstrap) | Released v0.7.57 (2026-06-28). Adds lean review command path and project instruction bootstrap updates for the current Worker + Sidecar architecture. |
| `241` | SDK Timeout Control Surface | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_241-sdk-timeout-control-surface) | Released v0.7.57 (2026-06-28). Adds seconds-based SDK timeout config; LLM request timeout normalization lives in `@kodax-ai/llm`, with coding adapting it to provider resilience. |
| `233` | Effort-First Reasoning Control System | `v0.7.57` | [v0.7.57](features/v0.7.57.md#feature_233-effort-first-reasoning-control-system) | Released v0.7.57 (2026-06-28). Makes `effort` the primary reasoning control, keeps legacy `reasoningMode`/`--reasoning` as compatibility input, adds `zai-coding`, and documents LLM-layer passive effort learning semantics with the agent-layer default capability cache. |
| `240` | Cross-Protocol `stopReason` Normalization + Terminal Semantics Dispatch | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_240-cross-protocol-stopreason-normalization--terminal-semantics-dispatch) | Implemented 2026-06-24. Adds provider-neutral stop-reason classifier in `@kodax-ai/llm`, wires max-token and managed-protocol gates through it, and gives `pause_turn`, refusal/content-filter, and unknown values explicit terminal handling. |
| `239` | SDK Multimodal Input + Clipboard Image Public API | `v0.7.56` | [v0.7.56](features/v0.7.56.md#feature_239-sdk-multimodal-input--clipboard-image-public-api) | Implemented 2026-06-24; expanded 2026-06-25 for Space and relayered in v0.7.57. Adds `@kodax-ai/kodax/media`, canonical `@kodax-ai/agent/media`, `@kodax-ai/coding/media` compatibility re-exports, shared image clipboard/normalization/persistence helpers, stable image/file/video input artifact contracts, model-level input capabilities, runtime artifact validation, GIF boundary docs, and queued follow-up artifacts. |
| `224` | Self-Improvement Skill Loop (procedural learning triage + SkillCurator v1) | `v0.7.54` | [v0.7.54](features/v0.7.54.md#feature_224-self-improvement-skill-loop) | Released v0.7.54 (2026-06-23). Turn-level learning triage → durable proposal store + usage/trust ledgers → governed, snapshot-safe skill apply via `/learn` (`pending`/`diff`/`approve [--ack-impact]`/`reject`). Approve-apply orchestration exposed from `@kodax-ai/agent` as `approveStoredLearningProposal`. Shipped alongside session recovery, extension discovery + runtime composition, ACP capability multiplexing, and a GLM model refresh. |
| `174` | `kodax sessions dedupe` | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_174-kodax-sessions-dedupe) | Released v0.7.53 (npm + tag + GitHub Release, 2026-06-19). Dry-run-first ghost-session cleanup; only uniquely-matched `runner-*` ghosts move to a reversible `.dedupe-archive`. |
| `211` | Interactive-Mode Extension/MCP Session State Cross-Resume Persistence | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_211-interactive-mode-extensionmcp-session-state-cross-resume-persistence) | Released v0.7.53 (2026-06-19). Runtime extension state snapshotted back to the REPL host and restored across `-r` / `-c`; preserves the FEATURE_173 single-writer invariant. |
| `237` | Todo-drift nudge (warn-only unclaimed-work reminder) | `v0.7.53` | [v0.7.53](features/v0.7.53.md#feature_237-todo-drift-nudge-warn-only-unclaimed-work-reminder) | Released v0.7.53 (2026-06-19). Warn-only observer arms a one-shot `<system-reminder>` + `onTodoDriftWarning` telemetry when work starts with pending-but-unclaimed todos; paired prompt eval. |
| `236` | Workflow Inline Skill Reference Propagation | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_236-workflow-inline-skill-reference-propagation) | Released v0.7.51 (2026-06-17). Workflow generator expands inline `/skill:<name>` and known bare slash skill references before harness generation; child briefings fail closed to the `skill` tool for unexpanded references. |
| `234` | Workflow Run Host Attribution (`hostMetadata`) | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_234-workflow-run-host-attribution-hostmetadata) | Released v0.7.51 (2026-06-17). Additive `hostMetadata?: Record<string,string>` on workflow snapshot/options; eval non-trigger. |
| `230` | Durable TUI Tool Transcript Replay | `v0.7.51` | [v0.7.51](features/v0.7.51.md#feature_230-durable-tui-tool-transcript-replay) | Released v0.7.51 (2026-06-17). Terminal `tool_group` replay cache + message-derived fallback + SDK transcript contract. |
| `229` | Workflow Process Events + SDK/System Progress Surface | `v0.7.50` | [v0.7.50](features/v0.7.50.md#feature_229-workflow-process-events--sdksystem-progress-surface) | Released v0.7.50 (npm + tag + GitHub Release, 2026-06-17). |

---

## 相关文档入口

- [Product Requirements](PRD.md)
- [Architecture Decision Records](ADR.md)
- [High-Level Design](HLD.md)
- [Detailed Design](DD.md)
- [Archived Features](FEATURES_ARCHIVED.md)
- [Known Issues](KNOWN_ISSUES.md)

---

## 2026-08-08 v0.7.89+ Roadmap Slide to 0.8.x / 0.9.x

At explicit user direction, every planned `v0.7.x` feature at `v0.7.89` and later
moves out of `0.7.x` into `0.8.x`, and the original `0.8.x` features slide to `0.9.x`.
`v0.7.90`-`v0.7.105` return to debug/patch slots; Issue 256 (v0.7.85 bug fix) and
FEATURE_289 (v0.7.85) are below the cutoff and are unchanged. FEATURE_262 (v0.9.0)
is also unchanged.

- `FEATURE_278`, `FEATURE_279`, `FEATURE_282`, `FEATURE_283`, `FEATURE_285`:
  `v0.7.90` -> `v0.8.0`.
- `FEATURE_280`: `v0.7.91` -> `v0.8.1`.
- `FEATURE_287`: `v0.7.93` -> `v0.8.3`.
- `FEATURE_288`: `v0.7.94` -> `v0.8.4`.
- `FEATURE_265`: `v0.7.95` -> `v0.8.5`.
- `FEATURE_105`: `v0.7.100` -> `v0.8.10`.
- `FEATURE_225` (InProgress): `v0.7.105` -> `v0.8.15`.
- `FEATURE_007`, `FEATURE_030`, `FEATURE_093`: `v0.8.5` -> `v0.9.5`.
- `FEATURE_113`: `v0.8.7` -> `v0.9.7`.
- `FEATURE_139`: `v0.8.25` -> `v0.9.25`.

Design documents relocated to their new version homes
(`docs/features/v0.8.x.md`, `v0.9.x.md`) with updated Status/Target fields; the prior
version files retain their headers and historical content with a relocation pointer.
The `v0.8.5.md` vision document (F007/030/093) slid wholesale to `v0.9.5.md`; the
`v0.8.5.md` filename became the FEATURE_265 home in that 2026-08-08 slide (and
the later 2026-08-20 +10 slide moved that home to `v0.8.15.md`). Displaced tombstones (`v0.9.5`
archived staging, `v0.8.15` cancelled FEATURE_125 design) were preserved verbatim in
`FEATURES_ARCHIVED.md`.

## 2026-08-16: FEATURE_294 — Host Tools first-class visibility

- Status: Implemented (released in `v0.7.89`)
- Design: [v0.7.89.md](features/v0.7.89.md)
- Summary: run-bound host tools materialize into the agent tool table as
  run-scoped definitions (never in `TOOL_REGISTRY`), the cached capability
  catalog gains a `## Host Capability Provider (run-bound)` line with a
  content-hash revision, lease revoke removes the surface fail-closed,
  bindings with colliding names are rejected up front, and A2A can
  authorize `host:` capability ids. Capability `runBoundHostTools` bumps
  to `2` (`materializedAgentTools`).

## 2026-08-20 v0.8.x +10 Slot Slide

At explicit user direction, every `0.8.x` version slot from `v0.8.0` onward
slides 10 minor slots later. `0.9.x` targets are unchanged.

- `FEATURE_278` / `FEATURE_279` / `FEATURE_282` / `FEATURE_283` / `FEATURE_285`:
  `v0.8.0` -> `v0.8.10`.
- `FEATURE_280`: `v0.8.1` -> `v0.8.11`.
- `FEATURE_287`: `v0.8.3` -> `v0.8.13`.
- `FEATURE_288`: `v0.8.4` -> `v0.8.14`.
- `FEATURE_265`: `v0.8.5` -> `v0.8.15`.
- `FEATURE_105`: `v0.8.10` -> `v0.8.20`.
- `FEATURE_225` (InProgress): `v0.8.15` -> `v0.8.25`.

Design documents were renamed with updated headers and Target fields. The two
relocation tombstones slid with their slots (`v0.8.7` -> `v0.8.17`,
`v0.8.25` -> `v0.8.35`) and remain free slots. Vacated `0.8.x` numbers
(`v0.8.0`-`v0.8.9`, `v0.8.12`, `v0.8.16`-`v0.8.19`, `v0.8.21`-`v0.8.24`,
`v0.8.26`-`v0.8.34`) return to free debug/patch capacity. A pre-existing
control-character defect in the old `v0.8.5.md` Version header was repaired
during the rename.
