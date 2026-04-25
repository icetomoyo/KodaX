# KodaX

Extreme Lightweight Coding Agent - TypeScript Implementation

## Overview

KodaX is a **modular, lightweight AI coding agent** built with TypeScript. It supports **12 LLM providers**, works as both a CLI tool and a library, ships an optional **Node-free standalone binary**, and includes a Scout-first adaptive multi-agent workflow for long-running coding tasks.

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
| **Provider choice** | 12 providers (incl. Anthropic, OpenAI, DeepSeek, Kimi, Qwen, Zhipu, MiniMax, MiMo, Gemini CLI, Codex CLI) + custom OpenAI/Anthropic-compatible providers | Often optimized for one provider |
| **Customization** | Edit prompts, tools, skills, session flow directly | Limited extension surface |
| **Codebase clarity** | Small TypeScript monorepo | Often much larger and harder to trace |
| **Distribution** | npm install / global link / **standalone binary** (Bun --compile, no Node required on target) | Closed-source installer or web app |
| **Learning value** | Good for understanding agent internals | More black-box |

## Quick Start

### 1. Install and build the CLI

```bash
git clone https://github.com/icetomoyo/KodaX.git
cd KodaX
npm install
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
      "model": "my-model",
      "userAgentMode": "compat"
    }
  ]
}
```

`userAgentMode` defaults to `"compat"`, which sends `KodaX` instead of the official SDK User-Agent. Switch it to `"sdk"` only when your gateway expects the upstream SDK header.

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
    userAgentMode: 'compat',
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

## Repo Intelligence Premium

KodaX now supports a split repo-intelligence architecture:

- **Public OSS baseline** lives in the public `KodaX` repo and keeps `CLI`, `REPL`, `ACP`, library imports, and repo-aware tools working even when no premium component is installed.
- **Premium intelligence** lives in the sibling private repo `KodaX-private` and runs through the local `repointel` daemon / CLI frontdoor.
- **KodaX native mode** is the flagship experience. It can prefetch repo intelligence before routing and prompt building, while other hosts such as Codex / Claude Code / OpenCode use the same premium tool through thin skills.

### Runtime modes

KodaX supports these repo-intelligence modes:

- `off`: strict benchmark baseline. Disable the repo-intelligence working plane entirely while keeping `/repointel` control commands available.
- `oss`: use only the public OSS baseline.
- `premium-shared`: use the premium engine, but without the native KodaX auto lane. This is useful for comparing KodaX against other hosts.
- `premium-native`: use the premium engine through the KodaX native bridge. This is the best local experience.
- `auto`: user-facing convenience mode. KodaX resolves it to `premium-native` when the premium daemon is reachable, otherwise it falls back to `oss`.

### Quick usage

Run KodaX with explicit repo-intelligence mode flags:

```bash
# OSS baseline only
kodax --repo-intelligence oss

# Premium native mode with trace output
kodax --repo-intelligence premium-native --repo-intelligence-trace

# Compare against the shared premium path
kodax --repo-intelligence premium-shared --repo-intelligence-trace
```

You can also set the same behavior through config or environment variables:

```powershell
$env:KODAX_REPO_INTELLIGENCE_MODE = "premium-native"
$env:KODAX_REPO_INTELLIGENCE_TRACE = "1"
$env:KODAX_REPOINTEL_BIN = "C:\Tools\repointel\repointel.exe"
```

Official `KodaX-private` releases should now publish only the native `repointel` package. The older offline bundle remains useful for internal/manual validation, but it should not be the normal end-user release artifact.

### REPL mode

It is not CLI-only. REPL mode supports the same repo-intelligence runtime modes.

The most direct premium-native REPL flow is:

```powershell
Set-Location <path-to-your-KodaX-clone>
kodax --repo-intelligence premium-native --repo-intelligence-trace
```

If you save the premium settings in `~/.kodax/config.json`, plain REPL startup is enough:

```powershell
kodax
```

Inside REPL, repo intelligence is still consumed automatically by the normal KodaX flow, and there are also lightweight status/control commands:

- `/status`: shows a compact repo-intelligence summary together with the normal session status output.
- `/repointel` or `/repointel status`: shows the current repo-intelligence state in more detail.
- `/repointel mode premium-native|premium-shared|oss|off|auto`: switches the current mode and writes it back to user config.
- `/repointel trace on|off|toggle`: turns repo-intelligence trace output on or off.
- `/repointel warm`: tries to warm or start the local premium service. If it cannot be started, KodaX reports the failure clearly and continues with the normal fallback path.

The most important fields to watch are:

- `mode`: the resolved runtime mode, such as `oss`, `premium-shared`, or `premium-native`
- `engine`: the actual engine in use, `oss` or `premium`
- `bridge`: `none`, `shared`, or `native`
- `status`: typically `ok`, `limited`, or `unavailable`

The practical difference between the two premium modes is:

- `premium-native`: the flagship KodaX path. KodaX can prefetch and inject repo intelligence earlier in its native runtime flow.
- `premium-shared`: still uses premium, but intentionally avoids the KodaX-native auto lane so you can compare against the shared multi-host path.
- `oss`: keep the public baseline repo tools and OSS intelligence only.
- `off`: strict disable for repo-intelligence working tools and auto injection. `/repointel` remains available as the control plane.

### User-level config

Repo-intelligence premium settings are supported in the user config file `~/.kodax/config.json`.

Supported fields:

- `repoIntelligenceMode`
- `repointelEndpoint`
- `repointelBin`
- `repoIntelligenceTrace`

Recommended end-user example when `repointel` is installed but not on `PATH`:

```json
{
  "provider": "zhipu-coding",
  "reasoningMode": "auto",
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe",
  "repoIntelligenceTrace": false
}
```

For normal user installs, the preferred setup is to install the premium tool so the `repointel` command is already on `PATH`, in which case this is usually enough:

```json
{
  "repoIntelligenceMode": "premium-native"
}
```

If `repointel` is not on `PATH`, `repointelBin` can point to the installed native executable, for example:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelBin": "C:\\Tools\\repointel\\repointel.exe"
}
```

For author same-parent local development, it is still valid to point `repointelBin` at the sibling private source build:

```json
{
  "repoIntelligenceMode": "premium-native",
  "repointelEndpoint": "http://127.0.0.1:47891",
  "repointelBin": "C:\\path\\to\\KodaX-private\\packages\\repointel-cli\\dist\\index.js",
  "repoIntelligenceTrace": true
}
```

`repointelEndpoint` is optional in normal installs. It only tells KodaX which local premium daemon address to use, and the default `http://127.0.0.1:47891` is usually enough unless you deliberately run a non-default endpoint.

For same-parent author local development, `repointelBin` can still point to the sibling private build output.

These config values are loaded by both CLI mode and REPL mode, and they are bridged into the runtime environment automatically.

### Config template

The repo now includes a user-facing config template:

- `config.example.jsonc`

Copy it to `~/.kodax/config.json`, then adjust provider and repo-intelligence settings as needed.

### Local same-parent development

The intended phase-1 development layout is to clone both repos under the same parent directory, for example:

- Public repo: `<parent>/KodaX`
- Private repo: `<parent>/KodaX-private`

Typical local workflow:

```powershell
# 1. Build the public repo
Set-Location <parent>\KodaX
npm install
npm run build

# 2. Build the private premium repo
Set-Location <parent>\KodaX-private
npm install
npm run build

# 3. Warm or start the premium daemon
node .\packages\repointel-cli\dist\index.js warm "{}"

# 4. Run KodaX in premium-native mode
Set-Location <parent>\KodaX
npm run dev -- --repo-intelligence premium-native --repo-intelligence-trace
```

### How KodaX behaves after the split

- If premium is unavailable, KodaX automatically falls back to the OSS baseline. Startup, imports, and public tools keep working.
- If premium is available, `premium-native` uses the daemon client directly and injects repo intelligence earlier than shared-host integrations.
- Trace-enabled runs can be used to compare `off`, `oss`, `premium-shared`, and `premium-native` on the same task, including mode, engine, bridge, daemon latency, cache hits, and capsule token estimates.

### External hosts

Codex, Claude Code, and OpenCode are intentionally thinner in phase 1:

- they install the shared Repointel skill
- they call the same local premium tool
- they do **not** ship a separate OSS fallback engine

Install the shared thin skill from the public repo:

```powershell
# Cross-platform primary entrypoint
node .\clients\repointel\scripts\install.mjs --host codex
node .\clients\repointel\scripts\install.mjs --host claude --workspace-root C:\path\to\workspace
node .\clients\repointel\scripts\install.mjs --host opencode --workspace-root C:\path\to\workspace
```

Useful helper scripts:

- `clients/repointel/scripts/demo.mjs`: run a local premium demo flow against a temporary endpoint.
- `clients/repointel/scripts/doctor.mjs`: inspect local premium setup, bridge status, daemon reachability, and host skill installation.
- `clients/repointel/scripts/install.mjs`: install the shared thin skill into Codex / Claude / OpenCode host paths.

The installable shared skill itself lives at:

- `clients/repointel/SKILL.md`

## Architecture

KodaX uses a **monorepo architecture** with npm workspaces, consisting of 5 packages:

```
KodaX/
├── packages/
│   ├── ai/                  # @kodax/ai - Independent LLM abstraction layer
│   │   └── providers/       # 12 LLM providers (Anthropic, OpenAI, DeepSeek, MiMo, etc.)
│   │
│   ├── agent/               # @kodax/agent - Generic Agent framework
│   │   └── session/         # Session management, message handling
│   │
│   ├── skills/              # @kodax/skills - Skills standard implementation
│   │   └── builtin/         # Built-in skills (code-review, tdd, git-workflow)
│   │
│   ├── coding/              # @kodax/coding - Coding Agent (tools + prompts)
│   │   └── tools/           # Tools: read, write, edit, bash, glob, grep, undo, ask_user_question, repo-intelligence
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

- **Modular Architecture** - Use as CLI, as a library, or as a Node-free single binary
- **12 LLM Providers** - Anthropic, OpenAI, DeepSeek, Kimi, Kimi Code, Qwen, Zhipu, Zhipu Coding, MiniMax Coding, MiMo Coding (Xiaomi Token Plan), Gemini CLI, Codex CLI — plus user-defined OpenAI/Anthropic-compatible providers
- **Scout-First AMA** - Adaptive multi-agent with H0/H1/H2 harness levels, Scout-complete direct execution, and context-preserving role upgrades
- **Reasoning Modes** - Unified `off/auto/quick/balanced/deep` interface across providers
- **Streaming Output** - Real-time response display
- **Session Management** - JSONL format with branchable session lineage tree
- **Skills System** - Natural language triggering, extensible, role-projected in AMA
- **Repo Intelligence** - OSS baseline + optional `repointel` premium engine, with native KodaX auto-injection lane
- **Rich Tool Surface** - 30+ built-in tools across file ops, shell, search, repo intelligence, MCP capabilities, git worktree, and agent control
- **Permission Control** - 3 permission modes with pattern-based control
- **Standalone Binary** - `bun --compile` releases for Win/macOS/Linux x64+arm64, no Node.js required on target machines
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

# Build the monorepo
npm run build

# Link globally (development mode)
npm link

# Now you can use 'kodax' anywhere
kodax "your task"
```

### As Standalone Binary (no Node required on target)

KodaX can be packaged into a single executable + a small `builtin/` sidecar directory using `bun --compile`. The target machine does **not** need Node.js or any other runtime.

Supported targets: `win-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`. Win7 / pre-glibc-2.27 distros / LoongArch are not supported.

**Build locally**:

```bash
# Install Bun once on your build machine
npm i -g bun                  # or scoop/brew/curl install — see docs/release.md

npm run build:binary          # Current host platform (fastest)
npm run build:binary:all      # All five targets in sequence
node scripts/build-binary.mjs --target=linux-arm64   # Specific target
```

Output lives under `dist/binary/<target>/`:

```
dist/binary/linux-x64/
├── kodax              # ~60 MB Bun-compiled executable
└── builtin/           # Sidecar built-in skills
```

Smoke-test: `dist/binary/<host>/kodax --version`.

**Automated release**: pushing a `v*` git tag triggers `.github/workflows/release.yml`, which builds all five targets on native runners, runs smoke tests, and publishes a GitHub Release with archives + SHA256SUMS. Use the `workflow_dispatch` button in the Actions UI to test the pipeline without tagging.

See [docs/release.md](docs/release.md) for full details on build flags, archive layout, troubleshooting, and the build-time `KODAX_BUNDLED` / `KODAX_VERSION` defines.

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
--max-iter <n>       Max iterations
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
- 12 LLM providers with a unified interface
- Streaming output support
- Thinking / reasoning mode support
- Error handling and retry logic
- Zero business logic dependencies

### @kodax/agent - Agent Framework

Generic agent framework with session management:

```typescript
import {
  generateSessionId,
  estimateTokens,
  type KodaXMessage
} from '@kodax/agent';
import { DefaultSummaryCompaction } from '@kodax/core';

// Generate session ID
const sessionId = generateSessionId();

// Estimate tokens
const tokens = estimateTokens(messages);

// Pluggable compaction policy (FEATURE_081, v0.7.23).
// Call `policy.shouldCompact(...)` at round boundaries, then `policy.compact(...)`.
const policy = new DefaultSummaryCompaction({
  thresholdRatio: 0.8,
  keepRecent: 10,
});
```

**Key Features**:
- Session ID generation and title extraction
- Token estimation (tiktoken-based)
- Pluggable `CompactionPolicy` + `DefaultSummaryCompaction` (generic) / `LineageCompaction` (coding preset)
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
- 30+ built-in tools across file ops, shell, search, repo intelligence, MCP, worktree, and agent control (see the [Tools](#tools) section)
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
| kimi | `KIMI_API_KEY` | Native | kimi-k2.6 |
| kimi-code | `KIMI_API_KEY` | Native | kimi-for-coding |
| qwen | `QWEN_API_KEY` | Native | qwen3.5-plus |
| zhipu | `ZHIPU_API_KEY` | Native | glm-5 |
| zhipu-coding | `ZHIPU_API_KEY` | Native | glm-5 |
| minimax-coding | `MINIMAX_API_KEY` | Native | MiniMax-M2.7 |
| mimo-coding | `MIMO_API_KEY` | Native | mimo-v2.5-pro (Xiaomi Token Plan, Anthropic-compat) |
| ark-coding | `ARK_API_KEY` | Native | glm-5.1 (Volcengine Ark Coding Plan, multi-model gateway, Anthropic-compat) |
| deepseek | `DEEPSEEK_API_KEY` | Native | deepseek-v4-flash |
| gemini-cli | `GEMINI_API_KEY` | Prompt-only / CLI bridge | (via gemini CLI) |
| codex-cli | `OPENAI_API_KEY` | Prompt-only / CLI bridge | (via codex CLI) |

> **Custom providers**: any OpenAI- or Anthropic-compatible endpoint can be added via `customProviders[]` in `~/.kodax/config.json` (CLI) or `registerCustomProviders()` (library). See the [Quick Start](#2-configure-a-provider) for the configuration shape.

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

# Adaptive multi-agent (AMA) mode — Scout-first fan-out for multi-file work
kodax --agent-mode ama "Analyze code structure, check test coverage, find bugs"
```

---

## Tools

KodaX ships 30+ built-in tools, grouped below. They are registered as a single flat tool surface to the LLM; the categories here are just for navigation.

### File operations
| Tool | Description |
|------|-------------|
| `read` | Read file contents (supports offset/limit) |
| `write` | Write a new file or fully rewrite an existing one |
| `edit` | Exact string replacement (supports `replace_all`) |
| `multi_edit` | Atomic batch of independent edits to one file |
| `insert_after_anchor` | Insert content after a unique anchor without rewriting the file |
| `undo` | Revert the last file modification |

### Shell & search
| Tool | Description |
|------|-------------|
| `bash` | Execute a shell command (supports `run_in_background`, output truncation) |
| `glob` | Find files by pattern |
| `grep` | Regex content search (context lines, multiline, file-type filter, pagination) |
| `code_search` | Lower-noise code search (extension-provider aware) |
| `semantic_lookup` | Symbol/module/process-aware search backed by repo intelligence |
| `web_search` | Discovery-oriented web search with trust + freshness signals |
| `web_fetch` | Fetch a specific URL with provenance hints |

### Repo Intelligence (working tools)
| Tool | Description |
|------|-------------|
| `repo_overview` | Summarize structure, key areas, entry hints, intelligence snapshot |
| `changed_scope` | Which files/areas/categories the current diff touches |
| `changed_diff` | Paged diff slice for a single file |
| `changed_diff_bundle` | Paged diff slices for multiple files in one call |
| `module_context` | Module capsule (deps, entries, symbols, tests, docs) |
| `symbol_context` | Definition + probable callers/callees + alternatives |
| `process_context` | Approximate static execution capsule for an entry |
| `impact_estimate` | Blast radius for a symbol/path/module |

### MCP capabilities (when MCP servers are configured)
| Tool | Description |
|------|-------------|
| `mcp_search` / `mcp_describe` / `mcp_call` | Discover and invoke MCP tools through the shared capability runtime |
| `mcp_read_resource` / `mcp_get_prompt` | Read MCP resources and prompts |

### Git worktree
| Tool | Description |
|------|-------------|
| `worktree_create` | Create a new worktree on an isolated branch for safe agent work |
| `worktree_remove` | Remove a worktree (with safety checks) |

### Agent control & UX
| Tool | Description |
|------|-------------|
| `dispatch_child_task` | Spawn a sub-agent for an independent investigation/edit task |
| `ask_user_question` | Single/multi-select or free-text prompt back to the user |
| `exit_plan_mode` | Present a finalized plan for approval (REPL only) |
| `emit_managed_protocol` | Internal scout/planner/handoff/verdict side-channel |

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
  estimateTokens,
  getGitRoot, getGitContext, getEnvContext, getProjectSnapshot,
  checkPromiseSignal
};
```

---

## Development

```bash
# Development mode (using tsx)
npm run dev "your task"

# Build
npm run build

# Optional: only build workspace packages
npm run build:packages

# Build standalone binary (current platform / all platforms)
npm run build:binary
npm run build:binary:all

# Run tests
npm test

# Eval-driven development tests (provider matrices, identity round-trip, etc.)
npm run test:eval

# Clean
npm run clean
```

### Repo Intelligence cache directories

KodaX now uses two repo-intelligence cache locations on disk:

- `.agent/repo-intelligence/`
  - OSS baseline repo-intelligence artifacts and existing task-engine snapshots.
- `.repointel/`
  - Premium `repointel` workspace cache shared by the local daemon/native frontdoor.

They are intentionally separated so:

- OSS fallback stays available even when premium is disabled or unavailable.
- Premium cache does not pollute OSS artifacts.
- KodaX and other hosts can share the same premium workspace cache.

`.repointel/` is a local generated directory and should not be committed.

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
- [docs/release.md](docs/release.md) - Standalone binary build & release pipeline
- [docs/PRD.md](docs/PRD.md) - Product Requirements
- [docs/ADR.md](docs/ADR.md) - Architecture Decisions
- [docs/HLD.md](docs/HLD.md) - High-Level Design
- [docs/DD.md](docs/DD.md) - Detailed Design
- [docs/FEATURE_LIST.md](docs/FEATURE_LIST.md) - Feature Tracking
- [docs/test-guides/](docs/test-guides/) - Feature-specific test guides
- [CHANGELOG.md](CHANGELOG.md) - Version History (v0.7.0+; [archive](docs/CHANGELOG_ARCHIVE.md) for older)

---

## License

[Apache License 2.0](LICENSE) - Copyright 2026 [icetomoyo](mailto:icetomoyo@gmail.com)
