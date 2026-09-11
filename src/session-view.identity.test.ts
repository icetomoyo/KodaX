import { expect, it } from 'vitest';
import type { KodaXSessionData, KodaXSessionUiTextHistoryItem } from '@kodax-ai/agent';
import { restoreSessionViewItems, persistSessionViewItems } from './session-view.js';

function message(content: string, timestamp: number, inputId?: string) {
  return { role: 'user' as const, content, timestamp: new Date(timestamp).toISOString(), ...(inputId ? { inputId } : {}) };
}

it('restores readable canonical history without a delivery alias', () => {
  const data: KodaXSessionData = { title: 'Legacy', gitRoot: '', messages: [
    { role: 'user', content: 'query', timestamp: new Date(500).toISOString() },
    { role: 'assistant', content: 'answer', timestamp: new Date(1000).toISOString() },
  ] };
  expect(restoreSessionViewItems('legacy', data, data.messages).map(item => item.text)).toEqual(['query', 'answer']);
});

it('keeps distinct input identities distinct when legacy display text and timestamps coincide', () => {
  const timestamp = 1000;
  const data: KodaXSessionData = { title: 'Distinct inputs', gitRoot: '', messages: [
    message('same', timestamp, 'input-one'),
    message('same', timestamp, 'input-two'),
  ], uiHistory: [
    { id: 'display-one', inputId: 'input-one', type: 'user', text: 'same', timestamp, presentationOnly: true },
    { id: 'display-two', inputId: 'input-two', type: 'user', text: 'same', timestamp, presentationOnly: true },
  ] };
  const users = restoreSessionViewItems('distinct', data, data.messages).filter(item => item.type === 'user');
  expect(users.map(item => item.inputId)).toEqual(['input-one', 'input-two']);
  expect(users.map(item => item.id)).toEqual(['display-one', 'display-two']);
});

it('consumes each legacy display match once instead of lending the same identity repeatedly', () => {
  const timestamp = 2000;
  const data: KodaXSessionData = { title: 'Legacy collisions', gitRoot: '', messages: [
    message('again', timestamp),
    message('again', timestamp),
    message('again', timestamp),
  ], uiHistory: [
    { id: 'legacy-first', type: 'user', text: 'again', timestamp, presentationOnly: true },
    { id: 'legacy-second', type: 'user', text: 'again', timestamp, presentationOnly: true },
  ] };
  const ids = restoreSessionViewItems('legacy-collisions', data, data.messages)
    .filter(item => item.type === 'user').map(item => item.id);
  expect(new Set(ids).size).toBe(3);
  expect(ids.filter(id => id === 'legacy-first')).toHaveLength(1);
  expect(ids.filter(id => id === 'legacy-second')).toHaveLength(1);
});

it('never force-merges an identity-bearing input with an unidentified lookalike display item', () => {
  const timestamp = 3000;
  const data: KodaXSessionData = { title: 'No forced merge', gitRoot: '', messages: [
    message('same', timestamp, 'input-known'),
    message('same', timestamp),
  ], uiHistory: [
    { id: 'legacy-lookalike', type: 'user', text: 'same', timestamp, presentationOnly: true },
  ] };
  const users = restoreSessionViewItems('no-forced-merge', data, data.messages).filter(item => item.type === 'user');
  // The identified input must not borrow the unidentified display item;
  // the legacy message (no identity) still may.
  expect(users[0]?.id).not.toBe('legacy-lookalike');
  expect(users[1]?.id).toBe('legacy-lookalike');
});

it('round-trips accepted input identities through persisted display history', () => {
  const persisted = persistSessionViewItems([
    { id: 'display-live', inputId: 'input-live', type: 'user', text: 'hello', timestamp: 4000 },
    { id: 'run:assistant', type: 'assistant', text: 'answer', timestamp: 4100 },
  ]);
  expect(persisted.find((item): item is KodaXSessionUiTextHistoryItem => item.type === 'user')?.inputId).toBe('input-live');
  const data: KodaXSessionData = { title: 'Round trip', gitRoot: '', messages: [
    message('hello', 4000, 'input-live'),
    { role: 'assistant', content: 'answer', timestamp: new Date(4100).toISOString() },
  ], uiHistory: persisted };
  const users = restoreSessionViewItems('round-trip', data, data.messages).filter(item => item.type === 'user');
  expect(users.map(item => item.id)).toEqual(['display-live']);
  expect(users.map(item => item.inputId)).toEqual(['input-live']);
});
