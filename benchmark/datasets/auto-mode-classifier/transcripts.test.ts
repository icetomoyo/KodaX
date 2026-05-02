/**
 * Hermetic shape test for transcript fixtures — no LLM, no I/O.
 *
 * The fixtures get matrixed against `cases.ts` in the synthetic pilot eval
 * (`tests/auto-mode-classifier.eval.ts`). They must hold a few stable
 * properties so the pilot data is comparable across reruns.
 */

import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_FIXTURES } from './transcripts.js';

describe('transcript fixtures shape', () => {
  it('all fixture ids are unique', () => {
    const ids = TRANSCRIPT_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every fixture has at least one message', () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      expect(f.messages.length).toBeGreaterThan(0);
    }
  });

  it('every fixture starts with a user message (preserves "first user message" anchor in transcript-strip)', () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      expect(f.messages[0]!.role).toBe('user');
    }
  });

  it('the size axis is monotonic — messages count grows with the size band', () => {
    // Count messages — coarse but adequate proxy for "this fixture is bigger".
    // Real token sizing is captured in the pilot output by the provider.
    const sizes = TRANSCRIPT_FIXTURES.map((f) => f.messages.length);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]!);
    }
  });

  it('has exactly the 5 documented size bands', () => {
    const ids = TRANSCRIPT_FIXTURES.map((f) => f.id);
    expect(ids).toEqual(['empty', 'short', 'medium', 'long', 'huge']);
  });
});
