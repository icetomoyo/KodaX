import type { KodaXCacheCapabilities, KodaXProviderStreamOptions } from '../types.js';
import { KodaXProviderError } from '../errors.js';

export function validateCacheCapabilities(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache capabilities.');
  const profile = value as KodaXCacheCapabilities;
  const lifetimes: Record<KodaXCacheCapabilities['dialect'], readonly string[]> = {
    'openai-retention': ['24h'], 'openai-options': ['30m', '12h'], anthropic: ['1h'], bedrock: ['1h'], pi: [], affinity: [],
  };
  if ((profile.affinityHeader !== undefined && !['x-session-affinity', 'x-affinity'].includes(profile.affinityHeader)) || !Object.hasOwn(lifetimes, profile.dialect) || (profile.longTtl !== undefined && !lifetimes[profile.dialect]?.includes(profile.longTtl))
    || (profile.locations !== undefined && (!Array.isArray(profile.locations) || profile.locations.some(location => !['system', 'tools', 'messages'].includes(location))))
    || (profile.maxCheckpoints !== undefined && (!Number.isSafeInteger(profile.maxCheckpoints) || profile.maxCheckpoints < 1))) throw new Error('Invalid declared cache dialect, lifetime or checkpoints.');
}
function bedrockCheckpoints(payload: Record<string, unknown>, capabilities: KodaXCacheCapabilities): void {
  const append = (list: unknown): void => {
    if (Array.isArray(list) && list.length && !list.some(value => value && typeof value === 'object' && 'cachePoint' in value)) list.push({ cachePoint: { type: 'default' } });
  };
  if (capabilities.locations?.includes('system')) append(payload.system);
  if (capabilities.locations?.includes('tools') && payload.toolConfig && typeof payload.toolConfig === 'object') append((payload.toolConfig as Record<string, unknown>).tools);
  if (capabilities.locations?.includes('messages') && Array.isArray(payload.messages)) {
    const last = payload.messages.slice().reverse().find((value: unknown) => value && typeof value === 'object' && 'role' in value && value.role === 'user') as { content?: unknown } | undefined;
    if (last) append(last.content);
  }
}
/** Pure wire projection. Cache eligibility and actual hits still belong to the upstream service. */
export function applyCachePolicy<T extends object>(payload: T, capabilities: KodaXCacheCapabilities | undefined,
  retention: KodaXProviderStreamOptions['cacheRetention'], disabled: boolean, provider: string): T {
  if (retention !== undefined && !['none', 'short', 'long'].includes(retention)) throw new KodaXProviderError('Invalid cache retention.', provider, { retryable: false });
  const off = disabled || retention === 'none';
  if (!off && retention === 'long' && capabilities?.dialect !== 'pi' && !capabilities?.longTtl) throw new KodaXProviderError('Long retention requires a declared cache lifetime.', provider, { retryable: false });
  const ttl = !off && retention === 'long' ? capabilities?.longTtl : undefined;
  if (!off && capabilities?.dialect === 'bedrock') {
    payload = structuredClone(payload);
    bedrockCheckpoints(payload as Record<string, unknown>, capabilities);
  }
  let checkpoints = 0;
  const visit = (value: unknown, location: string, depth: number, literal = false): unknown => {
    if (depth > 64) throw new KodaXProviderError('Cache payload exceeds the processing depth.', provider, { retryable: false });
    if (Array.isArray(value)) return value.map(entry => visit(entry, location, depth + 1, literal));
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (literal) { output[key] = visit(child, location, depth + 1, true); continue; }
      // Schemas and tool arguments are user data, even when a business field has a cache-like name.
      if (['input_schema', 'parameters', 'inputSchema', 'schema', 'responseSchema', 'json', 'arguments', 'args'].includes(key)
        || (key === 'input' && ('toolUseId' in value || ['tool_use', 'server_tool_use', 'tool_call', 'function_call'].includes(String((value as Record<string, unknown>).type))))) {
        output[key] = visit(child, location, depth + 1, true); continue;
      }
      const nextLocation = key === 'toolConfig' || key === 'tools' ? 'tools' : ['system', 'messages'].includes(key) ? key : location;
      if (['cache_control', 'cachePoint', 'prompt_cache_breakpoint'].includes(key)) {
        if (off || (capabilities?.locations && !capabilities.locations.includes(location as 'system' | 'tools' | 'messages'))) continue;
        checkpoints++;
        output[key] = ttl && key !== 'prompt_cache_breakpoint' && typeof child === 'object' && child ? { ...child, ttl } : child;
      } else output[key] = visit(child, nextLocation, depth + 1);
    }
    return output;
  };
  const output = visit(payload, '', 0) as Record<string, unknown>;
  if (off || capabilities?.affinityHeader) {
    for (const key of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options']) delete output[key];
    if (output.metadata && typeof output.metadata === 'object') delete (output.metadata as Record<string, unknown>).user_id;
  }
  if (capabilities?.dialect === 'openai-options') output.prompt_cache_options = off ? { mode: 'explicit' } : { mode: checkpoints ? 'explicit' : 'implicit', ...(ttl ? { ttl } : {}) };
  if (!off && retention && capabilities?.dialect === 'openai-retention') output.prompt_cache_retention = ttl ?? 'in_memory';
  if (capabilities?.dialect === 'pi' && output.options && typeof output.options === 'object') {
    const options = output.options as Record<string, unknown>;
    if (off) { options.cacheRetention = 'none'; delete options.sessionId; }
    else if (retention) options.cacheRetention = retention;
  }
  if (capabilities?.maxCheckpoints !== undefined && checkpoints > capabilities.maxCheckpoints) throw new KodaXProviderError('Declared cache checkpoint limit exceeded.', provider, { retryable: false });
  return output as T;
}
