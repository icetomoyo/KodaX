import { isDeepStrictEqual } from 'node:util';
import type { KodaXStreamResult, KodaXToolResultBlock, KodaXToolUseBlock } from '../packages/llm/src/types.js';
import type { FrozenInput } from './first-turn-eval-support.js';

/** Experimental text substitution only. Never alter capability assembly or execution. */
export function compactTeachingInput(input: FrozenInput, original: string, candidate: string): FrozenInput {
  if (!original || !candidate || original === candidate || input.system.split(original).length !== 2) {
    throw new Error('Expected one exact stable prompt occurrence and a distinct candidate');
  }
  return { ...input, system: input.system.replace(original, () => candidate) };
}

export interface ControlledAction {
  name: string;
  input: unknown;
  content: string;
  is_error?: boolean;
}

/** A choreographed probe never runs tools, guesses their result, or rewrites arguments. */
export function controlledResults(calls: readonly KodaXToolUseBlock[], actions: readonly ControlledAction[]): KodaXToolResultBlock[] {
  return calls.map(call => {
    const action = actions.find(item => item.name === call.name && isDeepStrictEqual(item.input, call.input));
    if (!action) throw new Error(`Unregistered controlled action: ${call.name}`);
    return { type: 'tool_result', tool_use_id: call.id, content: action.content,
      ...(action.is_error ? { is_error: true } : {}) };
  });
}

/** Input token counts reveal the shorter arm. Show them only after semantic review. */
export function semanticProbeEvidence(row: {
  text: string; toolCalls: readonly KodaXToolUseBlock[]; thinking: KodaXStreamResult['thinkingBlocks'];
  stopReason: string | null | undefined; error: string | null;
  usage?: unknown; referenceUsd?: number | null; durationMs?: number;
}) {
  return { text: row.text, toolCalls: row.toolCalls, thinking: row.thinking, stopReason: row.stopReason, error: row.error };
}
