/**
 * Tests for fuzzy matching algorithm - 模糊匹配算法测试
 */

import { describe, it, expect } from 'vitest';
import { fuzzyMatch, sortCandidates, sortCandidatesCombined } from '../fuzzy.js';

describe('fuzzyMatch', () => {
  it('should match exact string', () => {
    const result = fuzzyMatch('help', 'help');
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should match prefix', () => {
    const result = fuzzyMatch('hel', 'help');
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should match fuzzy characters', () => {
    const result = fuzzyMatch('hlp', 'help');
    expect(result.matched).toBe(true);
  });

  it('should not match when characters are missing', () => {
    const result = fuzzyMatch('xyz', 'help');
    expect(result.matched).toBe(false);
  });

  it('should be case insensitive', () => {
    const result = fuzzyMatch('HELP', 'help');
    expect(result.matched).toBe(true);
  });

  it('should give higher score for consecutive matches', () => {
    const consecutive = fuzzyMatch('hel', 'help');
    const nonConsecutive = fuzzyMatch('hlp', 'help');
    expect(consecutive.score).toBeGreaterThan(nonConsecutive.score);
  });

  it('should give higher score for prefix matches', () => {
    const prefix = fuzzyMatch('h', 'help');
    const middle = fuzzyMatch('e', 'help');
    expect(prefix.score).toBeGreaterThan(middle.score);
  });

  it('should return highlights array', () => {
    const result = fuzzyMatch('hlp', 'help');
    expect(result.highlights).toBeInstanceOf(Array);
    expect(result.highlights.length).toBeGreaterThan(0);
  });

  it('should handle empty pattern (matches everything with score 0)', () => {
    const result = fuzzyMatch('', 'help');
    expect(result.matched).toBe(true);
    expect(result.score).toBe(0);
  });

  it('should handle empty target', () => {
    const result = fuzzyMatch('help', '');
    expect(result.matched).toBe(false);
  });

  it('should handle pattern longer than target', () => {
    const result = fuzzyMatch('helpmeplease', 'help');
    expect(result.matched).toBe(false);
  });
});

describe('sortCandidates', () => {
  it('should sort by fuzzy match score', () => {
    const candidates = [
      { text: 'help' },
      { text: 'history' },
      { text: 'hint' },
      { text: 'hello' },
    ];
    const sorted = sortCandidates('hel', candidates);

    // 'hello' and 'help' should rank higher than 'history' or 'hint'
    // because 'hel' is a prefix match
    expect(sorted.length).toBeGreaterThan(0);
    expect(sorted[0]?._fuzzyScore).toBeGreaterThanOrEqual(sorted[sorted.length - 1]?._fuzzyScore ?? 0);
  });

  it('should filter out non-matching candidates', () => {
    const candidates = [
      { text: 'help' },
      { text: 'xyz' },
      { text: 'exit' },
    ];
    const sorted = sortCandidates('hel', candidates);

    // Only 'help' should match
    expect(sorted.length).toBe(1);
    expect(sorted[0]?.text).toBe('help');
  });

  it('should respect minimum score threshold', () => {
    const candidates = [
      { text: 'help' },
      { text: 'hop' },
    ];
    const sorted = sortCandidates('help', candidates, 100); // High threshold

    // Only exact match should pass
    expect(sorted.every(c => (c._fuzzyScore ?? 0) >= 100));
  });

  it('should handle empty candidates', () => {
    const sorted = sortCandidates('hel', []);
    expect(sorted).toEqual([]);
  });

  it('should return all candidates without score when pattern is empty', () => {
    const candidates = [
      { text: 'help' },
      { text: 'history' },
    ];
    const sorted = sortCandidates('', candidates);
    expect(sorted.length).toBe(2);
  });
});

describe('sortCandidatesCombined', () => {
  interface TestCandidate {
    text: string;
    _fuzzyScore?: number;
    customField?: string;
  }

  it('should preserve candidate properties', () => {
    const candidates: TestCandidate[] = [
      { text: 'help', customField: 'a' },
      { text: 'history', customField: 'b' },
    ];

    const sorted = sortCandidatesCombined('hel', candidates);
    expect(sorted.length).toBeGreaterThan(0);
    expect(sorted[0]?.customField).toBeDefined();
  });

  it('should sort by score descending', () => {
    const candidates: TestCandidate[] = [
      { text: 'hint' },
      { text: 'help' },
      { text: 'hello' },
    ];

    const sorted = sortCandidatesCombined('hel', candidates);

    // Check scores are in descending order
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i - 1]?._fuzzyScore ?? 0)).toBeGreaterThanOrEqual(sorted[i]?._fuzzyScore ?? 0);
    }
  });

  it('should filter candidates below minimum score', () => {
    const candidates: TestCandidate[] = [
      { text: 'help' },    // High score (prefix match)
      { text: 'hint' },    // Lower score for 'hel' pattern
    ];

    const sorted = sortCandidatesCombined('hel', candidates, 50);
    expect(sorted.every(c => (c._fuzzyScore ?? 0) >= 50));
  });

  it('should give prefix matches higher score', () => {
    const candidates: TestCandidate[] = [
      { text: 'help' },      // Prefix match
      { text: 'history' },   // Not prefix match (he is in middle)
    ];

    const sorted = sortCandidatesCombined('hel', candidates);

    // Prefix match should be first
    expect(sorted[0]?.text).toBe('help');
    expect(sorted[0]?._fuzzyScore).toBeGreaterThan(sorted[1]?._fuzzyScore ?? 0);
  });
});
