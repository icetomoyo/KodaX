# Admission systemPrompt Double-Wrap Baseline

> FEATURE_101 v0.7.31.1 — design open question Q6 closure (real-LLM lane).

## Product question

When the admission contract wraps an admitted constructed agent's
`instructions` field in a trusted/untrusted fence (added by FEATURE_101
v0.7.31.1 patch), does the wrapping **degrade the LLM's ability to
follow the role spec** compared to the un-wrapped trusted form?

The wrap chrome adds ~600 characters of trusted framing (header +
`<<< BEGIN UNTRUSTED MANIFEST INSTRUCTIONS >>>` fence + footer) before
the model ever sees the role spec. If the wrap distracts the model, or
if the "treat as DATA" framing dampens the role spec's effect, then
admitted agents would produce worse output than identical trusted
agents — that's the degradation we have to detect or rule out.

## Variants under test

| Variant id | What it is |
|---|---|
| `unwrapped` | The raw role spec sent as the entire system prompt (the trusted-agent path: `Runner.run` on a hand-authored Agent). |
| `wrapped`   | The same role spec passed through `buildSystemPrompt` (the admitted-agent path): TRUSTED_HEADER + BEGIN/END fence + role spec + TRUSTED_FOOTER. |

Both variants drop into `runOneShot` against the same user message
under each model alias. The wrap text is verbatim from
`packages/core/src/runner.ts:TRUSTED_HEADER` / `TRUSTED_FOOTER` — when
those constants change, this dataset re-imports the new version
automatically.

## Tasks

Five canonical role-spec scenarios. Each has a tightly-defined output
shape so judges can score deterministically without LLM-as-judge
overhead:

| Task id | Role spec | Judge gate |
|---|---|---|
| `echo` | "Repeat back every user message prefixed with `echo: `." | Output must start with `echo:` followed by the user's message. |
| `prefix-bullet` | "For each line of input, output the same line prefixed with `* `." | Every output line begins with `* `. |
| `count-words` | "Count the number of words in the user's message and reply with `WORD_COUNT: <n>`." | Output contains `WORD_COUNT: <correct n>`. |
| `uppercase` | "Convert the user's message to UPPERCASE and emit it. Do not add commentary." | Output is the upper-cased input verbatim. |
| `json-extract` | "Output a JSON object `{ \"subject\": <string>, \"sentiment\": <\"positive\"\|\"negative\"\|\"neutral\"> }` describing the user's message." | Output parses as JSON with the two required keys + sentiment in the enum. |

Why these tasks: each is **objective** (no taste / quality dimension),
so judges are deterministic. They cover the four practical role-spec
shapes a constructed agent typically embodies (transform / format /
analyze / classify). If wrap degradation exists, it surfaces as the
model deviating from the format the role spec specifies — a regression
the judges catch.

## Pass criterion

For each `(task × alias)` cell, both variants are independently
judged. The patch declares **non-degradation** if, across all alias
× task cells, the `wrapped` variant's pass rate is no worse than
`unwrapped` minus a small noise tolerance (2 percentage points,
following FEATURE_104 baseline-comparison convention).

If wrapped < unwrapped - 2pp on any cell, we have evidence the
double-wrap meaningfully harms performance and the wrap design needs
revisiting (option: simplify to fence-only, drop trusted footer, etc.).

## Run

```bash
# Full run across all aliases that have API keys configured.
npm run test:eval -- admission-wrap

# Single alias (e.g. just DeepSeek):
DEEPSEEK_API_KEY=... npx vitest run -c vitest.eval.config.ts tests/admission-wrap.eval.ts
```

Results land in `benchmark/results/<timestamp>--admission-wrap/`
(REPORT.md + results.json + per-cell traces). Compare
`wrappedPassRate` vs `unwrappedPassRate` per task to gate the
non-degradation claim.

## Cost

5 tasks × 2 variants × N aliases × 1 run = 10×N provider calls. With
3 aliases configured, that's 30 small calls (~5-10s each) ≈ 3-5 min
wall clock. The dataset is intentionally small so non-degradation can
be confirmed cheaply on every wrap-text change.
