/**
 * FEATURE_101 — `handoffLegality` invariant unit tests.
 *
 * The check is admit-time DAG cycle detection. Edge cases:
 *   - direct self-loop (manifest hands off to itself)
 *   - 2-node mutual handoff (a → b → a)
 *   - longer cycle through activatedAgents (a → b → c → a)
 *   - linear chain (admits)
 *   - diamond (admits — DAG, not a tree)
 */

import { describe, expect, it } from 'vitest';

import type { Agent } from '../agent.js';
import { createAgent, createHandoff } from '../agent.js';
import type { AdmissionCtx, AgentManifest, SystemCap } from '../admission.js';
import { handoffLegality } from './handoff-legality.js';

const SYS_CAP: SystemCap = {
  maxBudget: 100_000,
  maxIterations: 100,
  allowedToolCapabilities: ['read'],
};

function ctx(
  manifest: AgentManifest,
  activatedAgents: ReadonlyMap<string, Agent> = new Map(),
  stagedAgents: ReadonlyMap<string, Agent> = new Map(),
): AdmissionCtx {
  return { manifest, activatedAgents, stagedAgents, systemCap: SYS_CAP };
}

function stub(name: string, handoffTargets: readonly string[] = []): Agent {
  return {
    name,
    instructions: `agent ${name}`,
    handoffs: handoffTargets.map((t) => ({
      target: { name: t, instructions: '' } as Agent,
      kind: 'continuation' as const,
    })),
  };
}

describe('handoffLegality.admit — same-batch staged cycle (FEATURE_101 v0.7.31.1)', () => {
  it('rejects A→B when B is staged and points back to A', () => {
    const a = stub('a', ['b']);
    const b = stub('b', ['a']);
    const stagedAgents = new Map<string, Agent>([['b', b]]);
    const verdict = handoffLegality.admit!(
      a as AgentManifest,
      ctx(a as AgentManifest, new Map(), stagedAgents),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.severity).toBe('reject');
      expect(verdict.reason).toMatch(/cycle/i);
      expect(verdict.reason).toMatch(/a/);
      expect(verdict.reason).toMatch(/b/);
    }
  });

  it('admits a chain when staged predecessor never closes the loop', () => {
    const a = stub('a', ['b']);
    const b = stub('b', ['c']);
    const c = stub('c'); // terminal — no outgoing.
    const staged = new Map<string, Agent>([
      ['b', b],
      ['c', c],
    ]);
    const verdict = handoffLegality.admit!(
      a as AgentManifest,
      ctx(a as AgentManifest, new Map(), staged),
    );
    expect(verdict.ok).toBe(true);
  });

  it('activated agents take precedence over staged on name collision', () => {
    // staged 'b' has a back-edge to 'a' (would form cycle).
    // activated 'b' (different version of the same name) is terminal.
    // Activated wins, so admission accepts.
    const stagedB = stub('b', ['a']);
    const activatedB = stub('b'); // terminal
    const a = stub('a', ['b']);
    const verdict = handoffLegality.admit!(
      a as AgentManifest,
      ctx(
        a as AgentManifest,
        new Map<string, Agent>([['b', activatedB]]),
        new Map<string, Agent>([['b', stagedB]]),
      ),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('handoffLegality.admit', () => {
  it('admits a single agent with no handoffs', () => {
    const m = createAgent({ name: 'solo', instructions: 'do work' });
    expect(handoffLegality.admit!(m, ctx(m)).ok).toBe(true);
  });

  it('admits a linear chain a → b → c (terminates at c)', () => {
    const c = stub('c');
    const b = stub('b', ['c']);
    const a = stub('a', ['b']);
    const activated = new Map<string, Agent>([
      ['b', b],
      ['c', c],
    ]);
    expect(handoffLegality.admit!(a, ctx(a, activated)).ok).toBe(true);
  });

  it('admits a diamond a → {b, c} → d (DAG with multiple paths)', () => {
    const d = stub('d');
    const b = stub('b', ['d']);
    const c = stub('c', ['d']);
    const a = createAgent({
      name: 'a',
      instructions: 'root',
      handoffs: [
        createHandoff({ target: b, kind: 'continuation' }),
        createHandoff({ target: c, kind: 'continuation' }),
      ],
    });
    const activated = new Map<string, Agent>([
      ['b', b],
      ['c', c],
      ['d', d],
    ]);
    expect(handoffLegality.admit!(a, ctx(a, activated)).ok).toBe(true);
  });

  it('rejects a direct self-loop', () => {
    const a: Agent = {
      name: 'a',
      instructions: 'self',
      handoffs: [
        { target: { name: 'a', instructions: '' } as Agent, kind: 'continuation' },
      ],
    };
    const result = handoffLegality.admit!(a, ctx(a));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toMatch(/cycle/);
      expect(result.reason).toContain('a → a');
    }
  });

  it('rejects a 2-node mutual handoff a → b → a', () => {
    const a = stub('a', ['b']);
    const b = stub('b', ['a']);
    const activated = new Map<string, Agent>([['b', b]]);
    const result = handoffLegality.admit!(a, ctx(a, activated));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('a → b → a');
    }
  });

  it('rejects a transitive cycle a → b → c → a (3-node)', () => {
    const a = stub('a', ['b']);
    const b = stub('b', ['c']);
    const c = stub('c', ['a']);
    const activated = new Map<string, Agent>([
      ['b', b],
      ['c', c],
    ]);
    const result = handoffLegality.admit!(a, ctx(a, activated));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('a → b → c → a');
    }
  });

  it('handles unresolved handoff targets (no entry in activatedAgents) without crashing', () => {
    // c is not activated; the search reaches `b → c` and treats c as a
    // dead-end. No cycle exists, so admission succeeds.
    const b = stub('b', ['c']);
    const a = stub('a', ['b']);
    const activated = new Map<string, Agent>([['b', b]]);
    expect(handoffLegality.admit!(a, ctx(a, activated)).ok).toBe(true);
  });

  it('observe is a no-op pass-through in v1', () => {
    expect(
      handoffLegality.observe!(
        { kind: 'handoff_taken', target: 'b' },
        {
          manifest: createAgent({ name: 'a', instructions: 'x' }),
          mutationTracker: { files: new Set(), totalOps: 0 },
          recorder: {},
        },
      ).ok,
    ).toBe(true);
  });
});
