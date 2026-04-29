/**
 * FEATURE_101 admission runtime — patch reducer + registry tests.
 *
 * Pure function tests, zero LLM, zero I/O. Verifies the contract:
 *
 *   - applyManifestPatch is monotone (only shrinks, never expands)
 *   - composePatches: min-wins for clamps, union for collections
 *   - registerInvariant rejects duplicates and hookless invariants
 *   - resolveRequiredInvariants returns the 7 admission v1 closed-set ids
 *   - resolveEffectiveInvariants unions declared on top of required,
 *     stable ordering, no duplicates
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createAgent } from './agent.js';
import type {
  AgentManifest,
  InvariantId,
  ManifestPatch,
  QualityInvariant,
} from './admission.js';
import {
  _resetInvariantRegistry,
  applyManifestPatch,
  composePatches,
  getInvariant,
  listRegisteredInvariants,
  registerInvariant,
  resolveEffectiveInvariants,
  resolveRequiredInvariants,
} from './admission-runtime.js';

// ---------------------------------------------------------------------------
// applyManifestPatch
// ---------------------------------------------------------------------------

describe('applyManifestPatch', () => {
  const baseManifest: AgentManifest = {
    ...createAgent({
      name: 'sample',
      instructions: 'do things',
      tools: [
        { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
        { name: 'write', description: 'w', inputSchema: { type: 'object' } } as never,
        { name: 'bash', description: 'b', inputSchema: { type: 'object' } } as never,
      ],
    }),
    maxBudget: 8000,
  };

  it('returns the original manifest unchanged when patch is empty', () => {
    const result = applyManifestPatch(baseManifest, {});
    expect(result.tools).toHaveLength(3);
    expect(result.maxBudget).toBe(8000);
  });

  it('removes tools listed in patch.removeTools without mutating input', () => {
    const result = applyManifestPatch(baseManifest, { removeTools: ['write', 'bash'] });
    expect(result.tools).toHaveLength(1);
    expect(result.tools?.[0]?.name).toBe('read');
    expect(baseManifest.tools).toHaveLength(3);  // input not mutated
  });

  it('clampMaxBudget only lowers, never raises', () => {
    const lower = applyManifestPatch(baseManifest, { clampMaxBudget: 5000 });
    expect(lower.maxBudget).toBe(5000);

    const noop = applyManifestPatch(baseManifest, { clampMaxBudget: 10000 });
    expect(noop.maxBudget).toBe(8000);  // still original 8000, not raised to 10000
  });

  it('clampMaxBudget sets the field when the manifest had no maxBudget originally', () => {
    const noBudget: AgentManifest = createAgent({ name: 'x', instructions: 'y' });
    const clamped = applyManifestPatch(noBudget, { clampMaxBudget: 3000 });
    expect(clamped.maxBudget).toBe(3000);
  });

  it('addInvariants unions into manifest.declaredInvariants', () => {
    const result = applyManifestPatch(baseManifest, {
      addInvariants: ['evidenceTrail', 'independentReview'],
    });
    expect(result.declaredInvariants).toContain('evidenceTrail');
    expect(result.declaredInvariants).toContain('independentReview');
    expect(result.declaredInvariants).toHaveLength(2);
  });

  it('addInvariants does not duplicate when manifest already declared it', () => {
    const seeded: AgentManifest = {
      ...baseManifest,
      declaredInvariants: ['independentReview'],
    };
    const result = applyManifestPatch(seeded, {
      addInvariants: ['independentReview', 'evidenceTrail'],
    });
    expect(result.declaredInvariants).toHaveLength(2);
    expect(result.declaredInvariants).toContain('independentReview');
    expect(result.declaredInvariants).toContain('evidenceTrail');
  });

  it('combined patch (remove tools + clamp budget + add invariants) applies all in one pass', () => {
    const patch: ManifestPatch = {
      removeTools: ['bash'],
      clampMaxBudget: 4000,
      addInvariants: ['boundedRevise'],
    };
    const result = applyManifestPatch(baseManifest, patch);
    expect(result.tools).toHaveLength(2);  // read + write
    expect(result.maxBudget).toBe(4000);
    expect(result.declaredInvariants).toEqual(['boundedRevise']);
  });
});

// ---------------------------------------------------------------------------
// composePatches
// ---------------------------------------------------------------------------

describe('composePatches', () => {
  it('returns empty patch for zero inputs', () => {
    expect(composePatches([])).toEqual({});
  });

  it('returns the single input untouched when length === 1', () => {
    const single: ManifestPatch = { clampMaxBudget: 1000 };
    expect(composePatches([single])).toBe(single);  // referentially identical
  });

  it('clampMaxBudget min-wins across multiple patches', () => {
    const result = composePatches([
      { clampMaxBudget: 5000 },
      { clampMaxBudget: 3000 },
      { clampMaxBudget: 4000 },
    ]);
    expect(result.clampMaxBudget).toBe(3000);
  });

  it('clampMaxIterations min-wins across multiple patches', () => {
    const result = composePatches([
      { clampMaxIterations: 5 },
      { clampMaxIterations: 3 },
    ]);
    expect(result.clampMaxIterations).toBe(3);
  });

  it('removeTools unions across patches', () => {
    const result = composePatches([
      { removeTools: ['a', 'b'] },
      { removeTools: ['b', 'c'] },
    ]);
    expect(result.removeTools).toHaveLength(3);
    expect(result.removeTools).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('addInvariants unions and dedups', () => {
    const result = composePatches([
      { addInvariants: ['evidenceTrail', 'finalOwner'] },
      { addInvariants: ['finalOwner', 'boundedRevise'] },
    ]);
    expect(result.addInvariants).toHaveLength(3);
    expect(result.addInvariants).toEqual(expect.arrayContaining([
      'evidenceTrail',
      'finalOwner',
      'boundedRevise',
    ]));
  });

  it('notes concatenate in order', () => {
    const result = composePatches([
      { notes: ['note 1'] },
      { notes: ['note 2', 'note 3'] },
    ]);
    expect(result.notes).toEqual(['note 1', 'note 2', 'note 3']);
  });

  it('omits empty fields from the composed patch (no spurious `removeTools: []`)', () => {
    const result = composePatches([{ clampMaxBudget: 1000 }, { notes: ['x'] }]);
    expect(result).toEqual({ clampMaxBudget: 1000, notes: ['x'] });
    expect(result.removeTools).toBeUndefined();
    expect(result.addInvariants).toBeUndefined();
    expect(result.clampMaxIterations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invariant registry
// ---------------------------------------------------------------------------

describe('Invariant registry', () => {
  afterEach(() => {
    _resetInvariantRegistry();
  });

  it('register + lookup roundtrip', () => {
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'has final owner',
      admit: () => ({ ok: true }),
    };
    registerInvariant(inv);
    expect(getInvariant('finalOwner')).toBe(inv);
  });

  it('rejects duplicate id registration', () => {
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'first',
      admit: () => ({ ok: true }),
    };
    registerInvariant(inv);
    expect(() => registerInvariant({
      ...inv,
      description: 'second (duplicate)',
    })).toThrow(/already registered/i);
  });

  it('rejects invariants with no hooks', () => {
    expect(() => registerInvariant({
      id: 'finalOwner',
      description: 'no hooks',
    } as QualityInvariant)).toThrow(/at least one of admit/);
  });

  it('listRegisteredInvariants returns ids in registration order', () => {
    registerInvariant({ id: 'finalOwner', description: 'a', admit: () => ({ ok: true }) });
    registerInvariant({ id: 'handoffLegality', description: 'b', admit: () => ({ ok: true }) });
    registerInvariant({ id: 'evidenceTrail', description: 'c', observe: () => ({ ok: true }) });
    expect(listRegisteredInvariants()).toEqual([
      'finalOwner',
      'handoffLegality',
      'evidenceTrail',
    ]);
  });

  it('_resetInvariantRegistry clears all registrations', () => {
    registerInvariant({ id: 'finalOwner', description: 'a', admit: () => ({ ok: true }) });
    expect(listRegisteredInvariants()).toHaveLength(1);
    _resetInvariantRegistry();
    expect(listRegisteredInvariants()).toHaveLength(0);
  });

  it('getInvariant returns undefined for unregistered id', () => {
    expect(getInvariant('finalOwner')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveRequiredInvariants + resolveEffectiveInvariants
// ---------------------------------------------------------------------------

describe('resolveRequiredInvariants', () => {
  it('v1 returns the 7 admission v1 closed-set ids', () => {
    const required = resolveRequiredInvariants('scout', [], 'H0_DIRECT');
    expect(required).toHaveLength(7);
    expect(required).toEqual([
      'finalOwner',
      'handoffLegality',
      'budgetCeiling',
      'toolPermission',
      'evidenceTrail',
      'boundedRevise',
      'independentReview',
    ]);
  });

  it('v1 returns the same set regardless of role / toolScope / harnessTier', () => {
    const a = resolveRequiredInvariants('scout', [], 'H0_DIRECT');
    const b = resolveRequiredInvariants('evaluator', ['read', 'grep'], 'H2_PLAN_EXECUTE_EVAL');
    expect(a).toEqual(b);
  });
});

describe('resolveEffectiveInvariants', () => {
  const required: readonly InvariantId[] = [
    'finalOwner',
    'handoffLegality',
    'budgetCeiling',
  ];

  it('returns required as-is when declared is undefined or empty', () => {
    expect(resolveEffectiveInvariants(required, undefined)).toEqual(required);
    expect(resolveEffectiveInvariants(required, [])).toEqual(required);
  });

  it('appends declared invariants not already in required', () => {
    const result = resolveEffectiveInvariants(required, [
      'evidenceTrail',
      'harnessSelectionTiming',
    ]);
    expect(result).toEqual([
      ...required,
      'evidenceTrail',
      'harnessSelectionTiming',
    ]);
  });

  it('declared duplicates of required are silently dropped', () => {
    const result = resolveEffectiveInvariants(required, [
      'finalOwner',  // already in required
      'evidenceTrail',
    ]);
    expect(result).toEqual([...required, 'evidenceTrail']);
  });

  it('declared duplicates within itself are deduped', () => {
    const result = resolveEffectiveInvariants(required, [
      'evidenceTrail',
      'evidenceTrail',
      'harnessSelectionTiming',
    ]);
    expect(result).toEqual([
      ...required,
      'evidenceTrail',
      'harnessSelectionTiming',
    ]);
  });

  it('preserves required order; declared appended in insertion order', () => {
    const result = resolveEffectiveInvariants(required, [
      'harnessSelectionTiming',  // appended first
      'evidenceTrail',           // appended second
    ]);
    expect(result.indexOf('harnessSelectionTiming')).toBe(3);
    expect(result.indexOf('evidenceTrail')).toBe(4);
  });
});
