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
import type { KodaXMessage, KodaXToolUseBlock, KodaXToolResultBlock } from '@kodax-ai/llm';
import { checkIncompleteToolCalls, isUntrustedSalvage } from '../messages.js';
import { getRequiredToolParams } from '../tools/index.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';
import { createToolEventMeta, createToolResultBlock } from './tool-dispatch.js';
import { isVisibleToolName } from './event-emitter.js';
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

/**
 * Append the retry nudge to an existing `user` turn's content without breaking
 * its shape: a string turn gets the nudge as a trailing paragraph; a block-array
 * turn (e.g. tool_results) gets a trailing text block. Preserves alternation so
 * the incomplete-tool retry never emits a `user,user` pair.
 */
function appendTextToUserContent(
  content: KodaXMessage['content'],
  nudge: string,
): KodaXMessage['content'] {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? `${content}\n\n${nudge}` : nudge;
  }
  return [...content, { type: 'text', text: nudge }];
}

/**
 * Does a `user` turn carry real user text (vs. only tool_result blocks)? A
 * tool_results-only turn renders no transcript bubble and is not a user
 * REQUEST, so the merged retry nudge can be marked `_synthetic` (hidden on
 * restore + skipped by the sidecar gate) exactly like the old discrete nudge.
 * A turn with real text (e.g. the initial prompt) must stay visible.
 */
function userTurnHasText(content: KodaXMessage['content']): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some(
    (block) => (block as { type?: string; text?: string }).type === 'text'
      && ((block as { text?: string }).text ?? '').trim().length > 0,
  );
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
    // Popping the incomplete assistant turn leaves a `user` turn last (the
    // prior round's tool_results, or the initial prompt). Pushing a fresh `user`
    // here would create a user->user pair that Anthropic (and strict gateways)
    // 400 on — the same alternation hazard the ADR-045 maxed_out repair guards.
    // The v0.7.58 salvage guard routes more turns here, so merge the retry nudge
    // into the preceding user turn instead of appending a second one.
    const retryPrompt = buildRetryPrompt(incomplete, nextCount);
    const prevIndex = input.messages.length - 1;
    const prev = prevIndex >= 0 ? input.messages[prevIndex] : undefined;
    if (prev && prev.role === 'user') {
      // Mark the merged turn `_synthetic` ONLY when the preceding turn carries no
      // real user text (a pure tool_results turn) — that keeps the nudge hidden
      // on session restore + skipped by the sidecar "last real user" gate, just
      // like the old discrete `_synthetic` nudge. When the preceding turn is a
      // real message (e.g. the initial prompt), it must stay visible, so its
      // existing (non-synthetic) flag is preserved.
      const hideNudge = !userTurnHasText(prev.content);
      input.messages[prevIndex] = {
        ...prev,
        content: appendTextToUserContent(prev.content, retryPrompt),
        ...(hideNudge ? { _synthetic: true } : {}),
      };
    } else {
      input.messages.push({ role: 'user', content: retryPrompt, _synthetic: true });
    }
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
  // Track the cause so the synthesized error result tells the model the truth:
  // a salvaged/truncated payload needs a SHORTER, complete, valid response —
  // not more params. Reuses the same untrusted-salvage rule as the gate.
  const salvageIds = new Set<string>();
  for (const tc of input.toolBlocks) {
    if (isUntrustedSalvage(tc)) {
      incompleteIds.add(tc.id);
      salvageIds.add(tc.id);
      continue;
    }
    const required = getRequiredToolParams(tc.name);
    const inputObj = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (inputObj[param] === undefined || inputObj[param] === null || inputObj[param] === '') {
        incompleteIds.add(tc.id);
        break;
      }
    }
  }

  // Synthesize a tool_result for every VISIBLE tool_use in this turn — not only
  // the incomplete ones. A complete sibling sharing a turn with an incomplete/
  // salvaged block would otherwise be left unanswered: the next serialize drops
  // it as an orphan tool_use (repairToolCallHistory), silently losing a valid
  // call the model intended to make. Giving it an explicit "skipped — re-issue"
  // result keeps the wire valid AND tells the model to re-send it.
  //
  // ONLY visible tools: invisible/managed tools (e.g. emit_managed_protocol,
  // todo_*) are never written to the assistant wire history (run-substrate uses
  // `visibleToolBlocks`), so synthesizing a tool_result for them would create an
  // orphan tool_result with no matching tool_use — exactly what the normal path
  // (`applyPostToolProcessing`) avoids by gating on `isVisibleToolName`.
  const errorResults: KodaXToolResultBlock[] = [];
  for (const tc of input.toolBlocks) {
    if (!isVisibleToolName(tc.name)) continue;
    const errorMsg = incompleteIds.has(tc.id)
      ? (salvageIds.has(tc.id)
        ? `[Tool Error] ${tc.name}: Skipped — input was truncated or could not be parsed as valid JSON after ${KODAX_MAX_INCOMPLETE_RETRIES} retries. Re-send a shorter, complete tool call with valid arguments (e.g. write structure first, fill in with smaller edits).`
        : `[Tool Error] ${tc.name}: Skipped due to missing required parameters after ${KODAX_MAX_INCOMPLETE_RETRIES} retries`)
      : `[Tool Error] ${tc.name}: Skipped — a sibling tool call in the same turn was incomplete/truncated, so this turn was abandoned. Re-issue this call if it is still needed.`;
    await input.emitActiveExtensionEvent('tool:result', {
      id: tc.id,
      name: tc.name,
      content: errorMsg,
    });
    const toolResult = createToolResultBlock(tc.id, errorMsg);
    input.events.onToolResult?.(
      { id: tc.id, name: tc.name, content: errorMsg, toolResult },
      createToolEventMeta(input.events, tc.id),
    );
    errorResults.push(toolResult);
  }
  if (errorResults.length === 0) {
    // Hidden-only turn (e.g. the incomplete tool was an invisible todo_update /
    // managed-protocol call): there is no visible tool_use to pair a result
    // with, so an empty user message would be dropped by the OpenAI serializer
    // or become a meaningless wire '...' on Anthropic — neither gives the model
    // a recovery signal. Push a synthetic text nudge instead (neutral wording:
    // the cap reset means a re-issue would get fresh retries, so don't force it).
    input.messages.push({
      role: 'user',
      content: `Your previous tool call was incomplete or truncated and was skipped after ${KODAX_MAX_INCOMPLETE_RETRIES} retries. Continue without it, or re-issue it with complete, valid arguments.`,
      _synthetic: true,
    });
  } else {
    input.messages.push({ role: 'user', content: errorResults });
  }
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
