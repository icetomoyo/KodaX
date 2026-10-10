/**
 * FEATURE_102 Phase 3 (v0.7.45) — cross-provider fallback for child dispatch.
 *
 * The LLM layer already retries the SAME provider on rate-limit / transient
 * errors (`withRateLimit`, 3 attempts + retry-after). This adds the next step:
 * when the primary provider is *exhausted or down* (rate-limit retries gave up,
 * a 5xx, or a network failure), re-run the child once on the next provider in
 * an operator-configured chain instead of failing the whole child.
 *
 * Scope is deliberately minimal (KodaX 极简): only hard transport/availability
 * errors trigger fallback. A child that returned an ordinary `success:false` is a
 * task outcome, not a provider outage, so it is NOT retried elsewhere. Aborts
 * (user cancel) are never faked over.
 *
 * Configured via `KODAX_FALLBACK_PROVIDERS` (comma-separated provider ids). The
 * REPL `/fallback` command + `~/.kodax/config.json` mirror into this env var;
 * an empty/unset list means fallback is OFF (no separate toggle).
 */
import { randomUUID } from 'node:crypto';
import { KodaXNetworkError, KodaXProviderError, KodaXRateLimitError,
  runWithAdditionalProviderRequestObserver, runWithProviderRequestRoute } from '@kodax-ai/llm';

import type { KodaXOptions, KodaXResult } from './types.js';

type RunKodaXFn = (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;

/** Parse the operator-configured fallback chain. Empty when unset → OFF. */
export function resolveFallbackChain(): string[] {
  const raw = process.env.KODAX_FALLBACK_PROVIDERS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Only hard provider-availability errors are fallback-eligible. A returned
 * ordinary task outcome is explicitly NOT eligible — switching
 * providers because the agent didn't finish the task would mask real failures.
 */
export function isFallbackEligibleError(error: unknown): boolean {
  return (
    error instanceof KodaXRateLimitError ||
    error instanceof KodaXNetworkError ||
    error instanceof KodaXProviderError
  );
}

function errorReason(error: unknown): string {
  if (error instanceof KodaXRateLimitError) return 'rate-limit exhausted';
  if (error instanceof KodaXNetworkError) return 'network error';
  if (error instanceof KodaXProviderError) return 'provider error';
  return error instanceof Error ? error.message : String(error);
}

function unavailableProviderResult(result: KodaXResult): boolean {
  const failure = result.failure;
  if (result.success || result.interrupted || !failure || failure.source === 'local' || failure.errorClass === 'local_execution_error' || failure.failureCode) return false;
  if (failure.httpStatus !== undefined) return failure.httpStatus === 429 || failure.httpStatus >= 500;
  return ['rate_limit', 'provider_overloaded', 'connection_failure', 'request_timeout', 'stream_idle_timeout', 'chunk_timeout']
    .includes(failure.errorClass);
}

export function readChildTokenUsage(result: KodaXResult): number {
  const candidate = result.totalTokensUsed
    ?? result.usage?.totalTokens
    ?? result.contextTokenSnapshot?.usage?.totalTokens
    ?? result.contextTokenSnapshot?.currentTokens
    ?? 0;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

function addUsage(previous: KodaXResult['usage'], current: NonNullable<KodaXResult['usage']>): NonNullable<KodaXResult['usage']> {
  const aggregate: NonNullable<KodaXResult['usage']> = {
    inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
    totalTokens: (previous?.totalTokens ?? 0) + current.totalTokens,
  };
  for (const field of ['cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens'] as const) {
    if (previous?.[field] !== undefined || current[field] !== undefined) {
      aggregate[field] = (previous?.[field] ?? 0) + (current[field] ?? 0);
    }
  }
  return aggregate;
}

export interface ChildFallbackHooks {
  /** Completed-attempt totals remain observable if a later attempt throws. */
  readonly onUsage?: (totalTokensUsed: number) => void;
  /** Notified just before each fallback attempt (for progress/trace). */
  readonly onFallback?: (info: {
    readonly fromProvider: string;
    readonly toProvider: string;
    readonly reason: string;
  }) => void;
  /** Runtime authority ceiling; unauthorized providers are never attempted. */
  readonly isProviderAllowed?: (provider: string) => boolean;
}

/**
 * Run a child via `run`, falling back across the configured provider chain on
 * hard availability errors. The fallback attempt clears `model` (the primary's
 * model id won't exist on another provider) so the fallback provider uses its
 * own default. Ineligible errors and aborts propagate unchanged.
 */
export async function invokeChildWithFallback(
  options: KodaXOptions,
  prompt: string,
  run: RunKodaXFn,
  hooks?: ChildFallbackHooks,
): Promise<KodaXResult> {
  const primary = options.provider ?? 'anthropic';
  const chainId = `route_${randomUUID()}`;
  let routeAttempt = 0;
  let previousProvider: string | undefined;
  let usage: KodaXResult['usage'];
  let usageComplete = true;
  let totalTokensUsed = 0;
  let outcome: { result: KodaXResult } | { error: unknown };
  const attempt = async (selection: KodaXOptions): Promise<typeof outcome> => {
    const route = { chainId, attempt: ++routeAttempt, fromProvider: previousProvider };
    previousProvider = selection.provider ?? primary;
    // Request facts precede continuation, tool execution, and UI epilogues.
    // Nested children install their own route and account their own requests.
    const requests = new Map<string, KodaXResult['usage']>();
    const observedUsage = (): KodaXResult['usage'] => {
      let aggregate: KodaXResult['usage'];
      for (const current of requests.values()) {
        if (current !== undefined) aggregate = addUsage(aggregate, current);
      }
      return aggregate;
    };
    let result: KodaXResult;
    try {
      result = await runWithProviderRequestRoute(route, () => runWithAdditionalProviderRequestObserver(fact => {
        if (fact.route?.chainId === chainId && fact.route.attempt === route.attempt && fact.state !== 'started') {
          requests.set(fact.requestId, fact.usage);
        }
      }, () => run(selection, prompt)));
    } catch (error) {
      usageComplete = false;
      const observedTokens = observedUsage()?.totalTokens ?? 0;
      if (observedTokens > 0) {
        totalTokensUsed += observedTokens;
        hooks?.onUsage?.(totalTokensUsed);
      }
      return { error };
    }
    const observed = observedUsage();
    const observedTokens = observed?.totalTokens ?? 0;
    totalTokensUsed += Math.max(readChildTokenUsage(result), observedTokens);
    hooks?.onUsage?.(totalTokensUsed);
    const current = observed !== undefined && observedTokens >= (result.usage?.totalTokens ?? 0) ? observed : result.usage;
    if (current === undefined || [...requests.values()].some(value => value === undefined)) usageComplete = false;
    else usage = addUsage(usage, current);
    return { result };
  };
  outcome = await attempt(options);
  const chain = resolveFallbackChain().filter(candidate => candidate !== primary
    && (hooks?.isProviderAllowed?.(candidate) ?? true));
  for (const toProvider of chain) {
    const eligible = 'result' in outcome ? unavailableProviderResult(outcome.result) : isFallbackEligibleError(outcome.error);
    if (options.abortSignal?.aborted || !eligible) break;
    hooks?.onFallback?.({ fromProvider: primary, toProvider,
      reason: 'result' in outcome ? outcome.result.failure!.message : errorReason(outcome.error) });
    outcome = await attempt({ ...options, provider: toProvider, model: undefined });
  }
  if ('result' in outcome) return routeAttempt === 1 && totalTokensUsed <= readChildTokenUsage(outcome.result)
      && (usageComplete ? usage?.totalTokens === outcome.result.usage?.totalTokens : outcome.result.usage === undefined) ? outcome.result
    : { ...outcome.result, totalTokensUsed, usage: usageComplete ? usage : undefined };
  throw outcome.error;
}
