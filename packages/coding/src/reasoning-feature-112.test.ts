/**
 * FEATURE_112 contract tests — Investigation-Scale-Aware Routing (v0.7.34).
 *
 * Covers Slice 1 only — the deterministic ceiling-derivation matrix. The
 * stochastic Scout behavior eval lives in
 * `tests/feature-112-read-scope-routing.eval.ts` (Layer 2).
 *
 * The Slice 1 contract:
 *   - Mutation surfaces (code/system) → H2 ceiling regardless of other axes.
 *   - Read-only / docs-only + explicit-check assurance → H1 (legacy).
 *   - Read-only / docs-only + complex/systemic complexity → H1 (NEW in v0.7.34).
 *   - Read-only / docs-only + everything else → H0 (legacy default).
 *   - Backward compatibility: omitting complexity collapses to legacy behavior.
 */

import { describe, expect, it } from 'vitest';

import { deriveTopologyCeiling } from './reasoning.js';

describe('deriveTopologyCeiling — Slice 1 matrix', () => {
  // -------------------------------------------------------------------------
  // Mutation surfaces always reach H2; complexity must not change this.
  // -------------------------------------------------------------------------

  it('returns H2 for code mutationSurface regardless of complexity / assurance', () => {
    expect(deriveTopologyCeiling('code', 'default')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('code', 'explicit-check')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('code', 'default', 'simple')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('code', 'default', 'complex')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('code', 'default', 'systemic')).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  it('returns H2 for system mutationSurface regardless of complexity / assurance', () => {
    expect(deriveTopologyCeiling('system', 'default')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('system', 'default', 'systemic')).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  // -------------------------------------------------------------------------
  // Legacy explicit-check path still wins on read-only / docs-only.
  // -------------------------------------------------------------------------

  it('returns H1 when read-only + explicit-check assurance (legacy)', () => {
    expect(deriveTopologyCeiling('read-only', 'explicit-check')).toBe('H1_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('docs-only', 'explicit-check')).toBe('H1_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('read-only', 'explicit-check', 'simple')).toBe('H1_EXECUTE_EVAL');
  });

  // -------------------------------------------------------------------------
  // FEATURE_112 NEW: read-only + complex/systemic → H1.
  // -------------------------------------------------------------------------

  it('returns H1 when read-only + complex complexity (FEATURE_112)', () => {
    expect(deriveTopologyCeiling('read-only', 'default', 'complex')).toBe('H1_EXECUTE_EVAL');
  });

  it('returns H1 when read-only + systemic complexity (FEATURE_112)', () => {
    expect(deriveTopologyCeiling('read-only', 'default', 'systemic')).toBe('H1_EXECUTE_EVAL');
  });

  it('returns H1 when docs-only + complex complexity (FEATURE_112)', () => {
    expect(deriveTopologyCeiling('docs-only', 'default', 'complex')).toBe('H1_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('docs-only', 'default', 'systemic')).toBe('H1_EXECUTE_EVAL');
  });

  // -------------------------------------------------------------------------
  // Read-only with sub-threshold complexity stays at H0 (no false positives).
  // -------------------------------------------------------------------------

  it('returns H0 when read-only + simple complexity', () => {
    expect(deriveTopologyCeiling('read-only', 'default', 'simple')).toBe('H0_DIRECT');
    expect(deriveTopologyCeiling('docs-only', 'default', 'simple')).toBe('H0_DIRECT');
  });

  it('returns H0 when read-only + moderate complexity', () => {
    expect(deriveTopologyCeiling('read-only', 'default', 'moderate')).toBe('H0_DIRECT');
    expect(deriveTopologyCeiling('docs-only', 'default', 'moderate')).toBe('H0_DIRECT');
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: omitting complexity collapses to legacy behavior.
  // -------------------------------------------------------------------------

  it('preserves legacy behavior when complexity is omitted', () => {
    // Legacy: read-only + default → H0
    expect(deriveTopologyCeiling('read-only', 'default')).toBe('H0_DIRECT');
    expect(deriveTopologyCeiling('docs-only', 'default')).toBe('H0_DIRECT');
    // Legacy: read-only + explicit-check → H1
    expect(deriveTopologyCeiling('read-only', 'explicit-check')).toBe('H1_EXECUTE_EVAL');
    // Legacy: mutation surfaces → H2
    expect(deriveTopologyCeiling('code', 'default')).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(deriveTopologyCeiling('system', 'default')).toBe('H2_PLAN_EXECUTE_EVAL');
  });
});
