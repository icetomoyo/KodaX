import { afterEach, expect, it, vi } from 'vitest';
import { getProvider, KodaXRateLimitError } from '@kodax-ai/llm';
import { resetBuiltinProviderCache } from '../../../llm/src/providers/registry.js';
import { classifyResilienceError } from './classifier.js';
import { ProviderRecoveryCoordinator } from './recovery-coordinator.js';
import { StableBoundaryTracker } from './stable-boundary.js';

afterEach(() => {
  resetBuiltinProviderCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([false, true])('keeps HTTP 500 distinct from throttling (singleAttempt=%s)', async (singleAttempt) => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  const fetch = vi.fn(async () => Response.json({ error: { message: 'Internal Server Error' } },
    { status: 500, headers: { 'retry-after-ms': '1' } }));
  vi.stubGlobal('fetch', fetch);
  const error: unknown = await getProvider('openai').complete([], [], '', false, { singleAttempt }).catch((error: unknown) => error);
  expect(fetch).toHaveBeenCalledTimes(singleAttempt ? 1 : 3);
  expect(classifyResilienceError(error as Error)).toMatchObject({ errorClass: 'provider_overloaded', baseRetryDelay: 5000 });
});

it.each([429, 500])('honors explicit no-retry headers across adapter and host (%s)', async (status) => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  const fetch = vi.fn(async () => Response.json({ error: { message: 'Server request rejected' } },
    { status, headers: { 'x-should-retry': 'false', 'retry-after-ms': '1' } }));
  vi.stubGlobal('fetch', fetch);
  const error: unknown = await getProvider('openai').complete([], [], '', false).catch((error: unknown) => error);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(classifyResilienceError(error as Error).retryable).toBe(false);
});

it('keeps Retry-After when a 429 explicitly permits retry', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'Rate limit exceeded' } },
    { status: 429, headers: { 'x-should-retry': 'true', 'retry-after': '3' } }));
  const error: unknown = await getProvider('openai').complete([], [], '', false, { singleAttempt: true }).catch((error: unknown) => error);
  expect(classifyResilienceError(error as Error)).toMatchObject({ errorClass: 'rate_limit', baseRetryDelay: 3000 });
});

it.each([503, 529])('preserves both overloaded retry callbacks for HTTP %s', async (status) => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { message: 'Server overloaded' } }, { status, headers: { 'retry-after-ms': '1' } }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  vi.stubGlobal('fetch', fetch);
  const onRetryAfter = vi.fn();
  const onRateLimit = vi.fn();
  await getProvider('openai').complete([], [], '', false, { onRetryAfter, onRateLimit });
  expect(onRateLimit).toHaveBeenCalledExactlyOnceWith(1, 3, 1);
  expect(onRetryAfter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'overloaded', waitMs: 1 }));
});

it.each([429, 503, 529])('schedules the actual Host retry using normalized Retry-After milliseconds (%s)', async (status) => {
  vi.stubEnv('OPENAI_API_KEY', 'fixture-key');
  vi.stubGlobal('fetch', async () => Response.json({ error: { message: status === 429 ? 'Rate limit exceeded' : 'Server overloaded' } },
    { status, headers: { 'retry-after': '3' } }));
  const error: unknown = await getProvider('openai').complete([], [], '', false, { singleAttempt: true }).catch((error: unknown) => error);
  const coordinator = new ProviderRecoveryCoordinator(new StableBoundaryTracker(), {});
  const decision = coordinator.decideRecoveryAction(error as Error, classifyResilienceError(error as Error), 0);
  expect(decision).toMatchObject({ action: 'fresh_connection_retry', delayMs: 3000 });
});

it('keeps the legacy rate-limit delay in milliseconds when metadata is absent', () => {
  const error = new KodaXRateLimitError('rate limit', 3000);
  const coordinator = new ProviderRecoveryCoordinator(new StableBoundaryTracker(), {});
  expect(coordinator.decideRecoveryAction(error, classifyResilienceError(error), 0).delayMs).toBe(3000);
});

it.each([
  ['anthropic', 'ANTHROPIC_API_KEY', '1308', '已达到 5 小时使用上限，请等待重置。'],
  ['openai', 'OPENAI_API_KEY', 'insufficient_quota', 'You exceeded your current quota.'],
  ['openai', 'OPENAI_API_KEY', 'subscription_sharing_workplace_individual_usage_limit_exceeded', 'Usage limit set by workspace admin.'],
])('%s quota error %s / %s reaches the host without short retries', async (name, env, code, message) => {
  vi.stubEnv(env, 'fixture-key');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { type: code, code, message } }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0', 'x-request-id': 'fixture-request' },
  }));
  vi.stubGlobal('fetch', fetch);
  const onRetryAfter = vi.fn();
  for (const method of ['stream', 'complete'] as const) {
    fetch.mockClear();
    const error: unknown = await getProvider(name)[method]([{ role: 'user', content: 'hello' }], [], '', false,
      { maxOutputTokensOverride: 128, onRetryAfter }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onRetryAfter).not.toHaveBeenCalled();
    expect(error).toMatchObject({ metadata: { httpStatus: 429, upstreamCode: code, retryable: false }, message: expect.stringContaining(message) });
    expect(classifyResilienceError(error as Error)).toMatchObject({ retryable: false, maxRetries: 0 });
  }
});

it.each([
  '429 [1308][已达到 5 小时使用上限]',
  '429 insufficient_quota: check billing details',
  '429 Monthly usage limit reached',
  '402 Insufficient balance',
])('rejects legacy quota errors from third-party providers: %s', (message) => {
  expect(classifyResilienceError(new Error(message))).toMatchObject({ retryable: false, maxRetries: 0 });
});

it.each(['429 Rate limit exceeded', '429 1302 并发数限制', '503 server overloaded', 'Token quota exceeded per minute'])('keeps temporary throttling retryable: %s', (message) => {
  expect(classifyResilienceError(new Error(message)).retryable).toBe(true);
});

it.each(['anthropic', 'openai'])('%s retains bounded connection retries with the adapter as owner', async (name) => {
  vi.stubEnv(name === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY', 'fixture-key');
  const fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
  vi.stubGlobal('fetch', fetch);
  const provider = getProvider(name);
  await expect(provider.complete([{ role: 'user', content: 'hello' }], [], '', false,
    { maxOutputTokensOverride: 128 })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockClear();
  await expect(provider.complete([{ role: 'user', content: 'hello' }], [], '', false,
    { maxOutputTokensOverride: 128, singleAttempt: true })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
