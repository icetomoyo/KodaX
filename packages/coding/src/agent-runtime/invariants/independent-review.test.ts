/**
 * FEATURE_101 — `independentReview` invariant unit tests.
 *
 * Covers admit-time topology check (generator without evaluator
 * reachable → reject) and assertTerminal verdict requirement.
 */

import { describe, expect, it } from 'vitest';

import { createAgent, createHandoff } from '@kodax/core';
import type { Agent, AdmissionCtx, AgentManifest, Deliverable, SystemCap, TerminalCtx } from '@kodax/core';

import { independentReview } from './independent-review.js';

const SYS_CAP: SystemCap = {
  maxBudget: 200,
  maxIterations: 200,
  allowedToolCapabilities: ['read', 'edit', 'bash:test'],
};

function admitCtx(
  manifest: AgentManifest,
  activatedAgents: ReadonlyMap<string, Agent> = new Map(),
  stagedAgents: ReadonlyMap<string, Agent> = new Map(),
): AdmissionCtx {
  return { manifest, activatedAgents, stagedAgents, systemCap: SYS_CAP };
}

function termCtx(manifest: AgentManifest, deliverable: Deliverable): TerminalCtx {
  return { manifest, deliverable };
}

describe('independentReview.admit', () => {
  it('admits a single-role manifest without generator reachable', () => {
    const m: AgentManifest = createAgent({ name: 'scout', instructions: 's' });
    expect(independentReview.admit!(m, admitCtx(m)).ok).toBe(true);
  });

  it('admits a manifest where generator and evaluator are both reachable', () => {
    const evaluator = createAgent({ name: 'evaluator', instructions: 'e' });
    const generator = createAgent({
      name: 'generator',
      instructions: 'g',
      handoffs: [createHandoff({ target: evaluator, kind: 'continuation' })],
    });
    const planner = createAgent({
      name: 'planner',
      instructions: 'p',
      handoffs: [createHandoff({ target: generator, kind: 'continuation' })],
    });
    const activated = new Map<string, Agent>([
      ['planner', planner],
      ['generator', generator],
      ['evaluator', evaluator],
    ]);
    expect(independentReview.admit!(planner, admitCtx(planner, activated)).ok).toBe(true);
  });

  it('rejects a manifest where generator is reachable but evaluator is missing', () => {
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
    const result = independentReview.admit!(planner, admitCtx(planner, activated));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('generator');
      expect(result.reason).toContain('evaluator');
    }
  });

  it('rejects a manifest that IS the generator if no evaluator is reachable', () => {
    const generator: AgentManifest = createAgent({ name: 'generator', instructions: 'g' });
    const result = independentReview.admit!(generator, admitCtx(generator));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.severity).toBe('reject');
  });
});

describe('independentReview.assertTerminal', () => {
  const manifest = createAgent({ name: 'g', instructions: 'i' });

  it('admits a non-mutating deliverable without verdict', () => {
    const deliverable: Deliverable = { mutationCount: 0, evidenceArtifacts: [] };
    expect(
      independentReview.assertTerminal!(deliverable, termCtx(manifest, deliverable)).ok,
    ).toBe(true);
  });

  it('admits a mutating deliverable that carries an evaluator verdict', () => {
    const deliverable: Deliverable = {
      mutationCount: 4,
      evidenceArtifacts: ['report.json'],
      verdict: 'accept',
    };
    expect(
      independentReview.assertTerminal!(deliverable, termCtx(manifest, deliverable)).ok,
    ).toBe(true);
  });

  it('rejects a mutating deliverable with no verdict', () => {
    const deliverable: Deliverable = {
      mutationCount: 2,
      evidenceArtifacts: ['report.json'],
      // verdict intentionally undefined
    };
    const result = independentReview.assertTerminal!(deliverable, termCtx(manifest, deliverable));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('2 mutation');
      expect(result.reason).toContain('no evaluator verdict');
    }
  });

  it('admits when verdict=blocked (still reviewed, just inconclusive)', () => {
    const deliverable: Deliverable = {
      mutationCount: 1,
      evidenceArtifacts: ['note.json'],
      verdict: 'blocked',
    };
    expect(
      independentReview.assertTerminal!(deliverable, termCtx(manifest, deliverable)).ok,
    ).toBe(true);
  });
});
