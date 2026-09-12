import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import * as coding from '@kodax-ai/coding';
import { resetSkillRegistry } from '@kodax-ai/agent';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';
import { runOneShotClientTask } from './one-shot-task.js';

it('keeps a raw one-shot Skill and its cancellable preparation inside the Host Run lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-skill-'));
  const skillDir = path.join(root, '.kodax', 'skills', 'cli-helper');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'),
    '---\nname: cli-helper\ndescription: Explicit CLI helper\ndisable-model-invocation: true\n---\n!`pwd`\nHandle $ARGUMENTS.\n');
  let providerCalls = 0;
  class ProbeProvider extends KodaXBaseProvider {
    readonly name = 'one-shot-skill-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_ONE_SHOT_SKILL_KEY', model: 'one-shot-skill-test', supportsThinking: false,
    };
    async stream(): Promise<KodaXStreamResult> {
      providerCalls += 1;
      return { textBlocks: [], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_ONE_SHOT_SKILL_KEY', 'test-only');
  registerModelProvider('one-shot-skill-test', () => new ProbeProvider());
  const runtime = await createKodaXRuntime({ homeDir: root, sharedDaemonHost: true, defaultProvider: 'one-shot-skill-test' });
  const client = toKodaXProductClient(runtime);
  let preparationSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const shell = vi.spyOn(coding, 'toolBash').mockImplementation(async (_input, context) => {
    preparationSignal = context.abortSignal;
    if (!preparationSignal) throw new Error('Preparation requires the Host Run signal');
    await cleanup;
    preparationSignal.throwIfAborted();
    return 'prepared';
  });
  let pending: Promise<unknown> | undefined;
  try {
    const session = await client.sessions.create({ projectPath: root, title: 'Raw Skill' });
    await client.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
    const controller = new AbortController();
    const raw = 'please use /cli-helper inspect src';
    pending = runOneShotClientTask({ client, runtime, options: { provider: 'one-shot-skill-test', session: { id: session.id } },
      prompt: raw, abortSignal: controller.signal });
    await expect.poll(() => shell.mock.calls.length).toBe(1);
    const runs = await runtime.runs.list({ sessionId: session.id });
    expect(runs).toHaveLength(1);
    expect((await runtime.sessions.transcript(session.id))?.messages.filter((message) => message.role === 'user'))
      .toEqual([expect.objectContaining({ content: raw })]);
    controller.abort();
    await expect.poll(() => preparationSignal?.aborted).toBe(true);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(pending).resolves.toMatchObject({ interrupted: true });
    expect(providerCalls).toBe(0);
    expect(shell).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await Promise.allSettled(pending ? [pending] : []);
    await runtime.close();
    shell.mockRestore();
    resetSkillRegistry();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);
