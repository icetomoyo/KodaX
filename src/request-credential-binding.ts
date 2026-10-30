import type { RuntimeCredentialBinding, RuntimeCredentialLease, RuntimeCredentialService, RuntimeScopedCredentialRequest } from './client-host-authorization.js';

export interface RuntimeRequestCredentialBinding {
  readonly credential: Extract<RuntimeCredentialBinding, { mode: 'scoped' }>;
  close(): Promise<void>;
}
/** One immutable identity binding; shared by OAuth sessions and typed cloud credential providers. */
export async function bindRequestCredentials(input: {
  credentials: RuntimeCredentialService; provider?: string; providers?: readonly string[];
  acquire(request: RuntimeScopedCredentialRequest, signal: AbortSignal): Promise<string>;
  onInvalidate?(listener: () => Promise<void>): () => void;
}): Promise<RuntimeRequestCredentialBinding> {
  const { credentials, acquire } = input;
  const providers = [...new Set(input.providers ?? (input.provider ? [input.provider] : []))];
  if (!providers.length || providers.some(provider => !provider.trim())) throw new Error('Credential binding requires approved providers.');
  let active = true;
  let lease: RuntimeCredentialLease | undefined;
  const lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  let unsubscribe: () => void = () => undefined;
  let registering: Promise<RuntimeCredentialLease>;
  const close = (): Promise<void> => {
    if (closing) return closing;
    active = false; lifetime.abort(); unsubscribe();
    closing = (async () => { const registered = lease ?? await registering; await credentials.revoke(registered.id); })()
      .catch((error: unknown) => { closing = undefined; throw error; });
    return closing;
  };
  unsubscribe = input.onInvalidate?.(close) ?? unsubscribe;
  try {
    registering = credentials.registerScoped({ providers }, async request => {
      if (!active || !lease || request.leaseId !== lease.id || !providers.includes(request.provider)) throw new Error('Credential binding is inactive.');
      const token = await acquire(request, lifetime.signal);
      if (!active) throw new Error('Credential binding is inactive.');
      return token;
    });
    lease = await registering;
    if (!active) { await close(); throw new Error('Credential binding is inactive.'); }
    return { credential: { leaseId: lease.id, mode: 'scoped', providers }, close };
  } catch (error) { active = false; lifetime.abort(); unsubscribe(); throw error; }
}
