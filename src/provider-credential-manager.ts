import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAgentConfigPath } from '@kodax-ai/agent';
import { createCustomProvider, createFileProviderCredentialStore, getProvider, KODAX_PROVIDER_SNAPSHOTS,
  validateCustomProviderConfig, type KodaXCustomProviderConfig, type ProviderCredentialFileBinding } from '@kodax-ai/llm';

export interface ProviderCredentialStatus {
  readonly binding: ProviderCredentialFileBinding;
  readonly configRevision: string;
  readonly revision: string | null;
  readonly apiKeyEnv: string;
  readonly stored: boolean;
  readonly configured: boolean;
  readonly source: 'file' | 'environment' | 'cloud' | 'oauth' | 'external' | 'missing';
}
export interface ProviderCredentialManager {
  readonly filePath: string;
  describe(provider: string): Promise<ProviderCredentialStatus>;
  setApiKey(provider: string, key: string, expected: ProviderCredentialStatus): Promise<ProviderCredentialStatus>;
  removeApiKey(provider: string, expected: ProviderCredentialStatus): Promise<ProviderCredentialStatus>;
}
async function readConfig(file: string): Promise<{ config: Record<string, unknown>; revision: string }> {
  let bytes = '';
  try { bytes = await readFile(file, 'utf8'); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw new Error('Cannot read provider configuration.'); }
  let config: unknown; try { config = bytes ? JSON.parse(bytes) as unknown : {}; } catch { throw new Error('Invalid provider configuration.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid provider configuration.');
  return { config: config as Record<string, unknown>, revision: createHash('sha256').update(bytes).digest('hex') };
}
function configuredTarget(config: Record<string, unknown>, name: string) {
  const builtin = Object.entries(KODAX_PROVIDER_SNAPSHOTS).find(([id]) => id === name)?.[1];
  if (builtin) return { provider: getProvider(name), apiKeyEnv: builtin.apiKeyEnv, kind: builtin.capabilityProfile.transport === 'cli-bridge' ? 'external' as const : 'key' as const };
  const candidates = config.customProviders;
  if (!Array.isArray(candidates)) throw new Error('Unknown configured provider.');
  const matches: unknown[] = candidates.filter((value: unknown) => value && typeof value === 'object' && 'name' in value && value.name === name);
  if (matches.length !== 1) throw new Error('Unknown or duplicate configured provider.');
  const connection = matches[0] as KodaXCustomProviderConfig; validateCustomProviderConfig(connection);
  return { provider: createCustomProvider(connection), apiKeyEnv: connection.apiKeyEnv,
    kind: connection.oauth ? 'oauth' as const : connection.cloud ? 'cloud' as const : 'key' as const };
}
/** Trusted Main facade: UI may write a Key and inspect status, never read its original value. */
export function createProviderCredentialManager(input: { readonly configPath?: string; readonly profile?: string;
  readonly environment?: () => Readonly<Record<string, string | undefined>> } = {}): ProviderCredentialManager {
  const configPath = input.configPath ?? getAgentConfigPath('config.json'), profile = input.profile ?? 'default';
  if (!path.isAbsolute(configPath) || !profile.trim()) throw new Error('Credential manager requires a trusted config path and profile.');
  const store = createFileProviderCredentialStore(path.join(path.dirname(configPath), 'auth.json'));
  const target = async (name: string) => {
    const parsed = await readConfig(configPath), connection = configuredTarget(parsed.config, name);
    return { ...connection, configRevision: parsed.revision, binding: { profile, provider: name, connectionFingerprint: connection.provider.getCredentialConnectionFingerprint() } };
  };
  const describe = async (name: string): Promise<ProviderCredentialStatus> => {
    const selected = await target(name), saved = await store.describeApiKey(selected.binding);
    const environment = (input.environment?.() ?? process.env)[selected.apiKeyEnv]?.trim();
    const source = selected.kind === 'oauth' || selected.kind === 'external' ? selected.kind : saved.configured ? 'file'
      : environment ? 'environment' : selected.kind === 'cloud' ? 'cloud' : 'missing';
    return { binding: selected.binding, configRevision: selected.configRevision, revision: saved.revision ?? null,
      apiKeyEnv: selected.apiKeyEnv, stored: saved.configured, configured: source === 'file' || source === 'environment', source };
  };
  const mutate = async (name: string, expected: ProviderCredentialStatus, update?: { readonly key: string }) => {
    if (!expected || (expected.revision !== null && (typeof expected.revision !== 'string' || !expected.revision.trim()))) throw new Error('Credential update requires an expected revision. Refresh its state before retrying.');
    const selected = await target(name);
    if (selected.kind === 'oauth' || selected.kind === 'external') throw new Error(`Use the provider's ${selected.kind === 'oauth' ? 'OAuth' : 'external'} authentication flow.`);
    if (expected.configRevision !== selected.configRevision || expected.binding.profile !== selected.binding.profile
      || expected.binding.provider !== selected.binding.provider || expected.binding.connectionFingerprint !== selected.binding.connectionFingerprint) throw new Error('Provider configuration or connection changed. Refresh its state before retrying.');
    const previous = await store.readApiKey(selected.binding);
    const saved = update === undefined ? await store.removeApiKey(selected.binding, expected.revision) : await store.setApiKey(selected.binding, update.key, expected.revision);
    try {
      if ((await readConfig(configPath)).revision !== selected.configRevision) throw new Error('Provider configuration changed while saving credentials.');
      return await describe(name);
    } catch (error) {
      try { if (previous) await store.setApiKey(selected.binding, previous.key, saved.revision); else await store.removeApiKey(selected.binding, saved.revision); }
      catch (rollback) { throw new AggregateError([error, rollback], 'Credential update failed and rollback conflicted. Refresh its state before retrying.'); }
      throw error;
    }
  };
  return { filePath: store.filePath, describe, setApiKey: (name, key, expected) => mutate(name, expected, { key }), removeApiKey: (name, expected) => mutate(name, expected) };
}
