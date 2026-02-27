# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.6] - 2026-02-27

### Added
- **Permission Mode Auto-Switch**: Automatically switch to accept-edits mode when user selects "always" in default mode
- **Plan Mode Context**: System prompt informs LLM about read-only constraints in plan mode
- **Diff Display**: Show unified diff for write/edit operations
- **Warp.dev Theme**: New dark theme inspired by Warp.dev terminal (cyan accent, deep dark backgrounds)

### Changed
- **Config Location**: "Always yes" now saves to project-level config (`.kodax/config.local.json`)
- **Plan Mode Blocking**: Modification tools (write/edit/bash/undo) are directly blocked in plan mode without user confirmation dialog

### Fixed
- Permission mode persistence now correctly uses project-level configuration

## [0.4.5] - 2026-02-26

### Changed
- **Code Style**: Implemented English-first bilingual comment style for repl package
- Comments are primarily in English with selective Chinese brief notes for complex logic

## [0.4.4] - 2026-02-26

### Fixed
- Issue 047: Streaming flicker during output
- Issue 048: Message disorder in REPL display
- Issue 001: Removed unused PLAN_GENERATION_PROMPT constant

## [0.4.3] - 2026-02-25

### Fixed
- Issue 040: REPL display ordering - command output now renders in correct position (user message → command output)
- Console.log capture mechanism to preserve chalk colors while fixing render order

## [0.4.2] - 2026-02-25

### Fixed
- Issue 043: AbortSignal propagation for stream interruption
- Issue 044: Ctrl+C delay during streaming output

## [0.4.1] - 2026-02-24

### Fixed
- Issue 035, 041, 042: Keyboard input issues (Backspace, history navigation, Shift+Enter)

## [0.4.0] - 2026-02-24

### Changed
- **Architecture Refactoring**: Monorepo with npm workspaces
  - `@kodax/core`: Pure AI engine (7 providers, tools, session management)
  - `@kodax/repl`: Complete interactive terminal experience
  - Main entry `src/kodax_cli.ts` uses both packages
- **Directory Structure**: Renamed `cli/` to `common/` for better semantics

### Fixed
- Issue 035, 041, 042: Keyboard input issues (Backspace, history navigation, Shift+Enter)
- Issue 043: AbortSignal propagation for stream interruption
- Issue 044: Ctrl+C delay during streaming output

### Known Issues
- Issue 040: REPL display issues (banner timing, duplicate messages, [Complex content] placeholder)

## [0.2.0] - 2026-02-16

### Changed
- **Architecture Refactoring**: Split into Core + CLI modules
  - `kodax_core.ts`: Pure library module (can be used as npm package)
  - `kodax_cli.ts`: CLI entry with UI (spinner, colors, readline)
  - `index.ts`: Package entry point
  - Original `kodax.ts` kept as reference

### Added
- **Event-driven API**: `KodaXEvents` interface for streaming callbacks
- **Library API**: Can now use KodaX as an npm package
  - `runKodaX()` function for simple usage
  - `KodaXClient` class for continuous sessions
- **Session Storage Interface**: `KodaXSessionStorage` for custom storage backends
- **Commands System**: `/xxx` commands in CLI layer (replaces previous "Skills" naming)
- **Comprehensive Test Suite**: 135 tests across 3 test files
  - `kodax_core.test.ts`: Core module tests (82 tests)
  - `kodax_cli.test.ts`: CLI layer tests (20 tests)
  - `prompts.test.ts`: Prompt content verification tests (33 tests)

### Terminology
- **Skills** = Model capabilities (KODAX_TOOLS: read, write, bash, etc.) - in Core
- **Commands** = CLI shortcuts (/review, /test, etc.) - in CLI layer

### Exports
- `runKodaX` - Main function to run agent
- `KodaXClient` - Class for continuous sessions
- `KodaXEvents` - Event interface for streaming
- `KodaXOptions` - Options interface
- `KodaXResult` - Result interface
- `KODAX_TOOLS` - Tool definitions
- `getProvider` - Provider factory function
- `executeTool` - Tool execution function
- `compactMessages` - Context compression utility
- `estimateTokens` - Token estimation utility

## [0.1.0] - 2026-02-16

### Added
- Initial release of KodaX (TypeScript version of KodaXP)
- Single-file implementation (~1800 LOC)
- 7 LLM providers support: Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding
- Thinking mode for deep reasoning (anthropic, kimi-code, zhipu-coding)
- Streaming output with real-time display
- 7 tools: read, write, edit, bash, glob, grep, undo
- Session management with JSONL format persistent storage
- Cross-platform support: Windows/macOS/Linux
- Long-running mode with `--init` and `--auto-continue`
- Parallel tool execution with `--parallel`
- Multi-agent team mode with `--team`
- Skills system for custom extensions

### TypeScript Improvements over Python Version
- **Waiting Animation**: Uses `\r` to clear, no terminal traces
- **Spinner Instant Render**: First frame renders immediately (no 80ms wait)
- **Environment Context**: Includes Node version + platform-specific command hints
- **Cross-Platform Commands**: Dynamic hints for Windows/Unix (mkdir, pwd, etc.)
- **Working Directory**: Full path injected to avoid LLM guessing wrong paths
- **read Tool**: Supports offset/limit parameters
- **grep Tool**: Supports output_mode parameter (content/files_with_matches/count)
- **edit Tool**: Supports replace_all parameter for batch replacement
- **Type Safety**: Compile-time error checking
- **Async/Await**: Cleaner asynchronous code structure

### Fixed
- Cross-platform mkdir command (Windows vs Unix)
- Cross-platform pwd command (cd on Windows, pwd on Unix)
- Working directory path injection for LLM context
- Spinner visual feedback during tool execution
- Multiple newline issue with spinner
- Spinner not stopping when task completes
- Frequent incomplete tool calls by increasing MAX_TOKENS to 32768
