import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import type { KodaXMessage, KodaXToolResultBlock } from '../types.js';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each(['complete', 'stream'] as const)('%s delivers only paired tool images after the full response group', async (method) => {
  directory = await mkdtemp(path.join(tmpdir(), 'kodax-tool-images-'));
  const imagePath = path.join(directory, 'pixel.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=';
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  const provider = createCustomProvider({ name: 'vision-test', protocol: 'openai', model: 'vision',
    baseUrl: 'https://provider.invalid', apiKeyEnv: 'UNUSED', imageInput: true });
  const create = vi.fn(async (request: { stream?: boolean; messages: { role: string; content: unknown; tool_call_id?: string }[] }) =>
    request.stream ? (async function* () { yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; })()
      : { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  Reflect.set(provider, '_client', { chat: { completions: { create } } });
  const result = (id: string, label: string): KodaXToolResultBlock => ({ type: 'tool_result', tool_use_id: id,
    content: [{ type: 'text', text: label }, { type: 'image', path: imagePath, mediaType: 'image/png' }] });
  const history: KodaXMessage[] = [
    { role: 'assistant', content: ['a', 'b'].map((id) => ({ type: 'tool_use', id, name: 'read', input: {} })) },
    { role: 'user', content: [result('b', 'B'), result('a', 'A'), result('a', 'duplicate'), result('foreign', 'orphan')] },
    { role: 'user', content: 'follow up' },
    { role: 'assistant', content: 'boundary' },
    { role: 'user', content: [result('b', 'late')] },
  ];
  const original = structuredClone(history);
  await provider[method](history, [], 'system');
  const wire = create.mock.calls[0]![0].messages.filter((message) => message.role !== 'system');
  expect(wire.slice(0, 3).map((message) => message.role)).toEqual(['assistant', 'tool', 'tool']);
  expect(wire.slice(1, 3).map((message) => message.tool_call_id)).toEqual(['a', 'b']);
  const images = wire.filter((message) => message.role === 'user' && Array.isArray(message.content));
  expect(images).toHaveLength(2);
  expect(images.map((message) => message.content)).toEqual(['b', 'a'].map((id) => [
    { type: 'text', text: `Images from tool result ${id}:` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ]));
  expect(wire.at(-2)?.content).toBe('follow up');
  expect(wire.at(-1)?.content).toBe('boundary');
  expect(JSON.stringify(wire)).not.toContain(imagePath);
  expect(JSON.stringify(wire)).not.toMatch(/duplicate|orphan|late/);
  expect(history).toEqual(original);
});
