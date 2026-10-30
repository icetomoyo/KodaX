import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFileProviderCredentialStore } from '../auth-file.js';
import { openOAuthSession } from './session.js';

it('shares local revocation fences across separate handles to the same physical OAuth file', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-file-fence-')), file = path.join(folder, 'auth.json');
  try {
    const a = createFileProviderCredentialStore(file).oauth, b = createFileProviderCredentialStore(file).oauth;
    await a.transact('r', async () => ({ record: { id: 'r', service: 'openrouter', clientId: 'own-client', accountId: 'grant-a', credentials: { accessToken: 'fixture' } }, result: undefined }));
    const driver = { refresh: vi.fn(async () => ({ accessToken: 'unused' })) }, first = await openOAuthSession({ id: 'r', store: a, driver }), second = await openOAuthSession({ id: 'r', store: b, driver });
    const fence = vi.fn(async () => undefined); second.onInvalidate(fence);
    expect(await second.acquire()).toBe('fixture'); await first.revoke();
    expect(fence).toHaveBeenCalledOnce(); await expect(second.acquire()).rejects.toThrow(/revoked/);
    expect(await b.transact('r', async record => ({ record, result: record?.credentials }))).toBeUndefined();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('fences an in-flight refresh across file handles before a later account can receive its result', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-file-late-')), file = path.join(folder, 'auth.json');
  try {
    const a = createFileProviderCredentialStore(file).oauth, b = createFileProviderCredentialStore(file).oauth;
    await a.transact('a', async () => ({ record: { id: 'a', profile: 'work', service: 'openai-chatgpt', clientId: 'own', accountId: 'account-a', credentials: { accessToken: 'expired', refreshToken: 'once', expiresAt: Date.now() - 60000 } }, result: undefined }));
    let release!: () => void, started!: () => void, signal!: AbortSignal;
    const began = new Promise<void>(resolve => { started = resolve; });
    const driver = { refresh: async (_record: unknown, input: AbortSignal) => { signal = input; started(); await new Promise<void>(resolve => { release = resolve; }); return { accessToken: 'late-account-a', expiresAt: Date.now() + 3600000 }; } };
    const first = await openOAuthSession({ id: 'a', store: a, driver }), second = await openOAuthSession({ id: 'a', store: b, driver });
    const acquisition = expect(second.acquire()).rejects.toThrow(/revoked/); await began;
    const revoked = first.revoke(); expect(signal.aborted).toBe(true); release(); await acquisition; await revoked;
    await b.transact('b', async () => ({ record: { id: 'b', profile: 'work', service: 'openrouter', clientId: 'own', accountId: 'account-b', credentials: { accessToken: 'account-b-fixture' } }, result: undefined }));
    expect(await (await openOAuthSession({ id: 'b', store: a, driver })).acquire()).toBe('account-b-fixture');
    expect(await a.transact('a', async record => ({ record, result: record?.credentials }))).toBeUndefined();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('rotates a shared grant only once across three actual Main processes', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'kodax-oauth-file-process-')), file = path.join(folder, 'auth.json'), ledger = path.join(folder, 'refresh-ledger');
  try {
    const store = createFileProviderCredentialStore(file).oauth;
    await store.transact('r', async () => ({ record: { id: 'r', service: 'openai-chatgpt', clientId: 'own', accountId: 'grant', credentials: { accessToken: 'expired', refreshToken: 'once', expiresAt: Date.now() - 60000 } }, result: undefined }));
    const backend = new URL('../auth-file.ts', import.meta.url).href, sessions = new URL('./session.ts', import.meta.url).href;
    const script = `import {createFileProviderCredentialStore} from ${JSON.stringify(backend)};import {openOAuthSession} from ${JSON.stringify(sessions)};import {appendFile} from 'node:fs/promises';const session=await openOAuthSession({id:'r',store:createFileProviderCredentialStore(process.argv[1]).oauth,driver:{refresh:async record=>{if(record.credentials.refreshToken!=='once')throw new Error('Unexpected extra rotation');await appendFile(process.argv[2],'refresh\\n');return {accessToken:'new-fixture',refreshToken:'rotated',expiresAt:Date.now()+3600000}}}});if(await session.acquire()!=='new-fixture')throw new Error('Unexpected acquisition');`;
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script, file, ledger], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), windowsHide: true, timeout: 25000 })));
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(await readFile(ledger, 'utf8')).toBe('refresh\n');
  } finally { await rm(folder, { recursive: true, force: true }); }
}, 30000);
