import { credentialConnectionFingerprint } from '../credential-connection.js';
import { createHash } from 'node:crypto';
import type { KodaXCustomProviderConfig, KodaXGoogleCacheConnection, KodaXGoogleCacheReference,
  KodaXGoogleCacheExpiration, KodaXGoogleCacheRequest, KodaXToolDefinition } from '../types.js';
import { validateCloudProviderConfig } from './provider-config.js';
import { requireCloudCredential, cloudCredentialScope } from '../providers/cloud-auth.js';
import { withProviderRequestCredential } from '../provider-credential-context.js';
import { operationJson, operationUrl, object } from '../operations/request.js';
import { projectGoogleMessages } from '../providers/google-messages.js';
import { projectGoogleTools } from '../providers/google-tools.js';
import { resolvePromptCacheDisabled } from '../run-scoped-config.js';

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function createGoogleCacheConnection(config: KodaXCustomProviderConfig, accountScope: string): KodaXGoogleCacheConnection {
  validateCloudProviderConfig(config);
  if (!config.cloud || !['gemini', 'vertex'].includes(config.cloud.service)) throw new Error('CachedContent requires a native Google connection.');
  const descriptor = config.models?.find(entry => typeof entry !== 'string' && entry.id === config.model);
  const model = typeof descriptor === 'object' ? descriptor : undefined;
  const result: KodaXGoogleCacheConnection = { name: config.name, baseUrl: config.baseUrl, accountScope,
    model: typeof descriptor === 'object' ? descriptor.wireModel ?? config.model : config.model, cloud: config.cloud as KodaXGoogleCacheConnection['cloud'],
    imageInput: config.imageInput ?? config.capabilityProfile?.multimodalSupport === 'image-input', toolCapabilities: structuredClone(model?.toolCapabilities ?? config.toolCapabilities) };
  cacheScope(result); return result;
}
function root(connection: KodaXGoogleCacheConnection): string {
  const url = operationUrl(connection, '');
  if (connection.cloud.service === 'gemini') return url;
  const { project, location } = connection.cloud;
  if (!project || !location || !url.endsWith(`/projects/${project}/locations/${location}/publishers/google`)) throw new Error('Vertex cache resources require an explicit matching project/location root.');
  return url.slice(0, -'/publishers/google'.length);
}
export function cacheScope(connection: KodaXGoogleCacheConnection): string {
  if (typeof connection.accountScope !== 'string' || !connection.accountScope.trim()) throw new Error('Cache operations require a trusted account scope.');
  return hash([connection.name, connection.model, root(connection), connection.cloud, connection.accountScope]);
}
function resourcePrefix(connection: KodaXGoogleCacheConnection): string {
  return connection.cloud.service === 'gemini' ? 'cachedContents/' : `projects/${connection.cloud.project}/locations/${connection.cloud.location}/cachedContents/`;
}
function resourceId(connection: KodaXGoogleCacheConnection, name: unknown): string {
  const prefix = resourcePrefix(connection);
  if (typeof name !== 'string' || !name.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,200}$/.test(name.slice(prefix.length))) throw new Error('Invalid or foreign cache resource name.');
  return name.slice(prefix.length);
}
function wireModel(connection: KodaXGoogleCacheConnection): string {
  return connection.cloud.service === 'gemini' ? `models/${connection.model}`
    : `projects/${connection.cloud.project}/locations/${connection.cloud.location}/publishers/google/models/${connection.model}`;
}
function reference(connection: KodaXGoogleCacheConnection, body: Record<string, unknown>, context?: KodaXGoogleCacheReference): KodaXGoogleCacheReference {
  resourceId(connection, body.name);
  if (body.model !== wireModel(connection) || typeof body.expireTime !== 'string' || !Number.isFinite(Date.parse(body.expireTime))) throw new Error('Invalid cache model or expiration.');
  if (context && body.name !== context.name) throw new Error('Cache response changed resource identity.');
  return { version: 1, name: body.name as string, scope: cacheScope(connection), model: connection.model, expiresAt: Date.parse(body.expireTime),
    ...(context?.systemHash ? { systemHash: context.systemHash } : {}), ...(context?.toolsHash ? { toolsHash: context.toolsHash } : {}),
    ...(context?.forcedToolName ? { forcedToolName: context.forcedToolName } : {}) };
}
function validateReference(connection: KodaXGoogleCacheConnection, ref: KodaXGoogleCacheReference): void {
  resourceId(connection, ref?.name);
  if (ref.version !== 1 || ref.scope !== cacheScope(connection) || ref.model !== connection.model || !Number.isFinite(ref.expiresAt)) throw new Error('Cache reference does not match connection/account scope.');
}
function expiration(request: KodaXGoogleCacheExpiration): Record<string, string> {
  if (request.ttlSeconds !== undefined && request.expireTime !== undefined) throw new Error('Cache ttl and expireTime are mutually exclusive.');
  if (request.ttlSeconds !== undefined) {
    if (!Number.isSafeInteger(request.ttlSeconds) || request.ttlSeconds <= 0) throw new Error('Cache TTL must be positive seconds.');
    return { ttl: `${request.ttlSeconds}s` };
  }
  if (request.expireTime !== undefined) {
    if (!Number.isFinite(Date.parse(request.expireTime)) || Date.parse(request.expireTime) <= Date.now()) throw new Error('Cache expiration must be a future timestamp.');
    return { expireTime: request.expireTime };
  }
  return {};
}
function run<T>(connection: KodaXGoogleCacheConnection, signal: AbortSignal | undefined,
  operation: (headers: Headers, signal?: AbortSignal) => Promise<T>): Promise<T> {
  const target = { name: connection.name, getCredentialConnectionFingerprint: () => credentialConnectionFingerprint({ provider: connection.name,
    api: 'google-generate-content', baseUrl: connection.baseUrl, cloud: connection.cloud }) };
  return withProviderRequestCredential(target, 'utility', signal, async activeSignal => {
    const credential = requireCloudCredential(connection.name);
    if (credential.type === 'aws' || (connection.cloud.service === 'gemini' && credential.type !== 'api-key')) throw new Error('Cache credential does not match Google route.');
    const headers = new Headers({ 'content-type': 'application/json', ...(credential.type === 'api-key' ? { 'x-goog-api-key': credential.key } : { authorization: `Bearer ${credential.token}` }) });
    const result = await operation(headers, activeSignal); activeSignal?.throwIfAborted(); return result;
  });
}
function operationConnection(connection: KodaXGoogleCacheConnection) { return { name: connection.name, model: connection.model, baseUrl: root(connection) }; }
export async function createGoogleCache(connection: KodaXGoogleCacheConnection, request: KodaXGoogleCacheRequest, signal?: AbortSignal): Promise<KodaXGoogleCacheReference> {
  if (resolvePromptCacheDisabled()) throw new Error('Explicit cache creation is disabled.');
  connection = structuredClone(connection); request = structuredClone(request); cacheScope(connection);
  const expires = expiration(request);
  if (request.displayName !== undefined && [...request.displayName].length > 128) throw new Error('Cache display name exceeds 128 characters.');
  const plan = projectGoogleTools(connection.name, request.tools ?? [], connection.toolCapabilities ?? {}, request.forcedToolName);
  const system = request.system ? { parts: [{ text: request.system }] } : undefined;
  return run(connection, signal, async (headers, activeSignal) => {
    const contents = await projectGoogleMessages(request.messages, { provider: connection.name, api: 'google-generate-content', model: connection.model,
      baseUrl: connection.baseUrl, credentialScope: cloudCredentialScope(connection.name) }, connection.imageInput === true);
    const body = await operationJson(operationConnection(connection), '/cachedContents', headers, activeSignal,
      { model: wireModel(connection), contents, ...(system ? { systemInstruction: system } : {}), ...(plan.tools.length ? plan : {}), ...expires,
        ...(request.displayName !== undefined ? { displayName: request.displayName } : {}) });
    return { ...reference(connection, body), systemHash: hash(system ?? null), toolsHash: hash(plan), ...(request.forcedToolName ? { forcedToolName: request.forcedToolName } : {}) };
  });
}
export async function getGoogleCache(connection: KodaXGoogleCacheConnection, ref: KodaXGoogleCacheReference, signal?: AbortSignal): Promise<KodaXGoogleCacheReference> {
  connection = structuredClone(connection); ref = structuredClone(ref); validateReference(connection, ref);
  return run(connection, signal, async (headers, activeSignal) => reference(connection,
    await operationJson(operationConnection(connection), `/cachedContents/${resourceId(connection, ref.name)}`, headers, activeSignal, undefined, 'GET'), ref));
}
export async function listGoogleCaches(connection: KodaXGoogleCacheConnection, options: { pageSize?: number; pageToken?: string } = {}, signal?: AbortSignal): Promise<{ caches: KodaXGoogleCacheReference[]; nextPageToken?: string }> {
  connection = structuredClone(connection); options = { ...options }; cacheScope(connection);
  if (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000)) throw new Error('Invalid cache page size.');
  const query = new URLSearchParams({ ...(options.pageSize ? { pageSize: String(options.pageSize) } : {}), ...(options.pageToken ? { pageToken: options.pageToken } : {}) });
  return run(connection, signal, async (headers, activeSignal) => {
    const body = await operationJson(operationConnection(connection), `/cachedContents${query.size ? `?${query}` : ''}`, headers, activeSignal, undefined, 'GET');
    if (body.cachedContents !== undefined && !Array.isArray(body.cachedContents)) throw new Error('Invalid cache resource list.');
    if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') throw new Error('Invalid cache page token.');
    const caches = (body.cachedContents as unknown[] | undefined ?? []).map(value => object(value)).filter(value => value.model === wireModel(connection)).map(value => reference(connection, value));
    return { caches, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken as string } : {}) };
  });
}
export async function updateGoogleCache(connection: KodaXGoogleCacheConnection, ref: KodaXGoogleCacheReference, request: KodaXGoogleCacheExpiration, signal?: AbortSignal): Promise<KodaXGoogleCacheReference> {
  if (resolvePromptCacheDisabled()) throw new Error('Explicit cache renewal is disabled.');
  connection = structuredClone(connection); ref = structuredClone(ref); request = structuredClone(request); validateReference(connection, ref);
  const body = expiration(request), mask = Object.keys(body)[0];
  if (!mask) throw new Error('Cache update requires a new expiration.');
  return run(connection, signal, async (headers, activeSignal) => reference(connection, await operationJson(operationConnection(connection),
    `/cachedContents/${resourceId(connection, ref.name)}?updateMask=${mask}`, headers, activeSignal, body, 'PATCH'), ref));
}
export async function deleteGoogleCache(connection: KodaXGoogleCacheConnection, ref: KodaXGoogleCacheReference, signal?: AbortSignal): Promise<void> {
  connection = structuredClone(connection); ref = structuredClone(ref); validateReference(connection, ref);
  await run(connection, signal, async (headers, activeSignal) => { await operationJson(operationConnection(connection),
    `/cachedContents/${resourceId(connection, ref.name)}`, headers, activeSignal, undefined, 'DELETE'); });
}
export function validateGoogleCacheUse(connection: KodaXGoogleCacheConnection, ref: KodaXGoogleCacheReference, system: string, tools: KodaXToolDefinition[], forcedToolName?: string): string {
  validateReference(connection, ref);
  if (ref.expiresAt <= Date.now()) throw new Error('CachedContent reference has expired.');
  if (ref.systemHash ? ref.systemHash !== hash(system ? { parts: [{ text: system }] } : null) : Boolean(system)) throw new Error('CachedContent system declaration changed.');
  if (ref.forcedToolName !== forcedToolName) throw new Error('CachedContent tool policy changed.');
  if (ref.toolsHash ? ref.toolsHash !== hash(projectGoogleTools(connection.name, tools, connection.toolCapabilities ?? {}, forcedToolName)) : tools.length > 0) throw new Error('CachedContent tool declaration changed.');
  return ref.name;
}
