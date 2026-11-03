/** Negotiated trusted-broker carrier. Never persist it or send it to a provider. */
const PREFIX = 'kodax-provider-grant-v1:';
export interface ProviderCredentialGrant {
  readonly provider: string;
  readonly credential: string;
  /** Trusted registration/account/connection epoch digest, never credential authority. */
  readonly identity?: string;
  readonly recoverable?: boolean;
}
function invalid(): never { throw new Error('Invalid provider credential grant.'); }
function validate(provider: string, value: unknown): ProviderCredentialGrant {
  if (!value || typeof value !== 'object') return invalid();
  const record = value as Record<string, unknown>;
  if (record.provider !== provider || !provider.trim() || typeof record.credential !== 'string'
    || !record.credential.trim() || /[\r\n]/.test(record.credential) || record.credential.startsWith(PREFIX)
    || (record.identity !== undefined && (typeof record.identity !== 'string' || !/^[a-f0-9]{64}$/.test(record.identity)))
    || (record.recoverable !== undefined && typeof record.recoverable !== 'boolean')) return invalid();
  return { provider, credential: record.credential,
    ...(typeof record.identity === 'string' ? { identity: record.identity } : {}),
    ...(record.recoverable === true ? { recoverable: true } : {}) };
}
export function serializeProviderCredentialGrant(grant: ProviderCredentialGrant): string {
  return PREFIX + Buffer.from(JSON.stringify(validate(grant.provider, grant))).toString('base64url');
}
export function deserializeProviderCredentialGrant(provider: string, value: string): ProviderCredentialGrant {
  if (!value.startsWith(PREFIX)) return { provider, credential: value };
  if (value.length > 1024 * 1024) return invalid();
  try { return validate(provider, JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8')) as unknown); }
  catch { return invalid(); }
}
