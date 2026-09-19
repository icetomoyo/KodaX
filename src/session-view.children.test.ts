import { expect, it } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { buildChildActivityViewModel } from '../packages/repl/src/ui/view-models/child-activity.js';
import { SessionViewOwner } from './session-view.js';

it('routes recovery and interleaved retry-after pairs by child and physical request without polluting parent history', async () => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Recovery' },
    settings: {}, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  let view: ClientSessionView | undefined;
  const observation = await owner.observe('session', next => { view = next; });
  const events = owner.events('session', 'parent');
  const first = { childAgentId: 'one', providerRequestId: 'request-a' };
  const second = { childAgentId: 'two', providerRequestId: 'request-b' };
  const retry = { provider: 'test', waitMs: 500, reason: 'rate-limit' as const,
    source: 'retry-after-ms' as const, attempt: 1, maxAttempts: 3 };
  const detail = (id: string) => view?.activity?.children?.find(child => child.id === id)?.detail;
  try {
    events.onProviderRecovery?.({ stage: 'before_first_delta', errorClass: 'request_timeout', attempt: 1,
      maxAttempts: 3, delayMs: 500, recoveryAction: 'fresh_connection_retry', ladderStep: 1, fallbackUsed: false }, first);
    await expect.poll(() => detail('one')).toContain('Provider request timed out');
    expect(view?.items).toEqual([]);
    events.onRetryAfter?.(retry, first);
    events.onRetryAfter?.({ ...retry, provider: 'second' }, second);
    // A parent legacy-only event with the same numbers is not a child duplicate.
    events.onProviderRateLimit?.(1, 3, 500, { providerRequestId: 'parent-request' });
    events.onProviderRateLimit?.(1, 3, 500, first);
    events.onProviderRateLimit?.(1, 3, 500, second);
    await expect.poll(() => view?.items.map(item => item.text)).toEqual(['[Rate Limit] Retrying in 0.5s (1/3)...']);
    expect(detail('one')).toContain('[Rate limited] (test)');
    expect(detail('two')).toContain('[Rate limited] (second)');
    // Same child, a different physical request: do not suppress its legacy-only retry.
    events.onRetryAfter?.(retry, first);
    events.onProviderRateLimit?.(1, 3, 500, { ...first, providerRequestId: 'request-c' });
    await expect.poll(() => detail('one')).toBe('[Rate Limit] Retrying in 0.5s (1/3)...');
    const next = owner.events('session', 'next-run');
    next.onIterationStart?.(1, 3);
    events.onProviderRecovery?.({ stage: 'before_first_delta', errorClass: 'request_timeout', attempt: 1,
      maxAttempts: 3, delayMs: 500, recoveryAction: 'fresh_connection_retry', ladderStep: 1, fallbackUsed: false }, second);
    await expect.poll(() => view?.activity?.children).toBeUndefined();
    expect(view?.items).toHaveLength(1);
  } finally { observation.close(); await owner.close(); }
});

it('keeps child tool progress, completion and retries in the attributed live activity', async () => {
  const saved: unknown[] = [];
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Children' },
    settings: {}, items: [], queue: [], interactions: [], runs: [] }),
  async (_session, _runs, items) => { saved.push(items); });
  let view: ClientSessionView | undefined;
  const observation = await owner.observe('session', next => { view = next; });
  const events = owner.events('session', 'parent');
  const first = { contextKind: 'child' as const, childAgentId: 'one', childAgentName: 'Reader' };
  const second = { contextKind: 'child' as const, childAgentId: 'two', childAgentName: 'Reviewer' };
  const rows = () => buildChildActivityViewModel(view?.activity?.children ?? [], 3, Date.now()).rows.map(row => row.text).join('\n');
  try {
    events.onToolUseStart?.({ id: 'call', name: 'read', input: { path: 'a.ts' } }, first);
    events.onToolUseStart?.({ id: 'call', name: 'read', input: { path: 'b.ts' } }, second);
    events.onToolProgress?.({ id: 'call', message: 'Reading first file' }, first);
    await expect.poll(rows).toContain('Reading first file');
    expect(rows()).toContain('b.ts');
    events.onToolResult?.({ id: 'call', name: 'read', content: 'private tool output' }, first);
    await expect.poll(rows).toContain('read completed');
    events.onRetry?.('Child reconnect', 1, 3, second);
    await expect.poll(rows).toContain('Child reconnect · retry 1/3');
    expect(view?.items).toEqual([]);
    owner.checkpoint('session');
    await owner.flush('session');
    expect(JSON.stringify(saved)).not.toContain('private tool output');
    events.onChildActivityEnd?.(first);
    await expect.poll(() => view?.activity?.children?.map(child => child.label)).toEqual(['Reviewer']);
    const next = owner.events('session', 'next-run');
    next.onIterationStart?.(1, 3);
    events.onRetry?.('late previous run', 2, 3, second);
    owner.changed('session');
    await expect.poll(() => view?.activity?.children).toBeUndefined();
  } finally { observation.close(); await owner.close(); }
});
