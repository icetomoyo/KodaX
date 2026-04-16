/**
 * KodaX Cost Tracker - Immutable session cost tracking
 *
 * 成本追踪器 - 不可变的会话成本追踪
 * 使用 Immutable 模式，每次操作都返回新对象而不修改原有对象
 */

import { type CostRate, calculateCost, getCostRate } from './cost-rates.js';

export interface TokenUsageRecord {
  readonly timestamp: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cost: number;
  readonly role?: string;
}

export interface ProviderCostSummary {
  readonly cost: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SessionCostSummary {
  readonly totalCost: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheTokens: number;
  readonly callCount: number;
  readonly byProvider: Readonly<Record<string, ProviderCostSummary>>;
  readonly byRole: Readonly<Record<string, ProviderCostSummary>>;
}

export interface CostTracker {
  readonly records: readonly TokenUsageRecord[];
}

export function createCostTracker(): CostTracker {
  return { records: [] };
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
    readonly role?: string;
  },
  userCostOverrides?: Readonly<Record<string, Readonly<Record<string, CostRate>>>>,
): CostTracker {
  const rate = getCostRate(entry.provider, entry.model, userCostOverrides);
  const cacheTokens = (entry.cacheReadTokens ?? 0) + (entry.cacheWriteTokens ?? 0);
  const cost = rate ? calculateCost(rate, entry.inputTokens, entry.outputTokens, cacheTokens) : 0;

  const record: TokenUsageRecord = {
    timestamp: Date.now(),
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    cost,
    role: entry.role,
  };

  return { records: [...tracker.records, record] };
}

export function getSummary(tracker: CostTracker): SessionCostSummary {
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;
  const byProvider: Record<string, ProviderCostSummary> = {};
  const byRole: Record<string, ProviderCostSummary> = {};

  for (const r of tracker.records) {
    totalCost += r.cost;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheTokens += r.cacheReadTokens + r.cacheWriteTokens;

    // Aggregate by provider
    const prev = byProvider[r.provider];
    byProvider[r.provider] = {
      cost: (prev?.cost ?? 0) + r.cost,
      calls: (prev?.calls ?? 0) + 1,
      inputTokens: (prev?.inputTokens ?? 0) + r.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + r.outputTokens,
    };

    // Aggregate by role
    const roleKey = r.role ?? 'default';
    const prevRole = byRole[roleKey];
    byRole[roleKey] = {
      cost: (prevRole?.cost ?? 0) + r.cost,
      calls: (prevRole?.calls ?? 0) + 1,
      inputTokens: (prevRole?.inputTokens ?? 0) + r.inputTokens,
      outputTokens: (prevRole?.outputTokens ?? 0) + r.outputTokens,
    };
  }

  return {
    totalCost,
    totalInputTokens,
    totalOutputTokens,
    totalCacheTokens,
    callCount: tracker.records.length,
    byProvider,
    byRole,
  };
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCostReport(summary: SessionCostSummary): string {
  const lines: string[] = [];
  lines.push(`Session Cost: ${formatCost(summary.totalCost)} (${summary.callCount} calls)`);
  lines.push(
    `Tokens: ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out`,
  );
  if (summary.totalCacheTokens > 0) {
    lines.push(`Cache: ${summary.totalCacheTokens.toLocaleString()} tokens`);
  }
  lines.push('');

  const providerEntries = Object.entries(summary.byProvider).sort((a, b) => b[1].cost - a[1].cost);
  if (providerEntries.length > 0) {
    lines.push('By Provider:');
    for (const [name, data] of providerEntries) {
      lines.push(
        `  ${name}: ${formatCost(data.cost)} (${data.calls} calls, ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out)`,
      );
    }
    lines.push('');
  }

  const roleEntries = Object.entries(summary.byRole).sort((a, b) => b[1].cost - a[1].cost);
  if (roleEntries.length > 1) {
    lines.push('By Role:');
    for (const [name, data] of roleEntries) {
      lines.push(`  ${name}: ${formatCost(data.cost)} (${data.calls} calls)`);
    }
  }

  return lines.join('\n');
}
