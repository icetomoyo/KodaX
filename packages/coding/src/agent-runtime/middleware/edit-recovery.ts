/**
 * Edit anchor recovery + write-block middleware — CAP-015
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-015-edit-anchor-recovery--write-block
 *
 * Class 1 (substrate middleware). When an `edit` tool fails because the
 * `old_string` anchor isn't found OR the `EDIT_TOO_LARGE` cap fires, this
 * middleware:
 *
 *   1. **Records failure** in `RuntimeSessionState.editRecoveryAttempts`
 *      (path → attempt count) and `lastToolErrorCode`.
 *   2. **Blocks subsequent `write` to the same path** by adding it to
 *      `RuntimeSessionState.blockedEditWrites`. The permission gate
 *      (CAP-010) consults this set before allowing a `write` call. The
 *      block prevents the model from "giving up and rewriting the whole
 *      file" — anchor failures should retry with smaller / smarter
 *      anchors, not escalate.
 *   3. **Synthesises a recovery user-message** with diagnostic content:
 *      - `EDIT_TOO_LARGE`: tells the model to split into smaller edits.
 *      - `> 2 attempts`: stops auto-recovery, tells the model to choose
 *        a unique anchor from current content and retry with `edit`.
 *      - `≤ 2 attempts`: includes nearby anchor candidates from
 *        `inspectEditFailure` (window 120 lines on attempt 1, 400 on
 *        attempt 2) and instructs the model to retry.
 *
 * The block is cleared by `updateToolOutcomeTracking` after a non-error
 * `edit` or compatible `insert_after_anchor` result for the same path.
 *
 * Migration history: extracted from `agent.ts:902-1032`
 * (`resolveToolTargetPath` + `clearEditRecoveryStateForPath` +
 * `maybeBlockExistingFileWrite` + `buildEditRecoveryUserMessage`) — plus
 * the `RunnableToolCall` type alias from `agent.ts:138-142` — pre-FEATURE_100
 * baseline — during FEATURE_100 P2. The still-resident
 * `updateToolOutcomeTracking` in `agent.ts` imports back the helpers it
 * needs.
 */

import fsSync from 'fs';

import type { KodaXToolExecutionContext } from '../../types.js';
import { inspectEditFailure, parseEditToolError } from '../../tools/index.js';
import { resolveExecutionPath } from '../../runtime-paths.js';
import { emitResilienceDebug } from '../resilience-debug.js';
import type { RuntimeSessionState } from '../runtime-session-state.js';

export type RunnableToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown> | undefined;
};

export function resolveToolTargetPath(
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
): string | undefined {
  const pathValue = toolCall.input?.path;
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    return undefined;
  }
  return resolveExecutionPath(pathValue, ctx);
}

export function clearEditRecoveryStateForPath(
  runtimeSessionState: RuntimeSessionState,
  resolvedPath: string | undefined,
): void {
  if (!resolvedPath) {
    return;
  }
  runtimeSessionState.editRecoveryAttempts.delete(resolvedPath);
  runtimeSessionState.blockedEditWrites.delete(resolvedPath);
}

export function maybeBlockExistingFileWrite(
  toolCall: RunnableToolCall,
  ctx: KodaXToolExecutionContext,
  runtimeSessionState: RuntimeSessionState,
): string | undefined {
  if (toolCall.name !== 'write') {
    return undefined;
  }

  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  if (!resolvedPath || !runtimeSessionState.blockedEditWrites.has(resolvedPath)) {
    return undefined;
  }

  if (!fsSync.existsSync(resolvedPath)) {
    runtimeSessionState.blockedEditWrites.delete(resolvedPath);
    return undefined;
  }

  return `[Tool Error] write: BLOCKED_AFTER_EDIT_FAILURE: Refusing to rewrite existing file ${resolvedPath} while edit anchor recovery is in progress. Retry with edit using unique existing text; use an edits array for multiple replacements.`;
}

export async function buildEditRecoveryUserMessage(
  toolCall: RunnableToolCall,
  toolResult: string,
  runtimeSessionState: RuntimeSessionState,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  const code = parseEditToolError(toolResult);
  if (!code) {
    return undefined;
  }

  const pathValue = typeof toolCall.input?.path === 'string' ? toolCall.input.path : undefined;
  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  if (!pathValue || !resolvedPath) {
    return undefined;
  }

  runtimeSessionState.blockedEditWrites.add(resolvedPath);
  const attempt = (runtimeSessionState.editRecoveryAttempts.get(resolvedPath) ?? 0) + 1;
  runtimeSessionState.editRecoveryAttempts.set(resolvedPath, attempt);
  runtimeSessionState.lastToolErrorCode = code;

  if (code === 'EDIT_TOO_LARGE') {
    emitResilienceDebug('[edit:recovery]', {
      code,
      path: resolvedPath,
      attempt,
      action: 'split-edit',
    });
    return [
      `The previous edit for ${resolvedPath} failed with ${code}.`,
      'Do not use write to replace the existing file.',
      'Split the change into smaller replacements in the edits array of one edit call; later anchors must match the result of earlier edits.',
    ].join('\n');
  }

  if (attempt > 2) {
    emitResilienceDebug('[edit:recovery]', {
      code,
      path: resolvedPath,
      attempt,
      action: 'stop-auto-recovery',
    });
    return [
      `The previous edit for ${resolvedPath} failed with ${code}, and automatic anchor recovery is exhausted.`,
      'Do not escalate to a whole-file write.',
      'Choose a unique old_string from current file content and retry with edit; preserve the full anchor text when appending.',
    ].join('\n');
  }

  const windowLines = attempt === 1 ? 120 : 400;
  const edits = toolCall.input?.edits;
  const firstEdit = Array.isArray(edits) && edits.length === 1 ? edits[0] : undefined;
  const oldString = toolCall.input?.old_string
    ?? (firstEdit && typeof firstEdit === 'object' && 'old_string' in firstEdit ? firstEdit.old_string : '');
  const diagnostic = await inspectEditFailure(pathValue, String(oldString ?? ''), ctx, windowLines);
  const primary = diagnostic.candidates[0];
  const alternates = diagnostic.candidates.slice(1, 3);

  emitResilienceDebug('[edit:recovery]', {
    code,
    path: resolvedPath,
    attempt,
    windowLines,
    candidateCount: diagnostic.candidates.length,
  });

  const lines: string[] = [
    `The previous edit for ${resolvedPath} failed with ${code}.`,
    'Do not use write to rewrite the existing file.',
    'Retry with edit using a smaller unique old_string.',
    'For a section append, replace the complete unique heading line with that line plus the new content, preserving line breaks.',
  ];

  if (primary) {
    lines.push('');
    lines.push(`Best nearby anchor window (${primary.startLine}-${primary.endLine}):`);
    lines.push('```text');
    lines.push(primary.excerpt);
    lines.push('```');
  }

  if (alternates.length > 0) {
    lines.push('');
    lines.push('Other nearby candidate anchors:');
    for (const candidate of alternates) {
      lines.push(`- lines ${candidate.startLine}-${candidate.endLine}: ${candidate.preview}`);
    }
  }

  return lines.join('\n');
}
