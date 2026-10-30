import type { KodaXProviderConfig } from '../types.js';
import { requestExtensionFetch } from './request-extensions.js';

/** Only explicitly selected connection modes replace SDK auth; legacy defaults stay intact. */
export function connectionAuthFetch(config: KodaXProviderConfig, key: string, protocol: 'anthropic' | 'openai'): typeof fetch | undefined {
  if (!config.authentication && config.credentialSource !== 'broker') return undefined;
  return (url, init) => {
    const headers = new Headers(init?.headers);
    for (const header of ['authorization', 'x-api-key', 'api-key', 'cf-aig-authorization', 'openai-organization', 'openai-project']) headers.delete(header);
    if (config.authentication === 'cloudflare-gateway') headers.set('cf-aig-authorization', `Bearer ${key}`);
    else if (protocol === 'anthropic' && config.authentication !== 'bearer') headers.set('x-api-key', key);
    else headers.set('authorization', `Bearer ${key}`);
    if (config.oauth === 'anthropic') headers.set('anthropic-beta', [...new Set([...(headers.get('anthropic-beta')?.split(',') ?? []), 'oauth-2025-04-20'])].join(','));
    if (config.oauth === 'github-copilot') copilotHeaders(headers, init?.body);
    return requestExtensionFetch(globalThis.fetch)(url, { ...init, headers, redirect: 'error' });
  };
}

function copilotHeaders(headers: Headers, body: RequestInit['body']): void {
  if (typeof body !== 'string') return;
  let value: unknown;
  try { value = JSON.parse(body) as unknown; } catch { throw new Error('Invalid Copilot request JSON.'); }
  if (!value || typeof value !== 'object') throw new Error('Invalid Copilot request body.');
  const record = value as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input
    : typeof record.input === 'string' ? [{ role: 'user', content: record.input }] : [];
  const last: unknown = messages.at(-1);
  const user = last && typeof last === 'object' && 'role' in last && last.role === 'user'
    && (!('content' in last) || !Array.isArray(last.content) || last.content.some((p: unknown) => p && typeof p === 'object' && 'type' in p && p.type !== 'tool_result'));
  headers.set('x-initiator', user ? 'user' : 'agent');
  headers.set('openai-intent', 'conversation-edits');
  if (/"type":"(?:image|image_url|input_image)"/.test(JSON.stringify(messages))) headers.set('copilot-vision-request', 'true');
}
