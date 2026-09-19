import { expect, it } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

it('retains observed reasoning feedback without mixing child, replaced, or reset requests', async () => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Reasoning' },
    settings: { effort: 'high' }, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  const events = owner.events('session', 'run');
  const views: ClientSessionView[] = [];
  const observation = await owner.observe('session', view => views.push(view));
  const rejected = { provider: 'provider', model: 'model', effort: 'high' };
  try {
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'first', mode: 'append' });
    events.onReasoningEffortRejected?.({ ...rejected, providerRequestId: 'first' });
    events.onOutputSegmentStart?.({ responseId: 'response', providerRequestId: 'second', mode: 'replace' });
    events.onReasoningEffortRejected?.({ ...rejected, effort: 'stale', providerRequestId: 'first' });
    events.onReasoningEffortRejected?.({ ...rejected, effort: 'child', providerRequestId: 'second', childAgentId: 'child' });
    events.onReasoningEffortRejected?.({ ...rejected, effort: 'workflow', providerRequestId: 'second',
      workflowCorrelation: { workflowRunId: 'workflow' } });
    events.onReasoningResolved?.({ provider: 'provider', model: 'model', requestedEffort: 'high',
      sentEffort: 'medium', verified: false, fallbacks: [{ effort: 'high', reason: 'unsupported-effort' }], providerRequestId: 'second' });
    await expect.poll(() => views.at(-1)?.items.length).toBe(2);
    expect(views.at(-1)?.items.map(item => item.text)).toEqual([
      "[Reasoning] provider/model rejected effort 'high'.",
      "[Reasoning] provider/model sent effort 'medium' (requested 'high'; unverified).",
    ]);
    expect(views.at(-1)?.settings.effort).toBe('high');
    // Routine resolutions add no notice, and absent wire parameters are never called accepted.
    events.onReasoningResolved?.({ provider: 'provider', model: 'model', requestedEffort: 'auto',
      sentEffort: 'medium', verified: false, fallbacks: [], providerRequestId: 'second' });
    events.onReasoningResolved?.({ provider: 'provider', model: 'model', requestedEffort: 'high',
      verified: false, fallbacks: [{ reason: 'unsupported-parameter' }], providerRequestId: 'second' });
    await expect.poll(() => views.at(-1)?.items.at(-1)?.text).toContain('sent without an effort parameter');
    owner.resetHistory('session');
    events.onReasoningEffortRejected?.({ ...rejected, providerRequestId: 'second' });
    events.onReasoningEffortRejected?.(rejected);
    await expect.poll(() => views.at(-1)?.items.length).toBe(0);
  } finally { observation.close(); await owner.close(); }
});
