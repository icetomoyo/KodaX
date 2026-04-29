# AMA Harness Selection Calibration — Benchmark Dataset

> **Owner**: FEATURE_106 (v0.7.31)
> **Hosting**: `tests/ama-harness-selection.eval.ts`
> **Run**: `npm run test:eval -- ama-harness-selection`

## Product question

Does the Scout role-prompt correctly classify tasks into H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL across the 8 coding-plan provider/model aliases configured in `benchmark/harness/aliases.ts`?

Specifically, this dataset measures the bias FEATURE_106 was created to fix: **multi-file projects sinking into H0_DIRECT** instead of escalating to H1 / H2.

## What it tests

6 tasks split into 3 classes, 2 tasks per class:

| Task id | Class | Expected harness | Description |
|---|---|---|---|
| `h0-typo` | H0-clean | `H0_DIRECT` | Single-file single-line typo fix |
| `h0-lookup` | H0-clean | `H0_DIRECT` | Pure-answer lookup, no mutation |
| `h1-multifile-bugfix` | H1-clean | `H1_EXECUTE_EVAL` | Known bug across 2 files, scope explicit |
| `h1-refactor` | H1-clean | `H1_EXECUTE_EVAL` | Mechanical rename across 5 files |
| `h2-newproject` | H2-clean | `H2_PLAN_EXECUTE_EVAL` | New TypeScript REST API package from scratch |
| `h2-architectural` | H2-clean | `H2_PLAN_EXECUTE_EVAL` | Cross-module architectural feature add |

Each task is sent to each model with each prompt variant. A judge inspects the model's output for an explicit harness commitment.

## Prompt variants

| Variant id | Description | Status |
|---|---|---|
| `current` | v0.7.30 Scout role-prompt §QUALITY FRAMEWORK verbatim — the prompt that produced the H0 bias | Available (this commit) |
| `feature_106` | FEATURE_106 Slice 2 rewritten Scout prompt: H0 bound quantified (≤1 file ≤30 lines), SCOPE COMMITMENT hard rule | Added in FEATURE_106 Slice 2 implementation |

Stage 0 baseline runs the `current` variant only (48 cells = 6 task × 8 alias × `current` × 1 reasoning).
Stage 1 runs `feature_106` only (also 48 cells); compared cell-by-cell vs Stage 0 to detect quality regression.
Stage 2 runs both variants × 3 reasoning profiles (108 cells) to give FEATURE_103 reasoning decision quantitative support.

## Judges

For every cell:

| Judge | Category | Pass when |
|---|---|---|
| `harness-format` | `format` | Output contains `HARNESS:` or `confirmed_harness` followed by one of the three harness ids |
| `harness-correct` | `correctness` | The matched harness id equals the task's `expectedHarness` |
| `no-stale-tool-name` | `safety` | Output does NOT mention `emit_managed_protocol` (v0.7.22 stale name; if Scout cites it, our prompt is leaking outdated instruction) |

All three are zero-LLM regex judges — keeps the eval cheap and reproducible.

## Result interpretation

The `current` variant is expected to fail on H1/H2 tasks (that's the bug FEATURE_106 fixes). Concretely we expect to see:

- `harness-correct` on H0-clean tasks: ≥80% across 8 alias (H0 is the natural default, should be easy)
- `harness-correct` on H1-clean tasks: low — predominantly outputs `H0_DIRECT` instead of `H1_EXECUTE_EVAL` (the bug)
- `harness-correct` on H2-clean tasks: low — predominantly outputs `H0_DIRECT` (the bug)

After FEATURE_106 Slice 2 prompt rewrite lands, `feature_106` variant should hit:
- H0-clean: ≥95% (baseline kept)
- H1-clean: ≥80% (bug fixed)
- H2-clean: ≥80% (bug fixed)
- Cross-alias mean ≥80%, std ≤8% (acceptance criteria from FEATURE_106 design)

## When to re-run

- Any change to Scout role-prompt (`packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`)
- Any change to Scout reasoning profile (`packages/coding/src/agents/coding-agents.ts:scoutSpec.reasoning`)
- New provider/model added to alias table

## Last-run conclusion

_Stage 0 baseline pending — run when API keys configured._

## See also

- [FEATURE_106 设计](../../../docs/features/v0.7.31.md#feature_106-ama-harness-selection-calibration)
- [FEATURE_104 Prompt-Eval Harness](../../README.md)
- [Scout role-prompt source](../../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts)
