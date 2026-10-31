import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createFileProviderCredentialStore, type OAuthSessionStore, type OAuthCredentialSession, type OAuthService } from '@kodax-ai/llm';
import { createWindowsOAuthSessionStore } from './oauth-session-store.js';

export function providerOAuthStore(configPath: string): OAuthSessionStore {
  return createFileProviderCredentialStore(path.join(path.dirname(configPath), 'auth.json')).oauth;
}
export function assertProviderOAuthSessionScope(input: { readonly service: OAuthService; readonly profile?: string; readonly issuer?: string },
  session: Pick<OAuthCredentialSession, 'service' | 'profile' | 'issuer'>): void {
  if (input.service !== session.service) throw new Error('OAuth source and session must match.');
  if (input.profile !== undefined && (session.profile ?? 'default') !== input.profile) throw new Error('OAuth registration belongs to another profile.');
  if (input.service === 'radius') {
    if (input.issuer === undefined) throw new Error('Radius requires an approved OAuth issuer.');
    const normalize = (value?: string) => { try { return new URL(value ?? '').href.replace(/\/$/, ''); } catch { throw new Error('Invalid OAuth issuer metadata.'); } };
    if (normalize(input.issuer) !== normalize(session.issuer)) throw new Error('OAuth registration issuer does not match the approved connection.');
  }
}
/** Import only a linked registration. Retain the encrypted source for interrupted upgrades and rollback. */
export async function migrateProviderOAuthRegistration(input: {
  readonly configPath: string; readonly registrationId: string; readonly legacyStore?: OAuthSessionStore;
}): Promise<'current' | 'absent' | 'migrated'> {
  const target = providerOAuthStore(input.configPath), id = input.registrationId;
  if (await target.transact(id, async record => ({ record, result: record !== undefined }))) return 'current';
  let legacy = input.legacyStore;
  if (!legacy) {
    const directory = path.join(path.dirname(input.configPath), 'provider-oauth');
    const file = path.join(directory, `${createHash('sha256').update(id).digest('hex')}.sealed`);
    try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid legacy OAuth registration file.'); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'absent'; throw error; }
    legacy = createWindowsOAuthSessionStore(directory);
  }
  return legacy.transact(id, async previous => {
    if (!previous) return { record: previous, result: 'absent' as const };
    const copied = await target.transact(id, async current => current
      ? { record: current, result: false } : { record: previous, result: true });
    return { record: previous, result: copied ? 'migrated' as const : 'current' as const };
  });
}
