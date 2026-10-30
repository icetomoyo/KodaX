import type { KodaXCacheWriteUsage, KodaXTokenUsage } from '../types.js';

export function cacheWritePartition(total: number | undefined, counts: Readonly<Record<string, unknown>> | undefined): KodaXCacheWriteUsage | undefined {
  if (counts === undefined || total === undefined) return undefined;
  const entries = Object.entries(counts).filter(([, count]) => count !== undefined);
  if (entries.some(([ttl, count]) => !['5m', '1h', '30m', '12h', 'unknown'].includes(ttl) || typeof count !== 'number' || !Number.isFinite(count) || count < 0)
    || entries.reduce((sum, [, count]) => sum + (count as number), 0) !== total) return { unknown: total };
  return Object.fromEntries(entries) as KodaXCacheWriteUsage;
}
function fields(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Responses and its durable operations share the same additive usage fields. */
export function normalizeResponsesUsage(value: unknown): KodaXTokenUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = fields(value), details = fields(usage.input_tokens_details), output = fields(usage.output_tokens_details);
  const inputTokens = usage.input_tokens, outputTokens = usage.output_tokens;
  const valid = (count: unknown): count is number => typeof count === 'number' && Number.isFinite(count) && count >= 0;
  if (!valid(inputTokens) || !valid(outputTokens)) return undefined;
  const reads = details.cached_tokens, writes = details.cache_write_tokens;
  if ((reads !== undefined && !valid(reads)) || (writes !== undefined && !valid(writes))) return undefined;
  const raw = fields(details.cache_write_tokens_details);
  const byTtl = cacheWritePartition(writes as number | undefined, details.cache_write_tokens_details === undefined ? undefined
    : { '30m': raw.ttl_30m_tokens, '12h': raw.ttl_12h_tokens });
  return { inputTokens, outputTokens, totalTokens: valid(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens,
    ...(reads !== undefined ? { cachedReadTokens: reads as number } : {}), ...(writes !== undefined ? { cachedWriteTokens: writes as number } : {}),
    ...(byTtl ? { cachedWriteTokensByTtl: byTtl } : {}), ...(valid(output.reasoning_tokens) ? { thoughtTokens: output.reasoning_tokens } : {}) };
}
