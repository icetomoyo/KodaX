/**
 * Public history paging over the runtime conversation-page seam
 * (FEATURE_298 T09). Pages carry the same display projection as the session
 * view; ids anchor to the conversation revision so paging, re-reading and
 * large-entry reads stay unambiguous.
 */
import { restoreHistoryItemsFromSession } from '@kodax-ai/repl';
import { canonicalTools, canonicalToolKey, toolResultText, toolResultOutputPath } from './client-canonical-tools.js';
import { readSavedToolOutput } from './tool-output-reader.js';
import { readTaskResultReports, type KodaXDiagnosticSink, type KodaXMessage } from '@kodax-ai/agent';
import { assembleConversationHistoryEntry, readFollowingMessage } from './conversation-entry-reader.js';
export { assembleConversationHistoryEntry, readFollowingMessage } from './conversation-entry-reader.js';
import type {
  ClientHistoryPage,
  ClientItemContent,
  ClientItemReadOptions,
  ClientViewItem,
  ClientReadOptions,
} from '@kodax-ai/coding/client-contract';
import type {
  RuntimeConversationHistoryEntryChunk,
  RuntimeConversationHistorySlice,
} from './sdk-runtime.js';

const HISTORY_READ_CHUNK_CHARS = 65_536;

/** Shared deadline across a page, its retry and any oversized body reads. */
export function createHistoryReadBudget(options?: ClientReadOptions): () => ClientReadOptions {
  if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw Object.assign(new Error('History read timeoutMs must be positive and finite.'), { code: 'invalid_params' });
  }
  const deadline = options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  return () => {
    if (options?.signal?.aborted) throw Object.assign(new Error('History read cancelled.'), { code: 'read_cancelled' });
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw Object.assign(new Error('History read timed out.'), { code: 'read_timeout' });
    return { ...(remaining === undefined ? {} : { timeoutMs: remaining }), ...(options?.signal ? { signal: options.signal } : {}) };
  };
}

/** Project one conversation page into public display items. */
export async function projectConversationHistoryPage(
  sessionId: string,
  page: RuntimeConversationHistorySlice,
  readChunk: Parameters<typeof readConversationHistoryEntry>[2],
  // The CLI and the lazily loaded SDK can own distinct diagnostic and credential scopes.
  report?: KodaXDiagnosticSink,
): Promise<ClientHistoryPage> {
  const items: ClientViewItem[] = [];
  const oversized: { itemId: string; byteLength: number }[] = [];
  for (const [position, entry] of page.entries.entries()) {
    if (entry.oversized) {
      oversized.push({ itemId: historyEntryItemId(sessionId, page.revision, entry.index), byteLength: entry.byteLength });
    }
    const owner = entry.entry ?? (entry.oversized
      ? await assembleConversationHistoryEntry(readChunk, sessionId, page.revision, entry.index, report)
      : undefined);
    if (!owner) continue;
    const hasTools = owner.message.role === 'assistant' && Array.isArray(owner.message.content)
      && owner.message.content.some(block => block.type === 'tool_use');
    const successor = hasTools
      ? page.entries[position + 1]?.entry?.message
        ?? await readFollowingMessage(readChunk, sessionId, page.revision, entry.index, report)
      : undefined;
    const results = successor?.role === 'user' && Array.isArray(successor.content)
      ? successor.content.filter(block => block.type === 'tool_result') : [];
    items.push(...projectHistoryEntry(
      sessionId,
      page.revision,
      entry.index,
      results.length > 0
        ? [owner.message, { role: 'user', content: results,
          ...(successor?.timestamp !== undefined ? { timestamp: successor.timestamp } : {}) }]
        : [owner.message],
    ).map(item => boundHistoryItem({ ...item,
      ...(item.type === 'user' && Array.isArray(owner.message.content)
        && owner.message.content.some(block => block.type === 'image')
        ? { attachments: owner.message.content.flatMap(block => block.type === 'image'
          ? [{ kind: 'image' as const, path: block.path, ...(block.mediaType ? { mediaType: block.mediaType } : {}) }] : []) } : {}),
      ...(entry.boundaryId !== undefined ? { historyBoundary: {
        entryId: entry.boundaryId, sourceRevision: page.sourceRevision,
      } } : {}),
    })));
  }
  return {
    items,
    ...(page.locatedBoundaryId && items.some(item => item.historyBoundary?.entryId === page.locatedBoundaryId)
      ? { locatedBoundaryId: page.locatedBoundaryId } : {}),
    ...(page.newerCursor ? { newerCursor: page.newerCursor } : {}),
    revision: page.revision,
    sourceRevision: page.sourceRevision,
    status: page.status,
    issues: page.issues,
    ...(page.hasMore && page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    oversized,
  };
}

/**
 * Read the body of one history entry (an oversized entry, or any entry a
 * page item id refers to). `text` returns the entry's text and tool-result
 * content; `input` returns its tool-call parameters verbatim.
 * Task history returns report Markdown; the raw transcript namespace retains envelopes.
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
  namespace: 'history' | 'transcript' = 'history',
  report?: KodaXDiagnosticSink,
): Promise<ClientItemContent | null> {
  if (options.part === 'attachment') throw new Error('Read image attachments through sessions.readItem.');
  const parsed = parseHistoryEntryItemId(sessionId, itemId, namespace);
  if (parsed === undefined) return null;
  const entry = await assembleConversationHistoryEntry(readChunk, sessionId, parsed.revision, parsed.entryIndex, report);
  if (entry === null) return null;
  const selected = parsed.ordinal === undefined ? undefined
    : projectHistoryEntry(sessionId, parsed.revision, parsed.entryIndex, [entry.message])[parsed.ordinal];
  if (parsed.ordinal !== undefined && selected === undefined) return null;
  const reports = namespace === 'history' && parsed.ordinal === undefined && options.part !== 'input'
    ? readTaskResultReports(entry.message) : [];
  let text = selected?.text ?? (reports.length > 0 ? reports.map(report => report.summary).join('\n\n')
    : entryBody(entry.message, options.part === 'input' ? 'input' : 'text'));
  if (selected?.tool !== undefined) {
    const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
    const call = blocks.find((block) => block.type === 'tool_use' && block.id === selected.tool?.callId);
    if (options.part === 'input') {
      if (call?.type !== 'tool_use') return null;
      text = JSON.stringify(call.input);
    } else {
      const next = await readFollowingMessage(readChunk, sessionId, parsed.revision, parsed.entryIndex, report);
      const results = Array.isArray(next?.content) ? next.content : [];
      const result = results.find((block) => block.type === 'tool_result' && block.tool_use_id === selected.tool?.callId);
      if (result?.type !== 'tool_result') return null;
      const outputPath = toolResultOutputPath(result);
      if (options.part === 'original' && outputPath) return readSavedToolOutput(outputPath, itemId, options.offset);
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

/**
 * One bounded retry for a fresh newest-page read: the page cache reads under
 * a strict quiescent boundary, and right after activity a boundary miss is
 * transient. Cursor reads never retry — a stale cursor must reject with
 * resync_required so the caller restarts from a fresh page.
 */
export async function readHistoryPageWithBoundaryRetry(
  read: () => Promise<RuntimeConversationHistorySlice | null>,
  options: { readonly cursor?: string; readonly around?: unknown },
): Promise<RuntimeConversationHistorySlice | null> {
  try {
    return await read();
  } catch (error: unknown) {
    if (options.cursor !== undefined || options.around !== undefined || !isTransientHistoryBoundaryError(error)) throw error;
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

export function parseHistoryEntryItemId(
  sessionId: string,
  itemId: string,
  namespace: 'history' | 'transcript',
): { revision: string; entryIndex: number; ordinal?: number } | undefined {
  const prefix = `${sessionId}:${namespace}:`;
  if (!itemId.startsWith(prefix)) return undefined;
  const [base = '', ordinal, extra] = itemId.slice(prefix.length).split('#');
  if (extra !== undefined) return undefined;
  if (namespace === 'transcript' && ordinal !== undefined) return undefined;
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

export function projectHistoryEntry(
  sessionId: string,
  revision: string,
  entryIndex: number,
  messages: readonly KodaXMessage[],
): ClientViewItem[] {
  // A single entry may exceed the live display window. Keep all its blocks
  // under the same entry anchor; ordinals count emitted items flatly.
  const restored = restoreHistoryItemsFromSession({ messages, historyScope: 'all', structuredTaskResults: true });
  const tools = canonicalTools(messages);
  const items: ClientViewItem[] = [];
  let ordinal = 0;
  for (const item of restored) {
    if (item.type === 'tool_group') {
      for (const tool of item.tools) {
        const canonical = tools.get(canonicalToolKey(tool.id, tool.assistantOutputId));
        if (!canonical) continue;
        items.push({
          ...canonical,
          id: historyItemId(sessionId, revision, entryIndex, ordinal),
        });
        ordinal += 1;
      }
      continue;
    }
    items.push({
      id: historyItemId(sessionId, revision, entryIndex, ordinal),
      type: item.type as ClientViewItem['type'],
      text: item.text,
      ...(item.taskResult ? { taskResult: item.taskResult } : {}),
      ...(item.inputId !== undefined ? { inputId: item.inputId } : {}),
      ...(item.outputId !== undefined ? {
        outputId: item.outputId, outputState: 'committed' as const, textRevision: 0,
      } : {}),
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
