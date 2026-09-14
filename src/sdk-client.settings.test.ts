import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class SettingsTestProvider extends KodaXBaseProvider {
  readonly name = 'product-settings-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_SETTINGS_TEST_KEY', model: 'initial-model', supportsThinking: false,
  };
  constructor(private readonly models: (string | undefined)[]) { super(); }
  async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
    this.models.push(args[4]?.modelOverride);
    return {
      textBlocks: [{ type: 'text', text: 'Settings applied.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

it('applies Session settings to the next actual request without changing another Session or saved defaults', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-settings-'));
  const profile = 'settings-contract';
  const requestedModels: (string | undefined)[] = [];
  registerModelProvider('product-settings-test', () => new SettingsTestProvider(requestedModels));
  vi.stubEnv('KODAX_PRODUCT_SETTINGS_TEST_KEY', 'test-only');
  const runtime = await createKodaXRuntime({ homeDir, profile, sharedDaemonHost: true });
  try {
    const paths = resolveRuntimeDaemonPaths(homeDir, profile);
    const lock = tryAcquireRuntimeDaemonLock(paths, {
      runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
    });
    if (!lock) throw new Error('Could not acquire isolated test Host.');
    const endpoint = process.platform === 'win32'
      ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-settings-${randomUUID()}` }
      : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
    const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
    try {
      const client = await connectKodaXClient({ homeDir, profile, endpoint: endpoint.path });
      try {
        const first = await client.sessions.create({ title: 'First', projectPath: homeDir });
        const second = await client.sessions.create({ title: 'Second', projectPath: homeDir });
        const initial = {
          provider: 'product-settings-test', model: 'initial-model',
          agentMode: 'sa' as const, permissionMode: 'full-access' as const,
        };
        await client.sessions.updateSettings(first.id, initial);
        await client.sessions.updateSettings(second.id, initial);
        const savedDefaults = await runtime.config.read();
        await Promise.all([
          client.sessions.updateSettings(first.id, { model: 'next-model' }),
          client.sessions.updateSettings(first.id, { effort: 'low' }),
        ]);
        expect(await client.sessions.getSettings(first.id)).toMatchObject({ model: 'next-model' });
        const snapshot = await client.sessions.getSettingsVersioned(first.id);
        const updated = await client.sessions.updateSettingsVersioned(first.id, { model: 'next-model' },
          { expectedRevision: snapshot.revision });
        expect(updated).toMatchObject({ revision: snapshot.revision + 1, value: { model: 'next-model' } });
        await expect(client.sessions.updateSettingsVersioned(first.id, { model: 'stale-model' },
          { expectedRevision: snapshot.revision })).rejects.toMatchObject({ code: 'conflict' });
        expect(await client.sessions.getSettings(first.id)).toMatchObject({ model: 'next-model' });
        expect(await client.sessions.getSettings(second.id)).toMatchObject({ model: 'initial-model' });
        for (const session of [first, second]) {
          requestedModels.length = 0;
          const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'first-input', text: 'Reply briefly.' });
          if (!accepted.runId) throw new Error('Expected an immediate Run.');
          await runtime.runs.await(accepted.runId);
          await awaitLatestCodingMemoryReviewDrain(5_000);
          expect(requestedModels.length).toBeGreaterThan(0);
          expect(new Set(requestedModels)).toEqual(new Set([session.id === first.id ? 'next-model' : 'initial-model']));
        }
        expect(await runtime.config.read()).toEqual(savedDefaults);
        await client.config.patch({ ...initial, model: 'saved-model' });
        expect(await client.config.read()).toMatchObject({ model: 'saved-model' });
        const third = await client.sessions.create({ title: 'Uses defaults', projectPath: homeDir });
        requestedModels.length = 0;
        const accepted = await client.inputs.submit({ sessionId: third.id, inputId: 'default-input', text: 'Reply briefly.' });
        if (!accepted.runId) throw new Error('Expected an immediate Run.');
        await runtime.runs.await(accepted.runId);
        await awaitLatestCodingMemoryReviewDrain(5_000);
        expect(requestedModels.length).toBeGreaterThan(0);
        expect(new Set(requestedModels)).toEqual(new Set(['saved-model']));
        expect(await client.sessions.getSettings(first.id)).toMatchObject({ model: 'next-model' });
      } finally {
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
    await rm(homeDir, { recursive: true, force: true });
  }
});
