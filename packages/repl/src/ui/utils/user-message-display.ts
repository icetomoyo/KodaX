/**
 * Layer 3 render-time hard cap — pure helper used by the three user-message
 * renderer call-sites (MessageList, transcript-layout, prompt-surface-layout).
 *
 * Design: see docs/KNOWN_ISSUES.md Issue 121, specifically the Claude Code
 * `UserPromptMessage.tsx` comment:
 *
 *   "Piping large files via stdin (e.g. `cat 11k-line-file | claude`) creates
 *    a single user message whose <Text> node the fullscreen Ink renderer must
 *    wrap/output on every frame, causing 500ms+ keystroke latency."
 *
 * Even with Layer 1 (paste placeholder) and Layer 2 (auto-truncate), a long
 * text can still reach the renderer (stdin pipe, legacy terminals without
 * bracketed paste, non-interactive prompt injection). This cap is the
 * always-on safety net.
 *
 * Behavior: keeps head + tail, inserts `… +N lines …` summary. Head + tail
 * because `{ cat file; echo prompt; } | kodax` puts the user's actual
 * question at the end — we must preserve both ends.
 *
 * Kept in its own module so FEATURE_057 (Claude-Aligned TUI Substrate
 * Refactor, v0.7.30 InProgress) can move the renderer surface without
 * dragging behaviour decisions with it.
 */

export interface TruncateUserMessageOptions {
  maxChars?: number;
  headChars?: number;
  tailChars?: number;
}

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_HEAD_CHARS = 2_500;
const DEFAULT_TAIL_CHARS = 2_500;

function countNewlines(text: string, limit: number = text.length): number {
  let count = 0;
  const upper = Math.min(limit, text.length);
  for (let i = 0; i < upper; i++) {
    if (text.charCodeAt(i) === 10 /* '\n' */) count += 1;
  }
  return count;
}

/**
 * Apply the head+tail cap. Returns the original `text` unchanged when below
 * threshold — safe to call for every render without extra guard logic at
 * the call sites.
 */
export function truncateUserMessageForDisplay(
  text: string,
  opts: TruncateUserMessageOptions = {},
): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const headChars = opts.headChars ?? DEFAULT_HEAD_CHARS;
  const tailChars = opts.tailChars ?? DEFAULT_TAIL_CHARS;

  if (text.length <= maxChars) return text;

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const totalLines = countNewlines(text);
  const headLines = countNewlines(head);
  const tailLines = countNewlines(tail);
  const hiddenLines = Math.max(0, totalLines - headLines - tailLines);

  return `${head}\n… +${hiddenLines} lines …\n${tail}`;
}
