import { expect, it } from 'vitest';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

it('retains refusal as its own notice without changing the assistant body', async () => {
  const owner = new SessionViewOwner(async () => ({ session: { id: 's', title: 'Notice' },
    settings: {}, items: [], queue: [], interactions: [], runs: [] }), async () => undefined);
  const views: ClientSessionView[] = [];
  const observation = await owner.observe('s', view => views.push(view));
  try {
    const events = owner.events('s', 'r');
    events.onOutputSegmentStart?.({ responseId: 'turn', outputId: 'answer', providerRequestId: 'request', mode: 'append' });
    events.onTextDelta?.('Provider answer.', { providerRequestId: 'request' });
    events.onOutputNotice?.({ code: 'model_refused' }, { providerRequestId: 'request' });
    await expect.poll(() => views.at(-1)?.items.filter(item => item.type === 'info').length).toBe(1);
    expect(views.at(-1)?.items.filter(item => item.type === 'assistant').map(item => item.text)).toEqual(['Provider answer.']);
    expect(views.at(-1)?.items.find(item => item.type === 'info')?.text).toBe('[Model] The provider declined to answer.');
    events.onOutputNotice?.({ code: 'model_refused' }, { providerRequestId: 'child-request', childAgentId: 'child' });
    await owner.flush('s');
    expect(views.at(-1)?.items.filter(item => item.type === 'info')).toHaveLength(1);
    owner.resetHistory('s');
    events.onOutputNotice?.({ code: 'model_refused' }, { providerRequestId: 'request' });
    await expect.poll(() => views.at(-1)?.items.length).toBe(0);
  } finally { observation.close(); await owner.close(); }
});
