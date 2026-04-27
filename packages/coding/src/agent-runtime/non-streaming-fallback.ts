/**
 * Non-streaming fallback execution — CAP-071
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-071-non-streaming-fallback-execution
 *
 * Class 1 (substrate). Triggered from the recovery pipeline when
 * `decision.shouldUseNonStreaming === true` (CAP-069). Switches the
 * current attempt from streaming to a buffered `streamProvider.complete`
 * call. Used when transient stream-mode errors recover better against
 * the same provider's non-streaming endpoint (e.g. a partial-stream
 * mid-tool-input failure that the server cannot resume).
 *
 * Lifecycle:
 *
 *   1. Clear all stream-mode timers (`streamTimers.clearAll`) — the
 *      streaming attempt is abandoned; its watchdogs would otherwise
 *      keep firing into the controller below.
 *
 *   2. Build a fresh single-purpose hard-timer guard. The non-streaming
 *      attempt has its own AbortController (separate from the streaming
 *      `retryTimeoutController`) because the two paths have independent
 *      lifecycles — a stale `retryTimeoutController.signal.aborted`
 *      from the failed streaming attempt MUST NOT abort the fallback.
 *      The 10-minute hard cap is preserved.
 *
 *   3. Register the attempt with `boundarySession.beginAttempt(...
 *      fallback=true)` so telemetry distinguishes streaming vs fallback
 *      attempts.
 *
 *   4. Call `streamProvider.complete(...)` with a SIMPLER handler set
 *      than the streaming path. Non-streaming has no idle reset, no
 *      rate-limit handler, no heartbeat — those are streaming-only
 *      protocol concerns. Only the 3 content-delta handlers fire (and
 *      they fire for the buffered chunks the provider emits as the
 *      complete response is decoded).
 *
 *   5. On success: return `{ ok: true, result }`. The caller breaks the
 *      outer attempt loop and treats the fallback result as the canonical
 *      stream result.
 *
 *   6. On failure: return `{ ok: false, error }`. The caller falls
 *      through to the recovery-action branches (sanitize-thinking-retry /
 *      manual-continue / normal retry).
 *
 * Migration history: extracted from `agent.ts:895-948` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.2f.
 */

import type { KodaXEvents } from '../types.js';
import type {
  KodaXBaseProvider,
  KodaXStreamResult,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXReasoningRequest,
} from '@kodax/ai';
import type { BoundaryTrackerSession } from './boundary-tracker-session.js';
import type { ExtensionEventEmitter } from './stream-handler-wiring.js';

export interface NonStreamingFallbackInput {
  readonly events: KodaXEvents;
  readonly streamProvider: KodaXBaseProvider;
  readonly providerMessages: KodaXMessage[];
  readonly activeToolDefinitions: KodaXToolDefinition[];
  readonly effectiveSystemPrompt: string;
  readonly effectiveProviderReasoning: boolean | KodaXReasoningRequest;
  readonly callerAbortSignal: AbortSignal | undefined;
  readonly modelOverride: string | undefined;
  readonly hardTimeoutMs: number;
  readonly boundarySession: BoundaryTrackerSession;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
  readonly providerName: string;
  readonly attempt: number;
  /**
   * Hook to clear the streaming-mode timers BEFORE the fallback fires.
   * Required because the streaming attempt's watchdogs would otherwise
   * keep firing into a now-abandoned controller.
   */
  readonly clearStreamTimers: () => void;
}

export type NonStreamingFallbackOutcome =
  | { readonly ok: true; readonly result: KodaXStreamResult }
  | { readonly ok: false; readonly error: Error };

export async function executeNonStreamingFallback(
  input: NonStreamingFallbackInput,
): Promise<NonStreamingFallbackOutcome> {
  // Arm the fallback timer first, then clear stream timers in the try
  // block. The two controllers are independent — the fallback's
  // controller is not observed by the stream-mode retryTimeoutController
  // and vice versa — so the brief overlap window is benign even if a
  // queued stream-mode idle timer fires after this point. The streaming
  // attempt has already failed (we are inside its catch block), so any
  // late stream-mode abort hits a no-op.
  const fallbackTimeoutController = new AbortController();
  const fallbackSignal = input.callerAbortSignal
    ? AbortSignal.any([input.callerAbortSignal, fallbackTimeoutController.signal])
    : fallbackTimeoutController.signal;
  const fallbackHardTimer = setTimeout(() => {
    fallbackTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
  }, input.hardTimeoutMs);

  try {
    input.clearStreamTimers();
    input.boundarySession.beginAttempt(
      input.providerName,
      input.modelOverride ?? input.streamProvider.getModel(),
      input.providerMessages,
      input.attempt,
      true,
    );
    const result = await input.streamProvider.complete(
      input.providerMessages,
      input.activeToolDefinitions,
      input.effectiveSystemPrompt,
      input.effectiveProviderReasoning,
      {
        onTextDelta: (text: string) => {
          input.boundarySession.markTextDelta(text);
          void input.emitActiveExtensionEvent('text:delta', { text });
          input.events.onTextDelta?.(text);
        },
        onThinkingDelta: (text: string) => {
          input.boundarySession.markThinkingDelta(text);
          void input.emitActiveExtensionEvent('thinking:delta', { text });
          input.events.onThinkingDelta?.(text);
        },
        onThinkingEnd: (thinking: string) => {
          void input.emitActiveExtensionEvent('thinking:end', { thinking });
          input.events.onThinkingEnd?.(thinking);
        },
        modelOverride: input.modelOverride,
        signal: fallbackSignal,
      },
      fallbackSignal,
    );
    return { ok: true, result };
  } catch (rawError) {
    const error = rawError instanceof Error ? rawError : new Error(String(rawError));
    return { ok: false, error };
  } finally {
    clearTimeout(fallbackHardTimer);
  }
}
