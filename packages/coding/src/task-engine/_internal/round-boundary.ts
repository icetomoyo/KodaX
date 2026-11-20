/**
 * FEATURE_076 round-boundary helpers.
 *
 * Pure helpers for reshaping `runManagedTask`'s result into a clean
 * user-facing {user, assistant} dialog at the round exit.
 *
 * See docs/features/v0.7.25.md#feature_076 for the full design.
 */

import { COMPACTION_SUMMARY_PREFIX } from '@kodax-ai/agent';
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
 *   - undefined   → converged  (direct-engine result has no managedTask field;
 *                   treat as "the agent produced whatever it produced,
 *                   no unconverged signal")
 */
export function isUnconvergedVerdict(status?: KodaXTaskStatus): boolean {
  return status === 'running' || status === 'planned';
}

function isPlaceholderOnlyAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || trimmed === '...';
}

/**
 * Extract the user-facing final assistant text from a run result.
 *
 * Priority:
 *   1. `result.lastText` (all paths fill this with the user-facing answer)
 *   2. last message's text content (fallback for corner cases)
 *   3. empty string
 *
 * A bare legacy `'...'` or empty marker is not a real answer. Provider
 * serializers may synthesize `'...'` at the wire boundary, but clean
 * user-facing conversation history must keep that as empty text.
 */
export function extractFinalAssistantText(
  result: KodaXResult | undefined,
): string {
  const text = extractMessageText(result);
  return isPlaceholderOnlyAssistantText(text) ? '' : text;
}

function isCompactionCheckpointMessage(message: KodaXMessage | undefined): boolean {
  if (!message) return false;
  if (message._source === 'compaction-checkpoint') return true;
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
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
 * FEATURE_076 round-boundary reshape (v0.7.40 cache-friendly revision).
 *
 * Converts the raw `runManagedTask` result into a transcript suitable
 * for the next round's LLM input, dropping two specific sources of
 * cross-round pollution while preserving everything that the next
 * round's worker would otherwise have to re-derive:
 *
 *   - **Drops**: the leading stale role-prompt system message (Runner.run
 *     leaves the last-active agent's role prompt at `transcript[0]`;
 *     round 2's entry agent will inject its own at position 0, so
 *     keeping the previous one creates two conflicting system
 *     instructions back-to-back). CompactionSummary system messages
 *     (recognised by the `COMPACTION_SUMMARY_PREFIX` literal) are
 *     preserved.
 *
 *   - **Drops**: V1-legacy role-prompt-wrapped trailing
 *     `{user, assistant}` pairs ("You are the Evaluator role..."
 *     phrased as a user message). V2 AMA never produces these; the
 *     `normalizeLoadedSessionMessages` filter still runs as a defensive
 *     pass so a V1 session entering a V2 process gets cleaned up in
 *     the same round it lands.
 *
 *   - **Preserves**: `tool_use` / `tool_result` chains, intermediate
 *     assistant text, prior-round dialog. The next round's LLM sees
 *     what files were read, what edits were made, what bash commands
 *     ran — eliminating cross-round file re-reads and keeping the
 *     provider's prompt-cache prefix continuous across rounds. This
 *     is the v0.7.40 revision of FEATURE_076; the prior behaviour
 *     (replace everything with a synthetic `[user, assistant]` pair)
 *     was correct for the cross-round-coherence bug it targeted but
 *     simultaneously erased structurally useful context.
 *
 *   - **Appends a synthetic user-facing final assistant message** so
 *     the user-visible answer is unambiguous. V2 AMA's last assistant
 *     message is typically an `emit_verdict` tool_use block (no plain
 *     text); the verdict's `user_answer` field is sanitised into
 *     `result.lastText`. Surfacing it as a plain assistant message
 *     keeps both the transcript renderer and round 2's LLM seeing the
 *     same natural-language conclusion. Dedup'd when the transcript
 *     already ends with a matching plain-text assistant message.
 *
 *   - **Appends the round's user prompt** when V1 normalisation
 *     stripped it (V2 sessions retain it through their natural
 *     `runnerInput` shape, so the append is usually skipped). This
 *     preserves the prior contract that the round's user prompt is
 *     observable in `context.messages` after reshape.
 *
 * Debug-preserve cases — return the original result unchanged:
 *   - `result.messages` is undefined
 *   - `verdict.status` is `'running'` or `'planned'` (Q1)
 *   - `result.interrupted && !finalText`
 *
 * See `docs/features/v0.7.40.md` for the cache/re-read regression
 * motivation and `docs/features/v0.7.25.md#feature_076` for the
 * original cross-round-coherence motivation that this revision
 * preserves.
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

  const inputArtifacts = options.context?.inputArtifacts;

  const preservedArtifactLedger =
    result.artifactLedger ?? extractArtifactLedger(result.messages);

  const preservedMessages = preserveTranscriptForRoundExit(
    result.messages,
    prompt,
    finalText,
    inputArtifacts,
  );

  const recomputedSnapshot = result.contextTokenSnapshot
    ? recomputeContextTokenSnapshot(preservedMessages, result.contextTokenSnapshot)
    : undefined;

  return {
    ...result,
    messages: preservedMessages,
    artifactLedger: preservedArtifactLedger,
    contextTokenSnapshot: recomputedSnapshot,
  };
}

/**
 * Round-exit transcript preservation: drop stale role-prompt scaffolding
 * (leading system + V1 user-wrapped tails) while keeping `tool_use` /
 * `tool_result` chains intact so the next round avoids re-reads and
 * keeps prompt-cache prefix continuity. Always terminates with a
 * synthetic plain-text assistant message carrying the round's
 * user-facing answer.
 */
export function preserveTranscriptForRoundExit(
  rawMessages: readonly KodaXMessage[],
  prompt: string,
  finalText: string,
  inputArtifacts?: readonly KodaXInputArtifact[],
): KodaXMessage[] {
  // Step 1: strip stale leading role-prompt system message. Preserve
  // CompactionSummary system messages (they carry condensed history).
  let messages: readonly KodaXMessage[] = rawMessages;
  const first = messages[0];
  if (
    first?.role === 'system'
    && !isCompactionCheckpointMessage(first)
  ) {
    messages = messages.slice(1);
  }

  // Step 2: strip V1-legacy role-prompt-wrapped user-tail. No-op for
  // V2 AMA where role prompts are system-message-shaped.
  messages = normalizeLoadedSessionMessages(messages);

  // Step 3: ensure the transcript carries a user-side signal — either
  // the round's exact prompt or, in long-compacted sessions, the
  // CompactionSummary plus any surviving user message in the
  // protection window. Two skip conditions; otherwise append.
  //
  //   Skip (a): the round's exact prompt is already present. V2 AMA's
  //   `runnerInput` appends it before Runner.run executes, so this is
  //   the normal hit-path.
  //
  //   Skip (b): a compaction checkpoint survives. Current checkpoints
  //   are synthetic user messages (`_source: 'compaction-checkpoint'`),
  //   while older sessions use a system message with the summary prefix.
  //   Both already carry the task intent, so re-appending the prompt at the
  //   tail would only add a `[…work…, user_prompt, asst]` shape that
  //   reads as if the user spoke mid-task.
  //
  // Append otherwise — this ensures the output always has a user
  // message before any trailing assistant, satisfying Anthropic's
  // alternation constraint on the next round's request.
  const hasPromptAlready = messages.some(
    (m) => m.role === 'user' && extractComparableUserMessageText(m) === prompt,
  );

  let shouldAppendPrompt = !hasPromptAlready;
  if (shouldAppendPrompt) {
    const hasUserBoundary = messages.some((message) => message.role === 'user');
    const checkpointCarriesRoundIntent = messages.some((message) => (
      isCompactionCheckpointMessage(message)
      && (message.role === 'user' || hasUserBoundary)
    ));
    if (checkpointCarriesRoundIntent) shouldAppendPrompt = false;
  }

  if (shouldAppendPrompt) {
    messages = [
      ...messages,
      {
        role: 'user',
        content: buildPromptMessageContent(prompt, inputArtifacts),
      },
    ];
  }

  // Step 4: ensure the transcript ends with a plain-text assistant
  // message carrying the sanitised final answer. Three cases:
  //
  //   (a) Last is assistant whose string content already equals
  //       `finalText` — no-op (Worker path with plain-text final reply).
  //
  //   (b) Last is assistant with array content OR a string ≠ finalText
  //       — REPLACE the last message. V2 AMA's terminal assistant is
  //       typically `emit_verdict` / `emit_handoff` tool_use blocks
  //       (KodaX protocol machinery, not user content); the sanitised
  //       answer lives in `result.lastText` (extracted from
  //       `verdict.user_answer`). Replacing serves two ends: (i) we
  //       avoid two consecutive `role: 'assistant'` messages, which
  //       Anthropic's API rejects on the next round's request, and
  //       (ii) we keep KodaX protocol tool_use blocks out of the next
  //       round's worker context (those calls would not be re-issued
  //       and seeing them in transcript could confuse role inference).
  //
  //   (c) Last is user / tool_result-bearing user / empty — APPEND a
  //       synthetic `{assistant: finalText}` so the transcript ends
  //       on assistant. Empty `finalText` still produces this
  //       assistant message to match prior reshape behaviour (the
  //       previous implementation also appended an empty-string asst
  //       in this state).
  const lastMsg = messages[messages.length - 1];
  if (
    lastMsg?.role === 'assistant'
    && typeof lastMsg.content === 'string'
    && lastMsg.content === finalText
  ) {
    // (a) already correctly ended; no-op.
  } else if (lastMsg?.role === 'assistant') {
    // (b) replace.
    messages = [
      ...messages.slice(0, -1),
      { role: 'assistant', content: finalText },
    ];
  } else {
    // (c) append.
    messages = [
      ...messages,
      { role: 'assistant', content: finalText },
    ];
  }

  return [...messages];
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
