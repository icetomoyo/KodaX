import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { KodaXCacheCapabilities, KodaXProviderRequestMetadata, KodaXProviderStreamOptions, KodaXTokenUsage } from '../types.js';
import { KodaXProviderError } from '../errors.js';
import { applyCachePolicy } from './cache-policy.js';

interface RequestExtensions { environment: Readonly<Record<string, string | undefined>>; options: KodaXProviderStreamOptions; metadata: KodaXProviderRequestMetadata; cache?: KodaXCacheCapabilities; cacheDisabled: boolean; }
const requests = new AsyncLocalStorage<RequestExtensions>();
const protectedFields = new Set(['model', 'modelId', 'messages', 'input', 'instructions', 'system', 'systemInstruction', 'contents', 'context',
  'tools', 'tool_choice', 'toolChoice', 'toolConfig', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'maxTokens', 'maxOutputTokens',
  'reasoning', 'reasoning_effort', 'thinking', 'thinkingConfig', 'prompt_mode', 'extra_body', 'metadata', 'include', 'stream', 'stream_options',
  'store', 'background', 'previous_response_id', 'cachedContent', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options',
  'apiKey', 'api_key', 'authorization', 'credentials', 'cache_control', 'cachePoint', 'caching', 'cacheRetention', 'sessionId', 'generationConfig', 'inferenceConfig', 'additionalModelRequestFields', 'options', 'type', 'stream_id', 'generate']);
const reservedHeader = /^(?:authorization|proxy-authorization|host|content-length|content-type|connection|upgrade|sec-websocket-.+|session-id|x-session-affinity|x-affinity|cookie|user-agent|origin|referer|api-key|x-api-key|x-goog-api-key|x-amz-.+|cf-aig-authorization|openai-organization|openai-project|chatgpt-account-id|x-initiator|openai-intent|copilot-.+)$/i;

function invalid(message: string): never {
  throw new KodaXProviderError(message, requests.getStore()?.metadata.provider ?? 'request', { failureCode: 'request_build_failed', retryable: false });
}
function hookFailure(name: string, cause: unknown): never {
  const error = new KodaXProviderError(`Provider ${name} hook failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    requests.getStore()?.metadata.provider ?? 'request', { failureCode: 'response_stream_error', retryable: false });
  error.cause = cause; throw error;
}
export function withRequestExtensions<T>(provider: string, model: string, options: KodaXProviderStreamOptions | undefined, operation: () => T,
  cache?: KodaXCacheCapabilities, cacheDisabled = false): T {
  const snapshot = { ...options, ...(options?.env ? { env: { ...options.env } } : {}),
    ...(options?.headers ? { headers: { ...options.headers } } : {}), ...(options?.samplingParams ? { samplingParams: structuredClone(options.samplingParams) } : {}) };
  return requests.run({ environment: { ...(snapshot.env ?? process.env) }, options: snapshot, metadata: { provider, model }, cache, cacheDisabled }, () => {
    for (const key of Object.keys(snapshot.headers ?? {})) if (reservedHeader.test(key)) invalid(`Request header ${key} is controlled by the connection.`);
    return operation();
  });
}
export function requestEnvironment(key: string): string | undefined {
  const environment = requests.getStore()?.environment;
  return environment === undefined ? process.env[key] : environment[key];
}
export function requestIdentity(): string | undefined { return requests.getStore()?.options.identity; }
export function withCacheWritePartition(usage: KodaXTokenUsage | undefined): KodaXTokenUsage | undefined {
  const current = requests.getStore();
  return usage?.cachedWriteTokens && !usage.cachedWriteTokensByTtl && (current?.options.cacheRetention === 'long' || current?.cache?.dialect === 'openai-options')
    ? { ...usage, cachedWriteTokensByTtl: { unknown: usage.cachedWriteTokens } } : usage;
}
export function hasRequestEnvironment(): boolean { return requests.getStore()?.options.env !== undefined; }
export function requestHeaders(base?: RequestInit['headers']): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(requests.getStore()?.options.headers ?? {})) {
    if (reservedHeader.test(key)) invalid(`Request header ${key} is controlled by the connection.`);
    headers.set(key, key.toLowerCase() === 'anthropic-beta' && headers.has(key)
      ? [...new Set([...headers.get(key)!.split(','), ...value.split(',')])].join(',') : value);
  }
  const current = requests.getStore();
  if (current?.cacheDisabled || current?.options.cacheRetention === 'none') { headers.delete('x-affinity'); headers.delete('x-session-affinity'); }
  const affinity = current?.cache?.affinityHeader;
  if (affinity) {
    headers.delete(affinity);
    if (!current.cacheDisabled && current.options.cacheRetention !== 'none' && current.options.promptCacheKey) headers.set(affinity, current.options.promptCacheKey);
  }
  return headers;
}
function extensions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Request extensions must be an object.');
  if (Object.keys(value).some(key => protectedFields.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid('Request extensions cannot override protected protocol fields.');
  const options = value as Record<string, unknown>;
  validateProviderOptions(options.providerOptions);
  return options;
}
function validateProviderOptions(value: unknown, depth = 0): void {
  if (depth > 32) invalid('Provider options exceed the processing depth.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:byok|api[_-]?key|credentials?|access[_-]?token|refresh[_-]?token|authorization)$/i.test(key)) invalid('Provider options cannot supply credentials; use the credential broker.');
    if (/^(?:caching|cache[_-]?control|cache[_-]?retention|prompt[_-]?cache[_-]?(?:key|options|retention))$/i.test(key)) invalid('Provider options cannot override the cache policy.');
    validateProviderOptions(child, depth + 1);
  }
}
/** Called on native objects before SDK serialization/signing. Auth and request targets never enter this hook. */
export async function prepareProviderPayload<T extends object>(payload: T, shape: 'root' | 'google' | 'bedrock' | 'pi' = 'root', observe = true): Promise<T> {
  const current = requests.getStore();
  if (!current) return payload;
  const { options, metadata } = current;
  payload = applyCachePolicy(payload, current.cache, options.cacheRetention, current.cacheDisabled, metadata.provider);
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0)) invalid('Temperature must be a finite non-negative number.');
  const additions = { ...extensions(options.samplingParams ?? {}), ...(options.temperature !== undefined ? { temperature: options.temperature } : {}) };
  let patch: Record<string, unknown> | void;
  try { patch = await options.onPayload?.(structuredClone(payload) as Record<string, unknown>, { ...metadata }); }
  catch (error) { hookFailure('onPayload', error); }
  if (patch !== undefined) Object.assign(additions, extensions(patch));
  const container = shape === 'google' ? 'generationConfig' : shape === 'bedrock' ? 'inferenceConfig' : shape === 'pi' ? 'options' : undefined;
  const original = payload as Record<string, unknown>;
  const prepared = container ? { ...payload, [container]: { ...(original[container] as object), ...additions } } : { ...payload, ...additions };
  if (observe) observePreparedProviderPayload(prepared);
  return prepared as T;
}
export function observePreparedProviderPayload(prepared: object): void {
  const current = requests.getStore();
  const onRequestPrepared = current?.options.onRequestPrepared;
  if (current && onRequestPrepared) {
    const { options, metadata } = current, wire = prepared as Record<string, unknown>;
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
    try { onRequestPrepared({ ...metadata, stage: 'protocol-input', payloadHash: digest(wire),
      systemHash: digest(wire.system ?? wire.systemInstruction ?? wire.instructions), toolsHash: digest(wire.tools ?? wire.toolConfig),
      messagesHash: digest(wire.messages ?? wire.contents ?? wire.input ?? wire.context),
      cachePolicyHash: digest([current.cache, options.cacheRetention, current.cacheDisabled]) }); }
    catch (error) { hookFailure('onRequestPrepared', error); }
  }
}
/** Invoked inside the physical observation wrapper; response hooks receive their own body stream. */
export function requestExtensionFetch(fallback: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const current = requests.getStore();
    if (!current) return fallback(input, init);
    const headers = requestHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const response = await (current.options.fetch ?? fallback)(input, { ...init, headers, redirect: 'error' });
    try { await current.options.onResponse?.(response.clone(), { ...current.metadata }); }
    catch (error) { hookFailure('onResponse', error); }
    init?.signal?.throwIfAborted();
    return response;
  };
}
export function providerStreamEvent(event: unknown): void {
  const current = requests.getStore();
  try { current?.options.onProviderStreamEvent?.(structuredClone(event), { ...current.metadata }); }
  catch (error) { hookFailure('onProviderStreamEvent', error); }
}
