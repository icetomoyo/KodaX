/**
 * Shared parser for streamed tool_use input across all provider transports.
 *
 * Why this exists: when a provider hits `stop_reason: max_tokens`
 * (Anthropic) or `finish_reason: length` (OpenAI-compat) during a
 * tool_use turn, the accumulated `arguments` / `input_json_delta`
 * buffer is truncated mid-JSON. Two compat paths previously diverged:
 *
 *   - anthropic.ts: strict → partial-json salvage → {}
 *   - openai.ts:    strict → {} (lost the partial work)
 *
 * Centralising in one helper means the OpenAI path (deepseek-v4,
 * pay-as-you-go kimi/qwen/zhipu, plus any custom provider extending
 * KodaXOpenAICompatProvider) gets the same recovery as Anthropic-compat.
 *
 * Salvage strategy verified by deepseek-v4 bench (flash + pro, 6
 * truncation runs at 800-8000 max_tokens): all real-world truncations
 * land mid-string in the largest field with clean byte boundaries (no
 * mid-multibyte, no mid-`\uXXXX` escape, no lone backslash). partial-json
 * recovers a usable Record in 100% of observed cases.
 */

import { parse as parsePartialJson } from 'partial-json';

/**
 * Parse a tool_use input buffer with three-stage recovery.
 *
 * Stages:
 *   1. strict `JSON.parse` — fast path for the 99% complete case.
 *   2. `partial-json` salvage — closes open strings/brackets and
 *      returns whatever prefix was parseable. Lets the agent loop
 *      surface concrete partial work (e.g. half a `write` payload)
 *      to the model on the next turn instead of pretending the call
 *      had no input.
 *   3. empty `{}` — last-resort fallback for total garbage.
 *
 * Always returns a plain object so the caller can construct a valid
 * `KodaXToolUseBlock` without further type guards.
 */
export function parseToolInputWithSalvage(raw: string | undefined | null): Record<string, unknown> {
  if (!raw) return {};

  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    // fall through
  }

  try {
    const v = parsePartialJson(raw);
    if (process.env.KODAX_DEBUG_TOOL_STREAM) {
      console.warn('[Tool Block Salvaged] partial JSON recovered, rawLength=', raw.length);
    }
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
