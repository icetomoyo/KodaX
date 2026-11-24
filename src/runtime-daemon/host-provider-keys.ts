import { createHash } from 'node:crypto';
import path from 'node:path';
import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import {
  createFileProviderCredentialStore, createStoredProviderApiKeyReader, CredentialUpdateConflictError,
  setAmbientProviderKeySource,
} from '@kodax-ai/llm';
import { HostProtocolError } from '../host-protocol/codec.js';
import {
  createProviderCredentialManager, ProviderCredentialError, type ProviderCredentialStatus,
} from '../provider-credential-manager.js';

/** The keys the Host keeps are the owner's, saved under this profile. */
const PROFILE = 'default';

/** What a client may learn about a provider's key. Never the key itself. */
export interface HostProviderKeyStatus {
  readonly provider: string;
  readonly apiKeyEnv: string;
  readonly stored: boolean;
  /** Where the Host takes the key from now. The environment wins over the file. */
  readonly source: ProviderCredentialStatus['source'];
  /** Opaque. Changes whenever the stored key, the connection or the config changes. */
  readonly revision: string;
}

export interface HostProviderKeys {
  get(provider: string): Promise<HostProviderKeyStatus>;
  set(provider: string, key: string, ifRevision?: string): Promise<HostProviderKeyStatus>;
  remove(provider: string, ifRevision?: string): Promise<HostProviderKeyStatus>;
}

type Environment = () => Readonly<Record<string, string | undefined>>;

function authFile(configPath: string): string {
  return path.join(path.dirname(configPath), 'auth.json');
}

/**
 * Lets the Host's Runs use the keys saved next to its config when its
 * environment holds none. A key file the Host cannot read leaves the saved keys
 * unused and is reported once, so listing providers never breaks on it.
 * Returns the function that stops it.
 */
export function useHostStoredProviderKeys(
  configPath: string,
  warn: (message: string) => void = message => emitKodaXDiagnostic({ source: 'host-provider-keys', level: 'warn', message }),
): () => void {
  const read = createStoredProviderApiKeyReader(authFile(configPath));
  let warned = false;
  return setAmbientProviderKeySource((provider, connectionFingerprint) => {
    try {
      const key = read({ profile: PROFILE, provider, connectionFingerprint });
      warned = false;
      return key;
    } catch {
      if (!warned) warn(`Cannot read the saved provider keys in ${authFile(configPath)}; Runs use environment keys only until it is fixed.`);
      warned = true;
      return undefined;
    }
  });
}

function hostError(error: unknown): unknown {
  if (error instanceof CredentialUpdateConflictError) {
    return new HostProtocolError('conflict', 'The key changed. Read its state again before retrying.', { reason: 'revision_mismatch', cause: error });
  }
  if (!(error instanceof ProviderCredentialError)) return error;
  switch (error.reason) {
    case 'unknown_provider': return new HostProtocolError('not_found', error.message, { cause: error });
    case 'external_auth': return new HostProtocolError('invalid_params', error.message, { cause: error });
    case 'changed': return new HostProtocolError('conflict', error.message, { reason: 'revision_mismatch', cause: error });
    case 'unreadable_config': return new HostProtocolError('invalid_state', error.message, { cause: error });
  }
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { throw hostError(error); }
}

/** The owner's admin for the keys the Host keeps. Env-first, as the Host uses them. */
export function createHostProviderKeys(configPath: string, environment: Environment = () => process.env): HostProviderKeys {
  const manager = createProviderCredentialManager({ configPath, profile: PROFILE, environment });
  const store = createFileProviderCredentialStore(authFile(configPath));
  const view = (provider: string, status: ProviderCredentialStatus): HostProviderKeyStatus => {
    const external = status.source === 'oauth' || status.source === 'external';
    const source = !external && environment()[status.apiKeyEnv]?.trim() ? 'environment' : status.source;
    const revision = createHash('sha256')
      .update(JSON.stringify([status.configRevision, status.binding.connectionFingerprint, status.revision]))
      .digest('hex');
    return { provider, apiKeyEnv: status.apiKeyEnv, stored: status.stored, source, revision };
  };
  const checked = (provider: string, status: ProviderCredentialStatus, ifRevision: string | undefined): void => {
    if (ifRevision !== undefined && ifRevision !== view(provider, status).revision) {
      throw new HostProtocolError('conflict', 'The key changed. Read its state again before retrying.', { reason: 'revision_mismatch' });
    }
  };
  return {
    get: provider => mapped(async () => view(provider, await manager.describe(provider))),
    set: (provider, key, ifRevision) => mapped(async () => {
      const status = await manager.describe(provider);
      // A resent set that already holds answers with the state as it is.
      if (status.stored && (await store.readApiKey(status.binding))?.key === key) return view(provider, status);
      checked(provider, status, ifRevision);
      return view(provider, await manager.setApiKey(provider, key, status));
    }),
    remove: (provider, ifRevision) => mapped(async () => {
      const status = await manager.describe(provider);
      if (!status.stored) return view(provider, status);
      checked(provider, status, ifRevision);
      return view(provider, await manager.removeApiKey(provider, status));
    }),
  };
}
