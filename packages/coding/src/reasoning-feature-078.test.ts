/**
 * FEATURE_078 contract tests — Role-Aware Reasoning Profiles (effort-native).
 *
 * Covers:
 *   - `resolveRoleEffort` L1 (user ceiling) / L2 (agent profile default+max)
 *     interaction matrix
 *   - `clampEffort` and `compareEfforts` invariants
 *   - Backward-compat: callers with no profile collapse to the user ceiling
 *
 * Reasoning single-tracking replaced the legacy reasoning-mode chain
 * (`resolveRoleReasoning` / `clampReasoningMode` / `compareReasoningModes`)
 * with effort-native helpers. The Agent declaration's `reasoning` profile is
 * still expressed in legacy modes (`AgentReasoningProfile`), so the resolver
 * maps its `default`/`max` onto the effort ladder. FEATURE_193 retired the
 * Scout hint (L3) and the per-role split.
 */

import { describe, expect, it } from 'vitest';
import type { AgentReasoningProfile } from '@kodax-ai/agent';

import {
  clampEffort,
  compareEfforts,
  resolveRoleEffort,
} from './reasoning.js';

// ---------------------------------------------------------------------------
// L0 invariants — comparator + clamp building blocks
// ---------------------------------------------------------------------------

describe('compareEfforts', () => {
  it('retains the medium policy rank for custom efforts without reading object prototype keys', () => {
    expect(compareEfforts('custom-effort', 'medium')).toBe(0);
    expect(compareEfforts('constructor', 'high')).toBe(-1);
  });
  it('orders the canonical ladder: none < auto < low < medium < high < xhigh < max', () => {
    expect(compareEfforts('none', 'auto')).toBe(-1);
    expect(compareEfforts('auto', 'low')).toBe(-1);
    expect(compareEfforts('low', 'medium')).toBe(-1);
    expect(compareEfforts('medium', 'high')).toBe(-1);
    expect(compareEfforts('high', 'xhigh')).toBe(-1);
    expect(compareEfforts('xhigh', 'max')).toBe(-1);
  });

  it('returns 0 for equal efforts', () => {
    expect(compareEfforts('medium', 'medium')).toBe(0);
    expect(compareEfforts('none', 'none')).toBe(0);
  });

  it('is antisymmetric', () => {
    const efforts = ['none', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
    for (const a of efforts) {
      for (const b of efforts) {
        const ab = compareEfforts(a, b);
        const ba = compareEfforts(b, a);
        if (ab === 0) expect(ba).toBe(0);
        else expect(ab).toBe(-ba);
      }
    }
  });
});

describe('clampEffort', () => {
  it('passes through when effort <= ceiling', () => {
    expect(clampEffort('low', 'medium')).toBe('low');
    expect(clampEffort('medium', 'medium')).toBe('medium');
    expect(clampEffort('none', 'high')).toBe('none');
  });

  it('clamps when effort > ceiling', () => {
    expect(clampEffort('high', 'medium')).toBe('medium');
    expect(clampEffort('medium', 'low')).toBe('low');
    expect(clampEffort('high', 'none')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// L1-L2 resolution chain
// ---------------------------------------------------------------------------

// Agent profiles are still expressed in legacy reasoning modes; the resolver
// maps default/max onto the effort ladder (quick→low, balanced→medium, deep→high).
const SCOUT_PROFILE: AgentReasoningProfile = {
  default: 'quick',
  max: 'balanced',
  escalateOnRevise: false,
};
const SA_PROFILE: AgentReasoningProfile = {
  default: 'balanced',
  max: 'deep',
  escalateOnRevise: true,
};

describe('resolveRoleEffort — L1 hard kill switch', () => {
  it('userCeiling=none short-circuits regardless of profile', () => {
    expect(resolveRoleEffort('none', SA_PROFILE)).toBe('none');
    expect(resolveRoleEffort('none', SCOUT_PROFILE)).toBe('none');
  });
});

describe('resolveRoleEffort — backward compat (no profile)', () => {
  it('accepts native specialist efforts without mapping them through retired mode names', () => {
    expect(resolveRoleEffort('max', { default: 'xhigh', max: 'max' })).toBe('xhigh');
    expect(resolveRoleEffort('high', { default: 'max', max: 'max' })).toBe('high');
    expect(resolveRoleEffort('max', { default: 'auto' })).toBe('auto');
  });
  it('collapses to userCeiling when no profile is supplied', () => {
    expect(resolveRoleEffort('medium')).toBe('medium');
    expect(resolveRoleEffort('high')).toBe('high');
    expect(resolveRoleEffort('low')).toBe('low');
    expect(resolveRoleEffort('auto')).toBe('auto');
  });
});

describe('resolveRoleEffort — L2 (Agent profile default) under permissive ceiling', () => {
  it('with high ceiling, the role lands at its declared default (mapped)', () => {
    // SCOUT default quick → low
    expect(resolveRoleEffort('high', SCOUT_PROFILE)).toBe('low');
    // SA default balanced → medium
    expect(resolveRoleEffort('high', SA_PROFILE)).toBe('medium');
  });
});

describe('resolveRoleEffort — L1 ceiling clamps L2 default', () => {
  it('caps higher L2 default at lower L1 ceiling', () => {
    // SA default balanced→medium, but user said effort low → low.
    expect(resolveRoleEffort('low', SA_PROFILE)).toBe('low');
  });

  it('leaves lower L2 default unchanged under higher L1 ceiling', () => {
    // SCOUT default quick→low, user said effort high → low (self-limits).
    expect(resolveRoleEffort('high', SCOUT_PROFILE)).toBe('low');
  });
});
