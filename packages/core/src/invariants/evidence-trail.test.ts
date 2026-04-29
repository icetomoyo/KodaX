/**
 * FEATURE_101 — `evidenceTrail` invariant unit tests.
 *
 * v1 enforcement is at terminal time: a deliverable that recorded
 * mutations must produce at least one evidence artifact.
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '../agent.js';
import type { Deliverable, ObserveCtx, TerminalCtx } from '../admission.js';
import { evidenceTrail } from './evidence-trail.js';

const manifest = createAgent({ name: 'm', instructions: 'i' });

function obsCtx(): ObserveCtx {
  return {
    manifest,
    mutationTracker: { files: new Set(), totalOps: 0 },
    recorder: {},
  };
}

function termCtx(deliverable: Deliverable): TerminalCtx {
  return { manifest, deliverable };
}

describe('evidenceTrail.observe', () => {
  it('passes through every event kind in v1', () => {
    const ctx = obsCtx();
    expect(
      evidenceTrail.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 1 },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evidenceTrail.observe!(
        { kind: 'evidence_added', artifactPath: 'audit/a.json' },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evidenceTrail.observe!(
        { kind: 'tool_call', toolName: 'read' },
        ctx,
      ).ok,
    ).toBe(true);
  });
});

describe('evidenceTrail.assertTerminal', () => {
  it('admits a non-mutating deliverable with no artifacts', () => {
    const result = evidenceTrail.assertTerminal!(
      { mutationCount: 0, evidenceArtifacts: [] },
      termCtx({ mutationCount: 0, evidenceArtifacts: [] }),
    );
    expect(result.ok).toBe(true);
  });

  it('admits a non-mutating deliverable with artifacts (read-only audit run)', () => {
    // Read-only audits can produce reports without recording mutations —
    // the invariant must not flag this as a violation.
    const deliverable: Deliverable = {
      mutationCount: 0,
      evidenceArtifacts: ['audit/findings.json'],
    };
    expect(evidenceTrail.assertTerminal!(deliverable, termCtx(deliverable)).ok).toBe(true);
  });

  it('admits a mutating deliverable with at least one artifact', () => {
    const deliverable: Deliverable = {
      mutationCount: 3,
      evidenceArtifacts: ['audit/edit-1.json'],
    };
    expect(evidenceTrail.assertTerminal!(deliverable, termCtx(deliverable)).ok).toBe(true);
  });

  it('rejects a mutating deliverable with empty evidence artifacts', () => {
    const deliverable: Deliverable = {
      mutationCount: 2,
      evidenceArtifacts: [],
    };
    const result = evidenceTrail.assertTerminal!(deliverable, termCtx(deliverable));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.severity).toBe('reject');
      expect(result.reason).toContain('2 mutation');
      expect(result.reason).toContain('no evidence artifacts');
    }
  });

  it('admits when verdict is set with mutations and artifacts', () => {
    const deliverable: Deliverable = {
      mutationCount: 1,
      evidenceArtifacts: ['report.json'],
      verdict: 'accept',
    };
    expect(evidenceTrail.assertTerminal!(deliverable, termCtx(deliverable)).ok).toBe(true);
  });
});
