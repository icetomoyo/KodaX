# KodaX

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is the TypeScript + Node.js version of KodaXP, supporting 7 LLM providers with a modular architecture.

**Core Philosophy**: Transparent, Flexible, Minimalist

## Architecture

KodaX is now modular:

```
src/
├── kodax_core.ts      # Core library (can be used as npm package)
├── kodax_cli.ts       # CLI entry with UI (spinner, colors)
├── kodax.ts           # Original single-file (kept as reference)
└── index.ts           # Package exports
```

- **kodax_core.ts**: Pure library module with no CLI dependencies
- **kodax_cli.ts**: CLI layer with UI, commands, and user interaction

## Features

- **Modular Architecture**: Use as CLI or as a library
- **7 LLM Providers**: Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding
- **Thinking Mode**: Deep reasoning support
- **Streaming Output**: Real-time response display
- **7 Tools (Skills)**: read, write, edit, bash, glob, grep, undo
- **Session Management**: JSONL format persistent storage
- **Cross-Platform**: Windows/macOS/Linux

## Installation

### As CLI Tool

```bash
# Clone repository
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX

# Install dependencies
npm install

# Build
npm run build

# Link globally (development mode)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
```

### As Library

```bash
npm install kodax
```

```typescript
import { runKodaX, KodaXClient } from 'kodax';

// Simple usage
const result = await runKodaX({
  provider: 'zhipu-coding',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onComplete: () => console.log('\nDone!'),
  },
}, 'your task');

console.log(result.lastText);
```

## Usage

### CLI Usage

```bash
# Set API Key
export ZHIPU_API_KEY=your_api_key

# Basic usage
kodax "Help me create a TypeScript project"

# Or use node directly
node dist/kodax_cli.js "your task"
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

### Library Usage

#### Simple Mode (runKodaX)

```typescript
import { runKodaX, KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text, charCount) => console.log(`Thinking: ${charCount} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}: ${result.content.slice(0, 100)}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  thinking: true,
  events,
  noConfirm: true,
}, 'What is 1+1?');

console.log(result.lastText);
```

#### Continuous Session (KodaXClient)

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  events: {
    onTextDelta: (t) => process.stdout.write(t),
  },
});

// First message
await client.send('Read package.json');

// Continue same session
await client.send('Summarize it');

console.log(client.getSessionId());
```

#### Custom Session Storage

```typescript
import { runKodaX, KodaXSessionStorage, KodaXMessage } from 'kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // Save to your database
  }
  async load(id: string) {
    // Load from your database
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { ... },
}, 'task');
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
kodax --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "Create a REST API"

# Resume last session
kodax --session resume

# List all sessions
kodax --session list

# Parallel tool execution
kodax --parallel "Read package.json and tsconfig.json"

# Agent Team
kodax --team "Analyze code structure,Check test coverage,Find bugs"

# Long-running project
kodax --init "Build a Todo application"
kodax --auto-continue
```

## Tools (Skills)

| Tool | Description |
|------|-------------|
| read | Read file contents (supports offset/limit) |
| write | Write to file |
| edit | Exact string replacement (supports replace_all) |
| bash | Execute shell commands |
| glob | File pattern matching |
| grep | Content search (supports output_mode) |
| undo | Revert last modification |

## Commands (CLI)

Commands are `/xxx` shortcuts in CLI:

```bash
kodax /review src/auth.ts
kodax /test
```

Commands are stored in `~/.kodax/commands/`:
- `.md` files → Prompt commands (content used as prompt)
- `.ts/.js` files → Programmable commands

## API Exports

```typescript
// Main functions
export { runKodaX, KodaXClient };

// Types
export type {
  KodaXEvents, KodaXOptions, KodaXResult,
  KodaXMessage, KodaXContentBlock,
  KodaXSessionStorage, KodaXToolDefinition
};

// Tools
export { KODAX_TOOLS, KODAX_TOOL_REQUIRED_PARAMS, executeTool };

// Providers
export { getProvider, KODAX_PROVIDERS, KodaXBaseProvider };

// Utilities
export {
  estimateTokens, compactMessages,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal, checkAllFeaturesComplete, getFeatureProgress
};
```

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

## TypeScript Improvements over Python Version

| Feature | Python (KodaXP) | TypeScript (KodaX) |
|---------|-----------------|-------------------|
| **Architecture** | Single file | Modular (Core + CLI) |
| **Library Usage** | No | Yes (npm package) |
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

## Documentation

- [README_CN.md](docs/README_CN.md) - Chinese Documentation
- [DESIGN.md](docs/DESIGN.md) - Architecture and Implementation Details
- [TESTING.md](docs/TESTING.md) - Testing Guide
- [LONG_RUNNING_GUIDE.md](docs/LONG_RUNNING_GUIDE.md) - Long-Running Mode Guide

## License

MIT
