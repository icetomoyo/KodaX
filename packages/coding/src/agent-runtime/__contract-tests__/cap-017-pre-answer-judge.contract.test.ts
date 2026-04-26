/**
 * Contract test for CAP-017: pre-answer judge
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-017-pre-answer-judge
 *
 * Test obligations:
 * - CAP-PRE-ANSWER-JUDGE-001: review-final-answer trigger fires re-evaluation when criteria met
 *
 * Class: 3 — declarable opt-in middleware. Default for `defaultCodingAgent` only.
 *
 * The pre-answer judge in P2 lives as a CALL-SITE gating block in agent.ts
 * (around line 1734) — `if (mode === 'auto' && !preAnswerJudgeConsumed &&
 * isReviewFinalAnswerCandidate(...)) { ... }`. The substrate executor's
 * judge hook chain in P3 will own the gate; for P2 the contract is the
 * **predicate** that gates it.
 *
 * Active here: `isReviewFinalAnswerCandidate` truth-table (the most subtle
 * piece — it has Chinese / English regex matchers and structured-list
 * detection; regression here would silently stall or over-trigger the
 * pre-answer judge).
 *
 * Deferred (call-site / latch territory — P3):
 * - CAP-PRE-ANSWER-JUDGE-002 `preAnswerJudgeConsumed` latch — lives at
 *   agent.ts call site, not in the predicate.
 * - CAP-PRE-ANSWER-JUDGE-003 non-auto mode skip — same call-site gate.
 *
 * Verified location: agent-runtime/middleware/judges.ts (extracted from
 * agent.ts:1106-1149 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * STATUS: ACTIVE since FEATURE_100 P2 for the predicate truth-table.
 */

import { describe, expect, it } from 'vitest';

import type { ReasoningPlan } from '../../reasoning.js';
import {
  isReviewFinalAnswerCandidate,
  looksLikeReviewProgressUpdate,
} from '../middleware/judges.js';

function reviewPlan(): ReasoningPlan {
  return {
    decision: { primaryTask: 'review' },
  } as unknown as ReasoningPlan;
}

function planWithTask(task: string): ReasoningPlan {
  return {
    decision: { primaryTask: task },
  } as unknown as ReasoningPlan;
}

describe('CAP-017: pre-answer judge contract', () => {
  it('CAP-PRE-ANSWER-JUDGE-001a: non-review primaryTask → predicate returns true unconditionally (review-only short-circuit)', () => {
    expect(isReviewFinalAnswerCandidate('any prompt', planWithTask('edit'), '')).toBe(true);
    expect(isReviewFinalAnswerCandidate('any', planWithTask('plan'), 'short')).toBe(true);
    expect(isReviewFinalAnswerCandidate('x', planWithTask('lookup'), '')).toBe(true);
  });

  it('CAP-PRE-ANSWER-JUDGE-001b: review task + empty lastText → false (no answer to judge yet)', () => {
    expect(isReviewFinalAnswerCandidate('review prompt', reviewPlan(), '')).toBe(false);
    expect(isReviewFinalAnswerCandidate('review prompt', reviewPlan(), '   \n  ')).toBe(false);
  });

  it('CAP-PRE-ANSWER-JUDGE-001c: review task + progress-update prefix → false (mid-reasoning, not final answer)', () => {
    for (const text of [
      'Now let me check the auth module',
      'let me look at this carefully',
      '让我看看这个文件',
      '现在让我深入研究一下',
      '接下来我会继续检查',
    ]) {
      expect(isReviewFinalAnswerCandidate('review prompt', reviewPlan(), text)).toBe(false);
    }
  });

  it('CAP-PRE-ANSWER-JUDGE-001d: review task + long-form text (≥ 600 chars) → true (length-based final-answer signal)', () => {
    const longText = 'x'.repeat(600);
    expect(isReviewFinalAnswerCandidate('review prompt', reviewPlan(), longText)).toBe(true);
  });

  it('CAP-PRE-ANSWER-JUDGE-001e: review task + short text containing review keywords → true (full EN keyword set: "must fix" / "verdict" / "finding" / "final assessment" / "optional improvements")', () => {
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), 'Verdict: ship it.')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), 'Final assessment: looks good.')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), 'Must fix: null pointer in auth.')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), 'Finding: race condition.')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), 'Optional improvements: consider caching.')).toBe(true);
  });

  it('CAP-PRE-ANSWER-JUDGE-001f: review task + short text containing CN review keywords → true', () => {
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '必须修复以下问题')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '评审报告：通过')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '建议优化错误处理')).toBe(true);
  });

  it('CAP-PRE-ANSWER-JUDGE-001g: review task + short text starting with markdown list → true (list shape signals findings)', () => {
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '- bug 1\n- bug 2')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '* item\n* item')).toBe(true);
    expect(isReviewFinalAnswerCandidate('review', reviewPlan(), '1. issue\n2. issue')).toBe(true);
  });

  it('CAP-PRE-ANSWER-JUDGE-001h: review task + bare prose without keywords / list → false (likely mid-reasoning)', () => {
    expect(
      isReviewFinalAnswerCandidate('review prompt', reviewPlan(), 'I will continue inspecting'),
    ).toBe(false);
  });

  it('CAP-PRE-ANSWER-JUDGE-001i: short text but prompt mentions strict-review keywords → true (prompt-driven gate)', () => {
    // Even if lastText has nothing review-shaped, when the user prompt
    // explicitly says "PR review" / "code review" / "must fix", the
    // judge should fire so a stronger pass can be triggered.
    expect(
      isReviewFinalAnswerCandidate('please do a strict review', reviewPlan(), 'looks ok.'),
    ).toBe(true);
    expect(
      isReviewFinalAnswerCandidate('PR review please', reviewPlan(), 'fine.'),
    ).toBe(true);
  });

  it('CAP-PRE-ANSWER-PROGRESS-001: looksLikeReviewProgressUpdate recognises EN/CN progress prefixes (case-insensitive on EN)', () => {
    expect(looksLikeReviewProgressUpdate('Now let me check')).toBe(true);
    expect(looksLikeReviewProgressUpdate('NOW LET ME CHECK')).toBe(true);
    expect(looksLikeReviewProgressUpdate('让我检查一下')).toBe(true);
    expect(looksLikeReviewProgressUpdate('I just finished')).toBe(false);
    expect(looksLikeReviewProgressUpdate('')).toBe(false);
    expect(looksLikeReviewProgressUpdate('   ')).toBe(false);
  });

  it.todo('CAP-PRE-ANSWER-JUDGE-002: preAnswerJudgeConsumed latch prevents second invocation in same turn (call-site / P3 substrate)');
  it.todo('CAP-PRE-ANSWER-JUDGE-003: non-auto reasoning mode → judge skipped (call-site / P3 substrate)');
});
