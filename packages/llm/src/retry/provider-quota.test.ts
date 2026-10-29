import { expect, it } from 'vitest';
import { isProviderQuotaError } from './provider-quota.js';

it.each([
  { error: { error: { code: 1308 } } },
  { cause: { type: 'insufficient_quota' } },
  { metadata: { upstreamCode: 'billing_hard_limit_reached' } },
  { message: 'Monthly usage limit reached' },
  { message: 'Weekly usage limit exceeded' },
  { message: 'Insufficient balance' },
  { message: 'Credit balance is too low' },
  { message: 'Out of budget' },
  { message: '余额不足' },
  { message: '已达到 5 小时使用上限' },
  { message: '429 {"code":1308}' },
  { message: 'GoUsageLimitError' },
])('detects account limits without retaining error payloads: %j', (error) => {
  expect(isProviderQuotaError(error)).toBe(true);
});

it.each([null, undefined, '1308', 1308, {}, { code: '13080' },
  { message: '429 rate limit exceeded, retry after 1 second' },
  { message: 'Token quota exceeded per minute' },
  { message: 'Billing service unavailable, HTTP 503' },
  { message: 'request id 1308' }, { message: '{"code":13080}' },
])('does not confuse throttling or unrelated numbers with plan exhaustion: %j', (error) => {
  expect(isProviderQuotaError(error)).toBe(false);
});

it('bounds traversal of cyclic wrapper errors', () => {
  const error = new Error('wrapper');
  error.cause = error;
  expect(isProviderQuotaError(error)).toBe(false);
});
