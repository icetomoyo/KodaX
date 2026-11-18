import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain, LEARNING_REVIEW_TOOL } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from "./runtime-fixture.js";
import { startRuntimeDaemonHost } from '../src/runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from '../src/runtime-daemon/state.js';

interface AdmissionHost {
  readonly runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
  readonly client: Awaited<ReturnType<typeof connectKodaXClient>>;
  readonly mainRequests: string[];
  holdNextRequest(): void;
  release(): void;
  close(): Promise<void>;
}

async function startAdmissionHost(homeDir: string): Promise<AdmissionHost> {
  const mainRequests: string[] = [];
  let holdNext = false;
  let release = () => {};
  class AdmissionProvider extends KodaXBaseProvider {
    readonly name = 'ama-admission-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_AMA_ADMISSION_TEST_KEY', model: 'fixture', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: randomUUID(), name: LEARNING_REVIEW_TOOL.name,
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
        }],
      };
      mainRequests.push(args[2]);
      if (holdNext) {
        holdNext = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('ama-admission-test', () => new AdmissionProvider());
  vi.stubEnv('KODAX_AMA_ADMISSION_TEST_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'ama-admission-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Could not acquire isolated admission Host.');
  const endpointPath = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-ama-admission-${randomUUID()}` : path.join(homeDir, 'host.sock');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: { kind: process.platform === 'win32' ? 'pipe' : 'unix', path: endpointPath } });
  const client = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  return {
    runtime, client, mainRequests,
    holdNextRequest: () => { holdNext = true; },
    release: () => release(),
    close: async () => {
      release();
      await client.disconnect();
      await host.close();
      await runtime.close();
      await awaitLatestCodingMemoryReviewDrain(5_000);
      unregister();
      vi.unstubAllEnvs();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

it('runs Product turns as AMA when a legacy config.json still selects sa', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-admission-'));
  await mkdir(path.join(homeDir, '.kodax'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'config.json'), JSON.stringify({ agentMode: 'sa' }), 'utf8');
  const { runtime, client, close } = await startAdmissionHost(homeDir);
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const turn = await client.inputs.submit({ sessionId: session.id, inputId: 'legacy-config', text: 'Reply briefly.' });
    expect((await runtime.runs.get(turn.runId!)).mode).toBe('managed_task');
    expect((await runtime.runs.await(turn.runId!)).phase).toBe('completed');
    let displayedMode: string | undefined;
    const observation = await client.sessions.observe(session.id, view => { displayedMode = view.settings.agentMode; });
    expect(displayedMode).toBe('ama');
    observation.close();
  } finally {
    await close();
  }
});

it('defaults Product turns to AMA, ignores a retired sa setting and keeps explicit direct Runs', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-admission-'));
  const { runtime, client, mainRequests, holdNextRequest, release, close } = await startAdmissionHost(homeDir);
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const first = await client.inputs.submit({ sessionId: session.id, inputId: 'first', text: 'Reply briefly.' });
    expect(first.runId).toBeDefined();
    expect((await runtime.runs.get(first.runId!)).mode).toBe('managed_task');
    expect((await runtime.runs.await(first.runId!)).phase).toBe('completed');
    await awaitLatestCodingMemoryReviewDrain(5_000);
    expect(mainRequests).toHaveLength(1);
    let displayedMode: string | undefined;
    const observation = await client.sessions.observe(session.id, view => { displayedMode = view.settings.agentMode; });
    expect(displayedMode).toBe('ama');
    observation.close();
    expect(await runtime.sessions.getSettings(session.id)).not.toHaveProperty('agentMode');
    expect(await runtime.config.read()).not.toHaveProperty('agentMode');

    await runtime.sessions.updateSettings(session.id, { agentMode: 'sa' });
    holdNextRequest();
    const legacyInput = await client.inputs.submit({ sessionId: session.id, inputId: 'sdk-legacy', text: 'Legacy held turn.' });
    await expect.poll(() => mainRequests.length).toBe(2);
    expect((await runtime.runs.get(legacyInput.runId!)).mode).toBe('managed_task');
    const runningObservation = await client.sessions.observe(session.id, view => { displayedMode = view.settings.agentMode; });
    expect(displayedMode).toBe('ama');
    release();
    expect((await runtime.runs.await(legacyInput.runId!)).phase).toBe('completed');
    runningObservation.close();

    const direct = await runtime.runs.start({ sessionId: session.id, prompt: 'Direct engine turn.', mode: 'coding' });
    expect((await runtime.runs.get(direct.runId)).mode).toBe('coding');
    expect((await direct.result).phase).toBe('completed');
  } finally {
    await close();
  }
});
