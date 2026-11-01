import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { isRuntimeActorOwnerAlive } from './runtime-actor-owner-liveness.js';
import { createExecutionFactsStore } from './execution-facts.js';
import { observeProviderOperation, runWithProviderRequestObserver } from '../packages/llm/src/provider-request-observation.js';

vi.mock('./runtime-actor-owner-liveness.js', () => ({ isRuntimeActorOwnerAlive: vi.fn(async () => false) }));
const owner = { ownerId: 'owner', runtimeId: 'host-1', pid: 42, startedAt: new Date().toISOString() };
const request = { requestId: 'physical-request', logicalRequestId: 'logical', provider: 'fixture', purpose: 'primary' as const,
  attempt: 1, boundary: 'physical_attempt' as const, dispatch: 'dispatched' as const, state: 'started' as const, startedAt: new Date().toISOString() };
const target = { kind: 'run' as const, runId: 'run' };

it('expires pagination across a reconstructed projection instead of skipping or repeating concurrent rows', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-cursor-'));
  try {
    const writer = createExecutionFactsStore(dir, owner);
    for (const requestId of ['a', 'b', 'c']) writer.provider('session', target, { ...request, requestId, state: 'succeeded' });
    const page = await writer.service.readRequests('session', { limit: 1 });
    expect((await writer.service.readRequests('session', { limit: 1, cursor: page.nextCursor })).items[0]?.requestId).toBe('b');
    await expect(createExecutionFactsStore(dir, owner).service.readRequests('session', { limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ code: 'conflict' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('keeps growing observation writes linear and isolates storage roots', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-growth-'));
  let written = 0;
  const write = fs.writeFileSync.bind(fs);
  const append = fs.appendFileSync.bind(fs);
  const writing = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    written += Buffer.byteLength(data.toString()); return write(file, data, options);
  });
  const appending = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, data, options) => {
    written += Buffer.byteLength(data.toString()); return append(file, data, options);
  });
  const reading = vi.spyOn(fs, 'readSync');
  try {
    const store = createExecutionFactsStore(dir, owner, path.join(dir, 'sessions-a'));
    store.created('session');
    for (let index = 0; index < 250; index += 1) store.provider('session', target,
      { ...request, requestId: `request-${index}`, state: 'succeeded', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
    expect(written).toBeLessThan(1_500_000);
    expect(reading).not.toHaveBeenCalled();
    const other = createExecutionFactsStore(dir, owner, path.join(dir, 'sessions-b'));
    expect((await other.service.read('session')).requestCount).toBe(0);
    const reopened = createExecutionFactsStore(dir, owner, path.join(dir, 'sessions-a'));
    expect(await reopened.service.read('session')).toMatchObject({ requestCount: 250, usage: { totalTokens: 750 } });
  } finally { writing.mockRestore(); appending.mockRestore(); reading.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});

it('keeps concurrent completion order out of the request predecessor chain', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-order-'));
  try {
    const store = createExecutionFactsStore(dir, owner);
    for (const id of ['a', 'b']) store.provider('session', target, { ...request, requestId: id });
    store.provider('session', target, { ...request, requestId: 'a', state: 'succeeded' });
    store.provider('session', target, { ...request, requestId: 'c' });
    vi.mocked(isRuntimeActorOwnerAlive).mockResolvedValueOnce(true);
    expect((await store.service.readRequests('session')).items.find(row => row.requestId === 'c')?.previousRequestId).toBe('b');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('retires a short-written journal without truncating it and resumes collecting new facts', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-short-write-'));
  const append = fs.appendFileSync.bind(fs);
  try {
    const store = createExecutionFactsStore(dir, owner); store.created('session');
    const fault = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce((file, data, options) => {
      append(file, data.toString().slice(0, 9), options); throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    store.provider('session', target, { ...request, requestId: 'torn', state: 'succeeded' }); fault.mockRestore();
    for (const requestId of ['after', 'following']) store.provider('session', target, { ...request, requestId, state: 'succeeded' });
    expect(await store.service.read('session')).toMatchObject({ requestCount: 2, coverage: 'partial' });
    expect((await createExecutionFactsStore(dir, owner).service.readRequests('session')).items.map(row => row.requestId)).toEqual(['after', 'following']);
  } finally { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }
});

it('recovers healthy journal lanes after an invalid lane is explicitly isolated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-lanes-'));
  try {
    const first = createExecutionFactsStore(dir, owner);
    const second = createExecutionFactsStore(dir, { ...owner, runtimeId: 'second' });
    for (const [store, id] of [[first, 'a'], [second, 'b'], [first, 'c']] as const) store.provider('session', target,
      { ...request, requestId: id, state: 'succeeded', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
    const folder = (await readdir(path.join(dir, 'execution-facts', 'v2'), { recursive: true }))
      .find(name => name.endsWith('.jsonl'))!;
    const bad = path.join(dir, 'execution-facts', 'v2', path.dirname(folder), 'ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl');
    await writeFile(bad, '{broken}\n');
    const reader = createExecutionFactsStore(dir, owner);
    expect((await reader.service.read('session')).coverage).toBe('partial');
    await rm(bad);
    expect(await reader.service.read('session')).toMatchObject({ requestCount: 3, coverage: 'partial', usage: { totalTokens: 9 } });
    const rows = await reader.service.readRequests('session'); Object.assign(rows.items[0]!, { state: 'failed' });
    expect((await reader.service.readRequests('session')).items.every(row => row.state === 'succeeded')).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['{broken', JSON.stringify({ version: 99, sessionId: 'session' }),
  JSON.stringify({ version: 1, sessionId: 'session', revision: 1, coverage: 'complete', issues: [], owners: { bad: null }, requests: [null], tools: [], contexts: [] }),
  JSON.stringify({ version: 1, sessionId: 'session', revision: 1, coverage: 'complete', issues: [], owners: {}, requests: [{ ...request, usage: { inputTokens: 'wrong', outputTokens: 1 } }], tools: [], contexts: [] }),
])('keeps inference usable and statistics partial while retaining unreadable facts: %s', async bytes => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-facts-corrupt-'));
  const folder = path.join(dir, 'execution-facts');
  const name = `${createHash('sha256').update('session').digest('hex')}.json`;
  await mkdir(folder); await writeFile(path.join(folder, name), bytes);
  const operation = vi.fn(async () => ({ content: 'done' }));
  try {
    const store = createExecutionFactsStore(dir, owner);
    await expect(runWithProviderRequestObserver(fact => store.provider('session', target, fact), () =>
      observeProviderOperation('fixture', 'primary', undefined, operation))).resolves.toMatchObject({ content: 'done' });
    expect(operation).toHaveBeenCalledOnce();
    expect(await store.service.read('session')).toMatchObject({ coverage: 'partial' });
    expect((await store.service.read('session')).issues.length).toBeGreaterThan(0);
    const copies = await Promise.all((await readdir(folder)).map(file => readFile(path.join(folder, file), 'utf8')));
    expect(copies).toContain(bytes);
    if (bytes.includes('99')) expect(await readFile(path.join(folder, name), 'utf8')).toBe(bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('keeps a native provisional boundary distinct and becomes complete when the first wire arrives', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-fact-native-boundary-'));
  try {
    const store = createExecutionFactsStore(dir, owner);
    store.created('session');
    store.provider('session', target, { ...request, boundary: 'provider_operation', dispatch: 'unknown', wireObservation: 'pending' });
    vi.mocked(isRuntimeActorOwnerAlive).mockResolvedValueOnce(true);
    expect((await store.service.read('session')).coverage).toBe('complete');
    store.provider('session', target, { ...request, wireObservation: 'observed', state: 'succeeded', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
    expect(await store.service.read('session')).toMatchObject({ coverage: 'complete', operationCount: 0, physicalRequestCount: 1, issues: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reports partial physical coverage for an adapter operation lost during a crash', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-fact-operation-'));
  try {
    const store = createExecutionFactsStore(dir, owner);
    store.created('session');
    store.provider('session', target, { ...request, boundary: 'provider_operation', dispatch: 'unknown' });
    expect(await store.service.read('session')).toMatchObject({ coverage: 'partial', operationCount: 1, physicalRequestCount: 0, requestsWithoutUsage: 1 });
    expect((await store.service.readRequests('session')).items[0]).toMatchObject({ state: 'unknown', boundary: 'provider_operation' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('persists partial stream usage while keeping the complete task bill explicitly unknown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-fact-partial-stream-'));
  try {
    const store = createExecutionFactsStore(dir, owner);
    store.created('session');
    store.provider('session', target, { ...request, state: 'cancelled',
      partialUsage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } });
    expect((await store.service.readRequests('session')).items[0]).toMatchObject({ state: 'cancelled',
      partialUsage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } });
    expect(await store.service.read('session')).toMatchObject({ requestsWithoutUsage: 1, usage: { totalTokens: 0 } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('recovers unknown executions, retains actual sandbox observations and counts stable request usage once', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-fact-recovery-'));
  try {
    const previous = createExecutionFactsStore(dir, owner);
    previous.created('session'); previous.provider('session', target, request);
    previous.tool('session', target, 'tool-execution', 'provider-tool-id', 'bash', { state: 'executing',
      observation: { version: 1, state: 'fallback', reason: 'backend_failed', execution: 'normal_permission_policy' } });
    const current = createExecutionFactsStore(dir, { ...owner, runtimeId: 'host-2' });
    expect((await current.service.readRequests('session')).items[0]).toMatchObject({ requestId: request.requestId, state: 'unknown', recovery: 'outcome_unknown' });
    expect((await current.service.readTools('session')).items[0]).toMatchObject({ state: 'unknown',
      sandbox: [{ state: 'fallback', reason: 'backend_failed' }] });
    for (let index = 0; index < 2; index += 1) previous.provider('session', target, { ...request, state: 'succeeded',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedReadTokens: 2 } });
    expect(await current.service.read('session')).toMatchObject({ requestCount: 1, physicalRequestCount: 1, operationCount: 0,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 2 } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('preserves a terminal fact saved while an owner recovery probe is pending', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-fact-probe-'));
  let finish!: (alive: boolean) => void;
  vi.mocked(isRuntimeActorOwnerAlive).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    const store = createExecutionFactsStore(dir, owner);
    store.created('session'); store.provider('session', target, request);
    const reading = store.service.readRequests('session');
    store.provider('session', target, { ...request, state: 'succeeded', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } });
    finish(false);
    expect((await reading).items[0]).toMatchObject({ state: 'succeeded', usage: { inputTokens: 4 } });
    expect((await store.service.read('session')).usage.totalTokens).toBe(5);
  } finally { finish?.(false); await rm(dir, { recursive: true, force: true }); }
});
