import { afterEach, expect, it, vi } from 'vitest';
import { getProvider } from './registry.js';
import { createCustomProvider } from './custom-provider.js';
import type { KodaXMessage, KodaXToolDefinition } from '../types.js';

interface WireRequest {
  stream?: boolean;
  tools?: { name: string; description: string; input_schema: unknown }[];
  messages: { role: string; content: string | Record<string, unknown>[] }[];
  tool_choice?: { type: string; name: string };
}

function tool(name: string): KodaXToolDefinition {
  return { name, description: `Read the ${name} capability.`, input_schema: { type: 'object', properties: {} } };
}

function response(request: WireRequest, content: Record<string, unknown>[]): Response {
  if (!request.stream) return Response.json({ id: 'offline', type: 'message', role: 'assistant', model: 'fixture',
    content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
  const events = [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [{ type: 'content_block_start', index,
      content_block: block.type === 'tool_use' ? { ...block, input: {} } : block },
      ...(block.type === 'tool_use' ? [{ type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }] : []),
      { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['stream', 'complete'] as const)('keeps native Ark tools callable through legal wire names in %s', async method => {
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  const sent: WireRequest[] = [];
  const input = { batch: 'a', note: 'catalog.scan-v2', nested: { name: 'catalog.scan-v2' } };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest; sent.push(request);
    return response(request, [{ type: 'text', text: 'before' },
      { type: 'tool_use', id: 'actual-call', name: request.tools![0]!.name, input }, { type: 'text', text: 'after' }]);
  });
  vi.stubGlobal('fetch', fetch);
  const definitions = [tool('catalog.scan-v2'), tool('catalog_scan-v2')];
  const before = structuredClone(definitions);
  const deltas = vi.fn();
  const result = await getProvider('ark-coding')[method]([{ role: 'user', content: 'Read the catalog.' }], definitions, 'fixture',
    { effort: 'high' }, { modelOverride: 'kimi-k2.7-code', maxOutputTokensOverride: 2048, singleAttempt: true, fetch, onToolInputDelta: deltas });
  expect(sent).toHaveLength(1);
  const wire = sent[0]!.tools!;
  expect(wire.map(item => item.name)).toEqual(expect.arrayContaining([expect.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)]));
  expect(wire.every(item => /^[A-Za-z0-9_-]{1,64}$/.test(item.name))).toBe(true);
  expect(wire[0]!.name).toContain('catalog_scan-v2');
  expect(wire[1]!.name).toBe('catalog_scan-v2');
  expect(wire[0]!.name).not.toBe(wire[1]!.name);
  expect(wire.map(({ description, input_schema }) => ({ description, input_schema })))
    .toEqual(definitions.map(({ description, input_schema }) => ({ description, input_schema })));
  expect(definitions).toEqual(before);
  expect(result.toolBlocks).toEqual([{ type: 'tool_use', id: 'actual-call', name: 'catalog.scan-v2', input }]);
  expect(result.contentBlocks?.map(block => block.type === 'tool_use' ? block.name : block.type === 'text' ? block.text : block.type))
    .toEqual(['before', 'catalog.scan-v2', 'after']);
  if (method === 'stream') expect(deltas).toHaveBeenCalledWith('catalog.scan-v2', JSON.stringify(input), { toolId: 'actual-call' });
});

it.each(['stream', 'complete'] as const)('maps forced and removed historical tools without editing canonical arguments in %s', async method => {
  vi.stubEnv('KODAX_TOOL_WIRE_FIXTURE', 'offline-fixture');
  const sent: WireRequest[] = [];
  const input = { name: 'catalog.scan-v2', query: { 'catalog.scan-v2': 'unchanged' } };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest; sent.push(request);
    return response(request, [{ type: 'tool_use', id: `call-${sent.length}`, name: request.tools![0]!.name, input }]);
  });
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider({ name: 'tool-name-wire-fixture', protocol: 'anthropic', model: 'wire-fixture',
    baseUrl: 'https://wire.invalid/v1', apiKeyEnv: 'KODAX_TOOL_WIRE_FIXTURE', supportsThinking: false });
  const messages: KodaXMessage[] = [{ role: 'user', content: 'Read the catalog.' }];
  const options = { maxOutputTokensOverride: 2048, singleAttempt: true, fetch };
  const first = await provider[method](messages, [tool('catalog.scan-v2')], '', false, { ...options, forcedToolName: 'catalog.scan-v2' });
  const firstAlias = sent[0]!.tools![0]!.name;
  expect(firstAlias).not.toBe('catalog.scan-v2');
  expect(sent[0]!.tool_choice).toEqual({ type: 'tool', name: firstAlias });
  messages.push({ role: 'assistant', content: first.contentBlocks! },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'catalog.scan-v2 stays in result text.' }] });
  const before = structuredClone(messages);
  await provider[method](messages, [tool('catalog.next-page')], '', false, { ...options, forcedToolName: 'catalog.next-page' });
  const secondAlias = sent[1]!.tools![0]!.name;
  expect(sent[1]!.tool_choice).toEqual({ type: 'tool', name: secondAlias });
  expect(secondAlias).not.toBe(firstAlias);
  const blocks = sent[1]!.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content);
  expect(blocks.find(block => block.type === 'tool_use')).toMatchObject({ name: firstAlias, input });
  expect(blocks.find(block => block.type === 'tool_result')?.content).toBe('catalog.scan-v2 stays in result text.');
  expect(messages).toEqual(before);
});

it.each(['stream', 'complete'] as const)('rejects a wire alias supplied as an undeclared canonical forced tool in %s', async method => {
  vi.stubEnv('KODAX_TOOL_WIRE_FIXTURE', 'offline-fixture');
  let alias = '';
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    alias = request.tools![0]!.name;
    return response(request, [{ type: 'text', text: 'done' }]);
  });
  vi.stubGlobal('fetch', fetch);
  const provider = createCustomProvider({ name: 'tool-name-wire-fixture', protocol: 'anthropic', model: 'wire-fixture',
    baseUrl: 'https://wire.invalid/v1', apiKeyEnv: 'KODAX_TOOL_WIRE_FIXTURE', supportsThinking: false });
  const options = { maxOutputTokensOverride: 2048, singleAttempt: true, fetch };
  await provider[method]([{ role: 'user', content: 'Read data.' }], [tool('catalog.scan-v2')], '', false, options);
  expect(alias).not.toBe('catalog.scan-v2');
  await expect(provider[method]([{ role: 'user', content: 'Read data.' }], [tool('catalog.scan-v2')], '', false,
    { ...options, forcedToolName: alias })).rejects.toMatchObject({ metadata: {
      failureCode: 'request_build_failed', stage: 'request_build', retryable: false,
    } });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['stream', 'complete'] as const)('keeps the existing Ark policy that ignores forced tool choice in %s', async method => {
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  const sent: WireRequest[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest; sent.push(request);
    return response(request, [{ type: 'text', text: 'done' }]);
  });
  vi.stubGlobal('fetch', fetch);
  await getProvider('ark-coding')[method]([{ role: 'user', content: 'Read data.' }], [tool('catalog.scan-v2')], '', { effort: 'high' },
    { modelOverride: 'kimi-k2.7-code', maxOutputTokensOverride: 2048, singleAttempt: true, fetch, forcedToolName: 'undeclared' });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.tool_choice).toBeUndefined();
});

it.each(['stream', 'complete'] as const)('keeps Unicode, long and alias-shaped canonical names distinct and menu-independent in %s', async method => {
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  const sent: WireRequest[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest; sent.push(request);
    return response(request, [{ type: 'text', text: 'done' }]);
  });
  vi.stubGlobal('fetch', fetch);
  const provider = getProvider('ark-coding');
  const options = { modelOverride: 'kimi-k2.7-code', maxOutputTokensOverride: 2048, singleAttempt: true, fetch };
  const names = ['read', 'valid-with-hyphen', '目录.读取', 'a'.repeat(65), 'catalog.scan-v2'];
  await provider[method]([{ role: 'user', content: 'Read data.' }], names.map(tool), '', { effort: 'high' }, options);
  const aliases = new Map(sent[0]!.tools!.map((definition, index) => [names[index]!, definition.name]));
  const aliasShapedName = aliases.get('catalog.scan-v2')!;
  await provider[method]([{ role: 'user', content: 'Read other data.' }], [aliasShapedName, ...names.toReversed()].map(tool), '', { effort: 'high' }, options);
  const wireNames = sent[1]!.tools!.map(definition => definition.name);
  expect(wireNames.every(name => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
  expect(new Set(wireNames).size).toBe(names.length + 1);
  expect(wireNames[0]).not.toBe(aliasShapedName);
  expect(wireNames.slice(1)).toEqual(names.toReversed().map(name => aliases.get(name)));
  expect(aliases.get('read')).toBe('read');
  expect(aliases.get('valid-with-hyphen')).toBe('valid-with-hyphen');
});

it.each(['stream', 'complete'] as const)('does not decode a previous request alias outside the current declaration and history in %s', async method => {
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  let alias = '';
  let calls = 0;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest;
    if (calls++ === 0) alias = request.tools![0]!.name;
    return response(request, [{ type: 'tool_use', id: `call-${calls}`, name: alias, input: { name: 'catalog.scan-v2' } }]);
  });
  vi.stubGlobal('fetch', fetch);
  const provider = getProvider('ark-coding');
  const options = { modelOverride: 'kimi-k2.7-code', maxOutputTokensOverride: 2048, singleAttempt: true, fetch };
  const first = await provider[method]([{ role: 'user', content: 'Read data.' }], [tool('catalog.scan-v2')], '', { effort: 'high' }, options);
  expect(first.toolBlocks[0]!.name).toBe('catalog.scan-v2');
  const next = await provider[method]([{ role: 'user', content: 'Different authorized tools.' }], [tool('other_tool')], '', { effort: 'high' }, options);
  expect(next.toolBlocks[0]!.name).toBe(alias);
  expect(next.toolBlocks[0]!.name).not.toBe('catalog.scan-v2');
});

it('rejects colliding transport identities before dispatch instead of merging authorized tools', async () => {
  vi.stubEnv('ARK_CODING_API_KEY', 'offline-fixture');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  // Distinct lone surrogates encode as the same UTF-8 replacement character.
  await expect(getProvider('ark-coding').complete([{ role: 'user', content: 'Read data.' }],
    [tool('scan.\ud800'), tool('scan.\ud801')], '', { effort: 'high' },
    { modelOverride: 'kimi-k2.7-code', maxOutputTokensOverride: 2048, singleAttempt: true, fetch }))
    .rejects.toMatchObject({ metadata: { failureCode: 'request_build_failed', stage: 'request_build', retryable: false } });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['stream', 'complete'] as const)('preserves native signed and opaque wire history while canonical names and menus change in %s', async method => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');
  const sent: WireRequest[] = [];
  const input = { name: 'catalog.scan-v2', query: 'original parameters' };
  const opaque = { type: 'server_tool_use', id: 'server-1', name: 'web_search', input: { query: 'opaque.name' }, opaque: 'keep' };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as WireRequest; sent.push(request);
    return response(request, sent.length === 1 ? [
      { type: 'thinking', thinking: 'signed reasoning', signature: 'opaque.signature' }, opaque,
      { type: 'tool_use', id: 'call-1', name: request.tools![0]!.name, input },
    ] : [{ type: 'text', text: 'done' }]);
  });
  vi.stubGlobal('fetch', fetch);
  const provider = getProvider('anthropic');
  const options = { modelOverride: 'claude-opus-5-5', maxOutputTokensOverride: 4096, singleAttempt: true, fetch };
  const messages: KodaXMessage[] = [{ role: 'user', content: 'Read data.' }];
  const first = await provider[method](messages, [tool('catalog.scan-v2')], '', { effort: 'high' }, options);
  const alias = sent[0]!.tools![0]!.name;
  expect(first.toolBlocks[0]!.name).toBe('catalog.scan-v2');
  expect(first.nativeHistory?.output).toContainEqual({ type: 'tool_use', id: 'call-1', name: alias, input });
  expect(first.nativeHistory?.output).toContainEqual(opaque);
  messages.push({ role: 'assistant', content: first.contentBlocks!, nativeHistory: first.nativeHistory },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }] });
  const before = JSON.stringify(messages);
  const next = await provider[method](messages, [tool(alias)], '', { effort: 'high' }, options);
  expect(next.nativeHistory?.parent).toBe(first.nativeHistory!.id);
  const blocks = sent[1]!.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content);
  expect(blocks).toContainEqual(opaque);
  expect(blocks).toContainEqual({ type: 'thinking', thinking: 'signed reasoning', signature: 'opaque.signature' });
  expect(blocks).toContainEqual({ type: 'tool_use', id: 'call-1', name: alias, input });
  expect(blocks).toContainEqual({ type: 'tool_removal', tool: { type: 'tool_reference', name: alias } });
  expect(blocks.some(block => block.type === 'tool_addition')).toBe(true);
  expect(JSON.stringify(messages)).toBe(before);
});
