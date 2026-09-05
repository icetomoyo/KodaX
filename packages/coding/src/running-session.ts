/**
 * RunningSession — v0.7.42 (closes gap 6 reported by KodaX Space).
 *
 * `runKodaX(opts, prompt)` is a blocking `Promise<KodaXResult>` — once
 * a run is in-flight the SDK consumer cannot observe its session id,
 * flip provider / model / reasoning mid-run, or abort cooperatively
 * without forging an external `AbortSignal` and squinting at the
 * resolved `KodaXResult` after the fact.
 *
 * `startKodaX(opts, prompt)` returns a `RunningSession` handle
 * immediately (the run starts on the next microtask). The handle
 * exposes:
 *
 *   - `id`               — the resolved session id (from
 *                          `options.session.id` or freshly generated)
 *   - `currentProvider` / `currentModel` / `currentReasoning`
 *                          — last value the embedder requested
 *                          (mirrors what the next turn will see)
 *   - `setProvider` / `setModel` / `setReasoning`
 *                          — apply between turns; the next CAP-055
 *                          re-resolution picks them up
 *   - `abort(reason?)`    — cooperative abort via internal
 *                          `AbortController`; honors external
 *                          `options.abortSignal` too (forwarded)
 *   - `result`            — `Promise<KodaXResult>` (same shape
 *                          `runKodaX` returns)
 *
 * `runKodaX` is now a thin wrapper over `startKodaX(...).result` so
 * there is no dual code path (per feedback_no_parallel_refactor_paths).
 */

import { runKodaX } from './agent.js';
import { markStartKodaXGeneratedSessionId } from './agent-runtime/middleware/session-snapshot.js';
import type {
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXSessionControl,
  KodaXSessionMutators,
} from './types.js';
import { normalizeKodaXAgentMode } from './types.js';

export interface RunningSession {
  /** Session id used by the underlying run (echoes options.session.id when supplied). */
  readonly id: string;
  /** Last provider value requested via constructor or `setProvider`. */
  readonly currentProvider: string;
  /** Last model value requested via constructor or `setModel`. Undefined = provider default. */
  readonly currentModel: string | undefined;
  /** Last reasoning mode requested via constructor or `setReasoning`. */
  readonly currentReasoning: KodaXReasoningMode | undefined;
  /** Whether `abort` has been called (or the external signal has fired). */
  readonly aborted: boolean;
  /** Whether the substrate has wired up the live mutators yet. */
  readonly attached: boolean;
  /** Switch provider mid-run. Applies on the next turn. */
  setProvider(name: string): void;
  /** Switch model mid-run. Pass undefined to clear an override. */
  setModel(model: string | undefined): void;
  /** Switch reasoning on the next turn; optional effort/thinking replaces their current selection. */
  setReasoning(
    mode: KodaXReasoningMode | undefined,
    options?: Pick<KodaXOptions, 'effort' | 'thinking'>,
  ): void;
  /** Cooperatively abort. The underlying provider stream sees an AbortError. */
  abort(reason?: unknown): void;
  /** Resolves to the same shape `runKodaX` returns. */
  readonly result: Promise<KodaXResult>;
}

/**
 * Public-friendly factory for {@link KodaXSessionControl}. Callers that
 * want the mid-run mutation surface WITHOUT the `startKodaX` wrapper
 * (e.g. building their own abort + lifecycle) can instantiate this and
 * pass it as `KodaXOptions.sessionControl`.
 */
export function createSessionControl(): KodaXSessionControl & KodaXSessionMutators {
  return new SessionControlImpl();
}

export function startKodaX(
  options: KodaXOptions,
  prompt: string,
): RunningSession {
  const internalAbort = new AbortController();
  let aborted = false;
  const markAborted = (reason?: unknown): void => {
    if (aborted) return;
    aborted = true;
    internalAbort.abort(reason);
  };

  // Forward an externally-supplied AbortSignal so callers can keep their
  // existing cancellation pipeline while still using `startKodaX`.
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      markAborted(options.abortSignal.reason);
    } else {
      options.abortSignal.addEventListener(
        'abort',
        () => markAborted(options.abortSignal!.reason),
        { once: true },
      );
    }
  }

  // Session control — owns the requested-value cache + replay-on-attach.
  const control = new SessionControlImpl();
  control.seed({
    provider: options.provider,
    model: options.modelOverride ?? options.model,
    reasoning: options.reasoningMode,
  });

  const rawSessionId = options.session?.id;
  const callerSuppliedSessionId = rawSessionId !== undefined && rawSessionId !== null;
  const sessionId = rawSessionId ?? generateSessionId();
  const shouldThreadGeneratedSessionId =
    !callerSuppliedSessionId
    && options.session?.autoResume !== true
    && options.session?.resume !== true;
  const sessionOptions = shouldThreadGeneratedSessionId
    ? markStartKodaXGeneratedSessionId({
        ...(options.session ?? {}),
        id: sessionId,
      })
    : options.session;
  const effectiveOptions: KodaXOptions = {
    ...options,
    ...(options.agentMode !== undefined
      ? { agentMode: normalizeKodaXAgentMode(options.agentMode) }
      : {}),
    ...(sessionOptions !== undefined ? { session: sessionOptions } : {}),
    abortSignal: internalAbort.signal,
    sessionControl: control,
  };

  // Kick off the run. `runKodaX` returns the Promise immediately —
  // by the time control returns to the caller, the substrate's
  // `_attach` has not yet fired, so any sync setter calls land in
  // the pre-attach queue and replay on attach.
  const result = runKodaX(effectiveOptions, prompt);

  return {
    id: sessionId,
    get currentProvider() {
      return control.getProvider();
    },
    get currentModel() {
      return control.getModel();
    },
    get currentReasoning() {
      return control.getReasoning();
    },
    get aborted() {
      return aborted;
    },
    get attached() {
      return control.isAttached();
    },
    setProvider: (name) => control.setProvider(name),
    setModel: (model) => control.setModel(model),
    setReasoning: (mode, reasoning) => control.setReasoning(mode, reasoning),
    abort: (reason) => markAborted(reason),
    result,
  };
}

// ============== Internals ==============

/**
 * Generate a fresh session id matching the format substrate consumers
 * elsewhere produce. Format: `sess_<ms-since-epoch>_<8-char-base36>`.
 * Used only when the caller did not supply `options.session.id`.
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

class SessionControlImpl implements KodaXSessionControl, KodaXSessionMutators {
  private mutators: KodaXSessionMutators | null = null;

  private providerValue: string | undefined;
  private modelValue: string | undefined;
  private reasoningValue: KodaXReasoningMode | undefined;
  private reasoningOptions: Pick<KodaXOptions, 'effort' | 'thinking'> | undefined;

  // Set-vs-not-yet-set flags — needed so an explicit `setModel(undefined)`
  // (clear override) can be distinguished from a never-touched field.
  private hasPendingProvider = false;
  private hasPendingModel = false;
  private hasPendingReasoning = false;

  /**
   * Initialise the requested-value mirror from the constructor options.
   * Does NOT push these into the substrate — the substrate already has
   * them via the regular options pipeline. Used to populate the
   * `currentProvider` / `currentModel` / `currentReasoning` getters.
   */
  seed(input: {
    provider?: string;
    model?: string;
    reasoning?: KodaXReasoningMode;
  }): void {
    this.providerValue = input.provider;
    this.modelValue = input.model;
    this.reasoningValue = input.reasoning;
  }

  setProvider(name: string): void {
    this.providerValue = name;
    if (this.mutators) {
      this.mutators.setProvider(name);
    } else {
      this.hasPendingProvider = true;
    }
  }

  setModel(model: string | undefined): void {
    this.modelValue = model;
    if (this.mutators) {
      this.mutators.setModel(model);
    } else {
      this.hasPendingModel = true;
    }
  }

  setReasoning(
    mode: KodaXReasoningMode | undefined,
    options?: Pick<KodaXOptions, 'effort' | 'thinking'>,
  ): void {
    this.reasoningValue = mode;
    this.reasoningOptions = options === undefined ? undefined : { ...options };
    if (this.mutators) {
      this.mutators.setReasoning(mode, this.reasoningOptions);
    } else {
      this.hasPendingReasoning = true;
    }
  }

  getProvider(): string {
    return this.providerValue ?? '';
  }

  getModel(): string | undefined {
    return this.modelValue;
  }

  getReasoning(): KodaXReasoningMode | undefined {
    return this.reasoningValue;
  }

  isAttached(): boolean {
    return this.mutators !== null;
  }

  _attach(mutators: KodaXSessionMutators): void {
    if (this.mutators) {
      // Substrate called us twice — shouldn't happen, but be defensive.
      // Replace silently; the last mutators win.
    }
    this.mutators = mutators;
    if (this.hasPendingProvider && this.providerValue !== undefined) {
      mutators.setProvider(this.providerValue);
    }
    if (this.hasPendingModel) {
      mutators.setModel(this.modelValue);
    }
    if (this.hasPendingReasoning) {
      mutators.setReasoning(this.reasoningValue, this.reasoningOptions);
    }
    this.hasPendingProvider = false;
    this.hasPendingModel = false;
    this.hasPendingReasoning = false;
  }
}
