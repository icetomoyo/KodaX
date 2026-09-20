import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSessionStorage } from '@kodax-ai/repl';
import type { KodaXSessionData } from '@kodax-ai/agent';
import type { ClientSessionView } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner, persistSessionViewItems, restoreSessionViewItems, mergeSessionViewItems } from './session-view.js';
import { readFrozenClientPlaneItems } from '../packages/repl/src/ui/client-plane.js';

it('keeps a revised committed frozen output readable after it leaves the display window', async () => {
  const body = `FINAL${'x'.repeat(70_000)}`;
  const data: KodaXSessionData = { title: 'Frozen ownership', gitRoot: '', messages: [] };
  const views: ClientSessionView[] = [];
  const owner = new SessionViewOwner(async (_session, _history, _previous, live) => ({
    session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [],
    items: restoreSessionViewItems('session', data, data.messages, live),
    committedOutputIds: data.messages.flatMap(message => message.outputId ? [message.outputId] : []),
  }), async () => undefined, async (_session, itemId) =>
    restoreSessionViewItems('session', data, data.messages.slice(0, 1)).find(item => item.id === itemId) ?? null);
  const observation = await owner.observe('session', view => views.push(view));
  try {
    const events = owner.events('session', 'run');
    events.onOutputSegmentStart?.({ outputId: 'output', responseId: 'turn', providerRequestId: 'request', mode: 'append' });
    events.onTextDelta?.(`DRAFT${'x'.repeat(70_000)}`, { providerRequestId: 'request' });
    data.messages.push({ role: 'assistant', outputId: 'output', content: body });
    owner.changed('session', true);
    await expect.poll(() => views.at(-1)?.items.find(item => item.outputId === 'output')?.outputState).toBe('committed');
    const frozen = views.at(-1)!.items.find(item => item.outputId === 'output')!;
    data.messages.push(...Array.from({ length: 85 }, (_, index) => [
      { role: 'user' as const, content: `Query ${index}`, inputId: `input-${index}` },
      { role: 'assistant' as const, content: `Answer ${index}`, outputId: `later-${index}` },
    ]).flat());
    owner.changed('session', true);
    await expect.poll(() => views.at(-1)?.items.some(item => item.id === frozen.id)).toBe(false);
    const restored = await readFrozenClientPlaneItems({ readItem: async (session, id, options) =>
      owner.readItem(session, id, typeof options === 'number' ? { offset: options } : options) },
      'session', [{ ...frozen, type: 'assistant', timestamp: 0 }]);
    expect(restored).toMatchObject([{ text: body }]);
  } finally { observation.close(); await owner.close(); }
});

it('transfers an appended draft to its canonical message without changing identity or reading stale text', async () => {
  const data: KodaXSessionData = { title: 'Output ownership', gitRoot: '', messages: [
    { role: 'user', inputId: 'input', content: 'query' },
  ] };
  const views: ClientSessionView[] = [];
  const owner = new SessionViewOwner(async (_session, _history, _previous, live) => ({
    session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [],
    items: restoreSessionViewItems('session', data, data.messages, live),
    committedOutputIds: data.messages.flatMap(message => message.outputId ? [message.outputId] : []),
  }), async (_session, _runs, items) => { data.uiHistory = persistSessionViewItems(items); });
  const observation = await owner.observe('session', view => views.push(view));
  try {
    const events = owner.events('session', 'run', undefined, () => 'input');
    events.onOutputSegmentStart?.({ responseId: 'turn', outputId: 'output', providerRequestId: 'first', mode: 'append' });
    events.onTextDelta?.('First ', { providerRequestId: 'first' });
    events.onOutputSegmentStart?.({ responseId: 'turn', outputId: 'output', providerRequestId: 'next', mode: 'append' });
    events.onTextDelta?.('part ', { providerRequestId: 'next' });
    await expect.poll(() => views.at(-1)?.items.filter(item => item.type === 'assistant').map(item => item.text)).toEqual(['First part ']);
    const id = views.at(-1)!.items.find(item => item.type === 'assistant')!.id;
    const frozenDraft = await owner.readItem('session', id);
    expect(frozenDraft).toMatchObject({ outputState: 'draft' });
    owner.checkpoint('session');
    await owner.flush('session');
    data.messages.push({ role: 'assistant', content: 'First part', outputId: 'output' });
    owner.changed('session', true);
    await expect.poll(() => views.at(-1)?.items.filter(item => item.type === 'assistant').map(item => [item.id, item.text, item.outputState]))
      .toEqual([[id, 'First part', 'committed']]);
    expect(await owner.readItem('session', id)).toMatchObject({ text: 'First part', outputState: 'committed' });
    owner.checkpoint('session');
    await owner.flush('session');
    expect(data.uiHistory?.some(item => 'outputId' in item && item.outputId === 'output')).toBe(false);
    expect(restoreSessionViewItems('session', data, data.messages).filter(item => item.type === 'assistant'))
      .toMatchObject([{ id, text: 'First part', outputId: 'output', outputState: 'committed' }]);
    const restarted = new SessionViewOwner(async () => ({
      session: { id: 'session', title: data.title }, settings: {}, queue: [], interactions: [], runs: [],
      items: restoreSessionViewItems('session', data, data.messages),
    }), async () => undefined);
    try {
      const content = await restarted.readItem('session', id);
      expect(content).toMatchObject({ outputState: 'committed', textRevision: 0 });
      expect(frozenDraft?.textRevision ?? 0).toBe(content?.textRevision);
      expect(frozenDraft?.outputState).not.toBe(content?.outputState);
    } finally { await restarted.close(); }
  } finally { observation.close(); await owner.close(); }
});

it('keeps one output attached to its starting input across continuation and revises only replaced text', async () => {
  const views: ClientSessionView[] = [];
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Continuation' }, settings: {}, queue: [], interactions: [], runs: [], items: [],
  }), async () => undefined);
  let inputId = 'original';
  const observation = await owner.observe('session', view => views.push(view));
  try {
    const events = owner.events('session', 'run', undefined, () => inputId);
    events.onOutputSegmentStart?.({ outputId: 'output', responseId: 'turn', providerRequestId: 'first', mode: 'append' });
    events.onTextDelta?.('preserved ', { providerRequestId: 'first' });
    inputId = 'queued';
    events.onOutputSegmentStart?.({ outputId: 'output', responseId: 'turn', providerRequestId: 'second', mode: 'append' });
    events.onThinkingDelta?.('thinking ', { providerRequestId: 'second' });
    events.onThinkingDelta?.('blocks', { providerRequestId: 'second' });
    events.onThinkingEnd?.('blocks', { providerRequestId: 'second' });
    events.onTextDelta?.('abandoned', { providerRequestId: 'second' });
    await expect.poll(() => views.at(-1)?.items.find(item => item.type === 'thinking')?.afterInputId).toBe('original');
    expect(views.at(-1)?.items.find(item => item.type === 'thinking')?.text).toBe('thinking blocks');
    const before = views.at(-1)!.items.find(item => item.type === 'assistant')!;
    events.onOutputSegmentStart?.({ outputId: 'output', responseId: 'turn', providerRequestId: 'replacement', mode: 'replace' });
    events.onTextDelta?.('replacement', { providerRequestId: 'replacement' });
    events.onTextDelta?.('LATE', { providerRequestId: 'second' });
    await expect.poll(() => views.at(-1)?.items.find(item => item.type === 'assistant')?.text).toBe('preserved replacement');
    expect(views.at(-1)!.items.find(item => item.type === 'assistant')).toMatchObject({ id: before.id, textRevision: 1 });
  } finally { observation.close(); await owner.close(); }
});

it('restores multi-block canonical output without adding separators or reviving a settled out-of-window draft', () => {
  const data: KodaXSessionData = { title: 'Blocks', gitRoot: '', messages: [
    { role: 'user', content: 'query', inputId: 'input' },
    { role: 'assistant', outputId: 'blocks', content: [
      { type: 'thinking', thinking: 'First ' }, { type: 'thinking', thinking: 'thought' },
      { type: 'text', text: 'First ' }, { type: 'text', text: 'answer' },
    ] },
    ...Array.from({ length: 55 }, (_, index) => ({ role: 'user' as const, content: `Later ${index}`, inputId: `later-${index}` })),
  ], uiHistory: persistSessionViewItems([
    { id: 'old-draft', type: 'assistant', outputId: 'blocks', outputState: 'draft', text: 'First answer' },
    { id: 'still-partial', type: 'assistant', outputId: 'other', outputState: 'draft', text: 'Interrupted' },
  ]) };
  expect(restoreSessionViewItems('session', data, data.messages).some(item => item.outputId === 'blocks')).toBe(false);
  expect(restoreSessionViewItems('session', data, data.messages).some(item => item.outputId === 'other')).toBe(true);
  expect(restoreSessionViewItems('session', { ...data, messages: data.messages.slice(0, 2) }).filter(item => item.outputId === 'blocks')
    .map(item => [item.type, item.text])).toEqual([['thinking', 'First thought'], ['assistant', 'First answer']]);
});

it('does not use an identified committed output as text evidence to discard a legacy partial', () => {
  const items = mergeSessionViewItems([
    { id: 'input', type: 'user', inputId: 'input', text: 'query' },
    { id: 'owned', type: 'assistant', outputId: 'owned', outputState: 'committed', text: 'same' },
  ], [{ id: 'legacy', type: 'assistant', afterInputId: 'input', text: 'same' }]);
  expect(items.filter(item => item.type === 'assistant').map(item => item.id)).toEqual(['owned', 'legacy']);
});

it('restores a checkpointed partial and a distinct same-text committed answer from real storage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-output-ownership-'));
  const storage = new FileSessionStorage({ sessionsDir: directory });
  const data: KodaXSessionData = { title: 'Recovery', gitRoot: '', messages: [
    { role: 'user', inputId: 'first-input', content: 'first' },
    { role: 'user', inputId: 'second-input', content: 'second' },
    { role: 'assistant', outputId: 'completed', content: 'same answer' },
  ], uiHistory: persistSessionViewItems([
    { id: 'partial', type: 'assistant', outputId: 'cancelled', outputState: 'draft', afterInputId: 'first-input', text: 'same answer' },
    { id: 'completed-draft', type: 'assistant', outputId: 'completed', outputState: 'draft', afterInputId: 'second-input', text: 'same answer' },
    { id: 'notice', type: 'info', text: 'Retry retained' },
  ]) };
  try {
    await storage.save('recovery', data);
    const loaded = await new FileSessionStorage({ sessionsDir: directory }).load('recovery');
    expect(loaded).not.toBeNull();
    const restored = restoreSessionViewItems('recovery', loaded, loaded!.messages);
    expect(restored.filter(item => item.type === 'user' || item.type === 'assistant').map(item => [item.type, item.text, item.outputId]))
      .toEqual([['user', 'first', undefined], ['assistant', 'same answer', 'cancelled'],
        ['user', 'second', undefined], ['assistant', 'same answer', 'completed']]);
    expect(restored.filter(item => item.type === 'assistant').map(item => item.outputState)).toEqual(['draft', 'committed']);
    expect(restored.some(item => item.text === 'Retry retained')).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
