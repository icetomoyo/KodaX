# Benchmark Datasets

> Version-tracked. Datasets define the input cases an eval runs against.

## What goes here

A **dataset** is a versioned collection of (system prompt, user prompt,
judges) triples that constitute one prompt-evaluation scenario. Datasets
are committed to git so future runs reproduce against the same inputs.

Naming convention: one folder per dataset, with `case.ts` (or
`cases/*.ts`) defining the typed inputs.

```
benchmark/datasets/
  <dataset-id>/
    README.md             What this dataset measures + when to run it
    case.ts               (or cases/<n>.ts) — typed PromptVariant + judges
    fixtures/             (optional) input artefacts: large code snippets,
                          file contents the prompt references, etc.
```

A dataset folder is a self-contained scenario:

- The README explains the **product question** the dataset answers (e.g.
  "does the Scout role-prompt correctly classify H1 vs H2 across
  coding-plan providers?"), what triggers a re-run, and the last-run
  conclusion if you've already taken one.
- The TypeScript files export a typed array of `PromptVariant[]` (from
  `benchmark/harness/harness.ts`) plus the corresponding `PromptJudge[]`.
- `*.eval.ts` files under `tests/` import the dataset and call
  `runBenchmark` (see `benchmark/README.md` Pattern 3).

## What does NOT go here

- **Run results** → those go in `benchmark/results/` (gitignored).
- **Harness code** → that's `benchmark/harness/`.
- **Real LLM call tests that don't read from a dataset** → they can keep
  living as standalone `tests/*.eval.ts` files (the existing 7 from
  v0.7.27 era stay there until they're naturally migrated).

## Adding a new dataset

1. Create `benchmark/datasets/<your-id>/`
2. Add a `README.md` answering: what product question? what triggers
   re-runs? expected baseline behavior?
3. Define `PromptVariant[]` and `PromptJudge[]` in TypeScript
4. Reference the dataset from a `tests/<your-id>.eval.ts` that calls
   `runBenchmark`
5. Run once, write conclusion in the dataset README

This directory is intentionally empty at landing — datasets land
opportunistically as prompt changes need them, not preemptively.
