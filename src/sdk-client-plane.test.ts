import { toKodaXProductClient } from './client-runtime-adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  type KodaXMessage,
  type KodaXProviderConfig,
  type KodaXProviderStreamOptions,
  type KodaXStreamResult,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import { runClientPlaneRound } from '@kodax-ai/repl';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createCliClientPlane as wireClientPlane } from './cli-client-plane.js';
import { changedClientSessionSettings, clientSessionSettings } from '../packages/repl/src/ui/client-session-settings.js';

class ProbeProvider extends KodaXBaseProvider {
  readonly name = 't17-probe';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_T17_KEY', model: 't17-probe', supportsThinking: false,
  };
  constructor(private readonly finish: (resolve: (result: KodaXStreamResult) => void) => void) {
    super();
  }
  async stream(
    messages: KodaXMessage[],
    tools: KodaXToolDefinition[],
    _system: string,
    _reasoning?: boolean,
    streamOptions?: KodaXProviderStreamOptions,
  ): Promise<KodaXStreamResult> {
    // Episode learning is a separate background role, not another user round.
    if (tools.some((tool) => tool.name === 'commit_episode_learning_review')) {
      return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
        type: 'tool_use', id: 'fixture-learning-review', name: 'commit_episode_learning_review',
        input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
      }] };
    }
    void messages;
    return new Promise<KodaXStreamResult>((resolve) => this.finish((result) => {
      // Real providers stream text through the callbacks before resolving;
      // the view projection keys on these deltas.
      for (const block of result.textBlocks) {
        if (block.type === 'text') streamOptions?.onTextDelta?.(block.text);
      }
      resolve(result);
    }));
  }
}

/**
 * FEATURE_298 T17 — the client plane round trip: submit through the Host
 * input face, watch the session view stream the exchange, await the
 * terminal result, and stop via a receipt.
 */
it('runs one round over the client plane with view-driven display', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t17-plane-'));
  let releaseStream: ((result: KodaXStreamResult) => void) | undefined;
  registerModelProvider('t17-probe', () => new ProbeProvider((resolve) => {
    releaseStream = resolve;
  }));
  vi.stubEnv('KODAX_T17_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't17-probe',
  });
  const plane = wireClientPlane(toKodaXProductClient(runtime));
  try {
    const session = await runtime.sessions.create({ title: 'T17 plane', surface: 'repl', projectPath: homeDir });
    await plane.updateSettings?.(session.id, clientSessionSettings({
      provider: 't17-probe', model: 't17-selected', agentMode: 'sa',
      permissionMode: 'accept-edits', thinking: false, reasoningMode: 'off',
    }, 7));
    expect(await runtime.sessions.getSettings(session.id)).toMatchObject({
      provider: 't17-probe', model: 't17-selected', agentMode: 'sa',
      permissionMode: 'accept-edits', thinking: false, reasoningMode: 'off', maxIter: 7,
    });

    // The display subscription sees the live view before the run starts.
    const views: ClientSessionView[] = [];
    const close = await plane.observe(session.id, (view) => views.push(view));

    let roundError: unknown;
    const roundPromise = runClientPlaneRound({
      plane,
      sessionId: session.id,
      prompt: 'Summarize the repository.',
    }).catch((error: unknown) => {
      roundError = error;
      throw error;
    });

    // The user input and the live run appear in the view while streaming.
    await expect.poll(() =>
      views.some((view) =>
        view.items.some((item) => item.type === 'user' && item.text.includes('Summarize the repository.'))
        && view.runs.some((run) => run.phase === 'running'),
      ), { timeout: 15_000 },
    ).toBe(true);

    // Wait until the run has actually reached the provider, then release.
    await expect.poll(() => releaseStream !== undefined || roundError !== undefined, { timeout: 15_000 }).toBe(true);
    if (roundError !== undefined) {
      throw roundError instanceof Error ? roundError : new Error(String(roundError));
    }
    releaseStream!({
      textBlocks: [{ type: 'text', text: 'Repository summary.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    });
    const result = await roundPromise;

    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Repository summary.');
    expect(result.messages.length).toBeGreaterThan(0);
    // A second client changes the model. A local mode switch must write only
    // agentMode, preserving that independent Host-owned model selection.
    await runtime.sessions.updateSettings(session.id, { model: 'external-model' });
    await plane.updateSettings?.(session.id, changedClientSessionSettings(
      { agentMode: 'sa', model: 't17-selected' },
      { agentMode: 'ama', model: 't17-selected' },
    ));
    expect(await runtime.sessions.getSettings(session.id)).toMatchObject({
      agentMode: 'ama', model: 'external-model', permissionMode: 'accept-edits',
    });
    // An explicit selection of the locally displayed model still reaches the
    // Host when another client changed its value after the local snapshot.
    await plane.updateSettings?.(session.id, changedClientSessionSettings(
      { model: 't17-selected', permissionMode: 'accept-edits' },
      { model: 't17-selected', permissionMode: 'accept-edits' },
      ['model'],
    ));
    expect(await runtime.sessions.getSettings(session.id)).toMatchObject({
      model: 't17-selected', agentMode: 'ama', permissionMode: 'accept-edits',
    });

    // The assistant answer lands in the view for every client.
    await expect.poll(() =>
      views.some((view) =>
        view.items.some((item) => item.type === 'assistant' && item.text.includes('Repository summary.')),
      ), { timeout: 15_000 },
    ).toBe(true);
    close();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

it('stops a client-plane round with a receipt and maps it to the interrupted result', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t17-stop-'));
  registerModelProvider('t17-probe', () => new ProbeProvider(() => undefined));
  vi.stubEnv('KODAX_T17_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't17-probe',
  });
  const plane = wireClientPlane(toKodaXProductClient(runtime));
  try {
    const session = await runtime.sessions.create({ title: 'T17 stop', surface: 'repl', projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, {
      agentMode: 'sa', permissionMode: 'full-access',
    });
    const controller = new AbortController();
    const roundPromise = runClientPlaneRound({
      plane,
      sessionId: session.id,
      prompt: 'Long analysis.',
      abortSignal: controller.signal,
    });
    // Esc: the abort signal must translate into a Host stop request.
    await expect.poll(async () => {
      const runs = await runtime.runs.list({ sessionId: session.id });
      return runs.some((run) => run.phase === 'running');
    }, { timeout: 15_000 }).toBe(true);
    controller.abort();
    const result = await roundPromise;
    // Either the executor's own terminal result or the interrupted
    // projection — both must read as an interrupted round.
    expect(result.interrupted === true || result.success === false).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

it('queues a follow-up Host-side and rides the continuation run to its result', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-t17-queue-'));
  const resolvers: ((result: KodaXStreamResult) => void)[] = [];
  registerModelProvider('t17-probe', () => new ProbeProvider((resolve) => {
    resolvers.push(resolve);
  }));
  vi.stubEnv('KODAX_T17_KEY', 'test-key');
  const runtime = await createKodaXRuntime({
    homeDir, sharedDaemonHost: true, defaultProvider: 't17-probe',
  });
  const plane = wireClientPlane(toKodaXProductClient(runtime));
  try {
    const session = await runtime.sessions.create({ title: 'T17 queue', surface: 'repl', projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, {
      agentMode: 'sa', permissionMode: 'full-access',
    });
    const views: ClientSessionView[] = [];
    const close = await plane.observe(session.id, (view) => views.push(view));

    const roundPromise = runClientPlaneRound({
      plane, sessionId: session.id, prompt: 'First.',
    });
    // Wait until the run has reached the provider, then queue a follow-up.
    await expect.poll(() => resolvers.length, { timeout: 15_000 }).toBe(1);
    const queued = await plane.submit({
      sessionId: session.id, text: 'Follow-up.', inputId: 'ink-followup', delivery: 'after_turn',
    });
    expect(queued.runId).toBeUndefined();
    // The queued input is visible to every observer before delivery.
    await expect.poll(() =>
      views.some((view) => view.queue.some((entry) => entry.inputId === 'ink-followup')),
    { timeout: 15_000 }).toBe(true);

    resolvers[0]!({
      textBlocks: [{ type: 'text', text: 'First answer.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    });
    // The Host batches the queued text into a continuation run.
    await expect.poll(() => resolvers.length, { timeout: 15_000 }).toBe(2);
    resolvers[1]!({
      textBlocks: [{ type: 'text', text: 'Second answer.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    });
    const result = await roundPromise;
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Second answer.');
    close();
  } finally {
    vi.unstubAllEnvs();
    clearRuntimeModelProviders();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
