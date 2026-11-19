/**
 * KodaX leaf executor.
 *
 * `runLeafAgent(opts, prompt)` delegates to
 * `Runner.run(createCodingAgent(runSubstrate), …)` so leaf execution flows through
 * the Layer-A frame (ADR-020). The substrate body lives in
 * `agent-runtime/run-substrate.ts` (`runSubstrate`) and is wired via the
 * `Agent.substrateExecutor` closure attached in `coding-preset.ts`.
 */

import { Runner } from '@kodax-ai/agent';
import { resolveWorkMode } from './work-mode.js';
import { runWithScopedConfig } from '@kodax-ai/llm';

import { runSubstrate } from './agent-runtime/run-substrate.js';
import { createCodingAgent } from './coding-preset.js';
import { applyFollowupEscalationToOptions } from './reasoning.js';
import { deriveRunScopedConfig } from './run-scoped-config.js';
import {
  applyRuntimeSkillInvocationPolicy,
  awaitRuntimeSkillInvocationPolicy,
} from './skill-invocation-policy.js';
import { normalizeKodaXAgentMode, type KodaXOptions, type KodaXResult } from './types.js';
import { assertPromptSpecOnManagedRun } from './prompts/prompt-spec.js';

/**
 * Internal leaf executor: one Agent on the direct substrate, with no managed
 * Worker. Child Agents and their digest/repair one-shots run here. Public root
 * Runs go through the managed task engine instead.
 */
export async function runLeafAgent(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  if (resolveWorkMode(options) === 'script') throw new Error('Script requires the managed Run entry: use runManagedTask with Session storage.');
  assertPromptSpecOnManagedRun(options.context?.prompt);
  const policyOptions = await applyRuntimeSkillInvocationPolicy(options, prompt);
  const normalizedOptions: KodaXOptions = policyOptions.agentMode === undefined
    ? policyOptions
    : { ...policyOptions, agentMode: normalizeKodaXAgentMode(policyOptions.agentMode) };
  // FEATURE_103 (v0.7.29): apply L5 user-followup escalation at the
  // direct-engine entry. When the user's prompt contains a doubt or deepen marker
  // (and, for doubt, there is a prior assistant turn in the session),
  // bump the L1 ceiling one rank. Off remains off (kill switch). Pure
  // option transform — no escalation = same reference returned.
  const { options: baseOptions } = applyFollowupEscalationToOptions(normalizedOptions, prompt);
  // Keep profile instructions distinct from a caller's complete prompt override.
  // The substrate composes profile instructions with the admitted Skill catalog.
  const runtimeOptions: KodaXOptions = baseOptions.context?.permissionIntent !== undefined
    ? baseOptions
    : {
        ...baseOptions,
        context: {
          ...baseOptions.context,
          permissionIntent: { rootUserIntent: prompt },
        },
      };
  // Establish the run-scoped config (AsyncLocalStorage) around the whole run.
  // Without this the per-run overrides (modelTiers / maxOutputTokens /
  // disablePromptCache / lsp / workflow) would be dropped for a leaf that is
  // not already inside a managed scope. When a caller nests it inside an
  // existing scope this re-establishes the same scope, so it is idempotent.
  let failure: unknown;
  try {
    return await runWithScopedConfig(deriveRunScopedConfig(runtimeOptions), async () => {
      const result = await Runner.run<KodaXResult>(createCodingAgent(runSubstrate), prompt, {
        presetOptions: runtimeOptions,
        abortSignal: runtimeOptions.abortSignal,
        // FEATURE_092 (v0.7.33): forward caller-supplied run-scoped guardrails.
        // Runtime owns Auto[LLM] review at the proven host boundary; these are
        // additional caller policies merged with `agent.guardrails`.
        guardrails: runtimeOptions.guardrails,
        permissionIntent: runtimeOptions.context?.permissionIntent,
      });
      // Substrate executor always lifts full `KodaXResult` onto `data` —
      // missing means the Agent declaration is mis-wired (fail loud, never
      // return a truncated `RunResult` typed as `KodaXResult`).
      if (!result.data) {
        throw new Error(
          'runLeafAgent: substrate executor did not lift KodaXResult onto RunResult.data — '
          + 'verify createCodingAgent().substrateExecutor in coding-preset.ts',
        );
      }
      return result.data;
    });
  } catch (error: unknown) {
    failure = error;
    throw error;
  } finally {
    await awaitRuntimeSkillInvocationPolicy(policyOptions, failure);
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
