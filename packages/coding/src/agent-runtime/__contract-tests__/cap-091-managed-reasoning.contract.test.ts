/**
 * Contract test for CAP-091: AMA-only managed reasoning plan builder
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-091-ama-only-managed-reasoning-plan-builder
 *
 * Test obligations:
 * - CAP-MANAGED-REASONING-001: provider-failure fallback produces non-empty decision
 * - CAP-MANAGED-REASONING-002: recent messages capped at 10
 *
 * Risk: MEDIUM (reasoning-plan failure must NOT abort the AMA run —
 * provider-resolution failure builds a heuristic fallback decision so
 * downstream role prompts still receive the full context envelope)
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
 * STATUS: ACTIVE since FEATURE_100 P3.6h. CAP-MANAGED-REASONING-002
 * activated in FEATURE_100 P3.6t after `extractRecentMessagesForPlan`
 * was lifted out of the inline transform — function-level test no
 * longer needs hoisted vi.mock.
 */

import { describe, expect, it } from 'vitest';

import {
  buildManagedReasoningPlan,
  extractRecentMessagesForPlan,
} from '../../task-engine.js';
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

  it('CAP-MANAGED-REASONING-002a: extractRecentMessagesForPlan returns undefined for missing/empty initialMessages', () => {
    expect(extractRecentMessagesForPlan(undefined)).toBeUndefined();
    expect(extractRecentMessagesForPlan([])).toBeUndefined();
  });

  it('CAP-MANAGED-REASONING-002b: extractRecentMessagesForPlan returns at most the last 10 messages, in order', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    const sliced = extractRecentMessagesForPlan(fifteen);
    expect(sliced).toBeDefined();
    expect(sliced!.length).toBe(10);
    // Last 10 in order: m5..m14
    expect(sliced![0]!.content).toBe('m5');
    expect(sliced![9]!.content).toBe('m14');
  });

  it('CAP-MANAGED-REASONING-002c: when initialMessages.length <= 10, all messages are returned (no slicing artifact)', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({
      role: 'assistant' as const,
      content: `r${i}`,
    }));
    const sliced = extractRecentMessagesForPlan(seven);
    expect(sliced).toBeDefined();
    expect(sliced!.length).toBe(7);
    expect(sliced![0]!.content).toBe('r0');
    expect(sliced![6]!.content).toBe('r6');
  });
});
