/**
 * Managed-task Scout suspicious-completion detection.
 *
 * Ported from the legacy `task-engine.ts` helpers (4601 – 4660, 4844 – 4857)
 * that Shard 6d-b removed along with the rest of the AMA state machine.
 *
 * The harness observes Scout's completion and flags it as "uncertain" when
 * the model silently stopped without an explicit finish signal, when it
 * was flagged as a mutation task yet produced zero mutations, or when
 * budget was exhausted. Those cases are surfaced to the caller via
 * `options.events.onScoutSuspiciousCompletion` so the REPL can warn the
 * user to double-check the result.
 *
 * Scope for the Runner-driven path:
 *   - `MUTATION_PRIMARY_TASKS` / completion-word dictionaries are imported
 *     1:1 so the detection vocabulary matches legacy.
 *   - `detectScoutSuspiciousSignals` operates on the Runner-driven
 *     artefacts (`messages`, `managedProtocolPayload.scout`, mutation
 *     tracker, budget controller) instead of the legacy plan object +
 *     routing decision. When Scout declared `mutation_intent: open-scope`
 *     but emitted no tracked mutations, that mirrors the legacy
 *     `MUTATION_PRIMARY_TASKS` gate.
 */

import type { KodaXMessage, KodaXResult, KodaXScoutSuspiciousSignal, ManagedMutationTracker } from '../../../types.js';
import { checkPromiseSignal } from '../../../agent.js';
import type { ScoutMutationIntent } from './tool-policy.js';

export const MUTATION_PRIMARY_TASKS: ReadonlySet<string> = new Set([
  'edit',
  'bugfix',
  'refactor',
  'feature',
]);

const COMPLETION_WORDS_EN = /\b(done|completed|finished|fixed|merged|created|updated|added|removed|resolved|implemented|wrote|saved|no issues|all good|looks? fine)\b/i;
const COMPLETION_WORDS_ZH = /(完成|搞定|做好|修好|完毕|写好|改好|处理完|更新完|已完成|合并完成|没有问题|没发现|未发现)/;
const SUBSTANTIVE_ANSWER_MIN_LENGTH = 150;
const SUBSTANTIVE_ANSWER_STRUCTURE = /```|\n\s*[\-*]\s|\n\s*\d+\.\s|\n#{1,4}\s/;

export const SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT = 200;

function messageHasToolUse(msg: KodaXMessage): boolean {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return false;
  return msg.content.some((block) => {
    return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use';
  });
}

export function hadPriorAssistantToolCall(messages: readonly KodaXMessage[]): boolean {
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  if (assistantMsgs.length <= 1) return false;
  return assistantMsgs.slice(0, -1).some(messageHasToolUse);
}

export function lastAssistantHadNoTool(messages: readonly KodaXMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) return false;
  return !messageHasToolUse(last);
}

export function looksLikeCompletionText(
  text: string | undefined,
  mutationIntent: ScoutMutationIntent | undefined,
): boolean {
  if (!text) return false;
  if (COMPLETION_WORDS_EN.test(text) || COMPLETION_WORDS_ZH.test(text)) return true;
  // Structure fallback: a long, structured final answer (code blocks, bullet/
  // numbered lists, section headers) reads as a completion even without
  // explicit completion words. Skip this fallback when the harness inferred
  // open-scope mutation intent — those tasks can emit structured mid-progress
  // text that looks identical to a completion summary. Mirrors the
  // `MUTATION_PRIMARY_TASKS` gate in legacy.
  const isMutationTask = mutationIntent === 'open';
  if (!isMutationTask && text.length >= SUBSTANTIVE_ANSWER_MIN_LENGTH && SUBSTANTIVE_ANSWER_STRUCTURE.test(text)) {
    return true;
  }
  return false;
}

export interface ScoutSuspiciousDetectionInput {
  readonly messages: readonly KodaXMessage[];
  readonly lastText: string | undefined;
  readonly hasScoutPayload: boolean;
  readonly scoutMutationIntent: ScoutMutationIntent | undefined;
  readonly mutationTracker: ManagedMutationTracker | undefined;
  readonly budgetExhausted: boolean;
  readonly limitReached?: boolean;
}

/**
 * Detect suspicious-completion signals for a Scout-only H0 run.
 *
 * Three signal categories, each matches a discrete failure mode the
 * legacy harness already guarded:
 *
 *   S1 `mutation-expected-but-none` — Scout said the task was open-scope
 *       (mutation task) yet finished with zero tracked mutations and no
 *       formal Scout payload. Writes done via `bash python -c ...`
 *       bypass the tracker, so an empty tracker on a mutation task is a
 *       strong smell.
 *
 *   S2 `budget-exhausted` — the Runner budget was fully consumed, which
 *       usually means the model was thrashing instead of finishing.
 *
 *   S5 `no-formal-completion` — the session had tool_use earlier, the
 *       last assistant turn had no tool_use, and the last text neither
 *       carries a completion signal nor reads as a completion statement.
 *       Catches the classic "LLM trailed off mid-troubleshoot without
 *       noticing" failure.
 */
export function detectScoutSuspiciousSignals(
  input: ScoutSuspiciousDetectionInput,
): KodaXScoutSuspiciousSignal[] {
  const signals: KodaXScoutSuspiciousSignal[] = [];

  const mutationCount = input.mutationTracker?.files.size ?? 0;
  if (
    input.scoutMutationIntent === 'open'
      && mutationCount === 0
      && !input.hasScoutPayload
  ) {
    signals.push('mutation-expected-but-none');
  }

  if (input.budgetExhausted || input.limitReached === true) {
    signals.push('budget-exhausted');
  }

  const [promiseSignal] = checkPromiseSignal(input.lastText ?? '');
  const hasExplicitSignal = input.hasScoutPayload || promiseSignal === 'COMPLETE';
  if (
    !hasExplicitSignal
      && hadPriorAssistantToolCall(input.messages)
      && lastAssistantHadNoTool(input.messages)
      && !looksLikeCompletionText(input.lastText, input.scoutMutationIntent)
  ) {
    signals.push('no-formal-completion');
  }

  return signals;
}
