/**
 * Tri-state permission gate — CAP-010
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-010-tri-state-permission-gate-plan-mode--accept-edits--extension-toolbefore
 *
 * Pre-execute gate run before every tool dispatch. Three sources can veto
 * or modify the call; precedence is `events.beforeToolExecute` first, then
 * the extension `tool:before` hook. An extension ask runs the call only after
 * `events.requestToolApproval` answers `true` (FEATURE_304, ADR-071). Returns:
 *
 *   - `undefined`  → allow execution
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
 * A host that sets no `beforeToolExecute` runs only read-only tools; every
 * other call is refused with a result that says how to allow it, and the
 * process is warned once. `allowAll` is the explicit way to run every tool
 * (SDK v2 D8; before it, no callback meant every call ran). Code that wraps
 * `beforeToolExecute` falls back to `readOnlyWithoutApproval`, never to `true`,
 * so a wrapper cannot turn a missing callback into an allow.
 *
 * Migration history: extracted from `agent.ts:565-596` during FEATURE_100 P2.
 */

import { approvalMissingToolResult, approvalUnavailableToolResult, CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
import { isExtensionToolBeforeAsk, runActiveExtensionHook } from '../extensions/runtime.js';
import { isToolMutation } from '../tools/registry.js';
import type { KodaXEvents } from '../types.js';
import type { ToolResultRecovery } from '../tool-result-recovery.js';

/** Runs every tool call. Pass it as `events.beforeToolExecute` to opt out of approving calls. */
export const allowAll: NonNullable<KodaXEvents['beforeToolExecute']> = async () => true;

let warnedApprovalMissing = false;

/** Tells the program embedding KodaX, once, why calls are refused and what to set. */
function warnApprovalMissing(name: string): void {
  if (warnedApprovalMissing) return;
  warnedApprovalMissing = true;
  process.emitWarning(
    `KodaX refused the tool call "${name}": no events.beforeToolExecute is set, so only read-only tools run. `
      + 'Pass events.beforeToolExecute to approve each call, or allowAll from @kodax-ai/coding to run every tool.',
    { code: 'KODAX_TOOL_APPROVAL_MISSING' },
  );
}

/**
 * The approval a host gets when it sets none: a read-only tool runs, any other
 * call is refused with a result that says how to allow it.
 */
export const readOnlyWithoutApproval: NonNullable<KodaXEvents['beforeToolExecute']> = async (name) => {
  if (!isToolMutation(name)) return true;
  warnApprovalMissing(name);
  return approvalMissingToolResult(name);
};

export async function getToolExecutionOverride(
  events: KodaXEvents,
  name: string,
  input: Record<string, unknown>,
  toolId?: string,
  executionCwd?: string,
  gitRoot?: string,
  recovery?: ToolResultRecovery,
): Promise<string | undefined> {
  const approve = events.beforeToolExecute ?? readOnlyWithoutApproval;
  const allowed = await approve(name, input, { toolId });
  if (allowed === false) {
    recovery?.denyRead(name, input);
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  if (typeof allowed === 'string') {
    recovery?.denyRead(name, input);
    return allowed;
  }

  const extensionOverride = await runActiveExtensionHook('tool:before', {
    name,
    input,
    toolId,
    executionCwd,
    gitRoot,
  });
  if (extensionOverride === false) {
    recovery?.denyRead(name, input);
    return CANCELLED_TOOL_RESULT_MESSAGE;
  }

  if (isExtensionToolBeforeAsk(extensionOverride)) {
    // Without a way to ask a person, an ask must block rather than allow.
    const approval = events.requestToolApproval
      ? await events.requestToolApproval(name, input, extensionOverride.reason, { toolId,
        ...(extensionOverride.extensionAsks !== undefined ? { extensionAsks: extensionOverride.extensionAsks } : {}) })
      : `${approvalUnavailableToolResult(name)}\n${extensionOverride.reason}`;
    if (approval === true) return undefined;
    recovery?.denyRead(name, input);
    return typeof approval === 'string' ? approval : CANCELLED_TOOL_RESULT_MESSAGE;
  }

  if (typeof extensionOverride === 'string') recovery?.denyRead(name, input);
  return typeof extensionOverride === 'string' ? extensionOverride : undefined;
}
