import type { KodaXEvents, KodaXActivityEventMeta } from '@kodax-ai/coding';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createRecoveryHistoryItem } from '@kodax-ai/repl';

type DisplayNotice = Pick<ClientViewItem, 'type' | 'text' | 'icon'> & { readonly id?: string };
type AppendNotice = (notice: DisplayNotice, meta?: KodaXActivityEventMeta) => void;

/** Retained display facts, including ones which begin and end between two view deliveries. */
export function createSessionNoticeEvents(
  sessionId: string,
  append: AppendNotice,
): KodaXEvents {
  return {
    ...rateLimitNotices(append),
    ...compactionNotices(append),
    onReasoningEffortRejected: event => append({
      id: `reasoning:${event.providerRequestId ?? 'legacy'}:rejected:${event.provider}:${event.model}:${event.effort}`,
      type: 'info', text: `[Reasoning] ${event.provider}/${event.model} rejected effort '${event.effort}'.`,
    }),
    onReasoningResolved: event => {
      if (event.fallbacks.length === 0 && (event.requestedEffort === 'auto' || event.requestedEffort === event.sentEffort)) return;
      const sent = event.sentEffort === undefined ? 'sent without an effort parameter' : `sent effort '${event.sentEffort}'`;
      append({ id: `reasoning:${event.providerRequestId ?? 'legacy'}:resolved:${event.provider}:${event.model}`,
        type: 'info', text: `[Reasoning] ${event.provider}/${event.model} ${sent} (requested '${event.requestedEffort}'; unverified).` });
    },
    onProviderRecovery: (event, meta) => append(createRecoveryHistoryItem(event), meta),
    onMemoryNotice: (notice) => {
      if (notice.sessionId !== undefined && notice.sessionId !== sessionId) return;
      append({ id: `memory:${notice.episodeId}`, type: 'info', text: `[memory] ${notice.summaries.slice(0, 3).join('; ')}` });
    },
  };
}

function rateLimitNotices(append: AppendNotice): KodaXEvents {
  const pending = new Map<string, { attempt: number; maxAttempts: number; waitMs: number }>();
  const identity = (meta?: KodaXActivityEventMeta): string => JSON.stringify([
    meta?.contextKind, meta?.contextId, meta?.childAgentId,
    meta?.workflowCorrelation?.workflowRunId, meta?.workflowCorrelation?.childAgentId, meta?.providerRequestId,
  ]);
  return {
    onRetryAfter: (event, meta) => {
      pending.set(identity(meta), event);
      const source = event.source === 'exponential-backoff' ? 'no-header → backoff' : event.source;
      const reason = event.reason === 'overloaded' ? 'Overloaded' : 'Rate limited';
      append({ type: 'info', icon: '⏳', text: `[${reason}] (${event.provider}) — retrying in ${Math.round(event.waitMs / 1000)}s [${source}] (${event.attempt}/${event.maxAttempts})` }, meta);
    },
    onProviderRateLimit: (attempt, maxAttempts, delayMs, meta) => {
      const key = identity(meta);
      const previous = pending.get(key);
      pending.delete(key);
      if (previous?.attempt === attempt && previous.maxAttempts === maxAttempts && previous.waitMs === delayMs) return;
      append({ type: 'info', icon: '⏳', text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...` }, meta);
    },
  };
}

function compactionNotices(append: (notice: DisplayNotice) => void): KodaXEvents {
  let tokensBefore: number | undefined;
  return {
    onCompactStats: (info) => { tokensBefore = info.tokensBefore; },
    onCompact: (estimatedTokens) => {
      append({ type: 'info', icon: '✨', text: `Context auto-compacted (was ~${Math.round((tokensBefore ?? estimatedTokens) / 1000)}k tokens)` });
      tokensBefore = undefined;
    },
    onCompactEnd: () => { tokensBefore = undefined; },
  };
}
