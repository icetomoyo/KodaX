/**
 * FEATURE_316: keep the provider's prompt cache warm while a Run waits for a person.
 *
 * Each completed model request is remembered. While an approval, a question or a
 * plan exit is pending, the remembered request is resent with a one-token output
 * cap shortly before its cache entry expires. The resend goes out as purpose
 * `cache_refresh`, so Session statistics count it apart from model turns, and its
 * reply never reaches the transcript or the model context.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  cacheRefreshDelayMs,
  cacheRefreshPrices,
  getCostRate,
  promptCacheLifetime,
  promptCacheLifetimeMs,
  replaysWithOutputCap,
  resolvePromptCacheDisabled,
  withProviderRequestCredential,
  type CacheRefreshPrices,
  type KodaXBaseProvider,
  type KodaXMessage,
  type KodaXProviderStreamOptions,
  type KodaXReasoningRequest,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { KodaXEvents } from '../types.js';

/** Warming never goes on longer than this after the last real request. */
export const MAX_CACHE_WARMING_MS = 60 * 60_000;

type WarmableProvider = Pick<KodaXBaseProvider, 'name' | 'stream' | 'getModel' | 'getCacheCapabilities'
  | 'getReasoningCapability' | 'getReasoningProfile'>;

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
  /** When the entry was last read or written: the real request, then each refresh. */
  touchedAt: number;
  refreshes: number;
}

export interface PromptCacheWarmer {
  /** The request that just completed; its cache entry is the one to keep warm. */
  remember(request: ModelRequest, sentAt: number, promptTokens: number | undefined): void;
  /** Keep the remembered entry warm while `wait` is pending. */
  during<T>(wait: () => Promise<T>): Promise<T>;
  dispose(): void;
}

export function createPromptCacheWarmer(): PromptCacheWarmer {
  let target: WarmTarget | undefined;
  let waits = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: AbortController | undefined;
  let runInRunContext: (<R>(fn: () => R) => R) | undefined;

  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (): void => {
    disarm();
    const armed = target;
    if (!armed || waits === 0 || inFlight) return;
    const due = armed.touchedAt + armed.delayMs;
    // Warm requests never extend this window: it counts from the last real request.
    if (due > armed.sentAt + MAX_CACHE_WARMING_MS) return;
    const run = runInRunContext;
    timer = setTimeout(() => { void (run ? run(() => refresh(armed)) : refresh(armed)); }, Math.max(0, due - Date.now()));
    timer.unref?.();
  };
  const refresh = async (armed: WarmTarget): Promise<void> => {
    timer = undefined;
    if (target !== armed || waits === 0) return;
    // A timer that fires late (sleep, a blocked event loop) keeps half the margin for the
    // request itself; later than that the entry is likely gone and a resend would rewrite it.
    if (Date.now() > armed.touchedAt + armed.delayMs + (armed.lifetimeMs - armed.delayMs) / 2) return;
    // All refreshes during this wait together must cost less than losing the entry once.
    if ((armed.refreshes + 1) * armed.prices.refresh >= armed.prices.loss) return;
    const controller = new AbortController();
    inFlight = controller;
    const startedAt = Date.now();
    try {
      await withProviderRequestCredential(armed.provider, 'cache_refresh', controller.signal, signal =>
        armed.provider.stream(armed.messages, armed.tools, armed.system, armed.reasoning,
          { ...armed.options, maxOutputTokensOverride: 1, singleAttempt: true, signal }, signal));
      armed.touchedAt = startedAt;
      armed.refreshes += 1;
    } catch {
      // Best effort: the provider observation already records the failed request in the
      // Session statistics, and the Run itself must not notice. Stop warming this entry.
      if (target === armed) target = undefined;
      return;
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
    arm();
  };

  return {
    remember(request, sentAt, promptTokens) {
      target = undefined;
      disarm();
      const model = request.options.modelOverride ?? request.provider.getModel();
      const lifetime = promptCacheLifetime(request.provider.getCacheCapabilities(model),
        request.options.cacheRetention, resolvePromptCacheDisabled());
      if (!lifetime || !replaysWithOutputCap(request.provider, model, request.reasoning)) return;
      const lifetimeMs = promptCacheLifetimeMs(lifetime);
      const delayMs = cacheRefreshDelayMs(lifetimeMs);
      const rate = getCostRate(request.provider.name, model);
      const prices = rate && promptTokens !== undefined ? cacheRefreshPrices(rate, promptTokens, lifetime) : undefined;
      if (delayMs === undefined || !prices) return;
      target = { ...request, sentAt, lifetimeMs, delayMs, prices, touchedAt: sentAt, refreshes: 0 };
      arm();
    },
    async during(wait) {
      waits += 1;
      // Refreshes run in the Run's async context: its credentials, scoped config and observers.
      if (waits === 1) { runInRunContext = AsyncLocalStorage.snapshot(); arm(); }
      try {
        return await wait();
      } finally {
        waits -= 1;
        if (waits === 0) { disarm(); runInRunContext = undefined; }
      }
    },
    dispose() {
      target = undefined;
      disarm();
      inFlight?.abort();
    },
  };
}

const warmerStorage = new AsyncLocalStorage<PromptCacheWarmer>();

/** Event callbacks that wait for a person; while one is pending the cache is kept warm. */
const WAITING_EVENTS = ['beforeToolExecute', 'requestToolApproval', 'askUser', 'askUserMulti', 'askUserInput', 'exitPlanMode'] as const;

function warmDuringWaits(events: KodaXEvents | undefined, warmer: PromptCacheWarmer): KodaXEvents | undefined {
  if (!events) return events;
  const wrapped: Record<string, unknown> = { ...events };
  for (const name of WAITING_EVENTS) {
    const original = events[name] as ((...args: unknown[]) => unknown) | undefined;
    if (original) wrapped[name] = (...args: unknown[]) => warmer.during(async () => original.apply(events, args));
  }
  return wrapped as KodaXEvents;
}

/** Run one Run with its own warmer; nested Runs get their own. */
export async function runWithPromptCacheWarming<T extends { events?: KodaXEvents }, R>(
  options: T,
  run: (options: T) => Promise<R>,
): Promise<R> {
  const warmer = createPromptCacheWarmer();
  try {
    return await warmerStorage.run(warmer, () => run({ ...options, events: warmDuringWaits(options.events, warmer) }));
  } finally {
    warmer.dispose();
  }
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
  const sentAt = Date.now();
  const result = await provider.stream(messages, tools, system, reasoning, options, signal);
  warmerStorage.getStore()?.remember({ provider, messages: [...messages], tools: [...tools], system, reasoning,
    options: replayOptions(options) }, sentAt, result.usage?.inputTokens);
  return result;
}

/** The request's own options without its event callbacks, signal, retries or output cap. */
function replayOptions(options: KodaXProviderStreamOptions): KodaXProviderStreamOptions {
  const { signal: _signal, maxOutputTokensOverride: _cap, singleAttempt: _single, ...rest } = options;
  return Object.fromEntries(Object.entries(rest).filter(([key, value]) =>
    !(key.startsWith('on') && typeof value === 'function'))) as KodaXProviderStreamOptions;
}
