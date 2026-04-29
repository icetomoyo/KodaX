/**
 * Type-shape regression tests for FEATURE_101 admission contract types.
 *
 * Pure type-shape exercises: assert that the discriminated unions narrow
 * correctly, that AgentManifest extends Agent, and that ManifestPatch
 * fields compose as documented. No runtime logic — that arrives in the
 * 1A.2 / 1A.3 increments (invariant implementations + Runner.admit).
 *
 * Why bother shipping these now: catches accidental schema drift if a
 * future contributor "fixes" the discriminated union by collapsing
 * severity into a single string field. Type tests run as fast as
 * regular tests under vitest and burn no compile-only blind spot.
 */

import { describe, expect, it } from 'vitest';

import type {
  AdmissionVerdict,
  AdmittedHandle,
  AgentManifest,
  InvariantResult,
  ManifestPatch,
  QualityInvariant,
  ToolCapability,
} from './admission.js';
import type { Agent } from './agent.js';
import { createAgent } from './agent.js';

describe('FEATURE_101 admission types — schema shape', () => {
  it('AgentManifest is structurally an Agent (every Agent satisfies AgentManifest)', () => {
    const agent: Agent = createAgent({
      name: 'sample',
      instructions: 'do things',
    });
    // Type-level: assigning Agent to AgentManifest must compile.
    const manifest: AgentManifest = agent;
    expect(manifest.name).toBe('sample');
  });

  it('AgentManifest accepts manifest-only fields (requestedToolCapabilities / maxBudget / declaredInvariants)', () => {
    const manifest: AgentManifest = {
      name: 'reviewer',
      instructions: 'review code',
      requestedToolCapabilities: [
        { tool: 'read', capabilities: ['read'] },
        { tool: 'bash', capabilities: ['bash:test', 'bash:read-only'] },
      ],
      maxBudget: 5000,
      declaredInvariants: ['independentReview'],
    };
    expect(manifest.requestedToolCapabilities?.[0]?.tool).toBe('read');
    expect(manifest.maxBudget).toBe(5000);
    expect(manifest.declaredInvariants).toContain('independentReview');
  });

  it('InvariantResult discriminated union narrows by ok/severity', () => {
    const ok: InvariantResult = { ok: true };
    const reject: InvariantResult = {
      ok: false,
      severity: 'reject',
      reason: 'cycle detected',
    };
    const clamp: InvariantResult = {
      ok: false,
      severity: 'clamp',
      reason: 'budget over cap',
      patch: { clampMaxBudget: 1000 },
    };
    const warn: InvariantResult = {
      ok: false,
      severity: 'warn',
      reason: 'soft signal',
    };

    // Narrow by ok flag.
    expect(ok.ok).toBe(true);

    // Narrow by severity. TypeScript should make `patch` accessible only
    // on the clamp branch — this is the union design's value.
    if (!clamp.ok && clamp.severity === 'clamp') {
      expect(clamp.patch.clampMaxBudget).toBe(1000);
    } else {
      throw new Error('clamp narrowing failed');
    }

    if (!reject.ok && reject.severity === 'reject') {
      expect(reject.reason).toBe('cycle detected');
      // @ts-expect-error - reject branch has no patch field
      void reject.patch;
    }

    if (!warn.ok && warn.severity === 'warn') {
      expect(warn.reason).toBe('soft signal');
    }
  });

  it('ManifestPatch fields are all optional and compose as data', () => {
    const empty: ManifestPatch = {};
    const fullyPopulated: ManifestPatch = {
      removeTools: ['bash', 'web_fetch'],
      clampMaxBudget: 2000,
      clampMaxIterations: 3,
      addInvariants: ['evidenceTrail'],
      notes: ['budget clamped from 8000', 'tools clamped to read-only'],
    };
    expect(empty).toEqual({});
    expect(fullyPopulated.notes).toHaveLength(2);
  });

  it('AdmissionVerdict narrows handle/reason by ok flag', () => {
    const handle: AdmittedHandle = {
      manifest: createAgent({ name: 'x', instructions: 'y' }),
      admittedAt: '2026-04-29T00:00:00.000Z',
      appliedPatches: [],
      invariantBindings: ['finalOwner', 'handoffLegality'],
    };
    const success: AdmissionVerdict = {
      ok: true,
      handle,
      clampNotes: [],
    };
    const failure: AdmissionVerdict = {
      ok: false,
      reason: 'schema invalid',
      retryable: true,
    };
    if (success.ok) {
      expect(success.handle.manifest.name).toBe('x');
      // @ts-expect-error - success branch has no reason field
      void success.reason;
    }
    if (!failure.ok) {
      expect(failure.retryable).toBe(true);
      // @ts-expect-error - failure branch has no handle field
      void failure.handle;
    }
  });

  it('QualityInvariant supports any subset of the three hooks', () => {
    // Admit-only invariant (e.g. finalOwner)
    const admitOnly: QualityInvariant = {
      id: 'finalOwner',
      description: 'Manifest must designate a final owner',
      admit: () => ({ ok: true }),
    };
    // Observe-only (e.g. harnessSelectionTiming)
    const observeOnly: QualityInvariant = {
      id: 'harnessSelectionTiming',
      description: 'Multi-file mutations must be preceded by a harness verdict',
      observe: () => ({ ok: true }),
    };
    // Terminal-only (e.g. evidenceTrail terminal check)
    const terminalOnly: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'Evidence trail must be complete at terminal',
      assertTerminal: () => ({ ok: true }),
    };
    // All three
    const allThree: QualityInvariant = {
      id: 'independentReview',
      description: 'Verifier role bound + verdict produced',
      admit: () => ({ ok: true }),
      observe: () => ({ ok: true }),
      assertTerminal: () => ({ ok: true }),
    };
    expect([admitOnly, observeOnly, terminalOnly, allThree]).toHaveLength(4);
  });

  it('ToolCapability covers the seven tier classes from FEATURE_101 §Tool Capability Tier', () => {
    const all: ToolCapability[] = [
      'read',
      'edit',
      'bash:test',
      'bash:read-only',
      'bash:mutating',
      'bash:network',
      'subagent',
    ];
    expect(all).toHaveLength(7);
  });
});
