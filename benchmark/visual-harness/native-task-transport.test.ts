import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeTaskTransport, type NativeTaskTransportInput } from './native-task-transport.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const endpoint = 'https://api.kimi.com/coding/v1/messages';
const payload = { model: 'kimi-for-coding', max_tokens: 32000, stream: true,
  thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'Read the image.' }] };
const request = (overrides: Record<string, unknown> = {}) => new Request(endpoint, { method: 'POST', headers: { 'x-api-key': 'test-secret-do-not-save', 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, ...overrides }) });

it('accounts a truncated optional episode review and allows the next independent main request in the same cell', async () => {
  let calls = 0; let notified = 0;
  const options = await input({ failurePolicy: 'r5-cell-isolated', onStop: () => { notified++; }, fetcher: async () => {
    calls++; return new Response(calls === 1 ? sse().replace('end_turn', 'max_tokens') : sse());
  } });
  const transport = await createNativeTaskTransport(options);
  const review = () => request({ max_tokens: 1200, tools: [{ name: 'commit_episode_learning_review' }] });
  try {
    await expect(transport.fetch(review())).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError', toolName: 'commit_episode_learning_review' });
    expect(notified).toBe(0);
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 180, stopped: false });
    expect(transport.getLedger().reservedTokens).toBeUndefined();
    expect(transport.getLedger().cells['L-B0']?.stopped).not.toBe(true);
    await expect(transport.fetch(review())).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
    expect(calls).toBe(1);
    await transport.fetch(request());
    expect(transport.getLedger()).toMatchObject({ calls: 2, accountedCalls: 2, tokens: 360, stopped: false });
  } finally { await transport.settle(); }
});

it.each(['report_stall_judgment', 'commit_episode_learning_review'].flatMap(toolName =>
  ['truncated', 'empty', 'malformed'].map(kind => ({ toolName, kind }))))(
  'retains actual usage for recoverable $toolName $kind responses', async ({ toolName, kind }) => {
    let calls = 0; let notified = 0;
    const raw = kind === 'truncated' ? sse().replace('end_turn', 'max_tokens') : kind === 'empty' ? sse(30, true, false)
      : JSON.stringify({ model: 'kimi-for-coding', stop_reason: 'tool_use',
        usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 30 },
        content: [{ type: 'tool_use', id: 'malformed', name: toolName, input: null }] });
    const options = await input({ failurePolicy: 'r5-cell-isolated', onStop: () => { notified++; }, fetcher: async () => new Response(++calls === 1 ? raw : sse()) });
    const transport = await createNativeTaskTransport(options);
    try {
      await expect(transport.fetch(request({ tools: [{ name: toolName }] }))).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError', toolName });
      await transport.fetch(request());
      expect(notified).toBe(0);
      expect(transport.getLedger()).toMatchObject({ calls: 2, accountedCalls: 2, tokens: 360, stopped: false });
      expect(transport.getLedger().reservedTokens).toBeUndefined();
      expect(transport.getLedger().cells['L-B0']?.auxiliaryFailures).toHaveLength(1);
    } finally { await transport.settle(); }
  });

it.each(['total-budget', 'cell-budget', 'wallet'] as const)('does not soften %s failure after a complete optional review usage', async boundary => {
  let observations = 0; let notified = 0;
  const options = await input({ failurePolicy: 'r5-cell-isolated', maxTotalTokens: boundary === 'total-budget' ? 180 : 1500000,
    maxCellTokens: boundary === 'cell-budget' ? 180 : 250000, onStop: () => { notified++; },
    spendObservation: { preflightEvidence: 'offline-wallet', read: async () => {
      if (++observations === 2 && boundary === 'wallet') throw new Error('wallet unavailable');
      return { currency: 'CNY', priceInCents: 0, configurationHash: 'stable' };
    } }, fetcher: async () => new Response(sse().replace('end_turn', 'max_tokens')) });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request({ tools: [{ name: 'commit_episode_learning_review' }] }))).rejects.not.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
    expect(notified).toBe(1);
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 180, stopped: boundary !== 'cell-budget' });
    expect(transport.getLedger().cells['L-B0']?.auxiliaryFailures).toBeUndefined();
  } finally { await transport.settle(); }
});

it('hard-stops an optional review that reports more output than its actual sent cap', async () => {
  let notified = 0;
  const options = await input({ failurePolicy: 'r5-cell-isolated', onStop: () => { notified++; }, fetcher: async () => new Response(sse(1201)) });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request({ max_tokens: 1200, tools: [{ name: 'commit_episode_learning_review' }] }))).rejects.toThrow('output token cap');
    expect(notified).toBe(1);
    expect(transport.getLedger()).toMatchObject({ accountedCalls: 1, tokens: 1351, cells: { 'L-B0': { stopped: true } } });
    expect(transport.getLedger().cells['L-B0']?.auxiliaryFailures).toBeUndefined();
  } finally { await transport.settle(); }
});

it('isolates an accounted truncated r5 cell without retrying it or stopping the next independent cell', async () => {
  const options = await input({ failurePolicy: 'r5-cell-isolated', fetcher: async () => new Response(sse().replace('end_turn', 'max_tokens')) });
  const failed = await createNativeTaskTransport(options);
  await expect(failed.fetch(request())).rejects.toThrow('Truncated');
  await expect(failed.fetch(request())).rejects.toThrow('Truncated');
  expect(failed.getLedger()).toMatchObject({ stopped: false, calls: 1, accountedCalls: 1, tokens: 180,
    cells: { 'L-B0': { stopped: true } } });
  await failed.settle();
  await expect(createNativeTaskTransport(options)).rejects.toThrow();
  const next = await createNativeTaskTransport({ ...options, cell: 'L-V', fetcher: async () => new Response(sse()) });
  try {
    await next.fetch(request());
    expect(next.getLedger()).toMatchObject({ calls: 2, accountedCalls: 2, tokens: 360, stopped: false });
  } finally { await next.settle(); }
});

it('reserves real initial input plus output cap after an uncooperative r5 timeout and observes spend before another cell', async () => {
  let observations = 0; let calls = 0;
  const options = await input({ failurePolicy: 'r5-cell-isolated', timeoutMs: 30,
    spendObservation: { preflightEvidence: 'offline-wallet', read: async () => {
      observations++; return { currency: 'CNY', priceInCents: 0, configurationHash: 'stable' };
    } },
    fetcher: async () => { calls++; return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(sse().split('\n\n')[0] + '\n\n:keepalive\n\n'));
    }, cancel() { return new Promise<void>(() => {}); } }), { headers: { 'content-type': 'text/event-stream' } }); } });
  const failed = await createNativeTaskTransport(options);
  await expect(failed.fetch(request())).rejects.toThrow();
  expect(failed.getLedger()).toMatchObject({ stopped: false, calls: 1, accountedCalls: 0, tokens: 0,
    reservedTokens: 4246, cells: { 'L-B0': { stopped: true, reservation: { inputTokens: 150, maxOutputTokens: 4096, totalTokens: 4246 } } } });
  expect(observations).toBe(2);
  await expect(failed.fetch(request())).rejects.toThrow(); expect(calls).toBe(1);
  await failed.settle();
  const next = await createNativeTaskTransport({ ...options, cell: 'L-V', fetcher: async () => new Response(sse()) });
  try {
    await next.fetch(request());
    expect(next.getLedger()).toMatchObject({ calls: 2, accountedCalls: 1, tokens: 180, reservedTokens: 4246, stopped: false });
    expect(observations).toBe(4);
  } finally { await next.settle(); }
});

it.each(['missing-input', 'wallet-unobservable', 'total-reservation'] as const)('keeps r5 %s failures global', async reason => {
  let observations = 0;
  const options = await input({ failurePolicy: 'r5-cell-isolated',
    maxTotalTokens: reason === 'total-reservation' ? 4246 : 1500000,
    spendObservation: { preflightEvidence: 'offline-wallet', read: async () => {
      observations++;
      if (reason === 'wallet-unobservable' && observations === 2) throw new Error('wallet unavailable');
      return { currency: 'CNY', priceInCents: 0, configurationHash: 'stable' };
    } }, fetcher: async () => new Response(reason === 'missing-input' ? ': keepalive\n\n' : sse(30, false)) });
  const failed = await createNativeTaskTransport(options);
  try {
    await expect(failed.fetch(request())).rejects.toThrow();
    expect(failed.getLedger()).toMatchObject({ stopped: true, tokens: 0, accountedCalls: 0 });
    if (reason !== 'missing-input') expect(failed.getLedger().reservedTokens).toBe(4246);
    await expect(failed.fetch(request())).rejects.toThrow();
    expect(failed.getLedger().calls).toBe(1);
  } finally { await failed.settle(); }
  await expect(createNativeTaskTransport({ ...options, cell: 'L-V' })).rejects.toThrow();
});

it.each(['cell-tokens', 'cell-calls', 'total-tokens', 'total-calls', 'metadata'] as const)('applies r5 %s stop at the correct scope', async boundary => {
  const options = await input({ failurePolicy: 'r5-cell-isolated',
    maxCellTokens: boundary === 'cell-tokens' ? 180 : 250000,
    maxCallsPerCell: boundary === 'cell-calls' ? 1 : 8,
    maxTotalTokens: boundary === 'total-tokens' ? 180 : 1500000,
    maxTotalCalls: boundary === 'total-calls' ? 1 : 58,
    maxMetadataRequests: boundary === 'metadata' ? 2 : 80 });
  const transport = await createNativeTaskTransport(options);
  try {
    if (boundary === 'metadata') {
      await transport.fetch('https://api.kimi.com/coding/v1/models');
      await transport.fetch('https://api.kimi.com/coding/v1/models');
      await expect(transport.fetch('https://api.kimi.com/coding/v1/models')).rejects.toThrow('Metadata');
    } else if (boundary.endsWith('calls')) {
      await transport.fetch(request());
      await expect(transport.fetch(request())).rejects.toThrow('Call budget');
    } else await expect(transport.fetch(request())).rejects.toThrow('Token budget');
    expect(transport.getLedger().stopped).toBe(!boundary.startsWith('cell-'));
  } finally { await transport.settle(); }
});

it('counts r5 reservations in later global token settlement without inflating actual usage', async () => {
  const options = await input({ failurePolicy: 'r5-cell-isolated', maxTotalTokens: 4400, fetcher: async () => new Response(sse(30, false)) });
  const failed = await createNativeTaskTransport(options);
  await expect(failed.fetch(request())).rejects.toThrow('Incomplete');
  await failed.settle();
  const next = await createNativeTaskTransport({ ...options, cell: 'L-V', fetcher: async () => new Response(sse()) });
  try {
    await expect(next.fetch(request())).rejects.toThrow('Token budget');
    expect(next.getLedger()).toMatchObject({ stopped: true, tokens: 180, reservedTokens: 4246, accountedCalls: 1 });
  } finally { await next.settle(); }
});

it('settles already received final usage as actual when the response body never closes', async () => {
  const options = await input({ failurePolicy: 'r5-cell-isolated', timeoutMs: 30, fetcher: async () => new Response(
    new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse())); } })) });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow();
    expect(transport.getLedger()).toMatchObject({ stopped: false, tokens: 180, accountedCalls: 1, cells: { 'L-B0': { stopped: true } } });
    expect(transport.getLedger().reservedTokens).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.http.json'), 'utf8')).usage.totalTokens).toBe(180);
  } finally { await transport.settle(); }
});

it('keeps a bounded cancelled production stall consult recoverable and blocks replay of that same consult', async () => {
  let calls = 0; let notified = 0;
  const controller = new AbortController();
  const options = await input({ failurePolicy: 'r5-cell-isolated', onStop: () => { notified++; }, fetcher: async () => {
    calls++;
    if (calls > 1) return new Response(sse());
    return new Response(new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode(sse().split('\n\n')[0] + '\n\n'));
      setTimeout(() => controller.abort(), 20);
    } }));
  } });
  const transport = await createNativeTaskTransport(options);
  const consult = () => request({ max_tokens: 1024, tools: [{ name: 'report_stall_judgment', input_schema: { type: 'object' } }] });
  try {
    await expect(transport.fetch(consult(), { signal: controller.signal })).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
    expect(notified).toBe(0);
    expect(transport.getLedger()).toMatchObject({ stopped: false, tokens: 0, reservedTokens: 1174 });
    expect(JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.request.json'), 'utf8')).max_tokens).toBe(1024);
    expect(transport.getLedger().cells['L-B0']?.stopped).not.toBe(true);
    await expect(transport.fetch(consult())).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
    expect(calls).toBe(1);
    await transport.fetch(request());
    expect(transport.getLedger()).toMatchObject({ calls: 2, accountedCalls: 1, tokens: 180, reservedTokens: 1174 });
  } finally { await transport.settle(); }
});

it('does not stop the main cell when the production stall timeout expires while still queued before dispatch', async () => {
  let calls = 0; let notified = 0;
  const controller = new AbortController();
  const options = await input({ failurePolicy: 'r5-cell-isolated', onStop: () => { notified++; }, fetcher: async () => {
    calls++; await new Promise(resolve => setTimeout(resolve, 50)); return new Response(sse());
  } });
  const transport = await createNativeTaskTransport(options);
  try {
    const main = transport.fetch(request());
    const auxiliary = transport.fetch(request({ max_tokens: 1024, tools: [{ name: 'report_stall_judgment' }] }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const results = await Promise.allSettled([main, auxiliary]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { name: 'NativeRecoverableAuxiliaryError' } });
    expect(calls).toBe(1); expect(notified).toBe(0);
    expect(transport.getLedger()).toMatchObject({ stopped: false, calls: 1, accountedCalls: 1 });
    expect(transport.getLedger().reservedTokens).toBeUndefined();
    await transport.fetch(request()); expect(calls).toBe(2);
  } finally { await transport.settle(); }
});

it.each(['unknown-tool', 'mixed-tools', 'background-learning', 'missing-input', 'total-budget'] as const)(
  'does not apply the recoverable stall exception to %s', async scenario => {
    let notified = 0;
    const controller = new AbortController();
    const names = scenario === 'unknown-tool' ? ['other_judge'] : scenario === 'mixed-tools' ? ['report_stall_judgment', 'todo_update']
      : scenario === 'background-learning' ? ['commit_episode_learning_review'] : ['report_stall_judgment'];
    const options = await input({ failurePolicy: 'r5-cell-isolated', maxTotalTokens: scenario === 'total-budget' ? 1174 : 1500000,
      onStop: () => { notified++; }, fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode(scenario === 'missing-input' ? ':keepalive\n\n' : sse().split('\n\n')[0] + '\n\n'));
        setTimeout(() => controller.abort(), 20);
      } })) });
    const transport = await createNativeTaskTransport(options);
    try {
      await expect(transport.fetch(request({ max_tokens: 1024, tools: names.map(name => ({ name })) }), { signal: controller.signal })).rejects.not.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
      expect(notified).toBe(1);
      expect(transport.getLedger().stopped).toBe(['missing-input', 'total-budget'].includes(scenario));
      expect(transport.getLedger().cells['L-B0']?.auxiliaryFailures).toBeUndefined();
    } finally { await transport.settle(); }
  });

it('keeps each distinct recoverable stall reservation and accumulates their budget without counting it as actual', async () => {
  let current = new AbortController();
  const options = await input({ failurePolicy: 'r5-cell-isolated', fetcher: async () => new Response(new ReadableStream<Uint8Array>({ start(stream) {
    stream.enqueue(new TextEncoder().encode(sse().split('\n\n')[0] + '\n\n'));
    setTimeout(() => current.abort(), 20);
  } })) });
  const transport = await createNativeTaskTransport(options);
  try {
    for (const content of ['first independent inspection', 'later independent inspection']) {
      current = new AbortController();
      await expect(transport.fetch(request({ max_tokens: 1024, tools: [{ name: 'report_stall_judgment' }],
        messages: [{ role: 'user', content }] }), { signal: current.signal })).rejects.toMatchObject({ name: 'NativeRecoverableAuxiliaryError' });
    }
    expect(transport.getLedger()).toMatchObject({ stopped: false, calls: 2, accountedCalls: 0, tokens: 0, reservedTokens: 2348 });
    expect(transport.getLedger().cells['L-B0']?.reservations).toHaveLength(2);
    expect(transport.getLedger().cells['L-B0']?.auxiliaryFailures).toHaveLength(2);
  } finally { await transport.settle(); }
});
function sse(output = 30, complete = true, visible = true): string {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', model: 'kimi-for-coding', usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Preserved reasoning.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-value' } },
    { type: 'content_block_stop', index: 0 },
    ...(visible ? [{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Completed.' } },
      { type: 'content_block_stop', index: 1 }] : []),
    { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 10 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
    ...(complete ? [{ type: 'message_stop' }] : []),
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
async function input(overrides: Partial<NativeTaskTransportInput> = {}): Promise<NativeTaskTransportInput> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-native-transport-test-')); directories.push(directory);
  return { directory, cell: 'L-B0', provider: 'kimi-code', model: 'kimi-for-coding', maxCallsPerCell: 8,
    maxTotalCalls: 58, maxCellTokens: 250000, maxTotalTokens: 1500000, maxOutputTokens: 4096, timeoutMs: 60000, maxSpendUsd: 6,
    spendControl: { preflightEvidence: 'offline fixture: subscription overage disabled', maxAdditionalSpendUsd: 0 },
    fetcher: async () => new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }), ...overrides };
}

it('preserves native SSE, thinking and credentials in transit while normalizing cache and cumulative usage once', async () => {
  let sent: Request | undefined;
  const options = await input({ fetcher: async (source, init) => { sent = new Request(source, init); return new Response(sse(), { headers: { 'content-type': 'text/event-stream' } }); } });
  const transport = await createNativeTaskTransport(options);
  try {
    expect(await (await transport.fetch(request())).text()).toBe(sse());
    expect(sent!.headers.get('x-api-key')).toBe('test-secret-do-not-save');
    expect(await sent!.json()).toEqual({ ...payload, max_tokens: 4096 });
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 180, spendUsd: null,
      cells: { 'L-B0': { calls: 1, tokens: 180 } } });
    const usage = JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.http.json'), 'utf8'));
    expect(usage.usage).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180, cachedReadTokens: 40, cachedWriteTokens: 10 });
    const files = await readdir(options.directory);
    for (const file of files.filter(file => !file.endsWith('.lock'))) expect(await readFile(path.join(options.directory, file), 'utf8')).not.toContain('test-secret-do-not-save');
    expect(JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.production.json'), 'utf8')).max_tokens).toBe(32000);
  } finally { await transport.settle(); }
});

it('latches an HTTP failure before native SDK retry and retains the failed raw response', async () => {
  let calls = 0; let stops = 0;
  const options = await input({ onStop: () => { stops++; }, fetcher: async () => { calls++; return new Response('provider unavailable', { status: 503 }); } });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow('503');
    await expect(transport.fetch(request())).rejects.toThrow('503');
    expect(calls).toBe(1); expect(stops).toBe(1);
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 0, stopped: true });
    expect(await readFile(path.join(options.directory, 'L-B0-1.response.txt'), 'utf8')).toBe('provider unavailable');
  } finally { await transport.settle(); }
});

it('does not turn incomplete SSE or missing usage into a zero-cost successful response', async () => {
  for (const raw of [sse(30, false), 'event: message_stop\ndata: {"type":"message_stop"}\n\n']) {
    const options = await input({ fetcher: async () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }) });
    const transport = await createNativeTaskTransport(options);
    try {
      await expect(transport.fetch(request())).rejects.toThrow(/Incomplete|usage/);
      expect(transport.getLedger()).toMatchObject({ accountedCalls: 0, stopped: true });
      expect(await readFile(path.join(options.directory, 'L-B0-1.response.txt'), 'utf8')).toBe(raw);
    } finally { await transport.settle(); }
  }
});

it('settles actual usage at a token boundary and blocks follow-up dispatch', async () => {
  let calls = 0;
  const options = await input({ maxCellTokens: 180, maxOutputTokens: 64, fetcher: async () => { calls++; return new Response(sse()); } });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow('Token budget');
    await expect(transport.fetch(request())).rejects.toThrow('Token budget');
    expect(calls).toBe(1); expect(transport.getLedger()).toMatchObject({ tokens: 180, accountedCalls: 1 });
  } finally { await transport.settle(); }
});

it('counts metadata separately, rejects untrusted origins and permits no redirect', async () => {
  let calls = 0;
  const options = await input({ fetcher: async (source, init) => { calls++; expect(new Request(source, init).redirect).toBe('error'); return Response.json({ data: [] }); } });
  const transport = await createNativeTaskTransport(options);
  try {
    await transport.fetch('https://api.kimi.com/coding/v1/models');
    expect(transport.getLedger()).toMatchObject({ calls: 0, metadata: 1 });
    await expect(transport.fetch('https://api.kimi.com.attacker.invalid/coding/v1/models')).rejects.toThrow('Unregistered');
    expect(calls).toBe(1);
  } finally { await transport.settle(); }
});

it('refuses unknown financial authority and reserves conservative request cost before paid dispatch', async () => {
  let calls = 0;
  const options = await input({ spendControl: undefined, fetcher: async () => { calls++; return new Response(sse()); } });
  const transport = await createNativeTaskTransport(options);
  try { await expect(transport.fetch(request())).rejects.toThrow('Spend control'); expect(calls).toBe(0); }
  finally { await transport.settle(); }
  const costly = await input({ spendControl: undefined, rates: { inputUsdPerMillion: 100, cacheReadUsdPerMillion: 100, cacheWriteUsdPerMillion: 100, outputUsdPerMillion: 100, source: 'frozen rate fixture' } });
  const priced = await createNativeTaskTransport(costly);
  try { await expect(priced.fetch(request())).rejects.toThrow('Spend budget'); expect(priced.getLedger().calls).toBe(0); }
  finally { await priced.settle(); }
});

it('locks each provider ledger and carries exact priced usage across sequential cells', async () => {
  const options = await input({ spendControl: undefined, rates: { inputUsdPerMillion: 1, cacheReadUsdPerMillion: 0.1, cacheWriteUsdPerMillion: 2, outputUsdPerMillion: 3, source: 'frozen rate fixture' } });
  const first = await createNativeTaskTransport(options);
  await expect(createNativeTaskTransport({ ...options, cell: 'L-V' })).rejects.toThrow(/EEXIST|locked/);
  await first.fetch(request()); await first.settle();
  const second = await createNativeTaskTransport({ ...options, cell: 'L-V' });
  try {
    await second.fetch(request());
    expect(second.getLedger()).toMatchObject({ calls: 2, accountedCalls: 2, tokens: 360 });
    expect(second.getLedger().spendUsd).toBeCloseTo(2 * (100 + 4 + 20 + 90) / 1000000);
  } finally { await second.settle(); }
});

it('requires terminal output usage rather than mistaking message_start zero for a final bill', async () => {
  const raw = sse().replace('"usage":{"output_tokens":30}', '"usage":{}');
  const options = await input({ fetcher: async () => new Response(raw) });
  const transport = await createNativeTaskTransport(options);
  try { await expect(transport.fetch(request())).rejects.toThrow('usage'); }
  finally { await transport.settle(); }
});

it('accepts JSON native messages and comment-prefixed SSE without changing protocol', async () => {
  const message = { model: 'kimi-for-coding', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }],
    usage: { input_tokens: 7, output_tokens: 3 } };
  for (const raw of [JSON.stringify(message), `: keepalive\n\n${sse()}`]) {
    const options = await input({ fetcher: async () => new Response(raw, { headers: { 'content-type': raw.startsWith(':') ? 'text/event-stream' : 'application/json' } }) });
    const transport = await createNativeTaskTransport(options);
    try { expect(await (await transport.fetch(request())).text()).toBe(raw); expect(transport.getLedger().accountedCalls).toBe(1); }
    finally { await transport.settle(); }
  }
});

it('counts a timed-out physical attempt and prevents SDK redispatch', async () => {
  let calls = 0;
  const options = await input({ timeoutMs: 5, fetcher: async (_source, init) => {
    calls++;
    await new Promise<void>((_resolve, reject) => { init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); });
    throw new Error('Unreachable');
  } });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow();
    await expect(transport.fetch(request())).rejects.toThrow();
    expect(calls).toBe(1); expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 0, stopped: true });
  } finally { await transport.settle(); }
});

it('enforces separate call and metadata ceilings before the next HTTP request', async () => {
  const options = await input({ maxCallsPerCell: 1, fetcher: async source => String(source).endsWith('/models') ? Response.json({ data: [] }) : new Response(sse()) });
  const transport = await createNativeTaskTransport(options);
  try {
    for (let index = 0; index < 80; index++) await transport.fetch('https://api.kimi.com/coding/v1/models');
    await transport.fetch(request());
    await expect(transport.fetch(request())).rejects.toThrow('Call budget');
    expect(transport.getLedger()).toMatchObject({ calls: 1, metadata: 80 });
  } finally { await transport.settle(); }
  const other = await input({ fetcher: async () => Response.json({ data: [] }) });
  const metadata = await createNativeTaskTransport(other);
  try {
    for (let index = 0; index < 80; index++) await metadata.fetch('https://api.kimi.com/coding/v1/models');
    await expect(metadata.fetch('https://api.kimi.com/coding/v1/models')).rejects.toThrow('Metadata budget');
    expect(metadata.getLedger().metadata).toBe(80);
  } finally { await metadata.settle(); }
});

it('settles an oversized output before refusing to deliver its tool proposal', async () => {
  const options = await input({ maxOutputTokens: 20 });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow('output token cap');
    expect(transport.getLedger()).toMatchObject({ accountedCalls: 1, tokens: 180, stopped: true });
  } finally { await transport.settle(); }
});

it('observes Kimi spend before and after generation without presenting the observation as exact fees or a hard cap', async () => {
  let reads = 0;
  const options = await input({ spendControl: undefined, maxSpendUsd: 1, spendObservation: {
    preflightEvidence: 'Account configuration frozen in host preflight JSON',
    read: async () => ({ currency: 'CNY', priceInCents: ++reads === 1 ? 100 : 200, configurationHash: 'frozen-cap-and-refill-settings' }),
  } });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow('Observed spend stop');
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, metadata: 2, spendUsd: null,
      observedSpendCny: 1, observedSpendConservativeUsd: 1, stopped: true });
  } finally { await transport.settle(); }
});

it('stops on changed account settings or a decreasing expense observation after retaining generation usage', async () => {
  for (const changed of [true, false]) {
    let reads = 0;
    const options = await input({ spendControl: undefined, spendObservation: {
      preflightEvidence: 'Account preflight', read: async () => ({ currency: 'CNY', priceInCents: ++reads === 1 ? 100 : changed ? 100 : 99,
        configurationHash: reads === 1 || !changed ? 'frozen' : 'changed' }),
    } });
    const transport = await createNativeTaskTransport(options);
    try {
      await expect(transport.fetch(request())).rejects.toThrow(/configuration changed|counter decreased/);
      expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, stopped: true, spendUsd: null });
    } finally { await transport.settle(); }
  }
});

it.each(['max_tokens', 'length', 'model_context_window_exceeded'])('settles truncated %s usage then blocks automatic continuation at the physical boundary', async stopReason => {
  let calls = 0;
  const raw = sse(4096).replace('"stop_reason":"end_turn"', `"stop_reason":"${stopReason}"`);
  const options = await input({ fetcher: async () => { calls++; return new Response(raw, { headers: { 'content-type': 'text/event-stream' } }); } });
  const transport = await createNativeTaskTransport(options);
  try {
    const production = { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } };
    await expect(transport.fetch(request(production))).rejects.toThrow('Truncated native response');
    await expect(transport.fetch(request(production))).rejects.toThrow('Truncated native response');
    expect(calls).toBe(1);
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 4246, stopped: true });
    expect(JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.production.json'), 'utf8'))).toMatchObject(production);
    expect(JSON.parse(await readFile(path.join(options.directory, 'L-B0-1.http.json'), 'utf8')).stopReason).toBe(stopReason);
    expect(await readFile(path.join(options.directory, 'L-B0-1.response.txt'), 'utf8')).toBe(raw);
  } finally { await transport.settle(); }
});

it.each(['empty', 'thinking-only'])('settles %s completion usage then blocks automatic empty-turn retries', async shape => {
  let calls = 0;
  const raw = shape === 'thinking-only' ? sse(30, true, false) : JSON.stringify({ model: 'kimi-for-coding', content: [],
    stop_reason: 'end_turn', usage: { input_tokens: 150, output_tokens: 30 } });
  const options = await input({ fetcher: async () => { calls++; return new Response(raw); } });
  const transport = await createNativeTaskTransport(options);
  try {
    await expect(transport.fetch(request())).rejects.toThrow('Empty native completion');
    await expect(transport.fetch(request())).rejects.toThrow('Empty native completion');
    expect(calls).toBe(1); expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 180, stopped: true });
  } finally { await transport.settle(); }
});

it.each(['broken-json', 'missing-input', 'missing-required'])('settles malformed %s tool response then blocks SDK repair', async shape => {
  let calls = 0;
  const tool = { type: 'tool_use', id: 'call-read', name: 'read', ...(shape === 'missing-input' ? {} : { input: {} }) };
  const raw = shape === 'broken-json' ? sse().replace('event: message_delta\n',
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 2, content_block: tool })}\n\n`
    + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } })}\n\n`
    + 'event: message_delta\n')
    : JSON.stringify({ model: 'kimi-for-coding', content: [tool], stop_reason: 'tool_use', usage: { input_tokens: 150, output_tokens: 30 } });
  const options = await input({ fetcher: async () => { calls++; return new Response(raw); } });
  const transport = await createNativeTaskTransport(options);
  const parameters = { tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] };
  try {
    await expect(transport.fetch(request(parameters))).rejects.toThrow('Malformed native tool');
    await expect(transport.fetch(request(parameters))).rejects.toThrow('Malformed native tool');
    expect(calls).toBe(1); expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 180, stopped: true });
  } finally { await transport.settle(); }
});

it('allows a valid native tool-only response as well as the existing text-only path', async () => {
  const raw = JSON.stringify({ model: 'kimi-for-coding', content: [{ type: 'tool_use', id: 'call-read', name: 'read', input: { path: 'report.pdf' } }],
    stop_reason: 'tool_use', usage: { input_tokens: 150, output_tokens: 30 } });
  const options = await input({ fetcher: async () => new Response(raw) });
  const transport = await createNativeTaskTransport(options);
  try { expect(await (await transport.fetch(request())).text()).toBe(raw); expect(transport.getLedger().stopped).toBe(false); }
  finally { await transport.settle(); }
});

it('enforces its deadline against an uncooperative keepalive stream and settles without waiting for cancel', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const options = await input({ timeoutMs: 25, fetcher: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"model":"kimi-for-coding","usage":{"input_tokens":100,"output_tokens":0}}}\n\n'));
      pulse = setInterval(() => controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')), 2);
    },
    cancel() { cancelled = true; clearInterval(pulse); return new Promise<void>(() => {}); },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  const transport = await createNativeTaskTransport(options);
  const pending = transport.fetch(request());
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([pending, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Test deadline escaped')), 250); })]))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true);
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 0, stopped: true });
    expect(await readFile(path.join(options.directory, 'L-B0-1.response.txt'), 'utf8')).toContain(': keep-alive');
    await expect(transport.fetch(request())).rejects.toThrow();
  } finally {
    clearTimeout(deadline); clearInterval(pulse);
    if (!cancelled) streamController?.close();
    await pending.catch(() => undefined);
    await transport.settle();
  }
}, 1500);

it('enforces its deadline before headers even when fetch ignores abort, and cancels a late response', async () => {
  let finishFetch: ((response: Response) => void) | undefined;
  let lateCancelled = false;
  const options = await input({ timeoutMs: 25, fetcher: async () => new Promise<Response>(resolve => { finishFetch = resolve; }) });
  const transport = await createNativeTaskTransport(options);
  const pending = transport.fetch(request());
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([pending, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Test deadline escaped')), 250); })]))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.getLedger()).toMatchObject({ calls: 1, accountedCalls: 0, stopped: true });
    await transport.settle();
  } finally {
    clearTimeout(deadline);
    let lateController: ReadableStreamDefaultController<Uint8Array> | undefined;
    finishFetch?.(new Response(new ReadableStream<Uint8Array>({ start(controller) { lateController = controller; }, cancel() { lateCancelled = true; } })));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!lateCancelled) lateController?.close();
    await pending.catch(() => undefined);
    await transport.settle();
  }
  expect(lateCancelled).toBe(true);
}, 1500);

it('also bounds a spend observation callback that ignores its signal', async () => {
  const options = await input({ timeoutMs: 25, spendControl: undefined, spendObservation: {
    preflightEvidence: 'frozen account', read: async () => new Promise(() => {}),
  } });
  const transport = await createNativeTaskTransport(options);
  const pending = transport.fetch(request());
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([pending, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Test deadline escaped')), 250); })]))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(transport.getLedger()).toMatchObject({ calls: 0, metadata: 1, stopped: true });
    await transport.settle();
  } finally { clearTimeout(deadline); }
}, 1000);
