/**
 * Stream-timer lifecycle — CAP-066
 *
 * Capability inventory: docs/features/v0.7.29-capability-inventory.md#cap-066-stream-timers
 *
 * Class 1 (substrate). Owns the 3-timer + 1-controller lifecycle that
 * guards a single provider stream attempt against hangs:
 *
 *   1. **Hard timer** (`hardTimeoutMs`) — always armed. Aborts the
 *      retry controller after the configured wall-clock cap (default
 *      10 minutes per Issue 084). Last-resort kill switch.
 *
 *   2. **Stream max-duration watchdog** (`streamMaxDurationMs`) — armed
 *      only when the provider declares a server-side kill window via
 *      `getStreamMaxDurationMs()`. Aborts BEFORE the server RSTs so the
 *      recovery pipeline sees a clean StreamIncompleteError instead of
 *      a mid-stream socket reset. Distinct from the idle timer because
 *      some providers (e.g. zhipu-coding) emit keepalive pings during
 *      long tool_use generation that an idle timer would never fire.
 *
 *   3. **Idle timer** (`idleTimeoutMs > 0`) — optional. Aborts when no
 *      content events arrive within the timeout window. `resetIdleTimer`
 *      is invoked from every stream delta handler (text / thinking /
 *      tool_input) to keep the timer alive while data is flowing.
 *
 *   4. **`retryTimeoutController`** — the single AbortController that
 *      all three timers fire into. Merged with `callerAbortSignal` (when
 *      present) into `retrySignal`, which is passed to the underlying
 *      provider stream via `streamProvider.stream(..., retrySignal)`.
 *
 * `clearAll` MUST be called in every exit path of the stream attempt
 * (success, recovery-rethrow, abort-rethrow, finally). Missing a clear
 * leaks a timer that fires AFTER the next iteration begins, producing
 * a spurious abort in an unrelated turn.
 *
 * Migration history: extracted from `agent.ts:830-876` —
 * pre-FEATURE_100 baseline — during FEATURE_100 P3.2a.
 */

export interface StreamTimerOptions {
  /** Hard wall-clock cap (ms). Always armed. */
  readonly hardTimeoutMs: number;
  /** Idle delta-arrival cap (ms). 0 disables the idle timer. */
  readonly idleTimeoutMs: number;
  /**
   * Provider-declared server-side kill window (ms). 0 disables the
   * stream-max-duration watchdog.
   */
  readonly streamMaxDurationMs: number;
  /** The caller's AbortSignal (e.g., user Ctrl+C). Optional. */
  readonly callerAbortSignal: AbortSignal | undefined;
}

export interface StreamTimers {
  /**
   * The controller all three timers fire into. Exposed so the caller
   * can inspect `signal.aborted` after the fact (recovery path needs
   * this to distinguish timer-driven aborts from caller-driven ones).
   */
  readonly retryTimeoutController: AbortController;
  /**
   * The signal to pass to `streamProvider.stream(...)`. When
   * `callerAbortSignal` is present, this is the merged result of
   * `AbortSignal.any([callerAbortSignal, retryTimeoutController.signal])`;
   * otherwise it is `retryTimeoutController.signal` directly.
   */
  readonly retrySignal: AbortSignal;
  /**
   * Invoke from every stream delta handler (text / thinking / tool_input)
   * to keep the idle timer alive while data is flowing. No-op when the
   * idle timer is disabled.
   */
  readonly resetIdleTimer: () => void;
  /**
   * Clear the idle timer WITHOUT restarting it. Used by `onHeartbeat`
   * pause events: between content blocks the server may be silent while
   * generating the next block, so we clear the idle timer (the hard
   * timeout still guards stuck connections). No-op when the idle timer
   * is disabled.
   */
  readonly clearIdleTimer: () => void;
  /**
   * Clear all three timers. MUST be called in every exit path —
   * success, recovery rethrow, abort rethrow, finally. Idempotent.
   */
  readonly clearAll: () => void;
}

export function buildStreamTimers(opts: StreamTimerOptions): StreamTimers {
  const retryTimeoutController = new AbortController();

  let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    retryTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
  }, opts.hardTimeoutMs);

  let streamMaxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.streamMaxDurationMs > 0) {
    streamMaxDurationTimer = setTimeout(() => {
      retryTimeoutController.abort(
        new Error(
          `Stream max duration exceeded (${opts.streamMaxDurationMs}ms; provider has known server-side kill window)`,
        ),
      );
    }, opts.streamMaxDurationMs);
  }

  const idleEnabled = opts.idleTimeoutMs > 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  if (idleEnabled) {
    idleTimer = setTimeout(() => {
      retryTimeoutController.abort(
        new Error(`Stream stalled or delayed response (${opts.idleTimeoutMs}ms idle)`),
      );
    }, opts.idleTimeoutMs);
  }

  const resetIdleTimer = (): void => {
    if (!idleEnabled) return;
    clearTimeout(idleTimer);
    if (!retryTimeoutController.signal.aborted) {
      idleTimer = setTimeout(() => {
        retryTimeoutController.abort(
          new Error(`Stream stalled or delayed response (${opts.idleTimeoutMs}ms idle)`),
        );
      }, opts.idleTimeoutMs);
    }
  };

  const clearIdleTimer = (): void => {
    if (!idleEnabled) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const retrySignal = opts.callerAbortSignal
    ? AbortSignal.any([opts.callerAbortSignal, retryTimeoutController.signal])
    : retryTimeoutController.signal;

  const clearAll = (): void => {
    clearTimeout(hardTimer);
    clearTimeout(streamMaxDurationTimer);
    clearTimeout(idleTimer);
    hardTimer = undefined;
    streamMaxDurationTimer = undefined;
    idleTimer = undefined;
  };

  return {
    retryTimeoutController,
    retrySignal,
    resetIdleTimer,
    clearIdleTimer,
    clearAll,
  };
}
