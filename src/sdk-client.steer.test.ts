import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL, awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime, RUNTIME_REDIRECT_STOP_REASON } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class SteerProvider extends KodaXBaseProvider {
  readonly name = 'product-steer-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_STEER_TEST_KEY', model: 'product-steer-test', supportsThinking: false,
  };
  constructor(private readonly request: (messages: KodaXMessage[]) => Promise<void>) { super(); }
  async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[]): Promise<KodaXStreamResult> {
    // Episode reviews are real background requests, not redirected conversation turns.
    if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return {
      textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
        type: 'tool_use', id: 'review', name: LEARNING_REVIEW_TOOL.name,
        input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
      }],
    };
    await this.request(messages);
    return {
      textBlocks: [{ type: 'text', text: 'Acknowledged.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

let homeDir: string;
let release: () => void = () => undefined;
let interruptFirstRequest: () => void = () => undefined;
let requests: KodaXMessage[][] = [];
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-steer-'));
  const firstRequest = new Promise<void>((resolve) => { release = resolve; });
  const cancellation = new Promise<void>((resolve) => { interruptFirstRequest = resolve; });
  requests = [];
  registerModelProvider('product-steer-test', () => new SteerProvider(async (messages) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) {
      await Promise.race([
        firstRequest,
        cancellation.then(() => Promise.reject(new Error('This provider observes the redirect cancellation.'))),
      ]);
    }
  }));
  vi.stubEnv('KODAX_PRODUCT_STEER_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-steer-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated steer Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-steer-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  second = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  release();
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  await awaitLatestCodingMemoryReviewDrain(5_000);
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('steers into the named active Run at a safety point and rejects invalid or late targets', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  const steer = {
    sessionId: session.id, inputId: 'steer-1', text: 'Steered guidance.',
    delivery: 'steer' as const, targetRunId: active.runId!,
  };
  const accepted = await first.inputs.submit(steer);
  expect(accepted).toMatchObject({ state: 'queued', runId: active.runId });
  expect(await second.inputs.submit(steer)).toEqual(accepted);
  await expect(first.inputs.submit({ ...steer, text: 'A different steer.' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(second.inputs.submit({ ...steer, targetRunId: 'run_nonexistent' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(first.inputs.submit({ sessionId: session.id, inputId: 'steer-no-target', text: 'No target.', delivery: 'steer' })).rejects.toMatchObject({ code: 'conflict' });
  release();
  await runtime.runs.await(active.runId!);
  await expect.poll(async () => (await first.inputs.read(session.id, 'steer-1'))?.state).toBe('submitted');
  await expect.poll(() => requests.filter((messages) => messages
    .some((message) => message.role === 'user' && message.content === 'Steered guidance.')).length)
    .toBeGreaterThan(0);
  // A late steer toward the finished Run is rejected without queueing new work.
  await expect(second.inputs.submit({ sessionId: session.id, inputId: 'steer-late', text: 'Too late.', delivery: 'steer', targetRunId: active.runId! })).rejects.toMatchObject({ code: 'conflict' });
  expect(await first.inputs.read(session.id, 'steer-late')).toBeNull();
});

it('redirect accepts the new input first, cancels the old Run, and keeps the requested follow-up', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  await second.inputs.submit({ sessionId: session.id, inputId: 'plain-queued', text: 'Plain queued note.', delivery: 'after_turn' });
  const redirect = {
    sessionId: session.id, inputId: 'redirect-1', text: 'New direction.',
    delivery: 'redirect' as const, targetRunId: active.runId!,
  };
  const accepted = await second.inputs.submit(redirect);
  expect(accepted).toMatchObject({ state: 'queued' });
  expect(await first.inputs.submit(redirect)).toEqual(accepted);
  release();
  const stopped = await runtime.runs.await(active.runId!);
  expect(stopped.stop?.reason).toBe(RUNTIME_REDIRECT_STOP_REASON);
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
  const merged = requests[1]!.filter((message) => message.role === 'user').at(-1)?.content ?? '';
  expect(merged).toContain('Plain queued note.');
  expect(merged).toContain('New direction.');
  const consumed = await first.inputs.read(session.id, 'redirect-1');
  expect(consumed).toMatchObject({ state: 'submitted' });
  await runtime.runs.await(consumed!.runId!);
  // A redirect toward the already-settled Run is an explicit conflict.
  await expect(second.inputs.submit({ sessionId: session.id, inputId: 'redirect-2', text: 'Again.', delivery: 'redirect', targetRunId: active.runId! })).rejects.toMatchObject({ code: 'conflict' });
});

it('continues the redirect follow-up when cancellation actually interrupts the old Run', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  const accepted = await second.inputs.submit({
    sessionId: session.id, inputId: 'redirect-honored', text: 'Replacement direction.',
    delivery: 'redirect', targetRunId: active.runId!,
  });
  expect(accepted).toMatchObject({ state: 'queued' });
  // The Provider observes the redirect cancellation and settles the old Run
  // with a failure, not a completion.
  interruptFirstRequest();
  const stopped = await runtime.runs.await(active.runId!);
  expect(stopped.stop?.reason).toBe(RUNTIME_REDIRECT_STOP_REASON);
  expect(stopped.phase).not.toBe('completed');
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
  expect(requests[1]!.filter((message) => message.role === 'user').at(-1)?.content).toBe('Replacement direction.');
  const consumed = await first.inputs.read(session.id, 'redirect-honored');
  expect(consumed).toMatchObject({ state: 'submitted' });
  await runtime.runs.await(consumed!.runId!);
});
