/**
 * KodaX Agent — public SDK entry post-FEATURE_100 P3.6r/P3.6s.
 *
 * `runKodaX(opts, prompt)` is the stable SDK signature; internally it
 * delegates to `Runner.run(createDefaultCodingAgent(), …)` so SA
 * execution always flows through the Layer-A frame (Option Y deletion
 * per ADR-020 / v0.7.29 §239 §371). Substrate body lives in
 * `agent-runtime/run-substrate.ts` (`runSubstrate`) and is wired via
 * the `Agent.substrateExecutor` closure attached in `coding-preset.ts`.
 */

import { Runner } from '@kodax/core';

import { createDefaultCodingAgent } from './coding-preset.js';
import { applyFollowupEscalationToOptions } from './reasoning.js';
import type { KodaXOptions, KodaXResult } from './types.js';

export async function runKodaX(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  // FEATURE_103 (v0.7.29): apply L5 user-followup escalation at the SA
  // entry. When the user's prompt contains a doubt or deepen marker
  // (and, for doubt, there is a prior assistant turn in the session),
  // bump the L1 ceiling one rank. Off remains off (kill switch). Pure
  // option transform — no escalation = same reference returned.
  const { options: effectiveOptions } = applyFollowupEscalationToOptions(options, prompt);
  const result = await Runner.run<KodaXResult>(createDefaultCodingAgent(), prompt, {
    presetOptions: effectiveOptions,
    abortSignal: effectiveOptions.abortSignal,
  });
  // Substrate executor always lifts full `KodaXResult` onto `data` —
  // missing means the Agent declaration is mis-wired (fail loud, never
  // return a truncated `RunResult` typed as `KodaXResult`).
  if (!result.data) {
    throw new Error(
      'runKodaX: substrate executor did not lift KodaXResult onto RunResult.data — '
      + 'verify createDefaultCodingAgent().substrateExecutor in coding-preset.ts',
    );
  }
  return result.data;
}

export { buildAutoRepoIntelligenceContext } from './agent-runtime/middleware/repo-intelligence.js';
export {
  estimateProviderPayloadBytes,
  bucketProviderPayloadSize,
} from './agent-runtime/provider-payload.js';
export { checkPromiseSignal } from './agent-runtime/thinking-mode-replay.js';
export { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
export { saveSessionSnapshot } from './agent-runtime/middleware/session-snapshot.js';
export { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from './agent-runtime/history-cleanup.js';
