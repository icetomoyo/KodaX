import { expect, it } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/agent';
import { resolveSavedHistoryTurn, resolveHistoryTurnAtSnapshot } from './history-turn.js';
import { readHistoryPageWithBoundaryRetry } from './client-history.js';

function history(messages: KodaXMessage[]) {
  return { sourceRevision: 'source', status: 'resolved' as const, issues: [],
    entries: messages.map((message, index) => ({ message, boundaryId: `entry-${index}`, auditEntryIds: [`entry-${index}`] })) };
}

it('honors cancellation during a large single-turn tool-pair scan', async () => {
  const source = history([
    { role: 'user', content: 'many tools' },
    { role: 'assistant', content: Array.from({ length: 800 }, (_, index) => ({
      type: 'tool_use' as const, id: `call-${index}`, name: 'read', input: {},
    })) },
    { role: 'user', content: Array.from({ length: 800 }, (_, index) => ({
      type: 'tool_result' as const, tool_use_id: `call-${index}`, content: 'result',
    })) },
  ]);
  let checks = 0;
  await expect(resolveSavedHistoryTurn(source, 'head', { kind: 'latest' }, undefined, () => {
    if (++checks === 3) throw Object.assign(new Error('cancel during pairing'), { code: 'read_cancelled' });
  })).rejects.toMatchObject({ code: 'read_cancelled' });
});

it('counts real user inputs while preserving tool results and synthetic messages inside the complete turn', async () => {
  const source = history([
    { role: 'user', content: 'same prompt' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] },
    { role: 'user', content: 'child result', _synthetic: true },
    { role: 'user', content: 'same prompt' }, { role: 'assistant', content: 'answer' },
  ]);
  expect(await resolveSavedHistoryTurn(source, 'head', { kind: 'previous' })).toEqual({
    status: 'ready', sessionId: '', historyBoundary: { kind: 'turn_end', entryId: 'entry-3', sourceRevision: 'source' },
    startBoundary: { entryId: 'entry-0', sourceRevision: 'source' },
    expectedHead: 'head', turnIndex: 0, excerpt: 'same prompt', hasLaterTurn: true,
  });
  expect(await resolveSavedHistoryTurn(source, 'head', { kind: 'latest' }, 2))
    .toMatchObject({ status: 'ready', turnIndex: 0 });
});

it('distinguishes missing turns and refuses unproven canonical histories', async () => {
  expect(await resolveSavedHistoryTurn(history([]), null, { kind: 'latest' }))
    .toEqual({ status: 'unavailable', reason: 'no_turns' });
  const one = history([{ role: 'user', content: 'prompt' }]);
  expect(await resolveSavedHistoryTurn(one, 'head', { kind: 'previous' }))
    .toEqual({ status: 'unavailable', reason: 'no_previous_turn' });
  expect(await resolveSavedHistoryTurn({ ...one, status: 'partial' }, 'head', { kind: 'latest' }))
    .toEqual({ status: 'unavailable', reason: 'unresolved_history' });
});

it('keeps a bounded excerpt without cutting a UTF-16 surrogate pair', async () => {
  const source = history([{ role: 'user', content: 'x'.repeat(239) + '\u{1F600} trailing' }]);
  expect(await resolveSavedHistoryTurn(source, null, { kind: 'latest' }))
    .toMatchObject({ status: 'ready', excerpt: 'x'.repeat(239) });
  const exact = history([{ role: 'user', content: 'x'.repeat(238) + '\u{1F600} trailing' }]);
  expect(await resolveSavedHistoryTurn(exact, null, { kind: 'latest' }))
    .toMatchObject({ status: 'ready', excerpt: 'x'.repeat(238) + '\u{1F600}' });
});

it('selects a full-history index outside the current display window', async () => {
  const source = history(Array.from({ length: 140 }, (_, index): KodaXMessage[] => [
    { role: 'user', content: `query-${index}` }, { role: 'assistant', content: `answer-${index}` },
  ]).flat());
  expect(await resolveSavedHistoryTurn(source, 'head', { kind: 'index', index: 0 }))
    .toMatchObject({ status: 'ready', turnIndex: 0, historyBoundary: { entryId: 'entry-1' }, hasLaterTurn: true });
});

it('does not retry an obsolete saved-position read as though it were a fresh newest read', async () => {
  let reads = 0;
  await expect(readHistoryPageWithBoundaryRetry(async () => {
    reads += 1;
    throw Object.assign(new Error('Saved reading position changed.'), { code: 'resync_required' });
  }, { around: { searchItemId: 'opaque-hit' } })).rejects.toMatchObject({ code: 'resync_required' });
  expect(reads).toBe(1);
});

it('uses a new saved input only when the exact observed item identity is supplied, rejecting duplicates and drafts', async () => {
  const source = history([{ role: 'user', inputId: 'accepted', content: 'prompt' }, { role: 'assistant', outputId: 'saved', content: 'answer' }]);
  const base = { sessionId: 'session', history: source, conversationRevision: 'revision', expectedHead: 'head',
    transcriptSource: () => undefined, checkpoint: () => undefined };
  const selector = { kind: 'item' as const, source: 'view' as const, itemId: 'observed', inputId: 'accepted' };
  const viewItem = { id: 'observed', type: 'user' as const, text: 'preview', inputId: 'accepted' };
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector, viewItem })).toMatchObject({ status: 'ready', turnIndex: 0 });
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector: { ...selector, inputId: undefined, revision: 'old-source' },
    viewItem: { ...viewItem, historyBoundary: { entryId: 'entry-0', sourceRevision: 'old-source' } } }))
    .toMatchObject({ status: 'ready', historyBoundary: { sourceRevision: 'source' } });
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector: { ...selector, inputId: 'foreign' }, viewItem })).toMatchObject({ status: 'unavailable' });
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector, viewItem: { ...viewItem, id: 'foreign' } })).toMatchObject({ status: 'unavailable' });
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector, viewItem, history: { ...source, entries: [...source.entries, source.entries[0]!] } })).toMatchObject({ status: 'unavailable' });
  expect(await resolveHistoryTurnAtSnapshot({ ...base, selector: { ...selector, inputId: undefined, outputId: 'saved' },
    viewItem: { id: 'observed', type: 'assistant', text: 'draft', outputId: 'saved', outputState: 'draft' } }))
    .toMatchObject({ status: 'unavailable' });
});
