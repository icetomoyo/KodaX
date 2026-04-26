/**
 * Contract test for CAP-018: post-tool judge
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-018-post-tool-judge
 *
 * Test obligations:
 * - CAP-POST-TOOL-JUDGE-001: strong failure evidence triggers reroute
 * - CAP-POST-TOOL-JUDGE-002: weak / no evidence does not trigger
 *
 * Class: 3 — declarable opt-in middleware. Default for `defaultCodingAgent`
 * AND `generatorAgent` (per FEATURE_100 §设计 — give Generator
 * mid-iteration adaptive recovery).
 *
 * The post-tool judge in P2 lives as a CALL-SITE gating block in agent.ts
 * (around line 2080) — `if (mode === 'auto' && !postToolJudgeConsumed &&
 * hasStrongToolFailureEvidence(toolEvidence)) { ... }`. The substrate
 * executor's judge hook chain in P3 will own the gate; for P2 the contract
 * is the **predicate** that gates it.
 *
 * Active here: `hasStrongToolFailureEvidence` regex matchers — every false
 * positive stalls a happy-path turn, every false negative misses adaptive
 * recovery.
 *
 * Deferred (call-site / latch territory — P3):
 * - CAP-POST-TOOL-JUDGE-003 `postToolJudgeConsumed` latch.
 * - CAP-POST-TOOL-JUDGE-004 generatorAgent declaration enablement.
 *
 * Verified location: agent-runtime/middleware/judges.ts (extracted from
 * agent.ts:1151-1154 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the predicate truth-table.
 */

import { describe, expect, it } from 'vitest';

import { hasStrongToolFailureEvidence } from '../middleware/judges.js';

describe('CAP-018: post-tool judge contract', () => {
  it('CAP-POST-TOOL-JUDGE-001a: tool evidence containing failure-shaped keywords matches (English failure tokens — `\\b`-bounded)', () => {
    for (const evidence of [
      'Test 5 failed: details',
      'Test failure detected in suite',
      'Build error: missing module',
      'Throws an exception when input is null',
      'Traceback (most recent call last)',
      'assert false: expected x to equal y',
      'Test regression detected',
    ]) {
      expect(hasStrongToolFailureEvidence(evidence)).toBe(true);
    }
  });

  it('CAP-POST-TOOL-JUDGE-001b: tool evidence with operational failure tokens matches (timeout / not found / blocked / permission denied / console error)', () => {
    for (const evidence of [
      'request timeout after 30s',
      'file not found',
      'access blocked by permission gate',
      'permission denied',
      'console error: Uncaught TypeError',
    ]) {
      expect(hasStrongToolFailureEvidence(evidence)).toBe(true);
    }
  });

  it('CAP-POST-TOOL-JUDGE-002a: tool evidence with success / weak signals does NOT match', () => {
    for (const evidence of [
      'all tests passed',
      'compilation successful',
      'wrote 5 lines to a.ts',
      'found 3 matches',
      'task complete',
      '',
    ]) {
      expect(hasStrongToolFailureEvidence(evidence)).toBe(false);
    }
  });

  it('CAP-POST-TOOL-JUDGE-001c: word-boundary matching — embedded keywords inside camelCase / kebab identifiers should NOT match (avoids false positives on `errorHandler` / `failureCount` / `testfailure`)', () => {
    // `\b` is between word and non-word; both `r` and `H` in "errorHandler"
    // are word chars so no boundary, no match. Same for "failureCount".
    expect(hasStrongToolFailureEvidence('errorHandler is wired')).toBe(false);
    expect(hasStrongToolFailureEvidence('failureCount = 0')).toBe(false);
    // Substrings inside the middle of a word do NOT match either.
    expect(hasStrongToolFailureEvidence('testfailure')).toBe(false);
    // Hyphenated identifiers — `-` is non-word, so `\b` matches; embedded
    // keywords surrounded by hyphens DO match (acceptable; these read as
    // English-ish prose tokens, not symbol identifiers).
    expect(hasStrongToolFailureEvidence('error-banner shown')).toBe(true);
  });

  it('CAP-POST-TOOL-JUDGE-001d: case-insensitive matching (i flag)', () => {
    expect(hasStrongToolFailureEvidence('FAILED')).toBe(true);
    expect(hasStrongToolFailureEvidence('Error')).toBe(true);
    expect(hasStrongToolFailureEvidence('Exception')).toBe(true);
  });

  it.todo('CAP-POST-TOOL-JUDGE-003: postToolJudgeConsumed latch prevents second invocation in same turn (call-site / P3 substrate)');
  it.todo('CAP-POST-TOOL-JUDGE-004: generatorAgent has middleware.postToolJudge enabled (Agent declaration territory, P3)');
});
