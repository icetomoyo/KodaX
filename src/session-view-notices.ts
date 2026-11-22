import type { KodaXEvents, KodaXActivityEventMeta } from '@kodax-ai/coding';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createRecoveryHistoryItem } from '@kodax-ai/repl';

/**
 * The icon the Host gives each kind of notice it writes. A v1 item carries the
 * icon, and saved history keeps it, so the icon is how the kind travels until a
 * v2 view names it. The REPL's retry and recovery items use the same icon.
 */
export const NOTICE_ICONS = { retry: '⏳', compaction: '✨' } as const;
export type NoticeKind = keyof typeof NOTICE_ICONS;

/** The kind of a notice the Host wrote; undefined for any other item, such as one with an icon an old client chose. */
export function noticeKind(icon: string | undefined): NoticeKind | undefined {
  return (Object.keys(NOTICE_ICONS) as NoticeKind[]).find(kind => NOTICE_ICONS[kind] === icon);
}

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
    onOutputNotice: (notice, meta) => append({
      id: `output:${meta?.providerRequestId ?? 'legacy'}:${notice.code}`,
      type: 'info', text: '[Model] The provider declined to answer.',
    }, meta),
    onReasoningEffortRejected: event => append({
      id: `reasoning:${event.providerRequestId ?? 'legacy'}:rejected:${event.provider}:${event.model}:${event.effort}`,
      type: 'info', text: `[Reasoning] ${event.provider}/${event.model} rejected effort '${event.effort}'.`,
    }),
    onReasoningResolved: event => {
      // Profile aliases and previously learned rejections are routine wire resolution.
      // Retain the SDK diagnostic, but only interrupt the transcript for a new rejection.
      if (!event.fallbacks.some(fallback => fallback.reason === 'unsupported-effort' || fallback.reason === 'unsupported-parameter')) return;
      const sent = event.sentEffort === undefined ? 'sent without an effort parameter' : `sent effort '${event.sentEffort}'`;
      append({ id: `reasoning:${event.providerRequestId ?? 'legacy'}:resolved:${event.provider}:${event.model}`,
        type: 'info', text: `[Reasoning] ${event.provider}/${event.model} ${sent} (requested '${event.requestedEffort}'; unverified).` });
    },
    onProviderRecovery: (event, meta) => {
      // The CLI's manual_continue prompt names commands no SDK client handles;
      // the failed Run's error item carries the failure instead.
      if (event.recoveryAction === 'manual_continue') return;
      append(createRecoveryHistoryItem(event), meta);
    },
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
      append({ type: 'info', icon: NOTICE_ICONS.retry, text: `[${reason}] (${event.provider}) — retrying in ${Math.round(event.waitMs / 1000)}s [${source}] (${event.attempt}/${event.maxAttempts})` }, meta);
    },
    onProviderRateLimit: (attempt, maxAttempts, delayMs, meta) => {
      const key = identity(meta);
      const previous = pending.get(key);
      pending.delete(key);
      if (previous?.attempt === attempt && previous.maxAttempts === maxAttempts && previous.waitMs === delayMs) return;
      append({ type: 'info', icon: NOTICE_ICONS.retry, text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...` }, meta);
    },
  };
}

function compactionNotices(append: (notice: DisplayNotice) => void): KodaXEvents {
  let tokensBefore: number | undefined;
  return {
    onCompactStats: (info) => { tokensBefore = info.tokensBefore; },
    onCompact: (estimatedTokens) => {
      append({ type: 'info', icon: NOTICE_ICONS.compaction, text: `Context auto-compacted (was ~${Math.round((tokensBefore ?? estimatedTokens) / 1000)}k tokens)` });
      tokensBefore = undefined;
    },
    onCompactEnd: () => { tokensBefore = undefined; },
  };
}
