# Changelog

All notable changes to this project will be documented in this file.

## [0.5.24] - 2026-03-08

### Added
- **Context Usage Display** (Issue 070)
  - Status bar now shows real-time context token usage with color-coded progress bar
  - Green (< 50%): Safe zone
  - Yellow (50-75%): Warning zone
  - Red (≥ 75%): Critical zone - should trigger compaction
  - Banner displays context window size and compaction settings

### Fixed
- **Duplicate Message Issue**
  - Fixed ghost `[Interrupted]` messages appearing on new submissions
  - Added `clearResponse()` in finally block to clear stale buffer
  - Added concurrent execution prevention (`isLoading || confirmRequest` guard)
- **Agent Improvements**
  - Prevented duplicate message push into context
  - Unified intelligent compaction (removed legacy truncation fallback)
  - Added API hard timeout protection (3 minutes) to prevent infinite waits
  - Added basic safety threshold (100k tokens) for compaction

### Changed
- Banner now shows context window (e.g., "Context: 200k") and compaction status
- Compaction info loaded before Ink app renders to ensure banner displays correctly

## [0.5.23] - 2026-03-08

### Added
- **CLI Events Module** (`packages/ai/src/cli-events/`)
  - `types.ts` - Unified CLI event types (CLIEvent union)
  - `executor.ts` - Base CLIExecutor class with subprocess management
  - `gemini-parser.ts` - Gemini CLI JSON Lines parser
  - `codex-parser.ts` - Codex CLI JSON Lines parser
  - `session.ts` - CLISessionManager for KodaX↔CLI session mapping
  - `prompt-utils.ts` - Shared prompt building utility
  - `index.ts` - Barrel export

### Changed
- **gemini-cli provider** - Refactored to use CLI subprocess wrapper pattern
- **codex-cli provider** - Refactored to use CLI subprocess wrapper pattern
- Both providers now use `buildCLIPrompt()` shared utility
- Added stderr collection for error diagnostics
- Added `_installedCache` to avoid repeated spawn checks
- Added `exited` flag to prevent duplicate `child.kill()`

### Architecture
- **Delegate Pattern**: Tools are executed by CLI, not KodaX agent
- **Session Resume**: Multi-turn conversations via CLI session mapping
- **Zero Maintenance**: No need to track token format changes

### Documentation
- Added `FEATURE_016_CLI_PROVIDERS_TEST_GUIDE.md`
- Updated `v0.5.22.md` design document

## [0.5.22] - 2026-03-08

### Added
- CLI-based OAuth providers (gemini-cli, codex-cli) initial implementation

## [0.5.21] - 2026-03-08

### Fixed
- Chunked compression to avoid TPM rate limits
- Loop logic in cleanupIncompleteToolCalls
- Added ask-user-question tool

## [0.5.20] - 2026-03-07

### Added
- Project mode commands
- Context snapshot functionality
- Hot/cold track dual-track memory system
