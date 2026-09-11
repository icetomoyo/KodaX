/**
 * FEATURE_187 (v0.7.43) Phase D — RunnerToolObserver composition helper.
 *
 * Phase A through C built the FEATURE_178 stall sidecar into a
 * `RunnerToolObserver`-shaped middleware that runner-driven.ts wired in
 * by manually delegating to `stallSidecar.observer.beforeTool` /
 * `onToolCall` / `onToolResult` inside its existing toolObserver object
 * literal. That pattern works but obscures the precedence contract
 * ("which observer's beforeTool runs first?") and scales poorly if a
 * future middleware (e.g. compaction observer, auto-mode classifier)
 * needs the same surface.
 *
 * `composeToolObservers` is the explicit composition primitive:
 * receives N observers, returns a single `RunnerToolObserver` whose
 * lifecycle methods invoke each child in turn with documented semantics:
 *
 *   - `beforeTool`: invoked in argument order. Returns the FIRST
 *     short-circuit result (string OR `false`) — subsequent observers'
 *     beforeTool are NOT called. Returns `true` only if every observer
 *     allowed the tool (returned `true` or `undefined`).
 *
 *     Rationale: `beforeTool` is a permission gate. The earliest gate
 *     to block wins. The stall sidecar's nudge-consume MUST run before
 *     any permission/extension gate so the synthesized tool_result is
 *     injected instead of being filtered by a downstream policy.
 *
 *   - `onToolCall`: invoked in argument order on every observer. No
 *     short-circuit — multiple observers may legitimately observe the
 *     same call (e.g. stall detector records into transcript buffer
 *     AND evidence trail emits a span).
 *
 *   - `onToolResult`: same fan-out semantics as onToolCall.
 *
 * **Precedence convention** for runner-driven.ts callers: pass the
 * stall sidecar FIRST so its nudge-consume gates everything else.
 * Auto-mode classifier and extension permission observers follow.
 * Evidence-trail / telemetry observers go LAST (pure observation,
 * no gating).
 *
 * Design references:
 *   - ADR-030 §C — "abstract primitive, not framework"
 *   - docs/features/v0.7.43.md §FEATURE_187 Phase D
 *   - sibling `sidecar-verifier/` and `stall-sidecar/` middleware modules
 */

import type {
  RunnerToolCall,
  RunnerToolObserver,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { ContextCapacityError } from '@kodax-ai/agent';
import { KodaXError } from '@kodax-ai/llm';
import { buildLocalExecutionFailure } from '../../execution-failure.js';
import { ToolResultBatchCapacityError } from '../../tools/tool-result-policy.js';

/** Only synchronous local notifications use this boundary; permission gates may call Providers. */
function notifyToolObserver(notify: () => void): void {
  try {
    notify();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if ('executionFailure' in error || error.name === 'AbortError'
      || error instanceof KodaXError || error instanceof ContextCapacityError
      || error instanceof ToolResultBatchCapacityError) throw cause;
    const failure = buildLocalExecutionFailure(error);
    const target = Object.isExtensible(error) ? error : new Error(error.message, { cause: error });
    Object.defineProperty(target, 'executionFailure', { value: failure, configurable: true });
    throw target;
  }
}

/**
 * Compose N `RunnerToolObserver`s into a single observer with the
 * precedence semantics documented above. Returns a new observer; the
 * inputs are not mutated.
 *
 * Zero-argument call returns a no-op observer. This is NOT speculative
 * YAGNI flexibility — callers (e.g. runner-driven.ts) build their
 * middleware list dynamically from runtime config (stallSidecar may
 * be gated by feature flags in future, permission observer is
 * always-on today). When the spread reduces to zero in tests or
 * minimal-config bootstrap paths, the composed observer must still
 * satisfy the `RunnerToolObserver` contract (beforeTool → allow,
 * onToolCall / onToolResult → no-op) so Runner doesn't trip on
 * `undefined is not a function`.
 */
export function composeToolObservers(
  ...observers: readonly RunnerToolObserver[]
): RunnerToolObserver {
  return {
    beforeTool: async (call: RunnerToolCall) => {
      for (const obs of observers) {
        if (!obs.beforeTool) continue;
        const verdict = await obs.beforeTool(call);
        // Short-circuit on string (block + injected tool_result) or
        // false (cancel). Pass through on true / undefined.
        if (verdict === undefined || verdict === true) continue;
        return verdict;
      }
      return true;
    },
    onToolCall: (call: RunnerToolCall) => {
      for (const obs of observers) {
        notifyToolObserver(() => obs.onToolCall?.(call));
      }
    },
    onToolResult: (call: RunnerToolCall, result: RunnerToolResult) => {
      for (const obs of observers) {
        notifyToolObserver(() => obs.onToolResult?.(call, result));
      }
    },
    onToolExecutionStart: (call: RunnerToolCall) => {
      for (const obs of observers) notifyToolObserver(() => obs.onToolExecutionStart?.(call));
    },
    onToolExecutionEnd: (call: RunnerToolCall) => {
      for (const obs of observers) notifyToolObserver(() => obs.onToolExecutionEnd?.(call));
    },
  };
}
