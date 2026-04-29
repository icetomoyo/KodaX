/**
 * FEATURE_101 — `registerCodingInvariants` bootstrap test.
 *
 * Verifies that calling the bootstrap registers the full v1 set
 * (4 core pure + 4 coding capability-coupled = 8 ids) on the shared
 * runtime registry.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetInvariantRegistry,
  listRegisteredInvariants,
  Runner,
  createAgent,
} from '@kodax/core';
import type { AgentManifest } from '@kodax/core';

import { registerCodingInvariants } from './index.js';

describe('registerCodingInvariants', () => {
  afterEach(() => _resetInvariantRegistry());

  it('registers all 8 v1 invariants in canonical order', () => {
    _resetInvariantRegistry();
    registerCodingInvariants();
    expect(listRegisteredInvariants()).toEqual([
      // Core (registered first by registerCoreInvariants).
      'finalOwner',
      'handoffLegality',
      'evidenceTrail',
      'harnessSelectionTiming',
      // Coding capability-coupled.
      'budgetCeiling',
      'toolPermission',
      'boundedRevise',
      'independentReview',
    ]);
  });

  it('after registration, Runner.admit produces a 7-id binding for a minimal manifest', async () => {
    _resetInvariantRegistry();
    registerCodingInvariants();
    const manifest: AgentManifest = createAgent({ name: 'm', instructions: 'i' });
    const verdict = await Runner.admit(manifest);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // The 7 admission v1 closed-set ids — harnessSelectionTiming is NOT
      // in the required set, so it appears in bindings only when
      // explicitly declared.
      expect(verdict.handle.invariantBindings).toEqual([
        'finalOwner',
        'handoffLegality',
        'budgetCeiling',
        'toolPermission',
        'evidenceTrail',
        'boundedRevise',
        'independentReview',
      ]);
    }
  });
});
