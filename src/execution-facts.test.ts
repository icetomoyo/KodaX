import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { isRuntimeActorOwnerAlive } from './runtime-actor-owner-liveness.js';
import { createExecutionFactsStore } from './execution-facts.js';

vi.mock('./runtime-actor-owner-liveness.js', () => ({ isRuntimeActorOwnerAlive: vi.fn(async () => false) }));
const owner = { ownerId: 'owner', runtimeId: 'host-1', pid: 42, startedAt: new Date().toISOString() };
const request = { requestId: 'physical-request', logicalRequestId: 'logical', provider: 'fixture', purpose: 'primary' as const,
  attempt: 1, boundary: 'physical_attempt' as const, dispatch: 'dispatched' as const, state: 'started' as const, startedAt: new Date().toISOString() };
const target = { kind: 'run' as const, runId: 'run' };

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
