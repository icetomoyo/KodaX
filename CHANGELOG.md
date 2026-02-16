# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
