/**
 * Public history paging over the runtime conversation-page seam
 * (FEATURE_298 T09). Pages carry the same display projection as the session
 * view; ids anchor to the conversation revision so paging, re-reading and
 * large-entry reads stay unambiguous.
 */
import { restoreHistoryItemsFromSession } from '@kodax-ai/repl';
import { emitKodaXDiagnostic, type KodaXMessage } from '@kodax-ai/agent';
import type {
  ClientHistoryPage,
  ClientItemContent,
  ClientItemReadOptions,
  ClientViewItem,
} from '@kodax-ai/coding/client-contract';
import type {
  RuntimeConversationHistoryEntryChunk,
  RuntimeConversationHistorySlice,
} from './sdk-runtime.js';

const HISTORY_READ_CHUNK_CHARS = 65_536;
const HISTORY_CHUNK_READ_LIMIT = 512;

/** Project one conversation page into public display items. */
export async function projectConversationHistoryPage(
  sessionId: string,
  page: RuntimeConversationHistorySlice,
  readChunk: Parameters<typeof readConversationHistoryEntry>[2],
): Promise<ClientHistoryPage> {
  const items: ClientViewItem[] = [];
  const oversized: { itemId: string; byteLength: number }[] = [];
  for (const [position, entry] of page.entries.entries()) {
    if (entry.oversized) {
      oversized.push({ itemId: historyEntryItemId(sessionId, page.revision, entry.index), byteLength: entry.byteLength });
    }
    const owner = entry.entry ?? (entry.oversized
      ? await assembleConversationHistoryEntry(readChunk, sessionId, page.revision, entry.index)
      : undefined);
    if (!owner) continue;
    const hasTools = owner.message.role === 'assistant' && Array.isArray(owner.message.content)
      && owner.message.content.some(block => block.type === 'tool_use');
    const successor = hasTools
      ? page.entries[position + 1]?.entry?.message
        ?? await readFollowingMessage(readChunk, sessionId, page.revision, entry.index)
      : undefined;
    const results = successor?.role === 'user' && Array.isArray(successor.content)
      ? successor.content.filter(block => block.type === 'tool_result') : [];
    items.push(...projectHistoryEntry(
      sessionId,
      page.revision,
      entry.index,
      results.length > 0
        ? [owner.message, { role: 'user', content: results }]
        : [owner.message],
    ).map(boundHistoryItem));
  }
  return {
    items,
    revision: page.revision,
    ...(page.hasMore && page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    oversized,
  };
}

/**
 * Read the raw body of one history entry (an oversized entry, or any entry a
 * page item id refers to). `text` returns the entry's text and tool-result
 * content; `input` returns its tool-call parameters verbatim.
 */
export async function readConversationHistoryEntry(
  sessionId: string,
  itemId: string,
  readChunk: (input: {
    readonly sessionId: string;
    readonly revision: string;
    readonly entryIndex: number;
    readonly cursor?: string;
  }) => Promise<RuntimeConversationHistoryEntryChunk | null>,
  options: ClientItemReadOptions = {},
): Promise<ClientItemContent | null> {
  const parsed = parseHistoryEntryItemId(sessionId, itemId);
  if (parsed === undefined) return null;
  const entry = await assembleConversationHistoryEntry(readChunk, sessionId, parsed.revision, parsed.entryIndex);
  if (entry === null) return null;
  const selected = parsed.ordinal === undefined ? undefined
    : projectHistoryEntry(sessionId, parsed.revision, parsed.entryIndex, [entry.message])[parsed.ordinal];
  if (parsed.ordinal !== undefined && selected === undefined) return null;
  let text = selected?.text ?? entryBody(entry.message, options.part ?? 'text');
  if (selected?.tool !== undefined) {
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    const call = blocks.find((block) => block.type === 'tool_use' && block.id === selected.tool?.callId);
    if (options.part === 'input') {
      if (call?.type !== 'tool_use') return null;
      text = JSON.stringify(call.input);
    } else {
      const next = await readFollowingMessage(readChunk, sessionId, parsed.revision, parsed.entryIndex);
      const results = Array.isArray(next?.content) ? next.content : [];
      const result = results.find((block) => block.type === 'tool_result' && block.tool_use_id === selected.tool?.callId);
      if (result?.type !== 'tool_result') return null;
      text = toolResultText(result.content);
    }
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Item offset must be a non-negative integer.');
  if (offset >= text.length && text.length > 0) return null;
  const chunk = text.slice(offset, offset + HISTORY_READ_CHUNK_CHARS);
  const nextOffset = offset + chunk.length;
  return {
    id: itemId,
    text: chunk,
    offset,
    totalLength: text.length,
    ...(nextOffset < text.length ? { nextOffset } : {}),
  };
}

async function readFollowingMessage(
  readChunk: Parameters<typeof readConversationHistoryEntry>[2],
  sessionId: string,
  revision: string,
  entryIndex: number,
): Promise<KodaXMessage | undefined> {
  try {
    return (await assembleConversationHistoryEntry(readChunk, sessionId, revision, entryIndex + 1))?.message;
  } catch (error: unknown) {
    // An interrupted final tool call legitimately has no successor.
    if (error instanceof Error && error.message.startsWith('Transcript entry index is out of range:')) return undefined;
    throw error;
  }
}

/**
 * One bounded retry for a fresh newest-page read: the page cache reads under
 * a strict quiescent boundary, and right after activity a boundary miss is
 * transient. Cursor reads never retry — a stale cursor must reject with
 * resync_required so the caller restarts from a fresh page.
 */
export async function readHistoryPageWithBoundaryRetry(
  read: () => Promise<RuntimeConversationHistorySlice | null>,
  options: { readonly cursor?: string },
): Promise<RuntimeConversationHistorySlice | null> {
  try {
    return await read();
  } catch (error: unknown) {
    if (options.cursor !== undefined || !isTransientHistoryBoundaryError(error)) throw error;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref?.();
    });
    return read();
  }
}

function isTransientHistoryBoundaryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { readonly code: unknown }).code;
  return code === 'data_changed' || code === 'resync_required';
}

function historyEntryItemId(sessionId: string, revision: string, entryIndex: number): string {
  return `${sessionId}:history:${revision}:${entryIndex}`;
}

function parseHistoryEntryItemId(
  sessionId: string,
  itemId: string,
): { revision: string; entryIndex: number; ordinal?: number } | undefined {
  const prefix = `${sessionId}:history:`;
  if (!itemId.startsWith(prefix)) return undefined;
  const [base = '', ordinal, extra] = itemId.slice(prefix.length).split('#');
  if (extra !== undefined) return undefined;
  if (ordinal !== undefined && !/^\d+$/u.test(ordinal)) return undefined;
  // Parse from the right: the revision itself contains a colon
  // ("sha256:<digest>"), so only the trailing index segment is structural.
  const lastColon = base.lastIndexOf(':');
  if (lastColon <= 0) return undefined;
  const revision = base.slice(0, lastColon);
  if (!/^sha256:[0-9a-f]{8,}$/u.test(revision)) return undefined;
  const match = /^(\d+)$/u.exec(base.slice(lastColon + 1));
  if (match === null || match[1] === undefined) return undefined;
  const entryIndex = Number(match[1]);
  if (!Number.isSafeInteger(entryIndex) || (ordinal !== undefined && !Number.isSafeInteger(Number(ordinal)))) return undefined;
  return { revision, entryIndex, ...(ordinal !== undefined ? { ordinal: Number(ordinal) } : {}) };
}

function projectHistoryEntry(
  sessionId: string,
  revision: string,
  entryIndex: number,
  messages: readonly KodaXMessage[],
): ClientViewItem[] {
  // One entry (plus its pairing successor) at a time keeps the repl
  // projection inside its trimming window and gives every item an
  // unambiguous entry anchor; ordinals count emitted items flatly.
  const restored = restoreHistoryItemsFromSession({ messages });
  const ownerBlocks = Array.isArray(messages[0]?.content) ? messages[0].content : [];
  const resultBlocks = Array.isArray(messages[1]?.content) ? messages[1].content : [];
  const items: ClientViewItem[] = [];
  let ordinal = 0;
  for (const item of restored) {
    if (item.type === 'tool_group') {
      for (const tool of item.tools) {
        const call = ownerBlocks.find(block => block.type === 'tool_use' && block.id === tool.id);
        const result = resultBlocks.find(block => block.type === 'tool_result' && block.tool_use_id === tool.id);
        items.push({
          id: historyItemId(sessionId, revision, entryIndex, ordinal),
          type: 'tool',
          text: result?.type === 'tool_result' ? toolResultText(result.content) : String(tool.output ?? tool.error ?? ''),
          tool: {
            callId: tool.id, name: tool.name,
            status: tool.status === 'success' || tool.status === 'error' ? tool.status : 'cancelled',
            inputText: JSON.stringify(call?.type === 'tool_use' ? call.input : tool.input), startedAt: tool.startTime, endedAt: tool.endTime,
          },
        });
        ordinal += 1;
      }
      continue;
    }
    items.push({
      id: historyItemId(sessionId, revision, entryIndex, ordinal),
      type: item.type as ClientViewItem['type'],
      text: item.text,
      ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
      ...('icon' in item ? { icon: item.icon } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    });
    ordinal += 1;
  }
  return items;
}

function boundHistoryItem(item: ClientViewItem): ClientViewItem {
  const limit = 8192;
  const input = item.tool?.inputText;
  return {
    ...item,
    ...(item.text.length > limit ? { text: item.text.slice(0, limit), textOffset: 0, totalTextLength: item.text.length } : {}),
    ...(item.tool && input && input.length > limit
      ? { tool: { ...item.tool, inputText: input.slice(0, limit), totalInputLength: input.length } } : {}),
  };
}

function historyItemId(sessionId: string, revision: string, entryIndex: number, ordinal: number): string {
  return `${sessionId}:history:${revision}:${entryIndex}#${ordinal}`;
}

async function assembleConversationHistoryEntry(
  readChunk: (
    input: {
      readonly sessionId: string;
      readonly revision: string;
      readonly entryIndex: number;
      readonly cursor?: string;
    },
  ) => Promise<RuntimeConversationHistoryEntryChunk | null>,
  sessionId: string,
  revision: string,
  entryIndex: number,
): Promise<{ message: KodaXMessage } | null> {
  let cursor: string | undefined;
  const encoded: string[] = [];
  for (let read = 0; read < HISTORY_CHUNK_READ_LIMIT; read += 1) {
    const chunk = await readChunk({ sessionId, revision, entryIndex, ...(cursor !== undefined ? { cursor } : {}) });
    if (chunk === null) return null;
    encoded.push(chunk.data);
    if (!chunk.hasMore) {
      const decoded = decodeEntryJson(encoded.join(''));
      if (decoded === undefined) {
        emitKodaXDiagnostic({
          source: 'client.history',
          level: 'error',
          message: `History entry chunk stream for ${sessionId} entry ${entryIndex} did not decode.`,
        });
        throw Object.assign(
          new Error(`History entry ${sessionId}#${entryIndex} is unreadable.`),
          { code: 'internal_error' as const },
        );
      }
      return { message: decoded.message };
    }
    cursor = chunk.nextCursor;
    if (cursor === undefined) return null;
  }
  emitKodaXDiagnostic({
    source: 'client.history',
    level: 'error',
    message: `History entry chunk stream for ${sessionId} entry ${entryIndex} exceeded ${HISTORY_CHUNK_READ_LIMIT} chunks.`,
  });
  throw Object.assign(
    new Error(`History entry ${sessionId}#${entryIndex} exceeded the chunk read limit.`),
    { code: 'internal_error' as const },
  );
}

function decodeEntryJson(encoded: string): { message: KodaXMessage } | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) return undefined;
    if (typeof (message as { readonly role?: unknown }).role !== 'string') return undefined;
    return parsed as { message: KodaXMessage };
  } catch {
    return undefined;
  }
}

/** Raw entry body, bypassing the replay projection's display truncation. */
function entryBody(message: KodaXMessage, part: 'text' | 'input'): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (part === 'input') {
    return blocks
      .filter((block): block is Extract<typeof block, { readonly type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => JSON.stringify(block.input))
      .join('\n');
  }
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      parts.push(toolResultText(block.content));
    }
  }
  if (parts.length === 0 && typeof message.content === 'string') parts.push(message.content);
  return parts.join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item === 'object' && item !== null && (item as { readonly type?: unknown }).type === 'text'
      ? String((item as { readonly text?: unknown }).text ?? '')
      : ''))
    .filter((text) => text.length > 0)
    .join('\n');
}
