/**
 * First-run provider setup.
 *
 * This module owns only provider/model metadata. API key values never cross
 * this boundary: setup records the environment-variable *name* and asks the
 * user to set its value outside KodaX before restarting the terminal.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  KODAX_DEFAULT_PROVIDER,
  KODAX_PROVIDER_SNAPSHOTS,
  getAgentConfigPath,
  validateCustomProviderConfig,
  type KodaXCustomProviderConfig,
} from '@kodax-ai/coding';
import {
  CoreConfigWriteConflictError,
  withCoreConfigWriteLock,
} from './core-config-lock.js';

export interface ProviderSetupCatalogEntry {
  readonly name: string;
  readonly apiKeyEnv: string;
  readonly defaultModel: string;
  readonly models: readonly string[];
}

export type ProviderSetupReadiness =
  | {
      readonly status: 'needs-host-broker';
      readonly configPath: string;
      readonly configRevision: string;
      readonly provider: string;
    }
  | {
      readonly status: 'ready';
      readonly configPath: string;
      readonly configRevision: string;
      readonly provider?: string;
    }
  | {
      readonly status: 'needs-provider';
      readonly configPath: string;
      readonly configRevision: string;
    }
  | {
      readonly status: 'needs-credential';
      readonly configPath: string;
      readonly configRevision: string;
      readonly provider: string;
      readonly apiKeyEnv?: string;
    }
  | {
      readonly status: 'invalid-config';
      readonly configPath: string;
      readonly configRevision: string;
      readonly reason: string;
    };

export type ProviderSetupChoice =
  | {
      readonly kind: 'builtin';
      readonly provider: string;
      readonly model: string;
    }
  | {
      readonly kind: 'custom';
      readonly provider: ProviderSetupCustomProviderMetadata;
    };

/** The setup flow accepts public connection metadata, never provider secrets. */
export interface ProviderSetupCustomProviderMetadata extends Pick<KodaXCustomProviderConfig,
  'oauthRegistration' | 'models' | 'toolCapabilities' | 'cacheCapabilities' | 'reasoningProfile' | 'reasoningCapability' | 'reasoningPreset' | 'reasoning'
  | 'contextWindow' | 'maxOutputTokens' | 'supportsThinking' | 'imageInput' | 'promptCacheAffinity'
  | 'replayReasoningContent' | 'strictThinkingSignature' | 'verifyStrategy'> {
  readonly name: string;
  readonly protocol: KodaXCustomProviderConfig['protocol'];
  readonly api?: KodaXCustomProviderConfig['api'];
  readonly oauth?: KodaXCustomProviderConfig['oauth'];
  readonly cloud?: KodaXCustomProviderConfig['cloud'];
  readonly authentication?: KodaXCustomProviderConfig['authentication'];
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly model: string;
}

export interface InspectProviderSetupReadinessInput {
  readonly configPath?: string;
  readonly catalog?: readonly ProviderSetupCatalogEntry[];
  readonly environment?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly explicitProvider?: string;
}

export interface PersistProviderSetupChoiceInput {
  readonly configPath?: string;
  readonly expectedRevision: string;
  readonly catalog?: readonly ProviderSetupCatalogEntry[];
  readonly choice: ProviderSetupChoice;
}

export interface PersistedProviderSetupChoice {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly configPath: string;
}

export class ProviderSetupConfigConflictError extends Error {
  constructor(configPath: string) {
    super(`KodaX configuration changed while setup was open: ${configPath}. Re-run \`kodax setup\`.`);
    this.name = 'ProviderSetupConfigConflictError';
  }
}

export class ProviderSetupInvalidConfigError extends Error {
  constructor(configPath: string, reason: string) {
    super(`KodaX configuration cannot be safely updated: ${configPath}. ${reason}`);
    this.name = 'ProviderSetupInvalidConfigError';
  }
}

interface ParsedConfig {
  readonly configPath: string;
  readonly revision: string;
  readonly exists: boolean;
  readonly config?: Record<string, unknown>;
  readonly error?: string;
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CREDENTIAL_QUERY_PARAMETER_NAMES = new Set([
  'accesskey',
  'apikey',
  'accesstoken',
  'auth',
  'authorization',
  'bearertoken',
  'clientsecret',
  'credential',
  'key',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sig',
  'signature',
  'token',
  'xapikey',
]);

/** Built-in API providers only. CLI bridges retain their own authentication flows. */
export function getProviderSetupCatalog(): readonly ProviderSetupCatalogEntry[] {
  return Object.entries(KODAX_PROVIDER_SNAPSHOTS)
    .filter(([, snapshot]) => snapshot.capabilityProfile.transport !== 'cli-bridge')
    .map(([name, snapshot]) => ({
      name,
      apiKeyEnv: snapshot.apiKeyEnv,
      defaultModel: snapshot.model,
      models: [...new Set(snapshot.models
        ? [snapshot.model, ...snapshot.models.map((model) => model.id)]
        : [snapshot.model])],
    }))
    .sort((left, right) => {
      if (left.name === KODAX_DEFAULT_PROVIDER) return -1;
      if (right.name === KODAX_DEFAULT_PROVIDER) return 1;
      return left.name.localeCompare(right.name);
    });
}

/**
 * Determine whether automatic setup is appropriate without exposing an API-key
 * value to callers. An explicit provider or an existing valid config is never
 * replaced by automatic setup.
 */
export function inspectProviderSetupReadiness(
  input: InspectProviderSetupReadinessInput = {},
): ProviderSetupReadiness {
  const configPath = input.configPath ?? getAgentConfigPath('config.json');
  const catalog = input.catalog ?? getProviderSetupCatalog();
  const environment = input.environment ?? process.env;
  const parsed = readConfig(configPath);

  if (!parsed.config) {
    return {
      status: 'invalid-config',
      configPath,
      configRevision: parsed.revision,
      reason: parsed.error ?? 'config.json is not a JSON object.',
    };
  }
  const customProvidersError = existingCustomProvidersError(parsed.config);
  if (customProvidersError) {
    return {
      status: 'invalid-config',
      configPath,
      configRevision: parsed.revision,
      reason: customProvidersError,
    };
  }

  const explicitProvider = normalizedString(input.explicitProvider);
  if (explicitProvider) {
    const selected = resolveConfiguredProvider(parsed.config, explicitProvider, catalog);
    if (selected?.hostBroker) return { status: 'needs-host-broker', configPath, configRevision: parsed.revision, provider: explicitProvider };
    return selected && (!selected.requiresCredential
      || hasEnvironmentValue(environment, selected.apiKeyEnv))
      ? ready(configPath, parsed.revision, explicitProvider)
      : needsCredential(configPath, parsed.revision, explicitProvider, selected?.apiKeyEnv);
  }

  if (!parsed.exists) {
    return {
      status: 'needs-provider',
      configPath,
      configRevision: parsed.revision,
    };
  }

  const configuredProvider = normalizedString(parsed.config.provider);
  if (configuredProvider) {
    const selected = resolveConfiguredProvider(parsed.config, configuredProvider, catalog);
    if (!selected) {
      return {
        status: 'invalid-config',
        configPath,
        configRevision: parsed.revision,
        reason: `provider "${configuredProvider}" is not a valid built-in or custom provider.`,
      };
    }
    if (selected.hostBroker) return { status: 'needs-host-broker', configPath, configRevision: parsed.revision, provider: configuredProvider };
    return !selected.requiresCredential || hasEnvironmentValue(environment, selected.apiKeyEnv)
      ? ready(configPath, parsed.revision, configuredProvider)
      : needsCredential(configPath, parsed.revision, configuredProvider, selected.apiKeyEnv);
  }

  return {
    status: 'needs-provider',
    configPath,
    configRevision: parsed.revision,
  };
}

/**
 * Persist only non-secret provider metadata. The revision check prevents a
 * setup screen from replacing edits made by another process while it was open.
 */
export function persistProviderSetupChoice(
  input: PersistProviderSetupChoiceInput,
): PersistedProviderSetupChoice {
  const configPath = input.configPath ?? getAgentConfigPath('config.json');
  const catalog = input.catalog ?? getProviderSetupCatalog();
  try {
    return withCoreConfigWriteLock(configPath, () => {
      const parsed = readConfig(configPath);
      if (!parsed.config) {
        throw new ProviderSetupInvalidConfigError(
          configPath,
          parsed.error ?? 'config.json is invalid JSON.',
        );
      }
      if (parsed.revision !== input.expectedRevision) {
        throw new ProviderSetupConfigConflictError(configPath);
      }
      assertCustomProvidersPreservable(parsed.config, configPath);

      const selection = normalizeProviderSetupChoice(input.choice, catalog, parsed.config);
      const next = {
        ...parsed.config,
        provider: selection.provider,
        model: selection.model,
        ...(selection.customProviders ? { customProviders: selection.customProviders } : {}),
      };
      if (readConfig(configPath).revision !== input.expectedRevision) {
        throw new ProviderSetupConfigConflictError(configPath);
      }
      writeConfigAtomically(configPath, next);
      return {
        provider: selection.provider,
        model: selection.model,
        apiKeyEnv: selection.apiKeyEnv,
        configPath,
      };
    });
  } catch (error) {
    if (error instanceof CoreConfigWriteConflictError) {
      throw new ProviderSetupConfigConflictError(configPath);
    }
    throw error;
  }
}

export function providerSetupRestartInstructions(input: {
  readonly apiKeyEnv: string;
  readonly platform?: NodeJS.Platform;
  readonly credentialSource?: 'file';
}): readonly string[] {
  if (input.credentialSource === 'file') return [
    'The API key was saved in permission-protected plaintext auth.json, separately from config.json.',
    'Run `kodax` again. No environment-variable setup is required for this saved connection.',
    'Saving a key does not verify its online validity or model entitlement.',
  ];
  const platform = input.platform ?? process.platform;
  const environmentStep = platform === 'win32'
    ? `Required next step: use this provider's API key as the value of the user environment variable "${input.apiKeyEnv}" in Windows Environment Variables.`
    : `Required next step: use this provider's API key as the value of the environment variable "${input.apiKeyEnv}" in your shell profile.`;
  return [
    `config.json stores the environment-variable name only: "${input.apiKeyEnv}"; it never stores the API key.`,
    environmentStep,
    'KodaX cannot set this environment variable for you.',
    'Close and restart this terminal so the environment is refreshed.',
    'Then run `kodax` again.',
    'Optional: run `kodax doctor` to verify local configuration without an LLM request.',
  ];
}

function ready(configPath: string, configRevision: string, provider?: string): ProviderSetupReadiness {
  return { status: 'ready', configPath, configRevision, ...(provider ? { provider } : {}) };
}

function needsCredential(
  configPath: string,
  configRevision: string,
  provider: string,
  apiKeyEnv?: string,
): ProviderSetupReadiness {
  return {
    status: 'needs-credential',
    configPath,
    configRevision,
    provider,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function hasEnvironmentValue(
  environment: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  name: string | undefined,
): boolean {
  return name !== undefined && Boolean(environment[name]?.trim());
}

function resolveConfiguredProvider(
  config: Record<string, unknown>,
  name: string,
  catalog: readonly ProviderSetupCatalogEntry[],
): {
  readonly apiKeyEnv?: string;
  readonly requiresCredential: boolean;
  readonly hostBroker?: boolean;
} | undefined {
  const builtin = catalog.find((entry) => entry.name === name);
  if (builtin) return { apiKeyEnv: builtin.apiKeyEnv, requiresCredential: true };

  const snapshot = Object.entries(KODAX_PROVIDER_SNAPSHOTS)
    .find(([providerName]) => providerName === name)?.[1];
  if (snapshot?.capabilityProfile.transport === 'cli-bridge') {
    // A deliberately selected CLI bridge owns its own login/authentication
    // flow. First-run API-key setup must not invalidate or overwrite it.
    return { requiresCredential: false };
  }

  const custom = findValidCustomProvider(config, name);
  return custom
    ? { apiKeyEnv: custom.apiKeyEnv, requiresCredential: true, ...(custom.oauth || custom.cloud ? { hostBroker: true } : {}) }
    : undefined;
}

function assertCustomProvidersPreservable(
  config: Record<string, unknown>,
  configPath: string,
): void {
  const reason = existingCustomProvidersError(config);
  if (reason) {
    throw new ProviderSetupInvalidConfigError(
      configPath,
      reason,
    );
  }
}

function existingCustomProvidersError(config: Record<string, unknown>): string | undefined {
  const existing = config.customProviders;
  if (existing === undefined) return undefined;
  if (!Array.isArray(existing)) {
    return 'Existing customProviders must be an array; repair it before running setup.';
  }
  const names = new Set<string>();
  for (const value of existing) {
    const provider = toValidCustomProvider(value);
    if (!provider) {
      return 'Existing customProviders contains an invalid entry; repair it before running setup.';
    }
    const endpointError = customProviderEndpointError(provider.baseUrl);
    if (endpointError) {
      return `Existing customProviders entry "${provider.name}" is unsafe: ${endpointError}`;
    }
    if (names.has(provider.name)) {
      return `Existing customProviders contains duplicate name "${provider.name}"; repair it before running setup.`;
    }
    names.add(provider.name);
  }
  return undefined;
}

function findValidCustomProvider(
  config: Record<string, unknown>,
  name: string,
): KodaXCustomProviderConfig | undefined {
  const values = config.customProviders;
  if (!Array.isArray(values)) return undefined;
  for (const value of values) {
    const provider = toValidCustomProvider(value);
    if (provider?.name === name) return provider;
  }
  return undefined;
}

function toValidCustomProvider(value: unknown): KodaXCustomProviderConfig | undefined {
  if (!isRecord(value)) return undefined;
  const { name, protocol, baseUrl, apiKeyEnv, model } = value;
  if (
    typeof name !== 'string'
    || !['openai', 'anthropic', 'google', 'bedrock', 'mistral', 'pi-messages'].includes(String(protocol))
    || typeof baseUrl !== 'string'
    || typeof apiKeyEnv !== 'string'
    || typeof model !== 'string'
  ) {
    return undefined;
  }
  const provider: KodaXCustomProviderConfig = {
    ...value,
    name,
    protocol: protocol as KodaXCustomProviderConfig['protocol'],
    baseUrl,
    apiKeyEnv,
    model,
  };
  try {
    validateCustomProviderConfig(provider);
    return ENVIRONMENT_VARIABLE_NAME.test(provider.apiKeyEnv) ? provider : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderSetupChoice(
  choice: ProviderSetupChoice,
  catalog: readonly ProviderSetupCatalogEntry[],
  current: Record<string, unknown>,
): {
  readonly provider: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly customProviders?: KodaXCustomProviderConfig[];
} {
  if (choice.kind === 'builtin') {
    const provider = catalog.find((entry) => entry.name === choice.provider);
    if (!provider || !provider.models.includes(choice.model)) {
      throw new Error('Choose a supported built-in provider and model.');
    }
    return {
      provider: provider.name,
      model: choice.model,
      apiKeyEnv: provider.apiKeyEnv,
    };
  }

  const customProvider = validateProviderSetupCustomMetadata(choice.provider);
  if (catalog.some((entry) => entry.name === customProvider.name)) {
    throw new Error(`Custom provider name "${customProvider.name}" conflicts with a built-in provider.`);
  }
  const existing = current.customProviders;
  const previous = Array.isArray(existing)
    ? existing.flatMap((value) => {
        const provider = toValidCustomProvider(value);
        return provider ? [provider] : [];
      })
    : [];
  const duplicate = previous.find((provider) => provider.name === customProvider.name);
  const customProviders = duplicate
    ? previous.map((provider) => provider.name === customProvider.name ? customProvider : provider)
    : [...previous, customProvider];
  return {
    provider: customProvider.name,
    model: customProvider.model,
    apiKeyEnv: customProvider.apiKeyEnv,
    customProviders,
  };
}

/**
 * Validate and project custom setup metadata before it is displayed or
 * persisted. Unknown runtime fields are deliberately discarded.
 */
export function validateProviderSetupCustomMetadata(
  provider: ProviderSetupCustomProviderMetadata,
): KodaXCustomProviderConfig {
  const normalized: KodaXCustomProviderConfig = {
    name: provider.name.trim(),
    protocol: provider.protocol,
    ...(provider.api !== undefined ? { api: provider.api } : {}),
    ...(provider.oauth !== undefined ? { oauth: provider.oauth } : {}),
    ...(provider.cloud !== undefined ? { cloud: provider.cloud } : {}),
    ...(provider.authentication !== undefined ? { authentication: provider.authentication } : {}),
    baseUrl: provider.baseUrl.trim(),
    apiKeyEnv: provider.apiKeyEnv.trim(),
    model: provider.model.trim(),
  };
  for (const key of ['oauthRegistration', 'models', 'toolCapabilities', 'cacheCapabilities', 'reasoningProfile', 'reasoningCapability', 'reasoningPreset', 'reasoning',
    'contextWindow', 'maxOutputTokens', 'supportsThinking', 'imageInput', 'promptCacheAffinity',
    'replayReasoningContent', 'strictThinkingSignature', 'verifyStrategy'] as const) {
    if (provider[key] !== undefined) Object.assign(normalized, { [key]: structuredClone(provider[key]) });
  }
  const endpointError = customProviderEndpointError(normalized.baseUrl);
  if (endpointError) throw new Error(endpointError);
  validateCustomProviderConfig(normalized);
  if (!ENVIRONMENT_VARIABLE_NAME.test(normalized.apiKeyEnv)) {
    throw new Error('Custom provider API key environment variable name is invalid.');
  }
  return normalized;
}

function customProviderEndpointError(baseUrl: string): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return 'Custom provider Base URL must be a valid absolute URL.';
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return 'Custom provider Base URL must use http or https.';
  }
  if (parsedUrl.username || parsedUrl.password) {
    return 'Custom provider Base URL must not contain credentials.';
  }
  const credentialParameter = [...parsedUrl.searchParams.keys()].find((name) => (
    CREDENTIAL_QUERY_PARAMETER_NAMES.has(name.toLowerCase().replace(/[-_.]/g, ''))
  ));
  return credentialParameter === undefined
    ? undefined
    : `Custom provider Base URL must not contain credential query parameter "${credentialParameter}".`;
}

function readConfig(configPath: string): ParsedConfig {
  if (!fs.existsSync(configPath)) {
    return {
      configPath,
      revision: revisionFor(undefined),
      exists: false,
      config: {},
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      configPath,
      revision: revisionFor(undefined),
      exists: true,
      error: error instanceof Error ? error.message : 'config.json cannot be read.',
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return {
        configPath,
        revision: revisionFor(raw),
        exists: true,
        error: 'config.json must contain a JSON object.',
      };
    }
    return {
      configPath,
      revision: revisionFor(raw),
      exists: true,
      config: parsed,
    };
  } catch (error) {
    return {
      configPath,
      revision: revisionFor(raw),
      exists: true,
      error: error instanceof Error ? error.message : 'config.json is invalid JSON.',
    };
  }
}

function revisionFor(raw: string | undefined): string {
  return createHash('sha256').update(raw ?? '<missing>', 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeConfigAtomically(configPath: string, config: Record<string, unknown>): void {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.config.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}


/** Update only a non-secret OAuth registration reference under the existing config writer lock. */
export function linkProviderOAuthRegistration(input: { configPath?: string; name: string; service: NonNullable<KodaXCustomProviderConfig['oauth']>;
  expectedRegistration?: string; registration?: string }): void {
  const configPath = input.configPath ?? getAgentConfigPath('config.json');
  withCoreConfigWriteLock(configPath, () => {
    const snapshot = readConfig(configPath);
    if (snapshot.error || !snapshot.config) throw new ProviderSetupInvalidConfigError(configPath, snapshot.error ?? 'Missing configuration.');
    const providers = snapshot.config.customProviders;
    if (!Array.isArray(providers)) throw new Error('OAuth login requires a configured custom connection.');
    let matched = false;
    const next = providers.map(value => {
      const provider = toValidCustomProvider(value);
      if (!provider || provider.name !== input.name) return value;
      if (provider.oauth !== input.service || provider.oauthRegistration !== input.expectedRegistration) throw new ProviderSetupConfigConflictError(configPath);
      matched = true;
      const updated = { ...provider, oauthRegistration: input.registration }; validateCustomProviderConfig(updated); return updated;
    });
    if (!matched) throw new ProviderSetupConfigConflictError(configPath);
    writeConfigAtomically(configPath, { ...snapshot.config, customProviders: next });
  });
}
