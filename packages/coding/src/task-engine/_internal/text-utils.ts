/**
 * FEATURE_079 — Task Engine Phase 1 Pure Extraction (Slice 3)
 *
 * Pure text / message utilities extracted from task-engine.ts. Zero-behavior-change
 * move: these are the same functions previously defined as module-private at the
 * top of task-engine.ts. They share no state with each other; each is a pure
 * function of its inputs.
 *
 * Not moved in Slice 3 (reserved for later):
 * - sanitizeManagedUserFacingText / sanitizeManagedStreamingText /
 *   sanitizeEvaluatorPublicAnswer — these depend on MANAGED_CONTROL_PLANE_MARKERS
 *   and MANAGED_FENCE_NAMES, which depend on block-name constants still co-located
 *   with the protocol parse helpers. They move together in Slice 4 (protocol parse)
 *   to keep one coherent "managed-output sanitation" unit.
 * - isManagedFencePrefix / findIncompleteManagedFenceIndex — same reason as above;
 *   coupled to MANAGED_FENCE_NAMES.
 */

import type { KodaXResult } from '../../types.js';

/**
 * Truncate `value` to at most `maxLength` characters, appending "..." when
 * truncation occurs. Characters removed by the ellipsis are counted against
 * `maxLength` (i.e. the output length is never larger than `maxLength`).
 */
export function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

/**
 * Split a comma-separated tool list into a trimmed, empty-filtered array.
 * Returns `[]` for `undefined` / empty input. Used when parsing CLI/env
 * `--allowed-tools foo,bar,baz` style inputs and equivalent LLM-provided lists.
 */
export function splitAllowedToolList(value: string | undefined): string[] {
  return value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    ?? [];
}

/**
 * Escape a string so it can be embedded as a literal inside a RegExp.
 * Matches the set of metacharacters `. * + ? ^ $ { } ( ) | [ ] \`.
 */
export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Heuristic: does the path look like documentation?
 * Returns true for common doc file extensions, anything under `/docs/` or `/doc/`,
 * and root-level doc filenames like README/CHANGELOG/LICENSE/CONTRIBUTING/etc.
 * Case-insensitive.
 */
export function isDocsLikePath(value: string): boolean {
  const p = value.trim().toLowerCase();
  if (!p) return false;
  if (/\.(md|mdx|markdown|txt|rst|adoc)$/.test(p)) return true;
  if (/(^|\/)docs?\//.test(p)) return true;
  if (/(^|\/)(changelog|readme|contributing|license|authors|notice)(\.|$|\/)/i.test(p)) return true;
  return false;
}

/**
 * Extract the last assistant-visible text from a (partial) KodaXResult.
 * Prefers `lastText` if present; otherwise concatenates text parts from the
 * last message's content. Returns '' when no text is available.
 */
export function extractMessageText(result: Partial<KodaXResult> | undefined): string {
  if (!result) {
    return '';
  }

  if (typeof result.lastText === 'string' && result.lastText.trim()) {
    return result.lastText;
  }

  const lastMessage = result.messages?.[result.messages.length - 1];
  if (!lastMessage) {
    return '';
  }

  if (typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }

  return lastMessage.content
    .map((part) => ('text' in part ? part.text : '') || '')
    .join('');
}

/**
 * Return a new messages array whose last assistant message has its `content`
 * replaced with `text`. If there is no assistant message, one is appended.
 * If the array is empty, a single `{ role: 'assistant', content: text }` is
 * returned. Never mutates the input.
 */
export function replaceLastAssistantMessage(
  messages: KodaXResult['messages'],
  text: string,
): KodaXResult['messages'] {
  if (messages.length === 0) {
    return [{ role: 'assistant', content: text }];
  }

  const nextMessages = [...messages];
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    nextMessages[index] = {
      ...message,
      content: text,
    };
    return nextMessages;
  }

  nextMessages.push({ role: 'assistant', content: text });
  return nextMessages;
}
