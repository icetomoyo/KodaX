/**
 * FEATURE_101 admission integration suite — full v1 contract end-to-end.
 *
 * Boots the registry with `registerCodingInvariants()` (the 8-id v1
 * set: 4 core pure + 4 coding capability-coupled) and exercises
 * `Runner.admit` against the four canonical scenarios called out in
 * the FEATURE_101 §Acceptance Criteria:
 *
 *   1. **Happy path** — minimal manifest, no clamps, all admit hooks pass.
 *   2. **Clamp path** — over-budget manifest with a disallowed tool;
 *      both clamps compose and the admitted manifest reflects them.
 *   3. **Reject path** — generator-bearing topology missing an evaluator
 *      (independentReview rejects); separately, a transitive handoff
 *      cycle (handoffLegality rejects).
 *   4. **Mixed warn + clamp** — manifest with maxBudget over cap PLUS
 *      `harnessSelectionTiming` declared (observe-only id surfacing in
 *      bindings); admission still succeeds with both signals recorded.
 *
 * Sits in @kodax/coding because it depends on the capability-coupled
 * invariants. The pure-only suite at
 * `packages/core/src/admission-audit.test.ts` covers the core set in
 * isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Runner,
  _resetInvariantRegistry,
  createAgent,
  createHandoff,
} from '@kodax/core';
import type { Agent, AgentManifest, SystemCap } from '@kodax/core';

import { registerCodingInvariants } from './index.js';

// Tight cap to make clamps observable in tests; production caps are
// typically permissive enough that clamps fire only on adversarial
// manifests.
const TIGHT_CAP: SystemCap = {
  maxBudget: 200,
  maxIterations: 200,
  allowedToolCapabilities: ['read', 'edit', 'bash:test'],
};

describe('FEATURE_101 admission v1 — full integration', () => {
  beforeEach(() => {
    _resetInvariantRegistry();
    registerCodingInvariants();
  });
  afterEach(() => _resetInvariantRegistry());

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  it('happy path — minimal manifest admits with full v1 binding set', async () => {
    const m: AgentManifest = createAgent({
      name: 'minimal',
      instructions: 'do the thing',
      tools: [
        { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
      ],
    });
    const verdict = await Runner.admit(m, {
      systemCap: TIGHT_CAP,
      nowIso: '2026-04-29T00:00:00.000Z',
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.handle.appliedPatches).toEqual([]);
      expect(verdict.clampNotes).toEqual([]);
      expect(verdict.handle.invariantBindings).toEqual([
        'finalOwner',
        'handoffLegality',
        'budgetCeiling',
        'toolPermission',
        'evidenceTrail',
        'boundedRevise',
        'independentReview',
      ]);
      expect(verdict.handle.admittedAt).toBe('2026-04-29T00:00:00.000Z');
    }
  });

  // -------------------------------------------------------------------------
  // 2. Clamp path
  // -------------------------------------------------------------------------

  it('clamp path — over-budget + disallowed-tool manifest is admitted with composed clamps', async () => {
    const m: AgentManifest = {
      ...createAgent({
        name: 'greedy',
        instructions: 'wants too much',
        tools: [
          { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
          { name: 'web_fetch', description: 'w', inputSchema: { type: 'object' } } as never, // bash:network — disallowed
          { name: 'bash', description: 'b', inputSchema: { type: 'object' } } as never, // bash:mutating — disallowed
        ],
      }),
      maxBudget: 9000,
    };
    const verdict = await Runner.admit(m, { systemCap: TIGHT_CAP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // Budget clamped down to cap.
      expect(verdict.handle.manifest.maxBudget).toBe(200);
      // web_fetch + bash removed; read survives.
      const remainingNames = (verdict.handle.manifest.tools ?? []).map(
        (t) => (t as { name?: string }).name,
      );
      expect(remainingNames).toEqual(['read']);
      // Two clamp patches applied (one per invariant).
      expect(verdict.handle.appliedPatches).toHaveLength(2);
      expect(verdict.clampNotes.some((n) => n.startsWith('[budgetCeiling]'))).toBe(true);
      expect(verdict.clampNotes.some((n) => n.startsWith('[toolPermission]'))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 3a. Reject path — missing evaluator
  // -------------------------------------------------------------------------

  it('reject path — generator-bearing manifest without evaluator fails independentReview', async () => {
    const generator = createAgent({ name: 'generator', instructions: 'g' });
    const planner = createAgent({
      name: 'planner',
      instructions: 'p',
      handoffs: [createHandoff({ target: generator, kind: 'continuation' })],
    });
    const activated = new Map<string, Agent>([
      ['planner', planner],
      ['generator', generator],
    ]);
    const verdict = await Runner.admit(planner, {
      systemCap: TIGHT_CAP,
      activatedAgents: activated,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/independentReview/);
      expect(verdict.reason).toMatch(/generator/);
      expect(verdict.reason).toMatch(/evaluator/);
      expect(verdict.retryable).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 3b. Reject path — transitive cycle
  // -------------------------------------------------------------------------

  it('reject path — transitive handoff cycle (a → b → c → a, side branch with terminal) fails handoffLegality', async () => {
    // Side-branch terminal so finalOwner admits — handoffLegality must
    // be the invariant that catches the cycle.
    const terminal = createAgent({ name: 'terminal', instructions: 'sink' });
    const c = {
      name: 'c',
      instructions: 'c',
      handoffs: [
        { target: { name: 'a', instructions: '' }, kind: 'continuation' as const },
      ],
    };
    const b = {
      name: 'b',
      instructions: 'b',
      handoffs: [
        { target: c as unknown as Agent, kind: 'continuation' as const },
      ],
    };
    const a = createAgent({
      name: 'a',
      instructions: 'a',
      handoffs: [
        createHandoff({ target: terminal, kind: 'continuation' }),
        createHandoff({ target: b as unknown as Agent, kind: 'continuation' }),
      ],
    });
    const activated = new Map<string, Agent>([
      ['terminal', terminal],
      ['b', b as unknown as Agent],
      ['c', c as unknown as Agent],
    ]);
    const verdict = await Runner.admit(a, {
      systemCap: TIGHT_CAP,
      activatedAgents: activated,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/handoffLegality/);
      expect(verdict.reason).toMatch(/cycle/);
      expect(verdict.reason).toContain('a → b → c → a');
      expect(verdict.retryable).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Mixed signals — over-budget + observe-only declared
  // -------------------------------------------------------------------------

  it('mixed path — over-budget + harnessSelectionTiming declared admits with both signals', async () => {
    const m: AgentManifest = {
      ...createAgent({
        name: 'mixed',
        instructions: 'small over',
        tools: [
          { name: 'read', description: 'r', inputSchema: { type: 'object' } } as never,
        ],
      }),
      maxBudget: 500,
      declaredInvariants: ['harnessSelectionTiming'],
    };
    const verdict = await Runner.admit(m, { systemCap: TIGHT_CAP });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // Budget clamped.
      expect(verdict.handle.manifest.maxBudget).toBe(200);
      // harnessSelectionTiming joins the binding set.
      expect(verdict.handle.invariantBindings).toContain('harnessSelectionTiming');
      // Single clamp note (no warn from harnessSelectionTiming since it
      // has no admit hook — only triggers at observe time).
      expect(verdict.clampNotes).toHaveLength(1);
      expect(verdict.clampNotes[0]).toMatch(/^\[budgetCeiling\]/);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Schema rejection bypasses invariant hooks
  // -------------------------------------------------------------------------

  it('schema rejection short-circuits before any invariant fires', async () => {
    const verdict = await Runner.admit({
      name: '',
      instructions: 'x',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/manifest\.name/);
      expect(verdict.retryable).toBe(true);
    }
  });
});
