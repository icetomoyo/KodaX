import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as coding from '@kodax-ai/coding';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime, type RuntimeStartRunInput } from './sdk-runtime.js';

it('rechecks admission after asynchronous goal initialization before launching any work', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-goal-admission-'));
  let signalEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const binding = vi.spyOn(coding, 'buildSessionGoalRuntimeBinding').mockImplementation(async () => {
    signalEntered(); await gate; return undefined;
  });
  let providerCalls = 0;
  class Provider extends KodaXBaseProvider {
    readonly name = 'goal-admission'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_GOAL_ADMISSION_TEST', model: 'fixture', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      providerCalls += 1;
      return { textBlocks: [{ type: 'text', text: 'Unexpected work.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_GOAL_ADMISSION_TEST', 'fixture');
  registerModelProvider('goal-admission', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'goal-admission' });
  try {
    const session = await runtime.sessions.create({ projectPath: homeDir });
    let allowed = true;
    const submission = runtime.runs.start({ sessionId: session.id,
      input: { type: 'text', text: 'Start the requested work.' },
      assertAdmission() { if (!allowed) throw Object.assign(new Error('Client exit accepted'), { code: 'conflict' }); },
    } as RuntimeStartRunInput).then(result => ({ result }), (error: unknown) => ({ error }));
    await entered;
    allowed = false;
    release();
    expect(await submission).toMatchObject({ error: { code: 'conflict' } });
    expect(providerCalls).toBe(0);
    expect(await runtime.runs.list({ sessionId: session.id })).toEqual([]);
  } finally {
    release(); binding.mockRestore(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
