/**
 * FEATURE_101 — `finalOwner` invariant unit tests.
 *
 * The check is admit-only; we verify rejection on:
 *   - missing / blank manifest.name
 *   - handoff graphs that reach no terminal node
 *
 * And admission on:
 *   - manifests without handoffs (self is owner)
 *   - chains where some downstream node has no outgoing handoffs
 *   - unresolved targets (treated as terminal candidates — admission
 *     can't see beyond what's been activated)
 */

import { describe, expect, it } from 'vitest';

import { createAgent, createHandoff } from '../agent.js';
import type { Agent } from '../agent.js';
import type { AdmissionCtx, AgentManifest, SystemCap } from '../admission.js';
import { finalOwner } from './final-owner.js';

const SYS_CAP: SystemCap = {
  maxBudget: 100_000,
  maxIterations: 100,
  allowedToolCapabilities: ['read', 'edit', 'bash:test'],
};

function ctx(
  manifest: AgentManifest,
  activatedAgents: ReadonlyMap<string, Agent> = new Map(),
): AdmissionCtx {
  return { manifest, activatedAgents, systemCap: SYS_CAP };
}

describe('finalOwner.admit', () => {
  it('admits a single agent with no handoffs (self is the terminal owner)', () => {
    const m = createAgent({ name: 'solo', instructions: 'do work' });
    expect(finalOwner.admit!(m, ctx(m)).ok).toBe(true);
  });

  it('rejects manifest with empty name', () => {
    const broken: AgentManifest = { name: '', instructions: 'x' };
    const result = finalOwner.admit!(broken, ctx(broken));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('non-empty string');
    }
  });

  it('admits when downstream activated agent has no further handoffs', () => {
    const sink = createAgent({ name: 'verifier', instructions: 'verify' });
    const root = createAgent({
      name: 'generator',
      instructions: 'generate',
      handoffs: [createHandoff({ target: sink, kind: 'continuation' })],
    });
    const activated = new Map<string, Agent>([['verifier', sink]]);
    expect(finalOwner.admit!(root, ctx(root, activated)).ok).toBe(true);
  });

  it('admits a 3-hop acyclic chain (a → b → c, c is terminal)', () => {
    const c = createAgent({ name: 'c', instructions: 'sink' });
    const b = createAgent({
      name: 'b',
      instructions: 'middle',
      handoffs: [createHandoff({ target: c, kind: 'continuation' })],
    });
    const a = createAgent({
      name: 'a',
      instructions: 'root',
      handoffs: [createHandoff({ target: b, kind: 'continuation' })],
    });
    const activated = new Map<string, Agent>([
      ['b', b],
      ['c', c],
    ]);
    expect(finalOwner.admit!(a, ctx(a, activated)).ok).toBe(true);
  });

  it('admits when handoff target is not yet activated (treated as terminal candidate)', () => {
    const placeholder = createAgent({ name: 'future-evaluator', instructions: 'tbd' });
    const root = createAgent({
      name: 'generator',
      instructions: 'generate',
      handoffs: [createHandoff({ target: placeholder, kind: 'continuation' })],
    });
    // future-evaluator is NOT in activatedAgents — invariant must still
    // admit, treating the unresolved target as a terminal candidate.
    expect(finalOwner.admit!(root, ctx(root, new Map())).ok).toBe(true);
  });

  it('rejects when every reachable agent declares an outgoing handoff (no terminal)', () => {
    // Build a 2-cycle where activatedAgents resolves both targets.
    const a: Agent = {
      name: 'a',
      instructions: 'x',
      handoffs: [
        // `b` is the target — but b also has handoffs back to a
        // Use a structurally-typed Handoff (target name only matters).
        { target: { name: 'b', instructions: 'y' } as Agent, kind: 'continuation' },
      ],
    };
    const b: Agent = {
      name: 'b',
      instructions: 'y',
      handoffs: [
        { target: { name: 'a', instructions: 'x' } as Agent, kind: 'continuation' },
      ],
    };
    const activated = new Map<string, Agent>([
      ['a', a],
      ['b', b],
    ]);
    const result = finalOwner.admit!(a, ctx(a, activated));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('no terminal owner');
    }
  });
});
