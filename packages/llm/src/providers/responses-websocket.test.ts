import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createCustomProvider, runWithProviderCredential, runWithProviderRequestObserver, type ProviderRequestObservation,
  createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope,
  type KodaXResponsesSocket, type KodaXResponsesSocketFactory } from '../index.js';

afterEach(() => vi.unstubAllGlobals());
it('runs the default Node WebSocket implementation over a real local upgrade without an injected transport', async () => {
  interface Client { on(event: 'message', listener: (data: Buffer) => void): void; send(frame: string): void; terminate(): void; }
  const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: { server: Server }) => {
    on(event: 'connection', listener: (client: Client, request: IncomingMessage) => void): void; clients: Set<Client>; close(callback: () => void): void;
  } };
  const http = createServer(), server = new WebSocketServer({ server: http });
  let authorization: string | undefined, frame: Record<string, unknown> | undefined;
  server.on('connection', (client, request) => {
    authorization = request.headers.authorization;
    client.on('message', data => { frame = JSON.parse(data.toString()) as Record<string, unknown>; client.send(JSON.stringify(complete)); });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  try {
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('Expected local port');
    const provider = createCustomProvider({ ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    const result = await runWithProviderCredential(config.name, 'local-only-fixture', () => provider.complete([], [], '', undefined, { transport: 'websocket' }));
    expect(result.toolBlocks[0]?.input).toEqual({ path: 'a' }); expect(authorization).toBe('Bearer local-only-fixture');
    expect(frame?.type).toBe('response.create'); expect(frame).not.toHaveProperty('stream');
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(resolve)); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  }
});

it('replays cached grammar calls with their native custom receipt while keeping newly forced tools current', async () => {
  const lifetime = new AbortController();
  const firstDone = { type: 'response.completed', response: { id: 'grammar-first', status: 'completed', output: [
    { type: 'custom_tool_call', call_id: 'custom-1', name: 'query', input: 'SELECT 1', status: 'completed' },
  ] } };
  const link = socket([firstDone, { type: 'response.completed', response: { id: 'grammar-second', status: 'completed', output: [] } }]);
  const factory: KodaXResponsesSocketFactory = async () => link;
  const provider = createCustomProvider({ ...config, toolCapabilities: { grammar: ['regex'] } });
  const tools = [{ name: 'query', description: 'Query', grammar: { syntax: 'regex' as const, definition: 'SELECT [0-9]+' },
    input_schema: { type: 'object' as const, properties: { sql: { type: 'string' } }, required: ['sql'] } }];
  const options = { transport: 'websocket-cached' as const, sessionId: 'grammar', webSocketLifetime: lifetime.signal, webSocketFactory: factory, forcedToolName: 'query' };
  try {
    const result = await runWithProviderCredential(config.name, 'a', () => provider.complete([{ role: 'user', content: 'first' }], tools, '', undefined, options));
    expect(result.toolBlocks[0]?.input).toEqual({ sql: 'SELECT 1' });
    await runWithProviderCredential(config.name, 'a', () => provider.complete([{ role: 'user', content: 'first' }, { role: 'assistant', content: result.contentBlocks! },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'custom-1', content: 'result' }] }], tools, '', undefined, options));
    const frame = JSON.parse(link.send.mock.calls[1]![0]);
    expect(frame.previous_response_id).toBe('grammar-first'); expect(frame.tool_choice).toEqual({ type: 'custom', name: 'query' });
    expect(frame.input).toEqual([{ type: 'custom_tool_call_output', call_id: 'custom-1', output: 'result' }]);
  } finally { lifetime.abort(); }
});

it('preserves partial usage on a failed WebSocket terminal and exposes no executable result', async () => {
  const link = socket([{ type: 'response.created', response: { id: 'partial' } }, { type: 'response.failed', response: {
    id: 'partial', status: 'failed', usage: { input_tokens: 10, output_tokens: 3 }, error: { code: 'server_error', message: 'interrupted' }, output: [],
  } }]);
  const facts: ProviderRequestObservation[] = [];
  await expect(runWithProviderRequestObserver(fact => facts.push(fact), () => runWithProviderCredential(config.name, 'fixture', () => createCustomProvider(config).stream([], [], '', undefined,
    { transport: 'auto', webSocketFactory: async () => link })))).rejects.toThrow(/WebSocket/);
  expect(link.send).toHaveBeenCalledOnce(); expect(link.close).toHaveBeenCalledOnce();
  expect(facts.find(fact => fact.wireObservation === 'observed' && fact.state === 'failed')?.partialUsage).toMatchObject({ inputTokens: 10, outputTokens: 3 });
});

it.each(['account', 'model', 'session', 'tools', 'reasoning', 'cache'] as const)('keeps cached WebSocket continuation isolated when %s changes', async change => {
  const lifetime = new AbortController();
  const done = { type: 'response.completed', response: { id: 'done', status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
  ] } };
  const links = [socket([done, done]), socket([done])]; let connections = 0;
  const factory = vi.fn<KodaXResponsesSocketFactory>(async () => links[connections++]!);
  const provider = createCustomProvider({ ...config, cacheCapabilities: { dialect: 'openai-options', longTtl: '12h' } });
  const options = { transport: 'websocket-cached' as const, sessionId: `isolate-${change}`, webSocketLifetime: lifetime.signal, webSocketFactory: factory };
  try {
    const first = await runWithProviderCredential(config.name, 'a', () => provider.complete([{ role: 'user', content: 'first' }], [], '', undefined, options));
    const nextOptions = { ...options, ...(change === 'session' ? { sessionId: 'other-session' } : {}), ...(change === 'model' ? { modelOverride: 'other-model' } : {}),
      ...(change === 'cache' ? { cacheRetention: 'long' as const } : {}) };
    const tools = change === 'tools' ? [{ name: 'read', description: 'Read', input_schema: { type: 'object' as const, properties: {} } }] : [];
    await runWithProviderCredential(config.name, change === 'account' ? 'b' : 'a', () => provider.complete([{ role: 'user', content: 'first' },
      { role: 'assistant', content: first.contentBlocks! }, { role: 'user', content: 'next' }], tools, '', change === 'reasoning' ? { effort: 'low' } : undefined, nextOptions));
    const separate = ['account', 'model', 'session'].includes(change);
    expect(factory).toHaveBeenCalledTimes(separate ? 2 : 1);
    const frame = JSON.parse(links[separate ? 1 : 0]!.send.mock.calls[separate ? 0 : 1]![0]);
    expect(frame).not.toHaveProperty('previous_response_id'); expect(frame.input).toHaveLength(3);
  } finally { lifetime.abort(); }
});

it('obtains fresh broker credentials for cached requests and closes the socket with its lease owner', async () => {
  const done = { type: 'response.completed', response: { id: 'done', status: 'completed', output: [] } };
  const link = socket([done, done]), factory = vi.fn<KodaXResponsesSocketFactory>(async () => link);
  const acquire = vi.fn(async () => 'broker-fixture');
  const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire });
  const provider = createCustomProvider(config), options = { transport: 'websocket-cached' as const, sessionId: 'broker', webSocketFactory: factory };
  try {
    await runWithProviderCredentialLeaseScope(scope, async () => {
      await provider.complete([], [], '', undefined, options); await provider.complete([], [], '', undefined, options);
    });
    expect(acquire).toHaveBeenCalledTimes(2); expect(factory).toHaveBeenCalledOnce(); expect(link.close).not.toHaveBeenCalled();
  } finally { scope.close(); }
  expect(link.close).toHaveBeenCalledOnce();
});

it.each([401, 403, 429])('does not hide an authenticated WebSocket handshake HTTP %s with an SSE replay', async status => {
  const http = vi.fn(); vi.stubGlobal('fetch', http);
  const factory = vi.fn<KodaXResponsesSocketFactory>(async () => { throw Object.assign(new Error(`handshake ${status}`), { status }); });
  await expect(runWithProviderCredential(config.name, 'fixture', () => createCustomProvider(config).complete([], [], '', undefined,
    { transport: 'auto', webSocketFactory: factory }))).rejects.toThrow(/handshake/);
  expect(factory).toHaveBeenCalledOnce(); expect(http).not.toHaveBeenCalled();
});
const config = { name: 'ws-test', protocol: 'openai' as const, api: 'responses' as const, model: 'fixture', apiKeyEnv: 'UNUSED', baseUrl: 'https://ws.example/v1' };
function socket(events: unknown[]): KodaXResponsesSocket & { send: ReturnType<typeof vi.fn<(frame: string) => void>>; close: ReturnType<typeof vi.fn<() => void>> } {
  let closed = false;
  return { get closed() { return closed; }, send: vi.fn<(frame: string) => void>(), close: vi.fn<() => void>(() => { closed = true; }),
    receive: async () => { if (!events.length) throw new Error('connection closed'); return JSON.stringify(events.shift()); } };
}
const complete = { type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
  { type: 'function_call', status: 'completed', call_id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
], usage: { input_tokens: 10, output_tokens: 3 } } };
it('sends an authenticated native response.create frame and commits only terminal tool input', async () => {
  const link = socket([{ type: 'response.created', response: { id: 'response-1' } }, { type: 'response.output_text.delta', delta: 'ok' }, complete]);
  const factory = vi.fn<KodaXResponsesSocketFactory>(async () => link);
  const facts: ProviderRequestObservation[] = [], onTextDelta = vi.fn();
  const result = await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithProviderCredential(config.name, 'fixture-key',
    () => createCustomProvider(config).stream([{ role: 'user', content: 'task' }], [], 'system', undefined, { transport: 'websocket', webSocketFactory: factory, onTextDelta })));
  expect(factory.mock.calls[0]![0]).toMatchObject({ url: 'wss://ws.example/v1/responses', headers: { authorization: 'Bearer fixture-key' } });
  const frame = JSON.parse(link.send.mock.calls[0]![0]);
  expect(frame).toMatchObject({ type: 'response.create', model: 'fixture', store: false }); expect(frame).not.toHaveProperty('stream'); expect(frame).not.toHaveProperty('background');
  expect(result.toolBlocks[0]).toMatchObject({ name: 'read', input: { path: 'a' } }); expect(onTextDelta).toHaveBeenCalledWith('ok');
  expect(link.close).toHaveBeenCalledOnce(); expect(facts.filter(fact => fact.wireObservation === 'observed' && fact.state === 'succeeded')).toHaveLength(1);
});

it.each([false, true])('recovers a missing continuation only before generation, respecting singleAttempt=%s', async singleAttempt => {
  const lifetime = new AbortController();
  const done = (id: string) => ({ type: 'response.completed', response: { id, status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
  ] } });
  const firstLink = socket([done('first'), { type: 'error', status: 400, error: { code: 'previous_response_not_found', message: 'Missing continuation' } }]);
  const secondLink = socket([done('second')]);
  let connections = 0;
  const factory = vi.fn<KodaXResponsesSocketFactory>(async () => ++connections === 1 ? firstLink : secondLink);
  const provider = createCustomProvider(config), options = { transport: 'websocket-cached' as const, sessionId: 'recover', webSocketLifetime: lifetime.signal, webSocketFactory: factory };
  const first = await runWithProviderCredential(config.name, 'account-a', () => provider.complete([{ role: 'user', content: 'first' }], [], '', undefined, options));
  const next = () => runWithProviderCredential(config.name, 'account-a', () => provider.complete([{ role: 'user', content: 'first' },
    { role: 'assistant', content: first.contentBlocks! }, { role: 'user', content: 'next' }], [], '', undefined, { ...options, singleAttempt }));
  if (singleAttempt) { await expect(next()).rejects.toThrow(/Missing continuation/); expect(factory).toHaveBeenCalledOnce(); }
  else {
    await next(); expect(factory).toHaveBeenCalledTimes(2);
    const frame = JSON.parse(secondLink.send.mock.calls[0]![0]); expect(frame).not.toHaveProperty('previous_response_id'); expect(frame.input).toHaveLength(3);
  }
  expect(firstLink.close).toHaveBeenCalledOnce(); lifetime.abort();
});

it('reuses a lifetime-bound socket only for an unchanged model/account/session and sends incremental history', async () => {
  const lifetime = new AbortController();
  const done = (id: string) => ({ type: 'response.completed', response: { id, status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
  ] } });
  const link = socket([done('first'), done('second')]), factory = vi.fn<KodaXResponsesSocketFactory>(async () => link);
  const provider = createCustomProvider(config);
  const options = { transport: 'websocket-cached' as const, sessionId: 'session-a', webSocketLifetime: lifetime.signal, webSocketFactory: factory };
  const first = await runWithProviderCredential(config.name, 'account-a', () => provider.complete([{ role: 'user', content: 'first' }], [], 'system', undefined, options));
  await runWithProviderCredential(config.name, 'account-a', () => provider.complete([{ role: 'user', content: 'first' },
    { role: 'assistant', content: first.contentBlocks! }, { role: 'user', content: 'next' }], [], 'system', undefined, options));
  expect(factory).toHaveBeenCalledOnce(); expect(link.close).not.toHaveBeenCalled();
  expect(JSON.parse(link.send.mock.calls[1]![0])).toMatchObject({ previous_response_id: 'first', input: [{ role: 'user', content: 'next' }] });
  lifetime.abort(); expect(link.close).toHaveBeenCalledOnce();
});

it('auto falls back only before dispatch and never replays an interrupted generated response', async () => {
  const http = vi.fn(async () => new Response(`data: ${JSON.stringify(complete)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })); vi.stubGlobal('fetch', http);
  const provider = createCustomProvider(config);
  await runWithProviderCredential(config.name, 'fixture', () => provider.complete([], [], '', undefined, { transport: 'auto', webSocketFactory: async () => { throw new Error('upgrade unavailable'); } }));
  expect(http).toHaveBeenCalledOnce();
  const link = socket([{ type: 'response.created', response: { id: 'partial' } }, { type: 'response.output_text.delta', delta: 'partial' }]);
  await expect(runWithProviderCredential(config.name, 'fixture', () => provider.stream([], [], '', undefined,
    { transport: 'auto', webSocketFactory: async () => link }))).rejects.toThrow(/WebSocket/);
  expect(link.send).toHaveBeenCalledOnce(); expect(http).toHaveBeenCalledOnce(); expect(link.close).toHaveBeenCalledOnce();
});
