import { serializeProviderCredentialGrant, type OAuthCredentialSession } from '@kodax-ai/llm';
import type { RuntimeScopedCredentialRequest } from './client-host-authorization.js';

/** Trusted Main and SDK bindings share the negotiated OAuth request contract. */
export async function acquireOAuthRequestCredential(
  session: Pick<OAuthCredentialSession, 'acquire' | 'replayIdentity' | 'recoverRejectedCredential'>,
  request: RuntimeScopedCredentialRequest, signal: AbortSignal,
): Promise<string> {
  if (request.rejectedCredentialFingerprint !== undefined) {
    if (request.credentialContextVersion !== 1 || !/^[a-f0-9]{64}$/.test(request.rejectedCredentialFingerprint)
      || !session.recoverRejectedCredential) throw new Error('OAuth credential recovery requires a negotiated updated session.');
    await session.recoverRejectedCredential(request.rejectedCredentialFingerprint, signal);
  }
  const token = await session.acquire(signal);
  return request.credentialContextVersion === 1 ? serializeProviderCredentialGrant({ provider: request.provider, credential: token,
    identity: session.replayIdentity, recoverable: session.recoverRejectedCredential !== undefined }) : token;
}
