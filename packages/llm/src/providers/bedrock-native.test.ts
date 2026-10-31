import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { createCloudProviderConfig } from '../cloud/provider-config.js';
import { serializeCloudCredential } from '../cloud/credentials.js';
import { runWithProviderCredential } from '../provider-credential-context.js';
import { fileURLToPath } from 'node:url';
import { runWithProviderRequestObserver, type ProviderRequestObservation } from '../provider-request-observation.js';
import { createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope, withProviderRequestCredential } from '../provider-credential-context.js';
import { runWithScopedConfig } from '../run-scoped-config.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withPreparedImageHistory, prepareHistoryImages } from './image-serialization.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
// Independent protocol fixture; production encoding/CRC validation belongs to the official SDK.
function eventFrame(type: string, value: unknown): Buffer {
  const fields = { ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' };
  const headers = Buffer.concat(Object.entries(fields).map(([name, text]) => {
    const key = Buffer.from(name), data = Buffer.from(text), prefix = Buffer.alloc(1 + key.length + 3);
    prefix[0] = key.length; key.copy(prefix, 1); prefix[1 + key.length] = 7; prefix.writeUInt16BE(data.length, 2 + key.length);
    return Buffer.concat([prefix, data]);
  }));
  const payload = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(16 + headers.length + payload.length);
  const crc = (bytes: Uint8Array) => {
    let result = -1;
    for (const byte of bytes) { result ^= byte; for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ (result & 1 ? 0xedb88320 : 0); }
    return (result ^ -1) >>> 0;
  };
  frame.writeUInt32BE(frame.length); frame.writeUInt32BE(headers.length, 4); frame.writeUInt32BE(crc(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length); frame.writeUInt32BE(crc(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}
function eventResponse(events: Array<[string, unknown]>): Response {
  return new Response(Buffer.concat(events.map(([name, body]) => eventFrame(name, body))), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } });
}
describe('native Bedrock Converse', () => {
  it('signs an explicit temporary identity, sends native tools and replays signed reasoning', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
      output: { message: { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'plan', signature: 'sig' } } },
        { toolUse: { toolUseId: 'call', name: 'read', input: { path: 'a' } } }] } }, stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, cacheReadInputTokens: 10, cacheWriteInputTokens: 3 },
    }));
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'must-not-use-env');
    vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'must-not-use-env');
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'model:1', region: 'us-east-1' });
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, {
      type: 'aws', accessKeyId: 'test-access', secretAccessKey: 'test-secret', sessionToken: 'test-session',
    }), async () => {
      const first = await provider.complete([{ role: 'user', content: 'task' }], [{ name: 'read', description: 'read', input_schema: { type: 'object' } }], 'system');
      expect(first.toolBlocks[0]).toMatchObject({ id: 'call', name: 'read', input: { path: 'a' } });
      expect(first.usage).toMatchObject({ inputTokens: 20, outputTokens: 8, cachedReadTokens: 10, cachedWriteTokens: 3 });
      await provider.complete([{ role: 'assistant', content: first.contentBlocks! },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] }], [], 'system');
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/model%3A1/converse');
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-east-1\/bedrock\/aws4_request,/);
    expect(headers.get('x-amz-security-token')).toBe('test-session');
    const replay = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(replay.messages).toEqual([{ role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'plan', signature: 'sig' } } },
      { toolUse: { toolUseId: 'call', name: 'read', input: { path: 'a' } } }] },
    { role: 'user', content: [{ toolResult: { toolUseId: 'call', content: [{ text: 'ok' }], status: 'success' } }] }]);
  });
  it('decodes real split EventStream frames and commits tools only after complete native boundaries', async () => {
    const wire = Buffer.concat([
      eventFrame('messageStart', { role: 'assistant' }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'plan' } } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig-' } } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'end' } } }),
      eventFrame('contentBlockStop', { contentBlockIndex: 0 }),
      eventFrame('contentBlockStart', { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'call', name: 'read' } } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"pa' } } }),
      eventFrame('contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: 'th":"a"}' } } }),
      eventFrame('contentBlockStop', { contentBlockIndex: 1 }),
      eventFrame('messageStop', { stopReason: 'tool_use' }),
      eventFrame('metadata', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } }),
    ]);
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < wire.length; index += 11) controller.enqueue(wire.subarray(index, index + 11));
      controller.close();
    } }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } }));
    vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'model:1', region: 'us-east-1' });
    const onToolInputDelta = vi.fn();
    const response = await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'bedrock-token' }),
      () => createCustomProvider(config).stream([], [], '', undefined, { onToolInputDelta }));
    expect(response.thinkingBlocks[0]).toMatchObject({ type: 'thinking', thinking: 'plan', signature: 'sig-end' });
    expect(response.toolBlocks[0]).toMatchObject({ id: 'call', name: 'read', input: { path: 'a' } });
    expect(response.usage?.totalTokens).toBe(15);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer bedrock-token');
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/model%3A1/converse-stream');
    expect(onToolInputDelta.mock.calls.map(call => call[1]).join('')).toBe('{"path":"a"}');
  });
  it.each([true, false])('serializes images only with declared image input: %s', async imageInput => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }));
    vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' }), imageInput };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), () => createCustomProvider(config).complete([
      { role: 'user', content: [{ type: 'image', path: fileURLToPath(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url)) }] },
    ], [], ''));
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(JSON.stringify(body).includes('"image"')).toBe(imageInput);
  });
  it.each([
    [['messageStart', { role: 'user' }]],
    [['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'orphan' } }]],
    [['messageStart', { role: 'assistant' }], ['messageStop', { stopReason: 'max_tokens' }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call', name: 'read' } } }], ['messageStop', { stopReason: 'tool_use' }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockDelta', { contentBlockIndex: -1, delta: { text: 'invalid' } }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'ok' } }], ['contentBlockStop', { contentBlockIndex: 0 }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'late' } }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'ok' } }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'mixed' } } }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockStop', { contentBlockIndex: 0 }]],
    [['messageStart', { role: 'assistant' }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'plan' } } }], ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: 'AQI=' } } }]],
    [['messageStart', { role: 'assistant' }], ['validationException', { message: 'invalid request' }]],
  ] as Array<Array<[string, unknown]>>)('rejects invalid native boundaries without returning executable tools: %#', async events => {
    const fetch = vi.fn(async () => eventResponse(events)); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }),
      () => createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }))).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('rejects a truncated stream while retaining observed usage and no completed tool result', async () => {
    const fetch = vi.fn(async () => eventResponse([
      ['messageStart', { role: 'assistant' }],
      ['contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call', name: 'read' } } }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":' } } }],
      ['metadata', { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, metrics: { latencyMs: 1 } }],
    ])); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    const facts: ProviderRequestObservation[] = [];
    const scope = createProviderCredentialLeaseScope({ allowedProviders: [config.name], acquire: async () => serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }) });
    try {
      await expect(runWithProviderCredentialLeaseScope(scope, () => runWithProviderRequestObserver(f => facts.push(f), () => withProviderRequestCredential(config.name, 'primary', undefined,
        signal => createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }, signal))))).rejects.toThrow(/incomplete/);
      expect(facts.find(f => f.boundary === 'physical_attempt' && f.state === 'failed')).toMatchObject({ partialUsage: { totalTokens: 13 } });
    } finally { scope.close(); }
  });
  it('preserves multiple redacted byte fragments, text without start and source-safe replay', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => eventResponse([
      ['messageStart', { role: 'assistant' }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: 'AQI=' } } }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: 'AwQ=' } } }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
      ['contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'answer' } }],
      ['contentBlockStop', { contentBlockIndex: 1 }], ['messageStop', { stopReason: 'end_turn' }],
    ])); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    const provider = createCustomProvider(config);
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), async () => {
      const first = await provider.stream([], [], '');
      expect(first.contentBlocks?.map(b => b.type)).toEqual(['redacted_thinking', 'text']);
      expect(first.thinkingBlocks[0]).toMatchObject({ data: 'AQIDBA==' });
      await provider.stream([{ role: 'assistant', content: first.contentBlocks! }], [], '');
      await provider.stream([{ role: 'assistant', content: first.contentBlocks! }], [], '', undefined, { modelOverride: 'other' });
    });
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toContain('AQIDBA==');
    expect(String(fetch.mock.calls[2]?.[1]?.body)).not.toContain('redactedContent');
  });
  it('uses declared budget/adaptive profiles and applies forced tools, cache markers and cache-off per request', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' }),
      maxOutputTokens: 2000, promptCacheAffinity: true, reasoning: { efforts: ['off', 'low', 'high'], default: 'low' } };
    const provider = createCustomProvider(config);
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'prefix' }, { type: 'cache-boundary' as const }] }];
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), async () => {
      await provider.complete(messages, [{ name: 'read', description: 'old', input_schema: { type: 'object' } }], 'system', undefined, { forcedToolName: 'read' });
      await runWithScopedConfig({ disablePromptCache: true }, () => provider.complete(messages, [], '', false));
      const budget = createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'provider-budget', defaultEffort: 'low', budgetByEffort: { low: 1000 }, supportsDisabledThinking: true } });
      await budget.complete([], [], '');
    });
    const bodies = fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(bodies[0]).toMatchObject({ inferenceConfig: { maxTokens: 2000 }, additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }, toolConfig: { toolChoice: { tool: { name: 'read' } } } });
    expect(JSON.stringify(bodies[0])).toContain('cachePoint');
    expect(JSON.stringify(bodies[1])).not.toContain('cachePoint');
    expect(bodies[1]).toMatchObject({ additionalModelRequestFields: { thinking: { type: 'disabled' } } });
    expect(bodies[2]).toMatchObject({ additionalModelRequestFields: { thinking: { type: 'enabled', budget_tokens: 1000 } } });
  });
  it('disables SDK retries and preserves Retry-After for KodaX physical retry accounting', async () => {
    let count = 0;
    const fetch = vi.fn(async () => ++count === 1 ? Response.json({ __type: 'ThrottlingException', message: 'temporary rate limit' }, { status: 429, headers: { 'retry-after': '1' } })
      : Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    const onRetryAfter = vi.fn();
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }),
      () => createCustomProvider(config).complete([], [], '', undefined, { onRetryAfter }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetryAfter).toHaveBeenCalledWith(expect.objectContaining({ waitMs: 1000, reason: 'rate-limit', source: 'retry-after-seconds', attempt: 1 }));
  });
  it('never commits non-streaming tools after cancellation', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { abort.abort(new DOMException('cancelled', 'AbortError')); return Response.json({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 'call', name: 'read', input: {} } }] } }, stopReason: 'tool_use' }); }));
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }),
      () => createCustomProvider(config).complete([], [], '', undefined, { singleAttempt: true }, abort.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('closes an open response stream after native protocol rejection', async () => {
    let cancelled = false;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(eventFrame('messageStart', { role: 'user' })); }, cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })));
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), () => createCustomProvider(config).stream([], [], '', undefined, { singleAttempt: true }))).rejects.toThrow(/message start/);
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it('honors thinkingBudgetCap and a declared disabled default', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' }), thinkingBudgetCap: 1024, maxOutputTokens: 20000 };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), async () => {
      await createCustomProvider({ ...config, reasoningProfile: { effortStrategy: 'provider-budget', defaultEffort: 'high', budgetByEffort: { high: 8000 } } }).complete([], [], '');
      await createCustomProvider({ ...config, reasoning: { efforts: ['off', 'high'], default: 'off' } }).complete([], [], '');
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ additionalModelRequestFields: { thinking: { budget_tokens: 1024 } } });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({ additionalModelRequestFields: { thinking: { type: 'disabled' } } });
  });
  it('reuses admitted image bytes even if the local file changes before dispatch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kodax-t08-image-'));
    const imagePath = path.join(root, 'image.png');
    const bytes = await readFile(fileURLToPath(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url)));
    await writeFile(imagePath, bytes);
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' }), imageInput: true };
    const messages = [{ role: 'user' as const, content: [{ type: 'image' as const, path: imagePath }] }];
    try {
      await withPreparedImageHistory(async () => {
        await prepareHistoryImages(messages); await writeFile(imagePath, 'changed after admission');
        await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), () => createCustomProvider(config).complete(messages, [], ''));
      });
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).messages[0].content[0].image.source.bytes).toBe(bytes.toString('base64'));
    } finally { expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  });
  it.each([null, [], 'bad'])('rejects invalid complete-response tool arguments %j', async input => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ output: { message: { role: 'assistant', content: [
      { toolUse: { toolUseId: 'first', name: 'read', input: {} } }, { toolUse: { toolUseId: 'bad', name: 'read', input } },
    ] } }, stopReason: 'tool_use' })));
    const config = createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' });
    await expect(runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), () => createCustomProvider(config).complete([], [], ''))).rejects.toThrow();
  });
  it('keeps error receipts and missing-image notices in native tool results while dropping foreign opaque reasoning', async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
    const config = { ...createCloudProviderConfig({ service: 'bedrock', name: 'bedrock-test', model: 'chosen', region: 'us-east-1' }), imageInput: true };
    await runWithProviderCredential(config.name, serializeCloudCredential(config.name, { type: 'bearer', token: 'token' }), () => createCustomProvider(config).complete([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'old plan', signature: 'foreign-signature' }, { type: 'redacted_thinking', data: 'foreign-opaque' }, { type: 'tool_use', id: 'call', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content: [{ type: 'text', text: 'failed' }, { type: 'image', path: 'C:/not-present-kodax-t08-image.png' }] }] },
    ], [], ''));
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body).toContain('"status":"error"'); expect(body).toContain('Historical image unavailable');
    expect(body).not.toContain('foreign-signature'); expect(body).not.toContain('foreign-opaque'); expect(body).toContain('prior_reasoning');
  });
});
