import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { KodaXOptions, KodaXResult, RunningSession } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const executor = vi.hoisted(() => ({
  start: vi.fn(),
  managed: vi.fn(),
  options: [] as KodaXOptions[],
}));
vi.mock('@kodax-ai/coding', async (original) => ({
  ...await original<typeof import('@kodax-ai/coding')>(),
  startKodaX: executor.start,
  runManagedTask: executor.managed,
}));

function fixtureSession(options: KodaXOptions, result: KodaXResult): RunningSession {
  executor.options.push(options);
  return {
    id: options.session!.id!,
    currentProvider: options.provider,
    currentModel: options.model,
    currentReasoning: options.reasoningMode,
    attached: true,
    aborted: false,
    setProvider() {},
    setModel() {},
    setReasoning() {},
    abort() {},
    result: Promise.resolve(result),
  };
}

it('FEATURE_298 T35 — runs.await resolves the terminal outcome over the product face and session settings carry maxIter', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-runs-await-'));
  const success: KodaXResult = {
    success: true, lastText: 'done', messages: [], sessionId: 'assigned-by-host',
  };
  executor.start.mockImplementation((options: KodaXOptions) =>
    fixtureSession(options, success));
  executor.managed.mockImplementation((options: KodaXOptions) => {
    executor.options.push(options);
    return Promise.resolve(success);
  });
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'await-provider' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated runs-await Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-runs-await-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { maxIter: 7 });
    expect((await client.sessions.getSettings(session.id)).maxIter).toBe(7);

    const accepted = await client.inputs.submit({
      sessionId: session.id, inputId: 'await-1', text: 'Complete now.',
    });
    expect(accepted.state).toBe('submitted');
    expect(accepted.runId).toBeDefined();

    const outcome = await client.runs.await(accepted.runId!);
    expect(outcome.phase).toBe('completed');
    expect(outcome.result).toMatchObject({ success: true, lastText: 'done' });
    expect(outcome.error).toBeUndefined();

    // The iteration fuse is session-run shaping: the Host must hand the
    // stored cap to the executor exactly like a per-run option did.
    expect(executor.options.at(-1)?.maxIter).toBe(7);

    await client.sessions.updateSettings(session.id, { maxIter: null });
    expect((await client.sessions.getSettings(session.id)).maxIter).toBeUndefined();

    await expect(client.runs.await('run_does_not_exist')).rejects.toThrow(
      'Runtime run not found',
    );
  } finally {
    await client.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
