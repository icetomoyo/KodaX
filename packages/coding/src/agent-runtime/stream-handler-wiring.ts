/**
 * Stream-handler wiring — CAP-067
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-067-stream-handler-wiring
 *
 * Class 1 (substrate). Assembles the 6-handler callback bag passed to
 * `streamProvider.stream(...)`. Each handler fans out to three sinks:
 *
 *   1. `streamTimers.resetIdleTimer()` (or `clearIdleTimer()` for the
 *      heartbeat-pause path) — keeps the idle watchdog alive while
 *      data is flowing
 *   2. `boundaryTracker` — marks the corresponding event class for
 *      stable-boundary failure-stage inference (CAP-068 territory)
 *   3. Extension event bus (`emitActiveExtensionEvent`) + consumer
 *      events (`events.onXyz?.()`)
 *
 * The fan-out order is load-bearing for two reasons:
 *
 *   - `resetIdleTimer` MUST run before anything that could throw or
 *     suspend (extension events are async and dispatched via `void`,
 *     but the `events.onXyz` hook may run synchronously and block).
 *     Keeping the timer reset first guarantees the watchdog is always
 *     refreshed on any inbound delta.
 *
 *   - `boundaryTracker.markX` is invoked synchronously before the
 *     extension event dispatch so the tracker's "first event seen"
 *     state is consistent with what observers downstream see. Failure
 *     stage inference (`inferFailureStage`) relies on which mark*
 *     methods fired before the stream fault.
 *
 * `onHeartbeat` is the one handler that does NOT call `resetIdleTimer`
 * unconditionally: when `pause: true`, it calls `clearIdleTimer()`
 * instead. The semantic is "between content blocks the server may be
 * silent while generating the next block; clear idle (the hard timeout
 * still guards) but DO NOT restart it because the silence is expected."
 *
 * Migration history: extracted from `agent.ts:852-893` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.2c.
 */

import type { KodaXEvents } from '../types.js';
import type { KodaXProviderStreamOptions } from '@kodax/ai';
import type { StableBoundaryTracker } from '../resilience/stable-boundary.js';
import type { ExtensionEventMap } from '../extensions/types.js';
import type { StreamTimers } from './stream-timers.js';

/** Generic extension-event emitter signature shared with `runtime.emitEvent` etc. */
export type ExtensionEventEmitter = <TEvent extends keyof ExtensionEventMap>(
  event: TEvent,
  payload: ExtensionEventMap[TEvent],
) => Promise<void>;

export interface StreamHandlerWiringInput {
  readonly events: KodaXEvents;
  readonly boundaryTracker: StableBoundaryTracker;
  readonly streamTimers: StreamTimers;
  readonly emitActiveExtensionEvent: ExtensionEventEmitter;
  /**
   * Provider name carried into the `provider:rate-limit` extension event
   * payload (the rate-limit handler is the only one that needs it).
   */
  readonly providerName: string;
}

/**
 * Subset of `KodaXProviderStreamOptions` produced by the wiring step.
 * The caller still supplies `modelOverride` and `signal` directly when
 * passing this to `streamProvider.stream(...)`.
 */
export type StreamHandlerCallbacks = Pick<
  KodaXProviderStreamOptions,
  | 'onTextDelta'
  | 'onThinkingDelta'
  | 'onThinkingEnd'
  | 'onToolInputDelta'
  | 'onRateLimit'
  | 'onHeartbeat'
>;

export function buildStreamHandlers(input: StreamHandlerWiringInput): StreamHandlerCallbacks {
  const { events, boundaryTracker, streamTimers, emitActiveExtensionEvent, providerName } = input;
  return {
    onTextDelta: (text: string) => {
      streamTimers.resetIdleTimer();
      boundaryTracker.markTextDelta(text);
      void emitActiveExtensionEvent('text:delta', { text });
      events.onTextDelta?.(text);
    },
    onThinkingDelta: (text: string) => {
      streamTimers.resetIdleTimer();
      boundaryTracker.markThinkingDelta(text);
      void emitActiveExtensionEvent('thinking:delta', { text });
      events.onThinkingDelta?.(text);
    },
    onThinkingEnd: (thinking: string) => {
      streamTimers.resetIdleTimer();
      void emitActiveExtensionEvent('thinking:end', { thinking });
      events.onThinkingEnd?.(thinking);
    },
    onToolInputDelta: (name, json, meta) => {
      streamTimers.resetIdleTimer();
      boundaryTracker.markToolInputStart(meta?.toolId ?? `pending:${name}`);
      events.onToolInputDelta?.(name, json, meta);
    },
    onRateLimit: (rateAttempt, max, delay) => {
      streamTimers.resetIdleTimer();
      void emitActiveExtensionEvent('provider:rate-limit', {
        provider: providerName,
        attempt: rateAttempt,
        maxRetries: max,
        delayMs: delay,
      });
      events.onProviderRateLimit?.(rateAttempt, max, delay);
    },
    onHeartbeat: (pause) => {
      if (pause) {
        // Between content blocks: server may be silent while generating
        // the next block. Clear idle timer but do NOT restart it — the
        // hard request timeout (10 min) still guards against stuck
        // connections.
        streamTimers.clearIdleTimer();
      } else {
        streamTimers.resetIdleTimer();
      }
    },
  };
}
