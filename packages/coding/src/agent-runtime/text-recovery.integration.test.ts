import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, createCustomProvider, KodaXProviderError, registerModelProvider } from '@kodax-ai/llm';
import { runTestLeaf as runLeafAgent } from './test-leaf.js';
import { runManagedTaskViaRunner } from '../task-engine/runner-driven.js';
import { _resetMessageQueueForTests, actorQueueId, getMessageQueue } from '@kodax-ai/agent';
import { CodingActorSession } from './actor-runtime.js';
import * as validation from '../../../llm/src/image-validation.js';
import * as images from '../../../llm/src/providers/image-serialization.js';

let directory: string | undefined;
afterEach(async () => {
  _resetMessageQueueForTests(); vi.restoreAllMocks(); clearRuntimeModelProviders(); vi.unstubAllEnvs();
  if (directory) { expect(path.dirname(directory)).toBe(tmpdir()); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// A new image in a rejected request is dropped without a diagnostic request (Issue 449).
it.each(['Direct', 'AMA'] as const)('%s omits a new image the provider rejects and continues without changing raw history', async runtime => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-text-recovery-runtime-'));
  vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
  const file = path.join(directory, 'header.png');
  await writeFile(file, await readFile('tests/fixtures/images/valid-png.png'));
  const image = { type: 'image' as const, path: file };
  const history = [{ role: 'user' as const, content: [image] }];
  const original = structuredClone(history);
  // Admission cannot decode in this host; the later read-only inspection can.
  vi.spyOn(validation, 'validateImageBytes').mockResolvedValueOnce({ status: 'unverified', reason: 'decoder_unavailable' })
    .mockResolvedValue({ status: 'invalid' });
  const provider = createCustomProvider({ name: 'text-recovery', protocol: 'anthropic', model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
  const stream = vi.spyOn(provider, 'stream').mockImplementation(async messages => {
    if (JSON.stringify(messages).includes('"type":"image"')) {
      throw new KodaXProviderError('400 [1210] 图片输入格式/解析错误', 'text-recovery', { httpStatus: 400, upstreamCode: '1210' });
    }
    return { textBlocks: [{ type: 'text', text: '六万元，每项两万元，启动前支付。' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  });
  const diagnose = vi.spyOn(provider, 'complete');
  registerModelProvider('text-recovery', () => provider);
  const result = await (runtime === 'Direct' ? runLeafAgent : runManagedTaskViaRunner)({ provider: 'text-recovery', reasoningMode: 'off', maxIter: 2,
    context: { executionCwd: directory, managedTaskWorkspaceDir: directory }, session: { initialMessages: history } }, '总价六万元，每项两万元，启动前支付');
  expect(result.success).toBe(true);
  expect(diagnose).not.toHaveBeenCalled(); expect(stream).toHaveBeenCalledTimes(2);
  expect(stream.mock.calls[1]![4]).not.toMatchObject({ singleAttempt: true });
  expect(JSON.stringify(stream.mock.calls[1]![0])).not.toContain('"type":"image"');
  expect(JSON.stringify(stream.mock.calls[1]![0])).toContain('图片输入格式/解析错误');
  expect(history).toEqual(original);
  expect(await readFile(file)).toEqual(await readFile('tests/fixtures/images/valid-png.png'));
});

for (const runtime of ['Direct', 'AMA'] as const) {
  for (const outcome of ['resume', 'queued-input', 'second-rejection'] as const) {
    it(`${runtime} uses actual wire image evidence and handles ${outcome}`, async () => {
      // An image this model accepted before is not dropped by the image fallback, so only the diagnostic can.
      vi.spyOn(images, 'unacceptedPreparedImages').mockReturnValue([]);
      directory = await mkdtemp(path.join(tmpdir(), 'kodax-text-recovery-wire-'));
      vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
      const file = path.join(directory, 'header.png');
      await writeFile(file, await readFile('tests/fixtures/images/valid-png.png'));
      const history = [{ role: 'user' as const, content: [{ type: 'image' as const, path: file }] }];
      const original = structuredClone(history);
      const sessionId = `text-recovery-${runtime}-${outcome}`;
      const actorSession = new CodingActorSession({ sessionId });
      const provider = createCustomProvider({ name: 'wire-recovery', protocol: 'openai', model: 'vision',
        baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
      let diagnostics = 0;
      let streams = 0;
      const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }, options?: { maxRetries?: number }) => {
        if (!request.stream) {
          diagnostics++;
          expect(options?.maxRetries).toBe(0);
          const text = JSON.stringify(request.messages);
          expect(text).not.toContain('data:image/');
          const id = text.match(/m\d+\/b\d+(?:\/i\d+)?/)?.[0];
          expect(id).toBeDefined();
          if (outcome === 'queued-input') getMessageQueue().enqueue({ agentId: actorQueueId(sessionId, '/root'),
            priority: 'user', mode: 'prompt', content: 'New user input received during diagnosis' });
          return { choices: [{ message: { content: JSON.stringify({ action: 'omit_attachment', attachmentId: id,
            reason: 'Provider identified the exact rejected payload.' }) }, finish_reason: 'stop' }] };
        }
        streams++;
        if (streams === 1) {
          const message = request.messages.findIndex(item => JSON.stringify(item.content).includes('image_url'));
          const content = request.messages[message]!.content as { type: string }[];
          const block = content.findIndex(item => item.type === 'image_url');
          throw Object.assign(new Error(`Invalid image format at messages[${message}].content[${block}].image_url.url`), { status: 400 });
        }
        if (streams === 2) expect(options?.maxRetries).toBe(0);
        expect(JSON.stringify(request.messages)).not.toContain('data:image/');
        if (outcome === 'second-rejection') throw Object.assign(new Error('Service rate limit'), { status: 429 });
        return (async function* () { yield { choices: [{ delta: { content: '六万元，每项两万元，启动前支付。' }, finish_reason: 'stop' }] }; })();
      });
      Reflect.set(provider, '_client', { chat: { completions: { create } } });
      registerModelProvider('wire-recovery', () => provider);
      try {
        const result = await (runtime === 'Direct' ? runLeafAgent : runManagedTaskViaRunner)({ provider: 'wire-recovery',
          reasoningMode: 'off', maxIter: 2, lsp: false, session: { id: sessionId, initialMessages: history },
          context: { executionCwd: directory, managedTaskWorkspaceDir: directory, actorSession } },
        '总价六万元，每项两万元，启动前支付').catch(error => {
          if (runtime === 'AMA' && outcome !== 'resume') return { success: false };
          throw error;
        });
        expect(diagnostics).toBe(1);
        expect(result.success).toBe(outcome === 'resume');
        if (outcome !== 'resume') expect(streams).toBe(outcome === 'queued-input' ? 1 : 2);
        expect(history).toEqual(original);
      } finally { await actorSession.close('test complete'); }
    });
  }
}

// Issue 449: an unknown pixel limit below the 8000 px default. The run retries once with 2000 px request
// images; history and the file keep the original, and no diagnostic request is spent.
it.each(['Direct', 'AMA'] as const)('%s retries a pixel-limit rejection with smaller request images', async runtime => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-limit-runtime-'));
  vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
  const { Jimp } = await import('jimp');
  const { imageSize } = await import('image-size');
  const bytes = Buffer.from(await new Jimp({ width: 520, height: 9800, color: 0x3366ccff }).getBuffer('image/png'));
  const file = path.join(directory, 'full-page.png');
  await writeFile(file, bytes);
  const history = [{ role: 'user' as const, content: [{ type: 'image' as const, path: file }] }];
  const original = structuredClone(history);
  const provider = createCustomProvider({ name: 'pixel-limit', protocol: 'openai', model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
  const sent: { width?: number; height?: number }[] = [];
  const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }) => {
    if (!request.stream) throw new Error('Unexpected diagnostic request');
    const url = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(request.messages))?.[1];
    const size = url ? imageSize(Buffer.from(url, 'base64')) : {};
    sent.push(size);
    if (Math.max(size.width ?? 0, size.height ?? 0) > 4096) {
      throw Object.assign(new Error('image width and height must each be at most 4096 pixels'), { status: 400 });
    }
    return (async function* () { yield { choices: [{ delta: { content: 'The page is blue.' }, finish_reason: 'stop' }] }; })();
  });
  Reflect.set(provider, '_client', { chat: { completions: { create } } });
  registerModelProvider('pixel-limit', () => provider);
  const result = await (runtime === 'Direct' ? runLeafAgent : runManagedTaskViaRunner)({ provider: 'pixel-limit',
    reasoningMode: 'off', maxIter: 2, lsp: false, session: { initialMessages: history },
    context: { executionCwd: directory, managedTaskWorkspaceDir: directory } }, 'What colour is the page?');
  expect(result.success).toBe(true);
  expect(sent).toEqual([{ width: 424, height: 8000, type: 'png' }, { width: 106, height: 2000, type: 'png' }]);
  expect(history).toEqual(original);
  expect(await readFile(file)).toEqual(bytes);
});

async function pngFile(name: string, width: number, height: number): Promise<string> {
  const { Jimp } = await import('jimp');
  const file = path.join(directory!, name);
  await writeFile(file, Buffer.from(await new Jimp({ width, height, color: 0x3366ccff }).getBuffer('image/png')));
  return file;
}

async function sizesSent(request: { messages: { content: unknown }[] }): Promise<string[]> {
  const { imageSize } = await import('image-size');
  return [...JSON.stringify(request.messages).matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)]
    .map(match => imageSize(Buffer.from(match[1]!, 'base64'))).map(size => `${size.width}x${size.height}`);
}

// Issue 449: the rejection names no cause and even the 2000 px copy is refused. The image this model
// never accepted is dropped with the provider's reason; no diagnostic request is spent.
it.each(['Direct', 'AMA'] as const)('%s drops a new image the provider still rejects at 2000 px', async runtime => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-omit-runtime-'));
  vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
  const history = [{ role: 'user' as const, content: [{ type: 'image' as const, path: await pngFile('full-page.png', 520, 9800) }] }];
  const provider = createCustomProvider({ name: `image-omit-${runtime}`, protocol: 'openai', model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
  const sent: string[][] = [];
  const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }) => {
    if (!request.stream) throw new Error('Unexpected diagnostic request');
    sent.push(await sizesSent(request));
    if (sent.at(-1)!.length) throw Object.assign(new Error('Request rejected: unsupported content'), { status: 400 });
    expect(JSON.stringify(request.messages)).toContain('Request rejected: unsupported content');
    return (async function* () { yield { choices: [{ delta: { content: 'I cannot see that image.' }, finish_reason: 'stop' }] }; })();
  });
  Reflect.set(provider, '_client', { chat: { completions: { create } } });
  registerModelProvider(provider.name, () => provider);
  const result = await (runtime === 'Direct' ? runLeafAgent : runManagedTaskViaRunner)({ provider: provider.name,
    reasoningMode: 'off', maxIter: 2, lsp: false, session: { initialMessages: history },
    context: { executionCwd: directory, managedTaskWorkspaceDir: directory } }, 'What colour is the page?');
  expect(result.success).toBe(true);
  expect(sent).toEqual([['424x8000'], ['106x2000'], []]);
});

// Acceptance carries across runs: only the image this model has not answered before is reduced, so the
// accepted image keeps its bytes (and the cached prefix).
it.each(['Direct', 'AMA'] as const)('%s reduces only the new image when an accepted one is in history', async runtime => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-image-accepted-runtime-'));
  vi.stubEnv('KODAX_HOME', directory); vi.stubEnv('TEXT_RECOVERY_KEY', 'test');
  const wide = { type: 'image' as const, path: await pngFile('wide.png', 3000, 600) };
  const tall = { type: 'image' as const, path: await pngFile('full-page.png', 520, 9800) };
  const provider = createCustomProvider({ name: `image-accepted-${runtime}`, protocol: 'openai', model: 'vision',
    baseUrl: 'https://unused.invalid', apiKeyEnv: 'TEXT_RECOVERY_KEY', imageInput: true });
  const sent: string[][] = [];
  const create = vi.fn(async (request: { stream?: boolean; messages: { content: unknown }[] }) => {
    if (!request.stream) throw new Error('Unexpected diagnostic request');
    sent.push(await sizesSent(request));
    if (sent.at(-1)!.some(size => size.split('x').some(side => Number(side) > 4096))) {
      throw Object.assign(new Error('Request rejected: unsupported content'), { status: 400 });
    }
    return (async function* () { yield { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] }; })();
  });
  Reflect.set(provider, '_client', { chat: { completions: { create } } });
  registerModelProvider(provider.name, () => provider);
  const run = (initialMessages: { role: 'user'; content: (typeof wide)[] }[]) => (runtime === 'Direct' ? runLeafAgent : runManagedTaskViaRunner)({
    provider: provider.name, reasoningMode: 'off', maxIter: 2, lsp: false, session: { initialMessages },
    context: { executionCwd: directory, managedTaskWorkspaceDir: directory } }, 'Describe the images.');
  expect((await run([{ role: 'user', content: [wide] }])).success).toBe(true);
  expect((await run([{ role: 'user', content: [wide, tall] }])).success).toBe(true);
  expect(sent).toEqual([['3000x600'], ['3000x600', '424x8000'], ['3000x600', '106x2000']]);
});
