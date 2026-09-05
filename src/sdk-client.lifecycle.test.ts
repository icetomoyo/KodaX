import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import type { AgentExecutorFactory, ExternalAgentRegistration } from '@kodax-ai/agent';

import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import {
  readRuntimeOwnerPolicy,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './runtime-daemon/state.js';

it('accepts an idle Host shutdown without changing its owner mode', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-lifecycle-'));
  const profile = 'lifecycle';
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir, profile);
  try {
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the isolated lifecycle Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-lifecycle-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        await expect(client.host.shutdown()).resolves.toEqual({ accepted: true });
        await host.closed;
        await expect(runtime.sessions.list()).rejects.toThrow('closed');
        expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
      } finally {
        await client.disconnect();
      }
    } finally {
      await host.close();
    }
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('reports a busy Host and lets another client observe work after the submitting client detaches', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-detach-'));
  const finished = deferred();
  const working = deferred();
  registerModelProvider('lifecycle-test', () => new LifecycleProvider(working.resolve, finished.promise));
  vi.stubEnv('KODAX_LIFECYCLE_TEST_KEY', 'test-only');
  const profile = 'detach';
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true, defaultProvider: 'lifecycle-test' });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the isolated detach Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-detach-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const options = { homeDir, profile, endpoint: endpoint.path };
      const first = await connectKodaXClient(options);
      const second = await connectKodaXClient(options);
      try {
        const session = await first.sessions.create({ title: 'Background work', projectPath: homeDir });
        await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
        const views: ClientSessionView[] = [];
        const observation = await second.sessions.observe(session.id, (view) => views.push(view));
        try {
          await first.inputs.submit({ sessionId: session.id, inputId: 'keep-working', text: 'Continue until finished.' });
          await working.promise;
          await expect(first.host.shutdown()).rejects.toMatchObject({ code: 'busy' });
          await first.disconnect();
          await expect(second.sessions.read(session.id)).resolves.toMatchObject({ title: 'Background work' });
          await expect(second.host.shutdown()).rejects.toMatchObject({ code: 'busy' });
          finished.resolve();
          await expect.poll(() => views.at(-1)?.runs[0]?.phase).toBe('completed');
          await expect(second.host.shutdown()).resolves.toEqual({ accepted: true });
          await host.closed;
          expect(readRuntimeOwnerPolicy(paths).mode).toBe('daemon');
        } finally {
          observation.close();
        }
      } finally {
        finished.resolve();
        await Promise.all([first.disconnect(), second.disconnect()]);
      }
    } finally {
      finished.resolve();
      await host.close();
    }
  } finally {
    finished.resolve();
    await runtime.close();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

class LifecycleProvider extends KodaXBaseProvider {
  readonly name = 'lifecycle-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_LIFECYCLE_TEST_KEY', model: 'lifecycle-test', supportsThinking: false,
  };
  constructor(private readonly started: () => void, private readonly finished: Promise<void>) { super(); }
  async stream(): Promise<KodaXStreamResult> {
    this.started();
    await this.finished;
    return {
      textBlocks: [{ type: 'text', text: 'Background work completed.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

it('acknowledges shutdown while the Host still owns cleanup of its actual executor helper', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-helper-'));
  const cleanup = deferred();
  const disposing = deferred();
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<unknown> | undefined;
  const factory: AgentExecutorFactory = {
    executorId: 'lifecycle-helper', protocol: 'http',
    async create() {
      const helper = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); process.stdin.resume();'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = helper;
      exited = once(helper, 'exit');
      await once(helper.stdout, 'data');
      return {
        async start() { return { idempotencyKey: 'one-helper-task' }; },
        async *events() { yield { state: 'completed' as const, output: 'Helper task completed.' }; },
        async get() { return { state: 'completed' }; },
        async sendInput() {},
        async cancel() { return { state: 'completed' }; },
        async reconcile() { return { state: 'completed' }; },
        async dispose() {
          disposing.resolve();
          await cleanup.promise;
          helper.stdin.end();
          await exited;
        },
      };
    },
  };
  const registration: ExternalAgentRegistration = {
    agentId: 'external:lifecycle-helper', displayName: 'Lifecycle helper', enabled: true,
    executorId: factory.executorId, protocol: factory.protocol,
    configurationRevision: 'one', endpointIdentityHash: 'sha256:lifecycle-helper', executorConfig: {},
    capabilities: {
      streaming: 'supported', durableTasks: 'supported', inputRequired: 'unsupported',
      cancellation: 'supported', artifacts: 'unsupported',
    },
    effects: { remote: 'read', workspace: 'proposal' },
  };
  const profile = 'helper';
  const runtime = await createKodaXRuntime({
    homeDir, profile, sharedDaemonHost: true,
    externalAgents: { factories: [factory], policy: async () => ({ allowed: true }) },
  });
  try {
    await runtime.admin.agentRegistrations.upsert(registration);
    const session = await runtime.sessions.create({ title: 'Helper owner' });
    const task = await runtime.agents.spawn(session.id, {
      taskName: 'helper', kind: 'external', objective: 'Use one actual helper.',
      metadata: { agentId: registration.agentId },
    });
    await expect.poll(async () => (await runtime.agents.output(session.id, '/root/helper', task.turnId)).state)
      .toBe('completed');
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire the isolated helper Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-helper-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        await expect(client.host.shutdown()).resolves.toEqual({ accepted: true });
        await disposing.promise;
        expect(child?.exitCode).toBeNull();
        if (child?.pid === undefined) throw new Error('Executor helper never started.');
        expect(() => process.kill(child!.pid!, 0)).not.toThrow();
        cleanup.resolve();
        await host.closed;
        expect(child.exitCode).toBe(0);
      } finally {
        cleanup.resolve();
        await client.disconnect();
      }
    } finally {
      cleanup.resolve();
      await host.close();
    }
  } finally {
    cleanup.resolve();
    await runtime.close();
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => { throw new Error('Deferred promise was not initialized'); };
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}
