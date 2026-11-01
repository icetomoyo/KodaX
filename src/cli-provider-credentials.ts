import { KODAX_PROVIDER_SNAPSHOTS, createOAuthRefreshDriver, openOAuthSession, createFileProviderCredentialStore, createCustomProvider, getProvider, type KodaXCustomProviderConfig, type OAuthCredentialSession } from '@kodax-ai/llm';
import path from 'node:path';
import { getProviderSetupCatalog } from '@kodax-ai/repl';
import { getAgentConfigPath } from '@kodax-ai/agent';
import { createNativeCloudCredentialResolver } from './native-cloud-credentials.js';
import { providerOAuthStore, migrateProviderOAuthRegistration, assertProviderOAuthSessionScope } from './provider-oauth-store.js';
import { createProviderCredentialAuthorizer, type ProviderCredentialAuthorizer, type ProviderCredentialSource } from './provider-credential-authorizer.js';

/** Share in-flight initialization; a rejected bootstrap never poisons later attempts. */
export function createCliProviderCredentialAccess(config: Parameters<typeof createCliProviderCredentials>[0],
  options: Parameters<typeof createCliProviderCredentials>[1] = {}): ProviderCredentialAuthorizer {
  let pending: ReturnType<typeof createCliProviderCredentials> | undefined, closed = false;
  return {
    async authorizeExecution(request, services) {
      if (closed) throw new Error('CLI provider credential access is closed.');
      const current = pending ??= createCliProviderCredentials(config, options);
      let authorizer: ProviderCredentialAuthorizer;
      try { authorizer = await current; }
      catch (error) { if (pending === current) pending = undefined; throw error; }
      if (closed) throw new Error('CLI provider credential access is closed.');
      return authorizer.authorizeExecution(request, services);
    },
    async close() { closed = true; if (pending) await (await pending).close(); },
  };
}

function deferredSession(scope: { service: NonNullable<KodaXCustomProviderConfig['oauth']>; profile: string; issuer?: string },
  load: () => Promise<OAuthCredentialSession>): Pick<OAuthCredentialSession, 'service' | 'profile' | 'issuer' | 'acquire' | 'onInvalidate'> {
  let pending: Promise<OAuthCredentialSession> | undefined, opened: OAuthCredentialSession | undefined;
  const listeners = new Map<() => Promise<void>, (() => void) | undefined>();
  const open = (): Promise<OAuthCredentialSession> => {
    if (pending) return pending;
    const current = load().then(session => {
      assertProviderOAuthSessionScope(scope, session);
      for (const listener of listeners.keys()) listeners.set(listener, session.onInvalidate(listener));
      opened = session;
      return session;
    }).catch((error: unknown) => {
      for (const [listener, unsubscribe] of listeners) { unsubscribe?.(); listeners.set(listener, undefined); }
      if (pending === current) pending = undefined;
      throw error;
    });
    pending = current; return current;
  };
  return { ...scope,
    async acquire(signal) { signal?.throwIfAborted(); const session = await open(); signal?.throwIfAborted(); return session.acquire(signal); },
    onInvalidate(listener) {
      listeners.set(listener, opened?.onInvalidate(listener));
      return () => { listeners.get(listener)?.(); listeners.delete(listener); };
    },
  };
}

/** CLI is trusted Main. Captured names/routes only; each request resolves current credential material. */
export async function createCliProviderCredentials(config: { customProviders?: KodaXCustomProviderConfig[] }, options: { configPath?: string; profile?: string } = {}) {
  const configPath = options.configPath ?? getAgentConfigPath('config.json'), profile = options.profile ?? 'default';
  const store = createFileProviderCredentialStore(path.join(path.dirname(configPath), 'auth.json'));
  await store.initialize();
  const bindingFor = (name: string, connectionFingerprint: string) => ({ profile, provider: name, connectionFingerprint });
  const sources: ProviderCredentialSource[] = getProviderSetupCatalog().map(provider => {
    const connectionFingerprint = getProvider(provider.name).getCredentialConnectionFingerprint();
    return { profile, provider: provider.name, kind: 'api-key', apiKeyEnv: provider.apiKeyEnv, store, connectionFingerprint, binding: bindingFor(provider.name, connectionFingerprint) };
  });
  sources.push(...Object.entries(KODAX_PROVIDER_SNAPSHOTS).filter(([, profile]) => profile.capabilityProfile.transport === 'cli-bridge').map(([provider]) => ({ provider, kind: 'external' as const, profile })));
  const builtinNames = new Set(sources.map(source => source.provider));
  for (const configured of config.customProviders ?? []) {
    const connection = structuredClone(configured);
    if (builtinNames.has(connection.name)) continue;
    const connectionFingerprint = createCustomProvider(connection).getCredentialConnectionFingerprint(), binding = bindingFor(connection.name, connectionFingerprint);
    if (connection.oauth) {
      if (!connection.oauthRegistration) continue;
      const scope = { service: connection.oauth, profile, ...(connection.oauth === 'radius' ? { issuer: connection.baseUrl } : {}) };
      const session = deferredSession(scope, async () => {
        await migrateProviderOAuthRegistration({ configPath, registrationId: connection.oauthRegistration! });
        return openOAuthSession({ id: connection.oauthRegistration!, store: providerOAuthStore(configPath),
          driver: createOAuthRefreshDriver(connection.oauth!) });
      });
      sources.push({ provider: connection.name, kind: 'oauth', session, connectionFingerprint, ...scope });
    } else if (connection.cloud) {
      const resolve = createNativeCloudCredentialResolver(connection);
      sources.push({ provider: connection.name, kind: 'cloud', connection, connectionFingerprint, profile, resolve: async (_request, signal) => {
        const saved = await store.readApiKey(binding); signal.throwIfAborted();
        return saved ? connection.cloud!.service === 'bedrock' ? { type: 'bearer', token: saved.key } : { type: 'api-key', key: saved.key } : resolve(signal);
      } });
    } else sources.push({ provider: connection.name, kind: 'api-key', profile, apiKeyEnv: connection.apiKeyEnv, store, binding, connectionFingerprint });
  }
  return createProviderCredentialAuthorizer({ sources });
}
