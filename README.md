# InfCodeX

[English](README.md) | [中文](README_CN.md)

**InfCodeX** is Tokfinity's next-generation AI coding CLI and execution-oriented agent runtime for real software engineering.

It is not just a terminal chatbot for code. It is a modular, TypeScript-native system that can run as a CLI, be embedded as a library, and evolve into the execution layer of a larger agent platform.

> Current repository alias and command name: **KodaX / `kodax`**. The repository name is **InfCodeX**, while parts of the codebase and docs still use the historical KodaX naming.

---

## Why InfCodeX

Most AI coding tools optimize for quick demos or single-turn assistance. InfCodeX is built around a different goal: **reliable engineering execution**.

InfCodeX matters because it combines:

- **CLI-first execution** for developers who work in the terminal
- **Agent runtime architecture** instead of a single monolithic app
- **Project-aware continuity** through session memory and long-running task flows
- **Safety and governance** through permission modes and confirmation boundaries
- **Modularity** through reusable packages and clear dependency boundaries
- **Future multi-agent evolution** through parallel execution, team mode, and skills

For Tokfinity, InfCodeX is important not only as a developer tool, but as a **software-engineering execution substrate** that can integrate with the broader **InfOne** intelligent-organization platform.

---

## Positioning

**InfCodeX is a production-oriented AI coding CLI and agent runtime for serious software engineering.**

It serves two roles at the same time:

1. **Developer-facing CLI**
   - inspect repositories
   - read and modify files
   - run commands
   - iterate across multi-step engineering tasks

2. **Platform-facing execution layer**
   - reusable as npm packages
   - suitable for orchestration by higher-level systems
   - extensible with providers, tools, skills, and project policies

---

## Core Highlights

### 1. Modular layered architecture
InfCodeX is structured as a monorepo with five major packages:

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`

This separation is one of the project's strongest differentiators. Each layer has a clear responsibility, and several layers are designed to be independently reusable.

### 2. CLI and library dual use
InfCodeX can be used as:

- a terminal coding agent for day-to-day development
- a library embedded into other products or agent systems

That makes it much more strategic than a purely interactive tool.

### 3. Multi-provider model abstraction
The project exposes a provider abstraction layer and currently documents support for built-in providers such as:

- Anthropic
- OpenAI
- Kimi
- Kimi Code
- Qwen
- Zhipu
- Zhipu Coding
- MiniMax Coding
- Gemini CLI
- Codex CLI

This helps teams avoid hard vendor lock-in and makes the runtime more suitable for cost optimization, regional routing, private deployment, and enterprise model governance.

### 4. Real coding-agent execution loop
InfCodeX is designed around action, not just answer generation. Its coding layer includes tools and an iterative agent loop so the system can work on actual repositories.

Documented built-in tool capabilities include:

- read
- write
- edit
- bash
- glob
- grep
- undo
- diff

### 5. Permission-aware autonomy
InfCodeX introduces three permission modes:

- `plan`
- `accept-edits`
- `auto-in-project`

This is a critical design choice. It lets teams balance safety and efficiency rather than forcing a binary choice between manual mode and unrestricted automation.

### 6. Session memory and long-running work
Real engineering is rarely completed in one turn. InfCodeX supports persistent sessions and long-running workflows so the agent can resume work, preserve context, and move a task forward across multiple steps.

### 7. Skills-driven specialization
The skills layer allows InfCodeX to be specialized beyond generic prompting. It supports built-in skills, discoverable skills, markdown-based skill definitions, and natural-language triggering.

### 8. Native path toward multi-agent workflows
The project already points toward coordinated agent execution through features such as:

- parallel execution
- team mode
- project initialization
- auto-continue

This gives InfCodeX a credible path from "AI CLI" to "multi-agent engineering runtime".

---

## Architecture Overview

```text
InfCodeX
├─ AI Layer        → provider abstraction, streaming, retry, capability handling
├─ Agent Layer     → sessions, messages, token utilities, compaction
├─ Skills Layer    → skill discovery, registry, execution
├─ Coding Layer    → tools, prompts, coding-agent loop, long-running workflows
└─ REPL / CLI      → interactive UX, permission control, commands, project flows
```

This design provides several advantages:

- **Clear separation of concerns**
- **Replaceable boundaries across provider, runtime, and UI layers**
- **Better testability and replacement boundaries**
- **Potential for independent package reuse**
- **A stronger foundation for future enterprise orchestration**

### Package Overview

| Package | Responsibility | Notes |
|---------|----------------|-------|
| `@kodax/ai` | Provider abstraction and model adapters | Supports built-in providers and custom compatible endpoints |
| `@kodax/agent` | Sessions, messages, tokens, and compaction | Reusable outside the coding workflow |
| `@kodax/skills` | Skill discovery and execution | Lightweight specialization layer |
| `@kodax/coding` | Tools, prompts, and coding-agent loop | Execution-oriented core runtime |
| `@kodax/repl` | Terminal UI and slash commands | Permission UX and interactive workflow layer |

### Dependency Shape

```text
kodax CLI entry
├─ @kodax/repl
│  └─ @kodax/coding
│     ├─ @kodax/ai
│     ├─ @kodax/agent
│     └─ @kodax/skills
└─ @kodax/coding
```

---

## Why InfCodeX is strategically important to InfOne

InfOne represents the broader vision of an **intelligent organization / AI org** platform: defining, governing, routing, and managing large-scale agents across business scenarios.

Within that picture, InfCodeX can play a highly specific and valuable role.

### InfOne as control plane
InfOne is suited to handle:

- agent registration and lifecycle management
- model routing and policy decisions
- organization-level memory and governance
- permissions, auditability, and observability
- multi-agent orchestration at scale

### InfCodeX as execution plane
InfCodeX is suited to handle:

- repository-local engineering execution
- coding tools and file operations
- project-aware task continuation
- engineering-specific skills and workflows
- interactive and semi-automatic task delivery

### Combined value
Without a strong execution layer, an agent management platform can become a dashboard without operational depth.
Without a strong management layer, a coding CLI remains a local power tool with limited organizational leverage.

**InfOne + InfCodeX** together form a more complete system:

- InfOne decides **which agents should do what**.
- InfCodeX carries out **how software-engineering work gets done**.

That is why InfCodeX is not merely "another coding CLI". It is a practical bridge between:

- single-developer AI assistance,
- repository-level engineering execution,
- organization-level agent management.

---

## Typical Use Cases

### 1. Terminal-native coding copilot
Developers use InfCodeX locally to inspect code, patch files, run commands, and iterate faster without leaving the terminal.

### 2. Multi-step feature delivery
A task can continue across sessions rather than being constrained to one-shot prompting.

### 3. Team-standard engineering agent
A team can combine common rules, selected models, and skills to create more consistent coding-agent behavior across repositories.

### 4. SDLC agent execution substrate
InfCodeX can serve as the execution layer for coding-oriented agents inside a broader SDLC agent stack, including future integration with code review, testing, or delivery workflows.

### 5. Enterprise-safe rollout path
Organizations can adopt it incrementally with permission modes, scoped automation, and provider flexibility.

---

## Feature Snapshot

- TypeScript-native implementation
- Monorepo with reusable packages
- CLI + library usage model
- Streaming output
- Thinking / reasoning mode support
- Session persistence
- Permission-aware execution
- Skills system
- Parallel execution
- Team mode
- Long-running project workflows
- Cross-platform usage on Windows / macOS / Linux

---

## Project Mode

The most distinctive workflow carried over from the KodaX branch is **Project Mode / harness engineering**.

Instead of trusting the agent to simply declare success, Project Mode keeps project truth on disk and routes execution through verifier-gated steps. That makes long-running work more dependable on real repositories.

Key ideas:

- `kodax --init "<task>"` bootstraps project truth and planning artifacts
- `/project brainstorm` aligns scope before execution
- `/project plan` writes the active execution plan
- `/project next` advances work through deterministic gates
- `/project verify` and `/project quality` re-check outcomes before trust
- `kodax --auto-continue` keeps progressing work across multiple sessions

Typical flow:

```bash
kodax --init "Build a desktop app"
kodax
/project status
/project brainstorm
/project plan
/project next
/project verify --last
/project quality
```

Non-REPL alternative:

```bash
kodax --init "Build a desktop app"
kodax --auto-continue --max-hours 2
```

---

## Quick Start

### Requirements

- Node.js `>=18.0.0`
- npm workspaces

### 1. Install and build

```bash
npm install
npm run build:packages
npm run build
npm link
```

### 2. Configure a provider

Built-in providers read credentials from environment variables:

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

If you need a custom base URL or an OpenAI/Anthropic-compatible endpoint:

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

# One-shot CLI usage
kodax "Review this repository and summarize the architecture"
kodax --session review "Find the riskiest parts of src/"
kodax --session review "Give me concrete fix suggestions"
```

### 4. Use it as a library

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
    context: {
      gitRoot: '/repo',
      executionCwd: '/repo/packages/app',
    },
  },
  'Explain this codebase'
);
```

### Common examples

```bash
# session memory
kodax --session my-project "Read package.json"
kodax --session my-project "Summarize it"

# parallel execution
kodax --parallel "analyze and improve this module"

# team mode
kodax --team "implement,review,test"

# initialize long-running project work
kodax --init "deliver feature X"

# auto-continue until complete
kodax --auto-continue --max-hours 2
```

---

## Permission Modes

| Mode | Meaning |
|------|---------|
| `plan` | Read-only planning mode |
| `accept-edits` | Automatically accept file edits; confirm bash |
| `auto-in-project` | Full auto execution within project scope |

These modes make InfCodeX more suitable for serious environments where safety, auditability, and trust calibration matter.

---

## Detailed Usage

### REPL Quickstart

Running `kodax` with no prompt starts the interactive REPL:

```bash
kodax
```

Inside the REPL you can mix natural-language requests with slash commands:

```text
Read package.json and summarize the architecture
/model
/mode
/help
```

### CLI Quickstart

```bash
# Basic usage
kodax "Help me create a TypeScript project"

# Choose a provider explicitly
kodax --provider openai --model gpt-5.4 "Create a REST API"

# Use a deeper reasoning mode
kodax --reasoning deep "Review this architecture"
```

### Session Workflows

Use a session when you want memory across turns:

```bash
# No memory: two separate calls
kodax "Read src/auth.ts"
kodax "Summarize it"

# With memory: same session
kodax --session auth-review "Read src/auth.ts"
kodax --session auth-review "Summarize it"
kodax --session auth-review "How should I fix the first issue?"

# Session management
kodax --session list
kodax --session resume "continue"
```

### Workflow Examples

```bash
# Code review
kodax --session review "Review src/"
kodax --session review "Focus on security issues"
kodax --session review "Give me fix suggestions"

# Project development
kodax --session todo-app "Create a Todo application"
kodax --session todo-app "Add delete functionality"
kodax --session todo-app "Write tests"
```

### CLI Reference

```text
kodax                  Start the interactive REPL
-h, --help [topic]     Show help or topic help
-p, --print <text>     Run a single task and exit
-c, --continue         Continue the most recent conversation in this directory
-r, --resume [id]      Resume a session by ID, or the latest session
-m, --provider         Provider to use
--model <name>         Override the model
--reasoning <mode>     off | auto | quick | balanced | deep
-t, --thinking         Compatibility alias for --reasoning auto
-s, --session <op>     Session ID or legacy session operation
-j, --parallel         Enable parallel tool execution
--team <tasks>         Run multiple sub-agents in parallel
--init <task>          Initialize a long-running task
--auto-continue        Continue long-running tasks until complete
--max-iter <n>         Max iterations
--max-sessions <n>     Max sessions for --auto-continue
--max-hours <n>        Max runtime hours for --auto-continue
```

### Help Topics

```bash
kodax -h sessions
kodax -h init
kodax -h project
kodax -h auto
kodax -h provider
kodax -h thinking
kodax -h team
kodax -h print
```

---

## Advanced Library Usage

### Simple Mode with `runKodaX`

```typescript
import { runKodaX, type KodaXEvents } from 'kodax';

const events: KodaXEvents = {
  onTextDelta: (text) => process.stdout.write(text),
  onThinkingDelta: (text) => console.log(`Thinking delta: ${text.length} chars`),
  onToolResult: (result) => console.log(`Tool ${result.name}`),
  onComplete: () => console.log('\nDone!'),
  onError: (e) => console.error(e.message),
};

const result = await runKodaX(
  {
    provider: 'zhipu-coding',
    reasoningMode: 'auto',
    context: {
      gitRoot: '/repo',
      executionCwd: '/repo/packages/service',
    },
    events,
  },
  'What is 1+1?'
);

console.log(result.lastText);
```

### Continuous Session with `KodaXClient`

```typescript
import { KodaXClient } from 'kodax';

const client = new KodaXClient({
  provider: 'zhipu-coding',
  reasoningMode: 'auto',
  events: {
    onTextDelta: (text) => process.stdout.write(text),
  },
});

await client.send('Read package.json');
await client.send('Summarize it');

console.log(client.getSessionId());
```

### Custom Session Storage

```typescript
import { type KodaXMessage, type KodaXSessionStorage } from 'kodax';

class MyDatabaseStorage implements KodaXSessionStorage {
  async save(id: string, data: { messages: KodaXMessage[]; title: string; gitRoot: string }) {
    // Save to your own storage
  }

  async load(id: string) {
    return null;
  }
}

await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo',
  },
  session: {
    id: 'my-session-123',
    storage: new MyDatabaseStorage(),
  },
  events: { /* ... */ },
}, 'task');
```

### Library Modes Comparison

| Feature | `runKodaX` | `KodaXClient` |
|---------|------------|---------------|
| Message memory | No | Yes |
| Call style | Function | Class instance |
| Context | Independent each time | Accumulates |
| Use case | Single tasks and batch work | Multi-step or interactive workflows |

### Working Directory Semantics

`runKodaX()` distinguishes between two related but different concepts:

- `context.gitRoot`: the project root used for project-scoped prompts and permission logic.
- `context.executionCwd`: the working directory used for prompt context, relative tool paths, and shell execution.

If `executionCwd` is omitted, KodaX falls back to `gitRoot`, then `process.cwd()`.

```typescript
await runKodaX({
  provider: 'zhipu-coding',
  context: {
    gitRoot: '/repo',
    executionCwd: '/repo/packages/web',
  },
}, 'Review the current package and run local checks');
```

This is especially useful for monorepos where the project root and the active package directory are not the same.

---

## Using Individual Packages

InfCodeX keeps the KodaX branch's modular package story intact. Each package can be used independently when you do not need the full CLI.

### `@kodax/ai` — LLM Abstraction Layer

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

**Key Features**: 11 LLM providers with unified interface, streaming output, thinking mode support, error handling and retry logic.

### `@kodax/agent` — Agent Framework

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

**Key Features**: Session ID generation and title extraction, token estimation (tiktoken-based), message compaction with AI summarization.

### `@kodax/skills` — Skills System

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

### `@kodax/coding`

Use when you want the complete coding-agent loop, tool execution, prompts, and session-aware task handling.

### `@kodax/repl`

Use when you want the interactive terminal UI, slash-command system, and permission UX.

---

## Supported Providers

| Provider | Environment Variable | Reasoning Support | Default Model |
|----------|----------------------|-------------------|---------------|
| `anthropic` | `ANTHROPIC_API_KEY` | Native budget | `claude-sonnet-4-6` |
| `openai` | `OPENAI_API_KEY` | Native effort | `gpt-5.3-codex` |
| `deepseek` | `DEEPSEEK_API_KEY` | Native toggle on `deepseek-chat`; model-selected reasoning on `deepseek-reasoner` | `deepseek-chat` |
| `kimi` | `KIMI_API_KEY` | Native effort | `k2.5` |
| `kimi-code` | `KIMI_API_KEY` | Native budget | `k2.5` |
| `qwen` | `QWEN_API_KEY` | Native budget | `qwen3.5-plus` |
| `zhipu` | `ZHIPU_API_KEY` | Native budget | `glm-5` |
| `zhipu-coding` | `ZHIPU_API_KEY` | Native budget | `glm-5` |
| `minimax-coding` | `MINIMAX_API_KEY` | Native budget | `MiniMax-M2.7` |
| `gemini-cli` | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| `codex-cli` | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

### Provider Examples

```bash
# Use Zhipu Coding
kodax --provider zhipu-coding --thinking "Help me optimize this code"

# Use OpenAI
export OPENAI_API_KEY=your_key
kodax --provider openai "Create a REST API"

# Use DeepSeek
export DEEPSEEK_API_KEY=your_key
kodax --provider deepseek "Summarize this repository"
kodax --provider deepseek --model deepseek-reasoner "Think through this refactor plan"

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
| `read` | Read file contents with offset and limit support |
| `write` | Write a file |
| `edit` | Exact string replacement with `replace_all` support |
| `bash` | Execute shell commands |
| `glob` | File pattern matching |
| `grep` | Content search |
| `undo` | Revert the last modification |
| `ask_user_question` | Ask the user to choose between options |

---

## Skills System

The KodaX branch also introduced a more explicit skills story that remains relevant in InfCodeX.

Examples:

```bash
kodax "Help me review this code"
kodax "Write tests for this module"
kodax /skill:code-review
```

Built-in skills include:

- `code-review`
- `tdd`
- `git-workflow`

Custom skills can live under `~/.kodax/skills/`.

---

## Commands

Commands are `/xxx` shortcuts exposed through the CLI and REPL experience.

```bash
kodax /review src/auth.ts
kodax /test
```

Command definitions live in `~/.kodax/commands/`:

- `.md` files provide prompt commands
- `.ts` / `.js` files provide programmable commands

---

## Configuration

The repository includes a configuration template with:

- default provider selection
- provider model selection
- provider model overrides
- custom provider definitions
- unified reasoning mode
- compaction settings
- permission mode defaults

The current documented config path is:

```text
~/.kodax/config.json
```

See `config.example.jsonc` for the full template.

---

## Development

```bash
# Development mode
npm run dev "your task"

# Build all packages
npm run build:packages

# Build the root CLI
npm run build

# Run tests
npm test

# Clean generated artifacts
npm run clean
```

---

## Design Philosophy

InfCodeX is guided by several principles:

- **Transparent over black-box**
- **Composable over monolithic**
- **Execution-oriented over chat-oriented**
- **Governable over uncontrolled**
- **Evolvable over one-off**

This is what makes the project valuable not only as a CLI, but as a foundation for a broader engineering-agent ecosystem.

---

## Roadmap Direction

Based on the existing repo structure and internal documents, the natural forward path includes:

- richer multi-agent teamwork
- more built-in skills
- stronger plugin / extension capabilities
- deeper SDLC integration
- future IDE or web integrations
- tighter coupling with upper-layer agent platforms such as InfOne

---

## Repository Notes

The repository is evolving quickly, and parts of the documentation still reflect earlier naming and counting conventions. For example:

- `InfCodeX` and `KodaX` are both present in the docs
- some docs mention 7 providers while newer docs/configs enumerate 10 built-in providers
- package and command names currently remain `kodax`

This README therefore emphasizes **stable architectural truths** while also retaining the more detailed KodaX usage guidance that is still valuable for day-to-day development.

---

## Related Documents

- [Chinese README](./README_CN.md)
- [Architecture Overview](./docs/ARCHITECTURE_OVERVIEW.md)
- [Architecture Overview (Chinese)](./docs/ARCHITECTURE_OVERVIEW_CN.md)
- [InfCodeX + InfOne Positioning](./docs/PROJECT_POSITIONING.md)
- [InfCodeX + InfOne Positioning (Chinese)](./docs/PROJECT_POSITIONING_CN.md)
- [Feature List](./docs/FEATURE_LIST.md)
- [Feature Release Notes Index](./docs/features/README.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)

---

## License

[Apache License 2.0](./LICENSE)

---

## Summary

**InfCodeX is important because it is not only a CLI.**

It is a practical execution runtime for software-engineering agents, and it has the right architecture to grow from a powerful terminal tool into a key execution component inside Tokfinity's larger intelligent-agent platform strategy.
