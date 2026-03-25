# KodaX High-Level Design

> Last updated: 2026-03-25
>
> This document reflects the architecture reset carried by `FEATURE_022`, which turns KodaX from a command-led coding CLI into an adaptive multi-agent task engine.

---

## 1. Product Thesis

KodaX should no longer be modeled as:

- a single coding agent with optional long-running modes
- a CLI where the user must decide up front whether to enter "project mode"
- a product whose multi-agent story is a visible `--team` flag

KodaX should instead be modeled as:

- an adaptive task engine
- with native multi-agent execution for non-trivial work
- evidence-driven completion
- durable task state
- host-agnostic runtime contracts

The user experience goal is simple:

- ask for work in natural language
- let KodaX decide whether the task needs routing, planning, multiple agents, or verification
- expose controls only when the user wants to inspect, steer, or override the system

---

## 2. Design Goals

### 2.1 Primary goals

1. Make task complexity routing invisible by default.
2. Separate planning, generation, and evaluation responsibilities.
3. Treat completion as evidence, not self-report.
4. Preserve state across long-running and interrupted work.
5. Keep the runtime reusable across CLI, REPL, ACP, and future surfaces.
6. Keep the product minimal even as orchestration becomes more powerful.

### 2.2 Non-goals

1. Do not force heavyweight multi-agent execution on trivial prompts.
2. Do not make `/project` the primary product abstraction.
3. Do not present `--team` as the future orchestration model.
4. Do not let the generator also be the final judge of completion.
5. Do not tie the architecture to one provider or one harness shape.

---

## 3. System Overview

KodaX is organized around six conceptual layers:

```text
Surfaces
  -> Task Intake and Harness Router
    -> Multi-Agent Control Plane
      -> Coding Runtime and Capability Substrate
        -> Provider and Execution Adapters
          -> Durable Task State and Evidence Store
```

### 3.1 Surfaces

Surfaces are the user-facing or host-facing entry points:

- CLI one-shot mode
- interactive REPL
- ACP server
- future IDE, desktop, and web surfaces

Surfaces should not own task logic. They only collect input, render progress, request approvals, and display results.

### 3.2 Task Intake and Harness Router

The router is the first durable decision point for every request. It decides:

- task type
- complexity level
- whether the task is append vs overwrite vs new work
- whether discovery or brainstorm is needed
- whether durable task state is required
- which harness profile to use
- whether multi-agent execution is required

### 3.3 Multi-Agent Control Plane

The control plane manages role assignment, sequencing, evidence flow, retries, and synthesis.

Default role vocabulary:

- `Lead`
- `Planner`
- `Generator`
- `Evaluator`
- optional specialized `Worker` roles

### 3.4 Coding Runtime and Capability Substrate

This layer provides:

- prompt building
- tool execution
- extension loading
- structured capability registration
- session handling
- checkpoint and event plumbing

This substrate should remain host-agnostic and reusable.

### 3.5 Provider and Execution Adapters

This layer abstracts:

- native model providers
- CLI bridge providers
- future capability providers
- sandbox and execution providers

Provider capability must affect harness decisions. KodaX should not assume all providers can support the same orchestration behavior.

### 3.6 Durable Task State and Evidence Store

Every non-trivial task should have durable artifacts:

- intake summary
- contract
- plan
- run trace
- evidence
- checkpoints
- session tree / task lineage
- final verdict

This replaces the idea that only explicit "project mode" work deserves persistent truth.

---

## 4. Harness Profiles

KodaX should choose among four default harness profiles.

| Profile | Typical task | Roles | Durability | Verification |
|---|---|---|---|---|
| `H0_DIRECT` | simple Q&A, small read-only lookup | one agent | optional | lightweight only |
| `H1_EXECUTE_EVAL` | small code change, low ambiguity | generator + evaluator | yes | required |
| `H2_PLAN_EXECUTE_EVAL` | medium task, moderate ambiguity | planner + generator + evaluator | yes | required |
| `H3_MULTI_WORKER` | large, long-running, cross-module work | lead + planner + workers + evaluator | yes | strong evidence loop |

Rules:

- trivial read-only work may stay in `H0_DIRECT`
- any write-capable task should normally be at least `H1_EXECUTE_EVAL`
- any ambiguous or architectural task should normally be at least `H2_PLAN_EXECUTE_EVAL`
- any long-running or cross-cutting task should normally be `H3_MULTI_WORKER`

---

## 5. Role Model

### 5.1 Lead

Responsibilities:

- own the task envelope
- choose and adapt harness profile
- assign work to roles
- decide when to continue, retry, escalate, or stop
- synthesize the final user-facing result

The Lead should not be the sole judge of completion.

### 5.2 Planner

Responsibilities:

- expand the user request into an actionable contract
- identify assumptions, scope, and constraints
- propose task decomposition
- decide where brainstorm or clarification is required

The Planner should avoid prematurely locking low-level implementation details unless needed.

### 5.3 Generator

Responsibilities:

- read the contract and current context
- perform code changes or produce artifacts
- record claims and outputs
- stop short of self-certifying completion

### 5.4 Evaluator

Responsibilities:

- review contract compliance
- run deterministic checks
- inspect evidence quality
- challenge optimistic completion claims
- produce pass/fail or graded verdicts with reasons

The Evaluator is a load-bearing role. Reliability depends on this separation.

### 5.5 Specialized workers

Examples:

- research worker
- test worker
- refactor worker
- UI worker
- retrieval or evidence worker

These should be used only when the write scope or responsibility boundary is clear.

---

## 6. Task Lifecycle

```text
User request
  -> Intake
  -> Intent classification
  -> Complexity scoring
  -> Harness selection
  -> Contract creation
  -> Role assignment
  -> Execution loop
  -> Evaluation loop
  -> Synthesis
  -> Final verdict and persisted state
```

### 6.1 Intake

The intake layer produces a normalized task envelope:

- raw request
- workspace context
- active session context
- inferred task family
- inferred risk level

### 6.2 Contract creation

The contract is the task-local source of truth. It should capture:

- requested outcome
- scope
- append vs overwrite decision
- explicit constraints
- success criteria
- required evidence

### 6.3 Execution loop

Execution follows the contract. The Lead may revise routing if new evidence shows the initial harness profile was too weak or too strong.

### 6.4 Evaluation loop

The evaluator verifies:

- legality
- completeness
- quality
- evidence sufficiency
- regressions

If evaluation fails, the task returns to execution with explicit failure reasons.

### 6.5 Synthesis

The final response should be based on:

- contract status
- persisted evidence
- open risks
- user-visible outcome

---

## 7. Durable State Model

The persistent unit shifts from "project mode workspace" to "task".

Recommended layout:

```text
.agent/
  tasks/
    <task-id>/
      task.json
      intake.json
      contract.json
      plan.md
      decisions.jsonl
      evidence/
      checkpoints/
      session-tree/
      runs/
      artifacts/
```

### 7.1 Why task-first persistence

This allows:

- short tasks to stay light
- medium tasks to gain structure when needed
- long tasks to accumulate robust state
- old project-mode artifacts to be absorbed rather than duplicated

### 7.2 Relationship to current project artifacts

Current artifacts remain useful:

- `feature_list.json`
- `PROGRESS.md`
- `.agent/project/`

But they should be reinterpreted as transitional, project-shaped task state rather than the permanent product model.

---

## 8. Transitional Product Surface

### 8.1 `/project`

`/project` remains valuable, but its role changes from primary workflow entry to control surface:

- inspect task state
- view plan or evidence
- trigger manual verify
- intervene in routing
- resume or pause a managed task

### 8.2 `--init` and `--auto-continue`

These remain as compatibility-oriented entry points for long-running work, but the internal engine should treat them as alternate ways to create or continue managed tasks.

### 8.3 `--team`

`--team` should be retired as a product concept.

Possible handling:

- keep temporarily as a thin compatibility alias
- route it into the new control plane
- stop documenting it as the future orchestration model

---

## 9. Capability and Provider Strategy

### 9.1 Capability runtime

The extension and capability runtime should provide:

- tool registration and override
- capability metadata
- diagnostics
- reload behavior
- structured results

This is the substrate for search, sandbox, MCP, and future runtime packages.

### 9.2 Provider-aware harness policy

The router must consider provider characteristics such as:

- context behavior
- reasoning control semantics
- tool-calling reliability
- bridge-vs-native provenance
- multimodal support

This prevents false equivalence across providers.

---

## 10. Roadmap Alignment

The architecture reset changes planned feature ownership.

### 10.1 v0.7.0 foundation

- `FEATURE_019` Session Tree, Checkpoints, and Rewindable Task Runs
- `FEATURE_022` Native Multi-Agent Control Plane
- `FEATURE_025` Adaptive Task Intelligence and Harness Router
- `FEATURE_026` Roadmap Integrity and Planning Hygiene
- `FEATURE_029` Provider Capability Transparency and Harness Policy
- `FEATURE_034` Extension and Capability Runtime

### 10.2 v0.8.0 enrichment

- `FEATURE_007` Theme System Consolidation
- `FEATURE_018` CodeWiki and Task Knowledge Substrate
- `FEATURE_028` First-Class Search, Retrieval, and Evidence Tooling
- `FEATURE_035` MCP Capability Provider
- `FEATURE_038` Official Sandbox Extension

### 10.3 later delivery

- `FEATURE_031` Multimodal Artifact Inputs
- `FEATURE_023` Dual-Mode Terminal UX
- `FEATURE_030` Multi-Surface Delivery

---

## 11. Migration Principles

1. Reuse existing project harness strengths instead of discarding them.
2. Move persistent truth from project-only semantics to task-first semantics.
3. Keep user-visible compatibility while changing the internal engine.
4. Prefer evidence loops over heavier prompts.
5. Remove scaffolding when models or runtime guarantees make it unnecessary.

---

## 12. References

- [ADR](ADR.md)
- [PRD](PRD.md)
- [Detailed Design](DD.md)
- [Feature Roadmap](features/README.md)

---

## Appendix A: Current System Reference

The sections above describe the target architecture. This appendix retains a compact reference to the current system shape so migration work does not lose contact with the existing codebase.

### A.1 Current layered packaging

Current package layout remains:

```text
KodaX/
  packages/
    ai/
    agent/
    coding/
    repl/
    skills/
  src/
    kodax_cli.ts
```

### A.2 Current package dependency direction

```text
CLI/root
  -> REPL
    -> Coding
      -> Agent
        -> AI
      -> Skills
```

This remains an important migration constraint:

- no circular dependencies
- reusable lower layers
- product-grade logic primarily in `@kodax/coding` and `@kodax/repl`

### A.3 Current runtime patterns worth preserving

Current KodaX already relies on patterns that the new architecture should preserve rather than erase:

- provider abstraction + registry
- streaming-first output
- centralized tool registry and execution
- session persistence
- permission modes
- skills and command discovery

### A.4 Current product surfaces

Today KodaX already spans:

- one-shot CLI execution
- interactive REPL/TUI behavior
- ACP server support
- long-running project/harness flows

The target task engine should absorb these surfaces rather than fork them into separate architectures.

---

## Appendix B: Restored Pre-Reset HLD Notes

This appendix restores higher-detail current-state notes from the earlier HLD so the new target architecture does not erase the practical structure of the existing system.

### B.1 Design philosophy retained

The earlier HLD centered on:

- extreme lightness
- LLM-first behavior instead of overgrown rule systems
- reusable layered packaging
- zero-config startup with sensible defaults

Those values remain valid and still explain many present implementation choices.

### B.2 Layered architecture snapshot

```text
CLI Layer
  command parse | file storage | event handler
      ↓
Interactive Layer (REPL)
  Ink UI | permission control | built-in commands
      ↓
Coding Layer
  tools | prompts | agent loop
      ↓
Agent Layer
  session management | messages | tokenizer
      ↓
AI Layer
  providers | stream handling | error handling
```

Important retained point:

- `Skills` behave like a sidecar layer that can be loaded without dragging in the whole runtime.

### B.3 Module structure retained

```text
KodaX/
├── packages/
│   ├── ai/       # provider abstraction
│   ├── agent/    # session and agent substrate
│   ├── coding/   # coding runtime
│   ├── repl/     # interactive surface
│   └── skills/   # zero-dependency skills layer
├── src/          # CLI entry
└── docs/         # documentation
```

Current dependency direction remains:

```text
CLI/root
  -> REPL
    -> Coding
      -> Agent
        -> AI
      -> Skills
```

### B.4 Core design patterns retained

#### Provider abstraction and registry

Still a foundational pattern:

- shared base provider contract
- lazy registration and lookup
- provider-specific streaming implementations hidden behind one surface

#### Tool registry

Still a foundational pattern:

- centralized tool registration
- standard handler contract
- decoupled tool implementations

#### Streaming-first output

Still a foundational pattern:

- incremental text/thinking/tool events
- better observability and cancelability
- compatible with long-running and verifier-heavy flows

#### Permission modes

Still a foundational pattern:

- `plan`
- `default`
- `accept-edits`
- `auto-in-project`

These remain user-facing safety semantics even as deeper sandboxing evolves.

### B.5 Current data-flow notes retained

#### Agent loop

The current runtime still broadly follows:

1. build messages
2. call provider in streaming mode
3. collect text/thinking/tool blocks
4. execute tools if needed
5. append tool results
6. continue or finish
7. persist session state

#### Session persistence

Retained current-state traits:

- JSONL-style append-friendly persistence
- git-root-aware session identity
- resumable message history

### B.6 Extension and customization notes retained

Current customization paths still matter:

- custom providers via registration
- custom tools via the tool registry
- custom skills via markdown files in user and project directories

These are the baseline extension paths that `FEATURE_034` should evolve, not discard.

### B.7 Safety boundary notes retained

The older HLD carried several practical safety boundaries that are still relevant:

- protected config paths such as `.kodax/` and `~/.kodax/`
- stronger confirmation outside the project root
- permission-mode-specific write and shell restrictions

These boundaries still inform both approval UX and future sandbox profiles.

### B.8 Performance notes retained

Important current performance strategies remain:

- token-aware compaction
- bounded context growth
- selective parallel tool execution
- streaming-first UX to reduce perceived latency

### B.9 Technology baseline retained

| Category | Baseline |
|---|---|
| Runtime | Node.js `>= 20.0.0` |
| Language | TypeScript `>= 5.3.0` |
| Package manager | npm workspaces |
| Current terminal renderer | Ink |
| Test framework | Vitest |

### B.10 Future extension themes retained

The earlier HLD's extension themes are still relevant, even though they now map to different feature ownership:

- multi-agent coordination
- richer plugin and capability ecosystems
- VS Code / IDE integration
- stronger visual and remote surfaces
