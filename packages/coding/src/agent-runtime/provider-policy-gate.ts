/**
 * Provider-policy gate orchestration — CAP-064
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-064-provider-policy-evaluation--system-prompt-extension
 *
 * Class 1 (substrate). Wraps `evaluateProviderPolicy` (which lives in
 * the `provider-policy.ts` data-module) into a per-turn gate: throw
 * on block status, otherwise produce the extended system prompt that
 * carries any policy issue notes.
 *
 * The split between the data module (`provider-policy.ts` —
 * decision rules + note formatting) and this gate (when to apply,
 * what to do with the decision) keeps the substrate piece testable
 * without importing the full policy rule set.
 *
 * Three outputs from one call:
 *   1. THROWS on `status === 'block'` (with `[Provider Policy] {summary}`)
 *   2. `effectiveSystemPrompt` — the base prompt extended with policy
 *      notes when there are issues, otherwise the base prompt unchanged
 *   3. `decision` — exposed for telemetry / debug callers (not currently
 *      used by `agent.ts`, but kept on the return shape so future
 *      observability hooks can wire in without changing this signature)
 *
 * Migration history: extracted from `agent.ts:766-785` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.2b.
 */

import type { KodaXBaseProvider } from '@kodax/ai';
import type { KodaXOptions } from '../types.js';
import {
  buildProviderPolicyPromptNotes,
  evaluateProviderPolicy,
  type KodaXProviderPolicyDecision,
} from '../provider-policy.js';

export interface ProviderPolicyGateInput {
  readonly providerName: string;
  readonly model: string | undefined;
  readonly provider: KodaXBaseProvider;
  readonly prompt: string;
  readonly effectiveOptions: KodaXOptions;
  readonly reasoningMode: string;
  readonly taskType: string;
  readonly executionMode: string;
  /** The base system prompt produced by buildReasoningExecutionState. */
  readonly baseSystemPrompt: string;
}

export interface ProviderPolicyGateResult {
  readonly effectiveSystemPrompt: string;
  readonly decision: KodaXProviderPolicyDecision;
}

export function applyProviderPolicyGate(
  input: ProviderPolicyGateInput,
): ProviderPolicyGateResult {
  const decision = evaluateProviderPolicy({
    providerName: input.providerName,
    model: input.model,
    provider: input.provider,
    prompt: input.prompt,
    options: input.effectiveOptions,
    context: input.effectiveOptions.context,
    reasoningMode: input.reasoningMode as Parameters<typeof evaluateProviderPolicy>[0]['reasoningMode'],
    taskType: input.taskType as Parameters<typeof evaluateProviderPolicy>[0]['taskType'],
    executionMode: input.executionMode as Parameters<typeof evaluateProviderPolicy>[0]['executionMode'],
  });
  if (decision.status === 'block') {
    throw new Error(`[Provider Policy] ${decision.summary}`);
  }
  const effectiveSystemPrompt = decision.issues.length > 0
    ? [
        input.baseSystemPrompt,
        buildProviderPolicyPromptNotes(decision).join('\n'),
      ].join('\n\n')
    : input.baseSystemPrompt;
  return { effectiveSystemPrompt, decision };
}
