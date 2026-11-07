import { readTaskResultReports } from '@kodax-ai/agent';
import type { KodaXMessage } from '@kodax-ai/agent';
import type { SessionConversationHistoryData } from '@kodax-ai/repl';
import type { ClientHistoryTurnResolution, ClientHistoryTurnSelector, ClientViewItem } from '@kodax-ai/coding/client-contract';
import { parseHistoryEntryItemId, projectHistoryEntry } from './client-history.js';
import type { RuntimeConversationHistoryPageInput, RuntimeConversationHistorySlice,
  encodeRuntimeTranscriptCursor, decodeRuntimeTranscriptCursor } from './sdk-runtime.js';

function isTurnInput(message: KodaXMessage): boolean {
  return message.role === 'user' && message._synthetic !== true
    && readTaskResultReports(message).length === 0
    && !(Array.isArray(message.content) && message.content.length > 0
      && message.content.every(block => block.type === 'tool_result'));
}

/** The selected prefix includes invisible tool-result messages up to the next real input. */
export function resolveSavedHistoryTurn(
  history: SessionConversationHistoryData,
  expectedHead: string | null,
  selector: Exclude<ClientHistoryTurnSelector, { kind: 'item' }>,
  entryIndex?: number,
  checkpoint: () => void = () => undefined,
): ClientHistoryTurnResolution {
  if (history.status !== 'resolved') return { status: 'unavailable', reason: 'unresolved_history' };
  const starts: number[] = [];
  for (const [index, entry] of history.entries.entries()) {
    checkpoint();
    if (isTurnInput(entry.message)) starts.push(index);
  }
  if (starts.length === 0) return { status: 'unavailable', reason: 'no_turns' };
  if (entryIndex === undefined && selector.kind === 'previous' && starts.length < 2)
    return { status: 'unavailable', reason: 'no_previous_turn' };
  const selected = entryIndex === undefined
    ? selector.kind === 'index' ? selector.index : starts.length - (selector.kind === 'previous' ? 2 : 1)
    : starts.filter(index => index <= entryIndex).length - 1;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected >= starts.length)
    return { status: 'unavailable', reason: 'turn_not_found' };
  const lastIndex = (starts[selected + 1] ?? history.entries.length) - 1;
  const entryId = history.entries[lastIndex]?.boundaryId;
  if (!entryId) return { status: 'unavailable', reason: 'unproven_source' };
  const content = history.entries[starts[selected]!]!.message.content;
  const text = typeof content === 'string' ? content : content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
  return { status: 'ready', historyBoundary: { entryId, sourceRevision: history.sourceRevision },
    expectedHead, turnIndex: selected, excerpt: text.slice(0, 240).replace(/[\uD800-\uDBFF]$/u, ''),
    hasLaterTurn: selected < starts.length - 1 };
}

/** Selection validation belongs to the saved source, independent of the display window. */
export function resolveHistoryTurnAtSnapshot(input: {
  readonly sessionId: string;
  readonly history: SessionConversationHistoryData;
  readonly conversationRevision: string;
  readonly expectedHead: string | null;
  readonly selector: ClientHistoryTurnSelector;
  readonly viewItem?: ClientViewItem;
  readonly transcriptSource: (revision: string, index: number) => { readonly sourceRevision: string; readonly entryId?: string } | undefined;
  readonly checkpoint: () => void;
}): ClientHistoryTurnResolution {
  const { sessionId, history, selector, expectedHead, checkpoint } = input;
  if (selector.kind !== 'item') return resolveSavedHistoryTurn(history, expectedHead, selector, undefined, checkpoint);
  let entryIndex: number;
  if (selector.source === 'view') {
    const item = input.viewItem;
    if (!item || item.id !== selector.itemId || item.outputState === 'draft') return { status: 'unavailable', reason: 'unproven_source' };
    const boundary = item.historyBoundary;
    if (selector.revision !== undefined) {
      if (!boundary) return { status: 'unavailable', reason: 'unproven_source' };
      if (selector.revision !== boundary.sourceRevision) return { status: 'stale', reason: 'revision_mismatch' };
      // Read-time resolution may renew a metadata-only stale source if the
      // original immutable entry is still uniquely proven. Mutations still CAS
      // the new returned sourceRevision and never silently renew their target.
      const matches = history.entries.flatMap((entry, index) => entry.boundaryId === boundary.entryId
        || entry.auditEntryIds.includes(boundary.entryId) ? [index] : []);
      if (matches.length !== 1) return { status: 'stale', reason: 'source_changed' };
      entryIndex = matches[0]!;
    } else {
      const inputId = item.type === 'user' && selector.inputId === item.inputId ? item.inputId : undefined;
      const outputId = selector.outputId === (item.outputId ?? item.tool?.assistantOutputId) ? selector.outputId : undefined;
      if (!inputId && !outputId) return { status: 'unavailable', reason: 'unproven_source' };
      const matches = history.entries.flatMap((entry, index) => (inputId
        ? entry.message.inputId === inputId || entry.message.inputIds?.includes(inputId)
        : entry.message.outputId === outputId) ? [index] : []);
      if (matches.length !== 1) return { status: 'unavailable', reason: 'unproven_source' };
      entryIndex = matches[0]!;
    }
  } else {
    const parsed = parseHistoryEntryItemId(sessionId, selector.itemId, 'history');
    const reference = parsed ?? parseHistoryEntryItemId(sessionId, selector.itemId, 'transcript');
    if (!reference) return { status: 'unavailable', reason: 'item_not_found' };
    if (selector.revision !== reference.revision) return { status: 'stale', reason: 'revision_mismatch' };
    if (parsed) {
      if (parsed.revision !== input.conversationRevision) return { status: 'stale', reason: 'source_changed' };
      entryIndex = parsed.entryIndex;
      const entry = history.entries[entryIndex];
      if (!entry || (parsed.ordinal !== undefined && !projectHistoryEntry(sessionId, parsed.revision, entryIndex, [entry.message])[parsed.ordinal]))
        return { status: 'unavailable', reason: 'item_not_found' };
    } else {
      const snapshot = input.transcriptSource(reference.revision, reference.entryIndex);
      if (!snapshot) return { status: 'stale', reason: 'selection_expired' };
      if (snapshot.sourceRevision !== history.sourceRevision) return { status: 'stale', reason: 'source_changed' };
      const entryId = snapshot.entryId;
      entryIndex = entryId === undefined ? -1 : history.entries.findIndex(entry => entry.auditEntryIds.includes(entryId));
    }
  }
  if (entryIndex < 0 || entryIndex >= history.entries.length) return { status: 'unavailable', reason: 'not_canonical' };
  return resolveSavedHistoryTurn(history, expectedHead, { kind: 'latest' }, entryIndex, checkpoint);
}

interface LocatedHistoryRead {
  readonly readPage: (cursor: string | undefined, limit: number) => Promise<RuntimeConversationHistorySlice | null>;
  readonly readSource: () => Promise<SessionConversationHistoryData>;
  readonly transcriptSource: (revision: string, index: number) => { readonly sourceRevision: string; readonly entryId?: string } | undefined;
  readonly encode: typeof encodeRuntimeTranscriptCursor;
  readonly decode: typeof decodeRuntimeTranscriptCursor;
  readonly yieldControl: () => Promise<void>;
  readonly defaultLimit: number;
  readonly maximumLimit: number;
}

function staleHistory(message: string): never {
  throw Object.assign(new Error(message), { code: 'resync_required' });
}

async function locateConversationEntry(
  sessionId: string, around: NonNullable<RuntimeConversationHistoryPageInput['around']>,
  sourceRevision: string, read: LocatedHistoryRead,
): Promise<{index: number; boundaryId: string} | undefined> {
  let auditId: string | undefined;
  if ('searchItemId' in around) {
    const hit = parseHistoryEntryItemId(sessionId, around.searchItemId, 'transcript');
    const transcript = hit && read.transcriptSource(hit.revision, hit.entryIndex);
    if (!transcript || transcript.sourceRevision !== sourceRevision) staleHistory('Search reference expired; search again.');
    auditId = transcript.entryId;
    if (!auditId) return undefined;
  } else if (around.historyBoundary.sourceRevision !== sourceRevision) staleHistory('Saved reading position changed.');
  const history = await read.readSource();
  if (history.sourceRevision !== sourceRevision) staleHistory('Saved history changed.');
  let found: {index: number; boundaryId: string} | undefined;
  for (const [index, entry] of history.entries.entries()) {
    if ((index & 255) === 0) await read.yieldControl();
    if (!entry.boundaryId) continue;
    const matches = 'historyBoundary' in around ? entry.boundaryId === around.historyBoundary.entryId
      : auditId !== undefined && entry.auditEntryIds.includes(auditId);
    if (!matches) continue;
    if (found) return undefined;
    found = {index, boundaryId: entry.boundaryId};
  }
  return found;
}

/** Around/forward reads are optional navigation work, never CLI startup work. */
export async function readLocatedHistoryPage(
  input: RuntimeConversationHistoryPageInput, read: LocatedHistoryRead,
): Promise<RuntimeConversationHistorySlice | null> {
  const {sessionId, around, cursor} = input;
  if (around && cursor) throw new Error('Use either a saved position or a cursor.');
  const limit = Math.min(input.limit ?? read.defaultLimit, read.maximumLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid history page limit.');
  const tail = await read.readPage(undefined, 1);
  if (!tail) return null;
  const last = tail.entries.at(-1)?.index ?? -1;
  const located = around && await locateConversationEntry(sessionId, around, tail.sourceRevision, read);
  if (around && !located) return { ...tail, entries: [], hasMore: false, nextCursor: undefined };
  const template = tail.nextCursor && read.decode(tail.nextCursor);
  if (!template || template.kind === 'entry') {
    if (cursor) staleHistory('Saved history changed.');
    return { ...tail, locatedBoundaryId: located?.boundaryId };
  }
  const atEnd = (end: number) => read.encode({ ...template, end });
  const forward = cursor && read.decode(cursor.slice('newer.'.length));
  if (forward && (forward.kind !== template.kind || forward.revision !== tail.revision || forward.view !== 'conversation'))
    staleHistory('Saved history changed.');
  const start = forward && 'end' in forward ? forward.end : undefined;
  if (start !== undefined && start > last) staleHistory('Saved window no longer exists.');
  let end = located ? Math.min(last + 1, located.index + 1 + Math.floor(limit / 2))
    : Math.min(last + 1, (start ?? 0) + limit);
  let page = await read.readPage(atEnd(end), start === undefined ? limit : end - start);
  // A large following entry may shrink a centered page past the target.
  // Retry with the target as its last entry; never claim an absent hit is shown.
  if (located && page && !page.entries.some(entry => entry.index === located.index)) {
    end = located.index + 1;
    page = await read.readPage(atEnd(end), limit);
  }
  // A byte-bounded backward page may shrink. Forward must retain its first unread entry.
  while (start !== undefined && page && page.entries[0]?.index !== start && end > start + 1) {
    end = start + Math.max(1, Math.floor((end - start) / 2));
    page = await read.readPage(atEnd(end), end - start);
  }
  if (!page || page.revision !== tail.revision || (located && !page.entries.some(entry => entry.index === located.index)))
    staleHistory('Saved history changed.');
  return { ...page, locatedBoundaryId: located?.boundaryId,
    ...(end <= last ? { newerCursor: 'newer.' + atEnd(end) } : {}) };
}
