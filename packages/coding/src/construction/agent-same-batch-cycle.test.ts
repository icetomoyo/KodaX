/**
 * FEATURE_101 v0.7.31.1 — Tier A3: same-batch transitive cycle
 * detection across staged manifests.
 *
 * Scenario: an LLM generator stages two manifests in the same session
 * with mutual handoffs (A → B and B → A). Each manifest, viewed in
 * isolation, has a clean handoff graph. v0.7.31's handoff-legality
 * only consulted `activatedAgents`, so neither admission saw the
 * other; both passed and the cycle materialized at runtime. The
 * v0.7.31.1 patch adds a `stagedAgents` map populated by
 * ConstructionRuntime so the cycle is detected at the second
 * admission attempt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { _resetInvariantRegistry } from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';
import {
  configureRuntime,
  stage,
  testArtifact,
  _resetRuntimeForTesting,
} from './index.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cycle-'));
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

const buildArtifact = (
  name: string,
  handoffs: readonly { readonly ref: string; readonly kind: 'continuation' | 'as-tool' }[],
): AgentArtifact => ({
  kind: 'agent',
  name,
  version: '1.0.0',
  status: 'staged',
  createdAt: Date.now(),
  content: {
    instructions: `agent ${name} — performs work`,
    handoffs: handoffs.map((h) => ({ target: { ref: h.ref }, kind: h.kind })),
  },
});

describe('FEATURE_101 v0.7.31.1 — same-batch cycle detection', () => {
  it('rejects the second manifest of an A↔B mutual-handoff pair', async () => {
    // 1. Stage A → B. At this point B does not exist on disk.
    const aHandle = await stage(
      buildArtifact('agent-a', [{ ref: 'constructed:agent-b', kind: 'continuation' }]),
    );
    // First admission of A: no peer staged → passes.
    const aResult = await testArtifact(aHandle);
    expect(aResult.ok).toBe(true);

    // 2. Stage B → A. A is staged-but-not-activated; admission must
    // see it via stagedAgents and reject the back-edge.
    const bHandle = await stage(
      buildArtifact('agent-b', [{ ref: 'constructed:agent-a', kind: 'continuation' }]),
    );
    const bResult = await testArtifact(bHandle);
    expect(bResult.ok).toBe(false);
    expect(bResult.errors?.some((e) => /handoffLegality.*cycle/i.test(e))).toBe(true);
  });

  it('admits a chain when staged predecessors do not close the loop', async () => {
    // Stage C (terminal), then B → C, then A → B. No cycle.
    const cHandle = await stage(buildArtifact('agent-c', []));
    expect((await testArtifact(cHandle)).ok).toBe(true);

    const bHandle = await stage(
      buildArtifact('agent-b', [{ ref: 'constructed:agent-c', kind: 'continuation' }]),
    );
    expect((await testArtifact(bHandle)).ok).toBe(true);

    const aHandle = await stage(
      buildArtifact('agent-a', [{ ref: 'constructed:agent-b', kind: 'continuation' }]),
    );
    expect((await testArtifact(aHandle)).ok).toBe(true);
  });

  it('a manifest does not match itself in stagedAgents (self-exclusion)', async () => {
    // Stage A with no handoffs. First admission sees no staged peer
    // and admits; second admission of the same name+version must not
    // suddenly fail because A discovered itself in the staged map.
    const aHandle = await stage(buildArtifact('agent-self', []));
    const r1 = await testArtifact(aHandle);
    expect(r1.ok).toBe(true);
    // Re-running test on the same handle (e.g. after edits) would
    // pass too — the self-exclusion in buildStagedAgentsMap uses the
    // artifact name to skip the current node.
    const r2 = await testArtifact(aHandle);
    expect(r2.ok).toBe(true);
  });
});
