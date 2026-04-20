/**
 * FEATURE_076 round-boundary helpers.
 *
 * Pure helpers for reshaping `runManagedTask`'s result into a clean
 * user-facing {user, assistant} dialog at the round exit.
 *
 * See docs/features/v0.7.25.md#feature_076 for the full design.
 */

import type {
  KodaXInputArtifact,
  KodaXMessage,
  KodaXOptions,
  KodaXResult,
  KodaXTaskStatus,
} from '../../types.js';
import {
  buildPromptMessageContent,
  extractComparableUserMessageText,
} from '../../input-artifacts.js';
import { extractArtifactLedger } from '../../messages.js';
import { recomputeContextTokenSnapshot } from '../../token-accounting.js';
import { extractMessageText } from './text-utils.js';

/**
 * Q1 (FEATURE_076): decide whether a result represents an unconverged task
 * that has not produced a real user-facing answer.
 *
 * Uses the existing structured `KodaXTaskStatus` field — no new field on
 * `KodaXResult`, no string matching on placeholder summaries. All three
 * placeholder summary construction sites in task-engine.ts (~2163, 2244,
 * 2343) simultaneously set `verdict.status = 'running'`, and `lastText`
 * is derived from `verdict.summary` at task-engine.ts:~5326.
 *
 * Per-status policy:
 *   - 'running'   → unconverged (placeholder, not a real answer)
 *   - 'planned'   → unconverged (defensive; planning stage, should not
 *                   reach runManagedTask exit)
 *   - 'completed' → converged  (has a real answer)
 *   - 'blocked'   → converged  (blocked reason IS a valid user answer,
 *                   e.g. "需要 OAuth 授权")
 *   - 'failed'    → converged  (error message IS a valid user answer)
 *   - undefined   → converged  (SA fast-path has no managedTask field;
 *                   treat as "the agent produced whatever it produced,
 *                   no unconverged signal")
 */
export function isUnconvergedVerdict(status?: KodaXTaskStatus): boolean {
  return status === 'running' || status === 'planned';
}

/**
 * Extract the user-facing final assistant text from a run result.
 *
 * Priority:
 *   1. `result.lastText` (all paths fill this with the user-facing answer)
 *   2. last message's text content (fallback for corner cases)
 *   3. empty string
 *
 * Delegates to `extractMessageText` which already implements this priority.
 */
export function extractFinalAssistantText(
  result: KodaXResult | undefined,
): string {
  return extractMessageText(result);
}

/**
 * Build the clean user-facing dialog for a round exit: preserved history +
 * this round's {user, assistant}.
 *
 * Dedup: if `initial` already ends with a user message whose comparable text
 * matches `prompt`, only append the assistant turn — this is the CLI REPL
 * path where the user prompt is pushed to `context.messages` before
 * `runManagedTask` is called, and we do not want to duplicate the turn.
 *
 * Multi-modal: `inputArtifacts` (image attachments, etc.) are attached to
 * the new user message via `buildPromptMessageContent`. Text-only prompts
 * remain strings.
 *
 * Never mutates `initial`.
 */
export function buildUserFacingMessages(
  initial: readonly KodaXMessage[],
  prompt: string,
  assistantText: string,
  inputArtifacts?: readonly KodaXInputArtifact[],
): KodaXMessage[] {
  const lastMsg = initial[initial.length - 1];
  const alreadyHasPrompt =
    lastMsg?.role === 'user'
    && extractComparableUserMessageText(lastMsg) === prompt;

  const assistantMsg: KodaXMessage = {
    role: 'assistant',
    content: assistantText,
  };

  if (alreadyHasPrompt) {
    return [...initial, assistantMsg];
  }

  const userMsg: KodaXMessage = {
    role: 'user',
    content: buildPromptMessageContent(prompt, inputArtifacts),
  };

  return [...initial, userMsg, assistantMsg];
}

/**
 * FEATURE_076 round-boundary reshape.
 *
 * Converts the raw `runManagedTask` result (which may contain worker
 * execution trace, Scout role-prompt wrapping, Evaluator isolated session,
 * etc.) into a clean user-facing `{user, assistant}` dialog.
 *
 * Debug-preserve cases — return the original result unchanged:
 *   - `result.messages` is undefined
 *   - `verdict.status` is `'running'` or `'planned'` (Q1)
 *   - `result.interrupted && !finalText`
 *
 * Reshape behavior otherwise:
 *   1. Pre-extract artifact ledger from raw messages (tool_result blocks
 *      disappear after reshape)
 *   2. Build clean dialog via `buildUserFacingMessages`
 *   3. Full recompute of `contextTokenSnapshot` (Q2)
 *   4. Return new result with `messages` / `artifactLedger` /
 *      `contextTokenSnapshot` replaced; all other fields passthrough
 *      (success / signal / sessionId / lastText / managedTask / etc.)
 */
export function reshapeToUserConversation(
  result: KodaXResult,
  options: KodaXOptions,
  prompt: string,
): KodaXResult {
  if (!result.messages) {
    return result;
  }

  const finalText = extractFinalAssistantText(result);

  if (isUnconvergedVerdict(result.managedTask?.verdict?.status)) {
    return result;
  }
  if (result.interrupted && !finalText) {
    return result;
  }

  const originalInitialMessages = options.session?.initialMessages ?? [];
  const inputArtifacts = options.context?.inputArtifacts;

  const preservedArtifactLedger =
    result.artifactLedger ?? extractArtifactLedger(result.messages);

  const cleanMessages = buildUserFacingMessages(
    originalInitialMessages,
    prompt,
    finalText,
    inputArtifacts,
  );

  const recomputedSnapshot = result.contextTokenSnapshot
    ? recomputeContextTokenSnapshot(cleanMessages, result.contextTokenSnapshot)
    : undefined;

  return {
    ...result,
    messages: cleanMessages,
    artifactLedger: preservedArtifactLedger,
    contextTokenSnapshot: recomputedSnapshot,
  };
}

/**
 * FEATURE_076 Q4: normalize `messages` loaded from a pre-v0.7.25 session.
 *
 * Pre-v0.7.25 sessions persisted `context.messages` in worker-execution-
 * trace shape (Scout role-prompt-wrapped user, Evaluator isolated session
 * ending with a verdict block, etc.). On session load, detect trailing
 * role-prompt-shaped {user, assistant} pairs and drop them — keeping any
 * preceding clean user dialog intact. The next round's reshape will fill
 * in a clean {user, assistant} pair for the new prompt.
 *
 * Detection anchors on the Scout / Planner / Generator / Evaluator role
 * prompt opening line. The phrase must appear at the start of a user
 * message, which avoids matching casual "You are..." text inside normal
 * user questions.
 *
 * Never mutates the input array.
 */
export function normalizeLoadedSessionMessages(
  messages: readonly KodaXMessage[],
): KodaXMessage[] {
  let end = messages.length;

  while (end >= 2) {
    const user = messages[end - 2];
    const assistant = messages[end - 1];
    if (
      user.role === 'user'
      && assistant.role === 'assistant'
      && isRolePromptShapedUser(user)
    ) {
      end -= 2;
      continue;
    }
    break;
  }

  return messages.slice(0, end);
}

const ROLE_PROMPT_PREFIX_REGEX =
  /^\s*You are the (Scout|Planner|Generator|Evaluator) role\b/;

function isRolePromptShapedUser(message: KodaXMessage): boolean {
  if (message.role !== 'user') return false;

  const text =
    typeof message.content === 'string'
      ? message.content
      : extractLeadingTextBlock(message.content);

  return ROLE_PROMPT_PREFIX_REGEX.test(text);
}

function extractLeadingTextBlock(content: readonly unknown[]): string {
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type === 'text' && typeof first.text === 'string') {
    return first.text;
  }
  return '';
}
