/**
 * v1 reads an item at any offset; v2 reads it page by page with the cursor the
 * page before gave. The reader keeps the cursors it was given, so the REPL can
 * go on from where it stopped, and walks from the start for an offset it has no
 * cursor for.
 */
import type { ClientItemContent, ClientItemReadOptions, ClientViewItem } from '@kodax-ai/coding/client-contract';

import type { HostCallResult, KodaXHostClient } from '../host-protocol/host-client.js';

type ItemPart = 'text' | 'input' | 'output';
type ItemPage = HostCallResult<'item.read', 'local'>;
type TextVersion = Pick<ClientViewItem, 'textRevision' | 'outputState'>;

/** Enough cursors for the items a REPL pages through at once; the oldest go first. */
const KEPT_ITEMS = 64;

function v2Part(part: ClientItemReadOptions['part']): ItemPart {
  if (part === undefined || part === 'text') return 'text';
  if (part === 'input') return 'input';
  if (part === 'original') return 'output';
  throw new Error('A v2 Host sends attachments with the item, not as a part to read.');
}

export interface ItemReader {
  /** `version` is what the REPL last saw the item's text at, for a read that must not mix two versions. */
  read(sessionId: string, itemId: string, options: ClientItemReadOptions, version?: TextVersion): Promise<ClientItemContent>;
}

export function createItemReader(client: KodaXHostClient<'local'>): ItemReader {
  /** Per item and part, the cursor that reads from each offset. */
  const cursors = new Map<string, Map<number, string>>();
  const remember = (key: string, offset: number, cursor: string): void => {
    const known = cursors.get(key) ?? new Map<number, string>();
    cursors.delete(key);
    cursors.set(key, known.set(offset, cursor));
    if (cursors.size > KEPT_ITEMS) cursors.delete(cursors.keys().next().value!);
  };
  const page = async (sessionId: string, itemId: string, part: ItemPart, key: string, from: number, cursor?: string) => {
    const read: ItemPage = await client.call('item.read', { sessionId, itemId, part, ...(cursor !== undefined ? { cursor } : {}) });
    const end = from + read.text.length;
    if (read.nextCursor !== undefined) remember(key, end, read.nextCursor);
    return { ...read, from, end };
  };
  return {
    async read(sessionId, itemId, options, version) {
      const part = v2Part(options.part);
      const offset = options.offset ?? 0;
      const key = `${sessionId}\0${itemId}\0${part}`;
      let found = offset === 0 ? await page(sessionId, itemId, part, key, 0) : undefined;
      const cursor = found === undefined ? cursors.get(key)?.get(offset) : undefined;
      if (cursor !== undefined) found = await page(sessionId, itemId, part, key, offset, cursor);
      found ??= await page(sessionId, itemId, part, key, 0);
      // An offset inside a page: walk on until the page that holds it.
      while (found.end <= offset && found.nextCursor !== undefined) {
        found = await page(sessionId, itemId, part, key, found.end, found.nextCursor);
      }
      if (offset > found.from + found.text.length) throw new Error(`Item ${itemId} is shorter than offset ${offset}.`);
      const text = found.text.slice(offset - found.from);
      return {
        id: itemId,
        text,
        offset,
        totalLength: found.total,
        ...(found.nextCursor !== undefined ? { nextOffset: found.end } : {}),
        ...(part === 'text' && version !== undefined ? version : {}),
      };
    },
  };
}
