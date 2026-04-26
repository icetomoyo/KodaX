/**
 * Tool outcome tracking — CAP-026
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-026-tool-outcome-tracking-successfailure-history
 *
 * Class 1 (substrate middleware). Single side-effect function fired
 * after every tool result settles, BEFORE the post-tool judge (CAP-018)
 * reads `runtimeSessionState.lastToolErrorCode`.
 *
 * Three responsibilities, all writes onto `RuntimeSessionState`:
 *
 *   1. **`lastToolResultBytes`** — UTF-8 byte length of the result
 *      string. Consumed by retry-decision middleware (telemetry +
 *      payload-size budgeting).
 *   2. **`lastToolErrorCode`** — structured error code extracted via
 *      CAP-032 (`extractStructuredToolErrorCode`). Consumed by CAP-018
 *      post-tool judge to decide whether failure evidence is "strong"
 *      enough to trigger a CAP-019 task-reroute.
 *   3. **Edit-recovery anchor cleanup** — for `edit` and
 *      `insert_after_anchor` tool calls, clear the edit-recovery
 *      attempt counter on success (CAP-015 helpers handle the actual
 *      `runtimeSessionState.editRecoveryAttempts` mutation). The
 *      asymmetry is load-bearing:
 *        - `edit`: success is signalled by `parseEditToolError`
 *          returning falsy (its OWN error parser, more permissive than
 *          the generic `[Tool Error]` envelope).
 *        - `insert_after_anchor`: success is signalled by
 *          `!isToolResultErrorContent(...)` (the generic envelope).
 *      This split exists because the two tools surface their failures
 *      via different output shapes — `edit` emits structured anchor
 *      diagnostics, `insert_after_anchor` emits plain `[Tool Error]`.
 *
 * Time-ordering: AFTER tool result settle (the result string is in
 * hand); BEFORE post-tool judge (CAP-018), mutation reflection
 * (CAP-016), edit-recovery user-message build (CAP-015 emits its
 * recovery prompt only AFTER outcome tracking has updated the attempt
 * counter).
 *
 * P3 note: when CAP-024 (`executeToolCall`) is extracted into
 * `agent-runtime/tool-dispatch.ts`, this module will likely co-locate
 * there per inventory's "shared with CAP-024" annotation. For P2 it
 * lives in its own file to avoid creating a stub-named module that
 * would just be a moving target.
 *
 * Migration history: extracted from `agent.ts:1034-1054` (pre-FEATURE_100
 * baseline) during FEATURE_100 P2 (CAP-026/028 batch).
 */

import type { KodaXToolExecutionContext } from '../../types.js';
import { parseEditToolError } from '../../tools/index.js';
import {
  type RunnableToolCall,
  clearEditRecoveryStateForPath,
  resolveToolTargetPath,
} from './edit-recovery.js';
import type { RuntimeSessionState } from '../runtime-session-state.js';
import {
  extractStructuredToolErrorCode,
  isToolResultErrorContent,
} from '../tool-result-classify.js';

export function updateToolOutcomeTracking(
  toolCall: RunnableToolCall,
  toolResult: string,
  runtimeSessionState: RuntimeSessionState,
  ctx: KodaXToolExecutionContext,
): void {
  const resolvedPath = resolveToolTargetPath(toolCall, ctx);
  runtimeSessionState.lastToolResultBytes = Buffer.byteLength(toolResult, 'utf8');
  runtimeSessionState.lastToolErrorCode = extractStructuredToolErrorCode(toolResult);

  if (toolCall.name === 'edit') {
    if (!parseEditToolError(toolResult)) {
      clearEditRecoveryStateForPath(runtimeSessionState, resolvedPath);
    }
    return;
  }

  if (toolCall.name === 'insert_after_anchor' && !isToolResultErrorContent(toolResult)) {
    clearEditRecoveryStateForPath(runtimeSessionState, resolvedPath);
  }
}
