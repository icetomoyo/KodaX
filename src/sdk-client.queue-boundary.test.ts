import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider, registerCustomProviders,
  type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult, type KodaXToolDefinition,
  type KodaXProviderStreamOptions, type KodaXReasoningRequest,
} from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL, awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';

it.each((['sa', 'ama'] as const).flatMap(agentMode =>
  (['deliver', 'skill-barrier', 'withdraw-race', 'stop', 'failure'] as const).map(behavior => ({ agentMode, behavior }))))
('handles $behavior at the next Provider boundary of a $agentMode Run', async ({ agentMode, behavior }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-next-request-'));
  const providerName = 'next-request-test';
  let releaseFirst: () => void = () => {};
  let releaseSecond: () => void = () => {};
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const requests: KodaXMessage[][] = [];
  const views: ClientSessionView[] = [];
  let closeObservation = () => {};
  class BoundaryProvider extends KodaXBaseProvider {
    readonly name = providerName;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_NEXT_REQUEST_TEST_KEY', model: 'next-request-test', supportsThinking: false,
    };
    async stream(messages: KodaXMessage[], tools: KodaXToolDefinition[], _system: string,
      _reasoning?: boolean | KodaXReasoningRequest, options?: KodaXProviderStreamOptions): Promise<KodaXStreamResult> {
      if (tools.some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) return {
        textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'review', name: LEARNING_REVIEW_TOOL.name,
          input: { memoryPlan: { actions: [], warnings: [] }, capabilityDecision: { disposition: 'discard' } },
        }],
      };
      requests.push(structuredClone(messages));
      if (requests.length === 1) {
        await firstGate;
        if (behavior === 'failure') throw new Error('Provider failed before the boundary');
        return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
          type: 'tool_use', id: 'list', name: 'glob', input: { pattern: '*.png', path: homeDir },
        }] };
      }
      if (requests.length === 2) {
        options?.onTextDelta?.('Partial after boundary');
        await secondGate;
      }
      return { textBlocks: [{ type: 'text', text: 'Done.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_NEXT_REQUEST_TEST_KEY', 'test-only');
  registerModelProvider(providerName, () => new BoundaryProvider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: providerName });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated queue Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-next-request-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
  registerCustomProviders([{ name: providerName, protocol: 'openai', baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'KODAX_NEXT_REQUEST_TEST_KEY', model: providerName, imageInput: true }]);
  try {
    const imagePath = path.join(homeDir, 'queued.png');
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYz8AAAAASUVORK5CYII=', 'base64'));
    const session = await client.sessions.create({ projectPath: homeDir });
    const observation = await client.sessions.observe(session.id, view => views.push(view));
    closeObservation = () => observation.close();
    await client.sessions.updateSettings(session.id, { agentMode, permissionMode: 'full-access' });
    const active = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'List the image, then report.' });
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
    const followup = { sessionId: session.id, inputId: 'withdraw-me', text: 'Use this image in your next response.',
      delivery: 'after_turn' as const, inputArtifacts: [{ kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const }] };
    expect(await client.inputs.submit(followup)).toMatchObject({ state: 'queued' });
    expect(await client.inputs.withdraw(session.id, followup.inputId)).toMatchObject(followup);
    expect(await client.inputs.read(session.id, followup.inputId)).toMatchObject({ state: 'withdrawn' });
    await client.inputs.submit({ ...followup, inputId: 'followup' });
    if (behavior === 'skill-barrier') {
      await client.inputs.withdraw(session.id, 'followup');
      await client.inputs.submit({ ...followup, inputId: 'skill', text: '/inspect' });
      await client.inputs.submit({ ...followup, inputId: 'after-skill' });
    }
    const withdrawal = behavior === 'withdraw-race'
      ? client.inputs.withdraw(session.id, 'followup').then(() => true, () => false) : undefined;
    if (behavior === 'stop') await client.runs.stop(active.runId!);
    releaseFirst();
    if (behavior === 'stop' || behavior === 'failure') {
      await runtime.runs.await(active.runId!);
      expect(await client.inputs.read(session.id, 'followup')).toMatchObject({ state: 'queued' });
      expect(requests).toHaveLength(1);
      await client.inputs.withdraw(session.id, 'followup');
      return;
    }
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(2);
    if (behavior === 'skill-barrier') {
      expect(requests[1]!.some(message => message.inputId === 'skill' || message.inputId === 'after-skill')).toBe(false);
      expect(await client.inputs.read(session.id, 'skill')).toMatchObject({ state: 'queued' });
      expect(await client.inputs.read(session.id, 'after-skill')).toMatchObject({ state: 'queued' });
      await client.inputs.withdraw(session.id, 'skill');
      await client.inputs.withdraw(session.id, 'after-skill');
      return;
    }
    if (withdrawal && await withdrawal) {
      expect(requests[1]!.some(message => message.inputId === 'followup')).toBe(false);
      expect(await client.inputs.read(session.id, 'followup')).toMatchObject({ state: 'withdrawn' });
      return;
    }
    // The second request is still running: waiting for the whole Run would be too late.
    const injected = requests[1]!.find(message => message.inputId === 'followup');
    expect(injected).toBeDefined();
    expect(JSON.stringify(injected?.content)).toContain(followup.text);
    expect(Array.isArray(injected?.content) && injected.content.some(block => block.type === 'image' && block.path === imagePath)).toBe(true);
    expect(await client.inputs.read(session.id, 'followup')).toMatchObject({ state: 'submitted', runId: active.runId });
    await expect.poll(() => views.at(-1)?.items.find(item => item.text === 'Partial after boundary')?.afterInputId).toBe('followup');
    // Live deltas may arrive while a canonical history reload is in flight.
    // Observe convergence without a read or another input stimulating refresh.
    await expect.poll(() => {
      const current = views.at(-1)?.items ?? [];
      const inputIndex = current.findIndex(item => item.inputId === 'followup');
      const partialIndex = current.findIndex(item => item.text === 'Partial after boundary');
      return inputIndex >= 0 && current[inputIndex]!.text.includes(followup.text) && inputIndex < partialIndex;
    }, { timeout: 3_000 }).toBe(true);
    const items = views.at(-1)!.items;
    const inputIndex = items.findIndex(item => item.inputId === 'followup');
    expect(inputIndex).toBeGreaterThanOrEqual(0);
    expect(items[inputIndex]?.text).toContain(followup.text);
    expect(inputIndex).toBeLessThan(items.findIndex(item => item.text === 'Partial after boundary'));
    await expect(client.inputs.withdraw(session.id, 'followup')).rejects.toMatchObject({ code: 'conflict' });
    const transcript = await runtime.sessions.transcript(session.id);
    expect(transcript?.messages.filter(message => message.inputId === 'followup')).toHaveLength(1);
    expect(transcript?.messages.some(message => message.inputId === 'withdraw-me')).toBe(false);
  } finally {
    closeObservation();
    releaseFirst();
    releaseSecond();
    await client.disconnect();
    await host.close();
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders();
    registerCustomProviders([]);
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
