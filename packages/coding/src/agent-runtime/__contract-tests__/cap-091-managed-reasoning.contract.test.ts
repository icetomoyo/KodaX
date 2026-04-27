/**
 * Contract test for CAP-091: AMA-only managed reasoning plan builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-091-ama-only-managed-reasoning-plan-builder
 *
 * Test obligations:
 * - CAP-MANAGED-REASONING-001: provider-failure fallback produces non-empty decision
 * - CAP-MANAGED-REASONING-002: recent messages capped at 10
 *
 * Risk: MEDIUM (FEATURE_086 parity restore)
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:buildManagedReasoningPlan (exported
 * during FEATURE_100 P3.6h for contract activation; the post-substrate
 * relocation to `agent-runtime/managed-reasoning-plan.js` is deferred
 * to the substrate-executor migration).
 *
 * Time-ordering constraint: AFTER mode dispatch (CAP-089) decided AMA;
 * BEFORE runManagedTaskViaRunner.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6h.
 */

import { describe, expect, it } from 'vitest';

import { buildManagedReasoningPlan } from '../../task-engine.js';
import type { KodaXOptions } from '../../types.js';

describe('CAP-091: AMA-only managed reasoning plan builder contract', () => {
  it('CAP-MANAGED-REASONING-001: provider resolution failure → fallback ReasoningPlan with non-empty decision (NOT undefined → which would fall back to SCOUT_INSTRUCTIONS_FALLBACK minimal prompt)', async () => {
    // Force `resolveProvider` to throw by passing a provider name that
    // does not exist in any of the built-in / runtime / custom registries.
    const options = {
      provider: '__definitely_not_a_real_provider__',
      // Disable repo-signal loading so the test does not touch the
      // filesystem; the catch path is in the inner try/catch around
      // resolveProvider, not the outer signal-loading block.
      context: { repoIntelligenceMode: 'off' as const },
    } as unknown as KodaXOptions;

    const plan = await buildManagedReasoningPlan(options, 'fix the auth bug');

    // Fallback shape: mode/depth = 'off'; decision is non-empty (NOT
    // the undefined that the legacy path returned, which would force
    // runner-driven.ts to fall back to SCOUT_INSTRUCTIONS_FALLBACK).
    expect(plan.mode).toBe('off');
    expect(plan.depth).toBe('off');
    expect(plan.decision).toBeDefined();
    // The fallback decision is built from `buildFallbackRoutingDecision` and
    // should carry the prompt-derived task family + a non-empty primary task.
    expect(plan.decision).toMatchObject({
      primaryTask: expect.any(String),
    });
    expect(plan.amaControllerDecision).toBeDefined();
    expect(plan.promptOverlay).toBe('');
  });

  it.todo(
    'CAP-MANAGED-REASONING-002: only the last 10 messages from options.session.initialMessages are forwarded as recentMessages to createReasoningPlan — needs hoisted vi.mock against `./reasoning.js` from the SUT side; vi.doMock + dynamic re-import does not re-bind the existing import in task-engine.ts. Activation deferred until the substrate-executor migration extracts buildManagedReasoningPlan into a standalone module that can be unit-tested with explicit DI.',
  );
});
