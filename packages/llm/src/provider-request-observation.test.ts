import { expect, it } from 'vitest';
import { withProviderRequestCredential } from './provider-credential-context.js';
import { observeProviderAttempt, observeProviderFetch, observeProviderStreamUsage, runWithAdditionalProviderRequestObserver, runWithProviderRequestObserver, type ProviderRequestObservation } from './provider-request-observation.js';

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

it('adds isolated parallel observers without replacing the owner or changing explicit replacement', async () => {
  const owner: ProviderRequestObservation[] = [];
  const scopes: ProviderRequestObservation[][] = [[], []];
  await runWithProviderRequestObserver(fact => owner.push(fact), () => Promise.all(scopes.map((facts, index) =>
    runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () =>
      withProviderRequestCredential(`child-${index}`, 'primary', undefined, async () => {
        await Promise.resolve();
        return { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      })))));
  expect(owner).toHaveLength(4);
  expect(scopes[0]!.map(fact => fact.provider)).toEqual(['child-0', 'child-0']);
  expect(scopes[1]!.map(fact => fact.provider)).toEqual(['child-1', 'child-1']);

  const replacement: ProviderRequestObservation[] = [];
  await runWithAdditionalProviderRequestObserver(fact => owner.push(fact), () =>
    runWithProviderRequestObserver(fact => replacement.push(fact), () =>
      withProviderRequestCredential('different-session', 'primary', undefined, async () => ({}))));
  expect(owner).toHaveLength(4);
  expect(replacement).toHaveLength(2);
});

it.each([
  [{ inputTokens: 10, outputTokens: 50 }, { inputTokens: 10, outputTokens: 50, totalTokens: 60 }],
  [{ inputTokens: Number.NaN, outputTokens: 50 }, undefined],
  [{ inputTokens: 10, outputTokens: -1 }, undefined],
])('normalizes observed usage without inventing or propagating invalid totals: %j', async (usage, expected) => {
  const facts: ProviderRequestObservation[] = [];
  await runWithProviderRequestObserver(fact => facts.push(fact), () =>
    withProviderRequestCredential('custom', 'primary', undefined, async () => ({ usage })));
  expect(facts.at(-1)?.usage).toEqual(expected);
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

it('keeps partial usage on its physical attempt and never substitutes it for final usage', async () => {
  const facts: ProviderRequestObservation[] = [];
  const fetcher = observeProviderFetch(async () => new Response(''));
  await runWithProviderRequestObserver(fact => facts.push(fact), () => withProviderRequestCredential('http', 'sidecar', undefined,
    () => observeProviderAttempt('http', 'model', async () => {
      await fetcher('https://fixture.invalid');
      observeProviderStreamUsage({ inputTokens: 12, outputTokens: 2, totalTokens: 14 });
      // A replacement HTTP attempt must not inherit the first stream's progress.
      await fetcher('https://fixture.invalid');
      observeProviderStreamUsage({ inputTokens: Number.NaN, outputTokens: 2, totalTokens: 14 });
      await fetcher('https://fixture.invalid');
      observeProviderStreamUsage({ inputTokens: 4, outputTokens: 0, totalTokens: 4 });
      return { usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } };
    })));
  const terminal = facts.filter(f => f.boundary === 'physical_attempt' && f.state !== 'started');
  expect(terminal).toHaveLength(3);
  expect(terminal[0]).toMatchObject({ state: 'failed', partialUsage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 } });
  expect(terminal[0]?.usage).toBeUndefined();
  expect(terminal[1]?.partialUsage).toBeUndefined();
  expect(terminal[2]?.usage).toEqual({ inputTokens: 4, outputTokens: 3, totalTokens: 7 });
  expect(terminal[2]?.partialUsage).toBeUndefined();
});
