import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateImageBytes } from '../dist/sdk-media.js';
import { createAgent, Runner } from '../dist/sdk-agent.js';
import { createCustomProvider, KodaXContextOverflowError, withPreparedImageHistory } from '../dist/sdk-llm.js';

test('published media entry resolves its lazy decoder and keeps supported formats', async () => {
  for (const [name, mediaType] of [
    ['valid.jpg', 'image/jpeg'], ['valid-png.png', 'image/png'],
    ['valid.gif', 'image/gif'], ['valid.webp', 'image/webp'],
  ]) {
    const bytes = await readFile(new URL(`./fixtures/images/${name}`, import.meta.url));
    assert.deepEqual(await validateImageBytes(bytes), { status: 'valid', mediaType });
  }
});

test('published Runner and LLM entries share prepared images across context-overflow compaction', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-bundle-image-'));
  try {
    const bytes = await readFile(new URL('./fixtures/images/valid-png.png', import.meta.url));
    const filePath = path.join(directory, 'image.png');
    await writeFile(filePath, bytes);
    const provider = createCustomProvider({ name: 'bundle-test', protocol: 'openai', model: 'vision',
      baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED', imageInput: true });
    let wire;
    Reflect.set(provider, '_client', { chat: { completions: { create: async request => {
      wire = request;
      return { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] };
    } } } });
    let attempts = 0;
    const result = await withPreparedImageHistory(() => Runner.run(createAgent({ name: 'bundle-image', instructions: 'Inspect.' }), [
      { role: 'user', content: 'Old verbose context. '.repeat(1000) },
      { role: 'user', content: [{ type: 'image', path: filePath }] },
    ], { tracer: null, compactionHook: async (messages, error) => error ? messages.filter(message =>
      message.role === 'system' || Array.isArray(message.content)) : undefined,
    llm: async messages => {
      if (++attempts === 1) {
        await rm(filePath);
        throw new KodaXContextOverflowError({ inputTokensKind: 'unknown' });
      }
      const answer = await provider.complete([...messages], [], 'system');
      return answer.textBlocks.map(block => block.text).join('');
    } }));
    assert.equal(result.output, 'OK');
    assert.equal(attempts, 2);
    assert.ok(JSON.stringify(wire).includes(bytes.toString('base64')));
  } finally {
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  }
});

test('published media entry rejects an extracted JPEG without frame data', async () => {
  const bytes = await readFile(new URL('./fixtures/images/missing-sof.jpg', import.meta.url));
  assert.deepEqual(await validateImageBytes(bytes), { status: 'invalid' });
});
