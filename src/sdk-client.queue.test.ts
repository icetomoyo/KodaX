import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class QueueProvider extends KodaXBaseProvider {
  readonly name = 'product-queue-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_QUEUE_TEST_KEY', model: 'product-queue-test', supportsThinking: false,
  };
  constructor(private readonly request: (messages: KodaXMessage[]) => Promise<void>) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    requestModels.push(args[4]?.modelOverride);
    await this.request(args[0]);
    return {
      textBlocks: [{ type: 'text', text: 'This batch completed.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

let homeDir: string;
let release: () => void = () => undefined;
let requests: KodaXMessage[][] = [];
let requestModels: (string | undefined)[] = [];
let onRequest: () => void = () => undefined;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-queue-'));
  const firstRequest = new Promise<void>((resolve) => { release = resolve; });
  requests = [];
  requestModels = [];
  onRequest = () => undefined;
  registerModelProvider('product-queue-test', () => new QueueProvider(async (messages) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) await firstRequest;
    await onRequest();
  }));
  vi.stubEnv('KODAX_PRODUCT_QUEUE_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-queue-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated queue Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-queue-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  second = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  release();
  vi.restoreAllMocks();
  await Promise.all([first.disconnect(), second.disconnect()]);
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('shares queued input, atomically withdraws exact input, and batches the remaining text once', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access', model: 'queue-model-a' });
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
    const removed = { sessionId: session.id, inputId: 'withdraw-me', text: 'Never deliver this.' , delivery: 'after_turn' as const };
    const queued = await first.inputs.submit(removed);
    expect(queued.state).toBe('queued');
    expect(await second.inputs.submit(removed)).toEqual(queued);
    await first.inputs.submit({ ...removed, inputId: 'second', text: 'Second instruction.' });
    await second.inputs.submit({ ...removed, inputId: 'third', text: 'Third instruction.' });
    await expect.poll(() => views.at(-1)?.queue.map((item) => item.inputId))
      .toEqual(['withdraw-me', 'second', 'third']);
    const withdrawn = await second.inputs.withdraw(session.id, removed.inputId);
    expect(withdrawn).toMatchObject({ inputId: removed.inputId, text: removed.text });
    await expect(first.inputs.withdraw(session.id, removed.inputId)).rejects.toMatchObject({ code: 'conflict' });
    expect(await first.inputs.submit(removed)).toMatchObject({ state: 'withdrawn' });
    await first.sessions.updateSettings(session.id, { model: 'queue-model-b' });
    expect(requestModels).toEqual(['queue-model-a']);
    release();
    await runtime.runs.await(active.runId!);
    await expect.poll(() => requests.length).toBe(2);
    expect(requestModels).toEqual(['queue-model-a', 'queue-model-b']);
    await expect.poll(() => views.at(-1)?.queue.length).toBe(0);
    const latest = requests[1]!.filter((message) => message.role === 'user').at(-1);
    expect(latest?.content).toBe('Second instruction.\n\n---\n\nThird instruction.');
    expect(JSON.stringify(requests)).not.toContain(removed.text);
    const consumed = await first.inputs.read(session.id, 'second');
    expect(consumed).toMatchObject({ state: 'submitted' });
    await runtime.runs.await(consumed!.runId!);
    await expect(second.inputs.withdraw(session.id, 'third')).rejects.toMatchObject({ code: 'conflict' });
  } finally {
    release();
    observation.close();
  }
});

it('bounds queue previews and capacity while withdrawal returns the complete original once', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  const fullText = 'Large pasted instruction. '.repeat(40_000);
  const input = { sessionId: session.id, inputId: 'large', text: fullText, delivery: 'after_turn' as const };
  await first.inputs.submit(input);
  for (let i = 1; i < 5; i += 1) await first.inputs.submit({ ...input, inputId: `queued-${i}`, text: `Instruction ${i}.` });
  await expect(second.inputs.submit({ ...input, inputId: 'overflow' })).rejects.toMatchObject({ code: 'conflict' });
  expect(await first.inputs.read(session.id, 'overflow')).toBeNull();
  const views: ClientSessionView[] = [];
  const observation = await second.sessions.observe(session.id, (view) => views.push(view));
  try {
    expect(views[0]!.queue[0]!.text.length).toBeLessThan(100);
    await expect(second.inputs.submit({ ...input, delivery: 'immediate' })).rejects.toMatchObject({ code: 'conflict' });
    const attempts = await Promise.allSettled([first.inputs.withdraw(session.id, 'large'), second.inputs.withdraw(session.id, 'large')]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const success = attempts.find((result) => result.status === 'fulfilled');
    expect(success?.status === 'fulfilled' ? success.value.text : undefined).toBe(fullText);
    expect(attempts.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    for (let i = 1; i < 5; i += 1) await first.inputs.withdraw(session.id, `queued-${i}`);
    release();
    await runtime.runs.await(active.runId!);
    expect(requests).toHaveLength(1);
  } finally { observation.close(); }
});

it.each(['stop', 'failure'] as const)('retains undelivered text and starts no remaining work after %s', async (ending) => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  const queued = { sessionId: session.id, inputId: 'not-delivered', text: 'Keep this for editing.', delivery: 'after_turn' as const };
  await second.inputs.submit(queued);
  if (ending === 'stop') await runtime.runs.abort(active.runId!);
  else onRequest = () => { throw new Error('Injected terminal Provider failure.'); };
  release();
  const result = await runtime.runs.await(active.runId!);
  if (ending === 'stop') expect(result.stop?.requestedAt).toEqual(expect.any(String));
  else expect(result.phase).not.toBe('completed');
  expect(await first.inputs.read(session.id, queued.inputId)).toMatchObject({ state: 'queued' });
  expect(await first.inputs.withdraw(session.id, queued.inputId)).toMatchObject({ text: queued.text });
  expect(requests).toHaveLength(1);
});

it('keeps queued Skill raw text as its own batch and merges only the plain text around it', async () => {
  const session = await first.sessions.create({ projectPath: homeDir });
  await first.sessions.updateSettings(session.id, { agentMode: 'sa', permissionMode: 'full-access' });
  const active = await first.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Start.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  const queued = { sessionId: session.id, delivery: 'after_turn' as const };
  await second.inputs.submit({ ...queued, inputId: 'plain-a', text: 'Plain A.' });
  await second.inputs.submit({ ...queued, inputId: 'skill-run', text: '/review Check this diff.' });
  await second.inputs.submit({ ...queued, inputId: 'plain-b', text: 'Plain B.' });
  release();
  await runtime.runs.await(active.runId!);
  const awaitSubmittedRun = async (inputId: string): Promise<string> => {
    let runId: string | undefined;
    await expect.poll(async () => {
      const accepted = await first.inputs.read(session.id, inputId);
      runId = accepted?.runId;
      return accepted?.state ?? 'missing';
    }).toBe('submitted');
    return runId!;
  };
  for (const inputId of ['plain-a', 'skill-run', 'plain-b']) {
    await runtime.runs.await(await awaitSubmittedRun(inputId));
  }
  // Learning review may issue its own Provider call; identify each queued
  // input by its canonical inputId instead of request positions.
  const ownPromptOf = (inputId: string): KodaXMessage | undefined => {
    const request = requests.find((messages) => messages
      .some((message) => message.role === 'user' && message.inputId === inputId));
    return request
      ?.filter((message) => message.role === 'user' && message.inputId !== undefined)
      .at(-1);
  };
  expect(ownPromptOf('plain-a')?.content).toBe('Plain A.');
  expect(ownPromptOf('skill-run')?.content).toBe('/review Check this diff.');
  expect(ownPromptOf('plain-b')?.content).toBe('Plain B.');
  // No text-merged batch ever spans the Skill boundary.
  for (const message of requests.flat().filter((item) => item.role === 'user' && item.inputIds)) {
    expect(message.inputIds!.includes('skill-run') && message.inputIds!.length > 1).toBe(false);
  }
});
