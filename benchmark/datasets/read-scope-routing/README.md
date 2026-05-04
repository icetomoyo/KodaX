# Read-Scope Routing — Dataset for FEATURE_112 (v0.7.34)

## Product question

When a Scout faces a **read-only investigation** task, does the post-FEATURE_112
prompt rewrite (`SCOPE COMMITMENT` extended with investigation-scope rule + multi-thread
early decision rule + topology-ceiling semantic gloss) actually shift Scout's harness
choice toward `H1_EXECUTE_EVAL` for cases that warrant Evaluator audit, **without
regressing** simple-answer cases that should stay at `H0_DIRECT`?

This is the read-side counterpart to `ama-harness-selection` (FEATURE_106), which
covered the **mutation-side** harness leakage. FEATURE_106 closed `multi_file_h0_rate`
from 15.6% → 0%; FEATURE_112 attacks the symmetric issue on the read side: a
"why does this system behave like X" question that requires reading 5+ files
across multiple modules currently caps at H0 ceiling, so Scout has no path to
emit H1 for evaluator audit.

## Cases

4 task classes × the multi-alias matrix:

| ID | Class | Expected harness | Description |
|----|-------|------------------|-------------|
| `read-shallow-qa` | shallow QA | `H0_DIRECT` | Simple "what does X do" — must not regress |
| `read-deep-systemic` | deep investigation | `H1_EXECUTE_EVAL` | Multi-module "why" question — needs evaluator audit |
| `read-multithread` | multi-thread | `H1_EXECUTE_EVAL` | Independent investigation threads — should commit to escalation early |
| `read-unknown-heavy` | unknown + heavy | `H1_EXECUTE_EVAL` | Ambiguous scope likely to grow past 5 files |

The "expected" labels reflect KodaX product intent (FEATURE_112 design):
shallow QA stays direct; anything that needs an evaluator audit or a child
fan-out signals escalation by emitting `H1_EXECUTE_EVAL` (Scout still has
discretion — H1 ceiling is an upper bound, not a floor).

## Variants

| Variant ID | What it represents |
|------------|--------------------|
| `current_v0733` | v0.7.33 production prompt (FEATURE_106 SCOPE COMMITMENT only) — the baseline |
| `feature_112` | v0.7.34 prompt: SCOPE COMMITMENT extended with investigation-scope rule + multi-thread early-decision rule + topology-ceiling semantic gloss |

Both variants use the same `BENCHMARK_OUTPUT_INSTRUCTION` adapter as
`ama-harness-selection`, so the model can output either `HARNESS: <id>` or
`confirmed_harness=<id>`.

## Metrics

Per case class:

- **`harness-format`** — output contains a parseable `HARNESS: <id>` line. Format
  failures count as benchmark artefacts, not classification errors.
- **`harness-correct(expected)`** — emitted harness matches the expected label.
- **`no-regression-on-shallow`** — for the `read-shallow-qa` case, `feature_112`
  must keep ≥ 95% H0 correctness (no regression from `current_v0733`).
- **`read_scope_h1_rate`** — for the three deep classes (`deep-systemic`,
  `multithread`, `unknown-heavy`), pass threshold is `feature_112` ≥ `current_v0733`
  + 30 percentage points across alias mean (the symmetric counterpart to
  FEATURE_106's `multi_file_h0_rate ≤ 5%` target).

## Run model

Single-turn probe (per FEATURE_104 §single-step convention). The model gets the
Scout system prompt + the user message, and returns one short text reply with a
`HARNESS:` line. No tool dispatch, no continuation, no compaction — the only
question being measured is whether the prompt rewrite changes Scout's
harness-choice distribution on read-scope tasks.

## When to refresh

Re-run when:
- `role-prompt.ts` SCOPE COMMITMENT block changes (re-baseline).
- `decisionSummary` ceiling-gloss text changes (re-baseline).
- A new alias is added to `benchmark/harness/aliases.ts`.

Do NOT re-run for unrelated changes (compaction, runtime tooling, other roles).
