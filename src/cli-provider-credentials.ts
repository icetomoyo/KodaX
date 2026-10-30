import { KODAX_PROVIDER_SNAPSHOTS, createOAuthRefreshDriver, openOAuthSession, type KodaXCustomProviderConfig } from '@kodax-ai/llm';
import { getProviderSetupCatalog } from '@kodax-ai/repl';
import { getAgentConfigPath } from '@kodax-ai/agent';
import { createNativeCloudCredentialResolver } from './native-cloud-credentials.js';
import { providerOAuthStore } from './provider-auth-cli.js';
import { createProviderCredentialAuthorizer, type ProviderCredentialSource } from './provider-credential-authorizer.js';

/** CLI is trusted Main. Captured names/routes only; each request resolves current credential material. */
export async function createCliProviderCredentials(config: { customProviders?: KodaXCustomProviderConfig[] }) {
  const sources: ProviderCredentialSource[] = getProviderSetupCatalog().map(provider => ({ provider: provider.name, kind: 'environment', apiKeyEnv: provider.apiKeyEnv }));
  sources.push(...Object.entries(KODAX_PROVIDER_SNAPSHOTS).filter(([, profile]) => profile.capabilityProfile.transport === 'cli-bridge').map(([provider]) => ({ provider, kind: 'external' as const })));
  const builtinNames = new Set(sources.map(source => source.provider));
  for (const connection of config.customProviders ?? []) {
    if (builtinNames.has(connection.name)) continue;
    if (connection.oauth) {
      if (!connection.oauthRegistration) continue;
      const session = await openOAuthSession({ id: connection.oauthRegistration, store: providerOAuthStore(getAgentConfigPath('config.json')),
        driver: createOAuthRefreshDriver(connection.oauth) });
      sources.push({ provider: connection.name, kind: 'oauth', service: connection.oauth, session });
    } else if (connection.cloud) {
      const resolve = createNativeCloudCredentialResolver(connection);
      sources.push({ provider: connection.name, kind: 'cloud', connection, resolve: (_request, signal) => resolve(signal) });
    } else sources.push({ provider: connection.name, kind: 'environment', apiKeyEnv: connection.apiKeyEnv });
  }
  return createProviderCredentialAuthorizer({ sources });
}
