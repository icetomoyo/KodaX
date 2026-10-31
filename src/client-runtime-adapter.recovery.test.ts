import { expect, it, vi } from 'vitest';
import type { KodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

it('rebinds trusted authority for the original Run without accepting Product authority or replaying input', async () => {
  const recover = vi.fn(async () => ({ runId: 'run', sessionId: 'session' }));
  const authorize = vi.fn(async () => ({ credential: { leaseId: 'fresh', mode: 'scoped' as const, providers: ['deepseek'] } }));
  const runtime = { identity: { runtimeId: 'host' }, runs: { get: async () => ({ sessionId: 'session' }), recover },
    sessions: { getSettings: async () => ({ provider: 'deepseek', model: 'larger', reasoningMode: 'deep' }) } } as unknown as KodaXRuntime;
  const client = toKodaXProductClient(runtime, authorize);
  const input = { sessionId: 'session', runId: 'run', authorization: { credential: { leaseId: 'forged' } }, options: { toolInvocation: { name: 'edit' } } };
  expect(await client.runs.recover(input)).toEqual({ runId: 'run', sessionId: 'session' });
  expect(authorize).toHaveBeenCalledWith({ kind: 'recovery', input: { sessionId: 'session', runId: 'run' } }, expect.objectContaining({ identity: runtime.identity, createExecutionProfile: expect.any(Function) }));
  expect(recover).toHaveBeenCalledWith({ runId: 'run', options: { provider: 'deepseek', model: 'larger', reasoningMode: 'deep' },
    authorization: { credential: { leaseId: 'fresh', mode: 'scoped', providers: ['deepseek'] } } });
  await expect(client.runs.recover({ sessionId: 'other', runId: 'run' })).rejects.toThrow(/Session/);
  expect(recover).toHaveBeenCalledTimes(1);
});

it('carries explicit independent Actor checkpoint resume through the trusted Product boundary', async () => {
  const followup = vi.fn(async () => ({ accepted: true }));
  const authorize = vi.fn(async () => ({ tools: ['read'] }));
  const runtime = { identity: { runtimeId: 'host' }, capabilities: { productExecutionProfile: { version: 2 } }, agents: { followup } } as unknown as KodaXRuntime;
  const client = toKodaXProductClient(runtime, authorize);
  await client.agents.followup('session', '/root/worker', '', { resumeCheckpoint: true, expectedRevision: 7 });
  expect(authorize).toHaveBeenCalledWith({ kind: 'agent_followup', input: { sessionId: 'session', actorPath: '/root/worker',
    objective: '', resumeCheckpoint: true, expectedRevision: 7 } }, expect.objectContaining({ identity: runtime.identity, createExecutionProfile: expect.any(Function) }));
  expect(followup).toHaveBeenCalledWith('session', '/root/worker', '', { resumeCheckpoint: true, expectedRevision: 7, authorization: { tools: ['read'] } });
});
