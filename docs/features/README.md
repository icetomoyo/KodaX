# KodaX Feature Design Index

> Last updated: 2026-04-11
>
> Current released version: `v0.7.15`
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
- `FEATURE_054` is the intended convergence path for folding legacy Project semantics into AMA H2; do not read older project-mode docs as authorization to keep a second planning surface alive
- `Work x/200` is the primary budget UX
- `Round` is only user-visible when a real extra pass exists

## Current and upcoming feature docs

| Doc | Role |
|---|---|
| [v0.7.0.md](./v0.7.0.md) | Engine foundation and AMA simplification |
| [v0.7.10.md](./v0.7.10.md) | Repository intelligence, AMA cleanup, skill-aware orchestration |
| [v0.7.15.md](./v0.7.15.md) | Provider resilience, retry UX, and graceful recovery |
| [v0.7.18.md](./v0.7.18.md) | Engineering shell maturity: hook automation, cost observatory, MCP protocol, permission hardening |
| [v0.7.20.md](./v0.7.20.md) | Roadmap integrity and planning hygiene, plus historical staging notes for features re-homed to `v0.8.0` |
| [v0.7.25.md](./v0.7.25.md) | Host-aware TUI substrate close-out and historical staging for AMA-project convergence |
| [v0.7.30.md](./v0.7.30.md) | Runtime clarity, harness safety, multimodal/repo substrate, and transcript-native tool interaction maturity |
| [v0.8.0.md](./v0.8.0.md) | Dual-profile AMA, MCP substrate, prompt architecture, retrieval/evidence tooling, invisible parallelism, and durable memory |
| [v0.9.0.md](./v0.9.0.md) | REPL substrate hardening close-out and historical staging for features moved earlier |
| [v1.0.0.md](./v1.0.0.md) | Delivery surfaces outside the frozen shell |

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
- `FEATURE_051` is now the completed visible-shell close-out for the REPL.
- `FEATURE_055` closes the remaining REPL substrate hardening without reopening the shell surface.
- `FEATURE_046 / 047 / 052` describe AMA substrate and fan-out rules; they do not authorize a heavier multi-agent REPL surface by themselves.
- For REPL/TUI context, read `051 -> 055 -> 046/047/052` in that order.
- `FEATURE_054 / 038 / 031 / 042 / 053 / 043 / 023 / 056` are now intentionally grouped under `v0.7.30` so runtime clarity, harness safety, and transcript-native interaction maturity can be advanced together.
- `FEATURE_054` is the architecture-side convergence doc for removing the old Project split; read it before trusting any older `/project` references.
- `FEATURE_023` is now a future delivery/terminal-ergonomics doc, not a license to reopen REPL shell redesign already closed by `051/055`.
- `FEATURE_031` and `FEATURE_042` stay transcript-first and summary-first: multimodal intake should not become a media workbench, and repo intelligence should not become a graph product.
- `FEATURE_056` is the planned follow-up for tool interaction maturity inside the frozen shell: it should improve explanation, diff/progress/error affordances, and transcript-native actions without adding a control-tower UI.
- `v0.7.18` (Engineering Shell Maturity) derives from a systematic KodaX vs Claude Code comparison analysis (2026-04-11). It addresses real engineering-shell gaps without violating the minimalist philosophy: hook automation substrate (063), multi-provider cost tracking (064), MCP OAuth/elicitation (065), bash risk classification and denial tracking (066). IDE Bridge (#093) was deliberately downgraded to Low priority given the Vibe Coding paradigm shift.
