import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, type KodaXStreamResult } from '@kodax-ai/llm';
import { LEARNING_REVIEW_TOOL, awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

it('captures execution defaults per Run while a global patch waits for the next admission', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-run-config-boundary-'));
  const sample = join(homeDir, 'sample.txt');
  await writeFile(sample, 'Evidence');
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: number[] = [];
  class Provider extends KodaXBaseProvider {
    readonly name = 'config-boundary'; readonly supportsThinking = false;
    protected readonly config = { apiKeyEnv: 'KODAX_CONFIG_BOUNDARY_KEY', model: 'fixture', supportsThinking: false };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      if (!args[1].some(tool => tool.name === LEARNING_REVIEW_TOOL.name)) {
        requests.push(this.getEffectiveMaxOutputTokens());
        if (requests.length === 1) {
          enter(); await held;
          return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{
            type: 'tool_use', id: 'read', name: 'read', input: { path: sample },
          }] };
        }
      }
      return { textBlocks: [{ type: 'text', text: 'Evidence retained.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  const unregister = registerModelProvider('config-boundary', () => new Provider());
  vi.stubEnv('KODAX_CONFIG_BOUNDARY_KEY', 'fixture');
  vi.stubEnv('KODAX_MAX_OUTPUT_TOKENS', undefined);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'config-boundary' });
  try {
    const client = toKodaXProductClient(runtime);
    await client.config.patch({ maxOutputTokens: 1234 });
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { agentMode: 'sa', reasoningMode: 'off', permissionMode: 'full-access' });
    const first = await client.inputs.submit({ sessionId: session.id, inputId: 'held', text: 'Read the evidence.' });
    await entered;
    await client.config.patch({ maxOutputTokens: 2345 });
    await client.config.reload();
    release();
    expect((await client.runs.await(first.runId!)).phase).toBe('completed');
    const next = await client.inputs.submit({ sessionId: session.id, inputId: 'next', text: 'Reply briefly.' });
    expect((await client.runs.await(next.runId!)).phase).toBe('completed');
    expect(requests).toEqual([1234, 1234, 2345]);
  } finally {
    release(); await runtime.close(); await awaitLatestCodingMemoryReviewDrain(5_000);
    unregister(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
