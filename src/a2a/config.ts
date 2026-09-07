import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  resolveIntegrationConfigPath,
  writeIntegrationDocument,
  type IntegrationConfigSnapshot,
} from '@kodax-ai/repl';

import {
  assertOAuthScopeToken,
  parseOAuthEndpointUrl,
  parseOAuthIssuerIdentifier,
  parseOAuthResourceIdentifier,
} from './security.js';

export type A2AOutboundEffect = 'none' | 'read' | 'write' | 'unknown';

export interface A2AOAuth2ClientCredentialsConfig {
  readonly type: 'oauth2-client-credentials';
  readonly scheme: string;
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecretEnv: string;
  readonly scopes: readonly string[];
  readonly resource?: string;
  readonly clientAuthentication: 'client-secret-basic' | 'client-secret-post';
}

export interface A2AOutboundNetworkConfig {
  readonly allowPrivateAddresses: boolean;
  readonly allowInsecureHttp: boolean;
}

export interface A2AOutboundAgentConfig {
  readonly cardUrl: string;
  readonly enabled: boolean;
  readonly credentialEnv?: string;
  readonly authentication?: A2AOAuth2ClientCredentialsConfig;
  readonly network?: A2AOutboundNetworkConfig;
  readonly effect: A2AOutboundEffect;
}

/** Backward-compatible public mutation input; omitted `enabled` means active. */
export type A2AOutboundAgentInput = Omit<A2AOutboundAgentConfig, 'enabled'> & {
  readonly enabled?: boolean;
};

export type A2AWorkspaceConfig =
  | { readonly mode: 'managed' }
  | { readonly mode: 'fixed'; readonly root: string };

export interface A2AToolPolicyConfig {
  readonly workspace: 'none' | 'read' | 'write';
  readonly process: 'deny' | 'isolated';
  readonly network:
    | { readonly mode: 'deny' }
    | { readonly mode: 'allowlist'; readonly origins: readonly string[] };
  readonly tools: readonly string[];
  readonly mcp: Readonly<Record<string, readonly string[]>>;
  readonly skillScripts: Readonly<Record<string, readonly string[]>>;
  readonly subagents: 'deny' | 'inherit';
  /** Exact names of materialized host tools (capability ids host:<leaseId>:<toolName>) admitted by this policy. */
  readonly hostTools?: readonly string[];
}

export interface A2AUserMarkdownAgentConfigRef {
  readonly source: 'markdown:user';
  readonly name: string;
}

interface A2AExecutionBase {
  readonly profileId?: string;
  readonly workspace: A2AWorkspaceConfig;
  readonly toolPolicy: A2AToolPolicyConfig;
}

export type A2AServerExecutionConfig =
  | (A2AExecutionBase & { readonly kind: 'runtime-default' })
  | (A2AExecutionBase & {
      readonly kind: 'local-agent';
      readonly agentRef: A2AUserMarkdownAgentConfigRef;
    });

export interface A2APublishedSkillConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface A2APublishedAgentConfig {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly skills: readonly A2APublishedSkillConfig[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
}

export interface A2ABearerAuthenticationConfig {
  readonly type: 'bearer-env';
  readonly tokenEnv: string;
  readonly principalId: string;
}

export interface A2AOAuth2JwtAuthenticationConfig {
  readonly type: 'oauth2-jwt';
  readonly scheme: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  readonly tokenUrl: string;
  readonly metadataUrl?: string;
  readonly requiredScopes: readonly string[];
}

export type A2AServerAuthenticationConfig =
  | A2ABearerAuthenticationConfig
  | A2AOAuth2JwtAuthenticationConfig;

export interface A2AServerLimitsConfig {
  readonly maxRequestBytes: number;
  readonly maxPartBytes: number;
  readonly maxConcurrentTasks: number;
  readonly maxTaskWaitMs: number;
  readonly maxActiveTasksPerPrincipal: number;
  readonly maxRetainedTasksPerPrincipal: number;
  readonly maxEventsPerTask: number;
  readonly maxEventBytesPerTask: number;
  readonly maxWorkspaceBytesPerContext: number;
}

export interface A2AServerListenConfig {
  readonly hostname: string;
  readonly port: number;
}

export interface A2AServerConfig {
  readonly execution: A2AServerExecutionConfig;
  readonly published: A2APublishedAgentConfig;
  readonly publicBaseUrl?: string;
  /**
   * FEATURE_298 T21 — bootstrap-only Host-owned serving address. Present
   * means the Runtime daemon Host serves A2A itself; changing it requires an
   * explicit Host restart.
   */
  readonly listen?: A2AServerListenConfig;
  readonly authentication: A2AServerAuthenticationConfig;
  readonly limits: A2AServerLimitsConfig;
  readonly dataDir: string;
}

export interface A2AIntegrationDocument {
  readonly version: 2;
  readonly agents: Readonly<Record<string, A2AOutboundAgentConfig>>;
  readonly server?: A2AServerConfig;
}

export interface A2AIntegrationMigrationResult {
  readonly migrated: boolean;
  readonly snapshot: IntegrationConfigSnapshot<A2AIntegrationDocument>;
}

export interface A2AIntegrationInspection {
  readonly sourceVersion: 1 | 2;
  readonly snapshot: IntegrationConfigSnapshot<A2AIntegrationDocument>;
}

export interface A2AServerConfigChange {
  readonly kind: 'none' | 'hot' | 'restart-required';
  readonly fields: readonly string[];
}

const LIMIT_DEFAULTS: A2AServerLimitsConfig = {
  maxRequestBytes: 33_554_432,
  maxPartBytes: 16_777_216,
  maxConcurrentTasks: 4,
  maxTaskWaitMs: 30_000,
  maxActiveTasksPerPrincipal: 4,
  maxRetainedTasksPerPrincipal: 100,
  maxEventsPerTask: 1_000,
  maxEventBytesPerTask: 16_777_216,
  maxWorkspaceBytesPerContext: 1_073_741_824,
};

const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS) as readonly (keyof A2AServerLimitsConfig)[];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isExactLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function noUnknown(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${label} has unknown field "${unknown}".`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings.`);
  }
  const items = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates.`);
  return items;
}

function exactNames(value: unknown, label: string, allowEmpty = true): string[] {
  const items = stringList(value, label, allowEmpty);
  if (items.some((item) => item.includes('*'))) {
    throw new Error(`${label} does not accept wildcard authority.`);
  }
  return items;
}

function hostToolNames(value: unknown, label: string): string[] {
  return exactNames(value, label).map((name) => {
    if (!HOST_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(`${label} entries must be valid host tool names.`);
    }
    return name;
  });
}

function namedExactLists(value: unknown, label: string): Record<string, readonly string[]> {
  const source = record(value, label);
  const result: Record<string, readonly string[]> = {};
  for (const [name, rawItems] of Object.entries(source)) {
    if (!NAME_PATTERN.test(name) || name.includes('*')) {
      throw new Error(`${label} keys must be exact names without wildcards.`);
    }
    result[name] = exactNames(rawItems, `${label}.${name}`, false);
  }
  return result;
}

function parseSchemeName(value: unknown, label: string): string {
  const name = text(value, label);
  if (!NAME_PATTERN.test(name)) throw new Error(`${label} is invalid.`);
  return name;
}

function parseIssuer(value: unknown, label: string): string {
  return parseOAuthIssuerIdentifier(value, label);
}

function oauthScopeList(value: unknown, label: string): string[] {
  const scopes = stringList(value, label, true);
  for (const scope of scopes) assertOAuthScopeToken(scope, label);
  return scopes;
}

function parseResource(value: unknown, label: string): string {
  return parseOAuthResourceIdentifier(value, label);
}

function parseOAuthEndpoint(value: unknown, label: string): string {
  return parseOAuthEndpointUrl(value, label).href;
}

function parseOutboundAuthentication(
  value: unknown,
  label: string,
): A2AOAuth2ClientCredentialsConfig {
  const source = record(value, label);
  noUnknown(source, [
    'type', 'scheme', 'issuer', 'tokenUrl', 'clientId', 'clientSecretEnv',
    'scopes', 'resource', 'clientAuthentication',
  ], label);
  if (source.type !== 'oauth2-client-credentials') {
    throw new Error(`${label}.type must be oauth2-client-credentials.`);
  }
  const clientAuthentication = source.clientAuthentication ?? 'client-secret-basic';
  if (!['client-secret-basic', 'client-secret-post'].includes(String(clientAuthentication))) {
    throw new Error(`${label}.clientAuthentication is invalid.`);
  }
  return {
    type: 'oauth2-client-credentials',
    scheme: parseSchemeName(source.scheme, `${label}.scheme`),
    issuer: parseIssuer(source.issuer, `${label}.issuer`),
    tokenUrl: parseOAuthEndpoint(source.tokenUrl, `${label}.tokenUrl`),
    clientId: text(source.clientId, `${label}.clientId`),
    clientSecretEnv: parseEnvironmentName(source.clientSecretEnv, `${label}.clientSecretEnv`),
    scopes: oauthScopeList(source.scopes, `${label}.scopes`),
    ...(source.resource === undefined ? {} : { resource: parseResource(source.resource, `${label}.resource`) }),
    clientAuthentication: clientAuthentication as A2AOAuth2ClientCredentialsConfig['clientAuthentication'],
  };
}

function parseOutboundAgent(
  value: unknown,
  label: string,
  version: 1 | 2,
): A2AOutboundAgentConfig {
  const source = record(value, label);
  noUnknown(
    source,
    version === 1
      ? ['cardUrl', 'credentialEnv', 'effect']
      : ['cardUrl', 'enabled', 'credentialEnv', 'authentication', 'network', 'effect'],
    label,
  );
  const network = source.network === undefined
    ? undefined
    : parseOutboundNetwork(source.network, `${label}.network`);
  const cardUrl = parseHttpUrl(
    source.cardUrl,
    `${label}.cardUrl`,
    network?.allowInsecureHttp === true,
  );
  const effect = source.effect;
  if (!['none', 'read', 'write', 'unknown'].includes(String(effect))) {
    throw new Error(`${label}.effect is invalid.`);
  }
  const credentialEnv = source.credentialEnv === undefined
    ? undefined
    : parseEnvironmentName(source.credentialEnv, `${label}.credentialEnv`);
  if (credentialEnv && source.authentication !== undefined) {
    throw new Error(`${label}.credentialEnv and ${label}.authentication are mutually exclusive.`);
  }
  if (source.enabled !== undefined && typeof source.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean.`);
  }
  return {
    cardUrl,
    enabled: source.enabled ?? true,
    ...(credentialEnv ? { credentialEnv } : {}),
    ...(source.authentication === undefined
      ? {} : { authentication: parseOutboundAuthentication(source.authentication, `${label}.authentication`) }),
    ...(network === undefined ? {} : { network }),
    effect: effect as A2AOutboundEffect,
  };
}

function parseOutboundNetwork(
  value: unknown,
  label: string,
): A2AOutboundNetworkConfig {
  const source = record(value, label);
  noUnknown(source, ['allowPrivateAddresses', 'allowInsecureHttp'], label);
  if (typeof source.allowPrivateAddresses !== 'boolean') {
    throw new Error(`${label}.allowPrivateAddresses must be a boolean.`);
  }
  if (typeof source.allowInsecureHttp !== 'boolean') {
    throw new Error(`${label}.allowInsecureHttp must be a boolean.`);
  }
  return {
    allowPrivateAddresses: source.allowPrivateAddresses,
    allowInsecureHttp: source.allowInsecureHttp,
  };
}

function parseHttpUrl(value: unknown, label: string, allowInsecureHttp: boolean): string {
  const raw = text(value, label);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error: unknown) {
    throw new Error(`${label} must be an absolute HTTP URL.`, { cause: error });
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  if (parsed.hash) throw new Error(`${label} must not contain a fragment.`);
  const loopback = isExactLoopback(parsed.hostname);
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && (loopback || allowInsecureHttp))) {
    throw new Error(`${label} must use HTTPS, exact loopback HTTP, or explicitly authorized plaintext HTTP.`);
  }
  return parsed.toString();
}

function parseEnvironmentName(value: unknown, label: string): string {
  const name = text(value, label);
  if (!ENV_PATTERN.test(name)) throw new Error(`${label} must be an environment variable name.`);
  return name;
}

function parseWorkspace(value: unknown): A2AWorkspaceConfig {
  if (value === undefined) return { mode: 'managed' };
  const source = record(value, 'A2A server execution.workspace');
  if (source.mode === 'managed') {
    noUnknown(source, ['mode'], 'A2A server execution.workspace');
    return { mode: 'managed' };
  }
  if (source.mode !== 'fixed') throw new Error('A2A server execution.workspace.mode is invalid.');
  noUnknown(source, ['mode', 'root'], 'A2A server execution.workspace');
  const root = text(source.root, 'A2A server execution.workspace.root');
  if (!path.isAbsolute(root)) throw new Error('Fixed A2A workspace root must be absolute.');
  return { mode: 'fixed', root: path.resolve(root) };
}

function defaultToolPolicy(workspace: A2AWorkspaceConfig): A2AToolPolicyConfig {
  return {
    workspace: workspace.mode === 'managed' ? 'write' : 'read',
    process: 'deny',
    network: { mode: 'deny' },
    tools: [],
    mcp: {},
    skillScripts: {},
    subagents: 'deny',
  };
}

function parseNetworkPolicy(value: unknown): A2AToolPolicyConfig['network'] {
  const source = record(value, 'A2A toolPolicy.network');
  if (source.mode === 'deny') {
    noUnknown(source, ['mode'], 'A2A toolPolicy.network');
    return { mode: 'deny' };
  }
  if (source.mode !== 'allowlist') throw new Error('A2A toolPolicy.network.mode is invalid.');
  noUnknown(source, ['mode', 'origins'], 'A2A toolPolicy.network');
  const origins = stringList(source.origins, 'A2A toolPolicy.network.origins').map((origin) => {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch (error: unknown) { throw new Error('A2A toolPolicy network origins must be absolute HTTP origins.', { cause: error }); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
      throw new Error('A2A toolPolicy network origins must be absolute HTTP origins.');
    }
    return parsed.origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error('A2A toolPolicy.network.origins contains duplicates after normalization.');
  }
  return { mode: 'allowlist', origins };
}

function parseSkillScripts(value: unknown): Record<string, readonly string[]> {
  const scripts = namedExactLists(value, 'A2A toolPolicy.skillScripts');
  for (const [skill, entries] of Object.entries(scripts)) {
    scripts[skill] = entries.map((entry) => {
      if (entry.includes('\\') || path.posix.isAbsolute(entry)) {
        throw new Error('A2A skillScripts paths must use relative POSIX scripts/... paths.');
      }
      const normalized = path.posix.normalize(entry);
      if (!normalized.startsWith('scripts/') || normalized.includes('../')) {
        throw new Error('A2A skillScripts paths must remain below the Skill scripts directory.');
      }
      return normalized;
    });
  }
  return scripts;
}

function parseToolPolicy(value: unknown, workspace: A2AWorkspaceConfig): A2AToolPolicyConfig {
  if (value === undefined) return defaultToolPolicy(workspace);
  const source = record(value, 'A2A server execution.toolPolicy');
  const keys = ['workspace', 'process', 'network', 'tools', 'mcp', 'skillScripts', 'subagents'];
  noUnknown(source, [...keys, 'hostTools'], 'A2A server execution.toolPolicy');
  if (keys.some((key) => source[key] === undefined)) {
    throw new Error('A2A server execution.toolPolicy must be a complete object when present.');
  }
  if (!['none', 'read', 'write'].includes(String(source.workspace))) {
    throw new Error('A2A toolPolicy.workspace is invalid.');
  }
  if (!['deny', 'isolated'].includes(String(source.process))) {
    throw new Error('A2A toolPolicy.process is invalid.');
  }
  if (!['deny', 'inherit'].includes(String(source.subagents))) {
    throw new Error('A2A toolPolicy.subagents is invalid.');
  }
  const skillScripts = parseSkillScripts(source.skillScripts);
  const scriptCount = Object.values(skillScripts).reduce((sum, entries) => sum + entries.length, 0);
  if (source.process === 'deny' && scriptCount > 0) {
    throw new Error('A2A toolPolicy process deny requires empty skillScripts.');
  }
  if (source.process === 'isolated' && scriptCount === 0) {
    throw new Error('A2A toolPolicy process isolated requires non-empty skillScripts.');
  }
  return {
    workspace: source.workspace as A2AToolPolicyConfig['workspace'],
    process: source.process as A2AToolPolicyConfig['process'],
    network: parseNetworkPolicy(source.network),
    tools: exactNames(source.tools, 'A2A toolPolicy.tools'),
    mcp: namedExactLists(source.mcp, 'A2A toolPolicy.mcp'),
    skillScripts,
    subagents: source.subagents as A2AToolPolicyConfig['subagents'],
    ...(source.hostTools === undefined
      ? {}
      : { hostTools: hostToolNames(source.hostTools, 'A2A toolPolicy.hostTools') }),
  };
}

function parseExecution(value: unknown): A2AServerExecutionConfig {
  const source = record(value, 'A2A server execution');
  const workspace = parseWorkspace(source.workspace);
  const toolPolicy = parseToolPolicy(source.toolPolicy, workspace);
  const profileId = source.profileId === undefined
    ? undefined
    : text(source.profileId, 'A2A server execution.profileId');
  if (source.kind === 'runtime-default') {
    noUnknown(source, ['kind', 'workspace', 'toolPolicy', 'profileId'], 'A2A server execution');
    return { kind: 'runtime-default', workspace, toolPolicy, ...(profileId ? { profileId } : {}) };
  }
  if (source.kind !== 'local-agent') throw new Error('A2A server execution.kind is invalid.');
  noUnknown(source, ['kind', 'agentRef', 'workspace', 'toolPolicy', 'profileId'], 'A2A server execution');
  const rawRef = record(source.agentRef, 'A2A server execution.agentRef');
  noUnknown(rawRef, ['source', 'name'], 'A2A server execution.agentRef');
  if (rawRef.source !== 'markdown:user') {
    throw new Error('A2A local Agent source must be markdown:user.');
  }
  const name = text(rawRef.name, 'A2A server execution.agentRef.name');
  if (!NAME_PATTERN.test(name)) throw new Error('A2A local Agent name is invalid.');
  return {
    kind: 'local-agent',
    agentRef: { source: 'markdown:user', name },
    workspace,
    toolPolicy,
    ...(profileId ? { profileId } : {}),
  };
}

function parsePublishedSkill(value: unknown, index: number): A2APublishedSkillConfig {
  const label = `A2A server published.skills[${index}]`;
  const source = record(value, label);
  noUnknown(source, ['id', 'name', 'description', 'tags'], label);
  return {
    id: text(source.id, `${label}.id`),
    name: text(source.name, `${label}.name`),
    description: text(source.description, `${label}.description`),
    tags: stringList(source.tags, `${label}.tags`, true),
  };
}

function parsePublished(value: unknown): A2APublishedAgentConfig {
  const source = record(value, 'A2A server published');
  noUnknown(source, ['name', 'description', 'version', 'skills', 'inputModes', 'outputModes'], 'A2A server published');
  if (!Array.isArray(source.skills)) throw new Error('A2A server published.skills must be an array.');
  const skills = source.skills.map(parsePublishedSkill);
  const skillIds = skills.map((skill) => skill.id);
  if (new Set(skillIds).size !== skillIds.length) throw new Error('A2A published Skill ids must be unique.');
  return {
    name: text(source.name, 'A2A server published.name'),
    description: text(source.description, 'A2A server published.description'),
    version: text(source.version, 'A2A server published.version'),
    skills,
    inputModes: stringList(source.inputModes, 'A2A server published.inputModes'),
    outputModes: stringList(source.outputModes, 'A2A server published.outputModes'),
  };
}

function parseAuthentication(value: unknown, version: 1 | 2): A2AServerAuthenticationConfig {
  const source = record(value, 'A2A server authentication');
  if (source.type === 'bearer-env') {
    noUnknown(source, ['type', 'tokenEnv', 'principalId'], 'A2A server authentication');
    return {
      type: 'bearer-env',
      tokenEnv: parseEnvironmentName(source.tokenEnv, 'A2A server authentication.tokenEnv'),
      principalId: text(source.principalId, 'A2A server authentication.principalId'),
    };
  }
  if (version === 1) {
    throw new Error('A2A oauth2-jwt authentication requires integration config version 2.');
  }
  if (source.type !== 'oauth2-jwt') {
    throw new Error('A2A authentication type must be bearer-env or oauth2-jwt.');
  }
  noUnknown(source, [
    'type', 'scheme', 'issuer', 'audience', 'jwksUrl', 'tokenUrl',
    'metadataUrl', 'requiredScopes',
  ], 'A2A server authentication');
  return {
    type: 'oauth2-jwt',
    scheme: parseSchemeName(source.scheme, 'A2A server authentication.scheme'),
    issuer: parseIssuer(source.issuer, 'A2A server authentication.issuer'),
    audience: text(source.audience, 'A2A server authentication.audience'),
    jwksUrl: parseOAuthEndpoint(source.jwksUrl, 'A2A server authentication.jwksUrl'),
    tokenUrl: parseOAuthEndpoint(source.tokenUrl, 'A2A server authentication.tokenUrl'),
    ...(source.metadataUrl === undefined
      ? {} : { metadataUrl: parseOAuthEndpoint(source.metadataUrl, 'A2A server authentication.metadataUrl') }),
    requiredScopes: oauthScopeList(source.requiredScopes, 'A2A server authentication.requiredScopes'),
  };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function parseLimits(value: unknown, execution: A2AServerExecutionConfig): A2AServerLimitsConfig {
  const source = value === undefined ? {} : record(value, 'A2A server limits');
  noUnknown(source, LIMIT_KEYS, 'A2A server limits');
  const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [
    key,
    source[key] === undefined ? LIMIT_DEFAULTS[key] : positiveInteger(source[key], `A2A server limits.${key}`),
  ])) as unknown as A2AServerLimitsConfig;
  if (limits.maxPartBytes > limits.maxRequestBytes) {
    throw new Error('A2A server limits.maxPartBytes must not exceed maxRequestBytes.');
  }
  const fixedWrite = execution.workspace.mode === 'fixed' && execution.toolPolicy.workspace === 'write';
  if (fixedWrite && source.maxConcurrentTasks === undefined) {
    return { ...limits, maxConcurrentTasks: 1 };
  }
  if (fixedWrite && limits.maxConcurrentTasks !== 1) {
    throw new Error('A2A fixed writable workspace requires maxConcurrentTasks 1.');
  }
  return limits;
}

function parseListen(value: unknown): A2AServerListenConfig {
  const source = record(value, 'A2A server.listen');
  noUnknown(source, ['hostname', 'port'], 'A2A server.listen');
  const hostname = text(source.hostname, 'A2A server.listen.hostname');
  if (!isExactLoopback(hostname)) {
    throw new Error('A2A server.listen.hostname must be a loopback address.');
  }
  const port = positiveInteger(source.port, 'A2A server.listen.port');
  if (port > 65_535) throw new Error('A2A server.listen.port must be at most 65535.');
  return { hostname, port };
}

function parseServer(value: unknown, version: 1 | 2): A2AServerConfig {
  const source = record(value, 'A2A server');
  noUnknown(source, ['execution', 'published', 'publicBaseUrl', 'listen', 'authentication', 'limits', 'dataDir'], 'A2A server');
  const execution = parseExecution(source.execution);
  const publicBaseUrl = source.publicBaseUrl === undefined
    ? undefined
    : parseHttpUrl(source.publicBaseUrl, 'A2A server.publicBaseUrl', true);
  const listen = source.listen === undefined ? undefined : parseListen(source.listen);
  return {
    execution,
    published: parsePublished(source.published),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(listen ? { listen } : {}),
    authentication: parseAuthentication(source.authentication, version),
    limits: parseLimits(source.limits, execution),
    dataDir: text(source.dataDir, 'A2A server.dataDir'),
  };
}

export function parseA2AIntegrationDocument(value: unknown): A2AIntegrationDocument {
  const source = record(value, 'A2A integration config');
  noUnknown(source, ['version', 'agents', 'server'], 'A2A integration config');
  if (source.version !== 1 && source.version !== 2) {
    throw new Error('A2A integration config version must be 1 or 2.');
  }
  const version = source.version;
  const rawAgents = record(source.agents, 'A2A integration config agents');
  const agents: Record<string, A2AOutboundAgentConfig> = {};
  for (const [name, agent] of Object.entries(rawAgents)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`A2A outbound Agent name "${name}" is invalid.`);
    agents[name] = parseOutboundAgent(agent, `A2A outbound Agent "${name}"`, version);
  }
  return {
    version: 2,
    agents,
    ...(source.server === undefined ? {} : { server: parseServer(source.server, version) }),
  };
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface LoadedA2AIntegration {
  readonly snapshot: IntegrationConfigSnapshot<A2AIntegrationDocument>;
  readonly sourceVersion: 1 | 2;
  readonly nonEmptyLegacy: boolean;
}

function loadA2AIntegration(
  configHome: string,
): LoadedA2AIntegration {
  const file = resolveIntegrationConfigPath('a2a', configHome);
  const present = existsSync(file);
  const raw = present ? readFileSync(file, 'utf8') : JSON.stringify({ version: 2, agents: {} });
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error('Invalid A2A integration JSON.', { cause: error });
  }
  const document = parseA2AIntegrationDocument(value);
  const rawDocument = record(value, 'A2A integration config');
  if (rawDocument.version !== 1 && rawDocument.version !== 2) {
    throw new Error('A2A integration config version must be 1 or 2.');
  }
  const sourceVersion = rawDocument.version;
  const snapshot = {
    domain: 'a2a',
    source: present ? 'user' : 'default',
    path: file,
    revision: hash(raw),
    document,
    loadedAt: new Date().toISOString(),
  } as const;
  return {
    snapshot,
    sourceVersion,
    nonEmptyLegacy: sourceVersion === 1
      && (Object.keys(document.agents).length > 0 || document.server !== undefined),
  };
}

export function readA2AIntegration(
  configHome: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  return loadA2AIntegration(configHome).snapshot;
}

export function inspectA2AIntegration(
  configHome: string,
): A2AIntegrationInspection {
  const loaded = loadA2AIntegration(configHome);
  return { sourceVersion: loaded.sourceVersion, snapshot: loaded.snapshot };
}

function assertOrdinaryA2AMutationAllowed(loaded: LoadedA2AIntegration): void {
  if (!loaded.nonEmptyLegacy) return;
  throw new Error(
    'A2A integration config version 1 contains active declarations and requires explicit migration. '
      + 'Stop every daemon that uses this config home, then run '
      + '`kodax a2a migrate --confirm-daemons-stopped` before changing it.',
  );
}

function writeA2AIntegration(
  configHome: string,
  document: A2AIntegrationDocument,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  return writeIntegrationDocument({
    domain: 'a2a',
    configHome,
    document,
    validate: parseA2AIntegrationDocument,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
}

export function upsertA2AOutboundAgent(
  configHome: string,
  name: string,
  agent: A2AOutboundAgentInput,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  if (!NAME_PATTERN.test(name)) throw new Error('A2A outbound Agent name is invalid.');
  const loaded = loadA2AIntegration(configHome);
  assertOrdinaryA2AMutationAllowed(loaded);
  const current = loaded.snapshot;
  const normalized = parseOutboundAgent(agent, `A2A outbound Agent "${name}"`, 2);
  return writeA2AIntegration(configHome, {
    ...current.document,
    agents: { ...current.document.agents, [name]: normalized },
  }, expectedRevision ?? (current.source === 'user' ? current.revision : undefined));
}

export function removeA2AOutboundAgent(
  configHome: string,
  name: string,
  expectedRevision?: string,
): boolean {
  const loaded = loadA2AIntegration(configHome);
  assertOrdinaryA2AMutationAllowed(loaded);
  const current = loaded.snapshot;
  if (current.document.agents[name] === undefined) return false;
  const agents = { ...current.document.agents };
  delete agents[name];
  writeA2AIntegration(
    configHome,
    { ...current.document, agents },
    expectedRevision ?? (current.source === 'user' ? current.revision : undefined),
  );
  return true;
}

export function setA2AOutboundAgentEnabled(
  configHome: string,
  name: string,
  enabled: boolean,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  const loaded = loadA2AIntegration(configHome);
  assertOrdinaryA2AMutationAllowed(loaded);
  const current = loaded.snapshot;
  const agent = current.document.agents[name];
  if (!agent) throw new Error(`Unknown configured A2A Agent: ${name}.`);
  return writeA2AIntegration(configHome, {
    ...current.document,
    agents: { ...current.document.agents, [name]: { ...agent, enabled } },
  }, expectedRevision ?? (current.source === 'user' ? current.revision : undefined));
}

export function setA2AServerConfig(
  configHome: string,
  server: A2AServerConfig | undefined,
  expectedRevision?: string,
): IntegrationConfigSnapshot<A2AIntegrationDocument> {
  const loaded = loadA2AIntegration(configHome);
  assertOrdinaryA2AMutationAllowed(loaded);
  const current = loaded.snapshot;
  const document: A2AIntegrationDocument = server === undefined
    ? { version: 2, agents: current.document.agents }
    : { ...current.document, server };
  return writeA2AIntegration(
    configHome,
    document,
    expectedRevision ?? (current.source === 'user' ? current.revision : undefined),
  );
}

export function migrateA2AIntegrationV1(
  configHome: string,
  expectedRevision?: string,
): A2AIntegrationMigrationResult {
  const loaded = loadA2AIntegration(configHome);
  if (loaded.sourceVersion === 2) {
    return { migrated: false, snapshot: loaded.snapshot };
  }
  return {
    migrated: true,
    snapshot: writeA2AIntegration(
      configHome,
      loaded.snapshot.document,
      expectedRevision ?? loaded.snapshot.revision,
    ),
  };
}

export function classifyA2AServerChange(
  current: A2AServerConfig | undefined,
  next: A2AServerConfig | undefined,
): A2AServerConfigChange {
  if (isDeepStrictEqual(current, next)) return { kind: 'none', fields: [] };
  if (current === undefined || next === undefined) {
    return { kind: 'restart-required', fields: ['server'] };
  }
  const restartFields = ['execution', 'dataDir', 'listen'].filter((field) => (
    !isDeepStrictEqual(current[field as 'execution' | 'dataDir' | 'listen'], next[field as 'execution' | 'dataDir' | 'listen'])
  ));
  const hotFields = ['published', 'publicBaseUrl', 'authentication', 'limits'].filter((field) => (
    !isDeepStrictEqual(
      current[field as 'published' | 'publicBaseUrl' | 'authentication' | 'limits'],
      next[field as 'published' | 'publicBaseUrl' | 'authentication' | 'limits'],
    )
  ));
  return restartFields.length > 0
    ? { kind: 'restart-required', fields: [...restartFields, ...hotFields] }
    : { kind: 'hot', fields: hotFields };
}
