import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class GoalProvider extends KodaXBaseProvider {
  readonly name = 'product-goal-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_GOAL_TEST_KEY', model: 'product-goal-test', supportsThinking: false,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    requests.push(structuredClone(messages));
    return { textBlocks: [{ type: 'text', text: 'Acknowledged.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let requests: KodaXMessage[][] = [];
let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-goal-'));
  requests = [];
  registerModelProvider('product-goal-test', () => new GoalProvider());
  vi.stubEnv('KODAX_PRODUCT_GOAL_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-goal-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated goal Host.');
  const endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-goal-${randomUUID()}`
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

it('hosts one goal state both clients read, with explicit lifecycle conflicts', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });

  expect(await second.sessions.readGoal(session.id)).toBeNull();
  // Goal entries anchor to the active branch, so a session without any
  // conversation entry yet refuses goal creation explicitly.
  await expect(first.sessions.createGoal(session.id, { objective: 'too early' }))
    .rejects.toMatchObject({ code: 'conflict' });
  const round = await first.inputs.submit({ sessionId: session.id, inputId: 'warmup', text: 'Warm up the session.' });
  await runtime.runs.await(round.runId!);

  const created = await first.sessions.createGoal(session.id, { objective: 'Ship v2 release', tokenBudget: 50_000 });
  expect(created.status).toBe('active');
  expect(created.objective).toBe('Ship v2 release');
  expect(created.tokenBudget).toBe(50_000);

  // The other client sees the same goal and budget, without any run started.
  const mirrored = await second.sessions.readGoal(session.id);
  expect(mirrored).toMatchObject({ id: created.id, objective: created.objective, status: 'active', tokenBudget: 50_000 });
  expect(requests.length).toBe(1);

  // Budget rules stay the domain's: non-positive budgets are rejected.
  await expect(first.sessions.createGoal(session.id, { objective: 'bad', tokenBudget: 0 }))
    .rejects.toMatchObject({ code: 'invalid_params' });
  // A second goal cannot replace an active one.
  await expect(first.sessions.createGoal(session.id, { objective: 'another' }))
    .rejects.toMatchObject({ code: 'conflict' });

  const paused = await second.sessions.pauseGoal(session.id);
  expect(paused.status).toBe('paused');
  expect((await first.sessions.readGoal(session.id))?.status).toBe('paused');
  await expect(second.sessions.pauseGoal(session.id)).rejects.toMatchObject({ code: 'conflict' });

  const resumed = await first.sessions.resumeGoal(session.id);
  expect(resumed.status).toBe('active');
  await expect(first.sessions.resumeGoal(session.id)).rejects.toMatchObject({ code: 'conflict' });

  await second.sessions.clearGoal(session.id);
  expect(await first.sessions.readGoal(session.id)).toBeNull();
  await expect(second.sessions.clearGoal(session.id)).rejects.toMatchObject({ code: 'conflict' });

  // After clearing, a new goal can be created and no run ever started.
  const recreated = await first.sessions.createGoal(session.id, { objective: 'Fresh start' });
  expect(recreated.tokenBudget).toBeNull();
  // Goal commands never started or resurrected a Run.
  expect(requests.length).toBe(1);
}, 60_000);

it('appends notices through the Host so both clients see them in the view', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });

  await first.sessions.appendNotice(session.id, { content: 'Migrated to Host-owned notices.' });
  // Notices stay display-only: nothing reached the Provider.
  expect(requests.length).toBe(0);

  const views: Parameters<Parameters<typeof second.sessions.observe>[1]>[0][] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    expect(views[0]!.items.some((item) => item.type === 'info' && item.text.includes('Migrated to Host-owned notices.')))
      .toBe(true);
  } finally { observation.close(); }
}, 60_000);

it('keeps an explicit order when both clients create a goal concurrently', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const round = await first.inputs.submit({ sessionId: session.id, inputId: 'warmup', text: 'Warm up.' });
  await runtime.runs.await(round.runId!);

  const settled = await Promise.allSettled([
    first.sessions.createGoal(session.id, { objective: 'Winner from client one' }),
    second.sessions.createGoal(session.id, { objective: 'Winner from client two' }),
  ]);
  const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = settled.filter((outcome) => outcome.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const winner = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof first.sessions.createGoal>>>;
  const loser = rejected[0] as PromiseRejectedResult;
  expect(loser.reason).toMatchObject({ code: 'conflict' });
  const goal = await second.sessions.readGoal(session.id);
  expect(goal?.id).toBe(winner.value.id);
  expect(requests.length).toBe(1);
}, 60_000);

it('does not resurrect runs from an active goal after a Host restart', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const round = await first.inputs.submit({ sessionId: session.id, inputId: 'warmup', text: 'Warm up.' });
  await runtime.runs.await(round.runId!);
  await first.sessions.createGoal(session.id, { objective: 'Survives restarts without running' });

  // Restart the Host over the same storage root: the active goal must persist
  // for readers but must not start or resurrect any Run on its own.
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-goal-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not re-acquire goal Host after restart.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-goal-restart-' + randomUUID()
    : path.join(homeDir, 'host-restart.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });

  const goal = await first.sessions.readGoal(session.id);
  expect(goal).toMatchObject({ objective: 'Survives restarts without running', status: 'active' });
  expect(requests.length).toBe(1);
  const fresh = await second.sessions.readGoal(session.id);
  expect(fresh?.id).toBe(goal?.id);
  expect(requests.length).toBe(1);
}, 60_000);
