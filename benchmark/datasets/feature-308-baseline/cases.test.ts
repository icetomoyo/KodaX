import { describe, expect, it } from 'vitest';

import { FEATURE_308_READ_CASES, FEATURE_308_WRITE_CASES } from './cases.js';

describe('FEATURE_308 case data', () => {
  it('has the eight read cases (r1 c1-c5, r2 c6-c8) and four write probes', () => {
    expect(FEATURE_308_READ_CASES.map((item) => item.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
    expect(FEATURE_308_WRITE_CASES.map((item) => item.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('keeps the decisive detail inside a seed so the Layer-1 hint check is meaningful', () => {
    for (const readCase of FEATURE_308_READ_CASES) {
      expect(readCase.seeds.some((seed) => seed.statement.includes(readCase.decisiveDetail)), readCase.id).toBe(true);
    }
  });

  it('ends every history on an assistant turn because runOneShot appends the user turn', () => {
    for (const readCase of FEATURE_308_READ_CASES.filter((item) => item.history.length > 0)) {
      expect(readCase.history.at(-1)?.role, readCase.id).toBe('assistant');
    }
  });

  it('seeds the Chinese case in Chinese and the rest in English', () => {
    const hasCjk = (text: string): boolean => /[一-鿿]/.test(text);
    for (const readCase of FEATURE_308_READ_CASES) {
      // Scale cases (c6/c7) carry mixed-language distractors; the language is that of the target (last) seed.
      const text = [readCase.seeds.at(-1)!.statement, readCase.userMessage].join(' ');
      expect(hasCjk(text), readCase.id).toBe(readCase.language === 'zh');
    }
  });

  it('gives every write digest fixed identity so inputs are byte-stable', () => {
    for (const writeCase of FEATURE_308_WRITE_CASES) {
      expect(writeCase.digest.createdAt).toBe('2026-11-01T09:00:00.000Z');
      expect(writeCase.digest.id).toBe(`memory-outcome:${writeCase.id}`);
    }
  });
});
