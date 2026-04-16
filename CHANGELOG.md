# Changelog

All notable changes to this project will be documented in this file.

> Full history for versions prior to v0.7.0: [CHANGELOG_ARCHIVE.md](docs/CHANGELOG_ARCHIVE.md)

## [Unreleased]

<!-- last-sync: HEAD -->

---

## [0.7.19] - 2026-04-16

### Added
- **AMA Scout simplification**: Optional managed protocol and scope reflection for Scout role
- **Session lineage enhancements**: Extended session lineage types and tree visualization support
- **Storage improvements**: Expanded interactive storage test coverage and session tree integration

### Fixed
- **H0 completion signal**: Preserve explicit H0 completion signal and ensure failed H0 has task state
- **REPL session handling**: InkREPL session state and storage edge case fixes

---

## [0.7.18] - 2026-04-16
### Added
- **FEATURE_064 — Multi-Provider Cost Observatory**: Session cost tracking with `recordUsage()` after each LLM call; `/cost` command shows per-provider and per-role cost breakdown; built-in rate table for 11 providers
- **FEATURE_065 — MCP OAuth wiring**: OAuth 2.0 + PKCE token acquisition wired into MCP runtime `doConnect()`; cached token reuse and refresh; Authorization header injection for authenticated MCP servers
- **FEATURE_066 — Permission Hardening**: Bash command risk classifier (safe/normal/dangerous) wired into InkREPL `beforeToolExecute`; dangerous commands always require confirmation; session-scoped denial tracker prevents repeated prompts
- **FEATURE_067 — Child Agent Execution**: `dispatch-child-tasks` tool with read-only and write fan-out; child-executor with structured briefing, semaphore-based parallelism, abort propagation, and evaluator-assisted merge
- **FEATURE_068 — Worktree Isolation Tool**: `worktree_create` / `worktree_remove` tools with path traversal guard and safety checks
- **FEATURE_069 — Session Rewind & Shell Completion**: `/rewind [entry-id|label]` command for in-place session truncation; `kodax completion bash/zsh/fish` CLI subcommand
- **FEATURE_070 — Context Engine V2**: Microcompaction integration in agent loop; bash-intent extraction for smarter placeholders; user message protection in compression; analysis scratchpad in summary generator; post-compact artifact ledger injection + file content re-injection (top-N modified files); circuit breaker + graceful degradation for compaction failures
- **FEATURE_071 — AMA Managed Task Resilience**: Worker checkpoint persistence after each AMA phase; `findValidCheckpoint()` with 1h TTL + git commit validation; `resumeManagedTask()` for mid-execution recovery
- **Extension API helpers**: `api.exec()` for sandboxed shell command execution (env whitelist, timeout); `api.webhook()` for HTTP webhook with timeout support

### Changed
- **FEATURE_063 — Hook system cancelled**: Standalone hook system (`packages/coding/src/hooks/`) removed (~600 lines); executor capabilities extracted to Extension API helpers (`api.exec()` / `api.webhook()`); Extension system is the single extensibility mechanism
- **FEATURE_064 — Status bar cost display descoped**: Cost information available only via `/cost` command, not in status bar

### Fixed
- **Provider resilience**: Backoff improvements, Retry-After header support, ECONNRESET handling, context overflow recovery
- **Ask-user**: Scroll window, index mapping, multi-question support; ESC cancellation propagation (issue #114)
- **Tool group refs**: Preserved on ledger kind switch (issue #115)
- **AMA H0**: Continuation path truthy bug + validation conflict fix
- **Thinking blocks**: Preserved for Kimi compatibility
- **Stream resilience**: Stale-round guard (issue #116)
- **Security**: Worktree path traversal guard; hooks/OAuth/Docker hardening; denial-tracker TTL

---

## [0.7.17] - 2026-04-12
### Added
- **MCP fallback whitelist**: Fallback whitelist, dispose/resetTransport split, documentation for #108-#111
- **Session history seed conversion**: Tool summary display improvements and v0.7.35 feature docs
- **Lightweight i18n framework**: Internationalization framework for UI strings with English and Chinese support (en/zh)
- **End-turn fallback auto-continuation**: Managed protocol end_turn fallback auto-continuation and v0.7.35 Engineering Shell Maturity planning

### Fixed
- Classify 'aborted' errors as retryable `connection_failure`, simplify transient error hint

---

## [0.7.16] - 2026-04-11

### Added
- **FEATURE_061 Phase 2 — Scout direct completion**: Scout now completes H0 tasks end-to-end as both judge and executor, eliminating the scout-then-hand-off round-trip
- **FEATURE_061 Phase 3 — Context continuation across role upgrades**: Scout→Generator (H1) and Scout→Planner (H2) preserve session context, eliminating cold-start context breaks
- **FEATURE_061 Phase 4 — Role-level subagent capability**: Every core role (Scout/Planner/Generator/Evaluator) can spawn subagents for parallel work via `runOrchestration`
- **FEATURE_062 — Managed task budget simplification**: Immutable budget model with 2 fields + 4 functions replaces 10 fields + 14 functions; convergence signal inline in `buildWorkerRunOptions`
- **MCP transport module**: New `transport.ts` for improved MCP provider capability

### Changed
- **FEATURE_061 Phase 1 — Pre-Scout routing layers removed**: No more LLM routing call, harness guardrails, or Scout bypass before Scout entry; Intent Gate goes straight to Scout
- **Reasoning pipeline trimmed**: `createReasoningPlan` uses heuristic-only routing; `routeTaskWithLLM` dead-coded (FEATURE_061 Phase 1)
- **Harness guardrail system simplified**: `applyManagedHarnessGuardrailsToPlan` passes review context without forcing harness floors (FEATURE_061 Phase 1)
- **Task engine simplified**: ~3200 net lines removed from `task-engine.ts` — tactical flows, budget zones, and pre-Scout bypass paths consolidated
- **REPL commands updated**: Command types and interactive commands adapted for simplified AMA flow
- **Status bar and UI surfaces updated**: Status bar, shortcuts, surface status adapted for Scout-first architecture
- **Clipboard utility hardened**: Improved clipboard handling with expanded test coverage
- **Provider resilience expanded**: Error classification and resilience tests updated for broader transient pattern coverage
- **ACP server updated**: ACP server and CLI option helpers updated for Scout-first routing

### Removed
- `shouldBypassScoutForManagedH0` and Scout bypass path — all AMA tasks now go through Scout (FEATURE_061 Phase 1)
- `resolveManagedHarnessGuardrail` and pre-Scout harness floor enforcement (FEATURE_061 Phase 1)
- 3 Tactical Flow variants (`runTacticalReviewFlow`, `runTacticalInvestigationFlow`, `runTacticalLookupFlow`) — replaced by role-level subagent capability (FEATURE_061 Phase 4)
- Budget zone functions (`resolveBudgetZone`, `resolveWorkerIterLimits`, `formatBudgetAdvisory`, reserve logic) — replaced by simple cap/used model (FEATURE_062)
- ~3200 net lines removed across task-engine, reasoning, and related modules

---

## [0.7.15] - 2026-04-10

### Added
- **Fullscreen transcript surface rewrite**: Local renderer replaces Ink substrate for fullscreen REPL — vendored renderer, localized terminal hooks, renderer-native transcript interaction, and explicit transcript mode replacing implicit review mode
- **REPL cockpit substrate**: New prompt input controller with deep keyboard routing, footer surfaces for help/notices/queued state, transcript-native tool explanations, and owned TUI compatibility layer
- **Feature 045 provider-resilience**: Stream resilience across all provider layers with expanded transient error detection, Scout H0 tool policy fix, and prompt waiting/busy terminal state clarification
- **AMA tactical fan-out**: Investigation fan-out slice, lookup triage, and generalized reduction for AMA tactical planning; centralized branch lifecycle in scheduler; child-fanout restricted to runtime-backed review validation
- **Harness calibration and persistence**: Harness calibration corpus and checkpoint profiling, pivot persistence substrate, and workspace runtime truth (Feature 053)
- **Durable memory anchors**: First-class retrieval substrate with durable memory anchors, sectionized prompt assembly with prompt snapshot contracts
- **Multimodal artifact input substrate**: Align multimodal prompt artifact transport for rich content flows
- **Official sandbox extension substrate**: New sandbox extension package foundation
- **Incremental repo intelligence refresh**: Incremental update support for repo intelligence artifacts
- **Feature 055 REPL hardening**: REPL substrate hardening with bracketed paste protocol (replacing timing-based detection), busy prompt shell virtualization, and graceful exit flow serialization
- **Renderer viewport truth alignment**: Transcript scroll now uses renderer-accurate viewport geometry

### Changed
- **Fullscreen REPL localized from Ink**: Renderer internals, core engine shell, root primitives, input parsing, and terminal runtime hooks all localized; Ink substrate fully isolated
- **Transcript surface refactored**: Transcript body/footer separated, search moved into transcript footer, windowing moved into scrollbox, surface lifecycle finalized
- **Prompt shell split from transcript shell**: Separate prompt shell policy with hardened exit flow and interactive exit lifecycle cleanup
- **Repointel skill reorganized**: Follows Claude Code Skills spec; host integration refactored
- **Legacy project shell retired**: Removed from REPL surface
- **Prompt sectionization**: Prompt assembly sectionized with snapshot contracts for reproducibility

### Fixed
- Fullscreen banner moved into transcript history for correct ordering
- MCP typing and transcript chrome behavior stabilized
- Transcript selection rooted in rendered geometry
- Prompt streaming feedback simplified
- Native transcript browser controls, footer separators, and mouse selection restored
- Native clipboard preferred on local terminals
- Transcript viewport budget aligned; spinner liveness restored
- Transcript compact output truncation fixed
- REPL status colors and banner logo restored after regression
- Message list hook order regressions fixed
- Prompt editing shortcuts exposed in help and registry
- Transcript search anchoring and keyboard routing tightened
- Docs-only technical docs kept out of H2 reasoning path
- Pruning gap ratio added to prevent repeated shallow compaction
- Wheel history and banner unsticking on risky hosts

---

## [0.7.14] - 2026-04-02

### Added
- **Repo-intelligence dirty snapshot strategy and inventory tracking**: Dirty snapshot support for memoized reuse across requests, baseline/inventory files for clean git baseline tracking, file analysis index and dirty source hint caching

### Changed
- Bump repo-intelligence schema versions (index: 1→3, query: 2→9)
- Sort dependencies alphabetically in package.json

---

## [0.7.13] - 2026-03-31

### Added
- **FEATURE_045: Provider Stream Resilience and Graceful Recovery**: Comprehensive stream resilience improvements across all provider layers — expanded transient error detection with 21 message patterns, retry delay interruptible via AbortSignal, enhanced streaming robustness for Anthropic/OpenAI/custom providers
- **User-Agent compatibility mode**: New `userAgentMode` config field (`compat`/`sdk`) on custom and built-in providers to control User-Agent header for gateway compatibility
- **Shell environment hydration**: Resolve API keys and PATH from login shell profiles (bash/zsh/fish) when not available in the current process environment; null-delimited parsing with sentinel-based extraction
- **Multi-tool call tracking**: Refactored single `activeToolCall` into array-based `activeToolCalls` for concurrent tool call tracking in the UI layer
- **Tool confirmation module**: Extracted `buildToolConfirmationPrompt` into dedicated `tool-confirmation.ts` with network/delete command detection
- **Managed task live status label**: New `formatManagedTaskLiveStatusLabel` for phase-aware status rendering with worker prefix trimming
- **`onToolInputDelta` metadata**: Stream callback now receives optional `toolId` for multi-tool correlation
- **New types**: `KodaXProviderUserAgentMode`, `ShellEnvRunner` utility type
- **New tests**: Stream resilience (40+ lines), reasoning (75+ lines), task engine (470+ lines), error classification (25+ lines), retry handler (26+ lines), custom providers (104+ lines), InkREPL managed transcript (17+ lines), live streaming (43+ lines), transcript layout (81+ lines), CLI option helpers (47+ lines), ACP server (26+ lines), StatusBar (18+ lines), tool display (6+ lines), extension runtime (123+ lines), provider capability tests (77+ lines)

### Changed
- **Error classification unified**: Duplicated inline transient pattern checks replaced with `TRANSIENT_MESSAGE_PATTERNS` array and `matchesTransientMessage()` helper
- **Retry delay abortable**: `withRetry()` now accepts optional `AbortSignal`; `waitForRetryDelay()` resolves immediately on abort instead of waiting for the full delay
- **Tool preview length**: Truncation limit increased from 100 to 240 characters for better tool input visibility
- **Managed task breadcrumb**: Added `round` phase support with note propagation
- **Transcript layout enhanced**: Expanded with new row types and improved formatting

### Removed
- **pi-docs directory**: Deleted obsolete `docs/pi-docs/` reference documentation (28 files, ~13k lines)

### Documentation
- **FEATURE_LIST.md**: Added FEATURE_045 (Provider Stream Resilience), updated tracked feature count to 45
- **v0.7.15 feature design**: New design doc for FEATURE_045

---

## [0.7.12] - 2026-03-30

### Fixed
- Resolve mojibake (garbled text) in `kodax --help` output, CLI descriptions, and code comments across `kodax_cli.ts` — replaced 16 garbled strings with proper English text
- Fix garbled CJK keyword regex in `reasoning.ts` by referencing existing clean pattern constants instead of inline mojibake
- Replace separator with `→` in StatusBar routing/scout status display
- Propagate CLI model selection through ACP bridge

### Changed
- Add `.npmrc` to pin `registry.npmmirror.com` for consistent lockfile across machines

---

## [0.7.11] - 2026-03-30

### Added
- **Skill-aware AMA role projection**: skill invocations now carry `skillInvocation` metadata into managed execution, `Scout` emits a `skill-map`, and AMA roles consume role-specific skill views instead of sharing the same raw skill prompt
- **Skill artifacts for managed tasks**: managed workspaces now persist `skill-execution.md`, `skill-map.json`, and `skill-map.md`
- **Same-role round summaries for non-generator roles**: `Scout`, `Planner`, and `Evaluator` now persist a compact previous-round summary that is re-injected on later rounds without restoring full private chat history
- **Global work-budget approval loop**: AMA runs use a unified `globalWorkBudget` with repeated `+200` approval extensions near the 90% threshold
- **Improved tool disclosure**: REPL tool summaries now prefer target path/scope/cmd details, including explicit `bash` command display
- **Interrupted-response persistence test coverage**: new UI regression coverage for Ctrl+C persistence queuing
- **FEATURE_044**: Durable Compression Anchors and Artifact Recall spec added to v0.8.0 feature docs

### Changed
- **AMA simplified**: `H3_MULTI_WORKER`, default `Admission`, `Lead`, and `Contract Reviewer` were removed from the main runtime graph; AMA now operates with `H0_DIRECT`, `H1_EXECUTE_EVAL`, and `H2_PLAN_EXECUTE_EVAL`
- **Routing ceilings tightened**: `read-only` and `docs-only` work now stay on `SA/H0` by default, may use `H1` only when the user explicitly asks for stronger checking, and can no longer enter `H2_PLAN_EXECUTE_EVAL`
- **Repo scale semantics narrowed**: `reviewScale`, repo size, and changed-scope signals now shape evidence strategy only instead of forcing a heavier harness
- **H2 default pass count reduced**: coordinated mutation work now starts with a single main pass and opens extra passes only after structured evaluator failure
- **SA semantics clarified**: `SA` now bypasses AMA entirely and runs through the direct single-agent path
- **Project + SA continuity clarified**: project-aware direct runs now persist a lightweight run record for status, latest summary, and next-step guidance without entering the managed-task graph
- **Intent-first routing**: lightweight `conversation` / `lookup` inputs short-circuit before dirty-repo complexity can escalate them
- **Scout and Planner evidence boundaries tightened**: Scout stays pre-harness, Planner is restricted to scope facts plus overview evidence, and Generator owns deep evidence passes
- **Pre-Scout routing notes neutralized**: live AMA routing notes now stay provisional until Scout confirms the final harness
- **Status bar semantics updated**: `Work used/total` is the primary AMA budget signal; `Round` appears only when a real extra pass exists; AMA no longer falls back to user-visible `Iter x/y`
- **Evaluator public-answer contract tightened**: review answers are written directly for the user instead of narrating evaluator-vs-generator meta-review
- **Command metadata parity improved**: builtin commands now align more closely with discovered command metadata fields
- **Core docs refreshed**: HLD, DD, ADR, PRD, feature designs, and roadmap notes now match the current SA/AMA/skill architecture

### Fixed
- Interrupted managed tasks now filter empty/control-plane placeholder evidence from transcript rendering and queue the last visible response for background persistence
- Mixed lookup/actionable prompts no longer short-circuit onto the pure lookup path
- H1 revise no longer auto-escalates on the first evaluator retry
- H1 read-only Generator now receives both runtime write guards and explicit prompt guidance to stay non-mutating
- Scout downshifts now complete as Scout-owned `H0_DIRECT` runs instead of handing off to a second direct agent or leaking scout-flavored output

### Tests
- Added / expanded tests for `task-engine`, `reasoning`, `tool-display`, `live-streaming`, `StatusBar`, `invocation-runtime`, `types-legacy`, and `InkREPL.interrupted`

<!-- last-sync: HEAD -->

### Added
- **Repository intelligence substrate (FEATURE_018)**: Task-aware repository intelligence layer under `.agent/repo-intelligence/` with durable artifacts — `repo-overview.json`, `changed-scope.json`, `module-index.json`, `symbol-index.json`, `process-index.json`, `repo-intelligence-manifest.json` — supporting incremental refresh, freshness metadata, and language-tiered extraction (TS/JS via AST, Python, Go, Rust, Java, C++)
- **Intelligence query surfaces**: Six first-class retrieval tools — `repo_overview`, `module_context`, `symbol_context`, `process_context`, `impact_estimate`, `changed_scope` — returning structured capsules with freshness, confidence, evidence, and progressive disclosure (FEATURE_028)
- **Repo-intelligence tools**: `repo-overview.ts`, `module-context.ts`, `symbol-context.ts`, `process-context.ts`, `impact-estimate.ts`, `changed-scope.ts`, `internal.ts`, and `query.ts` in `packages/coding/src/tools/` and `packages/coding/src/repo-intelligence/`
- **Adaptive multi-agent mode toggle (FEATURE_027)**: Persistent `agentMode` setting (`sa`/`ama`) with CLI (`--agent-mode`), REPL (`/agent-mode`), and keyboard shortcut (`Alt+M`) entry points; status bar shows `KodaX - SA` or `KodaX - AMA`
- **SA mode execution constraint**: Single-Agent mode clamps execution to single-agent path while preserving task routing, metadata, and managed-task artifacts — reducing token cost
- **`--team` deprecation**: `--team` removed from main product surface, retained as deprecated compatibility path that warns and refuses execution
- **Agent mode shortcut**: `Alt+M` default shortcut for runtime SA/AMA toggle with command fallback
- **Prompt-time intelligence injection**: Automatic active-module and active-impact injection for edit/review/refactor flows via `buildPromptOverlay()`
- **Routing enrichment**: `stabilizeRoutingDecision()` now consumes lightweight repo-intelligence signals to raise complexity, bias planning, and choose safer harness profiles
- **Task evidence snapshots**: Managed tasks persist task-scoped retrieval snapshots (repo overview, changed scope, active module, impact) into evidence bundles
- **New types**: Intelligence capsule types, confidence tiers, freshness metadata, language capability tiers in `@kodax/coding` and `@kodax/ai`
- **New tests**: Repo-intelligence tool tests, reasoning tests for intelligence-aware routing, agent mode tests, status bar mode display tests, shortcut tests

### Changed
- **CLI entry points**: `kodax_cli.ts` updated for `--agent-mode` flag and deprecated `--team` handling
- **Reasoning pipeline expanded**: `reasoning.ts` (+495 lines) enriched with repo-intelligence signals, language-tiered extraction, and low-confidence fallback guidance
- **Task engine expanded**: `task-engine.ts` (+2645 lines) with intelligence query integration, evidence snapshot persistence, and managed-task lifecycle enrichment
- **Orchestration updated**: `orchestration.ts` refactored for intelligence-aware task dispatch and SA mode constraint propagation
- **REPL UI updated**: `InkREPL.tsx` gains agent mode display, mode toggle handling, and mode-aware rendering; `StatusBar` shows current agent mode
- **Session storage**: `storage.ts` gains `agentMode` persistence in session metadata
- **Provider registry**: Provider capability checks updated for intelligence-query-aware policy evaluation
- **Documentation**: v0.7.0, v0.8.0, v0.9.0 feature docs, FEATURE_LIST, KNOWN_ISSUES, and feature README updated for 018/027/028

---

## [0.7.5] - 2026-03-26

### Added
- **Task engine (FEATURE_022)**: `runManagedTask()` in `packages/coding/src/task-engine.ts` — full managed task lifecycle with contract creation, role assignment, evidence collection, and orchestration verdict; integrates with `runOrchestration` for multi-worker task execution
- **Task contract types**: `KodaXTaskContract`, `KodaXTaskRoleAssignment`, `KodaXTaskWorkItem`, `KodaXTaskEvidenceArtifact`, `KodaXTaskEvidenceEntry`, `KodaXTaskEvidenceBundle`, `KodaXOrchestrationVerdict`, `KodaXManagedTask` in `@kodax/coding`
- **Task context types**: `KodaXTaskCapabilityHint`, `KodaXTaskVerificationContract`, `KodaXTaskToolPolicy` for structured verification and tool policy contracts
- **Task surface tracking**: `KodaXTaskSurface` type (`cli`/`repl`/`project`/`plan`) propagated through execution context to identify managed task entry points
- **Session scope**: `KodaXSessionScope` (`user`/`managed-task-worker`) on `KodaXSessionData` and `KodaXSessionMeta` for worker session identification; `scope` option on `KodaXSessionOptions`
- **Project control state**: `ProjectControlState` interface and `createProjectControlState()` factory for tracking workflow mutations separately from derived workflow state
- **Managed task persistence**: `ProjectStorage` read/write for managed task artifacts (`managed-task.json`) and control state (`control-state.json`)
- **JSON guards**: Type guards for `ProjectControlState`, `KodaXManagedTask`, `KodaXTaskVerificationContract`, `KodaXTaskToolPolicy`, `KodaXTaskCapabilityHint` in `json-guards.ts`
- **Orchestration abort propagation**: `AbortSignal` threading from `runOrchestration` options through task runners to agent execution; `mergeAbortSignals()` utility for composite abort handling with `AbortSignal.any` fallback
- **Orchestration task cancellation**: `buildCancelledTaskResult()` and early-exit loop when external abort signal fires, marking all pending tasks as blocked
- **Task runner hooks**: `createOptions` and `onResult` callbacks on `CreateKodaXTaskRunnerOptions` for per-task option customization and post-result side effects
- **New tests**: Task engine integration tests, orchestration abort tests, project storage managed task tests, project harness control state tests, storage scope tests, CLI option helper tests

### Changed
- **CLI entry points use `runManagedTask`**: `kodax_cli.ts` replaced `runKodaX` with `runManagedTask` for all execution paths (direct, command, print) with `taskSurface: 'cli'`
- **Project commands use `runManagedTask`**: `/project next` and `/project auto` now execute via `runManagedTask` with project surface, feature metadata, and verification contracts
- **Workflow state derivation refactored**: `ProjectStorage.inferWorkflowState` replaced with `deriveWorkflowState` that considers control state, alignment truth, and managed task status for more accurate stage inference
- **Project harness verification integration**: Verification results now map to managed task verdict (`completed`/`blocked`) and update evidence entries with signals
- **Control state propagated**: Discovery, planning, and execution commands now use `saveProjectControlState` instead of directly mutating workflow state

### Documentation
- **ADR, DD, HLD, PRD**: Updated architecture decision records, design document, high-level design, and product requirements for FEATURE_022 task engine
- **Feature design docs**: v0.7.0, v0.8.0, v0.9.0, v1.0.0 feature documents updated for task engine integration and dependency tracking
- **FEATURE_LIST.md**: Updated with FEATURE_022 progress and cross-feature dependency references

---

## [0.7.4] - 2026-03-26

### Added
- **Task complexity inference (FEATURE_025)**: Weighted keyword scoring across 4 tiers — `simple`, `moderate`, `complex`, `systemic` — with language-aware Chinese and English keyword sets; cross-referenced with task type, risk level, and work intent for calibrated results
- **Work intent detection**: `inferWorkIntent()` classifies requests as `append`, `overwrite`, or `new` based on explicit keyword signals; destructive interpretation preferred when append and rewrite language conflict
- **Brainstorm trigger**: `inferRequiresBrainstorm()` detects ambiguity that warrants option framing — triggered by brainstorm keywords, low-confidence unknown tasks, systemic complexity, or high-risk overwrites
- **Harness profile selection**: `selectHarnessProfile()` maps routing decisions to 4 execution profiles (`H0_DIRECT`, `H1_EXECUTE_EVAL`, `H2_PLAN_EXECUTE_EVAL`, `H3_MULTI_WORKER`) based on task characteristics; automatically downgrades to H1/H2 on lossy bridge providers with recorded routing notes
- **Harness profile prompt overlays**: Dedicated system prompt fragments for each harness profile that guide the LLM's execution strategy
- **Tied task resolution**: `resolveTiedTask()` breaks score ties by checking for explicit directive keywords (review, fix, plan) in the prompt, falling back to `unknown` when no clear winner exists
- **Provider policy hints for decisions**: `buildProviderPolicyHintsForDecision()` converts a routing decision into policy hints — `harnessProfile`, `evidenceHeavy`, `brainstorm`, `workIntent` — threaded through execution context for downstream policy evaluation
- **Harness-aware provider policy rules**: New block/warn rules for `H3_MULTI_WORKER` (blocked on lossy/stateless providers, warned on limited) and `H2_PLAN_EXECUTE_EVAL` (warned on bridge/lossy providers)
- **Routing decision on KodaXResult**: `routingDecision` field on `KodaXResult` exposes the final visible routing decision including harness profile and work intent to callers
- **Extended KodaXProviderPolicyHints**: New `harnessProfile`, `brainstorm`, and `workIntent` fields for context-aware policy evaluation
- **New types**: `KodaXTaskComplexity`, `KodaXTaskWorkIntent`, `KodaXHarnessProfile` in `@kodax/ai`; re-exported through `@kodax/agent` and `@kodax/coding`
- **Extended routing decision**: `KodaXTaskRoutingDecision` gains `complexity`, `workIntent`, `requiresBrainstorm`, `harnessProfile`, and optional `routingNotes` fields
- **New tests**: 10 new reasoning tests (append/overwrite intent, brainstorm triggers, complexity tiers, H3 harness selection, provider downgrade, policy hints, tied task resolution), 2 new provider-policy tests (H3 block, H2 warn), expanded agent policy integration tests

### Changed
- **`stabilizeRoutingDecision` enriched**: Now runs full inference pipeline — work intent, complexity, brainstorm, harness profile — on every routing decision (fallback and LLM-routed) instead of only handling edge cases
- **Prompt overlay expanded**: `buildPromptOverlay()` now includes harness profile, work intent guidance, brainstorm trigger, and routing notes alongside the existing execution mode and task routing fields
- **Auto-reroute preserves enriched decision**: `maybeCreateAutoReroutePlan()` threads provider policy through `stabilizeRoutingDecision` so enriched fields are recalculated on reroute
- **Policy evaluation context passed to streaming**: `evaluateProviderPolicy` call in agent loop now receives `effectiveOptions` and `context` separately for accurate hint resolution
- **Agent loop threads routing decision to result**: All exit paths in `runKodaX` (success, error, cancel, yield, limit) now include `routingDecision` on the result
- **Provider policy hints threaded through execution context**: `buildReasoningExecutionState` injects `buildProviderPolicyHintsForDecision` into context's `providerPolicyHints` so downstream calls see the routing-derived hints
- **Router system prompt expanded**: LLM task router now accepts and validates `complexity`, `workIntent`, `harnessProfile`, `requiresBrainstorm`, and `routingNotes` fields

---

## [0.7.3] - 2026-03-26

### Changed
- **Message fingerprint caching**: `messagesEqual()` now uses a `WeakMap`-based fingerprint cache to avoid repeated `JSON.stringify` during lineage reconciliation, reducing deduplication cost for repeated calls
- **Fork session ID generation**: `MemorySessionStorage.fork()` uses `generateSessionId()` from `@kodax/coding` instead of a timestamp-based fallback for consistent session ID format
- **Guard reporter extraction**: Duplicated session transition guard callback in `InkREPL.tsx` extracted into shared `logSessionTransitionGuard()` helper

### Added
- **API documentation**: JSDoc comments added to all exported session lineage functions (`createSessionLineage`, `getSessionLineagePath`, `getSessionMessagesFromLineage`, `resolveSessionLineageTarget`, `setSessionLineageActiveEntry`, `appendSessionLineageLabel`, `forkSessionLineage`, `buildSessionTree`, `countActiveLineageMessages`)
- **New session lineage tests**: Empty lineage edge case, fork from active leaf without selector, skip branch summaries when `summarizeCurrentBranch` is disabled, missing selector null returns, orphaned entries rendered as separate roots

---

## [0.7.2] - 2026-03-26

### Added
- **Session lineage tree (FEATURE_019)**: `packages/agent/src/session-lineage.ts` — branchable session history with parent-child entry relationships, automatic deduplication, and immutable data structures; supports four entry types: `message`, `compaction`, `branch_summary`, and `label`
- **Session tree visualization**: `formatSessionTree()` renders the lineage as a tree with branch indicators, active-path markers, entry IDs, and optional checkpoint labels
- **Branch-and-continue navigation**: `setSessionLineageActiveEntry()` navigates to any tree node by entry ID or label; automatically summarizes abandoned branches into `branch_summary` entries for context preservation
- **Checkpoint labels**: `appendSessionLineageLabel()` attaches lightweight bookmark labels to any tree node; resolved via `getResolvedLabels()` with last-wins semantics and support for clearing labels
- **Session forking**: `forkSessionLineage()` deep-clones a branch path into an independent lineage with new entry IDs and preserved labels, enabling parallel exploration without mutating the source session
- **`/tree` REPL command**: Inspect, navigate, and label session branches — `/tree` displays the tree, `/tree <selector>` jumps to a node, `/tree label` and `/tree unlabel` manage checkpoint labels
- **`/fork` REPL command**: Export a branch into a new independent session file, optionally from a specific tree node
- **Session transition guardrails**: `evaluateSessionTransitionPolicy()` checks provider capability (session support) before session load, branch switch, or fork operations; blocks operations on stateless providers, warns on limited support
- **Extended `KodaXSessionStorage` interface**: New optional methods `getLineage`, `setActiveEntry`, `setLabel`, and `fork` for storage backends to support lineage operations
- **Session data model additions**: `KodaXSessionLineage`, `KodaXSessionEntry` (4 variants), `KodaXSessionNavigationOptions`, `KodaXSessionTreeNode` types; `KodaXSessionData` gains optional `lineage` field; `KodaXSessionMeta` gains lineage metadata fields
- **Lineage-aware JSONL persistence**: `storage.ts` reads and writes `lineage_entry` records alongside `meta` and `extension_record` lines; backward-compatible migration from legacy flat message arrays via `createSessionLineage()`
- **Lineage-aware session storage utilities**: `session-storage.ts` (Ink) and `MemorySessionStorage` (readline) both support lineage operations with `structuredClone` for immutability
- **Lineage-aware session listing**: `list()` reports active branch message count via `countActiveLineageMessages()` when lineage is present
- **Lineage storage helpers in project-harness**: `readLineageCheckpoints`, `readLineageSessionNodes`, `appendLineageCheckpoint`, `appendLineageSessionNode` with backward-compatible aliases
- **Project harness record schema additions**: `ProjectHarnessCheckpointRecord` and `ProjectHarnessSessionNodeRecord` gain `id` and `taskId` fields for lineage tracking
- **New tests**: `session-lineage.test.ts`, `session-tree-command.test.ts`, `session-guardrails.test.ts`, expanded `storage.test.ts`

### Changed
- **`loadSession` callback returns typed status**: `Promise<boolean>` replaced with `Promise<SessionLoadStatus>` (`loaded`/`missing`/`blocked`) to distinguish missing sessions from provider-guarded blocks
- **`deleteAll` scoped by git root**: `deleteAll()` now accepts optional `gitRoot` parameter for project-scoped session cleanup
- **Session save preserves extension state**: Both storage backends merge existing `extensionState` and `extensionRecords` on save for incremental updates
- **Session load returns cloned data**: `load()` now returns `structuredClone` to prevent accidental mutation of cached session state
- **Project harness persistence method rename**: Internal storage methods migrated to lineage-aware naming; old names kept as backward-compatible aliases

---

## [0.7.1] - 2026-03-26

### Added
- **Provider capability dimensions (FEATURE_029)**: Six new typed capability dimensions — `contextFidelity`, `toolCallingFidelity`, `sessionSupport`, `longRunningSupport`, `multimodalSupport`, `evidenceSupport` — added to `KodaXProviderCapabilityProfile` in `@kodax/ai`
- **Normalized capability profile**: `NormalizedKodaXProviderCapabilityProfile` type and `normalizeCapabilityProfile()` function ensuring all capability fields have explicit values with sensible defaults
- **Provider policy engine**: `packages/coding/src/provider-policy.ts` — `evaluateProviderPolicy()` evaluates provider constraints against task context (multimodal, MCP, long-running, project-harness, evidence-heavy, reasoning-control scenarios) and returns `block`/`warn`/`allow` decisions with routing notes
- **Policy-aware routing**: Provider policy wired into `createReasoningPlan()` and `buildPromptOverlay()` — routing prompts now include provider constraint notes; `buildRepositoryRoutingSummary` includes provider semantics for LLM routing decisions
- **Agent loop policy enforcement**: `evaluateProviderPolicy()` called in `runKodaX()` before streaming; `block` decisions throw errors, `warn` decisions append notes to system prompt
- **`/provider` REPL command**: Inspect provider capability matrix and common policy scenarios with color-coded block/warn/allow indicators; supports `/provider <name>[/<model>]` syntax
- **Provider capability snapshot helpers**: `getProviderCapabilitySnapshot`, `formatProviderCapabilityDetailLines`, `formatProviderSourceKind`, `getProviderCommonPolicyScenarios`, `getProviderPolicyDecision` in `@kodax/repl`
- **Provider policy types**: `KodaXProviderPolicyDecision`, `KodaXProviderPolicyIssue`, `KodaXProviderPolicyHint`, `KodaXProviderSourceKind` types in `@kodax/coding`
- **New tests**: `provider-policy.test.ts`, `agent.provider-policy.test.ts`, expanded `provider-capabilities.test.ts`; updated existing provider tests for 6 new capability fields

### Changed
- **Capability profiles expanded**: Native providers declare `full` across all 6 new dimensions; CLI bridge providers declare `lossy`/`limited`/`stateless` as appropriate
- **`cloneCapabilityProfile` normalized**: Now returns profile with all capability fields populated via `normalizeCapabilityProfile`
- **Existing provider tests updated**: `acp-base`, `capability-profile`, `cli-bridge-providers`, `custom-providers` tests updated for 6 new profile fields

### Documentation
- **FEATURE_034 design doc**: Capability profile section updated with 6 new dimensions
- **FEATURE_LIST.md**: Updated to reflect FEATURE_029 completion

---

## [0.7.0] - 2026-03-25

### Added
- **Extension Runtime (FEATURE_034)**: Headless programmable runtime with four layers — Extension Runtime (loading, lifecycle, hot reload, provenance), Capability Runtime (discovery, execution, structured result transport), Runtime Control Surface (session state, queued follow-ups, active tools, model/thinking overrides), and Host Adapters (CLI `--extension`, config-based loading, REPL commands)
- **Extension API**: `registerTool`, `registerCapabilityProvider`, `registerModelProvider`, `registerCommand`, `registerSkillPath`, typed `on(event)`, explicit `hook(...)` for `session:hydrate`, `provider:before`, `tool:before`, `turn:settle`
- **Definition-first tool registry**: Tools registered through atomic `LocalToolDefinition` with schema-derived required params; same-name tool override with provenance tracking; removed `KODAX_TOOL_REQUIRED_PARAMS` parallel truth source
- **Runtime model provider registry**: Dynamic model provider registration in `@kodax/ai` with same-name override and `registerModelProvider` API
- **Extension persistence store**: JSONL-backed key-value store in `@kodax/agent` for extension session state, scoped per extension identity with versioned entries
- **Extension commands in REPL**: `/extensions` command to list loaded extensions and `/reload` command to hot-reload extensions
- **`--extension` CLI flag**: Load extensions from CLI invocation
- **Extension command registration**: Extensions can register custom REPL commands via `registerCommand`
- **JSON mode type guards**: `JsonEventsLogger` and `JsonEventEmitter` type guards for structured event streaming
- **Extension types in `@kodax/agent`**: `KodaXExtensionSessionRecord`, `KodaXExtensionSessionState`, `KodaXExtensionStore`, `KodaXJsonValue` types
- **New tests**: extension runtime, agent extension integration, persistence store, tool registry, REPL extension commands, storage, autocomplete extension paths, CLI option helpers

### Changed
- **Agent loop extension integration**: Extension runtime wired into `agent.ts` at `session:hydrate`, `provider:before`, `tool:before`, and `turn:settle` hook points
- **Tool registry rewritten**: Multi-registration per tool name with active-selection semantics, `getRegisteredToolDefinition`, `getBuiltinRegisteredToolDefinition`, `listToolDefinitions` exported API
- **REPL commands refactored**: Chinese comments converted to English; extension-aware command dispatch; `getActiveExtensionRuntime` and `emitActiveExtensionEvent` wired into REPL commands
- **Storage module enhanced**: Extension session state and records persistence integrated into session storage
- **`@kodax/coding` public API expanded**: Extension runtime exports, capability types, tool definition types, extension store API
- **`@kodax/agent` public API expanded**: Extension store factory, extension types
- **`@kodax/ai` public API expanded**: Runtime model provider registration and resolver integration
- **`@kodax/skills` public API expanded**: `registerPluginSkillPath` for extension skill path registration
- **v0.7.0 feature design updated**: FEATURE_034 marked as Completed; roadmap dependency documentation finalized

### Documentation
- **Design document restructure**: Major cleanup of v0.7.0 feature design doc, removing redundant historical drafts while preserving key implementation decisions
- **Feature boundary documentation**: Updated boundary sections for 034 across dependent features (019, 022, 029, 035, 038)
