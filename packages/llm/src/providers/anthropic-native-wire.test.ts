import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, resetBuiltinProviderCache } from './registry.js';
import type { KodaXMessage, KodaXToolDefinition } from '../types.js';

afterEach(() => { resetBuiltinProviderCache(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==', 'base64');
const bindingPrefix = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'cache_control' ? undefined : item));

it('changes cache lifetime without freezing old markers or breaking the verified parent chain', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  });
  const provider = getProvider('anthropic'), messages: KodaXMessage[] = [];
  const tools: KodaXToolDefinition[] = [{ name: 'read', description: 'read', input_schema: { type: 'object', properties: {} } }];
  let parent: string | undefined;
  for (const cacheRetention of ['long', 'short', 'none', 'short', 'long'] as const) {
    messages.push({ role: 'user', content: cacheRetention });
    const result = await provider.complete(messages, tools, 'base', { effort: 'high' }, {
      modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, cacheRetention,
    });
    if (parent) expect(result.nativeHistory?.parent).toBe(parent);
    parent = result.nativeHistory!.id;
    const body = sent.at(-1)!;
    for (const key of ['system', 'tools']) {
      const marker = (body[key] as { cache_control?: { ttl?: string } }[]).at(-1)?.cache_control;
      if (cacheRetention === 'none') expect(marker).toBeUndefined();
      else { expect(marker).toBeDefined(); expect(marker?.ttl).toBe(cacheRetention === 'long' ? '1h' : undefined); }
    }
    messages.push({ role: 'assistant', content: result.contentBlocks!, nativeHistory: result.nativeHistory });
  }
});

it.each(['cached', 'wire'] as const)('keeps effort self-healing usable for a native model after a %s rejection', async rejection => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; sent.push(body);
    if ((body.output_config as { effort?: string } | undefined)?.effort === 'high') return Response.json({ type: 'error', error: {
      type: 'invalid_request_error', message: "Unsupported value 'high' for output_config.effort. Supported values: low, medium." } }, { status: 400 });
    return Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  });
  const result = await getProvider('anthropic').complete([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
    { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, ...(rejection === 'cached' ? { rejectedReasoningEfforts: ['high'] } : {}) });
  expect(sent).toHaveLength(rejection === 'cached' ? 1 : 2);
  expect(sent.at(-1)?.thinking).toMatchObject({ type: 'adaptive' });
  expect((sent.at(-1)?.output_config as { effort?: string } | undefined)?.effort).toBeUndefined();
  expect(result.nativeHistory?.requested.effort).toBeUndefined();
  expect(result.reasoningResolution?.sentEffort).toBeUndefined();
});

it('never replays unverified opaque thinking in a tail after a verified native fragment', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ content: [{ type: 'thinking', thinking: '', signature: 'verified-A' }, { type: 'text', text: 'A' }], stop_reason: 'end_turn' });
  });
  const provider = getProvider('anthropic'), options = { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096 };
  const input: KodaXMessage[] = [{ role: 'user', content: 'first' }];
  const first = await provider.complete(input, [], '', { effort: 'high' }, options);
  input.push({ role: 'assistant', content: first.contentBlocks!, nativeHistory: first.nativeHistory },
    { role: 'user', content: 'edited input before imported B' }, { role: 'assistant', content: [
      { type: 'thinking', thinking: 'retain readable context', signature: 'sig-unproven-B', source: first.thinkingBlocks[0]!.source }, { type: 'text', text: 'B' },
    ] }, { role: 'user', content: 'continue' });
  await provider.complete(input, [], '', { effort: 'high' }, options);
  expect(JSON.stringify(requests[1]!.messages)).not.toContain('sig-unproven-B');
  expect(JSON.stringify(requests[1]!.messages)).toContain('verified-A');
  expect(JSON.stringify(requests[1]!.messages)).toContain('retain readable context');
});

it('repairs a missing tool result on a new native lineage without running the tool', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  let sent: Record<string, unknown> = {};
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  });
  await getProvider('anthropic').complete([
    { role: 'user', content: 'read' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'missing', name: 'read', input: {} }] },
    { role: 'system', content: 'New trusted rule' }, { role: 'user', content: 'continue after recovery' },
  ], [], '', { effort: 'high' }, { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096 });
  expect(sent.messages).toMatchObject([{ role: 'user' }, { role: 'assistant' }, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'missing', is_error: true }, { type: 'text', text: 'continue after recovery' },
  ] }, { role: 'system', content: [{ type: 'text', text: 'New trusted rule' }] }]);
});

it.each(['stream', 'complete'] as const)('keeps actual wire/image/suffix across JSON restore and native updates through %s', async method => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-native-wire-'));
  try {
    const image = path.join(directory, 'first.png'); await writeFile(image, imageBytes);
    vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
    const requests: Record<string, unknown>[] = [];
    const native = [{ type: 'thinking', thinking: '', signature: 'signed-first' }, { type: 'text', text: 'done' }];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(body);
      if (body.stream) {
        const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          ...native.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({ content: native, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const provider = getProvider('anthropic');
    let messages: KodaXMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', path: image }] }];
    const options = { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, ephemeralSuffix: { content: 'old data reminder' } };
    const first = await provider[method](messages, [], 'base one', { effort: 'high' }, options);
    expect(first.nativeHistory).toBeDefined();
    messages.push({ role: 'assistant', content: first.contentBlocks!, nativeHistory: first.nativeHistory });
    messages = JSON.parse(JSON.stringify(messages)) as KodaXMessage[];
    await rm(image); messages.push({ role: 'user', content: 'continue' });
    const tool: KodaXToolDefinition = { name: 'read', description: 'Read', input_schema: { type: 'object', properties: {} } };
    const second = await provider[method](messages, [tool], 'base two', { effort: 'low' }, { ...options, ephemeralSuffix: { content: 'new data reminder' } });
    const oldMessages = requests[0]!.messages as unknown[];
    const next = requests[1]!.messages as Array<Record<string, unknown>>;
    expect(bindingPrefix(next.slice(0, oldMessages.length))).toEqual(bindingPrefix(oldMessages));
    expect(JSON.stringify(next)).toContain(imageBytes.toString('base64'));
    expect(JSON.stringify(next)).not.toContain('Historical image unavailable');
    expect(requests[1]!.system).toEqual(requests[0]!.system); expect(requests[1]!.tools).toBeUndefined();
    expect(next.at(-1)).toMatchObject({ role: 'system', output_config: { effort: 'low' } });
    expect(second.nativeHistory?.parent).toBe(first.nativeHistory?.id);
    messages.push({ role: 'assistant', content: second.contentBlocks!, nativeHistory: second.nativeHistory }, { role: 'user', content: 'last' });
    await provider[method](messages, [], 'base two', { effort: 'low' }, { ...options, ephemeralSuffix: undefined });
    expect(JSON.stringify(requests[2]!.messages)).toContain('tool_removal');
    expect(bindingPrefix((requests[2]!.messages as unknown[]).slice(0, next.length))).toEqual(bindingPrefix(next));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])('validates native thinking controls before %s dispatch', async modelOverride => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })); vi.stubGlobal('fetch', fetch);
  const provider = getProvider('anthropic'), messages: KodaXMessage[] = [{ role: 'user', content: 'hello' }];
  const options = { modelOverride, maxOutputTokensOverride: 4096 };
  if (!modelOverride.includes('haiku')) await expect(provider.complete(messages, [], '', { effort: 'none' }, options)).rejects.toThrow(/adaptive|none/i);
  else {
    await provider.complete(messages, [], '', { effort: 'none' }, options);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).thinking).toEqual({ type: 'disabled' });
  }
  const controlled = provider.complete(messages, [], '', { effort: 'high' }, { ...options, thinkingMode: 'between_tools' });
  if (modelOverride.includes('sonnet')) await expect(controlled).resolves.toBeDefined();
  else await expect(controlled).rejects.toThrow(/mode|adaptive/);
});

it.each(['stream', 'complete'] as const)('rejects unsupported sampling after SDK options/hooks in %s without sending a request', async method => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const onRequestPrepared = vi.fn();
  for (const patch of [{ temperature: 0.5 }, { samplingParams: { top_p: 0.9, top_k: 40 } },
    { onPayload: () => ({ temperature: 0.5 }) }]) {
    await expect(getProvider('anthropic')[method]([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
      { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, onRequestPrepared, ...patch })).rejects.toThrow(/sampling/i);
  }
  expect(fetch).not.toHaveBeenCalled(); expect(onRequestPrepared).not.toHaveBeenCalled();
});

it.each(['stream', 'complete'] as const)('keeps reasoning authoritative while allowing a format extension through %s', async method => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  let sent: Record<string, unknown> = {};
  const onRequestPrepared = vi.fn();
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (sent.stream) return new Response('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return Response.json({ content: [], stop_reason: 'end_turn' });
  });
  const provider = getProvider('anthropic'), options = { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, onRequestPrepared };
  await expect(provider[method]([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
    { ...options, onPayload: () => ({ output_config: { effort: 'low' } }) })).rejects.toThrow(/reasoning/i);
  await expect(provider[method]([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
    { ...options, onPayload: () => ({ output_config: undefined }) })).rejects.toThrow(/reasoning/i);
  await expect(provider[method]([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
    { ...options, samplingParams: { output_config: undefined } })).rejects.toThrow(/reasoning/i);
  const format = { type: 'json_schema', schema: { type: 'object' } };
  const result = await provider[method]([{ role: 'user', content: 'hello' }], [], '', { effort: 'high' },
    { ...options, onPayload: () => ({ output_config: { format } }) });
  expect(sent.output_config).toEqual({ effort: 'high', format });
  expect(result.nativeHistory?.baseline?.effort).toBe('high'); expect(result.nativeHistory?.requested.effort).toBe('high');
  expect(onRequestPrepared).toHaveBeenCalledTimes(1);
});

it('rejects assistant prefill after restoring actual native history', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const fetch = vi.fn(async () => Response.json({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }));
  vi.stubGlobal('fetch', fetch);
  const provider = getProvider('anthropic'), options = { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096 };
  const input: KodaXMessage[] = [{ role: 'user', content: 'first' }];
  const first = await provider.complete(input, [], '', { effort: 'high' }, options);
  input.push({ role: 'assistant', content: first.contentBlocks!, nativeHistory: first.nativeHistory });
  await expect(provider.complete(input, [], '', { effort: 'high' }, options)).rejects.toThrow(/prefill/i);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('retains streamed server-tool arguments, citations and start-only tool inputs in native wire history', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const citation = { type: 'web_search_result_location', url: 'https://fixture.invalid', title: 'Fixture', encrypted_index: 'opaque', cited_text: 'evidence' };
  const blocks = [{ type: 'server_tool_use', id: 'server', name: 'web_search', input: {} },
    { type: 'text', text: 'Evidence', citations: [] }, { type: 'tool_use', id: 'local', name: 'read', input: { path: 'actual.txt' } }];
  vi.stubGlobal('fetch', async () => {
    const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      ...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block },
        ...(index === 0 ? [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"query":"evidence"}' } }] : []),
        ...(index === 1 ? [{ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }] : []),
        { type: 'content_block_stop', index }]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const result = await getProvider('anthropic').stream([{ role: 'user', content: 'inspect' }], [], '', { effort: 'high' },
    { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096 });
  expect(result.nativeHistory?.output).toMatchObject([
    { type: 'server_tool_use', input: { query: 'evidence' } }, { type: 'text', citations: [citation] }, { type: 'tool_use', input: { path: 'actual.txt' } },
  ]);
  expect(result.toolBlocks[0]?.input).toEqual({ path: 'actual.txt' });
});

it.each(['claude-sonnet-5-5', 'claude-haiku-5-5'])('keeps admitted images when %s changes thinking mode after restore', async modelOverride => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-native-mode-'));
  try {
    const image = path.join(directory, 'first.png'); await writeFile(image, imageBytes);
    vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ content: [{ type: 'thinking', thinking: 'old reasoning', signature: 'old-signature' }, { type: 'text', text: 'done' }], stop_reason: 'end_turn' });
    });
    const provider = getProvider('anthropic'), options = { modelOverride, maxOutputTokensOverride: 4096 };
    let input: KodaXMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', path: image }] }];
    const first = await provider.complete(input, [], '', { effort: 'high' }, options);
    input.push({ role: 'assistant', content: first.contentBlocks!, nativeHistory: first.nativeHistory }, { role: 'user', content: 'continue' });
    input = JSON.parse(JSON.stringify(input)) as KodaXMessage[]; await rm(image);
    const next = await provider.complete(input, [], '', { effort: 'high' }, { ...options,
      thinkingMode: modelOverride.includes('sonnet') ? 'between_tools' : 'disabled' });
    expect(JSON.stringify(requests[1]?.messages)).toContain(imageBytes.toString('base64'));
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('old-signature');
    expect(JSON.stringify(requests[1]?.messages)).toContain('old reasoning');
    expect(next.nativeHistory?.parent).toBeUndefined(); expect(next.nativeHistory?.baseline).toBeDefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
