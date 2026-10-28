/**
 * Default coding agent preset (FEATURE_080 → FEATURE_100).
 *
 * History:
 *   v0.7.23 (FEATURE_080) introduced "Option Y": a `registerPresetDispatcher`
 *   indirection that wrapped `runKodaX` so `Runner.run(defaultCodingAgent, …)`
 *   appeared SDK-native while the body stayed on the legacy path. The trade-off
 *   was deliberate parity insurance during the Layer-A primitives rollout.
 *
 *   v0.7.29 (FEATURE_100) deletes Option Y per ADR-020. The substrate executor
 *   is attached directly to the Agent declaration via `Agent.substrateExecutor`
 *   (an Agent field added in this version), and `Runner.run` consults that
 *   field before any registry lookup. No `registerPresetDispatcher` call is
 *   made any more, so `Runner.run(createDefaultCodingAgent(), …)` and
 *   `runKodaX(opts, prompt)` (now a thin `Runner.run` wrapper in `agent.ts`)
 *   share one execution path.
 *
 * This file stays in `@kodax-ai/coding` because the substrate executor closure
 * imports `runSubstrate` from `agent-runtime/run-substrate.ts`. Importing
 * `@kodax-ai/core` alone never loads the substrate body.
 */

import {
  createAgent,
  extractAssistantTextFromMessage,
  type Agent,
  type AgentMessage,
  type AgentMiddlewareDeclaration,
  type AgentReasoningProfile,
  type PresetDispatcher,
  type RunResult,
} from '@kodax-ai/agent';
import type { MemoryDecisionReceipt } from '@kodax-ai/agent/experimental-memory';

import { runSubstrate } from './agent-runtime/run-substrate.js';
import { withMemoryDecisionTrace } from './memory/decision-trace.js';
import { applyRuntimeSkillInvocationPolicy, awaitRuntimeSkillInvocationPolicy } from './skill-invocation-policy.js';
import type { KodaXOptions, KodaXResult } from './types.js';

/** Stable name used as the dispatch key for the built-in coding preset. */
export const DEFAULT_CODING_AGENT_NAME = 'kodax/coding/default';

const DEFAULT_CODING_INSTRUCTIONS = `KodaX default coding agent.

This agent is a thin declaration that routes through the built-in \`runKodaX\`
pipeline. Tools, extensions, reasoning, provider selection, session
persistence, compaction and harness routing are all driven by the
\`KodaXOptions\` forwarded via \`Runner.run\` \`opts.presetOptions\`.
`;

function extractPrompt(input: string | readonly AgentMessage[]): string {
  if (typeof input === 'string') return input;
  for (let i = input.length - 1; i >= 0; i--) {
    const message = input[i];
    if (message?.role === 'user') {
      return extractAssistantTextFromMessage(message) || '';
    }
  }
  return '';
}

/**
 * An assistant turn whose text is empty or a bare `'...'` is NOT a real
 * reply — it is the empty-content marker (new sessions) or a legacy
 * persisted placeholder (old sessions). Such turns must never surface as
 * SDK output. The wire-only `'...'` the serializer adds lives only in the
 * provider payload, never in `result.messages`, so this filter only ever
 * sees an in-history marker, not a legitimate model answer.
 */
function isPlaceholderOnlyAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || trimmed === '...';
}

/**
 * A user message whose content is ONLY tool_result block(s) — the trailing
 * turn that legitimately follows the final assistant answer. It is the only
 * trailing message kind we skip when locating this run's final assistant.
 */
function isPureToolResultUserMessage(message: { role: string; content: unknown }): boolean {
  if (message.role !== 'user') return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) => !!b && typeof b === 'object' && 'type' in b && (b as { type: string }).type === 'tool_result',
  );
}

/**
 * Derive THIS run's final assistant output. Exported for unit testing the
 * empty/placeholder filter (P1③).
 *
 * Only the most-recent assistant turn represents this run's output. We skip
 * solely a trailing pure-tool_result user turn (the assistant answer sits
 * just before it), then stop at the first assistant message. Any OTHER
 * trailing message — a normal user prompt or a system message — means this
 * run produced no assistant reply (provider error / interrupted before the
 * assistant turn), so we return `''`. Likewise, if that assistant turn is an
 * empty marker or legacy `'...'` placeholder, return `''`. We must NEVER
 * resurface a stale answer from an earlier turn: in a resumed `-c` session
 * the earlier turns answered a DIFFERENT question.
 */
export function extractFinalAssistantText(result: KodaXResult): string {
  if (result.lastText && !isPlaceholderOnlyAssistantText(result.lastText)) {
    return result.lastText;
  }
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (!message) continue;
    if (message.role === 'assistant') {
      const text = extractAssistantTextFromMessage(message);
      return text && !isPlaceholderOnlyAssistantText(text) ? text : '';
    }
    if (isPureToolResultUserMessage(message)) continue;
    return '';
  }
  return '';
}

/**
 * Substrate executor closure attached to `createDefaultCodingAgent()`.
 * Adapts the Layer-A `Runner.run` signature → coding-specific
 * `runSubstrate(KodaXOptions, prompt)` and lifts the full `KodaXResult`
 * onto `RunResult.data` so the `runKodaX` shim (and any other internal
 * caller that needs the coding-specific shape — `client.ts`,
 * `task-engine.ts`, `child-executor.ts`, `acp_server.ts`, golden
 * recorder, integration tests) recovers it without a second execution.
 */
const codingSubstrate: PresetDispatcher = async (
  agent,
  input,
  opts,
  tracingContext,
) => {
  const presetOptions = (opts?.presetOptions ?? {}) as KodaXOptions;
  const permissionBoundOptions: KodaXOptions = opts?.permissionIntent === undefined
    ? presetOptions
    : {
        ...presetOptions,
        context: {
          ...presetOptions.context,
          permissionIntent: opts.permissionIntent,
        },
      };
  const baseMerged: KodaXOptions = opts?.abortSignal
    ? { ...permissionBoundOptions, abortSignal: opts.abortSignal }
    : permissionBoundOptions;
  const mergedGuardrails = [
    ...(agent.guardrails ?? []),
    ...(opts?.guardrails ?? presetOptions.guardrails ?? []),
  ];
  const merged: KodaXOptions = mergedGuardrails.length > 0
    ? { ...baseMerged, guardrails: [...new Set(mergedGuardrails)] }
    : baseMerged;
  const prompt = extractPrompt(input);

  // FEATURE_083 (v0.7.24): record a GenerationSpan around the substrate
  // call when a tracing context is supplied. The substrate path executes
  // a full reasoning+tool loop internally; this span represents the
  // boundary call and carries the provider/model declared on the preset
  // options.
  const memoryDecisionReceipts: MemoryDecisionReceipt[] = [];
  const genSpan = tracingContext
    ? tracingContext.agentSpan.addChild('coding:runSubstrate', {
        kind: 'generation',
        agentName: DEFAULT_CODING_AGENT_NAME,
        provider: merged.provider ?? 'unknown',
        model: merged.model ?? 'unknown',
        memoryDecisionReceipts,
      })
    : null;

  let result: KodaXResult;
  const ownsSkillPolicy = merged.context?.activateModelSkill === undefined;
  let runtimeOptions = merged;
  let failure: unknown;
  try {
    if (ownsSkillPolicy) runtimeOptions = await applyRuntimeSkillInvocationPolicy(merged, prompt);
    result = tracingContext === undefined
      ? await runSubstrate(runtimeOptions, prompt, agent)
      : await withMemoryDecisionTrace(memoryDecisionReceipts, () => runSubstrate(runtimeOptions, prompt, agent));
  } catch (err) {
    failure = err;
    if (genSpan) {
      genSpan.setError(err instanceof Error ? err : new Error(String(err)));
      genSpan.end();
    }
    throw err;
  } finally {
    if (ownsSkillPolicy) await awaitRuntimeSkillInvocationPolicy(runtimeOptions, failure);
  }
  if (genSpan) {
    genSpan.end();
  }

  const output = extractFinalAssistantText(result);
  // Lift the full `KodaXResult` onto `RunResult.data`. SDK consumers
  // that only need `output` / `messages` / `sessionId` ignore it; the
  // `runKodaX` shim and other internal callers cast it back via
  // `Runner.run<KodaXResult>` to recover lastText / success / usage / etc.
  const runResult: RunResult<KodaXResult> = {
    output,
    messages: result.messages,
    sessionId: result.sessionId,
    data: result,
  };
  return runResult;
};

/**
 * Default middleware declarations the coding substrate ships with.
 * The substrate body in `agent-runtime/run-substrate.ts` runs each of
 * these as branches today; the declaration list serves as the
 * machine-readable contract that the substrate honours, and lets
 * SDK consumers override (`createDefaultCodingAgent({ middleware: […] })`)
 * without forking the substrate body.
 */
export const DEFAULT_CODING_MIDDLEWARE: readonly AgentMiddlewareDeclaration[] = Object.freeze([
  Object.freeze({ name: 'autoReroute', enabled: true }),
  Object.freeze({ name: 'mutationReflection', enabled: true }),
  Object.freeze({ name: 'preAnswerJudge', enabled: true }),
  Object.freeze({ name: 'postToolJudge', enabled: true }),
]);

/**
 * Default reasoning profile for the SA single-agent declaration — FEATURE_078.
 *
 * Mirrors the AMA Worker profile (`balanced/deep`) so SA and AMA modes
 * share the same depth envelope. `escalateOnRevise: true` matches the
 * substrate's existing auto-reroute depth-escalation path that triggers
 * on uncertainty / low-value-review heuristics. FEATURE_193 (v0.7.43)
 * retired the V1 multi-role envelope (Scout / Planner / Generator /
 * Evaluator); only the Worker profile remains.
 *
 * The L1 user ceiling (`--reasoning <mode>` / `options.reasoningMode`) still
 * clamps the effective per-turn depth via `resolveRoleReasoning` and the
 * ceiling-aware `escalateThinkingDepth(_, ceiling)` helper.
 */
export const DEFAULT_CODING_REASONING_PROFILE: AgentReasoningProfile = Object.freeze({
  default: 'balanced',
  max: 'deep',
  escalateOnRevise: true,
});

/**
 * Construct the default coding Agent declaration. SDK consumers may write
 * `Runner.run(createDefaultCodingAgent(), prompt, { presetOptions })` and
 * the Runner will execute the substrate via `Agent.substrateExecutor`.
 *
 * `overrides` lets callers attach additional declarative fields
 * (e.g. custom `reasoning` profile, extra `guardrails`, custom
 * `provider`/`model`); these are preserved on the Agent and may be
 * consumed by the substrate executor through `presetOptions`.
 */
export function createDefaultCodingAgent(
  overrides: Partial<Omit<Agent, 'name' | 'instructions'>> = {},
): Agent {
  return createAgent({
    name: DEFAULT_CODING_AGENT_NAME,
    instructions: DEFAULT_CODING_INSTRUCTIONS,
    substrateExecutor: codingSubstrate,
    middleware: DEFAULT_CODING_MIDDLEWARE,
    reasoning: DEFAULT_CODING_REASONING_PROFILE,
    ...overrides,
  });
}
