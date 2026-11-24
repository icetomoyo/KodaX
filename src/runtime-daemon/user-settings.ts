/**
 * What a person reaching the Host over the network may change in their own
 * settings. The platform locks items with `server.userLocks` in host.json; a
 * few things are refused whatever it locks, because they would let the person
 * act with the Host's own authority rather than theirs.
 */
import { HostProtocolError } from '../host-protocol/codec.js';

/** What a platform may lock. `mcpStdio` is not written: it holds when the tool limit leaves out `bash`. */
export const HOST_USER_LOCKS = ['mcp', 'extensions', 'providers', 'permissions', 'fullAccess'] as const;
export type HostUserLock = typeof HOST_USER_LOCKS[number] | 'mcpStdio';

/** The lock that guards each whole method. */
const METHOD_LOCKS: Readonly<Record<string, HostUserLock>> = {
  'provider.custom.list': 'providers',
  'provider.custom.upsert': 'providers',
  'provider.custom.remove': 'providers',
  'provider.reasoning.probe': 'providers',
  'provider.reasoning.forget': 'providers',
  'provider.key.get': 'providers',
  'provider.key.set': 'providers',
  'provider.key.remove': 'providers',
  'mcp.server.upsert': 'mcp',
  'mcp.server.remove': 'mcp',
  'mcp.server.reload': 'mcp',
  'extension.reload': 'extensions',
};

/** Configuration fields that choose providers and models. */
const PROVIDER_FIELDS = [
  'provider', 'model', 'providerModels', 'fallbackProviders', 'fastProvider', 'fastModel', 'deepProvider', 'deepModel',
] as const;

const REDACTED = '[redacted]';

export interface UserSettingsContext {
  readonly locks: ReadonlySet<string>;
  /** The Host's environment, to tell a variable the person may name from one the platform set. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Why a `user` connection may not make this call, or `undefined`. Other roles are not checked here. */
export function userSettingsRefusal(
  method: string,
  params: Readonly<Record<string, unknown>>,
  context: UserSettingsContext,
): HostProtocolError | undefined {
  const lock = Object.hasOwn(METHOD_LOCKS, method) ? METHOD_LOCKS[method] : undefined;
  if (lock !== undefined && context.locks.has(lock)) return locked(lock);
  switch (method) {
    case 'config.update': return configRefusal(record(params.patch), context.locks);
    case 'session.settings.update': return fullAccessRefusal(record(params.patch), context.locks);
    case 'interaction.respond':
      return record(record(params.response).decision).type === 'allow_always' && context.locks.has('permissions') ? locked('permissions') : undefined;
    case 'provider.custom.upsert': return providerRefusal(record(params.provider), context.environment);
    case 'mcp.server.upsert': return mcpRefusal(record(params.config), context.locks);
    default: return undefined;
  }
}

/** An MCP server's configuration as a `user` connection reads it: the values of `env` and `headers` hidden. */
export function redactUserMcpConfig(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const redacted: Record<string, unknown> = { ...config };
  for (const field of ['env', 'headers'] as const) {
    const values = config[field];
    if (values !== null && typeof values === 'object') {
      redacted[field] = Object.fromEntries(Object.keys(values).map(name => [name, REDACTED]));
    }
  }
  return redacted;
}

function configRefusal(patch: Readonly<Record<string, unknown>>, locks: ReadonlySet<string>): HostProtocolError | undefined {
  // Both name a place on the Host: a module it loads, a directory it writes.
  if (Object.hasOwn(patch, 'extensions') || Object.hasOwn(record(patch.repoIntelligence), 'storageDir')) {
    return new HostProtocolError('forbidden', 'Only the Host owner may set paths on the Host.', { reason: 'host_path' });
  }
  if (locks.has('providers') && PROVIDER_FIELDS.some(field => Object.hasOwn(patch, field))) return locked('providers');
  if (locks.has('permissions') && Object.hasOwn(patch, 'permissionMode')) return locked('permissions');
  return fullAccessRefusal(patch, locks);
}

function fullAccessRefusal(patch: Readonly<Record<string, unknown>>, locks: ReadonlySet<string>): HostProtocolError | undefined {
  return patch.permissionMode === 'full-access' && locks.has('fullAccess') ? locked('fullAccess') : undefined;
}

/**
 * A provider sends its key to the `baseUrl` it names. Naming a variable the
 * Host's environment holds would send the platform's secret there, and `cloud`
 * would sign with the Host's own cloud identity.
 */
function providerRefusal(
  provider: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string | undefined>>,
): HostProtocolError | undefined {
  const variable = provider.apiKeyEnv;
  const hostHolds = typeof variable === 'string' && (environment[variable]?.trim() ?? '') !== '';
  if (!hostHolds && provider.cloud === undefined) return undefined;
  return new HostProtocolError('forbidden',
    "A provider you add cannot use the Host's keys: name a variable the Host does not set, and leave out cloud.",
    { reason: 'host_environment' });
}

function mcpRefusal(config: Readonly<Record<string, unknown>>, locks: ReadonlySet<string>): HostProtocolError | undefined {
  // Starting a stdio server runs its command on the Host.
  if (locks.has('mcpStdio') && (config.type === undefined || config.type === 'stdio')) {
    return new HostProtocolError('forbidden', 'This Host may not run commands, so it cannot start a stdio MCP server.', {
      reason: 'tool_ceiling',
    });
  }
  for (const field of ['env', 'headers'] as const) {
    if (Object.values(record(config[field])).includes(REDACTED)) {
      return new HostProtocolError('invalid_params', `${field} holds a value read back redacted; send the real value.`, {
        reason: 'redacted_value',
      });
    }
  }
  return undefined;
}

function locked(lock: HostUserLock): HostProtocolError {
  return new HostProtocolError('forbidden', `The platform has locked ${lock} on this Host.`, { reason: 'locked' });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
