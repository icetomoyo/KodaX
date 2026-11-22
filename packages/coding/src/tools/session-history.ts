import {
  readSessionHistoryEntry,
  searchSessionHistory,
  type KodaXSessionLineage,
} from '@kodax-ai/agent';
import type { KodaXSessionScope, KodaXSessionStorage } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';

export const SESSION_HISTORY_SEARCH_TOOL_NAME = 'session_history_search';
export const SESSION_HISTORY_READ_TOOL_NAME = 'session_history_read';
export const SESSION_HISTORY_TOOL_NAMES = [
  SESSION_HISTORY_SEARCH_TOOL_NAME,
  SESSION_HISTORY_READ_TOOL_NAME,
] as const;

export function isSessionHistoryTool(name: string): boolean {
  return SESSION_HISTORY_TOOL_NAMES.includes(name as typeof SESSION_HISTORY_TOOL_NAMES[number]);
}

export function createSessionHistoryLoader(input: {
  readonly sessionId?: string;
  readonly currentAgentId?: string;
  readonly sessionScope?: KodaXSessionScope;
  readonly storage?: KodaXSessionStorage;
}): KodaXToolExecutionContext['loadSessionHistory'] {
  const loadFullLineage = input.storage?.loadFullLineage;
  const isolatedChild = input.currentAgentId !== undefined
    && input.sessionScope === 'managed-task-worker';
  if (!input.sessionId || (input.currentAgentId !== undefined && !isolatedChild) || !loadFullLineage) {
    return undefined;
  }
  const { sessionId, storage } = input;
  return () => loadFullLineage.call(storage, sessionId);
}

export const SESSION_HISTORY_SEARCH_DESCRIPTION = 'Search the exact session entries that are no longer in your context because compaction replaced them with a summary. '
  + 'Use it when the current request depends on a detail the summary dropped, such as an exact value, ID, command, error text or user wording. '
  + 'Don\'t answer such details from the summary alone: it is a paraphrase and often loses them. '
  + 'Results are short snippets with stable entry citations. '
  + 'exactHits counts every entry that contains the whole query, including ones beyond the returned hits. '
  + 'totalHits also counts entries that match only some query terms. '
  + 'If exactHits is larger than the number of hits returned, some exact matches are hidden, so raise limit or narrow the query before you count or conclude. '
  + 'Read the hit you need with session_history_read, passing its entryRevision as revision.';

export const SESSION_HISTORY_READ_DESCRIPTION = 'Read one exact session entry cited by session_history_search, in bounded character chunks. '
  + 'Pass the hit\'s entryRevision as revision. '
  + 'When the result has a nextOffset, call again with that offset and the entryRevision the result returned. '
  + 'A stale result means the entry changed; it returns the new entryRevision to read with.';

export const SESSION_HISTORY_SEARCH_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string' as const, description: 'Specific phrase, identifier, command, or historical fact to find.' },
    limit: { type: 'number' as const, description: 'Maximum snippets to return (1-20, default 8).' },
    role: { type: 'string' as const, enum: ['user', 'assistant'], description: 'Optional message-role filter.' },
    scope: {
      type: 'string' as const,
      enum: ['compacted', 'all'],
      description: 'Defaults to compacted history. Use all only when you also need to search the entries still in your context.',
    },
  },
  required: ['query'],
};

export const SESSION_HISTORY_READ_SCHEMA = {
  type: 'object' as const,
  properties: {
    entry_id: { type: 'string' as const, description: 'Exact entryId of a search hit.' },
    revision: {
      type: 'string' as const,
      description: 'The hit\'s entryRevision, or the entryRevision returned by an earlier read. '
        + 'The top-level revision from a search also works, but it goes stale as soon as any new message is added.',
    },
    offset: { type: 'number' as const, description: 'Zero-based character offset (default 0). Use the nextOffset from the previous read.' },
  },
  required: ['entry_id'],
};

export function activateSessionHistoryTools(activeTools: readonly string[], enabled: boolean): string[] {
  const withoutHistory = activeTools.filter(
    (name) => !SESSION_HISTORY_TOOL_NAMES.includes(name as typeof SESSION_HISTORY_TOOL_NAMES[number]),
  );
  return enabled ? [...withoutHistory, ...SESSION_HISTORY_TOOL_NAMES] : withoutHistory;
}

export function canActivateSessionHistoryTools(input: {
  readonly activeTools: readonly string[];
  readonly sessionId?: string;
  readonly currentAgentId?: string;
  readonly sessionScope?: KodaXSessionScope;
  readonly storage?: KodaXSessionStorage;
}): boolean {
  return createSessionHistoryLoader(input) !== undefined
    && SESSION_HISTORY_TOOL_NAMES.every((name) => input.activeTools.includes(name));
}

async function loadHistory(ctx: KodaXToolExecutionContext): Promise<KodaXSessionLineage | null> {
  return ctx.loadSessionHistory?.() ?? null;
}

export async function toolSessionHistorySearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const lineage = await loadHistory(ctx);
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!lineage || !query) return JSON.stringify({ status: 'unavailable', hits: [] });
  const role = input.role === 'user' || input.role === 'assistant' ? input.role : undefined;
  const scope = input.scope === 'all' ? 'all' as const : 'compacted' as const;
  const requestedLimit = typeof input.limit === 'number' ? input.limit : 8;
  const result = searchSessionHistory(lineage, {
    query,
    limit: 20,
    role,
    scope,
    excludeToolNames: SESSION_HISTORY_TOOL_NAMES,
  });
  const limit = Math.min(20, Math.max(1, Math.trunc(requestedLimit)));
  const hits = result.hits
    .filter((hit) => hit.role !== 'system')
    .slice(0, limit);
  return JSON.stringify({
    status: 'ok',
    revision: result.revision,
    totalHits: result.totalHits,
    exactHits: result.exactHits,
    hits,
  });
}

export async function toolSessionHistoryRead(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const lineage = await loadHistory(ctx);
  const entryId = typeof input.entry_id === 'string' ? input.entry_id.trim() : '';
  if (!lineage || !entryId) return JSON.stringify({ status: 'unavailable', entryId });
  const target = lineage.entries.find((entry) => entry.id === entryId);
  if (target?.type === 'message' && target.message.role === 'system') {
    return JSON.stringify({ status: 'not_found', entryId });
  }
  const result = readSessionHistoryEntry(lineage, {
    entryId,
    revision: typeof input.revision === 'string' ? input.revision : undefined,
    offset: typeof input.offset === 'number' ? input.offset : undefined,
  });
  return JSON.stringify(result);
}
