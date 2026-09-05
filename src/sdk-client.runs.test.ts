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

class RunsProvider extends KodaXBaseProvider {
  readonly name = 'product-runs-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_RUNS_TEST_KEY', model: 'product-runs-test', supportsThinking: false,
  };
  constructor(private readonly request: (messages: KodaXMessage[]) => Promise<void>) { super(); }
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    await this.request(messages);
    return {
      textBlocks: [{ type: 'text', text: 'Done.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

let homeDir: string;
let release: () => void = () => undefined;
let requests: KodaXMessage[][] = [];
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-runs-'));
  const firstRequest = new Promise<void>((resolve) => { release = resolve; });
  requests = [];
  registerModelProvider('product-runs-test', () => new RunsProvider(async (messages) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) await firstRequest;
  }));
  vi.stubEnv('KODAX_PRODUCT_RUNS_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-runs-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated runs Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-runs-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  second = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  release();
  // beforeEach may fail partway; teardown stays safe on partial state.
  await Promise.allSettled([first?.disconnect(), second?.disconnect()]);
  await host?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads the same lifecycle facts from both clients and separates stop acceptance from the terminal state', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);

  const running = await second.runs.read(active.runId!);
  expect(running).toMatchObject({ runId: active.runId, sessionId: session.id, phase: 'running' });
  expect(running.stop).toBeUndefined();

  const receipt = await first.runs.stop(active.runId!);
  expect(receipt).toMatchObject({ runId: active.runId, sessionId: session.id, accepted: true });
  // Acceptance is not the terminal fact: the executor still hangs here.
  const afterStop = await second.runs.read(active.runId!);
  expect(afterStop.stop).toMatchObject({ requestedAt: expect.any(String), reason: 'runtime run aborted' });

  release();
  const result = await runtime.runs.await(active.runId!);
  expect(result.stop?.requestedAt).toEqual(afterStop.stop!.requestedAt);
  const terminal = await first.runs.read(active.runId!);
  expect(terminal.stop).toMatchObject({ state: 'confirmed', resolvedAt: expect.any(String) });

  // A repeated stop creates no new work; a missing Run is an explicit error.
  const repeat = await second.runs.stop(active.runId!);
  expect(repeat.accepted).toBe(false);
  await expect(first.runs.read('run_nonexistent')).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
