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
tests/prompt-eval/
  aliases.ts    — short alias map: 'zhipu/glm51' → { provider, model, apiKeyEnv }
  judges.ts     — reusable judges with categories: format / correctness / style / safety / custom
                  factories: mustContainAll/Any, mustNotContain, mustMatch/NotMatch,
                  lengthWithin, parseAndAssert, runJudges (decomposed aggregation)
  harness.ts    — runOneShot           (single probe + duration)
                  runABComparison      (lightweight pass/fail matrix; v1)
                  runBenchmark         (v2: multi-run + variance + speed + decomposed quality + composite)
                  speedScore           (tolerance-window scoring helper)
  report.ts     — renderBenchmarkReport (9-section markdown)
                  renderCompactSummary  (one-line per cell)
  persist.ts    — writeBenchmarkReport  (results.json + REPORT.md + codes/)
                  readBenchmarkResult   (round-trip for baseline diffs)
  __results__/  — git-ignored output directory; persist target
```

Eval cases themselves live at `tests/<topic>.eval.ts` (existing convention,
not changed). They import from `tests/prompt-eval/*` for shared helpers.

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
import { availableAliases } from './prompt-eval/aliases.js';
import { runOneShot } from './prompt-eval/harness.js';

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
import { availableAliases } from './prompt-eval/aliases.js';
import { runABComparison, formatComparisonTable } from './prompt-eval/harness.js';
import { mustContainAll, mustNotMatch } from './prompt-eval/judges.js';

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
multi-run (n=3 default), per-category scoring, speed tolerance window,
composite ranking, and full markdown REPORT.md output.

```ts
import { describe, it, expect } from 'vitest';
import { availableAliases } from './prompt-eval/aliases.js';
import { runBenchmark } from './prompt-eval/harness.js';
import { writeBenchmarkReport } from './prompt-eval/persist.js';
import {
  mustContainAll,
  mustMatch,
  mustNotMatch,
  type PromptJudge,
} from './prompt-eval/judges.js';

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
    // tests/prompt-eval/__results__/<timestamp>/. Commit-or-not is
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
6. **Diff REPORT.md A vs B**: §3 (composite) tells you direction; §8
   (failure patterns) tells you what specifically moved.
7. **Watch for regressions**: small assertion regressions on unrelated
   cases are usually noise (±10pp at n=3). Chase only product-relevant ones.

## Statistical caveats baked into the harness

- **n=3 default** — minimum for variance to be meaningful. Single-run
  decisions are vulnerable to lucky outputs.
- **Variance flag** — REPORT.md §6 marks cells with std-dev > 20pp as
  ⚠️ noisy. Bump to n=5+ before treating those as decision-grade.
- **3-point indistinguishability** — two cells within 3 composite points
  are statistically indistinguishable at n≤5. The harness doesn't try
  to "rank" them — that's the eval-file caller's call.
- **Speed window** — 100 at ≤30s, 0 at ≥240s, linear between. NOT
  linear-from-0 (which would penalize fast models for being fast). Tune
  the window per workload via `runs.speedIdealMs` / `speedCeilingMs`.
- **Composite weights** — default 0.85 quality / 0.15 speed favors
  correctness. Style and speed are necessary but never sufficient.

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

## What's not in this module

- **LLM-as-judge**. Some quality dimensions (style, naturalness) aren't
  expressible as deterministic judges. Cases that need an LLM judge keep
  that logic inline; we'll generalize after 3+ real cases (CLAUDE.md).
- **Cost tracking / token counting**. Out of scope — eval cases run on
  manual local pulses, not a CI budget. If we ever automate, this is
  where it'd plug in.
- **Anthropic / OpenAI / Google aliases**. Keep these out by default —
  they over-fit eval results since they self-identify and follow
  instructions reliably. Add only when an eval specifically targets
  cross-vendor behavior.
