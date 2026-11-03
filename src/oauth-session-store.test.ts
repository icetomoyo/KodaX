import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createEncryptedOAuthSessionStore, createWindowsOAuthSessionStore } from './oauth-session-store.js';

function fixtureSealer() {
  const key = randomBytes(32);
  return { async seal(plaintext: Uint8Array) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(plaintext), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
    async unseal(sealed: Uint8Array) { const input = Buffer.from(sealed), decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12)); decipher.setAuthTag(input.subarray(12, 28)); return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]); } };
}

it('publishes a complete file lock before entering an encrypted transaction', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-sealed-publication-'));
  const id = 'publication-fixture';
  const lock = path.join(directory, `${createHash('sha256').update(id).digest('hex')}.sealed.lock`);
  const store = createEncryptedOAuthSessionStore(directory, fixtureSealer());
  try {
    await store.transact(id, async record => {
      const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number; runtimeId: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.runtimeId).toBeTruthy();
      return { record, result: undefined };
    });
    expect(await readdir(directory)).not.toContain(path.basename(lock));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('recovers only a verified dead sealed-store writer while preserving registration identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-sealed-owner-recovery-'));
  const id = 'dead-writer-registration';
  const file = path.join(directory, `${createHash('sha256').update(id).digest('hex')}.sealed`);
  await mkdir(`${file}.lock`);
  await writeFile(path.join(`${file}.lock`, 'owner.json'), JSON.stringify({ runtimeId: 'fixture-retired', pid: 2_146_999_999, createdAt: '2026-01-01T00:00:00Z' }));
  const store = createEncryptedOAuthSessionStore(directory, fixtureSealer());
  try {
    await expect(store.transact(id, async record => ({ record, result: 'recovered-without-selecting-another-account' })))
      .resolves.toBe('recovered-without-selecting-another-account');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 35_000);

it('serializes rotating transactions across store instances and never writes plaintext token material', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-store-'));
  const sealer = fixtureSealer();
  try {
    const a = createEncryptedOAuthSessionStore(directory, sealer), b = createEncryptedOAuthSessionStore(directory, sealer);
    await a.transact('registration', async () => ({ record: { id: 'registration', service: 'openai-chatgpt', clientId: 'issued', accountId: 'verified', credentials: { accessToken: 'secret-0', refreshToken: 'refresh-secret', expiresAt: 1 } }, result: undefined }));
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).transact('registration', async record => {
      const count = Number(record!.credentials!.accessToken.split('-').at(-1));
      await new Promise(resolve => setTimeout(resolve, 5));
      return { record: { ...record!, credentials: { ...record!.credentials!, accessToken: `secret-${count + 1}` } }, result: undefined };
    })));
    expect(await b.transact('registration', async record => ({ record, result: record!.credentials!.accessToken }))).toBe('secret-8');
    for (const name of await readdir(directory)) expect((await readFile(path.join(directory, name))).toString()).not.toMatch(/secret|refresh/);
    await expect(a.transact('registration', async record => ({ record: { ...record!, accountId: 'other-account' }, result: 'must-not-publish' }))).rejects.toThrow(/storage|registration/i);
    await expect(a.transact('registration', async () => { throw new Error('operation rejected'); })).rejects.toThrow('operation rejected');
    expect(await a.transact('registration', async record => ({ record: undefined, result: record!.accountId }))).toBe('verified');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it.skipIf(process.platform !== 'win32')('roundtrips the actual current-user Windows DPAPI adapter without plaintext files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-dpapi-'));
  try {
    const store = createWindowsOAuthSessionStore(directory);
    await store.transact('dpapi-fixture', async () => ({ record: { id: 'dpapi-fixture', service: 'github-copilot', clientId: 'issued', accountId: 'verified', credentials: { accessToken: 'local-dpapi-fixture' } }, result: 1 }));
    expect(await createWindowsOAuthSessionStore(directory).transact('dpapi-fixture', async record => ({ record: undefined, result: record!.credentials!.accessToken }))).toBe('local-dpapi-fixture');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'win32')('holds the real secure-store transaction across separate Main processes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-dpapi-process-'));
  try {
    const store = createWindowsOAuthSessionStore(directory);
    await store.transact('process-fixture', async () => ({ record: { id: 'process-fixture', service: 'github-copilot', clientId: 'issued', accountId: 'verified', credentials: { accessToken: 'counter-0' } }, result: undefined }));
    const modulePath = new URL('./oauth-session-store.ts', import.meta.url).href;
    const script = `import {createWindowsOAuthSessionStore} from ${JSON.stringify(modulePath)};const store=createWindowsOAuthSessionStore(process.argv[1]);await store.transact('process-fixture',async record=>{const count=Number(record.credentials.accessToken.split('-').at(-1));await new Promise(resolve=>setTimeout(resolve,20));return {record:{...record,credentials:{accessToken:'counter-'+(count+1)}},result:null}});`;
    const runs = await Promise.allSettled(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 20000 })));
    expect(runs.every(run => run.status === 'fulfilled')).toBe(true);
    expect(await store.transact('process-fixture', async record => ({ record: undefined, result: record!.credentials!.accessToken }))).toBe('counter-3');
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);

it('does not overwrite corrupt records or publish a failed encrypted commit', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-store-failure-')), sealer = fixtureSealer();
  try {
    const store = createEncryptedOAuthSessionStore(directory, sealer);
    const record = { id: 'fixture', service: 'openrouter' as const, clientId: 'issued', accountId: 'grant', credentials: { accessToken: 'must-stay-old' } };
    await store.transact(record.id, async () => ({ record, result: undefined }));
    const file = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.sealed'))!);
    const before = await readFile(file); await writeFile(file, Buffer.concat([before, Buffer.from('tampered')]));
    let called = false;
    await expect(store.transact(record.id, async value => { called = true; return { record: value, result: 1 }; })).rejects.toThrow(/storage failed/);
    expect(called).toBe(false); expect(await readFile(file)).not.toEqual(before);
    await writeFile(file, before);
    const failing = createEncryptedOAuthSessionStore(directory, { ...sealer, async seal() { throw new Error('secret-in-backend-error'); } });
    await expect(failing.transact(record.id, async value => ({ record: { ...value!, credentials: { accessToken: 'must-not-publish' } }, result: 'must-not-publish' }))).rejects.toThrow(/storage failed/);
    expect(await readFile(file)).toEqual(before); expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(await store.transact(record.id, async value => ({ record: undefined, result: value!.credentials!.accessToken }))).toBe('must-stay-old');
    await expect(store.transact('', async value => ({ record: value, result: 1 }))).rejects.toThrow(/storage/);
    expect(() => createEncryptedOAuthSessionStore('relative', sealer)).toThrow(/absolute/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
