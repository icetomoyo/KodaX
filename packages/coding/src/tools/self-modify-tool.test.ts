/**
 * FEATURE_090 (v0.7.32) — `stage_self_modify` + self-modify-in-disguise
 * guard on `stage_agent_construction`. Unit-level coverage; the activate-
 * path force-ask-user / LLM diff summary path lands in P3.
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
  type AgentArtifact,
} from '../construction/index.js';
import {
  appendAuditEntry,
  readAuditEntries,
} from '../construction/audit-log.js';
import {
  consumeBudget,
  DEFAULT_SELF_MODIFY_BUDGET,
} from '../construction/budget.js';
import type { KodaXToolExecutionContext } from '../types.js';

import { toolStageAgentConstruction } from './agent-construction.js';
import { toolStageSelfModify } from './self-modify-tool.js';

const ctx = { backups: new Map() } as KodaXToolExecutionContext;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-self-modify-tool-'));
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

/**
 * Persist a fully-formed active manifest directly so the self-modify
 * tool has a "prev" to diff against. We bypass the construction
 * lifecycle to keep the test focused on `stage_self_modify` rather
 * than the FEATURE_089 admission path.
 */
async function persistActiveManifest(artifact: AgentArtifact): Promise<void> {
  const dir = path.join(tmpRoot, '.kodax', 'constructed', 'agents', artifact.name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${artifact.version}.json`),
    JSON.stringify(artifact, null, 2),
    'utf8',
  );
}

function buildArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    kind: 'agent',
    name: overrides.name ?? 'alpha',
    version: overrides.version ?? '1.0.0',
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? Date.now(),
    sourceAgent: overrides.sourceAgent,
    content: overrides.content ?? {
      instructions: 'You are alpha.',
    },
  } as AgentArtifact;
}

function asJson(artifact: AgentArtifact): string {
  return JSON.stringify(artifact);
}

describe('stage_self_modify — entry validation', () => {
  it('rejects when artifact_json is missing', async () => {
    const out = await toolStageSelfModify({}, ctx);
    expect(out).toMatch(/^\[Tool Error\] stage_self_modify:.*'artifact_json' is required/);
  });

  it('rejects when artifact_json is malformed JSON', async () => {
    const out = await toolStageSelfModify({ artifact_json: '{ not json' }, ctx);
    expect(out).toMatch(/failed to parse as JSON/);
  });

  it('rejects when artifact.kind is not agent', async () => {
    const out = await toolStageSelfModify(
      { artifact_json: JSON.stringify({ kind: 'tool', name: 'a', version: '1.0.0', content: { instructions: 'x' } }) },
      ctx,
    );
    expect(out).toMatch(/artifact\.kind must be 'agent'/);
  });

  it('rejects when sourceAgent is missing', async () => {
    const next = buildArtifact({ name: 'alpha', version: '1.1.0' });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/sourceAgent is required/);
  });

  it('rejects when sourceAgent does not match name', async () => {
    const next = buildArtifact({ name: 'alpha', version: '1.1.0', sourceAgent: 'not-alpha' });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/sourceAgent='not-alpha' does not match artifact\.name='alpha'/);
  });

  it('rejects when no active version of the agent exists', async () => {
    const next = buildArtifact({ name: 'alpha', version: '1.1.0', sourceAgent: 'alpha' });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/no active version of 'alpha' on disk/);
    expect(out).toMatch(/stage_agent_construction for first-time staging/);
  });
});

describe('stage_self_modify — happy path', () => {
  it('persists status=staged and writes a self_modify_staged audit entry', async () => {
    await persistActiveManifest(
      buildArtifact({
        name: 'alpha',
        version: '1.0.0',
        status: 'active',
        content: { instructions: 'You are alpha.' },
      }),
    );

    const next = buildArtifact({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'You are alpha. Verdict: accept | revise | blocked.' },
    });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toContain('staged self-modify: alpha 1.0.0 → 1.1.0');
    expect(out).toContain(`budgetRemaining=${DEFAULT_SELF_MODIFY_BUDGET}/${DEFAULT_SELF_MODIFY_BUDGET}`);

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.1.0.json'),
        'utf8',
      ),
    );
    expect(persisted.status).toBe('staged');

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_staged');
    expect(audit[0]!.fromVersion).toBe('1.0.0');
    expect(audit[0]!.toVersion).toBe('1.1.0');
    expect(audit[0]!.diffHash).toBeTypeOf('string');
  });
});

describe('stage_self_modify — hard rejects', () => {
  beforeEach(async () => {
    await persistActiveManifest(
      buildArtifact({
        name: 'alpha',
        version: '1.0.0',
        status: 'active',
        content: {
          instructions: 'You are alpha.',
          guardrails: [{ kind: 'tool', ref: 'no-rm-rf' }],
        },
      }),
    );
  });

  it('rejects on guardrail-ratchet violation and audits self_modify_rejected', async () => {
    const next = buildArtifact({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: { instructions: 'You are alpha (sneaky).' /* no guardrails! */ },
    });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/rule='guardrail-ratchet'/);
    expect(out).toMatch(/tool:no-rm-rf/);

    // Manifest must NOT be on disk (validation rejected before stage()).
    await expect(
      fs.stat(path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.1.0.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_rejected');
    expect(audit[0]!.rejectRule).toBe('guardrail-ratchet');
  });

  it('rejects when budget is exhausted', async () => {
    for (let i = 0; i < DEFAULT_SELF_MODIFY_BUDGET; i += 1) {
      await consumeBudget('alpha', { cwd: tmpRoot });
    }
    const next = buildArtifact({
      name: 'alpha',
      version: '1.1.0',
      status: 'staged',
      sourceAgent: 'alpha',
      content: {
        instructions: 'updated',
        guardrails: [{ kind: 'tool', ref: 'no-rm-rf' }],
      },
    });
    const out = await toolStageSelfModify({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/rule='budget-exhausted'/);

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.rejectRule).toBe('budget-exhausted');
  });
});

describe('stage_agent_construction — self-modify-in-disguise guard', () => {
  it('refuses when the manifest name collides with an active constructed agent', async () => {
    await persistActiveManifest(
      buildArtifact({ name: 'alpha', version: '1.0.0', status: 'active' }),
    );

    const next = buildArtifact({
      name: 'alpha',
      version: '2.0.0',
      status: 'staged',
      content: { instructions: 'rewrite' },
    });
    const out = await toolStageAgentConstruction({ artifact_json: asJson(next) }, ctx);
    expect(out).toMatch(/already has an active manifest \(1\.0\.0\)/);
    expect(out).toMatch(/stage_self_modify/);

    // Pre-existing 1.0.0 must still be intact; 2.0.0 must NOT have landed.
    await expect(
      fs.stat(path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '2.0.0.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows staging a fresh, never-before-seen name (FEATURE_089 happy path unchanged)', async () => {
    const fresh = buildArtifact({
      name: 'beta',
      version: '0.1.0',
      status: 'staged',
      content: { instructions: 'You are beta.' },
    });
    const out = await toolStageAgentConstruction({ artifact_json: asJson(fresh) }, ctx);
    expect(out).toContain('staged: beta@0.1.0');
  });
});
