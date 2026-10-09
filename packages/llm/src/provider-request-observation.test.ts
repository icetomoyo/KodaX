import { expect, it } from 'vitest';
import { withProviderRequestCredential } from './provider-credential-context.js';
import { observeProviderAttempt, observeProviderFetch, runWithProviderRequestObserver, type ProviderRequestObservation } from './provider-request-observation.js';

it('records an in-flight non-fetch adapter before completion and retains its identity', async () => {
  const facts: ProviderRequestObservation[] = [];
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const pending = runWithProviderRequestObserver(fact => facts.push(fact), () =>
    withProviderRequestCredential('custom', 'compaction', undefined, async () => { await wait; return { usage: { inputTokens: 5, outputTokens: 2 } }; }));
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ state: 'started', boundary: 'provider_operation', dispatch: 'unknown', purpose: 'compaction' });
  finish(); await pending;
  expect(facts[1]).toMatchObject({ requestId: facts[0]!.requestId, state: 'succeeded', usage: { inputTokens: 5, outputTokens: 2 } });
});

it('refines the pending fact at the physical fetch boundary and assigns SDK retries separate IDs', async () => {
  const facts: ProviderRequestObservation[] = [];
  let calls = 0;
  const fetcher = observeProviderFetch(async () => new Response('', { status: ++calls === 1 ? 503 : 200 }));
  await runWithProviderRequestObserver(fact => facts.push(fact), () => withProviderRequestCredential('http', 'primary', undefined,
    () => observeProviderAttempt('http', 'model', async () => {
      await fetcher('https://fixture.invalid'); await fetcher('https://fixture.invalid');
      return { usage: { inputTokens: 10, outputTokens: 3 } };
    }), 'logical-fixture'));
  const final = new Map(facts.map(fact => [fact.requestId, fact]));
  expect(final.size).toBe(2);
  expect([...final.values()].map(fact => [fact.boundary, fact.state, fact.attempt])).toEqual([
    ['physical_attempt', 'failed', 1], ['physical_attempt', 'succeeded', 2],
  ]);
  expect([...final.values()].every(fact => fact.logicalRequestId === 'logical-fixture')).toBe(true);
});
