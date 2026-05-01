/**
 * FEATURE_090 (v0.7.32) — `kodax constructed <action>` CLI tests.
 *
 * The CLI helpers call `process.exit(1)` on input / IO errors. Tests
 * stub `process.exit` so a failure path doesn't tear the test runner
 * down. Stdout / stderr are spied on to assert the human-facing
 * messages.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import {
  configureRuntime,
  _resetRuntimeForTesting,
  readBudget,
  readAuditEntries,
  readDisableState,
  resolveConstructedAgent,
  DEFAULT_SELF_MODIFY_BUDGET,
  remainingSelfModifyBudget,
  type AgentArtifact,
} from '@kodax/coding';

import {
  runConstructedAudit,
  runConstructedRollback,
  runDisableSelfModify,
  runResetSelfModifyBudget,
} from './self_modify_cli.js';

let tmpRoot: string;
let exitSpy: MockInstance;
let stdoutSpy: MockInstance;
let stderrSpy: MockInstance;
let logSpy: MockInstance;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-self-modify-cli-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'reject',
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  _resetRuntimeForTesting();
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  logSpy.mockRestore();
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

describe('runResetSelfModifyBudget', () => {
  it('rejects an empty name with exit 1', async () => {
    await expect(
      runResetSelfModifyBudget('', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('rejects an unknown agent with exit 1', async () => {
    await expect(
      runResetSelfModifyBudget('nonexistent', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    const message = stderrSpy.mock.calls.flat().join('');
    expect(message).toMatch(/no constructed agent named 'nonexistent'/);
  });

  it('resets a partially-consumed budget and writes audit entry', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));
    // Seed a partially-consumed budget directly on disk; we don't need
    // to import the (intentionally package-private) `consumeBudget`
    // helper — `readBudget` accepts whatever shape we write here.
    const budgetFile = path.join(
      tmpRoot,
      '.kodax',
      'constructed',
      'agents',
      'alpha',
      '_self_modify.json',
    );
    await fs.writeFile(budgetFile, JSON.stringify({ name: 'alpha', count: 2 }), 'utf8');

    await runResetSelfModifyBudget('alpha', { cwd: tmpRoot });

    const after = await readBudget('alpha', { cwd: tmpRoot });
    expect(after.count).toBe(0);
    expect(remainingSelfModifyBudget(after)).toBe(DEFAULT_SELF_MODIFY_BUDGET);

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_budget_reset');
    expect(audit[0]!.budgetRemaining).toBe(DEFAULT_SELF_MODIFY_BUDGET);
    expect(audit[0]!.toVersion).toBe('1.0.0');

    const log = logSpy.mock.calls.flat().join('');
    expect(log).toMatch(/reset to 3\/3 \(was 1\/3\)/);
  });

  it('still records audit entry when budget was already full (idempotent reset)', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));

    await runResetSelfModifyBudget('alpha', { cwd: tmpRoot });

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_budget_reset');

    const log = logSpy.mock.calls.flat().join('');
    expect(log).toMatch(/already full/);
  });

  it('records sentinel toVersion when no active manifest exists yet', async () => {
    // Only a staged version exists — agent name is known but not activated.
    await persistManifest(buildAgent({ name: 'alpha', version: '0.1.0', status: 'staged' }));

    await runResetSelfModifyBudget('alpha', { cwd: tmpRoot });

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit[0]!.toVersion).toBe('<no active version>');
  });
});

describe('runConstructedAudit', () => {
  it('rejects an unknown agent with exit 1', async () => {
    await expect(
      runConstructedAudit('nonexistent', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('prints a friendly empty-state message when there are no audit entries', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));

    await runConstructedAudit('alpha', { cwd: tmpRoot });

    const log = logSpy.mock.calls.flat().join('');
    expect(log).toMatch(/No audit entries recorded for 'alpha'/);
  });

  it('renders audit entries chronologically, preserving event details', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));
    await runResetSelfModifyBudget('alpha', { cwd: tmpRoot });
    await runDisableSelfModify('alpha', { cwd: tmpRoot });

    logSpy.mockClear();
    await runConstructedAudit('alpha', { cwd: tmpRoot });
    const log = logSpy.mock.calls.flat().join('\n');
    expect(log).toMatch(/Self-modify audit log for 'alpha' \(2 entries\)/);
    expect(log).toMatch(/self_modify_budget_reset/);
    expect(log).toMatch(/self_modify_disabled/);
    // Order: budget_reset (recorded first) precedes disabled (recorded
    // second) in the printed output.
    const resetIdx = log.indexOf('self_modify_budget_reset');
    const disabledIdx = log.indexOf('self_modify_disabled');
    expect(resetIdx).toBeLessThan(disabledIdx);
  });
});

describe('runDisableSelfModify', () => {
  it('rejects an unknown agent with exit 1', async () => {
    await expect(
      runDisableSelfModify('nonexistent', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('writes the marker, records audit, and surfaces a green confirmation', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));

    await runDisableSelfModify('alpha', { cwd: tmpRoot });

    const state = await readDisableState('alpha', { cwd: tmpRoot });
    expect(state.disabled).toBe(true);
    expect(state.disabledAt).toBeTypeOf('string');

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_disabled');

    const log = logSpy.mock.calls.flat().join('');
    expect(log).toMatch(/permanently disabled/);
  });

  it('is idempotent — re-disabling appends a fresh audit row without erroring', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));

    await runDisableSelfModify('alpha', { cwd: tmpRoot });
    await runDisableSelfModify('alpha', { cwd: tmpRoot });

    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(2);
    expect(audit.every((e) => e.event === 'self_modify_disabled')).toBe(true);
  });
});

describe('runConstructedRollback', () => {
  it('rejects an unknown agent with exit 1', async () => {
    await expect(
      runConstructedRollback('nonexistent', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
  });

  it('rejects when only one active version exists (no rollback target)', async () => {
    await persistManifest(buildAgent({ name: 'alpha', version: '1.0.0' }));

    await expect(
      runConstructedRollback('alpha', { cwd: tmpRoot }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    const stderr = stderrSpy.mock.calls.flat().join('');
    expect(stderr).toMatch(/no prior version to roll back to/);
  });

  it('rolls back to the previous active version, revoking the current and re-registering target', async () => {
    // Two active versions on disk; v1.1.0 is more recently activated.
    const v100 = buildAgent({
      name: 'alpha',
      version: '1.0.0',
      status: 'active',
      activatedAt: 1000,
      content: { instructions: 'You are alpha v1.0.' },
    });
    const v110 = buildAgent({
      name: 'alpha',
      version: '1.1.0',
      status: 'active',
      activatedAt: 2000,
      content: { instructions: 'You are alpha v1.1.' },
    });
    await persistManifest(v100);
    await persistManifest(v110);
    // Resolver gets populated by `bootstrapForCli`'s rehydrate inside
    // `runConstructedRollback`, no explicit register needed here.

    await runConstructedRollback('alpha', { cwd: tmpRoot });

    // Resolver now hands out v1.0.0.
    expect(resolveConstructedAgent('alpha')?.instructions).toBe('You are alpha v1.0.');

    // Disk: v1.1.0 → revoked, v1.0.0 still active.
    const persistedV110 = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.1.0.json'),
        'utf8',
      ),
    );
    const persistedV100 = JSON.parse(
      await fs.readFile(
        path.join(tmpRoot, '.kodax', 'constructed', 'agents', 'alpha', '1.0.0.json'),
        'utf8',
      ),
    );
    expect(persistedV110.status).toBe('revoked');
    expect(persistedV100.status).toBe('active');

    // Audit: rolled-back entry written with both versions.
    const audit = await readAuditEntries({ cwd: tmpRoot, agentName: 'alpha' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.event).toBe('self_modify_rolled_back');
    expect(audit[0]!.fromVersion).toBe('1.1.0');
    expect(audit[0]!.toVersion).toBe('1.0.0');
  });
});
