import { describe, expect, it } from 'vitest';

import { applyViewOps, diffSessionView, viewPatchStep, type SyncItem, type SyncView, type ViewOp } from './view-sync.js';

interface Item extends SyncItem {
  readonly state?: 'live' | 'settled';
  readonly tool?: { readonly status: string; readonly progress?: string | undefined };
}
type View = SyncView<Item>;

/** What the other end holds after the value crossed the connection. */
function wire<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function view(items: readonly Item[], keys: Record<string, unknown> = {}): View {
  return { ...keys, items };
}

function item(id: string, text = '', rest: Partial<Item> = {}): Item {
  return { id, text, ...rest };
}

/** Applies what the Host would send and returns the client's copy. */
function follow(copy: View, previous: View, next: View): View {
  const result = applyViewOps(copy, wire(diffSessionView(previous, next)));
  if (result.view === undefined) throw new Error(`The copy lost sync: ${result.resync}.`);
  return result.view;
}

/** Small seeded generator (mulberry32), so a failing sequence can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const WINDOW = 8;
const KEYS = ['runs', 'queue', 'activity', 'fromALaterRevision'];
const WORDS = ['a', 'bc', 'def', '\n', '好', '😀', ' '];

/** One random change of the kind a Session view goes through. */
function mutate(current: View, next: () => number, ids: { count: number }): View {
  const pick = (size: number): number => Math.floor(next() * size);
  const items = [...current.items];
  const keys: Record<string, unknown> = { ...current };
  const target = pick(Math.max(items.length, 1));
  const chosen = items[target];
  const word = WORDS[pick(WORDS.length)]!;
  const fresh = (): Item => item(`item-${ids.count += 1}`, word, { state: 'live' });
  switch (pick(12)) {
    case 0: case 1: case 2:
      if (chosen) items[target] = { ...chosen, text: chosen.text + word,
        ...(chosen.textTotal !== undefined ? { textTotal: chosen.textTotal + word.length } : {}) };
      break;
    case 3:
      // A provider retry: the text is replaced, not extended.
      if (chosen) items[target] = { ...chosen, text: word };
      break;
    case 4:
      // The window over a long text moved: the text still grows, the total does not match an append.
      if (chosen) items[target] = { ...chosen, text: chosen.text.slice(1) + word, textTotal: (chosen.textTotal ?? chosen.text.length) + word.length };
      break;
    case 5:
      if (chosen) items[target] = { ...chosen, state: 'settled', tool: { status: word, progress: undefined } };
      break;
    case 6:
      items.push(fresh());
      break;
    case 7:
      items.splice(target, 0, fresh());
      break;
    case 8:
      if (chosen) items.splice(target, 1);
      break;
    case 9:
      // An item takes another place, as a live item does once history gives it one.
      if (chosen) { items.splice(target, 1); items.splice(pick(items.length + 1), 0, chosen); }
      break;
    case 10:
      keys[KEYS[pick(KEYS.length)]!] = pick(2) === 0 ? { depth: { value: pick(3) }, list: [pick(3), null] } : pick(3);
      break;
    default:
      delete keys[KEYS[pick(KEYS.length)]!];
  }
  // Only the newest items stay in the view.
  return { ...keys, items: items.slice(-WINDOW) };
}

describe('a copy kept by patches', () => {
  it('equals the full view after every step of a random history', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const ids = { count: 0 };
      let host: View = view([]);
      let copy = wire(host);
      for (let step = 0; step < 60; step += 1) {
        const changed = mutate(host, next, ids);
        copy = follow(copy, host, changed);
        expect(copy, `seed ${seed}, step ${step}`).toEqual(wire(changed));
        host = changed;
      }
    }
  });

  it('is unchanged by a view that did not change', () => {
    const next = random(7);
    const ids = { count: 0 };
    let host: View = view([]);
    for (let step = 0; step < 200; step += 1) {
      host = mutate(host, next, ids);
      expect(diffSessionView(host, wire(host))).toEqual([]);
    }
  });
});

describe('diffSessionView', () => {
  it('sends only the new text when an item grew and nothing else changed', () => {
    const previous = view([item('a', 'Hel'), item('b', 'x')]);
    expect(diffSessionView(previous, view([item('a', 'Hello'), item('b', 'x')]))).toEqual([
      { op: 'item.append', id: 'a', field: 'text', text: 'lo' },
    ]);
  });

  it('appends to a cut item whose total grew by the same length', () => {
    const previous = view([item('a', 'tail', { textTotal: 100 })]);
    expect(diffSessionView(previous, view([item('a', 'tail+', { textTotal: 101 })]))).toEqual([
      { op: 'item.append', id: 'a', field: 'text', text: '+' },
    ]);
  });

  it.each([
    ['replaced text', item('a', 'Hallo')],
    ['shortened text', item('a', 'He')],
    ['text that grew together with another field', item('a', 'Hello', { state: 'settled' })],
    ['a total that did not grow with the text', item('a', 'Hello', { textTotal: 900 })],
    ['a field that changed while the text stayed', item('a', 'Hel', { tool: { status: 'success' } })],
  ])('sends the whole item for %s', (_name, changed) => {
    const previous = view([item('a', 'Hel')]);
    expect(diffSessionView(previous, view([changed]))).toEqual([{ op: 'item.put', item: changed }]);
  });

  it('places a new item before its neighbour, or last', () => {
    const previous = view([item('a'), item('c')]);
    expect(diffSessionView(previous, view([item('a'), item('b'), item('c'), item('d')]))).toEqual([
      { op: 'item.put', item: item('d') },
      { op: 'item.put', item: item('b'), before: 'c' },
    ]);
  });

  it('moves one item with one operation when it left the end', () => {
    const previous = view([item('a'), item('b'), item('c'), item('live', 'draft')]);
    const next = view([item('a'), item('live', 'draft'), item('b'), item('c')]);
    expect(diffSessionView(previous, next)).toEqual([{ op: 'item.put', item: item('live', 'draft'), before: 'b' }]);
    expect(follow(previous, previous, next).items.map(entry => entry.id)).toEqual(['a', 'live', 'b', 'c']);
  });

  it('reaches any new order', () => {
    const previous = view([item('a'), item('b'), item('c'), item('d')]);
    for (const order of [['d', 'c', 'b', 'a'], ['b', 'c', 'd', 'a'], ['d', 'b', 'a', 'c'], ['c', 'a', 'd', 'b']]) {
      const next = view(order.map(id => item(id)));
      expect(follow(previous, previous, next).items.map(entry => entry.id)).toEqual(order);
    }
  });

  it('removes the items that left the window', () => {
    const previous = view([item('a'), item('b'), item('c')]);
    expect(diffSessionView(previous, view([item('c'), item('d')]))).toEqual([
      { op: 'item.remove', id: 'a' },
      { op: 'item.remove', id: 'b' },
      { op: 'item.put', item: item('d') },
    ]);
  });

  it('sets a changed key, removes a missing one and leaves equal ones alone', () => {
    const previous = view([], { runs: [{ runId: 'r1', phase: 'running' }], queue: [], activity: { runId: 'r1' }, cleared: 1 });
    const next = view([], { runs: [{ runId: 'r1', phase: 'completed' }], queue: [], activity: undefined, cleared: null, added: 0 });
    expect(diffSessionView(previous, next)).toEqual([
      { op: 'set', key: 'runs', value: [{ runId: 'r1', phase: 'completed' }] },
      { op: 'set', key: 'activity' },
      { op: 'set', key: 'cleared', value: null },
      { op: 'set', key: 'added', value: 0 },
    ]);
  });

  it('treats an undefined field as an absent one', () => {
    const previous = view([item('a', 'x', { tool: { status: 'success', progress: undefined } })], { activity: undefined });
    expect(diffSessionView(previous, view([item('a', 'x', { tool: { status: 'success' } })]))).toEqual([]);
  });

  it('sends nothing for two empty views', () => {
    expect(diffSessionView(view([]), view([]))).toEqual([]);
  });
});

describe('applyViewOps', () => {
  const start = view([item('a', 'one'), item('b', 'two', { textTotal: 50 })], { runs: [] });

  it('leaves the view it was given untouched', () => {
    const before = wire(start);
    const result = applyViewOps(start, [
      { op: 'item.append', id: 'a', field: 'text', text: '!' },
      { op: 'item.remove', id: 'b' },
      { op: 'set', key: 'runs', value: [1] },
    ]);
    expect(result.view).toEqual(view([item('a', 'one!')], { runs: [1] }));
    expect(start).toEqual(before);
  });

  it('grows the total of a cut item with its text', () => {
    const result = applyViewOps(start, [{ op: 'item.append', id: 'b', field: 'text', text: '++' }]);
    expect(result.view?.items[1]).toEqual(item('b', 'two++', { textTotal: 52 }));
  });

  it('replaces an item in place when it is put before its own neighbour', () => {
    const result = applyViewOps(start, [{ op: 'item.put', item: item('a', 'new'), before: 'b' }]);
    expect(result.view?.items).toEqual([item('a', 'new'), start.items[1]]);
  });

  it('keeps a key it has no use for', () => {
    const result = applyViewOps(start, [{ op: 'set', key: 'fromALaterRevision', value: { any: 'thing' } }]);
    expect(result.view).toEqual({ ...start, fromALaterRevision: { any: 'thing' } });
    const later = applyViewOps(result.view!, [{ op: 'set', key: 'runs', value: [2] }]);
    expect(later.view?.fromALaterRevision).toEqual({ any: 'thing' });
  });

  it('removes a key set without a value', () => {
    expect(applyViewOps(start, [{ op: 'set', key: 'runs' }]).view).toEqual(view(start.items));
  });

  it.each<[string, unknown]>([
    ['an operation from a later revision', { op: 'item.move', id: 'a', before: 'b' }],
    ['an append to a field other than text', { op: 'item.append', id: 'a', field: 'inputText', text: 'x' }],
    ['a set of the item list', { op: 'set', key: 'items', value: [] }],
  ])('asks for a new snapshot on %s', (_name, op) => {
    expect(applyViewOps(start, [{ op: 'item.remove', id: 'a' }, op as ViewOp<Item>])).toEqual({ resync: 'unknown_op' });
  });

  it.each<[string, ViewOp<Item>]>([
    ['a removal', { op: 'item.remove', id: 'gone' }],
    ['an append', { op: 'item.append', id: 'gone', field: 'text', text: 'x' }],
    ['a placement before', { op: 'item.put', item: item('c'), before: 'gone' }],
  ])('asks for a new snapshot on %s of an item it does not hold', (_name, op) => {
    expect(applyViewOps(start, [op])).toEqual({ resync: 'missing_item' });
  });
});

describe('viewPatchStep', () => {
  const current = { epoch: 'e1', seq: 4 };

  it('applies the patch numbered right after the copy', () => {
    expect(viewPatchStep(current, { epoch: 'e1', seq: 5 })).toBe('apply');
  });

  it.each([
    ['a gap', { epoch: 'e1', seq: 6 }],
    ['a repeat', { epoch: 'e1', seq: 4 }],
    ['another epoch', { epoch: 'e2', seq: 5 }],
  ])('asks for a new snapshot on %s', (_name, patch) => {
    expect(viewPatchStep(current, patch)).toBe('resync');
  });
});
