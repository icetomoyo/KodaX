import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { OAuthCredentialError, type OAuthSessionRecord, type OAuthSessionStore } from '@kodax-ai/llm';

/** Supply an OS/user-bound authenticated sealer; no plaintext fallback is provided. */
export interface OAuthSessionSealer { seal(plaintext: Uint8Array): Promise<Uint8Array>; unseal(ciphertext: Uint8Array): Promise<Uint8Array>; }
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function storageError(): OAuthCredentialError { return new OAuthCredentialError('storage_failed'); }
async function lock(directory: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30000;
  while (true) {
    try { await mkdir(directory, { mode: 0o700 }); return () => rmdir(directory); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw storageError();
      if (Date.now() >= deadline) throw storageError();
      await delay(20);
    }
  }
}
function registration(value: unknown, id: string): OAuthSessionRecord {
  if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id
    || !('clientId' in value) || typeof value.clientId !== 'string' || !value.clientId.trim()
    || !('accountId' in value) || typeof value.accountId !== 'string' || !value.accountId.trim()
    || !('service' in value) || typeof value.service !== 'string') throw storageError();
  return value as OAuthSessionRecord;
}
async function readRecord(file: string, id: string, sealer: OAuthSessionSealer): Promise<OAuthSessionRecord | undefined> {
  let encrypted: Buffer;
  try { encrypted = await readFile(file); } catch (error) { if (missing(error)) return undefined; throw storageError(); }
  try {
    if (encrypted.length > 1024 * 1024) throw storageError();
    const plaintext = await sealer.unseal(encrypted);
    try { return registration(JSON.parse(Buffer.from(plaintext).toString('utf8')), id); }
    finally { plaintext.fill(0); }
  } catch { throw storageError(); }
}
async function commit(file: string, record: OAuthSessionRecord | undefined, sealer: OAuthSessionSealer): Promise<void> {
  if (!record) { try { await unlink(file); } catch (error) { if (!missing(error)) throw storageError(); } return; }
  const temporary = `${file}.${randomUUID()}.tmp`, plaintext = Buffer.from(JSON.stringify(record));
  try {
    const encrypted = await sealer.seal(plaintext);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    if (process.platform !== 'win32') { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } catch { throw storageError(); }
  finally { plaintext.fill(0); try { await unlink(temporary); } catch (error) { if (!missing(error)) throw storageError(); } }
}
/** Lock is held over refresh and durable commit, including across independent Main processes. */
export function createEncryptedOAuthSessionStore(directory: string, sealer: OAuthSessionSealer): OAuthSessionStore {
  if (!path.isAbsolute(directory)) throw new Error('OAuth store requires an absolute trusted directory.');
  return { async transact(id, operation) {
    if (!id.trim() || id.length > 512) throw storageError();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${createHash('sha256').update(id).digest('hex')}.sealed`);
    const release = await lock(`${file}.lock`);
    try {
      const previous = await readRecord(file, id, sealer), update = await operation(previous ? structuredClone(previous) : undefined);
      if (update.record) {
        registration(update.record, id);
        if (previous && (previous.service !== update.record.service || previous.clientId !== update.record.clientId
          || previous.accountId !== update.record.accountId || previous.issuer !== update.record.issuer || previous.identityKind !== update.record.identityKind)) throw storageError();
      }
      await commit(file, update.record, sealer); return update.result;
    } finally { await release(); }
  } };
}
function dpapi(input: Uint8Array, protect: boolean): Promise<Uint8Array> {
  const method = protect ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $data = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${method}($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000 });
    const chunks: Buffer[] = []; let size = 0;
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.stderr.resume(); child.on('error', () => reject(storageError()));
    child.stdin.on('error', () => reject(storageError()));
    child.on('close', code => {
      const text = Buffer.concat(chunks).toString().trim();
      if (code !== 0 || !text || size > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) reject(storageError());
      else resolve(Buffer.from(text, 'base64'));
    });
    child.stdin.end(Buffer.from(input).toString('base64'));
  });
}
export function createWindowsOAuthSessionStore(directory: string): OAuthSessionStore {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI is unavailable. Supply the trusted Main OS secure-store adapter.');
  return createEncryptedOAuthSessionStore(directory, { seal: input => dpapi(input, true), unseal: input => dpapi(input, false) });
}
