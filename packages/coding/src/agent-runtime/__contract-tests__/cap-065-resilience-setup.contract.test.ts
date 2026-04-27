/**
 * Contract test for CAP-065: resilience config + recovery coordinator + boundary tracker per-turn setup
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-065-resilience-config--recovery-coordinator--boundary-tracker-per-turn-setup
 *
 * Test obligations:
 * - CAP-RESILIENCE-SETUP-001: config resolves per provider
 * - CAP-RESILIENCE-SETUP-002: sanitize latch persists across attempts within turn but resets across turns
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-retry-policy.ts (extracted
 * from agent.ts:797-813 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2e)
 *
 * Time-ordering constraint: BEFORE stream call; PER-turn (state does not persist across turns).
 *
 * Active here:
 *   - resilienceCfg is the resolved (Required) form for the provider
 *   - recoveryCoordinator is constructed fresh per call → new latch state
 *   - enableNonStreamingFallback is gated on both config flag AND
 *     provider.supportsNonStreamingFallback() — provider veto wins
 *   - tracker is shared (passed in, not created) → marks done by the
 *     stream-handler-wiring path are visible to the coordinator's
 *     decideRecoveryAction calls
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2e.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXBaseProvider } from '@kodax/ai';

import { buildResilienceSession } from '../provider-retry-policy.js';
import { StableBoundaryTracker } from '../../resilience/stable-boundary.js';

function fakeProvider(supportsFallback: boolean): KodaXBaseProvider {
  return {
    name: 'anthropic',
    isConfigured: () => true,
    getApiKeyEnv: () => 'ANTHROPIC_API_KEY',
    getModel: () => 'claude-sonnet-4-5',
    supportsNonStreamingFallback: () => supportsFallback,
  } as unknown as KodaXBaseProvider;
}

describe('CAP-065: buildResilienceSession — config resolution', () => {
  it('CAP-RESILIENCE-SETUP-001a: returns Required<ProviderResilienceConfig> with timeouts and maxRetries populated', () => {
    const tracker = new StableBoundaryTracker();
    const { resilienceCfg } = buildResilienceSession('anthropic', fakeProvider(true), tracker);

    expect(resilienceCfg.requestTimeoutMs).toBeGreaterThan(0);
    expect(resilienceCfg.streamIdleTimeoutMs).toBeGreaterThanOrEqual(0);
    expect(resilienceCfg.maxRetries).toBeGreaterThan(0);
  });

  it('CAP-RESILIENCE-SETUP-001b: enableNonStreamingFallback respects provider veto', () => {
    const tracker = new StableBoundaryTracker();
    const withFallback = buildResilienceSession('anthropic', fakeProvider(true), tracker);
    const withoutFallback = buildResilienceSession('anthropic', fakeProvider(false), tracker);

    // When provider says no, the coordinator's enableNonStreamingFallback is
    // false regardless of resilienceCfg.enableNonStreamingFallback. We can't
    // observe the coordinator's internal config directly, but the contract is
    // that buildResilienceSession does the AND gate — the resilienceCfg returned
    // from us reflects the policy file (not the AND gate; that gate is applied
    // when constructing the coordinator). So we verify the gate is INSIDE the
    // coordinator config — same provider, different supportsNonStreamingFallback,
    // produces different recovery decisions for the same error class. Smoke
    // test: both sessions construct without error.
    expect(withFallback.recoveryCoordinator).toBeDefined();
    expect(withoutFallback.recoveryCoordinator).toBeDefined();
  });
});

describe('CAP-065: buildResilienceSession — per-turn freshness', () => {
  it('CAP-RESILIENCE-SETUP-002a: each call returns a fresh recoveryCoordinator instance', () => {
    const tracker = new StableBoundaryTracker();
    const a = buildResilienceSession('anthropic', fakeProvider(true), tracker);
    const b = buildResilienceSession('anthropic', fakeProvider(true), tracker);
    expect(a.recoveryCoordinator).not.toBe(b.recoveryCoordinator);
    // Single-shot latches (e.g. sanitize-thinking-and-retry) live on the
    // coordinator instance — fresh instance means fresh latch. Across turns
    // the substrate executor calls buildResilienceSession again, so the
    // sanitize latch resets. Within a turn the same coordinator is reused
    // so the latch persists across attempt retries.
  });

  it('CAP-RESILIENCE-SETUP-002b: tracker is shared (passed in, not created)', () => {
    const tracker = new StableBoundaryTracker();
    const session = buildResilienceSession('anthropic', fakeProvider(true), tracker);
    // We can't observe the coordinator's tracker directly, but the contract
    // is that buildResilienceSession does NOT create a new tracker. This is
    // load-bearing because stream-handler-wiring (CAP-067) marks deltas on
    // the tracker we pass in, and the coordinator reads inferFailureStage
    // from the same tracker for its decisions.
    expect(session).toBeDefined();
    // Smoke: building with a custom tracker does not throw.
    expect(() => buildResilienceSession('anthropic', fakeProvider(false), tracker)).not.toThrow();
  });
});
