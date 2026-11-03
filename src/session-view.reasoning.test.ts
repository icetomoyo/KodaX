import { expect, it } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

it.each([
  { reason: 'implicit profile alias', requestedEffort: 'medium', sentEffort: 'high', fallbacks: [] },
  { reason: 'explicit profile alias', requestedEffort: 'medium', sentEffort: 'high',
    fallbacks: [{ effort: 'medium', reason: 'profile' }] },
  { reason: 'learned rejection', requestedEffort: 'high', sentEffort: 'medium',
    fallbacks: [{ effort: 'high', reason: 'cached-rejection' }] },
] as const)('keeps a high session quiet across repeated $reason resolutions', async ({ requestedEffort, sentEffort, fallbacks }) => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: 'Reasoning' },
    settings: { effort: 'high' }, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  const events = owner.events('session', 'run');
  try {
    for (const providerRequestId of ['first', 'second']) {
      events.onOutputSegmentStart?.({ responseId: providerRequestId, providerRequestId, mode: 'append' });
      events.onReasoningResolved?.({ provider: 'deepseek', model: 'deepseek-flash', requestedEffort,
        sentEffort, verified: false, fallbacks: [...fallbacks], providerRequestId });
    }
    const views: ClientSessionView[] = [];
    const observation = await owner.observe('session', view => views.push(view));
    try {
      expect(views.at(-1)?.settings.effort).toBe('high');
      expect(views.at(-1)?.items).toEqual([]);
      expect(views.at(-1)?.activity).toMatchObject({ reasoning: {
        providerRequestId: 'second', requestedEffort, sentEffort, verified: false,
      } });
    } finally { observation.close(); }
  } finally { await owner.close(); }
});

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
    for (const meta of [{ providerRequestId: 'first' }, { providerRequestId: 'second', childAgentId: 'child' },
      { providerRequestId: 'second', workflowCorrelation: { workflowRunId: 'workflow' } }]) {
      events.onReasoningResolved?.({ provider: 'provider', model: 'model', requestedEffort: 'max', sentEffort: 'none',
        verified: false, fallbacks: [{ effort: 'max', reason: 'unsupported-effort' }], ...meta });
    }
    await expect.poll(() => views.at(-1)?.items.length).toBe(2);
    expect(views.at(-1)?.items.map(item => item.text)).toEqual([
      "[Reasoning] provider/model rejected effort 'high'.",
      "[Reasoning] provider/model sent effort 'medium' (requested 'high'; unverified).",
    ]);
    expect(views.at(-1)?.settings.effort).toBe('high');
    expect(views.at(-1)?.activity).toMatchObject({ reasoning: {
      providerRequestId: 'second', requestedEffort: 'high', sentEffort: 'medium', verified: false,
    } });
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
