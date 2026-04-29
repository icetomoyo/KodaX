/**
 * FEATURE_101 × FEATURE_106 joint integration test (v0.7.31 Phase 2.1+2.2).
 *
 * Verifies that the admission contract runtime (FEATURE_101) and the AMA
 * harness calibration (FEATURE_106) compose end-to-end:
 *
 *   1. `registerCodingInvariants()` bootstraps the full v1 closed set
 *      (4 core pure + 4 coding capability-coupled = 8 invariant ids,
 *      including the FEATURE_106 external `harnessSelectionTiming`).
 *
 *   2. `Runner.admit()` accepts a Scout-shaped manifest under default
 *      caps and produces an `AdmittedHandle` whose `invariantBindings`
 *      include the harness-timing invariant when declared.
 *
 *   3. When invoked through the registry (the runtime path
 *      `Runner.observe` will eventually drive in a follow-up
 *      increment), `harnessSelectionTiming.observe`:
 *        - fires a warn signal on a multi-file `mutation_recorded`
 *          event with no confirmed Scout verdict (the FEATURE_106
 *          calibration target); AND
 *        - stays silent when the verdict has been set (calibration
 *          successful).
 *
 *   4. The scope-aware-harness Guardrail (FEATURE_106 Slice 1) and
 *      this invariant (Slice 3) are independent — the Guardrail acts
 *      on tool results, the invariant observes runner events. Both
 *      remain wired after a single bootstrap call.
 *
 * Phase 3 will add FEATURE_089 (agent generation) and grow this suite
 * to a true three-feature joint test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Runner,
  _resetInvariantRegistry,
  createAgent,
  getInvariant,
  listRegisteredInvariants,
} from '@kodax/core';
import type {
  AgentManifest,
  ObserveCtx,
  RunnerEvent,
  SystemCap,
} from '@kodax/core';

import { registerCodingInvariants } from './index.js';

const SYS_CAP: SystemCap = {
  maxBudget: 200,
  maxIterations: 200,
  allowedToolCapabilities: ['read', 'edit', 'bash:test'],
};

// Matches @kodax/core/admission.ts §ReadonlyMutationTracker.
function emptyTracker(): ObserveCtx['mutationTracker'] {
  return { files: new Set<string>(), totalOps: 0 };
}

function obsCtx(
  manifest: AgentManifest,
  recorder: ObserveCtx['recorder'] = {},
): ObserveCtx {
  return {
    manifest,
    mutationTracker: emptyTracker(),
    recorder,
  };
}

describe('FEATURE_101 × FEATURE_106 — joint registration + observe wiring', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    registerCodingInvariants();
  });
  afterEach(() => _resetInvariantRegistry());

  it('registerCodingInvariants brings up the full v1 set including harnessSelectionTiming', () => {
    const ids = listRegisteredInvariants();
    expect(ids).toContain('harnessSelectionTiming');
    // The 8 ids = 7 admission v1 closed set + FEATURE_106 external.
    expect(ids).toHaveLength(8);
  });

  it('Runner.admit binds harnessSelectionTiming when manifest declares it', async () => {
    const manifest: AgentManifest = {
      ...createAgent({ name: 'scout-like', instructions: 'classify' }),
      declaredInvariants: ['harnessSelectionTiming'],
    };
    const verdict = await Runner.admit(manifest, { systemCap: SYS_CAP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.handle.invariantBindings).toContain('harnessSelectionTiming');
    }
  });

  it('harnessSelectionTiming.observe fires on multi-file mutation without confirmed harness (FEATURE_106 calibration target)', () => {
    // The invariant is registered; we drive its observe hook directly,
    // simulating what `Runner.observe` will do in a future increment.
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    expect(inv?.observe).toBeDefined();

    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'packages/api/src/handlers/auth.ts',
      fileCount: 4,
    };
    const result = inv!.observe!(event, obsCtx(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('warn');
      expect(result.reason).toContain('fileCount=4');
      expect(result.reason).toContain('Scout-emitted confirmedHarness');
    }
  });

  it('harnessSelectionTiming.observe stays silent when Scout has committed to H1 (calibration successful)', () => {
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const recorder: ObserveCtx['recorder'] = {
      scout: { payload: { scout: { confirmedHarness: 'H1_EXECUTE_EVAL' } } },
    };
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'packages/api/src/handlers/auth.ts',
      fileCount: 4,
    };
    const result = inv!.observe!(event, obsCtx(manifest, recorder));
    expect(result.ok).toBe(true);
  });

  it('harnessSelectionTiming.observe ignores single-file mutations regardless of harness commitment', () => {
    const inv = getInvariant('harnessSelectionTiming');
    expect(inv).toBeDefined();
    const manifest = createAgent({ name: 'scout-like', instructions: 'classify' });
    const event: RunnerEvent = {
      kind: 'mutation_recorded',
      file: 'a.ts',
      fileCount: 1,
    };
    expect(inv!.observe!(event, obsCtx(manifest)).ok).toBe(true);
  });

  it('Guardrail Slice 1 + invariant Slice 3 share registration but are independent contracts', () => {
    // Slice 3 (this invariant) is registered.
    expect(getInvariant('harnessSelectionTiming')).toBeDefined();
    // Slice 1 (the guardrail) is not in the invariant registry — it
    // lives at the Guardrail layer (run-scoped). The two are wired
    // through different runtimes; both are exercised in
    // `scope-aware-harness-guardrail.integration.test.ts`. This test
    // confirms they don't accidentally collide on the same id.
    expect(listRegisteredInvariants()).not.toContain('scope-aware-harness');
  });
});
