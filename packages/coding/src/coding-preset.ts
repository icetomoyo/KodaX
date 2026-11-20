import { staticText } from './prompts/static-text.js';
/**
 * Coding Agent declarations (FEATURE_080 -> FEATURE_100 -> FEATURE_311).
 *
 * `Runner.run` dispatches a coding Agent through `Agent.substrateExecutor`
 * (ADR-020). One declaration shape serves two executors: the public
 * `createDefaultCodingAgent()` preset runs the managed Worker, and the
 * internal leaf executor (`runLeafAgent`) runs the direct substrate.
 *
 * The managed preset lives in `default-coding-agent.ts` so this file does not
 * import the task engine, which already depends on the leaf executor.
 */

import {
  createAgent,
  extractAssistantTextFromMessage,
  type Agent,
  type AgentMessage,
  type AgentMiddlewareDeclaration,
  type PresetDispatcher,
  type RunResult,
} from '@kodax-ai/agent';
import type { MemoryDecisionReceipt } from '@kodax-ai/agent/experimental-memory';

import { withMemoryDecisionTrace } from './memory/decision-trace.js';
import type { KodaXOptions, KodaXResult } from './types.js';

/** Stable name used as the dispatch key for the built-in coding preset. */
export const DEFAULT_CODING_AGENT_NAME = 'kodax/coding/default';

const DEFAULT_CODING_INSTRUCTIONS = staticText("coding-preset.instructions") + '\n';

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

/** Runs one coding execution for a Runner-dispatched coding Agent. */
export type CodingAgentExecutor = (
  options: KodaXOptions,
  prompt: string,
  agent: Agent,
) => Promise<KodaXResult>;

/**
 * Substrate executor closure for a coding Agent declaration.
 * Adapts the Layer-A `Runner.run` signature to a coding executor and lifts
 * the full `KodaXResult` onto `RunResult.data`, so internal callers recover
 * the coding-specific shape without a second execution.
 */
const createCodingSubstrate = (execute: CodingAgentExecutor): PresetDispatcher => async (
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
  try {
    result = tracingContext === undefined
      ? await execute(merged, prompt, agent)
      : await withMemoryDecisionTrace(memoryDecisionReceipts, () => execute(merged, prompt, agent));
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
 * Default middleware declarations the coding substrate ships with.
 * The declaration list describes active substrate middleware and lets
 * SDK consumers override (`createDefaultCodingAgent({ middleware: […] })`)
 * without forking the substrate body.
 */
export const DEFAULT_CODING_MIDDLEWARE: readonly AgentMiddlewareDeclaration[] = Object.freeze([
  Object.freeze({ name: 'autoReroute', enabled: true }),
  Object.freeze({ name: 'mutationReflection', enabled: true }),
  // Keep the declaration names for compatibility; the V1 judges are retired.
  Object.freeze({ name: 'preAnswerJudge', enabled: false }),
  Object.freeze({ name: 'postToolJudge', enabled: false }),
]);

/**
 * Construct a coding Agent declaration whose `Runner.run` dispatch calls
 * `execute`. The public preset passes the managed Worker; the internal leaf
 * executor passes the direct substrate.
 *
 * `overrides` lets callers attach additional declarative fields
 * (e.g. custom `reasoning` profile, extra `guardrails`, custom
 * `provider`/`model`); these are preserved on the Agent and may be
 * consumed by the substrate executor through `presetOptions`.
 */
export function createCodingAgent(
  execute: CodingAgentExecutor,
  overrides: Partial<Omit<Agent, 'name' | 'instructions'>> = {},
): Agent {
  return createAgent({
    name: DEFAULT_CODING_AGENT_NAME,
    instructions: DEFAULT_CODING_INSTRUCTIONS,
    substrateExecutor: createCodingSubstrate(execute),
    middleware: DEFAULT_CODING_MIDDLEWARE,
    ...overrides,
  });
}
