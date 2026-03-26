# InfCodeX Architecture Overview

This document summarizes the current public architecture of the InfCodeX repository and explains why the layering matters.

## 1. High-level structure

InfCodeX follows a layered monorepo design:

```text
CLI Layer
└─ REPL Layer
   └─ Coding Layer
      ├─ Agent Layer
      │  └─ AI Layer
      └─ Skills Layer
```

The repository currently exposes five main packages plus a root CLI entry:

- `@kodax/ai`
- `@kodax/agent`
- `@kodax/skills`
- `@kodax/coding`
- `@kodax/repl`
- root `src/kodax_cli.ts`

## 2. Layer responsibilities

### AI Layer
Responsible for provider abstraction, streaming, and error handling.

This layer matters because it decouples the rest of the system from any single model vendor or API style.

### Agent Layer
Responsible for generic agent concerns such as:

- session handling
- message lifecycle
- token estimation / compaction support

This layer allows the coding runtime to inherit reusable agent primitives instead of re-implementing them inside the CLI.

### Skills Layer
Responsible for skill discovery, registration, and execution.

The skills layer is strategically important because it provides a path from generic prompting to more structured, reusable task specialization.

### Coding Layer
Responsible for:

- tools
- coding prompts
- the action loop that connects model output with tool execution

This is the true execution core of InfCodeX.

### REPL Layer
Responsible for terminal interaction and operator experience, including:

- interactive UI
- commands
- permission control
- user-facing execution flow

### CLI Layer
Responsible for the entrypoint, command parsing, and top-level command invocation.

## 3. Why this architecture is strong

### Clear boundaries
Each layer has an obvious scope, which reduces conceptual sprawl and makes the codebase easier to extend.

### Reusability
Several layers are independently valuable outside the CLI itself. This supports embedding InfCodeX into broader systems.

### Governance potential
Because permissions, providers, tools, and sessions are separated, the runtime has a better chance of integrating with enterprise governance later.

### Multi-agent future
A clean execution runtime is a better substrate for team mode, agent decomposition, and orchestration than a single-file CLI design.

## 4. Observed architectural strengths

- modular monorepo structure
- reusable package boundaries
- provider abstraction
- agent/session separation
- explicit skills subsystem
- coding-specific execution layer
- terminal UX separated from core runtime

## 5. Strategic interpretation

This architecture suggests that InfCodeX is already more than a local CLI utility. It is a candidate execution runtime for engineering agents, especially when paired with an upper-layer agent management system.
