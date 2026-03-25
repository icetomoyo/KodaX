# KodaX Architecture Decision Records

> Last updated: 2026-03-25
> This ADR set reflects the architecture reset carried by `FEATURE_022`, which promotes KodaX from a command-led coding CLI into an adaptive multi-agent task engine.

---

## ADR-001: Keep the Layered Monorepo

**Status**: Accepted

KodaX keeps the layered monorepo structure:

- `@kodax/ai`: provider abstraction
- `@kodax/agent`: generic session and compaction substrate
- `@kodax/coding`: headless coding runtime
- `@kodax/repl`: interactive surfaces
- `@kodax/skills`: reusable instruction bundles

Reasoning:

- The layers are already understandable and reusable.
- The new task engine should be built on top of the current package boundaries, not by collapsing them.
- `@kodax/coding` remains the correct place for the product-grade runtime, because it already owns prompts, tools, orchestration, and the coding loop.

---

## ADR-002: KodaX Becomes an Adaptive Task Engine

**Status**: Proposed

KodaX should no longer treat `Project Mode` as the main product abstraction.

The new primary abstraction is a **task**:

- a task may be a one-shot answer
- a task may become a managed long-running task
- a task may require planning, execution, and evaluation
- a task may require one agent or multiple agents

Reasoning:

- Users should not need to decide up front whether they are "in project mode".
- The system should determine whether a request needs discovery, durable state, verification, or multi-agent execution.
- This aligns better with how users naturally work: they describe intent, not mode.

Consequence:

- `/project` becomes a control surface over managed tasks instead of the product center.
- `feature_list.json`, `.agent/project/`, session plans, and harness artifacts become part of a broader task-state model.

---

## ADR-003: Non-Trivial Tasks Default to Native Multi-Agent Execution

**Status**: Proposed

KodaX should adopt native multi-agent execution for non-trivial work.

The system should treat the following as separate responsibilities:

- `Lead`: routing, decomposition, synthesis, escalation
- `Planner`: scope expansion, success criteria, contract drafting
- `Generator`: implementation
- `Evaluator`: skeptical grading, QA, acceptance decisions

Reasoning:

- A single agent that plans, implements, and self-approves is structurally unreliable.
- Separating implementation from evaluation is now a load-bearing requirement, not an optimization.
- Anthropic's 2026 harness work shows that planner/generator/evaluator separation produces materially better long-running outputs than naive single-agent loops.

Consequence:

- Single-agent execution remains only as a low-complexity fallback.
- KodaX should reason in terms of role separation even when the runtime chooses a minimal harness profile.

---

## ADR-004: Replace Sprint-Centric Project Semantics with Contract-Centric Task Semantics

**Status**: Proposed

The system should standardize on **task contracts** rather than hard-coding `project` or `sprint` semantics into the user-facing workflow.

A task contract defines:

- the active scope
- the deliverable
- the acceptance criteria
- the evidence expected from evaluation

Reasoning:

- The current `/project` workflow is useful but too tied to a specific long-running coding path.
- Contracts generalize better to bug fixes, reviews, refactors, investigations, and broader long-running app development.
- Contracts are the right bridge between a high-level prompt and testable work.

Consequence:

- Future managed runs should be organized around negotiated contracts.
- `feature_list.json` remains valid for some tasks, but it stops being the only truth model.

---

## ADR-005: Evidence, Not Self-Report, Defines Completion

**Status**: Accepted

KodaX should continue to treat self-reported completion as insufficient.

Completion must be derived from evidence such as:

- deterministic checks
- test results
- UI/browser verification
- contract criteria coverage
- structured evaluator findings

Reasoning:

- This is already the strongest part of the current `Project Harness`.
- The next architecture should generalize this approach rather than replace it.

Consequence:

- Evaluators need a first-class evidence model.
- The storage model should preserve run artifacts, findings, checkpoints, and evaluator decisions.

---

## ADR-006: `/project` Becomes a Transitional Control Surface

**Status**: Proposed

`/project` should remain available, but its role changes.

It becomes:

- a state viewer
- a control plane UI
- a manual override surface
- a diagnostic entry point

It should stop being the only way to access durable harness behavior.

Reasoning:

- Current KodaX users already rely on `/project`.
- Removing it outright would create unnecessary churn.
- Internalizing managed execution while keeping `/project` as an inspection and override surface gives the best migration path.

---

## ADR-007: Retire `--team` as a Product Concept

**Status**: Proposed

The current `--team` flow should be treated as legacy orchestration plumbing, not the future multi-agent product.

Reasoning:

- It only accepts comma-separated parallel prompts.
- It lacks role semantics, contract negotiation, evaluator authority, durable task truth, and evidence aggregation.
- It does not represent the architecture KodaX now wants to ship.

Consequence:

- Future documentation should stop presenting `--team` as the multi-agent story.
- Feature planning should assume `FEATURE_022` replaces it with a real control plane.

---

## ADR-008: Provider Capability Must Influence Harness Shape

**Status**: Proposed

Harness choice should depend on model capability, not just user preference.

The provider/model capability profile should inform:

- whether planning is lightweight or explicit
- whether evaluation is mandatory
- whether long uninterrupted runs are safe
- whether stronger resets or stronger decomposition are required
- expected cost and latency envelopes

Reasoning:

- Different providers and models do not fail in the same way.
- A fixed harness wastes cost on strong models and under-supports weaker ones.

Consequence:

- `FEATURE_029` becomes strategically important, not merely diagnostic.

---

## ADR-009: Keep the Runtime Headless and Surface-Agnostic

**Status**: Accepted

The new task engine should remain headless and reusable across:

- CLI
- REPL / TUI
- ACP / IDE
- future desktop and web surfaces

Reasoning:

- Multi-surface delivery is a roadmap objective, not a separate product.
- The control plane, storage model, and agent orchestration logic should not be trapped inside one UI.

Consequence:

- `FEATURE_030` depends on the runtime choices made by `FEATURE_022`, `FEATURE_025`, and `FEATURE_034`.

---

## ADR-010: Use Simplification as a First-Class Maintenance Rule

**Status**: Accepted

KodaX should actively remove harness components once they stop being load-bearing.

Reasoning:

- Better models shift which scaffolding is necessary.
- A harness that only grows becomes brittle, expensive, and hard to reason about.
- The goal is not "more agents"; the goal is "the minimum structure that preserves reliability at current model capability".

Consequence:

- Every new harness component should have a clear failure mode it addresses.
- Feature docs should describe both why a component exists and what would allow it to be removed later.

---

## Appendix A: Retained Historical Design Decisions

The architecture reset did not invalidate a number of earlier accepted implementation decisions. They remain worth retaining as practical and historical reference.

### A.1 Provider abstraction and registry

Still valid:

- providers implement one shared abstraction
- provider lookup remains registry-based
- factory-style registration keeps instantiation lazy

Why it still matters:

- new harness logic still depends on one provider interface
- native vs bridge-backed semantics can only be compared cleanly if the abstraction remains explicit

### A.2 Streaming-first output

Still valid:

- providers should prefer streaming output
- hosts should continue to receive incremental text, thinking, and tool lifecycle updates

Why it still matters:

- task-engine routing does not remove the UX need for real-time feedback
- evaluators and long-running flows benefit from observable progress

### A.3 Permission modes remain real product behavior

Still valid:

- read-only / plan behavior
- guarded default mode
- edit-accepting modes
- stronger automation within controlled project flows

Why it still matters:

- sandbox and capability work do not replace approval UX
- task-engine execution still needs a user-facing permission model

### A.4 Skills remain markdown-first instruction bundles

Still valid:

- skills stay lightweight and file-based
- skill discovery and natural-language triggering remain part of the product

### A.5 Ink is still the current terminal renderer

Still valid:

- Ink remains the current interactive terminal baseline

Why it still matters:

- `FEATURE_023` is an interaction and renderer-evolution feature, not a reason to erase current renderer history

### A.6 Tool registry remains foundational

Still valid:

- tools are still registered and executed through one central runtime contract

Why it still matters:

- `FEATURE_034` evolves this design, but does not remove its importance

### A.7 Session persistence remains foundational

Still valid:

- persistent sessions and resumable history remain core product behavior

Why it still matters:

- `FEATURE_019` extends this into task-aware lineage instead of replacing the need for durable session truth

### A.8 Promise signals and interactive control still matter

Still valid:

- completion / blocked / decision-style control signals remain part of current long-running behavior
- pending input and interruption flows remain important runtime realities

### A.9 Autocomplete and trigger-behavior history is still useful

Still valid:

- multi-source autocomplete
- careful trigger-character behavior to avoid false positives in paths and URLs

Why it still matters:

- these decisions still inform terminal UX evolution under `FEATURE_023`

---

## Appendix B: Historical ADR Outline (Pre-Reset)

The earlier ADR file recorded a set of already-adopted implementation decisions in more traditional ADR form. They are preserved here so that historical wording, scope, and rationale are not lost.

### B.1 ADR-001: 5-layer independent architecture

Original intent retained:

- CLI, Interactive, Coding, Agent, AI, plus zero-dependency Skills concerns
- each layer should remain independently useful and testable
- architecture should favor reuse and clearer evolution boundaries

### B.2 ADR-002: Provider abstraction pattern

Original intent retained:

- support many providers behind one interface
- use an abstract base plus registry pattern
- keep provider differences isolated behind the provider layer

### B.3 ADR-003: Streaming-first output

Original intent retained:

- users should see output incrementally
- long responses should not block on full completion
- stream lifecycle events are part of both UX and debugging

### B.4 ADR-004: Permission mode system

Original intent retained:

- balance safety and speed through explicit modes
- keep dangerous actions gated
- let trust increase progressively instead of being all-or-nothing

### B.5 ADR-005: Skills as markdown instruction bundles

Original intent retained:

- keep skills lightweight and portable
- prefer plain markdown for authoring and version control
- support reusable task templates without a heavy plugin runtime

### B.6 ADR-006: Ink as the CLI UI framework

Original intent retained:

- build interactive terminal UX with React-style composition
- use a renderer that supports complex TUI state without abandoning the Node stack

### B.7 ADR-007: Tool registry pattern

Original intent retained:

- register tools centrally
- decouple tool execution logic from the agent loop
- keep the runtime extensible and testable

### B.8 ADR-008: Session persistence format

Original intent retained:

- persist sessions in append-friendly text formats
- keep sessions inspectable and resumable
- support long-running and cross-session continuity

### B.9 ADR-009: Promise signal system

Original intent retained:

- allow the agent to surface explicit control outcomes such as completion, blocked state, and decision requests
- give the host a structured way to react to long-running flows

### B.10 ADR-010: Multi-source autocomplete

Original intent retained:

- merge completions from commands, files, skills, and other sources
- keep the completion architecture extensible through specialized completers

### B.11 ADR-011: Trigger-character whitespace rule

Original intent retained:

- avoid false trigger behavior in URLs and file paths
- require start-of-input or whitespace-aware trigger positions for `/` and `@`
