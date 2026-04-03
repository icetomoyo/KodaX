# KodaX Feature Design Index

> Last updated: 2026-04-02
>
> Current released version: `v0.7.10`
>
> Current architecture direction:
> `SA outside AMA` + `AMA H0/H1/H2` + `Scout -> skill-map -> Planner/Generator/Evaluator`

## How to read this directory

This directory mixes three kinds of documents:

1. Current-source-of-truth feature docs
2. Planned roadmap docs
3. Historical release design docs

If you only want the current AMA / task-engine direction, start with:

1. [v0.7.0.md](./v0.7.0.md)
2. [v0.7.10.md](./v0.7.10.md)
3. [../FEATURE_LIST.md](../FEATURE_LIST.md)
4. [../ADR.md](../ADR.md)
5. [../HLD.md](../HLD.md)
6. [../DD.md](../DD.md)

## Current source of truth

The current execution model is:

- `SA` is fully outside AMA
- AMA keeps only `H0_DIRECT`, `H1_EXECUTE_EVAL`, and `H2_PLAN_EXECUTE_EVAL`
- `Scout` is a pre-harness role, not part of the H2 worker graph
- `H2` is `Planner -> Generator <-> Evaluator`
- Skills are adapted into AMA through `Scout -> skill-map`
- Non-generator AMA roles reuse compact same-role summaries across rounds instead of full private-history continuity
- `Project` and `SA / AMA` are orthogonal; `Project + SA` persists a lightweight run record instead of a managed task
- `Work x/200` is the primary budget UX
- `Round` is only user-visible when a real extra pass exists

## Current and upcoming feature docs

| Doc | Role |
|---|---|
| [v0.7.0.md](./v0.7.0.md) | Engine foundation and AMA simplification |
| [v0.7.10.md](./v0.7.10.md) | Repository intelligence, AMA cleanup, skill-aware orchestration |
| [v0.7.15.md](./v0.7.15.md) | Provider resilience, retry UX, and graceful recovery |
| [v0.7.20.md](./v0.7.20.md) | Roadmap integrity and planning hygiene, plus historical staging notes for features re-homed to `v0.8.0` |
| [v0.7.25.md](./v0.7.25.md) | Host-aware TUI substrate, transcript verbosity, and review-fallback demotion |
| [v0.8.0.md](./v0.8.0.md) | Dual-profile AMA, MCP substrate, prompt architecture, retrieval/evidence tooling, invisible parallelism, durable memory, and safe runtime |
| [v0.9.0.md](./v0.9.0.md) | Multimodal inputs and harness maturation |
| [v1.0.0.md](./v1.0.0.md) | Delivery surfaces |

## Historical release docs

These documents remain useful as implementation history, but they are not the source of truth for the current AMA architecture:

- [v0.3.1.md](./v0.3.1.md)
- [v0.3.3.md](./v0.3.3.md)
- [v0.4.0.md](./v0.4.0.md)
- [v0.5.0.md](./v0.5.0.md)
- [v0.5.20.md](./v0.5.20.md)
- [v0.5.22.md](./v0.5.22.md)
- [v0.6.0.md](./v0.6.0.md)
- [v0.6.10.md](./v0.6.10.md)
- [v0.6.15.md](./v0.6.15.md)
- [v0.6.20.md](./v0.6.20.md)

## Reading guidance

- Historical docs may still mention old role names or layer boundaries as part of migration history.
- The active architecture should be interpreted through the top-level docs, not by reading an older release doc in isolation.
- When a historical doc and a current doc disagree, the current doc wins.
