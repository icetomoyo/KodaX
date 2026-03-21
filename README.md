# KodaX

[English](README.md) | [中文](README_CN.md)

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is a **modular, lightweight AI coding agent** built with TypeScript. It supports **10 LLM providers**, works as both a CLI tool and a library, and includes a distinctive **Project Mode / harness engineering** workflow for long-running coding tasks.

**Core Philosophy**: Transparent, Flexible, Minimalist

**Why KodaX?**

| Question | KodaX answer |
|---------|--------------|
| Why not only use Claude Code? | KodaX is easier to inspect, modify, self-host, and switch across providers. |
| Why not only use an SDK? | KodaX already gives you a CLI, sessions, tools, permissions, and skills out of the box. |
| Why use it as a codebase? | The architecture is small enough to understand and customize without wading through thousands of files. |
| Why use it in production tools? | The packages are separated cleanly, so you can reuse only the layer you need. |

**KodaX vs hosted coding assistants**

| Feature | KodaX | Typical hosted coding assistant |
|---------|-------|----------------------------------|
| **Architecture** | Modular (5 packages), library-friendly | Usually product-first, less reusable as code |
| **Provider choice** | 10 providers, custom provider support | Often optimized for one provider |
| **Customization** | Edit prompts, tools, skills, session flow directly | Limited extension surface |
| **Codebase clarity** | Small TypeScript monorepo | Often much larger and harder to trace |
| **Learning value** | Good for understanding agent internals | More black-box |

## Quick Start

### 1. Install and build the CLI

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
npm run build:packages
npm run build
npm link
```

### 2. Configure a provider

KodaX reads API keys from environment variables. For built-in providers, the fastest path is:

```bash
# macOS / Linux
export ZHIPU_API_KEY=your_api_key

# PowerShell
$env:ZHIPU_API_KEY="your_api_key"
```

For CLI defaults, create `~/.kodax/config.json`:

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto"
}
```

If you need a custom base URL or an OpenAI/Anthropic-compatible endpoint, define a custom provider in the same config file:

```json
{
  "provider": "my-openai-compatible",
  "customProviders": [
    {
      "name": "my-openai-compatible",
      "protocol": "openai",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_LLM_API_KEY",
      "model": "my-model"
    }
  ]
}
```

### 3. Start in REPL or run a one-shot task

```bash
# Interactive REPL
kodax

# Then ask naturally inside the REPL
Read package.json and summarize the architecture
/mode
/help

# Project Mode / harness engineering
kodax --init "Desktop app"
kodax
/project brainstorm
/project plan
/project next

# One-shot CLI usage
kodax "Review this repository and summarize the architecture"
kodax --session review "Find the riskiest parts of src/"
kodax --session review "Give me concrete fix suggestions"
```

### 4. Use it as a library

Library usage still expects API keys from environment variables. If you want custom provider names or base URLs in code, register them explicitly:

```typescript
import { registerCustomProviders, runKodaX } from 'kodax';

registerCustomProviders([
  {
    name: 'my-openai-compatible',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    apiKeyEnv: 'MY_LLM_API_KEY',
    model: 'my-model',
  },
]);

const result = await runKodaX(
  {
    provider: 'my-openai-compatible',
    reasoningMode: 'auto',
  },
  'Explain this codebase'
);
```

## Core Workflows

- **CLI coding assistant**: run one-off tasks or stay in a session for multi-step work.
- **Skills-driven workflows**: trigger built-in or custom skills from natural language.
- **Project Mode / harness engineering**: bootstrap a long-running project, keep project truth on disk, and execute through verifier-gated `/project` flows.
- **Embeddable library**: reuse the provider layer, session layer, or full coding agent in your own app.

## Project Mode

KodaX's most opinionated feature is **Project Mode**: a harness-engineering workflow for long-running coding projects.

Instead of letting the agent self-report "done", Project Mode keeps project truth on disk and pushes execution through deterministic verification loops. The workflow spans both non-REPL bootstrap commands and REPL `/project` commands.

**What makes it different**

- **Verifier-gated execution**: `/project next` and `/project auto` are checked by a harness instead of trusting self-declared completion.
- **Project truth files**: initialization creates and updates project management artifacts such as `feature_list.json` and files under `.agent/project/`.
- **Structured planning**: `/project brainstorm` aligns requirements and `/project plan` writes the active execution plan.
- **Quality checkpoints**: `/project quality` and `/project verify` rerun deterministic checks before you trust a stage as complete.

**Typical flow**

```bash
kodax --init "Desktop app"
kodax
/project brainstorm
/project plan
/project next
/project quality
```

**Non-REPL alternative**

```bash
kodax --init "Desktop app"
kodax --auto-continue --max-hours 2
```

---

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces, consisting of 5 packages:

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - Independent LLM abstraction layer
│   │   └── providers/       # 10 LLM providers (Anthropic, OpenAI, etc.)
│   │
│   ├── agent/               # @kodax/agent - Generic Agent framework
│   │   └── session/         # Session management, message handling
│   │
│   ├── skills/              # @kodax/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # 8 tools: read, write, edit, bash, glob, grep, undo, ask_user_question
│   │
│   └── repl/                # @kodax/repl - Interactive terminal UI
│       ├── ui/              # Ink/React components, themes
│       └── interactive/     # Commands, REPL logic
│
├── src/
│   └── kodax_cli.ts         # Main CLI entry point
│
└── package.json             # Root workspace config
```

### Package Dependencies

```
                    ┌─────────────────┐
                    │   kodax (root)  │
                    │   CLI Entry     │
                    └────────┬────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
       ┌─────────────┐               ┌─────────────┐
       │ @kodax/repl │               │@kodax/coding│
       │  UI Layer   │               │ Tools+Prompts│
       └──────┬──────┘               └──────┬──────┘
              │                             │
              │              ┌──────────────┼──────────────┐
              │              │              │              │
              ▼              ▼              ▼              ▼
       ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
       │@kodax/skills│ │ @kodax/agent│ │  @kodax/ai  │ │  External   │
       │(zero deps)  │ │Agent Frame  │ │LLM Abstract │ │   SDKs      │
       └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

### Package Overview

| Package | Purpose | Key Dependencies |
|---------|---------|------------------|
| `@kodax/ai` | Independent LLM abstraction, reusable by other projects | @anthropic-ai/sdk, openai |
| `@kodax/agent` | Generic Agent framework, session management | @kodax/ai, js-tiktoken |
| `@kodax/skills` | Skills standard implementation | Zero external deps |
| `@kodax/coding` | Coding Agent with tools and prompts | @kodax/ai, @kodax/agent, @kodax/skills |
| `@kodax/repl` | Complete interactive terminal UI | @kodax/coding, ink, react |

---

## Features

- **Modular Architecture** - Use as CLI or as a library
- **10 LLM Providers** - Anthropic, OpenAI, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding, MiniMax Coding, Gemini CLI, Codex CLI
- **Reasoning Modes** - Unified `off/auto/quick/balanced/deep` interface across providers
- **Streaming Output** - Real-time response display
- **8 Tools** - read, write, edit, bash, glob, grep, undo, ask_user_question
- **Session Management** - JSONL format persistent storage
- **Project Mode / Harness Engineering** - Verifier-gated long-running workflow with project truth files and `/project` commands
- **Skills System** - Natural language triggering, extensible
- **Permission Control** - 3 permission modes with pattern-based control
- **Cross-Platform** - Windows/macOS/Linux
- **TypeScript Native** - Full type safety and IDE support

---

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
import { runKodaX } from 'kodax';

process.env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY ?? 'your_api_key';

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
    onComplete: () => console.log('\nDone!'),
  },
}, 'your task');

console.log(result.lastText);
```

For CLI users, provider defaults live in `~/.kodax/config.json`. For library users, API keys are still read from environment variables; if you need custom base URLs or provider aliases, use `registerCustomProviders()` as shown above.

---

## Usage

### REPL Quickstart

Running `kodax` with no prompt starts the interactive REPL.

```bash
kodax
```

Inside the REPL you can type normal requests or slash commands:

```text
Read package.json and summarize the architecture
/model
/mode
/help
```

### CLI Quickstart

```bash
# Set API key
export ZHIPU_API_KEY=your_api_key

# Basic usage
kodax "Help me create a TypeScript project"

# Choose a provider explicitly
kodax --provider openai --model gpt-5.4 "Create a REST API"

# Use a deeper reasoning mode
kodax --reasoning deep "Review this architecture"
```

### Session Workflows

Use a session when you want memory across turns. Without a session, each CLI call is independent.

```bash
# No memory: two separate calls
kodax "Read src/auth.ts"
kodax "Summarize it"

# With memory: same session
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"
kodax --session my-project "How should I fix the first issue?"

# Session management
kodax --session list
kodax --session resume "continue"
```

### Session Patterns

```bash
# ❌ No memory: two independent calls
kodax "Read src/auth.ts"           # Agent reads and responds
kodax "Summarize it"               # Agent doesn't know what to summarize

# ✅ With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"        # Agent knows to summarize auth.ts
kodax --session auth-review "How to fix first issue"  # Agent has context
```

### Workflow Examples

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

### Project Mode / Harness Engineering

Project Mode combines bootstrap commands with REPL-side `/project` commands:

```bash
# Bootstrap project truth
kodax --init "Build a desktop app"

# Enter REPL and use verifier-gated project commands
kodax
/project status
/project brainstorm
/project plan
/project next
/project verify --last
/project quality

# Or let the non-REPL loop keep going
kodax --auto-continue --max-hours 2
```

### CLI Reference

```text
kodax                    Start the interactive REPL
-h, --help [topic]   Show help or topic help
-p, --print <text>   Run a single task and exit
-c, --continue       Continue the most recent conversation in this directory
-r, --resume [id]    Resume a session by ID, or the latest session
-m, --provider       Provider to use
--model <name>       Override the model
--reasoning <mode>   off | auto | quick | balanced | deep
-t, --thinking       Compatibility alias for --reasoning auto
-s, --session <op>   Session ID or legacy session operation
-j, --parallel       Enable parallel tool execution
--team <tasks>       Run multiple sub-agents in parallel
--init <task>        Initialize a long-running task
--auto-continue      Continue long-running tasks until complete
--max-iter <n>       Max iterations
--max-sessions <n>   Max sessions for --auto-continue
--max-hours <n>      Max runtime hours for --auto-continue
```

### Permission Control

KodaX provides 3 permission modes for fine-grained control:

| Mode | Description | Tools Need Confirmation |
|------|-------------|------------------------|
| `plan` | Read-only planning mode | All modification tools blocked |
| `accept-edits` | Auto-accept file edits | bash only |
| `auto-in-project` | Full auto within project | None (project-scoped) |

```bash
# In REPL, use /mode command
/mode plan          # Switch to plan mode (read-only)
/mode accept-edits  # Switch to accept-edits mode
/mode auto-in-project  # Switch to auto-in-project mode
/auto                  # Alias for auto-in-project

# Check current mode
/mode
```

**Features:**
- In `accept-edits` mode, choosing "always" can persist safe Bash allow-patterns
- Plan mode includes system prompt context for LLM awareness
- Permanent protection zones: `.kodax/`, `~/.kodax/`, paths outside project
- Pattern-based permission: Allow specific Bash commands (e.g., `Bash(npm install)`)
- Unified diff display for write/edit operations

### CLI Help Topics

Get detailed help for specific topics:

```bash
# Basic help
kodax -h
kodax --help

# Detailed topic help
kodax -h sessions      # Session management details
kodax -h init          # Long-running project initialization
kodax -h project       # Project mode / harness workflow
kodax -h auto          # Auto-continue mode
kodax -h provider      # LLM provider configuration
kodax -h thinking      # Thinking/reasoning mode
kodax -h team          # Multi-agent parallel execution
kodax -h print         # Print configuration
```

## Advanced Library Usage

#### Simple Mode (runKodaX)

```typescript
import { runKodaX, KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`Thinking delta: ${text.length} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}: ${result.content.slice(0, 100)}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events,
}, 'What is 1+1?');

console.log(result.lastText);
```

#### Continuous Session (KodaXClient)

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
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

---

## Using Individual Packages

KodaX is built with a modular architecture. Each package can be used independently:

### @kodax/ai - LLM Abstraction Layer

Independent LLM provider abstraction, reusable in any project:

```typescript
import { getProvider, KodaXBaseProvider } from '@kodax/ai';

// Get a provider instance
const provider = getProvider('anthropic');

// Stream completion
const stream = await provider.streamCompletion(
  [{ role: 'user', content: 'Hello!' }],
  { onTextDelta: (text) => process.stdout.write(text) }
);

for await (const result of stream) {
  if (result.type === 'text') {
    // Handle text delta
  } else if (result.type === 'tool_use') {
    // Handle tool call
  }
}
```

**Key Features**:
- 10 LLM providers with unified interface
- Streaming output support
- Thinking mode support
- Error handling and retry logic
- Zero business logic dependencies

### @kodax/agent - Agent Framework

Generic agent framework with session management:

```typescript
import {
  generateSessionId,
  estimateTokens,
  compactMessages,
  type KodaXMessage
} from '@kodax/agent';

// Generate session ID
const sessionId = generateSessionId();

// Estimate tokens
const tokens = estimateTokens(messages);

// Compact messages when context is too long
if (tokens > 100000) {
  const compacted = await compactMessages(messages, {
    threshold: 75000,
    keepRecent: 20
  });
}
```

**Key Features**:
- Session ID generation and title extraction
- Token estimation (tiktoken-based)
- Message compaction with AI summarization
- Generic types for messages and tools

### @kodax/skills - Skills System

Agent Skills standard implementation with zero external dependencies:

```typescript
import {
  SkillRegistry,
  discoverSkills,
  executeSkill,
  type SkillContext
} from '@kodax/skills';

// Discover skills from paths
const skills = await discoverSkills(['/path/to/skills']);

// Initialize registry
const registry = getSkillRegistry();
await registry.registerSkills(skills);

// Execute a skill
const context: SkillContext = {
  skillId: 'code-review',
  arguments: { target: 'src/' },
  workingDirectory: process.cwd()
};

const result = await executeSkill(context);
```

**Key Features**:
- Zero external dependencies
- Markdown-based skill files
- Natural language triggering
- Variable resolution
- Built-in skills included

### @kodax/coding - Coding Agent

Complete coding agent with tools and prompts:

```typescript
import { runKodaX, KodaXClient, KODAX_TOOLS } from '@kodax/coding';

// Use runKodaX for single tasks
const result = await runKodaX({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text)
  }
}, 'Read package.json and explain the dependencies');

// Or use KodaXClient for continuous sessions
const client = new KodaXClient({
  provider: 'anthropic',
  reasoningMode: 'auto',
  events: { ... }
});

await client.send('Create a new file');
await client.send('Add a function to it'); // Has context from previous message
```

**Key Features**:
- 8 built-in tools (read, write, edit, bash, glob, grep, undo, ask_user_question)
- System prompts for coding tasks
- Agent loop implementation
- Session management
- Auto-continue mode

### @kodax/repl - Interactive Terminal UI

Complete interactive REPL with Ink/React components:

```typescript
// Usually used as CLI, but can be integrated
import { InkREPL } from '@kodax/repl';

// The REPL package provides:
// - Interactive terminal UI
// - Permission control (4 modes)
// - Command system (/help, /mode, etc.)
// - Skills integration
// - Theme support
```

**Key Features**:
- Ink-based React components
- 3 permission modes
- Built-in commands
- Real-time streaming display
- Context usage indicator

### Package Dependency Graph

```
@kodax/ai (零业务依赖)
    ↓
@kodax/agent (依赖 @kodax/ai)
    ↓
@kodax/skills (零外部依赖)  →  @kodax/coding (依赖 ai, agent, skills)
                                        ↓
                                  @kodax/repl (依赖 coding, ink, react)
```

**Import Recommendations**:

| Use Case | Package | Why |
|----------|---------|-----|
| Only need LLM abstraction | `@kodax/ai` | Minimal dependencies |
| Building custom agent | `@kodax/agent` | Session + messages + tokenization |
| Using skills system | `@kodax/skills` | Zero deps, pure skills |
| Coding tasks | `@kodax/coding` | Complete coding agent |
| Terminal app | `@kodax/repl` | Full interactive experience |

---

| Provider | Environment Variable | Reasoning Support | Default Model |
|----------|----------------------|-------------------|---------------|
| anthropic | `ANTHROPIC_API_KEY` | Native | claude-sonnet-4-6 |
| openai | `OPENAI_API_KEY` | Native | gpt-5.3-codex |
| kimi | `KIMI_API_KEY` | Native | k2.5 |
| kimi-code | `KIMI_API_KEY` | Native | k2.5 |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Native | glm-5 |
| minimax-coding | `MINIMAX_API_KEY` | Native | MiniMax-M2.5 |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

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
kodax --auto-continue --max-hours 2
```

---

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
| ask_user_question | Ask the user to choose between options |

---

## Skills System

KodaX includes a built-in Skills system that can be triggered by natural language:

```bash
# Natural language triggering (no explicit /skill needed)
kodax "帮我审查代码"           # Triggers code-review skill
kodax "写测试用例"             # Triggers tdd skill
kodax "提交代码"               # Triggers git-workflow skill

# Explicit skill command
kodax /skill:code-review
```

Built-in skills include:
- **code-review** - Code review and quality analysis
- **tdd** - Test-driven development workflow
- **git-workflow** - Git commit and workflow automation

Skills are stored in `~/.kodax/skills/` and can be extended with custom skills.

---

## Commands (CLI)

Commands are `/xxx` shortcuts in CLI:

```bash
kodax /review src/auth.ts
kodax /test
```

Commands are stored in `~/.kodax/commands/`:
- `.md` files → Prompt commands (content used as prompt)
- `.ts/.js` files → Programmable commands

---

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

---

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build all packages
npm run build:packages

# Build
npm run build

# Run tests
npm test

# Clean
npm run clean
```

---

## Code Style

### Comment Guidelines

KodaX uses an **English-first** comment style with selective Chinese brief notes for complex logic.

| Situation | Style | Example |
|-----------|-------|---------|
| Import/Export | English only | `// Import dependencies` |
| Simple constants | English only | `// Max retry count` |
| Simple logic | English only | `// Return if null` |
| **Business rules** | English + Chinese | `// Skip tool_result - 跳过工具结果块` |
| **Platform compatibility** | English + Chinese | `// Windows path handling - Windows 路径处理` |
| **Performance optimization** | English + Chinese | `// Debounce to prevent flicker - 防抖避免闪烁` |

---

## Documentation

- [README_CN.md](README_CN.md) - Chinese Documentation
- [DESIGN.md](docs/DESIGN.md) - Architecture and Implementation Details
- [TESTING.md](docs/TESTING.md) - Testing Guide
- [test-guides/](docs/test-guides/) - Feature-specific test guides
- [LONG_RUNNING_GUIDE.md](docs/LONG_RUNNING_GUIDE.md) - Long-Running Mode Guide
- [CHANGELOG.md](CHANGELOG.md) - Version History

---

## License

[Apache License 2.0](LICENSE) - Copyright 2026 [icetomoyo](mailto:icetomoyo@gmail.com)
