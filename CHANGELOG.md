# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Removed clear screen shortcut (Ctrl+L) to avoid display issues
- Enhanced help panel with autocomplete hints (/ for commands, @ for files)
- Help panel now auto-hides when using other shortcuts (Ctrl+T, Ctrl+O)
- Removed console logs from mode/thinking toggle shortcuts

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
