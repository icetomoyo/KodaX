import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '../types.js';
import { createCustomProvider } from './custom-provider.js';
import { prepareHistoryImages, prepareImageBlock, prepareValidatedImageBlock, withPreparedImageHistory } from './image-serialization.js';
import * as validation from '../image-validation.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

it('defers snapshots until the active consumer needs native image bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-prepared-history-'));
  directories.push(directory);
  const filePath = path.join(directory, 'image.png');
  const png = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, png);
  const block = { type: 'image' as const, path: filePath };
  const messages: KodaXMessage[] = [{ role: 'user', content: [block] }];
  const inspect = vi.spyOn(validation, 'validateImageBytes');
  let native = false;
  await withPreparedImageHistory(async () => {
    expect(prepareHistoryImages(messages)).toBeUndefined();
    prepareValidatedImageBlock(block, Buffer.from('unused'), { status: 'invalid' });
    expect(inspect).not.toHaveBeenCalled();
    native = true;
    await prepareHistoryImages(messages);
    await rm(filePath);
    expect(await prepareImageBlock(block)).toMatchObject({ data: png.toString('base64') });
    expect(inspect).toHaveBeenCalledOnce();
  }, undefined, () => native);
});

it('cancels admission without waiting for a stuck decoder or admitting the remaining images', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-prepared-history-'));
  directories.push(directory);
  const filePath = path.join(directory, 'image.png');
  await writeFile(filePath, await readFile('tests/fixtures/images/valid-png.png'));
  let finish!: (result: validation.ImageValidation) => void;
  const decoding = new Promise<validation.ImageValidation>(resolve => { finish = resolve; });
  const inspect = vi.spyOn(validation, 'validateImageBytes').mockReturnValue(decoding);
  const abort = new AbortController();
  const messages: KodaXMessage[] = [{ role: 'user', content: Array.from({ length: 3 },
    () => ({ type: 'image' as const, path: filePath })) }];
  const admitted = withPreparedImageHistory(async () => { await prepareHistoryImages(messages); }, abort.signal);
  const rejected = expect(admitted).rejects.toMatchObject({ name: 'AbortError' });
  try {
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(inspect).toHaveBeenCalledOnce();
  } finally { finish({ status: 'valid', mediaType: 'image/png' }); }
});

it('keeps text-only and already-prepared admission synchronous', async () => {
  await withPreparedImageHistory(async () => {
    expect(prepareHistoryImages([{ role: 'user', content: 'text only' }])).toBeUndefined();
    const messages: KodaXMessage[] = [{ role: 'user', content: [{ type: 'image', path: 'missing-image-for-test.png' }] }];
    await prepareHistoryImages(messages);
    expect(prepareHistoryImages(messages)).toBeUndefined();
  });
});

for (const protocol of ['anthropic', 'openai'] as const) {
  for (const method of ['complete', 'stream'] as const) {
    it(`${protocol}/${method} reuses admitted bytes, admits new reads, and restores without changing raw history`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'kodax-prepared-history-'));
      directories.push(directory);
      const filePath = path.join(directory, 'image.png');
      const png = await readFile('tests/fixtures/images/valid-png.png');
      await writeFile(filePath, png);
      const messages: KodaXMessage[] = [{ role: 'user', content: [{ type: 'image', path: filePath }] }];
      const original = structuredClone(messages);
      const provider = createCustomProvider({ name: 'prepared-history', protocol, model: 'vision',
        baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED', imageInput: true });
      const create = vi.fn(async (_request: { messages: unknown[] }) => method === 'stream'
        ? (async function* () { yield protocol === 'anthropic' ? { type: 'message_stop' }
          : { choices: [{ delta: {}, finish_reason: 'stop' }] }; })()
        : protocol === 'anthropic' ? { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }
          : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
      Reflect.set(provider, '_client', protocol === 'anthropic' ? { messages: { create } }
        : { chat: { completions: { create } } });
      await withPreparedImageHistory(async () => {
        await prepareHistoryImages(messages);
        await rm(filePath);
        await provider[method](messages, [], 'system');
        await provider[method](messages, [], 'system');
        for (const call of create.mock.calls) expect(JSON.stringify(call[0])).toContain(png.toString('base64'));
        // A fresh read of the same path is independent of the older attachment.
        const next: KodaXMessage = { role: 'user', content: [{ type: 'image', path: filePath }] };
        await prepareHistoryImages([next]);
        await provider[method]([...messages, next], [], 'system');
        const mixed = JSON.stringify(create.mock.calls.at(-1)![0]);
        expect(mixed).toContain(png.toString('base64'));
        expect(mixed).toContain('file is missing');
      });
      expect(messages).toEqual(original);
      // Resuming starts a fresh preparation scope; no permanent negative or positive cache.
      await withPreparedImageHistory(async () => {
        await prepareHistoryImages(messages);
        await provider[method](messages, [], 'system');
        expect(JSON.stringify(create.mock.calls.at(-1)![0])).toContain('file is missing');
      });
      await writeFile(filePath, png);
      await provider[method](messages, [], 'system');
      expect(JSON.stringify(create.mock.calls.at(-1)![0])).toContain(png.toString('base64'));
    });
  }
}

it('defers unreadable attachments to image consumers, preserving non-vision tool-result behavior', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-prepared-history-'));
  directories.push(directory);
  const block = { type: 'image' as const, path: directory };
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'image', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image', content: [block] }] },
  ];
  const provider = createCustomProvider({ name: 'text-only', protocol: 'openai', model: 'text',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED', imageInput: false });
  const create = vi.fn(async (_request: unknown) => ({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }));
  Reflect.set(provider, '_client', { chat: { completions: { create } } });
  await withPreparedImageHistory(async () => {
    await prepareHistoryImages(messages);
    await provider.complete(messages, [], 'system');
    expect(JSON.stringify(create.mock.calls[0]![0])).toContain('does not support inline images');
    // A vision serializer must still see the real I/O failure, not a fabricated corruption verdict.
    await expect(prepareImageBlock(block)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

it('isolates nested and concurrent runs, including callers sharing the same history objects', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-prepared-history-'));
  directories.push(directory);
  const filePath = path.join(directory, 'image.png');
  const png = await readFile('tests/fixtures/images/valid-png.png');
  await writeFile(filePath, png);
  const block = { type: 'image' as const, path: filePath };
  const messages: KodaXMessage[] = [{ role: 'user', content: [block] }];
  let admitted!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const next = new Promise<void>(resolve => { resume = resolve; });
  const first = withPreparedImageHistory(async () => {
    await prepareHistoryImages(messages);
    admitted();
    await next;
    expect(await prepareImageBlock(block)).toMatchObject({ data: png.toString('base64') });
    await withPreparedImageHistory(async () => {
      expect(await prepareImageBlock(block)).toHaveProperty('placeholder');
    });
    expect(await prepareImageBlock(block)).toMatchObject({ data: png.toString('base64') });
  });
  const second = withPreparedImageHistory(async () => {
    await ready;
    try {
      await rm(filePath);
      await prepareHistoryImages(messages);
      expect(await prepareImageBlock(block)).toHaveProperty('placeholder');
    } finally { resume(); }
  });
  await Promise.all([first, second]);
});
