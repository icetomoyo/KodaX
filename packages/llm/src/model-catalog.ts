import { createHash, randomUUID } from 'node:crypto';
import { operationUrl, readOperationJson, runOperation } from './operations/request.js';
import { observeProviderAttempt } from './provider-request-observation.js';
import { nativeFetch } from './providers/native-http.js';
import { decodeModelCatalog } from './model-catalog-decode.js';
import type { KodaXModelCatalogConnection, KodaXModelCatalogSnapshot, KodaXModelCatalogStore,
  KodaXRefreshModelCatalogOptions, KodaXRefreshModelCatalogResult } from './model-catalog-types.js';

/** Useful standalone default; persistent storage and its atomic transaction belong to the trusted Host. */
export function createMemoryModelCatalogStore(): KodaXModelCatalogStore {
  const snapshots = new Map<string, KodaXModelCatalogSnapshot>();
  return {
    async read(scope, signal) { signal?.throwIfAborted(); const value = snapshots.get(scope); return value ? structuredClone(value) : undefined; },
    async compareAndSwap(scope, expected, snapshot, options) {
      options.signal?.throwIfAborted();
      if (!options.isCurrent() || snapshots.get(scope)?.revision !== expected) return false;
      snapshots.set(scope, structuredClone(snapshot)); return true;
    },
  };
}
const defaultStore = createMemoryModelCatalogStore();
const pending = new WeakMap<KodaXModelCatalogStore, Map<string, AbortController>>();
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function source(connection: KodaXModelCatalogConnection) {
  if (!['openai-models', 'openrouter-user-models', 'radius-config'].includes(connection.api)
    || typeof connection.accountScope !== 'string' || !connection.accountScope.trim()) throw new Error('Catalog refresh requires an explicit API and trusted account scope.');
  const base = operationUrl(connection, '');
  const url = connection.api === 'radius-config' ? new URL('/v1/config', base)
    : new URL(`${base}${connection.api === 'openrouter-user-models' ? '/models/user' : '/models'}`);
  return { url, scope: digest([connection.name, connection.api, base, connection.accountScope]) };
}
function storedSnapshot(value: KodaXModelCatalogSnapshot | undefined, scope: string): KodaXModelCatalogSnapshot | undefined {
  if (value === undefined) return undefined;
  if (value.version !== 1 || value.scope !== scope || typeof value.revision !== 'string' || !Array.isArray(value.models) || !Number.isFinite(value.checkedAt)
    || (value.etag !== undefined && (typeof value.etag !== 'string' || value.etag.length > 4096 || /[\r\n]/.test(value.etag)))
    || (value.lastModified !== undefined && !Number.isFinite(Date.parse(value.lastModified)))) throw new Error('Invalid stored model catalog snapshot.');
  return structuredClone(value);
}
export async function refreshProviderModelCatalog(connection: KodaXModelCatalogConnection, options: KodaXRefreshModelCatalogOptions = {}): Promise<KodaXRefreshModelCatalogResult> {
  connection = structuredClone(connection); options = { ...options };
  const { url, scope } = source(connection), store = options.store ?? defaultStore;
  const timeout = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('Invalid catalog refresh timeout.');
  const slots = pending.get(store) ?? new Map<string, AbortController>(); pending.set(store, slots);
  const controller = new AbortController(); slots.get(scope)?.abort(new Error('Catalog refresh superseded.')); slots.set(scope, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout), ...(options.signal ? [options.signal] : [])]);
  const isCurrent = () => slots.get(scope) === controller && !signal.aborted && options.isCurrent?.() !== false;
  try {
    const prior = storedSnapshot(await store.read(scope, signal), scope);
    if (!isCurrent()) return { status: 'stale' };
    return await runOperation(connection, 'utility', signal, (headers, activeSignal) => observeProviderAttempt(connection.name, connection.model, async () => {
      if (prior?.etag) headers.set('if-none-match', prior.etag);
      if (prior?.lastModified) headers.set('if-modified-since', prior.lastModified);
      const response = await nativeFetch(url.href, { method: 'GET', headers, signal: activeSignal }, true);
      if (!isCurrent() || activeSignal?.aborted) return { status: 'stale' };
      if ([401, 403, 404].includes(response.status)) { await response.body?.cancel(); return { status: 'unavailable', httpStatus: response.status, ...(prior ? { snapshot: prior } : {}) }; }
      if (response.status !== 304 && !response.ok) throw Object.assign(new Error(`Model catalog HTTP ${response.status}.`), { status: response.status, headers: response.headers });
      if (response.status === 304 && !prior) throw new Error('Model catalog returned 304 without a matching snapshot.');
      const checkedAt = Date.now();
      const snapshot: KodaXModelCatalogSnapshot = response.status === 304 ? { ...prior!, checkedAt, revision: randomUUID() }
        : { version: 1, revision: randomUUID(), scope, checkedAt, source: { api: connection.api, origin: url.origin, pathHash: digest(url.pathname) },
          ...decodeModelCatalog(connection, await readOperationJson(response, activeSignal), checkedAt),
          ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
          ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}) };
      storedSnapshot(snapshot, scope);
      const committed = await store.compareAndSwap(scope, prior?.revision, snapshot, { signal: activeSignal,
        isCurrent: () => isCurrent() && !activeSignal?.aborted });
      if (!committed || !isCurrent()) return { status: 'stale' };
      return { status: response.status === 304 ? 'not-modified' : 'updated', snapshot: structuredClone(snapshot) };
    }, true));
  } catch (error) { if (slots.get(scope) !== controller) return { status: 'stale' }; throw error; }
  finally { if (slots.get(scope) === controller) slots.delete(scope); }
}
