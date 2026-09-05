import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it.each([
  { agentMode: 'sa', compact: false },
  { agentMode: 'ama', compact: false },
  { agentMode: 'ama', compact: true },
] as const)('applies live $agentMode Session settings at the next request (compaction: $compact)', async ({ agentMode, compact }) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-live-settings-'));
  const samples = Array.from({ length: 3 }, (_, index) => path.join(homeDir, `sample-${index}.txt`));
  await Promise.all(samples.map((sample, index) => writeFile(sample, `sample content ${index}`)));
  const requests: { provider: string; model: string | undefined; reasoning: Parameters<KodaXBaseProvider['stream']>[3] }[] = [];
  const entered = Array.from({ length: 4 }, gate);
  const release = Array.from({ length: 4 }, gate);
  let seedingHistory = compact;
  class LiveSettingsProvider extends KodaXBaseProvider {
    readonly supportsThinking = true;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_LIVE_SETTINGS_TEST_KEY', model: 'provider-default', supportsThinking: true,
    };
    constructor(readonly name: string) { super(); }
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (args[1].some((tool) => tool.name === 'emit_sidecar_verdict')) return {
        textBlocks: [], thinkingBlocks: [],
        toolBlocks: [{ type: 'tool_use', id: 'verdict', name: 'emit_sidecar_verdict', input: { verdict: 'accept' } }],
        stopReason: 'tool_use',
      };
      if (seedingHistory) return {
        textBlocks: [{ type: 'text', text: 'Historical context from prior work. '.repeat(8_000) }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
      };
      const index = requests.length;
      const request = { provider: this.name, model: args[4]?.modelOverride, reasoning: typeof args[3] === 'object' ? { enabled: args[3].enabled, effort: args[3].effort } : args[3] };
      requests.push(request);
      entered[index]?.resolve();
      await release[index]?.promise;
      expect(args[4]?.modelOverride).toBe(request.model);
      if (typeof request.reasoning === 'object') expect(args[3]).toMatchObject(request.reasoning);
      else expect(args[3]).toBe(request.reasoning);
      return index < (compact ? 1 : 3)
        ? { textBlocks: [], thinkingBlocks: [], toolBlocks: [{ type: 'tool_use', id: `read-${index}`, name: 'read', input: { path: samples[index] } }], stopReason: 'tool_use',
            ...(compact ? { usage: { inputTokens: 129_900, outputTokens: 100, totalTokens: 130_000 } } : {}) }
        : { textBlocks: [{ type: 'text', text: 'Read sample content.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  for (const name of ['live-settings-first', 'live-settings-next']) {
    registerModelProvider(name, () => new LiveSettingsProvider(name));
  }
  vi.stubEnv('KODAX_LIVE_SETTINGS_TEST_KEY', 'test-only');
  const profile = 'live-settings';
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
    if (!lock) throw new Error('Could not acquire isolated test Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-live-settings-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const session = await client.sessions.create({ title: 'Live settings', projectPath: homeDir });
        if (compact) {
          await client.sessions.updateSettings(session.id, { provider: 'live-settings-first', agentMode: 'sa', permissionMode: 'full-access' });
          const previous = await client.inputs.submit({ sessionId: session.id, inputId: 'history', text: 'Describe the prior work context.' });
          if (previous.runId === undefined) throw new Error('Expected a prior history Run.');
          await runtime.runs.await(previous.runId);
          await awaitLatestCodingMemoryReviewDrain(5_000);
          seedingHistory = false;
        }
        await client.sessions.updateSettings(session.id, {
          provider: 'live-settings-first', model: 'initial-model', effort: 'low',
          permissionMode: 'full-access', agentMode,
          ...(compact ? { compactionTriggerTokens: 120_000 } : {}),
        });
        const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'read-input', text: 'Read sample-0.txt, sample-1.txt and sample-2.txt and briefly report their content. Do not modify files.' });
        if (accepted.runId === undefined) throw new Error('An idle Session must start the submitted input.');
        expect((await runtime.runs.get(accepted.runId)).mode).toBe(agentMode === 'ama' ? 'managed_task' : 'coding');
        await entered[0]!.promise;
        const first = { provider: 'live-settings-first', model: 'initial-model', reasoning: { enabled: true, effort: 'low' } };
        expect(requests[0]).toEqual(first);
        await client.sessions.updateSettings(session.id, { provider: 'live-settings-next', model: 'next-model', effort: 'none' });
        expect(requests[0]).toEqual(first);
        release[0]!.resolve();
        await entered[1]!.promise;
        expect(requests[1]).toEqual({ provider: 'live-settings-next', model: 'next-model', reasoning: { enabled: false, effort: 'none' } });
        if (compact) {
          expect(await runtime.events.replay({ sessionId: session.id, type: 'context.compaction.started' })).not.toHaveLength(0);
          release[1]!.resolve();
          await entered[2]!.promise;
          expect(requests[2]).toEqual({ provider: 'live-settings-next', model: 'next-model', reasoning: { enabled: false, effort: 'none' } });
          release[2]!.resolve();
          expect((await runtime.runs.await(accepted.runId)).phase).toBe('completed');
          return;
        }
        await client.sessions.updateSettings(session.id, { effort: null, reasoningMode: 'quick' });
        release[1]!.resolve();
        await entered[2]!.promise;
        expect(requests[2]?.reasoning).toEqual({ enabled: true, effort: 'low' });
        await client.sessions.updateSettings(session.id, { reasoningMode: null, thinking: false, model: null });
        release[2]!.resolve();
        await entered[3]!.promise;
        expect(requests[3]).toEqual({ provider: 'live-settings-next', model: undefined, reasoning: { enabled: false, effort: 'none' } });
        release[3]!.resolve();
        expect((await runtime.runs.await(accepted.runId)).phase).toBe('completed');
      } finally {
        release.forEach((item) => item.resolve());
        await client.disconnect();
      }
    } finally {
      await host.close();
    }
  } finally {
    await runtime.close();
    await awaitLatestCodingMemoryReviewDrain(5_000);
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 20_000);
