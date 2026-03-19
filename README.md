# InfCodeX

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
InfCodeX introduces four permission modes:

- `plan`
- `default`
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
├─ AI Layer        → provider abstraction, streaming, error handling
├─ Agent Layer     → sessions, messages, token utilities
├─ Skills Layer    → skill discovery, registry, execution
├─ Coding Layer    → tools, prompts, agent loop
└─ REPL / CLI      → interactive UX, permission control, commands
```

This design provides several advantages:

- **Clear separation of concerns**
- **No circular dependency mindset**
- **Better testability and replacement boundaries**
- **Potential for independent package reuse**
- **A stronger foundation for future enterprise orchestration**

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
- and organization-level agent management.

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

## Quick Start

### Requirements

- Node.js `>=18.0.0` according to `package.json`
- npm workspaces

### Install and build

```bash
npm install
npm run build:packages
npm run build
```

### Use via CLI

```bash
export ZHIPU_API_KEY=your_api_key
kodax "Help me understand this repository"
```

### Use via node directly

```bash
node dist/kodax_cli.js "your task"
```

### Examples

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
kodax --auto-continue "finish remaining work"
```

---

## Permission Modes

| Mode | Meaning |
|------|---------|
| `plan` | Read-only planning mode |
| `default` | Safe default mode |
| `accept-edits` | Automatically accept file edits; confirm bash |
| `auto-in-project` | Full auto execution within project scope |

These modes make InfCodeX more suitable for serious environments where safety, auditability, and trust calibration matter.

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

This README therefore emphasizes **stable architectural truths** and **strategic product characteristics**, while keeping volatile numeric details aligned as much as possible with the current public repository.

---

## Related Documents

- [Chinese README](./README_CN.md)
- [Architecture Overview](./docs/ARCHITECTURE_OVERVIEW.md)
- [Architecture Overview (Chinese)](./docs/ARCHITECTURE_OVERVIEW_CN.md)
- [InfCodeX + InfOne Positioning](./docs/PROJECT_POSITIONING.md)
- [InfCodeX + InfOne Positioning (Chinese)](./docs/PROJECT_POSITIONING_CN.md)

---

## Summary

**InfCodeX is important because it is not only a CLI.**

It is a practical execution runtime for software-engineering agents, and it has the right architecture to grow from a powerful terminal tool into a key execution component inside Tokfinity's larger intelligent-agent platform strategy.
