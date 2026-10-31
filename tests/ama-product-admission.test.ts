import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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

it('defaults Product turns to AMA while preserving SDK-selected and captured direct Runs', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ama-admission-'));
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
    holdNext = true;
    const legacyInput = await client.inputs.submit({ sessionId: session.id, inputId: 'sdk-legacy', text: 'Legacy held turn.' });
    const legacy = { runId: legacyInput.runId! };
    await expect.poll(() => mainRequests.length).toBe(2);
    expect((await runtime.runs.get(legacy.runId)).mode).toBe('coding');
    const runningObservation = await client.sessions.observe(session.id, view => { displayedMode = view.settings.agentMode; });
    expect(displayedMode).toBe('sa');
    const queued = await client.inputs.submit({ sessionId: session.id, inputId: 'after-legacy', text: 'Reply briefly again.', delivery: 'after_turn' });
    expect(queued.state).toBe('queued');
    await client.sessions.updateSettings(session.id, { agentMode: 'ama' });
    expect((await runtime.runs.get(legacy.runId)).mode).toBe('coding');
    expect(displayedMode).toBe('sa');
    release();
    expect((await runtime.runs.await(legacy.runId)).phase).toBe('completed');
    await expect.poll(async () => (await client.inputs.read(session.id, 'after-legacy'))?.runId).toBeDefined();
    const next = await client.inputs.read(session.id, 'after-legacy');
    expect((await runtime.runs.get(next!.runId!)).mode).toBe('coding');
    expect((await runtime.runs.await(next!.runId!)).phase).toBe('completed');
    const fresh = await client.inputs.submit({ sessionId: session.id, inputId: 'fresh-ama', text: 'New independent turn.' });
    expect((await runtime.runs.get(fresh.runId!)).mode).toBe('managed_task');
    expect((await runtime.runs.await(fresh.runId!)).phase).toBe('completed');
    await expect.poll(() => displayedMode).toBe('ama');
    runningObservation.close();
  } finally {
    release();
    await client.disconnect();
    await host.close();
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
