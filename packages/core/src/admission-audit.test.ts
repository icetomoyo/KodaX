/**
 * FEATURE_101 — `runAdmissionAudit` (and `Runner.admit` thin wrapper)
 * 5-step audit integration tests.
 *
 * Verifies the contract:
 *   - Schema validation rejects malformed manifests with retryable=true
 *   - Effective invariant resolution = required ∪ declared
 *   - Reject short-circuits before clamp accumulation
 *   - Clamp severity composes patches and applies to the admitted manifest
 *   - Warn results surface as clampNotes without blocking admission
 *   - Default options produce permissive system caps
 *
 * Tests reset the registry before each block and register the four
 * pure-new invariants (no @kodax/coding capability-coupled invariants
 * needed at this layer).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgent, createHandoff } from './agent.js';
import { runAdmissionAudit } from './admission-audit.js';
import {
  _resetInvariantRegistry,
  registerInvariant,
} from './admission-runtime.js';
import { _resetAdmissionMetrics } from './admission-metrics.js';
import type {
  AgentManifest,
  QualityInvariant,
  SystemCap,
  ToolCapability,
} from './admission.js';
import { finalOwner, registerCoreInvariants } from './invariants/index.js';
import { Runner } from './runner.js';

const SYS_CAP: SystemCap = {
  maxBudget: 10_000,
  maxIterations: 50,
  allowedToolCapabilities: ['read', 'edit', 'bash:test', 'bash:read-only'] as readonly ToolCapability[],
};

describe('runAdmissionAudit — schema validation (Step 1)', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
    registerCoreInvariants();
  });
  afterEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
  });

  it('rejects manifest with empty name', () => {
    const result = runAdmissionAudit({ name: '', instructions: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/manifest\.name/);
      expect(result.retryable).toBe(true);
    }
  });

  it('rejects manifest with non-string instructions', () => {
    const result = runAdmissionAudit({
      name: 'a',
      instructions: 42 as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/instructions/);
  });

  it('rejects manifest with unnamed tool', () => {
    const result = runAdmissionAudit({
      name: 'a',
      instructions: 'x',
      tools: [{ description: 'r' } as never],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/tools\[0\]\.name/);
  });

  it('rejects manifest with unknown declaredInvariant id', () => {
    const result = runAdmissionAudit({
      name: 'a',
      instructions: 'x',
      declaredInvariants: ['notARealInvariant' as never],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown invariant id/);
  });

  it('rejects manifest with unknown tool capability', () => {
    const result = runAdmissionAudit({
      name: 'a',
      instructions: 'x',
      requestedToolCapabilities: [
        { tool: 'read', capabilities: ['filesystem' as never] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown capability/);
  });

  it('rejects manifest with empty capabilities array', () => {
    const result = runAdmissionAudit({
      name: 'a',
      instructions: 'x',
      requestedToolCapabilities: [{ tool: 'read', capabilities: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/non-empty array/);
  });
});

describe('runAdmissionAudit — happy path (Steps 2–5)', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
    registerCoreInvariants();
  });
  afterEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
  });

  it('admits a minimal manifest and produces an AdmittedHandle', () => {
    const m: AgentManifest = createAgent({ name: 'minimal', instructions: 'do' });
    const result = runAdmissionAudit(m, {
      systemCap: SYS_CAP,
      nowIso: '2026-04-29T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.manifest.name).toBe('minimal');
      expect(result.handle.admittedAt).toBe('2026-04-29T00:00:00.000Z');
      expect(result.handle.appliedPatches).toEqual([]);
      expect(result.clampNotes).toEqual([]);
      // invariantBindings reflects ids whose implementations are
      // registered. With only the 4 pure-new core invariants registered
      // (Phase 1A.3), the bindings = required ∩ registered. Phase 1A.4
      // adds budgetCeiling/toolPermission/boundedRevise/independentReview
      // and grows this set to the full 7-id closed set.
      expect(result.handle.invariantBindings).toEqual([
        'finalOwner',
        'handoffLegality',
        'evidenceTrail',
      ]);
    }
  });

  it('unions declared invariants on top of required (filtered to registered ids)', () => {
    const m: AgentManifest = {
      ...createAgent({ name: 'a', instructions: 'b' }),
      declaredInvariants: ['harnessSelectionTiming', 'finalOwner'],
    };
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only ids with registered implementations appear in bindings.
      // Required set yields 3 registered (finalOwner / handoffLegality /
      // evidenceTrail); declared adds harnessSelectionTiming = 4 total.
      expect(result.handle.invariantBindings).toEqual([
        'finalOwner',
        'handoffLegality',
        'evidenceTrail',
        'harnessSelectionTiming',
      ]);
    }
  });

  it('uses DEFAULT_SYSTEM_CAP when no systemCap is provided', () => {
    const m: AgentManifest = createAgent({ name: 'a', instructions: 'b' });
    const result = runAdmissionAudit(m);
    expect(result.ok).toBe(true);
  });

  it('observe-only invariants in the effective set do not produce a spurious reject', () => {
    // harnessSelectionTiming has only an observe hook (no admit). When it's
    // declared on the manifest it joins the effective set, but the audit's
    // admit loop must skip it cleanly (the !inv.admit branch).
    const m: AgentManifest = {
      ...createAgent({ name: 'observer', instructions: 'watch' }),
      declaredInvariants: ['harnessSelectionTiming'],
    };
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.invariantBindings).toContain('harnessSelectionTiming');
    }
  });

  it('invariantBindings excludes ids that have no implementation registered', () => {
    // Reset the registry, then register only finalOwner. Required-set
    // resolution still nominates 7 ids, but only finalOwner has an
    // implementation. The handle's bindings must reflect what's actually
    // available, not the nominated set.
    _resetInvariantRegistry();
    registerInvariant(finalOwner);
    const m: AgentManifest = createAgent({ name: 'minimal', instructions: 'do' });
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.invariantBindings).toEqual(['finalOwner']);
    }
    // Restore for subsequent tests.
    _resetInvariantRegistry();
    registerCoreInvariants();
  });
});

describe('runAdmissionAudit — reject short-circuit (Step 3 reject)', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
    registerCoreInvariants();
  });
  afterEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
  });

  it('rejects a self-loop (finalOwner runs first in the required order — diagnoses "no terminal")', () => {
    // Self-loop: both finalOwner and handoffLegality flag this; finalOwner
    // is earlier in the required order so it produces the reject reason.
    const a = createAgent({
      name: 'a',
      instructions: 'x',
      handoffs: [
        createHandoff({
          target: createAgent({ name: 'a', instructions: 'x' }),
          kind: 'continuation',
        }),
      ],
    });
    const result = runAdmissionAudit(a, { systemCap: SYS_CAP });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/finalOwner|handoffLegality|terminal owner|cycle/);
      expect(result.retryable).toBe(false);
    }
  });

  it('handoffLegality specifically catches a side-branch cycle that finalOwner accepts', () => {
    // a → terminal (passes finalOwner), AND a → c → c (cycle on side branch).
    // finalOwner sees a path to a terminal and admits, so handoffLegality
    // is the invariant that produces the reject — proves cycle detection
    // covers transitive references through activatedAgents.
    const terminal = createAgent({ name: 'terminal', instructions: 'sink' });
    const cyclic = {
      name: 'c',
      instructions: 'self-loop',
      handoffs: [
        { target: { name: 'c', instructions: '' }, kind: 'continuation' as const },
      ],
    } as const;
    const a = createAgent({
      name: 'a',
      instructions: 'root',
      handoffs: [
        createHandoff({ target: terminal, kind: 'continuation' }),
        createHandoff({
          target: cyclic as unknown as ReturnType<typeof createAgent>,
          kind: 'continuation',
        }),
      ],
    });
    const activated = new Map<string, ReturnType<typeof createAgent>>([
      ['terminal', terminal],
      ['c', cyclic as unknown as ReturnType<typeof createAgent>],
    ]);
    const result = runAdmissionAudit(a, {
      systemCap: SYS_CAP,
      activatedAgents: activated,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/cycle/);
      expect(result.reason).toContain('c → c');
      expect(result.retryable).toBe(false);
    }
  });
});

describe('runAdmissionAudit — clamp composition (Steps 3–5)', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    // Register a stub invariant that returns a clamp patch — tests the
    // patch-composition pipeline without needing the @kodax/coding
    // capability-coupled invariants.
    const budgetClamper: QualityInvariant = {
      id: 'budgetCeiling',
      description: 'stub clamp',
      admit: (manifest) => {
        if (typeof manifest.maxBudget === 'number' && manifest.maxBudget > 5000) {
          return {
            ok: false,
            severity: 'clamp',
            reason: `budget ${manifest.maxBudget} exceeds cap 5000`,
            patch: { clampMaxBudget: 5000 },
          };
        }
        return { ok: true };
      },
    };
    const toolClamper: QualityInvariant = {
      id: 'toolPermission',
      description: 'stub clamp',
      admit: (manifest) => {
        if (manifest.tools && manifest.tools.some((t) => (t as { name?: string }).name === 'bash')) {
          return {
            ok: false,
            severity: 'clamp',
            reason: 'bash not in tool scope',
            patch: { removeTools: ['bash'] },
          };
        }
        return { ok: true };
      },
    };
    // Register only what we need (skip the other 5 invariants).
    registerInvariant(budgetClamper);
    registerInvariant(toolClamper);
    // Pure-new invariants still need to be registered for required-set
    // resolution to find them.
    registerCoreInvariants();
  });
  afterEach(() => _resetInvariantRegistry());

  it('applies budget clamp and surfaces the note', () => {
    const m: AgentManifest = {
      ...createAgent({ name: 'over', instructions: 'too much' }),
      maxBudget: 8000,
    };
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.manifest.maxBudget).toBe(5000);
      expect(result.handle.appliedPatches).toHaveLength(1);
      expect(result.clampNotes[0]).toContain('[budgetCeiling]');
      expect(result.clampNotes[0]).toContain('exceeds cap 5000');
    }
  });

  it('applies tool clamp (removeTools) and the manifest no longer contains bash', () => {
    const m: AgentManifest = {
      ...createAgent({
        name: 'with-bash',
        instructions: 'shell please',
        tools: [
          { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
          { name: 'bash', description: 'b', inputSchema: { type: 'object' } } as never,
        ],
      }),
    };
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.manifest.tools).toHaveLength(1);
      expect(result.handle.manifest.tools![0]!.name).toBe('read');
      expect(result.clampNotes[0]).toContain('[toolPermission]');
    }
  });

  it('composes multiple clamps in one admission pass', () => {
    const m: AgentManifest = {
      ...createAgent({
        name: 'over-both',
        instructions: 'shell + budget over',
        tools: [
          { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
          { name: 'bash', description: 'b', inputSchema: { type: 'object' } } as never,
        ],
      }),
      maxBudget: 9000,
    };
    const result = runAdmissionAudit(m, { systemCap: SYS_CAP });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.handle.manifest.maxBudget).toBe(5000);
      expect(result.handle.manifest.tools).toHaveLength(1);
      expect(result.handle.appliedPatches).toHaveLength(2);
      expect(result.clampNotes).toHaveLength(2);
    }
  });
});

describe('Runner.admit — thin wrapper around runAdmissionAudit', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
    registerCoreInvariants();
  });
  afterEach(() => {
    _resetInvariantRegistry();
    _resetAdmissionMetrics();
  });

  it('delegates to runAdmissionAudit and returns the same verdict shape', async () => {
    const m: AgentManifest = createAgent({ name: 'wrapped', instructions: 'go' });
    const verdict = await Runner.admit(m, { systemCap: SYS_CAP, nowIso: '2026-04-29T12:00:00.000Z' });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.handle.admittedAt).toBe('2026-04-29T12:00:00.000Z');
      expect(verdict.handle.invariantBindings).toContain('finalOwner');
    }
  });

  it('surfaces schema rejection through Runner.admit', async () => {
    const verdict = await Runner.admit({ name: '', instructions: 'x' });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.retryable).toBe(true);
      expect(verdict.reason).toMatch(/manifest\.name/);
    }
  });
});
