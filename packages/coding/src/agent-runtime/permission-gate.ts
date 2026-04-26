/**
 * Tri-state permission gate — CAP-010
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-010-tri-state-permission-gate-plan-mode--accept-edits--extension-toolbefore
 *
 * Pre-execute gate run before every tool dispatch. Three sources can veto
 * or modify the call; precedence is `events.beforeToolExecute` first, then
 * the extension `tool:before` hook. Returns:
 *
 *   - `undefined`  → allow execution (the default)
 *   - a string     → block, but use this string as the synthesized
 *                    tool_result content (lets plan-mode show "this would
 *                    have done X" or extension hooks emit structured
 *                    rationale)
 *   - the special `CANCELLED_TOOL_RESULT_MESSAGE` constant → block as
 *                    cancellation (treated as user-cancel by the loop, not
 *                    as model-visible policy text)
 *
 * The tri-state contract MUST be preserved verbatim: callers downstream
 * (tool dispatch loop) distinguish cancel-vs-block-with-message by exact
 * string equality with `CANCELLED_TOOL_RESULT_MESSAGE`.
 *
 * Migration history: extracted from `agent.ts:565-596` during FEATURE_100 P2.
 */

import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import { runActiveExtensionHook } from '../extensions/runtime.js';
import type { KodaXEvents } from '../types.js';

export async function getToolExecutionOverride(
  events: KodaXEvents,
  name: string,
  input: Record<string, unknown>,
  toolId?: string,
  executionCwd?: string,
  gitRoot?: string,
): Promise<string | undefined> {
  if (events.beforeToolExecute) {
    const allowed = await events.beforeToolExecute(name, input, { toolId });
    if (allowed === false) {
      return CANCELLED_TOOL_RESULT_MESSAGE;
    }

    if (typeof allowed === 'string') {
      return allowed;
    }
  }

  const extensionOverride = await runActiveExtensionHook('tool:before', {
    name,
    input,
    toolId,
    executionCwd,
    gitRoot,
  });
  if (extensionOverride === false) {
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  return typeof extensionOverride === 'string' ? extensionOverride : undefined;
}
