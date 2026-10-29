/** Account/plan exhaustion requires replenishment or a long reset, not short backoff. */
const QUOTA_CODES = new Set([
  '1308', 'insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low',
  'usage_limit_reached', 'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_workplace_individual_usage_limit_exceeded',
  'gousagelimiterror', 'freeusagelimiterror',
]);

export function isProviderQuotaError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== 'object' || depth > 4) return false;
  const record = error as Record<string, unknown>;
  if ([record.code, record.type, record.upstreamCode].some(value =>
    (typeof value === 'string' || typeof value === 'number') && QUOTA_CODES.has(String(value).toLowerCase()))) return true;
  if (typeof record.message === 'string') {
    const message = record.message;
    if (message.toLowerCase().split(/\W+/).some(code => code !== '1308' && QUOTA_CODES.has(code))
      || /(?:\[1308\]|["']?code["']?\s*:\s*["']?1308\b)/i.test(message)
      || /\b(?:monthly|weekly|daily|subscription) usage limit (?:reached|exceeded)\b/i.test(message)
      || /\b(?:insufficient (?:balance|credits)|credit balance (?:is )?too low|out of budget)\b/i.test(message)
      || /余额不足|已达到.{0,20}(?:小时|天|月)使用上限/.test(message)) return true;
  }
  return isProviderQuotaError(record.error, depth + 1)
    || isProviderQuotaError(record.cause, depth + 1)
    || isProviderQuotaError(record.metadata, depth + 1);
}
