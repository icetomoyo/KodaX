import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import { validateCustomProviderConfig, type KodaXCloudCredentialResolution, type KodaXCustomProviderConfig, type OAuthCredentialSession,
  type FileProviderCredentialStore, type ProviderCredentialFileBinding } from '@kodax-ai/llm';
import type { KodaXClientHostAuthorization, RuntimeScopedCredentialRequest } from './client-host-authorization.js';
import { bindRequestCredentials, type RuntimeRequestCredentialBinding } from './request-credential-binding.js';
import { assertProviderOAuthSessionScope } from './provider-oauth-store.js';
import { acquireOAuthRequestCredential } from './oauth-request-credential.js';
import { cloudRequestCredential } from './cloud-request-credential.js';

export type ProviderCredentialSource = { readonly provider: string; readonly connectionFingerprint?: string; readonly profile?: string } & (
  | { readonly kind: 'external' }
  | { readonly kind: 'environment'; readonly apiKeyEnv: string }
  | { readonly kind: 'api-key'; readonly apiKeyEnv: string; readonly store: FileProviderCredentialStore; readonly binding: ProviderCredentialFileBinding; readonly connectionFingerprint: string }
  | { readonly kind: 'oauth'; readonly session: Pick<OAuthCredentialSession, 'service' | 'profile' | 'issuer' | 'acquire' | 'onInvalidate' | 'replayIdentity' | 'recoverRejectedCredential'>; readonly service: NonNullable<KodaXCustomProviderConfig['oauth']>; readonly profile?: string; readonly issuer?: string }
  | { readonly kind: 'cloud'; readonly connection: KodaXCustomProviderConfig; readonly resolve: (request: RuntimeScopedCredentialRequest, signal: AbortSignal) => Promise<KodaXCloudCredentialResolution> }
);
export interface ProviderCredentialAuthorizer { readonly authorizeExecution: KodaXClientHostAuthorization; close(): Promise<void>; }
/** Trusted Main only. Sources are an explicit allowlist, never supplied by Product/model input. */
export function createProviderCredentialAuthorizer(input: {
  readonly sources: readonly ProviderCredentialSource[];
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
}): ProviderCredentialAuthorizer {
  const sources = new Map(input.sources.map(source => [source.provider, source.kind === 'cloud' ? { ...source, connection: structuredClone(source.connection) } : source.kind === 'api-key' ? { ...source, binding: { ...source.binding } } : { ...source }]));
  if (sources.size !== input.sources.length) throw new Error('Duplicate provider credential source.');
  for (const source of sources.values()) validateSource(source);
  let active: RuntimeRequestCredentialBinding | undefined, epoch: string | undefined, closed = false, invalidated = false;
  let retired: RuntimeRequestCredentialBinding[] = [];
  let serial: Promise<unknown> = Promise.resolve();
  const authorizeExecution: KodaXClientHostAuthorization = (_request, services) => {
    const operation = serial.then(async () => {
      if (closed || invalidated) throw new Error('Provider credential authorizer is closed or revoked.');
      if (!sources.size) return undefined;
      const runtimeId = services.identity?.runtimeId;
      if (!runtimeId) throw new Error('Provider credential authorization requires Host identity.');
      // The lease is bound to the authenticated Host runtimeId. The Host's profile name is not an authority boundary (Issue 406).
      if (!active || epoch !== runtimeId) {
        const previous = active; active = undefined;
        if (previous) try { await previous.close(); }
        catch { retired.push(previous); emitKodaXDiagnostic({ source: 'credential-authorizer', level: 'warn', message: 'Previous Host lease cleanup failed; local authority is fenced and cleanup will be retried.' }); }
        active = await bindRequestCredentials({ credentials: services.credentials, providers: [...sources.keys()],
          acquire: (request, signal) => acquire(sources.get(request.provider)!, request, signal, input.environment),
          onInvalidate: listener => subscribeSources(sources.values(), async () => { invalidated = true; await listener(); }) });
        epoch = runtimeId;
      }
      return { credential: active.credential };
    });
    serial = operation.catch(() => undefined); // The caller receives the original rejection; serialization stays usable.
    return operation;
  };
  return { authorizeExecution, async close() {
    closed = true; await serial;
    const bindings = [...retired, ...(active ? [active] : [])]; active = undefined; retired = [];
    const results = await Promise.allSettled(bindings.map(binding => binding.close()));
    const failures = results.flatMap((result, index) => { if (result.status === 'fulfilled') return []; retired.push(bindings[index]!); return [result.reason as unknown]; });
    if (failures.length) throw new AggregateError(failures, 'Provider credential cleanup failed. Local authority is fenced.');
  } };
}
function validateSource(source: ProviderCredentialSource): void {
  if (!['environment', 'api-key', 'oauth', 'cloud', 'external'].includes(source.kind)) throw new Error('Unknown provider credential source.');
  if (source.connectionFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(source.connectionFingerprint)) throw new Error('Invalid approved connection fingerprint.');
  if (!source.provider.trim()) throw new Error('Credential source requires a provider.');
  if ((source.kind === 'environment' || source.kind === 'api-key') && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.apiKeyEnv)) throw new Error('Invalid approved environment variable.');
  if (source.profile !== undefined && !source.profile.trim()) throw new Error('Invalid approved credential profile.');
  if (source.kind === 'api-key' && (source.binding.provider !== source.provider || source.binding.connectionFingerprint !== source.connectionFingerprint
    || !source.binding.profile.trim() || (source.profile !== undefined && source.profile !== source.binding.profile))) throw new Error('Invalid approved stored credential binding.');
  if (source.kind === 'oauth') assertProviderOAuthSessionScope(source, source.session);
  if (source.kind === 'cloud') {
    validateCustomProviderConfig(source.connection);
    if (!source.connection.cloud || source.connection.name !== source.provider) throw new Error('Cloud credential source requires matching connection metadata.');
  }
}
async function acquire(source: ProviderCredentialSource, request: RuntimeScopedCredentialRequest, signal: AbortSignal,
  environment?: () => Readonly<Record<string, string | undefined>>): Promise<string> {
  signal.throwIfAborted();
  if (source.connectionFingerprint && request.connectionFingerprint !== source.connectionFingerprint) throw new Error('Provider credential connection is not approved.');
  if (request.rejectedCredentialFingerprint !== undefined && (request.credentialContextVersion !== 1
    || !/^[a-f0-9]{64}$/.test(request.rejectedCredentialFingerprint) || source.kind !== 'oauth')) throw new Error('Credential recovery is not supported by this source.');
  if (source.kind === 'external') throw new Error('This provider owns authentication outside the API-key broker.');
  if (source.kind === 'oauth') return acquireOAuthRequestCredential(source.session, request, signal);
  if (source.kind === 'api-key') { const saved = await source.store.readApiKey(source.binding); signal.throwIfAborted(); if (saved) return saved.key; }
  if (source.kind === 'environment' || source.kind === 'api-key') {
    const key = (environment?.() ?? process.env)[source.apiKeyEnv];
    if (!key?.trim()) throw new Error('Approved provider credential is unavailable.');
    return key;
  }
  try {
    const resolved = cloudRequestCredential(source.provider, await source.resolve(request, signal), request.credentialContextVersion);
    const credential = resolved.credential; signal.throwIfAborted();
    const cloud = source.connection.cloud!;
    if ((cloud.service === 'gemini' && credential.type !== 'api-key') || (cloud.service === 'bedrock' && credential.type === 'api-key')
      || (cloud.service !== 'bedrock' && credential.type === 'aws') || (cloud.service === 'vertex' && credential.type === 'bearer' && !cloud.project)) throw new Error('Mismatched cloud credential.');
    return resolved.serialize();
  } catch { signal.throwIfAborted(); throw new Error('Cloud credential broker acquisition failed.'); }
}

function subscribeSources(sources: Iterable<ProviderCredentialSource>, listener: () => Promise<void>): () => void {
  const subscriptions: (() => void)[] = [];
  try { for (const source of sources) if (source.kind === 'oauth') subscriptions.push(source.session.onInvalidate(listener)); }
  catch (error) { for (const unsubscribe of subscriptions) unsubscribe(); throw error; }
  return () => { for (const unsubscribe of subscriptions) unsubscribe(); };
}
