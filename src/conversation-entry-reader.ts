/** Hot canonical entry reads without loading history display projection. */
import { emitKodaXDiagnostic, type KodaXMessage } from '@kodax-ai/agent';
import type { RuntimeConversationHistoryEntryChunk } from './sdk-runtime.js';

export type ConversationEntryReader = (input: {
  readonly sessionId: string; readonly revision: string; readonly entryIndex: number; readonly cursor?: string;
}) => Promise<RuntimeConversationHistoryEntryChunk | null>;

const HISTORY_CHUNK_READ_LIMIT = 512;

export async function readFollowingMessage(
  readChunk: ConversationEntryReader, sessionId: string, revision: string, entryIndex: number,
  report = emitKodaXDiagnostic,
): Promise<KodaXMessage | undefined> {
  try {
    return (await assembleConversationHistoryEntry(readChunk, sessionId, revision, entryIndex + 1, report))?.message;
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Transcript entry index is out of range:')) return undefined;
    throw error;
  }
}

export async function assembleConversationHistoryEntry(
  readChunk: ConversationEntryReader, sessionId: string, revision: string, entryIndex: number,
  report = emitKodaXDiagnostic,
): Promise<{ message: KodaXMessage } | null> {
  let cursor: string | undefined;
  const bytes: Buffer[] = [];
  for (let read = 0; read < HISTORY_CHUNK_READ_LIMIT; read += 1) {
    const chunk = await readChunk({ sessionId, revision, entryIndex, ...(cursor !== undefined ? { cursor } : {}) });
    if (chunk === null) return null;
    bytes.push(Buffer.from(chunk.data, 'base64'));
    if (!chunk.hasMore) {
      const decoded = decodeEntryJson(Buffer.concat(bytes));
      if (decoded === undefined) {
        report({ source: 'client.history', level: 'error',
          message: `History entry chunk stream for ${sessionId} entry ${entryIndex} did not decode.` });
        throw Object.assign(new Error(`History entry ${sessionId}#${entryIndex} is unreadable.`), { code: 'internal_error' as const });
      }
      return { message: decoded.message };
    }
    cursor = chunk.nextCursor;
    if (cursor === undefined) return null;
  }
  report({ source: 'client.history', level: 'error',
    message: `History entry chunk stream for ${sessionId} entry ${entryIndex} exceeded ${HISTORY_CHUNK_READ_LIMIT} chunks.` });
  throw Object.assign(new Error(`History entry ${sessionId}#${entryIndex} exceeded the chunk read limit.`), { code: 'internal_error' as const });
}

function decodeEntryJson(bytes: Buffer): { message: KodaXMessage } | undefined {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) return undefined;
    if (typeof (message as { readonly role?: unknown }).role !== 'string') return undefined;
    return parsed as { message: KodaXMessage };
  } catch {
    return undefined;
  }
}
