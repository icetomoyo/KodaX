import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  KodaXRuntime,
  RuntimeCompactSessionResult,
  RuntimeRunResult,
  RuntimeStartRunInput,
} from '../sdk-runtime.js';
import { createRuntimeDaemonClient } from './client.js';
import { acquireRuntimeDaemonLease } from './manager.js';
import {
  readRuntimeDaemonLockOwner,
  readRuntimeDaemonState,
  readRuntimeDaemonToken,
  resolveRuntimeDaemonPaths,
  tryAcquireRuntimeDaemonLock,
} from './state.js';
import type { RuntimeDaemonEndpoint } from './transport.js';

const tempRoots: string[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  const tasks = cleanupTasks.splice(0);
  await Promise.allSettled(tasks.map((task) => task()));
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime daemon lease manager', () => {
  it('attaches without constructing a second Runtime owner', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    const firstLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (runtimeId) => makeRuntime(runtimeId),
    });
    let candidateCalls = 0;
    const secondLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (runtimeId) => {
        candidateCalls += 1;
        return makeRuntime(runtimeId);
      },
    });
    cleanupTasks.push(async () => {
      await secondLease.close();
      await firstLease.close();
      await firstLease.shutdown();
    });

    expect(secondLease.ownsHost).toBe(false);
    expect(candidateCalls).toBe(0);
  });

  it('shares attached shutdown and keeps its transport open for retry', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    const ownerLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (runtimeId) => makeRuntime(runtimeId),
    });
    const attachedLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (runtimeId) => makeRuntime(runtimeId),
    });
    cleanupTasks.push(async () => {
      await attachedLease.close();
      await ownerLease.close();
      await ownerLease.shutdown();
    });
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    await attachedLease.transport.request('initialize', {
      profile: 'default',
      token: readRuntimeDaemonToken(paths),
    });
    const originalRequest = attachedLease.transport.request.bind(attachedLease.transport);
    let shutdownRequests = 0;
    const request = vi.spyOn(attachedLease.transport, 'request').mockImplementation(
      async (method, params) => {
        if (method === 'runtime.shutdown') {
          shutdownRequests += 1;
          if (shutdownRequests === 1) {
            throw new Error('transient attached shutdown failure');
          }
        }
        return originalRequest(method, params);
      },
    );
    try {
      const first = attachedLease.shutdown();
      const concurrent = attachedLease.shutdown();
      await expect(first).rejects.toThrow('transient attached shutdown failure');
      await expect(concurrent).rejects.toThrow('transient attached shutdown failure');
      expect(shutdownRequests).toBe(1);

      await expect(attachedLease.shutdown()).resolves.toBeUndefined();
      expect(shutdownRequests).toBe(2);
    } finally {
      request.mockRestore();
    }
  });

  it('lets concurrent starters converge on one daemon owner', async () => {
    const homeDir = tempHome();
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    const endpoint = await makeTestEndpoint();
    const createdRuntimes: KodaXRuntime[] = [];

    const [firstLease, secondLease] = await Promise.all([
      acquireRuntimeDaemonLease({
        homeDir,
        profile: 'default',
        endpoint,
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async (runtimeId) => {
          const runtime = makeRuntime(runtimeId);
          createdRuntimes.push(runtime);
          return runtime;
        },
      }),
      acquireRuntimeDaemonLease({
        homeDir,
        profile: 'default',
        endpoint,
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async (runtimeId) => {
          const runtime = makeRuntime(runtimeId);
          createdRuntimes.push(runtime);
          return runtime;
        },
      }),
    ]);
    const ownerLease = firstLease.ownsHost ? firstLease : secondLease;
    cleanupTasks.push(async () => {
      await firstLease.close();
      await secondLease.close();
      await ownerLease.shutdown();
    });

    expect([firstLease.ownsHost, secondLease.ownsHost].filter(Boolean)).toHaveLength(1);
    const owner = readRuntimeDaemonLockOwner(paths.lockFile);
    expect(owner?.runtimeId).toMatch(/^rt_/);
    expect(createdRuntimes).toHaveLength(1);

    const token = readRuntimeDaemonToken(paths);
    await expect(firstLease.transport.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: owner?.runtimeId } });
    await expect(secondLease.transport.request('initialize', { profile: 'default', token }))
      .resolves.toMatchObject({ identity: { runtimeId: owner?.runtimeId } });
  });

  it('isolates default endpoints by home directory for the same profile', async () => {
    const firstHome = tempHome();
    const secondHome = tempHome();
    const firstPaths = resolveRuntimeDaemonPaths(firstHome, 'shared');
    const secondPaths = resolveRuntimeDaemonPaths(secondHome, 'shared');
    let firstRuntime: KodaXRuntime | undefined;
    let secondRuntime: KodaXRuntime | undefined;

    const [firstLease, secondLease] = await Promise.all([
      acquireRuntimeDaemonLease({
        homeDir: firstHome,
        profile: 'shared',
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async (runtimeId) => {
          firstRuntime = makeRuntime(runtimeId, 'shared');
          return firstRuntime;
        },
      }),
      acquireRuntimeDaemonLease({
        homeDir: secondHome,
        profile: 'shared',
        startupTimeoutMs: 2_000,
        pollIntervalMs: 10,
        createRuntime: async (runtimeId) => {
          secondRuntime = makeRuntime(runtimeId, 'shared');
          return secondRuntime;
        },
      }),
    ]);
    cleanupTasks.push(async () => {
      await firstLease.close();
      await secondLease.close();
      await firstLease.shutdown();
      await secondLease.shutdown();
    });

    expect(firstLease.ownsHost).toBe(true);
    expect(secondLease.ownsHost).toBe(true);
    if (!firstRuntime || !secondRuntime) throw new Error('Expected both Runtime owners.');
    expect(firstLease.endpoint.path).not.toBe(secondLease.endpoint.path);
    expect(readRuntimeDaemonLockOwner(firstPaths.lockFile)).toMatchObject({
      runtimeId: firstRuntime.identity.runtimeId,
    });
    expect(readRuntimeDaemonLockOwner(secondPaths.lockFile)).toMatchObject({
      runtimeId: secondRuntime.identity.runtimeId,
    });

    await expect(firstLease.transport.request('initialize', {
      profile: 'shared',
      token: readRuntimeDaemonToken(firstPaths),
    })).resolves.toMatchObject({ identity: { runtimeId: firstRuntime.identity.runtimeId } });
    await expect(secondLease.transport.request('initialize', {
      profile: 'shared',
      token: readRuntimeDaemonToken(secondPaths),
    })).resolves.toMatchObject({ identity: { runtimeId: secondRuntime.identity.runtimeId } });
  });

  it('claims a startup lock after the waiting owner disappears', async () => {
    const homeDir = tempHome();
    const paths = resolveRuntimeDaemonPaths(homeDir, 'default');
    expect(tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: 'runtime-starter',
      pid: 999_999,
      createdAt: '2026-07-09T00:00:00.000Z',
    })).toBeDefined();

    let pidChecks = 0;
    let runtime: KodaXRuntime | undefined;
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      profile: 'default',
      endpoint: await makeTestEndpoint(),
      startupTimeoutMs: 1_000,
      pollIntervalMs: 10,
      healthCheck: {
        isPidAlive: () => {
          pidChecks += 1;
          return pidChecks === 1;
        },
      },
      createRuntime: async (runtimeId) => {
        runtime = makeRuntime(runtimeId);
        return runtime;
      },
    });
    cleanupTasks.push(async () => {
      await lease.close();
      await lease.shutdown();
    });

    expect(lease.ownsHost).toBe(true);
    if (!runtime) throw new Error('Expected Runtime owner.');
    expect(readRuntimeDaemonLockOwner(paths.lockFile)).toMatchObject({
      runtimeId: runtime.identity.runtimeId,
    });
  });

  it('keeps the daemon alive when its original client detaches', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    let runtimeId: string | undefined;
    const firstLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (ownerId) => {
        runtimeId = ownerId;
        return makeRuntime(ownerId);
      },
    });
    const token = readRuntimeDaemonToken(firstLease.paths);
    await firstLease.transport.request('initialize', { profile: 'default', token });
    const secondLease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (ownerId) => makeRuntime(ownerId),
    });
    await secondLease.transport.request('initialize', { profile: 'default', token });
    cleanupTasks.push(async () => {
      await secondLease.close();
      await firstLease.shutdown();
    });

    await firstLease.close();

    await expect(secondLease.transport.request('ping')).resolves.toEqual({
      ok: true,
      runtimeId,
    });
  });

  it('round-trips failed run Errors through a real daemon socket', async () => {
    const homeDir = tempHome();
    const endpoint = await makeTestEndpoint();
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint,
      createRuntime: async (runtimeId) => makeRuntime(
        runtimeId,
        'default',
        new TypeError('provider unavailable'),
      ),
    });
    cleanupTasks.push(async () => {
      await lease.close();
      await lease.shutdown();
    });
    const token = readRuntimeDaemonToken(lease.paths);
    await lease.transport.request('initialize', { profile: 'default', token });
    const client = createRuntimeDaemonClient({
      identity: {
        ...makeRuntime('runtime-errors').identity,
        mode: 'daemon',
      },
      transport: lease.transport,
    });

    const handle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'fail over the wire',
    });
    const result = await handle.result;

    expect(result).toMatchObject({ phase: 'failed' });
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.name).toBe('TypeError');
    expect(result.error?.message).toBe('provider unavailable');
  });

  it('releases daemon ownership only through explicit shutdown', async () => {
    const homeDir = tempHome();
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint: await makeTestEndpoint(),
      createRuntime: async (runtimeId) => makeRuntime(runtimeId),
    });
    cleanupTasks.push(() => lease.shutdown());
    const token = readRuntimeDaemonToken(lease.paths);
    await lease.transport.request('initialize', { profile: 'default', token });

    await lease.close();
    expect(readRuntimeDaemonState(lease.paths)).toMatchObject({ status: 'ready' });

    await lease.shutdown();
    expect(readRuntimeDaemonState(lease.paths)).toBeUndefined();
    expect(readRuntimeDaemonLockOwner(lease.paths.lockFile)).toBeUndefined();
  });

  it('shares concurrent owned-host shutdown and permits retry after failure', async () => {
    const homeDir = tempHome();
    let runtime: ReturnType<typeof makeRuntime> | undefined;
    let closeCalls = 0;
    const lease = await acquireRuntimeDaemonLease({
      homeDir,
      endpoint: await makeTestEndpoint(),
      createRuntime: async (runtimeId) => {
        runtime = makeRuntime(runtimeId);
        const originalClose = runtime.close.bind(runtime);
        runtime.close = async () => {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error('transient owned Runtime close failure');
          await originalClose();
        };
        return runtime;
      },
    });
    cleanupTasks.push(() => lease.shutdown());

    const first = lease.shutdown();
    const concurrent = lease.shutdown();
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).rejects.toThrow(
      'transient owned Runtime close failure',
    );
    expect(runtime?.closed).toBe(false);
    expect(readRuntimeDaemonLockOwner(lease.paths.lockFile)).toBeDefined();

    await expect(lease.shutdown()).resolves.toBeUndefined();
    expect(closeCalls).toBe(2);
    expect(runtime?.closed).toBe(true);
    expect(readRuntimeDaemonLockOwner(lease.paths.lockFile)).toBeUndefined();
  });
});

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-manager-'));
  tempRoots.push(dir);
  return dir;
}

async function makeTestEndpoint(): Promise<RuntimeDaemonEndpoint> {
  if (process.platform === 'win32') {
    return {
      kind: 'pipe',
      path: `\\\\.\\pipe\\kodax-runtime-manager-test-${randomUUID()}`,
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-daemon-manager-socket-'));
  tempRoots.push(dir);
  return {
    kind: 'unix',
    path: path.join(dir, 'daemon.sock'),
  };
}

function makeRuntime(
  runtimeId = 'runtime-manager-test',
  profile = 'default',
  runError?: Error,
): KodaXRuntime & { closed: boolean } {
  const runtime: KodaXRuntime & { closed: boolean } = {
    closed: false,
    identity: {
      runtimeId,
      mode: 'daemon',
      profile,
      startedAt: '2026-07-09T00:00:00.000Z',
      version: '0.7.66',
    },
    sessions: {
      async cancel(input) { return { ...input, frontier: 0, receipts: [] }; },
      async status(sessionId) {
        return { sessionId, runtimeId: "runtime-test", phase: "idle",
          observedAt: new Date(0).toISOString() };
      },
      async conversation() { return null; },
      async conversationPage() { return null; },
      async conversationEntryChunk() { return null; },
      async diagnostics() { throw new Error("Session diagnostics are not used by this fixture."); },
      async create(input) {
        return { id: input?.sessionId ?? 'session-1', title: input?.title ?? 'Test Session' };
      },
      async load(sessionId) {
        return { id: sessionId, title: 'Loaded Session' };
      },
      async list() {
        return [];
      },
      async transcript() {
        return null;
      },
      async transcriptPage() {
        return null;
      },
      async transcriptEntryChunk() {
        return null;
      },
      async transcriptSearch() {
        return null;
      },
      async observe(sessionId) {
        return createTestObservation(sessionId);
      },
      async fork() {
        return null;
      },
      async getSettings() {
        return {};
      },
      async getSettingsVersioned() {
        return { revision: 0, value: {} };
      },
      async getAutoModeStats() {
        return undefined;
      },
      async updateSettings() {
        return {};
      },
      async updateSettingsVersioned(_sessionId, _patch, options) {
        return { revision: options.expectedRevision + 1, value: {} };
      },
      async appendNotice() {
        return null;
      },
      async confirmIdentityAlias() {
        throw new Error('Identity confirmation is outside this manager fixture.');
      },
      async rewind(input) {
        return { id: input.sessionId, title: 'Rewound Session' };
      },
      async setActiveEntry(input) {
        return { id: input.sessionId, title: 'Active Entry Session' };
      },
      async compact(input) {
        return {
          compacted: false,
          tokensBefore: 0,
          tokensAfter: 0,
          messages: [],
          session: { id: input.sessionId, title: 'Compacted Session' },
        } satisfies RuntimeCompactSessionResult;
      },
      async archive() {},
      async unarchive() {},
      async delete() {},
    },
    runs: {
      async start(input: RuntimeStartRunInput) {
        const result: RuntimeRunResult = {
          runId: 'run-1',
          sessionId: input.sessionId,
          phase: runError === undefined ? 'completed' : 'failed',
          ...(runError !== undefined ? { error: runError } : {}),
        };
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async submitInput(input) {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: 'stale_run',
        };
      },
      async await(runId) {
        return {
          runId,
          sessionId: 'session-1',
          phase: runError === undefined ? 'completed' : 'failed',
          ...(runError !== undefined ? { error: runError } : {}),
        };
      },
      async get(runId) {
        return {
          runId,
          sessionId: 'session-1',
          phase: 'completed',
          startedAt: '2026-07-09T00:00:00.000Z',
          provider: 'mock',
        };
      },
      async list() {
        return [];
      },
      async abort(runId) {
        return { runId, sessionId: "session-1", accepted: false,
          state: "confirmed", outcome: "completed", phase: "completed", revision: 0 };
      },
      async setModel() {},
      async setProvider() {},
      async setReasoning() {},
    },
    events: {
      subscribe() {
        return { close() {} };
      },
      async replay() {
        return [];
      },
    },
    permissions: {
      async request() {
        return { type: 'allow_once' };
      },
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
      async listGrants() { return { revision: 0, value: [] }; },
      async revokeGrant() { return false; },
    },
    userInputs: createTestUserInputs(),
    credentials: createTestCredentialService(),
    hostTools: createTestHostToolService(),
    operations: {
      async get() {
        throw new Error('operation not found');
      },
    },
    workflows: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      subscribe() {
        return { close() {} };
      },
      async pause() {
        return false;
      },
      async resume() {
        return false;
      },
      async stop() {
        return false;
      },
    },
    learning: {} as KodaXRuntime['learning'],
    config: {
      async readEffective() {
        return { schemaVersion: 1, capturedAt: new Date(0).toISOString(),
          persistedConfig: { state: "missing" }, entries: {}, credentials: {} };
      },
      async read() {
        return {};
      },
      async patch(patch) {
        return patch;
      },
      async reload() {
        return { ok: true, config: {} };
      },
    },
    catalog: {
      async providers() {
        return [];
      },
      async models() {
        return [];
      },
      async commands() {
        return [];
      },
      async resolveCommand() {
        return null;
      },
      async skills() {
        return [];
      },
      async describeSkill() {
        return null;
      },
      async customProviders() {
        return [];
      },
      async upsertCustomProvider(config) {
        return config;
      },
      async deleteCustomProvider() {
        return false;
      },
      async extensions() {
        return { active: false, extensions: [] };
      },
      async reloadExtensions() {
        return { ok: true, active: false };
      },
    },
    mcp: {
      async listServers() {
        return {};
      },
      async getServer() {
        return undefined;
      },
      async validateServer(_name, config) {
        return {
          ok: true,
          config: config as Parameters<KodaXRuntime['mcp']['upsertServer']>[1],
        };
      },
      async upsertServer(_name, config) {
        return config;
      },
      async deleteServer() {
        return false;
      },
      async reloadServers() {
        return { ok: true, servers: [] };
      },
      async listTools() {
        return [];
      },
    },
    artifacts: {
      async create(input) {
        return {
          id: 'art-1',
          kind: input.kind,
          path: input.path,
          sizeBytes: 0,
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async get() {
        return undefined;
      },
      async delete() {
        return false;
      },
    },
    admin: {
      agentRegistrations: {
        async list() { return []; },
        async upsert() { throw new Error('External agents are disabled in this test runtime.'); },
        async setEnabled() { throw new Error('External agents are disabled in this test runtime.'); },
        async remove() { throw new Error('External agents are disabled in this test runtime.'); },
      },
    },
    agents: {
      enabled: false,
      async listDispatchable() { return []; },
      async describe() { return undefined; },
      async preflight() { throw new Error('External agents are disabled in this test runtime.'); },
      async tree() {
        return {
          rootPath: '/root' as const,
          actors: [],
          activeNonRootTurns: 0,
          maxConcurrentThreads: 4,
          revision: 0,
        };
      },
      async detail() { throw new Error('Actor not found.'); },
      async spawn() { throw new Error('Actor execution is disabled in this test runtime.'); },
      async send() { throw new Error('Actor execution is disabled in this test runtime.'); },
      async followup() { throw new Error('Actor execution is disabled in this test runtime.'); },
      async interrupt() { throw new Error('Actor execution is disabled in this test runtime.'); },
      async output() { throw new Error('Actor execution is disabled in this test runtime.'); },
      async events() { return []; },
      async wait() { return undefined; },
    },
    status: {
      async snapshot() {
        return {
          ...runtime.identity,
          sessions: [],
          runs: [],
          pendingPermissions: [],
          workflows: [],
        };
      },
      async preflight() {
        return {
          runtimeId: runtime.identity.runtimeId,
          clientCount: 0,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows: [],
          activeAgentTurns: [],
          activeAgentTasks: [],
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers: [],
          canStop: true,
        };
      },
    },
    diagnostics: {
      async latestContextBudget() {
        return null;
      },
      async latestToolExposure() {
        return null;
      },
      async latestProviderCacheDiagnostic() {
        return null;
      },
    },
    async close() {
      runtime.closed = true;
    },
  };
  return runtime;
}

function createTestUserInputs(): KodaXRuntime['userInputs'] {
  return {
    async listPending() { return []; },
    async respond(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
    async dismiss(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
  };
}

function createTestCredentialService(): KodaXRuntime['credentials'] {
  return {
    async registerScoped(input) { return { id: 'credential-test', ...input, brokerVersion: 2 }; },
    async resumeScoped() { throw new Error('Missing credential lease.'); },
    async register(input) { return { id: 'credential-test', ...input }; },
    async resume() { throw new Error('Missing credential lease.'); },
    async revoke() { return false; },
  };
}

function createTestHostToolService(): KodaXRuntime['hostTools'] {
  return {
    async register(tools) { return { id: 'host-tools-test', tools }; },
    async resume() { throw new Error('Missing host tool lease.'); },
    async revoke() { return false; },
    async getInvocation() { return undefined; },
  };
}

function createTestObservation(sessionId: string) {
  return {
    invalidated: new Promise<never>(() => undefined),
    snapshot: {
      runtimeId: 'runtime-test',
      cursor: { sessionId, journalEpoch: "test-epoch", seq: 0 },
      transcriptRevision: 'sha256:test',
      session: { id: sessionId, title: 'Test Session' },
      transcript: null,
      settings: { revision: 0, value: {} },
      runs: [],
      pendingPermissions: [],
      live: {
        assistantTextByRun: {},
        outputSegmentsByRun: {},
        thinkingTextByRun: {},
        activeTools: [],
        pendingUserInputs: [],
        managedTasks: [],
      },
    },
    close() {},
  };
}
