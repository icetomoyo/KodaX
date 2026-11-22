import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import {
  KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';

import { createKodaXRuntime } from '../tests/runtime-fixture.js';

const PROVIDER = 'runtime-input-request-provider';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

/** A home whose model answers at once, or waits for `release` when `held` is set. */
async function home(held = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-input-request-'));
  let calls = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = held ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
  const started = new Promise<void>((resolve) => { entered = resolve; });
  class CountingProvider extends KodaXBaseProvider {
    readonly name = PROVIDER;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_INPUT_REQUEST_KEY', model: 'input-request', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      calls += 1;
      entered();
      await gate;
      args[5]?.throwIfAborted();
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_INPUT_REQUEST_KEY', 'offline-test');
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const unregister = registerModelProvider(PROVIDER, () => new CountingProvider());
  cleanups.push(async () => {
    release?.();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const open = async () => {
    const runtime = await createKodaXRuntime({
      homeDir: root, sessionsDir: path.join(root, 'sessions'), defaultProvider: PROVIDER,
    });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await runtime.close();
    };
    cleanups.push(close);
    return { runtime, close };
  };
  return { root, open, started, calls: () => calls };
}

describe('an input submitted again under the id it was accepted with', () => {
  it('starts one Run however often it is submitted, across a Host restart', async () => {
    const { root, open, calls } = await home();
    const first = await open();
    const session = await first.runtime.sessions.create({ title: 'Once', projectPath: root });
    const input = { sessionId: session.id, inputId: 'input-1', text: 'Say done.' };

    const accepted = await first.runtime.runs.acceptInput(input);
    expect(accepted).toMatchObject({ state: 'submitted', inputId: 'input-1' });
    await first.runtime.runs.await(accepted.runId!);
    expect(await first.runtime.runs.acceptInput(input)).toMatchObject({ state: 'submitted', runId: accepted.runId });
    const modelCalls = calls();
    await first.close();

    const restarted = await open();
    expect(await restarted.runtime.runs.getInput(session.id, 'input-1'))
      .toMatchObject({ state: 'submitted', runId: accepted.runId });
    expect(await restarted.runtime.runs.acceptInput(input)).toMatchObject({ state: 'submitted', runId: accepted.runId });
    expect((await restarted.runtime.runs.list({ sessionId: session.id })).map(run => run.runId)).toEqual([accepted.runId]);
    expect(calls()).toBe(modelCalls);
  });

  it('refuses a different input under that id after a Host restart', async () => {
    const { root, open } = await home();
    const first = await open();
    const session = await first.runtime.sessions.create({ title: 'Once', projectPath: root });
    const accepted = await first.runtime.runs.acceptInput({ sessionId: session.id, inputId: 'input-2', text: 'First.' });
    await first.runtime.runs.await(accepted.runId!);
    await first.close();

    const restarted = await open();
    await expect(restarted.runtime.runs.acceptInput({ sessionId: session.id, inputId: 'input-2', text: 'Second.' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not run the input again when the Host stopped in the middle of its Run', async () => {
    const { root, open, started, calls } = await home(true);
    const first = await open();
    const session = await first.runtime.sessions.create({ title: 'Cut short', projectPath: root });
    const input = { sessionId: session.id, inputId: 'input-3', text: 'Say done.' };
    const accepted = await first.runtime.runs.acceptInput(input);
    await started;
    await first.close();

    const restarted = await open();
    expect(await restarted.runtime.runs.acceptInput(input)).toMatchObject({ state: 'submitted', runId: accepted.runId });
    expect((await restarted.runtime.runs.list({ sessionId: session.id })).map(run => run.runId)).toEqual([accepted.runId]);
    expect(calls()).toBe(1);
  });
});
