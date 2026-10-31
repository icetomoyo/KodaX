import { randomUUID } from 'node:crypto';
import { beginOAuthAuthorization, beginDeviceAuthorization, createOAuthRefreshDriver, openOAuthSession,
  OAuthCredentialError, type OAuthLoginInput, type OAuthLoginResult, type OAuthSessionStore, type OAuthSessionRecord, type OAuthCredentialSession } from '@kodax-ai/llm';

export interface ProviderOAuthLoginInput extends Omit<OAuthLoginInput, 'redirectUri'> {
  readonly redirectUri?: string; readonly store: OAuthSessionStore;
  readonly profile?: string;
  readonly browser?: (authorization: { authorizationUrl: string; signal?: AbortSignal }) => Promise<string>;
  readonly device?: (authorization: { verificationUri: string; userCode: string; expiresAt: number }) => Promise<void>;
  /** Optional trusted issuer-specific validation; otherwise isolate the authenticated grant, without claiming a user identity. */
  readonly verifyIdentity?: (result: OAuthLoginResult, context: { service: OAuthLoginInput['service']; clientId: string; nonce?: string; signal?: AbortSignal }) => Promise<string>;
}
/** Real PKCE/device login using the caller's issued registration, secure commit before publication. */
export async function loginProviderOAuth(input: ProviderOAuthLoginInput) {
  if (!input.clientId?.trim() || Boolean(input.browser) === Boolean(input.device)) throw new OAuthCredentialError('invalid_session');
  if (input.profile !== undefined && (typeof input.profile !== 'string' || !input.profile.trim())) throw new OAuthCredentialError('invalid_session');
  let result: OAuthLoginResult, nonce: string | undefined;
  const common = { service: input.service, clientId: input.clientId, scopes: [...input.scopes], issuer: input.issuer, fetch: input.fetch, signal: input.signal };
  if (input.browser) {
    if (!input.redirectUri) throw new OAuthCredentialError('invalid_session');
    const authorization = await beginOAuthAuthorization({ ...common, redirectUri: input.redirectUri }); nonce = authorization.nonce;
    try { result = await authorization.exchange(await input.browser({ authorizationUrl: authorization.authorizationUrl, signal: input.signal }), input.signal); }
    finally { authorization.close(); }
  } else {
    const authorization = await beginDeviceAuthorization(common);
    try { await input.device!({ verificationUri: authorization.verificationUriComplete ?? authorization.verificationUri, userCode: authorization.userCode, expiresAt: authorization.expiresAt }); result = await authorization.poll(input.signal); }
    finally { authorization.close(); }
  }
  input.signal?.throwIfAborted();
  const clientId = input.clientId!.trim();
  const accountId = input.verifyIdentity ? await input.verifyIdentity(result, { service: input.service, clientId, nonce, signal: input.signal }) : `grant:${randomUUID()}`;
  if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 1024) throw new OAuthCredentialError('invalid_session');
  const record: OAuthSessionRecord = { id: randomUUID(), service: input.service, clientId, accountId,
    identityKind: input.verifyIdentity ? 'account' : 'grant', credentials: result.tokens, ...(input.issuer ? { issuer: input.issuer } : {}), ...(input.profile ? { profile: input.profile } : {}) };
  input.signal?.throwIfAborted();
  await input.store.transact(record.id, async previous => {
    if (previous) throw new OAuthCredentialError('invalid_session');
    input.signal?.throwIfAborted(); return { record, result: undefined };
  });
  const open = () => openOAuthSession({ id: record.id, store: input.store, driver: createOAuthRefreshDriver(record.service, { fetch: input.fetch }) });
  let session: OAuthCredentialSession | undefined;
  try {
    input.signal?.throwIfAborted(); session = await open(); input.signal?.throwIfAborted();
    return { registrationId: record.id, accountId: record.accountId, identityKind: record.identityKind, session };
  } catch (error) {
    // This registration was never published. Fence/clear its grant while retaining committed registration facts.
    if (input.signal?.aborted) { session ??= await open(); await session.revoke(); }
    throw error;
  }
}
