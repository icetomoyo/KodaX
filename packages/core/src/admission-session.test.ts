/**
 * Unit tests for admission-session — runtime dispatch of `observe` and
 * `assertTerminal` invariant hooks (FEATURE_101 v0.7.31.1 follow-up).
 *
 * Coverage:
 *   - WeakMap binding registry round-trip
 *   - observe dispatch on every recorded event kind
 *   - mutationTracker / recorder are exposed (read-only) to observe
 *   - assertTerminal fire-once + Deliverable assembly
 *   - violations accumulator includes both observe + terminal hits
 *   - createInvariantSessionForAgent skips trusted (un-admitted) agents
 */

import { describe, it, expect, beforeEach } from 'vitest';

import type { Agent } from './agent.js';
import {
  InvariantSession,
  createInvariantSessionForAgent,
  getAdmittedAgentBindings,
  setAdmittedAgentBindings,
} from './admission-session.js';
import type {
  AdmissionCtx,
  AgentManifest,
  Deliverable,
  InvariantResult,
  ObserveCtx,
  QualityInvariant,
  RunnerEvent,
  TerminalCtx,
} from './admission.js';
import {
  _resetInvariantRegistry,
  registerInvariant,
} from './admission-runtime.js';

const baseManifest: AgentManifest = {
  name: 'test-agent',
  instructions: 'do work',
};

beforeEach(() => {
  _resetInvariantRegistry();
});

describe('admission-session — WeakMap binding registry', () => {
  it('round-trips bindings through set/get for an agent', () => {
    const agent: Agent = { name: 'a', instructions: '' };
    setAdmittedAgentBindings(agent, baseManifest, ['finalOwner', 'evidenceTrail']);
    const meta = getAdmittedAgentBindings(agent);
    expect(meta).toBeDefined();
    expect(meta?.bindings).toEqual(['finalOwner', 'evidenceTrail']);
    expect(meta?.manifest).toBe(baseManifest);
  });

  it('returns undefined for un-admitted agents', () => {
    const agent: Agent = { name: 'untrusted', instructions: '' };
    expect(getAdmittedAgentBindings(agent)).toBeUndefined();
  });

  it('createInvariantSessionForAgent returns undefined for un-admitted agents', () => {
    const agent: Agent = { name: 'untrusted', instructions: '' };
    expect(createInvariantSessionForAgent(agent)).toBeUndefined();
  });

  it('createInvariantSessionForAgent returns a session for admitted agents', () => {
    const agent: Agent = { name: 'admitted', instructions: '' };
    setAdmittedAgentBindings(agent, baseManifest, ['finalOwner']);
    expect(createInvariantSessionForAgent(agent)).toBeInstanceOf(InvariantSession);
  });
});

describe('InvariantSession — observe dispatch', () => {
  it('dispatches tool_call events to bound invariants with capability', () => {
    const seen: RunnerEvent[] = [];
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'capture',
      observe(event: RunnerEvent, _ctx: ObserveCtx) {
        seen.push(event);
        return { ok: true } as InvariantResult;
      },
      // admit is required-or-observe — supply admit too so register passes.
      admit(_m: AgentManifest, _c: AdmissionCtx) {
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['finalOwner'], baseManifest);
    session.recordToolCall('read', 'read');
    session.recordToolCall('bash');
    session.recordHandoff('next-agent');

    expect(seen).toEqual([
      { kind: 'tool_call', toolName: 'read', capability: 'read' },
      { kind: 'tool_call', toolName: 'bash' },
      { kind: 'handoff_taken', target: 'next-agent' },
    ]);
  });

  it('exposes a read-only mutationTracker reflecting recorded mutations', () => {
    let seenCount = -1;
    const inv: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'inspect',
      observe(event: RunnerEvent, ctx: ObserveCtx) {
        if (event.kind === 'mutation_recorded') {
          seenCount = ctx.mutationTracker.files.size;
        }
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['evidenceTrail'], baseManifest);
    session.recordMutation('a.ts');
    session.recordMutation('b.ts');
    session.recordMutation('a.ts'); // dup — distinct file count stays 2.
    expect(seenCount).toBe(2);
    expect(session.getMutationCount()).toBe(2);
  });

  it('records evidence artifacts and surfaces them on the session', () => {
    const inv: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'noop',
      observe(_event, _ctx) {
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['evidenceTrail'], baseManifest);
    session.recordEvidence('docs/test.md');
    session.recordEvidence('artifact.txt');
    expect(session.getEvidenceArtifacts()).toEqual(['docs/test.md', 'artifact.txt']);
  });

  it('exposes confirmedHarness on the recorder for harnessSelectionTiming', () => {
    let confirmed: string | undefined;
    const inv: QualityInvariant = {
      id: 'harnessSelectionTiming',
      description: 'inspect-recorder',
      observe(_event: RunnerEvent, ctx: ObserveCtx) {
        confirmed = ctx.recorder.scout?.payload?.scout?.confirmedHarness;
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['harnessSelectionTiming'], baseManifest);
    session.setConfirmedHarness('H1_EXECUTE_EVAL');
    session.recordToolCall('read');
    expect(confirmed).toBe('H1_EXECUTE_EVAL');
  });

  it('accumulates violations from observe', () => {
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'reject-on-bash',
      observe(event: RunnerEvent) {
        if (event.kind === 'tool_call' && event.toolName === 'bash') {
          return {
            ok: false,
            severity: 'reject',
            reason: 'bash banned at runtime',
          } as InvariantResult;
        }
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['finalOwner'], baseManifest);
    const r1 = session.recordToolCall('read');
    expect(r1.results).toHaveLength(0);
    const r2 = session.recordToolCall('bash');
    expect(r2.results).toHaveLength(1);
    expect(r2.results[0]!.id).toBe('finalOwner');
    expect(r2.results[0]!.result.ok).toBe(false);
    expect(session.getViolations()).toHaveLength(1);
  });

  it('skips invariants without observe hooks', () => {
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'admit-only',
      admit(_m, _c) {
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['finalOwner'], baseManifest);
    const result = session.recordToolCall('read');
    expect(result.results).toHaveLength(0);
  });

  it('skips ids not in the registry (graceful degradation)', () => {
    const session = new InvariantSession(['finalOwner', 'evidenceTrail'], baseManifest);
    // No invariants registered — must not throw.
    expect(() => session.recordToolCall('read')).not.toThrow();
    expect(session.getViolations()).toHaveLength(0);
  });
});

describe('InvariantSession — assertTerminal', () => {
  it('runs assertTerminal hooks once and assembles a Deliverable', () => {
    let seenDeliverable: Deliverable | undefined;
    const inv: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'inspect-terminal',
      assertTerminal(deliverable: Deliverable, _ctx: TerminalCtx) {
        seenDeliverable = deliverable;
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['evidenceTrail'], baseManifest);
    session.recordMutation('x.ts');
    session.recordEvidence('out.txt');
    session.setVerdict('accept');
    session.assertTerminal();

    expect(seenDeliverable).toEqual({
      evidenceArtifacts: ['out.txt'],
      verdict: 'accept',
      mutationCount: 1,
    });
  });

  it('fires once — repeat calls return the cached violation set', () => {
    let calls = 0;
    const inv: QualityInvariant = {
      id: 'finalOwner',
      description: 'count',
      assertTerminal(_d, _c) {
        calls += 1;
        return {
          ok: false,
          severity: 'reject',
          reason: 'demo',
        } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['finalOwner'], baseManifest);
    const r1 = session.assertTerminal();
    const r2 = session.assertTerminal();
    expect(calls).toBe(1);
    expect(r1.results).toHaveLength(1);
    expect(r2.results).toHaveLength(1);
  });

  it('captures terminal violations in getViolations together with observe hits', () => {
    const inv: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'observe-warn-terminal-reject',
      observe(_e, _c) {
        return {
          ok: false,
          severity: 'warn',
          reason: 'noticed something',
        } as InvariantResult;
      },
      assertTerminal(_d, _c) {
        return {
          ok: false,
          severity: 'reject',
          reason: 'critical at end',
        } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['evidenceTrail'], baseManifest);
    session.recordMutation('a.ts');
    session.assertTerminal();

    const violations = session.getViolations();
    expect(violations).toHaveLength(2);
    expect(violations[0]!.result.ok).toBe(false);
    expect(violations[1]!.result.ok).toBe(false);
  });

  it('passes verdict undefined for runs that never set one', () => {
    let seenVerdict: Deliverable['verdict'] = 'accept';
    const inv: QualityInvariant = {
      id: 'evidenceTrail',
      description: 'inspect',
      assertTerminal(deliverable, _ctx) {
        seenVerdict = deliverable.verdict;
        return { ok: true } as InvariantResult;
      },
    };
    registerInvariant(inv);

    const session = new InvariantSession(['evidenceTrail'], baseManifest);
    session.assertTerminal();
    expect(seenVerdict).toBeUndefined();
  });
});
