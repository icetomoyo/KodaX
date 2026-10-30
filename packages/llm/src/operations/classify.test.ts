import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createProviderOperationConnection, classify, createProviderCredentialLeaseScope, runWithProviderCredentialLeaseScope } from '../index.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('returns native System One probabilities without a chat generation', async () => {
  vi.stubEnv('TYPESAFE_API_KEY', 'fixture-key');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({
    model: 'jev-test', answers: { billing: { type: 'noul', noul: 0.98 },
      urgency: { type: 'score', score: 1.7, confidence: 0.55, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } },
    usage: { input_tokens: 120, output_tokens: 12 },
  }));
  vi.stubGlobal('fetch', fetcher);
  const result = await classify({ name: 'decider', api: 'typesafe-system-one', model: 'jev-test',
    baseUrl: 'https://api.typesafe.ai/v1', apiKeyEnv: 'TYPESAFE_API_KEY' }, {
    state: 'I was charged twice', questions: { billing: { type: 'bool', instructions: 'Billing issue?' },
      urgency: { type: 'score', instructions: 'Urgency?', criteria: ['Can wait', 'This week', 'Today'] } },
  });
  expect(result.answers).toEqual({ billing: { type: 'bool', probability: 0.98 },
    urgency: { type: 'score', score: 1.7, confidence: 0.55, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } });
  expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 12 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.typesafe.ai/v1/systemone');
  const init = fetcher.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
  expect(JSON.parse(String(init?.body)).questions.billing).toEqual({ type: 'noul', instructions: 'Billing issue?' });
});

it('honors temporary HTTP Retry-After while refusing quota retries', async () => {
  vi.stubEnv('CLASSIFIER_KEY', 'fixture');
  const connection = { name: 'retry-classifier', api: 'typesafe-system-one' as const, model: 'fixture', baseUrl: 'https://classify.example/v1', apiKeyEnv: 'CLASSIFIER_KEY' };
  const request = { state: 'evidence', questions: { yes: { type: 'bool' as const, instructions: 'Yes?' } } };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'temporary rate limit' } }, { status: 429, headers: { 'retry-after-ms': '1' } }))
    .mockResolvedValueOnce(Response.json({ answers: { yes: { type: 'noul', noul: 0.7 } } }));
  vi.stubGlobal('fetch', fetcher);
  expect((await classify(connection, request)).answers.yes).toEqual({ type: 'bool', probability: 0.7 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockImplementation(async () => Response.json({ error: { code: 'insufficient_quota', message: 'insufficient quota' } }, { status: 429 }));
  await expect(classify(connection, request)).rejects.toThrow('insufficient quota');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('admits image bytes and lowers native TypeSafe assets with the required opt-in', async () => {
  const data = (await readFile(new URL('../../../../tests/fixtures/images/valid-png.png', import.meta.url))).toString('base64');
  const scope = createProviderCredentialLeaseScope({ allowedProviders: ['image-decider'], acquire: async () => 'scoped-key' });
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ answers: { yes: { type: 'noul', noul: 0.5 } } }));
  vi.stubGlobal('fetch', fetcher);
  await runWithProviderCredentialLeaseScope(scope, () => classify({ name: 'image-decider', api: 'typesafe-system-one', model: 'fixture', baseUrl: 'https://api.typesafe.ai/v1', credentialSource: 'broker' },
    { state: 'Describe this', images: { photo: { data, mediaType: 'image/png' } }, questions: { yes: { type: 'bool', instructions: 'Yes?' } } }));
  const init = fetcher.mock.calls[0]?.[1];
  expect(new Headers(init?.headers).get('typesafe-danger-zone-images')).toBe('true');
  expect(JSON.parse(String(init?.body))).toMatchObject({ state: ['photo', 'Describe this'], assets: { photo: { type: 'image', format: 'png', data_base64: data } } });
  scope.close();
});

it('uses native Decisions questions, retains score distributions and per-question refusals', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'api-key');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ model: 'decision-test', answers: [
    { name: 'risk', type: 'score', score: 1.1, confidence: 0.7, probabilities: [
      { value: 0, label: 'Low', probability: 0.1 }, { value: 1, label: 'Medium', probability: 0.7 }, { value: 2, label: 'High', probability: 0.2 }] },
    { name: 'private', type: 'refusal' }, { name: 'valid', type: 'predicate', probability: 0.9 },
  ] }));
  vi.stubGlobal('fetch', fetcher);
  const result = await classify({ name: 'decisions', api: 'openai-decisions', model: 'decision-test', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' }, {
    state: { text: 'evidence' }, questions: { risk: { type: 'score', instructions: 'Risk?', criteria: ['Low', 'Medium', 'High'] },
      private: { type: 'bool', instructions: 'Private?' }, valid: { type: 'bool', instructions: 'Valid?' } },
  });
  expect(result.answers.risk).toEqual({ type: 'score', score: 1.1, confidence: 0.7, probabilities: { 0: 0.1, 1: 0.7, 2: 0.2 } });
  expect(result.answers.private).toEqual({ type: 'refusal' });
  expect(result.answers.valid).toEqual({ type: 'bool', probability: 0.9 });
  expect(result.usage).toBeUndefined();
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_json', data: { text: 'evidence' } }] }]);
  expect(body.questions[0]).toEqual({ name: 'risk', type: 'score', instructions: 'Risk?', levels: ['Low', 'Medium', 'High'] });
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/decisions');
});

it('preserves explicit bool criteria when lowering a native Decisions predicate', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'api-key');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ answers: [{ name: 'eligible', type: 'predicate', probability: 0.8 }] })); vi.stubGlobal('fetch', fetcher);
  await classify({ name: 'decisions', api: 'openai-decisions', model: 'fixture', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' }, {
    state: { age: 70 }, questions: { eligible: { type: 'bool', instructions: 'Eligible?', criteria: { true: 'Age >= 65', false: 'Age < 65' } } },
  });
  const instructions = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).questions[0].instructions;
  expect(instructions).toContain('Eligible?'); expect(instructions).toContain('Age >= 65'); expect(instructions).toContain('Age < 65');
});

it.each(['cloudflare-jev', 'cloudflare-clef'] as const)('uses the explicit %s envelope', async dialect => {
  vi.stubEnv('CF_KEY', 'cf-key');
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ success: true,
    result: { model: 'fixture-model', answers: { yes: { type: 'noul', noul: 0.8 } } } }));
  vi.stubGlobal('fetch', fetcher);
  const result = await classify({ name: 'cf', api: 'cloudflare-workers-ai-system-one', dialect, model: dialect === 'cloudflare-jev' ? 'typesafe/jev' : 'clef',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/account', apiKeyEnv: 'CF_KEY' }, { state: 'hello', questions: { yes: { type: 'bool', instructions: 'Yes?' } } });
  expect(result.answers.yes).toEqual({ type: 'bool', probability: 0.8 });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  if (dialect === 'cloudflare-jev') {
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/account/ai/run');
    expect(body).toMatchObject({ model: 'typesafe/jev', input: { state: 'hello', questions: { yes: { type: 'noul' } } } });
  } else {
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/cloudflare/clef');
    expect(body).toMatchObject({ model: 'clef', state: 'hello', questions: { yes: { type: 'noul' } } });
    expect(body.input).toBeUndefined();
  }
});

it('routes the declared Vercel classifier through its TypeSafe API root', async () => {
  vi.stubEnv('AI_GATEWAY_API_KEY', 'fixture');
  const wire = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ answers: { check: { type: 'noul', noul: 0.8 } } })); vi.stubGlobal('fetch', wire);
  const connection = createProviderOperationConnection('vercel-ai-gateway', { name: 'vercel-classifier', api: 'typesafe-system-one', model: 'typesafe/jev' });
  await classify(connection, { state: 'evidence', questions: { check: { type: 'bool', instructions: 'Check?' } } });
  expect(wire.mock.calls[0]?.[0]).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
  expect(new Headers(wire.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer fixture');
});
