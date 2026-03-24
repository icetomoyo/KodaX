# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

---

## [0.6.20] - 2026-03-24

### Documentation
- Moved Feature 034 (Extension + Capability Runtime) from v0.8.0 to v0.7.0
- Updated v0.7.0 feature count to 7, v0.8.0 to 5
- Synced feature index in FEATURE_LIST.md and features/README.md

---

## [0.6.19] - 2026-03-24

### Added
- **Tool output guardrail**: `truncate.ts` with `truncateHead`, `truncateTail`, `formatSize`, `persistToolOutput`, and UTF-8-aware byte boundary handling
- **Per-tool result policy**: `tool-result-policy.ts` with configurable `maxLines`, `maxBytes`, `direction` (head/tail) per tool; `applyToolResultGuardrail` wired into agent tool execution pipeline
- **Streaming read**: Read tool now uses `readline` stream with byte budget, binary file detection, long line truncation, and preflight size warnings for large files
- **Bash tail capture**: Bash tool uses `TailCollector` for bounded stdout/stderr (512KB) with truncation hints and GBK fallback on Windows
- **Diff preview truncation**: Edit and write tools truncate large diffs with full-output spill to `~/.kodax/tool-results/`
- **Grep result truncation**: Grep tool caps at 400 lines / 24KB with spill-to-file fallback
- **System prompt guidance**: Added bounded output instructions for read, bash, grep, and diff tools
- **New tests**: truncate, tool-result-policy, bash, read, client

### Changed
- Tool descriptions updated to signal bounded output behavior
- Agent tool execution pipeline now wraps all tool results through `guardToolResult`
- Guardrail utilities exported from `@kodax/coding` public API
- FEATURE_LIST.md and v0.6.20 planning notes updated

---

## [0.6.18] - 2026-03-23

### Added
- **7 new cli-events test files**: acp-client, codex-parser, command-utils, gemini-parser, prompt-utils, pseudo-acp-server, session
- **Provider test coverage**: New tests for acp-base, base, custom-providers, cli-bridge-providers, registry
- **Test infrastructure**: Shared `temp-dir` test helpers in `@kodax/repl` and `@kodax/skills` with auto-cleanup
- **Project workflow extraction**: `project-harness-core.ts` and `project-workflow.ts` extracted from monolithic `project-harness.ts`
- **CLI option extraction**: `cli_option_helpers.ts` and `cli_commands.ts` extracted from `kodax_cli.ts`
- **command-utils module**: Shared argument escaping/splitting helpers for CLI event parsers
- **skill-registry tests**: New unit tests for skill registry

### Changed
- **cli-events i18n**: All Chinese comments converted to English across types.ts, acp-client, codex-parser, gemini-parser, executor, prompt-utils, pseudo-acp-server, session
- **pseudo-acp-server refactoring**: Better separation of concerns and code organization
- **markdown-render**: Significant refactoring of markdown rendering logic
- **themes refactoring**: Theme system cleanup
- **terminalCapabilities refactoring**: Simplified terminal capability detection
- **project-commands slimmed**: Moved logic to project-harness-core and project-workflow
- **prompts cleanup**: Removed ~246 lines from interactive prompts module
- **ACP base provider**: Reliability improvements
- **Permission system**: Minor fixes in executor and permission modules
- **message-utils refactoring**: Simplified message rendering utilities
- **KNOWN_ISSUES.md**: Major cleanup, synced resolution status

### Removed
- **11 stale `.d.ts.map` files**: Removed compiled declaration map artifacts from `packages/ai/src/`
- **test-retry.ts**: Removed scratch test file

---

## [0.6.17] - 2026-03-23

### Added
- **ACP Runtime Event Architecture**: `src/acp_events.ts` introduces typed ACP lifecycle, prompt, permission, and notification-failure events plus the shared `AcpEventEmitter` / `AcpEventSink` abstraction
- **ACP Event Sink Hook**: `KodaXAcpServerOptions.eventSinks` lets external callers attach custom sinks without touching ACP protocol flow
- **MiniMax M2.7 Provider**: Default MiniMax model upgraded from M2.5 to M2.7; added model list including M2.7-highspeed, M2.5, M2.5-highspeed, M2.1, M2.1-highspeed, M2

### Changed
- **ACP server event-driven logging**: `KodaXAcpServer` now emits runtime events via `AcpEventEmitter` instead of composing log strings inside protocol handlers
- **AcpLogger as event sink**: `AcpLogger` implements `AcpEventSink` and acts as the default `stderr` sink for ACP runtime events
- **dispatchNotification uses event emission**: Failed notification dispatch emits structured `notification_failed` events

### Documentation
- README/README_CN and KNOWN_ISSUES issue 100 updated to describe the runtime-events-plus-sink architecture
- Fixed stale version references across docs (DD.md, config.example.jsonc, docs/features/README.md, test guides)

### Tests
- ACP tests now assert structured runtime events directly, with a smaller stderr integration surface for the default sink

---

## [0.6.16] - 2026-03-23

### Added
- **ACP Runtime Event Architecture (Issue 100)**: Added `src/acp_events.ts` with typed ACP lifecycle, prompt, permission, and notification-failure events, plus `AcpEventEmitter` / `AcpEventSink`
- **ACP Event Sink Logging**: `AcpLogger` now acts as the default `stderr` sink for ACP runtime events; configurable via `KODAX_ACP_LOG=off|error|info|debug` and `KodaXAcpServerOptions.logLevel`
- **ACP log level control**: `KODAX_ACP_LOG` environment variable and `logLevel` option on `KodaXAcpServerOptions` for runtime log level configuration
- **CLI help for ACP logging**: `KODAX_ACP_LOG=<level>` documented in both `--help acp` and `--help acp serve` output

### Changed
- **ACP server logging flow**: `KodaXAcpServer` now emits runtime events instead of directly composing human-readable log lines inside protocol handlers
- **`dispatchNotification` uses event emission**: Failed notification dispatch now emits structured `notification_failed` events, which the default logger sink renders to `stderr`
- **Test infrastructure**: ACP tests now record runtime events directly, keep `stderr` assertions for sink integration only, and silence SDK invalid-request noise only in the two error-path tests that need it

### Documentation
- README/README_CN: Added ACP lifecycle logging section explaining `stderr` vs `stdout` separation and `KODAX_ACP_LOG` usage
- KNOWN_ISSUES.md: Issue 100 now documents the landed runtime-events-plus-sink architecture and updated file inventory

### Tests
- Updated ACP tests assert emitted lifecycle and permission events directly while still verifying default `stderr` sink output

---

## [0.6.15] - 2026-03-22

### Added
- **FEATURE_040: ACP Server Support**: `acp serve` CLI command exposes KodaX as a standard ACP (Agent Client Protocol) agent runtime via stdio; `KodaXAcpServer` class with streaming, permission enforcement, cancel, and mode validation; `ACP_PERMISSION_MODE_IDS` mapping for ACP mode negotiation; fail-closed on unknown permission modes
- **Execution CWD context**: `resolveExecutionCwd()` utility in `runtime-paths.ts` resolves deterministic working directory from `executionCwd > gitRoot > process.cwd()`; all tools (bash, read, edit, write, glob, grep) now use context-aware CWD instead of `process.cwd()`
- **Permission mode helpers**: `normalizePermissionMode()` and `isPermissionMode()` with `PERMISSION_MODES` constant for safe mode validation throughout the codebase; `@kodax/repl` re-exports permission helpers for external consumers
- **`onToolUseStart` input parameter**: Tool start events now include `input` field for full tool call context visibility
- **`beforeToolExecute` tool ID**: Permission hook receives `toolId` in meta parameter for fine-grained tool tracking

### Changed
- **Deprecated `default` permission mode removed**: `default` mode migrated to `accept-edits` at runtime and persisted to config; `normalizePermissionMode()` used throughout REPL, executor, and permission context for safe handling
- **Permission system refactoring**: Extracted `isPathInsideProject()` and `getBashOutsideProjectWriteRisk()` from executor to shared `permission.ts`; executor and ACP server now use shared helpers
- **Prompt builder CWD-aware**: `buildSystemPrompt()` uses `executionCwd` for git context, project snapshot, and long-running context resolution; feature file paths resolved relative to project root
- **Renamed "serial" to "sequential"**: Status bar, banner, `/parallel` help text, and all display surfaces now use "sequential" for non-parallel execution mode
- **GlobalShortcuts parallel sync**: `onSetParallel` callback wired through to keep `currentOptionsRef` in sync when toggling parallel mode via keyboard
- **`/mode` command**: Description updated from "Switch code/ask mode" to "Switch permission mode"; uses `PERMISSION_MODES` constant instead of hardcoded array
- **InputPrompt Tab behavior**: Tab key handler no longer returns `true` in all branches, preventing double character insertion on unmatched tab completions

### Documentation
- Provider count updated to 11 across CLAUDE.md, AGENTS.md, HLD.md (DeepSeek)
- Feature merge: v0.6.20 content consolidated into v0.6.15; v0.6.20.md deleted
- docs/features/README.md comprehensive update (providers, commands, release history, feature index 026-040)
- CHANGELOG.md reference fixed (v0.6.20 → v0.6.15)

### Tests
- New test files: `builder.test.ts`, `InputPrompt.test.tsx`, `GlobalShortcuts.test.ts`, `ShortcutsRegistry.test.ts`
- Updated tool tests for `executionCwd` context parameter (grep, glob)
- Updated status bar tests from "serial" to "sequential"
- ACP server tests: streaming, permissions, cancel, mode validation, cwd handling, fail-closed

---

## [0.6.14] - 2026-03-22

### Added
- **FEATURE_039: Plan Mode Write Whitelist**: Allow writes to `.agent/plan_mode_doc.md` and system temp directory during plan mode; path normalization with symlink resolution; cross-platform temp directory expansion (`%TEMP%`, `$TMPDIR`, etc.); block writes to all other paths with clear error messages
- **DeepSeek Built-in Provider**: Native provider support for DeepSeek AI with configuration via `DEEPSEEK_API_KEY` environment variable

### Fixed
- **Security: Shell injection in skill-resolver**: Replaced `execSync` with safe `child_process.execFile` API
- **Security: Direct `!command` execution**: Restricted to safe read-only commands only; write operations now require explicit Bash tool usage
- **Security: Shell-executor argument sanitization**: Hardened against command injection vectors
- **ReDoS risk in grep tool**: Escaped user-provided RegExp patterns to prevent catastrophic backtracking
- **Accidentally committed build artifacts**: Removed 27 compiled `.js`/`.js.map` files from `packages/ai/src/`; hardened `.gitignore` rules
- **JSON.parse without validation**: Added schema validation in `storage.ts` and `project-storage.ts` to prevent silent data corruption
- **Sync file I/O blocking**: Replaced `fs.readFileSync` calls in `reasoning-overrides.ts` with async alternatives
- **Permission race condition**: Fixed mode switch during confirmation dialog causing incorrect permission evaluation

### Changed
- Clarified plan mode write allowance error messages with guidance on allowed locations
- Updated permission system with `getPlanModeBlockReason` and `isPlanModeAllowedPath` for precise path-based write control
- Updated FEATURE_LIST.md with features 039-040 design documents for v0.6.15
- Expanded KNOWN_ISSUES.md with technical debt inventory

---

## [0.6.13] - 2026-03-21

### Added
- **FEATURE_033: REPL Parallel Toggle (`/parallel`)**: New `/parallel [on|off|toggle]` command with `/pm` alias to dynamically switch between parallel and serial tool execution during REPL sessions; execution mode persisted to `~/.kodax/config.json` and synced across classic REPL, Ink REPL, status bar, and startup banner

### Documentation
- **FEATURE_037**: API Token Usage design — real usage value preferred with estimation fallback
- **FEATURE_035**: MCP Bridge design with user-level paths
- **FEATURE_034**: Extension + Capability Runtime design
- **FEATURE_038**: Official Sandbox Extension design for `@kodax/sandbox` optional package
- **README Language Switcher**: Added English/Chinese toggle link

### Changed
- Aligned legal and contributor metadata across documentation
- Refreshed permission mode messaging and CLI help text

---

## [0.6.12] - 2026-03-19

### Added
- **Discovery-Driven Brainstorm Flow**: `/project brainstorm` replaced freeform continue/done subcommands with a structured UI-driven discovery flow that asks four alignment questions (outcome priority, constraints, non-goals, success criteria); supports pause/resume and free-form input via "Other" option
- **Workflow State Machine**: `ProjectWorkflowState` with seven stages (`bootstrap` → `discovering` → `aligned` → `planned` → `executing` → `blocked` → `completed`) persisted to `.agent/project/project_state.json`; automatic stage inference from existing artifacts when state file is absent
- **Project Alignment Model**: `ProjectAlignment` and `ProjectBrief` types with Markdown serialization/parsing; alignment captures confirmed requirements, constraints, non-goals, accepted tradeoffs, success criteria, and open questions; persisted to `.agent/project/alignment.md` and `.agent/project/project_brief.md`
- **Change Request Support**: `/project init` on an existing project now offers change-request workflows (explore, draft plan, or record-only); change requests persisted as individual Markdown files under `.agent/project/change-requests/`
- **Execution Stage Gating**: `/project next` and `/project auto` now verify the project is in a `planned`/`executing`/`blocked`/`completed` stage before proceeding; users are directed to run `/project plan` first when not ready
- **Auto Session Plan Generation**: `ensureExecutionSessionPlan` automatically generates a `session_plan.md` from the current feature when execution begins without an existing plan
- **Workflow-Aware Status**: `/project status` now displays workflow stage, scope, unresolved discovery count, session plan presence, and recommended next command based on current stage
- **Stage-Aware Edit**: `/project edit` operates on alignment data during `discovering`/`aligned`/`bootstrap` stages; detects feature index from natural language input during execution stages
- **`/project plan` Alignment Integration**: When no feature list exists, `/project plan` generates features from alignment data using AI or deterministic fallback; handles `change_request` scope by appending to existing features
- **Expanded Project Hints**: `/project` startup hint now shows workflow stage, context-aware recommended next step, and diagnostic command suggestions
- **`-h project` Help Topic**: New CLI help topic documenting the full Project Mode workflow across non-REPL bootstrap commands and REPL `/project` commands
- **`/project plan` Tab Completion**: Added `plan` to feature-index auto-completion in project completer

### Changed
- **Init Workflow Redesign**: `/project init` now presents a three-way choice (start discovery, draft planning directly, initialize only) instead of delegating to `buildInitPrompt`; creates alignment and brief files immediately
- **Legacy Subcommand Deprecation**: `/project brainstorm continue`/`done`, `/project init --append` gracefully print deprecation notices instead of executing
- **`--init` Help Alignment**: Updated init help topic to reference REPL `/project` commands and `.agent/project/` artifact layout
- **Session Help Clarity**: `-r` without ID documented as "list recent sessions, then resume the latest"; `-n/--new` documented as legacy no-op; `-s` documented as legacy session operations
- **Print Mode Help**: Added `--model <name>` option and provider selection example
- **Team Mode Description**: Updated to note experimental status and clarify it is not yet a fully shared-context multi-agent runtime
- **Provider Help Caveat**: CLI bridge providers annotated as "latest-user-message only, MCP unavailable"
- **Test Guide Naming Convention**: All 12 test guide files renamed to follow `FEATURE_{ID}_{VERSION}_TEST_GUIDE.md` standard

### Removed
- **`buildInitPrompt` Dependency**: Project init no longer delegates to `buildInitPrompt` from `common/utils.js`; REPL-side project management is fully self-contained

---

## [0.6.11] - 2026-03-19

### Added
- **Provider Capability Profiles**: `KodaXProviderCapabilityProfile` type distinguishing `native-api` vs `cli-bridge` transport, conversation semantics (`full-history` / `last-user-message`), and MCP support (`native` / `none`); all 10 providers now declare explicit capability metadata
- **CLI `--model` Flag**: Override the default model for any provider via `--model <name>` (e.g. `kodax -m openai --model gpt-5.4 "task"`)
- **Provider Capability Warnings**: `/providers` and `/status` now display yellow warnings for `cli-bridge` providers, alerting users to potential capability limitations
- **`getProviderConfiguredCapabilityProfile` API**: New exported function in `@kodax/ai` for retrieving the capability profile of the active provider
- **Tracker Consistency Test**: Automated validation test for `FEATURE_LIST.md` metadata (version counts, status aggregates, design doc cross-references)

### Changed
- **Provider Help Dynamic Rendering**: `--help provider` now generates the provider list dynamically from the registry instead of hardcoding names
- **Auto Mode Clarification**: `-y, --auto` documented as backward-compat alias; non-REPL CLI already runs in auto mode by default

### Documentation
- **docs/features/README.md Full Rewrite**: Updated from v0.3.x to v0.6.10; 5-layer architecture diagram, 10 providers, 9 tools, complete feature index, reasoning mode table
- **Provider/Tool Count Alignment**: Updated counts across PRD, HLD, CLAUDE.md, AGENTS.md, README_CN.md, GENERAL_TEST_GUIDE (7 → 10 providers, 8 → 9 tools)
- **Path Migration**: Updated `.kodax/session_plan.md` and `.kodax/projects/` references to `.agent/project/` in FEATURE_LIST, DD, features/README
- **Roadmap Expansion**: Added features 026-030 to FEATURE_LIST and version design docs (v0.7.0, v0.8.0, v1.0.0)

---

## [0.6.10] - 2026-03-18

### Added
- **FEATURE_024: Project Harness - Action-Level Verified Execution**: Deterministic verification for `/project next` and `/project auto`; protected-artifact blocking for `feature_list.json` and harness-owned files; `/project verify` with current-workspace re-verification; harness run/evidence persistence; proof-carrying completion report parsing; declarative invariant compilation for test, doc, and workspace dependency checks; active-feature relevance and unrelated-diff detection; structured failure codes and retry feedback; checkpoint metadata and session-tree node capture; feature-step and session-plan checklist coverage gates; repair-playbook policy in generated harness config
- **Autocomplete Replacement Utility**: Extracted `buildAutocompleteReplacement` function into dedicated `autocomplete-replacement.ts` with typed interfaces for command, argument, file, and skill completion types
- **TextBuffer.replaceRange**: New `replaceRange(start, end, replacement)` method for replacing arbitrary text ranges with cursor positioning
- **TextBuffer.moveToAbsoluteOffset**: New method to move cursor to any absolute string offset, supporting multi-line navigation
- **useTextBuffer.replaceRange**: Exposed `replaceRange` from the `useTextBuffer` hook with undo history support

### Changed
- **Project Runtime Artifact Migration**: Project runtime artifacts moved from `.kodax/project/` to `.agent/project/` with legacy `.kodax` read compatibility; session plan, brainstorm, checkpoints, session-tree, and harness records now under `.agent/project/`
- **InputPrompt Refactor**: Replaced inline autocomplete replacement logic with extracted `buildAutocompleteReplacement` utility; uses `replaceRange` instead of `setText` for precise cursor-aware completion
- **`/project verify` Enhancement**: Now reruns deterministic workspace verification instead of just displaying the latest cached result
- **Feature Execution Prompt**: Added feature-step and session-plan checklist items as completion criteria for agent attempts

---

## [0.6.4] - 2026-03-18

### Added
- **History Review Mode**: PgUp enters review mode; Ctrl+Y/Alt+Z toggle; Esc/End/PgDn-at-bottom resume live; j/k for line-by-line scrolling; mouse wheel support (wheelup/wheeldown via SGR sequence parsing); live updates and spinner animation paused while reviewing; up to 50 rounds and 4000 transcript rows visible in review
- **Mouse Wheel Support**: SGR mouse sequence detection and buffering in keypress-parser; `wheelup`/`wheeldown` recognized as function keys; multi-byte SGR sequence assembly
- **MessageList Viewport Props**: `scrollOffset`, `animateSpinners`, and `windowed` props for review-mode rendering control; spinner glyphs freeze when `animateSpinners=false`; windowed mode bypasses Ink `<Static>` to enable scroll-offset slicing
- **Review Snapshot State**: `ReviewSnapshot` interface captures and freezes streaming state when entering review or awaiting user interaction; `isLivePaused` flag coordinates display freeze across MessageList, StatusBar, and suggestions
- **FEATURE_023: Dual-Mode Terminal UX**: v1.0.0 roadmap feature documenting the inline vs fullscreen TUI split, half-automatic review mode as the first deliverable, and renderer migration strategy (Rezi/OpenTUI/Ratatui)

### Changed
- **StatusBar Simplified**: Removed animated `<Spinner>` component and per-char counts from status bar; replaced with static `isThinkingActive` boolean and `showBusyStatus` flag; spinner animation now lives only in transcript rows where it belongs
- **Waiting-for-Input State**: Busy indicator hidden when awaiting user interaction (confirm dialogs, UI requests); input placeholder changes to "Reviewing history..." during review
- **Viewport Budget**: `reviewHint` line accounting added; `reviewHintRows` included in reserved bottom rows
- **Help Bar**: Added "PgUp review" hint to the keyboard shortcuts bar
- **Command Discovery Dedup**: Directories are now resolved via `realpathSync` and deduplicated so overlapping project and user command paths do not produce duplicate commands
- **Feature List**: Added FEATURE_023 and v1.0.0 version tracking (23 total features)

---

## [0.6.3] - 2026-03-17

### Added
- **Skill Creator Eval Pipeline**: Full end-to-end skill evaluation workflow with `init-skill`, `run-eval`, `grade-evals`, `analyze-benchmark`, and `compare-runs` scripts; expert agent prompts in `agents/` (grader, analyzer, comparator)
- **CLI `skill` Subcommands Expanded**: `init`, `eval`, `grade`, `analyze`, `compare` added to `kodax skill`; per-subcommand help via `printSkillSubcommandHelp`
- **StatusBar Real-Time Busy Indicator**: Animated `<Spinner>` with live char counts for thinking and tool input (e.g. "Thinking (42 chars)", "Bash (12 chars)"); `formatBusyStatus` helper for unified display logic
- **Thinking Char Tracking**: `appendThinkingChars(text.length)` accumulates character count during `onThinkingDelta`, displayed in transcript and status bar
- **MessageList viewportRows Prop**: Viewport budget awareness passed through to `MessageList` component

### Fixed
- **CJK Cursor Placement**: New `splitAtVisualColumn` and `sliceByCodePoints` utilities correctly handle wide (CJK) characters in cursor positioning and text rendering
- **Word Wrap Tracking**: `chunkEndInLogical` variable added to `calculateVisualLayout` ensuring `currentPosInLogical` advances by actual logical positions, not by chunk length after wide-char reordering
- **Thinking Reset on Multi-Iteration**: `startThinking()` now called on every iteration instead of only iteration 1, preventing stale thinking state across iterations

---

## [0.6.2] - 2026-03-17

### Added
- **Skill Creator Builtin**: New `skill-creator` builtin skill with `validate`, `package`, and `install` sub-tools for creating, packaging, and installing KodaX skills
- **CLI `skill` Command**: `kodax skill validate|package|install` subcommands for running skill tools without starting an agent session, with `kodax -h skill` detailed help topic
- **Skill Loader: `references/` and `assets/` Folders**: `loadFullSkill` now loads `references/` and `assets/` subdirectories alongside existing `scripts/`, `templates/`, and `resources/`
- **Recursive Skill File Loading**: `loadSkillFiles` now descends into subdirectories and uses `relative()` paths for correct cross-platform path handling
- **Skill Type Extensions**: `Skill` interface gains optional `references` and `assets` fields

### Changed
- **Built-in Skill Descriptions Rewritten**: `code-review`, `tdd`, and `git-workflow` SKILL.md files rewritten with clearer trigger scoping, severity levels, and compatibility notes; `tdd` and `git-workflow` now use `disable-model-invocation: true` for manual-only triggering
- **`@kodax/skills` README Updated**: Examples updated for new API (`discoverSkills` returns `Map`, `SkillContext` fields), skill table refreshed with new `skill-creator` entry
- **Plan Mode Handoff Feedback**: Refinements to plan mode handoff behavior

---

## [0.6.1] - 2026-03-17

### Added
- **`hasPendingInputs` Event Hook**: New `KodaXEvents.hasPendingInputs` callback lets the agent loop detect queued follow-ups and exit early to hand control back to the REPL

### Fixed
- **Queued Prompt Continuation After User Cancel**: When user interrupts via Ctrl+C/ESC, queued follow-ups now continue instead of being discarded — the agent exits its loop cleanly and the REPL drains the queue
- **ESC to Remove Queued Input**: Single ESC on empty input now removes the last queued prompt (previously required two presses); double-ESC still interrupts
- **Blank Prompt Filtering**: `runQueuedPromptSequence` now skips blank/whitespace-only queued prompts instead of sending them to the agent
- **Input Clear After Queue**: Input field is cleared after queueing a follow-up prompt, preventing stale text from appearing on next render
- **PendingInputsIndicator Layout**: Container changed to `flexDirection="column"` to prevent horizontal overflow

---

## [0.6.0] - 2026-03-17

### Added
- **Command System 2.0**: User-level `.md` command file discovery (`~/.kodax/commands/` + `.kodax/commands/`), generic `UIContext` interface for select/confirm/input, and LLM-callable user interaction tools (`ask_user`, `confirm_action`, `get_input`)
- **Project Mode 2.0 - AI-Driven Workflow**: Brainstorm, plan, and quality subcommands for `/project`
  - `project-brainstorm.ts`: Session-based brainstorming with AI-powered facilitator and fallback mode
  - `project-planner.ts`: Structured plan generation with phases, tasks, estimates, and risk tracking
  - `project-quality.ts`: Automated quality checks with scoring across completeness, testing, documentation, and architecture dimensions
- **Streaming Context (`StreamingContext`)**: React context provider for streaming state, enabling child components to access pending inputs, mode, and iteration without prop drilling
- **Pending Inputs Queue**: `pending-inputs.ts` utility with `MAX_PENDING_INPUTS=5` cap; `PendingInputsIndicator` component shows queued prompt count in status bar
- **Queued Prompt Sequence**: `queued-prompt-sequence.ts` runs queued follow-up prompts sequentially after streaming completes, with ESC-to-cancel support
- **Project Storage Enhancement**: Brainstorm session persistence (session JSON + transcript markdown) with active session index for resume support

### Changed
- **InkREPL ESC Behavior**: Single ESC on non-empty input now no-ops instead of triggering interrupt; double-ESC still interrupts
- **InkREPL Prompt Queue**: `canQueueFollowUps` state gates the follow-up queue; `addPendingInput`/`removeLastPendingInput`/`shiftPendingInput` wired through `StreamingContext`
- **Project Storage JSDoc**: Comments normalized to English; internal helper methods (`getBrainstormSessionDir`, etc.) extracted
- **Feature List Stats**: v0.6.0 progress report with all 5 features marked Completed

### Fixed
- **Viewport Budget with Pending Inputs**: `pendingInputSummary` now included in budget calculation, preventing layout jump when pending inputs appear

---

## [0.5.42] - 2026-03-16

### Changed
- **Transcript Section Granularity**: Active round now builds one `TranscriptSection` per `HistoryItem` via `buildHistoryItemTranscriptSections()`, with pending state (thinking/streaming/tool) as a separate section appended only when content exists
- **JSDoc Cleanup**: `MessageListProps` comments normalized to English

### Fixed
- **Unicode Escape Consistency**: Remaining non-ASCII characters (`○`, `●`, `──`, hint emoji) replaced with Unicode escapes

---

## [0.5.41] - 2026-03-16

### Changed
- **MessageList Static/Dynamic Split**: Completed conversation rounds now render via Ink `<Static>` (no re-render), while only the active round renders dynamically
  - Added `splitMessageHistorySections()` to split history at the last user message boundary
  - Added `buildStaticTranscriptSections()`, `buildDynamicTranscriptSection()`, `flattenTranscriptSections()` to `transcript-layout.ts`
  - Added `TranscriptSection` type with `key` and `rows` fields
  - Added `StaticTranscriptItemRenderer` component for stable rendering of completed rounds

### Fixed
- **Terminal Flicker**: Completed rounds no longer re-render on every keystroke or streaming token

---

## [0.5.40] - 2026-03-16

### Added
- **Viewport Budget System**: Unified bottom-section row calculation to prevent layout instability
  - `viewport-budget.ts` calculates reserved rows for input, suggestions, help bar, status bar, confirm dialog, and UI request dialogs
  - `calculateViewportBudget()` returns `messageRows` (available for messages) and `visibleSelectOptions` (clamped for select dialogs)
- **Transcript Layout System**: Replaced nested React components with flat `TranscriptRow[]` data model
  - `transcript-layout.ts` converts all `HistoryItem` types into unified rows with semantic color tokens
  - `getVisibleTranscriptRows()` slices from tail to keep latest content visible
  - `resolveTranscriptColor()` maps semantic tokens to theme colors
- **`getStatusBarText()` Export**: Pure function in StatusBar for reuse in viewport budget calculation, ensuring consistent line-wrapping
- **Layout Constants**: Extracted help bar segments and padding values into `constants/layout.ts`
- **Thinking Color**: New `thinking` color token in theme (`#A3ADC2`) for better readability of long thinking text

### Fixed
- **Message List Last Line Clipping**: Transcript now slices from tail based on viewport budget, ensuring the latest message line is always visible
- **Bottom Section Height Jumping**: Autocomplete suggestions space reservation moved to parent component (`InkREPLInner`), preventing jarring height changes on show/hide
- **Select Dialog Overflow**: Options now clamped to viewport budget limit with "X more choices..." indicator
- **Status Bar Width**: `AutocompleteSuggestions` uses dynamic `terminalWidth - 2` instead of hardcoded 80

### Changed
- **MessageList Architecture**: Removed `<Static>` / dynamic split approach in favor of unified TranscriptRow rendering
- **AutocompleteSuggestions**: State management (`reserveSpace`) lifted from component to parent; accepts `reserveSpace` and `width` props
- **Confirm Dialog Instruction**: Extracted from inline JSX to `useMemo` for testability
- **StatusBar Props**: Consolidated into single `useMemo` object in InkREPL
- **Message Utils**: Enhanced `extractTextContent` with legacy thinking tag stripping, added `RestoredHistorySeed` type and `buildRestoredHistory` function
- **Code Cleanup**: Removed most Chinese inline comments; emoji literals replaced with Unicode escapes

---

## [0.5.39] - 2026-03-16

### Added
- **Custom Provider Support**: Users can define custom AI providers in `config.json` via `customProviders` array
  - Supports OpenAI and Anthropic protocol families
  - Per-provider configuration: `baseUrl`, `apiKeyEnv`, `model`, `models`, `supportsThinking`, `reasoningCapability`
  - Unified provider resolution: `resolveProvider()` checks built-in first, then custom
  - Name collision warning when custom provider shadows a built-in
- **Multi-Model Support**: Built-in providers now expose available model lists
  - `getAvailableModels()` and `getModelDescriptor()` methods on base provider
  - Two-stage tab completion: `/model ant<TAB>` → provider names, `/model anthropic/cl<TAB>` → models
  - Provider model lists: Anthropic (3 models), OpenAI (3 models), Zhipu/Zhipu-coding (3 models each)
  - `providerModels` config field to override built-in model lists
  - `model` config field to select model within current provider
- **~/.agents/ Directory Support**: Skills and commands can now be discovered from `~/.agents/skills/` and `~/.agents/commands/` directories (AgentSkills standard)
- **`/model` Command Enhancement**: New syntax for provider and model selection
  - `/model <provider>` — switch provider
  - `/model <provider>/<model>` — switch to specific model
  - `/model /<model>` — switch model within current provider
  - Displays all providers with their models, current selection marked with `>`

### Fixed
- **Argument Completer Double Filtering**: Fixed two-stage provider/model completion returning no results
  - `getModelArgs()` pre-filters by model partial, but `getCompletions()` applied redundant filter with full `provider/modelPartial`
  - Added skip logic for arg names containing `/`
- **Unknown Provider Completion**: `/model unknown_provider/` now returns empty instead of falling back to provider names
- **MessageList Footer Clipping**: Moved `lastResponseHistoryItems` out of Ink's `<Static>` component
  - Items now reflow with footer/layout changes instead of being pinned permanently

### Changed
- **Skills/Commands Discovery Priority**: Adjusted directory priority order:
  1. `<projectRoot>/.kodax/skills/` (or `commands/`) — project level (highest)
  2. `~/.kodax/skills/` (or `commands/`) — user level
  3. `~/.agents/skills/` (or `commands/`) — user level (AgentSkills standard)
- **Removed Enterprise Paths**: Removed `~/.kodax/skills/enterprise/` directory (no longer needed)
- **`/copy` Command**: Replaced local `getLastAssistantMessage` with shared `extractLastAssistantText` (DRY)
- **Config Template**: Updated `config.example.jsonc` with full documentation for new fields (`model`, `providerModels`, `customProviders`)
- **Effective Model Resolution**: Priority chain `modelOverride > options.model > provider.config.model`

### Removed
- **Build Artifacts**: Cleaned up 24 accidentally committed build output files (`*.d.ts`, `*.js`, `*.js.map`) from `packages/ai/src/`
- **.gitignore Hardening**: Added rules to prevent build artifacts in source directories (`src/**/*.js`, `src/**/*.d.ts`, etc.)

---

## [0.5.38] - 2026-03-16

### Changed
- **System Prompts Enhancement**: Improved tool usage guidance in system prompts
  - Added shell command failure recovery order guidance
  - Added tool usage preferences (prefer specialized tools over shell)
  - Added temporary script handling guidelines

### Fixed
- **Permission Race Condition**: Fix race condition when switching permission mode during confirmation dialog
  - User could press Ctrl+O to switch to 'plan' mode while confirmation dialog was pending
  - Added re-evaluation of permission mode after user confirms tool execution
  - Synced permission mode ref in GlobalShortcuts to keep it updated
- **Temporary Helper Script Prevention**: Block creation of temp scripts outside project scratch area
  - Detect temp helper script patterns (e.g., temp-*.sh, helper*.js, scratch*.py)
  - Guide LLM to use specialized tools (read/edit/write) or .agent/ directory
  - Support both write tool and bash redirect/tee commands
- **Improved Plan Mode Error Messages**: Enhanced guidance when tools blocked in plan mode
  - Suggest using `ask_user_question` tool to request mode change
  - Clearer explanation of plan mode restrictions

---

## [0.5.37] - 2026-03-15

### Added
- **FEATURE_021**: Provider-Aware Reasoning Budget Matrix
  - Unified reasoning mode system: `off`, `auto`, `quick`, `balanced`, `deep`
  - Provider capability detection with fallback chains (native-budget → native-toggle → none)
  - Task routing with LLM-based and heuristic fallback
  - Auto-reroute capabilities for depth escalation and task reclassification
  - Reasoning mode persistence and configuration
  - New `/reasoning` command with inline argument support (e.g., `/reasoning:auto`)
  - Enhanced `/thinking` command as compatibility alias
  - Ctrl+T keyboard shortcut to cycle reasoning modes

### Changed
- Refactored AI and Coding layers to support unified reasoning system
- Enhanced provider registry with capability detection
- Improved REPL command parsing for inline arguments
- Updated StatusBar to display reasoning mode

### Fixed
- UI synchronization between React state and ref for reasoning mode
- Error handling in auto-reroute logic
- Configuration file save error handling

---

## [0.5.36] - 2026-03-14

### Added
- **FEATURE_013**: Command System 2.0 - Core commands
  - `/copy` - Copy last assistant message to clipboard
  - `/new` - Start new conversation session with confirmation
  - CommandRegistry pattern with dynamic registration support
  - Source tracking for builtin/extension/skill/prompt commands

### Fixed
- TypeScript type error in Session Initial Messages tests (kodax_core.test.ts)

### Changed
- Reorganized test files from `__tests__/` directories to source-adjacent location
  - Unit tests now placed next to source files (`*.test.ts`)
  - Updated CLAUDE.md with test organization standards
- Fixed fuzzy.test.ts TypeScript type error (TestCandidate extends ScoredCandidate)

---

## [0.5.35] - 2026-03-13

### Added
- **FEATURE_020**: AGENTS.md - Project-level AI context rules

### Added
- **FEATURE_020**: AGENTS.md - Project-level AI context rules
  - Multi-level rules support: global (~/.kodax/AGENTS.md), directory, project (.kodax/AGENTS.md)
  - Auto-discovery from current directory upward
  - Support for AGENTS.md and CLAUDE.md filenames (pi-mono compatible)
  - Priority system: global < directory < project
  - `/reload` command to reload rules during session
  - Startup feedback showing loaded rule files count

### Fixed
- REPL autocomplete trigger logic improvements and tests
- Shortcuts timing and help UI spacing

---

## [0.5.33] - 2026-03-11

### Fixed
- **Issue 084**: Silent stream interruption with no error
  - Added message_stop/finish_reason validation to detect incomplete responses
  - Implemented dual timeout mechanism: 10min hard + 60s idle timeout
  - Added StreamIncompleteError classification with 3 retries
  - Added [Interrupted] indicator for interrupted generations
- **Issue 085**: Read-only Bash command whitelist not reused in non-plan modes
  - Implemented unified readonly whitelist across all modes
- **Skill System**: Skill amnesia after compaction
  - Fixed skill registry reset bug after context compaction
  - Added APIUserAbortError handling
- **Network Errors**: Retry "Request was aborted" errors from network issues
  - Improved error classification for transient network failures

---

## [0.5.32] - 2026-03-10

### Fixed
- Build and compilation errors

---

## [0.5.31] - 2026-03-10

### Fixed
- Reviewed widened mode permissions
- Fixed compaction build errors
- Fixed build missing @kodax/ai module
- Fixed @kodax/ai build imports
- Reviewed readonly whitelist changes

---

## [0.5.30] - 2026-03-09

### Added
- **Tri-Layer Security for Plan Mode**
  - Implemented comprehensive permission control for plan mode
  - Fixed bash permission bugs across all layers
  - Enhanced security boundaries between modes

### Fixed
- **Issue 084**: Silent stream interruption with no error
- **Issue 085**: Read-only Bash command whitelist not reused in non-plan modes
- Skill amnesia after compaction and APIUserAbortError handling
- Retry "Request was aborted" errors from network issues

### Documentation
- Resolved Issue 070: Streaming output newlines preserved
- Resolved Issue 067: API rate limit retry mechanism fixed
- Resolved Issues 006, 060, 081 after code review
- Updated KNOWN_ISSUES.md status review
- Added FEATURE_017 design document and dependencies
- Added FEATURE_018 CodeWiki - 项目知识库系统
- Added issue 083 - 缺少快捷键系统

---

## [0.5.29] - 2026-03-08

### Changed
- **ACP Protocol Architecture Refactoring**
  - Refactored Gemini CLI and Codex CLI providers to use new ACP (Agent Client Protocol) architecture
  - Added `KodaXAcpProvider` base class for all ACP-based providers
  - Added `AcpClient` for ACP protocol communication
  - Added `createPseudoAcpServer` for in-memory ACP server simulation

---

## [0.5.28] - 2026-03-07

### Fixed
- **Compaction Indicator Issues**
  - Fixed thinking spinner incorrectly showing "Compacting" after compaction check
  - Added `onCompactEnd` callback to properly stop spinner in all cases
  - Removed redundant `needsBasicCompact` check (100k threshold)

---

## [0.5.27] - 2026-03-07

### Added
- **Rate Limit Message Display**
  - Fixed rate limit retry messages appearing 3 times after task completion
  - Changed from console.log to callback-based approach (`onRateLimit` callback)
- **Auto-Compaction Notification**
  - Status bar now shows "✨ Compacting..." indicator during context compaction
  - Added `onCompactStart` callback to notify UI before compaction starts
  - Info message displays after compaction

---

## [0.5.26] - 2026-03-06

### Fixed
- **Message Rendering Issues**
  - Fixed user messages appearing twice after tool confirmation
  - Fixed assistant messages disappearing after streaming ended
- **Duplicate Message Issue**
  - Fixed ghost `[Interrupted]` messages appearing on new submissions

---

## [0.5.25] - 2026-03-05

### Added
- **Real-time Context Usage Updates**
  - Context usage now updates after each LLM iteration
  - Added `onIterationEnd` callback to `KodaXEvents`

---

## [0.5.24] - 2026-03-04

### Added
- **Context Usage Display** (Issue 070)
  - Status bar now shows real-time context token usage with color-coded progress bar

### Fixed
- Various bug fixes

---

## [0.5.23] - 2026-03-03

### Changed
- **gemini-cli provider** - Refactored to use CLI subprocess wrapper pattern
- **codex-cli provider** - Refactored to use CLI subprocess wrapper pattern

---

## [0.5.22] - 2026-03-03

### Added
- **CLI Events Module** (`packages/ai/src/cli-events/`)
  - `types.ts` - Unified CLI event types
  - `executor.ts` - Base CLIExecutor class with subprocess management
  - `gemini-parser.ts` - Gemini CLI JSON Lines parser
  - `codex-parser.ts` - Codex CLI JSON Lines parser
  - `session.ts` - CLISessionManager for KodaX↔CLI session mapping
  - `prompt-utils.ts` - Shared prompt building utility

---

## [0.5.21] - 2026-03-03

### Added
- `ask-user-question` tool

### Fixed
- Correct loop logic in `cleanupIncompleteToolCalls`

### Documentation
- Updated outdated documentation and added general test guide
- Updated v0.5.20.md header with completion status
- Marked Feature 014 (Project Mode Enhancement) as completed
- Added Feature 015 - Project Mode 2.0 for v0.6.0

---

## [0.5.20] - 2026-03-02

### Added
- **Feature 014**: Project Mode Enhancement
  - Context snapshot functionality
  - Hot/cold track dual-track memory system

### Fixed
- **Issue 072**: Comprehensive fix for tool_call_id error
- **Issue 075**: CRLF handling for Windows paste
- Precise cleanup of orphaned tool_use blocks

---

## [0.5.17] - 2026-03-01

### Added
- **Comprehensive API error recovery mechanism**
  - Agent improvements for message handling
  - Unified intelligent compaction
  - Added API hard timeout protection (3 minutes)
  - Added basic safety threshold (100k tokens)

### Changed
- Banner now shows context window and compaction status

### Documentation
- Updated context tracks and added v0.5.20 feature design
- Migrated feature 013 (Command System 2.0) to v0.6.0

---

## [0.5.16] - 2026-02-28

### Added
- Plan mode allows read-only bash commands
- Iteration display and /skill: autocomplete fix

### Documentation
- Updated FEATURE_LIST.md timestamp

---

## [0.5.15] - 2026-02-28

### Added
- **Feature 012**: TUI Autocomplete Enhancement
  - Fuzzy matching for command autocomplete

### Documentation
- Updated context tracking and test guide for Feature 012

---

## [0.5.14] - 2026-02-27

### Added
- **Feature 011**: Intelligent Context Compaction
  - Multi-round compression with UI history fix
  - Prevented duplicate message push into context

### Fixed
- `limitReached` flag set to true when reaching iteration limit
- Session persistence after compaction

### Documentation
- Updated snapshots with limitReached bug fix

---

## [0.5.13] - 2026-02-26

### Fixed
- Double-ESC for clear input and interrupt streaming
- Autocomplete smart replacement and mid-line trigger support

---

## [0.5.12] - 2026-02-26

### Fixed
- Autocomplete Enter key now submits immediately

---

## [0.5.11] - 2026-02-25

### Added
- **Feature 012**: TUI Autocomplete Enhancement
  - Fixed autocomplete jitter issues

### Fixed
- Added end tags for Thinking content

### Documentation
- Migrated feature 007 to v0.6.0 planning
- Marked feature 006 Skills system as completed

---

## [0.5.10] - 2026-02-24

### Documentation
- Comprehensive project documentation update reflecting latest architecture
- Closed issue 080 - Long text input box fixed

### Fixed
- Added history memory limit to prevent memory leak

---

## [0.5.9] - 2026-02-24

### Fixed
- **Issue 080**: Unified single-line and multi-line input visual layout rendering
- Removed duplicate assistant message display

### Documentation
- Cleaned up KNOWN_ISSUES.md - removed archived issue details
- Marked feature 010 as completed

---

## [0.5.8] - 2026-02-23

### Fixed
- **Issue 080**: Long text input wrapping and cursor positioning

### Documentation
- Added missing entries to CHANGELOG for v0.5.5
- Updated changelog and KNOWN_ISSUES for v0.5.7

---

## [0.5.7] - 2026-02-22

### Fixed
- **Issue 074**: Iteration history duplicate display issue
- **Issue 072**: Clean up incomplete tool_use blocks on streaming interruption
- Restored thinking content in session history

---

## [0.5.6] - 2026-02-21

### Fixed
- CLI maxIter default value override + rate limit retry logic
- Implemented actual retry logic for API rate limiting
- Made CliOptions.maxIter optional to allow undefined fallback
- CLI maxIter defaults to undefined, uses coding package default
- Updated CLI default maxIter from 50 to 200
- Improved system prompt for natural language skill triggering

### Documentation
- Resolved issue 054, add 077 for advanced skill features
- Cleaned up skill budget management from Issue 054

---

## [0.5.5] - 2026-02-20

### Added
- Iteration history display and tool input preview
- FEATURE_013 Command System 2.0

### Fixed
- Bug fixes for Issue 075 & 076

---

## [0.5.4] - 2026-02-19

### Changed
- @kodax/coding package rename

---

## [0.5.3] - 2026-02-19

### Added
- **Feature 010**: Precise token calculation
  - Created @kodax/agent package with session/messages/tokenizer
  - Added tiktoken for precise token calculation

---

## [0.5.2] - 2026-02-18

### Added
- **Feature 010**: Skills system foundation
  - Created @kodax/skills package with zero dependencies

---

## [0.5.0] - 2026-02-17

### Fixed
- Critical skill registry singleton reset bug
- Properly save interrupted streaming responses
- Preserve interrupted streaming responses in history

### Documentation
- Fixed directory path references (.claude → .kodax)

---

## [0.4.9] - 2026-02-16

### Fixed
- **Issue 058**: Windows Terminal flickering
  - Upgraded Ink 5.x → 6.8.0 to fix Windows Terminal flickering
  - Upgraded React 18 → 19
  - Disabled incrementalRendering to fix cursor positioning issue
- Added missing getSkillRegistry import
- Used initializeSkillRegistry instead of getSkillRegistry

---

## [0.4.8] - 2026-02-15

### Added
- **Feature 006**: Agent Skills system
  - Implemented Agent Skills system
  - Copy builtin skills to dist and fix list display format
  - Use ESM-compatible __dirname for NodeNext module
  - Inject skill content into LLM context instead of preview

### Fixed
- **Issue 057**: Align skill command format with pi-mono design
- **Issue 056**: Implement skills progressive disclosure mechanism
- Hide deprecated /skills from help output
- Use cross-platform Node.js commands for Windows compatibility

### Documentation
- Added pi-mono reference documentation for skill system
- Updated FEATURE_006_TEST_GUIDE for Issue 057
- Updated test guide for help output fix

---

## [0.4.7] - 2026-02-14

### Added
- **Feature 009**: Architecture refactor - AI layer + permission separation
  - Pattern-based tool permission control (Bash-only)
  - 4-level permission control system (Feature 008)
  - Protected path check for bash commands

### Fixed
- **Issue 052**: Complete protected path check for bash commands
- **Issue 051**: Show cancellation feedback when user rejects permission

### Documentation
- Marked TC-009 and TC-010 as passed
- Added architecture refactor design document

---

## [0.4.6] - 2026-02-13

### Added
- **Feature 008**: Permission control system
  - 4-level permission control system
  - Pattern-based permission control

### Fixed
- **Issue 001**: Remove unused PLAN_GENERATION_PROMPT constant
- **Issue 047/048**: Streaming flicker and message disorder
- **Issue 046**: Session restore display issues
- Hide tool_use/tool_result blocks in history display
- React state sync issue in useTextBuffer (Issue 036)
- ExtractTextContent now handles thinking/tool_use blocks

### Changed
- Implemented English-first bilingual comment style (Issue 005)

---

## [0.4.5] - 2026-02-12

### Fixed
- **Issue 019**: Full Session ID display
- **Issue 045**: Thinking content persistence during response
- **Issue 016**: InkREPL component refactoring
- **Issue 011/012**: 命令预览长度 + ANSI Strip 性能
- **Issue 010**: 非空断言缺乏显式检查

### Changed
- Improved input prompt UX

---

## [0.4.4] - 2026-02-11

### Fixed
- **Issue 045**: Spinner 问答顺序颠倒

### Documentation
- Added gray-matter dependency and YAML parsing details to v0.5.0 design

---

## [0.4.3] - 2026-02-10

### Fixed
- **Issue 040**: REPL display problems
  - Capture command output to history for correct render order
  - Strip ANSI codes from captured command output

### Changed
- Restored ANSI colors in command output

### Documentation
- Updated README and CHANGELOG for monorepo architecture
- Added v0.5.0 feature planning - Skills system and Theme improvements

---

## [0.4.2] - 2026-02-09

### Fixed
- **Issue 040**: REPL display problems

---

## [0.4.1] - 2026-02-08

### Changed
- Complete monorepo restructuring

---

## [0.4.0] - 2026-02-07

### Added
- **Architecture Refactoring**
  - Monorepo architecture with packages/
  - @kodax/core package
  - @kodax/repl package
  - CLI and REPL modules separation

### Changed
- Renamed cli/ to common/ for clarity
- Complete v0.4.0 architecture refactoring

---

## [0.3.7] - 2026-02-06

### Changed
- **Phase 2**: Create packages directory structure
- **Phase 1**: Split kodax_cli.ts into storage.ts and cli-events.ts
- **Phase 0**: Remove kodax_core.ts, migrate to modular structure

---

## [0.3.6] - 2026-02-05

### Fixed
- **Issue 044**: Pass AbortSignal to SDK for instant Ctrl+C interruption

---

## [0.3.5] - 2026-02-04

### Fixed
- **Issue 043**: Implement AbortSignal propagation for stream interruption

---

## [0.3.4] - 2026-02-03

### Added
- REPL code review issues analysis (035-039)
- v0.4.0 architecture refactoring roadmap

### Fixed
- **Issue 035/041/042**: Keyboard input issues
- Improve type safety in project-commands.ts
- Improve error handling in project-storage.ts

### Documentation
- Integrated issues 037/039 into v0.4.0 feature design
- Updated KNOWN_ISSUES.md to new skill format with version tracking
- Restructure feature docs to new feature-list-tracker format

---

## [0.3.3] - 2026-02-02

### Added
- **Phase 6**: UIStateContext and KeypressContext
- **Phase 5**: UX enhancements
  - Full ASCII art logo and enhanced Banner
  - Compact header after first interaction
  - Full session ID display

### Fixed
- Streaming display and banner fixes
- Remove message list from Ink component to prevent re-rendering
- Print banner before Ink starts to prevent re-rendering
- Keep banner stable to prevent layout shift
- Hide banner on first input to prevent rendering after commands
- Remove fixed height constraint to prevent screen clearing
- Remove empty space when no messages in MessageList
- Replace Unicode chars with ASCII and add terminal height fallback
- Add fallback for terminal height in InkREPL

### Documentation
- Added comprehensive gap analysis vs Gemini CLI
- Updated Phase 5.4 documentation with actual implementation
- Added Phase 5 UI improvement requirements

---

## [0.3.2] - 2026-02-01

### Fixed
- High priority issues #25, #26, #27

---

## [0.3.1] - 2026-01-31

### Added
- **Ink-based Interactive UI** with --ink flag
  - Phase 1-4 interactive UI improvements
- **Ask mode** and **Plan mode** with refactored state management
- `/project` command for long-running task management
- Comprehensive help system for REPL and CLI commands
- Auto mode safety checks for operations outside project

### Fixed
- Character doubling caused by dual readline instances

### Changed
- **3-layer Architecture** with independent Core layer
- Refactored CLI interface to align with Claude Code conventions

### Documentation
- Updated feature docs and DESIGN.md with Ask/Plan mode

---

## [0.3.0] - 2026-01-30

### Added
- KODAX ASCII art logo
- Session delete mechanism
- Character count display to tool input progress
- Provider/model display and switch commands in interactive mode

### Fixed
- Logo alignment and styling
- Load config before CLI defaults to enable config priority
- Add model, thinking, noconfirm to help display
- Add delete command to help display
- Remove CLI default for provider to allow config file priority

---

## [0.2.5] - 2026-01-29

### Added
- Provider/model display and switch commands in interactive mode

---

## [0.2.4] - 2026-01-28

### Added
- Dynamic version reading from package.json

---

## [0.2.3] - 2026-01-27

### Fixed
- Shell command skip logic (Warp style) and added tests

---

## [0.2.2] - 2026-01-26

### Added
- Shell command execution with ! prefix in interactive mode

### Fixed
- Multiple critical and moderate bugs found during code review
- Critical bugs in interactive mode multi-round conversation
- Spinner animation timing issues in CLI layer
- Spinner display and removed extra newlines

### Changed
- [thinking] → [Thinking]

### Tests
- Comprehensive tests for error types and handling
- Comprehensive tests for interactive module and CLI options
- Reorganized tests into core and cli modules
- Added comprehensive test suite with prompt verification

### Documentation
- Added detailed architecture and usage documentation

---

## [0.2.0] - 2026-01-25

### Changed
- **Core/CLI separation** architecture

### Fixed
- Stop spinner when COMPLETE signal breaks the loop

---

## [0.1.0] - 2026-01-24

### Fixed
- Spinner display improvements
  - Only newline once when creating spinner to avoid empty lines
  - Add newline before creating spinner to prevent content overwrite
  - Remove newlines from thinking preview to prevent display issues
  - Stop spinner when tool_use block ends
