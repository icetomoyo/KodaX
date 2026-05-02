/**
 * Transcript stripping for the auto-mode classifier — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * The classifier sees a SUBSET of the main session's transcript:
 *
 *   - user messages (text and tool_result blocks)         KEEP
 *   - assistant tool_use blocks (factual record)          KEEP
 *   - assistant text + thinking + redacted_thinking       DROP
 *
 * Why drop assistant reasoning:
 *   1. Prompt-injection defense — the main agent may have absorbed
 *      instructions from a poisoned tool_result; its reasoning could
 *      then propagate that injection to the classifier.
 *   2. Noise reduction — assistant prose dilutes the signal the
 *      classifier needs (user intent + actual tool calls).
 *   3. Cost — main-session reasoning can be tens of KB; classifier
 *      input should stay in the few-KB range.
 *
 * Two size budgets:
 *   - maxToolResultBytes (default 2KB) — per-tool_result content cap
 *   - maxTranscriptBytes (default 8KB) — total serialized size cap;
 *     drops middle messages first, preserves first user message
 *     (original intent) and recent tail.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolResultBlock,
  KodaXToolUseBlock,
} from '@kodax/ai';

export interface StripOptions {
  readonly maxToolResultBytes?: number;
  readonly maxTranscriptBytes?: number;
}

const DEFAULT_TOOL_RESULT_BYTES = 2 * 1024;
const DEFAULT_TRANSCRIPT_BYTES = 8 * 1024;
const TRUNCATION_SUFFIX = '\n…[truncated]…';

export function stripAssistantText(
  messages: readonly KodaXMessage[],
  opts: StripOptions = {},
): KodaXMessage[] {
  const maxToolResultBytes = opts.maxToolResultBytes ?? DEFAULT_TOOL_RESULT_BYTES;
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? DEFAULT_TRANSCRIPT_BYTES;

  // Pass 1: per-message stripping
  const stripped: KodaXMessage[] = [];
  for (const msg of messages) {
    const result = stripMessage(msg, maxToolResultBytes);
    if (result !== null) stripped.push(result);
  }

  // Pass 2: overall size cap (preserve first user message + recent tail)
  return enforceTotalBudget(stripped, maxTranscriptBytes);
}

function stripMessage(msg: KodaXMessage, maxToolResultBytes: number): KodaXMessage | null {
  if (msg.role === 'user' || msg.role === 'system') {
    if (typeof msg.content === 'string') {
      return msg;
    }
    // user message with block array — typically tool_result blocks. Truncate them.
    const blocks: KodaXContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const truncated = truncateToolResult(block, maxToolResultBytes);
        blocks.push(truncated);
      } else {
        blocks.push(block);
      }
    }
    return { ...msg, content: blocks };
  }

  // role === 'assistant' — keep only tool_use blocks
  if (typeof msg.content === 'string') {
    // Pure-text assistant message: drop entirely.
    return null;
  }
  const keep: KodaXToolUseBlock[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      keep.push(block);
    }
    // Drop: text, thinking, redacted_thinking, image (assistants don't emit
    // images today, but if they ever do, those don't help the classifier)
  }
  if (keep.length === 0) return null;
  return { ...msg, content: keep };
}

function truncateToolResult(
  block: KodaXToolResultBlock,
  maxBytes: number,
): KodaXToolResultBlock {
  if (block.content.length <= maxBytes) return block;
  const truncated = block.content.slice(0, maxBytes) + TRUNCATION_SUFFIX;
  return { ...block, content: truncated };
}

function enforceTotalBudget(
  messages: readonly KodaXMessage[],
  maxBytes: number,
): KodaXMessage[] {
  if (messages.length === 0) return [];
  const sized = messages.map((m) => ({ msg: m, bytes: JSON.stringify(m).length }));
  const total = sized.reduce((sum, s) => sum + s.bytes, 0);
  if (total <= maxBytes) return [...messages];

  // Identify the first user message — always preserve it as the original intent.
  const firstUserIdx = sized.findIndex((s) => s.msg.role === 'user');
  if (firstUserIdx === -1) {
    // No user messages — keep last few until budget fits
    return takeTail(sized, maxBytes);
  }

  const head = sized[firstUserIdx]!;
  let remaining = maxBytes - head.bytes;
  if (remaining < 0) remaining = 0;

  // Take the recent tail that fits in the remaining budget
  const after = sized.slice(firstUserIdx + 1);
  const tail: typeof sized = [];
  for (let i = after.length - 1; i >= 0; i -= 1) {
    const s = after[i]!;
    if (s.bytes > remaining) break;
    tail.unshift(s);
    remaining -= s.bytes;
  }

  return [head.msg, ...tail.map((t) => t.msg)];
}

function takeTail(
  sized: ReadonlyArray<{ msg: KodaXMessage; bytes: number }>,
  maxBytes: number,
): KodaXMessage[] {
  const out: KodaXMessage[] = [];
  let remaining = maxBytes;
  for (let i = sized.length - 1; i >= 0; i -= 1) {
    const s = sized[i]!;
    if (s.bytes > remaining) break;
    out.unshift(s.msg);
    remaining -= s.bytes;
  }
  return out;
}
