import { expect, it } from 'vitest';
import type { ClientSessionView, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { SessionViewOwner } from './session-view.js';

type EpochView = ClientSessionView & { readonly epoch?: string };

function ownerOf(items: () => readonly ClientViewItem[]): SessionViewOwner {
  return new SessionViewOwner(async () => ({
    session: { id: 'session', title: 'Bounds' }, settings: {}, items: [...items()], queue: [], interactions: [], runs: [],
  }), async () => undefined);
}

/** The next view an observer is sent after the Session changed. */
async function nextView(owner: SessionViewOwner, read: () => EpochView | undefined, change: () => void): Promise<EpochView> {
  const before = read();
  change();
  owner.changed('session', true);
  await expect.poll(read, { timeout: 2000 }).not.toBe(before);
  return read()!;
}

it('bounds each item on its own, so one item growing changes no other', async () => {
  let items: ClientViewItem[] = [
    { id: 'query', type: 'user', text: 'Review the worktree.' },
    ...Array.from({ length: 40 }, (_, index): ClientViewItem => ({
      id: `long-${index}`, type: 'assistant', text: `block ${index} ` + '正文'.repeat(10_000),
    })),
    { id: 'tool', type: 'tool', text: 'ok', tool: { callId: 'c', name: 'bash', status: 'success', inputText: 'x'.repeat(5000) } },
    { id: 'live', type: 'assistant', text: 'a'.repeat(100) },
  ];
  const owner = ownerOf(() => items);
  let view: EpochView | undefined;
  const observation = await owner.observe('session', next => { view = next; }, { bounds: 'item' });
  try {
    const first = view!;
    for (const item of first.items.filter(candidate => candidate.id.startsWith('long-'))) {
      const source = items.find(candidate => candidate.id === item.id)!.text;
      expect(item.text.length).toBeGreaterThan(3072);
      expect(item.text.length).toBeLessThanOrEqual(6144);
      expect(item.text).toBe(source.slice(item.textOffset));
      expect(item.totalTextLength).toBe(source.length);
    }
    expect(first.items.find(item => item.id === 'tool')!.tool).toMatchObject({ inputText: 'x'.repeat(2048), totalInputLength: 5000 });
    expect(first.items.find(item => item.id === 'query')).toEqual(items[0]);

    const grown = await nextView(owner, () => view, () => {
      items = [...items.slice(0, -1), { id: 'live', type: 'assistant', text: 'a'.repeat(200_000) }];
    });
    expect(grown.items.filter(item => item.id !== 'live')).toEqual(first.items.filter(item => item.id !== 'live'));
  } finally { observation.close(); await owner.close(); }
});

it('moves the start of a growing text seldom, so most growth is an append', async () => {
  let text = '';
  const owner = ownerOf(() => [{ id: 'live', type: 'assistant', text }]);
  let view: EpochView | undefined;
  const observation = await owner.observe('session', next => { view = next; }, { bounds: 'item' });
  try {
    const starts = new Set<number>();
    for (let length = 6000; length <= 14_000; length += 500) {
      const next = await nextView(owner, () => view, () => { text = 'b'.repeat(length); });
      const [item] = next.items;
      expect(item!.text.length + (item!.textOffset ?? 0)).toBe(length);
      expect(item!.text.length).toBeLessThanOrEqual(6144);
      starts.add(item!.textOffset ?? 0);
    }
    expect([...starts]).toEqual([0, 3072, 6144, 9216]);
  } finally { observation.close(); await owner.close(); }
});

it('never starts or ends a cut text inside a surrogate pair', async () => {
  const owner = ownerOf(() => [{
    id: 'tool', type: 'tool', text: 'x' + '😀'.repeat(5000),
    tool: { callId: 'c', name: 'bash', status: 'success', inputText: 'y' + '😀'.repeat(2000) },
  }]);
  let view: EpochView | undefined;
  const observation = await owner.observe('session', next => { view = next; }, { bounds: 'item' });
  try {
    const [item] = view!.items;
    expect(/[\uDC00-\uDFFF]/u.test(item!.text.charAt(0))).toBe(false);
    expect(/[\uD800-\uDBFF]/u.test(item!.tool!.inputText!.at(-1)!)).toBe(false);
    expect(item!.tool!.inputText!.length).toBeLessThanOrEqual(2048);
  } finally { observation.close(); await owner.close(); }
});

it('keeps the shared text budget for an observer that did not ask for item bounds', async () => {
  const items: ClientViewItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: `long-${index}`, type: 'assistant', text: '正文'.repeat(10_000),
  }));
  const owner = ownerOf(() => items);
  let shared: EpochView | undefined;
  let bounded: EpochView | undefined;
  const observations = [
    await owner.observe('session', next => { shared = next; }),
    await owner.observe('session', next => { bounded = next; }, { bounds: 'item' }),
  ];
  try {
    expect(shared!.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(128 * 1024);
    expect(shared!.epoch).toBeUndefined();
    expect(bounded!.items.reduce((sum, item) => sum + item.text.length, 0)).toBeGreaterThan(128 * 1024);
    expect(bounded!.epoch).toEqual(expect.any(String));
  } finally { for (const observation of observations) observation.close(); await owner.close(); }
});

it('changes the epoch when history is rebuilt, and only then', async () => {
  let items: ClientViewItem[] = [{ id: 'a', type: 'user', text: 'one' }];
  const owner = ownerOf(() => items);
  let view: EpochView | undefined;
  const observation = await owner.observe('session', next => { view = next; }, { bounds: 'item' });
  try {
    const epoch = view!.epoch;
    const added = await nextView(owner, () => view, () => { items = [...items, { id: 'b', type: 'assistant', text: 'two' }]; });
    expect(added.epoch).toBe(epoch);

    const before = view;
    items = [{ id: 'a', type: 'user', text: 'one' }];
    owner.resetHistory('session');
    await expect.poll(() => view, { timeout: 2000 }).not.toBe(before);
    expect(view!.epoch).not.toBe(epoch);

    const other = ownerOf(() => items);
    let restarted: EpochView | undefined;
    const again = await other.observe('session', next => { restarted = next; }, { bounds: 'item' });
    expect(restarted!.epoch).not.toBe(view!.epoch);
    again.close();
    await other.close();
  } finally { observation.close(); await owner.close(); }
});
