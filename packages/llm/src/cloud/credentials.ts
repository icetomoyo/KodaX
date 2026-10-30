/** Request-only credentials. Never persist the serialized carrier in configuration or history. */
export type KodaXCloudCredential =
  | { readonly type: 'api-key'; readonly key: string }
  | { readonly type: 'bearer'; readonly token: string; readonly expiresAt?: number }
  | { readonly type: 'aws'; readonly accessKeyId: string; readonly secretAccessKey: string;
      readonly sessionToken?: string; readonly expiresAt?: number };

const PREFIX = 'kodax-cloud-v1:';
export function isCloudCredentialCarrier(value: string): boolean { return value.startsWith(PREFIX); }
function invalid(): never { throw new Error('Invalid or expired cloud request credential.'); }
function secret(value: unknown): string {
  return typeof value === 'string' && value.trim() && !/[\r\n]/.test(value) ? value : invalid();
}
function normalize(value: unknown): KodaXCloudCredential {
  if (!value || typeof value !== 'object') return invalid();
  const record = value as Record<string, unknown>;
  const expiry = record.expiresAt;
  if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= Date.now())) return invalid();
  const expiresAt = expiry as number | undefined;
  switch (record.type) {
    case 'api-key': return { type: 'api-key', key: secret(record.key) };
    case 'bearer': return { type: 'bearer', token: secret(record.token), ...(expiresAt === undefined ? {} : { expiresAt }) };
    case 'aws': return { type: 'aws', accessKeyId: secret(record.accessKeyId), secretAccessKey: secret(record.secretAccessKey),
      ...(record.sessionToken === undefined ? {} : { sessionToken: secret(record.sessionToken) }),
      ...(expiresAt === undefined ? {} : { expiresAt }) };
    default: return invalid();
  }
}
export function serializeCloudCredential(provider: string, credential: KodaXCloudCredential): string {
  if (!provider.trim()) return invalid();
  return PREFIX + Buffer.from(JSON.stringify({ provider, credential: normalize(credential) })).toString('base64url');
}
function unpack(value: string): { provider: string; credential: unknown } {
  try {
    if (!isCloudCredentialCarrier(value)) return invalid();
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return invalid();
    const record = parsed as Record<string, unknown>;
    if (typeof record.provider !== 'string' || !record.provider.trim()) return invalid();
    return { provider: record.provider, credential: record.credential };
  } catch { return invalid(); }
}
export function deserializeCloudCredential(provider: string, value: string): KodaXCloudCredential {
  const record = unpack(value);
  if (record.provider !== provider) return invalid();
  return normalize(record.credential);
}
/** Redaction must still work after an access token has expired. */
export function cloudCredentialSecrets(value: string): readonly string[] {
  if (!isCloudCredentialCarrier(value)) return [];
  try {
    const credential = unpack(value).credential;
    if (!credential || typeof credential !== 'object') return [];
    const record = credential as Record<string, unknown>;
    return ['key', 'token', 'accessKeyId', 'secretAccessKey', 'sessionToken']
      .flatMap(key => typeof record[key] === 'string' && record[key] ? [record[key] as string] : []);
  } catch { return []; } // Malformed carriers have no unpacked secrets; the full carrier is always redacted.
}
