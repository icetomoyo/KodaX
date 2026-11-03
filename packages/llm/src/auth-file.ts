import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { OAuthCredentialError, shareOAuthSessionStoreIdentity, type OAuthSessionRecord, type OAuthSessionStore } from './oauth/session.js';

export interface ProviderCredentialFileBinding { readonly profile: string; readonly provider: string; readonly connectionFingerprint: string; }
export interface StoredProviderApiKey { readonly key: string; readonly revision: string; }
export interface ProviderApiKeySnapshot { readonly binding: ProviderCredentialFileBinding; readonly key?: string; readonly revision: string | null; }
export interface ProviderApiKeyMutation { readonly binding: ProviderCredentialFileBinding; readonly key?: string; readonly expectedRevision: string | null; }
export type ProviderApiKeyStatus = { readonly configured: false; readonly revision?: string } | { readonly configured: true; readonly revision: string };
interface ApiKeyEntry { readonly binding: ProviderCredentialFileBinding; readonly key?: string; readonly revision: string; }
interface AuthDocument { version: 2; apiKeys: Record<string, ApiKeyEntry>; oauth: Record<string, OAuthSessionRecord>; }
export interface FileProviderCredentialStore {
  readonly filePath: string;
  /** Prepare private mask targets before a privileged application starts untrusted shell work. */
  initialize?(): Promise<void>;
  describeApiKey(binding: ProviderCredentialFileBinding): Promise<ProviderApiKeyStatus>;
  /** Trusted Main only; never expose this secret-returning port to Renderer/Product RPC. */
  readApiKey(binding: ProviderCredentialFileBinding): Promise<StoredProviderApiKey | undefined>;
  setApiKey(binding: ProviderCredentialFileBinding, key: string, expectedRevision?: string | null): Promise<Extract<ProviderApiKeyStatus, { configured: true }>>;
  removeApiKey(binding: ProviderCredentialFileBinding, expectedRevision?: string | null): Promise<{ readonly configured: false; readonly revision: string }>;
  readonly oauth: OAuthSessionStore;
}
/** Trusted Main only: coherent reads and all-or-nothing conditional changes, using the same v2 document. */
export interface AtomicFileProviderCredentialStore extends FileProviderCredentialStore {
  initialize(): Promise<void>;
  readApiKeys(bindings: readonly ProviderCredentialFileBinding[]): Promise<readonly ProviderApiKeySnapshot[]>;
  updateApiKeys(changes: readonly ProviderApiKeyMutation[]): Promise<readonly ProviderApiKeyStatus[]>;
}
export class CredentialUpdateConflictError extends Error {
  constructor() { super('Credential update conflict. Refresh its state before retrying.'); this.name = 'CredentialUpdateConflictError'; }
}
function failure(): OAuthCredentialError { return new OAuthCredentialError('storage_failed'); }
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function secret(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && !/[\r\n]/.test(value); }
function bindingId(binding: ProviderCredentialFileBinding): string {
  if (!binding || Object.keys(binding).some(key => !['profile', 'provider', 'connectionFingerprint'].includes(key)) || typeof binding.profile !== 'string' || !binding.profile.trim() || typeof binding.provider !== 'string' || !binding.provider.trim()
    || !/^[a-f0-9]{64}$/.test(binding.connectionFingerprint)) throw failure();
  return createHash('sha256').update(JSON.stringify([binding.profile, binding.provider, binding.connectionFingerprint])).digest('hex');
}
function validRegistration(value: unknown, id: string): value is OAuthSessionRecord {
  if (!object(value) || Object.keys(value).some(key => !['id', 'service', 'clientId', 'issuer', 'accountId', 'identityKind', 'profile', 'credentials', 'resource'].includes(key)) || value.id !== id || !secret(value.clientId) || !secret(value.accountId)
    || !['openai-chatgpt', 'openai-codex', 'github-copilot', 'anthropic', 'openrouter', 'kimi-coding', 'meta', 'xai', 'radius'].includes(String(value.service))
    || (value.issuer !== undefined && !secret(value.issuer))
    || (value.profile !== undefined && (typeof value.profile !== 'string' || !value.profile.trim()))
    || (value.identityKind !== undefined && !['account', 'grant'].includes(String(value.identityKind)))) return false;
  return [value.credentials, value.resource].every(tokens => tokens === undefined || (object(tokens) && Object.keys(tokens).every(key => ['accessToken', 'refreshToken', 'expiresAt', 'scopes', 'earliestRefreshAt'].includes(key)) && secret(tokens.accessToken)
    && (tokens.refreshToken === undefined || secret(tokens.refreshToken)) && (tokens.expiresAt === undefined || (typeof tokens.expiresAt === 'number' && Number.isFinite(tokens.expiresAt)))
    && (tokens.earliestRefreshAt === undefined || (typeof tokens.earliestRefreshAt === 'number' && Number.isFinite(tokens.earliestRefreshAt)))
    && (tokens.scopes === undefined || (Array.isArray(tokens.scopes) && tokens.scopes.every(scope => typeof scope === 'string')))));
}
function document(value: unknown): AuthDocument {
  if (!object(value) || (value.version !== 1 && value.version !== 2) || !object(value.apiKeys) || !object(value.oauth)
    || Object.keys(value).some(key => !['version', 'apiKeys', 'oauth'].includes(key))) throw failure();
  for (const [id, entry] of Object.entries(value.apiKeys)) {
    if (!object(entry) || Object.keys(entry).some(key => !['binding', 'key', 'revision'].includes(key)) || !object(entry.binding)
      || ((value.version === 1 || entry.key !== undefined) && !secret(entry.key)) || !secret(entry.revision)
      || bindingId(entry.binding as unknown as ProviderCredentialFileBinding) !== id) throw failure();
  }
  for (const [id, record] of Object.entries(value.oauth)) if (!validRegistration(record, id)) throw failure();
  return { ...value, version: 2 } as unknown as AuthDocument;
}
async function readDocument(file: string): Promise<AuthDocument> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw failure();
    return document(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) { if (missing(error)) return { version: 2, apiKeys: {}, oauth: {} }; throw failure(); }
}
let windowsSid: string | undefined;
async function protectFile(file: string, directory = false): Promise<void> {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw failure();
  const systemDirectory = path.join(systemRoot, 'System32');
  if (!windowsSid) {
    const result = await promisify(execFile)(path.join(systemDirectory, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10000 });
    windowsSid = result.stdout.match(/"(S-[0-9-]+)"/)?.[1]; if (!windowsSid) throw failure();
  }
  // Replace the DACL in one operation. Incremental grants leave explicit
  // Administrators/CREATOR OWNER entries inherited by new staging files.
  const program = [
    "$ErrorActionPreference='Stop'",
    "$directory=$env:KODAX_AUTH_DIRECTORY -eq '1'",
    '$security=if($directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}',
    '$security.SetAccessRuleProtection($true,$false)',
    '$inheritance=if($directory){[Security.AccessControl.InheritanceFlags]3}else{[Security.AccessControl.InheritanceFlags]0}',
    "foreach($value in @($env:KODAX_AUTH_SID,'S-1-5-18')){",
    '$sid=[Security.Principal.SecurityIdentifier]::new($value)',
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)",
    '$security.AddAccessRule($rule)',
    '}',
    'if($directory){[IO.Directory]::SetAccessControl($env:KODAX_AUTH_FILE,$security)}else{[IO.File]::SetAccessControl($env:KODAX_AUTH_FILE,$security)}',
  ].join('\n');
  await promisify(execFile)(path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(program, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 10000,
      env: { ...process.env, KODAX_AUTH_FILE: file, KODAX_AUTH_SID: windowsSid, KODAX_AUTH_DIRECTORY: directory ? '1' : '0' },
    });
}
async function prepareStaging(file: string): Promise<string> {
  const staging = `${file}.staging`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const directory = await lstat(staging); if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure();
  if (process.platform === 'win32') await protectFile(staging, true); else await chmod(staging, 0o700);
  return staging;
}
async function writeDocument(file: string, next: AuthDocument, valid: () => boolean): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n'); if (bytes.length > 4 * 1024 * 1024) throw failure();
  const staging = await prepareStaging(file);
  const temporary = path.join(staging, `${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await protectFile(temporary); if (!valid()) throw failure(); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if (!valid()) throw failure(); await rename(temporary, file);
    if (process.platform !== 'win32') { const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } catch { throw failure(); }
  finally { bytes.fill(0); try { await unlink(temporary); } catch (error) { if (!missing(error)) throw failure(); } }
}
async function transaction<T>(file: string, operation: (current: AuthDocument) => Promise<T>, initialize = false): Promise<T> {
  let compromised = false;
  let release: () => Promise<void>;
  try { release = await lockfile.lock(file, { realpath: false, stale: 30000, update: 5000,
    retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 100 }, onCompromised: () => { compromised = true; } }); }
  catch { throw failure(); }
  try {
    const current = await readDocument(file), before = JSON.stringify(current);
    const result = await operation(current); document(current);
    if (compromised) throw failure();
    if (JSON.stringify(current) !== before || (initialize && !Object.keys(current.apiKeys).length && !Object.keys(current.oauth).length)) await writeDocument(file, current, () => !compromised);
    if (compromised) throw failure(); return result;
  } finally { try { await release(); } catch { throw failure(); } }
}
function own<T>(values: Record<string, T>, id: string): T | undefined { return Object.hasOwn(values, id) ? values[id] : undefined; }
function expectRevision(current: ApiKeyEntry | undefined, expected: string | null | undefined): void {
  if (expected !== undefined && (current?.revision ?? null) !== expected) throw new CredentialUpdateConflictError();
}
/** Explicit protected plaintext backend, not a fallback from an OS vault failure. */
export function createFileProviderCredentialStore(filePath: string): AtomicFileProviderCredentialStore {
  if (!path.isAbsolute(filePath)) throw new Error('Credential store requires an absolute trusted path.');
  const canonical = async () => {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    return path.join(await realpath(path.dirname(filePath)), path.basename(filePath));
  };
  const readApiKey = async (binding: ProviderCredentialFileBinding): Promise<StoredProviderApiKey | undefined> => {
    const id = bindingId(binding), data = await readDocument(await canonical()), entry = own(data.apiKeys, id);
    return entry?.key ? { key: entry.key, revision: entry.revision } : undefined;
  };
  const status = (entry: StoredProviderApiKey | undefined): ProviderApiKeyStatus => entry ? { configured: true, revision: entry.revision } : { configured: false };
  const oauth: OAuthSessionStore = { async transact(id, operation) {
      if (typeof id !== 'string' || !id.trim() || id.length > 512) throw failure();
      const file = await canonical(); shareOAuthSessionStoreIdentity(oauth, 'file:' + (process.platform === 'win32' ? file.toLowerCase() : file));
      return transaction(file, async data => {
        const previous = own(data.oauth, id), update = await operation(previous ? structuredClone(previous) : undefined);
        if (update.record) {
          if (!validRegistration(update.record, id) || (previous && (previous.service !== update.record.service || previous.clientId !== update.record.clientId
            || previous.accountId !== update.record.accountId || previous.issuer !== update.record.issuer || previous.identityKind !== update.record.identityKind || previous.profile !== update.record.profile))) throw failure();
          Object.defineProperty(data.oauth, id, { value: structuredClone(update.record), enumerable: true, configurable: true, writable: true });
        } else delete data.oauth[id];
        return update.result;
      });
  } };
  return { filePath,
    async readApiKeys(bindings) {
      const selected = bindings.map(binding => ({ binding: structuredClone(binding), id: bindingId(binding) }));
      const data = await readDocument(await canonical());
      return selected.map(({ binding, id }) => {
        const entry = own(data.apiKeys, id);
        return { binding, revision: entry?.revision ?? null, ...(entry?.key === undefined ? {} : { key: entry.key }) };
      });
    },
    async updateApiKeys(changes) {
      const selected = structuredClone(changes).map(change => ({ ...change, id: bindingId(change.binding) }));
      if (new Set(selected.map(change => change.id)).size !== selected.length || selected.some(change =>
        (change.expectedRevision !== null && !secret(change.expectedRevision)) || (change.key !== undefined && !secret(change.key)))) throw failure();
      return transaction(await canonical(), async data => {
        for (const change of selected) expectRevision(own(data.apiKeys, change.id), change.expectedRevision);
        return selected.map(change => {
          const revision = randomUUID(); data.apiKeys[change.id] = { binding: change.binding, revision, ...(change.key === undefined ? {} : { key: change.key }) };
          return change.key === undefined ? { configured: false as const, revision } : { configured: true as const, revision };
        });
      });
    },
    async initialize() { const file = await canonical(); await prepareStaging(file); await transaction(file, async () => undefined, true); if (process.platform === 'win32') await protectFile(file); else await chmod(file, 0o600); }, readApiKey, describeApiKey: async binding => {
    const entry = own((await readDocument(await canonical())).apiKeys, bindingId(binding));
    return entry?.key ? status({ key: entry.key, revision: entry.revision }) : { configured: false, ...(entry ? { revision: entry.revision } : {}) };
  },
    async setApiKey(binding, key, expectedRevision) {
      binding = structuredClone(binding); const id = bindingId(binding); if (!secret(key)) throw failure();
      return transaction(await canonical(), async data => {
        expectRevision(own(data.apiKeys, id), expectedRevision);
        const entry = { binding, key, revision: randomUUID() }; data.apiKeys[id] = entry; return { configured: true as const, revision: entry.revision };
      });
    },
    async removeApiKey(binding, expectedRevision) {
      const id = bindingId(binding);
      return transaction(await canonical(), async data => {
        expectRevision(own(data.apiKeys, id), expectedRevision); const revision = randomUUID();
        data.apiKeys[id] = { binding: structuredClone(binding), revision }; return { configured: false, revision };
      });
    },
    oauth,
  };
}
