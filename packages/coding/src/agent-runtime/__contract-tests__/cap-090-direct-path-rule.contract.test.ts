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
 * stays `it.todo` because it asserts a NEGATIVE invariant about the AMA
 * path call site, which is integration-level (no exported boundary on
 * the AMA branch to assert against without spinning up the full
 * dispatcher).
 */

import { describe, expect, it } from 'vitest';

import { buildDirectPathTaskFamilyPromptOverlay } from '../../task-engine.js';

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

  it.todo('CAP-DIRECT-PATH-RULE-006: AMA path (agentMode !== "sa") does not call buildDirectPathTaskFamilyPromptOverlay — integration-level, requires dispatcher boundary mocking');
});
