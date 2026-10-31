import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { classify, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope,
  type KodaXClassificationRequest, type KodaXClassifierConnection } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const connection: KodaXClassifierConnection = { name: 'classifier', api: 'typesafe-system-one', model: 'fixture', baseUrl: 'https://classify.example/v1', apiKeyEnv: 'CLASSIFY_KEY' };
const choice: KodaXClassificationRequest = { state: 'state', questions: { category: { type: 'choice', instructions: 'Category?', criteria: { a: 'A', b: 'B' } } } };
const valid = { type: 'choice', choice: 'b', confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } };
it('preserves a native choice and its complete distribution', async () => {
  vi.stubEnv('CLASSIFY_KEY', 'key'); vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answers: { category: valid } })));
  expect((await classify(connection, choice)).answers.category).toEqual(valid);
});
it.each([
  ['foreign answer name', { foreign: valid }], ['missing answers', {}], ['extra answers', { category: valid, foreign: valid }],
  ['wrong type', { category: { ...valid, type: 'noul' } }], ['unknown choice', { category: { ...valid, choice: 'c' } }],
  ['missing label', { category: { ...valid, probabilities: { a: 1 } } }],
  ['foreign label', { category: { ...valid, probabilities: { a: 0.2, c: 0.8 } } }],
  ['out of range', { category: { ...valid, probabilities: { a: -0.2, b: 1.2 } } }],
  ['not finite', { category: { ...valid, confidence: null, probabilities: { a: null, b: 1 } } }],
  ['not normalized', { category: { ...valid, probabilities: { a: 0.2, b: 0.2 } } }],
  ['invalid confidence', { category: { ...valid, confidence: 2 } }],
] as Array<[string, unknown]>)('rejects %s rather than inventing probabilities', async (_name, answers) => {
  vi.stubEnv('CLASSIFY_KEY', 'key'); const fetcher = vi.fn(async () => Response.json({ answers })); vi.stubGlobal('fetch', fetcher);
  await expect(classify(connection, choice)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { state: 'x', questions: {} }, { state: 'x', questions: { ' ': { type: 'bool', instructions: '?' } } },
  { state: 'x', questions: { one: { type: 'choice', instructions: '?', criteria: { a: 'A' } } } },
  { state: 'x', questions: { one: { type: 'score', instructions: '?', criteria: Array.from({ length: 11 }, () => 'level') } } },
] as KodaXClassificationRequest[])('rejects invalid questions before transport', async request => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(classify(connection, request)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it('keeps Cloudflare hosted run state authoritative', async () => {
  vi.stubEnv('CLASSIFY_KEY', 'key');
  const fetcher = vi.fn(async () => Response.json({ success: true, result: { state: 'Completed', result: { answers: { category: valid } } } }));
  vi.stubGlobal('fetch', fetcher);
  const cf: KodaXClassifierConnection = { ...connection, api: 'cloudflare-workers-ai-system-one', dialect: 'cloudflare-jev' };
  expect((await classify(cf, choice)).answers.category).toEqual(valid);
  fetcher.mockImplementation(async () => Response.json({ success: true, result: { state: 'Running', result: { answers: { category: valid } } } }));
  await expect(classify(cf, choice)).rejects.toThrow(/not completed/);
  fetcher.mockImplementation(async () => Response.json({ success: false, result: { answers: { category: valid } } }));
  await expect(classify(cf, choice)).rejects.toThrow(/failed/);
});
it.each(['openrouter-system-one', 'cloudflare-clef', 'decisions'] as const)('lowers admitted images for %s without remote URLs', async dialect => {
  vi.stubEnv('CLASSIFY_KEY', 'key');
  const data = (await readFile(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url))).toString('base64');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json(dialect === 'decisions'
    ? { answers: [{ name: 'category', ...valid, probabilities: [{ value: 'a', probability: 0.2 }, { value: 'b', probability: 0.8 }] }] }
    : { ...(dialect === 'cloudflare-clef' ? { success: true, result: { answers: { category: valid } } } : { answers: { category: valid } }) }));
  vi.stubGlobal('fetch', fetcher);
  await classify({ ...connection, ...(dialect === 'decisions' ? { api: 'openai-decisions' as const }
    : dialect === 'cloudflare-clef' ? { api: 'cloudflare-workers-ai-system-one' as const, dialect, model: 'clef' } : { dialect }) }, { ...choice, images: { image: { data } } });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  if (dialect === 'decisions') expect(body.input[0].content[1]).toMatchObject({ type: 'input_image', image_url: `data:image/png;base64,${data}` });
  else if (dialect === 'cloudflare-clef') expect(body.images).toEqual([`data:image/png;base64,${data}`]);
  else expect(body.state).toEqual([{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }, 'state']);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('typesafe-danger-zone-images')).toBe(false);
});
it('cannot escape an exhausted/revoked scoped broker to an ambient key', async () => {
  vi.stubEnv('CLASSIFY_KEY', 'ambient'); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['classifier'], acquire: async () => { throw new Error('revoked'); } });
  await expect(runWithProviderCredentialLeaseScope(scope, () => classify(connection, choice))).rejects.toThrow('revoked');
  scope.close(); expect(fetcher).not.toHaveBeenCalled();
});
it('redacts an environment credential echoed in an upstream failure', async () => {
  vi.stubEnv('CLASSIFY_KEY', 'secret-fixture-key');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Invalid secret-fixture-key' } }, { status: 401 })));
  await expect(classify(connection, choice)).rejects.toThrow('Invalid [REDACTED_CREDENTIAL]');
});
it('freezes connection metadata before asynchronous credential acquisition', async () => {
  let release!: (key: string) => void;
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['classifier'], acquire: async () => new Promise<string>(resolve => { release = resolve; }) });
  const mutable = { ...connection };
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ answers: { category: valid } })); vi.stubGlobal('fetch', fetcher);
  const pending = runWithProviderCredentialLeaseScope(scope, () => classify(mutable, choice));
  mutable.baseUrl = 'https://untrusted.example'; release('authorized');
  await pending; scope.close(); expect(fetcher.mock.calls[0]?.[0]).toBe('https://classify.example/v1/systemone');
});
