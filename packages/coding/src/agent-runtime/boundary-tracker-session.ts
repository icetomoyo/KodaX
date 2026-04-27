/**
 * Boundary-tracker session — CAP-068
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-068-boundary-tracker--telemetry-emission
 *
 * Class 1 (substrate). Pairs `StableBoundaryTracker` instantiation with
 * the four telemetry emission sites that surround a stream attempt:
 *
 *   1. `beginAttempt` — pre-stream snapshot via `telemetryBoundary`
 *      (called at the start of every stream attempt, including the
 *      non-streaming-fallback path)
 *   2. `markTextDelta` / `markThinkingDelta` / `markToolInputStart` —
 *      per-event marks during stream (delegated from
 *      stream-handler-wiring.ts callbacks)
 *   3. `inferFailureStage` — invoked from the catch path to classify
 *      where the stream failed (pre-text / mid-text / mid-tool-input)
 *      based on which `markX` methods fired before the error
 *
 * The session also re-exposes the underlying tracker for callers that
 * need direct access to less-common methods (e.g. `snapshot()` for
 * debug logging). The tracker reference is stable for the life of the
 * session — extension callbacks holding it across the two `beginAttempt`
 * calls (main stream + non-streaming-fallback) get consistent state.
 *
 * `inferFailureStage` reads which mark* methods were fired during the
 * stream. If the stream-handler wiring (CAP-067) calls these on a
 * different tracker instance than the one later passed to
 * `inferFailureStage`, the stage inference returns wrong results
 * (silently corrupts retry telemetry and may select the wrong recovery
 * action). The session enforces this invariant by being the single
 * owner of the tracker.
 *
 * Migration history: extracted from `agent.ts:806` (instantiation) +
 * `agent.ts:813,820,926,933` (beginRequest+telemetryBoundary pairs) +
 * `agent.ts:881` (inferFailureStage) — pre-FEATURE_100 baseline —
 * during FEATURE_100 P3.2d.
 */

import type { KodaXMessage } from '@kodax/ai';
import { StableBoundaryTracker } from '../resilience/stable-boundary.js';
import { telemetryBoundary } from '../resilience/telemetry.js';

export class BoundaryTrackerSession {
  /**
   * Underlying tracker. Exposed `readonly` so consumers can reach
   * uncommon methods (e.g. `snapshot()` for debug logging) but cannot
   * replace the reference — substituting a different tracker would
   * break the inferFailureStage / mark consistency invariant.
   */
  readonly tracker: StableBoundaryTracker;

  constructor() {
    this.tracker = new StableBoundaryTracker();
  }

  /**
   * Begin a new attempt: arm the tracker for the given request shape
   * and emit `telemetryBoundary` with the resulting snapshot. Called
   * once before the main stream and once before any
   * non-streaming-fallback retry.
   */
  beginAttempt(
    providerName: string,
    model: string,
    messages: readonly KodaXMessage[],
    attempt: number,
    fallback: boolean,
  ): void {
    this.tracker.beginRequest(providerName, model, messages as KodaXMessage[], attempt, fallback);
    telemetryBoundary(this.tracker.snapshot());
  }

  /** Delegate: mark a text-delta event. */
  markTextDelta(text: string): void {
    this.tracker.markTextDelta(text);
  }

  /** Delegate: mark a thinking-delta event. */
  markThinkingDelta(text: string): void {
    this.tracker.markThinkingDelta(text);
  }

  /** Delegate: mark a tool-input start event. */
  markToolInputStart(toolId: string): void {
    this.tracker.markToolInputStart(toolId);
  }

  /**
   * Classify the failure stage based on which mark* methods fired
   * before the error. Reads the tracker's accumulated event flags;
   * does not mutate state.
   */
  inferFailureStage(): ReturnType<StableBoundaryTracker['inferFailureStage']> {
    return this.tracker.inferFailureStage();
  }

  /** Read-only snapshot for debug / observation. */
  snapshot(): ReturnType<StableBoundaryTracker['snapshot']> {
    return this.tracker.snapshot();
  }
}
