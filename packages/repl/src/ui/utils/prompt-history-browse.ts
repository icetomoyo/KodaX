import type { ClientHistoryPage } from '@kodax-ai/coding/client-contract';
import { readClientItemRange } from '@kodax-ai/coding';
import { clientViewToHistoryItems, type InkClientPlane } from '../client-plane.js';
import type { HistoryItem } from '../types.js';
import type { TranscriptRow } from './transcript-layout.js';

export interface PromptBrowseAnchor {
  readonly source: string;
  readonly character: number;
  readonly screenRow: number;
}

export interface PromptBrowseWindow {
  readonly pages: readonly ClientHistoryPage[];
  readonly pageCursors: readonly (string | undefined)[];
  readonly newerCursors: readonly (string | undefined)[];
  readonly items: HistoryItem[];
  readonly revision: string;
  readonly nextCursor?: string;
}

function sourceKeys(item: HistoryItem): string[] {
  if (item.type === 'tool_group') return item.tools.map(tool => `tool:${tool.id}`);
  if (item.inputId) return [`input:${item.inputId}`];
  if (item.outputId) return [`${item.type}:${item.outputId}`];
  return item.historyItemId ? [`history:${item.historyItemId}`] : [];
}

function anchorItem(items: readonly HistoryItem[], source: string): HistoryItem | undefined {
  const matches = items.filter(item => sourceKeys(item).includes(source));
  return matches.length === 1 ? matches[0] : undefined;
}

function hasItem(row: TranscriptRow, id: string): boolean {
  return row.itemId === id || row.itemIds?.includes(id) === true;
}

/** Record source identity and position in its rendered content, independent of wrapping. */
export function capturePromptBrowseAnchor(
  items: readonly HistoryItem[], rows: readonly TranscriptRow[], top: number, edge: 'top' | 'bottom' = 'top',
): PromptBrowseAnchor | undefined {
  for (let step = 0; step < rows.length - top; step++) {
    const index = edge === 'top' ? top + step : rows.length - 1 - step;
    const row = rows[index]!;
    if (edge === 'bottom' && !row.text.trim()) continue;
    const item = (edge === 'bottom' ? [...items].reverse() : items).find(candidate => hasItem(row, candidate.id));
    const source = item && sourceKeys(item).find(key => anchorItem(items, key));
    if (!item || !source) continue;
    const character = row.contentOffset ?? -1;
    const anchorRow = character < 0 ? rows.findIndex(candidate => hasItem(candidate, item.id)) : index;
    return { source, character, screenRow: anchorRow - top };
  }
  return undefined;
}

export function resolvePromptBrowseAnchor(
  items: readonly HistoryItem[], rows: readonly TranscriptRow[], anchor: PromptBrowseAnchor,
): number | undefined {
  const item = anchorItem(items, anchor.source);
  if (!item) return undefined;
  if (!coversAnchor(item, anchor)) return undefined;
  let candidate: number | undefined;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (!hasItem(row, item.id)) continue;
    if (anchor.character < 0) return Math.max(0, index - anchor.screenRow);
    if (row.contentOffset === undefined) continue;
    if (row.contentOffset > anchor.character) break;
    candidate = index;
  }
  return candidate === undefined ? undefined : Math.max(0, candidate - anchor.screenRow);
}

function coversAnchor(item: HistoryItem, anchor: PromptBrowseAnchor): boolean {
  return anchor.character < 0 || item.type === 'tool_group'
    || (anchor.character >= (item.textOffset ?? 0) && anchor.character < (item.textOffset ?? 0) + item.text.length);
}

function mapPages(pages: readonly ClientHistoryPage[]): HistoryItem[] {
  return pages.flatMap(page => clientViewToHistoryItems(page.items)
    .map(item => ({ ...item, historyItemId: item.id })));
}

function withinBudget(pages: readonly ClientHistoryPage[]): boolean {
  const items = pages.flatMap(page => page.items);
  return pages.length <= 4 && items.length <= 800
    && items.reduce((size, item) => size + item.text.length + (item.tool?.inputText?.length ?? 0), 0) <= 2_000_000;
}

/** A bounded saved window; never combine a saved revision with an observed suffix. */
export async function readPromptBrowseWindow(
  plane: Pick<InkClientPlane, 'readHistory' | 'readHistoryEntry'>, sessionId: string, anchor: PromptBrowseAnchor,
  previous?: PromptBrowseWindow, signal?: AbortSignal,
  direction: 'older' | 'newer' = 'older',
): Promise<PromptBrowseWindow> {
  if (!plane.readHistory) throw new Error('Saved history is unavailable.');
  if (direction === 'newer' && previous) return readNewerWindow(plane, sessionId, anchor, previous, signal);
  let pages = [...(previous?.pages ?? [])];
  const pageCursors = [...(previous?.pageCursors ?? [])];
  const newerCursors = [...(previous?.newerCursors ?? [])];
  let cursor = previous?.nextCursor;
  let revision = previous?.revision;
  const cursors = new Set<string>();
  for (let count = 0; count < 4; count++) {
    signal?.throwIfAborted();
    const page = await plane.readHistory(sessionId, { cursor, limit: 40 });
    signal?.throwIfAborted();
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error('Saved history changed. Press End, then scroll up to refresh.');
    if (cursor !== undefined && page.nextCursor === cursor) throw new Error('Saved history paging did not advance.');
    pages.unshift(page);
    pageCursors.unshift(cursor);
    while (!withinBudget(pages) && pages.length > 1) {
      const retained = pages.slice(0, -1);
      if (previous && !anchorItem(mapPages(retained), anchor.source)) break;
      if (newerCursors.length >= 128) throw new Error('History navigation limit reached. Press End to return to latest.');
      newerCursors.push(pageCursors.pop());
      pages = retained;
    }
    if (!withinBudget(pages)) throw new Error('Saved history exceeds the browse window budget.');
    const visible = anchorItem(mapPages(pages), anchor.source);
    if (visible) {
      pages = await hydrateAnchor(plane, sessionId, pages, visible, signal);
      if (!coversAnchor(anchorItem(mapPages(pages), anchor.source)!, anchor)) {
        throw new Error('Saved preview does not contain this reading position. Press End to return to latest.');
      }
      return { pages, pageCursors, newerCursors, items: mapPages(pages), revision, nextCursor: page.nextCursor };
    }
    cursor = page.nextCursor;
    if (cursor === undefined || cursors.has(cursor)) break;
    cursors.add(cursor);
  }
  throw new Error('The visible position is unavailable in saved history. Press End to return to live output.');
}

async function readNewerWindow(
  plane: Pick<InkClientPlane, 'readHistory' | 'readHistoryEntry'>, sessionId: string,
  anchor: PromptBrowseAnchor, previous: PromptBrowseWindow, signal?: AbortSignal,
): Promise<PromptBrowseWindow> {
  if (!previous.newerCursors.length || !plane.readHistory) return previous;
  const newerCursors = [...previous.newerCursors];
  const cursor = newerCursors.pop();
  signal?.throwIfAborted();
  const page = await plane.readHistory(sessionId, { cursor, limit: 40 });
  signal?.throwIfAborted();
  if (page.revision !== previous.revision) throw new Error('Saved history changed. Press End, then scroll up to refresh.');
  let pages = [...previous.pages, page];
  const pageCursors = [...previous.pageCursors, cursor];
  while (!withinBudget(pages) && pages.length > 1) {
    const retained = pages.slice(1);
    if (!anchorItem(mapPages(retained), anchor.source)) break;
    pages = retained;
    pageCursors.shift();
  }
  const visible = anchorItem(mapPages(pages), anchor.source);
  if (!withinBudget(pages) || !visible) throw new Error('Cannot load newer history while preserving the visible position.');
  pages = await hydrateAnchor(plane, sessionId, pages, visible, signal);
  if (!coversAnchor(anchorItem(mapPages(pages), anchor.source)!, anchor)) {
    throw new Error('Saved preview does not contain this reading position. Press End to return to latest.');
  }
  return { pages, pageCursors, newerCursors, items: mapPages(pages), revision: previous.revision,
    nextCursor: pages[0]?.nextCursor };
}

async function hydrateAnchor(
  plane: Pick<InkClientPlane, 'readHistoryEntry'>, sessionId: string,
  pages: ClientHistoryPage[], item: HistoryItem, signal?: AbortSignal,
): Promise<ClientHistoryPage[]> {
  if (item.type === 'tool_group' || !item.totalTextLength) return pages;
  // Keep the Host preview for very large bodies. Full transcript/copy remains
  // available through its existing explicit reader; earlier pages stay reachable.
  if (item.totalTextLength > 1_000_000) return pages;
  const read = plane.readHistoryEntry;
  if (!read) throw new Error('Saved text is unavailable.');
  const text = await readClientItemRange(offset => read(sessionId, item.id, { offset }), item.id,
    { length: item.totalTextLength, signal });
  signal?.throwIfAborted();
  const hydrated = pages.map(page => ({ ...page, items: page.items.map(source => source.id === item.id
    ? { ...source, text, textOffset: 0, totalTextLength: undefined } : source) }));
  return withinBudget(hydrated) ? hydrated : pages;
}
