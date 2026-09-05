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
export function projectConversationHistoryPage(
  sessionId: string,
  page: RuntimeConversationHistorySlice,
): ClientHistoryPage {
  const items: ClientViewItem[] = [];
  const oversized: { itemId: string; byteLength: number }[] = [];
  for (const [position, entry] of page.entries.entries()) {
    if (entry.oversized || entry.entry === undefined) {
      if (entry.oversized) {
        oversized.push({
          itemId: historyEntryItemId(sessionId, page.revision, entry.index),
          byteLength: entry.byteLength,
        });
      }
      continue;
    }
    // Tool pairing is cross-message: an assistant tool_use pairs with the
    // tool_result blocks of the NEXT message. Only that user-role successor
    // joins the projection — a wider window would re-project the successor
    // under this entry's anchor. Items always anchor to the tool-call owner.
    const successor = entry.entry.message.role === 'assistant'
      ? page.entries[position + 1]?.entry?.message
      : undefined;
    items.push(...projectHistoryEntry(
      sessionId,
      page.revision,
      entry.index,
      successor?.role === 'user'
        ? [entry.entry.message, successor]
        : [entry.entry.message],
    ));
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
  const text = entryBody(entry.message, options.part ?? 'text');
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
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
): { revision: string; entryIndex: number } | undefined {
  const prefix = `${sessionId}:history:`;
  if (!itemId.startsWith(prefix)) return undefined;
  const base = itemId.slice(prefix.length).split('#')[0] ?? '';
  // Parse from the right: the revision itself contains a colon
  // ("sha256:<digest>"), so only the trailing index segment is structural.
  const lastColon = base.lastIndexOf(':');
  if (lastColon <= 0) return undefined;
  const revision = base.slice(0, lastColon);
  if (!/^sha256:[0-9a-f]{8,}$/u.test(revision)) return undefined;
  const match = /^(\d+)$/u.exec(base.slice(lastColon + 1));
  if (match === null || match[1] === undefined) return undefined;
  return { revision, entryIndex: Number(match[1]) };
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
  const items: ClientViewItem[] = [];
  let ordinal = 0;
  for (const item of restored) {
    if (item.type === 'tool_group') {
      for (const tool of item.tools) {
        items.push({
          id: historyItemId(sessionId, revision, entryIndex, ordinal),
          type: 'tool',
          text: String(tool.output ?? tool.error ?? ''),
          tool: {
            callId: tool.id, name: tool.name, status: 'success',
            inputText: JSON.stringify(tool.input), startedAt: tool.startTime, endedAt: tool.endTime,
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
      ...('icon' in item ? { icon: item.icon } : {}),
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
    });
    ordinal += 1;
  }
  return items;
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
