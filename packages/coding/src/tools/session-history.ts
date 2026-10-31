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

export const SESSION_HISTORY_SEARCH_DESCRIPTION = [
  'Search exact persisted entries that are no longer present in the compacted model context.',
  'Use this only when a user request depends on an omitted historical detail; do not guess from the checkpoint.',
  'Results are bounded snippets with stable entry citations. Read the needed hit using its entryRevision as read.revision.',
].join(' ');

export const SESSION_HISTORY_ENTRY_REVISION_RULE = 'Use selected hit.entryRevision as revision; reuse returned entryRevision for nextOffset or stale recovery. '
  + 'It checks this entry across normal message appends. Top-level search revision remains a strict whole-history snapshot.';

export const SESSION_HISTORY_READ_DESCRIPTION = [
  'Read one exact persisted session-history entry cited by session_history_search.',
  'Content is returned in bounded character chunks.',
  SESSION_HISTORY_ENTRY_REVISION_RULE,
].join(' ');

export const SESSION_HISTORY_SEARCH_SCHEMA = {
  type: 'object' as const,
  properties: {
    query: { type: 'string' as const, description: 'Specific phrase, identifier, command, or historical fact to find.' },
    limit: { type: 'number' as const, description: 'Maximum snippets to return (1-20, default 8).' },
    role: {
      type: 'string' as const,
      enum: ['user', 'assistant'],
      description: 'Optional message-role filter.',
    },
    scope: {
      type: 'string' as const,
      enum: ['compacted', 'all'],
      description: 'Defaults to compacted history; use all only when active-tail search is required.',
    },
  },
  required: ['query'],
};

export const SESSION_HISTORY_READ_SCHEMA = {
  type: 'object' as const,
  properties: {
    entry_id: { type: 'string' as const, description: 'Exact selected hit.entryId returned by session_history_search.' },
    revision: { type: 'string' as const, description: 'Selected hit.entryRevision or read.entryRevision; legacy whole-history revision remains strict.' },
    offset: { type: 'number' as const, description: 'Zero-based character offset (default 0).' },
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
  });
  const limit = Math.min(20, Math.max(1, Math.trunc(requestedLimit)));
  const hits = result.hits
    .filter((hit) => hit.role !== 'system')
    .slice(0, limit);
  return JSON.stringify({ status: 'ok', revision: result.revision, hits });
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
