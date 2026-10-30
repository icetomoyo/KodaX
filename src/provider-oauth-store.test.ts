import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createFileProviderCredentialStore, type OAuthSessionRecord, type OAuthSessionStore } from '@kodax-ai/llm';
import { createEncryptedOAuthSessionStore, createWindowsOAuthSessionStore } from './oauth-session-store.js';
import { migrateProviderOAuthRegistration, providerOAuthStore } from './provider-oauth-store.js';

const record: OAuthSessionRecord = { id: 'linked', service: 'openrouter', clientId: 'own-client', accountId: 'grant-a', identityKind: 'grant', credentials: { accessToken: 'migration-fixture' } };
it.skipIf(process.platform !== 'win32')('imports an actual current-user DPAPI registration through the default migration path', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-dpapi-migrate-')), configPath = path.join(folder, 'config.json');
  try {
    const legacy = createWindowsOAuthSessionStore(path.join(folder, 'provider-oauth'));
    await legacy.transact(record.id, async () => ({ record, result: undefined }));
    expect(await migrateProviderOAuthRegistration({ configPath, registrationId: record.id })).toBe('migrated');
    expect(await providerOAuthStore(configPath).transact(record.id, async value => ({ record: value, result: value }))).toEqual(record);
    expect(await legacy.transact(record.id, async value => ({ record: value, result: value?.credentials }))).toBeUndefined();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('migrates only the linked legacy registration after a durable shared-file commit, preserving API keys', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-migration-')), configPath = path.join(folder, 'config.json');
  try {
    const legacy = createEncryptedOAuthSessionStore(path.join(folder, 'legacy'), { seal: async bytes => Buffer.from(bytes).reverse(), unseal: async bytes => Buffer.from(bytes).reverse() });
    for (const id of ['linked', 'unrelated']) await legacy.transact(id, async () => ({ record: { ...record, id }, result: undefined }));
    const file = createFileProviderCredentialStore(path.join(folder, 'auth.json')), binding = { profile: 'default', provider: 'key-provider', connectionFingerprint: 'a'.repeat(64) };
    await file.setApiKey(binding, 'key-fixture');
    expect(await migrateProviderOAuthRegistration({ configPath, registrationId: 'linked', legacyStore: legacy })).toBe('migrated');
    expect(await providerOAuthStore(configPath).transact('linked', async value => ({ record: value, result: value }))).toEqual(record);
    expect(await legacy.transact('linked', async value => ({ record: value, result: value?.credentials }))).toBeUndefined();
    expect(await legacy.transact('unrelated', async value => ({ record: value, result: value?.credentials }))).toEqual(record.credentials);
    expect((await file.readApiKey(binding))?.key).toBe('key-fixture'); expect(JSON.parse(await readFile(file.filePath, 'utf8')).version).toBe(2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('keeps a current or revoked shared registration authoritative and never resurrects the legacy grant', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-current-')), configPath = path.join(folder, 'config.json');
  try {
    const store = providerOAuthStore(configPath);
    await store.transact(record.id, async () => ({ record: { ...record, credentials: undefined }, result: undefined }));
    const legacy = { async transact<T>(): Promise<T> { throw new Error('Legacy OS backend must not be required.'); } };
    expect(await migrateProviderOAuthRegistration({ configPath, registrationId: record.id, legacyStore: legacy })).toBe('current');
    expect(await store.transact(record.id, async value => ({ record: value, result: value?.credentials }))).toBeUndefined();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('keeps the durable new copy and reports failed legacy cleanup without publishing a successful migration', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-cleanup-')), configPath = path.join(folder, 'config.json');
  const legacy: OAuthSessionStore = { async transact(_id, operation) {
    const update = await operation(structuredClone(record));
    if (!update.record?.credentials) throw new Error('Legacy cleanup failed.'); return update.result;
  } };
  try {
    await expect(migrateProviderOAuthRegistration({ configPath, registrationId: record.id, legacyStore: legacy })).rejects.toThrow(/cleanup/);
    expect(await providerOAuthStore(configPath).transact(record.id, async value => ({ record: value, result: value }))).toEqual(record);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('does not clear the legacy grant when another writer creates the target registration during migration', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-race-')), configPath = path.join(folder, 'config.json');
  const current = { ...record, accountId: 'different-current', credentials: { accessToken: 'current-fixture' } };
  let retained: OAuthSessionRecord | undefined;
  const legacy: OAuthSessionStore = { async transact(_id, operation) {
    await providerOAuthStore(configPath).transact(record.id, async () => ({ record: current, result: undefined }));
    const update = await operation(structuredClone(record)); retained = update.record; return update.result;
  } };
  try {
    expect(await migrateProviderOAuthRegistration({ configPath, registrationId: record.id, legacyStore: legacy })).toBe('current');
    expect(retained).toEqual(record); expect(await providerOAuthStore(configPath).transact(record.id, async value => ({ record: value, result: value }))).toEqual(current);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
