# Scout H0 Mini-Planner Strength — Dataset

Counterpart to `read-scope-routing/` and `ama-harness-selection/`. Probes the
**strength of mini-planner wording** in Scout's role-prompt for H0_DIRECT
multi-step tasks (FEATURE_097, v0.7.34).

## Product question

User feedback (2026-05-03):

> 我希望 H0 多步任务也能可靠看到结构化计划，但不希望简单任务被过度形式化。

Two competing forces:

- **More planning** → user gets visible checklist for medium tasks; LLM thinks
  through scope before acting (quality signal, ReAct-style benefit).
- **Less planning** → simple tasks (typo fix, single lookup) shouldn't be
  formalized into 3-step plans; over-formalization adds UI noise + wastes
  token budget.

The Scout role-prompt addendum that triggers `executionObligations` production
needs to thread this needle. This dataset measures whether a heavier "list
plan BEFORE acting" framing improves multi-step plan quality without
over-applying to simple tasks.

## Run model

Single-turn probe (per FEATURE_104 §single-step convention). Two variants
under test:

- **`light`** — current v0.7.34 design baseline: 1-line "≥2 distinct execution
  steps → populate executionObligations" hint.
- **`heavy`** — strengthened: explicit "list plan BEFORE calling
  emit_scout_verdict" framing + positive examples (cross-module edits, refactor
  + verification, independent changes) + negative examples (preparation reads,
  reasoning, single typos) + explicit todo_update timing.

Common pinned base: FEATURE_112 anchor SCOPE COMMITMENT block (winner of
`feature_112_anchor` A/B, shipped in v0.7.34). The two variants differ ONLY
in the mini-planner addendum + share IDENTICAL output format spec.

## Tasks

4 cases spanning the H0 complexity spectrum. ALL expect `H0_DIRECT` (this is
also a regression guard against FEATURE_112 over-triggering H1 escalation).

| Case ID | Complexity | Expected obligation count | Role |
|---|---|---|---|
| `h0-simple-typo` | simple-typo | 0–1 | Over-formalization red line |
| `h0-borderline-2step` | borderline-2step | 2–3 | Edge case (replace + verify) |
| `h0-multistep-rename` | multistep-rename | 3–6 | Mini-planner sweet spot |
| `h0-complex-flag` | complex-flag | 4–7 | Multi-touchpoint independent steps |

## Output format

Models emit:

```
HARNESS: H0_DIRECT

OBLIGATIONS:
- <step description>
- <step description>
...

RATIONALE: <one-line>
```

The `OBLIGATIONS` section is OPTIONAL — for tasks that don't warrant a
multi-step plan, models may omit it or list 0–1 entries. Only the `HARNESS`
line and `OBLIGATIONS` block are parsed.

## Judges

Per task, 4 judges:

1. **`harness-format`** (format) — must have `HARNESS:` line.
2. **`harness-correct(H0_DIRECT)`** (correctness) — must be H0; H1 escalation
   = fail (regression guard).
3. **`obligation-count(min..max)`** (correctness) — parsed obligation count
   must fall within the case's expected range.
4. **`obligation-coherence(no-filler)`** (style) — no obligation may start with
   filler/preparation/reasoning words (read / examine / understand / think /
   consider / analyze / investigate / explore). Skipped when 0 obligations.

## Decision matrix (release gate)

8 alias × 4 case × 2 variant = **64 cells**, 1 run/cell pilot (per
FEATURE_106/112 convention).

| `simple_overformalization_rate` | `multistep_completeness` | Ship decision |
|---|---|---|
| Heavy ≤ Light + 5pp | Heavy ≥ Light + 15pp | **Heavy** |
| Heavy > Light + 5pp | Any | Iterate Heavy 1 round; if still over → **Light** |
| Heavy ≈ Light (±5pp on multistep) | Heavy ≈ Light (±5pp) | **Light** (shorter prompt) |
| Heavy worse on simple AND no multistep gain | Heavy ≤ Light | **Light** |

`simple_overformalization_rate` = (H0-simple + H0-borderline cells whose
obligation count exceeds expected upper bound) / total such cells.

`multistep_completeness` = (H0-multistep + H0-complex cells whose obligation
count is within expected range) / total such cells.

## Run

```bash
npm run test:eval -- feature-097-h0-mini-planner-strength
```

Skips per-alias when API key absent (FEATURE_104 standard pattern).

## See also

- `tests/feature-097-h0-mini-planner-strength.eval.ts` — entry point
- `docs/features/v0.7.34.md#h0-mini-planner-强度-ab-eval` — design + criteria
- `benchmark/datasets/read-scope-routing/` — sibling FEATURE_112 dataset
- `benchmark/harness/aliases.ts` — 8 alias coding-plan provider table
