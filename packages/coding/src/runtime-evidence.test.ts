import { describe, expect, it } from 'vitest';
import {
  hasNonTransientRuntimeEvidence,
  hasTransientRetryEvidence,
  looksLikeActionableRuntimeEvidence,
} from './runtime-evidence.js';

describe('runtime evidence helpers', () => {
  it('treats timeout-only signals as transient retry evidence', () => {
    expect(hasTransientRetryEvidence('The stream timed out after a delayed response.')).toBe(true);
    expect(hasNonTransientRuntimeEvidence('The stream timed out after a delayed response.')).toBe(false);
    expect(looksLikeActionableRuntimeEvidence('The stream timed out after a delayed response.')).toBe(false);
  });

  it('keeps concrete failures actionable', () => {
    expect(hasTransientRetryEvidence('npm test failed with assertion failed in stderr')).toBe(false);
    expect(hasNonTransientRuntimeEvidence('npm test failed with assertion failed in stderr')).toBe(true);
    expect(looksLikeActionableRuntimeEvidence('Exit code 2 after runtime error in stderr')).toBe(true);
  });
});
