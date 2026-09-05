import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import type { KodaXOptions, KodaXResult, RunningSession } from '@kodax-ai/coding';
import { FileSessionStorage } from '@kodax-ai/repl';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const executor = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@kodax-ai/coding', async (original) => ({
  ...await original<typeof import('@kodax-ai/coding')>(), startKodaX: executor.start,
}));

it('keeps an unconfirmed temporary task until its executor settles and reports late cleanup failure after Host close', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-late-cleanup-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions') });
  let finish: ((result: KodaXResult) => void) | undefined;
  const execution = new Promise<KodaXResult>((resolve) => { finish = resolve; });
  let aborted = false;
  executor.start.mockImplementation((options: KodaXOptions): RunningSession => ({
    id: options.session!.id!, currentProvider: options.provider, currentModel: options.model,
    currentReasoning: options.reasoningMode, attached: true,
    get aborted() { return aborted; },
    setProvider() {}, setModel() {}, setReasoning() {},
    // This public executor port cannot confirm cancellation until its result arrives.
    abort() { aborted = true; },
    result: execution,
  }));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'late-executor' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated late-cleanup Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-late-cleanup-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  const diagnostics: KodaXDiagnostic[] = [];
  const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const session = await client.sessions.create({ projectPath: homeDir, temporary: true });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'late-result', text: 'Finish when possible.' });
    const result = runtime.runs.await(accepted.runId!);
    await host.close();
    expect(aborted).toBe(true);
    await expect(result).resolves.toMatchObject({ phase: 'unknown' });
    expect((await storage.load(session.id))?.runtimeInfo?.temporary).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.source === 'runtime.temporary-session')).toBe(false);

    finish!({ success: false, interrupted: true, lastText: '', messages: [], sessionId: session.id });
    await expect.poll(() => ({
      diagnostic: diagnostics.find((diagnostic) => diagnostic.source === 'runtime.temporary-session'),
      unhandled,
    }), {
      timeout: 3_000,
    }).toMatchObject({
      diagnostic: {
        level: 'error', message: `Temporary Session cleanup failed: ${session.id}`,
        detail: expect.objectContaining({ message: 'KodaX runtime is closed' }),
      },
      unhandled: [],
    });
    // Node reports unhandled rejection after the microtask queue drains.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
    expect((await storage.load(session.id))?.runtimeInfo?.temporary).toBe(true);
  } finally {
    finish?.({ success: false, interrupted: true, lastText: '', messages: [], sessionId: 'fixture-cleanup' });
    await client.disconnect();
    await host.close();
    await runtime.close();
    process.off('unhandledRejection', onUnhandled);
    restoreDiagnostics();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 15_000);
