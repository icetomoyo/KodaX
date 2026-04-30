# H2 Plan-Execute Boundary Eval — Dataset

> **Owner**: FEATURE_107 (v0.7.32)
> **Hosting**: TBD `tests/h2-plan-execute-boundary.eval.ts` (P3)
> **Run**: TBD `npm run test:eval -- h2-plan-execute-boundary`

## Status

P1.0 + P1.5 complete (scan + dataset draft). P2 (B-path implementation) pending.

## Dataset composition

18 cases total (down from original 25–30 target — see "Dataset rebalance"):

| Category | Count | Source |
|---|---|---|
| Real-replay | 1 | `~/.kodax/sessions/runner-1777024449767.jsonl` chain |
| Multi-file feature impl | 5 | hand-curated |
| Cross-package refactor | 4 | hand-curated |
| Multi-file bug fix | 4 | hand-curated |
| TDD multi-file | 4 | hand-curated |

## Dataset rebalance (P1.0 finding)

P1.0 scan revealed:
- **0 real H2 sessions** in 533-session corpus (confirms FEATURE_107 telemetry pivot)
- Of 73 H0_DIRECT KodaX sessions, only 4 had any file mutation; all 4 are the same task chain
- Real telemetry candidate pool effectively yields ~1 viable case, not 60% of dataset

Decision: pivoted to **Path A** (hand-curated heavy) — 1 real + 17 hand-curated. Dataset bias acknowledged in P5.5 review.

## Product question

When AMA escalates to H2 (Scout → Planner → Generator → Evaluator), is the
`Planner → fresh Generator(+plan artifact)` handoff a lossy compression that
would benefit from same-session continuation (variant B)? And as a reference
point: does Planner role itself add value over H1 same-session execution?

## Files

| File | Purpose |
|---|---|
| `candidates.jsonl` | P1.0 output — should-have-been-H2 candidates from `~/.kodax/sessions/` |
| `candidates-report.md` | P1.0 human-readable summary |
| `scan-summary.json` | P1.0 stats (harness distribution, score buckets) |
| `cases.ts` | P1.5 final dataset (TBD) |

## Replay safety

Every case runs in an isolated git worktree at the historical SHA. Production
repos are NEVER touched. See FEATURE_107 §Eval 执行隔离 for full safeguards.

## Provenance

Sessions sourced from `~/.kodax/sessions/` (single-user CLI telemetry, local
only — KodaX is not SaaS). User authored all sessions. No external data.
