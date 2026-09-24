import { expect, it } from 'vitest';
import type { KodaXMessage, KodaXSessionData, KodaXSessionEntry } from '@kodax-ai/agent';
import { persistSessionViewItems, restoreSessionViewItems, SessionViewOwner } from './session-view.js';

it.each([false, true])('restores notices before the following input and output (legacy: %s)', async legacy => {
  const messages: KodaXMessage[] = [
    { role: 'user', content: 'Repeat', ...(!legacy ? { inputId: 'first' } : {}) },
    { role: 'assistant', content: 'Earlier answer', ...(!legacy ? { outputId: 'earlier' } : {}) },
    { role: 'user', content: 'Repeat', ...(!legacy ? { inputId: 'second' } : {}) },
    { role: 'assistant', content: 'Current answer', outputId: 'current' },
  ];
  const entries: KodaXSessionEntry[] = messages.map((message, index) => ({
    type: 'message', id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    timestamp: '2026-09-24T00:00:00Z', message,
  }));
  entries.splice(2, 0, { type: 'client_notice', id: 'notice', parentId: 'entry-1',
    timestamp: '2030-01-01T00:00:00Z', source: 'client', content: 'Old notice' });
  const data: KodaXSessionData = { title: 'Notice order', gitRoot: '', messages,
    lineage: { version: 2, activeEntryId: 'entry-3', entries },
    uiHistory: persistSessionViewItems([
      { id: 'notice', type: 'info', text: 'Old notice' },
      { id: 'stale-draft', type: 'assistant', outputId: 'current', outputState: 'draft', text: 'Stale draft' },
    ]),
  };
  const owner = new SessionViewOwner(async () => ({ session: { id: 'session', title: data.title },
    settings: {}, queue: [], interactions: [], runs: [],
    items: restoreSessionViewItems('session', data, structuredClone(messages)),
  }), async () => undefined);
  const views: string[][] = [];
  const observation = await owner.observe('session', view => { views.push(view.items.map(item => item.text)); });
  try {
    expect(views.at(-1)).toEqual(['Repeat', 'Earlier answer', 'Old notice', 'Repeat', 'Current answer']);
    const page = restoreSessionViewItems('session', data, structuredClone(messages.slice(2)));
    expect(page.map(item => item.text)).toEqual(['Old notice', 'Repeat', 'Current answer']);
    expect(page.filter(item => item.id === 'notice')).toHaveLength(1);
    expect(page.filter(item => item.outputId === 'current')).toMatchObject([{ outputState: 'committed' }]);
  } finally { observation.close(); await owner.close(); }
});

it('prefers a proven legacy message reference over a later identical occurrence', () => {
  const earlier: KodaXMessage = { role: 'user', content: 'Repeat' };
  const later: KodaXMessage = { role: 'user', content: 'Repeat' };
  const data: KodaXSessionData = { title: 'Legacy references', gitRoot: '', messages: [earlier, later],
    lineage: { version: 2, activeEntryId: 'second', entries: [
      { type: 'message', id: 'first', parentId: null, timestamp: '2026-09-24T00:00:00Z', message: earlier },
      { type: 'client_notice', id: 'between', parentId: 'first', timestamp: '2026-09-24T00:00:00Z', source: 'client', content: 'Between' },
      { type: 'message', id: 'second', parentId: 'first', timestamp: '2026-09-24T00:00:00Z', message: later },
    ] },
  };
  expect(restoreSessionViewItems('session', data, [earlier]).map(item => item.text)).toEqual(['Repeat', 'Between']);
  data.lineage!.activeEntryId = 'first';
  expect(restoreSessionViewItems('session', data, [structuredClone(earlier)]).map(item => item.text)).toEqual(['Repeat', 'Between']);
});

it('positions a notice before retained tools outside the conversation page by call identity', () => {
  const messages: KodaXMessage[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'Old evidence' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'recent', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: 'Recent evidence' }] },
  ];
  const data: KodaXSessionData = { title: 'Paged notice', gitRoot: '', messages,
    lineage: { version: 2, activeEntryId: 'entry-3', entries: [
      { type: 'client_notice', id: 'notice', parentId: null, timestamp: '2026-09-24T00:00:00Z', source: 'client', content: 'Before tools' },
      ...messages.map((message, index): KodaXSessionEntry => ({ type: 'message', id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null, timestamp: '2026-09-24T00:00:00Z', message })),
    ] },
    uiHistory: persistSessionViewItems([
      { id: 'old-tool', type: 'tool', text: 'Old evidence', tool: { callId: 'old', name: 'read', status: 'success' } },
      { id: 'recent-tool', type: 'tool', text: 'Recent evidence', tool: { callId: 'recent', name: 'read', status: 'success' } },
    ]),
  };
  expect(restoreSessionViewItems('session', data, structuredClone(messages.slice(2))).map(item => item.text))
    .toEqual(['Before tools', 'Old evidence', 'Recent evidence']);
});
