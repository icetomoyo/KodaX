/**
 * KodaX Cost Tracker - Immutable session cost tracking
 *
 * 成本追踪器 - 不可变的会话成本追踪
 * 使用 Immutable 模式，每次操作都返回新对象而不修改原有对象
 */

import { type CostRate, calculateCostWithCacheLifetimes, getCostRate, getCostRateBasis } from './cost-rates.js';
import type { KodaXCacheWriteUsage } from './types.js';

export type CostBasis = 'estimate' | 'nominal' | 'mixed' | 'unknown';

export interface TokenUsageRecord {
  readonly cacheWriteTokensByTtl?: Readonly<KodaXCacheWriteUsage>;
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number | null;
  readonly costBasis?: Exclude<CostBasis, 'mixed'>;
  readonly role?: string;
}

export interface ProviderCostSummary {
  readonly cost: number | null;
  readonly knownCostSubtotal?: number;
  readonly unknownCostCalls?: number;
  readonly nominalCostCalls?: number;
  readonly costBasis?: CostBasis;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * FEATURE_130 (v0.7.36) — per-retry record. Captures the wait the
 * provider asked us to take so `/cost` can report "X retries, Ys total
 * wait" alongside the token cost. Lives in the same tracker as token
 * records to keep one source of truth for the session.
 */
export interface RetryRecord {
  readonly timestamp: number;
  readonly provider: string;
  readonly waitMs: number;
  readonly reason: 'rate-limit' | 'overloaded';
  readonly source:
    | 'retry-after-seconds'
    | 'retry-after-date'
    | 'retry-after-ms'
    | 'exponential-backoff';
}

export interface SessionCostSummary {
  readonly totalCost: number | null;
  readonly knownCostSubtotal?: number;
  readonly unknownCostCalls?: number;
  readonly nominalCostCalls?: number;
  readonly costBasis?: CostBasis;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheTokens: number;
  /** FEATURE_116 (v0.7.37): cumulative cache-read input tokens across the
   * session. Splits `totalCacheTokens` into the read half so the hit rate
   * (`cacheHitRate = totalCacheReadTokens / totalCacheTokens`) is
   * derivable for `/cost` reporting. */
  readonly totalCacheReadTokens: number;
  /** FEATURE_116 (v0.7.37): cumulative cache-write (creation) input tokens. */
  readonly totalCacheWriteTokens: number;
  /** FEATURE_116 (v0.7.37): cache-read share of all cache tokens this
   * session, in [0, 1]. Computed as `totalCacheReadTokens /
   * (totalCacheReadTokens + totalCacheWriteTokens)`. Returns 0 when no
   * cache activity has been recorded — a session with zero cache
   * activity is not "0% hit rate", just untracked. */
  readonly cacheHitRate: number;
  readonly callCount: number;
  /** FEATURE_130: total retries triggered across the session. */
  readonly retryCount: number;
  /** FEATURE_130: cumulative milliseconds spent in retry-after sleeps. */
  readonly retryWaitMs: number;
  readonly byProvider: Readonly<Record<string, ProviderCostSummary>>;
  readonly byRole: Readonly<Record<string, ProviderCostSummary>>;
}

export interface CostTracker {
  readonly records: readonly TokenUsageRecord[];
  /** FEATURE_130 (v0.7.36): retry-wait records, append-only and immutable. */
  readonly retries: readonly RetryRecord[];
}

export function createCostTracker(): CostTracker {
  return { records: [], retries: [] };
}

/**
 * FEATURE_130 (v0.7.36): record a retry-after wait. The InkREPL spinner
 * (or any other consumer of `KodaXEvents.onRetryAfter`) calls this so
 * `/cost` can surface accurate session-wide retry telemetry.
 */
export function recordRetry(
  tracker: CostTracker,
  entry: {
    readonly provider: string;
    readonly waitMs: number;
    readonly reason: 'rate-limit' | 'overloaded';
    readonly source:
      | 'retry-after-seconds'
      | 'retry-after-date'
      | 'retry-after-ms'
      | 'exponential-backoff';
  },
): CostTracker {
  const record: RetryRecord = {
    timestamp: Date.now(),
    provider: entry.provider,
    waitMs: entry.waitMs,
    reason: entry.reason,
    source: entry.source,
  };
  return { records: tracker.records, retries: [...tracker.retries, record] };
}

export function recordUsage(
  tracker: CostTracker,
  entry: {
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cacheWriteTokensByTtl?: Readonly<KodaXCacheWriteUsage>;
    readonly role?: string;
  },
  userCostOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>,
): CostTracker {
  const rate = getCostRate(entry.provider, entry.model, userCostOverrides);
  const cost = rate
    ? calculateCostWithCacheLifetimes(
        rate,
        entry.inputTokens,
        entry.outputTokens,
        entry.cacheReadTokens ?? 0,
        entry.cacheWriteTokens ?? 0,
        entry.cacheWriteTokensByTtl,
      )
    : null;

  const knownCost = cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null;
  const record: TokenUsageRecord = {
    timestamp: Date.now(),
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    ...(entry.cacheWriteTokensByTtl ? { cacheWriteTokensByTtl: { ...entry.cacheWriteTokensByTtl } } : {}),
    cost: knownCost,
    costBasis: knownCost === null ? 'unknown' : getCostRateBasis(entry.provider, entry.model, userCostOverrides),
    role: entry.role,
  };

  return { records: [...tracker.records, record], retries: tracker.retries };
}

export function getSummary(tracker: CostTracker): SessionCostSummary {
  let knownCostSubtotal = 0;
  let unknownCostCalls = 0;
  let nominalCostCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  const byProvider: Record<string, ProviderCostSummary> = {};
  const byRole: Record<string, ProviderCostSummary> = {};

  for (const r of tracker.records) {
    if (r.cost === null) unknownCostCalls++;
    else knownCostSubtotal += r.cost;
    if (r.costBasis === 'nominal') nominalCostCalls++;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheTokens += r.cacheReadTokens + r.cacheWriteTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    totalCacheWriteTokens += r.cacheWriteTokens;

    byProvider[r.provider] = aggregateCost(byProvider[r.provider], r);
    const roleKey = r.role ?? 'default';
    byRole[roleKey] = aggregateCost(byRole[roleKey], r);
  }

  let retryWaitMs = 0;
  for (const r of tracker.retries) {
    retryWaitMs += r.waitMs;
  }

  // FEATURE_116 (v0.7.37): cache hit rate = read / (read + write).
  // Defined to 0 when no cache activity has been observed (avoids 0/0
  // NaN; an empty session reports 0% rather than a bogus 100%).
  const cacheHitRate = totalCacheTokens > 0
    ? totalCacheReadTokens / totalCacheTokens
    : 0;

  return {
    totalCost: unknownCostCalls ? null : knownCostSubtotal,
    knownCostSubtotal,
    unknownCostCalls,
    nominalCostCalls,
    costBasis: summaryBasis(tracker.records.length, unknownCostCalls, nominalCostCalls),
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    cacheHitRate,
    callCount: tracker.records.length,
    retryCount: tracker.retries.length,
    retryWaitMs,
    byProvider,
    byRole,
  };
}

function aggregateCost(previous: ProviderCostSummary | undefined, record: TokenUsageRecord): ProviderCostSummary {
  const knownCostSubtotal = (previous?.knownCostSubtotal ?? previous?.cost ?? 0) + (record.cost ?? 0);
  const unknownCostCalls = (previous?.unknownCostCalls ?? 0) + (record.cost === null ? 1 : 0);
  const nominalCostCalls = (previous?.nominalCostCalls ?? 0) + (record.costBasis === 'nominal' ? 1 : 0);
  return { cost: unknownCostCalls ? null : knownCostSubtotal, knownCostSubtotal, unknownCostCalls, nominalCostCalls,
    costBasis: summaryBasis((previous?.calls ?? 0) + 1, unknownCostCalls, nominalCostCalls),
    calls: (previous?.calls ?? 0) + 1, inputTokens: (previous?.inputTokens ?? 0) + record.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + record.outputTokens };
}
function summaryBasis(calls: number, unknown: number, nominal: number): CostBasis {
  return unknown ? 'unknown' : nominal === 0 ? 'estimate' : nominal === calls ? 'nominal' : 'mixed';
}

export function formatCost(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return 'unknown';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCostReport(summary: SessionCostSummary): string {
  const lines: string[] = [];
  const label = summary.nominalCostCalls ? 'Session Cost (nominal estimate)' : 'Session Cost';
  lines.push(`${label}: ${formatCost(summary.totalCost)} (${summary.callCount} calls)`);
  if (summary.unknownCostCalls && summary.knownCostSubtotal !== undefined) {
    lines.push(`Known estimate subtotal: ${formatCost(summary.knownCostSubtotal)}; ${summary.unknownCostCalls} unpriced calls`);
  }
  lines.push(
    `Tokens: ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`,
  );
  if (summary.totalCacheTokens > 0) {
    // FEATURE_116 (v0.7.37): break the cache total into read / write and
    // surface hit rate so users can see prompt caching saving them money.
    const hitPct = (summary.cacheHitRate * 100).toFixed(0);
    lines.push(
      `Cache: ${summary.totalCacheTokens.toLocaleString()} tokens (`
        + `${summary.totalCacheReadTokens.toLocaleString()} read / `
        + `${summary.totalCacheWriteTokens.toLocaleString()} write, `
        + `${hitPct}% hit rate)`,
    );
  }
  if (summary.retryCount > 0) {
    const seconds = (summary.retryWaitMs / 1000).toFixed(1);
    lines.push(`Retries: ${summary.retryCount} (${seconds}s total wait)`);
  }
  lines.push('');

  const providerEntries = Object.entries(summary.byProvider).sort((a, b) => (b[1].knownCostSubtotal ?? b[1].cost ?? 0) - (a[1].knownCostSubtotal ?? a[1].cost ?? 0));
  if (providerEntries.length > 0) {
    lines.push('By Provider:');
    for (const [name, data] of providerEntries) {
      lines.push(
        `  ${name}: ${formatCost(data.cost)} (${data.calls} calls, ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out)`,
      );
    }
    lines.push('');
  }

  const roleEntries = Object.entries(summary.byRole).sort((a, b) => (b[1].knownCostSubtotal ?? b[1].cost ?? 0) - (a[1].knownCostSubtotal ?? a[1].cost ?? 0));
  if (roleEntries.length > 1) {
    lines.push('By Role:');
    for (const [name, data] of roleEntries) {
      lines.push(`  ${name}: ${formatCost(data.cost)} (${data.calls} calls)`);
    }
  }

  return lines.join('\n');
}
