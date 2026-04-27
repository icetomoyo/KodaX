/**
 * FEATURE_078 contract tests — Role-Aware Reasoning Profiles (v0.7.29).
 *
 * Covers:
 *   - `resolveRoleReasoning` L1 (user ceiling) / L2 (agent profile) / L3 (scout hint)
 *     interaction matrix
 *   - `clampReasoningMode` and `compareReasoningModes` invariants
 *   - `escalateThinkingDepth(_, ceiling)` clamping (L4 dynamic escalation)
 *   - Backward-compat: pre-FEATURE_078 callers (no profile, no ceiling, no hint)
 *     get exactly the old single-mode behavior
 *
 * The pre-FEATURE_078 contract was "all roles use the user's mode" (i.e. L1
 * pinned everything). The new contract is "L1 is a ceiling + bias; per-role
 * default is L2; Scout may suggest L3; L4 escalation clamped by L1". Anywhere
 * a role/profile/hint is omitted, the resolver collapses to the legacy answer.
 */

import { describe, expect, it } from 'vitest';
import type { AgentReasoningProfile } from '@kodax/core';

import {
  clampReasoningMode,
  compareReasoningModes,
  escalateThinkingDepth,
  resolveRoleReasoning,
} from './reasoning.js';

// ---------------------------------------------------------------------------
// L0 invariants — comparator + clamp building blocks
// ---------------------------------------------------------------------------

describe('compareReasoningModes', () => {
  it('orders the canonical sequence: off < auto < quick < balanced < deep', () => {
    expect(compareReasoningModes('off', 'auto')).toBe(-1);
    expect(compareReasoningModes('auto', 'quick')).toBe(-1);
    expect(compareReasoningModes('quick', 'balanced')).toBe(-1);
    expect(compareReasoningModes('balanced', 'deep')).toBe(-1);
  });

  it('returns 0 for equal modes', () => {
    expect(compareReasoningModes('balanced', 'balanced')).toBe(0);
    expect(compareReasoningModes('off', 'off')).toBe(0);
  });

  it('is antisymmetric', () => {
    const modes = ['off', 'auto', 'quick', 'balanced', 'deep'] as const;
    for (const a of modes) {
      for (const b of modes) {
        const ab = compareReasoningModes(a, b);
        const ba = compareReasoningModes(b, a);
        if (ab === 0) expect(ba).toBe(0);
        else expect(ab).toBe(-ba);
      }
    }
  });
});

describe('clampReasoningMode', () => {
  it('passes through when mode <= ceiling', () => {
    expect(clampReasoningMode('quick', 'balanced')).toBe('quick');
    expect(clampReasoningMode('balanced', 'balanced')).toBe('balanced');
    expect(clampReasoningMode('off', 'deep')).toBe('off');
  });

  it('clamps when mode > ceiling', () => {
    expect(clampReasoningMode('deep', 'balanced')).toBe('balanced');
    expect(clampReasoningMode('balanced', 'quick')).toBe('quick');
    expect(clampReasoningMode('deep', 'off')).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// L1-L4 resolution chain
// ---------------------------------------------------------------------------

const SCOUT_PROFILE: AgentReasoningProfile = {
  default: 'quick',
  max: 'balanced',
  escalateOnRevise: false,
};
const PLANNER_PROFILE: AgentReasoningProfile = {
  default: 'balanced',
  max: 'deep',
  escalateOnRevise: true,
};
const SA_PROFILE: AgentReasoningProfile = {
  default: 'balanced',
  max: 'deep',
  escalateOnRevise: true,
};

describe('resolveRoleReasoning — L1 hard kill switch', () => {
  it('userCeiling=off short-circuits regardless of profile or hint', () => {
    expect(resolveRoleReasoning('sa', 'off', SA_PROFILE)).toBe('off');
    expect(resolveRoleReasoning('scout', 'off', SCOUT_PROFILE, 'deep')).toBe('off');
    expect(resolveRoleReasoning('planner', 'off', PLANNER_PROFILE, 'balanced')).toBe('off');
  });
});

describe('resolveRoleReasoning — backward compat (no profile, no hint)', () => {
  it('collapses to userCeiling when no profile is supplied', () => {
    expect(resolveRoleReasoning('sa', 'balanced')).toBe('balanced');
    expect(resolveRoleReasoning('scout', 'deep')).toBe('deep');
    expect(resolveRoleReasoning('planner', 'quick')).toBe('quick');
    expect(resolveRoleReasoning('generator', 'auto')).toBe('auto');
  });
});

describe('resolveRoleReasoning — L2 (Agent profile default) under permissive ceiling', () => {
  it('with deep ceiling, each role lands at its declared default', () => {
    expect(resolveRoleReasoning('scout', 'deep', SCOUT_PROFILE)).toBe('quick');
    expect(resolveRoleReasoning('planner', 'deep', PLANNER_PROFILE)).toBe('balanced');
    expect(resolveRoleReasoning('sa', 'deep', SA_PROFILE)).toBe('balanced');
  });
});

describe('resolveRoleReasoning — L1 ceiling clamps L2 default', () => {
  it('caps higher L2 default at lower L1 ceiling', () => {
    // SA profile.default = balanced, but user said --reasoning quick → quick.
    expect(resolveRoleReasoning('sa', 'quick', SA_PROFILE)).toBe('quick');
    // Planner profile.default = balanced, but user said --reasoning quick → quick.
    expect(resolveRoleReasoning('planner', 'quick', PLANNER_PROFILE)).toBe('quick');
  });

  it('leaves lower L2 default unchanged under higher L1 ceiling', () => {
    // Scout profile.default = quick, user said --reasoning deep → quick (Scout self-limits).
    expect(resolveRoleReasoning('scout', 'deep', SCOUT_PROFILE)).toBe('quick');
  });
});

describe('resolveRoleReasoning — L2 max also clamps', () => {
  it('Scout max=balanced caps even when L1 ceiling allows deep', () => {
    // If a hypothetical higher-than-default scoutHint pushed Scout to deep,
    // its own profile.max=balanced would still hold the line.
    expect(resolveRoleReasoning('scout', 'deep', SCOUT_PROFILE, 'deep')).toBe('balanced');
  });
});

describe('resolveRoleReasoning — L3 (scout hint)', () => {
  it('overrides L2 default within ceilings', () => {
    // Generator default=balanced, scout hints quick, ceiling=deep → quick.
    expect(
      resolveRoleReasoning('generator', 'deep', PLANNER_PROFILE, 'quick'),
    ).toBe('quick');
  });

  it('clamped by L1 user ceiling', () => {
    // Generator default=balanced, scout hints deep, ceiling=quick → quick.
    expect(
      resolveRoleReasoning('generator', 'quick', PLANNER_PROFILE, 'deep'),
    ).toBe('quick');
  });

  it('clamped by L2 profile.max', () => {
    // Scout profile.max=balanced, hint=deep, ceiling=deep → balanced.
    expect(
      resolveRoleReasoning('scout', 'deep', SCOUT_PROFILE, 'deep'),
    ).toBe('balanced');
  });

  it('hint without profile and without ceiling-clamp uses hint as-is up to ceiling', () => {
    // No profile → fall back to userCeiling as base; hint becomes the L3 input.
    expect(resolveRoleReasoning('generator', 'deep', undefined, 'quick')).toBe('quick');
    expect(resolveRoleReasoning('generator', 'quick', undefined, 'deep')).toBe('quick');
  });
});

// ---------------------------------------------------------------------------
// L4 dynamic escalation — escalateThinkingDepth(depth, ceiling)
// ---------------------------------------------------------------------------

describe('escalateThinkingDepth — backward compat (no ceiling)', () => {
  it('caps at high without a ceiling argument', () => {
    expect(escalateThinkingDepth('off')).toBe('low');
    expect(escalateThinkingDepth('low')).toBe('medium');
    expect(escalateThinkingDepth('medium')).toBe('high');
    expect(escalateThinkingDepth('high')).toBe('high');
  });
});

describe('escalateThinkingDepth — ceiling-clamped (FEATURE_078 L4)', () => {
  it('does not exceed depth implied by user ceiling=quick', () => {
    // quick → max depth = low. Escalating from low must not go past low.
    expect(escalateThinkingDepth('low', 'quick')).toBe('low');
    expect(escalateThinkingDepth('medium', 'quick')).toBe('low');
    expect(escalateThinkingDepth('high', 'quick')).toBe('low');
  });

  it('does not exceed depth implied by user ceiling=balanced', () => {
    expect(escalateThinkingDepth('low', 'balanced')).toBe('medium');
    expect(escalateThinkingDepth('medium', 'balanced')).toBe('medium');
    expect(escalateThinkingDepth('high', 'balanced')).toBe('medium');
  });

  it('allows full range when ceiling=deep or ceiling=auto', () => {
    expect(escalateThinkingDepth('medium', 'deep')).toBe('high');
    expect(escalateThinkingDepth('medium', 'auto')).toBe('high');
  });

  it('returns "off" when ceiling=off (escalation neutralized)', () => {
    expect(escalateThinkingDepth('low', 'off')).toBe('off');
    expect(escalateThinkingDepth('medium', 'off')).toBe('off');
  });

  it('escalates from off to low when ceiling permits', () => {
    expect(escalateThinkingDepth('off', 'balanced')).toBe('low');
    expect(escalateThinkingDepth('off', 'deep')).toBe('low');
  });
});
