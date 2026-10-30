import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileProviderCredentialStore } from './auth-file.js';

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() { const folder = await mkdtemp(path.join(tmpdir(), 'kodax-auth-file-')); folders.push(folder); return path.join(folder, 'auth.json'); }
const binding = { profile: 'default', provider: 'custom', connectionFingerprint: 'a'.repeat(64) };
it('stores explicit API keys separately from configuration and exposes only redacted status', async () => {
  const file = await fixture(), store = createFileProviderCredentialStore(file);
  expect(await store.describeApiKey(binding)).toEqual({ configured: false });
  const state = await store.setApiKey(binding, 'saved-fixture-key');
  expect(state.configured).toBe(true); expect(state.revision).toMatch(/^[a-z0-9-]+$/);
  expect(JSON.stringify(state)).not.toContain('saved-fixture-key');
  expect((await store.readApiKey(binding))?.key).toBe('saved-fixture-key');
  expect(await store.readApiKey({ ...binding, provider: 'other' })).toBeUndefined();
  expect(await store.readApiKey({ ...binding, profile: 'other' })).toBeUndefined();
  expect(await store.readApiKey({ ...binding, connectionFingerprint: 'b'.repeat(64) })).toBeUndefined();
  const saved = JSON.parse(await readFile(file, 'utf8')); expect(saved.version).toBe(1); expect(JSON.stringify(saved)).toContain('saved-fixture-key');
  expect(await readdir(`${file}.staging`)).toEqual([]);
  await store.removeApiKey(binding, state.revision); expect(await store.describeApiKey(binding)).toEqual({ configured: false });
});
it('serializes the entire document across independent stores without dropping unrelated keys or OAuth rotations', async () => {
  const file = await fixture(), a = createFileProviderCredentialStore(file), b = createFileProviderCredentialStore(file);
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).setApiKey({ ...binding, provider: `provider-${index}` }, `fixture-${index}`)));
  await a.oauth.transact('registration', async () => ({ record: { id: 'registration', service: 'openrouter', clientId: 'issued', accountId: 'grant', identityKind: 'grant', credentials: { accessToken: 'counter-0' } }, result: undefined }));
  await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? a : b).oauth.transact('registration', async record => {
    const counter = Number(record!.credentials!.accessToken.split('-').at(-1)); await new Promise(resolve => setTimeout(resolve, 5));
    return { record: { ...record!, credentials: { accessToken: `counter-${counter + 1}` } }, result: undefined };
  })));
  expect(await b.oauth.transact('registration', async record => ({ record, result: record!.credentials!.accessToken }))).toBe('counter-6');
  for (let index = 0; index < 8; index++) expect((await a.readApiKey({ ...binding, provider: `provider-${index}` }))?.key).toBe(`fixture-${index}`);
});
it('rejects stale updates, corrupt documents and unsupported versions without overwriting committed credentials', async () => {
  const file = await fixture(), store = createFileProviderCredentialStore(file);
  const original = await store.setApiKey(binding, 'first'); await store.setApiKey(binding, 'second', original.revision);
  await expect(store.setApiKey(binding, 'stale', original.revision)).rejects.toThrow(/conflict/);
  expect((await store.readApiKey(binding))?.key).toBe('second');
  await writeFile(file, '{broken'); await expect(store.setApiKey(binding, 'must-not-write')).rejects.toThrow(/credential.*storage/i); expect(await readFile(file, 'utf8')).toBe('{broken');
  await writeFile(file, '{"version":999,"apiKeys":{},"oauth":{}}'); await expect(store.readApiKey(binding)).rejects.toThrow(/credential.*storage/i);
});

it('does not change OAuth identity metadata or committed data when an operation fails', async () => {
  const file = await fixture(), store = createFileProviderCredentialStore(file);
  const record = { id: 'registration', service: 'github-copilot' as const, clientId: 'issued', accountId: 'account', credentials: { accessToken: 'fixture' } };
  await store.oauth.transact(record.id, async () => ({ record, result: undefined }));
  const before = await readFile(file, 'utf8');
  await expect(store.oauth.transact(record.id, async current => ({ record: { ...current!, accountId: 'other' }, result: 'must-not-publish' }))).rejects.toThrow(/storage/);
  await expect(store.oauth.transact(record.id, async () => { throw new Error('operation rejected'); })).rejects.toThrow(/operation rejected/);
  expect(await readFile(file, 'utf8')).toBe(before);
});
it('rejects invalid input, create-only conflicts and deletion with a stale revision', async () => {
  expect(() => createFileProviderCredentialStore('relative.json')).toThrow(/absolute/);
  const store = createFileProviderCredentialStore(await fixture());
  await expect(store.readApiKey({ ...binding, connectionFingerprint: 'wrong' })).rejects.toThrow(/storage/);
  await expect(store.setApiKey(binding, 'one\ntwo')).rejects.toThrow(/storage/);
  const first = await store.setApiKey(binding, 'first', null);
  await expect(store.setApiKey(binding, 'second', null)).rejects.toThrow(/conflict/);
  await expect(store.removeApiKey(binding, 'stale')).rejects.toThrow(/conflict/);
  expect((await store.readApiKey(binding))?.key).toBe('first');
  await store.removeApiKey(binding, first.revision);
  expect(await store.removeApiKey(binding, null)).toEqual({ configured: false });
  await expect(store.oauth.transact('', async () => ({ record: undefined, result: undefined }))).rejects.toThrow(/storage/);
});
it('rejects malformed records and token fields without repairing or replacing the file', async () => {
  const file = await fixture(), store = createFileProviderCredentialStore(file);
  const record = { id: 'r', service: 'openrouter', clientId: 'client', accountId: 'account', credentials: { accessToken: 'fixture' } };
  const cases: unknown[] = [[], { version: 1, apiKeys: {}, oauth: {}, unexpected: true }, { version: 1, apiKeys: { invalid: {} }, oauth: {} }];
  for (const change of [{ id: 'other' }, { service: 'unknown' }, { clientId: '' }, { issuer: '\n' }, { identityKind: 'unknown' },
    { credentials: { accessToken: '' } }, { credentials: { accessToken: 'ok', scopes: 'wrong' } }, { credentials: { accessToken: 'ok', expiresAt: 'wrong' } },
    { resource: { accessToken: 'ok', earliestRefreshAt: 'wrong' } }, { credentials: { accessToken: 'ok', unsupported: true } }]) {
    cases.push({ version: 1, apiKeys: {}, oauth: { r: { ...record, ...change } } });
  }
  for (const value of cases) {
    const bytes = JSON.stringify(value); await writeFile(file, bytes);
    await expect(store.setApiKey(binding, 'must-not-write')).rejects.toThrow(/storage/);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  }
});

it('keeps keys and OAuth updates intact across separate Main processes', async () => {
  const file = await fixture(), store = createFileProviderCredentialStore(file);
  await store.oauth.transact('registration', async () => ({ record: { id: 'registration', service: 'openrouter', clientId: 'issued', accountId: 'grant', credentials: { accessToken: 'counter-0' } }, result: undefined }));
  const module = new URL('./auth-file.ts', import.meta.url).href;
  const script = `import {createFileProviderCredentialStore} from ${JSON.stringify(module)};const store=createFileProviderCredentialStore(process.argv[1]);await store.setApiKey({profile:'default',provider:'child-'+process.argv[2],connectionFingerprint:'a'.repeat(64)},'fixture-'+process.argv[2]);await store.oauth.transact('registration',async record=>{const counter=Number(record.credentials.accessToken.split('-').at(-1));await new Promise(resolve=>setTimeout(resolve,10));return {record:{...record,credentials:{accessToken:'counter-'+(counter+1)}},result:null}});`;
  const results = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script, file, String(index)], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), windowsHide: true, timeout: 20000 })));
  expect(results.every(result => result.status === 'fulfilled')).toBe(true);
  expect(await store.oauth.transact('registration', async record => ({ record, result: record!.credentials!.accessToken }))).toBe('counter-3');
  for (let index = 0; index < 3; index++) expect((await store.readApiKey({ ...binding, provider: `child-${index}` }))?.key).toBe(`fixture-${index}`);
}, 30000);

it.skipIf(process.platform !== 'win32')('protects the actual plaintext file with non-inherited current-user and SYSTEM access only', async () => {
  const file = await fixture(); await createFileProviderCredentialStore(file).setApiKey(binding, 'acl-fixture');
  const script = "$acl=[System.IO.File]::GetAccessControl($env:KODAX_TEST_AUTH_ACL); [Console]::Write(($acl.AreAccessRulesProtected.ToString()+'|'+(($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value}) -join ',')))";
  const result = await promisify(execFile)(path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000, env: { ...process.env, KODAX_TEST_AUTH_ACL: file } });
  const [protectedRules, accounts] = result.stdout.split('|'); expect(protectedRules).toBe('True');
  const identities = accounts!.split(','); expect(identities).toHaveLength(2); expect(identities).toContain('S-1-5-18');
  expect(identities.filter(identity => identity !== 'S-1-5-18').every(identity => /^S-1-5-21-/.test(identity))).toBe(true);
});
