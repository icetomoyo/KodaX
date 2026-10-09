import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { KodaXTokenUsage } from './types.js';
import type { ProviderCredentialAttribution, ProviderCredentialPurpose } from './provider-credential-context.js';

export interface ProviderRequestObservation {
  /** pending is a native fetch adapter's provisional boundary; unavailable is operation-only. */
  readonly wireObservation?: 'pending' | 'observed' | 'unavailable';
  readonly route?: { readonly chainId: string; readonly attempt: number; readonly fromProvider?: string };
  readonly requestId: string;
  readonly logicalRequestId: string;
  readonly provider: string;
  readonly model?: string;
  readonly purpose: ProviderCredentialPurpose;
  readonly attribution?: ProviderCredentialAttribution;
  readonly attempt: number;
  readonly boundary: 'physical_attempt' | 'provider_operation';
  readonly dispatch: 'dispatched' | 'unknown';
  readonly state: 'started' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly usage?: KodaXTokenUsage;
}
type Observer = (fact: ProviderRequestObservation) => void;
interface RequestContext {
  readonly provider: string; readonly purpose: ProviderCredentialPurpose;
  readonly attribution?: ProviderCredentialAttribution; readonly logicalRequestId: string;
  attempts: number;
  readonly signal?: AbortSignal;
  operationFact?: ProviderRequestObservation;
  wire?: WireContext;
}
interface WireContext { readonly provider: string; readonly model?: string; current?: ProviderRequestObservation; }
const observers = new AsyncLocalStorage<Observer>();
const requests = new AsyncLocalStorage<RequestContext>();
const wires = new AsyncLocalStorage<WireContext>();
const abortSignals = new AsyncLocalStorage<AbortSignal>();
const attributions = new AsyncLocalStorage<ProviderCredentialAttribution>();
/** Execution identity is observational and exists independently of credential authority. */
export function runWithProviderRequestAttribution<T>(attribution: ProviderCredentialAttribution, operation: () => T): T {
  return attributions.run(attribution, operation);
}
export function currentProviderRequestAttribution(): ProviderCredentialAttribution | undefined { return attributions.getStore(); }
const routes = new AsyncLocalStorage<NonNullable<ProviderRequestObservation['route']>>();
export function runWithProviderRequestRoute<T>(route: NonNullable<ProviderRequestObservation['route']>, operation: () => T): T {
  return routes.run(route, operation);
}
export function runWithProviderRequestAbortSignal<T>(signal: AbortSignal, operation: () => T): T {
  return abortSignals.run(signal, operation);
}
export function currentProviderRequestAbortSignal(): AbortSignal | undefined { return abortSignals.getStore(); }
export function runWithProviderRequestObserver<T>(observer: Observer, operation: () => T): T {
  return observers.run(observer, operation);
}
export async function observeProviderAttempt<T>(provider: string, model: string | undefined, operation: () => Promise<T>, observesFetch = false): Promise<T> {
  const observer = observers.getStore();
  if (!observer) return operation();
  const context = requests.getStore();
  if (context?.operationFact && context.attempts === 0 && observesFetch) {
    context.operationFact = { ...context.operationFact, model, wireObservation: 'pending' };
    observer(context.operationFact);
  }
  const wire: WireContext = { provider, model };
  try {
    const result = await wires.run(wire, operation);
    finishWire(wire, result);
    return result;
  } catch (error: unknown) {
    finishWire(wire, undefined, error);
    throw error;
  }
}
function usageFrom(result: unknown): KodaXTokenUsage | undefined {
  const usage = result !== null && typeof result === 'object' && 'usage' in result ? result.usage : undefined;
  return usage !== null && typeof usage === 'object' && 'inputTokens' in usage && 'outputTokens' in usage ? usage as KodaXTokenUsage : undefined;
}
function finishWire(wire: WireContext, result: unknown, error?: unknown): void {
  if (!wire.current || wire.current.state !== 'started') return;
  const cancelled = requests.getStore()?.signal?.aborted || abortSignals.getStore()?.aborted
    || (error instanceof Error && error.name === 'AbortError');
  wire.current = { ...wire.current, state: error === undefined ? 'succeeded' : cancelled ? 'cancelled' : 'failed',
    endedAt: new Date().toISOString(), usage: usageFrom(result) };
  observers.getStore()?.(wire.current);
}
/** Actual SDK fetch boundary, including SDK-internal HTTP retries. Records no payload or secret. */
export function observeProviderFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const observer = observers.getStore();
    const context = requests.getStore();
    if (!observer || !context) return fetcher(input, init);
    const wire = wires.getStore() ?? (context.wire ??= { provider: context.provider });
    if (wire.current?.state === 'started') finishWire(wire, undefined, new Error('Provider request replaced.'));
    context.attempts += 1;
    wire.current = { requestId: context.attempts === 1 && context.operationFact ? context.operationFact.requestId : `physical_${randomUUID()}`, logicalRequestId: context.logicalRequestId,
      provider: wire.provider, model: wire.model, purpose: context.purpose, attribution: context.attribution,
      route: routes.getStore(),
      attempt: context.attempts, boundary: 'physical_attempt', wireObservation: 'observed', dispatch: 'dispatched', state: 'started', startedAt: new Date().toISOString() };
    observer(wire.current);
    try {
      const response = await fetcher(input, init);
      if (!response.ok) finishWire(wire, undefined, new Error('Provider HTTP request failed.'));
      return response;
    } catch (error: unknown) { finishWire(wire, undefined, error); throw error; }
  };
}
export async function observeProviderOperation<T>(provider: string, purpose: ProviderCredentialPurpose,
  attribution: ProviderCredentialAttribution | undefined, operation: () => Promise<T>, logicalRequestId?: string, signal?: AbortSignal): Promise<T> {
  if (!observers.getStore()) return operation();
  const context: RequestContext = { provider, purpose, attribution, logicalRequestId: logicalRequestId ?? `logical_${randomUUID()}`, attempts: 0, signal };
  return requests.run(context, async () => {
    // Native HTTP adapters report their own physical attempts. Other adapters
    // retain an explicitly weaker operation boundary, never invented wire calls.
    const startedAt = new Date().toISOString();
    context.operationFact = { requestId: `request_${randomUUID()}`, logicalRequestId: context.logicalRequestId,
      provider, purpose, attribution, route: routes.getStore(), attempt: 1, boundary: 'provider_operation', wireObservation: 'unavailable', dispatch: 'unknown', state: 'started', startedAt };
    observers.getStore()!(context.operationFact);
    try {
      const value = await operation();
      if (context.wire) finishWire(context.wire, value);
      if (context.attempts === 0) observers.getStore()!({ ...context.operationFact, state: 'succeeded',
        endedAt: new Date().toISOString(), usage: usageFrom(value) });
      return value;
    } catch (error: unknown) {
      if (context.wire) finishWire(context.wire, undefined, error);
      if (context.attempts === 0) {
        const observer = observers.getStore()!;
        observer({ ...context.operationFact, state: signal?.aborted ? 'cancelled' : 'failed', endedAt: new Date().toISOString() });
      }
      throw error;
    }
  });
}
