/**
 * FEATURE_316: keep the provider's prompt cache warm, after pi's cache warmer.
 *
 * Each completed model request is remembered. When no newer request goes out
 * before its cache entry would expire, the request is resent with a one-token
 * output cap. Each refresh must be expected to save at least five cents: certain
 * to pay off while the Run is active, worth a 15% chance once a root Run has
 * ended and the Session waits for its next message. The resend goes out as
 * purpose `cache_refresh`, so Session statistics count it apart from model
 * turns, and its reply never reaches the transcript or the model context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CACHE_WARMING_MAX_IDLE_AGE_MS,
  CACHE_WARMING_MAX_RUN_AGE_MS,
  cacheRefreshDelayMs,
  cacheRefreshPrices,
  decideCacheWarming,
  getCostRate,
  hasScopedProviderCredentialAuthority,
  promptCacheLifetime,
  promptCacheLifetimeMs,
  replaysWithOutputCap,
  resolveCacheWarmingMode,
  resolvePromptCacheDisabled,
  withProviderRequestCredential,
  type CacheRefreshPrices,
  type CacheWarmingPhase,
  type KodaXBaseProvider,
  type KodaXMessage,
  type KodaXProviderStreamOptions,
  type KodaXReasoningRequest,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { KodaXOptions } from '../types.js';

type WarmableProvider = Pick<KodaXBaseProvider, 'name' | 'stream' | 'getModel' | 'getCacheCapabilities'
  | 'getReasoningCapability' | 'getReasoningProfile'>;

type RunContext = <R>(fn: () => R) => R;

interface ModelRequest {
  readonly provider: WarmableProvider;
  readonly messages: KodaXMessage[];
  readonly tools: KodaXToolDefinition[];
  readonly system: string;
  readonly reasoning: boolean | KodaXReasoningRequest | undefined;
  readonly options: KodaXProviderStreamOptions;
}

interface WarmTarget extends ModelRequest {
  readonly sentAt: number;
  readonly lifetimeMs: number;
  readonly delayMs: number;
  readonly prices: CacheRefreshPrices;
  /** The async context of the Run that sent the request: its credentials, config and observers. */
  readonly context: RunContext;
  /** When the entry was last read or written: the real request, then each refresh. */
  touchedAt: number;
}

interface PromptCacheWarmer {
  /** A Run starts using this warmer; refreshes run in its async context. */
  enter(context: RunContext): void;
  /** A real request starts: it reads the entry itself, so no refresh goes out meanwhile. */
  requestStarted(): void;
  /** The request ended; when it completed, its entry is the one to keep warm. */
  requestEnded(completed?: { request: ModelRequest; sentAt: number; promptTokens: number | undefined }): void;
  /** The Run ended. `idle` keeps warming while the Session waits for its next Run. */
  settle(idle: boolean): void;
  cancel(): void;
  readonly active: boolean;
}

/** `onIdleStop` runs when warming ends after the Run, so the Session can let the warmer go. */
function createPromptCacheWarmer(onIdleStop?: (warmer: PromptCacheWarmer) => void): PromptCacheWarmer {
  let target: WarmTarget | undefined;
  let context: RunContext | undefined;
  let phase: CacheWarmingPhase = 'run';
  let requests = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;

  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const stop = (): void => {
    target = undefined;
    disarm();
    if (phase === 'idle') onIdleStop?.(self);
  };
  const arm = (): void => {
    disarm();
    const armed = target;
    if (!armed || requests > 0 || inFlight) return;
    const due = armed.touchedAt + armed.delayMs;
    // Refreshes never extend this window: it counts from the last real request.
    const maxAge = phase === 'idle' ? CACHE_WARMING_MAX_IDLE_AGE_MS : CACHE_WARMING_MAX_RUN_AGE_MS;
    if (due > armed.sentAt + maxAge) { stop(); return; }
    timer = setTimeout(() => { void armed.context(() => refresh(armed)); }, Math.max(0, due - Date.now()));
    timer.unref?.();
  };
  const refresh = async (armed: WarmTarget): Promise<void> => {
    timer = undefined;
    if (target !== armed || requests > 0) return;
    // A timer that fires late (sleep, a blocked event loop) keeps half the margin for the
    // request itself; later than that the entry is likely gone and a resend would rewrite it.
    if (Date.now() > armed.touchedAt + armed.delayMs + (armed.lifetimeMs - armed.delayMs) / 2) { stop(); return; }
    const mode = resolveCacheWarmingMode();
    if (mode === 'off' || (mode === 'run' && phase === 'idle')) { stop(); return; }
    if (decideCacheWarming(armed.prices, phase).action === 'stop') { stop(); return; }
    // A borrowed key ends with the Run or operation that borrowed it; asking for it would only fail.
    if (hasScopedProviderCredentialAuthority(armed.provider.name) === false) { stop(); return; }
    const controller = new AbortController();
    inFlight = controller;
    const startedAt = Date.now();
    try {
      await withProviderRequestCredential(armed.provider, 'cache_refresh', controller.signal, signal =>
        armed.provider.stream(armed.messages, armed.tools, armed.system, armed.reasoning,
          { ...armed.options, maxOutputTokensOverride: 1, singleAttempt: true, signal }, signal));
      armed.touchedAt = startedAt;
    } catch {
      // Best effort: the provider observation already records the failed request in the
      // Session statistics, and the Run must not notice. A retry would come after the entry
      // expired and pay for a rewrite, so warming stops here.
      if (target === armed) stop();
      return;
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
    arm();
  };

  const self: PromptCacheWarmer = {
    enter(runContext) {
      context = runContext;
      phase = 'run';
    },
    requestStarted() {
      requests += 1;
      disarm();
    },
    requestEnded(completed) {
      requests = Math.max(0, requests - 1);
      if (completed && context) {
        // The newest request replaces the older entry even when it cannot be warmed itself.
        const entry = rememberable(completed.request, completed.promptTokens);
        target = entry && { ...completed.request, ...entry, context, sentAt: completed.sentAt, touchedAt: completed.sentAt };
      }
      arm();
    },
    settle(idle) {
      context = undefined;
      if (!idle || !target || resolveCacheWarmingModeIn(target) !== 'idle') { stop(); return; }
      phase = 'idle';
      arm();
    },
    cancel() {
      stop();
      inFlight?.abort();
    },
    get active() {
      return target !== undefined || inFlight !== undefined;
    },
  };
  return self;
}

function resolveCacheWarmingModeIn(target: WarmTarget): ReturnType<typeof resolveCacheWarmingMode> {
  return target.context(() => resolveCacheWarmingMode());
}

/** Lifetime, timing and prices of a request's entry; undefined when it cannot or should not be warmed. */
function rememberable(request: ModelRequest, promptTokens: number | undefined) {
  if (resolveCacheWarmingMode() === 'off') return undefined;
  const model = request.options.modelOverride ?? request.provider.getModel();
  const lifetime = promptCacheLifetime(request.provider.getCacheCapabilities(model),
    request.options.cacheRetention, resolvePromptCacheDisabled());
  if (!lifetime || !replaysWithOutputCap(request.provider, model, request.reasoning)) return undefined;
  const lifetimeMs = promptCacheLifetimeMs(lifetime);
  const delayMs = cacheRefreshDelayMs(lifetimeMs);
  const rate = getCostRate(request.provider.name, model);
  const prices = rate && promptTokens !== undefined ? cacheRefreshPrices(rate, promptTokens, lifetime) : undefined;
  if (delayMs === undefined || !prices) return undefined;
  return { lifetimeMs, delayMs, prices };
}

const warmerStorage = new AsyncLocalStorage<PromptCacheWarmer>();

/** Warmers that outlive their root Run, one per Session, while they keep an entry warm. */
const sessionWarmers = new Map<string, PromptCacheWarmer>();

/** Stop warming a Session's entry, or every Session's: its conversation or model changed, or it closed. */
export function cancelPromptCacheWarming(sessionId?: string): void {
  const warmers = sessionId === undefined ? [...sessionWarmers.values()] : [sessionWarmers.get(sessionId)];
  for (const warmer of warmers) warmer?.cancel();
  if (sessionId === undefined) sessionWarmers.clear();
  else sessionWarmers.delete(sessionId);
}

/**
 * Run one Run with a warmer. A root Run of a Session shares the Session's warmer, which keeps
 * warming after the Run ends; a nested Run, or one without a Session, gets its own.
 */
export async function runWithPromptCacheWarming<T extends Pick<KodaXOptions, 'session'>, R>(
  options: T,
  run: (options: T) => Promise<R>,
): Promise<R> {
  const sessionId = warmerStorage.getStore() ? undefined : options.session?.id;
  const warmer = (sessionId !== undefined ? sessionWarmers.get(sessionId) : undefined)
    ?? createPromptCacheWarmer(sessionId === undefined ? undefined : stopped => forget(sessionId, stopped));
  if (sessionId !== undefined) sessionWarmers.set(sessionId, warmer);
  warmer.enter(AsyncLocalStorage.snapshot());
  try {
    return await warmerStorage.run(warmer, () => run(options));
  } finally {
    warmer.settle(sessionId !== undefined);
    if (sessionId !== undefined && !warmer.active) forget(sessionId, warmer);
  }
}

function forget(sessionId: string, warmer: PromptCacheWarmer): void {
  if (sessionWarmers.get(sessionId) === warmer) sessionWarmers.delete(sessionId);
}

/** `provider.stream` for a Run's own model turns: a completed request becomes the one to keep warm. */
export async function streamKeepingCacheWarm(
  provider: WarmableProvider,
  messages: KodaXMessage[],
  tools: KodaXToolDefinition[],
  system: string,
  reasoning: boolean | KodaXReasoningRequest | undefined,
  options: KodaXProviderStreamOptions,
  signal: AbortSignal | undefined,
): Promise<KodaXStreamResult> {
  const warmer = warmerStorage.getStore();
  const sentAt = Date.now();
  warmer?.requestStarted();
  let result: KodaXStreamResult | undefined;
  try {
    result = await provider.stream(messages, tools, system, reasoning, options, signal);
    return result;
  } finally {
    warmer?.requestEnded(result && {
      request: { provider, messages: [...messages], tools: [...tools], system, reasoning, options: replayOptions(options) },
      sentAt,
      promptTokens: result.usage?.inputTokens,
    });
  }
}

/** The request's own options without its event callbacks, signal, retries or output cap. */
function replayOptions(options: KodaXProviderStreamOptions): KodaXProviderStreamOptions {
  const { signal: _signal, maxOutputTokensOverride: _cap, singleAttempt: _single, ...rest } = options;
  return Object.fromEntries(Object.entries(rest).filter(([key, value]) =>
    !(key.startsWith('on') && typeof value === 'function'))) as KodaXProviderStreamOptions;
}
