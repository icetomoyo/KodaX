/**
 * Incomplete tool-call truncation retry — CAP-072
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-072-incomplete-tool-truncation-retry
 *
 * Class 1 (substrate). When the provider truncates the response
 * mid-tool-call (some required parameters missing), this step provides
 * a single-shot-then-degrade recovery loop:
 *
 *   1. Detect via `checkIncompleteToolCalls` (returns names of params
 *      missing across all tool blocks).
 *   2. If under `KODAX_MAX_INCOMPLETE_RETRIES`: emit `onRetry`, pop
 *      the malformed assistant message, push a synthetic user prompt
 *      asking for shorter / complete parameters, return `retry` →
 *      caller `continue`s the outer for-loop.
 *   3. If at the cap: log a `Max retries exceeded` retry banner, build
 *      synthetic error tool_results for each tool with missing params,
 *      emit `tool:result` extension events + `events.onToolResult`,
 *      push the error block, reset counter, return `maxed_out` →
 *      caller `continue`s the outer for-loop (the next turn sees the
 *      error tool_results and can recover via assistant text).
 *   4. If no incomplete tools: reset counter, return `no_incomplete` →
 *      caller falls through to normal tool execution.
 *
 * The retry prompt escalates between attempt 1 and attempt 2+ — first
 * attempt is a polite reminder; subsequent attempts include explicit
 * size limits (50 lines for write, 30 for edit) and a "task will FAIL"
 * threat. This is intentional: providers that truncate once usually
 * recover on the next turn with a polite hint, but providers that
 * truncate repeatedly need stronger framing.
 *
 * Side effects:
 *   - mutates the `messages` array (pop assistant + push synthetic user,
 *     OR push error tool_results)
 *   - awaits `emitActiveExtensionEvent('tool:result', ...)` for each
 *     missing-parameter tool when the cap is hit
 *   - calls `events.onRetry` and `events.onToolResult` synchronously
 *
 * Migration history: extracted from `agent.ts:1233-1285` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.3b.
 */

import type { KodaXEvents, KodaXContextTokenSnapshot } from '../types.js';
import type { KodaXMessage, KodaXToolUseBlock, KodaXToolResultBlock } from '@kodax/ai';
import { checkIncompleteToolCalls } from '../messages.js';
import { getRequiredToolParams } from '../tools/index.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';
import { createToolResultBlock } from './tool-dispatch.js';
import { KODAX_MAX_INCOMPLETE_RETRIES } from '../constants.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';

export type IncompleteToolOutcome = 'retry' | 'maxed_out' | 'no_incomplete';

export interface IncompleteToolRetryInput {
  readonly toolBlocks: KodaXToolUseBlock[];
  readonly events: KodaXEvents;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
  /** Live message buffer — mutated in place. */
  readonly messages: KodaXMessage[];
  readonly incompleteRetryCount: number;
  readonly preAssistantTokenSnapshot: KodaXContextTokenSnapshot;
  readonly completedTurnTokenSnapshot: KodaXContextTokenSnapshot;
}

export interface IncompleteToolRetryResult {
  readonly outcome: IncompleteToolOutcome;
  /** Next iteration's incompleteRetryCount (0 on no_incomplete / maxed_out). */
  readonly nextIncompleteRetryCount: number;
  /** Next contextTokenSnapshot — caller assigns. */
  readonly nextContextTokenSnapshot: KodaXContextTokenSnapshot;
}

function buildRetryPrompt(missingParams: string[], retryCount: number): string {
  if (retryCount === 1) {
    return `Your previous response was truncated. Missing required parameters:\n${missingParams.map(i => `- ${i}`).join('\n')}\n\nPlease provide the complete tool calls with ALL required parameters.\nFor large content, keep it concise (under 50 lines for write operations).`;
  }
  return `⚠️ CRITICAL: Your response was TRUNCATED again. This is retry ${retryCount}/${KODAX_MAX_INCOMPLETE_RETRIES}.\n\nMISSING PARAMETERS:\n${missingParams.map(i => `- ${i}`).join('\n')}\n\nYOU MUST:\n1. For 'write' tool: Keep content under 50 lines - write structure first, fill in later with 'edit'\n2. For 'edit' tool: Keep new_string under 30 lines - make smaller, focused changes\n3. Provide ALL required parameters in your tool call\n\nIf your response is truncated again, the task will FAIL.\nPROVIDE SHORT, COMPLETE PARAMETERS NOW.`;
}

export async function checkAndRetryIncompleteTools(
  input: IncompleteToolRetryInput,
): Promise<IncompleteToolRetryResult> {
  const incomplete = checkIncompleteToolCalls(input.toolBlocks);

  // No incomplete tool calls — caller proceeds to normal tool execution.
  if (incomplete.length === 0) {
    return {
      outcome: 'no_incomplete',
      nextIncompleteRetryCount: 0,
      nextContextTokenSnapshot: input.completedTurnTokenSnapshot,
    };
  }

  const nextCount = input.incompleteRetryCount + 1;

  // Under the cap — pop assistant, push synthetic user prompt, retry.
  if (nextCount <= KODAX_MAX_INCOMPLETE_RETRIES) {
    input.events.onRetry?.(
      `Incomplete tool calls: ${incomplete.join(', ')}`,
      nextCount,
      KODAX_MAX_INCOMPLETE_RETRIES,
    );
    input.messages.pop();
    input.messages.push({
      role: 'user',
      content: buildRetryPrompt(incomplete, nextCount),
      _synthetic: true,
    });
    const rebased = rebaseContextTokenSnapshot(
      input.messages,
      input.preAssistantTokenSnapshot,
    );
    return {
      outcome: 'retry',
      nextIncompleteRetryCount: nextCount,
      nextContextTokenSnapshot: rebased,
    };
  }

  // At the cap — synthesize error tool_results for the missing-param tools.
  input.events.onRetry?.(
    `Max retries exceeded for incomplete tool calls. Skipping: ${incomplete.join(', ')}`,
    nextCount,
    KODAX_MAX_INCOMPLETE_RETRIES,
  );
  const incompleteIds = new Set<string>();
  for (const tc of input.toolBlocks) {
    const required = getRequiredToolParams(tc.name);
    const inputObj = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (inputObj[param] === undefined || inputObj[param] === null || inputObj[param] === '') {
        incompleteIds.add(tc.id);
        break;
      }
    }
  }

  const errorResults: KodaXToolResultBlock[] = [];
  for (const id of incompleteIds) {
    const tc = input.toolBlocks.find(t => t.id === id);
    if (tc) {
      const errorMsg = `[Tool Error] ${tc.name}: Skipped due to missing required parameters after ${KODAX_MAX_INCOMPLETE_RETRIES} retries`;
      await input.emitActiveExtensionEvent('tool:result', {
        id: tc.id,
        name: tc.name,
        content: errorMsg,
      });
      input.events.onToolResult?.({ id: tc.id, name: tc.name, content: errorMsg });
      errorResults.push(createToolResultBlock(tc.id, errorMsg));
    }
  }
  input.messages.push({ role: 'user', content: errorResults });
  const rebased = rebaseContextTokenSnapshot(
    input.messages,
    input.completedTurnTokenSnapshot,
  );
  return {
    outcome: 'maxed_out',
    nextIncompleteRetryCount: 0,
    nextContextTokenSnapshot: rebased,
  };
}
