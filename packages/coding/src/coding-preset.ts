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
 * This file stays in `@kodax/coding` because the substrate executor closure
 * imports `runSubstrate` from `agent-runtime/run-substrate.ts`. Importing
 * `@kodax/core` alone never loads the substrate body.
 */

import {
  createAgent,
  extractAssistantTextFromMessage,
  type Agent,
  type AgentMessage,
  type PresetDispatcher,
  type RunResult,
} from '@kodax/core';

import { runSubstrate } from './agent-runtime/run-substrate.js';
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

function extractFinalAssistantText(result: KodaXResult): string {
  if (result.lastText) return result.lastText;
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message?.role === 'assistant') {
      const text = extractAssistantTextFromMessage(message);
      if (text) return text;
    }
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
  _agent,
  input,
  opts,
  tracingContext,
) => {
  const presetOptions = (opts?.presetOptions ?? {}) as KodaXOptions;
  const merged: KodaXOptions = opts?.abortSignal
    ? { ...presetOptions, abortSignal: opts.abortSignal }
    : presetOptions;
  const prompt = extractPrompt(input);

  // FEATURE_083 (v0.7.24): record a GenerationSpan around the substrate
  // call when a tracing context is supplied. The substrate path executes
  // a full reasoning+tool loop internally; this span represents the
  // boundary call and carries the provider/model declared on the preset
  // options.
  const genSpan = tracingContext
    ? tracingContext.agentSpan.addChild('coding:runSubstrate', {
        kind: 'generation',
        agentName: DEFAULT_CODING_AGENT_NAME,
        provider: merged.provider ?? 'unknown',
        model: merged.model ?? 'unknown',
      })
    : null;

  let result: KodaXResult;
  try {
    result = await runSubstrate(merged, prompt);
  } catch (err) {
    if (genSpan) {
      genSpan.setError(err instanceof Error ? err : new Error(String(err)));
      genSpan.end();
    }
    throw err;
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
    ...overrides,
  });
}
