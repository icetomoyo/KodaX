# Prompt Eval Module

> FEATURE_104 (v0.7.29). Reusable harness for testing prompt changes against
> real LLM providers.

## When to use this

**Any change that touches LLM-facing prompt content** — system prompts,
role prompts (Scout/Generator/Planner/Evaluator), tool descriptions, or
any string that ships in `messages[]` to the provider — must be backed by
a prompt eval. Pure depth/parameter changes (FEATURE_078 reasoning ceiling,
FEATURE_103 L5 escalation) **do not** need an eval — they don't change the
text the model sees.

Triggers:

- Editing `packages/coding/src/agent-runtime/system-prompt-*.ts`
- Editing `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`
- Editing tool `description` fields in `packages/coding/src/tools/`
- Editing `coding-preset.ts:DEFAULT_CODING_INSTRUCTIONS`
- Adjusting protocol-emitter prompts in `packages/coding/src/agents/`

When in doubt: if your diff includes a string literal that ends up in the
provider request body, you need an eval.

## How to run

```bash
# Full eval suite (all *.eval.ts files in tests/)
npm run test:eval

# One eval file
npx vitest run -c vitest.eval.config.ts tests/your-case.eval.ts
```

Tests skip gracefully when their required `*_API_KEY` env var is absent.
A typical local run uses 1-3 of the 8 supported coding-plan providers.

## Module layout

```
benchmark/                    Top-level folder for everything benchmark-related.
  README.md                   This file. Convention guide + KodaX-vs-LiveCanvas rationale.
  harness/                    Code modules. Version-tracked.
    aliases.ts                Short alias map: 'zhipu/glm51' → { provider, model, apiKeyEnv }
    judges.ts                 Reusable judges with categories: format / correctness / style / safety / custom
                              Factories: mustContainAll/Any, mustNotContain, mustMatch/NotMatch,
                              lengthWithin, parseAndAssert, runJudges (decomposed aggregation)
    harness.ts                runOneShot           (single probe + duration)
                              runABComparison      (lightweight pass/fail matrix; v1)
                              runBenchmark         (v2: multi-run + variance + decomposed quality)
                                                   (latency tracked but NOT scored — KodaX is a
                                                    coding agent, quality is the only ranking metric)
    report.ts                 renderBenchmarkReport (9-section markdown)
                              renderCompactSummary  (one-line per cell)
    persist.ts                writeBenchmarkReport  (results.json + REPORT.md + codes/)
                              readBenchmarkResult   (round-trip for baseline diffs)
    self-test.test.ts         Zero-LLM unit tests; runs in default `npm test`
  datasets/                   Test cases + golden inputs. Version-tracked.
    README.md                 How to author a dataset
    <dataset-id>/             Self-contained scenario folder (added opportunistically)
  results/                    Run output. **NOT version-tracked** (.gitignore).
                              Persisted runs land here as benchmark/results/<ISO-timestamp>/
```

Eval test files (`tests/*.eval.ts`) live in the standard `tests/` directory
and import from `../benchmark/harness/*` for shared helpers.

## Provider/model alias scheme

| Alias | Provider | Model | API key env |
|---|---|---|---|
| `zhipu/glm51` | `zhipu-coding` | `glm-5.1` | `ZHIPU_API_KEY` |
| `kimi` | `kimi-code` | `kimi-for-coding` | `KIMI_API_KEY` |
| `mimo/v25` | `mimo-coding` | `mimo-v2.5` | `MIMO_API_KEY` |
| `mimo/v25pro` | `mimo-coding` | `mimo-v2.5-pro` | `MIMO_API_KEY` |
| `mmx/m27` | `minimax-coding` | `MiniMax-M2.7` | `MINIMAX_API_KEY` |
| `ark/glm51` | `ark-coding` | `glm-5.1` | `ARK_API_KEY` |
| `ds/v4pro` | `deepseek` | `deepseek-v4-pro` | `DEEPSEEK_API_KEY` |
| `ds/v4flash` | `deepseek` | `deepseek-v4-flash` | `DEEPSEEK_API_KEY` |

These are the **coding-plan** providers KodaX targets. Anthropic / OpenAI /
Google are intentionally not aliased here — they self-identify correctly
without coaching, and most prompt-quality issues we've debugged historically
(Issue 124 dispatch regressions, distillation persona bleed) reproduce on
the coding-plan side.

To add a new alias, extend `MODEL_ALIASES` in `aliases.ts`.

## Pattern 1 — One-shot probe

For cases where the eval owns its scoring logic:

```ts
import { describe, it, expect } from 'vitest';
import { availableAliases } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const TARGETS = availableAliases('zhipu/glm51', 'ds/v4flash');

describe.skipIf(TARGETS.length === 0)('my prompt eval', () => {
  for (const alias of TARGETS) {
    it(`${alias}: produces a structured verdict`, async () => {
      const out = await runOneShot(alias, {
        systemPrompt: '… your system prompt under test …',
        userMessage: '… task input …',
      });
      expect(out.text.length).toBeGreaterThan(0);
      // … your assertions …
    });
  }
});
```

## Pattern 2 — A/B variant comparison (lightweight)

For a quick "does prompt v2 beat v1?" check (single run, flat pass/fail):

```ts
import { describe, it, expect } from 'vitest';
import { availableAliases } from '../benchmark/harness/aliases.js';
import { runABComparison, formatComparisonTable } from '../benchmark/harness/harness.js';
import { mustContainAll, mustNotMatch } from '../benchmark/harness/judges.js';

const TARGETS = availableAliases('zhipu/glm51', 'mmx/m27', 'ds/v4flash');

describe.skipIf(TARGETS.length === 0)('refactor instruction prompt — v1 vs v2', () => {
  it('v2 passes on more models than v1', async () => {
    const result = await runABComparison({
      models: TARGETS,
      variants: [
        { id: 'v1', systemPrompt: V1_PROMPT,        userMessage: TASK },
        { id: 'v2', systemPrompt: V2_REWRITTEN,     userMessage: TASK },
      ],
      judges: [
        mustContainAll('refactor', 'preserve behavior'),
        mustNotMatch(/I'?m Claude/i, 'no-distillation-bleed'),
      ],
    });

    console.log(formatComparisonTable(result));
    expect(result.variantsPassingEveryModel).toContain('v2');
    // Or: assert v2 wins on at least N models …
  });
});
```

## Pattern 3 — Quantitative benchmark (decision-grade)

For "is v2 STATISTICALLY better than v1, and where exactly?". Uses
multi-run (n=3 default), per-category quality scoring, and full
markdown REPORT.md output.

> **KodaX-specific design choice**: ranking is **quality-only**.
> Latency is recorded for diagnostics (REPORT.md §5) but does NOT feed
> into rank or dominance. KodaX is a coding agent — a slow correct
> answer beats a fast wrong one. Multi-dimensional scoring that combines
> quality and latency makes sense for interactive UI gen, not here.

```ts
import { describe, it, expect } from 'vitest';
import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import { writeBenchmarkReport } from '../benchmark/harness/persist.js';
import {
  mustContainAll,
  mustMatch,
  mustNotMatch,
  type PromptJudge,
} from '../benchmark/harness/judges.js';

const TARGETS = availableAliases('zhipu/glm51', 'mmx/m27', 'ds/v4flash');

describe.skipIf(TARGETS.length === 0)('refactor prompt v1 vs v2 — benchmark', () => {
  it('v2 is dominant on every model and improves correctness', async () => {
    const judges: PromptJudge[] = [
      // format = does the output parse / shape OK
      { name: 'has-code-fence', category: 'format',
        judge: (out) => ({ passed: /```[\s\S]+```/.test(out) }) },
      // correctness = does it actually do what was asked
      { ...mustContainAll('preserve behavior'), category: 'correctness' },
      { ...mustMatch(/export\s+(default\s+)?function|class /, 'top-level-export'),
        category: 'correctness' },
      // safety = no distillation bleed
      { ...mustNotMatch(/I'?m Claude/i, 'no-claude'), category: 'safety' },
    ];

    const result = await runBenchmark({
      models: TARGETS,
      variants: [
        { id: 'v1', systemPrompt: V1_PROMPT, userMessage: TASK },
        { id: 'v2', systemPrompt: V2_REWRITTEN, userMessage: TASK },
      ],
      judges,
      runs: 3,
    });

    // Persist for diffing later. Snapshot directory under
    // benchmark/results/<timestamp>/. Commit-or-not is
    // your call (gitignored by default).
    const persisted = await writeBenchmarkReport(result);
    console.log(`REPORT: ${persisted.reportMdPath}`);

    // Decision-grade assertion: v2 must be strictly ≥ v1 across the board.
    expect(result.variantsDominantOnEveryModel).toContain('v2');

    // Or look at specific categories: e.g., correctness must improve.
    for (const alias of TARGETS) {
      const v1 = result.cells.find((c) => c.variantId === 'v1' && c.alias === alias)!;
      const v2 = result.cells.find((c) => c.variantId === 'v2' && c.alias === alias)!;
      const v1Correctness = v1.qualityByCategory.correctness ?? 0;
      const v2Correctness = v2.qualityByCategory.correctness ?? 0;
      // Allow ±10pp noise at n=3; require improvement that exceeds noise.
      expect(v2Correctness).toBeGreaterThanOrEqual(v1Correctness - 10);
    }
  });
});
```

The persisted REPORT.md has 9 sections (run summary, methodology, score
matrix, sub-dimensions, time analysis, variance, ranking, **assertion
failure patterns sorted by frequency**, reproduction). §8 is the gold:
the top-of-list failure pattern is the prompt-improvement opportunity.

## The iteration workflow (drilled-down)

Once you have a benchmark with a baseline:

1. **Run the baseline**: `npm run test:eval -- tests/your-prompt.eval.ts`
2. **Read REPORT.md §8**: pick the top failure pattern. Form a hypothesis:
   "this is a prompt issue, not a model issue, because no provider is
   dramatically better at it" (test: model-issue would show one provider
   at 90% and others at 10%; prompt-issue shows all at 15-30%).
3. **Edit ONE prompt section** that targets that failure. Resist the urge
   to rewrite the whole prompt — the diff is what tells you what helped.
4. **Smoke test**: run 1 case × 2 strong models × 1 run. If the failure
   pattern doesn't move, the prompt change didn't take. Don't waste a
   full bench run.
5. **Full re-run**: same scope as baseline.
6. **Diff REPORT.md A vs B**: §3 (quality matrix) tells you direction; §8
   (failure patterns) tells you what specifically moved.
7. **Watch for regressions**: small assertion regressions on unrelated
   cases are usually noise (±10pp at n=3). Chase only product-relevant ones.

## Statistical caveats baked into the harness

- **n=3 default** — minimum for variance to be meaningful. Single-run
  decisions are vulnerable to lucky outputs.
- **Variance flag** — REPORT.md §6 marks cells with std-dev > 20pp as
  ⚠️ noisy. Bump to n=5+ before treating those as decision-grade.
- **3-point indistinguishability** — two cells within 3 quality points
  are statistically indistinguishable at n≤5. The harness doesn't try
  to "rank" them — that's the eval-file caller's call.
- **Quality-only ranking** — for KodaX (a coding agent), correctness
  is the only thing that matters. Latency is reported (§5) but does
  not affect rank. If you need a composite that scores both, build it
  in your eval file from `cell.quality` + `cell.duration` directly.

## Conventions

- **Eval files end in `.eval.ts`** — picked up by `vitest.eval.config.ts`,
  excluded from default `npm test`. They may make real LLM calls and cost
  money. Never include `.eval.ts` files in CI default runs.
- **Skip when no API key.** Use `availableAliases(...)` + `describe.skipIf`
  / `it.skipIf` so the file passes locally even without coding-plan keys.
- **Pin coding-plan models explicitly.** Catalog refreshes (FEATURE_099)
  rename models; baking the alias makes those refreshes a single-file edit.
- **Keep matrix small.** N variants × M models × J probes = N·M·J calls.
  Each call is cents + seconds. 2-3 variants × 2-3 models × 2-3 probes is
  the sweet spot for most cases.
- **Record the conclusion in a comment block** at the top of the eval file
  with date + model versions, like the existing
  `tests/dispatch-prompt-comparison.eval.ts` does. Future readers need the
  empirical baseline next to the harness.
- **Never assert across all providers.** Some coding-plan providers will
  always lag on certain prompt patterns. Assert "v2 ≥ v1" not "v2 passes
  everywhere".

## Pattern 4 — Agent-level eval (FEATURE_107, v0.7.32)

For cases where the question can't be answered by a single LLM call but
requires running KodaX's full task loop (Scout → Planner → Generator ↔
Evaluator) against historical repo states:

```
benchmark/harness/
  worktree-runner.ts          git-worktree isolation envelope
                              setupWorktree / cleanupWorktree / runInWorktree
                              scanAndCleanOrphanWorktrees
  agent-task-runner.ts        spawn `kodax -p` in worktree with isolated HOME
                              + variant-forcing env vars
  plan-intent-fidelity.ts     LLM-as-judge: deliverable vs Planner intent
  h2-boundary-runner.ts       (P2.0f) orchestrator: cases × aliases × variants
benchmark/datasets/h2-plan-execute-boundary/
  cases.ts                    14 grounded H2-class cases (P1.5b locked)
  candidate-inventory.md      Methodology + verification trail
```

**Variant-forcing env-var contract** (consumed by KodaX source-side, P2.1):

| Env var | Values | Effect |
|---|---|---|
| `KODAX_FORCE_MAX_HARNESS` | `H1` / `H2` / unset | Override Scout verdict; eval-only path |
| `KODAX_PLANNER_INPUTFILTER` | `strip-reasoning` / unset | Activate plannerHandoffs `inputFilter` to strip Planner reasoning, leaving only plan artifact (v0.7.16 design intent, B-path) |

Both are eval-only (read once each in source); never set in production.
Removed at FEATURE_107 P6 cleanup unless 档 1 (B wins) triggers, in which
case B-path becomes default and env-var is removed in favor of unconditional
`inputFilter`.

**Re-framed 2026-04-30**: original `KODAX_PLANNER_GENERATOR_MERGED` env was
based on the (incorrect) assumption that current code is `new-session`. P2.1
design pass found current code is already `same-session` (no `inputFilter`
on any handoff), so B-path is "add `inputFilter`" not "switch to same-session".

**Why not extend `harness.ts`**: prompt-eval (`runOneShot`/`runBenchmark`)
is single-call + zero-filesystem. Agent-level eval requires worktree
isolation + multi-round task loop + transcript parsing — a different shape.
Two harnesses, same `aliases.ts`/`persist.ts` infrastructure.

## What's not in this module

- **LLM-as-judge** (general). Some quality dimensions (style, naturalness)
  aren't expressible as deterministic judges. Cases that need an LLM judge
  keep that logic inline; first instance is plan-intent-fidelity.ts —
  generalize after 3+ real cases (CLAUDE.md).
- **Cost tracking / token counting**. Out of scope — eval cases run on
  manual local pulses, not a CI budget. If we ever automate, this is
  where it'd plug in.
- **Anthropic / OpenAI / Google aliases**. Keep these out by default —
  they over-fit eval results since they self-identify and follow
  instructions reliably. Add only when an eval specifically targets
  cross-vendor behavior.
