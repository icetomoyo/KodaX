/**
 * FEATURE_101 — `budgetCeiling` invariant unit tests.
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '@kodax/core';
import type { AdmissionCtx, AgentManifest, SystemCap } from '@kodax/core';

import { budgetCeiling } from './budget-ceiling.js';

const SYS_CAP: SystemCap = {
  maxBudget: 200,
  maxIterations: 200,
  allowedToolCapabilities: ['read', 'edit'],
};

function ctx(manifest: AgentManifest): AdmissionCtx {
  return {
    manifest,
    activatedAgents: new Map(),
    stagedAgents: new Map(),
    systemCap: SYS_CAP,
  };
}

describe('budgetCeiling.admit', () => {
  it('admits manifest without an explicit maxBudget (no clamp)', () => {
    const m: AgentManifest = createAgent({ name: 'a', instructions: 'b' });
    expect(budgetCeiling.admit!(m, ctx(m)).ok).toBe(true);
  });

  it('admits manifest with maxBudget at the cap', () => {
    const m: AgentManifest = {
      ...createAgent({ name: 'a', instructions: 'b' }),
      maxBudget: 200,
    };
    expect(budgetCeiling.admit!(m, ctx(m)).ok).toBe(true);
  });

  it('admits manifest with maxBudget below the cap', () => {
    const m: AgentManifest = {
      ...createAgent({ name: 'a', instructions: 'b' }),
      maxBudget: 100,
    };
    expect(budgetCeiling.admit!(m, ctx(m)).ok).toBe(true);
  });

  it('clamps manifest with maxBudget exceeding the cap', () => {
    const m: AgentManifest = {
      ...createAgent({ name: 'a', instructions: 'b' }),
      maxBudget: 5000,
    };
    const result = budgetCeiling.admit!(m, ctx(m));
    expect(result.ok).toBe(false);
    if (!result.ok && result.severity === 'clamp') {
      expect(result.patch.clampMaxBudget).toBe(200);
      expect(result.reason).toContain('5000');
      expect(result.reason).toContain('200');
    } else {
      throw new Error('expected clamp severity');
    }
  });
});
