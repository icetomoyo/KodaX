import { AsyncLocalStorage } from 'node:async_hooks';

export type ProviderCredentialPurpose =
  | 'primary'
  | 'fallback'
  | 'classifier'
  | 'sidecar'
  | 'compaction'
  | 'workflow'
  | 'utility';

export interface ProviderCredentialLeaseAccess {
  readonly allowedProviders: readonly string[];
  readonly signal?: AbortSignal;
  readonly isActive?: () => boolean;
  acquire(
    provider: string,
    purpose: ProviderCredentialPurpose,
    signal: AbortSignal,
    attribution?: ProviderCredentialAttribution,
  ): Promise<string>;
}

export type ProviderCredentialAttribution =
  | {
      readonly kind: 'actor_turn';
      readonly actorPath: string;
      readonly turnId: string;
    }
  | {
      readonly kind: 'workflow';
      readonly workflowRunId: string;
    };

export interface ProviderCredentialLeaseScope {
  readonly allowedProviders: readonly string[];
  close(reason?: string): void;
}

interface ExactProviderCredentialScope {
  readonly kind: 'exact';
  readonly provider: string;
  readonly credential: string;
  readonly isActive: () => boolean;
  readonly parentLease?: LeaseProviderCredentialScope;
}

interface LeaseProviderCredentialScope {
  readonly kind: 'lease';
  readonly allowedProviders: ReadonlySet<string>;
  readonly access: ProviderCredentialLeaseAccess;
  readonly controller: AbortController;
  readonly parent?: LeaseProviderCredentialScope;
  readonly attribution?: ProviderCredentialAttribution;
}

interface DenyProviderCredentialScope {
  readonly kind: 'deny';
}

type ProviderCredentialScope =
  | ExactProviderCredentialScope
  | LeaseProviderCredentialScope
  | DenyProviderCredentialScope;

const providerCredentialStorage = new AsyncLocalStorage<ProviderCredentialScope | undefined>();
const leaseScopeInternals = new WeakMap<ProviderCredentialLeaseScope, LeaseProviderCredentialScope>();

/** Run a provider operation with an in-memory, run-scoped credential override. */
export function runWithProviderCredential<T>(
  provider: string,
  credential: string,
  operation: () => T,
): T {
  if (!provider || !credential) throw new Error('Provider credential scope requires non-empty values.');
  let active = true;
  const scope: ExactProviderCredentialScope = {
    kind: 'exact',
    provider,
    credential,
    isActive: () => active,
  };
  try {
    const result = providerCredentialStorage.run(scope, operation);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        active = false;
      }) as T;
    }
    active = false;
    return result;
  } catch (error: unknown) {
    active = false;
    throw error;
  }
}

/** Create an operation-owned resolver scope. No credential material is retained here. */
export function createProviderCredentialLeaseScope(
  access: ProviderCredentialLeaseAccess,
): ProviderCredentialLeaseScope {
  const allowedProviders = normalizeAllowedProviders(access.allowedProviders);
  const internal: LeaseProviderCredentialScope = {
    kind: 'lease',
    allowedProviders: new Set(allowedProviders),
    access,
    controller: new AbortController(),
  };
  const scope: ProviderCredentialLeaseScope = {
    allowedProviders,
    close(reason = 'credential operation completed') {
      if (!internal.controller.signal.aborted) {
        internal.controller.abort(new Error(reason));
      }
    },
  };
  leaseScopeInternals.set(scope, internal);
  return scope;
}

/** Run an operation in a previously created lease scope. */
export function runWithProviderCredentialLeaseScope<T>(
  scope: ProviderCredentialLeaseScope,
  operation: () => T,
): T {
  const internal = leaseScopeInternals.get(scope);
  if (!internal) throw new Error('Unknown provider credential lease scope.');
  return providerCredentialStorage.run(internal, operation);
}

/** Run outside any Runtime Provider credential authority (for external executors). */
export function runWithoutProviderCredentialScope<T>(operation: () => T): T {
  return providerCredentialStorage.run({ kind: 'deny' }, operation);
}

/** Derive a short-lived child from the active lazy lease without exposing its resolver. */
export function deriveCurrentProviderCredentialLeaseScope(
  allowedProviders: readonly string[],
  attribution?: ProviderCredentialAttribution,
): ProviderCredentialLeaseScope | undefined {
  const current = providerCredentialStorage.getStore();
  const parent = current?.kind === 'lease'
    ? current
    : current?.kind === 'exact'
      ? current.parentLease
      : undefined;
  if (!parent) return undefined;
  assertLeaseActive(parent);
  const normalized = normalizeAllowedProviders(allowedProviders, true);
  for (const provider of normalized) {
    if (!parent.allowedProviders.has(provider)) {
      throw new Error(`Parent credential scope does not allow provider ${provider}.`);
    }
  }
  const internal: LeaseProviderCredentialScope = {
    kind: 'lease',
    allowedProviders: new Set(normalized),
    access: parent.access,
    controller: new AbortController(),
    parent,
    ...(attribution === undefined ? {} : { attribution }),
  };
  const scope: ProviderCredentialLeaseScope = {
    allowedProviders: normalized,
    close(reason = 'derived credential operation completed') {
      if (!internal.controller.signal.aborted) {
        internal.controller.abort(new Error(reason));
      }
    },
  };
  leaseScopeInternals.set(scope, internal);
  return scope;
}

/** Concrete Provider authority carried by the active lazy lease, never a wildcard. */
export function currentProviderCredentialLeaseProviders(): readonly string[] | undefined {
  const current = providerCredentialStorage.getStore();
  const lease = current?.kind === 'lease'
    ? current
    : current?.kind === 'exact'
      ? current.parentLease
      : undefined;
  if (!lease) return undefined;
  assertLeaseActive(lease);
  return Object.freeze([...lease.allowedProviders]);
}

/**
 * Resolve one Provider immediately before its wire call. The secret exists only
 * in the nested exact scope and is discarded when the call settles.
 */
export async function withProviderRequestCredential<T>(
  provider: string,
  purpose: ProviderCredentialPurpose,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal | undefined) => Promise<T> | T,
): Promise<T> {
  const current = providerCredentialStorage.getStore();
  if (!current) return operation(signal);
  if (current.kind === 'deny') {
    throw new Error(`Provider credential scope does not allow provider ${provider}.`);
  }
  if (current.kind === 'exact' && current.provider === provider) {
    if (!current.isActive()) throw inactiveCredentialScopeError();
    return operation(signal);
  }
  const lease = current.kind === 'lease' ? current : current.parentLease;
  if (!lease) {
    throw new Error(`Provider credential scope does not allow provider ${provider}.`);
  }
  assertLeaseActive(lease);
  if (!lease.allowedProviders.has(provider)) {
    throw new Error(`Provider credential scope does not allow provider ${provider}.`);
  }
  const requestController = new AbortController();
  const requestSignal = combineAbortSignals([
    signal,
    requestController.signal,
    lease.controller.signal,
    lease.access.signal,
  ]);
  const credential = await lease.access.acquire(
    provider,
    purpose,
    requestSignal,
    lease.attribution,
  );
  assertLeaseActive(lease);
  if (!credential) throw new Error('Provider credential broker returned no credential.');
  const exact: ExactProviderCredentialScope = {
    kind: 'exact',
    provider,
    credential,
    parentLease: lease,
    isActive: () => !requestController.signal.aborted && isLeaseActive(lease),
  };
  try {
    return await providerCredentialStorage.run(exact, async () => {
      try {
        return await operation(requestSignal);
      } catch (error: unknown) {
        throw redactCredentialValue(error, credential, new WeakMap());
      }
    });
  } finally {
    requestController.abort(new Error('provider request completed'));
  }
}

/** Internal provider lookup. The credential is never copied to config or diagnostics. */
export function getScopedProviderCredential(provider: string): string | undefined {
  const scope = providerCredentialStorage.getStore();
  return scope?.kind === 'exact' && scope.provider === provider && scope.isActive()
    ? scope.credential
    : undefined;
}

/** Whether an active scope authorizes a Provider without triggering broker I/O. */
export function hasScopedProviderCredentialAuthority(provider: string): boolean | undefined {
  const scope = providerCredentialStorage.getStore();
  if (!scope) return undefined;
  if (scope.kind === 'deny') return false;
  if (scope.kind === 'exact') {
    if (scope.provider === provider) return scope.isActive();
    return scope.parentLease === undefined
      ? false
      : isLeaseActive(scope.parentLease) && scope.parentLease.allowedProviders.has(provider);
  }
  return isLeaseActive(scope) && scope.allowedProviders.has(provider);
}

/** True while either an exact or lazy credential authority is present. */
export function hasProviderCredentialContext(): boolean {
  return providerCredentialStorage.getStore() !== undefined;
}

/**
 * Resolve a provider credential without escaping an active scope.
 * A mismatched or lazy Provider deliberately receives no ambient fallback.
 */
export function resolveProviderCredential(
  provider: string,
  fallback: string | undefined,
): string | undefined {
  const scope = providerCredentialStorage.getStore();
  if (!scope) return fallback;
  if (scope.kind !== 'exact' || !scope.isActive()) return undefined;
  return scope.provider === provider ? scope.credential : undefined;
}

/** Remove the active exact credential from DTOs before diagnostics or persistence. */
export function redactScopedProviderCredential<T>(value: T): T {
  const scope = providerCredentialStorage.getStore();
  const credential = scope?.kind === 'exact' && scope.isActive()
    ? scope.credential
    : undefined;
  if (!credential) return value;
  return redactCredentialValue(value, credential, new WeakMap()) as T;
}

function normalizeAllowedProviders(
  providers: readonly string[],
  allowEmpty = false,
): readonly string[] {
  const normalized = providers.map((provider) => provider.trim());
  if (
    (!allowEmpty && normalized.length === 0)
    || normalized.some((provider) => provider.length === 0)
    || new Set(normalized).size !== normalized.length
  ) {
    throw new Error('Provider credential lease scope requires non-empty, unique Providers.');
  }
  return Object.freeze(normalized);
}

function isLeaseActive(scope: LeaseProviderCredentialScope): boolean {
  return !scope.controller.signal.aborted
    && (scope.access.signal?.aborted !== true)
    && (scope.access.isActive?.() ?? true)
    && (scope.parent === undefined || isLeaseActive(scope.parent));
}

function assertLeaseActive(scope: LeaseProviderCredentialScope): void {
  if (!isLeaseActive(scope)) throw inactiveCredentialScopeError();
}

function inactiveCredentialScopeError(): Error {
  return new Error('Provider credential lease scope is no longer active.');
}

function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal {
  const present = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined);
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function isPromiseLike<T>(value: T): value is T & PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function';
}

function redactCredentialValue(
  value: unknown,
  credential: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === 'string') return value.split(credential).join('[REDACTED_CREDENTIAL]');
  if (value === null || typeof value !== 'object') return value;
  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (value instanceof Error) {
    const redacted = Object.create(Object.getPrototypeOf(value)) as Error;
    seen.set(value, redacted);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) continue;
      const safeKey = typeof key === 'string'
        ? key.split(credential).join('[REDACTED_CREDENTIAL]')
        : key;
      if (Object.prototype.hasOwnProperty.call(redacted, safeKey)) continue;
      Object.defineProperty(redacted, safeKey, {
        ...descriptor,
        value: redactCredentialValue(descriptor.value, credential, seen),
      });
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    for (const item of value) redacted.push(redactCredentialValue(item, credential, seen));
    return redacted;
  }
  const redacted: Record<string, unknown> = {};
  seen.set(value, redacted);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) continue;
    const safeKey = key.split(credential).join('[REDACTED_CREDENTIAL]');
    redacted[safeKey] = redactCredentialValue(descriptor.value, credential, seen);
  }
  return redacted;
}
