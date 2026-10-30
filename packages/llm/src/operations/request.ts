import { withProviderRequestCredential, resolveProviderCredential, redactScopedProviderCredential,
  hasProviderCredentialContext, runWithProviderCredential } from '../provider-credential-context.js';
import { observeProviderAttempt } from '../provider-request-observation.js';
import { nativeResponse } from '../providers/native-http.js';
import type { KodaXTokenUsage } from '../types.js';
import type { KodaXOperationConnection } from './types.js';
import { setTimeout as wait } from 'node:timers/promises';
import { isProviderQuotaError } from '../retry/provider-quota.js';
import { parseRetryAfter, extractHeadersFromError } from '../retry/retry-after.js';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native operation response object.');
  return value as Record<string, unknown>;
}
export function operationUrl(connection: KodaXOperationConnection, path: string): string {
  const url = new URL(connection.baseUrl);
  if (!connection.name.trim() || !connection.model.trim() || url.username || url.password || url.search || url.hash
    || !['https:', 'http:'].includes(url.protocol)
    || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Invalid operation connection.');
  return `${url.href.replace(/\/$/, '')}${path}`;
}
/** Mutating operations are never automatically replayed after ambiguous delivery. */
export function runOperation<T>(connection: KodaXOperationConnection, purpose: 'utility' | 'classifier', signal: AbortSignal | undefined,
  operation: (headers: Headers, signal?: AbortSignal) => Promise<T>, options: { anonymous?: boolean; retry?: boolean } = {}): Promise<T> {
  operationUrl(connection, '');
  return withProviderRequestCredential(connection.name, purpose, signal, async requestSignal => {
      requestSignal?.throwIfAborted();
      const key = resolveProviderCredential(connection.name, connection.credentialSource === 'broker' ? undefined
        : connection.apiKeyEnv ? process.env[connection.apiKeyEnv] : undefined);
      if (!key && !options.anonymous) throw new Error('Operation requires an authorized credential.');
      const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) });
      const execute = async () => {
        try { const result = await retryOperation(() => operation(headers, requestSignal), options.retry === true, requestSignal); requestSignal?.throwIfAborted(); return result; }
        catch (error) { throw redactScopedProviderCredential(error); }
      };
      return key && !hasProviderCredentialContext() ? runWithProviderCredential(connection.name, key, execute) : execute();
    });
}
async function retryOperation<T>(operation: () => Promise<T>, retry: boolean, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (isProviderQuotaError(error)) {
        if (error && typeof error === 'object') Object.assign(error, { metadata: { retryable: false } });
        throw error;
      }
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (!retry || attempt >= 2 || signal?.aborted || ![429, 500, 502, 503, 529].includes(status as number)) throw error;
      const delay = parseRetryAfter(extractHeadersFromError(error), { attempt });
      if (delay.type === 'header' && delay.cappedFromHeader) throw error;
      await wait(delay.waitMs, undefined, { signal });
    }
  }
}
export async function operationJson(connection: KodaXOperationConnection, path: string, headers: Headers,
  signal?: AbortSignal, body?: unknown, method = 'POST'): Promise<Record<string, unknown>> {
  return operationRequest(connection, path, headers, signal, body, value => value, method);
}
export function operationRequest<T>(connection: KodaXOperationConnection, path: string, headers: Headers,
  signal: AbortSignal | undefined, body: unknown, decode: (body: Record<string, unknown>) => T | Promise<T>, method = 'POST'): Promise<T> {
  return observeProviderAttempt(connection.name, connection.model, async () => decode(await readJson(connection, path, headers, signal, body, method)), true);
}
async function readJson(connection: KodaXOperationConnection, path: string, headers: Headers,
  signal: AbortSignal | undefined, body: unknown, method: string): Promise<Record<string, unknown>> {
  const response = await nativeResponse(operationUrl(connection, path), { method, headers, signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  if (!response.body) throw new Error('Native operation returned an empty body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted(); const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 24 * 1024 * 1024) throw new Error('Native operation response exceeds the local processing limit.');
      chunks.push(next.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
}
export function operationUsage(value: unknown): KodaXTokenUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const u = object(value);
  const input = u.input_tokens ?? u.prompt_tokens, output = u.output_tokens ?? u.completion_tokens;
  if (input === undefined || output === undefined) return undefined;
  if (![input, output].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('Invalid native operation usage.');
  return { inputTokens: input as number, outputTokens: output as number, totalTokens: (input as number) + (output as number) };
}
