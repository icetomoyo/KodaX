import type { KodaXEvents } from '@kodax-ai/coding';
import type { ClientViewItem } from '@kodax-ai/coding/client-contract';
import { createRecoveryHistoryItem } from '@kodax-ai/repl';

type DisplayNotice = Pick<ClientViewItem, 'type' | 'text' | 'icon'> & { readonly id?: string };

/** Retained display facts, including ones which begin and end between two view deliveries. */
export function createSessionNoticeEvents(
  sessionId: string,
  append: (notice: DisplayNotice) => void,
): KodaXEvents {
  return {
    ...rateLimitNotices(append),
    ...compactionNotices(append),
    onProviderRecovery: (event) => append(createRecoveryHistoryItem(event)),
    onMemoryNotice: (notice) => {
      if (notice.sessionId !== undefined && notice.sessionId !== sessionId) return;
      append({ id: `memory:${notice.episodeId}`, type: 'info', text: `[memory] ${notice.summaries.slice(0, 3).join('; ')}` });
    },
  };
}

function rateLimitNotices(append: (notice: DisplayNotice) => void): KodaXEvents {
  let pending: { attempt: number; maxAttempts: number; waitMs: number } | undefined;
  return {
    onRetryAfter: (event) => {
      pending = event;
      const source = event.source === 'exponential-backoff' ? 'no-header → backoff' : event.source;
      const reason = event.reason === 'overloaded' ? 'Overloaded' : 'Rate limited';
      append({ type: 'info', icon: '⏳', text: `[${reason}] (${event.provider}) — retrying in ${Math.round(event.waitMs / 1000)}s [${source}] (${event.attempt}/${event.maxAttempts})` });
    },
    onProviderRateLimit: (attempt, maxAttempts, delayMs) => {
      const previous = pending;
      pending = undefined;
      if (previous?.attempt === attempt && previous.maxAttempts === maxAttempts && previous.waitMs === delayMs) return;
      append({ type: 'info', icon: '⏳', text: `[Rate Limit] Retrying in ${delayMs / 1000}s (${attempt}/${maxAttempts})...` });
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
