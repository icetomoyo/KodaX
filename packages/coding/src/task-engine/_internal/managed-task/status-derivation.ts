/**
 * Final-status / user-facing-text / managed-protocol payload derivation.
 *
 * The Runner-driven loop emits a single `KodaXResult` per managed-task
 * run; these helpers convert the recorder + RunnerResult tail into that
 * shape. Splits cleanly out of the orchestrator because the helpers
 * read only the immutable recorder/result shapes — no closures over
 * mid-run state.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 4060–4129 in
 * the pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — bodies are byte-identical to
 * the previous in-file declarations.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXTextBlock,
} from '@kodax-ai/llm';
import { sanitizeManagedUserFacingText } from './sanitize.js';

export function extractUserFacingText(result: { messages: readonly KodaXMessage[]; output: string }): string {
  const raw = extractUserFacingRaw(result);
  // Strip internal managed control-plane markers and any
  // stray ```kodax-task-*``` fences (complete or truncated) that the LLM
  // might emit in assistant text despite using structured emit tools.
  // Legacy task-engine.ts applied this at 14 call sites; re-added at the
  // single Runner-driven extraction point.
  const sanitized = sanitizeManagedUserFacingText(raw);
  // A bare empty-content placeholder ('...' from legacy pre-fix sessions) is
  // not real user-facing text. New sessions use an empty text block (raw "").
  return sanitized.trim() === '...' ? '' : sanitized;
}

export function extractUserFacingRaw(result: { messages: readonly KodaXMessage[]; output: string }): string {
  if (result.output.trim().length > 0) return result.output;
  const last = result.messages[result.messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as KodaXContentBlock[])
    .filter((b): b is KodaXTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
