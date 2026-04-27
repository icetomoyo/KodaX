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
  judges.ts     — reusable judges: mustContainAll, mustNotMatch, lengthWithin, ...
  harness.ts    — runOneShot / runABComparison / formatComparisonTable
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

## Pattern 2 — A/B variant comparison

For "does prompt v2 beat v1?":

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
