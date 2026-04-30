/**
 * FEATURE_101 v0.7.31.1 — builtin handoff resolution.
 *
 * Closes v0.7.31's silent degradation: a constructed agent that
 * handoffs to a builtin role (scout / planner / generator / evaluator)
 * had its target resolved to a stub `{ name, instructions: '' }`. The
 * runtime would still walk the name (so admission's handoff-legality
 * accepted the manifest), but the actual handoff at runtime gave the
 * target zero instructions — silent role-spec loss.
 *
 * The patch resolves `builtin:<role>` refs to the real
 * `@kodax/core/task-engine-agents` declarations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  _resetInvariantRegistry,
  evaluatorAgent,
  generatorAgent,
  plannerAgent,
  scoutAgent,
} from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';
import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  resolveConstructedAgent,
  _resetRuntimeForTesting,
} from './index.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-builtin-handoff-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
  _resetInvariantRegistry();
  registerCodingInvariants();
});

afterEach(async () => {
  _resetRuntimeForTesting();
  _resetInvariantRegistry();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('agent-resolver — builtin handoff resolution', () => {
  it('lifts builtin:scout handoff to the real scoutAgent declaration', async () => {
    // Need an evaluator handoff so independentReview admits (otherwise
    // the manifest with a generator role would be rejected).
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-with-scout',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper that hands off to the real scout',
        handoffs: [{ target: { ref: 'builtin:scout' }, kind: 'continuation' }],
      },
    };
    const handle = await stage(artifact);
    const tested = await testArtifact(handle);
    expect(tested.ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('wrapper-with-scout');
    expect(resolved).toBeDefined();
    const handoff = resolved!.handoffs?.[0];
    expect(handoff).toBeDefined();
    expect(handoff!.target.name).toBe(scoutAgent.name);
    expect(handoff!.target.instructions).toBe(scoutAgent.instructions);
  });

  it.each([
    ['scout', scoutAgent] as const,
    ['planner', plannerAgent] as const,
    ['generator', generatorAgent] as const,
    ['evaluator', evaluatorAgent] as const,
  ])('resolves builtin:%s ref to the matching real agent', async (role, expected) => {
    // Build a constructed agent whose handoffs reach generator + evaluator
    // when the role under test isn't already evaluator (so independentReview
    // is satisfied for generator-bearing graphs).
    const handoffs = role === 'generator' || role === 'evaluator'
      ? [
          { target: { ref: 'builtin:generator' }, kind: 'continuation' as const },
          { target: { ref: 'builtin:evaluator' }, kind: 'continuation' as const },
        ]
      : [{ target: { ref: `builtin:${role}` }, kind: 'continuation' as const }];

    const artifact: AgentArtifact = {
      kind: 'agent',
      name: `wrapper-${role}`,
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: `wrapper that hands off to ${role}`,
        handoffs: handoffs.map((h) => ({ target: { ref: h.target.ref }, kind: h.kind })),
      },
    };
    const handle = await stage(artifact);
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent(`wrapper-${role}`);
    expect(resolved).toBeDefined();
    const found = resolved!.handoffs?.find((h) => h.target.name === expected.name);
    expect(found).toBeDefined();
    expect(found!.target.instructions).toBe(expected.instructions);
  });

  it('resolves canonical kodax/role/<x> form too', async () => {
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-canonical',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper with canonical ref form',
        handoffs: [
          { target: { ref: 'builtin:kodax/role/planner' }, kind: 'continuation' },
        ],
      },
    };
    const handle = await stage(artifact);
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);
    const resolved = resolveConstructedAgent('wrapper-canonical');
    expect(resolved!.handoffs?.[0]?.target.name).toBe(plannerAgent.name);
    expect(resolved!.handoffs?.[0]?.target.instructions).toBe(plannerAgent.instructions);
  });

  it('falls back to a stub when builtin name is unknown', async () => {
    // Unknown builtin (not in the BUILTIN_AGENTS map). Admission still
    // passes because the stub has no outgoing edges; runtime sees the
    // stub instructions are empty.
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-unknown',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper to an unknown builtin',
        handoffs: [{ target: { ref: 'builtin:never-defined' }, kind: 'continuation' }],
      },
    };
    const handle = await stage(artifact);
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);
    const resolved = resolveConstructedAgent('wrapper-unknown');
    expect(resolved!.handoffs?.[0]?.target.name).toBe('never-defined');
    expect(resolved!.handoffs?.[0]?.target.instructions).toBe('');
  });
});
