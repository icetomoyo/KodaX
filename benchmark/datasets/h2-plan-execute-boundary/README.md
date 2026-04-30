# H2 Plan-Execute Boundary Eval — Dataset

> **Owner**: FEATURE_107 (v0.7.32)
> **Hosting**: TBD `tests/h2-plan-execute-boundary.eval.ts` (P3)
> **Run**: TBD `npm run test:eval -- h2-plan-execute-boundary`

## Status

P1.0 complete (candidate scan). P1.5 (human review + dataset finalization) pending.

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
