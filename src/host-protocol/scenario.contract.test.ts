/**
 * One set of scenarios, driven over v1 and over v2 against the same real Host.
 * A scenario speaks only the driver below, so a difference between the two
 * protocols in what the Host does shows up as one of them failing.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';

import { createKodaXRuntime } from '../../tests/runtime-fixture.js';
import { startRuntimeDaemonHost, type RuntimeDaemonHost } from '../runtime-daemon/host.js';
import {
  createRuntimeDaemonSocketClientTransport, dialRuntimeDaemonHostRpc, RuntimeDaemonTransportError, type RuntimeDaemonEndpoint,
} from '../runtime-daemon/transport.js';
import type { RuntimeDaemonMethod } from '../runtime-daemon/protocol.js';
import { readRuntimeDaemonToken, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from '../runtime-daemon/state.js';
import { connectHostRpc } from './client.js';
import { HostProtocolError } from './codec.js';
import { createKodaXHostClient, createRequestId, type KodaXHostClient } from './host-client.js';

/** What a scenario can do and see, in terms neither protocol owns. */
interface ScenarioDriver {
  createSession(requestId: string, title: string): Promise<string>;
  sessionTitle(sessionId: string): Promise<string | undefined>;
  sessionIds(): Promise<readonly string[]>;
  archive(sessionId: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  settings(sessionId: string): Promise<{ readonly revision: string; readonly permissionMode?: string }>;
  updateSettings(sessionId: string, patch: { readonly permissionMode: string }, ifRevision: string): Promise<string>;
  submit(sessionId: string, requestId: string, text: string): Promise<string>;
  waitRun(runId: string): Promise<RunFacts>;
  run(runId: string): Promise<RunFacts>;
  stopRun(runId: string): Promise<void>;
  interactions(sessionId: string): Promise<ReadonlyArray<{ readonly id: string; readonly kind: string }>>;
  answer(interactionId: string, answer: string): Promise<string>;
  conversation(sessionId: string): Promise<ReadonlyArray<{ readonly type: string; readonly text: string }>>;
  close(): void;
}

interface RunFacts {
  readonly phase: string;
  /** How it ended; absent while it has not. */
  readonly ended?: string;
  readonly stopConfirmed?: boolean;
}

/** The error a scenario can expect, without the protocol's own code for it. */
type Refusal = 'stale_revision' | 'not_found' | 'other';

const MODEL = 'scenario-model';
const ENDED_PHASES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function refusalOf(error: unknown): Refusal {
  if (error instanceof HostProtocolError) {
    if (error.kodaxCode === 'conflict' && error.reason === 'revision_mismatch') return 'stale_revision';
    return error.kodaxCode === 'not_found' ? 'not_found' : 'other';
  }
  if (error instanceof RuntimeDaemonTransportError) {
    const conflict = typeof error.data === 'object' && error.data !== null ? (error.data as { conflict?: unknown }).conflict : undefined;
    if (error.code === 'conflict' && conflict === 'revision_conflict') return 'stale_revision';
    return error.code === 'not_found' ? 'not_found' : 'other';
  }
  return 'other';
}

async function refusal(work: Promise<unknown>): Promise<Refusal | undefined> {
  return work.then(() => undefined, refusalOf);
}

interface V1Session { readonly id: string; readonly title?: string }
interface V1Run {
  readonly phase: string;
  readonly terminal?: { readonly kind: string };
  readonly stop?: { readonly state: string };
}

async function v1Driver(endpoint: RuntimeDaemonEndpoint, token: string, projectRoot: string): Promise<ScenarioDriver> {
  const transport = await createRuntimeDaemonSocketClientTransport(endpoint);
  const call = async <T>(method: RuntimeDaemonMethod, params?: Readonly<Record<string, unknown>>): Promise<T> => (
    await transport.request(method, params) as T
  );
  await call('initialize', { token, clientInfo: { name: 'scenario-v1', instanceId: `scenario-v1-${randomUUID()}` } });
  const runFacts = (status: V1Run): RunFacts => {
    const ended = status.terminal?.kind ?? (ENDED_PHASES.has(status.phase) ? status.phase : undefined);
    return {
      phase: status.phase,
      ...(ended !== undefined ? { ended } : {}),
      ...(status.stop !== undefined ? { stopConfirmed: status.stop.state === 'confirmed' } : {}),
    };
  };
  const run = async (runId: string): Promise<RunFacts> => runFacts(await call<V1Run>('run.get', { runId }));
  return {
    createSession: async (requestId, title) => (await call<V1Session>('session.create', { requestId, title, projectPath: projectRoot })).id,
    sessionTitle: async sessionId => (await call<V1Session>('session.load', { sessionId })).title,
    sessionIds: async () => (await call<readonly V1Session[]>('session.list', {})).map(session => session.id),
    archive: async (sessionId) => { await call('session.archive', { sessionId }); },
    unarchive: async (sessionId) => { await call('session.unarchive', { sessionId }); },
    remove: async (sessionId) => { await call('session.delete', { sessionId }); },
    settings: async (sessionId) => {
      const { revision, value } = await call<{ revision: number; value: { permissionMode?: string } }>(
        'session.settings.getVersioned', { sessionId });
      return { revision: String(revision), ...(value.permissionMode !== undefined ? { permissionMode: value.permissionMode } : {}) };
    },
    updateSettings: async (sessionId, patch, ifRevision) => String((await call<{ revision: number }>(
      'session.settings.updateVersioned', { sessionId, patch, expectedRevision: Number(ifRevision) })).revision),
    submit: async (sessionId, requestId, text) => {
      const accepted = await call<{ runId?: string }>('input.submit', { sessionId, inputId: requestId, text });
      return accepted.runId!;
    },
    waitRun: async (runId) => {
      await call('run.await', { runId });
      return run(runId);
    },
    run,
    stopRun: async (runId) => { await call('run.abort', { runId }); },
    interactions: async sessionId => (await call<ReadonlyArray<{ requestId: string; kind: string }>>('interaction.list', { sessionId }))
      .map(interaction => ({ id: interaction.requestId, kind: interaction.kind })),
    answer: async (interactionId, answer) => (await call<{ status: string }>('interaction.respond', {
      requestId: interactionId, response: { kind: 'question', answer },
    })).status,
    conversation: async (sessionId) => {
      const subscriptionId = `scenario-${randomUUID()}`;
      const { view } = await call<{ view: { items: ReadonlyArray<{ type: string; text?: string }> } }>(
        'session.view.observe', { sessionId, subscriptionId });
      await call('session.view.close', { subscriptionId });
      return spoken(view.items);
    },
    close: () => { void transport.close?.(); },
  };
}

async function v2Driver(endpoint: RuntimeDaemonEndpoint, token: string, projectRoot: string): Promise<ScenarioDriver> {
  const client: KodaXHostClient<'local'> = await createKodaXHostClient<'local'>({
    open: () => connectHostRpc(dialRuntimeDaemonHostRpc(endpoint), {
      client: { name: 'scenario-v2', version: '1.0.0', instanceId: `scenario-v2-${randomUUID()}` },
      auth: { scheme: 'ipc', token },
    }),
  });
  const runFacts = (run: { phase: string; outcome?: { status: string }; stop?: { confirmed: boolean } }): RunFacts => ({
    phase: run.phase,
    ...(run.outcome !== undefined ? { ended: run.outcome.status } : {}),
    ...(run.stop !== undefined ? { stopConfirmed: run.stop.confirmed } : {}),
  });
  return {
    createSession: async (requestId, title) => (await client.call('session.create', { requestId, title, projectRoot })).session.id,
    sessionTitle: async sessionId => (await client.call('session.get', { sessionId })).session.title,
    sessionIds: async () => (await client.call('session.list', {})).items.map(session => session.id),
    archive: async (sessionId) => { await client.call('session.archive', { requestId: createRequestId(), sessionId }); },
    unarchive: async (sessionId) => { await client.call('session.unarchive', { requestId: createRequestId(), sessionId }); },
    remove: async (sessionId) => { await client.call('session.delete', { requestId: createRequestId(), sessionId }); },
    settings: async (sessionId) => {
      const { revision, settings } = await client.call('session.settings.get', { sessionId });
      return { revision, ...(settings.permissionMode !== undefined ? { permissionMode: settings.permissionMode } : {}) };
    },
    updateSettings: async (sessionId, patch, ifRevision) => (await client.call('session.settings.update', {
      requestId: createRequestId(), sessionId, patch: patch as never, ifRevision,
    })).revision,
    submit: async (sessionId, requestId, text) => (await client.call('input.submit', { requestId, sessionId, text })).input.runId!,
    waitRun: async runId => runFacts((await client.call('run.wait', { runId })).run),
    run: async runId => runFacts((await client.call('run.get', { runId })).run),
    stopRun: async (runId) => { await client.call('run.stop', { requestId: createRequestId(), runId }); },
    interactions: async sessionId => (await client.call('interaction.list', { sessionId })).items
      .map(interaction => ({ id: interaction.id, kind: interaction.kind })),
    answer: async (interactionId, answer) => (await client.call('interaction.respond', {
      requestId: createRequestId(), interactionId, response: { kind: 'question', answer },
    })).status,
    conversation: async (sessionId) => {
      let first: ReadonlyArray<{ type: string; text?: string }> = [];
      const observation = await client.observeSession(sessionId, { onView: (view) => { first = view.items; } });
      observation.close();
      return spoken(first);
    },
    close: () => client.close(),
  };
}

/** What the person and the model said, in order. */
function spoken(items: ReadonlyArray<{ readonly type: string; readonly text?: string }>) {
  return items.filter(item => item.type === 'user' || item.type === 'assistant')
    .map(item => ({ type: item.type, text: item.text ?? '' }));
}

const DRIVERS = { v1: v1Driver, v2: v2Driver } as const;

/** How the scripted model answers a request: at once, by asking a question, or not until it is stopped. */
type ModelMode = 'answer' | 'ask' | 'hold';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
}, 60_000);

/** A real Host on a temporary home, with a scripted model and either protocol's driver. */
async function scenarioHost(protocol: keyof typeof DRIVERS, mode: ModelMode) {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-scenario-')));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const model = scriptedModel(mode);
  vi.stubEnv('KODAX_SCENARIO_KEY', 'offline-test');
  vi.stubEnv('KODAX_HOME', path.join(homeDir, '.kodax'));
  const unregister = registerModelProvider(MODEL, () => model.provider());
  cleanup.push(async () => {
    model.releaseAll();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister();
    vi.unstubAllEnvs();
  });

  let host: RuntimeDaemonHost | undefined;
  const start = async (): Promise<void> => {
    const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: MODEL });
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('The scenario Host could not take its home.');
    const endpoint: RuntimeDaemonEndpoint = process.platform === 'win32'
      ? { kind: 'pipe', path: `\\\\.\\pipe\\kodax-scenario-${randomUUID()}` }
      : { kind: 'unix', path: path.join(homeDir, `host-${randomUUID().slice(0, 8)}.sock`) };
    host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  };
  const stop = async (): Promise<void> => {
    const running = host;
    host = undefined;
    await running?.close();
  };
  cleanup.push(stop);
  await start();

  return {
    homeDir,
    model,
    /** A new client of the running Host. */
    connect: async (): Promise<ScenarioDriver> => {
      const token = readRuntimeDaemonToken(paths);
      if (token === undefined || host === undefined) throw new Error('The scenario Host is not running.');
      const driver = await DRIVERS[protocol](host.endpoint, token, homeDir);
      cleanup.push(() => driver.close());
      return driver;
    },
    restart: async (): Promise<void> => {
      await stop();
      await start();
    },
  };
}

function scriptedModel(mode: ModelMode) {
  let calls = 0;
  const held = new Set<() => void>();
  class ScriptedProvider extends KodaXBaseProvider {
    readonly name = MODEL;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_SCENARIO_KEY', model: MODEL, supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const [messages, tools, , , , signal] = args;
      // The Host's own review after a Run is not the conversation under test.
      if (tools.some(tool => tool.name === 'commit_episode_learning_review')) {
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'review', name: 'commit_episode_learning_review',
          input: { memoryPlan: { actions: [], warnings: [] } },
        }] };
      }
      calls += 1;
      if (mode === 'hold') {
        // As a real provider does, a held call ends when it is aborted.
        await new Promise<void>((resolve, reject) => {
          const release = (): void => { held.delete(release); resolve(); };
          held.add(release);
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => { held.delete(release); reject(signal.reason); }, { once: true });
        });
      }
      const last = messages.at(-1)?.content;
      const answered = Array.isArray(last) && last.some(block => block.type === 'tool_result');
      if (mode === 'ask' && !answered) {
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'ask-1', name: 'ask_user_question',
          input: { question: 'Which colour?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] },
        }] };
      }
      return { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  return {
    provider: () => new ScriptedProvider(),
    /** Turns of the conversation the model was asked for. */
    calls: () => calls,
    releaseAll: () => { for (const release of [...held]) release(); },
  };
}

describe.each(Object.keys(DRIVERS) as Array<keyof typeof DRIVERS>)('Host scenarios over %s', (protocol) => {
  it('creates a Session once per requestId, and archives, restores and deletes it', async () => {
    const host = await scenarioHost(protocol, 'answer');
    const client = await host.connect();
    const requestId = createRequestId();
    const sessionId = await client.createSession(requestId, 'Report');
    expect(await client.createSession(requestId, 'Report')).toBe(sessionId);
    expect(await client.sessionTitle(sessionId)).toBe('Report');
    expect(await client.sessionIds()).toEqual([sessionId]);

    await client.archive(sessionId);
    expect(await client.sessionIds()).toEqual([]);
    await client.unarchive(sessionId);
    expect(await client.sessionIds()).toEqual([sessionId]);
    await client.remove(sessionId);
    expect(await client.sessionIds()).toEqual([]);
    expect(await refusal(client.sessionTitle(sessionId))).toBe('not_found');
  });

  it('starts one Run per requestId, also when it is sent again after the Host restarted', async () => {
    const host = await scenarioHost(protocol, 'answer');
    const before = await host.connect();
    const sessionId = await before.createSession(createRequestId(), 'Work');
    const requestId = createRequestId();
    const runId = await before.submit(sessionId, requestId, 'Do the work.');
    expect(await before.submit(sessionId, requestId, 'Do the work.')).toBe(runId);
    expect(await before.waitRun(runId)).toMatchObject({ ended: 'completed' });

    await host.restart();
    const after = await host.connect();
    expect(await after.submit(sessionId, requestId, 'Do the work.')).toBe(runId);
    expect(host.model.calls()).toBe(1);
    expect(await after.conversation(sessionId)).toEqual([
      { type: 'user', text: 'Do the work.' },
      { type: 'assistant', text: 'done' },
    ]);
  });

  it('changes settings only from the revision the change was based on', async () => {
    const host = await scenarioHost(protocol, 'answer');
    const client = await host.connect();
    const sessionId = await client.createSession(createRequestId(), 'Settings');
    const { revision } = await client.settings(sessionId);

    const next = await client.updateSettings(sessionId, { permissionMode: 'accept-edits' }, revision);
    expect(next).not.toBe(revision);
    expect(await refusal(client.updateSettings(sessionId, { permissionMode: 'plan' }, revision))).toBe('stale_revision');
    expect(await client.settings(sessionId)).toEqual({ revision: next, permissionMode: 'accept-edits' });
  });

  it('settles a question with the first answer from any client of the person', async () => {
    const host = await scenarioHost(protocol, 'ask');
    const first = await host.connect();
    const second = await host.connect();
    const sessionId = await first.createSession(createRequestId(), 'Question');
    const runId = await first.submit(sessionId, createRequestId(), 'Ask me.');
    const [question] = await vi.waitFor(async () => {
      const pending = await second.interactions(sessionId);
      expect(pending).toHaveLength(1);
      return pending;
    }, { timeout: 10_000, interval: 20 });
    expect(question!.kind).toBe('question');

    expect(await second.answer(question!.id, 'red')).toBe('answered');
    expect(await first.answer(question!.id, 'blue')).toBe('already_resolved');
    expect(await first.waitRun(runId)).toMatchObject({ ended: 'completed' });
    expect(await first.interactions(sessionId)).toEqual([]);
  });

  it('stops a Run and records that the stop took effect', async () => {
    const host = await scenarioHost(protocol, 'hold');
    const client = await host.connect();
    const sessionId = await client.createSession(createRequestId(), 'Stop');
    const runId = await client.submit(sessionId, createRequestId(), 'Work until stopped.');
    await vi.waitFor(() => expect(host.model.calls()).toBe(1), { timeout: 10_000, interval: 20 });

    await client.stopRun(runId);
    // Stopped part-way through its work, so `interrupted`; `cancelled` is a Run stopped before it began.
    expect(await client.waitRun(runId)).toEqual({ phase: 'interrupted', ended: 'interrupted', stopConfirmed: true });
    // Asking again changes nothing.
    await client.stopRun(runId);
    expect(await client.run(runId)).toEqual({ phase: 'interrupted', ended: 'interrupted', stopConfirmed: true });
  });
});
