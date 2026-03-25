# KodaX Product Requirements

> Last updated: 2026-03-25
>
> This PRD captures the product shift tracked by `FEATURE_022`: from "CLI plus Project Mode" to "adaptive task engine with native multi-agent execution."

---

## 1. Product Position

KodaX is a coding system for people who want:

- a lightweight and inspectable codebase
- strong provider flexibility
- reliable long-running execution
- minimal user-facing mode switching
- a path from terminal use to embedded and multi-surface use

The product should feel simple, but its internal execution model should be sophisticated.

The key shift is:

- old model: a single agent plus optional project workflows
- new model: a task engine that decides when planning, multiple agents, and verification are needed

---

## 2. User Promise

When a user asks KodaX to do work, KodaX should:

1. understand whether the task is simple or complex
2. choose the right execution shape automatically
3. preserve task truth when the work is long-running
4. avoid trusting the executor's self-report
5. give the user inspection and override tools without forcing upfront mode decisions

In short:

- minimal on the outside
- intelligent in the middle
- reliable at the end

---

## 3. Product Principles

### 3.1 Invisible mode selection

Users should not have to decide whether they are in "project mode", "brainstorm mode", or "multi-agent mode" before they can ask for work.

### 3.2 Native multi-agent for non-trivial work

Non-trivial tasks should default to role separation:

- planning
- execution
- evaluation

Single-agent execution is a fallback, not the main architecture.

### 3.3 Evidence over optimism

Completion should depend on evidence and evaluator judgment, not the executor saying "done".

### 3.4 Durable task state

Long-running work needs persisted truth:

- task envelope
- contract
- plan
- evidence
- checkpoints
- lineage

### 3.5 Provider-aware behavior

KodaX should adapt to the actual semantics of the selected provider instead of assuming every provider behaves like the best native implementation.

### 3.6 Progressive simplification

As models and runtime guarantees improve, KodaX should remove scaffolding that is no longer load-bearing.

---

## 4. Primary User Journeys

### 4.1 Quick answer

User intent:

- explain code
- summarize a file
- answer a conceptual question

Expected behavior:

- lightweight routing
- no unnecessary task ceremony
- fast answer

### 4.2 Directed code change

User intent:

- make a small edit
- fix a bug
- add a focused behavior

Expected behavior:

- automatic detection that evaluation is needed
- generator plus evaluator flow
- clear summary of what changed and what was verified

### 4.3 Ambiguous or architectural request

User intent:

- "build X"
- "improve this system"
- "make this production-ready"

Expected behavior:

- auto-triggered discovery or brainstorm
- contract creation before major execution
- explicit scope and assumptions

### 4.4 Long-running delivery

User intent:

- multi-file refactor
- feature delivery across many turns
- sustained work over time

Expected behavior:

- durable task state
- checkpoints
- evidence accumulation
- native multi-agent orchestration
- resumable execution

---

## 5. Core Product Capabilities

### 5.1 Task intake and routing

The system must determine:

- task kind
- complexity
- risk
- append vs overwrite
- whether brainstorm is needed
- whether durable state is required
- which harness profile to use

### 5.2 Native multi-agent execution

The system must support:

- `Lead`
- `Planner`
- `Generator`
- `Evaluator`
- optional specialist workers

### 5.3 Evidence-driven verification

The system must support:

- deterministic checks
- evaluator review
- evidence capture
- completion verdicts
- retry loops when evidence is insufficient

### 5.4 Durable task memory

The system must persist:

- task envelope
- contract
- decisions
- evidence
- checkpoints
- session tree / lineage

### 5.5 Capability substrate

The system must support:

- extensible tools and capabilities
- sandbox and MCP as optional runtime capabilities
- structured result transport
- host-neutral loading

### 5.6 Multi-surface readiness

The runtime must be reusable across:

- terminal
- ACP host integrations
- future IDE and desktop surfaces

---

## 6. Target User Experience

### 6.1 What the user should feel

- "I can just ask."
- "The system knows when to think harder."
- "The system does not overcomplicate simple tasks."
- "Long-running work feels managed instead of fragile."
- "When KodaX says a task is done, it can explain why."

### 6.2 What the user should not need to think about

- whether to manually enter project mode
- whether to manually request brainstorm mode
- whether to manually choose multi-agent architecture
- whether the executor is self-grading its own work

---

## 7. Transitional UX Policy

### 7.1 `/project`

`/project` remains available, but its role changes:

- status and inspection
- manual override
- resume, pause, or verify
- artifact browsing

It is no longer the conceptual center of the product.

### 7.2 `--init` and `--auto-continue`

These stay as compatibility and convenience entry points, but should route into the same task engine used by natural requests.

### 7.3 `--team`

`--team` should stop being treated as the main multi-agent product story.

If retained temporarily, it should be documented as legacy or compatibility-oriented behavior.

---

## 8. Out-of-Scope Ideas

The architecture reset intentionally avoids:

- mandatory heavyweight multi-agent execution for every prompt
- hidden or opaque score systems without inspectable evidence
- unlimited branch-search or auto-generated harness code
- using the extension runtime as a catch-all orchestration layer

---

## 9. Success Criteria

### 9.1 Product outcomes

1. Users can issue long-running requests without first choosing "project mode".
2. Non-trivial write tasks use independent evaluation by default.
3. Managed tasks survive interruption with durable state.
4. Provider differences are explicit instead of silently flattened.
5. KodaX can evolve into IDE, desktop, and remote surfaces without rewriting the core engine.

### 9.2 Quality outcomes

1. Fewer false-positive "done" states.
2. Clearer reasoning about append vs overwrite.
3. Better behavior on ambiguous tasks.
4. Better trust in long-running automation.

---

## 10. Roadmap Strategy

### 10.1 Foundation release: v0.7.0

Goals:

- install the new core engine shape
- make multi-agent native
- make task routing explicit
- keep `034` as the runtime substrate

Features:

- `019` Session Tree, Checkpoints, and Rewindable Task Runs
- `022` Native Multi-Agent Control Plane
- `025` Adaptive Task Intelligence and Harness Router
- `026` Roadmap Integrity and Planning Hygiene
- `029` Provider Capability Transparency and Harness Policy
- `034` Extension and Capability Runtime

### 10.2 Enrichment release: v0.8.0

Goals:

- deepen retrieval, knowledge, and runtime safety

Features:

- `007` Theme System Consolidation
- `018` CodeWiki and Task Knowledge Substrate
- `028` First-Class Search, Retrieval, and Evidence Tooling
- `035` MCP Capability Provider
- `038` Official Sandbox Extension

### 10.3 Delivery releases

Later priorities:

- `031` Multimodal Artifact Inputs
- `023` Dual-Mode Terminal UX
- `030` Multi-Surface Delivery

---

## 11. Dependencies and Boundaries

### 11.1 Runtime substrate

`FEATURE_034` is necessary and should remain strong, but it is not the multi-agent control plane.

### 11.2 Verification substrate

The existing project harness ideas remain valuable, but they should be generalized into task-level evidence and evaluator semantics.

### 11.3 Legacy project artifacts

Current project truth files and `.agent/project/` remain useful as migration inputs, not as the permanent core abstraction.

---

## 12. References

- [ADR](ADR.md)
- [HLD](HLD.md)
- [Detailed Design](DD.md)
- [Feature Roadmap](features/README.md)

---

## Appendix A: Retained Product Baseline and Constraints

The sections above define the target product direction after the `FEATURE_022` shift. The appendix below restores important baseline product information from the earlier PRD so implementation work still has access to the current-product frame, constraints, and release history.

### A.1 Original product positioning

KodaX remains a lightweight TypeScript coding agent with:

- a layered architecture whose lower layers can be reused independently
- broad multi-provider support
- explicit permission modes and tool confirmations
- extension points across providers, tools, and skills

That baseline still matters even as the product shifts from "CLI plus Project Mode" to a task engine.

### A.2 Target users retained

| User type | Typical use | Core need |
|---|---|---|
| Independent developers | daily coding assistance | speed, low cost, provider choice |
| Team developers | review, refactor, guided edits | consistency, configurability, permissions |
| DevOps and automation users | CI/CD, unattended flows | automation, reliability, long-running behavior |
| AI builders and researchers | agent experiments | modularity, reusability, inspectability |

### A.3 Current core feature baseline

| Capability | Baseline value | Priority in the old PRD |
|---|---|---|
| Multi-provider support | Anthropic, OpenAI, Google-adjacent, Zhipu, Kimi, MiniMax, DeepSeek, bridge-backed providers | `P0` |
| Interactive REPL | Ink / React terminal UI with streaming output | `P0` |
| Tool set | read, write, edit, bash, glob, grep, undo, diff, ask-user | `P0` |
| Permission modes | `plan`, `default`, `accept-edits`, `auto-in-project` | `P0` |
| Session management | save, resume, list, delete | `P1` |
| Thinking / reasoning mode | supported on capable providers | `P1` |
| Parallel tool execution | multi-tool parallelism where safe | `P1` |
| Skills system | markdown-defined reusable instruction bundles | `P1` |
| Long-running flows | project workflows, harness, resumable automation | `P2` |
| Multi-agent work | now re-scoped under `FEATURE_022` | `P2` historically, now foundational |

### A.4 Technical constraints retained

| Area | Constraint |
|---|---|
| Runtime | Node.js `>= 20.0.0` |
| Language | TypeScript `>= 5.3.0` |
| CLI stack | Ink (`React for CLI`) remains the current renderer baseline |
| Tests | Vitest remains the primary test framework |
| Packaging | npm workspaces monorepo |
| Licensing | allow Apache / BSD / MIT style dependencies; avoid GPL / SSPL |
| Architecture | packages should remain independently useful where practical |
| Dependency direction | no circular dependencies |
| Quality bar | target high type safety and strong test coverage |

### A.5 Functional requirements by layer retained

#### `@kodax/ai`

Still requires:

- shared provider abstraction
- unified streaming interface
- provider registry
- normalized errors
- provider-aware reasoning controls where supported

#### `@kodax/agent`

Still requires:

- session management
- message persistence and reconstruction
- compaction-friendly message handling
- token estimation support

#### `@kodax/skills`

Still requires:

- skill discovery from user and project locations
- markdown-first skill execution
- natural-language triggering
- support for built-in and custom skills

#### `@kodax/coding`

Still requires:

- tool definitions and execution
- prompt construction
- coding loop orchestration
- permission integration
- long-running and harness-friendly runtime behavior

#### `@kodax/repl`

Still requires:

- interactive terminal UX
- permission controls
- built-in commands
- autocomplete
- theme support
- managed task and project control surfaces

### A.6 Non-functional requirements retained

| Area | Retained expectation |
|---|---|
| First response latency | aim for a fast first token / first visible response |
| Memory | avoid unnecessary runtime bloat |
| Type safety | keep public APIs strongly typed |
| Testability | components should remain independently testable |
| Cross-platform support | Windows, macOS, and Linux remain supported targets |
| Documentation | public interfaces and major workflows should remain documented |

### A.7 Release history retained

Important shipped milestones from the previous PRD remain useful as product history:

- `v0.5.x`: 5-layer architecture stabilized
- `v0.5.33`: autocomplete system and broader provider set
- `v0.6.0`: Command System 2.0 and Project Mode 2.0
- `v0.6.4`: history review mode and mouse-wheel interaction improvements
- `v0.6.10`: Project Harness and artifact migration
- `v0.6.15`: ACP server, provider growth, pending inputs, and runtime controls

The target state has changed, but these milestones remain part of the path that led to the current architecture.

### A.8 Risk baseline retained

| Risk | Why it still matters | Typical mitigation |
|---|---|---|
| Provider API changes | can break integrations quickly | isolate through provider abstraction |
| Dependency vulnerabilities | affect local execution trust | dependency review and updates |
| Context and token limits | still shape runtime behavior | compaction and provider-aware policy |
| Concurrency hazards | affect tool safety and determinism | guarded parallelism and explicit ownership |
| False-positive completion | more serious under automation | evaluator separation and evidence model |

### A.9 Glossary retained

| Term | Meaning |
|---|---|
| Provider | implementation of a model backend |
| Tool | callable runtime capability exposed to the agent |
| Skill | reusable instruction bundle |
| Session | persisted conversation/runtime history |
| Task | first-class managed work unit in the new architecture |
| Contract | task-local scope and completion criteria |
| Evidence | persisted proof used for completion judgment |
