import { KODAX_PROVIDER_SNAPSHOTS, createOAuthRefreshDriver, openOAuthSession, createFileProviderCredentialStore, createCustomProvider, getProvider, type KodaXCustomProviderConfig } from '@kodax-ai/llm';
import path from 'node:path';
import { getProviderSetupCatalog } from '@kodax-ai/repl';
import { getAgentConfigPath } from '@kodax-ai/agent';
import { createNativeCloudCredentialResolver } from './native-cloud-credentials.js';
import { providerOAuthStore, migrateProviderOAuthRegistration } from './provider-oauth-store.js';
import { createProviderCredentialAuthorizer, type ProviderCredentialSource } from './provider-credential-authorizer.js';

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
      await migrateProviderOAuthRegistration({ configPath, registrationId: connection.oauthRegistration });
      const session = await openOAuthSession({ id: connection.oauthRegistration, store: providerOAuthStore(configPath),
        driver: createOAuthRefreshDriver(connection.oauth) });
      if ((session.profile ?? 'default') !== profile) continue;
      sources.push({ provider: connection.name, kind: 'oauth', service: connection.oauth, session, connectionFingerprint, profile, ...(connection.oauth === 'radius' ? { issuer: connection.baseUrl } : {}) });
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
