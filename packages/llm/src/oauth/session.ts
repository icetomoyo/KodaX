/** OAuth login/ID-token validation and secure persistence belong to the trusted host. */
export type OAuthService = 'openai-chatgpt' | 'openai-codex' | 'github-copilot';

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Unix milliseconds, not the OAuth wire expires_in seconds. */
  /** Omitted only for a non-expiring GitHub OAuth grant (never an inference token). */
  readonly expiresAt?: number;
  readonly scopes?: readonly string[];
  readonly earliestRefreshAt?: number;
}

export interface OAuthSessionRecord {
  /** Unique registration ID. Never reuse it for another account or OAuth client. */
  readonly id: string;
  readonly service: OAuthService;
  readonly clientId: string;
  /** Identity validated during login by the host; never inferred from an email hint. */
  readonly accountId: string;
  readonly credentials?: OAuthTokens;
  /** Copilot's short-lived inference token is distinct from its GitHub OAuth token. */
  readonly resource?: OAuthTokens;
}

export interface OAuthSessionStore {
  /**
   * Hold a per-registration lock across read, refresh and atomic durable commit.
   * Implementations shared by processes MUST lock across processes too. A failed
   * operation/commit must reject and must not expose its result. Records contain secrets.
   */
  transact<T>(id: string, operation: (record: OAuthSessionRecord | undefined) => Promise<{
    record: OAuthSessionRecord | undefined; result: T;
  }>): Promise<T>;
}

export class OAuthCredentialError extends Error {
  constructor(readonly code: 'reauthentication_required' | 'refresh_failed' | 'invalid_session' | 'session_revoked' | 'storage_failed') {
    super(`OAuth credential ${code.replaceAll('_', ' ')}.`);
    this.name = 'OAuthCredentialError';
  }
}

export interface OAuthRefreshDriver {
  refresh(record: OAuthSessionRecord, signal: AbortSignal): Promise<OAuthTokens>;
  /** Copilot exchanges its GitHub token for a separate inference token. */
  exchangeResource?(record: OAuthSessionRecord, signal: AbortSignal): Promise<OAuthTokens>;
  revoke?(record: OAuthSessionRecord, signal: AbortSignal): Promise<void>;
}

export interface OAuthCredentialSession {
  readonly id: string;
  readonly service: OAuthService;
  readonly accountId: string;
  acquire(signal?: AbortSignal): Promise<string>;
  /** Called before local/remote revocation; host bridges must fence old authority immediately. */
  onInvalidate(listener: () => Promise<void>): () => void;
  /** Clears tokens while retaining registration metadata, even if remote revocation fails. */
  revoke(): Promise<{ remote: 'revoked' | 'unsupported' | 'failed'; leaseRevocationFailures: number }>;
}

function validTokens(tokens: OAuthTokens | undefined, requiresExpiry = true): tokens is OAuthTokens {
  return !!tokens?.accessToken.trim() && (!requiresExpiry && tokens.expiresAt === undefined
    || typeof tokens.expiresAt === 'number' && Number.isFinite(tokens.expiresAt) && tokens.expiresAt > 0)
    && (tokens.earliestRefreshAt === undefined || Number.isFinite(tokens.earliestRefreshAt));
}
function due(tokens: OAuthTokens): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() + 30_000 && (tokens.earliestRefreshAt ?? 0) <= Date.now();
}
function sameRegistration(a: OAuthSessionRecord, b: OAuthSessionRecord): boolean {
  return a.id === b.id && a.service === b.service && a.clientId === b.clientId && a.accountId === b.accountId;
}

interface SessionLifetime {
  registration: OAuthSessionRecord;
  controller: AbortController;
  listeners: Set<() => Promise<void>>;
  revoking?: ReturnType<OAuthCredentialSession['revoke']>;
}
// One host/store shares revocation fences across all handles for a registration.
const lifetimes = new WeakMap<OAuthSessionStore, Map<string, SessionLifetime>>();

/** A cancelled consumer does not cancel a shared, rotating refresh transaction. */
async function cancellable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('OAuth request aborted.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export async function openOAuthSession(input: {
  id: string; store: OAuthSessionStore; driver: OAuthRefreshDriver;
}): Promise<OAuthCredentialSession> {
  const { id, store, driver } = input;
  const initial = await store.transact(id, async record => ({ record, result: record }))
    .catch(() => { throw new OAuthCredentialError('storage_failed'); });
  if (!initial || initial.id !== id || !initial.clientId || !initial.accountId
    || !['openai-chatgpt', 'openai-codex', 'github-copilot'].includes(initial.service)) {
    throw new OAuthCredentialError('invalid_session');
  }
  const registration = { ...initial, credentials: undefined, resource: undefined };
  let registrations = lifetimes.get(store);
  if (!registrations) { registrations = new Map(); lifetimes.set(store, registrations); }
  let state = registrations.get(id);
  if (state && !sameRegistration(state.registration, registration)) throw new OAuthCredentialError('invalid_session');
  if (!state) {
    state = { registration, controller: new AbortController(), listeners: new Set() };
    registrations.set(id, state);
  }
  const shared = state;
  const lifetime = shared.controller;
  const listeners = shared.listeners;
  const ensureActive = () => { if (lifetime.signal.aborted) throw new OAuthCredentialError('session_revoked'); };
  return {
    id, service: initial.service, accountId: initial.accountId,
    async acquire(signal) {
      signal?.throwIfAborted();
      ensureActive();
      const pending = store.transact<{ token?: string; error?: OAuthCredentialError }>(id, async record => {
        ensureActive();
        if (!record || !sameRegistration(registration, record)) throw new OAuthCredentialError('invalid_session');
        if (!validTokens(record.credentials, record.service !== 'github-copilot')) throw new OAuthCredentialError('reauthentication_required');
        let next = record;
        let exchangingResource = false;
        const refreshSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);
        try {
          if (record.credentials.expiresAt !== undefined && record.credentials.expiresAt <= Date.now()
            && (record.credentials.earliestRefreshAt ?? 0) > Date.now()) throw new OAuthCredentialError('refresh_failed');
          if (due(record.credentials)) next = { ...next, credentials: await driver.refresh(next, refreshSignal), resource: undefined };
          if (!validTokens(next.credentials, record.service !== 'github-copilot')
            || (next.credentials.expiresAt !== undefined && next.credentials.expiresAt <= Date.now())) throw new OAuthCredentialError('reauthentication_required');
          if (next.service === 'github-copilot' && (!validTokens(next.resource) || due(next.resource))) {
            if (!driver.exchangeResource) throw new OAuthCredentialError('invalid_session');
            exchangingResource = true;
            next = { ...next, resource: await driver.exchangeResource(next, refreshSignal) };
          }
          ensureActive();
          const tokens = next.service === 'github-copilot' ? next.resource : next.credentials;
          if (!validTokens(tokens) || tokens.expiresAt! <= Date.now()) throw new OAuthCredentialError('refresh_failed');
          return { record: next, result: { token: tokens.accessToken, error: undefined } };
        } catch (error) {
          ensureActive();
          const failure = error instanceof OAuthCredentialError ? error : new OAuthCredentialError('refresh_failed');
          // A Copilot 401 does not undo a successful GitHub grant rotation.
          if (exchangingResource) return { record: { ...next, resource: undefined }, result: { error: failure } };
          // Commit the tombstone before reporting invalid_grant. A later Host must not retry stale refresh tokens.
          if (failure.code === 'reauthentication_required') return {
            record: { ...record, credentials: undefined, resource: undefined }, result: { token: undefined, error: failure },
          };
          throw failure;
        }
      }).catch((error: unknown) => { throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('storage_failed'); });
      const result = await cancellable(pending, signal);
      ensureActive();
      if (result.error) throw result.error;
      return result.token!;
    },
    onInvalidate(listener) { ensureActive(); listeners.add(listener); return () => { listeners.delete(listener); }; },
    revoke() {
      if (shared.revoking) return shared.revoking;
      lifetime.abort();
      // Start every fence synchronously, before waiting for storage or an upstream endpoint.
      const fences = Promise.allSettled([...listeners].map(async listener => listener()));
      listeners.clear();
      shared.revoking = (async () => {
        const record = await store.transact(id, async current => {
          if (current && !sameRegistration(registration, current)) throw new OAuthCredentialError('invalid_session');
          return { record: current && { ...current, credentials: undefined, resource: undefined }, result: current };
        }).catch((error: unknown) => { throw error instanceof OAuthCredentialError ? error : new OAuthCredentialError('storage_failed'); });
        let remote: 'revoked' | 'unsupported' | 'failed' = 'unsupported';
        if (driver.revoke && record?.credentials) {
          try { await driver.revoke(record, AbortSignal.timeout(30_000)); remote = 'revoked'; }
          catch { remote = 'failed'; } // Explicitly returned to the host; local logout is already durable.
        }
        const results = await fences;
        registrations.delete(id);
        return { remote, leaseRevocationFailures: results.filter(result => result.status === 'rejected').length };
      })().catch((error: unknown) => { shared.revoking = undefined; throw error; });
      return shared.revoking;
    },
  };
}
