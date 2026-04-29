/**
 * FEATURE_101 — `boundedRevise` invariant unit tests.
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '@kodax/core';
import type { ObserveCtx } from '@kodax/core';

import { boundedRevise } from './bounded-revise.js';

const manifest = createAgent({ name: 'g', instructions: 'i' });

function obsCtx(): ObserveCtx {
  return {
    manifest,
    mutationTracker: { files: new Set(), totalOps: 0 },
    recorder: {},
  };
}

describe('boundedRevise.observe', () => {
  it('passes non-revise events through', () => {
    expect(
      boundedRevise.observe!(
        { kind: 'tool_call', toolName: 'read' },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('admits revise_count at and below the threshold (3)', () => {
    expect(
      boundedRevise.observe!(
        { kind: 'revise_count', harness: 'H1_EXECUTE_EVAL', count: 1 },
        obsCtx(),
      ).ok,
    ).toBe(true);
    expect(
      boundedRevise.observe!(
        { kind: 'revise_count', harness: 'H1_EXECUTE_EVAL', count: 3 },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('warns when revise_count exceeds the threshold', () => {
    const result = boundedRevise.observe!(
      { kind: 'revise_count', harness: 'H2_PLAN_EXECUTE_EVAL', count: 4 },
      obsCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('warn');
      expect(result.reason).toContain('H2_PLAN_EXECUTE_EVAL');
      expect(result.reason).toContain('4');
    }
  });
});
