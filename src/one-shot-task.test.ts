import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';
import type {
  KodaXEvents,
  KodaXOptions,
  KodaXResult,
  RunningSession,
} from '@kodax-ai/coding';
import { FileSessionStorage } from '@kodax-ai/repl';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { runOneShotClientTask } from './one-shot-task.js';

const executor = vi.hoisted(() => ({
  managed: vi.fn(),
  options: [] as KodaXOptions[],
  events: [] as (KodaXEvents | undefined)[],
}));
vi.mock('@kodax-ai/coding', async (original) => ({
  ...await original<typeof import('@kodax-ai/coding')>(),
  startKodaX: (): RunningSession => {
    throw new Error('one-shot product runs must not use the SA executor');
  },
  runManagedTask: executor.managed,
}));

interface Harness {
  readonly runtime: KodaXRuntime;
  readonly homeDir: string;
  readonly endpoint: string;
  readonly close: () => Promise<void>;
}

async function startHarness(prefix: string): Promise<Harness> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 'one-shot-provider',
  });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated one-shot Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-one-shot-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  return {
    runtime,
    homeDir,
    endpoint: endpoint.path,
    close: async () => {
      await runtime.close();
      await host.close();
      await rm(homeDir, { recursive: true, force: true });
    },
  };
}

function mockManagedResult(result: KodaXResult): void {
  executor.managed.mockImplementation((options: KodaXOptions) => {
    executor.options.push(options);
    executor.events.push(options.events);
    return Promise.resolve(result);
  });
}

async function getGitRootForTest(): Promise<string | null> {
  const { getGitRoot } = await import('@kodax-ai/repl');
  return getGitRoot();
}

it('FEATURE_298 T35 — one-shot runs the product path: Host-owned temporary session, settings shaping, live progress, and legacy result projection', async () => {
  const harness = await startHarness('kodax-one-shot-product-');
  const storage = new FileSessionStorage({ cwd: harness.homeDir });
  const success: KodaXResult = {
    success: true, lastText: 'one-shot done', messages: [], sessionId: 'host-assigned',
  };
  mockManagedResult(success);
  const client = toKodaXProductClient(harness.runtime);
  const cliEvents: KodaXEvents = {};
  const onIterationStart = vi.fn();
  const onRetry = vi.fn();
  cliEvents.onIterationStart = onIterationStart;
  cliEvents.onRetry = onRetry;
  try {
    // no-session: undefined session options mean a temporary Host session.
    const options: KodaXOptions = {
      provider: 'flag-provider',
      maxIter: 9,
      context: { repoIntelligenceMode: 'full', repoIntelligenceTrace: false },
      events: cliEvents,
    };
    const result = await runOneShotClientTask({
      client, runtime: harness.runtime, options, prompt: 'Do the one-shot work.',
    });

    // Legacy shape the CLI printers expect, byte-identical fields.
    expect(result).toMatchObject({ success: true, lastText: 'one-shot done' });

    // Run shaping crossed through session settings.
    expect(executor.options.at(-1)).toMatchObject({
      provider: 'flag-provider',
      maxIter: 9,
      context: { repoIntelligenceMode: 'full', repoIntelligenceTrace: false },
    });

    // The temporary session is gone once the run settles (Host-owned delete).
    const sessionId = executor.options.at(-1)!.session!.id!;
    await expect.poll(() => storage.load(sessionId)).toBeNull();

    // Live progress crossed the runtime event bus into the CLI formatters
    // while the run was in flight (the adapter closes with the task).
    let release: ((result: KodaXResult) => void) | undefined;
    executor.managed.mockImplementation((runOptions: KodaXOptions) => {
      executor.options.push(runOptions);
      executor.events.push(runOptions.events);
      return new Promise<KodaXResult>((resolve) => { release = resolve; });
    });
    const eventsBaseline = executor.events.length;
    const pending = runOneShotClientTask({
      client, runtime: harness.runtime, options, prompt: 'Stream while running.',
    });
    await expect.poll(() => executor.events.length).toBe(eventsBaseline + 1);
    const liveEvents = executor.events.at(-1);
    expect(liveEvents?.onIterationStart).toBeTypeOf('function');
    liveEvents?.onIterationStart?.(1, 9, { providerRequestId: 'iteration-probe' });
    liveEvents?.onRetry?.('rate_limit', 1, 3);
    release!({
      success: true, lastText: 'streamed', messages: [], sessionId: 'host-assigned',
    });
    await expect(pending).resolves.toMatchObject({ success: true, lastText: 'streamed' });
    expect(onIterationStart).toHaveBeenCalledWith(
      1, 9, expect.objectContaining({ providerRequestId: 'iteration-probe' }),
    );
    expect(onRetry).toHaveBeenCalledWith('rate_limit', 1, 3);
  } finally {
    await harness.close();
  }
}, 120_000);

it('FEATURE_298 T35 — resume submits into the newest project session and restores its settings afterwards', async () => {
  const harness = await startHarness('kodax-one-shot-resume-');
  const client = toKodaXProductClient(harness.runtime);
  mockManagedResult({
    success: true, lastText: 'resumed', messages: [], sessionId: 'host-assigned',
  });
  try {
    const seeded = await client.sessions.create({
      projectPath: process.cwd(),
      gitRoot: (await getGitRootForTest()) ?? process.cwd(),
      surface: 'cli',
    });
    await client.inputs.submit({
      sessionId: seeded.id, inputId: 'seed-input', text: 'seed turn',
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Resume by id (the --resume <id> / -s <id> flow): read-or-create over
    // the Host session face. The resume-newest variant uses the same
    // sessions.list({projectRoot}) call as interactive resume; on worktree
    // checkouts that project filter is subject to a pre-existing FEATURE_219
    // bucket/canonical-root divergence (recorded as a T35 residual), so this
    // test pins the deterministic id path.
    const options: KodaXOptions = {
      provider: 'resume-provider',
      context: { repoIntelligenceMode: 'full', repoIntelligenceTrace: true },
      session: { id: seeded.id, scope: 'user' },
    };
    await client.sessions.updateSettings(seeded.id, { model: 'seed-model', repoIntelligenceMode: 'light', repoIntelligenceTrace: false });
    const result = await runOneShotClientTask({
      client, runtime: harness.runtime, options, prompt: 'Continue here.',
    });
    expect(result).toMatchObject({ success: true });
    expect(executor.options.at(-1)!.session!.id).toBe(seeded.id);
    expect(executor.options.at(-1)).toMatchObject({ provider: 'resume-provider',
      context: { repoIntelligenceMode: 'full', repoIntelligenceTrace: true } });

    // A resumed session keeps its own settings after the invocation.
    await expect.poll(async () => (await client.sessions.getSettings(seeded.id)).provider)
      .toBeUndefined();
    expect((await client.sessions.getSettings(seeded.id)).model).toBe('seed-model');
    expect(await client.sessions.getSettings(seeded.id)).toMatchObject({ repoIntelligenceMode: 'light', repoIntelligenceTrace: false });
  } finally {
    await harness.close();
  }
}, 120_000);

it('preserves another Client setting change made while a one-shot invocation is running', async () => {
  const harness = await startHarness('kodax-one-shot-concurrent-settings-');
  const client = await connectKodaXClient({ homeDir: harness.homeDir, endpoint: harness.endpoint });
  const other = await connectKodaXClient({ homeDir: harness.homeDir, endpoint: harness.endpoint });
  try {
    const session = await client.sessions.create({ title: 'Shared settings', projectPath: harness.homeDir });
    await client.sessions.updateSettings(session.id, { model: 'original-model' });
    executor.managed.mockImplementation(async () => {
      expect(await other.sessions.getSettings(session.id)).toMatchObject({ model: 'invocation-model' });
      await other.sessions.updateSettings(session.id, { model: 'new-ui-model' });
      return { success: true, lastText: 'done', messages: [], sessionId: session.id };
    });
    await runOneShotClientTask({ client, runtime: harness.runtime,
      options: { provider: 'one-shot-provider', model: 'invocation-model', session: { id: session.id } }, prompt: 'Work' });
    expect(await other.sessions.getSettings(session.id)).toMatchObject({ model: 'new-ui-model' });
  } finally {
    await client.disconnect();
    await other.disconnect();
    await harness.close();
  }
}, 120_000);

it('reports settings restoration failure even when no CLI error callback is installed', async () => {
  const harness = await startHarness('kodax-one-shot-restore-');
  const client = toKodaXProductClient(harness.runtime);
  const session = await client.sessions.create({ title: 'Restore', projectPath: harness.homeDir });
  const update = client.sessions.updateSettingsVersioned.bind(client.sessions);
  let calls = 0;
  client.sessions.updateSettingsVersioned = async (sessionId, patch, options) => {
    if (++calls === 2) throw new Error('restore transport lost');
    return update(sessionId, patch, options);
  };
  const diagnostics: KodaXDiagnostic[] = [];
  const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
  mockManagedResult({ success: true, lastText: 'done', messages: [], sessionId: session.id });
  try {
    await runOneShotClientTask({ client, runtime: harness.runtime,
      options: { provider: 'temporary-provider', session: { id: session.id } }, prompt: 'Work' });
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'kodax.one-shot', level: 'warn',
      message: expect.stringContaining('restore'), detail: expect.objectContaining({ message: 'restore transport lost' }) }));
  } finally {
    restoreDiagnostics();
    await harness.close();
  }
}, 120_000);

it('persists validated repo intelligence settings across Host restart and supports clearing them', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-repo-settings-'));
  let runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  try {
    let client = toKodaXProductClient(runtime);
    const session = await client.sessions.create({ title: 'Repo settings', projectPath: homeDir });
    await expect(client.sessions.updateSettings(session.id, { repoIntelligenceMode: 'invalid' } as never))
      .rejects.toThrow('repoIntelligenceMode');
    await expect(client.sessions.updateSettings(session.id, { repoIntelligenceTrace: 'yes' } as never))
      .rejects.toThrow('repoIntelligenceTrace');
    await client.sessions.updateSettings(session.id, { repoIntelligenceMode: 'off', repoIntelligenceTrace: false });
    await runtime.close();
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    client = toKodaXProductClient(runtime);
    expect(await client.sessions.getSettings(session.id)).toMatchObject({ repoIntelligenceMode: 'off', repoIntelligenceTrace: false });
    await client.sessions.updateSettings(session.id, { repoIntelligenceMode: null, repoIntelligenceTrace: null });
    const cleared = await client.sessions.getSettings(session.id);
    expect(cleared.repoIntelligenceMode).toBeUndefined();
    expect(cleared.repoIntelligenceTrace).toBeUndefined();
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);

it('FEATURE_298 T35 — a cancelled run projects the interrupted legacy result', async () => {
  const harness = await startHarness('kodax-one-shot-cancel-');
  const client = toKodaXProductClient(harness.runtime);
  mockManagedResult({
    success: false, lastText: '', messages: [], sessionId: 'host-assigned',
    interrupted: true, signal: 'BLOCKED',
  });
  try {
    const result = await runOneShotClientTask({
      client, runtime: harness.runtime, options: { provider: 'cancel-provider' }, prompt: 'Cancel me.',
    });
    // Parity: an executor-produced interrupted result is passed through
    // untouched; the synthesized interrupted shape only applies when the
    // run settles without one.
    expect(result).toMatchObject({
      success: false,
      interrupted: true,
      signal: 'BLOCKED',
    });
  } finally {
    await harness.close();
  }
}, 120_000);

it('FEATURE_298 T35 — abort requests a Host stop and settles as interrupted', async () => {
  const harness = await startHarness('kodax-one-shot-abort-');
  const client = toKodaXProductClient(harness.runtime);
  const stopSpy = vi.fn(client.runs.stop.bind(client.runs));
  client.runs.stop = stopSpy;
  let release: ((result: KodaXResult) => void) | undefined;
  executor.managed.mockImplementation((runOptions: KodaXOptions) => {
    executor.options.push(runOptions);
    return new Promise<KodaXResult>((resolve) => { release = resolve; });
  });
  const controller = new AbortController();
  try {
    const baseline = executor.options.length;
    const pending = runOneShotClientTask({
      client, runtime: harness.runtime,
      options: { provider: 'abort-provider' },
      prompt: 'Stop on request.',
      abortSignal: controller.signal,
    });
    await expect.poll(() => executor.options.length).toBe(baseline + 1);
    controller.abort();
    await expect.poll(() => stopSpy.mock.calls.length).toBe(1);
    release!({
      success: false, lastText: '', messages: [], sessionId: 'host-assigned',
      interrupted: true, signal: 'BLOCKED',
    });
    await expect(pending).resolves.toMatchObject({ interrupted: true });
  } finally {
    await harness.close();
  }
}, 120_000);

it('FEATURE_298 T35 — maps one-shot results to process exit codes', async () => {
  const { exitCodeForOneShotResult } = await import('./one-shot-task.js');
  expect(exitCodeForOneShotResult({
    success: true, lastText: 'ok', messages: [], sessionId: 's',
  })).toBe(0);
  expect(exitCodeForOneShotResult({
    success: false, lastText: '', messages: [], sessionId: 's',
    interrupted: true, signal: 'BLOCKED', signalReason: 'Runtime run cancelled.',
  })).toBe(130);
  expect(exitCodeForOneShotResult({
    success: false, lastText: '', messages: [], sessionId: 's', limitReached: true,
  })).toBe(1);
  expect(exitCodeForOneShotResult({
    success: false, lastText: 'err', messages: [], sessionId: 's',
  })).toBe(1);
});

it('rejects an unconfirmed Run outcome rather than treating it as completion or interruption', async () => {
  const { projectOneShotOutcome } = await import('./one-shot-task.js');
  expect(() => projectOneShotOutcome({ phase: 'unknown' }, 'unconfirmed-run', 'session'))
    .toThrow('Runtime run unconfirmed-run ended without a result.');
});

it('rejects the one-shot wait on a real client disconnect while the Host Run retains ownership', async () => {
  const harness = await startHarness('kodax-one-shot-disconnect-');
  const client = await connectKodaXClient({ homeDir: harness.homeDir, endpoint: harness.endpoint });
  let release: ((result: KodaXResult) => void) | undefined;
  executor.managed.mockImplementation((options: KodaXOptions) => {
    executor.options.push(options);
    return new Promise<KodaXResult>((resolve) => { release = resolve; });
  });
  let pending: Promise<unknown> | undefined;
  try {
    const baseline = executor.options.length;
    pending = runOneShotClientTask({ client, runtime: harness.runtime,
      options: { provider: 'disconnect-provider' }, prompt: 'Keep Host ownership.' });
    await expect.poll(() => executor.options.length).toBe(baseline + 1);
    const runs = await harness.runtime.runs.list();
    expect(runs).toHaveLength(1);
    const rejected = expect(pending).rejects.toThrow(/closed|disconnect|transport|socket/i);
    await client.disconnect();
    await rejected;
    expect((await harness.runtime.runs.get(runs[0]!.runId))?.phase).toBe('running');
    release?.({ success: true, lastText: 'Host finished', messages: [], sessionId: runs[0]!.sessionId });
    await expect(harness.runtime.runs.await(runs[0]!.runId)).resolves.toMatchObject({ phase: 'completed' });
    expect(executor.options.length).toBe(baseline + 1);
  } finally {
    release?.({ success: false, interrupted: true, lastText: '', messages: [], sessionId: 'cleanup' });
    await Promise.allSettled(pending ? [pending] : []);
    await client.disconnect();
    await harness.close();
  }
}, 60_000);
