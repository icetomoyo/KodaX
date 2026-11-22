/**
 * Keeps a client's copy of a view equal to the Host's. The Host turns two
 * successive views into operations, the client applies them to its copy. Both
 * ends run this file, so it imports nothing.
 *
 * A view is an ordered list of items plus top-level keys. There are four
 * operations and there will be no more: new data arrives as new keys and new
 * item types, which these four already carry.
 */

/** What syncing needs from an item. Every other field is carried as it is. */
export interface SyncItem {
  readonly id: string;
  readonly text: string;
  /** Units in the whole text, present when `text` is only its end. */
  readonly textTotal?: number | undefined;
}

export type SyncView<Item extends SyncItem = SyncItem> =
  { readonly items: readonly Item[] } & { readonly [key: string]: unknown };

export type ViewOp<Item extends SyncItem = SyncItem> =
  /** Places the item right before `before`, or last without it. An item with the same id is taken out first. */
  | { readonly op: 'item.put'; readonly item: Item; readonly before?: string | undefined }
  | { readonly op: 'item.remove'; readonly id: string }
  /** Adds to the end of the item's text. A `textTotal` the item carries grows by the same length. */
  | { readonly op: 'item.append'; readonly id: string; readonly field: 'text'; readonly text: string }
  /** Replaces a top-level key. Without `value` the key is removed. */
  | { readonly op: 'set'; readonly key: string; readonly value?: unknown };

/**
 * Why a copy can no longer follow the Host. `unknown_op` is an operation this
 * code does not know; `missing_item` is an operation naming an item the copy
 * does not hold. Either way the client subscribes again.
 */
export type ViewResyncReason = 'unknown_op' | 'missing_item';

export type ViewApplyResult<View> =
  | { readonly view: View; readonly resync?: undefined }
  | { readonly resync: ViewResyncReason; readonly view?: undefined };

export interface ViewPosition {
  /** Changes when the Host rebuilt its item ids, so nothing kept under the old one is valid. */
  readonly epoch: string;
  /** Counts the patches of one subscription, with no gaps. */
  readonly seq: number;
}

/**
 * Whether a patch is the next one for a copy at `current`. A gap, a repeat or
 * another epoch all mean the copy missed something: subscribe again.
 */
export function viewPatchStep(current: ViewPosition, patch: ViewPosition): 'apply' | 'resync' {
  return patch.epoch === current.epoch && patch.seq === current.seq + 1 ? 'apply' : 'resync';
}

/** Equal as JSON: an absent field and an undefined one are the same, as they are on the wire. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Readonly<Record<string, unknown>>;
  const b = right as Readonly<Record<string, unknown>>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameJson(a[key], b[key])) return false;
  }
  return true;
}

/** The text an item gained when nothing else about it changed. Undefined for any other change. */
function appendedText(previous: SyncItem, next: SyncItem): string | undefined {
  if (next.text.length <= previous.text.length || !next.text.startsWith(previous.text)) return undefined;
  const added = next.text.slice(previous.text.length);
  // A cut item whose window moved did not simply grow, even if its new text happens to extend the old.
  const grownTotal = previous.textTotal === undefined ? undefined : previous.textTotal + added.length;
  if (next.textTotal !== grownTotal) return undefined;
  return sameJson({ ...previous, text: '', textTotal: 0 }, { ...next, text: '', textTotal: 0 }) ? added : undefined;
}

function put<Item extends SyncItem>(item: Item, before: string | undefined): ViewOp<Item> {
  return before === undefined ? { op: 'item.put', item } : { op: 'item.put', item, before };
}

function diffItems<Item extends SyncItem>(previous: readonly Item[], next: readonly Item[]): ViewOp<Item>[] {
  const kept = new Set(next.map(item => item.id));
  const known = new Map(previous.map((item, index) => [item.id, { item, index }]));
  const ops: ViewOp<Item>[] = [];
  for (const item of previous) if (!kept.has(item.id)) ops.push({ op: 'item.remove', id: item.id });
  // From the end, so the neighbour an item is placed before is already where it belongs.
  let after: string | undefined;
  // An item stays where it is while it still precedes every item already left in place.
  // That is not always the fewest moves, but items rarely change order at all.
  let leftmostKept = Infinity;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index]!;
    const old = known.get(item.id);
    if (old === undefined || old.index > leftmostKept) {
      ops.push(put(item, after));
    } else {
      leftmostKept = old.index;
      const added = appendedText(old.item, item);
      if (added !== undefined) ops.push({ op: 'item.append', id: item.id, field: 'text', text: added });
      else if (!sameJson(old.item, item)) ops.push(put(item, after));
    }
    after = item.id;
  }
  return ops;
}

function diffKeys(previous: SyncView, next: SyncView): ViewOp<never>[] {
  const ops: ViewOp<never>[] = [];
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (key === 'items' || sameJson(previous[key], next[key])) continue;
    ops.push(next[key] === undefined ? { op: 'set', key } : { op: 'set', key, value: next[key] });
  }
  return ops;
}

/**
 * The operations that turn a copy of `previous` into `next`. Appending is used
 * only when an item's text grew and nothing else about it changed; replaced or
 * shortened text, as after a provider retry, sends the whole item.
 */
export function diffSessionView<Item extends SyncItem>(previous: SyncView<Item>, next: SyncView<Item>): ViewOp<Item>[] {
  return [...diffItems(previous.items, next.items), ...diffKeys(previous, next)];
}

function putItem<Item extends SyncItem>(items: Item[], item: Item, before: string | undefined): ViewResyncReason | undefined {
  const current = items.findIndex(candidate => candidate.id === item.id);
  if (current >= 0) items.splice(current, 1);
  const index = before === undefined ? items.length : items.findIndex(candidate => candidate.id === before);
  if (index < 0) return 'missing_item';
  items.splice(index, 0, item);
  return undefined;
}

function removeItem(items: SyncItem[], id: string): ViewResyncReason | undefined {
  const index = items.findIndex(candidate => candidate.id === id);
  if (index < 0) return 'missing_item';
  items.splice(index, 1);
  return undefined;
}

function appendText<Item extends SyncItem>(items: Item[], id: string, text: string): ViewResyncReason | undefined {
  const index = items.findIndex(candidate => candidate.id === id);
  const item = items[index];
  if (item === undefined) return 'missing_item';
  items[index] = {
    ...item,
    text: item.text + text,
    ...(item.textTotal !== undefined ? { textTotal: item.textTotal + text.length } : {}),
  };
  return undefined;
}

function applyOp<Item extends SyncItem>(items: Item[], keys: Map<string, unknown>, op: ViewOp<Item>): ViewResyncReason | undefined {
  switch (op.op) {
    case 'item.put': return putItem(items, op.item, op.before);
    case 'item.remove': return removeItem(items, op.id);
    case 'item.append': return op.field === 'text' ? appendText(items, op.id, op.text) : 'unknown_op';
    case 'set':
      // The item list changes only through the item operations.
      if (op.key === 'items') return 'unknown_op';
      if (op.value === undefined) keys.delete(op.key);
      else keys.set(op.key, op.value);
      return undefined;
    default: return 'unknown_op';
  }
}

/**
 * The view after the operations, or the reason the copy must be fetched again.
 * `view` is left untouched, and no operation is half applied. A key this client
 * has no use for is kept all the same, so it is there once the client learns it.
 */
export function applyViewOps<View extends SyncView>(
  view: View,
  ops: readonly ViewOp<View['items'][number]>[],
): ViewApplyResult<View> {
  const items = [...view.items];
  const keys = new Map(Object.entries(view));
  for (const op of ops) {
    const resync = applyOp(items, keys, op);
    if (resync !== undefined) return { resync };
  }
  keys.set('items', items);
  // The operations carry the same items and keys the view is made of.
  return { view: Object.fromEntries(keys) as View };
}
