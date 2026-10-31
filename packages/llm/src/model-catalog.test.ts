import { afterEach, expect, it, vi } from 'vitest';
import { refreshProviderModelCatalog, createMemoryModelCatalogStore, runWithProviderCredential, runWithProviderRequestObserver, type ProviderRequestObservation } from './index.js';

afterEach(() => vi.unstubAllGlobals());
it('refreshes an account catalog without replacing curated budgets or treating missing prices as free, then validates a 304', async () => {
  const store = createMemoryModelCatalogStore();
  const connection = { name: 'catalog', model: 'known', baseUrl: 'https://openrouter.ai/api/v1', api: 'openrouter-user-models' as const,
    credentialSource: 'broker' as const, accountScope: 'registration/account-a', curatedModels: [{ id: 'known', maxOutputTokens: 16000, contextWindow: 200000 }, { id: 'disabled' }] };
  let count = 0;
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ++count === 1 ? Response.json({ data: [
    { id: 'known', top_provider: { max_completion_tokens: 99999 }, pricing: { prompt: '0.000001', completion: '0', input_cache_read: '-1',
      overrides: [{ min_prompt_tokens: 10000, utc_start: 0, prompt: '0.000002' }] } },
    { id: 'sparse', pricing: {} },
  ] }, { headers: { etag: '"revision-1"', 'last-modified': 'Fri, 30 Oct 2026 00:00:00 GMT' } }) : new Response(null, { status: 304 })); vi.stubGlobal('fetch', wire);
  const first = await runWithProviderCredential(connection.name, 'account-token-a', () => refreshProviderModelCatalog(connection, { store }));
  expect(first.status).toBe('updated'); if (!first.snapshot) throw new Error('Expected catalog snapshot');
  expect(first.snapshot.models.find(model => model.id === 'known')).toMatchObject({ available: true, curated: { maxOutputTokens: 16000, contextWindow: 200000 },
    advertised: { outputTokenLimit: 99999 }, quote: { rates: { inputPer1M: 1, outputPer1M: 0 } } });
  expect(first.snapshot.models.find(model => model.id === 'disabled')?.available).toBe(false);
  expect(first.snapshot.models.find(model => model.id === 'known')?.quote?.conditions).toEqual([
    { when: { min_prompt_tokens: 10000, utc_start: 0 }, rates: { inputPer1M: 2 } },
  ]);
  const sparse = first.snapshot.models.find(model => model.id === 'sparse');
  expect(sparse?.advertised).not.toHaveProperty('contextWindow'); expect(sparse?.quote?.rates).not.toHaveProperty('inputPer1M');
  expect(JSON.stringify(first.snapshot)).not.toContain('account-token');
  const facts: ProviderRequestObservation[] = [];
  const next = await runWithProviderRequestObserver(fact => facts.push(fact), () => runWithProviderCredential(connection.name, 'refreshed-token-a', () => refreshProviderModelCatalog(connection, { store })));
  expect(next.status).toBe('not-modified'); expect(next.snapshot?.models).toEqual(first.snapshot.models);
  expect(new Headers(wire.mock.calls[1]?.[1]?.headers).get('if-none-match')).toBe('"revision-1"');
  expect(new Headers(wire.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer refreshed-token-a');
  expect(facts.filter(fact => fact.wireObservation === 'observed' && fact.state === 'succeeded')).toHaveLength(1);
});

it('fences superseded responses and revoked account publication, with account-local validators', async () => {
  const store = createMemoryModelCatalogStore();
  const connection = { name: 'catalog', model: 'm', baseUrl: 'https://models.example/v1', api: 'openai-models' as const, accountScope: 'a' };
  let release: (value: Response) => void = () => { throw new Error('Missing old request'); };
  const oldResponse = new Promise<Response>(resolve => { release = resolve; });
  let calls = 0;
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ++calls === 1 ? oldResponse
    : Response.json({ data: [{ id: 'new' }] }, { headers: { etag: '"new"' } })); vi.stubGlobal('fetch', wire);
  const old = runWithProviderCredential(connection.name, 'old-token', () => refreshProviderModelCatalog(connection, { store }));
  await vi.waitFor(() => expect(wire).toHaveBeenCalledOnce());
  const current = await runWithProviderCredential(connection.name, 'new-token', () => refreshProviderModelCatalog(connection, { store }));
  release(Response.json({ data: [{ id: 'old' }] }, { headers: { etag: '"old"' } }));
  expect((await old).status).toBe('stale'); expect(current.status).toBe('updated');
  const restored = await store.read(current.snapshot!.scope); expect(restored?.models.map(model => model.id)).toEqual(['new']);
  await runWithProviderCredential(connection.name, 'b-token', () => refreshProviderModelCatalog({ ...connection, accountScope: 'b' }, { store }));
  expect(new Headers(wire.mock.calls[2]?.[1]?.headers).has('if-none-match')).toBe(false);
  let live = true;
  wire.mockImplementationOnce(async () => { live = false; return Response.json({ data: [{ id: 'revoked' }] }); });
  const revoked = await runWithProviderCredential(connection.name, 'new-token', () => refreshProviderModelCatalog(connection, { store, isCurrent: () => live }));
  expect(revoked.status).toBe('stale'); expect((await store.read(current.snapshot!.scope))?.revision).toBe(current.snapshot?.revision);
});

it('loads Radius native declarations but never applies an untrusted foreign routing URL', async () => {
  const connection = { name: 'radius', model: 'm', baseUrl: 'https://radius.example/messages-prefix', api: 'radius-config' as const, accountScope: 'a' };
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ baseUrl: 'https://radius.example/v1', models: [{ id: 'm', name: 'Model',
    contextWindow: 100000, maxTokens: 200000, reasoning: true, input: ['text', 'image'], cost: { input: 0, output: 1 } }] })); vi.stubGlobal('fetch', wire);
  const result = await runWithProviderCredential(connection.name, 'fixture', () => refreshProviderModelCatalog(connection));
  expect(wire.mock.calls[0]?.[0]).toBe('https://radius.example/v1/config');
  expect(result.snapshot?.suggestedBaseUrl).toBe('https://radius.example/v1');
  expect(result.snapshot?.models[0]).toMatchObject({ advertised: { contextWindow: 100000, outputTokenLimit: 200000, imageInput: true, reasoning: true }, quote: { rates: { inputPer1M: 0, outputPer1M: 1 } } });
  wire.mockImplementationOnce(async () => Response.json({ baseUrl: 'https://foreign.example/v1', models: [] }));
  await expect(runWithProviderCredential(connection.name, 'fixture', () => refreshProviderModelCatalog(connection))).rejects.toThrow(/foreign/);
});
