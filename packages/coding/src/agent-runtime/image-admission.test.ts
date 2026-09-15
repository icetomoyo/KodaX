import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent, Runner } from '@kodax-ai/agent';
import { clearRuntimeModelProviders, createCustomProvider, registerModelProvider, type KodaXMessage } from '@kodax-ai/llm';
import { runKodaX } from '../agent.js';
import { runManagedTaskViaRunner } from '../task-engine/runner-driven.js';
import { CodingActorSession } from './actor-runtime.js';
import * as providerHook from './provider-hook.js';
import { executeTool } from '../tools/index.js';
import { toolRead } from '../tools/read.js';
import * as validation from '../../../llm/src/image-validation.js';
import { prepareImageBlock, withPreparedImageHistory } from '../../../llm/src/providers/image-serialization.js';

let directory: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  if (directory) {
    expect(path.dirname(directory)).toBe(tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

it('read uses its first unverified verdict without retrying the decoder during admission', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  const filePath = path.join(directory, 'image.png');
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, bytes);
  const inspect = vi.spyOn(validation, 'validateImageBytes').mockResolvedValue({
    status: 'unverified', reason: 'decoder_unavailable', mediaType: 'image/png',
  });
  await withPreparedImageHistory(async () => {
    const result = await toolRead({ path: filePath }, { backups: new Map() });
    if (typeof result === 'string') throw new Error(result);
    const image = result.find(item => item.type === 'image');
    if (!image) throw new Error('Expected retained image');
    expect(await prepareImageBlock(image)).toMatchObject({ data: bytes.toString('base64') });
    expect(inspect).toHaveBeenCalledOnce();
  });
});

it('cancels read during its first validation without waiting for the decoder', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  const filePath = path.join(directory, 'image.png');
  await writeFile(filePath, await readFile('tests/fixtures/images/valid-png.png'));
  let finish!: (result: validation.ImageValidation) => void;
  const inspect = vi.spyOn(validation, 'validateImageBytes').mockReturnValue(
    new Promise(resolve => { finish = resolve; }));
  const abort = new AbortController();
  const pending = withPreparedImageHistory(() => toolRead({ path: filePath }, { backups: new Map() }), abort.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
  } finally { finish({ status: 'valid', mediaType: 'image/png' }); }
});

it('custom Runner callbacks do not read or encode ignored historical images', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  const filePath = path.join(directory, 'image.png');
  await writeFile(filePath, await readFile('tests/fixtures/images/valid-png.png'));
  const inspect = vi.spyOn(validation, 'validateImageBytes');
  await Runner.run(createAgent({ name: 'text-only', instructions: 'Return OK.' }), [
    { role: 'user', content: [{ type: 'image', path: filePath }] },
    { role: 'user', content: 'Return OK.' },
  ], { tracer: null, llm: async () => 'OK' });
  expect(inspect).not.toHaveBeenCalled();
});

for (const runtime of ['substrate', 'managed'] as const) {
  it(`${runtime} skips historical image preparation for CLI transport`, async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
    vi.stubEnv('KODAX_HOME', directory);
    vi.stubEnv('IMAGE_ADMISSION_KEY', 'test-key');
    const filePath = path.join(directory, 'image.png');
    await writeFile(filePath, await readFile('tests/fixtures/images/valid-png.png'));
    const inspect = vi.spyOn(validation, 'validateImageBytes');
    const provider = createCustomProvider({ name: 'image-admission-cli', protocol: 'openai', model: 'text',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'IMAGE_ADMISSION_KEY' });
    const profile = provider.getCapabilityProfile();
    vi.spyOn(provider, 'getCapabilityProfile').mockReturnValue({ ...profile,
      transport: 'cli-bridge', conversationSemantics: 'last-user-message' });
    vi.spyOn(provider, 'stream').mockResolvedValue({ textBlocks: [{ type: 'text', text: 'OK' }],
      toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' });
    registerModelProvider('image-admission-cli', () => provider);
    const options = { provider: 'image-admission-cli', reasoningMode: 'off' as const,
      context: { executionCwd: directory, managedTaskWorkspaceDir: directory },
      session: { initialMessages: [{ role: 'user' as const, content: [{ type: 'image' as const, path: filePath }] }] },
      maxIter: 2 };
    await (runtime === 'substrate' ? runKodaX(options, 'Return OK.') : runManagedTaskViaRunner(options, 'Return OK.'));
    expect(inspect).not.toHaveBeenCalled();
  });
}

for (const runtime of ['runner', 'substrate', 'managed'] as const) {
  it(`${runtime} prepares restored images before generation and preserves the raw transcript`, async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
    vi.stubEnv('KODAX_HOME', directory);
    vi.stubEnv('IMAGE_ADMISSION_KEY', 'test-key');
    const filePath = path.join(directory, 'image.png');
    const png = await readFile('tests/fixtures/images/valid-png.png');
    await writeFile(filePath, png);
    const messages: KodaXMessage[] = [{ role: 'user', content: [{ type: 'image', path: filePath }] }];
    const original = structuredClone(messages);
    const provider = createCustomProvider({ name: 'image-admission', protocol: 'openai', model: 'vision',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'IMAGE_ADMISSION_KEY', imageInput: true });
    const create = vi.fn(async (_request: { messages: unknown[]; stream?: boolean }) => _request.stream
      ? (async function* () { yield { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }; })()
      : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
    Reflect.set(provider, '_client', { chat: { completions: { create } } });
    if (runtime === 'runner') {
      await withPreparedImageHistory(() => Runner.run(createAgent({ name: 'image-test', instructions: 'Inspect images.' }), messages, {
        tracer: null,
        llm: async (transcript) => {
          await rm(filePath);
          const result = await provider.complete([...transcript], [], 'system');
          return result.textBlocks.map(block => block.text).join('');
        },
      }));
    } else {
      const stream = provider.stream.bind(provider);
      vi.spyOn(provider, 'stream').mockImplementation(async (...args) => {
        await rm(filePath, { force: true });
        return stream(...args);
      });
      registerModelProvider('image-admission', () => provider);
      const options = { provider: 'image-admission', reasoningMode: 'off' as const,
        context: { executionCwd: directory, managedTaskWorkspaceDir: directory },
        session: { initialMessages: messages }, maxIter: 2 };
      const result = await (runtime === 'substrate' ? runKodaX(options, 'Inspect images.')
        : runManagedTaskViaRunner(options, 'Inspect images.'));
      expect(result.success).toBe(true);
    }
    expect(create).toHaveBeenCalled();
    expect(JSON.stringify(create.mock.calls[0]![0]).includes(png.toString('base64'))).toBe(true);
    expect(messages).toEqual(original);
  });
}

it('read admits the actual bytes before returning, so subsequent file edits cannot change the observation', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  const filePath = path.join(directory, 'image.png');
  const png = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, png);
  await withPreparedImageHistory(async () => {
    const result = await executeTool('read', { path: filePath }, { executionCwd: directory, backups: new Map() });
    if (typeof result === 'string') throw new Error(result);
    const block = result.find(item => item.type === 'image');
    if (!block || block.type !== 'image') throw new Error('Missing read image');
    await writeFile(filePath, 'not an image');
    expect(await prepareImageBlock(block)).toMatchObject({ data: png.toString('base64') });
    const next = await executeTool('read', { path: filePath }, { executionCwd: directory, backups: new Map() });
    expect(next).toContain('cannot be decoded');
  });
});

it('substrate admits history when a prepare hook switches CLI to native', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  vi.stubEnv('KODAX_HOME', directory);
  vi.stubEnv('IMAGE_ADMISSION_KEY', 'test-key');
  const filePath = path.join(directory, 'image.png');
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, bytes);
  const inspect = vi.spyOn(validation, 'validateImageBytes');
  const native = createCustomProvider({ name: 'admission-native', protocol: 'openai', model: 'vision',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'IMAGE_ADMISSION_KEY', imageInput: true });
  const cli = createCustomProvider({ name: 'admission-cli', protocol: 'openai', model: 'text',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'IMAGE_ADMISSION_KEY' });
  vi.spyOn(cli, 'getCapabilityProfile').mockReturnValue({ ...cli.getCapabilityProfile(),
    transport: 'cli-bridge', conversationSemantics: 'last-user-message' });
  registerModelProvider('admission-cli', () => cli);
  registerModelProvider('admission-native', () => native);
  vi.spyOn(providerHook, 'applyProviderPrepareHook').mockImplementation(async state => {
    expect(inspect).not.toHaveBeenCalled();
    return { ...state, provider: 'admission-native' };
  });
  const image = { type: 'image' as const, path: filePath };
  vi.spyOn(native, 'stream').mockImplementation(async () => {
    await rm(filePath);
    expect(await prepareImageBlock(image)).toMatchObject({ data: bytes.toString('base64') });
    return { textBlocks: [{ type: 'text', text: 'OK' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  });
  const result = await runKodaX({ provider: 'admission-cli', reasoningMode: 'off', maxIter: 2,
    context: { executionCwd: directory }, session: { initialMessages: [{ role: 'user', content: [image] }] } }, 'Inspect.');
  expect(result.success).toBe(true);
  expect(inspect).toHaveBeenCalledOnce();
});

it('managed native image snapshots survive idle-yield Runner reinvocation', async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-admission-'));
  vi.stubEnv('KODAX_HOME', directory);
  vi.stubEnv('IMAGE_ADMISSION_KEY', 'test-key');
  const filePath = path.join(directory, 'image.png');
  const bytes = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, bytes);
  const image = { type: 'image' as const, path: filePath };
  const inspect = vi.spyOn(validation, 'validateImageBytes');
  let inputOpen = false;
  const actorSession = new CodingActorSession({ sessionId: 'image-idle-yield', executor: {
    execute: async () => {
      await vi.waitFor(() => expect(inputOpen).toBe(true));
      return { output: 'child completed' };
    },
  } });
  const provider = createCustomProvider({ name: 'admission-idle', protocol: 'openai', model: 'vision',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'IMAGE_ADMISSION_KEY', imageInput: true });
  const runnerCalls = vi.spyOn(Runner, 'run');
  let calls = 0;
  vi.spyOn(provider, 'stream').mockImplementation(async () => {
    expect(await prepareImageBlock(image)).toMatchObject({ data: bytes.toString('base64') });
    if (++calls === 1) {
      await rm(filePath);
      await actorSession.rootControl().spawn({ taskName: 'image-child', objective: 'Wake parent.', kind: 'external' });
    }
    return { textBlocks: [{ type: 'text', text: calls === 1 ? 'waiting' : 'OK' }],
      toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  });
  registerModelProvider('admission-idle', () => provider);
  try {
    const result = await runManagedTaskViaRunner({ provider: 'admission-idle', reasoningMode: 'off',
      session: { id: 'image-idle-yield', initialMessages: [{ role: 'user', content: [image] }] },
      context: { executionCwd: directory, managedTaskWorkspaceDir: directory, actorSession,
        interruptInput: { closeInputWindow: () => { inputOpen = false; }, reopenInputWindow: () => { inputOpen = true; } } },
    }, 'Wait for the child.');
    expect(result.success).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(runnerCalls.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(inspect).toHaveBeenCalledOnce();
  } finally { await actorSession.close('test complete'); }
});
