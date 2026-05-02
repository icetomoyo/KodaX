# Auto-Mode Classifier Pilot — v0.7.33 Stage 1 Baseline

**Date**: 2026-05-02 06:54Z (UTC)
**Eval commit**: `7247439` (`feat(bench,docs,v0.7.33): FEATURE_092 phase 2b.10 — synthetic pilot eval`)
**Run command**: `KODAX_EVAL_AUTO_MODE_PILOT=1 npm run test:eval -- auto-mode-classifier`
**Wall clock**: 2778 s (~46 min) — 8 aliases × 70 cells = 560 sideQuery calls
**Why version-tracked**: this is the v0.7.33 release-gate baseline. Subsequent
prompt iteration (v0.7.34+) compares against this snapshot. See
`docs/features/v0.7.33.md §"Measured Overhead"` for the design-doc-anchored
analysis.

## Files

- `per-alias-summary.txt` — verbatim `[pilot]` summary lines from each `it()`
  block, ANSI-stripped. The same shape the eval prints to stdout.

## Methodology recap (single-step quantitative probe — see EVAL_GUIDELINES.md)

Each cell is one independent `sideQuery` invocation:

```
buildClassifierPrompt(rules=∅, transcript=fixture, action=case.action)
  ↓
sideQuery(provider, model, system, messages, timeoutMs=30s, querySource='auto_mode_pilot')
  ↓ stopReason ∈ {end_turn, max_tokens}
parseClassifierOutput(result.text)
  ↓
{ verdict, inputTokens, outputTokens, totalTokens, latencyMs }
```

No tool, no loop, no agent, no LLM-as-judge. Verdict comes from the model's
own `<block>yes|no</block>` tag (deterministic parse).

## Results summary

| alias | TP | FP | tokens/call | p50 | p90 | p99 | status |
|---|---|---|---|---|---|---|---|
| zhipu/glm51 | 78.6% | 7.1% | 2119 | 2.7s | **4.8s ✓** | 6.6s | clean |
| kimi | 81.1% | 6.3% | 2178 | 1.4s | **1.9s ✓** | 21.9s¹ | clean (1 transient err) |
| ark/glm51 | 78.9% | 0.0% | 2170 | 4.9s | 9.0s ✗ | 16.1s | clean |
| mmx/m27 | 84.3% | 10.5% | 2425 | 7.7s | 11.2s ✗ | 17.0s | clean (slowest) |
| ds/v4pro | 84.3% | 0.0% | 2368 | 5.5s | 9.0s ✗ | 11.5s | clean (2 unparseable) |
| ds/v4flash | 78.9% | 0.0% | 2376 | 2.8s | **4.5s ✓** | 5.7s | clean |
| mimo/v25 | n/a | n/a | n/a | n/a | n/a | n/a | rate-limited (69/70 err) |
| mimo/v25pro | n/a | n/a | n/a | n/a | n/a | n/a | rate-limited (70/70 err) |

¹ One outlier transient (single `error=1`) skews p99; ~95% of cells came in well under 2s.

### Latency P90 ≤ 5s gate

- **PASS**: kimi (1.9s), ds/v4flash (4.5s), zhipu/glm51 (4.8s)
- **FAIL**: ark/glm51 (9.0s), ds/v4pro (9.0s), mmx/m27 (11.2s)
- **N/A**: mimo/{v25,v25pro} — rate-limited, retest with throttling

Recommended default classifier model when explicitly set:
**`kimi:kimi-for-coding`** or **`deepseek:deepseek-v4-flash`**.

### Token cost overview (clean aliases only)

Average across 14 cases × N=6 alias for each transcript fixture size:

| Fixture | Avg tokens/call | % of huge |
|---|---|---|
| empty (~50 input tok) | ~470 | 6% |
| short (~400) | ~615 | 8% |
| medium (~1500) | ~940 | 12% |
| long (~4000) | ~1570 | 20% |
| huge (~7500, near 8KB cap) | ~7770 | 100% |

## Replay

```bash
git checkout 7247439
KODAX_EVAL_AUTO_MODE_PILOT=1 npm run test:eval -- auto-mode-classifier
```

The 14-case dataset (`benchmark/datasets/auto-mode-classifier/cases.ts`)
and 5 transcript fixtures (`benchmark/datasets/auto-mode-classifier/transcripts.ts`)
are deterministic; same inputs → near-identical token numbers (small variance
from per-provider tokenizer quirks). Latency varies with provider load — rerun
on a different day to spot persistent regressions vs. transient slowdowns.
