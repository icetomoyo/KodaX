import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskTransport } from './task-transport.js';

it('accounts actual usage and retains a failed request without retrying or dispatching another generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-transport-test-'));
  let generations = 0;
  const fetcher: typeof fetch = async source => {
    if (String(source).endsWith('/usages')) return Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } });
    generations++;
    if (generations === 2) return new Response('provider unavailable', { status: 503 });
    return Response.json({ model: 'kimi-for-coding', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } });
  };
  try {
    const transport = await createTaskTransport({ directory, cell: 'A-X', caseId: 'A', authorization: 'User approved this frozen batch.', apiKey: 'fixture-only', fetcher });
    const response = await transport.respond({ model: 'kimi-for-coding', messages: [], tools: [{ function: { name: 'todo_update' } }] });
    expect(response.usage).toEqual({ prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [], tools: [] })).rejects.toThrow('503');
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [], tools: [] })).rejects.toThrow();
    expect(generations).toBe(2);
    expect(JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))).toMatchObject({ calls: 2, accountedCalls: 1, tokens: 130, stopped: true });
    expect(await readFile(path.join(directory, 'A-X-2.response.txt'), 'utf8')).toBe('provider unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('preserves the provider failure when the ledger cannot be saved during error settlement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-ledger-save-failure-test-'));
  const fetcher: typeof fetch = async source => {
    if (String(source).endsWith('/usages')) return Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } });
    await rm(path.join(directory, 'ledger.json'));
    await mkdir(path.join(directory, 'ledger.json'));
    return new Response('provider unavailable', { status: 503 });
  };
  try {
    const transport = await createTaskTransport({ directory, cell: 'A-X', caseId: 'A', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    let failure: unknown;
    try { await transport.respond({ model: 'kimi-for-coding', messages: [] }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as unknown[];
    expect(String(errors[0])).toContain('Provider HTTP 503');
    expect(String(errors[1])).toContain('ledger.json');
    expect(await readFile(path.join(directory, 'A-X-1.response.txt'), 'utf8')).toBe('provider unavailable');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('checks the dedicated raw directory before issuing metadata or a generation', async () => {
  let http = 0;
  const fetcher: typeof fetch = async () => { http++; throw new Error('must not send'); };
  await expect(createTaskTransport({ directory: process.cwd(), cell: 'A-X', caseId: 'A', authorization: 'Approved.', apiKey: 'fixture', fetcher })).rejects.toThrow('OS Temp');
  expect(http).toBe(0);
});

it('stops on an invalid quota response before dispatching a model request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-quota-invalid-test-'));
  let generations = 0;
  const fetcher: typeof fetch = async source => {
    if (String(source).endsWith('/usages')) return Response.json({ booster_wallet: {} });
    generations++; throw new Error('must not send');
  };
  try {
    const transport = await createTaskTransport({ directory, cell: 'A-X', caseId: 'A', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow('spend observation unavailable');
    expect(generations).toBe(0);
    expect(transport.stopped).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('accounts a response but refuses its proposal when the observed spend stop is reached', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-wallet-stop-test-'));
  let quotas = 0; let generations = 0;
  const fetcher: typeof fetch = async source => {
    if (String(source).endsWith('/usages')) return Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: quotas++ ? '200' : '0' } } });
    generations++; return Response.json({ model: 'kimi-for-coding', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } });
  };
  try {
    const transport = await createTaskTransport({ directory, cell: 'A-X', caseId: 'A', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow('Conservative spend stop');
    expect(generations).toBe(1);
    expect(JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))).toMatchObject({ calls: 1, accountedCalls: 1, tokens: 130, stopped: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stops with unaccounted usage instead of presenting a missing provider usage as zero cost', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-missing-usage-test-'));
  let generations = 0;
  const fetcher: typeof fetch = async source => {
    if (String(source).endsWith('/usages')) return Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } });
    generations++; return Response.json({ model: 'kimi-for-coding', choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
  };
  try {
    const transport = await createTaskTransport({ directory, cell: 'A-X', caseId: 'A', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow('usage missing');
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow();
    expect(generations).toBe(1);
    const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')) as { calls: number; accountedCalls: number; stopped: boolean };
    expect(ledger).toMatchObject({ calls: 1, accountedCalls: 0, stopped: true });
    expect(ledger.accountedCalls === ledger.calls).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('settles the last actual usage and blocks its tool proposal when that request reaches the token stop', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-final-cap-test-'));
  let dispatched = 0;
  const fetcher: typeof fetch = async source => String(source).endsWith('/usages')
    ? Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } })
    : Response.json({ model: 'kimi-for-coding', choices: [{ message: { content: '', tool_calls: [{ id: 'act', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } });
  try {
    await writeFile(path.join(directory, 'ledger.json'), JSON.stringify({ calls: 20, accountedCalls: 20, tokens: 549_870, metadata: 25, stopped: false,
      firstWalletCents: 0, lastWalletCents: 0, cells: {} }));
    const transport = await createTaskTransport({ directory, cell: 'D-X', caseId: 'D', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] }).then(() => { dispatched++; })).rejects.toThrow('Token stop');
    expect(dispatched).toBe(0);
    expect(JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))).toMatchObject({ calls: 21, accountedCalls: 21, tokens: 550_000, stopped: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('preserves a partial response when its stream fails and never invents usage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-stream-test-'));
  const fetcher: typeof fetch = async source => String(source).endsWith('/usages')
    ? Response.json({ booster_wallet: { monthlyUsed: { currency: 'CNY', priceInCents: '0' } } })
    : new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      await new Promise(resolve => setTimeout(resolve, 5)); controller.error(new Error('stream interrupted'));
    } }));
  try {
    const transport = await createTaskTransport({ directory, cell: 'B-X', caseId: 'B', authorization: 'Approved.', apiKey: 'fixture', fetcher });
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow('stream interrupted');
    expect(await readFile(path.join(directory, 'B-X-1.response.txt'), 'utf8')).toBe('{"partial":');
    expect(JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'))).toMatchObject({ calls: 1, accountedCalls: 0, tokens: 0, stopped: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stops at the batch capacity before any HTTP and refuses to restart a used cell', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-task-capacity-test-'));
  let http = 0;
  const fetcher: typeof fetch = async () => { http++; throw new Error('must not contact provider'); };
  try {
    await writeFile(path.join(directory, 'ledger.json'), JSON.stringify({ calls: 26, accountedCalls: 26, tokens: 400_000, metadata: 30, stopped: false, cells: {} }));
    const input = { directory, cell: 'D-X', caseId: 'D' as const, authorization: 'Approved.', apiKey: 'fixture', fetcher };
    const transport = await createTaskTransport(input);
    await expect(transport.respond({ model: 'kimi-for-coding', messages: [] })).rejects.toThrow('budget');
    await expect(createTaskTransport(input)).rejects.toThrow('EEXIST');
    expect(http).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
