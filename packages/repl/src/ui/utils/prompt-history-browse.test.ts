import { describe, expect, it, vi } from 'vitest';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { clientViewToHistoryItems } from '../client-plane.js';
import { buildHistoryItemTranscriptSections, flattenTranscriptSections } from './transcript-layout.js';
import { capturePromptBrowseAnchor, readPromptBrowseWindow, resolvePromptBrowseAnchor } from './prompt-history-browse.js';

const tool = (index: number, repeated = false): ClientViewItem => ({
  id: `live-${index}`, type: 'tool', text: 'OK',
  tool: { callId: `call-${index}`, name: 'read', status: 'success', inputText: JSON.stringify({ path: repeated ? 'same.txt' : `file-${index}.txt` }) },
});
const renderRows = (items: ReturnType<typeof clientViewToHistoryItems>) =>
  flattenTranscriptSections(buildHistoryItemTranscriptSections(items, 100, 12, false));

describe('ordinary saved history browsing', () => {
  it.each([false, true])('recovers the original input and first tool after bounded observe rolls over (folded=%s)', async folded => {
    const source: ClientViewItem[] = [{ id: 'query', inputId: 'input-1', type: 'user', text: 'Original query' },
      ...Array.from({ length: folded ? 250 : 160 }, (_, index) => tool(index, folded && index >= 100))];
    const live = clientViewToHistoryItems(source.slice(-150));
    const rows = renderRows(live);
    // The real prompt renderer folds the final 150 identical reads into a short document.
    if (folded) expect(rows.length).toBeLessThan(30);
    const anchor = capturePromptBrowseAnchor(live, rows, 0);
    expect(anchor).toBeDefined();
    const readHistory = vi.fn(async (_session: string, options?: { cursor?: string }) => {
      const end = options?.cursor ? Number(options.cursor) : source.length;
      const start = Math.max(0, end - 40);
      return { revision: 'r1', oversized: [], items: source.slice(start, end).map(item => ({ ...item, id: `saved-${item.id}` })),
        ...(start ? { nextCursor: String(start) } : {}) };
    });
    let window = await readPromptBrowseWindow({ readHistory }, 's', anchor!);
    while (window.nextCursor) {
      const nextAnchor = capturePromptBrowseAnchor(window.items, renderRows(window.items), 0)!;
      window = await readPromptBrowseWindow({ readHistory }, 's', nextAnchor, window);
    }
    expect(window.items.some(item => item.type === 'user' && item.text === 'Original query')).toBe(true);
    expect(window.items.some(item => item.type === 'tool_group' && item.tools.some(call => call.id === 'call-0'))).toBe(true);
    expect(window.pages.length).toBeLessThanOrEqual(4);
  });

  it('hydrates the visible oversized text through the validated reader before replacing the display', async () => {
    const full = 'prefix '.repeat(2000) + 'visible ending';
    const item: ClientViewItem = { id: 'saved-a', outputId: 'o', type: 'assistant', text: 'visible ending',
      textOffset: full.length - 14, totalTextLength: full.length };
    const readHistoryEntry = vi.fn(async () => ({ id: item.id, text: full, offset: 0, totalLength: full.length }));
    const window = await readPromptBrowseWindow({
      readHistory: async () => ({ revision: 'r', oversized: [], items: [item] }), readHistoryEntry,
    }, 's', { source: 'assistant:o', character: 0, screenRow: 0 });
    expect(window.items[0]).toMatchObject({ text: full, textOffset: 0 });
    expect(readHistoryEntry).toHaveBeenCalledTimes(1);
  });

  it('rejects changed revisions and ambiguous sources without returning a mixed window', async () => {
    const anchor = { source: 'tool:call-2', character: 0, screenRow: 0 };
    const first = await readPromptBrowseWindow({ readHistory: async () => ({
      revision: 'r1', oversized: [], items: [tool(2)], nextCursor: 'older',
    }) }, 's', anchor);
    await expect(readPromptBrowseWindow({ readHistory: async () => ({
      revision: 'r2', oversized: [], items: [tool(1)],
    }) }, 's', anchor, first)).rejects.toThrow('changed');
    await expect(readPromptBrowseWindow({ readHistory: async () => ({
      revision: 'r1', oversized: [], items: [tool(2), { ...tool(2), id: 'ambiguous' }],
    }) }, 's', anchor)).rejects.toThrow('unavailable');
  });

  it('does not let an oversized entry prevent browsing earlier entries', async () => {
    const readHistoryEntry = vi.fn();
    const readHistory = vi.fn(async (_session: string, options?: { cursor?: string }) => options?.cursor
      ? { revision: 'r', oversized: [], items: [tool(0)] }
      : { revision: 'r', oversized: [{ itemId: 'huge', byteLength: 3_000_000 }], nextCursor: 'older',
        items: [{ id: 'huge', outputId: 'huge-output', type: 'assistant' as const,
          text: 'bounded preview', textOffset: 0, totalTextLength: 3_000_000 }] });
    const source = { source: 'assistant:huge-output', character: -1, screenRow: 0 };
    const initial = await readPromptBrowseWindow({ readHistory, readHistoryEntry }, 's', source);
    const older = await readPromptBrowseWindow({ readHistory, readHistoryEntry }, 's', source, initial);
    expect(older.items[0]).toMatchObject({ type: 'tool_group', tools: [{ id: 'call-0' }] });
    expect(older.items[1]).toMatchObject({ totalTextLength: 3_000_000 });
    expect(readHistoryEntry).not.toHaveBeenCalled();
  });

  it('revisits evicted newer pages in order and can then page older again', async () => {
    const source = Array.from({ length: 320 }, (_, index) => tool(index));
    const readHistory = vi.fn(async (_session: string, options?: { cursor?: string }) => {
      const end = options?.cursor ? Number(options.cursor) : source.length;
      const start = Math.max(0, end - 40);
      return { revision: 'r', oversized: [], items: source.slice(start, end),
        ...(start ? { nextCursor: String(start) } : {}) };
    });
    let window = await readPromptBrowseWindow({ readHistory }, 's',
      { source: 'tool:call-319', character: -1, screenRow: 0 });
    for (let count = 0; count < 6; count++) {
      const anchor = capturePromptBrowseAnchor(window.items, renderRows(window.items), 0)!;
      window = await readPromptBrowseWindow({ readHistory }, 's', anchor, window);
    }
    expect(window.items.at(-1)).toMatchObject({ tools: [{ id: 'call-199' }] });
    for (const lastCall of ['call-239', 'call-279', 'call-319']) {
      const rows = renderRows(window.items);
      const anchor = capturePromptBrowseAnchor(window.items, rows, Math.max(0, rows.length - 30), 'bottom')!;
      const lastItem = window.items.at(-1)!;
      expect(anchor.source).toBe(lastItem.type === 'tool_group' ? `tool:${lastItem.tools[0]!.id}` : 'tool');
      window = await readPromptBrowseWindow({ readHistory }, 's', anchor, window, undefined, 'newer');
      expect(window.items.at(-1)).toMatchObject({ tools: [{ id: lastCall }] });
      expect(new Set(window.items.map(item => item.id)).size).toBe(window.items.length);
      expect(window.pages).toHaveLength(4);
    }
    expect(window.newerCursors).toHaveLength(0);
    const anchor = capturePromptBrowseAnchor(window.items, renderRows(window.items), 0)!;
    window = await readPromptBrowseWindow({ readHistory }, 's', anchor, window);
    expect(window.items[0]).toMatchObject({ tools: [{ id: 'call-120' }] });
    expect(window.newerCursors).toHaveLength(1);
    await expect(readPromptBrowseWindow({ readHistory: async () => ({ revision: 'changed', oversized: [], items: [] }) },
      's', anchor, window, undefined, 'newer')).rejects.toThrow('changed');
    expect(window.items[0]).toMatchObject({ tools: [{ id: 'call-120' }] });
  });

  it('records UTF-16 positions across long lines, newlines, emoji and wrapping', () => {
    const text = '🦊中文 '.repeat(30_000) + '\n\nSecond line\n';
    const items = clientViewToHistoryItems([{ id: 'long', outputId: 'o', type: 'assistant', text }]);
    const before = performance.now();
    const rows = renderRows(items);
    expect(performance.now() - before).toBeLessThan(3000);
    const bodyRows = rows.filter(row => row.contentOffset !== undefined);
    expect(bodyRows.length).toBeGreaterThan(1000);
    for (const row of bodyRows) {
      expect(text.slice(row.contentOffset, row.contentOffset! + row.text.length)).toBe(row.text);
    }
  });

  it('preserves a user-message source position across resize without assigning offsets to truncation hints', () => {
    const text = Array.from({ length: 1000 }, (_, index) => `word${index}`).join(' ');
    const items = clientViewToHistoryItems([{ id: 'user', inputId: 'input', type: 'user', text }]);
    const rows = renderRows(items);
    const anchor = capturePromptBrowseAnchor(items, rows, 6)!;
    expect(anchor.character).toBeGreaterThan(0);
    const narrow = flattenTranscriptSections(buildHistoryItemTranscriptSections(items, 60, 12, false));
    const top = resolvePromptBrowseAnchor(items, narrow, anchor)!;
    expect(narrow[top]!.contentOffset).toBeLessThanOrEqual(anchor.character);
    expect(narrow[top]!.contentOffset! + narrow[top]!.text.length).toBeGreaterThan(anchor.character);
    const truncated = clientViewToHistoryItems([{ id: 'huge-user', inputId: 'other', type: 'user', text: text.repeat(3) }]);
    const hint = renderRows(truncated).find(row => row.text.includes(' lines …'));
    expect(hint).toBeDefined();
    expect(hint?.contentOffset).toBeUndefined();
  });

  it('refuses to replace a live tail reading position with an unrelated saved prefix', async () => {
    const item: ClientViewItem = { id: 'saved', outputId: 'huge', type: 'assistant',
      text: 'a'.repeat(8192), textOffset: 0, totalTextLength: 1_100_000 };
    const anchor = { source: 'assistant:huge', character: 1_091_190, screenRow: 0 };
    const mapped = clientViewToHistoryItems([item]);
    expect(resolvePromptBrowseAnchor(mapped, renderRows(mapped), anchor)).toBeUndefined();
    await expect(readPromptBrowseWindow({ readHistory: async () => ({
      revision: 'r', oversized: [], items: [item],
    }) }, 's', anchor)).rejects.toThrow('does not contain this reading position');
  });

  it('keeps the source content position when an older page is prepended and text rewraps', () => {
    const items = clientViewToHistoryItems([{ id: 'a', outputId: 'o', type: 'assistant', text: '0123456789 '.repeat(100) }]);
    const before = renderRows(items);
    const anchor = capturePromptBrowseAnchor(items, before, 4)!;
    const expanded = clientViewToHistoryItems([tool(1), { id: 'new-a', outputId: 'o', type: 'assistant', text: '0123456789 '.repeat(100) }]);
    const after = flattenTranscriptSections(buildHistoryItemTranscriptSections(expanded, 60, 12, false));
    const top = resolvePromptBrowseAnchor(expanded, after, anchor)!;
    expect(top).toBeGreaterThan(4);
    expect(after[top]?.itemId).toBe('new-a');
  });
});
