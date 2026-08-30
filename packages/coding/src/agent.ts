/**
 * KodaX Agent — public SDK entry post-FEATURE_100 P3.6r/P3.6s.
 *
 * `runKodaX(opts, prompt)` is the stable SDK signature; internally it
 * delegates to `Runner.run(createDefaultCodingAgent(), …)` so SA
 * execution always flows through the Layer-A frame (Option Y deletion
 * per ADR-020 / v0.7.29 §239 §371). Substrate body lives in
 * `agent-runtime/run-substrate.ts` (`runSubstrate`) and is wired via
 * the `Agent.substrateExecutor` closure attached in `coding-preset.ts`.
 *
 * v0.7.42: `runRunKodaXInternal` is the shared implementation. The
 * embedder-facing `startKodaX` (non-blocking, returns `RunningSession`)
 * lives in `./running-session.ts` and wraps the same internal path —
 * no dual route (per feedback_no_parallel_refactor_paths).
 */

import { Runner } from '@kodax-ai/agent';
import { runWithScopedConfig } from '@kodax-ai/llm';

import { createDefaultCodingAgent } from './coding-preset.js';
import { applyFollowupEscalationToOptions } from './reasoning.js';
import { deriveRunScopedConfig } from './run-scoped-config.js';
import {
  applyRuntimeSkillInvocationPolicy,
  awaitRuntimeSkillInvocationPolicy,
} from './skill-invocation-policy.js';
import { normalizeKodaXAgentMode, type KodaXOptions, type KodaXResult } from './types.js';

export async function runKodaX(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const policyOptions = await applyRuntimeSkillInvocationPolicy(options);
  const normalizedOptions: KodaXOptions = policyOptions.agentMode === undefined
    ? policyOptions
    : { ...policyOptions, agentMode: normalizeKodaXAgentMode(policyOptions.agentMode) };
  // FEATURE_103 (v0.7.29): apply L5 user-followup escalation at the SA
  // entry. When the user's prompt contains a doubt or deepen marker
  // (and, for doubt, there is a prior assistant turn in the session),
  // bump the L1 ceiling one rank. Off remains off (kill switch). Pure
  // option transform — no escalation = same reference returned.
  const { options: baseOptions } = applyFollowupEscalationToOptions(normalizedOptions, prompt);
  // FEATURE_247 (R1, SA): a profile's instructions map to `systemPromptOverride`
  // on the SA path (consumed in reasoning-plan-entry). `dispatchManagedTask`
  // applies this for its SA route, but `runKodaX` is ALSO a direct SA entry
  // (`startKodaX` wraps it), so a consumer that sets only
  // `context.agentProfile.instructions` via `runKodaX`/`startKodaX` would have
  // them silently dropped. Apply the same mapping here — an explicit caller-set
  // override still wins, and it is byte-identical when neither is set (or when
  // reached via dispatch, which already set the field: `??` no-op). Top-level
  // AMA dispatch routes to `runAMA`; Runtime Actor children may call this direct
  // substrate with AMA capability semantics, but do not use the AMA role-prompt
  // path, so this cannot double-inject that prompt.
  const profileInstructions = baseOptions.context?.agentProfile?.instructions;
  const effectiveOptions: KodaXOptions =
    profileInstructions !== undefined && baseOptions.context?.systemPromptOverride === undefined
      ? {
          ...baseOptions,
          context: { ...baseOptions.context, systemPromptOverride: profileInstructions },
        }
      : baseOptions;
  const runtimeOptions: KodaXOptions = effectiveOptions.context?.permissionIntent !== undefined
    ? effectiveOptions
    : {
        ...effectiveOptions,
        context: {
          ...effectiveOptions.context,
          permissionIntent: { rootUserIntent: prompt },
        },
      };
  // Establish the run-scoped config (AsyncLocalStorage) around the whole run.
  // `runKodaX` is a public SDK entry (and the target `startKodaX` wraps), so
  // without this the per-run overrides (modelTiers / maxOutputTokens /
  // disablePromptCache / lsp / workflow) would be silently dropped whenever a
  // consumer calls it directly rather than via `runManagedTask`. When reached
  // through `runManagedTask` (SA dispatch) this simply re-establishes the same
  // scope — nesting replaces with an identical config, so it is idempotent.
  try {
    return await runWithScopedConfig(deriveRunScopedConfig(runtimeOptions), async () => {
      const result = await Runner.run<KodaXResult>(createDefaultCodingAgent(), prompt, {
        presetOptions: runtimeOptions,
        abortSignal: runtimeOptions.abortSignal,
        // FEATURE_092 (v0.7.33): forward caller-supplied run-scoped guardrails
        // (e.g. AutoModeToolGuardrail injected by the REPL bootstrap when
        // permissionMode === 'auto'). Runner merges with `agent.guardrails`.
        guardrails: runtimeOptions.guardrails,
        permissionIntent: runtimeOptions.context?.permissionIntent,
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
    });
  } finally {
    await awaitRuntimeSkillInvocationPolicy(policyOptions);
  }
}

export { buildAutoRepoIntelligenceContext } from './agent-runtime/middleware/repo-intelligence.js';
export {
  estimateProviderPayloadBytes,
  bucketProviderPayloadSize,
} from './agent-runtime/provider-payload.js';
export { checkPromiseSignal } from './agent-runtime/thinking-mode-replay.js';
export { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
export {
  saveRequiredSessionSnapshot,
  saveSessionSnapshot,
} from './agent-runtime/middleware/session-snapshot.js';
export { describeTransientProviderRetry } from './agent-runtime/provider-retry-policy.js';
export {
  cleanupIncompleteToolCalls,
  validateAndFixToolHistory,
} from '@kodax-ai/agent';
