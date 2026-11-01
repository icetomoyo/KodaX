import type { KodaXCustomProviderConfig, OAuthCredentialSession } from '@kodax-ai/llm';
import type { RuntimeCredentialService } from './client-host-authorization.js';
import { bindRequestCredentials, type RuntimeRequestCredentialBinding } from './request-credential-binding.js';
import { acquireOAuthRequestCredential } from './oauth-request-credential.js';

export interface RuntimeOAuthCredentialBinding extends RuntimeRequestCredentialBinding {
  switchAccount(session: OAuthCredentialSession): Promise<RuntimeOAuthCredentialBinding>;
}

/**
 * Trusted host adapter for the existing v2 broker. Refresh tokens remain in the
 * host store. After Host restart call this again with the new credential service;
 * persisted lease IDs are deliberately not resumed as fresh authority.
 */
export async function bindOAuthCredentials(input: {
  credentials: RuntimeCredentialService;
  provider: Pick<KodaXCustomProviderConfig, 'name' | 'oauth'>;
  session: OAuthCredentialSession;
}): Promise<RuntimeOAuthCredentialBinding> {
  const { credentials, session } = input;
  const provider = { ...input.provider };
  if (!provider.name.trim() || provider.oauth !== session.service) throw new Error('OAuth binding requires a matching provider and session.');
  const binding = await bindRequestCredentials({ credentials, provider: provider.name,
    acquire: (request, signal) => acquireOAuthRequestCredential(session, request, signal), onInvalidate: listener => session.onInvalidate(listener) });
  return { ...binding, async switchAccount(next) {
    await binding.close();
    return bindOAuthCredentials({ credentials, provider, session: next });
  } };
}
