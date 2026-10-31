import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createCustomProvider } from './custom-provider.js';
import { getRejectedImageHash } from './rejected-image.js';
import type { KodaXMessage } from '../types.js';

it('serializes prepared user/tool images and retains precise upstream rejection evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kodax-responses-images-'));
  const imagePath = path.join(directory, 'pixel.png');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAAAuCAYAAACvdRKFAAAAhUlEQVR4Ae3BQQGAMADEsO6kIG5q8QQy+mlynvt+JJKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiEYiGoloJKKRiH7i7gKvb5ZrbwAAAABJRU5ErkJggg==';
  await writeFile(imagePath, Buffer.from(png, 'base64'));
  vi.stubEnv('RESPONSES_IMAGE_KEY', 'test-only');
  const config = { name: 'images', protocol: 'openai' as const, api: 'responses' as const, model: 'm', apiKeyEnv: 'RESPONSES_IMAGE_KEY', baseUrl: 'https://images.test/v1' };
  const history: KodaXMessage[] = [{ role: 'user', content: [{ type: 'image', path: imagePath }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'result' }, { type: 'image', path: imagePath }] }] }];
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Response.json({ status: 'completed', output: [] });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await createCustomProvider({ ...config, imageInput: true }).complete(history, [], '');
    expect(requests[0]?.input).toEqual([
      { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' }] },
      { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: [{ type: 'input_text', text: 'result' }, { type: 'input_image', image_url: `data:image/png;base64,${png}`, detail: 'auto' }] },
    ]);
    await createCustomProvider(config).complete(history, [], '');
    expect(JSON.stringify(requests[1])).not.toContain('base64');
    expect(JSON.stringify(requests[1])).not.toContain(imagePath);
    fetch.mockImplementation(async () => Response.json({ error: { message: 'Invalid image format at input[2].output[1].image_url' } }, { status: 400 }));
    const error = await createCustomProvider({ ...config, imageInput: true }).complete(history, [], '').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(getRejectedImageHash(error as Error)).toBe(createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex'));
    fetch.mockImplementation(async (_url, init) => { requests.push(JSON.parse(String(init.body)) as Record<string, unknown>); return Response.json({ status: 'completed', output: [] }); });
    await unlink(imagePath);
    await createCustomProvider({ ...config, imageInput: true }).complete(history, [], '');
    expect(JSON.stringify(requests.at(-1))).toContain('Historical image unavailable');
  } finally {
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
    // The single file may already have been removed by the missing-image assertion.
    await unlink(imagePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});
