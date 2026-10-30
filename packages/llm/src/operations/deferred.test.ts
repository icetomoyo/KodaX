import { afterEach, expect, it, vi } from 'vitest';
import { submitDeferred, fetchDeferred, cancelDeferred, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope,
  runWithProviderRequestObserver, createCustomProvider } from '../index.js';
import type { ProviderRequestObservation } from '../provider-request-observation.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const connection = { name: 'jobs', api: 'openai-background-responses' as const, model: 'model-fixture',
  baseUrl: 'https://api.openai.com/v1', credentialSource: 'broker' as const, accountScope: 'registration-account-1' };
const completed = { id: 'resp_fixture', status: 'completed', model: 'model-fixture', output: [
  { type: 'reasoning', id: 'rs_fixture', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'opaque' },
  { type: 'function_call', status: 'completed', call_id: 'call_fixture', name: 'read', arguments: '{"path":"a"}' },
], usage: { input_tokens: 10, output_tokens: 3 } };
it('submits a real background response and restores it with fresh per-operation authority', async () => {
  let grants = 0;
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['jobs'], acquire: async () => `grant-${++grants}` });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === 'GET' ? completed
    : String(_url).endsWith('/cancel') ? { id: 'resp_fixture', model: 'model-fixture', status: 'cancelled', output: [] }
    : { id: 'resp_fixture', model: 'model-fixture', status: 'queued', output: [], usage: { input_tokens: 999, output_tokens: 999 } }));
  vi.stubGlobal('fetch', fetcher);
  const facts: ProviderRequestObservation[] = [];
  await runWithProviderCredentialLeaseScope(scope, async () => runWithProviderRequestObserver(fact => facts.push(fact), async () => {
    const submitted = await submitDeferred(connection, { messages: [{ role: 'user', content: 'task' }], system: 'system',
      tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object', properties: {} } }], maxOutputTokens: 100 });
    expect(submitted.status).toBe('queued');
    expect(submitted).not.toHaveProperty('result');
    expect(JSON.stringify(submitted)).not.toContain('grant-');
    const restored = JSON.parse(JSON.stringify(submitted.reference));
    const result = await fetchDeferred(connection, restored);
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('Expected completion');
    expect(result.result.toolBlocks).toEqual([{ type: 'tool_use', id: 'call_fixture', name: 'read', input: { path: 'a' } }]);
    expect(result.result.contentBlocks?.map(b => b.type)).toEqual(['thinking', 'tool_use']);
    expect(result.usageKind).toBe('cumulative');
    expect((await cancelDeferred(connection, restored)).status).toBe('cancelled');
  }));
  expect(grants).toBe(3);
  expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual(['Bearer grant-1', 'Bearer grant-2', 'Bearer grant-3']);
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ background: true, store: false, stream: false, max_output_tokens: 100 });
  expect(fetcher.mock.calls[1]?.[0]).toBe('https://api.openai.com/v1/responses/resp_fixture');
  expect(fetcher.mock.calls[2]?.[0]).toBe('https://api.openai.com/v1/responses/resp_fixture/cancel');
  expect(facts.filter(f => f.state === 'succeeded' && f.boundary === 'physical_attempt').every(f => f.usage === undefined)).toBe(true);
  scope.close();
});

it.each(['queued', 'in_progress', 'failed', 'cancelled', 'incomplete'] as const)('keeps %s background snapshots non-executable', async status => {
  vi.stubEnv('JOB_KEY', 'key');
  const fetcher = vi.fn(async () => Response.json({ ...completed, status, incomplete_details: { reason: 'max_output_tokens' } })); vi.stubGlobal('fetch', fetcher);
  const result = await submitDeferred({ ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY' }, {
    messages: [{ role: 'user', content: 'task' }], tools: [], system: '', maxOutputTokens: 10 });
  expect(result.status).toBe(status); expect(result).not.toHaveProperty('result'); expect(result).not.toHaveProperty('usage');
  if (result.status === 'failed' || result.status === 'cancelled' || result.status === 'incomplete') {
    expect(result.partialUsage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(result.usageKind).toBe('cumulative'); expect(result.usageId).toContain('resp_fixture');
  }
});

it.each([
  [{ type: 'function_call', call_id: 'call', name: 'read', arguments: '{' }],
  [{ type: 'function_call', call_id: 'call', name: 'read', arguments: '[]' }],
  [{ type: 'function_call', status: 'in_progress', call_id: 'call', name: 'read', arguments: '{}' }],
  [{ type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' }, { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' }],
  [{ type: 'message', status: 'in_progress', content: [{ type: 'output_text', text: 'partial' }] }],
  [{ type: 'computer_call', id: 'service-tool' }],
  [{ type: 'function_call', call_id: 12, name: 'read', arguments: '{}' }],
  [{ type: 'message', status: 'completed', content: [{ type: 'unknown', text: 'partial' }] }],
  [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: { malformed: true } }],
].map(output => [output] as const))('rejects malformed or unsupported final background output', async output => {
  vi.stubEnv('JOB_KEY', 'key'); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...completed, output })));
  await expect(submitDeferred({ ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY' }, {
    messages: [{ role: 'user', content: 'task' }], tools: [], system: '', maxOutputTokens: 10 })).rejects.toThrow();
});

it('rejects foreign/corrupted references before requesting a credential or sending a query', async () => {
  vi.stubEnv('JOB_KEY', 'key');
  const fetcher = vi.fn(async () => Response.json({ ...completed, status: 'queued' })); vi.stubGlobal('fetch', fetcher);
  const config = { ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY' };
  const job = await submitDeferred(config, { messages: [], tools: [], system: '', maxOutputTokens: 10 });
  fetcher.mockClear();
  await expect(fetchDeferred({ ...config, accountScope: 'other-account' }, job.reference)).rejects.toThrow(/connection\/account/);
  await expect(fetchDeferred({ ...config, model: 'other-model' }, job.reference)).rejects.toThrow(/connection\/account/);
  await expect(fetchDeferred(config, { ...job.reference, id: '../other' })).rejects.toThrow(/connection\/account/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('requires fresh Host authority after revocation and permits explicit rebinding of the same account', async () => {
  const first = createProviderCredentialLeaseScope({ allowedProviders: ['jobs'], acquire: async () => 'host-1' });
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(init?.method === 'GET' ? completed : { ...completed, status: 'queued' }));
  vi.stubGlobal('fetch', fetcher);
  const submitted = await runWithProviderCredentialLeaseScope(first, () => submitDeferred(connection, { messages: [], tools: [], system: '', maxOutputTokens: 10 }));
  first.close();
  await expect(runWithProviderCredentialLeaseScope(first, () => fetchDeferred(connection, submitted.reference))).rejects.toThrow(/no longer active/);
  const next = createProviderCredentialLeaseScope({ allowedProviders: ['jobs'], acquire: async () => 'host-2' });
  const restored = await runWithProviderCredentialLeaseScope(next, () => fetchDeferred(connection, JSON.parse(JSON.stringify(submitted.reference))));
  expect(restored.status).toBe('completed'); expect(fetcher).toHaveBeenCalledTimes(2);
  next.close();
});

it('local cancellation aborts a query without sending remote cancel or returning partial tools', async () => {
  vi.stubEnv('JOB_KEY', 'key');
  const config = { ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY' };
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ ...completed, status: 'queued' })); vi.stubGlobal('fetch', fetcher);
  const submitted = await submitDeferred(config, { messages: [], tools: [], system: '', maxOutputTokens: 10 });
  const abort = new AbortController();
  fetcher.mockImplementation(async (_url, init) => { abort.abort(); init?.signal?.throwIfAborted(); return Response.json(completed); });
  await expect(fetchDeferred(config, submitted.reference, abort.signal)).rejects.toThrow();
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/cancel'))).toHaveLength(0);
});
it('preserves cumulative usage on a malformed completed output error without permitting execution', async () => {
  vi.stubEnv('JOB_KEY', 'key');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...completed, output: [{ type: 'function_call', call_id: 'c', name: 'read', arguments: '{' }] })));
  await expect(submitDeferred({ ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY' }, { messages: [], tools: [], system: '', maxOutputTokens: 10 }))
    .rejects.toMatchObject({ partialUsage: { inputTokens: 10, outputTokens: 3 }, usageKind: 'cumulative', reference: { id: 'resp_fixture' }, metadata: { retryable: false } });
});
it('restores grammar conversion data without storing a credential or a provider instance', async () => {
  vi.stubEnv('JOB_KEY', 'key');
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json({ ...completed,
    status: init?.method === 'GET' ? 'completed' : 'queued', output: [{ type: 'custom_tool_call', call_id: 'custom', name: 'query', input: 'SELECT 1;' }] })); vi.stubGlobal('fetch', fetcher);
  const config = { ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY', toolCapabilities: { grammar: ['regex' as const] } };
  const job = await submitDeferred(config, { messages: [], system: '', maxOutputTokens: 10, tools: [{ name: 'query', description: 'Query',
    grammar: { syntax: 'regex', definition: 'SELECT [0-9]+;' }, input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }] });
  const restored = await fetchDeferred(config, JSON.parse(JSON.stringify(job.reference)));
  if (restored.status !== 'completed') throw new Error('Expected completion');
  expect(restored.result.toolBlocks[0]?.input).toEqual({ sql: 'SELECT 1;' });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).tools[0].type).toBe('custom');
});

it('replays deferred opaque/custom history and receipt in foreground only for the same credential', async () => {
  vi.stubEnv('JOB_KEY', 'same-key');
  const output = [completed.output[0], { type: 'custom_tool_call', status: 'completed', call_id: 'custom', name: 'query', input: 'SELECT 1;' }];
  const wire = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => Response.json(JSON.parse(String(init?.body)).background
    ? { ...completed, output } : { status: 'completed', output: [] })); vi.stubGlobal('fetch', wire);
  const config = { ...connection, credentialSource: undefined, apiKeyEnv: 'JOB_KEY', toolCapabilities: { grammar: ['regex' as const] } };
  const job = await submitDeferred(config, { messages: [], system: '', maxOutputTokens: 100, tools: [{ name: 'query', description: 'Query',
    grammar: { syntax: 'regex', definition: 'SELECT [0-9]+;' }, input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }] });
  if (job.status !== 'completed') throw new Error('Expected completion');
  const provider = createCustomProvider({ name: config.name, model: config.model, baseUrl: config.baseUrl, apiKeyEnv: 'JOB_KEY', protocol: 'openai', api: 'responses' });
  const history = [{ role: 'assistant' as const, content: job.result.contentBlocks! },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'custom', content: 'result' }] }];
  await provider.complete(history, [], '');
  const sent = JSON.parse(String(wire.mock.calls[1]?.[1]?.body)).input;
  expect(sent).toContainEqual(expect.objectContaining({ type: 'reasoning', encrypted_content: 'opaque' }));
  expect(sent).toContainEqual(expect.objectContaining({ type: 'custom_tool_call', input: 'SELECT 1;' }));
  expect(sent).toContainEqual(expect.objectContaining({ type: 'custom_tool_call_output', call_id: 'custom', output: 'result' }));
  vi.stubEnv('JOB_KEY', 'other-key'); await provider.complete(history, [], '');
  const foreign = JSON.parse(String(wire.mock.calls[2]?.[1]?.body)).input;
  expect(JSON.stringify(foreign)).not.toContain('encrypted_content'); expect(foreign.some((value: { type?: string }) => value.type === 'custom_tool_call')).toBe(false);
});
