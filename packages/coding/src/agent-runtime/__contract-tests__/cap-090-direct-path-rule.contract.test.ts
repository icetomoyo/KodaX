/**
 * Contract test for CAP-090: SA-path task-family prompt overlay (direct path rules)
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-090-sa-path-task-family-prompt-overlay-direct-path-rules
 *
 * Test obligations:
 * - CAP-DIRECT-PATH-RULE-001: review task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-002: lookup task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-003: planning task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-004: investigation task family produces correct overlay
 * - CAP-DIRECT-PATH-RULE-005: undefined family appends nothing
 * - CAP-DIRECT-PATH-RULE-006: AMA agents do not invoke
 *
 * Risk: MEDIUM
 *
 * Class: 1
 *
 * Verified location: task-engine.ts:buildDirectPathTaskFamilyPromptOverlay
 * (exported during FEATURE_100 P3.6g for contract activation; the
 * post-substrate target `agent-runtime/direct-path-rules.ts` is
 * deferred to the substrate-executor migration phase).
 *
 * Time-ordering constraint: BEFORE runKodaX invocation; merged with
 * caller's promptOverlay via `\n\n` join.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.6g. CAP-DIRECT-PATH-RULE-006
 * activated in FEATURE_100 P3.6t — the negative invariant (AMA path
 * doesn't apply the SA direct-path overlay) is now testable through
 * the `dispatchManagedTask({ runSA, runAMA, … })` DI boundary.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildDirectPathTaskFamilyPromptOverlay,
  dispatchManagedTask,
} from '../../task-engine.js';
import type { KodaXOptions, KodaXResult } from '../../types.js';

describe('CAP-090: SA-path task-family prompt overlay (direct path rules) contract', () => {
  it('CAP-DIRECT-PATH-RULE-001: review task family produces a "[Direct Path Rule]" overlay with the review instruction', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay('review', []);
    expect(overlay).toContain('[Direct Path Rule]');
    expect(overlay).toContain('Return a review report, not a plan');
    expect(overlay).toContain('Findings first');
  });

  it('CAP-DIRECT-PATH-RULE-002: lookup task family produces a "[Direct Path Rule]" overlay with the lookup instruction', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay('lookup', []);
    expect(overlay).toContain('[Direct Path Rule]');
    expect(overlay).toContain('Return a concise factual answer');
    expect(overlay).toContain('relevant file path');
  });

  it('CAP-DIRECT-PATH-RULE-003: planning task family produces a "[Direct Path Rule]" overlay with the planning instruction', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay('planning', []);
    expect(overlay).toContain('[Direct Path Rule]');
    expect(overlay).toContain('Return a concrete plan, not an implementation report');
  });

  it('CAP-DIRECT-PATH-RULE-004: investigation task family produces a "[Direct Path Rule]" overlay with the investigation instruction', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay('investigation', []);
    expect(overlay).toContain('[Direct Path Rule]');
    expect(overlay).toContain('Return diagnosis, evidence, and next steps');
  });

  it('CAP-DIRECT-PATH-RULE-005: undefined task family results in no rule being appended (sections-only output)', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay(undefined, ['caller-section']);
    expect(overlay).toBe('caller-section');
    // No "[Direct Path Rule]" prefix added when family is undefined.
    expect(overlay).not.toContain('[Direct Path Rule]');
  });

  it('CAP-DIRECT-PATH-RULE-005b: undefined family with no caller sections produces an empty overlay', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay(undefined, []);
    expect(overlay).toBe('');
  });

  it('CAP-DIRECT-PATH-RULE-005c: caller sections are joined with \\n\\n and prepended before the family rule', () => {
    const overlay = buildDirectPathTaskFamilyPromptOverlay('review', ['first-section', 'second-section']);
    expect(overlay.startsWith('first-section\n\nsecond-section\n\n[Direct Path Rule]')).toBe(true);
  });

  it('CAP-DIRECT-PATH-RULE-006: AMA path does NOT inject the SA direct-path overlay into runAMA options', async () => {
    const runSA = vi.fn();
    const runAMA = vi.fn().mockResolvedValue({
      success: true,
      lastText: '',
      messages: [],
      sessionId: 's',
    } as KodaXResult);
    const buildPlan = vi.fn().mockResolvedValue({
      mode: 'off',
      depth: 'off',
      decision: {},
      promptOverlay: '',
    });

    await dispatchManagedTask(
      {
        agentMode: 'ama',
        // Original caller-supplied overlay should pass through, but
        // NOT have a "[Direct Path Rule]" appended.
        context: { promptOverlay: 'caller-only' },
      } as KodaXOptions,
      'review the auth module',
      { runSA, runAMA, buildPlan },
    );

    expect(runSA).not.toHaveBeenCalled();
    expect(runAMA).toHaveBeenCalledTimes(1);
    const [optsToAMA] = runAMA.mock.calls[0]!;
    // The dispatcher passes the original options through to runAMA
    // — promptOverlay is unchanged from caller value.
    expect(optsToAMA.context?.promptOverlay).toBe('caller-only');
    // No "[Direct Path Rule]" leaked into the AMA branch.
    expect(optsToAMA.context?.promptOverlay).not.toContain('[Direct Path Rule]');
  });

  it('CAP-DIRECT-PATH-RULE-006b: SA path DOES inject the direct-path overlay into runSA options', async () => {
    const runSA = vi.fn().mockResolvedValue({
      success: true,
      lastText: '',
      messages: [],
      sessionId: 's',
    } as KodaXResult);
    const runAMA = vi.fn();
    const buildPlan = vi.fn();

    await dispatchManagedTask(
      {
        agentMode: 'sa',
        context: { promptOverlay: 'caller-section' },
      } as KodaXOptions,
      // A "review" task family triggers the review-specific direct-path rule.
      'review the diff for issues',
      { runSA, runAMA, buildPlan },
    );

    expect(runSA).toHaveBeenCalledTimes(1);
    const [optsToSA] = runSA.mock.calls[0]!;
    expect(optsToSA.context?.promptOverlay).toContain('caller-section');
    expect(optsToSA.context?.promptOverlay).toContain('[Direct Path Rule]');
  });
});
