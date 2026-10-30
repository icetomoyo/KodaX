import { afterEach, expect, it, vi } from 'vitest';
import { classify, runWithProviderRequestObserver } from '../index.js';
import type { ProviderRequestObservation } from '../provider-request-observation.js';

afterEach(() => vi.unstubAllGlobals());
it('classifies from llama native label log-probabilities with a bounded deeper readout', async () => {
  let reads = 0;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('/tokenize')) return Response.json({ tokens: body.content === '\n' ? [10] : [10, body.content.endsWith('0') ? 100 : 101] });
    if (String(url).endsWith('/apply-template')) return Response.json({ prompt: 'rendered' });
    reads++;
    return Response.json({ completion_probabilities: [{ top_logprobs: reads === 1 ? [{ id: 100, logprob: Math.log(0.2) }]
      : [{ id: 100, logprob: Math.log(0.2) }, { id: 101, logprob: Math.log(0.8) }] }], tokens_evaluated: 16, tokens_predicted: 1 });
  });
  vi.stubGlobal('fetch', fetcher);
  const facts: ProviderRequestObservation[] = [];
  const result = await runWithProviderRequestObserver(fact => facts.push(fact), () => classify({ name: 'local', api: 'llama-cpp-classify',
    model: 'local-fixture', baseUrl: 'http://127.0.0.1:8080' }, { state: 'evidence', questions: { urgent: { type: 'bool', instructions: 'Urgent?' } } }));
  expect(result.answers.urgent).toEqual({ type: 'bool', probability: 0.8 });
  expect(result.usage).toMatchObject({ inputTokens: 32, outputTokens: 2 });
  const calls = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/completion'));
  expect(calls).toHaveLength(2);
  expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({ n_predict: 1, post_sampling_probs: false });
  expect(JSON.parse(String(calls[1]?.[1]?.body)).n_probs).toBeGreaterThan(JSON.parse(String(calls[0]?.[1]?.body)).n_probs);
  const physical = facts.filter(f => f.boundary === 'physical_attempt' && f.state !== 'started');
  expect(physical).toHaveLength(fetcher.mock.calls.length);
  expect(physical.every(f => f.state === 'succeeded')).toBe(true);
});
