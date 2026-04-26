/**
 * Reasoning plan execution-state builder — CAP-052
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-052-reasoning-plan-creation-entry
 *
 * Class 1 (substrate middleware). Builds the per-turn execution state
 * from the resolved `ReasoningPlan` — runs at the very top of every
 * turn (initial entry + every reroute apply), composing four cross-
 * cutting inputs into a single coherent envelope used by the rest of
 * the loop:
 *
 *   1. **Repo-intelligence context (CAP-001)** —
 *      `buildAutoRepoIntelligenceContext` resolves repo overview /
 *      decision matrix / preturn bundle when auto-repo mode is on;
 *      fed into `effectiveOptions.context.repoIntelligenceContext`.
 *
 *   2. **Reasoning mode** — `reasoningPlan.mode` is propagated onto
 *      `effectiveOptions.reasoningMode` so downstream readers
 *      (provider hook chain, system-prompt builder) see a single
 *      source of truth.
 *
 *   3. **Provider policy hints** — `buildProviderPolicyHintsForDecision`
 *      derives lossy-bridge / mcp-only / etc. hints from the plan's
 *      `decision` and merges them on top of any user-supplied
 *      `context.providerPolicyHints`.
 *
 *   4. **Prompt overlay** — concatenates the user-supplied
 *      `context.promptOverlay` with `reasoningPlan.promptOverlay`
 *      (joined with double newline) so the system-prompt builder
 *      sees both.
 *
 * Then derives `systemPrompt` (honoring `systemPromptOverride` if
 * provided) and a `providerReasoning` envelope that captures
 * enabled/mode/depth/taskType/executionMode for the provider stream
 * call.
 *
 * The merge order is load-bearing — `effectiveOptions` spreads
 * `options` first, then sets `reasoningMode` to the plan's value
 * (overriding any stale `options.reasoningMode`), then merges
 * `context` field-by-field. Don't reorder.
 *
 * **Wire-up note**: this function is passed as the `buildExecutionState`
 * callback to CAP-019's `maybeAdvanceAutoReroute` to avoid a cycle —
 * CAP-019 lives in `middleware/auto-reroute.ts`; if CAP-052 imported
 * from there directly the cycle would close. The DI callback pattern
 * in CAP-019 was chosen specifically for this case; it stays even
 * after CAP-052 has its own module.
 *
 * Migration history: extracted from `agent.ts:3066-3120` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P2 (CAP-052 batch).
 */

import type {
  KodaXExecutionMode,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXTaskType,
  KodaXThinkingDepth,
} from '../types.js';
import type { ReasoningPlan } from '../reasoning.js';
import { buildProviderPolicyHintsForDecision } from '../reasoning.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { buildAutoRepoIntelligenceContext } from './middleware/repo-intelligence.js';

export interface ReasoningExecutionState {
  effectiveOptions: KodaXOptions;
  systemPrompt: string;
  providerReasoning: {
    enabled: boolean;
    mode: KodaXReasoningMode;
    depth: KodaXThinkingDepth;
    taskType: KodaXTaskType;
    executionMode: KodaXExecutionMode;
  };
}

export async function buildReasoningExecutionState(
  options: KodaXOptions,
  reasoningPlan: ReasoningPlan,
  isNewSession: boolean,
): Promise<ReasoningExecutionState> {
  const repoIntelligenceContext = await buildAutoRepoIntelligenceContext(
    options,
    reasoningPlan,
    isNewSession,
    options.events,
  );

  const effectiveOptions: KodaXOptions = {
    ...options,
    reasoningMode: reasoningPlan.mode,
    context: {
      ...options.context,
      executionCwd: resolveExecutionCwd(options.context),
      repoIntelligenceContext,
      providerPolicyHints: {
        ...options.context?.providerPolicyHints,
        ...buildProviderPolicyHintsForDecision(reasoningPlan.decision),
      },
      promptOverlay: [
        options.context?.promptOverlay,
        reasoningPlan.promptOverlay,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  };

  return {
    effectiveOptions,
    systemPrompt: options.context?.systemPromptOverride
      ?? await buildSystemPrompt(effectiveOptions, isNewSession),
    providerReasoning: {
      enabled: reasoningPlan.depth !== 'off',
      mode: reasoningPlan.mode,
      depth: reasoningPlan.depth,
      taskType: reasoningPlan.decision.primaryTask,
      executionMode: reasoningPlan.decision.recommendedMode,
    },
  };
}
