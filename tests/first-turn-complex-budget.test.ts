import { expect, it } from 'vitest';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import type { ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';

const started: ProviderRequestObservation = {
  requestId: 'physical', logicalRequestId: 'logical', provider: 'fixture', purpose: 'sidecar',
  attempt: 1, boundary: 'physical_attempt', dispatch: 'dispatched', state: 'started', startedAt: '2026-10-20T00:00:00Z',
};
const cancelled = { ...started, state: 'cancelled' as const, partialUsage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } };
const bounded = {
  reservedTokens: 9000, reservedUsd: 0.1, facts: [started, cancelled],
  tools: ['report_stall_judgment'], reasoning: false, outputCap: 1024,
  requestCancelled: true, taskCancelled: false, failed: true,
};

it('charges the complete reservation for a bounded auxiliary cancellation while preserving fail-open', () => {
  expect(settleComplexAttempt(bounded)).toEqual({ chargedTokens: 9000, chargedUsd: 0.1, unknownUsage: true, stop: false, boundedAuxiliaryCancellation: true });
});

it('retains the full reservation for a native operation cancelled before its fetch boundary', () => {
  const pending = { ...started, boundary: 'provider_operation' as const, wireObservation: 'pending' as const, dispatch: 'unknown' as const };
  expect(settleComplexAttempt({ ...bounded, facts: [pending, { ...pending, state: 'cancelled' }] }))
    .toEqual({ chargedTokens: 9000, chargedUsd: 0.1, unknownUsage: true, stop: false, boundedAuxiliaryCancellation: true });
  expect(settleComplexAttempt({ ...bounded, facts: [{ ...pending, wireObservation: 'unavailable', state: 'cancelled' }] }))
    .toMatchObject({ stop: true, boundedAuxiliaryCancellation: false });
  expect(settleComplexAttempt({ ...bounded, facts: [pending, { ...pending, purpose: 'primary', state: 'cancelled' }] }))
    .toMatchObject({ stop: true, boundedAuxiliaryCancellation: false });
});

it.each([
  { tools: ['read'] }, { reasoning: true }, { outputCap: 4096 },
  { taskCancelled: true }, { requestCancelled: false },
  { facts: [started, { ...cancelled, state: 'failed' as const }] },
  { facts: [{ ...started, purpose: 'primary' as const }, { ...cancelled, purpose: 'primary' as const }] },
  { facts: [started, cancelled, { ...started, requestId: 'retry' }] },
  { facts: [] },
])('stops on errors outside the bounded auxiliary cancellation contract: %j', change => {
  expect(settleComplexAttempt({ ...bounded, ...change })).toMatchObject({ stop: true, unknownUsage: true, chargedTokens: 9000, chargedUsd: 0.1 });
});

it('uses valid complete usage only and never treats partial stream progress as a complete bill', () => {
  expect(settleComplexAttempt({ ...bounded, failed: false, requestCancelled: false,
    facts: [started, { ...started, state: 'succeeded', usage: { inputTokens: 100, outputTokens: 2, totalTokens: 102 } }], actualUsd: 0.001,
  })).toMatchObject({ chargedTokens: 102, chargedUsd: 0.001, unknownUsage: false, stop: false });
  expect(settleComplexAttempt({ ...bounded, failed: false, requestCancelled: false,
    facts: [started, { ...started, state: 'succeeded', usage: { inputTokens: 12, outputTokens: Number.NaN, totalTokens: 12 } }], actualUsd: 0.001 }))
    .toMatchObject({ chargedTokens: 9000, chargedUsd: 0.1, unknownUsage: true });
  expect(settleComplexAttempt({ ...bounded, facts: [started, { ...cancelled, usage: cancelled.partialUsage }], actualUsd: 0.001 }))
    .toMatchObject({ chargedTokens: 9000, chargedUsd: 0.1, unknownUsage: true, boundedAuxiliaryCancellation: true });
  expect(settleComplexAttempt({ ...bounded, failed: false, requestCancelled: false,
    facts: [started, { ...started, requestId: 'other-request', state: 'succeeded', usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 } }], actualUsd: 0.001 }))
    .toMatchObject({ chargedTokens: 9000, chargedUsd: 0.1, unknownUsage: true, stop: true });
});
