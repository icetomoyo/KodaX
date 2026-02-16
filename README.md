# KodaX

Extreme Lightweight Coding Agent - TypeScript Single-File Implementation

## Overview

KodaX is the TypeScript + Node.js version of KodaXP, implemented in a single file (~1800 LOC), supporting 7 LLM providers.

**Core Philosophy**: Transparent, Flexible, Minimalist

## Features

- **Single-File Implementation**: All code in `src/kodax.ts`, easy to read and customize
- **7 LLM Providers**: Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding
- **Thinking Mode**: Deep reasoning support
- **Streaming Output**: Real-time response display
- **7 Tools**: read, write, edit, bash, glob, grep, undo
- **Session Management**: JSONL format persistent storage
- **Cross-Platform**: Windows/macOS/Linux

## Installation

```bash
# Clone repository
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# Install dependencies
npm install

# Build
npm run build

# Run
node dist/kodax.js "your task"
```

### Global Installation (Recommended)

Install as a global command-line tool (similar to `uv tool install -e .` in Python):

```bash
# Build first
npm run build

# Link globally (editable mode - code changes take effect after rebuild)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
kodax --provider kimi-code "help me write code"

# Uninstall
npm unlink -g kodax
```

**Comparison with Python version:**

| Python (KodaXP) | TypeScript (KodaX) | Description |
|-----------------|-------------------|-------------|
| `uv tool install -e .` | `npm link` | Local dev install, code changes work |
| `uv tool install .` | `npm install -g .` | Global install |
| `uv tool uninstall kodaxp` | `npm unlink -g kodax` | Uninstall |
| `kodaxp "task"` | `kodax "task"` | Run command |

## Usage

### Basic Usage

```bash
# Set API Key
export ZHIPU_API_KEY=your_api_key

# Run
node dist/kodax.js "Help me create a TypeScript project"

# Or use npm
npm start "Help me create a TypeScript project"
```

### CLI Options

```
--provider <name>   LLM provider (default: zhipu-coding)
--thinking          Enable thinking mode
--no-confirm        Disable all confirmations
--session <id>      Session: resume, list, or specific ID
--parallel          Parallel tool execution
--team <tasks>      Run multiple agents in parallel
--init <task>       Initialize long-running project
--auto-continue     Auto-continue until complete
--max-iter <n>      Maximum iterations (default: 50)
--max-sessions <n>  Maximum sessions for --auto-continue (default: 50)
--max-hours <h>     Maximum hours for --auto-continue (default: 2.0)
```

### Providers

| Provider | Environment Variable | Thinking | Default Model |
|----------|---------------------|----------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Yes | claude-sonnet-4-20250514 |
| openai | `OPENAI_API_KEY` | No | gpt-4o |
| kimi | `KIMI_API_KEY` | No | moonshot-v1-128k |
| kimi-code | `KIMI_API_KEY` | Yes | k2p5 |
| qwen | `QWEN_API_KEY` | No | qwen-max |
| zhipu | `ZHIPU_API_KEY` | No | glm-4-plus |
| zhipu-coding | `ZHIPU_API_KEY` | Yes | glm-5 |

### Examples

```bash
# Use Zhipu Coding
node dist/kodax.js --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
node dist/kodax.js --provider openai "Create a REST API"

# Resume last session
node dist/kodax.js --session resume

# List all sessions
node dist/kodax.js --session list

# Parallel tool execution
node dist/kodax.js --parallel "Read package.json and tsconfig.json"

# Agent Team
node dist/kodax.js --team "Analyze code structure,Check test coverage,Find bugs"

# Long-running project
node dist/kodax.js --init "Build a Todo application"
node dist/kodax.js --auto-continue
```

## Tools

| Tool | Description |
|------|-------------|
| read | Read file contents (supports offset/limit) |
| write | Write to file |
| edit | Exact string replacement (supports replace_all) |
| bash | Execute shell commands |
| glob | File pattern matching |
| grep | Content search (supports output_mode) |
| undo | Revert last modification |

## TypeScript Improvements over Python Version

| Feature | Python (KodaXP) | TypeScript (KodaX) |
|---------|-----------------|-------------------|
| **Waiting Animation** | Leaves dots in terminal | Clears with `\r`, cleaner |
| **Spinner Instant Render** | Waits 80ms for first frame | Renders immediately, no visual gap |
| **Environment Context** | Platform only | Includes Node version + platform-specific command hints |
| **Cross-Platform Commands** | Static `pwd` and `mkdir -p` | Dynamic hints for Windows/Unix |
| **Working Directory** | Project name only | Full path injected |
| **read Tool** | Basic | offset/limit parameters |
| **grep Tool** | Basic | output_mode parameter |
| **edit Tool** | Single replacement | replace_all parameter |
| **Type Safety** | Runtime | Compile-time |
| **Async** | asyncio + threading | async/await |

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build
npm run build

# Run tests
npm test

# Clean
npm run clean
```

## Documentation

- [README_CN.md](docs/README_CN.md) - Chinese Documentation
- [DESIGN.md](docs/DESIGN.md) - Architecture and Implementation Details
- [TESTING.md](docs/TESTING.md) - Testing Guide
- [LONG_RUNNING_GUIDE.md](docs/LONG_RUNNING_GUIDE.md) - Long-Running Mode Guide

## Correspondence with KodaXP

KodaX is the TypeScript port of KodaXP with full feature parity:

- `kodaxp.py` (Python) → `src/kodax.ts` (TypeScript)
- ~2000 LOC Python → ~1800 LOC TypeScript
- `uv run kodaxp.py` → `node dist/kodax.js`

## License

MIT
