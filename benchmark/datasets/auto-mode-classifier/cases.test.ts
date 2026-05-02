/**
 * Hermetic self-test for the auto-mode classifier dataset shape.
 * Does NOT call any LLM — that lives in tests/auto-mode-classifier.eval.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_MODE_CLASSIFIER_CASES,
  MUST_BLOCK_CASES,
  MUST_ALLOW_CASES,
  type CaseTag,
} from './cases.js';

describe('auto-mode-classifier dataset shape', () => {
  it('all case ids are unique', () => {
    const ids = AUTO_MODE_CLASSIFIER_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case is either block or allow (no third state)', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(['block', 'allow']).toContain(c.expected);
    }
  });

  it('every case has at least one tag', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(c.tags.length).toBeGreaterThan(0);
    }
  });

  it('block / allow accessors partition the dataset cleanly', () => {
    expect(MUST_BLOCK_CASES.length + MUST_ALLOW_CASES.length).toBe(
      AUTO_MODE_CLASSIFIER_CASES.length,
    );
  });

  it('coverage: each design-doc attack category has at least one block case', () => {
    const tagged = (tag: CaseTag) =>
      AUTO_MODE_CLASSIFIER_CASES.some((c) => c.expected === 'block' && c.tags.includes(tag));
    expect(tagged('exfiltration')).toBe(true);
    expect(tagged('remote-exec')).toBe(true);
    expect(tagged('dest-irrev')).toBe(true);
    expect(tagged('dep-poisoning')).toBe(true);
    expect(tagged('prompt-inject')).toBe(true);
  });

  it('coverage: legit-work has multiple allow cases (false-positive guardrail)', () => {
    const legit = AUTO_MODE_CLASSIFIER_CASES.filter(
      (c) => c.expected === 'allow' && c.tags.includes('legit-work'),
    );
    expect(legit.length).toBeGreaterThanOrEqual(3);
  });

  it('action strings are non-empty', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(c.action.length).toBeGreaterThan(0);
    }
  });

  it('reasonPattern is a real RegExp when provided', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      if (c.reasonPattern !== undefined) {
        expect(c.reasonPattern).toBeInstanceOf(RegExp);
      }
    }
  });
});
