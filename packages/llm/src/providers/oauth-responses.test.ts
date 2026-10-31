import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createOAuthProviderConfig } from '../oauth/provider-config.js';
import { runWithProviderCredential } from '../provider-credential-context.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const terminal = { type: 'response.completed', response: { status: 'completed', output: [
  { type: 'function_call', id: 'fc', call_id: 'call', namespace: 'kodax', name: 'read', arguments: '{}', status: 'completed' },
] } };
describe('broker-only subscription Responses', () => {
  it.each([['openai-chatgpt', false], ['openai-codex', false], ['github-copilot', true]] as const)(
    'advertises native non-streaming recovery accurately for %s', (service, supported) => {
      const config = createOAuthProviderConfig({ service, name: 'subscription', model: 'chosen' });
      expect(createCustomProvider(config).supportsNonStreamingFallback()).toBe(supported);
    });
  it('uses public SIWC streaming, namespaced tools and history, including complete()', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(`data: ${JSON.stringify(terminal)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'subscription', model: 'chosen-model' });
    const provider = createCustomProvider(config);
    const onTextDelta = vi.fn();
    await runWithProviderCredential(config.name, 'oauth-access', async () => {
      const result = await provider.complete([], [{ name: 'read', description: 'read', input_schema: { type: 'object' } }], '', undefined,
        { forcedToolName: 'read', onTextDelta });
      expect(result.toolBlocks[0]?.name).toBe('read');
      await provider.complete([{ role: 'assistant', content: result.contentBlocks! },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] }], [], '');
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ store: false, stream: true, tools: [{ type: 'namespace', name: 'kodax', tools: [{ type: 'function', name: 'read' }] }],
      tool_choice: { type: 'function', name: 'read' } });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).input[0]).toMatchObject({ type: 'function_call', namespace: 'kodax' });
    vi.stubEnv(config.apiKeyEnv, 'ambient-must-not-be-used');
    await expect(provider.complete([], [], '')).rejects.toThrow(/broker|scoped/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not replay encrypted reasoning across account or token changes on the same connection', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(`data: ${JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'readable' }], encrypted_content: 'account-a-cipher' },
      ] },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'subscription', model: 'chosen-model' });
    const provider = createCustomProvider(config);
    const result = await runWithProviderCredential(config.name, 'account-a-token', () => provider.complete([], [], ''));
    await runWithProviderCredential(config.name, 'account-b-token', () => provider.complete([{ role: 'assistant', content: result.contentBlocks! }], [], ''));
    const replay = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(JSON.stringify(replay)).not.toContain('account-a-cipher');
    expect(replay.input).toEqual([{ role: 'assistant', content: '<prior_reasoning>\nreadable\n</prior_reasoning>' }]);
  });
  it('keeps legacy Codex routing separate and buffers SSE for complete with no unsupported output limit', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(`data: ${JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'complete', annotations: [] }] },
      ] },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createOAuthProviderConfig({ service: 'openai-codex', name: 'legacy-subscription', model: 'chosen' });
    const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-a' } })).toString('base64url')}.signature`;
    const onTextDelta = vi.fn();
    const result = await runWithProviderCredential(config.name, token, () => createCustomProvider(config).complete([], [], '', undefined, { onTextDelta }));
    expect(result.textBlocks).toEqual([{ type: 'text', text: 'complete' }]);
    expect(onTextDelta).toHaveBeenCalledExactlyOnceWith('complete');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('chatgpt-account-id')).toBe('workspace-a');
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ stream: true, store: false, instructions: 'You are a helpful assistant.' });
    expect(body.max_output_tokens).toBeUndefined();
    await expect(runWithProviderCredential(config.name, 'invalid-token', () => createCustomProvider(config).complete([], [], ''))).rejects.toThrow(/routing claim/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uses the Copilot resource bearer with per-request initiator headers and real non-streaming support', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ status: 'completed', output: [] }));
    vi.stubGlobal('fetch', fetch);
    const config = createOAuthProviderConfig({ service: 'github-copilot', name: 'copilot-subscription', model: 'chosen' });
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, 'inference-only', async () => {
      await provider.complete([{ role: 'user', content: 'task' }], [], '');
      await provider.complete([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] }], [], '');
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.individual.githubcopilot.com/responses');
    const headers = fetch.mock.calls.map(call => new Headers(call[1]?.headers));
    expect(headers.map(h => h.get('x-initiator'))).toEqual(['user', 'agent']);
    expect(headers[0]?.get('authorization')).toBe('Bearer inference-only');
    expect(headers[0]?.get('openai-intent')).toBe('conversation-edits');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).stream).toBe(false);
  });
  it('rejects mismatched subscription endpoints, API kinds and foreign tool namespaces', async () => {
    const config = createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'subscription', model: 'chosen' });
    expect(() => createCustomProvider({ ...config, baseUrl: 'https://chatgpt.com/backend-api/codex' })).toThrow(/matching/);
    expect(() => createCustomProvider({ ...config, api: 'chat-completions' })).toThrow(/matching/);
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ ...terminal,
      response: { ...terminal.response, output: [{ ...terminal.response.output[0], namespace: 'foreign' }] } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(runWithProviderCredential(config.name, 'access', () => createCustomProvider(config).complete([], [], ''))).rejects.toThrow(/function call/);
  });
  it('verifies credentials through the same subscription stream dialect without requiring ambient configuration', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(`data: ${JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output: [] },
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createOAuthProviderConfig({ service: 'openai-chatgpt', name: 'subscription', model: 'chosen' });
    const provider = createCustomProvider(config);
    expect(provider.isConfigured()).toBe(false);
    await runWithProviderCredential(config.name, 'access', async () => {
      expect(provider.isConfigured()).toBe(true);
      expect(await provider.verifyCredential()).toMatchObject({ ok: true, strategy: 'minimal-message' });
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true, store: false, max_output_tokens: 16 });
  });
});
