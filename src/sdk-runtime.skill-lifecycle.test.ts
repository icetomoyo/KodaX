import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as coding from '@kodax-ai/coding';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';

it('keeps standalone Skill dynamic preparation disabled under the same Plan policy as a Run', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-plan-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'context');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: context\ndescription: lifecycle probe\n---\n!`pwd`\n');
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  const shell = vi.spyOn(coding, 'toolBash').mockResolvedValue('Command: pwd\nExit: 0\nPLAN-SHELL-EXECUTED');
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    const result = await runtime.invocations.prepareSkill({ projectRoot, sessionId: session.id, name: 'context' });
    expect(shell).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'prepared', invocation: { prompt: expect.stringContaining('blocks are not allowed in Plan mode') } });
  } finally {
    await runtime.close();
    shell.mockRestore();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

it('aborts and joins standalone Skill preparation before the Host closes', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-close-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'context');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: context\ndescription: lifecycle probe\n---\n!`pwd`\n');
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true });
  let started = false;
  let finished = false;
  let signal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const execution = new Promise<void>(resolve => { release = resolve; });
  const shell = vi.spyOn(coding, 'toolBash').mockImplementation(async (_input, context) => {
    signal = context.abortSignal;
    started = true;
    await execution;
    finished = true;
    return 'Command: pwd\nExit: 0\ncontext';
  });
  const caller = new AbortController();
  let preparation: Promise<unknown> | undefined;
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    preparation = runtime.invocations.prepareSkill({ projectRoot, sessionId: session.id, name: 'context' }, { signal: caller.signal });
    await expect.poll(() => started).toBe(true);
    const closing = runtime.close();
    await expect.poll(() => signal?.aborted).toBe(true);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release?.();
    await closing;
    expect(finished).toBe(true);
    await expect(preparation).rejects.toBeDefined();
  } finally {
    release?.();
    await Promise.allSettled(preparation ? [preparation] : []);
    await runtime.close();
    shell.mockRestore();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

it.each(['stop', 'close'] as const)('retains Skill execution ownership and input identity across %s', async (action) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-idempotency-'));
  const skillDir = path.join(projectRoot, '.kodax', 'skills', 'context');
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: context\ndescription: lifecycle probe\n---\n!`pwd`\n');
  let providerCalls = 0;
  class ProbeProvider extends KodaXBaseProvider {
    readonly name = 'lifecycle-test';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_LIFECYCLE_TEST_KEY', model: 'lifecycle-test', supportsThinking: false };
    async stream(): Promise<KodaXStreamResult> {
      providerCalls += 1;
      return { textBlocks: [{ type: 'text', text: 'Done' }], thinkingBlocks: [], toolBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_LIFECYCLE_TEST_KEY', 'test-key');
  registerModelProvider('lifecycle-test', () => new ProbeProvider());
  const runtime = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 'lifecycle-test' });
  let release: (() => void) | undefined;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let preparationSignal: AbortSignal | undefined;
  const shell = vi.spyOn(coding, 'toolBash').mockImplementation(async (_input, context) => {
    const signal = context.abortSignal;
    preparationSignal = signal;
    if (!signal) throw new Error('Preparation lost its cancellation signal');
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await cleanup;
    signal.throwIfAborted();
    return '';
  });
  let observer: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    const session = await runtime.sessions.create({ projectPath: projectRoot });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
    const input = { sessionId: session.id, inputId: 'same-skill', text: '/skill:context' };
    const accepted = await runtime.runs.acceptInput(input);
    await expect.poll(() => shell.mock.calls.length).toBe(1);
    expect(await runtime.runs.acceptInput(input)).toEqual(accepted);
    if (action === 'stop') {
      await runtime.runs.abort(accepted.runId!);
      release?.();
      expect((await runtime.runs.await(accepted.runId!)).phase).toBe('interrupted');
      expect(await runtime.runs.acceptInput(input)).toEqual(accepted);
    } else {
      let closed = false;
      const closing = runtime.close().then(() => { closed = true; });
      await expect.poll(() => preparationSignal?.aborted).toBe(true);
      expect(closed).toBe(false);
      await expect(createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 'lifecycle-test' }))
        .rejects.toMatchObject({ code: 'session_storage_owned' });
      expect(closed).toBe(false);
      release?.();
      await closing;
      observer = await createKodaXRuntime({ homeDir: projectRoot, sharedDaemonHost: true, defaultProvider: 'lifecycle-test' });
      expect((await observer.runs.get(accepted.runId!))?.phase).toBe('interrupted');
    }
    expect(shell).toHaveBeenCalledOnce();
    expect(providerCalls).toBe(0);
    expect((await (observer ?? runtime).sessions.transcript(session.id))?.messages.filter(message => message.inputId === input.inputId)).toHaveLength(1);
  } finally {
    release?.();
    await runtime.close();
    await observer?.close();
    shell.mockRestore();
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
