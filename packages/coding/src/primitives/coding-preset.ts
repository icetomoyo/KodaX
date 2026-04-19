/**
 * Default coding agent preset + Runner dispatcher registration.
 *
 * FEATURE_080 (v0.7.23): the "Option Y" dog-food wiring. Importing this
 * module registers `runKodaX` as the dispatcher for the default coding
 * agent, so `Runner.run(createDefaultCodingAgent(), prompt, { presetOptions })`
 * routes through the existing task engine with zero behavior change.
 *
 * Importing from `./runner.js` + `./agent.js` alone does NOT load `runKodaX`.
 * Consumers who only need the generic Agent/Runner types should import from
 * those files (or from the `primitives/` barrel) directly and avoid this
 * module.
 */

import { runKodaX } from '../agent.js';
import type { KodaXOptions, KodaXResult } from '../types.js';

import {
  createAgent,
  type Agent,
  type AgentMessage,
} from './agent.js';
import {
  extractAssistantTextFromMessage,
  registerPresetDispatcher,
  type PresetDispatcher,
  type RunResult,
} from './runner.js';

/** Stable name used as the Runner dispatch key for the built-in coding preset. */
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

const codingDispatcher: PresetDispatcher = async (_agent, input, opts) => {
  const presetOptions = (opts?.presetOptions ?? {}) as KodaXOptions;
  const merged: KodaXOptions = opts?.abortSignal
    ? { ...presetOptions, abortSignal: opts.abortSignal }
    : presetOptions;
  const prompt = extractPrompt(input);
  const result = await runKodaX(merged, prompt);
  const output = extractFinalAssistantText(result);
  // Intentionally omit `data`: the full `KodaXResult` shape is a coding
  // preset implementation detail and should not leak through the Layer A
  // `RunResult` to external SDK consumers. Callers that need the raw
  // `KodaXResult` should invoke `runKodaX` directly.
  const runResult: RunResult = {
    output,
    messages: result.messages,
    sessionId: result.sessionId,
  };
  return runResult;
};

registerPresetDispatcher(DEFAULT_CODING_AGENT_NAME, codingDispatcher);

/**
 * Construct the default coding Agent. Exists as an Agent instance so SDK
 * consumers can write `Runner.run(createDefaultCodingAgent(), prompt, ...)`.
 *
 * `overrides` lets callers attach additional declarative fields (e.g. custom
 * `reasoning` profile, extra `guardrails`) — these are preserved on the Agent
 * object but the dispatcher currently only consumes `presetOptions` for
 * runtime behavior. Full wiring of declarative fields lands with FEATURE_084
 * (v0.7.26).
 */
export function createDefaultCodingAgent(
  overrides: Partial<Omit<Agent, 'name' | 'instructions'>> = {},
): Agent {
  return createAgent({
    name: DEFAULT_CODING_AGENT_NAME,
    instructions: DEFAULT_CODING_INSTRUCTIONS,
    ...overrides,
  });
}
