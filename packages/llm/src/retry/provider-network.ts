const CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

const beforeHeaders = new WeakSet<object>();
/** Called only when fetch rejects before returning a Response. Stream-body errors are never marked. */
export function markProviderConnectionFailure(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const original = value;
  const seen = new Set<object>();
  while (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    const error = value as { code?: unknown; cause?: unknown };
    if (typeof error.code === 'string' && CONNECTION_CODES.has(error.code)) { beforeHeaders.add(original); return; }
    value = error.cause;
  }
}
export function isProviderConnectionFailure(value: unknown): boolean { return !!value && typeof value === 'object' && beforeHeaders.has(value); }
