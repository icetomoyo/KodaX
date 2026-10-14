export { extractArtifactLedger, mergeArtifactLedger, type CompactionAnchor, type CompactionUpdate } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { isToolMutation } from './tools/index.js';
import { getMissingToolParams } from './tools/registry.js';

/**
 * A salvaged tool input is untrustworthy to execute when EITHER:
 *   - the stream did not end on a clean stop (`_truncated`) — may be cut
 *     mid-value, unsafe for any tool; OR
 *   - the tool is non-readonly per `isToolMutation` — any `sideEffect` other
 *     than `'readonly'` (filesystem/shell mutation, network reads/writes, state
 *     changes). Even a "complete" turn can carry malformed JSON (e.g. unescaped
 *     quotes) that salvage silently truncates mid-value — corrupting a file or
 *     firing an unintended side-effecting call; the protocol stop reason does
 *     not guarantee argument integrity.
 * A salvaged read-only input on a clean stop is allowed through (low risk,
 * avoids a needless retry loop for providers that emit non-strict-but-complete
 * JSON).
 */
export function isUntrustedSalvage(tc: KodaXToolUseBlock): boolean {
  return tc._truncated === true || (tc._salvaged === true && isToolMutation(tc.name));
}

export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    // Salvage guard: a tool block whose input was salvaged from malformed JSON
    // is untrustworthy (see isUntrustedSalvage) — flag and skip the per-param
    // scan so the agent loop retries instead of executing corrupt input.
    if (isUntrustedSalvage(tc)) {
      incomplete.push(`${tc.name}: incomplete input (salvaged from malformed/truncated JSON)`);
      continue;
    }
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of getMissingToolParams(tc.name, input)) {
      incomplete.push(`${tc.name}: missing '${param}'`);
    }
  }
  return incomplete;
}
