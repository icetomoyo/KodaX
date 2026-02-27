# KodaX

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is the TypeScript + Node.js version of KodaXP, supporting 7 LLM providers with a modular architecture.

**Core Philosophy**: Transparent, Flexible, Minimalist

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces:

```
KodaX/
├── packages/
│   ├── core/              # @kodax/core - Pure AI engine
│   │   ├── src/
│   │   │   ├── providers/ # 7 LLM providers
│   │   │   ├── tools/     # Tool definitions & execution
│   │   │   └── session/   # Session management
│   │   └── package.json
│   │
│   └── repl/              # @kodax/repl - Interactive terminal
│       ├── src/
│       │   ├── ui/        # Ink components, themes
│       │   └── interactive/ # Commands, REPL logic
│       └── package.json
│
├── src/
│   └── kodax_cli.ts       # Main CLI entry point
│
└── package.json           # Root workspace config
```

### Package Structure

| Package | Purpose | Dependencies |
|---------|---------|--------------|
| `@kodax/core` | Environment-agnostic AI engine | anthropic-sdk, openai |
| `@kodax/repl` | Complete interactive terminal | ink, react, chalk |
| `kodax` (root) | CLI entry, combines both | @kodax/core, @kodax/repl |

### Two Usage Modes

```
┌─────────────────────────────────────────────────────────────┐
│  Mode 1: CLI Command Line                                   │
│                                                              │
│  kodax "your task"                                           │
│                                                              │
│  Entry: package.json "bin" → dist/kodax_cli.js              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Mode 2: Library Import                                      │
│                                                              │
│  import { runKodaX } from '@kodax/core';                    │
│                                                              │
│  Entry: packages/core/dist/index.js                          │
└─────────────────────────────────────────────────────────────┘
```

### package.json Key Fields

```json
{
  "main": "dist/index.js",           // Library entry (for import)
  "bin": {
    "kodax": "./dist/kodax_cli.js"   // CLI entry (for command line)
  },
  "workspaces": [
    "packages/*"                      // Monorepo packages
  ]
}
```

| Field | Purpose | Trigger |
|-------|---------|---------|
| `"main"` | Library entry | `import from 'kodax'` |
| `"bin"` | Command entry | `kodax "task"` or `npm link` |
| `"workspaces"` | Monorepo | `npm install` links packages |

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

# Install dependencies (includes workspace packages)
npm install

# Build all packages
npm run build:packages
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

### Session Mode (With Memory)

```bash
# Start a session with specific ID
kodax --session my-project "Read package.json"

# Continue same session (has context memory)
kodax --session my-project "Summarize it"

# List all sessions
kodax --session list

# Resume last session
kodax --session resume "continue"
```

### No Memory vs With Memory

```bash
# ❌ No memory: two independent calls
kodax "Read src/auth.ts"           # Agent reads and responds
kodax "Summarize it"               # Agent doesn't know what to summarize

# ✅ With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"        # Agent knows to summarize auth.ts
kodax --session auth-review "How to fix first issue"  # Agent has context
```

### Common Scenarios

```bash
# Code review (multi-turn conversation)
kodax --session review "Review src/ directory"
kodax --session review "Focus on security issues"
kodax --session review "Give me fix suggestions"

# Project development (continuous session)
kodax --session todo-app "Create a Todo application"
kodax --session todo-app "Add delete functionality"
kodax --session todo-app "Write tests"
```

### CLI Options

```
-h, --help [topic]  Show help, or detailed help for a topic
--provider <name>   LLM provider (default: zhipu-coding)
--thinking          Enable thinking mode
--no-confirm        Enable auto mode (skip all confirmations)
--session <id>      Session: resume, list, or specific ID
--parallel          Parallel tool execution
--team <tasks>      Run multiple agents in parallel
--init <task>       Initialize long-running project
--auto-continue     Auto-continue until complete
--max-iter <n>      Maximum iterations (default: 50)
--max-sessions <n>  Maximum sessions for --auto-continue (default: 50)
--max-hours <h>     Maximum hours for --auto-continue (default: 2.0)
```

### CLI Help Topics

Get detailed help for specific topics:

```bash
# Basic help
kodax -h
kodax --help

# Detailed topic help
kodax -h sessions      # Session management details
kodax -h init          # Long-running project initialization
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning mode
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
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
  auto: true,
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

### Library Modes Comparison

| Feature | runKodaX | KodaXClient |
|---------|----------|-------------|
| **Message Memory** | ❌ No | ✅ Yes |
| **Call Style** | Function | Class instance |
| **Context** | Independent each time | Accumulates |
| **Use Case** | Single tasks, batch processing | Interactive dialogue, multi-step tasks |

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

## Code Style

### Comment Guidelines

KodaX uses a **English-first** comment style with selective Chinese brief notes for complex logic.

#### Rules

| Situation | Style | Example |
|-----------|-------|---------|
| Import/Export | English only | `// Import dependencies` |
| Simple constants | English only | `// Max retry count` |
| Simple logic | English only | `// Return if null` |
| **Business rules** | English + Chinese | `// Skip tool_result - 跳过工具结果块` |
| **Platform compatibility** | English + Chinese | `// Windows path handling - Windows 路径处理` |
| **Performance optimization** | English + Chinese | `// Debounce to prevent flicker - 防抖避免闪烁` |
| **Complex algorithms** | English + Chinese | Multi-line explanation |

#### Examples

```typescript
// ========== English ONLY (simple/obvious logic) ==========

// Import dependencies
import { foo } from 'bar';

// Default timeout in milliseconds
const DEFAULT_TIMEOUT = 5000;

// Initialize state
const [count, setCount] = useState(0);

// Clear the timer
clearInterval(timer);

// Return early if empty
if (!items.length) return;

// ========== English + Chinese brief (complex/business logic) ==========

// Validate session before resuming - 验证会话有效性后才恢复
// 避免加载损坏的会话文件导致运行时错误
if (session && !validateSession(session)) {
  return null;
}

// Batch updates to reduce render frequency - 批量更新减少渲染频率
// 解决流式输出时 Ink reconciler 每字符触发重渲染的问题
const FLUSH_INTERVAL = 80;

/**
 * Extracts text content from various message block types
 * 从各类消息块中提取文本内容
 *
 * Note: thinking blocks are internal AI reasoning and should not be displayed
 * 注意：thinking 块是 AI 内部思考，不应显示给用户
 */
function extractTextContent(block: MessageBlock): string { ... }
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
