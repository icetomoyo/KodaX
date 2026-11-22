/**
 * The Host's saved configuration and the providers a person added: the
 * defaults every Session starts from. Only the owner may change them for now;
 * a platform may later open them to the person, item by item.
 *
 * Secrets never come back: a field whose name says it holds a key, token or
 * password reads as `[redacted]`.
 */
import { z } from 'zod/v4';

import { hostCommandParams, hostList, hostParams, hostResult, type HostMethodRegistry } from './schema.js';
import { CredentialLeases } from './lease.js';

/** A saved document as the Host keeps it, with its secrets redacted. */
const Document = z.record(z.string(), z.unknown());

/**
 * The saved configuration, and its `revision` for `ifRevision`. The revision
 * covers what a client can read, so a change to a secret alone keeps it.
 */
const SavedConfig = hostResult({ config: Document, revision: z.string() });

const Name = z.string().min(1).max(256);

/** A change to the saved configuration. A field set to `null` is removed, so its default applies again. */
const ConfigPatch = z.strictObject({
  provider: Name.nullable(),
  model: Name.nullable(),
  effort: Name.nullable(),
  planModeEffort: Name.nullable(),
  thinking: z.boolean().nullable(),
  reasoningMode: z.enum(['off', 'auto', 'quick', 'balanced', 'deep']).nullable(),
  permissionMode: z.enum(['plan', 'accept-edits', 'auto', 'full-access']).nullable(),
  locale: Name.nullable(),
  /** The models offered for each provider, by provider name. */
  providerModels: z.record(Name, z.array(Name)).nullable(),
  /** Extension modules the Host loads, as paths or package names on the Host. */
  extensions: z.array(z.string().min(1).max(4096)).nullable(),
  repoIntelligenceMode: z.enum(['auto', 'off', 'light', 'full']).nullable(),
  repoIntelligenceTrace: z.boolean().nullable(),
  stallLog: z.boolean().nullable(),
  /** Providers a child Agent turns to, in order, when its own fails. */
  fallbackProviders: z.array(Name).nullable(),
  fastProvider: Name.nullable(),
  fastModel: Name.nullable(),
  deepProvider: Name.nullable(),
  deepModel: Name.nullable(),
  maxOutputTokens: z.int().positive().nullable(),
  disablePromptCache: z.boolean().nullable(),
  lsp: z.boolean().nullable(),
  lspAutoDownload: z.boolean().nullable(),
  acpLogLevel: Name.nullable(),
  sessionRetentionDays: z.int().positive().nullable(),
  repoIntelligence: z.strictObject({
    toolWaitMs: z.int().nonnegative(),
    workerTimeoutMs: z.int().positive(),
    workerOldSpaceMb: z.int().positive(),
    /** Where the code index is kept, as a path on the Host. */
    storageDir: z.string().min(1).max(4096),
  }).partial().nullable(),
  workflow: z.strictObject({ maxConcurrency: z.int().positive() }).partial().nullable(),
}).partial();

/** Where a setting in effect comes from, highest first: `runtime_override`, `environment`, `persisted`, `unset`. */
const EffectiveEntry = z.object({
  present: z.boolean(),
  /** Whether the value is in effect now. A saved value some take only at the next Run or restart is not yet. */
  applied: z.boolean(),
  source: z.string(),
  priority: z.int(),
  value: z.unknown().optional(),
});

const ConfigGetResult = hostResult({
  config: Document,
  revision: z.string(),
  effective: z.object({
    /** `loaded`, `missing` or `invalid`: whether the saved configuration could be read. */
    persisted: z.string(),
    /** What is in effect, by setting name. */
    entries: z.record(z.string(), EffectiveEntry),
    /** Which provider keys the Host's environment holds, by variable name. Never their values. */
    credentials: z.record(z.string(), z.object({ present: z.boolean(), source: z.string() })),
    /** When a changed setting takes effect: `immediate`, `next_run`, `restart` or `extension_reload`. */
    application: z.record(z.string(), z.string()).optional(),
  }),
});

/**
 * A provider a person added, as the Host keeps it: at least `name`,
 * `protocol`, `baseUrl`, `apiKeyEnv` (the Host environment variable that holds
 * its key) and `model`. The Host checks the rest.
 */
const CustomProvider = z.record(z.string(), z.unknown());

export const CONFIG_METHODS = {
  'config.get': { primitive: 'query', plane: 'settings', params: hostParams({}), result: ConfigGetResult },
  /** Fails with `conflict` when `ifRevision` is not the saved configuration's revision. */
  'config.update': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ patch: ConfigPatch, ifRevision: z.string().min(1).max(128).optional() }),
    result: SavedConfig,
  },
  /** Reads the saved configuration again after something other than the Host changed it. */
  'config.reload': { primitive: 'command', plane: 'settings', params: hostCommandParams({}), result: SavedConfig },
  'provider.custom.list': { primitive: 'query', plane: 'settings', params: hostParams({}), result: hostList(CustomProvider) },
  /** Adds a provider, or replaces the one of the same `name`. Fails with `invalid_params` when the Host cannot use it. */
  'provider.custom.upsert': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ provider: CustomProvider }),
    result: hostResult({ provider: CustomProvider }),
  },
  /** Answers the same whether or not the provider was there, so it is safe to send again. */
  'provider.custom.remove': {
    primitive: 'command', plane: 'settings', params: hostCommandParams({ name: Name }), result: hostResult({}),
  },
  /**
   * Asks the provider which of `efforts` a model accepts, by sending one small
   * request for each, and remembers the answers for the model picker. Costs a
   * request per effort.
   */
  'provider.reasoning.probe': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ provider: Name, model: Name.optional(), efforts: z.array(Name).min(1).max(16), leases: CredentialLeases.optional() }),
    restricted: { leases: 'trusted' },
    result: hostList(z.object({
      effort: z.string(),
      /** `accepted`, `rejected` or `error`. */
      status: z.string(),
      error: z.string().optional(),
    })),
  },
  /** Forgets what probing learned, for one model, one provider, or all of them. */
  'provider.reasoning.forget': {
    primitive: 'command',
    plane: 'settings',
    params: hostCommandParams({ provider: Name.optional(), model: Name.optional() }),
    result: hostResult({}),
  },
} as const satisfies HostMethodRegistry;
