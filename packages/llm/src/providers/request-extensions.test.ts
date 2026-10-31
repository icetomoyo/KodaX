import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCustomProvider, createCloudProviderConfig, runWithProviderCredential, serializeCloudCredential,
  createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope, withProviderRequestCredential,
  runWithProviderRequestObserver, type ProviderRequestObservation } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['anthropic', 'openai'] as const)('acquires a lazy %s SDK credential and preserves its utility owner facts', async protocol => {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(protocol === 'anthropic'
    ? { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
    : { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }));
  vi.stubGlobal('fetch', fetcher);
  const provider = createCustomProvider({ name: 'lazy', protocol, model: 'fixture', maxOutputTokens: 100, baseUrl: 'https://lazy.example/v1', apiKeyEnv: 'UNSET_LAZY_KEY' });
  const acquire = vi.fn(async (_provider: string, _purpose: string) => 'scoped-fixture');
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['lazy'], acquire });
  const facts: ProviderRequestObservation[] = [];
  await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithProviderCredentialLeaseScope(scope, () => provider.complete([], [], '')));
  expect(acquire).toHaveBeenCalledTimes(1);
  facts.length = 0; acquire.mockClear();
  await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithProviderCredentialLeaseScope(scope,
    () => withProviderRequestCredential('lazy', 'utility', undefined, signal => provider.complete([], [], '', undefined, undefined, signal))));
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(acquire.mock.calls[0]?.[1]).toBe('utility');
  expect(facts.filter(fact => fact.wireObservation === 'observed' && fact.state === 'started')).toHaveLength(1);
  expect(facts.every(fact => fact.purpose === 'utility')).toBe(true);
  scope.close();
});

it.each(['mistral', 'openai', 'anthropic', 'responses'] as const)('never replays %s when a response hook fails after headers were received', async route => {
  const wire = vi.fn(async () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const provider = createCustomProvider({ name: 'extensions', protocol: route === 'responses' ? 'openai' : route, ...(route === 'responses' ? { api: 'responses' as const } : {}), model: 'fixture', maxOutputTokens: 100, baseUrl: 'https://extensions.example/v1', apiKeyEnv: 'UNUSED' });
  await expect(runWithProviderCredential(provider.name, 'fixture', () => provider.complete([], [], '', undefined, { fetch: wire,
    onResponse: () => { throw Object.assign(new Error('hook failed'), { code: 'ECONNRESET' }); } }))).rejects.toThrow(/onResponse/);
  expect(wire).toHaveBeenCalledOnce();
});

it.each(['mistral', 'pi-messages', 'gemini', 'bedrock'] as const)('lowers sampling and hooks before native %s serialization/signing', async route => {
  const config = route === 'gemini' ? createCloudProviderConfig({ name: 'extensions', service: 'gemini', model: 'fixture' })
    : route === 'bedrock' ? createCloudProviderConfig({ name: 'extensions', service: 'bedrock', model: 'fixture', region: 'us-east-1' })
    : { name: 'extensions', model: 'fixture', protocol: route, apiKeyEnv: 'NATIVE_EXTENSION_KEY', baseUrl: 'https://extensions.example/v1' };
  const provider = createCustomProvider({ ...config, maxOutputTokens: 100 });
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => route === 'pi-messages'
    ? new Response('data: {"type":"start"}\n\ndata: {"type":"done","reason":"stop"}\n\n')
    : Response.json(route === 'gemini' ? { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }
      : route === 'bedrock' ? { output: { message: { role: 'assistant', content: [] } }, stopReason: 'end_turn' }
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const token = config.cloud ? serializeCloudCredential(config.name, route === 'gemini' ? { type: 'api-key', key: 'fixture' }
    : { type: 'aws', accessKeyId: 'test-access', secretAccessKey: 'test-secret' }) : 'fixture';
  const onPayload = vi.fn(() => ({ topP: 0.8 }));
  await runWithProviderCredential(config.name, token, () => provider.complete([], [], '', undefined,
    { fetch: wire, temperature: 0.2, onPayload, headers: { 'x-route-test': 'native' } }));
  const raw = wire.mock.calls[0]?.[1]?.body;
  const body = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString());
  const container = route === 'gemini' ? body.generationConfig : route === 'bedrock' ? body.inferenceConfig : route === 'pi-messages' ? body.options : body;
  expect(container).toMatchObject({ temperature: 0.2, topP: 0.8 }); expect(onPayload).toHaveBeenCalledOnce();
  if (route === 'bedrock') expect(new Headers(wire.mock.calls[0]?.[1]?.headers).get('authorization')).toMatch(/^AWS4-HMAC-SHA256/);
});

it('isolates request fetch/env/hooks and rejects protected payload or auth overrides before dispatch', async () => {
  const provider = createCustomProvider({ name: 'extensions', protocol: 'openai', api: 'responses', model: 'fixture',
    baseUrl: 'https://extensions.example/v1', apiKeyEnv: 'EXTENSION_KEY', maxOutputTokens: 100 });
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] }));
  const fallback = vi.fn(async () => { throw new Error('unexpected global transport'); }); vi.stubGlobal('fetch', fallback);
  const responses: string[] = [];
  const onRequestPrepared = vi.fn();
  const options = { env: { EXTENSION_KEY: 'request-a' }, fetch: wire, temperature: 0.3, samplingParams: { top_p: 0.8 }, headers: { 'x-route-test': 'a' },
    onPayload: async (payload: Readonly<Record<string, unknown>>) => { expect(payload.max_output_tokens).toBe(100); return { service_tier: 'flex' }; },
    onResponse: async (response: Response) => { responses.push(((await response.json()) as { status: string }).status); }, onRequestPrepared };
  await provider.complete([], [], '', undefined, options);
  const sent = wire.mock.calls[0]?.[1];
  expect(new Headers(sent?.headers).get('authorization')).toBe('Bearer request-a');
  expect(new Headers(sent?.headers).get('x-route-test')).toBe('a');
  expect(JSON.parse(String(sent?.body))).toMatchObject({ temperature: 0.3, top_p: 0.8, service_tier: 'flex', max_output_tokens: 100, store: false });
  expect(responses).toEqual(['completed']);
  expect(onRequestPrepared).toHaveBeenCalledWith(expect.objectContaining({ stage: 'protocol-input',
    payloadHash: createHash('sha256').update(String(sent?.body)).digest('hex') }));
  expect(JSON.stringify(onRequestPrepared.mock.calls)).not.toContain('request-a');
  await provider.complete([], [], '', undefined, { env: { EXTENSION_KEY: 'request-b' }, fetch: wire });
  expect(new Headers(wire.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer request-b');
  expect(JSON.parse(String(wire.mock.calls[1]?.[1]?.body))).not.toHaveProperty('temperature');
  await expect(provider.complete([], [], '', undefined, { ...options, headers: { authorization: 'foreign' } })).rejects.toThrow(/controlled/);
  await expect(provider.complete([], [], '', undefined, { ...options, samplingParams: { max_output_tokens: 999 } })).rejects.toThrow(/protected/);
  await expect(provider.complete([], [], '', undefined, { ...options, onPayload: () => ({ tools: [] }) })).rejects.toThrow(/protected/);
  expect(wire).toHaveBeenCalledTimes(2); expect(fallback).not.toHaveBeenCalled();
});

it('passes Vercel JSON routing while rejecting nested credential/cache overrides', async () => {
  const provider = createCustomProvider({ name: 'gateway', protocol: 'anthropic', model: 'fixture', baseUrl: 'https://gateway.example', apiKeyEnv: 'UNUSED', maxOutputTokens: 100 });
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }));
  await runWithProviderCredential(provider.name, 'fixture', () => provider.complete([], [], '', undefined, { fetch: wire,
    onPayload: () => ({ providerOptions: { gateway: { order: ['anthropic', 'bedrock'], only: ['anthropic'] } } }) }));
  expect(JSON.parse(String(wire.mock.calls[0]?.[1]?.body)).providerOptions.gateway.only).toEqual(['anthropic']);
  for (const gateway of [{ byok: { anthropic: [{ apiKey: 'untrusted' }] } }, { caching: 'auto' }]) {
    await expect(runWithProviderCredential(provider.name, 'fixture', () => provider.complete([], [], '', undefined,
      { fetch: wire, onPayload: () => ({ providerOptions: { gateway } }) }))).rejects.toThrow(/credential|cache/i);
  }
  expect(wire).toHaveBeenCalledOnce();
});
