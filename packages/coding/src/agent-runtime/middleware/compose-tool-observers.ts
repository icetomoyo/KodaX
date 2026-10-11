

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
