import type { KodaXCustomProviderConfig, OAuthCredentialSession } from '@kodax-ai/llm';
import type { RuntimeCredentialBinding, RuntimeCredentialLease, RuntimeCredentialService } from './client-host-authorization.js';

export interface RuntimeOAuthCredentialBinding {
  /** Only public authority is passed to Runtime execution inputs. */
  readonly credential: Extract<RuntimeCredentialBinding, { mode: 'scoped' }>;
  close(): Promise<void>;
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
  let active = true;
  let lease: RuntimeCredentialLease | undefined;
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  let unsubscribe: () => void = () => undefined;
  let registering: Promise<RuntimeCredentialLease>;
  const close = (): Promise<void> => {
    if (closing) return closing;
    active = false;
    lifetime.abort();
    unsubscribe();
    closing = (async () => { const registered = lease ?? await registering; await credentials.revoke(registered.id); })()
      .catch((error: unknown) => { closing = undefined; throw error; });
    return closing;
  };
  unsubscribe = session.onInvalidate(close);
  try {
    registering = credentials.registerScoped({ providers: [provider.name] }, async request => {
      if (!active || !lease || request.leaseId !== lease.id || request.provider !== provider.name) throw new Error('OAuth credential binding is inactive.');
      const token = await session.acquire(lifetime.signal);
      if (!active) throw new Error('OAuth credential binding is inactive.');
      return token;
    });
    lease = await registering;
    if (!active) { await close(); throw new Error('OAuth credential binding is inactive.'); }
    return {
      credential: { leaseId: lease.id, mode: 'scoped', providers: [provider.name] }, close,
      async switchAccount(next) {
        await close();
        return bindOAuthCredentials({ credentials, provider, session: next });
      },
    };
  } catch (error) { active = false; lifetime.abort(); unsubscribe(); throw error; }
}
