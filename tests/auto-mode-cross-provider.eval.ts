/**
 * Eval: Auto-Mode Cross-Provider Classifier — FEATURE_092 §7 release-gate (v0.7.33).
 *
 * ## Purpose
 *
 *   The auto-mode classifier supports a 4-layer override chain
 *   (`packages/coding/src/guardrails/auto-mode/model-resolver.ts`) so the user
 *   can run the classifier on a different provider than the main agent —
 *   e.g. "fast Kimi classifier in front of a slower Claude/GLM agent" or "free
 *   DeepSeek classifier in front of a paid agent". This eval verifies the
 *   cross-provider plumbing actually works end-to-end through one classifier
 *   hop:
 *
 *     - The classifier runs against the OVERRIDE (provider, model)
 *     - The cost tracker records that call under the OVERRIDE provider
 *     - The cost tracker records that call under role='auto_mode'
 *     - The guardrail returns a sane verdict (allow|block|escalate)
 *
 *   This is the §7 release-gate item from `docs/features/v0.7.33.md` —
 *   automation form of "manually verify that K provider in front of D
 *   provider's agent reports both providers in the cost summary".
 *
 * ## What it does NOT measure
 *
 *   - Verdict accuracy (covered by `auto-mode-classifier.eval.ts` sanity mode)
 *   - Latency / token cost (covered by the pilot mode of the same eval)
 *   - Full agent loop behavior with a downgraded engine (FEATURE_092 §5,
 *     deferred to use-it-and-fix per the v0.7.33 timeline)
 *
 *   The eval is intentionally minimal — direct guardrail invocation per combo,
 *   one tool call per combo, single sideQuery per combo. Three combos × ~3s
 *   each ≈ <15s of LLM spend per run.
 *
 * ## Why a direct guardrail call (not full `runKodaX`)
 *
 *   `runKodaX` creates its own internal cost tracker and exposes it only via
 *   `events.getCostReport` (formatted string). Inverting that to assert
 *   "byProvider has both names" would require parsing formatted output and
 *   replicating the agent's full bash-tool round-trip — weeks of integration
 *   surface for one cross-provider claim. Calling `beforeTool` directly with
 *   a `getCostTracker` callback we own is the single-hop equivalent: the
 *   classifier is the only LLM call on the path, so a tracker entry under the
 *   override provider proves cross-provider routing works.
 *
 * ## Combos
 *
 *   The matrix uses three providers known to pass the v0.7.33 latency gate
 *   (kimi, ds/v4flash, zhipu/glm51 — see Stage 1 pilot
 *   `benchmark/results/2026-05-02T06-54-27Z-auto-mode-classifier-pilot/`):
 *
 *     [agent]        → [classifier]
 *     ds/v4flash     → kimi
 *     kimi           → zhipu/glm51
 *     zhipu/glm51    → ds/v4flash
 *
 *   Combos skip individually if either alias's API key is missing
 *   (`MODEL_ALIASES[alias].apiKeyEnv`).
 *
 * ## Run
 *
 *   # Default — visible skip:
 *   npm run test:eval -- auto-mode-cross-provider
 *
 *   # Live (release-gate):
 *   KODAX_EVAL_AUTO_MODE_CROSS_PROVIDER=1 npm run test:eval -- auto-mode-cross-provider
 */

import { describe, expect, it } from 'vitest';

import {
  createCostTracker,
  getProvider,
  getSummary,
  type CostTracker,
} from '@kodax/ai';
import {
  createAutoModeToolGuardrail,
  getBuiltinRegisteredToolDefinition,
  getRegisteredToolDefinition,
  type AutoRules,
} from '@kodax/coding';
import type { GuardrailContext, RunnerToolCall } from '@kodax/core';

import {
  MODEL_ALIASES,
  resolveAlias,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';

const GATE_ENV = 'KODAX_EVAL_AUTO_MODE_CROSS_PROVIDER';
const isLiveOptIn = process.env[GATE_ENV] === '1';

const EMPTY_RULES: AutoRules = { allow: [], soft_deny: [], environment: [] };

/**
 * Three cross-provider combos. Order is `[agentAlias, classifierAlias]` —
 * agent alias seeds `defaultProvider`/`defaultModel`; classifier alias is
 * the override forced via `userSettings`.
 */
const COMBOS: ReadonlyArray<readonly [agent: ModelAlias, classifier: ModelAlias]> = [
  ['ds/v4flash',  'kimi'],
  ['kimi',        'zhipu/glm51'],
  ['zhipu/glm51', 'ds/v4flash'],
];

function hasKey(alias: ModelAlias): boolean {
  const env = MODEL_ALIASES[alias].apiKeyEnv;
  const value = process.env[env];
  return typeof value === 'string' && value.length > 0;
}

function buildCtx(): GuardrailContext {
  return {
    agent: { name: 'cross-provider-eval', instructions: '' },
    messages: [
      { role: 'user', content: 'Run `echo hello` and report the output.' },
    ],
  } as unknown as GuardrailContext;
}

const callBash = (command: string): RunnerToolCall => ({
  id: 'cross-provider-bash',
  name: 'bash',
  input: { command },
});

interface ComboReport {
  readonly agent: ModelAlias;
  readonly classifier: ModelAlias;
  readonly verdict: 'allow' | 'block' | 'escalate';
  readonly reason?: string;
  readonly tracker: ReturnType<typeof getSummary>;
  readonly latencyMs: number;
}

function formatReport(r: ComboReport): string {
  const providers = Object.keys(r.tracker.byProvider).sort().join(',');
  const roles = Object.keys(r.tracker.byRole).sort().join(',');
  return (
    `[cross-provider] agent=${r.agent} classifier=${r.classifier} `
    + `verdict=${r.verdict}${r.reason ? ` reason="${r.reason.slice(0, 80)}"` : ''} `
    + `latency=${r.latencyMs}ms tracker.calls=${r.tracker.callCount} `
    + `byProvider=[${providers}] byRole=[${roles}]`
  );
}

async function runCombo(
  agentAlias: ModelAlias,
  classifierAlias: ModelAlias,
): Promise<ComboReport> {
  const agentTarget = resolveAlias(agentAlias);
  const classifierTarget = resolveAlias(classifierAlias);

  const tracker: { current: CostTracker } = { current: createCostTracker() };

  const guardrail = createAutoModeToolGuardrail({
    rules: EMPTY_RULES,
    getToolProjection: (toolName) => {
      const def =
        getRegisteredToolDefinition(toolName)
        ?? getBuiltinRegisteredToolDefinition(toolName);
      return def?.toClassifierInput;
    },
    resolveProvider: (name) => {
      try {
        return getProvider(name);
      } catch {
        return undefined;
      }
    },
    defaultProvider: agentTarget.provider,
    defaultModel: agentTarget.model,
    // userSettings is layer 4 (lowest) of resolveClassifierModel — sufficient
    // here because no other override layer is set in this eval. The string
    // shape `provider:model` is the documented spec format.
    userSettings: `${classifierTarget.provider}:${classifierTarget.model}`,
    // Wire the tracker into the classifier — sideQuery records under
    // role=querySource='auto_mode'. We snapshot via getSummary() after the
    // call returns.
    getCostTracker: () => tracker.current,
    setCostTracker: (next) => { tracker.current = next; },
    timeoutMs: 30_000,
  });

  const t0 = Date.now();
  const verdict = await guardrail.beforeTool!(callBash('echo hello'), buildCtx());
  const latencyMs = Date.now() - t0;

  return {
    agent: agentAlias,
    classifier: classifierAlias,
    verdict: verdict.action,
    reason: verdict.action !== 'allow' ? verdict.reason : undefined,
    tracker: getSummary(tracker.current),
    latencyMs,
  };
}

describe('Eval: auto-mode cross-provider classifier (FEATURE_092 §7)', () => {
  if (!isLiveOptIn) {
    it(`skips: set ${GATE_ENV}=1 to run cross-provider release-gate eval`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  for (const [agentAlias, classifierAlias] of COMBOS) {
    const skipReason =
      !hasKey(agentAlias)      ? `missing ${MODEL_ALIASES[agentAlias].apiKeyEnv}`
      : !hasKey(classifierAlias) ? `missing ${MODEL_ALIASES[classifierAlias].apiKeyEnv}`
      : undefined;

    if (skipReason !== undefined) {
      it.skip(`combo ${agentAlias} → ${classifierAlias} (${skipReason})`, () => {});
      continue;
    }

    it(
      `combo ${agentAlias} → ${classifierAlias}: classifier provider + role recorded in tracker`,
      { timeout: 60_000 },
      async () => {
        const report = await runCombo(agentAlias, classifierAlias);
        // eslint-disable-next-line no-console
        console.log(formatReport(report));

        // Soft signal: the verdict path was reached. allow/block/escalate are
        // all acceptable — accuracy is NOT what this eval measures.
        expect(['allow', 'block', 'escalate']).toContain(report.verdict);

        // Hard gate #1: tracker recorded exactly the classifier call.
        expect(report.tracker.callCount).toBe(1);

        // Hard gate #2: the classifier provider name appears in byProvider.
        const classifierProviderName = MODEL_ALIASES[classifierAlias].provider;
        expect(report.tracker.byProvider).toHaveProperty(classifierProviderName);
        expect(report.tracker.byProvider[classifierProviderName]!.calls).toBe(1);

        // Hard gate #3: role bucket is 'auto_mode'.
        expect(report.tracker.byRole).toHaveProperty('auto_mode');
        expect(report.tracker.byRole['auto_mode']!.calls).toBe(1);

        // Cross-provider sanity: agent provider should NOT appear (we never
        // ran the agent). If the override layer leaked, this would catch it.
        const agentProviderName = MODEL_ALIASES[agentAlias].provider;
        if (agentProviderName !== classifierProviderName) {
          expect(report.tracker.byProvider).not.toHaveProperty(agentProviderName);
        }
      },
    );
  }
});
