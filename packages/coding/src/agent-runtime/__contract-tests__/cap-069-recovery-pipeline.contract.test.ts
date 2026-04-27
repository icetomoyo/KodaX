/**
 * Contract test for CAP-069: provider error → recovery decision pipeline
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-069-provider-error--recovery-decision-pipeline
 *
 * Test obligations:
 * - CAP-RECOVERY-001: sanitize-thinking fires once per turn, bypasses max-retries
 * - CAP-RECOVERY-002: manual_continue action throws the error
 * - CAP-RECOVERY-003: onProviderRecovery emits full decision payload
 * - CAP-RECOVERY-004: onRetry fallback fires when onProviderRecovery not wired
 *
 * Risk: HIGH (recovery decisions affect retry behavior; sanitize-thinking latch is single-shot)
 *
 * Class: 1
 *
 * Verified location: agent-runtime/provider-retry-policy.ts (extracted
 * from agent.ts:886-910 — pre-FEATURE_100 baseline — during FEATURE_100 P3.2e)
 *
 * Time-ordering constraint: AFTER stream error; BEFORE next attempt or rethrow.
 *
 * Active here:
 *   - classifyResilienceError + telemetryClassify run first (in this order)
 *   - decideRecoveryAction + telemetryDecision next (in this order)
 *   - events.onProviderRecovery fires with full payload (always when defined)
 *   - events.onRetry fires ONLY when onProviderRecovery is not defined AND
 *     decision.action !== 'manual_continue'
 *
 * Note: CAP-RECOVERY-001/002 (sanitize-thinking latch + manual-continue throw)
 * pin behaviors at the loop control-flow layer — NOT inside runRecoveryPipeline
 * (which only classifies + decides, never branches on action). The latch
 * lives on the coordinator instance (CAP-065 owns its lifetime), and the
 * manual-continue throw lives in agent.ts catch-block branching. Those two
 * are deferred to agent-level integration tests since they exercise the
 * larger loop, not this isolated step.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.2e (CAP-RECOVERY-003/004 only).
 */

import { describe, expect, it, vi } from 'vitest';

import type { KodaXEvents } from '../../types.js';
import type { ProviderRecoveryCoordinator, RecoveryDecision } from '../../resilience/index.js';
import type { ProviderResilienceConfig } from '../../resilience/types.js';

import { runRecoveryPipeline } from '../provider-retry-policy.js';

function fakeDecision(overrides: Partial<RecoveryDecision> = {}): RecoveryDecision {
  return {
    action: 'fresh_connection_retry',
    ladderStep: 1,
    delayMs: 1500,
    maxDelayMs: 60_000,
    shouldUseNonStreaming: false,
    reasonCode: 'connection_failure',
    failureStage: 'before_first_delta',
    serverRetryAfterMs: undefined,
    ...overrides,
  } as unknown as RecoveryDecision;
}

function fakeCoordinator(decision: RecoveryDecision): ProviderRecoveryCoordinator {
  return {
    decideRecoveryAction: vi.fn().mockReturnValue(decision),
  } as unknown as ProviderRecoveryCoordinator;
}

const fakeCfg: Required<ProviderResilienceConfig> = {
  requestTimeoutMs: 600_000,
  streamIdleTimeoutMs: 60_000,
  maxRetries: 5,
  enableNonStreamingFallback: true,
} as unknown as Required<ProviderResilienceConfig>;

describe('CAP-069: runRecoveryPipeline — onProviderRecovery emission', () => {
  it('CAP-RECOVERY-003a: emits onProviderRecovery with full payload (stage/errorClass/attempt/maxAttempts/delayMs/recoveryAction/ladderStep/fallbackUsed/serverRetryAfterMs)', () => {
    const onProviderRecovery = vi.fn();
    const decision = fakeDecision({
      delayMs: 2500,
      shouldUseNonStreaming: true,
      reasonCode: 'rate_limit',
      ladderStep: 2,
      serverRetryAfterMs: 3000,
    });
    runRecoveryPipeline({
      error: new Error('rate-limited'),
      failureStage: 'before_first_delta',
      attempt: 2,
      events: { onProviderRecovery } as unknown as KodaXEvents,
      resilienceCfg: fakeCfg,
      recoveryCoordinator: fakeCoordinator(decision),
    });

    expect(onProviderRecovery).toHaveBeenCalledOnce();
    const arg = onProviderRecovery.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.stage).toBe('before_first_delta');
    expect(arg.errorClass).toBe('rate_limit');
    expect(arg.attempt).toBe(2);
    expect(arg.maxAttempts).toBe(5);
    expect(arg.delayMs).toBe(2500);
    expect(arg.recoveryAction).toBe('fresh_connection_retry');
    expect(arg.ladderStep).toBe(2);
    expect(arg.fallbackUsed).toBe(true);
    expect(arg.serverRetryAfterMs).toBe(3000);
  });
});

describe('CAP-069: runRecoveryPipeline — onRetry fallback', () => {
  it('CAP-RECOVERY-004a: onRetry fires when onProviderRecovery is undefined AND action !== manual_continue', () => {
    const onRetry = vi.fn();
    runRecoveryPipeline({
      error: new Error('boom'),
      failureStage: 'mid_stream_text',
      attempt: 3,
      events: { onRetry } as unknown as KodaXEvents,
      resilienceCfg: fakeCfg,
      recoveryCoordinator: fakeCoordinator(fakeDecision({ action: 'fresh_connection_retry' })),
    });
    expect(onRetry).toHaveBeenCalledOnce();
    const [message, attemptArg, maxArg] = onRetry.mock.calls[0]!;
    expect(typeof message).toBe('string');
    expect(message).toMatch(/retry 3\/5/);
    expect(attemptArg).toBe(3);
    expect(maxArg).toBe(5);
  });

  it('CAP-RECOVERY-004b: onRetry does NOT fire when onProviderRecovery IS defined (richer event supersedes)', () => {
    const onRetry = vi.fn();
    const onProviderRecovery = vi.fn();
    runRecoveryPipeline({
      error: new Error('boom'),
      failureStage: 'before_first_delta',
      attempt: 1,
      events: { onRetry, onProviderRecovery } as unknown as KodaXEvents,
      resilienceCfg: fakeCfg,
      recoveryCoordinator: fakeCoordinator(fakeDecision()),
    });
    expect(onProviderRecovery).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('CAP-RECOVERY-004c: onRetry does NOT fire when action === manual_continue (terminal decision)', () => {
    const onRetry = vi.fn();
    runRecoveryPipeline({
      error: new Error('boom'),
      failureStage: 'before_first_delta',
      attempt: 1,
      events: { onRetry } as unknown as KodaXEvents,
      resilienceCfg: fakeCfg,
      recoveryCoordinator: fakeCoordinator(fakeDecision({ action: 'manual_continue' })),
    });
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe('CAP-069: runRecoveryPipeline — return shape', () => {
  it('CAP-RECOVERY-RETURN-001: returns { classified, decision } passthrough', () => {
    const decision = fakeDecision({ reasonCode: 'connection_failure' });
    const result = runRecoveryPipeline({
      error: new Error('boom'),
      failureStage: 'before_first_delta',
      attempt: 1,
      events: {} as KodaXEvents,
      resilienceCfg: fakeCfg,
      recoveryCoordinator: fakeCoordinator(decision),
    });
    expect(result.decision).toBe(decision);
    expect(result.classified).toBeDefined();
  });
});
