import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { generateImages } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const fixture = async () => (await readFile(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url))).toString('base64');
it.each(['images', 'chat-completions'] as const)('generates complete admitted image bytes via explicit %s dialect', async dialect => {
  const data = await fixture(); vi.stubEnv('IMAGE_API_KEY', 'image-key');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(dialect === 'images'
    ? { data: [{ b64_json: data, media_type: 'image/png' }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.04 } }
    : { choices: [{ finish_reason: 'stop', message: { content: 'caption', images: [{ image_url: { url: `data:image/png;base64,${data}` } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.04 } }));
  vi.stubGlobal('fetch', fetcher);
  const result = await generateImages({ name: 'artist', model: 'image-fixture', api: 'openrouter-images', dialect,
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' }, { prompt: 'Draw a tree', images: [{ data, mediaType: 'image/png' }] });
  expect(result.images).toEqual([{ data, mediaType: 'image/png', validation: { status: 'valid', mediaType: 'image/png' } }]);
  expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 20 });
  expect(result.cost).toEqual({ amount: 0.04, currency: 'USD', source: 'reported' });
  expect(fetcher.mock.calls[0]?.[0]).toBe(`https://openrouter.ai/api/v1/${dialect === 'images' ? 'images' : 'chat/completions'}`);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  if (dialect === 'images') expect(body).toMatchObject({ prompt: 'Draw a tree', input_references: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] });
  else expect(body).toMatchObject({ modalities: ['image', 'text'], messages: [{ role: 'user', content: [
    { type: 'text', text: 'Draw a tree' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] }] });
});

it.each([
  { data: [] }, { data: [{ b64_json: '!!', media_type: 'image/png' }] },
  { data: [{ b64_json: 'aGVsbG8=', media_type: 'image/png' }] }, { data: [{ url: 'https://untrusted.example/file.png' }] },
  { data: [{ b64_json: 'abc=', media_type: 2 }] },
])('rejects invalid dedicated image output without downloading or replaying', async body => {
  vi.stubEnv('IMAGE_API_KEY', 'image-key'); const fetcher = vi.fn(async () => Response.json(body)); vi.stubGlobal('fetch', fetcher);
  await expect(generateImages({ name: 'artist', model: 'fixture', api: 'openrouter-images', dialect: 'images',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' }, { prompt: 'Tree' })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('rejects a MIME mismatch and keeps unsupported vector bytes explicitly unverified', async () => {
  const data = await fixture(); vi.stubEnv('IMAGE_API_KEY', 'image-key');
  const fetcher = vi.fn(async () => Response.json({ data: [{ b64_json: data, media_type: 'image/jpeg' }] })); vi.stubGlobal('fetch', fetcher);
  const connection = { name: 'artist', model: 'fixture', api: 'openrouter-images' as const, dialect: 'images' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' };
  await expect(generateImages(connection, { prompt: 'Tree' })).rejects.toThrow(/MIME/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  fetcher.mockImplementation(async () => Response.json({ data: [{ b64_json: svg, media_type: 'image/svg+xml' }] }));
  expect((await generateImages(connection, { prompt: 'Tree' })).images[0]).toEqual({ data: svg, mediaType: 'image/svg+xml', validation: { status: 'unverified', reason: 'unsupported_format' } });
});

it.each(['missing-terminal', 'partial-only', 'upstream-error', 'after-terminal'] as const)('rejects %s image SSE without a final result', async mode => {
  const data = await fixture(); vi.stubEnv('IMAGE_API_KEY', 'image-key');
  const partial = `data: ${JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: data })}\n\n`;
  const final = `data: ${JSON.stringify({ type: 'image_generation.completed', b64_json: data })}\n\n`;
  const terminal = 'data: [DONE]\n\n';
  const events = mode === 'missing-terminal' ? partial + final : mode === 'partial-only' ? partial + terminal
    : mode === 'after-terminal' ? final + terminal + partial : partial + 'data: {"type":"error"}\n\n';
  const fetcher = vi.fn(async () => new Response(events)); vi.stubGlobal('fetch', fetcher);
  await expect(generateImages({ name: 'artist', model: 'fixture', api: 'openrouter-images', dialect: 'images',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' }, { prompt: 'Tree', stream: true })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('does not download remote chat-image output or accept an unfinished choice', async () => {
  vi.stubEnv('IMAGE_API_KEY', 'image-key');
  const fetcher = vi.fn(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { images: [{ image_url: { url: 'https://untrusted.example/a.png' } }] } }] })); vi.stubGlobal('fetch', fetcher);
  const connection = { name: 'artist', model: 'fixture', api: 'openrouter-images' as const, dialect: 'chat-completions' as const, baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' };
  await expect(generateImages(connection, { prompt: 'Tree' })).rejects.toThrow(/not downloaded/);
  fetcher.mockImplementation(async () => Response.json({ choices: [{ finish_reason: 'length', message: { images: [] } }] }));
  await expect(generateImages(connection, { prompt: 'Tree' })).rejects.toThrow(/not complete/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('cannot override model authority or output budget through image parameters', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(generateImages({ name: 'artist', model: 'fixture', api: 'openrouter-images', dialect: 'images',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' }, { prompt: 'Tree', parameters: { model: 'other' } })).rejects.toThrow(/core request/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('streams non-final previews but publishes only a completed image after the terminal marker', async () => {
  const data = await fixture(); vi.stubEnv('IMAGE_API_KEY', 'image-key');
  const frames = [{ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: data },
    { type: 'image_generation.completed', b64_json: data, media_type: 'image/png', usage: { prompt_tokens: 1, completion_tokens: 2 } }];
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetcher);
  const preview = vi.fn();
  const result = await generateImages({ name: 'artist', model: 'fixture', api: 'openrouter-images', dialect: 'images',
    baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'IMAGE_API_KEY' }, { prompt: 'Tree', stream: true, onPreview: preview });
  expect(preview).toHaveBeenCalledTimes(1);
  expect(preview.mock.calls[0]?.[0]).toMatchObject({ data, mediaType: 'image/png' });
  expect(preview.mock.calls[0]?.[1]).toBe(0);
  expect(result.images).toHaveLength(1);
  expect(result.usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).stream).toBe(true);
});
