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
 * Verified location: agent.ts:2093-2231 (catch block: error wrap, classify, decide, emit events,
 * execute recovery, sanitize-thinking-and-retry bypass, max-retries throw)
 *
 * Time-ordering constraint: AFTER stream error; BEFORE next attempt or rethrow;
 * sanitize-thinking-and-retry latch persists within turn but resets across turns.
 *
 * STATUS: P1 stub.
 */

import { describe, it } from 'vitest';

// Post-FEATURE_100 import target (uncomment in P2):
// import { executeRecoveryDecision } from '../provider-retry-policy.js';

describe('CAP-069: provider error → recovery decision pipeline contract', () => {
  it.todo('CAP-RECOVERY-001: sanitize_thinking_and_retry action fires at most once per turn (single-shot latch), bypasses max-retries gate, and decrements attempt counter');
  it.todo('CAP-RECOVERY-002: manual_continue recovery action throws the caught error without retrying');
  it.todo('CAP-RECOVERY-003: onProviderRecovery emits full payload (stage/errorClass/attempt/maxAttempts/delayMs/recoveryAction/ladderStep/fallbackUsed/serverRetryAfterMs)');
  it.todo('CAP-RECOVERY-004: when consumer has no onProviderRecovery handler, events.onRetry fires as fallback notification');
});
