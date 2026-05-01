/**
 * FEATURE_090 (v0.7.32) — `rollbackSelfModify` runtime function tests.
 *
 * Covers candidate selection, error codes, and the resolver +
 * persisted-disk side effects. Audit log writes are NOT tested here
 * — the runtime function intentionally leaves audit attribution to
 * the CLI surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { _resetInvariantRegistry } from '@kodax/core';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';

import {
  configureRuntime,
  _resetRuntimeForTesting,
  resolveConstructedAgent,
  rehydrateActiveArtifacts,
} from './index.js';
import { rollbackSelfModify } from './rollback.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-rollback-'));
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

async function persistManifest(artifact: AgentArtifact): Promise<void> {
  const dir = path.join(tmpRoot, '.kodax', 'constructed', 'agents', artifact.name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${artifact.version}.json`),
    JSON.stringify(artifact, null, 2),
    'utf8',
  );
}

function buildAgent(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'alpha',
    version: overrides.version ?? '1.0.0',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now(),
    testedAt: overrides.testedAt ?? Date.now(),
    activatedAt: overrides.activatedAt ?? Date.now(),
    content: overrides.content ?? { instructions: 'You are alpha.' },
  } as AgentArtifact;
}

describe('rollbackSelfModify — pre-conditions', () => {
  it('throws no-current-active when no active version exists', async () => {
    await persistManifest(
      buildAgent({ name: 'alpha', version: '1.0.0', status: 'staged' }),
    );
    await expect(rollbackSelfModify('alpha')).rejects.toMatchObject({
      code: 'no-current-active',
    });
  });

  it('throws no-rollback-target when only one active version exists', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));
    await rehydrateActiveArtifacts();
    await expect(rollbackSelfModify('alpha')).rejects.toMatchObject({
      code: 'no-rollback-target',
    });
  });
});

describe('rollbackSelfModify — happy path', () => {
  it('revokes current, re-registers target, returns version pair', async () => {
    const v100 = buildAgent({
      name: 'alpha',
      version: '1.0.0',
      activatedAt: 1000,
      content: { instructions: 'You are alpha v1.0.' },
    });
    const v110 = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      activatedAt: 2000,
      content: { instructions: 'You are alpha v1.1.' },
    });
    await persistManifest(v100);
    await persistManifest(v110);
    await rehydrateActiveArtifacts();

    const result = await rollbackSelfModify('alpha');

    expect(result).toMatchObject({
      agentName: 'alpha',
      fromVersion: '1.1.0',
      toVersion: '1.0.0',
    });

    // Resolver swapped to v1.0.0.
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha v1.0.');

    // Disk: v1.1.0 → revoked.
    const persistedV110 = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.1.0.json'),
        'utf8',
      ),
    );
    expect(persistedV110.status).toBe('revoked');

    // Disk: v1.0.0 stays active with original activatedAt — chained
    // rollbacks rely on the timestamps surviving.
    const persistedV100 = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.0.0.json'),
        'utf8',
      ),
    );
    expect(persistedV100.status).toBe('active');
    expect(persistedV100.activatedAt).toBe(1000);
  });

  it('chains backward through history on successive rollbacks', async () => {
    const v100 = buildAgent({
      name: 'alpha',
      version: '1.0.0',
      activatedAt: 1000,
      content: { instructions: 'v1.0' },
    });
    const v110 = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      activatedAt: 2000,
      content: { instructions: 'v1.1' },
    });
    const v120 = buildAgent({
      name: 'alpha',
      version: '1.2.0',
      activatedAt: 3000,
      content: { instructions: 'v1.2' },
    });
    await persistManifest(v100);
    await persistManifest(v110);
    await persistManifest(v120);
    await rehydrateActiveArtifacts();

    const first = await rollbackSelfModify('alpha');
    expect(first.fromVersion).toBe('1.2.0');
    expect(first.toVersion).toBe('1.1.0');
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('v1.1');

    const second = await rollbackSelfModify('alpha');
    expect(second.fromVersion).toBe('1.1.0');
    expect(second.toVersion).toBe('1.0.0');
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('v1.0');

    // No more rollback targets.
    await expect(rollbackSelfModify('alpha')).rejects.toMatchObject({
      code: 'no-rollback-target',
    });
  });
});
