import { expect, it } from 'vitest';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

it('keeps readable previews for earlier query, answer, thinking and tool input after a large output burst', async () => {
  const items: ClientViewItem[] = [
    { id: 'query', type: 'user', text: 'Please review the current worktree.' },
    { id: 'answer', type: 'assistant', text: 'I will inspect the changes and report the findings.' },
    { id: 'thinking', type: 'thinking', text: 'First identify the base revision.' },
    { id: 'tool', type: 'tool', text: 'Changed files: source.ts',
      tool: { callId: 'call', name: 'bash', status: 'success', inputText: '{"command":"git diff --stat"}' } },
    ...Array.from({ length: 24 }, (_, index): ClientViewItem => ({
      id: `long-${index}`, type: index % 2 ? 'thinking' : 'assistant', text: `block ${index} ` + '正文'.repeat(10_000),
    })),
  ];
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Long output' }, settings: {}, items, queue: [], interactions: [], runs: [],
  }), async () => undefined);
  let view: ClientSessionView | undefined;
  const observation = await owner.observe('session', next => { view = next; });
  try {
    for (const source of items.slice(0, 4)) {
      const visible = view?.items.find(item => item.id === source.id);
      expect(visible?.text, `${source.type} preview disappeared`).toBe(source.text);
    }
    expect(view?.items.find(item => item.id === 'tool')?.tool?.inputText).toBe(items[3]!.tool!.inputText);
    expect(view?.items.every(item => item.text.length > 0)).toBe(true);
    expect(view!.items.reduce((sum, item) => sum + item.text.length + (item.tool?.inputText?.length ?? 0), 0)).toBeLessThanOrEqual(128 * 1024);
    expect((await owner.readItem('session', 'long-0'))?.text).toBe(items[4]!.text);
  } finally { observation.close(); await owner.close(); }
});

it('reserves both result and argument previews throughout the retained 150-item window', async () => {
  const items: ClientViewItem[] = Array.from({ length: 151 }, (_, index) => ({
    id: `tool-${index}`, type: 'tool', text: '结果😀'.repeat(5000),
    tool: { callId: `call-${index}`, name: 'bash', status: 'success', inputText: 'command '.repeat(1500) },
  }));
  const owner = new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Full window' }, settings: {}, items, queue: [], interactions: [], runs: [],
  }), async () => undefined);
  let view: ClientSessionView | undefined;
  const observation = await owner.observe('session', next => { view = next; });
  try {
    expect(view!.items).toHaveLength(150);
    expect(view!.items[0]!.id).toBe('tool-1');
    for (const item of view!.items) {
      expect(item.text.length).toBeGreaterThanOrEqual(255);
      expect(item.tool!.inputText!.length).toBeGreaterThanOrEqual(256);
      expect(item.text.length).toBeLessThanOrEqual(8192);
      expect(item.tool!.inputText!.length).toBeLessThanOrEqual(8192);
      expect(item.text).toBe(items[1]!.text.slice(item.textOffset));
      expect(/[\uDC00-\uDFFF]/u.test(item.text.charAt(0))).toBe(false);
    }
    expect(view!.items.reduce((sum, item) => sum + item.text.length + item.tool!.inputText!.length, 0)).toBeLessThanOrEqual(128 * 1024);
    expect((await owner.readItem('session', 'tool-1', { part: 'input' }))?.text).toBe(items[1]!.tool!.inputText);
  } finally { observation.close(); await owner.close(); }
});
