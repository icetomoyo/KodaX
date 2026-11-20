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
 * Then derives `systemPrompt` from `systemPromptOverride` or the Agent
 * profile instructions (a leaf always has one) and a `providerReasoning` envelope that captures
 * enabled/mode/depth/taskType/executionMode for the provider stream
 * call.
 *
 * The merge order is load-bearing — `effectiveOptions` spreads
 * `options` first, then sets `reasoningMode` to the plan's value
 * (overriding any stale `options.reasoningMode`), then merges
 * `context` field-by-field. Don't reorder.
 *
 * Migration history: extracted from `agent.ts:3066-3120` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P2 (CAP-052 batch).
 */

import type {
  KodaXExecutionMode,
  KodaXOptions,
  KodaXTaskType,
} from '../types.js';
import type { ReasoningPlan } from '../reasoning.js';
import { buildProviderPolicyHintsForDecision } from '../reasoning.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { formatFullSkillSection } from '../skill-invocation-format.js';
import { buildAutoRepoIntelligenceContext } from './middleware/repo-intelligence.js';
import { getModelSkillCatalog } from './tool-resolution.js';

export interface ReasoningExecutionState {
  effectiveOptions: KodaXOptions;
  systemPrompt: string;
  providerReasoning: {
    enabled: boolean;
    effort: KodaXOptions['effort'];
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
    effort: reasoningPlan.effort,
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

  const instructions = options.context?.systemPromptOverride ?? options.context?.agentProfile?.instructions;
  // Root Runs use the managed Worker; every leaf caller supplies its own prompt.
  if (!instructions) {
    throw new Error('The leaf executor requires systemPromptOverride or agentProfile.instructions; root Runs use the managed Worker.');
  }
  return {
    effectiveOptions,
    systemPrompt: [
      instructions,
      options.context?.systemPromptOverride === undefined ? getModelSkillCatalog(effectiveOptions) : undefined,
      effectiveOptions.context?.skillInvocation
        ? formatFullSkillSection(effectiveOptions.context.skillInvocation)
        : undefined,
    ].filter((section): section is string => Boolean(section)).join('\n\n'),
    providerReasoning: {
      enabled: reasoningPlan.effort !== 'none',
      effort: reasoningPlan.effort,
      taskType: reasoningPlan.decision.primaryTask,
      executionMode: reasoningPlan.decision.recommendedMode,
    },
  };
}
